#!/usr/bin/env node
/**
 * 流程检查点：按 references/mode-routing.json（合同 v14）决定合法阶段与顺序，拒绝跳阶段。
 *
 * 用法：
 *   node scripts/checkpoint.mjs init    --dir <项目外目录> --route requirement|sql|source|template|manual-structure [--target diagrams|system|full|preview --note "用户明确的目标原话"] [--branch documentation|reuse|rebuild|run-verification]
 *   node scripts/checkpoint.mjs status  --dir <目录>
 *   node scripts/checkpoint.mjs advance --dir <目录> --to <阶段> [--note "用户原话"] [--artifact 名称=路径 ...] [--await-user "待选择事项" | --blocked "真实阻塞原因"]
 *   node scripts/checkpoint.mjs finish  --dir <目录> [--artifact 名称=路径 ...]
 *   node scripts/checkpoint.mjs record  --dir <目录> --tool <MCP 工具名>
 *   node scripts/checkpoint.mjs ids     --dir <目录> --set previewId=<uuid>
 *   node scripts/checkpoint.mjs verify  --dir <目录>
 *
 * 能力边界（必须如实告知用户与模型）：
 * - 本脚本只能校验「已经记录下来的」阶段、工具与证据，是自检与续跑合同；
 * - 它无法拦截没有记录的 MCP 调用，也无法替服务端判断计费与幂等；
 * - 计费与建项幂等由服务端合同（业务键、预留、幂等键）与真实回读共同保证，
 *   技能正文另要求每次计费动作后用 project_show / generation_status / billing_status 回读。
 *
 * 设计约束：
 * - 只落盘 JSON，不联网、不读凭据、不写项目目录内部。
 * - 阶段顺序、每阶段允许的 MCP 工具、阶段证据全部来自 mode-routing.json，脚本不维护第二份表。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRuntimeReview } from './runtime-review.mjs'
import { resolveRoute, migrateState, canonicalStage, requestQuestion, recordDecision, recordFailure } from './orchestration.mjs'
import { assertDiagramEvidence } from './diagram-evidence.mjs'
import { assertDiagramFacts } from './diagram-facts.mjs'
import { assertDatabaseRedesign } from '../references/generated-admin-hardening/scripts/check_database_redesign.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const CONTRACT = resolve(here, '..', 'references', 'mode-routing.json')
const STATE_FILE = 'jiema-state.json'

const BILLABLE_CREATE = new Set([
  'project_create',
  'project_sql_commit',
  'project_template_use',
  'project_source_doc_create',
])

const CREATE_GATES = new Set(loadContract().stages.filter(stage => stage.decisionKind === 'business-create').map(stage => stage.id))
const GENERIC_CONSENT = /^(?:继续|开始|好的?|可以|同意|确认|就这样|按推荐|下一步|go|yes|ok)[。.!！\s]*$/iu
const EXPLICIT_CREATE = /创建|建项|生成(?:项目|源码|代码)|下载源码|套用模板|保存(?:图|文档)|完成(?:项目|整个流程)|按(?:套餐|权益).{0,8}(?:扣费|结算)/u
const EXPLICIT_PREVIEW = /只读|仅.{0,12}(?:分析|设计|预演|预检)|只.{0,12}(?:分析|设计|预演|预检)|不(?:要|用|需|允许).{0,8}(?:创建|建项|生成|扣费)/u

function assertDrafts(state, requestedRoot, final = false) {
  const path = stageArtifactRecord(state, 'DIA.DRAFT')['diagram-drafts.json']
  const report = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  if (state.legacy?.completedStages.includes('DIA.DRAFT') && report?.schemaVersion !== 3) {
    state.diagramFacts = { status: 'unverified', reason: 'legacy 草稿未按新版事实合同验证；仅允许原失败点续跑' }
    return
  }
  if (!path) throw new Error('缺 diagram-drafts.json；必须补齐逐行事实证据')
  const savedPath = stageArtifactRecord(state, 'DIA.SAVE')['diagram-saved.json']
  const saved = final && savedPath ? JSON.parse(readFileSync(savedPath, 'utf8')) : null
  state.diagramFacts = assertDiagramFacts(path, {
    projectId: state.ids.projectId, projectRoot: requestedRoot || state.hardeningProjectRoot,
    sourceSha256: saved?.sourceSha256, basis: resolveRoute(loadContract(), state).diagramBasis, designSha256: saved?.designSha256,
  })
}

function terminalFor(contract, state) {
  return resolveRoute(contract, state).terminalStage
}

function assertDiagrams(state, requestedRoot) {
  const resolution = resolveRoute(loadContract(), state)
  const savedPath = stageArtifactRecord(state, 'DIA.SAVE')['diagram-saved.json']
  const result = assertDiagramEvidence(savedPath, {
    projectId: state.ids.projectId, projectRoot: requestedRoot || state.hardeningProjectRoot || state.diagramFacts?.projectRoot,
    basis: resolution.diagramBasis, designSha256: state.diagramFacts?.designSha256,
    legacy: Boolean(state.legacy?.completedStages.includes('DIA.DRAFT')),
  })
  const draftPath = stageArtifactRecord(state,'DIA.DRAFT')['diagram-drafts.json']
  if (draftPath && existsSync(draftPath)) {
    const draft=JSON.parse(readFileSync(draftPath,'utf8')), saved=JSON.parse(readFileSync(savedPath,'utf8'))
    if (draft.schemaVersion===3) {
      if (String(draft.designRevision)!==String(saved.designRevision)) throw new Error('草稿与保存回执设计版本不同')
      for (const d of draft.diagrams) if (saved.diagrams.find(row=>row.kind===d.kind)?.textSha256!==d.sha256) throw new Error(`保存正文与审核草稿不一致：${d.kind}`)
    }
  }
  return result
}

// 推进终点、verify及finish复用同一组证据检查，不另维护目标条件。
function assertFinalEvidence(contract, state, requestedRoot) {
  const { order } = resolveRoute(contract, state)
  if (order.includes('ENV.VERIFY')) assertEnvVerification(state, { requireAll: true })
  if (order.includes('HARD.FREEZE')) assertPageAudit(state, requestedRoot)
  if (order.includes('HARD.DATABASE')) assertDatabase(state, requestedRoot, 'acceptance')
  if (order.includes('DIA.DRAFT')) assertDrafts(state, requestedRoot, true)
  if (order.includes('DIA.SAVE')) assertDiagrams(state, requestedRoot)
}

function assertGateNote(stageId, note) {
  const value = String(note ?? '').trim()
  if (!value) throw new Error(`${stageId} 是用户闸门，必须用 --note 记录用户原话后进入`)
  if (CREATE_GATES.has(stageId) && (GENERIC_CONSENT.test(value) || !EXPLICIT_CREATE.test(value))) {
    throw new Error(`${stageId} 涉及建项或付费，用户原话必须明确包含创建、生成、套用或保存意图；“继续/好的/按推荐”不能充当授权`)
  }
}

function loadContract() {
  if (!existsSync(CONTRACT)) throw new Error(`找不到流程合同：${CONTRACT}`)
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'))
  if (contract.routes?.some((route) => route.entryMode === 'ai')) {
    throw new Error('流程合同仍包含已停用的 ai 建项模式')
  }
  return contract
}

function statePath(dir) {
  return join(resolve(dir), STATE_FILE)
}

function readState(dir) {
  const path = statePath(dir)
  if (!existsSync(path)) throw new Error(`没有检查点：${path}（先运行 init）`)
  const state = JSON.parse(readFileSync(path, 'utf8'))
  if (!state || typeof state !== 'object' || !state.route || !state.stage) throw new Error(`检查点格式无效：${path}`)
  const migrated = migrateState(state)
  const plan = resolveRoute(loadContract(), migrated)
  if (migrated.planDigest && migrated.planDigest !== plan.planDigest) throw new Error('执行计划摘要不一致；不能手改目标，请恢复原状态后 retarget')
  return migrated
}

function writeState(dir, state) {
  const path = statePath(dir)
  mkdirSync(dirname(path), { recursive: true })
  state.updatedAt = new Date().toISOString()
  const temporary = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, path)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  return path
}

function parseArgs(argv) {
  const command = argv[0]
  const opts = { set: [], artifact: [] }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)
    const key = arg.slice(2)
    if (key === 'set' || key === 'artifact') {
      const value = argv[++index]
      if (!value || !value.includes('=')) throw new Error(`--${key} 需要 name=value`)
      opts[key].push(value)
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`--${key} 需要一个值`)
    opts[key] = value
    index += 1
  }
  return { command, opts }
}

function requireOpt(opts, key) {
  if (!opts[key]) throw new Error(`缺少 --${key}`)
  return opts[key]
}

function artifactsOf(stage, state) {
  if (state?.legacy?.completedStages.includes(stage?.id)) return state.legacy.artifactNames[stage.id] ?? []
  return (stage?.artifacts ?? []).map((item) => item.name)
}

function stageArtifactRecord(state, stageId) {
  return (state.artifacts ?? {})[stageId] ?? {}
}

function assertDatabase(state, requestedRoot, phase = 'data') {
  const recorded = stageArtifactRecord(state, 'HARD.DATABASE')['docs/seed-data-spec.json']
  const root = requestedRoot || state.hardeningProjectRoot ||
    (recorded ? dirname(dirname(resolve(recorded))) : null)
  if (!root) throw new Error('数据库 v13 证据未验证；补做 HARD.DATABASE，不得重新建项或覆盖旧项目')
  const result = assertDatabaseRedesign(root, { phase })
  state.hardeningProjectRoot = resolve(root)
  state.databaseBinding = result.databaseBinding
  return result
}

function cmdMigrate(contract, opts) {
  const dir = requireOpt(opts, 'dir'), path = statePath(dir)
  const original = readFileSync(path, 'utf8'), state = migrateState(JSON.parse(original))
  const backup = `${path}.before-v${contract.version}`
  if (!existsSync(backup)) writeFileSync(backup, original, { flag: 'wx' })
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, stage: state.stage, status: state.status, backup, ids: state.ids, legacy: state.legacy }, null, 2))
}

function cmdDecision(contract, opts) {
  const dir = requireOpt(opts, 'dir'), state = readState(dir)
  const identity = recordDecision(state, requireOpt(opts, 'key'), requireOpt(opts, 'scope'), requireOpt(opts, 'value'), requireOpt(opts, 'note'))
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, identity, next: '沿用已回答决定，在同一任务继续' }))
}

function cmdRetarget(contract, opts) {
  const dir = requireOpt(opts, 'dir'), state = readState(dir)
  const target = requireOpt(opts, 'target'), note = requireOpt(opts, 'note')
  if (!['diagrams','system','full'].includes(target) || GENERIC_CONSENT.test(note)) throw new Error('变更须有明确交付目标原话；继续不构成范围扩大')
  if (state.pendingUserGate || state.status === 'awaiting_user') throw new Error('先处理待答的关键决定，不能用切换目标解除等待')
  if (state.target === target) throw new Error('交付目标未变化，无需重新规划')
  const previous = resolveRoute(contract,state)
  const previousStage = state.stage, previousStatus = state.status
  // history 记录的是进入阶段，文件登记也不代表已完成；只有离开的前序阶段可复用。
  const completed = new Set(state.status === 'done' ? previous.order : previous.order.slice(0, previous.order.indexOf(state.stage)))
  const candidate = { ...state, target, diagramBasis: undefined,
    projectMode: state.ids.projectId ? 'reuse' : state.projectMode,
    legacy: state.legacy ? { ...state.legacy, requiredStages: undefined } : undefined }
  if (state.route === 'source' && state.branch !== 'rebuild') candidate.branch = target === 'diagrams' ? 'documentation' : 'reuse'
  const next = resolveRoute(contract,candidate)
  state.scopeChanges ??= []
  state.scopeChanges.push({ at:new Date().toISOString(), note, target:state.target, planDigest:state.planDigest,
    history:state.history, tools:state.tools, artifacts:state.artifacts, legacy:state.legacy })
  const invalid = new Set(previous.diagramBasis !== next.diagramBasis || next.order.includes('HARD.FREEZE') && !previous.order.includes('HARD.FREEZE')
    ? ['DIA.DRAFT','DIA.SAVE','CREATE.C3','CREATE.C4','CREATE.C7','DELIVERY.FINAL'] : ['DELIVERY.FINAL'])
  state.target=target;state.branch=candidate.branch;state.projectMode=candidate.projectMode
  state.diagramBasis=next.diagramBasis;state.planDigest=next.planDigest
  state.artifacts=Object.fromEntries(Object.entries(state.artifacts).filter(([id])=>next.order.includes(id)&&!invalid.has(id)))
  state.history=state.history.filter(h=>next.order.includes(h.stage)&&!invalid.has(h.stage))
  state.tools=[] // 原调用保留在scopeChanges；新范围按新计划记录，既有projectId强制复用。
  if (state.legacy) {
    delete state.legacy.requiredStages
    state.legacy.completedStages=state.legacy.completedStages.filter(id=>next.order.includes(id)&&!invalid.has(id))
  }
  state.stage=next.order.find(id=>invalid.has(id)||!completed.has(id)||(!state.artifacts[id]&&!state.legacy?.completedStages.includes(id)))??next.terminalStage
  const retainsBlocker = previousStatus === 'blocked' && state.stage === previousStage
  state.status=retainsBlocker?'blocked':'in_progress'
  if (!retainsBlocker) state.blockers=[]
  state.pendingUserGate=null
  state.targetQuote=note
  if (!retainsBlocker) state.next=`按新范围从 ${state.stage} 继续；已保存历史成果与原业务身份`
  recordDecision(state,'delivery-target',next.planDigest,target,note)
  writeState(dir,state)
  console.log(JSON.stringify({ok:true,target,stage:state.stage,plan:next.order,ids:state.ids}))
}

function cmdFail(contract, opts) {
  const dir = requireOpt(opts, 'dir'), state = readState(dir)
  const failure = recordFailure(state, requireOpt(opts, 'code'), opts.progress ?? '', requireOpt(opts, 'recovery'))
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, stage: state.stage, status: state.status, failure }))
}

function cmdResume(contract, opts) {
  const dir = requireOpt(opts, 'dir'), state = readState(dir)
  if (state.status === 'done') throw new Error('已完成任务不能重复执行')
  if (!opts.note) throw new Error('resume 需要实际恢复证据 --note，不能凭等待时间解除阻塞')
  state.status = 'in_progress'; state.blockers = []
  const stage = contract.stages.find(item => item.id === state.stage)
  state.next = `从 ${state.stage} ${stage?.name ?? ''} 续跑；已登记恢复证据：${opts.note}`
  state.history.push({ stage: state.stage, at: new Date().toISOString(), note: `resume: ${opts.note}` })
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, stage: state.stage, ids: state.ids, next: state.next }))
}

function cmdArtifact(contract, opts) {
  const dir = requireOpt(opts, 'dir'), state = readState(dir)
  const stage = canonicalStage(opts.stage ?? state.stage)
  const resolution = resolveRoute(contract, state)
  if (resolution.order.indexOf(stage) < 0 || resolution.order.indexOf(stage) > resolution.order.indexOf(state.stage)) throw new Error('不能给未来或不适用阶段补证据')
  for (const pair of opts.artifact) {
    const [raw, ...parts] = pair.split('='), name = contract.artifactAliases[raw] ?? raw
    const path = resolve(parts.join('='))
    if (!existsSync(path) || !statSync(path).size) throw new Error(`证据不可读：${path}`)
    state.artifacts[stage] = { ...state.artifacts[stage], [name]: path }
  }
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, stage, artifacts: state.artifacts[stage] }))
}

function cmdInvalidate(contract, opts) {
  const dir = requireOpt(opts, 'dir'), state = readState(dir), from = canonicalStage(requireOpt(opts, 'from'))
  if (!/^(ENV|HARD|DIA)\./.test(from)) throw new Error('不得回退到收费创建/生成阶段')
  const resolution = resolveRoute(contract, state), at = resolution.order.indexOf(from)
  if (at < 0 || at > resolution.order.indexOf(state.stage)) throw new Error('返工点不在已执行范围')
  const reason = requireOpt(opts, 'reason'), invalidated = resolution.order.slice(at)
  state.invalidations ??= []
  state.invalidations.push({ reason, at: new Date().toISOString(), stages: invalidated, artifacts: Object.fromEntries(invalidated.map(id => [id, state.artifacts[id] ?? {}])) })
  for (const id of invalidated) delete state.artifacts[id]
  if (state.legacy) state.legacy.completedStages = state.legacy.completedStages.filter(id => !invalidated.includes(id))
  state.history = state.history.filter(h => !invalidated.includes(h.stage))
  state.stage = from; state.status = 'in_progress'; state.pendingUserGate = null; state.blockers = []
  if (invalidated.includes('HARD.DATABASE')) delete state.databaseBinding
  state.history.push({ stage: from, at: new Date().toISOString(), note: `invalidate: ${reason}` })
  state.next = `从 ${from} 复验；原项目与费用身份不变`
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, invalidated, ids: state.ids }))
}

function assertPageTasks(state, requestedRoot, phase) {
  if (state.legacy?.completedStages.includes('HARD.FREEZE')) return { valid: true, businessStatus: 'legacy/unverified' }
  const registered = stageArtifactRecord(state, 'HARD.PAGES')
  const path = registered['docs/page-business-plan.json']
  const projectRoot = requestedRoot || state.hardeningProjectRoot || (path ? dirname(dirname(resolve(path))) : null)
  if (!projectRoot) throw new Error('页面任务无法定位项目根目录；登记HARD.PAGES产物或传--project-root')
  const checker = [resolve(here, '../references/generated-admin-hardening/scripts/page_tasks.py'),
    resolve(here, '../../generated-admin-hardening/scripts/page_tasks.py')].find(p => existsSync(p))
  if (!checker) throw new Error('随包页面任务脚本缺失')
  const args = [checker, 'verify', '--project-root', resolve(projectRoot), '--phase', phase]
  if (phase === 'implemented') {
    if (!registered['page-task-state.json']) throw new Error('HARD.PAGES缺项目外page-task-state.json')
    args.push('--state', resolve(registered['page-task-state.json']))
  }
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', args,
    { encoding: 'utf8', timeout: 55000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  if (result.error || result.status !== 0) throw new Error(`页面任务门禁未通过：${result.error?.message ?? ''} ${result.stdout ?? ''}${result.stderr ?? ''}`)
  const report = JSON.parse(result.stdout)
  if (report.valid !== true) throw new Error('页面任务门禁无有效结果')
  state.hardeningProjectRoot = resolve(projectRoot)
  return report
}

function assertPageAudit(state, requestedRoot) {
  const recorded = stageArtifactRecord(state, 'HARD.FREEZE')['docs/page-redesign-audit.json']
  if (!recorded) throw new Error('HARD.FREEZE 未登记页面审计记录')
  const auditPath = resolve(recorded)
  const projectRoot = requestedRoot || state.hardeningProjectRoot ||
    (basename(dirname(auditPath)) === 'docs' ? dirname(dirname(auditPath)) : null)
  if (!projectRoot) throw new Error('HARD.FREEZE 无法定位项目根目录，请传 --project-root；标准 docs/page-redesign-audit.json 可自动定位')
  const candidates = [
    resolve(here, '../references/generated-admin-hardening/scripts/check_page_redesign.py'),
    resolve(here, '../../generated-admin-hardening/scripts/check_page_redesign.py'),
  ]
  const checker = candidates.find(path => existsSync(path))
  if (!checker) throw new Error('HARD.FREEZE 随包页面审计脚本缺失')
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [checker, '--project-root', resolve(projectRoot), '--audit', auditPath], {
      encoding: 'utf8', timeout: 55000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
  if (result.error || result.status !== 0) {
    throw new Error(`HARD.FREEZE 页面审计未通过：${result.error?.message ?? ''} ${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  const report = JSON.parse(result.stdout)
  if (report.status !== 'passed') throw new Error('HARD.FREEZE 页面审计没有返回 passed')
  const runtimePath = stageArtifactRecord(state, 'HARD.FREEZE')['docs/runtime-review.json']
  if (!runtimePath) throw new Error('HARD.FREEZE 未登记统一口令与页面可视复审 docs/runtime-review.json')
  assertRuntimeReview(resolve(projectRoot), JSON.parse(readFileSync(auditPath, 'utf8')), resolve(runtimePath))
  if (!state.legacy?.completedStages.includes('HARD.FREEZE')) assertDatabaseRedesign(projectRoot, { phase: 'acceptance' })
  assertPageTasks(state, projectRoot, 'complete')
  state.hardeningProjectRoot = resolve(projectRoot)
  return report
}

function readEnvVerification(state) {
  const artifactPath = stageArtifactRecord(state, 'ENV.VERIFY')['verify.json']
  if (!artifactPath) throw new Error('ENV.VERIFY 未登记 verify.json')
  const path = resolve(artifactPath)
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`ENV.VERIFY verify.json 不存在或为空：${path}`)
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`ENV.VERIFY verify.json 不是有效 JSON：${path}`)
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || !Array.isArray(report.passed) || !Array.isArray(report.failed) || !Array.isArray(report.needsHuman)
    || report.passed.length === 0) {
    throw new Error('ENV.VERIFY verify.json 必须包含非空 passed、failed 和 needsHuman 数组')
  }
  // Agent 补充项引用本轮文件；存在性只验证引用有效，不认证实测是否发生。
  for (const item of report.passed) {
    if (item?.evidence === undefined) continue
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      throw new Error(`ENV.VERIFY ${item.item ?? '通过项'} 的 evidence 必须为非空文件路径数组`)
    }
    for (const reference of item.evidence) {
      if (typeof reference !== 'string' || !reference.trim()) throw new Error('ENV.VERIFY 证据文件路径无效')
      const evidencePath = resolve(dirname(path), reference)
      if (!existsSync(evidencePath) || !statSync(evidencePath).isFile() || statSync(evidencePath).size === 0) {
        throw new Error(`ENV.VERIFY ${item.item ?? '通过项'} 证据文件缺失、为空或不是文件：${evidencePath}`)
      }
    }
  }
  return report
}

function assertEnvVerification(state, { requireAll = false } = {}) {
  const report = readEnvVerification(state)
  if (report.failed.length) throw new Error(`ENV.VERIFY verify.json 仍有 ${report.failed.length} 项 failed，不能推进`)
  if (requireAll && report.needsHuman.length) {
    throw new Error(`ENV.VERIFY verify.json 仍有 ${report.needsHuman.length} 项 needsHuman，须补齐真实验证后才能交付`)
  }
  return report
}

function cmdInit(contract, opts) {
  const route = requireOpt(opts, 'route')
  const dir = requireOpt(opts, 'dir')
  if (existsSync(statePath(dir))) throw new Error('检查点已存在，拒绝覆盖；使用 status 或 resume')
  if (route === 'diagram-only' && !opts['project-id']) throw new Error('独立补图需要原 project-id，不能猜测或新建')
  if (opts.deliverable && opts.deliverable !== 'source-only') throw new Error('未知限缩范围')
  if (opts.deliverable && opts.target && opts.target !== 'source-only') throw new Error('交付目标与限缩范围冲突')
  if ((opts.deliverable || opts.target === 'source-only') && !opts.note) throw new Error('限缩交付范围须记录用户原话')
  const projectMode = opts['project-id'] ? 'reuse' : 'create'
  const resolution = resolveRoute(contract, { route, target: opts.deliverable ?? opts.target, branch: opts.branch,
    projectMode, diagramBasis: opts['diagram-basis'] })
  const target = resolution.target
  if (target === 'preview' && (!opts.note || !EXPLICIT_PREVIEW.test(opts.note))) {
    throw new Error('仅预演目标必须用 --note 记录用户明确限制范围的原话')
  }
  if (target === 'preview' && (resolution.branch?.id === 'rebuild' || resolution.branch?.id === 'run-verification')) {
    throw new Error('源码重建/运行验证分支不能标成仅预演目标')
  }
  const first = resolution.stages.get(resolution.order[0])
  const state = {
    contractVersion: contract.version,
    projectMode, diagramBasis: resolution.diagramBasis, planDigest: resolution.planDigest,
    questions: {}, choiceCards: 0, failures: {},
    route,
    branch: resolution.branch?.id ?? null,
    target,
    targetQuote: opts.note ?? null,
    stage: resolution.order[0],
    status: 'in_progress',
    ids: opts['project-id'] ? { projectId: opts['project-id'], ...(opts['design-revision'] ? { designRevision: opts['design-revision'] } : {}) } : {},
    decisions: {},
    evidence: [],
    artifacts: {},
    tools: [],
    history: [{ stage: resolution.order[0], at: new Date().toISOString(), note: opts.note ? `init: ${opts.note}` : 'init' }],
    next: `按 ${first.id} ${first.name} 执行`,
    blockers: [],
  }
  if (opts.note) recordDecision(state, 'delivery-target', 'task', target, opts.note)
  if (opts['target-source'] === 'card') {
    if (!opts.note || GENERIC_CONSENT.test(opts.note)) throw new Error('交付选择卡必须记录明确选项与原话')
    state.choiceCards = 1
  }
  const path = writeState(dir, state)
  console.log(JSON.stringify({
    ok: true, file: path, route, branch: state.branch, target, terminalStage: terminalFor(contract, state), stage: state.stage,
    stageName: first.name,
    plan: resolution.order,
    requiredArtifacts: artifactsOf(first),
    boundary: '检查点只自检已记录的阶段/工具/证据，不能拦截未记录的 MCP 调用；计费与幂等由服务端合同与回读保证。',
  }, null, 2))
}

function cmdStatus(contract, opts) {
  const dir = requireOpt(opts, 'dir')
  const state = readState(dir)
  const resolution = resolveRoute(contract, state)
  const index = resolution.order.indexOf(state.stage)
  const current = resolution.stages.get(state.stage)
  let pendingVerification = null
  if (resolution.order.includes('ENV.VERIFY') && stageArtifactRecord(state, 'ENV.VERIFY')['verify.json']) {
    try {
      const report = readEnvVerification(state)
      pendingVerification = { failed: report.failed.length, needsHuman: report.needsHuman.length }
    } catch (error) {
      pendingVerification = { error: error instanceof Error ? error.message : String(error) }
    }
  }
  console.log(JSON.stringify({
    file: statePath(dir),
    route: state.route,
    branch: state.branch,
    target: state.target ?? 'full',
    terminalStage: terminalFor(contract, state),
    stage: state.stage,
    stageName: current?.name,
    status: state.status,
    progress: `${index + 1}/${resolution.order.length}`,
    nextStages: resolution.order.slice(index + 1, index + 3),
    allowedTools: current?.mcp ?? [],
    diagramBasis: resolution.diagramBasis, planDigest: resolution.planDigest, skippedStages: resolution.skipped,
    requiredArtifacts: artifactsOf(current),
    registeredArtifacts: stageArtifactRecord(state, state.stage),
    ids: state.ids,
    blockers: state.blockers,
    pendingUserGate: state.pendingUserGate ?? null,
    pendingVerification,
    updatedAt: state.updatedAt,
  }, null, 2))
}

function cmdAdvance(contract, opts) {
  const dir = requireOpt(opts, 'dir')
  const to = canonicalStage(requireOpt(opts, 'to'))
  const state = readState(dir)
  const resolution = resolveRoute(contract, state)
  const fromIndex = resolution.order.indexOf(state.stage)
  const toIndex = resolution.order.indexOf(to)
  if (toIndex < 0) {
    throw new Error(`阶段 ${to} 不在路由 ${state.route}${state.branch ? `/${state.branch}` : ''} 的序列中：${resolution.order.join(' → ')}`)
  }
  if (state.status === 'done') throw new Error('任务已结束；不得重复推进')
  if (state.status === 'blocked') throw new Error('阶段仍 blocked；先凭真实恢复证据 resume，再从当前阶段续跑')
  if (toIndex === fromIndex) throw new Error(`已经处于 ${to}`)
  if (toIndex < fromIndex) throw new Error(`不允许回退到 ${to}；返工请用 --note 在 ${state.stage} 记录，或新建检查点`)
  if (toIndex > fromIndex + 1) {
    const skipped = resolution.order.slice(fromIndex + 1, toIndex)
    throw new Error(`禁止跨越阶段：${state.stage} → ${to} 跳过了 ${skipped.join(', ')}`)
  }

  const terminalIndex = resolution.order.indexOf(terminalFor(contract, state))
  if (toIndex > terminalIndex) throw new Error(`当前目标是 ${state.target ?? 'full'}，终点为 ${terminalFor(contract, state)}；不得擅自推进到 ${to}`)

  if (opts['await-user'] && opts.blocked) throw new Error('--await-user 与 --blocked 不能同时使用')
  if (opts['await-user']) {
    const gate = resolution.stages.get(to)
    if (CREATE_GATES.has(to) && state.targetQuote && EXPLICIT_CREATE.test(state.targetQuote) && !GENERIC_CONSENT.test(state.targetQuote)) {
      recordDecision(state, opts.key ?? to, opts.scope ?? to, 'create', state.targetQuote)
      writeState(dir, state)
    }
    const question = requestQuestion(state, opts.key ?? to, opts.scope ?? to, opts.category ?? 'critical-business-or-high-risk-ambiguity')
    if (!question.ask) { console.log(JSON.stringify({ ok: true, ...question })); return }
    if (!gate?.userGate && !gate?.requiresUserConfirmation) throw new Error(`${to} 不是用户选择闸门，不能标记 awaiting_user`)
    state.status = 'awaiting_user'
    state.pendingUserGate = to
    state.blockers = []
    state.next = `等待用户在原生选择卡作答：${opts['await-user']}；收到答复后自动继续 ${to}`
    state.history.push({ stage: state.stage, at: new Date().toISOString(), note: `awaiting_user ${to}: ${opts['await-user']}` })
    writeState(dir, state)
    console.log(JSON.stringify({ ok: true, awaitingUser: true, stage: state.stage, pendingUserGate: to, next: state.next }, null, 2))
    return
  }

  if (opts.blocked) {
    state.status = 'blocked'
    state.blockers = [opts.blocked]
    state.history.push({ stage: state.stage, at: new Date().toISOString(), note: `blocked: ${opts.blocked}` })
    writeState(dir, state)
    console.log(JSON.stringify({ ok: true, blocked: true, stage: state.stage, blockers: state.blockers }, null, 2))
    return
  }

  for (const pair of opts.artifact) {
    const [rawName, ...rest] = pair.split('=')
    const name = contract.artifactAliases[rawName] ?? rawName
    const value = rest.join('=')
    if (!name || !value) throw new Error(`--artifact 格式应为 name=path：${pair}`)
    state.artifacts[state.stage] = { ...(state.artifacts[state.stage] ?? {}), [name]: value }
  }

  // 离开当前阶段前，校验该阶段声明的完成证据已经登记并可读。
  const currentStage = resolution.stages.get(state.stage)
  const required = artifactsOf(currentStage, state)
  const registered = stageArtifactRecord(state, state.stage)
  const missing = required.filter((name) => !registered[name])
  if (missing.length) {
    throw new Error(`阶段 ${state.stage} 的完成证据缺失：${missing.join(', ')}；请用 --artifact 名称=路径 登记后再进入 ${to}`)
  }
  const unreadable = required.filter((name) => {
    const artifactPath = resolve(registered[name])
    return !existsSync(artifactPath) || statSync(artifactPath).size === 0
  })
  if (unreadable.length) {
    throw new Error(`阶段 ${state.stage} 的证据文件不存在或为空：${unreadable.map((name) => `${name}=${registered[name]}`).join(', ')}`)
  }

  if (state.stage === 'HARD.PAGES') assertPageTasks(state, opts['project-root'], 'implemented')
  if (state.stage === 'HARD.DATABASE' || to === 'HARD.ACCEPTANCE') assertDatabase(state, opts['project-root'])
  // ENV.VERIFY 的未验证项可以随独立的业务改造继续，但交付前必须补齐。
  if (state.stage === 'ENV.VERIFY') assertEnvVerification(state)
  if (to === 'DELIVERY.FINAL') assertFinalEvidence(contract, state, opts['project-root'])
  else {
    if (state.stage === 'HARD.FREEZE') assertPageAudit(state, opts['project-root'])
    if (state.stage === 'DIA.DRAFT') assertDrafts(state, opts['project-root'])
    if (state.stage === 'DIA.SAVE') assertDiagrams(state, opts['project-root'])
  }
  const target = resolution.stages.get(to)
  const decided = state.decisions[`${opts.key ?? to}:${opts.scope ?? to}`]
  let gateNote = opts.note || decided?.quote || state.history.find(h => h.stage === to && h.note)?.note || state.targetQuote || ''
  if (target?.userGate || target?.requiresUserConfirmation) {
    if (!gateNote && to !== 'ENV.AUTHORIZE') throw new Error(`${to} 缺决定记录`)
    if (to === 'ENV.AUTHORIZE') {
      const planPath = stageArtifactRecord(state, 'ENV.PLAN')['plan.json']
      const plan = JSON.parse(readFileSync(planPath, 'utf8'))
      const system = (plan.actions ?? []).filter(a => a.privileges !== 'user' || a.kind === 'append-profile-path')
      if (system.length) assertGateNote(to, opts.note || decided?.quote)
      else gateNote = '具体计划只有已授权范围内用户级动作，无需系统授权卡'
    } else assertGateNote(to, gateNote)
  }
  if (state.pendingUserGate && state.pendingUserGate !== to) throw new Error(`正在等待 ${state.pendingUserGate} 的用户答复，不能推进到 ${to}`)

  state.stage = to
  state.status = 'in_progress'
  state.blockers = []
  state.pendingUserGate = null
  state.next = `按 ${target.id} ${target.name} 执行`
  state.history.push({ stage: to, at: new Date().toISOString(), note: gateNote })
  const path = writeState(dir, state)
  console.log(JSON.stringify({
    ok: true, file: path, stage: to, stageName: target.name,
    allowedTools: target.mcp ?? [], requiredArtifacts: artifactsOf(target),
  }, null, 2))
}

function cmdRecord(contract, opts) {
  const dir = requireOpt(opts, 'dir')
  const tool = requireOpt(opts, 'tool')
  const state = readState(dir)
  const resolution = resolveRoute(contract, state)
  const route = resolution.route
  const forbiddenByRoute = resolution.forbiddenTools
  if (forbiddenByRoute.includes(tool)) {
    throw new Error(`路由 ${state.route}/${state.target} 禁止调用 ${tool}：超出本次交付范围`)
  }
  const currentStage = resolution.stages.get(state.stage)
  const allowed = currentStage?.mcp ?? []
  if (!allowed.includes(tool)) {
    throw new Error(`阶段 ${state.stage}（${currentStage?.name}）不允许调用 ${tool}；本阶段允许 ${allowed.length ? allowed.join(', ') : '无 MCP 工具'}`)
  }
  if (!['recorded', 'failed', 'succeeded', 'unknown'].includes(opts.outcome ?? 'recorded')) throw new Error('工具结果必须 recorded/failed/succeeded/unknown')
  if (BILLABLE_CREATE.has(tool) && opts.outcome === 'succeeded' && state.tools.some(t => BILLABLE_CREATE.has(t.tool) && t.outcome === 'succeeded' && t.identity !== opts.identity)) throw new Error('已有成功建项身份，禁止以不同身份重复建项')
  state.tools = [...(state.tools ?? []), { tool, stage: state.stage, outcome: opts.outcome ?? 'recorded', identity: opts.identity ?? null, at: new Date().toISOString() }]
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, tool, stage: state.stage }, null, 2))
}

function cmdIds(contract, opts) {
  const dir = requireOpt(opts, 'dir')
  const state = readState(dir)
  if (!opts.set.length) throw new Error('至少一个 --set name=value')
  const applied = {}
  for (const pair of opts.set) {
    const [name, ...rest] = pair.split('=')
    const value = rest.join('=')
    if (!name || !value) throw new Error(`--set 格式应为 name=value：${pair}`)
    if (state.ids[name] && state.ids[name] !== value) throw new Error(`业务身份 ${name} 已冻结，不能换号重试`)
    state.ids[name] = value
    applied[name] = value
  }
  const path = writeState(dir, state)
  console.log(JSON.stringify({ ok: true, file: path, ids: applied }, null, 2))
}

function validateState(contract, state) {
  const resolution = resolveRoute(contract, state)
  const problems = []
  const notes = []
  if (state.planDigest && state.planDigest !== resolution.planDigest) problems.push('执行计划已变化；须记录范围变更并重新解析，不能手改目标')
  if (state.status === 'done' && state.target !== 'preview') {
    try { assertFinalEvidence(contract, state) } catch (error) { problems.push(error.message) }
  }

  if (!resolution.order.includes(state.stage)) problems.push(`检查点阶段 ${state.stage} 不在当前路由序列中`)
  if (state.status === 'done' && state.stage !== terminalFor(contract, state)) {
    problems.push(`当前目标 ${state.target ?? 'full'} 只能在 ${terminalFor(contract, state)} 完成，实际停在 ${state.stage}`)
  }
  const reached = new Set((state.history ?? []).map((entry) => entry.stage))
  for (const id of resolution.order) {
    const stage = resolution.stages.get(id)
    if (stage?.userGate && reached.has(id) && !(state.history ?? []).some((entry) => entry.stage === id && entry.note)) {
      problems.push(`用户闸门 ${id} 没有记录用户原话`)
    }
  }
  const billableUsed = [...new Map((state.tools ?? []).filter(entry => BILLABLE_CREATE.has(entry.tool) && entry.outcome === 'succeeded').map((entry, index) => [entry.identity ?? `unknown-${index}`, entry])).values()]
  if (billableUsed.length > 1) problems.push(`计费建项动作出现 ${billableUsed.length} 次（G4 只允许一次）`)

  const forbid = resolution.forbiddenTools
  const violated = (state.tools ?? []).filter((entry) => forbid.includes(entry.tool))
  if (violated.length) problems.push(`路由 ${state.route} 出现禁止工具：${[...new Set(violated.map((entry) => entry.tool))].join(', ')}`)

  const requiredStages = resolution.order.filter(id => id !== terminalFor(contract, state) && !state.legacy?.completedStages.includes(id))
  const missingStages = requiredStages.filter((id) => resolution.order.includes(id) && !reached.has(id))
  if (state.status === 'done' && state.target !== 'preview' && missingStages.length) {
    problems.push(`状态为 done 但缺少必经阶段：${missingStages.join(', ')}（G10）`)
  }

  if (reached.has('ENV.VERIFY') && (resolution.order.indexOf(state.stage) > resolution.order.indexOf('ENV.VERIFY') || state.status === 'done')) {
    try {
      const report = assertEnvVerification(state, { requireAll: state.status === 'done' || state.stage === 'DELIVERY.FINAL' })
      if (report.needsHuman.length) notes.push(`ENV.VERIFY 仍有 ${report.needsHuman.length} 项 needsHuman：可继续业务改造，不能完成交付。`)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (resolution.order.includes('HARD.FREEZE') && resolution.order.indexOf(state.stage) > resolution.order.indexOf('HARD.FREEZE')) {
    try {
      assertPageAudit(state)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }

  for (const stageId of reached) {
    const stage = resolution.stages.get(stageId)
    if (!stage) continue
    const required = artifactsOf(stage, state)
    const registered = stageArtifactRecord(state, stageId)
    for (const name of required) {
      if (!registered[name]) {
        if (resolution.order.indexOf(stageId) < resolution.order.indexOf(state.stage)) {
          problems.push(`阶段 ${stageId} 已完成但未登记证据 ${name}`)
        }
        continue
      }
      const artifactPath = resolve(registered[name])
      if (!existsSync(artifactPath) || statSync(artifactPath).size === 0) {
        problems.push(`阶段 ${stageId} 的证据文件不存在或为空：${name}=${registered[name]}`)
      }
    }
  }

  if (state.status === 'done' && state.target !== 'preview' && resolution.order.includes('HARD.FREEZE')) {
    try { assertDatabase(state, undefined, 'acceptance') } catch (error) { problems.push(error.message) }
    const hasEnvVerify = Boolean(stageArtifactRecord(state, 'ENV.VERIFY')['verify.json'])
    const hasAudit = Boolean(stageArtifactRecord(state, 'HARD.FREEZE')['docs/page-redesign-audit.json'])
    if (!hasEnvVerify) problems.push('状态为 done 但没有 ENV.VERIFY 的 verify.json（G11）')
    if (!hasAudit) problems.push('状态为 done 但没有 HARD.FREEZE 的页面审计记录（G11）')
    const h6 = (state.history ?? []).some((entry) => entry.stage === 'HARD.REWORK' && entry.note)
    if (!h6) problems.push('状态为 done 但 HARD.REWORK 没有返工/复验记录（G7）')
  }

  notes.push('本检查点只覆盖已记录内容：未记录的 MCP 调用无法被判错，计费与幂等以服务端合同和回读为准。')
  if (state.route === 'source' && state.branch === 'documentation') notes.push('源码文档模式不含 E/H 阶段；出现即视为流程错误。')
  return { problems, notes }
}

function cmdVerify(contract, opts) {
  const state = readState(requireOpt(opts, 'dir'))
  const { problems, notes } = validateState(contract, state)
  console.log(JSON.stringify({ ok: problems.length === 0, route: state.route, branch: state.branch, target: state.target ?? 'full', stage: state.stage, status: state.status, problems, notes }, null, 2))
  if (problems.length) process.exitCode = 1
}

function cmdFinish(contract, opts) {
  const dir = requireOpt(opts, 'dir')
  const state = readState(dir)
  if (state.stage !== terminalFor(contract, state)) throw new Error(`目标 ${state.target ?? 'full'} 尚未到达终点 ${terminalFor(contract, state)}，当前为 ${state.stage}`)
  if (state.status === 'blocked') throw new Error('阶段仍 blocked，不能完成；先恢复失败点')
  if (state.status === 'awaiting_user' || state.pendingUserGate) throw new Error('仍在等待用户选择，不能标记完成')
  for (const pair of opts.artifact) {
    const [rawName, ...rest] = pair.split('=')
    const name = contract.artifactAliases[rawName] ?? rawName
    const value = rest.join('=')
    if (!name || !value) throw new Error(`--artifact 格式应为 name=path：${pair}`)
    state.artifacts[state.stage] = { ...(state.artifacts[state.stage] ?? {}), [name]: value }
  }
  const resolution = resolveRoute(contract, state)
  const required = artifactsOf(resolution.stages.get(state.stage))
  const registered = stageArtifactRecord(state, state.stage)
  for (const name of required) {
    if (!registered[name] || !existsSync(resolve(registered[name])) || statSync(resolve(registered[name])).size === 0) {
      throw new Error(`终点 ${state.stage} 的证据缺失或为空：${name}`)
    }
  }
  if (state.target !== 'preview') assertFinalEvidence(contract, state, opts['project-root'])
  state.status = 'done'
  state.next = '目标已完成'
  state.history.push({ stage: state.stage, at: new Date().toISOString(), note: `finish: ${state.target ?? 'full'}` })
  const { problems } = validateState(contract, state)
  if (problems.length) throw new Error(`无法完成目标：${problems.join('；')}`)
  writeState(dir, state)
  console.log(JSON.stringify({ ok: true, target: state.target ?? 'full', stage: state.stage, status: state.status }, null, 2))
}

function main() {
  const argv = process.argv.slice(2)
  if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) {
    console.log('用法：checkpoint.mjs <init|status|advance|finish|record|ids|verify|migrate|decision|retarget|fail|resume|artifact|invalidate> [--dir 目录] [选项]')
    return
  }
  const contract = loadContract()
  const { command, opts } = parseArgs(argv)
  const table = { init: cmdInit, status: cmdStatus, advance: cmdAdvance, finish: cmdFinish, record: cmdRecord, ids: cmdIds, verify: cmdVerify,
    migrate: cmdMigrate, decision: cmdDecision, retarget: cmdRetarget, fail: cmdFail, resume: cmdResume, artifact: cmdArtifact, invalidate: cmdInvalidate }
  const handler = table[command]
  if (!handler) throw new Error(`未知命令：${command}`)
  handler(contract, opts)
}

try {
  main()
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 2
}

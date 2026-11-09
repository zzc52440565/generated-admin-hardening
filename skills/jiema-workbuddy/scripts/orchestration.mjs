import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { conventions } from './policy.mjs'

export const contract = JSON.parse(readFileSync(new URL('../references/mode-routing.json', import.meta.url), 'utf8'))
export const canonicalStage = id => contract.stageAliases[id] ?? id
export const scopeDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function resolveRoute(c, request) {
  const { route: routeId, projectMode = 'create' } = request
  const route = c.routes.find(r => r.id === routeId)
  if (!route) throw new Error(`未知路由：${routeId}`)
  const targetId = request.target ?? route.defaultTarget ?? route.branches?.find(b => b.id === request.branch)?.defaultTarget
  if (!targetId) throw new Error('缺交付目标：根据用户原话确定 diagrams/system/full；未明确只问一次，不默认全套')
  const target = c.targets[targetId]
  if (!target) throw new Error(`未知交付目标：${targetId}`)
  const branchId = request.branch ?? (routeId === 'source' ? ['diagrams', 'preview'].includes(targetId) ? 'documentation' : 'reuse' : undefined)
  const branch = route.branches?.find(b => b.id === branchId)
  if (route.branches?.length && !branch) throw new Error(`未知分支：${branchId}`)
  if ((branch?.targets ?? route.targets)?.includes(targetId) === false) throw new Error(`目标 ${targetId} 与 ${routeId}/${branchId ?? ''} 冲突`)
  if (!['create', 'reuse'].includes(projectMode)) throw new Error('projectMode 只能 create/reuse')
  const selected = branch ?? route
  let order = [...selected.stages], tail = [...(selected.tail ?? [])]
  if (selected.thenRoute) {
    const next = c.routes.find(r => r.id === selected.thenRoute), at = next?.stages.indexOf(selected.enterAt)
    if (at === undefined || at < 0) throw new Error('合同接入阶段不存在')
    order.push(...next.stages.slice(at)); tail = [...next.tail]
  }
  const capabilities = { ...target.capabilities, ...route.capabilities, ...branch?.capabilities }
  const expand = ids => ids.flatMap(id => c.stageGroups[id] ? c.stageGroups[id].stages : [id])
  const raw = expand([...order, ...tail])
  const enabled = id => Object.values(c.stageGroups).every(g => !g.stages.includes(id) || capabilities[g.capability])
  let filtered = raw.filter(enabled)
  let terminalStage = target.terminalStage
  if (targetId === 'preview') {
    terminalStage = target.terminalByRoute[routeId]
    const at = raw.indexOf(terminalStage)
    if (!terminalStage || at < 0) throw new Error(`不支持 ${routeId} 的只读预演`)
    filtered = raw.slice(0, at + 1)
  }
  // 迁移边界留下的旧限缩计划也走同一解释器；不把历史范围升级为新全套。
  if (request.legacy?.requiredStages) filtered = [...request.legacy.requiredStages]
  const diagramBasis = filtered.includes('DIA.DRAFT')
    ? routeId === 'diagram-only' ? request.diagramBasis ?? 'source'
      : routeId === 'source' || filtered.includes('CREATE.DOWNLOAD') || filtered.includes('HARD.FREEZE') ? 'source' : 'design'
    : null
  if (diagramBasis && !['design', 'source'].includes(diagramBasis)) throw new Error('图稿依据只能 design/source')
  if (request.diagramBasis && request.diagramBasis !== diagramBasis) throw new Error('图稿依据与目标/源码来源冲突')
  const creates = c.tools.billable.filter(t => t !== 'project_generate')
  const forbiddenTools = new Set(route.forbidToolsByBranch?.[branch?.id] ?? route.forbidTools ?? [])
  if (!filtered.includes('CREATE.GENERATE')) ['project_generate', 'project_download'].forEach(t => forbiddenTools.add(t))
  if (!filtered.includes('DIA.SAVE')) c.tools.diagramWrite.forEach(t => forbiddenTools.add(t))
  if (diagramBasis === 'design') forbiddenTools.add('diagram_bind_source')
  if (projectMode === 'reuse' || !filtered.some(id => c.stages.find(s => s.id === id)?.projectIdentity)) creates.forEach(t => forbiddenTools.add(t))
  if (targetId === 'preview') c.tools.neverBeforeUserDecision.forEach(t => forbiddenTools.add(t))
  const stages = new Map(c.stages.map(s => [s.id, { ...s, mcp: (s.mcp ?? []).filter(t => !forbiddenTools.has(t)) }]))
  for (const id of filtered) if (!stages.has(id)) throw new Error(`阶段缺定义：${id}`)
  if (new Set(filtered).size !== filtered.length) throw new Error('路由阶段重复')
  if (filtered.includes('HARD.ACCEPTANCE') && !filtered.includes('ENV.VERIFY')) throw new Error('业务验收必须有环境验证')
  const planDigest = scopeDigest({ route: routeId, branch: branch?.id ?? null, target: targetId, projectMode, diagramBasis, order: filtered })
  return { route, branch, target: targetId, order: filtered, stages, diagramBasis, terminalStage, planDigest,
    forbiddenTools: [...forbiddenTools], skipped: raw.filter(id => !filtered.includes(id)) }
}

// 纯内存映射；status 不落盘。首次显式 migrate 保留原文件备份。
export function migrateState(input) {
  const s = structuredClone(input), oldStage = s.stage
  if (s.contractVersion > contract.version) throw new Error('检查点来自更高版本合同，不能降级运行')
  const oldVersion = s.contractVersion ?? 12
  const legacy = oldVersion < contract.version
  s.stage = canonicalStage(s.stage)
  s.history = (s.history ?? []).map(h => ({ ...h, stage: canonicalStage(h.stage) }))
  s.tools = (s.tools ?? []).map(t => ({ ...t, stage: canonicalStage(t.stage) }))
  s.pendingUserGate = s.pendingUserGate ? canonicalStage(s.pendingUserGate) : null
  s.artifacts = Object.fromEntries(Object.entries(s.artifacts ?? {}).map(([id, values]) => [canonicalStage(id), Object.fromEntries(Object.entries(values).map(([name, p]) => [contract.artifactAliases[name] ?? name, p]))]))
  if (legacy) {
    const oldTarget = s.target ?? 'full', delivery = s.delivery
    if (oldVersion < 14) s.target = oldTarget === 'preview' ? 'preview'
      : s.route === 'diagram-only' || (s.route === 'source' && (!s.branch || s.branch === 'documentation')) ? 'diagrams'
        : ['env-only', 'harden-only'].includes(s.route) || s.branch === 'run-verification' ? 'system'
          : delivery && !delivery.diagrams ? delivery.localRuntime ? 'system' : 'source-only' : 'full'
    if (oldVersion < 14 && s.route === 'source' && !s.branch) s.branch = 'documentation'
    const plan = resolveRoute(contract, { ...s, legacy: undefined, diagramBasis: undefined })
    let order = plan.order
    if (delivery && oldTarget !== 'preview') {
      const oldPlan = resolveRoute(contract, { ...s, target: s.route === 'source' && s.branch === 'documentation' ? 'diagrams' : plan.target,
        legacy: undefined, diagramBasis: undefined }).order
      order = oldPlan.filter(id => !id.startsWith('ENV.') || delivery.localRuntime)
        .filter(id => !id.startsWith('HARD.') || delivery.hardening).filter(id => !id.startsWith('DIA.') || delivery.diagrams)
    }
    const completed = order.slice(0, Math.max(0, order.indexOf(s.stage)))
    s.legacy = { ...s.legacy, contractVersion: s.legacy?.contractVersion ?? oldVersion,
      originalStage: s.legacy?.originalStage ?? oldStage, originalTarget: s.legacy?.originalTarget ?? oldTarget,
      completedStages: s.legacy?.completedStages ?? completed,
      artifactNames: s.legacy?.artifactNames ?? Object.fromEntries(completed.map(id => [id, Object.keys(s.artifacts[id] ?? {})])),
      databaseV13: s.legacy?.databaseV13 ?? (oldVersion < 13 && completed.includes('HARD.DATABASE') ? 'unverified' : 'requires-evidence'),
      evidenceStatus: 'unverified' }
    if (JSON.stringify(order) !== JSON.stringify(plan.order)) s.legacy.requiredStages = order
    delete s.delivery
    s.projectMode ??= 'create'
    const resolved = resolveRoute(contract, { ...s, diagramBasis: undefined })
    s.diagramBasis = resolved.diagramBasis
    s.planDigest = resolved.planDigest
  }
  s.contractVersion = contract.version
  s.decisions ??= {}; s.questions ??= {}; s.choiceCards ??= 0; s.failures ??= {}
  return s
}

export function requestQuestion(state, key, scope, category) {
  if (!contract.interaction.allowedInterruptions.includes(category)) throw new Error('不属于允许打断用户的四类场景')
  const identity = `${key}:${scope}`
  if (state.decisions[identity] || state.questions[identity]) return { ask: false, identity, reason: '已回答或正在等待，禁止重复提问' }
  if (state.choiceCards >= conventions.interaction.maxDefaultChoiceCards) throw new Error('默认路径选择卡预算已用尽；合并未决关键事实，不重复询问')
  state.questions[identity] = { key, scope, category, status: 'awaiting_user' }
  state.choiceCards += 1
  return { ask: true, identity }
}

export function recordDecision(state, key, scope, value, quote) {
  if (!quote?.trim() || !value?.trim()) throw new Error('决定必须有真实原话与明确值')
  const identity = `${key}:${scope}`
  state.decisions[identity] = { key, scope, value, quote }
  if (state.questions[identity]) state.questions[identity].status = 'answered'
  return identity
}

export function recordFailure(state, code, progress, recovery) {
  if (!code || !recovery?.trim()) throw new Error('失败必须给诊断码与精确恢复动作')
  const key = `${state.stage}:${code}`, old = state.failures[key]
  const attempts = old?.progress === progress ? old.attempts + 1 : 1
  state.failures[key] = { code, progress, attempts, recovery, ids: { ...state.ids } }
  state.status = attempts >= conventions.interaction.maxNoProgressAttempts ? 'blocked' : 'in_progress'
  state.blockers = state.status === 'blocked' ? [code] : []
  state.next = recovery
  return state.failures[key]
}

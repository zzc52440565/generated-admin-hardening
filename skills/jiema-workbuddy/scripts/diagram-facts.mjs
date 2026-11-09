import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manualKinds } from './diagram-evidence.mjs'

const examplesRoot = dirname(fileURLToPath(new URL('../references/generated-admin-hardening/assets/quick-fill-examples/README.md', import.meta.url)))
export const exampleFiles = {
  'function-structure': '01-function-structure.txt', 'domain-class': '02-uml-class.txt',
  'system-sequence': '03-sequence-family.txt', 'system-flowchart': '04-system-flowchart-family.txt',
  'data-flow': '05-data-flow-family.txt', architecture: '06-architecture.txt', 'use-case': '07-use-case.txt',
}
const sha256 = text => createHash('sha256').update(text).digest('hex')
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel) }
const normalize = text => text.replace(/\s+/gu, '')

// 检查可追溯性与新鲜度，不证明模型对代码的解释正确，更不证明接口/页面实际运行。
export function assertDiagramFacts(path, { projectId, projectRoot, sourceSha256, basis, designSha256 } = {}) {
  const fail = message => { throw new Error(`图稿事实门禁：${message}`) }
  const nonempty = (v, label) => { if (typeof v !== 'string' || !v.trim()) fail(`缺 ${label}`) }
  const hash = (v, label) => { if (!/^[a-f0-9]{64}$/u.test(v ?? '')) fail(`无效 ${label}`) }
  const array = (v, label) => { if (!Array.isArray(v) || !v.length) fail(`缺 ${label}`); return v }
  const unique = (rows, label) => { if (new Set(rows.map(r => r.id)).size !== rows.length) fail(`${label} ID 重复`); rows.forEach(r => nonempty(r.id, `${label} ID`)) }
  const reportPath = realpathSync(path), base = dirname(reportPath)
  const r = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (r.schemaVersion !== 3 || !r.projectId || (projectId && r.projectId !== projectId)) fail('项目身份或 schemaVersion 不一致')
  if (!['design','source'].includes(r.basis) || (basis && r.basis !== basis)) fail('事实依据类型与执行计划不一致')
  const fromSource = r.basis === 'source'
  const root = realpathSync(fromSource ? r.projectRoot : r.evidenceRoot)
  let designBody
  if (fromSource) {
    if (projectRoot && root !== realpathSync(projectRoot)) fail('项目根目录不一致')
    if (inside(root, reportPath)) fail('冻结后的图稿事实与正文必须位于项目外')
    hash(r.sourceSha256, '冻结摘要')
    if (sourceSha256 && r.sourceSha256 !== sourceSha256) fail('冻结摘要与图稿回读不一致')
  } else {
    if (r.sourceSha256 || r.projectRoot) fail('设计依据不能伪造源码根目录或摘要')
    const snapshot = r.designSnapshot
    hash(snapshot?.sha256, '设计快照摘要'); nonempty(snapshot?.file, '设计快照路径')
    const snapshotPath = realpathSync(resolve(root, snapshot.file))
    if (isAbsolute(snapshot.file) || !inside(root,snapshotPath)) fail('设计快照路径越界')
    const bytes = readFileSync(snapshotPath), body = JSON.parse(bytes)
    if (sha256(bytes) !== snapshot.sha256 || (designSha256 && snapshot.sha256 !== designSha256)) fail('设计快照已变化或与回读不一致')
    if (body.projectId !== r.projectId || String(body.designRevision) !== String(r.designRevision) || !Array.isArray(body.design?.entities) || !Array.isArray(body.design?.relations)) fail('设计快照项目/版本/结构缺失')
    designBody = body
  }
  const sources = array(r.sources, '事实来源'); unique(sources, '事实来源')
  if (!fromSource && (!sources.some(s => s.kind === 'project-design' && s.path === r.designSnapshot.file && s.sha256 === r.designSnapshot.sha256)
    || !sources.some(s => ['requirement','sql'].includes(s.kind)))) fail('设计事实必须同时引用原始需求/SQL与真实项目设计快照')
  for (const s of sources) {
    nonempty(s.path, '事实相对路径'); nonempty(s.excerpt, '事实摘录'); hash(s.sha256, '事实哈希')
    if (fromSource) nonempty(s.symbol, '源码符号')
    else if (!['requirement','sql','decision','specification','project-design'].includes(s.kind)) fail('设计来源类型无效')
    if (isAbsolute(s.path)) fail('事实必须使用根目录相对路径')
    const actual = realpathSync(resolve(root, s.path))
    if (!inside(root, actual)) fail(`事实路径越界：${s.path}`)
    const bytes = readFileSync(actual), lines = bytes.toString('utf8').split(/\r?\n/u)
    if (sha256(bytes) !== s.sha256) fail(`${fromSource ? '源码' : '设计依据'}已变化：${s.path}；重做受影响图稿与验证`)
    if (!Number.isInteger(s.startLine) || !Number.isInteger(s.endLine) || s.startLine < 1 || s.endLine < s.startLine || s.endLine > lines.length || lines.slice(s.startLine - 1, s.endLine).join('\n') !== s.excerpt) fail(`源码摘录或行号不匹配：${s.path}`)
  }
  const sourceIds = new Set(sources.map(s => s.id))
  const refs = (ids, known, label) => { if (!Array.isArray(ids) || !ids.length || ids.some(id => !known.has(id))) fail(`${label} 引用缺失或未知`) }
  const facts = array(r.facts, '事实清单'); unique(facts, '事实')
  for (const f of facts) {
    nonempty(f.claim, '事实说明'); refs(f.sourceIds, sourceIds, `事实 ${f.id}`)
    if (!fromSource && !['provided','derived','proposed','confirmed'].includes(f.origin)) fail(`事实 ${f.id} 必须区分原始/推导/建议/确认`)
    if (!fromSource && f.origin === 'confirmed' && !f.sourceIds.some(id => sources.find(s => s.id === id)?.kind === 'decision')) fail('用户确认必须引用真实决定记录')
  }
  const factIds = new Set(facts.map(f => f.id))
  const diagrams = array(r.diagrams, '七类正文')
  if (diagrams.length !== manualKinds.length || new Set(diagrams.map(d => d.kind)).size !== manualKinds.length) fail('必须恰好七类正文')
  const mappedLines = new Map()
  for (const kind of manualKinds) {
    const d = diagrams.find(item => item.kind === kind)
    if (!d) fail(`缺 ${kind}`)
    nonempty(d.file, `${kind} 正文路径`); hash(d.sha256, `${kind} 正文哈希`)
    const file = realpathSync(resolve(base, d.file))
    if (!inside(base, file) || (fromSource && inside(root, file))) fail(`${kind} 正文必须位于项目外的本次交付目录`)
    const bytes = readFileSync(file), text = bytes.toString('utf8')
    if (sha256(bytes) !== d.sha256) fail(`${kind} 正文已变化`)
    if (normalize(text) === normalize(readFileSync(resolve(examplesRoot, exampleFiles[kind]), 'utf8'))) fail(`${kind} 直接照搬随包示例，必须根据目标业务事实重写`)
    const lines = text.split(/\r?\n/u), required = lines.flatMap((line, i) => line.trim() ? [i + 1] : [])
    const mappings = array(d.lines, `${kind} 逐行事实映射`)
    if (mappings.length !== required.length || new Set(mappings.map(m => m.line)).size !== required.length) fail(`${kind} 每个非空行必须恰有一条事实映射`)
    for (const m of mappings) {
      if (!required.includes(m.line)) fail(`${kind} 无效正文行号 ${m.line}`)
      refs(m.factIds, factIds, `${kind}:${m.line}`); nonempty(m.reason, `${kind}:${m.line} 推导依据`)
    }
    mappedLines.set(kind, new Set(required))
  }
  const scenarios = array(r.scenarios, '核心场景覆盖'); unique(scenarios, '场景')
  for (const s of scenarios) {
    nonempty(s.name, '场景名称'); refs(s.factIds, factIds, `场景 ${s.id}`)
    for (const kind of ['system-sequence', 'system-flowchart', 'data-flow']) {
      const coverage = s.coverage?.[kind]
      if (!coverage) fail(`场景 ${s.id} 缺 ${kind} 覆盖`)
      nonempty(coverage.reason, `场景 ${s.id}/${kind} 说明`)
      if (!Array.isArray(coverage.lines) || !coverage.lines.length || coverage.lines.some(line => !mappedLines.get(kind).has(line))) fail(`场景 ${s.id}/${kind} 必须指向实际正文行`)
    }
    // 没有事务/外部调用的只读场景可写“不适用”，必须有代码依据说明原因。
    for (const key of ['authorization', 'success', 'failure', 'concurrency', 'transaction']) {
      const review = s.review?.[key]
      nonempty(review?.reason, `场景 ${s.id}/${key} 自审`); refs(review?.factIds, factIds, `场景 ${s.id}/${key}`)
    }
  }
  if (r.authorization?.identityPolicy !== 'stable-id-only' || !Array.isArray(r.authorization.designDifferences)) fail('缺稳定身份策略或设计/实现差异清单')
  refs(r.authorization.factIds, factIds, '权限依据')
  for (const d of r.authorization.designDifferences) {
    nonempty(d.description, '设计差异'); nonempty(d.treatment, '差异处置'); refs(d.factIds, factIds, '设计差异')
  }
  if (r.er?.basis !== 'project-design' || String(r.er.designRevision) !== String(r.designRevision) || !/^[1-9][0-9]*$/u.test(String(r.designRevision))) fail('ER 必须对应当前 ProjectDesign 版本')
  refs(r.er.factIds, factIds, 'ER 源码结构对照'); nonempty(r.er.comparison, 'ER 与实际结构差异说明')
  // source 的在线设计回执也在项目外，不能为补证据改变冻结源码。
  if (fromSource) {
    const snapshot = r.er.projectReadback
    nonempty(snapshot?.file, 'ER project_show 回执路径'); hash(snapshot?.sha256, 'ER 回执摘要')
    const actual = realpathSync(resolve(base, snapshot.file))
    if (isAbsolute(snapshot.file) || !inside(base, actual) || inside(root, actual)) fail('ER 回执必须在项目外报告目录内')
    const bytes = readFileSync(actual)
    if (sha256(bytes) !== snapshot.sha256) fail('ER 回执已变化')
    designBody = JSON.parse(bytes)
  }
  if (designBody.projectId !== r.projectId || String(designBody.designRevision) !== String(r.designRevision)
    || !Array.isArray(designBody.design?.entities) || !Array.isArray(designBody.design?.relations)) fail('ER 回执项目/版本/结构缺失')
  const relations = designBody.design.relations, reviews = r.er.relations
  unique(relations, 'ER 在线关系')
  if (!Array.isArray(reviews) || reviews.length !== relations.length) fail('ER 每条在线关系必须逐项审查，不以数量或概括说明替代')
  unique(reviews, 'ER 关系审查')
  for (const relation of relations) {
    const review = reviews.find(row => row.id === relation.id)
    if (!review || review.name !== relation.name) fail(`ER 关系名称与真实回执不一致：${relation.id}`)
    if (!/^[\p{Script=Han}]{2,12}$/u.test(review.name) || ['关联', '关联关系', '对应', '对应关系', '关系'].includes(review.name)) fail(`ER 关系名称须为中文业务谓词，不能是技术键或占位词：${review.name}`)
    for (const key of ['sourceEntityId', 'targetEntityId', 'sourcePropertyId', 'cardinality']) {
      if (review[key] !== relation[key]) fail(`ER ${relation.id} 的 ${key} 与真实回执不一致`)
    }
    const sourceEntity = designBody.design.entities.find(e => e.id === relation.sourceEntityId)
    const targetEntity = designBody.design.entities.find(e => e.id === relation.targetEntityId)
    if (!sourceEntity || !targetEntity) fail(`ER ${relation.id} 端点不存在`)
    const expectedPairs = relation.physicalReference?.keyPairs ?? []
    const pairKey = pair => JSON.stringify([pair.sourcePropertyId, pair.targetPropertyId])
    if (!Array.isArray(review.keyPairs) || JSON.stringify(review.keyPairs.map(pairKey).sort()) !== JSON.stringify(expectedPairs.map(pairKey).sort())) fail(`ER ${relation.id} 必须核对完整外键组`)
    for (const pair of expectedPairs) {
      const field = sourceEntity.properties.find(p => p.id === pair.sourcePropertyId)
      if (!field || !targetEntity.properties.some(p => p.id === pair.targetPropertyId)) fail(`ER ${relation.id} 引用字段不存在`)
      const nullable = review.nullability?.find(row => row.sourcePropertyId === pair.sourcePropertyId)
      if (typeof field.required !== 'boolean' || nullable?.nullable !== !field.required) fail(`ER ${relation.id} 可空性未逐字段核对`)
    }
    if (!['source-to-target', 'target-to-source'].includes(review.readingDirection)) fail(`ER ${relation.id} 必须区分业务阅读方向与物理外键方向`)
    nonempty(review.meaning, `ER ${relation.id} 业务含义及状态条件`)
    refs(review.factIds, factIds, `ER ${relation.id} 业务依据`)
  }
  return { consistency: 'valid', status: 'unverified', basis: r.basis,
    ...(fromSource ? { projectRoot: root, sourceSha256: r.sourceSha256 } : { evidenceRoot: root, designSha256: r.designSnapshot.sha256 }),
    facts: facts.length, scenarios: scenarios.length }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(assertDiagramFacts(process.argv[2]), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 2 }
}

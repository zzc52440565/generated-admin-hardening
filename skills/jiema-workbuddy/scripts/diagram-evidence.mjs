import { realpathSync, readFileSync } from 'node:fs'
import { relative, isAbsolute, resolve } from 'node:path'

export const manualKinds = ['function-structure', 'data-flow', 'system-flowchart', 'architecture', 'system-sequence', 'domain-class', 'use-case']
// 只检验已记录的真实接口回执结构，不把本地检查成功升级成图稿 API 成功。
export function assertDiagramEvidence(path, { projectId, projectRoot, basis, designSha256, legacy = false } = {}) {
  const fail = message => { throw new Error(`图稿门禁：${message}`) }
  if (projectRoot) {
    const rel = relative(realpathSync(projectRoot), realpathSync(path))
    if (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)) fail('冻结后的图稿回执必须在项目外')
  }
  const report = JSON.parse(readFileSync(resolve(path), 'utf8'))
  const old = legacy && report.schemaVersion === 1
  if ((!old && report.schemaVersion !== 2) || !report.projectId || (projectId && report.projectId !== projectId)) fail('项目身份或 schemaVersion 不一致')
  const evidenceBasis = old ? 'source' : report.basis
  if (!['source','design'].includes(evidenceBasis) || (basis && evidenceBasis !== basis)) fail('图稿依据与执行计划不一致')
  const fromSource = evidenceBasis === 'source'
  const sha = report.sourceSha256
  if (fromSource && (!/^[a-f0-9]{64}$/.test(sha ?? '') || report.finalSnapshot?.sha256 !== sha || report.finalSnapshot?.method !== 'local_snapshot')) fail('缺最终源码摘要回读或摘要已变化')
  if (!fromSource) {
    if (sha || report.finalSnapshot) fail('设计图不得伪造源码绑定')
    if (!/^[a-f0-9]{64}$/.test(report.designSha256 ?? '') || (designSha256 && report.designSha256 !== designSha256)) fail('设计依据与冻结快照不一致')
    for (const phase of ['before','after']) {
      const read = report.projectReadback?.[phase]
      if (read?.method !== 'project_show' || read.projectId !== report.projectId || String(read.designRevision) !== String(report.designRevision) || read.designSha256 !== report.designSha256) fail('图稿保存前后项目设计已变化或缺回读')
    }
  }
  if (!Array.isArray(report.diagrams) || report.diagrams.length !== manualKinds.length || new Set(report.diagrams.map(d => d.kind)).size !== manualKinds.length) fail('必须逐一记录七类手工图')
  const validTime = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 60000
  for (const kind of manualKinds) {
    const d = report.diagrams.find(item => item.kind === kind)
    if (!d || d.status !== 'passed' || d.method !== 'diagram_status' || !Number.isInteger(d.revision) || d.revision < 1 || !validTime(d.readAt)) fail(`${kind} 尚未真实回读`)
    if (fromSource && (d.sourceMatch !== 'current' || d.localSourceSha256 !== sha)) fail(`${kind} 尚未真实回读为 current`)
    if (!fromSource && (d.sourceMatch || d.localSourceSha256)) fail(`${kind} 设计图不得伪造源码绑定`)
    if (d.availability && d.availability.available !== true) fail(`${kind} 投影不可用`)
    if (!old) {
      if (!d.commandBatchId || !/^[a-f0-9]{64}$/.test(d.textSha256 ?? '') || d.saveReceipt?.revision !== d.revision || !d.sourceFingerprint || d.saveReceipt.sourceFingerprint !== d.sourceFingerprint) fail(`${kind} 保存回执与回读版本/指纹不一致`)
      if (!validTime(d.savedAt) || Date.parse(d.savedAt) > Date.parse(d.readAt)) fail(`${kind} 保存/回读时间无效`)
    }
  }
  const useCase = report.diagrams.find(d => d.kind === 'use-case')
  const functionStructure = report.diagrams.find(d => d.kind === 'function-structure')
  if (!validTime(useCase.savedAt) || Date.parse(functionStructure.readAt) < Date.parse(useCase.savedAt)) fail('用例图保存后必须再次回读功能结构投影')
  const er = report.er
  if (er?.status !== 'passed' || er.method !== 'diagram_status' || String(er.fromDesignRevision) !== String(report.designRevision) || !/^[1-9][0-9]*$/.test(String(er.fromDesignRevision)) || !['entityCount', 'fieldCount', 'relationCount'].every(k => Number.isInteger(er[k]) && er[k] >= 0)) fail('缺派生 ER 的版本与结构回读')
  if (fromSource && (!validTime(report.finalSnapshot.readAt) || report.diagrams.some(d => Date.parse(d.readAt) > Date.parse(report.finalSnapshot.readAt)))) fail('最终摘要必须在图稿回读后核对')
  if (!fromSource) {
    const before = report.projectReadback.before, after = report.projectReadback.after
    if (!validTime(before.readAt) || !validTime(after.readAt) || report.diagrams.some(d => Date.parse(before.readAt) > Date.parse(d.savedAt) || Date.parse(d.readAt) > Date.parse(after.readAt))) fail('设计版本回读必须包围整套保存过程')
  }
  return { consistency: 'valid', status: 'unverified', basis: evidenceBasis, ...(fromSource ? { sourceSha256: sha } : { designSha256: report.designSha256 }) }
}

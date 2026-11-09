#!/usr/bin/env node
// 本地证据一致性检查，不联网、不执行 SQL，不认证记录者是否真的运行过。
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { conventions } from '../../../scripts/policy.mjs'

const types = ['table', 'column', 'key', 'constraint', 'index', 'view', 'procedure', 'function', 'trigger', 'query']
const advanced = ['view', 'procedure', 'function', 'trigger']
export const requiredCoverage = {
  boundary: ['limits', 'unique-conflict', 'long-text', 'null-and-zero', 'pagination'],
  conflict: ['overlap', 'concurrent-approval', 'duplicate-submit', 'occupied-cancel'],
  empty: ['new-user', 'role-empty', 'filter-empty'],
  isolation: ['cross-user'],
}
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const nonempty = v => typeof v === 'string' && v.trim().length > 0

export function assertDatabaseRedesign(projectRoot, { phase = 'data', binding } = {}) {
  const root = realpathSync(projectRoot)
  const require = (ok, message) => { if (!ok) throw new Error(`数据库门禁：${message}`) }
  const file = name => {
    require(nonempty(name) && !isAbsolute(name), '必须使用项目内相对证据路径')
    const p = realpathSync(resolve(root, name)), rel = relative(root, p)
    require(rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel), '证据越过项目根目录')
    require(statSync(p).isFile() && statSync(p).size > 0, `文件缺失或为空：${name}`)
    return p
  }
  const json = name => JSON.parse(readFileSync(file(name), 'utf8'))
  const rows = (value, label, allowEmpty = false) => {
    require(Array.isArray(value) && (allowEmpty || value.length > 0), `${label}必须为${allowEmpty ? '' : '非空'}数组`)
    return value
  }
  file('docs/db-redesign.md')
  const inventory = json('docs/sql-object-inventory.json'), seed = json('docs/seed-data-spec.json')
  const report = json('docs/db-verification.json'), sql = readFileSync(file('database.sql'), 'utf8')
  for (const doc of [inventory, seed, report]) require(doc.schemaVersion === 1, '规格版本无效')
  require(nonempty(seed.dataVersion) && nonempty(inventory.objectsVersion), '缺少数据/对象版本')
  const currentBinding = { dataVersion: seed.dataVersion, objectsVersion: inventory.objectsVersion, sqlSha256: digest(sql) }
  for (const [key, val] of Object.entries(currentBinding)) {
    require(report[key] === val, `数据库报告 ${key} 已失效`)
    if (binding) require(binding[key] === val, `下游验收 ${key} 已失效，重跑接口、页面与截图`)
  }
  require(seed.origin === 'business-redesign' && seed.scaffoldRowsRetained === 0, '必须全量重建，禁止脚手架数据残留')
  require(!/\bautoData\b/i.test(sql), '安装 SQL 含 autoData 占位数据')
  require(!sql.includes(`'${conventions.localDemo.password}'`), '安装 SQL 不得保存统一口令明文')
  require(!/\bDEFINER\s*=|\b(?:CREATE|DROP)\s+DATABASE\b|^\s*USE\s+[`\w]/im.test(sql), '安装脚本不能绑定旧库名、DEFINER 或重建数据库')
  for (const label of ['dialect', 'server-version', 'client', 'empty-database']) require(new RegExp(`^--\\s*${label}:\\s*\\S`, 'im').test(sql), `安装 SQL 文件头缺 ${label}`)
  const rebuiltAt = Date.parse(seed.rebuiltAt)
  require(Number.isFinite(rebuiltAt) && rebuiltAt <= Date.now() + 60000, '重建时间无效')
  const sourceDigests = seed.sourceDigests
  require(sourceDigests && Object.keys(sourceDigests).length, '缺业务代码与编码器源码摘要')
  require(JSON.stringify(Object.keys(sourceDigests).sort()) === JSON.stringify(Object.keys(report.sourceDigests ?? {}).sort()), '回读源码集合不一致')
  for (const [name, sha] of Object.entries(sourceDigests)) {
    require(report.sourceDigests[name] === sha && digest(readFileSync(file(name))) === sha, `源码证据已失效：${name}`)
  }
  const evidence = (name, methods) => {
    const e = json(name)
    require(e.status === 'passed', `证据未通过：${name}`)
    require(methods.includes(e.method), `证据类型不能证明该动作：${name}`)
    require(e.dataVersion === seed.dataVersion, `数据重建后旧证据失效：${name}`)
    const at = Date.parse(e.testedAt)
    require(Number.isFinite(at) && at >= rebuiltAt && at <= Date.now() + 60000, `证据时间无效：${name}`)
    require(nonempty(e.expected) && e.actual !== undefined && e.actual !== null, `缺预期/实际结果：${name}`)
    require(nonempty(e.command) || (e.request && nonempty(e.request.method) && nonempty(e.request.path)), `缺真实命令或请求：${name}`)
    require(e.fixture !== true || !['business-api', 'browser'].includes(e.method), 'fixture 不能充当业务动作证据')
    return e
  }
  const objects = rows(inventory.objects, 'objects'), identities = new Set()
  for (const o of objects) {
    require(nonempty(o.id) && !identities.has(o.id), '对象 ID 缺失/重复'); identities.add(o.id)
    require(types.includes(o.type) && ['retain', 'refactor', 'remove', 'add'].includes(o.decision), `对象类型/处置无效：${o.id}`)
    require([o.name, o.reason, o.source].every(nonempty), `对象缺业务依据：${o.id}`)
    if (advanced.includes(o.type) && o.decision !== 'remove') {
      require(nonempty(o.databaseReason), `高级对象缺数据库承担理由：${o.id}`)
      for (const k of ['writer', 'reader', 'doubleWrite', 'locking', 'deadlock', 'test', 'rollback']) require(nonempty(o.responsibility?.[k]), `${o.id} 缺责任划分 ${k}`)
    }
    if (o.type === 'query' && o.decision !== 'remove') {
      require(nonempty(o.sql) && nonempty(o.pageEntry), `查询缺 SQL/页面入口：${o.id}`)
      rows(o.indexes, `${o.id}.indexes`, true)
      require(o.indexes.length || nonempty(o.scanReason), `查询缺索引或扫描依据：${o.id}`)
      const q = rows(report.queryReadbacks, 'queryReadbacks').find(x => x.queryId === o.id)
      require(q && q.sqlSha256 === digest(o.sql), `查询回读与 SQL 不匹配：${o.id}`)
      const e = evidence(q.evidence, ['database-query'])
      require(e.explain !== undefined && e.resultSample !== undefined, `查询缺 EXPLAIN/结果：${o.id}`)
      const plan = rows(e.explain, `${o.id}.explain`)
      const actualKeys = [...new Set(plan.map(row => row.key).filter(k => k && k !== 'NULL'))].sort()
      rows(q.usedIndexes, `${o.id}.usedIndexes`, true)
      require(JSON.stringify([...new Set(q.usedIndexes)].sort()) === JSON.stringify(actualKeys), `实际 EXPLAIN key 与 usedIndexes 不一致：${o.id}`)
      require(q.usedIndexes.length || nonempty(o.scanReason), `EXPLAIN 未证明使用索引：${o.id}`)
      require(q.usedIndexes.every(k => o.indexes.includes(k)), `使用索引与设计不一致：${o.id}`)
    }
  }
  for (const t of types) require(objects.some(x => x.type === t) || (inventory.absentTypes ?? []).some(x => x.type === t && nonempty(x.reason)), `对象类别遗漏：${t}`)
  const accounts = rows(seed.accounts, 'accounts')
  require(new Set(accounts.map(a => `${a.role}:${a.username}`)).size === accounts.length, '账号重复')
  for (const a of accounts) {
    require(nonempty(a.role) && nonempty(a.username) && a.passwordPolicy === 'localDemo.password', '账号必须引用统一约定')
    require(sourceDigests[a.encoderSource], '未绑定应用真实编码器源码')
    const result = rows(report.accountReadbacks, 'accountReadbacks').find(x => x.role === a.role && x.username === a.username)
    require(result, `缺账号回读：${a.role}/${a.username}`)
    const hash = evidence(result.hashEvidence, ['application-password-encoder'])
    require(hash.matches === true && hash.encoderSource === a.encoderSource, '未由应用真实编码器验证哈希')
    const login = evidence(result.loginEvidence, ['business-api', 'browser'])
    require(login.role === a.role && login.username === a.username && login.passwordConvention === conventions.localDemo.password, '真实登录身份或统一口令不一致')
  }
  const identity = (entity, recordId) => nonempty(entity) && (nonempty(recordId) || Number.isSafeInteger(recordId))
    ? JSON.stringify([entity, String(recordId)]) : null
  const fixtureRecords = new Set()
  for (const f of rows(seed.fixtures, 'fixtures', true)) {
    require(f.fixture === true && nonempty(f.reason) && nonempty(f.scope) && f.countsAsActionEvidence === false, 'fixture 缺标注或被计入动作')
    const key = identity(f.entity, f.recordId)
    require(key, 'fixture 必须登记 entity/recordId，不能仅用说明隐藏受影响记录')
    fixtureRecords.add(key)
  }
  const samples = rows(seed.samples, 'samples'), usages = new Map()
  require(new Set(samples.map(s => s.id)).size === samples.length && samples.every(s => nonempty(s.id)), '样本 ID 缺失/重复')
  for (const category of ['state', 'boundary', 'conflict', 'empty', 'isolation']) require(samples.some(s => s.category === category), `缺样本覆盖：${category}`)
  for (const [category, cases] of Object.entries(requiredCoverage)) for (const name of cases) {
    const coverage = rows(seed.coverage, 'coverage').find(c => c.category === category && c.case === name)
    require(coverage, `缺具体覆盖：${category}/${name}`)
    if (coverage.status === 'not-applicable') require(nonempty(coverage.reason) && nonempty(coverage.source), `不适用缺业务依据：${name}`)
    else {
      require(coverage.status === 'tested', `具体覆盖未验证：${name}`)
      for (const id of rows(coverage.sampleIds, `${name}.sampleIds`)) require(samples.some(s => s.id === id && s.category === category && s.purpose === 'acceptance'), `具体覆盖未关联验收样本：${name}/${id}`)
      if (name === 'pagination') for (const id of coverage.sampleIds) {
        const sample = samples.find(s => s.id === id)
        require(sample.producer?.method === 'browser', '分页必须由实际页面切页验证')
        const p = evidence(sample.evidence, ['browser']).pagination
        require(p && objects.some(o => o.type === 'query' && o.decision !== 'remove' && o.id === p.queryId && o.pageEntry === p.pageEntry), '分页缺真实查询与页面入口关联')
        require(Number.isInteger(p.pageSize) && p.pageSize > 0 && Number.isInteger(p.total) && p.total > p.pageSize, '分页样本不足两页')
        const pages = rows(p.pages, '分页 pages')
        require(pages.length === 2 && pages[0].page === 1 && pages[1].page === 2, '分页必须记录第一页和第二页')
        const seen = new Set()
        for (const page of pages) {
          const ids = rows(page.recordIds, '分页 recordIds')
          require(ids.length === Math.min(p.pageSize, p.total - (page.page - 1) * p.pageSize), '分页行数与总数/页大小不一致')
          for (const recordId of ids) {
            require(nonempty(recordId) || Number.isSafeInteger(recordId), '分页缺记录身份')
            const key = String(recordId)
            require(!seen.has(key), '分页重复记录或两页实际为同一页'); seen.add(key)
          }
        }
      }
    }
  }
  for (const s of samples) {
    require(['demo', 'acceptance'].includes(s.purpose) && nonempty(s.producer?.action), `样本缺用途/生产者：${s.id}`)
    if (s.recordId !== undefined) {
      const key = `${s.entity}:${s.recordId}`
      require(!usages.has(key) || usages.get(key) === s.purpose, `演示与验收复用同一数据：${key}`)
      usages.set(key, s.purpose)
    }
    if (s.category === 'state' || s.purpose === 'acceptance') {
      if (s.category === 'state') require(identity(s.entity, s.recordId), `状态样本缺记录身份：${s.id}`)
      require(!fixtureRecords.has(identity(s.entity, s.recordId)), `fixture 记录不得计入状态或动作验收：${s.id}`)
      require(['business-api', 'browser'].includes(s.producer.method), `不能靠 SQL/fixture 制造动作或状态：${s.id}`)
      const e = evidence(s.evidence, [s.producer.method])
      require(e.fixture !== true, 'fixture 不得计入动作验收')
      require(!fixtureRecords.has(identity(s.entity ?? e.entity, e.recordId)), `fixture 回执不得计入状态或动作验收：${s.id}`)
      if (s.category === 'state') require(e.recordId === s.recordId && e.resultState === s.state, `状态生产回执不匹配：${s.id}`)
    } else evidence(s.evidence, ['business-api', 'browser', 'database-query', 'seed'])
  }
  for (const sm of rows(seed.stateMachines, 'stateMachines')) {
    require(nonempty(sm.entity) && nonempty(sm.source), '状态机缺源码依据')
    for (const state of rows(sm.states, `${sm.entity}.states`)) require(samples.some(s => s.category === 'state' && s.entity === sm.entity && s.state === state), `状态未覆盖：${sm.entity}/${state}`)
  }
  for (const t of objects.filter(o => o.type === 'table' && o.decision !== 'remove')) {
    const r = rows(report.tableReadbacks, 'tableReadbacks').find(x => x.table === t.name)
    require(r && Number.isInteger(r.count) && r.count >= 0, `表缺行数回读：${t.name}`)
    evidence(r.evidence, ['database-query'])
    const sm = seed.stateMachines.find(x => x.entity === t.name)
    if (sm) for (const state of sm.states) require(r.states?.[state] >= 1, `状态分布为空：${t.name}/${state}`)
  }
  for (const o of objects.filter(o => advanced.includes(o.type))) {
    const r = rows(report.objectReadbacks, 'objectReadbacks', true).find(x => x.objectId === o.id)
    require(r && r.exists === (o.decision !== 'remove'), `对象存在性不符：${o.id}`)
    evidence(r.evidence, ['database-query'])
    if (r.exists) evidence(r.invocationEvidence, ['database-query', 'business-api'])
  }
  for (const category of ['structure', 'objects', 'data', 'queries', 'passwords', 'empty-install']) {
    const c = rows(report.checks, 'checks').find(x => x.category === category)
    require(c, `缺数据库验证类别：${category}`)
    const e = evidence(c.evidence, ['database-query', 'database-import', 'application-password-encoder', 'business-api'])
    if (category === 'structure') {
      // 类别齐全不等于逐项复核：用数据库实际枚举的列闭合表与字段清单。
      const observed = new Set(), tables = new Set()
      for (const column of rows(e.columns, '结构回读 columns')) {
        require(nonempty(column.table) && nonempty(column.column), '结构回读缺表名/列名')
        const name = `${column.table}.${column.column}`
        require(!observed.has(name), `结构回读字段重复：${name}`)
        observed.add(name); tables.add(column.table)
      }
      for (const [type, names] of [['table', tables], ['column', observed]]) {
        const declared = new Set()
        for (const o of objects.filter(o => o.type === type && o.decision !== 'remove')) {
          require(!declared.has(o.name), `对象清单名称重复：${o.name}`)
          declared.add(o.name)
          require(names.has(o.name), `对象清单未在结构回读中出现：${o.name}`)
        }
        for (const name of names) require(declared.has(name), `结构对象未逐项登记：${name}`)
      }
    }
    if (category === 'empty-install') require(e.method === 'database-import' && e.emptyBefore === true && e.sqlSha256 === currentBinding.sqlSha256, '未证明空库导入唯一安装脚本')
  }
  const comparison = report.scaffoldComparison
  require(comparison?.retainedRows === 0 && nonempty(comparison.beforeDigest) && nonempty(comparison.afterDigest) && comparison.beforeDigest !== comparison.afterDigest, '缺脚手架残留对照')
  const comparisonEvidence = evidence(comparison.evidence, ['database-query'])
  require(comparisonEvidence.retainedRows === 0 && comparisonEvidence.beforeDigest === comparison.beforeDigest && comparisonEvidence.afterDigest === comparison.afterDigest, '脚手架对照回执不一致')
  if (phase === 'acceptance') {
    for (const name of ['docs/role-test-results.json', 'docs/page-redesign-audit.json', 'docs/runtime-review.json', 'docs/final-code-facts.json']) {
      const b = json(name).databaseBinding
      for (const [key, value] of Object.entries(currentBinding)) require(b?.[key] === value, `${name} 旧数据验收失效：${key}`)
    }
  }
  return { consistency: 'valid', status: 'unverified', databaseBinding: currentBinding, boundary: '只校验本地证据一致性；真实执行须另附数据库/API/原生任务回执' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1]
    if (!args.includes('--project-root')) throw new Error('需要 --project-root')
    console.log(JSON.stringify(assertDatabaseRedesign(value('--project-root'), { phase: args.includes('--phase') ? value('--phase') : 'data' }), null, 2))
  } catch (e) { console.error(JSON.stringify({ consistency: 'invalid', error: e.message })); process.exitCode = 1 }
}

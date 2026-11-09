import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

import { demoPassword as DEMO_PASSWORD } from './policy.mjs'

// 核对可机械验证的证据，不将记录者声明等同于真实登录或视觉质量。
export function assertRuntimeReview(projectRoot, audit, reportPath) {
  const root = realpathSync(projectRoot)
  const fail = message => { throw new Error(`H7 运行与视觉复审未通过：${message}`) }
  const file = name => {
    if (typeof name !== 'string' || !name || isAbsolute(name)) fail('证据须使用项目内相对路径')
    const path = realpathSync(resolve(root, name))
    const rel = relative(root, path)
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) fail('证据越过项目目录')
    if (!statSync(path).isFile() || !statSync(path).size) fail(`文件为空：${name}`)
    return path
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (report.schemaVersion !== 1 || report.targetRevision !== audit.targetRevision) fail('版本不一致')
  const digests = audit.sourceDigests ?? {}
  if (!Object.keys(digests).length || Object.keys(report.sourceDigests ?? {}).length !== Object.keys(digests).length) fail('源码清单不一致')
  let latestSource = 0
  for (const [name, digest] of Object.entries(digests)) {
    const path = file(name)
    if (report.sourceDigests?.[name] !== digest || createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) fail(`源码变化：${name}`)
    latestSource = Math.max(latestSource, statSync(path).mtimeMs)
  }
  const time = value => {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed) || parsed < latestSource - 1 || parsed > Date.now() + 60000) fail('证据时间早于源码或无效')
    return parsed
  }
  const evidence = (entry, method, convention = DEMO_PASSWORD) => {
    if (entry?.verified !== true || entry.passwordConvention !== convention) fail('演示口令不一致或未验证')
    const value = JSON.parse(readFileSync(file(entry.evidence), 'utf8'))
    if (value.status !== 'passed' || value.targetRevision !== report.targetRevision || value.method !== method || value.passwordConvention !== convention) fail('鉴权证据无效')
    if (!value.expected?.trim() || !value.actual?.trim()) fail('鉴权缺预期与实际结果')
    time(value.testedAt)
    return value
  }
  const db = report.database
  if (db?.scope !== 'local-demo') fail('须核对本地隔离数据库')
  if (db.engine === 'sqlite') {
    // SQLite 没有数据库登录口令；真实打开本地库，业务账号仍须统一约定。
    file(db.databaseFile)
    const dbEvidence = evidence(db, 'database-connection', 'not-applicable')
    if (dbEvidence.engine !== 'sqlite' || dbEvidence.databaseFile !== db.databaseFile) fail('SQLite 文件身份不一致')
  } else {
    if (!['127.0.0.1', 'localhost', '::1'].includes(db.host) || !Number.isInteger(db.port) || db.port < 1 || db.port > 65535) fail('须核对本地隔离数据库')
    const dbEvidence = evidence(db, 'database-connection')
    if (dbEvidence.host !== db.host || dbEvidence.port !== db.port) fail('数据库身份不一致')
  }
  const pages = audit.inventory?.pages ?? []
  const roles = new Set(pages.map(page => page.role))
  const loginRoles = report.loginRoles ?? []
  const publicRoles = report.publicRoles ?? []
  const classified = [...loginRoles, ...publicRoles]
  if (new Set(classified).size !== classified.length || roles.size !== classified.length || classified.some(role => !roles.has(role))) fail('登录与公开角色未完整分类')
  const accounts = report.accounts ?? []
  for (const role of loginRoles) if (!accounts.some(account => account.role === role)) fail(`角色未登录：${role}`)
  for (const account of accounts) {
    if (!loginRoles.includes(account.role) || !account.username?.trim()) fail('账号不属于登录角色')
    const value = evidence(account, 'browser')
    if (value.role !== account.role || value.username !== account.username) fail('登录身份不一致')
  }
  const reviews = report.pages ?? []
  if (new Set(reviews.map(item => item.pageId)).size !== pages.length || reviews.length !== pages.length) fail('视觉复审有漏页或重复页')
  const image = name => {
    const path = file(name), bytes = readFileSync(path)
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!(png || jpeg || webp)) fail(`截图不是受支持的图片：${name}`)
    return path
  }
  for (const page of pages) {
    const review = reviews.find(item => item.pageId === page.id)
    if (!review || review.status !== 'passed') fail(`页面未通过：${page.id}`)
    if (![review.changes, review.observations].every(items => Array.isArray(items) && items.length && items.every(item => typeof item === 'string' && item.trim().length >= 12))) fail(`缺具体改造／看图结论：${page.id}`)
    image(review.beforeScreenshot)
    const after = image(review.afterScreenshot)
    const reviewedAt = time(review.reviewedAt)
    if (statSync(after).mtimeMs < latestSource || reviewedAt < statSync(after).mtimeMs - 1000) fail(`截图或看图结论已过期：${page.id}`)
  }
  return { status: 'passed', pages: pages.length, accounts: accounts.length, boundary: '只校验证据一致性，不能证明实测发生或视觉质量' }
}

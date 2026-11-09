#!/usr/bin/env node
// 技能包静态自检：脚本语法、PowerShell 5.1 兼容性、跨平台字段同构、状态词表覆盖、
// 绝对路径与凭据泄漏、Markdown 链接与 frontmatter 必填字段。
//
// 用法：
//   node check-scripts.mjs          人类可读报告
//   node check-scripts.mjs --json   JSON 报告（供发布闸门使用）
//
// 用途说明：本机没有 PowerShell，Windows 脚本只能做静态验证；本脚本的通过不代表 Windows 上运行过。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..')
const scriptsDir = join(skillRoot, 'scripts')
const referencesDir = join(skillRoot, 'references')

const results = []
function record(group, name, status, detail) {
  results.push({ group, name, status, detail: detail ?? '' })
}
function pass(group, name, detail) { record(group, name, 'pass', detail) }
function fail(group, name, detail) { record(group, name, 'fail', detail) }
function warn(group, name, detail) { record(group, name, 'warn', detail) }

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', stdio: 'pipe', ...options })
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error?.message ?? null,
  }
}

// 状态词表：诊断脚本必须能表达每一类
const STATE_VOCABULARY = [
  'ok', 'missing', 'path-invisible', 'version-incompatible', 'service-stopped',
  'connect-failed', 'data-corrupt', 'unsupported-on-this-os', 'needs-elevation', 'needs-user-input',
]

// 两个平台诊断脚本必须输出的同构字段
const COMPONENT_FIELDS = [
  'type', 'component', 'state', 'version', 'major', 'requiredMajor', 'resolvedPath',
  'candidates', 'inPersistentPath', 'processOnlyPath', 'injected', 'faults', 'notes',
  'evidence', 'nextAction', 'forbidden',
]
const PLATFORM_FIELDS = [
  'type', 'schemaVersion', 'platform', 'os', 'arch', 'project',
  'persistentPath', 'persistentPathSources', 'processPath', 'processOnlyPath', 'injectedPath',
]

const BANNED_IN_SCRIPTS = [
  { pattern: /\|\s*(ba|z|)sh\b/, name: 'curl|bash 风格管道', skipIf: /curl|wget|Invoke-WebRequest/i },
  { pattern: /curl[^\n]*\|[^\n]*(ba)?sh/, name: 'curl | bash' },
  { pattern: /\biex\b|Invoke-Expression/i, name: 'Invoke-Expression（远程脚本执行）' },
  { pattern: /Set-ExecutionPolicy/i, name: 'Set-ExecutionPolicy' },
  { pattern: /\bsudo\b/, name: 'sudo 提权' },
  { pattern: /--?(yes|assume-yes)[^\n]*install/i, name: '无确认的批量安装' },
]

const scriptFiles = (await readdir(scriptsDir)).filter((name) => /\.(sh|ps1|mjs)$/.test(name)).sort()

// ---------- 1. 语法 ----------
for (const name of scriptFiles) {
  const full = join(scriptsDir, name)
  if (name.endsWith('.sh')) {
    const syntax = run('bash', ['-n', full])
    if (syntax.status === 0) pass('syntax', `${name}: bash -n`, '通过')
    else fail('syntax', `${name}: bash -n`, syntax.stderr.split('\n')[0])
  } else if (name.endsWith('.mjs')) {
    const syntax = run(process.execPath, ['--check', full])
    if (syntax.status === 0) pass('syntax', `${name}: node --check`, '通过')
    else fail('syntax', `${name}: node --check`, syntax.stderr.split('\n').slice(0, 2).join(' '))
  } else if (name.endsWith('.ps1')) {
    pass('syntax', `${name}: 静态检查`, '本机无 PowerShell，只做文本级校验（见下）')
  }
}

// ---------- 2. PowerShell 静态兼容性 ----------
function stripPsStringsAndComments(text) {
  // 粗粒度去字符串/注释，用于括号配平检查
  return text
    .replace(/<#[\s\S]*?#>/g, ' ')
    .replace(/(?<!\S)#[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"`]|`.|"")*"/g, '""')
}

for (const name of scriptFiles.filter((item) => item.endsWith('.ps1'))) {
  const full = join(scriptsDir, name)
  const raw = await readFile(full, 'utf8')
  const text = stripPsStringsAndComments(raw)

  for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
    const opens = (text.match(new RegExp(`\\${open}`, 'g')) ?? []).length
    const closes = (text.match(new RegExp(`\\${close}`, 'g')) ?? []).length
    if (opens === closes) pass('powershell', `${name}: ${open}${close} 配平`, `${opens} 对`)
    else fail('powershell', `${name}: ${open}${close} 配平`, `多 ${Math.abs(opens - closes)} 个（${opens} vs ${closes}）`)
  }
  const singleQuotes = (text.match(/'/g) ?? []).length
  const doubleQuotes = (text.match(/"/g) ?? []).length
  if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) pass('powershell', `${name}: 引号配平`, '通过（去字符串后统计）')
  else warn('powershell', `${name}: 引号配平`, `单引号 ${singleQuotes} / 双引号 ${doubleQuotes}，疑为奇数`)

  const ps51Bans = [
    { pattern: /\?\?/, name: '?? 空合并（PS7 才有）' },
    { pattern: /\?\./, name: '?. 空条件访问（PS7 才有）' },
    { pattern: /-Parallel\b/, name: '-Parallel（PS7 才有）' },
    { pattern: /\$IsWindows\b/, name: '$IsWindows（PS6+ 才有）' },
    { pattern: /ForEach-Object\s+-Parallel/, name: 'ForEach-Object -Parallel' },
    { pattern: /-AsHashtable\b/, name: '-AsHashtable（PS6+ 才有）' },
  ]
  for (const ban of ps51Bans) {
    if (ban.pattern.test(text)) fail('powershell', `${name}: 禁用语法`, ban.name)
    else pass('powershell', `${name}: 无 ${ban.name}`, '通过')
  }
  // 三元运算符：Ps 5.1 不支持
  const ternary = raw.split('\n').filter((line) => /\s\?\s.+\s:\s/.test(line) && !/^\s*#/.test(line))
  if (ternary.length === 0) pass('powershell', `${name}: 无三元运算符`, '通过')
  else fail('powershell', `${name}: 无三元运算符`, `命中 ${ternary.length} 行：${ternary[0].trim().slice(0, 60)}`)

  const requiredParams = ['Components', 'Project', 'JavaMajor', 'NodeMajor', 'Json', 'Human']
  for (const param of requiredParams) {
    if (new RegExp(`\\$${param}\\b`).test(raw)) pass('powershell', `${name}: 参数 -${param}`, '存在')
    else fail('powershell', `${name}: 参数 -${param}`, '缺失（与 diagnose-macos.sh 不同构）')
  }
}

// ---------- 3. 禁用模式与泄漏 ----------
const allowConventionIn = new Set(['provision-mysql-dev.mjs', 'plan.mjs'])
const PROHIBITION = /不要|禁止|不得|避免|不允许|forbidden|do not|don't|never/i
const SELF = 'check-scripts.mjs'
for (const name of scriptFiles) {
  if (name === SELF) continue
  const full = join(scriptsDir, name)
  const text = await readFile(full, 'utf8')
  for (const ban of BANNED_IN_SCRIPTS) {
    if (!ban.pattern.test(text)) continue
    const all = text.split('\n')
    const realHits = []
    for (let index = 0; index < all.length; index += 1) {
      const line = all[index]
      if (!ban.pattern.test(line)) continue
      if (/^\s*(#|\/\/)/.test(line)) continue
      if (PROHIBITION.test(line)) continue
      // 正则字面量行本身是“检测规则”，不是要执行的动作
      if (/^\s*\/.*\/i?,?\s*$/.test(line.trim())) continue
      // “禁用模式”声明区里的条目（forbidden / 禁止 列表）不是要执行的动作
      const context = all.slice(Math.max(0, index - 8), index).join('\n')
      if (/forbidden|禁止|不得|不允许/i.test(context)) continue
      realHits.push(line)
    }
    if (realHits.length === 0) continue
    fail('safety', `${name}: ${ban.name}`, realHits[0].trim().slice(0, 80))
  }
  const absolutePaths = text.split('\n')
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((item) => /\/(Users|home)\/[A-Za-z0-9._-]+\//.test(item.line) || /\/tmp\/[A-Za-z0-9._-]+/.test(item.line))
    .filter((item) => !/^\s*(#|\/\/)/.test(item.line))
    .filter((item) => !/reference|文档|示例/.test(item.line))
  if (absolutePaths.length === 0) pass('safety', `${name}: 无用户绝对路径`, '通过')
  else fail('safety', `${name}: 无用户绝对路径`, `第 ${absolutePaths[0].index} 行: ${absolutePaths[0].line.slice(0, 70)}`)

  const conventionLines = text.split('\n')
    .filter((line) => /123456/.test(line))
    .filter((line) => !/默认口令|口令约定|creden|convention|约定/i.test(line))
  if (conventionLines.length > 0 && !allowConventionIn.has(name)) {
    fail('safety', `${name}: 硬编码弱口令`, conventionLines[0].trim().slice(0, 80))
  }
}
pass('safety', '口令约定位置', '运行默认值统一读取主技能 conventions.json，检查器中的字面量仅用于检测')

// ---------- 4. 状态词表与字段同构 ----------
const shText = await readFile(join(scriptsDir, 'diagnose-macos.sh'), 'utf8')
const psText = await readFile(join(scriptsDir, 'diagnose-windows.ps1'), 'utf8')
for (const state of STATE_VOCABULARY) {
  const inSh = shText.includes(`'${state}'`)
  const inPs = psText.includes(`'${state}'`)
  if (inSh && inPs) pass('vocabulary', `状态 ${state}`, '两个平台都实现')
  else fail('vocabulary', `状态 ${state}`, `缺失于 ${[inSh ? '' : 'diagnose-macos.sh', inPs ? '' : 'diagnose-windows.ps1'].filter(Boolean).join(', ')}`)
}
for (const field of COMPONENT_FIELDS) {
  const inSh = new RegExp(`\\\\?"${field}\\\\?":`).test(shText)
  const inPs = new RegExp(`record\\.${field}|${field}\\s*=|\\.${field}\\b`).test(psText)
  if (inSh && inPs) pass('isomorphic', `字段 ${field}`, '两端都有')
  else fail('isomorphic', `字段 ${field}`, `缺失于 ${[inSh ? '' : 'diagnose-macos.sh', inPs ? '' : 'diagnose-windows.ps1'].filter(Boolean).join(', ')}`)
}
for (const field of PLATFORM_FIELDS) {
  const inSh = new RegExp(`\\\\?"${field}\\\\?"`).test(shText)
  const inPs = new RegExp(`${field}\\s*=`).test(psText)
  if (inSh && inPs) pass('isomorphic', `平台字段 ${field}`, '两端都有')
  else fail('isomorphic', `平台字段 ${field}`, `缺失于 ${[inSh ? '' : 'diagnose-macos.sh', inPs ? '' : 'diagnose-windows.ps1'].filter(Boolean).join(', ')}`)
}

// ---------- 5. 技能主文件 frontmatter 与 Markdown 链接 ----------
// 仓库里叫 SKILL.md；技能市场布局里嵌套技能正文改名 WORKFLOW.md，两种部署都要能跑。
const frontmatterRequired = ['name', 'description', 'display_name', 'display_name_en', 'description_zh', 'description_en', 'version', 'author']
const skillFile = ['SKILL.md', 'WORKFLOW.md']
  .map((name) => join(skillRoot, name))
  .find((file) => existsSync(file))
if (!skillFile) {
  fail('release', '技能主文件', '未找到 SKILL.md 或 WORKFLOW.md')
  process.exit(1)
}
const skillText = await readFile(skillFile, 'utf8')
const frontMatch = skillText.match(/^---\n([\s\S]*?)\n---/)
if (!frontMatch) fail('release', 'SKILL.md frontmatter', '缺少 --- 包裹的 frontmatter')
else {
  for (const field of frontmatterRequired) {
    if (new RegExp(`^${field}:\\s*\\S`, 'm').test(frontMatch[1])) pass('release', `frontmatter ${field}`, '存在')
    else fail('release', `frontmatter ${field}`, '缺失（发布包会打包失败）')
  }
}

const markdownFiles = [skillFile, join(skillRoot, 'SOURCE.md')]
try {
  for (const entry of await readdir(referencesDir)) {
    if (entry.endsWith('.md')) markdownFiles.push(join(referencesDir, entry))
  }
} catch {
  warn('release', 'references 目录', '不存在或为空')
}

let linkCount = 0
for (const file of markdownFiles) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    continue
  }
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^[a-z]+:\/\//i.test(target) || target.startsWith('mailto:')) continue
    linkCount += 1
    if (target.startsWith('/')) {
      fail('release', `${file.replace(skillRoot, '.')}: 相对链接`, `不能使用绝对路径：${target}`)
      continue
    }
    if (target.startsWith('..')) {
      // 跨技能引用：只允许指向同级技能目录，且打包后会重新解析为包内相对路径。
      const destination = resolve(dirname(file), target)
      const siblingRoot = dirname(skillRoot)
      const insideSibling = destination.startsWith(siblingRoot) && !destination.startsWith(`${skillRoot}/`)
      if (!insideSibling) {
        fail('release', `${file.replace(skillRoot, '.')}: 相对链接`, `跳出了技能目录树：${target}`)
        continue
      }
      const candidates = [destination, destination.replace(/WORKFLOW\.md$/, 'SKILL.md'), destination.replace(/SKILL\.md$/, 'WORKFLOW.md')]
      let found = false
      for (const candidate of candidates) {
        try {
          await access(candidate)
          found = true
          break
        } catch {
          // 继续尝试下一个改名候选
        }
      }
      if (found) pass('release', `${file.replace(skillRoot, '.')}: 跨技能链接 ${target}`, '存在（打包时重写为包内路径）')
      else fail('release', `${file.replace(skillRoot, '.')}: 跨技能链接 ${target}`, '目标文件不存在')
      continue
    }
    const destination = resolve(dirname(file), target)
    if (!destination.startsWith(skillRoot)) {
      fail('release', `${file.replace(skillRoot, '.')}: 相对链接`, `越过技能根目录：${target}`)
      continue
    }
    try {
      await access(destination)
      pass('release', `${file.replace(skillRoot, '.')}: 链接 ${target}`, '存在')
    } catch {
      fail('release', `${file.replace(skillRoot, '.')}: 链接 ${target}`, '目标文件不存在')
    }
  }
}
if (linkCount === 0) warn('release', 'Markdown 链接', '没有检测到相对链接')

// ---------- 6. 技能文件里不得出现仓库内路径 ----------
const REPO_PATH_RE = /(^|[\s`('"\[])((output|docs|workbuddy)\/[A-Za-z0-9._/-]+)/g
for (const file of markdownFiles) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    continue
  }
  const hits = []
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(REPO_PATH_RE)) hits.push(match[2])
  }
  if (hits.length === 0) pass('release', `${file.replace(skillRoot, '.')}: 无仓库内路径`, '通过')
  else fail('release', `${file.replace(skillRoot, '.')}: 无仓库内路径`, `发布包里不存在：${[...new Set(hits)].slice(0, 3).join(', ')}`)
}

// ---------- 汇总 ----------
const failed = results.filter((item) => item.status === 'fail')
const warned = results.filter((item) => item.status === 'warn')
const report = {
  schemaVersion: 1,
  kind: 'skill-static-check',
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  note: '本机没有 PowerShell：diagnose-windows.ps1 只做静态验证，不代表在 Windows 上运行过',
  scriptFiles,
  total: results.length,
  passed: results.filter((item) => item.status === 'pass').length,
  failed: failed.length,
  warned: warned.length,
  results,
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  let group = ''
  for (const item of results) {
    if (item.group !== group) {
      group = item.group
      process.stdout.write(`\n[${group}]\n`)
    }
    if (item.status === 'pass') continue
    process.stdout.write(`  ${item.status === 'fail' ? '✗' : '!'} ${item.name} — ${item.detail}\n`)
  }
  process.stdout.write(`\n共 ${report.total} 项：通过 ${report.passed}，失败 ${report.failed}，警告 ${report.warned}\n`)
  if (failed.length === 0) process.stdout.write('静态自检通过（注意：本机未实测 Windows）。\n')
}
process.exit(failed.length > 0 ? 1 : 0)

#!/usr/bin/env node
// 复验：在新的子进程（可重建持久化 PATH）里重新诊断，并执行真实构建 / 数据库鉴权连接等实证命令。
// 输出三类：passed（实测通过）/ failed（实测失败）/ needsHuman（历史字段名：待补证据，按 owner 续跑）。
//
// 用法：
//   node verify.mjs --project <项目目录> --components java,maven,mysql --build
//   node verify.mjs --project <项目目录> --components mysql --db-defaults-file <受保护的 my.cnf>
//
// 说明：--db-defaults-file 是 mysql 客户端读取的 0600 文件，口令不出现在命令行与日志里。

import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fail, nowIso, parseArgs, parseDiagnoseOutput, redactText, writeJsonFile } from './lib/common.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const args = parseArgs(process.argv.slice(2), {
  project: 'string',
  components: 'string',
  build: 'boolean',
  'build-command': 'string',
  buildCommand: 'string',
  'db-defaults-file': 'string',
  dbDefaultsFile: 'string',
  'db-port': 'string',
  dbPort: 'string',
  'db-name': 'string',
  dbName: 'string',
  'mvn-path': 'string',
  mvnPath: 'string',
  'extra-path': 'string',
  extraPath: 'string',
  noRebuildPath: 'boolean',
  out: 'string',
  json: 'boolean',
  help: 'boolean',
})
if (args.help) {
  process.stdout.write([
    '用法: node verify.mjs --project <项目目录> --components java,maven --build [选项]',
    '  --rebuild-path 默认开启：用 diagnose 报出的持久化 PATH 重建环境变量后再诊断，等价于新开终端',
    '  --no-rebuild-path        保留当前进程 PATH 诊断（仅用于对比）',
    '  --extra-path <dir1:dir2> 模拟“source 项目环境脚本后”的会话 PATH（Windows 用 ; 分隔）',
    '  --build                  执行真实构建（Maven: mvn -B -q -DskipTests package）',
    '  --build-command "<命令>"  自定义构建命令（按空格拆成 argv，不经 shell）',
    '  --db-defaults-file <文件> mysql 客户端鉴权用的 0600 选项文件（口令不进命令行）',
    '',
  ].join('\n'))
  process.exit(0)
}
if (!args.project) fail('缺少 --project <项目目录>', 2)
const projectDir = resolve(args.project)
try {
  await access(projectDir)
} catch {
  fail(`项目目录不存在: ${projectDir}`, 2)
}

const extraPath = String(args.extraPath || args['extra-path'] || '')
  .split(process.platform === 'win32' ? ';' : ':')
  .map((item) => item.trim())
  .filter(Boolean)
const platform = process.platform === 'darwin' ? 'macos' : (process.platform === 'win32' ? 'windows' : process.platform)
const diagnoseScript = platform === 'windows'
  ? join(here, 'diagnose-windows.ps1')
  : join(here, 'diagnose-macos.sh')

function runArgv(argv, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}), PATH: withExtraPath(options.env?.PATH ?? process.env.PATH ?? '') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }))
  })
}

const requested = String(args.components || '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

function withExtraPath(basePath) {
  if (!extraPath.length) return basePath
  const separator = platform === 'windows' ? ';' : ':'
  return [...extraPath, ...String(basePath ?? '').split(separator).filter(Boolean)].join(separator)
}

async function diagnose(extraEnv) {
  const argv = platform === 'windows'
    ? ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', diagnoseScript, '-Components', requested.join(','), '-Project', projectDir, '-Json']
    : ['bash', diagnoseScript, '--components', requested.join(','), '--project', projectDir, '--json']
  const envWithExtra = { ...extraEnv }
  envWithExtra.PATH = withExtraPath(envWithExtra.PATH ?? process.env.PATH ?? '')
  const result = await runArgv(argv, { env: envWithExtra })
  const records = parseDiagnoseOutput(result.stdout)
  return { result, records }
}

const passed = []
const failed = []
const needsHuman = []

// 第一步：在新进程里诊断（当前环境）
const first = await diagnose({})
if (first.records.length === 0) {
  failed.push({
    item: 'diagnose',
    command: `diagnose (${platform})`,
    detail: redactText(`诊断脚本没有输出可解析的记录；stderr: ${first.result.stderr.trim().split('\n').slice(-2).join(' ')}`),
  })
}
const platformRecord = first.records.find((record) => record?.type === 'platform') ?? null
const components = first.records.filter((record) => record?.type === 'component')

// 第二步：按持久化 PATH 重建环境再诊断（等价于用户新开终端）
let rebuilt = null
if (!args.noRebuildPath && platformRecord?.persistentPath?.length) {
  const rebuiltPath = [...platformRecord.persistentPath, ...(process.env.PATH ?? '').split(':').filter(Boolean)]
  rebuilt = await diagnose({ PATH: rebuiltPath.join(':') })
}

function statesFrom(records) {
  const map = new Map()
  for (const record of records) {
    if (record?.type === 'component') map.set(record.component, record)
  }
  return map
}

const currentStates = statesFrom(components)
const rebuiltStates = rebuilt ? statesFrom(rebuilt.records) : null

for (const component of requested) {
  const record = currentStates.get(component)
  if (!record) {
    needsHuman.push({ item: component, owner: 'agent', reason: '诊断结果里没有这个组件，无法复验', action: '由 Agent 补跑 diagnose 并核对项目依赖' })
    continue
  }
  const rebuiltRecord = rebuiltStates?.get(component) ?? null
  if (record.state !== 'ok') {
    failed.push({
      item: component,
      command: `diagnose ${component}`,
      detail: `新进程诊断状态 = ${record.state}；${(record.notes ?? []).join('; ')}`,
    })
    continue
  }
  if (rebuiltRecord && rebuiltRecord.state !== 'ok') {
    failed.push({
      item: component,
      command: `diagnose ${component}（持久化 PATH 环境）`,
      detail: `当前进程看起来 ok，但按持久化 PATH 重建后 = ${rebuiltRecord.state}；说明只在宿主注入环境里可用，用户新终端会失败`,
    })
    continue
  }
  passed.push({
    item: component,
    command: `diagnose ${component}`,
    detail: `${record.version ?? ''} ${record.resolvedPath ?? ''}`.trim() || 'ok',
  })
}

// 第三步：真实构建（只用项目里已有的包装器或已安装的工具，不联网安装任何东西）
const buildCommand = args.buildCommand || args['build-command'] || null
let effectiveBuild = buildCommand
if (!effectiveBuild && args.build) {
  const pom = join(projectDir, 'pom.xml')
  const wrapper = platform === 'windows' ? join(projectDir, 'mvnw.cmd') : join(projectDir, 'mvnw')
  const hasPom = await access(pom).then(() => true).catch(() => false)
  const hasWrapper = await access(wrapper).then(() => true).catch(() => false)
  if (hasPom) {
    if (hasWrapper) effectiveBuild = `${wrapper} -B -q -DskipTests package`
    else {
      const mvn = args.mvnPath || args['mvn-path'] || ''
      effectiveBuild = mvn ? `${mvn} -B -q -DskipTests package` : 'mvn -B -q -DskipTests package'
    }
  }
}

if (effectiveBuild) {
  const argv = effectiveBuild.split(/\s+/).filter(Boolean)
  const buildResult = await runArgv(argv, { cwd: projectDir })
  const headline = redactText((buildResult.stdout || buildResult.stderr).trim().split('\n').slice(-3).join(' | '))
  if (buildResult.code === 0) {
    passed.push({ item: 'build', command: effectiveBuild, detail: `退出码 0${headline ? `；${headline}` : ''}` })
  } else {
    failed.push({ item: 'build', command: effectiveBuild, detail: `退出码 ${buildResult.code}；${headline}` })
  }
} else if (args.build) {
  needsHuman.push({
    item: 'build',
    owner: 'agent',
    reason: '项目目录里没有识别到可用的构建入口（pom.xml + mvn/mvnw）',
    action: '按项目实际构建方式给出命令，再跑 node verify.mjs --build-command "<命令>"',
  })
}

// 第四步：数据库鉴权连接（口令只经 0600 选项文件，不进命令行）
const dbComponents = requested.filter((item) => ['mysql', 'postgresql', 'sqlserver'].includes(item))
const dbDefaults = args.dbDefaultsFile || args['db-defaults-file'] || null
for (const component of dbComponents) {
  const record = currentStates.get(component)
  if (!record || record.state !== 'ok') {
    needsHuman.push({ item: `${component}-auth`, reason: '服务未就绪，无法做鉴权连接', action: '先修服务状态' })
    continue
  }
  if (!dbDefaults) {
    needsHuman.push({
      item: `${component}-auth`,
      reason: '没有提供受保护的凭据文件，无法做真实鉴权连接',
      action: `准备一个 0600 的客户端选项文件（mysql 用 --defaults-extra-file），再执行：node verify.mjs --project ${projectDir} --components ${component} --db-defaults-file <文件>`,
    })
    continue
  }
  const port = args.dbPort || args['db-port'] || (component === 'mysql' ? '3306' : '5432')
  const dbName = args.dbName || args['db-name'] || ''
  const client = component === 'mysql' ? 'mysql' : 'psql'
  const argv = component === 'mysql'
    ? [client, `--defaults-extra-file=${resolve(dbDefaults)}`, '--protocol=TCP', '-h', '127.0.0.1', '-P', port, ...(dbName ? [dbName] : []), '-e', 'select 1 as ok;']
    : [client, `service=${resolve(dbDefaults)}`]
  const result = await runArgv(argv)
  if (result.code === 0) {
    const headline = redactText((result.stdout || result.stderr).trim().split('\n')[0] ?? '')
    passed.push({ item: `${component}-auth`, command: `${client} …(凭据走文件)`, detail: headline })
    for (const template of [
      '建表 + 插入中文 + 读回，核对 CHAR_LENGTH / LENGTH 比值',
      '用应用账号执行一次项目真实业务查询',
    ]) {
      needsHuman.push({ item: `${component}-business`, owner: 'agent', reason: template, action: '由 Agent 在已授权本机隔离库执行并记录真实回执；完成后补入最终 verify.json，不打断用户' })
    }
  } else {
    failed.push({
      item: `${component}-auth`,
      command: `${client} …(凭据走文件)`,
      detail: redactText((result.stderr || result.stdout).trim().split('\n')[0] ?? `退出码 ${result.code}`),
    })
  }
}

// 脚本未执行的业务/图形界面项由 Agent 继续；只有本人登录或权限授予才交用户。
for (const item of ['wxdevtools', 'tomcat']) {
  if (!requested.includes(item)) continue
  const record = currentStates.get(item)
  if (record?.state === 'ok') {
    needsHuman.push({
      item: `${item}-runtime`,
      reason: '进程/服务可用不等于业务可用',
      action: item === 'tomcat'
        ? '部署真实 WAR 后请求业务 URL，校验 HTTP 200 且页面内容正确'
        : '在微信开发者工具里导入项目并真实编译预览一次',
    })
  }
}

const report = {
  schemaVersion: 1,
  kind: 'env-verify',
  generatedAt: nowIso(),
  platform,
  project: projectDir,
  components: requested,
  passed,
  failed,
  needsHuman,
  evidence: {
    currentStates: Object.fromEntries([...currentStates].map(([name, record]) => [name, record.state])),
    rebuiltPathStates: rebuiltStates ? Object.fromEntries([...rebuiltStates].map(([name, record]) => [name, record.state])) : null,
    persistentPath: platformRecord?.persistentPath ?? null,
    injectedPath: platformRecord?.injectedPath ?? null,
  },
  conclusion: failed.length > 0
    ? '未通过：存在实测失败项，不能宣称环境就绪'
    : (needsHuman.length > 0 ? '实测项通过，但仍有尚待 Agent 补齐的业务/界面证据（不能算全部完成）' : '实测项全部通过'),
}

if (args.out) await writeJsonFile(resolve(args.out), report)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
process.exit(failed.length > 0 ? 1 : 0)

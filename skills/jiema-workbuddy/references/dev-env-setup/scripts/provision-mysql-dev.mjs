#!/usr/bin/env node
// 新建**本机开发** MySQL 实例（只允许回环地址），或报告为什么不能安全新建。
//
// 硬约束：
//   - 只允许 bind-address=127.0.0.1，独立 datadir 与独立端口，独立账号
//   - 本机开发实例默认口令读取 conventions.localDemo.password（产品约定）；执行前必须把这条约定原样展示给用户并记录在计划里
//   - 禁止用于远程/生产；禁止修改已有实例管理员口令；禁止覆盖已有 datadir
//   - 日志与报告不得输出真实口令（一律 <redacted>）
//   - 已有实例优先复用；无法安全复用时输出具体阻塞，而不是硬装第二个
//
// 用法：
//   node provision-mysql-dev.mjs --datadir <新目录> [--port 3307]           只打印计划（默认，不执行）
//   node provision-mysql-dev.mjs --datadir <新目录> --apply --confirm <digest>   真正执行
//
// 口令来源：默认取产品约定的本机开发口令；如需覆盖，用环境变量 JIEMA_DEV_DB_PASSWORD 或 --password-stdin。
// 口令永远不出现在命令行参数里。

import { demoPassword } from '../../../scripts/policy.mjs'
import { spawn } from 'node:child_process'
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { digestOf, envHome, fail, nowIso, parseArgs, redactText } from './lib/common.mjs'

const CONVENTION_TEXT = `本机开发 MySQL 新建实例默认口令 ${demoPassword}`
const CONVENTION_CONSTRAINTS = [
  '只允许 bind-address=127.0.0.1（不对局域网暴露）',
  '只用于本机开发，禁止用于远程或生产环境',
  '不得修改已有实例的管理员口令',
  '不得覆盖已有 datadir',
  '日志与报告不得出现真实口令',
]

const args = parseArgs(process.argv.slice(2), {
  datadir: 'string',
  port: 'string',
  prefix: 'string',
  mysqld: 'string',
  client: 'string',
  user: 'string',
  database: 'string',
  apply: 'boolean',
  confirm: 'string',
  'password-stdin': 'boolean',
  passwordStdin: 'boolean',
  'create-second-instance': 'boolean',
  createSecondInstance: 'boolean',
  json: 'boolean',
  help: 'boolean',
})

if (args.help) {
  process.stdout.write([
    '用法: node provision-mysql-dev.mjs --datadir <新目录> [--port 3307] [--prefix <前缀>]',
    '     加 --apply --confirm <planDigest> 才会真正执行；默认只打印计划与口令约定。',
    '   --mysqld <可执行文件>   指定 mysqld 路径（默认在 PATH 与常见目录里找）',
    '   --user <名>             应用账号，默认 app_dev',
    '   --database <名>         应用库名，默认 app_dev',
    '   --password-stdin        从 stdin 读口令（默认用产品约定的本机开发口令）',
    '',
    `约定原文：${CONVENTION_TEXT}`,
    '',
  ].join('\n'))
  process.exit(0)
}

const port = Number(args.port || 3307)
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('--port 必须是 1024-65535 的整数', 2)
const appUser = String(args.user || 'app_dev')
const appDatabase = String(args.database || 'app_dev')
if (!/^[A-Za-z0-9_]{3,32}$/.test(appUser)) fail('账号名只允许字母数字下划线（3-32 位）', 2)
if (!/^[A-Za-z0-9_]{1,64}$/.test(appDatabase)) fail('库名只允许字母数字下划线', 2)

const prefix = resolve(args.prefix || join(envHome(), `mysql-dev-${port}`))
const datadir = resolve(args.datadir || join(prefix, 'data'))
const cnfFile = join(prefix, 'my.cnf')
const socketFile = join(prefix, 'mysql.sock')
const pidFile = join(prefix, 'mysqld.pid')
const errorLog = join(prefix, 'error.log')
const credentialsFile = join(prefix, 'credentials.env')

const blockers = []
const notes = []
const steps = []

function addBlocker(code, detail, options = []) {
  blockers.push({ code, detail, options })
}

// ---------- 环境事实（只读） ----------
const isWindows = process.platform === 'win32'
if (process.getuid && process.getuid() === 0) {
  addBlocker('running-as-root', '当前进程以 root 运行；本脚本不代管理员安装/启动系统服务，请用普通用户运行', ['用普通用户重新执行'])
}

function whichSync(command) {
  const pathEnv = process.env.PATH ?? ''
  const separator = isWindows ? ';' : ':'
  const extensions = isWindows ? ['.exe', '.cmd', ''] : ['']
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const mysqldCandidates = [
  args.mysqld,
  whichSync(isWindows ? 'mysqld' : 'mysqld'),
  join(prefix, 'bin', isWindows ? 'mysqld.exe' : 'mysqld'),
  '/opt/homebrew/opt/mysql/bin/mysqld',
  '/usr/local/opt/mysql/bin/mysqld',
  '/usr/local/mysql/bin/mysqld',
  '/usr/sbin/mysqld',
].filter(Boolean)

let mysqldPath = null
for (const candidate of mysqldCandidates) {
  try {
    const info = await stat(candidate)
    if (info.isFile()) { mysqldPath = candidate; break }
  } catch {
    // 继续找
  }
}

const clientCandidates = [
  args.client,
  whichSync(isWindows ? 'mysql' : 'mysql'),
  mysqldPath ? join(dirname(mysqldPath), isWindows ? 'mysql.exe' : 'mysql') : null,
  '/opt/homebrew/opt/mysql/bin/mysql',
  '/usr/local/mysql/bin/mysql',
].filter(Boolean)

let clientPath = null
for (const candidate of clientCandidates) {
  try {
    const info = await stat(candidate)
    if (info.isFile()) { clientPath = candidate; break }
  } catch {
    // 继续找
  }
}

// 端口拒绝连接才表示空闲；权限错误和超时必须保留为未知，不能据此创建实例。
function probePort(candidatePort) {
  return new Promise((resolvePromise) => {
    let socket
    const finish = (state, error = null) => {
      socket?.destroy()
      resolvePromise({ state, error })
    }
    try {
      socket = createConnection({ host: '127.0.0.1', port: candidatePort })
      socket.once('connect', () => finish('listening'))
      socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'available' : 'unverified', error.code))
      socket.setTimeout(1000, () => finish('unverified', 'ETIMEDOUT'))
    } catch (error) {
      finish('unverified', error.code ?? 'TCP_PROBE_FAILED')
    }
  })
}

// 从正在监听的进程里读出它的命令行：用于"已有实例优先复用"的判断与提示
async function describeRunningInstance(candidatePort) {
  if (isWindows) return null
  const listener = await runArgv(['lsof', '-nP', `-iTCP:${candidatePort}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 })
  if (listener.code !== 0) return { inspectionStatus: 'unverified', inspectionError: listener.errorCode ?? `lsof-exit-${listener.code}` }
  const pids = listener.stdout.trim().split('\n').filter(pid => /^\d+$/.test(pid))
  for (const pid of pids) {
    const result = await runArgv(['ps', '-o', 'command=', '-p', pid], { timeout: 5000 })
    if (result.code !== 0) return { pid, inspectionStatus: 'unverified', inspectionError: result.errorCode ?? `ps-exit-${result.code}` }
    const command = result.stdout.trim()
    if (!command.includes('mysqld')) continue
    const basedir = (command.match(/--basedir=(\S+)/) ?? [])[1] ?? null
    const runningDatadir = (command.match(/--datadir=(\S+)/) ?? [])[1] ?? null
    const bind = (command.match(/--bind-address=(\S+)/) ?? [])[1] ?? null
    return { port: candidatePort, pid, basedir, datadir: runningDatadir, bindAddress: bind, command: redactText(command), inspectionStatus: 'verified' }
  }
  return null
}

const existingInstances = []
for (const candidatePort of new Set([3306, port])) {
  const probe = await probePort(candidatePort)
  if (probe.state === 'unverified') {
    addBlocker('port-probe-unavailable', `无法确认 127.0.0.1:${candidatePort} 的监听状态（${probe.error}），不能把未知当空闲`, [
      '保留当前计划与目录；恢复宿主回环网络访问后，原参数重新预检，勿停其他实例',
    ])
  } else if (candidatePort === port && probe.state === 'listening') {
    existingInstances.push({ port: candidatePort, note: '目标端口已被占用' })
  } else if (probe.state === 'listening') {
    const detail = await describeRunningInstance(candidatePort)
    existingInstances.push(detail
      ? { port: candidatePort, note: detail.inspectionStatus === 'verified' ? '本机已有 MySQL 实例在监听' : '本机已有监听，进程信息不可读；未判定可复用', ...detail }
      : { port: candidatePort, note: '本机已有实例在监听（未能读取进程信息）' })
  }
}

// 已有实例优先复用：没有显式要求，就不新建第二个实例
if (existingInstances.length > 0 && !(args.createSecondInstance || args['create-second-instance'])) {
  const first = existingInstances[0]
  addBlocker(
    'existing-instance-detected',
    `本机已有实例在 127.0.0.1:${first.port} 运行${first.datadir ? `（datadir ${first.datadir}）` : ''}：按“已有实例优先复用”原则不新建第二个实例`,
    [
      '复用该实例：把项目的连接串指向它，再用应用账号做一次真实鉴权连接',
      '确实需要独立实例时，显式加 --create-second-instance，并确认端口与 datadir 都不冲突',
    ],
  )
}

if (existingInstances.some((item) => item.port === port)) {
  addBlocker('port-in-use', `127.0.0.1:${port} 已有进程在监听；本脚本不会去抢端口或停别人的实例`, [
    `换一个空闲 --port（例如 3307/3308）`,
    '或复用已在运行的实例，不要另建',
  ])
}

// datadir 安全判定：存在即拒绝，绝不覆盖
try {
  const info = await stat(datadir)
  if (info.isDirectory()) {
    const list = await readdir(datadir)
    if (list.length > 0) {
      const hasMysqlSystem = list.includes('mysql') || list.includes('ibdata1') || list.includes('undo_001')
      addBlocker(
        'datadir-not-empty',
        `目标 datadir 已存在且非空（${list.length} 个条目${hasMysqlSystem ? '，且看起来是已有 MySQL 数据目录' : ''}）：${datadir}`,
        ['换一个新的空目录作为 datadir', '如果这是已有实例，请复用而不是覆盖'],
      )
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') addBlocker('datadir-stat-failed', `无法检查 datadir：${error.message}`)
}

// 已有实例的 basedir 也可以直接拿来用（复用同一套二进制，但不碰它的数据目录）
if (!mysqldPath) {
  const basedir = existingInstances.find((item) => item.basedir)?.basedir
  if (basedir) {
    const candidate = join(basedir, 'bin', isWindows ? 'mysqld.exe' : 'mysqld')
    try {
      const info = await stat(candidate)
      if (info.isFile()) {
        mysqldPath = candidate
        notes.push(`复用已有实例安装目录里的 mysqld：${candidate}（只借用二进制，不碰它已有的 datadir）`)
      }
    } catch {
      // 忽略
    }
  }
}

if (!mysqldPath) {
  addBlocker(
    'mysqld-not-found',
    '本机没有找到 mysqld 服务端二进制：无法自动创建实例（客户端存在也不等于服务端存在）',
    [
      '从 MySQL 官方下载对应平台的压缩包，解压到独立前缀后把 --mysqld 指过去',
      '或复用已有实例：确认连接串、账号与端口后直接验证，不新建',
      'Windows 可用官方 ZIP + 独立目录，但注册系统服务需要管理员权限，须单独授权',
    ],
  )
}
if (!clientPath) {
  notes.push('没有找到 mysql 客户端：实例创建后仍需客户端才能做鉴权复验，建议与服务端同目录使用')
}

// ---------- 计划 ----------
const passwordSource = args.passwordStdin || args['password-stdin']
  ? 'stdin'
  : (process.env.JIEMA_DEV_DB_PASSWORD ? 'env:JIEMA_DEV_DB_PASSWORD' : 'product-convention')

const plan = {
  schemaVersion: 1,
  kind: 'mysql-dev-provision-plan',
  generatedAt: nowIso(),
  platform: process.platform,
  bindAddress: '127.0.0.1',
  port,
  datadir,
  prefix,
  cnfFile,
  socketFile,
  pidFile,
  errorLog,
  appUser,
  appDatabase,
  mysqldPath,
  clientPath,
  credentialConvention: {
    text: CONVENTION_TEXT,
    constraints: CONVENTION_CONSTRAINTS,
    disclosedBeforeApply: true,
    passwordSource,
    passwordInArgv: false,
    redactedInLogs: true,
  },
  reusePolicy: {
    existingInstances,
    preferReuse: true,
    allowCreatingSecondInstance: existingInstances.length === 0 || Boolean(args.createSecondInstance || args['create-second-instance']),
  },
  steps: [
    '确认目标 datadir 是全新空目录（已存在则拒绝）',
    `写 ${cnfFile}：bind-address=127.0.0.1、port=${port}、独立 datadir/socket/pid/log，关闭 mysqlx 与远程监听`,
    `初始化数据目录：mysqld --defaults-file=${cnfFile} --initialize-insecure（root 初始为空口令，仅存在于本机回环新实例）`,
    `前台守护启动：mysqld --defaults-file=${cnfFile} --daemonize，只监听 127.0.0.1:${port}`,
    '用 0600 选项文件（而不是命令行参数）设置 root 口令并创建独立应用账号与库',
    '把账号口令写入 0600 的 credentials.env，报告里只出现 <redacted> 与该文件路径',
    '鉴权复验：select 1、select @@bind_address、select @@port，并确认真实监听地址为 127.0.0.1',
  ],
  forbidden: [
    '不使用 --initialize 覆盖任何已有 datadir',
    '不修改已有实例的管理员口令',
    '不把口令放进命令行参数、日志或报告',
    '不监听 0.0.0.0，不做任何远程/生产用途',
    '不注册系统级服务、不 sudo',
  ],
  blockers,
  notes,
  applied: false,
}
// 时间戳是展示元数据，不属于计划身份；否则 plan 与 apply 两次运行必定得到不同摘要。
const planIdentity = { ...plan }
delete planIdentity.generatedAt
const digest = digestOf(planIdentity)
plan.digest = digest

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
process.stdout.write(`\n${CONVENTION_TEXT}\n`)
for (const constraint of CONVENTION_CONSTRAINTS) process.stdout.write(`  - ${constraint}\n`)
process.stdout.write('\n')

if (blockers.length > 0) {
  process.stdout.write('无法安全新建实例，阻塞项：\n')
  for (const blocker of blockers) {
    process.stdout.write(`- [${blocker.code}] ${blocker.detail}\n`)
    for (const option of blocker.options) process.stdout.write(`    → ${option}\n`)
  }
  process.stdout.write(`\nplanDigest: ${digest}\n`)
  process.exit(3)
}

if (!args.apply) {
  process.stdout.write('以上是计划与口令约定，尚未执行任何改动。\n')
  process.stdout.write(`确认无误后执行：node provision-mysql-dev.mjs --datadir ${datadir} --port ${port} --apply --confirm ${digest}\n`)
  process.exit(0)
}

if (!args.confirm) fail(`缺少 --confirm <planDigest>；请先把计划与口令约定给用户确认。当前 planDigest: ${digest}`, 2)
if (String(args.confirm).trim() !== digest) {
  fail(`--confirm 与当前计划摘要不一致（计划可能已变），拒绝执行。\n期望: ${digest}\n收到: ${String(args.confirm).trim()}`, 3)
}

// ---------- 执行 ----------
let password = process.env.JIEMA_DEV_DB_PASSWORD || demoPassword
if (passwordSource === 'stdin') {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  password = Buffer.concat(chunks).toString('utf8').trim()
  if (!password) fail('stdin 没有提供口令', 2)
}

function log(line) {
  process.stdout.write(`${redactText(String(line).replaceAll(password, '<redacted>'))}\n`)
}

async function runArgv(argv, options = {}) {
  return new Promise((resolvePromise) => {
    const { input, ...spawnOptions } = options
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: process.env, ...spawnOptions,
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error.message, errorCode: error.code })
      return
    }
    let stdout = ''
    let stderr = ''
    if (input !== undefined) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${error.message}`, errorCode: error.code }))
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }))
  })
}

let started = false
try {
  await mkdir(datadir, { recursive: true, mode: 0o700 })
  await mkdir(prefix, { recursive: true })
  const cnf = [
    '[mysqld]',
    'bind-address=127.0.0.1',
    'mysqlx=OFF',
    'skip-name-resolve',
    `port=${port}`,
    `datadir=${datadir}`,
    `socket=${socketFile}`,
    `pid-file=${pidFile}`,
    `log-error=${errorLog}`,
    'character-set-server=utf8mb4',
    'collation-server=utf8mb4_general_ci',
    '',
    '[client]',
    `port=${port}`,
    `socket=${socketFile}`,
    '',
  ].join('\n')
  await writeFile(cnfFile, cnf, { mode: 0o600 })
  await chmod(cnfFile, 0o600)
  log(`[1/6] 已写配置 ${cnfFile}（bind-address=127.0.0.1, port=${port}）`)

  const init = await runArgv([mysqldPath, `--defaults-file=${cnfFile}`, '--initialize-insecure'])
  if (init.code !== 0) throw new Error(`初始化失败（退出码 ${init.code}）：${(init.stderr || init.stdout).trim().split('\n').slice(-2).join(' ')}`)
  log('[2/6] 数据目录初始化完成（新实例，未触碰任何已有 datadir）')

  const startArgv = [mysqldPath, `--defaults-file=${cnfFile}`]
  if (process.platform !== 'win32') startArgv.push('--daemonize')
  const start = await runArgv(startArgv)
  if (start.code !== 0 && !isWindows) throw new Error(`启动失败（退出码 ${start.code}）：${(start.stderr || start.stdout).trim().split('\n').slice(-2).join(' ')}`)
  started = true
  log('[3/6] 实例已启动，等待端口就绪…')

  let ready = false
  for (let i = 0; i < 40; i += 1) {
    if ((await probePort(port)).state === 'listening') { ready = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!ready) throw new Error('实例启动后端口仍不可连，见 error.log')
  log(`[4/6] 127.0.0.1:${port} 已就绪`)

  const adminFile = join(prefix, '.admin.cnf')
  // 初始化只创建 root@localhost；skip-name-resolve 下 TCP 127.0.0.1 不能冒充该账号。
  const adminConnection = isWindows
    ? `[client]\nuser=root\nhost=localhost\nport=${port}\nprotocol=TCP\n`
    : `[client]\nuser=root\nsocket=${socketFile}\nprotocol=SOCKET\n`
  await writeFile(adminFile, adminConnection, { mode: 0o600 })
  await chmod(adminFile, 0o600)

  const sqlBootstrap = [
    "SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';",
    `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password.replace(/'/g, "''")}';`,
    `CREATE DATABASE IF NOT EXISTS \`${appDatabase}\` CHARACTER SET utf8mb4;`,
    `CREATE USER IF NOT EXISTS '${appUser}'@'127.0.0.1' IDENTIFIED BY '${password.replace(/'/g, "''")}';`,
    `GRANT ALL PRIVILEGES ON \`${appDatabase}\`.* TO '${appUser}'@'127.0.0.1';`,
    'FLUSH PRIVILEGES;',
  ].join('\n')
  // 口令只走 stdin，不放到 argv 的 -e 参数或进程列表里。
  const bootstrap = await runArgv([clientPath, `--defaults-extra-file=${adminFile}`], { input: sqlBootstrap })
  await rm(adminFile, { force: true })
  if (bootstrap.code !== 0) throw new Error(`创建账号/库失败：${(bootstrap.stderr || bootstrap.stdout).trim().split('\n').slice(-2).join(' ')}`)
  log(`[5/6] 已设置 root 口令（<redacted>）并创建账号 ${appUser}@127.0.0.1 与库 ${appDatabase}`)

  const appFile = join(prefix, '.verify.cnf')
  await writeFile(appFile, `[client]\nuser=${appUser}\npassword=${password}\nhost=127.0.0.1\nport=${port}\nprotocol=TCP\n`, { mode: 0o600 })
  await chmod(appFile, 0o600)
  const verify = await runArgv([clientPath, `--defaults-extra-file=${appFile}`, '-N', '-e', 'select @@bind_address, @@port, current_user();'])
  await rm(appFile, { force: true })
  if (verify.code !== 0) throw new Error(`鉴权复验失败：${(verify.stderr || verify.stdout).trim().split('\n').slice(-2).join(' ')}`)
  const line = redactText(verify.stdout.trim())
  log(`[6/6] 鉴权复验通过：${line}`)
  if (!/127\.0\.0\.1/.test(line)) throw new Error('运行期 bind_address 不是 127.0.0.1，拒绝交付')

  await writeFile(
    credentialsFile,
    `# ${CONVENTION_TEXT}\n# 仅本机开发，禁止用于远程或生产\nMYSQL_HOST=127.0.0.1\nMYSQL_PORT=${port}\nMYSQL_DATABASE=${appDatabase}\nMYSQL_USER=${appUser}\nMYSQL_PASSWORD=${password}\n`,
    { mode: 0o600 },
  )
  await chmod(credentialsFile, 0o600)
  log(`凭据已写入 0600 文件：${credentialsFile}（口令显示为 <redacted>）`)
  log('完成。停止实例：按 pid 文件或 mysqld 的 shutdown 方式，不要删除 datadir。')
  process.exit(0)
} catch (error) {
  log(`[error] ${redactText(error.message ?? String(error))}`)
  log(`恢复步骤：停止该实例（pid 文件 ${pidFile}），确认后删除 ${prefix}；不要动任何已有 datadir。`)
  if (started) {
    log('已启动过实例：请先用 mysqladmin shutdown 或 kill 停掉，再清理目录。')
  }
  process.exit(1)
}

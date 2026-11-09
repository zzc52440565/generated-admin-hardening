#!/usr/bin/env node
// 执行计划中的**单个**动作：--plan <file> --action <id> --confirm <planDigest>
//
// 设计约束：
//   - 一次只执行一个 action，绝不提供「批量全部执行」参数
//   - 执行前写备份与检查点（可续跑），执行后自动复验该项
//   - 失败回滚该项并打印恢复步骤；日志脱敏（口令一律 <redacted>）
//   - 只接受计划白名单里的动作种类，不做任意命令拼接

import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  checkpointPath, digestOf, envHome, exists, fail, fileDigest, logPath, nowIso, parseArgs,
  readJsonFile, redactText, writeJsonFile,
} from './lib/common.mjs'

const args = parseArgs(process.argv.slice(2), {
  plan: 'string',
  action: 'string',
  confirm: 'string',
  'offline-archive': 'string',
  offlineArchive: 'string',
  list: 'boolean',
  status: 'boolean',
  'keep-partial': 'boolean',
  help: 'boolean',
  // 以下参数会被显式拒绝，用于把「批量执行」挡在入口
  all: 'boolean',
  actions: 'string',
  batch: 'boolean',
})

if (args.help) {
  process.stdout.write([
    '用法: node apply.mjs --plan <plan.json> --action <actionId> --confirm <planDigest>',
    '     node apply.mjs --plan <plan.json> --list          列出动作与 planDigest',
    '     node apply.mjs --plan <plan.json> --action <id> --status   查看该动作的检查点',
    '可选: --offline-archive <本地归档>  用本地归档代替下载（仍需摘要校验）',
    '      --keep-partial                失败时保留部分下载以便续跑（默认保留）',
    '',
    '注意：本脚本不接受 --all/--batch/--actions，一次只执行一个动作。',
    '',
  ].join('\n'))
  process.exit(0)
}

if (args.all || args.batch || args.actions) {
  fail('拒绝执行：本脚本一次只处理一个 --action，不提供批量执行开关', 2)
}
if (!args.plan) fail('缺少 --plan <plan.json>', 2)

const planPath = resolve(args.plan)
let plan
try {
  plan = await readJsonFile(planPath)
} catch (error) {
  fail(`读取计划失败：${error.message}`, 2)
}
if (plan.kind !== 'env-plan' || !Array.isArray(plan.actions)) fail('计划格式不对：需要 plan.mjs 生成的 env-plan', 2)

const body = { ...plan }
delete body.digest
const computed = digestOf(body)
const planDigest = plan.digest ?? computed

if (computed !== planDigest) {
  fail(`计划文件已被改动（内容摘要 ${computed} 与记录的 ${planDigest} 不一致），拒绝执行。请重新生成计划并重新授权。`, 3)
}

if (args.list) {
  process.stdout.write(`计划: ${planPath}\nplanDigest: ${planDigest}\n\n`)
  for (const action of plan.actions) {
    process.stdout.write(`- ${action.id}  [${action.kind}]  组件=${action.component}  目标=${action.target ?? '-'}  可逆=${action.reversible}\n`)
    if (action.installRoot) process.stdout.write(`    安装位置: ${action.installRoot}\n`)
  }
  if (plan.blockers?.length) {
    process.stdout.write(`\n阻塞项 ${plan.blockers.length}:\n`)
    for (const blocker of plan.blockers) process.stdout.write(`- ${blocker.component}: ${blocker.code} — ${blocker.detail}\n`)
  }
  if (plan.skipped?.length) {
    process.stdout.write(`\n跳过 ${plan.skipped.length}:\n`)
    for (const item of plan.skipped) process.stdout.write(`- ${item.component}: ${item.reason}\n`)
  }
  process.exit(0)
}

if (!args.action) fail('缺少 --action <actionId>（用 --list 查看可用动作）', 2)

const action = plan.actions.find((item) => item.id === args.action)
if (!action) {
  const available = plan.actions.map((item) => item.id).join(', ') || '（无）'
  fail(`计划里没有动作 ${args.action}。可用动作：${available}`, 2)
}

const ALLOWED = new Set(plan.policy?.allowedActionKinds ?? [])
if (!ALLOWED.has(action.kind)) fail(`动作种类 ${action.kind} 不在白名单内，拒绝执行`, 3)
if (action.reversible !== true) fail(`动作 ${action.id} 标记为不可逆，必须由用户手工执行`, 3)

const checkpointFile = checkpointPath(planDigest, action.id)
const logFile = logPath(planDigest, action.id)

if (args.status) {
  if (!(await exists(checkpointFile))) {
    process.stdout.write(`动作 ${action.id} 还没有检查点（未执行过）。\n`)
    process.exit(0)
  }
  const checkpoint = await readJsonFile(checkpointFile)
  process.stdout.write(`${JSON.stringify(checkpoint, null, 2)}\n`)
  process.exit(0)
}

if (!args.confirm) {
  fail(
    `缺少 --confirm <planDigest>。请先把计划原文给用户看过并取得授权，然后执行：\n`
    + `  node apply.mjs --plan ${planPath} --action ${action.id} --confirm ${planDigest}`,
    2,
  )
}
if (String(args.confirm).trim() !== planDigest) {
  fail(
    `--confirm 与计划摘要不一致，拒绝执行。\n期望: ${planDigest}\n收到: ${String(args.confirm).trim()}\n`
    + '如果计划已更新，请重新核对计划并由用户重新授权。',
    3,
  )
}

const envHomeDir = envHome()
const downloadsDir = join(envHomeDir, 'downloads')
await mkdir(downloadsDir, { recursive: true })
await mkdir(dirname(checkpointFile), { recursive: true })
await mkdir(dirname(logFile), { recursive: true })

async function log(line) {
  const text = redactText(line)
  process.stdout.write(`${text}\n`)
  await appendFile(logFile, `${text}\n`, 'utf8')
}

async function runArgv(argv, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
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

function splitCommand(command) {
  return String(command).trim().split(/\s+/).filter(Boolean)
}

let checkpoint = {
  planDigest,
  actionId: action.id,
  component: action.component,
  kind: action.kind,
  status: 'starting',
  stage: 'init',
  attempts: 0,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  createdPaths: [],
  backup: [],
  download: null,
  lastError: null,
  resumeHint: null,
  logFile,
}

if (await exists(checkpointFile)) {
  const previous = await readJsonFile(checkpointFile)
  if (previous.planDigest !== planDigest) {
    fail('检查点属于另一份计划（摘要不同）；请清理旧的检查点后再执行', 3)
  }
  checkpoint = { ...previous, attempts: (previous.attempts ?? 0) + 1, updatedAt: nowIso() }
  if (checkpoint.status === 'done') {
    process.stdout.write(`动作 ${action.id} 已经完成过（检查点 ${checkpointFile}），无需重复执行。\n`)
    process.exit(0)
  }
  await log(`[resume] 发现未完成检查点，从 stage=${checkpoint.stage} 继续（第 ${checkpoint.attempts} 次尝试）`)
} else {
  checkpoint.attempts = 1
}

async function saveCheckpoint(patch) {
  checkpoint = { ...checkpoint, ...patch, updatedAt: nowIso() }
  await writeJsonFile(checkpointFile, checkpoint)
}

function denyBroadTarget(path) {
  const normalized = resolve(path)
  const banned = ['/', '/usr', '/usr/local', '/Library', '/Applications', '/etc', '/opt', '/opt/homebrew']
  if (banned.includes(normalized)) return `目标位置过宽（${normalized}），拒绝写入；请用独立前缀`
  if (process.env.HOME && normalized === resolve(process.env.HOME)) return '目标位置是用户主目录本身，拒绝写入；请用独立前缀'
  if (/^[A-Za-z]:\\?$/.test(normalized)) return `目标位置是盘符根目录（${normalized}），拒绝写入；请用独立目录`
  return null
}

async function downloadVerified(command) {
  const url = command.url
  const localArchive = args.offlineArchive || args['offline-archive']
  const fileName = url.split('/').pop()
  const dest = join(downloadsDir, fileName)

  if (!isAbsolute(url) && !/^https:\/\//i.test(url)) fail(`只允许 https 官方下载地址，拒绝：${url}`, 3)

  if (localArchive) {
    const local = resolve(localArchive)
    if (!(await exists(local))) fail(`--offline-archive 指定的文件不存在：${local}`, 2)
    await log(`[download] 使用本地归档 ${local}（跳过网络下载）`)
    checkpoint.download = { url, file: local, mode: 'offline' }
    await saveCheckpoint({ stage: 'downloaded' })
    return local
  }

  const partial = `${dest}.partial`
  if (checkpoint.download?.file === dest && (await exists(dest)) && ['downloaded', 'checksum-ok', 'extracted', 'verified'].includes(checkpoint.stage)) {
    await log(`[download] 检查点显示已下载，复用 ${dest}（摘要仍会重新校验）`)
    return dest
  }
  if (await exists(partial)) {
    await log(`[download] 发现上次中断的临时文件，删除后重新下载：${partial}`)
    await rm(partial, { force: true })
  }

  await saveCheckpoint({ stage: 'downloading', download: { url, file: dest, mode: 'https', startedAt: nowIso() } })
  await log(`[download] GET ${url}`)
  let response
  try {
    response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) })
  } catch (error) {
    throw new Error(`下载失败（网络不可达或超时）：${error.message}。可改用 --offline-archive 指定已核对的本地归档，或换官方镜像后重新生成计划`)
  }
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}；官方源不可用时不要静默换第三方镜像，请重新核对计划`)
  }
  const writer = createWriteStream(partial)
  const reader = response.body.getReader()
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (!writer.write(Buffer.from(value))) {
      await new Promise((r) => writer.once('drain', r))
    }
  }
  await new Promise((r) => writer.end(r))
  await rm(dest, { force: true })
  await rename(partial, dest)
  await log(`[download] 已保存 ${dest}（${bytes} 字节）`)
  checkpoint.download = { url, file: dest, mode: 'https', bytes }
  await saveCheckpoint({ stage: 'downloaded' })
  return dest
}

async function verifyChecksum(file, source) {
  const algorithm = source.checksumAlgorithm || (source.sha512 ? 'sha512' : 'sha256')
  let expected = source.sha512 || source.sha256 || null
  let expectedFrom = 'plan'
  if (!expected) {
    if (!source.sha512Url && !source.sha256Url) {
      throw new Error('计划里没有摘要，也没有官方摘要文件地址：拒绝安装（禁止无摘要下载）')
    }
    const sidecarUrl = source.sha512Url || source.sha256Url
    if (!/^https:\/\//i.test(sidecarUrl)) throw new Error(`摘要文件必须来自官方 https 地址：${sidecarUrl}`)
    await log(`[checksum] 读取官方摘要文件 ${sidecarUrl}`)
    const response = await fetch(sidecarUrl, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
    if (!response.ok) throw new Error(`摘要文件不可用：HTTP ${response.status}；拒绝在没有校验材料的情况下继续`)
    const text = (await response.text()).trim()
    const match = text.match(/[A-Fa-f0-9]{32,128}/)
    if (!match) throw new Error('官方摘要文件里没有找到摘要值，拒绝继续')
    expected = match[0].toLowerCase()
    expectedFrom = 'official-sidecar'
  }
  const actual = await fileDigest(file, algorithm)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`摘要不匹配（${algorithm}）：期望 ${expected}（来自 ${expectedFrom}），实际 ${actual}；文件可能被篡改或下载不完整`)
  }
  await log(`[checksum] ${algorithm} 校验通过（来源 ${expectedFrom}）`)
  checkpoint.download = { ...(checkpoint.download ?? {}), algorithm, expected, actual, checksumSource: expectedFrom }
  await saveCheckpoint({ stage: 'checksum-ok' })
}

async function extractArchive(command) {
  const archive = checkpoint.download?.file
  if (!archive) throw new Error('缺少已下载的归档，无法解压')
  const into = resolve(command.into)
  const guard = denyBroadTarget(into)
  if (guard) throw new Error(guard)
  await mkdir(into, { recursive: true })
  const expectPath = command.expect ? join(into, command.expect) : null
  if (expectPath && (await exists(expectPath))) {
    throw new Error(`目标目录已存在：${expectPath}；为避免覆盖已有安装，拒绝解压。请人工确认后删除或换 installRoot`)
  }
  const lower = archive.toLowerCase()
  let argv
  if (lower.endsWith('.zip')) argv = ['unzip', '-q', archive, '-d', into]
  else argv = ['tar', '-xzf', archive, '-C', into]
  await log(`[extract] ${argv.join(' ')}`)
  const result = await runArgv(argv)
  if (result.code !== 0) throw new Error(`解压失败（退出码 ${result.code}）：${result.stderr.trim().split('\n')[0]}`)
  checkpoint.createdPaths = [...(checkpoint.createdPaths ?? []), expectPath ?? into]
  await saveCheckpoint({ stage: 'extracted' })
  if (expectPath && !(await exists(expectPath))) {
    throw new Error(`解压后没有出现预期目录 ${expectPath}，可能归档结构变了；需人工核对`)
  }
}

async function runVerifyCommands(action_) {
  const verify = action_.verify ?? []
  const results = []
  for (const entry of verify) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const looksLikeCommand = /^(\/|\.\/|~\/|[A-Za-z]:\\|node |npm |mvn|java )/.test(entry.trim())
    if (!looksLikeCommand) {
      results.push({ command: entry, skipped: true, reason: '这是人工验收步骤，不是可直接执行的命令' })
      continue
    }
    const argv = splitCommand(entry.replace(/^~\//, `${process.env.HOME}/`))
    await log(`[verify] ${argv.join(' ')}`)
    const result = await runArgv(argv, { cwd: action_.installRoot ? dirname(action_.installRoot) : process.cwd() })
    const ok = result.code === 0
    results.push({ command: entry, exitCode: result.code, ok, output: redactText((result.stdout || result.stderr).trim().split('\n')[0] ?? '') })
    await log(`[verify] ${ok ? 'pass' : 'fail'} — ${redactText((result.stdout || result.stderr).trim().split('\n')[0] ?? '')}`)
    if (!ok) return { ok: false, results }
  }
  return { ok: true, results }
}

async function rollback(reason) {
  const steps = []
  for (const created of checkpoint.createdPaths ?? []) {
    if (!created) continue
    if (await exists(created)) {
      await rm(created, { recursive: true, force: true })
      steps.push(`已删除本次创建的目录 ${created}`)
    }
  }
  for (const backup of checkpoint.backup ?? []) {
    if (backup.kind === 'file' && backup.backupFile && (await exists(backup.backupFile))) {
      await writeFile(backup.original, await readFile(backup.backupFile))
      steps.push(`已从备份还原本次改动的文件 ${backup.original}`)
    }
  }
  for (const step of steps) await log(`[rollback] ${step}`)
  const manual = (action.restore ?? []).filter(Boolean)
  checkpoint.status = 'failed'
  checkpoint.resumeHint = `失败原因：${redactText(reason)}；已执行回滚；可修复后用同样的 --action 重试（检查点会从 stage=${checkpoint.stage} 续跑）`
  await saveCheckpoint({ lastError: redactText(reason), rollback: steps, manualRestore: manual })
  return steps
}


async function writeProjectEnvScript(action_) {
  const command = (action_.commands ?? []).find((item) => item.kind === 'write-project-env-script')
  if (!command) throw new Error('计划里缺少 write-project-env-script 步骤')
  const projectDir = command.projectDir
  if (!projectDir) throw new Error('计划里没有项目目录，拒绝猜测写入位置')
  const dirs = (command.dirs ?? []).filter(Boolean)
  if (!dirs.length) throw new Error('没有可加入 PATH 的目录，拒绝写空脚本')
  const envDir = join(projectDir, 'scripts', 'env')
  const shFile = join(envDir, 'env.sh')
  const psFile = join(envDir, 'env.ps1')
  await mkdir(envDir, { recursive: true })

  const marker = '# managed-by: jiema-workbuddy dev-env-setup'
  for (const file of [shFile, psFile]) {
    if (await exists(file)) {
      const backupFile = `${file}.bak.${Date.now()}`
      await writeFile(backupFile, await readFile(file))
      checkpoint.backup = [...(checkpoint.backup ?? []), { kind: 'file', original: file, backupFile }]
      await log(`[backup] ${file} -> ${backupFile}`)
    }
  }
  await saveCheckpoint({ stage: 'backed-up' })

  const shBody = [
    '#!/usr/bin/env bash',
    marker,
    '# 只影响使用本脚本的进程（本项目）；不改系统 PATH、不改用户 profile。',
    `# 组件: ${action_.component}`,
    ...dirs.map((dir) => `export PATH="${dir}:$PATH"`),
    '',
  ].join('\n')
  const psBody = [
    marker,
    `# 组件: ${action_.component}`,
    ...dirs.map((dir) => `$env:Path = "${dir};" + $env:Path`),
    '',
  ].join('\r\n')
  await writeFile(shFile, shBody, 'utf8')
  await writeFile(psFile, psBody, 'utf8')
  checkpoint.createdPaths = [...(checkpoint.createdPaths ?? []), shFile, psFile]
  await saveCheckpoint({ stage: 'written' })
  await log(`[env] 已写 ${shFile} 与 ${psFile}（只含本组件目录）`)

  const componentCommand = action_.component === 'maven' ? 'mvn' : action_.component
  const probe = await runArgv(['bash', '-c', 'source "$1" >/dev/null 2>&1 && command -v "$2"', 'bash', shFile, componentCommand])
  checkpoint.verify = [{ command: `source ${shFile}; command -v ${componentCommand}`, exitCode: probe.code, ok: probe.code === 0, output: redactText(probe.stdout.trim()) }]
  if (probe.code !== 0) throw new Error(`环境脚本写入后仍找不到 ${componentCommand}，请检查目录是否正确`)
  await log(`[verify] 在新子 shell 里 source 脚本后 ${componentCommand} -> ${probe.stdout.trim()}`)
  await saveCheckpoint({ status: 'done', stage: 'verified' })
}

let exitCode = 0
try {
  await log(`[start] action=${action.id} kind=${action.kind} component=${action.component} planDigest=${planDigest}`)
  if (action.installRoot) {
    const guard = denyBroadTarget(action.installRoot)
    if (guard) throw new Error(guard)
  }

  switch (action.kind) {
    case 'download-verified-archive': {
      const downloadCommand = (action.commands ?? []).find((item) => item.kind === 'download-verified-archive')
      const extractCommand = (action.commands ?? []).find((item) => item.kind === 'extract-archive')
      if (!downloadCommand || !extractCommand) throw new Error('计划缺少下载或解压步骤')
      const archive = await downloadVerified(downloadCommand)
      await verifyChecksum(archive, action.source ?? {})
      await extractArchive(extractCommand)
      const verification = await runVerifyCommands(action)
      checkpoint.verify = verification.results
      if (!verification.ok) throw new Error('复验未通过（组件装了但不可用），见下面的 verify 结果')
      await saveCheckpoint({ status: 'done', stage: 'verified' })
      await log(`[done] ${action.id} 完成并通过复验；日志 ${logFile}`)
      break
    }

    case 'verify-only': {
      const verification = await runVerifyCommands(action)
      checkpoint.verify = verification.results
      if (!verification.ok) throw new Error('复验未通过')
      await saveCheckpoint({ status: 'done', stage: 'verified' })
      break
    }

    case 'restore-config-backup': {
      const command = (action.commands ?? []).find((item) => item.kind === 'restore-config-backup')
      if (!command?.target || !command?.backupFile) throw new Error('计划里缺少 restore-config-backup 的目标或备份文件')
      if (!(await exists(command.backupFile))) throw new Error(`备份文件不存在：${command.backupFile}`)
      if (await exists(command.target)) {
        const currentBackup = `${command.target}.broken.${Date.now()}`
        await writeFile(currentBackup, await readFile(command.target))
        await log(`[backup] 现有文件另存为 ${currentBackup}`)
        checkpoint.backup = [...(checkpoint.backup ?? []), { kind: 'file', original: command.target, backupFile: currentBackup }]
      }
      await writeFile(command.target, await readFile(command.backupFile))
      await log(`[restore] ${command.target} <- ${command.backupFile}`)
      await saveCheckpoint({ stage: 'restored' })
      const verification = await runVerifyCommands(action)
      checkpoint.verify = verification.results
      if (!verification.ok) throw new Error('恢复后复验未通过，见 verify 结果')
      await saveCheckpoint({ status: 'done', stage: 'verified' })
      await log(`[done] ${action.id} 已从备份恢复并复验通过；日志 ${logFile}`)
      break
    }
    case 'write-project-env-script': {
      await writeProjectEnvScript(action)
      await log(`[done] ${action.id} 完成；用之前先 source ${join(resolve(action.commands?.[0]?.projectDir ?? '.'), 'scripts/env/env.sh')}`)
      break
    }

    case 'append-profile-path':
    case 'start-user-service':
    case 'provision-dev-database':
    case 'install-via-plan':
    case 'user-manual-step': {
      // 这些动作要么需要用户参与，要么由专门脚本处理；apply 只做入口检查并给出准确指令
      await saveCheckpoint({ status: 'needs-user-step', stage: 'handoff' })
      await log(`[handoff] ${action.kind} 需要人工/专门脚本执行，apply 不代为完成。`)
      for (const command of action.commands ?? []) {
        await log(`  → ${command.declaredBy ?? ''}${command.script ?? command.kind} ${command.args ?? command.detail ?? ''}`.trim())
      }
      if (action.kind === 'provision-dev-database') {
        await log('  提示：provision-mysql-dev.mjs 默认只打印计划与口令约定，必须显式确认后才会执行。')
      }
      if (action.kind === 'install-via-plan') {
        await log('  提示：安装动作由 plan.mjs 生成（含官方来源与 sha512 校验），本文件只负责把它接进修复链路。')
      }
      exitCode = 4
      break
    }

    default:
      throw new Error(`未实现的动作种类：${action.kind}`)
  }
} catch (error) {
  const message = redactText(error.message ?? String(error))
  await log(`[error] ${message}`)
  const rolledBack = await rollback(message)
  await log(`[recover] 建议恢复步骤：\n  - ${(action.restore ?? ['无']).join('\n  - ')}`)
  if (rolledBack.length) await log(`[recover] 已自动完成 ${rolledBack.length} 步回滚`)
  exitCode = 1
}

const finalCheckpoint = await readJsonFile(checkpointFile).catch(() => checkpoint)
process.stdout.write(`\n检查点: ${checkpointFile}\n日志: ${logFile}\n状态: ${finalCheckpoint.status}\n`)
if (exitCode === 4) {
  process.stdout.write('说明：该动作没有被自动执行，按上面的指令继续（这是设计如此，不是失败）。\n')
}
process.exit(exitCode)

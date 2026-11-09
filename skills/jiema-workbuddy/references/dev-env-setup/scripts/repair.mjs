#!/usr/bin/env node
/**
 * 环境修复计划（repair）
 *
 * 与 plan.mjs 的分工：
 *   plan.mjs   —— 「要装什么」：按需求 + 诊断生成安装动作（新装 / 增量补齐）。
 *   repair.mjs —— 「坏了怎么修」：按诊断里的异常状态生成**可执行修复动作**，
 *                 输出与 plan.json 同构的计划，直接交给 apply.mjs 逐项执行。
 *
 * 用法：
 *   node scripts/repair.mjs --diagnose diagnose.ndjson --requirements requirements.json \
 *        [--project <项目目录>] [--out repair-plan.json]
 *   node scripts/repair.mjs --diagnose ... --requirements ... --apply --action <id> --confirm <digest>
 *
 * 覆盖三类现场：
 *   1. 全新电脑：缺组件（missing）→ 交给 plan.mjs 生成安装动作，本脚本只列入口；
 *   2. 部分安装：装了但 PATH 看不到（path-invisible）、版本不满足（version-incompatible）；
 *   3. 环境损坏：服务未启动（service-stopped）、连接失败（connect-failed）、数据/目录损坏（data-corrupt）。
 *
 * 边界：本脚本只自动执行「用户级、可逆、无提权」的修复；提权、服务注册、数据目录恢复一律
 * 生成为 user-manual-step，把准确命令交给用户。
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { digestOf, parseArgs, parseDiagnoseOutput, readJsonFile, redactText, requireArgs, writeJsonFile } from './lib/common.mjs'

const args = parseArgs(process.argv.slice(2), {
  diagnose: 'string',
  requirements: 'string',
  project: 'string',
  out: 'string',
  apply: 'boolean',
  action: 'string',
  confirm: 'string',
})

requireArgs(args, ['diagnose', 'requirements'])

const ALLOWED_KINDS = [
  'write-project-env-script',
  'restore-config-backup',
  'verify-only',
  'install-via-plan',
  'user-manual-step',
]

const diagnoseRecords = parseDiagnoseOutput(await readFile(resolve(args.diagnose), 'utf8'))
const requirements = await readJsonFile(resolve(args.requirements))
const components = Array.isArray(requirements?.components) ? requirements.components : []
const projectDir = args.project ? resolve(args.project) : requirements?.project?.directory ?? null
const installRoot = requirements?.project?.installRoot ?? null

const recordOf = (name) => diagnoseRecords.find((record) => record?.type === 'component' && record.component === name) ?? null

const actions = []
const skipped = []
const blockers = []
const manual = []

function pushAction(action) {
  actions.push({
    id: action.id,
    component: action.component,
    current: action.current ?? null,
    target: action.target ?? null,
    kind: action.kind,
    source: action.source ?? null,
    commands: action.commands ?? [],
    installRoot: action.installRoot ?? null,
    privileges: action.privileges ?? 'user',
    impact: action.impact ?? '',
    backup: action.backup ?? null,
    restore: action.restore ?? [],
    verify: action.verify ?? [],
    reversible: action.reversible === true,
    ...(action.requiresUserAction ? { requiresUserAction: true } : {}),
  })
}

for (const component of components) {
  const name = component?.name ?? component?.component
  if (!name) continue
  const record = recordOf(name)
  const state = record?.state ? String(record.state) : 'not-diagnosed'
  const current = record?.version ?? record?.path ?? null
  const required = component?.version ?? component?.target ?? null

  switch (state) {
    case 'ok':
      skipped.push({ component: name, state, reason: '诊断通过，无需修复' })
      break

    case 'missing':
      pushAction({
        id: `${name}-install-via-plan`,
        component: name,
        current: null,
        target: required,
        kind: 'install-via-plan',
        impact: '本脚本不自行造安装动作：先由 plan.mjs 按需求与诊断生成带官方来源与摘要校验的安装动作',
        commands: [{
          kind: 'delegate', declaredBy: 'scripts/plan.mjs',
          detail: `node scripts/plan.mjs --requirements ${args.requirements} --diagnose ${args.diagnose} --out plan.json`,
        }],
        restore: ['安装动作由 plan.mjs 生成，回滚方式见该计划里的 restore 字段'],
        verify: [`复验：node scripts/verify.mjs --project <项目目录> --components ${name} --out verify.json`],
        reversible: true,
        requiresUserAction: true,
      })
      manual.push({ component: name, reason: '缺失组件需要真实安装，走 plan.mjs + apply.mjs 的授权链路' })
      break

    case 'path-invisible':
      if (!projectDir) {
        blockers.push({ component: name, reason: '需要 --project 才能在项目内写环境脚本，拒绝猜测写入位置' })
        break
      }
      pushAction({
        id: `${name}-repair-path`,
        component: name,
        current,
        target: current,
        kind: 'write-project-env-script',
        commands: [{
          kind: 'write-project-env-script',
          projectDir,
          dirs: [record?.binDir ?? record?.path].filter(Boolean),
        }],
        impact: '只写项目内 scripts/env/env.sh 与 env.ps1，不改系统 PATH、不改用户 profile',
        backup: { kind: 'file', detail: '已有 env.sh/env.ps1 先备份为 .bak.<时间戳>' },
        restore: ['删除项目内 scripts/env/ 下本次写入的两份脚本，或用备份文件还原'],
        verify: [`source ${projectDir}/scripts/env/env.sh && command -v ${name}`],
        reversible: true,
      })
      break

    case 'version-incompatible':
      pushAction({
        id: `${name}-version-via-plan`,
        component: name,
        current,
        target: required,
        kind: 'install-via-plan',
        impact: '并行安装满足要求的版本到独立前缀，旧版本保留为备用；不卸载、不覆盖',
        commands: [{
          kind: 'delegate', declaredBy: 'scripts/plan.mjs',
          detail: `node scripts/plan.mjs --requirements ${args.requirements} --diagnose ${args.diagnose} --versions ${name}=<选定版本> --out plan.json`,
        }],
        installRoot,
        restore: ['删除新装前缀即可回到原状态；旧版本未被修改'],
        verify: [`新前缀下 ${name} 的版本命令`, '项目真实构建一次'],
        reversible: true,
        requiresUserAction: true,
      })
      manual.push({ component: name, reason: '版本不满足需要安装并行版本，走 plan.mjs 选择版本并由用户授权' })
      break

    case 'service-stopped':
      pushAction({
        id: `${name}-start-service`,
        component: name,
        current,
        target: current,
        kind: 'user-manual-step',
        impact: '启动数据库/应用服务器属于服务状态变更；技能只给命令，不代跑，也不改自启类型',
        commands: [{
          kind: 'declared-command',
          declaredBy: 'references/troubleshooting.md',
          detail: record?.startHint ?? `按 references/troubleshooting.md 里 ${name} 的前台启动步骤启动，并只绑定回环地址`,
        }],
        restore: ['停止本次启动的进程；不重建数据目录、不改管理员口令'],
        verify: [`连接 ${name} 的健康检查命令`, '业务入口真实访问'],
        reversible: true,
        requiresUserAction: true,
      })
      manual.push({ component: name, reason: '服务启动需要在本机真实执行，命令已写好但未代跑' })
      break

    case 'connect-failed':
      pushAction({
        id: `${name}-diagnose-connection`,
        component: name,
        current,
        target: required,
        kind: 'user-manual-step',
        impact: '连接失败需先取证（监听地址、认证插件、端口占用、防火墙），不靠改密或重建数据「试试看」',
        commands: [{
          kind: 'declared-command', declaredBy: 'references/troubleshooting.md',
          detail: `按 references/troubleshooting.md 中 ${name} 的连接失败条目逐项核对`,
        }],
        restore: ['本动作不写入，无需回滚'],
        verify: ['用应用身份真实鉴权连接并读写一条记录'],
        reversible: true,
        requiresUserAction: true,
      })
      manual.push({ component: name, reason: '连接类故障需要现场取证，不能自动改配置' })
      break

    case 'data-corrupt':
      pushAction({
        id: `${name}-recover-data`,
        component: name,
        current,
        target: required,
        kind: 'user-manual-step',
        impact: '数据/安装目录损坏：先备份取证，再由用户选择从备份还原或新建实例；技能禁止删除或重建已有 datadir',
        commands: [{
          kind: 'declared-command', declaredBy: 'references/troubleshooting.md',
          detail: `备份 ${record?.datadir ?? '<datadir>'} 后，按 troubleshooting 的损坏处置与会话记录恢复`,
        }],
        restore: ['恢复动作本身即以备份为基础；本轮不改动原目录'],
        verify: ['服务启动 + 应用身份连接 + 一条业务查询'],
        reversible: false,
        requiresUserAction: true,
      })
      manual.push({ component: name, reason: '数据损坏属高影响现场，必须由用户决定恢复方式' })
      break

    case 'needs-elevation':
      pushAction({
        id: `${name}-elevation`,
        component: name,
        current,
        target: required,
        kind: 'user-manual-step',
        impact: '该修复需要管理员权限；技能不做提权也不代跑提权命令，只给出准确命令与影响说明',
        commands: [{
          kind: 'declared-command', declaredBy: 'references/troubleshooting.md',
          detail: record?.hint ?? '按 troubleshooting 对应条目，由用户在自己的管理员终端执行',
        }],
        restore: ['命令由用户执行，回滚步骤随命令一并给出'],
        verify: ['执行后重新诊断并复验该项目所需组件'],
        reversible: true,
        requiresUserAction: true,
      })
      manual.push({ component: name, reason: '需要提权，交用户执行' })
      break

    case 'unsupported-on-this-os':
      blockers.push({
        component: name,
        reason: `${name} 在本操作系统没有受支持的原生方案；请选择远程/目标机器实例或等价组件`,
      })
      break

    case 'needs-user-input':
      blockers.push({
        component: name,
        reason: `${name} 缺少必要输入（位置、版本选择或口令来源），请先问一次再继续`,
      })
      break

    case 'not-diagnosed':
      blockers.push({ component: name, reason: '诊断里没有这个组件；先补一次只读诊断，再决定是否修复' })
      break

    default:
      blockers.push({ component: name, reason: `未识别的诊断状态 ${state}；按 references/components.md 的状态词表核对` })
  }
}

const planBody = {
  kind: 'env-plan',
  version: 1,
  generatedAt: new Date().toISOString(),
  purpose: 'repair',
  platform: requirements?.platform ?? null,
  project: { directory: projectDir, installRoot },
  policy: {
    description: '修复计划：一次只做一个动作；只自动执行用户级、可逆、无提权的修复',
    allowedActionKinds: ALLOWED_KINDS,
    batchExecution: false,
    forbiddenPatterns: [
      'sudo / 提权代跑',
      '删除或重建已有 datadir',
      '修改已有实例管理员口令',
      'curl | bash 一类远程脚本管道',
      '无摘要校验的下载',
    ],
  },
  actions,
  skipped,
  blockers,
  manual,
  notes: [
    '缺组件与版本不满足的安装动作由 plan.mjs 生成，本脚本不重复造安装动作',
    '所有动作都要逐项授权；授权一项不延伸到其它组件',
    '执行：node scripts/apply.mjs --plan <本文件> --action <id> --confirm <digest>',
  ],
}

const digest = digestOf(planBody)
const plan = { ...planBody, digest }

if (args.out) await writeJsonFile(resolve(args.out), plan)

if (args.apply) {
  const { spawnSync } = await import('node:child_process')
  const target = resolve(import.meta.dirname, 'apply.mjs')
  const result = spawnSync(process.execPath, [
    target,
    '--plan', resolve(args.out ?? 'repair-plan.json'),
    '--action', String(args.action ?? ''),
    '--confirm', String(args.confirm ?? ''),
  ], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
if (blockers.length) {
  process.stderr.write(`\n有 ${blockers.length} 个阻塞项，先处理再执行任何动作：\n`)
  for (const blocker of blockers) process.stderr.write(`  - ${redactText(blocker.component)}: ${redactText(blocker.reason)}\n`)
}
if (!actions.length && !blockers.length) process.stdout.write('\n没有需要修复的组件。\n')

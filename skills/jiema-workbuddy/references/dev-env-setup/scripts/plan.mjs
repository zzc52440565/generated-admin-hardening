#!/usr/bin/env node
// requirements + diagnose 结果 → 本机安装/修复计划 JSON（逐项需用户授权后才执行）。
//
// 用法：
//   node plan.mjs --requirements req.json --diagnose diagnose.ndjson --out plan.json
//   node plan.mjs --requirements req.json --diagnose diagnose.ndjson --versions maven=3.9.9 --install-root ~/.local/jiema-env
//
// 只允许白名单动作；禁止 curl|bash、禁止无摘要下载、禁止改已有数据库管理员口令、禁止重建已有 datadir。

import { demoPassword } from '../../../scripts/policy.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  digestOf, envHome, fail, nowIso, parseArgs, parseDiagnoseOutput, redactText,
  requireArgs, writeJsonFile,
} from './lib/common.mjs'

const args = parseArgs(process.argv.slice(2), {
  requirements: 'string',
  diagnose: 'string',
  out: 'string',
  platform: 'string',
  'install-root': 'string',
  installRoot: 'string',
  versions: 'string',
  'resolve-versions': 'boolean',
  resolveVersions: 'boolean',
  'mysql-port': 'string',
  mysqlPort: 'string',
  'profile-file': 'string',
  profileFile: 'string',
  help: 'boolean',
})
if (args.help) {
  process.stdout.write([
    '用法: node plan.mjs --requirements <req.json> --diagnose <diagnose.ndjson> [选项]',
    '  --out <文件>              写出计划 JSON（同时打印到 stdout）',
    '  --install-root <目录>     独立安装前缀，默认 ~/.local/jiema-env',
    '  --versions maven=3.9.9    指定要安装的官方版本（多组用逗号分隔）',
    '  --mysql-port <端口>       本机开发实例端口，默认 3307',
    '  --profile-file <文件>     允许写入的 shell 配置文件，默认不写任何 profile',
    '',
  ].join('\n'))
  process.exit(0)
}
requireArgs(args, ['requirements', 'diagnose'])

const requirementsPath = resolve(args.requirements)
const diagnosePath = resolve(args.diagnose)

let requirements
try {
  requirements = JSON.parse(await readFile(requirementsPath, 'utf8'))
} catch (error) {
  fail(`读取需求清单失败：${error.message}`)
}
let diagnoseRecords
try {
  diagnoseRecords = parseDiagnoseOutput(await readFile(diagnosePath, 'utf8'))
} catch (error) {
  fail(`读取诊断结果失败：${error.message}`)
}

const platformRecord = diagnoseRecords.find((record) => record?.type === 'platform') ?? null
const diagnoseComponents = diagnoseRecords.filter((record) => record?.type === 'component')
const platform = String(args.platform || platformRecord?.platform || process.platform).toLowerCase()
const isWindows = platform === 'windows' || platform === 'win32'
const installRoot = resolve(args.installRoot || args['install-root'] || envHome())
const mysqlPort = Number(args.mysqlPort || args['mysql-port'] || 3307)
const profileFile = args.profileFile || args['profile-file'] || null

const versions = {}
for (const pair of String(args.versions || '').split(',')) {
  const [name, version] = pair.split('=')
  if (name && version) versions[name.trim()] = version.trim()
}

// 官方镜像只保留近期版本（例如 dlcdn 上 3.9.9 已 404）。允许现场解析官方目录，
// 而不是把版本号写死在代码里——写死的版本迟早变成 404。
async function resolveLatest(listingUrl, pattern, preferPrefix) {
  if (!/^https:\/\//i.test(listingUrl)) throw new Error(`只允许 https 官方地址：${listingUrl}`)
  const response = await fetch(listingUrl, { redirect: 'follow', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`读取官方目录失败：HTTP ${response.status}（${listingUrl}）`)
  const html = await response.text()
  let found = []
  for (const match of html.matchAll(pattern)) found.push(match[1])
  if (!found.length) throw new Error(`官方目录里没有解析到版本：${listingUrl}`)
  if (preferPrefix) {
    const preferred = found.filter((item) => item.startsWith(preferPrefix))
    if (preferred.length) found = preferred
  }
  const compare = (a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (diff !== 0) return diff
    }
    return 0
  }
  found.sort(compare)
  return found[found.length - 1]
}

if (args.resolveVersions || args['resolve-versions']) {
  try {
    if (!versions.maven) versions.maven = await resolveLatest('https://dlcdn.apache.org/maven/maven-3/', /href="(3\.[0-9]+\.[0-9]+)\//g, '3.9.')
    if (!versions.tomcat) versions.tomcat = await resolveLatest('https://dlcdn.apache.org/tomcat/tomcat-10/', /href="v?(10\.[0-9]+\.[0-9]+)\//g)
    process.stderr.write(`已按官方目录解析版本：maven=${versions.maven ?? '-'} tomcat=${versions.tomcat ?? '-'}（解析时间 ${new Date().toISOString()}）\n`)
  } catch (error) {
    process.stderr.write(`版本解析失败，改用计划里的显式版本：${error.message}\n`)
  }
}

// 官方来源登记表：只登记官方域名与官方摘要文件位置，不缓存第三方镜像。
const OFFICIAL = {
  maven: {
    label: 'Apache Maven',
    listing: 'https://dlcdn.apache.org/maven/maven-3/',
    archive: (v) => (isWindows
      ? `https://dlcdn.apache.org/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.zip`
      : `https://dlcdn.apache.org/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.tar.gz`),
    checksum: (v) => (isWindows
      ? { algorithm: 'sha512', url: `https://dlcdn.apache.org/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.zip.sha512` }
      : { algorithm: 'sha512', url: `https://dlcdn.apache.org/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.tar.gz.sha512` }),
    homeRel: (v) => `apache-maven-${v}`,
    verifyFile: (v) => (isWindows ? `apache-maven-${v}/bin/mvn.cmd` : `apache-maven-${v}/bin/mvn`),
  },
  tomcat: {
    label: 'Apache Tomcat',
    listing: 'https://dlcdn.apache.org/tomcat/',
    archive: (v) => {
      const base = `https://dlcdn.apache.org/tomcat/tomcat-${String(v).split('.')[0]}/v${v}/bin/apache-tomcat-${v}`
      return isWindows ? `${base}-windows-x64.zip` : `${base}.tar.gz`
    },
    checksum: (v) => {
      const base = `https://dlcdn.apache.org/tomcat/tomcat-${String(v).split('.')[0]}/v${v}/bin/apache-tomcat-${v}`
      return { algorithm: 'sha512', url: isWindows ? `${base}-windows-x64.zip.sha512` : `${base}.tar.gz.sha512` }
    },
    homeRel: (v) => `apache-tomcat-${v}`,
    verifyFile: (v) => (isWindows ? `apache-tomcat-${v}/bin/catalina.bat` : `apache-tomcat-${v}/bin/catalina.sh`),
  },
}

const POLICY = {
  allowedActionKinds: [
    'download-verified-archive',
    'extract-archive',
    'write-project-env-script',
    'append-profile-path',
    'start-user-service',
    'provision-dev-database',
    'user-manual-step',
    'verify-only',
  ],
  forbiddenPatterns: [
    'curl ... | bash / sh / zsh（远程脚本管道）',
    '无摘要校验的下载',
    'sudo / 管理员提权后安装系统级服务',
    '修改已有数据库实例的管理员口令',
    '删除或重建已有 MySQL datadir',
    '全局覆盖已有 PATH 顺序',
    '关闭系统安全策略（UAC / SIP / ExecutionPolicy）',
  ],
  notes: [
    '所有动作都要逐项授权；授权一项不延伸到重装、改密或其它组件',
    '可逆动作优先：独立前缀 + 项目级环境脚本，而不是全局安装',
  ],
}

const actions = []
const skipped = []
const blockers = []

function stateOf(component) {
  const record = diagnoseComponents.find((item) => item?.component === component)
  return record ? String(record.state) : 'not-diagnosed'
}

function recordOf(component) {
  return diagnoseComponents.find((item) => item?.component === component) ?? null
}

function pushManual(component, { current, target, reason, officialUrl, extraVerify = [] }) {
  actions.push({
    id: `${component}-manual`,
    component,
    current: current ?? null,
    target: target ?? null,
    kind: 'user-manual-step',
    source: officialUrl ? { officialUrl, sha256: null, sha512: null, checksumNote: '由用户执行时按官方页面现场核对摘要' } : null,
    commands: [],
    installRoot: null,
    privileges: 'user',
    impact: reason,
    backup: null,
    restore: ['本动作不自动执行，不存在需要回滚的写入'],
    verify: [...extraVerify],
    reversible: true,
    requiresUserAction: true,
  })
}

function pushArchiveInstall(component, spec, version, requirement, diag) {
  const id = `${component}-install-${version}`
  const archive = spec.archive(version)
  const checksum = spec.checksum(version)
  const target = `${installRoot}/${spec.homeRel(version)}`
  actions.push({
    id,
    component,
    current: diag?.version ?? null,
    target: version,
    kind: 'download-verified-archive',
    source: {
      officialUrl: archive,
      sha256: null,
      sha512: null,
      sha512Url: checksum.url,
      checksumAlgorithm: checksum.algorithm,
      checksumPolicy: '下载后校验官方 sha512 sidecar；sidecar 不可用则拒绝执行',
    },
    commands: [
      { kind: 'download-verified-archive', url: archive, checksumUrl: checksum.url, algorithm: checksum.algorithm, dest: `${installRoot}/downloads/` },
      { kind: 'extract-archive', into: installRoot, expect: spec.homeRel(version) },
      { kind: 'verify-only', command: `${target}/${spec.verifyFile(version).split('/').slice(1).join('/')} -v` },
    ],
    installRoot: target,
    privileges: 'user',
    impact: `只在独立前缀 ${installRoot} 下新增目录；不改系统 PATH、不装系统服务、不动已有安装`,
    backup: { kind: 'none-needed', detail: '目标前缀不存在时无需备份；已存在则拒绝执行，避免覆盖' },
    restore: [`rm -rf ${target}`, `删除下载缓存 ${installRoot}/downloads/${archive.split('/').pop()}`],
    verify: [
      `${target}/bin/${spec.label === 'Apache Maven' ? (isWindows ? 'mvn.cmd' : 'mvn') : 'catalina.sh'} -v`,
      `用项目真实构建命令构建一次（见 verify.mjs --build）`,
    ],
    reversible: true,
    requirementReason: requirement?.reason ?? null,
  })
}

// ---------- 按组件状态生成动作 ----------
const componentOrder = Array.isArray(requirements.diagnoseComponents) ? requirements.diagnoseComponents : []

for (const component of componentOrder) {
  const diag = recordOf(component)
  const requirement = (requirements.components ?? []).find((item) => item?.component === component) ?? null
  const state = diag?.state ?? 'not-diagnosed'
  const current = diag?.version ?? null

  switch (state) {
    case 'ok':
      skipped.push({ component, reason: `诊断状态 ok（${current ?? '版本已满足'}）；不重复安装，只保留复验`, needsVerify: true })
      break

    case 'missing': {
      if (component === 'maven' && OFFICIAL.maven) {
        const version = versions.maven
        if (version) {
          pushArchiveInstall(component, OFFICIAL.maven, version, requirement, diag)
        } else {
          pushManual(component, {
            current,
            target: requirement?.requiredMajor ? `≥ ${requirement.requiredMajor}` : '由官方页面确定',
            reason: '缺少 Maven 且未指定版本；版本必须在 S3 计划里显式选定（不要凭记忆写死），选定后走官方压缩包 + sha512 校验',
            officialUrl: OFFICIAL.maven.listing,
            extraVerify: ['mvn -v', '用项目 pom.xml 真实构建一次'],
          })
        }
        break
      }
      if (component === 'tomcat' && OFFICIAL.tomcat) {
        const version = versions.tomcat
        if (version) {
          pushArchiveInstall(component, OFFICIAL.tomcat, version, requirement, diag)
        } else {
          pushManual(component, {
            current,
            target: requirement?.requiredMajor ? `Tomcat ${requirement.requiredMajor}.x` : '由官方页面确定',
            reason: '项目是外部 WAR 部署，需要 Tomcat；版本需按项目 servlet API 选定后从官方压缩包安装到独立前缀',
            officialUrl: OFFICIAL.tomcat.listing,
            extraVerify: ['部署 WAR 后请求真实 URL 并校验 HTTP 200 与页面内容'],
          })
        }
        break
      }
      if (component === 'java') {
        pushManual(component, {
          current,
          target: requirement?.requiredMajor ? `JDK ${requirement.requiredMajor}` : '按项目编译目标',
          reason: '缺少 JDK：需要按项目编译目标选定发行版与版本，由用户确认安装位置（Temurin/Adoptium 官方包，带官方 SHA256 清单）',
          officialUrl: 'https://adoptium.net/temurin/releases/',
          extraVerify: ['java -version', '用项目源码真实编译一次'],
        })
        break
      }
      if (component === 'node' || component === 'npm') {
        pushManual(component, {
          current,
          target: requirement?.requiredMajor ? `Node ≥ ${requirement.requiredMajor}` : '按项目 engines.node',
          reason: '缺少 Node/npm：按项目 engines 选定版本，从 nodejs.org 官方发行包安装到独立前缀（自带 SHASUMS256.txt）',
          officialUrl: 'https://nodejs.org/dist/',
          extraVerify: ['node -v', 'npm -v', '在项目目录真实 npm ci/install 后构建一次'],
        })
        break
      }
      if (component === 'mysql' || component === 'postgresql') {
        pushManual(component, {
          current,
          target: null,
          reason: '缺少数据库：本机开发实例应由 provision-mysql-dev.mjs 单独创建（限定 127.0.0.1、独立 datadir 与端口、独立账号），不得复用未知实例',
          officialUrl: component === 'mysql' ? 'https://dev.mysql.com/downloads/mysql/' : 'https://www.postgresql.org/download/',
          extraVerify: ['用应用账号鉴权连接目标库并执行一次真实查询'],
        })
        break
      }
      pushManual(component, {
        current,
        target: null,
        reason: `缺少 ${component}：确认本项目确实需要后，按 references/install-recipes.md 装到独立前缀`,
        officialUrl: null,
      })
      break
    }

    case 'path-invisible': {
      actions.push({
        id: `${component}-path-visibility`,
        component,
        current,
        target: current,
        kind: 'write-project-env-script',
        source: null,
        commands: [
          {
            kind: 'write-project-env-script',
            component,
            projectDir: requirements.project?.dir ?? null,
            dirs: [
              diag?.resolvedPath ? dirname(diag.resolvedPath) : null,
              ...(diag?.candidates ?? []).map((item) => {
                const raw = String(item).includes(':') ? String(item).split(':').pop() : String(item)
                return /[\\/](mvn|gradle|catalina\.sh|java|node|npm|psql|mysql)(\.cmd|\.bat|\.exe)?$/.test(raw) ? dirname(raw) : raw
              }),
            ].filter(Boolean).filter((value, index, list) => list.indexOf(value) === index),
            detail: '在项目内写 scripts/env/env.sh（及 env.ps1），只把该组件目录加进本项目的 PATH，不改系统 PATH 与用户 profile',
          },
        ],
        installRoot: null,
        privileges: 'user',
        impact: '只写项目内文件 + 当前会话环境，不改注册表/系统 PATH，不改用户 profile',
        backup: { kind: 'file', target: '<project>/scripts/env/env.sh 或 env.ps1', when: '文件已存在时先备份为 .bak.<时间戳>' },
        restore: ['删除或还原该项目内环境脚本'],
        verify: [`在同一个新子 shell 里 source 该脚本后诊断 ${component} 应变为 ok`],
        reversible: true,
        reason: diag?.notes?.join('; ') ?? '已安装但 PATH 看不到',
      })
      break
    }

    case 'version-incompatible': {
      const missingVersion = versions[component]
      if (component === 'maven' && missingVersion) {
        pushArchiveInstall(component, OFFICIAL.maven, missingVersion, requirement, diag)
      } else {
        pushManual(component, {
          current,
          target: requirement?.requiredMajor ? `≥ ${requirement?.requiredMajor}` : '按项目要求',
          reason: '生效版本不满足项目要求：并行安装满足要求的版本到独立前缀（保留旧版本），再用项目级 PATH/JAVA_HOME 指向它',
          officialUrl: null,
          extraVerify: [`在新子 shell 里诊断 ${component} 应为 ok`, '用项目真实构建验证版本兼容'],
        })
      }
      break
    }

    case 'service-stopped':
      actions.push({
        id: `${component}-start-service`,
        component,
        current,
        target: 'running',
        kind: 'start-user-service',
        source: null,
        commands: [
          { kind: 'start-user-service', detail: `按 references/failure-recovery.md 里的 ${component} 启动步骤前台启动，仅绑定 127.0.0.1` },
        ],
        installRoot: null,
        privileges: 'user',
        impact: '会启动一个本机进程/服务；不重建数据目录、不改口令、不装系统级服务',
        backup: { kind: 'evidence', detail: '启动前保存错误日志尾部与服务状态' },
        restore: [`停止该进程（kill <pid> 或对应的 stop 脚本），恢复启动前状态`],
        verify: ['端口在监听', '用应用账号真实鉴权连接一次', '业务查询返回预期结果'],
        reversible: true,
        reason: diag?.notes?.join('; ') ?? '组件存在但服务未运行',
      })
      break

    case 'data-corrupt':
      pushManual(component, {
        current,
        target: null,
        reason: '数据目录/安装目录疑似损坏：先备份再判断，绝不自动重建；由用户决定恢复方式',
        officialUrl: null,
        extraVerify: ['备份完成后再做任何修复', '修复后用真实读写验证'],
      })
      break

    case 'connect-failed':
      pushManual(component, {
        current,
        target: null,
        reason: '端口在监听但连接失败：先确认监听地址、协议与端口占用，再决定动作',
        officialUrl: null,
      })
      break

    case 'needs-elevation':
      pushManual(component, {
        current,
        target: null,
        reason: '该修复需要管理员权限：由用户在目标机器上亲自执行，技能不代为提权',
        officialUrl: null,
      })
      break

    case 'needs-user-input':
      pushManual(component, {
        current,
        target: null,
        reason: '需要用户输入或选择（口令、安装位置、是否修改用户环境变量）后才能继续',
        officialUrl: null,
      })
      break

    case 'unsupported-on-this-os':
      blockers.push({
        component,
        code: 'unsupported-on-this-os',
        detail: diag?.notes?.join('; ') ?? '该组件在本操作系统没有原生方案',
        options: ['使用用户确认的远程/Windows 实例', '与用户确认换用受支持的等价组件', '换到目标操作系统机器上做'],
      })
      break

    case 'not-diagnosed':
      blockers.push({
        component,
        code: 'not-diagnosed',
        detail: '需求清单里有这个组件，但诊断结果里没有对应记录；先跑 diagnose 再规划',
        options: ['补跑 diagnose-macos.sh / diagnose-windows.ps1'],
      })
      break

    default:
      blockers.push({ component, code: `unhandled-state`, detail: `诊断状态 ${state} 没有对应动作`, options: ['人工复核'] })
  }
}

// MySQL 本机开发实例：单独一项，且必须由 provision 脚本二次确认
if (componentOrder.includes('mysql') && recordOf('mysql')) {
  const diag = recordOf('mysql')
  const running = diag?.serverRunning === true || diag?.state === 'ok'
  if (running) {
    skipped.push({
      component: 'mysql',
      reason: '本机已有实例在监听；按“复用已有实例”处理，不新建实例、不改其口令',
      needsVerify: true,
    })
  } else {
    actions.push({
      id: 'mysql-provision-dev',
      component: 'mysql',
      current: diag?.version ?? null,
      target: `本机开发实例 127.0.0.1:${mysqlPort}`,
      kind: 'provision-dev-database',
      source: null,
      commands: [
        { kind: 'provision-dev-database', script: 'scripts/provision-mysql-dev.mjs', args: `--port ${mysqlPort} --datadir ${installRoot}/mysql-${mysqlPort}/data` },
      ],
      installRoot: `${installRoot}/mysql-${mysqlPort}`,
      privileges: 'user',
      impact: '新建一个独立的本机开发实例：只绑定 127.0.0.1、独立 datadir 与端口、独立账号；不触碰任何已有实例',
      backup: { kind: 'none-needed', detail: '新目录不存在才执行；若目标 datadir 已存在则拒绝执行' },
      restore: [`停止该实例并删除 ${installRoot}/mysql-${mysqlPort}`],
      verify: ['用应用账号在 127.0.0.1 上鉴权连接', '执行一次真实建表/插入/查询'],
      reversible: true,
      requiresUserAction: true,
      credentialConvention: {
        text: `本机开发 MySQL 新建实例默认口令 ${demoPassword}`,
        disclosedBeforeApply: true,
        constraints: [
          '只允许 bind-address=127.0.0.1',
          '只用于本机开发，禁止用于远程或生产',
          '不得修改已有实例的管理员口令',
          '不得覆盖已有 datadir',
          '日志与报告不得出现真实口令',
        ],
      },
    })
  }
}

const planBody = {
  schemaVersion: 1,
  kind: 'env-plan',
  generatedAt: nowIso(),
  platform: isWindows ? 'windows' : 'macos',
  installRoot,
  project: requirements.project ?? null,
  requirementsPath,
  diagnosePath,
  policy: POLICY,
  components: componentOrder.map((component) => ({
    component,
    state: stateOf(component),
    required: (requirements.components ?? []).find((item) => item?.component === component) ?? null,
  })),
  actions,
  skipped,
  blockers,
  approval: {
    mode: 'per-action',
    rule: '每个 action 单独授权；apply.mjs 一次只执行一个 action，必须带 --confirm <planDigest>',
    batchAllowed: false,
  },
}
const digest = digestOf(planBody)
const plan = { ...planBody, digest }

if (args.out) await writeJsonFile(resolve(args.out), plan)
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
if (planHasForbiddenPatterns({ actions: plan.actions, blockers: plan.blockers, skipped: plan.skipped })) {
  fail('内部错误：计划中出现可疑动作（远程脚本管道/无摘要下载/改密/重建 datadir），已中止')
}

function planHasForbiddenPatterns(value) {
  const text = JSON.stringify(value)
  const bad = [
    /curl[^"]*\|\s*(ba)?sh/i,
    /iwr[^"]*\|[^"]*iex/i,
    /identified\s+by|identified\s+with\s+mysql_native_password/i,
    /rm\s+-rf\s+\/?(datadir|data)/i,
    /--initialize(-insecure)?[^"]*existing/i,
  ]
  const hits = bad.filter((re) => re.test(text))
  if (hits.length) process.stderr.write(`${redactText(`计划自检命中禁用模式：${hits.map(String).join(', ')}`)}\n`)
  return hits.length > 0
}

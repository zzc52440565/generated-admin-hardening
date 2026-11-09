#!/usr/bin/env node
// 扫描一个已下载的项目目录，输出「本项目真正需要的组件」JSON。
// 只提取依赖与版本；配置文件中的口令一律替换为 <redacted>，绝不输出凭据值。
//
// 用法：
//   node detect-requirements.mjs --project <项目目录> [--out requirements.json] [--platform <提示>]

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import {
  fail, nowIso, parseArgs, parseMajor, redactText, requireArgs, writeJsonFile,
} from './lib/common.mjs'

const args = parseArgs(process.argv.slice(2), {
  project: 'string', out: 'string', platform: 'string', json: 'boolean', help: 'boolean',
})
if (args.help) {
  process.stdout.write('用法: node detect-requirements.mjs --project <项目目录> [--out <文件>] [--platform <提示>]\n')
  process.exit(0)
}
requireArgs(args, ['project'])

const projectDir = resolve(args.project)
try {
  const info = await stat(projectDir)
  if (!info.isDirectory()) fail(`项目路径不是目录: ${projectDir}`)
} catch {
  fail(`项目目录不存在: ${projectDir}`)
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', '.idea', '.vscode', 'vendor', '__pycache__'])
const MAX_DEPTH = 6
const MAX_FILES = 8000

async function walk(dir, depth = 0, collected = []) {
  if (depth > MAX_DEPTH || collected.length >= MAX_FILES) return collected
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return collected
  }
  for (const entry of entries) {
    if (collected.length >= MAX_FILES) break
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, depth + 1, collected)
      continue
    }
    if (entry.isFile()) collected.push(full)
  }
  return collected
}

const files = await walk(projectDir)
const rel = (file) => relative(projectDir, file).split('\\').join('/')
const byName = new Map()
for (const file of files) {
  const name = basename(file)
  if (!byName.has(name)) byName.set(name, [])
  byName.get(name).push(file)
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

const evidence = []
const warnings = []
function note(reason, file) {
  if (reason) evidence.push(file ? `${reason}（${rel(file)}）` : reason)
}
function warn(text) {
  warnings.push(text)
}

// ---------- Maven ----------
const pomFiles = byName.get('pom.xml') ?? []
const mavenWrappers = [...(byName.get('mvnw') ?? []), ...(byName.get('mvnw.cmd') ?? [])]
const gradleFiles = [...(byName.get('build.gradle') ?? []), ...(byName.get('build.gradle.kts') ?? [])]
const gradleWrappers = byName.get('gradle-wrapper.properties') ?? []

const model = {
  buildTool: null,
  buildWrapper: null,
  packaging: null,
  javaRelease: null,
  javaReleaseSource: null,
  springVersion: null,
  springBootVersion: null,
  servletNamespace: null,
  servletApiVersion: null,
  dependencies: [],
  gradlePluginIds: [],
  nodeEngines: null,
  packageManager: null,
  frontendFramework: null,
  viteMajor: null,
  csprojTargets: [],
  dotnetDesktop: null,
  miniapp: null,
  python: null,
}

function resolveProps(text, props) {
  return text.replace(/\$\{([^}]+)\}/g, (match, key) => props[key] ?? match)
}

function parsePom(text, file) {
  const props = {}
  const propsBlock = text.match(/<properties>([\s\S]*?)<\/properties>/)
  if (propsBlock) {
    for (const match of propsBlock[1].matchAll(/<([A-Za-z0-9._-]+)>([^<]*)<\/\1>/g)) {
      props[match[1]] = match[2].trim()
    }
  }
  const packaging = text.match(/<packaging>([^<]+)<\/packaging>/)
  if (packaging) model.packaging = packaging[1].trim()

  const deps = []
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = block[1]
    const g = body.match(/<groupId>([^<]+)<\/groupId>/)
    const a = body.match(/<artifactId>([^<]+)<\/artifactId>/)
    const v = body.match(/<version>([^<]+)<\/version>/)
    const scope = body.match(/<scope>([^<]+)<\/scope>/)
    if (!a) continue
    deps.push({
      groupId: g ? g[1].trim() : '',
      artifactId: a[1].trim(),
      version: v ? resolveProps(v[1].trim(), props) : null,
      scope: scope ? scope[1].trim() : 'compile',
    })
  }
  model.dependencies.push(...deps)

  const compilerRelease = text.match(/<release>\s*([0-9]+)\s*<\/release>/)
  const compilerSource = text.match(/<source>\s*([0-9.]+)\s*<\/source>/)
  const compilerTarget = text.match(/<target>\s*([0-9.]+)\s*<\/target>/)
  const candidate = compilerRelease?.[1] || props['maven.compiler.release'] || compilerSource?.[1]
    || props['maven.compiler.source'] || compilerTarget?.[1] || props['maven.compiler.target']
    || props['java.version'] || props['jdk.version'] || props['java.source.version']
  if (candidate) {
    model.javaRelease = parseMajor(candidate)
    model.javaReleaseSource = `pom.xml 编译目标 ${candidate}`
    note(model.javaReleaseSource, file)
  }
  const springVersion = props['spring.version'] || deps.find((d) => d.groupId === 'org.springframework')?.version
  if (springVersion) model.springVersion = String(springVersion).trim()
  const bootParent = text.match(/<artifactId>spring-boot-starter-parent<\/artifactId>[\s\S]{0,200}?<version>([^<]+)</)
  const bootPlugin = deps.find((d) => d.artifactId.startsWith('spring-boot-starter'))
  const bootVersion = bootParent?.[1] || deps.find((d) => d.groupId === 'org.springframework.boot')?.version
    || (bootPlugin ? props['spring-boot.version'] : null)
  if (bootVersion) model.springBootVersion = String(bootVersion).trim()

  const servlet = deps.find((d) => d.groupId === 'jakarta.servlet' || d.groupId === 'javax.servlet')
  if (servlet) {
    model.servletNamespace = servlet.groupId.startsWith('jakarta') ? 'jakarta' : 'javax'
    model.servletApiVersion = servlet.version ? String(servlet.version).trim() : null
    note(`servlet API ${model.servletNamespace} ${model.servletApiVersion ?? ''}`.trim(), file)
  }
  if (deps.some((d) => d.artifactId === 'spring-boot-maven-plugin')) model.springBootPlugin = true
  if (/<plugin>[\s\S]*?spring-boot-maven-plugin[\s\S]*?<\/plugin>/.test(text)) model.springBootPlugin = true
}

function parseGradle(text, file) {
  const toolchain = text.match(/languageVersion\s*=\s*JavaLanguageVersion\.of\(\s*(\d+)\s*\)/)
  const compat = text.match(/sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/)
  const target = text.match(/targetCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?(\d+)/)
  const candidate = toolchain?.[1] || compat?.[1] || target?.[1]
  if (candidate) {
    model.javaRelease = Number(candidate)
    model.javaReleaseSource = `build.gradle Java 版本 ${candidate}`
    note(model.javaReleaseSource, file)
  }
  for (const match of text.matchAll(/id\s*\(?\s*['"]([A-Za-z0-9.\-]+)['"]\s*\)?(?:\s*version\s*['"]([^'"]+)['"])?/g)) {
    model.gradlePluginIds.push({ id: match[1], version: match[2] ?? null })
  }
  const boot = model.gradlePluginIds.find((p) => p.id === 'org.springframework.boot')
  if (boot?.version) model.springBootVersion = boot.version
  for (const match of text.matchAll(/(?:implementation|api|compile|runtimeOnly|providedCompile)\s*\(?\s*['"]([\w.\-]+):([\w.\-]+):?([^'"]*)['"]/g)) {
    model.dependencies.push({ groupId: match[1], artifactId: match[2], version: match[3] || null, scope: match[0].split(/[( ]/)[0] })
  }
  if (/\bwar\b/.test(text) && /apply\s+plugin\s*:\s*['"]war['"]|id\s*\(?\s*['"]war['"]/.test(text)) model.packaging = 'war'
  else if (!model.packaging) model.packaging = 'jar'
  const servlet = model.dependencies.find((d) => d.groupId === 'jakarta.servlet' || d.groupId === 'javax.servlet')
  if (servlet) {
    model.servletNamespace = servlet.groupId.startsWith('jakarta') ? 'jakarta' : 'javax'
    model.servletApiVersion = servlet.version
  }
}

if (pomFiles.length > 1) {
  const root = pomFiles.find((f) => resolve(f) === resolve(projectDir, 'pom.xml'))
  if (root) {
    parsePom(await readText(root), root)
    model.buildTool = 'maven'
    warn(`发现 ${pomFiles.length} 个 pom.xml，按根 pom.xml 解析，子模块需人工复核`)
  } else {
    warn(`发现 ${pomFiles.length} 个 pom.xml 但根目录无 pom.xml，按第一个解析`)
    parsePom(await readText(pomFiles[0]), pomFiles[0])
    model.buildTool = 'maven'
  }
} else if (pomFiles.length === 1) {
  parsePom(await readText(pomFiles[0]), pomFiles[0])
  model.buildTool = 'maven'
  note('Maven 项目', pomFiles[0])
}

if (!model.buildTool && gradleFiles.length) {
  const rootGradle = gradleFiles.find((f) => resolve(f) === resolve(projectDir, basename(f))) ?? gradleFiles[0]
  parseGradle(await readText(rootGradle), rootGradle)
  model.buildTool = 'gradle'
  note('Gradle 项目', rootGradle)
}

if (model.buildTool === 'maven') {
  const wrapper = mavenWrappers.find((f) => rel(f) === 'mvnw') ?? mavenWrappers[0]
  model.buildWrapper = wrapper ? rel(wrapper) : null
  if (!wrapper) warn('项目无 Maven wrapper（mvnw），需要全局 mvn 才能构建')
} else if (model.buildTool === 'gradle') {
  const wrapper = gradleWrappers[0]
  model.buildWrapper = wrapper ? rel(wrapper) : null
  if (wrapper) {
    const text = await readText(wrapper)
    const url = text.match(/distributionUrl\s*=\s*(.+)/)
    if (url) {
      const version = url[1].match(/gradle-([\d.]+)-(?:bin|all)\.zip/)
      if (version) model.gradleWrapperVersion = version[1]
      note(`Gradle wrapper ${model.gradleWrapperVersion ?? '版本未知'}`, wrapper)
    }
  }
  if (!model.packaging) model.packaging = 'jar'
}

// ---------- Node / 前端 ----------
const packageJson = byName.get('package.json')?.[0]
if (packageJson) {
  let pkg = {}
  try {
    pkg = JSON.parse(await readText(packageJson))
  } catch {
    warn('package.json 解析失败，按存在前端工程处理')
  }
  const engines = pkg.engines?.node
  if (engines) {
    model.nodeEngines = String(engines)
    note(`package.json engines.node=${engines}`, packageJson)
  }
  if (pkg.packageManager) model.packageManager = String(pkg.packageManager).split('@')[0]
  else if (byName.get('pnpm-lock.yaml')) model.packageManager = 'pnpm'
  else if (byName.get('yarn.lock')) model.packageManager = 'yarn'
  else model.packageManager = 'npm'
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  if (allDeps.vue) model.frontendFramework = 'vue'
  else if (allDeps.react) model.frontendFramework = 'react'
  else if (allDeps['@angular/core']) model.frontendFramework = 'angular'
  if (allDeps.vite) {
    const raw = String(allDeps.vite).replace(/^[^0-9]*/, '')
    model.viteMajor = parseMajor(raw)
    note(`vite ${allDeps.vite}`, packageJson)
  }
  if (allDeps.uniapp || allDeps['@dcloudio/uni-app']) model.frontendFramework = model.frontendFramework ?? 'uni-app'
  note('前端工程（package.json）', packageJson)
}

// ---------- .NET ----------
const csprojFiles = files.filter((f) => f.endsWith('.csproj'))
for (const csproj of csprojFiles) {
  const text = await readText(csproj)
  const targets = [...text.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)].flatMap((m) => m[1].split(';'))
  for (const target of targets) {
    const value = target.trim()
    if (value && !model.csprojTargets.includes(value)) model.csprojTargets.push(value)
  }
  if (/<UseWPF>\s*true\s*<\/UseWPF>/i.test(text)) model.dotnetDesktop = 'wpf'
  else if (/<UseWindowsForms>\s*true\s*<\/UseWindowsForms>/i.test(text)) model.dotnetDesktop = 'winforms'
  note(`.NET 目标框架 ${model.csprojTargets.join(',') || '未声明'}`, csproj)
  break
}

// ---------- 小程序 ----------
for (const candidate of ['project.config.json', 'project.private.config.json', 'app.json']) {
  const found = byName.get(candidate)
  if (found?.length) {
    model.miniapp = candidate
    note(`小程序工程（${candidate}）`, found[0])
    break
  }
}

// ---------- Python ----------
const pythonMarkers = ['requirements.txt', 'pyproject.toml', 'manage.py']
const pythonFile = pythonMarkers.map((name) => byName.get(name)?.[0]).find(Boolean)
if (pythonFile) {
  model.python = rel(pythonFile)
  note('Python 工程标记文件', pythonFile)
}

// ---------- 数据库配置 ----------
const configFiles = files.filter((file) => {
  const name = basename(file)
  if (!/\.(properties|ya?ml|xml|env|conf|ini)$/i.test(name) && !name.startsWith('.env')) return false
  const path = rel(file)
  if (/^(src\/main\/|src\/test\/)?(resources|config|conf)?\//.test(path) || path.includes('resources')) return true
  return !path.includes('node_modules')
})

const dbCandidates = []
const credentialFindings = []
const jdbcUrlRe = /(jdbc:(mysql|mariadb|postgresql|sqlserver|oracle|sqlite)[^\s"'<>,;]*)/i

function recordCredentials(file, kind, keys) {
  if (!keys.length) return
  credentialFindings.push({ file: rel(file), kind, keys, values: '<redacted>', redacted: true })
}

for (const file of configFiles) {
  const text = await readText(file)
  if (!text) continue
  const name = basename(file)

  if (/\.properties$/i.test(name) || name.startsWith('.env') || /\.ini$/i.test(name)) {
    const keys = []
    for (const line of text.split('\n')) {
      const stripped = line.trim()
      if (!stripped || stripped.startsWith('#') || stripped.startsWith('!')) continue
      const match = stripped.match(/^([^=:]+)\s*[=:]\s*(.*)$/)
      if (!match) continue
      const key = match[1].trim()
      const value = match[2].trim()
      if (/(password|passwd|pwd|secret|token)/i.test(key)) keys.push(key)
      const urlMatch = value.match(jdbcUrlRe)
      if (urlMatch) dbCandidates.push({ url: urlMatch[1], file: rel(file), kind: 'properties', key })
    }
    recordCredentials(file, 'properties', keys)
  } else if (/\.ya?ml$/i.test(name)) {
    const keys = []
    const lines = text.split('\n')
    let inDatasource = false
    for (const line of lines) {
      const stripped = line.trim()
      if (!stripped || stripped.startsWith('#')) continue
      if (/^(datasource|data-source)\s*:/i.test(stripped)) inDatasource = true
      const kv = stripped.match(/^([A-Za-z0-9._-]+)\s*:\s*(.*)$/)
      if (!kv) continue
      const key = kv[1]
      let value = kv[2].trim().replace(/^['"]|['"]$/g, '')
      if (/(password|passwd|pwd|secret|token)/i.test(key)) keys.push(key)
      if ((inDatasource && key === 'url') || key === 'url' || key === 'jdbc-url') {
        const urlMatch = value.match(jdbcUrlRe)
        if (urlMatch) dbCandidates.push({ url: urlMatch[1], file: rel(file), kind: 'yaml', key })
      }
    }
    recordCredentials(file, 'yaml', keys)
  } else if (/\.xml$/i.test(name)) {
    const keys = []
    for (const match of text.matchAll(/<property\s+([^>]*?)\/>/g)) {
      const attrs = match[1]
      const nameAttr = attrs.match(/name\s*=\s*"([^"]+)"/)
      const valueAttr = attrs.match(/value\s*=\s*"([^"]*)"/)
      if (!nameAttr) continue
      const key = nameAttr[1]
      const value = valueAttr ? valueAttr[1] : ''
      if (/(password|passwd|pwd|secret|token)/i.test(key)) keys.push(key)
      if (/\$\{|\}/.test(value)) continue // 属性占位符，不是真实值
      const urlMatch = value.match(jdbcUrlRe)
      if (urlMatch) dbCandidates.push({ url: urlMatch[1], file: rel(file), kind: 'xml', key })
    }
    recordCredentials(file, 'xml', keys)
  }
}

// 去重，保留最靠前（通常是主配置）的一条作为生效数据库。
const seenUrls = new Set()
const activeDb = []
for (const candidate of dbCandidates) {
  if (seenUrls.has(candidate.url)) continue
  seenUrls.add(candidate.url)
  activeDb.push(candidate)
}

function parseJdbc(url) {
  const result = { type: null, host: null, port: null, database: null }
  const mysql = url.match(/^jdbc:(mysql|mariadb):\/\/([^/:;?]+)(?::(\d+))?\/([^?;]+)/i)
  if (mysql) {
    result.type = mysql[1].toLowerCase() === 'mariadb' ? 'mariadb' : 'mysql'
    result.host = mysql[2]
    result.port = mysql[3] ? Number(mysql[3]) : 3306
    result.database = mysql[4]
    return result
  }
  const pg = url.match(/^jdbc:postgresql:\/\/([^/:;?]+)(?::(\d+))?\/([^?;]+)/i)
  if (pg) {
    result.type = 'postgresql'
    result.host = pg[1]
    result.port = pg[2] ? Number(pg[2]) : 5432
    result.database = pg[3]
    return result
  }
  const mssql = url.match(/^jdbc:sqlserver:\/\/([^:;]+)(?::(\d+))?;?(.*)$/i)
  if (mssql) {
    result.type = 'sqlserver'
    result.host = mssql[1]
    result.port = mssql[2] ? Number(mssql[2]) : 1433
    const db = (mssql[3] ?? '').match(/[Dd]atabase[Nn]ame=([^;]+)/)
    result.database = db ? db[1] : null
    return result
  }
  const sqlite = url.match(/^jdbc:sqlite:(.+)$/i)
  if (sqlite) {
    result.type = 'sqlite'
    result.database = sqlite[1]
    return result
  }
  const oracle = url.match(/^jdbc:oracle:thin:@([^:]+):(\d+):(.+)$/i)
  if (oracle) {
    result.type = 'oracle'
    result.host = oracle[1]
    result.port = Number(oracle[2])
    result.database = oracle[3]
    return result
  }
  return result
}

const databases = activeDb.map((candidate) => {
  const parsed = parseJdbc(candidate.url)
  return {
    type: parsed.type,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    source: candidate.file,
    sourceKind: candidate.kind,
    sourceKey: candidate.key,
    // 只输出主机/端口/库名，凭据单独记录且已脱敏。
  }
})

const driverToDb = {
  'com.mysql.cj.jdbc.Driver': 'mysql',
  'com.mysql.jdbc.Driver': 'mysql',
  'org.mariadb.jdbc.Driver': 'mariadb',
  'org.postgresql.Driver': 'postgresql',
  'com.microsoft.sqlserver.jdbc.SQLServerDriver': 'sqlserver',
  'org.sqlite.JDBC': 'sqlite',
  'oracle.jdbc.OracleDriver': 'oracle',
}
const driverArtifactToDb = [
  { re: /mysql-connector-(java|j)$/i, db: 'mysql' },
  { re: /mariadb-java-client/i, db: 'mariadb' },
  { re: /postgresql$/i, db: 'postgresql' },
  { re: /mssql-jdbc/i, db: 'sqlserver' },
  { re: /sqlite-jdbc/i, db: 'sqlite' },
  { re: /ojdbc/i, db: 'oracle' },
]

const driversInPom = []
for (const dep of model.dependencies) {
  const hit = driverArtifactToDb.find((entry) => entry.re.test(dep.artifactId))
  if (hit) driversInPom.push({ db: hit.db, groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version })
}
// ---------- 推导组件 ----------
const components = []
function addComponent(component, payload) {
  if (components.some((item) => item.component === component)) return
  components.push({ component, ...payload })
}

const isJavaProject = model.buildTool === 'maven' || model.buildTool === 'gradle'
let javaMajor = model.javaRelease
let javaReason = model.javaReleaseSource
if (!javaMajor && isJavaProject) {
  const springMajor = parseMajor(model.springVersion ?? '')
  const bootMajor = parseMajor(model.springBootVersion ?? '')
  if (bootMajor !== null && bootMajor >= 3) {
    javaMajor = 17
    javaReason = `Spring Boot ${model.springBootVersion} 要求 Java 17+`
  } else if (springMajor !== null && springMajor >= 6) {
    javaMajor = 17
    javaReason = `Spring Framework ${model.springVersion} 要求 Java 17+`
  } else if (model.servletNamespace === 'jakarta') {
    javaMajor = 17
    javaReason = 'jakarta.servlet 命名空间（Jakarta EE 9+）通常要求 Java 11+，Tomcat 10.1+ 要求 Java 11+，保守取 17'
  } else if (model.servletNamespace === 'javax') {
    javaMajor = 8
    javaReason = 'javax.servlet 命名空间通常对应 Java 8/Tomcat 9'
  }
}
if (isJavaProject) {
  addComponent('java', {
    requiredMajor: javaMajor ?? null,
    reason: javaReason ?? '存在 Java 构建文件但未找到显式编译目标，需人工确认',
    confidence: model.javaRelease ? 'explicit' : (javaMajor ? 'inferred' : 'unknown'),
  })
  addComponent(model.buildTool, {
    requiredMajor: model.buildTool === 'gradle' ? (parseMajor(model.gradleWrapperVersion ?? '') ?? null) : null,
    reason: model.buildWrapper
      ? `项目自带 ${model.buildWrapper}，优先用包装器；包装器不可用时才需要全局工具`
      : `项目无包装器，需要全局 ${model.buildTool === 'maven' ? 'mvn' : 'gradle'}`,
    wrapper: model.buildWrapper,
    confidence: 'explicit',
  })
}

// 交付类型
let deliveryType = 'unknown'
if (model.miniapp) deliveryType = 'miniapp'
else if (model.csprojTargets.length) deliveryType = 'desktop-dotnet'
else if (model.packaging === 'war') deliveryType = 'war'
else if (model.buildTool && model.packaging === 'jar') deliveryType = 'jar'
else if (packageJson && !model.buildTool) deliveryType = 'static-frontend'

// 外部 Tomcat 判定
const bootWar = model.packaging === 'war' && (model.springBootVersion !== null)
const needsTomcat = model.packaging === 'war'
let tomcatMajor = null
if (needsTomcat) {
  if (model.servletNamespace === 'jakarta') {
    const apiMajor = parseMajor(model.servletApiVersion ?? '')
    if (apiMajor !== null && apiMajor >= 6.1) tomcatMajor = 11
    else if (apiMajor !== null && apiMajor >= 6) tomcatMajor = 10
    else tomcatMajor = 10
  } else if (model.servletNamespace === 'javax') {
    tomcatMajor = 9
  }
  addComponent('tomcat', {
    requiredMajor: tomcatMajor,
    reason: bootWar
      ? `packaging=war 且使用 Spring Boot ${model.springBootVersion}；可执行 war 可能内置容器，需按实际启动方式确认是否需要外部 Tomcat`
      : `packaging=war + ${model.servletNamespace ?? 'servlet'} API ${model.servletApiVersion ?? ''} → 外部部署需要 Tomcat ${tomcatMajor ?? '?'}`,
    external: true,
    confidence: model.servletNamespace ? 'inferred' : 'unknown',
  })
}

// 数据库组件
const activeTypes = [...new Set(databases.map((db) => db.type).filter(Boolean))]
for (const type of activeTypes) {
  const db = databases.find((item) => item.type === type)
  const driver = driversInPom.find((item) => item.db === type)
  addComponent(type === 'mariadb' ? 'mysql' : type, {
    role: 'server',
    scope: db?.host && /^(localhost|127\.0\.0\.1|::1)$/i.test(db.host) ? 'local' : 'remote',
    host: db?.host ?? null,
    port: db?.port ?? null,
    database: db?.database ?? null,
    driver: driver ? `${driver.groupId}:${driver.artifactId}:${driver.version ?? ''}` : null,
    reason: `配置文件 ${db?.source ?? ''} 中的激活连接串指向 ${type}`,
    confidence: db?.host && /^(localhost|127\.0\.0\.1|::1)$/i.test(db.host) ? 'explicit' : 'explicit',
  })
}
for (const driver of driversInPom) {
  if (activeTypes.includes(driver.db)) continue
  if (driver.db === 'mariadb' && activeTypes.includes('mysql')) continue
  warn(`项目声明了 ${driver.artifactId}（${driver.db}）驱动，但生效配置里没有对应的连接串；可能只是备用或注释掉的配置，未计入必需组件`)
}

if (packageJson) {
  let nodeMajor = null
  let reason = '前端工程需要 Node'
  if (model.nodeEngines) {
    nodeMajor = parseMajor(model.nodeEngines.replace(/[^0-9.]/g, ''))
    reason = `package.json engines.node=${model.nodeEngines}`
  } else if (model.viteMajor !== null && model.viteMajor >= 5) {
    nodeMajor = 18
    reason = `vite ${model.viteMajor} 要求 Node 18+`
  } else if (model.viteMajor !== null && model.viteMajor >= 3) {
    nodeMajor = 16
    reason = `vite ${model.viteMajor} 要求 Node 16+`
  }
  addComponent('node', { requiredMajor: nodeMajor, reason, confidence: model.nodeEngines ? 'explicit' : (nodeMajor ? 'inferred' : 'unknown') })
  addComponent(model.packageManager ?? 'npm', { requiredMajor: null, reason: `包管理器：${model.packageManager ?? 'npm'}`, confidence: 'explicit' })
}

if (model.csprojTargets.length) {
  const targets = model.csprojTargets
  const frameworkTargets = targets.filter((t) => /^v?\d+\.\d+$/.test(t) || /^net4/i.test(t))
  const sdkTargets = targets.filter((t) => !frameworkTargets.includes(t))
  if (frameworkTargets.length) {
    addComponent('dotnet-framework', {
      requiredMajor: frameworkTargets.map((t) => t.replace(/^v/, '')).join(','),
      reason: `csproj 目标框架 ${frameworkTargets.join(',')} → 需要 .NET Framework 与 Visual Studio Build Tools（MSBuild）`,
      confidence: 'explicit',
    })
    addComponent('msbuild', { requiredMajor: null, reason: '构建 .NET Framework WinForms/WPF 需要 MSBuild（Visual Studio Build Tools）', confidence: 'explicit' })
  }
  if (sdkTargets.length) {
    addComponent('dotnet-sdk', {
      requiredMajor: parseMajor(sdkTargets[0]),
      reason: `csproj 目标框架 ${sdkTargets.join(',')} → 需要对应 .NET SDK`,
      confidence: 'explicit',
    })
  }
  if (model.dotnetDesktop) {
    addComponent('windows-desktop-runtime', { requiredMajor: null, reason: `${model.dotnetDesktop} 桌面程序只能在 Windows 上运行`, confidence: 'explicit' })
  }
}

if (model.miniapp) {
  addComponent('wxdevtools', { requiredMajor: null, reason: '小程序工程需要微信开发者工具编译与预览', confidence: 'explicit' })
}

if (model.python) {
  addComponent('python', { requiredMajor: null, reason: `发现 Python 工程标记 ${model.python}`, confidence: 'explicit' })
}

// 平台推断
let platform = args.platform ? String(args.platform).toUpperCase() : null
if (!platform) {
  if (model.miniapp && packageJson) platform = 'VUE_WXAPP'
  else if (model.miniapp) platform = 'WXAPP'
  else if (model.csprojTargets.length) platform = 'C_SHARP'
  else if (model.buildTool === 'maven' || model.buildTool === 'gradle') {
    if (model.springBootVersion && /^3\./.test(model.springBootVersion)) platform = 'SPRING_BOOT3'
    else if (model.springBootVersion) platform = 'SPRING_BOOT'
    else if (model.packaging === 'war') platform = 'SSM'
    else platform = 'JAVA'
  } else if (packageJson) platform = 'VUE'
}

const diagnoseComponents = components
  .map((item) => item.component)
  .filter((name) => !['dotnet-framework', 'windows-desktop-runtime', 'dotnet-sdk'].includes(name))

const result = {
  schemaVersion: 1,
  kind: 'project-requirements',
  generatedAt: nowIso(),
  project: {
    dir: projectDir,
    name: basename(projectDir),
    platform,
    deliveryType,
    packaging: model.packaging,
    springVersion: model.springVersion,
    springBootVersion: model.springBootVersion ?? null,
    servletNamespace: model.servletNamespace,
    miniapp: model.miniapp,
    dotnetTargets: model.csprojTargets,
    dotnetDesktop: model.dotnetDesktop,
  },
  build: {
    tool: model.buildTool,
    wrapper: model.buildWrapper,
    gradleWrapperVersion: model.gradleWrapperVersion ?? null,
    javaRelease: model.javaRelease,
    javaReleaseSource: model.javaReleaseSource,
  },
  frontend: packageJson ? {
    framework: model.frontendFramework,
    packageManager: model.packageManager,
    enginesNode: model.nodeEngines,
    viteMajor: model.viteMajor,
  } : null,
  components,
  diagnoseComponents,
  databases,
  databaseDrivers: driversInPom,
  credentials: credentialFindings,
  evidence,
  warnings,
}

const serialized = JSON.stringify(result, null, 2)
if (/"(password|passwd|pwd|secret|token)"\s*:\s*"(?!<redacted>)/i.test(serialized)) {
  fail('内部错误：输出中疑似包含未脱敏的凭据字段，已中止')
}
if (args.out) {
  await writeJsonFile(resolve(args.out), result)
  process.stdout.write(`${redactText(`已写入需求清单：${resolve(args.out)}`)}\n`)
}
process.stdout.write(`${serialized}\n`)

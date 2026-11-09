// 环境技能公共库：脱敏、摘要、检查点、NDJSON 解析。
// 只依赖 Node 内置模块；不读取、不打印任何真实凭据值。

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const REDACTED = '<redacted>'

// 键名命中即视为凭据：值一律替换，不进日志、不进计划、不进 JSON。
const SECRET_KEY_RE = /(pass(word|wd)?|pwd|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|superpassword|super_password)/i
// 形如 password=xxx、Pwd=xxx、"password": "xxx"、--password xxx 的片段。
const SECRET_PAIR_RE = new RegExp(
  String.raw`((?:pass(?:word|wd)?|pwd|secret|token|credential|api[_-]?key|access[_-]?key|superpassword)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}]+)`,
  'gi',
)
const SECRET_FLAG_RE = /(--?(?:password|passwd|pwd|secret|token)[\s=]+)(\S+)/gi
// 常见 JDBC/连接串里的内嵌口令。
const URI_SECRET_RE = /(\b(?:jdbc:[a-z0-9]+:(?:\/\/)?[^\s"'<>]*?(?:password|pwd)=))([^;&"'\s<>]+)/gi

export function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key ?? ''))
}

export function redactText(input) {
  let text = String(input ?? '')
  text = text.replace(URI_SECRET_RE, (_m, head) => `${head}${REDACTED}`)
  text = text.replace(SECRET_PAIR_RE, (_m, head) => `${head}${REDACTED}`)
  text = text.replace(SECRET_FLAG_RE, (_m, head) => `${head}${REDACTED}`)
  return text
}

export function redactDeep(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? REDACTED : redactDeep(item, seen)
  }
  return out
}

// 有序序列化，用于计算稳定的计划指纹。
export function canonicalJson(value) {
  const walk = (input) => {
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map(walk)
    const out = {}
    for (const key of Object.keys(input).sort()) out[key] = walk(input[key])
    return out
  }
  return JSON.stringify(walk(value))
}

export function digestOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

export async function fileDigest(file, algorithm = 'sha512') {
  const buffer = await readFile(file)
  return createHash(algorithm).update(buffer).digest('hex')
}

export function envHome() {
  return resolve(process.env.JIEMA_ENV_HOME || join(homedir(), '.local', 'jiema-env'))
}

export function checkpointPath(planDigest, actionId) {
  const short = String(planDigest).replace(/^sha256:/, '').slice(0, 12)
  return join(envHome(), 'checkpoints', short, `${sanitizeId(actionId)}.json`)
}

export function logPath(planDigest, actionId) {
  const short = String(planDigest).replace(/^sha256:/, '').slice(0, 12)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(envHome(), 'logs', short, `${sanitizeId(actionId)}-${stamp}.log`)
}

export function sanitizeId(id) {
  return String(id ?? 'action').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

export async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function readJsonFile(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

export function nowIso() {
  return new Date().toISOString()
}

// 解析诊断脚本输出：NDJSON（一行一个对象）或单个 JSON 数组/对象。
export function parseDiagnoseOutput(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && trimmed.includes('\n') && !trimmed.split('\n')[0].trim().startsWith('{"type"'))) {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    return [parsed]
  }
  const records = []
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    try {
      records.push(JSON.parse(candidate))
    } catch {
      // 非 JSON 行（人类可读提示）忽略，不中断解析。
    }
  }
  return records
}

export function parseMajor(raw) {
  const text = String(raw ?? '')
  const match = text.match(/(\d+)(?:\.(\d+))?/)
  if (!match) return null
  const first = Number(match[1])
  if (first === 1 && match[2] !== undefined) return Number(match[2])
  return first
}

export function fail(message, code = 1) {
  process.stderr.write(`${redactText(message)}\n`)
  process.exit(code)
}

export function parseArgs(argv, spec) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = (eq > -1 ? token.slice(2, eq) : token.slice(2)).trim()
    const key = name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
    if (!(key in spec)) fail(`未知参数: --${name}`)
    const type = spec[key]
    if (type === 'boolean') {
      out[key] = true
      continue
    }
    const value = eq > -1 ? token.slice(eq + 1) : argv[++i]
    if (value === undefined) fail(`参数 --${name} 缺少取值`)
    out[key] = value
  }
  return out
}

export function requireArgs(args, keys) {
  for (const key of keys) {
    if (args[key] === undefined || args[key] === '') fail(`缺少必填参数: --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
  }
}

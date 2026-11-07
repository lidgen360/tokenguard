/** Файловые утилиты: обход, размеры, безопасные пути. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const HOME = os.homedir()
const LEGACY_HOME = path.join(HOME, '.ccliner')
export const DATA_HOME = process.env.TOKENGUARD_HOME || process.env.CCLINER_HOME || path.join(HOME, '.tokenguard')

/** Однократно перенести данные из старого каталога ~/.tokenguard в ~/.tokenguard. */
export function migrateLegacyHome() {
  if (process.env.TOKENGUARD_HOME || process.env.CCLINER_HOME) return null
  try {
    if (fs.existsSync(DATA_HOME) || !fs.existsSync(LEGACY_HOME)) return null
    fs.renameSync(LEGACY_HOME, DATA_HOME)
    return DATA_HOME
  } catch {
    return null
  }
}

/** Раскрыть ~ в домашний каталог. */
export function expand(input) {
  if (!input) return input
  return input.startsWith('~') ? path.join(HOME, input.slice(1)) : input
}

export function exists(input) {
  try {
    fs.accessSync(expand(input))
    return true
  } catch {
    return false
  }
}

export function isDir(input) {
  try {
    return fs.statSync(expand(input)).isDirectory()
  } catch {
    return false
  }
}

export function readText(input) {
  return fs.readFileSync(expand(input), 'utf8')
}

export function readJson(input) {
  try {
    return JSON.parse(readText(input))
  } catch {
    return null
  }
}

export function writeFile(input, data) {
  const target = expand(input)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
  return target
}

export function mtimeMs(input) {
  try {
    return fs.statSync(expand(input)).mtimeMs
  } catch {
    return 0
  }
}

export function fileSize(input) {
  try {
    return fs.statSync(expand(input)).size
  } catch {
    return 0
  }
}

export function ensureDir(input) {
  fs.mkdirSync(expand(input), { recursive: true })
  return expand(input)
}

export function humanBytes(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = Number(bytes) || 0
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`
}

export function ageDays(ms) {
  return (Date.now() - Number(ms || 0)) / 86_400_000
}

export function timestamp(date = new Date(), withSeconds = true) {
  const pad = (n) => String(n).padStart(2, '0')
  const base = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  return withSeconds ? `${base}${pad(date.getSeconds())}` : base
}

/** Человеческое «когда»: 5 мин, 3 ч, 12 дн. */
export function timeAgo(ms) {
  if (!ms) return '—'
  const diff = Date.now() - Number(ms)
  const minute = 60_000
  if (diff < minute) return 'только что'
  if (diff < 60 * minute) return `${Math.round(diff / minute)} мин`
  if (diff < 24 * 60 * minute) return `${Math.round(diff / (60 * minute))} ч`
  if (diff < 30 * 24 * 60 * minute) return `${Math.round(diff / (24 * 60 * minute))} дн`
  if (diff < 365 * 24 * 60 * minute) return `${Math.round(diff / (30 * 24 * 60 * minute))} мес`
  return `${(diff / (365 * 24 * 60 * minute)).toFixed(1)} г`
}

export function shortId(id, length = 8) {
  return String(id).replace(/^session-/, '').slice(0, length)
}

export const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', 'out',
  '.venv', 'venv', '__pycache__', '.tmp', '.cache', 'coverage', '.idea',
  '.vscode-test', 'vendor', 'target', '.gradle', '.pnpm-store',
  'cache', 'site-packages', 'dist-info', 'outputs', 'external', 'screenshots',
])

/** Обход файлов с игнорированием шумных каталогов. */
export function* walkFiles(root, options = {}) {
  const {
    maxDepth = Infinity,
    fileFilter = () => true,
    dirFilter = () => true,
    ignore = DEFAULT_IGNORE,
  } = options
  const start = expand(root)
  const stack = [{ dir: start, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const hidden = entry.name.startsWith('.') && entry.name !== '.github'
        const venvLike = /^\.?venv/.test(entry.name)
        if (depth < maxDepth && !hidden && !venvLike && !ignore.has(entry.name) && dirFilter(full)) {
          stack.push({ dir: full, depth: depth + 1 })
        }
        continue
      }
      if (entry.isFile() && !entry.name.startsWith('.') && fileFilter(full)) yield full
    }
  }
}

/**
 * Реестр артефактов tokenguard: что инструмент создал на диске.
 * Нужен для честного «найди и удали то, что мы сделали» — без слепого rm по каталогам.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_HOME, HOME, ensureDir } from './files.js'

export function dataHome() {
  return process.env.TOKENGUARD_HOME || process.env.CCLINER_HOME || DATA_HOME
}

export function manifestFile() {
  return path.join(dataHome(), 'manifest.jsonl')
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Записать созданный артефакт. Возвращает запись или null при ошибке. */
export function recordArtifact(entry) {
  try {
    ensureDir(dataHome())
    const row = {
      id: makeId(),
      ts: Date.now(),
      kind: String(entry.kind || 'file'),
      action: String(entry.action || 'create'),
      path: entry.path ? String(entry.path) : null,
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : {},
    }
    fs.appendFileSync(manifestFile(), `${JSON.stringify(row)}\n`, 'utf8')
    return row
  } catch {
    return null
  }
}

/** Все живые записи реестра (удалённые исключены). */
export function readManifest() {
  const file = manifestFile()
  if (!fs.existsSync(file)) return []
  const deleted = new Set()
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.kind === 'deleted' && record.meta?.id) deleted.add(record.meta.id)
    else rows.push(record)
  }
  const legacyHome = `${HOME}/.ccliner`
  const currentHome = dataHome()
  return rows
    .filter((record) => !deleted.has(record.id))
    .map((record) => (record.path && record.path.startsWith(legacyHome)
      ? { ...record, path: record.path.replace(legacyHome, currentHome) }
      : record))
}

/** Пометить артефакты удалёнными (append-only журнал). */
export function markDeleted(ids) {
  if (!ids || ids.length === 0) return
  ensureDir(dataHome())
  const lines = ids.map((id) => JSON.stringify({ id: makeId(), ts: Date.now(), kind: 'deleted', action: 'delete', path: null, meta: { id } })).join('\n')
  fs.appendFileSync(manifestFile(), `${lines}\n`, 'utf8')
}

/** Размер файла/каталога рекурсивно (для отчёта). */
export function sizeOf(target) {
  try {
    const stat = fs.statSync(target)
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    let total = 0
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      total += sizeOf(path.join(target, entry.name))
    }
    return total
  } catch {
    return 0
  }
}

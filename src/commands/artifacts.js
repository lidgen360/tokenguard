/** artifacts: что создал tokenguard — посмотреть и безопасно удалить. */
import fs from 'node:fs'
import path from 'node:path'
import { dataHome, markDeleted, readManifest, sizeOf } from '../util/manifest.js'
import { humanBytes, timeAgo } from '../util/files.js'
import { printTable, info, ok, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['kind', 'older-than']

const DELETABLE = new Set(['backup', 'digest', 'lazy-proxy', 'archive', 'docs-index'])
const KIND_DIRS = [
  ['backup', 'backups'],
  ['digest', 'digests'],
  ['lazy-proxy', 'lazy'],
  ['archive', 'archive'],
]

const HELP = `${bold('tokenguard artifacts')} — реестр того, что сделал tokenguard

  tokenguard artifacts list [--kind backup|digest|lazy-proxy|archive|docs-index] [--json]
      Показать созданные артефакты, их размер и возраст.

  tokenguard artifacts clean (--all | --kind <тип> | --older-than <дней>) [--apply]
      Безопасно удалить артефакты. Без --apply — только показать.
      Удаляются только файлы внутри каталога tokenguard (~/.tokenguard).
`

export async function run(positional, flags) {
  const sub = positional[0]
  if (!sub || sub === 'list') return list(flags)
  if (sub === 'clean') return clean(flags)
  console.log(HELP)
  return 0
}

function collect(flags) {
  const rows = readManifest().map((record) => ({
    ...record,
    exists: Boolean(record.path) && fs.existsSync(record.path),
    size: record.path ? sizeOf(record.path) : 0,
  }))
  // Артефакты, созданные до появления реестра: сканируем известные каталоги.
  if (!flags.kind || flags.kind === 'unregistered') {
    for (const [kind, dirName] of KIND_DIRS) {
      const dir = path.join(dataHome(), dirName)
      if (!fs.existsSync(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        const covered = rows.some((row) => row.path === full || (row.path && full.startsWith(`${row.path}${path.sep}`)))
        if (covered) continue
        const stat = fs.statSync(full)
        rows.push({
          id: null,
          ts: stat.mtimeMs,
          kind,
          action: 'unregistered',
          path: full,
          meta: {},
          exists: true,
          size: sizeOf(full),
          unregistered: true,
        })
      }
    }
  }
  return rows
}

function filterRows(rows, flags) {
  let result = rows
  if (flags.kind) result = result.filter((row) => row.kind === flags.kind || row.action === flags.kind)
  if (flags['older-than']) {
    const days = Number(flags['older-than'])
    if (Number.isFinite(days)) {
      const threshold = Date.now() - days * 86_400_000
      result = result.filter((row) => row.ts < threshold)
    }
  }
  return result
}

function list(flags) {
  const rows = filterRows(collect(flags), flags).filter((row) => row.kind !== 'session-rename')
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2))
    return 0
  }
  const renames = readManifest().filter((record) => record.kind === 'session-rename')
  if (rows.length === 0 && renames.length === 0) {
    info('tokenguard пока ничего не создавал (или всё уже удалено)')
    return 0
  }
  if (rows.length > 0) {
    printTable(
      ['Тип', 'Размер', 'Когда', 'Действие', 'Путь'],
      rows.map((row) => [
        row.kind,
        humanBytes(row.size),
        row.ts ? timeAgo(row.ts) : '—',
        row.unregistered ? 'найден на диске' : row.action,
        row.path ? row.path.replace(dataHome(), '~/.tokenguard') : '—',
      ]),
    )
    const deletable = rows.filter((row) => DELETABLE.has(row.kind))
    const total = deletable.reduce((sum, row) => sum + row.size, 0)
    info(`всего артефактов: ${rows.length}; можно удалить: ${deletable.length} (${humanBytes(total)})`)
  }
  if (renames.length > 0) {
    info(`переименований сессий: ${renames.length} (не удаляются; бэкапы лежат в ~/.tokenguard/backups)`)
  }
  return 0
}

function clean(flags) {
  const rows = filterRows(collect(flags), flags).filter((row) => DELETABLE.has(row.kind) && row.exists)
  if (!flags.all && !flags.kind && !flags['older-than']) {
    warn('укажи --all, --kind <тип> или --older-than <дней> — чтобы не удалить лишнее')
    return 1
  }
  if (rows.length === 0) {
    ok('нечего удалять')
    return 0
  }
  const total = rows.reduce((sum, row) => sum + row.size, 0)
  if (!flags.apply) {
    info(`dry-run: будет удалено ${rows.length} артефактов (${humanBytes(total)}):`)
    for (const row of rows.slice(0, 50)) console.log(`  • [${row.kind}] ${row.path.replace(dataHome(), '~/.tokenguard')} — ${humanBytes(row.size)}`)
    info('добавь --apply, чтобы выполнить')
    return 0
  }
  const base = path.resolve(dataHome())
  let freed = 0
  let deleted = 0
  const deletedIds = []
  for (const row of rows) {
    const target = path.resolve(row.path)
    if (!(target === base || target.startsWith(`${base}${path.sep}`))) {
      warn(`пропущено (вне каталога tokenguard): ${row.path}`)
      continue
    }
    try {
      if (fs.statSync(target).isDirectory()) fs.rmSync(target, { recursive: true, force: true })
      else fs.rmSync(target)
      freed += row.size
      deleted += 1
      if (row.id) deletedIds.push(row.id)
    } catch (error) {
      warn(`не удалось удалить ${row.path}: ${error.message}`)
    }
  }
  if (deletedIds.length > 0) markDeleted(deletedIds)
  ok(`удалено артефактов: ${deleted}, освобождено ${humanBytes(freed)}`)
  return 0
}

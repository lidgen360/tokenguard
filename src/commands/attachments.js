/** attachments: аудит и безопасная очистка вложений DSH (~/.dsh/attachments). */
import fs from 'node:fs'
import path from 'node:path'
import { HOME, ageDays, exists, humanBytes, timeAgo, timestamp } from '../util/files.js'
import { readCompressedText } from '../util/zstd.js'
import { recordArtifact } from '../util/manifest.js'
import { bold, info, ok, printTable, warn } from '../log.js'

export const VALUE_FLAGS = ['older-than']

const DEFAULT_OLDER_THAN_DAYS = 14
/** 64-символьный hex-хэш вложения; края без hex — чтобы не цеплять куски длинных строк. */
const HASH_PATTERN = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g
const SESSION_FILE_PATTERN = /^session\.v4\.jsonl(?:\.zstd)?$/
const HEX_DIR_PATTERN = /^[0-9a-f]{2}$/i
const HASH_FILE_PATTERN = /^[0-9a-f]{64}$/i

const HELP = `${bold('tokenguard attachments')} — вложения DSH: аудит и очистка

  tokenguard attachments list [--json]
      Объекты вложений DSH: сколько файлов и места, что осиротело, что самое старое.

  tokenguard attachments clean [--older-than <дней>] [--apply] [--json]
      Удалить только осиротевшие объекты старше N дней (по умолчанию ${DEFAULT_OLDER_THAN_DAYS}).
      Без --apply — dry-run: показывает, что будет удалено, и ничего не трогает.

  Объекты: ~/.dsh/attachments/v1/objects/<2hex>/<64hex>
  Сессии:  ~/.dsh/sessions/**/session.v4.jsonl.zstd
`

/** Каталог объектов вложений DSH по умолчанию. */
function defaultObjectsRoot() {
  return process.env.TOKENGUARD_ATTACHMENTS_ROOT || path.join(HOME, '.dsh', 'attachments', 'v1', 'objects')
}

/** Каталог сессий DSH по умолчанию. */
function defaultSessionsRoot() {
  return process.env.TOKENGUARD_DSH_SESSIONS_ROOT || path.join(HOME, '.dsh', 'sessions')
}

/** Понять, какой каталог передан: .../attachments, .../v1 или уже .../objects. */
function resolveObjectsRoot(input) {
  const base = path.resolve(input || defaultObjectsRoot())
  if (path.basename(base) === 'objects') return base
  for (const candidate of [path.join(base, 'v1', 'objects'), path.join(base, 'objects')]) {
    if (exists(candidate)) return candidate
  }
  return base
}

/** Все файлы сессий DSH под каталогом (рекурсивно, без символических ссылок). */
function collectSessionFiles(root) {
  const files = []
  const stack = [path.resolve(root)]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && SESSION_FILE_PATTERN.test(entry.name)) files.push(full)
    }
  }
  return files.sort()
}

/** Текст сессии: zstd (CLI/нативный zlib), иначе — как обычный текст. */
function readSessionText(file) {
  if (!file.endsWith('.zstd')) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  try {
    return readCompressedText(file)
  } catch {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
}

/** Объекты вложений: только <2hex>/<64hex>, отсортированы от старых к новым. */
function readObjects(objectsDir) {
  const objects = []
  let entries
  try {
    entries = fs.readdirSync(objectsDir, { withFileTypes: true })
  } catch {
    return objects
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !HEX_DIR_PATTERN.test(entry.name)) continue
    const bucket = path.join(objectsDir, entry.name)
    let files
    try {
      files = fs.readdirSync(bucket, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !HASH_FILE_PATTERN.test(file.name)) continue
      const full = path.join(bucket, file.name)
      try {
        const stat = fs.statSync(full)
        objects.push({ hash: file.name.toLowerCase(), path: full, size: stat.size, mtime: stat.mtimeMs })
      } catch {
        /* объект мог исчезнуть во время сканирования */
      }
    }
  }
  return objects.sort((left, right) => left.mtime - right.mtime)
}

/**
 * Чистое сканирование: объекты вложений и ссылки на них в сессиях DSH.
 * Ничего не меняет на диске; используется командой и тестами.
 * @param {{ attachmentsRoot?: string, sessionsRoot?: string }} [options]
 * @returns {object} объекты, сессии и сводка (total, orphans, oldest, …)
 */
export function scanData({ attachmentsRoot, sessionsRoot } = {}) {
  const objectsDir = resolveObjectsRoot(attachmentsRoot)
  const sessionsDir = path.resolve(sessionsRoot || defaultSessionsRoot())
  const attachmentsStatus = exists(objectsDir) ? 'ok' : 'skip'
  const sessionsStatus = exists(sessionsDir) ? 'ok' : 'skip'

  const referenced = new Set()
  let sessionCount = 0
  let sessionBytes = 0
  let unreadable = 0
  if (sessionsStatus === 'ok') {
    for (const file of collectSessionFiles(sessionsDir)) {
      const text = readSessionText(file)
      if (text === null) {
        unreadable += 1
        continue
      }
      sessionCount += 1
      try {
        sessionBytes += fs.statSync(file).size
      } catch {
        /* файл мог исчезнуть */
      }
      for (const match of text.matchAll(HASH_PATTERN)) referenced.add(match[0].toLowerCase())
    }
  }
  // Если сессии прочитать не удалось, ссылки неизвестны: осиротевшими не считаем.
  const referencesKnown = sessionsStatus === 'ok' && unreadable === 0

  const objects = attachmentsStatus === 'ok' ? readObjects(objectsDir) : []
  for (const object of objects) {
    object.referenced = referencesKnown ? referenced.has(object.hash) : null
  }
  const orphans = referencesKnown ? objects.filter((object) => object.referenced === false) : []
  const totalBytes = objects.reduce((sum, object) => sum + object.size, 0)
  const orphanBytes = orphans.reduce((sum, object) => sum + object.size, 0)
  const oldest = objects[0] ?? null

  return {
    attachmentsRoot: objectsDir,
    sessionsRoot: sessionsDir,
    attachmentsStatus,
    sessionsStatus,
    referencesKnown,
    sessions: {
      files: sessionCount,
      bytes: sessionBytes,
      hashes: referenced.size,
      unreadable,
    },
    objects,
    summary: {
      total: objects.length,
      totalBytes,
      orphans: referencesKnown ? orphans.length : null,
      orphanBytes: referencesKnown ? orphanBytes : null,
      oldest: oldest
        ? {
          hash: oldest.hash,
          size: oldest.size,
          mtime: oldest.mtime,
          ageDays: Math.round(ageDays(oldest.mtime) * 10) / 10,
        }
        : null,
    },
  }
}

function publicObject(object) {
  return {
    hash: object.hash,
    path: object.path,
    size: object.size,
    mtime: object.mtime,
    ageDays: Math.round(ageDays(object.mtime) * 10) / 10,
  }
}

function list(flags) {
  const data = scanData()
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2))
    return 0
  }
  if (data.attachmentsStatus === 'skip') {
    info(`вложения DSH не найдены: ${data.attachmentsRoot} — пропуск`)
    return 0
  }
  const { summary } = data
  if (summary.total === 0) {
    ok(`вложений нет (${data.attachmentsRoot})`)
    return 0
  }
  if (!data.referencesKnown) {
    const reason = data.sessionsStatus === 'skip'
      ? `каталог сессий не найден: ${data.sessionsRoot}`
      : `часть сессий не читается (файлов: ${data.sessions.unreadable})`
    warn(`ссылки на вложения проверить не удалось (${reason})`)
  }
  const orphans = data.objects.filter((object) => object.referenced === false).reverse()
  if (orphans.length > 0) {
    printTable(
      ['Хэш', 'Размер', 'Возраст', 'Путь'],
      orphans.slice(0, 50).map((object) => [
        object.hash.slice(0, 12),
        humanBytes(object.size),
        timeAgo(object.mtime),
        path.relative(data.attachmentsRoot, object.path),
      ]),
    )
    if (orphans.length > 50) info(`…и ещё осиротевших: ${orphans.length - 50}`)
  } else if (data.referencesKnown) {
    ok('осиротевших вложений нет')
  }
  const orphanLabel = summary.orphans === null ? '—' : `${summary.orphans} (${humanBytes(summary.orphanBytes)})`
  info(`всего объектов: ${summary.total} (${humanBytes(summary.totalBytes)}); осиротевших: ${orphanLabel}`)
  if (summary.oldest) {
    info(`самый старый: ${summary.oldest.hash.slice(0, 12)} — ${timeAgo(summary.oldest.mtime)} (${summary.oldest.ageDays} дн.)`)
  }
  info(`сессий прочитано: ${data.sessions.files}, хэшей-ссылок: ${data.sessions.hashes}`)
  return 0
}

/** Удалить объекты, не выходя за пределы каталога вложений. */
function deleteObjects(objectsRoot, candidates) {
  const base = path.resolve(objectsRoot)
  const hashes = []
  let freed = 0
  for (const object of candidates) {
    const target = path.resolve(object.path)
    if (!target.startsWith(`${base}${path.sep}`)) {
      warn(`пропущено (вне каталога вложений): ${object.path}`)
      continue
    }
    try {
      if (!fs.lstatSync(target).isFile()) {
        warn(`пропущено (не обычный файл): ${object.path}`)
        continue
      }
      fs.rmSync(target)
      freed += object.size
      hashes.push(object.hash)
    } catch (error) {
      warn(`не удалось удалить ${object.path}: ${error.message}`)
    }
  }
  return { count: hashes.length, freed, hashes }
}

/** Убрать опустевшие 2hex-каталоги (только непустые не трогаем). */
function pruneEmptyBuckets(objectsRoot) {
  const base = path.resolve(objectsRoot)
  let pruned = 0
  let entries
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !HEX_DIR_PATTERN.test(entry.name)) continue
    try {
      fs.rmdirSync(path.join(base, entry.name))
      pruned += 1
    } catch {
      /* каталог не пуст — оставляем */
    }
  }
  return pruned
}

function clean(flags) {
  const days = flags['older-than'] === undefined ? DEFAULT_OLDER_THAN_DAYS : Number(flags['older-than'])
  if (!Number.isFinite(days) || days < 0) {
    warn('--older-than должен быть числом дней (0 или больше)')
    return 1
  }
  const data = scanData()
  if (data.attachmentsStatus === 'skip') {
    info(`вложения DSH не найдены: ${data.attachmentsRoot} — пропуск`)
    return 0
  }
  if (!data.referencesKnown) {
    warn('не удалось достоверно прочитать сессии DSH — удаление отменено (ничего не тронуто)')
    return 0
  }
  const candidates = data.objects
    .filter((object) => object.referenced === false && ageDays(object.mtime) > days)
    .sort((left, right) => left.mtime - right.mtime)
  const candidateBytes = candidates.reduce((sum, object) => sum + object.size, 0)

  if (!flags.apply) {
    if (flags.json) {
      console.log(JSON.stringify({
        dryRun: true,
        olderThanDays: days,
        count: candidates.length,
        bytes: candidateBytes,
        candidates: candidates.map(publicObject),
      }, null, 2))
      return 0
    }
    if (candidates.length === 0) {
      ok(`нечего удалять: осиротевших объектов старше ${days} дн. нет`)
      return 0
    }
    info(`dry-run: будет удалено ${candidates.length} объектов (${humanBytes(candidateBytes)}) — осиротевшие старше ${days} дн.:`)
    for (const object of candidates.slice(0, 50)) {
      console.log(`  • ${path.relative(data.attachmentsRoot, object.path)} — ${humanBytes(object.size)}, ${timeAgo(object.mtime)}`)
    }
    if (candidates.length > 50) info(`…и ещё ${candidates.length - 50}`)
    info('добавь --apply, чтобы удалить (без --apply ничего не меняется)')
    return 0
  }

  const removed = deleteObjects(data.attachmentsRoot, candidates)
  const pruned = pruneEmptyBuckets(data.attachmentsRoot)
  if (removed.count > 0) {
    recordArtifact({
      kind: 'attachment-clean',
      action: 'delete',
      path: data.attachmentsRoot,
      meta: {
        olderThanDays: days,
        deleted: removed.count,
        freedBytes: removed.freed,
        prunedDirs: pruned,
        hashes: candidates.slice(0, 50).map((object) => object.hash),
        at: timestamp(),
      },
    })
  }
  if (flags.json) {
    console.log(JSON.stringify({
      dryRun: false,
      olderThanDays: days,
      count: removed.count,
      freedBytes: removed.freed,
      prunedDirs: pruned,
      deleted: removed.hashes,
    }, null, 2))
    return 0
  }
  ok(`удалено объектов: ${removed.count}, освобождено ${humanBytes(removed.freed)}, подчищено пустых каталогов: ${pruned}`)
  return 0
}

export async function run(positional, flags = {}) {
  const sub = positional[0]
  if (!sub || sub === 'list') return list(flags)
  if (sub === 'clean') return clean(flags)
  console.log(HELP)
  return 0
}

/** docs: индекс Markdown-документации и поиск противоречий. */
import path from 'node:path'
import fs from 'node:fs'
import { walkFiles, exists, humanBytes, ageDays, mtimeMs, fileSize, readText, writeFile, timeAgo } from '../util/files.js'
import { parseMarkdown, normalizeText, isLocalLink, slugifyHeading } from '../util/md.js'
import { recordArtifact } from '../util/manifest.js'
import { printTable, info, ok, warn, bold, dim } from '../log.js'

export const VALUE_FLAGS = ['root', 'out', 'min-age', 'limit']

const HELP = `${bold('tokenguard docs')} — порядок в Markdown

  tokenguard docs index [--root <dir>] [--write] [--json]
      Построить INDEX.md: заголовки, краткие описания, дубли, осиротевшие
      и устаревшие документы.

  tokenguard docs check [--root <dir>] [--json] [--strict]
      Проверить документацию: битые ссылки, противоречащие значения,
      дубли текста/заголовков, устаревшие «актуально на», конфликты статусов.
`

export async function run(positional, flags) {
  const sub = positional[0]
  if (!sub || sub === 'index') return indexCommand(flags)
  if (sub === 'check') return checkCommand(flags)
  console.log(HELP)
  return 0
}

function rootDir(flags) {
  return path.resolve(flags.root ? String(flags.root) : process.cwd())
}

const RUNTIME_PREFIXES = [
  'api/data/', 'saas/data/', 'outputs/', 'images/', 'docs/screenshots/',
  '.tmp/', 'node_modules/', 'external/', 'comfy/', 'Личное/',
]

export function loadDocs(root) {
  const docs = []
  const files = [...walkFiles(root, { fileFilter: (file) => file.toLowerCase().endsWith('.md'), maxDepth: 12 })].sort()
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (RUNTIME_PREFIXES.some((prefix) => relative.startsWith(prefix))) continue
    let text
    try {
      text = readText(file)
    } catch {
      continue
    }
    const parsed = parseMarkdown(text)
    docs.push({
      file,
      relative: path.relative(root, file),
      text,
      parsed,
      bytes: fileSize(file),
      mtime: mtimeMs(file),
    })
  }
  return docs
}

function localTargets(doc, docsByPath) {
  const dir = path.dirname(doc.file)
  const targets = []
  for (const link of doc.parsed.links) {
    if (!isLocalLink(link.href)) continue
    const withoutAnchor = link.href.split('#')[0].split('?')[0]
    if (!withoutAnchor) continue
    const target = path.resolve(dir, withoutAnchor)
    targets.push({ target, line: link.line, href: link.href })
  }
  return targets
}

/** Данные для индекса. */
export function indexData(root) {
  const docs = loadDocs(root)
  const docsByPath = new Map(docs.map((doc) => [doc.file, doc]))
  const titles = new Map()
  const referenced = new Set()
  for (const doc of docs) {
    const key = normalizeText(doc.parsed.title || path.basename(doc.file))
    if (key) titles.set(key, [...(titles.get(key) ?? []), doc])
    for (const link of localTargets(doc)) referenced.add(link.target)
  }
  const entries = docs
    .filter((doc) => path.basename(doc.file) !== 'INDEX.md')
    .map((doc) => {
      const summary = (doc.parsed.paragraphs[0] ?? '').replace(/\s+/g, ' ').slice(0, 160)
      const stale = ageDays(doc.mtime) > 90
      const orphan = !referenced.has(doc.file) && !/^README\.md$/i.test(path.basename(doc.file))
      return {
        file: doc.file,
        relative: doc.relative,
        title: doc.parsed.title || path.basename(doc.file, '.md'),
        summary,
        headings: doc.parsed.headings.length,
        bytes: doc.bytes,
        mtime: doc.mtime,
        stale,
        orphan,
        duplicateTitle: (titles.get(normalizeText(doc.parsed.title || path.basename(doc.file))) ?? []).length > 1,
      }
    })
  return { root, entries }
}

function renderIndex(data) {
  const lines = []
  lines.push('# Индекс документации')
  lines.push('')
  lines.push(`Дата: ${new Date().toISOString().slice(0, 10)}. Корень: \`${data.root}\`. Документов: ${data.entries.length}.`)
  lines.push('')
  lines.push('## Документы')
  lines.push('')
  lines.push('| Документ | Заголовок | О чём | Обновлён |')
  lines.push('|---|---|---|---|')
  for (const entry of data.entries) {
    const mark = entry.stale ? ' ⏳' : ''
    const orphan = entry.orphan ? ' 🔗' : ''
    lines.push(`| [${entry.relative}](${encodeURI(entry.relative)})${orphan} | ${escapeCell(entry.title)}${mark} | ${escapeCell(entry.summary)} | ${new Date(entry.mtime).toISOString().slice(0, 10)} |`)
  }
  const stale = data.entries.filter((entry) => entry.stale)
  const orphans = data.entries.filter((entry) => entry.orphan)
  const duplicates = data.entries.filter((entry) => entry.duplicateTitle)
  lines.push('')
  lines.push('## Требует внимания')
  lines.push('')
  if (duplicates.length > 0) {
    lines.push('**Дубли названий:**')
    for (const entry of duplicates) lines.push(`- ${entry.relative} — «${entry.title}»`)
    lines.push('')
  }
  if (stale.length > 0) {
    lines.push('**Давно не обновлялись (>90 дней):**')
    for (const entry of stale.slice(0, 30)) lines.push(`- ${entry.relative} — ${timeAgo(entry.mtime)}`)
    lines.push('')
  }
  if (orphans.length > 0) {
    lines.push('**Осиротевшие (на них никто не ссылается):**')
    for (const entry of orphans.slice(0, 30)) lines.push(`- ${entry.relative}`)
    lines.push('')
  }
  if (duplicates.length === 0 && stale.length === 0 && orphans.length === 0) lines.push('Всё чисто.')
  lines.push('')
  lines.push('_Сгенерировано tokenguard. Ссылки проверяй командой `tokenguard docs check`._')
  return `${lines.join('\n')}\n`
}

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ')
}

function indexCommand(flags) {
  const root = rootDir(flags)
  const data = indexData(root)
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2))
    return 0
  }
  if (data.entries.length === 0) {
    warn(`Markdown-файлы не найдены в ${root}`)
    return 0
  }
  if (flags.write) {
    const outFile = flags.out ? path.resolve(String(flags.out)) : path.join(root, 'INDEX.md')
    writeFile(outFile, renderIndex(data))
    recordArtifact({ kind: 'docs-index', action: 'create', path: outFile, meta: { docs: data.entries.length } })
    ok(`индекс: ${outFile}`)
  }
  printTable(
    ['Документ', 'Заголовок', 'Обновлён', 'Статус'],
    data.entries.slice(0, Number(flags.limit ?? 100)).map((entry) => [
      entry.relative,
      entry.title.slice(0, 44),
      timeAgo(entry.mtime),
      [entry.duplicateTitle ? 'дубль' : '', entry.stale ? 'устарел' : '', entry.orphan ? 'осиротел' : ''].filter(Boolean).join(', ') || 'ок',
    ]),
  )
  info(`документов: ${data.entries.length}; добавь --write, чтобы сохранить INDEX.md`)
  return 0
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 }

/** Найти противоречия и проблемы в документации. */
export function checkData(root) {
  const docs = loadDocs(root)
  const findings = []
  const add = (severity, rule, doc, line, message) => {
    findings.push({ severity, rule, file: path.relative(root, doc.file), line, message })
  }

  // 1. битые локальные ссылки
  for (const doc of docs) {
    for (const link of localTargets(doc)) {
      if (!exists(link.target)) add('high', 'broken-link', doc, link.line, `ссылка на несуществующий файл: ${link.href}`)
    }
    for (const link of doc.parsed.links) {
      if (!link.href.startsWith('#')) continue
      const slug = link.href.slice(1)
      const slugs = doc.parsed.headings.map((heading) => slugifyHeading(heading.text))
      if (slug && !slugs.includes(slug)) add('low', 'broken-anchor', doc, link.line, `якорь не найден в этом файле: ${link.href}`)
    }
  }

  // 2. дубли заголовков
  const headingMap = new Map()
  for (const doc of docs) {
    for (const heading of doc.parsed.headings) {
      const key = normalizeText(heading.text)
      if (key.length < 14) continue
      if (GENERIC_HEADINGS.has(key)) continue
      headingMap.set(key, [...(headingMap.get(key) ?? []), { doc, heading }])
    }
  }
  for (const group of headingMap.values()) {
    const files = new Set(group.map((item) => item.doc.file))
    if (files.size < 2) continue
    const first = group[0]
    const others = [...files].filter((file) => file !== first.doc.file).slice(0, 3).map((file) => path.relative(root, file))
    add('low', 'duplicate-heading', first.doc, first.heading.line, `заголовок «${first.heading.text}» повторяется в ${files.size} файлах, например: ${others.join(', ')}`)
  }

  // 3. противоречащие значения (порты, версии, ключи)
  const values = new Map()
  const valuePattern = /(?:^|[\s"'`=(])([A-Za-z_][A-Za-z0-9_]{1,30})\s*[:=]\s*["']?([0-9]+(?:\.[0-9]+){0,3})["']?(?=[\s,;)]|$)/g
  const IGNORED_KEYS = new Set(['active', 'version', 'ver', 'v', 'count', 'total', 'size', 'id'])
  for (const doc of docs) {
    doc.text.split('\n').forEach((lineText, index) => {
      for (const match of lineText.matchAll(valuePattern)) {
        const key = match[1]
        const value = match[2]
        if (IGNORED_KEYS.has(key.toLowerCase())) continue
        const entry = values.get(key) ?? new Map()
        entry.set(value, [...(entry.get(value) ?? []), { doc, line: index + 1 }])
        values.set(key, entry)
      }
    })
  }
  let conflicts = 0
  for (const [key, entry] of values) {
    if (entry.size < 2 || conflicts >= 25) continue
    const occurrences = [...entry.values()].flat()
    if (occurrences.length < 2) continue
    conflicts += 1
    const summary = [...entry.entries()].map(([value, list]) => `${value} (${list.map((item) => `${item.doc.relative}:${item.line}`).join(', ')})`).join(' vs ')
    add('medium', 'conflicting-value', occurrences[0].doc, occurrences[0].line, `«${key}» встречается с разными значениями: ${summary}`)
  }

  // 4. конфликт статусов внутри одного документа
  for (const doc of docs) {
    const done = /(статус|status)[^\n]{0,40}(выполнен|готов|done|завершен|закрыт)/i.test(doc.text)
    const open = /(TODO|FIXME|в работе|не сделано|не завершен|открыт)/i.test(doc.text)
    if (done && open) add('low', 'status-conflict', doc, 1, 'в документе одновременно «выполнено/готово» и «TODO/в работе»')
  }

  // 5. «актуально на» устарело
  for (const doc of docs) {
    const match = /(актуально|по состоянию)\s+на\s+(\d{1,2})[.\s/-](\d{1,2})[.\s/-](\d{4})/i.exec(doc.text)
    if (!match) continue
    const date = new Date(Number(match[4]), Number(match[3]) - 1, Number(match[2]))
    if (Number.isFinite(date.getTime()) && ageDays(date.getTime()) > 120) {
      const line = doc.text.slice(0, match.index).split('\n').length
      add('medium', 'stale-actual', doc, line, `«${match[1]} на ${match[2]}.${match[3]}.${match[4]}» — старше 120 дней`)
    }
  }

  // 6. повторяющиеся абзацы
  const paragraphs = new Map()
  for (const doc of docs) {
    for (const paragraph of doc.parsed.paragraphs) {
      const key = normalizeText(paragraph)
      if (key.length < 200) continue
      paragraphs.set(key, [...(paragraphs.get(key) ?? []), doc])
    }
  }
  for (const group of paragraphs.values()) {
    const files = new Set(group.map((doc) => doc.file))
    if (files.size < 2) continue
    const [first, second] = group
    add('medium', 'duplicate-paragraph', second, 1, `абзац (${normalizeText(second.parsed.paragraphs[0] ?? '').length} симв.) повторяется в ${files.size} файлах, например ${first.relative}`)
  }

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line)
  const counts = findings.reduce((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1
    return acc
  }, {})
  return { root, docs: docs.length, findings, counts }
}

function checkCommand(flags) {
  const root = rootDir(flags)
  const data = checkData(root)
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2))
    return flags.strict && data.counts.high > 0 ? 1 : 0
  }
  if (data.docs === 0) {
    warn(`Markdown-файлы не найдены в ${root}`)
    return 0
  }
  if (data.findings.length === 0) {
    ok(`проверено документов: ${data.docs}; проблем не найдено`)
    return 0
  }
  const icons = { high: '✖', medium: '▲', low: '·' }
  for (const finding of data.findings) {
    const line = finding.line ? `:${finding.line}` : ''
    console.log(`${icons[finding.severity]} [${finding.rule}] ${finding.file}${line} — ${finding.message}`)
  }
  info(`документов: ${data.docs}; проблем: ${data.findings.length} (высоких: ${data.counts.high ?? 0}, средних: ${data.counts.medium ?? 0}, низких: ${data.counts.low ?? 0})`)
  if (flags.strict && (data.counts.high ?? 0) > 0) return 1
  return 0
}

const GENERIC_HEADINGS = new Set([
  'ограничения', 'запуск', 'состав', 'пример', 'примеры', 'использование', 'конфигурация',
  'структура', 'описание', 'возможности', 'установка', 'проверка', 'результат', 'результаты',
])

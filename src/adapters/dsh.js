/** Адаптер DeepSeek Harness (DSH): сессии session.v4.jsonl.zstd. */
import fs from 'node:fs'
import path from 'node:path'
import { readCompressedText, writeCompressedText } from '../util/zstd.js'
import { backupPaths } from '../util/backup.js'
import { HOME, exists, walkFiles, mtimeMs, fileSize, shortId } from '../util/files.js'

export const id = 'dsh'
export const label = 'DeepSeek Harness'
export const SESSIONS_ROOT = path.join(HOME, '.dsh', 'sessions')
export const CACHE_ROOT = path.join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
export const TITLE_LIMIT_BYTES = 80
export const LIVE_WINDOW_MS = 120_000

const INTERNAL_MESSAGE_PATTERNS = [
  /^The user changed the approval policy/,
  /Current runtime context\. This snapshot/,
  /^Time sampled while preparing/,
  /^Browser time zone for this request/,
  /^Background subagent /,
  /^Agent [0-9a-f-]{8,} sent a message/,
  /^background job /,
]

export function detect() {
  return exists(SESSIONS_ROOT)
}

export function isInternalMessage(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return true
  return INTERNAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(clean))
}

/** Все файлы событий (верхнеуровневые и субагентские). */
export function* sessionFiles(root = SESSIONS_ROOT) {
  if (!exists(root)) return
  yield* walkFiles(root, {
    fileFilter: (file) => file.endsWith('.jsonl.zstd') && path.basename(file).startsWith('session.v4'),
  })
}

function parseEvents(file) {
  const events = []
  for (const line of readCompressedText(file).split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* повреждённую строку пропускаем, как и recoverable-декодер харнесса */
    }
  }
  return events
}

function messageText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function summarize(file, events) {
  const header = events.find((event) => event.type === 'session') ?? {}
  let title = ''
  let lastTime = Number(header.createdAt) || 0
  let userCount = 0
  let toolCount = 0
  let promptTokens = 0
  let outputTokens = 0
  for (const event of events) {
    if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
    if (event.type === 'session/title') {
      const value = event.data?.title
      if (typeof value === 'string' && value.trim()) title = value.trim()
    } else if (event.type === 'user/message') {
      userCount += 1
    } else if (event.type === 'tool/call') {
      toolCount += 1
    } else if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage) {
        promptTokens += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
        outputTokens += usage.outputTokens ?? 0
      }
    }
  }
  return {
    client: id,
    id: header.id ?? path.basename(path.dirname(file)),
    file,
    cwd: header.cwd ?? '',
    createdAt: Number(header.createdAt) || 0,
    origin: header.origin ?? 'user',
    parent: header.parentSession ?? null,
    title: title || '(без названия)',
    role: header.origin === 'subagent' ? 'subagent' : 'chat',
    lastTime,
    bytes: fileSize(file),
    userCount,
    toolCount,
    promptTokens,
    outputTokens,
  }
}

/** Список сессий со сводкой (без полной истории в памяти дольше одного файла). */
export function listSessions(options = {}) {
  const { root = SESSIONS_ROOT, includeSubagents = false } = options
  const result = []
  for (const file of sessionFiles(root)) {
    let events
    try {
      events = parseEvents(file)
    } catch {
      continue
    }
    if (events.length === 0) continue
    const summary = summarize(file, events)
    if (!includeSubagents && summary.role === 'subagent') continue
    result.push(summary)
  }
  result.sort((a, b) => b.lastTime - a.lastTime)
  return result
}

/** Найти сессию по id, префиксу или порядковому номеру в списке. */
export function resolveSession(ref, options = {}) {
  const sessions = listSessions({ ...options, includeSubagents: true })
  const needle = String(ref ?? '').trim()
  if (!needle) return null
  if (/^\d+$/.test(needle)) {
    const chatSessions = sessions.filter((session) => session.role === 'chat')
    const index = Number(needle) - 1
    return chatSessions[index] ?? null
  }
  const exact = sessions.find((session) => session.id === needle)
  if (exact) return exact
  const matches = sessions.filter((session) => session.id.replace(/^session-/, '').startsWith(needle.replace(/^session-/, '')))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) return { ambiguous: matches }
  return null
}

export function getEvents(session) {
  return parseEvents(session.file)
}

function truncateUtf8(text, limitBytes) {
  let result = ''
  let used = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char, 'utf8')
    if (used + bytes > limitBytes) break
    result += char
    used += bytes
  }
  return result
}

export function normalizeTitle(title) {
  const clean = String(title ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateUtf8(clean, TITLE_LIMIT_BYTES)
}

/** Безопасно переименовать сессию: бэкап + событие session/title (source: user). */
export function renameSession(session, rawTitle, options = {}) {
  const { force = false, liveWindowMs = LIVE_WINDOW_MS } = options
  const title = normalizeTitle(rawTitle)
  if (!title) throw new Error('пустое название после нормализации')
  if (!force && Date.now() - mtimeMs(session.file) < liveWindowMs) {
    throw new Error('сессия изменялась меньше 2 минут назад — похоже, она активна. Перезапусти с --force, если уверен')
  }
  const events = getEvents(session)
  const maxSeq = events.reduce((max, event) => (typeof event.seq === 'number' && event.seq > max ? event.seq : max), -1)
  const raw = readCompressedText(session.file)
  const backup = backupPaths([session.file], `session-${shortId(session.id)}`)
  const event = {
    type: 'session/title',
    seq: maxSeq + 1,
    time: Date.now(),
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }
  const text = `${raw.endsWith('\n') ? raw : `${raw}\n`}${JSON.stringify(event)}\n`
  writeCompressedText(session.file, text)
  const cache = path.join(CACHE_ROOT, `${session.id}.json`)
  try {
    fs.rmSync(cache)
  } catch {
    /* кэша может не быть */
  }
  return { title, backup, seq: event.seq, bytes: Buffer.byteLength(title, 'utf8') }
}

/** Извлечь материал для конспекта: запросы пользователя, файлы, команды. */
export function extractDigest(session) {
  const events = getEvents(session)
  const summary = summarize(session.file, events)
  const userRequests = []
  const files = new Map()
  const commands = []
  const assistantTexts = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = messageText(event.data?.content)
      if (!isInternalMessage(text)) userRequests.push({ time: event.time ?? 0, text: text.trim() })
    } else if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message?.content ?? event.data?.content)
      if (text.trim()) assistantTexts.push({ time: event.time ?? 0, text: text.trim() })
    } else if (event.type === 'tool/call') {
      const name = event.data?.name ?? event.data?.tool ?? ''
      const args = parseArguments(event.data?.arguments ?? event.data?.input ?? {})
      if (name === 'write' || name === 'edit') {
        const file = args?.file_path
        if (file) files.set(file, (files.get(file) ?? 0) + 1)
      } else if (name === 'bash' && typeof args?.command === 'string') {
        commands.push({ time: event.time ?? 0, command: args.command.split('\n')[0].slice(0, 200) })
      }
    }
  }
  return { summary, userRequests, filesTouched: [...files.keys()], commands, assistantTexts, events }
}

/** Таймлайн prompt-токенов по запросам: нужен для оценки экономии при делении чата. */
export function usageTimeline(session) {
  const timeline = []
  for (const event of getEvents(session)) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage) continue
    timeline.push({
      time: event.time ?? 0,
      promptTokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      outputTokens: usage.outputTokens ?? 0,
    })
  }
  return timeline
}

/** Использование MCP-инструментов: сервер → вызовы и последнее использование. */
function parseArguments(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function scanMcpUsage(options = {}) {
  const { root = SESSIONS_ROOT } = options
  const usage = new Map()
  for (const file of sessionFiles(root)) {
    let events
    try {
      events = parseEvents(file)
    } catch {
      continue
    }
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const name = String(event.data?.name ?? event.data?.tool ?? '')
      if (!name.startsWith('mcp__')) continue
      const parts = name.split('__')
      const server = parts[1]
      if (!server) continue
      const entry = usage.get(server) ?? { calls: 0, lastTime: 0 }
      entry.calls += 1
      if (typeof event.time === 'number' && event.time > entry.lastTime) entry.lastTime = event.time
      usage.set(server, entry)
    }
  }
  return usage
}

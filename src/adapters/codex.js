/** Адаптер OpenAI Codex CLI (rollout-*.jsonl в ~/.codex/sessions), best effort. */
import path from 'node:path'
import { HOME, exists, walkFiles, mtimeMs, fileSize, readText } from '../util/files.js'

export const id = 'codex'
export const label = 'Codex CLI'
export const SESSIONS_ROOT = path.join(HOME, '.codex', 'sessions')
const TITLE_LIMIT = 80

export function detect() {
  return exists(SESSIONS_ROOT)
}

function parseLines(file) {
  const lines = []
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue
    try {
      lines.push(JSON.parse(line))
    } catch {
      /* пропускаем */
    }
  }
  return lines
}

function payloadText(payload) {
  if (typeof payload?.text === 'string') return payload.text
  const content = payload?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item && typeof item.text === 'string' && /text$/.test(item.type ?? ''))
    .map((item) => item.text)
    .join('\n')
}

function summarize(file, lines) {
  let idValue = path.basename(file, '.jsonl')
  let cwd = ''
  let createdAt = 0
  let lastTime = mtimeMs(file)
  let title = ''
  let userCount = 0
  let toolCount = 0
  for (const line of lines) {
    const time = line.timestamp ? Date.parse(line.timestamp) : 0
    if (time && (!createdAt || time < createdAt)) createdAt = time
    if (time && time > lastTime) lastTime = time
    if (line.type === 'session_meta' && line.payload) {
      idValue = line.payload.id ?? idValue
      cwd = line.payload.cwd ?? cwd
      if (line.payload.timestamp) createdAt = Date.parse(line.payload.timestamp) || createdAt
    }
    if (line.type === 'response_item' && line.payload) {
      const payload = line.payload
      if (payload.type === 'message' && payload.role === 'user') {
        userCount += 1
        const text = payloadText(payload).trim()
        if (text && !title) title = text.slice(0, TITLE_LIMIT)
      } else if (payload.type === 'message' && payload.role === 'assistant') {
        /* только счёт */
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        toolCount += 1
      }
    }
  }
  return {
    client: id,
    id: idValue,
    file,
    cwd,
    createdAt,
    origin: 'user',
    parent: null,
    title: title || '(без названия)',
    role: 'chat',
    lastTime,
    bytes: fileSize(file),
    userCount,
    toolCount,
    promptTokens: 0,
    outputTokens: 0,
  }
}

export function listSessions(options = {}) {
  const { root = SESSIONS_ROOT } = options
  if (!exists(root)) return []
  const sessions = []
  for (const file of walkFiles(root, { fileFilter: (candidate) => candidate.endsWith('.jsonl') })) {
    let lines
    try {
      lines = parseLines(file)
    } catch {
      continue
    }
    if (lines.length === 0) continue
    sessions.push(summarize(file, lines))
  }
  sessions.sort((a, b) => b.lastTime - a.lastTime)
  return sessions
}

export function resolveSession(ref) {
  const needle = String(ref ?? '').trim()
  const sessions = listSessions()
  const matches = sessions.filter((session) => session.id === needle || session.id.startsWith(needle))
  if (matches.length === 1) return matches[0]
  return matches.length > 1 ? { ambiguous: matches } : null
}

export function extractDigest(session) {
  const lines = parseLines(session.file)
  const userRequests = []
  const assistantTexts = []
  const commands = []
  const filesTouched = new Map()
  for (const line of lines) {
    if (line.type !== 'response_item' || !line.payload) continue
    const payload = line.payload
    const time = line.timestamp ? Date.parse(line.timestamp) : 0
    if (payload.type === 'message' && payload.role === 'user') {
      const text = payloadText(payload).trim()
      if (text) userRequests.push({ time, text })
    } else if (payload.type === 'message' && payload.role === 'assistant') {
      const text = payloadText(payload).trim()
      if (text) assistantTexts.push({ time, text })
    } else if (payload.type === 'function_call') {
      const name = String(payload.name ?? '')
      const args = safeJson(payload.arguments)
      if (args?.file_path) filesTouched.set(args.file_path, (filesTouched.get(args.file_path) ?? 0) + 1)
      if (name.toLowerCase().includes('shell') && typeof args?.command === 'string') {
        commands.push({ time, command: args.command.split('\n')[0].slice(0, 200) })
      }
    }
  }
  return { summary: summarize(session.file, lines), userRequests, filesTouched: [...filesTouched.keys()], commands, assistantTexts, lines }
}

export function renameSession() {
  throw new Error('Codex CLI не поддерживает переименование сессий из CLI. Конспект и архивация доступны.')
}

function safeJson(value) {
  if (typeof value !== 'string') return value ?? null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

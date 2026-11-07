/** Адаптер Claude Code: ~/.claude/projects/<slug>/*.jsonl. */
import fs from 'node:fs'
import path from 'node:path'
import { HOME, exists, walkFiles, mtimeMs, fileSize, readText } from '../util/files.js'
import { estimateTokens } from '../util/tokens.js'

export const id = 'claude-code'
export const label = 'Claude Code'
export const SESSIONS_ROOT = path.join(HOME, '.claude', 'projects')
const TITLE_LIMIT = 80

const INTERNAL_PATTERNS = [
  /^<command-name>/,
  /^Caveat: The messages below/,
  /^This session is being continued/,
  /^<local-command/,
]

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

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function isInternal(text) {
  return INTERNAL_PATTERNS.some((pattern) => pattern.test(String(text ?? '').trim()))
}

function summarize(file, lines) {
  let title = ''
  let createdAt = 0
  let lastTime = 0
  let userCount = 0
  let toolCount = 0
  let promptTokens = 0
  let outputTokens = 0
  for (const line of lines) {
    const time = line.timestamp ? Date.parse(line.timestamp) : 0
    if (time && (!createdAt || time < createdAt)) createdAt = time
    if (time && time > lastTime) lastTime = time
    if (line.type === 'summary' && typeof line.summary === 'string' && line.summary.trim()) {
      title = line.summary.trim()
    }
    const message = line.message
    if (!message) continue
    const blocks = Array.isArray(message.content) ? message.content : []
    if (line.type === 'user') {
      userCount += 1
      if (!title) {
        const text = contentText(message.content).trim()
        if (text && !isInternal(text)) title = text.slice(0, TITLE_LIMIT)
      }
    } else if (line.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'tool_use') toolCount += 1
      }
      if (message.usage) {
        promptTokens += (message.usage.input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0)
        outputTokens += message.usage.output_tokens ?? 0
      }
    }
  }
  if (!lastTime) lastTime = mtimeMs(file)
  const slug = path.basename(path.dirname(file))
  return {
    client: id,
    id: path.basename(file, '.jsonl'),
    file,
    cwd: slug,
    createdAt,
    origin: 'user',
    parent: null,
    title: title || '(без названия)',
    role: 'chat',
    lastTime,
    bytes: fileSize(file),
    userCount,
    toolCount,
    promptTokens,
    outputTokens,
  }
}

export function listSessions(options = {}) {
  const { root = SESSIONS_ROOT } = options
  if (!exists(root)) return []
  const files = [...walkFiles(root, { fileFilter: (file) => file.endsWith('.jsonl') })]
  const sessions = []
  for (const file of files) {
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
  const summary = summarize(session.file, lines)
  const userRequests = []
  const filesTouched = new Map()
  const commands = []
  const assistantTexts = []
  for (const line of lines) {
    const message = line.message
    if (!message) continue
    const time = line.timestamp ? Date.parse(line.timestamp) : 0
    const blocks = Array.isArray(message.content) ? message.content : []
    if (line.type === 'user') {
      const text = contentText(message.content).trim()
      if (text && !isInternal(text)) userRequests.push({ time, text })
    } else if (line.type === 'assistant') {
      const text = contentText(message.content).trim()
      if (text) assistantTexts.push({ time, text })
      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue
        const name = String(block.name ?? '')
        const input = block.input ?? {}
        if (/Write|Edit|MultiEdit/.test(name) && input.file_path) {
          filesTouched.set(input.file_path, (filesTouched.get(input.file_path) ?? 0) + 1)
        } else if (name === 'Bash' && typeof input.command === 'string') {
          commands.push({ time, command: input.command.split('\n')[0].slice(0, 200) })
        }
      }
    }
  }
  return { summary, userRequests, filesTouched: [...filesTouched.keys()], commands, assistantTexts, lines }
}

export function renameSession() {
  throw new Error('Claude Code не поддерживает переименование сессий из CLI. Конспект и архивация доступны.')
}

export function usageTokens(session) {
  return {
    prompt: session.promptTokens,
    output: session.outputTokens,
    text: estimateTokens(JSON.stringify(session)),
  }
}

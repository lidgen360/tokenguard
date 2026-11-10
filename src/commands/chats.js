/** chats: безопасный архивариус (list/digest/rename/archive/clean). */
import fs from 'node:fs'
import path from 'node:path'
import * as dsh from '../adapters/dsh.js'
import * as claudeCode from '../adapters/claude-code.js'
import * as codex from '../adapters/codex.js'
import * as all from '../adapters/index.js'
import { backupPaths } from '../util/backup.js'
import { DATA_HOME, ensureDir, humanBytes, mtimeMs, readJson, timeAgo, shortId } from '../util/files.js'
import { sanitizeName } from '../util/naming.js'
import { printTable, info, ok, warn, bold } from '../log.js'
import { estimateTokens, humanTokens, parseTokenCount } from '../util/tokens.js'
import { analyzeTopicDrift, segmentLabel, topKeywords } from '../util/topics.js'
import { recordArtifact } from '../util/manifest.js'
import { redactSecrets } from '../util/redact.js'

export const VALUE_FLAGS = ['client', 'out', 'older-than', 'limit', 'threshold', 'window', 'keep-last', 'top', 'min-calls']

const ADAPTERS = { dsh, 'claude-code': claudeCode, codex }

export async function run(positional, flags) {
  const sub = positional[0]
  if (sub === 'list') return listSessions(flags)
  if (sub === 'digest') return digest(positional[1], flags)
  if (sub === 'rename') return rename(positional[1], positional.slice(2).join(' '), flags)
  if (sub === 'archive') return archive(positional.slice(1), flags)
  if (sub === 'clean') return clean(flags)
  if (sub === 'drift') return drift(positional.slice(1), flags)
  if (sub === 'tools') return tools(positional.slice(1), flags)
  if (sub === 'compact') return compact(positional.slice(1), flags)
  if (sub === 'pressure') return pressure(flags)
  console.log(HELP)
  return 0
}

const HELP = `${bold('tokenguard chats')} — архивариус чатов

  tokenguard chats list [--all] [--limit N] [--json]
  tokenguard chats digest <session> [--out файл] [--client dsh|claude-code|codex]
  tokenguard chats rename <session> "Новое название" [--force]
  tokenguard chats drift [<session>|--all] [--threshold 0.2] [--window 3] [--json]
      Детектор смены темы: где разговор ушёл в сторону и где выгодно начать новый чат.
  tokenguard chats tools [<session>] [--min-calls 2] [--json]
      Повторные одинаковые tool-вызовы: сколько раз и сколько токенов на них ушло.
  tokenguard chats compact <session> [--keep-last 8] [--out файл]
  tokenguard chats compact --auto [--threshold 350k]
      Сжать старую часть чата в конспект для продолжения в новом чате;
      --auto — выбрать самую тяжёлую сессию выше порога контекста.
  tokenguard chats pressure [--threshold 350k] [--top 12] [--json]
      Давление контекста: сколько токенов в последнем запросе каждой сессии,
      какие сессии выше порога и сколько даст сжатие на 100 запросов.
  tokenguard chats archive <session...> [--apply]
  tokenguard chats clean --older-than 30 [--apply]
`

function resolveAdapter(flags) {
  const id = flags.client
  if (!id) return { id: null }
  const adapter = ADAPTERS[id]
  if (!adapter) throw new Error(`неизвестный клиент «${id}»: доступны dsh, claude-code, codex`)
  return { id, adapter }
}

function pickSession(ref, flags) {
  const { adapter } = resolveAdapter(flags)
  if (adapter) {
    const found = adapter.resolveSession(ref)
    return { adapter, session: found }
  }
  for (const [id, candidate] of Object.entries(ADAPTERS)) {
    try {
      const found = candidate.resolveSession(ref)
      if (found && !found.ambiguous) return { adapter: candidate, session: found }
    } catch {
      /* адаптер может быть недоступен */
    }
  }
  return { adapter: null, session: null }
}

function listSessions(flags) {
  const limit = Number(flags.limit) || 30
  if (flags.all) {
    const sessions = all.listAllSessions().slice(0, limit)
    if (flags.json) {
      console.log(JSON.stringify(sessions, null, 2))
      return 0
    }
    printTable(
      ['#', 'Клиент', 'Когда', 'Размер', 'Сообщ.', 'Название', 'ID'],
      sessions.map((session, index) => [
        index + 1,
        session.client,
        timeAgo(session.lastTime),
        humanBytes(session.bytes),
        session.userCount,
        session.title.slice(0, 48),
        session.id.slice(0, 10),
      ]),
    )
    return 0
  }
  const clientId = flags.client ? String(flags.client) : null
  if (clientId && !ADAPTERS[clientId]) {
    warn(`неизвестный клиент «${clientId}»: доступны dsh, claude-code, codex`)
    return 1
  }
  const adapter = clientId ? ADAPTERS[clientId] : dsh
  const sessions = adapter.listSessions({ includeSubagents: false }).slice(0, limit).map((session) => ({ ...session, client: adapter.id }))
  if (flags.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return 0
  }
  if (sessions.length === 0) {
    warn(`сессии ${adapter.label} не найдены`)
    return 0
  }
  printTable(
    ['#', 'Когда', 'Размер', 'Сообщ.', 'Токены', 'Название', 'ID'],
    sessions.map((session, index) => [
      index + 1,
      timeAgo(session.lastTime),
      humanBytes(session.bytes),
      session.userCount,
      humanTokens(session.promptTokens),
      session.title.slice(0, 46),
      shortId(session.id),
    ]),
  )
  info(`всего: ${sessions.length} чатов (субагентские сессии скрыты; --all — все харнессы)`)
  return 0
}

function digest(ref, flags) {
  const { adapter, session } = pickSession(ref, flags)
  if (!session || session.ambiguous) {
    warn(`сессия «${ref}» не найдена или неоднозначна`)
    return 1
  }
  const extracted = adapter.extractDigest(session)
  const outFile = flags.out
    ? path.resolve(String(flags.out))
    : path.join(DATA_HOME, 'digests', `${sanitizeName(session.client ?? adapter.id)}-${sanitizeName(session.id)}.md`)
  let markdown = renderDigest(session, extracted)
  let redactedRules = 0
  if (!flags['no-redact']) {
    const redacted = redactSecrets(markdown)
    markdown = redacted.text
    redactedRules = redacted.count
  }
  ensureDir(path.dirname(outFile))
  fs.writeFileSync(outFile, markdown)
  recordArtifact({ kind: 'digest', action: 'create', path: outFile, meta: { session: session.id } })
  ok(`конспект: ${outFile}`)
  if (redactedRules > 0) info(`секреты замаскированы: ${redactedRules} правил (отключить: --no-redact)`)
  info(`запросов: ${extracted.userRequests.length}, файлов: ${extracted.filesTouched.length}, команд: ${extracted.commands.length}`)
  return 0
}

function renderDigest(session, extracted) {
  const lines = []
  const summary = extracted.summary
  lines.push(`# ${session.title} — авто-конспект`)
  lines.push('')
  lines.push(`Дата: ${new Date().toISOString().slice(0, 10)}. Это не история переписки, а извлечённый материал для проверки и архивации.`)
  lines.push('')
  lines.push('## Метаданные')
  lines.push('')
  lines.push(`- клиент: ${summary.client ?? session.client ?? 'dsh'}`)
  lines.push(`- сессия: \`${session.id}\``)
  if (session.cwd) lines.push(`- каталог: \`${session.cwd}\``)
  if (session.createdAt) lines.push(`- создана: ${new Date(session.createdAt).toISOString()}`)
  lines.push(`- последняя активность: ${new Date(session.lastTime).toISOString()}`)
  lines.push(`- запросов пользователя: ${extracted.userRequests.length}`)
  lines.push(`- вызовов инструментов: ${summary.toolCount}`)
  lines.push('')
  lines.push('## Запросы пользователя')
  lines.push('')
  for (const [index, request] of extracted.userRequests.slice(0, 200).entries()) {
    const when = request.time ? `${new Date(request.time).toISOString().slice(0, 16).replace('T', ' ')} — ` : ''
    lines.push(`${index + 1}. ${when}${request.text.replace(/\n+/g, ' ').slice(0, 600)}`)
  }
  if (extracted.filesTouched.length > 0) {
    lines.push('')
    lines.push('## Файлы, которые менялись')
    lines.push('')
    for (const file of extracted.filesTouched.slice(0, 200)) lines.push(`- \`${file}\``)
  }
  if (extracted.commands.length > 0) {
    lines.push('')
    lines.push('## Команды (первые 30)')
    lines.push('')
    for (const item of extracted.commands.slice(0, 30)) lines.push(`- \`${item.command.replace(/`/g, "'")}\``)
  }
  const lastAssistant = extracted.assistantTexts.slice(-3)
  if (lastAssistant.length > 0) {
    lines.push('')
    lines.push('## Последние ответы ассистента')
    lines.push('')
    for (const item of lastAssistant) lines.push(item.text.slice(0, 2000), '')
  }
  lines.push('')
  lines.push('> Конспект собран без LLM по эвристике: проверь и дополни перед тем, как опираться на него.')
  return `${lines.join('\n')}\n`
}

function rename(ref, title, flags) {
  if (!title || !title.trim()) {
    warn('укажи новое название: tokenguard chats rename <session> "Название"')
    return 1
  }
  const { session, adapter } = pickSession(ref, flags)
  if (!session || session.ambiguous) {
    warn(`сессия «${ref}» не найдена или неоднозначна`)
    return 1
  }
  try {
    const result = adapter.renameSession(session, title, { force: Boolean(flags.force) })
    recordArtifact({ kind: 'session-rename', action: 'rename', path: session.file, meta: { session: session.id, title: result.title, backup: result.backup } })
    ok(`переименовано в «${result.title}» (${result.bytes} байт)`)
    info(`бэкап: ${result.backup}`)
    return 0
  } catch (error) {
    warn(error.message)
    return 1
  }
}

function archive(refs, flags) {
  if (refs.length === 0) {
    warn('укажи хотя бы одну сессию: tokenguard chats archive <session...>')
    return 1
  }
  const targets = []
  for (const ref of refs) {
    const { session } = pickSession(ref, flags)
    if (!session || session.ambiguous) {
      warn(`сессия «${ref}» не найдена`)
      return 1
    }
    if (session.client !== 'dsh') {
      warn(`архивация пока поддержана только для DSH (${session.client} — конспект доступен)`)
      return 1
    }
    if (Date.now() - mtimeMs(session.file) < dsh.LIVE_WINDOW_MS) {
      warn(`сессия ${session.id.slice(0, 12)} изменялась меньше 2 минут назад — вероятно, активна; пропускаю`)
      continue
    }
    targets.push(session)
  }
  if (targets.length === 0) return 0
  if (!flags.apply) {
    info('dry-run: будут удалены (с бэкапом):')
    for (const session of targets) console.log(`  • ${session.id.slice(0, 12)} — ${session.title} (${humanBytes(session.bytes)})`)
    info('добавь --apply, чтобы выполнить')
    return 0
  }
  const files = targets.map((session) => session.file)
  const backup = backupPaths(files, 'chats-archive')
  for (const session of targets) fs.rmSync(path.dirname(session.file), { recursive: true, force: true })
  recordArtifact({ kind: 'chats-archive', action: 'delete', path: backup, meta: { sessions: targets.map((item) => item.id), count: targets.length } })
  ok(`удалено сессий: ${targets.length}; бэкап: ${backup}`)
  return 0
}

function clean(flags) {
  const days = Number(flags['older-than'] ?? 30)
  if (!Number.isFinite(days) || days <= 0) {
    warn('укажи --older-than <дней>')
    return 1
  }
  const threshold = Date.now() - days * 86_400_000
  const sessions = dsh.listSessions().filter((session) => session.lastTime < threshold)
  if (sessions.length === 0) {
    ok(`нет чатов старше ${days} дней`)
    return 0
  }
  if (!flags.apply) {
    info(`dry-run: ${sessions.length} чатов старше ${days} дней`)
    for (const session of sessions.slice(0, 50)) console.log(`  • ${timeAgo(session.lastTime)} — ${session.title.slice(0, 60)} (${humanBytes(session.bytes)})`)
    info('добавь --apply, чтобы заархивировать и удалить')
    return 0
  }
  return archive(sessions.map((session) => session.id), { ...flags, apply: true })
}


/* ------------------------------------------------------------------ */
/* Детектор смены темы                                                 */
/* ------------------------------------------------------------------ */

function userMessagesOf(adapter, session) {
  return adapter.extractDigest(session).userRequests
}

/** Оценка токенов, которые тратились на «старую» тему после смены. */
function estimateSavings(adapter, session, messages, shifts) {
  if (shifts.length === 0) return { total: 0, mode: 'n/a', details: [] }
  if (typeof adapter.usageTimeline === 'function') {
    const timeline = adapter.usageTimeline(session).filter((item) => item.promptTokens > 0)
    const details = []
    let total = 0
    for (const [index, shift] of shifts.entries()) {
      // Непересекающиеся сегменты: от этой смены до следующей.
      const startTime = shift.time || 0
      const endTime = index + 1 < shifts.length ? (shifts[index + 1].time || Infinity) : Infinity
      const segment = timeline.filter((item) => item.time >= startTime && item.time < endTime)
      if (segment.length === 0) {
        details.push({ shift, saved: 0 })
        continue
      }
      // Старый контекст на момент смены тащится в каждом следующем запросе сегмента.
      const baseline = segment[0].promptTokens
      const saved = baseline * segment.length
      details.push({ shift, saved })
      total += saved
    }
    return { total, mode: 'оценка по usage из логов', details }
  }
  const first = shifts[0].index
  const text = messages.slice(first).map((message) => message.text).join('\n')
  return {
    total: estimateTokens(text),
    mode: 'оценка по тексту',
    details: shifts.map((shift) => ({ shift, saved: 0 })),
  }
}

function driftOne(ref, flags) {
  const threshold = Number(flags.threshold ?? 0.2)
  const windowSize = Number(flags.window ?? 3)
  let picked
  if (ref) {
    picked = pickSession(ref, flags)
    if (!picked.session || picked.session.ambiguous) throw new Error(`сессия «${ref}» не найдена или неоднозначна`)
  } else {
    const sessions = dsh.listSessions()
    if (sessions.length === 0) throw new Error('сессий DSH не найдено')
    picked = { adapter: dsh, session: sessions[0] }
  }
  const messages = userMessagesOf(picked.adapter, picked.session)
  const analysis = analyzeTopicDrift(messages, { threshold, windowSize })
  const savings = estimateSavings(picked.adapter, picked.session, messages, analysis.shifts)
  if (flags.json) {
    console.log(JSON.stringify({
      session: {
        id: picked.session.id,
        title: picked.session.title,
        client: picked.adapter.id,
        cwd: picked.session.cwd,
      },
      messages: messages.length,
      analysis,
      savings,
    }, null, 2))
    return 0
  }
  console.log(bold(`Сессия: ${picked.session.title}`) + ` [${picked.adapter.id}]`)
  console.log(`Сообщений пользователя: ${messages.length}`)
  if (analysis.shifts.length === 0) {
    ok('смены темы не обнаружены — чат можно продолжать')
    return 0
  }
  for (const [index, shift] of analysis.shifts.entries()) {
    const when = shift.time ? new Date(shift.time).toISOString().slice(11, 16) : '—'
    const before = analysis.segments[index]
    const after = analysis.segments[index + 1]
    console.log('')
    console.log(`⚠ Смена темы ${index + 1}: после сообщения ${shift.index} (${when}), сходство ${shift.similarity}`)
    console.log(`   было:  ${segmentLabel(before)}`)
    console.log(`   стало: ${segmentLabel(after)}`)
    const saved = savings.details[index]?.saved
    if (saved > 0) console.log(`   новый чат с этого места: ≈${humanTokens(saved)} токенов экономии`)
  }
  console.log('')
  info(`итого смен темы: ${analysis.shifts.length}; суммарно при делении ≈${humanTokens(savings.total)} токенов (${savings.mode})`)
  info('перенести контекст: tokenguard chats digest <session> --out CHAT-CURRENT-STATE.md')
  return 0
}

function driftAll(flags) {
  const threshold = Number(flags.threshold ?? 0.2)
  const windowSize = Number(flags.window ?? 3)
  const rows = []
  for (const session of dsh.listSessions()) {
    let messages
    try {
      messages = dsh.extractDigest(session).userRequests
    } catch {
      continue
    }
    if (messages.length < 4) continue
    const analysis = analyzeTopicDrift(messages, { threshold, windowSize })
    const savings = estimateSavings(dsh, session, messages, analysis.shifts)
    rows.push({ session, messages, shifts: analysis.shifts, saved: savings.total })
  }
  rows.sort((a, b) => b.saved - a.saved)
  if (flags.json) {
    console.log(JSON.stringify(rows.map((row) => ({
      id: row.session.id,
      title: row.session.title,
      messages: row.messages,
      shifts: row.shifts,
      savedTokens: row.saved,
    })), null, 2))
    return 0
  }
  if (rows.length === 0) {
    warn('нет чатов с достаточным количеством сообщений')
    return 0
  }
  printTable(
    ['Чат', 'Сообщ.', 'Смен темы', 'Экономия', 'Вердикт'],
    rows.map((row) => [
      row.session.title.slice(0, 44),
      row.messages.length,
      row.shifts.length,
      row.shifts.length ? `≈${humanTokens(row.saved)}` : '—',
      row.shifts.length >= 2 || row.saved > 20_000 ? 'делить' : 'ок',
    ]),
  )
  info('подробности: tokenguard chats drift <session>')
  return 0
}

function drift(args, flags) {
  try {
    if (flags.all) return driftAll(flags)
    return driftOne(args?.[0], flags)
  } catch (error) {
    if (flags.json) {
      console.log(JSON.stringify({
        error: error.message,
        session: null,
        messages: 0,
        analysis: { shifts: [], segments: [] },
        savings: { total: 0 },
      }, null, 2))
      return 1
    }
    warn(error.message)
    return 1
  }
}

/* ------------------------------------------------------------------ */
/* Повторные tool-вызовы и компакция контекста                        */
/* ------------------------------------------------------------------ */

function toolsReport(args, flags) {
  const picked = args?.[0] ? pickSession(args[0], flags) : { adapter: dsh, session: dsh.listSessions()[0] }
  if (!picked.session || picked.session.ambiguous) {
    const message = !args?.[0] ? 'сессий DSH не найдено' : `сессия «${args[0]}» не найдена или неоднозначна`
    if (flags.json) {
      console.log(JSON.stringify({ error: message, session: null, calls: 0, duplicates: [], totalWasted: 0 }, null, 2))
      return 1
    }
    warn(message)
    return 1
  }
  const { calls, results } = dsh.toolCalls(picked.session)
  const groups = new Map()
  for (const call of calls.values()) {
    const key = `${call.name}\u0000${call.argsKey}`
    const group = groups.get(key) ?? { name: call.name, argsKey: call.argsKey, callIds: [], resultTokens: 0 }
    group.callIds.push(call.callId)
    group.resultTokens += estimateTokens(results.get(call.callId) ?? '')
    groups.set(key, group)
  }
  const minCalls = Number(flags['min-calls'] ?? 2)
  const duplicates = [...groups.values()]
    .filter((group) => group.callIds.length >= minCalls)
    .map((group) => ({
      name: group.name,
      args: group.argsKey.replace(/\n/g, ' ').slice(0, 80),
      calls: group.callIds.length,
      wastedTokens: Math.round((group.resultTokens * (group.callIds.length - 1)) / group.callIds.length),
    }))
    .sort((a, b) => b.wastedTokens - a.wastedTokens || b.calls - a.calls)
  const totalWasted = duplicates.reduce((sum, item) => sum + item.wastedTokens, 0)
  if (flags.json) {
    console.log(JSON.stringify({ session: picked.session.id, calls: calls.size, duplicates, totalWasted }, null, 2))
    return 0
  }
  console.log(bold(`Повторные вызовы: ${picked.session.title}`) + ` [${calls.size} вызовов]`)
  if (duplicates.length === 0) {
    ok('повторных одинаковых вызовов не найдено')
    return 0
  }
  printTable(
    ['Инструмент', 'Аргументы', 'Повторов', '≈Токенов впустую'],
    duplicates.slice(0, Number(flags.top ?? 12)).map((item) => [item.name, item.args, item.calls, humanTokens(item.wastedTokens)]),
  )
  info(`групп дублей: ${duplicates.length}; оценка потерь: ≈${humanTokens(totalWasted)} токенов`)
  return 0
}

export const DEFAULT_CONTEXT_THRESHOLD = 350_000
export const COMPACTED_CONTEXT_ESTIMATE = 50_000

/** Порог контекста: флаг → config.json → значение по умолчанию. null — некорректный флаг. */
export function resolveContextThreshold(flags = {}, config = {}) {
  const raw = flags.threshold ?? config.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD
  return parseTokenCount(raw, null)
}

/**
 * Давление контекста по сессиям: размер последнего запроса, максимум и оценка экономии.
 * Чистая функция: adapter.usageTimeline(session) даёт историю usage.
 */
export function pressureData(sessions, { adapter, threshold = DEFAULT_CONTEXT_THRESHOLD } = {}) {
  return (sessions ?? []).map((session) => {
    let timeline = []
    try {
      timeline = (adapter?.usageTimeline(session) ?? []).filter((item) => item.promptTokens > 0)
    } catch {
      timeline = []
    }
    const last = timeline.length > 0 ? timeline[timeline.length - 1].promptTokens : 0
    const max = timeline.reduce((value, item) => Math.max(value, item.promptTokens), last)
    const first = timeline.length > 0 ? timeline[0].promptTokens : 0
    const tail = timeline.slice(-8)
    const avgLast8 = tail.length > 0 ? Math.round(tail.reduce((sum, item) => sum + item.promptTokens, 0) / tail.length) : 0
    const cumulative = Number(session.promptTokens) || timeline.reduce((sum, item) => sum + item.promptTokens, 0)
    const savedPerRequest = Math.max(0, last - COMPACTED_CONTEXT_ESTIMATE)
    return {
      id: session.id,
      title: session.title ?? session.id,
      client: adapter?.id ?? session.client ?? 'dsh',
      requests: timeline.length,
      last,
      max,
      first,
      avgLast8,
      cumulative,
      bytes: session.bytes ?? 0,
      threshold,
      over: last >= threshold,
      savedPerRequest,
      savedPer100: savedPerRequest * 100,
    }
  }).sort((left, right) => right.last - left.last)
}

function resolvePressureAdapter(flags) {
  const { id, adapter } = resolveAdapter(flags)
  const target = adapter ?? dsh
  if (typeof target.usageTimeline !== 'function') {
    throw new Error(`для клиента «${id}» нет данных об использовании токенов`)
  }
  return target
}

function publicPressure(row) {
  return {
    id: row.id,
    title: row.title,
    client: row.client,
    requests: row.requests,
    lastPromptTokens: row.last,
    maxPromptTokens: row.max,
    firstPromptTokens: row.first,
    avgLast8PromptTokens: row.avgLast8,
    cumulativePromptTokens: row.cumulative,
    bytes: row.bytes,
    overThreshold: row.over,
    savedPerRequest: row.savedPerRequest,
    savedPer100: row.savedPer100,
  }
}

function pressure(flags) {
  let adapter
  try {
    adapter = resolvePressureAdapter(flags)
  } catch (error) {
    if (flags.json) console.log(JSON.stringify({ error: error.message }, null, 2))
    else warn(error.message)
    return 1
  }
  const config = readJson(path.join(DATA_HOME, 'config.json')) ?? {}
  const threshold = resolveContextThreshold(flags, config)
  if (threshold === null) {
    if (flags.json) console.log(JSON.stringify({ error: 'порог должен быть числом токенов: --threshold 350k' }, null, 2))
    else warn('порог должен быть числом токенов: --threshold 350k (или contextThreshold в config.json)')
    return 1
  }
  let sessions = []
  try {
    sessions = adapter.listSessions()
  } catch (error) {
    const message = `не удалось прочитать сессии: ${error?.message ?? error}`
    if (flags.json) console.log(JSON.stringify({ error: message }, null, 2))
    else warn(message)
    return 1
  }
  if (sessions.length === 0) {
    if (flags.json) {
      console.log(JSON.stringify({ threshold, compactedEstimate: COMPACTED_CONTEXT_ESTIMATE, over: 0, sessions: [] }, null, 2))
      return 0
    }
    info('сессий не найдено')
    return 0
  }
  const rows = pressureData(sessions, { adapter, threshold })
  const top = Math.max(1, Number(flags.top ?? 12) || 12)
  if (flags.json) {
    console.log(JSON.stringify({
      threshold,
      compactedEstimate: COMPACTED_CONTEXT_ESTIMATE,
      over: rows.filter((row) => row.over).length,
      sessions: rows.map(publicPressure),
    }, null, 2))
    return 0
  }
  printTable(
    ['Сессия', 'Последний', 'Макс', 'Запросов', 'Накопительно', 'Статус', '≈экономия/100'],
    rows.slice(0, top).map((row) => [
      `${row.title.slice(0, 36)}${row.title.length > 36 ? '…' : ''} (${shortId(row.id)})`,
      humanTokens(row.last),
      humanTokens(row.max),
      row.requests,
      humanTokens(row.cumulative),
      row.over ? 'выше порога' : '—',
      row.over ? humanTokens(row.savedPer100) : '—',
    ]),
  )
  const over = rows.filter((row) => row.over).length
  info(`порог: ${humanTokens(threshold)} · выше порога: ${over} из ${rows.length}`)
  info(`оценка «после сжатия» — ${humanTokens(COMPACTED_CONTEXT_ESTIMATE)} токенов (конспект + последние сообщения)`)
  if (over > 0) {
    info('сжать вручную: tokenguard chats compact <session>')
    info('выбрать самую тяжёлую автоматически: tokenguard chats compact --auto')
  } else {
    ok('все сессии ниже порога')
  }
  return 0
}

function compactChat(args, flags) {
  const picked = args?.[0] ? pickSession(args[0], flags) : { adapter: dsh, session: dsh.listSessions()[0] }
  if (!picked.session || picked.session.ambiguous) {
    warn(`сессия «${args?.[0] ?? ''}» не найдена`)
    return 1
  }
  const extracted = picked.adapter.extractDigest(picked.session)
  const messages = extracted.userRequests
  if (messages.length === 0) {
    warn('в сессии нет пользовательских сообщений')
    return 1
  }
  const keepLast = Math.max(1, Number(flags['keep-last'] ?? 8))
  const cutoff = Math.max(0, messages.length - keepLast)
  const early = messages.slice(0, cutoff)
  const tail = messages.slice(cutoff)
  const earlyKeywords = topKeywords(early.map((message) => message.text), 10).map((item) => item.word)
  const lines = []
  lines.push(`# COMPACT: ${picked.session.title}`)
  lines.push('')
  lines.push(`Сессия: \`${picked.session.id}\` · клиент: ${picked.adapter.id} · сообщений: ${messages.length} · сжато до последних ${tail.length}`)
  lines.push(`Дата сжатия: ${new Date().toISOString().slice(0, 10)}. Это контекст для нового чата, а не история переписки.`)
  lines.push('')
  lines.push(`## Ранняя часть (${early.length} сообщений, сжато)`)
  lines.push('')
  if (earlyKeywords.length > 0) lines.push(`Ключевые темы: ${earlyKeywords.join(', ')}.`)
  lines.push('')
  for (const [index, message] of early.entries()) {
    lines.push(`${index + 1}. ${message.text.replace(/\n+/g, ' ').slice(0, 240)}`)
  }
  if (early.length === 0) lines.push('(пусто)')
  lines.push('')
  lines.push(`## Последние ${tail.length} сообщений (дословно)`)
  lines.push('')
  for (const message of tail) lines.push(`- ${message.text}`)
  if (extracted.filesTouched.length > 0) {
    lines.push('')
    lines.push('## Затронутые файлы')
    lines.push('')
    for (const file of extracted.filesTouched.slice(0, 80)) lines.push(`- \`${file}\``)
  }
  const lastAssistant = extracted.assistantTexts.slice(-2)
  if (lastAssistant.length > 0) {
    lines.push('')
    lines.push('## Последние выводы ассистента')
    lines.push('')
    for (const item of lastAssistant) lines.push(item.text.slice(0, 1200), '')
  }
  lines.push('')
  lines.push('> Продолжи работу в новом чате: вставь этот документ первым сообщением (или приложи файлом).')
  let markdown = `${lines.join('\n')}\n`
  let redactedRules = 0
  if (!flags['no-redact']) {
    const redacted = redactSecrets(markdown)
    markdown = redacted.text
    redactedRules = redacted.count
  }
  const outFile = flags.out
    ? path.resolve(String(flags.out))
    : path.join(DATA_HOME, 'compact', `${sanitizeName(picked.session.client ?? picked.adapter.id)}-${sanitizeName(picked.session.id)}.md`)
  ensureDir(path.dirname(outFile))
  fs.writeFileSync(outFile, markdown)
  recordArtifact({ kind: 'compact', action: 'create', path: outFile, meta: { session: picked.session.id } })
  ok(`компакция: ${outFile}`)
  info(`ранних сообщений сжато: ${early.length}; последних сохранено: ${tail.length}`)
  if (redactedRules > 0) info(`секреты замаскированы: ${redactedRules} правил`)
  info('открой новый чат и вставь файл первым сообщением — контекст будет короче')
  return 0
}

function tools(args, flags) {
  return toolsReport(args, flags)
}

function compact(args, flags) {
  if (flags.auto) {
    const config = readJson(path.join(DATA_HOME, 'config.json')) ?? {}
    const threshold = resolveContextThreshold(flags, config)
    if (threshold === null) {
      warn('порог должен быть числом токенов: --threshold 350k')
      return 1
    }
    const rows = pressureData(dsh.listSessions(), { adapter: dsh, threshold })
    const picked = rows.find((row) => row.over)
    if (!picked) {
      ok(`нет сессий выше порога ${humanTokens(threshold)}`)
      return 0
    }
    info(`авто-выбор: «${picked.title}» — последний запрос ${humanTokens(picked.last)} (${shortId(picked.id)})`)
    return compactChat([picked.id], flags)
  }
  return compactChat(args, flags)
}

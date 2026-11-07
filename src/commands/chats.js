/** chats: безопасный архивариус (list/digest/rename/archive/clean). */
import fs from 'node:fs'
import path from 'node:path'
import * as dsh from '../adapters/dsh.js'
import * as claudeCode from '../adapters/claude-code.js'
import * as codex from '../adapters/codex.js'
import * as all from '../adapters/index.js'
import { backupPaths } from '../util/backup.js'
import { DATA_HOME, ensureDir, humanBytes, mtimeMs, timeAgo, shortId } from '../util/files.js'
import { sanitizeName } from '../util/naming.js'
import { printTable, info, ok, warn, bold } from '../log.js'
import { humanTokens } from '../util/tokens.js'

export const VALUE_FLAGS = ['client', 'out', 'older-than', 'limit']

const ADAPTERS = { dsh, 'claude-code': claudeCode, codex }

export async function run(positional, flags) {
  const sub = positional[0]
  if (sub === 'list') return listSessions(flags)
  if (sub === 'digest') return digest(positional[1], flags)
  if (sub === 'rename') return rename(positional[1], positional.slice(2).join(' '), flags)
  if (sub === 'archive') return archive(positional.slice(1), flags)
  if (sub === 'clean') return clean(flags)
  console.log(HELP)
  return 0
}

const HELP = `${bold('ccliner chats')} — архивариус чатов

  ccliner chats list [--all] [--limit N] [--json]
  ccliner chats digest <session> [--out файл] [--client dsh|claude-code|codex]
  ccliner chats rename <session> "Новое название" [--force]
  ccliner chats archive <session...> [--apply]
  ccliner chats clean --older-than 30 [--apply]
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
  const sessions = dsh.listSessions({ includeSubagents: false }).slice(0, limit)
  if (flags.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return 0
  }
  if (sessions.length === 0) {
    warn('сессии DSH не найдены (~/.dsh/sessions)')
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
  const markdown = renderDigest(session, extracted)
  ensureDir(path.dirname(outFile))
  fs.writeFileSync(outFile, markdown)
  ok(`конспект: ${outFile}`)
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
    warn('укажи новое название: ccliner chats rename <session> "Название"')
    return 1
  }
  const { session, adapter } = pickSession(ref, flags)
  if (!session || session.ambiguous) {
    warn(`сессия «${ref}» не найдена или неоднозначна`)
    return 1
  }
  try {
    const result = adapter.renameSession(session, title, { force: Boolean(flags.force) })
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
    warn('укажи хотя бы одну сессию: ccliner chats archive <session...>')
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


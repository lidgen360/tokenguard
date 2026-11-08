/** guard: правило экономии контекста в AGENTS.md + проверка дрейфа темы. */
import path from 'node:path'
import * as dsh from '../adapters/dsh.js'
import { analyzeTopicDrift, segmentLabel } from '../util/topics.js'
import { backupPaths } from '../util/backup.js'
import { exists, readText, writeFile } from '../util/files.js'
import { printTable, info, ok, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['root', 'session', 'threshold', 'window']

const MARK_BEGIN = '<!-- tokenguard:guard -->'
const MARK_END = '<!-- /tokenguard:guard -->'

const HELP = `${bold('tokenguard guard')} — защита контекста в проекте

  tokenguard guard install [--root <dir>]   # добавить правило в AGENTS.md
  tokenguard guard status [--root <dir>]    # есть ли правило и что с последним чатом
  tokenguard guard check [--session <id>] [--strict]
                                         # проверить дрейф последнего чата
`

export async function run(positional, flags) {
  const sub = positional[0]
  if (sub === 'install') return install(flags)
  if (sub === 'status') return status(flags)
  if (sub === 'check') return check(flags)
  console.log(HELP)
  return 0
}

function guardBlock() {
  return `${MARK_BEGIN}
## Экономия контекста (tokenguard)

- Если в запросе есть маркер \`[tokenguard-drift]\` — **первым блоком ответа** выведи
  \`⚠️ tokenguard: смена темы (N) — создать новый чат?\`, затем **спроси пользователя через
  интерактивный вопрос** (Да/Нет): «Создать новый чат с переносом контекста?».
- Если пользователь ответил **Да**: обнови конспект (\`tokenguard chats digest <session>\` и
  \`tokenguard chats compact <session> --keep-last 8 --out docs/CHAT-COMPACT.md\`) и создай новый чат
  автоматически: \`node bin/tokenguard-dsh-new-chat.js --prompt "Прочитай docs/CHAT-COMPACT.md ..."\`
  (Safari AppleScript: нажимает «Новая сессия», вставляет перенос и отправляет — ничего вручную).
- Без маркера, перед продолжением длинного чата (≥10 сообщений): \`tokenguard chats drift --json\`.
- Маркер вкладывает хук DSH (\`bin/tokenguard-dsh-hook.js\` через \`dsh-hooks-claude-code\`) — агент
  обязан его отработать, а не пропустить.
- Лимиты бюджета не используются: не запускай и не предлагай \`tokenguard budget\`.
${MARK_END}`
}

function install(flags) {
  const root = path.resolve(flags.root ? String(flags.root) : process.cwd())
  const file = path.join(root, 'AGENTS.md')
  const block = guardBlock()
  let content = ''
  let backup = null
  if (exists(file)) {
    content = readText(file)
    if (content.includes(MARK_BEGIN)) {
      const pattern = new RegExp(`${escapeRegExp(MARK_BEGIN)}[\\s\\S]*?${escapeRegExp(MARK_END)}`)
      const next = content.replace(pattern, block)
      if (next === content) {
        ok(`правило уже актуально: ${file}`)
        return 0
      }
      content = next
      backup = backupPaths([file], 'guard-agents')
    } else {
      backup = backupPaths([file], 'guard-agents')
      content = `${content.replace(/\s+$/, '')}\n\n${block}\n`
    }
  } else {
    content = `${block}\n`
  }
  writeFile(file, content)
  ok(`правило добавлено: ${file}`)
  if (backup) info(`бэкап: ${backup}`)
  info('агент увидит правило в следующей сессии (или после перезапуска)')
  return 0
}

function status(flags) {
  const root = path.resolve(flags.root ? String(flags.root) : process.cwd())
  const file = path.join(root, 'AGENTS.md')
  const installed = exists(file) && readText(file).includes(MARK_BEGIN)
  info(`AGENTS.md: ${file}`)
  info(`правило tokenguard: ${installed ? 'установлено' : 'нет (запусти guard install)'}`)
  const picked = latestSession(flags)
  if (picked) {
    const messages = picked.adapter.extractDigest(picked.session).userRequests
    const analysis = analyzeTopicDrift(messages, thresholds(flags))
    info(`последний чат: «${picked.session.title}» — сообщений ${messages.length}, смен темы ${analysis.shifts.length}`)
  }
  return 0
}

function check(flags) {
  const picked = latestSession(flags)
  if (!picked) {
    warn('сессий DSH не найдено')
    return 1
  }
  const messages = picked.adapter.extractDigest(picked.session).userRequests
  const analysis = analyzeTopicDrift(messages, thresholds(flags))
  console.log(bold(`Чат: ${picked.session.title}`) + ` · сообщений: ${messages.length}`)
  if (analysis.shifts.length === 0) {
    ok('смена темы не обнаружена — можно продолжать')
    return 0
  }
  for (const [index, shift] of analysis.shifts.entries()) {
    console.log(`⚠ смена темы ${index + 1}: после сообщения ${shift.index} — было «${segmentLabel(analysis.segments[index])}», стало «${segmentLabel(analysis.segments[index + 1])}»`)
  }
  console.log(bold(`⚠️  tokenguard: смена темы (${analysis.shifts.length}) — создать новый чат?`))
  info('перенести состояние: tokenguard chats digest <session> (или tokenguard chats compact <session> --keep-last 8)')
  return flags.strict ? 1 : 0
}

function thresholds(flags) {
  return {
    threshold: Number(flags.threshold ?? 0.18),
    windowSize: Number(flags.window ?? 4),
  }
}

function latestSession(flags) {
  try {
    if (flags.session) {
      const found = dsh.resolveSession(String(flags.session))
      if (!found || found.ambiguous) return null
      return { adapter: dsh, session: found }
    }
    const sessions = dsh.listSessions()
    return sessions.length > 0 ? { adapter: dsh, session: sessions[0] } : null
  } catch {
    return null
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * DSH `UserPromptSubmit` hook: turn the topic-drift detector into model context.
 *
 * The harness hook bridge runs this on every prompt and folds the returned
 * `additionalContext` into the step context, so the agent cannot "forget" to
 * check the chat: the drift notice travels with the request itself.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { humanTokens, parseTokenCount } from '../util/tokens.js'
import * as dsh from '../adapters/dsh.js'

/**
 * Where tokenguard keeps user-level settings (`$TOKENGUARD_HOME` or `~/.tokenguard`).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function tokenguardHome(env = process.env) {
  const configured = String(env.TOKENGUARD_HOME || '').trim()
  return configured || path.join(os.homedir(), '.tokenguard')
}

/**
 * Whether the drift hook is muted. Two switches, the hook is on by default:
 *   - `TOKENGUARD_DRIFT_HOOK=0` in the harness environment;
 *   - `{"driftHook": false}` in `$TOKENGUARD_HOME/config.json`.
 * The hook is a short-lived process, so toggling the file takes effect on the
 * very next prompt — the running DSH does not need a restart.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} true when the hook must stay silent
 */
export function driftHookDisabled(env = process.env) {
  const envValue = String(env.TOKENGUARD_DRIFT_HOOK ?? '').trim().toLowerCase()
  if (envValue === '0' || envValue === 'false' || envValue === 'off') return true
  try {
    const config = JSON.parse(readFileSync(path.join(tokenguardHome(env), 'config.json'), 'utf8'))
    return config?.driftHook === false
  } catch {
    return false
  }
}

/**
 * @param {object} payload hook stdin payload (`session_id` is the DSH session id)
 * @param {{ exec?: (ref: string) => object | null, disabled?: boolean }} [options]
 *   `disabled` overrides the config switch; tests pass it explicitly
 * @returns {string | null} additional context, or null when the chat is fine
 */
export function buildDriftContext(payload, { exec, disabled } = {}) {
  if (disabled ?? driftHookDisabled()) return null
  const raw = String(payload?.session_id || payload?.sessionId || '')
  const ref = raw.replace(/^session-/, '').trim()
  if (!ref) return null
  let analysis
  try {
    analysis = (exec || defaultExec)(ref)
  } catch {
    return null
  }
  if (!analysis) return null
  const shifts = Array.isArray(analysis?.analysis?.shifts) ? analysis.analysis.shifts.length : 0
  if (shifts === 0) return null
  const title = typeof analysis?.session?.title === 'string' ? analysis.session.title : ''
  const messages = Number(analysis?.messages) || 0
  return [
    '[tokenguard-drift]',
    `⚠️ tokenguard: смена темы (${shifts}) — создать новый чат?`,
    title ? `Чат «${title}», сообщений: ${messages}.` : `Сообщений: ${messages}.`,
    'Перенести состояние: tokenguard chats digest <session> (или tokenguard chats compact <session> --keep-last 8).',
    'Выведи это предупреждение первым блоком ответа и предложи пользователю новый чат.',
  ].join(' ')
}

export function defaultExec(ref) {
  const bin = process.env.TOKENGUARD_BIN || 'tokenguard'
  const run = spawnSync(bin, ['chats', 'drift', ref, '--json'], { encoding: 'utf8', timeout: 8_000 })
  if (run.error || run.status !== 0 || !run.stdout) return null
  try {
    return JSON.parse(run.stdout)
  } catch {
    return null
  }
}

/** Claude Code hook protocol shape understood by the DSH bridge. */
export function hookOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
}


/** Настройки из config.json (или {} при ошибке). */
export function readHookConfig(env = process.env) {
  try {
    return JSON.parse(readFileSync(path.join(tokenguardHome(env), 'config.json'), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

/**
 * Контекстный хук выключен по умолчанию: включён только при
 * `{"contextHook": true}` в config.json и не замьючен `TOKENGUARD_CONTEXT_HOOK=0`.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function contextHookDisabled(env = process.env) {
  const envValue = String(env.TOKENGUARD_CONTEXT_HOOK ?? '').trim().toLowerCase()
  if (envValue === '0' || envValue === 'false' || envValue === 'off') return true
  return readHookConfig(env)?.contextHook !== true
}

/** Быстро найти файл сессии по id: без чтения всех логов. */
function findSessionFile(ref) {
  const raw = String(ref || '').replace(/^session-/, '').trim()
  if (!raw) return null
  let keys = []
  try {
    keys = readdirSync(dsh.SESSIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
  for (const key of keys) {
    for (const dir of [`session-${raw}`, raw]) {
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const file = path.join(dsh.SESSIONS_ROOT, key, dir, name)
        if (existsSync(file)) return file
      }
    }
  }
  return null
}

/** Последний запрос текущей сессии — быстро, без полного сканирования всех чатов. */
export function defaultPressureExec(payload) {
  const ref = String(payload?.session_id || payload?.sessionId || '').replace(/^session-/, '').trim()
  const transcript = payload?.transcript_path ? String(payload.transcript_path) : ''
  const file = transcript && existsSync(transcript) ? transcript : findSessionFile(ref)
  if (!file) return null
  try {
    const timeline = dsh.usageTimeline({ file }).filter((item) => item.promptTokens > 0)
    const last = timeline.length > 0 ? timeline[timeline.length - 1].promptTokens : 0
    return { sessions: [{ id: ref, title: '', lastPromptTokens: last, requests: timeline.length }] }
  } catch {
    return null
  }
}

/**
 * Напоминание о давлении контекста: не чаще одного раза в cooldownMinutes на сессию.
 * Возвращает additionalContext или null. Чистая логика с инъекцией exec/now/statePath.
 */
export function buildContextContext(payload, { exec, now = Date.now(), statePath, config, disabled } = {}) {
  const settings = config ?? readHookConfig()
  const muted = disabled === undefined ? contextHookDisabled() : disabled
  if (muted || settings.contextHook !== true) return null

  const raw = String(payload?.session_id || payload?.sessionId || '')
  const ref = raw.replace(/^session-/, '').trim()
  if (!ref) return null

  let data
  try {
    data = (exec || defaultPressureExec)(payload)
  } catch {
    return null
  }
  const sessions = Array.isArray(data?.sessions) ? data.sessions : []
  const row = sessions.find((item) => item.id === ref) || sessions.find((item) => item.id?.startsWith(ref))
  if (!row) return null

  const threshold = parseTokenCount(settings.contextThreshold ?? '350k', 350_000)
  const lastPrompt = Number(row.lastPromptTokens) || 0
  if (lastPrompt < threshold) return null

  const cooldownMinutes = Math.max(5, Number(settings.contextHookCooldownMinutes ?? 45) || 45)
  const cooldownMs = cooldownMinutes * 60_000
  const file = statePath ?? path.join(tokenguardHome(), 'hooks', 'context-state.json')
  let state = {}
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch {
    state = {}
  }
  const key = String(row.id)
  const previous = state[key]
  if (previous && now - Number(previous.at) < cooldownMs) return null

  state[key] = {
    at: now,
    prompt: lastPrompt,
    reminders: (Number(previous?.reminders) || 0) + 1,
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(tmp, file)
  } catch {
    /* напоминание важнее состояния: если файл не записался, покажем его */
  }

  const title = String(row.title || '').trim()
  return [
    '[tokenguard-context]',
    `Контекст чата${title ? ` «${title}»` : ''} ≈ ${humanTokens(lastPrompt)} токенов (порог ${humanTokens(threshold)}).`,
    'Сжать старую часть в конспект, чтобы следующие ответы были дешевле?',
    `Если да — tokenguard chats compact ${key} --keep-last 8, затем вставить конспект первым сообщением в новый чат.`,
    `Это напоминание (не чаще раза в ${cooldownMinutes} мин). Спроси пользователя; не создавай чат и не сжимай без его ответа.`,
  ].join(' ')
}

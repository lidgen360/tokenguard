/**
 * DSH `UserPromptSubmit` hook: turn the topic-drift detector into model context.
 *
 * The harness hook bridge runs this on every prompt and folds the returned
 * `additionalContext` into the step context, so the agent cannot "forget" to
 * check the chat: the drift notice travels with the request itself.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

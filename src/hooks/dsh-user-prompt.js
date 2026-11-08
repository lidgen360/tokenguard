/**
 * DSH `UserPromptSubmit` hook: turn the topic-drift detector into model context.
 *
 * The harness hook bridge runs this on every prompt and folds the returned
 * `additionalContext` into the step context, so the agent cannot "forget" to
 * check the chat: the drift notice travels with the request itself.
 */
import { spawnSync } from 'node:child_process'

/**
 * @param {object} payload hook stdin payload (`session_id` is the DSH session id)
 * @param {{ exec?: (ref: string) => object | null }} [options]
 * @returns {string | null} additional context, or null when the chat is fine
 */
export function buildDriftContext(payload, { exec } = {}) {
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

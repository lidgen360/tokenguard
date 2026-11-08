import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDriftContext, hookOutput } from '../src/hooks/dsh-user-prompt.js'

const drift = (shifts) => ({
  session: { title: 'Тестовый чат' },
  messages: 30,
  analysis: { shifts: Array.from({ length: shifts }, (_, index) => ({ index })) },
})

test('injects the drift notice into model context', () => {
  let seen = null
  const context = buildDriftContext({ session_id: 'session-abc' }, { exec: (ref) => { seen = ref; return drift(3) } })
  assert.equal(seen, 'abc', 'session- prefix is stripped for the CLI')
  assert.match(context, /\[tokenguard-drift\]/)
  assert.match(context, /смена темы \(3\) — создать новый чат\?/)
  assert.match(context, /Тестовый чат/)
  assert.match(context, /chats digest/)
})

test('stays silent for a focused chat', () => {
  assert.equal(buildDriftContext({ session_id: 'abc' }, { exec: () => drift(0) }), null)
})

test('stays silent when the session is unknown or the CLI fails', () => {
  assert.equal(buildDriftContext({}, { exec: () => drift(2) }), null)
  assert.equal(buildDriftContext({ session_id: 'abc' }, { exec: () => null }), null)
  assert.equal(buildDriftContext({ session_id: 'abc' }, { exec: () => { throw new Error('boom') } }), null)
})

test('emits the hook protocol shape the DSH bridge understands', () => {
  assert.deepEqual(hookOutput('⚠️ тест'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '⚠️ тест' } })
})

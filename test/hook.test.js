import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildDriftContext, driftHookDisabled, hookOutput } from '../src/hooks/dsh-user-prompt.js'

const drift = (shifts) => ({
  session: { title: 'Тестовый чат' },
  messages: 30,
  analysis: { shifts: Array.from({ length: shifts }, (_, index) => ({ index })) },
})

test('injects the drift notice into model context', () => {
  let seen = null
  const context = buildDriftContext({ session_id: 'session-abc' }, { disabled: false, exec: (ref) => { seen = ref; return drift(3) } })
  assert.equal(seen, 'abc', 'session- prefix is stripped for the CLI')
  assert.match(context, /\[tokenguard-drift\]/)
  assert.match(context, /смена темы \(3\) — создать новый чат\?/)
  assert.match(context, /Тестовый чат/)
  assert.match(context, /chats digest/)
})

test('stays silent for a focused chat', () => {
  assert.equal(buildDriftContext({ session_id: 'abc' }, { disabled: false, exec: () => drift(0) }), null)
})

test('stays silent when the session is unknown or the CLI fails', () => {
  assert.equal(buildDriftContext({}, { disabled: false, exec: () => drift(2) }), null)
  assert.equal(buildDriftContext({ session_id: 'abc' }, { disabled: false, exec: () => null }), null)
  assert.equal(buildDriftContext({ session_id: 'abc' }, { disabled: false, exec: () => { throw new Error('boom') } }), null)
})

test('the config switch and the environment variable mute the hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hook-'))
  try {
    assert.equal(driftHookDisabled({ TOKENGUARD_HOME: dir }), false, 'no config → enabled')
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ driftHook: false }))
    assert.equal(driftHookDisabled({ TOKENGUARD_HOME: dir }), true)
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ driftHook: true }))
    assert.equal(driftHookDisabled({ TOKENGUARD_HOME: dir }), false)
    fs.writeFileSync(path.join(dir, 'config.json'), '{broken json')
    assert.equal(driftHookDisabled({ TOKENGUARD_HOME: dir }), false, 'a broken config never breaks the hook')
    assert.equal(driftHookDisabled({ TOKENGUARD_DRIFT_HOOK: '0' }), true)
    assert.equal(driftHookDisabled({ TOKENGUARD_DRIFT_HOOK: 'false' }), true)
    assert.equal(driftHookDisabled({ TOKENGUARD_DRIFT_HOOK: '1', TOKENGUARD_HOME: dir }), false, 'env=1 falls through to the (broken) config')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a muted hook never asks to start a new chat', () => {
  assert.equal(buildDriftContext({ session_id: 'abc' }, { disabled: true, exec: () => drift(4) }), null)
  assert.ok(buildDriftContext({ session_id: 'abc' }, { disabled: false, exec: () => drift(4) }))
})

test('emits the hook protocol shape the DSH bridge understands', () => {
  assert.deepEqual(hookOutput('⚠️ тест'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '⚠️ тест' } })
})

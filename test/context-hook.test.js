import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildContextContext, contextHookDisabled } from '../src/hooks/dsh-user-prompt.js'

const CONFIG = { contextHook: true, contextThreshold: '350k', contextHookCooldownMinutes: 45 }
const PAYLOAD = { session_id: 'session-abc123' }

function pressureRow({ id = 'abc123', lastPromptTokens = 500_000 } = {}) {
  return { sessions: [{ id, title: 'Тестовый чат', lastPromptTokens, requests: 100 }] }
}

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-context-hook-'))
  return path.join(dir, 'hooks', 'context-state.json')
}

test('contextHookDisabled: по умолчанию выключен, включается только contextHook=true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-hook-config-'))
  const env = { TOKENGUARD_HOME: dir, TOKENGUARD_CONTEXT_HOOK: '' }
  assert.equal(contextHookDisabled(env), true)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ contextHook: false }))
  assert.equal(contextHookDisabled(env), true)
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ contextHook: true }))
  assert.equal(contextHookDisabled(env), false)
  assert.equal(contextHookDisabled({ ...env, TOKENGUARD_CONTEXT_HOOK: '0' }), true)
})

test('buildContextContext: напоминание при превышении порога, с цифрами и командой', () => {
  const statePath = tempState()
  const message = buildContextContext(PAYLOAD, {
    config: CONFIG,
    disabled: false,
    exec: () => pressureRow(),
    now: 1_000_000,
    statePath,
  })
  assert.ok(message)
  assert.match(message, /\[tokenguard-context\]/)
  assert.match(message, /500K/)
  assert.match(message, /350K/)
  assert.match(message, /chats compact abc123/)
  assert.ok(fs.existsSync(statePath))
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(state.abc123.reminders, 1)
})

test('buildContextContext: кулдаун — не чаще раза в 45 минут', () => {
  const statePath = tempState()
  const options = { config: CONFIG, disabled: false, exec: () => pressureRow(), now: 1_000_000, statePath }
  assert.ok(buildContextContext(PAYLOAD, options))
  assert.equal(buildContextContext(PAYLOAD, { ...options, now: 1_000_000 + 10 * 60_000 }), null)
  assert.ok(buildContextContext(PAYLOAD, { ...options, now: 1_000_000 + 46 * 60_000 }))
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(state.abc123.reminders, 2)
})

test('buildContextContext: ниже порога, выключен или неизвестная сессия — молчит', () => {
  const options = { config: CONFIG, disabled: false, statePath: tempState(), now: 1_000_000 }
  assert.equal(buildContextContext(PAYLOAD, { ...options, exec: () => pressureRow({ lastPromptTokens: 100_000 }) }), null)
  assert.equal(buildContextContext(PAYLOAD, { ...options, disabled: true, exec: () => pressureRow() }), null)
  assert.equal(buildContextContext(PAYLOAD, { ...options, exec: () => ({ sessions: [{ id: 'other' }] }) }), null)
  assert.equal(buildContextContext({}, { ...options, exec: () => pressureRow() }), null)
  assert.equal(buildContextContext(PAYLOAD, { ...options, exec: () => null }), null)
})

test('buildContextContext: config без contextHook=true — молчит даже при exec', () => {
  const options = { disabled: false, statePath: tempState(), now: 1_000_000, exec: () => pressureRow() }
  assert.equal(buildContextContext(PAYLOAD, { ...options, config: {} }), null)
  assert.equal(buildContextContext(PAYLOAD, { ...options, config: { contextHook: false } }), null)
})

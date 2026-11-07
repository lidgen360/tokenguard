import test from 'node:test'
import assert from 'node:assert/strict'
import { hasSecrets, redactSecrets } from '../src/util/redact.js'

test('redactSecrets: маскирует ключи и пароли', () => {
  const text = [
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
    'password: hunter2',
    'Authorization: Bearer abcdef123456',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ].join('\n')
  const result = redactSecrets(text)
  assert.ok(result.count >= 4)
  assert.ok(!result.text.includes('hunter2'))
  assert.ok(!result.text.includes('sk-abcdefghijklmnop'))
  assert.ok(!result.text.includes('ghp_abcdefghijklmnop'))
  assert.ok(result.text.includes('СКРЫТО'))
})

test('redactSecrets: обычный текст не меняет', () => {
  const text = 'Проверили версию node и порт 8099, всё работает.'
  const result = redactSecrets(text)
  assert.equal(result.count, 0)
  assert.equal(result.text, text)
  assert.equal(hasSecrets(text), false)
})

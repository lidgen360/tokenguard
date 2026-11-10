import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'tokenguard.js')

function runJson(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-json-'))
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKENGUARD_HOME: path.join(home, '.tokenguard'),
    NO_COLOR: '1',
  }
  delete env.CCLINER_HOME
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env, encoding: 'utf8' })
  let data
  assert.doesNotThrow(() => {
    data = JSON.parse(result.stdout)
  }, `stdout должен быть JSON: ${result.stdout.slice(0, 200)}`)
  return { data, status: result.status, stderr: result.stderr, home }
}

test('--json контракт: пустые данные дают валидный JSON, а не текст', () => {
  const empty = [
    ['chats', 'pressure', '--json'],
    ['chats', 'drift', '--json'],
    ['chats', 'tools', '--json'],
    ['mcp', 'audit', '--json'],
    ['mcp', 'verify', '--json'],
    ['attachments', 'list', '--json'],
    ['attachments', 'clean', '--json'],
    ['doctor', '--json'],
    ['scan', '--json'],
    ['artifacts', 'list', '--json'],
  ]
  for (const args of empty) {
    const { data } = runJson(args)
    assert.equal(typeof data, 'object', `${args.join(' ')} → объект`)
    assert.ok(data !== null, `${args.join(' ')} → не null`)
  }
})

test('--json контракт: ошибки тоже JSON (код 1)', () => {
  const pressure = runJson(['chats', 'pressure', '--threshold', 'много', '--json'])
  assert.equal(pressure.status, 1)
  assert.match(pressure.data.error, /порог/)

  const drift = runJson(['chats', 'drift', '--json'])
  assert.equal(drift.status, 1)
  assert.match(drift.data.error, /сессий/)

  const tools = runJson(['chats', 'tools', '--json'])
  assert.equal(tools.status, 1)
  assert.match(tools.data.error, /сессий/)

  const verify = runJson(['mcp', 'verify', '--json'])
  assert.equal(verify.status, 1)
  assert.match(verify.data.error, /сервер|конфиг/i)
})

test('--json контракт: --client ошибки и списки', () => {
  const badClient = runJson(['chats', 'pressure', '--client', 'codex', '--json'])
  assert.equal(badClient.status, 1)
  assert.match(badClient.data.error, /codex/)

  const list = runJson(['chats', 'list', '--client', 'dsh', '--json'])
  assert.equal(list.status, 0)
  assert.ok(Array.isArray(list.data))
})

test('attachments clean --json: пропуск без вложений — JSON со skipped', () => {
  const { data, status } = runJson(['attachments', 'clean', '--json'])
  assert.equal(status, 0)
  assert.equal(data.skipped, true)
  assert.match(data.reason, /не найдены/)
})

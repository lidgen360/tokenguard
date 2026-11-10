import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'tokenguard.js')

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-doctor-'))
}

function runDoctor(home, extra = []) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TOKENGUARD_HOME: path.join(home, '.tokenguard'), NO_COLOR: '1' }
  delete env.CCLINER_HOME
  return spawnSync(process.execPath, [CLI, 'doctor', '--json', ...extra], { cwd: ROOT, env, encoding: 'utf8' })
}

function parse(result) {
  assert.equal(result.stderr, '', `stderr: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

test('doctor: чистое окружение — предупреждения без ошибок, код 0', () => {
  const home = tempHome()
  const result = runDoctor(home)
  assert.equal(result.status, 0)
  const data = parse(result)
  assert.ok(Array.isArray(data.checks) && data.checks.length >= 10)
  assert.equal(data.summary.fail, 0)
  assert.ok(data.summary.warn >= 1)
  const dataHome = data.checks.find((check) => check.id === 'data-home')
  assert.equal(dataHome.status, 'warn')
  assert.equal(data.checks.find((check) => check.id === 'node').status, 'ok')
})

test('doctor --strict: предупреждения дают код 1', () => {
  const home = tempHome()
  const result = runDoctor(home, ['--strict'])
  assert.equal(result.status, 1)
  assert.ok(parse(result).summary.warn >= 1)
})

test('doctor --fix: создаёт каталог данных и бэкапы с правами 700', () => {
  const home = tempHome()
  const first = parse(runDoctor(home, ['--fix']))
  assert.ok(first.fixes.length >= 2)
  const dataHome = path.join(home, '.tokenguard')
  assert.ok(fs.statSync(dataHome).isDirectory())
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dataHome).mode & 0o077, 0)
  }
  assert.ok(fs.statSync(path.join(dataHome, 'backups')).isDirectory())
  assert.equal(first.summary.fail, 0)

  const second = parse(runDoctor(home))
  assert.equal(second.checks.find((check) => check.id === 'data-home').status, 'ok')
  assert.equal(second.checks.find((check) => check.id === 'backups').status, 'ok')
})

test('doctor: битый config.json — ошибка и код 1', () => {
  const home = tempHome()
  const dataHome = path.join(home, '.tokenguard')
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dataHome, 'config.json'), '{oops')
  const result = runDoctor(home)
  assert.equal(result.status, 1)
  const data = parse(result)
  assert.ok(data.summary.fail >= 1)
  assert.equal(data.checks.find((check) => check.id === 'config').status, 'fail')
})

test('doctor --fix: отмечает удалёнными записи реестра с пропавшими файлами', () => {
  const home = tempHome()
  const dataHome = path.join(home, '.tokenguard')
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 })
  const manifest = path.join(dataHome, 'manifest.jsonl')
  fs.writeFileSync(manifest, `${JSON.stringify({ id: 'gone-1', ts: 1, kind: 'backup', action: 'create', path: '/nonexistent/tokenguard/x', meta: {} })}\n`)

  const before = parse(runDoctor(home))
  assert.equal(before.checks.find((check) => check.id === 'manifest').status, 'warn')

  const fixed = parse(runDoctor(home, ['--fix']))
  assert.ok(fixed.fixes.some((fix) => fix.id === 'manifest'))
  assert.equal(fixed.checks.find((check) => check.id === 'manifest').status, 'ok')
  assert.match(fs.readFileSync(manifest, 'utf8'), /"kind":"deleted"/)
})

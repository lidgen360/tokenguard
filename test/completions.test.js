import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'tokenguard.js')

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', ...env },
    encoding: 'utf8',
  })
}

test('completions bash: все команды и подкоманды', () => {
  const result = runCli(['completions', 'bash'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /complete -F _tokenguard tokenguard/)
  assert.match(result.stdout, /doctor/)
  assert.match(result.stdout, /attachments/)
  assert.match(result.stdout, /init/)
  assert.match(result.stdout, /verify/)
})

test('completions zsh и fish: валидные заголовки', () => {
  const zsh = runCli(['completions', 'zsh'])
  assert.equal(zsh.status, 0)
  assert.match(zsh.stdout, /#compdef tokenguard ccliner/)
  assert.match(zsh.stdout, /_tokenguard "\$@"/)

  const fish = runCli(['completions', 'fish'])
  assert.equal(fish.status, 0)
  assert.match(fish.stdout, /complete -c tokenguard/)
  assert.match(fish.stdout, /__fish_use_subcommand/)
})

test('completions --out: сохраняет файл', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-completions-'))
  const out = path.join(dir, 'nested', '_tokenguard')
  const result = runCli(['completions', 'zsh', '--out', out])
  assert.equal(result.status, 0)
  assert.match(fs.readFileSync(out, 'utf8'), /#compdef/)
})

test('completions: неизвестная оболочка — код 1', () => {
  const result = runCli(['completions', 'pwsh'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /bash, zsh, fish/)
})

test('init --apply: создаёт каталог данных и правило в AGENTS.md', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-init-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-init-root-'))
  const env = { HOME: home, USERPROFILE: home, TOKENGUARD_HOME: path.join(home, '.tokenguard') }
  delete env.CCLINER_HOME

  const result = runCli(['init', '--apply', '--json', '--root', root], env)
  assert.equal(result.status, 0)
  const data = JSON.parse(result.stdout)
  assert.equal(data.apply, true)
  const status = Object.fromEntries(data.steps.map((step) => [step.id, step.status]))
  assert.equal(status.data, 'ok')
  assert.equal(status.guard, 'ok')
  assert.ok(fs.existsSync(path.join(home, '.tokenguard', 'backups')))
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  assert.match(agents, /tokenguard:guard/)

  const second = runCli(['init', '--json', '--root', root], env)
  const again = JSON.parse(second.stdout)
  assert.equal(again.steps.find((step) => step.id === 'guard').status, 'ok')
  assert.equal(again.steps.find((step) => step.id === 'data').status, 'ok')
})

test('init без --apply: только план, ничего не меняет', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-init-dry-'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-init-dry-root-'))
  const env = { HOME: home, USERPROFILE: home, TOKENGUARD_HOME: path.join(home, '.tokenguard') }
  delete env.CCLINER_HOME

  const result = runCli(['init', '--json', '--root', root], env)
  assert.equal(result.status, 0)
  const data = JSON.parse(result.stdout)
  assert.equal(data.apply, false)
  assert.equal(data.steps.find((step) => step.id === 'guard').status, 'todo')
  assert.equal(data.steps.find((step) => step.id === 'data').status, 'todo')
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false)
  assert.equal(fs.existsSync(path.join(home, '.tokenguard')), false)
})

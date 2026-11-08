import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE = `# комментарий сверху
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1

# Safari MCP
- insert:
    - id: mcp-safari
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: safari
        transport: stdio
        command: /opt/homebrew/bin/npx
        args: ['-y', 'safari-mcp@2.23.0']
        toolCallTimeoutMs: 120000

# следующая запись, её трогать нельзя
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter:
        displayName: OpenRouter
`

test('patchDshProfile: точечно меняет блок и сохраняет остальное', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-patch-'))
  process.env.TOKENGUARD_HOME = home
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-profile-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, PROFILE)
  const { patchDshProfile } = await import('../src/commands/mcp.js')

  const result = await patchDshProfile(file, {
    name: 'safari',
    transport: 'stdio',
  }, '/tmp/wrapper/server.cjs', 600000)
  assert.equal(result.changed, true)
  const next = fs.readFileSync(file, 'utf8')
  assert.ok(next.includes('# комментарий сверху'), 'комментарий сверху сохранён')
  assert.ok(next.includes('# следующая запись, её трогать нельзя'), 'комментарий ниже сохранён')
  assert.ok(next.includes('/tmp/wrapper/server.cjs'), 'путь обёртки появился')
  assert.ok(next.includes('CCLINER_LAZY_IDLE_MS'), 'idle-переменная появилась')
  assert.ok(!next.includes('safari-mcp@2.23.0'), 'старая команда заменена')
  assert.ok(next.includes('openrouter'), 'соседняя запись не пострадала')

  // повторный вызов не должен ничего менять
  const again = await patchDshProfile(file, { name: 'safari', transport: 'stdio' }, '/tmp/wrapper/server.cjs', 600000)
  assert.equal(again.changed, false)
})

test('patchDshProfile: неизвестный сервер не ломает файл', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-patch-'))
  process.env.TOKENGUARD_HOME = home
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-profile-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, PROFILE)
  const before = fs.readFileSync(file, 'utf8')
  const { patchDshProfile } = await import('../src/commands/mcp.js')
  const result = await patchDshProfile(file, { name: 'nonexistent', transport: 'stdio' }, '/tmp/w.cjs', 1000)
  assert.equal(result.changed, false)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

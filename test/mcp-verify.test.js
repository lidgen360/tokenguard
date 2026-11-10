/** Проверка живой проверки MCP-серверов: `tokenguard mcp verify` и verifyServer(). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { verifyServer } from '../src/commands/mcp.js'

// Временный fixture-сервер: отвечает на initialize и tools/list, уведомления игнорирует.
const FIXTURE_SERVER = `#!/usr/bin/env node
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let newline = buffer.indexOf('\\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\\n')
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } })
    } else if (message.method === 'tools/list') {
      reply({ tools: [
        { name: 'echo', description: 'эхо', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'ping', description: 'пинг', inputSchema: { type: 'object', properties: {} } },
        { name: 'status', description: 'статус', inputSchema: { type: 'object', properties: {} } },
      ] })
    } else if (message.method !== 'notifications/initialized' && message.id !== undefined) {
      reply({})
    }
  }
})
`

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tokenguard-verify-'))
}

/** Локальный http-fixture: только loopback, внешних сетевых вызовов нет. */
function startHttpFixture() {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      const message = JSON.parse(body)
      if (message.id === undefined) {
        res.writeHead(202).end()
        return
      }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'http-fixture' } }
        : { tools: [{ name: 'http_echo' }, { name: 'http_ping' }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

test('verifyServer: stdio-сервер отвечает — ok, инструменты и латентность', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'fixture-server.mjs')
  fs.writeFileSync(file, FIXTURE_SERVER)
  const result = await verifyServer({
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [file],
    env: {},
  }, { timeout: 5 })
  assert.equal(result.ok, true)
  assert.equal(result.transport, 'stdio')
  assert.equal(result.toolCount, 3)
  assert.deepEqual(result.tools, ['echo', 'ping', 'status'])
  assert.equal(result.error, null)
  assert.ok(Number.isFinite(result.ms) && result.ms >= 0, 'латентность измерена')
  assert.equal(result.serverInfo?.name, 'fixture')
})

test('verifyServer: битая команда — fail с понятной ошибкой', async () => {
  const dir = tempDir()
  const result = await verifyServer({
    name: 'broken',
    transport: 'stdio',
    command: path.join(dir, 'no-such-mcp-server'),
    args: [],
  }, { timeout: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.toolCount, 0)
  assert.deepEqual(result.tools, [])
  assert.match(result.error, /не удалось запустить/)
})

test('verifyServer: сервер падает до ответа — fail без зависания', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'crash-server.mjs')
  fs.writeFileSync(file, "process.stderr.write('boom')\nprocess.exit(2)\n")
  const result = await verifyServer({
    name: 'crash',
    transport: 'stdio',
    command: process.execPath,
    args: [file],
  }, { timeout: 5 })
  assert.equal(result.ok, false)
  assert.equal(result.toolCount, 0)
  assert.ok(result.error && /завершился/.test(result.error), `ожидалась ошибка завершения: ${result.error}`)
})

test('verifyServer: http-сервер (локальный fixture) — ok и toolCount', async () => {
  const { server, url } = await startHttpFixture()
  try {
    const result = await verifyServer({ name: 'http', transport: 'http', url }, { timeout: 5 })
    assert.equal(result.ok, true)
    assert.equal(result.transport, 'http')
    assert.equal(result.toolCount, 2)
    assert.deepEqual(result.tools, ['http_echo', 'http_ping'])
    assert.equal(result.error, null)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('verifyServer: http-сервер без url — понятная ошибка', async () => {
  const result = await verifyServer({ name: 'no-url', transport: 'http' }, { timeout: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.transport, 'http')
  assert.match(result.error, /нет корректного url/)
})

test('verifyServer: недоступный http-адрес — fail, понятная ошибка без сети', async () => {
  // порт 1 на loopback закрыт: соединение отклоняется сразу, внешних вызовов нет
  const result = await verifyServer({ name: 'down', transport: 'http', url: 'http://127.0.0.1:1' }, { timeout: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.toolCount, 0)
  assert.match(result.error, /не удалось проверить http:\/\/127\.0\.0\.1:1/)
})

test('verifyServer: stdio-сервер без command — fail с подсказкой', async () => {
  const result = await verifyServer({ name: 'empty', transport: 'stdio' }, { timeout: 2 })
  assert.equal(result.ok, false)
  assert.match(result.error, /нет command/)
})

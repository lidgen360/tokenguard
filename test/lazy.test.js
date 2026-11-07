import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderLazyWrapper } from '../src/lazy/template.js'
import { probeMcpServer } from '../src/util/mcp-stdio.js'
import { spawn } from 'node:child_process'

const ECHO_SERVER = `#!/usr/bin/env node
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let newline = buffer.indexOf('\\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\\n')
    if (!line.trim()) continue
    const message = JSON.parse(line)
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } })
    } else if (message.method === 'tools/list') {
      reply({ tools: [
        { name: 'echo', description: 'повторяет текст', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
        { name: 'ping_tool', description: 'пинг', inputSchema: { type: 'object', properties: {} } },
      ] })
    } else if (message.method === 'tools/call') {
      const args = message.params?.arguments ?? {}
      if (message.params?.name === 'echo') reply({ content: [{ type: 'text', text: String(args.text ?? '') }] })
      else reply({ isError: true, content: [{ type: 'text', text: 'unknown tool' }] })
    } else if (message.id !== undefined) {
      reply({})
    }
  }
})
`

/** Мини-клиент: запускает MCP-сервер и вызывает последовательность методов. */
function runClient(serverFile, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    let nextId = 1
    const pending = new Map()
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 15_000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.id !== undefined && pending.has(message.id)) {
          const { ok, error } = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) error(new Error(message.error.message))
          else ok(message.result)
        }
      }
    })
    const call = (method, params) => new Promise((ok, error) => {
      const id = nextId++
      pending.set(id, { ok, error })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    ;(async () => {
      try {
        const results = []
        for (const [method, params] of calls) results.push(await call(method, params))
        clearTimeout(timer)
        child.kill()
        resolve(results)
      } catch (error) {
        clearTimeout(timer)
        child.kill()
        reject(error)
      }
    })()
  })
}

test('lazy wrapper: отдаёт 2 инструмента и проксирует вызовы по требованию', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-lazy-'))
  const upstream = path.join(dir, 'echo-server.cjs')
  fs.writeFileSync(upstream, ECHO_SERVER)
  const wrapper = path.join(dir, 'wrapper.cjs')
  fs.writeFileSync(wrapper, renderLazyWrapper({
    serverName: 'echo',
    upstream: { command: process.execPath, args: [upstream], env: {} },
    idleMs: 5_000,
  }))

  const probe = await probeMcpServer({ command: process.execPath, args: [wrapper] })
  assert.equal(probe.ok, true)
  assert.equal(probe.tools.length, 2)
  assert.deepEqual(probe.tools.map((tool) => tool.name), ['list_tools', 'call_tool'])

  const results = await runClient(wrapper, [
    ['initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }],
    ['tools/call', { name: 'list_tools', arguments: {} }],
    ['tools/call', { name: 'call_tool', arguments: { tool: 'echo', arguments: { text: 'привет' } } }],
  ])
  const tools = JSON.parse(results[1].content[0].text)
  assert.equal(tools.length, 2)
  assert.equal(results[2].content[0].text, 'привет')
})

test('lazy wrapper: ошибка при неизвестном инструменте', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccliner-lazy-'))
  const upstream = path.join(dir, 'echo-server.cjs')
  fs.writeFileSync(upstream, ECHO_SERVER)
  const wrapper = path.join(dir, 'wrapper.cjs')
  fs.writeFileSync(wrapper, renderLazyWrapper({
    serverName: 'echo',
    upstream: { command: process.execPath, args: [upstream], env: {} },
    idleMs: 5_000,
  }))
  const results = await runClient(wrapper, [
    ['initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }],
    ['tools/call', { name: 'nope', arguments: {} }],
  ])
  assert.equal(results[1].isError, true)
})

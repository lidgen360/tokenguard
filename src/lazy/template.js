/** Генератор ленивого MCP-прокси без зависимостей (CommonJS, raw JSON-RPC). */

export function renderLazyWrapper({ serverName, upstream, idleMs = 600_000 }) {
  const config = {
    serverName,
    command: upstream.command,
    args: upstream.args ?? [],
    env: upstream.env ?? {},
  }
  return `#!/usr/bin/env node
/* ccliner lazy MCP proxy for "${config.serverName}" — generated file, do not edit by hand. */
'use strict'
const { spawn } = require('node:child_process')

const CONFIG = ${JSON.stringify(config, null, 2)}
const IDLE_MS = Number(process.env.CCLINER_LAZY_IDLE_MS || ${Number(idleMs)})
const TOOLS = [
  {
    name: 'list_tools',
    description: 'Вернуть список инструментов сервера "${config.serverName}" (JSON: name, description, inputSchema). Вызывай один раз, затем используй call_tool.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'call_tool',
    description: 'Вызвать инструмент сервера "${config.serverName}" из list_tools. Сервер запускается по требованию и засыпает после простоя.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Имя инструмента из list_tools' },
        arguments: { type: 'object', description: 'Аргументы инструмента', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  },
]

let child = null
let ready = null
let idleTimer = null
let cachedTools = null
let nextUpstreamId = 1
const pending = new Map()

function log(...args) {
  if (process.env.CCLINER_LAZY_DEBUG) process.stderr.write('[ccliner-lazy] ' + args.join(' ') + '\\n')
}

function writeClient(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => stopUpstream('idle'), IDLE_MS)
  if (typeof idleTimer.unref === 'function') idleTimer.unref()
}

function stopUpstream(reason) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (!child) return
  try { child.kill('SIGTERM') } catch { /* уже мёртв */ }
  log('upstream stopped:', reason)
  child = null
  ready = null
  cachedTools = null
}

function ensureUpstream() {
  if (ready) { touchIdle(); return ready }
  ready = new Promise((resolve, reject) => {
    const spawned = spawn(CONFIG.command, CONFIG.args, {
      env: { ...process.env, ...CONFIG.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = spawned
    let buffer = ''
    let finished = false

    const fail = (error) => {
      if (finished) return
      finished = true
      try { spawned.kill('SIGTERM') } catch { /* noop */ }
      child = null
      ready = null
      cachedTools = null
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    spawned.on('error', fail)
    spawned.on('exit', (code) => {
      log('upstream exit', code)
      if (!finished) { finished = true; child = null; ready = null; cachedTools = null; reject(new Error('upstream завершился')) }
    })
    spawned.stderr.on('data', (chunk) => log(String(chunk).trim()))
    spawned.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\\n')
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== undefined && pending.has(message.id)) {
          const { ok, error } = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) error(new Error(message.error.message || 'upstream error'))
          else ok(message.result)
        }
      }
    })

    const call = (method, params) => new Promise((ok, error) => {
      const id = nextUpstreamId
      nextUpstreamId += 1
      pending.set(id, { ok, error })
      spawned.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
    })

    call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ccliner-lazy', version: '0.1.0' },
    })
      .then(() => {
        spawned.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n')
        return call('tools/list', {})
      })
      .then((result) => {
        cachedTools = (result.tools || []).map((tool) => ({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || {},
        }))
        finished = true
        touchIdle()
        resolve({ call })
      })
      .catch(fail)
  })
  return ready
}

async function handleRequest(message) {
  const { id, method, params } = message
  const reply = (result) => writeClient({ jsonrpc: '2.0', id, result })
  const failRpc = (code, text) => writeClient({ jsonrpc: '2.0', id, error: { code, message: text } })
  try {
    if (method === 'initialize') {
      reply({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: CONFIG.serverName + '-lazy', version: '0.1.0' },
      })
      return
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
    if (method === 'ping') { reply({}); return }
    if (method === 'tools/list') { reply({ tools: TOOLS }); return }
    if (method === 'resources/list') { reply({ resources: [] }); return }
    if (method === 'prompts/list') { reply({ prompts: [] }); return }
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments || {}
      if (name === 'list_tools') {
        await ensureUpstream()
        reply({ content: [{ type: 'text', text: JSON.stringify(cachedTools) }] })
        return
      }
      if (name === 'call_tool') {
        const tool = String(args.tool || '').trim()
        if (!tool) {
          reply({ isError: true, content: [{ type: 'text', text: 'call_tool: не указан tool' }] })
          return
        }
        const upstream = await ensureUpstream()
        const result = await upstream.call('tools/call', {
          name: tool,
          arguments: args.arguments && typeof args.arguments === 'object' ? args.arguments : {},
        })
        touchIdle()
        reply(result)
        return
      }
      reply({ isError: true, content: [{ type: 'text', text: 'неизвестный инструмент: ' + name }] })
      return
    }
    if (ready) {
      const upstream = await ready
      const result = await upstream.call(method, params)
      reply(result)
      return
    }
    failRpc(-32601, 'method not supported: ' + method)
  } catch (error) {
    failRpc(-32603, String(error?.message || error))
  }
}

let inputBuffer = ''
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString('utf8')
  let newline = inputBuffer.indexOf('\\n')
  while (newline >= 0) {
    const line = inputBuffer.slice(0, newline)
    inputBuffer = inputBuffer.slice(newline + 1)
    newline = inputBuffer.indexOf('\\n')
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    handleRequest(message).catch((error) => log('handler error:', error?.message || error))
  }
})
process.stdin.on('end', () => { stopUpstream('stdin closed'); process.exit(0) })
process.on('SIGTERM', () => { stopUpstream('SIGTERM'); process.exit(0) })
process.on('SIGINT', () => { stopUpstream('SIGINT'); process.exit(0) })
log('started, idle ms =', IDLE_MS)
`
}

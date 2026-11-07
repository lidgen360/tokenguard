/** Минимальный MCP-клиент по stdio: probe-запрос tools/list.
 *  Нужен, чтобы измерить, сколько инструментов публикует MCP-сервер и
 *  сколько токенов занимают их схемы. Работает без SDK. */
import { spawn } from 'node:child_process'
import { estimateTokens } from './tokens.js'

const PROTOCOL_VERSION = '2024-11-05'

/** Запустить MCP-сервер, сделать initialize + tools/list, погасить. */
export function probeMcpServer({ command, args = [], env = {}, cwd, timeoutMs = 25_000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let nextId = 1
    const pending = new Map()
    const timer = setTimeout(() => finish({ ok: false, error: 'таймаут probe' }), timeoutMs)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGTERM')
      resolve({ ...result, ms: Date.now() - startedAt })
    }

    function send(message) {
      if (child.exitCode !== null) return
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    function request(method, params) {
      return new Promise((res, rej) => {
        const id = nextId
        nextId += 1
        pending.set(id, { res, rej })
        send({ jsonrpc: '2.0', id, method, params })
      })
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        newline = stdout.indexOf('\n')
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id !== undefined && pending.has(message.id)) {
          const { res, rej } = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) rej(new Error(message.error.message ?? 'MCP error'))
          else res(message.result)
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('exit', () => {
      if (!settled && pending.size > 0) finish({ ok: false, error: `сервер завершился: ${stderr.trim().slice(0, 300)}` })
    })

    ;(async () => {
      try {
        const init = await request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'tokenguard', version: '0.1.0' },
        })
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const listed = await request('tools/list', {})
        const tools = (listed?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? {},
        }))
        finish({ ok: true, tools, serverInfo: init?.serverInfo ?? null })
      } catch (error) {
        finish({ ok: false, error: error.message })
      }
    })()
  })
}

/** Оценка токенов схем инструментов (как их видит модель). */
export function schemasTokens(tools) {
  return estimateTokens(JSON.stringify((tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }))))
}

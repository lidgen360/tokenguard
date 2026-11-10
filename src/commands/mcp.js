/** mcp: аудит MCP-серверов, живая проверка и перевод их в ленивый режим. */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { claudeDesktopConfigPath, discoverConfigs, scanUsage } from '../adapters/mcp-configs.js'
import { probeMcpServer, schemasTokens } from '../util/mcp-stdio.js'
import { renderLazyWrapper } from '../lazy/template.js'
import { backupPaths } from '../util/backup.js'
import { DATA_HOME, HOME, ensureDir, exists, readJson, writeFile, timeAgo, ageDays } from '../util/files.js'
import { sanitizeName } from '../util/naming.js'
import { recordArtifact } from '../util/manifest.js'
import { printTable, info, ok, warn, bold, dim } from '../log.js'

export const VALUE_FLAGS = ['root', 'client', 'idle', 'server', 'out', 'min-tokens', 'interval', 'timeout']

const HELP = `${bold('tokenguard mcp')} — аудит, живая проверка и ленивый режим

  tokenguard mcp audit [--probe] [--json]
      Найти MCP-конфиги всех клиентов, посчитать инструменты и токены схем (--probe),
      показать фактическое использование и предложить ленивый режим.

  tokenguard mcp verify <server> [--timeout 15] [--json]
  tokenguard mcp verify --all [--timeout 15] [--json]
      Живая проверка: запустить сервер и пройти initialize + tools/list.
      Показать ok/fail, число инструментов, латентность и ошибку.
      --all — все серверы из найденных конфигов; exit 1, если хоть один упал.

  tokenguard mcp lazy <server> [--client <клиент>] [--idle 10] [--apply]
  tokenguard mcp lazy --all [--apply] [--apply-dsh]
      Сгенерировать ленивый прокси (2 инструмента, запуск по требованию)
      и, для JSON-клиентов, сразу переписать конфиг (с бэкапом).
      --all — перевести все stdio-серверы, кроме уже ленивых.
      --apply-dsh — точечно заменить блоки в профилях DSH (бэкап + проверка YAML).

  tokenguard mcp watch [--once] [--interval 300] [--apply] [--apply-dsh]
      Кроссплатформенный наблюдатель: ловит изменения MCP-конфигов и включает lazy.
      Подходит для systemd/launchd/Task Scheduler; --once — один прогон.
`

export async function run(positional, flags) {
  const sub = positional[0]
  if (sub === 'audit') return audit(flags)
  if (sub === 'verify') return verify(positional[1], flags)
  if (sub === 'lazy') return flags.all ? lazyAll(flags) : lazy(positional[1], flags)
  if (sub === 'watch') return watchCommand(flags)
  console.log(HELP)
  return 0
}

const VERIFY_PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_VERIFY_TIMEOUT = 15

/** Разобрать таймаут в секундах: число больше нуля или значение по умолчанию. */
function normalizeTimeout(value) {
  const seconds = Number(value ?? DEFAULT_VERIFY_TIMEOUT)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_VERIFY_TIMEOUT
}

/**
 * Живая проверка одного MCP-сервера: initialize → notifications/initialized → tools/list.
 * stdio-сервер запускается как дочерний процесс и гарантированно гасится (SIGTERM, затем SIGKILL).
 * http(s)-сервер опрашивается POST-запросами с AbortController-таймаутом.
 * Возвращает { name, transport, ok, toolCount, tools, serverInfo, error, ms }.
 * @param {{name?: string, transport?: string, command?: string, args?: string[], env?: object, url?: string}} server
 * @param {{timeout?: number}} [options] таймаут в секундах
 */
export async function verifyServer(server, options = {}) {
  const target = server && typeof server === 'object' ? server : {}
  const timeoutSec = normalizeTimeout(options.timeout)
  const startedAt = Date.now()
  const isHttp = Boolean(target.url) || target.transport === 'http' || target.transport === 'sse'
  const transport = isHttp ? (target.transport === 'sse' ? 'sse' : 'http') : 'stdio'
  const checked = isHttp
    ? await verifyHttpServer(target, timeoutSec)
    : await verifyStdioServer(target, timeoutSec)
  return {
    name: String(target.name ?? ''),
    transport,
    ok: Boolean(checked.ok),
    toolCount: Number(checked.toolCount ?? 0),
    tools: Array.isArray(checked.tools) ? checked.tools : [],
    serverInfo: checked.serverInfo ?? null,
    error: checked.ok ? null : String(checked.error ?? 'неизвестная ошибка'),
    ms: Date.now() - startedAt,
  }
}

/** Проверить stdio-сервер: spawn, JSON-RPC по строкам, таймаут и аккуратное убийство. */
function verifyStdioServer(server, timeoutSec) {
  return new Promise((resolve) => {
    const command = server.command ? String(server.command) : ''
    if (!command) {
      resolve({ ok: false, toolCount: 0, tools: [], error: 'у stdio-сервера нет command — проверять нечего' })
      return
    }
    const args = Array.isArray(server.args) ? server.args.map(String) : []
    const env = server.env && typeof server.env === 'object' ? server.env : {}
    let child
    try {
      child = spawn(command, args, {
        cwd: server.cwd ? String(server.cwd) : undefined,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, toolCount: 0, tools: [], error: `не удалось запустить «${command}»: ${error.message}` })
      return
    }

    let buffer = ''
    let stderr = ''
    let settled = false
    let nextId = 1
    const pending = new Map()
    const timer = setTimeout(() => {
      finish({ ok: false, toolCount: 0, tools: [], error: `таймаут ${timeoutSec}с: сервер не ответил на initialize/tools/list` })
    }, timeoutSec * 1000)

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const { rejectPending } of pending.values()) rejectPending(new Error('проверка завершена'))
      pending.clear()
      stopChild(child)
      resolve(result)
    }

    function send(message) {
      if (settled || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) return
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch {
        /* процесс уже закрыл stdin */
      }
    }

    function request(method, params) {
      return new Promise((res, rej) => {
        const id = nextId
        nextId += 1
        pending.set(id, { res, rejectPending: rej })
        send({ jsonrpc: '2.0', id, method, params })
      })
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        const message = safeParseJson(line)
        if (!message || message.id === undefined || !pending.has(message.id)) continue
        const { res, rejectPending } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rejectPending(new Error(message.error.message ?? 'MCP: ошибка в ответе'))
        else res(message.result)
      }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
    child.stdin.on('error', () => { /* сервер мог закрыть stdin */ })
    child.on('error', (error) => {
      finish({ ok: false, toolCount: 0, tools: [], error: `не удалось запустить «${command}»: ${error.message}` })
    })
    child.on('exit', (code) => {
      if (settled || pending.size === 0) return
      const tail = stderr.trim().replace(/\s+/g, ' ').slice(0, 300)
      finish({ ok: false, toolCount: 0, tools: [], error: `сервер завершился (код ${code ?? '—'}) до ответа${tail ? `: ${tail}` : ''}` })
    })

    ;(async () => {
      try {
        const initialized = await request('initialize', {
          protocolVersion: VERIFY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'tokenguard', version: '0.1.0' },
        })
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const listed = await request('tools/list', {})
        const tools = Array.isArray(listed?.tools) ? listed.tools : []
        finish({
          ok: true,
          toolCount: tools.length,
          tools: tools.map((tool) => String(tool?.name ?? '')),
          serverInfo: initialized?.serverInfo ?? null,
        })
      } catch (error) {
        finish({ ok: false, toolCount: 0, tools: [], error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
}

/** Погасить дочерний процесс: SIGTERM, затем SIGKILL через 500 мс, если не умер. */
function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.stdin.end()
  } catch {
    /* stdin уже закрыт */
  }
  try {
    child.kill('SIGTERM')
  } catch {
    /* процесс уже завершился */
  }
  const forceKill = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill('SIGKILL')
    } catch {
      /* процесс уже завершился */
    }
  }, 500)
  forceKill.unref()
}

/** Проверить http(s)-сервер: POST initialize → notifications/initialized → tools/list. */
async function verifyHttpServer(server, timeoutSec) {
  const url = server.url ? String(server.url) : ''
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, toolCount: 0, tools: [], error: `у http-сервера «${server.name ?? ''}» нет корректного url` }
  }
  const timeoutMs = timeoutSec * 1000
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(server.headers && typeof server.headers === 'object' ? server.headers : {}),
  }
  let sessionId = null
  const post = async (payload) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers = sessionId ? { ...baseHeaders, 'mcp-session-id': sessionId } : baseHeaders
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const session = response.headers.get('mcp-session-id')
      if (session) sessionId = session
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, 200)
        throw new Error(`HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`)
      }
      if (payload.id === undefined) return null
      return await readJsonRpcResponse(response, payload.id)
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const initialized = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: VERIFY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'tokenguard', version: '0.1.0' },
      },
    })
    try {
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    } catch {
      /* уведомление необязательно: часть серверов отвечает 202 или 405 */
    }
    const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    return {
      ok: true,
      toolCount: tools.length,
      tools: tools.map((tool) => String(tool?.name ?? '')),
      serverInfo: initialized?.serverInfo ?? null,
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ok: false, toolCount: 0, tools: [], error: `таймаут ${timeoutSec}с: ${url} не ответил` }
    }
    const hint = server.transport === 'sse' ? ' (legacy SSE не поддержан — нужен Streamable HTTP)' : ''
    return { ok: false, toolCount: 0, tools: [], error: `не удалось проверить ${url}: ${error.message}${hint}` }
  }
}

/** Достать JSON-RPC-ответ из обычного JSON или SSE-потока (Streamable HTTP). */
async function readJsonRpcResponse(response, id) {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const message = safeParseJson(line.slice(5).trim())
      if (!message || message.id !== id) continue
      if (message.error) throw new Error(message.error.message ?? 'MCP: ошибка в ответе')
      return message.result
    }
    throw new Error('сервер не прислал JSON-RPC-ответ в SSE-потоке')
  }
  const message = safeParseJson(await response.text())
  if (!message) throw new Error('ответ сервера — не JSON-RPC')
  if (message.error) throw new Error(message.error.message ?? 'MCP: ошибка в ответе')
  return message.result
}

function safeParseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Живая проверка серверов из конфигов: `tokenguard mcp verify <server>|--all`. */
async function verify(serverName, flags) {
  const timeoutSec = normalizeTimeout(flags.timeout)
  const root = flags.root ? path.resolve(String(flags.root)) : process.cwd()
  const configs = await discoverConfigs({ root })
  const known = []
  for (const config of configs) {
    for (const server of config.servers) known.push({ client: config.client, server })
  }
  if (known.length === 0) {
    if (flags.json) console.log(JSON.stringify({ error: 'MCP-конфиги не найдены' }, null, 2))
    else warn('MCP-конфиги не найдены (DSH, Claude, Codex, Gemini, Cursor, VS Code)')
    return 1
  }
  let targets
  if (flags.all) {
    targets = known
  } else if (serverName) {
    const clientFilter = flags.client ? String(flags.client).toLowerCase() : null
    targets = known.filter(({ client, server }) => server.name === serverName
      && (!clientFilter || client.toLowerCase().includes(clientFilter)))
    if (targets.length === 0) {
      const message = `MCP-сервер «${serverName}» не найден в конфигах`
      if (flags.json) console.log(JSON.stringify({ error: message }, null, 2))
      else warn(message)
      return 1
    }
  } else {
    const message = 'укажи сервер или --all: tokenguard mcp verify <server> | tokenguard mcp verify --all'
    if (flags.json) console.log(JSON.stringify({ error: message }, null, 2))
    else warn(message)
    return 1
  }
  const results = []
  for (const { client, server } of targets) {
    results.push({ client, ...(await verifyServer(server, { timeout: timeoutSec })) })
  }
  const failed = results.filter((result) => !result.ok).length
  if (flags.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    printTable(
      ['Клиент', 'Сервер', 'Транспорт', 'Итог', 'Инстр.', 'Латентность', 'Ошибка'],
      results.map((result) => [
        result.client,
        result.name,
        result.transport,
        result.ok ? 'ok' : 'fail',
        result.toolCount,
        `${result.ms} мс`,
        result.ok ? '' : String(result.error ?? '').slice(0, 80),
      ]),
    )
    info(`проверено серверов: ${results.length}, ok: ${results.length - failed}, fail: ${failed}`)
    if (failed > 0) info('ни один конфиг не изменён: verify ничего не пишет на диск')
  }
  return failed === 0 ? 0 : 1
}

async function audit(flags) {
  const root = flags.root ? String(flags.root) : process.cwd()
  const configs = await discoverConfigs({ root })
  const usage = scanUsage()
  const probe = Boolean(flags.probe)
  const minTokens = Number(flags['min-tokens'] ?? 2000)
  const rows = []
  const totals = { servers: 0, probed: 0, tools: 0, tokens: 0, lazy: 0 }
  if (configs.length === 0) {
    if (flags.json) {
      console.log(JSON.stringify({ configs: [], rows: [], totals: { servers: 0, probed: 0, tools: 0, tokens: 0, lazy: 0 } }, null, 2))
      return 0
    }
    warn('MCP-конфиги не найдены (DSH, Claude, Codex, Gemini, Cursor, VS Code)')
    return 0
  }
  for (const config of configs) {
    for (const server of config.servers) {
      totals.servers += 1
      const used = usage.get(server.name)
      let tools = null
      let tokens = null
      let probeError = null
      if (probe && server.transport === 'stdio' && server.command) {
        const result = await probeMcpServer({ command: server.command, args: server.args, env: server.env })
        if (result.ok) {
          tools = result.tools.length
          tokens = schemasTokens(result.tools)
          totals.probed += 1
          totals.tools += tools
          totals.tokens += tokens
        } else {
          probeError = result.error
        }
      }
      const stale = !used || ageDays(used.lastTime) > 14
      let verdict = 'ок'
      if (server.lazyWrapper) {
        verdict = 'lazy ✓'
      } else if (tokens !== null) {
        if (tokens >= minTokens && stale) verdict = `lazy (−${tokens}т)`
        else if (tokens >= minTokens) verdict = 'core-фильтр'
        else verdict = 'ок'
        if (tokens >= minTokens && stale) totals.lazy += 1
      } else if (!used) {
        verdict = 'не использовался'
      }
      rows.push([
        config.client,
        server.name,
        server.transport,
        probeError ? 'ошибка' : (tools ?? '?'),
        tokens === null ? '?' : `~${tokens}`,
        used ? used.calls : 0,
        used ? timeAgo(used.lastTime) : '—',
        verdict,
      ])
    }
  }
  if (flags.json) {
    console.log(JSON.stringify({ configs, rows, totals }, null, 2))
    return 0
  }
  printTable(['Клиент', 'Сервер', 'Транспорт', 'Инстр.', '~Токенов', 'Вызовов', 'Последний', 'Вердикт'], rows)
  if (probe) {
    info(`всего серверов: ${totals.servers}, опрошено: ${totals.probed}, инструментов: ${totals.tools}, схемы ≈ ${totals.tokens} токенов`)
    if (totals.lazy > 0) info(`кандидатов в lazy-режим: ${totals.lazy} — «tokenguard mcp lazy <server>» даёт −(токены на запрос)`)
  } else {
    info(`всего серверов: ${totals.servers}. Запусти с --probe, чтобы измерить инструменты и токены схем.`)
  }
  return 0
}

async function lazy(serverName, flags) {
  if (!serverName) {
    warn('укажи имя сервера: tokenguard mcp lazy <server>')
    return 1
  }
  const root = flags.root ? String(flags.root) : process.cwd()
  const configs = await discoverConfigs({ root })
  const candidates = []
  for (const config of configs) {
    for (const server of config.servers) {
      if (server.name === serverName) candidates.push({ config, server })
    }
  }
  if (candidates.length === 0) {
    warn(`MCP-сервер «${serverName}» не найден в конфигах`)
    return 1
  }
  const chosen = flags.client
    ? candidates.find((candidate) => candidate.config.client.toLowerCase().includes(String(flags.client).toLowerCase()))
    : candidates[0]
  if (!chosen) {
    warn(`сервер найден, но не у клиента «${flags.client}»`)
    return 1
  }
  const { server, config } = chosen
  if (server.transport !== 'stdio' || !server.command) {
    warn('lazy-режим поддержан только для stdio-серверов с command')
    return 1
  }
  const idleMinutes = Number(flags.idle ?? 10)
  const idleMs = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60_000 : 600_000
  const outFile = flags.out
    ? path.resolve(String(flags.out))
    : path.join(DATA_HOME, 'lazy', sanitizeName(server.name), 'server.cjs')
  ensureDir(path.dirname(outFile))
  writeFile(outFile, renderLazyWrapper({
    serverName: server.name,
    upstream: { command: server.command, args: server.args, env: server.env },
    idleMs,
  }))
  recordArtifact({ kind: 'lazy-proxy', action: 'create', path: outFile, meta: { server: server.name } })
  ok(`ленивый прокси: ${outFile}`)

  // проверяем, что прокси поднимается и отдаёт ровно 2 инструмента
  const check = await probeMcpServer({ command: process.execPath, args: [outFile], timeoutMs: 20_000 })
  if (check.ok) {
    ok(`проверка: прокси отвечает, инструментов ${check.tools.length} (${check.tools.map((tool) => tool.name).join(', ')})`)
  } else {
    warn(`проверка прокси не удалась: ${check.error}`)
  }

  if (config.format === 'json') {
    if (flags.apply) {
      const backup = backupPaths([config.file], 'mcp-config')
      const data = readJson(config.file) ?? {}
      const key = config.client.includes('VS Code') ? 'servers' : 'mcpServers'
      data[key] = data[key] ?? {}
      data[key][server.name] = { command: process.execPath, args: [outFile] }
      writeFile(config.file, `${JSON.stringify(data, null, 2)}\n`)
      ok(`конфиг обновлён: ${config.file}`)
      info(`бэкап: ${backup}`)
    } else {
      console.log('')
      info('добавь --apply, чтобы переписать конфиг автоматически; либо вставь вручную:')
      console.log(JSON.stringify({ [server.name]: { command: process.execPath, args: [outFile] } }, null, 2))
    }
    return 0
  }

  // DSH (yaml): с --apply-dsh точечно патчим блок, иначе печатаем готовый сниппет
  if (flags['apply-dsh']) {
    const result = patchDshProfile(config.file, server, outFile, idleMs)
    if (result.changed) ok(`профиль DSH обновлён: ${config.file}`)
    else warn(`профиль DSH не изменён: ${result.reason}`)
    if (result.backup) info(`бэкап: ${result.backup}`)
    info('DSH подхватит конфиг после перезапуска (AI-Stop + AI-Start)')
    return 0
  }
  console.log('')
  info('вставь этот блок в ~/.dsh/profiles/<profile>/cordis.patch.yml (вместо текущей записи сервера):')
  console.log(renderDshPatch(server.name, outFile, idleMs))
  return 0
}

function renderDshPatch(name, wrapper, idleMs) {
  const lines = [
    '- insert:',
    `    - id: mcp-${name}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${name}`,
    '        transport: stdio',
    `        command: ${process.execPath}`,
    `        args: [${JSON.stringify(wrapper)}]`,
    '        env:',
    `          CCLINER_LAZY_IDLE_MS: '${idleMs}'`,
    '        toolCallTimeoutMs: 180000',
  ]
  return lines.join('\n')
}

/** Перевести в ленивый режим все stdio-серверы из всех найденных конфигов. */
export async function lazyAll(flags) {
  const root = flags.root ? String(flags.root) : process.cwd()
  const configs = await discoverConfigs({ root })
  const done = []
  const dshSnippets = []
  for (const config of configs) {
    for (const server of config.servers) {
      if (server.lazyWrapper) {
        done.push({ client: config.client, name: server.name, status: 'уже ленивый' })
        continue
      }
      if (server.transport !== 'stdio' || !server.command) {
        done.push({ client: config.client, name: server.name, status: 'пропущен (не stdio)' })
        continue
      }
      const idleMinutes = Number(flags.idle ?? 10)
      const idleMs = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60_000 : 600_000
      const outFile = path.join(DATA_HOME, 'lazy', sanitizeName(server.name), 'server.cjs')
      ensureDir(path.dirname(outFile))
      writeFile(outFile, renderLazyWrapper({
        serverName: server.name,
        upstream: { command: server.command, args: server.args, env: server.env },
        idleMs,
      }))
      recordArtifact({ kind: 'lazy-proxy', action: 'create', path: outFile, meta: { server: server.name, auto: true } })
      const probe = await probeMcpServer({ command: process.execPath, args: [outFile], timeoutMs: 20_000 })
      const status = probe.ok ? `прокси ок (${probe.tools.length} инстр.)` : `ошибка: ${probe.error}`
      if (config.format === 'json') {
        if (flags.apply) {
          const backup = backupPaths([config.file], 'mcp-config')
          const data = readJson(config.file) ?? {}
          const key = config.client.includes('VS Code') ? 'servers' : 'mcpServers'
          data[key] = data[key] ?? {}
          data[key][server.name] = { command: process.execPath, args: [outFile] }
          writeFile(config.file, `${JSON.stringify(data, null, 2)}\n`)
          done.push({ client: config.client, name: server.name, status: `${status}; конфиг обновлён (бэкап ${backup})` })
        } else {
          done.push({ client: config.client, name: server.name, status: `${status}; добавь --apply для правки конфига` })
        }
      } else if (flags['apply-dsh']) {
        const patched = patchDshProfile(config.file, server, outFile, idleMs)
        done.push({
          client: config.client,
          name: server.name,
          status: patched.changed
            ? `${status}; профиль обновлён (бэкап: ${patched.backup ?? '—'})`
            : `${status}; ${patched.reason}`,
        })
      } else {
        done.push({ client: config.client, name: server.name, status: status })
        dshSnippets.push(renderDshPatch(server.name, outFile, idleMs))
      }
    }
  }
  printTable(
    ['Клиент', 'Сервер', 'Результат'],
    done.map((item) => [item.client, item.name, item.status]),
  )
  if (dshSnippets.length > 0) {
    console.log('')
    info('для DSH вставь эти блоки в ~/.dsh/profiles/<profile>/cordis.patch.yml:')
    console.log(dshSnippets.join('\n\n'))
  }
  if (done.length === 0) warn('MCP-серверы не найдены')
  return 0
}

/**
 * Точечно заменить блок сервера в cordis.patch.yml на ленивую обёртку.
 * Не переписывает весь YAML: заменяется только нужный блок, остальное и комментарии сохраняются.
 * Перед записью — бэкап; после записи YAML проверяется парсером, при ошибке файл восстанавливается.
 */
export async function patchDshProfile(file, server, wrapperFile, idleMs) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const idLine = new RegExp(`^(\\s*)-\\s+id:\\s*mcp-${escapeRegExp(server.name)}\\s*$`)
  let start = -1
  let indent = ''
  for (let index = 0; index < lines.length; index += 1) {
    const match = idLine.exec(lines[index])
    if (match) {
      start = index
      indent = match[1]
      break
    }
  }
  if (start < 0) return { changed: false, reason: `блок mcp-${server.name} в профиле не найден` }
  let end = lines.length
  const indentLength = indent.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) {
      end = index
      break
    }
    const leading = line.match(/^\s*/)[0].length
    if (leading <= indentLength) {
      end = index
      break
    }
  }
  const block = lines.slice(start, end).join('\n')
  if (/(mcp-lazy|\/lazy\/|\.tokenguard|\/tokenguard\/|wrapper)/.test(block) && /server\.(mjs|cjs)/.test(block)) {
    return { changed: false, reason: 'уже использует ленивую обёртку' }
  }
  const child = `${indent}  `
  const inner = `${child}  `
  const replacement = [
    `${indent}- id: mcp-${server.name}`,
    `${child}name: '@deepseek-ai/dsh-mcp-client'`,
    `${child}config:`,
    `${inner}serverName: ${JSON.stringify(server.name)}`,
    `${inner}transport: ${JSON.stringify(server.transport ?? 'stdio')}`,
    `${inner}command: ${JSON.stringify(process.execPath)}`,
    `${inner}args: [${JSON.stringify(wrapperFile)}]`,
    `${inner}env:`,
    `${inner}  CCLINER_LAZY_IDLE_MS: '${idleMs}'`,
    `${inner}toolCallTimeoutMs: 180000`,
  ]
  const nextLines = [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
  const nextText = nextLines.join('\n')
  const { parse: parseYaml } = await import('yaml')
  try {
    parseYaml(nextText)
  } catch (error) {
    return { changed: false, reason: `результат не прошёл проверку YAML: ${error.message}` }
  }
  const backup = backupPaths([file], 'dsh-profile')
  fs.writeFileSync(file, nextText, 'utf8')
  return { changed: true, backup }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Кроссплатформенный наблюдатель за MCP-конфигами (без launchd). */
async function watchCommand(flags) {
  const root = flags.root ? path.resolve(String(flags.root)) : process.cwd()
  const once = Boolean(flags.once)
  const intervalSec = Math.max(30, Number(flags.interval ?? 300))
  const runFlags = { ...flags, all: true }
  const runOnce = async (reason) => {
    info(`[watch] ${reason}: проверяю MCP-конфиги`)
    await lazyAll(runFlags)
  }
  if (once) {
    await runOnce('однократный запуск')
    return 0
  }
  const targets = watchPaths(root)
  info(`[watch] каталог проекта: ${root}; путей под наблюдением: ${targets.length}`)
  let timer = null
  let busy = false
  const schedule = (reason) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (busy) return
      busy = true
      try {
        await runOnce(reason)
      } catch (error) {
        warn(`[watch] ошибка: ${error.message}`)
      } finally {
        busy = false
      }
    }, 1200)
  }
  const watchers = []
  for (const target of targets) {
    try {
      const isDir = fs.statSync(target).isDirectory()
      const recursive = isDir
      try {
        watchers.push(fs.watch(target, { recursive }, () => schedule(`изменён ${target}`)))
      } catch {
        watchers.push(fs.watch(target, () => schedule(`изменён ${target}`)))
      }
    } catch {
      /* путь мог исчезнуть */
    }
  }
  const poll = setInterval(() => schedule('плановый опрос'), intervalSec * 1000)
  info(`[watch] слежу за изменениями; опрос каждые ${intervalSec}с; Ctrl+C — выход`)
  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(poll)
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          /* уже закрыт */
        }
      }
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

function watchPaths(root) {
  const candidates = [
    path.join(HOME, '.dsh', 'profiles'),
    path.join(HOME, '.dsh', 'profiles', 'web', 'cordis.patch.yml'),
    path.join(HOME, '.dsh', 'profiles', 'superagent', 'cordis.patch.yml'),
    path.join(HOME, '.claude.json'),
    path.join(HOME, '.claude'),
    path.join(HOME, '.codex', 'config.toml'),
    path.join(HOME, '.codex'),
    path.join(HOME, '.gemini', 'settings.json'),
    path.join(HOME, '.gemini'),
    path.join(HOME, '.cursor', 'mcp.json'),
    path.join(HOME, '.cursor'),
    claudeDesktopConfigPath(),
    path.join(root, '.mcp.json'),
    path.join(root, '.cursor', 'mcp.json'),
    path.join(root, '.vscode', 'mcp.json'),
  ]
  return [...new Set(candidates)].filter(exists)
}

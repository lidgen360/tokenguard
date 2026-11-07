/** mcp: аудит MCP-серверов и перевод их в ленивый режим. */
import path from 'node:path'
import { discoverConfigs, scanUsage } from '../adapters/mcp-configs.js'
import { probeMcpServer, schemasTokens } from '../util/mcp-stdio.js'
import { renderLazyWrapper } from '../lazy/template.js'
import { backupPaths } from '../util/backup.js'
import { DATA_HOME, ensureDir, exists, readJson, writeFile, timeAgo, ageDays } from '../util/files.js'
import { sanitizeName } from '../util/naming.js'
import { printTable, info, ok, warn, bold, dim } from '../log.js'

export const VALUE_FLAGS = ['root', 'client', 'idle', 'server', 'out', 'min-tokens']

const HELP = `${bold('ccliner mcp')} — аудит MCP и ленивый режим

  ccliner mcp audit [--probe] [--json]
      Найти MCP-конфиги всех клиентов, посчитать инструменты и токены схем (--probe),
      показать фактическое использование и предложить ленивый режим.

  ccliner mcp lazy <server> [--client <клиент>] [--idle 10] [--apply]
      Сгенерировать ленивый прокси (2 инструмента, запуск по требованию)
      и, для JSON-клиентов, сразу переписать конфиг (с бэкапом).
`

export async function run(positional, flags) {
  const sub = positional[0]
  if (sub === 'audit') return audit(flags)
  if (sub === 'lazy') return lazy(positional[1], flags)
  console.log(HELP)
  return 0
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
    if (totals.lazy > 0) info(`кандидатов в lazy-режим: ${totals.lazy} — «ccliner mcp lazy <server>» даёт −(токены на запрос)`)
  } else {
    info(`всего серверов: ${totals.servers}. Запусти с --probe, чтобы измерить инструменты и токены схем.`)
  }
  return 0
}

async function lazy(serverName, flags) {
  if (!serverName) {
    warn('укажи имя сервера: ccliner mcp lazy <server>')
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

  // DSH (yaml): безопаснее выдать готовый блок — форматирование профиля не трогаем
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

/** mcp: аудит MCP-серверов и перевод их в ленивый режим. */
import fs from 'node:fs'
import path from 'node:path'
import { claudeDesktopConfigPath, discoverConfigs, scanUsage } from '../adapters/mcp-configs.js'
import { probeMcpServer, schemasTokens } from '../util/mcp-stdio.js'
import { renderLazyWrapper } from '../lazy/template.js'
import { backupPaths } from '../util/backup.js'
import { DATA_HOME, HOME, ensureDir, exists, readJson, writeFile, timeAgo, ageDays } from '../util/files.js'
import { sanitizeName } from '../util/naming.js'
import { recordArtifact } from '../util/manifest.js'
import { printTable, info, ok, warn, bold, dim } from '../log.js'

export const VALUE_FLAGS = ['root', 'client', 'idle', 'server', 'out', 'min-tokens', 'interval']

const HELP = `${bold('tokenguard mcp')} — аудит MCP и ленивый режим

  tokenguard mcp audit [--probe] [--json]
      Найти MCP-конфиги всех клиентов, посчитать инструменты и токены схем (--probe),
      показать фактическое использование и предложить ленивый режим.

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
  if (sub === 'lazy') return flags.all ? lazyAll(flags) : lazy(positional[1], flags)
  if (sub === 'watch') return watchCommand(flags)
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

/** Обнаружение MCP-конфигов разных клиентов и использование MCP-серверов. */
import fs from 'node:fs'
import path from 'node:path'
import { exists, readJson, readText, HOME } from '../util/files.js'
import * as dsh from './dsh.js'
import * as claudeCode from './claude-code.js'
import * as codex from './codex.js'

const DSH_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

function listdir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function normalizeServer(name, value) {
  if (!value || typeof value !== 'object') return null
  const args = Array.isArray(value.args) ? value.args.map(String) : []
  const url = value.url ?? value.serverUrl ?? value.httpUrl
  return {
    name: String(name),
    transport: value.type === 'http' || value.type === 'sse' || url ? (value.type ?? 'http') : (value.transport ?? 'stdio'),
    command: value.command ? String(value.command) : null,
    args,
    env: value.env && typeof value.env === 'object' ? value.env : {},
    url: url ? String(url) : null,
  }
}

function fromMcpServersObject(source) {
  if (!source || typeof source !== 'object') return []
  return Object.entries(source).map(([name, value]) => normalizeServer(name, value)).filter(Boolean)
}

/** Собрать все найденные MCP-конфиги: [{client, file, format, servers}] */
export async function discoverConfigs(options = {}) {
  const { root = process.cwd() } = options
  const found = []

  // DSH: профили в ~/.dsh/profiles/*/cordis.patch.yml
  const dshProfiles = path.join(HOME, '.dsh', 'profiles')
  if (exists(dshProfiles) && listdir(dshProfiles).length > 0) {
    const { parse: parseYaml } = await import('yaml')
    for (const profile of listdir(dshProfiles)) {
      const file = path.join(dshProfiles, profile, 'cordis.patch.yml')
      if (!exists(file)) continue
      const servers = parseDshPatch(file, parseYaml)
      if (servers.length > 0) found.push({ client: 'DSH', file, format: 'yaml', servers })
    }
  }

  // Claude Code: ~/.claude.json + локальный .mcp.json
  const claudeGlobal = path.join(HOME, '.claude.json')
  if (exists(claudeGlobal)) {
    const data = readJson(claudeGlobal) ?? {}
    const servers = fromMcpServersObject(data.mcpServers)
    if (servers.length > 0) found.push({ client: 'Claude Code', file: claudeGlobal, format: 'json', servers })
  }
  const claudeLocal = path.join(root, '.mcp.json')
  if (exists(claudeLocal)) {
    const data = readJson(claudeLocal) ?? {}
    const servers = fromMcpServersObject(data.mcpServers)
    if (servers.length > 0) found.push({ client: 'Claude Code (project)', file: claudeLocal, format: 'json', servers })
  }

  // Codex CLI: ~/.codex/config.toml
  const codexConfig = path.join(HOME, '.codex', 'config.toml')
  if (exists(codexConfig)) {
    const toml = await import('smol-toml')
    const servers = parseCodexToml(codexConfig, toml)
    if (servers.length > 0) found.push({ client: 'Codex CLI', file: codexConfig, format: 'toml', servers })
  }

  // Gemini CLI: ~/.gemini/settings.json
  const gemini = path.join(HOME, '.gemini', 'settings.json')
  if (exists(gemini)) {
    const data = readJson(gemini) ?? {}
    const servers = fromMcpServersObject(data.mcpServers)
    if (servers.length > 0) found.push({ client: 'Gemini CLI', file: gemini, format: 'json', servers })
  }

  // Cursor: ~/.cursor/mcp.json и проектный .cursor/mcp.json
  for (const [clientLabel, file] of [
    ['Cursor (global)', path.join(HOME, '.cursor', 'mcp.json')],
    ['Cursor (project)', path.join(root, '.cursor', 'mcp.json')],
  ]) {
    if (!exists(file)) continue
    const data = readJson(file) ?? {}
    const servers = fromMcpServersObject(data.mcpServers)
    if (servers.length > 0) found.push({ client: clientLabel, file, format: 'json', servers })
  }

  // Claude Desktop
  const desktop = process.platform === 'darwin'
    ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json')
  if (exists(desktop)) {
    const data = readJson(desktop) ?? {}
    const servers = fromMcpServersObject(data.mcpServers)
    if (servers.length > 0) found.push({ client: 'Claude Desktop', file: desktop, format: 'json', servers })
  }

  // VS Code / Copilot: .vscode/mcp.json
  const vscodeConfig = path.join(root, '.vscode', 'mcp.json')
  if (exists(vscodeConfig)) {
    const data = readJson(vscodeConfig) ?? {}
    const servers = fromMcpServersObject(data.servers ?? data.mcpServers ?? {})
    if (servers.length > 0) found.push({ client: 'VS Code', file: vscodeConfig, format: 'json', servers })
  }

  return found
}

/** Разобрать insert-записи dsh-mcp-client из cordis.patch.yml. */
function parseDshPatch(file, parseYaml) {
  let entries
  try {
    entries = parseYaml(readText(file))
  } catch {
    return []
  }
  const servers = []
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return
    if (entry.name === DSH_CLIENT_PLUGIN && entry.config?.serverName) {
      const config = entry.config
      servers.push({
        name: String(config.serverName),
        transport: config.transport ?? 'stdio',
        command: config.command ? String(config.command) : null,
        args: Array.isArray(config.args) ? config.args.map(String) : [],
        env: config.env && typeof config.env === 'object' ? config.env : {},
        url: config.url ? String(config.url) : null,
        lazyWrapper: Array.isArray(config.args) && config.args.some((arg) => String(arg).includes('.ccliner') || String(arg).includes('ccliner')),
      })
    }
    for (const key of ['insert', 'children', 'plugins']) {
      if (Array.isArray(entry[key])) entry[key].forEach(visit)
    }
  }
  if (Array.isArray(entries)) entries.forEach(visit)
  return servers
}

function parseCodexToml(file, toml) {
  try {
    const data = toml.parse(readText(file))
    const servers = data.mcp_servers ?? data.mcpServers ?? {}
    return Object.entries(servers).map(([name, value]) => normalizeServer(name, {
      ...value,
      type: value?.url ? 'http' : 'stdio',
    })).filter(Boolean)
  } catch {
    return []
  }
}

/** Сколько раз и когда использовался каждый MCP-сервер (по логам сессий). */
export function scanUsage() {
  const usage = new Map()
  const merge = (map) => {
    for (const [server, value] of map) {
      const current = usage.get(server) ?? { calls: 0, lastTime: 0 }
      current.calls += value.calls
      if (value.lastTime > current.lastTime) current.lastTime = value.lastTime
      usage.set(server, current)
    }
  }
  try {
    merge(dsh.scanMcpUsage())
  } catch {
    /* нет сессий */
  }
  for (const session of [...listSessionsSafe(claudeCode), ...listSessionsSafe(codex)]) {
    try {
      const text = readText(session.file)
      const regex = /mcp__([A-Za-z0-9_-]+)__/g
      let match
      while ((match = regex.exec(text)) !== null) {
        const server = match[1]
        const current = usage.get(server) ?? { calls: 0, lastTime: 0 }
        current.calls += 1
        if (session.lastTime > current.lastTime) current.lastTime = session.lastTime
        usage.set(server, current)
      }
    } catch {
      /* пропускаем */
    }
  }
  return usage
}

function listSessionsSafe(adapter) {
  try {
    return adapter.listSessions()
  } catch {
    return []
  }
}

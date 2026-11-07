/** scan: сводный обзор харнессов, чатов, MCP, проектов и документации. */
import path from 'node:path'
import { detectAdapters } from '../adapters/index.js'
import * as dsh from '../adapters/dsh.js'
import * as claudeCode from '../adapters/claude-code.js'
import * as codex from '../adapters/codex.js'
import { discoverConfigs, scanUsage } from '../adapters/mcp-configs.js'
import { scanData as projectsScanData } from './projects.js'
import { checkData as docsCheckData } from './docs.js'
import { humanBytes, timeAgo } from '../util/files.js'
import { humanTokens } from '../util/tokens.js'
import { printTable, info, ok, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['root', 'max-depth']

const HELP = `${bold('tokenguard scan')} — сводка по окружению

  tokenguard scan [--root <dir>] [--json]
      Что найдено: харнессы и чаты, MCP-оверхед, мёртвые проекты, проблемы docs.
`

export async function run(positional, flags) {
  const root = path.resolve(flags.root ? String(flags.root) : process.cwd())
  const adapters = detectAdapters()
  const sessions = { count: 0, bytes: 0, tokens: 0, perAdapter: [] }
  for (const adapter of [dsh, claudeCode, codex]) {
    let list = []
    try {
      list = adapter.listSessions()
    } catch {
      list = []
    }
    const bytes = list.reduce((sum, session) => sum + session.bytes, 0)
    const tokens = list.reduce((sum, session) => sum + (session.promptTokens ?? 0), 0)
    sessions.count += list.length
    sessions.bytes += bytes
    sessions.tokens += tokens
    sessions.perAdapter.push({ id: adapter.id, label: adapter.label, count: list.length, bytes, tokens })
  }

  const configs = await discoverConfigs({ root })
  const usage = scanUsage()
  const servers = configs.flatMap((config) => config.servers.map((server) => ({ ...server, client: config.client })))
  const projects = projectsScanData({ root, 'max-depth': flags['max-depth'] ?? 2 })
  const docs = docsCheckData(root)

  if (flags.json) {
    console.log(JSON.stringify({ root, adapters, sessions, configs, usage: [...usage.entries()], projects, docs }, null, 2))
    return 0
  }

  console.log(bold('Харнессы и чаты'))
  printTable(
    ['Харнесс', 'Найден', 'Сессий', 'Размер'],
    adapters.map((adapter) => {
      const stats = sessions.perAdapter.find((item) => item.id === adapter.id) ?? { count: 0, bytes: 0 }
      return [adapter.label, adapter.detected ? 'да' : 'нет', stats.count, humanBytes(stats.bytes)]
    }),
  )
  info(`всего сессий: ${sessions.count} (${humanBytes(sessions.bytes)}), токенов промптов в логах: ${humanTokens(sessions.tokens)}`)

  console.log('')
  console.log(bold('MCP'))
  if (servers.length === 0) {
    console.log('  MCP-серверы не найдены')
  } else {
    printTable(
      ['Клиент', 'Сервер', 'Транспорт', 'Вызовов', 'Последний'],
      servers.map((server) => {
        const used = usage.get(server.name)
        return [server.client, server.name, server.transport, used?.calls ?? 0, used ? timeAgo(used.lastTime) : '—']
      }),
    )
  }

  console.log('')
  console.log(bold('Проекты'))
  const verdicts = projects.repos.reduce((acc, repo) => {
    acc[repo.verdict] = (acc[repo.verdict] ?? 0) + 1
    return acc
  }, {})
  const dead = projects.repos.filter((repo) => repo.verdict === 'мёртвый' || repo.verdict === 'спящий')
  console.log(`  найдено репозиториев: ${projects.repos.length}; мёртвых/спящих: ${dead.length}`)
  for (const [verdict, count] of Object.entries(verdicts)) console.log(`  ${verdict}: ${count}`)
  for (const repo of dead.slice(0, 8)) console.log(`  • ${repo.name} — ${repo.verdict}, ${timeAgo(repo.lastCommit)}`)

  console.log('')
  console.log(bold('Документация'))
  console.log(`  документов: ${docs.docs}; проблем: ${docs.findings.length} (высоких: ${docs.counts.high ?? 0}, средних: ${docs.counts.medium ?? 0})`)
  for (const finding of docs.findings.filter((item) => item.severity === 'high').slice(0, 8)) {
    console.log(`  ✖ ${finding.file}:${finding.line} — ${finding.message}`)
  }
  if (docs.findings.length > 0) info('подробнее: tokenguard docs check')
  return 0
}

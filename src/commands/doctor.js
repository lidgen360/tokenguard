/** doctor: проверка окружения, интеграций и гигиены данных tokenguard. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { adapters as allAdapters, detectAdapters } from '../adapters/index.js'
import { discoverConfigs, scanUsage } from '../adapters/mcp-configs.js'
import { dataHome, readManifest, markDeleted, sizeOf } from '../util/manifest.js'
import { HOME, exists, humanBytes, timeAgo } from '../util/files.js'
import { driftHookDisabled } from '../hooks/dsh-user-prompt.js'
import { bold, dim, green, yellow, red, printTable, info, ok, warn, fail } from '../log.js'

export const VALUE_FLAGS = ['root']

const HELP = `${bold('tokenguard doctor')} — проверка окружения и интеграций

  tokenguard doctor [--json] [--strict] [--fix] [--root <dir>]
      Проверяет Node.js, каталог данных, бэкапы, реестр артефактов, харнессы,
      MCP-конфиги, lazy-прокси, хук DSH, автозапуск, конфиг и свободное место.
      --fix      безопасные исправления: создать каталоги, выставить права 700,
                 отметить удалёнными записи реестра с несуществующими файлами;
      --strict   код 1 также при предупреждениях;
      --json     машиночитаемый вывод.
`

const ICONS = { ok: green('✔'), warn: yellow('⚠'), fail: red('✖'), skip: dim('—') }

function check(id, title, fn) {
  try {
    return { id, title, status: 'ok', detail: '', ...fn() }
  } catch (error) {
    return { id, title, status: 'fail', detail: `ошибка проверки: ${error?.message ?? error}` }
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0])
  const good = major >= 20
  return { id: 'node', title: 'Node.js', status: good ? 'ok' : 'fail', detail: `${process.version}${good ? '' : ' — нужен ≥20 (engines)'}` }
}

function dataHomeCheck({ dataHome: dir }) {
  return check('data-home', 'Каталог данных', () => {
    let stat
    try {
      stat = fs.statSync(dir)
    } catch {
      return {
        status: 'warn',
        detail: `${dir} не создан`,
        fix: () => {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
          fs.chmodSync(dir, 0o700)
          return `создан ${dir} (0700)`
        },
      }
    }
    if (!stat.isDirectory()) return { status: 'fail', detail: `${dir} — не каталог` }
    // На Windows POSIX-права не работают: chmod меняет только read-only, mode не показателен.
    if (process.platform === 'win32') return { status: 'ok', detail: dir }
    const mode = stat.mode & 0o777
    try {
      fs.accessSync(dir, fs.constants.W_OK)
    } catch {
      return { status: 'fail', detail: `${dir} недоступен для записи` }
    }
    if (mode & 0o077) {
      return {
        status: 'warn',
        detail: `права ${mode.toString(8)} — ожидается 700`,
        fix: () => {
          fs.chmodSync(dir, 0o700)
          return `права выставлены: ${dir} → 700`
        },
      }
    }
    return { status: 'ok', detail: `${dir} · ${mode.toString(8)}` }
  })
}

function backupsCheck({ dataHome: dir }) {
  return check('backups', 'Бэкапы', () => {
    const backups = path.join(dir, 'backups')
    if (!exists(backups)) {
      return {
        status: 'warn',
        detail: 'каталога бэкапов нет',
        fix: () => {
          fs.mkdirSync(backups, { recursive: true, mode: 0o700 })
          return `создан ${backups}`
        },
      }
    }
    const entries = listDir(backups).length
    const bytes = sizeOf(backups)
    if (bytes > 2 * 1024 ** 3) {
      return { status: 'warn', detail: `${entries} шт., ${humanBytes(bytes)} — стоит почистить: tokenguard artifacts clean --older-than 30` }
    }
    return { status: 'ok', detail: `${entries} шт., ${humanBytes(bytes)}` }
  })
}

function manifestCheck() {
  return check('manifest', 'Реестр артефактов', () => {
    const rows = readManifest()
    const missing = rows.filter((record) => record.path && !exists(record.path))
    if (missing.length > 0) {
      return {
        status: 'warn',
        detail: `${rows.length} записей, ${missing.length} ссылаются на отсутствующие файлы`,
        fix: () => {
          markDeleted(missing.map((record) => record.id))
          return `отмечено удалёнными: ${missing.length}`
        },
      }
    }
    return { status: 'ok', detail: `${rows.length} записей, битых путей нет` }
  })
}

function harnessCheck() {
  return check('harness', 'Харнессы', () => {
    const detectedIds = new Set(detectAdapters().filter((adapter) => adapter.detected).map((adapter) => adapter.id))
    if (detectedIds.size === 0) {
      return { status: 'warn', detail: 'DSH / Claude Code / Codex не найдены' }
    }
    const parts = allAdapters.filter((adapter) => detectedIds.has(adapter.id)).map((adapter) => {
      try {
        const sessions = adapter.listSessions()
        const latest = Math.max(0, ...sessions.map((session) => session.mtimeMs ?? session.mtime ?? session.lastTime ?? 0))
        return `${adapter.label}: ${sessions.length} сессий${latest ? `, последняя ${timeAgo(latest)}` : ''}`
      } catch {
        return `${adapter.label}: ошибка чтения`
      }
    })
    return { status: 'ok', detail: parts.join(' · ') }
  })
}

async function mcpCheck({ root }) {
  let configs = []
  try {
    configs = await discoverConfigs({ root })
  } catch (error) {
    return { id: 'mcp', title: 'MCP-конфиги', status: 'fail', detail: `не удалось прочитать: ${error?.message ?? error}` }
  }
  const servers = configs.flatMap((config) => config.servers.map((server) => ({ ...server, client: config.client })))
  if (servers.length === 0) {
    return { id: 'mcp', title: 'MCP-конфиги', status: 'skip', detail: 'MCP-серверы не настроены' }
  }
  const usage = scanUsage()
  const lazy = servers.filter((server) => server.lazyWrapper)
  const unused = servers.filter((server) => !server.lazyWrapper && !(usage.get(server.name)?.calls > 0))
  const names = unused.slice(0, 4).map((server) => server.name).join(', ') + (unused.length > 4 ? '…' : '')
  return {
    id: 'mcp',
    title: 'MCP-конфиги',
    status: unused.length > 0 ? 'warn' : 'ok',
    detail: `${servers.length} серверов · ленивых ${lazy.length} · без вызовов ${unused.length}${unused.length ? ` (${names})` : ''}`,
  }
}

function lazyProxiesCheck({ dataHome: dir }) {
  return check('lazy-proxies', 'Lazy-прокси', () => {
    const lazyDir = path.join(dir, 'lazy')
    const wrappers = []
    for (const entry of listDir(lazyDir)) {
      if (!entry.isDirectory()) continue
      const wrapper = path.join(lazyDir, entry.name, 'server.cjs')
      if (exists(wrapper)) wrappers.push(wrapper)
    }
    if (wrappers.length === 0) return { status: 'skip', detail: 'локальных lazy-прокси нет' }
    const broken = []
    for (const wrapper of wrappers) {
      try {
        execFileSync(process.execPath, ['--check', wrapper], { stdio: 'pipe' })
      } catch {
        broken.push(path.basename(path.dirname(wrapper)))
      }
    }
    if (broken.length > 0) {
      return { status: 'fail', detail: `синтаксис сломан: ${broken.join(', ')}` }
    }
    return { status: 'ok', detail: `${wrappers.length} прокси, синтаксис в порядке` }
  })
}

function hookConfigFiles(home) {
  const profiles = path.join(home, '.dsh', 'profiles')
  const files = new Set()
  for (const entry of listDir(profiles)) {
    if (!entry.isDirectory()) continue
    const file = path.join(profiles, entry.name, 'cordis.patch.yml')
    if (!exists(file)) continue
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/configPath:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)) {
      files.add(match[1].trim())
    }
  }
  return [...files]
}

function collectCommands(value, out = []) {
  if (!value || typeof value !== 'object') return out
  if (typeof value.command === 'string') out.push(value.command)
  for (const item of Object.values(value)) collectCommands(item, out)
  return out
}

function hooksCheck({ home }) {
  return check('hooks', 'Хук DSH', () => {
    const files = hookConfigFiles(home)
    if (files.length === 0) return { status: 'skip', detail: 'хук не установлен (опционально)' }
    const problems = []
    const scripts = []
    for (const file of files) {
      if (!exists(file)) {
        problems.push(`нет конфига ${file}`)
        continue
      }
      let data
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        problems.push(`битый JSON ${path.basename(file)}`)
        continue
      }
      for (const command of collectCommands(data)) {
        const match = command.match(/([A-Za-z]:\\[^\s"']+\.(?:c|m)?js|\/[^\s"']+\.(?:c|m)?js)/)
        if (match) scripts.push(match[1])
      }
    }
    for (const script of scripts) {
      if (!exists(script)) problems.push(`нет скрипта ${script}`)
    }
    const state = driftHookDisabled() ? 'driftHook выключен' : 'driftHook включён'
    if (problems.length > 0) return { status: 'fail', detail: problems.join('; ') }
    return { status: 'ok', detail: `${scripts.length} команд · ${state}` }
  })
}

function autostartCheck({ platform, home }) {
  return check('autostart', 'Автозапуск', () => {
    if (platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents')
      const plists = listDir(dir).filter((entry) => /^ai\.tokenguard\..*\.plist$/.test(entry.name))
      if (plists.length === 0) return { status: 'skip', detail: 'plist не установлены (опционально)' }
      let loaded = 0
      try {
        const output = execFileSync('launchctl', ['list'], { encoding: 'utf8' })
        loaded = output.split('\n').filter((line) => line.includes('ai.tokenguard.')).length
      } catch {
        return { status: 'warn', detail: `${plists.length} plist, launchctl недоступен` }
      }
      return loaded > 0
        ? { status: 'ok', detail: `${plists.length} plist, загружено ${loaded}` }
        : { status: 'warn', detail: `${plists.length} plist, но ни один не загружен` }
    }
    if (platform === 'linux') {
      const dir = path.join(home, '.config', 'systemd', 'user')
      const units = listDir(dir).filter((entry) => /^tokenguard.*\.(service|timer)$/.test(entry.name))
      return units.length > 0
        ? { status: 'ok', detail: `${units.length} unit-файлов` }
        : { status: 'skip', detail: 'unit-файлы не установлены (опционально)' }
    }
    if (platform === 'win32') {
      try {
        const output = execFileSync('schtasks', ['/Query', '/FO', 'LIST'], { encoding: 'utf8' })
        const count = output.split('\n').filter((line) => /tokenguard/i.test(line)).length
        return count > 0
          ? { status: 'ok', detail: `${count} задач в Планировщике` }
          : { status: 'skip', detail: 'задачи не созданы (опционально)' }
      } catch {
        return { status: 'skip', detail: 'schtasks недоступен' }
      }
    }
    return { status: 'skip', detail: 'автозапуск не поддерживается на этой ОС' }
  })
}

function configCheck({ dataHome: dir }) {
  return check('config', 'Конфиг', () => {
    const file = path.join(dir, 'config.json')
    if (!exists(file)) return { status: 'skip', detail: 'config.json нет (значения по умолчанию)' }
    let data
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return { status: 'fail', detail: 'config.json — битый JSON' }
    }
    const context = data.contextHook === true ? `включён (порог ${data.contextThreshold ?? '350k'})` : 'выключен'
    return { status: 'ok', detail: `driftHook: ${data.driftHook === false ? 'выключен' : 'включён'} · contextHook: ${context}` }
  })
}

function diskCheck() {
  return check('disk', 'Свободное место', () => {
    const stats = fs.statfsSync(HOME)
    const free = stats.bavail * stats.bsize
    const gb = free / 1024 ** 3
    return gb < 5
      ? { status: 'warn', detail: `свободно ${gb.toFixed(1)} GB — мало` }
      : { status: 'ok', detail: `свободно ${gb.toFixed(1)} GB` }
  })
}

async function collect(ctx) {
  return [
    nodeCheck(),
    dataHomeCheck(ctx),
    backupsCheck(ctx),
    manifestCheck(ctx),
    harnessCheck(),
    await mcpCheck(ctx),
    lazyProxiesCheck(ctx),
    hooksCheck(ctx),
    autostartCheck(ctx),
    configCheck(ctx),
    diskCheck(),
  ]
}

function summarize(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const check of checks) summary[check.status] += 1
  return summary
}

export async function run(positional, flags) {
  const ctx = {
    root: path.resolve(flags.root ? String(flags.root) : process.cwd()),
    dataHome: dataHome(),
    home: HOME,
    platform: process.platform,
  }
  let checks = await collect(ctx)
  const fixes = []
  if (flags.fix) {
    for (const check of checks) {
      if (!check.fix || check.status === 'ok') continue
      try {
        fixes.push({ id: check.id, message: check.fix() })
      } catch (error) {
        fixes.push({ id: check.id, message: `не удалось: ${error?.message ?? error}` })
      }
    }
    if (fixes.length > 0) checks = await collect(ctx)
  }
  const summary = summarize(checks)
  const exitCode = summary.fail > 0 || (flags.strict && summary.warn > 0) ? 1 : 0

  if (flags.json) {
    console.log(JSON.stringify({ checks: checks.map(({ fix, ...rest }) => rest), summary, fixes }, null, 2))
    return exitCode
  }

  console.log(bold('tokenguard doctor') + dim(' — проверка окружения'))
  console.log('')
  printTable(['', 'Проверка', 'Детали'], checks.map((check) => [ICONS[check.status], check.title, check.detail]))
  console.log('')
  for (const fix of fixes) console.log(`${green('✔')} исправлено: ${fix.message}`)
  if (fixes.length > 0) console.log('')

  const parts = [`ok: ${summary.ok}`, `предупреждений: ${summary.warn}`, `ошибок: ${summary.fail}`]
  if (summary.skip > 0) parts.push(`пропущено: ${summary.skip}`)
  console.log(bold('Итог: ') + parts.join(' · '))

  if (summary.fail > 0) {
    fail('есть ошибки — см. детали выше')
  } else if (summary.warn > 0) {
    warn('есть предупреждения; безопасные исправления: tokenguard doctor --fix')
  } else {
    ok('всё в порядке')
  }
  if (summary.skip > 0) info('пропущенные проверки — опциональные интеграции')
  return exitCode
}

/** init: первичная настройка tokenguard за один запуск. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_HOME, HOME, exists, expand } from '../util/files.js'
import { upsertGuard } from './guard.js'
import { bold, dim, green, yellow, printTable, info, ok, warn } from '../log.js'

export const VALUE_FLAGS = ['root']

const HELP = `${bold('tokenguard init')} — первичная настройка

  tokenguard init [--apply] [--json] [--root <dir>]
      Проверяет и настраивает: каталог данных, guard-правило в AGENTS.md,
      хук DSH (если профиль уже ссылается на hooks-конфиг), автозапуск.
      Без --apply — только план; с --apply — безопасные шаги.
`

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK_SCRIPT = path.join(REPO_ROOT, 'bin', 'tokenguard-dsh-hook.js')
const MARK = '<!-- tokenguard:guard -->'

const ICONS = { ok: green('✔'), todo: yellow('○'), skip: dim('—'), warn: yellow('⚠') }

function hookConfigPath(home) {
  const profiles = path.join(home, '.dsh', 'profiles')
  let entries = []
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(profiles, entry.name, 'cordis.patch.yml')
    if (!exists(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    const match = text.match(/configPath:\s*['"]?([^'"\n]+?)['"]?\s*$/m)
    if (match) return match[1].trim()
  }
  return null
}

function hookStep(home) {
  const configPath = hookConfigPath(home)
  if (!configPath) {
    return { id: 'hook', title: 'Хук DSH', status: 'skip', detail: 'профиль без hooks-claude-code — добавь плагин и повтори init' }
  }
  if (!exists(configPath)) {
    return {
      id: 'hook',
      title: 'Хук DSH',
      status: 'todo',
      detail: configPath,
      action: () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        const data = {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(HOOK_SCRIPT)}`, timeout: 10 }] }],
          },
        }
        fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`)
        return configPath
      },
    }
  }
  let text = ''
  try {
    text = fs.readFileSync(configPath, 'utf8')
  } catch {
    text = ''
  }
  if (text.includes('tokenguard-dsh-hook')) {
    return { id: 'hook', title: 'Хук DSH', status: 'ok', detail: configPath }
  }
  return { id: 'hook', title: 'Хук DSH', status: 'warn', detail: `${configPath} не ссылается на tokenguard-dsh-hook.js` }
}

function autostartStep(platform, home) {
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents')
    let files = []
    try {
      files = fs.readdirSync(dir).filter((name) => /^ai\.tokenguard\..*\.plist$/.test(name))
    } catch {
      files = []
    }
    return files.length > 0
      ? { id: 'autostart', title: 'Автозапуск', status: 'ok', detail: `${files.length} plist в LaunchAgents` }
      : { id: 'autostart', title: 'Автозапуск', status: 'todo', detail: 'tokenguard autostart print --out ~/.tokenguard/services' }
  }
  if (platform === 'linux') {
    const dir = path.join(home, '.config', 'systemd', 'user')
    let units = []
    try {
      units = fs.readdirSync(dir).filter((name) => /^tokenguard.*\.(service|timer)$/.test(name))
    } catch {
      units = []
    }
    return units.length > 0
      ? { id: 'autostart', title: 'Автозапуск', status: 'ok', detail: `${units.length} unit-файлов` }
      : { id: 'autostart', title: 'Автозапуск', status: 'todo', detail: 'tokenguard autostart print --os linux --out ~/.tokenguard/services' }
  }
  return { id: 'autostart', title: 'Автозапуск', status: 'skip', detail: 'на этой ОС настраивается вручную' }
}

function dataStep(dataHome) {
  if (exists(dataHome)) {
    return { id: 'data', title: 'Каталог данных', status: 'ok', detail: dataHome }
  }
  return {
    id: 'data',
    title: 'Каталог данных',
    status: 'todo',
    detail: dataHome,
    action: () => {
      fs.mkdirSync(path.join(dataHome, 'backups'), { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        fs.chmodSync(dataHome, 0o700)
        fs.chmodSync(path.join(dataHome, 'backups'), 0o700)
      }
      return dataHome
    },
  }
}

function guardStep(root) {
  const file = path.join(root, 'AGENTS.md')
  const installed = exists(file) && fs.readFileSync(file, 'utf8').includes(MARK)
  return {
    id: 'guard',
    title: 'Правило в AGENTS.md',
    status: installed ? 'ok' : 'todo',
    detail: file,
    action: () => upsertGuard(root).file,
  }
}

function buildSteps({ root, home, dataHome, platform }) {
  return [dataStep(dataHome), guardStep(root), hookStep(home), autostartStep(platform, home)]
}

export async function run(positional, flags) {
  if (flags.help) {
    console.log(HELP)
    return 0
  }
  const root = path.resolve(expand(flags.root ? String(flags.root) : process.cwd()))
  const steps = buildSteps({ root, home: HOME, dataHome: DATA_HOME, platform: process.platform })
  const applied = []

  if (flags.apply) {
    for (const step of steps) {
      if (step.status !== 'todo' || !step.action) continue
      try {
        const message = step.action()
        applied.push({ id: step.id, message })
        step.status = 'ok'
        if (!flags.json) ok(`${step.title}: ${message}`)
      } catch (error) {
        step.status = 'warn'
        step.detail = `не удалось: ${error?.message ?? error}`
        if (!flags.json) warn(`${step.title}: ${step.detail}`)
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify({ root, apply: Boolean(flags.apply), steps: steps.map(({ action, ...rest }) => rest), applied }, null, 2))
    return 0
  }

  console.log(bold('tokenguard init') + dim(' — первичная настройка'))
  console.log('')
  printTable(['', 'Шаг', 'Детали'], steps.map((step) => [ICONS[step.status], step.title, step.detail]))
  console.log('')

  if (steps.some((step) => step.status === 'todo')) {
    if (flags.apply) {
      info('остались ручные шаги — см. детали выше')
    } else {
      ok('безопасные шаги: tokenguard init --apply')
    }
  } else {
    ok('базовая настройка в порядке')
  }
  info('проверка: tokenguard doctor · обзор: tokenguard scan')
  return 0
}

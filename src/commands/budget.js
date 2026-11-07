/** budget: дневной/недельный бюджет токенов с контролем расхода. */
import path from 'node:path'
import * as dsh from '../adapters/dsh.js'
import { DATA_HOME, ensureDir, readJson, writeFile } from '../util/files.js'
import { parseTokenSize } from '../util/sizes.js'
import { humanTokens } from '../util/tokens.js'
import { printTable, info, ok, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['daily', 'weekly']

const CONFIG_FILE = () => path.join(process.env.TOKENGUARD_HOME || process.env.CCLINER_HOME || DATA_HOME, 'budget.json')

export async function run(positional, flags) {
  const sub = positional[0]
  if (!sub || sub === 'status') return status(flags)
  if (sub === 'set') return setBudget(flags)
  if (sub === 'check') return check(flags)
  console.log(HELP)
  return 0
}

const HELP = `${bold('tokenguard budget')} — бюджет токенов

  tokenguard budget set --daily 20M [--weekly 100M]
  tokenguard budget status [--json]
  tokenguard budget check        # код 1, если бюджет превышен (для launchd/cron)
`

function readConfig() {
  const data = readJson(CONFIG_FILE())
  return data && typeof data === 'object' ? data : {}
}

function writeConfig(data) {
  ensureDir(path.dirname(CONFIG_FILE()))
  writeFile(CONFIG_FILE(), `${JSON.stringify(data, null, 2)}\n`)
}

function setBudget(flags) {
  const daily = flags.daily !== undefined ? parseTokenSize(flags.daily) : undefined
  const weekly = flags.weekly !== undefined ? parseTokenSize(flags.weekly) : undefined
  if (daily === undefined && weekly === undefined) {
    warn('укажи --daily 20M и/или --weekly 100M')
    return 1
  }
  if (daily === null || weekly === null) {
    warn('не понял размер: используй 20M, 500K, 1.5B')
    return 1
  }
  const config = readConfig()
  if (daily !== undefined) config.daily = daily
  if (weekly !== undefined) config.weekly = weekly
  config.updatedAt = new Date().toISOString()
  writeConfig(config)
  ok(`бюджет сохранён: ${CONFIG_FILE()}`)
  if (config.daily) info(`день: ${humanTokens(config.daily)} токенов`)
  if (config.weekly) info(`неделя: ${humanTokens(config.weekly)} токенов`)
  return 0
}

function startOfDay(now = Date.now()) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfWeek(now = Date.now()) {
  const date = new Date(startOfDay(now))
  const day = date.getDay() || 7 // воскресенье = 7
  date.setDate(date.getDate() - (day - 1))
  return date.getTime()
}

function usageSince(since) {
  const sessions = dsh.listSessions({ includeSubagents: true })
  let promptTokens = 0
  let requests = 0
  for (const session of sessions) {
    if (session.lastTime < since) continue
    const stats = dsh.eventStats(session, since)
    promptTokens += stats.promptTokens
    requests += stats.requests
  }
  return { promptTokens, requests }
}

function statusData() {
  const config = readConfig()
  const now = Date.now()
  const daySince = startOfDay(now)
  const weekSince = startOfWeek(now)
  const today = usageSince(daySince)
  const week = usageSince(weekSince)
  const dayProgress = Math.max(0.01, (now - daySince) / 86_400_000)
  const projectedDay = Math.round(today.promptTokens / dayProgress)
  return { config, today, week, projectedDay, dayProgress }
}

function status(flags) {
  const data = statusData()
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2))
    return 0
  }
  const { config, today, week, projectedDay } = data
  if (!config.daily && !config.weekly) {
    warn('бюджет не задан. Пример: tokenguard budget set --daily 20M --weekly 100M')
    return 0
  }
  console.log(bold('Бюджет токенов'))
  const rows = []
  if (config.daily) {
    const remaining = config.daily - today.promptTokens
    rows.push(['День', humanTokens(today.promptTokens), humanTokens(config.daily), remaining >= 0 ? humanTokens(remaining) : `перерасход ${humanTokens(-remaining)}`, humanTokens(projectedDay), remaining >= 0 ? (projectedDay > config.daily ? 'риск' : 'ок') : 'превышен'])
  }
  if (config.weekly) {
    const remaining = config.weekly - week.promptTokens
    rows.push(['Неделя', humanTokens(week.promptTokens), humanTokens(config.weekly), remaining >= 0 ? humanTokens(remaining) : `перерасход ${humanTokens(-remaining)}`, '—', remaining >= 0 ? 'ок' : 'превышен'])
  }
  printTable(['Период', 'Потрачено', 'Лимит', 'Осталось', 'Прогноз', 'Статус'], rows)
  info(`запросов сегодня: ${today.requests}; за неделю: ${week.requests}`)
  if (today.requests === 0) info('пока нет данных за сегодня')
  return 0
}

function check(flags) {
  const data = statusData()
  const { config, today, week } = data
  let failed = false
  if (config.daily && today.promptTokens > config.daily) {
    warn(`дневной бюджет превышен: ${humanTokens(today.promptTokens)} из ${humanTokens(config.daily)}`)
    failed = true
  }
  if (config.weekly && week.promptTokens > config.weekly) {
    warn(`недельный бюджет превышен: ${humanTokens(week.promptTokens)} из ${humanTokens(config.weekly)}`)
    failed = true
  }
  if (!failed) ok('бюджет соблюдён')
  if (flags.json) console.log(JSON.stringify({ ok: !failed, today, week, config }, null, 2))
  return failed ? 1 : 0
}

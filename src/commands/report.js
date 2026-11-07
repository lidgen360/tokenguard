/** report: где уходят токены — по дням, сессиям и инструментам. */
import path from 'node:path'
import * as dsh from '../adapters/dsh.js'
import { DATA_HOME, readJson } from '../util/files.js'
import { humanTokens } from '../util/tokens.js'
import { humanBytes } from '../util/files.js'
import { printTable, info, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['days', 'client', 'pricing', 'top']

export async function run(positional, flags) {
  const days = Number(flags.days ?? 7)
  if (!Number.isFinite(days) || days <= 0) {
    warn('укажи --days <число>')
    return 1
  }
  const since = Date.now() - days * 86_400_000
  const sessions = dsh.listSessions({ includeSubagents: true })
  const totals = { requests: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, promptTokens: 0 }
  const byDay = new Map()
  const tools = new Map()
  const perSession = []
  const models = new Set()
  for (const session of sessions) {
    if (session.lastTime < since) continue
    const stats = dsh.eventStats(session, since)
    if (stats.requests === 0) continue
    totals.requests += stats.requests
    totals.inputTokens += stats.inputTokens
    totals.cacheReadTokens += stats.cacheReadTokens
    totals.outputTokens += stats.outputTokens
    totals.promptTokens += stats.promptTokens
    for (const model of stats.models) models.add(model)
    for (const [day, bucket] of stats.byDay) {
      const acc = byDay.get(day) ?? { requests: 0, prompt: 0, output: 0 }
      acc.requests += bucket.requests
      acc.prompt += bucket.inputTokens + bucket.cacheReadTokens
      acc.output += bucket.outputTokens
      byDay.set(day, acc)
    }
    for (const [tool, count] of stats.tools) tools.set(tool, (tools.get(tool) ?? 0) + count)
    perSession.push({
      id: session.id,
      title: session.title,
      role: session.role,
      requests: stats.requests,
      prompt: stats.promptTokens,
      output: stats.outputTokens,
      lastTime: session.lastTime,
    })
  }
  const pricing = loadPricing(flags.pricing)
  const cost = pricing ? estimateCost(totals, pricing) : null
  const result = {
    days,
    since,
    models: [...models],
    totals,
    byDay: Object.fromEntries([...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    tools: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
    sessions: perSession.sort((a, b) => b.prompt - a.prompt),
    pricing,
    cost,
  }
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  console.log(bold(`Токены за ${days} дн.`))
  if (totals.requests === 0) {
    warn('за этот период нет данных в логах DSH')
    return 0
  }
  printTable(
    ['День', 'Запросов', 'Prompt', 'Output'],
    [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bucket]) => [
      day,
      bucket.requests,
      humanTokens(bucket.prompt),
      humanTokens(bucket.output),
    ]),
  )
  info(`запросов: ${totals.requests}; prompt: ${humanTokens(totals.promptTokens)} (input ${humanTokens(totals.inputTokens)} + cacheRead ${humanTokens(totals.cacheReadTokens)}); output: ${humanTokens(totals.outputTokens)}`)
  info(`в среднем на запрос: ${humanTokens(Math.round(totals.promptTokens / totals.requests))} prompt`)
  if (models.size > 0) info(`модели: ${[...models].join(', ')}`)

  console.log('')
  console.log(bold('Топ сессий по prompt'))
  printTable(
    ['Чат', 'Запросов', 'Prompt', 'Output'],
    perSession.slice(0, Number(flags.top ?? 8)).map((session) => [
      session.title.slice(0, 46),
      session.requests,
      humanTokens(session.prompt),
      humanTokens(session.output),
    ]),
  )

  console.log('')
  console.log(bold('Топ инструментов по вызовам'))
  printTable(
    ['Инструмент', 'Вызовов'],
    [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tool, count]) => [tool, count]),
  )

  if (cost) {
    console.log('')
    info(`оценка стоимости: ${cost.total.toFixed(2)} ${pricing.currency ?? 'USD'} (input ${cost.input.toFixed(2)}, cacheRead ${cost.cacheRead.toFixed(2)}, output ${cost.output.toFixed(2)})`)
    info(`тариф: ${(flags.pricing ?? path.join(DATA_HOME, 'pricing.json')).replace(DATA_HOME, '~/.tokenguard')}`)
  } else {
    console.log('')
    info('оценка в деньгах: создай ~/.tokenguard/pricing.json вида {"currency":"USD","perMillion":{"input":0.28,"cacheRead":0.028,"output":0.42}}')
  }
  info('бюджет: tokenguard budget set --daily 20M; контроль: tokenguard budget status')
  return 0
}

function loadPricing(customPath) {
  const file = customPath ? path.resolve(String(customPath)) : path.join(DATA_HOME, 'pricing.json')
  const data = readJson(file)
  if (!data || typeof data !== 'object' || !data.perMillion) return null
  const perMillion = data.perMillion
  if (!Number.isFinite(Number(perMillion.input))) return null
  return {
    file,
    currency: data.currency ?? 'USD',
    perMillion: {
      input: Number(perMillion.input) || 0,
      cacheRead: Number(perMillion.cacheRead ?? perMillion.input) || 0,
      output: Number(perMillion.output ?? 0) || 0,
    },
  }
}

function estimateCost(totals, pricing) {
  const m = pricing.perMillion
  const input = (totals.inputTokens / 1e6) * m.input
  const cacheRead = (totals.cacheReadTokens / 1e6) * m.cacheRead
  const output = (totals.outputTokens / 1e6) * m.output
  return { input, cacheRead, output, total: input + cacheRead + output }
}

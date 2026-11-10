/** Тесты HTML-отчёта report --html: структура, данные, устойчивость, отсутствие внешних ресурсов. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHtml } from '../src/util/report-html.js'
import { VALUE_FLAGS } from '../src/commands/report.js'

const fixture = {
  days: 7,
  since: Date.parse('2026-11-03T00:00:00.000Z'),
  models: ['deepseek-v4-flash'],
  totals: {
    requests: 42,
    inputTokens: 120_000,
    cacheReadTokens: 800_000,
    outputTokens: 50_000,
    promptTokens: 920_000,
  },
  byDay: {
    '2026-11-04': { requests: 10, prompt: 300_000, output: 12_000 },
    '2026-11-05': { requests: 32, prompt: 620_000, output: 38_000 },
  },
  tools: { read: 20, bash: 15, grep: 7 },
  sessions: [
    { id: 'session-a', title: 'Рефакторинг report.js', role: 'chat', requests: 20, prompt: 500_000, output: 20_000, lastTime: 1 },
    { id: 'session-b', title: '<script>alert(1)</script> поиск', role: 'subagent', requests: 22, prompt: 420_000, output: 30_000, lastTime: 2 },
  ],
  pricing: { currency: 'USD', perMillion: { input: 0.28, cacheRead: 0.028, output: 0.42 } },
  cost: { input: 0.034, cacheRead: 0.022, output: 0.021, total: 0.08 },
}

const build = (options = {}) => buildHtml(fixture, { generatedAt: Date.parse('2026-11-10T12:00:00.000Z'), ...options })

test('buildHtml: doctype, шапка, период и версия', () => {
  const html = build()
  assert.ok(html.startsWith('<!doctype html>'), 'документ начинается с doctype')
  assert.match(html, /<html lang="ru">/)
  assert.match(html, /<meta charset="utf-8">/)
  assert.ok(html.includes('tokenguard'))
  assert.match(html, /v\d+\.\d+\.\d+/, 'в шапке есть версия')
  assert.ok(html.includes('Токены за 7 дн.'))
  assert.ok(html.includes('2026-11-03'))
  assert.ok(html.includes('deepseek-v4-flash'))
})

test('buildHtml: итоги — запросы, input, cacheRead, output, стоимость', () => {
  const html = build()
  assert.ok(html.includes('Запросы'))
  assert.ok(html.includes('input'))
  assert.ok(html.includes('cacheRead'))
  assert.ok(html.includes('output'))
  assert.ok(html.includes('Стоимость'))
  assert.ok(html.includes('42'), 'итоговое число запросов')
  assert.ok(html.includes('120K'), 'input в человекочитаемом виде')
  assert.ok(html.includes('800K'), 'cacheRead в человекочитаемом виде')
  assert.ok(html.includes('50K'), 'output в человекочитаемом виде')
  assert.ok(html.includes('0.08 USD'), 'оценка стоимости и валюта')
})

test('buildHtml: SVG-столбики по дням', () => {
  const html = build()
  assert.match(html, /<svg[^>]*role="img"/)
  assert.ok(html.includes('2026-11-04') || html.includes('04.11'), 'подпись первого дня')
  assert.ok(html.includes('05.11'), 'подпись второго дня')
  assert.ok((html.match(/<rect /g) ?? []).length >= 4, 'по два столбика (prompt/output) на день')
  assert.ok(!html.includes('xmlns="http://www.w3.org/2000/svg"'), 'inline SVG без внешнего пространства имён')
})

test('buildHtml: таблицы сессий и инструментов, экранирование заголовков', () => {
  const html = build()
  assert.ok((html.match(/<table>/g) ?? []).length >= 2, 'минимум две таблицы')
  assert.ok(html.includes('Рефакторинг report.js'), 'сессия в топе')
  assert.ok(html.includes('bash'), 'инструмент в топе')
  assert.ok(html.includes('&lt;script&gt;'), 'HTML в названии экранирован')
  assert.ok(!/<script/i.test(html), 'нет исполняемых тегов script')
})

test('buildHtml: нет внешних http(s)-ресурсов, маскот встроен base64', () => {
  const html = build()
  assert.ok(!/https?:\/\//i.test(html), 'никаких внешних URL')
  assert.ok(!/<link\b/i.test(html), 'нет внешних stylesheet')
  assert.ok(!/<script\b/i.test(html), 'нет скриптов')
  assert.ok(!/url\(\s*['"]?https?:/i.test(html), 'нет внешних url() в CSS')
  assert.ok(html.includes('src="data:image/png;base64,'), 'маскот встроен как data URI')
})

test('buildHtml: без маскота (mascot: null) документ остаётся валидным', () => {
  const html = build({ mascot: null })
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('base64'))
})

test('buildHtml: устойчивость к пустым данным', () => {
  for (const data of [undefined, {}, { totals: {}, byDay: {}, tools: {}, sessions: [] }]) {
    const html = buildHtml(data)
    assert.ok(html.startsWith('<!doctype html>'))
    assert.ok(html.includes('нет данных'), 'пустой отчёт показывает пустое состояние')
    assert.ok(!/https?:\/\//i.test(html))
  }
})

test('report: --html зарегистрирован как флаг со значением', () => {
  assert.ok(VALUE_FLAGS.includes('html'))
})

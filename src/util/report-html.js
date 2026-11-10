/**
 * Самодостаточный HTML-отчёт для `tokenguard report --html`.
 * Только inline CSS и inline SVG: никаких внешних шрифтов, картинок и скриптов,
 * чтобы файл открывался офлайн и его можно было отправить одним вложением.
 */
import fs from 'node:fs'

const MASCOT_URL = new URL('../../assets/tokenguard-mascot-360.png', import.meta.url)
const PACKAGE_URL = new URL('../../package.json', import.meta.url)

const versionCache = { value: null }
const mascotCache = new Map()

/** Версия tokenguard из package.json (кешируется, при ошибке — 0.0.0). */
function packageVersion() {
  if (versionCache.value) return versionCache.value
  try {
    versionCache.value = JSON.parse(fs.readFileSync(PACKAGE_URL, 'utf8')).version ?? '0.0.0'
  } catch {
    versionCache.value = '0.0.0'
  }
  return versionCache.value
}

/** PNG-маскот как data URI (base64). null, если файла нет или он пустой. */
export function mascotDataUri(file = MASCOT_URL) {
  const key = String(file)
  if (!mascotCache.has(key)) {
    try {
      const bytes = fs.readFileSync(file)
      mascotCache.set(key, bytes.length > 0 ? `data:image/png;base64,${bytes.toString('base64')}` : null)
    } catch {
      mascotCache.set(key, null)
    }
  }
  return mascotCache.get(key)
}

function escape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/** 1234 → «1 234»: читаемые счётчики без Intl (детерминированно в тестах). */
function formatCount(value) {
  const number = Math.round(toNumber(value))
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function humanTokens(value) {
  const number = toNumber(value)
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(0)}K`
  return String(number)
}

function formatStamp(ms) {
  const date = new Date(toNumber(ms))
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDay(ms) {
  const date = new Date(toNumber(ms))
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function shortDay(day) {
  const parts = String(day ?? '').split('-')
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : String(day ?? '')
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

/** Нормализовать totals: значения по умолчанию вместо undefined/NaN. */
function normalizeTotals(totals) {
  const source = totals && typeof totals === 'object' ? totals : {}
  return {
    requests: toNumber(source.requests),
    inputTokens: toNumber(source.inputTokens),
    cacheReadTokens: toNumber(source.cacheReadTokens),
    outputTokens: toNumber(source.outputTokens),
    promptTokens: toNumber(source.promptTokens),
  }
}

/** Нормализовать byDay в отсортированный массив дней. */
function normalizeDays(byDay) {
  const source = byDay && typeof byDay === 'object' && !Array.isArray(byDay) ? byDay : {}
  return Object.entries(source)
    .filter(([day]) => typeof day === 'string' && day.length > 0)
    .map(([day, bucket]) => ({
      day,
      requests: toNumber(bucket?.requests),
      prompt: toNumber(bucket?.prompt),
      output: toNumber(bucket?.output),
    }))
    .sort((a, b) => a.day.localeCompare(b.day))
}

/** Нормализовать стоимость: null, если её нет или она нечисловая. */
function normalizeCost(cost) {
  if (!cost || typeof cost !== 'object') return null
  const total = toNumber(cost.total)
  if (!Number.isFinite(Number(cost.total))) return null
  return {
    input: toNumber(cost.input),
    cacheRead: toNumber(cost.cacheRead),
    output: toNumber(cost.output),
    total,
  }
}

const STYLE = `
:root{
  --bg:#f5f7fc;
  --panel:#ffffff;
  --text:#141a24;
  --muted:#5b6577;
  --line:#e4e9f2;
  --accent:#4f6ef7;
  --prompt:#4f6ef7;
  --output:#1fb57a;
  --shadow:0 10px 30px rgba(20,30,60,.07);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;
  color:var(--text);
  background:
    radial-gradient(1100px 520px at 15% -10%,#e6ecff 0%,rgba(230,236,255,0) 62%),
    radial-gradient(900px 480px at 100% 0%,#e6fbf2 0%,rgba(230,251,242,0) 55%),
    var(--bg);
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
}
.page{max-width:1060px;margin:0 auto;padding:32px 20px 44px}
.hero{display:flex;gap:28px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:26px}
.hero-main{min-width:260px}
.brand{margin:0 0 6px;font-weight:700;font-size:1.02rem;letter-spacing:.04em;color:var(--accent);text-transform:lowercase}
.badge{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:rgba(79,110,247,.12);color:var(--accent);font-size:.78rem;letter-spacing:.02em;vertical-align:2px}
h1{margin:.1rem 0 .3rem;font-size:clamp(1.55rem,3.2vw,2.15rem);line-height:1.15;letter-spacing:-.02em}
.period{margin:0;color:var(--muted);font-size:.95rem}
.models{margin:.55rem 0 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center;color:var(--muted);font-size:.86rem}
.chip{padding:2px 9px;border-radius:999px;border:1px solid var(--line);background:var(--panel);font-size:.8rem;color:var(--text)}
.mascot{width:150px;height:150px;object-fit:contain;filter:drop-shadow(0 12px 22px rgba(20,30,60,.16));flex:0 0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:0 0 22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow)}
.card-label{margin:0 0 6px;color:var(--muted);font-size:.8rem;letter-spacing:.04em;text-transform:uppercase}
.card-value{margin:0;font-size:1.5rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.card-sub{margin:6px 0 0;color:var(--muted);font-size:.78rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px 22px;margin:0 0 20px;box-shadow:var(--shadow);overflow-x:auto}
.panel h2{margin:0 0 14px;font-size:1.02rem;letter-spacing:-.01em}
.chart{display:block;width:100%;height:auto;max-height:320px}
.chart .bar-prompt{fill:var(--prompt)}
.chart .bar-output{fill:var(--output)}
.chart .axis{fill:var(--muted);font-size:11px;font-family:inherit}
.chart .baseline{stroke:var(--line);stroke-width:1}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:.82rem;margin-top:10px}
.legend span{display:inline-flex;gap:6px;align-items:center}
.swatch{width:11px;height:11px;border-radius:3px;display:inline-block}
.swatch-prompt{background:var(--prompt)}
.swatch-output{background:var(--output)}
table{width:100%;border-collapse:collapse;font-size:.92rem;font-variant-numeric:tabular-nums}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:.75rem;letter-spacing:.05em;text-transform:uppercase;font-weight:600}
td.num,th.num{text-align:right;white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(79,110,247,.04)}
.rank{width:34px;color:var(--muted)}
.empty{margin:0;padding:10px 0;color:var(--muted)}
.footer{margin-top:8px;color:var(--muted);font-size:.78rem;text-align:center}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1219;
    --panel:#151b25;
    --text:#e8edf6;
    --muted:#95a0b3;
    --line:#26303e;
    --shadow:0 10px 30px rgba(0,0,0,.35);
  }
  body{background:
    radial-gradient(1100px 520px at 15% -10%,rgba(79,110,247,.16) 0%,rgba(79,110,247,0) 62%),
    radial-gradient(900px 480px at 100% 0%,rgba(31,181,122,.12) 0%,rgba(31,181,122,0) 55%),
    var(--bg)}
  tbody tr:hover td{background:rgba(79,110,247,.08)}
}
@media print{
  body{background:#fff}
  .card,.panel{box-shadow:none}
  .mascot{display:none}
}
`

/** Короткая подпись для карточки стоимости. */
function costSub(cost, pricing) {
  if (!cost) return 'pricing.json не найден'
  return `input ${cost.input.toFixed(2)} · cacheRead ${cost.cacheRead.toFixed(2)} · output ${cost.output.toFixed(2)}`
}

function summaryCards(totals, cost, pricing) {
  const currency = escape(pricing?.currency ?? 'USD')
  const costValue = cost ? `${cost.total.toFixed(2)} ${currency}` : '—'
  const cards = [
    { label: 'Запросы', value: formatCount(totals.requests), sub: 'ответов ассистента' },
    { label: 'input', value: humanTokens(totals.inputTokens), sub: 'токенов без кеша' },
    { label: 'cacheRead', value: humanTokens(totals.cacheReadTokens), sub: 'из кеша промпта' },
    { label: 'output', value: humanTokens(totals.outputTokens), sub: 'сгенерировано' },
    { label: 'Стоимость', value: costValue, sub: costSub(cost, pricing) },
  ]
  return cards
    .map(
      (card) => `<div class="card">
          <p class="card-label">${escape(card.label)}</p>
          <p class="card-value">${escape(card.value)}</p>
          <p class="card-sub">${escape(card.sub)}</p>
        </div>`,
    )
    .join('\n        ')
}

/** Столбики по дням: prompt + output стопкой, чистый inline SVG. */
function dailyChart(days) {
  if (days.length === 0) return '<p class="empty">За этот период в логах нет дней с запросами.</p>'
  const slot = 64
  const barWidth = 30
  const chartHeight = 170
  const topPad = 12
  const bottomPad = 30
  const leftPad = 14
  const width = Math.max(leftPad * 2 + days.length * slot, 360)
  const height = topPad + chartHeight + bottomPad
  const baseline = topPad + chartHeight
  const max = Math.max(...days.map((day) => day.prompt + day.output), 1)
  const scale = (value) => Math.max((value / max) * chartHeight, 0)
  const bars = days
    .map((day, index) => {
      const x = leftPad + index * slot + (slot - barWidth) / 2
      const promptHeight = scale(day.prompt)
      const outputHeight = scale(day.output)
      const promptY = baseline - promptHeight
      const outputY = promptY - outputHeight
      const promptBar =
        promptHeight > 0
          ? `<rect class="bar-prompt" x="${x}" y="${promptY.toFixed(2)}" width="${barWidth}" height="${promptHeight.toFixed(2)}" rx="4"><title>${escape(day.day)}: prompt ${escape(humanTokens(day.prompt))}</title></rect>`
          : ''
      const outputBar =
        outputHeight > 0
          ? `<rect class="bar-output" x="${x}" y="${outputY.toFixed(2)}" width="${barWidth}" height="${outputHeight.toFixed(2)}" rx="4"><title>${escape(day.day)}: output ${escape(humanTokens(day.output))}</title></rect>`
          : ''
      const label = `<text class="axis" x="${(x + barWidth / 2).toFixed(2)}" y="${baseline + 19}" text-anchor="middle">${escape(shortDay(day.day))}</text>`
      return `<g>${promptBar}${outputBar}${label}</g>`
    })
    .join('')
  const legend = `<div class="legend"><span><i class="swatch swatch-prompt"></i>prompt</span><span><i class="swatch swatch-output"></i>output</span><span>макс ${escape(humanTokens(max))}</span></div>`
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Токены по дням">
          <line class="baseline" x1="${leftPad}" y1="${baseline}" x2="${width - leftPad}" y2="${baseline}"></line>
          ${bars}
        </svg>
        ${legend}`
}

function sessionTable(sessions, limit) {
  if (sessions.length === 0) return '<p class="empty">Сессий за этот период нет.</p>'
  const rows = sessions
    .slice(0, limit)
    .map(
      (session, index) => `<tr>
            <td class="rank">${index + 1}</td>
            <td>${escape(truncate(session.title, 64))}</td>
            <td class="num">${escape(formatCount(session.requests))}</td>
            <td class="num">${escape(humanTokens(session.prompt))}</td>
            <td class="num">${escape(humanTokens(session.output))}</td>
          </tr>`,
    )
    .join('')
  return `<table>
          <thead><tr><th>#</th><th>Чат</th><th class="num">Запросов</th><th class="num">Prompt</th><th class="num">Output</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
}

function toolTable(tools, limit) {
  const entries = tools
    .filter(([name, count]) => typeof name === 'string' && name.length > 0 && Number.isFinite(Number(count)))
    .map(([name, count]) => [name, toNumber(count)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
  if (entries.length === 0) return '<p class="empty">Вызовов инструментов за этот период нет.</p>'
  const rows = entries
    .map(
      ([name, count], index) => `<tr>
            <td class="rank">${index + 1}</td>
            <td>${escape(name)}</td>
            <td class="num">${escape(formatCount(count))}</td>
          </tr>`,
    )
    .join('')
  return `<table>
          <thead><tr><th>#</th><th>Инструмент</th><th class="num">Вызовов</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
}

/**
 * Собрать самодостаточный HTML-отчёт из результата `report`.
 * Устойчив к неполным данным: отсутствующие поля заменяются нулями и пустыми списками.
 * @param {object} [data] результат report (days, since, totals, byDay, tools, sessions, pricing, cost)
 * @param {object} [options] { version, mascot, top, generatedAt }
 * @returns {string} HTML-документ
 */
export function buildHtml(data, options = {}) {
  const source = data && typeof data === 'object' ? data : {}
  const totals = normalizeTotals(source.totals)
  const days = normalizeDays(source.byDay)
  const sessions = Array.isArray(source.sessions) ? source.sessions.filter((item) => item && typeof item === 'object') : []
  const tools = source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools) ? Object.entries(source.tools) : []
  const models = Array.isArray(source.models) ? source.models.map((model) => String(model)).filter(Boolean) : []
  const pricing = source.pricing && typeof source.pricing === 'object' ? source.pricing : null
  const cost = normalizeCost(source.cost)
  const daysCount = Math.round(toNumber(source.days))
  const since = toNumber(source.since)
  const version = escape(options.version ?? packageVersion())
  const mascot = options.mascot === undefined ? mascotDataUri() : options.mascot
  const top = toNumber(options.top) > 0 ? Math.round(toNumber(options.top)) : 10
  const generatedAt = toNumber(options.generatedAt) || Date.now()

  const periodLabel = daysCount > 0 ? `${daysCount} дн.` : 'весь период'
  const heading = daysCount > 0 ? `Токены за ${daysCount} дн.` : 'Токены'
  const periodDates =
    since > 0 && daysCount > 0
      ? `${formatDay(since)} — ${formatDay(generatedAt)}`
      : formatDay(generatedAt)
  const modelsLine =
    models.length > 0
      ? `<p class="models">Модели: ${models.map((model) => `<span class="chip">${escape(model)}</span>`).join(' ')}</p>`
      : ''
  const mascotLine = mascot ? `<img class="mascot" src="${mascot}" alt="Маскот tokenguard" width="150" height="150">` : ''
  const emptyState =
    totals.requests === 0
      ? '<p class="empty">За этот период нет данных в логах DSH: запросов не найдено.</p>'
      : ''

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tokenguard — отчёт: ${escape(heading)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="page">
  <header class="hero">
    <div class="hero-main">
      <p class="brand">tokenguard <span class="badge">v${version}</span></p>
      <h1>${escape(heading)}</h1>
      <p class="period">Период: ${escape(periodLabel)} · ${escape(periodDates)} · сгенерировано ${escape(formatStamp(generatedAt))}</p>
      ${modelsLine}
    </div>
    ${mascotLine}
  </header>

  <section class="cards" aria-label="Итоги">
    ${summaryCards(totals, cost, pricing)}
  </section>

  ${emptyState}

  <section class="panel">
    <h2>Токены по дням</h2>
    ${dailyChart(days)}
  </section>

  <section class="panel">
    <h2>Топ сессий по prompt</h2>
    ${sessionTable(sessions, top)}
  </section>

  <section class="panel">
    <h2>Топ инструментов по вызовам</h2>
    ${toolTable(tools, 12)}
  </section>

  <footer class="footer">
    tokenguard v${version} · отчёт самодостаточен: CSS и графика встроены, внешних ресурсов нет
  </footer>
</main>
</body>
</html>
`
}

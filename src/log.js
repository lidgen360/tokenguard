/** Небольшой слой вывода: цвета только в TTY, таблицы, символы. */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text))

export const bold = paint('1')
export const dim = paint('2')
export const red = paint('31')
export const green = paint('32')
export const yellow = paint('33')
export const blue = paint('34')
export const cyan = paint('36')

export const symbols = {
  ok: '✔',
  info: 'ℹ',
  warn: '⚠',
  fail: '✖',
  bullet: '•',
}

export function info(message) {
  console.log(`${blue(symbols.info)} ${message}`)
}

export function ok(message) {
  console.log(`${green(symbols.ok)} ${message}`)
}

export function warn(message) {
  console.error(`${yellow(symbols.warn)} ${message}`)
}

export function fail(message) {
  console.error(`${red(symbols.fail)} ${message}`)
}

/** Печать таблицы без внешних зависимостей. */
export function printTable(headers, rows) {
  const all = [headers, ...rows.map((row) => row.map((cell) => String(cell ?? '')))]
  const widths = headers.map((_, index) => Math.max(...all.map((row) => visualLength(row[index] ?? ''))))
  const line = (cells) => cells.map((cell, index) => pad(cell, widths[index])).join('  ')
  console.log(bold(line(headers)))
  console.log(dim(widths.map((w) => '─'.repeat(w)).join('  ')))
  for (const row of rows) console.log(line(row.map((cell) => String(cell ?? ''))))
}

function pad(text, width) {
  const extra = width - visualLength(text)
  return text + ' '.repeat(Math.max(0, extra))
}

/** Длина без ANSI-кодов. */
export function visualLength(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '').length
}

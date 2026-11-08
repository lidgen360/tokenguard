#!/usr/bin/env node
/**
 * Automate "new chat" for the live DSH Web GUI through Safari (AppleScript).
 *
 * The CLI cannot create a GUI session, but the authenticated Safari tab can:
 * click "Новая сессия", type the handoff prompt into the composer and send it.
 * Nothing is navigated or reloaded; the user's own tab and login are reused.
 *
 *   node bin/tokenguard-dsh-new-chat.js --prompt-file docs/CHAT-COMPACT.md
 *   node bin/tokenguard-dsh-new-chat.js --prompt "..." --url http://127.0.0.1:3080
 *   node bin/tokenguard-dsh-new-chat.js --dry-run
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const has = (name) => args.includes(`--${name}`)
const urlPrefix = flag('url') || process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runJs(js) {
  const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  const script = `tell application "Safari"
set targetTab to missing value
repeat with w from 1 to count of windows
  repeat with i from 1 to count of tabs of window w
    if (URL of tab i of window w) starts with "${urlPrefix}" then
      set targetTab to tab i of window w
      exit repeat
    end if
  end repeat
  if targetTab is not missing value then exit repeat
end repeat
if targetTab is missing value then return "NO_TAB"
return do JavaScript "${escaped}" in targetTab
end tell`
  try {
    return execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 20_000 }).trim()
  } catch (error) {
    return `APPLESCRIPT_ERROR: ${String(error?.stderr || error?.message || error).slice(0, 300)}`
  }
}

const inspect = runJs(`JSON.stringify({
  url: location.href,
  composer: [...document.querySelectorAll('[contenteditable="true"]')].filter(e => e.offsetParent !== null).length,
  newSession: [...document.querySelectorAll('button')].some(b => /Новая сессия|New Session/i.test(b.textContent || ''))
})`)
if (inspect.startsWith('APPLESCRIPT_ERROR') || inspect === 'NO_TAB') {
  console.error(inspect)
  process.exit(1)
}
const state = JSON.parse(inspect)
if (has('dry-run')) {
  console.log(JSON.stringify({ ok: true, dryRun: true, ...state }, null, 2))
  process.exit(0)
}

const prompt = flag('prompt-file')
  ? execFileSync('bash', ['-lc', `cat ${JSON.stringify(flag('prompt-file'))}`], { encoding: 'utf8' })
  : flag('prompt')
if (!prompt || !prompt.trim()) {
  console.error('нужен --prompt или --prompt-file')
  process.exit(1)
}
const base64 = Buffer.from(prompt, 'utf8').toString('base64')

const clickNew = runJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && /Новая сессия|New Session/i.test(x.textContent || ''))
  if (!b) return 'NO_BUTTON'
  b.click()
  return 'CLICKED'
})()`)
if (clickNew !== 'CLICKED') {
  console.error(`new session button: ${clickNew}`)
  process.exit(1)
}
await wait(1500)

const inserted = runJs(`(() => {
  const bytes = Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0))
  const text = new TextDecoder().decode(bytes)
  const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.offsetParent !== null)
  if (!el) return 'NO_COMPOSER'
  el.focus()
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
  document.execCommand('insertText', false, text)
  return 'INSERTED:' + (el.textContent || '').length
})()`)
if (!inserted.startsWith('INSERTED:')) {
  console.error(`composer insert: ${inserted}`)
  process.exit(1)
}
await wait(700)

const sent = runJs(`(() => {
  const labelled = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null && !b.disabled)
  const send = labelled.find((b) => /Отправ|Send/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')))
  if (send) { send.click(); return 'CLICKED_SEND' }
  const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.offsetParent !== null)
  if (!el) return 'NO_COMPOSER'
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'PRESSED_ENTER'
})()`)
await wait(2500)

const verified = runJs(`JSON.stringify({
  composerText: ([...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.offsetParent !== null)?.textContent || '').length,
  messageShown: document.body.innerText.includes('Перенос из предыдущего чата') || document.body.innerText.includes('NEXT-CHAT.md'),
  url: location.href
})`)
console.log(JSON.stringify({ ok: true, inserted, sent, ...(verified.startsWith('{') ? JSON.parse(verified) : { verified }) }, null, 2))

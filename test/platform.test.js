import test from 'node:test'
import assert from 'node:assert/strict'
import { claudeDesktopConfigPath } from '../src/adapters/mcp-configs.js'
import { renderAutostart } from '../src/commands/autostart.js'

const NODE = '/usr/local/bin/node'
const CLI = '/opt/tokenguard/bin/tokenguard.js'

test('claudeDesktopConfigPath: macOS, Linux и Windows', () => {
  const mac = claudeDesktopConfigPath('darwin', {}, '/Users/me')
  assert.ok(mac.includes('Library/Application Support/Claude'))
  const linux = claudeDesktopConfigPath('linux', {}, '/home/me')
  assert.equal(linux, '/home/me/.config/Claude/claude_desktop_config.json')
  const win = claudeDesktopConfigPath('win32', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me')
  assert.ok(win.includes('AppData\\Roaming') || win.includes('AppData/Roaming'))
  assert.ok(win.endsWith('claude_desktop_config.json'))
})

test('renderAutostart: launchd для macOS', () => {
  const result = renderAutostart({ os: 'darwin', node: NODE, cli: CLI, root: '/Users/me/Sites' })
  assert.ok(result.files['ai.tokenguard.weekly.plist'].includes('ai.tokenguard.weekly'))
  assert.ok(result.files['ai.tokenguard.mcpwatch.plist'].includes('<string>mcp</string>'))
  assert.ok(result.files['ai.tokenguard.mcpwatch.plist'].includes('<string>watch</string>'))
  assert.ok(result.files['ai.tokenguard.mcpwatch.plist'].includes(CLI))
  assert.ok(result.notes.join(' ').includes('launchctl'))
})

test('renderAutostart: systemd для Linux', () => {
  const result = renderAutostart({ os: 'linux', node: NODE, cli: CLI, root: '/home/me/Sites' })
  assert.ok(result.files['tokenguard-weekly.timer'].includes('OnCalendar=Mon 10:00'))
  assert.ok(result.files['tokenguard-mcpwatch.service'].includes('Restart=on-failure'))
  assert.ok(result.files['tokenguard-weekly.service'].includes(CLI))
  assert.ok(result.notes.join(' ').includes('systemctl --user'))
})

test('renderAutostart: Task Scheduler для Windows', () => {
  const result = renderAutostart({ os: 'win32', node: 'C:\\node\\node.exe', cli: 'C:\\tokenguard\\bin\\tokenguard.js', root: 'C:\\Sites' })
  const batch = result.files['tokenguard-schtasks.bat']
  assert.ok(batch.includes('schtasks /Create'))
  assert.ok(batch.includes('tokenguard mcpwatch'))
  assert.ok(result.notes.join(' ').includes('schtasks'))
})

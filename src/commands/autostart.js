/** autostart: готовые конфиги автозапуска для macOS, Linux и Windows. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDir, writeFile } from '../util/files.js'
import { info, ok, warn, bold } from '../log.js'

export const VALUE_FLAGS = ['os', 'out', 'root']

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tokenguard.js')
const NODE = process.execPath

export async function run(positional, flags) {
  const sub = positional[0]
  if (!sub || sub === 'print') return print(flags)
  console.log(HELP)
  return 0
}

const HELP = `${bold('tokenguard autostart')} — автозапуск на разных ОС

  tokenguard autostart print [--os auto|darwin|linux|win32] [--root <dir>] [--out <dir>]
      Показать (или сохранить) готовые конфиги: launchd / systemd / Task Scheduler.
`

/** Сгенерировать файлы автозапуска для ОС. Возвращает {os, files, notes}. */
export function renderAutostart({ os, node = NODE, cli = CLI, root = process.cwd() }) {
  if (os === 'darwin') {
    const plist = (label, args) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((part) => `<string>${part}</string>`).join('')}</array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/tmp/${label}.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/${label}.err.log</string>
</dict>
</plist>
`
    return {
      os,
      files: {
        'ai.tokenguard.weekly.plist': plist('ai.tokenguard.weekly', [node, cli, 'artifacts', 'clean', '--older-than', '30', '--apply']),
        'ai.tokenguard.mcpwatch.plist': plist('ai.tokenguard.mcpwatch', [node, cli, 'mcp', 'watch', '--interval', '300', '--apply', '--apply-dsh']),
      },
      notes: ['cp *.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) <plist>'],
    }
  }
  if (os === 'linux') {
    const weeklyService = `[Unit]
Description=tokenguard weekly maintenance

[Service]
Type=oneshot
WorkingDirectory=${root}
ExecStart=${node} ${cli} mcp lazy --all --apply --apply-dsh
ExecStart=${node} ${cli} artifacts clean --older-than 30 --apply
`
    const weeklyTimer = `[Unit]
Description=tokenguard weekly timer

[Timer]
OnCalendar=Mon 10:00
Persistent=true

[Install]
WantedBy=timers.target
`
    const watchService = `[Unit]
Description=tokenguard MCP config watcher

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${node} ${cli} mcp watch --interval 300 --apply --apply-dsh
Restart=on-failure
RestartSec=30
`
    return {
      os,
      files: {
        'tokenguard-weekly.service': weeklyService,
        'tokenguard-weekly.timer': weeklyTimer,
        'tokenguard-mcpwatch.service': watchService,
      },
      notes: [
        'mkdir -p ~/.config/systemd/user && cp *.service *.timer ~/.config/systemd/user/',
        'systemctl --user daemon-reload',
        'systemctl --user enable --now tokenguard-weekly.timer tokenguard-mcpwatch.service',
      ],
    }
  }
  // win32
  const weekly = `schtasks /Create /TN "tokenguard weekly" /SC WEEKLY /D MON /ST 10:00 /TR "\\"${node}\\" \\"${cli}\\" mcp lazy --all --apply --apply-dsh"`
  const scan = `schtasks /Create /TN "tokenguard scan" /SC WEEKLY /D MON /ST 10:05 /TR "\\"${node}\\" \\"${cli}\\" scan"`
  const watch = `schtasks /Create /TN "tokenguard mcpwatch" /SC MINUTE /MO 15 /TR "\\"${node}\\" \\"${cli}\\" mcp lazy --all --apply --apply-dsh"`
  return {
    os: 'win32',
    files: { 'tokenguard-schtasks.bat': `@echo off\r\n${weekly}\r\n${scan}\r\n${watch}\r\n` },
    notes: [
      'Запусти tokenguard-schtasks.bat от имени администратора (или через Планировщик заданий).',
      'Проверить: schtasks /Query /TN "tokenguard mcpwatch"',
      'Удалить: schtasks /Delete /TN "tokenguard mcpwatch" /F',
    ],
  }
}

function print(flags) {
  const requested = String(flags.os ?? 'auto')
  const os = requested === 'auto' ? process.platform : requested
  if (!['darwin', 'linux', 'win32'].includes(os)) {
    warn(`неизвестная ОС «${requested}»: доступны darwin, linux, win32`)
    return 1
  }
  const root = path.resolve(flags.root ? String(flags.root) : process.cwd())
  const result = renderAutostart({ os, root })
  if (flags.out) {
    const dir = path.resolve(String(flags.out))
    ensureDir(dir)
    for (const [name, content] of Object.entries(result.files)) writeFile(path.join(dir, name), content)
    ok(`конфиги сохранены: ${dir}`)
  } else {
    for (const [name, content] of Object.entries(result.files)) {
      console.log(bold(`--- ${name} ---`))
      console.log(content)
    }
  }
  console.log('')
  for (const note of result.notes) info(note)
  info(`ОС: ${os}; cwd проекта: ${root}`)
  return 0
}

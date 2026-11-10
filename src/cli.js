/** tokenguard — CLI for AI-harness context hygiene. */
import { readFile } from 'node:fs/promises'
import { bold, dim } from './log.js'
import { migrateLegacyHome } from './util/files.js'

export const HELP = `${bold('tokenguard')} ${dim('— линтер контекста для AI-харнессов')}

${bold('Использование:')}
  tokenguard <команда> [опции]
  tokenguard version | --version

${bold('Команды:')}
  scan [--root <dir>] [--json]
      Обзор: найденные харнессы и сессии, MCP-оверхед, мёртвые проекты, состояние docs.

  report [--days 7] [--json] [--html <file>] [--pricing <file>]
      Профайлер токенов: по дням, сессиям и инструментам; оценка стоимости.
      --html — самодостаточный HTML-отчёт с графиками, топ-сессиями и инструментами.

  budget set --daily 20M [--weekly 100M]
  budget status | check
      Бюджет токенов: расход, остаток, прогноз; check — код 1 при перерасходе.

  guard install | status | check [--root <dir>]
      Правило экономии контекста в AGENTS.md и проверка дрейфа темы.

  autostart print [--os auto|darwin|linux|win32] [--out <dir>]
      Готовые конфиги автозапуска: launchd, systemd, Task Scheduler.

  chats list [--all] [--json] [--limit N]
  chats digest <session> [--out <file>] [--client dsh|claude-code|codex]
  chats rename <session> <title> [--force]
  chats archive <session...> [--apply]
  chats clean --older-than <days> [--apply]
  chats drift [<session>|--all] [--threshold 0.2] [--window 3] [--json]
      Безопасный архивариус: список, конспект, переименование по смыслу,
      архивация, удаление с бэкапом и детектор смены темы в диалоге.

  mcp audit [--probe] [--json]
  mcp lazy <server> [--client <client>] [--apply] [--idle <minutes>]
  mcp verify [<server>|--all] [--timeout 10] [--json]
      Аудит MCP-конфигов (инструменты, токены, использование), перевод
      сервера в ленивый режим и живая проверка (initialize + tools/list).

  projects scan [--root <dir>] [--json]
  projects archive <path> [--apply] [--delete]
      Поиск мёртвых/незавершённых проектов и безопасная архивация.

  docs index [--root <dir>] [--write] [--json]
  docs check [--root <dir>] [--json] [--strict]
      Индекс Markdown-документации и поиск противоречий/устаревших мест.

  artifacts list [--kind <тип>] [--json]
  artifacts clean (--all | --kind <тип> | --older-than <дней>) [--apply]
      Что создал tokenguard (бэкапы, конспекты, прокси, архивы) и безопасное удаление.

  doctor [--json] [--strict] [--fix] [--root <dir>]
      Самодиагностика: Node.js, каталог данных и права, бэкапы, реестр артефактов,
      харнессы, MCP-конфиги, lazy-прокси, хук DSH, автозапуск, конфиг, место на диске.
      --fix — безопасные исправления (каталоги, права 700, битые записи реестра).

  attachments list [--json]
  attachments clean [--older-than <дней>] [--apply] [--json]
      Вложения DSH: сколько занимают, какие осиротели, безопасная очистка.

  completions [bash|zsh|fish] [--out <file>]
      Скрипт автодополнения команд для оболочки.

  init [--apply] [--json] [--root <dir>]
      Первичная настройка: каталог данных, guard-правило в AGENTS.md,
      хук DSH (если профиль готов), подсказка по автозапуску.

${bold('Принципы:')}
  • по умолчанию ничего не меняется (dry-run), изменения — только с --apply;
  • перед любым изменением делается бэкап в ~/.tokenguard/backups;
  • живые сессии (изменённые <2 мин назад) не трогаются без --force;
  • никаких сетевых вызовов без явных флагов.

${bold('Переменные окружения:')}
  CCLINER_HOME   каталог данных tokenguard (по умолчанию ~/.tokenguard)
  NO_COLOR       отключить цвета
  CCLINER_DEBUG  показать стек ошибок

${bold('Сделано в Lidogen 360:')}
  lidogenerator.top — сайты и лендинги, которые приносят клиентов.
  https://lidogenerator.top/?utm_source=tokenguard&utm_medium=cli&utm_campaign=brand
`

/** Разобрать аргументы: флаги --key, --key=value, --key value. */
export function parseArgs(argv, valueFlags = []) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--')) {
      let [key, value] = token.slice(2).split(/=(.*)/s)
      if (value === undefined && valueFlags.includes(key)) {
        value = argv[i + 1]
        i += 1
      }
      flags[key] = value === undefined ? true : value
      continue
    }
    positional.push(token)
  }
  return { flags, positional }
}

const LOADERS = {
  scan: () => import('./commands/scan.js'),
  chats: () => import('./commands/chats.js'),
  mcp: () => import('./commands/mcp.js'),
  projects: () => import('./commands/projects.js'),
  docs: () => import('./commands/docs.js'),
  artifacts: () => import('./commands/artifacts.js'),
  doctor: () => import('./commands/doctor.js'),
  attachments: () => import('./commands/attachments.js'),
  completions: () => import('./commands/completions.js'),
  init: () => import('./commands/init.js'),
  report: () => import('./commands/report.js'),
  budget: () => import('./commands/budget.js'),
  guard: () => import('./commands/guard.js'),
  autostart: () => import('./commands/autostart.js'),
}

export async function main(argv) {
  const migrated = migrateLegacyHome()
  if (migrated) console.log(`ℹ данные перенесены: ~/.ccliner → ${migrated.replace(process.env.HOME ?? '', '~')}`)
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP)
    return 0
  }
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`tokenguard ${pkg.version}`)
    return 0
  }
  const command = argv[0]
  const load = LOADERS[command]
  if (!load) {
    console.error(`tokenguard: неизвестная команда «${command}». Запусти tokenguard help`)
    return 1
  }
  const module = await load()
  const { flags, positional } = parseArgs(argv.slice(1), module.VALUE_FLAGS ?? [])
  return await module.run(positional, flags)
}

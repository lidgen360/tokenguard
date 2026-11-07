/** ccliner — CLI for AI-harness context hygiene. */
import { readFile } from 'node:fs/promises'
import { bold, dim } from './log.js'

export const HELP = `${bold('ccliner')} ${dim('— линтер контекста для AI-харнессов')}

${bold('Использование:')}
  ccliner <команда> [опции]
  ccliner version | --version

${bold('Команды:')}
  scan [--root <dir>] [--json]
      Обзор: найденные харнессы и сессии, MCP-оверхед, мёртвые проекты, состояние docs.

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
      Аудит MCP-конфигов (инструменты, токены, использование) и перевод
      сервера в ленивый режим (2 инструмента, запуск по требованию).

  projects scan [--root <dir>] [--json]
  projects archive <path> [--apply] [--delete]
      Поиск мёртвых/незавершённых проектов и безопасная архивация.

  docs index [--root <dir>] [--write] [--json]
  docs check [--root <dir>] [--json] [--strict]
      Индекс Markdown-документации и поиск противоречий/устаревших мест.

  artifacts list [--kind <тип>] [--json]
  artifacts clean (--all | --kind <тип> | --older-than <дней>) [--apply]
      Что создал ccliner (бэкапы, конспекты, прокси, архивы) и безопасное удаление.

${bold('Принципы:')}
  • по умолчанию ничего не меняется (dry-run), изменения — только с --apply;
  • перед любым изменением делается бэкап в ~/.ccliner/backups;
  • живые сессии (изменённые <2 мин назад) не трогаются без --force;
  • никаких сетевых вызовов без явных флагов.

${bold('Переменные окружения:')}
  CCLINER_HOME   каталог данных ccliner (по умолчанию ~/.ccliner)
  NO_COLOR       отключить цвета
  CCLINER_DEBUG  показать стек ошибок
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
}

export async function main(argv) {
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP)
    return 0
  }
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`ccliner ${pkg.version}`)
    return 0
  }
  const command = argv[0]
  const load = LOADERS[command]
  if (!load) {
    console.error(`ccliner: неизвестная команда «${command}». Запусти ccliner help`)
    return 1
  }
  const module = await load()
  const { flags, positional } = parseArgs(argv.slice(1), module.VALUE_FLAGS ?? [])
  return await module.run(positional, flags)
}

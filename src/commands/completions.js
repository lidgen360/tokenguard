/** completions: автодополнение для bash, zsh и fish. */
import fs from 'node:fs'
import path from 'node:path'
import { expand } from '../util/files.js'
import { bold, info, ok, warn } from '../log.js'

export const VALUE_FLAGS = ['out']

const HELP = `${bold('tokenguard completions')} — автодополнение команд

  tokenguard completions [bash|zsh|fish] [--out <file>]
      Печатает скрипт автодополнения (или сохраняет в файл).
      Установка:
        bash:  tokenguard completions bash | sudo tee /etc/bash_completion.d/tokenguard
        zsh:   tokenguard completions zsh > "\${fpath[1]}/_tokenguard"
        fish:  tokenguard completions fish > ~/.config/fish/completions/tokenguard.fish
`

const COMMANDS = [
  ['scan', 'сводка по окружению'],
  ['report', 'профайлер токенов'],
  ['budget', 'бюджет токенов'],
  ['guard', 'правило экономии контекста'],
  ['autostart', 'конфиги автозапуска'],
  ['chats', 'чат-архивариус и дрейф темы'],
  ['mcp', 'аудит и ленивый MCP'],
  ['projects', 'мёртвые проекты'],
  ['docs', 'индекс и проверка документации'],
  ['artifacts', 'реестр артефактов'],
  ['doctor', 'самодиагностика'],
  ['attachments', 'вложения DSH'],
  ['completions', 'автодополнение'],
  ['init', 'первичная настройка'],
  ['version', 'версия'],
  ['help', 'справка'],
]

const SUBCOMMANDS = {
  chats: ['list', 'digest', 'rename', 'archive', 'clean', 'drift', 'compact', 'tools'],
  mcp: ['audit', 'lazy', 'watch', 'verify'],
  projects: ['scan', 'archive'],
  docs: ['index', 'check'],
  artifacts: ['list', 'clean'],
  budget: ['set', 'status', 'check'],
  guard: ['install', 'status', 'check'],
  autostart: ['print'],
  attachments: ['list', 'clean'],
}

const FLAGS = ['--json', '--help', '--apply', '--fix', '--strict', '--root', '--days', '--older-than', '--all', '--limit', '--out', '--timeout']

function bashScript() {
  const cases = Object.entries(SUBCOMMANDS)
    .map(([command, subs]) => `    ${command}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ); return ;;`)
    .join('\n')
  return `# bash completion for tokenguard
# установка: tokenguard completions bash | sudo tee /etc/bash_completion.d/tokenguard

_tokenguard() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="${COMMANDS.map(([name]) => name).join(' ')}"
  local flags="${FLAGS.join(' ')}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${cases}
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
  fi
  return 0
}

complete -F _tokenguard tokenguard
complete -F _tokenguard ccliner
`
}

function zshScript() {
  const commandList = COMMANDS.map(([name, desc]) => `    '${name}:${desc}'`).join('\n')
  const subCases = Object.entries(SUBCOMMANDS)
    .map(([command, subs]) => `      ${command}) _values 'подкоманда' ${subs.map((sub) => `'${sub}'`).join(' ')} ;;`)
    .join('\n')
  return `#compdef tokenguard ccliner
# установка: tokenguard completions zsh > "\${fpath[1]}/_tokenguard"

_tokenguard() {
  local -a commands
  commands=(
${commandList}
  )

  _arguments -C \\
    '1:команда:->command' \\
    '*::аргумент:->args' \\
    '--json[машиночитаемый вывод]' \\
    '--help[справка]'

  case $state in
    command)
      _describe 'команда' commands
      ;;
    args)
      case $words[2] in
${subCases}
        *) _files ;;
      esac
      ;;
  esac
}

_tokenguard "$@"
`
}

function fishScript() {
  const lines = []
  for (const [name, desc] of COMMANDS) {
    lines.push(`complete -c tokenguard -n '__fish_use_subcommand' -a ${name} -d '${desc}'`)
    lines.push(`complete -c ccliner -n '__fish_use_subcommand' -a ${name} -d '${desc}'`)
  }
  for (const [command, subs] of Object.entries(SUBCOMMANDS)) {
    for (const sub of subs) {
      lines.push(`complete -c tokenguard -n '__fish_seen_subcommand_from ${command}' -a ${sub}`)
    }
  }
  lines.push('complete -c tokenguard -l json -d \'машиночитаемый вывод\'')
  lines.push('complete -c tokenguard -l help -d \'справка\'')
  return `# fish completion for tokenguard
# установка: tokenguard completions fish > ~/.config/fish/completions/tokenguard.fish
${lines.join('\n')}\n`
}

export function scriptFor(shell) {
  if (shell === 'bash') return bashScript()
  if (shell === 'zsh') return zshScript()
  if (shell === 'fish') return fishScript()
  return null
}

function detectShell() {
  const shell = path.basename(process.env.SHELL ?? '')
  if (shell === 'zsh' || shell === 'bash' || shell === 'fish') return shell
  return 'bash'
}

export async function run(positional, flags) {
  if (flags.help) {
    console.log(HELP)
    return 0
  }
  const shell = positional[0] ?? detectShell()
  const script = scriptFor(shell)
  if (!script) {
    warn(`неизвестная оболочка «${shell}». Доступно: bash, zsh, fish`)
    return 1
  }
  if (flags.out) {
    const target = path.resolve(expand(String(flags.out)))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, script, 'utf8')
    ok(`автодополнение ${shell} сохранено: ${target}`)
    info(`подключи файл в конфиге оболочки (см. tokenguard help completions)`)
    return 0
  }
  process.stdout.write(script)
  return 0
}

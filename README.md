# tokenguard

[![CI](https://github.com/lidgen360/tokenguard/actions/workflows/ci.yml/badge.svg)](https://github.com/lidgen360/tokenguard/actions/workflows/ci.yml)

<p align="center">
  <img src="assets/tokenguard-mascot-360.png" width="200" alt="tokenguard — хитрая крыса в доспехах">
</p>

**Линтер контекста для AI-харнессов.** Наводит порядок в чатах, MCP-серверах,
заброшенных проектах и Markdown-документации — чтобы агенты меньше жгли токены
и не тонули в устаревшем контексте.

> TL;DR: `tokenguard scan` — посмотреть, где утекает контекст;
> `tokenguard chats rename`, `tokenguard mcp lazy`, `tokenguard projects scan`,
> `tokenguard docs index` — починить.

## Зачем

Современные харнессы (DSH, Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code)
несут в каждый запрос схемы всех инструментов, длинную историю и документацию.
На практике это десятки тысяч токенов на запрос, из которых большая часть —
неиспользуемые MCP-инструменты и устаревшие тексты.

tokenguard измеряет этот оверхед и уменьшает его безопасно: по умолчанию ничего не
меняет, перед изменениями делает бэкапы, не трогает активные сессии.

## Что умеет

| Команда | Что делает |
|---|---|
| `tokenguard scan` | Сводка: харнессы, чаты, MCP, мёртвые проекты, проблемы docs |
| `tokenguard chats list` | Список чатов с размерами и токенами |
| `tokenguard chats digest <id>` | Авто-конспект чата (без LLM): запросы, файлы, команды |
| `tokenguard chats rename <id> "Название"` | Переименовать чат по смыслу (штатным событием `session/title`) |
| `tokenguard chats archive <id>` | Архивировать/удалить чат с tar-бэкапом |
| `tokenguard chats clean --older-than 30` | Найти и убрать старые чаты |
| `tokenguard chats drift [--all]` | Детектор смены темы: где разговор ушёл в сторону и где выгодно начать новый чат (с оценкой сэкономленных токенов) |
| `tokenguard chats compact <id>` | Сжать старую часть чата в конспект и продолжить в новом чате |
| `tokenguard chats pressure` | Давление контекста: размер последнего запроса по сессиям, порог и оценка экономии |
| `tokenguard chats compact --auto` | Выбрать самую тяжёлую сессию выше порога и сжать её |
| `tokenguard chats tools <id>` | Повторные одинаковые tool-вызовы: сколько раз и сколько токенов впустую |
| `tokenguard report [--days 7]` | Профайлер токенов: по дням, сессиям и инструментам, с оценкой стоимости |
| `tokenguard report --html report.html` | Самодостаточный HTML-отчёт: графики по дням, топ-сессии и инструменты, маскот |
| `tokenguard budget set/status/check` | Дневной/недельный бюджет токенов и контроль перерасхода |
| `tokenguard guard install/status/check` | Правило экономии контекста в AGENTS.md и проверка дрейфа темы |
| `tokenguard artifacts list` | Что создал tokenguard: бэкапы, конспекты, lazy-прокси, архивы |
| `tokenguard artifacts clean --all` | Безопасно удалить артефакты tokenguard (dry-run по умолчанию) |
| `tokenguard doctor` | Самодиагностика: Node.js, данные и права, бэкапы, харнессы, MCP, lazy-прокси, хук DSH, автозапуск, конфиг, диск; `--fix` — безопасные исправления |
| `tokenguard attachments list` | Вложения DSH: сколько занимают, какие осиротели |
| `tokenguard attachments clean --older-than 14` | Удалить осиротевшие вложения старше 14 дней (dry-run, с `--apply` — удаление) |
| `tokenguard completions bash` | Автодополнение для bash, zsh или fish |
| `tokenguard init` | Первичная настройка: данные, guard-правило, хук, подсказка по автозапуску |
| `tokenguard mcp audit [--probe]` | Найти MCP-конфиги, посчитать инструменты и токены их схем, показать использование |
| `tokenguard mcp lazy <server>` | Сгенерировать ленивый прокси: 2 инструмента вместо всех, запуск по требованию |
| `tokenguard mcp verify <server>` | Живая проверка MCP: `initialize` + `tools/list`, число инструментов и латентность |
| `tokenguard mcp lazy --all [--apply] [--apply-dsh]` | Перевести в ленивый режим все stdio-серверы; `--apply-dsh` — точечно патчит профиль DSH |
| `tokenguard projects scan` | Мёртвые/незавершённые проекты по git-метрикам |
| `tokenguard projects archive <path>` | git bundle + tar + опись, опционально перенос в архив |
| `tokenguard docs index` | Построить INDEX.md: заголовки, описания, дубли, осиротевшие, устаревшие |
| `tokenguard docs check` | Битые ссылки, противоречащие значения (порты/версии), дубли текста, устаревшие «актуально на» |


## Установка

```bash
git clone https://github.com/lidgen360/tokenguard.git
cd tokenguard
npm ci            # зависимости: yaml, smol-toml
npm link          # команды tokenguard и ccliner (алиас) в PATH
tokenguard version
```

Без глобальной установки: `node bin/tokenguard.js <команда>`.

Старое имя `ccliner` сохранено как алиас; данные один раз переносятся
из `~/.ccliner` в `~/.tokenguard`.

### Автозапуск

```bash
# macOS — launchd
tokenguard autostart print --os darwin --out ./services
cp ./services/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.tokenguard.weekly.plist

# Linux — systemd user units
tokenguard autostart print --os linux --out ./services
mkdir -p ~/.config/systemd/user && cp ./services/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now tokenguard-weekly.timer tokenguard-mcpwatch.service

# Windows — Task Scheduler
tokenguard autostart print --os win32 --out ./services
# затем запустить от администратора:
services\tokenguard-schtasks.bat
```

`autostart print` подставляет пути к текущему `node` и CLI — генерируйте конфиги
на целевой машине.

### Откуда вызывать

Из любой папки — команда работает с текущим каталогом либо с `--root`:

```bash
cd path/to/your/project && tokenguard scan
tokenguard docs check --root path/to/your/project
tokenguard chats drift
```

Внутри агента (DSH/Claude Code) правило в `AGENTS.md` проекта может просить
проверить `tokenguard chats drift` перед продолжением длинного чата.

Как регулярный сервис (опционально): `tokenguard autostart print` (launchd/systemd/schtasks)
или `tokenguard scan --root ~/projects` и `tokenguard artifacts clean --older-than 30 --apply`.

## Быстрый старт

Требуется Node.js ≥ 20 (zstd — встроенный, для Node < 23.8 нужна утилита `zstd`
в PATH).

```bash
git clone https://github.com/lidgen360/tokenguard.git tokenguard && cd tokenguard
npm ci
node bin/tokenguard.js doctor
node bin/tokenguard.js scan
node bin/tokenguard.js mcp audit --probe
node bin/tokenguard.js chats list
node bin/tokenguard.js docs index --write
```

## Пример: ленивый MCP

Обычный MCP-сервер публикует десятки инструментов, и их JSON-схемы уходят в модель
в каждом запросе. `tokenguard mcp lazy` генерирует прокси-сервер, который для клиента
выглядит как 2 инструмента:

- `list_tools` — вернуть список инструментов upstream (по требованию);
- `call_tool` — вызвать любой из них.

Upstream запускается при первом вызове и останавливается после простоя
(`CCLINER_LAZY_IDLE_MS`, по умолчанию 10 минут).

```bash
node bin/tokenguard.js mcp lazy safari --probe
```

Для JSON-клиентов (Claude Code, Cursor, Gemini, VS Code) конфиг переписывается
автоматически с `--apply`; для DSH печатается готовый YAML-блок.

## Давление контекста

Накопительные «200M токенов» в сессии — это сумма за сотни запросов, а не размер контекста.
Реальный расход определяет **последний запрос**: именно столько уходит в модель каждый раз.
`chats pressure` показывает последний запрос, максимум, накопительную сумму и оценку экономии:

```bash
tokenguard chats pressure                  # порог 350k, топ-12
tokenguard chats pressure --threshold 300k --top 5
tokenguard chats pressure --json
```

Порог можно задать один раз в `~/.tokenguard/config.json`:

```json
{ "contextThreshold": "350k" }
```

Сжать самую тяжёлую сессию выше порога (создаёт конспект для нового чата):

```bash
tokenguard chats compact --auto --threshold 350k
```

`compact` не удаляет историю и не создаёт чат сам: он пишет конспект (с маскировкой секретов),
который вставляется первым сообщением в новый чат.

## Отчёты и уборка

```bash
tokenguard report --days 7 --html report.html   # один файл: без внешних CSS/JS и запросов
tokenguard attachments list                     # сколько занимают вложения DSH
tokenguard attachments clean --older-than 14    # dry-run: только осиротевшие
tokenguard attachments clean --older-than 14 --apply
```

HTML-отчёт можно открыть локально или отправить как артефакт: внутри inline-графики,
итоги, топ-сессии и инструменты, маскот; данных наружу не уходит.

`attachments` удаляет только объекты, на которые не ссылается ни одна сессия, и только
старше порога. Если сессии прочитать не удалось, очистка отменяется — ничего не теряется.

## Детектор смены темы

Длинный чат — это растущий контекст, который оплачивается в каждом запросе.
`tokenguard chats drift` находит моменты, где тема разговора сменилась, и оценивает,
сколько токенов экономил бы новый чат.

```bash
tokenguard chats drift                 # последний чат
tokenguard chats drift <session>       # конкретный чат
tokenguard chats drift --all           # какие чаты давно пора делить
```

Внутри — лексическая близость соседних сообщений (Jaccard по значимым словам),
оценка экономии по usage из логов (в DSH) или по объёму текста (в остальных
харнессах). Рекомендация всегда сопровождается оценкой и не меняет ничего сама.

## Автоматический новый чат (Safari)

`bin/tokenguard-dsh-new-chat.js` создаёт новый чат в живом DSH GUI без CLI и без ручных шагов:

```sh
node bin/tokenguard-dsh-new-chat.js --prompt-file docs/CHAT-COMPACT.md
node bin/tokenguard-dsh-new-chat.js --prompt "Перенос из чата: прочитай docs/CHAT-COMPACT.md"
node bin/tokenguard-dsh-new-chat.js --dry-run          # только проверить вкладку и кнопки
```

Скрипт находит вкладку DSH в Safari (`DSH_WEB_URL`, по умолчанию `http://127.0.0.1:3080`),
нажимает «Новая сессия», вставляет текст переноса в композер и отправляет. Вкладка не
перезагружается, логин переиспользуется. Нужен включённый Safari → Develop → «Allow JavaScript
from Apple Events».

Полный сценарий агента: маркер `[tokenguard-drift]` → предупреждение → интерактивный вопрос
«Создать новый чат?» (Да/Нет) → при Да: `chats digest` + `chats compact` + этот скрипт.

## Хук для DeepSeek Harness

`bin/tokenguard-dsh-hook.js` — UserPromptSubmit-хук: на каждом запросе запускает `chats drift` и добавляет
в контекст модели маркер `[tokenguard-drift]` с предупреждением. Агент обязан вывести его первым блоком
ответа, поэтому «смена темы — создать новый чат?» появляется в чате без ручных команд.

Подключение (Web-профиль DSH):

1. Поставить мост хуков: `dsh plugin --profile web add <dsh-checkout>/packages/experimental/hooks-claude-code`
2. Создать `~/.dsh/hooks/tokenguard-hooks.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"/path/to/tokenguard/bin/tokenguard-dsh-hook.js\"", "timeout": 10 } ] }
    ]
  }
}
```

3. Строка в `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: hooks-claude-code
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: /home/you/.dsh/hooks/tokenguard-hooks.json
```

Хук молчит, пока дрейфа нет (модель не тратит контекст зря); при дрейфе добавляет ~200 символов.
Стоимость проверки: ~1.4 с на запрос (чтение лога сессии).

**Отключение хука.** Положи `{"driftHook": false}` в `~/.tokenguard/config.json` (или выставь
`TOKENGUARD_DRIFT_HOOK=0` в окружении харнесса) — хук замолчит со следующего запроса, перезапуск DSH
не нужен. `chats drift`/`digest`/`compact` остаются доступны вручную, а guard-правило больше не просит
предлагать новый чат.

## Профайлер, бюджет и guard

```bash
tokenguard report --days 7              # где ушли токены: дни, сессии, инструменты
tokenguard report --days 30 --json      # машинный формат
# лимиты опциональны; по умолчанию они отключены (budget.json отсутствует)
tokenguard budget set --daily 20M --weekly 150M
tokenguard budget status                # потрачено/лимит/прогноз
tokenguard budget check                 # код 1 при перерасходе (launchd/cron)
tokenguard guard install                # правило в AGENTS.md проекта
tokenguard guard check --strict         # проверить дрейф темы (код 1, если есть)
```

Оценка в деньгах: создай `~/.tokenguard/pricing.json`:

```json
{ "currency": "USD", "perMillion": { "input": 0.28, "cacheRead": 0.028, "output": 0.42 } }
```

## Что клинер сделал — найти и удалить

`tokenguard artifacts` ведёт реестр всех артефактов, которые создал инструмент:
бэкапы перед изменениями, конспекты чатов, сгенерированные lazy-прокси, архивы
проектов, INDEX.md. Реестр лежит в `~/.tokenguard/manifest.jsonl`.

```bash
tokenguard artifacts list                     # что создано, сколько занимает
tokenguard artifacts list --kind backup       # только бэкапы
tokenguard artifacts clean --older-than 30    # dry-run: что можно удалить
tokenguard artifacts clean --all --apply      # удалить (только внутри ~/.tokenguard)
```

Удаляются только файлы внутри каталога tokenguard — это защита от «удали то, не знаю что».
Переименования сессий показываются, но не удаляются: их бэкапы остаются в `~/.tokenguard/backups`.

### Автоматический lazy для новых MCP

`tokenguard mcp watch` — кроссплатформенный наблюдатель: при изменении MCP-конфигов
запускает `tokenguard mcp lazy --all --apply --apply-dsh`.

- JSON-клиенты (Claude Code, Cursor, Gemini, VS Code) — конфиг переписывается сразу;
- DSH — блок сервера в `cordis.patch.yml` заменяется точечно (бэкап + проверка YAML),
  харнесс подхватит после перезапуска;
- `--once` — один прогон для cron/Task Scheduler, `--interval <сек>` — период опроса.

Автозапуск для всех ОС: `tokenguard autostart print --os darwin|linux|win32`
(launchd / systemd user units / `schtasks`). На macOS пример launchd-агента
(`WatchPaths` + `StartInterval`) генерируется этим же `autostart print --os darwin`;
готовые plist-файлы в репозиторий не входят.

Управление launchd-агентом на macOS (если используешь launchd):

```bash
launchctl kickstart -k gui/$(id -u)/ai.tokenguard.mcpwatch   # прогнать сейчас
launchctl bootout     gui/$(id -u)/ai.tokenguard.mcpwatch   # выключить
```

Ограничение: следятся глобальные конфиги (список путей в `mcp watch`). Проектные
`.mcp.json` охватываются, если запускать `tokenguard mcp lazy --all --apply`
в каталоге проекта или добавить путь в конфиг.

## Поддерживаемые харнессы

| Харнесс | Чаты | Rename | MCP-конфиг |
|---|---|---|---|
| DeepSeek Harness (DSH) | ✅ | ✅ штатно | ✅ YAML-профили |
| Claude Code | ✅ | — | ✅ `~/.claude.json`, `.mcp.json` |
| OpenAI Codex CLI | ✅ (best effort) | — | ✅ `config.toml` |
| Gemini CLI | — | — | ✅ `settings.json` |
| Cursor | — | — | ✅ `~/.cursor/mcp.json` |
| VS Code / Copilot | — | — | ✅ `.vscode/mcp.json` |
| Claude Desktop | — | — | ✅ `claude_desktop_config.json` |

Формат адаптера простой: `detect / listSessions / extractDigest / renameSession`.
Новые харнессы добавляются в `src/adapters/`.

## Платформы

| ОС | CLI | Автозапуск | Заметки |
|---|---|---|---|
| **macOS** | ✅ | `autostart print --os darwin` (launchd) | нативный путь Claude Desktop, `mcp watch` |
| **Linux** | ✅ | `autostart print --os linux` (systemd user units) | `fs.watch` recursive при Node ≥ 20, плюс polling; `zstd` — нативно с Node ≥ 23.8 или пакет `zstd` |
| **Windows** | ✅ | `autostart print --os win32` → `.bat` с `schtasks` | `tar` встроен в Win10+, пути `%USERPROFILE%\.dsh`, `%APPDATA%\Claude` |

Что сделано для кроссплатформенности:

- только Node-API и `path.join`, бинарь ставится через `npm link` (создаёт `.cmd`-шим на Windows);
- пути Claude Desktop определяются по ОС (`Library/Application Support` на macOS, `%APPDATA%` на Windows, `~/.config` на Linux);
- `mcp watch` — кроссплатформенный наблюдатель (`fs.watch` + опрос), подходит для systemd/launchd/Task Scheduler;
- `autostart print` генерирует готовые конфиги для трёх ОС (launchd / systemd / `schtasks`);
- бэкапы — через `tar` (есть в macOS/Linux и в Windows 10+).

Требования: Node.js ≥ 20 (для нативного zstd — ≥ 23.8 либо утилита `zstd` в PATH),
`git` для анализа проектов, `tar` для бэкапов.

Ограничения: хуки DSH (`UserPromptSubmit`) — часть DSH и работают там, где работает DSH;
machine-специфичные пути к проектам в сервисных файлах генерируются из `--root`.

## Принципы безопасности

- **Dry-run по умолчанию.** Изменения только с `--apply`.
- **Бэкап перед изменением.** Всё сохраняется в `~/.tokenguard/backups`.
- **Живые сессии не трогаются.** Если файл сессии изменён <2 минут назад — нужен `--force`.
- **Никакой сети без флагов.** Конспекты строятся локально, без LLM.
- **Честные эвристики.** `docs check` — не «истина в последней инстанции», а подсказки;
  конспекты помечены как авто-материал для проверки.

## Структура

```
bin/tokenguard.js        — точка входа
src/cli.js            — разбор команд
src/adapters/         — харнессы: DSH, Claude Code, Codex, MCP-конфиги
src/commands/         — scan, chats, mcp, projects, docs
src/lazy/template.js  — генератор ленивого MCP-прокси (без зависимостей)
src/util/             — fs, zstd, токены, md, бэкапы, MCP-probe
test/                 — node:test, фикстуры без реальных данных
```

## Тесты

```bash
npm test
```

37 тестов: разбор Markdown, токены, сессии DSH, docs-противоречия, ленивый прокси,
детектор смены темы, реестр артефактов, редакция секретов, агрегаты DSH,
безопасный патчер профиля DSH и кроссплатформенный автозапуск.

## Дорожная карта

- [x] `report` + `budget`: профайлер токенов и лимиты
- [x] `mcp lazy --all`: массовый перевод MCP в ленивый режим
- [x] WatchPaths-агент: новые MCP автоматически становятся ленивыми
- [x] Кроссплатформенность: Windows/Linux пути, `mcp watch`, `autostart` для launchd/systemd/schtasks
- [x] `--apply-dsh`: точечная правка профиля DSH с бэкапом и проверкой YAML
- [x] `chats compact`: сжатие старой части чата
- [x] `guard`: правило в AGENTS.md + проверка дрейфа
- [x] `chats tools`: поиск повторных tool-вызовов
- [x] redaction секретов в конспектах
- [ ] `chats digest --llm` — конспекты «текущего состояния» через LLM
- [ ] Cursor/VS Code/Continue: чтение чатов из SQLite
- [x] `mcp lazy --apply` для DSH (правка YAML с сохранением комментариев)
- [ ] `docs index --check` в CI (GitHub Action)
- [ ] Экспорт отчёта `scan` в HTML

## Сделано в Lidogen 360

[![Lidogen 360](assets/logo.svg)](https://lidogenerator.top/?utm_source=tokenguard&utm_medium=readme&utm_campaign=brand)

tokenguard развивает команда [Lidogen 360](https://lidogenerator.top/?utm_source=tokenguard&utm_medium=readme&utm_campaign=brand) —
сайты и лендинги, которые приносят клиентов.

## Лицензия

MIT

# tokenguard

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
| `tokenguard chats tools <id>` | Повторные одинаковые tool-вызовы: сколько раз и сколько токенов впустую |
| `tokenguard report [--days 7]` | Профайлер токенов: по дням, сессиям и инструментам, с оценкой стоимости |
| `tokenguard budget set/status/check` | Дневной/недельный бюджет токенов и контроль перерасхода |
| `tokenguard guard install/status/check` | Правило экономии контекста в AGENTS.md и проверка дрейфа темы |
| `tokenguard artifacts list` | Что создал tokenguard: бэкапы, конспекты, lazy-прокси, архивы |
| `tokenguard artifacts clean --all` | Безопасно удалить артефакты tokenguard (dry-run по умолчанию) |
| `tokenguard mcp audit [--probe]` | Найти MCP-конфиги, посчитать инструменты и токены их схем, показать использование |
| `tokenguard mcp lazy <server>` | Сгенерировать ленивый прокси: 2 инструмента вместо всех, запуск по требованию |
| `tokenguard mcp lazy --all` | Перевести в ленивый режим все stdio-серверы из всех конфигов |
| `tokenguard projects scan` | Мёртвые/незавершённые проекты по git-метрикам |
| `tokenguard projects archive <path>` | git bundle + tar + опись, опционально перенос в архив |
| `tokenguard docs index` | Построить INDEX.md: заголовки, описания, дубли, осиротевшие, устаревшие |
| `tokenguard docs check` | Битые ссылки, противоречащие значения (порты/версии), дубли текста, устаревшие «актуально на» |


## Установка и вызов

```bash
cd ~/Sites/tokenguard
npm install       # зависимости (yaml, smol-toml)
npm link          # ставит в PATH команды tokenguard и ccliner (алиас)
tokenguard version
```

Старое имя `ccliner` сохранено как алиас. Данные автоматически переносятся
из `~/.ccliner` в `~/.tokenguard` при первом запуске.

Без установки: `node ~/Sites/tokenguard/bin/tokenguard.js <команда>`.

Откуда вызывать: из любой папки — команда работает с текущим каталогом либо с `--root`:

```bash
cd ~/Sites/Lidogenerator && tokenguard scan
tokenguard docs check --root ~/Sites/Lidogenerator
tokenguard chats drift
```

Изнутри агента (DSH/Claude Code) ничего вызывать вручную не нужно: правило в `AGENTS.md`
проекта просит агента проверить `tokenguard chats drift` перед продолжением длинного чата.

Как регулярный сервис (опционально): `launchd`/`cron` раз в неделю —
`tokenguard scan --root ~/Sites` и `tokenguard artifacts clean --older-than 30 --apply`.

## Быстрый старт

Требуется Node.js ≥ 20 (zstd — встроенный, для Node < 23.8 нужна утилита `zstd`
в PATH).

```bash
git clone <repo> tokenguard && cd tokenguard
npm install
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
      { "hooks": [ { "type": "command", "command": "node /Users/ila/Sites/tokenguard/bin/tokenguard-dsh-hook.js", "timeout": 10 } ] }
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
        configPath: /Users/ila/.dsh/hooks/tokenguard-hooks.json
```

Хук молчит, пока дрейфа нет (модель не тратит контекст зря); при дрейфе добавляет ~200 символов.
Стоимость проверки: ~1.4 с на запрос (чтение лога сессии).

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

25 тестов: разбор Markdown, токены, чтение/переименование сессий DSH, поиск
противоречий в docs, ленивый прокси (end-to-end с тестовым MCP-сервером),
детектор смены темы, реестр артефактов, редакция секретов, размеры и агрегаты DSH.

## Дорожная карта

- [x] `report` + `budget`: профайлер токенов и лимиты
- [x] `mcp lazy --all`: массовый перевод MCP в ленивый режим
- [x] `chats compact`: сжатие старой части чата
- [x] `guard`: правило в AGENTS.md + проверка дрейфа
- [x] `chats tools`: поиск повторных tool-вызовов
- [x] redaction секретов в конспектах
- [ ] `chats digest --llm` — конспекты «текущего состояния» через LLM
- [ ] Cursor/VS Code/Continue: чтение чатов из SQLite
- [ ] `mcp lazy --apply` для DSH (правка YAML с сохранением комментариев)
- [ ] `docs index --check` в CI (GitHub Action)
- [ ] Экспорт отчёта `scan` в HTML

## Лицензия

MIT

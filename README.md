# ccliner

**Линтер контекста для AI-харнессов.** Наводит порядок в чатах, MCP-серверах,
заброшенных проектах и Markdown-документации — чтобы агенты меньше жгли токены
и не тонули в устаревшем контексте.

> TL;DR: `ccliner scan` — посмотреть, где утекает контекст;
> `ccliner chats rename`, `ccliner mcp lazy`, `ccliner projects scan`,
> `ccliner docs index` — починить.

## Зачем

Современные харнессы (DSH, Claude Code, Codex CLI, Gemini CLI, Cursor, VS Code)
несут в каждый запрос схемы всех инструментов, длинную историю и документацию.
На практике это десятки тысяч токенов на запрос, из которых большая часть —
неиспользуемые MCP-инструменты и устаревшие тексты.

ccliner измеряет этот оверхед и уменьшает его безопасно: по умолчанию ничего не
меняет, перед изменениями делает бэкапы, не трогает активные сессии.

## Что умеет

| Команда | Что делает |
|---|---|
| `ccliner scan` | Сводка: харнессы, чаты, MCP, мёртвые проекты, проблемы docs |
| `ccliner chats list` | Список чатов с размерами и токенами |
| `ccliner chats digest <id>` | Авто-конспект чата (без LLM): запросы, файлы, команды |
| `ccliner chats rename <id> "Название"` | Переименовать чат по смыслу (штатным событием `session/title`) |
| `ccliner chats archive <id>` | Архивировать/удалить чат с tar-бэкапом |
| `ccliner chats clean --older-than 30` | Найти и убрать старые чаты |
| `ccliner chats drift [--all]` | Детектор смены темы: где разговор ушёл в сторону и где выгодно начать новый чат (с оценкой сэкономленных токенов) |
| `ccliner artifacts list` | Что создал ccliner: бэкапы, конспекты, lazy-прокси, архивы |
| `ccliner artifacts clean --all` | Безопасно удалить артефакты ccliner (dry-run по умолчанию) |
| `ccliner mcp audit [--probe]` | Найти MCP-конфиги, посчитать инструменты и токены их схем, показать использование |
| `ccliner mcp lazy <server>` | Сгенерировать ленивый прокси: 2 инструмента вместо всех, запуск по требованию |
| `ccliner projects scan` | Мёртвые/незавершённые проекты по git-метрикам |
| `ccliner projects archive <path>` | git bundle + tar + опись, опционально перенос в архив |
| `ccliner docs index` | Построить INDEX.md: заголовки, описания, дубли, осиротевшие, устаревшие |
| `ccliner docs check` | Битые ссылки, противоречащие значения (порты/версии), дубли текста, устаревшие «актуально на» |

## Быстрый старт

Требуется Node.js ≥ 20 (zstd — встроенный, для Node < 23.8 нужна утилита `zstd`
в PATH).

```bash
git clone <repo> ccliner && cd ccliner
npm install
node bin/ccliner.js scan
node bin/ccliner.js mcp audit --probe
node bin/ccliner.js chats list
node bin/ccliner.js docs index --write
```

## Пример: ленивый MCP

Обычный MCP-сервер публикует десятки инструментов, и их JSON-схемы уходят в модель
в каждом запросе. `ccliner mcp lazy` генерирует прокси-сервер, который для клиента
выглядит как 2 инструмента:

- `list_tools` — вернуть список инструментов upstream (по требованию);
- `call_tool` — вызвать любой из них.

Upstream запускается при первом вызове и останавливается после простоя
(`CCLINER_LAZY_IDLE_MS`, по умолчанию 10 минут).

```bash
node bin/ccliner.js mcp lazy safari --probe
```

Для JSON-клиентов (Claude Code, Cursor, Gemini, VS Code) конфиг переписывается
автоматически с `--apply`; для DSH печатается готовый YAML-блок.

## Детектор смены темы

Длинный чат — это растущий контекст, который оплачивается в каждом запросе.
`ccliner chats drift` находит моменты, где тема разговора сменилась, и оценивает,
сколько токенов экономил бы новый чат.

```bash
ccliner chats drift                 # последний чат
ccliner chats drift <session>       # конкретный чат
ccliner chats drift --all           # какие чаты давно пора делить
```

Внутри — лексическая близость соседних сообщений (Jaccard по значимым словам),
оценка экономии по usage из логов (в DSH) или по объёму текста (в остальных
харнессах). Рекомендация всегда сопровождается оценкой и не меняет ничего сама.

## Что клинер сделал — найти и удалить

`ccliner artifacts` ведёт реестр всех артефактов, которые создал инструмент:
бэкапы перед изменениями, конспекты чатов, сгенерированные lazy-прокси, архивы
проектов, INDEX.md. Реестр лежит в `~/.ccliner/manifest.jsonl`.

```bash
ccliner artifacts list                     # что создано, сколько занимает
ccliner artifacts list --kind backup       # только бэкапы
ccliner artifacts clean --older-than 30    # dry-run: что можно удалить
ccliner artifacts clean --all --apply      # удалить (только внутри ~/.ccliner)
```

Удаляются только файлы внутри каталога ccliner — это защита от «удали то, не знаю что».
Переименования сессий показываются, но не удаляются: их бэкапы остаются в `~/.ccliner/backups`.

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
- **Бэкап перед изменением.** Всё сохраняется в `~/.ccliner/backups`.
- **Живые сессии не трогаются.** Если файл сессии изменён <2 минут назад — нужен `--force`.
- **Никакой сети без флагов.** Конспекты строятся локально, без LLM.
- **Честные эвристики.** `docs check` — не «истина в последней инстанции», а подсказки;
  конспекты помечены как авто-материал для проверки.

## Структура

```
bin/ccliner.js        — точка входа
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

17 тестов: разбор Markdown, токены, чтение/переименование сессий DSH, поиск
противоречий в docs, ленивый прокси (end-to-end с тестовым MCP-сервером),
детектор смены темы и реестр артефактов.

## Дорожная карта

- [ ] `chats digest --llm` — конспекты «текущего состояния» через LLM (сейчас — эвристика)
- [ ] Cursor/VS Code/Continue: чтение чатов из SQLite
- [ ] `mcp lazy --apply` для DSH (аккуратная правка YAML с сохранением комментариев)
- [ ] `docs index --check` в CI (GitHub Action)
- [ ] Профили моделей и бюджетов: оценка стоимости запросов
- [ ] Экспорт отчёта `scan` в HTML

## Лицензия

MIT

# AGENTS.md — tokenguard

Базовые инструкции для работы над приложением. Полный контекст и история — в архиве
`~/Sites/archive/tokenguard/2026-11-14/` (см. `README.md` и `COMPACT-tokenguard-2026-11-14.md`).

## Что это

CLI для гигиены контекста AI-харнессов: чат-архивариус, детектор смены темы, давление контекста,
ленивый MCP, проверка документации, аудит вложений и самодиагностика.

## Команды

```bash
npm ci
npm test            # node --test, 87 тестов
npm run lint        # node --check по всем src
node bin/tokenguard.js help
node bin/tokenguard.js doctor
```

Версия: `package.json` + `package-lock.json` + запись в `CHANGELOG.md` (semver).
Текущая: **0.7.1**.

## Правила

- По умолчанию ничего не менять: изменения только с `--apply`, перед изменениями — бэкап.
- Живые сессии (изменённые < 2 мин) не трогать без `--force`.
- Новые команды: отдельный модуль в `src/commands/`, лоадер и помощь в `src/cli.js`,
  тесты в `test/`, строка в README и CHANGELOG.
- Без новых зависимостей, если можно обойтись Node stdlib; стиль — ESM, без `;`, русские сообщения.
- `--json` обязан всегда печатать валидный JSON, включая пустые данные и ошибки (`{"error": …}`).
- Коммит в `main`, пуш в `lidgen360/tokenguard`; CI: Linux + Windows на push, macOS — weekly/manual.
- Секреты не коммитить; в конспектах работает redaction.

## Лендинг и бренд

- Страница: `~/Sites/Lidogenerator/lidgen360/products/tokenguard.html`
  (каталог `products.html`), деплой: `~/Sites/Lidogenerator/scripts/deploy-site.sh`.
- Ассеты: `assets/` (вордмарк, лок-апы, кибер-иконка, OG 1200×630).
- Утверждённый дизайн: тёмный вордмарк + кибер-иконка; не менять без запроса.
- Прод: https://tokenguard.lidogenerator.top/ · https://lidogenerator.top/products/tokenguard.html

## Контекстный хук

`contextHook` по умолчанию выключен; включается в `~/.tokenguard/config.json`:

```json
{ "contextHook": true, "contextThreshold": "350k", "contextHookCooldownMinutes": 45 }
```

При превышении порога модель спрашивает согласие через `ask_user_question` (кнопки
«Сжать сейчас» / «Позже»), не чаще раза в 45 минут на сессию.

## Куда развивать (идеи)

- TUI/веб-дашборд по `report` и `chats pressure` (одна страница, без сервера).
- Недельный дайджест: pressure + drift + MCP + вложения в один отчёт.
- Прогноз стоимости по истории и «что будет, если сжать сейчас».
- Проверка здоровья lazy-прокси (живой handshake) — расширение `mcp verify`.
- Автоочистка вложений по расписанию (launchd/systemd) с отчётом.
- История давления контекста по сессиям (график роста).

#!/usr/bin/env bash
# Release-смоук tokenguard: проверяет, что релизный tarball ставится в чистый
# каталог и CLI работает без доступа к рабочей копии репозитория.
#
# Запуск: scripts/release-smoke.sh
# Требуется: node >= 20, npm, доступ к npm registry (для зависимостей yaml/smol-toml).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tokenguard-release-smoke.XXXXXX")"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

step() {
  printf '\n== %s ==\n' "$1"
}

VERSION="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$ROOT/package.json")"
PREFIX="$WORK/prefix"
HOME_DIR="$WORK/home"
DSH_DIR="$WORK/dsh"
PROJECT_DIR="$WORK/project"
mkdir -p "$HOME_DIR" "$DSH_DIR" "$PROJECT_DIR"

step "1/6 npm pack (версия $VERSION)"
npm pack --pack-destination "$WORK" >/dev/null
TARBALL="$WORK/tokenguard-$VERSION.tgz"
test -f "$TARBALL" || { echo "FAIL: tarball не создан: $TARBALL" >&2; exit 1; }
echo "tarball: $TARBALL ($(wc -c < "$TARBALL" | tr -d ' ') байт)"

step "2/6 установка из tarball в чистый префикс"
npm install -g --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1
BIN="$PREFIX/bin/tokenguard"
test -x "$BIN" || { echo "FAIL: нет исполняемого файла $BIN" >&2; exit 1; }
echo "установлено: $("$BIN" --version)"

step "3/6 изоляция: чистые HOME и DSH_HOME"
export HOME="$HOME_DIR"
export DSH_HOME="$DSH_DIR"
echo "HOME=$HOME"
echo "DSH_HOME=$DSH_HOME"

step "4/6 tokenguard --version и --help"
"$BIN" --version | grep -q "tokenguard $VERSION" || { echo "FAIL: неверная версия" >&2; exit 1; }
"$BIN" --help | grep -q "Использование:" || { echo "FAIL: --help без справки" >&2; exit 1; }
"$BIN" --help | grep -q "scan" || { echo "FAIL: --help без списка команд" >&2; exit 1; }
echo "OK: --version и --help"

step "5/6 базовый прогон: scan --json в пустом проекте"
cd "$PROJECT_DIR"
"$BIN" scan --json > "$WORK/scan.json"
node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!data.sessions || typeof data.sessions.count !== "number") {
    throw new Error("scan --json без sessions.count");
  }
' "$WORK/scan.json"
echo "OK: scan --json вернул валидный JSON"

step "6/6 doctor --json в изолированном окружении"
"$BIN" doctor --json > "$WORK/doctor.json"
node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(data.checks) || data.checks.length === 0) {
    throw new Error("doctor --json без проверок");
  }
' "$WORK/doctor.json"
echo "OK: doctor --json вернул проверки"

printf '\nRELEASE SMOKE OK: tarball tokenguard-%s ставится и работает в чистом окружении\n' "$VERSION"

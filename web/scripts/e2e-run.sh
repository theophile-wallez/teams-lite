#!/usr/bin/env bash
# Orchestrate a full local E2E smoke: mock backend + `teams --web` launcher +
# headless-browser assertions. Not part of CI's default `test`; run manually.
#
#   bash web/scripts/e2e-run.sh
#
# Requires a built web app (web/dist) and a Chromium (auto-detected from the
# Playwright cache, or CHROME_PATH).
set -uo pipefail
export PATH="$HOME/.bun/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_DIR="$ROOT/web"
UI_DIR="$ROOT/ui"
MOCK_PORT="${MOCK_PORT:-8420}"
WEB_PORT="${WEB_PORT:-4399}"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

echo "[e2e] starting mock backend on :$MOCK_PORT"
( cd "$WEB_DIR" && PORT="$MOCK_PORT" bun run mock/server.ts ) >/tmp/e2e-mock.log 2>&1 &
pids+=($!)

echo "[e2e] starting \`teams --web\` launcher on :$WEB_PORT"
( cd "$UI_DIR" && bun run src/index.tsx --web --no-open --port "$WEB_PORT" ) >/tmp/e2e-web.log 2>&1 &
pids+=($!)

echo "[e2e] waiting for the web server…"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then break; fi
  sleep 0.5
done

echo "[e2e] running headless smoke"
( cd "$WEB_DIR" && WEB_URL="http://127.0.0.1:$WEB_PORT" bun run scripts/e2e-smoke.ts )
status=$?

echo "[e2e] --- mock log (tail) ---"; tail -5 /tmp/e2e-mock.log
echo "[e2e] --- web log (tail) ---"; tail -8 /tmp/e2e-web.log
exit $status

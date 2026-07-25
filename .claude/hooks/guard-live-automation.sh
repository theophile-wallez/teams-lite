#!/usr/bin/env bash
# PreToolUse guard: keep automated tooling away from the user's real Teams account.
#
# THE INCIDENT THIS PREVENTS. An agent was screenshotting a UI change. It started
# the mock backend, pointed `vite dev` at it, and drove the app with an ad-hoc
# playwright-core script that typed into the composer and pressed Enter. Later it
# restarted `vite dev` WITHOUT `VITE_TEAMS_WS_URL`; the app silently fell back to
# the real backend on 127.0.0.1:8420. The next scripted keypress posted three
# messages to two real 1:1 chats with the user's colleagues. Every layer had been
# reasoned about and none of them could say no.
#
# So this hook says no, mechanically, before the command runs. READING the real
# backend is deliberately allowed — inspecting real data is useful and harmless.
# WRITING is what gets blocked, in every shape it can take:
#   1. browser automation (playwright / puppeteer / chromium) that does not go
#      through web/scripts/preview.ts — the helper that proves it is on the mock
#      before it types;
#   2. a script that calls send/edit/react against 127.0.0.1:8420;
#   3. `vite dev` without an explicit VITE_TEAMS_WS_URL (a dev server with no
#      declared backend is exactly how the incident started);
#   4. starting the Rust backend without TEAMS_LITE_READ_ONLY=1 — an agent has no
#      reason to run a send-capable backend; the user starts that one.
#
# The backend enforces the same boundary independently: writes require a capability
# token it publishes only for the user's own frontends (see `write_token` in
# src/bin/server.rs), so even a client this hook never saw cannot post.
#
# Contract: read the tool call as JSON on stdin, exit 0 to allow, exit 2 with a
# reason on stderr to block and tell the model why.
#
# This hook is a safety net, not a formality. If it blocks you, the answer is to
# use the sanctioned path (web/scripts/preview.ts, `bun run dev:mock`), never to
# rewrite the command to slip past the pattern. See AGENTS.md § Automation safety.
set -uo pipefail

payload="$(cat)"

# The command line, extracted without assuming jq is installed.
command_line="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(data.get("tool_input", {}).get("command", ""))
' 2>/dev/null || true)"

[ -z "$command_line" ] && exit 0

block() {
  printf 'BLOCKED by .claude/hooks/guard-live-automation.sh\n\n%s\n' "$1" >&2
  exit 2
}

project_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# Commands that ARE the sanctioned automation paths (or plain browser installs).
sanctioned_automation() {
  printf '%s' "$command_line" |
    grep -qE 'scripts/preview\.ts|bun run preview|test:e2e|playwright test|playwright install'
}

# A script file the command runs counts as part of the command. The incident's
# command line was a bare `bun run /tmp/shot-sparkle.ts`: every risky thing —
# launching chromium, typing into the composer, pressing Enter — lived inside the
# file, so a pattern match on the command line alone saw nothing at all.
#
# Only AD-HOC scripts are scanned: files outside the repo (/tmp/…) or untracked
# inside it. Tracked repo files are reviewed code, and several of them legitimately
# name the backend port (ws-client.ts, preview.ts, playwright.config.ts).
ad_hoc_scripts() {
  local token path
  for token in $(printf '%s' "$command_line" | grep -oE '[A-Za-z0-9_./~-]+\.(ts|tsx|js|mjs|cjs)' | sort -u); do
    path="$token"
    case "$path" in "~"*) path="$HOME${path#\~}" ;; esac
    [ -f "$path" ] || continue
    case "$(cd "$(dirname "$path")" && pwd)" in
      "$project_dir"*)
        git -C "$project_dir" ls-files --error-unmatch "$path" >/dev/null 2>&1 && continue
        ;;
    esac
    printf '%s\n' "$path"
  done
}

scripts_driving_a_browser=""
scripts_writing_to_the_backend=""
if ! sanctioned_automation; then
  while IFS= read -r script; do
    [ -z "$script" ] && continue
    if grep -qiE 'playwright|puppeteer|chrome-linux64/chrome|chromium' "$script"; then
      scripts_driving_a_browser="$scripts_driving_a_browser $script"
    fi
    # READING the live backend is fine and often the point (inspecting real data
    # beats guessing). WRITING is not: `send`/`edit`/`react` post as the user. So
    # a script that addresses port 8420 is blocked only when it also names a write
    # method or carries a write token.
    if grep -qE '(127\.0\.0\.1|localhost):8420' "$script" &&
      grep -qE '"(send|edit|react)"|'\''(send|edit|react)'\''|write_token' "$script"; then
      scripts_writing_to_the_backend="$scripts_writing_to_the_backend $script"
    fi
  done <<<"$(ad_hoc_scripts)"
fi

# --- 1. no writes to the live backend, and no ad-hoc browser drivers ----------
if [ -n "$scripts_writing_to_the_backend" ]; then
  block "This command runs a script that calls a WRITE method on the REAL backend (port 8420):
   ${scripts_writing_to_the_backend# }

Reading the live backend is fine — inspect all the real data you need. Writing is
not: send/edit/react post to real people as the user. The backend refuses writes
without the capability token it publishes for the user's own frontends (see the
write lock in src/bin/server.rs), and this hook refuses to run the attempt at all.

Exercise write flows against the mock: cd web && bun run preview."
fi

if printf '%s' "$command_line" | grep -qiE 'playwright|puppeteer|chrome-linux64/chrome|chromium' ||
  [ -n "$scripts_driving_a_browser" ]; then
  if ! sanctioned_automation; then
    [ -n "$scripts_driving_a_browser" ] &&
      printf 'note: browser automation found inside%s\n' "$scripts_driving_a_browser" >&2
    block "Ad-hoc browser automation is not allowed: a scripted keystroke can post a real
message to a real colleague if the app is not provably on the mock backend (it has
happened — three messages to two 1:1 chats).

Use the sanctioned path instead, which starts its own mock, points the dev server at
it, and asserts the MOCK sentinel badge before it types anything:

  cd web && bun run preview -- --out /tmp/shot           # screenshots
  cd web && bun run scripts/preview.ts                   # same, explicit

Or import it as a library (withPreview / typeInComposer / openFirstConversation)
from web/scripts/preview.ts for anything more elaborate. Extend that helper if it
lacks something — do not hand-roll a driver around it."
  fi
fi

# --- 2. a dev server must name its backend -----------------------------------
if printf '%s' "$command_line" | grep -qE '(vite dev|vite build --watch|bun run dev)([^:]|$)'; then
  if ! printf '%s' "$command_line" | grep -q 'VITE_TEAMS_WS_URL'; then
    block "A dev server must state which backend it targets. Without VITE_TEAMS_WS_URL the app
has no default in dev, and \`bun run dev\` is the user's own live-account shortcut —
neither is yours to start.

  cd web && bun run dev:mock     # mock backend on 8455 + vite on 4455 (use this)

The user runs \`bun run dev\` themselves for hands-on work against their account.
(The dev build also refuses to start without the variable; this hook stops you
earlier, before a dev server exists that something could drive.)"
  fi
fi

# --- 3. the backend an agent starts must be read-only ------------------------
if printf '%s' "$command_line" | grep -qE 'cargo run.*--bin server|teams-dev-server\.sh|target/(debug|release)/server'; then
  if ! printf '%s' "$command_line" | grep -q 'TEAMS_LITE_READ_ONLY=1'; then
    block "Start the backend read-only, or let the user start it. A send-capable backend
launched by tooling is how an accidental message reaches a colleague:

  TEAMS_LITE_READ_ONLY=1 cargo run --bin server

That refuses send/edit/react at the dispatch choke point (src/bin/server.rs) AND
listens on 8430 instead of 8420, so it never takes the port the user's own backend
wants — they can keep \`teams-back\`/\`teams-web\` running while you inspect real data
on ws://127.0.0.1:8430. If you genuinely need a send-capable backend, ask the user
to start it themselves."
  fi
fi

exit 0

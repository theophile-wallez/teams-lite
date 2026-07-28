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
#   2. a script that calls send/edit/react against the live backend — on its own
#      port (8420) or through the app server that relays to it (4321, and whatever
#      tailnet name it is served under: see the relay in web/server.ts);
#   2b. fetching the backend's write token, from the file it publishes or from the
#      endpoint the app's own server exposes it on. It is a capability: holding it
#      is what makes a write possible at all;
#   3. `vite dev` without an explicit VITE_TEAMS_WS_URL (a dev server with no
#      declared backend is exactly how the incident started);
#   4. starting the Rust backend without TEAMS_LITE_READ_ONLY=1 — an agent has no
#      reason to run a send-capable backend; the user starts that one;
#   5. anything that would send MAIL. The mailbox is read-only here and has no
#      sandbox equivalent (see AGENTS.md § Mail is READ-ONLY): the broker token
#      already carries `Mail.Send`, so the only thing standing between this
#      environment and a mail leaving the user's personal address is that nothing
#      names the endpoint. This hook refuses to be the first thing that does.
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

# Is this command STOPPING something rather than starting it? `kill`, `pkill` and
# `pgrep` name the same binaries and ports the rules below match, but cannot send,
# serve or type anything — and a guard that blocks cleanup only teaches the next
# agent to phrase its commands around the guard, which is the habit that caused the
# incident. Used by rules 2 and 3.
stopping_a_process() {
  printf '%s' "$command_line" | grep -qE '(^|[;&|[:space:]])(p?kill|pgrep|killall)([[:space:]]|$)'
}

# Is this command merely LOOKING at a file the rules below match by path — `ls -l
# target/debug/server`, `stat …`? That runs nothing either. Restricted to a command
# that is nothing else: `ls x && ./x` does start it, so any separator disqualifies.
inspecting_a_file() {
  printf '%s' "$command_line" | grep -qE '[;&|]' && return 1
  printf '%s' "$command_line" |
    grep -qE '^[[:space:]]*(ls|stat|file|readlink|du|wc|sha256sum|md5sum)([[:space:]]|$)'
}

# Commands that ARE the sanctioned automation paths (or plain browser installs).
sanctioned_automation() {
  printf '%s' "$command_line" |
    grep -qE 'scripts/preview\.ts|bun run preview|test:e2e|playwright test|playwright install'
}

# A script file the command RUNS counts as part of the command. The incident's
# command line was a bare `bun run /tmp/shot-sparkle.ts`: every risky thing —
# launching chromium, typing into the composer, pressing Enter — lived inside the
# file, so a pattern match on the command line alone saw nothing at all.
#
# Two filters, both about precision rather than leniency:
#   * only files an interpreter is about to execute in that command segment. A
#     command that merely NAMES a file (`git add x.ts`, `wc -l x.ts`, `grep … x.ts`)
#     runs nothing, so scanning its contents can only produce false blocks — and a
#     guard that fires on `git add` is one whose next reader learns to phrase
#     commands around it, which is the habit that caused the incident.
#   * only AD-HOC scripts: files outside the repo (/tmp/…) or untracked inside it.
#     Tracked repo files are reviewed code, and several legitimately name the
#     backend port (ws-client.ts, preview.ts, playwright.config.ts) or drive a
#     browser through the sanctioned helper (scripts/scroll-probe.ts).
ad_hoc_scripts() {
  local token path dir abs
  for token in $(printf '%s' "$command_line" | python3 -c '
import re, shlex, sys

INTERPRETER = re.compile(r"^(bun|bunx|node|nodejs|npx|pnpm|yarn|deno|tsx|ts-node|vite-node|python3?)$")
SCRIPT = re.compile(r"^[A-Za-z0-9_./~-]+\.(ts|tsx|js|mjs|cjs)$")

line = sys.stdin.read()
try:
    words = shlex.split(line, comments=False)
except ValueError:
    words = line.split()

found, running = [], False
for word in words:
    # A new command starts at every separator: `git add x.ts && bun run y.ts`
    # must not treat x.ts as something bun is about to run.
    if word in (";", "&&", "||", "|", "&"):
        running = False
        continue
    base = word.rsplit("/", 1)[-1]
    if INTERPRETER.match(base):
        running = True
    elif SCRIPT.match(word) and (running or word.startswith("./")):
        found.append(word)
for path in dict.fromkeys(found):
    print(path)
' 2>/dev/null); do
    path="$token"
    case "$path" in "~"*) path="$HOME${path#\~}" ;; esac
    [ -f "$path" ] || continue
    # Resolve to an absolute path before asking git about it: the command may be
    # run from a subdirectory (`cd web && bun run scripts/x.ts`), and a relative
    # path would be looked up against the repo root instead — making every tracked
    # script under a subdirectory look untracked, hence ad-hoc.
    dir="$(cd "$(dirname "$path")" && pwd)"
    abs="$dir/$(basename "$path")"
    case "$dir" in
      "$project_dir"*)
        git -C "$dir" ls-files --error-unmatch "$abs" >/dev/null 2>&1 && continue
        ;;
    esac
    printf '%s\n' "$abs"
  done
}

# The browser-automation match below runs on the command line itself, so a tracked
# file whose NAME contains one of the patterns (`web/playwright.config.ts`) reads as
# a driver — `sed -n 1,20p web/playwright.config.ts` runs nothing at all. Drop
# tracked repo paths from the copy used for that match. An inline driver
# (`node -e "…require('playwright')…"`) is untouched: that text is not a path to
# reviewed code.
command_line_sans_tracked_paths() {
  local scrubbed="$command_line" token path dir
  for token in $(printf '%s' "$command_line" | grep -oE '[A-Za-z0-9_./~-]+\.[A-Za-z0-9]+'); do
    path="$token"
    case "$path" in "~"*) path="$HOME${path#\~}" ;; esac
    [ -f "$path" ] || continue
    dir="$(cd "$(dirname "$path")" && pwd)"
    case "$dir" in "$project_dir"*) ;; *) continue ;; esac
    git -C "$dir" ls-files --error-unmatch "$dir/$(basename "$path")" >/dev/null 2>&1 || continue
    scrubbed="${scrubbed//$token/}"
  done
  printf '%s' "$scrubbed"
}

scripts_driving_a_browser=""
scripts_writing_to_the_backend=""
scripts_sending_mail=""
scripts_fetching_the_write_token=""
if ! sanctioned_automation; then
  while IFS= read -r script; do
    [ -z "$script" ] && continue
    if grep -qiE 'playwright|puppeteer|chrome-linux64/chrome|chromium' "$script"; then
      scripts_driving_a_browser="$scripts_driving_a_browser $script"
    fi
    # Mail: reading the mailbox is the whole point of the feature, so only the
    # WRITE endpoints are matched — Graph exposes sending as `sendMail` (and `/send`
    # on a draft), and moving/deleting as `move`/`DELETE` on a message.
    if grep -qiE 'sendMail|/messages/[^"'\'' ]*/send|graph\.microsoft\.com[^"'\'' ]*/(move|copy)' "$script"; then
      scripts_sending_mail="$scripts_sending_mail $script"
    fi
    # READING the live backend is fine and often the point (inspecting real data
    # beats guessing). WRITING is not: `send`/`edit`/`react` post as the user. So
    # a script that addresses the backend is blocked only when it also names a write
    # method or carries a write token.
    #
    # "Addresses the backend" includes the app's own server: it relays every
    # WebSocket upgrade to the same backend (see web/server.ts), so its port — and
    # any host it is reachable on, such as a tailnet name — is a second address for
    # the user's live account, not merely a static-file server.
    if grep -qE '(127\.0\.0\.1|localhost):(8420|4321)|[A-Za-z0-9-]+\.ts\.net' "$script" &&
      grep -qE '"(send|edit|react)"|'\''(send|edit|react)'\''|write_token' "$script"; then
      scripts_writing_to_the_backend="$scripts_writing_to_the_backend $script"
    fi
    # A script has no business naming the write token at all: an ad-hoc one that
    # does is fetching a capability it was not handed (see below).
    if grep -qE '__write-token|teams-lite/write-token' "$script"; then
      scripts_fetching_the_write_token="$scripts_fetching_the_write_token $script"
    fi
  done <<<"$(ad_hoc_scripts)"
fi

# --- 1. no writes to the live backend, and no ad-hoc browser drivers ----------
if [ -n "$scripts_writing_to_the_backend" ]; then
  block "This command runs a script that calls a WRITE method on the REAL backend — its own
port (8420) or the app server that relays to it (4321 / a tailnet name):
   ${scripts_writing_to_the_backend# }

Reading the live backend is fine — inspect all the real data you need. Writing is
not: send/edit/react post to real people as the user. The backend refuses writes
without the capability token it publishes for the user's own frontends (see the
write lock in src/bin/server.rs), and this hook refuses to run the attempt at all.

Exercise write flows against the mock: cd web && bun run preview."
fi

# --- 1a. the write token is never ours to fetch -------------------------------
# The token IS the write capability: the backend refuses send/edit/react without it
# and accepts them with it, whoever presents it. So a client that never has one is
# structurally read-only, and that is the property worth keeping — which means not
# going looking for it, in either of the two places it exists: the 0600 file the
# backend publishes, and the endpoint the app's own server hands it to its page on.
#
# Matched only behind a command that RETRIEVES it, so reading the code that
# implements the endpoint (`grep __write-token web/src`) stays allowed — the guard
# has to say yes to ordinary work or its next reader learns to phrase around it.
if printf '%s' "$command_line" |
  grep -qE '(curl|wget|xh|nc|cat|head|tail|less|od|xxd|base64|cp|install|tee)[^;&|]*(__write-token|teams-lite/write-token)' ||
  [ -n "$scripts_fetching_the_write_token" ]; then
  [ -n "$scripts_fetching_the_write_token" ] &&
    printf 'note: the write token is named inside%s\n' "$scripts_fetching_the_write_token" >&2
  block "This command would fetch the backend's WRITE TOKEN — a capability, not a config value.

Whoever holds it can post to real people as the user: it is the one thing standing
between a client that found the backend socket and a message in a colleague's chat.
Reading is open to any local client precisely BECAUSE writing needs this token, so
taking it collapses the split the whole design rests on (see the write lock in
src/bin/server.rs, and web/write-token.ts for the endpoint that serves the page).

It is published for the user's own frontends — the browser page and the TUI — and
was not handed to you. Nothing you legitimately need requires it:

  read real data     TEAMS_LITE_READ_ONLY=1 cargo run --bin server   (ws on 8430)
  exercise a write   cd web && bun run preview                       (mock backend)

If a real send is genuinely wanted, ask the user: consent is per-message."
fi

# --- 1b. no mail may ever be sent, moved or deleted ---------------------------
# Checked on the command line AND inside ad-hoc scripts, and deliberately WITHOUT a
# sanctioned-path exemption: unlike Teams, mail has no sandbox mailbox, so there is
# no context in which this is allowed.
if printf '%s' "$command_line" | grep -qiE 'sendMail|graph\.microsoft\.com[^ ]*/(sendMail|send|move)' ||
  [ -n "$scripts_sending_mail" ]; then
  [ -n "$scripts_sending_mail" ] &&
    printf 'note: a mail write was found inside%s\n' "$scripts_sending_mail" >&2
  block "This command would WRITE to the user's mailbox (send, move, or delete a mail).

Mail is read-only in this project, with NO exception — there is no sandbox mailbox
the way there is a sandbox Teams channel. A mail leaves the user's personal address,
reaches people who never agreed to be part of a test, and cannot be recalled.

The broker token this app holds already carries Mail.Send, so nothing at the API
level stops you: the guarantee is that no code names the endpoint (src/mail.rs
issues GET only, and two tests in it enforce that on the source). Keep it that way.

Reading is fine and is what the feature is for: list folders, read messages, render
bodies. If mail SENDING is genuinely wanted, it is a deliberate feature with its own
consent gate — ask the user, do not improvise it here."
fi

if command_line_sans_tracked_paths | grep -qiE 'playwright|puppeteer|chrome-linux64/chrome|chromium' ||
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
# Same exemption as rule 3 below, for the same reason: STARTING one is the risk.
# `pkill -f 'vite dev'` or a `pgrep` that names it is cleanup — it cannot serve
# anything to anyone — and a guard that blocks cleanup only teaches its next reader
# to phrase commands around it, which is the habit that caused the incident.
if ! stopping_a_process &&
  printf '%s' "$command_line" | grep -qE '(vite dev|vite build --watch|bun run dev)([^:]|$)'; then
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
# The compiled binary is matched only where a shell would RUN it — at the start of a
# command, after a separator, or behind `nohup`/`exec`/`env`. Text that merely names
# the path (a commit message about it, a doc line, a `--bin server` in prose) starts
# nothing, and a guard that fires on prose is one whose next reader learns to write
# around it. `cargo run --bin server` and the dev launcher stay matched anywhere:
# those spellings do not appear by accident.
runs_the_backend_binary='(^|[;&|])[[:space:]]*((nohup|exec|env|sudo)[[:space:]]+)*[A-Za-z0-9_./-]*target/(debug|release)/server([[:space:]]|$)'
if ! stopping_a_process && ! inspecting_a_file &&
  printf '%s' "$command_line" |
  grep -qE "cargo run.*--bin server|teams-dev-server\.sh|$runs_the_backend_binary"; then
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

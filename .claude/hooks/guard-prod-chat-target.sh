#!/usr/bin/env bash
# PreToolUse guard: a browser driven by an MCP tool may LOOK at the user's live app.
# It may never type in it.
#
# WHY THIS EXISTS. `guard-live-automation.sh` closes the Bash surface: an ad-hoc
# playwright script, a dev server with no declared backend, a send-capable backend
# started by tooling. The browser MCP tools are the same capability behind a
# different door — `browser_navigate` to the always-on web UI, `browser_type`,
# `browser_press_key: Enter`, and a message is in a real colleague's chat, exactly as
# in the incident that guard was written for (AGENTS.md § Automation safety).
#
# The split is the same as everywhere else in this project: READING the live account
# is allowed and useful, WRITING is not. So this hook allows navigation and the calls
# that only observe a page — snapshot, screenshot, console, network log, wait, hover —
# and blocks everything else once the browser's target is a live front. The read list
# is spelled out one tool at a time, so a tool added to either server tomorrow arrives
# blocked rather than pre-approved.
#
# It cannot see which conversation is open (no tool input carries that), and that is
# precisely the point: nothing here can prove where a keystroke would land. The one
# thing that can is `web/scripts/sandbox-live.ts`, which reads the open conversation
# id out of the app's own state before every keypress and refuses anything but the
# designated sandbox chat. That is why this hook can afford to be absolute.
#
# WHAT COUNTS AS LIVE. The backend's own ports (19420 service / 19421 dev / 19422 the
# released build the app unit runs), the app
# servers that relay to them (19440 / 19441 / 19442), and any `*.ts.net` host — the tailnet
# front of the always-on web unit is the same app, reachable under a name instead of
# a port. The mock's ports (19445/19446/19447/1945x) are deliberately absent.
#
# The target is remembered per session, because a keystroke tool's input says nothing
# about where the browser is: every `*_navigate` / `preview_open` writes what it aimed
# at, and the input tools read it back. NO recorded navigation blocks too — a browser
# whose page nobody declared is the "unproven means live" case, and one navigate call
# is all it takes to declare it.
#
# Contract: read the tool call as JSON on stdin, exit 0 to allow, exit 2 with a
# reason on stderr to block and tell the model why.
set -uo pipefail

payload="$(cat)"

# tool name, session id, and the whole tool_input as compact JSON (so a live address
# is matched wherever it sits — no tool's field names are assumed here).
read -r tool_name session_id <<<"$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(data.get("tool_name", "-"), data.get("session_id", "-") or "-")
' 2>/dev/null || true)"

tool_input="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(json.dumps(data.get("tool_input", {}), separators=(",", ":")))
' 2>/dev/null || true)"

[ -z "${tool_name:-}" ] && exit 0
case "$tool_name" in
  mcp__playwright__browser_* | mcp__t3-code__preview_*) ;;
  *) exit 0 ;;
esac

block() {
  printf 'BLOCKED by .claude/hooks/guard-prod-chat-target.sh\n\n%s\n' "$1" >&2
  exit 2
}

# An address that reaches the user's real account: the two send-capable backends, the
# two app servers that relay to them, and the tailnet name in front of the service.
live_address='(127\.0\.0\.1|localhost):(1942[0-2]|1944[0-2])|[A-Za-z0-9-]+\.ts\.net'
# A live port on its own, with no host: `preview_navigate` also takes
# `{target:{kind:"environment-port",port:19440}}`, which names the same app server
# without ever spelling a hostname.
live_port='(^|[^0-9])(1942[0-2]|1944[0-2])([^0-9]|$)'

state_dir="${XDG_RUNTIME_DIR:-/tmp}/teams-lite"
state_file="$state_dir/mcp-browser-target-${session_id//[^A-Za-z0-9_-]/_}"

target_kind=""
ever_live="0"
if [ -f "$state_file" ]; then
  target_kind="$(sed -n 's/^kind=//p' "$state_file" | tail -n 1)"
  ever_live="$(sed -n 's/^ever_live=//p' "$state_file" | tail -n 1)"
  [ -z "$ever_live" ] && ever_live="0"
fi

remember() {
  mkdir -p "$state_dir" 2>/dev/null || return 0
  printf 'kind=%s\never_live=%s\n' "$1" "$2" >"$state_file" 2>/dev/null || true
}

case "$tool_name" in
  # --- the calls that MOVE the browser: record where they aim ------------------
  *_navigate | *__preview_open)
    if printf '%s' "$tool_input" | grep -qE "$live_address|$live_port"; then
      remember live 1
    else
      remember other "$ever_live"
    fi
    exit 0
    ;;
  # --- the calls that move it somewhere this hook cannot see -------------------
  # `navigate_back` and a tab switch both land on a page whose address is not in the
  # tool input. Treating them as live once anything live has been opened in the
  # session is the conservative reading, and re-declaring with a navigate clears it.
  *_navigate_back | *__browser_tabs)
    [ "$ever_live" = "1" ] && remember live 1
    exit 0
    ;;
esac

# --- the calls that only OBSERVE the page ------------------------------------
# Listed one by one, and everything else is treated as able to activate a control —
# fail closed, so a tool added to either server tomorrow arrives blocked instead of
# pre-approved. Two near-twins to keep apart: `browser_network_requests` lists what
# the page already did (a read), while `browser_network_request` ISSUES one, which at
# a live front is a request to the user's own backend.
case "$tool_name" in
  *__browser_snapshot | *__browser_take_screenshot | *__browser_console_messages | \
    *__browser_network_requests | *__browser_wait_for | *__browser_resize | \
    *__browser_hover | *__browser_find | *__browser_close | \
    *__preview_snapshot | *__preview_status | *__preview_wait_for | *__preview_scroll | \
    *__preview_resize | *__preview_set_appearance | *__preview_recording_start | \
    *__preview_recording_stop)
    exit 0
    ;;
esac

sandbox_advice="To exercise a chat feature against the real account, there is exactly one place and
one tool:

  cd web && bun run sandbox -- --type \"hello\" --send

\`web/scripts/sandbox-live.ts\` opens the designated sandbox chat, reads the open
conversation id out of the app's own state before every keystroke, and refuses to
type anywhere else (AGENTS.md § Sending messages). For everything the mock can show,
use it instead — nothing it types leaves the machine:

  cd web && bun run preview -- --out /tmp/shot"

if [ "$target_kind" = "live" ]; then
  block "This browser is pointed at the user's LIVE Teams app, and \`$tool_name\` can activate a
control in the page — a click on Send, a keypress in the composer, a script that calls
the backend. Nothing in this tool call says which conversation is open, so nothing here
can tell a test message from a message to a colleague.

Looking is allowed and encouraged: navigate, snapshot, screenshot, read the console and
the network. Typing is not.

$sandbox_advice"
fi

if [ -z "$target_kind" ]; then
  block "\`$tool_name\` can activate a control in the page, and no navigation has been seen in
this session — so this hook cannot tell whether the browser is on a mock or on the
user's real Teams app. Unproven means live (AGENTS.md § Automation safety).

Declare the page first, with the navigate tool of the same server, and this call goes
through as soon as the target is not a live front.

$sandbox_advice"
fi

exit 0

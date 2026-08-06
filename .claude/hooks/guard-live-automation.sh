#!/usr/bin/env bash
# PreToolUse guard: keep automated tooling away from the user's real Teams account.
#
# THE INCIDENT THIS PREVENTS. An agent was screenshotting a UI change. It started
# the mock backend, pointed `vite dev` at it, and drove the app with an ad-hoc
# playwright-core script that typed into the composer and pressed Enter. Later it
# restarted `vite dev` WITHOUT `VITE_TEAMS_WS_URL`; the app silently fell back to
# the real backend on 127.0.0.1:19420. The next scripted keypress posted three
# messages to two real 1:1 chats with the user's colleagues. Every layer had been
# reasoned about and none of them could say no.
#
# So this hook says no, mechanically, before the command runs. READING the real
# backend is deliberately allowed — inspecting real data is useful and harmless.
# WRITING is what gets blocked, in every shape it can take:
#   1. browser automation (playwright / puppeteer / chromium) that does not go
#      through web/scripts/preview.ts — the helper that proves it is on the mock
#      before it types. Its live twin, web/scripts/sandbox-live.ts, is the one path
#      to a real keystroke: it types only in the designated sandbox chat, and proves
#      that from the app's own state before every key;
#   2. a script that calls send/edit/delete/react against the live backend — on its own
#      port (19420 for the always-on service, 19421 for the dev one, 19422 for the
#      released build the app unit runs) or through an
#      app server that relays to it (19440 / 19441 / 19442, and whatever tailnet name it is
#      served under: see the relay in web/server.ts);
#   2b. fetching the backend's write token, from the file it publishes or from the
#      endpoint the app's own server exposes it on. It is a capability: holding it
#      is what makes a write possible at all;
#   3. `vite dev` without an explicit VITE_TEAMS_WS_URL, and the production web
#      server without an explicit TEAMS_LITE_WS_URL (a server with no declared
#      backend is exactly how the incident started);
#   4. starting the Rust backend without TEAMS_LITE_READ_ONLY=1 — an agent has no
#      reason to run a send-capable backend; the user starts that one. This covers
#      every spelling: the binary in target/, the staged copy the always-on service
#      runs, the launcher scripts, and `systemctl --user start` on its units;
#   2c. a cargo EXAMPLE that posts to Teams without pinning the sandbox channel. An
#      example holds a broker token and talks to Teams directly, so no port and no
#      write token stands between it and a colleague's chat;
#   2d. a WRITE of the user's read position straight to Teams
#      (`PUT …/properties?name=consumptionhorizon`), which marks a thread read on
#      every device they own and shows the sender a read receipt. The gated
#      `mark_read` RPC is the only way that may happen;
#   2e. a PUBLISH of the user's own presence straight to Teams
#      (`PUT {presence}/v1/me/endpoints/`, or the manual status at
#      `/v1/me/forceavailability/`), which turns the green dot on for every colleague
#      who can see them. The gated `set_always_available` RPC — the switch in
#      Settings — is the only way that may happen;
#   2f. a WRITE of one of the user's own CHAT SETTINGS straight to Teams
#      (`PUT …/properties?name=alerts|ispinned|historyHiddenTime`), which pins, mutes
#      or hides that chat in every Teams client they own. The gated
#      `set_chat_pinned` / `set_chat_muted` / `set_chat_hidden` RPCs — the "…" menu on
#      a chat row — are the only way that may happen;
#   2g. a WRITE to one of the TRACKERS straight to GitLab or Linear
#      (`…/merge_requests/<iid>/approve` | `/unapprove` | `/merge` | `/notes`, a
#      `state_event`, or a GraphQL mutation). Both are read-only here save what the USER
#      clicks in the app — the approval, and the merge-request page's merge, comment,
#      comment deletion and close, each through its own gated `gitlab_*` RPC — and there
#      is no sandbox project to aim a test at. The MERGE is the sharpest of them: it
#      lands somebody's branch in a shared repository and no later call takes it back;
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
# This hook only sees `Bash`. Its sibling, guard-prod-chat-target.sh, covers the other
# door: a browser driven by an MCP tool, which needs no command line at all.
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

# The same idea, tightened, for rule 1 — which guards browser automation, where a
# chained second command would be the whole risk. `pgrep -af playwright` and
# `pkill -f chromium` name a browser driver and can drive nothing at all; blocking
# them only teaches the next reader to phrase commands around the guard.
#
# So: the command must BEGIN with a process probe, and must not chain or substitute
# another one. A bare `|` is tolerated because it is normally inside the pattern
# argument (`pgrep -af 'vite dev|mock/server.ts'`); `;`, `&`, a backtick and `$(` are
# not, because each can introduce a command this predicate never looked at.
probing_processes() {
  printf '%s' "$command_line" |
    grep -qE '^[[:space:]]*(p?kill|pgrep|killall)([[:space:]]|$)' || return 1
  printf '%s' "$command_line" | grep -qE '[;&`]|\$\(' && return 1
  return 0
}

# Is this command only RECORDING TEXT that happens to name a browser — a commit
# message, an annotated tag? Rules 3 and 3a anchor their patterns to a command
# position for exactly this reason ("prose that names the binary runs nothing"),
# but rule 1 matches anywhere, so `git commit -m "…Chromium fell to 8 fps…"` read
# as a driver. A guard that fires on a commit message teaches its next reader to
# write around it, which is the habit that caused the incident.
#
# Narrow on purpose, like `probing_processes`: the command must BEGIN with `git
# commit` or `git tag` — so `git -c core.editor=… commit` is not exempt, since what
# follows `git` there is a command git will run — and it must neither chain nor
# substitute anything, because either could introduce a real driver. The
# script-contents half of rule 1 stays unexempted regardless.
recording_a_message() {
  printf '%s' "$command_line" |
    grep -qE '^[[:space:]]*git[[:space:]]+(commit|tag)([[:space:]]|$)' || return 1
  printf '%s' "$command_line" | grep -qE '[;&|`]|\$\(' && return 1
  return 0
}

# Is this command merely LOOKING at a file the rules below match by path — `ls -l
# target/debug/server`, `stat …`, `bash -n bin/teams-dev-server.sh`? That runs
# nothing either: `-n` is bash's syntax-check mode, which parses and exits.
# Restricted to a command that is nothing else: `ls x && ./x` does start it, and
# `bash -n x && bash x` does too, so any separator disqualifies.
inspecting_a_file() {
  printf '%s' "$command_line" | grep -qE '[;&|]' && return 1
  printf '%s' "$command_line" |
    grep -qE '^[[:space:]]*((ls|stat|file|readlink|du|wc|sha256sum|md5sum|shellcheck)([[:space:]]|$)|(ba|z)?sh[[:space:]]+-n([[:space:]]|$))'
}

# Is this command SEARCHING TEXT that happens to name something the rules below
# match — `grep -rn "teams --web" README.md`, `rg teams-launcher`? A search runs
# nothing, so the same reasoning as `inspecting_a_file` applies. It needs its own
# predicate because a regex ALTERNATION puts a bare `|` on the command line, and every
# rule here reads `|` as a command separator: `grep "a\|teams x"` was read as
# `… | teams x` and blocked a search of this very repo.
#
# Narrow like `probing_processes`: the command must BEGIN with a search tool, and must
# neither chain (`;`, `&`) nor substitute (a backtick, `$(`) anything — either could
# introduce a command this predicate never looked at. A pipe is tolerated for the
# reason above, and a pipeline whose sink is a launcher is not a shape anyone writes.
searching_text() {
  printf '%s' "$command_line" |
    grep -qE '^[[:space:]]*(git[[:space:]]+)?(grep|egrep|fgrep|rg|ag|ack)([[:space:]]|$)' || return 1
  printf '%s' "$command_line" | grep -qE '[;&`]|\$\(' && return 1
  return 0
}

# Is this command asking a launcher to PRINT ITS USAGE? `teams --help` parses argv,
# writes the flags and exits (see launcher/src/index.ts), so it starts no backend and serves
# no app — and reading a command's own help is how anyone checks what it takes.
#
# Narrow like `probing_processes`: the flag must be there as a word, and the command
# must neither chain (`;`, `&`, `|`) nor substitute (a backtick, `$(`) anything, so
# `teams --help && teams` is not exempt. It stays true only while `--help` really does
# exit early; a launcher that grew a `--help` which also served something would make
# this exemption wrong, which is why the flag is checked, not merely tolerated.
printing_usage() {
  printf '%s' "$command_line" | grep -qE '[;&|`]|\$\(' && return 1
  printf '%s' "$command_line" | grep -qE '(^|[[:space:]])(--help|-h)([[:space:]]|$)'
}

# A COMMAND POSITION: the start of the line, or just after a separator, plus the
# prefixes a shell allows in front of a program — `nohup`, `exec`, `env`, `sudo`, and
# any number of `FOO=bar` assignments. Rules anchor their patterns to it so that PROSE
# naming the same words runs nothing: a commit message ("chore: systemctl --user start
# teams-lite at boot") must stay allowed, for the same reason `ls target/debug/server`
# does. The assignments belong in it because the very variable rule 3 asks for is
# written that way, and a rule a leading `FOO=1` can defeat is a rule with a spelling
# that walks straight through it.
at_command_start='(^|[;&|])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*|nohup|exec|env|sudo)[[:space:]]+)*'

# Commands that ARE the sanctioned automation paths (or plain browser installs).
# The drivers that are allowed to touch a browser, named one at a time.
#
# The two LIVE ones are here deliberately rather than by accident. `bun run sandbox` used
# to pass only because the alias spells no path and no browser word, so nothing matched it
# — an allowance nobody declared is an allowance nobody can review, and the next alias
# would have inherited it silently. Both are listed under both spellings (the alias and
# the script), so the exemption is the file rather than the phrasing.
#
# What earns a live driver its place is not that it is tracked: it is that its target is a
# CONSTANT in it and re-read from the app's own state immediately before the outward
# action. `sandbox-live.ts` does that with the sandbox chat's conversation id;
# `join-live.ts` does it with the authorized meeting's `data-join-url`. A new one must do
# the same before it is added here.
sanctioned_automation() {
  printf '%s' "$command_line" |
    grep -qE 'scripts/preview\.ts|bun run preview|test:e2e|playwright test|playwright install|scripts/sandbox-live\.ts|bun run sandbox|scripts/join-live\.ts|bun run join-live'
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

# The sandbox channel from AGENTS.md § Sending messages: the ONE conversation a send
# may target without asking first. Spelled here so this hook can tell a probe apart
# from a post to a colleague.
SANDBOX_THREAD='19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2'

# The Rust sources a `cargo run --example NAME` is about to execute.
#
# Rule 1 scans INTERPRETED scripts, which left a hole this feature opened: a cargo
# example talks to Teams directly, with a broker token, past every port and RPC the
# other rules match. `examples/agent_stream_probe.rs` is the legitimate shape of one
# (it posts to the sandbox channel and nowhere else); the rule below is what keeps
# the next one honest.
#
# `--bin` is deliberately NOT matched: the only binary here is the backend, rule 3
# already governs it, and it names `send_message` by definition.
example_sources_the_command_runs() {
  printf '%s' "$command_line" | python3 -c '
import shlex, sys

line = sys.stdin.read()
try:
    words = shlex.split(line, comments=False)
except ValueError:
    words = line.split()
found = []
for index, word in enumerate(words):
    if word == "--example" and index + 1 < len(words):
        found.append("examples/%s.rs" % words[index + 1])
print("\n".join(dict.fromkeys(found)))
' 2>/dev/null || true
}

# The presence PUBLISH, in a file of any kind: the endpoint registration that turns the
# user's status green, and the manual status next to it. Matched on the endpoints the
# service exposes and on this crate's own functions — never on `fetch_presence`, which
# READS other people's presence and is what the person card is built on.
publishes_presence() {
  grep -qiE 'me/endpoints|me/forceavailability|register_available_endpoint|remove_endpoint|presence\.teams\.microsoft\.com/\.default' "$1"
}

# Does this file WRITE one of the user's own chat settings to Teams? The three
# conversation properties the pin, the mute and the hide live in — measured against the
# tenant by examples/chat_settings_recon.rs — plus the crate's own functions that write
# them. Reading those properties is ordinary recon (the same GET the sidebar is built
# on) and is deliberately not matched: only `name=<key>`, the shape of the PUT, is.
writes_chat_settings() {
  grep -qiE 'name=(alerts|ispinned|historyHiddenTime)|set_chat_(pinned|muted|hidden)' "$1"
}

# Does this file WRITE to one of the trackers? Everything this app knows about GitLab
# and Linear READS, save what the USER clicks in the app: a merge request's approval
# (src/gitlab_approval.rs, the gated `gitlab_set_approval` RPC) and the merge-request
# PAGE's four writes — the merge, a comment, that comment's deletion and the close
# (src/gitlab_mr_write.rs, the gated `gitlab_mr_*` RPCs; see AGENTS.md § The GitLab page).
#
# A GitLab token carries whatever scopes the user granted it and a Linear key has full
# write access, so every one of those endpoints is matched wherever a file names them —
# the MERGE most of all, since it is the one action in this app that no later call takes
# back. Reading a tracker is the whole point of the page and the preview cards and is not
# matched: only the write endpoints, `state_event`, a GraphQL mutation and this crate's
# own write functions are.
writes_to_a_tracker() {
  grep -qiE 'merge_requests/[^ "'\'']*/((un)?approve|merge|notes)|/(un)?approve"|gitlab_approval::set|gitlab_set_approval|gitlab_mr_write::|gitlab_mr_(merge|comment|delete_comment|set_state)|state_event|"mutation |mutation *\{' "$1"
}

# Cargo examples that would post to Teams somewhere other than the sandbox channel,
# and (separately) those that would publish the user's own presence.
examples_that_send=""
examples_publishing_presence=""
examples_writing_to_a_tracker=""
while IFS= read -r source; do
  [ -z "$source" ] && continue
  path="$project_dir/$source"
  [ -f "$path" ] || continue
  # A presence publish is outward too, but it has NO conversation to pin — the target
  # is always the user's own status — so it cannot be made safe the way a send can,
  # and it is collected on its own.
  if publishes_presence "$path"; then
    examples_publishing_presence="$examples_publishing_presence $source"
  fi
  # A tracker write is the same shape of problem: there is no sandbox project and no
  # pre-authorized merge request, so pinning a conversation says nothing about where an
  # approval would land.
  if writes_to_a_tracker "$path"; then
    examples_writing_to_a_tracker="$examples_writing_to_a_tracker $source"
  fi
  # Does it act outward at all? Through this crate's send path, by naming the
  # chatService messages endpoint itself, by publishing our read position — a
  # horizon write tells the other party the user read their message, which reaches
  # them exactly as a post does (see `set_consumption_horizon`) — or by writing one of
  # the user's own chat settings, which lands in every Teams client they own.
  if ! grep -qE 'teams_send::(send_message|edit_message|delete_message|set_reaction)|/v1/users/ME/conversations/[^"]*/messages|set_consumption_horizon|name=consumptionhorizon([^s]|$)' \
    "$path" && ! writes_chat_settings "$path"; then
    continue
  fi
  # Then every conversation it names must be the sandbox one — and it must name one.
  # A send whose target comes from an argument is a send waiting for a typo.
  targets="$(grep -oE '19:[A-Za-z0-9]+@thread\.v2|8:orgid:[0-9a-fA-F-]+' "$path" | sort -u)"
  if [ "$targets" != "$SANDBOX_THREAD" ]; then
    examples_that_send="$examples_that_send $source"
  fi
done <<<"$(example_sources_the_command_runs)"

scripts_driving_a_browser=""
scripts_writing_to_the_backend=""
scripts_sending_mail=""
scripts_writing_the_read_state=""
scripts_writing_chat_settings=""
scripts_publishing_presence=""
scripts_writing_to_a_tracker=""
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
    # The read state, straight to Teams: WRITING our own consumption horizon marks a
    # thread read on every device the user owns and shows the sender a read receipt.
    # Only the singular `properties?name=consumptionhorizon` PUT (and the function that
    # issues it) is matched — the PLURAL `consumptionhorizons` GET is how "seen by" is
    # read, which is ordinary recon and must stay open.
    if grep -qiE 'name=consumptionhorizon([^s]|$)|set_consumption_horizon' "$script"; then
      scripts_writing_the_read_state="$scripts_writing_the_read_state $script"
    fi
    # The chat settings, straight to Teams: pinning, muting or hiding a chat lands in
    # every Teams client the user owns. Reading the same properties stays open — it is
    # the GET the sidebar is built on.
    if writes_chat_settings "$script"; then
      scripts_writing_chat_settings="$scripts_writing_chat_settings $script"
    fi
    # Our own presence, straight to Teams: registering an endpoint turns the green dot
    # on for every colleague, and the manual status beside it cannot even be undone.
    # READING presence (`getpresence`, `fetch_presence`) is untouched — it is what the
    # person card shows.
    if publishes_presence "$script"; then
      scripts_publishing_presence="$scripts_publishing_presence $script"
    fi
    # The trackers, straight to GitLab or Linear: an approval given with the user's own
    # token is an act by their account that everybody watching the merge request is told
    # about, and it bypasses the whole feature's consent gate (the write token, read-only
    # mode, the message menu's own confirmation). Reading a tracker is what the preview
    # cards are for and stays open.
    if writes_to_a_tracker "$script"; then
      scripts_writing_to_a_tracker="$scripts_writing_to_a_tracker $script"
    fi
    # READING the live backend is fine and often the point (inspecting real data
    # beats guessing). WRITING is not: `send`/`edit`/`delete`/`react` post as the user —
    # and `delete` is the one nothing takes back, since the message leaves the thread
    # for everybody in it —
    # `mark_read` publishes the user's read position (which clears the unread marker
    # on every device they own and shows the sender a read receipt), and
    # `push_subscribe`/`push_unsubscribe`/`push_test` change which devices the machine
    # sends the user's message previews to — a phone buzzed by tooling, or a stream
    # aimed at a new endpoint — and `set_settings` writes the integration credentials,
    # including the GitLab host its stored token may be sent to. So a script that
    # addresses the backend is blocked only when it also names a write method or
    # carries a write token.
    #
    # "Addresses the backend" includes the app's own server: it relays every
    # WebSocket upgrade to the same backend (see web/server.ts), so its port — and
    # any host it is reachable on, such as a tailnet name — is a second address for
    # the user's live account, not merely a static-file server.
    #
    # SIX ports, not two. 19420/19440 are the always-on service; 19421/19441 are the
    # user's hands-on dev pair (bin/teams-dev-server.sh and `bun run dev`), which is
    # just as send-capable. Only 19430 — read-only — is absent, by design.
    #
    # The `agent_set_*` methods are in that list for the same reason: they arm the local
    # agent that answers `@claude` in a Teams thread AS the user, decide what it may run
    # on this machine, and decide which program and model it starts (MACHINE_METHODS in
    # src/bin/server.rs). `agent_set_unrestricted` is the widest of them — it hands that
    # agent the user's own Claude Code configuration, every tool included — so a script
    # naming it against a live port is exactly the shape this refuses.
    #
    # `set_always_available` publishes the user's own status: it posts no message, but
    # the green dot it turns on is what every colleague reads (OUTWARD_METHODS in
    # src/bin/server.rs).
    #
    # `mail_mark_read` is the odd one out: it posts nothing and tells Graph nothing —
    # it clears an unread marker in the app's own mirror. It is still in this list
    # because nothing in this app can put such a marker BACK (there is no mark-unread,
    # and Outlook still calls the mail unread, so the local mark stands), so a script
    # walking a live inbox would quietly erase what the user had not read yet.
    #
    # `update_download` and `update_apply` are the in-app update (MACHINE_METHODS in
    # src/bin/server.rs): the first spends the user's bandwidth on a 130 MB release, and
    # the second REPLACES the `teams` binary their whole account runs through and
    # restarts it. Which build the user runs is theirs to choose, and a restart driven by
    # tooling would also cut a live `@claude` reply in half — the same failure
    # `teams-lite-service.sh update --now` is blocked for.
    #
    # The `call_*` methods are the sharpest entries in this list: a call RINGS a person.
    # `call_place` starts a device buzzing in somebody's pocket, `call_accept` opens the
    # user's own microphone to whoever is on the other end, `call_join` walks the user into
    # a meeting, where everybody present sees them arrive, `call_hangup` ends the call for
    # both of them, and `call_mute` states whether they can be heard. `call_prepare`
    # reserves the one call slot and hands out the relay credentials the backend holds
    # (OUTWARD_METHODS and MACHINE_METHODS in src/bin/server.rs). Reading `call_status` is
    # not a write and is not listed.
    #
    # `set_calling` is KEPT here although this app no longer has that method: calling is on
    # by default now and no client turns it on or off (`calling_available`). A backend
    # staged before that change is still listening on 19420 for weeks at a time, and it
    # would still answer — so a script naming it could unregister the device the user's
    # calls ring on, on the very install they are using.
    #
    # `set_person_name` and `set_person_avatar` write only to the local store too, and
    # are in the list because of WHAT they write: the name and the face this app puts on
    # a colleague's messages, everywhere from the sidebar to the push on the user's
    # phone. A script that could set them could make one person's post appear to come
    # from another (MACHINE_METHODS in src/bin/server.rs). Reading them back is not a
    # write and is not listed.
    if grep -qE '(127\.0\.0\.1|localhost):(1942[0-2]|1944[0-2])|[A-Za-z0-9-]+\.ts\.net' "$script" &&
      grep -qE '"(send|edit|delete|react|mark_read|mail_mark_read|set_always_available|set_chat_pinned|set_chat_muted|set_chat_hidden|push_subscribe|push_unsubscribe|push_test|set_settings|agent_set_mode|agent_set_tools|agent_set_provider|agent_set_unrestricted|set_person_name|set_person_avatar|update_download|update_apply|set_calling|call_prepare|call_place|call_join|call_accept|call_hangup|call_mute|gitlab_set_approval|gitlab_mr_merge|gitlab_mr_comment|gitlab_mr_delete_comment|gitlab_mr_set_state)"|'\''(send|edit|delete|react|mark_read|mail_mark_read|set_always_available|set_chat_pinned|set_chat_muted|set_chat_hidden|push_subscribe|push_unsubscribe|push_test|set_settings|agent_set_mode|agent_set_tools|agent_set_provider|agent_set_unrestricted|set_person_name|set_person_avatar|update_download|update_apply|set_calling|call_prepare|call_place|call_join|call_accept|call_hangup|call_mute|gitlab_set_approval|gitlab_mr_merge|gitlab_mr_comment|gitlab_mr_delete_comment|gitlab_mr_set_state)'\''|write_token' "$script"; then
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
port (19420 service / 19421 dev / 19422 released) or an app server that relays to it
(19440 / 19441 / 19442 /
a tailnet name):
   ${scripts_writing_to_the_backend# }

Reading the live backend is fine — inspect all the real data you need. Writing is
not: send/edit/delete/react post to real people as the user — a delete removes a
message from the thread for everybody and nothing brings it back — mark_read tells them the user
read their message, and the push_* methods decide which of the user's devices this
machine notifies, and the call_* methods ring a real person, open the user's own
microphone or register this machine as a device their calls ring on. mail_mark_read
reaches nobody but the user, and is here because
nothing in this app can raise an unread marker it clears. The backend refuses the
outward writes without the capability token it
publishes for the user's own frontends (see the write lock in src/bin/server.rs),
and this hook refuses to run the attempt at all.

Exercise write flows against the mock: cd web && bun run preview."
fi

# --- 1a. the write token is never ours to fetch -------------------------------
# The token IS the write capability: the backend refuses send/edit/delete/react without it
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

It is published for the user's own frontend — the browser page — and was not handed
to you. Nothing you legitimately need requires it:

  read real data     TEAMS_LITE_READ_ONLY=1 cargo run --bin server   (ws on 19430)
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

# --- 1c. a cargo example may only post to the sandbox channel ------------------
# See `example_sources_the_command_runs` above for why this rule exists at all.
if [ -n "$examples_that_send" ]; then
  block "This command runs a cargo example that POSTS TO TEAMS as the user, and does not pin
its target to the sandbox channel:
   ${examples_that_send# }

An example reaches Teams directly with a broker token, so no port rule and no write
token stands in its way — the only thing that can is what the file names. Hard-code
the conversation as a const:

  const SANDBOX_THREAD: &str = \"$SANDBOX_THREAD\";

and name no other, so the file cannot post anywhere the user has not pre-authorized
(AGENTS.md § Sending messages). See examples/agent_stream_probe.rs for the shape.
A send to any other conversation needs the user's consent for that exact message."
fi

# --- 1d. the read state goes to Teams through the gated RPC, or not at all -----
# `mark_read` is guarded as a backend write by rule 1, but the horizon can also be
# PUT straight to Teams with the skypetoken, which bypasses the backend entirely (the
# write token, read-only mode, Ghost mode — all of it). So the endpoint is matched
# inside ad-hoc scripts, and on the command line.
#
# On the command line, only behind an HTTP CLIENT — the same restriction rule 1a puts
# on the write token, and for the same reason: `grep -rn name=consumptionhorizon src`
# reads the code that implements this and must stay allowed, or the guard's next reader
# learns to phrase searches around it.
if printf '%s' "$command_line" |
  grep -qiE '(curl|wget|xh|httpie|http)[^;&|]*name=consumptionhorizon' ||
  [ -n "$scripts_writing_the_read_state" ]; then
  [ -n "$scripts_writing_the_read_state" ] &&
    printf 'note: a read-state write was found inside%s\n' "$scripts_writing_the_read_state" >&2
  block "This command would WRITE the user's read position straight to Teams
(PUT …/properties?name=consumptionhorizon).

That is outward-facing twice over: the unread marker clears on every device the user
is signed in on, and the sender is shown a read receipt saying the user read their
message. Neither can be undone.

Going direct also bypasses every gate the feature has: the write token, read-only
mode, and Ghost mode (which exists precisely so a read can stay local).

READING horizons is fine and is how \"seen by\" works — GET …/consumptionhorizons
(plural) is untouched by this rule. To exercise the write, use the mock:
cd web && bun run preview. Against the real account it needs the user's consent,
through the app's own gated mark_read RPC."
fi

# --- 1d2. a chat setting goes to Teams through the gated RPC, or not at all ------
# `set_chat_pinned` / `set_chat_muted` / `set_chat_hidden` are guarded as backend writes
# by rule 1, but the property can also be PUT straight to Teams with the skypetoken,
# which bypasses the backend entirely (the write token, read-only mode, the menu's own
# confirmation). So the three property names are matched inside ad-hoc scripts and cargo
# examples, and on the command line behind an HTTP client — the same restriction rule 1d
# puts on the horizon write, so `grep -rn name=alerts src` still reads the code that
# implements this.
#
# Unlike a send, a chat setting reaches no colleague — but it changes the user's own
# sidebar on every device they own, and a mute silences a thread they may be waiting on.
# Pinning the sandbox chat is what makes an example safe, exactly as for a send.
if printf '%s' "$command_line" |
  grep -qiE '(curl|wget|xh|httpie|http)[^;&|]*name=(alerts|ispinned|historyHiddenTime)' ||
  [ -n "$scripts_writing_chat_settings" ]; then
  [ -n "$scripts_writing_chat_settings" ] &&
    printf 'note: a chat-settings write was found inside%s\n' "$scripts_writing_chat_settings" >&2
  block "This command would WRITE one of the user's own chat settings straight to Teams
(PUT …/properties?name=alerts | ispinned | historyHiddenTime).

Those three carry the mute, the pin and the hide of one chat. A write lands in every
Teams client the user is signed in on: a pin re-orders their sidebar on their phone, a
mute silences a thread they may be waiting on, and a hide takes it out of their list.

Going direct also bypasses every gate the feature has: the write token, read-only mode,
and the app's own menu, which is where the user asks for the change.

READING those properties is fine and is what the sidebar is built on — a GET of
/v1/users/ME/conversations is untouched by this rule. To exercise the write, use the
mock: cd web && bun run preview. Against the real account it goes through the app's own
gated set_chat_pinned / set_chat_muted / set_chat_hidden RPCs, or through a cargo
example that pins the sandbox chat."
fi

# --- 1d3. a tracker is written through the gated RPC, or not at all -------------
# `gitlab_set_approval` is guarded as a backend write by rule 1, but GitLab can also be
# addressed straight with the user's own token, which bypasses the backend entirely (the
# write token, read-only mode, the message menu's own confirmation). So the two approval
# endpoints are matched inside ad-hoc scripts and cargo examples, and on the command line
# behind an HTTP client — the same restriction rule 1d puts on the horizon write, so
# `grep -rn approve src` still reads the code that implements this.
#
# Unlike a send, this cannot be made safe by pinning a target: there is no sandbox
# project and no pre-authorized merge request. An approval is an act by the user's GitLab
# account, everybody watching the merge request is told, and a project rule may act on it.
if printf '%s' "$command_line" |
  grep -qiE '(curl|wget|xh|httpie|http)[^;&|]*(merge_requests/[^ "'\'']*/((un)?approve|merge|notes)|state_event)' ||
  [ -n "$scripts_writing_to_a_tracker" ] || [ -n "$examples_writing_to_a_tracker" ]; then
  [ -n "$scripts_writing_to_a_tracker" ] &&
    printf 'note: a tracker write was found inside%s\n' "$scripts_writing_to_a_tracker" >&2
  [ -n "$examples_writing_to_a_tracker" ] &&
    printf 'note: a tracker write was found inside%s\n' "$examples_writing_to_a_tracker" >&2
  block "This command would WRITE to one of the user's trackers
(…/merge_requests/<iid>/approve | /unapprove | /merge | /notes, a state_event, or a
Linear GraphQL mutation).

The trackers are read-only here save what the USER clicks in the app: a merge request's
approval, and the merge-request page's merge, comment, comment deletion and close
(AGENTS.md § The trackers, § The GitLab page). Each reaches everybody watching the merge
request under the user's name — and the MERGE lands somebody's branch in a shared
repository, which no later call takes back.

Going direct also bypasses every gate those writes have: the write token, read-only
mode, and the second confirmation the page asks for. And pinning a target cannot make it
safe the way it can for a send — there is no sandbox project.

READING a tracker is fine and is what the page and the preview cards are built on — a
GET of an issue, a merge request, its pipeline or its comments is untouched by this rule.
To exercise a write, use the mock: cd web && bun run preview -- --gitlab. Against the
real account it goes through the app's own gated RPCs, from the user's own click."
fi

# --- 1e. our own presence is published by the gated RPC, or not at all ----------
# `set_always_available` is guarded as a backend write by rule 1, but the presence
# service can be addressed straight with the broker token, which bypasses the backend
# entirely (the write token, read-only mode, the switch's own off state). So the
# endpoints are matched inside ad-hoc scripts and cargo examples, and on the command
# line behind an HTTP client — the same restriction rule 1d puts on the horizon write,
# so `grep -rn me/endpoints src` still reads the code that implements this.
#
# Unlike a send, this cannot be made safe by pinning a target: the account IS the
# target. There is no sandbox status.
if printf '%s' "$command_line" |
  grep -qiE '(curl|wget|xh|httpie|http)[^;&|]*(me/endpoints|me/forceavailability)' ||
  [ -n "$scripts_publishing_presence" ] || [ -n "$examples_publishing_presence" ]; then
  [ -n "$scripts_publishing_presence" ] &&
    printf 'note: a presence publish was found inside%s\n' "$scripts_publishing_presence" >&2
  [ -n "$examples_publishing_presence" ] &&
    printf 'note: a presence publish was found inside%s\n' "$examples_publishing_presence" >&2
  block "This command would PUBLISH the user's own presence to Teams
(PUT {presence}/v1/me/endpoints/, or the manual status at /v1/me/forceavailability/).

That is outward: the green dot appears for every colleague who can see the user, on
every Teams client, and it is their account making the claim about where they are.
Pinning a target cannot make it safe the way it can for a send — the account is the
target, and there is no sandbox status.

The manual-status half is worse: the service accepts that write and refuses every
DELETE, so it cannot be undone from here at all (src/teams_presence.rs has a test that
keeps the crate from naming it).

READING presence is fine and is what the person card shows — getpresence and
fetch_presence are untouched by this rule. The one sanctioned way to turn the status
green is the user's own switch: Settings → Always available, which goes through the
gated set_always_available RPC and can be turned off again."
fi

# `probing_processes` and `recording_a_message` exempt only the COMMAND-LINE half: a
# `pgrep`/`pkill` that names a browser drives nothing, and neither does a commit
# message that mentions one. The script-contents half stays unexempted on purpose, so
# `pkill -f chrome; bun run /tmp/driver.ts` is still blocked by the driver inside it.
if { command_line_sans_tracked_paths | grep -qiE 'playwright|puppeteer|chrome-linux64/chrome|chromium' &&
  ! probing_processes && ! recording_a_message; } ||
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
lacks something — do not hand-roll a driver around it.

If the answer genuinely needs the real account, there is one place and one tool for
it — the designated sandbox chat, driven by web/scripts/sandbox-live.ts, which reads
the open conversation id out of the app's own state before every keystroke:

  cd web && bun run sandbox -- --type \"hello\" --send"
  fi
fi

# --- 2. a dev server must name its backend -----------------------------------
# Same exemption as rule 3 below, for the same reason: STARTING one is the risk.
# `pkill -f 'vite dev'` or a `pgrep` that names it is cleanup — it cannot serve
# anything to anyone — and a guard that blocks cleanup only teaches its next reader
# to phrase commands around it, which is the habit that caused the incident. A search
# that NAMES a dev server (`grep -rn "bun run dev" README.md`) starts nothing either.
if ! stopping_a_process && ! searching_text &&
  printf '%s' "$command_line" | grep -qE '(vite dev|vite build --watch|bun run dev)([^:]|$)'; then
  if ! printf '%s' "$command_line" | grep -q 'VITE_TEAMS_WS_URL'; then
    block "A dev server must state which backend it targets. Without VITE_TEAMS_WS_URL the app
has no default in dev, and \`bun run dev\` is the user's own live-account shortcut —
neither is yours to start.

  cd web && bun run dev:mock     # mock backend on 19455 + vite on 19445 (use this)

The user runs \`bun run dev\` themselves for hands-on work against their account.
(The dev build also refuses to start without the variable; this hook stops you
earlier, before a dev server exists that something could drive.)"
  fi
fi

# --- 2a. the PRODUCTION web server must name its backend too -------------------
# `web/server.ts` is not a static-file server: it relays every WebSocket upgrade to
# whatever `TEAMS_LITE_WS_URL` names, and that variable DEFAULTS to the live backend
# (web/server.ts). So `bun run start` with a bare environment builds the same
# unnamed-backend bridge rule 2 exists to forbid, one directory over. The always-on
# service states the variable in its unit file; a command line must state it too.
#
# `bun` is anchored to a command position, and that is not cosmetic: unanchored, the
# three letters matched inside another WORD — `web/scripts/stage-bundle.ts
# web/server.ts` in a plain `grep` argument read as an interpreter about to serve the
# app. A search is exempted for the same reason.
if ! stopping_a_process && ! searching_text &&
  printf '%s' "$command_line" |
  grep -qE "(bun run start|${at_command_start}bun[^;&|]*web/server\.ts)([^:]|\$)"; then
  if ! printf '%s' "$command_line" | grep -q 'TEAMS_LITE_WS_URL'; then
    block "The production web server must state which backend it relays to. TEAMS_LITE_WS_URL
defaults to the LIVE backend (see web/server.ts), so starting it bare puts a bridge
to the user's real account on a local port.

  cd web && bun run preview                       # mock backend, screenshots
  TEAMS_LITE_WS_URL=ws://127.0.0.1:19430 bun run start   # read-only backend

The user's own always-on instance is a systemd unit that names it explicitly; see
bin/teams-lite-service.sh and AGENTS.md § The always-on service."
  fi
fi

# --- 3. the backend an agent starts must be read-only ------------------------
# The binary and the launcher scripts are matched only where a shell would RUN them —
# at the start of a command, after a separator, or behind `nohup`/`exec`/`env`/a shell.
# Text that merely names one (a commit message, a doc line, `chmod +x` on it, a
# `--bin server` in prose) starts nothing, and a guard that fires on prose is one
# whose next reader learns to write around it. `cargo run --bin server` stays matched
# anywhere: that spelling does not appear by accident.
#
# THREE PATHS, not one. `target/(debug|release)/server` is the build output; the
# always-on service runs a STAGED copy outside the checkout
# (~/.local/share/teams-lite/service/server, see bin/teams-lite-service.sh), and a
# rule that knew only about target/ would wave that one straight through.
# The third is the RELEASED install's: `teams` extracts the backend it embeds to
# ~/.cache/teams-lite/server and spawns it (`extractEmbeddedBackend` in
# launcher/src/backend.ts). It needs no build, which is exactly why an agent on a
# machine with nothing compiled reaches for it — and it binds the port the user's own
# app owns.
# The leading path may be spelled with a variable or a tilde — `$HOME/.local/...`,
# `~/.local/...`, `"$PWD"/target/...` — so the prefix class accepts those characters
# too. Without `$` and `~` in it, the staged path only matched when written relative.
#
# It is `at_command_start` plus an interpreter and the path itself, so the environment
# assignments a shell accepts are described in ONE place. That matters: the path class
# holds no `=`, so before the shared prefix covered them
# `TEAMS_NO_IDLE_EXIT=1 target/release/server` matched nothing at all and walked
# straight through the rule it is the clearest example of.
at_backend_command_start="${at_command_start}((bash|sh|zsh)[[:space:]]+)*[\"']?[A-Za-z0-9_./~\${}-]*"
runs_the_backend_binary="${at_backend_command_start}(target/(debug|release)|teams-lite/service|cache/teams-lite)/server([[:space:]]|\$)"
# Every way of EXECUTING a launcher still matches, including through an interpreter
# (`bash bin/teams-dev-server.sh`) — which is why the prefix list above names the
# shells. `bash -n` is a syntax check and is exempted by `inspecting_a_file`.
runs_a_backend_launcher="${at_backend_command_start}teams-(dev-server|lite-backend)\.sh([[:space:]]|\$)"
if ! stopping_a_process && ! inspecting_a_file && ! searching_text &&
  printf '%s' "$command_line" |
  grep -qE "cargo run.*--bin server|$runs_a_backend_launcher|$runs_the_backend_binary"; then
  if ! printf '%s' "$command_line" | grep -q 'TEAMS_LITE_READ_ONLY=1'; then
    block "Start the backend read-only, or let the user start it. A send-capable backend
launched by tooling is how an accidental message reaches a colleague:

  TEAMS_LITE_READ_ONLY=1 cargo run --bin server

That refuses send/edit/delete/react at the dispatch choke point (src/bin/server.rs) AND
listens on 19430 instead of 19420, so it never takes the port the user's own backend
wants — they can keep the always-on service running while you inspect real data
on ws://127.0.0.1:19430. If you genuinely need a send-capable backend, ask the user
to start it themselves."
  fi
fi

# --- 3a. the always-on service is the user's to start -------------------------
# The service turns "start a send-capable backend" into one systemctl call, which
# rule 3 cannot see: no binary path, no `cargo run`, no TEAMS_LITE_READ_ONLY to
# offer, because a unit carries its environment in its own file. So this rule blocks
# the START verbs by name and unconditionally.
#
# Everything that only LOOKS or STOPS stays allowed, deliberately — `status`, `cat`,
# `show`, `list-units`, `is-active`, `daemon-reload`, `disable`, `stop`, and every
# `journalctl` — because installing and diagnosing the service IS agent work, and a
# guard that blocked the diagnosis would teach its next reader to phrase around it.
# `install` and `update` in bin/teams-lite-service.sh deliberately never start a
# unit, for the same reason; its `start`/`restart` subcommands are matched here.
# Both patterns are anchored to a command position — the start of the line, or
# after a separator — so that PROSE naming the same words runs nothing: a commit
# message ("chore: systemctl --user start teams-lite at boot") must stay allowed,
# for the same reason `ls target/debug/server` does.
starts_a_teams_lite_unit="${at_command_start}systemctl[^;&|]*[[:space:]](start|restart|try-restart|reload-or-restart|enable)([[:space:]][^;&|]*)?teams-lite"
runs_service_script_start="${at_command_start}[A-Za-z0-9_./-]*teams-lite-service\.sh[[:space:]]+[^;&|]*(start|restart|enable)"
if ! searching_text &&
  printf '%s' "$command_line" | grep -qE "$starts_a_teams_lite_unit|$runs_service_script_start"; then
  block "The always-on teams-lite service is the user's to start. Its backend unit is
send-capable by design — it is their real Teams client, running 24/7 — so a
\`systemctl --user start\` on it is the same act rule 3 refuses, just spelled with
systemd instead of a binary path.

Install and inspect it freely; starting it is the user's call:

  bin/teams-lite-service.sh install     # stage artifacts + write the units (starts nothing)
  bin/teams-lite-service.sh status      # unit state, ports, broker, tailscale
  journalctl --user -u teams-lite-backend -n 200 --no-pager

Then ask the user to run:

  systemctl --user enable --now teams-lite.target

To exercise the app yourself, use the mock: cd web && bun run preview."
fi

# --- 3a. an update may not cut a live agent reply in half -----------------------
# `update` restarts the units, and a restart kills a running @claude child: the reply it
# was writing stops where it stood, and the thread keeps a "claude is thinking…" body in
# front of everybody in it. So `update` waits for the agent to be quiet
# (`wait_for_quiet_agent` in bin/teams-lite-service.sh), and `--now` is the switch that
# skips the wait. That switch is the USER's — they are the one who can decide their own
# half-written reply is worth losing.
#
# Plain `update` stays allowed: it is how a staged artifact reaches the user's phone, and
# it now waits on its own.
skips_the_agent_wait="${at_command_start}[A-Za-z0-9_./~\${}-]*teams-lite-service\.sh[^;&|]*[[:space:]]--now([[:space:]]|\$)"
if ! searching_text &&
  printf '%s' "$command_line" | grep -qE "$skips_the_agent_wait"; then
  block "\`update --now\` skips the wait for a live @claude run. A restart kills the CLI child, so
the reply being written stops mid-sentence and the thread is left with a message that
says the agent is thinking — read by everybody in it.

Run the update without the flag: it waits for the agent, then restarts.

  bin/teams-lite-service.sh update

Only the user may decide a half-written reply is worth losing. If an update must go out
now, say why and let them run it."
fi

# --- 3b. the Intune container is the user's sign-in, not a toy ------------------
# `intune-container stop` takes the identity broker down, and with it every token the
# backend holds: the app goes empty for whoever is using it, on a phone included. A
# restart is also how the login keyring gets unlocked, so it is a real remedy — which is
# exactly why it belongs to the user, or to the rate-limited repair unit that the app's
# own button drives (see bin/teams-lite-broker-check.sh).
#
# Looking is free: `status`, `doctor` and `--help` answer the questions an agent
# actually has, and blocking those would only teach the next reader to phrase around
# the guard.
cycles_the_container="${at_command_start}[A-Za-z0-9_./~\${}-]*intune-container([[:space:]]+[^;&|]*)?[[:space:]](stop|start|restart|enroll|init|destroy|edge|autostart)([[:space:]]|\$)"
# The check script is read-only WITHOUT arguments and a trigger WITH `--repair`: it asks
# systemd for the repair unit, which restarts the container. So the flag is what decides.
# Anchored at a command position like every other rule here, so a commit message or a
# doc line that names the flag runs nothing and stays allowed.
asks_for_a_repair="${at_command_start}[A-Za-z0-9_./~\${}-]*teams-lite-broker-check\.sh[^;&|]*--repair"
if ! searching_text &&
  printf '%s' "$command_line" | grep -qE "$cycles_the_container|$asks_for_a_repair"; then
  block "The Intune container is the user's sign-in. Stopping or restarting it takes the identity
broker down, so teams-lite goes empty for whoever is looking at it — including a phone
on the tailnet — for about a minute.

Diagnose it freely:

  intune-container status
  intune-container doctor
  bin/teams-lite-broker-check.sh        # is the login keyring locked?

A restart IS the remedy when that keyring re-locked, but it is not yours to run: the
app has a Repair sign-in button, and teams-lite-broker-repair.service does it at most
three times an hour. Ask the user to press the button, or to run:

  intune-container stop && intune-container start"
fi

# --- 3c. the `teams` command is the whole live stack in one word ----------------
# The third of the "not yours to start" rules, and the widest: `teams` spawns the
# send-capable backend (rule 3) AND serves the real app on the production web port
# (rule 2a), then opens a browser on it. One word, both risks, and no useful
# read-only spelling of it — an agent that needs real data reads a read-only backend,
# and an agent that needs the UI drives the mock. So this one blocks unconditionally.
#
# Every spelling that RUNS it: the compiled binary wherever it was installed
# (launcher/dist/teams, ~/.teams-lite/bin/teams, a `teams` on the PATH), the repo
# wrapper that resolves the broker bus for it, and the source entrypoint. `teams-bin`
# is that binary and `teams` is only the wrapper install.sh writes beside it (:57 and
# :85), so `teams-bin` is the name `ps` and TEAMS_LITE_LAUNCHER_BIN give — the spelling
# an agent copies while diagnosing the live app, which is the one place a command line
# is read rather than composed. Anchored to a
# command position like rules 3 and 3a, so prose, `git add launcher/dist/teams` and
# `chmod +x` still run nothing. `teams-lite-service.sh` and friends do not match:
# the name must be followed by a space or the end of the segment. The entrypoint is
# matched only behind the interpreter that would RUN it — the same shape rule 2a uses
# for web/server.ts — because `git add launcher/src/index.ts` starts nothing. `bun` is
# anchored there for the same reason it is in rule 2a: unanchored, those three letters
# matched inside `stage-bundle.ts`, so a `sed` over a list of files that happened to
# name both was read as a launch.
runs_the_teams_command="${at_backend_command_start}teams(-bin)?([[:space:]]|\$)"
runs_the_teams_launcher="${at_backend_command_start}teams-launcher\.sh([[:space:]]|\$)"
runs_the_teams_entrypoint="${at_command_start}bun[^;&|]*(launcher/)?src/index\.ts"
if ! stopping_a_process && ! inspecting_a_file && ! searching_text && ! printing_usage &&
  printf '%s' "$command_line" |
  grep -qE "$runs_the_teams_command|$runs_the_teams_launcher|$runs_the_teams_entrypoint"; then
  block "\`teams\` is the user's whole live stack in one command: it starts a send-capable
backend, serves the real app on 19440 and opens a browser on it. That is rule 3 and
rule 2a at once, so it is theirs to run, not tooling's.

To look at real data, read a read-only backend:

  TEAMS_LITE_READ_ONLY=1 cargo run --bin server        # ws://127.0.0.1:19430

To exercise or screenshot the UI, drive the mock:

  cd web && bun run preview -- --out /tmp/shot

The user's always-on instance already serves the real app; see AGENTS.md
§ The always-on service."
fi

exit 0

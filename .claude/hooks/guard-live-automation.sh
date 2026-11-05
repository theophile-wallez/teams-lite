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
# WRITING is what gets blocked, in the shapes below (and what it cannot see is listed after them):
#   1. browser automation (playwright / puppeteer / chromium) that does not go
#      through web/scripts/preview.ts — the helper that proves it is on the mock
#      before it types. Its live twin, web/scripts/sandbox-live.ts, is the one path
#      to a real keystroke: it types only in the designated sandbox chat, and proves
#      that from the app's own state before every key;
#   2. a script that calls send/edit/delete/react against the live backend — on its own
#      port (19420 for the always-on service, 19421 for the dev one, 19422 for the
#      released build the app unit runs, 19423 for the container image) or through an
#      app server that relays to it (19440 / 19441 / 19442 / 19443, and whatever tailnet name
#      it is served under: see the relay in web/server.ts);
#   2b. fetching the backend's write token, from the file it publishes or from the
#      endpoint the app's own server exposes it on. It is a capability: holding it
#      is what makes a write possible at all;
#   3. `vite dev` without an explicit VITE_TEAMS_WS_URL, and the production web
#      server without an explicit TEAMS_LITE_WS_URL (a server with no declared
#      backend is exactly how the incident started);
#   3d. bringing teams-lite's CONTAINER IMAGE up (packaging/docker): `docker|podman run`,
#      `start`, a compose `up` — the whole live stack of rule 3c inside a container — and, since
#      the image now runs the user's own Intune container inside it, taking it DOWN too: a stop,
#      kill, pause or removal of the `teams-lite` container or a compose `stop|kill|down|rm|pause`
#      of its project, a signal sent to a process INSIDE it through an `exec` (3d-ii — `kill 1`
#      is `docker stop` by other means), another container JOINED to its pid namespace
#      (`--pid container:teams-lite`, `kubectl debug --target` — 3d-iii), a second launcher or
#      backend exec'd into it (3c-ii — a second send-capable backend, signed in as the user), and,
#      sharper still, deleting the volumes that hold its enrollment and its store (`down -v`,
#      `volume rm|prune`, `system prune --volumes`).
#      Building it, reading it (an `exec` that reads a file runs nothing), running it with
#      `-e TEAMS_LITE_READ_ONLY=1`, its two diagnostics — the self-test only on a throwaway
#      container with a network and an IPC namespace of its own — and a container of another
#      name stay open, each proof read as the engine reads its flags (before the image, and the
#      last word on its value);
#   3e. deploying, restarting or stopping it on KUBERNETES (packaging/helm): `helm
#      install|upgrade|rollback|uninstall` of the chart, the rendered manifests applied, a scale,
#      a rollout restart, a delete of its pod or its StatefulSet — and a `kubectl port-forward` to
#      it on any address but loopback or onto a local port the browser guard does not know as
#      live — and, irreversibly, a delete of its volume claims or of any namespace. Rendering,
#      `--dry-run`, a new release with `--set readOnly=true` and every read stay open;
#   4. starting the Rust backend without TEAMS_LITE_READ_ONLY=1 — an agent has no
#      reason to run a send-capable backend; the user starts that one. The spellings it
#      knows: the binary in target/, the staged copy the always-on service runs, the
#      released build's extraction, `cargo run --bin server`, the launcher scripts, any of
#      them handed to `systemd-run` (where only `-E TEAMS_LITE_READ_ONLY=1` reaches the
#      unit), and `systemctl --user start` on its units, or the same over raw D-Bus;
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
#      `state_event`, a thread resolution, or a GraphQL mutation). Both are read-only here
#      save what the USER
#      clicks in the app — the approval, and the merge-request page's merge, comment,
#      comment deletion and close, each through its own gated `gitlab_*` RPC — and there
#      is no sandbox project to aim a test at. The MERGE is the sharpest of them: it
#      lands somebody's branch in a shared repository and no later call takes it back;
#   5. anything that would send MAIL. The mailbox is read-only here and has no
#      sandbox equivalent (see AGENTS.md § Mail is READ-ONLY): the broker token
#      already carries `Mail.Send`, so the only thing standing between this
#      environment and a mail leaving the user's personal address is that nothing
#      names the endpoint. This hook refuses to be the first thing that does;
#   6. cycling the Intune CONTAINER, which holds the user's sign-in, in the spellings rule
#      3b lists: its own CLI's lifecycle verbs (behind any wrapper below, and as a transient
#      unit through `systemd-run`), its systemd unit and the repair's — every verb that
#      starts, stops, kills or freezes one, over `systemctl` or raw D-Bus — a kill naming one
#      of teams-lite's six hidden arguments, those arguments themselves (which make its own
#      binary boot the container, enter it, repair it, or — in the image's self-contained mode —
#      boot, stop or enroll the one it OWNS), the same arguments reached inside a container
#      through `docker|podman exec`, `docker compose exec` or `kubectl exec` — and so the two
#      image programs that end by stopping it, the self-test and the image's own entrypoint, RUN
#      by such an exec (reading either file stays open) — any
#      `StartTransientUnit`, and the crate's lifecycle and in-container calls inside a cargo
#      example. Reading it stays open (`intune-container status|doctor`, `cargo run --example
#      intune_status`, `teams-lite-intune-status` inside the image).
#
# WHERE A COMMAND IS. The rules that refuse a PROGRAM anchor it to a command position
# (`at_command_start`), so prose naming the same words runs nothing: the start of a line or
# of a segment after `;`, `&` or `|`; behind what a shell or a wrapper puts in front of a
# program — assignments, `env` and its options, `nohup`, `exec`, `sudo` and its bare flags,
# `timeout`, `nice`, `ionice`, `time`, `command`, `stdbuf`, `setsid`, `if`/`then`/`else`/`do`/
# `while`/`until`, `!`, and a shell (`bash -x x`, `sh -c '…'`) — and inside a subshell, a brace
# group, a command substitution or backticks. That last kind is read off a quote-aware
# EXECUTABLE VIEW of the line (`command_view`), because a `(` or a backtick in a commit message
# is text and the same character in a command is a boundary, and only the quoting can tell
# them apart. Three phrases are matched anywhere on purpose, and say why where they are
# spelled: rule 2's dev servers, rule 2a's `bun run start` and rule 3's `cargo run … --bin
# server`.
#
# WHAT IT CANNOT SEE, said rather than left to be found. It reads a command line, so a command
# assembled while the line runs is beyond it — `eval`, a variable holding the command,
# `bash -c "$CMD"`, the contents of a shell script it is handed (rule 1 scans an ad-hoc
# TS/JS/Python script for a browser driver and a backend write, and for nothing else here) —
# and so is most of a quoted `bash -c '…'` string: its first program is seen when nothing
# wraps it, and so is a command after a separator inside it, but not a wrapper in front of the
# first one, nor a subshell or a substitution in there. Neither does it know every program that
# runs another: `xargs`, `flock`, `watch`, `strace`, a `sudo` or `exec` option that takes a
# value. A kill by pid (`kill 6410`) is invisible — rule 3b refuses a kill whose pattern NAMES
# a hidden argument — and so is one whose pattern merely matches the repair (`pkill -f
# server`), or a glob stop that takes the repair unit with it. Rule 3 accepts
# TEAMS_LITE_READ_ONLY=1 anywhere on the line for a binary it runs directly, so a second
# command, `env -i` or `sudo` between the variable and the binary still passes. Rules 3d and 3e
# know a container, a volume and a release by NAME: a container stopped — or exec'd into and
# signalled, or joined — by its id, a list piped into `xargs docker stop`, a program inside it
# that signals on its own, a pid namespace shared by other means (a compose file's own
# `pid: "container:teams-lite"`, a podman pod created with `--share pid`), a volume's directory
# removed on disk (`rm -rf /var/lib/docker/volumes/…`), and a release, a StatefulSet or a claim
# named something the chart's name is not in, all walk past them.
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

# STOPPING something is not starting it. `kill`, `pkill` and `pgrep` name the same binaries
# and ports the rules below match, but cannot send, serve or type anything — and a guard that
# blocks cleanup only teaches the next agent to phrase its commands around the guard, which is
# the habit that caused the incident. Rules 2, 2a, 3 and 3c therefore read the line with every
# kill or probe COMMAND taken out of it (`command_line_outside_kills`, below) — and only that
# command. They used to skip the whole LINE when a kill word appeared anywhere in it, which
# made the ordinary restart one-liner `pkill -f target/release/server; target/release/server`
# start a send-capable backend with nothing in the way: a probe is not a licence for whatever
# follows it.
#
# The same idea, for the whole line, for rule 1 — which guards browser automation, where a
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
# prefixes a shell allows in front of a program — any number of `FOO=bar` assignments, the
# reserved words a command follows (`if`, `then`, `else`, `elif`, `do`, `while`, `until`,
# `!`) and the WRAPPERS that run the program after them. Rules anchor their patterns to it
# so that PROSE naming the same words runs nothing: a commit message ("chore: systemctl
# --user start teams-lite at boot") must stay allowed, for the same reason `ls
# target/debug/server` does. The assignments belong in it because the very variable rule 3
# asks for is written that way, and a rule a leading `FOO=1` can defeat is a rule with a
# spelling that walks straight through it.
#
# The wrappers are the same argument. `timeout 20 target/release/server` is the ordinary way
# to watch a server start for twenty seconds, and it started a send-capable backend past
# rule 3 because only `nohup`, `exec`, `env` and `sudo` were known; `timeout 300 … server
# __teams-lite-repair-broker` ran the repair by hand past rule 3b the same way. Each wrapper
# is spelled with the options that take a value (`timeout -s KILL 20`, `nice -n 10`,
# `ionice -c 2`, `stdbuf -oL`, `env -u NAME`), because an option the prefix does not know
# reads as the program and the match fails. `command -v` and `command -V` are deliberately
# NOT a prefix: they print where a program is and run nothing, so `command -v teams` is a
# question, while `command teams` runs it. `systemd-run` is not one either, because what
# it hands a program is a different environment — rules 3, 3b and 3c each spell it.
command_wrapper='([A-Za-z0-9_./~-]*/)?(nohup|exec|sudo([[:space:]]+-[A-Za-z]+)*|time([[:space:]]+-p)?|command([[:space:]]+-p)?|setsid([[:space:]]+(-[cfw]+|--(ctty|fork|wait)))*|nice([[:space:]]+(-n[[:space:]]*-?[0-9]+|-[0-9]+|--adjustment(=|[[:space:]]+)-?[0-9]+))*|ionice([[:space:]]+(-[cn][[:space:]]*[0-9]+|-t|--ignore|--(class|classdata)(=|[[:space:]]+)[^[:space:];&|]+))*|stdbuf([[:space:]]+(-[ioe][[:space:]]*[^[:space:];&|]+|--(input|output|error)(=|[[:space:]]+)[^[:space:];&|]+))*|timeout([[:space:]]+(--(signal|kill-after)(=|[[:space:]]+)[^[:space:];&|]+|-[sk][[:space:]]*[^[:space:];&|]+|--[a-z-]+|-[A-Za-z]+))*[[:space:]]+[0-9.]+[smhd]?|env([[:space:]]+(-[iv0]+|-|--(ignore-environment|null|debug)|-u[[:space:]]*[^[:space:];&|]+|--unset(=|[[:space:]]+)[^[:space:];&|]+|-C[[:space:]]*[^[:space:];&|]+|--chdir(=|[[:space:]]+)[^[:space:];&|]+))*)'
at_command_start="(^|[;&|])[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:];&|]*|if|then|else|elif|do|while|until|!|${command_wrapper})[[:space:]]+)*"

# A program handed to a SHELL — `bash x`, `sh -c 'x'`, `bash -x x` — is run as surely as one
# named on its own, so every program pattern accepts one in front, with its flags and the
# quote a `-c` string opens. The flags matter: `bash -x bin/teams-dev-server.sh` traces the
# launcher while it starts a send-capable backend, and it walked past rule 3 while only a bare
# `bash` was known. (`bash -n` is a syntax check; rules 3 and 3c exempt it as an inspection.)
by_a_shell="((bash|sh|zsh|dash)[[:space:]]+(-[A-Za-z]+[[:space:]]+)*)*[\"']?"
# The leading path of a program, which may be spelled with a variable or a tilde —
# `$HOME/.local/...`, `~/.local/...`, `"$PWD"/target/...`.
a_program_path='[A-Za-z0-9_./~${}-]*'
# Where a PROGRAM starts: a command position, an optional shell, and the program's own path.
at_a_program="${at_command_start}${by_a_shell}${a_program_path}"
# Where a WORD ends — a program's name, a verb, a hidden argument. Whitespace and the end of the
# line, and also the characters that end a command or a quoted string: `intune-container
# restart; echo ok`, `intune-container stop|cat` and `… __rootless-supervise;true` each walked
# past a rule that only knew whitespace. A `)` and a backtick end one only in the executable
# view below, where they are boundaries the shell really sees: on the raw line they are as often
# the end of a backticked or parenthesized NAME in a quoted message — a commit body saying that
# "`pkill -f x; target/release/server` is refused now" — so the raw reading keeps the narrower
# form (`ends_a_raw_word`, swapped in by the matchers below; every pattern is written once).
ends_a_word="([\"'[:space:];&|)\`]|\$)"
ends_a_raw_word="([\"'[:space:];&|]|\$)"

# THE EXECUTABLE VIEW of the line: the same characters, with the shell's own reading of them
# made explicit. Every character that is TEXT — inside single quotes, a double-quoted string,
# an escape, a comment or a here-document body — loses its power to separate commands (a `;`,
# `&`, `|`, `(`, `)`, backtick or newline there becomes a space, so a commit body's second line
# is no line start either), and every place a command really begins or ends that no separator
# marks — a subshell's `(` and `)`, a brace group's `{`, a `$(` or a backtick in any context,
# a `)` closing one — becomes a `;`. So `(intune-container
# stop)`, `{ intune-container stop; }`, `x=$(intune-container stop)` and `` `intune-container
# stop` `` all put the program at a command position, while `git commit -m 'docs:
# `intune-container stop` (…)'` and the heredoc a commit body is written with put it nowhere.
# The view has the same length as the line, character for character, which is what lets one
# pass also hand rules 2, 2a, 3 and 3c the line with every kill or probe command blanked out:
# a COMMAND is the stretch between two real boundaries, and one that begins with `kill`,
# `pkill`, `pgrep` or `killall` is cleanup, blanked in both the line and the view. A pgrep
# whose pattern holds a quoted `|` is one command in the view, so it is blanked whole.
#
# Every rule reads the RAW line, as the rules here always have (rules 2, 2a, 3 and 3c with its
# kill commands blanked), and the view besides, so the view can only add a match, never take
# one away from the raw reading — which is also why a line of a here-document
# or of a multi-line quoted string that BEGINS with a refused command still reads as one: grep
# reads the raw line line by line, which is what catches the second line of a multi-line
# `bash -c`. It is a parser for the shapes commands really take, not a shell: an expansion
# inside an unquoted here-document body is read as text, and anything it gets wrong falls back
# to what the raw line says.
command_view="" command_line_outside_kills="" command_view_outside_kills=""
{
  IFS= read -r -d '' command_view
  IFS= read -r -d '' command_line_outside_kills
  IFS= read -r -d '' command_view_outside_kills
} < <(printf '%s' "$command_line" | python3 -c '
import re, sys

line = sys.stdin.read()
n = len(line)
SQ, DQ, BQ = "\x27", "\x22", "\x60"
SEPARATORS = ";&|()" + BQ
view, cut = list(line), [False] * n

def literal(i):
    if view[i] in SEPARATORS or view[i] == "\n":
        view[i] = " "

def boundary(i):
    view[i], cut[i] = ";", True

def word_start(i):
    return i == 0 or line[i - 1] in " \t\n;&|(" + BQ

stack, heredocs, i = ["command"], [], 0
while i < n:
    c, context = line[i], stack[-1]
    if c == "\\":
        if i + 1 < n:
            literal(i + 1)
        i += 2
        continue
    if context == "double":
        if c == DQ:
            stack.pop()
        elif c == BQ:
            boundary(i)
            stack.append("backtick")
        elif c == "(" and line[i - 1] == "$":
            boundary(i)
            stack.append("paren")
        else:
            literal(i)
        i += 1
        continue
    if c == SQ:
        j, ansi = i + 1, line[i - 1 : i] == "$"
        while j < n and line[j] != SQ:
            j += 2 if ansi and line[j] == "\\" else 1
        for k in range(i + 1, min(j, n)):
            literal(k)
        i = j + 1
        continue
    if c == "\n":
        cut[i] = True
        i += 1
        for delimiter, strip in heredocs:
            while i < n:
                end = line.find("\n", i)
                end = n if end < 0 else end
                text = line[i:end]
                closed = (text.lstrip("\t") if strip else text) == delimiter
                if not closed:
                    for k in range(i, min(end + 1, n)):
                        literal(k)
                elif end < n:
                    cut[end] = True
                i = end + 1
                if closed:
                    break
        heredocs = []
        continue
    if c in ";&|":
        cut[i] = True
    elif c == DQ:
        stack.append("double")
    elif c == BQ:
        boundary(i)
        if context == "backtick":
            stack.pop()
        else:
            stack.append("backtick")
    elif c == "(":
        boundary(i)
        stack.append("paren")
    elif c == ")":
        boundary(i)
        if context == "paren":
            stack.pop()
    elif c == "{" and word_start(i) and line[i + 1 : i + 2] in (" ", "\t", "\n"):
        boundary(i)
    elif c == "#" and word_start(i):
        end = line.find("\n", i)
        end = n if end < 0 else end
        for k in range(i, end):
            literal(k)
        i = end
        continue
    elif line.startswith("<<", i) and not line.startswith("<<<", i):
        j = i + 2
        strip = line[j : j + 1] == "-"
        j += 1 if strip else 0
        while j < n and line[j] in " \t":
            j += 1
        k = j
        while k < n and line[k] not in " \t\n;&|()<>":
            k += 1
        delimiter = line[j:k].replace(SQ, "").replace(DQ, "").replace("\\", "")
        if delimiter:
            heredocs.append((delimiter, strip))
        i = k
        continue
    i += 1

KILL = re.compile(r"\s*(?:(?:[A-Za-z_]\w*=\S*|if|then|else|elif|do|while|until|!|sudo|nohup|exec|time|command|setsid|nice|timeout(?:\s+-\S+)*\s+[\d.]+[smhd]?)\s+)*"
                  r"(?:[^\s;&|]*/)?(?:p?kill|pgrep|killall)(?:\s|$)")
raw_left, view_left, start = list(line), list(view), 0
for end in [k for k in range(n) if cut[k]] + [n]:
    if KILL.match("".join(view[start:end])):
        for k in range(start, end):
            if line[k] != "\n":
                raw_left[k] = view_left[k] = " "
    start = end + 1
sys.stdout.write("".join(view) + "\0" + "".join(raw_left) + "\0" + "".join(view_left) + "\0")
' 2>/dev/null)
# Without the view — no python3, or a parse that failed — every rule reads the raw line alone,
# which is what it read before the view existed; a line that is nothing but a probe keeps its
# exemption.
if [ -z "$command_view" ]; then
  command_view="$command_line"
  if probing_processes; then
    command_line_outside_kills="" command_view_outside_kills=""
  else
    command_line_outside_kills="$command_line" command_view_outside_kills="$command_line"
  fi
fi

# A pattern as the RAW line is read with it: the same ERE, a word ending at `ends_a_raw_word`.
raw_form() {
  printf '%s' "${1//"$ends_a_word"/"$ends_a_raw_word"}"
}

# Does a command on this line match the ERE in $1 — on the raw line, or on its executable view?
# A view identical to the line holds no `(`, `)`, backtick or brace group and no separator
# inside a quote — every one of those changes a character of the view — so it can only repeat
# the raw answer (`)` and a backtick are the two characters the forms differ on), and the
# second grep is skipped: this hook runs before every command.
a_command_matches() {
  printf '%s\n' "$command_line" | grep -qE "${1//"$ends_a_word"/"$ends_a_raw_word"}" && return 0
  [ "$command_view" = "$command_line" ] && return 1
  printf '%s\n' "$command_view" | grep -qE "$1"
}

# The same, with every kill and probe command blanked out first: what rules 2, 2a, 3 and 3c
# read, so cleanup stays allowed and is no licence for what follows it.
a_command_outside_a_kill_matches() {
  printf '%s\n' "$command_line_outside_kills" |
    grep -qE "${1//"$ends_a_word"/"$ends_a_raw_word"}" && return 0
  [ "$command_view_outside_kills" = "$command_line_outside_kills" ] && return 1
  printf '%s\n' "$command_view_outside_kills" | grep -qE "$1"
}

# A RAW D-BUS CALL, at a command position: `busctl`, `gdbus` or `dbus-send`, with the rest of
# its segment after it. systemd answers the same methods `systemctl` wraps, so every rule that
# refuses a `systemctl` verb has a second spelling here that no `systemctl` pattern can see —
# `busctl --user call org.freedesktop.systemd1 … StartUnit ss teams-lite-backend.service
# replace` starts the send-capable backend as surely as `systemctl --user start` does. Rules
# 3a and 3b append the method and the unit name; reading a property or introspecting an
# object names neither and stays allowed.
raw_dbus_call="${at_a_program}(busctl|gdbus|dbus-send)[[:space:]][^;&|]*"

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
# `join-live.ts` does it with the authorized meeting's `data-join-url`; `call-live.ts` does
# it with the authorized one-to-one's `data-conversation-id`, read twice — off the composer
# and off the call button. A new one must do the same before it is added here.
sanctioned_automation() {
  printf '%s' "$command_line" |
    grep -qE 'scripts/preview\.ts|bun run preview|test:e2e|playwright test|playwright install|scripts/sandbox-live\.ts|bun run sandbox|scripts/join-live\.ts|bun run join-live|scripts/call-live\.ts|bun run call-live'
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

# Does this source DRIVE the identity broker's sign-in window — type into it, click in it,
# focus it, close it, or MOVE it (`capture_or_place`, the live session's read, which moves a
# window that hangs off its screen)? Reading it (`find`, `capture`, `size`) is measurement and
# stays allowed: `examples/signin_window_recon.rs` is what re-measures SIGN-IN.md § 3.
drives_the_signin_window() {
  grep -qE '\.(type_key|click|focus|close|capture_or_place)\(|close_open_signin_window|signin::Signin::start|interactive_token' "$1"
}

# Does this source CYCLE the Intune container — stop it, start it, rebuild it, restore over it,
# power its init off, or boot it through the crate's own supervisor — or ask for the repair
# that does? teams-lite links the `intune-container` crate now (src/intune.rs), so every one of
# those is a function call away from any example in this repo, with no port, no RPC, no write
# token and no `intune-container` on the command line for rule 3b to see.
#
# The names are the crate's own, read off its source at the pinned commit: `ops` is what its CLI
# runs (`backup` is there because it stops the container for a consistent archive and boots it
# again; `update` because it swaps the rootfs under a stopped container; `portal_*` and `edge`
# because a display is attached by a restart; `shell` because it enters the container, starting
# it first), `backend` is the half under it — `supervise_main` and `exec_main` ARE the boot and
# the in-container exec, and `exec`, `exec_foreground` and `shell` reach the same exec without
# the re-exec — `runtime` is the raw namespace layer (`poweroff_pid`, and `exec_pid`,
# `exec_pid_env`, `run_in_container`, `run_in_rootfs` and `open_shell_pty`, which run a program
# inside the container or its rootfs, as root unless a uid is passed: `exec_pid(leader,
# &["/bin/systemctl", "poweroff"], None)` is a poweroff by another name), and
# `autostart::enable|disable` start and stop the container's own unit, the library twin of the
# CLI verbs rule 3b refuses. The pinned commit adds four more, each a write by another name:
# `ops::portal_open_headless` starts the Intune portal INSIDE the running container (the
# enrollment flow, with no restart — which is why it is not a read); `backup::backup_rootless`
# and `backup::restore_rootless` are the archive halves `ops::backup|restore` stop the container
# around; `runtime::clear_runtime_state` and `save_runtime_state` rewrite the one file every
# backend finds the broker through — cleared under a RUNNING container, it reads as stopped and
# the next boot starts a second one over the same rootfs — and `runtime::remove_tree_as_root`
# is how the rootfs is deleted. What is left alone, on purpose and by name, is what
# examples/intune_status.rs (through teams_lite::intune) and any recon are built on:
# `runtime::load_runtime_state`, `runtime::is_running`, `ops::status`, `ops::is_initialized`,
# `ops::account`, `autostart::status`, `doctor::collect` — and `backend::probe`, which is NOT a
# read: it runs a caller-supplied `/bin/sh -c` script inside the running container, as the
# container's user, and answers its exit code. It is left open because the crate's own health
# checks (`doctor`) are probes of fixed scripts, and a recon asking the same questions is
# reading; an example that hands it anything else is running a command inside the user's
# sign-in container, which this scan cannot tell from a read, and should not do it.
#
# Three spellings, because Rust has three ways to reach a function: the full path
# (`intune_container::ops::stop(` or a `use` of it), the module imported and called through
# (`use intune_container::{backend, …}; backend::stop(…)`, matched only in a file that names the
# crate, so `tokio::runtime::…` elsewhere is nobody's business), and a grouped import of the
# function itself (`use intune_container::ops::{start, status};`). A glob import is not
# followed: it is not how this code is written, and the scan is a tripwire for the shapes code
# really takes rather than a proof — like every other source scan in this file.
#
# teams-lite's own half is the repair and, in the image's self-contained mode, the HELPERS:
# `intune::start_repair_unit` asks systemd for the transient unit that restarts the container,
# `intune::start_repair` is the mode-aware entry point that spawns either that unit or the
# embedded repair helper, `intune_embedded::spawn_helper` spawns the helper that BOOTS the
# container the image owns (a 1.7 GB pull and an init, on a fresh volume), repairs it or opens
# its portal to ENROLL it, and `intune::dispatch_reexec` runs whichever hidden subcommand its argv
# names — every one of those among them — in the calling process. The helpers' own bodies are
# matched by the `_main` suffix their module gives them (`repair_main`'s shape, which the
# embedded ones copy), and the private functions under the entry points are named too — the
# boot's own `boot` and `intune::boot_headless`, the start both the repair and the boot share — so a
# later `pub` does not open a hole; and so are the six hidden arguments, as literals and as the
# constants that hold them, which is what an example would hand `Command::new` to reach the same
# act through a binary.
cycles_the_container_in_source() {
  local lifecycle='(ops::(start|stop|init|enroll|destroy|update|restore|backup|edge|portal_start|portal_stop|portal_finish|portal_open_headless|detach_display|shell)|backend::(start|stop|attach_display|detach_display|initialize|update_rootfs|remove_rootfs|purge|backup|restore|supervise_main|exec_main|exec|exec_foreground|shell)|runtime::(poweroff_pid|start_systemd|boot_systemd|exec_pid|exec_pid_env|run_in_container|run_in_rootfs|open_shell_pty|clear_runtime_state|save_runtime_state|remove_tree_as_root)|autostart::(enable|disable)|backup::(backup_rootless|restore_rootless))'
  local names='(start|stop|init|enroll|destroy|update|restore|backup|edge|portal_start|portal_stop|portal_finish|portal_open_headless|detach_display|attach_display|initialize|update_rootfs|remove_rootfs|purge|supervise_main|exec_main|exec|exec_foreground|shell|poweroff_pid|start_systemd|boot_systemd|exec_pid|exec_pid_env|run_in_container|run_in_rootfs|open_shell_pty|clear_runtime_state|save_runtime_state|remove_tree_as_root|enable|disable|backup_rootless|restore_rootless)'
  grep -qE "intune_container::${lifecycle}([^A-Za-z0-9_]|\$)" "$1" && return 0
  if grep -q 'intune_container' "$1"; then
    grep -qE "(^|[^A-Za-z0-9_])${lifecycle}([^A-Za-z0-9_]|\$)" "$1" && return 0
    grep -qE "intune_container::(ops|backend|runtime|autostart|backup)::\{([^}]*[[:space:],])?${names}([[:space:],}]|\$)" "$1" && return 0
  fi
  grep -qE '(^|[^A-Za-z0-9_])intune::(start_repair_unit|start_repair|start_transient_oneshot|dispatch_reexec|restart_container|boot_headless|repair_main)([^A-Za-z0-9_]|$)|intune::\{([^}]*[[:space:],])?(start_repair_unit|start_repair|dispatch_reexec)([[:space:],}]|$)|(^|[^A-Za-z0-9_])intune_embedded::(spawn_helper|boot|[A-Za-z0-9_]*_main)([^A-Za-z0-9_]|$)|intune_embedded::\{([^}]*[[:space:],])?(spawn_helper|[A-Za-z0-9_]*_main)([[:space:],}]|$)|__teams-lite-repair-broker|__teams-lite-intune-(boot|stop|portal)|__rootless-supervise|__rootless-exec|(REPAIR|SUPERVISE|EXEC|BOOT|STOP|PORTAL)_SUBCOMMAND' "$1"
}

# The Rust sources a `cargo run --example NAME` is about to execute.
#
# Rule 1 scans INTERPRETED scripts, which left a hole this feature opened: a cargo
# example talks to Teams directly, with a broker token, past every port and RPC the
# other rules match. `examples/agent_stream_probe.rs` is the legitimate shape of one
# (it posts to the sandbox channel and nowhere else); the rule below is what keeps
# the next one honest.
#
# `--bin` is deliberately NOT matched: the only binary here is the backend, and it names
# `send_message` and the crate's lifecycle by definition. The command line is what governs
# it instead — rule 3 for starting it at all, and rule 3b for the hidden arguments that turn
# it into the container's supervisor, its in-container exec or the broker repair.
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
  if grep -qiE 'merge_requests/[^ "'\'']*/((un)?approve|merge|notes)|/(un)?approve"|gitlab_approval::set|gitlab_set_approval|gitlab_mr_write::|gitlab_mr_(merge|comment|delete_comment|edit_comment|resolve_thread|set_state)|state_event|"mutation |mutation *\{' "$1"; then
    return 0
  fi
  # RESOLVING a thread is `PUT …/discussions/{id}` with a `resolved` field, and READING one is
  # the same path with no field — which the preview cards and every recon do. So the two are
  # told apart by the pair, over the whole file: grep is line-based and a fetch puts its URL
  # and its body on different lines. A list read (`/discussions?per_page=…`) never matches at
  # all, because the write names a thread BY ID.
  grep -qE 'merge_requests/[^ "'\'']*/discussions/' "$1" &&
    grep -qiE '"?resolved"?[[:space:]]*[:=]' "$1"
}

# Cargo examples that would post to Teams somewhere other than the sandbox channel,
# and (separately) those that would publish the user's own presence.
examples_that_send=""
examples_publishing_presence=""
examples_writing_to_a_tracker=""
examples_driving_the_signin_window=""
examples_cycling_the_container=""
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
  # Driving the broker's own sign-in window is a THIRD shape with no sandbox: there is one
  # window, it is the user's live sign-in, and an example reaches it with no port, no RPC and
  # no write token in the way. `examples/signin_window_recon.rs` had exactly that as two flags
  # (`--type`, `--close`) until they were removed — reading the window is measurement, typing
  # into it or closing it is the act the four `signin_*` methods are gated for.
  if drives_the_signin_window "$path"; then
    examples_driving_the_signin_window="$examples_driving_the_signin_window $source"
  fi
  # The container is a FOURTH shape with no sandbox: there is one, it holds the user's sign-in,
  # and since the crate is linked an example reaches its lifecycle with a function call.
  if cycles_the_container_in_source "$path"; then
    examples_cycling_the_container="$examples_cycling_the_container $source"
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
    # EIGHT ports, not two. 19420/19440 are the always-on service; 19421/19441 are the
    # user's hands-on dev pair (bin/teams-dev-server.sh and `bun run dev`), which is
    # just as send-capable; 19422/19442 are the released build beside them; 19423/19443 are
    # the container image (packaging/docker). In its host-broker mode it shares the host's
    # network namespace, so both are this machine's loopback like the others; in its default,
    # self-contained mode it has a network of its own and only the web front is published, on
    # 127.0.0.1:19443 — the same door to the same account. Only 19430 — read-only — is
    # absent, by design.
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
    # `chess_engine_download` and `chess_engine_forget` are the CHESS ENGINE (MACHINE_METHODS in
    # src/bin/server.rs): the first spends the user's bandwidth on 7.3 MB from a pinned
    # release and writes it to their disk, the second deletes it. Neither posts to anybody,
    # so this is the weakest entry in the list — but a script that fetched 7 MB on the
    # user's live backend, or removed something they had fetched, is a side effect nobody
    # asked for, and a read-only backend refuses both anyway. `chess_sound_forget` is the
    # board's own SOUNDS on the same terms and for the same reason — it deletes what the
    # user's machine fetched. Their STATUS is not here: it is an open read, and it is what
    # fetches them, which is 64 KB a board asks for by being opened.
    #
    # `restart_backend` is the update's sibling minus the new binary (MACHINE_METHODS in
    # src/bin/server.rs): it takes down the process the user's own pages are talking to, and
    # it cuts off a local agent that is writing a reply — so tooling must not be able to
    # restart the app somebody is reading, for the same reason it must not apply an update.
    #
    # `agent_stop` kills a live `@claude` run mid-answer (MACHINE_METHODS in
    # src/bin/server.rs): it acts on a program this machine is running for the user, and
    # tooling must not cut a reply short in the user's own thread — the narrow cousin of the
    # restart above.
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
    #
    # `seal_set`, `seal_off`, `seal_forget` and `seal_reveal` decide whether a conversation's
    # messages are ENCRYPTED before they reach Teams, and under which passphrase. A script that
    # turned sealing off would make the next message go out in the clear to a chat whose reader
    # believes it is sealed; one that set a passphrase would make every message the user posts
    # unreadable to the colleagues they are writing to; `seal_forget` drops a key and every
    # message it opened becomes unreadable for good; and `seal_reveal` ANSWERS with a passphrase.
    # `seal_status` stays allowed: it names which chats are sealed and never a key.
    #
    # `custom_emoji_add`, `custom_emoji_remove` and `custom_emoji_import` write the emoji
    # pack: a script that could plant art in the pack could post a picture under the
    # user's name on the next send (MACHINE_METHODS in src/bin/server.rs).
    #
    # `signin_start`, `signin_frame`, `signin_input` and `signin_cancel` serve the identity
    # broker's own sign-in window to a browser (MACHINE_METHODS in src/bin/server.rs, over
    # src/signin.rs and SIGN-IN.md). Each one is its own reason: `signin_start` authenticates
    # as the user, `signin_frame` answers with a PICTURE of a sign-in page, and `signin_input`
    # presses keys into that page — so a script reaching a live backend with them could watch
    # a password being typed, or type one. Asking how a sign-in is GOING (`signin_status`)
    # publishes nothing and is not listed.
    #
    # `agent_persona_save` and `agent_persona_remove` write the user's own CUSTOM AGENTS
    # (MACHINE_METHODS in src/bin/server.rs, over src/agent_persona.rs). A row there decides
    # what a later `@bebou` in an opted-in thread does: which CLI starts, which model reads
    # the thread, and what instruction leads the prompt — so a script that could write one
    # could put words in the mouth of a program that answers as the user. Reading the list
    # back is not a write and is not listed.
    #
    # `intune_enroll` ENROLLS the Intune container the image runs in its self-contained mode
    # (MACHINE_METHODS in src/bin/server.rs, over src/signin.rs): it opens the Intune portal
    # inside that container and serves its window through the four `signin_*` methods above, so
    # what it starts is the registration of a DEVICE in the user's organisation, under their
    # account — a new entry in their tenant's device list, which the backend cannot take back.
    # Reading whether one is possible (`broker_status`'s `can_enroll`) is not a write and is not
    # listed.
    if grep -qE '(127\.0\.0\.1|localhost):(1942[0-3]|1944[0-3])|[A-Za-z0-9-]+\.ts\.net' "$script" &&
      grep -qE '"(send|edit|delete|react|mark_read|mail_mark_read|set_always_available|set_chat_pinned|set_chat_muted|set_chat_hidden|push_subscribe|push_unsubscribe|push_test|set_settings|agent_set_mode|agent_set_tools|agent_set_provider|agent_set_unrestricted|agent_stop|agent_cli_install|agent_cli_remove|agent_cli_set_auto_update|set_person_name|set_person_avatar|custom_emoji_add|custom_emoji_remove|custom_emoji_import|agent_persona_save|agent_persona_remove|seal_set|seal_off|seal_forget|seal_reveal|signin_start|signin_frame|signin_input|signin_cancel|update_download|update_apply|chess_engine_download|chess_engine_forget|chess_sound_forget|restart_backend|repair_broker|intune_enroll|set_calling|call_prepare|call_place|call_join|call_accept|call_offer_media|call_answer_media|call_subscribe|call_start_sharing|call_stop_sharing|call_hangup|call_mute|gitlab_set_approval|gitlab_mr_merge|gitlab_mr_comment|gitlab_mr_delete_comment|gitlab_mr_edit_comment|gitlab_mr_resolve_thread|gitlab_mr_set_state|gitlab_mr_review_run|gitlab_mr_review_ask)"|'\''(send|edit|delete|react|mark_read|mail_mark_read|set_always_available|set_chat_pinned|set_chat_muted|set_chat_hidden|push_subscribe|push_unsubscribe|push_test|set_settings|agent_set_mode|agent_set_tools|agent_set_provider|agent_set_unrestricted|agent_stop|agent_cli_install|agent_cli_remove|agent_cli_set_auto_update|set_person_name|set_person_avatar|custom_emoji_add|custom_emoji_remove|custom_emoji_import|agent_persona_save|agent_persona_remove|seal_set|seal_off|seal_forget|seal_reveal|signin_start|signin_frame|signin_input|signin_cancel|update_download|update_apply|chess_engine_download|chess_engine_forget|chess_sound_forget|restart_backend|repair_broker|intune_enroll|set_calling|call_prepare|call_place|call_join|call_accept|call_offer_media|call_answer_media|call_subscribe|call_start_sharing|call_stop_sharing|call_hangup|call_mute|gitlab_set_approval|gitlab_mr_merge|gitlab_mr_comment|gitlab_mr_delete_comment|gitlab_mr_edit_comment|gitlab_mr_resolve_thread|gitlab_mr_set_state|gitlab_mr_review_run|gitlab_mr_review_ask)'\''|write_token' "$script"; then
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
port (19420 service / 19421 dev / 19422 released / 19423 image) or an app server that relays
to it (19440 / 19441 / 19442 / 19443 / a tailnet name):
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
  grep -qiE '(curl|wget|xh|httpie|http)[^;&|]*(merge_requests/[^ "'\'']*/((un)?approve|merge|notes)|state_event|merge_requests/[^ "'\'']*/discussions/[^;&|]*resolved|resolved[^;&|]*merge_requests/[^ "'\'']*/discussions/)' ||
  [ -n "$scripts_writing_to_a_tracker" ] || [ -n "$examples_writing_to_a_tracker" ]; then
  [ -n "$scripts_writing_to_a_tracker" ] &&
    printf 'note: a tracker write was found inside%s\n' "$scripts_writing_to_a_tracker" >&2
  [ -n "$examples_writing_to_a_tracker" ] &&
    printf 'note: a tracker write was found inside%s\n' "$examples_writing_to_a_tracker" >&2
  block "This command would WRITE to one of the user's trackers
(…/merge_requests/<iid>/approve | /unapprove | /merge | /notes, a discussion resolved, a
state_event, or a
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

# --- 1d-bis. the broker's sign-in window is driven by the gated RPCs, or not at all ---
# There is ONE sign-in window on this machine and it is the user's live sign-in: typing into it
# is typing into their password field, and closing it cancels a flow they may be halfway
# through. The app reaches it through four MACHINE methods (rule 1 covers those by name), and a
# cargo example reaches it with no port, no RPC and no write token in the way — which
# `examples/signin_window_recon.rs` really did, behind `--type` and `--close`, until they were
# removed. READING the window is measurement and stays allowed, which is what that example is
# for now.
if [ -n "$examples_driving_the_signin_window" ]; then
  printf 'note: the sign-in window is driven inside%s\n' "$examples_driving_the_signin_window" >&2
  block "This command would DRIVE the identity broker's sign-in window from a command line
(typing into it, clicking in it, focusing it, closing it, or starting an interactive
acquisition).

That window is the user's live sign-in. Typing into it is typing into their password field;
closing it cancels the flow. The app does all of this through four gated RPCs — signin_start,
signin_frame, signin_input, signin_cancel — behind the write token, refused read-only, and
refused by this hook against a live port (AGENTS.md § Signing in again). A cargo example has
none of those in the way.

READING the window is fine and is what the measurements rest on: cargo run --example
signin_window_recon reports the display, the window and one frame's size, and is untouched by
this rule. To exercise the driving half, use the mock: cd web && bun run preview -- --signin."
fi

# --- 1d-ter. an example may not cycle the Intune container ------------------------
# The command-line half of this is rule 3b. This is the half a command line cannot show: since
# teams-lite links the `intune-container` crate, the container's whole lifecycle is a function
# call from any example — `cargo run --example x` names no `intune-container`, no hidden
# argument and no unit, so nothing else in this file would see it. See
# `cycles_the_container_in_source` for what is matched and why the reads are not.
if [ -n "$examples_cycling_the_container" ]; then
  printf 'note: the Intune container is cycled inside%s\n' "$examples_cycling_the_container" >&2
  block "This command runs a cargo example that would CYCLE the Intune container — stop it, start
it, rebuild or restore it, power its init off, boot it through the crate's own supervisor,
install or remove its unit, run a program inside it or open its portal — or ask for the broker
repair that restarts it, or for one of the helpers teams-lite's image boots, stops, repairs or
enrolls its own container with:
   ${examples_cycling_the_container# }

That container holds the user's sign-in. While it is down the identity broker answers
nothing: every token call fails and teams-lite goes empty for whoever is reading it, a phone
on the tailnet included, for about a minute. An example reaches it through the crate with no
port, no RPC and no write token in the way, so what the file calls is the only thing that
can be checked — and there is one container, so no target can be pinned to make it safe.

READING the container is fine, and it is what the diagnostic is for:

  cargo run --example intune_status     # the mode, the broker's bus, whether a repair is
                                        # available, which helper is at work, and whether
                                        # the login keyring is locked
  intune-container status
  intune-container doctor

A restart IS the remedy when that keyring re-locked, but it is not yours to run: the app's own
Repair sign-in button asks for it, and the backend asks on its own when it finds the keyring
locked — at most three automatic repairs an hour across every backend on the machine. Ask the
user to press the button."
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
#
# What is exempt is the kill COMMAND, never the line it is on: the incident itself was a
# dev server RESTARTED without its variable, and `pkill -f vite; cd web && bun run dev` is
# exactly that restart in one line.
if ! searching_text &&
  a_command_outside_a_kill_matches '(vite dev|vite build --watch|bun run dev)([^:]|$)'; then
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
if ! searching_text &&
  a_command_outside_a_kill_matches "(bun run start|${at_command_start}${by_a_shell}(${a_program_path}/)?bun[^;&|]*web/server\.ts)([^:]|\$)"; then
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

# --- the container and cluster CLIs, named once -----------------------------------
# Rules 3b, 3d and 3e all read a command through one of these: 3b for the hidden arguments an
# `exec` reaches inside teams-lite's own container, 3d for the image, 3e for the chart. A program
# here is matched where a shell would RUN it (`at_a_named_program`: a command position, a shell,
# and a path that ENDS in `/` before the name), so `mydocker` and `hoc` are not `docker` and `oc`.
at_a_named_program="${at_command_start}${by_a_shell}(${a_program_path}/)?"
container_cli='(docker|podman|nerdctl)([[:space:]]+container)?'
compose_cli='((docker|podman|nerdctl)[[:space:]]+([^;&|]*[[:space:]])?compose|docker-compose|podman-compose)'
kube_cli='((k3s|microk8s)[[:space:]]+kubectl|kubectl|oc)'

# --- what a container CLI RUNS inside a container, read once -------------------------------
# Four rules ask what a container CLI makes happen INSIDE a container, and they read it ONE way,
# here: rule 3b for the two image programs that end with the stop (the self-test and the
# entrypoint), rule 3c-ii for a second launcher or backend, rule 3d-ii for a signal, and rule
# 3d-iii for another container joined to the install's pid namespace. Each asks for its own
# verdict (`inside_a_container image-program|stack|signal|joins`), and the parse runs at most
# once per command line — only on a line that names a container CLI and reaches into a container
# at all (`exec`, `debug`, `--pid`), because this hook runs before every command and the parse is
# a process of its own.
#
# WHAT IS A PROGRAM. The word the exec'd command RUNS — never a word it is handed — read past the
# wrappers that run a program after their own options (`timeout 5 x`, `env A=1 x`, `setpriv
# --reuid=teams -- x`, `runuser -u teams -- x`, `busybox x`, `xargs x`, `exec x`), INTO a shell's
# `-c` script (its quoted separators and its newlines included), and onto a shell's script
# operand (`sh x`) or what `.`/`source` reads. So `docker exec teams-lite cat
# /usr/local/bin/teams-lite-container` reads a file and runs nothing, while `… sh -c
# '/usr/local/bin/teams-lite-container --help'` runs it. A PROGRAM that runs another on its own (a
# script that starts the launcher) is beyond it, like a kill by pid of a process it cannot name.
#
# WHICH CONTAINER. The install is the container named `teams-lite` (both compose files set
# `container_name`), the compose service `teams-lite`, or the chart's pod — `teams-lite-0`, a
# release's `<release>-teams-lite-0`, or `sts/teams-lite`, read as kubectl reads `kind/name`,
# with the namespace's value never taken for it (`kubectl -n teams-lite exec debug -- kill 1`
# signals a pod of another name). A target the shell COMPUTES (`$(docker ps -q)`) counts as the
# install: this hook cannot see whether teams-lite is in it. A container of ANOTHER name —
# tooling's own `teams-lite-ro` included — is somebody's own, except for what only teams-lite's
# image holds (the two image programs, and the backend at its two teams-lite paths), which is
# refused in any container: the act is the program, and an exec of it is the same act wherever
# it lands.
#
# It reads the line TWICE, and each reading sees what the other cannot. Cut at every `;`, `&`, `|`
# and newline, as the raw reading of every rule here is, a command keeps a target the shell
# computes whole (`docker exec $(docker ps -q) kill 1`) and a line of a here-document is a line;
# lexed as a shell lexes it, a `-c` script keeps the separators inside its quotes (`sh -c 'cat pid
# | xargs kill'`). It does not use `commands_matching`, which blanks every command that BEGINS
# with a kill — and the kill rule 3d-ii looks for is exactly the one after a computed target's `)`.
# The program has to be the container CLI, past the same wrappers, so `echo docker exec …` runs
# nothing. An input the parse fails on is read as what the line's own words point at — each
# verdict whose word is on the line — which is the narrow answer.
names_a_container_cli='(^|[^A-Za-z0-9_-])(docker|podman|nerdctl|docker-compose|podman-compose|kubectl|oc|k3s|microk8s)([^A-Za-z0-9_-]|$)'
reaches_into_a_container='(^|[^A-Za-z0-9_-])(exec|debug)([^A-Za-z0-9_-]|$)|--pid'
container_verdicts=""
container_verdicts_read=0
read_container_verdicts() {
  container_verdicts_read=1
  printf '%s' "$command_line" | grep -qE "$names_a_container_cli" || return 0
  printf '%s' "$command_line" | grep -qE -- "$reaches_into_a_container" || return 0
  container_verdicts="$(printf '%s' "$command_line" | python3 -c '
import os, re, shlex, sys

SIGNALLERS = {"kill", "pkill", "killall", "skill"}
CLIS = {"docker", "podman", "nerdctl", "docker-compose", "podman-compose", "kubectl", "oc", "k3s", "microk8s"}
SHELLS = {"sh", "bash", "ash", "dash", "zsh", "ksh", "mksh", "su"}
SOURCERS = {".", "source"}
# The options of a shell that take a value, so the word after them is not its script operand.
SHELL_VALUES = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}
# A wrapper runs the program after its own options: the ones that take a value, and how many
# positional words stand between them and the program (timeout`s duration, chroot`s new root,
# gosu`s user).
WRAPPERS = {
    "sudo": ({"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group", "--host", "--prompt", "--chdir"}, 0),
    "doas": ({"-u", "-C"}, 0),
    "env": ({"-u", "--unset", "-C", "--chdir"}, 0),
    "nice": ({"-n", "--adjustment"}, 0),
    "ionice": ({"-c", "-n", "--class", "--classdata"}, 0),
    "timeout": ({"-s", "--signal", "-k", "--kill-after"}, 1),
    "stdbuf": ({"-i", "-o", "-e", "--input", "--output", "--error"}, 0),
    "xargs": ({"-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter",
               "--max-args", "--max-procs", "--max-lines", "--max-chars", "--process-slot-var"}, 0),
    "nohup": (set(), 0), "setsid": (set(), 0), "exec": ({"-a"}, 0), "command": (set(), 0),
    "time": ({"-f", "-o", "--format", "--output"}, 0), "busybox": (set(), 0),
    # How the image itself drops to its runtime user (packaging/docker/entrypoint.sh), and the
    # other spellings of the same thing.
    "setpriv": ({"--reuid", "--regid", "--ruid", "--euid", "--rgid", "--egid", "--groups", "--inh-caps",
                 "--ambient-caps", "--bounding-set", "--securebits", "--pdeathsig", "--selinux-label",
                 "--apparmor-profile", "--landlock-access", "--landlock-rule", "--seccomp-filter"}, 0),
    "runuser": ({"-u", "--user", "-g", "--group", "-G", "--supp-group", "-s", "--shell", "-w",
                 "--whitelist-environment"}, 0),
    "gosu": (set(), 1), "su-exec": (set(), 1),
    "chroot": ({"--userspec", "--groups"}, 1),
}
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
COMPUTED = re.compile(r"\$\(|`")
# What the verb is followed by, per CLI: the long options that take a value, and the short
# letters that do (a value written straight after its letter is one word: `-uteams`).
KUBE_VALUES = {"-c", "--container", "-n", "--namespace", "-f", "--filename", "--pod-running-timeout",
               "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--as",
               "--as-group", "--as-uid", "--token", "--request-timeout", "--cache-dir", "-v", "--v",
               "--certificate-authority", "--client-certificate", "--client-key", "--tls-server-name"}
VERB_OPTIONS = {
    "engine": ({"-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--detach-keys",
                "--preserve-fds"}, set("euw")),
    "compose": ({"-e", "--env", "-u", "--user", "-w", "--workdir", "--index"}, set("euw")),
    "kube": (KUBE_VALUES, set("cnfsv")),
    "kube-debug": (KUBE_VALUES | {"--image", "--target", "--copy-to", "--profile", "--env",
                                  "--image-pull-policy", "--set-image", "--custom"}, set("cnfsv")),
}
# The two image programs that end with the stop (rule 3b).
IMAGE_PROGRAMS = {"teams-lite-container", "teams-lite-intune-selftest"}
# The launcher, and the backend: by a name that is teams-lite`s only inside the install, and at
# the two paths that are teams-lite`s anywhere — the image`s own copy, and the one the launcher
# unpacks to ~/.cache/teams-lite/server.
LAUNCHERS = {"teams", "teams-bin"}
TEAMS_LITE_BACKEND = re.compile(r"(^|/)(lib|\.cache)/teams-lite/server$")
PROC_EXE = re.compile(r"/proc/[0-9]+/exe")

def words(text, operators=";&|"):
    """The words of one command, quotes resolved; the operators as words of their own."""
    try:
        lexer = shlex.shlex(text, posix=True, punctuation_chars=operators)
        lexer.whitespace_split = True
        return list(lexer), False
    except ValueError:
        # A piece of the raw line can hold half a quote: read it loosely, quotes taken off.
        return [w.strip("\"\x27") for w in text.split()], True

def commands(ws):
    out, current = [], []
    for w in ws:
        if w and set(w) <= set(";&|()"):
            out.append(current)
            current = []
        else:
            current.append(w)
    out.append(current)
    return [c for c in out if c]

def clean(word):
    """A program word as the shell runs it: what an open `(` or backtick, or a closing one, wraps."""
    return re.sub(r"[)`]+$", "", re.sub(r"^.*[`(]", "", word))

def is_signal_zero(value):
    return value is not None and value.upper().lstrip("-") in ("0", "SIG0")

# `fed`: the program is run by xargs, which hands it what it reads as more arguments.
def sends_a_signal(program, args, fed):
    if program == "kill":
        signal, pids, options, i = None, [], True, 0
        while i < len(args):
            a = args[i]
            i += 1
            if options and a == "--":
                options = False
            elif options and a in ("-l", "-L", "--list", "--table", "--help", "--version", "-V"):
                return False
            elif options and a in ("-s", "-n", "--signal"):
                signal = args[i] if i < len(args) else None
                i += 1
            elif options and a.startswith("--signal="):
                signal = a.split("=", 1)[1]
            elif options and a in ("-q", "--queue"):
                i += 1
            elif options and a == "--timeout":
                i += 2
            elif options and a in ("-a", "--all", "-p", "--pid", "--verbose", "-r", "--require-handler"):
                pass
            elif options and a.startswith("-") and len(a) > 1 and signal is None:
                signal = a[1:]
            else:
                options = False
                pids.append(a)
        return (bool(pids) or fed) and not is_signal_zero(signal)
    exempt = {"--help", "-V", "--version"} | ({"-l", "--list", "-L", "--table"} if program != "pkill" else set())
    if any(a in exempt for a in args):
        return False
    for k, a in enumerate(args):
        if a == "-0" or a == "--signal=0":
            return False
        if a in ("--signal",) + (("-s",) if program == "killall" else ()) and k + 1 < len(args) and is_signal_zero(args[k + 1]):
            return False
    return bool(args) or fed

def script_words(text):
    """A shell script: its newlines end a command, as its `;` does."""
    return words(text.replace("\n", ";"))[0]

def shell_script(args, loose):
    """The script a shell is handed with -c (su: --command), or None."""
    for k, a in enumerate(args):
        if a.startswith("--command="):
            return script_words(a.split("=", 1)[1])
        if a == "--command" or (a.startswith("-") and not a.startswith("--") and "c" in a[1:]):
            if k + 1 >= len(args):
                return None
            return args[k + 1:] if loose else script_words(args[k + 1])
    return None

def shell_operand(args):
    """Where the script FILE a shell runs stands among its words, or None (-s and -i read none)."""
    k = 0
    while k < len(args):
        a = args[k]
        if a == "--":
            return k + 1 if k + 1 < len(args) else None
        if a in SHELL_VALUES:
            k += 2
        elif a[:1] in ("-", "+") and len(a) > 1:
            if not a.startswith("--") and ("s" in a[1:] or "i" in a[1:]):
                return None
            k += 1
        else:
            return k
    return None

def options_of(args):
    """The words before a command`s `--` (all of them when it has none)."""
    return args[:args.index("--")] if "--" in args else args

def runs(ws, loose, depth=0):
    """Every program the words run, as (path, its arguments, fed by xargs)."""
    if depth >= 6:
        return
    for c in commands(ws):
        yield from command_runs(c, loose, depth)

def command_runs(ws, loose, depth):
    i, fed = 0, False
    while i < len(ws):
        w = clean(ws[i])
        program = os.path.basename(w)
        if not w or ASSIGNMENT.match(w):
            i += 1
        elif program in SIGNALLERS:
            yield w, ws[i + 1:], fed
            return
        elif program in SHELLS:
            rest = ws[i + 1:]
            script = shell_script(rest, loose)
            if script is not None:
                yield from runs(script, loose, depth + 1)
            elif program != "su":
                k = shell_operand(rest)
                if k is not None:
                    yield clean(rest[k]), rest[k + 1:], fed
            return
        elif program in SOURCERS:
            if i + 1 < len(ws):
                yield clean(ws[i + 1]), ws[i + 2:], fed
            return
        elif program == "command" and any(
                a.startswith("-") and not a.startswith("--") and ("v" in a or "V" in a) for a in options_of(ws[i + 1:])):
            # `command -v x` says where x is, and runs nothing.
            return
        elif program == "runuser" and not any(
                a in ("-u", "--user") or a.startswith("--user=") for a in options_of(ws[i + 1:])):
            # The su form: a USER, then what a shell is handed with -c.
            script = shell_script(ws[i + 1:], loose)
            if script is not None:
                yield from runs(script, loose, depth + 1)
            return
        elif program in WRAPPERS:
            takes_a_value, positionals = WRAPPERS[program]
            fed = fed or program == "xargs"
            i += 1
            while i < len(ws) and ws[i].startswith("-") and ws[i] != "-":
                i += 2 if ws[i] in takes_a_value else 1
            i += positionals
        else:
            yield w, ws[i + 1:], fed
            return

def target_and_command(cli, ws):
    """The words after the verb -> the container (service, pod) it names, and its command."""
    long_values, short_values = VERB_OPTIONS[cli]
    kube = cli.startswith("kube")
    if kube and "--" in ws:
        cut = ws.index("--")
        ws, command = ws[:cut], ws[cut + 1:]
    else:
        command = None
    i, target = 0, None
    while i < len(ws):
        w = ws[i]
        if w.startswith("--"):
            i += 1 if "=" in w or w not in long_values else 2
        elif w.startswith("-") and len(w) > 1:
            letters = w[1:]
            hit = next((k for k, c in enumerate(letters) if c in short_values), None)
            i += 2 if hit == len(letters) - 1 else 1
        else:
            target = w
            i += 1
            # A target the shell computes runs to its own closing paren or backtick.
            while (target.count("$(") > target.count(")") or target.count("`") % 2) and i < len(ws):
                target += " " + ws[i]
                i += 1
            break
    if command is None:
        command = ws[i:]
        while kube and command and command[0].startswith("-"):
            command = command[1:]
    return target, command

def names_the_install(cli, target):
    if target is None:
        return False
    if COMPUTED.search(target):
        return True
    if cli.startswith("kube"):
        name = target.split("/", 1)[1] if "/" in target else target
        return re.fullmatch(r"([A-Za-z0-9.-]+-)?teams-lite(-[0-9]+|-headless)?", name) is not None
    return target.lstrip("/") == "teams-lite"

def program_at(ws):
    """Where the program of a command stands: past its assignments and wrappers."""
    i = 0
    while i < len(ws):
        w = re.sub(r"^.*[`(]", "", ws[i])
        program = os.path.basename(w)
        if not w or ASSIGNMENT.match(w):
            i += 1
        elif program in WRAPPERS and program not in ("xargs", "busybox"):
            takes_a_value, positionals = WRAPPERS[program]
            i += 1
            while i < len(ws) and ws[i].startswith("-") and ws[i] != "-":
                i += 2 if ws[i] in takes_a_value else 1
            i += positionals
        else:
            return i
    return None

def first(c, start, verbs):
    return next((k for k in range(start, len(c)) if c[k] in verbs), None)

def pid_namespaces(ws):
    """Every value a `--pid` flag is given among these words."""
    for k, w in enumerate(ws):
        if w.startswith("--pid="):
            yield w.split("=", 1)[1]
        elif w == "--pid" and k + 1 < len(ws):
            yield ws[k + 1]

def verdicts(ws, loose, found):
    for c in commands(ws):
        p = program_at(c)
        if p is None or os.path.basename(clean(c[p])) not in CLIS:
            continue
        verb = first(c, p + 1, ("exec", "run", "create", "debug"))
        if verb is None:
            continue
        before = {os.path.basename(clean(w)) for w in c[p:verb]}
        if before & {"kubectl", "oc"}:
            cli = "kube"
        elif "compose" in before or before & {"docker-compose", "podman-compose"}:
            cli = "compose"
        elif before & {"docker", "podman", "nerdctl"}:
            cli = "engine"
        else:
            continue
        executes = first(c, p + 1, ("exec",))
        if executes is not None:
            target, command = target_and_command(cli, c[executes + 1:])
            install = names_the_install(cli, target)
            for path, args, fed in runs(command, loose):
                name = os.path.basename(path)
                if name in IMAGE_PROGRAMS:
                    found.add("image-program")
                if TEAMS_LITE_BACKEND.search(path) or (
                        install and (name in LAUNCHERS or name == "server" or PROC_EXE.fullmatch(path))):
                    found.add("stack")
                if install and name in SIGNALLERS and sends_a_signal(name, args, fed):
                    found.add("signal")
        # Another container in the install`s pid namespace: a run or a create told to share it,
        # anywhere after the verb (a word after the image is an argument rather than a flag, and
        # is refused all the same: it costs a refusal, never a pass).
        joins = first(c, p + 1, ("run", "create"))
        if cli == "engine" and joins is not None:
            for value in pid_namespaces(c[joins + 1:]):
                if value.startswith("container:") and names_the_install("engine", value[len("container:"):]):
                    found.add("joins")
        # …and an ephemeral container aimed at one of its containers` namespaces.
        debugs = first(c, p + 1, ("debug",))
        if cli == "kube" and debugs is not None:
            rest = c[debugs + 1:]
            options = rest[:rest.index("--")] if "--" in rest else rest
            if any(w == "--target" or w.startswith("--target=") for w in options):
                target, _ = target_and_command("kube-debug", rest)
                if names_the_install("kube", target):
                    found.add("joins")

def readings(line):
    """The line cut as the raw reading cuts it, and the line lexed whole."""
    for piece in re.split(r"[;&|\n]", line):
        if piece.strip():
            yield words(piece)
    whole, loose = words(line, ";&|()")
    if not loose:
        yield whole, False

line = sys.stdin.read()
found = set()
try:
    for ws, loose in readings(line):
        verdicts(ws, loose, found)
except Exception:
    # The narrow answer: every verdict whose own word is on the line.
    found = set()
    if re.search(r"(^|[^A-Za-z0-9_-])(p?kill|killall|skill)([^A-Za-z0-9_-]|$)", line):
        found.add("signal")
    if re.search(r"teams-lite-(container|intune-selftest)", line):
        found.add("image-program")
    if re.search(r"(^|[^A-Za-z0-9_.-])(teams(-bin)?|server|exe)([^A-Za-z0-9_.-]|$)", line):
        found.add("stack")
    if re.search(r"--pid|--target", line):
        found.add("joins")
print(" ".join(sorted(found)))
' 2>/dev/null)"
}
# $1 is a verdict: `image-program`, `stack`, `signal` or `joins`. Called in the current shell —
# never in a `$( … )` — so the one parse is kept for every rule that asks after it.
inside_a_container() {
  [ "$container_verdicts_read" = 1 ] || read_container_verdicts
  case " $container_verdicts " in *" $1 "*) return 0 ;; esac
  return 1
}

# --- 3b. the Intune container is the user's sign-in, not a toy ------------------
# `intune-container stop` takes the identity broker down, and with it every token the
# backend holds: the app goes empty for whoever is using it, on a phone included. A restart
# is also how the login keyring gets unlocked, so it is a real remedy — which is exactly why
# it belongs to the user, or to the repair the app's own Repair sign-in button asks for (and
# the backend asks for on its own when it finds the keyring locked), behind a machine-wide
# floor of three automatic repairs an hour (`start_broker_repair` in src/bin/server.rs).
#
# It sits ABOVE rule 3 on purpose. `target/release/server __teams-lite-repair-broker` is also
# a backend binary started without TEAMS_LITE_READ_ONLY=1, and the first rule that matches is
# the one whose sentence the reader gets: rule 3's would tell them to add the variable, which
# changes nothing about a repair — this one says what the command really does.
#
# SEVEN SPELLINGS, because the repair stopped being a host command, the container stopped
# being something only its own CLI could reach (src/intune.rs links the crate), and the image
# now RUNS one of its own (src/intune_embedded.rs: in the self-contained mode, teams-lite boots,
# stops, repairs and enrolls the Intune container inside its own container, with no systemd —
# through three more hidden arguments of the same binary). Each is matched
# at a command position (see the header), so behind a wrapper, a shell, a subshell or a
# substitution too, and each verb or argument ends at whitespace or at anything that ends a
# command (`ends_a_word`) — `intune-container restart; echo ok` is the same restart.
#
# - THE CLI'S OWN VERBS. Every one that stops, starts or rebuilds the container, read off the
#   crate's `main.rs` at the pinned commit: `update` swaps the rootfs under a stopped
#   container and `restore` writes enrollment state over one; `backup` stops the container for
#   a consistent archive and boots it again; `detach-display`, `login`, `screen` and `edge`
#   attach or drop a display, which is a restart; `autostart enable|disable` starts or stops
#   it as it installs or removes its unit. `update --check` downloads nothing, and is refused
#   with the rest all the same: telling it apart takes a per-segment parse this rule does not
#   do, and the question it answers is not one this app asks. The same verbs handed to
#   `systemd-run` are the same acts with a unit name around them — an agent that has just read
#   that the repair runs as a transient unit reaches for exactly that spelling.
# - THE CONTAINER'S SYSTEMD UNIT, AND THE REPAIR'S. `intune-container autostart enable`
#   installs `intune-container.service`, and a `systemctl --user restart` of it is that same
#   restart spelled through systemd — rule 3a's argument, about a unit rule 3a does not name
#   (`enable` and `disable` are `autostart` spelled the same way). STOP, KILL and FREEZE are in
#   the list here, unlike in 3a: stopping teams-lite is cleanup, stopping the container is
#   taking the sign-in down. The repair's own unit — the transient `teams-lite-intune-repair`,
#   and the retired installed `teams-lite-broker-repair` a machine not yet migrated still has —
#   is refused with the same verbs, stop and kill included, for the reason src/intune.rs gives
#   about its own timeout: a repair cut between its stop and its start leaves no container at
#   all, the keyring then reads as not running rather than locked, and nothing automatic
#   brings it back — the Repair button refuses too, and says to run `intune-container start`.
# - A KILL NAMING A HIDDEN ARGUMENT. A process carrying one IS the container's supervisor, a
#   process inside it, or a repair half-way through, so `pkill -f __teams-lite-repair-broker`
#   is the same cut as stopping the repair's unit, and killing the supervisor takes the
#   container down and the crate's guard against booting a second one with it. Unlike every
#   other kill, it is not cleanup; `pgrep` naming the same words still only looks.
# - THE HIDDEN ARGUMENTS. `server`'s `main` routes six before it does anything else
#   (`intune::dispatch_reexec`): `__teams-lite-repair-broker` RESTARTS the container,
#   `__rootless-supervise` / `__rootless-exec` are the crate's own re-exec targets, which BOOT
#   it and run a script INSIDE it, and the image's self-contained mode adds three helpers of
#   its own — `__teams-lite-intune-boot` (init, an enrollment import, a start: on a fresh volume
#   that is a 1.7 GB pull), `__teams-lite-intune-stop` (the poweroff the entrypoint's SIGTERM
#   trap runs) and `__teams-lite-intune-portal` (the Intune portal opened to ENROLL the device).
#   They are refused whatever TEAMS_LITE_READ_ONLY says — the variable is what rule 3 asks for,
#   and none of the six is a backend it would make read-only: the boot, the portal and the
#   repair refuse under it, but the stop and the crate's two never look. Every program that
#   routes them is matched — a `server` at any path (the build output, the staged copy, the
#   released extraction, the image's /usr/local/lib/teams-lite/server, a bare `./server`),
#   `/proc/<pid>/exe` of a running backend, the crate's own CLI — and `cargo run`, which hands
#   `server` whatever follows it.
# - THE SAME ARGUMENTS INSIDE A CONTAINER. In the image the binary is behind `docker|podman exec
#   <container>`, `docker compose … exec <service>` or `kubectl exec <pod> --` — none of which
#   puts `server` at a command position on this line — so a container CLI's `exec`, `run` or
#   `debug` followed anywhere by a hidden argument is the same act, whatever container or pod
#   it names: the act is the argument, and an `exec` reaches any process inside, a `pkill -f
#   __…` included. Two of the image's own programs are refused when an `exec` RUNS them, for the
#   same reason, and both END WITH THE STOP:
#     • the self-test (`teams-lite-intune-selftest`), whose sanctioned shape is a THROWAWAY
#       `docker run --rm` (rule 3d) — inside a running install it acts on that install's own
#       volume;
#     • the image's ENTRYPOINT (`teams-lite-container`, packaging/docker/entrypoint.sh), a second
#       copy of the container's own PID 1 child.
#   In an image built from this checkout neither ever acts: the entrypoint takes a one-copy lock
#   before its first line that does anything (`take_instance_lock`), the self-test takes the same
#   lock, and `stop_intune_container` refuses without it — so a second copy exits 2 and never
#   reaches the stop. The rule stays because THIS HOOK CANNOT SEE WHICH BUILD A CONTAINER RUNS,
#   and in an image built before that lock a second entrypoint's launcher finds the ports taken —
#   or prints its usage, which is why `--help` is no exemption — and exits, and the script takes
#   that exit for the launcher's own end and powers the RUNNING Intune container off on its way
#   out. What is refused is RUNNING either one — the program the exec'd command runs, past its
#   wrappers and into a shell's `-c` script (`inside_a_container image-program`) — so reading
#   either file (`cat`, `ls -l`, `sha256sum`, `grep` of it) runs nothing and stays open, which is
#   how a published image's own copy is checked against packaging/docker/ in the checkout.
# - A TRANSIENT UNIT. The repair runs as a transient unit of the user's manager
#   (`intune::start_repair_unit`), so `systemd-run … server __teams-lite-repair-broker` is the
#   same repair without the app, and a raw `StartTransientUnit` is the call the backend itself
#   makes. That one is refused for ANY unit: a transient unit is a program the user's manager
#   runs with the manager's environment, its command is a property blob no pattern here can
#   read, and nothing an agent does needs one.
# - RAW D-BUS on the container's unit or the repair's: the `busctl`/`gdbus`/`dbus-send`
#   spelling of the systemctl verbs above (see `raw_dbus_call`), by name or by escaped path.
#
# Looking is free: `status`, `doctor`, `--help`, `autostart status` and `backup-inspect`
# answer the questions an agent actually has, and so do `cargo run --example intune_status`,
# `teams-lite-intune-status` exec'd inside the image, `systemctl --user status` on either unit
# and `pgrep`. A search, a commit message or a doc
# line that NAMES a verb, an argument or a method puts it at no command position and stays
# allowed — a backticked or parenthesized one in a quoted message included, because the
# executable view reads quoted text as text.
container_verb='(stop|start|restart|enroll|init|destroy|edge|update|restore|backup|detach-display|login|screen|autostart[[:space:]]+(enable|disable))'
unit_verb='(start|stop|restart|try-restart|reload-or-restart|try-reload-or-restart|condrestart|force-reload|kill|freeze)'
the_container="intune-container[\"']?([[:space:]]+[^;&|]*)?[[:space:]]${container_verb}${ends_a_word}"
cycles_the_container="${at_a_program}${the_container}"
cycles_the_container_in_a_unit="${at_a_program}systemd-run([[:space:]][^;&|]*)?[[:space:]][\"']?${a_program_path}${the_container}"
cycles_the_container_unit="${at_a_program}systemctl[^;&|]*[[:space:]](${unit_verb}|enable|disable)([[:space:]][^;&|]*)?intune-container"
cycles_the_repair_unit="${at_a_program}systemctl[^;&|]*[[:space:]]${unit_verb}([[:space:]][^;&|]*)?teams-lite-(intune|broker)-repair"
hidden_subcommand='(__teams-lite-repair-broker|__teams-lite-intune-(boot|stop|portal)|__rootless-supervise|__rootless-exec)'
hidden_argument="[[:space:]][\"']?${hidden_subcommand}${ends_a_word}"
runs_a_hidden_subcommand="${at_command_start}${by_a_shell}([A-Za-z0-9_./~\${}\"'-]*/)?(server|exe|intune-container)[\"']?([[:space:]][^;&|]*)?${hidden_argument}"
cargo_runs_a_hidden_subcommand="${at_a_program}cargo([[:space:]][^;&|]*)?[[:space:]](run|r)[[:space:]]([^;&|]*)?${hidden_argument}"
a_unit_runs_a_hidden_subcommand="${at_a_program}systemd-run([[:space:]][^;&|]*)?${hidden_argument}"
kills_a_hidden_subcommand="${at_a_program}(p?kill|killall)([[:space:]][^;&|]*)?(teams-lite-repair-broker|teams-lite-intune-(boot|stop|portal)|rootless-(supervise|exec))"
# Inside a container: an `exec`, a `run` or a `debug` reaching a hidden argument. (An `exec`
# RUNNING the self-test or the entrypoint is read by `inside_a_container`, below; a `run` of
# either as the image's own program is rule 3d's.)
in_a_container_cli="${at_a_named_program}(${container_cli}|${compose_cli}|${kube_cli})"
execs_a_hidden_subcommand="${in_a_container_cli}([[:space:]][^;&|]*)?[[:space:]]exec([[:space:]][^;&|]*)?${hidden_argument}"
runs_a_hidden_subcommand_in_a_container="${in_a_container_cli}([[:space:]][^;&|]*)?[[:space:]](run|debug)([[:space:]][^;&|]*)?${hidden_argument}"
starts_a_transient_unit="${raw_dbus_call}StartTransientUnit"
dbus_cycles_a_unit='(StartUnit|RestartUnit|StopUnit|KillUnit|FreezeUnit|EnqueueUnitJob|systemd1\.Unit[.[:space:]]+(Start|Restart|TryRestart|ReloadOrRestart|ReloadOrTryRestart|Stop|Kill|Freeze)([[:space:]]|$))'
container_or_repair_unit='(intune|broker(-|_2d)repair)'
cycles_the_container_over_dbus="${raw_dbus_call}(${dbus_cycles_a_unit}[^;&|]*${container_or_repair_unit}|${container_or_repair_unit}[^;&|]*${dbus_cycles_a_unit})"
# An exec RUNNING one of the two image programs that end with the stop. Asked only on a line that
# names one of them, because the answer is a parse of its own.
an_image_program_runs_in_a_container() {
  printf '%s' "$command_line" | grep -qE 'teams-lite-(container|intune-selftest)' || return 1
  inside_a_container image-program
}
if ! searching_text && {
  a_command_matches "$cycles_the_container|$cycles_the_container_in_a_unit|$cycles_the_container_unit|$cycles_the_repair_unit|$kills_a_hidden_subcommand|$runs_a_hidden_subcommand|$cargo_runs_a_hidden_subcommand|$a_unit_runs_a_hidden_subcommand|$execs_a_hidden_subcommand|$runs_a_hidden_subcommand_in_a_container|$starts_a_transient_unit|$cycles_the_container_over_dbus" ||
    an_image_program_runs_in_a_container
}; then
  block "The Intune container is the user's sign-in. Stopping, restarting, rebuilding or booting
it takes the identity broker down, so teams-lite goes empty for whoever is looking at it —
including a phone on the tailnet — for about a minute.

This rule refuses it in the spellings it knows, not only its own CLI's verbs (directly, behind
a wrapper such as timeout or setsid, or through systemd-run): the container's systemd unit and
the broker repair's (start, stop, kill or freeze, over systemctl or raw D-Bus); a kill that
names one of the hidden arguments; the hidden arguments themselves, which turn teams-lite's own
binary into the container's supervisor (__rootless-supervise), a process inside it
(__rootless-exec), the broker repair (__teams-lite-repair-broker) or — in teams-lite's
container image, which runs an Intune container of its own — the helper that boots it
(__teams-lite-intune-boot), stops it (__teams-lite-intune-stop) or opens its portal to enroll
the device (__teams-lite-intune-portal), whatever TEAMS_LITE_READ_ONLY says; the same arguments
reached inside a container through docker|podman exec, docker compose exec or kubectl exec; the
two image programs that end by powering an Intune container off, RUN inside a container through
such an exec — the self-test (teams-lite-intune-selftest) and the image's own entrypoint
(teams-lite-container); and any transient unit asked for over raw D-Bus (StartTransientUnit),
which is how the host's repair runs. Stopping a repair half-way through is the worst of them: it
can leave no container at all, and nothing automatic restarts one.

About those two programs: in an image built from this checkout a second copy of either is
refused by the entrypoint's own one-copy lock before it does anything, and never reaches the
stop. They are refused anyway because this hook cannot see which build a container runs: in an
image built before that lock, a second copy can power the RUNNING Intune container off on its
way out — the entrypoint does, at once and even for --help. Reading either file (cat, ls -l,
sha256sum, grep) runs nothing and stays open.

Diagnose it freely — these only read:

  cargo run --example intune_status     # the broker's bus, whether a repair is available,
                                        # and whether the login keyring is locked
  intune-container status
  intune-container doctor
  docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status
  kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status
  docker exec teams-lite sha256sum /usr/local/bin/teams-lite-container

A restart IS the remedy when that keyring re-locked, but it is not yours to run. The app's own
Repair sign-in button asks for it, and the backend asks on its own when it finds the keyring
locked — at most three automatic repairs an hour across every backend on the machine. In the
image's self-contained mode the backend also boots its own container on start and again when it
finds it down, and the app's own Enroll button opens the portal. Ask the user to press the
button, or to run:

  intune-container stop && intune-container start"
fi

# --- 3b-ii. the RETIRED repair scripts still act where a staged copy remains -----
# `teams-lite-broker-check.sh` and `teams-lite-broker-bus-check.sh` are gone from bin/: the
# backend now finds the broker's bus and reads the keyring itself (src/intune.rs, and
# `cargo run --example intune_status` for a person). But a machine staged before that change
# keeps its copies beside the binary — and the units their `--repair` starts — until
# bin/teams-lite-service.sh retires them on its next `install`, `update`, `units` or
# `uninstall`. That is a real window rather than a theoretical one: the automatic update runs
# only from a clean master and only while a unit is active, so a machine whose service is
# stopped keeps both for as long as nobody stages it.
#
# Inside that window `--repair` still does what it always did, and neither act is one this
# hook lets tooling take: the keyring check starts the retired teams-lite-broker-repair.service,
# which stops and starts the container; the bus check starts teams-lite-backend-restart.service,
# which try-restarts both send-capable backends — the socket drops under whoever is reading the
# app, every open page's write token dies with the process, and a live @claude run is cut off.
#
# So one narrow rule is kept for those two names, and it costs a regex. Without the flag either
# script only reads and is left alone, and so is prose that names it: the pattern is anchored to
# a command position like the other program rules here. It can be deleted once no machine
# holds a staged copy — a day this hook cannot see, which is why it is not tied to one.
runs_a_retired_repair="${at_a_program}teams-lite-broker-(bus-)?check\.sh[^;&|]*--repair"
if ! searching_text && a_command_matches "$runs_a_retired_repair"; then
  block "That script is RETIRED — the backend finds the broker's bus and checks the keyring itself
now (src/intune.rs) — but a copy staged before that change still acts on --repair:

  teams-lite-broker-check.sh --repair       starts the retired teams-lite-broker-repair.service,
                                            which restarts the Intune container
  teams-lite-broker-bus-check.sh --repair   starts teams-lite-backend-restart.service, which
                                            restarts both send-capable backends, drops every
                                            open page's socket and cuts off a live @claude run

bin/teams-lite-service.sh removes both, and their units, on its next install or update.

Read the state instead — this only looks:

  cargo run --example intune_status

The repair itself is the app's own Repair sign-in button; ask the user to press it."
fi

# --- 3. the backend an agent starts must be read-only ------------------------
# The binary and the launcher scripts are matched only where a shell would RUN them — at a
# command position (see the header: after a separator, behind an assignment or a wrapper such
# as `timeout 20`, handed to a shell, or inside a subshell or a substitution). Text that merely
# names one (a commit message, a doc line, `chmod +x` on it, a `--bin server` in prose) starts
# nothing, and a guard that fires on prose is one whose next reader learns to write around it.
# `cargo run --bin server` stays matched anywhere: that spelling does not appear by accident,
# and it is how `watchexec -r -- cargo run --bin server` and the like are caught — the program
# that starts the backend there is not one this file knows.
#
# A KILL OR A PROBE is read out of the line first (`command_line_outside_kills`), so cleanup
# stays allowed — `pkill -f target/release/server`, `kill -9 $(pgrep -f …)`, a chain of them —
# and is never a licence for what follows it: `pkill -f target/release/server;
# target/release/server` is the ordinary restart one-liner, and it started a send-capable
# backend while any kill word anywhere on the line skipped this rule.
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
# The leading path may be spelled with a variable or a tilde (`a_program_path`). Without `$`
# and `~` in it, the staged path only matched when written relative.
#
# It is `at_command_start` plus a shell and the path itself (`at_a_program`), so the prefixes a
# shell accepts are described in ONE place. That matters: the path class holds no `=`, so
# before the shared prefix covered them `TEAMS_NO_IDLE_EXIT=1 target/release/server` matched
# nothing at all and walked straight through the rule it is the clearest example of — and
# `timeout 20 target/release/server` did the same until the wrappers joined it.
backend_binary_path='(target/(debug|release)|teams-lite/service|cache/teams-lite)/server'
runs_the_backend_binary="${at_a_program}${backend_binary_path}${ends_a_word}"
# The ways of EXECUTING a launcher it knows all match, including through an interpreter
# (`bash bin/teams-dev-server.sh`, `bash -x …`). `bash -n` is a syntax check and is exempted
# by `inspecting_a_file`.
#
# `teams-lite-backend.sh` is RETIRED — the backend unit execs the binary with no wrapper now,
# because the backend finds the broker's bus itself (src/intune.rs) — and it stays in the list
# for the reason rule 3b-ii keeps its two scripts: a machine staged before that change still
# has the copy beside the binary until bin/teams-lite-service.sh retires it, and running it
# starts the same send-capable backend it always did.
runs_a_backend_launcher="${at_a_program}teams-(dev-server|lite-backend)\.sh${ends_a_word}"
#
# THE SAME PROGRAMS HANDED TO `systemd-run` are a transient unit of the user's manager: a
# backend that outlives this shell, under a unit name nothing else here knows — and one whose
# environment is NOT this shell's. A transient SERVICE runs in a clean environment with the
# manager as its parent (systemd-run(1)): `TEAMS_LITE_READ_ONLY=1 systemd-run --user
# target/release/server` sets the variable for systemd-run alone, and the unit starts
# send-capable on 19420. So the variable anywhere on the line proves nothing here. The unit is
# read-only only when systemd-run is TOLD so, in the same command and before the program:
# `-E TEAMS_LITE_READ_ONLY=1` (or `--setenv=`), `-E TEAMS_LITE_READ_ONLY` with the variable set
# in front (`-E NAME` copies it from systemd-run's own environment), or `--scope` with the
# variable in front — a scope is the one shape that does inherit the caller's environment.
backend_in_a_unit="([\"']?${a_program_path}(${backend_binary_path}|teams-(dev-server|lite-backend)\.sh)|${a_program_path}cargo[[:space:]][^;&|]*--bin([[:space:]]+|=)server)${ends_a_word}"
systemd_run_options="systemd-run([[:space:]][^;&|]*)?[[:space:]]"
read_only_setenv="(-E[[:space:]]*|--setenv([[:space:]]+|=))[\"']?TEAMS_LITE_READ_ONLY"
before_the_program="[[:space:]]([^;&|]*[[:space:]])?${backend_in_a_unit}"
runs_the_backend_in_a_unit="${at_a_program}${systemd_run_options}${backend_in_a_unit}"
unit_states_read_only="${systemd_run_options}${read_only_setenv}=1[\"']?${before_the_program}"
unit_copies_read_only="TEAMS_LITE_READ_ONLY=1[[:space:]][^;&|]*${systemd_run_options}${read_only_setenv}[\"']?${before_the_program}"
scope_inherits_read_only="TEAMS_LITE_READ_ONLY=1[[:space:]][^;&|]*${systemd_run_options}--scope${before_the_program}"
# Per COMMAND, because the proof has to sit in the very systemd-run it is about: one unit
# told it is read-only says nothing about a second one on the same line. $1 is the text, $2 the
# unit pattern and $3 the proof, each already in the form that text is read with.
a_unit_lacks_its_proof() {
  local units
  units="$(printf '%s\n' "$1" | tr ';&|' '\n\n\n' | grep -E "$2")" || return 1
  printf '%s\n' "$units" | grep -vE "$3" >/dev/null
}
starts_a_send_capable_unit() {
  local proof="$unit_states_read_only|$unit_copies_read_only|$scope_inherits_read_only"
  a_unit_lacks_its_proof "$command_line_outside_kills" "$(raw_form "$runs_the_backend_in_a_unit")" \
    "$(raw_form "$proof")" ||
    a_unit_lacks_its_proof "$command_view_outside_kills" "$runs_the_backend_in_a_unit" "$proof"
}
if ! inspecting_a_file && ! searching_text && starts_a_send_capable_unit; then
  block "This hands the backend to systemd-run without making the UNIT read-only. A transient
service does not inherit this shell's environment — systemd starts it clean, with the user's
manager as its parent — so TEAMS_LITE_READ_ONLY=1 written in front of systemd-run sets it for
systemd-run alone, and the unit comes up send-capable on 19420, outliving this shell under a
unit name nothing else watches.

Tell systemd-run, before the program:

  systemd-run --user -E TEAMS_LITE_READ_ONLY=1 target/release/server

or start it from this shell, where the variable does reach it:

  TEAMS_LITE_READ_ONLY=1 cargo run --bin server     # ws on 19430

If you genuinely need a send-capable backend, ask the user to start it themselves."
fi
if ! inspecting_a_file && ! searching_text &&
  a_command_outside_a_kill_matches "cargo run.*--bin server|$runs_a_backend_launcher|$runs_the_backend_binary"; then
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
starts_a_teams_lite_unit="${at_a_program}systemctl[^;&|]*[[:space:]](start|restart|try-restart|reload-or-restart|try-reload-or-restart|condrestart|force-reload|enable)([[:space:]][^;&|]*)?teams-lite"
runs_service_script_start="${at_a_program}teams-lite-service\.sh[[:space:]]+[^;&|]*(start|restart|enable)"
# The same verbs as raw D-Bus calls to the user's manager (see `raw_dbus_call`): the Manager's
# `StartUnit`/`RestartUnit` family and `EnqueueUnitJob`, or the unit object's own `Start`.
# A unit's object path spells its name escaped (`teams_2dlite_2dbackend_2eservice`), so both
# spellings of the name are matched, in either order against the method. `StopUnit` is left
# out for the reason `stop` is above.
dbus_starts_a_unit='(StartUnit|RestartUnit|EnqueueUnitJob|systemd1\.Unit[.[:space:]]+(Start|Restart|TryRestart|ReloadOrRestart|ReloadOrTryRestart)([[:space:]]|$))'
starts_a_teams_lite_unit_over_dbus="${raw_dbus_call}(${dbus_starts_a_unit}[^;&|]*teams(-|_2d)lite|teams(-|_2d)lite[^;&|]*${dbus_starts_a_unit})"
if ! searching_text &&
  a_command_matches "$starts_a_teams_lite_unit|$runs_service_script_start|$starts_a_teams_lite_unit_over_dbus"; then
  block "The always-on teams-lite service is the user's to start. Its backend unit is
send-capable by design — it is their real Teams client, running 24/7 — so a
\`systemctl --user start\` on it is the same act rule 3 refuses, just spelled with
systemd instead of a binary path.

Install and inspect it freely; starting it is the user's call:

  bin/teams-lite-service.sh install     # stage artifacts + write the units (starts nothing)
  bin/teams-lite-service.sh status      # unit state, ports, Intune, tailscale
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
skips_the_agent_wait="${at_a_program}teams-lite-service\.sh[^;&|]*[[:space:]]--now${ends_a_word}"
if ! searching_text && a_command_matches "$skips_the_agent_wait"; then
  block "\`update --now\` skips the wait for a live @claude run. A restart kills the CLI child, so
the reply being written stops mid-sentence and the thread is left with a message that
says the agent is thinking — read by everybody in it.

Run the update without the flag: it waits for the agent, then restarts.

  bin/teams-lite-service.sh update

Only the user may decide a half-written reply is worth losing. If an update must go out
now, say why and let them run it."
fi

# --- 3c. the `teams` command is the whole live stack in one word ----------------
# The third of the "not yours to start" rules, and the widest: `teams` spawns the
# send-capable backend (rule 3) AND serves the real app on the production web port
# (rule 2a), then opens a browser on it. One word, both risks, and no useful
# read-only spelling of it — an agent that needs real data reads a read-only backend,
# and an agent that needs the UI drives the mock. So this one blocks unconditionally.
#
# The spellings that RUN it, as far as this rule knows: the compiled binary wherever it was
# installed (launcher/dist/teams, ~/.teams-lite/bin/teams, a `teams` on the PATH), the repo
# wrapper that runs it from its own directory, and the source entrypoint. `teams-bin`
# is that binary and `teams` is only the wrapper install.sh writes beside it (:57 and
# :85), so `teams-bin` is the name `ps` and TEAMS_LITE_LAUNCHER_BIN give — the spelling
# an agent copies while diagnosing the live app, which is the one place a command line
# is read rather than composed. Anchored to a
# command position like rules 3 and 3a, so prose, `git add launcher/dist/teams` and
# `chmod +x` still run nothing. `teams-lite-service.sh` and friends do not match:
# the name must END there (`ends_a_word`), and a `-lite` does not end one. The entrypoint is
# matched only behind the interpreter that would RUN it — the same shape rule 2a uses
# for web/server.ts — because `git add launcher/src/index.ts` starts nothing. `bun` is
# anchored there for the same reason it is in rule 2a: unanchored, those three letters
# matched inside `stage-bundle.ts`, so a `sed` over a list of files that happened to
# name both was read as a launch.
#
# Like rule 3 it reads the line with every kill and probe taken out, so `pgrep -af teams-bin`
# looks and `pkill -f teams-bin; ~/.teams-lite/bin/teams --no-open` — the restart — does not
# walk past it; and handed to `systemd-run`, `teams` is the same whole stack in a unit that
# outlives this shell, so that spelling is refused too.
runs_the_teams_command="${at_a_program}teams(-bin)?${ends_a_word}"
runs_the_teams_launcher="${at_a_program}teams-launcher\.sh${ends_a_word}"
runs_the_teams_entrypoint="${at_command_start}${by_a_shell}(${a_program_path}/)?bun[^;&|]*(launcher/)?src/index\.ts"
runs_the_teams_command_in_a_unit="${at_a_program}${systemd_run_options}[\"']?${a_program_path}teams(-bin|-launcher\.sh)?${ends_a_word}"
if ! inspecting_a_file && ! searching_text && ! printing_usage &&
  a_command_outside_a_kill_matches "$runs_the_teams_command|$runs_the_teams_launcher|$runs_the_teams_entrypoint|$runs_the_teams_command_in_a_unit"; then
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

# --- 3c-ii. the same stack, exec'd INSIDE teams-lite's container -------------------------------
# Rules 3 and 3c read a command position on THIS line, and an `exec` puts the program behind
# `docker|podman exec <container>`, `docker compose … exec <service>` or `kubectl exec <pod> --`,
# at no command position here — so the launcher (`teams`, /usr/local/bin/teams) or the backend
# (/usr/local/lib/teams-lite/server, or the copy the launcher unpacks to ~/.cache/teams-lite/server)
# exec'd into a running install walked past both. It is their act exactly: an exec inherits the
# container's own environment (TEAMS_LITE_INTUNE_MODE, HOME, TEAMS_WEB_HOST) but not the ports its
# entrypoint chose, so that backend binds the default 19420 in the container's network namespace,
# where nothing holds it, and comes up SEND-CAPABLE — and, run as the image's runtime user (`-u
# teams`, or through `setpriv` as the entrypoint drops to it), signed in through the same identity
# broker as the install itself: in the self-contained mode that user is the one the inner Intune
# container maps to its root. A second calling endpoint rings the user's calls, a second presence
# publisher and a second claimant for every `@claude` run appear, and `teams --no-open` is a whole
# second stack that stays up.
#
# REFUSED WITH ANY ARGUMENTS, `--help` included, and whatever an `-e` on the exec or an `env`
# in front of the program says: the program is read past its wrappers and into a shell's `-c`
# script (`inside_a_container stack`), and nothing tooling needs is started inside the user's live
# install — a read-only look at real data through the image is a THROWAWAY `docker run --rm -e
# TEAMS_LITE_READ_ONLY=1` (rule 3d). The teams-lite paths count in ANY container, because only
# teams-lite's image holds them; a bare `teams` or `server` counts in the install's own container
# (or one the shell computes), because in a container of another name those are somebody else's
# programs. The read-only diagnostic (`teams-lite-intune-status`, and the binary behind it,
# /usr/local/lib/teams-lite/intune-status) is another program and stays open, and so does every
# exec that READS one of these files (`sha256sum /usr/local/lib/teams-lite/server`).
an_exec_starts_the_stack() {
  printf '%s' "$command_line" | grep -qE '(^|[^A-Za-z0-9_.-])(teams(-bin)?|server|exe)([^A-Za-z0-9_.-]|$)' ||
    return 1
  inside_a_container stack
}
if ! searching_text && an_exec_starts_the_stack; then
  block "This starts a second teams-lite INSIDE a container — the launcher (teams) or the backend
binary (/usr/local/lib/teams-lite/server, or the copy the launcher unpacks to
~/.cache/teams-lite/server), run through docker|podman exec, docker compose exec or kubectl exec.
An exec inherits the container's own environment but not the ports its entrypoint chose, so that
backend binds 19420 in the container's network namespace, finds it free, and comes up
SEND-CAPABLE — run as the image's runtime user (-u teams, or through setpriv), signed in through
the same identity broker as the install itself: a second calling endpoint ringing the user's
calls, a second presence publisher, a second claimant for every @claude run — and a
\`teams --no-open\` is a whole second stack that stays up. That is rule 3 and rule 3c's act, in a
container, so it is refused with any arguments and whatever an -e on the exec says. The
teams-lite paths count in any container; a bare teams or server counts in the install's own
(the container teams-lite, its compose service, the chart's pod) or in one the shell computes.

To read real data through the image, run a THROWAWAY container of your own, told it is read-only:

  docker run --rm --name teams-lite-ro -e TEAMS_LITE_READ_ONLY=1 … teams-lite:local

Looking inside stays open — reading those files, and the read-only diagnostic, run nothing:

  docker exec teams-lite sha256sum /usr/local/lib/teams-lite/server /usr/local/bin/teams
  docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status
  kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status"
fi

# --- 3d. teams-lite's container image is the user's to start — and, now, to stop ----------
# The image (packaging/docker/) runs `teams` — rule 3c's whole live stack — so starting it is
# the same act in a fourth spelling, and one rules 3 to 3c cannot see: no binary path on the
# line, no `teams`, no unit. The program is inside the image, and so is its environment.
#
# AND IT RUNS THE USER'S INTUNE CONTAINER NOW. In its default, self-contained mode
# (TEAMS_LITE_INTUNE_MODE=embedded, src/intune_embedded.rs) the image boots an Intune container
# INSIDE itself and keeps that device's enrollment on a volume of its own — so the teams-lite
# container is no longer only the app, it is that install's sign-in. Stopping it is therefore not
# cleanup any more: the entrypoint powers the inner container off on the way down, and the
# install is signed out until the user brings it back — the reason rule 3b refuses
# `intune-container stop` on the host. And two things a container CLI can do to it are
# IRREVERSIBLE: the `intune` volume holds the device's registration (its Workplace Join keys —
# only a NEW enrollment, a second device in the user's organisation, or a backup brings it back),
# and the `data` volume is the store (every message this machine synced, the custom emoji pack,
# the keys sealed chats are read with, and the push key every phone's subscription embeds).
#
# WHAT IS REFUSED. Bringing a teams-lite container up: `docker|podman|nerdctl run|create` of
# the image, `start|restart|unpause` of the container, and a compose `up|start|restart|run|
# create` of its project. What it is is named three ways and any one counts — the image or the
# container by its own name as a whole word (`teams-lite`, `teams-lite:local`, `--name
# teams-lite`), the compose file's directory (`packaging/docker`), or a shell already standing in
# it (`$PWD`), where a bare `docker compose up` finds the file on its own. The image's name may
# carry a REGISTRY in front of it, because CI publishes it (`ghcr.io/theophile-wallez/teams-lite:latest`,
# `…/teams-lite@sha256:…`): a reference names a host and namespaces and never begins with `/`,
# and a tag never holds one, so a path such as `…/worktrees/teams-lite/x` or a bind mount
# `./teams-lite:/data`, which is what `-v` carries, is still not the image.
#
# Taking it DOWN: `stop|kill|rm|remove|pause` of the container named `teams-lite` (a `restart`
# is refused above), and a compose `stop|kill|down|rm|pause` of its project, named the three ways
# above. A container command reaches a container by NAME, so a list the shell COMPUTES (`docker
# stop $(docker ps -q)`, which is every running container) is refused too: this hook cannot see
# whether teams-lite is in it. The verb must be the engine's own subcommand — only global flags
# may stand between `docker` and it — so `docker image rm teams-lite:local` removes an image and
# is left alone.
#
# Destroying what it keeps: a compose `down -v|--volumes` of its project; `docker volume rm` of
# a volume whose name carries `intune` (`intune`, `teams-lite_intune`, under any project name),
# of any volume of the `teams-lite` project (`teams-lite_data` is the store), of `--all`, or of a
# computed list; `docker volume prune`, whatever its filter; and `docker system prune --volumes`
# and `podman system reset`, which take every volume with them. A volume is "unused" — and so
# pruned — the moment its container is gone, which is what a `compose down` leaves.
#
# WHAT STAYS OPEN, because it is how the image is made and diagnosed: `build`, `logs`, `ps`,
# `images`, `inspect`, `config`, `top`, an `image rm`, `exec` into a running one of anything but
# a hidden argument or one of the two image programs that end with the stop (rule 3b), a second
# launcher or backend (rule 3c-ii) or a signal (rule 3d-ii) — reading any of those FILES
# included — and a stop or removal of a container of ANOTHER name, which is
# why tooling's own runs give theirs one (`--name teams-lite-ro`). And THREE ways to RUN the
# image, each of which states its proof in the command itself:
#   • `-e TEAMS_LITE_READ_ONLY=1` (or `--env`) on a `run`, which reaches the CONTAINER — the
#     backend then refuses every write, keeps the read-only 19430 (packaging/docker/
#     entrypoint.sh) and never boots an Intune container. The same variable in front of
#     `docker` sets it for the CLI alone, which is rule 3's systemd-run lesson again, so it
#     proves nothing;
#   • `--entrypoint teams-lite-intune-status`, the read-only diagnostic the image ships;
#   • `--entrypoint teams-lite-intune-selftest`, the image's proof that its self-contained boot
#     works: it boots an Intune container on the image's data directory, says whether the broker
#     came up, and STOPS it. It refuses a non-empty directory itself, and this rule makes sure it
#     is never handed one: a `-v`/`--volume`/`--mount` whose target is that directory, a
#     directory above it or a path inside it, or a `--volumes-from`, voids the proof — because
#     the one thing the self-test must never meet is a live install's enrollment. NOR may it be
#     handed a NETWORK namespace that is not its own (`--network host`, `--net=host`,
#     `--network container:…`, podman's `ns:…`): its Intune container draws on display :99, and
#     an X server's socket there is ABSTRACT — it belongs to the network namespace, so in the
#     host's it is the very :99 the user's own Intune container holds, and in another
#     container's it is that install's. The chart refuses `hostNetwork` beside embedded mode for
#     the same reason. NOR an IPC namespace that is not its own (`--ipc host`, `--ipc=host`,
#     `--ipc container:…`, podman's `ns:…`), for the same reason one layer down: its Intune
#     container binds the outer /dev, /dev/shm included, which is where the identity broker keeps
#     its POSIX semaphores (`sem.OneAuth_*`, the MSAL locks) — and that boot deletes every such
#     lock it finds HELD by no process it can see (`stale_broker_locks_script` in the crate's
#     provision.rs), seeing only its own pid namespace. In the host's /dev/shm a lock the user's
#     OWN broker holds at that moment reads as stale and is deleted, and the self-test's broker
#     then takes locks of the same names; in another container's, it is that install's broker.
# A compose `up`/`start`/`restart` has no proof to offer: its environment is the file's, and
# the file's is send-capable — and a compose `run` has no self-test proof either, because it
# mounts the service's own volumes, the `intune` one among them.
#
# A PROOF IS READ THE WAY THE ENGINE READS ITS FLAGS, and both halves of that closed a spelling
# that walked past the first version (`run_flags`, `runs_only_the_entrypoint`,
# `tells_the_container_read_only`):
#   • ONLY A FLAG IS A PROOF. The engine reads its flags after `run` up to the IMAGE (compose: the
#     service) and hands every word after it to the image's own program, so
#     `docker run teams-lite:local -e TEAMS_LITE_READ_ONLY=1` tells the container nothing and
#     `… teams-lite:local --entrypoint teams-lite-intune-status` runs the real entrypoint with two
#     words of argv. A proof counts only BEFORE the first word that names the image. That cut can
#     only come EARLY — a `--name teams-lite` or an `=teams-lite` names it too — which costs a
#     refusal and never a pass; and tooling's own runs carry a name of their own anyway, since the
#     stop of one named teams-lite is refused.
#   • THE LAST ONE WINS, so a repeat is no proof of anything. Docker and Podman keep the LAST value
#     of a repeated flag: `--entrypoint teams-lite-intune-selftest --entrypoint teams-lite-container`
#     runs the real stack, and `-e TEAMS_LITE_READ_ONLY=1 -e TEAMS_LITE_READ_ONLY=0` a send-capable
#     one. So an entrypoint proves something only as the SOLE `--entrypoint` of the command (a
#     second one anywhere, after the image included, voids it), and the read-only proof stands
#     only while the LAST word anywhere in the command that names TEAMS_LITE_READ_ONLY sets it to
#     1 — in any spelling: `-eTEAMS_LITE_READ_ONLY=0` counts, and so does a bare
#     `-e TEAMS_LITE_READ_ONLY`, which hands the container whatever the CLI's own value is.
image_registry_path='([A-Za-z0-9._-]+(:[0-9]+)?/)*'
# The tag is whatever the shell will put there (`:latest`, `:$TAG`, `:${TAG:-latest}`) — anything
# but a `/`, which is what makes `./teams-lite:/data` a bind mount and never an image.
names_the_image="(^|[[:space:]=\"'])${image_registry_path}teams-lite(:[^[:space:]\"';&|/@]*)?(@[^[:space:]\"';&|/]*)?([[:space:]\"';&|]|\$)"
names_the_project="${names_the_image}|packaging/docker([/[:space:]\"';&|]|\$)"
runs_a_container="${at_a_program}${container_cli}([[:space:]][^;&|]*)?[[:space:]](run|create)${ends_a_word}"
starts_a_container="${at_a_program}${container_cli}([[:space:]][^;&|]*)?[[:space:]](start|restart|unpause)${ends_a_word}"
compose_starts="${at_a_program}${compose_cli}([[:space:]][^;&|]*)?[[:space:]](up|start|restart|create)${ends_a_word}"
compose_runs="${at_a_program}${compose_cli}([[:space:]][^;&|]*)?[[:space:]]run${ends_a_word}"
entrypoint_flag="(^|[[:space:]\"'])--entrypoint([[:space:]]+|=)"
# A run that MENTIONS the self-test as an entrypoint — what it is handed is judged on this, whether
# or not it is the entrypoint the engine keeps.
container_selftest="${entrypoint_flag}[\"']?(/usr/local/bin/)?teams-lite-intune-selftest[\"']?([[:space:]]|\$)"
# A network namespace that is not the run's own: the host's, another container's, or a path to one.
shares_a_network_namespace="(^|[[:space:]])(--network|--net)([[:space:]]+|=)[\"']?(host([[:space:]\"']|\$)|container:|ns:)"
# An IPC namespace — and so a /dev/shm — that is not the run's own, in the same three shapes.
shares_an_ipc_namespace="(^|[[:space:]])--ipc([[:space:]]+|=)[\"']?(host([[:space:]\"']|\$)|container:|ns:)"
# The engine and its GLOBAL flags, and nothing else, before a subcommand: `docker --context x stop`
# is a stop, `docker image rm` is not. A flag that takes its value in the next word is listed by
# name; every other flag is a word of its own.
container_global_flags='([[:space:]]+(--?[A-Za-z][A-Za-z0-9-]*=[^;&|[:space:]]*|(--context|-c|--host|-H|--log-level|-l|--config|--connection|--url)[[:space:]]+[^-;&|[:space:]][^;&|[:space:]]*|--?[A-Za-z][A-Za-z0-9-]*))*'
the_engine="${at_a_named_program}(docker|podman|nerdctl)${container_global_flags}"
stops_a_container="${the_engine}([[:space:]]+container)?[[:space:]]+(stop|kill|rm|remove|pause)${ends_a_word}"
# Compose's own global flags, the same way: `docker compose -f x exec teams-lite rm /tmp/y` runs
# an `rm` inside the container and is not a compose `rm`.
compose_global_flags='([[:space:]]+(--?[A-Za-z][A-Za-z0-9-]*=[^;&|[:space:]]*|(-f|--file|-p|--project-name|--project-directory|--env-file|--profile|--ansi|--progress|--parallel)[[:space:]]+[^-;&|[:space:]][^;&|[:space:]]*|--?[A-Za-z][A-Za-z0-9-]*))*'
compose_stops="${at_a_named_program}${compose_cli}${compose_global_flags}[[:space:]]+(stop|kill|down|rm|pause)${ends_a_word}"
removes_a_volume="${the_engine}[[:space:]]+volume[[:space:]]+(rm|remove)${ends_a_word}"
prunes_the_volumes="${the_engine}[[:space:]]+volume[[:space:]]+prune${ends_a_word}"
prunes_the_system="${the_engine}[[:space:]]+system[[:space:]]+prune${ends_a_word}"
resets_the_system="${the_engine}[[:space:]]+system[[:space:]]+reset${ends_a_word}"
# A list the shell builds while the line runs: what it names is beyond this hook.
computed_list='\$\(|`'
# A volume of teams-lite's: the Intune one under any project name, or any of the compose
# project's own (`teams-lite_<name>`).
names_a_kept_volume="intune|(^|[[:space:]=\"'/,])teams-lite_[A-Za-z0-9_.-]+"
everything_flag_docker="(^|[[:space:]])(-a|--all)([[:space:]=]|\$)"
removes_the_volumes_flag="(^|[[:space:]])(-v|--volumes)(=(true|1))?([[:space:]\"']|\$)"
# The self-test as the block texts hand it out — spelled exactly as its own header, the Dockerfile
# and compose.yaml spell it, so a reader is never sent a second, weaker spelling: a throwaway
# container with the three security options it needs. seccomp and systempaths for the user
# namespace and the /proc it mounts, and apparmor because the default AppArmor profile, where the
# host enforces one, refuses `mount` — without it the run the guard recommends FAILS there.
selftest_command='docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
    --security-opt apparmor=unconfined \
    --entrypoint teams-lite-intune-selftest teams-lite:local'
# Where the self-contained image keeps the device's enrollment (packaging/docker/Dockerfile).
intune_data_dir='/home/teams/.local/share/intune-container'
# Where the shell RUNS the command: the harness says so in the payload, and a hook run by hand
# inherits it as $PWD. Read only when a compose command is on the line, because this hook runs
# before every command and the parse is a process of its own.
shell_directory() {
  local cwd
  cwd="$(printf '%s' "$payload" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("cwd", "") or "")
except Exception:
    pass
' 2>/dev/null || true)"
  printf '%s' "${cwd:-$PWD}"
}
# A COMPOSE command needs to name nothing: standing in the file's directory, or `cd`-ing into it
# earlier on the line, is how a bare `docker compose up` finds the file. So compose is judged by
# the whole line and the directory, and a container command — whose image or name is one of its
# own words — by itself.
compose_project_named() {
  printf '%s' "$command_line" | grep -qE "$names_the_project" && return 0
  case "$(shell_directory)" in */packaging/docker | */packaging/docker/) return 0 ;; esac
  return 1
}
# The commands on this line, one per line, kills and probes taken out, that match ERE $1 — on the
# raw line, and on its executable view, where a subshell's `(`, a `$(` and a backtick are command
# boundaries too, so `(helm install …)` and `x=$(kubectl rollout restart …)` are commands. Fails
# when there is none, which is what its callers test.
commands_matching() {
  local found
  found="$(
    printf '%s\n' "$command_line_outside_kills" | tr ';&|' '\n\n\n' | grep -E "$(raw_form "$1")"
    if [ "$command_view_outside_kills" != "$command_line_outside_kills" ]; then
      printf '%s\n' "$command_view_outside_kills" | tr ';&|' '\n\n\n' | grep -E "$1"
    fi
  )"
  [ -n "$found" ] || return 1
  printf '%s\n' "$found"
}
# $1 is one `docker run`. True when it mounts anything on the image's Intune data directory, on a
# directory above it, or inside it — or borrows another container's volumes, which is how a live
# install's would arrive. A `--tmpfs` is not a mount of anything the user owns, and is left alone.
mounts_the_intune_dir() {
  local spec target
  printf '%s' "$1" | grep -qE -- "(^|[[:space:]])--volumes-from([[:space:]]|=)" && return 0
  while IFS= read -r spec; do
    [ -n "$spec" ] || continue
    spec="${spec#[\"\']}"
    spec="${spec%[\"\']}"
    case "$spec" in
      *target=* | *dst=* | *destination=*)
        target="$(printf '%s' "$spec" | grep -oE '(target|dst|destination)=[^,]*' | head -n 1)"
        target="${target#*=}"
        ;;
      *:*)
        target="${spec#*:}"
        target="${target%%:*}"
        ;;
      *) target="$spec" ;;
    esac
    while [ "${target%/}" != "$target" ]; do target="${target%/}"; done
    case "$target" in
      "" | /home | /home/teams | /home/teams/.local | /home/teams/.local/share | "$intune_data_dir" | "$intune_data_dir"/*) return 0 ;;
    esac
  done <<<"$(printf '%s' "$1" | grep -oE -- "(^|[[:space:]])(-v|--volume|--mount)([[:space:]]+|=)[\"']?[^[:space:]\"']+" |
    sed -E "s/^[[:space:]]*(-v|--volume|--mount)([[:space:]]+|=)//")"
  return 1
}
# $1 is one `run` (or `create`). The engine's OWN flags: the words after that verb, up to the first
# one that names the image — for compose, the service, which is a word of the same shape.
run_flags() {
  printf '%s' "$1" |
    awk '{ for (i = 1; i <= NF; i++) if ($i == "run" || $i == "create") { for (j = i + 1; j <= NF; j++) printf "%s ", $j; exit } }' |
    sed -E "s#${names_the_image}.*##"
}
# $1 is one run, $2 the name of an image program. True when that program is the run's SOLE
# `--entrypoint`, among the engine's own flags.
runs_only_the_entrypoint() {
  local count
  count="$(printf '%s' "$1" | grep -oE -- "$entrypoint_flag" | wc -l)"
  [ "$count" -eq 1 ] || return 1
  run_flags "$1" | grep -qE -- "${entrypoint_flag}[\"']?(/usr/local/bin/)?$2[\"']?([[:space:]]|\$)"
}
# $1 is one run. True when an `-e`/`--env` flag tells the CONTAINER it is read-only, and nothing
# later in the command says otherwise.
tells_the_container_read_only() {
  local last
  run_flags "$1" |
    grep -qE -- "(^|[[:space:]])(-e|--env)([[:space:]]+|=)[\"']?TEAMS_LITE_READ_ONLY=1[\"']?([[:space:]]|\$)" || return 1
  last="$(printf '%s' "$1" | grep -oE "TEAMS_LITE_READ_ONLY(=[^[:space:]\"']*)?" | tail -n 1)"
  [ "$last" = "TEAMS_LITE_READ_ONLY=1" ]
}
# $1 is one run. True when it states it only READS: the container told it is read-only, or the
# read-only diagnostic as its sole entrypoint. (The self-test is a proof of its own, read where
# what it is handed is judged.)
states_it_only_reads() {
  tells_the_container_read_only "$1" || runs_only_the_entrypoint "$1" 'teams-lite-intune-status'
}
# The self-test, handed something that could be the user's enrollment.
a_selftest_meets_an_enrollment() {
  local one
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$names_the_image" || continue
    printf '%s' "$one" | grep -qE -- "$container_selftest" || continue
    mounts_the_intune_dir "$one" && return 0
  done <<<"$(commands_matching "$runs_a_container")"
  return 1
}
# The self-test, in a namespace that is not its own: $1 is the pattern for it — a network one,
# where its display :99 is somebody else's, or an IPC one, where its /dev/shm is. A flag written
# after the image is an argument rather than a flag, and is refused all the same: it costs a
# refusal, never a pass.
a_selftest_shares() {
  local one
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$names_the_image" || continue
    printf '%s' "$one" | grep -qE -- "$container_selftest" || continue
    printf '%s' "$one" | grep -qE -- "$1" && return 0
  done <<<"$(commands_matching "$runs_a_container")"
  return 1
}
a_selftest_shares_a_network() {
  a_selftest_shares "$shares_a_network_namespace"
}
a_selftest_shares_ipc() {
  a_selftest_shares "$shares_an_ipc_namespace"
}
# Deleting what the image keeps. The raw commands are what a computed list is read off: the
# executable view cuts a `$(` into a command of its own.
a_teams_lite_volume_is_destroyed() {
  local one
  if compose_project_named; then
    while IFS= read -r one; do
      [ -n "$one" ] || continue
      printf '%s' "$one" | grep -qE "(^|[[:space:]])down([[:space:]]|\$)" || continue
      printf '%s' "$one" | grep -qE -- "$removes_the_volumes_flag" && return 0
    done <<<"$(commands_matching "$compose_stops")"
  fi
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$names_a_kept_volume|$computed_list|$everything_flag_docker" && return 0
  done <<<"$(commands_matching "$removes_a_volume")"
  commands_matching "$prunes_the_volumes" >/dev/null && return 0
  commands_matching "$resets_the_system" >/dev/null && return 0
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE -- "$removes_the_volumes_flag" && return 0
  done <<<"$(commands_matching "$prunes_the_system")"
  return 1
}
# Taking it down: the container by name or in a computed list, or its compose project.
a_teams_lite_container_stops() {
  local one
  if commands_matching "$compose_stops" >/dev/null && compose_project_named; then
    return 0
  fi
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$names_the_image|$computed_list" && return 0
  done <<<"$(commands_matching "$stops_a_container")"
  return 1
}
a_teams_lite_container_starts() {
  local one
  if commands_matching "$compose_starts" >/dev/null && compose_project_named; then
    return 0
  fi
  while IFS= read -r one; do
    [ -n "$one" ] && printf '%s' "$one" | grep -qE "$names_the_image" && return 0
  done <<<"$(commands_matching "$starts_a_container")"
  return 1
}
# Per COMMAND, like rule 3's units: one container told it is read-only says nothing about a
# second one on the same line.
a_teams_lite_container_runs_unproven() {
  local one
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$names_the_image" || continue
    # The self-test is a proof of its own while it is the run's SOLE entrypoint; what it may be
    # HANDED is `a_selftest_meets_an_enrollment`'s and `a_selftest_shares_a_network`'s to
    # decide, and those rules run first — one decision, in one place.
    runs_only_the_entrypoint "$one" 'teams-lite-intune-selftest' && continue
    states_it_only_reads "$one" || return 0
  done <<<"$(commands_matching "$runs_a_container")"
  local compose_runs_here
  compose_runs_here="$(commands_matching "$compose_runs")" || return 1
  compose_project_named || return 1
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    states_it_only_reads "$one" || return 0
  done <<<"$compose_runs_here"
  return 1
}
# Nothing to decide on a line that names no container CLI at all — which is nearly every line.
if printf '%s' "$command_line" | grep -qE '(docker|podman|nerdctl|compose)' &&
  ! inspecting_a_file && ! searching_text && ! printing_usage; then
  if a_teams_lite_volume_is_destroyed; then
    block "This would DELETE what teams-lite's container keeps, and nothing brings it back:

  the intune volume    the device's ENROLLMENT — the Intune container the image runs, and the
                       Workplace Join keys that make it a registered device. Only a NEW
                       enrollment (a second device in the user's organisation) or a backup
                       made on the machine that enrolled restores it.
  the data volume      the store: every message this machine synced, the custom emoji pack, the
                       keys sealed chats are read with, and the push key every phone's
                       subscription embeds — regenerated, it silences all of them.

A \`docker volume prune\`, a \`system prune --volumes\` and a \`podman system reset\` take both
with every other volume nothing uses — and a volume is unused the moment its container is gone.
So is a \`volume rm\` whose names the shell computes: this hook cannot see what is in the list.

Remove what you made yourself, by name (\`docker volume rm my-scratch-volume\`), and give your
own runs volumes of their own. Deleting these is the user's decision alone: ask them."
  fi
  if a_selftest_meets_an_enrollment; then
    block "The self-test boots an Intune container on the image's data directory and STOPS it at the
end, so it is allowed only on a THROWAWAY one — a \`docker run --rm\` with nothing mounted there:

  $selftest_command

This run mounts something on $intune_data_dir (or above it, or inside it), or borrows another
container's volumes — which is how a live install's enrollment would meet a boot and a stop
nobody asked for. The self-test refuses a directory that is not empty on its own; this rule
makes sure it is never handed one."
  fi
  if a_selftest_shares_a_network; then
    block "The self-test boots an Intune container whose Xvfb draws on display :99 — and an X
server's socket there is ABSTRACT: it belongs to the NETWORK namespace, not to the container.
This run hands the self-test a network namespace that is not its own (--network host, --net=host,
--network container:…, or a podman ns: path). In the host's, :99 is the one the user's OWN Intune
container holds; in another container's, it is that install's. The self-test's Xvfb restarts
every second until it wins the name, and a broker that comes up while the self-test holds it has
no display — the served sign-in breaks until the self-test is gone. The chart refuses
hostNetwork beside embedded mode for the same reason.

Run it on a network of its own, which is the default:

  $selftest_command"
  fi
  if a_selftest_shares_ipc; then
    block "The self-test boots an Intune container that binds this container's /dev — /dev/shm
included, which is where the identity broker keeps its POSIX semaphores (sem.OneAuth_*, the
MSAL locks). Its boot deletes every such lock it finds HELD by no process it can see, and it
sees only its own pid namespace. This run hands it an IPC namespace that is not its own
(--ipc host, --ipc=host, --ipc container:…, or a podman ns: path): in the host's, /dev/shm is
the one the user's OWN Intune container's broker locks in; in another container's, it is that
install's. A lock held there at that moment reads as stale and is deleted, and the self-test's
broker then takes locks of the same names — so the other broker loses its mutual exclusion, and
a lock the self-test still holds when it stops leaves that broker's account lookups waiting and
answering empty until its next boot.

Run it with an IPC namespace of its own, which is the default:

  $selftest_command"
  fi
  if a_teams_lite_container_stops; then
    block "Stopping teams-lite's container takes that install's sign-in down. In its default,
self-contained mode the image runs the user's Intune container INSIDE it — the identity broker
and the device's enrollment — so a stop, a kill, a pause, a removal or a compose
stop|kill|down|rm|pause powers that container off with it: every token call fails and the app
goes empty for whoever is reading it, a phone included, until the user brings it back. It is
the host's \`intune-container stop\` (rule 3b) in a container's clothes, so it is theirs:

  docker compose -f packaging/docker/compose.yaml stop

A list the shell computes (\`docker stop \$(docker ps -q)\`) is refused too, because this hook
cannot see whether teams-lite is in it. Your OWN runs are yours to stop: give them a name of
their own and stop that one —

  docker run --rm --name teams-lite-ro -e TEAMS_LITE_READ_ONLY=1 … teams-lite:local
  docker stop teams-lite-ro

Reading it stays open: docker compose -f packaging/docker/compose.yaml logs -f, ps, and
exec teams-lite teams-lite-intune-status."
  fi
  if a_teams_lite_container_starts || a_teams_lite_container_runs_unproven; then
    block "teams-lite's container image runs \`teams\` — a send-capable backend signed in as the
user, and the real app on 127.0.0.1:19443 — and, in its default, self-contained mode, the user's
own Intune container inside it. So bringing it up is the same act rule 3c refuses, in a
container. Starting it is theirs:

  docker compose -f packaging/docker/compose.yaml up -d               # self-contained (default)
  docker compose -f packaging/docker/compose.host-broker.yaml up -d   # the host's broker

Building and reading it stay open:

  docker compose -f packaging/docker/compose.yaml build
  docker compose -f packaging/docker/compose.yaml logs -f
  docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status

and so does the self-test, on a throwaway container with nothing mounted on its Intune data
directory — it boots an Intune container, checks the broker comes up, and stops it:

  $selftest_command

The host-broker diagnostic reads the host's state, read-only, as the host user:

  docker run --rm --pid=host --user \"\$(id -u):\$(id -g)\" -e TEAMS_LITE_INTUNE_MODE=host \\
    --entrypoint teams-lite-intune-status \\
    -v ~/.local/share/intune-container:$intune_data_dir:ro teams-lite:local

To read real data through the image, tell the CONTAINER it is read-only — the backend then
refuses every write, listens on 19430 and boots no Intune container — and give it a name of its
own, so stopping it later is yours:

  docker run --rm --name teams-lite-ro -e TEAMS_LITE_READ_ONLY=1 … teams-lite:local

(TEAMS_LITE_READ_ONLY=1 in front of \`docker\` sets it for the CLI, never for the container.)

A proof is read the way the engine reads its flags: only BEFORE the image (a word after it is
an argument for the image's own program), and only as the last word on its value — so a second
--entrypoint anywhere voids an entrypoint proof, and a later TEAMS_LITE_READ_ONLY of any other
value, in any spelling, voids the read-only one."
  fi
fi

# --- 3d-ii. a SIGNAL sent inside teams-lite's container is a stop of it -----------------------
# Rule 3d refuses `docker stop|kill teams-lite`, and an `exec` reaches the same processes from
# the inside: `docker exec teams-lite kill 1` is that stop by other means, and so is most of what
# a signal can reach in there. In the image's default, self-contained mode every long-lived
# process in that container IS the install —
#   • PID 1 (tini) and the entrypoint it runs (packaging/docker/entrypoint.sh), whose TERM trap
#     powers the Intune container off on the way out. A KILL sent past PID 1 — to the entrypoint,
#     or to every process at once (`kill -9 -1`) — is that same stop WITHOUT the graceful poweroff,
#     the keyring that holds the enrollment SIGKILLed mid-write (PID 1 itself ignores a KILL sent
#     from inside its own namespace; nothing else in there does);
#   • the launcher, whose exit the entrypoint takes for the launcher's own end and answers with
#     the same poweroff;
#   • the backend, in the middle of whatever it was answering (the launcher starts another, and a
#     live `@claude` run is cut off with the old one);
#   • and the Intune container's own systemd, identity broker and keyring — the sign-in itself,
#     visible from the outer container because its pid namespace is nested inside it.
# And in the host-broker shape the container shares the HOST's pid namespace, so `kill 1` there,
# exec'd as root, is a signal to the host's own init.
# So ANY signal sent there is refused, not only one aimed at PID 1: a name list (`tini`, the
# entrypoint, `teams`) would miss a `pkill -f` whose pattern merely matches one of them, which is
# the shape that slips past every rule written by name. Two things send nothing, and stay open:
# signal 0 (`kill -0 1`, which only asks whether the process exists), and a list of signal names
# (`kill -l`).
#
# WHICH CONTAINER, AND WHERE THE SIGNAL IS: the shared parse above (`inside_a_container signal`)
# — the install by its name, its compose service or the chart's pod, or a target the shell
# COMPUTES, which is refused as rule 3d's stop is; and the signal as a PROGRAM the exec runs, read
# past its wrappers (`timeout 5 kill 1`, `busybox kill 1`, `xargs kill`) and into a shell's `-c`
# script (`sh -c 'pgrep x | xargs kill'`), never as a word — `grep kill /etc/x` exec'd into it
# reads a file. A container of ANOTHER name — tooling's own `teams-lite-ro` included — is
# somebody's own to signal, and a PROGRAM that signals on its own (a script that calls kill) is
# beyond it, like a kill by pid of a process this hook cannot name. The parse runs only on a line
# that names a signalling program and an `exec` at all.
if printf '%s' "$command_line" | grep -qE "(^|[^A-Za-z0-9_-])(p?kill|killall|skill)([^A-Za-z0-9_-]|\$)" &&
  printf '%s' "$command_line" | grep -qE "(^|[^A-Za-z0-9_-])exec([^A-Za-z0-9_-]|\$)" &&
  ! inspecting_a_file && ! searching_text && inside_a_container signal; then
  block "This sends a signal to a process INSIDE teams-lite's own container — the one named
teams-lite, its compose service, or the chart's pod. In the image's default, self-contained mode
every long-lived process there IS that install: PID 1 (tini) and the entrypoint behind it, whose
exit powers the Intune container off; the launcher, whose end the entrypoint answers with the
same poweroff; the backend, mid-answer; and the Intune container's own systemd, identity broker
and keyring, which are the sign-in itself. So \`kill 1\`, \`kill -TERM 1\` or a pkill there is
\`docker stop teams-lite\` by other means — and a KILL sent past PID 1 (to the entrypoint, or
\`kill -9 -1\`) is that stop without the graceful poweroff the keyring needs. In the host-broker
shape PID 1 is the HOST's init. Taking it down is the user's (rule 3d).

Looking inside stays open — none of these sends anything (the image ships no ps and no kill
binary; \`docker top\` lists its processes from the host's side):

  docker top teams-lite                 # every process in it, with its pid and command
  docker exec teams-lite cat /proc/1/status
  docker compose -f packaging/docker/compose.yaml exec teams-lite teams-lite-intune-status
  kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status

A container of your OWN (\`docker run --name teams-lite-ro …\`) is yours to signal."
fi

# --- 3d-iii. another container IN the install's pid namespace is inside it ----------------------
# Rule 3d-ii reads a signal an `exec` sends, and a second container can stand in the same place
# without one: `docker run --pid container:teams-lite busybox kill 1` (or `--pid=container:…`, on
# docker, podman or nerdctl, as a `run` or a `create`) and `kubectl debug <the chart's pod>
# --target=<container>` both put a new container INSIDE the install's pid namespace, as root with
# the engine's default capabilities — CAP_KILL among them. Every process of the install is then a
# process of that container: tini, the entrypoint whose exit powers the Intune container off, the
# launcher, the backend, and the Intune container's own systemd, broker and keyring — and in the
# host-broker shape, and in the chart's host modes (`hostPID`), that namespace is the HOST's. So a
# `kill 1` there is `docker stop teams-lite` by other means.
#
# THE JOIN ITSELF IS REFUSED, not only a signal on its command line, because what such a container
# runs is the very thing this hook cannot read: an interactive shell, a script, a program that
# signals on its own — and a container privileged enough to pass the kernel's ptrace check reads
# and writes the install's whole filesystem through /proc/<pid>/root as well, its enrollment
# volume included. Nothing a reader needs takes one: `docker top teams-lite` lists every process
# from the host's side (the image ships no ps), and an `exec` reads /proc in place. Which install:
# the container named `teams-lite`, the chart's pod — or a target the shell COMPUTES
# (`--pid container:$(docker ps -q)`); a container of ANOTHER name is somebody's own to join.
# podman's `--pod` is not matched: a pod shares no pid namespace unless it was created to
# (`--share pid`), and that is said in the hook's own list of what it cannot see.
an_other_container_joins_the_install() {
  printf '%s' "$command_line" | grep -qE -- '--pid|--target' || return 1
  inside_a_container joins
}
if ! searching_text && an_other_container_joins_the_install; then
  block "This puts another container INSIDE teams-lite's own pid namespace — --pid
container:teams-lite on a docker|podman run or create, or kubectl debug --target on the chart's
pod. Every process of that install is then a process of the new container, as root: PID 1 (tini)
and the entrypoint whose exit powers the Intune container off, the launcher, the backend, and the
Intune container's own systemd, broker and keyring — and in the host-broker shape that namespace
is the HOST's. A \`kill 1\` there is \`docker stop teams-lite\` by other means (rule 3d-ii), and
what an interactive shell or a script does there next is beyond this hook, so the join itself is
refused rather than the command it runs. A computed target (--pid container:\$(docker ps -q)) is
refused too.

The image ships no ps or kill, and none is needed to look inside:

  docker top teams-lite                 # every process in it, read from the host's side
  docker exec teams-lite cat /proc/1/status
  docker exec teams-lite ls /proc
  kubectl -n teams-lite exec teams-lite-0 -- cat /proc/1/status

A container of your OWN (--pid container:teams-lite-ro) is yours to join."
fi

# --- 3e. teams-lite on Kubernetes is the user's to start, to stop, and to delete -------------
# The chart (packaging/helm/teams-lite) runs rule 3d's image as a StatefulSet — the whole live
# stack again, in a fifth spelling no rule above can see: the program, its environment and the
# restart are all the cluster's. And the user's kubeconfig names real clusters, so `helm install`
# from here deploys to whichever one is current.
#
# AND IN ITS DEFAULT MODE THE POD IS THE USER'S SIGN-IN (`broker.mode: embedded`): it boots the
# Intune container inside itself and keeps the device's enrollment on a volume claim of its own,
# beside the store's. So, as in rule 3d, a STOP is not cleanup any more — uninstalling the
# release, scaling it to 0 or deleting its StatefulSet powers that container off and signs the
# install out until the user brings it back — and two deletes are IRREVERSIBLE: the chart's
# claims (`data-…teams-lite…`, the store, and `intune-…teams-lite…`, the enrollment), and ANY
# namespace, because deleting a namespace deletes every claim in it, and from here it is a
# namespace of whichever real cluster is current.
#
# WHAT IS REFUSED. Everything that STARTS the pod or RESTARTS it:
#   • `helm install|upgrade|rollback` of the chart or of a release named after it — by the release
#     name, the chart's path, its OCI reference (with or without a `:version` or `@sha256:` digest)
#     or a packaged `.tgz`, or `.` run from the chart's own directory, which the shell may already
#     stand in or the line may `cd` into first; `helm secrets upgrade` and the other plugin wrappers
#     that DEPLOY are the same verb, while `helm diff upgrade|rollback` only reads, and is open;
#   • `helmfile apply|sync|deploy` whose line names the chart or whose helmfile does;
#   • `kubectl apply|create|replace` of it — the rendered manifests piped in (`helm template … |
#     kubectl apply -f -`), the image named on the command (`kubectl create deployment --image=…`),
#     or a LOCAL manifest file or directory (`-f`) whose contents name the image or the chart's
#     labels: rendering to a file and applying it next is the two-step spelling of the one-liner;
#   • `kubectl scale` of it to anything but 0, `rollout restart|undo|resume`, a `delete` of its POD
#     (the StatefulSet makes another at once, so that is a restart and never a stop), and
#     `set image|env|resources`, `patch` or `edit` of its StatefulSet — by name, or by `--all`, a
#     kind with no name, or `-A` in its namespace, since those reach it too;
#   • `kubectl run` of the image without `--env=TEAMS_LITE_READ_ONLY=1`, and a `kubectl debug
#     --copy-to` of its pod — a SECOND copy of the live pod, on the same claims.
# Everything that STOPS it:
#   • `helm uninstall` (or `delete`, `del`, `un`) of a release named after the chart — a release
#     of another name, such as a read-only one tooling installed itself, is its own to remove;
#   • `kubectl scale` of it to 0, a `delete` of its StatefulSet (or of `all` of its kinds), and a
#     `delete -f` of its manifests — by name, `--all`, a nameless kind or `-A`, as above.
# And everything that DELETES what it keeps:
#   • `kubectl delete pvc` of the chart's claims — by name (`data-*teams-lite*`,
#     `intune-*teams-lite*`), by the chart's label, or `--all` / `-A` in ANY namespace, since a
#     claim names no release this hook could check. That is also why a READ-ONLY release's own
#     claims (`data-teams-lite-ro-0`) are refused: every release of this chart names its claims
#     after it, and a few empty claims left behind by `helm uninstall` cost nothing;
#   • `kubectl delete namespace|ns`, of ANY namespace.
# Kinds are read as kubectl reads them — alone, in a comma list (`pod,svc`) or as `kind/name`.
# Named, for kubectl, by `teams-lite` as a word — `statefulset/teams-lite`, `teams-lite-0`, a
# label `=teams-lite` — after the namespace flag's own value is taken out, since the README
# installs into a namespace of that name and `kubectl -n teams-lite logs …` is reading. That same
# namespace value is what makes an `--all` or a nameless kind a command about this workload.
#
# WHAT STAYS OPEN: rendering, packaging and reading (`helm template|lint|show|package|push|status|
# get|history|list|diff`, `kubectl get|describe|logs|exec|top` — an `exec` of anything but a
# hidden argument, which is rule 3b's), a delete of anything that is not the chart's (another
# pod, another workload, another claim), the uninstall of a release of another name, and two
# proofs a command can state about itself: `--dry-run` (nothing is deployed, stopped or
# deleted), and on a `helm install` — never an `upgrade`,
# which RESTARTS a release that exists, and an upgrade to read-only is still a restart of the
# user's live client — `--set readOnly=true` as the LAST word on that value. Helm merges its value
# flags in a fixed order (-f, --set-json, --set, --set-string, --set-file, --set-literal), so a
# `--set-string`, `--set-file` or `--set-literal` whose OWN value names readOnly outranks `--set`
# and voids the proof; a `--set-json` does not, and a values FILE is not read here, so it is never
# one. The chart writes TEAMS_LITE_READ_ONLY=1 after every other variable, so the backend then
# refuses every write and listens on 19430.
#
# AND A PORT-FORWARD IS A DOOR TO THE ACCOUNT. It is reading, and stays open, onto a LOOPBACK port
# the browser guard already knows as live (1942x / 1944x — guard-prod-chat-target.sh): every page
# that door serves is handed the write token, and that guard can only keep a browser from typing
# into the live app when it recognizes the address. `8080:19443` (or `8080:web`, the port's name)
# would be the live app under a port it reads as anything at all, `:19443` a port nobody chose,
# and `--address 0.0.0.0` the account on the LAN — so each of those is refused.
#
# WHAT IT CANNOT SEE, beyond the hook's own list: a manifest applied from a URL or a kustomization
# (`-k`), a helmfile whose file it cannot read, a release named something else and upgraded,
# scaled or uninstalled by that name alone, a claim of such a release deleted by its own name, a
# `kubectl drain` of the node the pod runs on, a delete of the PersistentVolume under a claim
# (held back by its protection finalizer while the claim exists, which is the reason it is not
# matched), and an Ingress, NodePort or LoadBalancer on a hostname or port of the user's own — a
# live front neither guard can recognize as the live app.
kube_verb() {
  printf '%s' "${at_a_named_program}${kube_cli}([[:space:]][^;&|]*)?[[:space:]]$1${ends_a_word}"
}
helm_deploys="${at_a_named_program}helm([[:space:]][^;&|]*)?[[:space:]](install|upgrade|rollback)${ends_a_word}"
helm_uninstalls="${at_a_named_program}helm([[:space:]][^;&|]*)?[[:space:]](uninstall|delete|del|un)${ends_a_word}"
# `helm diff` (a read-only plugin) takes the deploy verbs as its own subcommands.
helm_diffs="${at_a_named_program}helm([[:space:]][^;&|]*)?[[:space:]]diff[[:space:]]"
helmfile_deploys="${at_a_named_program}helmfile([[:space:]][^;&|]*)?[[:space:]](apply|sync|deploy)${ends_a_word}"
kube_applies="$(kube_verb '(apply|create|replace)')"
kube_scales="$(kube_verb scale)"
kube_rolls_out="$(kube_verb 'rollout[[:space:]]+(restart|undo|resume)')"
kube_deletes="$(kube_verb delete)"
kube_respecs="$(kube_verb '(set[[:space:]]+(image|env|resources|serviceaccount)|patch|edit)')"
kube_runs="$(kube_verb run)"
kube_debugs="$(kube_verb debug)"
kube_forwards="$(kube_verb port-forward)"
# The chart, as a chart reference names it: a release, a path whose LAST component is the chart
# (so `…/worktrees/teams-lite/x/values.yaml` is not it), an OCI reference with an optional tag or
# digest, a package, a manifest.
names_the_chart="(^|[[:space:]=\"'/])teams-lite(-[0-9][A-Za-z0-9.+_-]*\.tgz|\.ya?ml)?(:[^[:space:]\"';&|/@]*)?(@[^[:space:]\"';&|/]*)?/?([[:space:]\"';&|]|\$)"
# The workload, as kubectl names it: the StatefulSet, its pod, its Services, a label selector.
names_the_workload="(^|[[:space:]=\"'/])teams-lite(-[0-9]+|-headless)?([[:space:]\"';&|,]|\$)"
# A command about EVERY object of a kind: `--all`, every namespace, or a kind with no name after it
# (only flags, or nothing, follow the statefulset/pod kind).
everything_flag="(^|[[:space:]])(--all|-A|--all-namespaces)([[:space:]=]|\$)"
every_namespace="(^|[[:space:]])(-A|--all-namespaces)([[:space:]=]|\$)"
nameless_statefulset="[[:space:]](statefulsets?(\.apps)?|sts)([[:space:]]+-[^;&|]*)?[[:space:]]*\$"
dry_run="(^|[[:space:]])--dry-run(=(client|server))?([[:space:]\"']|\$)"
replicas_zero="--replicas([[:space:]]+|=)[\"']?0[\"']?([[:space:]]|\$)"
# The chart's own claims: `data-<sts>-0` and `intune-<sts>-0`, where the StatefulSet carries the
# chart's name (`data-teams-lite-0`, `intune-tl-teams-lite-0`).
names_a_chart_claim="(^|[[:space:]=\"'/,])(data|intune)-[A-Za-z0-9.-]*teams-lite[A-Za-z0-9.-]*([[:space:]\"',]|\$)"
# $1 is one command, $2 an ERE of resource kinds. True when the command names one of those kinds —
# alone (`pods`), in a comma list (`pod,svc`), with its group (`statefulsets.apps`) or as
# `kind/name`.
names_a_kind() {
  printf '%s' "$1" | grep -qE "(^|[[:space:],])($2)(\.[A-Za-z0-9.]+)?([[:space:],/]|\$)"
}
# `-n teams-lite` / `--namespace=teams-lite` names a place, not the workload.
without_namespace() {
  sed -E "s/(^|[[:space:]])(-n|--namespace)([[:space:]]+|=)[\"']?[^[:space:]\"']+[\"']?/\\1/g"
}
# $1 is one command. True when its namespace flag says it acts in the chart's own namespace.
in_its_namespace() {
  printf '%s' "$1" | grep -qE "(^|[[:space:]])(-n|--namespace)([[:space:]]+|=)[\"']?teams-lite[\"']?([[:space:]]|\$)"
}
# $1 is one command naming a statefulset or pod kind. True when it reaches the workload without
# naming it: every namespace, or `--all` or a nameless kind in the workload's own namespace.
reaches_it_unnamed() {
  local named
  named="$(printf '%s' "$1" | without_namespace)"
  printf '%s' "$1" | grep -qE "$every_namespace" && return 0
  in_its_namespace "$1" || return 1
  printf '%s' "$named" | grep -qE "$everything_flag" && return 0
  printf '%s' "$named" | grep -qE "$nameless_statefulset"
}
# The chart's own directory: the shell stands in it, or the line `cd`s into a directory of that
# name first — and the helm command's chart is `.`.
helm_in_the_charts_directory() {
  printf '%s' "$1" | grep -qE "[[:space:]]\./?([[:space:]]|\$)" || return 1
  case "$(shell_directory)" in */packaging/helm/teams-lite | */packaging/helm/teams-lite/) return 0 ;; esac
  printf '%s' "$command_line" | grep -qE "(^|[;&|(][[:space:]]*)(cd|pushd)[[:space:]]+[\"']?([^;&|[:space:]\"']*/)?teams-lite/?[\"']?([[:space:];&|)]|\$)"
}
# $1 is one helm command. True when it is an INSTALL, its LAST `--set` word on readOnly is `true`,
# and no flag that outranks `--set` names the value in its own argument.
helm_states_read_only() {
  local last
  printf '%s' "$1" | grep -qE "(^|[[:space:]])install([[:space:]]|\$)" || return 1
  printf '%s' "$1" | grep -qE "[[:space:]](upgrade|rollback)([[:space:]]|\$)" && return 1
  printf '%s' "$1" | grep -qE -- "--set-(string|file|literal)([[:space:]]+|=)[\"']?[^[:space:]\"']*readOnly" && return 1
  last="$(printf '%s' "$1" |
    grep -oE -- "--set([[:space:]]+|=)[\"']?[^[:space:]\"']+" |
    grep -oE "(^|[,=[:space:]\"'])readOnly=[^,[:space:]\"']*" | tail -n 1)"
  [[ "$last" == *readOnly=true ]]
}
# $1 is one `kubectl apply|create|replace` command. True when a LOCAL file or directory it names
# with -f holds a manifest of this chart: the image, or the chart's own name label.
applies_a_manifest_of_it() {
  local path file
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    case "$path" in -|http://* | https://*) continue ;; "~"/*) path="$HOME/${path#\~/}" ;; esac
    case "$path" in /*) ;; *) path="$(shell_directory)/$path" ;; esac
    [ -e "$path" ] || continue
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      grep -qE "app\.kubernetes\.io/name:[[:space:]]*[\"']?teams-lite[\"']?([[:space:]]|\$)|image:[[:space:]]*[\"']?([A-Za-z0-9._-]+(:[0-9]+)?/)*teams-lite([:@\"'[:space:]]|\$)" "$file" 2>/dev/null && return 0
    done <<<"$(find "$path" -maxdepth 5 -type f \( -name '*.yaml' -o -name '*.yml' -o -name '*.json' \) -size -2M 2>/dev/null)"
  done <<<"$(printf '%s' "$1" | grep -oE -- "(^|[[:space:]])(-f|--filename)([[:space:]]+|=)[\"']?[^[:space:]\"']+" |
    sed -E "s/^[[:space:]]*(-f|--filename)([[:space:]]+|=)[\"']?//")"
  return 1
}
# $1 is one `helmfile` command. True when the helmfile it reads (its -f, else the default in the
# directory it runs in) names the chart.
helmfile_names_it() {
  local path
  path="$(printf '%s' "$1" | grep -oE -- "(^|[[:space:]])(-f|--file)([[:space:]]+|=)[\"']?[^[:space:]\"']+" | head -n 1 |
    sed -E "s/^[[:space:]]*(-f|--file)([[:space:]]+|=)[\"']?//")"
  if [ -z "$path" ]; then
    for path in helmfile.yaml helmfile.yaml.gotmpl helmfile.d; do
      [ -e "$(shell_directory)/$path" ] && break
    done
  fi
  case "$path" in "~"/*) path="$HOME/${path#\~/}" ;; /*) ;; *) path="$(shell_directory)/$path" ;; esac
  [ -e "$path" ] || return 1
  grep -rqE "teams-lite" "$path" 2>/dev/null
}
# $1 is one `kubectl port-forward` command. True when it opens the app anywhere but a loopback port
# the browser guard knows as live.
forward_is_unsafe() {
  local token local_port address host addresses
  addresses="$(printf '%s' "$1" | grep -oE -- "--address([[:space:]]+|=)[\"']?[^[:space:]\"']+" |
    sed -E "s/^--address([[:space:]]+|=)[\"']?//; s/[\"']\$//")"
  while IFS= read -r address; do
    [ -n "$address" ] || continue
    IFS=',' read -ra host <<<"$address"
    for token in "${host[@]}"; do
      case "$token" in localhost | 127.0.0.1 | ::1) ;; *) return 0 ;; esac
    done
  done <<<"$addresses"
  read -ra host <<<"$1"
  for token in "${host[@]}"; do
    token="${token#[\"\']}"
    token="${token%[\"\']}"
    if [[ "$token" =~ ^([0-9]*):([0-9]+|[A-Za-z][A-Za-z0-9-]*)$ ]]; then
      local_port="${BASH_REMATCH[1]}"
    elif [[ "$token" =~ ^[0-9]+$ ]]; then
      local_port="$token"
    else
      continue
    fi
    [[ "$local_port" =~ ^(1942[0-3]|1944[0-3])$ ]] || return 0
  done
  return 1
}
teams_lite_deploys_on_kubernetes() {
  local one named
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$(raw_form "$helm_diffs")" && continue
    named="$(printf '%s' "$one" | without_namespace)"
    printf '%s' "$named" | grep -qE "$names_the_chart" || helm_in_the_charts_directory "$one" || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    helm_states_read_only "$one" && continue
    return 0
  done <<<"$(commands_matching "$helm_deploys")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$command_line_outside_kills" | without_namespace | grep -qE "$names_the_chart|$names_the_workload" && return 0
    helmfile_names_it "$one" && return 0
  done <<<"$(commands_matching "$helmfile_deploys")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    printf '%s' "$command_line_outside_kills" | without_namespace | grep -qE "$names_the_chart" && return 0
    printf '%s' "$one" | grep -qE "$names_the_image" && return 0
    applies_a_manifest_of_it "$one" && return 0
  done <<<"$(commands_matching "$kube_applies")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE -- "$replicas_zero" && continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    printf '%s' "$one" | without_namespace | grep -qE "$names_the_workload" && return 0
    reaches_it_unnamed "$one" && return 0
  done <<<"$(commands_matching "$kube_scales")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | without_namespace | grep -qE "$names_the_workload" && return 0
    reaches_it_unnamed "$one" && return 0
  done <<<"$(commands_matching "$kube_rolls_out")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    named="$(printf '%s' "$one" | without_namespace)"
    names_a_kind "$named" 'pods?|po' || continue
    printf '%s' "$named" | grep -qE "$names_the_workload" && return 0
    printf '%s' "$one" | grep -qE "$every_namespace" && return 0
    in_its_namespace "$one" && printf '%s' "$named" | grep -qE "$everything_flag" && return 0
  done <<<"$(commands_matching "$kube_deletes")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    named="$(printf '%s' "$one" | without_namespace)"
    printf '%s' "$named" | grep -qE "[[:space:]](statefulsets?(\.apps)?|sts)([[:space:]/]|\$)" || continue
    printf '%s' "$named" | grep -qE "$names_the_workload" && return 0
    reaches_it_unnamed "$one" && return 0
  done <<<"$(commands_matching "$kube_respecs")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$names_the_image" || continue
    printf '%s' "$one" | grep -qE -- "--env([[:space:]]+|=)[\"']?TEAMS_LITE_READ_ONLY=1[\"']?([[:space:]]|\$)" &&
      ! printf '%s' "$one" | grep -qE "TEAMS_LITE_READ_ONLY=([^1[:space:]\"']|1[^[:space:]\"'])" && continue
    return 0
  done <<<"$(commands_matching "$kube_runs")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE -- "--copy-to([[:space:]]|=)" || continue
    printf '%s' "$one" | without_namespace | grep -qE "$names_the_workload" && return 0
  done <<<"$(commands_matching "$kube_debugs")"
  return 1
}
# The release, the StatefulSet or its manifests taken DOWN.
teams_lite_stops_on_kubernetes() {
  local one named
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    printf '%s' "$one" | without_namespace | grep -qE "$names_the_chart" && return 0
  done <<<"$(commands_matching "$helm_uninstalls")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE -- "$replicas_zero" || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    printf '%s' "$one" | without_namespace | grep -qE "$names_the_workload" && return 0
    reaches_it_unnamed "$one" && return 0
  done <<<"$(commands_matching "$kube_scales")"
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    named="$(printf '%s' "$one" | without_namespace)"
    if printf '%s' "$one" | grep -qE -- "(^|[[:space:]])(-f|--filename)([[:space:]]|=)"; then
      printf '%s' "$command_line_outside_kills" | without_namespace | grep -qE "$names_the_chart" && return 0
      applies_a_manifest_of_it "$one" && return 0
    fi
    names_a_kind "$named" 'statefulsets?|sts|all' || continue
    printf '%s' "$named" | grep -qE "$names_the_workload" && return 0
    printf '%s' "$one" | grep -qE "$every_namespace" && return 0
    in_its_namespace "$one" || continue
    printf '%s' "$named" | grep -qE "$everything_flag" && return 0
    printf '%s' "$named" | grep -qE "$nameless_statefulset" && return 0
  done <<<"$(commands_matching "$kube_deletes")"
  return 1
}
# What it keeps, deleted: the chart's claims, or a namespace — which deletes every claim in it.
teams_lite_claims_are_deleted() {
  local one named
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$dry_run" && continue
    named="$(printf '%s' "$one" | without_namespace)"
    names_a_kind "$named" 'namespaces?|ns' && return 0
    names_a_kind "$named" 'persistentvolumeclaims?|pvc' || continue
    printf '%s' "$named" | grep -qE "$names_a_chart_claim|$names_the_workload|$everything_flag" && return 0
    printf '%s' "$one" | grep -qE "$every_namespace" && return 0
  done <<<"$(commands_matching "$kube_deletes")"
  return 1
}
teams_lite_forwarded_unsafely() {
  local one
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | without_namespace | grep -qE "$names_the_workload" || continue
    forward_is_unsafe "$one" && return 0
  done <<<"$(commands_matching "$kube_forwards")"
  return 1
}
# Nothing to decide on a line that names none of the tools — which is nearly every line.
if printf '%s' "$command_line" | grep -qE '(helm|kubectl|(^|[^A-Za-z0-9_])oc[[:space:]])' &&
  ! inspecting_a_file && ! searching_text && ! printing_usage; then
  if teams_lite_claims_are_deleted; then
    block "This would DELETE what teams-lite keeps on Kubernetes, and nothing brings it back. Its
volume claims hold the store — every message the install synced, the keys sealed chats are read
with, the push key every phone's subscription embeds — and, in the default self-contained mode,
the device's ENROLLMENT: the Intune container and the Workplace Join keys that make it a
registered device, which only a new enrollment (a second device in the user's organisation) or
a backup restores.

A namespace delete is refused whatever namespace it names: it deletes every claim in it, and the
kubeconfig here names real clusters, so it reaches whichever one is current. A claim delete with
--all or -A is refused in any namespace, because a claim names no release this hook could check.

Every release of this chart names its claims after it, so the claims of a read-only release
you installed yourself are refused too — \`helm uninstall\` leaves them, and they cost nothing.
Delete what is not the chart's by name, and read freely:

  kubectl -n teams-lite get pvc
  kubectl delete pvc my-scratch-claim -n my-scratch-namespace

Deleting these is the user's decision alone: ask them."
  fi
  if teams_lite_deploys_on_kubernetes; then
    block "Installing, upgrading or restarting teams-lite on Kubernetes starts its send-capable
backend, signed in as the user — rule 3c's whole live stack, run by the cluster — and the
kubeconfig here names real clusters. Deploying it, upgrading it and restarting it are theirs:

  helm upgrade --install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite …

Rendering and checking it stay open, and so does a NEW read-only release (never an upgrade of
theirs — that restarts the client they are using):

  helm template teams-lite packaging/helm/teams-lite                  # self-contained (default)
  helm template teams-lite packaging/helm/teams-lite --set broker.mode=intuneContainer \\
    --set broker.intuneContainer.stateDir=…                          # the node's own broker
  packaging/helm/check.sh
  helm upgrade --install … --dry-run=client
  helm install teams-lite-ro … --set readOnly=true      # the backend refuses every write

A second copy of the pod (kubectl debug --copy-to) is refused for the same reason: it is the
live client again, on the same claims."
  fi
  if teams_lite_stops_on_kubernetes; then
    block "Uninstalling teams-lite, scaling it to 0 or deleting its StatefulSet stops the user's
live client — and in the chart's default, self-contained mode, the Intune container inside the
pod with it: the identity broker and the device's enrollment go down, every token call fails,
and the install is signed out for whoever is reading it until the user brings it back. The
claims outlive it; the sign-in does not. It is theirs:

  helm -n teams-lite uninstall teams-lite

A release you installed yourself under another name is yours to remove, and so is anything of
your own in a namespace:

  helm install teams-lite-ro … --set readOnly=true   ->   helm uninstall teams-lite-ro
  kubectl -n teams-lite delete pod my-debug-shell

Reading it stays open: kubectl -n teams-lite get|describe|logs, and
kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status."
  fi
  if teams_lite_forwarded_unsafely; then
    block "A port-forward to teams-lite is a door to the user's account: every page it serves is
handed the write token. Open it on loopback, onto a port the browser guard knows as the live
app, so that guard keeps a browser from typing into it:

  kubectl -n teams-lite port-forward svc/teams-lite 19443:19443

Never \`8080:19443\` or \`8080:web\` (a live app under a port that reads as anything), \`:19443\`
(a port nobody chose) or \`--address 0.0.0.0\` (the account on the LAN)."
  fi
fi

exit 0

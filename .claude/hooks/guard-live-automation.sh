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
#      `start`, a compose `up` — the whole live stack of rule 3c inside a container. Building it
#      and running it with `-e TEAMS_LITE_READ_ONLY=1` stay open;
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
#      of teams-lite's three hidden arguments, those arguments themselves (which make its own
#      binary boot the container, enter it or repair it), any `StartTransientUnit`, and the
#      crate's lifecycle and in-container calls inside a cargo example. Reading it stays
#      open (`intune-container status|doctor`, `cargo run --example intune_status`).
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
# command, `env -i` or `sudo` between the variable and the binary still passes.
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
# focus it or close it? Reading it (`find`, `capture`, `size`) is measurement and stays allowed:
# `examples/signin_window_recon.rs` is what re-measures SIGN-IN.md § 3.
drives_the_signin_window() {
  grep -qE '\.(type_key|click|focus|close)\(|close_open_signin_window|signin::Signin::start|interactive_token' "$1"
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
# CLI verbs rule 3b refuses. What is left alone, on purpose and by name, is what
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
# teams-lite's own half is the repair: `intune::start_repair_unit` asks systemd for the
# transient unit that restarts the container, and `intune::dispatch_reexec` runs whichever
# hidden subcommand its argv names — the repair among them — in the calling process. The
# private functions under them are named too, so a later `pub` does not open a hole; and so are
# the three hidden arguments, as literals and as the constants that hold them, which is what an
# example would hand `Command::new` to reach the same act through a binary.
cycles_the_container_in_source() {
  local lifecycle='(ops::(start|stop|init|enroll|destroy|update|restore|backup|edge|portal_start|portal_stop|portal_finish|detach_display|shell)|backend::(start|stop|attach_display|detach_display|initialize|update_rootfs|remove_rootfs|purge|backup|restore|supervise_main|exec_main|exec|exec_foreground|shell)|runtime::(poweroff_pid|start_systemd|boot_systemd|exec_pid|exec_pid_env|run_in_container|run_in_rootfs|open_shell_pty)|autostart::(enable|disable))'
  local names='(start|stop|init|enroll|destroy|update|restore|backup|edge|portal_start|portal_stop|portal_finish|detach_display|attach_display|initialize|update_rootfs|remove_rootfs|purge|supervise_main|exec_main|exec|exec_foreground|shell|poweroff_pid|start_systemd|boot_systemd|exec_pid|exec_pid_env|run_in_container|run_in_rootfs|open_shell_pty|enable|disable)'
  grep -qE "intune_container::${lifecycle}([^A-Za-z0-9_]|\$)" "$1" && return 0
  if grep -q 'intune_container' "$1"; then
    grep -qE "(^|[^A-Za-z0-9_])${lifecycle}([^A-Za-z0-9_]|\$)" "$1" && return 0
    grep -qE "intune_container::(ops|backend|runtime|autostart)::\{([^}]*[[:space:],])?${names}([[:space:],}]|\$)" "$1" && return 0
  fi
  grep -qE '(^|[^A-Za-z0-9_])intune::(start_repair_unit|start_transient_oneshot|dispatch_reexec|restart_container|repair_main)([^A-Za-z0-9_]|$)|intune::\{([^}]*[[:space:],])?(start_repair_unit|dispatch_reexec)([[:space:],}]|$)|__teams-lite-repair-broker|__rootless-supervise|__rootless-exec|(REPAIR|SUPERVISE|EXEC)_SUBCOMMAND' "$1"
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
    # the container image (packaging/docker), which shares the host's network namespace, so
    # its ports are this machine's loopback like the others. Only 19430 — read-only — is
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
    if grep -qE '(127\.0\.0\.1|localhost):(1942[0-3]|1944[0-3])|[A-Za-z0-9-]+\.ts\.net' "$script" &&
      grep -qE '"(send|edit|delete|react|mark_read|mail_mark_read|set_always_available|set_chat_pinned|set_chat_muted|set_chat_hidden|push_subscribe|push_unsubscribe|push_test|set_settings|agent_set_mode|agent_set_tools|agent_set_provider|agent_set_unrestricted|agent_stop|set_person_name|set_person_avatar|custom_emoji_add|custom_emoji_remove|custom_emoji_import|agent_persona_save|agent_persona_remove|seal_set|seal_off|seal_forget|seal_reveal|signin_start|signin_frame|signin_input|signin_cancel|update_download|update_apply|chess_engine_download|chess_engine_forget|chess_sound_forget|restart_backend|repair_broker|set_calling|call_prepare|call_place|call_join|call_accept|call_offer_media|call_answer_media|call_subscribe|call_start_sharing|call_stop_sharing|call_hangup|call_mute|gitlab_set_approval|gitlab_mr_merge|gitlab_mr_comment|gitlab_mr_delete_comment|gitlab_mr_edit_comment|gitlab_mr_resolve_thread|gitlab_mr_set_state|gitlab_mr_review_run|gitlab_mr_review_ask)"|'\''(send|edit|delete|react|mark_read|mail_mark_read|set_always_available|set_chat_pinned|set_chat_muted|set_chat_hidden|push_subscribe|push_unsubscribe|push_test|set_settings|agent_set_mode|agent_set_tools|agent_set_provider|agent_set_unrestricted|agent_stop|set_person_name|set_person_avatar|custom_emoji_add|custom_emoji_remove|custom_emoji_import|agent_persona_save|agent_persona_remove|seal_set|seal_off|seal_forget|seal_reveal|signin_start|signin_frame|signin_input|signin_cancel|update_download|update_apply|chess_engine_download|chess_engine_forget|chess_sound_forget|restart_backend|repair_broker|set_calling|call_prepare|call_place|call_join|call_accept|call_offer_media|call_answer_media|call_subscribe|call_start_sharing|call_stop_sharing|call_hangup|call_mute|gitlab_set_approval|gitlab_mr_merge|gitlab_mr_comment|gitlab_mr_delete_comment|gitlab_mr_edit_comment|gitlab_mr_resolve_thread|gitlab_mr_set_state|gitlab_mr_review_run|gitlab_mr_review_ask)'\''|write_token' "$script"; then
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
install or remove its unit, or run a program inside it — or ask for the broker repair that
restarts it:
   ${examples_cycling_the_container# }

That container holds the user's sign-in. While it is down the identity broker answers
nothing: every token call fails and teams-lite goes empty for whoever is reading it, a phone
on the tailnet included, for about a minute. An example reaches it through the crate with no
port, no RPC and no write token in the way, so what the file calls is the only thing that
can be checked — and there is one container, so no target can be pinned to make it safe.

READING the container is fine, and it is what the diagnostic is for:

  cargo run --example intune_status     # the broker's bus, whether a repair is available,
                                        # and whether the login keyring is locked
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
# SIX SPELLINGS, because the repair stopped being a host command and the container stopped
# being something only its own CLI could reach (src/intune.rs links the crate). Each is matched
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
# - THE HIDDEN ARGUMENTS. `server`'s `main` routes three before it does anything else
#   (`intune::dispatch_reexec`): `__teams-lite-repair-broker` RESTARTS the container, and
#   `__rootless-supervise` / `__rootless-exec` are the crate's own re-exec targets, which BOOT
#   it and run a script INSIDE it. They are refused whatever TEAMS_LITE_READ_ONLY says — the
#   variable is what rule 3 asks for, and none of the three is a backend it would make
#   read-only: the repair refuses under it, but the other two never look. Every program that
#   routes them is matched — a `server` at any path (the build output, the staged copy, the
#   released extraction, a bare `./server`), `/proc/<pid>/exe` of a running backend, the
#   crate's own CLI — and `cargo run`, which hands `server` whatever follows it.
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
# `systemctl --user status` on either unit and `pgrep`. A search, a commit message or a doc
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
hidden_subcommand='(__teams-lite-repair-broker|__rootless-supervise|__rootless-exec)'
hidden_argument="[[:space:]][\"']?${hidden_subcommand}${ends_a_word}"
runs_a_hidden_subcommand="${at_command_start}${by_a_shell}([A-Za-z0-9_./~\${}\"'-]*/)?(server|exe|intune-container)[\"']?([[:space:]][^;&|]*)?${hidden_argument}"
cargo_runs_a_hidden_subcommand="${at_a_program}cargo([[:space:]][^;&|]*)?[[:space:]](run|r)[[:space:]]([^;&|]*)?${hidden_argument}"
a_unit_runs_a_hidden_subcommand="${at_a_program}systemd-run([[:space:]][^;&|]*)?${hidden_argument}"
kills_a_hidden_subcommand="${at_a_program}(p?kill|killall)([[:space:]][^;&|]*)?(teams-lite-repair-broker|rootless-(supervise|exec))"
starts_a_transient_unit="${raw_dbus_call}StartTransientUnit"
dbus_cycles_a_unit='(StartUnit|RestartUnit|StopUnit|KillUnit|FreezeUnit|EnqueueUnitJob|systemd1\.Unit[.[:space:]]+(Start|Restart|TryRestart|ReloadOrRestart|ReloadOrTryRestart|Stop|Kill|Freeze)([[:space:]]|$))'
container_or_repair_unit='(intune|broker(-|_2d)repair)'
cycles_the_container_over_dbus="${raw_dbus_call}(${dbus_cycles_a_unit}[^;&|]*${container_or_repair_unit}|${container_or_repair_unit}[^;&|]*${dbus_cycles_a_unit})"
if ! searching_text &&
  a_command_matches "$cycles_the_container|$cycles_the_container_in_a_unit|$cycles_the_container_unit|$cycles_the_repair_unit|$kills_a_hidden_subcommand|$runs_a_hidden_subcommand|$cargo_runs_a_hidden_subcommand|$a_unit_runs_a_hidden_subcommand|$starts_a_transient_unit|$cycles_the_container_over_dbus"; then
  block "The Intune container is the user's sign-in. Stopping, restarting, rebuilding or booting
it takes the identity broker down, so teams-lite goes empty for whoever is looking at it —
including a phone on the tailnet — for about a minute.

This rule refuses it in the spellings it knows, not only its own CLI's verbs (directly, behind
a wrapper such as timeout or setsid, or through systemd-run): the container's systemd unit and
the broker repair's (start, stop, kill or freeze, over systemctl or raw D-Bus); a kill that
names one of the hidden arguments; the hidden arguments themselves, which turn teams-lite's own
binary into the container's supervisor (__rootless-supervise), a process inside it
(__rootless-exec) or the broker repair (__teams-lite-repair-broker) — whatever
TEAMS_LITE_READ_ONLY says; and any transient unit asked for over raw D-Bus
(StartTransientUnit), which is how the repair runs. Stopping a repair half-way through is the
worst of them: it can leave no container at all, and nothing automatic restarts one.

Diagnose it freely — these only read:

  cargo run --example intune_status     # the broker's bus, whether a repair is available,
                                        # and whether the login keyring is locked
  intune-container status
  intune-container doctor

A restart IS the remedy when that keyring re-locked, but it is not yours to run. The app's own
Repair sign-in button asks for it, and the backend asks on its own when it finds the keyring
locked — at most three automatic repairs an hour across every backend on the machine. Ask the
user to press the button, or to run:

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

# --- 3d. teams-lite's container image is the user's to start ---------------------
# The image (packaging/docker/) runs `teams` — rule 3c's whole live stack — so starting it is
# the same act in a fourth spelling, and one rules 3 to 3c cannot see: no binary path on the
# line, no `teams`, no unit. The program is inside the image, and so is its environment.
#
# WHAT IS REFUSED. Bringing a teams-lite container up: `docker|podman|nerdctl run|create` of
# the image, `start|restart|unpause` of the container, and a compose `up|start|restart|run|
# create` of its project. What it is is named three ways and any one counts — the image or the
# container by its own name as a whole word (`teams-lite`, `teams-lite:local`, `--name
# teams-lite`; never a path such as `…/worktrees/teams-lite/x`, which is what `-v` mounts
# carry), the compose file's directory (`packaging/docker`), or a shell already standing in it
# (`$PWD`), where a bare `docker compose up` finds the file on its own.
#
# WHAT STAYS OPEN, because it is how the image is made and diagnosed: `build`, `logs`, `ps`,
# `images`, `inspect`, `config`, `exec` into a running one, and every stop and removal. And TWO
# ways to RUN it for reading, each of which states its proof in the command itself:
#   • `-e TEAMS_LITE_READ_ONLY=1` (or `--env`) on a `run`, which reaches the CONTAINER — the
#     backend then refuses every write and keeps the read-only 19430 (packaging/docker/
#     entrypoint.sh). The same variable in front of `docker` sets it for the CLI alone, which
#     is rule 3's systemd-run lesson again, so it proves nothing;
#   • `--entrypoint teams-lite-intune-status`, the read-only diagnostic the image ships.
# A compose `up`/`start`/`restart` has no proof to offer: its environment is the file's, and
# the file's is send-capable.
container_cli='(docker|podman|nerdctl)([[:space:]]+container)?'
compose_cli='((docker|podman|nerdctl)[[:space:]]+([^;&|]*[[:space:]])?compose|docker-compose|podman-compose)'
names_the_image="(^|[[:space:]=\"'])teams-lite(:[^[:space:]\"';&|]*)?([[:space:]\"';&|]|\$)"
names_the_project="${names_the_image}|packaging/docker([/[:space:]\"';&|]|\$)"
runs_a_container="${at_a_program}${container_cli}([[:space:]][^;&|]*)?[[:space:]](run|create)${ends_a_word}"
starts_a_container="${at_a_program}${container_cli}([[:space:]][^;&|]*)?[[:space:]](start|restart|unpause)${ends_a_word}"
compose_starts="${at_a_program}${compose_cli}([[:space:]][^;&|]*)?[[:space:]](up|start|restart|create)${ends_a_word}"
compose_runs="${at_a_program}${compose_cli}([[:space:]][^;&|]*)?[[:space:]]run${ends_a_word}"
container_read_only="(-e|--env)([[:space:]]+|=)[\"']?TEAMS_LITE_READ_ONLY=1[\"']?([[:space:]]|\$)|--entrypoint([[:space:]]+|=)[\"']?(/usr/local/bin/)?teams-lite-intune-status[\"']?([[:space:]]|\$)"
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
# The commands on this line, one per line, kills and probes taken out, that match ERE $1.
commands_matching() {
  printf '%s\n' "$command_line_outside_kills" | tr ';&|' '\n\n\n' | grep -E "$(raw_form "$1")"
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
    if printf '%s' "$one" | grep -qE "$names_the_image" &&
      ! printf '%s' "$one" | grep -qE "$container_read_only"; then
      return 0
    fi
  done <<<"$(commands_matching "$runs_a_container")"
  local compose_runs_here
  compose_runs_here="$(commands_matching "$compose_runs")" || return 1
  compose_project_named || return 1
  while IFS= read -r one; do
    [ -n "$one" ] || continue
    printf '%s' "$one" | grep -qE "$container_read_only" || return 0
  done <<<"$compose_runs_here"
  return 1
}
# Nothing to decide on a line that names no container CLI at all — which is nearly every line.
if printf '%s' "$command_line" | grep -qE '(docker|podman|nerdctl|compose)' &&
  ! inspecting_a_file && ! searching_text && ! printing_usage &&
  { a_teams_lite_container_starts || a_teams_lite_container_runs_unproven; }; then
  block "teams-lite's container image runs \`teams\` — a send-capable backend signed in as the
user, and the real app on 127.0.0.1:19443 — so bringing it up is the same act rule 3c
refuses, in a container. Starting it is theirs:

  docker compose -f packaging/docker/compose.yaml up -d

Building and reading it stay open:

  docker compose -f packaging/docker/compose.yaml build
  docker compose -f packaging/docker/compose.yaml logs -f
  docker run --rm --pid=host --entrypoint teams-lite-intune-status \\
    -v ~/.local/share/intune-container:/home/teams/.local/share/intune-container:ro teams-lite:local

To read real data through the image, tell the CONTAINER it is read-only — the backend then
refuses every write and listens on 19430:

  docker run --rm -e TEAMS_LITE_READ_ONLY=1 --pid=host --network=host … teams-lite:local

(TEAMS_LITE_READ_ONLY=1 in front of \`docker\` sets it for the CLI, never for the container.)"
fi

exit 0

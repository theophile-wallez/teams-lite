#!/usr/bin/env bash
# teams-lite as an always-on background service: build, stage, install, inspect.
#
#   bin/teams-lite-service.sh install     # build + stage + write the units (starts nothing)
#   bin/teams-lite-service.sh update      # rebuild + restage, then restart what is running
#   bin/teams-lite-service.sh update --now # the same, without waiting for a live agent run
#   bin/teams-lite-service.sh units       # rewrite + verify the units only (no build; needs a current stage)
#   bin/teams-lite-service.sh status      # units, ports, artifact, Intune, tailscale
#   bin/teams-lite-service.sh logs [-f]   # journal for both units
#   bin/teams-lite-service.sh tailscale   # point the tailnet HTTPS port at the web UI
#   bin/teams-lite-service.sh stop        # stop both units
#   bin/teams-lite-service.sh uninstall   # stop, disable, remove the units (keeps data)
#
# WHY IT STAGES INSTEAD OF RUNNING THE CHECKOUT. The service runs a COPY of the built
# artifacts in ~/.local/share/teams-lite/service, not the git tree, for three reasons:
#
#   1. `bun run test:e2e` rebuilds web/dist with its mock's URL compiled into the
#      client bundle (see web/build-info.ts). A service pointed at the checkout would
#      pick that up on its next restart and serve a phone a bundle that dials a mock.
#   2. `git checkout`, a pull, or a rebuild would change what the service serves the
#      next time it restarts — silently, and at a moment nobody chose.
#   3. "Not the dev version" then means something concrete: an artifact promoted on
#      purpose, with the commit it came from recorded next to it.
#
# WHAT IT DELIBERATELY DOES NOT DO: start or enable anything. The backend is
# send-capable — it is the user's real Teams client — so bringing it up is the user's
# call, and `install` prints the one command that does it. That boundary is also
# enforced mechanically for agents by .claude/hooks/guard-live-automation.sh.
#
# WHY `update` WAITS. A restart kills a local-agent run (`@claude` in a thread) with the
# child process, and the reply it was writing keeps its "claude is thinking…" body in
# front of everybody in the thread. So the restart waits for the agent to be quiet — see
# `wait_for_quiet_agent`, and `agent_run_marker_dir` in src/bin/server.rs for the markers
# it reads. The wait is bounded and then restarts anyway: the run left behind is closed
# by whichever backend comes up (`repair_abandoned_agent_runs`), so the thread ends up
# honest either way, and a staged commit is never held hostage by one stuck run.
#
# WHY IT WAITS BEFORE IT STAGES, AND NOT AFTER. Staging is not the harmless half. The web
# bundle is a DIRECTORY of hashed chunks, and the SSR handler imports them off disk as the
# routes are asked for; replace that directory under the running web server and its next
# lazy import names a file that is gone — so the page dies while the process stays up.
# It happened on 2026-08-06: an update staged a new bundle and then held its restart for a
# live `@claude` run that took 40 minutes, so from the moment it staged the app served
# Bun's own "fetch(req) did not return a Response object" page to the user's phone.
# So the wait comes FIRST, and staging plus the restart follow together: a bundle and the
# process serving it are out of step for the seconds a `try-restart` takes rather than for
# the length of a run. `renderWithSsr` in web/server.ts answers honestly inside those
# seconds, and neither half replaces the other — `install` stages without restarting
# anything at all.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
BIN_DIR="$(dirname "$SCRIPT_PATH")"
REPO="$(dirname "$BIN_DIR")"

# --- layout ------------------------------------------------------------------
# The two directory overrides exist so the generated units can be inspected — and
# verified with `systemd-analyze verify` — without writing into the live unit
# directory. Nothing else should set them. An inspection still needs a staged backend
# that finds the broker itself (`require_a_staged_backend_that_finds_the_broker`), so point
# TEAMS_LITE_SERVICE_DIR at one: the units exec it, and `systemd-analyze verify` refuses a
# unit whose program is absent in any case.
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
SERVICE_DIR="${TEAMS_LITE_SERVICE_DIR:-$DATA_HOME/teams-lite/service}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/teams-lite"
UNIT_DIR="${TEAMS_LITE_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"

# --- ports (defaults must match the code: src/bin/server.rs, web/server.ts) ---
BACKEND_PORT="${TEAMS_LITE_PORT:-19420}"
WEB_PORT="${TEAMS_LITE_WEB_PORT:-19440}"
# The tailnet-facing HTTPS port `tailscale serve` publishes. 443 is often already
# taken on a machine that serves something else, so 8443 is the default here.
TAILSCALE_PORT="${TEAMS_LITE_TAILSCALE_PORT:-8443}"

# --- the RELEASED build, beside the staged one (teams-lite-app.service) -------
# The single `teams` binary install.sh downloads, on ports of its own so it runs at the
# same time as the staged pair rather than instead of it. It is the artifact other people
# get, and the only install shape that can update ITSELF from the app (see AGENTS.md
# § Updating the app from inside it). Its ports keep the block's convention: x422/x442,
# next door to the service's x420/x440 and the dev pair's x421/x441.
APP_BIN="${TEAMS_LITE_APP_BIN:-$HOME/.teams-lite/bin/teams}"
INSTALL_SH_URL="https://raw.githubusercontent.com/theophile-wallez/teams-lite/master/install.sh"
APP_BACKEND_PORT="${TEAMS_LITE_APP_BACKEND_PORT:-19422}"
APP_WEB_PORT="${TEAMS_LITE_APP_WEB_PORT:-19442}"

UNITS=(
  teams-lite-backend.service
  teams-lite-web.service
  teams-lite-app.service
  teams-lite.target
)

# WHAT EARLIER VERSIONS OF THIS SCRIPT INSTALLED, AND THIS ONE TAKES BACK.
#
# Every one of these existed because the backend read the identity broker's D-Bus address
# from an environment frozen at exec, and because the broker repair was an installed unit
# running the `intune-container` binary: a .path unit restarted both backends whenever the
# Intune container rewrote rootless.json (through teams-lite-backend-restart.service — a
# .path can only START a unit), a timer ran a keyring check and a bus check every fifteen
# minutes, the repair unit did the stop and the start, and five scripts staged beside the
# binary resolved, waited for and froze the bus. The backend now finds the bus on every
# connection, checks the keyring itself and asks systemd for a TRANSIENT repair unit under
# a name of its own (src/intune.rs), so none of them has a job — and left in place they
# would still act: the .path would restart both backends on every container boot, and the
# timer would run scripts this version no longer stages.
#
# WHY BY NAME, rather than by falling out of UNITS. `install_units` and `uninstall` act on
# UNITS alone, and `stage_artifacts` never deletes a file it staged before — so on a machine
# staged before this, every one of them would stay installed, ENABLED and running for good.
# `retire_old_units` and `retire_old_scripts` run on `install`, `update`, `units` and
# `uninstall`. .claude/hooks/sync-service-to-master.sh runs `update` on its own when master
# moves, which is how this reaches the always-on machine with nobody typing a command — so
# both are idempotent, quiet where there is nothing to retire, and never fail an update.
#
# AND ONLY IN FRONT OF A BACKEND THAT NO LONGER NEEDS THEM. The retirement is half of one
# change and the binary is the other half, so `install_units` refuses outright in front of a
# staged binary that predates it (`require_a_staged_backend_that_finds_the_broker`), and it
# keeps RETIRED_KEPT_FOR_AN_OLD_BACKEND installed while an old binary is still the one
# RUNNING and nothing in this run restarts it.
RETIRED_UNITS=(
  teams-lite-broker-bus.path
  teams-lite-broker-health.timer
  teams-lite-broker-health.service
  teams-lite-backend-restart.service
  teams-lite-broker-repair.service
)
# The two that were ENABLED (WantedBy=teams-lite.target) and run continuously, so the two
# that are stopped and disabled as well as deleted.
RETIRED_WATCHERS=(
  teams-lite-broker-bus.path
  teams-lite-broker-health.timer
)
RETIRED_SCRIPTS=(
  teams-lite-backend.sh
  teams-lite-broker-check.sh
  teams-lite-broker-bus-check.sh
  teams-lite-broker-wait.sh
  broker-env.sh
)

# WHAT A BACKEND FROM BEFORE THIS STILL LIVES BY, for as long as nothing restarts it.
#
# `update` try-restarts the backend straight after it writes the units, so an old process
# outlives the retirement by the seconds that takes. `install` and `units` restart nothing,
# by design — so on a machine whose staged backend has been running since before this
# change, that process would carry on with its bus frozen at exec and nothing left to keep
# it signed in: no .path to restart it when the container moves, and a Repair sign-in — its
# own button and its own automatic trigger, both `systemctl start` of the installed repair
# unit — naming a unit that is gone. So these three stay installed, with the scripts the
# repair runs, until that process runs the staged build (`stale_backend_pid`). It ends on its
# own too: the next container boot fires the .path, whose try-restart brings the backend up
# on the staged binary, and the next `units` or `update` then retires them.
#
# THE HEALTH TIMER IS DELIBERATELY NOT AMONG THEM, though it was a healer too. Its bus half
# compares every running backend's frozen session-bus address with the container's and
# try-restarts BOTH backends on a mismatch — and a backend started from this version's unit
# carries no container address at all. Kept, it would read the very restart this deferral
# asks for as a stale backend and restart both every fifteen minutes, cutting a live
# `@claude` reply each time, for as long as it stayed installed. The old process does not
# need it either: the .path covers the container moving under it, and its own observer still
# asks for the repair when a token call fails with the locked-keyring signature.
RETIRED_KEPT_FOR_AN_OLD_BACKEND=(
  teams-lite-broker-bus.path
  teams-lite-backend-restart.service
  teams-lite-broker-repair.service
)

# THE ONE TELL BETWEEN A BACKEND THAT FINDS THE IDENTITY BROKER ITSELF AND ONE THAT DOES NOT.
# The hidden argument the in-process repair re-executes the binary with
# (`intune::REPAIR_SUBCOMMAND` in src/intune.rs) is a literal in every build that has the
# in-process lookup and in none before it, so `grep -a` tells the two apart from the bytes
# alone — no build to run, no version to parse, nothing on the host beyond grep. The units
# this version writes depend on exactly that difference: teams-lite-backend.service execs the
# binary with no wrapper, and a build from before would then dial the user manager's bus,
# where there is no broker. bin/teams-launcher.sh and install.sh carry the same check, for
# the same pairing; src/update.rs pins all three spellings to the constant, so renaming the
# argument cannot quietly turn every current build into an "old" one.
BROKER_LOOKUP_MARKER="__teams-lite-repair-broker"

BUN="${BUN:-$HOME/.bun/bin/bun}"
SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"

# The backend PATH, baked into the unit. The systemd user manager's own PATH holds
# neither of the two directories a coding-agent CLI installs itself into, so the local
# agent (`@claude` in a thread) finds no program and drops every trigger. The user's
# directories come first, because a self-updating CLI lives there and must win over an
# older packaged copy.
AGENT_PATH="${TEAMS_LITE_AGENT_PATH:-$HOME/.local/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

# Where a live agent run publishes its marker (`agent_run_marker_dir` in
# src/bin/server.rs), and how long a restart waits for one. Forty minutes, because a run
# is bounded by SILENCE and not by a clock (`agent::RUN_IDLE_TIMEOUT`): a question that
# needs an hour of tool calls gets it, so a ten-minute wait here would kill the long runs
# this wait exists to protect. Past it the restart proceeds, because the staged commit
# must reach the user's phone and the abandoned reply is closed by the backend that comes
# up.
# No runtime directory means no markers are published at all (see the Rust side), so the
# variable stays empty rather than naming a path at the root that can never exist.
AGENT_RUN_DIR="${TEAMS_LITE_AGENT_RUN_DIR:-${XDG_RUNTIME_DIR:+$XDG_RUNTIME_DIR/teams-lite/agent-runs}}"
AGENT_WAIT_SECONDS="${TEAMS_LITE_AGENT_WAIT:-2400}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() {
  printf 'teams-lite-service: %s\n' "$*" >&2
  exit 1
}

# --- build -------------------------------------------------------------------

# The commit the artifacts are built FROM, pinned for the whole run by
# build_artifacts and read again by stage_artifacts.
#
# WHY IT IS PINNED. The build takes about a minute, and something else can
# fast-forward the checkout inside that minute: the auto-pull hook in
# ~/.claude/settings.json, another session's push, or the user's own `git pull`. A
# second `git rev-parse HEAD` at staging time then writes a VERSION that names a
# commit the binary does not hold. That lie does not heal, because
# .claude/hooks/sync-service-to-master.sh compares VERSION with HEAD: it reads the
# two as equal, logs "already serving", and never rebuilds. The service kept a
# backend from before the feature while VERSION named the commit that added it, so a
# new RPC answered `unknown method` in the user's own app and every test passed.
BUILD_REV=""

repo_head() { git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown; }

build_backend() {
  say "Building the backend (release)…"
  # Bake the commit so the running service can say what it serves (build.rs reads it).
  TEAMS_BUILD_REV="$BUILD_REV" \
    cargo build --release --manifest-path "$REPO/Cargo.toml" --bin server
}

build_web() {
  [ -d "$REPO/web/node_modules" ] || {
    say "Installing web dependencies…"
    (cd "$REPO/web" && "$BUN" install)
  }

  # The web build MUST NOT see VITE_TEAMS_WS_URL: it is compiled into the client
  # bundle as the backend the page dials. `env -u` scrubs it whatever the caller had
  # set, and dist/ is removed first so nothing survives from an earlier (possibly
  # E2E) build. web/server.ts refuses a pinned bundle at startup as a second net.
  say "Building the web UI (production)…"
  rm -rf "$REPO/web/dist"
  (cd "$REPO/web" &&
    env -u VITE_TEAMS_WS_URL -u PORT -u HOST \
      TEAMS_BUILD_REV="$BUILD_REV" \
      "$BUN" run build)
}

build_artifacts() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found; install Rust first"
  [ -x "$BUN" ] || die "bun not found at $BUN (set BUN=/path/to/bun)"

  # Build the commit that was checked out when the build started, then check that it
  # is still the one checked out. A tree that moved under the build produced half an
  # artifact set, so the only honest answer is to build it again.
  local attempt moved
  for attempt in 1 2 3; do
    BUILD_REV="$(repo_head)"
    build_backend
    build_web
    moved="$(repo_head)"
    [ "$moved" = "$BUILD_REV" ] && return 0
    warn "the checkout moved from ${BUILD_REV:0:12} to ${moved:0:12} during the build \
(attempt $attempt of 3) — building it again"
  done
  die "the checkout keeps moving during the build; run 'update' again once it is still"
}

# --- stage -------------------------------------------------------------------

stage_artifacts() {
  local server_bin="$REPO/target/release/server"
  [ -x "$server_bin" ] || die "no release backend at $server_bin — run 'install' or 'update'"

  say "Staging into $SERVICE_DIR…"
  mkdir -p "$SERVICE_DIR"

  # Replace the binary through a temp file + rename: an atomic swap, so a running
  # backend keeps its open file and the next start gets the new one.
  #
  # It is the whole of the backend's program: teams-lite-backend.service execs it with no
  # wrapper, because the backend finds the identity broker's bus itself (src/intune.rs).
  # The scripts earlier versions staged beside it are removed by `retire_old_scripts`,
  # and only once no unit left on the machine runs them.
  install -m 0755 "$server_bin" "$SERVICE_DIR/server.new"
  mv -f "$SERVICE_DIR/server.new" "$SERVICE_DIR/server"

  # The web runtime file set is owned by web/scripts/stage-bundle.ts, so this script
  # and launcher/build.ts cannot drift apart on what the server needs.
  (cd "$REPO/web" && "$BUN" run scripts/stage-bundle.ts "$SERVICE_DIR/web")

  # The commit the ARTIFACTS hold, never a fresh read of HEAD — see BUILD_REV for the
  # gap a second read opens.
  local commit="$BUILD_REV"
  [ -n "$commit" ] ||
    die "stage_artifacts runs after build_artifacts, which pins the commit it built"
  cat >"$SERVICE_DIR/VERSION" <<EOF
commit=$commit
staged_from=$REPO
staged_at=$(date -Is)
backend_port=$BACKEND_PORT
web_port=$WEB_PORT
EOF
  info "commit $commit"
}

# --- units -------------------------------------------------------------------

# Does the binary at $1 find the identity broker by itself (see BROKER_LOOKUP_MARKER)? A file
# that is absent or cannot be read is not one that does.
finds_the_broker_itself() {
  [ -r "$1" ] && grep -qaF -- "$BROKER_LOOKUP_MARKER" "$1"
}

# Refuse to write the units in front of a staged backend that cannot find the identity broker
# by itself — BEFORE anything is written or retired, so a refusal leaves the machine exactly as
# it was.
#
# `install` and `update` stage the binary they have just built, so they always pass; the run
# this exists for is `units`, which stages nothing. On a machine still staged from before this
# change — what an `update` whose build failed leaves behind, or a checkout pulled by hand —
# it used to write the wrapper-less backend unit in front of the OLD binary and retire every
# watcher that binary lived by. The process carried on with its frozen address for the
# moment, and the next restart of it (a crash, Settings › Restart the backend, a reboot)
# exec'd the old binary straight onto the user manager's bus, where there is no broker: the
# always-on app signed out, with nothing left on the machine to bring it back.
require_a_staged_backend_that_finds_the_broker() {
  local server="$SERVICE_DIR/server"
  [ -e "$server" ] ||
    die "no backend is staged at $server — run 'bin/teams-lite-service.sh update' (or \
'install'), which builds and stages one before it writes the units"
  finds_the_broker_itself "$server" ||
    die "the backend staged at $server predates the in-process broker lookup: the units this \
version writes exec it with no wrapper, so it could not find the identity broker. Run \
'bin/teams-lite-service.sh update', which builds and stages the current backend first and \
then restarts what is running onto it"
}

# The pid of a staged backend that is RUNNING a build from before the in-process broker
# lookup, or nothing.
#
# Judged from the PROCESS, not from the file: `stage_artifacts` renames the new binary over the
# old one, the old process keeps running the inode it started from — its /proc/<pid>/exe then
# reads "…/server (deleted)" — and /proc/<pid>/exe still OPENS that inode, so the grep that
# judges the staged file judges the running one too, whatever path it was started from. That is
# sharper than comparing paths: a process running an earlier build that already finds the
# broker needs none of the old units, and is left alone. A unit with no main process, or one
# that has gone by the time it is read, is no old backend to keep anything for.
stale_backend_pid() {
  local pid
  pid="$("$SYSTEMCTL" --user show -p MainPID --value teams-lite-backend.service 2>/dev/null ||
    true)"
  case "$pid" in
    "" | 0 | *[!0-9]*) return 0 ;;
  esac
  [ -e "/proc/$pid/exe" ] || return 0
  finds_the_broker_itself "/proc/$pid/exe" || printf '%s' "$pid"
}

# Write the units, verify them, and retire what earlier versions installed.
#
#   install_units --restart-follows      `update`: it try-restarts the backend right after
#   install_units --no-restart-follows   `install`, `units`: nothing restarts it
#
# THE CALLER SAYS WHICH, and this function never works it out. The answer decides whether a
# backend still running a build from before this one keeps the units it lives by
# (RETIRED_KEPT_FOR_AN_OLD_BACKEND), and only the caller knows whether a restart is coming:
# the unit's state says what is running now, never whether this run is about to replace it.
# A new caller has to answer too — there is no default to fall into.
install_units() {
  local restart="${1:-}"
  case "$restart" in
    --restart-follows | --no-restart-follows) shift ;;
    *) die "install_units: say whether a restart follows (--restart-follows or \
--no-restart-follows), not '$restart'" ;;
  esac
  [ $# -eq 0 ] || die "unknown option '$1' for units"

  require_a_staged_backend_that_finds_the_broker

  say "Writing the units into $UNIT_DIR…"
  mkdir -p "$UNIT_DIR" "$CONFIG_DIR"

  # Which units this machine can actually run. The app unit runs the RELEASED binary,
  # which install.sh downloads and which most machines do not have — and a unit whose
  # ExecStart does not exist is one systemd rejects here and would fail at start with
  # 203/EXEC. So it is written only when the binary is there, and a stale copy is removed
  # when it is not: no unit for a program that is absent.
  local units=()
  for unit in "${UNITS[@]}"; do
    if [ "$unit" = teams-lite-app.service ] && [ ! -x "$APP_BIN" ]; then
      rm -f "$UNIT_DIR/$unit"
      info "$unit: skipped — no released build at $APP_BIN"
      continue
    fi
    units+=("$unit")
  done

  local unit
  for unit in "${units[@]}"; do
    [ -f "$REPO/packaging/systemd/$unit" ] || die "missing template: packaging/systemd/$unit"
    sed \
      -e "s|@SERVICE_DIR@|$SERVICE_DIR|g" \
      -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
      -e "s|@REPO@|$REPO|g" \
      -e "s|@BUN@|$BUN|g" \
      -e "s|@AGENT_PATH@|$AGENT_PATH|g" \
      -e "s|@BACKEND_PORT@|$BACKEND_PORT|g" \
      -e "s|@WEB_PORT@|$WEB_PORT|g" \
      -e "s|@APP_BIN_DIR@|$(dirname "$APP_BIN")|g" \
      -e "s|@APP_BIN@|$APP_BIN|g" \
      -e "s|@APP_BACKEND_PORT@|$APP_BACKEND_PORT|g" \
      -e "s|@APP_WEB_PORT@|$APP_WEB_PORT|g" \
      "$REPO/packaging/systemd/$unit" >"$UNIT_DIR/$unit"
    info "$unit"
  done

  # Leftover placeholders mean a template gained a token this script does not know:
  # fail loudly rather than install a unit systemd will reject at start time.
  local leftovers
  leftovers="$(grep -l '@[A-Z_]\+@' "${units[@]/#/$UNIT_DIR/}" 2>/dev/null || true)"
  [ -z "$leftovers" ] || die "unsubstituted placeholders in: $leftovers"

  # Let systemd itself judge the result, while a mistake is still one sed away.
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze --user verify "${units[@]/#/$UNIT_DIR/}" ||
      die "systemd rejected the generated units (see the errors above)"
  fi

  # A backend this run will not restart, still running a build from before this one, keeps the
  # units it lives by — and only while one of them is still installed, so a machine already
  # migrated hears nothing about it. Never against an inspection directory, where nothing is
  # retired anyway.
  local stale_pid="" keep=()
  if [ "$restart" = --no-restart-follows ] && [ -z "${TEAMS_LITE_UNIT_DIR:-}" ]; then
    stale_pid="$(stale_backend_pid)"
    if [ -n "$stale_pid" ] && any_retired_unit_installed "${RETIRED_KEPT_FOR_AN_OLD_BACKEND[@]}"; then
      keep=("${RETIRED_KEPT_FOR_AN_OLD_BACKEND[@]}")
    fi
  fi

  # The units this version no longer ships come off the machine in the same pass, so one
  # reload covers both — and the scripts they ran go only after that reload (see
  # `retire_old_scripts` for why the order is the whole point). AFTER the verify: a set
  # systemd rejected stops the run before anything has been taken off the machine.
  retire_old_units ${keep[@]+"${keep[@]}"}
  [ -n "${TEAMS_LITE_UNIT_DIR:-}" ] || "$SYSTEMCTL" --user daemon-reload
  reset_retired_units
  retire_old_scripts

  if [ "${#keep[@]}" -gt 0 ]; then
    warn "teams-lite-backend.service (pid $stale_pid) still runs a build from before this one,"
    warn "and nothing in this run restarts it. Kept, with the scripts they run, because it"
    warn "follows a container restart and repairs a locked keyring through them:"
    warn "  ${keep[*]}"
    warn "Restart it onto the staged build — that is yours to run:"
    warn "  systemctl --user try-restart teams-lite-backend.service"
    warn "The next 'update' or 'units' retires them after that ('update' restarts it itself)."
  fi
}

# Is any of the named retired units still on this machine — its file, or the enable symlink a
# file deleted by hand leaves dangling in the target's wants?
any_retired_unit_installed() {
  local unit
  for unit in "$@"; do
    retired_unit_installed "$unit" && return 0
  done
  return 1
}

retired_unit_installed() {
  [ -e "$UNIT_DIR/$1" ] || [ -L "$UNIT_DIR/teams-lite.target.wants/$1" ]
}

# Clear the `failed` mark a retired unit leaves behind once its file is gone. A unit whose last
# run failed is not garbage-collected (CollectMode=inactive), so after the reload it stays
# loaded as `not-found failed`: `systemctl --user --failed` lists it and the user manager
# reports `degraded` until a reboot — with nothing in `status` able to say why, because the
# file is gone. The old health check failed whenever one of its checks could not tell (exit 2),
# so this is a leftover the migration really produces.
#
# Only the units that are GONE. One still on disk is one something still runs or relies on,
# and a reset would clear its start limit too — for the repair unit, its three an hour. A unit
# systemd never loaded answers with an error, which is the common case and says nothing.
reset_retired_units() {
  [ -z "${TEAMS_LITE_UNIT_DIR:-}" ] || return 0
  local unit
  for unit in "${RETIRED_UNITS[@]}"; do
    retired_unit_installed "$unit" && continue
    "$SYSTEMCTL" --user reset-failed "$unit" >/dev/null 2>&1 || true
  done
}

# Take the RETIRED_UNITS off this machine: stop and disable the two watchers, then delete
# every retired unit file. The caller reloads systemd once, after this.
#
#   retire_old_units [UNIT…]   the units named are KEPT — enabled, armed and on disk — this
#                              time; `install_units` names RETIRED_KEPT_FOR_AN_OLD_BACKEND
#                              when an old backend still runs and nothing restarts it
#
# NOTHING ELSE IS STOPPED, and the repair unit least of all. A repair may be running at this
# very moment — it stops the Intune container and starts it again — and cutting it between
# the two leaves the user with no container, and so no sign-in, until somebody starts it by
# hand.
#
# AND A UNIT THAT IS RUNNING KEEPS ITS FILE UNTIL THE NEXT RUN, which is the same rule one
# step further. Deleting the file of a running oneshot and reloading is a cut too, only a
# quieter one: the reload re-reads every unit from disk, a unit with no file comes back with
# no command list, and systemd then lets the CURRENT command finish and runs none after it
# ("execution of the command list won't be resumed") — so a repair caught inside its `stop`
# would never reach its `start`. The two oneshots beside it (the health check, the backend
# restart) get the same courtesy, because one rule is easier to trust than three. The next
# `update` or `units` finds them stopped and finishes the job.
#
# A unit that is already gone is the common case on every run after the first, so every
# step here tolerates it and says nothing about it.
retire_old_units() {
  local unit state keep=" $* "
  # Against an inspection directory there is no live manager to act on: the files it
  # holds were written for `systemd-analyze verify`, and the installed units are untouched.
  if [ -z "${TEAMS_LITE_UNIT_DIR:-}" ]; then
    for unit in "${RETIRED_WATCHERS[@]}"; do
      case "$keep" in *" $unit "*) continue ;; esac
      if [ -f "$UNIT_DIR/$unit" ]; then
        "$SYSTEMCTL" --user disable --now "$unit" >/dev/null 2>&1 || true
      else
        # A file somebody already deleted by hand can leave the watcher loaded and armed
        # until it is stopped; `disable` needs the file, `stop` does not.
        "$SYSTEMCTL" --user stop "$unit" >/dev/null 2>&1 || true
      fi
    done
  fi
  for unit in "${RETIRED_UNITS[@]}"; do
    # The enable symlink too. `disable` finds it through the [Install] section of the
    # file, so a file deleted by hand leaves its symlink dangling in the target's wants.
    retired_unit_installed "$unit" || continue
    case "$keep" in
      *" $unit "*)
        info "$unit: kept for the running backend, which predates this build"
        continue
        ;;
    esac
    if [ -z "${TEAMS_LITE_UNIT_DIR:-}" ]; then
      state="$(unit_state "$unit")"
      case "$state" in
        active | activating | deactivating | reloading | refreshing)
          info "$unit: still $state — left in place, and retired on the next run"
          continue
          ;;
      esac
    fi
    rm -f "$UNIT_DIR/$unit" "$UNIT_DIR/teams-lite.target.wants/$unit"
    info "$unit: retired"
  done
}

# What the user manager says a unit is doing, or nothing. `is-active` exits non-zero for
# every state but `active` and prints the answer on stdout either way, so the status is
# ignored and the first line is the answer — exactly as `print_units_state` reads it.
unit_state() {
  "$SYSTEMCTL" --user is-active "$1" 2>/dev/null | head -1 || true
}

# Delete the RETIRED_SCRIPTS earlier versions staged beside the binary.
#
# AFTER the reload, never before it. Until systemd re-reads teams-lite-backend.service it
# still holds the old one in memory, whose ExecStart= is the staged teams-lite-backend.sh —
# so a backend that crashed or was restarted inside that window would fail with 203/EXEC.
# And never against an inspection directory: there, the INSTALLED backend unit was not
# rewritten, and may still exec one of these.
#
# AND NEVER ONE A RETIRED UNIT STILL ON DISK WOULD RUN. A unit is left in place because it is
# running (see `retire_old_units`) or because an old backend still relies on it
# (RETIRED_KEPT_FOR_AN_OLD_BACKEND), and either way its LATER commands still name these files:
# the old health check is two ExecStart= lines, so one caught running its first script would
# fail its second with 203/EXEC, and a kept repair unit's ExecCondition= is one of them. A
# script that is running right now is safe either way — `rm` unlinks the name and the shell
# reading it keeps the open file — but the commands after it are not, so a script goes only
# once nothing left installed names it, and the next run finishes the job.
retire_old_scripts() {
  [ -z "${TEAMS_LITE_UNIT_DIR:-}" ] || return 0
  local script
  for script in "${RETIRED_SCRIPTS[@]}"; do
    [ -e "$SERVICE_DIR/$script" ] || continue
    if retired_script_in_use "$script"; then
      info "$SERVICE_DIR/$script: kept — a retired unit still installed runs it"
      continue
    fi
    rm -f "$SERVICE_DIR/$script"
    info "$SERVICE_DIR/$script: retired"
  done
}

# Would something left installed still run the staged RETIRED_SCRIPTS file $1? A retired unit
# still on disk names its scripts by their STAGED path (its Documentation= lines name the
# checkout's copy, which is a different path and runs nothing); broker-env.sh is run by no unit
# at all, but SOURCED by the two check scripts, so it lives as long as either of them does.
retired_script_in_use() {
  local script="$1" other
  retired_unit_runs "$script" && return 0
  for other in "${RETIRED_SCRIPTS[@]}"; do
    [ "$other" != "$script" ] && [ -f "$SERVICE_DIR/$other" ] || continue
    retired_unit_runs "$other" || continue
    grep -qE "^[[:space:]]*(\.|source)[[:space:]].*/${script//./\\.}\"?[[:space:]]*\$" \
      "$SERVICE_DIR/$other" && return 0
  done
  return 1
}

retired_unit_runs() {
  local unit
  for unit in "${RETIRED_UNITS[@]}"; do
    [ -f "$UNIT_DIR/$unit" ] || continue
    grep -qF -- "$SERVICE_DIR/$1" "$UNIT_DIR/$unit" && return 0
  done
  return 1
}

# --- checks ------------------------------------------------------------------

port_owner() {
  # Who listens on $1, or nothing. `ss` prints the process for our own sockets.
  ss -ltnp "sport = :$1" 2>/dev/null | awk 'NR>1 {print $NF; exit}'
}

# Is intune-container initialized? The crate's own question (`ops::is_initialized`: its
# config.toml is there and says `initialized = true`), asked of the file with shell builtins
# alone — `status` runs nothing on the host to answer it. A summary, not the authority: the
# crate also refuses a file it cannot parse, and `intune_status` is the one that says so.
intune_container_initialized() {
  local line
  [ -f "$1" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    [ "${line//[[:space:]]/}" = "initialized=true" ] && return 0
  done <"$1"
  return 1
}

check_environment() {
  say "Environment"

  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" = "yes" ]; then
    info "linger: enabled (the service survives logout and starts at boot)"
  else
    warn "linger is OFF — the service would stop at logout. Fix: loginctl enable-linger $USER"
  fi

  # WHERE THE IDENTITY BROKER IS, AND WHETHER THE CONTAINER'S KEYRING IS LOCKED, are the
  # backend's own questions now, answered in process through the `intune-container` crate
  # (src/intune.rs) — so this script asks neither. A shell answer beside the backend's would
  # be a second spelling of one fact, and the two drifting apart is exactly how a backend
  # ended up on a bus with no broker on it. What files alone can say is whether
  # intune-container is set up here, which is what decides whether the app offers its
  # Repair sign-in button at all (`intune::repair_available`). The live answer is one
  # read-only command away, and it is the same code the backend runs.
  local intune_config="$DATA_HOME/intune-container/config.toml"
  if intune_container_initialized "$intune_config"; then
    info "intune-container: set up ($intune_config) — the app can repair a locked keyring"
  elif [ -f "$intune_config" ]; then
    warn "intune-container: configured but not initialized ($intune_config) — the app offers no repair"
  else
    info "intune-container: not set up — classic Intune or none; the broker is looked for on the session bus"
  fi
  info "the broker's bus and the keyring, live: (cd $REPO && cargo run --example intune_status)"

  local owner
  owner="$(port_owner "$BACKEND_PORT")"
  if [ -n "$owner" ]; then
    info "backend port $BACKEND_PORT: in use by $owner"
  else
    info "backend port $BACKEND_PORT: free"
  fi
  owner="$(port_owner "$WEB_PORT")"
  if [ -n "$owner" ]; then
    info "web port $WEB_PORT: in use by $owner"
  else
    info "web port $WEB_PORT: free"
  fi
}

check_tailscale() {
  say "Tailscale"
  command -v tailscale >/dev/null 2>&1 || {
    warn "tailscale not installed — the app stays reachable on localhost only"
    return 0
  }
  local target="http://127.0.0.1:$WEB_PORT"
  if tailscale serve status 2>/dev/null | grep -q "proxy $target"; then
    local host
    host="$(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | cut -d'"' -f4)"
    info "serving ${host%.}:$TAILSCALE_PORT -> $target (tailnet only)"
  else
    warn "no tailscale serve mapping to $target"
    warn "add it with: bin/teams-lite-service.sh tailscale"
  fi
}

configure_tailscale() {
  command -v tailscale >/dev/null 2>&1 || die "tailscale not installed"
  say "Publishing the web UI on the tailnet…"
  # `serve`, never `funnel`: serve is tailnet-only, behind Tailscale's own
  # authenticated HTTPS. Funnel would publish the user's Teams account to the
  # internet, send included, because the page fetches the write token from this
  # same server.
  tailscale serve --bg --https="$TAILSCALE_PORT" "http://127.0.0.1:$WEB_PORT"
  check_tailscale
}

# --- the local agent ---------------------------------------------------------

# How many agent runs are writing a reply right now.
#
# One marker file per run, holding the pid of the backend that owns it. The pid is what
# makes a leftover different from a live run: a marker whose process is gone belongs to a
# run something already killed — most often a previous restart — and waiting for it would
# hold every update back for as long as the file sits there.
live_agent_runs() {
  local file pid count=0
  if [ -n "$AGENT_RUN_DIR" ] && [ -d "$AGENT_RUN_DIR" ]; then
    for file in "$AGENT_RUN_DIR"/*; do
      [ -f "$file" ] || continue
      pid="$(sed -n 's/^pid=//p' "$file" | head -1)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        count=$((count + 1))
      fi
    done
  fi
  printf '%s' "$count"
}

# Hold the restart while the local agent is mid-answer.
#
# A restart kills the CLI child, so the reply stops growing where it stood and the thread
# is left with a body that says the agent is thinking. Waiting is the only way the reader
# gets the answer they asked for — nothing can resume a run.
#
# Bounded, and it never fails: after AGENT_WAIT_SECONDS it says so and lets the restart
# through, because the alternative is a stuck run keeping the user's phone on an old
# commit indefinitely. The reply that dies then is closed by the backend that comes up.
wait_for_quiet_agent() {
  local live waited=0
  live="$(live_agent_runs)"
  [ "$live" = 0 ] && return 0

  say "Waiting for the local agent to finish…"
  info "$live run(s) writing a reply — a restart would freeze it mid-answer"
  while [ "$(live_agent_runs)" != 0 ] && [ "$waited" -lt "$AGENT_WAIT_SECONDS" ]; do
    sleep 5
    waited=$((waited + 5))
    [ $((waited % 60)) = 0 ] && info "still writing after ${waited}s"
  done
  if [ "$(live_agent_runs)" != 0 ]; then
    warn "gave up after ${waited}s: restarting anyway — the reply will be marked interrupted"
  else
    info "the agent is quiet after ${waited}s"
  fi
}

# --- reporting ---------------------------------------------------------------

print_units_state() {
  say "Units"
  local unit state enabled
  for unit in "${UNITS[@]}"; do
    if [ ! -f "$UNIT_DIR/$unit" ]; then
      info "$unit: not installed"
      continue
    fi
    # Both queries exit non-zero for an inactive or disabled unit and print the
    # answer on stdout, so take the first line and ignore the status.
    state="$("$SYSTEMCTL" --user is-active "$unit" 2>/dev/null | head -1 || true)"
    enabled="$("$SYSTEMCTL" --user is-enabled "$unit" 2>/dev/null | head -1 || true)"
    info "$unit: ${state:-unknown} (${enabled:-not-enabled})"
  done
  # A retired unit still on disk is one a later run takes back (see RETIRED_UNITS) — said
  # here so it does not read as part of the current install. The hint names `update`, never
  # `units`: this is exactly the state of a machine still staged from before the change,
  # where `units` refuses (it would put the new units in front of the old binary) and a
  # backend left running that build is what keeps them — and `update` is the one run that
  # stages the current backend, restarts onto it and retires them, whichever case this is.
  for unit in "${RETIRED_UNITS[@]}"; do
    [ -f "$UNIT_DIR/$unit" ] || continue
    warn "$unit: retired but still installed — 'bin/teams-lite-service.sh update' removes it"
  done
}

print_artifact() {
  say "Staged artifact"
  if [ -f "$SERVICE_DIR/VERSION" ]; then
    sed 's/^/  /' "$SERVICE_DIR/VERSION"
  else
    info "nothing staged in $SERVICE_DIR"
  fi
}

# The other install on this machine: the released `teams` binary the app unit runs. It
# is not staged and not built here — install.sh downloads it, and the in-app update
# button replaces it — so what `status` can say about it is whether it is there.
print_released_build() {
  say "Released build (teams-lite-app.service)"
  if [ -x "$APP_BIN" ]; then
    info "$APP_BIN"
    info "backend $APP_BACKEND_PORT, web http://127.0.0.1:$APP_WEB_PORT"
    info "updates itself: the app's own button replaces this binary"
  else
    warn "not installed at $APP_BIN — teams-lite-app.service would fail to start"
    warn "install it with: curl -fsSL $INSTALL_SH_URL | sh"
  fi
}

print_next_steps() {
  cat <<EOF

$(say "Next step — yours to run")
  systemctl --user enable --now teams-lite.target

  The backend is send-capable: it signs in as you and can post messages, so
  starting it is deliberately not automated.

  Then, from any device on your tailnet:
    https://$(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | cut -d'"' -f4 | sed 's/\.$//'):$TAILSCALE_PORT

  Follow it with:
    journalctl --user -u teams-lite-backend -u teams-lite-web -f

$(say "Optional — the RELEASED build, beside this one")
  The staged pair above follows your checkout. The published build can run at the
  same time, on ports of its own ($APP_BACKEND_PORT / $APP_WEB_PORT), and it is the
  only install that can update itself from inside the app:

    curl -fsSL $INSTALL_SH_URL | sh
    systemctl --user enable --now teams-lite-app.service

  Both are send-capable, so that second command is yours to run too. They share the
  message store, which two backends here already do, and the released one answers on
  http://127.0.0.1:$APP_WEB_PORT. For the tailnet, give it a port of its own:
    tailscale serve --bg --https=8444 http://127.0.0.1:$APP_WEB_PORT
EOF
}

# --- subcommands -------------------------------------------------------------

cmd_install() {
  build_artifacts
  stage_artifacts
  # `install` starts and restarts nothing, so a backend already running keeps what it lives by.
  install_units --no-restart-follows
  check_environment
  check_tailscale
  print_next_steps
}

cmd_update() {
  local wait_for_agent=yes
  while [ $# -gt 0 ]; do
    case "$1" in
      --now) wait_for_agent=no ;;
      *) die "unknown option '$1' for update (try --now)" ;;
    esac
    shift
  done

  # Build first: it writes into the checkout's own target/ and web/dist, so it touches
  # nothing the running service reads and it costs about a minute nobody has to wait for.
  build_artifacts
  # Then wait, BEFORE anything staged is replaced. Staging breaks the running web server
  # on its next lazy import (see WHY IT WAITS BEFORE IT STAGES above), so everything that
  # replaces a live artifact goes after this line and as close to the restart as it can.
  [ "$wait_for_agent" = no ] || wait_for_quiet_agent
  stage_artifacts
  # The restart below follows at once, so an old backend outlives the retirement by the
  # seconds that takes and nothing needs keeping for it.
  install_units --restart-follows
  # Restart only what is already running: an update must not start a service the
  # user chose to keep down.
  say "Restarting whatever is running…"
  # The app unit too: `units` may have rewritten it, and `try-restart` does nothing when
  # it is not running. It restarts onto the SAME released binary — an `update` builds the
  # staged artifacts and never touches that one, which the app's own button owns.
  "$SYSTEMCTL" --user try-restart teams-lite-backend.service teams-lite-web.service \
    teams-lite-app.service
  print_units_state
  print_artifact
}

cmd_status() {
  print_units_state
  print_artifact
  print_released_build
  # Why an update may be sitting there doing nothing: it is waiting for this.
  say "Local agent"
  info "$(live_agent_runs) run(s) writing a reply"
  check_environment
  check_tailscale
}

cmd_logs() {
  exec journalctl --user -u teams-lite-backend.service -u teams-lite-web.service \
    -u teams-lite-app.service "$@"
}

cmd_stop() {
  "$SYSTEMCTL" --user stop teams-lite.target teams-lite-backend.service \
    teams-lite-web.service teams-lite-app.service
  print_units_state
}

cmd_uninstall() {
  say "Stopping and disabling…"
  "$SYSTEMCTL" --user disable --now teams-lite.target 2>/dev/null || true
  "$SYSTEMCTL" --user disable --now teams-lite-app.service 2>/dev/null || true
  "$SYSTEMCTL" --user stop teams-lite-backend.service teams-lite-web.service 2>/dev/null || true
  "$SYSTEMCTL" --user disable teams-lite-backend.service teams-lite-web.service 2>/dev/null || true
  # What an older version installed goes too, by the same rules `units` retires it under —
  # or an uninstall would leave the broker watchers enabled, restarting backends that are
  # no longer installed every time the container boots.
  retire_old_units
  local unit
  for unit in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$unit"; done
  "$SYSTEMCTL" --user daemon-reload
  reset_retired_units
  retire_old_scripts
  say "Removed the units. Left alone on purpose:"
  info "$SERVICE_DIR (staged artifacts — delete it by hand if you want it gone)"
  info "$DATA_HOME/teams-lite/teams-lite.sqlite (your local message store)"
  info "the tailscale serve mapping (tailscale serve --https=$TAILSCALE_PORT off)"
}

usage() {
  # The title and the subcommand list — up to the blank line that ends it, so a note
  # added to the header below never spills half a paragraph into the help.
  sed -n '2,13p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

main() {
  case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    update) shift; cmd_update "$@" ;;
    units) shift; install_units --no-restart-follows "$@" ;;
    status) shift; cmd_status "$@" ;;
    logs) shift; cmd_logs "$@" ;;
    tailscale) shift; configure_tailscale "$@" ;;
    stop) shift; cmd_stop "$@" ;;
    uninstall) shift; cmd_uninstall "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown subcommand '$1' (try --help)" ;;
  esac
}

main "$@"

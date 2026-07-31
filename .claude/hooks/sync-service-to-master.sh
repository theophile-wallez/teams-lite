#!/usr/bin/env bash
# Keep the always-on service on master — without ever bringing it up.
#
# A PostToolUse hook on Bash. It fires after a git command that can move master. It
# fast-forwards the checkout, compares the staged artifact's commit with HEAD, and —
# when they differ — re-stages and restarts the service through
# `bin/teams-lite-service.sh update`, in a detached background job so the session
# never waits for the build.
#
# WHY A HOOK. The service runs a COPY of the built artifacts, promoted on purpose
# (see the header of bin/teams-lite-service.sh). That is the right default, but it has
# one failure mode: work lands on master, nobody re-stages, and the user's phone
# serves a commit from days ago while every test in the repo passes. The comparison is
# on the commit, so the hook is a no-op whenever the artifact is already current.
#
# WHAT IT WILL NOT DO — the guardrails, in the order they are checked:
#
#   1. It never STARTS the service. It acts only when a unit is already active, and
#      `update` uses `systemctl try-restart`, which is a no-op on a stopped unit. The
#      backend is send-capable, so bringing it up stays the user's call — the rule
#      .claude/hooks/guard-live-automation.sh enforces for every other entry point.
#   2. It never stages a working tree nobody promoted. The checkout must be on master
#      and clean, because `update` builds the tree as it stands: one uncommitted edit
#      would otherwise reach the user's phone.
#   3. It never guesses which checkout feeds the service. The path comes from git
#      itself (--git-common-dir), so a session running in .worktrees/<task> stages
#      master from the main checkout, not its own branch.
#   4. It never runs twice at once. The background job holds an flock, so a burst of
#      git commands produces one build.
#
# Everything it does is logged to $XDG_STATE_HOME/teams-lite/service-auto-update.log.
set -euo pipefail

LOCK_FILE="${TMPDIR:-/tmp}/teams-lite-service-auto-update.lock"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
LOG_FILE="$STATE_HOME/teams-lite/service-auto-update.log"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
SERVICE_DIR="${TEAMS_LITE_SERVICE_DIR:-$DATA_HOME/teams-lite/service}"
SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"
UNITS=(teams-lite-backend.service teams-lite-web.service)

# The systemd user manager and the hook runner both start with a thin PATH, and the
# build needs cargo and bun.
PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
export PATH

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# Emit the one message the user sees in the session — and give the model the same
# text, so a skipped update is something it can act on rather than a silent no-op.
report() {
  jq -nc --arg m "$1" '{
    systemMessage: $m,
    suppressOutput: true,
    hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m},
  }'
  exit 0
}

# The checkout that feeds the service, resolved by git rather than by the caller's cwd
# — a worktree session must stage master, not its own branch.
service_checkout() {
  local common_dir
  common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || return 1
  dirname "$(readlink -f "$common_dir")"
}

# Guardrail 2, as a function: `update` builds the tree as it stands, so refuse
# anything but a clean master. Prints the reason.
checkout_is_promotable() {
  local checkout="$1" branch
  branch="$(git -C "$checkout" symbolic-ref --quiet --short HEAD 2>/dev/null || echo DETACHED)"
  if [ "$branch" != master ]; then
    printf "%s is on '%s', not master" "$checkout" "$branch"
    return 1
  fi
  if [ -n "$(git -C "$checkout" status --porcelain)" ]; then
    printf '%s has uncommitted changes' "$checkout"
    return 1
  fi
}

staged_commit() {
  [ -f "$SERVICE_DIR/VERSION" ] || return 0
  sed -n 's/^commit=//p' "$SERVICE_DIR/VERSION"
}

service_is_running() {
  local unit
  for unit in "${UNITS[@]}"; do
    [ "$("$SYSTEMCTL" --user is-active "$unit" 2>/dev/null)" = active ] && return 0
  done
  return 1
}

# --- the background job ------------------------------------------------------
# Re-entered as `$0 --run <checkout>`, detached from the session, holding the lock.

run_update() {
  local checkout="$1"
  mkdir -p "$(dirname "$LOG_FILE")"
  exec >>"$LOG_FILE" 2>&1

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "skip: another update holds the lock"
    return 0
  fi

  # Re-check every gate under the lock. The build takes about a minute, so the state
  # that justified this job may have moved — and a job started by hand skips the hook
  # path entirely, so this is where the gates have to hold.
  [ -x "$checkout/bin/teams-lite-service.sh" ] || {
    log "skip: no service script in $checkout"
    return 0
  }
  service_is_running || {
    log "skip: no unit is active — starting the service is the user's call"
    return 0
  }
  local reason
  if ! reason="$(checkout_is_promotable "$checkout")"; then
    log "skip: $reason"
    return 0
  fi

  # Land what the push just published. `--ff-only` is the whole safety of this line:
  # it either fast-forwards master or fails, and never rewrites the user's checkout.
  # (~/.claude/settings.json has a hook that pulls too; a second ff-only pull of the
  # same ref is a no-op, and owning the pull here is what makes the compare below
  # independent of which hook ran first.)
  git -C "$checkout" pull --ff-only origin master >/dev/null 2>&1 ||
    log "note: pull --ff-only did not move master"

  local head staged
  staged="$(staged_commit)"
  head="$(git -C "$checkout" rev-parse HEAD)"
  if [ "$staged" = "$head" ]; then
    log "skip: already serving $head"
    return 0
  fi

  log "update: staged=$staged head=$head checkout=$checkout"
  if "$checkout/bin/teams-lite-service.sh" update; then
    log "update: done, now serving $head"
  else
    log "update: FAILED (exit $?) — the service still serves $(staged_commit)"
  fi
}

# --- the hook ----------------------------------------------------------------

main() {
  command -v jq >/dev/null 2>&1 || exit 0

  local command
  command="$(jq -r '.tool_input.command // ""')"
  # Only a command that can move master is worth a state check.
  printf '%s' "$command" |
    grep -qE '\bgit\b.*\b(push|pull|fetch|merge|rebase|commit|cherry-pick|reset|am)\b' || exit 0

  # Guardrail 3.
  local checkout
  checkout="$(service_checkout)" || exit 0
  [ -x "$checkout/bin/teams-lite-service.sh" ] || exit 0

  # Nothing staged means the service was never installed, and installing it is not
  # this hook's business.
  local staged head
  staged="$(staged_commit)"
  [ -n "$staged" ] || exit 0
  head="$(git -C "$checkout" rev-parse HEAD 2>/dev/null)" || exit 0

  # Guardrail 1: only ever a restart of something already up.
  service_is_running || exit 0

  # A command that touches the remote is worth a job even when the local state looks
  # current: the job pulls first, so it is the only place that can see a commit still
  # sitting on origin. That case stays silent here — most such jobs find nothing.
  local gap=no touches_remote=no
  [ "$staged" != "$head" ] && gap=yes
  printf '%s' "$command" | grep -qE '\bgit\b.*\b(push|pull|fetch)\b' && touches_remote=yes
  [ "$gap" = yes ] || [ "$touches_remote" = yes ] || exit 0

  # Guardrail 2: stage a promoted commit, not a work in progress. Silent unless the
  # gap is already visible — an unrelated commit on a task branch is not a warning.
  local reason
  if ! reason="$(checkout_is_promotable "$checkout")"; then
    [ "$gap" = yes ] || exit 0
    report "The always-on service still serves ${staged:0:12}: $reason, and 'update' builds the tree as it stands. Land the work on a clean master, then run bin/teams-lite-service.sh update."
  fi

  mkdir -p "$(dirname "$LOG_FILE")"
  setsid nohup "$(readlink -f "${BASH_SOURCE[0]}")" --run "$checkout" >/dev/null 2>&1 &
  [ "$gap" = yes ] || exit 0
  report "Updating the always-on service: ${staged:0:12} → ${head:0:12}. It rebuilds in the background (about a minute), then restarts the running units, so open pages reconnect. Log: $LOG_FILE"
}

if [ "${1:-}" = --run ]; then
  run_update "$2"
else
  main
fi

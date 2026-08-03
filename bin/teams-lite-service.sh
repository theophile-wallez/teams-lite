#!/usr/bin/env bash
# teams-lite as an always-on background service: build, stage, install, inspect.
#
#   bin/teams-lite-service.sh install     # build + stage + write the units (starts nothing)
#   bin/teams-lite-service.sh update      # rebuild + restage, then restart what is running
#   bin/teams-lite-service.sh units       # rewrite + verify the units only (no build)
#   bin/teams-lite-service.sh status      # units, ports, artifact, broker, tailscale
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
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
BIN_DIR="$(dirname "$SCRIPT_PATH")"
REPO="$(dirname "$BIN_DIR")"

# --- layout ------------------------------------------------------------------
# The two directory overrides exist so the generated units can be inspected — and
# verified with `systemd-analyze verify` — without writing into the live unit
# directory. Nothing else should set them.
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
SERVICE_DIR="${TEAMS_LITE_SERVICE_DIR:-$DATA_HOME/teams-lite/service}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/teams-lite"
UNIT_DIR="${TEAMS_LITE_UNIT_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
CONTAINER_STATE="${TEAMS_LITE_CONTAINER_STATE:-$DATA_HOME/intune-container/rootless.json}"

# --- ports (defaults must match the code: src/bin/server.rs, web/server.ts) ---
BACKEND_PORT="${TEAMS_LITE_PORT:-19420}"
WEB_PORT="${TEAMS_LITE_WEB_PORT:-19440}"
# The tailnet-facing HTTPS port `tailscale serve` publishes. 443 is often already
# taken on a machine that serves something else, so 8443 is the default here.
TAILSCALE_PORT="${TEAMS_LITE_TAILSCALE_PORT:-8443}"

UNITS=(
  teams-lite-backend.service
  teams-lite-web.service
  teams-lite-backend-restart.service
  teams-lite-broker-bus.path
  teams-lite-broker-repair.service
  teams-lite-broker-health.service
  teams-lite-broker-health.timer
  teams-lite.target
)

BUN="${BUN:-$HOME/.bun/bin/bun}"
SYSTEMCTL="$(command -v systemctl || echo /usr/bin/systemctl)"
# Baked into the repair unit at install time, because the systemd user manager's PATH
# has no ~/.local/bin. The fallback keeps the token substituted on a host that has no
# intune-container at all; the unit's ConditionFileIsExecutable= then makes it inert
# rather than broken.
INTUNE_CONTAINER="${INTUNE_CONTAINER:-$(command -v intune-container || echo "$HOME/.local/bin/intune-container")}"

# The backend PATH, baked into the unit. The systemd user manager's own PATH holds
# neither of the two directories a coding-agent CLI installs itself into, so the local
# agent (`@claude` in a thread) finds no program and drops every trigger. The user's
# directories come first, because a self-updating CLI lives there and must win over an
# older packaged copy.
AGENT_PATH="${TEAMS_LITE_AGENT_PATH:-$HOME/.local/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() {
  printf 'teams-lite-service: %s\n' "$*" >&2
  exit 1
}

# --- build -------------------------------------------------------------------

build_artifacts() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found; install Rust first"
  [ -x "$BUN" ] || die "bun not found at $BUN (set BUN=/path/to/bun)"

  say "Building the backend (release)…"
  # Bake the commit so the running service can say what it serves (build.rs reads it).
  TEAMS_BUILD_REV="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)" \
    cargo build --release --manifest-path "$REPO/Cargo.toml" --bin server

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
      TEAMS_BUILD_REV="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)" \
      "$BUN" run build)
}

# --- stage -------------------------------------------------------------------

stage_artifacts() {
  local server_bin="$REPO/target/release/server"
  [ -x "$server_bin" ] || die "no release backend at $server_bin — run 'install' or 'update'"

  say "Staging into $SERVICE_DIR…"
  mkdir -p "$SERVICE_DIR"

  # Replace the binary through a temp file + rename: an atomic swap, so a running
  # backend keeps its open file and the next start gets the new one.
  install -m 0755 "$server_bin" "$SERVICE_DIR/server.new"
  mv -f "$SERVICE_DIR/server.new" "$SERVICE_DIR/server"

  install -m 0755 "$BIN_DIR/teams-lite-backend.sh" "$SERVICE_DIR/teams-lite-backend.sh"
  install -m 0755 "$BIN_DIR/teams-lite-broker-check.sh" "$SERVICE_DIR/teams-lite-broker-check.sh"
  install -m 0644 "$BIN_DIR/broker-env.sh" "$SERVICE_DIR/broker-env.sh"

  # The web runtime file set is owned by web/scripts/stage-bundle.ts, so this script
  # and cli/build.ts cannot drift apart on what the server needs.
  (cd "$REPO/web" && "$BUN" run scripts/stage-bundle.ts "$SERVICE_DIR/web")

  local commit
  commit="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
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

install_units() {
  say "Writing the units into $UNIT_DIR…"
  mkdir -p "$UNIT_DIR" "$CONFIG_DIR"
  local unit
  for unit in "${UNITS[@]}"; do
    [ -f "$REPO/packaging/systemd/$unit" ] || die "missing template: packaging/systemd/$unit"
    sed \
      -e "s|@SERVICE_DIR@|$SERVICE_DIR|g" \
      -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
      -e "s|@CONTAINER_STATE@|$CONTAINER_STATE|g" \
      -e "s|@REPO@|$REPO|g" \
      -e "s|@BUN@|$BUN|g" \
      -e "s|@SYSTEMCTL@|$SYSTEMCTL|g" \
      -e "s|@INTUNE_CONTAINER@|$INTUNE_CONTAINER|g" \
      -e "s|@AGENT_PATH@|$AGENT_PATH|g" \
      -e "s|@BACKEND_PORT@|$BACKEND_PORT|g" \
      -e "s|@WEB_PORT@|$WEB_PORT|g" \
      "$REPO/packaging/systemd/$unit" >"$UNIT_DIR/$unit"
    info "$unit"
  done

  # Leftover placeholders mean a template gained a token this script does not know:
  # fail loudly rather than install a unit systemd will reject at start time.
  local leftovers
  leftovers="$(grep -l '@[A-Z_]\+@' "${UNITS[@]/#/$UNIT_DIR/}" 2>/dev/null || true)"
  [ -z "$leftovers" ] || die "unsubstituted placeholders in: $leftovers"

  # Let systemd itself judge the result, while a mistake is still one sed away.
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze --user verify "${UNITS[@]/#/$UNIT_DIR/}" ||
      die "systemd rejected the generated units (see the errors above)"
  fi

  [ -n "${TEAMS_LITE_UNIT_DIR:-}" ] || "$SYSTEMCTL" --user daemon-reload
}

# --- checks ------------------------------------------------------------------

port_owner() {
  # Who listens on $1, or nothing. `ss` prints the process for our own sockets.
  ss -ltnp "sport = :$1" 2>/dev/null | awk 'NR>1 {print $NF; exit}'
}

check_environment() {
  say "Environment"

  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" = "yes" ]; then
    info "linger: enabled (the service survives logout and starts at boot)"
  else
    warn "linger is OFF — the service would stop at logout. Fix: loginctl enable-linger $USER"
  fi

  # shellcheck source=bin/broker-env.sh
  . "$BIN_DIR/broker-env.sh"
  local bus
  bus="$(teams_lite_broker_bus)"
  if [ -n "$bus" ]; then
    info "identity broker: on the container bus ($bus)"
  elif teams_lite_broker_on_session_bus; then
    info "identity broker: on this session bus"
  else
    warn "identity broker unreachable — sign-in will fail. Try: intune-container start"
  fi

  if [ -x "$INTUNE_CONTAINER" ]; then
    # The keyring re-locks on its own, so the repair path matters as much as the broker.
    local keyring=0
    "$BIN_DIR/teams-lite-broker-check.sh" >/dev/null 2>&1 || keyring=$?
    case "$keyring" in
      0) info "container keyring: unlocked ($INTUNE_CONTAINER can repair it)" ;;
      1) warn "container keyring is LOCKED — no tokens. Repair: systemctl --user start teams-lite-broker-repair" ;;
      *) info "container keyring: unknown (no secret service on the container bus)" ;;
    esac
  else
    warn "no intune-container at $INTUNE_CONTAINER — the in-app repair button stays hidden"
  fi

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
}

print_artifact() {
  say "Staged artifact"
  if [ -f "$SERVICE_DIR/VERSION" ]; then
    sed 's/^/  /' "$SERVICE_DIR/VERSION"
  else
    info "nothing staged in $SERVICE_DIR"
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
EOF
}

# --- subcommands -------------------------------------------------------------

cmd_install() {
  build_artifacts
  stage_artifacts
  install_units
  check_environment
  check_tailscale
  print_next_steps
}

cmd_update() {
  build_artifacts
  stage_artifacts
  install_units
  # Restart only what is already running: an update must not start a service the
  # user chose to keep down.
  say "Restarting whatever is running…"
  "$SYSTEMCTL" --user try-restart teams-lite-backend.service teams-lite-web.service
  print_units_state
  print_artifact
}

cmd_status() {
  print_units_state
  print_artifact
  check_environment
  check_tailscale
}

cmd_logs() {
  exec journalctl --user -u teams-lite-backend.service -u teams-lite-web.service "$@"
}

cmd_stop() {
  "$SYSTEMCTL" --user stop teams-lite.target teams-lite-backend.service teams-lite-web.service
  print_units_state
}

cmd_uninstall() {
  say "Stopping and disabling…"
  "$SYSTEMCTL" --user disable --now teams-lite.target 2>/dev/null || true
  "$SYSTEMCTL" --user stop teams-lite-backend.service teams-lite-web.service 2>/dev/null || true
  "$SYSTEMCTL" --user disable teams-lite-backend.service teams-lite-web.service \
    teams-lite-broker-bus.path 2>/dev/null || true
  local unit
  for unit in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$unit"; done
  "$SYSTEMCTL" --user daemon-reload
  say "Removed the units. Left alone on purpose:"
  info "$SERVICE_DIR (staged artifacts — delete it by hand if you want it gone)"
  info "$DATA_HOME/teams-lite/teams-lite.sqlite (your local message store)"
  info "the tailscale serve mapping (tailscale serve --https=$TAILSCALE_PORT off)"
}

usage() {
  sed -n '2,20p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

main() {
  case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    update) shift; cmd_update "$@" ;;
    units) shift; install_units "$@" ;;
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

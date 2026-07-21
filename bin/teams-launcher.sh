#!/usr/bin/env bash
# teams-lite launcher — reaches the Microsoft Identity Broker over D-Bus in either
# of the two Intune topologies teams-lite supports.
#
# SUPPORTED TOPOLOGIES
#   1. Classic Intune  — the broker (com.microsoft.identity.broker1) runs as the
#      real user and owns its well-known name on the HOST session bus
#      (/run/user/<uid>/bus). Nothing special is needed: zbus::Connection::session()
#      finds it straight away, so we just launch the binary directly.
#
#   2. Containerized Intune — the broker runs inside a rootless container on its
#      OWN session bus (/run/user/0/bus), not the host session bus. Two things then
#      block a plain launch:
#        a. The well-known name is absent from our bus, so
#           zbus::Connection::session() can't find the broker at all.
#        b. The container maps container-uid 0 -> host-uid <uid>, and the bus
#           enforces D-Bus EXTERNAL auth by uid. zbus sends our host uid, which the
#           bus rejects ("EXTERNAL rejected").
#      Entering the container's USER namespace (nsenter -U) makes our process
#      present as the mapped uid 0, so EXTERNAL succeeds. Keeping the host MOUNT
#      namespace lets the binary and the host filesystem stay visible; the bus is
#      reached via /proc/<broker-pid>/root/run/user/0/bus. We pin HOME/XDG_* to the
#      real user so the SQLite store and cache land in ~/.local/share, not /root.
#
#   The UI process spawns the Rust backend as a child that inherits our env and
#   namespaces, so wrapping this single entry point fixes both processes.
#
# DETECTION ORDER
#   • Broker name already on the host session bus  -> classic mode, direct launch.
#   • Otherwise, a broker process found running     -> containerized mode, bridge
#     into its user namespace and point D-Bus at its bus.
#   • Neither                                       -> launch directly and let the
#     binary surface its own "broker unreachable" error (no silent magic, no hang).
set -euo pipefail

# Absolute path to the compiled `teams` binary this launcher wraps.
TEAMS_BIN="${TEAMS_LITE_BIN:-/home/ubuntu/GitHub/teams-lite/ui/dist/teams}"

# Match the real broker by its full binary path. This deliberately does NOT match
# the separate `microsoft-identity-device-broker`, whose path differs.
BROKER_MATCH='identity-broker/bin/microsoft-identity-broker'

# The broker's well-known D-Bus name (same in both topologies).
BROKER_DBUS_NAME='com.microsoft.identity.broker1'

# Guard against infinite re-exec: once we're inside the namespace we set this and
# fall straight through to exec-ing the binary. A compiled Bun binary reads
# bunfig.toml from the CURRENT directory at startup, so run from the binary's own
# directory to avoid picking up another project's bunfig (mirrors install.sh).
if [ "${TEAMS_LITE_IN_NS:-}" = "1" ]; then
  cd "$(dirname "$TEAMS_BIN")" || exit 1
  exec "$TEAMS_BIN" "$@"
fi

if [ ! -x "$TEAMS_BIN" ]; then
  echo "teams-lite: binary not found at $TEAMS_BIN" >&2
  echo "  build it with: (cd ui && bun run build)  or set TEAMS_LITE_BIN" >&2
  exit 1
fi

# Run the binary directly from its own directory (bunfig.toml reasons, see above).
launch_direct() {
  cd "$(dirname "$TEAMS_BIN")" || exit 1
  exec "$TEAMS_BIN" "$@"
}

# --- Topology 1: classic Intune (broker on the host session bus) ----------------
# If the well-known name is already claimed on our own session bus, the broker runs
# as us and no bridging is needed. `busctl --user` reads DBUS_SESSION_BUS_ADDRESS,
# the same address zbus::Connection::session() will use.
if command -v busctl >/dev/null 2>&1 &&
   busctl --user --list --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$BROKER_DBUS_NAME"; then
  launch_direct "$@"
fi

# --- Topology 2: containerized Intune (broker in a rootless container) -----------
# Resolve the broker PID dynamically (PIDs are volatile across broker restarts).
BROKER_PID="$(pgrep -f "$BROKER_MATCH" | head -1 || true)"

if [ -z "$BROKER_PID" ]; then
  echo "teams-lite: identity broker not found on the session bus or as a running" \
       "process — start Intune first (classic sign-in, or 'intune-container start')." \
       "Launching anyway; sign-in will fail if the broker stays down." >&2
  launch_direct "$@"
fi

BROKER_BUS="/proc/$BROKER_PID/root/run/user/0/bus"
if [ ! -S "$BROKER_BUS" ]; then
  echo "teams-lite: broker process $BROKER_PID has no container bus at $BROKER_BUS" \
       "— launching directly (sign-in may fail)." >&2
  launch_direct "$@"
fi

# Re-exec the whole launcher inside the broker's user namespace (uid maps to 0 so
# D-Bus EXTERNAL auth is accepted) while keeping the host mount namespace (so the
# binary and $HOME stay visible). Env is pinned to the real user's dirs.
exec sudo nsenter -t "$BROKER_PID" -U -- \
  env \
    TEAMS_LITE_IN_NS=1 \
    TEAMS_LITE_BIN="$TEAMS_BIN" \
    HOME="$HOME" \
    XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}" \
    XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$BROKER_BUS" \
    "$0" "$@"

#!/usr/bin/env bash
# teams-lite launcher — reaches the Microsoft Identity Broker over D-Bus in either
# of the two Intune topologies teams-lite supports, WITHOUT ever needing sudo.
#
# SUPPORTED TOPOLOGIES
#   1. Classic Intune — the broker (com.microsoft.identity.broker1) runs as the
#      real user and owns its well-known name on the HOST session bus
#      (/run/user/<uid>/bus). Nothing special is needed: zbus::Connection::session()
#      finds it straight away, so we launch the binary directly.
#
#   2. Containerized Intune (e.g. the `intune-container` project) — the broker runs
#      inside a rootless container as the SAME host user (container-root is mapped
#      to our host uid), on the container's own session bus at
#      /run/user/0/bus. That socket is reachable from the host, unprivileged, via
#      /proc/<broker-pid>/root/run/user/0/bus, and the bus does NOT enforce D-Bus
#      EXTERNAL auth by uid — so we just point DBUS_SESSION_BUS_ADDRESS at it and
#      connect directly. No nsenter, no sudo, no namespace juggling.
#
#   The UI process spawns the Rust backend as a child that inherits our env, so
#   wrapping this single entry point fixes both processes.
#
# DETECTION ORDER
#   • Broker name already on the host session bus  -> classic mode, direct launch.
#   • Otherwise, a broker process found running     -> containerized mode, point
#     D-Bus at its in-container bus and launch directly.
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

if [ ! -x "$TEAMS_BIN" ]; then
  echo "teams-lite: binary not found at $TEAMS_BIN" >&2
  echo "  build it with: (cd ui && bun run build)  or set TEAMS_LITE_BIN" >&2
  exit 1
fi

# Run the binary from its own directory: a compiled Bun binary reads bunfig.toml
# from the CURRENT directory at startup, so running inside another Bun project
# (whose bunfig has a `preload`) would crash. teams-lite doesn't care about the
# working directory (logs go to /tmp, database to the XDG data dir, both absolute).
launch() {
  cd "$(dirname "$TEAMS_BIN")" || exit 1
  exec "$TEAMS_BIN" "$@"
}

# --- Topology 1: classic Intune (broker on the host session bus) ----------------
# If the well-known name is already claimed on our own session bus, the broker runs
# as us and no bridging is needed. `busctl --user` reads DBUS_SESSION_BUS_ADDRESS,
# the same address zbus::Connection::session() will use.
if command -v busctl >/dev/null 2>&1 &&
   busctl --user --list --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$BROKER_DBUS_NAME"; then
  launch "$@"
fi

# --- Topology 2: containerized Intune (broker in a rootless container) -----------
# The broker runs as our host user inside the container, so its session bus socket
# is reachable unprivileged at /proc/<pid>/root/run/user/0/bus. Point D-Bus there
# and connect directly — no nsenter, no sudo.
BROKER_PID="$(pgrep -f "$BROKER_MATCH" | head -1 || true)"

if [ -z "$BROKER_PID" ]; then
  echo "teams-lite: identity broker not found on the session bus or as a running" \
       "process — start Intune first (classic sign-in, or 'intune-container start')." \
       "Launching anyway; sign-in will fail if the broker stays down." >&2
  launch "$@"
fi

BROKER_BUS="/proc/$BROKER_PID/root/run/user/0/bus"
if [ ! -S "$BROKER_BUS" ]; then
  echo "teams-lite: broker process $BROKER_PID has no reachable bus at $BROKER_BUS" \
       "— launching directly (sign-in may fail)." >&2
  launch "$@"
fi

export DBUS_SESSION_BUS_ADDRESS="unix:path=$BROKER_BUS"
launch "$@"

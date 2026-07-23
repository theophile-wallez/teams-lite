#!/usr/bin/env bash
# teams-lite DEV backend launcher — runs the backend straight from source
# (`cargo run --bin server`) while reaching the Microsoft Identity Broker exactly
# the way the production launcher (bin/teams-launcher.sh) does, and keeping the
# backend alive across frontend disconnects.
#
# Why this exists: `bin/teams-launcher.sh` wraps the COMPILED `teams` binary and
# bridges D-Bus to the broker before exec'ing it. A raw `cargo run --bin server`
# skips that bridging, so on a containerized-Intune host the dev backend can't
# authenticate (D-Bus can't find com.microsoft.identity.broker1 on our own
# session bus). This mirrors the launcher's detection for the dev workflow.
#
# It also sets TEAMS_NO_IDLE_EXIT so the backend only stops on Ctrl+C — handy when
# the browser/dev server disconnects and reconnects during development.
#
# Runs from any directory: the repo root is derived from this script's location,
# and `cargo` locates the workspace manifest from there. See bin/teams-launcher.sh
# for the full explanation of the two Intune topologies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Match the real broker by its full binary path, NOT the separate device-broker.
BROKER_MATCH='identity-broker/bin/microsoft-identity-broker'
BROKER_DBUS_NAME='com.microsoft.identity.broker1'

# Keep the dev backend alive across frontend disconnects (only Ctrl+C stops it).
export TEAMS_NO_IDLE_EXIT="${TEAMS_NO_IDLE_EXIT:-1}"

# --- Topology 1: classic Intune (broker on our own session bus) -----------------
# If the well-known name is already claimed on our session bus, no bridging needed.
if command -v busctl >/dev/null 2>&1 &&
   busctl --user --list --no-legend 2>/dev/null | awk '{print $1}' | grep -qx "$BROKER_DBUS_NAME"; then
  exec cargo run --manifest-path "$REPO_ROOT/Cargo.toml" --bin server "$@"
fi

# --- Topology 2: containerized Intune (broker in a rootless container) -----------
# The broker runs as our host user inside the container, so its session bus socket
# is reachable unprivileged at /proc/<pid>/root/run/user/0/bus. Point D-Bus there.
BROKER_PID="$(pgrep -f "$BROKER_MATCH" | head -1 || true)"
if [ -n "$BROKER_PID" ]; then
  BROKER_BUS="/proc/$BROKER_PID/root/run/user/0/bus"
  if [ -S "$BROKER_BUS" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=$BROKER_BUS"
  else
    echo "teams-lite(dev): broker $BROKER_PID has no reachable bus at $BROKER_BUS" \
         "— starting anyway; sign-in may fail." >&2
  fi
else
  echo "teams-lite(dev): identity broker not found on the session bus or as a" \
       "running process — start Intune first. Starting anyway; sign-in will fail" \
       "if the broker stays down." >&2
fi

exec cargo run --manifest-path "$REPO_ROOT/Cargo.toml" --bin server "$@"

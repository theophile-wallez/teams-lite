#!/usr/bin/env bash
# Resolve the D-Bus session bus that carries the Microsoft Identity Broker, and
# export DBUS_SESSION_BUS_ADDRESS when it is not the bus we already sit on.
#
# SOURCE THIS FILE, do not execute it:
#
#   . "$(dirname "$0")/broker-env.sh"
#   teams_lite_export_broker_bus       # exports DBUS_SESSION_BUS_ADDRESS if needed
#
# WHY IT EXISTS. Every entry point that starts the backend needs the same answer to
# the same question, and the answer used to be copy-pasted in three places
# (bin/teams-launcher.sh, bin/teams-dev-server.sh, the launcher install.sh writes).
# One of those copies drifting is how a backend ends up talking to a bus with no
# broker on it — it starts, authenticates against nothing, and fails at the first
# token. So the detection lives here once.
#
# THE TWO TOPOLOGIES teams-lite supports:
#
#   1. Classic Intune — the broker runs as the real user and owns
#      com.microsoft.identity.broker1 on our own session bus (/run/user/<uid>/bus).
#      Nothing to do: zbus::Connection::session() finds it (see src/auth.rs).
#
#   2. Containerized Intune (the `intune-container` project) — the broker runs
#      inside a rootless container as the SAME host user (container-root is mapped
#      to our host uid), on the container's own session bus at /run/user/0/bus.
#      That socket is reachable from the host, unprivileged, through
#      /proc/<container-pid>/root/run/user/0/bus, and the bus does not enforce
#      D-Bus EXTERNAL auth by uid — so pointing DBUS_SESSION_BUS_ADDRESS at it is
#      enough. No nsenter, no sudo, no namespace juggling.
#
# WHY WE DO NOT LOOK FOR THE BROKER PROCESS FIRST. The obvious handle on topology 2
# is the broker's own PID, and that is what the earlier copies used:
#
#     pgrep -f 'identity-broker/bin/microsoft-identity-broker'
#
# It does not work. The broker is D-Bus *activated*, not resident: the container
# ships /usr/share/dbus-1/services/com.microsoft.identity.broker1.service and no
# systemd unit for it, so most of the time no such process exists and the name is
# merely listed `(activatable)`. The detection then found nothing and fell through
# to the host bus, where the broker is absent altogether.
#
# The stable handle is the CONTAINER, not the broker: `intune-container` records its
# leader (the container's PID 1 on the host) in rootless.json, and that process
# lives exactly as long as the container. Its /proc/<pid>/root/run/user/0/bus is the
# bus the broker activates on. We keep the process probes after it as fallbacks, for
# a host whose container is managed by something that writes no such file.
#
# NOT SOLVED HERE: the resolved path embeds a PID, and a process environment is
# frozen after exec. When the container restarts, the leader changes and a
# long-running backend keeps dialling a socket that no longer exists — it stays up
# and permanently unauthenticated. Re-resolving is a RESTART, which is why the
# service ships a .path unit watching rootless.json (see packaging/systemd/).

# The broker's well-known D-Bus name (identical in both topologies). The separate
# device broker (com.microsoft.identity.devicebroker1) is a different service and
# is deliberately not accepted as a substitute.
TEAMS_LITE_BROKER_DBUS_NAME='com.microsoft.identity.broker1'

# Where `intune-container` records the running container: {"leader": <pid>, …}.
# The leader is the container's PID 1 as seen from the host.
TEAMS_LITE_CONTAINER_STATE="${TEAMS_LITE_CONTAINER_STATE:-$HOME/.local/share/intune-container/rootless.json}"

# Fallback process probes, most specific first. The broker itself when it happens to
# be resident, then the device broker — a different service, but one that runs in
# the SAME container, so its /proc/<pid>/root reaches the same bus.
TEAMS_LITE_BROKER_PROCESS_MATCHES=(
  'identity-broker/bin/microsoft-identity-broker'
  'identity-broker/bin/microsoft-identity-device-broker'
  'intune/bin/intune-daemon'
)

# Does the given bus carry the broker name — owned, or merely activatable? `busctl
# list` reports both, and activatable is the normal case: the first D-Bus call starts
# the broker. Returns 1 when busctl is missing, so such a host falls back to the
# weaker "the socket exists" test rather than refusing to start.
teams_lite_broker_on_bus() {
  local address="$1"
  command -v busctl >/dev/null 2>&1 || return 1
  busctl --address="$address" --list --no-legend 2>/dev/null |
    awk '{print $1}' | grep -qx "$TEAMS_LITE_BROKER_DBUS_NAME"
}

# Is the broker already reachable on the session bus we inherited? Then this is
# topology 1 (or someone already pointed us at the right bus) and we must not
# rewrite the address.
teams_lite_broker_on_session_bus() {
  command -v busctl >/dev/null 2>&1 || return 1
  busctl --user --list --no-legend 2>/dev/null |
    awk '{print $1}' | grep -qx "$TEAMS_LITE_BROKER_DBUS_NAME"
}

# The container leader PID from rootless.json, or nothing. Parsed with grep rather
# than jq/python so this file has no dependency beyond coreutils: the launchers it
# serves must work on a bare host.
teams_lite_container_leader() {
  [ -r "$TEAMS_LITE_CONTAINER_STATE" ] || return 0
  grep -o '"leader"[[:space:]]*:[[:space:]]*[0-9]\+' "$TEAMS_LITE_CONTAINER_STATE" 2>/dev/null |
    grep -o '[0-9]\+$' | head -1
}

# Print the in-container bus address for a host PID, if that process really has one.
teams_lite_bus_for_pid() {
  local pid="$1" socket
  [ -n "$pid" ] || return 1
  socket="/proc/$pid/root/run/user/0/bus"
  [ -S "$socket" ] || return 1
  printf 'unix:path=%s' "$socket"
}

# Print the address of a bus that carries the broker, or nothing. Never exports.
#
# Order: explicit override, the bus we already sit on, the container leader, then
# the process probes. Each candidate must pass teams_lite_broker_on_bus when busctl
# is available, so a stale socket from a half-dead container is skipped instead of
# being handed to the backend as if it were good.
teams_lite_broker_bus() {
  local address pid

  # An operator override, for a topology this script does not know about.
  if [ -n "${TEAMS_LITE_BROKER_BUS:-}" ]; then
    printf '%s' "$TEAMS_LITE_BROKER_BUS"
    return 0
  fi

  # Topology 1: already reachable. Print nothing — "no change needed".
  if teams_lite_broker_on_session_bus; then
    return 0
  fi

  # Topology 2, by container: the handle that lives as long as the container.
  if address="$(teams_lite_bus_for_pid "$(teams_lite_container_leader)")" &&
    teams_lite_broker_on_bus "$address"; then
    printf '%s' "$address"
    return 0
  fi

  # Topology 2, by process: for a container managed without rootless.json.
  # `|| true` on every probe: this file is sourced by scripts running under
  # `set -e`, and pgrep exits 1 when it matches nothing, which is the normal case.
  for match in "${TEAMS_LITE_BROKER_PROCESS_MATCHES[@]}"; do
    for pid in $(pgrep -f "$match" 2>/dev/null || true); do
      if address="$(teams_lite_bus_for_pid "$pid")" && teams_lite_broker_on_bus "$address"; then
        printf '%s' "$address"
        return 0
      fi
    done
  done

  return 0
}

# Export DBUS_SESSION_BUS_ADDRESS when the broker lives on another bus.
#
# Deliberately never fatal: the caller starts the backend either way, and the
# backend reports its own "broker unreachable" error. A launcher that refused to
# start would turn a recoverable sign-in problem into a service that never runs —
# and on a machine where the container comes and goes, the retry is the fix.
teams_lite_export_broker_bus() {
  local address
  address="$(teams_lite_broker_bus)"

  if [ -n "$address" ]; then
    export DBUS_SESSION_BUS_ADDRESS="$address"
    return 0
  fi

  if teams_lite_broker_on_session_bus; then
    return 0
  fi

  echo "teams-lite: the identity broker ($TEAMS_LITE_BROKER_DBUS_NAME) is not on this" \
    "session bus, and no Intune container was found — start Intune first (classic" \
    "sign-in, or 'intune-container start'). Continuing; sign-in fails while the" \
    "broker stays unreachable." >&2
  return 0
}

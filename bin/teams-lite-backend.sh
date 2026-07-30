#!/usr/bin/env bash
# ExecStart wrapper for teams-lite-backend.service.
#
# One job: resolve the D-Bus session bus that carries the Microsoft Identity Broker,
# then exec the backend. It exists because systemd's `Environment=` is static while
# the answer is not — on a containerized-Intune host the broker's bus lives at
# /proc/<container-leader>/root/run/user/0/bus, and that PID changes on every
# container boot. See bin/broker-env.sh for the detection and for why the container,
# not the broker process, is the handle.
#
# `exec` matters: the backend replaces this shell, so it stays the unit's MainPID and
# systemd's Type=exec, KillSignal and Restart= all act on the real process.
#
# bin/teams-lite-service.sh copies this file and broker-env.sh next to the release
# binary in the service directory, so the running service depends on no git checkout.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

# The staged copy sits next to the binary; from a checkout, fall back to target/.
SERVER_BIN="${TEAMS_LITE_SERVER_BIN:-$SCRIPT_DIR/server}"
if [ ! -x "$SERVER_BIN" ]; then
  SERVER_BIN="$(dirname "$SCRIPT_DIR")/target/release/server"
fi

if [ ! -x "$SERVER_BIN" ]; then
  echo "teams-lite(service): no backend binary at $SERVER_BIN" >&2
  echo "  install or refresh it with: bin/teams-lite-service.sh update" >&2
  exit 1
fi

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"

# An empty result means "no other bus needed" — either the broker is already on our
# own session bus (classic Intune), or nothing was found at all. Only the second case
# is a failure.
broker_bus="$(teams_lite_broker_bus)"

# Fail the START when no broker is reachable, rather than run a backend that dies on
# its first token call: the journal then names the cause, and `Restart=always` with
# its backoff turns "the container is not up yet" into a retry instead of a dead
# service. 69 is EX_UNAVAILABLE.
if [ -z "$broker_bus" ] && ! teams_lite_broker_on_session_bus; then
  echo "teams-lite(service): no reachable identity broker — is the Intune container up?" >&2
  echo "  check with: intune-container status && intune-container doctor" >&2
  exit 69
fi

# A locked container keyring is not a missing bus: the socket is there, the broker name
# is activatable, and the check above passes — then authentication fails and the backend
# exits, and systemd retries for ever with nobody to fix the cause. So look at the cause
# before starting, and ask for a repair when it is locked.
#
# `--repair` only enqueues the repair unit, which restarts the container. We do not wait
# for it: the restart moves the broker bus, so this start is doomed either way. Exit 69
# (EX_UNAVAILABLE) and let `Restart=always` come back to a repaired container.
#
# ONLY on exit 1, which means "locked". Exit 2 is "cannot tell" — no busctl, a classic
# Intune host, no secret service — and refusing to start on that would turn an unknown
# into an outage.
#
# TEAMS_LITE_BROKER_BUS pins the check to the bus this backend is about to use. Without
# it the check re-resolves on its own, and it would find the broker's name on
# `DBUS_SESSION_BUS_ADDRESS` — which is the CONTAINER's bus once exported — read that as
# a classic-Intune host, and skip the keyring test entirely. It did exactly that once.
if [ -x "$SCRIPT_DIR/teams-lite-broker-check.sh" ]; then
  keyring=0
  TEAMS_LITE_BROKER_BUS="$broker_bus" \
    "$SCRIPT_DIR/teams-lite-broker-check.sh" --repair || keyring=$?
  if [ "$keyring" -eq 1 ]; then
    echo "teams-lite(service): waiting for the broker repair to finish; systemd will retry." >&2
    exit 69
  fi
fi

[ -n "$broker_bus" ] && export DBUS_SESSION_BUS_ADDRESS="$broker_bus"

exec "$SERVER_BIN" "$@"

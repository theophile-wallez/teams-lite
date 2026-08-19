#!/usr/bin/env bash
# Is a running backend still dialling a broker bus that is no longer the broker's?
# And optionally: restart the ones that are.
#
#   teams-lite-broker-bus-check.sh            # exit 0 = fine, 1 = stale, 2 = cannot tell
#   teams-lite-broker-bus-check.sh --repair   # …and ask systemd to restart the stale ones
#
# WHY THIS EXISTS. The broker's bus lives at /proc/<container-leader>/root/run/user/0/bus
# (see bin/broker-env.sh), a backend resolves that path once and systemd freezes it into
# the process environment at exec. Two things then go wrong, and only ONE of them was
# ever covered:
#
#   * the container RESTARTS while a backend runs, so the leader PID moves. That is what
#     teams-lite-broker-bus.path watches rootless.json for.
#   * a backend STARTS BEFORE the container is ready, and freezes the HOST session bus —
#     which carries no broker at all. Nothing covered this. `PathChanged=` fires only on
#     a write while the path unit is already watching, and on a boot everything starts at
#     once: the container writes rootless.json in the same second, so the change is
#     missed and the file never moves again. The container's own unit is a Type=oneshot
#     that stays "active (exited)" and restarts itself without changing state, so
#     PartOf= does not fire either.
#
# The second one is permanent and silent, which is the whole reason for this file. The
# backend does not exit on a failed token call — a broken sign-in is deliberately not
# fatal, so the history keeps serving — so the process stays up, `active (running)`,
# answering every read, and signs in to nothing for as long as it lives. It happened to
# teams-lite-app.service on this host: its four start attempts all lost the race, the
# survivor froze /run/user/1000/bus, and the app on that front could not reach Teams at
# all while the staged pair beside it worked perfectly.
#
# It tests the CAUSE rather than a symptom, which is the discipline
# teams-lite-broker-check.sh states for the keyring: it compares where the broker IS with
# where each backend is still dialling. That beats inferring staleness from a failed
# token call, which is equally what a locked keyring, a stopping container and a slow
# reply look like — and each of those has a different repair.
#
# TWO CALLERS, one answer:
#   * teams-lite-broker-health.timer, every 15 minutes — the only trigger that works
#     while no client is connected, which is exactly when this outage goes unnoticed;
#   * a human diagnosing "why is this front empty when the other one is fine".
#
# It never runs `intune-container` and never restarts a container: the container is
# healthy in this failure. The repair is the BACKEND's, and it is the one
# teams-lite-broker-bus.path already uses, so a restart is spelled in one place.
set -uo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

RESTART_UNIT="teams-lite-backend-restart.service"
SYSTEMCTL="${SYSTEMCTL:-$(command -v systemctl || echo /usr/bin/systemctl)}"

# The units that hold a backend whose environment carries the bus address. The app unit's
# MainPID is the LAUNCHER rather than the backend — the backend is its child and inherits
# this environment — so the launcher's own copy is the right one to read either way.
BACKEND_UNITS=(
  teams-lite-backend.service
  teams-lite-app.service
)

repair=0
case "${1:-}" in
  --repair) repair=1 ;;
  "") ;;
  *)
    echo "usage: $(basename "$SCRIPT_PATH") [--repair]" >&2
    exit 2
    ;;
esac

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"

# The unit's main process, or nothing when it is not running. A stopped unit is skipped
# rather than repaired: the user may have taken it down on purpose, which is the same
# reason the restart unit uses `try-restart`.
main_pid_of() {
  local unit="$1" pid
  pid="$("$SYSTEMCTL" --user show -p MainPID --value "$unit" 2>/dev/null)" || return 1
  case "$pid" in
    "" | 0) return 1 ;;
  esac
  printf '%s' "$pid"
}

bus="$(teams_lite_broker_bus)"

if [ -z "$bus" ]; then
  # Neither case is a stale backend, and neither is repairable by a restart.
  if teams_lite_broker_on_session_bus; then
    echo "teams-lite(broker-bus-check): classic Intune — the broker is on this session" \
      "bus, so no backend can be holding a stale one." >&2
  else
    # The container is down. Restarting a backend now would only make its own start fail
    # and walk up the backoff, and it would take the user's history offline for the
    # duration. A repair must never fire on ignorance.
    echo "teams-lite(broker-bus-check): no Intune container bus found; cannot tell" \
      "whether a backend is stale. Check: intune-container status" >&2
  fi
  exit 2
fi

stale=()
checked=0

for unit in "${BACKEND_UNITS[@]}"; do
  pid="$(main_pid_of "$unit")" || continue
  frozen="$(teams_lite_frozen_bus_of_pid "$pid")" || {
    # A process we cannot read is not one we may judge.
    echo "teams-lite(broker-bus-check): cannot read the environment of $unit (pid $pid);" \
      "skipping it." >&2
    continue
  }
  checked=$((checked + 1))
  if [ "$frozen" = "$bus" ]; then
    continue
  fi
  stale+=("$unit")
  echo "teams-lite(broker-bus-check): $unit is dialling ${frozen:-<no address>} while the" \
    "broker is on $bus — that backend can mint no token at all." >&2
done

if [ "$checked" -eq 0 ]; then
  echo "teams-lite(broker-bus-check): no running backend to check." >&2
  exit 2
fi

if [ "${#stale[@]}" -eq 0 ]; then
  echo "teams-lite(broker-bus-check): every running backend is on the broker's bus." >&2
  exit 0
fi

if [ "$repair" -eq 0 ]; then
  exit 1
fi

# --no-block: the restart unit try-restarts the very cgroup this script may be running
# in (the health service is PartOf the target), so waiting for it would be waiting for
# our own death. It restarts BOTH backends rather than only the stale ones, which is
# what the .path unit already does and is safe: a try-restart of a healthy backend costs
# it a reconnect, and spelling the repair twice is how the two triggers drift apart.
echo "teams-lite(broker-bus-check): asking systemd to run $RESTART_UNIT." >&2
if ! "$SYSTEMCTL" --user start --no-block "$RESTART_UNIT"; then
  echo "teams-lite(broker-bus-check): $RESTART_UNIT refused to start. Check:" \
    "systemctl --user status $RESTART_UNIT" >&2
fi

exit 1

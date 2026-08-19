#!/usr/bin/env bash
# ExecStartPre for teams-lite-app.service: do not let the launcher start until the
# broker's bus exists.
#
# WHY A UNIT NEEDS THIS AND THE STAGED BACKEND DOES NOT. Both resolve the bus at start
# and both freeze it at exec, and the staged backend does that resolution in a wrapper
# THIS repo ships (bin/teams-lite-backend.sh, which waits). The released build's wrapper
# is the one install.sh WRITES into ~/.teams-lite/bin/teams — a self-contained copy, and
# the in-app update deliberately replaces the binary beside it and never the wrapper. So
# a machine installed before the wait was added keeps a wrapper that launches anyway, for
# as long as nobody re-runs install.sh: measured on this host, the container restarted,
# `PartOf=` propagated to the app unit, its wrapper lost the race, and the backend froze
# /run/user/1000/bus — which carries no broker — while staying `active (running)`.
#
# The unit is written by bin/teams-lite-service.sh on every `install`/`update`, so a fix
# HERE reaches the machine with the next re-stage and costs no 130 MB download. That is
# the whole reason this sits in an ExecStartPre rather than in the wrapper alone: the unit
# is the half this repo can still correct.
#
# It also makes the failure BOUNDED rather than permanent. A non-zero exit here aborts the
# start, and the unit's `Restart=always` comes back — so the worst case is a retry, where
# before it was a backend signed in to nothing until the 15-minute health timer noticed
# (bin/teams-lite-broker-bus-check.sh, which stays: it is what catches every case this
# cannot, including a container that moves while the launcher is already up).
set -uo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"

bus="$(teams_lite_wait_for_broker_bus)"

if [ -n "$bus" ] || teams_lite_broker_on_session_bus; then
  exit 0
fi

# NOTHING FOUND. Whether that is worth failing the start on depends on whether this host
# has a container at all, which is the same question the wait itself asks:
#
#   * a container is KNOWN (rootless.json exists) and its bus did not appear inside the
#     window — so this really is the race, and failing hands the retry to `Restart=always`
#     rather than freezing a dead address for the life of the process. 69 is EX_UNAVAILABLE,
#     the code bin/teams-lite-backend.sh already uses for it;
#   * no container is known — classic Intune, or a machine with no Intune at all. Failing
#     there would keep the app unit down for ever over something that is not a fault, and
#     the app's own banner already says what it cannot do. So it starts, exactly as before.
if [ -e "$TEAMS_LITE_CONTAINER_STATE" ]; then
  echo "teams-lite(broker-wait): the Intune container's bus did not appear within" \
    "${TEAMS_LITE_BROKER_WAIT_SECONDS}s. Not starting on a bus with no broker; systemd" \
    "will retry. Check: intune-container status" >&2
  exit 69
fi

echo "teams-lite(broker-wait): no Intune container on this host — starting anyway." >&2
exit 0

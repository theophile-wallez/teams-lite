#!/usr/bin/env bash
# Is the Intune container's login keyring locked? And optionally: repair it.
#
#   teams-lite-broker-check.sh            # exit 0 = fine, 1 = locked, 2 = cannot tell
#   teams-lite-broker-check.sh --repair   # …and ask systemd for a repair when locked
#   teams-lite-broker-check.sh --locked   # INVERTED: 0 = locked. For ExecCondition=
#
# The `--locked` spelling exists because systemd reads an `ExecCondition=` exit status
# the other way round: 0 runs the unit, 1-254 SKIPS it. So the repair unit asks "is it
# locked?" and proceeds only on 0 — and an unknown state (2) skips, which is the safe
# direction: never restart a container on a guess.
#
# WHY THIS EXISTS. The container's keyring re-locks on its own — twice in two days on
# this host, roughly every 18 hours. The broker then activates, cannot read its
# secrets, and drops off the bus, so every token call dies with
# `org.freedesktop.DBus.Error.NoReply: Message recipient disconnected …`. The backend
# stays up and healthy-looking while the app shows no chats at all.
#
# This script tests THE CAUSE rather than a symptom. `org.freedesktop.secrets` exposes
# the login collection's `Locked` property on the container's own bus, and reading it
# is one cheap D-Bus get-property away. That beats inferring the lock from a failed
# token call, which is also what a killed broker, a stopping container, or a slow reply
# looks like.
#
# THREE CALLERS, one answer:
#   * bin/teams-lite-backend.sh, before it execs the backend — because a locked keyring
#     at startup makes authentication fail, and the unit then retries for ever with
#     nobody to repair it;
#   * teams-lite-broker-health.timer, every 15 minutes — because with nobody in Mail or
#     the Calendar and a live real-time socket, the backend makes NO broker calls and
#     an outage can go unnoticed indefinitely;
#   * teams-lite-broker-repair.service as its ExecCondition — so no trigger, not even
#     the in-app button, can restart a container whose keyring is perfectly fine.
#
# It never runs `intune-container` itself. The repair lives in one unit so that its
# rate limit covers every trigger together.
set -uo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

REPAIR_UNIT="teams-lite-broker-repair.service"
SYSTEMCTL="${SYSTEMCTL:-$(command -v systemctl || echo /usr/bin/systemctl)}"

# The login keyring, as org.freedesktop.secrets exposes it inside the container.
SECRETS_NAME='org.freedesktop.secrets'
SECRETS_PATH='/org/freedesktop/secrets/collection/login'
SECRETS_IFACE='org.freedesktop.Secret.Collection'

repair=0
inverted=0
case "${1:-}" in
  --repair) repair=1 ;;
  --locked) inverted=1 ;;
  "") ;;
  *)
    echo "usage: $(basename "$SCRIPT_PATH") [--repair | --locked]" >&2
    exit 2
    ;;
esac

# 0 when the keyring is fine, 1 when it is locked — or the reverse under `--locked`.
verdict() {
  local locked="$1"
  if [ "$inverted" -eq 1 ]; then
    [ "$locked" -eq 1 ] && exit 0
    exit 1
  fi
  exit "$locked"
}

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"

# `Locked` on the collection: "b true" when locked, "b false" when not. An empty
# answer means we could not ask — no bus, no secret service, no busctl — and that is
# deliberately NOT the same as "locked": a repair must never fire on ignorance.
keyring_locked() {
  local bus="$1" answer
  command -v busctl >/dev/null 2>&1 || return 2
  answer="$(busctl --address="$bus" get-property \
    "$SECRETS_NAME" "$SECRETS_PATH" "$SECRETS_IFACE" Locked 2>/dev/null)" || return 2
  case "$answer" in
    *true*) return 0 ;;
    *false*) return 1 ;;
    *) return 2 ;;
  esac
}

bus="$(teams_lite_broker_bus)"
if [ -z "$bus" ]; then
  # Either the broker is on our own session bus (a classic Intune host, where there is
  # no container to repair) or nothing was found at all. Neither is a locked keyring.
  if teams_lite_broker_on_session_bus; then
    echo "teams-lite(broker-check): classic Intune — no container keyring to check." >&2
  else
    echo "teams-lite(broker-check): no Intune container bus found; cannot check the keyring." >&2
  fi
  exit 2
fi

keyring_locked "$bus"
case "$?" in
  1)
    echo "teams-lite(broker-check): the container keyring is unlocked." >&2
    verdict 0
    ;;
  2)
    echo "teams-lite(broker-check): could not read the keyring state on $bus." >&2
    exit 2
    ;;
esac

echo "teams-lite(broker-check): the container keyring is LOCKED — the broker cannot" \
  "mint tokens, so teams-lite has no chats, mail or calendar." >&2

if [ "$repair" -eq 0 ]; then
  verdict 1
fi

# --no-block: return as soon as the job is enqueued. The repair restarts the
# container, which moves the broker bus, which makes teams-lite-broker-bus.path
# restart the backend — so a caller inside the backend's own cgroup must not wait for
# the repair it just asked for.
echo "teams-lite(broker-check): asking systemd to run $REPAIR_UNIT." >&2
if "$SYSTEMCTL" --user start --no-block "$REPAIR_UNIT"; then
  verdict 1
fi

# A non-zero exit here is almost always the unit's own rate limit (three repairs an
# hour). Say so rather than retrying: a keyring that re-locks faster than that needs a
# human, not another restart.
echo "teams-lite(broker-check): $REPAIR_UNIT refused to start — most likely its rate" \
  "limit (3/hour). Check: systemctl --user status $REPAIR_UNIT" >&2
verdict 1

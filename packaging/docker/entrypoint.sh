#!/bin/sh
# What the container image runs: `teams`, with no browser to open, on ports of its OWN.
#
# THE PORTS ARE THE POINT. The compose file runs this image in the host's network namespace
# (see packaging/docker/compose.yaml for why), so its ports are host ports — and the launcher
# ATTACHES to whatever already listens on its backend's port (`ensureBackend` in
# launcher/src/backend.ts). On the defaults, that would be the user's always-on service on
# 19420: this image would serve somebody else's backend, with no token it can find, and every
# send would be refused. So the image takes its own pair (19423 / 19443 — AGENTS.md § Ports),
# which also keeps its live feed its own when it shares a store with a host install: the
# trouter endpoint id is keyed by the store AND the port (`endpoint_id_path`).
#
# A READ-ONLY run keeps the read-only backend's own 19430, which is what an explicit
# TEAMS_LITE_PORT would drag it off (bin/teams-dev-server.sh makes the same exception). Either
# port can still be set by the caller; this only fills in what they left unset.
set -eu

if [ "${TEAMS_LITE_READ_ONLY:-}" != 1 ]; then
  export TEAMS_LITE_PORT="${TEAMS_LITE_PORT:-19423}"
fi
export TEAMS_WEB_PORT="${TEAMS_WEB_PORT:-19443}"
# The backend's own lines go to `docker logs`, beside the launcher's, rather than to a file in
# the container's /tmp that nobody reads (`backendLogsInherited` in launcher/src/backend.ts).
export TEAMS_LITE_BACKEND_LOG="${TEAMS_LITE_BACKEND_LOG:--}"

exec /usr/local/bin/teams --no-open "$@"

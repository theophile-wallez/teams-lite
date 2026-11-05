#!/usr/bin/env bash
# teams-lite DEV backend launcher — runs the backend straight from source
# (`cargo run --bin server`) on a port of its own, and keeps it alive across frontend
# disconnects.
#
# Two jobs, both below: the port (19421, beside the always-on service's 19420), and
# TEAMS_NO_IDLE_EXIT so the backend only stops on Ctrl+C — handy when the browser/dev
# server disconnects and reconnects during development.
#
# It no longer makes the identity broker reachable, because there is nothing left to do:
# the backend finds the broker's D-Bus itself, on every connection, from the Intune
# container's own runtime state (src/intune.rs), so a raw `cargo run --bin server`
# authenticates on a containerized-Intune host exactly as this script does. It used to
# source a shell detection and freeze the container's bus into DBUS_SESSION_BUS_ADDRESS,
# which went stale with the next container restart.
#
# Runs from any directory: the repo root is derived from this script's location,
# and `cargo` locates the workspace manifest from there.
set -euo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Keep the dev backend alive across frontend disconnects (only Ctrl+C stops it).
export TEAMS_NO_IDLE_EXIT="${TEAMS_NO_IDLE_EXIT:-1}"

# A PORT OF ITS OWN: 19421, next door to the always-on service's 19420.
#
# Both are send-capable backends on the same store, so they must not compete for one
# port. The service holds 19420 for weeks; this launcher is for hands-on work while
# that keeps running, so it steps aside by default. `bun run dev` in web/ points at
# 19421 to match, and `TEAMS_LITE_PORT` still overrides both.
#
# Not when read-only: `TEAMS_LITE_PORT` wins over every default in `resolve_port`
# (src/bin/server.rs), so setting it here unconditionally would drag a read-only
# backend off 19430 and onto the dev port — taking a port the user wants, which is
# the one thing read-only mode exists to avoid.
if [ "${TEAMS_LITE_READ_ONLY:-}" != "1" ]; then
  export TEAMS_LITE_PORT="${TEAMS_LITE_PORT:-19421}"
fi

exec cargo run --manifest-path "$REPO_ROOT/Cargo.toml" --bin server "$@"

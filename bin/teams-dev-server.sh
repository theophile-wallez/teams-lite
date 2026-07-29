#!/usr/bin/env bash
# teams-lite DEV backend launcher — runs the backend straight from source
# (`cargo run --bin server`) with the Microsoft Identity Broker reachable, and keeps
# the backend alive across frontend disconnects.
#
# Why this exists: a raw `cargo run --bin server` does no broker detection, so on a
# containerized-Intune host the dev backend cannot authenticate (D-Bus finds no
# com.microsoft.identity.broker1 on our own session bus). The detection is shared
# with the other entry points in bin/broker-env.sh — see that file for the two
# topologies and for why the CONTAINER, not the broker process, is the handle.
#
# It also sets TEAMS_NO_IDLE_EXIT so the backend only stops on Ctrl+C — handy when
# the browser/dev server disconnects and reconnects during development.
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

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"
teams_lite_export_broker_bus

exec cargo run --manifest-path "$REPO_ROOT/Cargo.toml" --bin server "$@"

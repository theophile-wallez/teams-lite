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

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"
teams_lite_export_broker_bus

exec cargo run --manifest-path "$REPO_ROOT/Cargo.toml" --bin server "$@"

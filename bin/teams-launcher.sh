#!/usr/bin/env bash
# teams-lite launcher — runs the compiled `teams` binary with the Microsoft Identity
# Broker reachable, in either of the two Intune topologies teams-lite supports, and
# WITHOUT ever needing sudo.
#
# The detection itself lives in bin/broker-env.sh, sourced below: three entry points
# need the same answer to the same question (this launcher, bin/teams-dev-server.sh,
# and the always-on service in packaging/systemd), and a copy of it drifting is how a
# backend ends up on a bus with no broker on it. Read that file for the two
# topologies, and for why the CONTAINER — not the broker process — is the handle.
#
# The UI process spawns the Rust backend as a child that inherits our environment, so
# wrapping this single entry point fixes both processes.
set -euo pipefail

# Resolve through symlinks: this file is meant to be linked onto the PATH (for
# example ~/.local/bin/teams -> <repo>/bin/teams-launcher.sh), and broker-env.sh sits
# next to the REAL file, not next to the link.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Absolute path to the compiled `teams` binary this launcher wraps.
TEAMS_BIN="${TEAMS_LITE_BIN:-$REPO_ROOT/ui/dist/teams}"

if [ ! -x "$TEAMS_BIN" ]; then
  echo "teams-lite: binary not found at $TEAMS_BIN" >&2
  echo "  build it with: (cd ui && bun run build)  or set TEAMS_LITE_BIN" >&2
  exit 1
fi

# shellcheck source=bin/broker-env.sh
. "$SCRIPT_DIR/broker-env.sh"
teams_lite_export_broker_bus

# Run the binary from its own directory: a compiled Bun binary reads bunfig.toml
# from the CURRENT directory at startup, so running inside another Bun project
# (whose bunfig has a `preload`) would crash. teams-lite doesn't care about the
# working directory (logs go to /tmp, database to the XDG data dir, both absolute).
cd "$(dirname "$TEAMS_BIN")" || exit 1
exec "$TEAMS_BIN" "$@"

#!/usr/bin/env bash
# teams-lite launcher — runs the compiled `teams` binary from its own directory.
#
# It used to be the place the Microsoft Identity Broker was made reachable: it sourced a
# shared shell detection and exported the Intune container's bus into
# DBUS_SESSION_BUS_ADDRESS, which the launcher and the backend it spawns then kept frozen
# for their whole lives. The backend now finds the broker itself, on every connection,
# from the container's own runtime state (src/intune.rs), so nothing about D-Bus is set
# here any more — and an address set here would only be one the backend has to ignore.
#
# What is left is the working directory, which is a real job — see the comment above the
# `cd` below — and refusing a compiled binary older than this file, which is the one pairing
# that dropping the export broke (see the comment above the `grep`).
set -euo pipefail

# Resolve through symlinks: this file is meant to be linked onto the PATH (for
# example ~/.local/bin/teams -> <repo>/bin/teams-launcher.sh), and the default binary
# below is found relative to the REAL file, not to the link.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Absolute path to the compiled `teams` binary this launcher wraps.
TEAMS_BIN="${TEAMS_LITE_BIN:-$REPO_ROOT/launcher/dist/teams}"

if [ ! -x "$TEAMS_BIN" ]; then
  echo "teams-lite: binary not found at $TEAMS_BIN" >&2
  echo "  build it with: (cd launcher && bun run build)  or set TEAMS_LITE_BIN" >&2
  exit 1
fi

# THE BINARY MUST BE AS NEW AS THIS FILE, and nothing else makes it so. launcher/dist is a
# build artifact git does not track, so a `git pull` brings this wrapper — which no longer
# makes the broker reachable — and leaves the compiled launcher, and the backend embedded in
# it, exactly as old as it was. That backend reads the broker's bus from the environment
# alone: started from here on a containerized-Intune host it would dial the desktop session
# bus, where there is no broker, and stay signed out for as long as it ran. So the pairing is
# refused here, where it is made, rather than started into a sign-in that cannot work.
#
# The tell is the hidden argument the in-process repair re-executes the backend with
# (`intune::REPAIR_SUBCOMMAND` in src/intune.rs): a literal in every backend that finds the
# broker itself and in none before it, and launcher/build.ts embeds the backend's bytes as
# they are, so `grep -a` finds it inside the compiled launcher with nothing run. It costs one
# read of the file up to where the backend sits, from the page cache — a fraction of a second
# at worst (measured here: 0.23 s to read all 320 MB of a debug backend and find nothing). It
# is refused even when the launch would only ATTACH to a backend already listening: a
# refusal that depended on what else happens to be running would be one nobody could
# predict, and the rebuild is one line.
if ! grep -qaF -- __teams-lite-repair-broker "$TEAMS_BIN"; then
  echo "teams-lite: this teams binary predates the in-process broker lookup — rebuild it:" >&2
  echo "  cd $REPO_ROOT && cargo build --release --bin server && (cd launcher && bun run build)" >&2
  echo "  (the launcher embeds target/release/server, so the backend is rebuilt first)" >&2
  exit 1
fi

# Run the binary from its own directory: a compiled Bun binary reads bunfig.toml
# from the CURRENT directory at startup, so running inside another Bun project
# (whose bunfig has a `preload`) would crash. teams-lite doesn't care about the
# working directory (logs go to /tmp, database to the XDG data dir, both absolute).
cd "$(dirname "$TEAMS_BIN")" || exit 1
exec "$TEAMS_BIN" "$@"

#!/bin/sh
# teams-lite installer — grabs the latest prebuilt `teams` binary and puts it on
# your PATH. Usage:
#
#   curl -fsSL https://raw.githubusercontent.com/theophile-wallez/teams-lite/master/install.sh | sh
#
# Environment:
#   TEAMS_LITE_HOME   install location (default: ~/.teams-lite)
set -eu

REPO="theophile-wallez/teams-lite"
INSTALL_DIR="${TEAMS_LITE_HOME:-$HOME/.teams-lite}"
BIN_DIR="$INSTALL_DIR/bin"

# teams-lite is Linux-only: it signs in through the Microsoft Identity Broker
# over the session D-Bus, which only exists on managed Linux machines.
os="$(uname -s)"
if [ "$os" != "Linux" ]; then
  echo "teams-lite is Linux-only (it needs the Microsoft Identity Broker over D-Bus)." >&2
  echo "Detected: $os" >&2
  exit 1
fi

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) asset="teams-linux-x64" ;;
  *)
    echo "No prebuilt binary for CPU architecture '$arch' yet." >&2
    echo "Build from source instead: https://github.com/$REPO#build-from-source" >&2
    exit 1
    ;;
esac

url="https://github.com/$REPO/releases/download/latest/$asset"

# Nothing under $INSTALL_DIR is created or touched until the download has passed every check
# below: a refused install leaves the machine exactly as it was — an earlier install still
# whole, or nothing at all.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Downloading teams-lite ($asset)…"
if command -v curl >/dev/null 2>&1; then
  curl -fSL --progress-bar "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress -O "$tmp" "$url"
else
  echo "error: need curl or wget to download." >&2
  exit 1
fi

# Sanity check: a real ELF binary, not an HTML error page.
if ! head -c 4 "$tmp" | od -An -tx1 | tr -d ' \n' | grep -qi '^7f454c46'; then
  echo "error: download did not look like a binary. Is a 'latest' release published yet?" >&2
  echo "  $url" >&2
  exit 1
fi

# And one as new as THIS installer. The wrapper written below no longer makes the identity
# broker reachable, because a current backend finds the broker itself; a release built before
# that reads the broker's bus from its environment alone, so behind this wrapper it would dial
# the desktop session bus — where a containerized-Intune host has no broker — and stay signed
# out from its first start. That pairing is real in the minutes after the change that made
# the wrapper this small: this file is served from master the moment it merges, while `latest`
# is republished only once CI has built that same commit (and never, if that build fails).
#
# The tell is the hidden argument the in-process repair re-executes the backend with
# (`intune::REPAIR_SUBCOMMAND` in src/intune.rs, in the repository): a literal in every backend
# that finds the broker itself and in none before it, and the release embeds the backend's
# bytes as they are, so `grep -a` finds it inside the download with nothing run. The check sits
# BEFORE anything is installed, so a refusal keeps the binary and the wrapper an earlier run
# put here — a pair that works together — rather than half of each.
if ! grep -qaF __teams-lite-repair-broker "$tmp"; then
  echo "error: the release for this installer is not published yet — retry in a few minutes." >&2
  echo "  The 'latest' build predates the backend finding the identity broker by itself, which" >&2
  echo "  the launcher this installer writes relies on. Nothing was installed or changed." >&2
  echo "  If it persists, the release build failed: https://github.com/$REPO/actions" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
install -m 0755 "$tmp" "$BIN_DIR/teams-bin"

# Launcher wrapper. One job: bunfig isolation — a compiled Bun binary reads bunfig.toml
# from the CURRENT directory at startup, so running `teams` inside another Bun project
# (whose bunfig has a `preload`) would crash. We sidestep that by running from a directory
# we control (teams-lite doesn't care about the working directory: its logs go to /tmp and
# its database to the XDG data dir, both absolute). It execs, so the binary keeps the
# wrapper's pid — under teams-lite-app.service, the unit's MainPID — and it is the one file
# here the in-app update never replaces, which is a reason to keep it this small: whatever
# it does, a machine keeps doing until somebody re-runs this installer.
#
# It used to have a second job, making the Microsoft Identity Broker reachable. On a
# containerized-Intune host the broker lives on the container's own D-Bus, reached through
# /proc/<container-leader>/root/run/user/0/bus — a path that moves with every container
# boot — and this wrapper carried a copy of the shell detection that found it, waited for
# it and exported it into DBUS_SESSION_BUS_ADDRESS, where it stayed frozen for the life of
# the process. The backend now finds that bus itself, on every connection, from the
# container's own runtime state (src/intune.rs in the repository), so there is nothing left
# for a wrapper to resolve — and TEAMS_LITE_BROKER_BUS, the operator's override for a
# topology nothing detects, is read by the backend too.
#
# A WRAPPER WRITTEN BY AN OLDER install.sh still exports that frozen address, and it is
# harmless: the backend prefers a running container over whatever bus it inherited, so the
# stale address is never dialled while there is a broker to reach — and with no container
# running there is no broker on any bus. Re-running this installer replaces it anyway. The
# OTHER pairing — this wrapper in front of a binary older than it — is the one that breaks
# sign-in, and the marker check above is what keeps this installer from ever writing it.
cat > "$BIN_DIR/teams" <<EOF
#!/usr/bin/env bash
set -euo pipefail

TEAMS_BIN="$BIN_DIR/teams-bin"

cd "$BIN_DIR" || exit 1
exec "\$TEAMS_BIN" "\$@"
EOF
chmod 0755 "$BIN_DIR/teams"

echo "Installed teams-lite to $BIN_DIR/teams"

# Make `teams` immediately runnable if a standard bin dir is on PATH; otherwise
# print the one line the user needs to add.
linked=""
# Single candidate today; kept as a loop so more standard bin dirs can be added.
# shellcheck disable=SC2066
for d in "$HOME/.local/bin"; do
  case ":$PATH:" in
    *":$d:"*)
      mkdir -p "$d"
      ln -sf "$BIN_DIR/teams" "$d/teams"
      linked="$d/teams"
      break
      ;;
  esac
done

echo ""
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "Run it with:  teams"
    ;;
  *)
    if [ -n "$linked" ]; then
      echo "Linked into $linked — run it with:  teams"
    else
      echo "Add teams-lite to your PATH, then run 'teams':"
      echo "  export PATH=\"$BIN_DIR:\$PATH\""
    fi
    ;;
esac

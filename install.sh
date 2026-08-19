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

mkdir -p "$BIN_DIR"
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

install -m 0755 "$tmp" "$BIN_DIR/teams-bin"

# Launcher wrapper. It does two jobs:
#
#   1. bunfig isolation — a compiled Bun binary reads bunfig.toml from the CURRENT
#      directory at startup, so running `teams` inside another Bun project (whose
#      bunfig has a `preload`) would crash. We sidestep that by running from a
#      directory we control (teams-lite doesn't care about the working directory:
#      its logs go to /tmp and its database to the XDG data dir, both absolute).
#
#   2. Broker reach — teams-lite signs in through the Microsoft Identity Broker
#      (com.microsoft.identity.broker1) over the session D-Bus, in either Intune
#      topology, WITHOUT ever needing sudo:
#        • Classic Intune: the broker runs as the real user and owns its name on
#          the host session bus. We just launch directly.
#        • Containerized Intune: the broker runs as the same host user inside a
#          rootless container, on the container's own bus (/run/user/0/bus). That
#          socket is reachable unprivileged from the host via
#          /proc/<container-pid>/root/run/user/0/bus, so we just point
#          DBUS_SESSION_BUS_ADDRESS at it and connect directly.
#      Detection is automatic; if no broker is found we still launch and let the
#      binary surface its own error — but only after WAITING for one, because this
#      wrapper is also what teams-lite-app.service execs, and there the address it
#      resolves is frozen for the life of a service that never exits on its own.
#      Losing that race left a backend permanently signed in to nothing, on a front
#      the user reads, with the app `active (running)` the whole time. The wait is
#      bounded and happens only while a container is KNOWN (rootless.json exists),
#      so a machine with classic Intune or none at all still launches at once.
#
#      This is a self-contained COPY of bin/broker-env.sh, because an installed
#      binary has no repo to source it from. bin/broker-env.sh is the source of
#      truth and carries the full explanation — in particular why the CONTAINER,
#      not the broker process, is the handle: the broker is D-Bus activated, so
#      most of the time no broker process exists to find.
cat > "$BIN_DIR/teams" <<EOF
#!/usr/bin/env bash
set -euo pipefail

TEAMS_BIN="$BIN_DIR/teams-bin"
BROKER_DBUS_NAME='com.microsoft.identity.broker1'
CONTAINER_STATE="\${TEAMS_LITE_CONTAINER_STATE:-\$HOME/.local/share/intune-container/rootless.json}"
BROKER_WAIT_SECONDS="\${TEAMS_LITE_BROKER_WAIT_SECONDS:-30}"

launch() {
  cd "$BIN_DIR" || exit 1
  exec "\$TEAMS_BIN" "\$@"
}

# Does a bus carry the broker name — owned, or merely activatable?
broker_on_bus() {
  command -v busctl >/dev/null 2>&1 || return 1
  busctl --address="\$1" --list --no-legend 2>/dev/null |
    awk '{print \$1}' | grep -qx "\$BROKER_DBUS_NAME"
}

# Both topologies, retried until the container is up. The launch function execs, so
# the first bus that carries the broker ends this loop for good.
waited=0
while :; do
  # Topology 1 — classic Intune: broker name already on our host session bus.
  if command -v busctl >/dev/null 2>&1 &&
     busctl --user --list --no-legend 2>/dev/null | awk '{print \$1}' | grep -qx "\$BROKER_DBUS_NAME"; then
    launch "\$@"
  fi

  # Topology 2 — containerized Intune: the container's own bus, reached through
  # /proc. The container leader first (it lives as long as the container), then any
  # process that runs inside it.
  for pid in \\
    "\$(grep -o '"leader"[[:space:]]*:[[:space:]]*[0-9]\\+' "\$CONTAINER_STATE" 2>/dev/null | grep -o '[0-9]\\+\$' || true)" \\
    \$(pgrep -f 'identity-broker/bin/microsoft-identity' 2>/dev/null || true) \\
    \$(pgrep -f 'intune/bin/intune-daemon' 2>/dev/null || true); do
    [ -n "\$pid" ] || continue
    bus="/proc/\$pid/root/run/user/0/bus"
    [ -S "\$bus" ] || continue
    if broker_on_bus "unix:path=\$bus"; then
      export DBUS_SESSION_BUS_ADDRESS="unix:path=\$bus"
      launch "\$@"
    fi
  done

  # Wait only while a container is KNOWN to exist. With no rootless.json there is
  # nothing to wait for, so a classic-Intune host and a machine with no Intune at
  # all launch at once rather than hanging.
  [ -e "\$CONTAINER_STATE" ] || break
  [ "\$waited" -lt "\$BROKER_WAIT_SECONDS" ] || break
  sleep 1
  waited=\$((waited + 1))
done

echo "teams-lite: identity broker not found on this session bus and no Intune" \\
     "container was found — start Intune first. Launching anyway; sign-in will" \\
     "fail while the broker stays unreachable." >&2
launch "\$@"
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

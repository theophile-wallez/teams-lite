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

# Launcher wrapper. A compiled Bun binary reads bunfig.toml from the CURRENT
# directory at startup, so running `teams` inside another Bun project (whose
# bunfig has a `preload`) would crash. We sidestep that by running from a
# directory we control — teams-lite doesn't care about the working directory
# (its logs go to /tmp and its database to the XDG data dir, both absolute).
cat > "$BIN_DIR/teams" <<EOF
#!/bin/sh
cd "$BIN_DIR" || exit 1
exec "$BIN_DIR/teams-bin" "\$@"
EOF
chmod 0755 "$BIN_DIR/teams"

echo "Installed teams-lite to $BIN_DIR/teams"

# Make `teams` immediately runnable if a standard bin dir is on PATH; otherwise
# print the one line the user needs to add.
linked=""
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

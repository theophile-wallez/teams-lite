#!/usr/bin/env bash
# Package the chart FOR THE REPOSITORY THAT PUBLISHES IT.
#
#     packaging/helm/package.sh <owner/repo> <chart version> <app version> <destination dir>
#
# The chart in the tree names the upstream repository (theophile-wallez/teams-lite — the one
# install.sh and the update check name): its image, its home, its sources. A FORK that publishes
# from its own master (its CI runs .github/workflows/build.yml too) must not ship a chart whose
# default image is upstream's — `helm install` would then run a build the fork never made. So the
# published package is stamped with the repository it was built in: the image becomes
# ghcr.io/<owner/repo, lowercased — GHCR's rule>, and `home` and `sources` its GitHub page (the first
# source is what `helm push` turns into the OCI source annotation, which links the package to that
# repository). The tree itself is never edited: a copy is.
#
# Each rewrite must find the upstream spelling it replaces, or this fails — a default renamed in
# values.yaml or Chart.yaml would otherwise be published unstamped, pointing at upstream, with
# nothing saying so.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <owner/repo> <chart version> <app version> <destination dir>" >&2
  exit 2
fi
repository="$1" version="$2" app_version="$3" destination="$4"
case "$repository" in
  */*) ;;
  *) echo "$0: '$repository' is not <owner/repo>" >&2; exit 2 ;;
esac

upstream="theophile-wallez/teams-lite"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp -R "$here/teams-lite" "$staging/teams-lite"
chart="$staging/teams-lite"

# Replace every $2 in file $1 with $3, and fail when there was none to replace.
stamp() {
  local file="$1" from="$2" to="$3"
  if ! grep -qF -- "$from" "$file"; then
    echo "$0: $(basename "$file") no longer names '$from' — update this script with it" >&2
    exit 1
  fi
  FROM="$from" TO="$to" python3 -I -c '
import os, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(text.replace(os.environ["FROM"], os.environ["TO"]))
' "$file"
}

stamp "$chart/values.yaml" "repository: ghcr.io/${upstream}" "repository: ghcr.io/${repository,,}"
stamp "$chart/Chart.yaml" "https://github.com/${upstream}" "https://github.com/${repository}"
stamp "$chart/Chart.yaml" "https://raw.githubusercontent.com/${upstream}/" "https://raw.githubusercontent.com/${repository}/"

mkdir -p "$destination"
helm package "$chart" --version "$version" --app-version "$app_version" --destination "$destination"

#!/usr/bin/env bash
# The chart's whole gate, in ONE place, so a branch's CI and master's release run the same checks
# (.github/workflows/ci.yml and build.yml):
#
#   1. `helm lint --strict`, for the default (embedded) mode, each host mode, and the app published
#      through a Gateway behind its own sign-in;
#   2. the decision tests (chart.test.ts), rendered through the real helm;
#   3. every variant rendered and validated against the Kubernetes API's own schemas
#      (kubeconform, strict — an unknown field is an error), for the oldest Kubernetes the chart
#      claims (Chart.yaml `kubeVersion`) and a current one. Each is rendered FOR the version it is
#      validated against (`--kube-version`), because the chart decides on it: the user-namespace
#      opt-in is refused below 1.30, so it is validated only where a cluster would accept it.
#
# Nothing here talks to a cluster. kubeconform is downloaded at a pinned version and checked
# against its published sha256 before it runs — pass KUBECONFORM=/path/to/kubeconform to use one
# already on the machine — and it fetches the API schemas from GitHub, so step 3 needs the network.
set -euo pipefail
set -f # `ingress.tls[0]` is a value path, never a glob

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart="$here/teams-lite"
host="--set broker.mode=intuneContainer --set broker.intuneContainer.stateDir=/home/user/.local/share/intune-container"
bus="--set broker.mode=sessionBus --set broker.sessionBus.socket=/run/user/1000/bus"

# The Gateway API's own schemas (the HTTPRoute), which kubeconform's default location does not carry:
# the CRDs catalog, at a pinned commit so a run today validates what a run tomorrow does.
CRDS_CATALOG=6ab3493622cd387923a2d0da5234f53e80e1bd28
# A sign-in in front of the app, which every route beyond the tailnet needs.
signin="--set auth.oauth2Proxy.enabled=true --set auth.oauth2Proxy.issuerUrl=https://accounts.google.com --set auth.oauth2Proxy.clientId=client --set auth.oauth2Proxy.existingSecret=teams-lite-oauth2-proxy --set auth.oauth2Proxy.emails[0]=you@example.com"
route="--set httpRoute.enabled=true --set httpRoute.parentRefs[0].name=public --set httpRoute.parentRefs[0].namespace=gateway-system --set httpRoute.hostnames[0]=teams.example.com --set networkPolicy.allowNamespaces[0]=envoy-gateway-system"

KUBECONFORM_VERSION=v0.7.0
KUBECONFORM_SHA256=c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3

for mode in "" "$host" "$bus" "$signin $route"; do
  # shellcheck disable=SC2086 # each mode is a list of flags
  helm lint --strict "$chart" $mode
done
# A per-test budget of a minute rather than bun's 5 s default: these tests are bound by the
# subprocesses they run — `helm template`/`helm package` renders, and the image's entrypoint run as
# a library — so their time is the machine's load, not the code's. Measured: the suite takes 8 s on
# an idle workstation and single tests crossed 5 s (one at 22 s) while a Docker build ran beside it,
# which is a CI runner's ordinary state.
(cd "$here" && bun test --timeout 60000)

kubeconform="${KUBECONFORM:-}"
if [ -z "$kubeconform" ]; then
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  curl -fsSL -o "$scratch/kubeconform.tar.gz" \
    "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz"
  echo "${KUBECONFORM_SHA256}  $scratch/kubeconform.tar.gz" | sha256sum --check --quiet -
  tar -xzf "$scratch/kubeconform.tar.gz" -C "$scratch" kubeconform
  kubeconform="$scratch/kubeconform"
fi

# One line per shape the chart can take. Each is split on spaces on purpose.
variants=(
  # The embedded (self-contained) mode, the default.
  ""
  "--set broker.embedded.import.secretName=teams-lite-enrollment --set broker.embedded.persistence.storageClassName=local-path"
  "--set readOnly=true --set ingress.enabled=true --set ingress.className=tailscale --set ingress.tls[0].hosts[0]=teams-lite --set networkPolicy.allowNamespaces[0]=tailscale"
  "$signin --set ingress.enabled=true --set ingress.className=nginx --set ingress.hosts[0].host=teams.example.internal --set networkPolicy.allowNamespaces[0]=ingress-nginx"
  # Published through a Gateway: behind the chart's own sign-in, and behind the user's word.
  "$signin $route"
  "$signin $route --set httpRoute.timeouts.request=0s --set httpRoute.filters[0].type=ResponseHeaderModifier --set httpRoute.filters[0].responseHeaderModifier.set[0].name=Strict-Transport-Security --set httpRoute.filters[0].responseHeaderModifier.set[0].value=max-age=31536000"
  "$route --set auth.external=true"
  "$signin --set ingress.enabled=true --set ingress.className=tailscale --set ingress.annotations.tailscale\\.com/funnel=true --set ingress.tls[0].hosts[0]=teams-lite --set networkPolicy.allowNamespaces[0]=tailscale --set auth.oauth2Proxy.redirectUrl=https://teams-lite.tail1.ts.net/oauth2/callback"
  "--set networkPolicy.enabled=false"
  "--set networkPolicy.from[0].namespaceSelector.matchLabels.team=tailscale --set networkPolicy.allowNamespaces[0]=tailscale"
  "--set persistence.existingClaim=store --set timezone=Europe/Paris"
  "--set persistence.enabled=false"
  # A microVM runtime, declared (it adds one variable to the container).
  "--set broker.embedded.vmIsolated=true"
  # The host modes.
  "$host"
  "$host --set hostNetwork=true"
  "$host --set persistence.existingClaim=store"
  "$host $signin $route"
  "$bus"
)
# Shapes a cluster older than 1.30 cannot take, and the chart refuses there.
variants_since_1_30=(
  "--set broker.embedded.userNamespaces=true"
  "--set broker.embedded.userNamespaces=true --set broker.embedded.import.secretName=teams-lite-enrollment"
)
oldest="$(awk -F'"' '/^kubeVersion:/ { sub(/^>=/, "", $2); sub(/-0$/, "", $2); print $2; exit }' "$chart/Chart.yaml")"
current=1.33.0
validate() {
  local kubernetes="$1" variant="$2"
  # shellcheck disable=SC2086 # the variant is a list of flags
  helm template teams-lite "$chart" --kube-version "$kubernetes" $variant |
    "$kubeconform" -strict -summary -kubernetes-version "$kubernetes" \
      -schema-location default \
      -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/${CRDS_CATALOG}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
      -
}
for kubernetes in "$oldest" "$current"; do
  echo "== Kubernetes $kubernetes"
  for variant in "${variants[@]}"; do
    validate "$kubernetes" "$variant"
  done
done
echo "== Kubernetes $current (1.30 and later only)"
for variant in "${variants_since_1_30[@]}"; do
  validate "$current" "$variant"
done

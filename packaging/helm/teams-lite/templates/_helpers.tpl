{{/*
The release's full name: the release name alone when it already names the chart (`helm install
teams-lite …` gives `teams-lite`, `teams-lite-0`, `data-teams-lite-0`), the two joined otherwise.
*/}}
{{- define "teams-lite.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "teams-lite.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "teams-lite.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name (.Chart.Version | replace "+" "_") | trunc 63 | trimSuffix "-" }}
{{ include "teams-lite.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "teams-lite.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "teams-lite.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The image reference: a digest wins over a tag, and an unset tag is the chart's own appVersion —
the image CI built from the same commit as this chart.
*/}}
{{- define "teams-lite.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* A moving tag is re-read on every start; a build's own tag never moves. */}}
{{- define "teams-lite.pullPolicy" -}}
{{- if .Values.image.pullPolicy -}}
{{- .Values.image.pullPolicy -}}
{{- else if and (not .Values.image.digest) (eq (default .Chart.AppVersion .Values.image.tag) "latest") -}}
Always
{{- else -}}
IfNotPresent
{{- end -}}
{{- end -}}

{{/* The web front's own port: 19443, the container image's pair (packaging/docker/entrypoint.sh). */}}
{{- define "teams-lite.webPort" -}}19443{{- end -}}

{{/*
Where the image keeps the Intune container's state: $HOME/.local/share/intune-container for the
image's own user, which is the path the linked crate resolves everything under. The embedded
mode's claim is mounted there read-write; the intuneContainer mode mounts the NODE's state there
read-only. One path, two meanings, which is why compose.yaml and compose.host-broker.yaml both
name it.
*/}}
{{- define "teams-lite.intuneStatePath" -}}/home/teams/.local/share/intune-container{{- end -}}

{{/*
Where an enrollment backup to import is mounted, and the name the file has there. The directory
is the Secret's own mount; the file is its one projected key, renamed to the name the backend is
told about (TEAMS_LITE_INTUNE_IMPORT) whatever the key is called in the Secret.
*/}}
{{- define "teams-lite.importDir" -}}/run/teams-lite/intune-import{{- end -}}
{{- define "teams-lite.importFile" -}}enrollment-backup.tar.gz{{- end -}}

{{/* Whether the pod runs its own Intune container. */}}
{{- define "teams-lite.embedded" -}}
{{- if eq .Values.broker.mode "embedded" -}}true{{- end -}}
{{- end -}}

{{/*
`storageClassName:` for a claim, from a value in the chart's own spelling: empty is the cluster's
default class (no field at all), "-" asks for none (an empty string), anything else names one.
*/}}
{{- define "teams-lite.storageClassName" -}}
{{- if eq . "-" -}}
storageClassName: ""
{{- else if . -}}
storageClassName: {{ . | quote }}
{{- end -}}
{{- end -}}

{{/* The names extraEnv gives a value to, so the refusals below can see a collision. */}}
{{- define "teams-lite.extraEnvNames" -}}
{{- range .Values.extraEnv }}{{ .name }} {{ end -}}
{{- end -}}

{{/*
The refusals no schema can state, because each is about two values at once. Rendered by every
template that could otherwise produce a manifest that would deploy and quietly not work.
*/}}
{{- define "teams-lite.validate" -}}
{{- $embedded := include "teams-lite.embedded" . -}}
{{- $extraEnv := splitList " " (include "teams-lite.extraEnvNames" .) -}}
{{- if and $embedded .Values.hostNetwork -}}
{{- fail "hostNetwork=true is refused with broker.mode=embedded: the pod's own Intune container shares the pod's network namespace, and its Xvfb (:99) binds the ABSTRACT socket @/tmp/.X11-unix/X99 — in the node's namespace that collides with the :99 of an Intune container already running there, and whichever starts second loses its display and its broker. It is not needed either: the served sign-in works without it in this mode, because that :99 is the pod's own." -}}
{{- end -}}
{{- if and (not $embedded) .Values.broker.embedded.userNamespaces -}}
{{- fail (printf "broker.embedded.userNamespaces applies to broker.mode=embedded only: the %s mode reaches the NODE's broker as the node's own user, which a pod whose ids are remapped cannot be." .Values.broker.mode) -}}
{{- end -}}
{{- if and (not $embedded) .Values.broker.embedded.vmIsolated -}}
{{- fail (printf "broker.embedded.vmIsolated applies to broker.mode=embedded only: the %s mode boots no Intune container and checks no network namespace, and it reaches the NODE's broker through the node's /proc — which a pod in a VM of its own could not see at all." .Values.broker.mode) -}}
{{- end -}}
{{- if and (not $embedded) .Values.broker.embedded.import.secretName -}}
{{- fail (printf "broker.embedded.import.secretName applies to broker.mode=embedded only: the %s mode boots no Intune container of its own, so an enrollment backup would never be read." .Values.broker.mode) -}}
{{- end -}}
{{- /*
The other direction, and the sharper one, because the embedded mode is the DEFAULT: a value that
names the node's broker with no `broker.mode` beside it is somebody who meant a host mode and
forgot to say so. Rendered, it is a pod that ignores the enrollment they pointed at, downloads an
Intune image of its own and offers "Enroll this device" — whose press registers a SECOND device
for the account. The mode is never inferred from a value, so it is named for them instead.
*/ -}}
{{- if and $embedded .Values.broker.intuneContainer.stateDir -}}
{{- fail "broker.intuneContainer.stateDir is set, but broker.mode is embedded (the default): a pod in that mode boots an Intune container of its OWN and never reads the node's, so the enrollment that state belongs to would be ignored — and its \"Enroll this device\" would register a second device for the account. Add --set broker.mode=intuneContainer to reach the node's broker, or drop the stateDir to keep the pod self-contained." -}}
{{- end -}}
{{- if and $embedded .Values.broker.sessionBus.socket -}}
{{- fail "broker.sessionBus.socket is set, but broker.mode is embedded (the default): a pod in that mode boots an Intune container of its OWN and never dials the node's session bus, so the broker on it would be ignored — and its \"Enroll this device\" would register a second device for the account. Add --set broker.mode=sessionBus to reach the node's broker, or drop the socket to keep the pod self-contained." -}}
{{- end -}}
{{- /*
The embedded pod STARTS AS ROOT and must: its entrypoint delegates the container's cgroup and
gives a fresh volume's root directory to the image's `teams` user, then drops to that user itself.
Three values in a security context undo that without a word, so each is refused by name — in a
read-only release too, which still starts as root (and drops itself) and still mounts the Intune
claim. fsGroup is the one that DAMAGES rather than merely fails: the kubelet
re-groups a volume recursively and adds group read-write, and on the Intune claim that is every
file of a rootfs owned by the pod's subordinate ids and the device's 0600 keyring.
*/ -}}
{{- if $embedded -}}
{{- if not (kindIs "invalid" .Values.podSecurityContext.fsGroup) -}}
{{- fail "podSecurityContext.fsGroup is refused with broker.mode=embedded: the kubelet re-groups a volume RECURSIVELY and adds group read-write, and on the Intune claim that is every file of a rootfs owned by the pod's subordinate ids and the device's 0600 keyring — the enrollment, changed hands and broken. The entrypoint gives a fresh volume's ROOT directory to the image's user itself, and nothing below it, which is all an fsGroup would have been for." -}}
{{- end -}}
{{- range $field, $context := dict "podSecurityContext" .Values.podSecurityContext "securityContext" .Values.securityContext -}}
{{- if $context.runAsUser -}}
{{- fail (printf "%s.runAsUser is refused with broker.mode=embedded: the pod must START AS ROOT — its entrypoint delegates the container's cgroup and gives a fresh volume's root directory to the image's `teams` user, then drops to that user itself. Started as uid %v it skips all of that: the Intune container cannot boot, and a fresh volume stays root's." $field $context.runAsUser) -}}
{{- end -}}
{{- if $context.runAsNonRoot -}}
{{- fail (printf "%s.runAsNonRoot is refused with broker.mode=embedded: the image starts as root on purpose — its entrypoint delegates the container's cgroup and gives a fresh volume's root directory to the image's `teams` user, then drops to that user itself — so the kubelet would refuse to start the container at all." $field) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and $embedded .Values.broker.embedded.userNamespaces (not (semverCompare ">=1.30.0-0" .Capabilities.KubeVersion.Version)) -}}
{{- fail (printf "broker.embedded.userNamespaces needs Kubernetes 1.30 or later, and this is %s: pod user namespaces are beta from 1.30, and the appArmorProfile field the opt-in sets does not exist before it." .Capabilities.KubeVersion.Version) -}}
{{- end -}}
{{- if has "TEAMS_LITE_INTUNE_MODE" $extraEnv -}}
{{- fail "extraEnv must not set TEAMS_LITE_INTUNE_MODE: the pod's whole shape follows broker.mode (hostPID, the volumes, the privileges), so the mode the backend is told is the chart's to write. Set broker.mode instead." -}}
{{- end -}}
{{- if has "TEAMS_LITE_NETNS_IS_OWN" $extraEnv -}}
{{- fail "extraEnv must not set TEAMS_LITE_NETNS_IS_OWN: it turns off the entrypoint's refusal of the node's network namespace, so the chart writes it — from broker.embedded.vmIsolated, which it refuses in a host mode and says the cost of in its notes. Set broker.embedded.vmIsolated=true instead, and only for a pod that runs under a microVM runtime." -}}
{{- end -}}
{{- if and .Values.broker.embedded.import.secretName (has "TEAMS_LITE_INTUNE_IMPORT" $extraEnv) -}}
{{- fail "extraEnv sets TEAMS_LITE_INTUNE_IMPORT beside broker.embedded.import.secretName: two answers to which enrollment to import. Keep one — the Secret, or (for an archive over a Secret's 1 MiB) your own volume and the variable." -}}
{{- end -}}
{{- if and .Values.hostNetwork .Values.ingress.enabled -}}
{{- fail "ingress.enabled needs hostNetwork=false: with hostNetwork the web front listens on the NODE's 127.0.0.1, which no Service and no Ingress can reach. Reach it from the node (tailscale serve) or with kubectl port-forward." -}}
{{- end -}}
{{- if and .Values.hostNetwork (ne .Values.service.type "ClusterIP") -}}
{{- fail "service.type must stay ClusterIP with hostNetwork: the web front is on the node's loopback, and a published Service would point at nothing." -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.className) -}}
{{- fail "ingress.enabled needs ingress.className: an Ingress with no class is taken by the cluster's DEFAULT controller (Traefik on k3s), which publishes the account to whatever reaches the node. Name the controller you mean — `tailscale` for the Tailscale operator." -}}
{{- end -}}
{{- if and .Values.ingress.enabled (include "teams-lite.networkPolicyApplies" .) (not .Values.networkPolicy.from) (not .Values.networkPolicy.allowNamespaces) -}}
{{- fail "ingress.enabled with a NetworkPolicy that lets nothing in: the Ingress controller could not reach the app. Name its namespace in networkPolicy.allowNamespaces (`tailscale` for the Tailscale operator), or describe it in networkPolicy.from." -}}
{{- end -}}
{{- if eq .Values.broker.mode "intuneContainer" -}}
{{- $_ := required "broker.intuneContainer.stateDir is required: the node's intune-container state, normally /home/<user>/.local/share/intune-container" .Values.broker.intuneContainer.stateDir -}}
{{- else if eq .Values.broker.mode "sessionBus" -}}
{{- $socket := required "broker.sessionBus.socket is required: the node user's session bus, /run/user/<uid>/bus" .Values.broker.sessionBus.socket -}}
{{- $owner := index (splitList "/" $socket) 3 -}}
{{- if ne $owner (toString (int .Values.hostUser.uid)) -}}
{{- fail (printf "broker.sessionBus.socket %s belongs to uid %s, but hostUser.uid is %d: the bus answers its own user only." $socket $owner (int .Values.hostUser.uid)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Whether the NetworkPolicy is rendered: asked for, and not a host-network pod, which no policy
applies to (the web front is then on the node's loopback instead).
*/}}
{{- define "teams-lite.networkPolicyApplies" -}}
{{- if and .Values.networkPolicy.enabled (not .Values.hostNetwork) -}}true{{- end -}}
{{- end -}}

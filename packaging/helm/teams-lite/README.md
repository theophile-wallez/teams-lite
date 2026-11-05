# teams-lite Helm chart

teams-lite — a Microsoft Teams client for Linux — as one pod on Kubernetes, with its store on a
persistent volume. It runs the container image from [`packaging/docker`](../../docker), published
by CI to `ghcr.io/theophile-wallez/teams-lite`.

**By default the pod is self-contained** (`broker.mode=embedded`): it boots **its own Intune
container inside itself** — the identity broker, its keyring and the device's enrollment live on a
volume of the pod's own — so it runs on **any node whose kernel permits unprivileged user
namespaces, of a cluster that admits privileged pods**, and nothing on the node is touched. **On
an Ubuntu 23.10+ node (24.04 LTS included) that takes
`kernel.apparmor_restrict_unprivileged_userns=0`**, which Ubuntu ships at 1 — see [Where it
runs](#the-self-contained-pod-the-default). The device is enrolled once: imported from a backup of
an existing enrollment, or enrolled from the app. The two **host modes** (`intuneContainer`,
`sessionBus`) keep the older shape instead — the pod reaches the broker of the machine it runs on,
which needs the **enrolled node** and its **PID namespace** (`hostPID`). **Kubernetes is
UNVERIFIED in every mode**: the chart renders, lints and validates against the Kubernetes API's own
schemas, and the embedded boot was measured under Docker only — no pod has run on a cluster.

```bash
kubectl create namespace teams-lite
kubectl label namespace teams-lite pod-security.kubernetes.io/enforce=privileged
helm install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite
kubectl -n teams-lite logs -f teams-lite-0                       # the first start downloads ~1.7 GB
kubectl -n teams-lite port-forward svc/teams-lite 19443:19443     # http://127.0.0.1:19443
```

## The self-contained pod (the default)

The image's backend links [intune-container](https://github.com/magicabdel/intune-container) and
runs its rootless runtime itself, with no systemd and nothing on the host: on its first start it
downloads the Intune container's image (about **1.7 GB**) onto a claim of its own,
`intune-teams-lite-0` (`broker.embedded.persistence`, 8 GiB), boots it, and keeps it running —
repairing a locked keyring by restarting it, and powering it off cleanly when the pod is stopped.
The web app is up within seconds of the pod starting, and says "Setting up the Intune container…"
while that first download runs — "Starting the Intune container…" on every later boot.

**Enroll it — once.** Either:

- **Import an existing enrollment.** On the machine that enrolled, make the backup; then hand it
  to the release installed above as a Secret, with an **upgrade** (a second `helm install` of the
  same name is refused):

  ```bash
  intune-container backup -o enrollment-backup.tar.gz   # stops and restarts that container for a minute
  kubectl -n teams-lite create secret generic teams-lite-enrollment --from-file=enrollment-backup.tar.gz
  version=$(helm -n teams-lite get metadata teams-lite -o json | jq -r .version)   # the chart it runs
  helm upgrade teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite \
    --version "${version:?no installed chart version}" \
    --reuse-values --set broker.embedded.import.secretName=teams-lite-enrollment
  ```

  **The `--version` is load-bearing.** With none, `oci://…` is the NEWEST chart — CI publishes one
  on every push — and `--reuse-values` then renders it against the OLD chart's coalesced defaults
  rather than its own (that is what the flag does: Helm replaces the new chart's values with the
  old release's), so a key a later chart renamed, removed or now requires fails this chart's strict
  schema with an error that has nothing to do with the import; and where it renders, it moves the
  app to a new image in the middle of an enrollment move. Pinned to the version the release
  already runs, the chart and its defaults are the same ones, and the upgrade changes exactly one
  value. The `${version:?…}` stops the command rather than run it with an empty `--version` (which
  helm reads as "the newest") when the version could not be read — no release, or no `jq`.
  `helm get metadata` is Helm 3.13 or later; on an older one, the version is what follows
  `teams-lite-` in the CHART column of `helm -n teams-lite list`.

  The Secret is part of the pod, so the upgrade replaces the pod, and the new one imports the
  archive at boot — **only while its own state holds no device registration**. So do it BEFORE
  enrolling from the app: a pod that already holds a registration (its own enrollment, or an
  earlier import) ignores the archive and says so in its logs. The first boot after the upgrade
  imports it, and every later one ignores it. (To import from the very first start instead, create
  the Secret first and pass the same `--set` to the `helm install` itself.) **This is a MOVE, not a
  copy: stop that enrollment on the machine it came from** — two live copies of one device are
  unmeasured. The archive *is* the device (its keys and its keyring), so once the pod has imported
  it, drop it — the same pinned upgrade as above, with
  `--set broker.embedded.import.secretName=""` — then delete the Secret. A Secret
  holds at most 1 MiB (how large a real backup is has not been measured); a larger archive goes in
  through `extraVolumes`, readable by uid 1000, with `TEAMS_LITE_INTUNE_IMPORT` pointing at it in
  `extraEnv`. The Secret is required while it is named: a mistyped name or key is a pod that does
  not start, rather than a second device enrolled beside the one you meant to move.
- **Enroll from the app.** With nothing to import, the app offers **Enroll this device** once the
  container is up, and draws the Intune portal's enrollment window — and the sign-in it opens —
  right in the page.

**What it costs.** The pod is **privileged** (`securityContext.privileged: true`): it delegates its
own cgroup, maps a range of subordinate ids and boots a whole systemd inside itself. Its pod has an
`Unconfined` seccomp profile, no `runAsUser` (the entrypoint starts as root, hands its cgroup and
its two volumes to the image's `teams` user, and drops to it) and **no `fsGroup`** — its recursive
chown would give the Intune rootfs, which is owned by the pod's subordinate ids, and the device's
`0600` keyring to one group and break the enrollment. The chart **refuses** all three in
`podSecurityContext` (and `runAsUser` / `runAsNonRoot` in `securityContext`) rather than render a
pod that cannot boot or a claim that gets re-grouped. A namespace enforcing the `baseline` or
`restricted` Pod Security level refuses the pod; label it
`pod-security.kubernetes.io/enforce=privileged`. The root filesystem is read-only
(`readOnlyRootFilesystem: true`): every path the image writes is a volume — the store, the Intune
claim, `~/.cache` and `/tmp`. That was measured only on the host-only image that preceded the
embedded mode (it served the app `--read-only` as another uid). The current image — which starts
as root, takes its one-copy lock in `/tmp` and boots an Intune container — has NOT been run on a
read-only root, as root or as any other uid.

**A read-only release** (`readOnly=true`) boots nothing, so it is rendered without what booting
costs: **not privileged** — every capability dropped but the five its entrypoint uses as root
(`CHOWN` and `DAC_OVERRIDE` to take over a fresh store claim's root, below; `SETUID` and `SETGID`
to drop to `teams`; `KILL` for tini to forward the stop signal to it), no privilege escalation, a
`RuntimeDefault` seccomp profile — with no import Secret mounted and the Intune claim mounted
**read-only**. By the Pod Security Standards that is `baseline` (it still starts as root, so not
`restricted`). The list was measured under Docker with a stand-in for the image's user — a
read-only root, no privilege escalation, these five over a root-owned empty volume: the store root
was taken over and `teams` wrote to it, and without `DAC_OVERRIDE` root could not even reach it
(`/home/teams` is `0700`) — never on a cluster. It **keeps the Intune claim**: a StatefulSet cannot
change its claims in place, so a claim that came and went with `readOnly` would turn the upgrade
that switches it off into a refusal.

**It shows what its store already holds, and nothing more**: it never signs in, so nothing new
ever arrives. So it is worth something only on a store that holds a history — the release's own,
switched with the import's own pinned upgrade (above) carrying `--set readOnly=true` instead — at
the chart version that release already runs, for the import's reason — or a store claim owned by
uid 1000 named by `persistence.existingClaim`. A NEW read-only release gets a claim of its own, fresh and
empty: its entrypoint takes over that claim's root — only a root-owned, empty one, never a
directory something already holds — so the backend can create its store there, which it does
whatever the mode, and the app then starts and shows nothing at all.

**`hostNetwork` is refused** in this mode, and it is not needed: the Intune container shares the
pod's network namespace, and the X display its broker draws on (`:99`) binds an abstract socket —
in the node's namespace that would collide with the `:99` of an Intune container already running
there, and whichever started second would lose its display and its broker. In the pod's own
namespace, the sign-in and enrollment windows are served into the app with no host networking.

**Under a microVM runtime** (Kata Containers, Firecracker), say so with
`--set broker.embedded.vmIsolated=true`. The image refuses the node's network by the kernel's own
fixed number for its INITIAL network namespace — proof of the node's network wherever the pod
shares the node's kernel, which is every ordinary runtime. A microVM pod runs on a guest kernel of
its own, and Kata hands every container of it that guest's initial network namespace: on no host
network at all, it reads the same number, and every start is refused (the logs blame a
`--network host` nobody set). The value writes `TEAMS_LITE_NETNS_IS_OWN=1`, which lets that one
namespace through — the IPC refusal and the `:99` check still run, and the start says so in its
logs. It is **declared, never detected**: nothing in the pod can tell a guest kernel from the
node's, so on a pod that shares the node's kernel it is `hostNetwork` let through. The chart does
not pick the runtime (a cluster whose default handler is a microVM one, or a `runtimeClassName`
added by a post-renderer), and no microVM runtime has run this image — whether its Intune
container boots in one at all is unmeasured.

**Where it runs.** Any **amd64** node (Microsoft's identity broker ships for x86_64 alone) with
**cgroup v2** (the unified hierarchy at `/sys/fs/cgroup`) whose **kernel permits unprivileged user
namespaces** — the Intune container's runtime checks before it boots anything, and refuses to start
without cgroup v2 or while
`user.max_user_namespaces` is 0, Debian's `kernel.unprivileged_userns_clone` is 0, or **Ubuntu's
`kernel.apparmor_restrict_unprivileged_userns` is 1, which is how Ubuntu 23.10 and later (24.04 LTS
included) ship**. The boot's line in the logs then ends `AppArmor restricts unprivileged user
namespaces (kernel.apparmor_restrict_unprivileged_userns is 1)`, on every retry. On such a node,
set it there:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-teams-lite-userns.conf
```

That is the only way past it: the check reads the sysctl's VALUE, so neither `privileged` nor an
AppArmor profile with `userns,` gets through, and a pod cannot set it (it is not a namespaced
sysctl). What it costs is a hardening Ubuntu applies to every process on that node. On a cluster
whose nodes are not all set, label the ones that are and pin the pod with `nodeSelector`. The image
and the Intune image inside it are `linux/amd64` only, so on a cluster with arm64 nodes set
`nodeSelector.kubernetes\.io/arch=amd64`. With a node-local storage class (k3s's `local-path`) the
claims pin the pod to the node it was first scheduled on.

**Memory.** Requests only, no limit, as in every mode. A limit would also have to hold the first
start's download: the crate's image pull keeps every compressed layer in memory until it has them
all (read from oci-client's code, not measured).

### User namespaces instead of privileged (opt-in, UNVERIFIED)

`--set broker.embedded.userNamespaces=true` runs the pod with **`hostUsers: false`** — its root is an
unprivileged id range on the node — and a container that is **not** privileged: `SYS_ADMIN`,
`SETUID` and `SETGID` added, `procMount: Unmasked`, and `appArmorProfile: Unconfined`. **Nothing
about this shape has been run anywhere.** It needs, all of it:

- **Kubernetes 1.30 or later** (pod user namespaces are beta there; the chart refuses the opt-in
  below it), with the `UserNamespacesSupport` and `ProcMountType` feature gates on;
- **containerd 2.1 or later**, with writable cgroups for the pod, and volumes on filesystems that
  support idmapped mounts;
- the kubelet's **`userNamespaces.idsPerPod`** large enough for uid 1000 **and** the 65536
  subordinate ids from 100000 the image gives its Intune container: at least 165536 ids, which the
  kubelet counts in blocks of 65536 — **196608**;
- a **seccomp profile that allows `unshare`, `mount` and `setns`** (the pod's is `Unconfined`; a
  cluster that forbids `Unconfined` needs a `Localhost` profile that allows them).

## The host modes: where your Intune enrollment already is

`broker.mode=intuneContainer` (or `sessionBus` on a classic Intune host) never boots a container of
its own: the pod asks the **Microsoft identity broker of the machine it runs on**. On a
containerized-Intune host that broker lives in your intune-container, and the pod reaches its D-Bus
socket through the node's process table (`/proc/<container leader>/root/run/user/0/bus`). So the
pod needs:

- **the node's PID namespace** (`hostPID: true`), which is the `privileged` Pod Security level —
  label the namespace `pod-security.kubernetes.io/enforce=privileged` where one is enforced;
- **your uid and gid** (`hostUser`): the broker answers the uid the kernel reports, and nothing else;
- **the intune-container state, read-only** (`broker.intuneContainer.stateDir`), mounted as a
  directory that must already exist on the node.

```bash
helm install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite \
  --set broker.mode=intuneContainer \
  --set hostUser.uid=$(id -u) --set hostUser.gid=$(id -g) \
  --set broker.intuneContainer.stateDir=$HOME/.local/share/intune-container
```

That makes it a single-node deployment by nature: **a Kubernetes that runs directly on the enrolled
workstation** — k3s, k0s, or kubeadm on the host. A cluster on another machine has no broker to
reach, and the pod never signs in. **kind, k3d and minikube's docker or podman driver cannot work
either**: their nodes are containers with a PID namespace and a filesystem of their own, so the
node's process table holds no Intune container and the state directory is not there. On a
multi-node cluster, pin the pod with `nodeSelector`; scheduled anywhere else it fails its hostPath
check and does not start. In these modes the pod runs as `hostUser`, non-root, with every
capability dropped.

On a classic Intune host (the broker on your session bus), use
`--set broker.mode=sessionBus --set broker.sessionBus.socket=/run/user/$(id -u)/bus`. The pod mounts
`/run/user` with the node's mounts propagated in, so it keeps finding the bus of the session running
now across a logout and a login. That shape is untested.

**Switching modes** changes the StatefulSet's volume claims (the embedded mode has a second one),
which Kubernetes refuses to change in place: `helm uninstall` first — the claims are kept — then
install in the other mode.

## Why a StatefulSet

One replica, not configurable. One Teams account, one SQLite store, one send-capable backend:

- **It never runs twice.** A StatefulSet's rolling update terminates the old pod before it starts
  the new one — a pod's name is unique, so the controller waits for the deletion — and does not
  start a replacement until the old pod is confirmed gone. A second copy would be a second device
  posting, ringing and syncing as you, and SQLite cannot share a volume across nodes. A Deployment
  gets the same behaviour only with `strategy: Recreate`, and one override away from losing it.
- **An upgrade mends a pod that never started.** `podManagementPolicy: Parallel` — with one replica
  it orders nothing, but under the default `OrderedReady` the controller stops at a pod that is not
  Ready before it applies an update, so a release installed with a typo (stuck in
  `ContainerCreating`) would never be replaced by the `helm upgrade` that fixes it.
- **The volumes are kept.** The volume claim templates' PVCs — `data-teams-lite-0`, and in the
  embedded mode `intune-teams-lite-0` — outlive `helm uninstall`: they are your whole history and
  the device's enrollment. Delete them yourself when you mean to.
- **It is stopped cleanly.** `terminationGracePeriodSeconds` is 90 s where the pod boots its own
  Intune container (30 s in a host mode or a read-only release) — a ceiling, not a delay: the
  entrypoint forwards the TERM to the launcher, and in the embedded mode then powers the Intune
  container off, so the inner systemd, the broker and the keyring are not killed mid-write. What a
  stop does NOT do is hand the calling registration back: the launcher SIGKILLs its backend, so
  Teams keeps offering your calls to the pod's gone endpoint until that registration expires on its
  own, within the hour — after every stop and every upgrade. A longer grace period does not change
  that.

What it costs: a volume claim template cannot be resized through `helm upgrade`. Grow it with
`kubectl edit pvc data-teams-lite-0` (or `intune-teams-lite-0`) on a storage class that allows
expansion. Use a `ReadWriteOnce` class on a local filesystem (k3s's `local-path` is fine); SQLite in
WAL mode does not belong on NFS or any `ReadWriteMany` volume, the Intune rootfs needs a filesystem
that keeps ownership by subordinate ids, and the chart refuses an RWX mode for either.

## Secrets: almost none to give it

The Microsoft sign-in is the broker's, so the chart takes no credential. Everything sensitive the
app holds — every synced message, the GitLab and Linear tokens you enter in Settings, the push key,
the passphrases of sealed chats — lives **in the store on the PVC**, and in the embedded mode the
device's own keys and keyring live on the Intune claim. Treat both volumes as the secret they are:
an encrypted storage class, and no backups to anywhere you would not put your mailbox. The one
credential you may hand it is an enrollment backup to import (above), which is the device itself —
drop it once it is imported.

CI publishes **two** GHCR packages, and a new GHCR package starts out private: the image
(`teams-lite`) and the chart (`charts/teams-lite`). Make both public once, in each package's settings
on GitHub — or, while they are private, `helm registry login ghcr.io` (a token with `read:packages`)
before `helm install oci://…`, and an `imagePullSecrets` entry so the node can pull the image. That
pull secret is the one other Kubernetes Secret this chart may need; `extraEnvFrom` takes a Secret
for anything else you choose to hand the app.

## Reaching it

**Whatever can reach the web port can send as you**: the web front hands the backend's write token
to every page it serves. So the defaults keep it to the pod — a `ClusterIP` Service, no Ingress, and
a NetworkPolicy (on by default) that lets no other pod in — and these are the ways in:

| Way | How |
| --- | --- |
| From the machine | `kubectl -n teams-lite port-forward svc/teams-lite 19443:19443` |
| From your phone, on your tailnet | the [Tailscale operator](https://tailscale.com/kb/1236/kubernetes-operator): `ingress.enabled=true`, `ingress.className=tailscale`, `ingress.tls[0].hosts[0]=teams-lite`, `networkPolicy.allowNamespaces[0]=tailscale` |
| From anywhere, through your Gateway | an [HTTPRoute](https://gateway-api.sigs.k8s.io/api-types/httproute/) behind the chart's own sign-in — see [Publishing it](#publishing-it-a-sign-in-in-front-and-a-gateway-api-route) |
| Through another Ingress controller | the same sign-in (`auth.oauth2Proxy`), or `auth.external=true` when the controller authenticates every request itself |

The chart refuses an Ingress with no `className` (the cluster's default controller — Traefik on k3s
— would take it and publish the account) and one the NetworkPolicy would let nothing reach: name the
controller's namespace in `networkPolicy.allowNamespaces`, or any other peers in `networkPolicy.from`.
It refuses **anything that publishes the app beyond your tailnet with no sign-in in front of it** —
an HTTPRoute, a NodePort or LoadBalancer Service, an Ingress of any class but `tailscale`, and a
Tailscale Ingress carrying the `tailscale.com/funnel` annotation — unless `auth.oauth2Proxy` runs one
or `auth.external` says something in front already authenticates every request (or only a network
you trust reaches it).

**The app answers only to names it knows.** A request whose `Host` is not a loopback name, an IP
address, a tailnet name (`*.ts.net`) or one of `web.allowedHosts` is refused with a 403: that is what
a DNS-rebinding page looks like — same-origin with the app under the attacker's name, and able to
read the write token. The chart adds every `httpRoute.hostnames` and `ingress.hosts` entry itself;
name any other address you reach it under in `web.allowedHosts`. Its socket, likewise, opens only
for a page the app itself served.

**What no NetworkPolicy can keep out is the pod's own node**: every process of every account on the
machine, and every hostNetwork pod running there, can still reach the port — Kubernetes always
allows a node's traffic to its own pods (that is also how the probes and `kubectl port-forward`
work). For host-level isolation, use the node's firewall (or, in a host mode, `hostNetwork`, where
the front stays on `127.0.0.1`), or the sign-in sidecar below, which moves the front onto the pod's
own loopback. A NodePort or LoadBalancer Service publishes the port to whatever reaches the node,
which is why the chart wants a sign-in in front of one too. Egress stays open in every mode: the app talks to Microsoft, and the embedded
Intune container downloads its image and enrolls through the same door.

## Publishing it: a sign-in in front, and a Gateway API route

To reach the app from anywhere without a VPN client, run **oauth2-proxy beside it in the pod**
(`auth.oauth2Proxy`) and route your Gateway to it (`httpRoute`). The web front then listens on the
pod's own `127.0.0.1`, so the sign-in is the only way to it — for the route, every other pod and the
node alike, which no NetworkPolicy could have kept out. Signing in is OpenID Connect against a
provider you already use, and **only the addresses you list get in**.

1. **Register a client** at your provider (Google, Microsoft Entra, Pocket ID, Authentik, Keycloak,
   Zitadel…), with `https://teams.example.com/oauth2/callback` as its redirect URI. Prefer a provider
   where your account has phishing-resistant MFA (a passkey): it is now the lock on your Teams
   account.
2. **Create the Secret** with the client's secret and a cookie secret:

   ```sh
   kubectl -n teams-lite create secret generic teams-lite-oauth2-proxy \
     --from-literal=client-secret='<from your provider>' \
     --from-literal=cookie-secret="$(openssl rand -base64 32 | tr -- '+/' '-_')"
   ```

   A **public** client — registered with no secret, PKCE alone (Zitadel's "PKCE" authentication
   method) — takes `auth.oauth2Proxy.publicClient: true` and a Secret holding only `cookie-secret`.
   oauth2-proxy refuses an OpenID Connect provider with no client secret at all, so the chart hands
   it the empty one (`--client-secret-file=/dev/null`); the PKCE verifier is what proves the exchange.

   **An address is not an identity on a provider you share.** Where anybody may register an
   organization or an account — a Zitadel, Keycloak or Authentik instance serving other people — or
   where another organization's admin can create a user with any address and mark it verified (and
   Microsoft Entra, whose `email` claim the tenant sets), somebody else can be given *your*
   address. Pin your own user id at the provider as well, which only the provider mints:
   `auth.oauth2Proxy.subjects: ["<your sub>"]` (quoted — a Zitadel id is all digits). The chart
   then passes `--oidc-groups-claim=sub` and one `--allowed-group` each, checked beside the
   addresses at sign-in and on every request. Zitadel shows the id on the user's page in its
   console; any provider's is on the line refusing you in `kubectl logs <pod> -c oauth2-proxy`
   (`user:<sub>`). On Zitadel, also turn on **Check authorization on Authentication** for the
   project and grant a role to you alone, so the provider itself refuses everybody else.

3. **Install** with a values file:

   <!-- public-values: the chart's tests render this block -->
   ```yaml
   # public.yaml
   httpRoute:
     enabled: true
     parentRefs:
       - name: public               # your Gateway, and the listener that holds the certificate
         namespace: gateway-system
         sectionName: https
     hostnames:
       - teams.example.com
   auth:
     oauth2Proxy:
       enabled: true
       issuerUrl: https://accounts.google.com
       clientId: 1234-abcd.apps.googleusercontent.com
       existingSecret: teams-lite-oauth2-proxy
       emails:
         - you@example.com
   networkPolicy:
     allowNamespaces:
       - envoy-gateway-system       # where your Gateway's proxies run
   ```

   ```sh
   helm install teams-lite oci://ghcr.io/theophile-wallez/charts/teams-lite -n teams-lite -f public.yaml
   ```

What the chart does with it, and why:

- **The Gateway is yours.** Its listener terminates TLS (cert-manager's gateway-shim annotation on the
  Gateway is the usual way) and must admit routes from this namespace (`allowedRoutes`). The route
  is one rule for every path; the app's socket is an ordinary HTTP/1.1 Upgrade on it, which the
  common implementations (Envoy Gateway, Istio, Cilium, Traefik, NGINX Gateway Fabric) proxy as
  they are. One that applies a request timeout to it cuts the socket: `httpRoute.timeouts.request:
  "0s"` turns that off where it is supported. HSTS and other headers go in `httpRoute.filters`.
- **Let the Gateway's proxies through the NetworkPolicy** (`networkPolicy.allowNamespaces`):
  `envoy-gateway-system` for Envoy Gateway, the Gateway's own namespace for Istio and kgateway. The
  chart refuses a route the policy would let nothing reach.
- **Cilium's own Gateway is in no namespace**: its proxy reaches a backend under Cilium's reserved
  `ingress` identity, which no NetworkPolicy peer can name, so with only `allowNamespaces` the route
  answers 503 (measured on Cilium 1.20, with `kube-system` named). `networkPolicy.allowCiliumIngress:
  true` adds a CiliumNetworkPolicy admitting that identity on the same one port; Cilium admits the
  union of the two, and the NetworkPolicy still keeps every pod out.
- **Only the listed addresses**: `--authenticated-emails-file`, never `--email-domain`, and only an
  address the provider says it has verified. `extraArgs` cannot add a way past it: a flag that lets
  in somebody who is not on the list, or opens a path with no session (`--email-domain`,
  `--skip-auth-route`, `--htpasswd-file`, `--trusted-ip`, …), is refused. The list is a ConfigMap oauth2-proxy watches, so a
  change reaches it without restarting the pod (which would power the Intune container off) — and
  an address taken off it is refused on its very next request, signed in or not. A socket already
  open stays open until it next reconnects: the sign-in is checked when a connection opens.
- **A sign-in lasts a week** (`cookieExpire: 168h`), in a `__Host-` cookie that is Secure, HttpOnly
  and SameSite=Lax. When it runs out, the page notices its socket being refused and reloads, which
  walks through your provider and back — a blink while the provider's own session is alive.
  `cookieRefresh` (off) re-checks the session with the provider that often, so an account the
  provider disables loses access within it — but it needs a refresh token (Entra: add
  `offline_access` to `scope`), or the session ends with the provider's ID token, about hourly.
- **What is reachable without signing in**: the web manifest, its icons and the favicon — static
  files a phone fetches to install the app, which say nothing but its name. Nothing else — and the
  app takes its socket on `/__backend` alone, so none of those paths can be used to open one.
- **Push notifications and calls are unaffected**: the backend reaches the push service and Teams'
  media relays directly, never through the route.
- **The hostname is public anyway**: its certificate lands in the Certificate Transparency logs
  within minutes, and scanners find it. The sign-in is what stands there.
- **Behind the sign-in is your employer's account.** The enrolled, compliant device your
  organization's Conditional Access sees is this pod; it never sees the device you browse from.
  Check that publishing it is acceptable to your organization.

Through an Ingress controller instead of a Gateway, the sign-in is the same: `ingress.enabled=true`
with its `className` and `hosts`, and `auth.oauth2Proxy` as above. ingress-nginx cuts a WebSocket
that is quiet for 60 s by default; the app's server pings any socket quiet for 25 s, and
`nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` (with `proxy-send-timeout`) stops relying
on it. To keep your own authentication in front instead (an ingress controller's auth annotations,
an Envoy Gateway SecurityPolicy, Cloudflare Access), set `auth.external=true` — your word, which the
chart cannot check.

From this machine, a port-forward to the **pod** (`kubectl -n teams-lite port-forward
pod/teams-lite-0 19443:19443`) reaches its loopback around the sign-in; whoever may port-forward in
this namespace holds the account either way.

**UNVERIFIED on a cluster**, like the rest of this chart, and never behind a real Gateway or a real
provider. What WAS measured, under Docker: oauth2-proxy v7.15.5 run with exactly the flags this chart
renders, against a stand-in OpenID Connect provider, in front of the app's own production server and
its mock backend. The page and the socket were sent to sign in; the manifest, the icons and the
favicon were not; a signed-in page loaded and its socket carried a real request to the backend; a
socket opened by another site's page, with the session cookie attached, was refused by the app; an
address taken off the list was refused at sign-in and cut off in an existing session, with the list
reloaded live; and an idle socket stayed open past a minute. The ConfigMap's own way of updating the
file (a symlink swap) was not measured, only an edit of the file.

### `hostNetwork` (host modes only)

Off by default, and refused in the embedded mode (above). In a host mode, `hostNetwork=true` shares
the node's network: the web front then stays on the node's `127.0.0.1:19443` and the broker's
**sign-in window can be served into the app** (it is drawn on an X display whose socket only the
node's network namespace can see). No Service or Ingress can reach a loopback address, so the chart
refuses to render one in that mode — reach it from the node, or with
`kubectl port-forward pod/teams-lite-0 19443:19443`.

Without it, the app says the window cannot be served here; the automatic re-sign-in, which needs no
window, still works.

In that mode the pod's ports are the node's — 19423 and 19443, the image's own pair — which no host
install of teams-lite uses, but the Docker compose container does: the two cannot run on one machine
at the same time. No NetworkPolicy applies to a host-network pod, so none is rendered.

## What it cannot do from a pod

- **Repair a locked Intune keyring — in a host mode.** That restarts your intune-container, which is
  the host's to do: run `intune-container stop && intune-container start`, or keep a teams-lite
  installed on the host, which repairs it on its own. The embedded pod repairs its own.
- **Update itself.** A new build is a new chart version (`helm upgrade`); the in-app update stays a
  link.
- **Answer `@claude`.** The agent CLIs are your own installs, signed in to your own providers, and
  are not in the image.

## Values

| Value | Default | |
| --- | --- | --- |
| `broker.mode` | `embedded` | or `intuneContainer` / `sessionBus` (the host modes) |
| `broker.embedded.persistence.size` | `8Gi` | the Intune state's claim: the rootfs and the enrollment |
| `broker.embedded.persistence.storageClassName` / `.accessModes` | cluster default / `[ReadWriteOnce]` | |
| `broker.embedded.import.secretName` / `.key` | — / `enrollment-backup.tar.gz` | an enrollment backup, imported once |
| `broker.embedded.userNamespaces` | `false` | UNVERIFIED: `hostUsers: false` instead of privileged |
| `broker.embedded.vmIsolated` | `false` | UNVERIFIED: declares a microVM runtime (Kata, Firecracker) for the network-namespace check |
| `hostUser.uid` / `hostUser.gid` | `1000` | host modes: your `id -u` / `id -g` on the node |
| `broker.intuneContainer.stateDir` | — | required in `intuneContainer` mode: `/home/<you>/.local/share/intune-container`; refused in the embedded one |
| `broker.sessionBus.socket` | — | required in `sessionBus` mode; refused in the embedded one |
| `readOnly` | `false` | the backend reads everything and refuses every write (and the embedded mode boots nothing, unprivileged) |
| `image.repository` | `ghcr.io/theophile-wallez/teams-lite` | |
| `image.tag` | the chart's `appVersion` | the image built from the same commit |
| `image.digest` | — | pins the image byte for byte |
| `nodeSelector` | `{}` | host modes: pin to the enrolled node |
| `hostNetwork` | `false` | host modes only; see above |
| `service.type` / `service.port` | `ClusterIP` / `19443` | |
| `ingress.*` | disabled | any class but `tailscale` (or with Funnel) needs a sign-in in front |
| `httpRoute.enabled` | `false` | a Gateway API HTTPRoute; needs `parentRefs` and a sign-in in front |
| `httpRoute.parentRefs` / `.hostnames` / `.filters` / `.timeouts` | — | as written in an HTTPRoute |
| `auth.oauth2Proxy.enabled` | `false` | oauth2-proxy beside the app; the web front moves to the pod's loopback |
| `auth.oauth2Proxy.issuerUrl` / `.clientId` / `.existingSecret` / `.emails` | — | required with it |
| `auth.oauth2Proxy.publicClient` | `false` | a client with no secret (PKCE alone): the Secret holds only `cookie-secret` |
| `auth.oauth2Proxy.subjects` | `[]` | the provider's user ids (`sub`, quoted), checked as well as `emails` — set it on any provider you share |
| `auth.oauth2Proxy.redirectUrl` | `https://<first route hostname>/oauth2/callback` | |
| `auth.oauth2Proxy.cookieExpire` / `.cookieRefresh` | `168h` / off | refresh needs a refresh token from the provider |
| `auth.oauth2Proxy.image.tag` | `v7.15.5` | |
| `auth.external` | `false` | your word that something in front authenticates every request |
| `web.allowedHosts` | `[]` | names the app answers to beyond loopback, IPs, `*.ts.net` and the route hostnames |
| `networkPolicy.enabled` | `true` | no other pod may reach the web port |
| `networkPolicy.allowNamespaces` / `.from` | `[]` / `[]` | who may (e.g. `[tailscale]`) |
| `networkPolicy.allowCiliumIngress` | `false` | admit Cilium's own Gateway/Ingress proxy, which is in no namespace |
| `persistence.enabled` | `true` | `false` keeps the store in an emptyDir, lost with the pod (the Intune claim stays) |
| `persistence.existingClaim` | — | a PVC you made |
| `persistence.storageClassName` / `.size` | cluster default / `2Gi` | |
| `cache.sizeLimit` | `1Gi` | the emptyDir the launcher unpacks the backend into |
| `timezone` | UTC | an IANA name |
| `resources` | requests only | no memory limit by default: an OOM-kill mid-call is worse |
| `terminationGracePeriodSeconds` | 90 embedded / 30 host | a ceiling for the clean stop |
| `extraEnv`, `extraEnvFrom`, `extraVolumes`, `extraVolumeMounts` | | `extraEnv` may not set `TEAMS_LITE_INTUNE_MODE`, `TEAMS_LITE_NETNS_IS_OWN`, `TEAMS_WEB_HOST` or `TEAMS_LITE_ALLOWED_HOSTS` |
| `podSecurityContext`, `securityContext` | | merged over the chart's own, per mode; the embedded mode refuses `fsGroup`, `runAsUser` and `runAsNonRoot` |

An unknown value is refused rather than ignored, at every level the chart defines
(`values.schema.json`): `hostUser.uidd` or `networkPolicy.enable` is an error, never a default. So is
a value of one mode set in another: `broker.embedded.userNamespaces`, `broker.embedded.vmIsolated` or
an import Secret with a host mode, and `hostNetwork`, `broker.intuneContainer.stateDir` or `broker.sessionBus.socket` with the
embedded one. Those last two matter most, because the embedded mode is the DEFAULT: the mode is
never inferred from them, so a host install that forgot `--set broker.mode=…` is refused with the
mode named, rather than deployed as a pod that ignores your enrollment and offers to enroll a
second device.

Resource names are the release's when it contains `teams-lite` (`helm install teams-lite …` gives
`teams-lite`, `teams-lite-0`, `data-teams-lite-0`, `intune-teams-lite-0`), and
`<release>-teams-lite` otherwise; NOTES.txt prints the commands with the right names.

## Troubleshooting

```bash
kubectl -n teams-lite logs -f teams-lite-0       # the launcher, the backend and the Intune container's boot
# where the broker is, read-only — in the embedded mode as the image's user, whom its bus answers:
kubectl -n teams-lite exec teams-lite-0 -- setpriv --reuid=teams --regid=teams --init-groups -- teams-lite-intune-status
kubectl -n teams-lite exec teams-lite-0 -- teams-lite-intune-status   # a host mode
```

- **`violates PodSecurity`** — the namespace enforces `baseline` or stricter; label it `privileged`
  (a read-only release needs only `baseline`).
- **The logs say `AppArmor restricts unprivileged user namespaces`** (embedded) — the node is Ubuntu
  23.10 or later with `kernel.apparmor_restrict_unprivileged_userns=1`. Set it to 0 on the node
  ([Where it runs](#the-self-contained-pod-the-default)); nothing in the pod can.
- **The logs say `runs in the kernel's INITIAL network namespace`** (embedded, no `hostNetwork`) —
  the pod runs under a microVM runtime; declare it with `broker.embedded.vmIsolated=true` (above).
  On any other runtime that sentence is the node's network, and the declaration is wrong.
- **The pod is stuck in `ContainerCreating` with an import Secret named** — the Secret or its key does
  not exist (`kubectl -n teams-lite describe pod teams-lite-0`).
- **The embedded boot cannot delegate its cgroup or map its ids** — the container is not privileged
  (a `securityContext` override, or a policy that strips it), or `/sys/fs/cgroup` is not writable in
  it; the logs say which. Under the user-namespace opt-in, check every requirement above.
- **`hostPath type check failed`** (a host mode) — the pod is on a node without that intune-container
  state, or the path is wrong.
- **The broker cannot be reached / permission denied on `/proc/<pid>/root`** (a host mode) — the uid
  is not the node user's, or an AppArmor profile refuses the ptrace-read it takes (Ubuntu). On
  Kubernetes 1.30 or later set `securityContext.appArmorProfile.type=Unconfined`; before 1.30 the
  annotation `podAnnotations.container\.apparmor\.security\.beta\.kubernetes\.io/teams-lite=unconfined`.
  SELinux nodes (Fedora) may refuse it as well; that shape is untested.

## Versions

Every push to `master` publishes a chart `0.1.<run>` whose `appVersion` is `build-<sha>`, the tag of
the image built from the same commit (and the name of that commit's GitHub release). A
`helm upgrade` with no `--version` moves to the newest build — and to carry your own values across
it, give them again (`-f` your values file) or pass `--reset-then-reuse-values` (Helm 3.14 or
later), which lays the release's last values over the NEW chart's defaults. Never `--reuse-values`
across versions: it renders the new chart against the OLD chart's defaults, which this chart's
strict schema refuses as soon as a key moved. `--reuse-values` belongs to an upgrade pinned to the
version the release already runs, which changes one value and nothing else (the import above).

A **fork** publishes too, from its own `master`, under its own owner:
`ghcr.io/<owner>/teams-lite` and `oci://ghcr.io/<owner>/charts/teams-lite`. Its chart is stamped
with the fork's image and repository as it is packaged (`packaging/helm/package.sh`), so it never
runs a build the fork did not make; the chart in the tree names upstream.

The chart's checks — `helm lint`, the render tests and strict schema validation — are
`packaging/helm/check.sh`, run by CI on every branch and before every publish.

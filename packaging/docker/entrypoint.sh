#!/bin/sh
# What the container image runs: `teams`, with no browser to open, on ports of its OWN — and, in
# the image's default EMBEDDED mode, beside an Intune container this image boots for itself.
#
# TWO STAGES IN ONE SCRIPT, because the two halves need two different users.
#
#   1. AS ROOT, the few things only root can do, and nothing else — and only in EMBEDDED mode
#      (host mode does nothing here). The Intune container's systemd needs a cgroup-v2 subtree it
#      can write, and inside a Docker container or a pod there is no user manager to hand one
#      over: the linked intune-container crate makes that subtree itself, as a child of the cgroup
#      this container runs in (INTUNE_CONTAINER_CGROUP=own) — which only works once root has given
#      that cgroup to the runtime user. A FRESH volume's root is given to it too (a new PVC is
#      root-owned and empty; a Docker named volume already is the runtime user's), the directory
#      itself and nothing under it — and never a directory somebody already owns, which may be the
#      host's. Before any of it, the HOST's network and IPC namespaces are refused (recognised as
#      the kernel's initial ones — under a microVM runtime the initial network namespace is the
#      guest's, which TEAMS_LITE_NETNS_IS_OWN=1 declares), and so is a network namespace that
#      already holds display :99 (another Intune container's). A READ-ONLY
#      run boots nothing, so of all that it does one thing: it takes over a fresh STORE root, which
#      its backend creates its database in all the same. Then it drops to the runtime user with
#      setpriv and runs this same script again.
#   2. AS THE RUNTIME USER, the launcher, in the background, behind a TERM trap: when the
#      container is asked to stop, the launcher is stopped first and then the Intune container is
#      powered off GRACEFULLY. Without the trap its systemd, broker and keyring are SIGKILLed
#      mid-write the moment PID 1 exits — and that keyring holds the device's enrollment.
#
# ONE COPY PER CONTAINER: the very first thing either stage does is take an exclusive lock, and a
# second copy — a `docker exec … teams-lite-container`, even with `--help` — exits 2 before it
# acts, because its way out is that same graceful stop, of the container the first copy runs
# (`take_instance_lock`).
#
# A process that is NOT root here skips stage 1 with one line: the host-broker shape runs as the
# host user from the start (compose.host-broker.yaml's `user:`, the chart's non-root host pods),
# and that mode never needs root.
#
# THE PORTS ARE THE POINT TOO. In the host-broker shape this image shares the host's network
# namespace, so its ports are host ports — and the launcher ATTACHES to whatever already listens
# on its backend's port (`ensureBackend` in launcher/src/backend.ts). On the defaults that would
# be the user's always-on service on 19420: this image would serve somebody else's backend, with
# no token it can find, and every send would be refused. So the image takes its own pair (19423 /
# 19443 — AGENTS.md § Ports), which also keeps its live feed its own when it shares a store with a
# host install: the trouter endpoint id is keyed by the store AND the port (`endpoint_id_path`).
# A READ-ONLY run keeps the read-only backend's own 19430, which is what an explicit
# TEAMS_LITE_PORT would drag it off (bin/teams-dev-server.sh makes the same exception). Either
# port can still be set by the caller; this only fills in what they left unset.
#
# packaging/docker/teams-lite-intune-selftest SOURCES this file for its functions
# (TEAMS_LITE_CONTAINER_LIBRARY=1), so the self-test proves the very root stage a real start runs
# rather than a copy of it. Everything below `main` is a function for that reason.
set -eu

ME=teams-lite-container
# Fixed by the Dockerfile: the user, the backend binary the helpers below run (the launcher
# embeds its own copy and extracts it into ~/.cache; this one is there before anything has been
# extracted), and the launcher.
RUNTIME_USER=teams
SERVER=/usr/local/lib/teams-lite/server
LAUNCHER=/usr/local/bin/teams
# The backend binary's hidden subcommands (src/intune_embedded.rs). The boot is the backend's own
# to start (it decides when); this file names it for the self-test, which sources it.
# shellcheck disable=SC2034
BOOT_SUBCOMMAND=__teams-lite-intune-boot
STOP_SUBCOMMAND=__teams-lite-intune-stop
# What says "stage 1 is done, this process is the runtime user's" across the setpriv exec.
STAGE_ENV=TEAMS_LITE_CONTAINER_STAGE
# The PATH a helper gets when this process has none — the backend's own fallback (`DEFAULT_PATH`
# in src/intune_embedded.rs). The crate runs newuidmap, newgidmap and tar by name.
DEFAULT_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The lock that makes this script ONE PER CONTAINER (`take_instance_lock`). A fixed path rather
# than one under $TMPDIR: every copy has to find the same file whatever its environment says.
# It is held on descriptor 9, which a POSIX redirection cannot take from a variable, so the 9 is
# spelled where it is used.
INSTANCE_LOCK=/tmp/teams-lite-container.lock
# Set only by `take_instance_lock`, and cleared here so a value in the environment cannot claim it.
INSTANCE_LOCKED=
# The abstract socket the Intune container's Xvfb binds for its display :99
# (`ops::CONTAINER_DISPLAY` in the intune-container crate), as /proc/net/unix lists it.
CONTAINER_DISPLAY_SOCKET='@/tmp/.X11-unix/X99'
# The inode numbers the kernel gives the namespaces it BOOTS with, as <linux/nsfs.h> publishes
# them (`enum init_ns_ino`). Every namespace made later is numbered from 0xF0000000 up, so a match
# PROVES that this container runs in the KERNEL's initial namespace of that kind
# (`namespace_is_the_kernels_initial`) — and that is the HOST's wherever the container shares the
# host's kernel, which is runc, crun, rootless podman and every ordinary pod. It is NOT the host's
# under a microVM runtime (Kata Containers, Firecracker): there the container runs on a GUEST
# kernel of the sandbox's own, and Kata drops the network namespace from the spec it hands that
# guest, so every container of the sandbox runs in the guest's initial network namespace — which
# reads this very number on a guest kernel recent enough to fix it. Nothing in this container can
# tell the two apart, so this script never tries: a VM-isolated runtime is DECLARED, with
# TEAMS_LITE_NETNS_IS_OWN=1 (`netns_is_declared_own`), and only for the network namespace — Kata's
# agent makes a fresh IPC namespace per sandbox, so the IPC number never matches there. The IPC
# number has been fixed since Linux 3.8. The NETWORK one is fixed only on recent kernels — this
# machine's 7.3 fixes it — and on an older one the initial network namespace is numbered like any
# other, so the network half of that proof is simply never found there.
INITIAL_NET_NAMESPACE=4026531833 # NET_NS_INIT_INO, 0xEFFFFFF9
INITIAL_IPC_NAMESPACE=4026531839 # IPC_NS_INIT_INO, 0xEFFFFFFF

say() { printf '%s: %s\n' "$ME" "$*" >&2; }
warn() { printf '%s: WARNING: %s\n' "$ME" "$*" >&2; }
# A command's complaint is often one line per file it was refused; a log line wants the first.
first_line() { printf '%s\n' "$1" | sed -n 1p; }

# Whose Intune container this image deals with — declared, never detected (the house rule), and
# read with the backend's own rule (`parse_mode`): unset or empty is `host`, and any other value
# is refused LOUDLY rather than guessed at, because the two modes do opposite things with an
# Intune container (boot and stop one of their own, or never touch the user's).
resolve_mode() {
  case "${TEAMS_LITE_INTUNE_MODE:-}" in
    '' | host) INTUNE_MODE=host ;;
    embedded) INTUNE_MODE=embedded ;;
    *)
      say "TEAMS_LITE_INTUNE_MODE=${TEAMS_LITE_INTUNE_MODE} is not a mode teams-lite knows: set it to \`embedded\` (this image boots its own Intune container, the default) or \`host\` (it reaches the identity broker of the machine it runs on)"
      exit 2
      ;;
  esac
}

is_read_only() { [ "${TEAMS_LITE_READ_ONLY:-}" = 1 ]; }

# The data root the backend and the crate both resolve (`$XDG_DATA_HOME`, else
# `$HOME/.local/share`): the store is `<it>/teams-lite`, the Intune state `<it>/intune-container`.
data_home() { printf '%s\n' "${XDG_DATA_HOME:-${HOME:-/home/$RUNTIME_USER}/.local/share}"; }

# Something has to reap and forward signals, and as PID 1 a shell does neither well: the kernel
# drops a signal PID 1 has no handler for, and every orphan — the crate's own supervisor among
# them — becomes its zombie. The image's ENTRYPOINT already puts tini there; a `--entrypoint`
# override or a pod `command:` does not, so this puts it back.
supervise_as_pid1() {
  if [ "$$" = 1 ] && [ -x /usr/bin/tini ]; then
    exec /usr/bin/tini -- "$0" "$@"
  fi
}

# ONE COPY OF THIS SCRIPT PER CONTAINER, and the second one never gets as far as anything. A copy
# started inside a running container — `docker exec teams-lite teams-lite-container`, or the
# innocent-looking `… --help` — lands as root (the image has no `USER`), runs the root stage,
# starts a second launcher, which finds the ports taken (or prints its usage) and exits, and then
# reaches the end of stage 2: the graceful stop, of the Intune container the FIRST copy runs —
# the live one, holding the enrollment. So the first thing a copy does is take an exclusive,
# NON-blocking flock on a fixed file and keep it for its whole life, and a copy that finds it
# held exits 2 with a sentence before it touches anything. Before the root stage on purpose: that
# stage's `:99` check would otherwise read the live container's own display as somebody else's
# and refuse with the wrong reason. A PPID test would be no substitute — in the host-broker shape
# (`pid: host`) tini is a subreaper rather than PID 1, and an exec'd copy's parent is the
# runtime's shim, which says nothing about whether a first copy is up.
#
# The lock lives on descriptor 9 of THIS SHELL and of nothing else. Taken before the root stage,
# it crosses the setpriv exec on the same open file description, which stage 2 finds still naming
# the lock and takes again — a flock its own description already holds is granted at once. And
# every child is started with `9>&-`, so the launcher, the backend and above all the Intune
# container's supervisor (whose descriptors that container's PID 1 inherits for its whole life)
# never carry it: the lock means "this script is running", and it goes when the script does.
#
# The file is CREATED with one open and LOCKED through another, read-only. A lock needs no write,
# and a file a root start left behind (`docker restart` keeps /tmp) cannot be opened for writing
# by the runtime user — fs.protected_regular even refuses root an O_CREAT open of another user's
# file in a sticky /tmp — while a read-only open of it works for everyone. Anything but a plain
# file at that path (a symlink planted there, a directory) is refused rather than followed.
take_instance_lock() {
  if ! lock_is_on_descriptor_9; then
    if [ -L "$INSTANCE_LOCK" ] || { [ -e "$INSTANCE_LOCK" ] && [ ! -f "$INSTANCE_LOCK" ]; }; then
      say "refusing to start: $INSTANCE_LOCK is not a plain file — it is the lock that keeps a second copy of this script out of a running container, and this script never follows it anywhere else"
      exit 2
    fi
    # `command` on both: a redirection that fails on a SPECIAL builtin (`:`, `exec`) makes a
    # POSIX shell exit on the spot — silently here, with its complaint sent to /dev/null.
    { command : >>"$INSTANCE_LOCK"; } 2>/dev/null || :
    if ! { command exec 9<"$INSTANCE_LOCK"; } 2>/dev/null; then
      say "refusing to start: cannot open $INSTANCE_LOCK — without that lock nothing stops a second copy of this script from powering the running Intune container off; /tmp has to be writable"
      exit 2
    fi
  fi
  if ! flock -n 9; then
    say "refusing to start: another teams-lite-container (or teams-lite-intune-selftest) already runs in this container and holds $INSTANCE_LOCK. Both end by powering the Intune container off, so a second copy would stop the RUNNING one on its way out (a second launcher only finds the ports taken and exits) — taking this install's sign-in down. To look at it, use \`teams-lite-intune-status\` and the logs; to restart it, restart the container"
    exit 2
  fi
  INSTANCE_LOCKED=1
}

# Whether this shell's descriptor 9 is open on the lock file — the one inherited across the
# setpriv exec. By device and inode, which is what "the same file" means (`test -ef` would say it
# too, but POSIX leaves it undefined). /proc/$$ is THIS shell: $$ is expanded before stat runs.
lock_is_on_descriptor_9() {
  _held=$(stat -L -c '%d:%i' "/proc/$$/fd/9" 2>/dev/null) || return 1
  [ "$_held" = "$(stat -c '%d:%i' "$INSTANCE_LOCK" 2>/dev/null)" ]
}

# ---- stage 1: as root -------------------------------------------------------------------------

# Give a volume's ROOT to the runtime user — and only a root nobody has used yet. A fresh
# Kubernetes PVC is a root-owned, empty directory (a filesystem made for it may hold a root-owned
# `lost+found` and nothing else), and the runtime user cannot write a byte to it until its root is
# theirs; the chart sets no fsGroup in embedded mode for the reason below. A Docker named volume
# starts out as a copy of the image's own directory, already the runtime user's, and is left
# exactly as it is.
#
# ANYTHING ELSE IS SOMEBODY'S, and this process is root — with Docker's default (no user-namespace
# remapping) container root IS host root, so a chown here lands on the HOST. A directory owned by
# another id is a host directory bound in (compose.yaml's own store bind, to bring an existing
# install's history along) or a volume made for another uid, and re-owning it would break its
# owner: a host install could no longer create its SQLite -wal and -shm beside its own store,
# while the files inside still refused this container. So such a directory is LEFT AS IT IS and
# the warning says what does fix it — an image built for that owner's uid. A root-owned directory
# that already holds something is left too: it is not a fresh volume, and whatever is in it would
# stay root's.
#
# The directory ITSELF, never what is under it: what is under the Intune state is the inner
# container's rootfs, owned by SUBORDINATE ids, and a recursive pass would hand every file of it to
# one uid and break that container for good. Only the uid decides who may write; the group of a
# directory the runtime user already owns is left to that owner.
#
# A directory root cannot even REACH is said, never skipped in silence: the runtime user's home is
# 0700, so root crosses it only with DAC_OVERRIDE, and a container that was not given it (a
# securityContext that dropped it) would otherwise leave a fresh volume root's with nothing in the
# log — and the backend would then fail to create its store with no word about why. The message is
# read in the C locale, which is what says "Permission denied" rather than a translation of it.
own_dir() {
  if ! _owner=$(LC_ALL=C stat -c '%u:%g' "$1" 2>&1); then
    case "$_owner" in
      *'Permission denied'*)
        warn "cannot reach $1 as root ($(first_line "$_owner")): a directory above it is closed to root without the DAC_OVERRIDE capability — in this image, $RUNTIME_USER's own 0700 home — and this container was not given it. It is left as it is, so a fresh volume mounted there stays root's, where $RUNTIME_USER cannot write a byte"
        ;;
    esac
    return 0
  fi
  [ -d "$1" ] || return 0
  case "$_owner" in
    "$2":*) return 0 ;;
  esac
  if [ "$_owner" != 0:0 ] || ! is_fresh_volume_root "$1"; then
    warn "$1 belongs to $_owner, not to $RUNTIME_USER ($2:$3), and is left as it is: only a fresh volume's root (root-owned and empty) is taken over, never a directory something already owns or holds. If it is a host directory, build the image for its owner (TEAMS_LITE_UID / TEAMS_LITE_GID) — until then, writes to it as $RUNTIME_USER may be refused"
    return 0
  fi
  if chown "$2:$3" "$1" 2>/dev/null; then
    say "gave $1 to $RUNTIME_USER (a fresh volume's root, owned by $_owner; the directory itself, nothing under it)"
  else
    warn "could not give $1 to $RUNTIME_USER (it is $_owner) — writes to it will be refused"
  fi
}

# Empty, or holding only the root-owned `lost+found` a freshly made filesystem carries.
is_fresh_volume_root() {
  _entries=$(ls -A "$1" 2>/dev/null) || return 1
  [ -z "$_entries" ] && return 0
  [ "$_entries" = lost+found ] && [ -d "$1/lost+found" ] && [ ! -L "$1/lost+found" ] &&
    [ "$(stat -c '%u:%g' "$1/lost+found" 2>/dev/null)" = 0:0 ]
}

# The cgroup-v2 path this process runs in, relative to the hierarchy it sees (`0::/…` in
# /proc/self/cgroup). `/` inside a private cgroup namespace — Docker's and containerd's default
# on cgroup v2 — and the full path from the hierarchy's root under a host cgroup namespace.
own_cgroup_path() { sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null | head -n 1; }

# Hand the cgroup this container runs in to the runtime user: the directory, and the three files
# the crate writes through when it makes the Intune container's scope a CHILD of it — creating
# the child needs the directory, and moving a process into it needs write access to the
# cgroup.procs of the common ancestor, which is this one (cgroup.threads for a threaded subtree,
# cgroup.subtree_control for the controllers the inner systemd asks for). Never more: the parent
# of this cgroup is the platform's, and the limits on this one stay where the platform put them.
#
# Two ways in, tried in order, because the platforms differ in the one way that matters:
#
#   • DIRECTLY, where /sys/fs/cgroup is writable — a privileged Docker container or Kubernetes
#     pod, whose root is the host's root and whose cgroupfs is mounted read-write.
#   • Through a cgroup2 mount of OUR OWN where it is read-only — a non-privileged Docker container,
#     whose runtime mounts it read-only and root-owned (a direct chown answers EROFS). Read-only is
#     a property of the MOUNT, not of the files: in a fresh user, mount and cgroup namespace, root
#     mounts cgroup2 again — rooted at this very cgroup, whatever its path — and the chown lands
#     on the same files. The tmpfs first is the crate's own move and for its reason: cgroup2 is
#     one superblock, and the legacy mount call refuses it on the root of a mount of itself
#     (measured: bookworm's mount(8) answers "already mounted or mount point busy"; trixie's
#     mounts it without the tmpfs, which then costs nothing). Both mounts die with that
#     namespace; nothing about this container's own view changes.
#
# MEASURED on Docker 29.9 (runc, cgroup v2), in a stock debian:trixie-slim prepared as the
# Dockerfile prepares the image (uidmap and libcap2-bin, the file capabilities, the user and its
# subordinate ranges) and run as root with `--security-opt seccomp=unconfined --security-opt
# systempaths=unconfined --security-opt apparmor=unconfined`, through THIS function:
#
#   • non-privileged, private cgroup namespace (`0::/`): the direct chown answered EROFS and the
#     nested line delegated the cgroup;
#   • non-privileged, `--cgroupns=host` (`0::/system.slice/docker-<id>.scope`, the path that is
#     not `/`): the same, at that path;
#   • `--privileged`, under both cgroup namespaces: the direct chown delegated it.
#
# In every one the runtime user then did what the crate does — made a child scope and moved a
# process into it (directly where cgroupfs was writable, through a private mount where it was
# not) — and newuidmap mapped 65 535 subordinate ids through its file capability. NOT measured:
# Kubernetes, where a privileged pod is the first case and the `hostUsers: false` opt-in needs
# the runtime to have delegated the pod's cgroup to the pod's own root (the chart says so).
#
# The SAME nested line on bookworm's util-linux 2.38.1 is refused outright (`could not parse ID:
# '0:0:1'` — the colon form of --map-users is 2.39's, and 2.38 maps root's extra ids only through
# newuidmap and a subordinate range root does not have), which is why the image is trixie and its
# build asserts util-linux 2.39 or later. The maps are symmetric (0 to 0, the runtime uid to
# itself), so the order of the two numbers — which changed in 2.39 — cannot matter.
delegate_cgroup() {
  _uid=$1 _gid=$2 _why='' _nested=
  _rel=$(own_cgroup_path)
  if [ -z "$_rel" ]; then
    warn "this container is not on the cgroup v2 hierarchy (no 0:: line in /proc/self/cgroup) — the Intune container needs cgroup v2, and will not boot"
    return 0
  fi
  _dir=/sys/fs/cgroup${_rel%/}
  if [ -d "$_dir" ] &&
    _why=$(chown "$_uid:$_gid" "$_dir" "$_dir/cgroup.procs" "$_dir/cgroup.threads" "$_dir/cgroup.subtree_control" 2>&1); then
    say "delegated the cgroup ${_rel} to $RUNTIME_USER (cgroupfs is writable here)"
    return 0
  fi
  # The inner script takes the ids as its own $1 and $2 — single quotes on purpose.
  # shellcheck disable=SC2016
  if _nested=$(unshare --user --map-users=0:0:1 --map-users="$_uid:$_uid:1" \
    --map-groups=0:0:1 --map-groups="$_gid:$_gid:1" --mount --cgroup \
    sh -euc 'mount -t tmpfs -o mode=0755 tmpfs /sys/fs/cgroup
             mount -t cgroup2 cgroup2 /sys/fs/cgroup
             cd /sys/fs/cgroup
             chown "$1:$2" . cgroup.procs cgroup.threads cgroup.subtree_control' \
    delegate "$_uid" "$_gid" 2>&1); then
    say "delegated the cgroup ${_rel} to $RUNTIME_USER through a cgroup2 mount of its own ($(first_line "${_why:-$_dir is not visible here}"))"
    return 0
  fi
  warn "could not delegate the cgroup ${_rel} to $RUNTIME_USER — the Intune container will not boot. Directly: $(first_line "${_why:-no such directory $_dir}"). Through a namespace of its own: $(first_line "${_nested:-refused}"). Run the container privileged, or with --security-opt seccomp=unconfined --security-opt apparmor=unconfined (compose.yaml sets both)"
}

# The inner container maps 65 536 ids through newuidmap and newgidmap, and under Docker the
# SETUID form of those is refused (measured: EPERM) — the image carries them as FILE capabilities
# instead (the Dockerfile). Three things undo that without a word, so each one is said here:
# capabilities stripped from the binaries, `no_new_privs` (Docker's no-new-privileges, Kubernetes'
# allowPrivilegeEscalation: false — under it the kernel ignores file capabilities at exec, and it
# is inherited by every process below this one), and a missing subordinate range.
check_id_mapping() {
  for _pair in newuidmap:cap_setuid newgidmap:cap_setgid; do
    _helper=${_pair%%:*} _cap=${_pair#*:}
    if ! _path=$(command -v "$_helper" 2>/dev/null); then
      warn "$_helper is missing — the Intune container cannot map its id range"
      continue
    fi
    _caps=$(getcap "$_path" 2>/dev/null) || _caps=
    case "$_caps" in
      *"$_cap"*) ;;
      *) warn "$_path carries no $_cap file capability — the Intune container cannot map its id range (a setuid newuidmap is refused inside a container)" ;;
    esac
  done
  if grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status 2>/dev/null; then
    warn "no_new_privs is set on this container (a no-new-privileges security option, or allowPrivilegeEscalation: false): the kernel ignores newuidmap's file capabilities, and the Intune container cannot map its id range"
  fi
  for _file in /etc/subuid /etc/subgid; do
    if ! grep -q "^$RUNTIME_USER:" "$_file" 2>/dev/null; then
      warn "$_file holds no range for $RUNTIME_USER — the Intune container cannot map its id range"
    fi
  done
}

# The three kernel settings the intune-container runtime REFUSES to boot under (`runtime::preflight`
# in the crate, which every setup and every start runs before it downloads or starts anything) —
# said here, at the start, rather than as the boot helper's failure a minute later and on every
# retry after it. None of them can be changed from inside a container: they are the host's, or
# the node's, and so is the remedy each sentence names.
#
# The AppArmor one is the one a real deployment meets: Ubuntu 23.10 and later — 24.04 LTS, the
# distribution Intune supports, and a common Kubernetes node — ship it at 1. The crate refuses on
# the sysctl's VALUE, so nothing about this container helps: not `apparmor=unconfined`, not a
# privileged pod, not an AppArmor profile that allows `userns`. Setting it to 0 on the host is
# the only way past it.
check_user_namespaces() {
  if [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = 0 ]; then
    warn "user.max_user_namespaces is 0 on this host: the Intune container cannot boot — the intune-container runtime refuses to start with user namespaces disabled. The remedy is the host's: raise user.max_user_namespaces (sysctl, and a file in /etc/sysctl.d to keep it)"
  fi
  if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ]; then
    warn "kernel.unprivileged_userns_clone is 0 on this host: the Intune container cannot boot — the intune-container runtime refuses to start without unprivileged user namespaces. The remedy is the host's: \`sysctl -w kernel.unprivileged_userns_clone=1\`, and a file in /etc/sysctl.d to keep it"
  fi
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    warn "kernel.apparmor_restrict_unprivileged_userns is 1 on this host (Ubuntu 23.10 and later ship it so): the Intune container cannot boot — the intune-container runtime refuses to start whenever that sysctl is 1, whatever AppArmor profile this container runs under, so apparmor=unconfined and a privileged pod do not help. The only remedy is the host's (the node's): \`sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\`, and a file in /etc/sysctl.d to keep it"
  fi
}

# Whether this process runs in the kernel's initial namespace of kind $1 (`net`, `ipc`), whose
# fixed inode number is $2. The ns link is followed (`-L`) to the namespace itself; /proc/self is
# the stat process, which a command substitution starts in this shell's namespaces. Measured
# 2026-11-03 on this machine's 7.3 kernel, with throwaway debian:trixie-slim containers (the
# image's own base): `--network host` reads 4026531833 and `--ipc host` reads 4026531839, while a
# bridge network and a private (or `shareable`) IPC namespace read numbers from 4026531840 up. A
# microVM runtime was NOT measured: what it reads is from Kata's own code (above), not a run.
namespace_is_the_kernels_initial() { [ "$(stat -L -c %i "/proc/self/ns/$1" 2>/dev/null)" = "$2" ]; }
network_is_the_kernels_initial() { namespace_is_the_kernels_initial net "$INITIAL_NET_NAMESPACE"; }

# Whether the operator DECLARED that this container runs under a microVM runtime, so the kernel's
# initial network namespace here is the guest's — this sandbox's own — rather than the host's. A
# declaration, never a detection (the house rule, and there is nothing here to detect it by): `1`
# declares it, unset, empty and `0` do not, and any other value is refused LOUDLY rather than read
# either way — `true` taken for no would refuse the start with a sentence about `--network host`
# nobody set, and taken for yes would be a guess about the one check that keeps this image off the
# user's own display. It relaxes the NETWORK-namespace proof and nothing else: the IPC refusal and
# the :99 check below run exactly as they do without it.
netns_is_declared_own() {
  case "${TEAMS_LITE_NETNS_IS_OWN:-}" in
    '' | 0) return 1 ;;
    1) return 0 ;;
    *)
      say "TEAMS_LITE_NETNS_IS_OWN=${TEAMS_LITE_NETNS_IS_OWN} is not a value teams-lite knows: set it to 1 ONLY when this container runs under a microVM runtime (Kata Containers, Firecracker), whose guest kernel's initial network namespace is the sandbox's own — or leave it unset"
      exit 2
      ;;
  esac
}

# The two decisions the refusals take. A network namespace is the host's when it is the kernel's
# initial one and nobody declared a VM-isolated runtime; the IPC one is the host's when it is the
# kernel's initial one, with no declaration that could change that (see above).
network_is_the_hosts() { network_is_the_kernels_initial && ! netns_is_declared_own; }
ipc_is_the_hosts() { namespace_is_the_kernels_initial ipc "$INITIAL_IPC_NAMESPACE"; }

# What a declared VM-isolated runtime changed — said on every start that reads it, because it
# turns a refusal off and the log is where somebody looks for why a start was allowed. Only on a
# container that really is in the kernel's initial network namespace does it change anything, and
# that is when the line names what the declaration costs if it is wrong.
say_the_netns_declaration() {
  netns_is_declared_own || return 0
  if network_is_the_kernels_initial; then
    say "TEAMS_LITE_NETNS_IS_OWN=1: this container runs in the kernel's INITIAL network namespace, and is let through on that declaration alone — true only under a microVM runtime (Kata Containers, Firecracker), whose guest kernel is this sandbox's. On a container that shares the HOST's kernel that namespace is the host's (--network host): unset the declaration there, or the Intune container this image boots takes the display :99 of the user's own"
  else
    say "TEAMS_LITE_NETNS_IS_OWN=1 is declared and changes nothing here: this container's network namespace is not the kernel's initial one"
  fi
}

# EMBEDDED MODE NEVER RUNS IN THE HOST'S NETWORK OR IPC NAMESPACE, and both are refused before
# anything starts, because a container never leaves the namespaces it was started in: a check at
# the start covers its whole life. That is the difference from the :99 check below, which can only
# see a display that is ALREADY bound — and under `network_mode: host` with `restart:
# unless-stopped` the daemon brings this container up at boot, before the user's session has
# started their own Intune container's Xvfb. Recognised by the namespace itself, the refusal does
# not depend on which of the two came up first.
#
#   • NETWORK: the Intune container this image boots shares this container's network namespace,
#     and its display :99 is an ABSTRACT socket, which lives in the network namespace. In the
#     host's, it takes the host's :99 — the user's own Intune container's — and whichever of the
#     two starts second loses its display and with it its broker (it exits at activation with no
#     :99): the user's sign-in on this machine, or this container's.
#   • IPC (`--ipc host`): Docker then hands the container the host's /dev/shm, which the crate
#     binds into the Intune container — and that is where the user's own identity broker keeps the
#     POSIX semaphores of its OneAuth and MSAL locks. The inner container's session setup deletes
#     every held one it finds no process of its OWN pid namespace mapping (the crate's stale-lock
#     cleanup), and its broker takes locks of the same names: the user's broker loses its mutual
#     exclusion, or blocks on a lock this container holds when it is stopped.
#
# On a kernel that does not fix the network namespace's number (above), the network refusal is the
# :99 check alone, which covers only a :99 already listening when this container starts — so host
# networking is UNSUPPORTED in embedded mode whatever the kernel, and refused by proof only where
# the kernel makes it provable.
#
# The proof is about the KERNEL's initial network namespace, which is the host's only where the
# container shares the host's kernel. Under a microVM runtime it is the guest's, and the refusal
# would end every start of a container that is on no host network at all — so the sentence names
# that case, and the one declaration that lets it through.
refuse_the_hosts_namespaces() {
  if network_is_the_hosts; then
    say "refusing to start in embedded mode: this container runs in the kernel's INITIAL network namespace — the HOST's (--network host, network_mode: host) wherever the container shares the host's kernel. The Intune container this image boots draws its sign-in and its identity broker on display :99, an abstract socket that lives in the network namespace — in the host's it is the :99 of the user's own Intune container, and whichever of the two started second would lose its display and its broker. Ways out: run this container on a network of its own (no --network host; compose.yaml gives it one), or let it use the host's Intune container instead with the host mode (compose.host-broker.yaml, TEAMS_LITE_INTUNE_MODE=host). If — and ONLY if — it runs under a microVM runtime (Kata Containers, Firecracker), whose guest kernel's initial namespace is the sandbox's own and no host's, declare that with TEAMS_LITE_NETNS_IS_OWN=1 (the chart's broker.embedded.vmIsolated=true)"
    exit 2
  fi
  say_the_netns_declaration
  if ipc_is_the_hosts; then
    say "refusing to start in embedded mode: this container runs in the HOST's IPC namespace (--ipc host), so its /dev/shm is the host's — where the user's own identity broker keeps the semaphores of its OneAuth and MSAL locks. The Intune container this image boots would clear the ones it cannot see a process of its own holding, and take locks of the same names. Run it with an IPC namespace of its own (no --ipc host; compose.yaml gives it one), or use the host's Intune container with the host mode (compose.host-broker.yaml, TEAMS_LITE_INTUNE_MODE=host)"
    exit 2
  fi
}

# Whether this network namespace already holds the abstract socket of display :99. In a namespace
# of this container's own — a bridge network, a pod — /proc/net/unix lists only this container's
# sockets, and before the boot nothing here has bound one; so a listing proves the namespace is
# SHARED with something that draws on :99: another container's (`--network container:<it>`), or
# the host's own Intune container on a kernel whose host namespace cannot be recognised by number.
# Read by the self-test as well, which refuses with its own words. The path is the EIGHTH column
# (Num RefCount Protocol Flags Type St Inode Path), and it is compared whole: `X990` is another
# display, and a pattern would need its dots escaped to be exact.
display_99_is_held() {
  [ -r /proc/net/unix ] || return 1
  while read -r _ _ _ _ _ _ _ _path; do
    [ "$_path" = "$CONTAINER_DISPLAY_SOCKET" ] && return 0
  done </proc/net/unix
  return 1
}

# Embedded mode never shares a network namespace with another Intune container — the reason is the
# network half of `refuse_the_hosts_namespaces`, and the loser could be the host user's own Intune
# container, restarted by its keyring repair while this one held :99. What this catches is the
# shared namespace that is NOT recognisable as the host's, and only while its :99 is bound: it is a
# look at one moment, never a proof about the namespace (see above).
refuse_a_shared_display() {
  if display_99_is_held; then
    say "refusing to start in embedded mode: this container's network namespace already holds display :99 ($CONTAINER_DISPLAY_SOCKET in /proc/net/unix) — it is shared with another Intune container (another container's network, or the host's under --network host). The Intune container this image boots draws on :99 too, and whichever of the two started second would lose its display and its identity broker. Two ways out: run this container on a network of its own (no --network host or container:…; compose.yaml gives it one), or let it use the host's Intune container instead with the host mode (compose.host-broker.yaml, TEAMS_LITE_INTUNE_MODE=host)"
    exit 2
  fi
}

# What an embedded boot needs from the host, checked before anything is handed over: namespaces of
# its own (refused otherwise), and kernel settings that permit the boot (said).
embedded_preflight() {
  refuse_the_hosts_namespaces
  refuse_a_shared_display
  check_user_namespaces
}

# setpriv keeps the environment, so the HOME the next stage sees — and every path derived from it
# here — is set before anything else: the runtime user's, whatever root's own would have been.
adopt_runtime_user_env() {
  _home=$(getent passwd "$RUNTIME_USER" | cut -d: -f6)
  export HOME="${_home:-/home/$RUNTIME_USER}" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER"
}

# Stage 1 itself, which does something only in EMBEDDED mode. Host mode has no Intune container of
# this image's own (the one it reaches is the host user's, mounted read-only), and its store is the
# host user's: nothing is delegated and nothing is taken over.
#
# A READ-ONLY run boots no Intune container either, so it delegates nothing, checks no namespace
# (nothing it starts draws on :99 or takes a lock) and leaves the cache and the Intune state as they
# were handed over — the state is the enrollment, and a read-only run never writes it. What it
# DOES take over is a fresh STORE root, and only that, because its backend writes there whatever
# the mode: the store's schema is created and migrated on open, deliberately ungated
# (`prepare_store` in src/bin/server.rs). Without this, a read-only run handed a fresh, root-owned
# store volume — the claim a new Kubernetes release gets — cannot create its database, and its
# backend exits at every start. A fresh root holds nothing (`own_dir` takes over nothing else), so
# nobody's data is touched; a directory somebody already owns is left exactly as before, the
# host's included.
# What it needs as root is CHOWN, and DAC_OVERRIDE to reach the volume at all — the runtime user's
# home above it is 0700, which root without that capability cannot cross — both in Docker's
# default set and in Kubernetes' `baseline` Pod Security level (the chart's read-only pod adds them).
root_stage() {
  _uid=$(id -u "$RUNTIME_USER")
  _gid=$(id -g "$RUNTIME_USER")
  adopt_runtime_user_env
  if [ "$INTUNE_MODE" != embedded ]; then
    say "host mode: nothing to do as root — the Intune container is the host user's, and the store and the cache are left as they were handed over"
    return 0
  fi
  _data=$(data_home)
  if is_read_only; then
    own_dir "$_data/teams-lite" "$_uid" "$_gid"
    say "read-only: no cgroup is delegated, and nothing but a fresh store root is taken over — a read-only run never boots an Intune container, but its backend still creates its store"
    return 0
  fi
  embedded_preflight
  own_dir "$_data/teams-lite" "$_uid" "$_gid"
  own_dir "$HOME/.cache" "$_uid" "$_gid"
  own_dir "$_data/intune-container" "$_uid" "$_gid"
  delegate_cgroup "$_uid" "$_gid"
  check_id_mapping
}

# Become the runtime user and run this script again as stage 2. Real, effective and saved ids at
# once (--reuid/--regid), its own groups, no inheritable capabilities — and the kernel clears the
# rest as the uid leaves 0. Deliberately NOT --no-new-privs: it would make the kernel ignore the
# file capabilities newuidmap and newgidmap carry, and the inner container could not map its ids.
drop_to_runtime_user() {
  export "$STAGE_ENV=user"
  exec setpriv --reuid="$RUNTIME_USER" --regid="$RUNTIME_USER" --init-groups --inh-caps=-all -- "$0" "$@"
}

# What a process that is not root says instead of stage 1, and what it still checks in embedded
# mode: the same preflight (the host's namespaces and a shared :99 are refused however this
# container was started), and whether whoever started it already handed it its cgroup (a platform
# may), since without that an embedded boot cannot work and nothing else would say why.
not_root_stage() {
  say "running as uid $(id -u), not root — the root stage is skipped"
  if [ "$INTUNE_MODE" = embedded ] && ! is_read_only; then
    embedded_preflight
    _rel=$(own_cgroup_path)
    _dir=/sys/fs/cgroup${_rel%/}
    if [ -z "$_rel" ] || [ "$(stat -c %u "$_dir" 2>/dev/null)" != "$(id -u)" ]; then
      warn "embedded mode, but this container's cgroup was not delegated to uid $(id -u) — the Intune container will not boot. Start the container as root (no compose \`user:\`, no pod runAsUser): its entrypoint delegates the cgroup and then drops to $RUNTIME_USER itself"
    fi
  fi
}

# ---- stage 2: as the runtime user ------------------------------------------------------------

# Run one of the backend binary's hidden subcommands the way the backend runs every helper
# (`spawn_helper` / `helper_env` in src/intune_embedded.rs): in a SESSION of its own, so a signal
# meant for this shell's process group never reaches it, and in an environment rebuilt from
# nothing — the crate's supervisor inherits it, and the Intune container's PID 1 inherits the
# supervisor's for its whole life, so no token, no bus address and no display may ride along.
# INTUNE_CONTAINER_CGROUP=own is the crate's setting for an application that knows it runs inside
# a container: the scope is a child of this one, never one asked of a manager it inherited.
#
# It EXECS, so it is only ever called in a subshell, with the instance lock's descriptor closed:
# `( exec_helper SUB ) 9>&- &` (see `take_instance_lock`).
exec_helper() {
  _sub=$1
  set -- PATH="${PATH:-$DEFAULT_PATH}" TEAMS_LITE_INTUNE_MODE=embedded INTUNE_CONTAINER_CGROUP=own
  for _name in HOME USER LOGNAME XDG_DATA_HOME LANG TZ RUST_LOG TEAMS_LITE_INTUNE_IMPORT; do
    eval "_value=\${$_name:-}"
    if [ -n "$_value" ]; then
      set -- "$@" "$_name=$_value"
    fi
  done
  exec setsid -w env -i "$@" "$SERVER" "$_sub"
}

# Wait for process $1 and return its status. A trapped signal interrupts `wait` — it returns
# above 128 with the process still there — so this waits again until the process is really gone,
# and the status returned is the process's own rather than the signal's.
wait_for() {
  _rc=0
  wait "$1" || _rc=$?
  while kill -0 "$1" 2>/dev/null; do
    _rc=0
    wait "$1" || _rc=$?
  done
  return "$_rc"
}

# The trap. The FIRST signal stops the launcher (which takes its backend down with it —
# `killChildOnExit` in launcher/src/backend.ts); every later one is SAID and changes nothing, so a
# second Ctrl+C or a second TERM can never cut the Intune container's poweroff short — a stop
# killed halfway leaves the keyring and the broker's state half-written in a volume that holds the
# device's enrollment.
# shellcheck disable=SC2317 # reached through the trap
on_signal() {
  if [ -n "$STOPPING" ]; then
    say "$1 while stopping — ignored; the Intune container's graceful stop is not cut short"
    return 0
  fi
  STOPPING=$1
  say "$1 — stopping teams-lite"
  if [ -n "$LAUNCHER_PID" ]; then
    kill -TERM "$LAUNCHER_PID" 2>/dev/null || :
  fi
}

# The Intune container's graceful poweroff, after the launcher has gone: the stop helper waits up
# to 25 s for a setup or a start that holds the lifecycle lock, then gives the inner systemd up to
# 20 s (src/intune_embedded.rs) — which is why compose.yaml grants 60 s and the chart 90.
# Embedded mode only: in host mode the Intune container is the USER'S, and this image never stops
# it. Not read-only either: a read-only run never booted one, so the only container a stop could
# reach from it is somebody else's on a shared volume. And only from the copy of this script that
# holds the instance lock: the stop is what made a second copy dangerous, so no path reaches it
# without the proof that this copy is the container's only one.
stop_intune_container() {
  if [ "$INTUNE_MODE" != embedded ] || is_read_only; then
    return 0
  fi
  if [ -z "$INSTANCE_LOCKED" ]; then
    warn "not stopping the Intune container: this copy of $ME does not hold $INSTANCE_LOCK, so the container may be another copy's"
    return 0
  fi
  if [ ! -x "$SERVER" ]; then
    warn "$SERVER is missing — the Intune container is not stopped gracefully"
    return 0
  fi
  say "stopping the Intune container gracefully"
  (exec_helper "$STOP_SUBCOMMAND") 9>&- &
  _stop_pid=$!
  _stop_rc=0
  wait_for "$_stop_pid" || _stop_rc=$?
  if [ "$_stop_rc" != 0 ]; then
    warn "the Intune container's stop exited $_stop_rc (its reason is above) — it ends with this container"
  fi
}

user_stage() {
  if [ "$(id -u)" = 0 ]; then
    say "refusing to run teams-lite as root: the backend signs in as the runtime user, and the Intune container is that user's (did $STAGE_ENV leak into the environment?)"
    exit 2
  fi
  # Usually the lock the root stage took, inherited on descriptor 9 across the setpriv exec and
  # re-taken on that same description; taken afresh for a start that never was root.
  take_instance_lock

  # KUBERNETES WRITES ITS OWN VALUE INTO THIS VERY NAME. A pod is handed `<SERVICE>_PORT=tcp://
  # <ip>:<port>` for every Service in its namespace, and a Service called `teams-lite` makes that
  # TEAMS_LITE_PORT — which both the launcher and the backend read as the backend's port, and
  # which the line below would keep because it is set. The chart turns the links off
  # (`enableServiceLinks: false`, packaging/helm); a manifest written by hand may not, so a value
  # that is not a port number is dropped here, and the drop is said.
  case "${TEAMS_LITE_PORT:-}" in
    *[!0-9]*)
      echo "teams-lite-container: ignoring TEAMS_LITE_PORT=${TEAMS_LITE_PORT} — not a port number (a Kubernetes service link? set enableServiceLinks: false)" >&2
      unset TEAMS_LITE_PORT
      ;;
  esac

  if [ "${TEAMS_LITE_READ_ONLY:-}" != 1 ]; then
    export TEAMS_LITE_PORT="${TEAMS_LITE_PORT:-19423}"
  fi
  export TEAMS_WEB_PORT="${TEAMS_WEB_PORT:-19443}"
  # The backend's own lines go to `docker logs`, beside the launcher's, rather than to a file in
  # the container's /tmp that nobody reads (`backendLogsInherited` in launcher/src/backend.ts).
  export TEAMS_LITE_BACKEND_LOG="${TEAMS_LITE_BACKEND_LOG:--}"

  # The launcher runs in the BACKGROUND so this shell is still here to stop the Intune container
  # after it, and the trap is armed before it starts so no signal can fall between the two. It is
  # started without the instance lock's descriptor: the lock is this script's, not its children's.
  STOPPING=
  LAUNCHER_PID=
  trap 'on_signal TERM' TERM
  trap 'on_signal INT' INT
  "$LAUNCHER" --no-open "$@" 9>&- &
  LAUNCHER_PID=$!
  if [ -n "$STOPPING" ]; then
    kill -TERM "$LAUNCHER_PID" 2>/dev/null || :
  fi
  _status=0
  wait_for "$LAUNCHER_PID" || _status=$?
  if [ -z "$STOPPING" ]; then
    say "the launcher exited ($_status) on its own"
    # Stopping now all the same: a signal from here on is one more ask to do what is under way.
    STOPPING='exit'
  fi
  stop_intune_container
  exit "$_status"
}

main() {
  case "${TEAMS_LITE_CONTAINER_STAGE:-}" in
    '') ;;
    user)
      unset TEAMS_LITE_CONTAINER_STAGE
      resolve_mode
      user_stage "$@"
      ;;
    *)
      say "$STAGE_ENV=${TEAMS_LITE_CONTAINER_STAGE} is this script's own marker, not a setting"
      exit 2
      ;;
  esac
  supervise_as_pid1 "$@"
  # First, before the mode is even read: a second copy in a running container must not reach a
  # single line that acts (see `take_instance_lock`).
  take_instance_lock
  resolve_mode
  if [ "$(id -u)" = 0 ]; then
    root_stage
    drop_to_runtime_user "$@"
  fi
  not_root_stage
  user_stage "$@"
}

if [ "${TEAMS_LITE_CONTAINER_LIBRARY:-}" != 1 ]; then
  main "$@"
fi

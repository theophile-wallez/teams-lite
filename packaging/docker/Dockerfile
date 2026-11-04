# syntax=docker/dockerfile:1
#
# teams-lite as a container image — PACKAGING, and in its default mode a self-contained one.
#
#     docker compose -f packaging/docker/compose.yaml build
#     docker compose -f packaging/docker/compose.yaml up -d      # the user's own start
#
# It builds the single `teams` binary CI publishes (launcher/build.ts embeds the release
# backend and the built web app in it) from THIS checkout, and runs it with no browser to
# open. See AGENTS.md § Running teams-lite in a container image for the whole argument. The
# image runs in one of two modes, DECLARED (TEAMS_LITE_INTUNE_MODE, never detected), and the
# facts each rests on are short:
#
# EMBEDDED — the default, and what `ENV` below declares. The image boots its OWN Intune
# container, inside itself, through the intune-container crate the backend links: the rootless
# runtime unshares a user namespace and boots the systemd of the Intune container's image
# (ghcr.io/magicabdel/intune-container:latest, pulled on the first start) as its PID 1,
# with no systemd on the outside. So it carries what that needs and nothing the host provides:
#
#   • newuidmap and newgidmap as FILE CAPABILITIES. The inner container maps 65 536 ids (the
#     range /etc/subuid and /etc/subgid give the runtime user below), and inside a Docker
#     container the SETUID-root form of those two is refused — measured: EPERM, because a setuid
#     helper needs CAP_SYS_ADMIN in the bounding set, which Docker withholds. With the setuid bit
#     removed and `cap_setuid=ep` / `cap_setgid=ep` set instead, they work. no-new-privileges
#     defeats both forms, which is why neither compose.yaml nor the chart sets it.
#   • util-linux 2.39 or later, which is why this is TRIXIE rather than bookworm. The entrypoint
#     starts as root to hand the cgroup this container runs in to the runtime user (the crate
#     makes the Intune container's scope a CHILD of it), and where Docker mounts /sys/fs/cgroup
#     read-only it does so through a nested `unshare --map-users=0:0:1 --map-users=<uid>:<uid>:1`.
#     Measured on Docker 29.9: that line delegates on trixie's util-linux 2.41.5, and bookworm's
#     2.38.1 refuses it (`could not parse ID: '0:0:1'`; 2.38 maps root's extra ids only through
#     newuidmap and a subordinate range root does not have). The build asserts the version.
#   • the entrypoint starts as ROOT and drops to the runtime user with setpriv — hence no `USER`
#     line here at all — and tini is PID 1: in this mode the image has a pid namespace of its own.
#     A network namespace of its own too, and an IPC one: the inner container's display :99 is an
#     ABSTRACT socket, and the host's /dev/shm holds the user's own broker's lock semaphores. The
#     entrypoint refuses the host's IPC namespace on every kernel and the host's network namespace
#     on a kernel that fixes its number (both by the kernel's own number for its INITIAL ones,
#     which are the host's wherever the container shares the host's kernel), and a network
#     namespace where :99 is already bound — on an older kernel that last check is the only one
#     `--network host` meets, so host networking is unsupported in this mode, never merely refused.
#     Under a microVM runtime (Kata, Firecracker) the initial network namespace is the GUEST
#     kernel's, the sandbox's own: TEAMS_LITE_NETNS_IS_OWN=1 DECLARES that runtime (never
#     detected) and lets that one namespace through. No microVM runtime has run this image.
#   • a host kernel that permits unprivileged user namespaces. Ubuntu 23.10 and later ship
#     kernel.apparmor_restrict_unprivileged_userns=1, and the crate refuses to boot under it
#     whatever this container's AppArmor profile; the entrypoint says so, and the one remedy is
#     that sysctl at 0 on the host.
#
# MEASURED with this shape (Docker 29.9, runc, cgroup v2): the real Intune image's systemd booted
# inside a plain Docker container with `--security-opt seccomp=unconfined --security-opt
# systempaths=unconfined`, with the cgroup delegated by the nested unshare and file-capability
# newuidmap, and the broker came up `active`. And through THIS image's own `server` binary, by
# `teams-lite-intune-selftest` (below) on 2026-11-03: the setup (75 s, the 1.7 GB pull), the boot
# with no user manager, the keyring read unlocked over D-Bus by the image's own diagnostic, the
# broker's bus, and a graceful stop in 1 s. NOT measured: Kubernetes at all, a send-capable run
# (the user's own `up`), a token minted through an embedded broker, an enrollment, an import.
#
# HOST — the identity broker of the machine it runs on (compose.host-broker.yaml, the chart's
# `intuneContainer` and `sessionBus` modes), reached through the HOST's process table: on a
# containerized-Intune host its bus is /proc/<container leader>/root/run/user/0/bus, read live
# from the intune-container runtime state (src/intune.rs). That needs the host pid namespace, a
# read-only view of that state, and the process running AS THE HOST USER: /proc/<pid>/root is
# opened under the same-uid rule, and the container's dbus-daemon authenticates the uid the
# kernel reports. Measured from a stock image with `--pid=host --user 1000:1000`: the socket
# opened and `AUTH EXTERNAL` as uid 0 answered OK. Run as root it would be neither — so host mode
# starts as that user (compose's `user:`, the chart's runAsUser), and the entrypoint's root stage
# never runs. tini is a subreaper there (`-s`), because PID 1 is the host's init.
#
# Both modes:
#
#   • UID/GID are BUILD arguments, and in BOTH modes they decide who owns state. Host mode needs
#     them to BE the host user's (the broker answers that uid). Embedded mode needs them STABLE:
#     the runtime uid is the Intune container's own root (the crate maps the inner root onto it),
#     so the rootfs it unpacks and the keyring holding the enrollment are written under that uid,
#     and an image rebuilt for another one finds the `intune` volume owned by the old uid — the
#     Intune container does not boot again until the uid is put back. And the entrypoint takes
#     over only a FRESH volume's root (root-owned and empty), never a directory something already
#     owns, so a host store bound in must already belong to this uid: build with
#     TEAMS_LITE_UID=$(id -u) TEAMS_LITE_GID=$(id -g) to bind one. The image CI publishes
#     (ghcr.io/theophile-wallez/teams-lite, .github/workflows/build.yml) is built for 1000:1000,
#     the first user of nearly every Linux desktop. Nothing else in it is anybody's: no
#     credential, no store, no enrollment, no machine.
#   • In host mode the repair is not this image's to make: it asks the host's systemd manager to
#     run THIS binary, and this binary's path exists only inside the image — so the image declares
#     itself (TEAMS_LITE_CONTAINER_IMAGE) and the backend offers no repair there, saying why. In
#     embedded mode the Intune container is this image's own, and the backend repairs it itself.
#   • The in-app update is not this image's either: an image is replaced by building a new one,
#     so the binary is installed where the runtime user cannot write and `update::self_install`
#     answers no on its own — the button stays the link it is for every install that is updated
#     where it came from.
#
# Both the build stage and the runtime are Debian, deliberately the SAME release: the Rust
# binary links the build stage's glibc, and a runtime older than that refuses it at exec.

ARG DEBIAN_RELEASE=trixie
ARG RUST_VERSION=1
ARG BUN_VERSION=1

FROM oven/bun:${BUN_VERSION}-debian AS bun

# --- build: the same three steps CI runs (.github/workflows/build.yml) ---------------------
FROM rust:${RUST_VERSION}-${DEBIAN_RELEASE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
# The whole checkout, minus what .dockerignore names — which includes an Intune ENROLLMENT BACKUP
# left beside compose.yaml: it holds the device's registration keys and its keyring, and copied
# here it would be sent to the daemon and kept in this stage's layer in the build cache long
# after the file itself is deleted.
COPY . .

# Empty unless the caller passes the commit, which is what build.rs reads as "a build from
# source" — the update check then skips itself, exactly as it does for a `cargo build` here.
# Pass it (`TEAMS_BUILD_REV=$(git rev-parse HEAD)`) and the app says when `latest` moved on.
ARG TEAMS_BUILD_REV=
ENV TEAMS_BUILD_REV=${TEAMS_BUILD_REV}

# The backend, and the READ-ONLY diagnostic that answers where the broker is from inside the
# image (`examples/intune_status.rs`). `target` is a cache mount, so the binaries are copied
# out of it before the step ends.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin server --example intune_status \
 && mkdir -p /out \
 && cp target/release/server /out/server \
 && cp target/release/examples/intune_status /out/teams-lite-intune-status

RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd launcher && bun install --frozen-lockfile \
 && cd ../web && bun install --frozen-lockfile

# launcher/build.ts reads the backend from target/release/server and builds the web app
# itself; it writes its output inside the repo on purpose (a cross-filesystem outfile is
# the zero-filled-binary bug its header records).
RUN mkdir -p target/release \
 && cp /out/server target/release/server \
 && cd launcher && bun run build.ts \
 && cp dist/teams /out/teams

# --- runtime ---------------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim

# tini, so the backend, every agent CLI it spawns and the Intune container's own supervisor are
# reaped, and a stop reaches the entrypoint — which stops the launcher and then powers the Intune
# container off gracefully (packaging/docker/entrypoint.sh). tzdata, because "the machine's own
# zone" is what an unset presence zone means (src/teams_presence.rs) and a TZ name needs the
# database; compose mounts /etc/localtime for the same reason. uidmap and libcap2-bin for the
# inner container's id range (above): the two map helpers, and `setcap` / `getcap` to give them
# their capabilities and for the entrypoint to check they still carry them. util-linux, which the
# slim image already holds, supplies setpriv, unshare, setsid and flock — the last for the lock
# that keeps the entrypoint to one copy per container.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates tini tzdata uidmap libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap \
 && setcap cap_setuid=ep /usr/bin/newuidmap \
 && setcap cap_setgid=ep /usr/bin/newgidmap \
 && for tool in setpriv unshare setsid flock getent getcap; do \
      command -v "$tool" >/dev/null || { echo "the runtime needs $tool" >&2; exit 1; }; \
    done \
 && set -- $(unshare --version | sed -n 's/.*util-linux \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p') \
 && if [ "${1:-0}" -lt 2 ] || { [ "$1" -eq 2 ] && [ "${2:-0}" -lt 39 ]; }; then \
      echo "the entrypoint's cgroup delegation needs util-linux 2.39 or later (unshare --map-users with colon ranges); this release has $(unshare --version)" >&2; \
      exit 1; \
    fi

ARG UID=1000
ARG GID=1000
# The first of the 65 536 subordinate ids the Intune container maps its own users onto. The range
# must leave the runtime user's own uid and gid OUTSIDE it — an id mapped twice is a map the
# kernel refuses — which the step below asserts rather than leaves to the first boot.
ARG SUBID_START=100000
# `-o`: in host mode a host uid or gid that collides with one Debian already uses is still the one
# the broker needs. The data directories are created here so a Docker named volume mounted on one
# starts out owned by this user rather than by root; a volume that does not (a fresh Kubernetes
# PVC, root-owned and empty) has its ROOT given to this user by the entrypoint, and nothing below
# it — a directory owned by anybody else is left alone, because it may be the host's. The
# subordinate ranges are WRITTEN rather than appended to: `useradd` adds one of its own when the
# files exist, and two lines for one user is two answers to which ids the inner container may use.
RUN for id in "${UID}" "${GID}"; do \
      if [ "$id" -eq 0 ] || { [ "$id" -ge "${SUBID_START}" ] && [ "$id" -lt $((SUBID_START + 65536)) ]; }; then \
        echo "UID/GID $id is root or inside the subordinate range ${SUBID_START}+65536; pick another SUBID_START" >&2; \
        exit 1; \
      fi; \
    done \
 && groupadd -o -g "${GID}" teams \
 && useradd -o -u "${UID}" -g "${GID}" -m -d /home/teams -s /usr/sbin/nologin teams \
 && printf 'teams:%s:65536\n' "${SUBID_START}" > /etc/subuid \
 && printf 'teams:%s:65536\n' "${SUBID_START}" > /etc/subgid \
 && mkdir -p /home/teams/.local/share/teams-lite /home/teams/.local/share/intune-container /home/teams/.cache \
 && chown -R "${UID}:${GID}" /home/teams

COPY --from=build /out/teams /usr/local/bin/teams
# The backend binary on its own, beside the copy the launcher embeds and extracts into ~/.cache:
# the entrypoint runs its `__teams-lite-intune-stop` at shutdown and the self-test its
# `__teams-lite-intune-boot`, and neither may depend on the launcher having run first. One build
# stage writes both, so the two can never be different builds.
COPY --from=build /out/server /usr/local/lib/teams-lite/server
COPY --from=build /out/teams-lite-intune-status /usr/local/lib/teams-lite/intune-status
# The diagnostic's own wrapper, which drops a root caller (a plain `docker exec`) to the runtime
# user: an outer root is unmapped inside the Intune container, and its bus would refuse it.
COPY --chmod=0755 packaging/docker/teams-lite-intune-status /usr/local/bin/teams-lite-intune-status
COPY --chmod=0755 packaging/docker/entrypoint.sh /usr/local/bin/teams-lite-container
# Proves the embedded boot inside this very image, with no backend and no enrollment:
#   docker run --rm --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
#     --security-opt apparmor=unconfined --entrypoint teams-lite-intune-selftest teams-lite:local
COPY --chmod=0755 packaging/docker/teams-lite-intune-selftest /usr/local/bin/teams-lite-intune-selftest

LABEL org.opencontainers.image.title="teams-lite" \
      org.opencontainers.image.description="A Microsoft Teams client for Linux that boots its own Intune container, as a container image" \
      org.opencontainers.image.source="https://github.com/theophile-wallez/teams-lite"

# Declared, never detected — the shape TEAMS_LITE_LAUNCHER and TEAMS_LITE_RESTART_ON_EXIT
# already have. TEAMS_LITE_CONTAINER_IMAGE says this binary runs in the image (what it blocks is
# the HOST-mode repair, `intune::repair_blocker`); TEAMS_LITE_INTUNE_MODE says whose Intune
# container it deals with (src/intune_embedded.rs) — a host-broker run overrides it with `host`.
# HOME, USER and LOGNAME are the runtime user's, set here because the process starts as root and
# setpriv keeps the environment it is handed.
ENV TEAMS_LITE_CONTAINER_IMAGE=1 \
    TEAMS_LITE_INTUNE_MODE=embedded \
    HOME=/home/teams \
    USER=teams \
    LOGNAME=teams
WORKDIR /home/teams
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/teams-lite-container"]

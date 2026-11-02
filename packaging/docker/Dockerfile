# syntax=docker/dockerfile:1
#
# teams-lite as a container image — PACKAGING, never isolation.
#
#     docker compose -f packaging/docker/compose.yaml build
#     docker compose -f packaging/docker/compose.yaml up -d      # the user's own start
#
# It builds the single `teams` binary CI publishes (launcher/build.ts embeds the release
# backend and the built web app in it) from THIS checkout, and runs it with no browser to
# open. See AGENTS.md § Running teams-lite in a container image for the whole argument; the
# four facts it rests on are short:
#
#   • The identity broker is reached through the HOST's process table. On a containerized-
#     Intune host its bus is /proc/<container leader>/root/run/user/0/bus, and that path moves
#     on every Intune container boot — so the backend reads where it is NOW, from the
#     intune-container runtime state (src/intune.rs), on every connection. Inside an image
#     that needs the host pid namespace and a read-only view of that state, and the process
#     must run AS THE HOST USER: /proc/<pid>/root is opened under the same-uid rule, and the
#     container's dbus-daemon authenticates the uid the kernel reports. Measured from a stock
#     image with `--pid=host --user 1000:1000`: the socket opened and `AUTH EXTERNAL` as uid 0
#     answered OK. Run as root it would be neither.
#   • Hence UID/GID are BUILD arguments: the image is built for one host user. It is a local
#     build, never a published one — nothing in it is anybody else's to pull.
#   • The repair is not this image's to make. It asks the host's systemd manager to run THIS
#     binary, and this binary's path exists only inside the image — so the image declares
#     itself (TEAMS_LITE_CONTAINER_IMAGE) and the backend offers no repair, saying why.
#   • The in-app update is not either: an image is replaced by building a new one, so the
#     binary is installed where the runtime user cannot write and `update::self_install`
#     answers no on its own — the button stays the link it is for every install that is
#     updated where it came from.
#
# Both the build stage and the runtime are Debian, deliberately the SAME release: the Rust
# binary links the build stage's glibc, and a runtime older than that refuses it at exec.

ARG DEBIAN_RELEASE=bookworm
ARG RUST_VERSION=1
ARG BUN_VERSION=1

FROM oven/bun:${BUN_VERSION}-debian AS bun

# --- build: the same three steps CI runs (.github/workflows/build.yml) ---------------------
FROM rust:${RUST_VERSION}-${DEBIAN_RELEASE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /src
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

# tini, so the backend and every agent CLI it spawns are reaped and a `docker stop` reaches the
# launcher, which takes its backend down with it (launcher/src/backend.ts). As a SUBREAPER
# (`-s`), because it is not PID 1: the compose file shares the host's pid namespace, where PID 1
# is the host's init — and tini said so on the first run, warning that no zombie would be
# re-parented to it. tzdata,
# because "the machine's own zone" is what an unset presence zone means (src/teams_presence.rs)
# and a TZ name needs the database; compose mounts /etc/localtime for the same reason.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates tini tzdata \
 && rm -rf /var/lib/apt/lists/*

ARG UID=1000
ARG GID=1000
# `-o`: a host uid or gid that collides with one Debian already uses is still the one the
# broker needs. The data directory is created here so a named volume mounted on it starts
# out owned by this user rather than by root.
RUN groupadd -o -g "${GID}" teams \
 && useradd -o -u "${UID}" -g "${GID}" -m -d /home/teams -s /usr/sbin/nologin teams \
 && mkdir -p /home/teams/.local/share/teams-lite /home/teams/.cache \
 && chown -R "${UID}:${GID}" /home/teams

COPY --from=build /out/teams /usr/local/bin/teams
COPY --from=build /out/teams-lite-intune-status /usr/local/bin/teams-lite-intune-status
COPY packaging/docker/entrypoint.sh /usr/local/bin/teams-lite-container

LABEL org.opencontainers.image.title="teams-lite" \
      org.opencontainers.image.description="A Microsoft Teams client for Linux, as a local container image" \
      org.opencontainers.image.source="https://github.com/magicabdel/teams-lite"

# Declared, never detected — the shape TEAMS_LITE_LAUNCHER and TEAMS_LITE_RESTART_ON_EXIT
# already have. What it decides is `intune::repair_available` (src/intune.rs).
ENV TEAMS_LITE_CONTAINER_IMAGE=1 \
    HOME=/home/teams
USER teams
WORKDIR /home/teams
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/teams-lite-container"]

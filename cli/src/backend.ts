// Manages the Rust backend as a child process (opencode model): the `teams`
// command owns the server lifecycle — spawn it, wait until it's listening, and
// kill it on exit. One command starts everything.

import { spawn, type Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/// Where a normal, send-capable backend listens.
const DEFAULT_PORT = 19420;
/// Where a READ-ONLY backend listens instead, so it never takes the port the
/// user's own backend wants.
const READ_ONLY_PORT = 19430;

const HOST = "127.0.0.1";

/// The port the backend will bind, resolved exactly as the backend itself resolves
/// it (`resolve_port` in src/bin/server.rs): an explicit `TEAMS_LITE_PORT` wins,
/// else read-only mode moves aside to 19430. Two processes read the same
/// environment, so a rule duplicated here is a rule that drifts — and a launcher
/// that waited on 19420 while the child bound 19430 would time out on every
/// read-only start.
export function backendPort(): number {
  const configured = Number(process.env.TEAMS_LITE_PORT);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return process.env.TEAMS_LITE_READ_ONLY === "1" ? READ_ONLY_PORT : DEFAULT_PORT;
}

/// The WebSocket URL of that backend.
export function backendUrl(): string {
  return `ws://${HOST}:${backendPort()}`;
}

/// Are we running as a `bun build --compile` standalone binary? In that mode the
/// backend is embedded inside this executable (see embedded-backend.ts) rather
/// than sitting next to a source tree. Bun.embeddedFiles is populated only in a
/// compiled binary; under `bun run` it is empty.
export function isCompiledBinary(): boolean {
  const embedded = (globalThis as unknown as { Bun?: { embeddedFiles?: unknown[] } }).Bun
    ?.embeddedFiles;
  return Array.isArray(embedded) && embedded.length > 0;
}

/// The repo root, for a source checkout: cli/src -> two levels up.
export function repoRoot(): string {
  return join(import.meta.dir, "..", "..");
}

/// Extract the embedded backend to a stable cache path and return it. We only
/// rewrite the file when it is missing or its size differs from the embedded
/// copy, so upgrades (a newer `teams` binary) transparently refresh it while
/// normal launches are a cheap stat().
async function extractEmbeddedBackend(): Promise<string> {
  const { default: bunfsPath } = await import("./embedded-backend");
  const bytes = new Uint8Array(await Bun.file(bunfsPath).arrayBuffer());

  const dir = join(homedir(), ".cache", "teams-lite");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "server");

  let upToDate = false;
  try {
    upToDate = statSync(dest).size === bytes.byteLength;
  } catch {
    upToDate = false;
  }
  if (!upToDate) {
    writeFileSync(dest, bytes);
  }
  chmodSync(dest, 0o755);
  return dest;
}

/// Locate the backend binary. Compiled binary → extract the embedded copy.
/// Dev (`bun run`) → prefer release, fall back to debug in the source tree.
async function backendBinary(): Promise<string> {
  if (isCompiledBinary()) {
    return extractEmbeddedBackend();
  }

  const root = repoRoot();
  const release = join(root, "target", "release", "server");
  const debug = join(root, "target", "debug", "server");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;
  throw new Error(
    "backend binary not found — build it with: cargo build --release --bin server",
  );
}

/// Is something already listening on the backend port? (lets us attach to an
/// already-running server instead of spawning a second one.)
async function portOpen(): Promise<boolean> {
  try {
    const sock = await Bun.connect({
      hostname: HOST,
      port: backendPort(),
      socket: { data() {}, open(s) { s.end(); } },
    });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

export type BackendHandle = { stop: () => void };

/// Ensure the backend is running. If a server is already up, attach to it and
/// don't manage its lifecycle. Otherwise spawn one and return a stop() handle.
///
/// `keepAlive` (dev use) starts the spawned backend with `TEAMS_NO_IDLE_EXIT`, so
/// it survives frontend disconnects and only stops when we kill it — handy when
/// the browser tab is closed/reloaded during development. It has no effect when
/// we merely attach to a backend someone else already started.
export async function ensureBackend(opts: { keepAlive?: boolean } = {}): Promise<BackendHandle> {
  if (await portOpen()) {
    return { stop: () => {} }; // someone else owns it
  }

  const bin = await backendBinary();
  const proc: Subprocess = spawn([bin], {
    stdout: Bun.file("/tmp/teams-lite-server.log"),
    stderr: Bun.file("/tmp/teams-lite-server.log"),
    stdin: "ignore",
    ...(opts.keepAlive ? { env: { ...process.env, TEAMS_NO_IDLE_EXIT: "1" } } : {}),
  });

  // wait for it to bind (auth broker handshake can take a few seconds)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `backend exited (code ${proc.exitCode}). See /tmp/teams-lite-server.log`,
      );
    }
    if (await portOpen()) {
      const stop = () => {
        try {
          proc.kill(9);
        } catch {}
      };
      killChildOnExit(stop);
      return { stop };
    }
    await Bun.sleep(300);
  }
  try { proc.kill(9); } catch {}
  throw new Error("backend still not listening after 60s. See /tmp/teams-lite-server.log");
}

/// Kill the backend whenever this process goes away, for any reason.
///
/// Two hooks are needed, not one. "exit" covers a normal return and an uncaught
/// error, but a signal terminates the process WITHOUT running exit handlers — and
/// Ctrl+C on the launcher is the ordinary way to stop it. Without the signal
/// handlers a `--dev` backend, which we start with idle-exit disabled, would
/// survive as an orphan holding the port and the user's account, and only a manual
/// kill would clear it.
function killChildOnExit(stop: () => void): void {
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
}

// Manages the Rust backend as a child process (opencode model): the UI owns the
// server lifecycle — spawn it, wait until it's listening, and kill it on exit.
// One command (`teams`) starts everything.

import { spawn, type Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = 8420;
const HOST = "127.0.0.1";

/// Are we running as a `bun build --compile` standalone binary? In that mode the
/// backend is embedded inside this executable (see embedded-server.ts) rather
/// than sitting next to a source tree. Bun.embeddedFiles is populated only in a
/// compiled binary; under `bun run` it is empty.
function isCompiledBinary(): boolean {
  const embedded = (globalThis as unknown as { Bun?: { embeddedFiles?: unknown[] } }).Bun
    ?.embeddedFiles;
  return Array.isArray(embedded) && embedded.length > 0;
}

/// Extract the embedded backend to a stable cache path and return it. We only
/// rewrite the file when it is missing or its size differs from the embedded
/// copy, so upgrades (a newer `teams` binary) transparently refresh it while
/// normal launches are a cheap stat().
async function extractEmbeddedServer(): Promise<string> {
  const { default: bunfsPath } = await import("./embedded-server");
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
async function serverBinary(): Promise<string> {
  if (isCompiledBinary()) {
    return extractEmbeddedServer();
  }

  // ui/src -> project root is two levels up
  const root = join(import.meta.dir, "..", "..");
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
      port: PORT,
      socket: { data() {}, open(s) { s.end(); } },
    });
    sock.end();
    return true;
  } catch {
    return false;
  }
}

export type ServerHandle = { stop: () => void };

/// Ensure the backend is running. If a server is already up, attach to it and
/// don't manage its lifecycle. Otherwise spawn one and return a stop() handle.
///
/// `keepAlive` (dev use) starts the spawned backend with `TEAMS_NO_IDLE_EXIT`, so
/// it survives frontend disconnects and only stops when we kill it — handy when
/// the browser tab is closed/reloaded during development. It has no effect when
/// we merely attach to a backend someone else already started.
export async function ensureServer(opts: { keepAlive?: boolean } = {}): Promise<ServerHandle> {
  if (await portOpen()) {
    return { stop: () => {} }; // someone else owns it
  }

  const bin = await serverBinary();
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
      // Kill the backend whenever this process exits, for any reason. We only
      // hook "exit" — a synchronous, last-gasp callback that Bun/Node fires no
      // matter how we got here (normal return, uncaught error, or a signal that
      // OpenTUI's own handler turned into an exit). We deliberately do NOT add
      // our own SIGINT/SIGTERM handlers that call process.exit(): OpenTUI's
      // renderer already registers signal handlers that run destroy() to leave
      // raw mode, exit the alternate screen, and — crucially — disable mouse
      // tracking. Racing it with an eager process.exit(0) kills the process
      // before those terminal-restore escape sequences are flushed, which is
      // exactly what leaves the terminal spewing "35;56;51M"-style SGR mouse
      // reports after Ctrl+C. Letting "exit" do the child cleanup keeps our
      // teardown ordered strictly after the terminal has been restored.
      process.on("exit", stop);
      return { stop };
    }
    await Bun.sleep(300);
  }
  try { proc.kill(9); } catch {}
  throw new Error("backend still not listening after 60s. See /tmp/teams-lite-server.log");
}

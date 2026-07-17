// Manages the Rust backend as a child process (opencode model): the UI owns the
// server lifecycle — spawn it, wait until it's listening, and kill it on exit.
// One command (`teams`) starts everything.

import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = 8420;
const HOST = "127.0.0.1";

/// Locate the backend binary (prefer release, fall back to debug).
function serverBinary(): string {
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
export async function ensureServer(): Promise<ServerHandle> {
  if (await portOpen()) {
    return { stop: () => {} }; // someone else owns it
  }

  const bin = serverBinary();
  const proc: Subprocess = spawn([bin], {
    stdout: Bun.file("/tmp/teams-lite-server.log"),
    stderr: Bun.file("/tmp/teams-lite-server.log"),
    stdin: "ignore",
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
      // also kill the child if the UI process dies unexpectedly
      process.on("exit", stop);
      process.on("SIGINT", () => { stop(); process.exit(0); });
      process.on("SIGTERM", () => { stop(); process.exit(0); });
      return { stop };
    }
    await Bun.sleep(300);
  }
  try { proc.kill(9); } catch {}
  throw new Error("backend still not listening after 60s. See /tmp/teams-lite-server.log");
}

// teams-lite — `teams --web` launcher.
//
// The web analog of the terminal UI: instead of rendering OpenTUI, it brings up
// (or attaches to) the Rust backend, starts the SSR web server (web/server.ts —
// a self-contained Bun fetch server), holds a keepalive connection so the
// backend never self-expires while the browser tab is closed, and opens the
// browser. One command (`teams --web`) starts everything, mirroring the TUI's
// single-command model.

import { spawn } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureServer } from "./server";

const BACKEND_URL = "ws://127.0.0.1:8420";

export type WebOptions = {
  port: number;
  host: string;
  open: boolean;
};

const DEFAULTS: WebOptions = { port: 4321, host: "127.0.0.1", open: true };

/** Parse `teams --web [--port N] [--host H] [--no-open]` from argv. */
export function parseWebArgs(argv: string[]): { web: boolean; options: WebOptions } {
  const web = argv.includes("--web");
  const options: WebOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-open") options.open = false;
    else if (arg === "--open") options.open = true;
    else if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]) || DEFAULTS.port;
    else if (arg?.startsWith("--port=")) options.port = Number(arg.slice(7)) || DEFAULTS.port;
    else if (arg === "--host" || arg === "-H") options.host = argv[++i] ?? DEFAULTS.host;
    else if (arg?.startsWith("--host=")) options.host = arg.slice(7) || DEFAULTS.host;
  }
  // Honor env overrides so scripting stays flexible.
  if (process.env.TEAMS_WEB_PORT) options.port = Number(process.env.TEAMS_WEB_PORT) || options.port;
  if (process.env.TEAMS_WEB_HOST) options.host = process.env.TEAMS_WEB_HOST;
  return { web, options };
}

/// Are we a `bun build --compile` standalone binary? (mirrors server.ts)
function isCompiledBinary(): boolean {
  const embedded = (globalThis as unknown as { Bun?: { embeddedFiles?: unknown[] } }).Bun
    ?.embeddedFiles;
  return Array.isArray(embedded) && embedded.length > 0;
}

/// Locate a directory containing the web server entry + built assets. In dev we
/// use the repo's web/ (building it first if needed). In the compiled binary the
/// web bundle is embedded; we extract it to a cache dir (see extractEmbeddedWeb).
async function resolveWebRoot(): Promise<{ dir: string; entry: string }> {
  if (isCompiledBinary()) {
    const { extractEmbeddedWeb } = await import("./web-embed");
    const dir = await extractEmbeddedWeb();
    return { dir, entry: join(dir, "server.js") };
  }

  // Dev: ui/src -> repo root is two levels up; the web app lives at <root>/web.
  const root = join(import.meta.dir, "..", "..");
  const webDir = join(root, "web");
  const built = join(webDir, "dist", "server", "server.js");
  if (!existsSync(built)) {
    console.error("[web] building the web app (first run)…");
    const proc = spawn(["bun", "run", "build"], {
      cwd: webDir,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`web build failed (exit ${code}) in ${webDir}`);
  }
  return { dir: webDir, entry: join(webDir, "server.ts") };
}

/// Hold a single WebSocket connection to the backend for the launcher's whole
/// lifetime, reconnecting on drop. This guarantees the backend always has >=1
/// client while `teams --web` runs, so it never self-expires between browser
/// reloads or while no tab is open. Cleaned up implicitly on process exit.
function startKeepalive(): void {
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    try {
      const ws = new WebSocket(BACKEND_URL);
      ws.onclose = () => {
        if (!stopped) setTimeout(connect, 1000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    } catch {
      if (!stopped) setTimeout(connect, 1000);
    }
  };
  connect();
  process.on("exit", () => {
    stopped = true;
  });
}

/// Best-effort open the default browser at the given URL (Linux: xdg-open).
function openBrowser(url: string): void {
  try {
    spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    // Non-fatal: the URL is printed to the console regardless.
  }
}

/** Run the full `teams --web` experience. Never returns (keeps serving). */
export async function runWeb(options: WebOptions): Promise<void> {
  console.error("teams-lite — starting web UI…");

  // 1. Bring up (or attach to) the Rust backend, and keep it alive.
  await ensureServer();
  startKeepalive();

  // 2. Locate/build the web app and start its SSR server in-process. The server
  //    module reads PORT/HOST from the environment and self-starts Bun.serve.
  const { entry } = await resolveWebRoot();
  process.env.PORT = String(options.port);
  process.env.HOST = options.host;
  // Dynamic import with a runtime-computed path so the compiler never tries to
  // bundle the separate web app into the `teams` binary.
  await import(/* @vite-ignore */ entry);

  const url = `http://${options.host}:${options.port}`;
  console.error(`\n  teams-lite web UI ready at ${url}\n`);

  // 3. Open the browser (unless suppressed).
  if (options.open) openBrowser(url);
}

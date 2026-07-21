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
  /// Dev mode (`--web-dev`): serve the web app through Vite's dev server so
  /// source edits hot-reload in the browser, instead of the built SSR bundle.
  dev: boolean;
};

const DEFAULTS: WebOptions = { port: 4321, host: "127.0.0.1", open: true, dev: false };

/**
 * Parse `teams --web|--web-dev [--port N] [--host H] [--no-open]` from argv.
 *
 * `--web-dev` is the developer analog of `--web`: it wires up the backend,
 * keepalive and browser exactly the same way, but serves the app through Vite
 * (HMR) so changes re-render live. Both flags enter the web path.
 */
export function parseWebArgs(argv: string[]): { web: boolean; options: WebOptions } {
  const dev = argv.includes("--web-dev");
  const web = dev || argv.includes("--web");
  const options: WebOptions = { ...DEFAULTS, dev };
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

/// Dev mode: serve the web app through Vite's dev server (`bun run dev`) against
/// the repo's web/ sources, so edits hot-reload in the browser. This mirrors the
/// production path (backend + keepalive + browser already handled by the caller)
/// but swaps the built SSR bundle for a live-reloading Vite process. Only works
/// from a source checkout: a compiled `teams` binary embeds the built bundle, not
/// the sources Vite needs. Runs until the Vite process exits, then exits with it.
async function runViteDev(options: WebOptions): Promise<never> {
  if (isCompiledBinary()) {
    throw new Error(
      "teams --web-dev needs the web/ sources and only works from a source " +
        "checkout (bun run). Use `teams --web` with the compiled binary.",
    );
  }

  // Dev: ui/src -> repo root is two levels up; the web app lives at <root>/web.
  const root = join(import.meta.dir, "..", "..");
  const webDir = join(root, "web");

  // Vite reads PORT/HOST from the environment (see web/vite.config.ts). `bun run
  // dev` also regenerates the theme first, matching a hand-run dev session.
  const proc = spawn(["bun", "run", "dev"], {
    cwd: webDir,
    env: { ...process.env, PORT: String(options.port), HOST: options.host },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const url = `http://${options.host}:${options.port}`;
  console.error(`\n  teams-lite web UI (dev, hot reload) ready at ${url}\n`);
  if (options.open) openBrowser(url);

  const code = await proc.exited;
  process.exit(code ?? 0);
}

/** Run the full `teams --web` / `--web-dev` experience (keeps serving). */
export async function runWeb(options: WebOptions): Promise<void> {
  console.error(`teams-lite — starting web UI${options.dev ? " (dev, hot reload)" : ""}…`);

  // 1. Bring up (or attach to) the Rust backend, and keep it alive.
  await ensureServer();
  startKeepalive();

  // 2. Dev mode: hand off to Vite (HMR) instead of the built SSR server. Never
  //    returns — it runs until the Vite process exits.
  if (options.dev) await runViteDev(options);

  // 3. Locate/build the web app and start its SSR server in-process. The server
  //    module reads PORT/HOST from the environment and self-starts Bun.serve.
  const { entry } = await resolveWebRoot();
  process.env.PORT = String(options.port);
  process.env.HOST = options.host;
  // Dynamic import with a runtime-computed path so the compiler never tries to
  // bundle the separate web app into the `teams` binary.
  await import(/* @vite-ignore */ entry);

  const url = `http://${options.host}:${options.port}`;
  console.error(`\n  teams-lite web UI ready at ${url}\n`);

  // 4. Open the browser (unless suppressed).
  if (options.open) openBrowser(url);
}

// teams-lite — what `teams` does.
//
// It brings up (or attaches to) the Rust backend, starts the web app's SSR server
// (web/server.ts — a self-contained Bun fetch server), holds a keepalive connection
// so the backend never self-expires while the browser tab is closed, and opens the
// browser. One command starts everything.

import { spawn } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  backendUrl,
  ensureBackend,
  isCompiledBinary,
  repoRoot,
  WRITE_TOKEN_ENV,
} from "./backend";
import { handleBackendEvent, spawnDetached } from "./update";

export type LaunchOptions = {
  port: number;
  host: string;
  open: boolean;
  /// Dev mode (`--dev`): serve the web app through Vite's dev server so source
  /// edits hot-reload in the browser, instead of the built SSR bundle.
  dev: boolean;
  /// `--help`: print the usage and run nothing.
  help: boolean;
};

const DEFAULTS: LaunchOptions = {
  port: 19440,
  host: "127.0.0.1",
  open: true,
  dev: false,
  help: false,
};

export const USAGE = `teams-lite — a Microsoft Teams client for Linux.

  teams [options]        start the backend, serve the web app, open the browser

Options:
  -p, --port <n>   port to serve the web app on (default ${DEFAULTS.port})
  -H, --host <h>   host to bind (default ${DEFAULTS.host})
      --no-open    don't open the browser
      --dev        serve through Vite instead, so edits hot-reload (source checkout only)
  -h, --help       print this message

Environment:
  TEAMS_WEB_PORT / TEAMS_WEB_HOST   same as --port / --host
  TEAMS_LITE_PORT                   the backend's port (default 19420, 19430 read-only)
`;

/**
 * Parse `teams [--port N] [--host H] [--no-open] [--dev]` from argv.
 *
 * `--web` and `--web-dev` stay accepted as aliases: the web app used to be the
 * second face of a terminal UI, so both spellings are in people's shells and in
 * their scripts. The web app is the only face now, which is what makes `--web` a
 * no-op rather than a removal.
 */
export function parseArgs(argv: string[]): LaunchOptions {
  const options: LaunchOptions = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dev" || arg === "--web-dev") options.dev = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--open") options.open = true;
    else if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]) || DEFAULTS.port;
    else if (arg?.startsWith("--port=")) options.port = Number(arg.slice(7)) || DEFAULTS.port;
    else if (arg === "--host" || arg === "-H") options.host = argv[++i] ?? DEFAULTS.host;
    else if (arg?.startsWith("--host=")) options.host = arg.slice(7) || DEFAULTS.host;
  }
  // Honor env overrides so scripting stays flexible.
  if (process.env.TEAMS_WEB_PORT) options.port = Number(process.env.TEAMS_WEB_PORT) || options.port;
  if (process.env.TEAMS_WEB_HOST) options.host = process.env.TEAMS_WEB_HOST;
  return options;
}

/// Locate a directory containing the web server entry + built assets. In dev we
/// use the repo's web/ (building it first if needed). In the compiled binary the
/// web bundle is embedded; we extract it to a cache dir (see extractEmbeddedWeb).
async function resolveWebRoot(): Promise<{ dir: string; entry: string }> {
  if (isCompiledBinary()) {
    const { extractEmbeddedWeb } = await import("./web-bundle");
    const dir = await extractEmbeddedWeb();
    // The extracted file is `server.ts`; Bun applies the TypeScript rule that resolves
    // a `.js` specifier to the `.ts` beside it (verified), so both spellings load it.
    return { dir, entry: join(dir, "server.ts") };
  }

  const webDir = join(repoRoot(), "web");
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
/// client while `teams` runs, so it never self-expires between browser reloads or
/// while no tab is open. Cleaned up implicitly on process exit.
///
/// It is also the one channel the backend can reach US on, which is what an in-app
/// update needs: only this process can restart the app onto a new build, so `onEvent`
/// carries the backend's `update_restart` to `handleBackendEvent` (see src/update.ts).
function startKeepalive(url: string, onEvent?: (raw: unknown) => void): void {
  let stopped = false;
  const connect = () => {
    if (stopped) return;
    try {
      const ws = new WebSocket(url);
      if (onEvent) ws.onmessage = (event: MessageEvent) => onEvent(event.data);
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
async function runViteDev(options: LaunchOptions): Promise<never> {
  if (isCompiledBinary()) {
    throw new Error(
      "teams --dev needs the web/ sources and only works from a source checkout " +
        "(bun run). Use plain `teams` with the compiled binary.",
    );
  }

  const webDir = join(repoRoot(), "web");

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
  console.error(`\n  teams-lite (dev, hot reload) ready at ${url}\n`);
  if (options.open) openBrowser(url);

  const code = await proc.exited;
  process.exit(code ?? 0);
}

/** Run the whole thing (keeps serving until the process is stopped). */
export async function launch(options: LaunchOptions): Promise<void> {
  console.error(`teams-lite — starting${options.dev ? " (dev, hot reload)" : ""}…`);

  // 1. Bring up (or attach to) the Rust backend, and keep it alive. In dev,
  //    spawn it with idle-exit disabled so closing/reloading the browser doesn't
  //    take the backend down between hot reloads.
  const backend = await ensureBackend({ keepAlive: options.dev });
  // Hand our own frontend the token we pinned for that backend. It has to be in the
  // environment before anything serves the write-token route (web/write-token.ts reads
  // the environment first, then the file), and it is what lets this instance run beside
  // the always-on service: neither backend publishes over the other's token. Null means
  // we attached to a backend that published its own, so the file is the right source.
  if (backend.writeToken) process.env[WRITE_TOKEN_ENV] = backend.writeToken;

  // 2. Dev mode: hand off to Vite (HMR) instead of the built SSR server. Never
  //    returns — it runs until the Vite process exits.
  if (options.dev) {
    startKeepalive(backendUrl());
    await runViteDev(options);
  }

  // 3. Locate/build the web app and start its SSR server in-process. The server
  //    module reads PORT/HOST from the environment and self-starts Bun.serve.
  const { entry } = await resolveWebRoot();
  process.env.PORT = String(options.port);
  process.env.HOST = options.host;
  // Name the backend the page's socket is relayed to. web/server.ts defaults to
  // 19420, so without this a `TEAMS_LITE_PORT` backend would be managed here and
  // ignored there — the page would load and never reach a backend.
  process.env.TEAMS_LITE_WS_URL ??= backendUrl();
  // Dynamic import with a runtime-computed path so the compiler never tries to
  // bundle the separate web app into the `teams` binary.
  //
  // The module exports the listener it started, which an in-app update needs: the new
  // build cannot bind this port while ours still holds it (see src/update.ts).
  const web = (await import(/* @vite-ignore */ entry)) as {
    server?: { stop: (closeActiveConnections?: boolean) => void };
  };

  // 3b. Now that both halves are ours to stop, listen for the backend asking us to
  //     restart onto a build it just installed.
  startKeepalive(backendUrl(), (raw) =>
    handleBackendEvent(raw, {
      stopWeb: () => web.server?.stop(true),
      stopBackend: async () => {
        backend.stop();
        await backend.waitForExit();
      },
      execPath: process.execPath,
      args: process.argv.slice(2),
      start: spawnDetached,
      exit: () => process.exit(0),
      log: (message) => console.error(message),
    }),
  );

  const url = `http://${options.host}:${options.port}`;
  console.error(`\n  teams-lite ready at ${url}\n`);

  // 4. Open the browser (unless suppressed).
  if (options.open) openBrowser(url);
}

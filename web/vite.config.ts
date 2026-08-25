// Vite config for the teams-lite web UI (TanStack Start, SSR).
//
// Plugin order matters: tsconfig paths -> tailwind -> tanstackStart -> react
// (react's plugin MUST come after Start's, per the TanStack Start docs).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { WRITE_TOKEN_ROUTE, writeTokenResponse } from "./write-token";
import { CHESS_SOUND_ROUTE, chessSoundFileResponse } from "./chess-sound-file";
import { ENGINE_ROUTE, engineFileResponse } from "./engine-file";
import { BUILD_INFO_FILE, type BuildInfo } from "./build-info";
import { BACKEND_WS_ROUTE } from "./src/lib/backend-route";

// The dev server port for `vite dev`. The production server reads PORT at
// runtime (see server.ts), so this only affects local dev.
//
// Deliberately NOT 19440, the production port: that one belongs to the always-on
// service (packaging/systemd/teams-lite-web.service), which holds it for weeks at a
// time. A dev server defaulting there would fail to bind whenever the service runs —
// and, worse, would win the port on the boot where it started first, quietly putting
// a hot-reloading dev build behind the tailnet HTTPS address the phone bookmarks.
const DEV_PORT = Number(process.env.PORT ?? 19441);
// The dev server host. `teams --dev` sets HOST to bind the same interface as the
// production launcher; unset lets Vite pick its default (localhost).
const DEV_HOST = process.env.HOST || undefined;

/**
 * Serves the backend's write token in dev, the way `server.ts` does in production
 * — so `vite dev` against a real backend can still send, and so the endpoint's
 * behavior is identical in both topologies (see write-token.ts).
 */
function writeTokenPlugin(): Plugin {
  return {
    name: "teams-lite-write-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(WRITE_TOKEN_ROUTE, async (_req, res) => {
        const response = writeTokenResponse();
        res.statusCode = response.status;
        res.setHeader("content-type", response.headers.get("content-type") ?? "text/plain");
        res.end(await response.text());
      });
    },
  };
}

/**
 * The CHESS ENGINE's own files, in dev.
 *
 * The same route the production server holds (see engine-file.ts): the engine is a Worker script
 * that finds its wasm beside itself, so both topologies have to serve it from one path or a board
 * works in one and not the other.
 */
function chessEnginePlugin(): Plugin {
  return {
    name: "teams-lite-chess-engine",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ENGINE_ROUTE, async (req, res) => {
        // The middleware is mounted AT the route, so `req.url` is what follows it.
        const response = engineFileResponse(ENGINE_ROUTE + (req.url ?? "").replace(/^\/+/, ""));
        if (!response) {
          res.statusCode = 404;
          res.end("no such engine file\n");
          return;
        }
        res.statusCode = response.status;
        for (const [name, value] of response.headers) res.setHeader(name, value);
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

/**
 * The chess BOARD's own SOUNDS, in dev.
 *
 * The same route the production server holds (see chess-sound-file.ts), for the reason the engine's
 * own plugin exists: a board that sounded right in production and fell back to synthesis in dev
 * would make the difference invisible to whoever was working on it.
 */
function chessSoundPlugin(): Plugin {
  return {
    name: "teams-lite-chess-sound",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(CHESS_SOUND_ROUTE, async (req, res) => {
        // The middleware is mounted AT the route, so `req.url` is what follows it.
        const response = chessSoundFileResponse(
          CHESS_SOUND_ROUTE + (req.url ?? "").replace(/^\/+/, ""),
        );
        if (!response) {
          res.statusCode = 404;
          res.end("no such board sound\n");
          return;
        }
        res.statusCode = response.status;
        for (const [name, value] of response.headers) res.setHeader(name, value);
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

/**
 * Records what the build was pinned to, so the production server can refuse to
 * serve a bundle that was built for a test (see build-info.ts for the whole trap).
 * `VITE_TEAMS_WS_URL` is compiled INTO the client, and nothing in the output
 * directory afterwards reveals that — this file is what reveals it.
 *
 * `writeBundle` on the client build only: it runs once the assets are on disk, and
 * the server build writes into the same `dist/` from a sibling directory.
 */
function buildInfoPlugin(): Plugin {
  return {
    name: "teams-lite-build-info",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir;
      // Client output is dist/client, server output dist/server. Write one file at
      // dist/ level, from whichever finishes: both carry the same information.
      if (!dir) return;
      const distDir = join(dir, "..");
      const info: BuildInfo = {
        pinnedBackend: process.env.VITE_TEAMS_WS_URL?.trim() || null,
        builtAt: new Date().toISOString(),
        commit: process.env.TEAMS_BUILD_REV?.trim() || null,
      };
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, BUILD_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
    },
  };
}

// The backend the dev server relays {@link BACKEND_WS_ROUTE} to: the very one it
// was told to target, never a default (see `defaultWsUrl` in src/lib/ws-client.ts —
// a dev server with an implicit backend is how three real messages went out). No
// variable, no relay: the page then has to name a backend it can reach itself.
const DEV_BACKEND_WS_URL = process.env.VITE_TEAMS_WS_URL?.trim();

export default defineConfig(({ command }) => ({
  server: {
    port: DEV_PORT,
    host: DEV_HOST,
    // A browser on this machine talks to the Rust backend directly. One on another
    // device cannot — its own 127.0.0.1 is not this host — so it asks the dev
    // server for the same socket on this path, and Vite forwards it. That is what
    // makes the app work from a phone (over Tailscale) with the backend still bound
    // to loopback; `web/server.ts` does the same for a production build.
    proxy: DEV_BACKEND_WS_URL
      ? { [BACKEND_WS_ROUTE]: { target: DEV_BACKEND_WS_URL, ws: true, rewrite: () => "/" } }
      : undefined,
    // Reached through a Tailscale name, not just localhost. Vite rejects unknown
    // Host headers by default (DNS-rebinding protection), which would answer the
    // phone with "Blocked request" before any of the above matters.
    allowedHosts: [".ts.net"],
    // Fail on a taken port instead of quietly taking the next one. Everything that
    // points at this server names its port exactly — a Tailscale proxy, a phone's
    // bookmark, the E2E suite, `scripts/preview.ts` — so drifting to 4322 does not
    // degrade gracefully: it leaves those pointing at whatever else is on 19440.
    strictPort: true,
  },
  ssr: {
    // For the production BUILD, bundle every dependency into the SSR output so
    // dist/server/server.js is self-contained (only node: builtins stay
    // external) — this is what lets `teams` run the server from the compiled
    // binary's embedded, extracted bundle (no node_modules there).
    //
    // In DEV (`vite dev` / `teams --dev`) we must NOT inline them: Vite's
    // dev SSR module runner can't execute CommonJS deps such as react (they use
    // `module.exports`). `noExternal` has no valid "false" value, so we leave it
    // undefined in dev, which externalizes deps and lets the runtime require
    // them as CJS normally — so HMR works.
    noExternal: command === "build" ? true : undefined,
  },
  plugins: [
    writeTokenPlugin(),
    chessEnginePlugin(),
    chessSoundPlugin(),
    buildInfoPlugin(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    // React's Vite plugin MUST come after Start's plugin (per the TanStack docs).
    viteReact(),
  ],
}));

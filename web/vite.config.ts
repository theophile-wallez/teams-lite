// Vite config for the teams-lite web UI (TanStack Start, SSR).
//
// Plugin order matters: tsconfig paths -> tailwind -> tanstackStart -> react
// (react's plugin MUST come after Start's, per the TanStack Start docs).
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { WRITE_TOKEN_ROUTE, writeTokenResponse } from "./write-token";
import { BACKEND_WS_ROUTE } from "./src/lib/backend-route";

// The dev server port for `vite dev`. The production server reads PORT at
// runtime (see server.ts / the Nitro output), so this only affects local dev.
const DEV_PORT = Number(process.env.PORT ?? 4321);
// The dev server host. `teams --web-dev` sets HOST to bind the same interface as
// the production launcher; unset lets Vite pick its default (localhost).
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
    strictPort: false,
  },
  ssr: {
    // For the production BUILD, bundle every dependency into the SSR output so
    // dist/server/server.js is self-contained (only node: builtins stay
    // external) — this is what lets `teams --web` run the server from the
    // compiled binary's embedded, extracted bundle (no node_modules there).
    //
    // In DEV (`vite dev` / `teams --web-dev`) we must NOT inline them: Vite's
    // dev SSR module runner can't execute CommonJS deps such as react (they use
    // `module.exports`). `noExternal` has no valid "false" value, so we leave it
    // undefined in dev, which externalizes deps and lets the runtime require
    // them as CJS normally — so HMR works.
    noExternal: command === "build" ? true : undefined,
  },
  plugins: [
    writeTokenPlugin(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    // React's Vite plugin MUST come after Start's plugin (per the TanStack docs).
    viteReact(),
  ],
}));

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

export default defineConfig(({ command }) => ({
  server: {
    port: DEV_PORT,
    host: DEV_HOST,
    // The browser talks to the Rust backend directly over its own WebSocket
    // (ws://127.0.0.1:8420), so Vite needs no proxy — but keep HMR stable when
    // launched behind the `teams --web` supervisor.
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

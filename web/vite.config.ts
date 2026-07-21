// Vite config for the teams-lite web UI (TanStack Start, SSR).
//
// Plugin order matters: tsconfig paths -> tailwind -> tanstackStart -> react
// (react's plugin MUST come after Start's, per the TanStack Start docs).
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

// The dev server port for `vite dev`. The production server reads PORT at
// runtime (see server.ts / the Nitro output), so this only affects local dev.
const DEV_PORT = Number(process.env.PORT ?? 4321);

export default defineConfig({
  server: {
    port: DEV_PORT,
    // The browser talks to the Rust backend directly over its own WebSocket
    // (ws://127.0.0.1:8420), so Vite needs no proxy — but keep HMR stable when
    // launched behind the `teams --web` supervisor.
    strictPort: false,
  },
  // Bundle all dependencies into the SSR output so dist/server/server.js is
  // self-contained (only node: builtins stay external). This is what lets the
  // `teams --web` launcher run the server from the compiled binary's embedded,
  // extracted bundle — where there is no node_modules to resolve bare imports.
  ssr: {
    noExternal: true,
  },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    // React's Vite plugin MUST come after Start's plugin (per the TanStack docs).
    viteReact(),
  ],
});

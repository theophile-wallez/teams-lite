// Vitest config for the teams-lite web client's pure-logic unit tests.
//
// The modules under test (protocol, appearance, rich-text, ws-client) touch
// neither the DOM nor the real network, so a plain "node" environment is enough.
// We inject a fake WebSocket in the ws-client tests instead of a browser.
//
// Tests import { describe, it, expect, vi } from "vitest" explicitly (globals are
// off) because tsconfig.json type-checks the test files and does not list
// "vitest/globals" in its `types`.
//
// Component tests server-render a component to a string (`react-dom/server`), so
// they need no DOM either — but they do need JSX compiled, hence the React plugin.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // Resolve the `~/*` -> `./src/*` alias from tsconfig so tests can use it.
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] }), react()],
  test: {
    globals: false,
    environment: "node",
    // Both extensions: a component test is written in JSX (`*.test.tsx`), and an
    // include pattern that only matched `.ts` would skip it in silence.
    //
    // `scripts/` is in the list because testable code lives outside src/ too: the
    // production server's runtime file set and its build-info guard are not client
    // code, and a pattern that only saw src/ would run their tests never — which is
    // how the embedded bundle went out missing a module in the first place.
    //
    // The web ROOT is in it for the same reason and it is the sharper case: server.ts and
    // build-info.ts decide what a phone is served, and they sat outside every pattern —
    // so the day a staged update broke the running server, nothing was watching them.
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}", "*.test.{ts,tsx}"],
  },
});

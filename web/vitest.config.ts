// Vitest config for the teams-lite web client's pure-logic unit tests.
//
// The modules under test (protocol, color, theme-resolve, themes, ws-client)
// touch neither the DOM nor the real network, so a plain "node" environment is
// enough. We inject a fake WebSocket in the ws-client tests instead of a browser.
//
// Tests import { describe, it, expect, vi } from "vitest" explicitly (globals are
// off) because tsconfig.json type-checks *.test.ts and does not list
// "vitest/globals" in its `types`.
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // Resolve the `~/*` -> `./src/*` alias from tsconfig so tests can use it.
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

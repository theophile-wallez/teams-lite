// Production web server for the teams-lite web UI (Bun).
//
// `vite build` (TanStack Start, Vite environment API) emits two things:
//   - dist/client/  — hashed static assets + the client entry
//   - dist/server/server.js — a portable SSR handler exporting { fetch }
//
// This wrapper serves the static assets and falls back to the SSR handler for
// everything else. It is intentionally a plain Bun fetch server (no Nitro, no
// Node): that keeps it self-contained so the `teams --web` launcher can run it
// in-process with the embedded Bun runtime, preserving the single-binary promise.
//
// Env: PORT (default 4321), HOST (default 127.0.0.1).

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const here = import.meta.dir;
const clientDir = join(here, "dist", "client");
const serverEntry = join(here, "dist", "server", "server.js");

if (!existsSync(serverEntry)) {
  console.error(
    `[teams-web] build output missing at ${serverEntry}. Run \`bun run build\` first.`,
  );
  process.exit(1);
}

const { default: ssr } = (await import(serverEntry)) as {
  default: { fetch: (request: Request) => Response | Promise<Response> };
};

const port = Number(process.env.PORT ?? 4321);
const hostname = process.env.HOST ?? "127.0.0.1";

// Resolve a request path to a static file inside dist/client, guarding against
// path traversal. Returns null when there is no matching static asset.
function staticFileFor(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const full = join(clientDir, rel);
  if (!full.startsWith(clientDir)) return null;
  return existsSync(full) ? full : null;
}

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    // Browsers request /favicon.ico unconditionally; map it to our SVG so it
    // never falls through to the SSR handler as a 404.
    if (url.pathname === "/favicon.ico") {
      const svg = join(clientDir, "favicon.svg");
      if (existsSync(svg)) {
        return new Response(Bun.file(svg), {
          headers: { "cache-control": "public, max-age=86400" },
        });
      }
    }
    const filePath = staticFileFor(url.pathname);
    if (filePath) {
      const isHashedAsset = url.pathname.startsWith("/assets/");
      return new Response(Bun.file(filePath), {
        headers: isHashedAsset
          ? { "cache-control": "public, max-age=31536000, immutable" }
          : { "cache-control": "no-cache" },
      });
    }
    return ssr.fetch(request);
  },
});

console.log(`[teams-web] serving on http://${server.hostname}:${server.port}`);

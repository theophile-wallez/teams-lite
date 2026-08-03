// Production web server for the teams-lite web UI (Bun).
//
// `vite build` (TanStack Start, Vite environment API) emits two things:
//   - dist/client/  — hashed static assets + the client entry
//   - dist/server/server.js — a portable SSR handler exporting { fetch }
//
// This wrapper serves the static assets, relays the page's WebSocket to the local
// Rust backend, and falls back to the SSR handler for everything else. It is
// intentionally a plain Bun fetch server (no Nitro, no Node): that keeps it
// self-contained so the `teams` launcher can run it in-process with the embedded
// Bun runtime, preserving the single-binary promise.
//
// Env: PORT (default 19440), HOST (default 127.0.0.1),
//      TEAMS_LITE_WS_URL (default ws://127.0.0.1:19420 — the backend to relay to).

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { WRITE_TOKEN_ROUTE, writeTokenResponse } from "./write-token";
import { readBuildInfo, refuseToServeReason } from "./build-info";

const here = import.meta.dir;
const distDir = join(here, "dist");
const clientDir = join(distDir, "client");
const serverEntry = join(distDir, "server", "server.js");

if (!existsSync(serverEntry)) {
  console.error(
    `[teams-web] build output missing at ${serverEntry}. Run \`bun run build\` first.`,
  );
  process.exit(1);
}

// Refuse a bundle built against a pinned backend — an E2E build, in practice. It
// would send the page to that backend instead of this machine's, and nothing about
// the directory shows it (see build-info.ts). Exit rather than warn: a service that
// starts anyway is a service whose logs nobody reads until the phone misbehaves.
const buildInfo = readBuildInfo(distDir);
const refusal = refuseToServeReason(buildInfo, process.env);
if (refusal) {
  console.error(`[teams-web] refusing to serve this build: ${refusal}`);
  process.exit(1);
}

const { default: ssr } = (await import(serverEntry)) as {
  default: { fetch: (request: Request) => Response | Promise<Response> };
};

const port = Number(process.env.PORT ?? 19440);
const hostname = process.env.HOST ?? "127.0.0.1";

/**
 * The backend this server relays page sockets to.
 *
 * Loopback by default, because that is the only interface the backend binds
 * (`bind_addr()` in `src/bin/server.rs`) and the only one it should: reaching it
 * means reaching the user's Teams account. Overridable so a read-only backend can
 * be put behind the app instead (`TEAMS_LITE_READ_ONLY=1` listens on 19430).
 */
const backendWsUrl = process.env.TEAMS_LITE_WS_URL?.trim() || "ws://127.0.0.1:19420";

/** Per-connection state for one page socket relayed to the backend. */
type Relay = {
  /** Our socket to the backend, opened when the page's socket opens. */
  upstream: WebSocket | null;
  /** Frames from the page that arrived before `upstream` finished opening. */
  pending: (string | ArrayBufferLike | ArrayBufferView)[];
};

// Ceiling on a single relayed frame, both ways. Generous because the protocol
// carries proxied media inline: `fetch_media` and `mail_attachment` answer with a
// base64 blob on this same socket, so one frame can be an entire attachment.
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

// Resolve a request path to a static file inside dist/client, guarding against
// path traversal. Returns null when there is no matching static asset.
function staticFileFor(pathname: string): string | null {
  if (pathname === "/" || pathname === "") return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (`/%ZZ`) throws URIError. Answer "no such asset" and let
    // SSR render its 404, rather than letting a 500 out of the fetch handler.
    return null;
  }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const full = join(clientDir, rel);
  if (!full.startsWith(clientDir)) return null;
  return existsSync(full) ? full : null;
}

const server = Bun.serve<Relay>({
  port,
  hostname,
  idleTimeout: 60,
  async fetch(request, server) {
    const url = new URL(request.url);
    // A WebSocket upgrade is always the page asking for the backend: the app opens
    // exactly one socket, on `BACKEND_WS_ROUTE` (see `defaultWsUrl` in
    // src/lib/ws-client.ts; the dev server proxies the same path). Relaying it is
    // what lets the app work from another device — a phone's own 127.0.0.1 is not
    // this machine's backend, and an https: page may not open a plaintext ws:// at
    // all — while the backend itself stays bound to loopback. Any path is accepted:
    // this server has no other socket to confuse it with, and matching loosely
    // keeps it working if the route ever moves.
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (server.upgrade(request, { data: { upstream: null, pending: [] } })) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 400 });
    }
    // The app's page cannot read the backend's write token from disk, so hand it
    // over here. Without it the client is read-only (see write-token.ts).
    if (url.pathname === WRITE_TOKEN_ROUTE) return writeTokenResponse();
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
  websocket: {
    maxPayloadLength: MAX_FRAME_BYTES,
    backpressureLimit: MAX_FRAME_BYTES,
    // Drop the connection rather than silently discarding a frame: the client
    // reconnects and reissues, whereas a hole in the stream would hang a request
    // until its timeout with no way to tell what went missing.
    closeOnBackpressureLimit: true,
    // Bun pings on its own (`sendPings` defaults to true) and browsers answer, so
    // an idle chat stays open instead of being torn down every couple of minutes.
    idleTimeout: 120,

    open(ws) {
      const upstream = new WebSocket(backendWsUrl);
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        for (const frame of ws.data.pending) upstream.send(frame as string);
        ws.data.pending = [];
      };
      upstream.onmessage = (event: MessageEvent) => ws.send(event.data);
      upstream.onclose = () => ws.close();
      // A refused connection means no backend is listening. Close with "server
      // error" so the page's own reconnect/backoff handles it (see ws-client.ts)
      // instead of waiting on requests that can never be answered.
      upstream.onerror = () => ws.close(1011, "backend unreachable");
    },

    message(ws, message) {
      const upstream = ws.data.upstream;
      if (!upstream) return;
      // The page can send as soon as ITS socket is open, which happens before ours
      // to the backend is — hold those frames rather than dropping them, or the
      // first request of every session (`conversations`) would vanish.
      if (upstream.readyState !== WebSocket.OPEN) {
        ws.data.pending.push(message);
        return;
      }
      upstream.send(message as string);
    },

    close(ws) {
      ws.data.pending = [];
      try {
        ws.data.upstream?.close();
      } catch {
        // Already closing/closed: nothing left to release.
      }
      ws.data.upstream = null;
    },
  },
});

console.log(
  `[teams-web] serving on http://${server.hostname}:${server.port} (backend ${backendWsUrl})`,
);
// Name the artifact in the log too: the always-on service runs a STAGED copy of
// this bundle (bin/teams-lite-service.sh), so "which build is live" is a question
// the journal has to be able to answer.
if (buildInfo) {
  const commit = buildInfo.commit ? ` commit ${buildInfo.commit.slice(0, 12)}` : "";
  console.log(`[teams-web] bundle built ${buildInfo.builtAt}${commit}`);
}

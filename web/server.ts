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
import { CHESS_SOUND_ROUTE, chessSoundFileResponse } from "./chess-sound-file";
import { ENGINE_ROUTE, engineFileResponse } from "./engine-file";
import { bundleWasReplaced, readBuildInfo, refuseToServeReason } from "./build-info";

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
  default: { fetch: (request: Request) => unknown };
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

// Whether Bun will serve this object, which is NOT `instanceof Response`. Bun.serve
// accepts a Response its own class constructed and refuses every other object — and
// srvx's `NodeResponse` (h3, under TanStack Start) passes `instanceof` while being
// refused, so the constructor is the only test that matches Bun's own behaviour. Handed
// one, Bun answers with its BRANDED "fetch(req) did not return a Response object" page,
// at status 200, and dumps the object over a dozen journal lines: the reader is told
// nothing and the operator is told nothing about the cause.
function bunWillServe(value: unknown): value is Response {
  return value instanceof Response && value.constructor === Response;
}

/** How much of a refused body to quote: enough to name a cause, never a whole page. */
const CAUSE_CHARS = 300;

/**
 * One LINE for the journal, and the cause rather than the shape.
 *
 * `console.error` on a Response prints a screenful of getters — that is what Bun's own
 * refusal did, seventeen times, and it named nothing. What is worth having is inside the
 * refused object: the SSR handler catches its own module-resolution error and hands back a
 * response CARRYING it (`Cannot find module './assets/start-….js'`), so reading that body
 * is the difference between a report and a shrug. Bounded, and it never throws: this runs
 * on the path that exists because something else already went wrong.
 */
async function causeOf(value: unknown): Promise<string> {
  if (value instanceof Error) return value.message;
  const shape = (value as object)?.constructor?.name ?? typeof value;
  if (!(value instanceof Response)) return `returned ${shape}`;
  try {
    const text = (await value.text()).replace(/\s+/g, " ").trim();
    if (!text) return `returned ${shape} ${value.status} with an empty body`;
    return `returned ${shape} ${value.status}: ${text.slice(0, CAUSE_CHARS)}`;
  } catch {
    return `returned ${shape} ${value.status}, whose body could not be read`;
  }
}

// What was last reported, so a broken build says its cause ONCE instead of once per
// request. A phone retrying behind a lock screen is the common case.
let lastFailure = "";

function reportOnce(line: string): void {
  if (line === lastFailure) return;
  lastFailure = line;
  console.error(`[teams-web] ${line}`);
}

/** Text into markup. Both callers pass literals; nothing later has to remember that. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A page for a request this server cannot render, as a REAL Response.
 *
 * Plain HTML with no script and no remote reference — the discipline the rest of the app
 * holds to, and the only shape that is certain to render when the bundle behind it is the
 * thing that is broken. It says nothing about the cause either: that goes to the journal,
 * because an SSR error quoted onto a page states this machine's paths to whoever reached
 * it. No auto-refresh: `install` stages without restarting anything, so a page that
 * reloaded itself would spin for ever there. The reader gets the sentence and the link.
 */
function plainPage(status: number, rawTitle: string, rawSentence: string): Response {
  const title = escapeHtml(rawTitle);
  const sentence = escapeHtml(rawSentence);
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;` +
    `font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;padding:2rem}` +
    `main{max-width:32rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}` +
    `p{margin:0 0 1.5rem;color:#aaa}a{color:#eee}</style></head>` +
    `<body><main><h1>${title}</h1><p>${sentence}</p>` +
    `<a href="">Reload</a></main></body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Render with the SSR handler, and never hand Bun something it refuses to serve.
 *
 * Two failures come through here and they are told apart by the build stamp on disk
 * (`bundleWasReplaced`), because the reader's next move differs:
 *
 *   - THE BUNDLE MOVED UNDER US. An update staged a new `dist/` while this process kept
 *     the module graph of the old one, so a lazy route chunk no longer exists. The
 *     restart that finishes the update is seconds away, so the answer is 503 + a reload.
 *     This is the one that reached a real user: on 2026-08-06 an update staged a bundle
 *     and then held its restart for a live `@claude` run that took 40 minutes, so the
 *     phone was served Bun's own error page from the moment it staged (see the header of
 *     bin/teams-lite-service.sh, which now waits BEFORE it stages).
 *   - ANYTHING ELSE is a real SSR fault at this build, and calling it an update would
 *     send the reader reloading a page that is never going to come back on its own.
 */
async function renderWithSsr(request: Request): Promise<Response> {
  let answer: unknown;
  try {
    answer = await ssr.fetch(request);
  } catch (error) {
    answer = error instanceof Error ? error : new Error(String(error));
  }
  if (bunWillServe(answer)) return answer;

  const path = new URL(request.url).pathname;
  if (bundleWasReplaced(buildInfo, readBuildInfo(distDir))) {
    reportOnce(
      "the bundle on disk was replaced while this server was running, so its route " +
        "chunks are gone — serving 503 until the update restarts it",
    );
    return plainPage(
      503,
      "teams-lite is being updated",
      "This build was replaced a moment ago. Reload once the service has restarted.",
    );
  }
  reportOnce(`the SSR handler failed on ${path}: ${await causeOf(answer)}`);
  return plainPage(
    500,
    "teams-lite could not render this page",
    "The server could not build the page. Its journal says why.",
  );
}

// Exported, and that export is load-bearing for exactly one caller: the `teams`
// launcher imports this module to start the app in-process, and an in-app update has to
// free this port before the new build binds it (see launcher/src/update.ts). Nothing
// else stops it — a service run is stopped by systemd, and a stop() nobody calls costs
// nothing.
export const server = Bun.serve<Relay>({
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
    // The CHESS ENGINE's own files, from the cache the backend fetched them into. It serves the two
    // PINNED names and nothing else, so a request cannot reach any other file on this machine (see
    // engine-file.ts).
    if (url.pathname.startsWith(ENGINE_ROUTE)) {
      const engine = engineFileResponse(url.pathname);
      if (engine) return engine;
    }
    // The chess BOARD's own sounds, from the same kind of cache and under the same rule: the twelve
    // PINNED names and nothing else (see chess-sound-file.ts). They are served from here rather than
    // fetched by the page so that drawing a board tells chess.com nothing.
    if (url.pathname.startsWith(CHESS_SOUND_ROUTE)) {
      const sound = chessSoundFileResponse(url.pathname);
      if (sound) return sound;
    }
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
    return renderWithSsr(request);
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

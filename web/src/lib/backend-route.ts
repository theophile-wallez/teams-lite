// The one path both of the app's servers relay to the Rust backend.
//
// Its own module because the two sides that must agree on it live in different
// programs: the browser client (`ws-client.ts`) and the servers that forward it —
// `web/server.ts` in production, a Vite proxy in dev (`vite.config.ts`). Keeping it
// here means the dev config does not have to pull browser code into the Node build
// just to learn one string.

/**
 * Where a page that cannot reach the backend directly asks its own server for that
 * socket instead — a phone over Tailscale, say, whose 127.0.0.1 is not this
 * machine's. Prefixed like `/__write-token`: an app-server endpoint, never a route.
 */
export const BACKEND_WS_ROUTE = "/__backend";

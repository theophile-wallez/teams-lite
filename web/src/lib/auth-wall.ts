// When a SIGN-IN in front of this app expires, the page signs in again — by itself when nothing
// would be lost, and by the reader's own press when something would.
//
// The app can be published behind an authenticating proxy (oauth2-proxy in the Helm chart, or
// Cloudflare Access, Pomerium, an ingress controller's own auth): every request must carry that
// proxy's session cookie, and when the cookie expires the proxy answers with a redirect to its
// identity provider, or a 401. A WebSocket handshake cannot follow a redirect and the browser
// tells a page NOTHING about why one failed — a sign-in that expired, a backend that is down and a
// network that dropped are the same bare close event. So the page kept retrying a socket the proxy
// would never let through, and after half a minute said "Backend lost" over a backend that was
// fine, until somebody thought to reload.
//
// The decision here is taken on an ordinary request the page CAN read the answer of: the store
// asks its own server for something behind the same wall with redirects made visible
// (`redirect: "manual"`), and only a wall says "sign in". The app's own servers never answer that
// route with a redirect or a 401 (200 with the token, 404 without one), so on a machine with no
// proxy in front this never fires.
//
// A RELOAD is the remedy, because it is a top-level navigation: the one request a browser follows
// through the identity provider and back, which with the provider's own session alive costs a
// blink. But a reload also throws away what lives only in this page — a thread's draft, a typed
// title, pasted pictures, and a live call's audio — so it is taken on its own ONLY when none of
// that is there (lib/unsent-work.ts); otherwise the reader is ASKED, with the reload one press away,
// and can copy their words out first. And it is bounded, so a proxy that can never be satisfied is
// not a page reloading for ever: only while the page is VISIBLE (a background reload would walk a
// hidden tab through a sign-in nobody is looking at), and at most once per
// {@link AUTH_RELOAD_INTERVAL_MS}, remembered across the reload itself — inside that window the
// reader is asked instead.

/** What the probe answered: the Response's `type` and `status`, or null when it never arrived. */
export type ProbeAnswer = { type: ResponseType | string; status: number } | null;

/**
 * - `signed-out`  — something in front of this app wants a sign-in: a redirect (which a
 *                   `redirect: "manual"` fetch sees as `opaqueredirect`), or a 401.
 * - `reachable`   — this app's own server answered; whatever failed the socket, it was not a sign-in.
 * - `unreachable` — nothing answered (offline, the server down, a gateway's 5xx).
 *
 * 403 is deliberately NOT `signed-out`: it is a REFUSAL — a proxy saying this account is not
 * allowed, or this app's own server refusing an address — which a sign-in does not change, so
 * reloading into it would only walk the reader to the same refusal again.
 */
export type SessionVerdict = "signed-out" | "reachable" | "unreachable";

export function sessionVerdict(answer: ProbeAnswer): SessionVerdict {
  if (!answer) return "unreachable";
  if (answer.type === "opaqueredirect" || answer.status === 401) return "signed-out";
  if (answer.status === 0 || answer.status >= 500) return "unreachable";
  return "reachable";
}

/** How often a failed handshake may send a probe: the reconnect backoff fires every few seconds. */
export const SESSION_PROBE_INTERVAL_MS = 15_000;

/** The shortest gap between two automatic reloads, remembered across the reload itself. */
export const AUTH_RELOAD_INTERVAL_MS = 5 * 60_000;

/** Where the moment of the last automatic reload is kept (sessionStorage: this tab, this visit). */
export const AUTH_RELOAD_KEY = "teams-lite:auth-wall-reload";

/**
 * - `reload` — reload now: the sign-in expired, the page is looked at, nothing would be lost, and
 *              no automatic reload happened inside the interval.
 * - `ask`    — the sign-in expired, but a reload now would lose something (or one just happened and
 *              did not help): tell the reader, with the reload one press away.
 * - `none`   — nothing to do (no sign-in in the way), or not yet (the page is hidden; the next wake
 *              asks again).
 */
export type SignInRemedy = "reload" | "ask" | "none";

export function signInRemedy(input: {
  verdict: SessionVerdict;
  visible: boolean;
  /** When the last automatic reload happened, or null for never. */
  lastReloadAt: number | null;
  now: number;
  /** Whether a reload would throw away unsent words, pictures or a live call. */
  wouldLoseWork: boolean;
}): SignInRemedy {
  if (input.verdict !== "signed-out") return "none";
  if (input.wouldLoseWork) return "ask";
  if (!input.visible) return "none";
  if (input.lastReloadAt === null) return "reload";
  // A clock that went BACKWARDS is not "a long time ago": it is no evidence either way, and a
  // reload loop is the one outcome this must never have.
  const since = input.now - input.lastReloadAt;
  return since >= AUTH_RELOAD_INTERVAL_MS ? "reload" : "ask";
}

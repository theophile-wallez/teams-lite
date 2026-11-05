// Which ADDRESS a request may reach the app under, and which PAGE may open its socket.
//
// The app's server hands the backend's write token to every page it serves (write-token.ts) and
// relays that page's WebSocket to the backend, where reads need no token at all. So "who can make a
// browser talk to this server" is the whole account, and two browser attacks reach it without the
// attacker ever touching this machine:
//
//   CROSS-SITE WEBSOCKET HIJACKING. A browser opens a WebSocket to any address a page names, and
//   WebSockets are not covered by the same-origin policy: a page on evil.example can open
//   ws://127.0.0.1:19440/ — or the tailnet name, or a public hostname behind a sign-in wall, whose
//   cookie the browser attaches — and read every chat, mail and calendar entry that answers on it.
//   The browser always says which page asked (`Origin`), so the socket is refused unless that page
//   is this app's own: same-origin with the address the request came in on.
//
//   DNS REBINDING. evil.example resolves to the attacker's server, serves a page, then resolves to
//   127.0.0.1. The page is now SAME-ORIGIN with this server under the attacker's name, so the Origin
//   check above passes and so does a read of the token route — the token, not just the reads. What
//   the browser cannot fake is the NAME it used, so a request is refused unless its Host is one this
//   app answers to. That is Vite's own `server.allowedHosts`, which the dev server already enforces
//   (vite.config.ts) — this gives the production server the same rule.
//
// One module, imported by the production server (server.ts) and by the dev server's proxy
// (vite.config.ts), so the two cannot disagree. It names nothing from Bun — vite.config.ts is
// evaluated under Node — and reads headers through a function so either server's request fits.
//
// What it is NOT: a defence against anything that is not a browser. A script sets any Origin and
// any Host it likes; the write token (src/bin/server.rs) is what stands between a script and a
// send. Reads by a local process are open by design, and this does not change that.

/** Extra names this app answers to, comma-separated. `.example.com` means that domain and every
 *  name under it; `*` turns the Host check off (and says so in the journal). */
export const ALLOWED_HOSTS_ENV = "TEAMS_LITE_ALLOWED_HOSTS";

/** Extra page origins that may open the socket, comma-separated (`https://teams.example.com`). For a
 *  proxy that rewrites Host and says nothing in X-Forwarded-Host, which no origin can then match. */
export const ALLOWED_ORIGINS_ENV = "TEAMS_LITE_ALLOWED_ORIGINS";

/** A header by name, case-insensitively; `null`/`undefined` when absent. */
export type HeaderReader = (name: string) => string | null | undefined;

export type Verdict = { ok: true } | { ok: false; reason: string };

/** The configuration a verdict is taken against, read once from the environment. */
export type OriginPolicy = {
  /** Names beyond the built-in ones (lowercase; a leading `.` covers subdomains). */
  hosts: readonly string[];
  /** Whether `*` was given: every name is accepted. */
  anyHost: boolean;
  /** Origins beyond same-origin, normalized (`scheme://host[:port]`). */
  origins: readonly string[];
};

/**
 * The policy, from `env` and from the names the SERVER ITSELF was told to listen on (`ownHosts` —
 * its `HOST`): an operator who binds `teams --host mybox.lan` and opens that URL is not a
 * DNS-rebinding page, and refusing the page the launcher itself opened would be the app refusing
 * its own front door. An address or an unspecified bind (`0.0.0.0`) adds nothing a built-in does not
 * already cover.
 */
export function policyFromEnv(
  env: Record<string, string | undefined>,
  ownHosts: readonly (string | undefined)[] = [],
): OriginPolicy {
  const entries = [...splitList(env[ALLOWED_HOSTS_ENV]), ...ownHosts.filter((h): h is string => !!h?.trim())];
  const hosts = entries.map(hostEntry);
  const origins = splitList(env[ALLOWED_ORIGINS_ENV])
    .map(normalizeOrigin)
    .filter((origin): origin is string => origin !== null);
  return { hosts: hosts.filter((h) => h !== "*"), anyHost: hosts.includes("*"), origins };
}

/**
 * One allowed-hosts entry as the NAME it compares on: lowercase, no trailing dot, and no port — the
 * refusal page names the address a request came in under, port included, and a reader who pastes
 * that in must not be refused again by the very entry it told them to add.
 */
function hostEntry(raw: string): string {
  const entry = raw.trim().toLowerCase();
  if (entry === "*") return entry;
  const dot = entry.startsWith(".");
  const body = dot ? entry.slice(1) : entry;
  const name = parseAuthority(body)?.hostname ?? body.replace(/\.$/, "");
  return dot ? `.${name}` : name;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * An authority (`host`, `host:port`, `[v6]:port`) split into a lowercase hostname and its port, or
 * null when it is not one. The port is `null` when absent: what it defaults to depends on a scheme
 * the Host header does not carry, so the comparison below supplies it.
 */
export function parseAuthority(raw: string): { hostname: string; port: string | null } | null {
  const value = raw.trim().toLowerCase();
  if (!value || /[\s/@?#]/.test(value)) return null;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return null;
    const rest = value.slice(end + 1);
    if (rest && !/^:\d+$/.test(rest)) return null;
    return { hostname: value.slice(0, end + 1), port: rest ? rest.slice(1) : null };
  }
  const colon = value.lastIndexOf(":");
  if (colon >= 0) {
    const port = value.slice(colon + 1);
    // A second colon outside brackets is an unbracketed IPv6 address, which no Host header carries.
    if (!/^\d+$/.test(port) || value.slice(0, colon).includes(":")) return null;
    return { hostname: value.slice(0, colon).replace(/\.$/, ""), port };
  }
  return { hostname: value.replace(/\.$/, ""), port: null };
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Whether this app answers to `hostname` without being told.
 *
 * Each built-in is a name no DNS-rebinding attacker can put in a victim's address bar: a LOOPBACK
 * name (`localhost`, and `*.localhost`, which browsers resolve to loopback themselves), an IP
 * LITERAL (a page served from an address belongs to whoever holds that address), and a TAILNET name
 * under `.ts.net` (Tailscale holds that zone; the dev server allows it for the same reason, and it is
 * how a phone reaches the always-on service through `tailscale serve`).
 */
export function hostIsBuiltIn(hostname: string): boolean {
  const name = hostname.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (IPV4.test(name)) return true;
  if (name.startsWith("[") && name.endsWith("]")) return true;
  return name.endsWith(".ts.net");
}

function hostIsAllowed(hostname: string, policy: OriginPolicy): boolean {
  if (policy.anyHost || hostIsBuiltIn(hostname)) return true;
  return policy.hosts.some((entry) =>
    entry.startsWith(".") ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry,
  );
}

/**
 * Every name a request says it came in under: its Host, then what a proxy in front of us wrote in
 * X-Forwarded-Host and `Forwarded: host=` — which is where a proxy that rewrites Host to our own
 * address keeps the public name.
 *
 * ONLY THE SOCKET'S ORIGIN CHECK MAY READ THE LAST TWO. Neither is a forbidden header, so a page
 * can set either on any `fetch` it makes — and after DNS rebinding that fetch is same-origin, needs
 * no preflight, and could name `127.0.0.1` while its Host names the attacker. A WebSocket handshake
 * is the one request a page cannot add a header to, so there they are trustworthy; the address
 * check (`hostVerdict`) reads Host alone.
 */
export function requestAuthorities(header: HeaderReader): string[] {
  const names: string[] = [];
  const host = header("host");
  if (host) names.push(host);
  for (const value of splitList(header("x-forwarded-host") ?? undefined)) names.push(value);
  for (const element of splitList(header("forwarded") ?? undefined)) {
    for (const pair of element.split(";")) {
      const [key, ...rest] = pair.split("=");
      if (key?.trim().toLowerCase() !== "host") continue;
      const value = rest.join("=").trim().replace(/^"|"$/g, "");
      if (value) names.push(value);
    }
  }
  return names;
}

/**
 * Whether a request's address is one this app answers to — the DNS-rebinding half, taken on EVERY
 * request, because the token route and the socket are not the only pages worth refusing under an
 * attacker's name.
 */
export function hostVerdict(header: HeaderReader, policy: OriginPolicy): Verdict {
  // HOST ALONE — a forwarded name is a header any page may set (see `requestAuthorities`). A proxy
  // that rewrites Host to our own address still passes: loopback names and addresses are built in.
  const host = header("host") ?? "";
  const parsed = parseAuthority(host);
  if (parsed && hostIsAllowed(parsed.hostname, policy)) return { ok: true };
  const shown = parsed?.hostname ?? (host || "(no Host header)");
  return {
    ok: false,
    reason:
      `this server does not answer to the name ${shown}. If that is your address for it, add ` +
      `${shown} — the name alone, no port — to ${ALLOWED_HOSTS_ENV} (comma-separated; a leading ` +
      `"." covers subdomains).`,
  };
}

/** `scheme://host[:port]` with the scheme's default port dropped, or null for no usable origin. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether a WebSocket UPGRADE may go through: its address passes {@link hostVerdict}, and the page
 * that asked is this app's own.
 *
 * NO `Origin` IS ACCEPTED: every browser sends one on a WebSocket handshake, so a request without
 * one is not a page — the launcher's own keepalive, a probe, a script — and Origin was never going
 * to stop those. `null` is REFUSED: a sandboxed iframe and a `data:` page both send it, and both are
 * exactly what an attacker can make.
 */
export function upgradeVerdict(header: HeaderReader, policy: OriginPolicy): Verdict {
  const host = hostVerdict(header, policy);
  if (!host.ok) return host;
  const raw = header("origin");
  if (raw === null || raw === undefined) return { ok: true };
  const origin = normalizeOrigin(raw);
  if (origin === null) {
    return { ok: false, reason: `a page with origin ${JSON.stringify(raw)} may not open this app's socket.` };
  }
  if (policy.origins.includes(origin)) return { ok: true };
  const url = new URL(origin);
  const hostname = url.hostname.replace(/\.$/, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const authority of requestAuthorities(header)) {
    const parsed = parseAuthority(authority);
    if (!parsed || !hostIsAllowed(parsed.hostname, policy)) continue;
    if (parsed.hostname === hostname && (parsed.port ?? port) === port) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `a page on ${origin} may not open this app's socket: it was not served by this app ` +
      `(the request came in as ${requestAuthorities(header)[0] ?? "(no Host header)"}). If a proxy ` +
      `in front of this server rewrites Host, have it send X-Forwarded-Host, or add ${origin} to ` +
      `${ALLOWED_ORIGINS_ENV}.`,
  };
}

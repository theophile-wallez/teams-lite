// Whether the token this app hands its own page is the token its backend accepts.
//
// WHY THIS EXISTS. The backend gates every outward and machine method on a capability
// token it mints per PROCESS (the write lock, see src/bin/server.rs). We hand that token
// to our own page through the web server we run in-process — and there are two ways to
// end up serving one the backend refuses:
//
//   • WE ATTACHED. `ensureBackend` attaches to a backend that is already listening
//     rather than spawning one, and a backend another `teams` spawned carries a PINNED
//     token — which is deliberately in no file. So the file our page falls back to holds
//     somebody else's token, or none.
//   • THE PAGE'S SOCKET GOES ELSEWHERE. `TEAMS_LITE_WS_URL`, when it is already set,
//     wins over the backend we manage, so the page can talk to one backend while holding
//     the token of another.
//
// In both, reads answer normally: the sidebar fills, the history scrolls, the live dot is
// green — and every send, reaction, mark-as-read and update comes back refused. A user met
// it on the update button, and the refusal text of whatever they pressed was the only
// place this app ever said so. So we ask the backend at startup and say it plainly, once,
// where the person who ran the command can read it.
//
// Asking costs the backend nothing and reveals nothing: `write_lock_status` is an open
// method that answers where the asker stands, never what the token is.

/// Where this app stands with its backend's write lock. `unknown` is the honest answer
/// for a backend too old to know the question, or one that did not answer in time —
/// never a warning, because a guess about the user's install is worse than silence.
export type WriteLockState = "held" | "foreign" | "read_only" | "unknown";

/// The backend's answer (see `write_lock_payload` in src/bin/server.rs). `pinned` says
/// where its token lives, which is what makes a `foreign` state actionable.
export type WriteLockReport = { state: WriteLockState; pinned: boolean };

export const UNKNOWN_WRITE_LOCK: WriteLockReport = { state: "unknown", pinned: false };

/// Read the backend's `write_lock_status` answer, keeping nothing we cannot prove.
export function parseWriteLock(raw: unknown): WriteLockReport {
  if (!raw || typeof raw !== "object") return UNKNOWN_WRITE_LOCK;
  const { state, pinned } = raw as { state?: unknown; pinned?: unknown };
  if (state !== "held" && state !== "foreign" && state !== "read_only") return UNKNOWN_WRITE_LOCK;
  return { state, pinned: pinned === true };
}

/// What to print for a report, or null when there is nothing to say.
///
/// `held` is silence: the healthy case is every case, and a line stating it would be one
/// more line nobody reads. The other two are stated because the user cannot see either
/// from the app — and each one names the way out, which differs:
///
///   • a PINNED token belongs to the launcher that spawned that backend, so no file holds
///     the right one and nothing this instance can read would help: another `teams` owns
///     it, and the way out is to stop that one or to give this one a backend of its own.
///   • an UNPINNED one sits in the file every frontend reads, so this backend published a
///     token and we are serving something else — a value inherited from a dead instance,
///     or a file another backend has since published over. Restarting THIS app is what
///     re-reads it; a reload of the page would ask the same server the same question.
export function writeLockWarning(report: WriteLockReport, wsUrl: string): string | null {
  if (report.state === "held" || report.state === "unknown") return null;
  if (report.state === "read_only") {
    return (
      `[write-lock] the backend on ${wsUrl} runs read-only (TEAMS_LITE_READ_ONLY=1) — ` +
      "this app can read everything and send nothing. Start it without that variable to send."
    );
  }
  const cause = report.pinned
    ? `another teams-lite instance owns the backend on ${wsUrl}: its token was pinned by ` +
      "the launcher that started it, so no file holds the one this app serves. Stop that " +
      "instance, or give this one a backend of its own (TEAMS_LITE_PORT)."
    : `the backend on ${wsUrl} published its token, and this app is serving another one. ` +
      "Restart this app so it reads that backend's token, or stop the other backend on " +
      "this machine.";
  return (
    "[write-lock] this backend does not accept the token this app serves — every send, " +
    `reaction and update will be refused. ${cause}`
  );
}

/// Ask an already-running backend one question over a socket of its own, and close it.
///
/// Deliberately not the launcher's keepalive connection: that one exists to keep the
/// backend from idling out and to carry its `update_restart` event, and a request/reply
/// exchange multiplexed onto it would have to survive every reconnect for the sake of one
/// question asked once. Resolves `undefined` on any failure — a diagnostic must never be
/// the reason the app does not start.
export function askBackend(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: unknown) => {
      if (settled) return;
      settled = true;
      try {
        ws?.close();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      clearTimeout(timer);
      return done(undefined);
    }
    ws.onopen = () => ws?.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event: MessageEvent) => {
      // The backend also pushes events on this socket (a greeting, a broker status), and
      // they carry no `id` — so the reply is the frame that answers ours.
      try {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
        if (frame.id !== 1) return;
        clearTimeout(timer);
        done(frame.result);
      } catch {
        /* not JSON, not our reply */
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(undefined);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      done(undefined);
    };
  });
}

/// Ask the backend whether it accepts the token our own web server hands the page.
///
/// The token is read back from that server's own endpoint rather than from the
/// environment or the file, because the endpoint IS what the page gets: this checks the
/// chain the user's clicks travel down, not our idea of it.
/// A missing endpoint and a missing TOKEN are two different answers, and only the first
/// is worth waiting for: our web server may not have bound its port yet (Vite takes
/// seconds), while a 404 is the server saying there is no token — which is itself part of
/// the state being measured. So `fetchToken` THROWS for the first and returns null for the
/// second, and this retries only a throw.
export async function readWriteLock(deps: {
  tokenUrl: string;
  wsUrl: string;
  fetchToken?: (url: string) => Promise<string | null>;
  ask?: (wsUrl: string, method: string, params: Record<string, unknown>) => Promise<unknown>;
  /// How many times to wait for our own server to come up, one second apart.
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<WriteLockReport> {
  const fetchToken = deps.fetchToken ?? fetchWriteToken;
  const ask = deps.ask ?? askBackend;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? 5;

  let token: string | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      token = await fetchToken(deps.tokenUrl);
      break;
    } catch {
      // Our own server never answered, so nothing has been proven either way.
      if (attempt >= attempts) return UNKNOWN_WRITE_LOCK;
      await sleep(1_000);
    }
  }
  const raw = await ask(deps.wsUrl, "write_lock_status", { write_token: token ?? undefined });
  return parseWriteLock(raw);
}

/// Read the token our own web server serves (`WRITE_TOKEN_ROUTE` in web/write-token.ts).
/// Null means the server answered that it has none, which the backend then reads as
/// `foreign` — the same state the page is in, which is the point.
async function fetchWriteToken(url: string): Promise<string | null> {
  // A network failure is left to THROW, which is what makes the caller wait and try
  // again: our own server may not have bound its port yet.
  const res = await fetch(url, { headers: { "cache-control": "no-store" } });
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token ? body.token : null;
  } catch {
    return null;
  }
}

/// Put the token our page must present into `env`, or take a stale one out.
///
/// The removal is the load-bearing half. `TEAMS_LITE_WRITE_TOKEN` is read from the
/// environment FIRST by web/write-token.ts, and this process inherits its parent's
/// environment — which for the app's own update is the launcher it replaced. So a value
/// left behind is a dead instance's token, served to a live page in front of the file
/// that holds the right one.
export function serveWriteToken(
  env: Record<string, string | undefined>,
  variable: string,
  spawned: string | null,
): void {
  if (spawned) env[variable] = spawned;
  else delete env[variable];
}

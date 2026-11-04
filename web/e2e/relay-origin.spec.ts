// The production server's two refusals, driven over HTTP against the real web/server.ts: an
// address it does not answer to (DNS rebinding), and a socket opened by another site's page
// (cross-site WebSocket hijacking). See web/request-origin.ts for both arguments; the policy itself
// is unit-tested there, and this pins that the SERVER applies it — to every request, and before an
// upgrade reaches the backend.
//
// The relay's upstream is the MOCK in this suite (TEAMS_LITE_WS_URL in playwright.config.ts), so
// the one upgrade this lets through reaches nothing real.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { expect, test } from "./helpers";

type Answer = { status: number; body: string };

/** One raw request to the app's server, with headers a browser API would not let us set. */
function raw(baseURL: string, headers: Record<string, string>, path = "/__backend"): Promise<Answer> {
  const url = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 101, body: "" });
    });
    req.on("error", reject);
    req.end();
  });
}

const UPGRADE = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

test.describe("the production server's address and origin checks", () => {
  test("refuses a name it does not answer to, and says which variable allows one", async ({ baseURL }) => {
    const answer = await raw(baseURL!, { Host: "evil.example" });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("TEAMS_LITE_ALLOWED_HOSTS");
  });

  test("refuses another site's page a socket", async ({ baseURL }) => {
    const host = new URL(baseURL!).host;
    const answer = await raw(baseURL!, { ...UPGRADE, Host: host, Origin: "https://evil.example" });
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("TEAMS_LITE_ALLOWED_ORIGINS");
  });

  test("lets the app's own page open one", async ({ baseURL }) => {
    const host = new URL(baseURL!).host;
    const answer = await raw(baseURL!, { ...UPGRADE, Host: host, Origin: new URL(baseURL!).origin });
    expect(answer.status).toBe(101);
  });

  test("relays a socket on the backend's route and on no other path", async ({ baseURL }) => {
    // The paths the chart's sign-in lets through with no session (the manifest, an icon, the
    // favicon — `--skip-auth-route` in templates/statefulset.yaml), plus the root. oauth2-proxy
    // matches those by method and path and forwards an upgrade, so a relay that took a socket on
    // any path handed a read socket to anybody who could reach the hostname. No Origin, because
    // that is what a script sends — and the allowed Host, because that is what reaches the relay.
    const host = new URL(baseURL!).host;
    for (const path of ["/manifest.webmanifest", "/icons/icon-192.png", "/favicon.ico", "/", "/__backend/"]) {
      const answer = await raw(baseURL!, { ...UPGRADE, Host: host }, path);
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toContain("/__backend");
    }
    // The control: the same request on the route itself is relayed, so the 404s above are the path
    // and nothing else.
    expect((await raw(baseURL!, { ...UPGRADE, Host: host })).status).toBe(101);
  });

  test("refuses the handshake while the backend is down, rather than opening a socket and dropping it", async () => {
    // A second production server whose backend is gone: nothing listens on port 9 (discard). Had it
    // accepted the page's socket first, the page would see each attempt OPEN and reset its backoff —
    // redialling every 500 ms and never saying the backend is lost (`openUpstream` in web/server.ts).
    const server = spawn("bun", ["server.ts"], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        TEAMS_LITE_WS_URL: "ws://127.0.0.1:9",
        TEAMS_LITE_ALLOW_PINNED_BUILD: "1",
        TEAMS_LITE_WRITE_TOKEN: "e2e-stand-in-not-a-real-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const baseURL = await new Promise<string>((resolve, reject) => {
        let out = "";
        server.stdout!.on("data", (chunk) => {
          out += chunk;
          const url = out.match(/serving on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          if (url) resolve(url);
        });
        server.on("exit", (code) => reject(new Error(`the server exited ${code}: ${out}`)));
      });
      const host = new URL(baseURL).host;
      const answer = await raw(baseURL, { ...UPGRADE, Host: host, Origin: new URL(baseURL).origin });
      expect(answer.status).toBe(502);
    } finally {
      server.kill();
    }
  });
});

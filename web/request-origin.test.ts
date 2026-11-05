import { describe, expect, it } from "vitest";
import {
  ALLOWED_HOSTS_ENV,
  ALLOWED_ORIGINS_ENV,
  hostIsBuiltIn,
  hostVerdict,
  parseAuthority,
  policyFromEnv,
  requestAuthorities,
  upgradeVerdict,
  type HeaderReader,
} from "./request-origin";

/** A header reader over a plain object, case-insensitively — what both servers hand the policy. */
function headers(values: Record<string, string>): HeaderReader {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower[name.toLowerCase()];
}

const NONE = policyFromEnv({});

describe("the names this app answers to without being told", () => {
  it("are loopback names, IP literals and tailnet names", () => {
    for (const name of ["localhost", "app.localhost", "127.0.0.1", "10.42.0.7", "[::1]", "[fd7a:115c::1]"]) {
      expect(hostIsBuiltIn(name), name).toBe(true);
    }
    expect(hostIsBuiltIn("theophile-remote.taild26c06.ts.net")).toBe(true);
  });

  it("are never a name an attacker could point at this machine", () => {
    for (const name of ["evil.example", "localhost.evil.example", "ts.net.evil.example", "teams.example.com"]) {
      expect(hostIsBuiltIn(name), name).toBe(false);
    }
  });
});

describe("an authority", () => {
  it("splits into a hostname and an optional port, IPv6 included", () => {
    expect(parseAuthority("Teams.Example.com:8443")).toEqual({ hostname: "teams.example.com", port: "8443" });
    expect(parseAuthority("teams.example.com.")).toEqual({ hostname: "teams.example.com", port: null });
    expect(parseAuthority("[::1]:19440")).toEqual({ hostname: "[::1]", port: "19440" });
    expect(parseAuthority("[::1]")).toEqual({ hostname: "[::1]", port: null });
  });

  it("is refused when it is not one", () => {
    for (const raw of ["", "a b", "evil.example/x", "user@host", "::1", "host:port", "[::1", "[::1]x"]) {
      expect(parseAuthority(raw), raw).toBeNull();
    }
  });
});

describe("the Host check (DNS rebinding)", () => {
  it("answers this machine's own names", () => {
    expect(hostVerdict(headers({ host: "127.0.0.1:19440" }), NONE).ok).toBe(true);
    expect(hostVerdict(headers({ host: "localhost:19443" }), NONE).ok).toBe(true);
    expect(hostVerdict(headers({ host: "theophile-remote.taild26c06.ts.net:8443" }), NONE).ok).toBe(true);
  });

  it("refuses a name nobody configured, and names the variable that would allow it", () => {
    const verdict = hostVerdict(headers({ host: "evil.example:19440" }), NONE);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("the name evil.example.");
      expect(verdict.reason).toContain(ALLOWED_HOSTS_ENV);
    }
  });

  it("answers a configured name, and a leading dot covers its subdomains", () => {
    const policy = policyFromEnv({ [ALLOWED_HOSTS_ENV]: "teams.example.com, .corp.example" });
    expect(hostVerdict(headers({ host: "teams.example.com" }), policy).ok).toBe(true);
    expect(hostVerdict(headers({ host: "corp.example" }), policy).ok).toBe(true);
    expect(hostVerdict(headers({ host: "a.b.corp.example" }), policy).ok).toBe(true);
    expect(hostVerdict(headers({ host: "notcorp.example" }), policy).ok).toBe(false);
    expect(hostVerdict(headers({ host: "evil.teams.example.com" }), policy).ok).toBe(false);
  });

  it("reads Host ALONE: a forwarded name is a header any page's fetch may set", () => {
    // After DNS rebinding, a same-origin fetch can name 127.0.0.1 in X-Forwarded-Host or Forwarded
    // while its Host names the attacker — no preflight, no forbidden header. Neither may admit it.
    for (const forged of [{ "x-forwarded-host": "127.0.0.1" }, { forwarded: "host=localhost" }]) {
      expect(hostVerdict(headers({ host: "evil.example:19440", ...forged }), NONE).ok).toBe(false);
    }
    // A proxy that rewrites Host to our own address still passes: addresses are built in.
    expect(hostVerdict(headers({ host: "127.0.0.1:19443", "x-forwarded-host": "teams.example.com" }), NONE).ok).toBe(
      true,
    );
    expect(
      requestAuthorities(headers({ host: "a", forwarded: 'for=1.2.3.4;host="b:443";proto=https, host=c' })),
    ).toEqual(["a", "b:443", "c"]);
  });

  it("matches an entry written with a port, which is what the refusal page shows", () => {
    const refused = hostVerdict(headers({ host: "mybox.lan:19443" }), NONE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("mybox.lan — the name alone, no port");
    const policy = policyFromEnv({ [ALLOWED_HOSTS_ENV]: "mybox.lan:19443, .Corp.Example:443" });
    expect(hostVerdict(headers({ host: "mybox.lan:19443" }), policy).ok).toBe(true);
    expect(hostVerdict(headers({ host: "a.corp.example" }), policy).ok).toBe(true);
  });

  it("answers to the name the server itself was told to bind", () => {
    const policy = policyFromEnv({}, ["mybox.lan", undefined, ""]);
    expect(hostVerdict(headers({ host: "mybox.lan:19440" }), policy).ok).toBe(true);
    expect(hostVerdict(headers({ host: "evil.example:19440" }), policy).ok).toBe(false);
  });

  it("is off with `*`, for whoever really wants that", () => {
    expect(hostVerdict(headers({ host: "anything.example" }), policyFromEnv({ [ALLOWED_HOSTS_ENV]: "*" })).ok).toBe(
      true,
    );
  });
});

describe("the socket's Origin check (cross-site WebSocket hijacking)", () => {
  it("lets the app's own page in, however it was reached", () => {
    expect(upgradeVerdict(headers({ host: "127.0.0.1:19440", origin: "http://127.0.0.1:19440" }), NONE).ok).toBe(true);
    // tailscale serve: the default HTTPS port in the Origin, and an explicit one in the Host.
    expect(
      upgradeVerdict(
        headers({ host: "box.tail1.ts.net:8443", origin: "https://box.tail1.ts.net:8443" }),
        NONE,
      ).ok,
    ).toBe(true);
    const policy = policyFromEnv({ [ALLOWED_HOSTS_ENV]: "teams.example.com" });
    expect(upgradeVerdict(headers({ host: "teams.example.com", origin: "https://teams.example.com" }), policy).ok).toBe(
      true,
    );
    expect(
      upgradeVerdict(headers({ host: "teams.example.com:443", origin: "https://teams.example.com" }), policy).ok,
    ).toBe(true);
    // A proxy that rewrote Host to our own address and kept the public name in X-Forwarded-Host.
    expect(
      upgradeVerdict(
        headers({ host: "127.0.0.1:19443", "x-forwarded-host": "teams.example.com", origin: "https://teams.example.com" }),
        policy,
      ).ok,
    ).toBe(true);
  });

  it("refuses another site's page — on loopback, on the tailnet, and behind a sign-in wall", () => {
    for (const host of ["127.0.0.1:19440", "box.tail1.ts.net:8443", "teams.example.com"]) {
      const verdict = upgradeVerdict(
        headers({ host, origin: "https://evil.example" }),
        policyFromEnv({ [ALLOWED_HOSTS_ENV]: "teams.example.com" }),
      );
      expect(verdict.ok, host).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(ALLOWED_ORIGINS_ENV);
    }
  });

  it("refuses another port and another scheme on the same name: those are other origins", () => {
    expect(upgradeVerdict(headers({ host: "127.0.0.1:19440", origin: "http://127.0.0.1:8080" }), NONE).ok).toBe(false);
    expect(upgradeVerdict(headers({ host: "box.tail1.ts.net", origin: "http://box.tail1.ts.net" }), NONE).ok).toBe(
      true,
    );
    expect(upgradeVerdict(headers({ host: "box.tail1.ts.net:443", origin: "http://box.tail1.ts.net" }), NONE).ok).toBe(
      false,
    );
  });

  it("refuses a tailnet page that is not THIS one, though its name is a built-in", () => {
    // Somebody else's Funnel is on .ts.net too: an allowed NAME is not an allowed ORIGIN.
    expect(
      upgradeVerdict(headers({ host: "box.tail1.ts.net:8443", origin: "https://evil.tail9.ts.net" }), NONE).ok,
    ).toBe(false);
  });

  it("refuses the opaque origin a sandboxed frame or a data: page sends", () => {
    expect(upgradeVerdict(headers({ host: "127.0.0.1:19440", origin: "null" }), NONE).ok).toBe(false);
    expect(upgradeVerdict(headers({ host: "127.0.0.1:19440", origin: "file://" }), NONE).ok).toBe(false);
  });

  it("accepts no Origin at all, which is not a browser", () => {
    expect(upgradeVerdict(headers({ host: "127.0.0.1:19420" }), NONE).ok).toBe(true);
  });

  it("still refuses an address nobody configured, before it looks at the Origin", () => {
    expect(upgradeVerdict(headers({ host: "evil.example:19440", origin: "http://evil.example:19440" }), NONE).ok).toBe(
      false,
    );
  });

  it("accepts an origin named outright, for a proxy that forwards no name", () => {
    const policy = policyFromEnv({ [ALLOWED_ORIGINS_ENV]: "https://Teams.Example.com:443/" });
    expect(upgradeVerdict(headers({ host: "127.0.0.1:19443", origin: "https://teams.example.com" }), policy).ok).toBe(
      true,
    );
  });
});

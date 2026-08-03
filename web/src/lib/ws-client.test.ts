// Behavior tests for the Backend WebSocket client. No real network is used: a
// FakeWebSocket is injected via globalThis.WebSocket and driven synchronously by
// the test, and fake timers make the reconnect backoff deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Backend, backendUrlForPage, needsRelay } from "./ws-client";

type WsEvent = { data?: unknown };

/** Minimal WebSocket stand-in the test can open/message/close by hand. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }

  readonly url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev?: WsEvent) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: WsEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  // The app calls close() on teardown after nulling handlers, so this only
  // flips state — it must NOT re-fire onclose (that would loop reconnects).
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }
  // The browser hands onerror an opaque Event with no failure detail; mirror
  // that here by passing a bare object rather than an Error.
  simulateError(): void {
    this.onerror?.({});
  }
  simulateClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }
}

let originalWebSocket: typeof globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(0);
  FakeWebSocket.reset();
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
});

/** Create a Backend and drive its first socket to the OPEN state. */
async function connected(opts?: ConstructorParameters<typeof Backend>[1]): Promise<{
  backend: Backend;
  socket: FakeWebSocket;
}> {
  const backend = new Backend("ws://test", opts);
  const promise = backend.connect();
  const socket = FakeWebSocket.last();
  socket.simulateOpen();
  await promise;
  return { backend, socket };
}

describe("Backend connect", () => {
  it("resolves connect() when the socket opens", async () => {
    const backend = new Backend("ws://test");
    const promise = backend.connect();

    expect(backend.connected).toBe(false);
    FakeWebSocket.last().simulateOpen();
    await expect(promise).resolves.toBeUndefined();
    expect(backend.connected).toBe(true);

    backend.close();
  });

  it("rejects connect() with a readable message when the socket errors", async () => {
    const backend = new Backend("ws://test");
    const promise = backend.connect();

    FakeWebSocket.last().simulateError();

    // Not the opaque Event that would render as "[object Event]".
    await expect(promise).rejects.toThrow("could not connect to ws://test");

    backend.close();
  });
});

describe("Backend request/response", () => {
  it("sends a framed {id,method,params} and resolves on the matching result", async () => {
    const { backend, socket } = await connected();

    const promise = backend.open("c1");

    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!) as {
      id: number;
      method: string;
      params?: { conversation?: string };
    };
    expect(frame.method).toBe("open");
    expect(frame.params).toEqual({ conversation: "c1" });
    expect(typeof frame.id).toBe("number");

    socket.simulateMessage(JSON.stringify({ id: frame.id, result: { messages: [], has_more: false } }));

    await expect(promise).resolves.toEqual({ messages: [], has_more: false });
    backend.close();
  });

  it("rejects a request when the response carries an error", async () => {
    const { backend, socket } = await connected();

    const promise = backend.open("c1");
    const frame = JSON.parse(socket.sent[0]!) as { id: number };
    socket.simulateMessage(JSON.stringify({ id: frame.id, error: "no such conversation" }));

    await expect(promise).rejects.toThrow("no such conversation");
    backend.close();
  });

  it("frames a send request with raw image data and dimensions", async () => {
    const { backend, socket } = await connected();

    const promise = backend.send("c1", "caption", undefined, undefined, {
      name: "capture.png",
      contentType: "image/png",
      width: 640,
      height: 480,
      dataBase64: "aGVsbG8=",
    });

    const frame = JSON.parse(socket.sent[0]!) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    expect(frame.method).toBe("send");
    expect(frame.params).toEqual({
      conversation: "c1",
      text: "caption",
      image: {
        name: "capture.png",
        content_type: "image/png",
        width: 640,
        height: 480,
        data_base64: "aGVsbG8=",
      },
    });

    socket.simulateMessage(JSON.stringify({ id: frame.id, result: { sent: true } }));
    await expect(promise).resolves.toEqual({ sent: true });
    backend.close();
  });

  it("frames a react request with conversation, message_id and key", async () => {
    const { backend, socket } = await connected();

    const promise = backend.react("c1", "c1#5", "heart");

    const frame = JSON.parse(socket.sent[0]!) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    expect(frame.method).toBe("react");
    expect(frame.params).toEqual({ conversation: "c1", message_id: "c1#5", key: "heart" });

    socket.simulateMessage(JSON.stringify({ id: frame.id, result: { reacted: true } }));
    await expect(promise).resolves.toEqual({ reacted: true });
    backend.close();
  });

  // mark_read publishes the user's read position to Teams, so it must travel as a
  // WRITE: the backend refuses it without the capability token, exactly like a send.
  it("frames mark_read as a write, carrying the write token", async () => {
    const { backend, socket } = await connected();
    backend.setWriteToken("tok");

    const promise = backend.markRead("c1");

    const frame = JSON.parse(socket.sent[0]!) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    expect(frame.method).toBe("mark_read");
    expect(frame.params).toEqual({ conversation: "c1", write_token: "tok" });

    socket.simulateMessage(
      JSON.stringify({ id: frame.id, result: { read: true, ghost: false } }),
    );
    await expect(promise).resolves.toEqual({ read: true, ghost: false });
    backend.close();
  });

  // "Always available" publishes the user's own status to Teams, where every
  // colleague reads it, so it travels as a WRITE in both directions — turning it off
  // is the same outward call as turning it on.
  it("frames set_always_available as a write, carrying the write token", async () => {
    for (const enabled of [true, false]) {
      const { backend, socket } = await connected();
      backend.setWriteToken("tok");

      const promise = backend.setAlwaysAvailable(enabled);

      const frame = JSON.parse(socket.sent[0]!) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      expect(frame.method).toBe("set_always_available");
      expect(frame.params).toEqual({ enabled, write_token: "tok" });

      socket.simulateMessage(
        JSON.stringify({
          id: frame.id,
          result: {
            gitlab_host: "gitlab.com",
            gitlab_token_set: false,
            linear_token_set: false,
            ghost_mode: false,
            always_available: enabled,
          },
        }),
      );
      await expect(promise).resolves.toMatchObject({ always_available: enabled });
      backend.close();
    }
  });

  // Choosing a provider decides which program the backend's machine starts for a chat
  // message, and which model reads the thread, so it travels as a WRITE — the backend
  // refuses it without the capability token (MACHINE_METHODS in src/bin/server.rs).
  it("frames agent_set_provider as a write, carrying the write token", async () => {
    const { backend, socket } = await connected();
    backend.setWriteToken("tok");

    const promise = backend.agentSetProvider("claude", { enabled: false, model: "opus" });

    const frame = JSON.parse(socket.sent[0]!) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    expect(frame.method).toBe("agent_set_provider");
    expect(frame.params).toEqual({
      provider: "claude",
      enabled: false,
      model: "opus",
      write_token: "tok",
    });

    socket.simulateMessage(
      JSON.stringify({
        id: frame.id,
        result: {
          backends: [
            {
              name: "claude",
              prefix: "@claude",
              available: true,
              enabled: false,
              model: "opus",
              models: ["opus"],
            },
          ],
          conversations: [],
          tools: ["Read"],
          workspace: "/tmp",
          enabled: true,
          sandbox_conversation: "19:sandbox@thread.v2",
        },
      }),
    );
    await expect(promise).resolves.toMatchObject({
      backends: [{ name: "claude", enabled: false, model: "opus" }],
    });
    backend.close();
  });

  it("frames a fetch_avatar request with kind and id, resolving the photo result", async () => {
    const { backend, socket } = await connected();

    const promise = backend.fetchAvatar("team", "group-guid");

    const frame = JSON.parse(socket.sent[0]!) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    expect(frame.method).toBe("fetch_avatar");
    expect(frame.params).toEqual({ kind: "team", id: "group-guid" });

    socket.simulateMessage(
      JSON.stringify({
        id: frame.id,
        result: { found: true, content_type: "image/jpeg", data_base64: "AAAA" },
      }),
    );
    await expect(promise).resolves.toEqual({
      found: true,
      content_type: "image/jpeg",
      data_base64: "AAAA",
    });
    backend.close();
  });

  it("resolves fetch_avatar with found=false when the subject has no photo", async () => {
    const { backend, socket } = await connected();
    const promise = backend.fetchAvatar("user", "8:orgid:nobody");
    const frame = JSON.parse(socket.sent[0]!) as { id: number };
    socket.simulateMessage(JSON.stringify({ id: frame.id, result: { found: false } }));
    await expect(promise).resolves.toEqual({ found: false });
    backend.close();
  });

  it("rejects immediately when not connected", async () => {
    const backend = new Backend("ws://test");
    await expect(backend.open("c1")).rejects.toThrow("not connected");
    backend.close();
  });
});

describe("Backend events", () => {
  it("dispatches incoming {event,data} frames and honors unsubscribe", async () => {
    const { backend, socket } = await connected();
    const received: unknown[] = [];

    const off = backend.on("presence", (data) => received.push(data));
    socket.simulateMessage(JSON.stringify({ event: "presence", data: { status: "online" } }));
    expect(received).toEqual([{ status: "online" }]);

    off();
    socket.simulateMessage(JSON.stringify({ event: "presence", data: { status: "away" } }));
    expect(received).toEqual([{ status: "online" }]);

    backend.close();
  });

  it("ignores malformed frames without throwing", async () => {
    const { backend, socket } = await connected();
    const received: unknown[] = [];
    backend.on("presence", (data) => received.push(data));

    expect(() => socket.simulateMessage("not json")).not.toThrow();
    expect(received).toEqual([]);

    backend.close();
  });
});

describe("Backend reconnect", () => {
  it("schedules a reconnect after the socket closes", () => {
    const backend = new Backend("ws://test", { giveUpMs: 10_000, initialDelayMs: 50, maxDelayMs: 100 });
    backend.connect().catch(() => {});

    const first = FakeWebSocket.last();
    first.simulateClose();

    // No new socket yet — a reconnect is pending behind the backoff timer.
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last()).not.toBe(first);

    backend.close();
  });

  it("emits backend_lost once the give-up window elapses", () => {
    const backend = new Backend("ws://test", { giveUpMs: 1000, initialDelayMs: 10, maxDelayMs: 100 });
    let lost = 0;
    backend.on("backend_lost", () => {
      lost += 1;
    });
    backend.connect().catch(() => {});

    // Drive the retry loop: close, let the backoff timer fire a new socket, repeat.
    let guard = 0;
    while (lost === 0 && guard < 100) {
      guard += 1;
      FakeWebSocket.last().simulateClose();
      if (lost > 0) break;
      vi.advanceTimersByTime(100);
    }

    expect(lost).toBe(1);
    expect(guard).toBeLessThan(100);
    backend.close();
  });

  it("emits a disconnected event on every close", async () => {
    const { backend, socket } = await connected({ giveUpMs: 10_000, initialDelayMs: 50 });
    let disconnects = 0;
    backend.on("disconnected", () => {
      disconnects += 1;
    });

    socket.simulateClose();
    expect(disconnects).toBe(1);

    backend.close();
  });

  it("emits reconnected on a reopen but stays silent on the first connect", async () => {
    const backend = new Backend("ws://test", { giveUpMs: 10_000, initialDelayMs: 50 });
    let reconnects = 0;
    backend.on("reconnected", () => {
      reconnects += 1;
    });

    // First open: this is the initial connect, not a recovery.
    const promise = backend.connect();
    FakeWebSocket.last().simulateOpen();
    await promise;
    expect(reconnects).toBe(0);

    // Drop, let the backoff fire a fresh socket, and open it — now it's a reopen.
    FakeWebSocket.last().simulateClose();
    vi.advanceTimersByTime(50);
    FakeWebSocket.last().simulateOpen();
    expect(reconnects).toBe(1);

    backend.close();
  });
});

describe("backendUrlForPage", () => {
  it("keeps the page's own host, so a remote device reaches this machine's backend", () => {
    // The point of going through the page's origin: on a phone opening the app
    // over Tailscale, ws://127.0.0.1:19420 would be the phone itself.
    expect(backendUrlForPage({ protocol: "http:", host: "theophile-remote:19440" })).toBe(
      "ws://theophile-remote:19440/__backend",
    );
  });

  it("upgrades to wss on an https page (a plaintext ws:// would be refused)", () => {
    expect(backendUrlForPage({ protocol: "https:", host: "host.ts.net:8443" })).toBe(
      "wss://host.ts.net:8443/__backend",
    );
  });

  it("has no answer without a real page (SSR, or a non-http origin)", () => {
    expect(backendUrlForPage(null)).toBeNull();
    expect(backendUrlForPage(undefined)).toBeNull();
    expect(backendUrlForPage({ protocol: "http:", host: "" })).toBeNull();
    expect(backendUrlForPage({ protocol: "file:", host: "" })).toBeNull();
  });
});

describe("needsRelay", () => {
  it("is true only for a loopback backend seen from another device", () => {
    expect(needsRelay("ws://127.0.0.1:19420", { hostname: "theophile-remote.ts.net" })).toBe(true);
    expect(needsRelay("ws://localhost:19420", { hostname: "100.80.26.90" })).toBe(true);
  });

  it("leaves a page on this machine talking to the backend directly", () => {
    expect(needsRelay("ws://127.0.0.1:19420", { hostname: "localhost" })).toBe(false);
    expect(needsRelay("ws://127.0.0.1:19420", { hostname: "127.0.0.1" })).toBe(false);
  });

  it("never redirects a backend that is already remote — the mock stays the mock", () => {
    // A configured non-loopback backend was named on purpose; relaying it would
    // quietly retarget the page at whatever the serving host proxies to.
    expect(needsRelay("ws://mock.internal:19455", { hostname: "theophile-remote.ts.net" })).toBe(
      false,
    );
    expect(needsRelay("not a url", { hostname: "theophile-remote.ts.net" })).toBe(false);
  });

  it("has nothing to decide without a page (SSR)", () => {
    expect(needsRelay("ws://127.0.0.1:19420", null)).toBe(false);
    expect(needsRelay("ws://127.0.0.1:19420", { hostname: "" })).toBe(false);
  });
});

describe("Backend retryNow", () => {
  it("reconnects after the give-up window, the way a woken phone tab needs", () => {
    const backend = new Backend("ws://test", { giveUpMs: 1000, initialDelayMs: 10, maxDelayMs: 100 });
    let lost = 0;
    backend.on("backend_lost", () => {
      lost += 1;
    });
    backend.connect().catch(() => {});

    // Exhaust the backoff: retries stop and nothing opens a socket any more.
    let guard = 0;
    while (lost === 0 && guard < 100) {
      guard += 1;
      FakeWebSocket.last().simulateClose();
      if (lost > 0) break;
      vi.advanceTimersByTime(100);
    }
    const exhausted = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(exhausted);

    // A tab coming back to the foreground gets a real attempt, not the banner.
    backend.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(exhausted + 1);
    FakeWebSocket.last().simulateOpen();
    expect(backend.connected).toBe(true);

    // And the fresh window is back: a later drop schedules a retry again.
    FakeWebSocket.last().simulateClose();
    vi.advanceTimersByTime(10);
    expect(FakeWebSocket.instances).toHaveLength(exhausted + 2);

    backend.close();
  });

  it("does nothing while connected, or once closed", async () => {
    const { backend } = await connected();
    backend.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(1);

    backend.close();
    backend.retryNow();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

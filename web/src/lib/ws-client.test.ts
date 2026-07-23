// Behavior tests for the Backend WebSocket client. No real network is used: a
// FakeWebSocket is injected via globalThis.WebSocket and driven synchronously by
// the test, and fake timers make the reconnect backoff deterministic.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Backend } from "./ws-client";

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
});

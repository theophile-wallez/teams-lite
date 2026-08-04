// The last step of an in-app update: put the app back up on the build that was just
// installed.
//
// The backend owns everything before this. It found the release, downloaded it, checked
// it, and renamed it over this binary (see src/update.rs) — all of which it can do while
// the app keeps running, because a rename leaves every running process on the inode it
// started from. What it cannot do is restart the app: the web server runs inside THIS
// process and the backend is our child, so we are the only process that can take both
// down and bring both back. It therefore asks, on the keepalive socket it already has
// from us, with one `update_restart` event.
//
// The order below is the whole of it, and every step is load-bearing:
//
//   1. Stop the web server. Its port is the one the new process binds first, and a
//      listener that is still up when the new one starts makes it exit on EADDRINUSE —
//      which would leave the user with no app at all rather than an updated one.
//   2. Kill the backend child, whose port the new process binds too. It is ours; the
//      new one spawns its own.
//   3. Spawn the new build, detached, from the same path with the same arguments plus
//      `--no-open`: the user already has the page open, and it reconnects on its own.
//   4. Exit. Not before the spawn, or nothing starts; not long after it, or two
//      launchers race for the ports.
//
// A dev run (`bun run`) is refused rather than handled: `process.execPath` is bun there,
// the argv carries a script path, and nothing was installed anyway.

import { spawn } from "bun";
import { isCompiledBinary } from "./backend";

/** What one relaunch needs from the caller, so the sequence itself stays testable. */
export type RelaunchDeps = {
  /** Stop the in-process web server (`server.stop(true)` — closes live sockets too). */
  stopWeb: () => void;
  /** Kill the backend child we spawned, and resolve once it is really gone (see
   *  `BackendHandle.waitForExit`): its port has to be free before the new build looks. */
  stopBackend: () => Promise<void>;
  /** The binary to start: the just-replaced `teams`. */
  execPath: string;
  /** Its arguments, without the executable itself. */
  args: string[];
  /** Start the new build, detached from this process. */
  start: (command: string[]) => void;
  /** End this process, once the new one is on its way. */
  exit: () => void;
  /** Where a step that fails says so. */
  log: (message: string) => void;
};

/**
 * The arguments the new process is started with: ours, plus `--no-open`, and never a
 * second copy of it.
 *
 * `--no-open` is the difference between a seamless update and a surprise: the user is
 * looking at the page right now, and opening a second tab on top of it would say the app
 * restarted louder than the reconnect itself does. `--dev` is dropped for the same reason
 * it is refused above — a compiled binary cannot serve the Vite sources.
 */
export function relaunchArgs(args: string[]): string[] {
  const kept = args.filter((arg) => arg !== "--no-open" && arg !== "--open");
  return [...kept, "--no-open"];
}

/**
 * Restart this app onto the build the backend just installed.
 *
 * Every step is injected so the sequence — stop the listeners, then spawn, then exit —
 * is pinned by a test rather than by reading it. Returns nothing: by the time it is done
 * this process is on its way out.
 */
export async function relaunch(deps: RelaunchDeps): Promise<void> {
  deps.log("[update] restarting onto the new build…");
  // Both stops are best-effort: a listener that is already gone is not a reason to
  // strand the user on the old build, and the spawn below is what actually matters.
  try {
    deps.stopWeb();
  } catch (e) {
    deps.log(`[update] could not stop the web server: ${String(e)}`);
  }
  try {
    // AWAITED, unlike the web server's synchronous stop: a signalled process still holds
    // its port for a moment, and the new build would attach to the backend we just killed.
    await deps.stopBackend();
  } catch (e) {
    deps.log(`[update] could not stop the backend: ${String(e)}`);
  }

  try {
    deps.start([deps.execPath, ...relaunchArgs(deps.args)]);
  } catch (e) {
    // Nothing started, and our own listeners are down. Say what happened and leave the
    // process to exit: the new build is installed, so the user's next `teams` is on it.
    deps.log(
      `[update] could not start the new build (${String(e)}). It is installed — run \`teams\` again.`,
    );
  }
  deps.exit();
}

/**
 * Wire the backend's `update_restart` event to the relaunch, for a real run.
 *
 * The event carries the binary the backend replaced, and we check it against our own
 * `execPath` before acting: this socket is a local one that anything on the machine can
 * open a frame on, and "restart yourself" is worth confirming is about us. It is not the
 * gate that protects the machine — that is the write token on the RPC that emits this —
 * it is the one that keeps a stray frame from restarting an app nobody updated.
 */
export function handleBackendEvent(
  raw: unknown,
  deps: Omit<RelaunchDeps, "execPath" | "args"> & { execPath: string; args: string[] },
): void {
  if (typeof raw !== "string") return;
  let frame: { event?: unknown; data?: { binary?: unknown } };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return;
  }
  if (frame.event !== "update_restart") return;
  if (!isCompiledBinary()) {
    deps.log("[update] not restarting: this is a source run, and nothing was installed.");
    return;
  }
  const binary = frame.data?.binary;
  if (typeof binary !== "string" || binary !== deps.execPath) {
    deps.log(`[update] ignoring an apply for ${String(binary)} — this process runs ${deps.execPath}`);
    return;
  }
  // Not awaited: this is a socket handler, and the relaunch ends in `process.exit`. A
  // rejection can only come from `log` itself, so it is reported rather than swallowed.
  void relaunch(deps).catch((e) => deps.log(`[update] the restart failed: ${String(e)}`));
}

/** Start `command` detached, so it outlives this process. */
export function spawnDetached(command: string[]): void {
  const child = spawn(command, {
    // The same terminal, when there is one: a user who ran `teams` in a shell keeps
    // seeing the app's output where they expect it.
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  // Bun ties a child's lifetime to this process only through the handlers we install
  // ourselves (see killChildOnExit in backend.ts); unref'ing states the intent — this
  // one must survive us.
  child.unref();
}

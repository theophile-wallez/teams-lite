// Restarting the BACKEND alone, when it asks — Settings › This app.
//
// It is the small sibling of src/update.ts. That one puts the whole app back up on a new
// build: web server down, backend down, new process, this one exits. This one replaces the
// backend child and nothing else, because nothing else is wrong — the user pressed
// "Restart the backend" for a process that answers reads and has stopped doing something
// else, and the narrowest thing that mends it is a fresh backend.
//
// Two consequences make the narrow shape worth its own module:
//
//   * **Our web server never stops.** The page stays served; its socket drops and its own
//     reconnect brings it back, which is a state the app already draws for every other
//     restart on this machine.
//   * **The new child keeps the pinned write token** (see `BackendHandle.restart`), so the
//     token the page holds is still the one the new backend gates writes on. A fresh token
//     would leave every send refused until somebody reloaded.
//
// The backend asks on the keepalive socket it already has from us (`backend_restart`,
// emitted by `Ctx::restart_backend`). It is a local socket that anything on this machine can
// open a frame on, so the frame is checked against the child we actually own — by PORT,
// which is what tells this machine's backends apart, exactly as an update's frame is checked
// against our own `execPath`. That check is not the gate protecting the machine: the write
// token on the RPC that emits this is (`MACHINE_METHODS` in src/bin/server.rs). It is the
// one that keeps a stray frame from restarting a backend nobody asked about.

/** What one backend restart needs from the caller, so the sequence stays testable. */
export type BackendRestartDeps = {
  /** Stop the backend child and start a new one, resolving once it is listening
   *  (`BackendHandle.restart`). */
  restart: () => Promise<void>;
  /** The port our own backend child binds — the frame has to name it. */
  port: number;
  /** Where a step that fails says so. */
  log: (message: string) => void;
};

/**
 * Handle one frame off the keepalive socket, and ignore every frame that is not this event.
 *
 * Not awaited by its caller (a socket handler), so a failure is reported here rather than
 * left as an unhandled rejection: a restart that could not bring the backend back is the
 * one thing whoever ran the command has to be able to read afterwards.
 */
export function handleBackendRestartEvent(raw: unknown, deps: BackendRestartDeps): void {
  if (typeof raw !== "string") return;
  let frame: { event?: unknown; data?: { port?: unknown } };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return;
  }
  if (frame.event !== "backend_restart") return;

  const port = frame.data?.port;
  if (typeof port !== "number" || port !== deps.port) {
    deps.log(
      `[restart] ignoring a restart for backend ${String(port)} — this launcher owns ${deps.port}`,
    );
    return;
  }

  deps.log("[restart] restarting the backend…");
  void deps
    .restart()
    .then(() => deps.log("[restart] the backend is back up."))
    // Everything that can go wrong ends here: a backend we only ATTACHED to (not ours to
    // restart), or a new child that never bound the port. The app keeps serving its page
    // either way, which is why this is a line and not an exit.
    .catch((e: unknown) => deps.log(`[restart] the backend did not come back: ${String(e)}`));
}

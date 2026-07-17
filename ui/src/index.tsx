// teams-lite — entry point. Mount the UI immediately (so the splash shows at
// once), then let the App bring up the backend and connect.
//
// We pass `onDestroy` so the process actually EXITS whenever OpenTUI tears the
// renderer down. OpenTUI registers handlers for every exit signal (SIGINT,
// SIGTERM, SIGHUP, …) that call renderer.destroy() but NOT process.exit() — it
// relies on the event loop draining to end the process. If anything keeps the
// loop alive (e.g. a reconnect timer), the process survives the signal, loses
// its terminal, gets reparented to systemd --user, and lingers as a background
// CPU spinner. Exiting from onDestroy (which runs at the end of destroy, after
// the terminal is restored — so it doesn't race teardown) makes closing the
// terminal window, Ctrl+C, or a kill all reliably end the process.
import { render } from "@opentui/solid";
import { App } from "./app";

await render(() => <App />, {
  onDestroy: () => process.exit(0),
});

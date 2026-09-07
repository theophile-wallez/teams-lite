import { createFileRoute } from "@tanstack/react-router";

// THE THREADS view, addressed by the "/threads" URL. Like the settings and conversation routes
// this renders nothing directly — the persistent shell in `_app` detects the route and swaps
// the detail pane for the threads pane, so the sidebar (and the backend socket + every cache)
// stay mounted across the switch.
//
// It is a ROUTE rather than a piece of state for the three reasons every page in this app is
// one: it survives a reload, it can be sent to somebody, and the browser's own Back leaves it.
export const Route = createFileRoute("/_app/threads")({
  component: () => null,
});

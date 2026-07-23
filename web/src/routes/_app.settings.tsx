import { createFileRoute } from "@tanstack/react-router";

// The settings surface, addressed by the "/settings" URL. Like the conversation
// routes this renders nothing directly — the persistent shell in `_app` detects
// the settings route and swaps the message pane for the settings pane, so the
// sidebar (and the backend socket + caches) stay mounted across the switch.
export const Route = createFileRoute("/_app/settings")({
  component: () => null,
});

import { createFileRoute } from "@tanstack/react-router";
import { App } from "~/components/app";

// Pathless layout route. It owns the persistent application shell (the
// ControllerProvider that holds the single backend WebSocket, the sidebar, the
// message pane, and the status bar). Both `/` and `/c/$conversationId` render
// underneath it, so navigating between conversations never remounts the shell —
// the socket and in-memory caches survive route changes. The shell reads the
// active conversation id from the URL and drives the controller from it.
export const Route = createFileRoute("/_app")({
  component: App,
});

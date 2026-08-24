import { createFileRoute } from "@tanstack/react-router";

// The conversation itself: `/c/<conversation-id>`.
//
// It renders nothing, like every other route here — the shell in `_app` reads the id from the
// URL and opens the thread through the controller, so the message pane and its scroll survive
// every move between conversations.
export const Route = createFileRoute("/_app/c/$conversationId/")({
  component: () => null,
});

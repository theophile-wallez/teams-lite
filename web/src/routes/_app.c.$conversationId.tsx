import { createFileRoute } from "@tanstack/react-router";

// A single open conversation, addressed by its id in the URL path
// (`/c/<conversation-id>`). The id is a Teams thread id such as
// `19:...@thread.v2`; TanStack Router escapes it with encodeURIComponent on the
// way out and decodes it on the way in, so it round-trips safely.
//
// Like the index route this renders nothing directly — the persistent shell in
// `_app` reads `conversationId` from the URL and opens it through the
// controller. Keeping the pane in the shell (rather than here) means switching
// conversations never tears down the message view or its scroll state.
export const Route = createFileRoute("/_app/c/$conversationId")({
  component: () => null,
});

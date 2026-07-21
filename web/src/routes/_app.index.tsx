import { createFileRoute } from "@tanstack/react-router";

// The conversation-list surface with no conversation open. This route carries no
// visual output of its own: the persistent shell in `_app` renders the sidebar
// and the empty message pane. Its only job is to represent the "/" URL so the
// shell can close any open conversation when the user navigates back here.
export const Route = createFileRoute("/_app/")({
  component: () => null,
});

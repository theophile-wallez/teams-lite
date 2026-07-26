import { createFileRoute } from "@tanstack/react-router";

// One open mail, addressed by its Graph message id in the URL path (`/m/<id>`).
// Those ids are long base64 strings with `=` padding; TanStack Router escapes them
// with encodeURIComponent on the way out and decodes them on the way in, so they
// round-trip safely — the same arrangement as `/c/<thread-id>` for chats.
//
// Like the conversation route this renders nothing itself: the persistent shell in
// `_app` reads `mailId` from the URL and opens it through the controller, so moving
// between mails never tears down the reading pane or the sidebar's scroll position.
export const Route = createFileRoute("/_app/m/$mailId")({
  component: () => null,
});

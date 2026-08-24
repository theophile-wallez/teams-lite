import { createFileRoute, Outlet } from "@tanstack/react-router";

// A single open conversation, addressed by its id in the URL path
// (`/c/<conversation-id>`). The id is a Teams thread id such as
// `19:...@thread.v2`; TanStack Router escapes it with encodeURIComponent on the
// way out and decodes it on the way in, so it round-trips safely.
//
// This is a LAYOUT route with two children, because a conversation has a second surface: the
// thread itself (`index`), and one GAME OF CHESS in it drawn full screen
// (`chess/$gameId` — see components/chess-page.tsx). Splitting them by URL rather than by a
// piece of state is what makes the board a place the reader can be: reloadable, sendable to
// whoever they are playing, and behind the browser's own Back. It is the shape the merge
// request's own page and its diff already have.
//
// Like the index route this renders nothing directly — the persistent shell in
// `_app` reads `conversationId` from the URL and opens it through the
// controller. Keeping the pane in the shell (rather than here) means switching
// conversations never tears down the message view or its scroll state. The Outlet is still
// rendered, because a layout that swallows its children would leave the matched child
// unmounted and its URL no longer authoritative.
export const Route = createFileRoute("/_app/c/$conversationId")({
  component: Outlet,
});

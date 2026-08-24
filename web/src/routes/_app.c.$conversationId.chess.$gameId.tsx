import { createFileRoute } from "@tanstack/react-router";

// ONE GAME OF CHESS, full screen: `/c/<conversation-id>/chess/<game>`.
//
// A URL of its own rather than a panel in the history, because playing a game is somewhere the
// reader STAYS rather than a row they scroll past — and because the card in the conversation is
// a board in a column a phone's width wide, which is the right place to play a move and the
// wrong place to play a game. What follows from the URL is what makes it worth having: it
// survives a reload, it can be sent to whoever you are playing, and the browser's own Back
// leaves it.
//
// The game is addressed by the six hex characters its messages already carry (see
// lib/chess-wire.ts), so nothing new travels for the page to exist. The shell in `_app` draws
// it FULL SCREEN, over the sidebar as well as the pane: the board, the score sheet and the
// conversation's own chat are three columns of its own, and a fourth of chat rows beside them
// would leave none of them the room. Like every other route here it renders nothing itself.
export const Route = createFileRoute("/_app/c/$conversationId/chess/$gameId")({
  component: () => null,
});

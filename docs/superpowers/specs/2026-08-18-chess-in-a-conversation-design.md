# Chess in a conversation

Play a game of chess against anybody in a Teams conversation who also runs teams-lite,
from a shortcut in that conversation's own header. The challenge, the acceptance and every
move are ordinary Teams messages; the board is one row in the history, derived from them.

## Why this shape

**Teams has no private data channel.** A move has to reach another machine, and the only
carrier is a message in the conversation — so the game is played *in* the thread, under the
user's name, visible to everybody in it. That constraint is also the design: a game needs
no storage at all, because the position replays out of the thread's own history. A reload,
a phone, a game played while this app was closed all draw the same board, and there is
nothing to reconcile when a frame is lost.

It is the property `agent-reply.tsx` already has ("the stream is an overlay on the posted
message, never a message of its own"), pushed all the way: here there is no overlay either.
The history IS the game.

**Nothing in the backend changes.** No RPC, no schema, no gate. `send` is already an
`OUTWARD_METHODS` entry and a move rides in its params, which is exactly the argument
§ @mentions and § Pictures in a message make for themselves. The automation hook already
blocks a script that names `send` against a live port, so the guardrails hold unchanged.

## The wire: a trailing line, read back from the words

Every chess message ends with one `<p><em>…</em></p>` line, the shape
`agent_policy::Signature` writes and `agentAuthorship` reads back, and carries the words a
stock Teams client shows above it:

| What a reader sees | The line under it |
| --- | --- |
| `♟ Chess — I'd like a game. I'm white.` | `— chess 7f3a1c open w, via teams-lite` |
| `♟ Chess — accepted.` | `— chess 7f3a1c join, via teams-lite` |
| `♟ 1. e4` | `— chess 7f3a1c 1 e4, via teams-lite` |
| `♟ Chess — I offer a draw.` | `— chess 7f3a1c draw, via teams-lite` |
| `♟ Chess — I accept the draw.` | `— chess 7f3a1c draw-ok, via teams-lite` |
| `♟ Chess — I resign.` | `— chess 7f3a1c resign, via teams-lite` |

Grammar: `— chess <game> <kind…>, via teams-lite`, where `<game>` is six lowercase hex
characters minted by the challenger and `<kind…>` is one of `open w` / `open b` / `join` /
`<ply> <san>` / `draw` / `draw-ok` / `resign`. Six rules, each pinned by a unit test:

- **It is read from the WORDS, never from markup** — the choice `agent-message.ts`,
  `agent-tag.ts` and `tracker-ref.ts` all make. So every game already in a thread renders,
  nothing is added to the wire, and a colleague's own client shows the words the user's
  account really posted.
- **The PLY NUMBER is explicit** (1-based; 1 is white's first move). It makes ordering
  independent of delivery and makes a duplicate detectable: two messages claiming one ply
  is a real state — two clients, one racing reconnect — and the EARLIER `compose_time`
  wins while the later is refused.
- **A line this app cannot parse is not a chess message.** An unknown `<kind>`, a bad game
  id, a ply that is not a number: the message stays an ordinary message rather than
  becoming a game with a hole in it.
- **The words above the line are never parsed.** They exist for a stock Teams reader and
  for a push notification; the line is the whole of the machine-readable half. Two readers
  of one fact is the bug § Push notifications names.
- **The trailing line is STRIPPED from the sidebar's preview** — `chessPreviewText` in
  `chess-wire.ts`, applied by `conversation-list.tsx` where it draws
  `last_message_preview`. Left in, the chat list would read
  `♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite`.
- **A DELETED message is not a chess message**, exactly as `agentAuthorship` refuses one:
  its placeholder is its body.

## Who plays, and what is refused

The **challenge**'s sender is one player and its `open w` / `open b` says which colour they
took; the **accept**'s sender is the other. Both by `sender_mri`, never by display name —
two colleagues may share one (§ WHO said it). `is_self` says which side is the reader's.

- **A move is accepted only from the player whose turn it is.** So a third person in a
  group chat cannot play, and that is the derivation rather than a rule the UI applies.
- **An illegal move is never absorbed.** The replay stops at the offending ply and the card
  says the game cannot be replayed, naming the move. Accepting what the wire claims would
  be a board that disagrees with the other player's.
- **The first accept wins.** In a group or channel the challenge is open; a second accept
  is refused (it is not the game's second player).
- **One game in flight per conversation.** A challenge is refused while a game is unfinished
  there — the next one waits. A finished game (mate, stalemate, draw, resignation) leaves
  its board where it is and lets a new challenge start.
- **A CONVERSATION holds a game; a team CHANNEL does not.** A 1:1 and a group chat draw one
  message after another, which is what a row placed at the challenge can absorb the rest of
  the game into. A channel's history is drawn as THREADS (`ThreadGroup`), so a board there
  would have to live inside a thread and answer a different question about where it sits —
  a later feature, not a quiet addition. It costs nothing the user asked for: the sandbox
  thread `19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2` is a group CHAT, so the one place a
  send is pre-authorized is covered. The header simply draws no control in a channel.

## Where it is drawn

**The shortcut** joins `<CallButton/>` and `<AgentMenu/>` in the header's control group
(`message-pane.tsx:874`), in `ChessPawnIcon` at the same 36px square — a header is a row of
controls the user aims at, so a chat that changed their size would move the target
(§ Audio calls). Three states:

- **no game** — a popover: "Challenge <name>", the colour (White / Black / Random,
  Random by default), and the sentence that says what the press costs: a message goes out
  under the user's name and everybody in the conversation sees it. The failure of that send
  is reported IN the popover, which is the approval menu's rule (§ The trackers).
  **Random is resolved at the press**, in the page, into the `open w` / `open b` the
  challenge really carries — the wire never says "random", because a colour nothing decided
  is a game whose two clients could disagree about who moves first.
- **a game in flight** — the press scrolls to the board through the existing
  `requestScrollToMessage`, and the control carries a dot when it is the user's turn.
- **nowhere it could work** — Notes (the chat with oneself) draws none at all.

**The board** is one `HistoryRow` (`{kind:"chess", key:"chess:<game>", game}`), placed at
the index of the challenge message; every other message of that game is ABSORBED into it,
so a 60-move game adds nothing to the thread's length and the board does not move under the
reader. `rowOfMessage` maps every absorbed message to that row, so a deep link from a
notification lands on the board. `estimateSize` adds `CHESS_ROW_PX`, the way it adds
`TIME_MARK_ROW_PX` — a row taller than its estimate is a corrected `scrollTop` and a twitch
(§ When a message was sent).

## The board itself

- **Oriented from the reader's own colour**; white at the bottom for a spectator.
- **Both players named as they are everywhere else in this app** — the store's own
  resolution, so a renamed colleague wears their nickname and their custom face
  (§ Renaming a person).
- **Drag a piece OR tap-tap** (source square, then target). Tap-tap is not a fallback: it
  is how the app is used on a phone. Legal targets are lit, and promotion opens a small
  picker (Q / R / B / N).
- **A move goes out optimistically and is TAKEN BACK if the send fails**, with the sentence
  at the board. The composer's rule: this app never posts without the user, so it must
  never leave them believing it did.
- **Resign and draw ask twice** (Delete's arming pattern). A resignation ends the game and
  cannot be taken back; a draw offer reaches the other player.
- **Check, checkmate, stalemate and a draw are stated in words**, and so is the result.
- **A compact move list UNDER the board**, one scrollable line of pairs
  (`1. e4 e5  2. Nf3 …`), so the game is readable without replaying it in one's head. Under
  rather than beside: the card sits in a chat column that is a phone's width at its
  narrowest, and a second column there would take the board down to nothing.

## The engine

`chess.js` (1.4.0, BSD-2-Clause, **zero dependencies**, TypeScript types included). Legal
move generation with castling, en passant, promotion, pins, threefold repetition and the
fifty-move rule is a week of subtle bugs to write, and a game that accepts an illegal move
is a game with no rules.

**It is a LAZY chunk**, the rule `@pierre/diffs` holds (§ The DIFF is a PAGE). The split
that makes it possible:

- `web/src/lib/chess-wire.ts` — the trailing line, in both directions. No dependency.
- `web/src/lib/chess-thread.ts` — the games a thread holds: their id, their players, their
  colours, the move list in ply order, the result, whose turn it is (from ply parity), and
  which messages each absorbs. **No rules knowledge, no dependency** — which is what lets
  the pane decide a chess row exists and the header draw its turn dot without loading a
  highlighter's worth of JavaScript.
- `web/src/components/chess-board.tsx` + `chess-game-card.tsx` — reached only through
  `lazy(() => import(…))`. This is the only place `chess.js` is imported: it replays the
  move list into a position and answers what is legal.

## The pieces (a risk named rather than promised)

Hugeicons ships `ChessKingIcon` / `ChessQueenIcon` / `ChessRookIcon` / `ChessBishopIcon` /
`ChessKnightIcon` / `ChessPawnIcon`, so § Hugeicons is satisfied by the library the app
already has. They are `currentColor` strokes, and two distinguishable sides at ~40px is not
something a design decides in prose: **the capture decides.** If the two colours do not
read as two armies, the fallback is the Unicode chess glyphs (♔♕♖♗♘♙ / ♚♛♜♝♞♟), which are
real piece art in every system font. Either way the choice is made once, in one module, and
the board does not know which it drew.

## Files

New:

- `web/src/lib/chess-wire.ts` + `.test.ts`
- `web/src/lib/chess-thread.ts` + `.test.ts`
- `web/src/components/chess-board.tsx`
- `web/src/components/chess-game-card.tsx`
- `web/src/components/chess-button.tsx`
- `web/e2e/chess.spec.ts`

Touched:

- `web/src/components/message-pane.tsx` — the `chess` row kind, the absorb pass in the rows
  memo, `CHESS_ROW_PX` in `estimateSize`, `<ChessButton/>` in the header group.
- `web/src/lib/protocol.ts` — the preview strip.
- `web/src/lib/store.ts` — `sendChessMessage` (one call into the existing `backend.send`),
  and the optimistic move's rollback.
- `web/mock/server.ts` — the opponent.
- `web/scripts/preview.ts` — `--chess`.
- `web/package.json` — `chess.js`.
- `AGENTS.md` — a section of its own.

## Mock, tests, capture

- **The mock plays the opponent** (`simulateMockChessReply`, the shape
  `simulateMockAgentRun` has): it accepts a challenge and answers a legal move, so the whole
  surface is reviewable with no tenant and no second machine. A `{kind:"chess"}` test hook
  arms a refused send, a specific reply move and an illegal one — and a spec MUST reset it,
  since one mock process serves the whole run.
- **Unit** (`bun run test`): the wire in both directions, every refusal, the ply-collision
  rule, the preview strip, the thread derivation (players, turn, absorbed ids, result).
- **E2E** (`bun run test:e2e`): challenge from the header, the board appears as one row, the
  opponent's move arrives and the board follows it, a move sent and taken back on a refused
  send, resign arming twice, tap-tap on a coarse pointer, and the thread's length not growing
  with the game.
- **Capture**: `cd web && bun run preview -- --out /tmp/chess --chess` — the header control
  and its popover, the board in both themes, mid-game with the move list, a promotion, a
  finished game, and the board at a phone's width.
- **Not run**: `cargo test` — nothing in `src/` is touched.

## What is deliberately not built

No clock (a game over messages is correspondence chess), no engine to play against, no
rating, no analysis, no several games at once in one thread, no board on a page or in a
dialog. Each is a later feature and none is needed for a game between two people.

## What stays unverified against the tenant

**The pairing.** The wire rides `send`, which is measured; the parse, the derivation and the
whole surface are pinned against unit tests and the mock. What nothing here can test is one
real challenge accepted by a colleague who also runs teams-lite — that is the user's own
click, in their own app, and the sandbox channel is the only thread where a send is
pre-authorized (§ Sending messages).

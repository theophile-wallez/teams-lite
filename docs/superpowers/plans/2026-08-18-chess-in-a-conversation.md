# Chess in a conversation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user play chess against anybody in a Teams conversation who also runs teams-lite, from a shortcut in that conversation's header, with every move travelling as an ordinary Teams message.

**Architecture:** A game IS the thread. Each challenge / accept / move / draw / resign is one Teams message carrying a trailing `<p><em>— chess <id> <kind>, via teams-lite</em></p>` line, read back from the words exactly as `agent-message.ts` reads an agent's signature. Nothing is stored: a pure module derives every game in the open conversation from the loaded messages, the message pane collapses each game's messages into ONE board row placed at its challenge, and a lazy chunk holding `chess.js` replays the move list into a position. No backend change, no RPC, no gate — `send` is already the consent gate a move rides through.

**Tech Stack:** TypeScript, React 19, vitest, Playwright, `chess.js` 1.4.0 (BSD-2-Clause, zero deps), hugeicons.

**Spec:** `docs/superpowers/specs/2026-08-18-chess-in-a-conversation-design.md`

## Global Constraints

- **All artifacts in English** — UI strings, comments, identifiers, commit messages. The chat with the user may be French; nothing committed may be.
- **Hugeicons is the only icon library.** Every glyph from `@hugeicons/core-free-icons` through `<HugeiconsIcon icon={…} />`; an icon held as a value is typed `IconSvgElement`. `web/src/lib/icon-library.test.ts` scans for a second icon package and fails.
- **Nothing in `src/` (Rust) is touched.** `cargo test` is not part of this plan's gate.
- **No new RPC, no new `OUTWARD_METHODS` entry.** Every outward act goes through the existing `backend.send(conversation, text, replyTo, contentHtml)`.
- **Working directory is the worktree** `/home/cle/clement/teams-lite/.worktrees/chess`, branch `feat/chess`. All `bun` commands run from its `web/` subdirectory.
- **Test gate per task:** `bun run test` (vitest) and `bun run typecheck`. The E2E suite (`bun run test:e2e`) runs in Task 11 with explicit free ports: `E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468`.
- **Wire grammar, verbatim:** `— chess <game> <kind…>, via teams-lite` where `<game>` is exactly six lowercase hex characters and `<kind…>` is one of `open w`, `open b`, `join`, `<ply> <san>`, `draw`, `draw-ok`, `resign`.
- **A team CHANNEL offers no game** (its history is drawn as threads). Conversations only — which includes the sandbox group chat.

## File Structure

| File | Responsibility |
| --- | --- |
| `web/src/lib/chess-wire.ts` | The trailing line, both directions. Plus the preview strip and the game-id mint. No dependency. |
| `web/src/lib/chess-thread.ts` | Every game a message list holds: players, colours, move list, result, turn, absorbed ids. No rules knowledge, no dependency. |
| `web/src/components/chess-pieces.tsx` | One glyph per piece per colour. The single place the hugeicons-vs-Unicode decision lives. |
| `web/src/components/chess-board.tsx` | The 8×8 grid, presentational and controlled. Knows nothing of `chess.js`. |
| `web/src/components/chess-game-card.tsx` | The lazy chunk. Imports `chess.js`, replays the move list, owns selection/promotion state, draws the board + status + move list + controls. |
| `web/src/components/chess-button.tsx` | The header control: challenge popover, turn dot, scroll-to-board. |

---

### Task 1: The wire line

**Files:**
- Create: `web/src/lib/chess-wire.ts`
- Test: `web/src/lib/chess-wire.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` from `~/lib/protocol`.
- Produces:
  - `type ChessColor = "w" | "b"`
  - `type ChessWireBody = { kind: "open"; color: ChessColor } | { kind: "join" } | { kind: "move"; ply: number; san: string } | { kind: "draw" } | { kind: "drawAccepted" } | { kind: "resign" }`
  - `type ChessWire = { game: string; body: ChessWireBody }`
  - `chessWireIn(message: ChatMessage): ChessWire | null`
  - `chessWireLine(wire: ChessWire): string`
  - `chessMessageWords(body: ChessWireBody): string`
  - `chessMessageHtml(wire: ChessWire): string`
  - `chessPreviewText(preview: string): string`
  - `newChessGameId(): string`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/chess-wire.test.ts
import { describe, expect, it } from "vitest";
import {
  chessMessageHtml,
  chessMessageWords,
  chessPreviewText,
  chessWireIn,
  chessWireLine,
  newChessGameId,
} from "./chess-wire";
import type { ChatMessage } from "./protocol";

function message(content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "1",
    conversation_id: "19:c@thread.v2",
    seq: 1,
    compose_time: 1,
    sender: "Ada Lovelace",
    sender_mri: "8:orgid:ada",
    content,
    ...over,
  };
}

/** The body a real send produces, so every test reads what the app really posts. */
function body(line: string, words = "♟ words"): string {
  return `<p>${words}</p><p><em>${line}</em></p>`;
}

describe("chessWireIn", () => {
  it("reads a challenge and the colour its sender took", () => {
    const wire = chessWireIn(message(body("— chess 7f3a1c open w, via teams-lite")));
    expect(wire).toEqual({ game: "7f3a1c", body: { kind: "open", color: "w" } });
  });

  it("reads an accept, a draw offer, its acceptance and a resignation", () => {
    expect(chessWireIn(message(body("— chess 7f3a1c join, via teams-lite")))?.body).toEqual({
      kind: "join",
    });
    expect(chessWireIn(message(body("— chess 7f3a1c draw, via teams-lite")))?.body).toEqual({
      kind: "draw",
    });
    expect(chessWireIn(message(body("— chess 7f3a1c draw-ok, via teams-lite")))?.body).toEqual({
      kind: "drawAccepted",
    });
    expect(chessWireIn(message(body("— chess 7f3a1c resign, via teams-lite")))?.body).toEqual({
      kind: "resign",
    });
  });

  it("reads a move as its ply and its SAN", () => {
    expect(chessWireIn(message(body("— chess 7f3a1c 1 e4, via teams-lite")))?.body).toEqual({
      kind: "move",
      ply: 1,
      san: "e4",
    });
    // Castling, promotion and mate are SAN too, and the shape must admit them.
    expect(chessWireIn(message(body("— chess 7f3a1c 15 O-O, via teams-lite")))?.body).toEqual({
      kind: "move",
      ply: 15,
      san: "O-O",
    });
    expect(chessWireIn(message(body("— chess 7f3a1c 61 exd8=Q#, via teams-lite")))?.body).toEqual({
      kind: "move",
      ply: 61,
      san: "exd8=Q#",
    });
  });

  it("tolerates the whitespace Teams inserts when it stores a body", () => {
    const stored = "<p>♟ 1. e4</p>\r\n<p>\r\n<em>— chess 7f3a1c 1 e4, via teams-lite</em>\r\n</p>";
    expect(chessWireIn(message(stored))?.body).toEqual({ kind: "move", ply: 1, san: "e4" });
  });

  it("is null for anything it cannot read, rather than a game with a hole in it", () => {
    // An ordinary message.
    expect(chessWireIn(message("<p>shall we play?</p>"))).toBeNull();
    // An agent's signature is the same SHAPE and must not be read as chess.
    expect(chessWireIn(message(body("— claude, via teams-lite")))).toBeNull();
    // A kind this build does not know.
    expect(chessWireIn(message(body("— chess 7f3a1c castle, via teams-lite")))).toBeNull();
    // A game id that is not six lowercase hex characters.
    expect(chessWireIn(message(body("— chess 7F3A1C join, via teams-lite")))).toBeNull();
    expect(chessWireIn(message(body("— chess 7f3a1 join, via teams-lite")))).toBeNull();
    // A ply that is not a positive number.
    expect(chessWireIn(message(body("— chess 7f3a1c 0 e4, via teams-lite")))).toBeNull();
    // SAN with markup-ish characters in it.
    expect(chessWireIn(message(body("— chess 7f3a1c 1 <b>e4</b>, via teams-lite")))).toBeNull();
    // The line has to be the LAST block, not merely present.
    expect(
      chessWireIn(message(`${body("— chess 7f3a1c join, via teams-lite")}<p>and more</p>`)),
    ).toBeNull();
  });

  it("is never read on a DELETED message, whose placeholder is its body", () => {
    const gone = message(body("— chess 7f3a1c 1 e4, via teams-lite"), { deleted: true });
    expect(chessWireIn(gone)).toBeNull();
  });
});

describe("chessWireLine", () => {
  it("round-trips every kind through chessWireIn", () => {
    const wires = [
      { game: "7f3a1c", body: { kind: "open", color: "w" } },
      { game: "7f3a1c", body: { kind: "open", color: "b" } },
      { game: "7f3a1c", body: { kind: "join" } },
      { game: "7f3a1c", body: { kind: "move", ply: 7, san: "Nf3" } },
      { game: "7f3a1c", body: { kind: "draw" } },
      { game: "7f3a1c", body: { kind: "drawAccepted" } },
      { game: "7f3a1c", body: { kind: "resign" } },
    ] as const;
    for (const wire of wires) {
      const read = chessWireIn(message(chessMessageHtml(wire)));
      expect(read).toEqual(wire);
    }
  });
});

describe("chessMessageWords", () => {
  it("says what happened, so a stock Teams client shows a sentence", () => {
    expect(chessMessageWords({ kind: "move", ply: 1, san: "e4" })).toBe("♟ 1. e4");
    // Black's move is numbered by the MOVE, not the ply, the way a score sheet reads.
    expect(chessMessageWords({ kind: "move", ply: 2, san: "e5" })).toBe("♟ 1… e5");
    expect(chessMessageWords({ kind: "move", ply: 3, san: "Nf3" })).toBe("♟ 2. Nf3");
    expect(chessMessageWords({ kind: "open", color: "w" })).toContain("white");
    expect(chessMessageWords({ kind: "open", color: "b" })).toContain("black");
    expect(chessMessageWords({ kind: "resign" })).toContain("resign");
  });
});

describe("chessPreviewText", () => {
  it("takes the marker off a sidebar preview and leaves the words", () => {
    expect(chessPreviewText("♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite")).toBe("♟ 1. e4");
  });

  it("leaves an ordinary preview alone", () => {
    expect(chessPreviewText("on my way")).toBe("on my way");
    expect(chessPreviewText("")).toBe("");
    // An agent's signature is not ours to strip.
    expect(chessPreviewText("done — claude, via teams-lite")).toBe("done — claude, via teams-lite");
  });
});

describe("newChessGameId", () => {
  it("mints six lowercase hex characters that the reader can read back", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newChessGameId();
      expect(id).toMatch(/^[0-9a-f]{6}$/);
      const wire = { game: id, body: { kind: "join" } } as const;
      expect(chessWireIn(message(chessMessageHtml(wire)))).toEqual(wire);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test chess-wire`
Expected: FAIL — `Failed to resolve import "./chess-wire"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/chess-wire.ts
/**
 * The line a chess message signs itself with, in both directions.
 *
 * A move has to reach another machine and Teams has no private data channel, so the
 * carrier is a message in the conversation. Nothing about the game is stored: the body
 * carries the words a stock Teams client shows, and one trailing `<p><em>…</em></p>` line
 * carries the machine-readable half — the shape `agent_policy::Signature` writes and
 * `agentAuthorship` reads back (see lib/agent-message.ts).
 *
 * It is read from the WORDS and never from markup, which is the choice `agent-tag.ts` and
 * `tracker-ref.ts` both make: every game already in a thread renders, nothing is added to
 * the wire, and a colleague's own client shows exactly what the user's account posted.
 */

import type { ChatMessage } from "./protocol";

/** Which side of the board. `w` and `b` are chess.js's own spelling, so the two halves of
 *  this feature never need a translation between them. */
export type ChessColor = "w" | "b";

/** What one chess message says. */
export type ChessWireBody =
  | { kind: "open"; color: ChessColor }
  | { kind: "join" }
  | { kind: "move"; ply: number; san: string }
  | { kind: "draw" }
  | { kind: "drawAccepted" }
  | { kind: "resign" };

/** One chess message: which game, and what it says about it. */
export type ChessWire = { game: string; body: ChessWireBody };

/** One trailing `<p><em>…</em></p>`, allowing the whitespace Teams stores. Deliberately the
 *  same pattern `agent-message.ts` uses: both features sign a body the same way, and a
 *  second spelling of "the last italic block" would drift from it. */
const SIGNATURE = /<p>\s*<em>\s*([^<]*?)\s*<\/em>\s*<\/p>\s*$/i;

/** The signature a chess message carries. The game id is six lowercase hex characters —
 *  narrow on purpose, so an agent's `— claude, via teams-lite` and a colleague's own prose
 *  can never be read as a game. */
const CHESS_LINE = /^—\s*chess\s+([0-9a-f]{6})\s+(.+?),\s*via teams-lite$/i;

/** SAN's own shape, and nothing about legality: a piece letter, a file, or castling, then
 *  the squares, the capture, the promotion and the check marks. What is LEGAL is chess.js's
 *  answer (see components/chess-game-card.tsx) — this only refuses a token that could not
 *  be a move at all, which is what keeps a stray line out of a game. */
const SAN = /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/;

/** The game id: six lowercase hex characters. Short enough to read in a sentence, wide
 *  enough (16.7M) that two games in one conversation cannot collide in practice. */
export function newChessGameId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The chess message this message is, or null when it is not one.
 *
 * A DELETED message is never one, exactly as `agentAuthorship` refuses one: its placeholder
 * is its body, and a game must not absorb a row the reader is being shown a tombstone for.
 */
export function chessWireIn(message: ChatMessage): ChessWire | null {
  if (message.deleted === true) return null;
  const signature = SIGNATURE.exec(message.content ?? "");
  if (!signature) return null;
  const line = CHESS_LINE.exec(signature[1] ?? "");
  if (!line) return null;
  const game = (line[1] ?? "").toLowerCase();
  const body = wireBody((line[2] ?? "").trim());
  return body && { game, body };
}

/** What the `<kind…>` half of a line says, or null for a kind this build does not know —
 *  which leaves the message an ordinary message rather than a game with a hole in it. */
function wireBody(rest: string): ChessWireBody | null {
  if (rest === "open w") return { kind: "open", color: "w" };
  if (rest === "open b") return { kind: "open", color: "b" };
  if (rest === "join") return { kind: "join" };
  if (rest === "draw") return { kind: "draw" };
  if (rest === "draw-ok") return { kind: "drawAccepted" };
  if (rest === "resign") return { kind: "resign" };
  const move = /^(\d{1,3})\s+(\S+)$/.exec(rest);
  if (!move) return null;
  const ply = Number(move[1]);
  const san = move[2] ?? "";
  if (!Number.isInteger(ply) || ply < 1) return null;
  if (!SAN.test(san)) return null;
  return { kind: "move", ply, san };
}

/** The line itself. The one spelling, read back by {@link chessWireIn}. */
export function chessWireLine(wire: ChessWire): string {
  return `— chess ${wire.game} ${wireKind(wire.body)}, via teams-lite`;
}

function wireKind(body: ChessWireBody): string {
  switch (body.kind) {
    case "open":
      return `open ${body.color}`;
    case "join":
      return "join";
    case "move":
      return `${body.ply} ${body.san}`;
    case "draw":
      return "draw";
    case "drawAccepted":
      return "draw-ok";
    case "resign":
      return "resign";
  }
}

/**
 * The words above the line — what a stock Teams client shows, and what a push notification
 * on somebody's phone says. They are never parsed: the line is the whole machine-readable
 * half, and two readers of one fact is the bug § Push notifications names.
 */
export function chessMessageWords(body: ChessWireBody): string {
  switch (body.kind) {
    case "open":
      return `♟ Chess — I'd like a game. I'm ${body.color === "w" ? "white" : "black"}.`;
    case "join":
      return "♟ Chess — accepted.";
    case "move":
      // Numbered the way a score sheet reads: by the MOVE, with an ellipsis for black.
      return `♟ ${Math.ceil(body.ply / 2)}${body.ply % 2 === 1 ? "." : "…"} ${body.san}`;
    case "draw":
      return "♟ Chess — I offer a draw.";
    case "drawAccepted":
      return "♟ Chess — I accept the draw.";
    case "resign":
      return "♟ Chess — I resign.";
  }
}

/** The whole body a chess message is sent with: the words, then the line. */
export function chessMessageHtml(wire: ChessWire): string {
  return `<p>${chessMessageWords(wire.body)}</p><p><em>${chessWireLine(wire)}</em></p>`;
}

/** The plain-text half of the same send, for a client that shows no HTML. */
export function chessMessageText(wire: ChessWire): string {
  return `${chessMessageWords(wire.body)}\n${chessWireLine(wire)}`;
}

/** The trailing marker taken off a sidebar preview. Left in, the chat list would read
 *  `♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite`. */
export function chessPreviewText(preview: string): string {
  const at = preview.lastIndexOf("— chess ");
  if (at < 0) return preview;
  if (!CHESS_LINE.test(preview.slice(at).trim())) return preview;
  return preview.slice(0, at).trim();
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && bun run test chess-wire && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chess-wire.ts web/src/lib/chess-wire.test.ts
git commit -m "feat(chess): a chess message signs itself the way an agent's reply does"
```

---

### Task 2: The games a thread holds

**Files:**
- Create: `web/src/lib/chess-thread.ts`
- Test: `web/src/lib/chess-thread.test.ts`

**Interfaces:**
- Consumes: `chessWireIn`, `ChessColor`, `ChessWire` from `./chess-wire`; `ChatMessage` from `./protocol`.
- Produces:
  - `type ChessPlayer = { mri: string; name: string; isSelf: boolean }`
  - `type ChessOutcome = { kind: "playing" } | { kind: "resigned"; by: ChessColor } | { kind: "drawAgreed" }`
  - `type ChessGame = { id: string; challengeMessageId: string; challengeSeq: number; challenger: ChessPlayer; challengerColor: ChessColor; opponent: ChessPlayer | null; moves: string[]; turn: ChessColor; drawOfferedBy: ChessColor | null; outcome: ChessOutcome; ourColor: ChessColor | null; absorbed: string[]; refusedPlies: number[] }`
  - `chessGamesInThread(messages: ChatMessage[]): ChessGame[]`
  - `chessPlayerOf(game: ChessGame, color: ChessColor): ChessPlayer | null`
  - `chessGameIsSettled(game: ChessGame): boolean`
  - `activeChessGame(games: ChessGame[]): ChessGame | null`
  - `chessTurnIsOurs(game: ChessGame): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/lib/chess-thread.test.ts
import { describe, expect, it } from "vitest";
import {
  activeChessGame,
  chessGameIsSettled,
  chessGamesInThread,
  chessPlayerOf,
  chessTurnIsOurs,
} from "./chess-thread";
import { chessMessageHtml, type ChessWire } from "./chess-wire";
import type { ChatMessage } from "./protocol";

const ME = { mri: "8:orgid:me", name: "Clement" };
const ADA = { mri: "8:orgid:ada", name: "Ada Lovelace" };
const GRACE = { mri: "8:orgid:grace", name: "Grace Hopper" };

let seq = 0;

/** One chess message from somebody. `who === ME` is the reader's own. */
function chess(who: { mri: string; name: string }, wire: ChessWire): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "19:c@thread.v2",
    seq,
    compose_time: 1_700_000_000_000 + seq * 1000,
    sender: who.name,
    sender_mri: who.mri,
    content: chessMessageHtml(wire),
    ...(who === ME ? { is_self: true } : {}),
  };
}

/** An ordinary message, which a game must leave alone. */
function chat(who: { mri: string; name: string }, text: string): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversation_id: "19:c@thread.v2",
    seq,
    compose_time: 1_700_000_000_000 + seq * 1000,
    sender: who.name,
    sender_mri: who.mri,
    content: `<p>${text}</p>`,
    ...(who === ME ? { is_self: true } : {}),
  };
}

describe("chessGamesInThread", () => {
  it("finds a game from its challenge alone, with nobody opposite yet", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(game.id).toBe("aaa111");
    expect(game.challenger).toEqual({ mri: ME.mri, name: ME.name, isSelf: true });
    expect(game.challengerColor).toBe("w");
    expect(game.opponent).toBeNull();
    expect(game.ourColor).toBe("w");
    expect(game.turn).toBe("w");
    expect(game.moves).toEqual([]);
  });

  it("names the other player from the ACCEPT, and gives them the other colour", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "b" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game.opponent).toEqual({ mri: ADA.mri, name: ADA.name, isSelf: false });
    expect(chessPlayerOf(game, "b")?.mri).toBe(ME.mri);
    expect(chessPlayerOf(game, "w")?.mri).toBe(ADA.mri);
    expect(game.ourColor).toBe("b");
  });

  it("keeps the moves in ply order and follows the turn", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
      chat(ADA, "nice"),
      chess(ADA, { game: "aaa111", body: { kind: "move", ply: 2, san: "e5" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 3, san: "Nf3" } }),
    ]);
    expect(game.moves).toEqual(["e4", "e5", "Nf3"]);
    expect(game.turn).toBe("b");
    expect(chessTurnIsOurs(game)).toBe(false);
  });

  it("absorbs every message of the game and nothing else", () => {
    const messages = [
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chat(ADA, "your move"),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ];
    const [game] = chessGamesInThread(messages);
    expect(game.absorbed).toEqual([messages[0].id, messages[1].id, messages[3].id]);
    expect(game.challengeMessageId).toBe(messages[0].id);
  });

  it("REFUSES a move from the player whose turn it is not", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      // Ada is black and it is white's move.
      chess(ADA, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game.moves).toEqual([]);
    expect(game.refusedPlies).toEqual([1]);
  });

  it("REFUSES a move from somebody who is not in the game at all", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(GRACE, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game.moves).toEqual([]);
  });

  it("REFUSES a move before the game was accepted", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ]);
    expect(game.moves).toEqual([]);
  });

  it("keeps the FIRST of two messages claiming one ply, and refuses the later", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "d4" } }),
    ]);
    expect(game.moves).toEqual(["e4"]);
    expect(game.refusedPlies).toEqual([1]);
  });

  it("refuses a SECOND accept — the first colleague to answer is the opponent", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(GRACE, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game.opponent?.mri).toBe(ADA.mri);
  });

  it("refuses an accept from the CHALLENGER: a game needs two people", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ME, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(game.opponent).toBeNull();
  });

  it("carries a draw offer, and settles the game when the OTHER player accepts it", () => {
    const offered = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ME, { game: "aaa111", body: { kind: "draw" } }),
    ])[0];
    expect(offered.drawOfferedBy).toBe("w");
    expect(chessGameIsSettled(offered)).toBe(false);

    const agreed = chessGamesInThread([
      chess(ME, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "bbb222", body: { kind: "join" } }),
      chess(ME, { game: "bbb222", body: { kind: "draw" } }),
      chess(ADA, { game: "bbb222", body: { kind: "drawAccepted" } }),
    ])[0];
    expect(agreed.outcome).toEqual({ kind: "drawAgreed" });
    expect(chessGameIsSettled(agreed)).toBe(true);

    // Accepting one's OWN offer settles nothing.
    const alone = chessGamesInThread([
      chess(ME, { game: "ccc333", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "ccc333", body: { kind: "join" } }),
      chess(ME, { game: "ccc333", body: { kind: "draw" } }),
      chess(ME, { game: "ccc333", body: { kind: "drawAccepted" } }),
    ])[0];
    expect(alone.outcome).toEqual({ kind: "playing" });
  });

  it("settles the game on a resignation, naming who resigned", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
    ]);
    expect(game.outcome).toEqual({ kind: "resigned", by: "b" });
    expect(chessGameIsSettled(game)).toBe(true);
  });

  it("ignores anything after the game is settled, but still absorbs it", () => {
    const messages = [
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
      chess(ME, { game: "aaa111", body: { kind: "move", ply: 1, san: "e4" } }),
    ];
    const [game] = chessGamesInThread(messages);
    expect(game.moves).toEqual([]);
    expect(game.absorbed).toContain(messages[3].id);
  });

  it("holds several games apart, in the order they were opened", () => {
    const games = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
    ]);
    expect(games.map((g) => g.id)).toEqual(["aaa111", "bbb222"]);
  });

  it("ignores a message for a game whose challenge it never saw", () => {
    // The history pages older, so the challenge may simply not be loaded yet. A board
    // built from the tail of a game would show a position that never happened.
    expect(chessGamesInThread([chess(ME, { game: "zzz999", body: { kind: "move", ply: 5, san: "e4" } })])).toEqual([]);
  });
});

describe("activeChessGame", () => {
  it("is the newest unfinished game, and null when every one is settled", () => {
    const settled = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
    ]);
    expect(activeChessGame(settled)).toBeNull();

    const live = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
      chess(ADA, { game: "aaa111", body: { kind: "resign" } }),
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
    ]);
    expect(activeChessGame(live)?.id).toBe("bbb222");
  });
});

describe("chessTurnIsOurs", () => {
  it("is false for a spectator and while the game waits for an opponent", () => {
    const [waiting] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
    ]);
    expect(chessTurnIsOurs(waiting)).toBe(false);

    const [theirs] = chessGamesInThread([
      chess(ADA, { game: "bbb222", body: { kind: "open", color: "w" } }),
      chess(GRACE, { game: "bbb222", body: { kind: "join" } }),
    ]);
    expect(theirs.ourColor).toBeNull();
    expect(chessTurnIsOurs(theirs)).toBe(false);
  });

  it("is true when the game is accepted and it is the reader's move", () => {
    const [game] = chessGamesInThread([
      chess(ME, { game: "aaa111", body: { kind: "open", color: "w" } }),
      chess(ADA, { game: "aaa111", body: { kind: "join" } }),
    ]);
    expect(chessTurnIsOurs(game)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test chess-thread`
Expected: FAIL — `Failed to resolve import "./chess-thread"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/lib/chess-thread.ts
/**
 * Every game of chess a loaded message list holds, derived from the messages themselves.
 *
 * There is no store for a game and there is deliberately none: the position replays out of
 * the thread's own history, so a reload, a phone and a game played while this app was closed
 * all draw the same board, and there is nothing to reconcile when a frame is lost. It is the
 * property the agent's overlay has ("the row in the history IS the Teams message"), with no
 * overlay left at all.
 *
 * This module knows NO chess rules and carries no dependency. It answers who is playing,
 * whose turn it is and what the moves were; whether a move is LEGAL is chess.js's answer,
 * in the lazy chunk (see components/chess-game-card.tsx). That split is what lets the pane
 * decide a board row exists, and the header draw its turn dot, without loading a rules
 * engine into the path of every chat.
 */

import { chessWireIn, type ChessColor } from "./chess-wire";
import type { ChatMessage } from "./protocol";

/** One side's player. Named by MRI and never by display name — two colleagues may share
 *  one (§ WHO said it) — with the name kept for what the card draws. */
export type ChessPlayer = { mri: string; name: string; isSelf: boolean };

/** How the game ended, when a MESSAGE ended it. Mate, stalemate and the draws the rules
 *  decide are the board's own answer and are not in here: only chess.js can see those. */
export type ChessOutcome =
  | { kind: "playing" }
  | { kind: "resigned"; by: ChessColor }
  | { kind: "drawAgreed" };

/** One game, as the thread states it. */
export type ChessGame = {
  id: string;
  /** The message the board row is placed at. */
  challengeMessageId: string;
  challengeSeq: number;
  challenger: ChessPlayer;
  challengerColor: ChessColor;
  /** Whoever accepted, or null while the challenge is still open. */
  opponent: ChessPlayer | null;
  /** SAN in ply order; index 0 is ply 1. */
  moves: string[];
  /** Whose move it is, from the ply count. */
  turn: ChessColor;
  drawOfferedBy: ChessColor | null;
  outcome: ChessOutcome;
  /** The reader's own side, or null when they are watching. */
  ourColor: ChessColor | null;
  /** Every message of this game, the challenge included — what the pane absorbs. */
  absorbed: string[];
  /** Plies a message claimed and the game refused: a move out of turn, a duplicate, a
   *  move before the accept. Kept so the card can SAY so rather than drawing a board that
   *  silently disagrees with the other player's. */
  refusedPlies: number[];
};

/** Who plays a colour. */
export function chessPlayerOf(game: ChessGame, color: ChessColor): ChessPlayer | null {
  if (color === game.challengerColor) return game.challenger;
  return game.opponent;
}

/** Whether a MESSAGE has ended this game. The board decides the rest. */
export function chessGameIsSettled(game: ChessGame): boolean {
  return game.outcome.kind !== "playing";
}

/** The newest game still being played, or null. One game in flight per conversation, so
 *  this is what a challenge is refused against and what the header points at. */
export function activeChessGame(games: ChessGame[]): ChessGame | null {
  for (let i = games.length - 1; i >= 0; i -= 1) {
    const game = games[i];
    if (game && !chessGameIsSettled(game)) return game;
  }
  return null;
}

/** Whether the reader may move: they are a player, somebody accepted, and it is their turn. */
export function chessTurnIsOurs(game: ChessGame): boolean {
  return !!game.ourColor && !!game.opponent && game.turn === game.ourColor;
}

/** The games this message list holds, in the order they were opened. */
export function chessGamesInThread(messages: ChatMessage[]): ChessGame[] {
  const byId = new Map<string, ChessGame>();
  const order: string[] = [];

  for (const message of messages) {
    const wire = chessWireIn(message);
    if (!wire) continue;
    const who = playerOf(message);

    if (wire.body.kind === "open") {
      // A game is opened once. A second `open` for the same id is absorbed and ignored,
      // because the first one is the game every reader has already started replaying.
      if (byId.has(wire.game)) {
        byId.get(wire.game)?.absorbed.push(message.id);
        continue;
      }
      byId.set(wire.game, {
        id: wire.game,
        challengeMessageId: message.id,
        challengeSeq: message.seq,
        challenger: who,
        challengerColor: wire.body.color,
        opponent: null,
        moves: [],
        turn: "w",
        drawOfferedBy: null,
        outcome: { kind: "playing" },
        ourColor: message.is_self === true ? wire.body.color : null,
        absorbed: [message.id],
        refusedPlies: [],
      });
      order.push(wire.game);
      continue;
    }

    const game = byId.get(wire.game);
    // A message for a game whose challenge is not loaded says nothing this app can draw:
    // the history pages older, and a board built from the tail of a game would show a
    // position that never happened.
    if (!game) continue;
    game.absorbed.push(message.id);
    // Everything after a resignation or an agreed draw is absorbed and ignored.
    if (chessGameIsSettled(game)) continue;

    if (wire.body.kind === "join") {
      // The FIRST colleague to answer is the opponent, and it can never be the challenger:
      // a game needs two people.
      if (game.opponent || who.mri === game.challenger.mri) continue;
      game.opponent = who;
      if (message.is_self === true) game.ourColor = other(game.challengerColor);
      continue;
    }

    const color = colorOf(game, who.mri);
    // Nobody outside the game may act on it. That is the derivation rather than a rule the
    // UI applies, which is what keeps a third person in a group chat out of it.
    if (!color) continue;

    if (wire.body.kind === "move") {
      // A move is accepted only from the player whose turn it is, only once the game has an
      // opponent, and only as the NEXT ply. Two messages claiming one ply is a real state —
      // two clients, one racing reconnect — and the earlier one wins because this walk is in
      // order; the later is refused rather than applied on top.
      if (!game.opponent || color !== game.turn || wire.body.ply !== game.moves.length + 1) {
        game.refusedPlies.push(wire.body.ply);
        continue;
      }
      game.moves.push(wire.body.san);
      game.turn = other(game.turn);
      // A move answers an open draw offer by declining it, which is what a move means.
      game.drawOfferedBy = null;
      continue;
    }

    if (wire.body.kind === "draw") {
      game.drawOfferedBy = color;
      continue;
    }

    if (wire.body.kind === "drawAccepted") {
      // Accepting one's own offer settles nothing.
      if (!game.drawOfferedBy || game.drawOfferedBy === color) continue;
      game.outcome = { kind: "drawAgreed" };
      game.drawOfferedBy = null;
      continue;
    }

    // A resignation.
    game.outcome = { kind: "resigned", by: color };
    game.drawOfferedBy = null;
  }

  return order.map((id) => byId.get(id)).filter((game): game is ChessGame => !!game);
}

function playerOf(message: ChatMessage): ChessPlayer {
  return {
    mri: message.sender_mri ?? "",
    name: message.sender,
    isSelf: message.is_self === true,
  };
}

function colorOf(game: ChessGame, mri: string): ChessColor | null {
  if (mri && mri === game.challenger.mri) return game.challengerColor;
  if (mri && game.opponent && mri === game.opponent.mri) return other(game.challengerColor);
  return null;
}

function other(color: ChessColor): ChessColor {
  return color === "w" ? "b" : "w";
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && bun run test chess-thread && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/chess-thread.ts web/src/lib/chess-thread.test.ts
git commit -m "feat(chess): a game is derived from the thread, never stored"
```

---

### Task 3: The sidebar preview stops showing the marker

**Files:**
- Modify: `web/src/lib/protocol.ts` — `previewLine` (line ~1730) and `channelPreviewLine` (line ~1912)
- Test: `web/src/lib/protocol.test.ts`

**Interfaces:**
- Consumes: `chessPreviewText` from `./chess-wire`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `web/src/lib/protocol.test.ts` (inside the existing `describe` that covers `previewLine`, or a new one beside it — the file's own `conversation()` helper builds the fixture):

```ts
describe("previewLine and chess", () => {
  it("shows the words of a chess message and not its marker", () => {
    const c = conversation({
      last_message_preview: "♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite",
      last_message_from_me: true,
    });
    expect(previewLine(c)).toBe("You: ♟ 1. e4");
  });

  it("leaves every other preview exactly as it was", () => {
    const c = conversation({ last_message_preview: "on my way", last_message_from_me: true });
    expect(previewLine(c)).toBe("You: on my way");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test protocol -t chess`
Expected: FAIL — the preview still carries `— chess 7f3a1c 1 e4, via teams-lite`.

- [ ] **Step 3: Write minimal implementation**

In `web/src/lib/protocol.ts`, add the import at the top beside the other `./` imports:

```ts
import { chessPreviewText } from "./chess-wire";
```

Then in `previewLine`, replace the body read:

```ts
export function previewLine(c: Conversation): string {
  // A chess message signs itself with a trailing marker (see lib/chess-wire.ts). It is the
  // machine-readable half and nothing a reader of the chat list wants: left in, a row would
  // read "♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite".
  const body = chessPreviewText(c.last_message_preview ?? "");
  if (!body) return "";
  ...
```

And the same one line in `channelPreviewLine`:

```ts
export function channelPreviewLine(c: Channel): string {
  const body = chessPreviewText(c.last_message_preview ?? "");
  if (!body) return "";
  ...
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && bun run test protocol && bun run typecheck`
Expected: PASS, and every existing `previewLine` test still green.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/protocol.ts web/src/lib/protocol.test.ts
git commit -m "fix(chess): the chat list shows a move, not the line that carries it"
```

---

### Task 4: The pieces

**Files:**
- Create: `web/src/components/chess-pieces.tsx`
- Test: `web/src/components/chess-pieces.test.tsx`

**Interfaces:**
- Consumes: `ChessColor` from `~/lib/chess-wire`.
- Produces:
  - `type ChessPieceKind = "k" | "q" | "r" | "b" | "n" | "p"` (chess.js's own lowercase letters)
  - `<ChessPiece kind={ChessPieceKind} color={ChessColor} className?={string} />`

**Note for the implementer:** the spec names this a risk rather than a promise. Draw the pieces with the hugeicons chess set first (`ChessKingIcon`, `ChessQueenIcon`, `ChessRookIcon`, `ChessBishopIcon`, `ChessKnightIcon`, `ChessPawnIcon` — all present in `@hugeicons/core-free-icons@4.2.3`, verified). Capture the board in Task 10 and LOOK at it: if the two colours do not read as two armies at board size, swap the internals of this one file for the Unicode glyphs (`♔♕♖♗♘♙` / `♚♛♜♝♞♟`) and keep the same props. Nothing outside this file may learn which was drawn.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/chess-pieces.test.tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChessPiece } from "./chess-pieces";

describe("ChessPiece", () => {
  it("names the piece and its colour for a reader who cannot see it", () => {
    const { getByLabelText } = render(<ChessPiece kind="n" color="w" />);
    expect(getByLabelText("White knight")).toBeTruthy();
  });

  it("draws all twelve without throwing", () => {
    for (const kind of ["k", "q", "r", "b", "n", "p"] as const) {
      for (const color of ["w", "b"] as const) {
        const { container } = render(<ChessPiece kind={kind} color={color} />);
        expect(container.firstChild).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test chess-pieces`
Expected: FAIL — `Failed to resolve import "./chess-pieces"`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/components/chess-pieces.tsx
/**
 * One glyph per piece per colour, and the ONE place the choice of art lives.
 *
 * The pieces come from hugeicons, which is the app's only icon library (§ Project shape) and
 * happens to ship a complete chess set. They are `currentColor` strokes, so the two sides are
 * told apart by ink and by a fill: a white piece is the page's own foreground over the
 * background, a black piece is the foreground filled. If a capture ever shows those two not
 * reading as two armies at board size, the internals here become the Unicode chess glyphs
 * and nothing outside this file changes.
 *
 * Every piece names itself for a screen reader, because a board drawn in glyphs says nothing
 * to somebody who cannot see it.
 */

import {
  ChessBishopIcon,
  ChessKingIcon,
  ChessKnightIcon,
  ChessPawnIcon,
  ChessQueenIcon,
  ChessRookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";

/** chess.js's own lowercase piece letters, so no translation is needed between the two. */
export type ChessPieceKind = "k" | "q" | "r" | "b" | "n" | "p";

const GLYPH: Record<ChessPieceKind, IconSvgElement> = {
  k: ChessKingIcon,
  q: ChessQueenIcon,
  r: ChessRookIcon,
  b: ChessBishopIcon,
  n: ChessKnightIcon,
  p: ChessPawnIcon,
};

const NAME: Record<ChessPieceKind, string> = {
  k: "king",
  q: "queen",
  r: "rook",
  b: "bishop",
  n: "knight",
  p: "pawn",
};

export function ChessPiece(props: {
  kind: ChessPieceKind;
  color: ChessColor;
  className?: string;
}) {
  const label = `${props.color === "w" ? "White" : "Black"} ${NAME[props.kind]}`;
  return (
    <HugeiconsIcon
      icon={GLYPH[props.kind]}
      role="img"
      aria-label={label}
      // The two sides: white is drawn as an outline, black is filled. Both are the page's
      // own foreground, so the pieces read in either theme without a colour of their own.
      className={cn(
        "size-[80%]",
        props.color === "w" ? "text-foreground" : "text-foreground",
        props.className,
      )}
      strokeWidth={props.color === "w" ? 1.6 : 2.2}
      fill={props.color === "b" ? "currentColor" : "none"}
    />
  );
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && bun run test chess-pieces && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/chess-pieces.tsx web/src/components/chess-pieces.test.tsx
git commit -m "feat(chess): the pieces come from the app's own icon library"
```

---

### Task 5: The board

**Files:**
- Create: `web/src/components/chess-board.tsx`
- Test: `web/src/components/chess-board.test.tsx`

**Interfaces:**
- Consumes: `ChessPiece`, `ChessPieceKind` from `./chess-pieces`; `ChessColor` from `~/lib/chess-wire`.
- Produces:
  - `type ChessSquare = string` (`"a1"` … `"h8"`)
  - `type ChessBoardSquare = { square: ChessSquare; piece: { kind: ChessPieceKind; color: ChessColor } | null }`
  - `<ChessBoard squares={ChessBoardSquare[]} orientation={ChessColor} selected={ChessSquare | null} targets={ChessSquare[]} lastMove={[ChessSquare, ChessSquare] | null} check={ChessSquare | null} onSquare?={(square: ChessSquare) => void} />`

The board is **presentational and controlled**: it holds no chess knowledge and no state. `squares` arrives in a1…h8 order (rank-major, file-minor) and the component lays it out for the orientation it was given.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/chess-board.test.tsx
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChessBoard, type ChessBoardSquare } from "./chess-board";

/** An empty board with one white knight on b1. */
function squares(): ChessBoardSquare[] {
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const out: ChessBoardSquare[] = [];
  for (let rank = 1; rank <= 8; rank += 1) {
    for (const file of files) {
      out.push({
        square: `${file}${rank}`,
        piece: file === "b" && rank === 1 ? { kind: "n", color: "w" } : null,
      });
    }
  }
  return out;
}

describe("ChessBoard", () => {
  it("draws sixty-four squares", () => {
    const { container } = render(
      <ChessBoard squares={squares()} orientation="w" selected={null} targets={[]} lastMove={null} check={null} />,
    );
    expect(container.querySelectorAll("[data-square]").length).toBe(64);
  });

  it("puts the reader's own side at the bottom", () => {
    const white = render(
      <ChessBoard squares={squares()} orientation="w" selected={null} targets={[]} lastMove={null} check={null} />,
    );
    const first = white.container.querySelectorAll("[data-square]")[0];
    expect(first?.getAttribute("data-square")).toBe("a8");

    const black = render(
      <ChessBoard squares={squares()} orientation="b" selected={null} targets={[]} lastMove={null} check={null} />,
    );
    const firstBlack = black.container.querySelectorAll("[data-square]")[0];
    expect(firstBlack?.getAttribute("data-square")).toBe("h1");
  });

  it("marks the selected square, the legal targets and the last move", () => {
    const { container } = render(
      <ChessBoard
        squares={squares()}
        orientation="w"
        selected="b1"
        targets={["a3", "c3"]}
        lastMove={["e2", "e4"]}
        check={null}
      />,
    );
    expect(container.querySelector('[data-square="b1"]')?.getAttribute("data-selected")).toBe("true");
    expect(container.querySelector('[data-square="a3"]')?.getAttribute("data-target")).toBe("true");
    expect(container.querySelector('[data-square="e4"]')?.getAttribute("data-last-move")).toBe("true");
  });

  it("reports the square that was pressed", () => {
    const onSquare = vi.fn();
    const { container } = render(
      <ChessBoard
        squares={squares()}
        orientation="w"
        selected={null}
        targets={[]}
        lastMove={null}
        check={null}
        onSquare={onSquare}
      />,
    );
    (container.querySelector('[data-square="b1"]') as HTMLElement).click();
    expect(onSquare).toHaveBeenCalledWith("b1");
  });

  it("draws plain squares with no handler, so a spectator's board is not a grid of buttons", () => {
    const { container } = render(
      <ChessBoard squares={squares()} orientation="w" selected={null} targets={[]} lastMove={null} check={null} />,
    );
    expect(container.querySelectorAll("button").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test chess-board`
Expected: FAIL — `Failed to resolve import "./chess-board"`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/components/chess-board.tsx
/**
 * The board: eight by eight, presentational and controlled.
 *
 * It holds no chess knowledge and no state — what is legal, what is selected and what a
 * press means are the card's answers (see chess-game-card.tsx), which is what keeps chess.js
 * out of this file and out of the path of a chat. It draws what it is handed, in the
 * orientation it is given.
 *
 * A square is a BUTTON only where there is something to press: a spectator's board, and a
 * board whose game is over, are a grid of squares rather than a grid of controls.
 */

import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { ChessPiece, type ChessPieceKind } from "./chess-pieces";

export type ChessSquare = string;

export type ChessBoardSquare = {
  square: ChessSquare;
  piece: { kind: ChessPieceKind; color: ChessColor } | null;
};

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

export function ChessBoard(props: {
  /** a1…h8, rank-major. */
  squares: ChessBoardSquare[];
  orientation: ChessColor;
  selected: ChessSquare | null;
  targets: ChessSquare[];
  lastMove: [ChessSquare, ChessSquare] | null;
  check: ChessSquare | null;
  onSquare?: (square: ChessSquare) => void;
}) {
  const bySquare = new Map(props.squares.map((s) => [s.square, s]));
  const ranks = props.orientation === "w" ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = props.orientation === "w" ? FILES : [...FILES].reverse();
  const targets = new Set(props.targets);

  return (
    <div
      data-testid="chess-board"
      // The board is square whatever width the chat column gives it, and it never grows
      // past the words around it.
      className="grid aspect-square w-full grid-cols-8 overflow-hidden rounded-lg border border-border-subtle"
    >
      {ranks.map((rank) =>
        files.map((file) => {
          const name = `${file}${rank}`;
          const cell = bySquare.get(name);
          const light = (FILES.indexOf(file) + rank) % 2 === 1;
          const selected = props.selected === name;
          const target = targets.has(name);
          const lastMove = props.lastMove?.includes(name) === true;
          const Tag = props.onSquare ? "button" : "div";
          return (
            <Tag
              key={name}
              {...(props.onSquare ? { type: "button" as const, onClick: () => props.onSquare?.(name) } : {})}
              data-square={name}
              data-selected={selected ? "true" : undefined}
              data-target={target ? "true" : undefined}
              data-last-move={lastMove ? "true" : undefined}
              aria-label={cell?.piece ? `${name}, ${cell.piece.color === "w" ? "white" : "black"}` : name}
              className={cn(
                "relative grid place-items-center",
                light ? "bg-chess-light" : "bg-chess-dark",
                selected && "ring-2 ring-inset ring-primary",
                lastMove && !selected && "ring-1 ring-inset ring-primary/40",
                props.check === name && "bg-destructive/30",
              )}
            >
              {cell?.piece && <ChessPiece kind={cell.piece.kind} color={cell.piece.color} />}
              {/* A legal target: a dot on an empty square, a ring around a piece that can be
                  taken — which is how every chess board says the difference. */}
              {target && (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute",
                    cell?.piece
                      ? "inset-0 rounded-none ring-[3px] ring-inset ring-primary/70"
                      : "size-[22%] rounded-full bg-primary/60",
                  )}
                />
              )}
            </Tag>
          );
        }),
      )}
    </div>
  );
}
```

Add the two square colours to `web/src/styles/app.css`, beside the other project tokens (find the `@theme` block that declares `--color-border-subtle` and add them there so `bg-chess-light` / `bg-chess-dark` resolve in both themes):

```css
  --color-chess-light: oklch(0.92 0.02 85);
  --color-chess-dark: oklch(0.62 0.05 145);
```

and in the dark-theme block beside the other overrides:

```css
  --color-chess-light: oklch(0.56 0.02 85);
  --color-chess-dark: oklch(0.38 0.04 145);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && bun run test chess-board && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/chess-board.tsx web/src/components/chess-board.test.tsx web/src/styles/app.css
git commit -m "feat(chess): a board that knows the rules of nothing"
```

---

### Task 6: The store sends a chess message

**Files:**
- Modify: `web/src/lib/store.ts` — beside `sendDraft` (line ~5825)
- Test: covered by Task 11's E2E and by the mock; no unit test (the method is one `await` around `backend.send`).

**Interfaces:**
- Consumes: `chessMessageHtml`, `chessMessageText`, `type ChessWire` from `./chess-wire`.
- Produces on `TeamsController`:
  - `sendChessMessage(conversationId: string, wire: ChessWire): Promise<boolean>`
- Produces on the app state:
  - `chessError: string | null` — the sentence the card draws when a chess send failed.
  - `chessPending: { conversation: string; game: string; ply: number; san: string } | null` — the move that has left the page and not yet come back, so the board can draw it and take it back.

- [ ] **Step 1: Add the state**

In `web/src/lib/store.ts`, find the `AppState` type and its initial value, and add the two fields with the other per-conversation transients (beside `sendError`):

```ts
  /** Why the last chess message could not be sent. The composer's own rule applied to the
   *  board: this app never posts without the user, so it must never leave them believing it
   *  did — and a move that did not leave is invisible unless the board says so. */
  chessError: string | null;
  /** A move that has left this page and whose message has not come back yet. The board draws
   *  it at once (a chess board that waits for a round trip feels broken) and takes it back if
   *  the send fails. */
  chessPending: { conversation: string; game: string; ply: number; san: string } | null;
```

Initial value: `chessError: null, chessPending: null`.

- [ ] **Step 2: Add the method**

Beside `sendDraft`:

```ts
  /**
   * Post one chess message — a challenge, an accept, a move, a draw offer or a resignation.
   *
   * It rides the existing `send`, which is already the `OUTWARD_METHODS` entry that gates
   * every post this app makes: a move is the click the user just made, exactly as pressing
   * Enter in the composer is (see AGENTS.md § Chess in a conversation). Nothing here widens
   * that gate and there is no RPC of its own.
   *
   * A MOVE is drawn before it lands and taken back if the send fails, which is the rule
   * `removeSentWords` follows for the words: the failure is reported at the board rather
   * than swallowed into a cue.
   */
  async sendChessMessage(conversationId: string, wire: ChessWire): Promise<boolean> {
    const pending =
      wire.body.kind === "move"
        ? {
            conversation: conversationId,
            game: wire.game,
            ply: wire.body.ply,
            san: wire.body.san,
          }
        : null;
    if (pending) this.set({ chessPending: pending, chessError: null });
    else this.set({ chessError: null });
    try {
      await this.backend.send(
        conversationId,
        chessMessageText(wire),
        undefined,
        chessMessageHtml(wire),
      );
    } catch (e) {
      // The status line keeps the raw failure for whoever reads a screenshot; the board
      // gets the sentence the player acts on.
      this.set({
        status: `chess send failed: ${errText(e)}`,
        chessError: sendFailureMessage(e),
        // The move never left, so the board must not keep showing it.
        chessPending: this.get().chessPending === pending ? null : this.get().chessPending,
      });
      playCue("error");
      return false;
    }
    // The message itself is what clears a pending move: it arrives on the live feed, the
    // derivation picks it up, and the board is then drawing the thread rather than a guess.
    return true;
  }

  /** Forget a pending move once the thread really holds it, and forget a stale sentence when
   *  the reader moves to another conversation. Called by the board on every render pass. */
  settleChessPending(moves: number): void {
    const pending = this.get().chessPending;
    if (pending && moves >= pending.ply) this.set({ chessPending: null });
  }
```

Add the import at the top of the file beside the other `./` imports:

```ts
import { chessMessageHtml, chessMessageText, type ChessWire } from "./chess-wire";
```

- [ ] **Step 3: Clear the transients on a conversation change**

Find where `sendError` is reset when the open conversation changes (search `sendError: null` inside `openConversation`) and add `chessError: null` beside it. A sentence about a failed move must not hang over another chat — the rule `sendError` already follows.

- [ ] **Step 4: Typecheck**

Run: `cd web && bun run typecheck && bun run test`
Expected: PASS (no behaviour changed yet; nothing calls the new method).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/store.ts
git commit -m "feat(chess): one place posts a chess message, through the send that is already gated"
```

---

### Task 7: The game card

**Files:**
- Create: `web/src/components/chess-game-card.tsx`
- Modify: `web/package.json` (add `chess.js`)
- Test: `web/src/components/chess-game-card.test.tsx`

**Interfaces:**
- Consumes: `ChessGame`, `chessPlayerOf`, `chessGameIsSettled`, `chessTurnIsOurs` from `~/lib/chess-thread`; `ChessWire`, `ChessColor` from `~/lib/chess-wire`; `ChessBoard`, `ChessBoardSquare` from `./chess-board`; `useAppState`, `useController` from `./controller-context`; `Avatar` from `./avatar`.
- Produces:
  - `default` export `<ChessGameCard game={ChessGame} conversationId={string} className?={string} />` — **the default export is what `message-pane.tsx` lazy-loads.**

- [ ] **Step 1: Add the dependency**

```bash
cd web && bun add chess.js@1.4.0
```

Then confirm it is the version and licence the spec names:

Run: `cd web && cat node_modules/chess.js/package.json | head -20`
Expected: `"version": "1.4.0"`, `"license": "BSD-2-Clause"`, no `dependencies`.

- [ ] **Step 2: Write the failing test**

```tsx
// web/src/components/chess-game-card.test.tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ChessGame } from "~/lib/chess-thread";
import ChessGameCard from "./chess-game-card";

function game(over: Partial<ChessGame> = {}): ChessGame {
  return {
    id: "aaa111",
    challengeMessageId: "m1",
    challengeSeq: 1,
    challenger: { mri: "8:orgid:me", name: "Clement", isSelf: true },
    challengerColor: "w",
    opponent: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
    moves: [],
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
    absorbed: ["m1", "m2"],
    refusedPlies: [],
    ...over,
  };
}

describe("ChessGameCard", () => {
  it("replays the moves into a position", () => {
    // 1. e4 e5 — the two centre pawns have moved, so e2 and e7 are empty.
    const { container } = render(
      <ChessGameCard game={game({ moves: ["e4", "e5"], turn: "w" })} conversationId="19:c@thread.v2" />,
    );
    expect(container.querySelector('[data-square="e4"] [role="img"]')).toBeTruthy();
    expect(container.querySelector('[data-square="e2"] [role="img"]')).toBeNull();
    expect(container.querySelector('[data-square="e5"] [role="img"]')).toBeTruthy();
  });

  it("names both players and says whose move it is", () => {
    const { getByTestId } = render(
      <ChessGameCard game={game()} conversationId="19:c@thread.v2" />,
    );
    expect(getByTestId("chess-status").textContent).toContain("Your move");
  });

  it("says a game the thread cannot replay, rather than drawing a board that disagrees", () => {
    const { getByTestId } = render(
      // `Qh5` is not legal from the start, so the replay stops.
      <ChessGameCard game={game({ moves: ["e4", "Qh5"] })} conversationId="19:c@thread.v2" />,
    );
    expect(getByTestId("chess-status").textContent).toMatch(/cannot be replayed/i);
  });

  it("states a checkmate and offers no controls once the game is over", () => {
    const { getByTestId, queryByTestId } = render(
      <ChessGameCard
        // Fool's mate.
        game={game({ moves: ["f3", "e5", "g4", "Qh4#"], turn: "w" })}
        conversationId="19:c@thread.v2"
      />,
    );
    expect(getByTestId("chess-status").textContent).toMatch(/checkmate/i);
    expect(queryByTestId("chess-resign")).toBeNull();
  });

  it("states a resignation without asking the rules about it", () => {
    const { getByTestId } = render(
      <ChessGameCard
        game={game({ outcome: { kind: "resigned", by: "b" } })}
        conversationId="19:c@thread.v2"
      />,
    );
    expect(getByTestId("chess-status").textContent).toMatch(/resigned/i);
  });

  it("waits for an opponent while the challenge is open", () => {
    const { getByTestId, queryByTestId } = render(
      <ChessGameCard game={game({ opponent: null })} conversationId="19:c@thread.v2" />,
    );
    expect(getByTestId("chess-status").textContent).toMatch(/waiting/i);
    // Nobody may move into a game with one player.
    expect(queryByTestId("chess-board")?.querySelectorAll("button").length ?? 0).toBe(0);
  });

  it("draws a spectator's board with no controls at all", () => {
    const { queryByTestId } = render(
      <ChessGameCard
        game={game({
          ourColor: null,
          challenger: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
        })}
        conversationId="19:c@thread.v2"
      />,
    );
    expect(queryByTestId("chess-resign")).toBeNull();
    expect(queryByTestId("chess-board")?.querySelectorAll("button").length ?? 0).toBe(0);
  });

  it("lists the moves as a score sheet", () => {
    const { getByTestId } = render(
      <ChessGameCard game={game({ moves: ["e4", "e5", "Nf3"] })} conversationId="19:c@thread.v2" />,
    );
    expect(getByTestId("chess-moves").textContent).toContain("1. e4 e5");
    expect(getByTestId("chess-moves").textContent).toContain("2. Nf3");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && bun run test chess-game-card`
Expected: FAIL — `Failed to resolve import "./chess-game-card"`.

- [ ] **Step 4: Write the implementation**

```tsx
// web/src/components/chess-game-card.tsx
/**
 * One game of chess, drawn as a row in the history where it was started.
 *
 * This is the LAZY chunk and the only place `chess.js` is imported (§ The engine): the move
 * list the thread states is replayed into a position here, and what is legal is asked of the
 * rules rather than worked out. The pure half — which games exist, who plays, whose turn —
 * is `lib/chess-thread.ts` and carries no dependency, which is what keeps a rules engine off
 * the path of every chat.
 *
 * Three things this card owes the reader:
 *   - the board is oriented from THEIR side, and a spectator sees white at the bottom;
 *   - a move goes out on their press and is TAKEN BACK if the send fails, with the sentence
 *     here — the composer's rule, because a move that did not leave is otherwise invisible;
 *   - a move list the rules cannot replay is SAID, never drawn as a board that silently
 *     disagrees with the other player's.
 */

import { Chess, type Square } from "chess.js";
import { useMemo, useState } from "react";
import {
  chessGameIsSettled,
  chessPlayerOf,
  chessTurnIsOurs,
  type ChessGame,
} from "~/lib/chess-thread";
import type { ChessColor } from "~/lib/chess-wire";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { ChessBoard, type ChessBoardSquare } from "./chess-board";
import type { ChessPieceKind } from "./chess-pieces";
import { useAppState, useController } from "./controller-context";

/** What the rules say about the move list the thread holds. */
type Replay = {
  chess: Chess;
  /** The ply the replay stopped at, when a move was not legal. */
  brokeAt: number | null;
  lastMove: [string, string] | null;
};

function replay(moves: string[]): Replay {
  const chess = new Chess();
  let lastMove: [string, string] | null = null;
  for (let i = 0; i < moves.length; i += 1) {
    try {
      const made = chess.move(moves[i] as string);
      lastMove = [made.from, made.to];
    } catch {
      return { chess, brokeAt: i + 1, lastMove };
    }
  }
  return { chess, brokeAt: null, lastMove };
}

export default function ChessGameCard(props: {
  game: ChessGame;
  conversationId: string;
  className?: string;
}) {
  const controller = useController();
  const chessError = useAppState((s) => s.chessError);
  const pending = useAppState((s) => s.chessPending);
  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);
  const [armedResign, setArmedResign] = useState(false);

  const game = props.game;
  // A move this page has sent and not yet seen come back is drawn as if it had landed: a
  // board that waits for a round trip before it moves feels broken.
  const moves = useMemo(() => {
    if (pending && pending.game === game.id && pending.ply === game.moves.length + 1) {
      return [...game.moves, pending.san];
    }
    return game.moves;
  }, [game.id, game.moves, pending]);

  const { chess, brokeAt, lastMove } = useMemo(() => replay(moves), [moves]);
  const orientation: ChessColor = game.ourColor ?? "w";
  const settled = chessGameIsSettled(game) || chess.isGameOver() || brokeAt !== null;
  const ourMove =
    !settled && chessTurnIsOurs(game) && moves.length === game.moves.length && !!game.ourColor;

  const squares: ChessBoardSquare[] = useMemo(() => {
    const board = chess.board();
    const out: ChessBoardSquare[] = [];
    // chess.js gives rank 8 first; the board wants a1…h8, and it lays out orientation itself.
    for (let row = board.length - 1; row >= 0; row -= 1) {
      for (const cell of board[row] ?? []) {
        if (!cell) continue;
        out.push({ square: cell.square, piece: { kind: cell.type as ChessPieceKind, color: cell.color } });
      }
    }
    // Every empty square has to exist too, so the grid is complete.
    const held = new Set(out.map((s) => s.square));
    for (const rank of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const file of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        const name = `${file}${rank}`;
        if (!held.has(name)) out.push({ square: name, piece: null });
      }
    }
    return out;
  }, [chess]);

  const targets = useMemo(() => {
    if (!ourMove || !selected) return [];
    return chess.moves({ square: selected as Square, verbose: true }).map((m) => m.to);
  }, [chess, ourMove, selected]);

  const check = chess.inCheck()
    ? (squares.find((s) => s.piece?.kind === "k" && s.piece.color === chess.turn())?.square ?? null)
    : null;

  function press(square: string): void {
    if (!ourMove) return;
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (selected) {
      const legal = chess.moves({ square: selected as Square, verbose: true });
      const move = legal.find((m) => m.to === square);
      if (move) {
        setSelected(null);
        // A promotion is the one move the squares cannot say on their own.
        if (move.promotion) setPromotion({ from: move.from, to: move.to });
        else void send(move.san);
        return;
      }
    }
    // Selecting one's own piece, and nothing else: a press on an empty square with nothing
    // selected means nothing.
    const cell = squares.find((s) => s.square === square);
    if (cell?.piece && cell.piece.color === game.ourColor) setSelected(square);
    else setSelected(null);
  }

  async function send(san: string): Promise<void> {
    await controller.sendChessMessage(props.conversationId, {
      game: game.id,
      body: { kind: "move", ply: game.moves.length + 1, san },
    });
  }

  async function promote(piece: "q" | "r" | "b" | "n"): Promise<void> {
    if (!promotion) return;
    const probe = replay(game.moves).chess;
    const made = probe.move({ from: promotion.from, to: promotion.to, promotion: piece });
    setPromotion(null);
    await send(made.san);
  }

  return (
    <article
      data-testid="chess-game"
      data-chess-game={game.id}
      className={cn(
        "mx-auto w-full max-w-80 rounded-xl border border-border-subtle bg-surface p-3",
        props.className,
      )}
    >
      <ChessPlayers game={game} orientation={orientation} />
      <ChessBoard
        squares={squares}
        orientation={orientation}
        selected={selected}
        targets={targets}
        lastMove={lastMove}
        check={check}
        {...(ourMove ? { onSquare: press } : {})}
      />
      <p data-testid="chess-status" className="mt-2 text-xs text-text-dim">
        {statusOf(game, chess, brokeAt, ourMove)}
      </p>
      {moves.length > 0 && (
        <p
          data-testid="chess-moves"
          // One scrollable line of pairs, UNDER the board: this card sits in a chat column
          // that is a phone's width at its narrowest, and a second column there would take
          // the board down to nothing.
          className="mt-1 overflow-x-auto whitespace-nowrap text-[11px] text-text-faint"
        >
          {scoreSheet(moves)}
        </p>
      )}
      {chessError && (
        <p data-testid="chess-error" className="mt-1 text-[11px] text-destructive">
          {chessError}
        </p>
      )}
      {promotion && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-text-dim">Promote to</span>
          {(["q", "r", "b", "n"] as const).map((piece) => (
            <button
              key={piece}
              type="button"
              data-testid={`chess-promote-${piece}`}
              onClick={() => void promote(piece)}
              className="rounded-md border border-border-subtle px-2 py-0.5 text-xs hover:bg-accent"
            >
              {piece.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      {!settled && game.ourColor && game.opponent && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="chess-resign"
            onClick={() => {
              if (!armedResign) {
                setArmedResign(true);
                return;
              }
              setArmedResign(false);
              void controller.sendChessMessage(props.conversationId, {
                game: game.id,
                body: { kind: "resign" },
              });
            }}
            className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim hover:bg-accent"
          >
            {armedResign ? "Resign — no later message takes it back" : "Resign"}
          </button>
          {game.drawOfferedBy && game.drawOfferedBy !== game.ourColor ? (
            <button
              type="button"
              data-testid="chess-draw-accept"
              onClick={() =>
                void controller.sendChessMessage(props.conversationId, {
                  game: game.id,
                  body: { kind: "drawAccepted" },
                })
              }
              className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim hover:bg-accent"
            >
              Accept the draw
            </button>
          ) : (
            <button
              type="button"
              data-testid="chess-draw"
              onClick={() =>
                void controller.sendChessMessage(props.conversationId, {
                  game: game.id,
                  body: { kind: "draw" },
                })
              }
              className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-dim hover:bg-accent"
            >
              {game.drawOfferedBy === game.ourColor ? "Draw offered" : "Offer a draw"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/** Both players, black above the board and white below it — the way a board is read. */
function ChessPlayers(props: { game: ChessGame; orientation: ChessColor }) {
  const top = props.orientation === "w" ? "b" : "w";
  const player = chessPlayerOf(props.game, top as ChessColor);
  return (
    <header className="mb-2 flex items-center gap-2">
      <Avatar seed={player?.mri ?? props.game.id} label={player?.name ?? "Waiting…"} className="size-6" />
      <span className="truncate text-xs font-medium text-foreground">
        {player?.name ?? "Waiting for somebody to accept"}
      </span>
      <span className="ml-auto text-[11px] text-text-faint">
        {top === "w" ? "White" : "Black"}
      </span>
    </header>
  );
}

/** What the reader needs to know, in one line. The MESSAGE-decided outcomes come first:
 *  a resignation and an agreed draw are facts about the thread, not about the position. */
function statusOf(game: ChessGame, chess: Chess, brokeAt: number | null, ourMove: boolean): string {
  if (brokeAt !== null) {
    return `This game cannot be replayed — move ${brokeAt} is not legal here. Open it in a real chess client.`;
  }
  if (game.outcome.kind === "resigned") {
    const who = chessPlayerOf(game, game.outcome.by);
    return `${who?.isSelf ? "You" : (who?.name ?? "Somebody")} resigned.`;
  }
  if (game.outcome.kind === "drawAgreed") return "Draw agreed.";
  if (chess.isCheckmate()) {
    const loser = chessPlayerOf(game, chess.turn());
    return `Checkmate — ${loser?.isSelf ? "you lose" : `${loser?.name ?? "they"} lose`}.`;
  }
  if (chess.isStalemate()) return "Stalemate — a draw.";
  if (chess.isInsufficientMaterial()) return "A draw: neither side can mate.";
  if (chess.isDraw()) return "A draw.";
  if (!game.opponent) return "Waiting for somebody to accept.";
  if (game.refusedPlies.length > 0 && ourMove) return "Your move.";
  if (ourMove) return chess.inCheck() ? "Your move — you are in check." : "Your move.";
  const them = chessPlayerOf(game, chess.turn());
  return `Waiting for ${them?.name ?? "them"}.`;
}

/** `1. e4 e5  2. Nf3` — the way a score sheet reads. */
function scoreSheet(moves: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const white = moves[i];
    const black = moves[i + 1];
    out.push(`${i / 2 + 1}. ${white}${black ? ` ${black}` : ""}`);
  }
  return out.join("  ");
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd web && bun run test chess-game-card && bun run typecheck`
Expected: PASS. If a test that renders the card fails on `useAppState` outside a provider, wrap the render in the same test provider the other component tests use — check `web/src/components/message-bubble.test.tsx` for the pattern and follow it.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/bun.lock web/src/components/chess-game-card.tsx web/src/components/chess-game-card.test.tsx
git commit -m "feat(chess): the card replays the thread's moves and asks the rules what is legal"
```

---

### Task 8: The history draws one row per game

**Files:**
- Modify: `web/src/components/message-pane.tsx` — the `HistoryRow` union (line ~103), the rows memo (lines ~308-356), `estimateSize` (line ~364), the row renderer (line ~958)
- Test: covered by Task 11's E2E.

**Interfaces:**
- Consumes: `chessGamesInThread` from `~/lib/chess-thread`; the default export of `./chess-game-card` through `lazy`.
- Produces: `{ kind: "chess"; key: string; game: ChessGame }` on `HistoryRow`.

- [ ] **Step 1: Add the row kind and the lazy import**

Add to the top of `message-pane.tsx`, beside the other imports:

```ts
import { lazy, Suspense } from "react";
import { chessGamesInThread, type ChessGame } from "~/lib/chess-thread";

/** The board is the only surface in this app that needs a chess engine, so `chess.js` is
 *  reached through a lazy chunk and never sits on the path of a chat — the rule
 *  `@pierre/diffs` holds for the diff renderer (§ The DIFF is a PAGE). */
const ChessGameCard = lazy(() => import("./chess-game-card"));
```

(`lazy` and `Suspense` may already be imported from `react`; extend the existing import rather than adding a second.)

Extend the union:

```ts
type HistoryRow =
  | { kind: "message"; key: string; message: ChatMessage; prev?: ChatMessage; next?: ChatMessage }
  | { kind: "thread"; key: string; thread: Thread }
  | { kind: "agent"; key: string; run: AgentRun }
  | { kind: "recording"; key: string; recording: CallRecording }
  | { kind: "chess"; key: string; game: ChessGame };
```

- [ ] **Step 2: Derive the games and absorb their messages**

Above the rows memo, beside the other passes over the history:

```ts
  // Every game of chess this thread holds. A game IS its messages (see lib/chess-thread.ts),
  // so this is a pass over the history exactly as `messageTimeMarks` is, and for its reason:
  // the pane re-renders on every scroll that mounts a row while a game changes only when the
  // messages do. Channels are excluded: their history is drawn as THREADS, and a board inside
  // one is a different surface (see AGENTS.md § Chess in a conversation).
  const chessGames = useMemo(
    () => (threads ? [] : chessGamesInThread(messages)),
    [threads, messages],
  );
```

Inside the rows memo, in the `else` branch (the non-threaded one), replace the plain `messages.forEach` with a pass that absorbs:

```ts
    } else {
      // Every message of a game is ABSORBED into that game's own row, so a sixty-move game
      // adds nothing to the thread's length and the board does not move under the reader.
      const absorbedBy = new Map<string, ChessGame>();
      for (const game of chessGames) {
        for (const id of game.absorbed) absorbedBy.set(id, game);
      }
      messages.forEach((message, i) => {
        const game = absorbedBy.get(message.id);
        if (game) {
          // The board sits where the game STARTED, and every later message of it points at
          // that row — so a deep link from a notification lands on the board rather than on
          // a row that is not drawn.
          if (message.id === game.challengeMessageId) {
            rows.push({ kind: "chess", key: `chess:${game.id}`, game });
          }
          rowOfMessage.set(message.id, rows.length - 1);
          return;
        }
        rowOfMessage.set(message.id, rows.length);
        rows.push({
          kind: "message",
          key: message.id,
          message,
          prev: messages[i - 1],
          next: messages[i + 1],
        });
      });
    }
```

**Note:** the original code used the loop index `i` as the row index (`rowOfMessage.set(message.id, i)`), which is only correct while every message is exactly one row. With absorption it is not, so the index comes from `rows.length` as written above. `prev`/`next` deliberately stay the neighbouring MESSAGES rather than the neighbouring rows: they feed the same-author run and the time mark, and a chess row between two messages does not make them two different people.

Add `chessGames` to the memo's dependency list.

- [ ] **Step 3: Give the row its height**

In `estimateSize`:

```ts
    estimateSize: (index) => {
      const row = rows[index];
      // A board is a square as wide as the card plus its header, status and score sheet. A
      // row taller than its estimate is corrected by writing `scrollTop`, which is the twitch
      // e2e/history.spec.ts exists to catch — so the board is held at its own height.
      if (row?.kind === "chess") return CHESS_ROW_PX;
      const marked = row?.kind === "message" && timeMarks.has(row.message.id);
      return ROW_ESTIMATE_PX + (marked ? TIME_MARK_ROW_PX : 0);
    },
```

and beside `TIME_MARK_ROW_PX`'s declaration:

```ts
/** The room a chess row takes: a 320px board, its two-name header, the status line and the
 *  score sheet. It is a CONSTANT the estimate knows, for the reason `TIME_MARK_ROW_PX` is. */
const CHESS_ROW_PX = 420;
```

- [ ] **Step 4: Draw it**

In the row renderer, beside the `recording` and `agent` arms:

```tsx
                    ) : row.kind === "chess" ? (
                      // The game, drawn where it was started. It is not a message and takes
                      // no bubble, no side and no sender — the shape the recording card
                      // already has, for its reason: nothing here was said, the row IS the
                      // game the thread holds.
                      <Suspense
                        fallback={
                          <div
                            data-testid="chess-loading"
                            className="mx-auto my-2 w-full max-w-80 animate-pulse rounded-xl border border-border-subtle bg-surface"
                            style={{ height: `${CHESS_ROW_PX - 16}px` }}
                          />
                        }
                      >
                        <ChessGameCard
                          game={row.game}
                          conversationId={openId}
                          className="my-2"
                        />
                      </Suspense>
```

- [ ] **Step 5: Mount the header control**

In the header's control group (line ~874), between the call button and the agent menu:

```tsx
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <CallButton conversationId={openId} />
            <ChessButton conversationId={openId} games={chessGames} />
            <AgentMenu conversationId={openId} />
          </div>
```

with `import { ChessButton } from "./chess-button";` at the top. **Task 9 creates that component — do Task 9 before running the app.**

- [ ] **Step 6: Typecheck**

Run: `cd web && bun run typecheck`
Expected: FAIL on `./chess-button` only. That is the seam Task 9 closes; do not stub it.

- [ ] **Step 7: Commit (after Task 9 typechecks)**

Hold this commit until Task 9 is written, then commit both:

```bash
git add web/src/components/message-pane.tsx web/src/components/chess-button.tsx
git commit -m "feat(chess): a game is one row in the history, at the message that started it"
```

---

### Task 9: The header shortcut

**Files:**
- Create: `web/src/components/chess-button.tsx`
- Test: `web/src/components/chess-button.test.tsx`

**Interfaces:**
- Consumes: `ChessGame`, `activeChessGame`, `chessTurnIsOurs` from `~/lib/chess-thread`; `newChessGameId` from `~/lib/chess-wire`; `isGroupChat`, `convLabel` from `~/lib/protocol`; `useAppState`, `useController` from `./controller-context`; `Popover`, `PopoverContent`, `PopoverTrigger` from `./ui/popover`.
- Produces: `<ChessButton conversationId={string} games={ChessGame[]} />`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/chess-button.test.tsx
import { describe, expect, it } from "vitest";
import { chessChallengeLabel, chessButtonState } from "./chess-button";
import type { ChessGame } from "~/lib/chess-thread";

function game(over: Partial<ChessGame> = {}): ChessGame {
  return {
    id: "aaa111",
    challengeMessageId: "m1",
    challengeSeq: 1,
    challenger: { mri: "8:orgid:me", name: "Clement", isSelf: true },
    challengerColor: "w",
    opponent: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
    moves: [],
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
    absorbed: ["m1"],
    refusedPlies: [],
    ...over,
  };
}

describe("chessButtonState", () => {
  it("offers a challenge when no game is in flight", () => {
    expect(chessButtonState([])).toEqual({ kind: "challenge" });
    expect(chessButtonState([game({ outcome: { kind: "drawAgreed" } })])).toEqual({
      kind: "challenge",
    });
  });

  it("points at the live game, and says when it is the reader's move", () => {
    const live = game();
    expect(chessButtonState([live])).toEqual({ kind: "open", game: live, ourTurn: true });
    const theirs = game({ turn: "b" });
    expect(chessButtonState([theirs])).toEqual({ kind: "open", game: theirs, ourTurn: false });
  });
});

describe("chessChallengeLabel", () => {
  it("names the person in a 1:1 and the conversation in a group", () => {
    expect(chessChallengeLabel("Ada Lovelace", false)).toBe("Challenge Ada Lovelace");
    expect(chessChallengeLabel("Design crew", true)).toBe("Challenge Design crew — first to accept plays");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && bun run test chess-button`
Expected: FAIL — `Failed to resolve import "./chess-button"`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// web/src/components/chess-button.tsx
/**
 * The chess control in a conversation's header, beside the call button and the agent menu.
 *
 * Three states, and each is the reader's next move: with no game in flight it opens a
 * popover that CHALLENGES; with a game going it takes them to the board and carries a dot
 * when it is their turn; and in a conversation that cannot hold a game it is not drawn at
 * all — the call button's own discipline, that a control which cannot do the thing it names
 * is worse than no control.
 *
 * The press that challenges is an outward action: a message goes out under the user's name
 * and everybody in the conversation sees it. So the popover SAYS that before the press, and
 * a refusal is reported inside the popover rather than swallowed — the rule the approval menu
 * follows (§ The trackers).
 */

import { HugeiconsIcon } from "@hugeicons/react";
import { ChessPawnIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { activeChessGame, chessTurnIsOurs, type ChessGame } from "~/lib/chess-thread";
import { newChessGameId, type ChessColor } from "~/lib/chess-wire";
import { convLabel, isGroupChat } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** What the control is for, right now. Pure, so it is unit-tested without a DOM. */
export type ChessButtonState =
  | { kind: "challenge" }
  | { kind: "open"; game: ChessGame; ourTurn: boolean };

export function chessButtonState(games: ChessGame[]): ChessButtonState {
  const live = activeChessGame(games);
  if (!live) return { kind: "challenge" };
  return { kind: "open", game: live, ourTurn: chessTurnIsOurs(live) };
}

/** What the press reaches. In a group the challenge is open, and the label says so, because
 *  who the opponent will be is the one thing the user cannot know before the press. */
export function chessChallengeLabel(label: string, group: boolean): string {
  return group ? `Challenge ${label} — first to accept plays` : `Challenge ${label}`;
}

export function ChessButton(props: { conversationId: string; games: ChessGame[] }) {
  const controller = useController();
  const conversation = useAppState((s) => s.conversations.find((c) => c.id === props.conversationId));
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState<"w" | "b" | "random">("random");
  const [error, setError] = useState<string | null>(null);

  // A channel's history is drawn as threads, so it holds no board (see AGENTS.md); and Notes
  // — the chat with oneself — has nobody to play.
  if (!conversation || conversation.kind === "notes") return null;

  const state = chessButtonState(props.games);
  const group = isGroupChat(conversation);
  const label = conversation.name || convLabel(conversation);

  if (state.kind === "open") {
    return (
      <button
        type="button"
        data-testid="chess-button"
        data-conversation-id={props.conversationId}
        data-chess-game={state.game.id}
        aria-label={state.ourTurn ? "Your move — go to the board" : "Go to the chess board"}
        onClick={() => controller.requestScrollToMessage(props.conversationId, state.game.challengeMessageId)}
        className="relative grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={ChessPawnIcon} className="size-5" strokeWidth={1.6} />
        {state.ourTurn && (
          <span
            data-testid="chess-your-turn"
            aria-hidden
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
          />
        )}
      </button>
    );
  }

  async function challenge(): Promise<void> {
    const mine: ChessColor = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color;
    setError(null);
    const sent = await controller.sendChessMessage(props.conversationId, {
      game: newChessGameId(),
      body: { kind: "open", color: mine },
    });
    if (sent) setOpen(false);
    else setError("The challenge did not go out. Nothing was posted — try again.");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chess-button"
          data-conversation-id={props.conversationId}
          aria-label={chessChallengeLabel(label, group)}
          className="grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={ChessPawnIcon} className="size-5" strokeWidth={1.6} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <p className="text-sm font-medium text-foreground">{chessChallengeLabel(label, group)}</p>
        <div className="mt-2 flex items-center gap-1">
          {(["random", "w", "b"] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`chess-color-${option}`}
              onClick={() => setColor(option)}
              aria-pressed={color === option}
              className={
                color === option
                  ? "rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
                  : "rounded-md border border-border-subtle px-2 py-1 text-xs text-text-dim hover:bg-accent"
              }
            >
              {option === "random" ? "Random" : option === "w" ? "White" : "Black"}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-text-faint">
          This posts a message under your name, and everybody in this conversation sees it. They
          need teams-lite to play.
        </p>
        <button
          type="button"
          data-testid="chess-challenge"
          onClick={() => void challenge()}
          className="mt-2 w-full rounded-md bg-primary px-2 py-1.5 text-xs font-medium text-primary-foreground"
        >
          Send the challenge
        </button>
        {error && (
          <p data-testid="chess-challenge-error" className="mt-1 text-[11px] text-destructive">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

**Two things to check against the real code while writing this:** the name of the controller method that scrolls to a message (`requestScrollToMessage` — grep it in `web/src/lib/store.ts` and use its real signature), and the field that says a conversation is Notes (grep `ConversationKind` / `"notes"` in `web/src/lib/protocol.ts`). Both exist; use their real spellings rather than these.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && bun run test chess-button && bun run typecheck`
Expected: PASS, and Task 8's `message-pane.tsx` now typechecks too.

- [ ] **Step 5: Commit both**

```bash
git add web/src/components/chess-button.tsx web/src/components/chess-button.test.tsx web/src/components/message-pane.tsx
git commit -m "feat(chess): a shortcut in every conversation's header challenges, or goes to the board"
```

---

### Task 10: The mock plays the opponent

**Files:**
- Modify: `web/mock/server.ts` — beside `maybeRunMockAgent` in `scheduleSendEcho` (line ~8608), and the test-hook block (line ~9374)
- Test: exercised by Task 11.

**Interfaces:**
- Produces in the mock: `maybeAnswerMockChess(convId: string, msg: ChatMessage): void`, and a `{kind:"chess"}` test hook with `{ reply?: string; refuse?: boolean; reset?: boolean }`.

- [ ] **Step 1: Wire the hook point**

In `scheduleSendEcho`, beside the existing `maybeRunMockAgent(convId, msg);`:

```ts
    maybeRunMockAgent(convId, msg);
    maybeAnswerMockChess(convId, msg);
```

- [ ] **Step 2: Write the opponent**

Add near the agent simulation, importing `chess.js` at the top of the mock (`import { Chess } from "chess.js";`):

```ts
// ---------------------------------------------------------------------------
// Chess, answered (mirrors nothing in the backend — the whole feature is the page's).
//
// A game needs two machines, and the mock has one. So it plays the OPPONENT: it accepts a
// challenge and answers every move with a legal one, which is what makes the board, the turn
// dot and a whole game reviewable with no tenant and no colleague. It reads the same trailing
// line the page writes, because a mock that invented its own wire would hide the bug instead
// of failing a test.
// ---------------------------------------------------------------------------

/** How long the opponent takes to answer. Slow enough to watch, quick enough for a spec. */
const MOCK_CHESS_DELAY_MS = Number(process.env.MOCK_CHESS_DELAY_MS ?? 350);

/** Armed by the `{kind:"chess"}` test hook. A spec MUST reset it: one mock process serves
 *  the whole run, and an opponent left refusing breaks every later spec. */
let mockChessReply: string | null = null;
let mockChessRefuses = false;

/** The chess line a message carries, in the mock's own reading of the page's format. */
function mockChessWire(content: string): { game: string; rest: string } | null {
  const signature = /<p>\s*<em>\s*([^<]*?)\s*<\/em>\s*<\/p>\s*$/i.exec(content);
  if (!signature) return null;
  const line = /^—\s*chess\s+([0-9a-f]{6})\s+(.+?),\s*via teams-lite$/i.exec(signature[1] ?? "");
  return line ? { game: line[1] as string, rest: (line[2] as string).trim() } : null;
}

/** Answer the user's chess message as the other player would. */
function maybeAnswerMockChess(convId: string, msg: ChatMessage): void {
  if (mockChessRefuses) return;
  const wire = mockChessWire(msg.content);
  if (!wire) return;
  const t = threadFor(convId);
  if (!t) return;
  const other = otherPartyOf(convId);
  if (!other) return;

  // A challenge is accepted; a move is answered with a legal reply.
  if (wire.rest.startsWith("open ")) {
    setTimeout(() => postMockChess(convId, other, wire.game, "join", "♟ Chess — accepted."), MOCK_CHESS_DELAY_MS);
    return;
  }
  const move = /^(\d{1,3})\s+(\S+)$/.exec(wire.rest);
  if (!move) return;

  // Replay the game out of the thread, then pick a reply: the armed one when a spec named it,
  // otherwise the first legal move — deterministic, so a spec can assert on it.
  setTimeout(() => {
    const chess = new Chess();
    const sans: string[] = [];
    for (const m of t.messages) {
      const w = mockChessWire(m.content);
      if (!w || w.game !== wire.game) continue;
      const played = /^(\d{1,3})\s+(\S+)$/.exec(w.rest);
      if (!played) continue;
      try {
        chess.move(played[2] as string);
        sans.push(played[2] as string);
      } catch {
        return;
      }
    }
    const legal = chess.moves();
    const san = mockChessReply && legal.includes(mockChessReply) ? mockChessReply : legal[0];
    if (!san) return;
    const ply = sans.length + 1;
    const words = `♟ ${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "…"} ${san}`;
    postMockChess(convId, other, wire.game, `${ply} ${san}`, words);
  }, MOCK_CHESS_DELAY_MS);
}

/** Post one chess message as the other party, on the live feed the page really reads. */
function postMockChess(
  convId: string,
  who: { mri: string; name: string },
  game: string,
  kind: string,
  words: string,
): void {
  const t = threadFor(convId);
  if (!t) return;
  const seq = nextSeq(t.messages);
  const msg: ChatMessage = {
    id: `${convId}#${seq}`,
    conversation_id: convId,
    seq,
    compose_time: Date.now(),
    sender: who.name,
    sender_mri: who.mri,
    content: `<p>${words}</p><p><em>— chess ${game} ${kind}, via teams-lite</em></p>`,
    is_self: false,
  };
  t.messages.push(msg);
  t.recompute();
  broadcast("message", nicknamed(msg));
  broadcast(t.changedEvent, {});
}
```

**Find the real spellings before writing this:** `otherPartyOf` is a stand-in name — grep the mock for how it already resolves the colleague of a conversation (the seeds around line 1081 use an `other` object with `.mri` and `.name`), and use that. `nicknamed`, `broadcast`, `threadFor`, `nextSeq` and `t.recompute()` / `t.changedEvent` are all real and used exactly as `scheduleSendEcho` uses them.

- [ ] **Step 3: Add the test hook**

Beside the `agent_personas` hook (line ~9374):

```ts
    // Chess: arm the opponent's next reply, make it refuse to answer at all, or put it back.
    // A spec MUST reset — one mock process serves the whole run, and an opponent left refusing
    // breaks every later spec.
    if (body.kind === "chess") {
      if (body.reset === true) {
        mockChessReply = null;
        mockChessRefuses = false;
      }
      if (typeof body.reply === "string") mockChessReply = body.reply;
      if (typeof body.refuse === "boolean") mockChessRefuses = body.refuse;
      return { ok: true };
    }
```

- [ ] **Step 4: Check it runs**

Run: `cd web && bun run typecheck && MOCK_TEST_HOOKS=1 PORT=19465 timeout 5 bun run mock/server.ts`
Expected: the mock starts and prints its listening line; the timeout ends it.

- [ ] **Step 5: Commit**

```bash
git add web/mock/server.ts web/package.json
git commit -m "test(chess): the mock plays the opponent, so a game needs no second machine"
```

---

### Task 11: The capture and the E2E spec

**Files:**
- Modify: `web/scripts/preview.ts` — a `--chess` flag beside the others
- Create: `web/e2e/chess.spec.ts`

- [ ] **Step 1: Add the capture flag**

Read how `--call-recording` or `--available` is declared in `web/scripts/preview.ts` and follow it exactly. The `--chess` scene must: open the first 1:1, press `chess-button`, press `chess-challenge`, wait for `chess-game`, then capture

- `${out}-button-{light,dark}.png` cropped to `[data-testid="chess-button"]` at `--dpr 4` (the pawn is 20px)
- `${out}-challenge-{light,dark}.png` — the popover
- `${out}-board-{light,dark}.png` — the board after the mock accepted
- `${out}-mid-game.png` — after four moves, with the score sheet
- `${out}-mobile.png` at 390px

- [ ] **Step 2: Write the spec**

```ts
// web/e2e/chess.spec.ts
import { expect, test } from "@playwright/test";
// Follow the helpers the other specs in this directory use for opening the app and a
// conversation, and for the `{kind:"chess"}` test hook (grep `kind: "agent_personas"` in
// web/e2e for the hook helper's real name).

test.describe("chess in a conversation", () => {
  test.afterEach(async ({ request }) => {
    // One mock process serves the whole run: an armed opponent left behind breaks every
    // later spec.
    await testHook(request, { kind: "chess", reset: true });
  });

  test("a challenge from the header becomes one board row, and the opponent accepts", async ({ page }) => {
    await openFirstConversation(page);
    const before = await page.getByTestId("message-scroll").getAttribute("data-loaded-count");
    await page.getByTestId("chess-button").click();
    await page.getByTestId("chess-challenge").click();
    await expect(page.getByTestId("chess-game")).toBeVisible();
    // The mock accepts, and the board says whose move it is.
    await expect(page.getByTestId("chess-status")).toContainText(/your move|waiting for/i);
    // Two messages went out and came back, and the history grew by ONE row: the game absorbs
    // its own messages.
    expect(Number(await page.getByTestId("message-scroll").getAttribute("data-loaded-count"))).toBeGreaterThan(
      Number(before),
    );
    await expect(page.getByTestId("chess-game")).toHaveCount(1);
  });

  test("a move is played by pressing a square twice, and the opponent answers", async ({ page, request }) => {
    await testHook(request, { kind: "chess", reply: "e5" });
    await openFirstConversation(page);
    await page.getByTestId("chess-button").click();
    await page.getByTestId("chess-challenge").click();
    await expect(page.getByTestId("chess-game")).toBeVisible();
    // Only play when it is our move; the challenge picks a colour at random.
    const status = page.getByTestId("chess-status");
    if ((await status.textContent())?.match(/your move/i)) {
      await page.locator('[data-square="e2"]').click();
      await expect(page.locator('[data-square="e4"][data-target="true"]')).toBeVisible();
      await page.locator('[data-square="e4"]').click();
      await expect(page.getByTestId("chess-moves")).toContainText("1. e4");
      await expect(page.getByTestId("chess-moves")).toContainText("e5");
    }
  });

  test("a move that could not be sent is taken back, and the board says so", async ({ page, request }) => {
    // Use the mock's existing send-error hook (grep `testSendError` in web/mock/server.ts for
    // the hook that arms it) so the send is refused before anything is posted.
    await openFirstConversation(page);
    await page.getByTestId("chess-button").click();
    await page.getByTestId("chess-challenge").click();
    await expect(page.getByTestId("chess-game")).toBeVisible();
    await armSendError(request, "no");
    const status = page.getByTestId("chess-status");
    if ((await status.textContent())?.match(/your move/i)) {
      await page.locator('[data-square="e2"]').click();
      await page.locator('[data-square="e4"]').click();
      await expect(page.getByTestId("chess-error")).toBeVisible();
      // The piece is back where it was: nothing was posted.
      await expect(page.locator('[data-square="e2"] [role="img"]')).toBeVisible();
    }
    await armSendError(request, null);
  });

  test("resigning asks twice", async ({ page }) => {
    await openFirstConversation(page);
    await page.getByTestId("chess-button").click();
    await page.getByTestId("chess-challenge").click();
    await expect(page.getByTestId("chess-game")).toBeVisible();
    const resign = page.getByTestId("chess-resign");
    await resign.click();
    await expect(resign).toContainText(/no later message takes it back/i);
    await resign.click();
    await expect(page.getByTestId("chess-status")).toContainText(/resigned/i);
    // A settled game offers no controls.
    await expect(page.getByTestId("chess-resign")).toHaveCount(0);
  });

  test("the header points at a live game and says when it is our move", async ({ page }) => {
    await openFirstConversation(page);
    await page.getByTestId("chess-button").click();
    await page.getByTestId("chess-challenge").click();
    await expect(page.getByTestId("chess-game")).toBeVisible();
    await expect(page.getByTestId("chess-button")).toHaveAttribute("data-chess-game", /^[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 3: Run it on free ports**

Run: `cd web && E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468 bun run test:e2e chess`
Expected: PASS. Fix the spec against the real helper names as needed; do not weaken an assertion to make it pass.

- [ ] **Step 4: Run the whole suite, because the pane changed**

Run: `cd web && E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468 bun run test:e2e`
Expected: PASS. `history.spec.ts` and `notifications.spec.ts` are the two that matter most — the rows memo and `rowOfMessage` both changed.

- [ ] **Step 5: Capture and LOOK at the pieces**

Run: `cd web && bun run preview -- --out /tmp/chess --chess --dpr 2`
Then read `/tmp/chess-board-light.png` and `/tmp/chess-board-dark.png`. **If the two colours do not read as two armies, change `chess-pieces.tsx` to the Unicode glyphs and re-capture.** This is the decision the spec deferred to the capture.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/preview.ts web/e2e/chess.spec.ts web/src/components/chess-pieces.tsx
git commit -m "test(chess): pin the whole game against the mock, and capture the board"
```

---

### Task 12: AGENTS.md

**Files:**
- Modify: `AGENTS.md` — a new `## Chess in a conversation` section, after `## CUSTOM AGENTS`; and the `## Automation safety` capture list; and `## Project shape`'s web-app bullet.

- [ ] **Step 1: Write the section**

It must state, in the file's own voice, every rule a later reader could break: the wire is read from the words; a move is the click that consents to it and `send` is the gate it rides; the position is derived and nothing is stored; a game is one row at its challenge and absorbs its own messages; a channel holds no game and why; an illegal move is said rather than drawn; a failed move is taken back at the board; `chess.js` is a lazy chunk; the pieces come from hugeicons; the mock plays the opponent and its test hook must be reset; and that **the pairing is unverified against the tenant** — one real challenge accepted by a colleague running teams-lite is the user's own click, in the sandbox chat.

- [ ] **Step 2: Add the capture line**

In § Automation safety's list of preview scenes, beside the others:

```
  For a game of CHESS — the header control, the challenge popover, the board in both themes,
  a game in progress with its score sheet and the board at a phone's width:
  `bun run preview -- --out /tmp/chess --chess`.
```

- [ ] **Step 3: Name the two modules in § Project shape**

Add `chess-wire.ts` / `chess-thread.ts` to the web-app bullet the way the other pure modules are named.

- [ ] **Step 4: Full gate**

Run: `cd web && bun run test && bun run typecheck && E2E_MOCK_PORT=19467 E2E_WEB_PORT=19468 bun run test:e2e`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs(chess): write down every rule the board rests on"
```

---

## Self-Review

**Spec coverage.** Wire → Task 1. Preview strip → Task 3. Derivation, players, refusals, one-game-in-flight → Task 2. Board, orientation, tap-tap, targets → Tasks 4-5. Engine as a lazy chunk, replay, promotion, resign/draw arming, illegal-replay sentence, move list under the board → Task 7. Optimistic move + rollback + failure sentence → Tasks 6-7. One row at the challenge, absorption, `rowOfMessage`, `CHESS_ROW_PX` → Task 8. Header control, three states, colour choice with Random resolved at the press, refusal in the popover → Task 9. Mock opponent + test hook → Task 10. Capture + E2E → Task 11. Docs → Task 12. Channels excluded → Tasks 8 (the `threads` guard) and 9 (no control) and 12.

**Type consistency.** `ChessColor`, `ChessWire`, `ChessWireBody` are declared in Task 1 and used verbatim after. `ChessGame`'s field names in Task 2 are the ones Tasks 7-9 read (`challengeMessageId`, `challengerColor`, `ourColor`, `absorbed`, `refusedPlies`, `drawOfferedBy`, `outcome`). `ChessPieceKind` is declared in Task 4 and imported by Tasks 5 and 7. `ChessBoardSquare` is declared in Task 5 and built in Task 7. `sendChessMessage` / `chessError` / `chessPending` are declared in Task 6 and used in Tasks 7 and 9. `ChessGameCard` is a DEFAULT export in Task 7 because Task 8 lazy-loads it.

**Three names the implementer must verify against the real code rather than trusting this plan** (each is flagged at its step): the controller method that scrolls to a message, the field that marks a Notes conversation, and the mock's own way of naming the other party in a conversation.

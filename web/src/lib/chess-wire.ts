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

/** A move's `<ply> <san>` half. */
const MOVE = /^(\d{1,3})\s+(\S+)$/;

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
  const move = MOVE.exec(rest);
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

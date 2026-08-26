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
 *
 * TWO SHAPES LIVE HERE, and both are read.
 *
 *   - **v1, one message per act** (`— chess 7f3a1c 1 e4, via teams-lite`). Every game played
 *     before the ledger below is written this way, and it still replays: a sixty-move game is
 *     sixty messages, which is what the ledger exists to stop.
 *   - **v2, a LEDGER per player** (`— chess 7f3a1c v2 w open tc.600+0 at.… 1.e4.59830`). One
 *     message per player per game, EDITED in place as that player moves, so a sixty-move game
 *     is two messages. The full move list is the MERGE of the two ledgers by ply (see
 *     lib/chess-thread.ts).
 *
 * **WHY ONE LEDGER PER PLAYER RATHER THAN ONE PER GAME.** A single shared message is the
 * obvious shape and it is impossible: this app refuses to edit a message that is not the
 * user's own (§ Sending messages), and so does the backend before the network. So each player
 * keeps their OWN record and the game is the merge — which also keeps authorship exactly as
 * strong as it was when every move was its own message: a ply is signed by the player who
 * played it, and nobody can write a move into somebody else's ledger.
 *
 * **WHAT AN EDIT COSTS, stated because it is real.** An edit does not bump a conversation's
 * preview and does not push, so a colleague whose app is CLOSED is no longer buzzed by every
 * move — only by the challenge and the accept, which are sends. With a clock running that is
 * the honest trade: a game against somebody who is not looking is lost on time either way.
 */

import type { ChatMessage } from "./protocol";
import { withoutSignedLine } from "./wire-line";

/** Which side of the board. `w` and `b` are chess.js's own spelling, so the two halves of
 *  this feature never need a translation between them. */
export type ChessColor = "w" | "b";

/** A clock, as the wire states it: the base and the increment, in whole seconds. */
export type ChessTimeControl = { base: number; increment: number };

/** One ply in a player's own ledger. `clockMs` is what the mover had LEFT after playing it —
 *  their own reading, which is the only clock that exists here (see lib/chess-clock.ts). */
export type ChessLedgerMove = { ply: number; san: string; clockMs: number | null };

/**
 * One player's whole record of one game: what they did, when they last did it, and the moves
 * they played with the clock they had left after each.
 *
 * It is a STATE rather than a stream of events, because it is re-serialized on every move: the
 * reader's own build writes the whole line again, so a token that is no longer true is simply
 * not written. That is what makes an edited message honest — there is no history inside it to
 * disagree with itself.
 */
export type ChessLedger = {
  /** The author's own side. Required: it is what attributes every ply in the ledger. */
  color: ChessColor;
  /** This author OPENED the game — the challenge. Their ledger is the game's own root. */
  opened: boolean;
  /** This author ACCEPTED it. */
  joined: boolean;
  /** This author declined a challenge they were offered. */
  declined: boolean;
  /** The clock the game is played with. Stated by whoever OPENED it; a ledger that did not
   *  open the game may echo it, and the opener's is what counts. */
  time: ChessTimeControl | null;
  /**
   * The ELO of the engine this author is playing, when their opponent is not a person.
   *
   * Stockfish has no MRI: it cannot author a message and it cannot edit one, so a game against it
   * is ONE ledger — the reader's own — carrying BOTH sides' moves. That is the only place in this
   * feature where one author writes the other colour's plies, and this token is what makes it
   * legible: without it a ledger holding both parities is a ledger nobody can trust (see the parity
   * rule in `parseLedger`).
   */
  engineElo: number | null;
  /**
   * The moment this author last MOVED, by their own clock (epoch ms) — the moment their
   * opponent's clock therefore started. It is why a reload, a phone and an app that was closed
   * for an hour all draw the same two numbers.
   *
   * It is a MOVE and never "the newest thing I did", and the difference is load-bearing: a
   * draw offer, a resignation and a flag claim all leave it alone. One token doing both jobs
   * made a flag claim move the very moment it was checked against — the claim said "your clock
   * ran out", and by carrying its own time forward it also said the opponent's clock had only
   * just started, so the claim disproved itself. A test pins it.
   */
  at: number | null;
  /** This author's own plies, ascending. */
  moves: ChessLedgerMove[];
  /** A draw offered AFTER this ply — 0 before any move. An offer stands only while the game is
   *  still at that ply, so a move answers it by declining it with nothing to clear. */
  drawOfferedAt: number | null;
  /** A standing offer accepted at this ply. */
  drawAcceptedAt: number | null;
  /** This author resigns — or, before anybody accepted, withdraws their own challenge. */
  resigned: boolean;
  /**
   * How this author's own last move ENDED the game, when it did.
   *
   * The rules decide mate and stalemate, and only a board with `chess.js` in it can see them —
   * which the strip under the header and the conversation's menu deliberately do not have. So the
   * mover, who does have it, says so: `end.mate` is redundant with the SAN (which marks mate with
   * `#`) and `end.draw` is not, and both are CHECKABLE by the other side, whose own board replays
   * the same position. Without it a game somebody won by mate sat in the strip for ever, saying
   * it was somebody's move.
   */
  ended: "mate" | "draw" | null;
  /** This author claims that colour's clock ran out, AT this moment. Never their own: a flag is
   *  claimed by whoever is not on the clock, and the moment travels with it because the
   *  arithmetic is re-checked on the other machine before it is believed (see
   *  `chessFlagIsFair`). A claim carrying no moment is one nothing can check. */
  flagged: { color: ChessColor; at: number | null } | null;
};

/** What one v1 chess message says. */
export type ChessWireBody =
  | { kind: "open"; color: ChessColor; time?: ChessTimeControl | null }
  | { kind: "join" }
  | { kind: "decline" }
  | { kind: "move"; ply: number; san: string }
  | { kind: "draw" }
  | { kind: "drawAccepted" }
  | { kind: "resign" }
  /** v2: the whole of one player's record, in one line. */
  | { kind: "ledger"; ledger: ChessLedger };

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

/** The words a chess line opens with — the parameter `withoutSignedLine` finds it by. */
const CHESS_MARKER = "— chess ";

/** SAN's own shape, and nothing about legality: a piece letter, a file, or castling, then
 *  the squares, the capture, the promotion and the check marks. What is LEGAL is chess.js's
 *  answer (see components/chess-game-card.tsx) — this only refuses a token that could not
 *  be a move at all, which is what keeps a stray line out of a game. */
const SAN = /^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?$/;

/** A v1 move's `<ply> <san>` half. */
const MOVE = /^(\d{1,3})\s+(\S+)$/;

/** The version token a LEDGER opens with. A line this build cannot read leaves the message an
 *  ordinary message rather than a game with a hole in it, which is the rule an unknown v1 kind
 *  already follows — so a ledger from a NEWER build is drawn as the words it carries. */
const LEDGER_VERSION = "v2";

/**
 * A ledger's own move token: `<ply>.<san>` or `<ply>.<san>.<centiseconds-left>` — `1.e4.59830`,
 * which is chess's own notation for the first half of it.
 *
 * **THE SEPARATOR IS A FULL STOP AND MAY NEVER BE A COLON**, and that is not a matter of taste.
 * The backend substitutes custom emoji into every outbound body, on a send and on an edit alike,
 * and `custom_emoji::code_spans_in_text` matches `:name:` ANYWHERE in the text — no whitespace
 * needed before it — for any lowercase name in the user's own pack. A move written `1:e4:59830`
 * therefore holds the code span `:e4:`, and a pack with an emoji of that name (packs grow on
 * their own: § Custom emoji imports a colleague's) would replace it with an `<img …>` tag. That
 * breaks `SIGNATURE`'s own `[^<]*` and the game becomes unreadable — for BOTH players, for good,
 * with nothing left to repair it with, because the app can no longer see a game to edit. No colon
 * appears anywhere in a ledger line, and a test pins exactly that.
 *
 * Centiseconds rather than milliseconds keep a sixty-move line short, and 1/100 s is finer than
 * anything a clock is read at.
 */
const LEDGER_MOVE = /^(\d{1,3})\.([^.\s]+)(?:\.(\d{1,7}))?$/;

/** The clock, `tc.<base>+<increment>` in whole seconds. */
const LEDGER_TIME = /^tc\.(\d{1,5})\+(\d{1,4})$/;

/** How many of the author's own moves the WORDS carry. The line below them holds every one, so
 *  this is only what a stock Teams client and a sidebar preview show — and a preview that is
 *  four hundred characters of score sheet is a preview nobody reads. */
const WORDS_MOVES = 6;

/** The game id: six lowercase hex characters. Short enough to read in a sentence, wide
 *  enough (16.7M) that two games in one conversation cannot collide in practice. */
export function newChessGameId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An empty ledger for one side — what a challenge and an accept both start from. */
export function newChessLedger(color: ChessColor): ChessLedger {
  return {
    color,
    opened: false,
    joined: false,
    declined: false,
    time: null,
    engineElo: null,
    at: null,
    moves: [],
    drawOfferedAt: null,
    drawAcceptedAt: null,
    resigned: false,
    ended: null,
    flagged: null,
  };
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
  if (rest.startsWith(`${LEDGER_VERSION} `) || rest === LEDGER_VERSION) {
    const ledger = parseLedger(rest.slice(LEDGER_VERSION.length).trim());
    return ledger && { kind: "ledger", ledger };
  }
  if (rest === "open w") return { kind: "open", color: "w" };
  if (rest === "open b") return { kind: "open", color: "b" };
  if (rest === "join") return { kind: "join" };
  if (rest === "decline") return { kind: "decline" };
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

/**
 * One ledger, read out of its own tokens.
 *
 * Two rules make it survive the future: an UNKNOWN named token is IGNORED, so a build that
 * gains a token does not make its games unreadable to this one — and a malformed MOVE token
 * REFUSES the whole ledger, because a move list with a hole in it is a different game and
 * drawing it would be a board that silently disagrees with the other player's.
 */
function parseLedger(rest: string): ChessLedger | null {
  const tokens = rest.split(/\s+/).filter(Boolean);
  let color: ChessColor | null = null;
  const ledger = newChessLedger("w");
  const plies = new Map<number, ChessLedgerMove>();

  for (const token of tokens) {
    if (token === "w" || token === "b") {
      color = token;
      continue;
    }
    if (token === "open") {
      ledger.opened = true;
      continue;
    }
    if (token === "join") {
      ledger.joined = true;
      continue;
    }
    if (token === "decline") {
      ledger.declined = true;
      continue;
    }
    if (token === "resign") {
      ledger.resigned = true;
      continue;
    }
    if (token === "end.mate" || token === "end.draw") {
      ledger.ended = token === "end.mate" ? "mate" : "draw";
      continue;
    }
    const flag = /^flag\.(w|b)(?:\.(\d{1,15}))?$/.exec(token);
    if (flag) {
      ledger.flagged = {
        color: flag[1] === "w" ? "w" : "b",
        at: flag[2] === undefined ? null : Number(flag[2]),
      };
      continue;
    }
    // The ENGINE this author is playing, and its Elo. `sf` is Stockfish's own short name.
    const engine = /^sf\.(\d{3,4})$/.exec(token);
    if (engine) {
      ledger.engineElo = Number(engine[1]);
      continue;
    }
    const time = LEDGER_TIME.exec(token);
    if (time) {
      ledger.time = { base: Number(time[1]), increment: Number(time[2]) };
      continue;
    }
    const at = /^at\.(\d{1,15})$/.exec(token);
    if (at) {
      ledger.at = Number(at[1]);
      continue;
    }
    const draw = /^draw\.(\d{1,3})$/.exec(token);
    if (draw) {
      ledger.drawOfferedAt = Number(draw[1]);
      continue;
    }
    const drawOk = /^drawok\.(\d{1,3})$/.exec(token);
    if (drawOk) {
      ledger.drawAcceptedAt = Number(drawOk[1]);
      continue;
    }
    // A move is the one token that starts with a digit, so nothing named can be mistaken for
    // one — and a token that LOOKS like a move and is not readable as one refuses the ledger.
    if (/^\d/.test(token)) {
      const move = LEDGER_MOVE.exec(token);
      if (!move) return null;
      const ply = Number(move[1]);
      const san = move[2] ?? "";
      if (!Number.isInteger(ply) || ply < 1 || !SAN.test(san)) return null;
      const clock = move[3];
      plies.set(ply, {
        ply,
        san,
        // Centiseconds on the wire, milliseconds everywhere else: one unit inside the app.
        clockMs: clock === undefined ? null : Number(clock) * 10,
      });
      continue;
    }
    // Anything else is a token from a build that knows more than this one. Ignored on purpose.
  }

  if (!color) return null;
  ledger.color = color;
  ledger.moves = [...plies.values()].sort((a, b) => a.ply - b.ply);
  // Every ply in one player's ledger is theirs, so its parity is decided by their colour. A
  // ledger claiming the other side's ply is not a ledger this app can trust at all.
  //
  // THE ONE EXCEPTION is a game against an ENGINE, and it is the narrowest one there is: a ledger
  // that declares `sf.<elo>` is one whose author is playing a machine that cannot author a message,
  // so both sides' plies are theirs to write. An ordinary ledger can never reach it — the token has
  // to be there — and a ledger that claims an engine is a ledger claiming nothing about anybody
  // else: there is no second player for it to speak for.
  if (ledger.engineElo === null) {
    const wants = color === "w" ? 1 : 0;
    if (ledger.moves.some((m) => m.ply % 2 !== wants)) return null;
  }
  return ledger;
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
    case "decline":
      return "decline";
    case "move":
      return `${body.ply} ${body.san}`;
    case "draw":
      return "draw";
    case "drawAccepted":
      return "draw-ok";
    case "resign":
      return "resign";
    case "ledger":
      return `${LEDGER_VERSION} ${serializeLedger(body.ledger)}`;
  }
}

/**
 * A ledger's own tokens, in ONE deterministic order.
 *
 * Deterministic because the message is rewritten on every move: two builds holding the same
 * state must write the same line, or a test cannot pin it and a reader comparing two edits
 * would see a change that is not a change.
 */
export function serializeLedger(ledger: ChessLedger): string {
  const out: string[] = [ledger.color];
  if (ledger.opened) out.push("open");
  if (ledger.joined) out.push("join");
  if (ledger.declined) out.push("decline");
  if (ledger.time) out.push(`tc.${ledger.time.base}+${ledger.time.increment}`);
  if (ledger.engineElo !== null) out.push(`sf.${Math.round(ledger.engineElo)}`);
  if (ledger.at !== null) out.push(`at.${Math.round(ledger.at)}`);
  for (const move of [...ledger.moves].sort((a, b) => a.ply - b.ply)) {
    const clock = move.clockMs === null ? "" : `.${Math.max(0, Math.round(move.clockMs / 10))}`;
    out.push(`${move.ply}.${move.san}${clock}`);
  }
  if (ledger.drawOfferedAt !== null) out.push(`draw.${ledger.drawOfferedAt}`);
  if (ledger.drawAcceptedAt !== null) out.push(`drawok.${ledger.drawAcceptedAt}`);
  if (ledger.resigned) out.push("resign");
  if (ledger.ended) out.push(`end.${ledger.ended}`);
  if (ledger.flagged) {
    const at = ledger.flagged.at === null ? "" : `.${Math.round(ledger.flagged.at)}`;
    out.push(`flag.${ledger.flagged.color}${at}`);
  }
  return out.join(" ");
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
    case "decline":
      return "♟ Chess — not right now, thanks.";
    case "move":
      // Numbered the way a score sheet reads: by the MOVE, with an ellipsis for black.
      return `♟ ${Math.ceil(body.ply / 2)}${body.ply % 2 === 1 ? "." : "…"} ${body.san}`;
    case "draw":
      return "♟ Chess — I offer a draw.";
    case "drawAccepted":
      return "♟ Chess — I accept the draw.";
    case "resign":
      return "♟ Chess — I resign.";
    case "ledger":
      return ledgerWords(body.ledger);
  }
}

/**
 * What a LEDGER says in words. It is edited on every move, so this sentence is rewritten with
 * it — which is why it says the state rather than the event: "my moves so far", not "I played
 * e4", because a message whose words said one move and whose line held forty would be a
 * message that lies to every client but this one.
 */
function ledgerWords(ledger: ChessLedger): string {
  const parts: string[] = [];
  // A game against the ENGINE says so first: it is the one thing a colleague reading the thread
  // needs to know, because the message is the reader playing alone rather than an invitation.
  if (ledger.engineElo !== null) {
    parts.push(`I'm playing ${chessEngineName(ledger.engineElo)}.`);
    if (ledger.time) parts.push(`${clockWords(ledger.time)}.`);
  } else if (ledger.opened) {
    parts.push(`I'd like a game. I'm ${ledger.color === "w" ? "white" : "black"}.`);
    if (ledger.time) parts.push(`${clockWords(ledger.time)}.`);
  } else if (ledger.joined && ledger.moves.length === 0) {
    parts.push("accepted.");
  }
  if (ledger.moves.length > 0) {
    const shown = ledger.moves.slice(-WORDS_MOVES);
    const elided = shown.length < ledger.moves.length ? "… " : "";
    const list = shown
      .map((m) => `${Math.ceil(m.ply / 2)}${m.ply % 2 === 1 ? "." : "…"} ${m.san}`)
      .join(" ");
    // In an engine game the ledger holds BOTH sides, so the words say "moves" rather than "mine".
    parts.push(`${ledger.engineElo === null ? "my moves" : "moves"}: ${elided}${list}`);
  }
  if (ledger.drawAcceptedAt !== null) parts.push("I accept the draw.");
  else if (ledger.drawOfferedAt !== null) parts.push("I offer a draw.");
  if (ledger.resigned) parts.push("I resign.");
  if (ledger.ended === "mate") parts.push("Checkmate.");
  else if (ledger.ended === "draw") parts.push("That is a draw.");
  if (ledger.flagged) {
    parts.push(`${ledger.flagged.color === "w" ? "White" : "Black"} ran out of time.`);
  }
  if (ledger.declined) parts.push("not right now, thanks.");
  return `♟ Chess — ${parts.join(" ") || "a game."}`;
}

/**
 * What the engine is CALLED at one strength — the name a seat, a chip and a menu row all draw.
 *
 * One spelling, here, because five surfaces show it and the Elo is the only thing that tells two
 * engine games apart. The build is "Stockfish 18 Lite" (see src/chess_engine.rs); what a player
 * reads is the strength they chose, because that is the fact they picked.
 */
export function chessEngineName(elo: number): string {
  return `Stockfish ${Math.round(elo)}`;
}

/** A time control in words: `10 min`, `3 min + 2 s`, `no clock`. */
export function clockWords(time: ChessTimeControl | null): string {
  if (!time) return "no clock";
  const base =
    time.base % 60 === 0 ? `${time.base / 60} min` : `${Math.floor(time.base / 60)}:${String(time.base % 60).padStart(2, "0")}`;
  return time.increment > 0 ? `${base} + ${time.increment} s` : base;
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
 *  `♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite`.
 *
 *  **The rule lives in `wire-line.ts`, in ONE spelling for both features that sign a body this way**
 *  — this is that rule pointed at chess's own marker and grammar, and its Rust twin
 *  (`push_policy::without_wire_line`) is parameterised the same way. It matters here rather than
 *  being tidy: a v2 ledger crosses the preview's 120-character ceiling at the challenger's FIRST OWN
 *  MOVE (139 characters against 112 for the challenge alone), so every clocked game leaked a
 *  truncated wire onto its chat row from move one until the cut branch existed. */
export function chessPreviewText(preview: string): string {
  return withoutSignedLine(preview, CHESS_MARKER, CHESS_LINE);
}

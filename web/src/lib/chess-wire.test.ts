import { describe, expect, it } from "vitest";
import {
  chessMessageHtml,
  chessWireLine,
  chessMessageText,
  chessMessageWords,
  chessPreviewText,
  chessWireIn,
  clockWords,
  newChessGameId,
  newChessLedger,
  serializeLedger,
  type ChessLedger,
  type ChessWire,
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
    // A disambiguated move, which is the shape a middlegame really writes.
    expect(chessWireIn(message(body("— chess 7f3a1c 30 R1a3, via teams-lite")))?.body).toEqual({
      kind: "move",
      ply: 30,
      san: "R1a3",
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
    expect(chessWireIn(message(body("— chess 7f3a1 join, via teams-lite")))).toBeNull();
    expect(chessWireIn(message(body("— chess 7f3a1cc join, via teams-lite")))).toBeNull();
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
    const wires: ChessWire[] = [
      { game: "7f3a1c", body: { kind: "open", color: "w" } },
      { game: "7f3a1c", body: { kind: "open", color: "b" } },
      { game: "7f3a1c", body: { kind: "join" } },
      { game: "7f3a1c", body: { kind: "move", ply: 7, san: "Nf3" } },
      { game: "7f3a1c", body: { kind: "draw" } },
      { game: "7f3a1c", body: { kind: "drawAccepted" } },
      { game: "7f3a1c", body: { kind: "resign" } },
    ];
    for (const wire of wires) {
      expect(chessWireIn(message(chessMessageHtml(wire)))).toEqual(wire);
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

describe("chessMessageText", () => {
  it("carries the same two halves as the HTML, for a client that shows none", () => {
    const text = chessMessageText({ game: "7f3a1c", body: { kind: "move", ply: 1, san: "e4" } });
    expect(text).toBe("♟ 1. e4\n— chess 7f3a1c 1 e4, via teams-lite");
  });
});

describe("chessPreviewText", () => {
  it("takes the marker off a sidebar preview and leaves the words", () => {
    expect(chessPreviewText("♟ 1. e4 — chess 7f3a1c 1 e4, via teams-lite")).toBe("♟ 1. e4");
  });

  it("takes it off a preview the backend flattened with a newline", () => {
    expect(chessPreviewText("♟ 1. e4\n— chess 7f3a1c 1 e4, via teams-lite")).toBe("♟ 1. e4");
  });

  it("leaves an ordinary preview alone", () => {
    expect(chessPreviewText("on my way")).toBe("on my way");
    expect(chessPreviewText("")).toBe("");
    // An agent's signature is not ours to strip.
    expect(chessPreviewText("done — claude, via teams-lite")).toBe("done — claude, via teams-lite");
  });
});

// ---- v2, the LEDGER --------------------------------------------------------------
//
// One message per player per game, EDITED as they move. Every test here is about the one thing
// that makes it safe: the line is a STATE, so it is written whole every time and read whole
// back, and a line this build cannot trust is refused rather than read with a hole in it.
describe("a ledger", () => {
  /** White's own record: they opened a ten-minute game and have played two moves. */
  function white(): ChessLedger {
    return {
      ...newChessLedger("w"),
      opened: true,
      time: { base: 600, increment: 0 },
      at: 1_700_000_123_456,
      moves: [
        { ply: 1, san: "e4", clockMs: 598_300 },
        { ply: 3, san: "Nf3", clockMs: 592_000 },
      ],
    };
  }

  it("round-trips through the body a send really posts", () => {
    const wire: ChessWire = { game: "7f3a1c", body: { kind: "ledger", ledger: white() } };
    expect(chessWireIn(message(chessMessageHtml(wire)))).toEqual(wire);
  });

  it("writes ONE deterministic line, so two builds holding one state write one line", () => {
    expect(serializeLedger(white())).toBe(
      "w open tc.600+0 at.1700000123456 1.e4.59830 3.Nf3.59200",
    );
    // The tokens are ordered by what they are rather than by when they were added, so a state
    // reached two ways serializes the same.
    const shuffled: ChessLedger = { ...white(), moves: [...white().moves].reverse() };
    expect(serializeLedger(shuffled)).toBe(serializeLedger(white()));
  });

  it("carries every act a game needs, and reads each one back", () => {
    const ledger: ChessLedger = {
      ...newChessLedger("b"),
      joined: true,
      at: 42,
      moves: [{ ply: 2, san: "e5", clockMs: null }],
      drawOfferedAt: 2,
      resigned: true,
      // A flag claim carries its OWN moment: `at:` is when this author last MOVED, and a claim
      // that moved it would move the very instant it is checked against.
      flagged: { color: "w", at: 1_700_000_222_222 },
    };
    const line = serializeLedger(ledger);
    expect(line).toBe("b join at.42 2.e5 draw.2 resign flag.w.1700000222222");
    const read = chessWireIn(message(body(`— chess 7f3a1c v2 ${line}, via teams-lite`)));
    expect(read?.body).toEqual({ kind: "ledger", ledger });
  });

  it("IGNORES a token it does not know, so a newer build's game still replays", () => {
    const read = chessWireIn(
      message(body("— chess 7f3a1c v2 w open sparkle.9 1.e4.59830, via teams-lite")),
    );
    expect(read?.body.kind).toBe("ledger");
    expect(read?.body.kind === "ledger" && read.body.ledger.moves).toEqual([
      { ply: 1, san: "e4", clockMs: 598_300 },
    ]);
  });

  it("REFUSES the whole ledger for a move it cannot read, rather than dropping the move", () => {
    // A move list with a hole in it is a different game, and drawing it would be a board that
    // silently disagrees with the other player's.
    expect(chessWireIn(message(body("— chess 7f3a1c v2 w 1.e4 2, via teams-lite")))).toBeNull();
    expect(
      chessWireIn(message(body("— chess 7f3a1c v2 w 1.<b>e4</b>, via teams-lite"))),
    ).toBeNull();
    expect(chessWireIn(message(body("— chess 7f3a1c v2 w 0.e4, via teams-lite")))).toBeNull();
  });

  it("REFUSES a ledger that claims the other side's ply", () => {
    // Every ply in one player's ledger is theirs, so its parity is decided by their colour:
    // white's second ply is 3, never 2. A ledger that says otherwise cannot be trusted at all.
    expect(chessWireIn(message(body("— chess 7f3a1c v2 w 2.e5, via teams-lite")))).toBeNull();
    expect(chessWireIn(message(body("— chess 7f3a1c v2 b 1.e4, via teams-lite")))).toBeNull();
  });

  it("REFUSES a ledger with no colour on it, and reads a bare one with nothing in it", () => {
    expect(chessWireIn(message(body("— chess 7f3a1c v2 open, via teams-lite")))).toBeNull();
    expect(chessWireIn(message(body("— chess 7f3a1c v2 w, via teams-lite")))?.body).toEqual({
      kind: "ledger",
      ledger: newChessLedger("w"),
    });
  });

  it("leaves a v3 line an ordinary message, which is what an unknown v1 kind already does", () => {
    expect(chessWireIn(message(body("— chess 7f3a1c v3 w 1.e4, via teams-lite")))).toBeNull();
  });

  it("says in WORDS what a stock Teams client is shown, bounded so a preview stays a line", () => {
    expect(chessMessageWords({ kind: "ledger", ledger: white() })).toBe(
      "♟ Chess — I'd like a game. I'm white. 10 min. my moves: 1. e4 2. Nf3",
    );
    // Seven moves in, the oldest give way: the line below the words holds every one of them.
    const long: ChessLedger = {
      ...white(),
      moves: Array.from({ length: 8 }, (_, i) => ({
        ply: i * 2 + 1,
        san: "Nf3",
        clockMs: null,
      })),
    };
    const words = chessMessageWords({ kind: "ledger", ledger: long });
    expect(words).toContain("…");
    expect(words).toContain("8. Nf3");
    expect(words).not.toContain("1. Nf3");
    // And the terminal acts are said in words too, because they are what a colleague reads.
    expect(
      chessMessageWords({ kind: "ledger", ledger: { ...white(), resigned: true } }),
    ).toContain("I resign.");
    expect(
      chessMessageWords({ kind: "ledger", ledger: { ...white(), flagged: { color: "b", at: 1 } } }),
    ).toContain("Black ran out of time.");
  });

  it("NEVER WRITES A COLON, because a colon is a custom emoji code", () => {
    // `custom_emoji::code_spans_in_text` matches `:name:` anywhere in an outbound body, so a move
    // written `1:e4:59830` holds the span `:e4:` — and a pack with an emoji of that name would
    // replace it with an `<img>`, which breaks the signature and loses the game for both players
    // with nothing left to repair it with. Every separator is a full stop.
    const everything: ChessLedger = {
      ...white(),
      joined: true,
      declined: true,
      drawOfferedAt: 3,
      drawAcceptedAt: 3,
      resigned: true,
      flagged: { color: "b", at: 1_700_000_222_222 },
    };
    expect(serializeLedger(everything)).not.toContain(":");
    // And the whole body a send posts holds none either, outside the markup itself.
    const line = chessWireLine({ game: "7f3a1c", body: { kind: "ledger", ledger: everything } });
    expect(line).not.toContain(":");
  });

  it("is stripped out of a sidebar preview like every other chess line", () => {
    const wire: ChessWire = { game: "7f3a1c", body: { kind: "ledger", ledger: white() } };
    expect(chessPreviewText(chessMessageText(wire))).toBe(chessMessageWords(wire.body));
  });
});

describe("clockWords", () => {
  it("says a time control the way a player says one", () => {
    expect(clockWords(null)).toBe("no clock");
    expect(clockWords({ base: 600, increment: 0 })).toBe("10 min");
    expect(clockWords({ base: 180, increment: 2 })).toBe("3 min + 2 s");
    expect(clockWords({ base: 90, increment: 0 })).toBe("1:30");
  });
});

describe("newChessGameId", () => {
  it("mints six lowercase hex characters that the reader can read back", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = newChessGameId();
      expect(id).toMatch(/^[0-9a-f]{6}$/);
      const wire: ChessWire = { game: id, body: { kind: "join" } };
      expect(chessWireIn(message(chessMessageHtml(wire)))).toEqual(wire);
    }
  });
});

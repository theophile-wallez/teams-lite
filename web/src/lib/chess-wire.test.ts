import { describe, expect, it } from "vitest";
import {
  chessMessageHtml,
  chessMessageText,
  chessMessageWords,
  chessPreviewText,
  chessWireIn,
  newChessGameId,
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

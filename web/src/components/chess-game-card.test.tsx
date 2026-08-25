import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChessGame } from "~/lib/chess-thread";
import ChessGameCard from "./chess-game-card";
import { ControllerProvider } from "./controller-context";

/** A backend URL nothing listens on: the provider only constructs a client here. It is needed
 *  because the card draws real faces, and an avatar resolves its photo through the controller. */
const OFFLINE_URL = "ws://127.0.0.1:1";

function game(over: Partial<ChessGame> = {}): ChessGame {
  return {
    id: "aaa111",
    challengeMessageId: "m1",
    challengeSeq: 1,
    challenger: { mri: "8:orgid:me", name: "Clement", isSelf: true },
    challengerColor: "w",
    opponent: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
    moves: [],
    moveClocks: [],
    time: null,
    startedAt: null,
    actedAt: { w: null, b: null },
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
    ledgers: { w: null, b: null },
    endedByRules: null,
    engine: null,
    absorbed: ["m1", "m2"],
    refusedPlies: [],
    ...over,
  };
}

/** Server-rendered, which is this repo's component-test convention. */
function render(over: Partial<ChessGame> = {}): string {
  return renderToStaticMarkup(
    <ControllerProvider url={OFFLINE_URL}>
      <ChessGameCard game={game(over)} conversationId="19:c@thread.v2" />
    </ControllerProvider>,
  );
}

/** Whether a square holds a piece, read out of the markup. */
function occupied(html: string, square: string): boolean {
  const at = html.indexOf(`data-square="${square}"`);
  if (at < 0) return false;
  // The piece, when there is one, is the next thing inside that square's element.
  const next = html.indexOf("data-square=", at + 1);
  const cell = html.slice(at, next < 0 ? undefined : next);
  return cell.includes("data-piece=");
}

function status(html: string): string {
  const at = html.indexOf('data-testid="chess-status"');
  return html.slice(at, at + 400);
}

describe("ChessGameCard", () => {
  it("replays the moves into a position", () => {
    // 1. e4 e5 — the two centre pawns have moved, so e2 and e7 are empty and e4/e5 are not.
    const html = render({ moves: ["e4", "e5"], turn: "w" });
    expect(occupied(html, "e4")).toBe(true);
    expect(occupied(html, "e5")).toBe(true);
    expect(occupied(html, "e2")).toBe(false);
    expect(occupied(html, "e7")).toBe(false);
  });

  it("draws the opening position for a game nobody has moved in", () => {
    const html = render();
    expect(occupied(html, "e2")).toBe(true);
    expect(occupied(html, "d8")).toBe(true);
    expect(occupied(html, "e4")).toBe(false);
  });

  it("names both players, the reader as themselves", () => {
    const html = render();
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("You");
    expect(html).toContain("White");
    expect(html).toContain("Black");
  });

  it("orients the board from the reader's own side, and white's way for a spectator", () => {
    expect(render({ ourColor: "b" })).toContain('data-orientation="b"');
    expect(render({ ourColor: "w" })).toContain('data-orientation="w"');
    expect(render({ ourColor: null })).toContain('data-orientation="w"');
  });

  it("SAYS a game the thread cannot replay, rather than drawing a board that disagrees", () => {
    // `Qh5` is not legal from the start, so the replay stops at the second move.
    const html = render({ moves: ["e4", "Qh5"] });
    expect(status(html)).toMatch(/cannot be replayed/i);
    expect(status(html)).toContain("move 2");
  });

  it("states a checkmate from the position, and the loser", () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#
    const html = render({ moves: ["f3", "e5", "g4", "Qh4#"], turn: "w", ourColor: "w" });
    expect(status(html)).toMatch(/checkmate/i);
    expect(status(html)).toMatch(/you lost/i);
  });

  it("states a stalemate as a draw, which is a fact only the rules can see", () => {
    // The shortest stalemate known, verified against chess.js: black is not in check and has
    // no legal move. Nothing in the THREAD says the game ended, so this can only come from
    // the position — which is the whole reason the card asks the rules at all.
    const html = render({
      moves: [
        "e3", "a5", "Qh5", "Ra6", "Qxa5", "h5", "Qxc7", "Rah6", "h4", "f6",
        "Qxd7+", "Kf7", "Qxb7", "Qd3", "Qxb8", "Qh7", "Qxc8", "Kg6", "Qe6",
      ],
      turn: "b",
      outcome: { kind: "playing" },
    });
    expect(status(html)).toMatch(/stalemate/i);
    // And a settled game offers nothing to press.
    expect(html.match(/<button/g)).toBeNull();
  });

  it("states a resignation without asking the rules about it", () => {
    const html = render({ outcome: { kind: "resigned", by: "b" } });
    expect(status(html)).toContain("Ada Lovelace resigned");
    // And a resignation of the reader's own is theirs.
    expect(status(render({ outcome: { kind: "resigned", by: "w" } }))).toContain("You resigned");
  });

  it("states an agreed draw", () => {
    expect(status(render({ outcome: { kind: "drawAgreed" } }))).toContain("Draw agreed");
  });

  it("draws an EMPTY SEAT for a side nobody holds, and never a person's initials", () => {
    // Tinted initials are how this app draws a colleague with no photo, so "Nobody yet" reduced
    // to `NY` was ink naming nobody. The seat is drawn as a seat instead.
    const html = render({ opponent: null });
    expect(html).not.toContain("Nobody yet");
    expect(html).toContain("border-dashed");
  });

  it("says whose the empty seat IS, from the reader's own side", () => {
    // The challenger is waiting for anybody; the person challenged is looking at their own seat,
    // and telling them somebody else is awaited is the mistake the status line already made.
    expect(render({ opponent: null })).toContain("Waiting for somebody");
    const challenged = render({
      opponent: null,
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
    });
    expect(challenged).toContain("You, if you accept");
    // And a challenge nobody took is nobody's seat any more.
    const declined = render({
      opponent: null,
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
      outcome: { kind: "declined", withdrawn: false },
    });
    expect(declined).not.toContain("You, if you accept");
  });

  it("waits for an opponent while the challenge is open, and offers to take it back", () => {
    const html = render({ opponent: null });
    expect(status(html)).toMatch(/waiting for somebody to accept/i);
    // The challenger's own way out, which is what frees the conversation for another game.
    expect(html).toContain('data-testid="chess-withdraw"');
    // They are not offered an answer to their own challenge, and nobody may move yet.
    expect(html).not.toContain('data-testid="chess-accept"');
    expect(html).not.toContain('data-testid="chess-resign"');
  });

  it("OFFERS THE ANSWER to somebody who was challenged, and says who asked", () => {
    // The bug this test exists for: the challenged player's side of a fresh challenge used to be
    // a board with nothing to press at all, because the mock accepted on its own.
    const html = render({
      opponent: null,
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
      challengerColor: "w",
    });
    expect(html).toContain('data-testid="chess-accept"');
    expect(html).toContain('data-testid="chess-decline"');
    // It says WHO asked and which side the reader would take — the two facts they answer with.
    expect(status(html)).toContain("Ada Lovelace challenged you");
    expect(status(html)).toContain("black");
    // And never the challenger's own sentence, which reads as if they were the one waiting.
    expect(status(html)).not.toMatch(/waiting for somebody to accept/i);
    expect(html).not.toContain('data-testid="chess-withdraw"');
  });

  it("names the side the challenged reader would take, from the challenger's colour", () => {
    const asWhite = render({
      opponent: null,
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada", isSelf: false },
      challengerColor: "b",
    });
    expect(status(asWhite)).toContain("white");
  });

  it("states a declined challenge and a withdrawn one apart, and neither as a loss", () => {
    expect(status(render({ outcome: { kind: "declined", withdrawn: false } }))).toContain(
      "Challenge declined",
    );
    const withdrawn = status(render({ outcome: { kind: "declined", withdrawn: true } }));
    expect(withdrawn).toContain("withdrew the challenge");
    // Nobody lost a game that never started.
    expect(withdrawn).not.toMatch(/resigned|checkmate/i);
  });

  it("draws a spectator's board with no controls at all", () => {
    const html = render({
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
      opponent: { mri: "8:orgid:grace", name: "Grace Hopper", isSelf: false },
    });
    expect(html.match(/<button/g)).toBeNull();
    expect(status(html)).toMatch(/waiting for/i);
  });

  it("offers no ACT on a settled game — and offers another game instead", () => {
    const html = render({ outcome: { kind: "resigned", by: "b" } });
    // Nothing can be done to a game that is over: no resignation, no draw, no flag to claim.
    for (const control of ["chess-resign", "chess-draw", "chess-claim-flag", "chess-accept"]) {
      expect(html).not.toContain(`data-testid="${control}"`);
    }
    // A REMATCH is the one thing a finished game offers, and it INVERTS the colours: we were white.
    expect(html).toContain('data-testid="chess-rematch"');
    expect(html).toContain('data-rematch-color="b"');
    expect(html).toContain("you take black");
  });

  it("offers no rematch for a game the reader watched, or one nobody played", () => {
    // Somebody else's finished game is not the reader's to replay — it would post a challenge under
    // their name for two other people's series.
    const watched = render({
      ourColor: null,
      challenger: { mri: "8:orgid:ada", name: "Ada Lovelace", isSelf: false },
      opponent: { mri: "8:orgid:grace", name: "Grace Hopper", isSelf: false },
      outcome: { kind: "resigned", by: "b" },
    });
    expect(watched).not.toContain('data-testid="chess-rematch"');
    // And a challenge nobody took up was never a game, so "again" names nothing.
    const declined = render({ opponent: null, outcome: { kind: "declined", withdrawn: false } });
    expect(declined).not.toContain('data-testid="chess-rematch"');
  });

  it("says what each side has TAKEN, and how far up it leaves them", () => {
    // 1. e4 d5 2. exd5 — white has taken a pawn and is a point up; black has taken nothing.
    const html = render({ moves: ["e4", "d5", "exd5"], turn: "b" });
    expect(html).toContain('data-testid="chess-captured-w"');
    // Black's pawn, in black's own glyph, and the delta signed from each side's own point of view.
    expect(html).toContain("♟");
    expect(html).toContain('data-delta="1"');
    expect(html).toContain('data-delta="-1"');
    // The words, because a glyph says nothing to a screen reader.
    expect(html).toContain("1 pawn");
  });

  it("says nothing about material at the starting position", () => {
    // Nothing taken and nothing between them: two lines that would say neither.
    const html = render();
    expect(html).not.toContain('data-testid="chess-captured-w"');
    expect(html).not.toContain('data-testid="chess-captured-b"');
  });

  it("lists the moves as a score sheet", () => {
    const html = render({ moves: ["e4", "e5", "Nf3"] });
    expect(html).toContain("1. e4 e5");
    expect(html).toContain("2. Nf3");
  });

  it("names the game it is, so a spec and the header can find it", () => {
    expect(render()).toContain('data-chess-game="aaa111"');
  });
});

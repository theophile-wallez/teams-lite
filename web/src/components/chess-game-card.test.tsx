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
    turn: "w",
    drawOfferedBy: null,
    outcome: { kind: "playing" },
    ourColor: "w",
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

  it("waits for an opponent while the challenge is open, and nobody may move", () => {
    const html = render({ opponent: null });
    expect(status(html)).toMatch(/waiting for somebody to accept/i);
    expect(html.match(/<button/g)).toBeNull();
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

  it("offers no controls once a game is settled", () => {
    expect(render({ outcome: { kind: "resigned", by: "b" } }).match(/<button/g)).toBeNull();
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

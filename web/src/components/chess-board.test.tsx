import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChessBoard } from "./chess-board";

/** The opening position, and one with the two centre pawns out. */
const OPENING = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const AFTER_E4_E5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3";

function render(over: Partial<Parameters<typeof ChessBoard>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChessBoard
      id="chess-test"
      fen={OPENING}
      orientation="w"
      playable={null}
      selected={null}
      targets={[]}
      lastMove={null}
      check={null}
      premove={null}
      {...over}
    />,
  );
}

/** The squares in the order they are drawn. */
function drawn(html: string): string[] {
  return [...html.matchAll(/data-square="([a-h][1-8])"/g)].map((m) => m[1] as string);
}

/** Whether a square holds a piece: the renderer nests the piece inside the square. */
function occupied(html: string, square: string): boolean {
  const at = html.indexOf(`data-square="${square}"`);
  if (at < 0) return false;
  const next = html.indexOf("data-square=", at + 1);
  return html.slice(at, next < 0 ? undefined : next).includes("data-piece=");
}

describe("ChessBoard", () => {
  it("draws sixty-four squares from the FEN it was handed", () => {
    expect(drawn(render()).length).toBe(64);
    // The opening position, so the two centre squares are empty and the pawns are home.
    expect(occupied(render(), "e2")).toBe(true);
    expect(occupied(render(), "e4")).toBe(false);
    // And a position two moves in.
    const played = render({ fen: AFTER_E4_E5 });
    expect(occupied(played, "e4")).toBe(true);
    expect(occupied(played, "e2")).toBe(false);
  });

  it("puts the reader's own side at the bottom", () => {
    // White reads a8 first (top-left) and h1 last (bottom-right).
    const white = drawn(render({ orientation: "w" }));
    expect(white[0]).toBe("a8");
    expect(white[63]).toBe("h1");
    // Black reads the board the other way round.
    const black = drawn(render({ orientation: "b" }));
    expect(black[0]).toBe("h1");
    expect(black[63]).toBe("a8");
  });

  it("marks the selected square, the legal targets, the last move and a check", () => {
    const html = render({
      selected: "b1",
      targets: ["a3", "c3"],
      lastMove: ["e2", "e4"],
      check: "e8",
    });
    // The marks live on this app's own overlay INSIDE the renderer's square, so they are
    // scoped to it rather than sitting on it.
    expect(html).toContain('data-square-state="b1" data-selected="true"');
    expect(html).toContain('data-square-state="a3" data-target="true"');
    expect(html).toMatch(/data-square-state="e4"[^>]*data-last-move="true"/);
    expect(html).toMatch(/data-square-state="e8"[^>]*data-check="true"/);
    // And leaves every other square unmarked.
    const at = html.indexOf('data-square-state="d5"');
    const overlay = html.slice(at, html.indexOf(">", at));
    expect(overlay).not.toContain("data-selected");
    expect(overlay).not.toContain("data-target");
    expect(overlay).not.toContain("data-last-move");
    expect(overlay).not.toContain("data-check");
  });

  it("draws a target on an EMPTY square differently from one holding a piece", () => {
    // A dot where there is nothing to take…
    const empty = render({ fen: OPENING, selected: "b1", targets: ["a3"] });
    expect(empty).toContain("rounded-full");
    // …and a ring around a piece that can be.
    const capture = render({ fen: OPENING, selected: "b1", targets: ["d2"] });
    const at = capture.indexOf('data-square-state="d2"');
    const next = capture.indexOf("data-square=", at);
    expect(capture.slice(at, next)).toContain("ring-inset");
  });

  it("says which side it is drawn from, so a capture and a spec can read it", () => {
    expect(render({ orientation: "b" })).toContain('data-orientation="b"');
  });

  it("is a SQUARE box whatever width it is given", () => {
    // The board holds its own shape rather than taking the height its container offers.
    expect(render()).toContain("aspect-square");
  });

  it("does not animate when the reader asked for no motion", () => {
    // Nothing to assert in the markup — the option travels to the renderer — so this pins
    // that the prop is accepted and the board still draws.
    expect(drawn(render({ animate: false })).length).toBe(64);
  });

  it("marks a PREMOVE in its own tint, never as a move that happened", () => {
    // A premove is a decision, not a move: the yellow the last move wears would say the board
    // has already played it.
    const html = render({ premove: ["g1", "f3"], lastMove: ["e2", "e4"] });
    expect(html).toMatch(/data-square-state="f3"[^>]*data-premove="true"/);
    expect(html).toMatch(/data-square-state="f3"[^>]*bg-chess-premove/);
    // And the last move keeps the board's own highlight.
    expect(html).toMatch(/data-square-state="e4"[^>]*data-last-move="true"/);
  });

  it("says whether a TOUCH over it scrolls the page, because a card in the history must", () => {
    // The renderer writes `touch-action: none` on every piece; a board inside a scrolling
    // conversation frees it (see styles/app.css) and gives up touch dragging with it.
    expect(render({ scrollable: true })).toContain('data-scrollable="true"');
    expect(render()).not.toContain("data-scrollable");
  });

  it("asks WHICH PIECE over the board, drawn with the renderer's own art", () => {
    const html = render({ promotion: { from: "e7", to: "e8", color: "w" } });
    // The four pieces, in the order every board offers them, and each one is a real piece
    // rather than the word for it.
    expect(html).toContain('data-testid="chess-promotion"');
    for (const piece of ["q", "n", "r", "b"]) {
      expect(html).toContain(`data-testid="chess-promote-${piece}"`);
    }
    expect(html).toContain("Promote to Queen");
    // It is drawn INSIDE the board, over the file the pawn is landing on.
    const at = html.indexOf('data-testid="chess-promotion"');
    expect(html.slice(0, at)).toContain('data-testid="chess-board"');
  });
});

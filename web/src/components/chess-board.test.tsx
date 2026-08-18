import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChessBoard, emptyChessSquares, type ChessBoardSquare } from "./chess-board";

/** An empty board with one white knight on b1. */
function squares(): ChessBoardSquare[] {
  return emptyChessSquares().map((s) =>
    s.square === "b1" ? { square: "b1", piece: { kind: "n" as const, color: "w" as const } } : s,
  );
}

function render(over: Partial<Parameters<typeof ChessBoard>[0]> = {}): string {
  return renderToStaticMarkup(
    <ChessBoard
      squares={squares()}
      orientation="w"
      selected={null}
      targets={[]}
      lastMove={null}
      check={null}
      {...over}
    />,
  );
}

/** The squares in the order they are drawn. */
function drawn(html: string): string[] {
  return [...html.matchAll(/data-square="([a-h][1-8])"/g)].map((m) => m[1] as string);
}

describe("ChessBoard", () => {
  it("draws sixty-four squares", () => {
    expect(drawn(render()).length).toBe(64);
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

  it("marks the selected square, the legal targets and the last move", () => {
    const html = render({ selected: "b1", targets: ["a3", "c3"], lastMove: ["e2", "e4"] });
    expect(html).toMatch(/data-square="b1"[^>]*data-selected="true"/);
    expect(html).toMatch(/data-square="a3"[^>]*data-target="true"/);
    expect(html).toMatch(/data-square="e4"[^>]*data-last-move="true"/);
    // And leaves every other square unmarked.
    expect(html).not.toMatch(/data-square="d5"[^>]*data-selected/);
  });

  it("names a square and whatever is standing on it", () => {
    const html = render();
    expect(html).toContain('aria-label="b1, white n"');
    expect(html).toContain('aria-label="d4"');
  });

  it("is a grid of BUTTONS only where a press means something", () => {
    // A player's board: every square is pressable, because a press is how a move is made.
    expect(render({ onSquare: () => {} }).match(/<button/g)?.length).toBe(64);
    // A spectator's board, and a finished game: squares, not controls.
    expect(render().match(/<button/g)).toBeNull();
  });

  it("draws the piece it was handed and nothing where there is none", () => {
    const html = render();
    expect(html).toContain('data-piece="wn"');
    expect(html.match(/data-piece=/g)?.length).toBe(1);
  });

  it("says which side it is drawn from, so a capture and a spec can read it", () => {
    expect(render({ orientation: "b" })).toContain('data-orientation="b"');
  });
});

describe("emptyChessSquares", () => {
  it("is every square once, in a1…h8 order", () => {
    const all = emptyChessSquares();
    expect(all.length).toBe(64);
    expect(all[0]?.square).toBe("a1");
    expect(all[63]?.square).toBe("h8");
    expect(new Set(all.map((s) => s.square)).size).toBe(64);
  });
});

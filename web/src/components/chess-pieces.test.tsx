import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChessPiece, type ChessPieceKind } from "./chess-pieces";
import type { ChessColor } from "~/lib/chess-wire";

function render(kind: ChessPieceKind, color: ChessColor): string {
  return renderToStaticMarkup(<ChessPiece kind={kind} color={color} />);
}

describe("ChessPiece", () => {
  it("names the piece and its colour for a reader who cannot see it", () => {
    expect(render("n", "w")).toContain('aria-label="White knight"');
    expect(render("q", "b")).toContain('aria-label="Black queen"');
  });

  it("draws all twelve, each saying which it is", () => {
    for (const kind of ["k", "q", "r", "b", "n", "p"] as const) {
      for (const color of ["w", "b"] as const) {
        expect(render(kind, color)).toContain(`data-piece="${color}${kind}"`);
      }
    }
  });

  it("uses the SOLID glyph for both sides, because a hollow one vanishes on a light square", () => {
    // ♟ and never ♙: the outline glyph is what made the two armies read the same.
    expect(render("p", "w")).toContain("♟");
    expect(render("p", "b")).toContain("♟");
    for (const hollow of ["♔", "♕", "♖", "♗", "♘", "♙"]) {
      expect(render("k", "w")).not.toContain(hollow);
    }
  });

  it("gives each piece its own glyph, so a knight is never drawn as a bishop", () => {
    const drawn = (["k", "q", "r", "b", "n", "p"] as const).map((kind) => {
      const html = render(kind, "b");
      // The glyph is the element's only text content, so it is what sits before the close.
      const end = html.lastIndexOf("</span>");
      return html.slice(html.lastIndexOf(">", end - 1) + 1, end);
    });
    expect(drawn.every((glyph) => glyph.length > 0)).toBe(true);
    expect(new Set(drawn).size).toBe(6);
  });

  it("gives the two sides opposite ink, so a board's armies never swap with the theme", () => {
    const white = render("p", "w");
    const black = render("p", "b");
    expect(white).toContain("color:#fbfbfa");
    expect(black).toContain("color:#1c1917");
    // And each one is outlined in the other's ink, which is what makes both readable on either
    // square colour.
    expect(white).toContain("#1c1917");
    expect(black).toContain("#f5f5f4");
  });

  it("outlines every side, all the way round", () => {
    for (const color of ["w", "b"] as const) {
      const html = render("k", color);
      expect(html).toContain("text-shadow");
      // Four offsets: left, right, above, below.
      expect(html.match(/-?1px/g)?.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("asks for the TEXT presentation, or a system draws a colourful emoji instead", () => {
    expect(render("q", "w")).toContain("font-variant-emoji:text");
  });

  it("is inert and unselectable: a board is tapped and dragged, not read as text", () => {
    const html = render("k", "b");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("select-none");
  });
});

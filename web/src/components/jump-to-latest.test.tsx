// The jump-to-latest button stays mounted so it can fade out, which makes its
// hidden state a real accessibility question: an invisible control must not be a
// tab stop, must not be announced, and must not take a click. These tests pin
// that contract on the rendered markup.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { JumpToLatest } from "./jump-to-latest";

function render(visible: boolean): string {
  return renderToStaticMarkup(<JumpToLatest visible={visible} onClick={() => {}} />);
}

describe("JumpToLatest", () => {
  it("is reachable and opaque when the reader has scrolled up", () => {
    const html = render(true);
    expect(html).toContain('data-visible="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Jump to the newest message"');
    expect(html).toContain("pointer-events-auto");
    expect(html).toContain("opacity-100");
  });

  it("is inert while the history is at its newest message", () => {
    const html = render(false);
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("opacity-0");
  });
});

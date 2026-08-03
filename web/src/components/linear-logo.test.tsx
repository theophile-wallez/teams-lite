// Linear's logomark is a third party's asset, so these read the rendered SVG and
// pin the two things a later edit could quietly break: that the outline is still
// Linear's own drawing, and that the theme still supplies the fill. The suite runs
// without a DOM (see vitest.config.ts), which is enough for pure markup.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { LinearLogo } from "./linear-logo";

/**
 * SHA-256 of the `d` attribute of `logo-dark.svg` and `logo-light.svg` in
 * Linear-Brand-Assets.zip (linked from linear.app/brand) — both files carry the same
 * outline. Linear asks that the mark not be altered, so this fails on any redraw,
 * re-export or "tidy up" of the path, which is the point.
 */
const OFFICIAL_PATH_SHA256 =
  "758bf493bcdd6d40a77f8ea79f1643b3a581ad6d4d95aefaf4ac251eb96ab8f8";

function pathOf(html: string): string {
  return /\sd="([^"]+)"/.exec(html)?.[1] ?? "";
}

describe("LinearLogo", () => {
  it("draws Linear's own outline, unaltered", () => {
    const path = pathOf(renderToStaticMarkup(<LinearLogo />));
    expect(createHash("sha256").update(path).digest("hex")).toBe(OFFICIAL_PATH_SHA256);
  });

  it("takes its fill from the theme, so both brand versions are reachable", () => {
    // Linear ships the mark twice — #222326 for a light background, white for a dark
    // one — and `.linear-logo` (app.css) holds both. The path must therefore inherit
    // the colour rather than hard-code either one.
    const html = renderToStaticMarkup(<LinearLogo />);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain("linear-logo");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  it("is decorative by default, because the word Linear sits next to it", () => {
    const html = renderToStaticMarkup(<LinearLogo />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
    expect(html).not.toContain("<title>");
  });

  it("becomes a named image when the caller gives it a title", () => {
    // The link card is that caller: the mark is the only thing naming the tracker.
    const html = renderToStaticMarkup(<LinearLogo title="Linear" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Linear"');
    expect(html).toContain("<title>Linear</title>");
    expect(html).not.toContain("aria-hidden");
  });

  it("keeps the caller's sizing next to its own class", () => {
    const html = renderToStaticMarkup(<LinearLogo className="size-3 shrink-0" />);
    expect(html).toContain("linear-logo");
    expect(html).toContain("size-3");
    expect(html).toContain("shrink-0");
  });
});

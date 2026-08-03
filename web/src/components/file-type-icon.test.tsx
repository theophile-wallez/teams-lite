// The file-type icon is pure markup — a family, a colour class and one path — so
// these tests read the rendered SVG. The suite runs without a DOM (see
// vitest.config.ts), which is enough for a component that holds no state.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTypeIcon } from "./file-type-icon";

describe("FileTypeIcon", () => {
  it("colours the icon by the document family", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="deck.pptx" />);
    expect(html).toContain('data-file-kind="powerpoint"');
    expect(html).toContain("text-file-powerpoint");
  });

  it("falls back to the quiet generic page", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="blob" />);
    expect(html).toContain('data-file-kind="generic"');
    expect(html).toContain("text-file-generic");
  });

  it("is decorative by default, because the file name sits next to it", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="notes.md" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="img"');
  });

  it("becomes a named image when the caller gives it a title", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="notes.md" title="Text file" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Text file"');
    expect(html).toContain("<title>Text file</title>");
    expect(html).not.toContain("aria-hidden");
  });

  it("cuts the glyph out of the page, so no background colour is assumed", () => {
    const html = renderToStaticMarkup(<FileTypeIcon name="Budget.xlsx" />);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('fill-rule="evenodd"');
  });

  it("gives every family its own drawing", () => {
    const names = [
      "a.docx",
      "a.xlsx",
      "a.pptx",
      "a.pdf",
      "a.png",
      "a.mp4",
      "a.mp3",
      "a.zip",
      "a.ts",
      "a.txt",
      "a",
    ];
    const paths = names.map((name) => {
      const html = renderToStaticMarkup(<FileTypeIcon name={name} />);
      return /\sd="([^"]+)"/.exec(html)?.[1] ?? "";
    });
    expect(paths.every((d) => d.length > 0)).toBe(true);
    expect(new Set(paths).size).toBe(names.length);
  });
});

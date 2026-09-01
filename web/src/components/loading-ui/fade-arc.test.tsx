// The app's ONE loader, and the two things about it that fail SILENTLY.
//
// A gradient is referenced by id, so an id that is not unique per instance means two arcs on one
// screen paint from one gradient — and an id the paths do not reference means an arc with no ink
// at all. Neither throws, neither fails a type-check, and both look like a loader that stopped
// working. So both are pinned here, by server-rendering the component the way every other
// component test in this app does (`react-dom/server`, no DOM needed).
//
// The last block SCANS THE SOURCE, in the discipline `icon-library.test.ts` uses and for its
// reason: the rule is that this app has ONE loader shape. Two would read as two designs sharing a
// screen — which is the whole argument for hugeicons being the only icon library — and nothing
// about a second spinner would ever fail a build. It also pins the keyframes ACROSS the file
// boundary: the component names its animation in TypeScript and app.css defines it, so a rename
// on one side alone leaves an arc that never turns and no test to notice.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FadeArc } from "./fade-arc";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..", "..", "..");
const APP_CSS = readFileSync(join(WEB_DIR, "src", "styles", "app.css"), "utf8");

/** The component's CODE, with every comment removed.
 *
 *  Its header explains in prose why the `<style>` the vendor inlines is not here — so a scan of
 *  the raw file is satisfied by the very sentence that says the element is gone. That is the
 *  defect this app has closed sixteen times: a source scan met by something other than the thing
 *  it names. Strip the prose, and the assertion is about the code again. */
const CODE = readFileSync(join(HERE, "fade-arc.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

/** The keyframes name, spelled once here and asserted on both sides of the boundary. */
const KEYFRAMES = "loading-ui-fade-arc-spin";

/** Every gradient id declared in `<defs>`, in document order. */
function declaredIds(markup: string): string[] {
  return [...markup.matchAll(/<linearGradient id="([^"]+)"/g)].flatMap((m) => m[1] ?? []);
}

/** Every gradient id a path actually paints with. */
function referencedIds(markup: string): string[] {
  return [...markup.matchAll(/fill="url\(#([^)]+)\)"/g)].flatMap((m) => m[1] ?? []);
}

describe("the fade arc", () => {
  it("is one svg that reports itself as a status", () => {
    const markup = renderToStaticMarkup(<FadeArc className="size-4" />);
    expect(markup.match(/<svg/g)).toHaveLength(1);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('viewBox="0 0 24 24"');
  });

  it("carries no <style> of its own, because app.css holds the rule", () => {
    // The vendor injects one <style> PER INSTANCE, keyed on nothing React can dedupe. A loader
    // mounts and unmounts constantly here — inside a virtualized history among other places.
    expect(renderToStaticMarkup(<FadeArc className="size-4" />)).not.toContain("<style");
    expect(CODE).not.toContain("<style");
    // And the strip really strips: a scan that quietly matched nothing would pass forever.
    expect(CODE).toContain("function FadeArc");
    expect(CODE).not.toContain("the vendor injects");
  });

  it("names an animation app.css really defines", () => {
    const markup = renderToStaticMarkup(<FadeArc className="size-4" />);
    expect(markup).toContain(`animation-name:${KEYFRAMES}`);
    expect(markup).toContain("animation-iteration-count:infinite");
    // The speed is a custom property, so a caller can slow one arc down without a second rule.
    expect(markup).toContain("var(--duration, 1s)");
    expect(APP_CSS).toContain(`@keyframes ${KEYFRAMES}`);
  });

  it("paints with exactly the gradients it declares", () => {
    const markup = renderToStaticMarkup(<FadeArc className="size-4" />);
    const declared = declaredIds(markup);
    expect(declared).toHaveLength(2);
    // Both directions: a declared gradient nothing paints with is dead weight, and a painted
    // gradient nothing declares is an arc with no ink.
    expect(new Set(referencedIds(markup))).toEqual(new Set(declared));
  });

  it("gives every instance gradient ids of its own", () => {
    // Two loaders on one screen is the ordinary case — a list loading beside a button working.
    const markup = renderToStaticMarkup(
      <>
        <FadeArc className="size-4" />
        <FadeArc className="size-4" />
      </>,
    );
    const declared = declaredIds(markup);
    expect(declared).toHaveLength(4);
    expect(new Set(declared).size).toBe(4);
    // And no id may carry a ":" — React's own useId spells one, and `url(#a:b)` resolves to
    // nothing. The component strips them; this is what proves the strip is still there.
    for (const id of declared) expect(id).not.toContain(":");
  });

  it("takes its ink from the text colour, so a text-* class tints it", () => {
    const markup = renderToStaticMarkup(<FadeArc className="size-4" />);
    expect(markup.match(/currentColor/g)?.length).toBe(4);
  });

  it("passes the caller's class and props through", () => {
    const markup = renderToStaticMarkup(
      <FadeArc className="size-3.5 text-text-faint" data-testid="busy" aria-label="Loading" />,
    );
    expect(markup).toContain('class="size-3.5 text-text-faint"');
    expect(markup).toContain('data-testid="busy"');
    expect(markup).toContain('aria-label="Loading"');
  });

  it("lets a caller override the speed without losing the animation", () => {
    const markup = renderToStaticMarkup(
      <FadeArc className="size-4" style={{ ["--duration" as string]: "2s" }} />,
    );
    expect(markup).toContain(`animation-name:${KEYFRAMES}`);
    expect(markup).toContain("--duration:2s");
  });
});

/** Files whose spinning glyph is a STATUS mark rather than a loader, and is correct as it is.
 *
 *  In both, `Loading02Icon` is ONE entry of a closed set — beside a checkmark, an alert, a play
 *  and a clock — chosen from a pipeline's own status, typed `IconSvgElement`, and tinted by tone.
 *  A filled gradient arc dropped into that row would read as a different design, and it would not
 *  even type-check inside the record. The `running` job turns because it is running; it is not the
 *  app telling the reader to wait. */
const STATUS_GLYPH_FILES = [
  "src/components/gitlab-pipeline-graph.tsx",
  "src/components/gitlab-link-card.tsx",
];

function sourceFiles(): string[] {
  const self = fileURLToPath(import.meta.url);
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a directory this checkout does not have
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && path !== self) {
        found.push(path);
      }
    }
  };
  for (const dir of ["src", "mock", "e2e", "scripts"]) walk(join(WEB_DIR, dir));
  return found;
}

describe("the app's one loader", () => {
  it("finds the source files it is meant to scan", () => {
    // A guard whose walk silently matched nothing would pass forever.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("is the only spinner shape anywhere in the app", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles()) {
      const rel = path.slice(WEB_DIR.length + 1).split("\\").join("/");
      if (STATUS_GLYPH_FILES.includes(rel)) continue;
      // The CODE, not the prose. This app is documented in its own files, so `fade-arc.tsx`
      // explains in as many words what `animate-spin` used to give a reader — and a guard met by
      // the sentence that records the fix is a guard that proves nothing. Only full-line comments
      // and block comments go, so a violation can never be hidden by stripping code beside it.
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      // A turning hugeicons glyph is the shape this loader replaced. Either half of it is the
      // whole defect: the loader GLYPH, and the class that turns any glyph.
      if (code.includes("Loading02Icon")) offenders.push(`${rel} draws Loading02Icon`);
      if (code.includes("animate-spin")) offenders.push(`${rel} spins a glyph with animate-spin`);
    }
    expect(offenders).toEqual([]);
  });

  it("still leaves the pipeline's status glyphs alone", () => {
    // The other half of the rule above: exempting those two files is only honest while they
    // really are the status vocabulary. A scan that silently stopped matching them would let the
    // exemption outlive its reason.
    for (const rel of STATUS_GLYPH_FILES) {
      const source = readFileSync(join(WEB_DIR, rel), "utf8");
      expect(source, rel).toContain("Loading02Icon");
      expect(source, rel).not.toContain("FadeArc");
    }
  });
});

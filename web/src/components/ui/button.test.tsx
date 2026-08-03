// A button's sound is tied to what the user DID, never to where the pointer is.
//
// cuelume plays a cue for every `data-cuelume-*` attribute it finds (see
// lib/sounds.ts `bindCues`), and `data-cuelume-hover` fires on pointerenter — so a
// pointer crossing a toolbar chimed at the user for actions they never took. These
// tests pin the rendered markup: press and toggle stay, hover never comes back, and
// an action's outcome is sounded by the controller instead (lib/store.ts).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "./button";

const VARIANTS = ["default", "secondary", "ghost", "outline", "destructive"] as const;

describe("Button sound cues", () => {
  it("ticks on pointer-down by default", () => {
    const html = renderToStaticMarkup(<Button>Save</Button>);
    expect(html).toContain("data-cuelume-press");
  });

  it("plays the toggle cue for an on/off control", () => {
    const html = renderToStaticMarkup(<Button cue="toggle">Mute</Button>);
    expect(html).toContain("data-cuelume-toggle");
    expect(html).not.toContain("data-cuelume-press");
  });

  it("stays silent when the caller opts out", () => {
    const html = renderToStaticMarkup(<Button cue={null}>Send</Button>);
    expect(html).not.toContain("data-cuelume");
  });

  it("never plays a cue on hover, in any variant or cue mode", () => {
    for (const variant of VARIANTS) {
      for (const cue of ["press", "toggle", null] as const) {
        const html = renderToStaticMarkup(
          <Button variant={variant} cue={cue}>
            Save
          </Button>,
        );
        expect(html).not.toContain("data-cuelume-hover");
      }
    }
  });
});

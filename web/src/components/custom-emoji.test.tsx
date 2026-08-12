// What a custom emoji looks like BEFORE its art arrives.
//
// Server-rendering runs no effects, so the markup below is exactly the first paint —
// which is the state this file is about: the art is fetched through the media proxy, and
// for the length of that fetch the glyph has nothing to draw. It used to draw `label`,
// and on a reaction chip that label is the phrase "custom emoji" rather than a code, in a
// span that took none of the caller's classes: unbounded words spilling out of a 30px
// pill. The skeleton is the same box the art will occupy, so nothing moves when it lands.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomEmoji } from "./custom-emoji";
import { ControllerProvider } from "./controller-context";

/** A backend URL nothing listens on: the provider only constructs a client here. */
const OFFLINE_URL = "ws://127.0.0.1:1";

const ART = "https://eu-api.asyncgw.teams.microsoft.com/v1/objects/0-eu-d1/views/imgo";

function render(props: { label: string; jumbo?: boolean; className?: string }): string {
  return renderToStaticMarkup(
    <ControllerProvider url={OFFLINE_URL}>
      <CustomEmoji src={ART} {...props} />
    </ControllerProvider>,
  );
}

describe("CustomEmoji — before the art arrives", () => {
  it("draws a skeleton rather than the label", () => {
    // The reaction chip's own call: the label is a phrase, and it is what used to spill.
    const out = render({ label: "custom emoji", className: "size-5" });
    expect(out).not.toContain("custom emoji");
    expect(out).toContain("animate-pulse");
  });

  it("gives the skeleton the caller's size, so the glyph does not move when it lands", () => {
    // `size-5` last means it wins over the default, exactly as it does on the `<img>` —
    // a skeleton of a different size is a layout shift with extra steps.
    expect(render({ label: ":shipit:", className: "size-5" })).toContain("size-5");
    expect(render({ label: ":shipit:" })).toContain("size-[1.15em]");
    expect(render({ label: ":shipit:", jumbo: true })).toContain("size-[2.75em]");
  });

  it("holds no code either: a half-drawn `:shipit:` is the same flash of text", () => {
    expect(render({ label: ":shipit:" })).not.toContain(":shipit:");
  });
});

// A left accent border, done the opencode way: a box that draws a heavy vertical
// bar (┃, U+2503 BOX DRAWINGS HEAVY VERTICAL) down its left edge via OpenTUI's
// native border. The native border spans the box's full height automatically, so
// there is no per-row glyph loop and no coupling to the content's line count.
//
// ┃ is a box-drawing glyph (universally supported by terminal fonts), unlike the
// finer "Legacy Computing" quarter blocks. The content is wrapped in an inner box
// whose paddingLeft is the gap between the bar and the text.
//
// Mirrors opencode's prompt border (packages/tui/src/ui/border.ts + component/
// prompt/index.tsx): EmptyBorder blanks every side, `vertical` draws the bar, and
// a `╹` foot taper closes the bottom.

import { type JSXElement } from "solid-js";
import { type ColorInput } from "@opentui/core";
import { theme } from "./theme";

// Blank every border piece so only the ones we set below are drawn.
const EMPTY_BORDER = {
  topLeft: "",
  topRight: "",
  bottomLeft: "",
  bottomRight: "",
  horizontal: " ",
  vertical: "",
  topT: "",
  bottomT: "",
  leftT: "",
  rightT: "",
  cross: "",
};

const HEAVY_VERTICAL = "┃"; // U+2503 BOX DRAWINGS HEAVY VERTICAL
const FOOT = "╹"; // U+2579 BOX DRAWINGS HEAVY UP — tapers the bottom of the bar

export function Border(props: {
  color?: ColorInput;
  char?: string;
  gap?: number;
  children?: JSXElement;
}) {
  return (
    <box
      border={["left"]}
      borderColor={props.color ?? theme().primary}
      customBorderChars={{ ...EMPTY_BORDER, vertical: props.char ?? HEAVY_VERTICAL, bottomLeft: FOOT }}
      style={{ width: "100%" }}
    >
      <box style={{ flexGrow: 1, width: "100%", paddingLeft: props.gap ?? 0 }}>{props.children}</box>
    </box>
  );
}

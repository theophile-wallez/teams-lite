import { describe, expect, it } from "vitest";
import { isVirtualKeyboardOpen, type KeyboardViewportState } from "./virtual-keyboard";

const OPEN_VIEWPORT: KeyboardViewportState = {
  layoutHeight: 844,
  visualHeight: 510,
  visualOffsetTop: 0,
  baselineHeight: 844,
  editableFocused: true,
  scale: 1,
};

describe("isVirtualKeyboardOpen", () => {
  it("detects a keyboard that overlays the layout viewport", () => {
    expect(isVirtualKeyboardOpen(OPEN_VIEWPORT)).toBe(true);
  });

  it("detects a keyboard after the layout viewport also shrinks", () => {
    expect(
      isVirtualKeyboardOpen({
        ...OPEN_VIEWPORT,
        layoutHeight: 510,
      }),
    ).toBe(true);
  });

  it("requires an editable element to have focus", () => {
    expect(isVirtualKeyboardOpen({ ...OPEN_VIEWPORT, editableFocused: false })).toBe(false);
  });

  it("ignores small browser toolbar changes", () => {
    expect(
      isVirtualKeyboardOpen({
        ...OPEN_VIEWPORT,
        visualHeight: 780,
      }),
    ).toBe(false);
  });

  it("ignores pinch zoom", () => {
    expect(isVirtualKeyboardOpen({ ...OPEN_VIEWPORT, scale: 1.5 })).toBe(false);
  });
});

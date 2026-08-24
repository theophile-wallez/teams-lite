// @vitest-environment happy-dom
//
// `aModalIsOpen` asks the DOM rather than tracking state, so proving it needs a real one.
import { describe, expect, it } from "vitest";
import { aModalIsOpen, formatShortcut, hasModifier, isAppleKeyboard } from "./platform";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("isAppleKeyboard", () => {
  it("recognizes a Mac by its platform", () => {
    expect(isAppleKeyboard({ platform: "MacIntel", userAgent: MAC_UA })).toBe(true);
  });

  it("recognizes an iPhone", () => {
    expect(isAppleKeyboard({ platform: "iPhone", userAgent: "" })).toBe(true);
  });

  it("falls back to the user agent when the platform is missing", () => {
    expect(isAppleKeyboard({ userAgent: MAC_UA })).toBe(true);
  });

  it("reports Linux and Windows as non-Apple", () => {
    expect(isAppleKeyboard({ platform: "Linux x86_64", userAgent: LINUX_UA })).toBe(false);
    expect(isAppleKeyboard({ platform: "Win32", userAgent: "" })).toBe(false);
  });

  it("reports a browser that answers nothing as non-Apple", () => {
    expect(isAppleKeyboard({})).toBe(false);
  });
});

describe("hasModifier", () => {
  it("accepts Ctrl and Cmd alike, so the same shortcut works on every keyboard", () => {
    expect(hasModifier({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasModifier({ ctrlKey: false, metaKey: true })).toBe(true);
  });

  it("rejects a bare key", () => {
    expect(hasModifier({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("formatShortcut", () => {
  it("juxtaposes the glyphs on a Mac and joins them elsewhere", () => {
    expect(formatShortcut("K", "⌘")).toBe("⌘K");
    expect(formatShortcut("K", "Ctrl")).toBe("Ctrl+K");
  });
});

describe("aModalIsOpen", () => {
  /** The DOM this reads, put back after every case: it asks the document rather than tracking
   *  state, which is the whole reason it works — and the whole reason it needs a real element. */
  function withLayer(role: string | null, state: string | null, run: () => void) {
    if (role === null) {
      run();
      return;
    }
    const layer = document.createElement("div");
    layer.setAttribute("role", role);
    if (state) layer.setAttribute("data-state", state);
    document.body.appendChild(layer);
    try {
      run();
    } finally {
      layer.remove();
    }
  }

  it("stands the shell aside for a dialog and for a MENU", () => {
    // A menu counts because a conversation's three header controls became one dropdown: the
    // chess challenge used to be a popover, which is `role="dialog"` and was absorbed, and
    // folding it into a menu made Escape close the menu AND leave the conversation.
    withLayer("dialog", "open", () => expect(aModalIsOpen()).toBe(true));
    withLayer("menu", "open", () => expect(aModalIsOpen()).toBe(true));
  });

  it("counts a layer that is animating AWAY, because Radix has already moved its state", () => {
    // Radix listens for Escape in the CAPTURE phase, so by the time the shell's bubble-phase
    // handler runs, the layer it just dismissed reads `closed` and is still mounted. Testing
    // `data-state` is what made a first attempt at this do nothing at all.
    withLayer("dialog", "closed", () => expect(aModalIsOpen()).toBe(true));
    withLayer("menu", "closed", () => expect(aModalIsOpen()).toBe(true));
  });

  it("does not stand aside for anything else", () => {
    withLayer(null, null, () => expect(aModalIsOpen()).toBe(false));
    // A tooltip and a toast dismiss themselves and never own Escape.
    withLayer("tooltip", "open", () => expect(aModalIsOpen()).toBe(false));
    withLayer("status", "open", () => expect(aModalIsOpen()).toBe(false));
  });
});

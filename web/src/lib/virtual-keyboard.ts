const MINIMUM_KEYBOARD_HEIGHT = 100;
const EDITABLE_SELECTOR =
  'textarea, input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]), [contenteditable="true"]';

export type KeyboardViewportState = {
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
  baselineHeight: number;
  editableFocused: boolean;
  scale: number;
};

/**
 * Distinguishes a software keyboard from browser chrome and a hardware keyboard.
 * The 100 px threshold is larger than a mobile browser toolbar but smaller than
 * the shortest iOS software keyboard.
 */
export function isVirtualKeyboardOpen(state: KeyboardViewportState): boolean {
  if (!state.editableFocused || state.scale > 1.05) return false;

  const layoutOcclusion =
    state.layoutHeight - state.visualHeight - state.visualOffsetTop;
  const baselineShrink = state.baselineHeight - state.visualHeight;
  return Math.max(layoutOcclusion, baselineShrink) >= MINIMUM_KEYBOARD_HEIGHT;
}

function isEditable(element: Element | null): boolean {
  return element?.matches(EDITABLE_SELECTOR) ?? false;
}

/**
 * Marks the document while a software keyboard covers the bottom safe area.
 * iOS keeps env(safe-area-inset-bottom) after its keyboard opens, although that
 * area is then part of the keyboard. The marker lets the composer omit it.
 */
export function installVirtualKeyboardState(): () => void {
  const viewport = window.visualViewport;
  const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches;
  if (!viewport || !touchDevice) return () => {};

  let baselineHeight = viewport.height;
  let baselineWidth = viewport.width;

  const update = () => {
    const editableFocused = isEditable(document.activeElement);
    const orientationChanged = Math.abs(viewport.width - baselineWidth) > 1;

    if (orientationChanged) {
      baselineHeight = viewport.height;
      baselineWidth = viewport.width;
    } else {
      // Preserve the largest viewport for this orientation. A focus change can
      // happen before iOS finishes closing its keyboard, so the current height is
      // not necessarily the keyboard-free baseline.
      baselineHeight = Math.max(baselineHeight, viewport.height);
    }

    const keyboardOpen = isVirtualKeyboardOpen({
      layoutHeight: window.innerHeight,
      visualHeight: viewport.height,
      visualOffsetTop: viewport.offsetTop,
      baselineHeight,
      editableFocused,
      scale: viewport.scale,
    });
    document.documentElement.toggleAttribute("data-virtual-keyboard-open", keyboardOpen);
  };

  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", update);
  update();

  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", update);
    document.documentElement.removeAttribute("data-virtual-keyboard-open");
  };
}

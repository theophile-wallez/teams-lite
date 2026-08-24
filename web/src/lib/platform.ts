import { useEffect, useState } from "react";

/**
 * Which key the app's shortcuts use as the "command" modifier.
 *
 * Every shortcut accepts BOTH Ctrl and Cmd, because a keyboard event is cheap to
 * match twice and a Mac user reaches for Cmd. Only the *label* is a choice, and it
 * follows the keyboard the user has: "⌘" on Apple hardware, "Ctrl" everywhere else.
 */
export type ModifierLabel = "⌘" | "Ctrl";

/**
 * True when the keyboard in front of the user is an Apple one, so Cmd is the
 * modifier they expect to see named.
 *
 * `navigator.platform` is deprecated but it is still the only field that reports the
 * hardware rather than the rendering engine, and every browser answers it; the user
 * agent is the fallback. An iPad reports itself as a Mac, which is correct here: an
 * attached keyboard is an Apple one.
 */
export function isAppleKeyboard(
  nav: Partial<Navigator> = typeof navigator === "undefined" ? ({} as Navigator) : navigator,
): boolean {
  const platform = nav.platform ?? "";
  const ua = nav.userAgent ?? "";
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh|iPhone|iPad|iPod/.test(ua);
}

/**
 * A shortcut as it is written on that keyboard: "⌘K" on a Mac, "Ctrl+K" elsewhere.
 *
 * Apple keyboards name a chord by juxtaposing the glyphs; every other platform joins
 * them with a "+".
 */
export function formatShortcut(key: string, label: ModifierLabel): string {
  return label === "⌘" ? `⌘${key}` : `${label}+${key}`;
}

/** True when a keyboard event carries the app's command modifier — Ctrl or Cmd. */
export function hasModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): boolean {
  return event.ctrlKey || event.metaKey;
}

/**
 * Whether a DIALOG or a MENU is open right now — the layers the app's own global shortcuts
 * have to stand aside for.
 *
 * A dialog dismisses itself on Escape, and the primitive behind it (`@radix-ui/react-dialog`)
 * keeps a layer stack so only the top one reacts. What that stack cannot reach is a listener
 * on `document` that is not part of it: the app shell's own Escape, which leaves the open pane
 * (see components/app.tsx). Both fired, so Escape in a form inside Settings closed the form
 * AND navigated out of Settings — taking the reader's place with it.
 *
 * It asks the DOM rather than tracking state, because the alternative is every dialog in the
 * app remembering to tell the shell it exists, and the one that forgets is the bug. The
 * selector is the primitive's own contract: its content carries `role="dialog"`.
 *
 * `data-state` is deliberately NOT tested, and that is the whole of why a first attempt at
 * this did nothing. Radix listens for Escape in the CAPTURE phase, so by the time this
 * bubble-phase handler runs the dialog it just dismissed already reads `closed` — the
 * element is still mounted (it has an exit animation) but the state has moved. Matching a
 * dialog in EITHER state is also the right rule rather than a workaround: while one is
 * animating away it is still what the reader's Escape was aimed at.
 *
 * **A MENU counts, for the same reason and by the same argument.** It was a dialog alone until
 * a conversation's three header controls became one dropdown (§ ONE MENU in a conversation's
 * header): the chess challenge used to be a POPOVER, which carries `role="dialog"` and was
 * therefore absorbed, and folding it into a menu made Escape close the menu AND leave the
 * conversation — the reader's place gone, from the one key that means "put that away". That is
 * the identical defect this function was written for, arriving through a second primitive, and
 * every other dropdown in the app (a message's actions, a chat row's "…") had it all along.
 * `role="menu"` is that primitive's own contract, exactly as `role="dialog"` is the other's.
 */
export function aModalIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"], [role="menu"]') !== null;
}

/**
 * The modifier label to render in a hint, resolved on the client only.
 *
 * The page is server-rendered, and the server has no idea which keyboard will read
 * it, so the first paint is always "Ctrl" and Apple hardware swaps to "⌘" right
 * after mount. Deciding during render instead would be a hydration mismatch.
 */
export function useModifierLabel(): ModifierLabel {
  const [label, setLabel] = useState<ModifierLabel>("Ctrl");
  useEffect(() => {
    if (isAppleKeyboard()) setLabel("⌘");
  }, []);
  return label;
}

/**
 * Whether this reader is pointing with a FINGER, resolved on the client only.
 *
 * Most coarse-pointer choices in this app are made in CSS, which is the right place for
 * them — a target's size, an affordance a hover reveals. This is for the one thing CSS
 * cannot do: leave a control out of the DOM entirely. A row hidden with `display: none` is
 * still in a menu's own collection, so a keyboard would walk onto a row nobody can see, and
 * `false` until mount is the safe default — the extra row belongs to a phone, and a pointer's
 * menu is the one that must not gain a dead stop.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    setCoarse(query.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return coarse;
}

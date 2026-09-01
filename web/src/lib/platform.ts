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
 * Whether a modal DIALOG is open right now — the one layer the app's own global shortcuts have
 * to stand aside for even when nothing consumed the key.
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
 * It is asked at KEYDOWN CAPTURE time and never later — see `watchOpenLayers` below, which is
 * the whole reason the `data-state` trap has an answer at all.
 *
 * **A MENU is deliberately NOT matched here, and that was tried.** Folding a conversation's
 * three header controls into one dropdown (§ ONE MENU in a conversation's header) made Escape
 * close the menu AND leave the conversation, so `role="menu"` was added — and it broke the
 * opposite case, which `messaging.spec.ts` caught: a menu whose row was CLICKED is still
 * mounted for its exit animation, and it then swallowed the Escape that cancels the pending
 * reply that row had just started. The state cannot tell those apart, because both read
 * `closed`. What can is asking BEFORE Radix has moved anything, which is what
 * {@link watchOpenLayers} does from the CAPTURE phase — so the shell asks {@link aLayerWasOpen}
 * first (see components/app.tsx) and this function is what remains for the case that answer cannot
 * cover: a dialog that is up and never saw the key at all, because a native `datetime-local` input
 * ate it for its own calendar.
 *
 * It deliberately does NOT read `event.defaultPrevented`, and this comment said for a while that
 * the shell did. It does not, and it must not: a Radix layer that is CLOSING still calls
 * `preventDefault()`, so that flag reads the same for a layer the reader was looking at and one
 * whose own row they had just clicked — which is the regression `messaging.spec.ts` catches.
 */
export function aModalIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"]') !== null;
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

/**
 * Whether this reader asked for LESS MOTION — live, which is the whole reason it is here.
 *
 * motion/react publishes `useReducedMotion`, and it is `useState(prefersReducedMotion.current)`
 * with NO SUBSCRIPTION: its own source carries `TODO See if people miss automatically updating
 * shouldReduceMotion setting` under a docstring claiming it responds actively. So it is read once
 * per MOUNT, and for a surface it can switch off entirely that is worse than a stale flag. Under
 * reduced motion the companion layer draws nothing AND its spawn row is not offered — so a reader
 * who turns Reduce Motion OFF had no in-app path to a creature at all until they reloaded, with
 * nothing anywhere saying why.
 *
 * It follows {@link useCoarsePointer} line for line, including `false` until it has asked: this app
 * is server-rendered, so a lazy initializer reading `matchMedia` would answer one thing on the
 * server and another on the client and mismatch at hydration. What that costs is one frame, and the
 * one surface that reads this has two other answers of "nothing" over it (the stored preference,
 * also read in an effect, and real pet data, which arrives over the socket long after either).
 */
export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduce(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

/**
 * Whether a dismissable LAYER was open at the moment the reader last pressed a key.
 *
 * This exists because the obvious test cannot be made at the obvious time. The app shell's own
 * shortcuts run on a bubble-phase listener, and every Radix layer dismisses itself from a
 * CAPTURE-phase listener on the same document — so by the time the shell asks, the layer the
 * reader just dismissed has already been moved to `data-state="closed"` and is still mounted for
 * its exit animation. Two states, one reading, and both of the wrong answers were shipped:
 *
 *   - Reading PRESENCE (any `[role="menu"]`) made a menu that was closing swallow the next
 *     Escape — the one that cancels the pending reply the menu's own row had just started, which
 *     `messaging.spec.ts` catches.
 *   - Reading nothing at all let one Escape do two things: close the conversation's menu AND
 *     leave the conversation.
 *
 * So the question is asked FIRST, in the capture phase, before Radix has moved anything: at that
 * instant `data-state` still says what the reader was looking at. The shell installs this once
 * and reads {@link aLayerWasOpen} from its own handler.
 *
 * Registration order is what makes it work, and it is not an accident: this is installed when
 * the app mounts, and a layer's own listener is installed when that layer OPENS — later, on the
 * same phase and the same target, so this one runs first.
 */
let layerWasOpen = false;

/** Install the capture-phase watch. Returns its own cleanup, for a `useEffect`. */
export function watchOpenLayers(): () => void {
  if (typeof document === "undefined") return () => {};
  const onKeyDownCapture = () => {
    layerWasOpen =
      document.querySelector(
        // A dialog and a menu carry a role that says what they are. The third member is for a layer
        // that honestly has NEITHER: a hover card publishes no `role` at all (Radix deliberately
        // leaves it roleless, because supplementary content is not a dialog), so a card the reader
        // is looking at could not be matched here — and on a merge-request route the shell's own
        // Escape calls `goToList()`, so one press would dismiss the card AND throw the reader off
        // the page. `data-escape-layer` is what such a layer opts in with, rather than claiming a
        // role it does not have (see components/review-code-chip.tsx).
        '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [data-escape-layer][data-state="open"]',
      ) !== null;
  };
  document.addEventListener("keydown", onKeyDownCapture, { capture: true });
  return () => document.removeEventListener("keydown", onKeyDownCapture, { capture: true });
}

/** Whether a layer was open when the current key was pressed (see {@link watchOpenLayers}). */
export function aLayerWasOpen(): boolean {
  return layerWasOpen;
}

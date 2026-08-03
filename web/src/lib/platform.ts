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

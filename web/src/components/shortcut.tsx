import { Command } from "lucide-react";
import { formatShortcut, type ModifierLabel } from "~/lib/platform";

/**
 * The command modifier as a mark: Lucide's Command icon on Apple hardware, the word
 * "Ctrl" on every other keyboard.
 *
 * U+2318 is in none of Inter's served subsets, so the ⌘ character is drawn by a
 * fallback font — shorter and lighter than the letter beside it, and different on
 * every platform. The icon is the same mark under our own control. It is
 * baseline-aligned like a letter, and its size, offset and stroke are calibrated
 * against a K's cap box and stem: measured at 8x device scale, both marks are 53
 * device pixels tall with a 9 pixel stroke. Every value is in `em`, so the pair stays
 * matched at any font size.
 */
export function ModifierKey(props: { modifier: ModifierLabel }) {
  if (props.modifier !== "⌘") return <>{props.modifier}</>;
  return (
    <>
      <Command aria-hidden className="size-[0.745em] translate-y-[0.11em]" strokeWidth={3.4} />
      <span className="sr-only">Command </span>
    </>
  );
}

/**
 * A whole chord for one <kbd> box: the modifier mark followed by the key, written the
 * way that keyboard writes it. The separator is {@link formatShortcut}'s to decide,
 * so a rendered hint and a `title` string can never disagree.
 */
export function ShortcutChord(props: { keyName: string; modifier: ModifierLabel }) {
  if (props.modifier !== "⌘") return <>{formatShortcut(props.keyName, props.modifier)}</>;
  return (
    <>
      <ModifierKey modifier={props.modifier} />
      {props.keyName}
    </>
  );
}

import { useState } from "react";
import { appleEmojiUrl } from "~/lib/teams-emoji";
import { cn } from "~/lib/utils";

/**
 * One emoji, drawn from the Apple emoji set we serve locally (see
 * scripts/sync-emoji-assets.ts) so every reaction surface — the quick row, the
 * full picker, the chips under a bubble, the activity feed — shows the *same*
 * glyph. Without this each surface would inherit the host font's emoji (Noto on
 * Linux, Segoe on Windows), and the picker would then disagree with the chip the
 * user just created.
 *
 * The native character is the `alt` text, so a missing image (a handful of Teams
 * reactions are composites with no Apple equivalent, e.g. `fistbump` 🤜🤛) simply
 * renders as text instead of a broken image. Sizing comes from `className`; the
 * image is square and defaults to the caller's font size.
 */
export function Emoji(props: { emoji: string; className?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span aria-hidden className={cn("leading-none", props.className)}>
        {props.emoji}
      </span>
    );
  }

  return (
    <img
      src={appleEmojiUrl(props.emoji)}
      alt={props.emoji}
      aria-hidden
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn(
        "inline-block size-[1.15em] select-none object-contain align-[-0.15em]",
        props.className,
      )}
    />
  );
}

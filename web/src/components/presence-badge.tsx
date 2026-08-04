import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, CheckIcon, Clock01Icon, MinusSignIcon } from "@hugeicons/core-free-icons";
import type { PersonPresence } from "~/lib/protocol";
import { presenceLabel, presenceTone, type PresenceTone } from "~/lib/presence";
import { cn } from "~/lib/utils";

/**
 * The presence dot Teams puts on a person: a small coloured disc whose glyph
 * says *which* state it is, so the meaning survives colour-blindness and greyscale
 * — a check for available, a dash for busy, a clock for away, a hollow ring for
 * offline, a cross-arrow for out of office.
 *
 * Sizing comes from the caller through `className` (defaults to 10px, the size
 * that sits well on the 36–44px avatars used across the app). Used standalone in
 * the person card's status line and as an overlay on the card's avatar.
 */

/** Per-tone fill and glyph colour. The two "not here" states are hollow — an
 *  outlined ring rather than a filled disc — which is how Teams distinguishes
 *  offline from every reachable state at a glance. Out of office borrows violet
 *  (Teams' own colour for it); the rest map to the theme's semantic roles. */
const TONE_STYLES: Record<PresenceTone, string> = {
  available: "bg-success text-white",
  busy: "bg-destructive text-white",
  away: "bg-warning text-white",
  oof: "bg-violet-500 text-white dark:bg-violet-400",
  offline: "bg-transparent text-text-dim ring-1 ring-inset ring-current",
  unknown: "bg-transparent text-text-faint ring-1 ring-inset ring-current",
};

/** The tones drawn as an outlined ring rather than a filled disc. Over a surface
 *  they stay see-through, which is the point; over a photo they need a fill of
 *  their own (see the `ring` prop) or the picture reads through the ring as a
 *  glyph that means nothing. */
const HOLLOW_TONES: ReadonlySet<PresenceTone> = new Set(["offline", "unknown"]);

/** The glyph inside the dot, per tone (`null` = an empty ring, for offline). */
function ToneGlyph({ tone }: { tone: PresenceTone }) {
  const glyph = "size-[0.62em]";
  switch (tone) {
    case "available":
      return <HugeiconsIcon icon={CheckIcon} className={glyph} strokeWidth={4} aria-hidden />;
    case "busy":
      return <HugeiconsIcon icon={MinusSignIcon} className={glyph} strokeWidth={4} aria-hidden />;
    case "away":
      return <HugeiconsIcon icon={Clock01Icon} className={glyph} strokeWidth={3.5} aria-hidden />;
    case "oof":
      return <HugeiconsIcon icon={Cancel01Icon} className={glyph} strokeWidth={4} aria-hidden />;
    default:
      return null;
  }
}

export function PresenceBadge(props: {
  presence: PersonPresence | null;
  /** Sizing/positioning overrides; merged last. Defaults to a 10px dot. */
  className?: string;
  /** Mark the badge as an overlay on an avatar: it gains an outline in the surface
   *  colour, and a hollow tone gains that colour as its fill, so the badge stays
   *  legible over a photo instead of showing it through. */
  ring?: boolean;
  /** Expose the state to assistive tech. Pass it wherever the badge is the only
   *  thing that states the presence — the chat header. Leave it off beside a status
   *  line that already says it in words, so the state is not announced twice. */
  labelled?: boolean;
}) {
  const tone = presenceTone(props.presence);
  const label = presenceLabel(props.presence);
  return (
    <span
      data-testid="presence-badge"
      data-tone={tone}
      role={props.labelled ? "img" : undefined}
      aria-label={props.labelled ? label : undefined}
      aria-hidden={props.labelled ? undefined : true}
      // The tooltip stays in both modes: it is how a pointer reads the state where no
      // words state it. `aria-label` names the badge for a reader, so it never doubles.
      title={label}
      className={cn(
        "grid size-2.5 shrink-0 place-items-center rounded-full text-[10px] leading-none",
        TONE_STYLES[tone],
        props.ring && "outline-2 outline-background",
        props.ring && HOLLOW_TONES.has(tone) && "bg-background",
        props.className,
      )}
    >
      <ToneGlyph tone={tone} />
    </span>
  );
}

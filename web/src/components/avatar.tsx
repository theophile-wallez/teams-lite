import { cn } from "~/lib/utils";

// Soft, low-saturation avatar tints, chosen deterministically per seed so a
// conversation keeps the same colour across renders. Muted on purpose to honour
// the neutral-first palette (colour aids scanning without shouting).
const AVATAR_TINTS = [
  "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-300",
];

function tintFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]!;
}

/** Up to two uppercase initials for a display label. */
export function avatarInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * A rounded-square identity avatar with deterministic tint and initials. Size
 * and text size are controlled by the caller through `className` (defaults to a
 * 36px sidebar avatar). Pass `initials` to override the computed initials — e.g.
 * a single letter for a dense, overlapping avatar stack where two letters would
 * be clipped by the overlap.
 */
export function Avatar(props: { seed: string; label: string; initials?: string; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl text-[13px] font-semibold",
        tintFor(props.seed),
        props.className,
      )}
      aria-hidden
    >
      {props.initials ?? avatarInitials(props.label)}
    </span>
  );
}

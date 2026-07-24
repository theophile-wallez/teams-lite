import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";

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

/** Deterministic avatar tint (bg + text colour classes) for a seed string, so the
 *  same conversation/channel keeps its colour across renders. Exported so channel
 *  rows can tint their `#` glyph the same way identity avatars are tinted. */
export function tintFor(seed: string): string {
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

/** A real profile photo to load for an avatar: a person (`kind: "user"`, `id` =
 *  their MRI) or a Teams "team" group (`kind: "team"`, `id` = its AAD group id).
 *  When the subject has no photo, the avatar keeps its tinted initials. */
export type AvatarPhoto = { kind: "user" | "team"; id: string };

/**
 * Resolve a profile photo to a blob object URL through the controller, or `null`
 * while loading / when there is none (fall back to initials). Safe to call with
 * `undefined` (no fetch). Loads client-side only via an effect, so SSR always
 * renders the initials and hydration is stable.
 */
function useAvatarPhoto(photo?: AvatarPhoto): string | null {
  const controller = useController();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!photo || !photo.id) {
      setSrc(null);
      return;
    }
    let active = true;
    setSrc(null);
    controller
      .loadAvatar(photo.kind, photo.id)
      .then((url) => {
        if (active) setSrc(url);
      })
      .catch(() => {
        // transient failure — stay on initials; loadAvatar evicts so a later
        // render retries.
      });
    return () => {
      active = false;
    };
  }, [controller, photo?.kind, photo?.id]);

  return src;
}

/**
 * A rounded-square identity avatar with deterministic tint and initials. Size
 * and text size are controlled by the caller through `className` (defaults to a
 * 36px sidebar avatar). Pass `initials` to override the computed initials — e.g.
 * a single letter for a dense, overlapping avatar stack where two letters would
 * be clipped by the overlap.
 *
 * Pass `photo` to load the subject's real profile picture: it renders over the
 * initials once fetched (and fades in), and the initials remain the fallback
 * while loading, when the subject has no photo, or if the image fails to decode.
 */
export function Avatar(props: {
  seed: string;
  label: string;
  initials?: string;
  className?: string;
  photo?: AvatarPhoto;
}) {
  const photoUrl = useAvatarPhoto(props.photo);
  return (
    <span
      className={cn(
        "relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl text-[13px] font-semibold",
        tintFor(props.seed),
        props.className,
      )}
      aria-hidden
    >
      {props.initials ?? avatarInitials(props.label)}
      {photoUrl && (
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full rounded-[inherit] object-cover animate-in fade-in duration-200"
          // If the blob fails to decode, drop it so the initials show through.
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
    </span>
  );
}

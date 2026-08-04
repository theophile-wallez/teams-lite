import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserMultiple02Icon, ZoomIcon } from "@hugeicons/core-free-icons";
import { isMeetingChat, type Conversation, type MailAddress } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";
import { PersonCoin } from "./person-coin";

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
 *  same conversation/channel keeps its colour across renders. */
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

/** A real picture to load for an avatar. Three kinds of subject, addressed the way
 *  Teams addresses each one:
 *   - a person (`kind: "user"`, `id` = their MRI) or a Teams "team" group
 *     (`kind: "team"`, `id` = its AAD group id) — an identity, so an id;
 *   - a group chat's own uploaded picture (`kind: "chat"`) — hosted content, so
 *     the `url` the backend reported on the conversation (`picture_url`);
 *   - somebody a MAIL names (`kind: "address"`) — a mail carries an SMTP address
 *     rather than an identity, so the address is resolved to a person first (see
 *     `TeamsController.loadAvatarForAddress`).
 *  When the subject has no picture, the avatar keeps its tinted initials. */
export type AvatarPhoto =
  | { kind: "user" | "team"; id: string }
  | { kind: "chat"; url: string }
  | { kind: "address"; address: string };

/** The picture to show for one address on a mail, or `undefined` when the mail
 *  carries no address to resolve (the avatar then keeps its tinted initials). */
export function mailAddressPhoto(address: string): AvatarPhoto | undefined {
  return address ? { kind: "address", address } : undefined;
}

/** Everything after the "@", lowercased — the organisation a mail address belongs
 *  to. Empty when the string is not an address. */
function mailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).trim().toLowerCase() : "";
}

/** The second-level labels that are part of a public suffix rather than a name, so
 *  "example.co.uk" is read as "example" and not as "co". A short list on purpose: a
 *  real public-suffix list is a megabyte of data to pick two letters with. */
const SUFFIX_LABELS = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/** The registrable part of a domain — its name plus the public suffix:
 *  "md.getsentry.com" → "getsentry.com", "sns.amazonaws.com" → "amazonaws.com",
 *  "shop.example.co.uk" → "example.co.uk". What sits in front of it is routing
 *  ("mail.", "updates.", "notifications."), so this is the part that names the
 *  organisation and the part two subdomains of one sender share. */
function registrableDomain(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  let index = labels.length - 2;
  if (SUFFIX_LABELS.has(labels[index]!)) index -= 1;
  return labels.slice(index).join(".");
}

/** The label inside a domain a reader recognises: "md.getsentry.com" → "getsentry",
 *  "linear.app" → "linear". */
function domainName(domain: string): string {
  return registrableDomain(domain).split(".")[0] ?? "";
}

/** The tint seed for a face on a mail: the sender's registrable DOMAIN, so every
 *  address at one organisation carries one colour — `notifications@linear.app` and
 *  `security@updates.linear.app` are the same sender to the reader, and today they
 *  are the only thing a colour can say about them.
 *
 *  It costs a colleague nothing: measured on this tenant, every internal address the
 *  directory resolves has a photo, which covers the tint entirely. What shares the
 *  organisation's colour is what the directory could not name — a shared mailbox, a
 *  distribution list, someone who left — and those ARE the same organisation.
 *
 *  `fallback` is used when the mail carries no address at all (the mail's own id, so
 *  two nameless senders still differ). */
export function mailAvatarSeed(address: MailAddress, fallback: string): string {
  return registrableDomain(mailDomain(address.address)) || address.address || fallback;
}

/** True when a local part spells a PERSON's name: exactly two dot-separated words of
 *  letters, which is what a corporate mailbox looks like ("reva.singh"). Everything
 *  else — "no-reply", "security", "notifications", "adq_lab_eng" — names a function or
 *  a machine, and then the organisation is what a reader recognises. */
function spellsAPersonName(local: string): boolean {
  const words = local.split(".");
  return words.length === 2 && words.every((word) => word.length >= 2 && /^[a-z]+$/i.test(word));
}

/** The initials a face on a mail shows. The display name when the mail carries one.
 *  Failing that, the address itself is read: `reva.singh@` spells a person, so "RS",
 *  while `no-reply@sns.amazonaws.com` spells nobody — every alert mailbox in the
 *  mailbox is called that — so the organisation answers instead, "AM". */
export function mailAvatarInitials(address: MailAddress): string {
  const name = address.name.trim();
  if (name) return avatarInitials(name);
  const at = address.address.lastIndexOf("@");
  const local = at > 0 ? address.address.slice(0, at) : "";
  if (spellsAPersonName(local)) return avatarInitials(local.replace(".", " "));
  const label = domainName(mailDomain(address.address));
  return avatarInitials(label || address.address);
}

/** The picture an avatar should show for a conversation, or `undefined` when there
 *  is none to load (the avatar then keeps its tinted initials).
 *
 *  A 1:1 shows the other party's profile photo; a group chat shows the picture its
 *  members gave it — Microsoft Teams lets a group carry one, and it is the only
 *  face a multi-party thread has. */
export function conversationPhoto(c: Conversation): AvatarPhoto | undefined {
  if (c.avatar_mri) return { kind: "user", id: c.avatar_mri };
  if (c.picture_url) return { kind: "chat", url: c.picture_url };
  return undefined;
}

/** What an avatar shows when the subject has no picture to load.
 *   - "initials" — the tinted monogram on a rounded square (a team, a channel);
 *   - "person"   — a circle, for a single human;
 *   - "group"    — two people, for a chat somebody started by writing in it;
 *   - "meeting"  — a video camera, for a thread Teams created for a meeting/call.
 *  The last two are glyphs rather than initials because a multi-party thread's
 *  monogram says nothing: "[Stratumn] Daily" and "Daily standup" both read "SD",
 *  while the origin is what tells the two threads apart. */
export type AvatarFallback = "initials" | "person" | "group" | "meeting";

/** The fallback a conversation's avatar takes. One mapping, so the sidebar, the
 *  header and the command palette can never disagree about a thread's origin. */
export function conversationFallback(c: Conversation): AvatarFallback {
  if (c.kind === "one_on_one") return "person";
  // Notes is the user's own thread. It is neither a meeting nor a group of
  // people, so it keeps its monogram.
  if (c.kind === "notes") return "initials";
  return isMeetingChat(c) ? "meeting" : "group";
}

/** The glyph each of the two icon fallbacks draws. */
const FALLBACK_ICON = {
  meeting: ZoomIcon,
  group: UserMultiple02Icon,
} as const;

/** The cache/effect key of a photo: whichever of `id` / `url` / `address`
 *  addresses it. */
function photoKey(photo?: AvatarPhoto): string {
  if (!photo) return "";
  if (photo.kind === "chat") return photo.url;
  if (photo.kind === "address") return photo.address;
  return photo.id;
}

/**
 * Resolve a profile photo to a blob object URL through the controller, or `null`
 * while loading / when there is none (fall back to initials). Safe to call with
 * `undefined` (no fetch). Loads client-side only via an effect, so SSR always
 * renders the initials and hydration is stable.
 */
function useAvatarPhoto(photo?: AvatarPhoto): string | null {
  const controller = useController();
  const [src, setSrc] = useState<string | null>(null);
  const key = photoKey(photo);

  useEffect(() => {
    if (!photo || !key) {
      setSrc(null);
      return;
    }
    let active = true;
    setSrc(null);
    const loading =
      photo.kind === "chat"
        ? controller.loadAvatarPicture(photo.url)
        : photo.kind === "address"
          ? controller.loadAvatarForAddress(photo.address)
          : controller.loadAvatar(photo.kind, photo.id);
    loading
      .then((url) => {
        if (active) setSrc(url);
      })
      .catch(() => {
        // transient failure — stay on initials; the controller evicts the entry so
        // a later render retries.
      });
    return () => {
      active = false;
    };
    // Keyed on the identity the photo carries, never on the object: callers build
    // a fresh `photo` on every render.
  }, [controller, photo?.kind, key]);

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
 * fallback once fetched (and fades in), and the fallback remains while loading,
 * when the subject has no photo, or if the image fails to decode.
 *
 * `fallback` chooses that pre-photo layer's shape and its no-photo placeholder
 * (see `AvatarFallback`). "initials" (default) is the tinted monogram on a
 * rounded square, for teams and channels. "person" is circular, for a single
 * human (a 1:1 chat, a reader, a call participant): it shows their tinted
 * initials like Teams, and only falls back to a faceless circular <PersonCoin>
 * when the subject has no nameable label. A person avatar is always circular (so
 * initials, coin and any photo match), regardless of the caller's radius class.
 * "group" and "meeting" draw a glyph on the same tinted square, so a multi-party
 * thread states its origin and still keeps a colour of its own.
 */
export function Avatar(props: {
  seed: string;
  label: string;
  initials?: string;
  className?: string;
  photo?: AvatarPhoto;
  fallback?: AvatarFallback;
  /** A test handle on the avatar itself, for a spec that reads the tint or the
   *  initials it settled on. A glyph avatar keeps its own `avatar-glyph`. */
  testId?: string;
  /** A picture to draw INSTEAD of resolving `photo` — an image the caller already
   *  holds and the backend has never seen. The one caller is the dialog that gives
   *  somebody a custom face (see person-edit-dialog.tsx): the file the user just
   *  picked is not stored yet, so there is nothing for `photo` to fetch, and the
   *  preview still has to be the same avatar in the same shape. */
  overrideSrc?: string;
}) {
  const resolved = useAvatarPhoto(props.overrideSrc ? undefined : props.photo);
  const photoUrl = props.overrideSrc ?? resolved;
  const person = props.fallback === "person";
  const glyph =
    props.fallback === "meeting" || props.fallback === "group"
      ? FALLBACK_ICON[props.fallback]
      : undefined;
  const initials = props.initials ?? avatarInitials(props.label);
  // A named person shows tinted initials (like Teams); the faceless coin is only
  // for a human we can't name (a bare MRI / phone number → avatarInitials → "?").
  const coin = person && initials === "?";
  return (
    <span
      className={cn(
        "relative grid size-9 shrink-0 place-items-center overflow-hidden text-[13px] font-semibold",
        person ? "rounded-full" : "rounded-xl",
        // Initials sit on a tinted disc; a person coin brings its own gradient
        // background, so the tint is skipped only when a coin is what shows.
        !coin && tintFor(props.seed),
        props.className,
        // Re-assert round after the caller's className so dense monogram stacks
        // (which pass rounded-md/lg) still get circular avatars.
        person && "rounded-full",
      )}
      data-testid={glyph ? "avatar-glyph" : props.testId}
      data-fallback={glyph ? props.fallback : undefined}
      aria-hidden
    >
      {coin ? (
        <PersonCoin seed={props.seed} className="size-full" />
      ) : glyph ? (
        // Sized as a share of the avatar, not in pixels, so one glyph serves the
        // 36px sidebar row and the 24px palette line alike. It inherits the
        // tint's own text colour, like the initials it stands in for.
        <HugeiconsIcon icon={glyph} className="size-[58%]" strokeWidth={1.8} />
      ) : (
        initials
      )}
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

import { useEffect, useState } from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Briefcase01Icon,
  Building02Icon,
  Mail01Icon,
  MapPinIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { hasPersonOverride, type PersonOverride, type PersonProfile } from "~/lib/protocol";
import { lastSeenLabel, presenceIsUnknown, presenceLabel } from "~/lib/presence";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { PersonEditDialog } from "./person-edit-dialog";
import { PresenceBadge } from "./presence-badge";
import { usePresence } from "./use-presence";
import { useController } from "./controller-context";

/**
 * The person card Teams shows when you rest the pointer on someone's name: their
 * photo, who they are, what they do, and their live presence — with the details
 * (email, department, work location) beneath.
 *
 * Everything is fetched lazily, only once the card is actually opened, and both
 * halves are independent: the profile comes from the directory (cached for the
 * session, since it barely changes) and the presence from the presence service
 * (re-read when the cached one has aged out). Either can fail or be unknown
 * without taking the other down — a card with just a name and a photo is still
 * useful, which is why the trigger's own label seeds it.
 */

/** Dwell before the card appears / after leaving before it hides. Long enough that
 *  sweeping the cursor across a message full of mentions never flashes cards, short
 *  enough that a deliberate hover feels immediate. Mirrors Teams' own feel. */
const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 160;

/** What the card knows about someone: what we already had (their display name and
 *  MRI, straight from the message) plus whatever the lookups add. */
type PersonIdentity = { mri: string; name: string };

/** Load a person's directory card and presence for an OPEN card. Both start as
 *  `undefined` (loading) and settle to a value or `null` (nothing to show), so the
 *  card can render the useful half as soon as it lands instead of waiting for both.
 *  Nothing is requested while `open` is false — hovering is cheap by design. The
 *  presence is read once per opening (a card is a glance, not a surface that stays
 *  on screen), through the same hook the chat header uses. */
function usePersonDetails(mri: string, open: boolean) {
  const controller = useController();
  const [profile, setProfile] = useState<PersonProfile | null | undefined>(undefined);
  const [override, setOverride] = useState<PersonOverride | null>(null);
  const presence = usePresence(open ? mri : undefined);

  useEffect(() => {
    if (!open || !mri) return;
    let alive = true;
    controller
      .loadProfile(mri)
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setProfile(null));
    // Whether the user renamed or re-faced this person. Not needed to DRAW the card —
    // the backend already resolved the name and the photo — but it decides whether the
    // card says who Teams calls them, which is the honesty half of the rename.
    controller
      .loadPersonOverride(mri)
      .then((o) => alive && setOverride(o))
      .catch(() => alive && setOverride(null));
    return () => {
      alive = false;
    };
  }, [controller, mri, open]);

  return { profile, presence, override };
}

/** One detail row: an icon, the value, and (for an email) a mailto link. */
function DetailRow(props: {
  icon: React.ReactNode;
  children: React.ReactNode;
  href?: string;
  testid: string;
}) {
  const content = props.href ? (
    <a
      href={props.href}
      className="truncate underline-offset-2 hover:underline"
      // The card lives in a portal above the app; a mailto must not bubble into
      // the message row's own click handling.
      onClick={(e) => e.stopPropagation()}
    >
      {props.children}
    </a>
  ) : (
    <span className="truncate">{props.children}</span>
  );
  return (
    <div data-testid={props.testid} className="flex items-center gap-2 text-xs text-text-dim">
      <span className="shrink-0 text-text-faint">{props.icon}</span>
      {content}
    </div>
  );
}

/** The card's body — exported for the hover wrapper below and for tests, which
 *  render it directly instead of driving a real hover. */
export function PersonCard(props: {
  identity: PersonIdentity;
  open: boolean;
  /** Open the rename dialog. Owned by the WRAPPER rather than by this card, because
   *  the card lives inside a hover card that closes the moment the pointer leaves it
   *  — a dialog mounted in here would be unmounted by its own opening click. */
  onEdit?: () => void;
}) {
  const { identity } = props;
  const { profile, presence, override } = usePersonDetails(identity.mri, props.open);
  const renamed = override?.display_name?.trim() || "";
  // The name we already have is the floor: a directory lookup can only improve it.
  // Except when the USER named this person — then their choice is the answer, and the
  // directory's is demoted to the line below (see `renamedFrom`). Teams itself never
  // knows about a nickname, so a lookup can only ever contradict one.
  const name = renamed || profile?.display_name?.trim() || identity.name;
  // Who Teams says this is, shown only when the user renamed them. Kept on the card
  // for the same reason the dialog keeps it: a nickname the user cannot see through is
  // a nickname they cannot undo, and a card is where they come to ask "who is this?".
  const renamedFrom = renamed
    ? profile?.display_name?.trim() || override?.teams_name?.trim() || ""
    : "";
  const presenceKnown = presence !== undefined && !presenceIsUnknown(presence);
  const lastSeen = lastSeenLabel(presence ?? null);
  const note = presence?.out_of_office_note?.trim() || presence?.note?.trim() || "";

  return (
    <div data-testid="person-card" className="flex w-[19rem] max-w-[85vw] flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="relative shrink-0">
          <Avatar
            seed={identity.mri || name}
            label={name}
            fallback="person"
            className="size-12 text-base"
            photo={identity.mri ? { kind: "user", id: identity.mri } : undefined}
          />
          {/* The badge only appears once we actually know the state, so the card
              never asserts "offline" while the lookup is still in flight. */}
          {presenceKnown && (
            <PresenceBadge
              presence={presence ?? null}
              ring
              className="absolute -bottom-0.5 -right-0.5 size-3.5"
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div data-testid="person-card-name" className="truncate font-semibold text-foreground">
            {name}
          </div>
          {renamedFrom ? (
            <div data-testid="person-card-renamed-from" className="truncate text-xs text-text-faint">
              Teams calls them {renamedFrom}
            </div>
          ) : null}
          {profile?.job_title ? (
            <div data-testid="person-card-title" className="truncate text-xs text-text-dim">
              {profile.job_title}
            </div>
          ) : null}
          {presenceKnown ? (
            <div
              data-testid="person-card-presence"
              className="mt-1 flex items-center gap-1.5 text-xs font-medium text-foreground"
            >
              <PresenceBadge presence={presence ?? null} className="size-2.5" />
              <span className="truncate">{presenceLabel(presence)}</span>
            </div>
          ) : null}
          {lastSeen ? (
            <div data-testid="person-card-last-seen" className="text-xs text-text-faint">
              {lastSeen}
            </div>
          ) : null}
        </div>
      </div>

      {note ? (
        <p
          data-testid="person-card-note"
          className="line-clamp-3 rounded-lg bg-accent/60 px-2.5 py-1.5 text-xs italic text-text-dim"
        >
          {note}
        </p>
      ) : null}

      {profile ? (
        <div className="flex flex-col gap-1.5">
          {profile.email ? (
            <DetailRow
              testid="person-card-email"
              icon={<HugeiconsIcon icon={Mail01Icon} className="size-3.5" strokeWidth={1.8} />}
              href={`mailto:${profile.email}`}
            >
              {profile.email}
            </DetailRow>
          ) : null}
          {profile.department ? (
            <DetailRow
              testid="person-card-department"
              icon={<HugeiconsIcon icon={Briefcase01Icon} className="size-3.5" strokeWidth={1.8} />}
            >
              {profile.department}
            </DetailRow>
          ) : null}
          {profile.company_name ? (
            <DetailRow
              testid="person-card-company"
              icon={<HugeiconsIcon icon={Building02Icon} className="size-3.5" strokeWidth={1.8} />}
            >
              {profile.company_name}
            </DetailRow>
          ) : null}
          {profile.office_location ? (
            <DetailRow
              testid="person-card-location"
              icon={<HugeiconsIcon icon={MapPinIcon} className="size-3.5" strokeWidth={1.8} />}
            >
              {profile.office_location}
            </DetailRow>
          ) : null}
        </div>
      ) : profile === undefined ? (
        // Skeleton while the directory answers: three quiet bars, no spinner, so
        // the card doesn't flicker for the common sub-200ms lookup.
        <div data-testid="person-card-loading" className="flex flex-col gap-1.5" aria-hidden>
          <span className="h-3 w-40 rounded bg-accent/70" />
          <span className="h-3 w-28 rounded bg-accent/60" />
          <span className="h-3 w-32 rounded bg-accent/50" />
        </div>
      ) : null}

      {/* Rename them, and give them a face — here only. The card is where this
          belongs: it is the surface that already answers "who is this?", so it is the
          one place the user can see the real name at the moment they replace it. Only
          offered for somebody we can address, since an override is keyed on their MRI. */}
      {identity.mri && props.onEdit ? (
        <button
          type="button"
          data-testid="person-card-edit"
          className="-mx-1.5 -my-1 flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-xs text-text-dim transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={props.onEdit}
        >
          <HugeiconsIcon icon={PencilEdit02Icon} className="size-3.5" strokeWidth={1.8} />
          {hasPersonOverride(override) ? "Edit your name for them" : "Rename them here"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Wraps a person's name so resting the pointer on it opens their {@link PersonCard}
 * — the sender line above a bubble, an @mention inside one. The trigger keeps
 * whatever styling the caller gives its children (Radix renders it as a span via
 * `asChild`), and is keyboard-focusable so the card is reachable without a mouse.
 *
 * Without an MRI there is nobody to look up, so the children render bare: no
 * trigger, no hover affordance, no request.
 *
 * The rename dialog is mounted HERE, beside the hover card rather than inside it: the
 * card closes the instant the pointer leaves, so a dialog living in its content would
 * be unmounted by the very click that opened it.
 */
export function PersonHoverCard(props: {
  mri: string | undefined;
  name: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const mri = props.mri;
  if (!mri) return <>{props.children}</>;

  return (
    <>
    <HoverCardPrimitive.Root
      open={open}
      onOpenChange={setOpen}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
    >
      <HoverCardPrimitive.Trigger asChild>
        <span
          data-testid="person-hover-trigger"
          data-person-mri={props.mri}
          tabIndex={0}
          className={cn("cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", props.className)}
        >
          {props.children}
        </span>
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 rounded-xl border border-border/60 bg-popover p-3.5 text-popover-foreground shadow-pop backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1"
        >
          <PersonCard
            identity={{ mri, name: props.name }}
            open={open}
            onEdit={() => {
              // Close the card as the dialog takes over: leaving it open behind a modal
              // overlay would leave a card nothing can dismiss.
              setOpen(false);
              setEditing(true);
            }}
          />
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
    <PersonEditDialog open={editing} onOpenChange={setEditing} mri={mri} name={props.name} />
    </>
  );
}

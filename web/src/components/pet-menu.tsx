/**
 * EVERYTHING A READER CAN DO TO ONE CREATURE, behind one trigger in its own lane.
 *
 * Two of them are gestures on the sprite itself — a press pats it, a drag throws it and plays (see
 * pet-layer.tsx) — and this is everything else, which is most of it: feeding, a nap, its art, and
 * sending one's own creature home. The PAT is a row here as well as a gesture, and that is not a
 * duplicate: a reader on a phone cannot reliably press a 52px target that walks, and the row is also
 * the only place the toggle can SAY which way it goes.
 *
 * **THE TRIGGER SAYS WHOSE PET IT IS, which is the one thing the art cannot.** A canvas inherits no
 * type and carries no words, so three creatures pacing a strip are three animals nobody can
 * attribute. The trigger is therefore a NAME rather than an ellipsis: it identifies the lane, it
 * labels the control for a screen reader, and it carries the accent dot when the pet wants
 * something — which is the vocabulary the chess dot and the agent's own "on" already use in this
 * app, rather than a hue of this feature's own.
 *
 * Five rules hold the rows, and each one is somebody else's rule applied here:
 *
 *   - **EVERY ROW RIDES `DropdownMenuItem`, so the 44px touch floor is free.** One rule, in one
 *     place, for every menu in the app (§ A HOLD is how a phone reaches a menu).
 *   - **A REFUSAL IS REPORTED WHERE THE PRESS WAS MADE, which here is two places.** The menu is HELD
 *     open across a publish, exactly as the merge-request approval's is and for its reason: an
 *     outward action that failed must never be left looking like it worked, and the status line is
 *     eleven pixels at the foot of a sidebar. And because a PAT can be made on the sprite with this
 *     menu shut, the TRIGGER carries the same sentence in its own words and turns — a reader who
 *     tapped the creature is looking at its lane and not at a menu they never opened. Both read one
 *     slot (`petError`, keyed by the pet the press was about), so they cannot disagree.
 *   - **NO ROW IS OFFERED WHILE A PUBLISH IS IN FLIGHT.** `publishPetLedger` refuses a second one
 *     SILENTLY — the press never left, so there is nothing to report — and for a feed that silence
 *     is masked by press one's own optimistic act. For a DESPAWN or a SKIN change there is no
 *     optimistic draw at all, so a second press inside a round trip would be a dead control with
 *     no sentence and no cue. The signal is the ENTRY in `petPending[conversationId]` and never
 *     its `act`, which is null for exactly the two presses that need this most.
 *   - **A READER WITH NO CREATURE OF THEIR OWN IS OFFERED NO Feed, Play OR Nap, on any pet.** It
 *     is the wire's own consequence rather than a rule invented here: an act is a line in its
 *     AUTHOR's ledger, and a ledger must name a pet — so somebody who has never spawned has
 *     nowhere to write one. `petPublishFor` refuses those presses, and a row that reported a
 *     refusal would be a control that changes nothing. What they have instead is the PAT, which is
 *     a reaction and needs no record at all.
 *   - **REMOVE ASKS TWICE**, and the second press says what it costs. It is the pattern Delete and
 *     Approve already use. In the WIRE it is not irreversible — a pet taken back keeps its id and
 *     its whole history (`petPublishFor`'s spawn) — and the conversation's own menu now offers that
 *     way back, so it is no longer the one-way door it shipped as. It still asks twice, and the
 *     WORDS still promise nothing about coming back: this press posts "gone home" to everybody in
 *     the thread, and a reader who confused it with the Settings switch would be putting their
 *     creature down believing they had merely hidden it. Where the return is stated is where it can
 *     be acted on, which is the spawn row itself.
 */

import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Apple01Icon,
  Delete02Icon,
  FavouriteIcon,
  GameController01Icon,
  Moon02Icon,
  PaintBoardIcon,
} from "@hugeicons/core-free-icons";
import type { PetPress } from "~/lib/pet-act";
import { PET_SKINS } from "~/lib/pet-skin";
import { petNeedsSomething, petSnapshot, type PetFoldAct, type PetMood } from "~/lib/pet-state";
import { petSlotKey, PET_PAT_KEY, type Pet } from "~/lib/pet-thread";
import type { ChatMessage } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** What each mood is called for a reader. The code's own words are the openpets ones; a couple of
 *  them are not English a person would use about an animal, so the map is the translation and
 *  there is exactly one of it. */
const MOOD_WORDS: Record<PetMood, string> = {
  sleeping: "asleep",
  hungry: "hungry",
  tired: "tired",
  bored: "bored",
  happy: "happy",
  content: "content",
};

export function PetMenu(props: {
  conversationId: string;
  /** The creature this menu is about — anybody's. */
  pet: Pet;
  /** Every pet the thread holds, because whether the reader may act at all depends on their OWN. */
  pets: Pet[];
  messages: ChatMessage[];
  /** A publish in flight in this conversation, handed DOWN rather than subscribed to here: the
   *  gesture on the sprite is gated by the same answer, and two subscriptions to one slot are two
   *  chances for the control and the toy to disagree about whether the reader may act. */
  pending: { pet: string; act: PetFoldAct | null } | undefined;
  publish: (press: PetPress) => void;
}) {
  const controller = useController();
  const [open, setOpen] = useState(false);
  /** Whether Remove has been pressed once. It is dropped whenever the menu closes: an armed
   *  deletion the reader walked away from must not still be armed when they come back. */
  const [armed, setArmed] = useState(false);
  const pending = props.pending;
  const error = useAppState((s) => s.petError[petSlotKey(props.conversationId, props.pet.id)]);

  const pet = props.pet;
  const ours = pet.owner.isSelf;
  // Whether the reader HAS a creature of their own — which is what decides the three acts, on this
  // pet and on every other. It is read off `owner.isSelf` and never off an identity: the page is
  // never handed the user's own MRI (the backend resolves that question — § Push notifications),
  // which is exactly why `Pet.owner.isSelf` exists.
  const hasOwnPet = props.pets.some((it) => it.owner.isSelf && !it.gone);
  // A publish is in flight ANYWHERE in this conversation. The reader's ledger is one message for
  // the whole thread, so a feed on a colleague's pet and a nap on their own contend on it.
  const busy = pending !== undefined;

  // MEMOIZED, because it is a scan of the whole history and this component re-renders on every
  // scroll that mounts a row of it — three pets over a five-hundred-message thread is fifteen
  // hundred comparisons for a word in a menu nobody has opened.
  const patted = useMemo(
    () =>
      props.messages
        .find((message) => message.id === pet.messageId)
        ?.reactions?.some((reaction) => reaction.key === PET_PAT_KEY && reaction.mine) === true,
    [props.messages, pet.messageId],
  );

  const snapshot = useMemo(
    () =>
      petSnapshot(
        pet.birth,
        // The act this page has in flight, folded before its message comes back — a creature that
        // waited for a round trip before it stopped being hungry would read as one that ignored
        // the reader. It is drawn on the pet `petPending` NAMES, which for a feed on a colleague's
        // creature is theirs rather than ours.
        pending?.pet === pet.id && pending.act ? [...pet.acts, pending.act] : pet.acts,
        // A CLOCK IN A MEMO WITH NO CLOCK IN ITS DEPS, deliberately: this re-reads whenever the
        // history or the pending act moves, which over a stat that decays two points an hour is
        // indistinguishable from reading it continuously. A ticking clock here would re-render a
        // menu, and through it three sprites' hosts, for a number nobody can see change.
        Date.now(),
        pet.pats,
      ),
    [pet, pending],
  );

  const name = ours ? "You" : firstWord(pet.owner.name) || "Someone";
  const wants = petNeedsSomething(snapshot.stats);
  const whose = ours ? "Your" : firstWord(pet.owner.name) ? `${firstWord(pet.owner.name)}'s` : "Somebody's";
  const label = `${whose} ${petArtLabel(pet.skin)} — ${MOOD_WORDS[snapshot.mood]}, level ${snapshot.level}`;

  /** Publish and KEEP THE MENU OPEN, so the refusal — or the pet visibly reacting — is met where
   *  the press was made. Radix closes a menu on select, which for an outward action would take the
   *  only surface that can report it away in the same frame. */
  const act = (press: PetPress) => (event: Event) => {
    event.preventDefault();
    props.publish(press);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setArmed(false);
      }}
    >
      <DropdownMenuTrigger
        data-testid="pet-menu-trigger"
        data-pet={pet.id}
        data-wants={wants ? "true" : undefined}
        data-error={error ? "true" : undefined}
        // A REFUSAL IS VISIBLE WITH THIS MENU SHUT, which is what a tap on the sprite needs: a pat
        // is published from the creature itself, so the reader who made that press is looking at the
        // lane rather than at a menu they never opened. The trigger turns, its own words carry the
        // sentence, and the menu one press away draws it in full — the composer's rule, at the size
        // a 24px pill has.
        aria-label={error ? `${label} — ${error}` : label}
        title={error ? `${label} — ${error}` : label}
        className={cn(
          // The INK is a 24px pill and the TARGET is 44px, grown with a pseudo-element rather than
          // by making the pill itself a thumb wide — the technique the dialog's close and the
          // slider's thumb already use, each citing the other. A creature is a small piece of art
          // in a scrolling column, and its control must not be bigger than it is.
          "pointer-events-auto relative flex h-6 max-w-full items-center gap-1 rounded-full bg-panel px-2 text-[11px] shadow-chip transition-colors",
          "after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          error ? "text-destructive" : "text-text-dim hover:text-foreground",
        )}
      >
        <span className="truncate">{name}</span>
        {wants && (
          // The app's ONE accent, which is what says "this wants something" everywhere else here —
          // the chess dot and the agent's own "on". A pet may not introduce a hue.
          <span data-testid="pet-wants-dot" aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent data-testid="pet-menu" align="end" side="top" className="min-w-[13rem]">
        <DropdownMenuLabel className="normal-case tracking-normal">{label}</DropdownMenuLabel>

        {/* THE PAT IS A REACTION, so it is the one thing here that needs no ledger and takes no
            pending slot: it is a single tap in every client the reader's colleagues might be
            holding, and it TOGGLES, so pressing again takes it back. */}
        <DropdownMenuItem
          data-testid="pet-pat"
          onSelect={(event) => {
            event.preventDefault();
            void controller.patPet(props.conversationId, pet);
          }}
        >
          <HugeiconsIcon icon={FavouriteIcon} className="size-4 shrink-0" strokeWidth={1.8} />
          {patted ? "Take your pat back" : "Pat"}
        </DropdownMenuItem>

        {hasOwnPet ? (
          <>
            <DropdownMenuItem data-testid="pet-feed" disabled={busy} onSelect={act({ kind: "feed", pet: pet.id })}>
              <HugeiconsIcon icon={Apple01Icon} className="size-4 shrink-0" strokeWidth={1.8} />
              Feed
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="pet-play" disabled={busy} onSelect={act({ kind: "play", pet: pet.id })}>
              <HugeiconsIcon icon={GameController01Icon} className="size-4 shrink-0" strokeWidth={1.8} />
              Play
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="pet-nap" disabled={busy} onSelect={act({ kind: "nap", pet: pet.id })}>
              <HugeiconsIcon icon={Moon02Icon} className="size-4 shrink-0" strokeWidth={1.8} />
              Nap
            </DropdownMenuItem>
          </>
        ) : (
          // NOT a disabled row: a control that reports a refusal is a control that changes nothing.
          // One sentence instead, because a menu holding a pat and nothing else says nothing about
          // why the acts are absent.
          <p data-testid="pet-no-pet-note" className="px-2.5 py-1.5 text-[11px] leading-snug text-text-faint">
            Feeding and playing take a companion of your own — an act is written into its owner's
            own record.
          </p>
        )}

        {ours && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Skin</DropdownMenuLabel>
            {PET_SKINS.map((skin) => (
              <DropdownMenuItem
                key={skin.name}
                data-testid={`pet-skin-${skin.name}`}
                // The art it already wears is drawn as the current one and cannot be pressed:
                // `petPublishFor` refuses a skin change that would write the same bytes — an
                // outward write reaching everybody in the thread and changing no reader's creature
                // — so a live row here would be one that does nothing.
                disabled={busy || skin.name === pet.skin}
                onSelect={act({ kind: "skin", skin: skin.name })}
              >
                <HugeiconsIcon icon={PaintBoardIcon} className="size-4 shrink-0" strokeWidth={1.8} />
                {skin.label}
                {skin.name === pet.skin && <span className="ml-auto text-[11px] text-text-faint">current</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="pet-remove"
              data-armed={armed ? "true" : undefined}
              destructive
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                if (!armed) {
                  setArmed(true);
                  return;
                }
                props.publish({ kind: "despawn" });
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-4 shrink-0" strokeWidth={1.8} />
              {armed ? "Send them home — everybody is told" : "Send them home"}
            </DropdownMenuItem>
          </>
        )}

        {error && (
          // The sentence the reader acts on, at the press that failed. The status line keeps the
          // raw failure for whoever reads a screenshot; this is the half a person can do something
          // about.
          <p data-testid="pet-error" className="px-2.5 py-1.5 text-[11px] leading-snug text-destructive">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The art's own label, for the words — a pet carries no name of its own on the wire. Resolved
 *  through `PET_SKINS` rather than through `petSkin`, so a skin this build does not hold reads as
 *  a plain "companion" instead of claiming the default art's name for somebody else's creature. */
function petArtLabel(skin: string): string {
  return PET_SKINS.find((it) => it.name === skin)?.label.toLowerCase() ?? "companion";
}

/** A person's first name, which is all a 130px lane has room for. */
function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

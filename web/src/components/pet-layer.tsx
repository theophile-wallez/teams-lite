/**
 * THE CREATURES THIS CONVERSATION HOLDS, walking a strip over its history.
 *
 * A pet IS its messages (see lib/pet-thread.ts), so this surface owns no pet state at all: it
 * takes the folded creatures, gives each one a lane and a canvas, and hands the canvas to the
 * vendored engine (vendor/desksprite.ts). Everything it decides is a DISPLAY decision — which
 * pets fit, where each may walk, and what each one is doing — which is why every one of those
 * decisions is a pure exported function below rather than something buried in a render.
 *
 * It is `chess-games-strip.tsx`'s overlay with a creature in it, and it keeps that file's four
 * rules for that file's reasons:
 *
 *   - **it FLOATS rather than taking room.** An overlay over the history, so nothing in the
 *     conversation moves when a pet appears or is put down — and the history's own scroll is
 *     untouched, which is what `pet.spec.ts` measures across a pet arriving.
 *   - **the FRAME LOOP is the engine's and nowhere else.** `MessagePane` re-renders on every
 *     scroll that mounts a row and on every streamed agent frame; a pet redraws sixty times a
 *     second. The two must never be the same render, so a sprite's position lives in the engine's
 *     own closure and reaches React never.
 *   - **it is BOUNDED, and it says what it left out.** {@link PET_LAYER_MAX} creatures, then a
 *     count — a group chat where five people each keep a pet is a strip of five, and five walking
 *     sprites over a conversation is a zoo rather than a companion.
 *   - **it mounts NOTHING when there is nothing to draw**, which here is three separate answers
 *     (see {@link PetLayer}).
 *
 * **NOT `overflow-hidden`, and that is a ruling rather than an omission.** The engine's landing
 * squash scales a sprite to 1.35x about its own feet, so a pet spans some nine pixels past each
 * side of its box for the dozen frames the squash takes to relax — clipping would take back
 * exactly what scaling about the feet bought. It also buys nothing: `bandBounds` already keeps the
 * whole creature inside the box by subtracting the sprite's own width, so nothing can walk out.
 *
 * **THE ARENA CLEARS THE THREE BANDS THIS RECTANGLE ALREADY OWES, IN TWO CONSTANTS** — the chess
 * strip above, and the composer's fade with `JumpToLatest`'s reach inside it below (see
 * {@link PET_LAYER_TOP_PX} and {@link PET_LAYER_BOTTOM_PX}).
 *
 * **THE CANVAS IS NOT DEVICE-PIXEL-RATIO AWARE, and that is a refusal rather than an oversight.**
 * The engine sizes its own backing store to the skin's declared pixel count and draws each art
 * pixel as a `PX`-wide `fillRect` under `image-rendering: pixelated` — so a browser upscaling that
 * by a whole-number device ratio reproduces every block exactly, which is the one case where a
 * bigger backing store buys nothing at all. Buying it anyway would mean writing `canvas.width`
 * behind the vendored engine and scaling its context, i.e. a second answer to "how big is this
 * sprite" — the class of bug § A picture somebody SENT calls "the box IS the picture". A skin
 * authored with anti-aliased art rather than blocks is what would change the answer, and none is.
 *
 * **A PRESS PATS THE CREATURE AND A DRAG THROWS IT, and the engine is what tells them apart.** Both
 * are outward writes — a pat is a reaction on the pet's ledger message, a throw publishes a `play`
 * act — so both hang off the two callbacks the engine RAILS (`onTap` and `onThrow`, split by the
 * distance the pointer travelled) and never off `onGrab`, which fires for an ordinary scroll that
 * happens to start on a pet. The split is the engine's own PATCH 4 rather than a second gesture
 * interpreter here: without a distance the two gestures were ONE, and a press aimed at whatever a
 * creature had wandered over published an act that cost it energy and stayed in its record for good.
 *
 * The two are deliberately asymmetric in what they risk, which is what decided which is which: a pat
 * TOGGLES and writes no record, so the gesture a reader makes by accident is the one that takes
 * itself back, while the act with a cost is behind a gesture nobody performs without meaning to.
 *
 * **AND AN ACCIDENTAL PRESS STILL PUBLISHES SOMETHING — say so plainly, because it is the trade and
 * not a bug that was fixed.** The canvas takes `pointer-events: auto` and claims `pointerdown`, so a
 * tap the reader aimed at a bubble a creature had wandered over reaches the pet and pats it: an
 * outward write, a `heart` reaction on the pet's own ledger message, under the reader's name. What
 * the distance split changed is WHICH write — it was an `edit` that took energy off the creature and
 * appended to its record for ever, and it is now a reaction that the next press takes back. Nobody
 * should later read this as "an accidental press publishes nothing". Costing the reader that press
 * at all is the price of a toy in a scrolling column, and it is why the whole layer has an off
 * switch (Settings › Companions).
 *
 * **The MENU is still its own target**, because a creature has more done to it than two gestures can
 * carry: feeding, a nap, its art, and sending it home. It is a small labelled trigger in the pet's
 * own lane (pet-menu.tsx) — one piece of furniture per pet, which is the price of a control surface
 * on a 52px sprite, and it is also where a refusal is met.
 */

import { useEffect, useRef, useState } from "react";
import { chessGameIsSettled, chessPlayerOf, type ChessGame } from "~/lib/chess-thread";
import { CHESS_STRIP_HEIGHT_PX } from "./chess-games-strip";
import { petPublishFor, type PetPress } from "~/lib/pet-act";
import type { PetFoldAct } from "~/lib/pet-state";
import { petSkin, PET_DEFAULT_SKIN, type PetSkin } from "~/lib/pet-skin";
import type { Pet } from "~/lib/pet-thread";
import type { ChatMessage } from "~/lib/protocol";
import type { AgentRun } from "~/lib/agent-run";
import {
  createSprite,
  FLOOR_MARGIN,
  PX,
  type SpriteBand,
  type SpriteBox,
  type SpriteHandle,
  type SpriteState,
} from "~/vendor/desksprite";
import { useAppState, useController } from "./controller-context";
import { usePrefersReducedMotion } from "~/lib/platform";
import { PetMenu } from "./pet-menu";

/**
 * How many creatures are drawn before the rest become a count.
 *
 * Three, which is the chess strip's own bound and for its reason — and here it is also what makes
 * a LANE wide enough to walk: at a phone's 390px, three lanes are 130px each and a 52px sprite
 * has room to pace one. A fourth would leave every pet standing almost still.
 */
export const PET_LAYER_MAX = 3;

/**
 * The band at the TOP of the history that is already owned, in CSS px.
 *
 * It is the chess strip's OWN measurement rather than a number restated here: a chip is `h-11` and
 * its container adds `py-1.5` either side, so the strip is 56px and not the 44 a reading of the chip
 * alone gives. Restated wrong, this arena began twelve pixels INSIDE a live strip and — being a later
 * sibling at the same `z-10` — painted over it: two bounded-count labels on top of each other, and a
 * pet standing at its own ceiling eating presses meant for a chip.
 *
 * The inset is unconditional rather than measured against a live game, because a pet WALKS and a
 * thrown one arcs: an arena that grew and shrank as a game came and went would move the floor under a
 * creature for a reason the reader cannot see. What it costs is 56px of height a pet never uses in a
 * conversation with no game in it.
 */
export const PET_LAYER_TOP_PX = CHESS_STRIP_HEIGHT_PX;

/**
 * The band at the BOTTOM that is already owned, in CSS px.
 *
 * `composer-fade` is `h-14` (56px) and dissolves anything below `z-20`, so a pet standing inside
 * it would fade out from the feet up. `JumpToLatest` is a 36px square at `bottom-3` — 48px of
 * reach, inside the same band — so one number clears both, and a pet's floor is the fade's own
 * top edge.
 */
export const PET_LAYER_BOTTOM_PX = 56;

/**
 * The biggest a creature may be drawn, on either side, in CSS px.
 *
 * A skin declares its own size and the shipped ones DISAGREE — `cat` and `duck` are 13x13 (52px)
 * where `blue-boy` is 14x14 (56px) — so nothing here spells a sprite's size as a constant (see
 * {@link petSpriteBox}). This is the other half of that: a size read out of data needs a ceiling,
 * or a skin authored at 40x40 would draw a 160px animal over somebody's conversation. It is a cap
 * on the ART rather than a scaler, because scaling is not available — the engine sizes its own
 * canvas from the skin, which is exactly the rule that keeps a picture from being squashed.
 */
export const PET_MAX_PX = 64;

/**
 * The shortest arena a creature can be drawn in at all, in CSS px — the tallest art this layer
 * admits, the floor margin it stands on, and 24px for the trigger pill under it (`h-6`).
 *
 * The two insets take 112px off a rectangle whose height nothing here controls — a phone in landscape
 * with a grown composer leaves less than that, and an absolutely-positioned box with both edges
 * pinned then computes a height of ZERO. `spriteFloor` floors at 0, so a pet would be drawn at the
 * arena's top edge and hang its whole body OUT of a box with no height, unclipped, over the
 * composer's fade, with its trigger pinned to the same line. It is GUARDED rather than measured: the
 * real threshold needs a render, and below this there is no room for a creature whatever it is.
 *
 * **WHAT IT COSTS, said rather than left to be found: a reader on a very short viewport has no
 * control for their creature ANYWHERE.** Nothing is drawn, so there is no pet menu — and the
 * conversation's own spawn row is correctly not offered either, because a record already stands
 * (`petSpawnIsOffered`). So a landscape phone with the keyboard up holds a companion nobody can
 * feed, rename or send home. It SELF-HEALS the moment the box grows back, which is why it is a
 * stated cost rather than a state to report: the arena element stays mounted even here, precisely so
 * it can learn the window has grown.
 */
export const PET_LAYER_MIN_PX = PET_MAX_PX + FLOOR_MARGIN + 24;

/** The drawn size of a skin, in CSS px — the ONE place `size` becomes pixels. */
export function petSpriteBox(skin: PetSkin): { w: number; h: number } {
  return { w: skin.size.w * PX, h: skin.size.h * PX };
}

/** Whether a skin is small enough to draw over a conversation. See {@link PET_MAX_PX}. */
export function petArtFits(skin: PetSkin): boolean {
  const box = petSpriteBox(skin);
  return box.w <= PET_MAX_PX && box.h <= PET_MAX_PX;
}

/**
 * The art a pet is drawn in: the skin it names, or the default when that art is too big.
 *
 * It is the reading `petSkin` already takes for a name this build does not hold — a pet in the
 * wrong skin is a pet, and a page that refused to draw one is no pet at all. There is exactly ONE
 * fallback and no loop: the default is art in this repo, `pet-layer.test.tsx` measures it against
 * {@link PET_MAX_PX}, and a build whose own default outgrew the cap is a build with a failing test
 * rather than a page looking for a third answer. (`pet-skin.test.ts` measures something else — each
 * skin's frames against its OWN declared size — and this line used to credit it with the cap.)
 */
export function petArtFor(name: string): PetSkin {
  const art = petSkin(name);
  return petArtFits(art) ? art : petSkin(PET_DEFAULT_SKIN);
}

/**
 * The lane one pet walks, as the fractions of the arena's width the engine's `band` takes.
 *
 * Divided by how many are DRAWN rather than by {@link PET_LAYER_MAX}: with three pets each lane is
 * the third the plan names, and a single creature gets the whole width instead of pacing the left
 * third of an empty strip. The lanes tile the arena exactly and in order, so two pets never share
 * a stretch of floor — which is what the whole idea of a band is for (the engine's PATCH 3 exists
 * because upstream put every sprite in one lane and three of them bunched at the same end).
 *
 * A count of zero cannot happen — the layer draws nothing then — and is answered as one rather
 * than dividing by it.
 */
export function petBand(index: number, count: number): SpriteBand {
  const lanes = Math.max(1, count);
  const lane = Math.min(Math.max(0, index), lanes - 1);
  return { from: lane / lanes, to: (lane + 1) / lanes };
}

/**
 * Which creatures are drawn, and how many were left over.
 *
 * **THE READER'S OWN PET IS NEVER THE ONE LEFT OUT, and that is a correctness rule rather than a
 * courtesy.** This layer's menu is the ONLY place in the app that changes a creature's art or sends
 * it home, and `petPublishFor` refuses a fresh spawn while a record already stands — so a reader who
 * spawned fourth in a five-person chat would have a creature they could never reach again, ageing in
 * a thread with no control anywhere. So theirs is lifted into the drawn set when message order would
 * have cut it, and only then: the chess strip orders "most urgent first" for its own version of this,
 * and re-ordering when there is already room would move somebody's lane for nothing.
 */
export function petsDrawn(pets: Pet[]): { drawn: Pet[]; hidden: number } {
  // A pet that has GONE is a record rather than a creature: its owner sent it home, and its acts
  // still count for everybody else's pets (see `Pet.gone`). Nothing draws it.
  const here = pets.filter((pet) => !pet.gone);
  const mine = here.findIndex((pet) => pet.owner.isSelf);
  const order =
    mine >= PET_LAYER_MAX ? [here[mine]!, ...here.filter((_, at) => at !== mine)] : here;
  return {
    drawn: order.slice(0, PET_LAYER_MAX),
    hidden: Math.max(0, here.length - PET_LAYER_MAX),
  };
}

/**
 * WHAT A PET IS DOING — its OWNER's state, in the engine's own vocabulary.
 *
 * **THE ENGINE HAS FOUR STATES AND THEY ARE A CLOSED SET** (`idle`, `working`, `done`, `error`):
 * anything else it is handed reads as `idle`, silently. So the five words the plan names —
 * `review`, `running`, `jumping`, `failed`, `waving`, `waiting` — are CAUSES here rather than
 * states, and this function is where a cause becomes one of the four. A function answering the
 * plan's own words would have been a second vocabulary the engine ignores, which is a pet that
 * never once changed and nothing anywhere saying why.
 *
 * What each of the four really looks like, since the shipped art carries no `work`, `done` or
 * `error` frame and all three therefore draw the IDLE rows: the pet paces FASTER while working, it
 * SPEAKS one line on entering any non-idle state, and it stands still and droops on `error`. So
 * the four are a pace and a sentence, which is exactly as much as a 13-pixel creature should say.
 *
 * **THE CADENCE IS WHAT DECIDED THE SET, and one cause was cut for it.** The engine speaks on
 * every change into a non-idle state, so a state that turns at the pace of a CONVERSATION is a
 * speech bubble per message — three of them over a busy thread. `waving` when its owner posts is
 * therefore not here: it would have been the loudest thing on the screen at the one moment the
 * reader is reading words. An agent run changes phase a handful of times per run and a chess turn
 * a handful of times an hour, so both earn their sentence.
 *
 * **AN AGENT RUN IS THE READER'S OWN, ALWAYS.** Only the user may summon the local agent
 * (`from_me`, § The local agent), so the run this page holds is theirs — it is applied to the
 * SELF pet and to no other. A colleague who runs teams-lite too has runs this page never sees, so
 * their creature mirrors their chess turn and nothing else. That is the honest shape rather than a
 * gap: this app draws no state it cannot observe.
 */
export function petSpriteState(args: {
  pet: Pet;
  /** The local agent run in this conversation, or nothing. */
  agentRun: Pick<AgentRun, "phase"> | null | undefined;
  /** Every game this thread holds, for whose turn it is. */
  games: ChessGame[];
}): SpriteState {
  const { pet, agentRun } = args;
  if (pet.owner.isSelf && agentRun) {
    if (agentRun.phase === "error") return "error";
    if (agentRun.phase === "done") return "done";
    return "working";
  }
  return args.games.some((game) => chessWaitsFor(game, pet.owner.mri)) ? "working" : "idle";
}

/** Whether a live game is waiting on this person to move. An EMPTY mri waits for nobody: a
 *  message with no author at all is a recording or a thread activity, and `"" === ""` would put
 *  every authorless creature on somebody else's clock (the guard `petOf` already carries). */
function chessWaitsFor(game: ChessGame, mri: string): boolean {
  if (!mri || !game.opponent || chessGameIsSettled(game)) return false;
  return chessPlayerOf(game, game.turn)?.mri === mri;
}

/**
 * What a press publishes, for every control in the layer and in the menu alike.
 *
 * ONE call site for `petPublishFor` + `publishPetLedger`, because a throw and a menu row are the
 * same act with a different gesture — and because the store's own refusal (one publish in flight
 * per conversation) is only correct if every press goes through it.
 *
 * A press the thread does not admit publishes NOTHING and says nothing: `petPublishFor` answers
 * null for a stale press (the pet went home while the menu was open, the reader has no ledger of
 * their own to write an act into), and a control that cannot act is not drawn in the first place —
 * this is the guard behind that, never the surface's own decision.
 */
function usePetPublish(args: {
  conversationId: string;
  pets: Pet[];
  messages: ChatMessage[];
}): (press: PetPress) => void {
  const controller = useController();
  const { conversationId, pets, messages } = args;
  return (press: PetPress) => {
    const publish = petPublishFor({ press, pets, messages, now: Date.now() });
    if (!publish) return;
    void controller.publishPetLedger(conversationId, publish);
  };
}

/**
 * The overlay, or nothing.
 *
 * **THREE ANSWERS ARE "NOTHING", and the third is a correctness rule rather than a tidy-up.**
 * The reader turned the companions off, the reader asked for less motion, or this conversation
 * holds no creature — and it is the LAST one that closes a real window: `petsShown` is read from
 * `localStorage` inside `start()`, which runs in `ControllerProvider`'s own effect, and children
 * render before any effect does. So the first committed render always carries the hopeful default
 * `true`, and a layer that keyed on the route alone would draw a pet for one frame to somebody who
 * had turned the switch off. Real pet data arrives over the socket long after `start()`, which is
 * why this gates on it.
 *
 * **AN ANIMATED CREATURE HELD STILL IS NOT A STILL CREATURE — IT IS A BROKEN ONE**, which is why
 * reduced motion draws nothing at all rather than a frozen sprite. It is `.agent-shine`'s own
 * precedent: stopped, that sweep is a smear of colour over one corner rather than a light going
 * round an edge, so it is `display: none` instead. The engine has its own, milder rule for a host
 * that asks it to move less; this layer never reaches it, and that is deliberate.
 *
 * **AND IT IS LIVE** ({@link usePrefersReducedMotion}, not motion/react's mount-only
 * `useReducedMotion`), because this is the one gate that takes the whole feature away: under
 * reduced motion nothing is drawn AND the spawn row is not offered, so a reader who turned Reduce
 * Motion OFF had no in-app path to a companion at all until they reloaded, with nothing anywhere
 * saying why. `.agent-shine`, the precedent cited above, is a CSS `@media` rule and has always been
 * live; this layer was the odd one out.
 */
export function PetLayer(props: {
  conversationId: string;
  pets: Pet[];
  messages: ChatMessage[];
  games: ChessGame[];
}) {
  const shown = useAppState((s) => s.petsShown);
  const reduce = usePrefersReducedMotion();
  if (!shown || reduce) return null;
  const { drawn, hidden } = petsDrawn(props.pets);
  if (drawn.length === 0) return null;
  return (
    <PetArena
      conversationId={props.conversationId}
      pets={props.pets}
      messages={props.messages}
      games={props.games}
      drawn={drawn}
      hidden={hidden}
    />
  );
}

/**
 * The rectangle the creatures live in, measured.
 *
 * It is a component of its own rather than a branch inside {@link PetLayer} because the box is
 * MEASURED off this element: an effect that ran while the layer was drawing nothing would find no
 * element to observe and would never run again once one appeared. Mounting the arena only when
 * there is something to put in it makes the measurement and the element arrive together.
 *
 * The measurement is a `ResizeObserver` rather than a layout read per frame — the whole point of
 * the engine's own arithmetic is that a sprite's position costs no layout — and the box is only
 * re-stated when it really changed, since an identical object would walk every sprite's `setBox`
 * for nothing.
 */
function PetArena(props: {
  conversationId: string;
  pets: Pet[];
  messages: ChatMessage[];
  games: ChessGame[];
  drawn: Pet[];
  hidden: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<SpriteBox | null>(null);
  const publish = usePetPublish({
    conversationId: props.conversationId,
    pets: props.pets,
    messages: props.messages,
  });
  // The PHASE and never the frame. A run's frame is a new object about once a second, and this
  // arena holds three sprite hosts and three menus: subscribing to the whole thing would re-render
  // all of them for every word an agent writes, which is the one thing an overlay over a
  // virtualized history must not do. A phase is a string and changes a handful of times per run.
  const agentPhase = useAppState((s) => s.agentRuns[props.conversationId]?.phase ?? null);
  // A publish this page has in flight, ANYWHERE in this conversation. It is read here rather than
  // twice below because the gesture and the menu contend on the same one message, so both halves of
  // this surface have to be gated by one answer (see `PetMenu` on why the ENTRY is the signal).
  const pending = useAppState((s) => s.petPending[props.conversationId]);
  const roomy = box !== null && box.height >= PET_LAYER_MIN_PX;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      setBox((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid="pet-layer"
      data-count={roomy ? props.drawn.length : 0}
      // The overlay passes every pointer through; only a pet and its own trigger take one. At a
      // phone's width there is no gutter — every horizontal position is over a bubble, and every
      // row under it is a live target (a hold that opens a menu, a reaction chip, a quote jump).
      className="pointer-events-none absolute inset-x-0 z-10"
      // The two insets are stated ONCE, as the constants that argue for them, rather than as
      // Tailwind classes a reader would have to convert back into pixels to check.
      style={{ top: PET_LAYER_TOP_PX, bottom: PET_LAYER_BOTTOM_PX }}
    >
      {/* NOTHING is drawn in an arena with no room for a creature — see `PET_LAYER_MIN_PX`. The
          element itself stays, because it is what the box is measured off: a layer that unmounted
          here could never learn the window had grown back. */}
      {roomy &&
        box &&
        props.drawn.map((pet, index) => (
          <PetSprite
            key={pet.id}
            conversationId={props.conversationId}
            pet={pet}
            pets={props.pets}
            messages={props.messages}
            band={petBand(index, props.drawn.length)}
            box={box}
            state={petSpriteState({
              pet,
              agentRun: agentPhase ? { phase: agentPhase } : null,
              games: props.games,
            })}
            pending={pending}
            publish={publish}
          />
        ))}
      {roomy && props.hidden > 0 && (
        // What was left out, where a reader can see it — the strip's own rule. A count that a
        // bounded list does not state reads as a complete list.
        <span
          data-testid="pets-more"
          className="absolute right-2 top-0 rounded-full bg-panel px-2 py-0.5 text-[10px] text-text-faint shadow-chip"
        >
          +{props.hidden} more
        </span>
      )}
    </div>
  );
}

/**
 * One creature: the engine's canvas, and the trigger that reaches everything else.
 *
 * The sprite is created ONCE per ART and lives in the engine's own closure from then on. Its lane,
 * its arena and its state are all re-STATED through the handle's own setters, because a rebuild
 * costs everything the closure holds — where the creature is standing, which way it faces, how far
 * through its walk cycle it is, and what it is doing. A pet only ever starts again when its owner
 * changes its art, which is a press they made about that creature.
 */
function PetSprite(props: {
  conversationId: string;
  pet: Pet;
  pets: Pet[];
  messages: ChatMessage[];
  band: SpriteBand;
  box: SpriteBox;
  state: SpriteState;
  pending: { pet: string; act: PetFoldAct | null } | undefined;
  publish: (press: PetPress) => void;
}) {
  const controller = useController();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<SpriteHandle | null>(null);
  const art = petArtFor(props.pet.skin);
  // The box and the STATE at the moment the sprite is created, without making the sprite DEPEND on
  // either: an art change builds a new creature, and it must arrive in today's arena doing today's
  // work rather than in the arena and the mood of whenever the last one was built. A fresh sprite
  // starts at the engine's own `idle`, and neither setter fires for a value that has not moved — so
  // without these two, changing a skin mid-agent-run would leave the new creature walking at idle
  // pace in a stale box.
  const boxRef = useRef(props.box);
  const stateRef = useRef(props.state);
  // What each gesture publishes, read at the moment of the gesture rather than captured when the
  // sprite was built — the pets and the history they publish from move under it several times a
  // minute, and so does whether a publish is already in flight.
  const tapRef = useRef<() => void>(() => {});
  const throwRef = useRef<() => void>(() => {});

  // Every ref here is written in an EFFECT rather than during a render, which is this app's own
  // shape for a ref (`agent-reply.tsx`, `message-pane.tsx`) and the rule React states: a render
  // that is thrown away must leave nothing behind. None can be read before its first write — a
  // gesture and a rebuild are both commits later.
  useEffect(() => {
    // A PAT: a reaction on the pet's ledger message, which needs no record of the reader's own and
    // therefore no pending slot — it is the one thing a reader with no creature can do, and it
    // TOGGLES, so a press that was not meant takes itself back.
    tapRef.current = () => void controller.patPet(props.conversationId, props.pet);
    // A THROW is an act, so it contends on the reader's one ledger message like every other: the
    // store would refuse a second publish SILENTLY, and a gesture cannot be drawn disabled the way
    // a menu row can, so it is refused here where the intent is readable. What says so to the
    // reader is the menu in the same lane, whose rows are visibly out while a publish travels.
    //
    // **A THROW BY SOMEBODY WITH NO RECORD OF THEIR OWN PUBLISHES NOTHING AND SAYS NOTHING, and that
    // is a stated cost rather than a gap that was fixed.** `petPublishFor` refuses it — an act is a
    // line in its author's OWN ledger and they have none, which is the same refusal that hides Feed,
    // Play and Nap from their menu — and a drag cannot carry the sentence a row is replaced by. What
    // they have is the PAT, which a press already gives them, and the sentence itself is one press away
    // on the trigger in this lane.
    //
    // What must NOT differ between the gesture and the rows is WHO may act, and it did for exactly one
    // reader: somebody whose own pet had GONE HOME. `hasOwnPet` asked for `isSelf && !gone` while
    // `petPublishFor` asks for `mine` — so the menu hid the three rows and this gesture published them.
    // The wire's answer is the one that decides (a departed owner's acts still count), so the menu was
    // the half that moved.
    throwRef.current = () => {
      if (props.pending) return;
      props.publish({ kind: "play", pet: props.pet.id });
    };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createSprite({
      canvas,
      skin: art,
      box: boxRef.current,
      band: props.band,
      // `onTap` and `onThrow` AND NEVER `onGrab`: the engine's host contract says why in as many
      // words — a touch scroll that starts on a pet grabs it for a frame or two before the browser
      // claims the gesture, so `onGrab` fires for a gesture nobody meant as one. The other two are
      // railed against a cancelled gesture, against a release that is not the grabbing pointer's
      // own main button, and against a hold whose release was lost; and they are split by DISTANCE,
      // so a press that moved nothing can never publish the act a fling was meant to.
      onTap: () => tapRef.current(),
      onThrow: () => throwRef.current(),
    });
    handleRef.current = handle;
    // The rebuilt sprite is told what it is doing at once, since it starts at the engine's own
    // `idle` and the state effect below will not fire for a value that did not change.
    handle.setState(stateRef.current);
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // KEYED ON THE ART, AND ON NOTHING ELSE. The engine captures the skin — its `size` is the canvas
    // it sized once and its frames are cached against that object — so new art is a new sprite, and
    // it is the reader's own press that causes one. Everything else a lane and a window can do to a
    // creature is a SETTER (`setBand`, `setBox`), because a rebuild loses its position, its state and
    // its pace: the band was in this list once, and a fourth person spawning re-cut every lane and
    // snapped every pet in the conversation to the left edge of its new one.
  }, [art]);

  useEffect(() => {
    boxRef.current = props.box;
    handleRef.current?.setBox(props.box);
  }, [props.box]);

  useEffect(() => {
    handleRef.current?.setBand(props.band);
  }, [props.band.from, props.band.to]);

  useEffect(() => {
    stateRef.current = props.state;
    handleRef.current?.setState(props.state);
  }, [props.state]);

  const lane = { left: `${props.band.from * 100}%`, width: `${(props.band.to - props.band.from) * 100}%` };

  return (
    <>
      {/* The canvas is the CALLER's — the engine sizes it, places it and takes its own pointer
          events, and it draws no colour on it. It carries `aria-hidden` because it is the art: the
          labelled control for this creature is the menu's trigger below. */}
      <canvas
        ref={canvasRef}
        data-testid="pet-sprite"
        data-pet={props.pet.id}
        data-state={props.state}
        aria-hidden
      />
      {/* The trigger sits in the pet's OWN lane, at the foot of the arena, so the creature the
          reader is looking at and the control that acts on it are in the same stretch of floor.
          The wrapper passes pointers through; the trigger inside it does not.

          `pr-2` is the GUTTER, and it is the same 8px `pets-more` above keeps and the chess strip
          beside it takes as `px-2`. Without it the rightmost lane's pill sat flush against the
          window: measured at exactly 1280.0 on a 1280px viewport and exactly 390.0 on a phone, so
          the 44px target its `after:-inset-x-1` draws ran 4px OFF SCREEN and the ink read as
          clipped. It insets every lane rather than only the last, which is the right outcome — a
          gutter that depended on which lane a creature walked in would move the target between
          two pets. */}
      <span className="pointer-events-none absolute bottom-0 flex justify-end pr-2" style={lane}>
        <PetMenu
          conversationId={props.conversationId}
          pet={props.pet}
          pets={props.pets}
          messages={props.messages}
          pending={props.pending}
          publish={props.publish}
        />
      </span>
    </>
  );
}

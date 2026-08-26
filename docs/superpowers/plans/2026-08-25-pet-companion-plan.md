# Implementation plan — A COMPANION in a conversation

Spec: `docs/superpowers/specs/2026-08-25-pet-companion-design.md` (READ IT — it is the binding
authority; this plan is its argument).

Worktree: `/home/claude/private/teams-lite/.worktrees/pet-companion` on branch `feat/pet-companion`.
`web/node_modules` is installed there. Run everything from `web/` unless a task says otherwise.

Already committed and NOT to be re-done:

- `web/src/lib/pet-wire.ts` + `pet-wire.test.ts` — the signed line. 26 tests.
- `web/src/lib/pet-state.ts` + `pet-state.test.ts` — decay, mood, level, the fold of acts. 27 tests.

## Global Constraints

Copy these verbatim into every review dispatch.

1. **NO COLON MAY EVER APPEAR IN A LEDGER LINE.** The backend substitutes custom emoji into every
   outbound body on a send AND on an edit (`src/custom_emoji.rs`, `code_spans_in_text` matches
   `:name:` anywhere with no whitespace required). One colon becomes an `<img>`, `SIGNATURE`'s own
   `[^<]*?` stops matching, and every pet in the conversation is unreadable for everybody for good.
   Every separator is `.`.
2. **A PET IS NAMED BY 6 LOWERCASE HEX, NEVER BY AN MRI.** An MRI contains colons.
3. **English only** — every identifier, comment, string, test name and commit message.
4. **Hugeicons is the only icon library.** `web/src/lib/icon-library.test.ts` scans for a second icon
   PACKAGE and must keep passing. desksprite is a vendored FILE, not an installed package. Do not
   add a dependency.
5. **The overlay never touches the virtualized history.** Never write `scrollTop`, never call
   `scrollTo`, never be a child of `[data-testid="message-scroll"]` or of a measured row, never add
   height or layout to anything the virtualizer measures. `web/e2e/history.spec.ts` polices this.
6. **`pointer-events-none` on the overlay container; `pointer-events-auto` only on a pet itself.**
   At 390px there is no gutter and every row is a live target (hold menu, reaction chips, quote jump).
7. **Compositor properties only** in any animation — `transform`/`opacity`. Never `filter`,
   `box-shadow`, `width`, `top`.
8. **Exactly ONE `data-conversation-id` in the document.** Do not render a composer, do not copy that
   attribute.
9. **`prefers-reduced-motion`: draw nothing at all.** Not held still — a wanderer frozen mid-stride is
   a smear. `web/src/styles/app.css:231-241` forces every animation to 0.001ms.
10. **No new RPC and no new gate.** `send`, `edit` and `react` are already `OUTWARD_METHODS`.
11. **No sound.**
12. **Gate for every task**: from `web/`, `bun run test` (all of it, not only the new file) and
    `bun run typecheck` must both pass. A task that touches Rust also runs `cargo test` from the repo
    root. A task that touches a page surface also runs the e2e spec named in the task.
13. **House voice.** This repo's modules open with a docstring that argues WHY, names the failure the
    rule prevents, and states costs out loud. Match `chess-wire.ts`, `chess-thread.ts` and
    `chess-games-strip.tsx`. Match their comment density; do not write bare code.
14. **Mock parity is deliberate duplication.** The mock stands for ANOTHER MACHINE and must re-spell
    the wire rather than import it, so a divergence FAILS a test instead of being impossible.

## Task 1 — `pet-thread.ts`: the fold over a thread

Create `web/src/lib/pet-thread.ts` and `web/src/lib/pet-thread.test.ts`.

Read `web/src/lib/chess-thread.ts` first — this is the same shape and its module docstring explains
the collect-then-resolve rationale. Read `web/src/lib/pet-wire.ts` and `pet-state.ts`, which exist.

Export:

```ts
export type Pet = {
  id: string;              // 6 hex
  owner: { mri: string; name: string };
  skin: string;
  birth: number;           // the ledger message's own compose_time — service-stamped
  gone: boolean;
  messageId: string;       // the ledger message, for the next edit
  acts: PetFoldAct[];      // every act by anybody, targeting this pet
  absorbed: string[];      // every message id this pet's record occupies
};
export function petsInThread(messages: ChatMessage[]): Pet[];
export function petSlotKey(conversationId: string, petId: string): string;
export function petOf(pets: Pet[], mri: string): Pet | undefined;
```

Rules, each of which needs a test:

- **ONE PASS, collect then resolve.** Walk into a `Map<petId, Draft>`, keeping first-seen order, then
  resolve and drop nulls.
- **One ledger per AUTHOR, first wins.** A second ledger from the same author is absorbed and ignored.
- **BIRTH is the ledger message's `compose_time`**, never a payload value: an edited message keeps its
  first post's time, so this is service-stamped and unforgeable. `seq`/`compose_time` mean "when this
  record was created".
- **A pet's acts come from EVERY ledger in the thread**, filtered to `act.target === pet.id`. An act
  naming a pet the thread does not hold is dropped.
- **A PAT IS A STANDING STATE, NOT A TIMED ACT** — see the ruling in the ledger. The page never
  receives a reaction's timestamp or the reactor's MRI (`ReactionUser` is `{name, mine?}` only,
  because CLAUDE.md § WHO reacted deliberately withholds MRIs from the page), so a pat cannot be
  folded in time. Instead `Pet` carries `pats: number` — the `count` of the agreed pat reaction on the
  ledger message, and nothing else. Every client sees the same count, so it converges exactly.
  This task therefore ALSO amends `pet-state.ts`, which currently has `pat` in `PET_ACT_EFFECTS`:
  - remove `"pat"` from `PetFoldAct["kind"]` and from `PET_ACT_EFFECTS`;
  - add `export const PET_PAT_AFFECTION = 15` and `export const PET_PATS_COUNTED = 3`;
  - add `export function petAffectionBonus(pats: number): number` returning
    `Math.min(pats, PET_PATS_COUNTED) * PET_PAT_AFFECTION`;
  - `petSnapshot` takes the pat count and applies the bonus to `affection` AFTER the fold, clamped to
    0…100, so it is a standing term rather than a history;
  - **a pat earns NO xp**, because a standing bonus would make a level flap as a reaction toggled;
  - update `pet-state.test.ts` for all of it, and state the cost in the docstring: un-reacting takes
    the pat back, and pats do not contribute to levelling.
- **`gone` means the pet is not drawn but its record still exists**, so acts its owner performed on
  OTHER pets still count.
- **`absorbed` lists every message of the record** so the pane can take its raw line off the history.
- A deleted ledger is not a wire at all (`petWireIn` already handles it).
- An act dated before the target's birth or after `now` is left in `acts` — `petSnapshot` refuses it,
  and one refusal site is better than two.

Do NOT import `pet-state.ts` here for anything but the `PetFoldAct` type: the derivation knows no pet
rules, which is what makes cheap surfaces possible.

## Task 2 — `pet-skin.ts` and three skins

Create `web/src/lib/pet-skin.ts`, `web/src/lib/pet-skin.test.ts`, and three skin JSON files under
`web/src/skins/`.

The format is desksprite's, documented at `/tmp/petsurvey/desksprite/docs/SKIN_FORMAT.md`; the two
bundled examples are `/tmp/petsurvey/desksprite/skins/cat.json` and `blue-boy.json`. Read all three.

```ts
export type PetSkin = {
  name: string;            // the key used on the wire: [a-z0-9][a-z0-9-]{0,23}
  label: string;           // what a reader sees
  palette: Record<string, string | null>;   // "." must map to null
  size: { w: number; h: number };
  anchor: { x: number; y: number };
  frames: Record<string, string[] | string[][]>;
  traits?: { walkSpeed?: number; messages?: Record<string, string> };
};
export const PET_SKINS: PetSkin[];
export const PET_DEFAULT_SKIN: string;
export function petSkin(name: string): PetSkin;         // falls back to the default, never throws
export function validatePetSkin(skin: unknown): string | null;  // null = valid, else the reason
```

- **Three skins, authored here, ours.** Adapt `cat` and `blue-boy` from desksprite (MIT, author
  `welltilln` — credit them in each file's `author` field and in the module docstring), and author a
  THIRD of your own design at the same `13x13`.
- **Required frame slots**: `idle`, `held`, `walk` (an array of frames). Optional with documented
  fallbacks: `fall`→`held`, `work`→`idle`, `done`→`idle`, `error`→`idle`.
- **`validatePetSkin` refuses**: a frame wider or taller than `size`, rows of unequal length, a
  palette without `"."` → null, a `name` outside the charset, a missing required slot. Each refusal
  needs a test.
- **`petSkin` never throws** — an unknown name is a colleague's newer build, and a missing pet is
  worse than the wrong art.
- Every skin in `PET_SKINS` must pass `validatePetSkin` — one test asserts that over the whole set.
- `traits.messages` carries the pet's own voice per state; keep them under 40 characters.

## Task 3 — the vendored engine

Create `web/src/vendor/desksprite.ts` from `/tmp/petsurvey/desksprite/desksprite.js` (MIT — keep the
licence header and name the upstream in the module docstring), and
`web/src/vendor/desksprite.test.ts`.

Convert it to a TypeScript MODULE with named exports (it is currently an IIFE assigning a global).
Strip everything this app does not use: the CRT desk, its clock, its calendar, lunch-at-noon, the
`skinUrl` fetch, and the injected `<style>` for desk chrome. Keep: the skin frame player, the walk
cycle, grab/dangle/throw physics, the sweat drop, and the speech bubble.

THREE patches, each with a comment naming the reason:

1. **ONE TICKER FOR EVERY PET.** Upstream `start()` creates its own rAF loops; this app draws several
   pets. Hoist the tick to a single module-level loop that every live sprite registers with, and stop
   the loop when the last sprite unregisters. openpets does exactly this with one 16 ms interval.
2. **IT WALKS A BOX IT IS GIVEN, NOT THE WINDOW.** Upstream `floorY()` reads `global.innerHeight`.
   Take the box as `{width, height}` from the caller and re-read it on resize.
3. **HOME BANDS.** A sprite is created with a band `{from, to}` as a fraction of the box width, wanders
   inside it by default, and may cross it when thrown. Upstream places several pets at fixed cascade
   offsets with no collision avoidance, which reads as broken when three bunch at one end.

Export a small surface and keep every constant upstream's: `PX = 4`, `GRAVITY = 0.9`,
`THROW_CAP = 22`, `CATCH_MARGIN = 28`, `FLOOR_MARGIN = 6`.

```ts
export const PX: number;
export type SpriteBox = { width: number; height: number };
export type SpriteHandle = {
  setState(state: string): void;
  say(text: string): void;
  setBox(box: SpriteBox): void;
  destroy(): void;
};
export function createSprite(opts: {
  canvas: HTMLCanvasElement;
  skin: PetSkin;
  box: SpriteBox;
  band: { from: number; to: number };
  onGrab?: () => void;
  onThrow?: () => void;
  reducedMotion?: boolean;
}): SpriteHandle;
```

The unit test covers the PURE helpers only (frame selection with fallbacks, the band clamp, the
physics step, the floor from a box) — no canvas, no DOM. Extract those into exported functions so they
are testable without a browser.

## Task 4 — `pet-act.ts` and the store publisher

Create `web/src/lib/pet-act.ts` + `pet-act.test.ts`, and add `publishPetLedger` to
`web/src/lib/store.ts`.

Read `web/src/lib/chess-act.ts` and `web/src/lib/store.ts`'s `publishChessLedger` (search for it) —
this is the same split, and the reasons in their comments apply unchanged.

```ts
export type PetPress =
  | { kind: "spawn"; skin: string }
  | { kind: "feed" | "play" | "nap"; pet: string }
  | { kind: "despawn" }
  | { kind: "skin"; skin: string };
export function petPublishFor(args: {
  press: PetPress;
  pets: Pet[];
  me: { mri: string; name: string };
  now: number;
}): { ledger: PetLedger; messageId?: string; label: string } | null;
```

- **A pure `press → next ledger` function, then ONE imperative publisher.** Four surfaces must not
  disagree about what an act writes.
- **The first act SENDS, every later act EDITS**, and `messageId` comes from the DERIVATION
  (`petOf(pets, me.mri)?.messageId`) — never from anything the store remembers. That is what makes
  the feature survive a reload, a second window and a phone.
- **The edit carries `content_html` AND the plain-text twin.** An edit that carried only text would
  have the line escaped and the record lost — that is why `content_html` exists on the edit RPC.
- **Returning null is a guard against a STALE press**, never how the UI decides what to draw.
- **Optimistic draw, rollback on refusal**, with `petPending` and `petError` keyed by
  `petSlotKey(conversationId, petId)` — one conversation holds several pets, and a single slot would
  draw one pet's refusal under another.
- **A pat is NOT here.** It is `react` on the pet's ledger message, from the layer.
- Refuse a press on a pet the thread does not hold, and refuse a `spawn` when the presser already owns
  a pet that is not `gone`.

## Task 5 — the mock

Edit `web/mock/server.ts`.

Read how chess does it there (search `mockParseLedger`, `maybeAnswerMockChess`, `resetMockChess`,
`mockChessSeedCount`) — including its module comment on why the wire is re-spelled rather than
imported. Do the same for pets, and copy the bugs it records as having been fixed:

- **RE-SPELL the wire** (parser, serializer, words). Do not import `pet-wire.ts`.
- **Wake the responder on EVERY path that mutates a body** — the send echo, `editMessage`, and
  `editAgentReply`. Chess was woken only by sends at first and so never answered a move.
- **Ask "am I already in this?" BEFORE "did they spawn one?"** A ledger is a STATE: the reader's
  message still says `spawn` on their fortieth act.
- **Its own fixture conversation** (`19:pet-demo@thread.v2`), a recorded seed count, and a reset that
  TRUNCATES back to it. One mock process serves the whole run.
- **A `{kind:"pet"}` test hook** arming at least: `colleague` (a colleague spawns a pet, so the
  reader's "somebody else's pet" path is really exercised), `act:<kind>` (the colleague acts NOW on the
  reader's pet — the only way to reach a live incoming act), `pat` (the colleague reacts), and
  `reset:true`.
- **Capture EDITS as well as sends** if the existing capture does not already, and honour
  `testSendError` on the edit handler.

## Task 6 — `pet-layer.tsx` and `pet-menu.tsx`

Create `web/src/components/pet-layer.tsx` and `web/src/components/pet-menu.tsx`, and mount the layer
in `web/src/components/message-pane.tsx`.

Read `web/src/components/chess-games-strip.tsx` (the overlay precedent and its four documented rules)
and `web/src/components/call-stage.tsx` (motion values + `animate()`, `clampMiniPosition`).

- **Mount point**: a third sibling of the history wrapper at `message-pane.tsx:956`, beside
  `ChessGamesStrip` and `JumpToLatest`. Classes: `pointer-events-none absolute inset-0 z-10`.
  **NOT `overflow-hidden`, and that is a ruling rather than an omission**: the engine's landing squash
  scales a sprite to 1.35x about its own feet, so a pet spans about 9 px past each side of its box for
  the ~12 frames of the squash's decay, and `overflow: hidden` would clip exactly that. It is also
  belt-and-braces that buys nothing — `bandBounds` in the engine already keeps the whole creature
  inside the box by subtracting the sprite's own width, so nothing can walk out.
- **`onThrow` is the act; `onGrab` is NOT.** The engine states this in its own host contract: a touch
  scroll that STARTS on a pet picks it up for a frame or two before the browser claims the gesture,
  so `onGrab` fires on an ordinary scroll and nothing outward or irreversible may hang off it.
  `onThrow` is railed in the engine never to fire for a cancelled gesture, which is what makes it safe
  to publish a `play` act from — without that rail every accidental scroll over a pet would have been
  an edit to a real Teams message.
- **Return null when there is nothing to draw** — no pets, the switch off, or reduced motion. The
  strip's own rule: mount nothing.
- **GATE ON REAL PET DATA, NEVER ON THE ROUTE ALONE**, and that is a correctness rule rather than a
  nicety. `petsShown` is loaded from `localStorage` inside `start()`, which runs in
  `ControllerProvider`'s own `useEffect` — and children RENDER before any effect does, so the first
  committed render always carries the hopeful default `true`. A layer mounted on the route would
  therefore draw a pet for one frame to a reader who had turned the switch off. Waiting for the
  thread's own messages closes that window, because they arrive over the socket long after `start()`.
- **THREE BANDS ARE TAKEN and the roam box must clear them**: the top `44px` while a chess game is
  live, the bottom `56px` where `composer-fade` dissolves anything below `z-20`, and a `36px` square
  at `bottom-3 right-4` / `md:right-6` (`JumpToLatest`).
- **One `<canvas>` per pet at `52x52` CSS px** (`13 * PX`), device-pixel-ratio aware.
- **Each pet's band is its index's third of the width**, capped at `PET_LAYER_MAX` (3) pets drawn.
  State how many were left out where a reader can see it — the strip's own rule.
- **A pet mirrors its OWNER**: `review`/`running`/`jumping`/`failed` from that owner's agent run,
  `waving` when they post, `waiting` on their chess turn. Read those from the store the pane already
  subscribes to. Derive the state in a pure exported function so it is unit-testable.
- **The pet owns its own frame loop.** Never lift per-frame state into `MessagePane`, which re-renders
  on every scroll that mounts a row and on every streamed agent frame.
- **The menu** (`pet-menu.tsx`) opens on a press: Feed, Play, Nap, and — on the reader's own pet only
  — Change skin and Remove. Remove asks twice. Every row rides the shared `DropdownMenuItem` so it
  clears the 44px touch floor. A refusal is reported in the menu it was pressed in, not swallowed.
- **A READER WITH NO PET OF THEIR OWN IS OFFERED NO Feed/Play/Nap, on any pet.** Task 4 refuses those
  presses and the reason is the wire's: an act lives in its author's own ledger, so a reader with no
  ledger has nowhere to write one — and a `gone: true` ledger minted to carry acts would post "Cat has
  gone home." for a creature that was never born. Their way in is the PAT (a reaction, which needs no
  ledger) and Spawn. A row that reported a refusal would be a control that changes nothing.
- **`petPending` IS ONE SLOT PER CONVERSATION, and a second press while it is held is refused.** A
  reader's ledger is ONE message for the whole conversation, so every press they make — feed on Ada's
  pet, nap on their own, despawn — contends on that one message. Two in flight both read the same base
  and last write wins, which silently loses an act; a despawn racing a feed on a colleague's pet loses
  that colleague's. So `petPending[conversationId]` is `{ pet, act }` where `act` may be null (a
  despawn carries none, and it must still take the slot), the layer draws `act` on the pet that `pet`
  names, and `publishPetLedger` refuses a second publish while the slot is held. The refusal is SILENT
  — the press never left, so there is nothing to report — which is how chess refuses a move with one
  already in flight.
- **AND THE SILENT REFUSAL PUTS AN OBLIGATION HERE: a control must not be OFFERED while that slot is
  taken.** For a feed the silence is masked, because press one's own optimistic act is already on
  screen. For a **despawn** or a **skin** change there is no optimistic draw at all, so a second press
  inside a round trip is a dead control with no sentence and no cue. Disable every row that publishes
  while `petPending[conversationId]` holds an entry — the ENTRY is the in-flight signal, never
  `?.act`, which is null for a despawn, a skin and a spawn.
- **It is released on success as well as on failure**, unlike `chessPending`, and the reason is the
  backend's own ordering: the `edit` handler writes the local row and emits the message BEFORE it
  answers `{edited:true}`, so the derived ledger already states the act by the time the promise
  resolves. Keeping it would count the act twice. So there is no `settlePetActs` to call. (The emit and
  the response may travel through different queues, so that ordering bounds the window rather than
  proving it zero.)
- **`petPublishFor` takes the thread's `messages`, not only its `pets`.** An act APPENDS to the record
  its own message states, and the fold throws away WHO performed each act — so rebuilding a ledger from
  `pets` alone would publish a record holding one act and drop everything its author had ever done. A
  `pets`/`messages` pair that disagrees publishes nothing.
- **A PAT is a press on the pet itself**, which calls `react` with a fixed emoji on the ledger
  message and toggles.
- **`prefers-reduced-motion` draws nothing.**

Follow the `clean-ui-design` conventions the app already holds: neutral-first, one accent, shadow as
border (`shadow-chip`), 8px grid, 13-14px type, radius 6-16px, light AND dark.

## Task 6b — SPAWNING one (the conversation's own menu)

**This task is an amendment, and the omission it repairs is worth stating: no task was ever assigned the
entry point.** Tasks 1–6 built the fold, the engine, the publisher, the mock and the layer, and every one
of them draws or acts on a pet that already exists — so the feature is UNREACHABLE from the UI, and
`pet-menu.tsx`'s Remove is a one-way door: it despawns the only pet a reader can have and nothing offers
to bring it back.

Edit `web/src/components/conversation-menu.tsx`, over the pure helpers in `web/src/lib/pet-act.ts`.

- **The conversation's own MENU is the home, and the argument is that section's own.** § ONE MENU in a
  conversation's header: the call, the chess challenge, the agent switch and the seal all live there
  because each is a thing this thread offers, and a control that drew itself only in some conversations
  would move the target between them. A pet is per conversation and per person, which is exactly that
  shape. It also reaches the one place the layer never does — a conversation with no messages at all,
  where the overlay mounts nothing (Task 6's gate on real pet data).
- **NO NEW GATE.** A spawn is `publishPetLedger` with a fresh id, which is the `send` that is already an
  `OUTWARD_METHODS` entry — the rule § A channel post has a TITLE states for a subject and § Pictures in
  a message for an upload: a thing that rides an existing gated call is part of that call, not a second
  action.
- **ONE PRESS, and the row says what it costs — do NOT ask twice.** A spawn posts one message to the
  thread, which every colleague sees and which the reader can take back from the same menu. Asking twice
  is for what nothing undoes (Remove, a deletion, the merge), and asking twice for a reversible post
  would teach the reader that this app's confirmations mean nothing.
- **The SKIN is picked in the row, over `PET_SKINS`, through `PickButton`** — the control the engine row
  and the colour row of the chess challenge already use, for the reason § Playing STOCKFISH gives: four
  rows of presses in one menu must not be four slightly different controls. The pick is KEPT across an
  open and a close of the menu, exactly as the chess colour and clock are: it is a preference, not a
  step.
- **It is drawn only where it would work**, and each condition is one the surface already holds:
  - the reader has no LIVE pet of their own in this conversation (`petOf` + `gone`);
  - **never in a CHANNEL** — the layer is mounted on the conversation history and a channel's is drawn
    as THREADS, which is the same limit § A SEALED chat states for a channel and for its reason;
  - **OFFERED in NOTES**, which is the deliberate opposite: a solo thread has nobody to play with, and
    a companion is the one thing there that needs nobody — the argument § Playing STOCKFISH makes for
    the computer in Notes;
  - `petsShown` is on (a spawn a reader could not see would be a message posted for nothing);
  - `petPending[conversationId]` holds no entry — Task 6's disable-on-pending obligation, and a spawn
    has no optimistic draw at all, so a second press inside a round trip is a dead control.
- **The refusal is reported in the menu it was pressed in**, never swallowed into a cue — the rule the
  approval row and the composer both hold. **Note the wrinkle**: a first spawn's `publish.pet` is a
  freshly minted id this menu has never seen, so a `petError` keyed by `petSlotKey` needs that id
  carried back from the publish rather than guessed at.
- **A `gone` pet is RE-SPAWNED, never re-minted.** `pet-wire.ts` states it in as many words — an id is
  minted once and kept, so a pet taken away and brought back is the same creature rather than a stranger
  wearing its skin, and its history of acts is still in the ledger.
- **The trigger gains NOTHING.** § ONE MENU keeps two things outside the closed menu (the chess dot and
  the agent's accent) and each earned it: a thing waiting to be done, and a standing consent about
  posting. A pet is neither.
- Testid `pet-spawn`. Every row rides the shared `DropdownMenuItem`, so the 44px floor is free.

## Task 7 — Settings › Companions

Edit `web/src/components/settings-pane.tsx` (find how an existing local switch is done — appearance,
or sender icons) and add the preference to `web/src/lib/store.ts`.

- **One switch, on by default, LOCAL per browser** — stored the way the chat pins and the appearance
  setting are, not on the backend. Whether a reader wants to look at a creature is not a fact about
  the conversation, so there is nothing to publish.
- **HIDING IS NOT DESPAWNING, and the pane says so in its own words.** The switch stops this window
  drawing them; the reader's own pet is still in the thread and their friends still see it. Removing it
  for everybody is the menu's Remove.
- **It is drawn whether or not a pet exists** — Settings is where somebody goes to turn a thing off
  before they have met it.
- Off means the layer is not mounted at all.

## Task 8 — take the line off five surfaces

Chess found four and missed one. Do all five:

1. the sidebar CHAT row preview — `previewLine` in `web/src/lib/protocol.ts`
2. the sidebar CHANNEL row preview — `channelPreviewLine`, same file
3. the Web Push body — `src/push_policy.rs`, beside `without_chess_line` (Rust; a push has no page)
4. the call / chess-page chat column — `web/src/components/conversation-chat-panel.tsx`
5. the BUBBLE itself — absorb by WIRE PRESENCE (`petWireIn(m) !== null`), never by resolved state.
   Chess absorbs from its resolved games, so a record whose root has paged out is absorbed by nothing
   and its raw line renders. Do not copy that.

Every strip RE-VALIDATES the tail before cutting (`stripPetLine` already does). The Rust one needs its
own test in `push_policy`, including the negative cases: an agent's own `— claude, via teams-lite`, a
bare em dash, and prose containing the words.

## Task 9 — end to end

Create `web/e2e/pet.spec.ts` and add a `--pet` flag to `web/scripts/preview.ts`.

Read `web/e2e/chess.spec.ts` for the shape, and `web/scripts/preview.ts`'s existing flags.

The spec must pin, each as its own test:

- the overlay draws a pet in the mock's pet conversation, and `[data-testid="message-scroll"]`'s
  `scrollTop` is UNCHANGED across the pet appearing (the history must not move)
- a pet is grabbed and thrown with the POINTER (`mouse.down`/`move`/`up`), and lands
- **A TOUCH SCROLL THAT STARTS ON A PET SCROLLS THE HISTORY, AND PUBLISHES NOTHING.** This is the
  sharpest assertion in this spec, and the only place the BEHAVIOUR can be asserted: the engine's
  `dragEnd` is closed over inside `createSprite` and reachable only through a real `PointerEvent` on a
  mounted canvas. (Its two rails — no `onThrow` for a cancelled gesture, and no `onThrow` for a pointer
  that is not the one that grabbed — are separately pinned by a source-scan test in
  `web/src/vendor/desksprite.test.ts`, which catches the guard being deleted or inverted at unit speed
  but cannot prove a browser fires `pointercancel` for a vertical flick. That half is this spec's.)
  Drive a real vertical touch drag that
  BEGINS on the pet, and assert three things — the scroller moved, `onThrow` fired no act (count the
  RPCs, not the bubbles), and the pet is not left held. What this protects is an OUTWARD WRITE: without
  the rail, every accidental scroll over a pet is an edit to a real Teams message.
- Feed reaches the mock as exactly ONE edit whose `content_html` matches
  `/<p><em>— pet [0-9a-f]{6} v1 .*, via teams-lite<\/em><\/p>/`
- a pat reaches the mock as exactly ONE reaction, and pressing again toggles it off
- a colleague's act (the `{kind:"pet"}` hook) changes the reader's pet with no reload
- the raw ledger line appears NOWHERE on screen (not in the bubble, not in the sidebar preview)
- the Settings switch off mounts no overlay
- `prefers-reduced-motion` draws nothing
- exactly ONE `[data-conversation-id]` in the document while a pet is on screen
- the layer is `pointer-events-none` and a reaction chip under a pet is still clickable

`--pet` captures: the pets in both themes, a speech bubble, the menu, the armed Remove, a phone at
390px, and the Settings switch. Use `withPreview`, and reset the `{kind:"pet"}` hook afterwards.

## Task 10 — the documentation

Edit `CLAUDE.md`.

- Add a `## A COMPANION in a conversation` section in the house voice, after the chess section. It
  states the arguments, the measured numbers, the costs, and what is unverified. The spec is the
  source; do not merely link it.
- **CORRECT § Chess in a conversation.** It says an edit "does not push". True in outcome, wrong in
  mechanism: `Store::insert_message` returns TRUE on an edit (`src/store.rs:3485,:3495`), so
  `push_live_message` IS entered on the receiving machine (`src/bin/server.rs:12275`); what stops the
  push is `claim_once("{conv}/{id}")` (`:9990`), whose table is pruned at `CLAIM_RETENTION` (24 h,
  `:269`), and what saves a ledger edited across a day boundary is that `compose_time` never moves on
  an edit so `is_stale` refuses the frame. Say it precisely, and say why it matters here: a pet is the
  first ledger in this app that lives for months.
- Add the `--pet` capture to § Automation safety's list of sanctioned preview flags.

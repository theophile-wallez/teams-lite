# A COMPANION in a conversation — the known follow-ups

**Every one of these was found, measured and deliberately NOT fixed** while the feature was built. None is a
Critical or an Important: each was ranked Minor, or ruled on and deferred with a reason. Each entry says what
it is, why it was parked, and — the part that matters when picking one up — **what it costs if the park was
wrong.**

It is committed beside the spec and the plan because it is the only record of them: the working notes it came
from were scratch and are gone. § A COMPANION in a conversation in `AGENTS.md` documents what shipped; this
documents what did not.

**Three of these want their own commit rather than a rider**, and they are the ones to read first:

- **the phone DEAD ZONE** (a vertical flick starting on a creature scrolls nothing — measured 0 px against
  185 px, because the canvas has no scrollable ancestor), whose upgrade path is named in the entry;
- **entry 27**, the `prev`/`next` and time-mark shape **shared with chess** — the right fix is one "messages
  as drawn" list feeding both, which mends chess and pet at once and therefore changes shipped rendering;
- **whether a spawn should PUSH at all** (bottom of this file), which is a product decision rather than a
  defect.

Two entries are marked **CLOSED** in place: they were mended during the build and are kept as the record of
what was found, not as open work.

Ordered by what a reader would actually notice, not by the task that found it.

## Visible to a reader

1. **`SHOWS` is shouted in visible UI copy** (Settings › Companions subtitle). The only SHOUTED word in a
   user-facing string in the whole of `web/src/components` — the house voice shouts in prose and comments,
   never in strings a reader sees. One word. *Cost if wrong: none, it is a typo-class blemish; but it is the
   kind that ships and stays for a year.*

2. **A refused pat leaves the trigger red indefinitely.** `petError` is cleared only by the next press on
   that same pet, so the sentence and the red trigger persist rather than fading. Defensible as a STATE
   rather than a toast (§ Audio calls: a state that scrolls away is one nobody can check). *Cost: a stale
   red mark on a pet whose failure the reader has already read and moved on from.*

3. **A refused press leaves that pet's PREVIOUS failure sentence on screen.** Arguably more honest than
   clearing an error for a press that never happened. *Cost: the reader reads an old sentence as if it were
   about the press they just made.*

4. **An errored pet stands outside its re-cut lane** until its state changes, because `roamStep` returns
   early on `state === "error"` and is delayed while held or falling. **Ruled: NO CLAMP** — a clamp is
   precisely the teleport round 2 deleted. Documented in the engine's own docstring instead. *Cost: two
   lanes visibly overlap for the duration of an error; the pet is still inside the box and still drawn.*

5. **A rebuild still speaks on an ART change** — a skin change re-creates the sprite, which re-plays its
   speech bubble. One press, by the pet's own owner, about that pet. *Cost: a bubble the owner arguably
   expects anyway.*

6. **A stale-held pet is dropped rather than re-grabbed** by the click that clears it. *Cost: one wasted
   press, once, on a browser that dropped a touch silently.*

## From the spawn control (Task 6b)

17. **Reduced motion makes the whole feature silently unreachable, with no sentence anywhere.** The layer draws
    nothing under `prefers-reduced-motion`, so the spawn row is correctly not offered — but `petsShown` off at
    least has a Settings switch the reader turned themselves, while this reader never asked for a companion
    feature to disappear and is told nothing. Consistent with the house rule ("drawn only where it would work",
    never a row that reports a refusal), which is why it is parked rather than fixed. **Suggestion for the final
    wave: one line in Settings › Companions saying it.** *Cost if wrong: a reader with reduced motion on
    concludes the feature does not exist.*

18. **The Companion section is permanent furniture for a reader who never takes one.** It is drawn in EVERY
    conversation's menu until they spawn, and spawning in one chat clears it only there. The menu already
    scrolls (`max-h-[min(32rem,70vh)] overflow-y-auto`), so the ~150 px costs scrolling rather than clipping the
    Seal and agent rows below it. *Cost: a reader uninterested in the feature carries it for ever, in every
    thread.*

19. **Two open pages share neither `petPending` nor `spawnedPet`.** So a phone's row stays live during the
    spawn echo window whatever the laptop just did. Inherent to a page-local pending — chess has the same
    property — and stated where the gate is. *Cost: the double-spawn window survives across two devices even
    though it is closed on one.*

20. **CLOSED — not parked.** `setOpen(false)` on the pet path is pinned after all: `helpers.ts:1304`
    (`spawnPet`) and `preview.ts` (`takeCompanion`) both `waitFor({ state: "detached" })` on the menu, so
    deleting the close fails **ten** e2e tests. The final review measured that. The original worry —
    "somebody removes the close and only a human notices" — is wrong; kept as the record.

21. **A spawn whose answer was LOST — not refused — can still leave an unreachable duplicate ledger.** The
    backend runs `send` under `retry::RetryPolicy::auth_only()` and deliberately does not retry it, because a
    timeout says nothing about whether Teams accepted the message. So a lost answer looks like a failure, the row
    comes back, and the retry mints a fresh id → a second ledger the fold absorbs whole and `despawn` can never
    reach. **Nothing in this feature can close it**: Teams publishes no idempotency key on that endpoint. Not
    introduced by the spawn control — the row was live before it existed. *Cost: the same two-visible-messages
    outcome as the closed window, on a flaky link, with a manual "Delete for everyone" as the only undo.*

22. **An echo that never arrives leaves the Spawn row disabled with no sentence** until a reload, because
    `spawnError` is the only slot that produces words. The right trade against a duplicate nothing can reach, but
    silent. *Cost: a reader on a dropped feed sees a dead "Take a cat" and is told nothing.*

23. **`petError` keeps a row under every abandoned minted id for the page's life.** Harmless — no surface reads a
    key whose pet never landed.

24. **The spawn receipt is ONE page-local slot, so two spawns in two conversations overwrite each other.**
    A press in B replaces A's receipt, and A's Spawn row is live again on return — the duplicate-send window
    at another scale. Only a per-conversation receipt (`Record<string, string>`) closes it. Same root as entry
    19 (two open pages share neither slot). *Cost: the unreachable duplicate ledger, for a reader who spawns
    in two conversations inside one echo.*

25. **A receipt whose conversation the reader LEFT dies with the menu.** Going to the chat list makes `openId`
    falsy, the menu unmounts, and the receipt goes with it. Correct as it stands — written down so nobody
    re-derives it and "fixes" it.

26. **The receipt write is pinned by TEXT, not by POSITION.** Moving it to after the `await
    publishPetLedger(…)` passes; deleting it outright fails. Near-equivalent today, because the pending
    release and the receipt write land in one React batch — so it is fragile-by-luck rather than broken. The
    receipt's whole purpose is to cover answer→echo, and nothing asserts the order. *Cost: a later reader
    moves it below the await and the window re-opens silently.*

## From the five surfaces (Task 8) — and one of these is a decision about CHESS

27. **An absorbed ledger is still the `prev`/`next` NEIGHBOUR of the messages around it, and `timeMarks` runs
    over raw `messages` too.** So a pet ledger between two *different* people's messages draws a duplicate
    sender name, and one sitting inside an hour-long gap can eat a time mark. **Chess behaves identically
    today.** Both failure directions are SAFE — a name repeated, never a *wrong* name; a mark missing, never a
    *wrong* time. **The right fix is ONE shared "messages as drawn" list feeding both `prev`/`next` and
    `messageTimeMarks`**, which mends chess and pet at once — and precisely because it changes chess's shipped
    rendering it wants its own commit and its own capture rather than a rider on this branch. *Cost: a
    cosmetic repeat or a missing mark, in a thread where somebody spawned between two colleagues' messages.*

28. **The deep-link effect never finds a node for an absorbed id**, so `clearScrollTarget` is never called and
    `deepLinkPending` keeps blocking the older-page prefetch until the reader leaves the conversation.
    Pre-existing shape, shared with chess. *Cost: one conversation's history stops paging older until the
    reader navigates away.*

29. **A preview cut landing INSIDE the wire's id — or immediately after it, with no space — still leaks the
    ~13-character marker fragment.** `split_once(' ')` fails and the strip does nothing. Narrow, and untested
    unless the fix round adds the one-line case. *Cost: `— pet 7f3a1` on a chat row, in a narrow window of
    body lengths.*

30. **`findIndex` for the absorbed-pet mapping only considers `kind === "message"`**, so a pet ledger older
    than a *recording* row maps past it. *Cost: a deep link lands one row further down than it should.*

31. **The `strip_prefix(marker) else { return }` arm in `without_wire_line` is DEAD CODE** — `preview[at..]`
    starts with the marker by construction, proved by a mutation to `unwrap_or("")` that SURVIVED (unreachable
    rather than untested). Carried over from the chess original. Decides nothing either way.

## Structural — a rule held by prose rather than by code

7. **`CHESS_STRIP_HEIGHT_PX = 56` is hand-computed** from `h-11` + `py-1.5`, with the two classes named only
   in prose. Not derivable from TS. *Cost: the chip becomes `h-12` one day, the pet arena starts 12px inside
   a live chess strip, and nothing fails.*

8. **The residual of the Critical, and the one thing nobody may misread later.** The canvas still takes
   `pointer-events: auto` and still claims `pointerdown`, so **a tap the reader aimed at a message a pet has
   wandered over is STILL an outward write** — a `heart` reaction now, rather than an `edit` that costs
   energy and appends to the ledger for ever. That is the right trade and it is argued in `pet-layer.tsx`.
   *Cost of misreading it: somebody reads the closed Critical as "an accidental press now publishes
   nothing", which is false.*

9. **The mock's act CAPTURE INDICES are unpinned** — a mock reading `act[1]` for the letter rather than the
   moment would pass. A direct consequence of a change I ordered (dropping `readersIn` for the act), and the
   same gap the skin token's second assertion form exists to close. *Cost: the mock drifts from the page's
   wire in a way no test sees — which is the class that already bit this feature over the loosened `\d+`.*

10. **The scan tests are PRESENCE checks on literals**, so a guard commented out with its text intact would
    pass — weaker than `engine-file` / `update`, which scan for the ABSENCE of a forbidden name. It still
    catches a delete, a rename and a re-key. *Cost: a rail disabled by a comment rather than by deletion.*
    **UPDATE after rounds 4 and 5: this entry is now largely CLOSED rather than parked.** A rail commented out
    with its text intact no longer passes — the helpers strip comments after slicing (round 4) including
    trailing ones (round 5), so the quoted text is gone before the assertion runs. What remains of the entry
    is entry 16 below: a `/*` inside a string literal in a scanned window. The class produced **ten** measured
    instances in this feature before it was closed; the final review should still mutate every scan test
    rather than trust that count.

11. **A helper's `expect`s run in the describe body**, so a renamed marker surfaces as a **collection error**
    rather than a named failure. **Ruled: leave it**, verified by running it — the message names the file and
    the exact missing marker. *Cost: the other 24 tests in that file do not run, so a rename hides whether
    anything else broke until it is fixed.*

12. **Two verbatim full-line scan assertions are format-brittle.** Safe direction: a false failure, never a
    false pass. It already FIRED once, on the round-2 change, and behaved exactly as recorded — loud, and in
    the safe direction.

## Engine-level, each with a stated cost

13. **A TOUCH grab that ends with neither `pointerup` nor `pointercancel` can never be cleared**, because a
    fresh touch gets a fresh id. **Ruled: park.** It is stuck-pet, not unmeant-write — `onThrow` stays armed
    and UNREACHABLE, since every path into `dragEnd` requires the dead id — and under `touch-action: pan-y`
    the ordinary interruption IS `pointercancel`, which is handled. *Cost: a pet frozen in `held` with four
    document listeners retained until unmount, on a browser that drops a touch silently.*

14. **A buttonless `pointermove` while held would be a strictly stronger lost-release detector** — catching
    an out-of-window release at the first move back rather than at the next press, and covering entry 13 as
    well. Not taken because the narrower detector preserves the two-finger rule. *Cost: the lost release is
    noticed one gesture later than it could be.*

16. **A string literal containing `/*` inside a scanned window** would make the block-comment strip eat real
    code — which SATISFIES a `not.toContain` (the absence assertions in `pet-act.test.ts`, and
    `mock-pet-wire`'s colon rule). No such literal exists in any scanned window today. *Cost if wrong: an
    absence assertion passes over code it was meant to forbid — the same false-pass direction as the class
    this feature has now closed ten instances of.*

## Test-shape, low cost

15. **`companions.spec.ts:40-41`** does `page.reload()` and then `gotoApp`'s own `page.goto("/")`, so the
    comment credits the reload while the assertion rests on the second load. The round trip IS proved.
    *Cost: a comment that misdescribes which load proves the thing.*

## FOUND BY TASK 9's CAPTURES AND MEASUREMENTS — the first time these states were drawn

**NUMBERING NOTE.** This block was written as 17–21 by the task that found it, colliding with the spawn
control's own 17–21 above. It is renumbered **32–36** here — appended to the end of the number space rather
than shifting anything, so every citation already made elsewhere (the ledger, the final review) still means
what it said. Cite by number AND section from now on.

32. **A VERTICAL TOUCH FLICK THAT STARTS ON A CREATURE DOES NOT SCROLL THE HISTORY.** Measured on a Pixel 7:
    the same 200 px flick moves the conversation **185 px** from the message area and **0 px** from the
    sprite — and 0 px from the pet's own 44 px trigger pill, which is the same root cause on a second
    target. The SAFETY half of `touch-action: pan-y` holds and is now pinned behaviourally (Chromium really
    does fire `pointercancel`, nothing is published, the pet is released) — but the engine's own argument for
    choosing `pan-y` was "the browser takes the vertical gesture", and it cannot: `pet-layer` is a SIBLING of
    `message-scroll` (`message-pane.tsx`), so the canvas has no scrollable ancestor to pan. Chromium claims
    the gesture and then scrolls nothing. *Cost: on a phone, a 52 px dead zone that WALKS plus a fixed pill,
    in the bottom band of the arena where a thumb starts a flick — the exact failure § Chess records for
    `touch-action: none` on a board, one step less bad because the pet lets go.* **Not fixed here**: every
    candidate (move the layer inside the virtualized scroller; `touch-action: none` plus forwarding the pan
    in JS; the carousel-shape grab the engine already names as THE UPGRADE) is a behavioural change with its
    own trade, which is a design decision rather than a rider on the e2e task. Pinned as it IS by
    `pet.spec.ts` — "but THE HISTORY DOES NOT MOVE under that flick" — with a CONTROL flick in the same test,
    so the day it is mended that test fails and the fix is to fold its assertion back into the test above it.

33. **`prefers-reduced-motion` is read ONCE PER MOUNT and never subscribed — BEING FIXED in the final round.**
    The final review moved this out of the park with an argument the original entry missed: under reduced
    motion **the spawn row is absent too**, so a reader who turns Reduce Motion *off* has no in-app path to a
    companion at all until they reload, with nothing saying why. The live-subscription pattern already exists
    in this repo (`useCoarsePointer`, `platform.ts`), ~5 lines. Also note the original entry said "per page
    load": it is per MOUNT, and the listener DOES update the module-level value — so a later re-render from
    any other cause picks the new value up **non-deterministically**, which is worse than merely stale.
    Original text follows. `useReducedMotion` (framer-motion) is
    `useState(prefersReducedMotion.current)` with no subscription — its own source carries
    `TODO See if people miss automatically updating shouldReduceMotion setting` directly under a docstring
    claiming "It will actively respond to changes". So a reader who turns Reduce Motion on keeps their
    creatures until they reload, and one who turns it off gets none until then. `.agent-shine`, the precedent
    this layer's rule cites, is a CSS `@media` rule and IS live — so the pet layer is the odd one out.
    *Cost: one reload, on a setting nobody changes twice a day; the spec asserts the reload path rather than
    the live one and says why.*

34. **CLOSED — not parked.** The rightmost trigger's zero gutter was FIXED in Task 9's own fix round: `pr-2`
    on the lane wrapper, with `pet.spec.ts:206` measuring `pill.x + pill.width <= width - TRIGGER_TARGET_BLEED_PX`
    at both 1280 and 390. The final review confirmed it independently. Kept here as the record of what was
    found and mended, not as an open item. Original text: the
    trigger's right edge is exactly 1280.0 at 1280px and exactly 390.0 at 390px, because the lane spans
    `inset-x-0` and the pill is `justify-end` inside it. Its 44 px touch target (`after:-inset-x-1`)
    therefore extends 4 px off-screen, and the pill reads on a capture as clipped. Its own sibling in the
    same file — `pets-more` — is `right-2`, and the chess strip beside it is `px-2`. *Cost: one control in
    this feature is drawn against the edge where every other floating control in the app keeps a gutter;
    fixable in one class, but it moves a target in every lane so it wants its own argument.*

35. **A pet's MENU can cover the creature it is about** — and the original wording OVERSTATED it, which the
    final review measured: six opens as the creature walked right gave 0%, 0%, 0%, 0%, 0%, **41%**, with the
    menu's bottom sitting 24 px ABOVE the creature's feet and a geometric ceiling of about half its height.
    "The cat is entirely behind the panel" came from one screenshot and is not what the geometry allows.
    Original text follows. The trigger stands at the foot of the lane and the menu
    opens `side="top" align="end"`, so it grows up over exactly that lane — and the menu is deliberately HELD
    OPEN across a publish so a refusal can be reported where the press was made. The two decisions collide:
    the reader watching for their creature to react to a Feed is watching a menu instead. Visible in
    `${out}-menu-{light,dark}.png` and `${out}-armed-dark.png`, where the cat is entirely behind the panel.
    *Cost: the optimistic act the fold draws for a feed is invisible at the moment it is drawn.*

36. **On a phone a creature stands ON its own trigger — and this one was UNDERSTATED.** The final review
    measured it the way preview reaches that width (shrinking from 1200×850, so the floor clamp fires):
    overlap in **78 of 260 samples = 30% of the time**, and at maximum the creature covers the pill
    **entirely** (35.2 of 35.2 px). So "partly behind" is too kind: for about a third of the time the only
    labelled control for that creature is behind the creature. The pill stays clickable — its wrapper is
    painted after the canvas — but that is inference rather than measurement. Original text follows. At 390px
    a lane is 195px, the pill is at the lane's
    right edge, and a pet walking to that edge overlaps it (`${out}-phone-light.png`). *Cost: the only
    labelled control for that creature is partly behind the creature, on the width the app is read at.*

## Deliberately NOT parked — decisions handed to the final review

- **Should a spawned pet PUSH at all?** A spawn is a `send`, so it buzzes every colleague's phone with
  "Cat is here." § Push notifications says widening the delivery policy is a product decision — and
  narrowing it is equally one — so Task 8's job is only that the BODY carries no wire. Whether the
  notification should happen is a question for a human, not a cleanup.
- ~~**Three triggers at 390px** and the red trigger have never been RENDERED~~ — **DONE by Task 9.** Both
  are captured (`${out}-phone-light.png`, `${out}-phone-menu-light.png`, `${out}-refused-light.png`,
  `${out}-refused-trigger-light.png`) and both drew correctly; what they revealed is entries 19 and 21.
- ~~**`TAP_SLOP = 10` and the strolling re-lane are unrendered too.**~~ — **DONE by Task 9**, behaviourally
  and by capture. The tap/throw split holds against a real CDP touch (a tap publishes one `react` and no
  edit; a throw publishes the `play` edit), and the re-lane neither teleports the first creature nor makes it
  speak. Both are mutation-proved: inverting the split and putting the band back in the create effect's deps
  each fail a named test. NOTE what the re-lane assertion cost to get right — written the obvious way it was
  GREEN under the rebuild mutation, because a fresh sprite starts at `bounds.min` and a creature measured
  seconds after birth is still standing there, so a teleport measures as nothing. The pet is now walked well
  clear of that edge first, and that precondition is asserted rather than assumed.

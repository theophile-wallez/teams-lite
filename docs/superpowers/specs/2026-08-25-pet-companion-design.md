# A COMPANION in a conversation (a pet each, and anybody may play with anybody's)

A conversation can hold a small animated creature per person. It wanders the chat, it reacts to what
its owner is really doing — an agent run, a message, a chess game — and anybody in the thread can feed
it, play with it, pat it or put it to sleep. It is carried by ordinary Teams messages, the way a game
of chess is, so a colleague who also runs teams-lite sees the same creature in the same state and
nothing about it is stored on this machine.

`web/src/lib/pet-wire.ts` holds the line a pet message signs itself with, `pet-thread.ts` derives every
pet and every stat from the thread's own messages, `pet-act.ts` decides what a press publishes,
`pet-state.ts` the animation a pet is in at this instant, and `web/src/components/pet-layer.tsx` draws
them. The engine is a vendored copy of **desksprite** (MIT), and the art is skins this repo authors.

## THE THREAT TO THE FEATURE IS TRAFFIC, and it is what every decision below answers

A pet that published its animation would be unshippable. Chess edits one message per MOVE — about one
a minute. A creature reacting to an agent's tool calls changes state about once a second, and a thread
cannot carry dozens of writes a minute for a decoration. So the split is the one chess already makes,
one level up:

- **What TRAVELS is an ACT** — somebody fed it, somebody played with it. Human cadence: a few an hour,
  tens a day for three people.
- **Everything else is DERIVED.** The animation, the mood, the four stats, the level, the speech: every
  client computes them from the thread it already holds plus its own clock, and reaches the same answer
  with nothing transmitted.
- **Position is LOCAL and unsynced.** Two readers have two window sizes, so a shared coordinate is
  traffic bought for nothing. What is shared is the creature's STATE; where it is standing is each
  window's own business.

## THE STATS NEED NO SYNC AT ALL, and that is the fact the whole design rests on

Measured off openpets' own virtual-pet plugin: decay is a **pure function of elapsed time**. Awake, per
hour: hunger −2, energy −3, happiness −2, affection −1. Asleep: energy +15, happiness −0.5. From full
that is 50 h to starve, 33.3 h to exhaust and 50 h to bore, and every value is clamped to 0…100.

So hunger is never a number anybody sends. It is `apply(genesis, acts, now)`, and two machines holding
the same acts hold the same pet. That is also what bounds the ledger: an act old enough has no
measurable effect on the fold, because the stats have long since saturated.

## THE WIRE — one ledger per PERSON, and an act names the pet it targets

    Nori · fed 12 · played 7 · patted 31
    — pet 7f3a1c v1 nori 1756060012345.f.7f3a1c 1756060099000.p.a91e04, via teams-lite

The envelope is the one chess uses, and it is **shared with the agent reply signature**:
`SIGNATURE = /<p>\s*<em>\s*([^<]*?)\s*<\/em>\s*<\/p>\s*$/i` — the body's LAST block. Three features now
live in that slot, so they are told apart INSIDE it. `pet` is a literal keyword followed by a
fixed-shape id, which neither the agent's `SIGNER` (a single name token, no spaces) nor
`CHESS_LINE` can match. **Reuse the `SIGNATURE` constant; do not invent a fourth envelope.**

- **The ledger belongs to its AUTHOR, and Teams enforces that for us.** A person may only edit their
  own message, so a record of "what I did" cannot be forged — the reason chess keeps a ledger per
  player.
- **A ledger holds the acts its author PERFORMED, on whichever pet.** Anybody may play with anybody's
  pet, and the actor is the only person who can write, so an act must name its target.
- **A PET IS NAMED BY A 6-HEX ID, NEVER BY AN MRI, AND THAT IS NOT A STYLE CHOICE.** An MRI is
  `8:orgid:bea5de00-…`: it contains colons, and the backend substitutes any `:name:` in an outbound
  body for a custom emoji's art (`custom_emoji::code_spans_in_text`, charset `[a-z0-9][a-z0-9-_+]{0,63}`,
  no whitespace required in front of it). One emoji named `orgid` in anybody's pack and the line becomes
  an `<img>`, `SIGNATURE`'s own `[^<]*?` stops matching, and every pet in the conversation is unreadable
  for everybody for good with nothing left to repair it with. **No colon ever appears in a ledger line**,
  every separator is a full stop, and the first test written asserts
  `serialize(everythingSet)).not.toContain(":")`. Chess never met this because its author IS its player;
  here an act reaches across people, so the id exists to keep an identity out of the text.
- **AN ACT TOKEN STARTS WITH ITS TIMESTAMP, so it starts with a DIGIT.** That is chess's own
  discriminator, and it buys the right failure mode: a NAMED token this build does not know is
  **ignored** (so a newer build's pet still folds), while a token starting with a digit that does not
  parse **refuses the whole record** (so a corrupt act is never half-applied). Every field is
  length-bounded at the parse — 1–15 digits for an epoch, exactly 6 hex for an id — because an
  unbounded `\d+` is how 400 characters of garbage becomes a number nothing can reason about.
- **The log is BOUNDED to `PET_ACTS_KEPT` (30) acts per person**, which is safe rather than sloppy: the
  stats clamp and saturate in about 50 h, so dropping an act a week old moves the fold by nothing a
  reader could see. It is what keeps a message edited for months from growing without limit.
- **Serialization is DETERMINISTIC by construction** — one fixed token order, and the acts sorted here
  rather than trusted from the caller — so two builds holding the same state emit the same bytes, a
  no-op edit really is a no-op, and the wire is assertable.
- **The words above the line state the STATE, never the event**, and are regenerated from the same state
  on every act. A message whose words said one event while its line held forty would lie to every client
  but this one.
- **A DELETED message is never a wire.** First line of the reader, as in `agentAuthorship`.
- **An unknown VERSION degrades to an ordinary message**: the payload is recognised only on the literal
  prefix `"v1 "`, so a `v3` line from a newer build draws its words and no pet.
- **The line must be LAST, and nothing may inject a tag into it.** So a pet act can never carry a
  picture: `message_content` appends images AFTER the body and would break the trailing-block match.
- **The marker must survive FLATTENING.** The strip sites work over `plain_text_from_html`, which keeps
  one newline per block, so the words and the line are two blocks rather than one styled span.

## WHAT EACH ACT COSTS, measured in this crate

| act | carrier | what it costs |
| --- | --- | --- |
| feed, play, nap, spawn, despawn, rename | one **edit** of the actor's own ledger | no new row, no chime, no preview bump |
| **pat** | a Teams **reaction** on that pet's own message | no new row, toggles so it repeats, carries the reactor's MRI |
| grab, dangle, throw, land, walk, wander | **nothing** — local | free |
| every animation, mood, stat, level, line of speech | **derived** | free |

**A REACTION IS THE SAFEST WRITE HERE, one gate earlier than an edit.** A reaction frame carries an
empty `content`, so `Store::insert_message` returns false and `push_live_message` is never reached
(`src/bin/server.rs:12274`). An **edit** is quiet for a subtler reason, and CLAUDE.md § Chess states it
imprecisely: `insert_message` returns **true** on an edit, because the `ON CONFLICT DO UPDATE … WHERE
excluded.content <> '' AND messages.content <> excluded.content` clause fires
(`src/store.rs:3485,:3495`), so the push path IS entered on the receiving machine. What stops the push
is `claim_once("{conv}/{id}")` — one push per message id, ever (`:9990`) — and that table is pruned at
`CLAIM_RETENTION` (24 h, `:269`). A ledger edited across a day boundary can re-take its claim, and what
saves it is that `compose_time` never moves on an edit, so `is_stale` refuses the frame. **A pet is the
first ledger here that lives for months**, so the correction belongs in CLAUDE.md in this same change.

**The EDIT must carry `content_html`.** `edit` escaped its text before chess; escaped, the line comes
back as characters, `SIGNATURE` never matches again, and every reader loses the state while the message
is still there. Send the plain-text twin as well, for a client that shows no HTML.

**No new RPC, and no new gate.** `send`, `edit` and `react` are already `OUTWARD_METHODS` entries; a
pet's acts ride them as a mention and a picture ride a send. Nothing here reaches a stranger's server,
so there is no fetch to gate either.

## WHAT A PET REACTS TO — each one mirrors its OWNER

This is what three pets buy that one shared pet could not: three creatures doing three different things
at once, each legible at a glance. Every row is derived, so none of it is sent.

| the pet does | because its owner |
| --- | --- |
| `review` → `running` → `jumping` / `failed` | has an agent run going, and it finished or failed |
| `waving` | posted a message |
| `jumping` | had a message reacted to |
| `waiting` | has a chess move due |
| `running-left` / `running-right` | is walking (local) |
| `idle`, or a mood line | nothing in particular |

The nine states and their frame counts are openpets': `idle` (6 frames, 5500 ms, infinite),
`running-right` / `running-left` (8, 1060), `waving` (4, 700, ×2), `jumping` (5, 840, ×2), `failed`
(8, 1220, ×2), `waiting` (6, 1010, infinite), `running` (6, 820, infinite), `review` (6, 1030,
infinite). The ladder is `override ?? default ?? idle`, so a state a skin lacks is never a blank pet.

**The movement REFUSAL GATE is taken verbatim**, in openpets' own order: `already-moving, hidden,
paused, dragging, transient-display, status-active`. A speech bubble therefore blocks walking, which is
why a pet never talks and walks at once.

## THE GESTURE IS LOCAL, THE ACT IS WHAT TRAVELS

Grabbing a friend's pet, dangling it and throwing it are desksprite's own physics and are sent nowhere.
What is sent is that you PLAYED with it: one act, `+25 happiness, −15 energy` — the only act that costs
the creature something. So Alice's pet gets happier because Bob threw it around, and not one coordinate
crossed the network.

The four acts are openpets': **feed** `hunger +25, xp +5`; **play** `happiness +25, energy −15, xp +5`;
**pat** `affection +15, happiness +10, xp +3`, bound to a click, which is why it is the cheapest;
**nap** `energy +40` and asleep 15 minutes, `xp +5`. Level N costs `N × 50` xp, so level 2 is ten feeds
or seventeen pats. Mood is a six-way ladder, first match wins: sleeping, hungry under 30, tired under
30, bored under 30, happy at a mean of 75, else content. **There is no death**, and a neglect line fires
at any stat under 30 with a 6 h cooldown.

**Every self-reported number is CLAMPED to what both machines can derive**, the rule
`chessClockCeilingMs` holds: a stat is recomputed from the acts rather than believed, and an act
timestamped in the future is refused.

## THE ENGINE is desksprite, vendored, and the ART is ours

desksprite (MIT, 854 lines, no dependencies) draws on `<canvas>` and injects its own CSS. A **skin is a
~2 KB JSON file**: a palette of single characters to hex, a `size`, an `anchor`, and frame slots as
arrays of equal-length character rows. `PX = 4` and a skin of `13×13` therefore draws at **52×52 px**.

Choosing it over openpets' catalogue removes a whole subsystem. openpets' art is 1.6 MB of lossless
webp per pet, on a host with no CORS and no published digest, so it would need the chess-engine
apparatus — a pinned table, a version-in-path cache, a `.part.<pid>` rename, one route whose match
decides the path, and two gated RPCs (`src/chess_engine.rs`, `web/engine-file.ts`). That apparatus
exists to give **executable** bytes an identity and to keep 7.3 MB out of a 134 MB release. Neither
justification survives a 2 KB text file in our own repo. It also settles the licence question: openpets
states no licence for its sprite art and its own footer admits some of it is unofficial fan-made
content, while a skin we author is ours.

It is a vendored FILE, not an installed package, so `web/src/lib/icon-library.test.ts` — which scans for
a second icon package — is untouched. The precedent for art that is not a hugeicons glyph is a chess
piece.

Three patches to the vendored copy, each noted where it is:

- **ONE TICKER FOR EVERY PET.** `start()` creates its own rAF loops and this feature draws several;
  openpets' own answer is a single 16 ms interval driving every pet. Several loops for several creatures
  is work nobody can see.
- **IT WALKS THE PANE, NOT THE WINDOW.** `floorY()` reads `global.innerHeight`, the desktop assumption;
  here the floor is the chat pane's own box.
- **EACH PET GETS A HOME BAND** — thirds of the pane's width. openpets places several pets at fixed
  cascade offsets with **no collision avoidance at all**, and for floor-walkers that reads as broken the
  moment all three bunch at one end. A band keeps them apart with no collision code, and they may still
  cross.

`desk: false` is what this app uses: the CRT desk, its clock and its lunch-at-noon belong to a desktop
widget, not to a conversation.

## WHERE IT IS DRAWN — one mount point, and three bands already taken

A third sibling of the **history wrapper** (`web/src/components/message-pane.tsx:956`, the only
positioned ancestor between the header and the composer), beside `ChessGamesStrip` (`:961`) and
`JumpToLatest` (`:1089`): `pointer-events-none absolute inset-0 z-10`, `overflow-hidden`, animating
only `x` / `y` motion values on a child.

That rectangle is the header's bottom edge to the composer's top edge. It costs the conversation no
layout, it is OUTSIDE the scroller so no scroll and no measurement can see it, and it survives every
re-render of the pane provided the sprite owns its own frame loop.

**Three bands inside it are taken**, and the pet's floor and roam box are cut to clear them:

- the top **44 px** while a chess game is live (the strip);
- the bottom **~56 px**, where the composer's `composer-fade` (`h-14`) dissolves anything below `z-20`;
- a **36 px** square at `bottom-3 right-4` / `md:right-6` — `JumpToLatest`, which appears the instant
  the reader scrolls up.

**Three prohibitions, each with a test already behind it.** Never write `scrollTop` or call `scrollTo`
on the scroller — a live agent run already owns it every frame with a rAF loop (`:629-645`) and
`e2e/history.spec.ts` polices the virtualizer's own scroll correction to `SLACK_PX = 2`. Never be a
child of the scroller or of a measured row. Never add height or layout to anything the virtualizer
measures.

- **`pointer-events-none` on the container is mandatory, not a nicety.** At 390 px there is no gutter:
  every horizontal position is over a bubble, and every row is a live target — a hold-to-open menu,
  reaction chips, a quote jump, a "…". Only the sprite itself takes `pointer-events-auto`, the chess
  strip's own split.
- **Compositor properties only.** The measured budget is in `web/src/lib/word-effect-motion.ts`: 8
  animating words held 60 fps, 24 sat on the edge, 100 collapsed to 8 fps, while the same DOM with
  animations off held 60 fps at 300 words — *"the DOM is not the cost, the running animations are."*
  Three sprites are well inside it; a sprite animating `filter` or `box-shadow` is exactly what
  collapsed.
- **It must not render a composer and must not copy `data-conversation-id`.** There is exactly one in
  the document and a spec counts them.
- **Under `prefers-reduced-motion` it is NOT DRAWN**, rather than held still: `app.css:231-241` forces
  every animation to 0.001 ms, and a wanderer frozen mid-stride is a smear rather than a resting pose.
  That is `.agent-shine`'s own rule.
- **It makes no sound.** A conversation that clicked every time a creature moved is one nobody can read
  in an open-plan office — what the chess CARD already holds against the chess PAGE. If it ever does, it
  rides the single `soundsEnabled` flag, is synthesized rather than fetched, and is silent on a hidden
  tab.

## THE LINE MUST BE STRIPPED ON FIVE SURFACES

Chess found four and missed one, so this feature enumerates them up front: the sidebar **chat** row
(`previewLine`), the sidebar **channel** row (`channelPreviewLine`), the **Web Push** body (in Rust,
because a push has no page), the **call / chess-page chat column**, and the **bubble** itself.

- **The bubble absorbs by WIRE PRESENCE, not by resolved state.** Chess absorbs from its resolved games,
  so a record whose root has paged out is absorbed by nothing and its raw line renders. `petWireIn(m)
  !== null` is the robust test, the one `conversation-chat-panel.tsx:101` already uses.
- **Every strip RE-VALIDATES the tail before cutting.** `lastIndexOf(marker)` then a full re-match — a
  naive `split(marker)[0]` truncates a real message that happens to contain the words.

## IT CAN BE TURNED OFF, and the switch is about THIS SCREEN

**Settings › Companions**, one switch, on by default. Off, no pet is drawn at all — not the reader's own
and not anybody else's, and the overlay is not mounted (`if (!on) return null`, the strip's own rule).

- **It is a LOCAL preference, per browser**, stored the way the chat pins and the appearance setting are.
  There is nothing to publish: whether a reader wants to look at a creature is not a fact about the
  conversation.
- **HIDING IS NOT DESPAWNING, and the pane says so.** The switch stops this window drawing them; the
  reader's own pet is still in the thread and their friends still see it. Removing it for everybody is
  an act, from the pet's own menu, and it asks twice like every other removal here.
- **It is drawn whether or not a pet exists**, because Settings is where somebody goes to turn a thing
  off before they have met it.

## THE DERIVATION — collect, then resolve

`petsInThread(messages)` walks the history ONCE into a `Map<petId, Draft>`, keeping first-seen order and
pushing every message's id into `draft.absorbed`, then resolves each draft and drops the nulls. It knows
no pet rules and imports only the wire.

- **One ledger per author, first wins.** A second ledger from the same author is absorbed and ignored.
- **Ordering is by `seq` then by the act's own timestamp**, and `seq` / `compose_time` mean "when this
  RECORD was created" — an edited message keeps its first post's time, so every later moment is carried
  in the payload.
- **An act from outside the thread, or timestamped in the future, is REFUSED and the refusal is kept**
  rather than dropped silently.
- **Terminal acts are anchored at a payload position, not at message order**, because a despawn lives in
  a message posted weeks earlier.

## THE PUBLISH PATH — one pure function, one store method

`petPublishFor(...) → {pet, ledger, messageId, pending?} | null` in `pet-act.ts`, then the single store
method `publishPetLedger`. Returning null is a guard against a STALE press, never how the UI decides
what to draw.

- **The first act SENDS, every later act EDITS**, and `messageId` comes from the DERIVATION — never from
  anything the store remembers — which is what makes the feature survive a reload, a second window and
  a phone.
- **Optimistic draw, rollback on refusal, error keyed by `(conversationId, petId)`**, because one
  conversation holds several pets and a single slot would draw one pet's refusal under another.
- **The composer is bypassed entirely.**

## DEGRADATION

| case | what happens |
| --- | --- |
| a build too old to read `v1` | the ledger's words are drawn as an ordinary message; no pet |
| an unknown named token | ignored; the rest of the line still parses |
| a malformed act token (digit-prefixed) | that whole record is refused |
| a colleague on stock Teams | one message rewritten now and then, whose words are a readable summary |
| a lost frame | nothing: the next edit carries the whole state again |
| a history paged out | the fold runs over what is loaded; the bubble absorbs by wire presence anyway |
| a deleted ledger | not a wire; that pet is gone |
| a sealed chat | works untouched — the seal is transparent to the reader, and the ledger is words |
| a channel post's title | preserved: the edit handler re-reads `thread_subject` from the store |
| a read-only backend | no act can be published; pets already in the thread are drawn |
| `prefers-reduced-motion` | not drawn |
| the switch off | not mounted |

## FILES

    web/src/lib/pet-wire.ts          the signed line, both directions, and the no-colon assertion
    web/src/lib/pet-thread.ts        the fold: every pet in a thread, from the thread's own messages
    web/src/lib/pet-state.ts         decay, mood, level, and which animation a pet is in now
    web/src/lib/pet-act.ts           what a press publishes, and the words above the line
    web/src/lib/pet-skin.ts          the skin type, the bundled skins, validation
    web/src/vendor/desksprite.ts     the vendored engine, patched (one ticker, pane floor, bands)
    web/src/components/pet-layer.tsx the overlay, and one canvas per pet
    web/src/components/pet-menu.tsx  feed / play / nap / rename / remove
    web/src/components/companions-settings.tsx   the switch
    web/skins/*.json                 the art

## THE MOCK RE-IMPLEMENTS THE WIRE, DELIBERATELY

It stands for ANOTHER MACHINE, so it re-spells the envelope, the parser, the serializer and the words
rather than importing them: a divergence between the two spellings must FAIL a test rather than be
impossible. It keeps its own ledger and EDITS it.

- **It is woken on every path that mutates a body** — the send echo, `editMessage` and
  `editAgentReply`. Chess was woken only by sends at first and so accepted a challenge and then never
  answered a move.
- **It asks "am I already in this?" BEFORE "did they spawn one?"**, because a ledger is a STATE: the
  reader's message still says `spawn` on their fortieth act.
- **Its own fixture thread, and a reset that TRUNCATES to a seed count.** One mock process serves the
  whole run, and a pet outlives a page.
- **A hook per otherwise-unreachable state**, including the half of the feature the mock would otherwise
  play itself: a colleague acting on the reader's pet.
- **Sends AND edits are captured.** Without the edit capture a spec sees a record created and never sees
  it change, because the thread gains no message.

## WHAT IS PINNED, AND WHAT IS NOT VERIFIED

Unit tests own the pure half: the wire round-trip and every refusal, the no-colon assertion, determinism
under a shuffled act list, the fold's convergence over out-of-order and partial act sets, the decay
arithmetic against openpets' measured rates, the mood ladder, the level curve, and the state chosen for
each derived signal. `web/e2e/pet.spec.ts` owns the surface: the overlay never moves the history and
never touches `scrollTop`, a pet is grabbed and thrown with the pointer, an act reaches the mock as one
EDIT with `content_html`, a pat reaches it as one reaction, the switch mounts nothing, and reduced
motion draws nothing. `cd web && bun run preview -- --out /tmp/pet --pet` captures the pets in both
themes, a bubble, the menu, a phone's width and the Settings switch.

**Unverified against the tenant** is the pairing: nobody has published a pet ledger to a real
conversation and had a colleague's install fold it. The carriers are measured — a send, an edit and a
reaction are this app's oldest writes — but a ledger of digits, spaces and full stops has never been
posted and read back byte for byte, which is the same gap the chess ledger records. A probe pinned to
the sandbox chat would close it.

**Deliberately not built**: the shared grab, where everybody watches one creature dangle in real time.
It needs a continuous cross-machine channel, and the only ephemeral one Teams offers this app is the
`Control/Typing` frame — which this app receives but never sends, and whose `content` its own parser
DISCARDS (`src/trouter_events.rs:283-308`). Sending one is a new outward write and its relay is
unmeasured, so it is an upgrade behind a probe, never a foundation.

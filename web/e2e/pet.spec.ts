import { devices, type Locator, type Page } from "@playwright/test";
import { TAP_SLOP } from "../src/vendor/desksprite";
import {
  test,
  expect,
  closeConversationMenu,
  conversationRow,
  emitLive,
  fetchCapturedEdits,
  gotoApp,
  openConversationMenu,
  openConversationNamed,
  openPetMenu,
  ownPetTrigger,
  petSprite,
  PET_THREAD_ID,
  PET_THREAD_NAME,
  resetChess,
  resetPet,
  setPetHook,
  setSendControl,
  spawnPet,
} from "./helpers";

// A COMPANION walking over a conversation.
//
// A pet IS its messages (web/src/lib/pet-thread.ts): one ledger message per person, edited in
// place, whose trailing line is a versioned wire read back out of the WORDS. So nothing about a
// creature is stored anywhere, and everything below is a reading of the thread's own history.
//
// What makes this file worth more than a spec usually is: five of the states it drives had never
// been rendered in a browser at all — every one of them was pinned by a unit test and drawn by
// nothing. The two sharpest are gestures, and both are OUTWARD WRITES:
//
//   - a TOUCH SCROLL that starts on a pet must publish NOTHING. Without that rail every accidental
//     scroll over a creature is an edit to a real Teams message. It holds — and driving it also
//     measured the half that does NOT: the flick publishes nothing and the history does not move
//     either, because the overlay has no scrollable ancestor. See the two tests under "with a
//     finger", the second of which pins that as the defect it is.
//   - a plain TAP must not publish a `play` act. It did once, with no distance threshold at all,
//     so a press aimed at a bubble a pet had wandered over appended to its record for ever.
//
// Both are counted on the SOCKET rather than in the thread (see `recordRpcs`): a page that
// published twice and drew one creature would pass every assertion about the history.
//
// Everything happens in "Pet Corner", a thread of its own — a pet is a message that STAYS, so a
// creature spawned in a shared fixture is a sprite in every later spec's history.
test.describe("a companion in a conversation", () => {
  const scroller = '[data-testid="message-scroll"]';
  const layer = '[data-testid="pet-layer"]';

  /**
   * Every RPC this page SENT, in order — read off the WebSocket.
   *
   * The three writes this feature can make are all RPCs and none of them is a row a spec could
   * count: a first spawn is a `send`, every act after it is an `edit` of that one message, and a
   * pat is a `react`. So "this gesture published nothing" is a question about the socket, and the
   * mock's own capture cannot answer it either — it records sends and edits and no reactions at all.
   *
   * It MUST be installed before the page navigates: the app opens its socket on load, and a
   * listener attached afterwards would miss every frame and report a clean gesture for a page it
   * never watched.
   */
  function recordRpcs(page: Page): () => string[] {
    const methods: string[] = [];
    page.on("websocket", (ws) => {
      ws.on("framesent", (frame) => {
        if (typeof frame.payload !== "string") return;
        try {
          const method = (JSON.parse(frame.payload) as { method?: unknown }).method;
          if (typeof method === "string") methods.push(method);
        } catch {
          /* not a JSON request frame */
        }
      });
    });
    return () => [...methods];
  }

  /** The three RPCs this feature can publish with. Anything else the page says is not a write. */
  const OUTWARD = new Set(["send", "edit", "react"]);

  /** What a run of RPCs published, in order — `send`, `edit` and `react` and nothing else. */
  function writes(methods: string[]): string[] {
    return methods.filter((method) => OUTWARD.has(method));
  }

  /** Where a creature is standing, in the arena's own pixels — the engine's `translate`. */
  async function spriteX(sprite: Locator): Promise<number> {
    const transform = await sprite.evaluate((node) => (node as HTMLElement).style.transform);
    return Number(/translate\((-?[\d.]+)px/.exec(transform)?.[1] ?? NaN);
  }

  /**
   * How far the creature's FEET are above the arena's own floor, in CSS px.
   *
   * Measured off the two real boxes rather than off the engine's numbers, because the whole defect
   * this catches is the engine's `body.y` disagreeing with the box it was handed.
   */
  async function spriteGap(page: Page, sprite: Locator): Promise<number> {
    const feet = await sprite.boundingBox();
    const arena = await page.locator(layer).boundingBox();
    if (!feet || !arena) return Number.NaN;
    return arena.y + arena.height - (feet.y + feet.height);
  }

  /**
   * How close to the floor counts as seated. `FLOOR_MARGIN` is 6px, and the landing SQUASH scales
   * the sprite about its own feet — so a creature that has just landed measures a pixel or two off
   * while the squash relaxes. The defect this bounds was measured at 127px and 406px.
   */
  const GAP_PX = 20;

  /**
   * How much of the trigger's 44px target may hang past the window: none. Its `after:-inset-x-1`
   * grows the box 4px each side, so the INK has to stop that far short of the edge.
   */
  const TRIGGER_TARGET_BLEED_PX = 4;

  /**
   * How far the trigger's 44px target hangs BELOW its own ink: `after:-inset-y-2.5`, 10px.
   *
   * The arena's floor is the composer's own top edge (`PET_LAYER_BOTTOM_PX` is 0, so the creature
   * really walks on the box), so a pill flush on that floor would put those 10px inside the bar —
   * where this overlay is the later paint at `z-10` and a press means "focus the message field".
   * `PET_TRIGGER_LIFT_PX` lifts it by exactly this much; the unit test pins the pair of numbers, and
   * this is the half that measures the real box against the real floor.
   */
  const TRIGGER_TARGET_UNDERHANG_PX = 10;

  /** Whether the reader is still holding it: the engine writes the cursor from the pose. */
  async function isHeld(sprite: Locator): Promise<boolean> {
    return (
      (await sprite.evaluate((node) => getComputedStyle(node as HTMLElement).cursor)) === "grabbing"
    );
  }

  /** Open the pet thread, with the colleague ARMED or SILENT as the test needs. */
  async function openPetThread(page: Page, opts: { silent?: boolean } = {}): Promise<void> {
    if (opts.silent) await setPetHook(page, { silent: true });
    await gotoApp(page);
    await openConversationNamed(page, PET_THREAD_NAME);
  }

  /**
   * Give the thread a HISTORY, so its scroller has somewhere to go.
   *
   * The pet fixture is one seeded message and a pet's own ledger draws no row at all, so the
   * conversation is shorter than one screen and `scrollTop` cannot move — which is not a state the
   * touch rail can be tested in. `resetPet` truncates the thread back to its seed afterwards.
   */
  async function fillHistory(page: Page, conversation: string, rows = 26): Promise<void> {
    for (let row = 0; row < rows; row++) {
      await emitLive(page, { conversation, content: `Filler line ${row} for a scrollable history.` });
    }
    await expect
      .poll(() =>
        page
          .locator(scroller)
          .evaluate((node) => node.scrollHeight - node.clientHeight),
      )
      .toBeGreaterThan(200);
  }

  test.afterEach(async ({ page }) => {
    // One mock process serves the whole run. A creature left behind is a sprite in every later
    // spec's history, a row in its menu and a state its author has to reason about — and a chess
    // game seeded here would be a chip in every later strip.
    await resetPet(page);
    await resetChess(page);
    await setSendControl(page, { clear: true });
  });

  test("the overlay draws a creature, and the history does not move under it", async ({ page }) => {
    await openPetThread(page, { silent: true });
    // Nothing is drawn in a conversation with no creature — the layer's own third answer.
    await expect(page.locator(layer)).toHaveCount(0);

    // THE HISTORY HAS TO BE ABLE TO MOVE BEFORE "it did not move" MEANS ANYTHING, and getting that
    // wrong made this — the file's headline claim — an assertion of `0 === 0`. The seeded fixture is
    // one message and a pet's ledger draws no row, so `scrollHeight === clientHeight`, `scrollTop`
    // is pinned at 0 and writing 9999 to it still reads 0. Measured: with the layer moved INTO the
    // flow, taking 160px out of the history, the test PASSED — so "it FLOATS rather than taking
    // room", the first rule this surface has, was pinned by nothing at all. `fillHistory` and a
    // scroll off the end are what make the number real, and both are asserted before the spawn.
    await fillHistory(page, PET_THREAD_ID);
    const before = await page.locator(scroller).evaluate((node) => {
      node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      return {
        top: node.scrollTop,
        height: node.clientHeight,
        scrollable: node.scrollHeight - node.clientHeight,
      };
    });
    expect(before.scrollable).toBeGreaterThan(200);
    expect(before.top).toBeGreaterThan(0);
    await page.waitForTimeout(300);

    await spawnPet(page);
    await expect(petSprite(page)).toHaveCount(1);
    await expect(page.locator(layer)).toHaveAttribute("data-count", "1");

    // THE WHOLE POINT OF AN OVERLAY: it floats rather than taking room, so a creature appearing
    // moves nothing in the conversation — neither the ROOM the history has nor the reader's place
    // in it. Read after the sprite is drawn, so the arena has been measured and every effect the
    // layer runs has run.
    const after = await page.locator(scroller).evaluate((node) => ({
      top: node.scrollTop,
      height: node.clientHeight,
    }));
    // The SIZE first, because the scroll position is a consequence of it: a layer in the flow
    // shrinks this box whether or not the reader's place happens to survive the shrink.
    expect(after.height).toBe(before.height);
    expect(after.top).toBe(before.top);
  });

  test("the creature FALLS to a floor that dropped, and its trigger keeps a gutter", async ({
    page,
  }) => {
    // THE FLOOR FOLLOWS A WINDOW BOTH WAYS, and it used to follow only one. `setBox` clamped with
    // `Math.min(body.y, floor())`, which re-seats a creature when the floor RISES and does nothing
    // when it DROPS — and a `roaming` pet walks at a fixed y, so nothing ever brought it down.
    // Measured before the fix: growing the arena from 500px to 900px tall left a 406px gap between
    // the creature's feet and its own floor, and it kept pacing mid-air with its trigger far below.
    // Every trigger is ordinary — rotating a phone, a keyboard closing, un-maximising a window.
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    const sprite = petSprite(page).first();

    // SHORTER first, which is the direction that always worked, so the creature is demonstrably
    // seated before the window grows.
    await page.setViewportSize({ width: 1280, height: 520 });
    await expect.poll(() => spriteGap(page, sprite), { timeout: 10_000 }).toBeLessThan(GAP_PX);

    // TALLER, which is the half that was broken. It FALLS, which hands the problem to the pose a
    // thrown creature already uses — so the arc, the landing and the squash are all written.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(() => spriteGap(page, sprite), { timeout: 10_000 }).toBeLessThan(GAP_PX);

    // AND THE TRIGGER KEEPS ITS GUTTER at both widths. With one creature the only lane is the
    // rightmost one, so its pill sat flush against the window — exactly 1280.0 and exactly 390.0 —
    // and 4px of its 44px target (`after:-inset-x-1`) was off screen.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const pill = await ownPetTrigger(page).boundingBox();
      const arena = await page.locator(layer).boundingBox();
      expect(pill).not.toBeNull();
      expect(arena).not.toBeNull();
      expect(pill!.x + pill!.width).toBeLessThanOrEqual(width - TRIGGER_TARGET_BLEED_PX);
      // AND IT KEEPS A GUTTER DOWNWARD TOO, which is what the arena standing on the composer costs:
      // the pill's 44px target hangs 10px below its ink, and the floor is the bar's own top edge, so
      // flush it would take a press that means "focus the message field".
      expect(pill!.y + pill!.height + TRIGGER_TARGET_UNDERHANG_PX).toBeLessThanOrEqual(
        arena!.y + arena!.height + 1,
      );
    }
  });

  test("the creature really WALKS ON the conversation box", async ({ page }) => {
    // The arena used to clear a whole 56px `composer-fade` below it, which — plus the engine's own
    // 6px `FLOOR_MARGIN` — left a companion hovering 62px over the box it is supposed to stand on.
    // The fade never needed it: it is a positioned element at `z-index: auto` and this arena is
    // `z-10` in the same stacking context, so the creature already paints over it.
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    const sprite = petSprite(page).first();
    await expect.poll(() => spriteGap(page, sprite), { timeout: 10_000 }).toBeLessThan(GAP_PX);

    // The measurement that matters is against the COMPOSER, not against the arena: the arena is
    // where this app says the floor is, and the bar is where the reader sees it.
    const feet = await sprite.boundingBox();
    const shell = await page.locator('[data-testid="composer-shell"]').boundingBox();
    expect(feet).not.toBeNull();
    expect(shell).not.toBeNull();
    const air = shell!.y - (feet!.y + feet!.height);
    // Standing on it, not hovering over it. `FLOOR_MARGIN` is 6px and a landing squash measures a
    // pixel or two off while it relaxes; the defect this bounds measured 62.
    expect(air).toBeGreaterThanOrEqual(0);
    expect(air).toBeLessThan(GAP_PX);
  });

  test("the MENU stays inside a phone's window, and its words are not cut off", async ({ page }) => {
    // A MENU THAT IS WIDER THAN THE WINDOW CANNOT BE RESCUED BY RADIX, and that is the whole of this
    // defect. Collision detection SHIFTS a panel back into view; it cannot SHRINK one. Nothing bounded
    // the width, so the prose branch of this menu measured its own intrinsic ~535px against a phone's
    // 390px window, Radix shifted it as far as the collision padding allowed, and `overflow-hidden`
    // then CLIPPED the sentence mid-word with no ellipsis and no way to read the rest. It reached a
    // reader: "Feeding and playing take a companion of your own — an act is written into" and then the
    // edge of the phone.
    //
    // THE STATE IS A COLLEAGUE'S CREATURE WITH NO PET OF THE READER'S OWN, which is why the capture
    // that already existed never showed it: `--pet`'s phone shot opens the reader's OWN menu, whose
    // rows are all short. The prose only exists on the branch `hasOwnPet` is false for, and that
    // branch had been rendered at a phone's width by nothing.
    await openPetThread(page, { silent: true });
    await setPetHook(page, { colleague: true });
    await expect(petSprite(page)).toHaveCount(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await openPetMenu(page);
    // The precondition, asserted rather than assumed: this is the WIDE shape. Without it the test
    // passes against the narrow menu it was never about.
    await expect(page.locator('[data-testid="pet-no-pet-note"]')).toBeVisible();

    const menu = page.locator('[data-testid="pet-menu"]');
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    // AND THE WORDS FIT THE BOX, which is the sharper half and the one a box measurement alone cannot
    // give: the content is `overflow-hidden`, so a panel clamped to the window with a child that
    // refuses to wrap measures perfectly and still hides the end of the sentence.
    const overflow = await menu.evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // THE THREE ASSERTIONS ABOVE ARE ALL SATISFIED BY THIS MENU'S OWN `w-72`, so on their own they
    // pin half the fix and leave the other half — the one that covers every OTHER menu — free to be
    // deleted with nothing failing. That is the shape of test defect this feature already closed
    // sixteen times, so both halves are measured separately.
    //
    // THE SHARED CLAMP, read as a COMPUTED value rather than as a class name: 366px is 390 less the
    // 12px of `collisionPadding` on each side, which is what Radix's own
    // `--radix-dropdown-menu-content-available-width` resolves to. `none` here means the rule in
    // `ui/dropdown-menu.tsx` is gone and the next menu to carry a sentence is the next menu to run
    // off the side of a phone.
    const maxWidth = await menu.evaluate(
      (node) => getComputedStyle(node as HTMLElement).maxWidth,
    );
    expect(maxWidth).toBe("366px");

    // AND THIS MENU IS NOT A SLAB, which is the half the clamp cannot give. Bounded by the window
    // alone it measures 366 of a phone's 390 — not clipped, and still the entire screen over the
    // conversation it belongs to. A declared width is what makes it a panel and what makes the
    // sentence wrap at a measure somebody can read.
    expect(box!.width).toBeLessThanOrEqual(320);
  });

  test("a creature is GRABBED and THROWN with the pointer, and it lands", async ({ page }) => {
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    const sprite = petSprite(page).first();
    const box = await sprite.boundingBox();
    expect(box).not.toBeNull();
    const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Held is a POSE and the engine writes it into the cursor, so this is the app's own answer to
    // "is the reader carrying it" rather than a guess from the transform.
    await expect.poll(() => isHeld(sprite)).toBe(true);
    // Well past TAP_SLOP, and UPWARD as well as sideways: a mouse keeps every direction, which is
    // exactly what `touch-action: pan-y` costs a finger.
    for (const step of [1, 2, 3, 4]) {
      await page.mouse.move(from.x + step * 30, from.y - step * 12);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();

    // It is in the air and then it is not: `falling` is neither held nor roaming, and the engine
    // lands it on its own floor.
    await expect.poll(() => isHeld(sprite)).toBe(false);
    await expect
      .poll(async () => sprite.evaluate((node) => getComputedStyle(node as HTMLElement).cursor), {
        timeout: 10_000,
      })
      .toBe("grab");
  });

  test("FEED reaches the mock as exactly ONE edit carrying the ledger line", async ({ page }) => {
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    // The spawn is the one publish that is a `send`; everything after it rewrites that message.
    await setSendControl(page, { clear: true });

    await openPetMenu(page);
    await page.locator('[data-testid="pet-feed"]').click();

    await expect.poll(async () => (await fetchCapturedEdits(page)).length).toBe(1);
    const edit = (await fetchCapturedEdits(page))[0];
    // The wire is READ BACK OUT OF THE WORDS, so what has to survive is the trailing italic block
    // byte for byte — the version, the six-hex game id and the exact ending. A body whose line lost
    // its `, via teams-lite` is a creature every reader loses.
    expect(edit?.content_html).toMatch(
      /<p><em>— pet [0-9a-f]{6} v1 .*, via teams-lite<\/em><\/p>/,
    );
    // And the plain-text twin travels beside it, because an edit carrying only text would have the
    // line ESCAPED and the record gone.
    expect(edit?.text).toMatch(/— pet [0-9a-f]{6} v1 .*, via teams-lite$/);
  });

  test("a PAT is exactly ONE reaction, and pressing again takes it back", async ({ page }) => {
    const rpcs = recordRpcs(page);
    await openPetThread(page, { silent: true });
    const pet = await spawnPet(page);
    // The spawn itself is a `send`, so what this test is about starts after it. The log is SLICED
    // rather than cleared: nothing that already happened is thrown away.
    const before = writes(rpcs()).length;
    expect(writes(rpcs())).toEqual(["send"]);

    await openPetMenu(page, pet);
    const row = page.locator('[data-testid="pet-pat"]');
    await expect(row).toHaveText(/^Pat$/);
    await row.click();
    // A pat is a REACTION and not a ledger act, so it publishes exactly one `react` and no edit at
    // all — which is what makes it the one thing a reader with no creature of their own can do.
    await expect(row).toHaveText(/Take your pat back/);
    expect(writes(rpcs()).slice(before)).toEqual(["react"]);

    await row.click();
    await expect(row).toHaveText(/^Pat$/);
    // TOGGLED, never appended: two presses are two reactions and never a record of anything.
    expect(writes(rpcs()).slice(before)).toEqual(["react", "react"]);
    expect(await fetchCapturedEdits(page)).toHaveLength(0);
  });

  test("a COLLEAGUE'S act changes the reader's creature, with no reload", async ({ page }) => {
    await openPetThread(page);
    const pet = await spawnPet(page);
    // The colleague answers a first spawn by taking a creature of its own, and an act is a line in
    // its AUTHOR's own ledger — so it can do nothing to the reader's pet until it has one.
    await expect(petSprite(page)).toHaveCount(2);

    const trigger = ownPetTrigger(page);
    await expect(trigger).toHaveAttribute("data-pet", pet);
    await expect(trigger).toHaveAttribute("title", /content/);

    // A NAP is the act whose effect is immediate and unambiguous: it puts the creature to sleep for
    // fifteen minutes, so the mood the trigger states changes on the frame the ledger arrives.
    expect((await setPetHook(page, { act: "nap" })).acted).toBe(true);
    await expect(trigger).toHaveAttribute("title", /asleep/);
    // No reload anywhere above: the edited ledger arrived on the live feed and the fold re-read it.
  });

  test("a SECOND creature re-cuts the lanes without teleporting the first, or making it speak", async ({
    page,
  }) => {
    // THE STROLLING RE-LANE, which nothing had ever drawn. Every lane is a share of the arena
    // divided by how many pets are DRAWN, so a second creature narrows the first one's — and a
    // sprite REBUILT for its new lane starts at that lane's left edge, which is a teleport of most
    // of a screen. `setBand` is what makes it a setter instead, and this is the only place that can
    // tell: it needs a mounted canvas and a real animation frame.
    // THE COLLEAGUE IS SILENT FOR THE SPAWN and asked for its own creature deliberately, later. That
    // is not tidiness: a fresh sprite starts at `bounds.min`, i.e. its lane's LEFT EDGE, so a
    // creature that has only just been created is already standing where a rebuild would put it —
    // and a teleport measures as nothing at all. This test was written the other way first, and the
    // mutation that adds the band back to the create effect's deps left it GREEN. So the pet has to
    // be demonstrably AWAY from that edge before anything re-cuts the lanes, and that precondition
    // is asserted rather than assumed.
    await openPetThread(page, { silent: true });
    const pet = await spawnPet(page);
    const mine = petSprite(page, pet);
    // A bubble the engine has not spoken into is `hidden`, and there is one per sprite — so the
    // question is whether ANY of them is showing, not what one of them says.
    const speaking = page.locator(".pet-sprite-bubble:not([hidden])");

    // Let it walk. 0.7 px a frame at idle (`WALK_SPEED`) times the cat's own 1.35 `walkSpeed`, so
    // ~57 px a second — a couple of seconds of pacing puts it well clear of its own left edge.
    await expect.poll(() => spriteX(mine), { timeout: 15_000 }).toBeGreaterThan(80);
    const walked = await spriteX(mine);

    // NOW re-cut the lanes, and watch every frame of it.
    const seen: number[] = [walked];
    await setPetHook(page, { colleague: true });
    for (let sample = 0; sample < 60; sample++) {
      seen.push(await spriteX(mine));
      if ((await petSprite(page).count()) === 2 && sample > 12) break;
      await page.waitForTimeout(30);
    }
    await expect(petSprite(page)).toHaveCount(2);
    seen.push(await spriteX(mine));

    const steps = seen.slice(1).map((x, at) => Math.abs(x - seen[at]!));
    expect(seen.every((x) => Number.isFinite(x))).toBe(true);
    // NOTHING JUMPED. A rebuild shows up here as one sample of eighty-odd pixels, because that is
    // the distance back to `bounds.min`.
    expect(Math.max(...steps)).toBeLessThan(40);
    // AND IT IS STILL WHERE IT WAS WALKING, which is the same fact from the other end: the creature
    // did not end up back at the edge by any route, jump or slide.
    expect(await spriteX(mine)).toBeGreaterThan(60);
    // AND NOTHING SPOKE. The engine speaks on entering a non-idle state, so a rebuilt sprite
    // re-spoke its line — a speech bubble on a creature whose owner did nothing at all. Both
    // bubbles exist in the DOM from the moment their sprite does; neither may be showing.
    await expect(page.locator(".pet-sprite-bubble")).toHaveCount(2);
    await expect(speaking).toHaveCount(0);
  });

  test("the raw ledger line appears NOWHERE on screen", async ({ page }) => {
    await openPetThread(page, { silent: true });
    await spawnPet(page);

    // NOT IN THE HISTORY: a ledger message is absorbed, exactly as a chess one is, so it draws no
    // bubble at all — its words are machinery rewritten on every act.
    await expect(page.locator('[data-testid="message"]', { hasText: "via teams-lite" })).toHaveCount(
      0,
    );
    // NOT IN THE SIDEBAR PREVIEW: the row says the creature's own words and never the wire. This is
    // the surface that took the longest to mend, because a preview is CUT at 120 characters and a
    // strip requiring the complete ending matched nothing on a cut line. The row has to be scrolled
    // to — this fixture's sidebar time is frozen at the foot of the list on purpose.
    const row = await conversationRow(page, PET_THREAD_NAME);
    // The preview really is the pet's message, so this is the row the strip had to mend rather
    // than some older line that never carried a wire.
    await expect(row).toContainText("Cat");
    await expect(row).not.toContainText("via teams-lite");
    await expect(row).not.toContainText("— pet ");

    // AND NOWHERE ELSE AT ALL. `— pet ` — an em dash, the word, a space — is this feature's own
    // marker and nothing else in the app writes it, so the whole document is fair game for it.
    const anywhere = await page.locator("body").innerText();
    expect(anywhere).not.toContain("— pet ");
  });

  test("the layer passes pointers THROUGH: a reaction chip under a creature is still clickable", async ({
    page,
  }) => {
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    // The arena covers the whole history, so everything under it would be unreachable if the box
    // took its own pointer events. Only a pet's canvas and its trigger do.
    await expect(page.locator(layer)).toHaveCSS("pointer-events", "none");

    // PROVED rather than read off a class: the browser is asked what a pointer at that point would
    // really hit, and the answer must be the MESSAGE — not merely "not the overlay", which is also
    // true of a point over nothing.
    //
    // THE POINT HAS TO BE UNDER THE ARENA, and getting that wrong is what this precondition exists
    // for. The seeded fixture's one row sits at y≈116 while the arena starts at y≈120 (its top inset
    // clears the chess strip), so the obvious `.first()` message is ABOVE the overlay entirely and
    // the assertion below was true of nothing at all. It still went red under the
    // `pointer-events-auto` mutation — on the class read above, not on this — which is exactly how a
    // vacuous behavioural assertion hides behind a real one.
    for (let row = 0; row < 6; row++) {
      await emitLive(page, { conversation: PET_THREAD_ID, content: `A line under the arena ${row}.` });
    }
    const message = page.locator('[data-testid="message"]').last();
    await expect(message).toBeVisible();
    const box = await message.boundingBox();
    const arena = await page.locator(layer).boundingBox();
    expect(box).not.toBeNull();
    expect(arena).not.toBeNull();
    const at = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    expect(at.y).toBeGreaterThan(arena!.y);
    expect(at.y).toBeLessThan(arena!.y + arena!.height);
    expect(
      await message.evaluate((node, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit !== null && node.contains(hit);
      }, at),
    ).toBe(true);
  });

  test("exactly ONE conversation sentinel is in the document while a creature is on screen", async ({
    page,
  }) => {
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    await expect(petSprite(page)).toHaveCount(1);

    // The composer states which conversation a keystroke lands in, and a sanctioned live driver
    // proves its target with it (§ Automation safety). Two of them would give that question two
    // answers, so an overlay that mounted a second composer would break the one rail between a
    // script and a colleague's chat.
    const shell = page.locator('[data-testid="composer-shell"]');
    await expect(shell).toHaveCount(1);
    await expect(shell).toHaveAttribute("data-conversation-id", PET_THREAD_ID);
  });

  test("the Settings switch OFF mounts no overlay", async ({ page }) => {
    await openPetThread(page, { silent: true });
    await spawnPet(page);
    await expect(page.locator(layer)).toHaveCount(1);

    await page.locator('[data-testid="open-settings"]').click();
    const section = page.locator('[data-testid="companions-settings"]');
    await expect(section).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await section.getByTestId("companions-toggle").click();
    await expect(section.getByTestId("companions-toggle")).toHaveAttribute("aria-checked", "false");

    // Back to the thread: the creature is still in it — hiding is not despawning — and this browser
    // draws nothing.
    await page.keyboard.press("Escape");
    await openConversationNamed(page, PET_THREAD_NAME);
    await expect(page.locator(layer)).toHaveCount(0);
    await expect(petSprite(page)).toHaveCount(0);
  });

  /**
   * A CREATURE WHOSE LEDGER HAS PAGED OUT IS STILL THE READER'S, AND THEY ARE OFFERED NO SECOND ONE.
   *
   * The whole feature rests on "a pet IS its messages", and the history loads a PAGE at a time — 40,
   * mirrored by the mock. Every act EDITS its author's one ledger, so that message keeps the `seq` it
   * was first posted at: forty messages later, which is a couple of days in a real chat, the record is
   * no longer in the loaded window while the creature is very much alive.
   *
   * What that used to do is the sharpest thing in this file. The fold saw no pet of the reader's own, so
   * nothing was drawn, there was no menu to reach it with, Feed/Play/Nap were replaced by "Feeding and
   * playing take a companion of your own" — and the conversation's own menu OFFERED A SPAWN. That press
   * SENDS: a second arrival message everybody in the thread reads, and a record `petsInThread`'s
   * one-ledger-per-author rule absorbs and ignores WHOLE, so the creature they had just taken vanished
   * and nothing in the feature could ever reach it again.
   *
   * `pet_messages` is the read that closes it (src/store.rs), merged in by `withPetArchive`. THE RELOAD
   * IS THE TEST: it is what makes the app ask for a fresh page, and 45 filler messages after the spawn
   * is what keeps the ledger out of the newest 40.
   */
  test("a ledger that has PAGED OUT still draws its creature, and offers no second one", async ({
    page,
  }) => {
    const rpcs = recordRpcs(page);
    await openPetThread(page, { silent: true });
    const pet = await spawnPet(page);
    // 45, so the newest 40 cannot hold the ledger whatever else the thread gained.
    await fillHistory(page, PET_THREAD_ID, 45);

    // A FRESH LOAD is the test: it is what makes the app ask for a page of history again, and this
    // one cannot contain the ledger. `gotoApp` rather than `page.reload()`, because it waits for the
    // socket and the mock sentinel — a reload alone races the app's own start.
    await gotoApp(page);
    await openConversationNamed(page, PET_THREAD_NAME);

    // THE CREATURE IS STILL DRAWN, which is only possible from the archive: its ledger is not in the
    // page the app just loaded.
    await expect(petSprite(page, pet)).toHaveCount(1);
    // And the read really is where it came from — asserted on the socket, because a page that drew the
    // pet for any other reason would pass the line above.
    expect(rpcs()).toContain("pet_messages");

    // AND NO SPAWN IS OFFERED, which is the half that used to post the duplicate.
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="pet-spawn"]')).toHaveCount(0);
    await closeConversationMenu(page);

    // The creature's own menu offers the three acts too, because the reader's record was found: this is
    // the same answer read from the other side, and it was "Feeding and playing take a companion of
    // your own" for a reader who plainly had one.
    await openPetMenu(page, pet);
    await expect(page.locator('[data-testid="pet-feed"]')).toBeVisible();
    await expect(page.locator('[data-testid="pet-no-pet-note"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("prefers-reduced-motion draws nothing, and offers no creature to take", async ({ page }) => {
    await openPetThread(page, { silent: true });

    /**
     * THE SPAWN ROW IS ASSERTED WITH NO PET IN THE THREAD, IN BOTH DIRECTIONS, AND THAT ORDER IS THE
     * WHOLE POINT.
     *
     * `petSpawnIsOffered` has four refusals and `mine && !mine.gone` is one of them, so a check made
     * after a spawn passes whatever the reduce flag says — the row is correctly absent because the
     * reader already HAS a creature. Asserted that way this test passed with the gate deleted, which
     * is how `conversation-menu.tsx` came to read motion/react's mount-only `useReducedMotion` while
     * the layer read the live `usePrefersReducedMotion`: two answers to "would a creature be drawn?",
     * and a spawn posts a message everybody in the thread sees. Here reduce is the ONLY refusal in
     * play, so the row's absence and its RETURN are both about the flag alone.
     */
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="pet-spawn"]')).toHaveCount(0);
    await closeConversationMenu(page);

    // And BACK, with no reload — the direction the reader was stranded by, and the one a mount-only
    // hook cannot answer at all: the row returns, so there is an in-app path to a companion again.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="pet-spawn"]')).toHaveCount(1);
    await closeConversationMenu(page);

    await spawnPet(page);
    await expect(page.locator(layer)).toHaveCount(1);

    // LIVE, with NO RELOAD, and that is the assertion rather than a convenience. It used to reload,
    // because `useReducedMotion` (motion/react) reads the query ONCE into a `useState` initialiser
    // it never updates — its own source carries `TODO See if people miss automatically updating
    // shouldReduceMotion setting` under a docstring claiming it responds actively. That was worse
    // than a stale flag here, because this gate takes the whole feature away: under reduced motion
    // nothing is drawn AND the spawn row is not offered, so a reader who turned Reduce Motion OFF
    // had no in-app path to a companion at all until they reloaded, with nothing saying why. The
    // layer reads `usePrefersReducedMotion` (lib/platform.ts) now, which subscribes the way
    // `useCoarsePointer` does — so flipping the query is what this test does, and going back to the
    // mount-only hook fails it.
    await page.emulateMedia({ reducedMotion: "reduce" });

    // AN ANIMATED CREATURE HELD STILL IS NOT A STILL CREATURE — it is a broken one — so the whole
    // layer goes rather than a frozen sprite. `.agent-shine`'s own precedent. The creature is still
    // in the thread; this browser draws none of it.
    await expect(page.locator(layer)).toHaveCount(0);
    await expect(petSprite(page)).toHaveCount(0);
    // And the conversation's menu offers none either — which HERE is the pet's own record refusing it
    // as well, and is why the flag's own two directions are asserted above with no creature in the
    // thread at all. A spawn nobody can see would post a message its own presser never meets.
    await openConversationMenu(page);
    await expect(page.locator('[data-testid="pet-spawn"]')).toHaveCount(0);
    await closeConversationMenu(page);

    // AND BACK: turning Reduce Motion off returns the creature with no reload.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator(layer)).toHaveCount(1);
    await expect(petSprite(page)).toHaveCount(1);
  });

  // ---- the two GESTURES, with a finger ---------------------------------------
  //
  // A coarse pointer is not a narrow viewport: what these two are about is what a TOUCH does, and
  // the engine's whole `touch-action: pan-y` argument only exists for one.
  test.describe("with a finger", () => {
    // A PHONE, minus the one field a whole spread carries that cannot live in a describe
    // (`defaultBrowserType`, which forces a new worker). What matters here is the three that
    // decide the layout and the pointer.
    test.use({ viewport: devices["Pixel 7"].viewport, hasTouch: true, isMobile: true });

    /**
     * A real touch drag, through the browser's own input pipeline.
     *
     * It has to be CDP and not a dispatched event: the question is whether CHROMIUM claims a
     * vertical gesture that starts on a pet, and a synthetic `pointermove` proves nothing about
     * that — it never reaches the compositor, so no scroll is ever recognised and no
     * `pointercancel` is ever fired. Driving the real pipeline is the only thing that can answer it,
     * which is why this half of the rail is here rather than in a unit test.
     */
    async function touchDrag(
      page: Page,
      from: { x: number; y: number },
      to: { x: number; y: number },
    ): Promise<void> {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: from.x, y: from.y }],
      });
      const steps = 10;
      for (let step = 1; step <= steps; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: from.x + ((to.x - from.x) * step) / steps,
              y: from.y + ((to.y - from.y) * step) / steps,
            },
          ],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    }

    /** The middle of a creature, in viewport pixels. */
    async function spriteCentre(sprite: Locator): Promise<{ x: number; y: number }> {
      const box = await sprite.boundingBox();
      expect(box).not.toBeNull();
      return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    }

    /**
     * A thread longer than a screen, scrolled to its end, with a creature in it.
     *
     * Both touch-scroll tests need exactly this, and they need it stated once: the seeded fixture is
     * ONE message and a pet's ledger draws NO row, so the scroller cannot move at all until the
     * conversation is longer than a screen — which is the ordinary state the rail exists for.
     */
    async function readyToScroll(page: Page): Promise<{ top: number; scrollable: number }> {
      await fillHistory(page, PET_THREAD_ID);
      await page.locator(scroller).evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(300);
      return page.locator(scroller).evaluate((node) => ({
        top: node.scrollTop,
        scrollable: node.scrollHeight - node.clientHeight,
      }));
    }

    test("A TOUCH SCROLL THAT STARTS ON A CREATURE PUBLISHES NOTHING, and lets go of it", async ({
      page,
    }) => {
      // THE SHARPEST ASSERTION IN THIS FILE. `onThrow` publishes a `play` act — an edit to a real
      // Teams message — and a scroll is not a press the reader aimed at a pet. The engine's rail is
      // that a CANCELLED gesture fires neither callback; its two siblings (no `onThrow` for a
      // cancel, none for a pointer that is not the one that grabbed) are pinned by a source scan in
      // desksprite.test.ts, which cannot prove a browser fires `pointercancel` for a vertical flick.
      // That half is this test's, and it is the reason it drives CDP.
      const rpcs = recordRpcs(page);
      await openPetThread(page, { silent: true });
      await spawnPet(page);
      const before = writes(rpcs()).length;
      const sprite = petSprite(page).first();
      await readyToScroll(page);

      const centre = await spriteCentre(sprite);
      // 220 px is twenty-two times TAP_SLOP, so a RELEASE of this gesture would be an unambiguous
      // throw — which is what makes the emptiness below proof that Chromium CANCELLED the pointer
      // rather than delivering it. A release inside the slop would have shown up as a `react`, and a
      // release outside it as an `edit`; neither is here.
      await touchDrag(page, centre, { x: centre.x, y: centre.y + 220 });
      await page.waitForTimeout(600);

      // NOTHING was published. Counted on the socket, because a page that posted an act and drew no
      // change in the creature would pass any assertion about the pet.
      expect(writes(rpcs()).slice(before)).toEqual([]);
      // And the creature is not left stuck to a finger that has gone.
      await expect.poll(() => isHeld(sprite)).toBe(false);
    });

    test("but THE HISTORY DOES NOT MOVE under that flick — a DEFECT this pins rather than blesses", async ({
      page,
    }) => {
      // MEASURED, and it is the other half of the sentence the test above proves. `touch-action:
      // pan-y` on the canvas was chosen with this argument, in the engine's own words: "a reader
      // flicks up, their thumb lands on a pet that has wandered under it, and the history does not
      // move. With `pan-y` the browser takes the vertical gesture and fires `pointercancel`." The
      // second half is TRUE — nothing publishes, the pet is dropped — and the FIRST half is not:
      // Chromium takes the gesture and then has nothing to pan, because `pet-layer` is a SIBLING of
      // `message-scroll` (message-pane.tsx) rather than a descendant, so the canvas has no
      // scrollable ancestor at all. The flick is swallowed.
      //
      // Measured on a Pixel 7 with one creature: the same 200 px flick moves the history 185 px from
      // the message area and 0 px from the sprite — and 0 px from the pet's own 44 px trigger pill
      // too, which is the same root cause on a second target. So the dead zone is a 52 px creature
      // that WALKS, plus a fixed pill, in the bottom band of the arena where a thumb starts a flick.
      //
      // It is asserted as it IS rather than as it should be, because a red suite is not a report —
      // and the CONTROL flick is what makes that honest: without it, "the scroller did not move"
      // would pass just as well if the touch driver did nothing at all, which is this feature's own
      // defect class (an assertion satisfied by something other than the thing it names). WHOEVER
      // MENDS THIS: this test will fail, and that failure is the fix landing. Delete it and fold its
      // scroll assertion back into the test above.
      await openPetThread(page, { silent: true });
      await spawnPet(page);
      const sprite = petSprite(page).first();
      const scrolled = page.locator(scroller);

      // THE CONTROL: the identical gesture on the history itself, which really does scroll.
      const plain = await readyToScroll(page);
      expect(plain.scrollable).toBeGreaterThan(200);
      const paneBox = await scrolled.boundingBox();
      expect(paneBox).not.toBeNull();
      await touchDrag(
        page,
        { x: paneBox!.x + paneBox!.width / 2, y: paneBox!.y + paneBox!.height * 0.35 },
        { x: paneBox!.x + paneBox!.width / 2, y: paneBox!.y + paneBox!.height * 0.35 + 200 },
      );
      await page.waitForTimeout(500);
      expect(await scrolled.evaluate((node) => node.scrollTop)).toBeLessThan(plain.top - 100);

      // AND THE SAME GESTURE ON THE CREATURE, which does not.
      const onPet = await readyToScroll(page);
      const centre = await spriteCentre(sprite);
      await touchDrag(page, centre, { x: centre.x, y: centre.y + 200 });
      await page.waitForTimeout(500);
      expect(await scrolled.evaluate((node) => node.scrollTop)).toBe(onPet.top);
    });

    test("a TAP pats the creature and publishes NO act; a real THROW plays with it", async ({
      page,
    }) => {
      // TAP_SLOP, which nothing had ever drawn. Without a distance the two gestures were ONE, so a
      // press aimed at whatever a creature had wandered over published an act that cost it energy
      // and stayed in its record for good. The two are deliberately asymmetric: over-reading a
      // throw as a tap costs a reaction that toggles, and the other way costs an irreversible
      // append.
      const rpcs = recordRpcs(page);
      await openPetThread(page, { silent: true });
      await spawnPet(page);
      const before = writes(rpcs()).length;
      const sprite = petSprite(page).first();

      // A TAP: pressed and let go with the finger still inside TAP_SLOP of where it landed.
      const centre = await spriteCentre(sprite);
      await touchDrag(page, centre, { x: centre.x + Math.floor(TAP_SLOP / 3), y: centre.y });
      await expect.poll(() => writes(rpcs()).slice(before).length, { timeout: 10_000 }).toBe(1);
      // A REACTION and nothing else: no edit, so nothing was appended to the creature's record.
      expect(writes(rpcs()).slice(before)).toEqual(["react"]);
      expect(await fetchCapturedEdits(page)).toHaveLength(0);

      // AND THE RESIDUAL, asserted rather than wished away: the canvas takes `pointer-events: auto`
      // and claims `pointerdown`, so a tap the reader aimed at a bubble the creature had wandered
      // over reaches the PET and pats it. That is the trade this split made — a reaction the next
      // press takes back, in place of an edit that cost energy for ever — and it is not a bug that
      // was fixed. The `react` above IS that press when the pet is standing on a message.

      // A THROW: the same gesture carried well past TAP_SLOP, sideways because `pan-y` gives the
      // vertical axis to the scroller.
      await expect.poll(() => isHeld(sprite)).toBe(false);
      const from = await spriteCentre(sprite);
      await touchDrag(page, from, { x: from.x + 8 * TAP_SLOP, y: from.y });
      // ONE edit, which is the `play` act — the reader carried it somewhere and let go.
      await expect.poll(async () => (await fetchCapturedEdits(page)).length, { timeout: 10_000 }).toBe(1);
      expect((await fetchCapturedEdits(page))[0]?.text).toMatch(/— pet [0-9a-f]{6} v1 /);
    });
  });
});

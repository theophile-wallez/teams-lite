// Diagnostic: measure how smoothly the message history scrolls upward.
//
// Drives the app through `withPreview` (the sanctioned mock-backed driver — see
// scripts/preview.ts), wheels the history up at a steady rate, and samples the
// scroller once per frame.
//
//   cd web && bun run scripts/scroll-probe.ts
//   MOCK_BACKLOG=600 bun run scripts/scroll-probe.ts --steps 120 --interval 100
//
// The interesting number is not `scrollTop` but where a given message *sits on
// screen* from frame to frame: that is what an eye follows. Wheeling up by a
// constant delta should move it down by that same delta every frame, so any
// other movement is a visible twitch. Each frame therefore records the message
// nearest the viewport centre and its screen position, and the report scores the
// frame-to-frame movement of that same message against what the wheel asked for.
//
// Every programmatic scroll the virtualizer performs is logged too (the probe
// patches `scrollTo` on the scroller, recording the live `scrollTop` and the
// value written), so a twitch can be attributed instead of guessed at.

import { withPreview, openFirstConversation } from "./preview";

/** One wheel notch, and how far it should move the content. */
const STEP_PX = 90;

/** A programmatic scroll: where the element actually was, and what was written. */
type Fix = { live: number; want: number };
type Frame = {
  t: number;
  top: number;
  height: number;
  loaded: number;
  /** Anchor message nearest the viewport centre, and its screen y. */
  anchor: string | null;
  anchorY: number;
  fixes: Fix[];
};

const INSTRUMENT = `(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  if (!el) throw new Error("no message scroller");
  const probe = { frames: [], pending: [], notches: [] };
  window.__scrollProbe = probe;
  const nativeScrollTo = el.scrollTo.bind(el);
  el.scrollTo = (arg) => {
    const to = typeof arg === "object" && arg !== null ? arg.top : arg;
    probe.pending.push({ live: Math.round(el.scrollTop), want: Math.round(to ?? 0) });
    return nativeScrollTo(arg);
  };
  const anchorNode = () => {
    const box = el.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const node of el.querySelectorAll("[data-message-id]")) {
      const rect = node.getBoundingClientRect();
      const distance = Math.abs(rect.top - middle);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { id: node.dataset.messageId, y: Math.round(rect.top) };
      }
    }
    return best;
  };
  const tick = () => {
    const anchor = anchorNode();
    probe.frames.push({
      t: Math.round(performance.now()),
      top: Math.round(el.scrollTop),
      height: Math.round(el.scrollHeight),
      loaded: Number(el.dataset.loadedCount ?? 0),
      anchor: anchor ? anchor.id : null,
      anchorY: anchor ? anchor.y : 0,
      fixes: probe.pending.splice(0),
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/** A wheel notch keeps moving the content for about this long (Chromium animates
 *  wheel scrolling), so frames in that window are "driven" and expected to move. */
const NOTCH_SETTLE_MS = 80;

const flag = (name: string, fallback: number): number =>
  Number(process.argv[process.argv.indexOf(name) + 1]) || fallback;

await withPreview(async ({ page }) => {
  const steps = flag("--steps", 90);
  const interval = flag("--interval", 16);
  await openFirstConversation(page);
  await page.waitForTimeout(1500);

  await page.evaluate(INSTRUMENT);
  // Put the cursor over the history so wheel events land on the scroller.
  await page.mouse.move(600, 450);
  for (let i = 0; i < steps; i++) {
    await page.evaluate(`window.__scrollProbe.notches.push(Math.round(performance.now()))`);
    await page.mouse.wheel(0, -STEP_PX);
    await page.waitForTimeout(interval);
  }
  await page.waitForTimeout(600);

  const frames = (await page.evaluate(`window.__scrollProbe.frames`)) as Frame[];
  const notches = (await page.evaluate(`window.__scrollProbe.notches`)) as number[];

  console.log(`\nwheel: ${steps} notches of ${STEP_PX}px, one every ${interval}ms`);
  report(frames, notches);
});

function report(frames: Frame[], notches: number[]): void {
  // Frame-to-frame movement of the *same* message on screen — what an eye
  // following that message actually sees. Frames that don't share an anchor with
  // their predecessor can't be compared (the anchor changes as rows pass the
  // centre, which is expected, not a twitch).
  const driven = (t: number) => notches.some((n) => t >= n - 16 && t <= n + NOTCH_SETTLE_MS);
  const tracked: Array<{ index: number; frame: Frame; moved: number; driven: boolean }> = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!;
    const frame = frames[i]!;
    if (frame.anchor === null || frame.anchor !== prev.anchor) continue;
    tracked.push({
      index: i,
      frame,
      moved: frame.anchorY - prev.anchorY,
      driven: driven(frame.t),
    });
  }

  // Idle frames: the wheel asked for nothing, so the content must not move.
  const idle = tracked.filter((f) => !f.driven);
  const twitches = idle.filter((f) => Math.abs(f.moved) > 2);
  const worst = [...twitches].sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved));
  // Driven frames should move by one notch; anything well past that is a lurch.
  const lurches = tracked.filter((f) => f.driven && Math.abs(f.moved) > STEP_PX * 1.5);
  const fixes = frames.flatMap((f) => f.fixes);

  console.log(`\n=== scroll probe ===`);
  console.log(`frames sampled          : ${frames.length}`);
  console.log(`scrollTop               : ${frames[0]?.top} -> ${frames[frames.length - 1]?.top}`);
  console.log(`history loaded          : ${frames[0]?.loaded} -> ${frames[frames.length - 1]?.loaded}`);
  console.log(`comparable / idle frames: ${tracked.length} / ${idle.length}`);
  console.log(
    `twitches (idle movement): ${twitches.length}` +
      ` (${idle.length ? Math.round((100 * twitches.length) / idle.length) : 0}% of idle frames)`,
  );
  console.log(`worst twitch            : ${worst[0] ? sign(worst[0].moved) : "0px"}`);
  console.log(`lurches (>1.5 notches)  : ${lurches.length}`);
  console.log(`total idle movement     : ${Math.round(idle.reduce((n, f) => n + Math.abs(f.moved), 0))}px`);
  console.log(`programmatic scrolls    : ${fixes.length}`);

  if (worst.length > 0) {
    console.log(`\nlargest twitches (content moved while the wheel was idle):`);
    for (const f of worst.slice(0, 15)) {
      console.log(
        `  #${f.index} t=${f.frame.t} anchor moved ${sign(f.moved)}` +
          ` | top=${f.frame.top} height=${f.frame.height} loaded=${f.frame.loaded}` +
          ` writes=[${f.frame.fixes.map((x) => `${sign(x.want - x.live)}`).join(" ")}]` +
          ` prevWrites=[${(frames[f.index - 1]?.fixes ?? []).map((x) => sign(x.want - x.live)).join(" ")}]`,
      );
    }
  }
}

function sign(n: number): string {
  return `${n > 0 ? "+" : ""}${Math.round(n)}px`;
}

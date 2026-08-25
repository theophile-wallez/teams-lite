/**
 * Does a BROWSER really decode chess.com's board sounds, over this app's own route?
 *
 * Everything else about that chain is measured somewhere a test can reach: the backend fetching the
 * eleven files and verifying them against pinned digests
 * (`chess_sound::tests::the_real_sounds_download_and_verify`), the route refusing anything but a
 * pinned name (`web/chess-sound-file.test.ts`), and the page never asking chess.com for them
 * (`web/e2e/chess.spec.ts`). The one link none of those can cover is the LAST one — `fetch` over the
 * app's own origin into `AudioContext.decodeAudioData` — because the recordings are chess.com's and
 * are therefore not in this repository, so the suite deliberately runs with an EMPTY sound directory
 * and every spec exercises the synthesized fallback instead.
 *
 * This is that check, and it is the shape `scroll-probe.ts` already has: a tracked script that drives
 * the app THROUGH `withPreview` rather than around it, so the mock sentinel is asserted before
 * anything happens and nothing can reach a real account. It types nothing and sends nothing.
 *
 * It needs the real recordings on this machine, which nothing here will fetch for you — the app does
 * that, once, on the first board. Point it at them:
 *
 *   cd web && TEAMS_LITE_CHESS_SOUND_DIR=~/.cache/teams-lite/chess-sounds/<version> \
 *     bun run scripts/chess-sound-probe.ts
 *
 * It prints counts, byte lengths and durations — never audio, and never a path.
 */

import { CHESS_SOUNDS_SERVED, CHESS_SOUND_ROUTE, CHESS_SOUND_VERSION } from "../chess-sound-file";
import { withPreview } from "./preview";

const ROUTE = `${CHESS_SOUND_ROUTE}${CHESS_SOUND_VERSION}/`;

type Decoded = {
  name: string;
  status: number;
  bytes: number;
  /** Seconds, as the browser's own decoder measured them. */
  duration: number;
  channels: number;
  sampleRate: number;
  error: string;
};

async function main(): Promise<void> {
  if (!process.env.TEAMS_LITE_CHESS_SOUND_DIR) {
    console.error(
      "TEAMS_LITE_CHESS_SOUND_DIR is not set, so the route would answer 404 for every file and\n" +
        "this probe would measure the fallback rather than the recordings. Point it at a directory\n" +
        "holding them — the app fetches them into ~/.cache/teams-lite/chess-sounds/<version>/ the\n" +
        "first time a board is opened.",
    );
    process.exitCode = 2;
    return;
  }

  await withPreview(async ({ page }) => {
    // Every request the page makes, so this also re-proves the rule the E2E spec pins: nothing about
    // a board ever reaches chess.com.
    const offMachine: string[] = [];
    page.on("request", (request) => {
      if (/chesscomfiles\.com|chess\.com/.test(request.url())) offMachine.push(request.url());
    });

    // Decode through the very module the app plays with — imported by its own dev-server path, so it
    // is the same module instance rather than a copy of the logic.
    //
    // The body below runs in the BROWSER while this file is typechecked under the Node config, which
    // has no DOM: `AudioContext` and that module path are therefore reached through `globalThis` and
    // a variable specifier. Narrow local shapes rather than `any`, so a typo is still caught.
    const results = (await page.evaluate(async (route: string) => {
      type Buf = { duration: number; numberOfChannels: number; sampleRate: number };
      type Ctx = { decodeAudioData: (bytes: ArrayBuffer) => Promise<Buf> };
      type SoundModule = {
        chessSoundFileNames: () => string[];
        primeChessSounds: (route: string) => void;
        chessSoundIsRecorded: (name: string) => boolean;
      };
      const globals = globalThis as unknown as {
        AudioContext: new () => Ctx;
        fetch: (url: string) => Promise<{ status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
        setTimeout: (fn: () => void, ms: number) => void;
      };
      const ctx = new globals.AudioContext();
      const path = "/src/lib/chess-sound.ts";
      const module = (await import(/* @vite-ignore */ path)) as SoundModule;
      const out: Decoded[] = [];
      for (const name of module.chessSoundFileNames()) {
        const entry: Decoded = {
          name,
          status: 0,
          bytes: 0,
          duration: 0,
          channels: 0,
          sampleRate: 0,
          error: "",
        };
        try {
          const response = await globals.fetch(`${route}${name}.mp3`);
          entry.status = response.status;
          const raw = await response.arrayBuffer();
          entry.bytes = raw.byteLength;
          const buffer = await ctx.decodeAudioData(raw);
          entry.duration = Math.round(buffer.duration * 1000) / 1000;
          entry.channels = buffer.numberOfChannels;
          entry.sampleRate = buffer.sampleRate;
        } catch (e) {
          entry.error = e instanceof Error ? e.message : String(e);
        }
        out.push(entry);
      }
      // And the module's own view of it, which is what `playChessSound` reads to choose a recording
      // over synthesis.
      module.primeChessSounds(route);
      await new Promise<void>((resolve) => globals.setTimeout(resolve, 1500));
      const recorded = [
        "move",
        "moveOpponent",
        "capture",
        "castle",
        "check",
        "promote",
        "start",
        "win",
        "lose",
        "draw",
        "premove",
        "lowTime",
        "notify",
      ].filter((n) => module.chessSoundIsRecorded(n));
      return { out, recorded };
    }, ROUTE)) as { out: Decoded[]; recorded: string[] };

    let ok = 0;
    for (const entry of results.out) {
      if (entry.error || entry.status !== 200) {
        console.log(`  ✗ ${entry.name.padEnd(14)} status ${entry.status} ${entry.error}`);
        continue;
      }
      ok += 1;
      console.log(
        `  ✓ ${entry.name.padEnd(14)} ${String(entry.bytes).padStart(6)} bytes  ` +
          `${entry.duration.toFixed(3)}s  ${entry.channels}ch @ ${entry.sampleRate}Hz`,
      );
    }
    console.log(
      `\n${ok}/${CHESS_SOUNDS_SERVED.length} decoded by the browser over ${CHESS_SOUND_ROUTE}`,
    );
    console.log(
      `${results.recorded.length}/14 sounds would play as a RECORDING: ${results.recorded.join(", ")}`,
    );
    console.log(
      offMachine.length === 0
        ? "0 requests reached chess.com — the bytes came from this app's own origin."
        : `!! ${offMachine.length} requests reached chess.com: ${offMachine.join(", ")}`,
    );
    if (ok !== CHESS_SOUNDS_SERVED.length || offMachine.length > 0) process.exitCode = 1;
  });
}

await main();

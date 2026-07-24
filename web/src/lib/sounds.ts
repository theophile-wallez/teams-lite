// teams-lite web — interaction sounds (cuelume).
//
// Curated, synthesized Web-Audio interaction cues. Split in two, mirroring
// lib/appearance.ts:
//
//   • a PURE preference layer (key / default / coerce) with no DOM, storage, or
//     audio, so the on/off setting is trivially testable; and
//   • a thin, CLIENT-ONLY bridge to the `cuelume` engine that loads it lazily.
//     Web Audio is browser-only, so keeping the import behind a dynamic
//     `import()` guarded by `typeof window` keeps the engine off the SSR path
//     and out of the critical bundle (same trick the composer uses for TipTap).
//
// The controller (lib/store.ts) owns the side effects and persistence; React
// components just read `soundsEnabled` and call controller methods.

// Type-only import — erased at build time, so it never pulls the engine into the
// SSR module graph.
import type { SoundName } from "cuelume";

export type { SoundName };

/** Persisted preference key. Client-only, like the theme and channel favorites —
 *  sound is a per-device UX choice, not backend state. */
export const SOUNDS_STORAGE_KEY = "teams-lite:sounds";

/** Sounds are ON out of the box; the Settings toggle is the off switch. */
export const DEFAULT_SOUNDS_ENABLED = true;

/** Coerce an unknown stored value to a boolean. We persist "1"/"0"; older or
 *  hand-edited values ("true"/"false") are honored too, and anything else falls
 *  back to the default so a junk entry never silences (or unmutes) unexpectedly. */
export function coerceSoundsEnabled(value: unknown): boolean {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return DEFAULT_SOUNDS_ENABLED;
}

// ---- client-only cuelume bridge ------------------------------------------
//
// One shared lazy import: the first cue/bind/enable call loads the engine, and
// every later call chains off the same promise so state (the enabled flag) and
// calls stay ordered. Each wrapper is a no-op during SSR.

let modulePromise: Promise<typeof import("cuelume")> | null = null;

function engine(): Promise<typeof import("cuelume")> | null {
  if (typeof window === "undefined") return null;
  if (!modulePromise) modulePromise = import("cuelume");
  return modulePromise;
}

/** Enable or disable ALL playback. cuelume keeps a single module-level flag that
 *  both `play()` and the `bind()`-delegated cues respect, so this is the one
 *  lever the Settings toggle needs. */
export function setCuesEnabled(enabled: boolean): void {
  void engine()?.then((m) => m.setEnabled(enabled));
}

/** Play a curated cue by name. A no-op when sounds are disabled, during SSR, on
 *  browsers without Web Audio, or before the first user gesture — the engine
 *  guards all of those itself. */
export function playCue(sound: SoundName): void {
  void engine()?.then((m) => m.play(sound));
}

/** Delegate every `data-cuelume-*` interaction under the document once, so the
 *  button press / hover / toggle cues work app-wide. Idempotent in the engine,
 *  and gated by the same enabled flag as `playCue`. */
export function bindCues(): void {
  void engine()?.then((m) => m.bind());
}

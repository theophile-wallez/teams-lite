import { describe, it, expect } from "vitest";
import {
  DEFAULT_SOUNDS_ENABLED,
  SOUNDS_STORAGE_KEY,
  coerceSoundsEnabled,
} from "./sounds";

// Only the pure preference layer is exercised here — the cuelume bridge is
// client-only (lazy `import()` behind a `typeof window` guard) and side-effect
// free until a cue is actually played, so importing this module in tests never
// touches Web Audio.

describe("coerceSoundsEnabled", () => {
  it("reads the persisted on/off form we write", () => {
    expect(coerceSoundsEnabled("1")).toBe(true);
    expect(coerceSoundsEnabled("0")).toBe(false);
  });

  it("also honors boolean-ish legacy/hand-edited values", () => {
    expect(coerceSoundsEnabled("true")).toBe(true);
    expect(coerceSoundsEnabled("false")).toBe(false);
  });

  it("falls back to the default for missing or junk values", () => {
    expect(coerceSoundsEnabled(null)).toBe(DEFAULT_SOUNDS_ENABLED);
    expect(coerceSoundsEnabled(undefined)).toBe(DEFAULT_SOUNDS_ENABLED);
    expect(coerceSoundsEnabled("")).toBe(DEFAULT_SOUNDS_ENABLED);
    expect(coerceSoundsEnabled("yes")).toBe(DEFAULT_SOUNDS_ENABLED);
    expect(coerceSoundsEnabled(2)).toBe(DEFAULT_SOUNDS_ENABLED);
  });
});

describe("defaults", () => {
  it("ships with sounds on so the feature is discoverable out of the box", () => {
    expect(DEFAULT_SOUNDS_ENABLED).toBe(true);
  });

  it("uses a namespaced, client-only storage key", () => {
    expect(SOUNDS_STORAGE_KEY).toBe("teams-lite:sounds");
  });
});

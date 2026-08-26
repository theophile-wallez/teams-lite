import { describe, it, expect } from "vitest";
import {
  DEFAULT_PETS_SHOWN,
  PETS_SHOWN_STORAGE_KEY,
  coercePetsShown,
  petsShownValue,
} from "./pet-visibility";

// The pure half only. That the CONTROLLER really writes through `petsShownValue` — and that
// the preference therefore survives a real reload — is `e2e/companions.spec.ts`, which
// reloads the page; the switch's effect on the overlay is Task 9's.

describe("the round trip", () => {
  it("reads back what it writes, both ways", () => {
    // Through BOTH halves rather than against the literals "1"/"0": a test that restated the
    // write format would keep passing if the writer changed to "yes"/"no", while every reload
    // silently reset the preference to the default.
    expect(coercePetsShown(petsShownValue(true))).toBe(true);
    expect(coercePetsShown(petsShownValue(false))).toBe(false);
  });

  it("writes one of two short values and nothing else", () => {
    expect(petsShownValue(true)).toBe("1");
    expect(petsShownValue(false)).toBe("0");
  });
});

describe("coercePetsShown", () => {
  it("honours a value edited by hand", () => {
    expect(coercePetsShown("true")).toBe(true);
    expect(coercePetsShown("false")).toBe(false);
  });

  it("falls back to the default for a missing or junk value", () => {
    expect(coercePetsShown(null)).toBe(DEFAULT_PETS_SHOWN);
    expect(coercePetsShown(undefined)).toBe(DEFAULT_PETS_SHOWN);
    expect(coercePetsShown("")).toBe(DEFAULT_PETS_SHOWN);
    expect(coercePetsShown("yes")).toBe(DEFAULT_PETS_SHOWN);
    expect(coercePetsShown(0)).toBe(DEFAULT_PETS_SHOWN);
  });
});

describe("the default", () => {
  it("draws the companions in a fresh browser", () => {
    expect(DEFAULT_PETS_SHOWN).toBe(true);
  });

  it("is persisted under a namespaced client-only key", () => {
    expect(PETS_SHOWN_STORAGE_KEY).toBe("teams-lite:pets-shown");
  });
});

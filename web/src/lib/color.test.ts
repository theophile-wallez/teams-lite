// Behavior tests for the browser-safe color primitives that back the theme engine.
import { describe, it, expect } from "vitest";
import { fromHex, fromInts, mix, toCss, luminance, WHITE, BLACK } from "./color";

describe("fromHex", () => {
  it("expands #rgb shorthand", () => {
    expect(fromHex("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });

  it("parses #rrggbb as fully opaque", () => {
    expect(fromHex("#2b5278")).toEqual({ r: 43, g: 82, b: 120, a: 1 });
  });

  it("parses the alpha byte of #rrggbbaa", () => {
    const c = fromHex("#2b527880");
    expect({ r: c.r, g: c.g, b: c.b }).toEqual({ r: 43, g: 82, b: 120 });
    expect(c.a).toBeCloseTo(128 / 255, 5);
  });
});

describe("mix", () => {
  it("takes the rounded midpoint of two colors", () => {
    const a = fromInts(0, 0, 0);
    const b = fromInts(10, 20, 31);
    expect(mix(a, b, 0.5)).toEqual({ r: 5, g: 10, b: 16, a: 1 });
  });

  it("interpolates alpha linearly", () => {
    const transparent = fromInts(0, 0, 0, 0);
    const opaque = fromInts(0, 0, 0, 255);
    expect(mix(transparent, opaque, 0.5).a).toBeCloseTo(0.5, 5);
  });
});

describe("toCss", () => {
  it("emits space-separated rgb() for opaque colors", () => {
    expect(toCss(fromInts(43, 82, 120))).toBe("rgb(43 82 120)");
  });

  it("emits transparent for zero alpha", () => {
    expect(toCss(fromInts(10, 20, 30, 0))).toBe("transparent");
  });

  it("emits rgb() with a slash alpha for partial transparency", () => {
    expect(toCss(fromInts(0, 0, 0, 128))).toBe(`rgb(0 0 0 / ${(128 / 255).toFixed(3)})`);
  });
});

describe("luminance", () => {
  it("orders white above black, with mid-grays in between", () => {
    expect(luminance(WHITE)).toBe(1);
    expect(luminance(BLACK)).toBe(0);
    expect(luminance(WHITE)).toBeGreaterThan(luminance(fromInts(128, 128, 128)));
    expect(luminance(fromInts(128, 128, 128))).toBeGreaterThan(luminance(BLACK));
  });

  it("weights green above red above blue", () => {
    expect(luminance(fromInts(0, 255, 0))).toBeGreaterThan(luminance(fromInts(255, 0, 0)));
    expect(luminance(fromInts(255, 0, 0))).toBeGreaterThan(luminance(fromInts(0, 0, 255)));
  });
});

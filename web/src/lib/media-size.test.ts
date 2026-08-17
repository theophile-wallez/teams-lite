import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MAX_DRAWN_PICTURE_HEIGHT, drawnPictureBox } from "./media-size";

describe("drawnPictureBox", () => {
  it("leaves a picture that fits the ceiling exactly as it was stated", () => {
    expect(drawnPictureBox(777, 312)).toEqual({ width: 777, height: 312 });
    expect(drawnPictureBox(400, MAX_DRAWN_PICTURE_HEIGHT)).toEqual({
      width: 400,
      height: MAX_DRAWN_PICTURE_HEIGHT,
    });
  });

  it("brings a tall picture's WIDTH down with its height, keeping the shape", () => {
    const box = drawnPictureBox(640, 1000)!;
    expect(box.height).toBe(MAX_DRAWN_PICTURE_HEIGHT);
    expect(box.width).toBe(204);
    // The whole point: the box is the picture's own shape, so nothing is left over beside it.
    expect(box.width / box.height).toBeCloseTo(640 / 1000, 2);
  });

  it("never rounds the width UP, which would put the height over the ceiling", () => {
    // 3 / 4 of 320 is 240 exactly; 999 / 1000 of it is 319.68, and a width rounded up from it
    // asks for a height of 320.3 — which `max-height` clamps, and the leftover room is back.
    expect(drawnPictureBox(999, 1000)).toEqual({ width: 319, height: MAX_DRAWN_PICTURE_HEIGHT });
    expect(drawnPictureBox(3000, 4000)).toEqual({ width: 240, height: MAX_DRAWN_PICTURE_HEIGHT });
  });

  it("keeps a picture out of a box of no width at all", () => {
    expect(drawnPictureBox(400, 100_000)).toEqual({ width: 1, height: MAX_DRAWN_PICTURE_HEIGHT });
  });

  it("answers nothing without the PAIR, because a ceiling reaches a width through a ratio", () => {
    expect(drawnPictureBox(640, undefined)).toBeUndefined();
    expect(drawnPictureBox(undefined, 1000)).toBeUndefined();
    expect(drawnPictureBox(undefined, undefined)).toBeUndefined();
    expect(drawnPictureBox(0, 1000)).toBeUndefined();
    expect(drawnPictureBox(640, -1)).toBeUndefined();
  });

  it("states the ceiling the thumbnail is really drawn under", () => {
    // The number above is arithmetic over a Tailwind class in another file, so the two are
    // pinned together here: `max-h-80` is 20rem, and 20rem is 320px at this app's root size.
    const source = readFileSync(new URL("../components/media-image.tsx", import.meta.url), "utf8");
    expect(source).toContain("max-h-80");
    expect(MAX_DRAWN_PICTURE_HEIGHT).toBe(20 * 16);
  });
});

import { describe, expect, it } from "vitest";
import {
  anchorTransform,
  clampPan,
  clampZoom,
  fitRect,
  FIT_VIEW,
  MAX_UPSCALE,
  viewTransform,
  wheelZoomFactor,
  zoomAround,
  ZOOM_MARGIN,
  ZOOM_MAX,
  type Point,
  type Rect,
  type Size,
  type View,
} from "./image-zoom";

const VIEWPORT: Size = { width: 1200, height: 800 };

/** Where a viewport point lands after a view is applied to the fit box. */
function project(point: Point, view: View, fit: Rect): Point {
  const centre = { x: fit.left + fit.width / 2, y: fit.top + fit.height / 2 };
  return {
    x: centre.x + view.pan.x + view.zoom * (point.x - centre.x),
    y: centre.y + view.pan.y + view.zoom * (point.y - centre.y),
  };
}

describe("fitRect", () => {
  it("shrinks a picture larger than the viewport into it, margin included", () => {
    const fit = fitRect({ width: 4000, height: 3000 }, VIEWPORT);

    expect(fit.height).toBeCloseTo(VIEWPORT.height - ZOOM_MARGIN * 2, 5);
    expect(fit.width / fit.height).toBeCloseTo(4 / 3, 5);
    expect(fit.width).toBeLessThanOrEqual(VIEWPORT.width - ZOOM_MARGIN * 2);
  });

  it("grows a small picture instead of showing it at its own size", () => {
    const natural: Size = { width: 64, height: 48 };
    const fit = fitRect(natural, VIEWPORT);

    expect(fit.width).toBeCloseTo(natural.width * MAX_UPSCALE, 5);
    expect(fit.height).toBeCloseTo(natural.height * MAX_UPSCALE, 5);
    expect(fit.width / fit.height).toBeCloseTo(natural.width / natural.height, 5);
  });

  it("grows a mid-sized picture only until it fills the viewport", () => {
    const fit = fitRect({ width: 600, height: 400 }, VIEWPORT);

    // 1.84× here, not the 3× cap: the viewport runs out first.
    expect(fit.height).toBeCloseTo(VIEWPORT.height - ZOOM_MARGIN * 2, 5);
    expect(fit.width).toBeCloseTo((VIEWPORT.height - ZOOM_MARGIN * 2) * 1.5, 5);
  });

  it("centres the box in the viewport", () => {
    const fit = fitRect({ width: 800, height: 200 }, VIEWPORT);

    expect(fit.left + fit.width / 2).toBeCloseTo(VIEWPORT.width / 2, 5);
    expect(fit.top + fit.height / 2).toBeCloseTo(VIEWPORT.height / 2, 5);
  });

  it("uses the whole available box while the picture's size is unknown", () => {
    const fit = fitRect({ width: 0, height: 0 }, VIEWPORT);

    expect(fit.width).toBe(VIEWPORT.width - ZOOM_MARGIN * 2);
    expect(fit.height).toBe(VIEWPORT.height - ZOOM_MARGIN * 2);
  });
});

describe("anchorTransform", () => {
  it("puts the fit box back exactly over its thumbnail", () => {
    const fit = fitRect({ width: 600, height: 400 }, VIEWPORT);
    const anchor: Rect = { left: 120, top: 640, width: 150, height: 100 };

    const transform = anchorTransform(fit, anchor);
    const scale = Number(/scale\(([-\d.]+)\)/.exec(transform)![1]);
    const travel = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform)!;
    const dx = Number(travel[1]);
    const dy = Number(travel[2]);

    expect(fit.width * scale).toBeCloseTo(anchor.width, 5);
    expect(fit.height * scale).toBeCloseTo(anchor.height, 5);
    expect(fit.left + fit.width / 2 + dx).toBeCloseTo(anchor.left + anchor.width / 2, 5);
    expect(fit.top + fit.height / 2 + dy).toBeCloseTo(anchor.top + anchor.height / 2, 5);
  });
});

describe("zoomAround", () => {
  it("keeps the point under the pointer under it", () => {
    const fit = fitRect({ width: 1000, height: 1000 }, VIEWPORT);
    const at: Point = { x: 700, y: 300 };
    const before: View = { zoom: 1, pan: { x: 0, y: 0 } };

    const after = zoomAround(before, 2.5, at, fit, VIEWPORT);
    // The picture point that was under the pointer is the one whose projection
    // was `at`; after the zoom its projection must be `at` again.
    const source = {
      x: (at.x - (fit.left + fit.width / 2) - before.pan.x) / before.zoom + fit.left + fit.width / 2,
      y: (at.y - (fit.top + fit.height / 2) - before.pan.y) / before.zoom + fit.top + fit.height / 2,
    };

    expect(project(source, after, fit).x).toBeCloseTo(at.x, 4);
    expect(project(source, after, fit).y).toBeCloseTo(at.y, 4);
  });

  it("never zooms past the bounds, and re-centres a picture that fits", () => {
    const fit = fitRect({ width: 1000, height: 1000 }, VIEWPORT);

    expect(zoomAround(FIT_VIEW, 99, { x: 600, y: 400 }, fit, VIEWPORT).zoom).toBe(ZOOM_MAX);
    const out = zoomAround({ zoom: 4, pan: { x: 300, y: 120 } }, 0.2, { x: 10, y: 10 }, fit, VIEWPORT);
    expect(out.zoom).toBe(1);
    expect(out.pan.x).toBeCloseTo(0, 10);
    expect(out.pan.y).toBeCloseTo(0, 10);
  });
});

describe("clampPan", () => {
  it("stops a large picture when its edge reaches the viewport edge", () => {
    const fit = fitRect({ width: 1000, height: 1000 }, VIEWPORT);
    const zoom = 3;
    const limit = (fit.height * zoom - VIEWPORT.height) / 2;

    expect(clampPan({ x: 0, y: 9999 }, zoom, fit, VIEWPORT).y).toBeCloseTo(limit, 5);
    expect(clampPan({ x: 0, y: -9999 }, zoom, fit, VIEWPORT).y).toBeCloseTo(-limit, 5);
  });

  it("keeps a picture that fits centred", () => {
    const fit = fitRect({ width: 400, height: 300 }, VIEWPORT);

    const pan = clampPan({ x: 200, y: -80 }, 1, fit, VIEWPORT);
    expect(pan.x).toBeCloseTo(0, 10);
    expect(pan.y).toBeCloseTo(0, 10);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in scrolling up and out scrolling down", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    // Symmetric: a notch up then the same notch down is the identity.
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 10);
  });

  it("normalizes a wheel that reports lines or pages", () => {
    expect(wheelZoomFactor(-1, 1)).toBeCloseTo(wheelZoomFactor(-16, 0), 10);
    expect(wheelZoomFactor(-1, 2)).toBeCloseTo(wheelZoomFactor(-400, 0), 10);
  });

  it("amplifies a trackpad pinch, which arrives as tiny ctrl+wheel deltas", () => {
    expect(wheelZoomFactor(-10, 0, true)).toBeGreaterThan(wheelZoomFactor(-10, 0, false));
  });
});

describe("clampZoom and viewTransform", () => {
  it("bounds the zoom to the fit box and 8×", () => {
    expect(clampZoom(0.1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(50)).toBe(ZOOM_MAX);
  });

  it("writes the pan, the drag and the zoom into one transform", () => {
    expect(viewTransform({ zoom: 2, pan: { x: 10, y: -20 } }, { x: 1, y: 2 })).toBe(
      "translate(11px, -18px) scale(2)",
    );
  });
});

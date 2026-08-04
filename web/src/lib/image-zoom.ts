/**
 * Geometry for the chat-image lightbox (components/image-lightbox.tsx).
 *
 * All of it is pure: a picture's box, the transform that puts that box back over
 * its thumbnail, and what a wheel notch or a pinch does to the view. Keeping it
 * out of the component is what makes the maths testable — anchored zoom and pan
 * clamping are exactly the parts that are wrong by one term and still look
 * plausible on screen.
 *
 * Coordinates are viewport pixels. The picture is drawn as an absolutely
 * positioned element at its {@link fitRect}, and the view (zoom + pan) is a CSS
 * transform on top of that box, about its own centre.
 */

/** Space kept between a zoomed picture and the edge of the viewport, in px. */
export const ZOOM_MARGIN = 32;

/** The view the picture opens at: the whole fit box, centred. */
export const FIT_VIEW: View = { zoom: 1, pan: { x: 0, y: 0 } };

/** Zoom bounds, as a multiple of the fit box (1 = the picture fills its box). */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

/**
 * How far past its own resolution a picture is grown to fill the viewport.
 *
 * A picture SMALLER than the viewport is grown, because opening a 200px
 * thumbnail into a 200px picture reads as nothing happening at all. It is not
 * grown without limit: past roughly three times its own pixels a raster picture
 * is mush, and mush is not a preview. The wheel still takes it further when the
 * user asks for that (see {@link ZOOM_MAX}).
 */
export const MAX_UPSCALE = 3;

/** How far a one-finger drag pulls a fitting picture down before it closes, px. */
export const SWIPE_CLOSE_DISTANCE = 96;

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; width: number; height: number };

/** Zoom (a multiple of the fit box) plus a pan offset from its centre. */
export type View = { zoom: number; pan: Point };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * The box a picture of `natural` size opens into: the largest box with the
 * picture's own aspect ratio that fits the viewport minus `margin` on every
 * side, centred — grown up to {@link MAX_UPSCALE} when the picture is smaller
 * than that. A picture whose size is not known yet gets the whole available box.
 */
export function fitRect(natural: Size, viewport: Size, margin = ZOOM_MARGIN): Rect {
  const available: Size = {
    width: Math.max(1, viewport.width - margin * 2),
    height: Math.max(1, viewport.height - margin * 2),
  };
  const known = natural.width > 0 && natural.height > 0;
  const scale = known
    ? Math.min(available.width / natural.width, available.height / natural.height, MAX_UPSCALE)
    : 1;
  const width = known ? natural.width * scale : available.width;
  const height = known ? natural.height * scale : available.height;
  return {
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
    height,
  };
}

/**
 * The transform that puts the fit box back exactly over `anchor` — the thumbnail
 * in the message — so the picture flies out of the thread on open and back into
 * it on close. Assumes `transform-origin` is the box's own centre.
 */
export function anchorTransform(fit: Rect, anchor: Rect): string {
  const scale =
    fit.width > 0 && fit.height > 0
      ? Math.min(anchor.width / fit.width, anchor.height / fit.height)
      : 1;
  const dx = anchor.left + anchor.width / 2 - (fit.left + fit.width / 2);
  const dy = anchor.top + anchor.height / 2 - (fit.top + fit.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

/** The CSS transform of a view. */
export function viewTransform(view: View, drag: Point = { x: 0, y: 0 }): string {
  return `translate(${view.pan.x + drag.x}px, ${view.pan.y + drag.y}px) scale(${view.zoom})`;
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, ZOOM_MIN, ZOOM_MAX);
}

/**
 * Keep the picture over the viewport: one larger than the viewport may be dragged
 * until its own edge meets the viewport edge and no further, and one that fits
 * stays centred. Re-applied on every change, so a resize can never leave the
 * picture parked off-screen.
 */
export function clampPan(pan: Point, zoom: number, fit: Rect, viewport: Size): Point {
  const limit: Point = {
    x: Math.max(0, (fit.width * zoom - viewport.width) / 2),
    y: Math.max(0, (fit.height * zoom - viewport.height) / 2),
  };
  return { x: clamp(pan.x, -limit.x, limit.x), y: clamp(pan.y, -limit.y, limit.y) };
}

/**
 * Zoom to `zoom` while keeping the point of the picture that sits under `at`
 * (viewport coordinates) under it. That is what makes a wheel zoom magnify what
 * the pointer names rather than the middle of the screen.
 */
export function zoomAround(
  view: View,
  zoom: number,
  at: Point,
  fit: Rect,
  viewport: Size,
): View {
  const next = clampZoom(zoom);
  const centre: Point = { x: fit.left + fit.width / 2, y: fit.top + fit.height / 2 };
  const ratio = next / view.zoom;
  // The point under `at` before the change is `at - centre - pan`, scaled by
  // 1/zoom. Solving "the same point stays under `at`" for the new pan gives this.
  const pan: Point = {
    x: at.x - centre.x - ratio * (at.x - centre.x - view.pan.x),
    y: at.y - centre.y - ratio * (at.y - centre.y - view.pan.y),
  };
  return { zoom: next, pan: clampPan(pan, next, fit, viewport) };
}

/**
 * A wheel notch turned into a zoom multiplier. Exponential, so one notch feels
 * the same at every zoom level, and normalized across `deltaMode` because a
 * mouse wheel reports lines where a trackpad reports pixels. A pinch on a
 * trackpad arrives as ctrl+wheel with small deltas, so it is amplified.
 */
export function wheelZoomFactor(deltaY: number, deltaMode = 0, ctrlKey = false): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  const step = ctrlKey ? 0.01 : 0.0025;
  return Math.exp(-pixels * step);
}

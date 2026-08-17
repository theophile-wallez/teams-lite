/**
 * How much room a picture takes in a message.
 *
 * A picture is drawn at the size it STATES (see `pixelAttr` in `rich-text.ts` and the
 * `{width=… height=…}` block a GitLab upload carries), under a ceiling on its height — and the
 * two have to agree, which is the whole of this module.
 */

/** The tallest a picture is drawn: `max-h-80` on the thumbnail in `media-image.tsx`, which is
 *  20rem at this app's root size. It is spelled here as a number because the box below is
 *  arithmetic over it, and `media-size.test.ts` pins the two together — a ceiling this
 *  arithmetic disagrees with is exactly the letterbox it exists to prevent. */
export const MAX_DRAWN_PICTURE_HEIGHT = 320;

/**
 * The box a picture of a STATED size is drawn in: its own shape, no taller than the ceiling.
 *
 * A stated width makes the CSS width DEFINITE, so `max-height` clamps the height ALONE and
 * `object-contain` fits the picture inside a box far too wide for it — a photo from a phone
 * came out with a hand's width of empty mat either side of it, and the box the words around it
 * reserved was that same too-wide one. Scaling BOTH numbers keeps the ratio the browser derives
 * from them, so the box is the picture and the picture is the box.
 *
 * It needs the PAIR, because a ceiling on the height can only reach the width through a ratio —
 * the rule the parse already follows for the same reason. A picture that states nothing is
 * unaffected: with no definite width the browser shrinks the box itself.
 */
export function drawnPictureBox(
  width: number | undefined,
  height: number | undefined,
): { width: number; height: number } | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  if (height <= MAX_DRAWN_PICTURE_HEIGHT) return { width, height };
  return {
    // Floored rather than rounded: a width rounded UP puts the height a fraction of a pixel
    // over the ceiling, where `max-height` clamps it and the letterbox is back at that
    // fraction. At least one pixel, so a picture 400x100000 is still a picture.
    width: Math.max(1, Math.floor((width * MAX_DRAWN_PICTURE_HEIGHT) / height)),
    height: MAX_DRAWN_PICTURE_HEIGHT,
  };
}

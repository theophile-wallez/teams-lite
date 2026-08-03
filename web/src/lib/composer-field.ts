/**
 * The composer field's own metrics, shared by the rich editor and by the
 * placeholder the composer shows while TipTap (a lazily loaded chunk) arrives.
 *
 * One constant, because the two must agree: the box is exactly as tall before the
 * editor mounts as after, so the field never jumps under the cursor on hydration.
 * `text-base` (16px) stops iOS Safari auto-zooming on focus; `md:text-sm` keeps
 * 14px on desktop.
 */
export const COMPOSER_FIELD_CLASS =
  "max-h-64 min-h-[1.5rem] w-full px-1 py-1 text-base md:text-sm";

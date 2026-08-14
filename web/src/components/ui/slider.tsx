import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "~/lib/utils";

/**
 * A slider, over `@radix-ui/react-slider` — the ninth radix primitive in this app, and here
 * for the reason the other eight are: the keyboard (arrows, Home/End, PageUp/PageDown), the
 * aria roles and the pointer capture are not things to re-derive per control.
 *
 * It takes an ARRAY, so one thumb and two are the same component: the presence hours are the
 * two-thumb case (`web/src/components/settings-pane.tsx`). Three rules of this app's own:
 *
 *   * **The thumb is 44px of TARGET around a 16px of ink.** A 16px circle is what the design
 *     wants and half of what a thumb has to be to be hit on a phone, so the hit area is grown
 *     with a pseudo-element rather than the ink — growing the ink would make a control that
 *     reads as heavy, and shrinking the target is what makes a slider unusable on a phone.
 *   * **The track carries its own contrast in both themes.** `bg-element` under
 *     `bg-primary` is the pair every other control here uses, so the filled part is legible
 *     against the empty part rather than only against the card.
 *   * **The RANGE may be drawn by the caller instead** (`renderRange: false`), which is what
 *     a window crossing midnight needs: green from the evening to the morning is two segments
 *     with a gap in the middle, and this primitive's own `Range` is one element.
 */
export function Slider({
  className,
  renderRange = true,
  children,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Draw the primitive's own filled range. `false` leaves the track to `children`. */
  renderRange?: boolean;
}) {
  const thumbs = Array.isArray(props.value) ? props.value.length : 1;
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none select-none items-center py-3",
        "data-[disabled]:opacity-60",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-element">
        {renderRange && <SliderPrimitive.Range className="absolute h-full bg-primary" />}
        {children}
      </SliderPrimitive.Track>
      {Array.from({ length: thumbs }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          className={cn(
            "relative block size-4 shrink-0 rounded-full border-2 border-primary bg-background shadow-chip",
            "transition-colors hover:border-primary/80",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            // 44px of touch target around 16px of ink (see the note above).
            "after:absolute after:-inset-3.5 after:content-['']",
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

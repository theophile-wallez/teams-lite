import type { CSSProperties, HTMLAttributes } from "react";
import { cn } from "~/lib/utils";

/**
 * A hairline that catches the light, travelling around the edge of the box it is dropped
 * into. After magicui's ShineBorder (magicui.design/docs/components/shine-border, MIT).
 *
 * Two things make it a BORDER rather than a wash, and both are the mask's work: the
 * element is a radial gradient three times the size of its own box, and the padding box
 * is punched out of it (`mask-composite: exclude`), so only `width` of ring is ever
 * painted. The animation then moves the gradient across that ring, which is why nothing
 * about the geometry changes while it runs — a message in a virtualized history is not
 * re-laid-out sixty times a second (see `.shine-border` in styles/app.css, which also
 * takes it away under `prefers-reduced-motion`).
 *
 * It sits `absolute inset-0` and takes its radius from its parent (`rounded-[inherit]`),
 * so a caller owes it one positioned ancestor and nothing else. It is inert: no pointer
 * events, and nothing for a screen reader to read.
 */
export function ShineBorder(props: {
  /** What the light is made of. One colour, or several for a gradient of them. Defaults
   *  to the app's accent, as a `var()` so it follows the theme. */
  color?: string | string[];
  /** How thick the ring is, in pixels. One hairline by default. */
  width?: number;
  /** How long one pass round the box takes, in seconds. */
  duration?: number;
  className?: string;
  style?: CSSProperties;
} & Omit<HTMLAttributes<HTMLDivElement>, "color" | "style" | "className">) {
  const { color = "var(--primary)", width = 1, duration = 6, className, style, ...rest } = props;
  const light = Array.isArray(color) ? color.join(",") : color;
  return (
    <div
      aria-hidden
      {...rest}
      style={{
        // The transparent stops on both sides are what makes it a moving highlight
        // rather than a lit ring: most of the box is empty, so only the stretch of edge
        // the gradient is over at that moment shows any colour at all.
        backgroundImage: `radial-gradient(transparent, transparent, ${light}, transparent, transparent)`,
        backgroundSize: "300% 300%",
        mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
        maskComposite: "exclude",
        WebkitMaskComposite: "xor",
        padding: width,
        ["--shine-duration" as string]: `${duration}s`,
        ...style,
      }}
      className={cn("shine-border pointer-events-none absolute inset-0 rounded-[inherit]", className)}
    />
  );
}

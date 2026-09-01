// loading-ui's Fade Arc (https://loading-ui.com/docs/components/fade-arc, MIT) — the app's
// one loader. It is the vendor's own file, kept as theirs, exactly as magicui's ShineBorder is
// (components/magicui/shine-border.tsx): an arc of two gradient-filled segments whose leading
// edge is solid and whose tail fades out, turning once a second.
//
// It is a LOADING INDICATOR and not an icon set, so § Hugeicons is untouched — every GLYPH in
// this app still comes from @hugeicons/core-free-icons, and `icon-library.test.ts` still holds.
// That is the same footing `thinking-orbs` stands on for the update button's own work mark. No
// package is installed for this: the registry hands over source, and this is that source.
//
// TWO adaptations, and each is the one ShineBorder already made:
//
//  - the import path is this project's own alias (`~/lib/utils`).
//  - the `@keyframes` the vendor injects as an inline <style> live in `styles/app.css` beside
//    every other keyframe in this app. The vendor's shape is one <style> element PER INSTANCE,
//    which React cannot dedupe (there is no `href` to key on) — and a loader is mounted and
//    unmounted constantly here, inside a VIRTUALIZED history among other places, so that shape
//    would thrash a style node per row. The stylesheet holds the rule once instead.
//
// The animation is left where the vendor put it, INLINE, and that is deliberate: app.css's
// global `prefers-reduced-motion` rule is `!important`, and an important author declaration
// beats a normal inline one — so a reader who asked for less motion gets a still arc, which is
// exactly what `animate-spin` already gave them. Nothing about that behaviour changed.
//
// Sizing is the CALLER's, through a `size-*` utility: the svg carries a viewBox and no
// width/height, so a site that names no size draws at the width of whatever contains it. Inside
// the `Button` primitive that size comes for free (`[&_svg]:size-4`); everywhere else it is
// spelled. The ink is `currentColor` in both gradients, so a `text-*` class tints the arc and
// its tail together, and `--duration` sets the speed.
import * as React from "react";

import { cn } from "~/lib/utils";

function FadeArc({ className, style, ...props }: React.ComponentProps<"svg">) {
  const baseId = React.useId().replace(/:/g, "");
  const leadingGradientId = `${baseId}-leading`;
  const trailingGradientId = `${baseId}-trailing`;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="status"
      className={cn(className)}
      style={{
        animationName: "loading-ui-fade-arc-spin",
        animationDuration: "var(--duration, 1s)",
        animationTimingFunction: "linear",
        animationIterationCount: "infinite",
        ...style,
      }}
      {...props}
    >
      <defs>
        <linearGradient id={leadingGradientId} x1="50%" x2="50%" y1="5.271%" y2="91.793%">
          <stop offset="0%" stopColor="currentColor" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={trailingGradientId} x1="50%" x2="50%" y1="15.24%" y2="87.15%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <g fill="none">
        <path
          d="M8.749.021a1.5 1.5 0 0 1 .497 2.958A7.5 7.5 0 0 0 3 10.375a7.5 7.5 0 0 0 7.5 7.5v3c-5.799 0-10.5-4.7-10.5-10.5C0 5.23 3.726.865 8.749.021"
          fill={`url(#${leadingGradientId})`}
          transform="translate(1.5 1.625)"
        />
        <path
          d="M15.392 2.673a1.5 1.5 0 0 1 2.119-.115A10.48 10.48 0 0 1 21 10.375c0 5.8-4.701 10.5-10.5 10.5v-3a7.5 7.5 0 0 0 5.007-13.084a1.5 1.5 0 0 1-.115-2.118"
          fill={`url(#${trailingGradientId})`}
          transform="translate(1.5 1.625)"
        />
      </g>
    </svg>
  );
}

export { FadeArc };

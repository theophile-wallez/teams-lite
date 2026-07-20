// A braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏), the same style used by opencode. Renders a
// single animated glyph that cycles through the frames on a fixed interval, so
// any loading state reads as "working" rather than frozen.
//
// The interval is owned by the component and cleaned up on unmount; nothing
// runs when a Spinner is not mounted.

import { createSignal, onMount, onCleanup, For } from "solid-js";
import { type ColorInput } from "@opentui/core";
import { theme } from "./theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

export function Spinner(props: { color?: ColorInput; label?: string }) {
  const [frame, setFrame] = createSignal(0);
  onMount(() => {
    const t = setInterval(() => setFrame((i) => (i + 1) % FRAMES.length), FRAME_MS);
    onCleanup(() => clearInterval(t));
  });

  const content = () => (props.label ? `${FRAMES[frame()]} ${props.label}` : FRAMES[frame()]);
  return <text content={content()} style={{ fg: props.color ?? theme().textMuted }} />;
}

// A pulsing block bar (the "wave" spinner from opencode): a row of blocks where
// a brightness crest sweeps back and forth. Each block is tinted from a color
// ramp based on its distance to the crest, so the whole bar reads as a moving
// gradient rather than a single moving dot.
//
// The palette is a prop (darkest → brightest); it defaults to the active theme's
// pulse ramp, so the splash bar recolors with the theme.

const PULSE_MS = 90;

export function PulseBar(props: { width?: number; colors?: readonly ColorInput[] }) {
  const width = () => props.width ?? 8;
  const ramp = () => props.colors ?? theme().pulseRamp;

  // `pos` is the crest index; `dir` flips it at the ends for a ping-pong sweep.
  const [pos, setPos] = createSignal(0);
  onMount(() => {
    let dir = 1;
    const t = setInterval(() => {
      setPos((p) => {
        let next = p + dir;
        if (next >= width() - 1) { next = width() - 1; dir = -1; }
        else if (next <= 0) { next = 0; dir = 1; }
        return next;
      });
    }, PULSE_MS);
    onCleanup(() => clearInterval(t));
  });

  // Distance 0 → brightest color; farther blocks fall back down the ramp.
  const colorAt = (i: number) => {
    const r = ramp();
    const dist = Math.abs(i - pos());
    const idx = Math.max(0, r.length - 1 - dist);
    return r[idx];
  };

  return (
    <box style={{ flexDirection: "row" }}>
      <For each={Array.from({ length: width() })}>
        {(_, i) => <text content="█" style={{ fg: colorAt(i()) }} />}
      </For>
    </box>
  );
}

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { splitWordEffects, type WordEffect } from "~/lib/word-effects";

/** The class that carries each effect's palette, motion and corner glyphs. */
const EFFECT_CLASS: Record<WordEffect, string> = {
  sparkle: "sparkle-word",
  football: "football-word",
};

/**
 * One decorated word: every letter gets its own color from the effect's ramp and
 * animates on a staggered delay, with a pair of glyphs at the corners — sparkles
 * for the nicknames, footballs for the football words. No chip behind it, the
 * message's own background shows through. All of the look lives in `.effect-word`
 * and the per-effect classes (app.css) so the palette can follow the surface the
 * word lands on and the global `prefers-reduced-motion` rule can still the whole
 * thing; here we only emit the per-letter spans and the stagger index each one
 * animates on.
 *
 * The letters are hidden from assistive tech and the word is restated as the
 * wrapper's label, so a screen reader announces "bébou" rather than spelling it
 * out; selection and copy still yield the plain word.
 */
export function EffectWord({ word, effect }: { word: string; effect: WordEffect }) {
  return (
    <span className={`effect-word ${EFFECT_CLASS[effect]}`} aria-label={word}>
      {Array.from(word).map((letter, i) => (
        <span
          key={i}
          className="effect-word-letter"
          style={{ "--effect-index": i } as CSSProperties}
          aria-hidden
        >
          {letter}
        </span>
      ))}
    </span>
  );
}

/**
 * Render a text run with any decorated word wrapped in an {@link EffectWord}.
 * Text without one is returned as a bare string, so ordinary messages render
 * exactly as before — no wrapper elements, no extra DOM.
 */
export function renderWordEffects(text: string, key: number): ReactNode {
  const segments = splitWordEffects(text);
  if (segments.length === 1 && !segments[0]!.effect) return text;
  return (
    <Fragment key={key}>
      {segments.map((segment, i) =>
        segment.effect ? (
          <EffectWord key={i} word={segment.text} effect={segment.effect} />
        ) : (
          segment.text
        ),
      )}
    </Fragment>
  );
}

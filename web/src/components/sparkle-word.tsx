import { Fragment, type CSSProperties, type ReactNode } from "react";
import { splitSparkleWords } from "~/lib/sparkle-words";

/**
 * One nickname, dressed up: every letter gets its own color from a candy ramp
 * and bobs and shimmers on a staggered delay, with sparkles twinkling at the
 * corners — no chip behind it, the message's own background shows through. All
 * of the look lives in `.sparkle-word` (app.css) so the palette can follow the
 * surface the word lands on and the global `prefers-reduced-motion` rule can
 * still the whole thing; here we only emit the per-letter spans and the stagger
 * index each one animates on.
 *
 * The letters are hidden from assistive tech and the word is restated as the
 * wrapper's label, so a screen reader announces "bébou" rather than spelling it
 * out; selection and copy still yield the plain word.
 */
export function SparkleWord({ word }: { word: string }) {
  return (
    <span className="sparkle-word" aria-label={word}>
      {Array.from(word).map((letter, i) => (
        <span
          key={i}
          className="sparkle-word-letter"
          style={{ "--sparkle-index": i } as CSSProperties}
          aria-hidden
        >
          {letter}
        </span>
      ))}
    </span>
  );
}

/**
 * Render a text run with any nickname wrapped in a {@link SparkleWord}. Text
 * without one is returned as a bare string, so ordinary messages render exactly
 * as before — no wrapper elements, no extra DOM.
 */
export function renderSparkleWords(text: string, key: number): ReactNode {
  const segments = splitSparkleWords(text);
  if (segments.length === 1 && !segments[0]!.sparkle) return text;
  return (
    <Fragment key={key}>
      {segments.map((segment, i) =>
        segment.sparkle ? <SparkleWord key={i} word={segment.text} /> : segment.text,
      )}
    </Fragment>
  );
}

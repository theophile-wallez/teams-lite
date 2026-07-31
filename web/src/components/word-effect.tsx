import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { splitWordEffects, type WordEffect } from "~/lib/word-effects";
import { wordMotionBudget } from "~/lib/word-effect-motion";

/** The class that carries each effect's palette, motion and corner glyphs. */
const EFFECT_CLASS: Record<WordEffect, string> = {
  sparkle: "sparkle-word",
  football: "football-word",
};

/** What every decorated word on the page reports its visibility to. */
const onScreenHandlers = new WeakMap<Element, (onScreen: boolean) => void>();
let onScreenObserver: IntersectionObserver | null = null;

/**
 * Report whether `node` is on screen, now and on every change. One observer
 * serves every decorated word, since an observer per word would cost more than
 * the words it watches.
 *
 * Where there is no observer to be had — an old browser, a test renderer — the
 * word counts as on screen: the egg still moves and the budget still bounds it,
 * only the choice of *which* words move goes back to document order.
 */
function observeOnScreen(node: Element, onChange: (onScreen: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }
  onScreenObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) onScreenHandlers.get(entry.target)?.(entry.isIntersecting);
  });
  onScreenHandlers.set(node, onChange);
  onScreenObserver.observe(node);
  return () => {
    onScreenObserver?.unobserve(node);
    onScreenHandlers.delete(node);
  };
}

/**
 * A motion slot for one word, held only while the word is on screen and only
 * while the budget has room (see {@link wordMotionBudget}). `moving` starts false
 * and turns true once a slot is granted, so the server renders the still word and
 * the motion arrives after hydration — never a mismatch.
 */
function useWordMotion() {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let release: (() => void) | null = null;
    const stopObserving = observeOnScreen(node, (onScreen) => {
      if (onScreen === Boolean(release)) return;
      if (onScreen) {
        release = wordMotionBudget.claim(() => setMoving(true));
      } else {
        release?.();
        release = null;
        setMoving(false);
      }
    });
    return () => {
      stopObserving();
      release?.();
    };
  }, []);
  return { ref, moving };
}

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
 * `data-motion="on"` is what turns the animations on in the CSS, and a word only
 * gets it while it holds a slot in the motion budget. A word without one keeps the
 * whole look and stands still, so a message with a hundred nicknames still reads as
 * the egg it is without animating five hundred letters at once.
 *
 * The letters are hidden from assistive tech and the word is restated as the
 * wrapper's label, so a screen reader announces "bébou" rather than spelling it
 * out; selection and copy still yield the plain word.
 */
export function EffectWord({ word, effect }: { word: string; effect: WordEffect }) {
  const { ref, moving } = useWordMotion();
  return (
    <span
      ref={ref}
      className={`effect-word ${EFFECT_CLASS[effect]}`}
      data-motion={moving ? "on" : undefined}
      aria-label={word}
    >
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

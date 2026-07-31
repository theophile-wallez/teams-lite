// How many decorated words may animate at the same time — the budget behind the
// word-effect easter egg (see lib/word-effects.ts and components/word-effect.tsx).
//
// A decorated word is expensive to animate and cheap to merely draw. Every letter
// carries two infinite animations (the bob and the shimmer) and every corner glyph
// one more, so "bébou" alone runs twelve; the shimmer animates `filter`, which
// repaints the letter on every frame instead of riding the compositor. Measured in
// Chromium on a decorated word repeated across a message: 8 words held 60 fps,
// 24 words sat on the edge, 100 words collapsed to 8 fps — while the very same DOM
// with the animations switched off stayed at 60 fps with 300 words. The DOM is not
// the cost. The running animations are.
//
// So the count of *animating* words is bounded, and nothing else: a word that gets
// no slot keeps its whole look (the ramp, the halo, the corner glyphs) and only
// stands still, which is the resting look the reduced-motion rule already ships.
// The slots go to the words on screen (the observer in components/word-effect.tsx),
// so the motion follows the reader instead of sticking to the top of a long message.
//
// The budget is pure bookkeeping — no React, no DOM — so it unit-tests in the node
// environment alongside the detection logic.

/**
 * How many words may animate at once. Small on purpose: the measurements above
 * come from a desktop, and the same page runs on the user's phone, so the limit
 * sits well under the knee rather than on it.
 */
export const MAX_MOVING_WORDS = 8;

/** A pool of motion slots, handed out first-come and given back on release. */
export type MotionBudget = {
  /**
   * Ask for one slot. `onGrant` runs at once when a slot is free, and later when
   * another word gives one back. The returned function releases the slot, or
   * withdraws the request while it is still waiting; call it exactly once.
   */
  claim(onGrant: () => void): () => void;
  /** How many slots are out. For the tests. */
  granted(): number;
  /** How many words are waiting for one. For the tests. */
  waiting(): number;
};

/** A budget of `limit` slots. */
export function createMotionBudget(limit: number): MotionBudget {
  let granted = 0;
  const queue: Array<() => void> = [];

  /** Pass a freed slot to the next waiter, or return it to the pool. */
  function handOver(): void {
    const next = queue.shift();
    if (next) next();
    else granted--;
  }

  return {
    claim(onGrant) {
      // A wrapper of its own, so two claims that share one callback still hold
      // two distinguishable places in the queue.
      const waiter = () => onGrant();
      if (granted < limit) {
        granted++;
        onGrant();
      } else {
        queue.push(waiter);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const queued = queue.indexOf(waiter);
        if (queued >= 0) queue.splice(queued, 1);
        else handOver();
      };
    },
    granted: () => granted,
    waiting: () => queue.length,
  };
}

/** The one budget every decorated word on the page draws from. */
export const wordMotionBudget = createMotionBudget(MAX_MOVING_WORDS);

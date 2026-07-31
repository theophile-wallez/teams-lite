import { describe, expect, it } from "vitest";
import { createMotionBudget, MAX_MOVING_WORDS, wordMotionBudget } from "~/lib/word-effect-motion";

/** A claim that records whether it was granted. */
function claim(budget: ReturnType<typeof createMotionBudget>) {
  const state = { moving: false, release: () => {} };
  state.release = budget.claim(() => {
    state.moving = true;
  });
  return state;
}

describe("createMotionBudget", () => {
  it("grants up to the limit and no more", () => {
    const budget = createMotionBudget(2);
    const words = [claim(budget), claim(budget), claim(budget)];
    expect(words.map((w) => w.moving)).toEqual([true, true, false]);
    expect(budget.granted()).toBe(2);
    expect(budget.waiting()).toBe(1);
  });

  it("hands a released slot to the word that waited longest", () => {
    const budget = createMotionBudget(1);
    const [held, second, third] = [claim(budget), claim(budget), claim(budget)];
    held.release();
    expect(second.moving).toBe(true);
    expect(third.moving).toBe(false);
    second.release();
    expect(third.moving).toBe(true);
    expect(budget.granted()).toBe(1);
  });

  it("returns the slot to the pool when nobody waits", () => {
    const budget = createMotionBudget(2);
    const word = claim(budget);
    word.release();
    expect(budget.granted()).toBe(0);
    expect(claim(budget).moving).toBe(true);
  });

  it("withdraws a claim that is still waiting, without freeing a slot", () => {
    const budget = createMotionBudget(1);
    const [held, waiting] = [claim(budget), claim(budget)];
    waiting.release();
    expect(budget.granted()).toBe(1);
    expect(budget.waiting()).toBe(0);
    // The slot the first word holds is still its own.
    held.release();
    expect(budget.granted()).toBe(0);
  });

  it("ignores a second release, so a slot is never given away twice", () => {
    const budget = createMotionBudget(1);
    const word = claim(budget);
    word.release();
    word.release();
    expect(budget.granted()).toBe(0);
    expect(claim(budget).moving).toBe(true);
    expect(budget.granted()).toBe(1);
  });

  it("keeps two claims that share one callback apart in the queue", () => {
    const budget = createMotionBudget(1);
    let grants = 0;
    const grant = () => {
      grants++;
    };
    const held = budget.claim(grant);
    const first = budget.claim(grant);
    budget.claim(grant);
    expect(budget.waiting()).toBe(2);
    // Withdrawing one waiter must not drop the other.
    first();
    expect(budget.waiting()).toBe(1);
    held();
    expect(grants).toBe(2);
    expect(budget.waiting()).toBe(0);
  });
});

describe("wordMotionBudget", () => {
  it("is the shared budget, sized for a phone as much as a desktop", () => {
    expect(MAX_MOVING_WORDS).toBe(8);
    expect(wordMotionBudget.granted()).toBe(0);
  });
});

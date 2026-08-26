import { describe, expect, it } from "vitest";
import {
  PET_GENESIS,
  PET_LEVEL_COST,
  PET_NAP_MS,
  PET_PAT_AFFECTION,
  PET_PATS_COUNTED,
  petAffectionBonus,
  petLevelProgress,
  petNeedsSomething,
  petSnapshot,
  type PetFoldAct,
} from "./pet-state";

const HOUR = 3_600_000;
const BIRTH = 1_756_000_000_000;

function at(hours: number): number {
  return BIRTH + hours * HOUR;
}

function act(hours: number, kind: PetFoldAct["kind"]): PetFoldAct {
  return { at: at(hours), kind };
}

describe("a newborn", () => {
  it("is born with openpets' own stats", () => {
    expect(petSnapshot(BIRTH, [], BIRTH).stats).toEqual(PET_GENESIS);
  });

  it("is content rather than happy, because a bond is earned", () => {
    // The mean of 80/80/80/50 is 72.5, under the 75 that happy needs.
    expect(petSnapshot(BIRTH, [], BIRTH).mood).toBe("content");
  });

  it("starts at level 1 with no xp", () => {
    const snap = petSnapshot(BIRTH, [], BIRTH);
    expect(snap.level).toBe(1);
    expect(snap.xp).toBe(0);
  });
});

describe("decay is a pure function of elapsed time", () => {
  it("costs the measured rate per hour", () => {
    const snap = petSnapshot(BIRTH, [], at(10));
    expect(snap.stats.hunger).toBeCloseTo(60, 6); // 80 − 2×10
    expect(snap.stats.energy).toBeCloseTo(50, 6); // 80 − 3×10
    expect(snap.stats.happiness).toBeCloseTo(60, 6);
    expect(snap.stats.affection).toBeCloseTo(40, 6);
  });

  it("takes 50 hours to starve and 33.3 to exhaust, from full", () => {
    expect(petSnapshot(BIRTH, [act(0, "feed")], at(50)).stats.hunger).toBeCloseTo(0, 6);
    expect(petSnapshot(BIRTH, [], at(80 / 3)).stats.energy).toBeCloseTo(0, 6);
  });

  it("never falls below zero or climbs above a hundred", () => {
    const starved = petSnapshot(BIRTH, [], at(500)).stats;
    for (const value of Object.values(starved)) expect(value).toBe(0);
    const stuffed = petSnapshot(BIRTH, [act(0, "feed"), act(0.001, "feed"), act(0.002, "feed")], at(0.003));
    expect(stuffed.stats.hunger).toBeLessThanOrEqual(100);
  });

  it("gives the same answer to two machines reading the same acts", () => {
    const acts = [act(1, "feed"), act(5, "play"), act(9, "feed")];
    const a = petSnapshot(BIRTH, acts, at(20));
    const b = petSnapshot(BIRTH, [...acts].reverse(), at(20));
    expect(a).toEqual(b);
  });
});

describe("the order of acts matters, which is why it is a fold", () => {
  /**
   * THE assertion behind `petSnapshot` being a walk rather than a sum: the clamp loses whatever
   * falls outside 0…100, so feeding early and feeding late are different creatures.
   */
  it("is not the same pet when a feed comes early as when it comes late", () => {
    const early = petSnapshot(BIRTH, [act(1, "feed")], at(48)).stats.hunger;
    const late = petSnapshot(BIRTH, [act(47, "feed")], at(48)).stats.hunger;
    expect(late).toBeGreaterThan(early);
  });

  it("loses a feed entirely when the pet was already full", () => {
    const full = petSnapshot(BIRTH, [act(0, "feed")], BIRTH).stats.hunger;
    expect(full).toBe(100); // 80 + 25, clamped
  });
});

describe("the acts", () => {
  it("feeds", () => {
    expect(petSnapshot(BIRTH, [act(0, "feed")], BIRTH).stats.hunger).toBe(100);
  });

  it("plays, and play is the only act with a cost", () => {
    const snap = petSnapshot(BIRTH, [act(0, "play")], BIRTH).stats;
    expect(snap.happiness).toBe(100); // 80 + 25 clamped
    expect(snap.energy).toBe(65); // 80 − 15
  });

  it("naps, and sleeping wins over every other mood", () => {
    const snap = petSnapshot(BIRTH, [act(0, "nap")], BIRTH + 60_000);
    expect(snap.mood).toBe("sleeping");
    expect(snap.asleepUntil).toBe(BIRTH + PET_NAP_MS);
  });

  it("buys energy fast while asleep", () => {
    // The nap gives 40 outright, then sleep pays 15/h for a quarter of an hour.
    const awake = petSnapshot(BIRTH, [act(0, "nap")], BIRTH + PET_NAP_MS);
    expect(awake.stats.energy).toBeCloseTo(100, 6); // 80 + 40 + 3.75, clamped
    const tired = petSnapshot(BIRTH, [act(20, "nap")], at(20) + PET_NAP_MS);
    // 80 − 3×20 = 20, then +40 = 60, then +3.75 asleep, minus a little hunger/happiness.
    expect(tired.stats.energy).toBeCloseTo(63.75, 6);
  });

  it("wakes the pet for anything but a nap", () => {
    const woken = petSnapshot(BIRTH, [act(0, "nap"), act(0.1, "feed")], at(0.2));
    expect(woken.asleepUntil).toBe(0);
    expect(woken.mood).not.toBe("sleeping");
  });
});

describe("refusals", () => {
  it("refuses an act from before the pet was born", () => {
    const snap = petSnapshot(BIRTH, [{ at: BIRTH - HOUR, kind: "feed" }], BIRTH);
    expect(snap.stats.hunger).toBe(PET_GENESIS.hunger);
  });

  it("refuses an act dated in the future", () => {
    const snap = petSnapshot(BIRTH, [{ at: at(10), kind: "feed" }], at(1));
    expect(snap.stats.hunger).toBeCloseTo(78, 6);
  });

  it("refuses a moment that is not a number at all", () => {
    const snap = petSnapshot(BIRTH, [{ at: Number.NaN, kind: "feed" }], BIRTH);
    expect(snap.stats).toEqual(PET_GENESIS);
  });
});

describe("the mood ladder, first match wins", () => {
  it("is hungry before it is tired, even when both are low", () => {
    // 40 h awake: hunger 0, energy 0 — hungry comes first in the ladder.
    expect(petSnapshot(BIRTH, [], at(40)).mood).toBe("hungry");
  });

  it("is tired when only energy is low", () => {
    const acts: PetFoldAct[] = [act(20, "feed")];
    const snap = petSnapshot(BIRTH, acts, at(21));
    expect(snap.stats.hunger).toBeGreaterThanOrEqual(30);
    expect(snap.stats.energy).toBeLessThan(30);
    expect(snap.mood).toBe("tired");
  });

  it("is happy only once the mean clears 75", () => {
    // 80 / 80 / 80 / 50 is a mean of 72.5 and merely content; two pats put the bond at 80, which
    // is the whole point of the bonus reaching the mood rather than only the number.
    expect(petSnapshot(BIRTH, [], BIRTH).mood).toBe("content");
    expect(petSnapshot(BIRTH, [], BIRTH, 2).mood).toBe("happy");
  });
});

describe("levelling", () => {
  /** A run of acts one millisecond apart, and the moment just after the last of them. Spacing them
   *  in HOURS would date most of them in the future of the read, which the fold rightly refuses. */
  function run(n: number, kind: PetFoldAct["kind"]): { acts: PetFoldAct[]; now: number } {
    return { acts: Array.from({ length: n }, (_, i) => ({ at: BIRTH + i, kind })), now: BIRTH + n };
  }

  it("takes ten feeds to reach level 2", () => {
    const { acts, now } = run(10, "feed");
    const snap = petSnapshot(BIRTH, acts, now);
    expect(snap.level).toBe(2);
    expect(snap.xp).toBe(0);
  });

  it("can carry a pet through more than one level", () => {
    // 30 feeds is 150 xp; level 1 costs 50 and level 2 costs 100, so it lands on level 3 with none left.
    const { acts, now } = run(30, "feed");
    const snap = petSnapshot(BIRTH, acts, now);
    expect(snap.level).toBe(3);
    expect(snap.xp).toBe(0);
  });

  it("reports progress through the current level", () => {
    const { acts, now } = run(5, "feed");
    const snap = petSnapshot(BIRTH, acts, now);
    expect(snap.xp).toBe(25);
    expect(petLevelProgress(snap)).toBeCloseTo(25 / PET_LEVEL_COST, 6);
  });
});

describe("a pat is a standing state rather than a timed act", () => {
  it("adds to the bond after the fold, so nothing decays it away", () => {
    // 50 hours of neglect is exactly what it takes to forget a bond; the pats still show, because
    // they are a term added at the end rather than an act ageing since some invented moment.
    const bare = petSnapshot(BIRTH, [], at(50));
    const patted = petSnapshot(BIRTH, [], at(50), 2);
    expect(bare.stats.affection).toBe(0);
    expect(patted.stats.affection).toBe(2 * PET_PAT_AFFECTION);
  });

  it("is taken back when the reaction is, which is the cost of holding it in a reaction", () => {
    // The same pet read with the reaction gone: the bond drops, because a reaction is a live set.
    const patted = petSnapshot(BIRTH, [], at(10), 1).stats.affection;
    const unreacted = petSnapshot(BIRTH, [], at(10), 0).stats.affection;
    expect(patted).toBe(unreacted + PET_PAT_AFFECTION);
  });

  it("counts at most three, so a bond is not a popularity count", () => {
    expect(petAffectionBonus(PET_PATS_COUNTED)).toBe(PET_PATS_COUNTED * PET_PAT_AFFECTION);
    expect(petAffectionBonus(50)).toBe(petAffectionBonus(PET_PATS_COUNTED));
  });

  it("earns no xp, because a level must not flap as a reaction toggles", () => {
    const snap = petSnapshot(BIRTH, [], BIRTH, PET_PATS_COUNTED);
    expect(snap.xp).toBe(0);
    expect(snap.level).toBe(1);
  });

  it("has ceilings that CLOSE, so a full bonus can never reach the top of the bar", () => {
    // Nothing but a pat raises affection and it only decays, so the most a pet can hold is its
    // genesis bond plus every counted pat. Move either constant and this fails rather than shipping
    // a bar that reads full for a creature nobody has fed in a week.
    expect(PET_GENESIS.affection + PET_PATS_COUNTED * PET_PAT_AFFECTION).toBeLessThan(100);
    expect(petSnapshot(BIRTH, [], BIRTH, PET_PATS_COUNTED).stats.affection).toBe(95);
  });

  it("says nothing at all when nobody has reacted", () => {
    expect(petAffectionBonus(0)).toBe(0);
    expect(petSnapshot(BIRTH, [], BIRTH, 0)).toEqual(petSnapshot(BIRTH, [], BIRTH));
  });
});

describe("needing something", () => {
  it("is quiet while everything is fine", () => {
    expect(petNeedsSomething(petSnapshot(BIRTH, [], BIRTH).stats)).toBe(false);
  });

  it("speaks up once one stat is low", () => {
    expect(petNeedsSomething(petSnapshot(BIRTH, [], at(30)).stats)).toBe(true);
  });
});

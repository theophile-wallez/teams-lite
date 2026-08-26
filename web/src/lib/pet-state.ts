/**
 * WHAT A PET IS RIGHT NOW — and every number in it is DERIVED, never sent.
 *
 * This is the module the whole feature rests on. Decay is a **pure function of elapsed time**, so
 * two machines holding the same acts hold the same creature: hunger is never a value anybody
 * publishes, it is `petSnapshot(birth, acts, now)`. That is what lets a shared pet cost a few
 * writes a day instead of one a frame, and it is why the wire (pet-wire.ts) carries acts and
 * nothing else.
 *
 * **EVERY RATE HERE IS MEASURED**, off openpets' own virtual-pet plugin
 * (plugins/official/openpets.virtual-pet/index.js), rather than invented. They are quoted in the
 * constants below with what they add up to, because the shape of the game is in the arithmetic: it
 * takes 50 hours of neglect to starve a pet and 33 to exhaust one, which is what makes a creature
 * three people share survive a weekend nobody looks at it.
 *
 * **THE BOUND ON THE LEDGER IS SAFE BECAUSE OF THIS FILE.** Stats clamp to 0…100 and reach their
 * floor in about 50 hours, so an act a week old moves the answer by nothing a reader could see —
 * which is what makes `PET_ACTS_KEPT` a correctness-preserving bound rather than a lossy one.
 */

/** The four stats, each 0…100. openpets' own set, and its own HUD names: Food, Energy, Play, Bond. */
export type PetStats = { hunger: number; energy: number; happiness: number; affection: number };

/** What a pet is feeling, first match wins. `sleeping` is a state rather than a mood, and it wins
 *  over everything because a pet nobody can wake has nothing to say about being hungry. */
export type PetMood = "sleeping" | "hungry" | "tired" | "bored" | "happy" | "content";

/**
 * An act as the FOLD sees it — exactly the wire's three, because **A PAT IS NOT AN ACT IN TIME.**
 *
 * A pat is a Teams REACTION on the pet's own message, and the page is never handed enough to fold
 * one: `Reaction` carries a key, a count and the reactors' NAMES, with no timestamp and no MRI at
 * all (§ WHO reacted deliberately withholds the MRIs — one answer about a name in this app). So
 * there is no moment to age a pat from and nobody to attribute it to, and a fold that invented
 * either would be two machines inventing two different creatures.
 *
 * What a pat is instead is a STANDING TERM, added to affection after the fold — see
 * `petAffectionBonus` and the two costs stated there.
 */
export type PetFoldAct = { at: number; kind: "feed" | "play" | "nap" };

/** What a pet is born with. Affection starts LOW on purpose — a bond is the one stat you earn. */
export const PET_GENESIS: PetStats = { hunger: 80, energy: 80, happiness: 80, affection: 50 };

/** Per HOUR, awake. From FULL: 50 h to starve, 33.3 h to exhaust, 50 h to bore — and 100 h to
 *  forget, since affection is the one stat that falls a single point an hour. From the GENESIS
 *  values above it is 40 h, 26.7 h, 40 h and 50 h, and that 50 is the number the
 *  {@link PET_ACTS_KEPT} bound is argued against: a creature nobody touches goes flat inside two
 *  days on the other three and inside four on AFFECTION from full — both well under a week, which
 *  is the only comparison the bound needs, so an act a week old moves the fold by nothing.
 *  (An earlier note here said "50 h to forget" FROM FULL, which is affection's genesis figure
 *  standing in the full-stat sentence.) */
export const PET_DECAY_AWAKE: PetStats = { hunger: -2, energy: -3, happiness: -2, affection: -1 };

/** Per HOUR, asleep. Energy is the only thing sleep buys, and it buys a lot of it: a 15-minute nap
 *  is worth about 3.75 energy on top of the 40 the act itself gives. */
export const PET_DECAY_ASLEEP: PetStats = { hunger: -2, energy: 15, happiness: -0.5, affection: 0 };

/** How long a nap lasts. */
export const PET_NAP_MS = 15 * 60_000;

/**
 * What each act does, and what it is worth. **PLAY IS THE ONLY ACT WITH A COST.**
 *
 * A pat is not in here, and could not be: an effect in this table is applied at a MOMENT, and a pat
 * has none (see `PetFoldAct`, and `petAffectionBonus` for what it does instead).
 */
export const PET_ACT_EFFECTS: Record<PetFoldAct["kind"], Partial<PetStats> & { xp: number }> = {
  feed: { hunger: 25, xp: 5 },
  play: { happiness: 25, energy: -15, xp: 5 },
  nap: { energy: 40, xp: 5 },
};

/** What one pat is worth in affection — the bond is the stat a pat is about. */
export const PET_PAT_AFFECTION = 15;

/** How many pats count. A pet three people share collects reactions from all of them, and an
 *  unbounded term would make the bond a popularity count rather than something the creature's own
 *  history earns: three is the whole of the bonus, and the fold pays for the rest. */
export const PET_PATS_COUNTED = 3;

/**
 * What a pet's pats add to its affection.
 *
 * **THREE COSTS, all stated here rather than discovered.** A reaction is a live SET and not a log,
 * so **un-reacting takes the pat back** and the pet's bond drops — the one interaction here with an
 * undo at all, and consistent across machines precisely because every one of them folds the same
 * set. **A pat earns NO xp**: a standing term would make a level flap up and down as somebody
 * toggled a reaction, and a level that comes and goes is not a level. And it **SILENCES the bond as
 * a complaint**: two pats put the floor at `PET_LOW` exactly and three put it above, so a pet with
 * a couple of reactions on its message can never again be one `petNeedsSomething` speaks up about
 * for affection. That is the deliberate shape — a bond somebody keeps reaffirming is not a problem
 * — and it is why the three counted pats stop well short of the ceiling rather than filling the bar.
 */
export function petAffectionBonus(pats: number): number {
  return Math.min(pats, PET_PATS_COUNTED) * PET_PAT_AFFECTION;
}

/** Under this, a stat is a problem the pet will say something about. */
export const PET_LOW = 30;

/** The mean of all four a pet has to clear to be outright happy rather than merely content. */
export const PET_HAPPY_MEAN = 75;

/** Level N costs N × this, so level 2 is ten feeds — and no number of pats, which earn none (see
 *  `petAffectionBonus`). Unbounded on purpose: there is no end state to a creature three people
 *  keep. */
export const PET_LEVEL_COST = 50;

/** Everything a surface needs about a pet at one instant. */
export type PetSnapshot = {
  stats: PetStats;
  mood: PetMood;
  level: number;
  xp: number;
  /** When it wakes, or 0 when it is awake. */
  asleepUntil: number;
};

const STATS: (keyof PetStats)[] = ["hunger", "energy", "happiness", "affection"];

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Age a pet from one moment to the next.
 *
 * The span is SPLIT into the part inside a nap and the part outside it, because sleep runs its own
 * rates — openpets' own `applyDecay`. A span that ends before it starts (two machines' clocks, or
 * an act the fold has already passed) ages nothing rather than ageing backwards.
 */
function aged(stats: PetStats, from: number, to: number, asleepUntil: number): PetStats {
  const span = to - from;
  if (span <= 0) return stats;
  const asleepMs = Math.max(0, Math.min(to, asleepUntil) - from);
  const awakeMs = span - asleepMs;
  const out = { ...stats };
  for (const key of STATS) {
    out[key] = clamp(
      out[key] +
        (PET_DECAY_ASLEEP[key] * asleepMs) / 3_600_000 +
        (PET_DECAY_AWAKE[key] * awakeMs) / 3_600_000,
    );
  }
  return out;
}

/** Spend xp into levels. Loops, so one act can carry a pet through more than one level. */
function levelled(level: number, xp: number): { level: number; xp: number } {
  let l = Math.max(1, level);
  let x = Math.max(0, xp);
  while (x >= l * PET_LEVEL_COST) {
    x -= l * PET_LEVEL_COST;
    l += 1;
  }
  return { level: l, xp: x };
}

/**
 * Fold a pet: born at `birth`, everything that has happened to it, read at `now`.
 *
 * **THE ORDER MATTERS AND THAT IS WHY THIS IS A FOLD RATHER THAN A SUM.** Feeding a pet and then
 * neglecting it for two days is not the same creature as neglecting it for two days and then
 * feeding it — the clamp at 0 and at 100 loses whatever fell outside. So the walk ages the pet to
 * each act, applies it, and ages it once more to now.
 *
 * An act BEFORE the pet was born, or one dated in the FUTURE, is refused: the moment in a ledger
 * act is the actor's own clock, and the ceiling is what both machines can derive. That is the rule
 * `chessClockCeilingMs` holds for a self-reported clock, applied to a self-reported moment. **THIS
 * IS THE ONE PLACE THAT REFUSES ONE** — `petsInThread` leaves such an act in the pet's list on
 * purpose, because two refusal sites are two chances to disagree about which acts count.
 *
 * `pats` is the count of the pat reaction on the pet's own message, applied LAST as a standing term
 * rather than folded (see `petAffectionBonus`). It is optional because a surface that has not
 * resolved one yet — a preview, a test of the decay alone — should understate the bond rather than
 * invent it.
 */
export function petSnapshot(
  birth: number,
  acts: PetFoldAct[],
  now: number,
  pats = 0,
): PetSnapshot {
  let stats = { ...PET_GENESIS };
  let xp = 0;
  let level = 1;
  let asleepUntil = 0;
  let at = birth;

  const applied = acts
    .filter((a) => Number.isFinite(a.at) && a.at >= birth && a.at <= now)
    .sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind));

  for (const act of applied) {
    stats = aged(stats, at, act.at, asleepUntil);
    at = act.at;
    const effect = PET_ACT_EFFECTS[act.kind];
    for (const key of STATS) {
      const delta = effect[key];
      if (delta !== undefined) stats[key] = clamp(stats[key] + delta);
    }
    // Every act but a nap WAKES the pet, which is openpets' own rule and the reason a nap is the
    // one act you cannot interrupt with a snack.
    asleepUntil = act.kind === "nap" ? act.at + PET_NAP_MS : 0;
    ({ level, xp } = levelled(level, xp + effect.xp));
  }

  stats = aged(stats, at, now, asleepUntil);
  // The pats go on AFTER the last ageing, because a standing term is not a moment in the history:
  // folded in at some invented instant it would decay away, and a pet whose reactions are still on
  // its message would read as one nobody had ever patted. The MOOD sees the bonus, since a pet
  // three people keep reacting to really is a happier creature.
  stats.affection = clamp(stats.affection + petAffectionBonus(pats));
  return { stats, mood: petMood(stats, asleepUntil, now), level, xp, asleepUntil };
}

/**
 * The mood ladder, first match wins.
 *
 * It is an ORDER rather than a score because the pet has to say ONE thing, and "hungry" is more
 * actionable than "a bit low on three counts". openpets' own thresholds.
 */
export function petMood(stats: PetStats, asleepUntil: number, now: number): PetMood {
  if (now < asleepUntil) return "sleeping";
  if (stats.hunger < PET_LOW) return "hungry";
  if (stats.energy < PET_LOW) return "tired";
  if (stats.happiness < PET_LOW) return "bored";
  const mean = STATS.reduce((sum, key) => sum + stats[key], 0) / STATS.length;
  return mean >= PET_HAPPY_MEAN ? "happy" : "content";
}

/** Whether anything is low enough that the pet should say so. */
export function petNeedsSomething(stats: PetStats): boolean {
  return STATS.some((key) => stats[key] < PET_LOW);
}

/** How far through the current level, 0…1 — what a bar draws. */
export function petLevelProgress(snapshot: PetSnapshot): number {
  return Math.min(1, snapshot.xp / (snapshot.level * PET_LEVEL_COST));
}

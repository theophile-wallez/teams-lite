import { describe, expect, it } from "vitest";
import {
  CHESS_DEFAULT_TIME,
  chessClockCeilingMs,
  chessClockReading,
  chessClockTickMs,
  chessFlagIsFair,
  chessRemainingAfterMove,
  chessThinkStartedAt,
  formatChessClock,
  PREMOVE_SPEND_MS,
  type ChessClockState,
} from "./chess-clock";

const T0 = 1_700_000_000_000;

/** A ten-minute game somebody accepted at T0, with nobody having moved. */
function state(over: Partial<ChessClockState> = {}): ChessClockState {
  return {
    time: CHESS_DEFAULT_TIME,
    stated: { w: null, b: null },
    actedAt: { w: null, b: null },
    startedAt: T0,
    turn: "w",
    settled: false,
    live: true,
    ...over,
  };
}

describe("chessClockReading", () => {
  it("is two nulls in a game with NO clock, which is every game played before this", () => {
    const reading = chessClockReading(state({ time: null }), T0 + 60_000);
    expect(reading).toEqual({ white: null, black: null, running: null, flagged: null });
  });

  it("holds two full clocks, neither running, while nobody has accepted", () => {
    const reading = chessClockReading(state({ live: false }), T0 + 60_000);
    expect(reading.white).toBe(600_000);
    expect(reading.black).toBe(600_000);
    // Nobody is on the clock in a game nobody joined: a challenge left open overnight must not
    // lose on time before it was ever a game.
    expect(reading.running).toBeNull();
  });

  it("counts the FIRST move down from the moment the game was accepted", () => {
    const reading = chessClockReading(state(), T0 + 10_000);
    expect(reading.white).toBe(590_000);
    expect(reading.black).toBe(600_000);
    expect(reading.running).toBe("w");
  });

  it("counts the side to move down from the moment their OPPONENT acted", () => {
    // White played at T0+10s with 9:50 left; black is thinking from there.
    const reading = chessClockReading(
      state({
        stated: { w: 590_000, b: null },
        actedAt: { w: T0 + 10_000, b: null },
        turn: "b",
      }),
      T0 + 25_000,
    );
    // Black has spent 15s of their own ten minutes; white's is frozen where they left it.
    expect(reading.black).toBe(585_000);
    expect(reading.white).toBe(590_000);
    expect(reading.running).toBe("b");
  });

  it("freezes BOTH clocks once a message has ended the game", () => {
    const reading = chessClockReading(
      state({
        stated: { w: 590_000, b: 400_000 },
        actedAt: { w: T0 + 10_000, b: T0 + 20_000 },
        settled: true,
      }),
      T0 + 10_000_000,
    );
    expect(reading.white).toBe(590_000);
    expect(reading.black).toBe(400_000);
    expect(reading.running).toBeNull();
  });

  it("says whose clock is OUT, and stops calling it running", () => {
    const reading = chessClockReading(
      state({ stated: { w: 5_000, b: null }, actedAt: { w: null, b: T0 }, turn: "w" }),
      T0 + 30_000,
    );
    expect(reading.white).toBe(0);
    expect(reading.flagged).toBe("w");
    // Nothing counts down past zero, and nothing here ends the game either — a flag is CLAIMED.
    expect(reading.running).toBeNull();
  });

  it("draws the two clocks as STATED when no moment says where to count from", () => {
    // A ledger from a build that wrote no `at:`. A countdown from "now" would restart on every
    // reload and every reader would see a different number, which is worse than a still clock.
    const reading = chessClockReading(
      state({ startedAt: null, stated: { w: 300_000, b: 200_000 } }),
      T0 + 60_000,
    );
    expect(reading).toEqual({ white: 300_000, black: 200_000, running: null, flagged: null });
  });
});

describe("chessThinkStartedAt", () => {
  it("is the opponent's own last act, and the accept before either side has moved", () => {
    expect(chessThinkStartedAt(state())).toBe(T0);
    expect(
      chessThinkStartedAt(state({ turn: "b", actedAt: { w: T0 + 9_000, b: null } })),
    ).toBe(T0 + 9_000);
  });
});

describe("chessRemainingAfterMove", () => {
  it("charges the time that really passed, and adds the increment after it", () => {
    const left = chessRemainingAfterMove({
      time: { base: 600, increment: 2 },
      stated: 600_000,
      thinkStartedAt: T0,
      nowMs: T0 + 12_000,
    });
    expect(left).toBe(590_000);
  });

  it("charges a PREMOVE a tenth of a second, whatever the wall clock says", () => {
    // The opponent thought for four minutes; the reader's move was already decided.
    const left = chessRemainingAfterMove({
      time: CHESS_DEFAULT_TIME,
      stated: 600_000,
      thinkStartedAt: T0,
      nowMs: T0 + 240_000,
      premove: true,
    });
    expect(left).toBe(600_000 - PREMOVE_SPEND_MS);
  });

  it("states ZERO and no increment for a move played past the flag", () => {
    const left = chessRemainingAfterMove({
      time: { base: 600, increment: 5 },
      stated: 3_000,
      thinkStartedAt: T0,
      nowMs: T0 + 9_000,
    });
    // Handing five seconds to the move that took them past zero would undo the flag.
    expect(left).toBe(0);
  });

  it("is null in a game with no clock, which is what a ledger then states", () => {
    expect(
      chessRemainingAfterMove({ time: null, stated: 0, thinkStartedAt: T0, nowMs: T0 }),
    ).toBeNull();
  });
});

describe("chessFlagIsFair", () => {
  const running = state({
    stated: { w: 5_000, b: 300_000 },
    actedAt: { w: null, b: T0 },
    turn: "w",
  });

  it("believes a claim the arithmetic agrees with", () => {
    expect(chessFlagIsFair(running, { by: "b", color: "w", at: T0 + 30_000 })).toBe(true);
  });

  it("refuses a claim made before the clock was really out", () => {
    expect(chessFlagIsFair(running, { by: "b", color: "w", at: T0 + 2_000 })).toBe(false);
  });

  it("refuses a claim against the player who is NOT on the clock", () => {
    expect(chessFlagIsFair(running, { by: "w", color: "b", at: T0 + 30_000 })).toBe(false);
  });

  it("refuses a claim on one's OWN clock, and one that names no moment", () => {
    expect(chessFlagIsFair(running, { by: "w", color: "w", at: T0 + 30_000 })).toBe(false);
    expect(chessFlagIsFair(running, { by: "b", color: "w", at: null })).toBe(false);
  });

  it("refuses one in a game with no clock and in a game nobody accepted", () => {
    expect(
      chessFlagIsFair({ ...running, time: null }, { by: "b", color: "w", at: T0 + 30_000 }),
    ).toBe(false);
    expect(
      chessFlagIsFair({ ...running, live: false }, { by: "b", color: "w", at: T0 + 30_000 }),
    ).toBe(false);
  });
});

describe("formatChessClock", () => {
  it("reads the way a chess clock reads, and counts tenths at the sharp end", () => {
    expect(formatChessClock(600_000)).toBe("10:00");
    expect(formatChessClock(65_000)).toBe("1:05");
    expect(formatChessClock(20_000)).toBe("0:20");
    // Below twenty seconds whole seconds tell somebody nothing about whether they can move.
    expect(formatChessClock(19_900)).toBe("19.9");
    expect(formatChessClock(1_050)).toBe("1.0");
    expect(formatChessClock(0)).toBe("0.0");
    expect(formatChessClock(null)).toBe("—");
  });

  it("never counts a second that has not finished, so 0:01 is not shown at 0:00.4", () => {
    // Ceiling above the tenths threshold: a clock reading 1:00 must not be 59.6 seconds.
    expect(formatChessClock(59_600)).toBe("1:00");
  });
});

describe("chessClockTickMs", () => {
  it("redraws four times a second, and ten times below twenty seconds", () => {
    expect(chessClockTickMs({ white: 600_000, black: 1, running: "w", flagged: null })).toBe(250);
    expect(chessClockTickMs({ white: 5_000, black: 1, running: "w", flagged: null })).toBe(100);
    // Nothing is running, so nothing has to be redrawn at all.
    expect(chessClockTickMs({ white: 600_000, black: 1, running: null, flagged: null })).toBe(0);
  });
});

describe("chessClockCeilingMs", () => {
  it("is the most a side could possibly have, from the ledger alone", () => {
    // A ten-minute game with no increment: ten minutes, whatever anybody claims.
    expect(chessClockCeilingMs({ base: 600, increment: 0 }, 40)).toBe(600_000);
    // With an increment, one per move THEY made.
    expect(chessClockCeilingMs({ base: 180, increment: 2 }, 10)).toBe(200_000);
    expect(chessClockCeilingMs(null, 10)).toBe(0);
  });

  it("CLAMPS a stated clock that no arithmetic could have reached", () => {
    // A player states twenty minutes in a ten-minute game. Both machines hold the same numbers,
    // so both clamp it the same way — it is a ceiling rather than a claim about who is honest.
    const reading = chessClockReading(
      state({
        stated: { w: 1_200_000, b: null },
        actedAt: { w: T0, b: T0 + 5_000 },
        plies: { w: 1, b: 1 },
        turn: "w",
      }),
      T0 + 5_000,
    );
    expect(reading.white).toBe(600_000);
  });
});

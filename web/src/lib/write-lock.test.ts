// The page's half of "can this window act at all". See lib/write-lock.ts for the failure
// it covers: every read answers, every outward action is refused, and the app looks fine.
import { describe, expect, test } from "vitest";
import {
  parseWriteLock,
  UNKNOWN_WRITE_LOCK,
  writeLockNeedsAttention,
  type WriteLock,
} from "./protocol";
import { writeLockNotice } from "./write-lock";

describe("parseWriteLock", () => {
  test("reads the three states the backend states", () => {
    expect(parseWriteLock({ state: "held", pinned: true })).toEqual({
      state: "held",
      pinned: true,
    });
    expect(parseWriteLock({ state: "foreign", pinned: false })).toEqual({
      state: "foreign",
      pinned: false,
    });
    expect(parseWriteLock({ state: "read_only", pinned: false }).state).toBe("read_only");
  });

  // An older backend refuses the method outright and never reaches here; a newer field we
  // do not know must not become a state we act on.
  test("anything else is unknown", () => {
    for (const raw of [undefined, null, 3, "held", {}, { state: "ok" }, { state: null }]) {
      expect(parseWriteLock(raw)).toEqual(UNKNOWN_WRITE_LOCK);
    }
  });

  test("pinned is only what was stated", () => {
    expect(parseWriteLock({ state: "foreign" }).pinned).toBe(false);
    expect(parseWriteLock({ state: "foreign", pinned: "yes" }).pinned).toBe(false);
  });
});

describe("writeLockNeedsAttention", () => {
  // Only `foreign`. A page that has not asked yet, one talking to a backend too old to
  // answer, and a deliberately read-only backend are all silence — a banner that appears
  // by default is worse than the bug it guesses at, which is the rule the broker banner
  // already follows.
  test("only a foreign token is worth a banner", () => {
    expect(writeLockNeedsAttention({ state: "foreign", pinned: true })).toBe(true);
    expect(writeLockNeedsAttention({ state: "foreign", pinned: false })).toBe(true);
    expect(writeLockNeedsAttention({ state: "held", pinned: true })).toBe(false);
    expect(writeLockNeedsAttention({ state: "read_only", pinned: false })).toBe(false);
    expect(writeLockNeedsAttention(UNKNOWN_WRITE_LOCK)).toBe(false);
    expect(writeLockNeedsAttention(null)).toBe(false);
    expect(writeLockNeedsAttention(undefined)).toBe(false);
  });
});

describe("writeLockNotice", () => {
  test("says nothing whenever the state is not worth a banner", () => {
    const quiet: WriteLock[] = [
      { state: "held", pinned: true },
      { state: "read_only", pinned: false },
      UNKNOWN_WRITE_LOCK,
    ];
    for (const lock of quiet) expect(writeLockNotice(lock)).toBeNull();
    expect(writeLockNotice(null)).toBeNull();
  });

  // The reader is told what they cannot do, never that a token comparison failed: the
  // sentence has to work for somebody who has never heard of the write lock.
  test("names what the reader cannot do, in both causes", () => {
    for (const pinned of [true, false]) {
      const notice = writeLockNotice({ state: "foreign", pinned });
      expect(notice?.title).toBe("This window can read, but not send");
      expect(notice?.message.toLowerCase()).toContain("refuse");
      expect(notice?.hint).toContain("check again");
      expect(notice?.message).not.toContain("write_token");
    }
  });

  // Two causes, two ways out, and only `pinned` tells them apart: a pinned token is in no
  // file, so nothing this app reads would ever match and another instance has to go.
  test("a pinned token blames the other instance; a published one blames this app", () => {
    const owned = writeLockNotice({ state: "foreign", pinned: true });
    expect(owned?.message).toContain("Another teams-lite instance");
    expect(owned?.hint).toContain("Stop the other instance");

    const wrongSource = writeLockNotice({ state: "foreign", pinned: false });
    expect(wrongSource?.message).toContain("This app is handing this window");
    expect(wrongSource?.hint).toContain("Restart the app");
  });
});

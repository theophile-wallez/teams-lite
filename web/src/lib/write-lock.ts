// What to SAY when this page holds a write token its backend does not accept.
//
// The state itself comes from the backend (`WriteLock` in lib/protocol.ts, over
// `write_lock_status` in src/bin/server.rs). This is the half the reader acts on, and it
// is kept out of the component for the usual reason: the wording is what has to be pinned
// by a test, and a sentence inside JSX is a sentence nobody checks.
//
// WHY IT IS WORTH A BANNER. In this state every read answers and every outward action is
// refused: the sidebar fills, the history scrolls, the live dot is green, and the composer
// only chimes. It reached a user as "Update failed — try again", which sent them looking at
// their network and at the release. The app has to say the true thing instead, and say it
// before the next click rather than after it.

import { writeLockNeedsAttention, type WriteLock } from "./protocol";

export type WriteLockNotice = {
  /** What is wrong, from the reader's side: not "the token mismatched" but what they
   *  cannot do. */
  title: string;
  /** Why, in one sentence. */
  message: string;
  /** The one thing that mends it, which is never something this page can do itself. */
  hint: string;
};

/** The notice for a write-lock state, or null when there is nothing to say (see
 *  {@link writeLockNeedsAttention}: a healthy page, an unanswered one and a deliberately
 *  read-only backend are all silence). */
export function writeLockNotice(lock: WriteLock | null | undefined): WriteLockNotice | null {
  if (!writeLockNeedsAttention(lock) || !lock) return null;
  const title = "This window can read, but not send";
  // A PINNED token was handed to that backend by the launcher that spawned it and was
  // published nowhere, so no file holds the right one: another instance owns the backend,
  // and nothing this page reads would ever match. A PUBLISHED one is readable, so the
  // fault is on this side — this app is serving a token that is not that backend's, which
  // only a restart of the app re-reads.
  return lock.pinned
    ? {
        title,
        message:
          "Another teams-lite instance owns the backend this window talks to, so it refuses " +
          "everything this window would do as you — a message, a reaction, marking a chat " +
          "read, an update.",
        hint:
          "Stop the other instance, then check again. Two instances can also run side by " +
          "side, each with a backend of its own.",
      }
    : {
        title,
        message:
          "This app is handing this window a write token that its backend does not accept, " +
          "so every message, reaction, read marker and update is refused.",
        hint: "Restart the app so it reads that backend's own token, then check again.",
      };
}

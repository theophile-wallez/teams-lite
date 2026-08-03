import { useEffect, useState } from "react";
import type { PersonPresence } from "~/lib/protocol";
import { useController } from "./controller-context";

/**
 * One person's live presence, read through the controller (which batches and
 * briefly caches it — see `loadPresence`). The single place a React view fetches
 * presence, so the person card and the chat header behave the same way.
 *
 * `undefined` means "not known yet" (nothing requested, or the lookup is still in
 * flight) and `null` means "the service has no answer", which the presence helpers
 * both render as the unknown tone. A view that must not assert a state too early
 * checks for `undefined` before it renders anything.
 *
 * Pass `undefined` as the MRI to fetch nothing — that is how a lazily opened
 * surface (a hover card) stays free until it opens.
 */

/** How often a `refresh: true` reader re-reads. Matches the store's own presence
 *  TTL, so a tick is a real round-trip rather than the same cached answer. */
const REFRESH_MS = 30_000;

export function usePresence(
  mri: string | undefined,
  opts?: {
    /** Keep the value fresh while mounted, for a surface that stays on screen (a
     *  chat header). A transient surface leaves it off and reads once. */
    refresh?: boolean;
  },
): PersonPresence | null | undefined {
  const controller = useController();
  const refresh = opts?.refresh ?? false;
  // The MRI the value belongs to is stored WITH it, so switching person reads as
  // "not known yet" instead of briefly showing the previous person's state.
  const [entry, setEntry] = useState<{ mri: string; value: PersonPresence | null } | null>(null);

  useEffect(() => {
    if (!mri) return;
    let alive = true;
    const read = () => {
      controller
        .loadPresence(mri)
        .then((value) => alive && setEntry({ mri, value }))
        .catch(() => alive && setEntry({ mri, value: null }));
    };
    read();
    if (!refresh) {
      return () => {
        alive = false;
      };
    }
    const timer = setInterval(read, REFRESH_MS);
    // A background tab has its timers throttled, so the value on screen when the
    // user comes back can be minutes old: re-read the moment the tab is shown.
    const onVisibility = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [controller, mri, refresh]);

  if (!mri) return undefined;
  return entry && entry.mri === mri ? entry.value : undefined;
}

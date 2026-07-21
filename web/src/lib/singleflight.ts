// Coalesce repeated async work into a single in-flight run plus at most one
// trailing re-run. Ported verbatim from ui/src/singleflight.ts.
//
// Some backend events trigger a refresh which — via the backend — can trigger
// another event, which triggers another refresh. Mapping every event 1:1 to a
// full refetch lets a burst (or feedback loop) amplify into many concurrent
// refreshes. `coalesce` caps concurrency at one: any triggers fired while a run
// is active collapse into exactly ONE follow-up run once the current settles.
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  let again = false;

  return async function trigger(): Promise<void> {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    try {
      do {
        again = false;
        await run();
      } while (again);
    } finally {
      inFlight = false;
    }
  };
}

// Coalesce repeated async work into a single in-flight run plus at most one
// trailing re-run.
//
// Why this exists: some backend events trigger a refresh which — via the
// backend — can trigger another event, which triggers another refresh. Mapping
// every event 1:1 to a full refetch + re-render lets a burst (or a feedback
// loop) amplify into many concurrent refreshes that saturate the single-threaded
// UI event loop and freeze the terminal. `coalesce` caps concurrency at one: any
// number of triggers fired while a run is active collapse into exactly ONE
// follow-up run once the current one settles, so the newest state is always
// fetched without stacking work.
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  let again = false;

  return async function trigger(): Promise<void> {
    if (inFlight) {
      // A run is already active; record that state changed again so we do
      // exactly one more pass when it finishes, instead of starting a new run.
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

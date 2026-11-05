// What a RELOAD would throw away, asked of the surfaces that hold it.
//
// The page reloads on its own when a sign-in in front of it expires (lib/auth-wall.ts), and a
// reload keeps only what lives outside the page: the conversation's own draft is the backend's —
// but only up to the moment its socket was refused — while a thread's draft, a typed post title and
// pasted pictures live in this page and nowhere else. Those are held by the composers, as component
// state the store cannot see, so each composer REPORTS whether it holds any. The store asks before
// it reloads, and asks the reader instead when the answer is yes.

type Reporter = () => boolean;

const reporters = new Set<Reporter>();

/** Report, for as long as the caller lives, whether it holds work a reload would lose. */
export function reportUnsentWork(reporter: Reporter): () => void {
  reporters.add(reporter);
  return () => {
    reporters.delete(reporter);
  };
}

/** Whether any surface holds work a reload would lose. A reporter that throws counts as yes:
 *  being wrong in that direction costs the reader one press, the other direction their words. */
export function hasUnsentWork(): boolean {
  for (const reporter of reporters) {
    try {
      if (reporter()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

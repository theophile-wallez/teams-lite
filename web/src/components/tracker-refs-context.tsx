import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppState } from "./controller-context";
import type { TrackerVocabulary } from "~/lib/tracker-ref";

/**
 * The vocabulary every rendered body reads tracker references with (see lib/tracker-ref.ts):
 * the configured GitLab host, the Linear workspace this machine's key belongs to, and the
 * project the surface is about.
 *
 * A CONTEXT rather than a prop, because the answer belongs to the app rather than to any one
 * caller — it is two settings — and because a reference is drawn on nearly every surface
 * there is: a message body, a reply quote, a card, an agent's answer, a merge request's
 * description, a comment on a diff line. Threading two fields through all of them would be
 * eight chances to forget one, and the surface that forgot would be the one where a
 * reference silently stayed a word.
 *
 * The default is NULL, and that is load-bearing: {@link RichNodes} renders identically
 * without a provider, so the body renderer stays a pure function of its props for the unit
 * tests that server-render it with no app around them. No vocabulary means no chip, which is
 * exactly what a machine with no GitLab host and no Linear key gets.
 */
const TrackerVocabularyContext = createContext<TrackerVocabulary | null>(null);

/** The vocabulary in force here, or null when nothing can be recognised. */
export function useTrackerVocabulary(): TrackerVocabulary | null {
  return useContext(TrackerVocabularyContext);
}

/**
 * The app-level provider: what THIS MACHINE can recognise, read from the settings it already
 * holds.
 *
 * Placed once, above the whole shell, for the reason the context exists. It names no project:
 * a bare `!42` in a chat message is resolved from that message's own links (see
 * `projectNamedIn`), and the surfaces that ARE about one merge request add it themselves
 * ({@link TrackerProjectProvider}).
 */
export function TrackerRefsProvider(props: { children: ReactNode }) {
  const gitlabHost = useAppState((s) => s.settings.gitlab_host);
  const linear = useAppState((s) => s.linearWorkspace);
  const vocabulary = useMemo<TrackerVocabulary>(
    () => ({ gitlabHost, linear }),
    [gitlabHost, linear],
  );
  return (
    <TrackerVocabularyContext.Provider value={vocabulary}>
      {props.children}
    </TrackerVocabularyContext.Provider>
  );
}

/**
 * The same vocabulary with the project this surface is about put on it — the open merge
 * request, on the page and on its diff.
 *
 * It is what makes a bare `!42` in a description or a comment mean THIS project, which is
 * GitLab's own rule for a reference written inside one. Everything else about the vocabulary
 * is kept, so a page that names a project still recognises a Linear identifier.
 *
 * Drawn outside a provider it adds nothing: with no machine vocabulary there is nothing to
 * add a project to, and a page that could recognise `!42` but not address it would be worse
 * than one that leaves the words alone.
 */
export function TrackerProjectProvider(props: {
  project: string | null | undefined;
  children: ReactNode;
}) {
  const outer = useTrackerVocabulary();
  const vocabulary = useMemo(
    () => (outer ? { ...outer, project: props.project ?? null } : null),
    [outer, props.project],
  );
  return (
    <TrackerVocabularyContext.Provider value={vocabulary}>
      {props.children}
    </TrackerVocabularyContext.Provider>
  );
}

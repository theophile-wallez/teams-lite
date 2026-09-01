import { createContext, useContext, useMemo, type ReactNode } from "react";
import { codeVocabulary, NO_CODE_VOCABULARY, type CodeVocabulary } from "~/lib/gitlab-review-code";
import type { GitLabDiff } from "~/lib/gitlab-diff";
import type { PierreSide } from "~/lib/gitlab-diff-comment";

// What a NAME chip in the reading's prose is drawn against, and where its press goes.
//
// It is a context and not a prop, and the reason is narrow: the chip is a LEAF inside a parsed
// markdown tree, several levels below anything that knows about a merge request, so a prop would
// have to be threaded through `RichNodes` and every element it renders to reach it. What the
// context carries is exactly what that leaf must not fetch for itself — the diff to search, and
// where a press goes.
//
// **IT IS DELIBERATELY NOT READ BY `RichNodes`, and that is the opposite choice from
// `tracker-refs-context.tsx`.** That context is read by the seam itself, and its own header gives
// two reasons: the answer belongs to the app rather than to any one caller ("it is two settings"),
// and a reference is drawn on nearly every surface there is. Neither holds here. This answer is ONE
// page's diff read and the surface is ONE route — so the MARKING is done by the four memos that
// already parse this prose (see `gitlab-review-page.tsx` and `gitlab-review-chat.tsx`), and only the
// CHIP reads this. `RichNodes` is called from seven places in five files and by every message bubble
// in the app through `RichContent`; putting a third marker in it would make every surface that draws
// words pay for a feature drawn on one route, and would widen the blast radius of a mistake here from
// one page to all of them.

export type ReviewCodeVocabulary = {
  /** The names the branch holds and the files it changed — everything the marking needs
   *  ({@link codeVocabulary}). */
  code: CodeVocabulary;
  /** The diff itself, which the CARD searches when it opens. The vocabulary answers "is this a name
   *  here"; only the diff can answer "where". */
  diff: GitLabDiff | null;
  /** Go to one place in the changes: that file becomes the one on screen, at that line, with the
   *  name's own occurrences panel open on it. Absent where there is nowhere to go — an SSR pass, a
   *  unit test — which is what makes the chip fall back to being read rather than pressed. */
  onGoToOccurrence?: (symbol: string, path: string, lineNumber: number, side: PierreSide) => void;
  /** Open the name's own panel on the diff page, at the first place it stands. On a coarse pointer
   *  this is the WHOLE press, because a floating card cannot be drawn there at all (see
   *  `review-code-chip.tsx`). */
  onOpenSymbol?: (symbol: string) => void;
};

const ReviewCodeContext = createContext<ReviewCodeVocabulary | null>(null);

/** What a chip reads, or `null` where names are not marked at all — every surface but the reading. */
export function useReviewCode(): ReviewCodeVocabulary | null {
  return useContext(ReviewCodeContext);
}

/**
 * Provide the vocabulary for one merge request's reading.
 *
 * The vocabulary is memoized on the DIFF OBJECT, which is the one thing that decides it. The diff
 * arrives as fresh JSON from a background read several times a minute, so it really does rebuild
 * then — and that is the honest cost: one pass over the patch text the page already walks per render
 * for its own line counts, with no allocation per character.
 */
export function ReviewCodeProvider(props: {
  diff: GitLabDiff | null;
  /** Whether there is a READING to mark. With none there is no prose on this page that names
   *  anything, so tokenizing the diff would be a walk over every patch line for nobody — and the
   *  reader who has not pressed Read yet is exactly the reader looking at the offer. */
  hasReview: boolean;
  onGoToOccurrence?: ReviewCodeVocabulary["onGoToOccurrence"];
  onOpenSymbol?: ReviewCodeVocabulary["onOpenSymbol"];
  children: ReactNode;
}) {
  const { diff, hasReview, onGoToOccurrence, onOpenSymbol } = props;
  const code = useMemo(
    () => (hasReview ? codeVocabulary(diff) : NO_CODE_VOCABULARY),
    [diff, hasReview],
  );
  const value = useMemo<ReviewCodeVocabulary>(
    () => ({ code, diff, onGoToOccurrence, onOpenSymbol }),
    [code, diff, onGoToOccurrence, onOpenSymbol],
  );
  return <ReviewCodeContext.Provider value={value}>{props.children}</ReviewCodeContext.Provider>;
}

/** The vocabulary alone, for a caller that MARKS and never draws — which is every one of the four
 *  memos. It answers an empty vocabulary where there is none, so `markReviewCode` marks nothing and
 *  hands back the very tree it was given. */
export function useCodeVocabulary(): CodeVocabulary {
  return useReviewCode()?.code ?? NO_CODE_VOCABULARY;
}

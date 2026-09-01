import { useMemo, useState, type ReactNode } from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import {
  occurrenceSideLabel,
  symbolOccurrences,
  type SymbolOccurrence,
} from "~/lib/gitlab-diff-symbols";
import { pierreSideOf } from "~/lib/gitlab-diff-comment";
import { codePreviewMore, reviewCodePreview, type CodePreview } from "~/lib/gitlab-review-code";
import { useCoarsePointer } from "~/lib/platform";
import { cn } from "~/lib/utils";
import { useReviewCode } from "./review-code-context";

// A NAME the reading mentions, drawn as the code it names.
//
// The rules are in `lib/gitlab-review-code.ts` (which words) and `lib/gitlab-diff-symbols.ts`
// (where they stand). This file draws, and decides two things the library cannot: how the reader
// reaches the code, and what a card may cover.
//
// **THE TWO POINTERS GET TWO DIFFERENT ANSWERS, and the reasons are MECHANISMS rather than pixel
// counts.** An earlier draft of this comment gave two figures — a 317 px document column and a 570 px
// card — and neither was measured here; they are gone, because a number nothing measured is worth
// less than the argument it was standing in for. What is checkable is all three of these:
//
//   - THE ROOM. On a phone this page is one column, and the reading's document SHARES it with the
//     follow-up conversation (`max-h-[55%]`, gitlab-review-page.tsx). A floating card over that
//     covers the sticky heading and the paragraph the pressed name was in — the sentence that gives
//     the code its meaning — and Radix cannot shrink it to fit: `shift` and `flip` MOVE a panel, and
//     the app's own dropdown records that in as many words.
//   - A TAP CANNOT CLOSE WHAT IT OPENED. The trigger is not a `DismissableLayerBranch`, so a
//     `pointerdown` on it is OUTSIDE the content's layer; `deferPointerDownOutside` defaults false,
//     so the dismissal fires on that `pointerdown` and the `click` after it re-opens. Read in
//     `@radix-ui/react-dismissable-layer`, and it holds for an open-only handler as well as a
//     toggle, so it is structural.
//   - A HOLD COLLIDES WITH TEXT SELECTION, whose only fix in this app is `user-select: none`
//     (app.css states what a hold on words costs on each platform) — and that would make an
//     identifier the one word on the page a reader cannot copy, on the surface where copying one
//     into a grep is the commonest next move.
//
// So a coarse pointer gets a PRESS THAT NAVIGATES: to the diff page, at the first place the name
// stands. Nothing has to be closed and nothing has to be held.
//
// **AND ON A PHONE IT IS THE CODE IT LANDS ON, NOT THE LIST — say so plainly, because it is a real
// limit rather than the panel arriving late.** The diff page draws its occurrences panel only where
// there are two columns to put it beside: below `DIFF_COLUMNS_MIN_WIDTH` it is one column at a time,
// and a list of places there would be a third page competing with the two it already has (that rule
// is the panel's own, and it predates this feature). So what a phone gets from a chip is the file,
// the code, and the LINE LIT — "take me to this" rather than "show me everywhere". The one thing that
// had to change for it is which column that page opens on: it opens on the FILES, and a reader who
// pressed a NAME has already answered that question, so `gitlab-diff-page.tsx` opens on the patch
// when a name is already open. Without that the press landed on a file tree with no mention of the
// name pressed — measured, and it is what the phone spec now pins.
//
// **AND THE INLINE TARGET IS NOT GROWN.** The prose is 14 px on `leading-relaxed`, so a line box is
// 22.75 px; growing a ~16 px chip to this app's 44 px floor would add 14 px above and below, and two
// chips on adjacent lines would then have targets overlapping by 21 px — a thumb on the lower half
// of one name opening the other name's code. CLAUDE.md records that exact failure for the thread
// foot row and answers it by growing 4 px UP and 16 px DOWN, "because what is above is a real
// control"; in a paragraph there is a real control in BOTH directions, so no asymmetry is available.
// The ink's own box is the target, and that is the honest half of the trade above: a 16 px target
// that takes the reader to a full surface is fair, where a 16 px target that opens a 570 px overlay
// is not.

/** How long a pointer must rest before the card opens, and how long it may leave before it closes.
 *
 *  The person card's own two numbers, because one hover means one thing across this app — and a
 *  paragraph of prose is full of these, so a card that opened on the way past would flash at a
 *  reader whose pointer is only crossing the line. */
const OPEN_DELAY_MS = 420;
const CLOSE_DELAY_MS = 160;

export function CodeRefChip(props: { symbol: string; inCode?: boolean; children: ReactNode }) {
  const vocab = useReviewCode();
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);

  // The SEARCH runs only while the card is open, and the index has already promised it will find
  // something (see `symbolIndex`). It is keyed on the diff as well as the name, so a background
  // read that moves the diff under an open card re-answers rather than showing stale lines.
  //
  // ABOVE the early return below, because a hook may not be called conditionally — the trap the
  // tracker chip's own file states one level up (its router hook lives in a child component for
  // exactly this reason).
  const diff = vocab?.diff ?? null;
  const preview = useMemo(
    () => (open ? reviewCodePreview(symbolOccurrences(diff, props.symbol)) : null),
    [open, diff, props.symbol],
  );

  // Nowhere to point: an SSR pass, a unit test rendering this prose to a string, or any surface
  // that is not the reading. The word stays the word it is, which is the same fall-back a mention
  // with no identity and a tracker reference with no vocabulary already take.
  if (!vocab) return <>{props.children}</>;

  const ink = (
    <span
      data-testid="review-code-ref"
      data-symbol={props.symbol}
      data-in-code={props.inCode ? "yes" : "no"}
      className={cn("code-ref", props.inCode && "code-ref-bare")}
    >
      {props.children}
    </span>
  );

  // What a reader with no pointer at all is told — a screen reader, and a phone, where the press
  // navigates and no card is ever drawn. It is the one place the count is stated in words.
  const label = `${props.symbol} — in the changes on this branch`;

  if (coarse) {
    return (
      <button
        type="button"
        data-testid="review-code-press"
        aria-label={label}
        title={label}
        // Inline, so the button is the ink and adds no box of its own: `display: inline` keeps the
        // word inside the line it was written on, and a chip that became a block would break the
        // paragraph at every name.
        //
        // NO VERTICAL PADDING AND NO GROWN PSEUDO-ELEMENT. Both have been added to this line and
        // both were taken back off: the header above gives the measurement — 12–14px above and below
        // a ~16px chip makes two names on adjacent lines overlap, so a thumb on the lower half of one
        // opens the other one's code. `web/e2e/gitlab.spec.ts` proves it by HIT TEST from the INK's
        // own box rather than from this button's, which is the only way to see either of them.
        className="inline appearance-none bg-transparent p-0 text-left"
        onClick={() => vocab.onOpenSymbol?.(props.symbol)}
      >
        {ink}
      </button>
    );
  }

  return (
    <HoverCardPrimitive.Root
      open={open}
      onOpenChange={setOpen}
      openDelay={OPEN_DELAY_MS}
      closeDelay={CLOSE_DELAY_MS}
    >
      <HoverCardPrimitive.Trigger asChild>
        {/* A BUTTON, and the keyboard's whole path through this feature.
            Radix opens the card on focus, which SHOWS the code — but its content is portalled to the
            end of the body, so Tab from here goes to the next word of the document rather than into
            the card, and nothing inside it can be reached that way. A hover-only affordance is not
            acceptable for something that leads somewhere, so Enter and Space do what the coarse press
            does: go to the first place the name stands, which is the same destination the card's own
            first row offers.

            A real `button` rather than the focusable `span` `PersonHoverCard` uses, because a person
            card only ever SHOWS and this one acts. The tab stops it adds are the ones a paragraph of
            mentions already adds. */}
        <button
          type="button"
          data-testid="review-code-press"
          aria-label={label}
          title={label}
          onClick={() => vocab.onOpenSymbol?.(props.symbol)}
          className="inline appearance-none rounded-sm bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {ink}
        </button>
      </HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          data-testid="review-code-card"
          data-symbol={props.symbol}
          // THE SHELL'S OWN ESCAPE HAS TO SEE THIS LAYER. A hover card carries no `role` at all, so
          // neither `aLayerWasOpen` nor `aModalIsOpen` could match it — and on this route the app's
          // Escape calls `goToList()`, so one press would close the card AND throw the reader out of
          // the reading, taking a half-written follow-up question with it. `data-escape-layer` is
          // the third member of `watchOpenLayers`' own selector (lib/platform.ts), which is the
          // narrow fix: no role is invented, and nothing about the other two layers moves.
          data-escape-layer=""
          // BOUNDED BY RADIX'S OWN MEASUREMENTS rather than by `100vw`. Neither existing hover card
          // in this app carries either bound — the person card has none, and the update button
          // hand-rolls `calc(100vw-1.5rem)`, which is the exact spelling the shared dropdown records
          // as having shipped a clipped panel. These read the real clipping box, so a card near the
          // right edge of a window is narrowed rather than cut.
          className="z-50 w-[26rem] max-w-[var(--radix-hover-card-content-available-width)] overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-pop backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1"
        >
          <CodeRefCard
            preview={preview}
            onGo={(occurrence, path) =>
              vocab.onGoToOccurrence?.(
                props.symbol,
                path,
                occurrence.lineNumber,
                pierreSideOf(occurrence.side),
              )
            }
          />
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}

/** What the card holds: the name, how much of it there is, and the first few places it stands. */
function CodeRefCard(props: {
  preview: CodePreview | null;
  onGo: (occurrence: SymbolOccurrence, path: string) => void;
}) {
  const { preview } = props;
  // NO SEARCH TO DRAW — and it is NOT "still looking". `setOpen(true)` re-renders, and the memo that
  // runs the search runs in that same render, so by the time this component exists the answer is in.
  // What reaches here is the answer being NOTHING: the diff has moved under a page that has been open
  // a while and the name is no longer one these changes hold. That sentence is the honest one;
  // "looking…" would leave a card spinning for ever over somebody's paragraph.
  if (!preview) {
    return (
      <p data-testid="review-code-card-gone" className="px-3 py-2.5 text-[11px] text-text-faint">
        This name is not in the changes this page is holding any more — the branch has moved.
      </p>
    );
  }
  const more = codePreviewMore(preview);
  return (
    <div className="flex max-h-[var(--radix-hover-card-content-available-height)] flex-col">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-border-subtle px-3 py-2">
        {/* The name in the type the CODE is set in — it is code, and setting it in the prose face
            would make the card read as a remark about the name rather than as the name itself. The
            occurrences panel opens with the same two lines, so pressing through to it is a
            continuation rather than a new surface to read. */}
        <p className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground">
          {preview.symbol}
        </p>
        {/* The count, and — when it is the whole truth about the answer — that the branch took the
            name AWAY. Every row already says `removed` for itself; this says it about the answer, so a
            reader who reads the summary and not the rows is not left believing the code is there. */}
        <p data-testid="review-code-card-summary" className="shrink-0 text-[10px] text-text-faint">
          {preview.summary}
          {preview.removedOnly ? " · removed" : ""}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {preview.files.map((file) => (
          <section key={file.path} data-testid="review-code-card-file" data-path={file.path}>
            {/* The DIRECTORY gives way and the file's own name never does — the rule the
                occurrences panel holds, because a path here runs to
                `src/main/java/com/acme/service/UserService.java` and the end is the part that says
                which file this is. */}
            <h3 className="flex items-baseline gap-1.5 border-b border-border-subtle bg-element/60 px-3 py-1 text-[10px]">
              <span className="min-w-0 truncate text-text-faint">{parentOf(file.path)}</span>
              <span className="shrink-0 font-medium text-text-dim">{nameOf(file.path)}</span>
            </h3>
            <ul>
              {file.occurrences.map((occurrence) => (
                <li key={`${occurrence.row}:${occurrence.start}`}>
                  <CodeLineRow
                    occurrence={occurrence}
                    onGo={() => props.onGo(occurrence, file.path)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {(more || preview.limits) && (
        <p
          data-testid="review-code-card-more"
          className="shrink-0 border-t border-border-subtle px-3 py-1.5 text-[10px] leading-relaxed text-text-faint"
        >
          {[more, preview.limits].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

/** One place the name stands: the line number, which side it is on, and the line itself with the
 *  name marked EXACTLY.
 *
 *  Marking it character for character is what this card has that the renderer beside it cannot: the
 *  app draws these lines itself, so it can emphasize the name inside one, where the diff's own
 *  tokens live in a shadow root that CSS cannot select by text. The offsets are the search's own. */
function CodeLineRow(props: { occurrence: SymbolOccurrence; onGo: () => void }) {
  const { occurrence } = props;
  const before = occurrence.text.slice(0, occurrence.start);
  const match = occurrence.text.slice(occurrence.start, occurrence.end);
  const after = occurrence.text.slice(occurrence.end);
  return (
    <button
      type="button"
      data-testid="review-code-card-line"
      data-line={occurrence.lineNumber}
      data-side={occurrence.side}
      title={`Go to ${occurrence.lineNumber} in the changes`}
      onClick={props.onGo}
      className="flex w-full items-baseline gap-2 px-3 py-1 text-left transition-colors hover:bg-accent"
    >
      <span
        // The same three-way vocabulary the diff's own gutter and the occurrences panel use, so a
        // reader learns it once: an added line, a removed line, a line the patch carried for
        // context. It is stated in WORDS for a screen reader, because a colour is not a signal.
        className={cn(
          "w-8 shrink-0 text-right text-[10px] tabular-nums",
          occurrence.side === "new" && "text-success",
          occurrence.side === "old" && "text-destructive",
          occurrence.side === "both" && "text-text-faint",
        )}
        aria-label={`line ${occurrence.lineNumber}, ${occurrenceSideLabel(occurrence.side)}`}
      >
        {occurrence.lineNumber}
      </span>
      {/* One line, never wrapped: a wrapped line of code makes every row a different height and
          the name's own column meaningless. It is clipped, and the whole line is on the page one
          press away. */}
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-dim">
        {before}
        <span className="rounded-sm bg-primary/15 font-medium text-foreground">{match}</span>
        {after}
      </code>
    </button>
  );
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

function nameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

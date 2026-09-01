import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import {
  occurrenceSideLabel,
  symbolSearchLimits,
  symbolSearchSummary,
  type SymbolOccurrence,
  type SymbolSearch,
} from "~/lib/gitlab-diff-symbols";
import { cn } from "~/lib/utils";

// The panel on the right of the diff page: every place the name the reader pressed turns up in
// these changes.
//
// It answers the one question a reviewer has about an identifier they have just met — "what else in
// this branch touches it?" — and it is drawn from `lib/gitlab-diff-symbols.ts`, which is pure. This
// file draws; it decides nothing.
//
// **It is honest about being a TEXTUAL search**, in its own heading. GitHub answers this from a
// symbol index a language server built, and nothing on this machine holds one for a diff read out of
// a tracker (see the library's header). So the panel says what it did — found the name as a whole
// word — rather than calling it "references", because a reader who believes a list is semantic stops
// checking it.
//
// Four rules hold it, and `web/e2e/gitlab.spec.ts` pins each:
//
//   - **It scrolls ITSELF**, like the two columns beside it. The page never scrolls.
//   - **A row is a PLACE, and pressing it goes there** — the exact line, not just the file, because
//     a file here runs to nine hundred lines. It stays open afterwards: a reader walking six
//     occurrences is going to press the next one.
//   - **The name is emphasized exactly**, character for character, from the offsets the search
//     returned. That is what this panel has that the code beside it cannot: the app draws these
//     lines itself, so it can mark the name inside one, where the renderer's own tokens live in a
//     shadow root that CSS cannot select by text.
//   - **What the search could NOT see is stated at the foot** — a file whose patch never travelled
//     may hold the name and this list would never say so.

export type DiffSymbolsPanelProps = {
  search: SymbolSearch;
  /** Which file the reader is at, so the row for the file they are in is marked as being here. */
  currentPath: string | null;
  /** Go to one occurrence: the file becomes the one on screen, at that line. */
  onGo: (occurrence: SymbolOccurrence, path: string) => void;
  onClose: () => void;
};

export function DiffSymbolsPanel(props: DiffSymbolsPanelProps) {
  const { search } = props;
  const limits = symbolSearchLimits(search);
  return (
    <aside
      data-testid="gitlab-diff-symbols"
      data-symbol={search.symbol}
      data-total={search.total}
      aria-label={`Occurrences of ${search.symbol} in these changes`}
      className="flex min-h-0 min-w-0 flex-col bg-background"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-border-subtle px-3 py-2">
        <HugeiconsIcon
          icon={Search01Icon}
          className="mt-1 size-3.5 shrink-0 text-text-faint"
          strokeWidth={1.8}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The name as the reader pressed it, in the type the code is set in — it IS code, and
              setting it in the prose face would make it read as a word about the code. */}
          <p
            data-testid="gitlab-diff-symbols-name"
            className="truncate font-mono text-[12px] font-medium text-foreground"
          >
            {search.symbol}
          </p>
          <p data-testid="gitlab-diff-symbols-summary" className="text-[11px] text-text-faint">
            {symbolSearchSummary(search)}
          </p>
        </div>
        <button
          type="button"
          data-testid="gitlab-diff-symbols-close"
          aria-label="Close the occurrences panel"
          title="Close the occurrences panel"
          onClick={props.onClose}
          className="-mr-1 grid size-7 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.8} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {search.files.length === 0 ? (
          <p
            data-testid="gitlab-diff-symbols-none"
            className="px-3 py-4 text-[12px] leading-relaxed text-text-faint"
          >
            This name stands nowhere else in the changes this page read.
          </p>
        ) : (
          search.files.map((file) => (
            <section key={file.path} data-testid="gitlab-diff-symbols-file" data-path={file.path}>
              {/* The path, sticky inside this panel's own scroll — which in a list of places is
                  what says which file the rows under the reader's eye belong to. It is the rule
                  pierre's own file header follows one column to the left. */}
              <h3
                className={cn(
                  "sticky top-0 z-10 flex items-baseline gap-1.5 border-b border-border-subtle bg-element/95 px-3 py-1.5 backdrop-blur-sm",
                  file.path === props.currentPath && "text-foreground",
                )}
              >
                {/* The DIRECTORY gives way and the FILE'S OWN NAME never does. A path here runs to
                    `src/main/java/com/acme/service/UserService.java`, and truncating it at the end
                    would drop the one part that says which file this is — while truncating it at the
                    start (the `direction: rtl` trick) right-aligns every short path against the
                    count, which is what the first capture of this panel showed. */}
                <span className="flex min-w-0 flex-1 items-baseline text-[11px]">
                  <span className="min-w-0 truncate text-text-faint">{filePathParent(file.path)}</span>
                  <span className="shrink-0 font-medium">{filePathName(file.path)}</span>
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-text-faint">
                  {file.occurrences.length}
                </span>
              </h3>
              <ul>
                {file.occurrences.map((occurrence) => (
                  <li key={`${occurrence.row}:${occurrence.start}`}>
                    <OccurrenceRow
                      occurrence={occurrence}
                      symbol={search.symbol}
                      onGo={() => props.onGo(occurrence, file.path)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {limits && (
        <p
          data-testid="gitlab-diff-symbols-limits"
          className="shrink-0 border-t border-border-subtle px-3 py-2 text-[11px] leading-relaxed text-text-faint"
        >
          {limits}
        </p>
      )}
    </aside>
  );
}

/** A path's directory part, trailing slash and all, and `""` for a file at the root. */
function filePathParent(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

/** A path's own file name. */
function filePathName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/** One place the name stands: its line number, whether that line was added, removed or is context,
 *  and the line itself with the name marked.
 *
 *  The whole row is the control, because the target is "this place" rather than any one word in it —
 *  and a 44 px row would fit four occurrences on a screen, so it is the height a line of code is
 *  plus room to press, which is the same trade the merge-request sidebar's own rows make. */
function OccurrenceRow(props: {
  occurrence: SymbolOccurrence;
  symbol: string;
  onGo: () => void;
}) {
  const { occurrence } = props;
  const before = occurrence.text.slice(0, occurrence.start);
  const match = occurrence.text.slice(occurrence.start, occurrence.end);
  const after = occurrence.text.slice(occurrence.end);
  return (
    <button
      type="button"
      data-testid="gitlab-diff-symbols-occurrence"
      data-line={occurrence.lineNumber}
      data-side={occurrence.side}
      title={`Go to line ${occurrence.lineNumber}`}
      onClick={props.onGo}
      className="group flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent"
    >
      <span
        className={cn(
          "w-9 shrink-0 text-right text-[10px] tabular-nums",
          // The same three-way vocabulary the gutter beside it uses, so a reader does not learn a
          // second one: an added line, a removed line, and a line the patch carried for context.
          // The app's OWN two tokens — the pipeline graph already spends them on the same meaning —
          // rather than a raw palette colour, which would be a second green in one screen.
          occurrence.side === "new" && "text-success",
          occurrence.side === "old" && "text-destructive",
          occurrence.side === "both" && "text-text-faint",
        )}
        aria-label={`line ${occurrence.lineNumber}, ${occurrenceSideLabel(occurrence.side)}`}
      >
        {occurrence.lineNumber}
      </span>
      {/* The line, on ONE line: it is a place rather than something to read here, and a wrapped
          row would make the list's own rhythm depend on how long somebody's line is. The leading
          whitespace is trimmed for the same reason — an indented line would start half a row in. */}
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5 text-text-dim">
        {before.trimStart()}
        <mark
          data-testid="gitlab-diff-symbols-match"
          className="rounded-sm bg-primary/20 px-px font-medium text-foreground"
        >
          {match}
        </mark>
        {after}
      </code>
    </button>
  );
}

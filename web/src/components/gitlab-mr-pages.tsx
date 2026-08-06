import { useNavigate, useMatchRoute, useParams } from "@tanstack/react-router";
import {
  gitlabPageLinkLabel,
  gitlabPageUrl,
  MERGE_REQUEST_PAGES,
  unbuiltMergeRequestPage,
  type MergeRequestPage,
} from "~/lib/gitlab-mr-pages";
import { cn } from "~/lib/utils";
import { GitLabLogo } from "./gitlab-logo";

// The SUB-HEADER of a merge request: the four pages it has, under the header that names it.
//
// One merge request is four surfaces, exactly as GitLab's own is — Overview, Commits,
// Pipelines, Diffs — and each is a ROUTE (see `lib/gitlab-mr-pages.ts` for the set, and the
// four files under `src/routes`). Four rules hold the strip together:
//
//   - **It navigates; it never swaps a piece of state.** Every page therefore survives a
//     reload, can be sent to a colleague, and is behind the browser's own Back — the reason
//     the diff was a route before this strip existed.
//   - **It is on EVERY one of the four**, the full-screen diff page included. A strip that
//     named the pages of a merge request and then vanished on one of them would leave the
//     reader with a Back button where they wanted a Commits tab.
//   - **All four are always offered, whatever a read answered.** A tab is where the reader
//     goes, not an invitation into content, so a strip whose shape changed per merge request
//     would move the target between two of them. What a page could not read, that page says
//     — which is why a diff nobody could read still has its tab and still opens a screen
//     that explains itself.
//   - **Two of the four hold nothing yet, and they SAY so** (`UnbuiltMergeRequestPage`),
//     with the one thing left: GitLab's own page for what is missing. A page drawn blank
//     reads as a failed read.
//
// It wears the app's own tab idiom (the segmented pill of `ui/tabs.tsx`) rather than that
// primitive itself: `TabsTrigger` points `aria-controls` at a panel in the same document, and
// three of these four pages are places rather than panels — the Diffs one replaces the whole
// screen. So it is a `nav` of buttons carrying `aria-current`, which is what a reader's
// screen reader is owed here.

/** Which of the four pages the URL asks for. The router's own answer, so nothing here parses
 *  a pathname — and `overview` is the fallback, because `/mr/<id>` IS the overview. */
export function useMergeRequestPage(): MergeRequestPage {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/mr/$mergeRequestId/diff" })) return "diffs";
  if (matchRoute({ to: "/mr/$mergeRequestId/commits" })) return "commits";
  if (matchRoute({ to: "/mr/$mergeRequestId/pipelines" })) return "pipelines";
  return "overview";
}

export function MergeRequestPageStrip(props: { current: MergeRequestPage; className?: string }) {
  const navigate = useNavigate();
  // `strict: false` because this strip is drawn from two routes — the merge request's own and
  // its diff — and both carry the same param.
  const { mergeRequestId } = useParams({ strict: false });

  // No id means no merge request to have pages of: the pane draws its empty state instead.
  if (!mergeRequestId) return null;

  const go = (page: MergeRequestPage) => {
    // One navigate call per page, so each route is a literal the router can type-check. A
    // table of `to` strings would type as a union and lose that.
    const params = { mergeRequestId };
    switch (page) {
      case "overview":
        void navigate({ to: "/mr/$mergeRequestId", params });
        return;
      case "commits":
        void navigate({ to: "/mr/$mergeRequestId/commits", params });
        return;
      case "pipelines":
        void navigate({ to: "/mr/$mergeRequestId/pipelines", params });
        return;
      case "diffs":
        void navigate({ to: "/mr/$mergeRequestId/diff", params });
        return;
    }
  };

  return (
    // The row scrolls sideways rather than widening: four labels are wider than a 320 px
    // phone, and a header that grows past its column takes the page's own controls off the
    // right of the screen (the `min-w-0` lesson the long title already taught this page).
    <div
      className={cn(
        "flex shrink-0 overflow-x-auto border-b border-border-subtle px-2 py-1.5 md:px-5 md:py-2",
        props.className,
      )}
    >
      <nav
        aria-label="Merge request pages"
        data-testid="gitlab-mr-pages"
        data-page={props.current}
        className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-card p-1 shadow-chip"
      >
        {MERGE_REQUEST_PAGES.map((entry) => {
          const current = entry.page === props.current;
          return (
            <button
              key={entry.page}
              type="button"
              data-testid="gitlab-mr-page"
              data-page={entry.page}
              data-current={current ? "true" : undefined}
              aria-current={current ? "page" : undefined}
              title={entry.hint}
              data-cuelume-toggle=""
              onClick={() => go(entry.page)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[12px] font-medium transition-colors md:px-3 md:py-1.5 md:text-[13px]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                current
                  ? "bg-background text-foreground shadow-chip"
                  : "text-text-dim hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/** A page of a merge request that this app does not read yet.
 *
 *  It says which page is missing and offers GitLab's own for it, which is the one thing left
 *  — the contract the diff's own failure already holds. Drawn as the whole surface, because
 *  there is no other content beside it to fall back on. */
export function UnbuiltMergeRequestPage(props: { page: MergeRequestPage; webUrl?: string }) {
  const notice = unbuiltMergeRequestPage(props.page);
  const href = gitlabPageUrl(props.webUrl, props.page);
  if (!notice) return null;
  return (
    <div
      data-testid="gitlab-mr-unbuilt"
      data-page={props.page}
      className="flex min-h-0 flex-1 items-center justify-center p-8"
    >
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <GitLabLogo className="size-8" title="GitLab" />
        <p className="text-[13px] text-text-dim">{notice}</p>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid="gitlab-mr-unbuilt-link"
            className="text-[13px] text-text-dim underline-offset-2 hover:text-foreground hover:underline"
          >
            {gitlabPageLinkLabel(props.page)}
          </a>
        )}
      </div>
    </div>
  );
}

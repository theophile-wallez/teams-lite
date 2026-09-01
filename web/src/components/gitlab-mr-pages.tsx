import { useNavigate, useMatchRoute, useParams } from "@tanstack/react-router";
import {
  gitlabPageLinkLabel,
  gitlabPageUrl,
  jobLogPath,
  MERGE_REQUEST_PAGES,
  MERGE_REQUEST_PAGES_ID,
  mergeRequestPagePanel,
  unbuiltMergeRequestPage,
  type MergeRequestPage,
} from "~/lib/gitlab-mr-pages";
import { cn } from "~/lib/utils";
import { GitLabLogo } from "./gitlab-logo";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

// The SUB-HEADER of a merge request: the pages it has, under the header that names it.
//
// Four of them are GitLab's own, in GitLab's own order — Overview, Commits, Pipelines, Diffs —
// and the fifth is this app's: the READING (§ THE READING IS A PAGE). Each is a ROUTE (see
// `lib/gitlab-mr-pages.ts` for the set, and the files under `src/routes`). Four rules hold the
// strip together:
//
//   - **It navigates; it never swaps a piece of state.** Every page therefore survives a
//     reload, can be sent to a colleague, and is behind the browser's own Back — the reason
//     the diff was a route before this strip existed, and the reason the reading became one.
//   - **It is on EVERY page**, the two full-screen ones included. A strip that named the pages
//     of a merge request and then vanished on one of them would leave the reader with a Back
//     button where they wanted a Commits tab.
//   - **All of them are always offered, whatever a read answered.** A tab is where the reader
//     goes, not an invitation into content, so a strip whose shape changed per merge request
//     would move the target between two of them. What a page could not read, that page says
//     — which is why a diff nobody could read still has its tab and still opens a screen
//     that explains itself.
//   - **One of them holds nothing yet, and it SAYS so** (`UnbuiltMergeRequestPage`),
//     with the one thing left: GitLab's own page for what is missing. A page drawn blank
//     reads as a failed read.
//
// It IS the app's own `Tabs` primitive (`ui/tabs.tsx`), with two things about it worth stating:
//
//   - **The tabs sit in the sub-header itself, never in a card.** `TabsList`'s own surface —
//     the `bg-card` pill with its shadow — is dropped here: a card floating inside a header row
//     is two nested surfaces for one thing, and this row already has its own bottom border. The
//     wash stays on the CURRENT tab, which is what it is for: saying which page is open.
//   - **`aria-controls` is kept true.** Every trigger points at a panel id, so the CONTENT of
//     each page carries it (`mergeRequestPagePanel`) — it resolves inside one document on every
//     page, because each draws its own strip beside its own content.
//
// The value is the URL and `onValueChange` NAVIGATES, so arrowing along the strip walks the
// pages: automatic activation is the primitive's own behaviour, and it costs nothing here
// because moving between the pages of an open merge request re-reads nothing.

/** Which of the four pages the URL asks for. The router's own answer, so nothing here parses
 *  a pathname — and `overview` is the fallback, because `/mr/<id>` IS the overview. */
export function useMergeRequestPage(): MergeRequestPage {
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/mr/$mergeRequestId/diff" })) return "diffs";
  if (matchRoute({ to: "/mr/$mergeRequestId/review" })) return "review";
  if (matchRoute({ to: "/mr/$mergeRequestId/commits" })) return "commits";
  // A JOB's log hangs under the Pipelines page, so the strip keeps Pipelines current there: a
  // reader inside a job is inside that run.
  if (matchRoute({ to: "/mr/$mergeRequestId/pipelines" })) return "pipelines";
  if (matchRoute({ to: "/mr/$mergeRequestId/jobs/$jobId" })) return "pipelines";
  return "overview";
}

/**
 * How a JOB is opened: the anchor props one job card wears.
 *
 * A card stays an `<a>` with a real address, and the click is intercepted so the router takes it
 * — three things follow, and the first is the one that matters here: the graph holds no BUTTON,
 * which is the rule that says nothing on it writes (see `gitlab-pipeline-graph.tsx`, whose spec
 * counts them). The other two are a reader's own: the address is copyable, and a modified click
 * still opens a second window.
 *
 * `null` when the URL names no merge request, which is a graph with nothing to hang a job off.
 */
export function useJobLogLink(): ((jobId: number) => {
  href: string;
  onClick: (event: React.MouseEvent) => void;
}) | null {
  const navigate = useNavigate();
  const { mergeRequestId } = useParams({ strict: false });
  if (!mergeRequestId) return null;
  return (jobId: number) => ({
    href: jobLogPath(mergeRequestId, jobId),
    onClick: (event: React.MouseEvent) => {
      // A modified click is the reader asking their browser for a second window, and this app
      // never takes one of those off them.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void navigate({
        to: "/mr/$mergeRequestId/jobs/$jobId",
        params: { mergeRequestId, jobId: String(jobId) },
      });
    },
  });
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
      case "review":
        void navigate({ to: "/mr/$mergeRequestId/review", params });
        return;
    }
  };

  return (
    // The row scrolls sideways rather than widening: five labels are wider than a 320 px
    // phone, and a header that grows past its column takes the page's own controls off the
    // right of the screen (the `min-w-0` lesson the long title already taught this page).
    //
    // It states which page is current for a driver to read, because the strip is what every
    // capture and every spec waits on — the sentinel discipline the composer already follows
    // for its conversation.
    <div
      data-testid="gitlab-mr-pages"
      data-page={props.current}
      className={cn(
        "flex shrink-0 overflow-x-auto border-b border-border-subtle px-2 py-1.5 md:px-5 md:py-2",
        props.className,
      )}
    >
      <Tabs
        id={MERGE_REQUEST_PAGES_ID}
        value={props.current}
        onValueChange={(value) => go(value as MergeRequestPage)}
        className="min-w-0"
      >
        {/* `surface={false}`: no card, so the tabs stand in the sub-header itself. The wash is
            on the current tab alone, which is the one thing it has to say. */}
        <TabsList aria-label="Merge request pages" surface={false} className="gap-0.5">
          {MERGE_REQUEST_PAGES.map((entry) => (
            <TabsTrigger
              key={entry.page}
              value={entry.page}
              data-testid={`gitlab-mr-page-${entry.page}`}
              title={entry.hint}
              // Natural widths rather than the equal quarters a sidebar strip takes: these are
              // four words in a header, not a segmented control filling a column. How the
              // CURRENT one is drawn follows `surface={false}` and is the primitive's own.
              className="flex-none shrink-0 px-2 py-1 text-[12px] md:px-3 md:py-1.5 md:text-[13px]"
            >
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
      {...mergeRequestPagePanel(props.page)}
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

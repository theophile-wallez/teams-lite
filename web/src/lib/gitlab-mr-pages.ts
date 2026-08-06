// The PAGES one merge request has, and everything pure that can be said about them.
//
// GitLab's own merge request is not one page but four — Overview, Commits, Pipelines,
// Changes — and this app now says the same thing in the same order. Each one is a ROUTE
// (`/mr/<id>`, `…/commits`, `…/pipelines`, `…/diff`), for the reason the diff already is a
// route rather than a piece of state: it survives a reload, it can be sent to a colleague,
// and the browser's own Back leaves it.
//
// Two of the four hold nothing yet. That is stated here rather than decided in a component,
// so "which pages are built" is one testable fact, and so the sentence a reader gets names
// what is missing and offers the one thing left — GitLab's own page for it, which is the
// contract every other read failure on this surface holds (see `DiffFailure`).
//
// Nothing here touches the DOM, the router or the network: the strip that draws it is
// `components/gitlab-mr-pages.tsx`, and the routes are its four files under `src/routes`.

/** One of the four pages of a merge request. `diffs` is GitLab's "Changes" — the app calls
 *  its own route `/diff` and its surface the diff, so the page keeps that name here and the
 *  LABEL below is what a reader sees. */
export type MergeRequestPage = "overview" | "commits" | "pipelines" | "diffs";

export type MergeRequestPageEntry = {
  page: MergeRequestPage;
  /** What the strip calls it. */
  label: string;
  /** What it is for, for the control's own title: four one-word labels need somewhere to
   *  say which is which — the rule `SCOPE_HINTS` already follows in the sidebar. */
  hint: string;
  /** What GitLab's own page for it hangs on, after the merge request's `web_url`. Empty for
   *  the Overview, whose GitLab page IS that URL. */
  gitlabPath: string;
  /** The sentence a page that holds nothing yet says, or `undefined` on one that is built.
   *  A page drawn blank reads as a failed read, so every page says something. */
  unbuilt?: string;
};

/** The four, in the order GitLab puts them in — Overview first, because it is what opening a
 *  merge request means, and the changes LAST, because reading the code is what a reviewer
 *  goes on to do. */
export const MERGE_REQUEST_PAGES: readonly MergeRequestPageEntry[] = [
  {
    page: "overview",
    label: "Overview",
    hint: "The description, the pipeline, the approvals and the conversation",
    gitlabPath: "",
  },
  {
    page: "commits",
    label: "Commits",
    hint: "The commits on the source branch",
    gitlabPath: "/commits",
    unbuilt: "The commits on this branch are not read here yet.",
  },
  {
    page: "pipelines",
    label: "Pipelines",
    hint: "Every pipeline that has run for this merge request",
    gitlabPath: "/pipelines",
    // Says where the pipeline the reader is probably after already is: the Overview polls
    // the one in flight, so this page holding nothing costs them nothing today.
    unbuilt:
      "The pipelines of this merge request are not read here yet. The Overview follows the one in flight.",
  },
  {
    page: "diffs",
    label: "Diffs",
    hint: "The changed files, and one of them read in full",
    gitlabPath: "/diffs",
  },
];

/** The entry for one page. Every `MergeRequestPage` has one, so this never answers nothing —
 *  the type is the closed set the list is built from. */
export function mergeRequestPageEntry(page: MergeRequestPage): MergeRequestPageEntry {
  const entry = MERGE_REQUEST_PAGES.find((candidate) => candidate.page === page);
  // Unreachable while the type and the list agree; kept because a page added to one and not
  // the other must not take the whole surface down.
  return entry ?? MERGE_REQUEST_PAGES[0]!;
}

/** The sentence a page that holds nothing yet says, or `null` on one that is built. */
export function unbuiltMergeRequestPage(page: MergeRequestPage): string | null {
  return mergeRequestPageEntry(page).unbuilt ?? null;
}

/**
 * GitLab's own address for one page of this merge request, or `null` when there is no merge
 * request URL to hang it on.
 *
 * It is built from the merge request's own `web_url` — never from the configured host and an
 * assembled path — so a link out of this app can only ever point at the resource GitLab
 * itself named.
 */
export function gitlabPageUrl(
  webUrl: string | null | undefined,
  page: MergeRequestPage,
): string | null {
  if (!webUrl) return null;
  // A trailing slash would make `…/-/merge_requests/42//commits`, which GitLab redirects but
  // which reads as a bug in a status bar.
  const base = webUrl.endsWith("/") ? webUrl.slice(0, -1) : webUrl;
  return `${base}${mergeRequestPageEntry(page).gitlabPath}`;
}

/** What the way out to GitLab is called on a page that holds nothing yet. Names the PAGE, so
 *  a reader on Commits is never offered "the changes". */
export function gitlabPageLinkLabel(page: MergeRequestPage): string {
  return `Open the ${mergeRequestPageEntry(page).label.toLowerCase()} in GitLab`;
}

// The PAGES one merge request has, and everything pure that can be said about them.
//
// GitLab's own merge request is not one page but four — Overview, Commits, Pipelines,
// Changes — and this app now says the same thing in the same order. Each one is a ROUTE
// (`/mr/<id>`, `…/commits`, `…/pipelines`, `…/diff`), for the reason the diff already is a
// route rather than a piece of state: it survives a reload, it can be sent to a colleague,
// and the browser's own Back leaves it.
//
// ONE of the four holds nothing yet. That is stated here rather than decided in a component,
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
    hint: "The head pipeline, drawn as the graph of its jobs",
    gitlabPath: "/pipelines",
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

/**
 * This app's own address for ONE job's log, under the merge request it belongs to.
 *
 * A job hangs off the Pipelines page rather than sitting beside it in the strip above: it is a
 * detail of a run, so the strip keeps Pipelines current there and Back leaves the log for the run.
 *
 * `mergeRequestId` is already the URL-safe pair (see `mergeRequestId` in lib/gitlab-mr.ts), so
 * nothing here encodes anything twice.
 */
export function jobLogPath(mergeRequestId: string, jobId: number): string {
  return `/mr/${mergeRequestId}/jobs/${jobId}`;
}

/** What the way out to GitLab is called on a page that holds nothing yet. Names the PAGE, so
 *  a reader on Commits is never offered "the changes". */
export function gitlabPageLinkLabel(page: MergeRequestPage): string {
  return `Open the ${mergeRequestPageEntry(page).label.toLowerCase()} in GitLab`;
}

// ---- the strip, and the panel each of its tabs really controls ---------------
//
// The sub-header is the app's own `Tabs` primitive, so every trigger points `aria-controls`
// at a panel — and that promise is kept rather than left dangling: the CONTENT of the page is
// given the id the trigger names. It resolves inside one document on all four pages, the
// full-screen diff included, because each page draws its own strip beside its own content.
//
// The base id is a CONSTANT rather than React's own generated one, since the two halves are
// drawn by different components (the strip in `MergeRequestPageStrip`, the panel by whichever
// surface holds that page) and one merge request is on screen at a time.

/** The id the four tabs and their panels hang off. */
export const MERGE_REQUEST_PAGES_ID = "gitlab-mr-pages";

/** What a tab's own element id is — the value `TabsTrigger` mints from the base id, spelled
 *  here so a panel can point back at it. */
export function mergeRequestPageTabId(page: MergeRequestPage): string {
  return `${MERGE_REQUEST_PAGES_ID}-tab-${page}`;
}

/** The attributes the CONTENT of one page carries, so the tab above it really controls
 *  something and a screen reader can name what it is looking at. Spread onto the element that
 *  holds that page's content. */
export function mergeRequestPagePanel(page: MergeRequestPage): {
  id: string;
  role: "tabpanel";
  "aria-labelledby": string;
} {
  return {
    id: `${MERGE_REQUEST_PAGES_ID}-panel-${page}`,
    role: "tabpanel",
    "aria-labelledby": mergeRequestPageTabId(page),
  };
}

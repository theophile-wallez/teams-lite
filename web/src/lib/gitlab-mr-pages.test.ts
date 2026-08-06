import { describe, expect, it } from "vitest";
import {
  gitlabPageLinkLabel,
  gitlabPageUrl,
  MERGE_REQUEST_PAGES,
  mergeRequestPageEntry,
  mergeRequestPagePanel,
  mergeRequestPageTabId,
  unbuiltMergeRequestPage,
  type MergeRequestPage,
} from "./gitlab-mr-pages";

const WEB_URL = "https://git.example.com/group/app/-/merge_requests/42";

describe("the pages of a merge request", () => {
  it("offers GitLab's own four, in GitLab's own order", () => {
    expect(MERGE_REQUEST_PAGES.map((entry) => entry.page)).toEqual([
      "overview",
      "commits",
      "pipelines",
      "diffs",
    ]);
    expect(MERGE_REQUEST_PAGES.map((entry) => entry.label)).toEqual([
      "Overview",
      "Commits",
      "Pipelines",
      "Diffs",
    ]);
  });

  it("says what each page is for, because four one-word labels do not", () => {
    // The rule `SCOPE_HINTS` already holds for the sidebar's own filter: a label with room
    // for one word needs somewhere to say which is which.
    for (const entry of MERGE_REQUEST_PAGES) {
      expect(entry.hint.length).toBeGreaterThan(0);
      expect(entry.hint).not.toEqual(entry.label);
    }
  });

  it("names exactly the one page that holds nothing yet", () => {
    expect(unbuiltMergeRequestPage("overview")).toBeNull();
    expect(unbuiltMergeRequestPage("diffs")).toBeNull();
    // PIPELINES is built: it draws the head pipeline as the graph of its jobs (see
    // `gitlab-pipeline-page.tsx`), so it says nothing about being missing.
    expect(unbuiltMergeRequestPage("pipelines")).toBeNull();
    expect(unbuiltMergeRequestPage("commits")).toMatch(/not read here yet/);
  });

  it("builds GitLab's own address from the merge request's own URL", () => {
    expect(gitlabPageUrl(WEB_URL, "overview")).toBe(WEB_URL);
    expect(gitlabPageUrl(WEB_URL, "commits")).toBe(`${WEB_URL}/commits`);
    expect(gitlabPageUrl(WEB_URL, "pipelines")).toBe(`${WEB_URL}/pipelines`);
    // GitLab calls the changes `/diffs`, whatever this app calls its own route.
    expect(gitlabPageUrl(WEB_URL, "diffs")).toBe(`${WEB_URL}/diffs`);
  });

  it("takes a trailing slash off rather than doubling it", () => {
    expect(gitlabPageUrl(`${WEB_URL}/`, "commits")).toBe(`${WEB_URL}/commits`);
  });

  it("has no address at all without a merge-request URL", () => {
    // Which is what makes the link disappear rather than point at nothing: a detail still on
    // its way carries no `web_url`.
    expect(gitlabPageUrl(undefined, "commits")).toBeNull();
    expect(gitlabPageUrl("", "commits")).toBeNull();
    expect(gitlabPageUrl(null, "commits")).toBeNull();
  });

  it("names the page in the way out, never another one", () => {
    expect(gitlabPageLinkLabel("commits")).toBe("Open the commits in GitLab");
    expect(gitlabPageLinkLabel("pipelines")).toBe("Open the pipelines in GitLab");
  });

  it("answers for every page of the closed set", () => {
    const pages: MergeRequestPage[] = ["overview", "commits", "pipelines", "diffs"];
    for (const page of pages) {
      expect(mergeRequestPageEntry(page).page).toBe(page);
    }
  });

  it("pairs every tab with the panel it really controls", () => {
    // The strip is the app's own `Tabs` primitive, so each trigger points `aria-controls` at a
    // panel id — and that id has to be the one the page's content carries, or the promise is a
    // dangling reference. The two halves are spelled here so they cannot drift.
    const pages: MergeRequestPage[] = ["overview", "commits", "pipelines", "diffs"];
    const ids = new Set<string>();
    for (const page of pages) {
      const panel = mergeRequestPagePanel(page);
      expect(panel.role).toBe("tabpanel");
      expect(panel["aria-labelledby"]).toBe(mergeRequestPageTabId(page));
      ids.add(panel.id);
    }
    // One id per page: two pages sharing one would point two tabs at one panel.
    expect(ids.size).toBe(pages.length);
  });
});

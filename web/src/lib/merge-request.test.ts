import { describe, expect, it } from "vitest";
import { mergeRequestFromUrl, mergeRequestsIn, reviewRequest } from "./merge-request";

// The parse is a port of the merge-request half of `gitlab::parse_url`, so the cases
// mirror `gitlab::tests` case for case: what a message offers must match what the
// backend would accept.
describe("mergeRequestFromUrl", () => {
  it("reads a merge request on the configured host", () => {
    expect(mergeRequestFromUrl("https://gitlab.com/acme/webapp/-/merge_requests/42", "gitlab.com"))
      .toEqual({
        url: "https://gitlab.com/acme/webapp/-/merge_requests/42",
        projectPath: "acme/webapp",
        iid: 42,
        reference: "!42",
      });
  });

  it("reads a nested group, and a self-hosted host", () => {
    const url = "https://gitlab.example.com/group/sub/app/-/merge_requests/7";
    expect(mergeRequestFromUrl(url, "gitlab.example.com")).toMatchObject({
      projectPath: "group/sub/app",
      iid: 7,
      reference: "!7",
    });
  });

  it("keeps the reader's own position out of the parse", () => {
    // A tab, a diff path and a query string are where the reader was, not what the
    // link names.
    for (const suffix of ["/diffs?tab=changes", "/pipelines", "#note_1"]) {
      expect(
        mergeRequestFromUrl(`https://gitlab.com/a/b/-/merge_requests/9${suffix}`, "gitlab.com"),
      ).toMatchObject({ iid: 9 });
    }
  });

  it("names nothing on another host", () => {
    // The host pin is the whole reason the backend's token is safe. A menu offering an
    // action here would be offering one the backend refuses.
    expect(
      mergeRequestFromUrl("https://gitlab.evil.example/a/b/-/merge_requests/1", "gitlab.com"),
    ).toBeNull();
    expect(mergeRequestFromUrl("http://gitlab.com/a/b/-/merge_requests/1", "gitlab.com")).toBeNull();
    // A blank configured host matches nothing rather than everything.
    expect(mergeRequestFromUrl("https://gitlab.com/a/b/-/merge_requests/1", "  ")).toBeNull();
  });

  it("names nothing that is not a merge request", () => {
    for (const url of [
      "https://gitlab.com/acme/webapp/-/issues/7",
      "https://gitlab.com/acme/webapp",
      "https://gitlab.com/acme/webapp/-/commit/deadbeef",
      "https://gitlab.com/acme/webapp/-/merge_requests",
      "https://gitlab.com/acme/webapp/-/merge_requests/new",
      "https://gitlab.com/-/merge_requests/1",
    ]) {
      expect(mergeRequestFromUrl(url, "gitlab.com")).toBeNull();
    }
  });
});

describe("mergeRequestsIn", () => {
  it("keeps the order, drops everything else, and counts one link once", () => {
    const mr = "https://gitlab.com/a/b/-/merge_requests/2";
    const found = mergeRequestsIn(
      ["https://gitlab.com/a/b/-/issues/1", mr, "https://linear.app/x/issue/ENG-1", mr],
      "gitlab.com",
    );
    expect(found.map((m) => m.reference)).toEqual(["!2"]);
  });
});

describe("reviewRequest", () => {
  it("names the merge request in full", () => {
    const mr = mergeRequestFromUrl("https://gitlab.com/a/b/-/merge_requests/3", "gitlab.com")!;
    const request = reviewRequest(mr);
    // Both halves: the reference is what a reader recognises, the URL is what the agent
    // needs to go and read it.
    expect(request).toContain("!3");
    expect(request).toContain(mr.url);
    // And it is a request, so a bare prefix is never what gets sent.
    expect(request.trim().length).toBeGreaterThan(10);
  });
});

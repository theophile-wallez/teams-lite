// The rules that turn a word into a link to a tracked thing — and, just as often, the rules
// that leave a word alone. Every case here pins one of the five rails in the module header of
// tracker-ref.ts.
import { describe, expect, it } from "vitest";
import { parseMessageBody, type RichNode } from "./rich-text";
import {
  linearIssueFromUrl,
  markTrackerRefs,
  mergeRequestPath,
  projectNamedIn,
  projectNamedInText,
  threadProjects,
  trackerRefFromUrl,
  type TrackerVocabulary,
} from "./tracker-ref";

const GITLAB_HOST = "git.sia.partners";

/** A workspace shaped like this tenant's: a handful of team keys under one url key. */
const VOCAB: TrackerVocabulary = {
  gitlabHost: GITLAB_HOST,
  linear: { url_key: "heka-internal", team_keys: ["STMN", "CONFIG", "CLIENT"] },
};

const MR_URL = `https://${GITLAB_HOST}/heka/platform/-/merge_requests/42`;
const ISSUE_URL = "https://linear.app/heka-internal/issue/STMN-3439/archived-traces";

/** The chips a rendered tree carries, in order: what each says and where it goes. */
function chips(nodes: RichNode[]): { tracker: string; text: string; href: string }[] {
  const out: { tracker: string; text: string; href: string }[] = [];
  const visit = (node: RichNode): void => {
    if (node.type === "text") return;
    if (node.tag === "trackerRef") {
      out.push({
        tracker: node.attrs.tracker ?? "",
        text: text(node.children),
        href: node.attrs.href ?? "",
      });
      return;
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function text(nodes: RichNode[]): string {
  return nodes
    .map((node) => (node.type === "text" ? node.text : text(node.children)))
    .join("");
}

/** One body, read as a message body is. */
function body(html: string, vocab: TrackerVocabulary = VOCAB): RichNode[] {
  return markTrackerRefs(parseMessageBody(html, "html"), vocab);
}

describe("a reference in the words", () => {
  it("turns a bare merge request reference into a link to THIS app's page", () => {
    // What an agent writes when it answers about one: the reference, and the project named by
    // the link beside it.
    const nodes = body(`<p>${MR_URL} is ready — !42 passes CI</p>`);
    expect(chips(nodes)).toEqual([
      { tracker: "gitlab", text: "!42", href: "/mr/heka%2Fplatform!42" },
      { tracker: "gitlab", text: "!42", href: "/mr/heka%2Fplatform!42" },
    ]);
  });

  it("turns a Linear identifier into a link to the issue, addressed in the workspace", () => {
    const nodes = body("<p>STMN-3439 is the follow-up</p>");
    expect(chips(nodes)).toEqual([
      {
        tracker: "linear",
        text: "STMN-3439",
        href: "https://linear.app/heka-internal/issue/STMN-3439",
      },
    ]);
  });

  it("leaves a word that only LOOKS like an identifier alone", () => {
    // The rule the team keys exist for. Each of these has an identifier's shape and names no
    // issue, and a link to nothing is worse than the word it replaced.
    for (const word of ["UTF-8", "SHA-1", "RFC-2119", "AES-256", "ISO-8601", "COVID-19"]) {
      const nodes = body(`<p>see ${word} for the details</p>`);
      expect(chips(nodes), word).toEqual([]);
      expect(text(nodes)).toContain(word);
    }
  });

  it("leaves a bare `!42` alone when nothing says which project it is in", () => {
    const nodes = body("<p>!42 is ready</p>");
    expect(chips(nodes)).toEqual([]);
    expect(text(nodes)).toBe("!42 is ready");
  });

  it("resolves a bare `!42` against the project the SURFACE is about", () => {
    // The merge-request page and its diff: GitLab's own rule for a reference inside a project.
    const nodes = body("<p>same as !7</p>", { ...VOCAB, project: "heka/platform" });
    expect(chips(nodes)).toEqual([
      { tracker: "gitlab", text: "!7", href: "/mr/heka%2Fplatform!7" },
    ]);
  });

  it("takes a full reference's own project over everything else", () => {
    const nodes = body("<p>ported from other/repo!8</p>", { ...VOCAB, project: "heka/platform" });
    expect(chips(nodes)).toEqual([
      { tracker: "gitlab", text: "other/repo!8", href: "/mr/other%2Frepo!8" },
    ]);
  });

  it("never reads a reference out of code", () => {
    // An answer explaining what `!42` means must not link to somebody's branch while it does so.
    const nodes = body("<p>write <code>!42</code> or <code>STMN-3439</code></p>");
    expect(chips(nodes)).toEqual([]);
    const fenced = body("<pre><code>git log !42 STMN-3439</code></pre>");
    expect(chips(fenced)).toEqual([]);
  });

  it("keeps the words around a reference, and the punctuation against it", () => {
    const nodes = body("<p>(STMN-3439), and !42.</p>", { ...VOCAB, project: "heka/platform" });
    expect(chips(nodes).map((chip) => chip.text)).toEqual(["STMN-3439", "!42"]);
    expect(text(nodes)).toBe("(STMN-3439), and !42.");
  });

  it("is not fooled by a reference that is a piece of something longer", () => {
    // `wow!42` is punctuation and a number, a path segment is part of a path, an address is an
    // address, and a hyphenated compound is one word. A whole `STMN-34390` IS an identifier —
    // that is issue 34390 — so the boundary is what is checked here, never the length.
    const nodes = body(
      "<p>wow!42 and a/b/c/STMN-3439 and me@STMN-3439 and STMN-3439-rebased</p>",
      VOCAB,
    );
    expect(chips(nodes)).toEqual([]);
  });

  it("reads the same reference in every shape one body can carry it", () => {
    // A list item, a bold run, a quote: the walk reaches the words wherever they are.
    const nodes = body(
      `<ul><li>fixes STMN-3439</li></ul><p><strong>!42</strong></p>` +
        `<blockquote><p>STMN-3439</p></blockquote>`,
      { ...VOCAB, project: "heka/platform" },
    );
    expect(chips(nodes).map((chip) => chip.text)).toEqual(["STMN-3439", "!42", "STMN-3439"]);
  });

  it("is idempotent, so a second pass over a marked tree changes nothing", () => {
    const once = body("<p>STMN-3439</p>");
    expect(markTrackerRefs(once, VOCAB)).toEqual(once);
  });

  it("returns the very same tree when there is nothing to mark", () => {
    // What lets a caller memoize on identity, and what keeps every other surface untouched.
    const parsed = parseMessageBody("<p>nothing to see here</p>", "html");
    expect(markTrackerRefs(parsed, VOCAB)).toBe(parsed);
  });
});

describe("a reference written as a link", () => {
  it("draws a merge request URL as the chip, aimed at this app's own page", () => {
    const nodes = body(`<p>please look at <a href="${MR_URL}">${MR_URL}</a></p>`);
    expect(chips(nodes)).toEqual([
      { tracker: "gitlab", text: "!42", href: "/mr/heka%2Fplatform!42" },
    ]);
  });

  it("keeps the LABEL an author gave their own link", () => {
    // Their words are theirs. The chip adds a mark and a target, and replaces nothing.
    const nodes = body(`<p><a href="${MR_URL}">the release branch</a></p>`);
    expect(chips(nodes)).toEqual([
      { tracker: "gitlab", text: "the release branch", href: "/mr/heka%2Fplatform!42" },
    ]);
  });

  it("draws a Linear issue URL as the chip, aimed at Linear", () => {
    const nodes = body(`<p><a href="${ISSUE_URL}">${ISSUE_URL}</a></p>`);
    expect(chips(nodes)).toEqual([{ tracker: "linear", text: "STMN-3439", href: ISSUE_URL }]);
  });

  it("recognises a Linear link with no workspace read at all", () => {
    // The URL carries the workspace, so a link never needed the read a bare identifier does.
    const nodes = body(`<p>${ISSUE_URL}</p>`, { gitlabHost: GITLAB_HOST, linear: null });
    expect(chips(nodes)).toEqual([{ tracker: "linear", text: "STMN-3439", href: ISSUE_URL }]);
  });

  it("leaves an ordinary link alone", () => {
    const nodes = body('<p><a href="https://example.com/a">https://example.com/a</a></p>');
    expect(chips(nodes)).toEqual([]);
  });

  it("leaves a GitLab link on another host alone", () => {
    // The host pinning: the backend's token lives behind it, and a page must not offer an
    // address for a merge request this machine cannot read.
    const elsewhere = "https://gitlab.example.org/a/b/-/merge_requests/1";
    expect(chips(body(`<p><a href="${elsewhere}">${elsewhere}</a></p>`))).toEqual([]);
  });

  it("claims only a merge request on the GitLab side", () => {
    // An issue and a project have pages in GitLab and none here, so their links stay links.
    for (const path of ["/-/issues/7", "/-/pipelines/9", ""]) {
      const url = `https://${GITLAB_HOST}/heka/platform${path}`;
      expect(chips(body(`<p><a href="${url}">${url}</a></p>`)), url).toEqual([]);
    }
  });
});

describe("what a machine can recognise", () => {
  it("recognises nothing when neither tracker is configured", () => {
    const nodes = body(`<p>STMN-3439 and ${MR_URL}</p>`, { gitlabHost: "", linear: null });
    expect(chips(nodes)).toEqual([]);
  });

  it("recognises no bare identifier while the workspace is unknown", () => {
    // A hopeful guess would draw a chip pointing at a workspace nobody named.
    const nodes = body("<p>STMN-3439</p>", { gitlabHost: GITLAB_HOST, linear: null });
    expect(chips(nodes)).toEqual([]);
  });

  it("recognises no bare identifier for a team the workspace does not hold", () => {
    const nodes = body("<p>ENG-7</p>");
    expect(chips(nodes)).toEqual([]);
  });
});

describe("the project a THREAD puts a bare reference in", () => {
  /** A thread in reading order, oldest first, the way `threadProjects` takes one. */
  function thread(...bodies: string[]): (readonly [string, string])[] {
    return bodies.map((body, i) => [`m${i}`, body] as const);
  }

  it("carries the project forward from the message that named it", () => {
    // Measured on the tenant: the link is pasted ONCE, and every message after it — the
    // reader's own words and every answer an agent writes — says `!298`.
    const projects = threadProjects(
      thread(`<p>can you look at ${MR_URL}</p>`, "<p>@claude review it</p>", "<p>!42 is fine</p>"),
      VOCAB,
    );
    expect(projects.get("m0")).toBe("heka/platform");
    expect(projects.get("m2")).toBe("heka/platform");
  });

  it("never looks forward", () => {
    // A project named later says nothing about a reference written before it.
    const projects = threadProjects(thread("<p>!42 is fine</p>", `<p>${MR_URL}</p>`), VOCAB);
    expect(projects.has("m0")).toBe(false);
    expect(projects.get("m1")).toBe("heka/platform");
  });

  it("moves with the thread, and a message's own project wins", () => {
    // "The merge request we are talking about" is the nearest one, which is how a reader
    // resolves it themselves.
    const projects = threadProjects(
      thread(`<p>${MR_URL}</p>`, "<p>and other/repo!8 too</p>", "<p>!9 next</p>"),
      VOCAB,
    );
    expect(projects.get("m1")).toBe("other/repo");
    expect(projects.get("m2")).toBe("other/repo");
  });

  it("names nothing when the machine has no GitLab host", () => {
    expect(threadProjects(thread(`<p>${MR_URL}</p>`), { gitlabHost: "", linear: null }).size).toBe(
      0,
    );
  });

  it("reads a project out of a raw body, href and all", () => {
    // The thread asks this of every message it holds, so it reads the TEXT rather than a parsed
    // tree — and an `href` is text too.
    expect(projectNamedInText(`<a href="${MR_URL}">the branch</a>`, VOCAB)).toBe("heka/platform");
    expect(projectNamedInText("<p>nothing here</p>", VOCAB)).toBeNull();
  });
});

describe("the pieces the surfaces share", () => {
  it("addresses this app's own merge-request page the way the route does", () => {
    // One spelling of that address in this app: `mergeRequestId`'s.
    expect(mergeRequestPath("heka/platform", 42)).toBe("/mr/heka%2Fplatform!42");
  });

  it("reads a Linear issue URL the way the backend does", () => {
    expect(linearIssueFromUrl(ISSUE_URL)?.identifier).toBe("STMN-3439");
    // Without a slug, and hand-typed in lower case.
    expect(linearIssueFromUrl("https://linear.app/acme/issue/eng-7")?.identifier).toBe("ENG-7");
    // A project, a document, another host: none is an issue.
    expect(linearIssueFromUrl("https://linear.app/acme/project/thing-abc123")).toBeNull();
    expect(linearIssueFromUrl("https://linear.app.evil.com/acme/issue/ENG-7")).toBeNull();
    expect(linearIssueFromUrl("http://linear.app/acme/issue/ENG-7")).toBeNull();
  });

  it("names the tracker a URL belongs to, and neither for anything else", () => {
    expect(trackerRefFromUrl(MR_URL, VOCAB)?.tracker).toBe("gitlab");
    expect(trackerRefFromUrl(ISSUE_URL, VOCAB)?.tracker).toBe("linear");
    expect(trackerRefFromUrl("https://example.com", VOCAB)).toBeNull();
  });

  it("finds the project a body's own words put a bare reference in", () => {
    const parsed = parseMessageBody(`<p>see <a href="${MR_URL}">${MR_URL}</a></p>`, "html");
    expect(projectNamedIn(parsed, VOCAB)).toBe("heka/platform");
    // A full reference names one too, and a body that names none answers null.
    expect(projectNamedIn(parseMessageBody("<p>other/repo!8</p>", "html"), VOCAB)).toBe(
      "other/repo",
    );
    expect(projectNamedIn(parseMessageBody("<p>nothing</p>", "html"), VOCAB)).toBeNull();
  });
});

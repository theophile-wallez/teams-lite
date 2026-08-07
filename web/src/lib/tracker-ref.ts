// A tracker reference in somebody's words: a Linear issue, or a GitLab merge request.
//
// The trackers this app reads are the ones the user works in, so their vocabulary turns up
// in everything written here — an agent's answer ("!42 is ready, it closes STMN-3439"), a
// colleague's message, a merge request's own description. Written out it is a word; read as
// a reference it is one press away from the thing it names. That press is the whole feature:
//
//   * a LINEAR issue goes to Linear, wearing Linear's own mark, because this app holds no
//     issue page of its own — the card a link earns is as far as it goes;
//   * a GitLab MERGE REQUEST goes to THIS APP's own merge-request page (§ The GitLab page),
//     wearing the tanuki, because that page is where the reader is going anyway: the diff,
//     the pipeline, the conversation and the merge are all on it.
//
// It is recognised from the WORDS, never from markup, and that is the same choice
// `agent-tag.ts` makes for a `@claude` prefix and `agent-message.ts` for a reply's
// signature. A reference carries no markup anywhere: an agent writes `!42` because that is
// what a person writes, a colleague types `STMN-3439` from their phone, and GitLab hands us
// the author's own text. So there is nothing to restore — the words are read the way the
// trackers themselves read them, which is what makes every message ever written render as
// one.
//
// Five rules hold it, and each is pinned by a test in tracker-ref.test.ts:
//
//   * **A reference nothing can address stays the text it is.** A `!42` in a body that names
//     no project, an `ENG-123` on a machine whose Linear workspace was never read, a GitLab
//     URL on another host: each stays the word it was. That is the rule `agent_markdown`'s
//     @mention already follows — a name the thread does not hold is plain text — and here it
//     is also what stops `UTF-8`, `SHA-1` and `ISO-8601` from becoming links to nothing.
//   * **The words are never replaced by other words.** A chip shows the reference the author
//     wrote, or the label they gave their own link. The one text this ever drops is a bare
//     URL turned into that URL's own short reference, which is the case where the words ARE
//     the address.
//   * **A reference inside code is code.** The scan skips a `code` / `pre` subtree, exactly
//     as a mention does: an answer explaining what `!42` means must not link to somebody's
//     branch while it does so.
//   * **A bare `!42` belongs to the CONTAINING project.** That is GitLab's own rule, so the
//     surface says which project that is (the open merge request), and a body with no
//     surface of its own — a chat message, an agent's answer — resolves it against the
//     project its own links name.
//   * **Only a merge request is claimed on the GitLab side.** `#123` (an issue) and `&5` (an
//     epic) are GitLab references too, and this app has a page for neither, so they are left
//     alone rather than sent to a page that would say "not built yet".
//
// Everything here is pure — no DOM, no network, no React — so what a body offers is decided
// by unit-tested rules rather than by whatever a component happened to see.

import { mergeRequestId } from "./gitlab-mr";
import { LINEAR_WEB_HOST } from "./linear";
import { mergeRequestFromUrl } from "./merge-request";
import type { LinearWorkspace } from "./protocol";
import { nodeText, trimUrlPunctuation, type RichNode } from "./rich-text";

/** What one surface reads references with: the trackers this machine is configured for, and
 *  the project the surface's own words belong to. */
export type TrackerVocabulary = {
  /** The configured GitLab host — the pin the backend's token lives behind. A URL on any
   *  other host names no merge request here (see `mergeRequestFromUrl`). */
  gitlabHost: string;
  /** The Linear workspace, or null while it is unknown: no key, a key Linear refused, or a
   *  backend too old to answer. Null means no bare identifier is recognised, which is the
   *  reading every unanswered capability takes in this app. */
  linear: LinearWorkspace | null;
  /** The GitLab project this surface is about, when it is about one: the merge request whose
   *  description and comments are on screen. It is what a bare `!42` means there. */
  project?: string | null;
};

/** One reference, resolved. */
export type TrackerRef =
  | {
      tracker: "linear";
      /** `STMN-3439`, upper-cased the way Linear writes it. */
      reference: string;
      /** Linear's own address for the issue. */
      href: string;
    }
  | {
      tracker: "gitlab";
      /** GitLab's own short reference, `!42`. */
      reference: string;
      /** THIS APP's merge-request page for it (`/mr/<project>!<iid>`), which is the whole
       *  point of recognising one. */
      href: string;
      projectPath: string;
      iid: number;
    };

/** A candidate reference. Four alternatives, in the order that keeps the others honest:
 *
 *   1. a URL, taken whole — so the `/-/merge_requests/42` inside one is never read as a
 *      bare `!42`, and a Linear link's own path never as an identifier;
 *   2. a FULL GitLab reference, `group/sub/project!42`, which names its own project;
 *   3. a BARE `!42`, which names the project the words belong to;
 *   4. a Linear identifier, `STMN-3439`.
 */
const CANDIDATE = new RegExp(
  [
    // 1. a URL
    /https?:\/\/[^\s<>"'`[\]]+/.source,
    // 2. `group/sub/project!42` — a project path, which must hold at least one `/`
    /[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+![0-9]{1,9}/.source,
    // 3. `!42`
    /![0-9]{1,9}/.source,
    // 4. `STMN-3439`
    /[A-Z][A-Z0-9]{0,9}-[0-9]{1,9}/.source,
  ].join("|"),
);

/** What may not sit immediately before a reference: a `!` after a word is punctuation
 *  ("wow!42"), and a letter, digit, `-`, `/` or `@` before either kind means the reference is
 *  a piece of something longer — a path, a hyphenated compound, an address. */
const BEFORE = /[\p{L}\p{N}_!/@.-]/u;

/** And what may not sit immediately after one: `ENG-123-4` and `ENG-1234` are not `ENG-123`,
 *  and `!42x` is not a merge request. */
const AFTER = /[\p{L}\p{N}_-]/u;

/** True for a candidate that is a URL rather than a reference written as words. */
function isUrl(candidate: string): boolean {
  return /^https?:/i.test(candidate);
}

/**
 * The Linear issue a URL names, or null. A port of the issue arm of `linear::parse_url`
 * (src/linear.rs), keeping both of its rails: the host is Linear's own fixed one, and the
 * identifier is upper-cased so a hand-typed link reads like Linear's own.
 *
 * A project and a document are deliberately not claimed: neither has a short reference a
 * chip could show, so a link to one stays the link it is.
 */
export function linearIssueFromUrl(url: string): { identifier: string; url: string } | null {
  const match = /^https:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!match) return null;
  const host = (match[1] ?? "").split("@").pop()?.split(":")[0]?.toLowerCase() ?? "";
  if (host !== LINEAR_WEB_HOST) return null;
  // `linear.app/<workspace>/issue/<TEAM-123>[/<slug>]`: the workspace is a segment of the
  // address, so the identifier is only ever the third.
  const segments = (match[2] ?? "").split("/").filter(Boolean);
  if (segments[1] !== "issue") return null;
  const raw = segments[2] ?? "";
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}-[0-9]{1,9}$/.test(raw)) return null;
  return { identifier: raw.toUpperCase(), url };
}

/** The app's own page for one merge request. The route is `/mr/$mergeRequestId` and the id is
 *  `mergeRequestId`'s, so a chip and the GitLab sidebar's own press land on one address. */
export function mergeRequestPath(projectPath: string, iid: number): string {
  return `/mr/${mergeRequestId({ projectPath, iid })}`;
}

/** The reference a URL names, whichever tracker it belongs to, or null when it names
 *  neither. */
export function trackerRefFromUrl(url: string, vocab: TrackerVocabulary): TrackerRef | null {
  const issue = linearIssueFromUrl(url);
  if (issue) return { tracker: "linear", reference: issue.identifier, href: issue.url };
  const mr = mergeRequestFromUrl(url, vocab.gitlabHost);
  if (!mr) return null;
  return {
    tracker: "gitlab",
    reference: mr.reference,
    href: mergeRequestPath(mr.projectPath, mr.iid),
    projectPath: mr.projectPath,
    iid: mr.iid,
  };
}

/** The issue a bare identifier names in this workspace, or null when it names none.
 *
 *  The team key is what makes this honest rather than a guess about the shape of a word:
 *  `UTF-8`, `SHA-1`, `RFC-2119` and `AES-256` all have an identifier's shape and name no
 *  issue, and a link to nothing is worse than the word it replaced. */
function linearRefFromIdentifier(
  identifier: string,
  workspace: LinearWorkspace | null,
): TrackerRef | null {
  if (!workspace || workspace.url_key.trim() === "") return null;
  const reference = identifier.toUpperCase();
  const key = reference.slice(0, reference.lastIndexOf("-"));
  if (!workspace.team_keys.some((known) => known.toUpperCase() === key)) return null;
  return {
    tracker: "linear",
    reference,
    // The address `linear::issue_url` writes. Read from the real workspace on 2026-08-07:
    // Linear's own `url` for an issue whose title carries no slug is exactly this, and the
    // slug it appends when there is one is decoration —
    // `examples/linear_workspace_recon.rs` is what re-measures that.
    href: `https://${LINEAR_WEB_HOST}/${workspace.url_key}/issue/${reference}`,
  };
}

/** The merge request a `!42` — bare, or with its own project in front of it — names, or null
 *  when there is no project to put behind it. */
function mergeRequestRefFromReference(
  candidate: string,
  containingProject: string | null,
): TrackerRef | null {
  const cut = candidate.lastIndexOf("!");
  const projectPath = candidate.slice(0, cut) || (containingProject ?? "");
  const iid = Number(candidate.slice(cut + 1));
  if (projectPath.trim() === "" || !Number.isInteger(iid) || iid <= 0) return null;
  return {
    tracker: "gitlab",
    reference: `!${iid}`,
    href: mergeRequestPath(projectPath, iid),
    projectPath,
    iid,
  };
}

/** One candidate in a line: the text, and where it sits. */
type Candidate = { text: string; start: number; end: number };

/** Every candidate in one line, with the boundary rules applied.
 *
 *  A fresh regex per call rather than one sticky module-level object: the scan is used from
 *  two places and one of them stops early, and a shared `lastIndex` is exactly the kind of
 *  state that makes a parser answer differently the second time it is asked. */
function candidates(text: string): Candidate[] {
  const scanner = new RegExp(CANDIDATE.source, "g");
  const found: Candidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(text)) !== null) {
    const candidate = match[0];
    const start = match.index;
    const end = start + candidate.length;
    // A URL is delimited by whitespace and needs no boundary rule; everything else is a word
    // among words.
    if (!isUrl(candidate)) {
      if (BEFORE.test(text[start - 1] ?? "")) continue;
      if (AFTER.test(text[end] ?? "")) continue;
    }
    found.push({ text: candidate, start, end });
  }
  return found;
}

/**
 * The project a body's own words put a bare `!42` in: the first merge request it names in
 * full — as a URL, or as a `group/project!7` reference.
 *
 * It is the fallback for a surface that names no project of its own, which is every chat
 * message: "look at <url> — !12 is the follow-up" is one thought about one project, and
 * GitLab's own rule for a bare reference is the containing project. A body that names none
 * leaves `!42` the word it is.
 */
export function projectNamedIn(nodes: RichNode[], vocab: TrackerVocabulary): string | null {
  for (const node of nodes) {
    if (node.type === "text") {
      for (const candidate of candidates(node.text)) {
        if (isUrl(candidate.text)) {
          const ref = trackerRefFromUrl(trimUrlPunctuation(candidate.text), vocab);
          if (ref?.tracker === "gitlab") return ref.projectPath;
          continue;
        }
        const cut = candidate.text.lastIndexOf("!");
        if (cut > 0) return candidate.text.slice(0, cut);
      }
      continue;
    }
    if (node.tag === "a" && node.attrs.href) {
      const ref = trackerRefFromUrl(node.attrs.href, vocab);
      if (ref?.tracker === "gitlab") return ref.projectPath;
    }
    const inside = projectNamedIn(node.children, vocab);
    if (inside) return inside;
  }
  return null;
}

/** A reference node: the chip the renderer draws, carrying the author's own words as its text
 *  so anything that does not know the tag still shows what was written. */
function refNode(ref: TrackerRef, children: RichNode[]): RichNode {
  return {
    type: "element",
    tag: "trackerRef",
    attrs: {
      tracker: ref.tracker,
      reference: ref.reference,
      href: ref.href,
      ...(ref.tracker === "gitlab" ? { project: ref.projectPath } : {}),
    },
    children,
  };
}

/** One text node with every reference in it marked, or null when it holds none — so an
 *  untouched tree comes back as the same tree. */
function markText(
  text: string,
  vocab: TrackerVocabulary,
  containingProject: string | null,
): RichNode[] | null {
  let out: RichNode[] | null = null;
  let at = 0;
  for (const candidate of candidates(text)) {
    // A candidate inside the span already consumed cannot be a reference of its own.
    if (candidate.start < at) continue;
    // A bare URL is the one case where the words ARE the address, so the chip may show the
    // short reference instead of ninety characters of path. Whatever punctuation the URL rule
    // trimmed stays text: "(…!42)" keeps its bracket.
    const written = isUrl(candidate.text) ? trimUrlPunctuation(candidate.text) : candidate.text;
    const ref = isUrl(candidate.text)
      ? trackerRefFromUrl(written, vocab)
      : candidate.text.includes("!")
        ? mergeRequestRefFromReference(candidate.text, containingProject)
        : linearRefFromIdentifier(candidate.text, vocab.linear);
    if (!ref) continue;
    out ??= [];
    const lead = text.slice(at, candidate.start);
    if (lead.length > 0) out.push({ type: "text", text: lead });
    const label = isUrl(candidate.text) ? ref.reference : written;
    out.push(refNode(ref, [{ type: "text", text: label }]));
    at = candidate.start + written.length;
  }
  if (!out) return null;
  const tail = text.slice(at);
  if (tail.length > 0) out.push({ type: "text", text: tail });
  return out;
}

/**
 * The same tree with every tracker reference in it drawn as a chip.
 *
 * Three kinds of node are treated differently, each for a stated reason:
 *
 *  - a `code` or `pre` subtree is left ALONE, because a reference quoted as syntax is syntax;
 *  - an `a` whose href names a reference BECOMES the chip — keeping the author's own label
 *    when they gave one, and taking the short reference when the label was only the URL — so
 *    a merge request linked anywhere lands on this app's own page;
 *  - a text node is scanned for the references its words carry.
 *
 * An `a` that names nothing is untouched, so an ordinary link keeps its favicon.
 */
export function markTrackerRefs(nodes: RichNode[], vocab: TrackerVocabulary): RichNode[] {
  const canReadGitLab = vocab.gitlabHost.trim() !== "";
  const canReadLinear = !!vocab.linear && vocab.linear.url_key.trim() !== "";
  if (!canReadGitLab && !canReadLinear) return nodes;
  // The surface's own project wins over the body's: on the merge-request page a bare `!42`
  // means THIS project, which is GitLab's own rule, and a link to somewhere else in the same
  // paragraph does not move it.
  const containingProject = vocab.project?.trim() || projectNamedIn(nodes, vocab);
  return markNodes(nodes, vocab, containingProject);
}

/** The walk itself. Returns the SAME array when nothing changed, which is what lets a caller
 *  memoize on identity. */
function markNodes(
  nodes: RichNode[],
  vocab: TrackerVocabulary,
  containingProject: string | null,
): RichNode[] {
  let changed = false;
  const out: RichNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const marked = markText(node.text, vocab, containingProject);
      if (!marked) {
        out.push(node);
        continue;
      }
      out.push(...marked);
      changed = true;
      continue;
    }
    // Code is code; and a chip is never re-read, which is what keeps this idempotent.
    if (node.tag === "code" || node.tag === "pre" || node.tag === "trackerRef") {
      out.push(node);
      continue;
    }
    if (node.tag === "a") {
      const ref = node.attrs.href ? trackerRefFromUrl(node.attrs.href, vocab) : null;
      if (!ref) {
        out.push(node);
        continue;
      }
      // The label an author gave their own link is their words, so it stays. An anchor whose
      // text IS its address has no label to keep, and the reference reads better than the URL.
      const label = nodeText([node]).trim();
      const bare = label === "" || label === node.attrs.href;
      out.push(refNode(ref, bare ? [{ type: "text", text: ref.reference }] : node.children));
      changed = true;
      continue;
    }
    const children = markNodes(node.children, vocab, containingProject);
    if (children === node.children) {
      out.push(node);
      continue;
    }
    out.push({ ...node, children });
    changed = true;
  }
  return changed ? out : nodes;
}

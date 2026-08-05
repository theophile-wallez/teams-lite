// A merge request named in a message, and the two things the ⋯ menu then offers.
//
// A GitLab link in a chat message is already enriched into a card (see
// components/gitlab-link-card.tsx). This is the other half of that: a merge request is
// something the reader is being ASKED for — "can you look at this before the release?" —
// so its message carries two actions nothing else in the thread does. Reviewing it with
// one of the machine's agents, and approving it.
//
// The parse is a port of the merge-request half of `gitlab::parse_url` (src/gitlab.rs)
// and keeps its two rails:
//
//   - **The host must be the configured one.** That is the pin the backend's token
//     lives behind, and a menu offering an action for a link on another host would be
//     offering something the backend refuses.
//   - **Only `/-/merge_requests/<iid>` counts.** An issue, a project, a commit and a
//     pipeline are not approvable and not what "review this" means.
//
// Everything here is pure — no network, no DOM — so what a message offers is decided by
// unit-tested rules rather than by whatever a card happened to resolve to.

/** One merge request a message names. */
export type MergeRequestLink = {
  /** The link as it appeared in the message: what the backend is asked about, and what
   *  the agent is pointed at. */
  url: string;
  /** Full project path, "group/sub/project". */
  projectPath: string;
  iid: number;
  /** GitLab's short human reference, "!42". What a menu row and a report name, because
   *  a URL in a menu is unreadable. */
  reference: string;
};

/** The lowercased host of an `https://` URL, or `null` for anything else. Mirrors
 *  `split_host_path` in src/gitlab.rs: userinfo and port are dropped, and a non-https
 *  URL is not a GitLab link at all — the token never reaches one. */
function httpsHost(url: string): string | null {
  const match = /^https:\/\/([^/?#]+)/i.exec(url);
  if (!match) return null;
  const authority = match[1] ?? "";
  const hostPort = authority.split("@").pop() ?? "";
  const host = hostPort.split(":")[0] ?? "";
  return host === "" ? null : host.toLowerCase();
}

/**
 * The merge request `url` names on `gitlabHost`, or `null` when it names none.
 *
 * A trailing tab, a diff path or a query string is kept out of the parse the way the
 * backend keeps it out: the iid is the segment straight after `merge_requests`, and
 * anything after it is the reader's own position in the page.
 */
export function mergeRequestFromUrl(url: string, gitlabHost: string): MergeRequestLink | null {
  const host = gitlabHost.trim().toLowerCase();
  if (host === "" || httpsHost(url) !== host) return null;

  const path = /^https:\/\/[^/?#]+([^?#]*)/i.exec(url)?.[1] ?? "";
  const segments = path.split("/").filter(Boolean);
  const dash = segments.indexOf("-");
  // The project path is everything before GitLab's `/-/` marker, and it must be
  // non-empty: `/-/merge_requests/1` names no project.
  if (dash < 1) return null;
  const rest = segments.slice(dash + 1);
  if (rest[0] !== "merge_requests") return null;
  const raw = rest[1] ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const iid = Number(raw);
  return {
    url,
    projectPath: segments.slice(0, dash).join("/"),
    iid,
    reference: `!${iid}`,
  };
}

/** The merge requests a list of links names, in the order they appeared, one entry per
 *  URL. A message quoting the same link twice offers one action, not two. */
export function mergeRequestsIn(
  urls: readonly string[],
  gitlabHost: string,
): MergeRequestLink[] {
  const out: MergeRequestLink[] = [];
  for (const url of urls) {
    const mr = mergeRequestFromUrl(url, gitlabHost);
    if (mr && !out.some((known) => known.url === mr.url)) out.push(mr);
  }
  return out;
}

/**
 * What the composer says after the agent's tag when "Review with <agent>" is picked on
 * an empty composer.
 *
 * It names the merge request in FULL, reference and URL, for the same reason
 * `ANSWER_REQUEST` says "this message": the prompt has to name what it is about. The
 * reference alone means nothing outside the project, and the URL alone is what the agent
 * needs to go and read it.
 *
 * A half-written draft still wins (see `answerRequest`): the user's own sentence is the
 * request, and the message being replied to carries the link anyway.
 */
export function reviewRequest(mr: MergeRequestLink): string {
  return `Review this merge request: ${mr.reference} ${mr.url}`;
}

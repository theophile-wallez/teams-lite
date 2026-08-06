// A PICTURE in a merge request's description or comment: which one it is, and whether this app
// can draw it at all.
//
// An author pastes a screenshot into a GitLab description and GitLab writes
// `![image.png](/uploads/<secret>/image.png){width=777 height=312}` — a RELATIVE path into the
// project's own uploads, and an optional attribute block. Rendered as ordinary markdown that
// is a link nobody can follow, so the page used to print the whole thing as text.
//
// Three measured facts decide what happens here (`examples/merge_request_image_recon.rs`,
// READ-ONLY over the 40 newest open merge requests of `git.sia.partners`, 2026-08-06):
//
//   * every image in a DESCRIPTION was a relative `/uploads/…` — and it carried the
//     `{width=… height=…}` block;
//   * every image in a COMMENT was an absolute URL on ANOTHER host (a badge, a screenshot
//     host). Those stay LINKS: fetching one would tell that host the user read this page,
//     which is the read receipt § Mail strips out of every body;
//   * the upload's bytes are served by GitLab's own API route and by nothing else. The web
//     path the markdown writes answers 404 — to the header token, to `?private_token=`, and to
//     no credential at all — so the browser could never draw it whatever this app did.
//
// So an upload becomes a node the RENDERER loads over the socket (`gitlab_mr_upload`, which is
// an ordinary read of the page), and the promise § The GitLab page is written under holds
// unchanged: nothing on this page is fetched from GitLab by the browser.

import { element, type InlineImage, type InlineOptions } from "./markdown-inline";
import type { RichNode } from "./rich-text";

/** Which upload a picture is. The three parts together are the whole address, and the BACKEND
 *  spells the endpoint from them — so no client can aim the token at an address this app did
 *  not name (the rail a comment's own position already follows). */
export type UploadRef = {
  /** The project the upload belongs to, GitLab's `group/sub/project`. */
  project: string;
  /** GitLab's own secret for the file, which is the whole authorization to read it. */
  secret: string;
  filename: string;
};

/** A project upload path, as GitLab's markdown writes one. The secret is hex — GitLab mints it
 *  with `SecureRandom.hex(16)`, 32 characters on this instance — and the filename is one
 *  segment, so neither part can address anything but one upload of one project. */
const UPLOAD_PATH = /^\/uploads\/([0-9a-f]{16,64})\/([^/?#]+)$/i;

/** Which upload `url` names, or `null` when it names none: an absolute URL, a repository file,
 *  a wiki page, anything whose shape is not GitLab's own upload path. */
export function parseUploadPath(url: string, project: string): UploadRef | null {
  const match = UPLOAD_PATH.exec(url.trim());
  if (!match || !project.trim()) return null;
  const filename = decodeFilename(match[2]!);
  if (!filename) return null;
  return { project: project.trim(), secret: match[1]!, filename };
}

/** The name the file really has. GitLab percent-encodes a space and a parenthesis into the
 *  path, and the backend encodes the name again when it builds the endpoint — so decoding here
 *  is what keeps `screen shot (2).png` from being asked for as `screen%2520shot`. A name that
 *  is not valid encoding is taken as the literal text it is. */
function decodeFilename(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The one key a picture is cached under, in the page's own blob cache. It names the upload
 *  and nothing about where it was drawn, so the same screenshot in a description and in a
 *  comment is fetched once. */
export function uploadKey(ref: UploadRef): string {
  return `gitlab:${ref.project}:${ref.secret}/${ref.filename}`;
}

/** What a `gitlabImage` node holds, read back out of one. */
export function uploadOf(attrs: {
  project?: string;
  secret?: string;
  filename?: string;
}): UploadRef | null {
  const { project, secret, filename } = attrs;
  if (!project || !secret || !filename) return null;
  return { project, secret, filename };
}

/**
 * The image rule the GitLab page parses its markdown with: an upload of THIS project becomes a
 * picture, and every other image is left to the shared scanner's own answer — a link, or the
 * literal text a relative address is.
 *
 * The project is what makes it a closure: the parser is pure and knows nothing about which
 * merge request it is rendering, and an upload path names no project of its own.
 */
export function gitLabMarkdownOptions(project: string | undefined): InlineOptions {
  if (!project) return {};
  return {
    image: (image: InlineImage): RichNode | null => {
      const ref = parseUploadPath(image.url, project);
      if (!ref) return null;
      return element("gitlabImage", [], {
        project: ref.project,
        secret: ref.secret,
        filename: ref.filename,
        alt: image.alt || ref.filename,
        ...(image.width ? { width: image.width } : {}),
        ...(image.height ? { height: image.height } : {}),
      });
    },
  };
}

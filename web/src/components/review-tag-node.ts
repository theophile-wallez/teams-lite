// The composer's REVIEW TAG: one atomic inline node saying which theme or file the question points
// at.
//
// It is the shape `AgentTagNode` already has, for that node's own reasons — and the one rule both
// rest on is worth stating again here, because it is what keeps this feature honest:
//
//   - **IT SERIALIZES TO ITS OWN WORDS.** `renderText` emits exactly what `reviewTagText` writes —
//     `@src/server/health.ts`, `@[A replica is drained…]` — so `editor.getText()` gives the same
//     string a plain textarea gave, and NOTHING downstream changed: `reviewTagsInText` still reads
//     what travels out of the question's own words, the backend still holds every path to the diff,
//     and a question typed by hand with no chip in it works exactly as before. The chip is a way of
//     DRAWING those words, never a second place they live.
//   - **ONE BACKSPACE REMOVES IT WHOLE.** It is `atom: true`, so there is nothing inside to shorten:
//     half a path names no file, and half a bracketed title names no theme. A person's name shrinks
//     by a word because a person can be addressed by their first name; neither of these can.
//   - **It carries no state of its own beyond the tag.** The attrs are the tag, so a chip cannot
//     disagree with what the words say — and a document restored from text alone (the failure
//     hand-back) rebuilds the same chips by re-reading the words.
//
// The drawn chip is a React node view (`review-tag-chip.tsx`), which is the SAME component the sent
// question's bubble draws — so a tag looks one way, before and after the press.

import { Node, ReactNodeViewRenderer } from "@tiptap/react";

import { reviewTagText, type ReviewTag } from "~/lib/gitlab-review";
import { ReviewTagNodeView } from "./review-tag-view";

/** The tag one node holds, or `null` when its attrs cannot be one.
 *
 *  A node is only ever created by this app's own insert, so the guard is about a document restored
 *  from somewhere unexpected rather than about a hostile input — and the safe answer is to draw
 *  nothing rather than a chip naming `undefined`. */
export function tagOfNode(attrs: Record<string, unknown>): ReviewTag | null {
  const kind = String(attrs.kind ?? "");
  const label = String(attrs.label ?? "");
  if (kind === "theme") {
    const index = Number(attrs.index);
    if (!Number.isInteger(index) || index < 0) return null;
    return { kind: "theme", index, label };
  }
  const path = String(attrs.path ?? "");
  if (!path) return null;
  return { kind: "file", path, label: label || path };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    reviewTag: {
      /** Insert a chip for `tag`, replacing the "@…" the reader typed (`from`..`to`).
       *
       *  A trailing space is the caller's business rather than this command's, because whether one is
       *  wanted depends on what follows the range — the rule the textarea's own `pick` already held:
       *  a pick in the middle of a sentence already has a space in front of the next word, and a
       *  second one would be a gap the reader has to delete. */
      insertReviewTag: (options: { tag: ReviewTag; from: number; to: number }) => ReturnType;
    };
  }
}

export const ReviewTagNode = Node.create({
  name: "reviewTag",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      kind: { default: "file" },
      /** A theme's place in the reading, which is how a theme is named everywhere here
       *  (`reviewSectionId`, and the wire's own `themes: number[]`). A title would go stale the
       *  moment a fresh reading renamed it. */
      index: { default: null },
      path: { default: null },
      label: { default: "" },
    };
  },

  // No `parseHTML`: nothing pastes one of these in, and a document is only ever built by the insert
  // below or from TEXT (which rebuilds the chips by re-reading the words). A parse rule would be a
  // second way in with nothing behind it.

  renderHTML({ node }) {
    const tag = tagOfNode(node.attrs);
    // A span whose text IS the tag's own spelling, so anything that reads this document as HTML —
    // a copy, a paste into another field — carries the words rather than an empty element.
    return ["span", { "data-review-tag": "" }, tag ? reviewTagText(tag) : ""];
  },

  /** What `editor.getText()` gives for this node — and therefore what travels.
   *
   *  This is the whole contract with `src/gitlab_review.rs`: the question is a string, the tags are
   *  read back out of it, and a chip is only how those characters are drawn. */
  renderText({ node }) {
    const tag = tagOfNode(node.attrs);
    return tag ? reviewTagText(tag) : "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReviewTagNodeView);
  },

  addCommands() {
    return {
      insertReviewTag:
        ({ tag, from, to }) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContentAt(
              { from, to },
              {
                type: this.name,
                attrs:
                  tag.kind === "theme"
                    ? { kind: "theme", index: tag.index, label: tag.label }
                    : { kind: "file", path: tag.path, label: tag.label },
              },
            )
            .run(),
    };
  },
});

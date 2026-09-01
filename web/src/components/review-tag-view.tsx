import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";

import { ReviewTagChip } from "./review-tag-chip";
import { tagOfNode } from "./review-tag-node";

/**
 * The chip as the COMPOSER draws it, for the atomic node in `review-tag-node.ts`.
 *
 * A node view rather than plain `renderHTML` markup, so the chip is the SAME component the sent
 * question's bubble draws — one piece of artwork rather than two that look alike. The node's
 * `renderText` stays the tag's own spelling, because that is what has to survive into the question
 * that travels.
 *
 * A node whose attrs cannot be a tag draws nothing at all. That is unreachable through this app's own
 * insert; it is here because drawing a chip labelled `undefined` would be worse than drawing none.
 */
export function ReviewTagNodeView(props: ReactNodeViewProps) {
  const tag = tagOfNode(props.node.attrs);
  return (
    // `as="span"`, because a question is a sentence and a block wrapper would break the line at
    // every chip. `contentEditable={false}` is the node view's own: an atom has nothing to type into,
    // and without it a caret can land inside the chip's own text.
    <NodeViewWrapper as="span" className="review-tag-node" contentEditable={false}>
      {tag && <ReviewTagChip tag={tag} />}
    </NodeViewWrapper>
  );
}

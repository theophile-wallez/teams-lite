import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { PackEmoji } from "./custom-emoji";

/**
 * A custom emoji chip in the composer: the art inline with the text, drawn from the
 * blob URL the store holds for that name.
 *
 * The chip's only job is to put the right code in the body. The backend substitutes it
 * server-side, so what travels on the wire is the bare `:shipit:` text the node's
 * `renderHTML` emits (custom-emoji-extension.ts). The art this shows is the preview;
 * what the reader gets is the markup the backend already renders.
 *
 * It is the one pack-art surface that keeps the WHOLE code as its placeholder: it sits in
 * a line of text rather than in a glyph-sized box, and the code is what the user just
 * typed.
 */
export function CustomEmojiChipView(props: ReactNodeViewProps) {
  const name = String(props.node.attrs.name ?? "");

  return (
    <NodeViewWrapper as="span" className="custom-emoji-node">
      <PackEmoji
        name={name}
        className="h-[1.2em] w-auto align-middle"
        placeholder={<span className="text-text-dim">:{name}:</span>}
      />
    </NodeViewWrapper>
  );
}

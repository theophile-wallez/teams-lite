import { useEffect, useState } from "react";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useController } from "./controller-context";

/**
 * A custom emoji chip in the composer: the art inline with the text, drawn from the
 * blob URL the store holds for that name.
 *
 * The chip's only job is to put the right code in the body. The backend substitutes it
 * server-side, so what travels on the wire is the bare `:shipit:` text the node's
 * `renderHTML` emits (custom-emoji-extension.ts). The art this shows is the preview;
 * what the reader gets is the markup the backend already renders.
 */
export function CustomEmojiChipView(props: ReactNodeViewProps) {
  const controller = useController();
  const name = String(props.node.attrs.name ?? "");
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    controller.customEmojiUrl(name).then((result: string | null) => {
      if (active) setUrl(result);
    });
    return () => {
      active = false;
    };
  }, [controller, name]);

  if (!url) {
    return (
      <NodeViewWrapper as="span" className="custom-emoji-node">
        <span className="text-text-dim">:{name}:</span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="custom-emoji-node">
      <img
        src={url}
        alt={`:${name}:`}
        className="inline-block h-[1.2em] w-auto align-middle"
        data-emoji-name={name}
      />
    </NodeViewWrapper>
  );
}

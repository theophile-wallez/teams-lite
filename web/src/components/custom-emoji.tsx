import { useCallback, useEffect, useState } from "react";
import { mediaNeedsProxy } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";

/**
 * A custom emoji from a message: `:shipit:` drawn from the bytes the message
 * itself carries. The `src` is Teams-hosted content (AMS, rewritten at storage
 * to asyncgw), so it goes through the media proxy the way MediaImage does it —
 * the browser has no skypetoken. A glyph, not a picture: sized to the text,
 * no lightbox, no zoom, no download. Falls back to the literal code text
 * (`:shipit:`) when the image cannot be fetched.
 */
export function CustomEmoji(props: {
  src: string;
  code: string;
  jumbo?: boolean;
  className?: string;
}) {
  const controller = useController();
  const proxied = mediaNeedsProxy(props.src);
  const [objectUrl, setObjectUrl] = useState<string | null>(proxied ? null : props.src);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!proxied) {
      setObjectUrl(props.src);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setObjectUrl(null);
    setFailed(false);
    const src = props.src;
    controller.retainMedia(src);
    controller
      .loadMedia(src)
      .then((url) => {
        if (!cancelled) setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.releaseMedia(src);
    };
  }, [controller, props.src, proxied]);

  const onError = useCallback(() => setFailed(true), []);

  if (failed || !objectUrl) {
    return (
      <span aria-hidden className="leading-none">
        {props.code}
      </span>
    );
  }

  const size = props.jumbo ? "size-[2.5em]" : "size-[1.15em]";
  return (
    <img
      src={objectUrl}
      alt={props.code}
      title={props.code}
      aria-hidden
      draggable={false}
      loading="lazy"
      onError={onError}
      className={cn(
        "inline-block select-none object-contain align-[-0.15em]",
        props.className ?? size,
      )}
    />
  );
}

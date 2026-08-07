import { useCallback, useEffect, useState } from "react";
import { mediaNeedsProxy } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";

/**
 * A custom emoji drawn from hosted content: `:shipit:` from the bytes a message
 * carries, or the art a custom reaction's key names. The `src` is Teams-hosted (AMS,
 * rewritten at storage to asyncgw), so it goes through the media proxy the way
 * MediaImage does it — the browser has no skypetoken. A glyph, not a picture: sized to
 * the text, no lightbox, no zoom, no download. Falls back to `label` when the image
 * cannot be fetched.
 *
 * A src that needs no proxy is one of our OWN blob URLs (see {@link PackEmoji}). It can
 * no longer be a stranger's server: `rich-text.ts` refuses to make a custom emoji node
 * out of a src the proxy would not carry, so an emoji `<img>` pointing off-tenant
 * collapses to its text before it ever reaches this component.
 */
export function CustomEmoji(props: {
  src: string;
  /** The words this glyph stands for — its `:code:` where the reader knows it, and a
   *  neutral phrase where the key names only art. Used as `alt`, `title`, and as the
   *  text drawn in its place when the bytes cannot be fetched. */
  label: string;
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
        {props.label}
      </span>
    );
  }

  return (
    <img
      src={objectUrl}
      alt={props.label}
      title={props.label}
      aria-hidden
      draggable={false}
      loading="lazy"
      onError={onError}
      className={cn(
        "inline-block select-none object-contain align-[-0.15em]",
        props.className ?? "size-[1.15em]",
      )}
    />
  );
}

/**
 * One of the user's OWN emoji, drawn from the pack by name — for the surfaces that
 * OFFER an emoji rather than show one somebody already used (the reaction row).
 *
 * The art comes over `custom_emoji_image` and becomes a blob URL the store caches per
 * name, so a row of six costs six requests once and none afterwards. It is deliberately
 * the opposite of {@link CustomEmoji}: this is the pack, which is right for something
 * the user is about to send, and wrong for anything already in a message.
 */
export function PackEmoji(props: { name: string; className?: string }) {
  const controller = useController();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void controller.customEmojiUrl(props.name).then((resolved) => {
      if (alive) setUrl(resolved);
    }).catch(() => {
      if (alive) setUrl(null);
    });
    return () => {
      alive = false;
    };
  }, [controller, props.name]);

  const label = `:${props.name}:`;
  if (!url) {
    return (
      <span aria-hidden className="text-[10px] leading-none text-text-faint">
        {label.slice(0, 3)}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={label}
      title={label}
      aria-hidden
      draggable={false}
      className={cn("inline-block size-[18px] select-none object-contain", props.className)}
    />
  );
}

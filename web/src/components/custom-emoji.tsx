import { useCallback, useEffect, useState } from "react";
import { originalArtUrl } from "~/lib/custom-emoji";
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
 *
 * What is FETCHED is `originalArtUrl(src)` rather than the src itself, which is what makes
 * an animated GIF animate here: AMS serves the rendition a message names as a static
 * frame. The message keeps the src it always carried — see that function for the
 * measurement, and for why the two must not be the same URL.
 */
export function CustomEmoji(props: {
  src: string;
  /** The words this glyph stands for — its `:code:` where the reader knows it, and a
   *  neutral phrase where the key names only art. Used as `alt`, `title`, and as the
   *  text drawn in its place when the bytes cannot be fetched. */
  label: string;
  /** Draw it large, for a message that is nothing but emoji. The bubble decides this and
   *  drops its own chrome in the same breath (see `bodyIsOnlyEmoji`) — a large glyph still
   *  inside a padded bubble reads as an uploaded picture, which is the thing to avoid. */
  jumbo?: boolean;
  className?: string;
}) {
  const controller = useController();
  const src = originalArtUrl(props.src);
  const proxied = mediaNeedsProxy(src);
  const [objectUrl, setObjectUrl] = useState<string | null>(proxied ? null : src);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!proxied) {
      setObjectUrl(src);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setObjectUrl(null);
    setFailed(false);
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
  }, [controller, src, proxied]);

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
        props.className ?? (props.jumbo ? "size-[2.75em]" : "size-[1.15em]"),
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

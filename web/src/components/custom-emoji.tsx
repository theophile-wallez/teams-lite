import { useCallback, useEffect, useState, type ReactNode } from "react";
import { originalArtUrl } from "~/lib/custom-emoji";
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
 * The src is ALWAYS proxied, and that is structural rather than incidental: both callers
 * name a src the proxy would carry — `rich-text.ts` refuses to build a `customEmoji` node
 * out of anything else, and `customReactionArt` refuses a key that carries anything else —
 * so an emoji pointing off-tenant collapses to its text before it reaches this component.
 * `originalArtUrl` only ever moves the RENDITION, never the host, so it cannot take a src
 * off the proxy's list either. One of the user's OWN emoji is a blob URL and a different
 * component ({@link PackEmoji}).
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
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
  }, [controller, src]);

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
        // The size and the caller's own classes are INDEPENDENT: a `className` used to
        // replace the size outright, so passing one silently un-did `jumbo` — two
        // unrelated props, one of them quietly cancelling the other.
        props.jumbo ? "size-[2.75em]" : "size-[1.15em]",
        props.className,
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
 *
 * It is the ONE loader for pack art. There were four — the reaction row, the settings
 * list, the typeahead and the composer's chip each with its own `useState` + effect —
 * and they had already drifted: two spelled their placeholder `:sh:` and one `:sh`, and
 * two of them had no `.catch` at all, so a backend that could not answer left an
 * unhandled rejection per mounted row.
 */
export function PackEmoji(props: {
  name: string;
  className?: string;
  /** Drawn while the art loads, and when the pack cannot serve it. The default is the
   *  code shortened to fit a glyph-sized box; the composer's chip passes the whole
   *  `:code:`, which is what the user typed and which has a line of text to sit in. */
  placeholder?: ReactNode;
}) {
  const controller = useController();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // `customEmojiUrl` REJECTS when its RPC fails, so this catch is not optional.
    controller
      .customEmojiUrl(props.name)
      .then((resolved) => {
        if (alive) setUrl(resolved);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [controller, props.name]);

  const label = `:${props.name}:`;
  if (!url) {
    return (
      props.placeholder ?? (
        <span
          aria-hidden
          className={cn(
            "grid place-items-center text-[10px] leading-none text-text-faint",
            props.className,
          )}
        >
          :{props.name.slice(0, 2)}:
        </span>
      )
    );
  }
  return (
    <img
      src={url}
      alt={label}
      title={label}
      draggable={false}
      // Which emoji this is, for the composer's chip: the node view holds no attributes of
      // its own, so the art is the only place a spec can read the name off.
      data-emoji-name={props.name}
      className={cn("inline-block size-[18px] select-none object-contain", props.className)}
    />
  );
}

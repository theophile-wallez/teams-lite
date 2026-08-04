import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Download04Icon,
  ExternalLinkIcon,
  Film01Icon,
  ImageNotFound01Icon,
  Loading02Icon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { formatCallDuration, mediaNeedsProxy, type Attachment } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";
import { FileTypeIcon } from "./file-type-icon";
import { ImageLightbox } from "./image-lightbox";

/** A picture's own pixel dimensions — what it takes to reserve its space. */
type ImageSize = { width: number; height: number };

/** The natural size of every picture this app has already drawn once, keyed by URL.
 *
 *  It exists because the history is VIRTUALIZED: a row that scrolls out of view
 *  unmounts, and on the way back it mounts again from nothing. Without a memory of
 *  the size, such a row reserves nothing, measures short, and grows again when the
 *  bytes arrive — once per pass, for every picture, which is the jump a reader
 *  scrolling through a thread with images actually sees.
 *
 *  Teams states the size on most inline images (see `imageDimension` in
 *  lib/rich-text.ts) and on no attachment at all, so this is what covers the rest.
 *  It is never invalidated: the bytes behind a hosted-content URL do not change,
 *  and it holds two numbers per URL. */
const naturalSizes = new Map<string, ImageSize>();

/** How tall a picture is ever drawn, and how wide. The reserved box and the loaded
 *  image MUST carry the same pair — that identity is the whole point of the box, so
 *  they are named once here rather than spelled twice. (Written out as literal
 *  Tailwind classes because the scanner reads source text: a class assembled from a
 *  variable is a class Tailwind never generates.) */
const IMAGE_CAPS = "max-h-80 max-w-full";

/**
 * An image from a chat message. Authenticated Teams hosted content (inline
 * images, image attachments on *.teams.microsoft.com / *.skype.com) is fetched
 * through the backend media proxy and rendered from a local blob URL, since the
 * browser lacks the skypetoken. Public images (giphy, the Teams static-asset
 * CDN) are loaded directly by the browser. Shows a placeholder while a proxied
 * image loads and a graceful fallback if the fetch/render fails.
 *
 * **The space a picture will occupy is reserved before it loads**, from the size
 * the message stated (`width`/`height`) or from the size this app measured the last
 * time it drew that URL. This is not a nicety: the history is virtualized and
 * measures each row as it mounts, so a picture that arrives after its row was
 * measured makes the row grow and shoves every row below it — the reader is reading
 * one message and is holding another a frame later. A reserved box makes the
 * before and after the same height, so nothing moves.
 */
export function MediaImage(props: {
  src: string;
  alt?: string;
  /** The picture's own dimensions, when the message stated them. Both or neither:
   *  one side alone states no ratio and reserves nothing. */
  width?: number;
  height?: number;
  className?: string;
}) {
  const controller = useController();
  const proxied = mediaNeedsProxy(props.src);
  // Public images render straight from their URL; proxied ones wait for a blob.
  const [objectUrl, setObjectUrl] = useState<string | null>(proxied ? null : props.src);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const thumbRef = useRef<HTMLImageElement>(null);
  const onClosed = useCallback(() => setZoomed(false), []);

  // The box to hold for this picture: what the message stated, else what we
  // measured last time. Undefined for a picture this app has never drawn and whose
  // message said nothing — the one case that still settles on load, and the case
  // `rememberNaturalSize` turns into a reserved box for every later view.
  const stated =
    props.width !== undefined && props.height !== undefined
      ? { width: props.width, height: props.height }
      : undefined;
  const reserved = stated ?? naturalSizes.get(props.src);

  // Record what the browser resolved, so the next mount of this URL reserves it.
  const rememberNaturalSize = useCallback((el: HTMLImageElement) => {
    if (el.naturalWidth > 0 && el.naturalHeight > 0) {
      naturalSizes.set(props.src, { width: el.naturalWidth, height: el.naturalHeight });
    }
  }, [props.src]);

  useEffect(() => {
    if (!proxied) {
      setObjectUrl(props.src);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setObjectUrl(null);
    setFailed(false);
    // Hold the blob for as long as this view displays it, so the media cache's
    // byte budget can't revoke it from under us (see `evictMedia`).
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

  if (failed) {
    return (
      <div
        data-testid="message-image-error"
        className={cn(
          "flex items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs text-text-dim shadow-chip",
          props.className,
        )}
      >
        <HugeiconsIcon icon={ImageNotFound01Icon} className="size-4 shrink-0" strokeWidth={1.6} />
        <span className="truncate">{props.alt || "Image unavailable"}</span>
      </div>
    );
  }

  if (!objectUrl) {
    return (
      // The picture's own box, held empty. A `span`, not a `div`: this renders
      // inside a rich-text <p>, where only phrasing content is valid.
      //
      // The box is the picture's own WIDTH IN PIXELS plus its ratio, under the same
      // two caps the loaded image carries (`max-h-80`, `max-w-full`).
      //
      // A definite pixel width, never `min(width, 100%)`: every box around a bubble's
      // content is shrink-to-fit, and a PERCENTAGE contributes nothing to a parent's
      // intrinsic width. So a percentage-width placeholder let the bubble size itself
      // to its text and the picture then widened it — the row still grew, by 39px,
      // which is what the spec measured. A pixel width contributes exactly what the
      // image will contribute, so the bubble is already the width the picture needs.
      // `max-w-full` still keeps a picture wider than the column inside it, and the
      // ratio then takes the height down with the width, exactly as `h-auto` does for
      // the image.
      <span
        data-testid="message-image-placeholder"
        className={cn(
          "flex items-center justify-center rounded-lg bg-element",
          IMAGE_CAPS,
          // Nothing known about this one yet, so hold the old fixed thumbnail box.
          !reserved && "h-32 w-40",
          props.className,
        )}
        style={
          reserved
            ? {
                aspectRatio: `${reserved.width} / ${reserved.height}`,
                width: `${reserved.width}px`,
              }
            : undefined
        }
      >
        <HugeiconsIcon
          icon={Loading02Icon}
          className="size-4 animate-spin text-text-faint"
          strokeWidth={1.6}
        />
      </span>
    );
  }

  const alt = props.alt || "image";
  return (
    // The wrapping span shrink-wraps the thumbnail and carries `props.className`
    // (e.g. the inline image's `my-1`), so the image-only "atelier mat" still
    // zeroes that margin (see `.image-mat` in app.css). Span and button are both
    // phrasing content, which keeps the subtree valid inside a rich-text <p>.
    <span className={cn("block w-fit max-w-full", props.className)}>
      <button
        type="button"
        aria-label={`View image: ${alt}`}
        onClick={() => setZoomed(true)}
        className="block w-fit max-w-full cursor-zoom-in rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <img
          ref={thumbRef}
          data-testid="message-image"
          src={objectUrl}
          alt={alt}
          loading="lazy"
          // The dimensions the box was reserved from, handed to the browser as the
          // attributes it sizes a not-yet-decoded image by — so the image holds that
          // same space from its first frame instead of from its first painted byte.
          width={reserved?.width}
          height={reserved?.height}
          onLoad={(e) => rememberNaturalSize(e.currentTarget)}
          onError={() => setFailed(true)}
          className={cn(
            "block rounded-xl object-contain shadow-card transition-opacity duration-150 ease-out hover:opacity-90",
            IMAGE_CAPS,
            // `width`/`height` state the ratio; the caps decide the drawn size, so
            // the height must follow the width rather than the attribute.
            "h-auto",
          )}
          // The picture is in the lightbox while it is open: leaving it drawn here
          // too would show through the travel and behind the scrim. `visibility`
          // rather than `display`, so the thumbnail keeps the space it holds — the
          // lightbox measures that spot to fly the picture back into it.
          style={{ visibility: zoomed ? "hidden" : undefined }}
        />
      </button>
      {zoomed ? (
        <ImageLightbox src={objectUrl} alt={alt} anchor={thumbRef} onClosed={onClosed} />
      ) : null}
    </span>
  );
}

/**
 * A non-image attachment (file/card) rendered as a chip, led by the coloured icon
 * of its own document type (see {@link FileTypeIcon}). Clicking it loads the bytes
 * through the media proxy and opens them in a new tab, so a file shared in a chat
 * is actually reachable from the web UI.
 */
export function FileAttachment(props: { attachment: Attachment }) {
  const controller = useController();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const url = await controller.loadMedia(props.attachment.url);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      controller.setStatus("Couldn't load attachment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="message-file"
      onClick={() => void open()}
      className="flex items-center gap-2 rounded-lg bg-element/80 px-3 py-2 text-left text-xs text-foreground shadow-chip transition-colors hover:bg-element"
    >
      {busy ? (
        <HugeiconsIcon
          icon={Loading02Icon}
          className="size-4 shrink-0 animate-spin text-text-faint"
          strokeWidth={1.6}
        />
      ) : (
        <FileTypeIcon
          name={props.attachment.name}
          contentType={props.attachment.content_type}
          className="size-4"
        />
      )}
      <span className="truncate">{props.attachment.name}</span>
      <HugeiconsIcon
        icon={Download04Icon}
        className="ml-auto size-3.5 shrink-0 text-text-faint"
        strokeWidth={1.6}
      />
    </button>
  );
}

/**
 * A meeting recording (Teams `Video.2/CallRecording.1`) rendered as a media card:
 * a big video poster with a play overlay and a duration badge, captioned with the
 * recording's title. The poster thumbnail is authenticated Teams hosted content,
 * so it is fetched through the media proxy (same path as {@link MediaImage}); a
 * missing/failed poster falls back to a film-strip placeholder — the card stays
 * clickable either way. Clicking opens the recording's SharePoint player page in
 * a new tab directly (it is a web page, not proxiable media bytes), where the
 * user is already signed in — teams-lite never streams the video itself.
 */
export function RecordingAttachment(props: { attachment: Attachment }) {
  const controller = useController();
  const { url, name, thumbnail_url, duration_seconds } = props.attachment;
  const hasThumb = Boolean(thumbnail_url);
  const proxied = hasThumb && mediaNeedsProxy(thumbnail_url!);
  const [poster, setPoster] = useState<string | null>(hasThumb && !proxied ? thumbnail_url! : null);
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => {
    if (!hasThumb) return;
    if (!proxied) {
      setPoster(thumbnail_url!);
      setPosterFailed(false);
      return;
    }
    let cancelled = false;
    setPoster(null);
    setPosterFailed(false);
    const thumb = thumbnail_url!;
    controller.retainMedia(thumb);
    controller
      .loadMedia(thumb)
      .then((u) => {
        if (!cancelled) setPoster(u);
      })
      .catch(() => {
        if (!cancelled) setPosterFailed(true);
      });
    return () => {
      cancelled = true;
      controller.releaseMedia(thumb);
    };
  }, [controller, thumbnail_url, hasThumb, proxied]);

  const duration =
    duration_seconds && duration_seconds > 0 ? formatCallDuration(duration_seconds) : null;
  const showPoster = poster !== null && !posterFailed;

  return (
    <button
      type="button"
      data-testid="message-recording"
      onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
      title={name}
      className="group block w-full max-w-sm overflow-hidden rounded-xl bg-element text-left shadow-card transition-shadow hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="relative aspect-video w-full bg-gradient-to-br from-element to-card">
        {showPoster ? (
          <img
            src={poster}
            alt=""
            loading="lazy"
            onError={() => setPosterFailed(true)}
            className="absolute inset-0 size-full object-cover"
          />
        ) : hasThumb && !posterFailed ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon
              icon={Loading02Icon}
              className="size-5 animate-spin text-text-faint"
              strokeWidth={1.6}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <HugeiconsIcon icon={Film01Icon} className="size-8 text-text-faint" strokeWidth={1.4} />
          </div>
        )}
        {/* Play affordance over a subtle scrim, so the poster reads as a video. */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30">
          <span className="flex items-center justify-center rounded-full bg-black/55 p-3 shadow-card backdrop-blur-sm transition-transform group-hover:scale-105">
            <HugeiconsIcon
              icon={PlayIcon}
              className="size-6 fill-white text-white"
              strokeWidth={1.6}
            />
          </span>
        </div>
        {duration && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
            {duration}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="truncate text-xs font-medium text-foreground">{name}</span>
        <HugeiconsIcon
          icon={ExternalLinkIcon}
          className="ml-auto size-3.5 shrink-0 text-text-faint"
          strokeWidth={1.6}
        />
      </div>
    </button>
  );
}

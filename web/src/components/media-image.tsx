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

/** Bytes this app fetches ITSELF, for a picture the browser could not load at all: the key it
 *  is cached and retained under, and the call that resolves it to a blob object URL. The
 *  GitLab page's uploads arrive this way (see `gitlab-image.tsx`); a chat image needs none,
 *  because its own URL says whether it goes through the media proxy. */
export type ImageSource = { key: string; load: () => Promise<string> };

/**
 * An image from a chat message. Authenticated Teams hosted content (inline
 * images, image attachments on *.teams.microsoft.com / *.skype.com) is fetched
 * through the backend media proxy and rendered from a local blob URL, since the
 * browser lacks the skypetoken. Public images (giphy, the Teams static-asset
 * CDN) are loaded directly by the browser. Shows a placeholder while a proxied
 * image loads and a graceful fallback if the fetch/render fails.
 *
 * `source` overrides all of that with bytes the caller knows how to fetch, and `width` /
 * `height` are what the picture is KNOWN to be before it arrives — so its room is held while
 * it loads instead of the words around it re-flowing when it lands.
 */
export function MediaImage(props: {
  src: string;
  alt?: string;
  className?: string;
  source?: ImageSource;
  width?: number;
  height?: number;
}) {
  const controller = useController();
  const { source } = props;
  const proxied = source ? true : mediaNeedsProxy(props.src);
  // Public images render straight from their URL; proxied ones wait for a blob.
  const [objectUrl, setObjectUrl] = useState<string | null>(proxied ? null : props.src);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const thumbRef = useRef<HTMLImageElement>(null);
  const onClosed = useCallback(() => setZoomed(false), []);

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
    // byte budget can't revoke it from under us (see `evictMedia`). The key is the
    // caller's when it fetches the bytes, so retain and load name one entry.
    const key = source ? source.key : props.src;
    // `loadPicture` rather than `loadMedia`: a picture is drawn at the resolution its object
    // store really holds, not at the reduced view a Teams client wrote on the <img> (see
    // `fullSizeMediaUrl`). It keys on this URL either way, so the key above is unchanged.
    const load = source ? source.load : () => controller.loadPicture(props.src);
    controller.retainMedia(key);
    load()
      .then((url) => {
        if (!cancelled) setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.releaseMedia(key);
    };
    // `source` is rebuilt on every render, so the effect keys on the picture it NAMES rather
    // than on the object: a new closure for the same upload must not re-fetch it.
  }, [controller, props.src, proxied, source?.key]);

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
      <div
        data-testid="message-image-loading"
        className={cn(
          "flex items-center justify-center rounded-lg bg-element",
          // A picture whose size is known holds exactly its own room, capped like the drawn
          // one — so nothing around it moves when the bytes land. One whose size nobody stated
          // keeps the box this has always drawn.
          props.width && props.height ? "h-auto max-h-80 w-full" : "h-32 w-40",
          props.className,
        )}
        style={
          props.width && props.height
            ? { aspectRatio: `${props.width} / ${props.height}`, maxWidth: props.width }
            : undefined
        }
      >
        <HugeiconsIcon
          icon={Loading02Icon}
          className="size-4 animate-spin text-text-faint"
          strokeWidth={1.6}
        />
      </div>
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
          // The size the author asked for, when they did — the aspect the browser reserves
          // room by. `max-w-full` below still wins over it, so a 777px screenshot fits a
          // 320px column instead of widening it.
          width={props.width}
          height={props.height}
          onError={() => setFailed(true)}
          className="block h-auto max-h-80 max-w-full rounded-xl object-contain shadow-card transition-opacity duration-150 ease-out hover:opacity-90"
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

import { useEffect, useState } from "react";
import { Download, ExternalLink, FileText, Film, ImageOff, Loader2, Play } from "lucide-react";
import Zoom from "react-medium-image-zoom";
import { formatCallDuration, mediaNeedsProxy, type Attachment } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useController } from "./controller-context";

/**
 * An image from a chat message. Authenticated Teams hosted content (inline
 * images, image attachments on *.teams.microsoft.com / *.skype.com) is fetched
 * through the backend media proxy and rendered from a local blob URL, since the
 * browser lacks the skypetoken. Public images (giphy, the Teams static-asset
 * CDN) are loaded directly by the browser. Shows a placeholder while a proxied
 * image loads and a graceful fallback if the fetch/render fails.
 */
export function MediaImage(props: { src: string; alt?: string; className?: string }) {
  const controller = useController();
  const proxied = mediaNeedsProxy(props.src);
  // Public images render straight from their URL; proxied ones wait for a blob.
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
        <ImageOff className="size-4 shrink-0" strokeWidth={1.6} />
        <span className="truncate">{props.alt || "Image unavailable"}</span>
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        className={cn(
          "flex h-32 w-40 items-center justify-center rounded-lg bg-element",
          props.className,
        )}
      >
        <Loader2 className="size-4 animate-spin text-text-faint" strokeWidth={1.6} />
      </div>
    );
  }

  const alt = props.alt || "image";
  return (
    // Click-to-zoom is delegated to react-medium-image-zoom: it portals a native
    // <dialog> (opened with showModal → the top layer) to <body>, so the
    // enlarged picture and its zoom/close transition are never clipped by, nor
    // drawn under, the message scroller — the failure the previous hand-rolled
    // Motion morph kept hitting. It also centres the picture with a symmetric
    // margin on every side. The wrapping span shrink-wraps the thumbnail and
    // carries `props.className` (e.g. the inline image's `my-1`) at the same
    // depth the old trigger button did, so the image-only "atelier mat" still
    // zeroes that margin (see `.image-mat` in app.css). `wrapElement="span"`
    // keeps the whole subtree phrasing content — valid inside a rich-text <p>.
    <span className={cn("block w-fit max-w-full", props.className)}>
      <Zoom
        wrapElement="span"
        classDialog="teams-image-zoom"
        zoomMargin={32}
        a11yNameButtonZoom="View image"
        a11yNameButtonUnzoom="Close image preview"
      >
        <img
          data-testid="message-image"
          src={objectUrl}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="block max-h-80 max-w-full rounded-xl object-contain shadow-card transition-opacity duration-150 ease-out hover:opacity-90"
        />
      </Zoom>
    </span>
  );
}

/**
 * A non-image attachment (file/card) rendered as a chip. Clicking it loads the
 * bytes through the media proxy and opens them in a new tab, so a file shared in
 * a chat is actually reachable from the web UI.
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
        <Loader2 className="size-4 shrink-0 animate-spin text-text-faint" strokeWidth={1.6} />
      ) : (
        <FileText className="size-4 shrink-0 text-text-faint" strokeWidth={1.6} />
      )}
      <span className="truncate">{props.attachment.name}</span>
      <Download className="ml-auto size-3.5 shrink-0 text-text-faint" strokeWidth={1.6} />
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
            <Loader2 className="size-5 animate-spin text-text-faint" strokeWidth={1.6} />
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Film className="size-8 text-text-faint" strokeWidth={1.4} />
          </div>
        )}
        {/* Play affordance over a subtle scrim, so the poster reads as a video. */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30">
          <span className="flex items-center justify-center rounded-full bg-black/55 p-3 shadow-card backdrop-blur-sm transition-transform group-hover:scale-105">
            <Play className="size-6 fill-white text-white" strokeWidth={1.6} />
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
        <ExternalLink className="ml-auto size-3.5 shrink-0 text-text-faint" strokeWidth={1.6} />
      </div>
    </button>
  );
}

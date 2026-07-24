import { useEffect, useState } from "react";
import { Download, FileText, ImageOff, Loader2 } from "lucide-react";
import Zoom from "react-medium-image-zoom";
import { mediaNeedsProxy, type Attachment } from "~/lib/protocol";
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
    controller
      .loadMedia(props.src)
      .then((url) => {
        if (!cancelled) setObjectUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ImageNotFound01Icon, ScissorIcon } from "@hugeicons/core-free-icons";
import type { MailBody as MailBodyData } from "~/lib/protocol";
import { cn } from "~/lib/utils";

// The second half of the mail-rendering pipeline (the first is `src/mail_html.rs`).
//
// The backend already reduced the body to an inert, self-contained fragment: no
// scripts, styles, frames or forms; no remote references of any kind. This component
// adds the ISOLATION half — the mail is a foreign document, and it renders inside a
// frame that cannot script, navigate, fetch, or reach our DOM and CSS:
//
//   sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
//     NOTE the absence of `allow-scripts`. That single omission is what makes the
//     frame inert: without it no script in the document can run, whatever survived
//     sanitizing. `allow-same-origin` is then safe — and necessary, because it is
//     what lets THIS component measure the document's height from the outside
//     (a sandboxed frame with an opaque origin would be unreadable, forcing either a
//     nested scrollbar or a script inside the frame to report its size, and adding
//     `allow-scripts` to solve a layout problem would give up the whole guarantee).
//     The two `allow-popups*` flags exist so a link the user clicks can open in a
//     real tab instead of being silently swallowed.
//
//   Content-Security-Policy: default-src 'none'; img-src data:; style-src
//   'unsafe-inline'
//     Belt to the sanitizer's braces. Even a remote reference that somehow survived
//     upstream cannot load: the only image source permitted is `data:` (the inline
//     images the backend embedded), and no script, frame, font, or connection of any
//     kind is allowed. `style-src 'unsafe-inline'` permits the mail's own inline
//     `style` attributes, which is how mail is laid out at all.
//
// Mail always renders on a light surface, in both app themes. Mail HTML hard-codes
// its own colours against an assumed white background — dark text on dark cells,
// invisible logos, unreadable tables — and "fixing" that would mean rewriting the
// sender's document. Every serious client makes the same call; the frame is a card
// with its own light background, deliberately reading as a quoted document rather
// than as part of the app.

/** Extra room added under the measured document height, so a body whose last line
 *  sits flush against the edge is not visually clipped. */
const HEIGHT_PADDING_PX = 8;

/** Fallback height before (or without) a successful measurement. */
const MIN_HEIGHT_PX = 120;

/** The document handed to the frame: the sanitized fragment plus a CSP, a charset,
 *  and the minimum styling needed to make mail readable in a narrow pane. */
function buildDocument(html: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    /* Mail is built out of fixed-width tables (600px is the convention). Allow a
       horizontal scroll rather than letting one wide table stretch the frame. */
    overflow-x: auto;
    overflow-y: hidden;
    word-break: break-word;
  }
  /* An image with its source removed (a blocked tracker) must not reserve space. */
  img:not([src]) { display: none; }
  img { max-width: 100%; height: auto; }
  a { color: #0f62d6; }
  blockquote {
    margin: 0.5em 0;
    padding-left: 0.9em;
    border-left: 2px solid #e2e2e2;
    color: #555555;
  }
  pre { white-space: pre-wrap; }
  table { max-width: 100%; }
</style>
</head>
<body>${html}</body>
</html>`;
}

/**
 * Renders one mail body, isolated in a sandboxed frame, and reports what the
 * sanitizer removed.
 */
export function MailBody(props: { body: MailBodyData; className?: string }) {
  const { body } = props;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT_PX);
  const document = useMemo(() => buildDocument(body.html), [body.html]);

  // Measure the framed document and grow the frame to fit, so the mail scrolls with
  // the pane instead of inside a second scrollbar. Safe to read across the frame
  // boundary: `allow-same-origin` without `allow-scripts` means the document is
  // readable but cannot execute anything.
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc?.documentElement) return;
    const measured = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
    );
    setHeight(Math.max(MIN_HEIGHT_PX, measured + HEIGHT_PADDING_PX));
  }, []);

  // Re-measure while the document settles: embedded images decode asynchronously,
  // and the pane's width changes with the window. A ResizeObserver on the framed
  // body covers both without polling.
  useEffect(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc?.body) return;
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(doc.body);
    return () => observer.disconnect();
  }, [document, measure]);

  const nothingToShow = body.html.trim().length === 0;

  return (
    <div className={cn("flex flex-col gap-2", props.className)}>
      {(body.blocked_remote_images > 0 || body.truncated) && (
        <div className="flex flex-col gap-1">
          {body.blocked_remote_images > 0 && (
            <p
              data-testid="mail-blocked-images"
              className="flex items-center gap-2 text-[12px] text-text-faint"
            >
              <HugeiconsIcon
                icon={ImageNotFound01Icon}
                className="size-3.5 shrink-0"
                strokeWidth={1.5}
              />
              <span>
                {body.blocked_remote_images} remote{" "}
                {body.blocked_remote_images === 1 ? "image" : "images"} blocked — loading
                one would tell the sender you opened this mail.
              </span>
            </p>
          )}
          {body.truncated && (
            <p
              data-testid="mail-truncated"
              className="flex items-center gap-2 text-[12px] text-text-faint"
            >
              <HugeiconsIcon icon={ScissorIcon} className="size-3.5 shrink-0" strokeWidth={1.5} />
              <span>This message was unusually large and has been shortened.</span>
            </p>
          )}
        </div>
      )}

      {nothingToShow ? (
        <p data-testid="mail-body-empty" className="text-[13px] text-text-faint">
          {body.blocked_remote_images > 0
            ? "This message is made entirely of remote images, so there is nothing left to show."
            : "This message has no content."}
        </p>
      ) : (
        <iframe
          ref={frameRef}
          data-testid="mail-body"
          title="Message body"
          // No `allow-scripts`: see the note at the top of this file. Changing this
          // line is what a security review of this feature should look at first.
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={document}
          onLoad={measure}
          style={{ height: `${height}px` }}
          className="w-full rounded-xl border border-border-subtle bg-white"
        />
      )}
    </div>
  );
}

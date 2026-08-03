import { lazy, Suspense, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { ArrowUp, ImagePlus, LoaderCircle, Type, X } from "lucide-react";
import {
  composerImageAccept,
  loadComposerImage,
  sendImage,
  type ComposerImage,
} from "~/lib/composer-image";
import { copyableMessageText } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";

// TipTap (ProseMirror) is heavy and only needed when rich mode is on, so load it
// lazily on demand. This keeps the default plain-text composer path off the
// critical bundle.
const RichEditor = lazy(() =>
  import("./rich-editor").then((m) => ({ default: m.RichEditor })),
);

const MAX_ROWS = 12;
const LINE_HEIGHT = 20;
const BASE_PADDING = 16;
const RICH_MODE_KEY = "teams-composer-rich";

/** Escape plain draft text so it seeds the rich editor as literal text. */
function draftToHtml(text: string): string {
  if (!text) return "";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return `<p>${escaped}</p>`;
}

/** The first image file on the clipboard, or null when the paste carries none —
 *  which is what keeps an ordinary text paste an ordinary text paste. */
function clipboardImage(event: ClipboardEvent): File | null {
  for (const item of event.clipboardData.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    return item.getAsFile();
  }
  return null;
}

/**
 * Message composer with two input modes, toggled like Teams: a rich-text editor
 * (default — bold/italic/underline/strike/code/link/lists via keyboard shortcuts
 * and a select-to-format menu, no permanent toolbar) and a plain auto-growing
 * textarea. Enter sends, Shift+Enter inserts a newline; a reply banner shows the
 * quoted message. The rich editor can be turned off with the format toggle.
 *
 * One image can ride along with either mode — picked with the image button or
 * pasted from the clipboard, previewed above the field, and uploaded to Teams by
 * the backend as part of the same `send` (see src/teams_send.rs). The submitted
 * snapshot stays on screen while the request is in flight and after a failure, so
 * a rejected send never loses the image or the caption.
 */
export function Composer(props: { focusToken: unknown }) {
  const controller = useController();
  const draft = useAppState((s) => s.draft);
  const replyingTo = useAppState((s) => s.replyingTo);
  const openId = useAppState((s) => s.openId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rich, setRich] = useState(false);
  // The rich editor owns its content, so it registers a submit callback here and
  // reports emptiness for the send button's enabled state.
  const richSubmitRef = useRef<(() => void) | null>(null);
  const [richEmpty, setRichEmpty] = useState(true);
  const richFocusRef = useRef<(() => void) | null>(null);
  const [image, setImage] = useState<ComposerImage | null>(null);
  const imageRef = useRef<ComposerImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [sending, setSending] = useState(false);
  // A ref as well as state: `send` must see the current values synchronously, so a
  // second Enter during a pending request cannot start a duplicate send.
  const sendingRef = useRef(false);
  // Monotonic tokens that make a late async result harmless: a selection or a send
  // only writes back when it is still the newest one for this conversation.
  const selectionVersion = useRef(0);
  const sendVersion = useRef(0);

  // Restore the mode preference on the client (kept out of SSR to avoid a
  // hydration mismatch — the server always renders the plain textarea, then we
  // flip to rich here). Rich text is the default: only an explicit opt-out ("0")
  // drops to the plain textarea, so formatting shortcuts (Ctrl+B/I/U, Ctrl+K) and
  // the select-to-format menu are available unless the user turned rich off.
  useEffect(() => {
    try {
      setRich(localStorage.getItem(RICH_MODE_KEY) !== "0");
    } catch {
      setRich(true);
    }
  }, []);

  imageRef.current = image;

  // An image belongs to the conversation it was picked in, so switching away drops
  // it rather than carrying it into somebody else's chat.
  useEffect(() => {
    selectionVersion.current += 1;
    sendVersion.current += 1;
    imageRef.current = null;
    setImage(null);
    setImageError(null);
    setImageLoading(false);
    sendingRef.current = false;
    setSending(false);
  }, [openId]);

  const toggleRich = () => {
    setRich((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RICH_MODE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // Keep the textarea sized to its content, capped at MAX_ROWS.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || rich) return;
    el.style.height = "auto";
    const maxHeight = MAX_ROWS * LINE_HEIGHT + BASE_PADDING;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft, rich]);

  // Focus the plain composer when the open conversation changes.
  useEffect(() => {
    if (openId && !rich) textareaRef.current?.focus();
  }, [openId, rich, props.focusToken]);

  /** Read, validate and preview one picked or pasted image. Decoding is async, so a
   *  newer selection (or a removal) makes this result stale and it is dropped. */
  const selectImage = async (file: File) => {
    const version = ++selectionVersion.current;
    setImageError(null);
    setImageLoading(true);
    try {
      const next = await loadComposerImage(file);
      if (selectionVersion.current !== version) return;
      imageRef.current = next;
      setImage(next);
    } catch (error) {
      if (selectionVersion.current !== version) return;
      setImageError(error instanceof Error ? error.message : "Could not add the image.");
    } finally {
      if (selectionVersion.current === version) setImageLoading(false);
    }
  };

  const removeImage = () => {
    selectionVersion.current += 1;
    imageRef.current = null;
    setImage(null);
    setImageError(null);
    setImageLoading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    focusField();
  };

  const handlePaste = (event: ClipboardEvent) => {
    const file = clipboardImage(event);
    if (!file) return;
    event.preventDefault();
    void selectImage(file);
  };

  /**
   * Send one snapshot of the composer: the text (or rich HTML) plus the pending
   * image. Returns whether the backend accepted it, which is what tells the rich
   * editor whether it may clear itself.
   *
   * Only the exact submitted image is cleared, and only on success — a failure
   * leaves the whole snapshot on screen to retry, and a picture picked while the
   * request was in flight is never thrown away.
   */
  const send = async (text: string, html?: string): Promise<boolean> => {
    if (sendingRef.current || imageLoading) return false;
    const clean = text.trim();
    const richHtml = html?.trim() || undefined;
    const submittedImage = imageRef.current;
    if (!clean && !richHtml && !submittedImage) return false;

    const version = ++sendVersion.current;
    sendingRef.current = true;
    setSending(true);
    const sent = await controller.sendDraft(
      text,
      richHtml,
      submittedImage ? sendImage(submittedImage) : undefined,
    );
    if (sendVersion.current !== version) return sent;
    sendingRef.current = false;
    setSending(false);
    if (sent && imageRef.current === submittedImage) {
      imageRef.current = null;
      setImage(null);
    }
    return sent;
  };

  const submitPlain = () => {
    const text = textareaRef.current?.value ?? draft;
    void send(text);
  };

  const canSend =
    !sending &&
    !imageLoading &&
    (image !== null || (rich ? !richEmpty : draft.trim().length > 0));

  const submit = () => {
    if (!canSend) return;
    if (rich && !richEmpty) richSubmitRef.current?.();
    else void send(draft);
  };

  const focusField = () => {
    if (rich) richFocusRef.current?.();
    else textareaRef.current?.focus();
  };

  return (
    <div
      data-testid="composer-shell"
      // The live sentinel. `web/scripts/sandbox-live.ts` is allowed to type into the
      // REAL account in exactly one conversation (the sandbox chat in AGENTS.md), and
      // it proves which one is open by reading this attribute before every keystroke.
      // It carries the app's own `openId`, not the URL and not the script's
      // assumption, so a redirect or a click that moved the thread cannot fool it —
      // the live counterpart of `[data-testid="backend-badge"]`. Keep it stable.
      data-conversation-id={openId ?? ""}
      className="composer-shell relative shrink-0 bg-background px-4"
    >
      {/* The history dissolves into the page immediately above the bar. The overlay
          hangs off the composer's own top edge (bottom-full) rather than the bottom
          of the scroll area, so no unfaded strip of padding is left between the two
          — the fade lands exactly where the bar (or its reply banner) begins. */}
      <div
        aria-hidden
        className="composer-fade pointer-events-none absolute inset-x-0 bottom-full h-14"
      />

      {replyingTo && (
        <div
          data-testid="reply-banner"
          className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-primary bg-card px-3 py-2 shadow-chip animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-primary">
              Replying to {replyingTo.message.sender}
            </div>
            <div className="truncate text-xs text-text-faint">
              {copyableMessageText(replyingTo.message)}
            </div>
          </div>
          <button
            type="button"
            aria-label="Cancel reply"
            data-testid="reply-cancel"
            data-cuelume-press=""
            onClick={() => controller.cancelReply()}
            className="grid size-6 shrink-0 place-items-center rounded-md text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" strokeWidth={1.6} />
          </button>
        </div>
      )}
      <div
        className="flex cursor-text flex-col gap-2 rounded-2xl bg-card px-3 py-2.5 shadow-chip transition-shadow focus-within:shadow-card"
        onMouseDown={(event) => {
          // Clicking anywhere in the box focuses the field, except the action
          // buttons (send / rich-text toggle / image) and the field itself, which
          // handle their own clicks.
          const element = event.target as HTMLElement;
          if (element.closest("button") || element.closest("textarea, [contenteditable]")) return;
          event.preventDefault();
          focusField();
        }}
      >
        {/* The pending image, above the field like Teams: a thumbnail with its pixel
            size and a remove button. It is a local preview (a data URL), so nothing
            is uploaded until the message is actually sent. */}
        {image && (
          <div data-testid="composer-image-preview" className="relative w-fit max-w-full">
            <img
              src={image.previewUrl}
              alt={image.name}
              className="max-h-40 max-w-full rounded-xl border border-border-subtle object-contain"
            />
            <button
              type="button"
              aria-label="Remove image"
              title="Remove image"
              data-testid="composer-image-remove"
              onClick={removeImage}
              className="absolute -right-2 -top-2 grid size-7 place-items-center rounded-full bg-popover text-foreground shadow-pop hover:bg-accent"
            >
              <X className="size-4" strokeWidth={1.8} />
            </button>
            <div className="mt-1 text-xs text-text-faint">
              {image.width} × {image.height}
            </div>
          </div>
        )}
        {imageError && (
          <div role="alert" data-testid="composer-image-error" className="text-xs text-destructive">
            {imageError}
          </div>
        )}

        {/* Input field. Rich mode is a bare-looking editor that formats via
            keyboard shortcuts and a select-to-format menu; plain mode is a bare
            auto-growing textarea. Both read as the same lean box, and both hand a
            pasted image to `handlePaste` instead of inserting it as content. */}
        {rich ? (
          <Suspense
            fallback={
              <div className="min-h-[1.75rem] w-full text-sm text-text-faint" aria-hidden />
            }
          >
            <RichEditor
              key={openId ?? "none"}
              initialContent={draftToHtml(draft)}
              focusToken={props.focusToken}
              submitRef={richSubmitRef}
              focusRef={richFocusRef}
              onEmptyChange={setRichEmpty}
              // Mirror the editor's text into the plain draft so drafts still
              // persist per-conversation and toggling back to plain keeps the text.
              onChangeText={(text) => controller.setDraftText(text)}
              onPaste={handlePaste}
              onSubmit={(html) => send("", html)}
            />
          </Suspense>
        ) : (
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            data-testid="composer"
            placeholder="Write a message…"
            className={cn(
              // `text-base` (16px) on mobile prevents iOS Safari from auto-zooming
              // when the field is focused; `md:text-sm` restores 14px on desktop.
              "max-h-64 w-full resize-none bg-transparent px-1 py-1 text-base outline-none md:text-sm placeholder:text-text-faint",
            )}
            onChange={(event) => controller.setDraftText(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitPlain();
              }
            }}
          />
        )}

        {/* Bottom control bar: rich-text toggle and image picker on the left, send
            on the right. */}
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label="Toggle rich text formatting"
              aria-pressed={rich}
              title="Rich text formatting"
              data-testid="composer-format-toggle"
              data-cuelume-toggle=""
              onClick={toggleRich}
              className={cn(
                "grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground",
                rich && "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
              )}
            >
              <Type className="size-4" strokeWidth={1.6} />
            </button>
            {/* The picker itself: hidden, opened by the button beside it. Its value is
                cleared on every change so re-picking the same file still fires. */}
            <input
              ref={fileInputRef}
              type="file"
              accept={composerImageAccept()}
              data-testid="composer-image-input"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void selectImage(file);
              }}
            />
            <button
              type="button"
              aria-label={image ? "Replace image" : "Add image"}
              title={image ? "Replace image" : "Add image"}
              data-testid="composer-image-button"
              disabled={imageLoading || sending}
              onClick={() => fileInputRef.current?.click()}
              className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
            >
              {imageLoading ? (
                <LoaderCircle className="size-4 animate-spin" strokeWidth={1.6} />
              ) : (
                <ImagePlus className="size-4" strokeWidth={1.6} />
              )}
            </button>
          </div>

          <button
            type="button"
            aria-label={sending ? "Sending message" : "Send message"}
            title="Send (Enter)"
            data-testid="composer-send"
            disabled={!canSend}
            onClick={submit}
            className={cn(
              "grid size-8 shrink-0 cursor-pointer place-items-center rounded-full transition-all disabled:cursor-default",
              canSend
                ? "bg-primary text-primary-foreground shadow-chip hover:brightness-110 active:brightness-95"
                : "bg-element text-text-faint",
            )}
          >
            {sending ? (
              <LoaderCircle className="size-4 animate-spin" strokeWidth={1.8} />
            ) : (
              <ArrowUp className="size-4" strokeWidth={2} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

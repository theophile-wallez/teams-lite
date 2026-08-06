import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type { Editor } from "@tiptap/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ImageAdd01Icon,
  Loading02Icon,
  SentIcon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { AgentAnswer } from "~/lib/agent-answer";
import { COMPOSER_FIELD_CLASS } from "~/lib/composer-field";
import {
  composerImageAccept,
  loadComposerImage,
  sendImage,
  type ComposerImage,
} from "~/lib/composer-image";
import { agentCandidatesFor, type OutboundMention } from "~/lib/mentions";
import { copyableMessageText } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";

// TipTap (ProseMirror) is heavy, so it stays off the critical bundle and arrives as
// its own chunk. Both imports name the same module, so the format bar costs nothing
// beyond the editor that is loading anyway.
const RichEditor = lazy(() => import("./rich-editor").then((m) => ({ default: m.RichEditor })));
const FormatToolbar = lazy(() =>
  import("./rich-editor").then((m) => ({ default: m.FormatToolbar })),
);

/** Whether the user keeps the format bar open. The editor is rich either way. */
const TOOLBAR_KEY = "teams-composer-toolbar";

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
 * Message composer. There is one field and it is always the rich-text editor, so
 * bold/italic/underline/strike/code/link/lists are on the keyboard
 * (Cmd/Ctrl+B/I/U, Cmd/Ctrl+K) in every state of the box. Enter sends, Shift+Enter
 * inserts a newline; a reply banner shows the quoted message.
 *
 * The `Type` button decides only whether the format buttons are *visible*: on, they
 * sit in the box's own top section; off, they appear over a selection instead. It
 * never swaps the field, so the text keeps its place and its padding — the box grows
 * upwards from its fixed bottom edge and the words do not move.
 *
 * Typing "@" opens the mention list, and a picked person travels with the message as
 * a real Teams mention — see `RichEditor`. An "@" that opens the message also offers the
 * agents this machine can run, which travel as the plain prefix that summons them. The
 * same tag arrives from the other end when the reader picks "Answer with <agent>" on a
 * message: the draft is written for them, and the send stays their own Enter.
 *
 * One image can ride along with the message — picked with the image button or
 * pasted from the clipboard, previewed above the field, and uploaded to Teams by
 * the backend as part of the same `send` (see src/teams_send.rs). The submitted
 * snapshot stays on screen while the request is in flight and after a failure, so
 * a rejected send never loses the image or the caption.
 */
export function Composer(props: {
  focusToken: unknown;
  /** An "Answer with <agent>" the reader picked on a message, drafted here rather than
   *  sent (see lib/agent-answer.ts). */
  agentAnswer?: AgentAnswer | null;
}) {
  const controller = useController();
  const draft = useAppState((s) => s.draft);
  // Why the last send in this thread did not leave, in one sentence. The controller
  // sets it and clears it on the next send that works (see `sendDraft`).
  const sendError = useAppState((s) => s.sendError);
  const replyingTo = useAppState((s) => s.replyingTo);
  const openId = useAppState((s) => s.openId);
  // Who this thread can @mention. Loaded on the first "@" (see
  // `ensureMentionCandidates`), so a conversation nobody mentions in costs nothing.
  const mentionCandidates = useAppState((s) => s.mentionCandidates);
  // The agents THIS thread can summon. Read from the backend's own status and the
  // conversation's own mode, so a thread nobody opted in offers none — a tag there would
  // look like it started a program while nothing ran.
  const agentStatus = useAppState((s) => s.agent);
  const agentCandidates = useMemo(
    () => agentCandidatesFor(agentStatus, openId),
    [agentStatus, openId],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  // The editor owns its content, so it registers a submit callback here, reports
  // emptiness for the send button's enabled state, and hands its instance out for
  // the format bar to drive.
  const richSubmitRef = useRef<(() => void) | null>(null);
  const [richEmpty, setRichEmpty] = useState(true);
  const richFocusRef = useRef<(() => void) | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
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

  // Restore the format bar preference on the client (kept out of SSR to avoid a
  // hydration mismatch — the server renders the bar closed, which is the default).
  useEffect(() => {
    try {
      setToolbarOpen(localStorage.getItem(TOOLBAR_KEY) === "1");
    } catch {
      /* ignore */
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

  /** Show or hide the format buttons. The field itself is untouched, so the caret,
   *  the selection and the text stay exactly as they were. */
  const toggleToolbar = () => {
    setToolbarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(TOOLBAR_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

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
  const send = async (
    text: string,
    html?: string,
    mentions?: OutboundMention[],
  ): Promise<boolean> => {
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
      mentions,
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

  const canSend = !sending && !imageLoading && (image !== null || !richEmpty);

  const submit = () => {
    if (!canSend) return;
    // An empty field with a picked image is a valid send: the image travels with an
    // empty body, so the editor has nothing to serialize.
    if (richEmpty) void send("");
    else richSubmitRef.current?.();
  };

  const focusField = () => richFocusRef.current?.();

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

      {/* The reading column. The bar is capped a touch wider than the history
          (`max-w-composer` vs `max-w-chat`), so it reads as a frame under the
          messages rather than a box that ends exactly where they do. The fade
          above stays full-width, because it belongs to the whole history. */}
      <div className="mx-auto w-full max-w-composer">
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
              <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.6} />
            </button>
          </div>
        )}
        <div
          className="flex cursor-text flex-col gap-2 rounded-2xl bg-card px-3 py-2.5 shadow-chip transition-shadow focus-within:shadow-card"
          onMouseDown={(event) => {
            // Clicking anywhere in the box focuses the field, except the action
            // buttons (send / format bar / image) and the field itself, which handle
            // their own clicks.
            const element = event.target as HTMLElement;
            if (element.closest("button") || element.closest("[contenteditable]")) return;
            event.preventDefault();
            focusField();
          }}
        >
          {/* The format bar, in the box's own top section. It is the SAME editor either
              way — the button only shows or hides these buttons — so the field keeps its
              content, its caret and its padding when the bar opens. The row keeps its
              height while the editor chunk loads, so the bar does not grow under the
              pointer that opened it. */}
          {toolbarOpen && (
            <div
              role="toolbar"
              aria-label="Formatting"
              data-testid="composer-toolbar"
              className="flex min-h-7 items-center gap-0.5 border-b border-border-subtle pb-2 animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
            >
              <Suspense fallback={null}>{editor && <FormatToolbar editor={editor} />}</Suspense>
            </div>
          )}

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
                <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.8} />
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
          {/* Why the last message did not leave, beside the words that are still in the
              box. The status line at the foot of the sidebar carries the raw failure for
              whoever debugs it; this is the half the user reads, and without it a refused
              send is a button that chimes and does nothing (see lib/send-failure.ts). */}
          {sendError && (
            <div role="alert" data-testid="composer-send-error" className="text-xs text-destructive">
              {sendError}
            </div>
          )}

          {/* The one input field: a bare-looking rich editor that hands a pasted image
              to `handlePaste` instead of inserting it as content. The placeholder under
              `Suspense` carries the field's own metrics, so the box does not resize when
              the editor arrives. */}
          <Suspense fallback={<div className={COMPOSER_FIELD_CLASS} aria-hidden />}>
            <RichEditor
              key={openId ?? "none"}
              initialContent={draftToHtml(draft)}
              focusToken={props.focusToken}
              toolbarVisible={toolbarOpen}
              submitRef={richSubmitRef}
              focusRef={richFocusRef}
              onEmptyChange={setRichEmpty}
              onEditorChange={setEditor}
              // Mirror the editor's text into the draft, so a half-written message
              // survives a walk through other conversations.
              onChangeText={(text) => controller.setDraftText(text)}
              onPaste={handlePaste}
              onSubmit={(html, mentions) => send("", html, mentions)}
              mentionCandidates={mentionCandidates}
              agentCandidates={agentCandidates}
              // A request asked in another thread is dropped rather than applied here.
              // The editor is keyed per conversation, so a fresh one would otherwise
              // apply the last pick again — in a thread nobody asked, and possibly one
              // where the tag would summon nothing.
              agentAnswer={
                props.agentAnswer?.conversation === openId ? props.agentAnswer : null
              }
              onMentionQuery={() => void controller.ensureMentionCandidates()}
            />
          </Suspense>

          {/* Bottom control bar: format bar toggle and image picker on the left, send
              on the right. */}
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={toolbarOpen ? "Hide formatting options" : "Show formatting options"}
                aria-pressed={toolbarOpen}
                title={toolbarOpen ? "Hide formatting options" : "Show formatting options"}
                data-testid="composer-format-toggle"
                data-cuelume-toggle=""
                onClick={toggleToolbar}
                className={cn(
                  "grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground",
                  toolbarOpen &&
                    "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
                )}
              >
                <HugeiconsIcon icon={TextFontIcon} className="size-4" strokeWidth={1.6} />
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
                  <HugeiconsIcon
                    icon={Loading02Icon}
                    className="size-4 animate-spin"
                    strokeWidth={1.6}
                  />
                ) : (
                  <HugeiconsIcon icon={ImageAdd01Icon} className="size-4" strokeWidth={1.6} />
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
                <HugeiconsIcon
                  icon={Loading02Icon}
                  className="size-4 animate-spin"
                  strokeWidth={1.8}
                />
              ) : (
                <HugeiconsIcon icon={SentIcon} className="size-4" strokeWidth={1.8} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowUp, Type, X } from "lucide-react";
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

/**
 * Message composer with two input modes, toggled like Teams: a rich-text editor
 * (default — bold/italic/underline/strike/code/link/lists via keyboard shortcuts
 * and a select-to-format menu, no permanent toolbar) and a plain auto-growing
 * textarea. Enter sends, Shift+Enter inserts a newline; a reply banner shows the
 * quoted message. The rich editor can be turned off with the format toggle.
 */
export function Composer(props: { focusToken: unknown }) {
  const controller = useController();
  const draft = useAppState((s) => s.draft);
  const replyingTo = useAppState((s) => s.replyingTo);
  const openId = useAppState((s) => s.openId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [rich, setRich] = useState(false);
  // The rich editor owns its content, so it registers a submit callback here and
  // reports emptiness for the send button's enabled state.
  const richSubmitRef = useRef<(() => void) | null>(null);
  const [richEmpty, setRichEmpty] = useState(true);
  const richFocusRef = useRef<(() => void) | null>(null);

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

  const submitPlain = () => {
    const text = textareaRef.current?.value ?? draft;
    if (!text.trim()) return;
    void controller.sendDraft(text);
  };

  const canSend = rich ? !richEmpty : draft.trim().length > 0;

  const submit = () => {
    if (rich) richSubmitRef.current?.();
    else submitPlain();
  };

  const focusField = () => {
    if (rich) richFocusRef.current?.();
    else textareaRef.current?.focus();
  };

  return (
    <div
      data-testid="composer-shell"
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
        onMouseDown={(e) => {
          // Clicking anywhere in the box focuses the field, except the action
          // buttons (send / rich-text toggle) and the field itself, which handle
          // their own clicks.
          const el = e.target as HTMLElement;
          if (el.closest("button") || el.closest("textarea, [contenteditable]")) return;
          e.preventDefault();
          focusField();
        }}
      >
        {/* Input field. Rich mode is a bare-looking editor that formats via
            keyboard shortcuts and a select-to-format menu; plain mode is a bare
            auto-growing textarea. Both read as the same lean box. */}
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
              onSubmit={(html) => void controller.sendDraft("", html)}
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
            onChange={(e) => controller.setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitPlain();
              }
            }}
          />
        )}

        {/* Bottom control bar: rich-text toggle on the left, send on the right. */}
        <div className="flex items-center justify-between gap-1.5">
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

          <button
            type="button"
            aria-label="Send message"
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
            <ArrowUp className="size-4" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

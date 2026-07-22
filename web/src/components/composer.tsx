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
 * Message composer with two input modes, toggled like Teams: a plain
 * auto-growing textarea (default) and a rich-text editor (bold/italic/underline/
 * strike/code/link/lists, keyboard shortcuts, floating toolbar). Enter sends,
 * Shift+Enter inserts a newline; a reply banner shows the quoted message.
 */
export function Composer(props: { focusToken: unknown }) {
  const controller = useController();
  const draft = useAppState((s) => s.draft);
  const replyingTo = useAppState((s) => s.replyingTo);
  const openId = useAppState((s) => s.openId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [rich, setRich] = useState(false);

  // Restore the mode preference on the client (kept out of SSR to avoid a
  // hydration mismatch — the server always renders the plain textarea).
  useEffect(() => {
    try {
      setRich(localStorage.getItem(RICH_MODE_KEY) === "1");
    } catch {
      /* ignore */
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

  const canSend = draft.trim().length > 0;

  return (
    <div className="shrink-0 bg-background px-4 pb-4 pt-2">
      {replyingTo && (
        <div
          data-testid="reply-banner"
          className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-primary bg-card px-3 py-2 shadow-chip"
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
            onClick={() => controller.cancelReply()}
            className="grid size-6 shrink-0 place-items-center rounded-md text-text-dim transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" strokeWidth={1.6} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-2xl bg-card px-2 py-1.5 shadow-chip transition-shadow focus-within:shadow-card focus-within:ring-1 focus-within:ring-ring">
        <button
          type="button"
          aria-label="Toggle rich text formatting"
          aria-pressed={rich}
          title="Rich text formatting"
          data-testid="composer-format-toggle"
          onClick={toggleRich}
          className={cn(
            "mb-0.5 grid size-8 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground",
            rich && "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
          )}
        >
          <Type className="size-4" strokeWidth={1.6} />
        </button>

        {rich ? (
          <Suspense
            fallback={
              <div className="min-h-[1.75rem] w-full py-1 text-sm text-text-faint" aria-hidden />
            }
          >
            <RichEditor
              key={openId ?? "none"}
              initialContent={draftToHtml(draft)}
              focusToken={props.focusToken}
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
              "max-h-64 w-full resize-none self-center bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-text-faint",
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

        {!rich && (
          <button
            type="button"
            aria-label="Send message"
            title="Send (Enter)"
            data-testid="composer-send"
            disabled={!canSend}
            onClick={submitPlain}
            className={cn(
              "mb-0.5 grid size-8 shrink-0 place-items-center rounded-full transition-all",
              canSend
                ? "bg-primary text-primary-foreground shadow-chip hover:brightness-110 active:brightness-95"
                : "bg-element text-text-faint",
            )}
          >
            <ArrowUp className="size-4" strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}

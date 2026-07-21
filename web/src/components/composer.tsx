import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { copyableMessageText } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";

const MAX_ROWS = 12;
const LINE_HEIGHT = 20;
const BASE_PADDING = 16;

/**
 * Message composer: an auto-growing textarea with a reply banner. Enter sends,
 * Shift+Enter inserts a newline. The draft is controlled by the store so it
 * persists per-conversation (durable server-side) and survives pane switches.
 */
export function Composer(props: { focusToken: unknown }) {
  const controller = useController();
  const draft = useAppState((s) => s.draft);
  const replyingTo = useAppState((s) => s.replyingTo);
  const openId = useAppState((s) => s.openId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the textarea sized to its content, capped at MAX_ROWS.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = MAX_ROWS * LINE_HEIGHT + BASE_PADDING;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft]);

  // Focus the composer when the open conversation changes (or actions close).
  useEffect(() => {
    if (openId) textareaRef.current?.focus();
  }, [openId, props.focusToken]);

  const submit = () => {
    const text = textareaRef.current?.value ?? draft;
    if (!text.trim()) return;
    void controller.sendDraft(text);
  };

  return (
    <div className="shrink-0 border-t border-border bg-background px-3 py-3">
      {replyingTo && (
        <div
          data-testid="reply-banner"
          className="mb-2 flex items-start gap-2 rounded-md border-l-2 border-primary bg-panel px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-primary">
              Replying to {replyingTo.message.sender}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {copyableMessageText(replyingTo.message)}
            </div>
          </div>
          <button
            type="button"
            aria-label="Cancel reply"
            data-testid="reply-cancel"
            onClick={() => controller.cancelReply()}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-element px-3 py-2 focus-within:border-border-active focus-within:ring-1 focus-within:ring-ring">
        <div className="mt-1 self-stretch">
          <span className="block h-full w-0.5 rounded bg-primary/70" aria-hidden />
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          data-testid="composer"
          placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)"
          className={cn(
            "max-h-64 w-full resize-none bg-transparent py-1 text-sm outline-none placeholder:text-text-faint",
          )}
          onChange={(e) => controller.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </div>
  );
}

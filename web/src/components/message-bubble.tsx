import { useEffect, useMemo, useRef, useState } from "react";
import { copyableMessageText, parseMessageContent, type ChatMessage } from "~/lib/protocol";
import { cn } from "~/lib/utils";

/**
 * A single chat message rendered as a bubble. Mine align right with an accent
 * background; others align left in the element color. The sender name shows only
 * on incoming bubbles in group chats. Replies render the quoted message as a
 * recessed block with a left accent bar, preserving text before/after the quote.
 * When `editing` is true, the body is replaced by an in-place editor (Enter to
 * save, Shift+Enter for a newline, Escape to cancel). Mirrors the TUI's
 * MessageBubble (ui/src/app.tsx).
 */
export function MessageBubble(props: {
  message: ChatMessage;
  showSenderName: boolean;
  editing: boolean;
  onOpenActions: (message: ChatMessage) => void;
  onSaveEdit: (message: ChatMessage, text: string) => void;
  onCancelEdit: () => void;
}) {
  const mine = props.message.is_self === true;
  const parsed = useMemo(() => parseMessageContent(props.message.content), [props.message.content]);
  const nameShown = !mine && props.showSenderName;

  const body = parsed.quote ? parsed.afterQuote : parsed.body;

  return (
    <div className={cn("group flex w-full", mine ? "justify-end" : "justify-start")}>
      <div
        data-testid="message"
        data-mine={mine ? "true" : "false"}
        className={cn(
          "relative max-w-[74%] rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm",
          mine
            ? "rounded-br-md bg-bubble-mine text-bubble-mine-foreground"
            : "rounded-bl-md bg-bubble-incoming text-bubble-incoming-foreground",
        )}
        onContextMenu={(e) => {
          e.preventDefault();
          props.onOpenActions(props.message);
        }}
      >
        {nameShown && (
          <div className="mb-0.5 text-xs font-semibold text-sender-name">
            {props.message.sender}
          </div>
        )}

        {props.editing ? (
          <MessageEditor
            initialText={copyableMessageText(props.message)}
            onSave={(text) => props.onSaveEdit(props.message, text)}
            onCancel={props.onCancelEdit}
          />
        ) : (
          <>
            {parsed.beforeQuote ? (
              <p className="whitespace-pre-wrap break-words">{parsed.beforeQuote}</p>
            ) : null}

            {parsed.quote ? (
              <div
                className={cn(
                  "my-1 rounded-md border-l-2 px-2 py-1",
                  mine
                    ? "border-sender-name-mine bg-quote-mine"
                    : "border-sender-name bg-quote-incoming",
                )}
              >
                {parsed.quote.sender ? (
                  <div
                    className={cn(
                      "text-xs font-semibold",
                      mine ? "text-sender-name-mine" : "text-sender-name",
                    )}
                  >
                    {parsed.quote.sender}
                  </div>
                ) : null}
                <div
                  className={cn(
                    "whitespace-pre-wrap break-words text-xs",
                    mine ? "text-quote-text-mine" : "text-quote-text-incoming",
                  )}
                >
                  {parsed.quote.text}
                </div>
              </div>
            ) : null}

            {body ? <p className="whitespace-pre-wrap break-words">{body}</p> : null}

            <button
              type="button"
              aria-label="Message actions"
              data-testid="message-actions"
              onClick={() => props.onOpenActions(props.message)}
              className={cn(
                "absolute -top-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
                mine ? "left-1" : "right-1",
              )}
            >
              <span className="grid size-6 place-items-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm hover:text-foreground">
                ⋯
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * In-place message editor: an auto-focused textarea seeded with the current
 * message text, plus Save/Cancel controls. Enter saves, Shift+Enter inserts a
 * newline, Escape cancels — matching the composer's keyboard model.
 */
function MessageEditor(props: {
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialText);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Focus and place the caret at the end of the existing text.
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const save = () => {
    if (value.trim()) props.onSave(value);
  };

  return (
    <div className="flex min-w-[12rem] flex-col gap-2">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        data-testid="message-edit-input"
        aria-label="Edit message"
        className="w-full resize-none rounded-md bg-background/60 px-2 py-1 text-sm text-foreground outline-none ring-1 ring-border focus:ring-ring"
        onChange={(e) => {
          setValue(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          // Keep edit keys local: the app has a window-level handler where Enter
          // and Escape drive list navigation / closing the conversation.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          }
        }}
      />
      <div className="flex justify-end gap-2 text-xs">
        <button
          type="button"
          data-testid="edit-cancel"
          onClick={props.onCancel}
          className="rounded px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="edit-save"
          onClick={save}
          disabled={!value.trim()}
          className="rounded bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

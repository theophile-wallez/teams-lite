import { useMemo } from "react";
import { parseMessageContent, type ChatMessage } from "~/lib/protocol";
import { cn } from "~/lib/utils";

/**
 * A single chat message rendered as a bubble. Mine align right with an accent
 * background; others align left in the element color. The sender name shows only
 * on incoming bubbles in group chats. Replies render the quoted message as a
 * recessed block with a left accent bar, preserving text before/after the quote.
 * Mirrors the TUI's MessageBubble (ui/src/app.tsx).
 */
export function MessageBubble(props: {
  message: ChatMessage;
  showSenderName: boolean;
  onOpenActions: (message: ChatMessage) => void;
}) {
  const mine = props.message.is_self === true;
  const parsed = useMemo(() => parseMessageContent(props.message.content), [props.message.content]);
  const nameShown = !mine && props.showSenderName;

  const body = parsed.quote ? parsed.afterQuote : parsed.body;

  return (
    <div className={cn("group flex w-full", mine ? "justify-end" : "justify-start")}>
      <div
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
      </div>
    </div>
  );
}

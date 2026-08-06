import { useEffect, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { bodyFormat, mentionsByItemId, type ChatMessage } from "~/lib/protocol";
import { agentAuthorship } from "~/lib/agent-message";
import { Avatar } from "./avatar";
import { Composer } from "./composer";
import { useAppState } from "./controller-context";
import { RichContent } from "./rich-content";
import { SystemEventLine } from "./system-event-line";

/**
 * The meeting's chat, in the stage's side panel.
 *
 * It is the app's OWN thread seen through a 21rem column: the panel's tab navigates the
 * app to that conversation, so the history, the drafts, the live feed and the read state
 * are the ones the conversation already has — there is no second history loader here, and
 * a message sent from the panel is sent by the same composer, under the same consent, as
 * one sent from the pane behind it.
 *
 * Three things follow from that, and each is deliberate:
 *
 * - **The composer is the app's one composer, MOVED.** It carries the live sentinel a
 *   sanctioned driver proves its target with, so a second one would give that question two
 *   answers (see `useCallOwnsComposer`). The pane behind renders none while this panel
 *   holds it, which costs nothing: a full stage covers that pane completely.
 * - **A message is READ here, and acted on there.** No reactions, no edit, no delete, no
 *   "…" menu — a call's side panel is for following what is being said and saying
 *   something back. Everything else is one fold away, in the conversation itself, where it
 *   has the room its menus need.
 * - **The tab NAVIGATES, so opening it marks the thread read** — exactly as clicking that
 *   chat in the sidebar does, and for the same reason: the user asked to see it. Nothing
 *   here opens a conversation on its own.
 */
export function CallStageChat(props: { conversation: string }) {
  const openId = useAppState((s) => s.openId);
  const messages = useAppState((s) => s.messages);
  const loading = useAppState((s) => s.loadingMessages);
  const ready = openId === props.conversation;

  return (
    <div data-testid="call-stage-chat" className="flex min-h-0 flex-1 flex-col">
      {ready && !loading ? (
        <ChatTranscript messages={messages} />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-faint">
          <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />
          Opening the conversation…
        </div>
      )}
      {/* The one composer, held here while this panel is open. It is the conversation's
          own, so a half-written message survives the fold and lands in the right thread. */}
      {ready && <Composer focusToken={props.conversation} />}
    </div>
  );
}

/** The newest of the thread, oldest first, stuck to the bottom.
 *
 *  It is NOT virtualized, and that is why it is bounded: a panel this narrow is read
 *  during a call rather than scrolled through, and mounting the whole backlog beside a
 *  live video stage would cost the call frames. What is above the last
 *  {@link TRANSCRIPT_MESSAGES} is in the conversation itself. */
function ChatTranscript(props: { messages: ChatMessage[] }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const shown = useMemo(
    () => props.messages.slice(-TRANSCRIPT_MESSAGES),
    [props.messages],
  );
  const newest = shown[shown.length - 1]?.id;

  // Stick to the bottom as messages arrive. A call's chat is followed live, so the newest
  // line is the one being read — and this panel is opened mid-conversation, which is
  // exactly when a scroller left at the top would look empty.
  //
  // After a frame, not during the commit: the rows are ordinary text and images whose
  // final height the browser only knows once it has laid them out, so a `scrollTop` written
  // synchronously lands short of the bottom by however much the last row grew.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = scroller.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [newest]);

  if (shown.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-text-faint">
        Nothing has been said in this chat yet.
      </div>
    );
  }

  return (
    <div
      ref={scroller}
      data-testid="call-stage-transcript"
      // The bottom padding is the composer's own fade: that overlay hangs off the box's top
      // edge, so without room under the last line it would dissolve the newest message
      // instead of the empty strip above the field.
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-12 pt-3"
    >
      {shown.map((message, index) => (
        <TranscriptRow
          key={message.id}
          message={message}
          // One head per run of messages from the same person, like the history's own
          // grouping: the face and the name are what a new speaker needs, and repeating
          // them per line is what makes a narrow column unreadable.
          continues={continuesRun(shown[index - 1], message)}
        />
      ))}
    </div>
  );
}

/** How much of the thread the panel holds. Enough to read what was said while the call
 *  has been going, and few enough that mounting it costs the video nothing. */
const TRANSCRIPT_MESSAGES = 60;

/** Whether this message continues the one above it: the same author, and no system line
 *  between them. */
function continuesRun(previous: ChatMessage | undefined, message: ChatMessage): boolean {
  if (!previous || previous.system_event || message.system_event) return false;
  return (previous.sender_mri ?? previous.sender) === (message.sender_mri ?? message.sender);
}

function TranscriptRow(props: { message: ChatMessage; continues: boolean }) {
  const { message } = props;
  // A system line is centred and says its own words — the same component the history uses,
  // so a meeting chat's "call started" reads identically in both places.
  if (message.system_event) {
    return (
      <div className="py-1 text-center">
        <SystemEventLine event={message.system_event} />
      </div>
    );
  }

  // An agent's answer is the message minus the line it signs itself with: the bubble in the
  // history says a machine wrote it beside the mark, and this row has no room for that
  // second sentence — but it must not show the raw signature either.
  const agent = agentAuthorship(message);
  const content = agent ? agent.bodyHtml : message.content;
  const mentions = mentionsByItemId(message);

  return (
    <div className="flex items-start gap-2">
      {props.continues ? (
        <span className="w-7 shrink-0" aria-hidden />
      ) : (
        <Avatar
          seed={message.sender_mri || message.sender}
          label={message.sender}
          photo={message.sender_mri ? { kind: "user", id: message.sender_mri } : undefined}
          fallback="person"
          className="mt-0.5 size-7 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        {!props.continues && (
          <p className="flex items-baseline gap-1.5">
            <span className="truncate text-xs font-semibold text-foreground">
              {message.is_self && !agent ? "You" : message.sender}
            </span>
            <span className="shrink-0 text-[11px] text-text-faint">{timeOf(message)}</span>
          </p>
        )}
        {message.deleted ? (
          <p className="text-xs italic text-text-faint">This message was deleted.</p>
        ) : (
          <RichContent
            html={content}
            format={bodyFormat(message.message_type)}
            mentions={mentions}
            className="break-words text-xs leading-relaxed text-text-dim"
          />
        )}
      </div>
    </div>
  );
}

/** When a message was written, in the reader's own locale. */
function timeOf(message: ChatMessage): string {
  if (!message.compose_time) return "";
  return new Date(message.compose_time).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

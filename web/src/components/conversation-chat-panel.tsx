import { useEffect, useMemo, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { chessWireIn } from "~/lib/chess-wire";
import { petWireIn } from "~/lib/pet-wire";
import { bodyFormat, mentionsByItemId, type ChatMessage } from "~/lib/protocol";
import { agentAuthorship } from "~/lib/agent-message";
import { Avatar } from "./avatar";
import { Composer } from "./composer";
import { useAppState } from "./controller-context";
import { RichContent } from "./rich-content";
import { SystemEventLine } from "./system-event-line";
import { cn } from "~/lib/utils";

/**
 * A conversation's chat, in a narrow column beside something else.
 *
 * TWO SURFACES draw it and both are full-screen surfaces that put the thread beside what the
 * reader came for: a live CALL's side panel (§ A call is a PAGE), and the CHESS page, where the
 * game is being played in this very conversation and what is being said while people play is the
 * other half of it. One component rather than two, because "the app's own thread in 21rem" is one
 * problem with one answer — and because the composer below is the app's ONE composer, which two
 * copies of this panel would give two answers about.
 *
 * It is the app's OWN thread seen through that column: the surface above navigates the app to the
 * conversation, so the history, the drafts, the live feed and the read state are the ones the
 * conversation already has — there is no second history loader here, and a message sent from the
 * panel is sent by the same composer, under the same consent, as one sent from the pane.
 *
 * Three things follow from that, and each is deliberate:
 *
 * - **The composer is the app's one composer, MOVED.** It carries the live sentinel a
 *   sanctioned driver proves its target with, so a second one would give that question two
 *   answers (see `useCallOwnsComposer`). The pane behind renders none while a call panel
 *   holds it, and on the chess page the pane is not mounted at all — either way there is
 *   exactly one.
 * - **A message is READ here, and acted on there.** No reactions, no edit, no delete, no
 *   "…" menu — a side column is for following what is being said and saying something back.
 *   Everything else is one fold away, in the conversation itself, where it has the room its
 *   menus need.
 * - **Opening it marks the thread read** — exactly as clicking that chat in the sidebar does,
 *   and for the same reason: the user asked to see it. Nothing here opens a conversation on
 *   its own.
 */
export function ConversationChatPanel(props: {
  conversation: string;
  /** The panel's own name, because a spec asks a call's panel and a chess page's about
   *  different things. The call's original ids are what its own specs still read. */
  testId?: string;
  transcriptTestId?: string;
  className?: string;
  /** Whether the panel draws the composer. A live call whose own chat panel is open already
   *  holds it, and two would be two answers to "which conversation does a keystroke land in". */
  composer?: boolean;
}) {
  const openId = useAppState((s) => s.openId);
  const messages = useAppState((s) => s.messages);
  const loading = useAppState((s) => s.loadingMessages);
  const ready = openId === props.conversation;

  return (
    <div
      data-testid={props.testId ?? "call-stage-chat"}
      className={cn("flex min-h-0 flex-1 flex-col", props.className)}
    >
      {ready && !loading ? (
        <ChatTranscript messages={messages} testId={props.transcriptTestId} />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-faint">
          <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.8} />
          Opening the conversation…
        </div>
      )}
      {/* The one composer, held here while this panel is open. It is the conversation's
          own, so a half-written message survives the fold and lands in the right thread. */}
      {ready && props.composer !== false && <Composer focusToken={props.conversation} />}
    </div>
  );
}

/** The call stage's own spelling of the panel, keeping the ids its specs read. */
export function CallStageChat(props: { conversation: string }) {
  return <ConversationChatPanel conversation={props.conversation} />;
}

/**
 * Whether a message is MACHINERY rather than something somebody said.
 *
 * A game of CHESS and a COMPANION are each carried by ordinary Teams messages signed with a
 * trailing line, and the history draws each as its own thing — a BOARD
 * (components/chess-game-card.tsx) and a creature the OVERLAY walks over the thread
 * (components/pet-layer.tsx). Left in, this column showed the raw signed line instead, which is
 * the one thing both features promise is drawn nowhere.
 *
 * It LEAVES THEM OUT rather than stripping the line off them, and that is the difference between
 * this panel and a sidebar row. Nobody typed those words: a pet's are `Nori · fed 3`, regenerated
 * on every act, so a stripped line would leave a row of machinery standing between two things
 * people really said. The pane absorbs them into what draws them; this panel has neither a board
 * nor an overlay, and the game or the creature is on screen beside it.
 *
 * Read by WIRE PRESENCE, never from a game or a pet some derivation resolved: a record whose own
 * root has paged out of the loaded history resolves to nothing, and asking the message itself
 * cannot have that failure.
 */
function carriesWire(message: ChatMessage): boolean {
  return chessWireIn(message) !== null || petWireIn(message) !== null;
}

/**
 * What the column SHOWS: the newest of what was said, with the machinery left out.
 *
 * Both halves of that in one pure function, exported so a test drives the decision rather than
 * reading it — the bound as much as the filter, since which end of the thread survives it is what
 * a reader of a live call is looking at.
 */
export function transcriptMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !carriesWire(message)).slice(-TRANSCRIPT_MESSAGES);
}

/** The newest of the thread, oldest first, stuck to the bottom.
 *
 *  It is NOT virtualized, and that is why it is bounded: a panel this narrow is read
 *  during a call rather than scrolled through, and mounting the whole backlog beside a
 *  live video stage would cost the call frames. What is above the last
 *  {@link TRANSCRIPT_MESSAGES} is in the conversation itself. */
function ChatTranscript(props: { messages: ChatMessage[]; testId?: string }) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const shown = useMemo(() => transcriptMessages(props.messages), [props.messages]);
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
      data-testid={props.testId ?? "call-stage-transcript"}
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

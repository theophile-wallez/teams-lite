import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type { Editor } from "@tiptap/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Clock01Icon,
  ImageAdd01Icon,
  SentIcon,
  SquareLock02Icon,
  TextFontIcon,
} from "@hugeicons/core-free-icons";
import type { AgentAnswer } from "~/lib/agent-answer";
import { COMPOSER_FIELD_CLASS } from "~/lib/composer-field";
import {
  composerImageAccept,
  composerImagesBytes,
  COMPOSER_IMAGE_MAX_COUNT,
  imageBatchError,
  loadComposerImage,
  sendImage,
  type ComposerImage,
} from "~/lib/composer-image";
import { agentCandidatesFor, type OutboundMention } from "~/lib/mentions";
import {
  POST_SUBJECT_MAX_CHARS,
  outboundSubject,
  postSubjectOffered,
} from "~/lib/post-subject";
import { scheduledBanner } from "~/lib/schedule-send";
import {
  SEAL_COMPOSER_HINT,
  SEAL_MISMATCH_HINT,
  sealIsOn,
  sealKeyDisagrees,
} from "~/lib/seal";
import { copyableMessageText } from "~/lib/protocol";
import { replyHeading } from "~/lib/threads";
import { BROADCAST_HINT, BROADCAST_LABEL, broadcastOffered } from "~/lib/chat-threads";
import { threadDraftKey, type ThreadTarget } from "~/lib/store";
import { cn } from "~/lib/utils";
import { FadeArc } from "./loading-ui/fade-arc";
import { ScheduleSendMenu } from "./schedule-send-menu";
import { ScheduledMessagesDialog } from "./scheduled-messages-dialog";
import { useAppState, useController } from "./controller-context";
import type { CustomEmoji } from "~/lib/custom-emoji";
import { unicodeShortcodes } from "~/lib/emoji-shortcodes";

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

/** Every image file on the clipboard, in the order it carries them — a paste of three
 *  screenshots is three pictures, not the first one. Empty when the paste carries none,
 *  which is what keeps an ordinary text paste an ordinary text paste. */
function clipboardImages(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
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
 * Up to `COMPOSER_IMAGE_MAX_COUNT` images ride along with the message — picked with the
 * image button or pasted from the clipboard, previewed above the field in the order they
 * were added, and uploaded to Teams by the backend as part of the same `send` (see
 * src/teams_send.rs). Each one is removed on its own. The submitted snapshot stays on
 * screen while the request is in flight and after a failure, so a rejected send never
 * loses the pictures or the caption; a successful one takes back exactly the pictures
 * that left, so a screenshot pasted while the request was travelling is not thrown away
 * and the one that went out is not sent twice.
 */
export function Composer(props: {
  focusToken: unknown;
  /** An "Answer with <agent>" the reader picked on a message, drafted here rather than
   *  sent (see lib/agent-answer.ts). */
  agentAnswer?: AgentAnswer | null;
  /**
   * THE THREAD THIS BAR POSTS INTO, when it is a thread's own composer rather than the one
   * under the conversation (`ThreadTarget`).
   *
   * A thread has its own reply bar at the foot of its panel — Slack's shape, and the one the
   * reference gets right: a single bar under the CONVERSATION while a thread stands open beside
   * it reads as belonging to neither. So this is the SAME component drawn twice rather than a
   * second, lesser box: the pictures, the mentions, the emoji, the seal and the agent tag are
   * all the ones the reader already has.
   *
   * What differs is only what it is aimed at and what it holds: its own draft, its own Send,
   * its own broadcast box, no post TITLE (a thread's title belongs to its first post) and no
   * banner of any kind — the panel above it IS the banner.
   */
  thread?: ThreadTarget | null;
}) {
  const controller = useController();
  const thread = props.thread ?? null;
  /** The key this box's own draft lives under, or null for the conversation's one. */
  const threadKey = thread ? threadDraftKey(thread) : null;
  /**
   * EVERY HANDLE THIS BAR PUBLISHES, prefixed in a thread's own bar.
   *
   * A conversation holds TWO composers while a thread is open, so an unprefixed name would
   * resolve to two elements — and every selector in this app's own suite and in
   * `web/scripts/preview.ts` that names one would silently become ambiguous. The live sentinel
   * is the sharpest case (`composer-shell` must answer exactly one conversation), and the rest
   * are what a spec drives: the send, the format bar, the picture picker.
   *
   * So the conversation's bar keeps every name it had, byte for byte, and a thread's bar takes
   * `thread-` in front of each — which is also what tells a spec WHICH bar it is driving.
   */
  const tid = (name: string) => (thread ? `thread-${name}` : name);
  const conversationDraft = useAppState((s) => s.draft);
  const threadDraft = useAppState((s) => (threadKey ? (s.threadDrafts[threadKey] ?? "") : ""));
  const draft = threadKey ? threadDraft : conversationDraft;
  // Why the last send in this thread did not leave, in one sentence. The controller
  // sets it and clears it on the next send that works (see `sendDraft`).
  const sendErrorText = useAppState((s) => s.sendError);
  const sendErrorAt = useAppState((s) => s.sendErrorAt);
  /** THIS bar's own failure. A conversation holds two composers while a thread is open, so the
   *  sentence belongs beside the words that did not leave rather than in both boxes. */
  const sendError = (thread?.root.id ?? null) === sendErrorAt ? sendErrorText : null;
  // Where the words went when the last send here was SCHEDULED. The mirror of `sendError`,
  // in the same place: the box is empty and the message is not in the thread yet.
  // What is QUEUED for this conversation. Derived rather than announced by the send that
  // queued it: a line set by an event went stale as soon as the message was cancelled, and
  // said nothing at all when the app was reopened with something already waiting.
  const scheduledHere = useAppState((s) => s.scheduledMessages);
  // Words handed back by the scheduled list's Edit, for the thread they belong to.
  const composerRestore = useAppState((s) => s.composerRestore);
  // Whether the words in this box will be ENCRYPTED when they leave (see lib/seal.ts). It
  // comes from the BACKEND, which is what really seals them, and it is false until the
  // backend has answered: a hopeful padlock over a message that goes out in the clear is
  // the one thing this hint must never do.
  const sealStatus = useAppState((s) => s.sealStatus);
  // The messages on screen, for the one warning no press can reach (see `sealMismatch`).
  const openMessages = useAppState((s) => s.messages);
  const replyingTo = useAppState((s) => s.replyingTo);
  const openId = useAppState((s) => s.openId);
  // Whether the open thread is a CHANNEL, which is what decides that a post has a TITLE at
  // all: a chat message has none in Teams, and a reply belongs to a thread already named by
  // its first post (see lib/post-subject.ts).
  const channels = useAppState((s) => s.channels);
  // …and HOW that channel is drawn, which decides it too: a channel Teams draws as a running
  // conversation has a chat's own composer, with no title in it (see lib/post-subject.ts).
  const channelLayout = useAppState((s) => (openId ? s.channelLayouts[openId] : undefined));
  const isChannel = channels.some((channel) => channel.id === openId);
  const subjectOffered = postSubjectOffered({
    isChannel,
    // A thread's own bar posts a reply, and a reply carries no title whichever bar wrote it.
    replying: replyingTo !== null || thread !== null,
    layout: channelLayout,
  });
  // Whether this bar offers "Also send to the chat" — a chat THREAD's own bar and nothing else
  // (see `broadcastOffered`). The bar under the conversation writes an ordinary reply, which is
  // already in the running history: there is nothing for the box to ask for there.
  const broadcast = broadcastOffered({
    inThread: thread !== null,
    isChannelThread: thread?.threadRoot != null,
  });
  /** Whether the reader ticked it. Local to the composer like the pending pictures and the
   *  title, and for the same reason: the choice belongs to the reply being written, so it is
   *  dropped when the reply is cancelled or the reader walks away rather than following them
   *  into somebody else's thread.
   *
   *  It starts UNTICKED, which is Slack's own default and the whole point of the feature: the
   *  noise a thread keeps out of the running history is what it is for, and a box that started
   *  ticked would make every reply a broadcast and the fold a thing nobody ever saw. */
  const [alsoToChat, setAlsoToChat] = useState(false);
  /**
   * …and the SAME ANSWER in a ref, because `send` cannot read the state.
   *
   * The rich editor holds this composer's `onSubmit` from the render it was mounted in
   * (`submitRef`), so a send closes over the FIRST render's values — which is why the pictures
   * and the scheduled moment are already refs here rather than state. Read from the state, every
   * reply went out folded whatever the reader had ticked: measured, and it is the defect
   * `gitlab-review-chat.tsx` records for its own `ask`.
   */
  const threadOnlyRef = useRef(false);
  /**
   * The tick belongs to the THREAD being answered: opening another thread starts UNTICKED, which
   * is the whole point of having chosen a thread at all — the answer belongs in it. The reader
   * may tick it to put the reply in the running history as well.
   *
   * It is keyed on the thread's own root, so walking from one thread to another does not carry
   * the last one's choice into it.
   */
  useEffect(() => {
    setAlsoToChat(false);
  }, [threadKey]);
  // The title being written. Local to the composer, like the pending pictures and for the
  // same reason: a title belongs to the post it is being written for, so it is dropped when
  // the reader walks to another conversation rather than following them into one.
  const [subject, setSubject] = useState("");
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
  const [customEmojiPack, setCustomEmojiPack] = useState<CustomEmoji[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  // The editor owns its content, so it registers a submit callback here, reports
  // emptiness for the send button's enabled state, and hands its instance out for
  // the format bar to drive.
  const richSubmitRef = useRef<(() => void) | null>(null);
  const [richEmpty, setRichEmpty] = useState(true);
  const richFocusRef = useRef<(() => void) | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const imagesRef = useRef<ComposerImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  // How many pictures are still being decoded. A count rather than a flag: a paste and a
  // pick can overlap, and a flag cleared by whichever finished first would enable Send
  // while the other picture is not in the message yet.
  const [loadingImages, setLoadingImages] = useState(0);
  const imageLoading = loadingImages > 0;
  const [sending, setSending] = useState(false);
  // Whether the list of what Teams is holding is open. Local: the banner's link is the only
  // thing that opens it, and it closes itself when a row takes the reader elsewhere.
  const [scheduledOpen, setScheduledOpen] = useState(false);
  // A ref as well as state: `send` must see the current values synchronously, so a
  // second Enter during a pending request cannot start a duplicate send.
  const sendingRef = useRef(false);
  // Monotonic tokens that make a late async result harmless: a selection or a send
  // only writes back when it is still the newest one for this conversation.
  const selectionVersion = useRef(0);
  const sendVersion = useRef(0);
  // The moment the NEXT send is for, or null for now. A ref rather than an argument
  // because the rich editor serializes itself and calls back into `send`, so nothing can
  // be threaded through that hop — and it is read once and cleared, so a scheduled press
  // can never make the Enter after it a scheduled send too.
  const scheduledAtRef = useRef<number | null>(null);

  // Restore the format bar preference on the client (kept out of SSR to avoid a
  // hydration mismatch — the server renders the bar closed, which is the default).
  useEffect(() => {
    try {
      setToolbarOpen(localStorage.getItem(TOOLBAR_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  // Load custom emoji pack and keep it fresh.
  const loadPack = useCallback(() => {
    controller.loadCustomEmoji().then(setCustomEmojiPack).catch(() => setCustomEmojiPack([]));
  }, [controller]);

  useEffect(() => {
    loadPack();
    return controller.onCustomEmojiChange(loadPack);
  }, [controller, loadPack]);

  // An image belongs to the conversation it was picked in, so switching away drops
  // it rather than carrying it into somebody else's chat.
  //
  // The decode counter is deliberately NOT reset here: a batch still decoding decrements
  // itself when it finishes, and zeroing it under one would let the NEXT batch's
  // decrement take the count to zero while that batch's picture is still missing — Send
  // enabled, Enter posts the message without it. What the reset would buy is Send
  // enabled a moment earlier in the new conversation; what it costs is a message short
  // of a picture.
  useEffect(() => {
    selectionVersion.current += 1;
    sendVersion.current += 1;
    imagesRef.current = [];
    setImages([]);
    setImageError(null);
    setSubject("");
    sendingRef.current = false;
    setSending(false);
  }, [openId]);

  // A message handed back by the scheduled list brings its TITLE with it, so a titled
  // announcement taken out of the queue is not re-posted with its heading missing. It runs on
  // each restore the store publishes, and never for another thread's — exactly as the words
  // do not travel between conversations either.
  useEffect(() => {
    if (!composerRestore || composerRestore.conversation !== openId) return;
    setSubject(composerRestore.subject ?? "");
  }, [composerRestore, openId]);

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

  /** Read, validate and preview picked or pasted images, appending them in the order they
   *  were given. Decoding is async and one at a time, so the previews arrive in that same
   *  order; a conversation change makes the whole batch stale and drops it — a removal
   *  does not, because the others are separate pictures.
   *
   *  BOTH ceilings are stated here as well as at the backend, so an eleventh picture — or
   *  one that would take the batch over what a message may weigh — is refused before a
   *  send rather than by one, and a batch that crosses either keeps the pictures that fit.
   *  The weight is the one that must not be left to the backend alone: the request would
   *  be a frame the socket refuses to read, which drops the connection instead of
   *  answering, and a dropped connection is reported as an unreachable backend. */
  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    const version = selectionVersion.current;
    setImageError(null);
    setLoadingImages((count) => count + 1);
    try {
      for (const file of files) {
        if (selectionVersion.current !== version) return;
        if (imagesRef.current.length >= COMPOSER_IMAGE_MAX_COUNT) {
          setImageError(`A message carries at most ${COMPOSER_IMAGE_MAX_COUNT} images.`);
          return;
        }
        const tooHeavy = imageBatchError(composerImagesBytes(imagesRef.current), file);
        if (tooHeavy) {
          setImageError(tooHeavy);
          return;
        }
        try {
          const next = await loadComposerImage(file);
          if (selectionVersion.current !== version) return;
          imagesRef.current = [...imagesRef.current, next];
          setImages(imagesRef.current);
        } catch (error) {
          if (selectionVersion.current !== version) return;
          setImageError(error instanceof Error ? error.message : "Could not add the image.");
        }
      }
    } finally {
      setLoadingImages((count) => Math.max(0, count - 1));
    }
  };

  /** Drop one picture. The others, and anything still decoding, are untouched. */
  const removeImage = (id: number) => {
    imagesRef.current = imagesRef.current.filter((image) => image.id !== id);
    setImages(imagesRef.current);
    setImageError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    focusField();
  };

  const handlePaste = (event: ClipboardEvent) => {
    const files = clipboardImages(event);
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  /**
   * Send one snapshot of the composer: the text (or rich HTML) plus the pending
   * images. Returns whether the backend accepted it, which is what tells the rich
   * editor whether it may clear itself.
   *
   * Only the exact submitted pictures are cleared, and only on success — a failure
   * leaves the whole snapshot on screen to retry, and a picture pasted while the
   * request was in flight is never thrown away.
   */
  const send = async (
    text: string,
    html?: string,
    mentions?: OutboundMention[],
  ): Promise<boolean> => {
    const scheduledAt = scheduledAtRef.current;
    scheduledAtRef.current = null;
    if (sendingRef.current || imageLoading) return false;
    const clean = text.trim();
    const richHtml = html?.trim() || undefined;
    const submitted = imagesRef.current;
    if (!clean && !richHtml && submitted.length === 0) return false;

    // The TITLE only where a post has one, so a line typed before the reader pressed Reply
    // is not smuggled onto the reply — the backend refuses one there (`parse_subject`).
    const submittedSubject = subjectOffered ? outboundSubject(subject) : undefined;

    const version = ++sendVersion.current;
    sendingRef.current = true;
    setSending(true);
    const sent = await controller.sendDraft(
      text,
      richHtml,
      submitted.map(sendImage),
      mentions,
      scheduledAt ?? undefined,
      submittedSubject,
      // Whether this reply is drawn in its thread alone — from the REF, which is the only
      // thing this closure can read (see `threadOnlyRef`). It is already narrowed to a chat
      // thread's own bar, so the bar under the conversation and a channel thread's bar can
      // never send a flag the backend refuses (`parse_thread_only`).
      threadOnlyRef.current,
      // …and WHICH thread these words are a reply into, where this bar is a thread's own. It
      // REPLACES the pending reply for this send rather than adding a second way to reply: the
      // panel has no pending reply, the thread it shows IS the target.
      thread ?? undefined,
    );
    if (sendVersion.current !== version) return sent;
    sendingRef.current = false;
    setSending(false);
    if (sent) {
      const gone = new Set(submitted.map((image) => image.id));
      imagesRef.current = imagesRef.current.filter((image) => !gone.has(image.id));
      setImages(imagesRef.current);
      // The title that left goes with the words, and only while the field still holds
      // exactly it: a reader who rewrote the title while the send was travelling keeps
      // what they are writing. The rule `removeSentWords` follows for the body.
      if (submittedSubject) {
        setSubject((now) => (now.trim() === submittedSubject ? "" : now));
      }
    }
    return sent;
  };

  const canSend = !sending && !imageLoading && (images.length > 0 || !richEmpty);
  const scheduleBanner = scheduledBanner(
    scheduledHere.filter((m) => m.conversation_id === openId).map((m) => m.scheduled_time ?? 0),
  );
  // Whether these words will be encrypted, and whether the thread disagrees with the
  // passphrase this machine would seal them under. Both are read from what the app already
  // holds — the backend's own seal status, and the messages on screen — so neither costs a
  // request and neither can go stale behind a reader who is already typing.
  // What the next send would carry, kept where `send` can read it (see `threadOnlyRef`). It is
  // the WHOLE decision rather than the tick alone: `broadcast` is false for the bar under the
  // conversation and for a channel thread's, so neither can ever fold a reply.
  useEffect(() => {
    threadOnlyRef.current = broadcast && !alsoToChat;
  }, [broadcast, alsoToChat]);

  const sealed = sealIsOn(sealStatus, openId);
  const sealMismatch = sealKeyDisagrees(sealStatus, openId, openMessages);

  /** Send the composer's snapshot — now, or at `scheduledAt` if the reader picked a
   *  moment. One path for both, so a scheduled message carries the same pictures, the
   *  same mentions and the same reply as the one Enter would have sent. */
  const submit = (scheduledAt: number | null = null) => {
    if (!canSend) return;
    scheduledAtRef.current = scheduledAt;
    // An empty field with a picked image is a valid send: the image travels with an
    // empty body, so the editor has nothing to serialize.
    if (richEmpty) void send("");
    else richSubmitRef.current?.();
  };

  const focusField = () => richFocusRef.current?.();

  return (
    <div
      // THE LIVE SENTINEL IS THE CONVERSATION'S OWN BAR AND NOTHING ELSE.
      //
      // `web/scripts/sandbox-live.ts` is allowed to type into the REAL account in exactly one
      // conversation (the sandbox chat in AGENTS.md) and proves which one is open by reading
      // `data-conversation-id` off `composer-shell` before every keystroke. A thread's bar is a
      // SECOND box on screen, so it takes a name of its own: `composer-shell` still resolves to
      // exactly one element, and that element still carries the app's own `openId` rather than
      // the URL or the script's assumption. Keep both stable.
      //
      // What a keystroke can reach is unchanged either way — a thread's bar posts a reply into
      // a thread OF THIS CONVERSATION, so both bars name the same conversation and the proof
      // means what it always meant.
      data-testid={thread ? "thread-composer-shell" : "composer-shell"}
      data-conversation-id={openId ?? ""}
      // WHICH thread this bar posts into, for the reason the conversation is stated: a panel
      // opened from a row that has since scrolled away is still this thread's.
      data-thread-root={thread ? thread.root.id : undefined}
      className={cn(
        "composer-shell relative shrink-0 bg-background",
        // A thread's bar sits INSIDE its panel, which already carries the panel's own padding,
        // so it takes the narrower gutter the panel is written at.
        thread ? "px-3 pb-3 md:px-4" : "px-4",
      )}
    >
      {/* The history dissolves into the page immediately above the bar. The overlay
          hangs off the composer's own top edge (bottom-full) rather than the bottom
          of the scroll area, so no unfaded strip of padding is left between the two
          — the fade lands exactly where the bar (or its reply banner) begins. */}
      {/* Only under the CONVERSATION: the fade dissolves the history into the page above the
          bar, and a thread's panel has its own scroller with its own end. */}
      {!thread && (
        <div
          aria-hidden
          className="composer-fade pointer-events-none absolute inset-x-0 bottom-full h-14"
        />
      )}

      {/* The reading column. The bar is capped a touch wider than the history
          (`max-w-composer` vs `max-w-chat`), so it reads as a frame under the
          messages rather than a box that ends exactly where they do. The fade
          above stays full-width, because it belongs to the whole history. */}
      <div className={cn("mx-auto w-full", thread ? "max-w-none" : "max-w-composer")}>
        {!thread && replyingTo && (
          <div
            data-testid="reply-banner"
            className="mb-2 flex items-start gap-2 rounded-xl border-l-2 border-primary bg-card px-3 py-2 shadow-chip animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
          >
            <div className="min-w-0 flex-1">
              {/* A channel reply is a POST IN A THREAD written a screen away from that
                  thread, so the banner names the thread rather than the person (see
                  `replyHeading`). It is the one thing on screen beside the box that says
                  where the next Enter lands. */}
              <div className="text-xs font-semibold text-primary">
                {replyHeading(replyingTo.message, replyingTo.threadRoot)}
              </div>
              <div className="truncate text-xs text-text-faint">
                {copyableMessageText(replyingTo.message)}
              </div>
              {/* AND WHETHER IT ALSO LANDS IN THE RUNNING HISTORY. In THIS bar the box sits
                  in the banner, because the banner is the one authority on where the next
                  Enter lands and this is the other half of that sentence. A thread's own bar
                  has no banner, so it carries the box under its field instead — which is
                  where the reference puts it (see the second `BroadcastBox` below). */}
              {broadcast && <BroadcastBox checked={alsoToChat} onChange={setAlsoToChat} />}
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
        {/* Where the words went when the last send here was queued for later — ABOVE the
            box rather than inside it, because the message is in NO thread and this line
            plus the list it links to are the only things on screen accounting for them.
            Inside the box it read as part of the message being written. */}
        {!thread && scheduleBanner && (
          <div
            data-testid="composer-schedule-note"
            className="mb-2 flex items-start gap-2 px-1 text-xs text-text-dim"
          >
            <HugeiconsIcon
              icon={Clock01Icon}
              className="mt-0.5 size-3.5 shrink-0"
              strokeWidth={1.6}
            />
            {/* The sentence and the link are ONE flowing block, not a row with the link
                pinned right: at a phone's width the sentence takes two lines, and a link
                held against the far edge then floats beside a ragged paragraph. Inline, it
                wraps with the words — which is also where the reference puts it. */}
            <p className="min-w-0 flex-1">
              {scheduleBanner}{" "}
              <button
                type="button"
                data-testid="composer-schedule-open-list"
                onClick={() => setScheduledOpen(true)}
                className="font-medium text-primary hover:underline"
              >
                See all scheduled messages
              </button>
            </p>
          </div>
        )}
        <ScheduledMessagesDialog open={scheduledOpen} onOpenChange={setScheduledOpen} />
        <div
          className="relative flex cursor-text flex-col gap-2 rounded-2xl bg-card px-3 py-2.5 shadow-chip transition-shadow focus-within:shadow-card"
          onMouseDown={(event) => {
            // Clicking anywhere in the box focuses the field, except the action
            // buttons (send / format bar / image), the field itself, and the TITLE —
            // each of which handles its own clicks. A press on the title that fell
            // through here would put the caret in the body instead, which makes the
            // title field unusable by pointer.
            const element = event.target as HTMLElement;
            if (element.closest("button, input, [contenteditable]")) return;
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
              data-testid={tid("composer-toolbar")}
              className="flex min-h-7 items-center gap-0.5 border-b border-border-subtle pb-2 animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
            >
              <Suspense fallback={null}>{editor && <FormatToolbar editor={editor} />}</Suspense>
            </div>
          )}

          {/* The TITLE, on a channel post only — Teams' own "Add a subject", and the line
              its announcements draw above the body. It is a separate FIELD rather than a
              first line of the message because that is what it is on the wire: a property,
              not words in the body (see lib/post-subject.ts), so a client that typed it
              into the message would show a colleague a bold sentence instead of a titled
              post. It sits at the top of the box, above the words it titles, set in the
              weight it is drawn in and ruled off from them — which is the differentiation
              the whole feature is about. Native `maxLength` is the ceiling, so the field
              refuses the 251st character instead of the send refusing the title. */}
          {/* THAT THESE WORDS WILL BE ENCRYPTED, and nothing else: one quiet mark in the
              corner of the box the reader is typing in.
              It was two sentences above the field — what the seal covers, and the warning that
              the thread disagrees with this machine's passphrase — and both were too loud for a
              standing state: a line that is there on every message of every sealed chat is
              furniture, and it pushed the field down. The words survive where they are ACTED on
              rather than merely true: the dialog states what the seal covers and what it does
              not, and it is the dialog that reports a passphrase opening nothing already in the
              thread (`sealSetMismatch`).
              A DISAGREEMENT says so on HOVER and never in colour: the mark stays as quiet in that
              state as in the ordinary one, because a red glyph in the corner of the box is the
              same interruption the red line was. What it costs is stated plainly — there is no
              hover on a phone, so a phone reader meets that warning in the dialog behind the
              header's menu, which is also where it can be acted on.
              It cannot collide with the post TITLE above it: a channel is the only conversation
              with that field and a channel cannot be sealed (`sealCanBeUsed`). */}
          {sealed && (
            <span
              data-testid={tid("composer-seal-mark")}
              data-seal-mismatch={sealMismatch ? "true" : undefined}
              role="img"
              // A `title` on an `<svg>` is not a tooltip, so the span carries both it and the
              // accessible name and the glyph inside is hidden.
              title={sealMismatch ? SEAL_MISMATCH_HINT : SEAL_COMPOSER_HINT}
              aria-label={sealMismatch ? SEAL_MISMATCH_HINT : SEAL_COMPOSER_HINT}
              className="pointer-events-auto absolute right-2.5 top-2 z-10 text-text-faint/60"
            >
              <HugeiconsIcon icon={SquareLock02Icon} className="size-3" strokeWidth={1.8} aria-hidden />
            </span>
          )}

          {subjectOffered && (
            <input
              type="text"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              // Enter belongs to the message, so in the title it moves to the words rather
              // than posting a titled nothing — and Escape does the same instead of reaching
              // the shell, whose Escape LEAVES the conversation (`goToList`) and would drop
              // the title with it: the words are a persisted draft and this line is not.
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                focusField();
              }}
              maxLength={POST_SUBJECT_MAX_CHARS}
              placeholder="Add a subject"
              aria-label="Post title"
              data-testid="composer-subject"
              // 16px so iOS does not zoom the page on focus (the rule
              // COMPOSER_FIELD_CLASS states), and 44px tall so it clears the touch floor
              // every other target in this app clears — this box is aimed at with a thumb.
              className="min-h-11 w-full border-b border-border-subtle bg-transparent px-1 text-base font-semibold text-foreground outline-none placeholder:font-normal placeholder:text-text-faint"
            />
          )}

          {/* The pending pictures, above the field like Teams: a thumbnail each, with its
              pixel size and its own remove button, in the order they were added. They are
              local previews (data URLs), so nothing is uploaded until the message is
              actually sent. Several of them wrap onto their own rows rather than widening
              the box — the composer's width belongs to the conversation, not to a paste —
              and they are drawn SMALLER than a single one, because ten pictures at the
              height one gets is a composer that has eaten the conversation. */}
          {images.length > 0 && (
            <div data-testid={tid("composer-images")} className="flex flex-wrap items-start gap-3 pt-1">
              {images.map((image) => (
                <div
                  key={image.id}
                  data-testid={tid("composer-image-preview")}
                  data-image-name={image.name}
                  className="relative w-fit max-w-full"
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className={cn(
                      "max-w-full rounded-xl border border-border-subtle object-contain",
                      images.length > 1 ? "max-h-24" : "max-h-40",
                    )}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    title="Remove image"
                    data-testid={tid("composer-image-remove")}
                    onClick={() => removeImage(image.id)}
                    className="absolute -right-2 -top-2 grid size-7 place-items-center rounded-full bg-popover text-foreground shadow-pop hover:bg-accent"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="size-4" strokeWidth={1.8} />
                  </button>
                  <div className="mt-1 text-xs text-text-faint">
                    {image.width} × {image.height}
                  </div>
                </div>
              ))}
            </div>
          )}
          {imageError && (
            <div role="alert" data-testid={tid("composer-image-error")} className="text-xs text-destructive">
              {imageError}
            </div>
          )}
          {/* Why the last message did not leave, beside the words that are still in the
              box. The status line at the foot of the sidebar carries the raw failure for
              whoever debugs it; this is the half the user reads, and without it a refused
              send is a button that chimes and does nothing (see lib/send-failure.ts). */}
          {sendError && (
            <div role="alert" data-testid={tid("composer-send-error")} className="text-xs text-destructive">
              {sendError}
            </div>
          )}

          {/* The one input field: a bare-looking rich editor that hands a pasted image
              to `handlePaste` instead of inserting it as content. The placeholder under
              `Suspense` carries the field's own metrics, so the box does not resize when
              the editor arrives. */}
          <Suspense fallback={<div className={COMPOSER_FIELD_CLASS} aria-hidden />}>
            <RichEditor
              // Keyed per BOX: the conversation's bar is keyed by the conversation, and a
              // thread's by its own thread — so opening another thread gets a fresh field
              // seeded from that thread's own draft rather than the last one's words.
              key={threadKey ?? openId ?? "none"}
              initialContent={draftToHtml(draft)}
              focusToken={props.focusToken}
              toolbarVisible={toolbarOpen}
              submitRef={richSubmitRef}
              focusRef={richFocusRef}
              onEmptyChange={setRichEmpty}
              onEditorChange={setEditor}
              // Mirror the editor's text into the draft, so a half-written message
              // survives a walk through other conversations.
              onChangeText={(text) =>
                threadKey ? controller.setThreadDraftText(threadKey, text) : controller.setDraftText(text)
              }
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
              // Words the scheduled list handed back. Never another thread's: a message
              // cancelled in one conversation must not appear in the box of another.
              restoreDraft={
                // Never in a THREAD's bar: the words handed back are a message that was queued
                // for the CONVERSATION, and putting them in a thread would re-post them
                // somewhere nobody sent them (see the scheduled list's Edit).
                !thread && composerRestore && composerRestore.conversation === openId
                  ? { html: draftToHtml(composerRestore.text), token: composerRestore.token }
                  : null
              }
              testId={tid("composer-rich")}
              // A thread's bar says what it answers. The two bars stand side by side, so an
              // identical placeholder would make them read as one box drawn twice.
              placeholder={thread ? "Reply…" : undefined}
              onMentionQuery={() => void controller.ensureMentionCandidates()}
              customEmojiPack={customEmojiPack}
              unicodeShortcodes={unicodeShortcodes}
            />
          </Suspense>

          {/* A THREAD'S OWN BROADCAST BOX, under the words and above the controls, which is
              where the reference draws it. This bar writes nothing but a reply, so there is no
              banner to hang it in — and the box is the one thing on screen that says the reply
              can also land in the running history (§ A CHAT HAS THREADS TOO). */}
          {thread && broadcast && <BroadcastBox checked={alsoToChat} onChange={setAlsoToChat} />}

          {/* Bottom control bar: format bar toggle and image picker on the left, send
              on the right. */}
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={toolbarOpen ? "Hide formatting options" : "Show formatting options"}
                aria-pressed={toolbarOpen}
                title={toolbarOpen ? "Hide formatting options" : "Show formatting options"}
                data-testid={tid("composer-format-toggle")}
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
              {/* The picker itself: hidden, opened by the button beside it. It takes several
                  files at once, as the clipboard does. Its value is cleared on every change
                  so re-picking the same file still fires. */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={composerImageAccept()}
                data-testid={tid("composer-image-input")}
                className="sr-only"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  event.target.value = "";
                  void addImages(files);
                }}
              />
              <button
                type="button"
                aria-label={images.length > 0 ? "Add another image" : "Add image"}
                title={images.length > 0 ? "Add another image" : "Add image"}
                data-testid={tid("composer-image-button")}
                disabled={imageLoading || sending}
                onClick={() => fileInputRef.current?.click()}
                className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50"
              >
                {imageLoading ? (
                  <FadeArc className="size-4" />
                ) : (
                  <HugeiconsIcon icon={ImageAdd01Icon} className="size-4" strokeWidth={1.6} />
                )}
              </button>
            </div>

            {/* ONE pill, split in two: Send, and the chevron that discloses "later".
                They answer one question — now, or then — so two separate buttons would ask
                the reader to tell them apart. Slack's own shape. */}
            <div
              data-testid={tid("composer-send-group")}
              className={cn(
                "flex shrink-0 items-center rounded-full transition-all",
                canSend && "shadow-chip",
              )}
            >
              <button
                type="button"
                aria-label={sending ? "Sending message" : "Send message"}
                title="Send (Enter)"
                data-testid={tid("composer-send")}
                disabled={!canSend}
                onClick={() => submit()}
                className={cn(
                  "grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-l-full transition-all disabled:cursor-default",
                  canSend
                    ? "bg-primary text-primary-foreground hover:brightness-110 active:brightness-95"
                    : "bg-element text-text-faint",
                )}
              >
                {sending ? (
                  <FadeArc className="size-4" />
                ) : (
                  <HugeiconsIcon icon={SentIcon} className="size-4" strokeWidth={1.8} />
                )}
              </button>
              <ScheduleSendMenu canSend={canSend} onSchedule={(at) => submit(at)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "ALSO SEND TO THE CHAT" — one row, drawn wherever a reply is being written.
 *
 * It is one component because it is one control: the bar under the conversation hangs it in the
 * reply banner (which is what says where the next Enter lands there) and a thread's own bar
 * carries it under its field, and neither may say it differently from the other.
 *
 * THE BOX IS THE INK and the 44px target is GROWN — the technique the thread foot row, the
 * dialog's close and the slider's thumb already use. A box a thumb tall would push the field
 * down by half a centimetre on every reply, in a bar the reader is about to type in.
 */
function BroadcastBox(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label
      data-testid="reply-broadcast"
      title={BROADCAST_HINT}
      className="relative mt-1.5 inline-flex h-6 w-fit cursor-pointer items-center gap-2 text-[11px] text-text-dim after:absolute after:inset-x-0 after:-bottom-2.5 after:-top-2.5 after:content-['']"
    >
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
        className="size-3.5 shrink-0 accent-primary"
      />
      <span>{BROADCAST_LABEL}</span>
    </label>
  );
}

import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowTurnBackwardIcon,
  ArrowTurnForwardIcon,
  BanIcon,
  CopyIcon,
  Delete02Icon,
  EyeIcon,
  EyeOffIcon,
  MessageSquareDashedIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SmilePlusIcon,
} from "@hugeicons/core-free-icons";
import {
  bodyFormat,
  copyableMessageText,
  mentionsByItemId,
  parseRichMessage,
  urlHost,
  type ChatMessage,
  type LinkMetadata,
  type ParsedRichMessage,
  type Reaction,
} from "~/lib/protocol";
import { reactionEmoji, REACTION_PICKER } from "~/lib/teams-emoji";
import { hasActivePipeline } from "~/lib/gitlab-pipeline";
import { LINEAR_WEB_HOST } from "~/lib/linear";
import {
  containsImage,
  dropLinks,
  extractLinks,
  hasNonImageContent,
  hasVisibleContent,
  parseMessageBody,
} from "~/lib/rich-text";
import { agentAuthorship } from "~/lib/agent-message";
import { agentRunIsLive, type AgentRun } from "~/lib/agent-run";
import { CardAttachment } from "~/components/card-attachment";
import { RichContent } from "~/components/rich-content";
import { cn } from "~/lib/utils";
import { AgentSignature, AgentStoredStatus, AgentStream } from "./agent-reply";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { FileAttachment, MediaImage, RecordingAttachment } from "./media-image";
import { GitLabLinkCard } from "./gitlab-link-card";
import { LinearLinkCard } from "./linear-link-card";
import { PersonHoverCard } from "./person-card";
import { Emoji } from "./emoji";
import { useAppState, useController } from "./controller-context";
import { useMessageGestures } from "./use-message-gestures";

// emoji-mart and its dataset are ~1.5 MB and only needed once someone reaches
// past the six quick reactions, so the full picker is a lazy chunk.
const EmojiPicker = lazy(() => import("./emoji-picker"));

/** Room reserved below a bubble that carries reactions. The chip row straddles
 *  the bubble's bottom edge — a third of a pill inside it, the rest hanging out
 *  (see {@link ReactionChips}) — and is positioned absolutely, so it takes no
 *  layout space of its own. This margin is that overhang (~20px of a 30px pill)
 *  plus enough air that the chips read as belonging to their own message rather
 *  than crowding whatever follows: the next message, or this message's "seen by"
 *  line. */
const REACTION_OVERHANG = "mb-7";

/** Resolved enrichment for a set of links, keyed by URL: `undefined` while a
 *  lookup is in flight, `null` when the link is not an enrichable integration,
 *  or the provider-tagged metadata once resolved. */
type LinkResults = Map<string, LinkMetadata | null | undefined>;

/** Whether a resolved link is a merge request whose CI is still in flight — the
 *  one thing worth re-polling. Narrowed on the provider first: only GitLab has a
 *  pipeline, and both providers use the kind "issue". */
function isPollable(meta: LinkMetadata | null | undefined): boolean {
  return meta?.provider === "gitlab" && hasActivePipeline(meta);
}

/** How often to re-fetch a merge request whose pipeline is still running. Kept
 *  conservative: only links with an in-progress pipeline are polled (see
 *  {@link hasActivePipeline}), and only while the tab is visible, so this stays a
 *  trickle even with many open merge requests. */
const PIPELINE_POLL_MS = 20_000;

/**
 * Enrich a stable list of URLs through the controller (which goes to the backend
 * and caches per URL). Returns a reactive map of results so the caller can hide
 * enriched links from the body and render their cards. The owning component, not
 * the card, drives this so it can decide the message's layout from the outcome.
 *
 * A merge request whose pipeline is still running is additionally re-polled on an
 * interval (see {@link PIPELINE_POLL_MS}) so its status badge stays live; polling
 * stops the moment every pipeline reaches a terminal state.
 */
function useEnrichedLinks(urls: string[]): LinkResults {
  const controller = useController();
  const [results, setResults] = useState<LinkResults>(new Map());
  // A stable key so the effect only re-runs when the actual set of URLs changes.
  const key = urls.join("\n");

  useEffect(() => {
    let alive = true;
    for (const url of urls) {
      controller
        .enrichLink(url)
        .then((meta) => alive && setResults((prev) => new Map(prev).set(url, meta)))
        .catch(() => alive && setResults((prev) => new Map(prev).set(url, null)));
    }
    return () => {
      alive = false;
    };
    // `urls` is captured via its stable string `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key]);

  // Live pipeline polling. While any resolved link is a merge request with an
  // in-progress pipeline, re-enrich just those links on an interval so the badge
  // follows the running CI. The interval is armed only when something is active
  // and torn down as soon as everything is terminal; it pauses while the tab is
  // hidden, and a transient refresh failure keeps the last-known status.
  const anyActive = urls.some((url) => isPollable(results.get(url)));
  const resultsRef = useRef(results);
  resultsRef.current = results;

  useEffect(() => {
    if (!anyActive) return;
    let alive = true;
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      for (const url of urls) {
        if (!isPollable(resultsRef.current.get(url))) continue;
        controller
          .refreshLink(url)
          .then((meta) => alive && meta && setResults((prev) => new Map(prev).set(url, meta)))
          .catch(() => {
            /* keep the last-known status on a transient refresh failure */
          });
      }
    }, PIPELINE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // `urls` is captured via `key`; `resultsRef` keeps the interval off the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key, anyActive]);

  return results;
}

/**
 * A single chat message rendered as a bubble. Mine align right with an accent
 * background; others align left in the element color. The sender name shows only
 * on incoming bubbles in group chats. Replies render the quoted message as a
 * recessed block with a left accent bar, preserving text before/after the quote.
 * Inbound Teams formatting (bold, links, lists, mentions, …) is rendered via
 * {@link RichContent}. When `editing` is true, the body is replaced by an
 * in-place editor (Enter to save, Shift+Enter for a newline, Escape to cancel).
 *
 * GitLab links that resolve to a rich integration are shown as a preview card
 * and removed from the body text (never both). When the message is *only* such a
 * link, the bubble chrome is dropped entirely and just the card is shown.
 *
 * Likewise, a message that is *only* an image (inline or an image attachment,
 * with no text) drops the bubble chrome and instead frames the picture on a soft
 * "atelier" mat — a neutral card, the same on both sides, carrying a faint
 * diagonal hatch that peeks around the picture's padded edges. On an incoming
 * image-only message the sender name still shows, floating above the mat.
 */
/**
 * Memoized: the pane renders one of these per visible message, and a single live
 * message (or any other pane-level state change) would otherwise re-render every
 * mounted bubble — parsing its HTML and reconciling its whole subtree. The pane
 * keeps every callback prop stable (see its `useCallback`s) so this actually
 * bails out; `message` is reference-stable because the store replaces a message
 * object only when it really changed.
 */
export const MessageBubble = memo(MessageBubbleImpl);

function MessageBubbleImpl(props: {
  message: ChatMessage;
  showSenderName: boolean;
  editing: boolean;
  continuesAbove: boolean;
  continuesBelow: boolean;
  highlighted?: boolean;
  /** The live agent run writing INTO this message, when one is (see lib/agent-run.ts).
   *  The pane passes it only to the message it targets; the body then comes from the
   *  stream instead of from the stored content. */
  agentRun?: AgentRun;
  /** Let go of a settled run — passed straight through to {@link AgentStream}. */
  onAgentSettled?: () => void;
  /** This message already sits on a surface of its own: it is the root post of a
   *  channel thread, and the thread's card is that surface. A message that would
   *  otherwise bring its own panel — an app card — renders flush inside it
   *  instead of as a card within a card. */
  onPanel?: boolean;
  onReply: (message: ChatMessage) => void;
  onCopy: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, key: string) => void;
  onStartEdit: (message: ChatMessage) => void;
  onSaveEdit: (message: ChatMessage, text: string) => void;
  onCancelEdit: () => void;
  onDelete: (message: ChatMessage) => void;
}) {
  // A message the local agent wrote, from the line it signs itself with. It went out
  // through the user's account, so the wire calls it ours — but they did not write it,
  // and it takes the side of everything that arrives rather than of everything they
  // sent (see components/agent-reply.tsx for why that is the honest choice).
  const agent = useMemo(() => agentAuthorship(props.message), [props.message]);
  const mine = props.message.is_self === true && !agent;
  // How this body must be read. A `Text` message is plain text: it carries no Teams
  // markup at all, so there is no quote to split out of it and nothing to parse —
  // the whole body IS the body, shown verbatim.
  const format = bodyFormat(props.message.message_type);
  // An agent's body is the message minus its signature: the mark and the name above the
  // bubble say the same thing, and the bubble must not say it twice.
  const content = agent ? agent.bodyHtml : props.message.content;
  const parsed = useMemo<ParsedRichMessage>(
    () => (format === "text" ? { bodyHtml: content } : parseRichMessage(content)),
    [content, format],
  );
  // Who the body's @mention spans point at, so each mention of a person can offer
  // their card on hover (the span itself only carries an index — see
  // `mentionsByItemId`).
  const mentions = useMemo(() => mentionsByItemId(props.message), [props.message]);
  // Candidate integration links in the authored body (not the quoted reply): the
  // configured GitLab host, and Linear's fixed one. Filtering by host keeps
  // enrichment to links an integration could plausibly claim, so an ordinary link
  // costs no round-trip; the backend stays authoritative on whether one really is
  // enrichable.
  const gitlabHost = useAppState((s) => s.settings.gitlab_host);
  const candidateLinks = useMemo(() => {
    const hosts = new Set([gitlabHost.trim().toLowerCase(), LINEAR_WEB_HOST].filter(Boolean));
    const body = `${parsed.beforeHtml ?? ""}\n${parsed.bodyHtml}`;
    return extractLinks(body, format).filter((u) => hosts.has(urlHost(u) ?? ""));
  }, [parsed, format, gitlabHost]);

  const enrichment = useEnrichedLinks(candidateLinks);

  // The links that resolved to an integration → shown as cards and hidden from
  // the body, and the cards themselves (in document order).
  const cards = useMemo(() => {
    const out: { url: string; meta: LinkMetadata }[] = [];
    for (const url of candidateLinks) {
      const meta = enrichment.get(url);
      if (meta) out.push({ url, meta });
    }
    return out;
  }, [candidateLinks, enrichment]);
  const hiddenHrefs = useMemo(() => new Set(cards.map((c) => c.url)), [cards]);

  // The rendered body, split into its before-quote and main parts, each parsed
  // to a node tree with carded links removed. Computed once so we can ask
  // several questions of it (has text? has an image?) without re-parsing.
  const bodyParts = useMemo(() => {
    const parse = (body?: string) =>
      body ? dropLinks(parseMessageBody(body, format), hiddenHrefs) : [];
    return [parse(parsed.beforeHtml), parse(parsed.bodyHtml)];
  }, [parsed, format, hiddenHrefs]);
  // Any renderable content (text, links, lists, OR images) once carded links go.
  const bodyHasContent = useMemo(() => bodyParts.some(hasVisibleContent), [bodyParts]);
  // Real, non-image content — a text-free image body reads as empty here.
  const bodyHasText = useMemo(() => bodyParts.some(hasNonImageContent), [bodyParts]);
  // At least one inline image in the body.
  const bodyHasImage = useMemo(() => bodyParts.some(containsImage), [bodyParts]);

  const attachments = props.message.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  const imageAttachments = attachments.filter((a) => a.kind === "image");
  const recordingAttachments = attachments.filter((a) => a.kind === "recording");
  const cardAttachments = attachments.filter((a) => a.kind === "card");

  // When the message is *only* an integration link (a card, no quote, no
  // attachments, no other body content), the bubble chrome is dropped and just
  // the card is shown.
  const linkOnly =
    !props.editing && !parsed.quote && !hasAttachments && cards.length > 0 && !bodyHasContent;

  // A media-only message: at least one image and nothing else — no text, no
  // quote, no link card, and any attachments are images too. Such messages swap
  // the bubble chrome for the "atelier" mat below (mine and incoming alike); an
  // incoming one still shows the sender's name above the mat.
  //
  // A Teams emoji is *not* an image here even though it arrives as an `<img>`:
  // the parser turns it into its own character (see `isEmojiImage`), so an
  // emoji-only message counts as text and keeps its ordinary bubble instead of
  // being framed on the mat like a 20 px photo.
  const hasImage = bodyHasImage || imageAttachments.length > 0;
  const imageOnly =
    !props.editing &&
    !parsed.quote &&
    cards.length === 0 &&
    hasImage &&
    !bodyHasText &&
    imageAttachments.length === attachments.length;

  // A card-only message: an app/bot card and nothing else — which is what a whole
  // notifications channel (GitHub, Figma, Sentry, n-Alerts) consists of. The card
  // brings its own surface, so wrapping it in a coloured bubble would frame it
  // twice; like a link card it becomes the message.
  const cardOnly =
    !props.editing &&
    !parsed.quote &&
    cards.length === 0 &&
    cardAttachments.length > 0 &&
    !bodyHasContent &&
    cardAttachments.length === attachments.length;

  // The card IS the root post of a channel thread, and that thread already draws
  // a card around the whole post. So the card renders flush on that panel and
  // spans it, instead of being a smaller card inside a bigger one.
  const cardOnPanel = cardOnly && props.onPanel === true;

  // A recording-only message: a meeting recording and nothing else (the backend
  // clears the body and any sender for these, so they always arrive this way).
  // Like an image-only message it drops the bubble chrome — the recording card
  // (poster + play + caption) is its own surface, so it needs no mat.
  const recordingOnly =
    !props.editing &&
    !parsed.quote &&
    cards.length === 0 &&
    recordingAttachments.length > 0 &&
    !bodyHasContent &&
    recordingAttachments.length === attachments.length;

  // A message the sender has deleted on Teams. It always renders as a plain
  // bubble (a muted "message deleted" placeholder), never as a bare image/link/
  // recording surface — so the media-only treatments are suppressed below. It is
  // revealable only when we cached the original before it was deleted (its body
  // or an attachment survived in our store); a deletion we only ever saw as a
  // tombstone has nothing to reveal.
  const isDeleted = props.message.deleted === true;
  const revealable = isDeleted && (bodyHasContent || hasAttachments);

  // A message with NO visible payload at all: an empty body, no attachment, no
  // quote, no link card — and not a deletion, which has its own placeholder. Such a
  // message is either a Teams payload this client cannot show (a voice memo, a form
  // response) or a machine frame that should never have been stored. Rendering it as
  // it was — a blank coloured pill — tells the reader nothing; dropping it silently
  // hides that anything was sent, which reads as a hole in the conversation the
  // next message then replies into. So it says so, once, quietly, the way Teams
  // itself owns up to a message type it cannot render.
  // An agent's reply is never unshowable, even when its body is empty: the placeholder
  // the backend posts the instant a trigger lands ("claude is thinking…") IS an empty
  // body, and it is the most informative thing on screen at that moment.
  const isUnsupported =
    !isDeleted &&
    !props.editing &&
    !agent &&
    !bodyHasContent &&
    !hasAttachments &&
    !parsed.quote &&
    cards.length === 0;

  // A message nobody can act on: gone (deleted) or unshowable (unsupported). There
  // is nothing to reply to, copy, edit or react to, so the actions menu does not
  // appear on it. Reactions already on it still show — they are information the
  // reader would otherwise lose.
  const inert = isDeleted || isUnsupported;

  // Media- and link-only messages render without the standard rounded, colored
  // bubble — an image gets the atelier mat, a recording its video card, a link or
  // app card just the card. A deleted or unsupported message keeps a bubble: its
  // placeholder is the body. An agent's reply keeps one too: its mark and its status
  // line belong to a bubble, and an answer that happens to be one link is still an
  // answer.
  const bare = !isDeleted && !agent && (linkOnly || imageOnly || recordingOnly || cardOnly);

  // Only label the first message of a same-author run; continuations are clearly
  // from the same person. A message with no sender (e.g. a meeting recording,
  // whose only author hint is a bare contacts URL the backend drops) shows no
  // name — an empty label would just be a blank gap above the card. An agent's reply
  // carries its own mark instead, in every thread rather than only in a group: WHO
  // wrote it is the whole point of the label there.
  const nameShown =
    !mine &&
    !agent &&
    props.showSenderName &&
    !props.continuesAbove &&
    props.message.sender.trim() !== "";
  const [menuOpen, setMenuOpen] = useState(false);

  // Reactions on this message, and which emotion (if any) is ours — the latter
  // highlights our chip and lets a click on it toggle the reaction off.
  const reactions = props.message.reactions ?? [];
  const myReactionKey = reactions.find((r) => r.mine)?.key;
  // Chips only show on a live, non-edited message, so only then is there an
  // overhang to reserve room for.
  const chipsShown = reactions.length > 0 && !props.editing && !isDeleted;

  // The full emoji picker (all ~1550 Teams reactions), anchored to the bubble so
  // it survives the ⋯ menu it was opened from — that menu closes on select, and a
  // popover must outlive the surface that opened it.
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiTheme = useAppState((s) => s.resolvedTheme);
  const messageGestures = useMessageGestures({
    enabled: !inert && !props.editing,
    mine,
    onLongPress: () => setMenuOpen(true),
    onReply: () => props.onReply(props.message),
  });

  // Set while the ⋯ menu closes because it handed off to the full picker, so the
  // menu can skip its focus restore that once (see `onCloseAutoFocus` below).
  const handingOffToPicker = useRef(false);

  // Hand off from the ⋯ menu's quick row to the full picker: the menu steps aside,
  // since both are the same one-reaction decision.
  const openEmojiPicker = () => {
    handingOffToPicker.current = true;
    setMenuOpen(false);
    setEmojiPickerOpen(true);
  };

  // Apply a reaction from any surface (the menu bar, the emoji picker, or a chip),
  // then close every transient surface. The backend toggles server-side.
  const react = (key: string) => {
    setMenuOpen(false);
    setEmojiPickerOpen(false);
    props.onReact(props.message, key);
  };

  // The quoted message a reply carries. Its own variable because a streamed agent
  // answer needs it too: the answer is posted as a native reply to the message that
  // summoned it, and a quote that only appeared once the run finished would make the
  // bubble jump at the moment the reader is watching it most closely.
  const quotedBlock =
    parsed.quote ? (
      <div
        className={cn(
          "my-1 rounded-lg border-l-2 px-2.5 py-1.5",
          mine ? "border-sender-name-mine bg-quote-mine" : "border-sender-name bg-quote-incoming",
        )}
      >
        {/* A forward carries no author at all — Teams sends the forwarded content
            and nothing else — so the block says what it is instead of standing
            there as an unattributed quote. */}
        {parsed.quote.kind === "forward" ? (
          <div
            data-testid="quote-forwarded"
            className={cn(
              "flex items-center gap-1 text-xs font-semibold",
              mine ? "text-sender-name-mine" : "text-sender-name",
            )}
          >
            <HugeiconsIcon
              icon={ArrowTurnForwardIcon}
              className="size-3 shrink-0"
              strokeWidth={1.8}
              aria-hidden
            />
            Forwarded
          </div>
        ) : null}
        {parsed.quote.sender ? (
          <div
            className={cn(
              "flex text-xs font-semibold",
              mine ? "text-sender-name-mine" : "text-sender-name",
            )}
          >
            {/* The quoted author is a person too — their card is a hover away
                whenever the quote carried their MRI. */}
            <PersonHoverCard mri={parsed.quote.senderMri} name={parsed.quote.sender}>
              <span data-testid="quote-sender">{parsed.quote.sender}</span>
            </PersonHoverCard>
          </div>
        ) : null}
        <RichContent
          html={parsed.quote.html}
          className={cn("text-xs", mine ? "text-quote-text-mine" : "text-quote-text-incoming")}
        />
      </div>
    ) : null;

  // The message's rendered media/body — text/rich content, a quoted reply, and
  // attachments. Pulled out so an image-only message can wrap it in the
  // "atelier" mat (a framed card) while an ordinary message renders it plainly
  // inside the bubble.
  const mediaBody = (
    <>
      {parsed.beforeHtml ? (
        <RichContent
          html={parsed.beforeHtml}
          format={format}
          hiddenHrefs={hiddenHrefs}
          mentions={mentions}
          cardShownSeparately={cardAttachments.length > 0}
        />
      ) : null}

      {quotedBlock}

      {parsed.bodyHtml ? (
        <RichContent
          html={parsed.bodyHtml}
          format={format}
          hiddenHrefs={hiddenHrefs}
          mentions={mentions}
          cardShownSeparately={cardAttachments.length > 0}
        />
      ) : null}

      {hasAttachments ? (
        <div
          data-testid="message-attachments"
          className={cn("flex flex-col gap-1.5", !cardOnly && "mt-1.5")}
        >
          {attachments.map((att, i) =>
            att.kind === "image" ? (
              <MediaImage key={`att-${i}-${att.url}`} src={att.url} alt={att.name} />
            ) : att.kind === "recording" ? (
              <RecordingAttachment key={`att-${i}-${att.url}`} attachment={att} />
            ) : att.kind === "card" ? (
              <CardAttachment key={`att-${i}-${att.name}`} attachment={att} onPanel={cardOnPanel} />
            ) : (
              <FileAttachment key={`att-${i}-${att.url}`} attachment={att} />
            ),
          )}
        </div>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        "group flex w-full",
        mine ? "justify-end" : "justify-start",
        // Tighten the spacing within a same-author run; keep a wider gap between
        // different authors.
        props.continuesAbove ? "mt-0.5" : "mt-2",
        // Reactions hang below the bubble — grow the gap so they have room.
        chipsShown && REACTION_OVERHANG,
      )}
    >
      <motion.div
        data-testid="message"
        data-mine={mine ? "true" : "false"}
        data-message-id={props.message.id}
        data-highlighted={props.highlighted ? "true" : undefined}
        data-link-only={linkOnly ? "true" : undefined}
        data-image-only={imageOnly ? "true" : undefined}
        data-recording-only={recordingOnly ? "true" : undefined}
        data-card-only={cardOnly ? "true" : undefined}
        data-deleted={isDeleted ? "true" : undefined}
        data-unsupported={isUnsupported ? "true" : undefined}
        style={{ x: messageGestures.x, touchAction: "pan-y" }}
        {...messageGestures.handlers}
        className={cn(
          "relative text-sm leading-relaxed",
          // Media- and link-only messages drop the standard bubble chrome; the
          // link card / atelier mat / recording card (below) becomes the surface.
          // A link card gets a tighter max width; the mat is capped at the usual
          // bubble one; a recording card sizes itself (max-w-sm).
          linkOnly && "max-w-md",
          // A card on its own panel spans it; a card that draws its own stays as
          // narrow as the other bubbles.
          cardOnly && (cardOnPanel ? "w-full" : "w-full max-w-md"),
          imageOnly && "max-w-[76%]",
          recordingOnly && "w-full max-w-sm",
          !bare &&
            cn(
              "max-w-[76%] rounded-2xl px-3.5 py-2",
              // A deleted message — and one with nothing to show — drops the accent
              // fill for a muted, dashed "ghost" bubble (the same on both sides) so
              // it reads as absent rather than as a real message.
              isDeleted || isUnsupported
                ? "border border-dashed border-border bg-transparent text-text-dim shadow-none"
                : mine
                ? "bg-bubble-mine text-bubble-mine-foreground shadow-chip"
                : "bg-bubble-incoming text-bubble-incoming-foreground shadow-card",
              // An agent's reply takes the incoming surface and one hairline more, so it
              // reads as its own kind of message without needing a colour of its own.
              agent && "ring-1 ring-inset ring-primary/15",
              // Chained messages (same author, adjacent) flatten the touching
              // corners on the author's anchor side — right for mine, left for
              // incoming — so a run reads as one continuous block on that edge.
              mine
                ? cn(props.continuesAbove && "rounded-tr-md", props.continuesBelow && "rounded-br-md")
                : cn(props.continuesAbove && "rounded-tl-md", props.continuesBelow && "rounded-bl-md"),
            ),
          // Deep-link highlight: a brief ring pulse when opened from a
          // notification, so the targeted message is unmistakable.
          props.highlighted &&
            "ring-2 ring-primary/70 ring-offset-2 ring-offset-background transition-shadow",
        )}
        onContextMenu={(e) => {
          if (inert) return; // nothing to act on
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {!props.editing && !inert ? (
          <motion.span
            aria-hidden
            data-testid="swipe-reply-indicator"
            style={{
              x: messageGestures.indicatorX,
              opacity: messageGestures.indicatorOpacity,
              scale: messageGestures.indicatorScale,
            }}
            className={cn(
              "pointer-events-none absolute top-1/2 z-0 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground shadow-chip",
              mine ? "left-full ml-2" : "right-full mr-2",
            )}
          >
            <HugeiconsIcon icon={ArrowTurnBackwardIcon} className="size-4" strokeWidth={1.8} />
          </motion.span>
        ) : null}

        {/* The full picker, opened from the ⋯ menu's quick row. Anchored to an
            invisible stand-in for the bubble's own box rather than to the button
            that opened it: that button is transient (the menu closes on select)
            and a popover outlives it. Only mounted while open, so the lazy chunk
            is fetched on first use. */}
        <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
          <PopoverAnchor aria-hidden className="pointer-events-none absolute inset-0" />
          <PopoverContent
            side="top"
            align={mine ? "end" : "start"}
            className="overflow-hidden"
            // Reacting is a pointer gesture on a hovered message; pulling focus
            // back to the bubble on close would scroll the pane to it.
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <Suspense
              fallback={
                <div
                  data-testid="emoji-picker-loading"
                  className="h-[420px] w-[338px] animate-pulse rounded-xl bg-element"
                />
              }
            >
              <EmojiPicker onPick={react} theme={emojiTheme} />
            </Suspense>
          </PopoverContent>
        </Popover>

        {nameShown && (
          <div className="mb-0.5 flex text-xs font-semibold text-sender-name">
            <PersonHoverCard mri={props.message.sender_mri} name={props.message.sender}>
              <span data-testid="sender-name">{props.message.sender}</span>
            </PersonHoverCard>
          </div>
        )}

        {/* Who wrote this: the CLI's own mark, above the answer. Busy while a run is
            still going — including a reply we are only seeing the tail of, because its
            stored body says it was still being written. */}
        {agent && !props.editing ? (
          <AgentSignature
            backend={agent.backend}
            busy={props.agentRun ? agentRunIsLive(props.agentRun) : agent.pending}
          />
        ) : null}

        {props.editing ? (
          <MessageEditor
            initialText={copyableMessageText(props.message)}
            onSave={(text) => props.onSaveEdit(props.message, text)}
            onCancel={props.onCancelEdit}
          />
        ) : isDeleted ? (
          // A deleted message: a muted placeholder that, when the original was
          // cached, unveils it with an "invisible ink" reveal. No reaction chips,
          // link cards, or actions menu — the message is gone; only its ghost (and
          // optionally the cached text) remains.
          <DeletedContent mine={mine} revealable={revealable}>
            {mediaBody}
          </DeletedContent>
        ) : (
          <>
            {agent && props.agentRun ? (
              // A run is writing into this message: its body comes from the stream, not
              // from the content Teams last echoed back. The two agree — the backend
              // edits the message with the same text — but the stream is many frames
              // ahead of the edit, and it knows what the agent is doing between them.
              <>
                {quotedBlock}
                <AgentStream
                  run={props.agentRun}
                  onSettled={props.onAgentSettled ?? (() => undefined)}
                />
              </>
            ) : agent ? (
              // A reply nobody watched being written: everything is known from the
              // message itself, including whether it stopped mid-answer.
              <>
                {mediaBody}
                <AgentStoredStatus authorship={agent} hasBody={bodyHasContent} />
              </>
            ) : isUnsupported ? (
              <UnsupportedContent />
            ) : linkOnly ? null : imageOnly ? (
              // A lone picture: frame it on the atelier mat — a neutral card
              // with a faint diagonal hatch peeking around a few px of padding.
              // `w-fit` hugs the image; `max-w-full` keeps it within the row cap.
              // The mat's radius stays concentric with the image (`rounded-xl`,
              // 12px): outer = inner + padding, so 6px padding → 18px radius.
              <div
                data-testid="image-mat"
                className="image-mat flex w-fit max-w-full flex-col gap-1.5 rounded-[18px] p-1.5 shadow-card"
              >
                {mediaBody}
              </div>
            ) : (
              mediaBody
            )}

            {cards.length > 0 ? (
              <div className={cn("flex flex-col gap-1.5", !linkOnly && "mt-1.5")}>
                {cards.map(({ url, meta }) =>
                  meta.provider === "linear" ? (
                    <LinearLinkCard key={url} metadata={meta} />
                  ) : (
                    <GitLabLinkCard key={url} metadata={meta} />
                  ),
                )}
              </div>
            ) : null}

            {chipsShown ? (
              <ReactionChips reactions={reactions} mine={mine} onToggle={react} />
            ) : null}

            {/* A message nobody can act on gets no actions surface at all. */}
            {inert ? null : (
              <MessageActionsMenu
                mine={mine}
                inside={cardOnPanel}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onCloseAutoFocus={(event) => {
                  // The menu normally returns focus to its trigger when it closes,
                  // which is right for Escape or a click away. On a handoff it is
                  // not: the full picker is a popover that dismisses when focus
                  // lands outside it, so the restore would close the picker the
                  // moment it opened — and emoji-mart's search field is where
                  // focus belongs anyway.
                  if (!handingOffToPicker.current) return;
                  handingOffToPicker.current = false;
                  event.preventDefault();
                }}
                activeReactionKey={myReactionKey}
                onReact={react}
                onMore={openEmojiPicker}
                onEdit={() => props.onStartEdit(props.message)}
                onReply={() => props.onReply(props.message)}
                onCopy={() => props.onCopy(props.message)}
                onDelete={() => props.onDelete(props.message)}
              />
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}

/**
 * The ⋯ actions surface of a bubble, and the only way in to a reaction: a
 * hover-revealed trigger on the author's outer side, opening a menu that leads
 * with the reaction bar and then Edit (mine only), Reply, Copy and Delete (mine
 * only). On a coarse pointer a long press on the bubble opens the same menu.
 * Rendered only for a message there is something to do with — see `inert` in the
 * bubble.
 *
 * Delete asks twice. Every other action here is recoverable — an edit can be edited
 * again, a reaction toggled off — while a deletion removes the message from the
 * thread for everybody, on every device, and nothing brings it back. So the first
 * select does not act: it keeps the menu open and swaps the row for "Delete for
 * everyone", which is the one that calls. The confirmation is dropped whenever the
 * menu closes, so a menu reopened later never starts armed.
 *
 * There is deliberately no floating picker on hover: it appeared over every
 * message the cursor rested on, which is a lot of motion for a rare action that
 * this menu already carries — reachable by keyboard and by touch, which the hover
 * row never was.
 *
 * `inside` moves the trigger into the message's top-right corner, floating on its
 * own chip. A message that spans its container — a card on a channel thread's
 * panel — leaves no room beside it, so a trigger placed outside would be clipped
 * by the history's own horizontal bounds.
 */
function MessageActionsMenu(props: {
  mine: boolean;
  /** Place the trigger inside the message box instead of beside it. */
  inside?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called as the menu closes, before it restores focus to its trigger. */
  onCloseAutoFocus: (event: Event) => void;
  activeReactionKey?: string;
  onReact: (key: string) => void;
  /** Hand off to the full emoji picker — the quick row's "more" affordance. */
  onMore: () => void;
  onEdit: () => void;
  onReply: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A closed menu is disarmed: the next open starts at "Delete", never at the
  // confirmation. Reset on close rather than on open so the row does not visibly
  // change back while the menu is still fading out.
  useEffect(() => {
    if (!props.open) setConfirmingDelete(false);
  }, [props.open]);

  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Message actions"
          data-testid="message-actions"
          className={cn(
            // Hidden until hover on a mouse. A coarse pointer opens this menu
            // with a long press, so the permanent mobile ellipsis is unnecessary.
            "message-actions-trigger absolute hidden size-7 cursor-pointer place-items-center rounded-md text-text-dim transition hover:bg-accent hover:text-foreground focus-visible:grid data-[state=open]:grid data-[state=open]:bg-accent data-[state=open]:text-foreground [@media(pointer:fine)]:grid [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:focus-visible:opacity-100 [@media(pointer:fine)]:group-hover:grid [@media(pointer:fine)]:group-hover:opacity-100 [@media(pointer:fine)]:data-[state=open]:opacity-100",
            props.inside
              // Over the message's own first line, so it needs a fill of its own
              // to stay legible against the text it covers.
              ? "right-0 top-0 bg-card shadow-chip"
              : cn("top-1/2 -translate-y-1/2", props.mine ? "-left-9" : "-right-9"),
          )}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" strokeWidth={1.6} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={props.mine ? "start" : "end"}
        onCloseAutoFocus={props.onCloseAutoFocus}
      >
        <ReactionPicker
          data-testid="menu-reaction-picker"
          activeKey={props.activeReactionKey}
          onPick={props.onReact}
          onMore={props.onMore}
          className="justify-between px-1 pb-1"
        />
        <DropdownMenuSeparator />
        {props.mine && (
          <DropdownMenuItem data-testid="action-edit" onSelect={props.onEdit}>
            <HugeiconsIcon icon={PencilIcon} className="size-4" strokeWidth={1.6} />
            Edit
          </DropdownMenuItem>
        )}
        <DropdownMenuItem data-testid="action-reply" onSelect={props.onReply}>
          <HugeiconsIcon icon={ArrowTurnBackwardIcon} className="size-4" strokeWidth={1.6} />
          Reply
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="action-copy" onSelect={props.onCopy}>
          <HugeiconsIcon icon={CopyIcon} className="size-4" strokeWidth={1.6} />
          Copy
        </DropdownMenuItem>
        {props.mine && (
          <>
            <DropdownMenuSeparator />
            {confirmingDelete ? (
              <DropdownMenuItem
                data-testid="action-delete-confirm"
                destructive
                onSelect={props.onDelete}
              >
                <HugeiconsIcon icon={Delete02Icon} className="size-4" strokeWidth={1.6} />
                Delete for everyone
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                data-testid="action-delete"
                destructive
                onSelect={(event) => {
                  // Hold the menu open: this select arms the confirmation above,
                  // it does not delete.
                  event.preventDefault();
                  setConfirmingDelete(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} className="size-4" strokeWidth={1.6} />
                Delete
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The body of a message with nothing to show: an empty body, no attachment, no
 * quote, not a deletion (see `isUnsupported`). One muted line inside the same ghost
 * bubble a deletion gets — enough for the reader to see that something was sent
 * here and that this client cannot show it, without pretending to know what it was.
 *
 * The alternative, skipping the row entirely, was rejected: it leaves a silent gap
 * that the next message replies into ("did you get the file?" with nothing above
 * it), and it hides a whole class of payloads we would like to hear about rather
 * than quietly swallow.
 */
function UnsupportedContent() {
  return (
    <div data-testid="unsupported-message" className="flex items-center gap-2">
      <HugeiconsIcon
        icon={MessageSquareDashedIcon}
        className="size-3.5 shrink-0"
        strokeWidth={1.6}
        aria-hidden
      />
      <span className="italic">Unsupported message</span>
    </div>
  );
}

/**
 * The body of a deleted message. Collapsed, it is a muted "Message deleted"
 * placeholder (a slashed icon + italic label). When the original was cached
 * before the sender deleted it (`revealable`), a "Reveal" affordance unveils it
 * with an "invisible ink" reveal — the text materializes out of a blur while a
 * single accent shimmer sweeps across, echoing iMessage's hidden-message effect —
 * and a "Hide" control hides it again. Honors reduced-motion (the content just
 * appears, no blur or shimmer). When there is nothing cached to reveal, only the
 * placeholder shows.
 */
function DeletedContent(props: { mine: boolean; revealable: boolean; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  const [shimmerDone, setShimmerDone] = useState(false);
  const reduce = useReducedMotion();

  const reveal = () => {
    setShimmerDone(false);
    setRevealed(true);
  };
  const hide = () => setRevealed(false);

  return (
    <div data-testid="deleted-message" className="min-w-0">
      <AnimatePresence mode="wait" initial={false}>
        {revealed ? (
          <motion.div
            key="revealed"
            className="min-w-0 text-foreground"
            initial={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(12px)" }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.15 : 0.7, ease: [0.2, 0.65, 0.3, 0.9] }}
          >
            {/* The unveiled original, with a one-shot shimmer sweeping over it. */}
            <div className="relative min-w-0">
              {props.children}
              {!reduce && !shimmerDone ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden rounded-md"
                >
                  <motion.span
                    className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-primary/30 to-transparent"
                    initial={{ x: "0%" }}
                    animate={{ x: "400%" }}
                    transition={{ duration: 0.9, ease: "easeInOut" }}
                    onAnimationComplete={() => setShimmerDone(true)}
                  />
                </span>
              ) : null}
            </div>
            <button
              type="button"
              data-testid="deleted-hide"
              onClick={hide}
              className="mt-1 inline-flex items-center gap-1 text-xs text-text-dim transition-colors hover:text-foreground"
            >
              <HugeiconsIcon icon={EyeOffIcon} className="size-3" strokeWidth={1.6} />
              Hide
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="placeholder"
            className="flex items-center gap-2"
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <HugeiconsIcon
              icon={BanIcon}
              className="size-3.5 shrink-0"
              strokeWidth={1.6}
              aria-hidden
            />
            <span className="italic">
              {props.mine ? "You deleted this message" : "This message was deleted"}
            </span>
            {props.revealable ? (
              <button
                type="button"
                data-testid="deleted-reveal"
                onClick={reveal}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs not-italic text-primary transition-colors hover:bg-primary/10"
              >
                <HugeiconsIcon icon={EyeIcon} className="size-3" strokeWidth={1.6} />
                Reveal
              </button>
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * A row of emoji buttons for adding a reaction, in Teams' canonical order,
 * followed by the affordance that opens the full emoji picker. It is the reaction
 * bar at the top of the ⋯ menu; the caller supplies its chrome via `className`.
 * `activeKey` marks our current reaction with a distinct highlight; clicking it
 * removes the reaction, which the highlight and the label ("Remove … reaction")
 * already say — no extra badge needed on top of the emoji.
 */
function ReactionPicker(props: {
  onPick: (key: string) => void;
  onMore: () => void;
  activeKey?: string;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      role="group"
      aria-label="React"
      data-testid={props["data-testid"]}
      className={cn("flex items-center gap-0.5", props.className)}
    >
      {REACTION_PICKER.map(({ key, emoji }) => {
        const active = props.activeKey === key;
        return (
          <button
            key={key}
            type="button"
            aria-label={active ? `Remove ${key} reaction` : `React with ${key}`}
            aria-pressed={active}
            data-active={active ? "true" : undefined}
            data-testid={`reaction-option-${key}`}
            onClick={() => props.onPick(key)}
            className={cn(
              "grid size-7 place-items-center rounded-full leading-none transition-transform",
              active ? "bg-primary/20 ring-1 ring-inset ring-primary/50" : "hover:bg-accent",
            )}
          >
            <Emoji emoji={emoji} className="size-[18px]" />
          </button>
        );
      })}
      {/* The six above are the shortcuts; the other ~1500 reactions Teams accepts
          are one click away in the full picker. */}
      <button
        type="button"
        aria-label="More reactions"
        data-testid="reaction-more"
        onClick={props.onMore}
        className="grid size-7 place-items-center rounded-full text-text-dim transition-transform hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={SmilePlusIcon} className="size-[18px]" strokeWidth={1.6} />
      </button>
    </div>
  );
}

/**
 * The reaction chips of a message: one pill per emotion with a count, our own
 * reaction highlighted. Clicking a chip toggles that reaction (removing ours
 * when it is already ours, otherwise adding/replacing it).
 *
 * Placed the way Messenger and Teams place theirs: the row *straddles* the
 * bubble's bottom edge on the author's side — about a third of a pill tucked
 * inside the bubble, the remaining two thirds hanging below it — so the
 * reactions read as attached to the message without eating into its text. It is
 * absolutely positioned so it never widens the bubble; the bubble row reserves
 * the overhang below itself instead (see {@link REACTION_OVERHANG}). That
 * straddling is also why the pills carry a blurred fill and a drop shadow: they
 * sit *on top of* the bubble's edge rather than beside it, so a translucent fill
 * needs the blur to keep the emoji legible over whatever shows through.
 *
 * A count of one is implicit and stays unwritten: the emoji alone says one
 * person reacted, so the pill becomes a circle around it. The number appears
 * from two reactions upward, where it carries information.
 */
function ReactionChips(props: {
  reactions: Reaction[];
  mine: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      data-testid="message-reactions"
      className={cn(
        // `top-full` + `-translate-y-1/3` puts a third of the row's height back
        // inside the bubble; `w-max` lets it extend outward from its anchored
        // side instead of being folded into the bubble's width.
        "absolute top-full z-10 flex w-max -translate-y-1/3 items-center gap-1",
        props.mine ? "right-2" : "left-2",
      )}
    >
      {props.reactions.map((r) => (
        <button
          key={r.key}
          type="button"
          data-testid={`reaction-chip-${r.key}`}
          data-mine={r.mine ? "true" : undefined}
          aria-pressed={r.mine}
          aria-label={`${r.mine ? "Remove your" : "Add"} ${r.key} reaction`}
          onClick={() => props.onToggle(r.key)}
          className={cn(
            "flex cursor-pointer items-center rounded-full border leading-none shadow-card backdrop-blur-md transition-colors",
            // One pill height either way (30px): a counted pill pads a 20px
            // emoji, a lone one is a circle of the same size around it.
            r.count > 1 ? "gap-1 px-2 py-1" : "size-[30px] justify-center",
            r.mine
              ? "border-primary/40 bg-reaction-chip-mine text-foreground"
              : "border-reaction-chip-border bg-reaction-chip text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {/* The emoji is the reaction; it reads above message-text size so the
              eye lands on it rather than on the count beside it. */}
          <Emoji emoji={reactionEmoji(r.key)} className="size-5" />
          {r.count > 1 && (
            <span data-testid="reaction-count" className="text-[11px] font-medium tabular-nums">
              {r.count}
            </span>
          )}
        </button>
      ))}
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
    <div className="flex min-w-[14rem] flex-col gap-2">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        data-testid="message-edit-input"
        aria-label="Edit message"
        className="w-full resize-none rounded-lg bg-card px-2.5 py-1.5 text-sm text-foreground shadow-chip outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          className="rounded-md px-2.5 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="edit-save"
          onClick={save}
          disabled={!value.trim()}
          className="rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground shadow-chip transition-all hover:brightness-110 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

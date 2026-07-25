import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Ban, Copy, Eye, EyeOff, MoreHorizontal, Pencil, Reply } from "lucide-react";
import {
  copyableMessageText,
  mentionsByItemId,
  parseRichMessage,
  urlHost,
  type ChatMessage,
  type GitLabLinkMetadata,
  type Reaction,
} from "~/lib/protocol";
import { reactionEmoji, REACTION_PICKER } from "~/lib/notifications";
import { hasActivePipeline } from "~/lib/gitlab-pipeline";
import {
  containsImage,
  dropLinks,
  extractLinks,
  hasNonImageContent,
  hasVisibleContent,
  parseRichHtml,
} from "~/lib/rich-text";
import { RichContent } from "~/components/rich-content";
import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { FileAttachment, MediaImage, RecordingAttachment } from "./media-image";
import { GitLabLinkCard } from "./gitlab-link-card";
import { PersonHoverCard } from "./person-card";
import { useAppState, useController } from "./controller-context";

/** Dwell before the hover reaction picker appears, the way Teams reveals its
 *  reaction bar — long enough that merely passing the cursor over a message
 *  doesn't flash it, short enough to feel responsive. */
const REACTION_HOVER_MS = 350;

/** Room reserved below a bubble that carries reactions. The chip row straddles
 *  the bubble's bottom edge — a third of a pill inside it, the rest hanging out
 *  (see {@link ReactionChips}) — and is positioned absolutely, so it takes no
 *  layout space of its own. This margin is that overhang (~17px of a 26px pill)
 *  plus enough air that the chips read as belonging to their own message rather
 *  than crowding whatever follows: the next message, or this message's "seen by"
 *  line. */
const REACTION_OVERHANG = "mb-6";

/** Resolved enrichment for a set of links, keyed by URL: `undefined` while a
 *  lookup is in flight, `null` when the link is not an enrichable integration,
 *  or the metadata once resolved. */
type LinkResults = Map<string, GitLabLinkMetadata | null | undefined>;

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
  const anyActive = urls.some((url) => hasActivePipeline(results.get(url)));
  const resultsRef = useRef(results);
  resultsRef.current = results;

  useEffect(() => {
    if (!anyActive) return;
    let alive = true;
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      for (const url of urls) {
        if (!hasActivePipeline(resultsRef.current.get(url))) continue;
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
 * Mirrors the TUI's MessageBubble (ui/src/app.tsx).
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
  onReply: (message: ChatMessage) => void;
  onCopy: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, key: string) => void;
  onStartEdit: (message: ChatMessage) => void;
  onSaveEdit: (message: ChatMessage, text: string) => void;
  onCancelEdit: () => void;
}) {
  const mine = props.message.is_self === true;
  const parsed = useMemo(() => parseRichMessage(props.message.content), [props.message.content]);
  // Who the body's @mention spans point at, so each mention of a person can offer
  // their card on hover (the span itself only carries an index — see
  // `mentionsByItemId`).
  const mentions = useMemo(() => mentionsByItemId(props.message), [props.message]);
  // Candidate GitLab links in the authored body (not the quoted reply) that
  // target the configured host. Filtering by host keeps enrichment to real
  // GitLab links; the backend is authoritative on whether one is enrichable.
  const gitlabHost = useAppState((s) => s.settings.gitlab_host);
  const candidateLinks = useMemo(() => {
    const host = gitlabHost.trim().toLowerCase();
    if (!host) return [];
    const html = `${parsed.beforeHtml ?? ""}\n${parsed.bodyHtml}`;
    return extractLinks(html).filter((u) => urlHost(u) === host);
  }, [parsed, gitlabHost]);

  const enrichment = useEnrichedLinks(candidateLinks);

  // The links that resolved to an integration → shown as cards and hidden from
  // the body, and the cards themselves (in document order).
  const cards = useMemo(() => {
    const out: { url: string; meta: GitLabLinkMetadata }[] = [];
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
    const parse = (html?: string) => (html ? dropLinks(parseRichHtml(html), hiddenHrefs) : []);
    return [parse(parsed.beforeHtml), parse(parsed.bodyHtml)];
  }, [parsed, hiddenHrefs]);
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

  // When the message is *only* an integration link (a card, no quote, no
  // attachments, no other body content), the bubble chrome is dropped and just
  // the card is shown.
  const linkOnly =
    !props.editing && !parsed.quote && !hasAttachments && cards.length > 0 && !bodyHasContent;

  // A media-only message: at least one image and nothing else — no text, no
  // quote, no link card, and any attachments are images too. Such messages swap
  // the bubble chrome for the "atelier" mat below (mine and incoming alike); an
  // incoming one still shows the sender's name above the mat.
  const hasImage = bodyHasImage || imageAttachments.length > 0;
  const imageOnly =
    !props.editing &&
    !parsed.quote &&
    cards.length === 0 &&
    hasImage &&
    !bodyHasText &&
    imageAttachments.length === attachments.length;

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

  // Media- and link-only messages render without the standard rounded, colored
  // bubble — an image gets the atelier mat, a recording its video card, a link
  // just its preview card. A deleted message keeps the standard bubble chrome.
  const bare = !isDeleted && (linkOnly || imageOnly || recordingOnly);

  // Only label the first message of a same-author run; continuations are clearly
  // from the same person. A message with no sender (e.g. a meeting recording,
  // whose only author hint is a bare contacts URL the backend drops) shows no
  // name — an empty label would just be a blank gap above the card.
  const nameShown =
    !mine && props.showSenderName && !props.continuesAbove && props.message.sender.trim() !== "";
  const [menuOpen, setMenuOpen] = useState(false);

  // Reactions on this message, and which emotion (if any) is ours — the latter
  // highlights our chip and lets a click on it toggle the reaction off.
  const reactions = props.message.reactions ?? [];
  const myReactionKey = reactions.find((r) => r.mine)?.key;
  // Chips only show on a live, non-edited message, so only then is there an
  // overhang to reserve room for.
  const chipsShown = reactions.length > 0 && !props.editing && !isDeleted;

  // Hover reaction picker: revealed after a short dwell, dismissed on leave. The
  // whole bubble row is the hover target; the picker floats just above it and,
  // being a descendant, keeps the hover alive when the cursor moves onto it.
  const [pickerOpen, setPickerOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const openPickerSoon = () => {
    // A deleted message has no reaction/actions affordances — the message is gone.
    if (props.editing || menuOpen || isDeleted) return;
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => setPickerOpen(true), REACTION_HOVER_MS);
  };
  const cancelPicker = () => {
    clearHoverTimer();
    setPickerOpen(false);
  };
  useEffect(() => clearHoverTimer, []);

  // Apply a reaction from either surface (hover picker, menu bar, or a chip),
  // then close both transient surfaces. The backend toggles server-side.
  const react = (key: string) => {
    cancelPicker();
    setMenuOpen(false);
    props.onReact(props.message, key);
  };

  // The message's rendered media/body — text/rich content, a quoted reply, and
  // attachments. Pulled out so an image-only message can wrap it in the
  // "atelier" mat (a framed card) while an ordinary message renders it plainly
  // inside the bubble.
  const mediaBody = (
    <>
      {parsed.beforeHtml ? (
        <RichContent html={parsed.beforeHtml} hiddenHrefs={hiddenHrefs} mentions={mentions} />
      ) : null}

      {parsed.quote ? (
        <div
          className={cn(
            "my-1 rounded-lg border-l-2 px-2.5 py-1.5",
            mine ? "border-sender-name-mine bg-quote-mine" : "border-sender-name bg-quote-incoming",
          )}
        >
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
      ) : null}

      {parsed.bodyHtml ? (
        <RichContent html={parsed.bodyHtml} hiddenHrefs={hiddenHrefs} mentions={mentions} />
      ) : null}

      {hasAttachments ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          {attachments.map((att, i) =>
            att.kind === "image" ? (
              <MediaImage key={`att-${i}-${att.url}`} src={att.url} alt={att.name} />
            ) : att.kind === "recording" ? (
              <RecordingAttachment key={`att-${i}-${att.url}`} attachment={att} />
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
      onMouseEnter={openPickerSoon}
      onMouseLeave={cancelPicker}
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
      <div
        data-testid="message"
        data-mine={mine ? "true" : "false"}
        data-message-id={props.message.id}
        data-highlighted={props.highlighted ? "true" : undefined}
        data-link-only={linkOnly ? "true" : undefined}
        data-image-only={imageOnly ? "true" : undefined}
        data-recording-only={recordingOnly ? "true" : undefined}
        data-deleted={isDeleted ? "true" : undefined}
        className={cn(
          "relative text-sm leading-relaxed",
          // Media- and link-only messages drop the standard bubble chrome; the
          // link card / atelier mat / recording card (below) becomes the surface.
          // A link card gets a tighter max width; the mat is capped at the usual
          // bubble one; a recording card sizes itself (max-w-sm).
          linkOnly && "max-w-md",
          imageOnly && "max-w-[76%]",
          recordingOnly && "w-full max-w-sm",
          !bare &&
            cn(
              "max-w-[76%] rounded-2xl px-3.5 py-2",
              // A deleted message drops the accent fill for a muted, dashed
              // "ghost" bubble (the same on both sides) so it reads as absent
              // rather than as a real message — until it is revealed.
              isDeleted
                ? "border border-dashed border-border bg-transparent text-text-dim shadow-none"
                : mine
                ? "bg-bubble-mine text-bubble-mine-foreground shadow-chip"
                : "bg-bubble-incoming text-bubble-incoming-foreground shadow-card",
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
          if (isDeleted) return; // no actions menu on a deleted message
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {!props.editing && !isDeleted && pickerOpen && (
          <div
            className={cn(
              // Float just above the bubble on the author's anchor side. The
              // `pb-1` is a transparent hover bridge so the cursor never crosses
              // an empty gap between bubble and picker (which would dismiss it).
              "absolute bottom-full z-20 pb-1 animate-in fade-in zoom-in-95 duration-150",
              mine ? "right-0" : "left-0",
            )}
          >
            <ReactionPicker
              data-testid="reaction-picker"
              activeKey={myReactionKey}
              onPick={react}
              floating
              className="rounded-full border border-border/50 bg-popover/70 p-1 shadow-pop backdrop-blur-md"
            />
          </div>
        )}

        {nameShown && (
          <div className="mb-0.5 flex text-xs font-semibold text-sender-name">
            <PersonHoverCard mri={props.message.sender_mri} name={props.message.sender}>
              <span data-testid="sender-name">{props.message.sender}</span>
            </PersonHoverCard>
          </div>
        )}

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
            {linkOnly ? null : imageOnly ? (
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
                {cards.map(({ url, meta }) => (
                  <GitLabLinkCard key={url} metadata={meta} />
                ))}
              </div>
            ) : null}

            {chipsShown ? (
              <ReactionChips reactions={reactions} mine={mine} onToggle={react} />
            ) : null}

            <DropdownMenu
              open={menuOpen}
              onOpenChange={(open) => {
                setMenuOpen(open);
                // The menu and the hover picker are alternative reaction
                // surfaces; never show both at once.
                if (open) cancelPicker();
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Message actions"
                  data-testid="message-actions"
                  className={cn(
                    // Hidden until hover on a mouse, but always visible on touch
                    // (coarse pointer) where there is no hover — otherwise the
                    // reply/react/copy/edit menu would be unreachable on mobile.
                    "absolute top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-text-dim opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-accent data-[state=open]:text-foreground data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100",
                    mine ? "-left-9" : "-right-9",
                  )}
                >
                  <MoreHorizontal className="size-4" strokeWidth={1.6} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={mine ? "start" : "end"}>
                {/* Reaction bar — the same emojis as the hover picker, so
                    reacting is also reachable from the ⋯ menu (and by keyboard). */}
                <ReactionPicker
                  data-testid="menu-reaction-picker"
                  activeKey={myReactionKey}
                  onPick={react}
                  className="justify-between px-1 pb-1"
                />
                <DropdownMenuSeparator />
                {mine && (
                  <DropdownMenuItem
                    data-testid="action-edit"
                    onSelect={() => props.onStartEdit(props.message)}
                  >
                    <Pencil className="size-4" strokeWidth={1.6} />
                    Edit
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  data-testid="action-reply"
                  onSelect={() => props.onReply(props.message)}
                >
                  <Reply className="size-4" strokeWidth={1.6} />
                  Reply
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="action-copy"
                  onSelect={() => props.onCopy(props.message)}
                >
                  <Copy className="size-4" strokeWidth={1.6} />
                  Copy
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
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
              <EyeOff className="size-3" strokeWidth={1.6} />
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
            <Ban className="size-3.5 shrink-0" strokeWidth={1.6} aria-hidden />
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
                <Eye className="size-3" strokeWidth={1.6} />
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
 * A row of emoji buttons for adding a reaction, in Teams' canonical order. Used
 * both as the floating hover picker and as the reaction bar at the top of the ⋯
 * menu. The caller supplies chrome via `className` (a translucent, frosted
 * rounded bar for the hover picker; flat inside the menu). `activeKey` marks our
 * current reaction with a distinct highlight; clicking it removes the reaction,
 * which the highlight and the label ("Remove … reaction") already say — no extra
 * badge needed on top of the emoji.
 *
 * `floating` (the hover picker) adds the pop-scale on hover, which would be
 * clipped inside the menu's `overflow-hidden` surface.
 */
function ReactionPicker(props: {
  onPick: (key: string) => void;
  activeKey?: string;
  floating?: boolean;
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
              "grid size-7 place-items-center rounded-full text-base leading-none transition-transform",
              props.floating && "hover:scale-125",
              active ? "bg-primary/20 ring-1 ring-inset ring-primary/50" : "hover:bg-accent",
            )}
          >
            <span aria-hidden>{emoji}</span>
          </button>
        );
      })}
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
 * straddling is also why the pills carry an opaque fill and a drop shadow: they
 * sit *on top of* the bubble's edge rather than beside it.
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
            "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 leading-none shadow-card transition-colors",
            r.mine
              ? "border-primary/40 bg-reaction-chip-mine text-foreground"
              : "border-reaction-chip-border bg-reaction-chip text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {/* Emoji at message-text size (not label size) — the reaction, not its
              count, is what the eye should land on. */}
          <span aria-hidden className="text-base leading-none">
            {reactionEmoji(r.key)}
          </span>
          <span className="text-[11px] font-medium tabular-nums">{r.count}</span>
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

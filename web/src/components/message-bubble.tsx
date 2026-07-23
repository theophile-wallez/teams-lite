import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, MoreHorizontal, Pencil, Reply } from "lucide-react";
import {
  copyableMessageText,
  parseRichMessage,
  urlHost,
  type ChatMessage,
  type GitLabLinkMetadata,
  type Reaction,
} from "~/lib/protocol";
import { reactionEmoji, REACTION_PICKER } from "~/lib/notifications";
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
import { FileAttachment, MediaImage } from "./media-image";
import { GitLabLinkCard } from "./gitlab-link-card";
import { useAppState, useController } from "./controller-context";

/** Dwell before the hover reaction picker appears, the way Teams reveals its
 *  reaction bar — long enough that merely passing the cursor over a message
 *  doesn't flash it, short enough to feel responsive. */
const REACTION_HOVER_MS = 350;

/** Resolved enrichment for a set of links, keyed by URL: `undefined` while a
 *  lookup is in flight, `null` when the link is not an enrichable integration,
 *  or the metadata once resolved. */
type LinkResults = Map<string, GitLabLinkMetadata | null | undefined>;

/**
 * Enrich a stable list of URLs through the controller (which goes to the backend
 * and caches per URL). Returns a reactive map of results so the caller can hide
 * enriched links from the body and render their cards. The owning component, not
 * the card, drives this so it can decide the message's layout from the outcome.
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
 * with no text) drops the bubble chrome so the picture stands alone. On an
 * incoming image-only message the sender name still shows, floating in the void
 * above the picture rather than inside a bubble.
 */
export function MessageBubble(props: {
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

  // When the message is *only* an integration link (a card, no quote, no
  // attachments, no other body content), the bubble chrome is dropped and just
  // the card is shown.
  const linkOnly =
    !props.editing && !parsed.quote && !hasAttachments && cards.length > 0 && !bodyHasContent;

  // A media-only message: at least one image and nothing else — no text, no
  // quote, no link card, and any attachments are images too. Such messages drop
  // the bubble chrome so the picture stands alone (mine and incoming alike); an
  // incoming one still shows the sender's name in the void above the image.
  const hasImage = bodyHasImage || imageAttachments.length > 0;
  const imageOnly =
    !props.editing &&
    !parsed.quote &&
    cards.length === 0 &&
    hasImage &&
    !bodyHasText &&
    imageAttachments.length === attachments.length;

  // Media- and link-only messages render without the rounded, colored bubble.
  const bare = linkOnly || imageOnly;

  // Only label the first message of a same-author run; continuations are clearly
  // from the same person.
  const nameShown = !mine && props.showSenderName && !props.continuesAbove;
  const [menuOpen, setMenuOpen] = useState(false);

  // Reactions on this message, and which emotion (if any) is ours — the latter
  // highlights our chip and lets a click on it toggle the reaction off.
  const reactions = props.message.reactions ?? [];
  const myReactionKey = reactions.find((r) => r.mine)?.key;

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
    if (props.editing || menuOpen) return;
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
      )}
    >
      <div
        data-testid="message"
        data-mine={mine ? "true" : "false"}
        data-message-id={props.message.id}
        data-highlighted={props.highlighted ? "true" : undefined}
        data-link-only={linkOnly ? "true" : undefined}
        data-image-only={imageOnly ? "true" : undefined}
        className={cn(
          "relative text-sm leading-relaxed",
          // Media- and link-only messages drop the bubble chrome so the picture
          // or card is the surface; a link card gets a tighter max width.
          linkOnly && "max-w-md",
          imageOnly && "max-w-[76%]",
          !bare &&
            cn(
              "max-w-[76%] rounded-2xl px-3.5 py-2",
              mine
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
          e.preventDefault();
          setMenuOpen(true);
        }}
      >
        {!props.editing && pickerOpen && (
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
              className="rounded-full border border-border bg-popover p-1 shadow-pop"
            />
          </div>
        )}

        {nameShown && (
          <div
            data-testid="sender-name"
            className="mb-0.5 text-xs font-semibold text-sender-name"
          >
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
            {linkOnly ? null : (
              <>
                {parsed.beforeHtml ? (
                  <RichContent html={parsed.beforeHtml} hiddenHrefs={hiddenHrefs} />
                ) : null}

                {parsed.quote ? (
                  <div
                    className={cn(
                      "my-1 rounded-lg border-l-2 px-2.5 py-1.5",
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
                    <RichContent
                      html={parsed.quote.html}
                      className={cn(
                        "text-xs",
                        mine ? "text-quote-text-mine" : "text-quote-text-incoming",
                      )}
                    />
                  </div>
                ) : null}

                {parsed.bodyHtml ? (
                  <RichContent html={parsed.bodyHtml} hiddenHrefs={hiddenHrefs} />
                ) : null}

                {hasAttachments ? (
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    {attachments.map((att, i) =>
                      att.kind === "image" ? (
                        <MediaImage key={`att-${i}-${att.url}`} src={att.url} alt={att.name} />
                      ) : (
                        <FileAttachment key={`att-${i}-${att.url}`} attachment={att} />
                      ),
                    )}
                  </div>
                ) : null}
              </>
            )}

            {cards.length > 0 ? (
              <div className={cn("flex flex-col gap-1.5", !linkOnly && "mt-1.5")}>
                {cards.map(({ url, meta }) => (
                  <GitLabLinkCard key={url} metadata={meta} />
                ))}
              </div>
            ) : null}

            {reactions.length > 0 ? (
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
                    "absolute top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-text-dim opacity-0 transition hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:bg-accent data-[state=open]:text-foreground data-[state=open]:opacity-100",
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
 * A row of emoji buttons for adding a reaction, in Teams' canonical order. Used
 * both as the floating hover picker and as the reaction bar at the top of the ⋯
 * menu. The caller supplies chrome via `className` (a rounded popover for the
 * hover picker; flat inside the menu). `activeKey` highlights our current
 * reaction so re-picking it reads as "remove".
 */
function ReactionPicker(props: {
  onPick: (key: string) => void;
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
      {REACTION_PICKER.map(({ key, emoji }) => (
        <button
          key={key}
          type="button"
          aria-label={`React with ${key}`}
          aria-pressed={props.activeKey === key}
          data-testid={`reaction-option-${key}`}
          onClick={() => props.onPick(key)}
          className={cn(
            "grid size-7 place-items-center rounded-full text-base leading-none transition-transform hover:scale-125 hover:bg-accent",
            props.activeKey === key && "bg-accent",
          )}
        >
          <span aria-hidden>{emoji}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The reaction chips shown under a message: one per emotion with a count, our
 * own reaction highlighted. Clicking a chip toggles that reaction (removing ours
 * when it is already ours, otherwise adding/replacing it). Aligned to the
 * author's side so it reads as belonging to the bubble.
 */
function ReactionChips(props: {
  reactions: Reaction[];
  mine: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      data-testid="message-reactions"
      className={cn("mt-1 flex flex-wrap gap-1", props.mine ? "justify-end" : "justify-start")}
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
            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition-colors",
            r.mine
              ? "border-primary/50 bg-primary/15 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <span aria-hidden>{reactionEmoji(r.key)}</span>
          <span className="tabular-nums">{r.count}</span>
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

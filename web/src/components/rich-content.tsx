import { Fragment, useMemo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { GlobeIcon, Unlink02Icon } from "@hugeicons/core-free-icons";
import {
  dropLinks,
  hasVisibleContent,
  mergeAdjacentMentions,
  nodeText,
  parseMessageBody,
  parseRelayedEmail,
  type RichElement,
  type RichNode,
  type RichTag,
} from "~/lib/rich-text";
import { bodyIsOnlyEmoji } from "~/lib/custom-emoji";
import { markAgentTag } from "~/lib/agent-tag";
import { uploadOf } from "~/lib/gitlab-upload";
import type { AgentCandidate } from "~/lib/mentions";
import type { BodyFormat, MessageMention } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { AgentTagChip } from "./agent-tag";
import { CustomEmoji } from "./custom-emoji";
import { EmailSummaryCard } from "./email-summary";
import { GitLabImage } from "./gitlab-image";
import { MediaImage } from "./media-image";
import { PersonHoverCard } from "./person-card";
import { renderWordEffects } from "./word-effect";

/**
 * Renders a Teams HTML fragment as safe React elements. The HTML is parsed into
 * an allowlisted node tree by {@link parseRichHtml} (no `dangerouslySetInnerHTML`),
 * then mapped to styled elements here. Supports bold, italic, underline,
 * strikethrough, small print, inline code, code blocks, links, ordered/unordered
 * lists, headings, tables, separators, @mentions, line breaks, inline images and
 * emoji.
 *
 * An HTML email relayed into a channel is not rendered as a message body at all:
 * it is summarized to its subject, headings and action link (see
 * {@link EmailSummaryCard}).
 *
 * `hiddenHrefs` drops anchors with those hrefs from the output — used when a link
 * is surfaced as a rich preview card instead, so it is never shown twice.
 *
 * `mentions` maps each mention span's `itemid` to what it names (see
 * `mentionsByItemId`): given one, a mention of a person becomes hoverable and
 * reveals their card, and the spans Teams split a name across are drawn as one chip
 * (see {@link mergeMentionRuns}). Without it — or for a mention of a
 * channel/team/tag — the mention still renders, just as inert accent text.
 *
 * `cardShownSeparately` says the message carries a decoded card attachment, so the
 * body's empty app-card placeholder ("Link preview unavailable") is dropped — the
 * real card is right there below the body. Set it when the payload arrived; leave it
 * off for a legacy row whose card was never stored, where the placeholder is the only
 * trace that a card was posted.
 *
 * `format` says how the body must be READ (see `bodyFormat`). It defaults to
 * `"html"`; pass `"text"` for a Teams `messagetype: Text` body, which is plain text
 * and is then shown verbatim — escaped by React, with bare URLs still linked — so
 * `Vec<String>` survives instead of being parsed away as a tag.
 *
 * `agentTags` names the agents whose prefix, when the body OPENS with it, is drawn as
 * that vendor's chip instead of as the plain `@claude` on the wire (see `markAgentTag`).
 * Pass it only where the tag would really have summoned one; empty or absent leaves the
 * prefix the words it is.
 */
export function RichContent(props: {
  html: string;
  className?: string;
  hiddenHrefs?: Set<string>;
  mentions?: Map<number, MessageMention>;
  format?: BodyFormat;
  cardShownSeparately?: boolean;
  agentTags?: readonly AgentCandidate[];
  /** Render each word in its own span, so a body that is still being written animates
   *  its new words in. Only the streamed agent reply passes this — see
   *  {@link renderTokens}. */
  tokens?: boolean;
}) {
  const { html, hiddenHrefs, agentTags } = props;
  const format = props.format ?? "html";
  // A plain-text body is text, not markup: it is never an email either, and its
  // angle brackets are the author's own (see `parseMessageBody`).
  const email = useMemo(() => (format === "text" ? null : parseRelayedEmail(html)), [html, format]);
  const nodes = useMemo(() => {
    const parsed = parseMessageBody(html, format);
    const pruned = hiddenHrefs && hiddenHrefs.size > 0 ? dropLinks(parsed, hiddenHrefs) : parsed;
    // Last, on the tree as it will be read: the prefix has to open what the reader sees.
    return agentTags ? markAgentTag(pruned, agentTags) : pruned;
  }, [html, format, hiddenHrefs, agentTags]);
  if (email) return <EmailSummaryCard email={email} className={props.className} />;
  return (
    <RichNodes
      nodes={nodes}
      className={cn("whitespace-pre-wrap", props.className)}
      mentions={props.mentions}
      cardShownSeparately={props.cardShownSeparately}
      tokens={props.tokens}
    />
  );
}

/**
 * Render an already-parsed node tree — the half of {@link RichContent} that turns
 * nodes into elements, without the assumption that they came from Teams HTML.
 *
 * A card's text is markdown, not HTML, and it is parsed by `parseCardMarkdown`
 * (lib/card-markdown.ts); going through this renderer is what makes a card's bold,
 * links and lists look exactly like a message body's instead of a second, drifting
 * implementation of the same styles.
 *
 * Renders nothing at all when the tree holds nothing visible, so a caller never has
 * to guard against an empty block.
 */
export function RichNodes(props: {
  nodes: RichNode[];
  className?: string;
  mentions?: Map<number, MessageMention>;
  cardShownSeparately?: boolean;
  /** See {@link RichContent}'s `tokens`. */
  tokens?: boolean;
}) {
  const nodes = useMemo(
    () => mergeMentionRuns(props.nodes, props.mentions),
    [props.nodes, props.mentions],
  );
  const jumbo = useMemo(() => bodyIsOnlyEmoji(nodes), [nodes]);
  if (!hasVisibleContent(nodes)) return null;
  return (
    <div className={cn("break-words", props.className)}>
      {nodes.map((node, i) =>
        renderNode(node, i, {
          mentions: props.mentions,
          cardShownSeparately: props.cardShownSeparately,
          tokens: props.tokens,
          jumbo,
        }),
      )}
    </div>
  );
}

/**
 * What a mention span names: the message's own mention list, keyed by the `itemid`
 * the span carries — or, in the composer's own markup, the MRI the span itself holds
 * (a message being written has no list beside it yet).
 */
function mentionTarget(
  node: RichElement,
  mentions?: Map<number, MessageMention>,
): MessageMention | undefined {
  const itemid = Number(node.attrs.itemid);
  const listed = Number.isInteger(itemid) ? mentions?.get(itemid) : undefined;
  if (listed) return listed;
  return node.attrs.mri
    ? { itemid, mri: node.attrs.mri, kind: "person", display_name: nodeText(node.children) }
    : undefined;
}

/**
 * Draw the words of one name as one chip: Teams splits a mention across the WORDS of
 * the name it shows ("Clément BOSLE" is two spans, two `itemid`s, one MRI), and its
 * own client only tints them, so the split shows here and nowhere else. The identity
 * is the MRI, so it is the message's own mention list that proves two spans name one
 * person — see {@link mergeAdjacentMentions} for what happens when nothing does.
 */
function mergeMentionRuns(
  nodes: RichNode[],
  mentions?: Map<number, MessageMention>,
): RichNode[] {
  return mergeAdjacentMentions(nodes, (node) => mentionTarget(node, mentions)?.mri);
}

/**
 * A text run as one span per word, so a body that is still growing animates the words
 * that are new and leaves the rest alone.
 *
 * The spans are keyed by position, which is the whole trick: while an answer streams,
 * every word but the last few is at the same position it was in the previous frame, so
 * React keeps those spans mounted and only the new ones mount — and a mount is what
 * runs the `agent-token` animation (app.css). No timers, no per-word state, and the
 * cost of a frame is the words the frame added.
 *
 * Whitespace is emitted verbatim between the spans rather than being folded into them:
 * the body renders under `whitespace-pre-wrap`, so a swallowed newline would reflow the
 * paragraph.
 */
function renderTokens(text: string, key: number): ReactNode {
  const pieces = text.split(/(\s+)/);
  return (
    <Fragment key={key}>
      {pieces.map((piece, i) =>
        piece === "" || /^\s+$/.test(piece) ? (
          piece
        ) : (
          <span key={i} className="agent-token">
            {piece}
          </span>
        ),
      )}
    </Fragment>
  );
}

// Block-level tags get vertical spacing between siblings (but not before the
// first child), so paragraphs and lists don't collapse together.
const BLOCK_SPACING = "[&:not(:first-child)]:mt-1";

// A heading opens a section, so it gets a touch more air above it than an
// ordinary block — but stays inside a chat bubble, so not a whole line's worth.
const HEADING_SPACING = "[&:not(:first-child)]:mt-2";

// Tags that may not appear inside a `<p>` (see the `p` case below).
const BLOCK_ONLY_TAGS = new Set<RichTag>([
  "p",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "hr",
  "table",
  "card",
]);


/**
 * A small rounded-square site icon shown inline just before a link's text, as
 * part of the anchor itself. The favicon is loaded straight from DuckDuckGo's
 * public favicon service keyed by the link's host — external links are public,
 * so this needs no media proxy (unlike {@link MediaImage}), and DuckDuckGo is
 * privacy-respecting (no per-request tracking). Rendered only for absolute
 * http(s) links; relative/fragment/mailto/tel anchors get no icon.
 *
 * Modeled on shadcn/Radix `Avatar`: a fallback — a small globe glyph on the same
 * rounded chip — shows immediately and holds the space while the favicon loads,
 * so the link never jumps. The favicon fades in once it decodes; if it never
 * arrives (offline, blocked, or the site has none) the globe simply stays. The
 * chip is a fixed `em`-sized box either way, so there is no layout shift and the
 * icon tracks the surrounding text size.
 */
function LinkFavicon({ href }: { href?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const host = useMemo(() => {
    if (!href) return null;
    try {
      const url = new URL(href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
    } catch {
      return null;
    }
  }, [href]);
  if (!host) return null;
  const showFavicon = loaded && !failed;
  return (
    <span className="relative mr-1 inline-flex size-[1.05em] shrink-0 items-center justify-center overflow-hidden rounded-[0.25em] align-middle text-zinc-500 ring-1 ring-black/5">
      {/* Fallback globe — visible until (and unless) the favicon paints. */}
      <HugeiconsIcon
        icon={GlobeIcon}
        className={cn("size-[0.72em] transition-opacity", showFavicon && "opacity-0")}
        strokeWidth={2}
        aria-hidden
      />
      {!failed && (
        // Fills the chip edge-to-edge — the favicon is the tile, no padding.
        <img
          src={`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity",
            showFavicon ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </span>
  );
}

/**
 * What the surrounding nodes imply for how this one renders.
 *
 * @property mentions Who the body's @mention spans point at (see `RichContent`).
 * @property verbatim Inside a `code`/`pre` subtree, where text is shown exactly
 * as written — no easter-egg decoration (see {@link renderWordEffects}).
 * @property inPre Inside a `pre`, which already paints the code-block surface, so
 * a nested `code` must not paint a second one on top of it.
 * @property cardShownSeparately The message carries a decoded card attachment, so
 * the body's empty app-card placeholder is dropped (see `RichContent`).
 * @property tokens Wrap each word in its own span, for a body still being written
 * (see {@link renderTokens}).
 */
type RenderContext = {
  mentions?: Map<number, MessageMention>;
  verbatim?: boolean;
  inPre?: boolean;
  cardShownSeparately?: boolean;
  tokens?: boolean;
  jumbo?: boolean;
};

function renderNode(node: RichNode, key: number, ctx: RenderContext): ReactNode {
  if (node.type === "text") {
    if (ctx.verbatim) return node.text;
    // A body being written animates its new words; a finished one gets the easter-egg
    // decoration. Never both: a word that arrives one frame at a time has nothing to
    // gain from a six-colour ramp, and the two would fight over the same span.
    return ctx.tokens ? renderTokens(node.text, key) : renderWordEffects(node.text, key);
  }

  const childCtx: RenderContext = {
    mentions: ctx.mentions,
    verbatim: ctx.verbatim || node.tag === "code" || node.tag === "pre",
    inPre: ctx.inPre || node.tag === "pre",
    cardShownSeparately: ctx.cardShownSeparately,
    tokens: ctx.tokens,
    // An emoji-only body is decided once, on the whole tree, so it has to travel DOWN
    // it: a one-emoji message serializes as `<p><img …></p>`, so the emoji is never a
    // top-level node and a `jumbo` left behind here reached nothing.
    jumbo: ctx.jumbo,
  };
  const children = node.children.map((child, i) => renderNode(child, i, childCtx));

  switch (node.tag) {
    case "br":
      return <br key={key} />;
    case "hr":
      // A separator inside a bubble: a hairline in the bubble's own text color,
      // with the air a paragraph break would have had.
      return <hr key={key} className="my-2 border-0 border-t border-current/20" />;
    case "strong":
      return (
        <strong key={key} className="font-semibold">
          {children}
        </strong>
      );
    case "em":
      return (
        <em key={key} className="italic">
          {children}
        </em>
      );
    case "u":
      return (
        <u key={key} className="underline underline-offset-2">
          {children}
        </u>
      );
    case "s":
      return (
        <s key={key} className="line-through">
          {children}
        </s>
      );
    case "small":
      return (
        <small key={key} className="text-[0.85em] opacity-80">
          {children}
        </small>
      );
    case "code":
      // Teams wraps a code block as `<pre><code>`. Only one of the two paints the
      // surface — otherwise the inner background sits as a darker slab on the
      // outer one, with the padding doubled around it.
      return ctx.inPre ? (
        <code key={key} className="font-mono">
          {children}
        </code>
      ) : (
        <code
          key={key}
          className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/15"
        >
          {children}
        </code>
      );
    case "pre":
      return (
        <pre
          key={key}
          className={cn(
            BLOCK_SPACING,
            "overflow-x-auto rounded-md bg-black/10 p-2 font-mono text-xs dark:bg-white/15",
          )}
        >
          {children}
        </pre>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className={cn(BLOCK_SPACING, "border-l-2 border-current/30 pl-2 opacity-90")}
        >
          {children}
        </blockquote>
      );
    case "ul":
      return (
        <ul key={key} className={cn(BLOCK_SPACING, "list-disc pl-5")}>
          {children}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className={cn(BLOCK_SPACING, "list-decimal pl-5")}>
          {children}
        </ol>
      );
    case "li":
      return <li key={key}>{children}</li>;
    case "p": {
      // Message HTML nests freely, and `<div>` maps to a paragraph — so a
      // "paragraph" may well contain a list, a table or another paragraph. None
      // of those may live inside a `<p>`: the browser would close the paragraph
      // early and re-parent them, which breaks SSR hydration. Such a block
      // renders as a `<div>`; a genuine text paragraph stays a `<p>`.
      const wrapsBlock = node.children.some(
        (child) => child.type === "element" && BLOCK_ONLY_TAGS.has(child.tag),
      );
      const Block = wrapsBlock ? "div" : "p";
      return (
        <Block key={key} className={BLOCK_SPACING}>
          {children}
        </Block>
      );
    }
    // Headings sit inside a chat bubble, so they gain weight and only a little
    // size — enough to read as a hierarchy, nowhere near page-heading scale. The
    // sizes are relative (`em`) so a heading quoted in a reply shrinks with it.
    case "h1":
      return (
        <h1 key={key} className={cn(HEADING_SPACING, "text-[1.15em] font-semibold")}>
          {children}
        </h1>
      );
    case "h2":
      return (
        <h2 key={key} className={cn(HEADING_SPACING, "text-[1.08em] font-semibold")}>
          {children}
        </h2>
      );
    case "h3":
      return (
        <h3 key={key} className={cn(HEADING_SPACING, "font-semibold")}>
          {children}
        </h3>
      );
    case "table":
      // A table can be wider than the bubble, so it scrolls horizontally inside
      // it rather than stretching it. `whitespace-normal` opts the cells out of
      // the body's `pre-wrap`, where the source HTML's newlines between cells
      // would otherwise open blank lines inside them.
      return (
        <div key={key} className={cn(BLOCK_SPACING, "max-w-full overflow-x-auto")}>
          <table className="w-max max-w-full border-collapse whitespace-normal text-[0.95em]">
            {children}
          </table>
        </div>
      );
    case "thead":
      return <thead key={key}>{children}</thead>;
    case "tbody":
      return <tbody key={key}>{children}</tbody>;
    case "tr":
      return (
        <tr key={key} className="border-b border-current/10 last:border-b-0">
          {children}
        </tr>
      );
    case "th":
      return (
        <th
          key={key}
          colSpan={node.attrs.colspan}
          rowSpan={node.attrs.rowspan}
          className="px-2 py-1 text-left align-top font-semibold"
        >
          {children}
        </th>
      );
    case "td":
      return (
        <td
          key={key}
          colSpan={node.attrs.colspan}
          rowSpan={node.attrs.rowspan}
          className="px-2 py-1 align-top"
        >
          {children}
        </td>
      );
    case "card":
      // An app link-unfurl card. Teams sends its payload out of band (the HTML holds
      // only the card's id), so when nothing came through we say so rather than
      // render an invisible element and lose the fact that a card existed — UNLESS
      // the payload did arrive and is being rendered as a card attachment below the
      // body, in which case this placeholder would contradict the card next to it.
      if (!hasVisibleContent(node.children) && ctx.cardShownSeparately) return null;
      return hasVisibleContent(node.children) ? (
        <div
          key={key}
          data-testid="app-card"
          className={cn(
            BLOCK_SPACING,
            "rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5",
          )}
        >
          {children}
        </div>
      ) : (
        <div
          key={key}
          data-testid="app-card-unavailable"
          className={cn(BLOCK_SPACING, "flex items-center gap-1.5 text-xs text-text-dim")}
        >
          <HugeiconsIcon
            icon={Unlink02Icon}
            className="size-3.5 shrink-0"
            strokeWidth={1.6}
            aria-hidden
          />
          Link preview unavailable
        </div>
      );
    case "a":
      return (
        <a
          key={key}
          href={node.attrs.href}
          target="_blank"
          rel="noopener noreferrer"
          // `break-all` makes a long, spaceless URL start filling the line
          // right after the favicon rather than jumping to the next line whole
          // (which strands the favicon alone above the text). `overflow-wrap`
          // alone won't do this — it only breaks a word as a last resort, after
          // first bumping it to a fresh line.
          className="underline underline-offset-2 break-all hover:opacity-80"
        >
          <LinkFavicon href={node.attrs.href} />
          {children}
        </a>
      );
    case "img":
      return (
        <MediaImage
          key={key}
          src={node.attrs.src ?? ""}
          alt={node.attrs.alt ?? ""}
          className="my-1"
        />
      );
    case "gitlabImage": {
      // A GitLab upload: the picture is real, and its bytes come through the backend because
      // no browser can ask GitLab for them (see `~/lib/gitlab-upload.ts`). An attribute this
      // app cannot turn into an upload draws nothing rather than an empty box.
      const upload = uploadOf(node.attrs);
      if (!upload) return null;
      return (
        <GitLabImage
          key={key}
          upload={upload}
          alt={node.attrs.alt ?? ""}
          width={node.attrs.width}
          height={node.attrs.height}
          className="my-1"
        />
      );
    }
    case "mention": {
      // The span carries only an index; who it names lives in the message's
      // mention list. A person we can identify gets their card on hover; a
      // channel/team/tag mention (or an unmapped one) still reads as a mention.
      //
      // The chip's colours come from CSS rather than from a prop, because whether it
      // sits in our own bubble is the BUBBLE's business: `[data-mine]` on the message
      // switches it (see styles/app.css), so the renderer needs no flag threaded
      // through every node.
      const mention = mentionTarget(node, ctx.mentions);
      const text = <span className="mention-chip">{children}</span>;
      if (mention?.kind !== "person") return <span key={key}>{text}</span>;
      // The card's name is the chip's own text, because the mention list names each
      // WORD of a name separately: no single entry of it holds the whole name (see
      // {@link mergeMentionRuns}).
      return (
        <PersonHoverCard key={key} mri={mention.mri} name={nodeText([node]).trim()}>
          {text}
        </PersonHoverCard>
      );
    }
    case "agent":
      // The very chip the composer drew (components/agent-tag.tsx), so tagging an agent
      // and reading the message back are one thing rather than two that look alike. The
      // node's own text — the `@claude` on the wire — is what the chip replaces: the mark
      // and the name say it in the vendor's own voice, which is what was on screen when
      // the message was written.
      return <AgentTagChip key={key} backend={node.attrs.backend ?? ""} />;
    case "customEmoji":
      return (
        <CustomEmoji
          key={key}
          src={node.attrs.src ?? ""}
          label={node.attrs.code ?? ""}
          jumbo={ctx.jumbo}
        />
      );
    default:
      return <span key={key}>{children}</span>;
  }
}

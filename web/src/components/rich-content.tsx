import { useMemo, useState, type ReactNode } from "react";
import { Globe } from "lucide-react";
import { dropLinks, hasVisibleContent, parseRichHtml, type RichNode } from "~/lib/rich-text";
import type { MessageMention } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { MediaImage } from "./media-image";
import { PersonHoverCard } from "./person-card";
import { renderSparkleWords } from "./sparkle-word";

/**
 * Renders a Teams HTML fragment as safe React elements. The HTML is parsed into
 * an allowlisted node tree by {@link parseRichHtml} (no `dangerouslySetInnerHTML`),
 * then mapped to styled elements here. Supports bold, italic, underline,
 * strikethrough, inline code, code blocks, links, ordered/unordered lists,
 * @mentions, line breaks, and inline images.
 *
 * `hiddenHrefs` drops anchors with those hrefs from the output — used when a link
 * is surfaced as a rich preview card instead, so it is never shown twice.
 *
 * `mentions` maps each mention span's `itemid` to the person it names (see
 * `mentionsByItemId`): given one, a mention of a person becomes hoverable and
 * reveals their card. Without it — or for a mention of a channel/team/tag — the
 * mention still renders, just as inert accent text.
 */
export function RichContent(props: {
  html: string;
  className?: string;
  hiddenHrefs?: Set<string>;
  mentions?: Map<number, MessageMention>;
}) {
  const { html, hiddenHrefs } = props;
  const nodes = useMemo(() => {
    const parsed = parseRichHtml(html);
    return hiddenHrefs && hiddenHrefs.size > 0 ? dropLinks(parsed, hiddenHrefs) : parsed;
  }, [html, hiddenHrefs]);
  if (!hasVisibleContent(nodes)) return null;
  return (
    <div className={cn("whitespace-pre-wrap break-words", props.className)}>
      {nodes.map((node, i) => renderNode(node, i, props.mentions))}
    </div>
  );
}

// Block-level tags get vertical spacing between siblings (but not before the
// first child), so paragraphs and lists don't collapse together.
const BLOCK_SPACING = "[&:not(:first-child)]:mt-1";

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
      <Globe
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
 * @param verbatim Inside a `code`/`pre` subtree, where text is shown exactly as
 * written — no easter-egg decoration (see {@link renderSparkleWords}).
 */
function renderNode(
  node: RichNode,
  key: number,
  mentions?: Map<number, MessageMention>,
  verbatim = false,
): ReactNode {
  if (node.type === "text") return verbatim ? node.text : renderSparkleWords(node.text, key);

  const isVerbatim = verbatim || node.tag === "code" || node.tag === "pre";
  const children = node.children.map((child, i) => renderNode(child, i, mentions, isVerbatim));

  switch (node.tag) {
    case "br":
      return <br key={key} />;
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
    case "code":
      return (
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
    case "p":
      return (
        <p key={key} className={BLOCK_SPACING}>
          {children}
        </p>
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
    case "mention": {
      // The span carries only an index; who it names lives in the message's
      // mention list. A person we can identify gets their card on hover; a
      // channel/team/tag mention (or an unmapped one) stays plain accent text.
      const itemid = Number(node.attrs.itemid);
      const mention = Number.isInteger(itemid) ? mentions?.get(itemid) : undefined;
      const text = <span className="font-semibold text-sender-name">{children}</span>;
      if (!mention) return <span key={key}>{text}</span>;
      return (
        <PersonHoverCard key={key} mri={mention.mri} name={mention.display_name}>
          {text}
        </PersonHoverCard>
      );
    }
    default:
      return <span key={key}>{children}</span>;
  }
}

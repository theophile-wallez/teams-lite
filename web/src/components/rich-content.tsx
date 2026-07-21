import { useMemo, type JSX } from "react";
import { hasVisibleContent, parseRichHtml, type RichNode } from "~/lib/rich-text";
import { cn } from "~/lib/utils";

/**
 * Renders a Teams HTML fragment as safe React elements. The HTML is parsed into
 * an allowlisted node tree by {@link parseRichHtml} (no `dangerouslySetInnerHTML`),
 * then mapped to styled elements here. Supports bold, italic, underline,
 * strikethrough, inline code, code blocks, links, ordered/unordered lists,
 * @mentions, line breaks, and inline images.
 */
export function RichContent(props: { html: string; className?: string }) {
  const nodes = useMemo(() => parseRichHtml(props.html), [props.html]);
  if (!hasVisibleContent(nodes)) return null;
  return (
    <div className={cn("whitespace-pre-wrap break-words", props.className)}>
      {nodes.map((node, i) => renderNode(node, i))}
    </div>
  );
}

// Block-level tags get vertical spacing between siblings (but not before the
// first child), so paragraphs and lists don't collapse together.
const BLOCK_SPACING = "[&:not(:first-child)]:mt-1";

function renderNode(node: RichNode, key: number): JSX.Element | string | null {
  if (node.type === "text") return node.text;

  const children = node.children.map((child, i) => renderNode(child, i));

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
          className="underline underline-offset-2 hover:opacity-80"
        >
          {children}
        </a>
      );
    case "img":
      return (
        <img
          key={key}
          src={node.attrs.src}
          alt={node.attrs.alt ?? ""}
          loading="lazy"
          className="my-1 max-h-80 max-w-full rounded-md"
        />
      );
    case "mention":
      return (
        <span key={key} className="font-semibold text-sender-name">
          {children}
        </span>
      );
    default:
      return <span key={key}>{children}</span>;
  }
}

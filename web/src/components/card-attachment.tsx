import { Fragment, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ExternalLinkIcon, Layout01Icon } from "@hugeicons/core-free-icons";
import type { Attachment, CardPayload } from "~/lib/protocol";
import { parseCardMarkdown } from "~/lib/card-markdown";
import { cn } from "~/lib/utils";
import { RichNodes } from "./rich-content";

/** The generic label the backend gives a card that has no title of its own
 *  (`PLACEHOLDER_TITLE` in src/teams_cards.rs). It exists so a generic attachment
 *  renderer and the sidebar preview always find a name; as a heading it says nothing
 *  the card's own glyph does not, so a card with real content drops it. */
const PLACEHOLDER_NAME = "Card";

/**
 * An adaptive / connector card posted by an app or a bot — a poll, a monitoring
 * alert, a GitHub / Figma / Sentry notification — rendered from the flattened
 * payload the backend decodes out of the `SWIFT.1` body (see src/teams_cards.rs).
 * Whole channels are made of nothing but these, so it is a first-class surface,
 * not a debug dump of what a card once was.
 *
 * It wears the same clothes as the other cards in the app (see `GitLabLinkCard`
 * and `EmailSummaryCard`): one `bg-card` panel with a leading glyph, a title, and
 * quiet supporting lines. The text is the card's own markdown — an Adaptive Card
 * `TextBlock` is markdown by specification — so it is parsed by
 * {@link parseCardMarkdown} and rendered by the message renderer itself: bold labels
 * stay bold, and a link shows its two-word label instead of the 500-character
 * monitoring URL behind it.
 *
 * What it deliberately does NOT do is pretend to be a card host: nothing in the text
 * is ever read as HTML, and an action that is not a link — a poll vote, a bot
 * `Action.Submit` — renders as inert text. Acting on one would mean posting to
 * Teams as the user, which nothing in this client does behind their back.
 *
 * `onPanel` says the card already sits on a surface of its own — a channel
 * thread's card, where the card IS the root post — so it drops its own fill,
 * padding and shadow and reads as the content of that panel. Two nested panels
 * frame the same words twice and buy nothing.
 */
export function CardAttachment(props: {
  attachment: Attachment;
  onPanel?: boolean;
  className?: string;
}) {
  const { attachment } = props;
  // A card entry whose payload never made it through still names itself, so the
  // fact that a card was posted is not lost.
  const card: CardPayload = attachment.card ?? { title: "", text: "", facts: [], actions: [] };
  const facts = card.facts ?? [];
  const actions = card.actions ?? [];
  // A link unfurl also says which app produced it (see `card.app_name`); a card a
  // bot posted directly carries neither, and its title already names the source.
  const appName = card.app_name?.trim() ?? "";
  const appIcon = card.app_icon?.trim() ?? "";
  const text = useMemo(() => parseCardMarkdown(card.text), [card.text]);
  // The placeholder name is a label of last resort: it titles a card whose payload
  // never came through — losing the fact that a card was posted would be worse —
  // and steps aside as soon as the card has content of its own to show.
  const name = attachment.name.trim();
  const hasBody = text.length > 0 || facts.length > 0 || actions.length > 0;
  const title = card.title.trim() || (name === PLACEHOLDER_NAME && hasBody ? "" : name);

  return (
    <div
      data-testid="card-attachment"
      data-content-type={attachment.content_type}
      data-on-panel={props.onPanel ? "true" : undefined}
      className={cn(
        "w-full text-foreground",
        !props.onPanel && "rounded-xl bg-card px-3 py-2.5 shadow-chip",
        props.className,
      )}
    >
      <div className="flex items-start gap-2.5">
        {appIcon ? (
          // A link unfurl names its app and ships an ordinary public CDN icon (no
          // media proxy needed, unlike hosted content), so the source is shown as
          // itself rather than as the generic card glyph.
          <img
            data-testid="card-app-icon"
            src={appIcon}
            alt=""
            className="mt-0.5 size-4 shrink-0 rounded-sm object-contain"
            loading="lazy"
          />
        ) : (
          <HugeiconsIcon
            icon={Layout01Icon}
            className="mt-0.5 size-4 shrink-0 text-primary"
            strokeWidth={1.6}
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {appName && appName !== title ? (
            <div data-testid="card-app-name" className="truncate text-[11px] text-text-faint">
              {appName}
            </div>
          ) : null}

          {title ? (
            <div data-testid="card-title" className="text-[13px] font-medium break-words">
              {title}
            </div>
          ) : null}

          {text.length > 0 ? (
            // The card's blocks arrive as one string with `\n` between them; each is
            // a block of markdown, rendered as its own paragraph or list item.
            <div data-testid="card-text" className="text-xs text-text-dim">
              <RichNodes nodes={text} />
            </div>
          ) : null}

          {facts.length > 0 ? (
            <dl
              data-testid="card-facts"
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 text-[11px]"
            >
              {facts.map((fact, i) => (
                <Fragment key={`${fact.title}-${i}`}>
                  <dt className="truncate text-text-faint">{fact.title}</dt>
                  <dd className="min-w-0 break-words text-text-dim">{fact.value}</dd>
                </Fragment>
              ))}
            </dl>
          ) : null}

          {actions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {actions.map((action, i) =>
                action.url ? (
                  <a
                    key={`${action.title}-${i}`}
                    data-testid="card-action"
                    href={action.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2 py-1 text-xs font-medium transition-colors hover:bg-accent"
                  >
                    {action.title}
                    <HugeiconsIcon
                      icon={ExternalLinkIcon}
                      className="size-3 shrink-0"
                      strokeWidth={1.8}
                      aria-hidden
                    />
                  </a>
                ) : (
                  // Not a link: a vote, a form submit — something only real Teams
                  // can perform. Shown so the card still reads as what it is, with
                  // no border, no hover and no cursor that suggests otherwise.
                  <span
                    key={`${action.title}-${i}`}
                    data-testid="card-action-inert"
                    className="inline-flex w-fit items-center rounded-md px-1.5 py-1 text-xs text-text-faint"
                  >
                    {action.title}
                  </span>
                ),
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

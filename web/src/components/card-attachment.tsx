import { Fragment } from "react";
import { ExternalLink, LayoutTemplate } from "lucide-react";
import type { Attachment, CardPayload } from "~/lib/protocol";
import { cn } from "~/lib/utils";

/**
 * An adaptive / connector card posted by an app or a bot — a poll, a monitoring
 * alert, a GitHub / Figma / Sentry notification — rendered from the flattened
 * payload the backend decodes out of the `SWIFT.1` body (see src/teams_cards.rs).
 * Whole channels are made of nothing but these, so it is a first-class surface,
 * not a debug dump of what a card once was.
 *
 * It wears the same clothes as the other cards in the app (see `GitLabLinkCard`
 * and `EmailSummaryCard`): one `bg-card` panel with a leading glyph, a title, and
 * quiet supporting lines. What it deliberately does NOT do is pretend to be a card
 * host: `text` is printed verbatim as plain text (its `\n` block breaks preserved,
 * never parsed as markup), and an action that is not a link — a poll vote, a bot
 * `Action.Submit` — renders as inert text. Acting on one would mean posting to
 * Teams as the user, which nothing in this client does behind their back.
 */
/** A line made of nothing but separator punctuation — Adaptive Cards lay out
 *  "Rust • 12 Stars" as separate blocks, so flattening them to `\n` leaves a lone
 *  "•" or "|" on its own line. It carried a horizontal rhythm we do not reproduce
 *  and no information, so it goes. */
const SEPARATOR_LINE = /^[\s•·|—–\-*]+$/;

/** Drop the card text's information-free separator lines, keeping everything else
 *  verbatim (including blank runs collapsed to a single break). */
function cardText(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "" && !SEPARATOR_LINE.test(line))
    .join("\n");
}

export function CardAttachment(props: { attachment: Attachment; className?: string }) {
  const { attachment } = props;
  // A card entry whose payload never made it through still names itself, so the
  // fact that a card was posted is not lost.
  const card: CardPayload = attachment.card ?? { title: "", text: "", facts: [], actions: [] };
  const title = card.title.trim() || attachment.name.trim();
  const facts = card.facts ?? [];
  const actions = card.actions ?? [];
  // A link unfurl also says which app produced it (see `card.app_name`); a card a
  // bot posted directly carries neither, and its title already names the source.
  const appName = card.app_name?.trim() ?? "";
  const appIcon = card.app_icon?.trim() ?? "";
  const text = cardText(card.text);

  return (
    <div
      data-testid="card-attachment"
      data-content-type={attachment.content_type}
      className={cn("w-full rounded-xl bg-card px-3 py-2.5 text-foreground shadow-chip", props.className)}
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
          <LayoutTemplate
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

          {text ? (
            // The card's blocks arrive as one string with `\n` between them, so the
            // breaks are honoured by the wrapping rather than by markup.
            <p data-testid="card-text" className="whitespace-pre-wrap break-words text-xs text-text-dim">
              {text}
            </p>
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
                    <ExternalLink className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
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

import { ExternalLink, Mail } from "lucide-react";
import type { RelayedEmail } from "~/lib/rich-text";
import { cn } from "~/lib/utils";

/**
 * The compact rendering of an HTML email relayed into a channel (Sentry alert
 * digests and the like): a mail chip, the subject, the headings beneath it as a
 * short list of links, and the email's call-to-action.
 *
 * Full email HTML is a wall of nested layout tables inside a chat bubble, with a
 * logo and a tracking pixel that our image rendering would turn into framed,
 * zoomable picture cards. So the body is not rendered at all — only the gist
 * {@link parseRelayedEmail} extracts from it, which by construction contains no
 * images and no tables. The hidden preheader ("New issue from internal.") is
 * dropped even earlier, by the parser's `display:none` handling.
 */
export function EmailSummaryCard(props: { email: RelayedEmail; className?: string }) {
  const { subject, headlines, action } = props.email;
  return (
    <div
      data-testid="email-summary"
      className={cn("flex min-w-0 flex-col gap-1.5", props.className)}
    >
      <div className="flex items-center gap-1.5 text-xs text-text-dim">
        <Mail className="size-3.5 shrink-0" strokeWidth={1.6} aria-hidden />
        <span>Email</span>
      </div>

      {subject ? <div className="font-semibold break-words">{subject}</div> : null}

      {headlines.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {headlines.map((line, i) => (
            <li key={`${line.text}-${i}`} className="flex gap-1.5">
              <span className="text-text-dim" aria-hidden>
                ·
              </span>
              {line.href ? (
                <a
                  href={line.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 break-words underline underline-offset-2 hover:opacity-80"
                >
                  {line.text}
                </a>
              ) : (
                <span className="min-w-0 break-words">{line.text}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {action ? (
        <a
          data-testid="email-action"
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 inline-flex w-fit items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2 py-1 text-xs font-medium transition-colors hover:bg-accent"
        >
          {action.label}
          <ExternalLink className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
        </a>
      ) : null}
    </div>
  );
}

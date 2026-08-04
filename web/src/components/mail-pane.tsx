import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ChevronLeftIcon,
  Download04Icon,
  Loading02Icon,
  Mail01Icon,
} from "@hugeicons/core-free-icons";
import {
  formatAttachmentSize,
  mailAddressLabel,
  mailFileAttachments,
  mailReceivedMs,
  mailRecipientsLabel,
  mailSenderLabel,
  mailSubjectLabel,
  type MailAddress,
  type MailAttachment,
  type MailHeader,
} from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar, mailAddressPhoto, mailAvatarInitials, mailAvatarSeed } from "./avatar";
import { useAppState, useController } from "./controller-context";
import { FileTypeIcon } from "./file-type-icon";
import { MailBody } from "./mail-body";

// The reading pane for one mail. Occupies the same slot as `MessagePane`, so the
// two-column layout, the mobile full-screen page and the back button all behave
// identically whether the user is reading a chat or a mail.
//
// There is no reply, forward or delete affordance, and their absence is deliberate:
// the backend cannot perform any of them (see src/mail.rs). Offering a button that
// could only fail — or worse, that someone later wires up without a consent gate —
// would be the wrong kind of complete.

/** Full date and time for the reading pane header. */
function formatFullDate(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MailPane(props: { onBack?: () => void }) {
  const mail = useAppState((s) => s.openMail);
  const openMailId = useAppState((s) => s.openMailId);
  const body = useAppState((s) => s.mailBody);
  const bodyLoading = useAppState((s) => s.mailBodyLoading);
  const bodyError = useAppState((s) => s.mailBodyError);

  if (!openMailId) return <MailEmptyState />;

  return (
    <section data-testid="mail-pane" className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border-subtle px-3 pt-[env(safe-area-inset-top)] md:gap-3 md:px-5">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label="Back to mail"
            data-testid="back-to-list"
            className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-text-dim transition-colors hover:bg-accent hover:text-foreground md:hidden"
          >
            <HugeiconsIcon icon={ChevronLeftIcon} className="size-5" strokeWidth={1.6} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 data-testid="mail-title" className="truncate text-sm font-medium text-foreground">
            {mail ? mailSubjectLabel(mail) : "Message"}
          </h2>
          <p className="truncate text-[11px] text-text-faint">
            {/* Says plainly what this surface is, and what it is not. */}
            Mail · read-only
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <article className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {/* Keyed by the mail, so a recipient line the reader opened on one message
              starts collapsed again on the next. */}
          {mail && <MailHeaderCard key={mail.id} mail={mail} />}

          {bodyError ? (
            <p data-testid="mail-body-error" className="text-[13px] text-destructive">
              {bodyError}
            </p>
          ) : bodyLoading || !body ? (
            <p className="flex items-center gap-2 py-6 text-[13px] text-text-faint">
              <HugeiconsIcon
                icon={Loading02Icon}
                className="size-3.5 animate-spin"
                strokeWidth={1.6}
              />
              Loading message…
            </p>
          ) : (
            <>
              <MailAttachments messageId={openMailId} attachments={body.attachments} />
              <MailBody body={body} />
            </>
          )}
        </article>
      </div>
    </section>
  );
}

/** Sender, recipients and date — the metadata block above the body. */
function MailHeaderCard(props: { mail: MailHeader }) {
  const mail = props.mail;
  const sender = mailSenderLabel(mail);
  const date = useMemo(() => formatFullDate(mailReceivedMs(mail)), [mail.received]);

  return (
    <div className="flex flex-col gap-3">
      <h1 data-testid="mail-heading" className="text-lg font-semibold leading-snug text-foreground">
        {mailSubjectLabel(mail)}
      </h1>
      <div className="flex items-start gap-3">
        <Avatar
          seed={mailAvatarSeed(mail.from, mail.id)}
          label={sender}
          initials={mailAvatarInitials(mail.from)}
          fallback="person"
          photo={mailAddressPhoto(mail.from.address)}
          testId="mail-avatar"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span data-testid="mail-from" className="text-[13px] font-medium text-foreground">
              {sender}
            </span>
            {mail.from.address && mail.from.name && (
              <span className="truncate text-[12px] text-text-faint">{mail.from.address}</span>
            )}
            {date && <time className="ml-auto shrink-0 text-[12px] text-text-faint">{date}</time>}
          </div>
          <MailRecipients kind="to" label="To" addresses={mail.to} />
          <MailRecipients kind="cc" label="Cc" addresses={mail.cc} />
        </div>
      </div>
    </div>
  );
}

/** How many recipients a line shows before the rest go behind a "+N" chip. Enough
 *  that an ordinary mail shows everybody, few enough that a 200-address distribution
 *  list cannot push the body off the screen. */
const RECIPIENTS_SHOWN = 6;

/** One recipient line — To or Cc — as a face and a name per person, the way a mail
 *  client names the people a message reached. A long list is cut at
 *  RECIPIENTS_SHOWN and opens in place, because the count is what matters first and
 *  the names second. Nothing renders when nobody is on the line. */
function MailRecipients(props: { kind: "to" | "cc"; label: string; addresses: MailAddress[] }) {
  const [expanded, setExpanded] = useState(false);
  const people = useMemo(
    () => props.addresses.filter((address) => mailAddressLabel(address).length > 0),
    [props.addresses],
  );
  if (people.length === 0) return null;

  const shown = expanded ? people : people.slice(0, RECIPIENTS_SHOWN);
  const hidden = people.slice(shown.length);

  return (
    <div
      data-testid="mail-recipients"
      data-kind={props.kind}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <span className="text-[12px] text-text-faint">{props.label}</span>
      {shown.map((address, index) => (
        <MailPersonChip key={`${address.address}-${index}`} address={address} />
      ))}
      {hidden.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="mail-recipients-more"
          title={mailRecipientsLabel(hidden, hidden.length)}
          className={cn(
            "rounded-full px-2 py-0.5 text-[12px] tabular-nums text-text-dim",
            "bg-accent/60 transition-colors hover:bg-accent hover:text-foreground",
          )}
        >
          +{hidden.length}
        </button>
      )}
    </div>
  );
}

/** One person a mail names: their photo when the directory knows the address, their
 *  tinted initials otherwise. The address is the title, so a name shared by two
 *  colleagues is still tellable apart without widening the chip. */
function MailPersonChip(props: { address: MailAddress }) {
  const label = mailAddressLabel(props.address);
  return (
    <span
      data-testid="mail-recipient"
      data-address={props.address.address || undefined}
      title={props.address.address || label}
      className="flex max-w-[220px] items-center gap-1.5 rounded-full bg-accent/60 py-0.5 pl-0.5 pr-2"
    >
      <Avatar
        seed={mailAvatarSeed(props.address, label)}
        label={label}
        // One letter, not two: the chip is 20px, and the overlap of a second letter
        // is what a dense stack clips first.
        initials={mailAvatarInitials(props.address).slice(0, 1)}
        fallback="person"
        photo={mailAddressPhoto(props.address.address)}
        className="size-5 text-[9px]"
        testId="mail-avatar"
      />
      <span className="min-w-0 truncate text-[12px] text-text-dim">{label}</span>
    </span>
  );
}

/** File attachments as downloadable chips. Inline images are excluded — they are
 *  already rendered inside the body, so listing them here would double them up. */
function MailAttachments(props: { messageId: string; attachments: MailAttachment[] }) {
  const controller = useController();
  const files = useMemo(() => mailFileAttachments(props.attachments), [props.attachments]);
  if (files.length === 0) return null;

  return (
    <ul data-testid="mail-attachments" className="flex flex-wrap gap-2">
      {files.map((file) => {
        const size = formatAttachmentSize(file.size);
        return (
          <li key={file.id}>
            <button
              type="button"
              data-testid="mail-attachment"
              data-cuelume-press=""
              onClick={() =>
                void controller.downloadMailAttachment(props.messageId, file.id, file.name)
              }
              title={`Download ${file.name}`}
              className={cn(
                "group flex max-w-[280px] items-center gap-2 rounded-lg bg-card px-2.5 py-1.5",
                "text-left text-[12px] text-text-dim shadow-chip transition-colors hover:text-foreground",
              )}
            >
              <FileTypeIcon name={file.name} contentType={file.content_type} className="size-4" />
              <span className="min-w-0 flex-1 truncate">{file.name || "Attachment"}</span>
              {size && <span className="shrink-0 tabular-nums text-text-faint">{size}</span>}
              <HugeiconsIcon
                icon={Download04Icon}
                className="size-3.5 shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-100"
                strokeWidth={1.6}
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Shown in the detail pane while the Mail tab is up but no mail is open. */
function MailEmptyState() {
  return (
    <section
      data-testid="mail-pane-empty"
      className="flex min-w-0 flex-1 items-center justify-center bg-background p-8"
    >
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
          <HugeiconsIcon icon={Mail01Icon} className="size-6" strokeWidth={1.4} />
        </span>
        <p className="text-sm text-text-dim">Pick a message to read it.</p>
        <p className="text-[12px] text-text-faint">
          Mail is read-only here: remote images are never loaded, so opening a message
          tells its sender nothing. Reading one clears its marker in this app alone —
          Outlook still shows it unread.
        </p>
      </div>
    </section>
  );
}

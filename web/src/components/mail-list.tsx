import { useCallback, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { HugeiconsIcon } from "@hugeicons/react";
import { Attachment01Icon, ChevronDownIcon } from "@hugeicons/core-free-icons";
import {
  mailFolderLabel,
  mailReceivedMs,
  mailSenderLabel,
  mailSubjectLabel,
  type MailFolder,
  type MailHeader,
} from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar, mailAddressPhoto, mailAvatarInitials, mailAvatarSeed } from "./avatar";
import { useAppState, useController } from "./controller-context";
import { FadeArc } from "./loading-ui/fade-arc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// The Mail tab's sidebar surface: a folder picker over a virtualized list of
// message headers. Deliberately the same shape as the Chats tab — a scrollable list
// of rows whose selection drives the shared detail pane — so mail reads as one more
// section of the app rather than a bolted-on second application.

/** Row height for the three-line mail row (sender, subject, preview). */
const ROW_HEIGHT = 78;

/** How close to the bottom (px) the list gets before older mail is prefetched. */
const PREFETCH_MARGIN_PX = 600;

/** Compact date for a mail row: the time today, a weekday this week, else a date.
 *  Mirrors the chat sidebar's formatter so both lists read alike. */
function formatMailDate(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  if (now.getTime() - date.getTime() < 7 * dayMs) {
    return date.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

/** The Mail tab: folder picker + the selected folder's mail, newest first. */
export function MailList() {
  const controller = useController();
  const folders = useAppState((s) => s.mailFolders);
  const folderId = useAppState((s) => s.mailFolderId);
  const messages = useAppState((s) => s.mailMessages);
  const loading = useAppState((s) => s.mailLoading);
  const loadingOlder = useAppState((s) => s.mailLoadingOlder);
  const hasMoreOlder = useAppState((s) => s.mailHasMoreOlder);
  const error = useAppState((s) => s.mailError);
  const openMailId = useAppState((s) => s.openMailId);
  const navigate = useNavigate();

  const selected = useMemo(
    () => folders.find((f) => f.id === folderId) ?? null,
    [folders, folderId],
  );

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: 10,
  });

  // Infinite scroll downwards (mail lists page into the PAST as you scroll down,
  // the opposite of a chat history).
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || !hasMoreOlder || loadingOlder) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < PREFETCH_MARGIN_PX) void controller.loadOlderMail();
  }, [controller, hasMoreOlder, loadingOlder]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FolderPicker
        folders={folders}
        selected={selected}
        onSelect={(id) => void controller.selectMailFolder(id)}
      />

      {error && messages.length === 0 ? (
        <p
          data-testid="mail-error"
          className="px-4 py-6 text-center text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : loading && messages.length === 0 ? (
        <MailListSkeleton />
      ) : messages.length === 0 ? (
        <p
          data-testid="mail-empty"
          className="px-6 py-6 text-center text-[13px] text-text-faint"
        >
          No mail in this folder.
        </p>
      ) : (
        <div
          ref={parentRef}
          onScroll={onScroll}
          data-testid="mail-scroll"
          className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2"
        >
          <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((row) => {
              const mail = messages[row.index];
              if (!mail) return null;
              return (
                <div
                  key={mail.id}
                  className="absolute left-0 top-0 w-full"
                  style={{ height: `${ROW_HEIGHT}px`, transform: `translateY(${row.start}px)` }}
                >
                  <MailRow
                    mail={mail}
                    open={openMailId === mail.id}
                    onClick={() =>
                      void navigate({ to: "/m/$mailId", params: { mailId: mail.id } })
                    }
                  />
                </div>
              );
            })}
          </div>
          {loadingOlder && (
            <p className="flex items-center justify-center gap-2 py-3 text-[12px] text-text-faint">
              <FadeArc className="size-3.5" />
              Loading earlier mail…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** How many placeholder rows the skeleton draws. Enough to fill a tall sidebar; the
 *  surplus is clipped rather than scrolled. */
const SKELETON_ROWS = 10;

/** Per-row bar widths, so the placeholder reads as mail rather than as a table.
 *  A fixed cycle, not a random draw: the same folder must not re-shuffle on every
 *  render, and a screenshot has to be reproducible. */
const SKELETON_WIDTHS = [
  { sender: "w-24", subject: "w-44", preview: "w-52" },
  { sender: "w-32", subject: "w-36", preview: "w-40" },
  { sender: "w-20", subject: "w-52", preview: "w-32" },
  { sender: "w-28", subject: "w-28", preview: "w-48" },
];

/** The first load of a folder: the rows that are coming, drawn as quiet bars.
 *  A skeleton over a spinner because the list's shape is known before its content
 *  is — the sidebar keeps its geometry, so nothing jumps when the mail lands. */
function MailListSkeleton() {
  return (
    <div
      data-testid="mail-loading"
      className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2"
      aria-busy="true"
      aria-hidden
    >
      {Array.from({ length: SKELETON_ROWS }, (_, index) => {
        const width = SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]!;
        return (
          <div
            key={index}
            className="my-0.5 flex h-[74px] shrink-0 animate-pulse items-start gap-3 px-2.5 py-2"
            // Staggered so the column breathes down the list instead of blinking
            // as one block.
            style={{ animationDelay: `${index * 90}ms` }}
          >
            {/* Tinted from --text-faint, not from --accent: the hover fill is within a
                percent of the sidebar itself in light mode, so a bar made of it is
                invisible. The faint text colour reads on both themes. */}
            <span className="size-9 shrink-0 rounded-full bg-text-faint/20" />
            <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <span className="flex items-center gap-2">
                <span className={cn("h-3 rounded bg-text-faint/25", width.sender)} />
                <span className="ml-auto h-2.5 w-8 rounded bg-text-faint/15" />
              </span>
              <span className={cn("h-3 rounded bg-text-faint/20", width.subject)} />
              <span className={cn("h-2.5 rounded bg-text-faint/15", width.preview)} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The folder selector. A dropdown rather than a row of chips: a real mailbox has
 *  seven well-known folders plus the user's own, which would never fit a 320px
 *  sidebar as tabs. */
function FolderPicker(props: {
  folders: MailFolder[];
  selected: MailFolder | null;
  onSelect: (id: string) => void;
}) {
  const label = props.selected ? mailFolderLabel(props.selected) : "Folders";
  return (
    <div className="px-3 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="mail-folder-picker"
          data-cuelume-press=""
          className={cn(
            "flex w-full items-center gap-2 rounded-lg bg-card px-3 py-2 text-left shadow-chip",
            "text-[13px] font-medium text-foreground transition-colors hover:bg-accent",
          )}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {props.selected && props.selected.unread_count > 0 && (
            <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
              {props.selected.unread_count}
            </span>
          )}
          <HugeiconsIcon
            icon={ChevronDownIcon}
            className="size-3.5 shrink-0 text-text-faint"
            strokeWidth={1.6}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[240px]">
          {props.folders.map((folder) => (
            <DropdownMenuItem
              key={folder.id}
              data-testid="mail-folder-option"
              data-folder-id={folder.id}
              onClick={() => props.onSelect(folder.id)}
              className={cn(
                "flex items-center gap-2",
                folder.id === props.selected?.id && "font-medium text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{mailFolderLabel(folder)}</span>
              {folder.unread_count > 0 && (
                <span className="shrink-0 text-[11px] tabular-nums text-text-faint">
                  {folder.unread_count}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** One mail row: sender, date, subject, and Graph's own preview line. Unread is
 *  carried by a bolder sender + subject and a dot, matching the chat list's idiom. */
function MailRow(props: { mail: MailHeader; open: boolean; onClick: () => void }) {
  const mail = props.mail;
  const unread = !mail.is_read;
  const sender = mailSenderLabel(mail);
  const date = useMemo(() => formatMailDate(mailReceivedMs(mail)), [mail.received]);

  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid="mail-row"
      data-mail-id={mail.id}
      data-open={props.open ? "true" : undefined}
      data-unread={unread ? "true" : undefined}
      aria-current={props.open ? "true" : undefined}
      className={cn(
        "my-0.5 flex h-[74px] w-full items-start gap-3 rounded-xl px-2.5 py-2 text-left transition-all",
        props.open ? "bg-row-open shadow-card" : "hover:bg-row-hovered",
      )}
    >
      <Avatar
        seed={mailAvatarSeed(mail.from, mail.id)}
        label={sender}
        initials={mailAvatarInitials(mail.from)}
        fallback="person"
        photo={mailAddressPhoto(mail.from.address)}
        testId="mail-avatar"
      />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            data-testid="mail-sender"
            className={cn(
              "min-w-0 flex-1 truncate text-[13px]",
              unread || props.open ? "font-medium text-foreground" : "text-text-dim",
            )}
          >
            {sender}
          </span>
          {mail.has_attachments && (
            <HugeiconsIcon
              icon={Attachment01Icon}
              className="size-3 shrink-0 text-text-faint"
              strokeWidth={1.6}
            />
          )}
          {date && (
            <time className="shrink-0 text-[11px] tabular-nums text-text-faint">{date}</time>
          )}
        </span>

        <span
          data-testid="mail-subject"
          className={cn(
            "truncate text-[13px]",
            unread ? "font-medium text-foreground" : "text-text-dim",
          )}
        >
          {mailSubjectLabel(mail)}
        </span>

        <span className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-xs text-text-faint">{mail.preview || " "}</span>
          {unread && <span className="size-2 shrink-0 rounded-full bg-unread-dot" aria-hidden />}
        </span>
      </span>
    </button>
  );
}

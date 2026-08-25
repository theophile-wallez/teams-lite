import { HugeiconsIcon } from "@hugeicons/react";
import {
  BellIcon,
  BellOffIcon,
  EyeIcon,
  EyeOffIcon,
  Mail01Icon,
  MailOpen01Icon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import {
  chatIsHidden,
  chatIsMuted,
  chatIsPinned,
  chatIsUnread,
  type Conversation,
} from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Every row carries its glyph in the same gutter, so the four labels read as one
 *  column rather than as two groups. */
const ITEM_ICON = "size-4 shrink-0 text-text-dim";

/**
 * The "…" menu on a chat row in the sidebar — the settings Microsoft Teams offers
 * there: pin the chat to the top, mute it, put it away, mark it read or unread.
 *
 * Two of the four items reach the account, and two do not — which is measurement, not
 * policy, and the menu says which is which because a switch whose reach the user has to
 * guess is worse than no switch:
 *
 * - **Mute is published to Microsoft Teams.** A mute is the conversation's own `alerts`
 *   property; the write round-trips (see `src/teams_chat_settings.rs`), so it lands on
 *   every device the user is signed in on and their phone stops notifying them.
 * - **Mark as read is published too**: the same `mark_read` the app makes on open, which
 *   moves the user's consumption horizon and shows the sender a read receipt. Ghost mode
 *   still decides whether Teams is told at all.
 * - **Mark as UNREAD does not reach Teams**, and cannot: `mark_read` only publishes a
 *   horizon that moves forward, and a read receipt the sender already saw cannot be
 *   withdrawn. So it is a local marker, cleared by opening the chat (see
 *   `chatIsUnread`) — the direction the pair is asymmetric in, stated rather than hidden.
 * - **Pin and hide stay HERE.** Teams keeps neither in a place this app can write: the
 *   chat service refuses `pinned`/`sticky` outright, and the properties it does accept
 *   are never read back by the payload the sidebar is built from. A write nothing reads
 *   would report success while the user's phone disagreed, so both remain local
 *   overrides (`ChatPrefs` in lib/protocol.ts).
 *
 * The trigger belongs to a pointer, so a phone never sees it: it is revealed by hover
 * on a fine pointer and hidden outright on a coarse one, where the way in is a long
 * press on the row (the row owns that, and opens this menu through `open`). It comes
 * back for the anchor while the menu IS open, since a `display: none` trigger has no
 * position to anchor a panel to.
 */
export function ChatMenu(props: {
  conversation: Conversation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where the trigger sits, and on which background — the row's business, since it is
   *  the row's corner and the row's colour. */
  className?: string;
}) {
  const controller = useController();
  const prefs = useAppState((s) => s.chatPrefs);
  const unreads = useAppState((s) => s.chatUnreads);
  const c = props.conversation;
  const pinned = chatIsPinned(c, prefs);
  const muted = chatIsMuted(c);
  const hidden = chatIsHidden(c, prefs);
  const unread = chatIsUnread(c, unreads);

  return (
    // Non-modal, for the reason calendar-view-menu.tsx spells out: a modal Radix menu
    // parks `pointer-events: none` on the body until its close animation ends, which
    // swallows the next click.
    <DropdownMenu modal={false} open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger
        data-testid="chat-menu"
        data-conversation-id={c.id}
        aria-label={`Chat settings for ${c.name || "this chat"}`}
        title="More options"
        data-cuelume-press=""
        // The row itself is a button and this trigger sits over it, so the click must
        // stop here: opening the menu must never also open the chat.
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "hidden size-7 place-items-center rounded-lg bg-transparent text-text-dim transition-colors",
          "hover:bg-element hover:text-foreground data-[state=open]:bg-element data-[state=open]:text-foreground",
          "data-[state=open]:grid",
          "[@media(pointer:fine)]:grid [@media(pointer:fine)]:opacity-0",
          "[@media(pointer:fine)]:group-hover/chat:opacity-100",
          "[@media(pointer:fine)]:focus-visible:opacity-100",
          "[@media(pointer:fine)]:data-[state=open]:opacity-100",
          props.className,
        )}
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" strokeWidth={2} />
      </DropdownMenuTrigger>

      {/* A fixed width, because the note at the foot is a sentence: left to itself the
          panel would stretch to hold it on one line, and a 320px sidebar would carry a
          menu wider than the list it belongs to. */}
      <DropdownMenuContent align="end" className="w-[15rem]">
        {/* Every row states what the click will DO — "Unpin", not a ticked "Pin" —
            which is how Teams words this menu, and it keeps the four labels on one
            gutter instead of two. */}
        <DropdownMenuItem
          data-testid="chat-menu-pin"
          data-on={pinned ? "true" : undefined}
          onSelect={() => controller.toggleChatPin(c.id)}
        >
          <HugeiconsIcon
            icon={pinned ? PinOffIcon : PinIcon}
            className={ITEM_ICON}
            strokeWidth={1.6}
          />
          <span className="flex-1">{pinned ? "Unpin" : "Pin to top"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="chat-menu-mute"
          data-on={muted ? "true" : undefined}
          onSelect={() => void controller.setChatMuted(c.id, !muted)}
        >
          <HugeiconsIcon
            icon={muted ? BellIcon : BellOffIcon}
            className={ITEM_ICON}
            strokeWidth={1.6}
          />
          <span className="flex-1">{muted ? "Unmute" : "Mute"}</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          data-testid="chat-menu-hide"
          data-on={hidden ? "true" : undefined}
          onSelect={() => controller.setChatHidden(c.id, !hidden)}
        >
          <HugeiconsIcon
            icon={hidden ? EyeIcon : EyeOffIcon}
            className={ITEM_ICON}
            strokeWidth={1.6}
          />
          <span className="flex-1">{hidden ? "Show chat" : "Hide chat"}</span>
        </DropdownMenuItem>
        {/* One slot, two actions, and which one is offered is which one has something
            to do — the "Unpin"/"Pin to top" rule again. Reading it through
            `chatIsUnread` is what makes the pair honest: a chat marked unread HERE is
            offered "Mark as read", whatever Teams still says about it. */}
        {unread ? (
          <DropdownMenuItem
            data-testid="chat-menu-mark-read"
            onSelect={() => void controller.markConversationRead(c.id)}
          >
            <HugeiconsIcon icon={MailOpen01Icon} className={ITEM_ICON} strokeWidth={1.6} />
            <span className="flex-1">Mark as read</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            data-testid="chat-menu-mark-unread"
            onSelect={() => controller.markChatUnread(c.id)}
          >
            <HugeiconsIcon icon={Mail01Icon} className={ITEM_ICON} strokeWidth={1.6} />
            <span className="flex-1">Mark as unread</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Not a `DropdownMenuLabel`: that one captions the group under it. This is a
            note about the items above, and it is the honest half of offering them at
            all — each half of it names the settings it applies to. */}
        <p className="px-2.5 pb-1 pt-0.5 text-[11px] leading-snug text-text-faint">
          Muting and marking read reach Microsoft Teams, so your phone follows. Pinning,
          hiding and marking unread stay in teams-lite.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { HugeiconsIcon } from "@hugeicons/react";
import {
  BellIcon,
  BellOffIcon,
  EyeIcon,
  EyeOffIcon,
  MailOpen01Icon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import { chatIsHidden, chatIsMuted, chatIsPinned, type Conversation } from "~/lib/protocol";
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
 * there: pin the chat to the top, mute it, put it away, mark it read.
 *
 * Pin, mute and hide are LOCAL overrides. Each mirrors what Teams reported until the
 * user changes it here, and nothing is written back: publishing a setting to their
 * account is an outward action and would need its own consent gate, exactly like a
 * send (see `ChatPrefs` in lib/protocol.ts). The menu states that in one line rather
 * than letting the user assume their phone learned about it — a mute that silenced
 * this app while their phone kept buzzing would otherwise read as a broken switch.
 *
 * Mark as read is the one item that DOES leave the machine, so it sits apart: it is
 * the same `mark_read` the app makes on open, which publishes the user's consumption
 * horizon and shows the sender a read receipt. It is here because the user asked for
 * it on this chat, and Ghost mode still decides whether Teams is told at all.
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
  const c = props.conversation;
  const pinned = chatIsPinned(c, prefs);
  const muted = chatIsMuted(c, prefs);
  const hidden = chatIsHidden(c, prefs);

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
          onSelect={() => controller.toggleChatMute(c.id)}
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
        {!c.is_read && (
          <DropdownMenuItem
            data-testid="chat-menu-mark-read"
            onSelect={() => void controller.markConversationRead(c.id)}
          >
            <HugeiconsIcon icon={MailOpen01Icon} className={ITEM_ICON} strokeWidth={1.6} />
            <span className="flex-1">Mark as read</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />

        {/* Not a `DropdownMenuLabel`: that one captions the group under it. This is a
            note about the two settings above, and it is the honest half of offering
            them at all. */}
        <p className="px-2.5 pb-1 pt-0.5 text-[11px] leading-snug text-text-faint">
          Pinning, muting and hiding stay in teams-lite. Microsoft Teams is not told, so
          your phone still notifies you.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

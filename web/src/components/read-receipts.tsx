import type { ReadReceipt } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** How many "seen by" avatars to show before collapsing the rest into a "+N". */
const MAX_AVATARS = 4;

/** The first letter of a name, for the dense overlapping stack (two initials get
 *  clipped by the overlap; the full name shows in the hovercard). */
function firstInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** A display name for a receipt, falling back when the backend couldn't resolve
 *  one (a member outside our roster). */
function receiptName(receipt: ReadReceipt): string {
  return receipt.member.trim() || "Someone";
}

/**
 * The "seen by" row: a right-aligned stack of small overlapping avatars anchored
 * just below the last message each person has read (Teams/Messenger-style read
 * receipts). Only OTHER members appear — our own read position is never shown.
 * Each avatar reveals who it is on hover; more than {@link MAX_AVATARS} readers
 * collapse into a "+N" chip that lists the rest.
 *
 * Purely presentational: the caller (the message pane) decides which message a
 * receipt anchors to via `computeReadReceiptAnchors` and renders this beneath it.
 */
export function ReadReceipts(props: { receipts: ReadReceipt[] }) {
  const { receipts } = props;
  if (receipts.length === 0) return null;

  const shown = receipts.slice(0, MAX_AVATARS);
  const overflow = receipts.slice(MAX_AVATARS);

  return (
    <div
      data-testid="read-receipts"
      className="mt-0.5 mb-1.5 flex justify-end pr-0.5"
    >
      <span className="flex items-center">
        {shown.map((receipt, i) => {
          const name = receiptName(receipt);
          return (
            <Tooltip key={receipt.member_mri}>
              <TooltipTrigger asChild>
                <span
                  data-testid="read-receipt-avatar"
                  className={cn(
                    "relative rounded-md ring-2 ring-background transition-transform hover:z-20 hover:-translate-y-0.5",
                    i > 0 && "-ml-1.5",
                  )}
                  style={{ zIndex: shown.length - i }}
                >
                  <Avatar
                    seed={receipt.member_mri || name}
                    label={name}
                    initials={firstInitial(name)}
                    className="size-4 rounded-md text-[8px] font-semibold"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent className="flex items-center gap-2 px-2 py-1.5">
                <Avatar
                  seed={receipt.member_mri || name}
                  label={name}
                  className="size-7 rounded-lg text-[10px]"
                />
                <span className="flex flex-col">
                  <span className="text-xs font-medium text-popover-foreground">{name}</span>
                  <span className="text-[10px] text-text-faint">Seen</span>
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {overflow.length > 0 && <ReadReceiptsOverflow readers={overflow} />}
      </span>
    </div>
  );
}

/** The "+N" chip for the readers beyond the shown avatars, with a tooltip that
 *  names each of them. */
function ReadReceiptsOverflow(props: { readers: ReadReceipt[] }) {
  const names = props.readers.map(receiptName);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="read-receipts-more"
          style={{ zIndex: 0 }}
          className="relative -ml-1.5 grid size-4 place-items-center rounded-md bg-accent text-[7px] font-semibold text-text-dim ring-2 ring-background transition-transform hover:z-20 hover:-translate-y-0.5 hover:text-foreground"
        >
          +{props.readers.length}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="text-xs text-popover-foreground">Seen by {names.join(", ")}</span>
      </TooltipContent>
    </Tooltip>
  );
}

import { useState } from "react";
import { Phone, PhoneMissed } from "lucide-react";
import { formatCallEvent, type SystemEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

/** How many participant avatars to show before collapsing the rest into a "+N". */
const MAX_AVATARS = 5;

/** The first letter of a name, for the dense overlapping stack (two initials get
 *  clipped by the overlap; the full initials show in the hovercard and dialog). */
function firstInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/**
 * A centered, muted system line for a call/meeting event — e.g. "Call ended ·
 * 10 min" followed by an overlapping stack of participant avatars — rendered in
 * the timeline in place of a chat bubble. Mirrors Teams' inline call notices: no
 * sender, no mine/theirs side. Each avatar reveals the participant on hover; when
 * there are more than five, a "+N" chip opens a dialog with the full roster.
 */
export function CallEventLine(props: { event: SystemEvent }) {
  const { event } = props;
  const missed = event.event === "missed";
  const Icon = missed ? PhoneMissed : Phone;
  const participants = event.participants ?? [];
  return (
    <div
      data-testid="system-event"
      data-system-event={event.kind}
      data-call-event={event.event}
      className="my-2 flex justify-center"
    >
      <span
        className={cn(
          "flex items-center gap-2 rounded-full bg-element px-3 py-1 text-xs",
          missed ? "text-destructive" : "text-text-faint",
        )}
      >
        <span className="flex items-center gap-1.5">
          <Icon className="size-3 shrink-0" strokeWidth={1.8} />
          {formatCallEvent(event)}
        </span>
        {participants.length > 0 && <CallParticipants participants={participants} />}
      </span>
    </div>
  );
}

/** The overlapping avatar stack (capped at {@link MAX_AVATARS}) plus a "+N"
 *  overflow chip. Ringed in the pill's own colour so the avatars read as a clean
 *  cut-out stack. */
function CallParticipants(props: { participants: string[] }) {
  const shown = props.participants.slice(0, MAX_AVATARS);
  const overflow = props.participants.length - shown.length;
  return (
    <span data-testid="call-participants" className="flex items-center">
      {shown.map((name, i) => (
        <Tooltip key={`${i}-${name}`}>
          <TooltipTrigger asChild>
            <span
              data-testid="call-avatar"
              className={cn(
                "relative rounded-lg ring-2 ring-element transition-transform hover:z-20 hover:-translate-y-0.5",
                i > 0 && "-ml-2",
              )}
              style={{ zIndex: shown.length - i }}
            >
              <Avatar
                seed={name}
                label={name}
                initials={firstInitial(name)}
                className="size-6 rounded-lg text-[10px]"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2 px-2 py-1.5">
            <Avatar seed={name} label={name} className="size-7 rounded-lg text-[10px]" />
            <span className="text-xs font-medium text-popover-foreground">{name}</span>
          </TooltipContent>
        </Tooltip>
      ))}
      {overflow > 0 && (
        <CallParticipantsOverflow participants={props.participants} overflow={overflow} />
      )}
    </span>
  );
}

/** The "+N" chip: a tooltip on hover, and a click opens a dialog listing every
 *  participant. */
function CallParticipantsOverflow(props: { participants: string[]; overflow: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="call-participants-more"
            onClick={() => setOpen(true)}
            style={{ zIndex: 0 }}
            className="relative -ml-2 grid size-6 place-items-center rounded-lg bg-accent text-[9px] font-semibold text-text-dim ring-2 ring-element transition-transform hover:z-20 hover:-translate-y-0.5 hover:text-foreground"
          >
            +{props.overflow}
          </button>
        </TooltipTrigger>
        <TooltipContent>Show all {props.participants.length} participants</TooltipContent>
      </Tooltip>
      <DialogContent data-testid="call-participants-modal" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Call participants</DialogTitle>
          <DialogDescription>
            {props.participants.length} people were in this call.
          </DialogDescription>
        </DialogHeader>
        <ul className="-mx-1 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {props.participants.map((name, i) => (
            <li
              key={`${i}-${name}`}
              data-testid="call-participant-row"
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <Avatar seed={name} label={name} className="size-8" />
              <span className="text-sm text-foreground">{name}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

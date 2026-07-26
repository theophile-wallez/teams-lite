import { useState } from "react";
import { Phone, PhoneMissed } from "lucide-react";
import { formatCallEvent, type CallSystemEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";
import { Avatar, type AvatarPhoto } from "./avatar";
import { SystemLine } from "./system-line";
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
 * A system line for a call/meeting event — e.g. "Call ended · 10 min" followed by an
 * overlapping stack of participant avatars — rendered in the timeline in place of a
 * chat bubble (see {@link SystemLine} for the pill it sits in). Each avatar reveals
 * the participant on hover; when there are more than five, a "+N" chip opens a
 * dialog with the full roster.
 */
export function CallEventLine(props: { event: CallSystemEvent }) {
  const { event } = props;
  const missed = event.event === "missed";
  const participants = event.participants ?? [];
  return (
    <SystemLine
      kind={event.kind}
      icon={missed ? PhoneMissed : Phone}
      label={formatCallEvent(event)}
      alert={missed}
      data={{ "data-call-event": event.event }}
    >
      {participants.length > 0 && (
        <CallParticipants participants={participants} mris={event.participant_mris} />
      )}
    </SystemLine>
  );
}

/** A call participant: display name plus (optional) MRI for their real photo. */
type Participant = { name: string; mri: string };

/** An {@link AvatarPhoto} for a participant's MRI, or `undefined` when unknown so
 *  the avatar keeps its generated person coin. */
function participantPhoto(mri: string): AvatarPhoto | undefined {
  return mri ? { kind: "user", id: mri } : undefined;
}

/** The overlapping avatar stack (capped at {@link MAX_AVATARS}) plus a "+N"
 *  overflow chip. Ringed in the pill's own colour so the avatars read as a clean
 *  cut-out stack. Shared by the timeline call line and the incoming-call banner.
 *  `mris` (when present) is aligned index-for-index with `participants` and lets
 *  each avatar show that person's real photo; a missing slot stays a coin. */
export function CallParticipants(props: { participants: string[]; mris?: string[] }) {
  const people: Participant[] = props.participants.map((name, i) => ({
    name,
    mri: props.mris?.[i] ?? "",
  }));
  const shown = people.slice(0, MAX_AVATARS);
  const overflow = people.length - shown.length;
  return (
    <span data-testid="call-participants" className="flex items-center">
      {shown.map(({ name, mri }, i) => (
        <Tooltip key={`${i}-${name}`}>
          <TooltipTrigger asChild>
            <span
              data-testid="call-avatar"
              className={cn(
                "relative rounded-full ring-2 ring-element transition-transform hover:z-20 hover:-translate-y-0.5",
                i > 0 && "-ml-2",
              )}
              style={{ zIndex: shown.length - i }}
            >
              <Avatar
                seed={mri || name}
                label={name}
                initials={firstInitial(name)}
                fallback="person"
                photo={participantPhoto(mri)}
                className="size-6 text-[10px]"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent className="flex items-center gap-2 px-2 py-1.5">
            <Avatar
              seed={mri || name}
              label={name}
              fallback="person"
              photo={participantPhoto(mri)}
              className="size-7 text-[10px]"
            />
            <span className="text-xs font-medium text-popover-foreground">{name}</span>
          </TooltipContent>
        </Tooltip>
      ))}
      {overflow > 0 && <CallParticipantsOverflow people={people} overflow={overflow} />}
    </span>
  );
}

/** The "+N" chip: a tooltip on hover, and a click opens a dialog listing every
 *  participant (each with their real photo when known). */
function CallParticipantsOverflow(props: { people: Participant[]; overflow: number }) {
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
            className="relative -ml-2 grid size-6 place-items-center rounded-full bg-accent text-[9px] font-semibold text-text-dim ring-2 ring-element transition-transform hover:z-20 hover:-translate-y-0.5 hover:text-foreground"
          >
            +{props.overflow}
          </button>
        </TooltipTrigger>
        <TooltipContent>Show all {props.people.length} participants</TooltipContent>
      </Tooltip>
      <DialogContent data-testid="call-participants-modal" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Call participants</DialogTitle>
          <DialogDescription>{props.people.length} people were in this call.</DialogDescription>
        </DialogHeader>
        <ul className="-mx-1 flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {props.people.map(({ name, mri }, i) => (
            <li
              key={`${i}-${name}`}
              data-testid="call-participant-row"
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
            >
              <Avatar
                seed={mri || name}
                label={name}
                fallback="person"
                photo={participantPhoto(mri)}
                className="size-8"
              />
              <span className="text-sm text-foreground">{name}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

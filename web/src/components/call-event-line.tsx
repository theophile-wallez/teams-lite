import { Phone, PhoneMissed } from "lucide-react";
import { formatCallEvent, type SystemEvent } from "~/lib/protocol";
import { cn } from "~/lib/utils";

/**
 * A centered, muted system line for a call/meeting event — e.g.
 * "Call ended · 10 min · 5 participants" — rendered in the timeline in place of a
 * chat bubble. Mirrors Teams' inline call notices: no avatar, no sender, no
 * mine/theirs side. Hovering shows the participant names.
 */
export function CallEventLine(props: { event: SystemEvent }) {
  const { event } = props;
  const missed = event.event === "missed";
  const Icon = missed ? PhoneMissed : Phone;
  const names = event.participants ?? [];
  return (
    <div
      data-testid="system-event"
      data-system-event={event.kind}
      data-call-event={event.event}
      className="my-2 flex justify-center"
    >
      <span
        title={names.length > 0 ? names.join(", ") : undefined}
        className={cn(
          "flex items-center gap-1.5 rounded-full bg-element px-3 py-1 text-xs",
          missed ? "text-destructive" : "text-text-faint",
        )}
      >
        <Icon className="size-3 shrink-0" strokeWidth={1.8} />
        {formatCallEvent(event)}
      </span>
    </div>
  );
}

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "~/lib/utils";

/**
 * The shared chrome of a system line: a centered, muted pill carrying a small glyph
 * and one short sentence, with room for trailing content (a call's participant
 * avatars). Every system event — a call notice, a membership or pin change — wears
 * it, so the timeline reads consistently whatever the event is. Mirrors Teams' own
 * inline notices: no sender, no mine/theirs side.
 *
 * `data` adds row-level data attributes (the call line's `data-call-event`), which
 * keeps each kind addressable from tests without teaching this component about it.
 */
export function SystemLine(props: {
  /** The `SystemEvent.kind` this line renders, surfaced as `data-system-event`. */
  kind: string;
  icon: LucideIcon;
  label: string;
  /** Draw attention rather than blend in (a missed call). */
  alert?: boolean;
  data?: Record<string, string>;
  children?: ReactNode;
}) {
  const { icon: Icon } = props;
  return (
    <div
      data-testid="system-event"
      data-system-event={props.kind}
      {...props.data}
      className="my-2 flex justify-center"
    >
      <span
        className={cn(
          "flex items-center gap-2 rounded-full bg-element px-3 py-1 text-xs",
          props.alert ? "text-destructive" : "text-text-faint",
        )}
      >
        <span className="flex items-center gap-1.5">
          <Icon className="size-3 shrink-0" strokeWidth={1.8} aria-hidden />
          {props.label}
        </span>
        {props.children}
      </span>
    </div>
  );
}

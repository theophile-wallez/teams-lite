import {
  isCallEvent,
  isMeetingEvent,
  isThreadActivityEvent,
  type SystemEvent,
} from "~/lib/protocol";
import { CallEventLine } from "./call-event-line";
import { MeetingEventLine } from "./meeting-event-line";
import { ThreadActivityLine } from "./thread-activity-line";

/**
 * A message that is really a system/activity event, rendered in the timeline as a
 * centered line instead of a chat bubble: a call notice, a membership or pin
 * change, a scheduled meeting. The single place the message pane routes
 * `system_event` through — each kind then owns its own line (see {@link SystemLine}
 * for the shared chrome).
 *
 * An event of a kind this client does not know renders NOTHING. The backend gains
 * kinds over time, and a client that predates one has nothing true to say about it —
 * printing its raw payload as a bubble is exactly the bug these lines exist to fix.
 */
export function SystemEventLine(props: { event: SystemEvent }) {
  const { event } = props;
  if (isCallEvent(event)) return <CallEventLine event={event} />;
  if (isThreadActivityEvent(event)) return <ThreadActivityLine event={event} />;
  if (isMeetingEvent(event)) return <MeetingEventLine event={event} />;
  return null;
}

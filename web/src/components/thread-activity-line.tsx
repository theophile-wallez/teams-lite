import { useEffect, useState } from "react";
import { PinIcon, PinOffIcon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { formatThreadActivity, type ThreadActivityEvent } from "~/lib/protocol";
import { SystemLine } from "./system-line";
import { useController } from "./controller-context";

/** The glyph for each activity we can label. An event we have no words for never
 *  reaches here (see {@link formatThreadActivity}), so the fallback is only there
 *  to keep this total. */
const ACTIVITY_ICON = {
  member_added: UserAdd01Icon,
  pinned: PinIcon,
  unpinned: PinOffIcon,
} as const;

/**
 * Resolve the display names of the people a thread activity is about.
 *
 * Teams sends `friendlyname` empty on almost every membership frame, so the MRI is
 * the only identity that actually arrives — the same situation the call line is in,
 * where the MRI is what fetches the participant's photo. Here it fetches the name
 * instead, through the directory lookup the person card already uses (cached per
 * session by the controller, so a repeated member costs nothing). A name Teams DID
 * send is authoritative and never looked up.
 *
 * Returns the names index-aligned with `mris`, with `""` for anyone still unknown —
 * the label then counts them instead of naming them.
 */
function useMemberNames(names: string[], mris: string[]): string[] {
  const controller = useController();
  const [resolved, setResolved] = useState<Record<string, string>>({});
  // A stable key so the effect only re-runs when the actual set of MRIs changes.
  const missing = mris.filter((mri, i) => mri && !(names[i] ?? "").trim());
  const key = missing.join("\n");

  useEffect(() => {
    if (missing.length === 0) return;
    let alive = true;
    for (const mri of missing) {
      controller
        .loadProfile(mri)
        .then((profile) => {
          const name = profile?.display_name?.trim();
          if (alive && name) setResolved((prev) => ({ ...prev, [mri]: name }));
        })
        .catch(() => {
          /* no name to show — the label counts this person instead */
        });
    }
    return () => {
      alive = false;
    };
    // `missing` is captured via its stable string `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, key]);

  // The two lists are index-aligned but either can be the shorter one, so the walk
  // covers both: a member Teams named without an MRI keeps their name, and one it
  // only identified by MRI gets the resolved one.
  const count = Math.max(names.length, mris.length);
  return Array.from({ length: count }, (_, i) => {
    const given = (names[i] ?? "").trim();
    return given || resolved[mris[i] ?? ""] || "";
  });
}

/**
 * A centered, muted system line for a Teams thread activity — "Nathan CAPIAUX was
 * added to the chat", "A message was pinned" — rendered in the timeline in place of
 * a chat bubble, exactly like a call event. These arrive as machine frames whose
 * author is the thread itself, so before they were understood they showed up as a
 * bubble of raw JSON attributed to a URL.
 *
 * An activity with no sentence to its name renders nothing at all.
 */
export function ThreadActivityLine(props: { event: ThreadActivityEvent }) {
  const { event } = props;
  const names = useMemberNames(event.members ?? [], event.member_mris ?? []);
  const label = formatThreadActivity(event, names);
  if (!label) return null;
  const icon = ACTIVITY_ICON[event.event as keyof typeof ACTIVITY_ICON] ?? UserAdd01Icon;
  return (
    <SystemLine
      kind={event.kind}
      icon={icon}
      label={label}
      data={{ "data-thread-activity": event.event }}
    />
  );
}

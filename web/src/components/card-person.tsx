import { personFace, type TrackerPerson } from "~/lib/tracker-people";
import { Avatar } from "./avatar";

/**
 * Who a link-preview card is about, on the card's own faint meta line.
 *
 * ONE component for both trackers, because it is one fact: a colleague the user's own Teams
 * knows is drawn AS that colleague — their real face and the name this app calls them — while
 * somebody only the tracker knows keeps the tracker's word over tinted initials (see
 * `personFace`). A GitLab card naming its author one way and a Linear card naming its
 * assignee another would be two answers to "who is this?" on two cards in the same thread.
 *
 * The face is a Teams read, through the backend's own `fetch_avatar` like every other avatar
 * in this app: it tells the tracker nothing, and the tracker's own `avatar_url` is never
 * requested — drawing a card must make no request to the instance that holds it.
 */
export function CardPerson(props: { person: TrackerPerson; testId?: string }) {
  const face = personFace(props.person);
  return (
    <span
      data-testid={props.testId ?? "card-person"}
      data-person={face.label}
      className="flex min-w-0 items-center gap-1"
    >
      <Avatar
        seed={face.seed}
        label={face.label}
        photo={face.photo}
        // One letter: the avatar is 14px, which is two initials' worth of pixels for one.
        initials={face.label.slice(0, 1).toUpperCase()}
        fallback="person"
        className="size-3.5 text-[8px]"
      />
      <span className="min-w-0 truncate">{face.label}</span>
    </span>
  );
}

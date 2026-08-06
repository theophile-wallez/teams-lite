// Who a tracker's user is, and how this app draws them.
//
// A mirror of `src/tracker_people.rs`: the shape both trackers spell a person in, plus the
// identity the BACKEND resolves onto it — the colleague in the user's own Teams, matched by
// their real name (see § A tracker user who is also a colleague in CLAUDE.md).
//
// Pure: no DOM, no network, no React. Two surfaces read it — the merge-request page and the
// two link-preview cards — and they must agree, because a colleague drawn one way on a card
// and another way on the page is the bug this file exists to make impossible.

/** One person a tracker names, plus the one field the backend adds on the way out
 *  (`with_teams_people` in src/bin/server.rs). Mirrors `tracker_people::Person`. */
export type TrackerPerson = {
  name: string;
  username: string;
  avatar_url?: string;
  /** Who this tracker user is in the user's own Teams, when the backend could prove it by
   *  their real name (`tracker_people::TeamsPerson`). `undefined` for a bot, for a colleague
   *  this machine has never been told about, and on a backend too old to say — all three read
   *  the same way, which is that the tracker's own words are what the surface has. */
  teams?: { mri: string; name: string };
};

/** What one person is DRAWN as: the tint's seed, the name, and the picture to load — one
 *  decision, in one place, for a sidebar row, the people on a merge request, the author of
 *  every comment and a preview card.
 *
 *  Its whole job is that a colleague looks the same here as in a chat:
 *
 *  - **A resolved person is drawn as that person.** Their Teams name — which is the nickname
 *    the user gave them when they gave one, resolved server-side like every other name in
 *    this app — and their Teams photo, which `fetch_avatar` serves from the user's own custom
 *    picture first. No photo simply leaves the tinted initials, exactly as everywhere else.
 *  - **The seed is their MRI**, which is what every other avatar in this app seeds on
 *    (a read receipt, the typing line, an @mention row), so one person is one colour across
 *    the whole app rather than one colour per surface.
 *  - **Somebody only the tracker knows keeps the tracker's words**, and asks for no picture:
 *    `avatar_url` is never fetched (see `tracker_people::Person`). */
export type TrackerFace = {
  seed: string;
  label: string;
  photo?: { kind: "user"; id: string };
};

export function personFace(person: TrackerPerson): TrackerFace {
  const teams = person.teams?.mri ? person.teams : undefined;
  if (teams) {
    return {
      seed: teams.mri,
      label: teams.name || person.name || person.username,
      photo: { kind: "user", id: teams.mri },
    };
  }
  return {
    seed: person.username || person.name,
    label: person.name || person.username,
  };
}

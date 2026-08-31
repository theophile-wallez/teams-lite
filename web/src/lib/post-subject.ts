/**
 * A channel post's TITLE — the line an announcement puts above its body.
 *
 * A CHANNEL post is titled and a CHAT message is not: that is Teams' own split, and it is
 * the whole differentiation this module exists for. A chat has no such field anywhere in
 * its client, and a channel's composer offers "Add a subject" on a new post.
 *
 * The title travels as `properties.subject` and never as words in the body (see
 * `teams_send::SUBJECT`, and `parse_thread` in src/teams_read.rs, which is what has always
 * drawn an inbound one as the thread's heading).
 */

/** How long a title may get. The backend's own bound (`teams_send::MAX_SUBJECT_CHARS`),
 *  spelled here so the field REFUSES the 251st character rather than collecting a title
 *  the send would be refused for. Measured on this tenant's store, real titles run from 11
 *  to 108 characters. */
export const POST_SUBJECT_MAX_CHARS = 250;

/**
 * Whether the composer offers a title at all.
 *
 * Three conditions, and each is Teams' own:
 *   * a CHANNEL. A chat message has no title, so a field there would collect a line the
 *     send is refused for — and it would claim a distinction the surface does not have.
 *   * a NEW post. A REPLY is part of a thread that is already named, so the backend
 *     refuses a titled one (`teams_send::parse_subject`) — and a field the send refuses is
 *     worse than no field.
 *   * a channel drawn as POSTS. Teams offers "Add a subject" in a channel whose history is a
 *     wall of titled announcements and NOT in one drawn as a running conversation: there the
 *     composer is a chat's own box, because a post in it is a chat message that happens to be
 *     able to hold a thread (see § A CHANNEL IS DRAWN THE WAY TEAMS DRAWS IT). A field there
 *     would draw a heading nothing else on that surface has — and the post it titled would
 *     read as an announcement in a conversation.
 *
 * It is the one rule, read in both places it decides something: whether the field is drawn,
 * and whether what is in it travels. So a title typed before the reader pressed Reply is
 * simply not sent, and it is still there when they cancel the reply.
 *
 * The LAYOUT is optional because it is READ from the tenant and arrives with the history: a
 * channel this page has not been told about yet, and a machine that could not reach the
 * tenant, both take the posts answer — which is the surface this app drew before the layout
 * was read at all, and the one whose composer has always offered a title.
 */
export function postSubjectOffered(where: {
  isChannel: boolean;
  replying: boolean;
  layout?: "posts" | "conversation";
}): boolean {
  return where.isChannel && !where.replying && where.layout !== "conversation";
}

/** What the title field's contents become on the wire: the trimmed line, or nothing at
 *  all. Empty means the property is never written, which keeps an untitled post
 *  byte-identical to what this app sent before the field existed. */
export function outboundSubject(raw: string): string | undefined {
  const clean = raw.trim();
  return clean.length > 0 ? clean : undefined;
}

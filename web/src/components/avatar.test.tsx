// Which picture an avatar loads for a conversation, and what it draws when there is
// none. Both rules are per-kind and easy to get subtly wrong: the two picture
// sources are addressed differently (a person by MRI — a profile-photo lookup — and
// a group chat by URL — hosted content), and the no-picture glyph states the
// thread's origin. Every render site goes through `conversationPhoto` and
// `conversationFallback`, so these pin both mappings once.
import { describe, it, expect } from "vitest";
import {
  conversationFallback,
  conversationPhoto,
  mailAvatarInitials,
  mailAvatarSeed,
} from "./avatar";
import type { Conversation, MailAddress } from "~/lib/protocol";

function conv(patch: Partial<Conversation>): Conversation {
  return {
    id: "19:x@thread.v2",
    name: "Chat",
    last_message_time: 0,
    kind: "group",
    last_message_preview: "",
    last_message_sender: "",
    last_message_from_me: false,
    is_read: true,
    is_muted: false,
    is_pinned: false,
    is_hidden: false,
    thread_type: "chat",
    draft: "",
    ...patch,
  };
}

const PICTURE =
  "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frs-d4-abc/views/avatar_fullsize";

describe("conversationPhoto", () => {
  it("loads the other party's profile photo for a 1:1", () => {
    const photo = conversationPhoto(
      conv({ kind: "one_on_one", avatar_mri: "8:orgid:leonor" }),
    );
    expect(photo).toEqual({ kind: "user", id: "8:orgid:leonor" });
  });

  it("loads a group chat's own picture by URL", () => {
    const photo = conversationPhoto(conv({ picture_url: PICTURE }));
    expect(photo).toEqual({ kind: "chat", url: PICTURE });
  });

  it("loads nothing when there is no picture, so the initials stand", () => {
    expect(conversationPhoto(conv({}))).toBeUndefined();
    // Empty strings are what the backend sends for "none" — not a fetchable id.
    expect(conversationPhoto(conv({ avatar_mri: "", picture_url: "" }))).toBeUndefined();
    // A store row written before the field existed carries neither key.
    expect(conversationPhoto(conv({ kind: "notes" }))).toBeUndefined();
  });
});

describe("conversationFallback", () => {
  it("draws a camera for a thread a meeting or a call created", () => {
    expect(conversationFallback(conv({ thread_type: "meeting" }))).toBe("meeting");
    // The id alone is enough, so a row synced before `thread_type` existed still
    // reads as a meeting.
    expect(
      conversationFallback(conv({ id: "19:meeting_YWI2Y2E5MDI@thread.v2", thread_type: "" })),
    ).toBe("meeting");
  });

  it("draws two people for a chat somebody started by writing in it", () => {
    expect(conversationFallback(conv({}))).toBe("group");
    // A group thread the backend could not classify at all.
    expect(conversationFallback(conv({ kind: "unknown", thread_type: "" }))).toBe("group");
  });

  it("leaves a single human and Notes as they were", () => {
    expect(conversationFallback(conv({ kind: "one_on_one" }))).toBe("person");
    expect(conversationFallback(conv({ kind: "notes", id: "48:notes" }))).toBe("initials");
  });
});

// The face of a sender the Teams directory cannot name — an external one, a shared
// mailbox — is all a reader gets, so the two things it can say are pinned here: one
// colour per organisation, and initials that name the organisation rather than the
// mailbox in front of the "@".
describe("a mail avatar with no photo behind it", () => {
  const mail = (name: string, address: string): MailAddress => ({ name, address });

  it("seeds its tint from the domain, so one organisation is one colour", () => {
    // The mailbox in front of the "@" and the subdomain behind it are both routing:
    // the reader sees one sender, so both addresses seed the same tint.
    expect(mailAvatarSeed(mail("Tracker", "notifications@tracker.dev"), "id")).toBe("tracker.dev");
    expect(mailAvatarSeed(mail("", "security@updates.tracker.dev"), "id")).toBe("tracker.dev");
    expect(mailAvatarSeed(mail("", "noreply@md.getsentry.com"), "id")).toBe("getsentry.com");
    expect(mailAvatarSeed(mail("", "hello@shop.example.co.uk"), "id")).toBe("example.co.uk");
    // Case never splits a domain in two.
    expect(mailAvatarSeed(mail("", "Noreply@Tracker.DEV"), "id")).toBe("tracker.dev");
    // No domain to group by: the address itself, then the mail's own id, so two
    // nameless senders still differ.
    expect(mailAvatarSeed(mail("Nobody", "not-an-address"), "id")).toBe("not-an-address");
    expect(mailAvatarSeed(mail("", ""), "AAMk-1==")).toBe("AAMk-1==");
  });

  it("takes its initials from the display name when the mail carries one", () => {
    expect(mailAvatarInitials(mail("Ada Lovelace", "ada@example.com"))).toBe("AL");
    expect(mailAvatarInitials(mail("Tracker", "notifications@tracker.dev"))).toBe("TR");
  });

  it("reads a nameless machine address as its organisation", () => {
    // "NO" on every no-reply@ in the mailbox is what this avoids.
    expect(mailAvatarInitials(mail("", "no-reply@sns.amazonaws.com"))).toBe("AM");
    expect(mailAvatarInitials(mail("", "noreply@md.getsentry.com"))).toBe("GE");
    expect(mailAvatarInitials(mail("", "security@updates.tracker.dev"))).toBe("TR");
    // A shared mailbox names a function, not a person.
    expect(mailAvatarInitials(mail("", "adq_lab_eng@example.com"))).toBe("EX");
    // A two-part public suffix is not a name.
    expect(mailAvatarInitials(mail("", "hello@shop.example.co.uk"))).toBe("EX");
    // Nothing to read at all keeps the faceless coin's "?" (see `Avatar`).
    expect(mailAvatarInitials(mail("", ""))).toBe("?");
  });

  it("reads a nameless address that spells a person as that person", () => {
    // A corporate mailbox is "first.last", and those two words name somebody even
    // when the mail carries no display name at all.
    expect(mailAvatarInitials(mail("", "reva.singh@partner.example.org"))).toBe("RS");
    expect(mailAvatarInitials(mail("", "Alexandre.Agaud@example.com"))).toBe("AA");
    // One word, three words, or a separator that is not a dot is not a name.
    expect(mailAvatarInitials(mail("", "alexandre@example.com"))).toBe("EX");
    expect(mailAvatarInitials(mail("", "do.not.reply@example.com"))).toBe("EX");
    expect(mailAvatarInitials(mail("", "mailer-daemon@example.com"))).toBe("EX");
    expect(mailAvatarInitials(mail("", "plat.114@example.com"))).toBe("EX");
  });
});

// Which picture an avatar loads for a conversation, and what it draws when there is
// none. Both rules are per-kind and easy to get subtly wrong: the two picture
// sources are addressed differently (a person by MRI — a profile-photo lookup — and
// a group chat by URL — hosted content), and the no-picture glyph states the
// thread's origin. Every render site goes through `conversationPhoto` and
// `conversationFallback`, so these pin both mappings once.
import { describe, it, expect } from "vitest";
import { conversationFallback, conversationPhoto } from "./avatar";
import type { Conversation } from "~/lib/protocol";

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

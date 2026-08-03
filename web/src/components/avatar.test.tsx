// Which picture an avatar loads for a conversation. The rule is per-kind and easy
// to get subtly wrong, because the two sources are addressed differently: a person
// by MRI (a profile-photo lookup) and a group chat by URL (hosted content). Every
// render site goes through `conversationPhoto`, so these pin the mapping once.
import { describe, it, expect } from "vitest";
import { conversationPhoto } from "./avatar";
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

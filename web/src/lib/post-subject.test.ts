import { describe, expect, it } from "vitest";
import { POST_SUBJECT_MAX_CHARS, outboundSubject, postSubjectOffered } from "./post-subject";

describe("postSubjectOffered", () => {
  it("offers a title on a new channel post and nowhere else", () => {
    expect(postSubjectOffered({ isChannel: true, replying: false })).toBe(true);
    // A chat message has no title in Teams, and the backend would refuse one.
    expect(postSubjectOffered({ isChannel: false, replying: false })).toBe(false);
    // A reply belongs to a thread that is already named — its root post's title.
    expect(postSubjectOffered({ isChannel: true, replying: true })).toBe(false);
    expect(postSubjectOffered({ isChannel: false, replying: true })).toBe(false);
  });
});

describe("outboundSubject", () => {
  it("trims, and an empty title is no property at all", () => {
    expect(outboundSubject("  Ship it  ")).toBe("Ship it");
    // Nothing typed, or only whitespace: the send carries no `subject`, so an untitled
    // post is byte-identical to what this app sent before the field existed.
    expect(outboundSubject("")).toBeUndefined();
    expect(outboundSubject("   \n ")).toBeUndefined();
  });

  it("states the backend's own ceiling, so the field refuses before a send does", () => {
    // `teams_send::MAX_SUBJECT_CHARS`. The two must agree: a field that collected more
    // would earn a refusal for a title the reader had already finished writing.
    expect(POST_SUBJECT_MAX_CHARS).toBe(250);
  });
});

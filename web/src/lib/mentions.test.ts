import { describe, expect, it } from "vitest";
import {
  dedupeCandidates,
  matchMentionCandidates,
  mentionQueryBefore,
  shortenMentionLabel,
  type MentionCandidate,
} from "./mentions";

const PEOPLE: MentionCandidate[] = [
  { mri: "8:orgid:charlotte", name: "Charlotte Dubois" },
  { mri: "8:orgid:theo", name: "Théophile WALLEZ" },
  { mri: "8:orgid:john", name: "John De Doe" },
  { mri: "8:orgid:duncan", name: "Duncan Charles" },
];

describe("mentionQueryBefore", () => {
  it("opens on a bare @ at the start of a block and after a space", () => {
    expect(mentionQueryBefore("@")).toEqual({ query: "", at: 0 });
    expect(mentionQueryBefore("hello @")).toEqual({ query: "", at: 6 });
    expect(mentionQueryBefore("hello @cha")).toEqual({ query: "cha", at: 6 });
  });

  it("keeps matching across one space, so a surname can be typed", () => {
    expect(mentionQueryBefore("@Charlotte Dub")).toEqual({ query: "Charlotte Dub", at: 0 });
  });

  it("is not a mention inside a word — an email address stays text", () => {
    expect(mentionQueryBefore("write to ada@example.com")).toBeNull();
    expect(mentionQueryBefore("a@b")).toBeNull();
  });

  it("closes once the @ is behind a sentence rather than a name", () => {
    expect(mentionQueryBefore("@one two three")).toBeNull();
    expect(mentionQueryBefore(`@${"x".repeat(40)}`)).toBeNull();
    // A lone at-sign followed by a space: the author typed past it.
    expect(mentionQueryBefore("@ ")).toBeNull();
  });

  it("takes the LAST @ in the text, which is the one being typed", () => {
    expect(mentionQueryBefore("hi @john and @cha")).toEqual({ query: "cha", at: 13 });
  });

  it("has no query in ordinary text", () => {
    expect(mentionQueryBefore("")).toBeNull();
    expect(mentionQueryBefore("just some words")).toBeNull();
  });
});

describe("matchMentionCandidates", () => {
  it("offers everybody, in the caller's order, for a bare @", () => {
    expect(matchMentionCandidates(PEOPLE, "").map((p) => p.name)).toEqual(
      PEOPLE.map((p) => p.name),
    );
  });

  it("ranks a leading match above a surname match above a substring", () => {
    expect(matchMentionCandidates(PEOPLE, "char").map((p) => p.name)).toEqual([
      "Charlotte Dubois", // the name starts with it
      "Duncan Charles", // a later word starts with it
    ]);
  });

  it("ignores case and diacritics, so a plain keyboard finds an accented name", () => {
    expect(matchMentionCandidates(PEOPLE, "theo").map((p) => p.name)).toEqual([
      "Théophile WALLEZ",
    ]);
    expect(matchMentionCandidates(PEOPLE, "WALLEZ").map((p) => p.name)).toEqual([
      "Théophile WALLEZ",
    ]);
  });

  it("matches across the space in a full name", () => {
    expect(matchMentionCandidates(PEOPLE, "john de").map((p) => p.name)).toEqual(["John De Doe"]);
  });

  it("offers nobody when nobody matches, and drops a nameless person", () => {
    expect(matchMentionCandidates(PEOPLE, "zzz")).toEqual([]);
    expect(matchMentionCandidates([{ mri: "8:orgid:x", name: "" }], "")).toEqual([]);
  });

  it("caps the list", () => {
    expect(matchMentionCandidates(PEOPLE, "", 2)).toHaveLength(2);
  });
});

describe("shortenMentionLabel", () => {
  it("drops one word per keystroke, from the end", () => {
    // Teams' own behaviour: "John De Doe" -> "John De" -> "John" -> gone.
    expect(shortenMentionLabel("John De Doe")).toBe("John De");
    expect(shortenMentionLabel("John De")).toBe("John");
    expect(shortenMentionLabel("John")).toBeNull();
  });

  it("treats a run of whitespace as one separator", () => {
    expect(shortenMentionLabel("  John   De  Doe ")).toBe("John De");
  });

  it("has nothing to drop in an empty label", () => {
    expect(shortenMentionLabel("")).toBeNull();
    expect(shortenMentionLabel("   ")).toBeNull();
  });
});

describe("dedupeCandidates", () => {
  it("keeps the first of each person and the first name it can find", () => {
    expect(
      dedupeCandidates([
        { mri: "8:orgid:ABC", name: "" },
        { mri: "8:orgid:abc", name: "Ada Lovelace" },
        { mri: "", name: "nobody" },
      ]),
    ).toEqual([{ mri: "8:orgid:ABC", name: "Ada Lovelace" }]);
  });
});

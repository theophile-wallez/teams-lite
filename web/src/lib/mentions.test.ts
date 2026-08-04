import { describe, expect, it } from "vitest";
import type { AgentStatus } from "./agent";
import {
  agentCandidatesFor,
  dedupeCandidates,
  matchAgentCandidates,
  matchMentionCandidates,
  mentionOptionKey,
  mentionOptions,
  mentionQueryBefore,
  shortenMentionLabel,
  type AgentCandidate,
  type MentionCandidate,
} from "./mentions";

const PEOPLE: MentionCandidate[] = [
  { mri: "8:orgid:charlotte", name: "Charlotte Dubois" },
  { mri: "8:orgid:theo", name: "Théophile WALLEZ" },
  { mri: "8:orgid:john", name: "John De Doe" },
  { mri: "8:orgid:duncan", name: "Duncan Charles" },
];

const CLAUDE: AgentCandidate = { backend: "claude", name: "Claude", prefix: "@claude" };
const OPENCODE: AgentCandidate = { backend: "opencode", name: "opencode", prefix: "@opencode" };

/** An `agent_status` with both CLIs installed and one conversation opted in. */
function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    backends: [
      {
        name: "claude",
        prefix: "@claude",
        available: true,
        enabled: true,
        model: null,
        models: [],
      },
      {
        name: "opencode",
        prefix: "@opencode",
        available: true,
        enabled: true,
        model: null,
        models: [],
      },
    ],
    conversations: [{ conversation: "19:on@thread.v2", mode: "reply" }],
    tools: [],
    workspace: "/home/me",
    enabled: true,
    sandbox_conversation: "19:sandbox@thread.v2",
    ...overrides,
  };
}

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

describe("agentCandidatesFor", () => {
  it("offers the installed, enabled agents of an opted-in conversation", () => {
    expect(agentCandidatesFor(status(), "19:on@thread.v2")).toEqual([
      { backend: "claude", name: "Claude", prefix: "@claude" },
      // Each vendor's own casing: Claude is a proper noun, opencode is not.
      { backend: "opencode", name: "opencode", prefix: "@opencode" },
    ]);
  });

  it("offers none in a conversation nobody opted in", () => {
    // The consent gate of the whole feature: a tag there would summon nothing.
    expect(agentCandidatesFor(status(), "19:off@thread.v2")).toEqual([]);
    expect(agentCandidatesFor(status(), null)).toEqual([]);
  });

  it("offers none before the backend has answered, and none from a read-only one", () => {
    expect(agentCandidatesFor(null, "19:on@thread.v2")).toEqual([]);
    expect(agentCandidatesFor(status({ enabled: false }), "19:on@thread.v2")).toEqual([]);
  });

  it("skips a CLI this machine has not got, and one the user switched off", () => {
    const partial = status();
    partial.backends[0]!.available = false;
    partial.backends[1]!.enabled = false;
    expect(agentCandidatesFor(partial, "19:on@thread.v2")).toEqual([]);
  });
});

describe("matchAgentCandidates", () => {
  it("offers every agent for a bare @", () => {
    expect(matchAgentCandidates([CLAUDE, OPENCODE], "")).toEqual([CLAUDE, OPENCODE]);
  });

  it("matches the name and the prefix's own spelling, ignoring case", () => {
    expect(matchAgentCandidates([CLAUDE, OPENCODE], "cl")).toEqual([CLAUDE]);
    expect(matchAgentCandidates([CLAUDE, OPENCODE], "Claude")).toEqual([CLAUDE]);
    expect(matchAgentCandidates([CLAUDE, OPENCODE], "OPEN")).toEqual([OPENCODE]);
  });

  it("offers nobody for a query that names neither", () => {
    expect(matchAgentCandidates([CLAUDE, OPENCODE], "charlotte")).toEqual([]);
  });
});

describe("mentionOptions", () => {
  const both = (query: string, atMessageStart: boolean) =>
    mentionOptions({ people: PEOPLE, agents: [CLAUDE, OPENCODE], query, atMessageStart });

  it("puts the agents above the people", () => {
    expect(both("", true).map(mentionOptionKey).slice(0, 3)).toEqual([
      "agent:claude",
      "agent:opencode",
      "person:8:orgid:charlotte",
    ]);
  });

  it("offers no agent once the @ is not the start of the message", () => {
    // The backend summons an agent from the prefix a message OPENS with, so a tag
    // anywhere else would look like a run that never happened.
    expect(both("", false).every((option) => option.kind === "person")).toBe(true);
    expect(both("cl", false)).toEqual([]);
  });

  it("caps the whole list, agents included", () => {
    const options = mentionOptions({
      people: PEOPLE,
      agents: [CLAUDE, OPENCODE],
      query: "",
      atMessageStart: true,
      limit: 3,
    });
    expect(options.map(mentionOptionKey)).toEqual([
      "agent:claude",
      "agent:opencode",
      "person:8:orgid:charlotte",
    ]);
  });

  it("keeps the two kinds of key apart", () => {
    expect(mentionOptionKey({ kind: "agent", agent: CLAUDE })).toBe("agent:claude");
    expect(mentionOptionKey({ kind: "person", person: PEOPLE[0]! })).toBe(
      "person:8:orgid:charlotte",
    );
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

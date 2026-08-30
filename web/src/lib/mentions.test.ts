import { describe, expect, it } from "vitest";
import type { AgentStatus } from "./agent";
import type { AgentPersona } from "./agent-persona";
import {
  agentCandidatesFor,
  channelMentionCandidate,
  dedupeCandidates,
  defaultAgentCandidatesFor,
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

const CLAUDE: AgentCandidate = {
  backend: "claude",
  name: "Claude",
  prefix: "@claude",
  persona: null,
};
const OPENCODE: AgentCandidate = {
  backend: "opencode",
  name: "opencode",
  prefix: "@opencode",
  persona: null,
};
/** One of the user's own CUSTOM AGENTS, as `agent_status` publishes it. */
const BEBOU: AgentPersona = {
  name: "bebou",
  label: "Bebou",
  prefix: "@bebou",
  backend: "claude",
  model: null,
  preprompt: "/bebou",
  has_avatar: true,
  added_ms: 1,
  updated_ms: 1,
};
/** The row {@link BEBOU} becomes in the "@" list. */
const BEBOU_ROW: AgentCandidate = {
  backend: "claude",
  name: "Bebou",
  prefix: "@bebou",
  persona: "bebou",
};

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
      CLAUDE,
      // Each vendor's own casing: Claude is a proper noun, opencode is not.
      OPENCODE,
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

  it("offers the user's own custom agents AFTER the providers", () => {
    // The providers are a fixed short list a reader learns once; the personas grow. A menu
    // whose first row moved as agents were added would have to be read every time.
    expect(agentCandidatesFor(status({ personas: [BEBOU] }), "19:on@thread.v2")).toEqual([
      CLAUDE,
      OPENCODE,
      BEBOU_ROW,
    ]);
  });

  it("offers a custom agent only where its own provider would answer", () => {
    // `@bebou` runs Claude Code, so everything true of `@claude` is true of it: a CLI this
    // machine has not got, a provider switched off, and a conversation nobody opted in each
    // take the row away. A row that summons nothing is the lie this list exists to avoid.
    const missing = status({ personas: [BEBOU] });
    missing.backends[0]!.available = false;
    expect(agentCandidatesFor(missing, "19:on@thread.v2")).toEqual([OPENCODE]);

    const off = status({ personas: [BEBOU] });
    off.backends[0]!.enabled = false;
    expect(agentCandidatesFor(off, "19:on@thread.v2")).toEqual([OPENCODE]);

    expect(agentCandidatesFor(status({ personas: [BEBOU] }), "19:off@thread.v2")).toEqual([]);
  });

  it("offers none from a backend too old to publish any", () => {
    // `personas` is absent there, and the feature then behaves exactly as it did before it
    // existed rather than throwing on a missing field.
    const older = status();
    delete older.personas;
    expect(agentCandidatesFor(older, "19:on@thread.v2")).toEqual([CLAUDE, OPENCODE]);
  });
});

describe("defaultAgentCandidatesFor", () => {
  // What a message's ⋯ menu offers: one row, the provider the user chose in Settings —
  // while the composer's own "@" (agentCandidatesFor, above) still offers both.
  it("offers the default provider alone", () => {
    expect(defaultAgentCandidatesFor(status(), "19:on@thread.v2")).toEqual([CLAUDE]);
    expect(
      defaultAgentCandidatesFor(status({ default_provider: "opencode" }), "19:on@thread.v2"),
    ).toEqual([OPENCODE]);
  });

  it("keeps every gate the wider list applies", () => {
    // It narrows the list; it can never widen it.
    expect(defaultAgentCandidatesFor(status(), "19:off@thread.v2")).toEqual([]);
    expect(defaultAgentCandidatesFor(status({ enabled: false }), "19:on@thread.v2")).toEqual([]);
    expect(defaultAgentCandidatesFor(null, "19:on@thread.v2")).toEqual([]);
  });

  it("never grows a row for a custom agent", () => {
    // This menu is a column of actions on one message. The composer's "@" offers the user's
    // own agents because that list is what they are reading while they type; a row per agent
    // HERE would turn a message menu into a directory of programs.
    expect(
      defaultAgentCandidatesFor(status({ personas: [BEBOU] }), "19:on@thread.v2"),
    ).toEqual([CLAUDE]);
  });

  it("offers the other one when the default itself would never answer", () => {
    // A row that summons nothing is the one thing worse than two rows.
    const missing = status({ default_provider: "claude" });
    missing.backends[0]!.available = false;
    expect(defaultAgentCandidatesFor(missing, "19:on@thread.v2")).toEqual([OPENCODE]);
  });
});

describe("matchAgentCandidates", () => {
  it("finds a custom agent by its label and by its address", () => {
    // "@Beb" is how somebody looks for the agent they named; "@bebou" is what they type when
    // they already know it. Both are the same row.
    expect(matchAgentCandidates([CLAUDE, BEBOU_ROW], "Beb")).toEqual([BEBOU_ROW]);
    expect(matchAgentCandidates([CLAUDE, BEBOU_ROW], "bebou")).toEqual([BEBOU_ROW]);
  });

  it("does not offer a custom agent for the name of the provider it runs", () => {
    // Otherwise "@claude" would offer every agent that happens to run on Claude Code, which
    // buries the provider's own row under the user's.
    expect(matchAgentCandidates([CLAUDE, BEBOU_ROW], "claude")).toEqual([CLAUDE]);
  });

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

const CHANNEL: MentionCandidate = {
  mri: "19:eng-incidents@thread.tacv2",
  name: "Incidents",
  kind: "channel",
};

describe("mentionOptions", () => {
  const both = (query: string) =>
    mentionOptions({ targets: PEOPLE, agents: [CLAUDE, OPENCODE], query });

  it("puts the agents above the people", () => {
    expect(both("").map(mentionOptionKey).slice(0, 3)).toEqual([
      "agent:claude",
      "agent:opencode",
      "person:8:orgid:charlotte",
    ]);
  });

  it("offers the agents wherever the @ stands", () => {
    // The backend reads an address anywhere in the message, so a row mid-sentence
    // summons the agent exactly as one at the front does.
    expect(both("").map(mentionOptionKey).slice(0, 2)).toEqual(["agent:claude", "agent:opencode"]);
    expect(both("cl").map(mentionOptionKey)).toEqual(["agent:claude"]);
  });

  it("caps the whole list, agents included", () => {
    const options = mentionOptions({
      targets: PEOPLE,
      agents: [CLAUDE, OPENCODE],
      query: "",
      limit: 3,
    });
    expect(options.map(mentionOptionKey)).toEqual([
      "agent:claude",
      "agent:opencode",
      "person:8:orgid:charlotte",
    ]);
  });

  it("keeps the three kinds of key apart", () => {
    expect(mentionOptionKey({ kind: "agent", agent: CLAUDE })).toBe("agent:claude");
    expect(mentionOptionKey({ kind: "person", person: PEOPLE[0]! })).toBe(
      "person:8:orgid:charlotte",
    );
    expect(mentionOptionKey({ kind: "channel", channel: CHANNEL })).toBe(
      "channel:19:eng-incidents@thread.tacv2",
    );
  });

  it("draws the CHANNEL as its own kind, never as a person", () => {
    // The row must not be a person: `Avatar` would seed tinted initials from a THREAD id,
    // which is a face for a colleague who does not exist. The candidate carries what it is,
    // so the option does too.
    const options = mentionOptions({ targets: [CHANNEL, ...PEOPLE], agents: [], query: "" });
    expect(options[0]).toEqual({ kind: "channel", channel: CHANNEL });
    expect(options.slice(1).every((o) => o.kind === "person")).toBe(true);
  });

  it("offers the channel FIRST on a bare @, and ranks it by name once anything is typed", () => {
    // First because the caller puts it first and the matcher is stable: one fixed row a
    // reader learns once, above a list of people that grows. And it is found by its own
    // name like everybody else — never by a person's.
    const list = { targets: [CHANNEL, ...PEOPLE], agents: [] as AgentCandidate[] };
    expect(mentionOptions({ ...list, query: "" })[0]!.kind).toBe("channel");
    expect(mentionOptions({ ...list, query: "Inc" }).map(mentionOptionKey)).toEqual([
      "channel:19:eng-incidents@thread.tacv2",
    ]);
    expect(
      mentionOptions({ ...list, query: "Charl" }).every((o) => o.kind === "person"),
    ).toBe(true);
  });
});

describe("channelMentionCandidate", () => {
  const conversationId = "19:eng-incidents@thread.tacv2";

  it("names the channel by its OWN thread id, which is what the backend checks", () => {
    // Measured on this tenant: 176 of 177 real channel mentions name the very thread their
    // message was posted in, so the mri is the conversation and nothing is invented here.
    expect(channelMentionCandidate({ conversationId, name: "Incidents", isChannel: true })).toEqual(
      { mri: conversationId, name: "Incidents", kind: "channel" },
    );
  });

  it("offers nothing where there is no channel to name", () => {
    // A chat has none — and the backend refuses one there whatever a page offers, so this
    // is the page agreeing with that rail rather than a second, softer copy of it.
    expect(
      channelMentionCandidate({
        conversationId: "19:abc@thread.v2",
        name: "Design crew",
        isChannel: false,
      }),
    ).toBeNull();
    // …and nothing without an id or a name: a row showing a thread id is a row nobody can
    // pick, which is the rule that already keeps an unnamed colleague out of the list.
    expect(channelMentionCandidate({ conversationId, name: "  ", isChannel: true })).toBeNull();
    expect(channelMentionCandidate({ conversationId: null, name: "x", isChannel: true })).toBeNull();
  });

  it("checks the id's own shape rather than trusting the caller's flag", () => {
    // This is the one function that decides whether the row is offered, so it has to answer
    // the way the backend does: a page that offered a channel mention the backend refuses
    // would be drawing a control whose press reports a refusal.
    for (const id of ["19:abc@thread.v2", "8:orgid:ada", "48:notes", "19:abc@unq.gbl.spaces"]) {
      expect(channelMentionCandidate({ conversationId: id, name: "General", isChannel: true }))
        .toBeNull();
    }
    // A channel POST's own deep-link id is still that channel: the `;messageid=` suffix names
    // a thread root rather than a conversation of its own (`teams_read::base_thread_id`).
    expect(
      channelMentionCandidate({
        conversationId: `${conversationId};messageid=1784899486984`,
        name: "Incidents",
        isChannel: true,
      })?.kind,
    ).toBe("channel");
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

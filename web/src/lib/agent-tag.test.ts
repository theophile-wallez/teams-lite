import { describe, expect, it } from "vitest";
import type { AgentStatus } from "./agent";
import { agentTagInText, agentTagsInMessage, markAgentTag } from "./agent-tag";
import type { AgentCandidate } from "./mentions";
import type { ChatMessage } from "./protocol";
import { parseMessageBody, type RichNode } from "./rich-text";

const CLAUDE: AgentCandidate = { backend: "claude", name: "Claude", prefix: "@claude" };
const OPENCODE: AgentCandidate = { backend: "opencode", name: "opencode", prefix: "@opencode" };
const AGENTS = [CLAUDE, OPENCODE];

const OPTED_IN = "19:sandbox@thread.v2";

/** An `agent_status` with both CLIs installed and one conversation opted in. */
const STATUS: AgentStatus = {
  backends: [
    { name: "claude", prefix: "@claude", available: true, enabled: true, model: null, models: [] },
    {
      name: "opencode",
      prefix: "@opencode",
      available: true,
      enabled: true,
      model: null,
      models: [],
    },
  ],
  conversations: [{ conversation: OPTED_IN, mode: "reply" }],
  tools: [],
  workspace: "/home/user/project",
  enabled: true,
  sandbox_conversation: OPTED_IN,
};

/** A message of the user's own, in the opted-in thread. */
function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    conversation_id: OPTED_IN,
    seq: 1,
    compose_time: 1,
    sender: "Théophile WALLEZ",
    sender_mri: "8:orgid:theo",
    content: "<p>@claude which port?</p>",
    is_self: true,
    ...over,
  };
}

/** The backend each `agent` node in a tree names, in document order. */
function tags(nodes: RichNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "text"
      ? []
      : node.tag === "agent"
        ? [node.attrs.backend ?? ""]
        : tags(node.children),
  );
}

/** The tree of a body, with the tags of `AGENTS` marked. */
function marked(html: string, agents: readonly AgentCandidate[] = AGENTS): RichNode[] {
  return markAgentTag(parseMessageBody(html, "html"), agents);
}

describe("agentTagsInMessage", () => {
  it("offers this machine's agents on the user's own message in an opted-in thread", () => {
    expect(agentTagsInMessage(message(), STATUS).map((a) => a.backend)).toEqual([
      "claude",
      "opencode",
    ]);
  });

  it("offers every backend on a colleague's message, since their machine ran it", () => {
    // A colleague running teams-lite summons their OWN agent: the backend's trigger
    // requires `from_me`, so their prefix ran nothing here — and every gate that would
    // decide whether it ran (this thread's mode, this machine's CLIs, this backend's
    // write lock) is about this machine and none of them is about theirs. So the chip is
    // marked from the prefix alone, and it claims only what they wrote.
    for (const from of [{ is_self: false }, { is_self: undefined }]) {
      expect(agentTagsInMessage(message(from), STATUS).map((a) => a.backend)).toEqual([
        "claude",
        "opencode",
      ]);
    }
  });

  it("offers them on a colleague's message in a thread nobody opted in, and with the providers off", () => {
    // The consent gate is about posting from THIS machine. Their agent already answered.
    const off: AgentStatus = {
      ...STATUS,
      enabled: false,
      conversations: [],
      backends: [
        { ...STATUS.backends[0]!, enabled: false },
        { ...STATUS.backends[1]!, available: false },
      ],
    };
    expect(
      agentTagsInMessage(message({ is_self: false, conversation_id: "19:other@thread.v2" }), off).map(
        (a) => a.backend,
      ),
    ).toEqual(["claude", "opencode"]);
  });

  it("offers none on a colleague's message before the backend names its CLIs", () => {
    // How an agent is addressed still comes from the backend, so there is one spelling of
    // `@claude` in this app and not two.
    expect(agentTagsInMessage(message({ is_self: false }), null)).toEqual([]);
  });

  it("offers none in a thread nobody opted in, and none before the backend answers", () => {
    expect(agentTagsInMessage(message({ conversation_id: "19:other@thread.v2" }), STATUS)).toEqual(
      [],
    );
    expect(agentTagsInMessage(message(), null)).toEqual([]);
  });

  it("offers none on a deleted message, and none on the agent's own reply", () => {
    // Both rules hold whoever wrote it: they are about the message, not about a machine.
    expect(agentTagsInMessage(message({ deleted: true }), STATUS)).toEqual([]);
    expect(agentTagsInMessage(message({ deleted: true, is_self: false }), STATUS)).toEqual([]);
    const reply = { content: "<p>19420.</p><p><em>— claude, via teams-lite</em></p>" };
    expect(agentTagsInMessage(message(reply), STATUS)).toEqual([]);
    expect(agentTagsInMessage(message({ ...reply, is_self: false }), STATUS)).toEqual([]);
  });

  it("offers only the providers that would answer, on a message of OURS", () => {
    const off: AgentStatus = {
      ...STATUS,
      backends: [
        { ...STATUS.backends[0]!, enabled: false },
        { ...STATUS.backends[1]!, available: false },
      ],
    };
    expect(agentTagsInMessage(message(), off)).toEqual([]);
    // A read-only backend never answers whatever the modes say.
    expect(agentTagsInMessage(message(), { ...STATUS, enabled: false })).toEqual([]);
  });
});

// `agentTagInText` is a port of `agent_policy::split_prefix` and the prompt rules
// `trigger_for` applies around it, so these cases mirror the Rust tests one for one: what
// the backend would answer is what wears a chip.
describe("agentTagInText", () => {
  it("names the agent a prefixed message summons", () => {
    expect(agentTagInText("@claude which port?", AGENTS)).toBe(CLAUDE);
  });

  it("gives each backend its own prefix", () => {
    expect(agentTagInText("@opencode which port?", AGENTS)).toBe(OPENCODE);
  });

  it("ignores case, and the punctuation an address may carry", () => {
    expect(agentTagInText("@Claude which port?", AGENTS)).toBe(CLAUDE);
    expect(agentTagInText("@claude: which port?", AGENTS)).toBe(CLAUDE);
    expect(agentTagInText("@claude, which port?", AGENTS)).toBe(CLAUDE);
    expect(agentTagInText("  \n@claude which port?", AGENTS)).toBe(CLAUDE);
  });

  it("reads the address wherever it stands", () => {
    // One request written several ways: a person does not always open with the name of
    // whoever they are writing to, and the backend reads every one of these the same.
    expect(agentTagInText("which port, @claude?", AGENTS)).toBe(CLAUDE);
    expect(agentTagInText("which port? @claude", AGENTS)).toBe(CLAUDE);
    expect(agentTagInText("bon @claude, tu peux regarder ?", AGENTS)).toBe(CLAUDE);
    // The case this rule gives up, and it is stated where the rule is: talking ABOUT the
    // agent and talking TO it are the same words, so this is a request now.
    expect(agentTagInText("as we said @claude is quick", AGENTS)).toBe(CLAUDE);
  });

  it("takes the FIRST agent addressed when a message names two", () => {
    // The agent the sentence turns to first, whichever order the caller's list is in.
    expect(agentTagInText("ask @claude, not @opencode", AGENTS)).toBe(CLAUDE);
    expect(agentTagInText("ask @opencode, not @claude", AGENTS)).toBe(OPENCODE);
  });

  it("reads nothing from a word that merely starts the same way", () => {
    expect(agentTagInText("@claudette which port?", AGENTS)).toBeNull();
    expect(agentTagInText("ask @claudette which port?", AGENTS)).toBeNull();
  });

  it("reads nothing from an address of another kind", () => {
    // An email is not a summons: the prefix has to be a word of its own on both sides.
    expect(agentTagInText("write to ping@claude.example", AGENTS)).toBeNull();
    expect(agentTagInText("mail opencode@example.com about it", AGENTS)).toBeNull();
  });

  it("reads nothing without a prompt, and nothing from a paste", () => {
    expect(agentTagInText("@claude", AGENTS)).toBeNull();
    expect(agentTagInText("@claude   ", AGENTS)).toBeNull();
    expect(agentTagInText("@claude:", AGENTS)).toBeNull();
    expect(agentTagInText(`@claude ${"x".repeat(4_001)}`, AGENTS)).toBeNull();
    // The prompt is the whole message minus the address, so the cap counts all of it.
    expect(agentTagInText(`${"x".repeat(4_001)} @claude`, AGENTS)).toBeNull();
  });

  it("reads nothing when the agent is not one the caller offers", () => {
    // The caller's list is the consent gate: a thread nobody opted in offers none, and a
    // prefix for a provider that is off summons nothing.
    expect(agentTagInText("@opencode which port?", [CLAUDE])).toBeNull();
    expect(agentTagInText("@claude which port?", [])).toBeNull();
  });
});

describe("markAgentTag", () => {
  it("marks the prefix and keeps every word around it", () => {
    const nodes = marked("<p>@claude which port?</p>");
    expect(tags(nodes)).toEqual(["claude"]);
    // The prefix stays the node's own text, so anything that does not know the tag still
    // shows what the user typed.
    expect(JSON.stringify(nodes)).toContain("@claude");
    expect(JSON.stringify(nodes)).toContain(" which port?");
  });

  it("marks it through the markup it was written in", () => {
    expect(tags(marked("<p><strong>@claude</strong> which port?</p>"))).toEqual(["claude"]);
  });

  it("marks the FIRST address only", () => {
    // The second one summons nobody: the backend takes the agent the sentence turns to
    // first, and every later `@claude` is one of the author's own words.
    expect(tags(marked("<p>@claude ask @claude again</p>"))).toEqual(["claude"]);
  });

  it("marks an address that stands mid-message, at the offset the backend read it", () => {
    // The chip goes where the request is, not on the first `@claude`-shaped word: both are
    // read from one pass over the whole text (see `agentAddressInText`).
    const nodes = marked("<p>as we said @claude is quick</p>");
    expect(tags(nodes)).toEqual(["claude"]);
    expect(JSON.stringify(nodes)).toContain("as we said ");
    expect(JSON.stringify(nodes)).toContain(" is quick");
    // Across blocks, and through the markup it was written in.
    expect(tags(marked("<p>look at this</p><p>@claude and that</p>"))).toEqual(["claude"]);
    expect(tags(marked("<p>which port <strong>@claude</strong></p>"))).toEqual(["claude"]);
  });

  it("keeps the author's own comma out of the chip", () => {
    // The backend cuts "do this, @claude" at the comma — it is how a person marks who they
    // are talking to — but the comma is their punctuation and stays their text.
    const nodes = marked("<p>which port, @claude?</p>");
    expect(tags(nodes)).toEqual(["claude"]);
    expect(JSON.stringify(nodes)).toContain("which port,");
    expect(JSON.stringify(nodes)).toContain("?");
  });

  it("leaves a body that summons nothing exactly as it was", () => {
    const html = "<p>write to ping@claude.example</p>";
    const parsed = parseMessageBody(html, "html");
    expect(markAgentTag(parsed, AGENTS)).toBe(parsed);
    expect(markAgentTag(parseMessageBody(html, "html"), [])).toEqual(parsed);
  });

  it("leaves the prefix alone when no single text holds it whole", () => {
    // Markup splitting the prefix, so what the chip would name is a guess.
    expect(tags(marked("<p><strong>@cla</strong>ude which port?</p>"))).toEqual([]);
    expect(tags(marked("<p>ask <strong>@cla</strong>ude which port?</p>"))).toEqual([]);
  });

  it("marks the prefix of a plain-text body too", () => {
    expect(tags(markAgentTag(parseMessageBody("@claude which port?", "text"), AGENTS))).toEqual([
      "claude",
    ]);
  });
});

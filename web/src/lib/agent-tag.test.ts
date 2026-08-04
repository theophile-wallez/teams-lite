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

  it("offers NONE on a colleague's message", () => {
    // THE gate: the backend's trigger requires `from_me`, so a colleague's prefix ran
    // nothing — and a chip on it would say they can start a program on this machine.
    expect(agentTagsInMessage(message({ is_self: false }), STATUS)).toEqual([]);
    expect(agentTagsInMessage(message({ is_self: undefined }), STATUS)).toEqual([]);
  });

  it("offers none in a thread nobody opted in, and none before the backend answers", () => {
    expect(agentTagsInMessage(message({ conversation_id: "19:other@thread.v2" }), STATUS)).toEqual(
      [],
    );
    expect(agentTagsInMessage(message(), null)).toEqual([]);
  });

  it("offers none on a deleted message, and none on the agent's own reply", () => {
    expect(agentTagsInMessage(message({ deleted: true }), STATUS)).toEqual([]);
    const reply = message({
      content: "<p>19420.</p><p><em>— claude, via teams-lite</em></p>",
    });
    expect(agentTagsInMessage(reply, STATUS)).toEqual([]);
  });

  it("offers only the providers that would answer", () => {
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

  it("reads nothing when the prefix does not open the message", () => {
    // Somebody talking ABOUT the agent, not to it — which is what the backend reads too.
    expect(agentTagInText("as we said @claude is quick", AGENTS)).toBeNull();
  });

  it("reads nothing from a word that merely starts the same way", () => {
    expect(agentTagInText("@claudette which port?", AGENTS)).toBeNull();
  });

  it("reads nothing without a prompt, and nothing from a paste", () => {
    expect(agentTagInText("@claude", AGENTS)).toBeNull();
    expect(agentTagInText("@claude   ", AGENTS)).toBeNull();
    expect(agentTagInText(`@claude ${"x".repeat(4_001)}`, AGENTS)).toBeNull();
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

  it("marks the FIRST prefix only", () => {
    // The second one summons nobody: the backend reads the prefix a message opens with.
    expect(tags(marked("<p>@claude ask @claude again</p>"))).toEqual(["claude"]);
  });

  it("leaves a body that summons nothing exactly as it was", () => {
    const html = "<p>as we said @claude is quick</p>";
    const parsed = parseMessageBody(html, "html");
    expect(markAgentTag(parsed, AGENTS)).toBe(parsed);
    expect(markAgentTag(parseMessageBody(html, "html"), [])).toEqual(parsed);
  });

  it("leaves the prefix alone when no single text holds it whole", () => {
    // Markup splitting the prefix, so what the chip would name is a guess.
    expect(tags(marked("<p><strong>@cla</strong>ude which port?</p>"))).toEqual([]);
  });

  it("marks the prefix of a plain-text body too", () => {
    expect(tags(markAgentTag(parseMessageBody("@claude which port?", "text"), AGENTS))).toEqual([
      "claude",
    ]);
  });
});

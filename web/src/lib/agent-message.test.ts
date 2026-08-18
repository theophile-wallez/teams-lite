import { describe, expect, it } from "vitest";
import { agentAuthorship } from "./agent-message";
import type { ChatMessage } from "./protocol";

/** A message as the backend broadcasts one. */
function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "1785773946200",
    conversation_id: "19:thread@thread.v2",
    seq: 1,
    ts: "2026-08-03T10:00:00Z",
    sender: "Théophile WALLEZ",
    sender_mri: "8:orgid:me",
    is_self: true,
    message_type: "RichText/Html",
    content: "",
    ...over,
  } as ChatMessage;
}

// The four bodies are `agent_policy::thinking_html`, `reply_html` (streaming and
// finished) and `failure_html`.

describe("agentAuthorship — a custom agent", () => {
  // The persona form is `bebou (claude)` (`agent_policy::Signature`). Reading it back is what
  // makes a reply draw under its own name and face — including one answered from a phone
  // while this app was closed, which is most of them.
  it("reads which custom agent answered, and which CLI ran", () => {
    const found = agentAuthorship(
      message({
        content: "<p>coucou ma Véro</p><p><em>— natacha (claude), via teams-lite</em></p>",
      }),
    );
    expect(found).not.toBeNull();
    expect(found!.persona).toBe("natacha");
    expect(found!.backend).toBe("claude");
    expect(found!.bodyHtml).toBe("<p>coucou ma Véro</p>");
    expect(found!.pending).toBe(false);
  });

  it("reads the persona in all three states", () => {
    const writing = agentAuthorship(
      message({ content: "<p>coucou</p><p><em>natacha (claude) is writing…</em></p>" }),
    );
    expect(writing!.persona).toBe("natacha");
    expect(writing!.pending).toBe(true);

    const thinking = agentAuthorship(
      message({ content: "<p><em>bebou (opencode) is thinking…</em></p>" }),
    );
    expect(thinking!.persona).toBe("bebou");
    expect(thinking!.backend).toBe("opencode");
    expect(thinking!.pending).toBe(true);

    const failed = agentAuthorship(
      message({ content: "<p><em>bebou (claude) could not answer: boom</em></p>" }),
    );
    expect(failed!.persona).toBe("bebou");
    expect(failed!.failure).toBe("boom");
    expect(failed!.pending).toBe(false);
  });

  it("leaves a plain provider reply with no persona", () => {
    // Byte for byte the signature every reply carried before this feature: an older message
    // must keep reading as one, and it must not be attributed to an agent nobody made.
    const found = agentAuthorship(
      message({ content: "<p>19420.</p><p><em>— claude, via teams-lite</em></p>" }),
    );
    expect(found!.persona).toBeNull();
    expect(found!.backend).toBe("claude");
  });

  it("refuses a persona form whose CLI this app does not know", () => {
    // The rule that makes "a message signed by a name we know" different from "a message
    // ending in a dash and some words". The PERSONA name is whatever the machine that wrote
    // the reply called its own agent, so it is never checked — the CLI is.
    expect(
      agentAuthorship(message({ content: "<p>hi</p><p><em>— bebou (gemini), via teams-lite</em></p>" })),
    ).toBeNull();
    expect(
      agentAuthorship(message({ content: "<p>hi</p><p><em>— somebody's aunt, via teams-lite</em></p>" })),
    ).toBeNull();
  });

  it("reads one through the whitespace Teams stores a body with", () => {
    const stored =
      "<p>coucou</p>\r\n<p>\r\n<em>— natacha (claude), via teams-lite</em>\r\n</p>\r\n";
    expect(agentAuthorship(message({ content: stored }))!.persona).toBe("natacha");
  });
});

describe("agentAuthorship", () => {
  it("reads a finished reply and hands back the answer without the signature", () => {
    const found = agentAuthorship(
      message({
        content: "<p>The port is 19420.</p><p><em>— claude, via teams-lite</em></p>",
      }),
    );
    expect(found).not.toBeNull();
    expect(found!.backend).toBe("claude");
    expect(found!.bodyHtml).toBe("<p>The port is 19420.</p>");
    expect(found!.pending).toBe(false);
    expect(found!.failure).toBeNull();
  });

  it("reads a reply that is still being written", () => {
    const streaming = agentAuthorship(
      message({ content: "<p>The port is</p><p><em>claude is writing…</em></p>" }),
    );
    expect(streaming!.pending).toBe(true);
    expect(streaming!.bodyHtml).toBe("<p>The port is</p>");

    // The placeholder: signed, and with no answer yet at all.
    const placeholder = agentAuthorship(
      message({ content: "<p><em>opencode is thinking…</em></p>" }),
    );
    expect(placeholder!.backend).toBe("opencode");
    expect(placeholder!.pending).toBe(true);
    expect(placeholder!.bodyHtml).toBe("");
  });

  it("reads a failure and keeps its reason", () => {
    const failed = agentAuthorship(
      message({ content: "<p><em>claude could not answer: claude exited 1</em></p>" }),
    );
    expect(failed!.failure).toBe("claude exited 1");
    expect(failed!.pending).toBe(false);
  });

  it("reads a run a restart cut short, and stops calling it pending", () => {
    // `agent_policy::interrupted_html` — the body a backend writes over a reply no
    // process is finishing any more (a restart killed the CLI). It reuses the failure
    // shape precisely so this path needs no new pattern; the test pins the string, which
    // is the only thing holding the two languages together.
    const interrupted = agentAuthorship(
      message({
        content:
          "<p><em>claude could not answer: the backend restarted before the answer arrived — ask again</em></p>",
      }),
    );
    expect(interrupted!.backend).toBe("claude");
    expect(interrupted!.pending).toBe(false);
    expect(interrupted!.failure).toBe(
      "the backend restarted before the answer arrived — ask again",
    );
  });

  it("survives the whitespace Teams inserts when it stores a body", () => {
    // Teams pretty-prints what it keeps: `</p>\r\n<p>` for our `</p><p>`.
    const found = agentAuthorship(
      message({
        content: "<p>Answer.</p>\r\n<p>\r\n  <em>— claude, via teams-lite</em>\r\n</p>\r\n",
      }),
    );
    expect(found!.backend).toBe("claude");
    expect(found!.bodyHtml).toBe("<p>Answer.</p>");
  });

  it("keeps the quote a reply carries", () => {
    // The answer is posted as a native reply to the message that summoned it, so the
    // body opens with Teams' quote markup. Only the signature is removed.
    const content =
      '<div itemscope itemtype="http://schema.skype.com/Reply"><span>@claude what is the port?</span></div>' +
      "<p>19420.</p><p><em>— claude, via teams-lite</em></p>";
    const found = agentAuthorship(message({ content }));
    expect(found!.bodyHtml).toContain("schema.skype.com/Reply");
    expect(found!.bodyHtml).toContain("<p>19420.</p>");
    expect(found!.bodyHtml).not.toContain("via teams-lite");
  });

  it("is not fooled by a message that merely talks about the agent", () => {
    for (const content of [
      "<p>claude is writing the docs today</p>",
      "<p><em>I asked claude, via teams-lite, yesterday</em></p>",
      "<p><em>— someone else, via teams-lite</em></p>",
      "<p><em>— claude, via teams-lite</em></p><p>and then I added this</p>",
      "<p>plain text</p>",
      "",
    ]) {
      expect(agentAuthorship(message({ content })), content).toBeNull();
    }
  });

  it("reads a colleague's reply too, because their teams-lite signs it the same way", () => {
    // A colleague in the thread may run teams-lite, and their agent's answer arrives as an
    // incoming message signed exactly like ours. Read as an ordinary message it would show
    // the reader the raw signature line the mark above the bubble exists to replace, tucked
    // against that colleague's own words. Whose account it went out under is not guessed:
    // the bubble names the message's own sender beside the mark.
    const content = "<p>Sonnet 4.5.</p><p><em>— claude, via teams-lite</em></p>";
    const found = agentAuthorship(message({ content, is_self: false, sender: "MST-Eago" }));
    expect(found!.backend).toBe("claude");
    expect(found!.bodyHtml).toBe("<p>Sonnet 4.5.</p>");
    expect(found!.pending).toBe(false);
  });

  it("never reads a deleted message as an agent reply", () => {
    // A deletion has its own treatment (a ghost bubble, revealable when cached), and
    // it must not be replaced by an agent bubble — whoever posted it.
    const content = "<p>Gone.</p><p><em>— claude, via teams-lite</em></p>";
    expect(agentAuthorship(message({ content, deleted: true }))).toBeNull();
    expect(agentAuthorship(message({ content, deleted: true, is_self: false }))).toBeNull();
  });

  it("is not fooled by a colleague's message either", () => {
    // The signature is closed on the names we know, in both directions: an incoming
    // message that merely talks about the agent stays an ordinary message.
    for (const content of [
      "<p>claude answered me in the other thread</p>",
      "<p><em>— someone else, via teams-lite</em></p>",
      "<p><em>— claude, via teams-lite</em></p><p>and then I added this</p>",
    ]) {
      expect(agentAuthorship(message({ content, is_self: false })), content).toBeNull();
    }
  });
});

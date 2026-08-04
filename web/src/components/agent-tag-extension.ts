// The composer's agent tag: one atomic inline node saying which agent the message
// summons.
//
// It comes out of the same list as a person mention and works nothing like one, which is
// the whole point of it being its own node:
//
//   - **It notifies nobody, so it carries no identity.** A mention is a pair (an indexed
//     span in the body, an entry naming an MRI beside it) and that pair is what pings a
//     person. An agent has no MRI; what summons it is the prefix the message OPENS with,
//     read back by `agent_policy::split_prefix` on the backend.
//   - **It serializes to that prefix, as plain text.** `renderHTML` emits the bare
//     `@claude` inside a span our own parser unwraps, so the body that reaches Teams is
//     exactly what the user would have typed by hand — no markup that would render as
//     coloured text in every other client while summoning nothing.
//   - **One Backspace removes it whole.** There is no name to shorten: "Claude" is one
//     word, and half a prefix summons nothing.
//
// The drawn chip is a React node view (components/agent-tag.tsx), so the mark is the same
// artwork an agent reply wears in the thread.

import { Node, ReactNodeViewRenderer } from "@tiptap/react";
import { AgentTagView } from "./agent-tag";

/** The text the tag becomes: the backend's own prefix, or the one it must be when a
 *  pasted span carried the name alone. */
function tagText(attrs: { backend?: unknown; prefix?: unknown }): string {
  const prefix = String(attrs.prefix ?? "").trim();
  if (prefix) return prefix;
  const backend = String(attrs.backend ?? "").trim();
  return backend ? `@${backend}` : "";
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    agentTag: {
      /** Insert a tag summoning `backend`, replacing the "@…" the user typed
       *  (`from`..`to`), and leave a trailing space — which the trigger needs anyway,
       *  since a prefix glued to the next word summons nothing. */
      insertAgentTag: (options: {
        backend: string;
        prefix: string;
        from: number;
        to: number;
      }) => ReturnType;
    };
  }
}

export const AgentTagNode = Node.create({
  name: "agentTag",
  group: "inline",
  inline: true,
  // An atom with no interior: the caret never lands inside a prefix, so a half-eaten
  // "@clau" — which would summon nothing while still looking like a tag — cannot exist.
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      backend: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-agent-tag") ?? "",
        renderHTML: (attributes) => ({ "data-agent-tag": attributes.backend }),
      },
      prefix: {
        default: "",
        // The prefix IS the node's text (see renderHTML), so it is read back from the
        // content rather than from an attribute of its own.
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-agent-tag]" }];
  },

  /** The markup `editor.getHTML()` carries — never what is drawn (the node view above is).
   *  A span our own parser unwraps, holding the prefix as its only text, so the body that
   *  reaches Teams is the plain `@claude` and nothing else. */
  renderHTML({ node, HTMLAttributes }) {
    return ["span", HTMLAttributes, tagText(node.attrs)];
  },

  /** What the tag contributes to `editor.getText()` — the plain text the draft is
   *  persisted as. The prefix, verbatim: a draft cannot survive a reload as a node, and
   *  "@claude" is both what it says and what still summons the agent when sent. */
  renderText({ node }) {
    return tagText(node.attrs);
  },

  addNodeView() {
    return ReactNodeViewRenderer(AgentTagView, { as: "span" });
  },

  addCommands() {
    return {
      insertAgentTag:
        ({ backend, prefix, from, to }) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContentAt({ from, to }, [
              { type: this.name, attrs: { backend, prefix } },
              { type: "text", text: " " },
            ])
            .run(),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Returning false leaves Backspace its normal job, so this only fires with the
      // caret immediately behind a tag — which then goes whole.
      Backspace: () => {
        const { selection } = this.editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;
        const before = $from.nodeBefore;
        if (!before || before.type.name !== this.name) return false;
        return this.editor
          .chain()
          .deleteRange({ from: $from.pos - before.nodeSize, to: $from.pos })
          .run();
      },
    };
  },
});

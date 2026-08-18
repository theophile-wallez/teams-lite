// The composer's agent tag: one atomic inline node saying which agent the message
// summons.
//
// It comes out of the same list as a person mention and works nothing like one, which is
// the whole point of it being its own node:
//
//   - **It notifies nobody, so it carries no identity.** A mention is a pair (an indexed
//     span in the body, an entry naming an MRI beside it) and that pair is what pings a
//     person. An agent has no MRI; what summons it is the prefix itself, wherever the
//     message writes it, read back by `agent_policy::split_prefix` on the backend.
//   - **It serializes to that prefix, as plain text.** `renderHTML` emits the bare
//     `@claude` inside a span our own parser unwraps, so the body that reaches Teams is
//     exactly what the user would have typed by hand — no markup that would render as
//     coloured text in every other client while summoning nothing. The chip the thread
//     then shows is that prefix read back out of the words (lib/agent-tag.ts), the way
//     the backend's own trigger reads it.
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
        /** The custom agent this tag summons, by address, or absent for the provider. */
        persona?: string | null;
        from: number;
        to: number;
      }) => ReturnType;
      /** Put a tag summoning `backend` at the START of the message, keeping whatever the
       *  composer already held after it, and leave the caret at the end. `request` seeds
       *  the words after the tag for a composer that had none (see `answerRequest` in
       *  lib/agent-answer.ts).
       *
       *  The front is a READABLE place rather than the only working one — the backend reads
       *  an address wherever it stands (`agent_policy::split_prefix`) — and it is where a
       *  draft the user did not type should start: "Answer with Claude" writes a sentence
       *  they are about to add to, and the agent it names belongs at the top of it.
       *
       *  A tag already leading the message is REPLACED: picking a second agent changes
       *  which one answers, it does not queue both. */
      leadAgentTag: (options: {
        backend: string;
        prefix: string;
        persona?: string | null;
        request: string;
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
      // Which CUSTOM AGENT the tag summons, by address — what makes the chip draw its own
      // face and label rather than the vendor's mark (see components/agent-tag.tsx).
      //
      // It is written to the markup and read back, unlike `prefix`, because the prefix
      // cannot answer it: `@bebou` says the address without saying it is a persona, and a
      // draft re-parsed from `editor.getHTML()` would otherwise come back as a plain
      // provider tag with the wrong mark on it. Nothing about it reaches TEAMS — the node's
      // own text is all `renderText` and the send path carry (see the module note above).
      persona: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-agent-persona") ?? "",
        renderHTML: (attributes) =>
          attributes.persona ? { "data-agent-persona": attributes.persona } : {},
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
    return ReactNodeViewRenderer(AgentTagView, {
      as: "span",
      // The node view owns every DOM change inside itself, and this is NOT a nicety: a
      // CUSTOM AGENT's chip draws that agent's FACE, which arrives one round trip later
      // (`usePersonaAvatar`) and replaces the vendor's `<svg>` with an `<img>`. ProseMirror
      // watches the editable for mutations it did not make and re-parses the node they
      // landed in — so that swap was read as the reader editing the document, and the atom
      // was re-parsed out of existence: the chip vanished the moment the next character was
      // typed. Nothing here is editable content, so there is no mutation this view wants
      // ProseMirror to act on.
      ignoreMutation: () => true,
    });
  },

  addCommands() {
    return {
      insertAgentTag:
        ({ backend, prefix, persona, from, to }) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContentAt({ from, to }, [
              { type: this.name, attrs: { backend, prefix, persona: persona ?? "" } },
              { type: "text", text: " " },
            ])
            .run(),

      leadAgentTag:
        ({ backend, prefix, persona, request }) =>
        ({ chain, state }) => {
          const tag = { type: this.name, attrs: { backend, prefix, persona: persona ?? "" } };
          // The tag is followed by a space either way: a prefix glued to the next word
          // summons nothing.
          const words = { type: "text", text: request ? ` ${request}` : " " };
          const first = state.doc.firstChild;
          // The message does not OPEN with a paragraph (an empty doc always does; a
          // draft that starts with a list does not). A leading paragraph of its own then
          // carries the tag, so the prefix opens the message whatever follows it.
          if (!first || first.type.name !== "paragraph") {
            return chain()
              .insertContentAt(0, { type: "paragraph", content: [tag, words] })
              .focus("end")
              .run();
          }
          // Replace a tag that already leads the message, and the single space it left
          // behind with it, so switching agents cannot leave a double space.
          const leading = first.firstChild;
          const tagged = leading !== null && leading.type.name === this.name;
          const after = tagged && first.childCount > 1 ? first.child(1) : null;
          const spaced = after !== null && after.isText && after.text?.startsWith(" ") === true;
          const to = 1 + (tagged ? leading.nodeSize : 0) + (spaced ? 1 : 0);
          return chain()
            .insertContentAt({ from: 1, to }, [tag, words])
            .focus("end")
            .run();
        },
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

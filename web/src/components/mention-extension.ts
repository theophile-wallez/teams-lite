// The composer's @mention: one atomic inline node holding WHO is mentioned and the
// text that names them.
//
// Two things make it a Teams mention rather than a coloured word:
//
//   - It serializes to the markup Teams reads. `renderHTML` emits the Skype Mention
//     span plus `data-mri`; on send, `serializeTeamsMessage` (lib/rich-text.ts) turns
//     each one into an indexed span and a `mentions` entry, which is the pair that
//     actually notifies the person.
//   - Its text SHRINKS. Backspace on a mention drops the last word of the name and
//     keeps the mention — "John De Doe" -> "John De" -> "John" — because that is how
//     people address each other in a thread, and Teams works exactly this way. Only a
//     mention down to its last word is removed whole.
//
// The node is an atom: the cursor never goes inside it, so the label can only change
// through the commands below, and a half-eaten name is impossible.

import { Node, mergeAttributes } from "@tiptap/react";
import { shortenMentionLabel } from "~/lib/mentions";
import type { MentionTargetKind } from "~/lib/protocol";

export const MENTION_ITEMTYPE = "http://schema.skype.com/Mention";

/** The class the composer's mention wears, styled in styles/app.css. */
export const MENTION_CLASS = "composer-mention";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mention: {
      /** Insert a mention for `mri` displayed as `label`, replacing the "@…" the user
       *  typed (`from`..`to`), and leave a trailing space so typing continues. */
      insertMention: (options: {
        mri: string;
        label: string;
        from: number;
        to: number;
        /** What the mention names. Absent is a person — the narrowest thing it can be
         *  (see `MentionTargetKind`), which is also what the wire defaults to. */
        kind?: MentionTargetKind;
      }) => ReturnType;
    };
  }
}

export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  // An atom with no selectable interior: one keystroke acts on the whole mention,
  // which is what makes the shrink-by-word behaviour well defined.
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      mri: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-mri") ?? "",
        renderHTML: (attributes) => ({ "data-mri": attributes.mri }),
      },
      label: {
        default: "",
        parseHTML: (element) => element.textContent ?? "",
        // The label IS the node's text, so it is rendered as content, not as an
        // attribute (see renderHTML below).
        renderHTML: () => ({}),
      },
      // WHAT this mention names, so the serializer can say so on the wire — a channel
      // mention described as a person is blue text notifying nobody. It rides the DOM as
      // an attribute because the editor's own HTML is what a draft round-trips through,
      // and the default is a person: every mention this app could make before this was
      // one, and reading an absent value as a channel would notify a whole channel.
      kind: {
        default: "person",
        parseHTML: (element) =>
          element.getAttribute("data-mention-kind") === "channel" ? "channel" : "person",
        renderHTML: (attributes) =>
          attributes.kind === "channel" ? { "data-mention-kind": "channel" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[itemtype="${MENTION_ITEMTYPE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        itemscope: "",
        itemtype: MENTION_ITEMTYPE,
        class: MENTION_CLASS,
        // The editor must not let the caret wander into the name; the whole mention
        // is one thing to the keyboard.
        contenteditable: "false",
      }),
      String(node.attrs.label ?? ""),
    ];
  },

  /**
   * What the mention contributes to `editor.getText()`, which is the plain-text mirror
   * the draft is persisted as and the text that survives a switch to the plain field.
   *
   * The "@" is kept on purpose. A draft is stored as text, so a mention cannot survive
   * a reload as a mention — and "Liam Nguyen could you review this?" would read as a
   * message that mentions him while notifying nobody. "@Liam Nguyen" says what it is,
   * and is exactly what the author would type to make it a mention again.
   */
  renderText({ node }) {
    const label = String(node.attrs.label ?? "");
    return label ? `@${label}` : "";
  },

  addCommands() {
    return {
      insertMention:
        ({ mri, label, from, to, kind }) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContentAt({ from, to }, [
              { type: this.name, attrs: { mri, label, kind: kind ?? "person" } },
              { type: "text", text: " " },
            ])
            .run(),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Teams' shrink-by-word. Returning false leaves Backspace to its normal job, so
      // this only ever fires with the caret immediately after a mention.
      Backspace: () => {
        const { state } = this.editor;
        const { selection } = state;
        if (!selection.empty) return false;
        const { $from } = selection;
        const before = $from.nodeBefore;
        if (!before || before.type.name !== this.name) return false;
        const start = $from.pos - before.nodeSize;
        const shorter = shortenMentionLabel(String(before.attrs.label ?? ""));
        if (shorter === null) {
          // One word left: the mention itself goes.
          return this.editor.chain().deleteRange({ from: start, to: $from.pos }).run();
        }
        return this.editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(start, undefined, { ...before.attrs, label: shorter });
            return true;
          })
          .run();
      },
    };
  },
});

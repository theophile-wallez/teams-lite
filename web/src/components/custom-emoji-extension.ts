// The composer's custom emoji chip: one atomic inline node holding an emoji name.
//
// It serializes to the bare `:name:` text so the backend can substitute it with the
// markup Teams renders. The chip itself is not the markup: it is the typeahead's
// output, and its job is to put the code Teams expects in the body.
//
// An alias serializes to its TARGET, so `:ship:` (an alias of `shipit`) becomes
// `:shipit:` in the body. The backend would resolve either, but a reader receiving
// `:ship:` gets a name only the sender's machine can explain, while `:shipit:` is the
// name the art actually has.
//
// One Backspace removes it whole. There is no name to shorten: half an emoji code
// names nothing, so there is nothing to shrink.
//
// The drawn chip is a React node view (components/custom-emoji-chip.tsx), so the art
// is the same image the thread renders.

import { Node, ReactNodeViewRenderer } from "@tiptap/react";
import { CustomEmojiChipView } from "./custom-emoji-chip";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    customEmoji: {
      /** Insert a custom emoji chip, replacing the ":…" the user typed (`from`..`to`).
       *  `target` is the name the backend substitutes: the emoji's own name, or the alias
       *  target when the typed name was an alias. */
      insertCustomEmoji: (options: {
        name: string;
        target: string;
        from: number;
        to: number;
      }) => ReturnType;
    };
  }
}

export const CustomEmojiNode = Node.create({
  name: "customEmoji",
  group: "inline",
  inline: true,
  // An atom with no interior: the caret never lands inside a code, so a half-eaten
  // `:ship` cannot exist. One Backspace removes it whole.
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-emoji-name") ?? "",
        renderHTML: (attributes) => ({ "data-emoji-name": attributes.name }),
      },
      target: {
        default: "",
        // The target IS the node's text (see renderHTML), so it is read back from the
        // content rather than from an attribute of its own.
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-emoji-name]" }];
  },

  /** The markup `editor.getHTML()` carries — never what is drawn (the node view is).
   *  A span our own parser unwraps, holding the target as its only text, so the body
   *  that reaches Teams is the bare `:shipit:` and nothing else. An alias serializes to
   *  its target here, which is how `:ship:` becomes `:shipit:` in the body. */
  renderHTML({ node, HTMLAttributes }) {
    const target = String(node.attrs.target ?? node.attrs.name ?? "").trim();
    return ["span", HTMLAttributes, target ? `:${target}:` : ""];
  },

  /** What the chip contributes to `editor.getText()` — the plain text the draft is
   *  persisted as. The target, verbatim: a draft cannot survive a reload as a node, and
   *  `:shipit:` is both what it says and what the backend substitutes when sent. */
  renderText({ node }) {
    const target = String(node.attrs.target ?? node.attrs.name ?? "").trim();
    return target ? `:${target}:` : "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(CustomEmojiChipView, { as: "span" });
  },

  addCommands() {
    return {
      insertCustomEmoji:
        ({ name, target, from, to }) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContentAt({ from, to }, [
              { type: this.name, attrs: { name, target } },
              { type: "text", text: " " },
            ])
            .run(),
    };
  },

  addKeyboardShortcuts() {
    return {
      // Returning false leaves Backspace its normal job, so this only fires with the
      // caret immediately behind a chip — which then goes whole.
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

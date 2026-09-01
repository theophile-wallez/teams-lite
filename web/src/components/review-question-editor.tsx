import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";

import {
  matchReviewTags,
  reviewQuestionParts,
  reviewTagKey,
  reviewTagLabel,
  type ReviewTag,
} from "~/lib/gitlab-review";
import { cn } from "~/lib/utils";
import { ReviewTagNode } from "./review-tag-node";

// THE QUESTION'S OWN FIELD: a box the reader types a sentence into, where a tagged theme or file is
// drawn as a CHIP rather than as the raw words it travels as.
//
// **IT IS THE APP'S OWN EDITOR, and that is why it is not a textarea.** A tag has to be drawn as
// something whose width is not its text's — a file chip shows `kubernetes-agent.gitlab-ci.yaml` where
// the words carry `@tooling/ci/components/blocks/kubernetes-agent.gitlab-ci.yaml` — and no overlay
// over a textarea can do that: the mirror's layout would have to match the field's character for
// character, which is exactly what a shortened chip breaks. So it is TipTap with one atomic node, the
// shape `agent-tag-extension.ts` already has for `@claude`, and the words are still the truth
// (`ReviewTagNode.renderText`).
//
// It replaced a `<textarea>` that carried the same typeahead. What moved with it, and why:
//
//   - **NOTHING ABOUT THE WIRE.** `editor.getText()` gives the same string the textarea's `value`
//     gave, character for character, so `reviewTagsInText` reads what travels out of the question's
//     own words exactly as before and `src/gitlab_review.rs` is untouched. A question typed by hand
//     with no chip in it still works.
//   - **The typeahead came WITH the field**, because the query is a fact about the caret and only the
//     editor knows where that is. It keeps every rule it had: the "@" must open the text or follow
//     whitespace, the query is what stands between it and the CARET (never to the end of the text),
//     a row is activated on `mousemove` and never `mouseenter`, Escape leaves the "@" as text, and
//     Enter asks while Shift+Enter is a new line.
//   - **THE GROWTH IS THE POINT OF A CONTENTEDITABLE.** A box that stays two lines tall while the
//     reader writes a paragraph hides most of what they wrote; one that grows for ever pushes the
//     conversation off the screen. It grows with its content to `MAX_LINES` and scrolls after that.

/** The most lines the box grows to before it scrolls itself.
 *
 *  Eight, which is a paragraph — past that the reader is writing a document and the panel it sits in
 *  is a column beside the branch's code, so a box that kept growing would take the conversation with
 *  it. Below `md` the panel is a bounded slice under the document, where the same number is what
 *  stops the box from taking the whole of it. */
const MAX_LINES = 8;

/** The line height the box grows in multiples of, in pixels.
 *
 *  It is a CONSTANT rather than a measurement, and it is the one the field's own class sets
 *  (`text-[13px] leading-5`): the ceiling has to be a number CSS can hold before anything is
 *  rendered, or the box would draw at one height and be corrected a frame later — the jump the
 *  description fold's own `everPressed` rule exists to avoid. Move one and move the other. */
const LINE_PX = 20;

/** What a caller can do to the field from outside it.
 *
 *  Three things, and each is one the panel owns rather than the field: the words are CLEARED on the
 *  press (because they are drawn as a bubble in the same frame), HANDED BACK when a publish failed,
 *  and FOCUSED by a press anywhere in the box. */
export type ReviewQuestionHandle = {
  focus: () => void;
  clear: () => void;
  /** Put `text` in the field, rebuilding the chips by re-reading its words.
   *
   *  It is how a failed publish hands the question back: the words are the truth, so the document is
   *  rebuilt from them and the chips come back with no state kept anywhere. */
  setText: (text: string) => void;
};

/** An "@…" being typed: what was typed, and the document range it occupies — so picking a tag
 *  replaces exactly those characters. The shape `MentionQueryState` has in the app's own composer. */
type QueryState = { query: string; from: number; to: number };

/**
 * The "@…" the caret sits in, in document coordinates, or null when it sits in ordinary text.
 *
 * The text is read from the caret's own BLOCK and only up to the caret, which is what gives the two
 * rules this shares with every other "@" in the app: the trigger must open the line or follow
 * whitespace (so `note@example` opens nothing), and the query is what stands between it and the
 * caret — never to the end of the text, which is the defect the textarea version was fixed for (a
 * reader going back to add a tag mid-sentence lost the rest of their question).
 *
 * An ATOM — a chip already in the sentence — counts as one non-space character, so the offsets line
 * up with document positions and a chip cannot be read as part of a query.
 */
function queryInEditor(editor: Editor): QueryState | null {
  const { $from, empty } = editor.state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const opens = at === 0 || /\s/.test(before[at - 1]!);
  const run = before.slice(at + 1);
  // Whitespace ENDS a query, so "@ " closes the list again rather than matching every tag.
  if (!opens || /\s/.test(run)) return null;
  return { query: run, from: $from.start() + at, to: $from.pos };
}

export function ReviewQuestionEditor(props: {
  /** Everything the question can be tagged with, themes first (`reviewTags`). */
  tags: ReviewTag[];
  /** Already-picked tags, so the list does not offer one twice: a control that changes nothing reads
   *  as a bug, and picking one twice sends it once anyway. */
  picked: ReadonlySet<string>;
  placeholder: string;
  /** The question as WORDS, on every change — which is what the panel sends and what it reads the
   *  tags out of. */
  onChangeText: (text: string) => void;
  /** Enter with no Shift, and only while the list is not open. */
  onSubmit: () => void;
  handle: Ref<ReviewQuestionHandle>;
}) {
  const [query, setQuery] = useState<QueryState | null>(null);
  const [active, setActive] = useState(0);

  // The list this render shows, mirrored into refs because `handleKeyDown` is created ONCE with the
  // editor and would otherwise close over the first render's values — the trap the app's own composer
  // states for its two typeaheads.
  const matches = useMemo(
    () => (query === null ? [] : matchReviewTags(props.tags, query.query, props.picked)),
    [query, props.tags, props.picked],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const activeRef = useRef(active);
  activeRef.current = active;
  const submitRef = useRef(props.onSubmit);
  submitRef.current = props.onSubmit;
  // Set by `pick`, which is defined below the editor it needs — one ref rather than a forward
  // declaration, because `handleKeyDown` is only ever called after mount.
  const pickRef = useRef<(tag: ReviewTag) => void>(() => {});

  const editor = useEditor({
    // TanStack Start renders on the server; ProseMirror needs the DOM, so creation is deferred to the
    // client to avoid a hydration mismatch — the rule `rich-editor.tsx` holds.
    immediatelyRender: false,
    extensions: useMemo(
      () => [
        // The NARROWEST document that can hold a question: one paragraph of text, with a hard break
        // for Shift+Enter, and the tag node. No StarterKit — bold, lists and links are not things a
        // question to a model needs, and every one of them would be markup in a prompt.
        Document,
        Paragraph,
        Text,
        HardBreak,
        // Configured at CREATION, which is the one thing to know about it: a caller that changed this
        // prop later would not move it. Nothing does, and the alternative is recreating the editor —
        // which would throw away whatever the reader had typed.
        Placeholder.configure({ placeholder: props.placeholder }),
        ReviewTagNode,
      ],
      [props.placeholder],
    ),
    onUpdate: ({ editor }) => {
      props.onChangeText(editor.getText());
      setQuery(queryInEditor(editor));
      setActive(0);
    },
    onSelectionUpdate: ({ editor }) => {
      // A click or an arrow moves the caret with no change to the text, and a list measured against
      // the old position would match the wrong run — so it is re-measured rather than left open.
      setQuery(queryInEditor(editor));
    },
    onBlur: () => setQuery(null),
    editorProps: {
      attributes: {
        class: cn(
          "w-full text-[13px] leading-5 text-foreground outline-none",
          // GROWTH: the box is as tall as its content up to the ceiling, then scrolls. `min-h` is two
          // lines, which is what the textarea's own `rows={2}` was, so an empty box is the same size
          // it always was.
          "overflow-y-auto tiptap-message",
        ),
        style: `min-height:${LINE_PX * 2}px;max-height:${LINE_PX * MAX_LINES}px`,
        "data-testid": "gitlab-review-chat-field",
      },
      handleKeyDown: (_view, event) => {
        const open = matchesRef.current.length > 0;
        if (open) {
          const count = matchesRef.current.length;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (index + step + count) % count);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const tag = matchesRef.current[activeRef.current] ?? matchesRef.current[0];
            if (tag) pickRef.current(tag);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            // The list, and only the list. Escape is also the app's "leave this page" key, and
            // closing a menu must not do that too — the rule the app's own composer states.
            event.stopPropagation();
            setQuery(null);
            return true;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        return false;
      },
    },
  });

  /** Put a tag in the sentence, in place of the "@…" that opened the list. */
  const pick = (tag: ReviewTag) => {
    if (!editor || !query) return;
    editor.commands.insertReviewTag({ tag, from: query.from, to: query.to });
    // A space AFTER the chip, so the reader carries straight on typing — and NOT a second one when
    // the text already has one there, which is what a pick in the middle of a sentence has in front
    // of it. The rule the textarea's own `pick` held, read off the document instead of a string.
    const at = editor.state.selection.from;
    const after = editor.state.doc.textBetween(at, Math.min(at + 1, editor.state.doc.content.size));
    if (after !== " ") editor.commands.insertContent(" ");
    setQuery(null);
    setActive(0);
  };
  pickRef.current = pick;

  useImperativeHandle(
    props.handle,
    () => ({
      focus: () => {
        if (!editor) return;
        // The element first and the caret second, which is what makes a phone raise its keyboard:
        // TipTap finishes its own focus in a `requestAnimationFrame`, and a frame is long enough to
        // type into (the rule `focusEditor` states in full).
        editor.view.dom.focus({ preventScroll: true });
        editor.commands.focus("end");
      },
      clear: () => {
        editor?.commands.clearContent(true);
        setQuery(null);
      },
      setText: (text: string) => {
        // Rebuilt from the WORDS, so the chips come back by re-reading them and nothing about a
        // handed-back question is kept anywhere else.
        editor?.commands.setContent(reviewQuestionDoc(text, props.tags));
        setQuery(null);
      },
    }),
    [editor, props.tags],
  );

  return (
    <>
      {matches.length > 0 && (
        // Over the box rather than under it, because the box is at the foot of a column: a list below
        // would be off the bottom of the screen.
        <ul
          data-testid="gitlab-review-chat-list"
          className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-lg bg-card p-1 shadow-card"
        >
          {matches.map((tag, index) => (
            <li key={reviewTagKey(tag)}>
              <button
                type="button"
                data-testid="gitlab-review-chat-option"
                data-kind={tag.kind}
                data-active={index === active ? "yes" : "no"}
                // `mousemove` rather than `mouseenter`: this list opens right over the field the
                // reader just clicked, so a row appearing under a STATIONARY cursor would take the
                // active row away from the keyboard — the defect both composer typeaheads were fixed
                // for.
                onMouseMove={() => setActive(index)}
                // `preventDefault` on the press, or the field blurs before the click lands and
                // `onBlur` closes the list under it.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(tag)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]",
                  index === active ? "bg-accent" : "",
                )}
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-px text-[10px]",
                    tag.kind === "theme"
                      ? "bg-primary/10 text-primary"
                      : "bg-element text-text-faint",
                  )}
                >
                  {tag.kind === "theme" ? "theme" : "file"}
                </span>
                {/* The NAME the chip will show, and the whole path under it where they differ — so
                    what a row promises and what the chip becomes are one thing, and the reader can
                    still tell two files of the same name apart before they pick. */}
                <span
                  className={cn(
                    "min-w-0 truncate",
                    tag.kind === "file" ? "font-mono text-text-dim" : "text-foreground",
                  )}
                >
                  {reviewTagLabel(tag)}
                </span>
                {tag.kind === "file" && reviewTagLabel(tag) !== tag.path && (
                  <span className="ml-auto min-w-0 shrink truncate font-mono text-[10px] text-text-faint">
                    {tag.path}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <EditorContent editor={editor} className="min-w-0" />
    </>
  );
}

/**
 * One question's WORDS as a document, with its tags as chips.
 *
 * It is the read half of `ReviewTagNode.renderText`: that turns a chip into its words, and this turns
 * words back into chips. Both go through `reviewQuestionParts`, so a question written by hand, one
 * built by picking, and one handed back after a failure all draw the same thing.
 */
function reviewQuestionDoc(text: string, tags: ReviewTag[]) {
  const parts = reviewQuestionParts(text, tags);
  const content = parts.flatMap((part) =>
    part.kind === "text"
      ? part.text.split("\n").flatMap((line, index) =>
          index === 0
            ? line
              ? [{ type: "text", text: line }]
              : []
            : [{ type: "hardBreak" }, ...(line ? [{ type: "text", text: line }] : [])],
        )
      : [
          {
            type: "reviewTag",
            attrs:
              part.tag.kind === "theme"
                ? { kind: "theme", index: part.tag.index, label: part.tag.label }
                : { kind: "file", path: part.tag.path, label: part.tag.label },
          },
        ],
  );
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

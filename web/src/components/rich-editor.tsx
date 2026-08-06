import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BoldIcon,
  CodeIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link02Icon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
} from "@hugeicons/core-free-icons";
import { answerRequest, type AgentAnswer } from "~/lib/agent-answer";
import { COMPOSER_FIELD_CLASS } from "~/lib/composer-field";
import {
  mentionOptions,
  mentionQueryBefore,
  type AgentCandidate,
  type MentionCandidate,
  type MentionOption,
  type OutboundMention,
} from "~/lib/mentions";
import {
  emojiQueryBefore,
  emojiSuggestions,
  insertedEmojiName,
  type CustomEmoji,
  type EmojiSuggestion,
} from "~/lib/custom-emoji";
import { serializeTeamsMessage } from "~/lib/rich-text";
import { cn } from "~/lib/utils";
import { AgentTagNode } from "./agent-tag-extension";
import { MentionNode } from "./mention-extension";
import { MentionSuggestions } from "./mention-suggestions";
import { CustomEmojiNode } from "./custom-emoji-extension";
import { EmojiSuggestions } from "./emoji-suggestions";

// The editor is deliberately restricted to the formatting Microsoft Teams
// accepts in RichText/Html: bold, italic, underline, strikethrough, inline code,
// links, and bullet/ordered lists. Headings, horizontal rules, code blocks, and
// blockquotes are disabled so we never emit markup Teams would drop or mangle
// (the reply quote is a blockquote the backend owns).
const EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    horizontalRule: false,
    codeBlock: false,
    blockquote: false,
    link: {
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https",
      HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
    },
  }),
  Placeholder.configure({
    placeholder: "Write a message…",
  }),
  // @mentions: an atomic inline node that carries who is mentioned, shrinks by one
  // word per Backspace, and serializes to the markup Teams notifies people from.
  MentionNode,
  // Agent tags: the same shape of node for a thing that is not a person — it summons a
  // CLI on the backend's machine and serializes to the plain prefix that trigger reads.
  AgentTagNode,
  // Custom emoji: an atomic inline node holding an emoji name, which serializes to the
  // bare :name: text the backend substitutes. One Backspace removes it whole.
  CustomEmojiNode,
];

/** `useLayoutEffect` in the browser, `useEffect` on the server (where there is no
 *  layout and React warns about the former). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** An "@…" being typed: what was typed, the document range it occupies (so picking
 *  somebody replaces exactly that text), and whether it opens the message. */
type MentionQueryState = { query: string; from: number; to: number; atStart: boolean };

/** A ":…" being typed: what was typed, the document range it occupies (so picking
 *  an emoji replaces exactly that text). */
type EmojiQueryState = { query: string; from: number; to: number };

/** A message on its way out: the words it took, the range of the document they came from,
 *  and every change the document has taken since — so the words that LEFT can be taken out
 *  of the field without touching the ones typed while it was in flight (see
 *  {@link removeSentWords}). */
type SentWords = { words: string; from: number; to: number; mapping: Mapping };

/** The words of a document range, an atom (a mention chip, an agent tag) counted as the one
 *  character it occupies — the reading `mentionQueryInEditor` already works in, and the one
 *  thing that stays comparable while the document changes around the range. */
function wordsBetween(doc: ProseMirrorNode, from: number, to: number): string {
  return doc.textBetween(from, to, "\n", "\ufffc");
}

/**
 * Put the caret in the field, in the caller's own task.
 *
 * TipTap finishes its own focus inside a `requestAnimationFrame`, and a frame is long
 * enough for the reader to have started typing — those keystrokes land nowhere. A phone
 * is stricter still: it raises its keyboard only for a focus that happens in the gesture
 * that asked for one, which a deferred focus is not. So the element is focused first and
 * the command only places the caret.
 */
function focusEditor(editor: Editor): void {
  // The command scrolls the field into view itself, so this half must not do it too.
  editor.view.dom.focus({ preventScroll: true });
  editor.commands.focus("end");
}

/**
 * Take the words that were just sent back out of the field, and leave everything else.
 *
 * A send is not instant, so the field can hold more than it did when the message left —
 * the next word the reader started typing, or the correction a phone's keyboard commits
 * as Enter is pressed. Clearing the whole field then erases words nobody sent, and
 * leaving the whole field reads as a message that never went: the box still shows what
 * just left, and the next Enter posts it a second time. Both happened, so neither is the
 * rule: the sent range is followed through every change the document took and only that
 * range goes.
 *
 * Nothing is removed unless the range still holds exactly the words that left. A reader who
 * rewrote the draft while it travelled — selected it all and typed something else — keeps
 * every word of what they wrote, because a guess at where the sent words went would take
 * their message instead of ours.
 */
function removeSentWords(editor: Editor, sent: SentWords): void {
  if (sent.mapping.maps.length === 0) {
    // The common case: the field is untouched, so it goes back to a clean empty
    // document rather than to an emptied one (no leftover marks, no leftover blocks).
    editor.commands.clearContent();
    return;
  }
  // A word typed AT either edge belongs to the reader, not to the message: the biases keep
  // an insertion at `from` in front of the range and one at `to` behind it.
  const from = sent.mapping.map(sent.from, 1);
  const to = sent.mapping.map(sent.to, -1);
  if (from >= to || wordsBetween(editor.state.doc, from, to) !== sent.words) return;
  editor.commands.deleteRange({ from, to });
}

/** The `@…` the caret sits in, in document coordinates, or null when it sits in
 *  ordinary text. The text is read from the caret's own block, so a mention can only
 *  start at the beginning of a line or after a space (see `mentionQueryBefore`).
 *
 *  `atStart` says whether this "@" OPENS the message — the document's first block, with
 *  nothing but whitespace in front of it. Only there does a prefix summon an agent
 *  (`agent_policy::split_prefix`), so only there is one offered. */
function mentionQueryInEditor(editor: Editor): MentionQueryState | null {
  const { $from, empty } = editor.state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  // An atom (an existing mention, an image) counts as one non-space character, so the
  // offsets below line up with document positions.
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const found = mentionQueryBefore(before);
  if (!found) return null;
  // A paragraph straight in the document, and its first one: a list item, or a second
  // block, carries text ahead of the prefix even when its own line does not.
  const atStart =
    $from.depth === 1 && $from.index(0) === 0 && before.slice(0, found.at).trim() === "";
  return { query: found.query, from: $from.start() + found.at, to: $from.pos, atStart };
}

/** The `:\u2026` the caret sits in, in document coordinates, or null when it sits in
 *  ordinary text. The text is read from the caret's own block, so an emoji code can only
 *  start at the beginning of a line or after a space (see `emojiQueryBefore`). */
function emojiQueryInEditor(editor: Editor): EmojiQueryState | null {
  const { $from, empty } = editor.state.selection;
  if (!empty || !$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const found = emojiQueryBefore(before);
  if (!found) return null;
  return { query: found.query, from: $from.start() + found.at, to: $from.pos };
}

/** Prompt for a URL and apply it as a link to the current selection. */
function promptForLink(editor: Editor) {
  const previous = editor.getAttributes("link").href as string | undefined;
  const url = window.prompt("Link URL", previous ?? "https://");
  if (url === null) return; // cancelled
  if (url.trim() === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
}

/**
 * A Teams-compatible rich-text message editor built on TipTap. It is the only
 * message field the composer has: Enter sends, Shift+Enter inserts a line break,
 * Cmd/Ctrl+B/I/U format the selection, and Cmd/Ctrl+K adds a link — always, whether
 * or not the composer shows the format bar.
 *
 * Formatting is therefore reachable two ways, and never both at once: the composer's
 * own {@link FormatToolbar} when the user opened it, and a floating BubbleMenu over
 * the selection when they did not. On submit the HTML is normalized to the
 * Teams-safe subset by {@link serializeTeamsMessage}, which also hands back who the
 * body's @mentions name.
 *
 * Typing "@" opens the mention list (see `mentionQueryInEditor` and
 * `MentionSuggestions`): arrows move, Enter or Tab picks, Escape closes it and leaves
 * the "@" as text. A picked person becomes one atomic node whose name shrinks by a word
 * per Backspace, exactly as in Teams (see components/mention-extension.ts).
 *
 * An "@" that OPENS the message also offers the agents this machine can run, above the
 * people. That tag is a different node and a different promise — it notifies nobody and
 * starts a program instead (see components/agent-tag-extension.ts) — so it is drawn
 * differently and it goes out as the plain prefix the backend's trigger reads.
 */
export function RichEditor(props: {
  initialContent: string;
  focusToken: unknown;
  onSubmit: (html: string, mentions: OutboundMention[]) => Promise<boolean>;
  /** Whether the composer already shows a format bar — then the selection menu stays
   *  away, so the same buttons are never offered twice. */
  toolbarVisible?: boolean;
  /** Handles image clipboard items before ProseMirror inserts them as content. */
  onPaste?: (event: ReactClipboardEvent) => void;
  /** Registers the editor's submit fn so an outside control (send button) can call it. */
  submitRef?: MutableRefObject<(() => void) | null>;
  /** Registers a focus fn so clicking the composer's dead space can focus the editor. */
  focusRef?: MutableRefObject<(() => void) | null>;
  /** Reports whether the editor is empty, so the send button can reflect it. */
  onEmptyChange?: (empty: boolean) => void;
  /** Mirrors the editor's plain text out, so the composer can persist it as the draft. */
  onChangeText?: (text: string) => void;
  /** Hands the live editor out, so the composer can drive it from its format bar. */
  onEditorChange?: (editor: Editor | null) => void;
  /** The people this conversation can mention. */
  mentionCandidates?: readonly MentionCandidate[];
  /** The agents this conversation can summon — empty unless one really would answer
   *  (see `agentCandidatesFor`). */
  agentCandidates?: readonly AgentCandidate[];
  /** An "Answer with <agent>" — or a "Review with <agent>" — picked from a message's own
   *  menu: the tag it asks for is put at the front of the draft, with that row's own
   *  request behind it, once per token (see lib/agent-answer.ts). */
  agentAnswer?: AgentAnswer | null;
  /** Called the moment an "@…" starts, so the candidates can be fetched on demand. */
  onMentionQuery?: () => void;
  /** The custom emoji pack this machine holds. */
  customEmojiPack: readonly CustomEmoji[];
  /** The Unicode emoji shortcodes (lazy-loaded). */
  unicodeShortcodes: ReadonlyArray<readonly [string, string]>;
}) {
  // The mention list, mirrored into a ref because `handleKeyDown` is created once with
  // the editor and would otherwise read the state of the first render forever.
  const [mention, setMention] = useState<MentionQueryState | null>(null);
  const mentionRef = useRef<MentionQueryState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);
  const rankedRef = useRef<MentionOption[]>([]);
  // The exact query the user dismissed with Escape. Typing on reopens the list; the
  // same query does not, so Escape means "not this one" rather than "not ever".
  const dismissedRef = useRef<string | null>(null);
  // The message currently on its way out, and where its words sit in the document as the
  // reader keeps typing into it (see `submit` and `removeSentWords`).
  const sentRef = useRef<SentWords | null>(null);

  const setMentionState = (next: MentionQueryState | null) => {
    mentionRef.current = next;
    setMention(next);
  };
  const setActive = (index: number) => {
    activeIndexRef.current = index;
    setActiveIndex(index);
  };
  const closeMentions = () => {
    setMentionState(null);
    setActive(0);
  };

  // The emoji list, mirrored into a ref for the same reason as mentions.
  const [emoji, setEmoji] = useState<EmojiQueryState | null>(null);
  const emojiRef = useRef<EmojiQueryState | null>(null);
  const [emojiActiveIndex, setEmojiActiveIndex] = useState(0);
  const emojiActiveIndexRef = useRef(0);
  const emojiRankedRef = useRef<EmojiSuggestion[]>([]);
  const emojiDismissedRef = useRef<string | null>(null);
  // The pack and shortcodes, in refs so the suggestion logic reads the latest values.
  const customEmojiPackRef = useRef(props.customEmojiPack);
  const unicodeShortcodesRef = useRef(props.unicodeShortcodes);

  customEmojiPackRef.current = props.customEmojiPack;
  unicodeShortcodesRef.current = props.unicodeShortcodes;

  const setEmojiState = (next: EmojiQueryState | null) => {
    emojiRef.current = next;
    setEmoji(next);
  };
  const setEmojiActive = (index: number) => {
    emojiActiveIndexRef.current = index;
    setEmojiActiveIndex(index);
  };
  const closeEmoji = () => {
    setEmojiState(null);
    setEmojiActive(0);
  };

  /** Re-read the "@…" under the caret after anything that can move or change it. */
  const syncMentions = (editor: Editor) => {
    const found = mentionQueryInEditor(editor);
    if (!found) {
      dismissedRef.current = null;
      if (mentionRef.current) closeMentions();
      return;
    }
    if (dismissedRef.current === found.query) return;
    dismissedRef.current = null;
    const previous = mentionRef.current;
    setMentionState(found);
    // A different query is a different list: start at its best match.
    if (!previous || previous.query !== found.query) setActive(0);
    props.onMentionQuery?.();
  };

  /** Re-read the ":…" under the caret after anything that can move or change it. */
  const syncEmoji = (editor: Editor) => {
    const found = emojiQueryInEditor(editor);
    if (!found) {
      emojiDismissedRef.current = null;
      if (emojiRef.current) closeEmoji();
      return;
    }
    if (emojiDismissedRef.current === found.query) return;
    emojiDismissedRef.current = null;
    const previous = emojiRef.current;
    setEmojiState(found);
    if (!previous || previous.query !== found.query) setEmojiActive(0);
  };

  const editor = useEditor({
    // TanStack Start renders on the server; ProseMirror needs the DOM, so defer
    // creation to the client to avoid a hydration mismatch.
    immediatelyRender: false,
    extensions: EXTENSIONS,
    content: props.initialContent,
    onCreate: ({ editor }) => props.onEmptyChange?.(editor.isEmpty),
    onUpdate: ({ editor }) => {
      props.onEmptyChange?.(editor.isEmpty);
      props.onChangeText?.(editor.getText());
      syncMentions(editor);
      syncEmoji(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      syncMentions(editor);
      syncEmoji(editor);
    },
    // Follow the words of a message that is in flight through every change the document
    // takes while it travels, so the send that lands takes exactly those words out.
    onTransaction: ({ transaction }) => {
      if (transaction.docChanged) sentRef.current?.mapping.appendMapping(transaction.mapping);
    },
    onBlur: () => {
      closeMentions();
      closeEmoji();
    },
    editorProps: {
      attributes: {
        // The field metrics come from the shared constant, so the placeholder the
        // composer shows until this editor mounts is exactly as tall as the editor.
        class: cn(COMPOSER_FIELD_CLASS, "tiptap-message overflow-y-auto outline-none"),
      },
      handleKeyDown: (_view, event) => {
        // The mention list owns the keyboard while it is open and has somebody to
        // offer, so Enter picks a person instead of sending a half-typed name.
        const mentionOpen = mentionRef.current !== null && rankedRef.current.length > 0;
        if (mentionOpen) {
          const count = rankedRef.current.length;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((activeIndexRef.current + step + count) % count);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const option = rankedRef.current[activeIndexRef.current];
            if (option) pick(option);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            // The list, and only the list. Escape is also the app's "leave this
            // thread"/"cancel the reply" key, and closing a menu must not do either.
            event.stopPropagation();
            dismissedRef.current = mentionRef.current?.query ?? null;
            closeMentions();
            return true;
          }
        }
        // The emoji list owns the keyboard while it is open and has something to offer.
        const emojiOpen = emojiRef.current !== null && emojiRankedRef.current.length > 0;
        if (emojiOpen) {
          const count = emojiRankedRef.current.length;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setEmojiActive((emojiActiveIndexRef.current + step + count) % count);
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const suggestion = emojiRankedRef.current[emojiActiveIndexRef.current];
            if (suggestion) pickEmoji(suggestion);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            emojiDismissedRef.current = emojiRef.current?.query ?? null;
            closeEmoji();
            return true;
          }
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
          return true;
        }
        const mod = event.metaKey || event.ctrlKey;
        if (mod && (event.key === "k" || event.key === "K")) {
          event.preventDefault();
          if (editor) promptForLink(editor);
          return true;
        }
        return false;
      },
    },
  });

  // The ranked list this render shows. Kept in a ref as well, for `handleKeyDown`.
  const ranked = mention
    ? mentionOptions({
        people: props.mentionCandidates ?? [],
        agents: props.agentCandidates ?? [],
        query: mention.query,
        atMessageStart: mention.atStart,
      })
    : [];
  rankedRef.current = ranked;

  // The ranked emoji list this render shows. Kept in a ref as well, for `handleKeyDown`.
  const rankedEmoji = emoji
    ? emojiSuggestions(
        emoji.query,
        customEmojiPackRef.current,
        unicodeShortcodesRef.current,
      )
    : [];
  emojiRankedRef.current = rankedEmoji;

  /** Replace the typed "@…" with the thing that was picked: a mention of a person, or a
   *  tag summoning an agent. */
  const pick = (option: MentionOption) => {
    const state = mentionRef.current;
    if (!editor || !state) return;
    closeMentions();
    const { from, to } = state;
    if (option.kind === "agent") {
      editor
        .chain()
        .insertAgentTag({ backend: option.agent.backend, prefix: option.agent.prefix, from, to })
        .run();
      return;
    }
    editor
      .chain()
      .insertMention({ mri: option.person.mri, label: option.person.name, from, to })
      .run();
  };

  /** Replace the typed ":…" with the picked emoji: a custom emoji chip or a Unicode
   *  character. An alias serializes to its target, so the backend substitutes the right
   *  art. */
  const pickEmoji = (suggestion: EmojiSuggestion) => {
    const state = emojiRef.current;
    if (!editor || !state) return;
    closeEmoji();
    const { from, to } = state;
    if (suggestion.kind === "unicode") {
      editor.chain().insertContentAt({ from, to }, suggestion.native + " ").run();
      return;
    }
    const target = insertedEmojiName(suggestion, customEmojiPackRef.current);
    editor
      .chain()
      .insertCustomEmoji({ name: suggestion.name, target, from, to })
      .run();
  };

  const submit = () => {
    if (!editor) return;
    closeMentions();
    closeEmoji();
    const { html, mentions } = serializeTeamsMessage(editor.getHTML());
    // A send while one is already out is refused by the composer, so what it answers says
    // nothing about the words in the field: the message in flight still owns them.
    if (sentRef.current) {
      void props.onSubmit(html, mentions);
      return;
    }
    const doc = editor.state.doc;
    const from = Selection.atStart(doc).from;
    const to = Selection.atEnd(doc).to;
    const sent: SentWords = {
      words: wordsBetween(doc, from, to),
      from,
      to,
      mapping: new Mapping(),
    };
    sentRef.current = sent;
    void props.onSubmit(html, mentions).then((accepted) => {
      if (sentRef.current !== sent) return;
      sentRef.current = null;
      // A refused send keeps every word where it is, beside the sentence saying why it
      // did not leave (see the composer's `sendError`).
      if (!accepted || editor.isDestroyed) return;
      removeSentWords(editor, sent);
    });
  };

  // The caret belongs in the field the moment somebody asks for it — a reply, a fresh
  // thread, a click on the box's dead space. A layout effect keeps it in the same task as
  // the click that asked, which is what a phone's keyboard waits for.
  useIsomorphicLayoutEffect(() => {
    if (editor) focusEditor(editor);
  }, [editor, props.focusToken]);

  // "Answer with <agent>", from a message's ⋯ menu: lead the draft with that agent's tag
  // and leave the caret after it, so the user only has to send (or say more first). The
  // token is what makes it happen once per pick — the same pick on the same message must
  // not re-insert the tag on every unrelated re-render.
  const answerToken = props.agentAnswer?.token;
  const appliedAnswer = useRef<number | null>(null);
  useEffect(() => {
    const answer = props.agentAnswer;
    if (!editor || !answer || appliedAnswer.current === answer.token) return;
    appliedAnswer.current = answer.token;
    editor.commands.leadAgentTag({
      backend: answer.backend,
      prefix: answer.prefix,
      request: answerRequest(editor.getText(), answer.request),
    });
    // `props.agentAnswer` is read through its own token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, answerToken]);

  // Expose submit so the composer's send button can trigger it from the outside.
  useEffect(() => {
    const ref = props.submitRef;
    if (!ref) return;
    ref.current = submit;
    return () => {
      ref.current = null;
    };
  });

  // Expose focus so clicking the composer's dead space can focus the editor.
  useEffect(() => {
    const ref = props.focusRef;
    if (!ref) return;
    ref.current = () => {
      if (editor) focusEditor(editor);
    };
    return () => {
      ref.current = null;
    };
  });

  // Hand the editor to the composer, which renders the format bar in its own top
  // section. The composer keys this component per conversation, so the null on
  // unmount is what stops the bar driving a dead editor.
  const onEditorChange = props.onEditorChange;
  useEffect(() => {
    onEditorChange?.(editor ?? null);
    return () => onEditorChange?.(null);
  }, [editor, onEditorChange]);

  if (!editor) {
    // Reserve the field height so the composer doesn't jump on hydration.
    return <div className={COMPOSER_FIELD_CLASS} aria-hidden />;
  }

  return (
    <div className="relative w-full">
      {/* The mention list, anchored to the field's own box (see MentionSuggestions).
          It is rendered only while an "@…" is being typed AND somebody matches it. */}
      {mention && (
        <MentionSuggestions
          options={ranked}
          activeIndex={activeIndex}
          onPick={pick}
          onActivate={setActive}
        />
      )}
      {/* The emoji list, anchored to the field's own box (see EmojiSuggestions).
          It is rendered only while a ":…" is being typed AND something matches it. */}
      {emoji && (
        <EmojiSuggestions
          suggestions={rankedEmoji}
          activeIndex={emojiActiveIndex}
          onPick={pickEmoji}
          onActivate={setEmojiActive}
        />
      )}
      {/* The select-to-format menu, for when the composer's format bar is closed.
          It is not the only way to format: the keyboard (Cmd/Ctrl+B/I/U, Cmd/Ctrl+K)
          always works, bar or no bar. */}
      {!props.toolbarVisible && (
        <BubbleMenu
          editor={editor}
          className="flex items-center gap-0.5 rounded-xl bg-popover p-1 shadow-pop"
        >
          <FormatToolbar editor={editor} />
        </BubbleMenu>
      )}
      <EditorContent editor={editor} data-testid="composer-rich" onPaste={props.onPaste} />
    </div>
  );
}

/** The marks and lists the bar offers, in the order it shows them. `null` draws the
 *  separator between the character formats and the two list formats. */
const FORMATS = [
  { name: "bold", label: "Bold", icon: BoldIcon, toggle: "toggleBold" },
  { name: "italic", label: "Italic", icon: TextItalicIcon, toggle: "toggleItalic" },
  { name: "underline", label: "Underline", icon: TextUnderlineIcon, toggle: "toggleUnderline" },
  { name: "strike", label: "Strikethrough", icon: TextStrikethroughIcon, toggle: "toggleStrike" },
  { name: "code", label: "Inline code", icon: CodeIcon, toggle: "toggleCode" },
  { name: "link", label: "Link", icon: Link02Icon, toggle: null },
  null,
  {
    name: "bulletList",
    label: "Bulleted list",
    icon: LeftToRightListBulletIcon,
    toggle: "toggleBulletList",
  },
  {
    name: "orderedList",
    label: "Numbered list",
    icon: LeftToRightListNumberIcon,
    toggle: "toggleOrderedList",
  },
] as const;

/**
 * One row of format buttons over the editor's current selection.
 *
 * The composer shows it in its own top section when the user asks for it (the `Type`
 * button); the BubbleMenu above shows the same row over the selection when they did
 * not. Both drive the same editor, so formatting reads the same either way.
 *
 * The active flags come through `useEditorState`, so the row follows the CARET as
 * well as the typing: the composer that renders the bar does not re-render on a
 * transaction of its own, and a highlight that only tracked edits would lie every
 * time the user clicked into a bold word.
 */
export function FormatToolbar(props: { editor: Editor }) {
  const { editor } = props;
  const active = useEditorState({
    editor,
    selector: ({ editor }) =>
      FORMATS.map((format) => (format ? editor.isActive(format.name) : false)),
  });
  return (
    <>
      {FORMATS.map((format, index) =>
        format === null ? (
          <span key="sep" className="mx-0.5 h-4 w-px bg-border-subtle" aria-hidden />
        ) : (
          <FmtButton
            key={format.name}
            label={format.label}
            active={active[index] ?? false}
            onClick={() =>
              format.toggle === null
                ? promptForLink(editor)
                : editor.chain().focus()[format.toggle]().run()
            }
          >
            <HugeiconsIcon icon={format.icon} className="size-4" strokeWidth={1.8} />
          </FmtButton>
        ),
      )}
    </>
  );
}

function FmtButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      // Keep focus in the editor so toggling from the BubbleMenu preserves the selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      className={cn(
        "grid size-7 cursor-pointer place-items-center rounded-md text-text-dim transition-colors hover:bg-accent hover:text-foreground",
        props.active && "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
      )}
    >
      {props.children}
    </button>
  );
}

import {
  useEffect,
  type ClipboardEvent as ReactClipboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
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
import { COMPOSER_FIELD_CLASS } from "~/lib/composer-field";
import { serializeTeamsHtml } from "~/lib/rich-text";
import { cn } from "~/lib/utils";

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
];

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
 * Teams-safe subset by {@link serializeTeamsHtml}.
 */
export function RichEditor(props: {
  initialContent: string;
  focusToken: unknown;
  onSubmit: (html: string) => Promise<boolean>;
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
}) {
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
    },
    editorProps: {
      attributes: {
        // The field metrics come from the shared constant, so the placeholder the
        // composer shows until this editor mounts is exactly as tall as the editor.
        class: cn(COMPOSER_FIELD_CLASS, "tiptap-message overflow-y-auto outline-none"),
      },
      handleKeyDown: (_view, event) => {
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

  const submit = () => {
    if (!editor) return;
    const html = serializeTeamsHtml(editor.getHTML());
    const submittedHtml = html;
    void props.onSubmit(html).then((sent) => {
      if (!sent || !editor || serializeTeamsHtml(editor.getHTML()) !== submittedHtml) return;
      editor.commands.clearContent();
    });
  };

  useEffect(() => {
    editor?.commands.focus("end");
  }, [editor, props.focusToken]);

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
    ref.current = () => editor?.commands.focus("end");
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
    <div className="w-full">
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

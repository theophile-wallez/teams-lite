import { useEffect, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  TextBoldIcon,
  TextItalicIcon,
  TextUnderlineIcon,
  TextStrikethroughIcon,
  SourceCodeIcon,
  Link01Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
} from "@hugeicons/core-free-icons";
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
    placeholder: "Write a message…  (Enter to send, Shift+Enter for a new line)",
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
 * A Teams-compatible rich-text message editor built on TipTap. Enter sends,
 * Shift+Enter inserts a line break, Cmd/Ctrl+B/I/U format the selection, and
 * Cmd/Ctrl+K adds a link. A floating BubbleMenu appears over the selection and a
 * static toolbar sits above the field. On submit the HTML is normalized to the
 * Teams-safe subset by {@link serializeTeamsHtml}.
 */
export function RichEditor(props: {
  initialContent: string;
  focusToken: unknown;
  onSubmit: (html: string) => void;
}) {
  const editor = useEditor({
    // TanStack Start renders on the server; ProseMirror needs the DOM, so defer
    // creation to the client to avoid a hydration mismatch.
    immediatelyRender: false,
    extensions: EXTENSIONS,
    content: props.initialContent,
    editorProps: {
      attributes: {
        class: "tiptap-message max-h-64 min-h-[1.5rem] w-full overflow-y-auto outline-none",
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
    if (!html) return;
    props.onSubmit(html);
    editor.commands.clearContent();
  };

  useEffect(() => {
    editor?.commands.focus("end");
  }, [editor, props.focusToken]);

  if (!editor) {
    // Reserve the field height so the composer doesn't jump on hydration.
    return <div className="min-h-[1.5rem] w-full py-1 text-sm text-text-faint" aria-hidden />;
  }

  return (
    <div className="w-full">
      <Toolbar editor={editor} onLink={() => promptForLink(editor)} />
      <BubbleMenu
        editor={editor}
        className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-md"
      >
        <ToolbarButtons editor={editor} onLink={() => promptForLink(editor)} />
      </BubbleMenu>
      <EditorContent editor={editor} data-testid="composer-rich" className="text-sm" />
    </div>
  );
}

function Toolbar(props: { editor: Editor; onLink: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-0.5 border-b border-border pb-2">
      <ToolbarButtons editor={props.editor} onLink={props.onLink} />
    </div>
  );
}

function ToolbarButtons(props: { editor: Editor; onLink: () => void }) {
  const { editor } = props;
  return (
    <>
      <FmtButton
        label="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <HugeiconsIcon icon={TextBoldIcon} size={16} />
      </FmtButton>
      <FmtButton
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <HugeiconsIcon icon={TextItalicIcon} size={16} />
      </FmtButton>
      <FmtButton
        label="Underline"
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <HugeiconsIcon icon={TextUnderlineIcon} size={16} />
      </FmtButton>
      <FmtButton
        label="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <HugeiconsIcon icon={TextStrikethroughIcon} size={16} />
      </FmtButton>
      <FmtButton
        label="Inline code"
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <HugeiconsIcon icon={SourceCodeIcon} size={16} />
      </FmtButton>
      <FmtButton label="Link" active={editor.isActive("link")} onClick={props.onLink}>
        <HugeiconsIcon icon={Link01Icon} size={16} />
      </FmtButton>
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <FmtButton
        label="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <HugeiconsIcon icon={LeftToRightListBulletIcon} size={16} />
      </FmtButton>
      <FmtButton
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <HugeiconsIcon icon={LeftToRightListNumberIcon} size={16} />
      </FmtButton>
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
        "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-element hover:text-foreground",
        props.active && "bg-element text-primary",
      )}
    >
      {props.children}
    </button>
  );
}

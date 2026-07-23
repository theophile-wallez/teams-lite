import { useEffect, type MutableRefObject, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Strikethrough,
  Underline,
} from "lucide-react";
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
  /** Registers the editor's submit fn so an outside control (send button) can call it. */
  submitRef?: MutableRefObject<(() => void) | null>;
  /** Registers a focus fn so clicking the composer's dead space can focus the editor. */
  focusRef?: MutableRefObject<(() => void) | null>;
  /** Reports whether the editor is empty, so the send button can reflect it. */
  onEmptyChange?: (empty: boolean) => void;
}) {
  const editor = useEditor({
    // TanStack Start renders on the server; ProseMirror needs the DOM, so defer
    // creation to the client to avoid a hydration mismatch.
    immediatelyRender: false,
    extensions: EXTENSIONS,
    content: props.initialContent,
    onCreate: ({ editor }) => props.onEmptyChange?.(editor.isEmpty),
    onUpdate: ({ editor }) => props.onEmptyChange?.(editor.isEmpty),
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

  if (!editor) {
    // Reserve the field height so the composer doesn't jump on hydration.
    return (
      <div className="min-h-[1.5rem] w-full py-1 text-base text-text-faint md:text-sm" aria-hidden />
    );
  }

  return (
    <div className="w-full">
      <Toolbar editor={editor} onLink={() => promptForLink(editor)} />
      <BubbleMenu
        editor={editor}
        className="flex items-center gap-0.5 rounded-xl bg-popover p-1 shadow-pop"
      >
        <ToolbarButtons editor={editor} onLink={() => promptForLink(editor)} />
      </BubbleMenu>
      {/* `text-base` (16px) on mobile stops iOS Safari auto-zooming on focus;
          `md:text-sm` keeps 14px on desktop. */}
      <EditorContent editor={editor} data-testid="composer-rich" className="text-base md:text-sm" />
    </div>
  );
}

function Toolbar(props: { editor: Editor; onLink: () => void }) {
  return (
    <div className="mb-2 flex items-center gap-0.5 border-b border-border-subtle pb-2">
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
        <Bold className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <FmtButton
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <FmtButton
        label="Underline"
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Underline className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <FmtButton
        label="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <FmtButton
        label="Inline code"
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
      >
        <Code className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <FmtButton label="Link" active={editor.isActive("link")} onClick={props.onLink}>
        <Link2 className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <span className="mx-0.5 h-4 w-px bg-border-subtle" aria-hidden />
      <FmtButton
        label="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className="size-4" strokeWidth={1.8} />
      </FmtButton>
      <FmtButton
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-4" strokeWidth={1.8} />
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
        "grid size-7 cursor-pointer place-items-center rounded-md text-text-dim transition-colors hover:bg-accent hover:text-foreground",
        props.active && "bg-primary/12 text-primary hover:bg-primary/15 hover:text-primary",
      )}
    >
      {props.children}
    </button>
  );
}

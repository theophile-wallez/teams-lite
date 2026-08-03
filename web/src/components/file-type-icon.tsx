import { fileKind, type FileKind } from "~/lib/file-kind";
import { cn } from "~/lib/utils";

/**
 * The icon of a shared document, coloured by what the document is: a blue W for a
 * Word file, an orange P for a deck, a green X for a sheet, a red mark for a PDF,
 * a hill for a picture, and so on. It replaces one generic grey page for every
 * attachment, so a person scanning a thread reads the type before the name.
 *
 * One silhouette carries all of them — a page with a folded corner, on a 24×24
 * grid — and the family glyph is *cut out* of that page rather than drawn over it.
 * A stencil needs no second colour, so the same icon sits on a chip, on a bubble
 * or on a mail row without ever painting a background it does not know about.
 *
 * The colours live in `theme.css` as `--file-*` (mapped to `text-file-*`
 * utilities), one pair per family, because a saturated red that reads on white is
 * mud on the dark page. They are the one deliberate exception to the theme's
 * single-accent rule: here the colour *is* the information.
 *
 * The four Office/PDF glyphs come from the Material Icon Theme (MIT,
 * github.com/material-extensions/vscode-material-icon-theme) — the marks VS Code
 * draws at this exact size, so their letters hold at 16px. The rest are drawn to
 * match: same grid, same page, same stencil.
 */

/** The shared page: body plus the folded top-right corner, cut out. */
const PAGE = "M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1.5V9h5.5z";

type FileTypeGlyph = {
  /** Path data for the whole icon: the page, then the cut-out family glyph. */
  path: string;
  /** The Tailwind text colour that `fill="currentColor"` picks up. */
  color: string;
};

const GLYPHS: Record<FileKind, FileTypeGlyph> = {
  word: {
    path: `${PAGE}M7 13l1.5 7h2l1.5-3 1.5 3h2l1.5-7h1v-2h-4v2h1l-.9 4.2L13 15h-2l-1.1 2.2L9 13h1v-2H6v2z`,
    color: "text-file-word",
  },
  excel: {
    path: `${PAGE}M17 11h-4v2h1l-2 1.67L10 13h1v-2H7v2h1l3 2.5L8 18H7v2h4v-2h-1l2-1.67L14 18h-1v2h4v-2h-1l-3-2.5 3-2.5h1z`,
    color: "text-file-excel",
  },
  powerpoint: {
    path: `${PAGE}M8 11v2h1v6H8v1h4v-1h-1v-2h2a3 3 0 0 0 3-3 3 3 0 0 0-3-3zm5 2a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-2v-2z`,
    color: "text-file-powerpoint",
  },
  pdf: {
    // The Acrobat swash, which needs the whole path (its pieces are positioned
    // relative to the page outline), so this one does not reuse PAGE.
    path: "M13 9h5.5L13 3.5zM6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m4.93 10.44c.41.9.93 1.64 1.53 2.15l.41.32c-.87.16-2.07.44-3.34.93l-.11.04.5-1.04c.45-.87.78-1.66 1.01-2.4m6.48 3.81c.18-.18.27-.41.28-.66.03-.2-.02-.39-.12-.55-.29-.47-1.04-.69-2.28-.69l-1.29.07-.87-.58c-.63-.52-1.2-1.43-1.6-2.56l.04-.14c.33-1.33.64-2.94-.02-3.6a.85.85 0 0 0-.61-.24h-.24c-.37 0-.7.39-.79.77-.37 1.33-.15 2.06.22 3.27v.01c-.25.88-.57 1.9-1.08 2.93l-.96 1.8-.89.49c-1.2.75-1.77 1.59-1.88 2.12-.04.19-.02.36.05.54l.03.05.48.31.44.11c.81 0 1.73-.95 2.97-3.07l.18-.07c1.03-.33 2.31-.56 4.03-.75 1.03.51 2.24.74 3 .74.44 0 .74-.11.91-.3m-.41-.71.09.11c-.01.1-.04.11-.09.13h-.04l-.19.02c-.46 0-1.17-.19-1.9-.51.09-.1.13-.1.23-.1 1.4 0 1.8.25 1.9.35M7.83 17c-.65 1.19-1.24 1.85-1.69 2 .05-.38.5-1.04 1.21-1.69zm3.02-6.91c-.23-.9-.24-1.63-.07-2.05l.07-.12.15.05c.17.24.19.56.09 1.1l-.03.16-.16.82z",
    color: "text-file-pdf",
  },
  image: {
    // A sun over a ridge — the one mark a picture reads as at any size.
    path: `${PAGE}M9.3 11.85a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 0 0 0-2.7zM6.6 19.4 10.2 14.6l2.4 3.2 1.6-1.9 3.2 3.5z`,
    color: "text-file-image",
  },
  video: {
    path: `${PAGE}M9.4 12.6 16 16 9.4 19.4z`,
    color: "text-file-video",
  },
  audio: {
    // An eighth note: the head's rightmost point is where the stem rises.
    path: `${PAGE}M11.4 15.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zM13.15 17v-4.6l3.3-1v1.8l-1.9.6V17z`,
    color: "text-file-audio",
  },
  archive: {
    path: `${PAGE}M11.1 11.2h1.9v1.9h-1.9zM13 13.1h1.9v1.9H13zM11.1 15h1.9v1.9h-1.9zM13 16.9h1.9v1.9H13z`,
    color: "text-file-archive",
  },
  code: {
    path: `${PAGE}M10.5 12.5 11.6 13.7 9.2 16 11.6 18.3 10.5 19.5 6.7 16zM13.5 12.5 12.4 13.7 14.8 16 12.4 18.3 13.5 19.5 17.3 16z`,
    color: "text-file-code",
  },
  text: {
    path: `${PAGE}M7.6 12.4h8.8v1.5H7.6zM7.6 15.2h8.8v1.5H7.6zM7.6 18h5.6v1.5H7.6z`,
    color: "text-file-text",
  },
  generic: {
    // No glyph: an unknown type shows a bare page instead of claiming a family.
    path: PAGE,
    color: "text-file-generic",
  },
};

/**
 * The coloured icon for one file. `name` decides the family, `contentType` breaks
 * the tie when the name carries no extension (see {@link fileKind}). Decorative by
 * default — the file name always sits next to it — so it is hidden from the
 * accessibility tree unless the caller passes a `title`.
 */
export function FileTypeIcon(props: {
  name: string;
  contentType?: string;
  className?: string;
  title?: string;
}) {
  const kind = fileKind(props.name, props.contentType);
  const glyph = GLYPHS[kind];

  return (
    <svg
      data-testid="file-type-icon"
      data-file-kind={kind}
      viewBox="0 0 24 24"
      className={cn("shrink-0", glyph.color, props.className)}
      role={props.title ? "img" : undefined}
      aria-hidden={props.title ? undefined : true}
      aria-label={props.title}
    >
      {props.title ? <title>{props.title}</title> : null}
      <path d={glyph.path} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

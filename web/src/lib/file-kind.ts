/**
 * The document family a shared file belongs to — what its icon shows.
 *
 * A chat or a mail carries a file name and, usually, a MIME type. The name is the
 * stronger signal of the two: Teams and Outlook both send
 * `application/octet-stream` for plenty of ordinary documents, while the
 * extension a person typed is nearly always right. The MIME type is the fallback,
 * and it earns its keep on a name with no extension at all.
 */
export type FileKind =
  | "word"
  | "excel"
  | "powerpoint"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "text"
  | "generic";

/** Extension → family. Lowercase, no leading dot. */
const KIND_BY_EXTENSION: Record<string, FileKind> = {
  // Word processors.
  doc: "word",
  docx: "word",
  docm: "word",
  dot: "word",
  dotx: "word",
  odt: "word",
  rtf: "word",
  pages: "word",
  // Spreadsheets.
  xls: "excel",
  xlsx: "excel",
  xlsm: "excel",
  xlsb: "excel",
  csv: "excel",
  tsv: "excel",
  ods: "excel",
  numbers: "excel",
  // Presentations.
  ppt: "powerpoint",
  pptx: "powerpoint",
  pptm: "powerpoint",
  pps: "powerpoint",
  ppsx: "powerpoint",
  odp: "powerpoint",
  key: "powerpoint",
  // Fixed layout.
  pdf: "pdf",
  // Pictures.
  png: "image",
  jpg: "image",
  jpeg: "image",
  jfif: "image",
  gif: "image",
  bmp: "image",
  webp: "image",
  avif: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",
  svg: "image",
  ico: "image",
  psd: "image",
  ai: "image",
  // Moving pictures.
  mp4: "video",
  m4v: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  wmv: "video",
  flv: "video",
  mpg: "video",
  mpeg: "video",
  // Sound.
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  aiff: "audio",
  wma: "audio",
  // Containers.
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  iso: "archive",
  // Source and structured data.
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  json: "code",
  jsonc: "code",
  xml: "code",
  yml: "code",
  yaml: "code",
  toml: "code",
  ini: "code",
  html: "code",
  htm: "code",
  css: "code",
  scss: "code",
  sql: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  ps1: "code",
  py: "code",
  rb: "code",
  rs: "code",
  go: "code",
  java: "code",
  kt: "code",
  swift: "code",
  c: "code",
  h: "code",
  cpp: "code",
  hpp: "code",
  cs: "code",
  php: "code",
  patch: "code",
  diff: "code",
  // Plain prose.
  txt: "text",
  md: "text",
  markdown: "text",
  rst: "text",
  log: "text",
};

/** MIME type → family, for a name that carries no usable extension. Matched on the
 *  full type first, then on the `image/` · `video/` · `audio/` group. */
const KIND_BY_MIME: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "application/msword": "word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
  "application/vnd.oasis.opendocument.text": "word",
  "application/rtf": "word",
  "application/vnd.ms-excel": "excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "excel",
  "application/vnd.oasis.opendocument.spreadsheet": "excel",
  "text/csv": "excel",
  "application/vnd.ms-powerpoint": "powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "powerpoint",
  "application/vnd.oasis.opendocument.presentation": "powerpoint",
  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
  "application/x-7z-compressed": "archive",
  "application/x-rar-compressed": "archive",
  "application/gzip": "archive",
  "application/x-tar": "archive",
  "application/json": "code",
  "application/xml": "code",
  "text/xml": "code",
  "text/html": "code",
  "text/plain": "text",
  "text/markdown": "text",
};

/** The extension of a file name, lowercase and without its dot; `""` when the name
 *  has none. A leading dot makes a hidden file, not an extension (`.gitignore`),
 *  and a run of digits is a version or a date, not a type (`report.2026`). */
export function fileExtension(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) && !/^\d+$/.test(ext) ? ext : "";
}

/** The document family of a shared file. Falls back to `"generic"`, which is a
 *  plain page — an unknown type says so rather than claiming to be a document. */
export function fileKind(name: string, contentType?: string): FileKind {
  const byExtension = KIND_BY_EXTENSION[fileExtension(name)];
  if (byExtension) return byExtension;

  // A content type may carry parameters: `text/plain; charset=utf-8`.
  const mime = (contentType ?? "").trim().toLowerCase().split(";")[0]!.trim();
  const byMime = KIND_BY_MIME[mime];
  if (byMime) return byMime;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/")) return "text";
  return "generic";
}

// Regenerates `src/lib/teams-emoji-catalog.ts` — the Teams reaction catalog.
//
// A Teams reaction is not an emoji on the wire: it is an "emotion key" out of
// Microsoft's own catalog (`like`, `fire`, `1f389_partypopper`, `yes-tone2`, …),
// and only Microsoft knows which key maps to which emoji. They publish exactly
// that table in the public Teams developer docs:
//
//   https://github.com/MicrosoftDocs/msteams-docs
//   msteams-platform/agents-in-teams/teams-reactions-reference.md
//
// This script fetches that markdown, parses its `| emoji | name | id |` tables,
// and writes the pairs out as a compact generated module. Skin tone variants are
// NOT emitted as rows: the doc states the rule ("append `-tone1`…`-tone5` to the
// base reaction ID"), so `teams-emoji.ts` applies it at runtime instead of us
// shipping five extra rows per hand. Which ids accept that suffix does matter
// though — only the hand gesture and people tables carry a tone column, and the
// live tenant confirms it (👍🏼 is `yes-tone2`, never `like-tone2`) — so those
// rows are flagged.
//
// It also checks every emoji against the Apple emoji images we serve
// (`emoji-datasource-apple`) and reports the ones with no image — those fall
// back to the native glyph in the UI, which is why the report is informational
// and not an error.
//
// Usage:
//   bun run generate:emoji              # fetch the live doc and rewrite the module
//   bun run generate:emoji --check      # parse only: report, write nothing
//   bun run generate:emoji --from <md>  # parse a local copy of the doc

import { existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const DOC_URL =
  "https://raw.githubusercontent.com/MicrosoftDocs/msteams-docs/main/msteams-platform/agents-in-teams/teams-reactions-reference.md";

const WEB_DIR = join(import.meta.dirname, "..");
const OUT_FILE = join(WEB_DIR, "src/lib/teams-emoji-catalog.ts");
/** Where the Apple images live in the package we sync into `public/` (see
 *  `sync-emoji-assets.ts`) — used only to report coverage. */
const APPLE_IMAGE_DIR = join(WEB_DIR, "node_modules/emoji-datasource-apple/img/apple/64");

/** One row of a reaction table: the emoji, Microsoft's reaction id for it, and
 *  whether the row lists skin tone variants of that id. */
type CatalogRow = { emoji: string; id: string; tones: boolean };

/**
 * A reaction table row: `| 🔥 | **Fire** | `fire` |`, followed on the toneable
 * tables by a column of `-tone1`…`-tone5` variants. The id charset is
 * Microsoft's: lowercase letters, digits, `_` (their `<codepoint>_<name>` form)
 * and `-` (tone suffixes).
 */
const ROW = /^\|\s*(\S+?)\s*\|\s*\*\*(.+?)\*\*\s*\|\s*`([a-z0-9_-]+)`\s*\|(.*)$/gmu;

/**
 * Parse the doc into rows in document order. Order is meaningful: several ids
 * share one emoji (👍 is both `like` and `yes`; 🙁 is `sad`, `saddog`, `shake`,
 * …), and the doc lists the canonical reaction first — see
 * `teams-emoji.ts`, which resolves emoji → id by first occurrence.
 */
function parseCatalog(markdown: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  const seen = new Set<string>();
  for (const [, emoji, , id, rest] of markdown.matchAll(ROW)) {
    if (seen.has(id!)) continue; // the doc repeats a couple of ids across sections
    seen.add(id!);
    rows.push({ emoji: emoji!, id: id!, tones: (rest ?? "").includes(`${id}-tone1`) });
  }
  return rows;
}

/** `🔥` -> `1f525`, `#️⃣` -> `0023-fe0f-20e3`: the emoji's code points, the way
 *  the Apple image files (and emoji-mart's `unified`) name them — lowercase hex,
 *  padded to four digits, joined by `-`. Kept in sync with `emojiUnified` in
 *  src/lib/teams-emoji.ts. */
function unified(emoji: string): string {
  return [...emoji].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0")).join("-");
}

const VARIATION_SELECTOR = "\u{FE0F}";

/**
 * The doc writes a handful of emoji unqualified — `❤` and `♻` without the
 * emoji-presentation selector — while both the Apple images and emoji-mart's
 * `native` strings carry it. Qualify those (and only those: the selector is
 * added when it names an existing image) so a catalog emoji is directly
 * comparable to what the picker hands us, and directly nameable as an image.
 */
function qualify(emoji: string, hasImage: (emoji: string) => boolean): string {
  if (hasImage(emoji)) return emoji;
  const [first, ...rest] = [...emoji];
  if (first === undefined || rest[0] === VARIATION_SELECTOR) return emoji;
  const qualified = [first, VARIATION_SELECTOR, ...rest].join("");
  return hasImage(qualified) ? qualified : emoji;
}

function generatedModule(rows: CatalogRow[]): string {
  const pairs = rows.map((r) => `${r.id} ${r.emoji}${r.tones ? " +" : ""}`).join("\n");
  return `// GENERATED FILE — do not edit by hand.
//
// Microsoft's Teams reaction catalog: one \`<reaction id> <emoji>\` line per
// reaction, in the order the docs list them (the first id for an emoji is the
// canonical one). A trailing \` +\` marks an id that accepts the \`-tone1\`…
// \`-tone5\` skin tone suffix, which is applied at runtime rather than listed.
//
// Source: MicrosoftDocs/msteams-docs, msteams-platform/agents-in-teams/
// teams-reactions-reference.md. Regenerate with \`bun run generate:emoji\`
// (web/scripts/generate-teams-emoji.ts).

/** ${rows.length} reactions, packed as text so the whole catalog costs one
 *  string in the bundle and is parsed lazily on first use. */
export const TEAMS_EMOJI_CATALOG = \`${pairs}\`;
`;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const fromIndex = args.indexOf("--from");
  const from = fromIndex === -1 ? null : args[fromIndex + 1];

  const markdown = from
    ? await readFile(from, "utf8")
    : await fetch(DOC_URL).then((r) => {
        if (!r.ok) throw new Error(`fetching the reactions reference failed: ${r.status}`);
        return r.text();
      });

  let rows = parseCatalog(markdown);
  if (rows.length < 1_000) {
    throw new Error(
      `only ${rows.length} reactions parsed — the doc's table format probably changed`,
    );
  }

  // The Apple images are both what the UI renders and how we tell a qualified
  // emoji from an unqualified one, so generating without them would silently
  // produce a different catalog.
  if (!existsSync(APPLE_IMAGE_DIR)) {
    throw new Error(`${APPLE_IMAGE_DIR} is missing — run \`bun install\` in web/ first`);
  }
  const hasImage = (emoji: string) => existsSync(join(APPLE_IMAGE_DIR, `${unified(emoji)}.png`));
  rows = rows.map((r) => ({ ...r, emoji: qualify(r.emoji, hasImage) }));

  // Sanity: the six classic reactions the quick picker offers must be present.
  for (const id of ["like", "heart", "laugh", "surprised", "sad", "angry"]) {
    if (!rows.some((r) => r.id === id)) throw new Error(`classic reaction "${id}" is missing`);
  }

  console.log(`parsed ${rows.length} reactions (${new Set(rows.map((r) => r.emoji)).size} emoji)`);

  const missing = rows.filter((r) => !hasImage(r.emoji));
  console.log(
    `Apple images: ${rows.length - missing.length}/${rows.length} covered` +
      (missing.length
        ? ` — falling back to the native glyph for: ${missing.map((m) => m.id).join(", ")}`
        : ""),
  );

  if (checkOnly) return;
  await writeFile(OUT_FILE, generatedModule(rows));
  console.log(`wrote ${OUT_FILE}`);
}

await main();

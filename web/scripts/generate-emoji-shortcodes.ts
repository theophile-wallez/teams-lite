// Regenerates `src/lib/emoji-shortcodes.ts` — a compact Unicode emoji shortcode index.
//
// The composer needs to offer Unicode emoji in the ":" typeahead, but emoji-mart's
// dataset is 1.5 MB and deliberately behind the picker's lazy import. The composer is
// on the critical path, so it gets a compact index instead: one `name native` line per
// emoji id and alias, packed as text and parsed lazily on first use.
//
// This script reads `@emoji-mart/data`, extracts every emoji id and alias with its
// native character, and writes them out as a generated module. Skin tone variants are
// NOT emitted: the picker applies them, and the typeahead does not (a skin tone cannot
// be typed as a shortcode).
//
// Usage:
//   bun run generate:emoji-shortcodes

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import emojiData from "@emoji-mart/data";

const WEB_DIR = join(import.meta.dirname, "..");
const OUT_FILE = join(WEB_DIR, "src/lib/emoji-shortcodes.ts");

type EmojiData = {
  emojis: Record<
    string,
    {
      id: string;
      name: string;
      keywords: string[];
      skins: Array<{ native: string }>;
    }
  >;
  aliases: Record<string, string>;
};

function generateShortcodes() {
  const data = emojiData as EmojiData;
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const [id, emoji] of Object.entries(data.emojis)) {
    if (!emoji.skins?.[0]?.native) continue;
    const native = emoji.skins[0].native;
    if (!seen.has(id)) {
      lines.push(`${id} ${native}`);
      seen.add(id);
    }
  }

  for (const [alias, target] of Object.entries(data.aliases)) {
    const emoji = data.emojis[target];
    if (!emoji?.skins?.[0]?.native) continue;
    const native = emoji.skins[0].native;
    if (!seen.has(alias)) {
      lines.push(`${alias} ${native}`);
      seen.add(alias);
    }
  }

  return lines.join("\n");
}

function generatedModule(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  return `// GENERATED FILE — do not edit by hand.
//
// Unicode emoji shortcode index: one \`<name> <native>\` line per emoji id and
// alias, packed as text so the whole index costs one string in the bundle and is
// parsed lazily on first use. Skin tone variants are NOT included: the picker
// applies them, and the typeahead does not.
//
// Source: @emoji-mart/data. Regenerate with \`bun run generate:emoji-shortcodes\`
// (web/scripts/generate-emoji-shortcodes.ts).

/** Unicode emoji shortcodes (${bytes.toLocaleString()} bytes, ~${Math.round(bytes / 1024)} KB). */
export const EMOJI_SHORTCODES = \`${content}\`;
`;
}

async function main() {
  const content = generateShortcodes();
  const lines = content.split("\n").length;
  const bytes = new TextEncoder().encode(content).length;

  console.log(`generated ${lines.toLocaleString()} shortcodes (${bytes.toLocaleString()} bytes, ~${Math.round(bytes / 1024)} KB)`);

  await writeFile(OUT_FILE, generatedModule(content));
  console.log(`wrote ${OUT_FILE}`);
}

await main();

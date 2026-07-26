import { useMemo } from "react";
import Picker from "@emoji-mart/react";
import rawData from "@emoji-mart/data";
import { appleEmojiUrlFromUnified, canReactWith, teamsReactionKey } from "~/lib/teams-emoji";

// This module is the lazy chunk behind the "more reactions" button: emoji-mart
// plus its 1.5 MB dataset must never sit on the critical path, so it is only ever
// reached through `lazy(() => import("./emoji-picker"))` (see message-bubble.tsx).

/** The slice of emoji-mart's dataset we touch. Its published types are loose, so
 *  the shape is declared where it is used rather than cast at every access. */
type EmojiMartSkin = { native: string; unified: string; src?: string };
type EmojiMartData = {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<string, { id: string; skins: EmojiMartSkin[] }>;
  aliases: Record<string, string>;
  sheet: unknown;
};

/**
 * emoji-mart's dataset, adapted twice over.
 *
 * First, every emoji Teams has no reaction for is dropped (a couple of hundred:
 * mostly newer sequences and family/couple combinations). Offering them would
 * mean either sending a key no other Teams client can render or silently dropping
 * the click — hiding them is the honest option, and search then only turns up
 * emoji that actually work.
 *
 * Second, each skin gets an explicit `src`. Left alone, emoji-mart draws its grid
 * from a spritesheet on jsdelivr — a 4 MB CDN request this app has no business
 * making, and one whose cell geometry is pinned to the emoji-datasource version
 * its dataset was built from. A per-skin `src` (the field it already honors for
 * custom emoji) points every glyph at the images we serve ourselves instead.
 *
 * Computed once per session; emoji-mart indexes whatever object it is handed.
 */
function reactableData(): EmojiMartData {
  const data = rawData as EmojiMartData;
  const emojis: EmojiMartData["emojis"] = {};
  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins[0]?.native;
    if (!native || !canReactWith(native)) continue;
    emojis[id] = {
      ...emoji,
      skins: emoji.skins.map((skin) => ({ ...skin, src: appleEmojiUrlFromUnified(skin.unified) })),
    };
  }
  return {
    ...data,
    emojis,
    categories: data.categories.map((c) => ({ ...c, emojis: c.emojis.filter((id) => id in emojis) })),
    aliases: Object.fromEntries(
      Object.entries(data.aliases).filter(([, target]) => target in emojis),
    ),
  };
}

/** What emoji-mart hands back on a pick (the fields we use). */
type PickedEmoji = { native: string };

/**
 * The full emoji picker for reactions: emoji-mart in Apple mode, drawing its
 * images from our own origin, and reporting picks as Teams reaction keys so the
 * caller never has to know the difference between an emoji and an emotion key.
 *
 * `onPick` receives a key like `fire` or `yes-tone2`; a pick with no key is
 * impossible here because the dataset is pre-filtered to reactable emoji.
 */
export default function EmojiPicker(props: {
  onPick: (key: string) => void;
  theme: "light" | "dark";
}) {
  const data = useMemo(reactableData, []);

  return (
    <div
      data-testid="emoji-picker"
      // emoji-mart's palette, mapped onto ours (see --emoji-picker-* in
      // theme.css). The custom properties inherit into its shadow root.
      style={
        {
          "--rgb-background": "var(--emoji-picker-background)",
          "--rgb-color": "var(--emoji-picker-color)",
          "--rgb-accent": "var(--emoji-picker-accent)",
          "--rgb-input": "var(--emoji-picker-input)",
          "--font-family": "inherit",
        } as React.CSSProperties
      }
    >
      <Picker
        data={data}
        theme={props.theme}
        set="apple"
        // Apple images, served locally — never from a CDN (see appleEmojiUrl).
        // Both hooks point home: `getImageURL` for the glyphs emoji-mart resolves
        // itself, `getSpritesheetURL` so a sheet request could only ever be a
        // local 404 rather than a silent trip to jsdelivr.
        getImageURL={(_set: string, unified: string) => appleEmojiUrlFromUnified(unified)}
        getSpritesheetURL={() => "/emoji/apple/64/spritesheet-unused.png"}
        onEmojiSelect={(emoji: PickedEmoji) => {
          const key = teamsReactionKey(emoji.native);
          if (key) props.onPick(key);
        }}
        autoFocus
        previewPosition="none"
        skinTonePosition="search"
        perLine={9}
        emojiSize={22}
        emojiButtonSize={32}
        navPosition="top"
      />
    </div>
  );
}

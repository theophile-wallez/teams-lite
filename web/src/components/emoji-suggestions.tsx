import { useEffect, useRef, useState } from "react";
import type { EmojiSuggestion } from "~/lib/custom-emoji";
import { useController } from "./controller-context";
import { cn } from "~/lib/utils";

/**
 * The list the composer shows while a ":…" is being typed: custom emoji first,
 * then Unicode shortcodes, best match first, one of them active.
 *
 * Presentational only — the query, the ranking and the keyboard live in
 * `RichEditor`, so this component can be read (and tested) as what it is: a menu.
 * The active row is scrolled into view, because arrowing past the visible rows must
 * not be a dead end.
 *
 * It floats above the composer rather than at the caret: the field is at the bottom
 * of the window, the list is short, and a menu anchored to the box it belongs to
 * cannot end up half off-screen the way a caret-anchored one does on a phone.
 */
export function EmojiSuggestions(props: {
  suggestions: EmojiSuggestion[];
  activeIndex: number;
  onPick: (suggestion: EmojiSuggestion) => void;
  onActivate: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [props.activeIndex]);

  if (props.suggestions.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Pick an emoji"
      data-testid="emoji-suggestions"
      className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-72 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl bg-popover p-1 shadow-pop animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
    >
      {props.suggestions.map((suggestion, index) => {
        const active = index === props.activeIndex;
        return (
          <button
            key={`${suggestion.kind}:${suggestion.name}`}
            type="button"
            role="option"
            aria-selected={active}
            data-active={active}
            // Which band the row is in. The two kinds can share a name — `:ship` is a
            // custom alias here AND a Unicode shortcode — so the ordering the list
            // promises (custom first) is only readable from the kind, never from the name.
            data-kind={suggestion.kind}
            data-testid={`emoji-suggestion-${suggestion.name}`}
            onMouseDown={(event) => event.preventDefault()}
            // MOVE, not enter. The list grows and shrinks under a pointer that is already
            // sitting where the composer was clicked, and a row appearing beneath a
            // STATIONARY cursor fires `mouseenter` — which would hand the active row to
            // wherever the mouse happens to rest and take it away from the keyboard. A
            // lone ":" made that a certainty rather than a corner: the list opens right
            // over the field the reader just clicked.
            onMouseMove={() => props.onActivate(index)}
            onClick={() => props.onPick(suggestion)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
              active ? "bg-accent text-foreground" : "text-text-dim hover:bg-accent/60",
            )}
          >
            {suggestion.kind === "custom" ? (
              <CustomEmojiRow name={suggestion.name} />
            ) : (
              <UnicodeEmojiRow name={suggestion.name} native={suggestion.native} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** A custom emoji: its art (or a placeholder while loading) and its :name:. */
function CustomEmojiRow(props: { name: string }) {
  const controller = useController();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    controller.customEmojiUrl(props.name).then((result: string | null) => {
      if (active) setUrl(result);
    });
    return () => {
      active = false;
    };
  }, [controller, props.name]);

  return (
    <>
      <span className="grid size-7 shrink-0 place-items-center">
        {url ? (
          <img src={url} alt={`:${props.name}:`} className="h-5 w-auto" />
        ) : (
          <span className="text-xs text-text-faint">:{props.name.slice(0, 2)}:</span>
        )}
      </span>
      <RowName>{`:${props.name}:`}</RowName>
    </>
  );
}

/** A Unicode emoji: its native glyph and its :name:. */
function UnicodeEmojiRow(props: { name: string; native: string }) {
  return (
    <>
      <span className="grid size-7 shrink-0 place-items-center text-xl">{props.native}</span>
      <RowName>{`:${props.name}:`}</RowName>
    </>
  );
}

function RowName(props: { children: string }) {
  return (
    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{props.children}</span>
  );
}

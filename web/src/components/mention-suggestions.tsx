import { useEffect, useRef } from "react";
import type { MentionCandidate } from "~/lib/mentions";
import { cn } from "~/lib/utils";
import { Avatar } from "./avatar";

/**
 * The list the composer shows while an "@…" is being typed: the people this thread
 * can mention, best match first, one of them active.
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
export function MentionSuggestions(props: {
  candidates: MentionCandidate[];
  activeIndex: number;
  onPick: (candidate: MentionCandidate) => void;
  onActivate: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [props.activeIndex]);

  if (props.candidates.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention someone"
      data-testid="mention-suggestions"
      className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-72 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl bg-popover p-1 shadow-pop animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
    >
      {props.candidates.map((candidate, index) => {
        const active = index === props.activeIndex;
        return (
          <button
            key={candidate.mri}
            type="button"
            role="option"
            aria-selected={active}
            data-active={active}
            data-testid="mention-suggestion"
            data-mri={candidate.mri}
            // Keep the caret where it is: the click must not blur the editor before
            // the mention is inserted.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => props.onActivate(index)}
            onClick={() => props.onPick(candidate)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
              active ? "bg-accent text-foreground" : "text-text-dim hover:bg-accent/60",
            )}
          >
            <Avatar
              seed={candidate.mri}
              label={candidate.name}
              fallback="person"
              photo={{ kind: "user", id: candidate.mri }}
              className="size-7 text-[11px]"
            />
            {/* The row's own text: the avatar beside it renders initials, so the name
                needs a handle of its own for anything reading the list. */}
            <span
              data-testid="mention-suggestion-name"
              className="min-w-0 flex-1 truncate font-medium text-foreground"
            >
              {candidate.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

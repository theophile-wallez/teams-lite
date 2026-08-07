import { useEffect, useRef } from "react";
import {
  mentionOptionKey,
  type AgentCandidate,
  type MentionCandidate,
  type MentionOption,
} from "~/lib/mentions";
import { cn } from "~/lib/utils";
import { AgentLogo } from "./agent-logo";
import { Avatar } from "./avatar";

/**
 * The list the composer shows while an "@…" is being typed: the agents this thread can
 * summon, then the people it can mention, best match first, one of them active.
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
  options: MentionOption[];
  activeIndex: number;
  onPick: (option: MentionOption) => void;
  onActivate: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [props.activeIndex]);

  if (props.options.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Mention someone or tag an agent"
      data-testid="mention-suggestions"
      className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-72 max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl bg-popover p-1 shadow-pop animate-in fade-in slide-in-from-bottom-1 duration-150 ease-out"
    >
      {props.options.map((option, index) => {
        const active = index === props.activeIndex;
        return (
          <button
            key={mentionOptionKey(option)}
            type="button"
            role="option"
            aria-selected={active}
            data-active={active}
            data-testid="mention-suggestion"
            data-kind={option.kind}
            data-mri={option.kind === "person" ? option.person.mri : undefined}
            data-agent={option.kind === "agent" ? option.agent.backend : undefined}
            // Keep the caret where it is: the click must not blur the editor before
            // the mention is inserted.
            onMouseDown={(event) => event.preventDefault()}
            // MOVE, not enter — the same rule as the emoji list, and for the same reason.
            // A bare "@" opens this list over the field the reader just clicked, and a row
            // rendering beneath a STATIONARY cursor fires `mouseenter`, which would take the
            // active row away from the keyboard. `mousemove` means the reader moved.
            onMouseMove={() => props.onActivate(index)}
            onClick={() => props.onPick(option)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
              active ? "bg-accent text-foreground" : "text-text-dim hover:bg-accent/60",
            )}
          >
            {option.kind === "agent" ? (
              <AgentRow agent={option.agent} />
            ) : (
              <PersonRow person={option.person} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Somebody the message can notify: their photo (or initials) and their name. */
function PersonRow(props: { person: MentionCandidate }) {
  return (
    <>
      <Avatar
        seed={props.person.mri}
        label={props.person.name}
        fallback="person"
        photo={{ kind: "user", id: props.person.mri }}
        className="size-7 text-[11px]"
      />
      {/* The row's own text: the avatar beside it renders initials, so the name
          needs a handle of its own for anything reading the list. */}
      <RowName>{props.person.name}</RowName>
    </>
  );
}

/**
 * An agent the message can summon, drawn as what it is and never as a member of the
 * thread: the CLI's own mark where a photo would go — with nothing behind it, because a
 * disc would read as an avatar — and one line saying where the answer is written.
 *
 * A listed agent is one that really would answer; see `agentCandidatesFor`.
 */
function AgentRow(props: { agent: AgentCandidate }) {
  return (
    <>
      <span className="grid size-7 shrink-0 place-items-center">
        <AgentLogo backend={props.agent.backend} className="size-4" />
      </span>
      <RowName>{props.agent.name}</RowName>
      <span className="shrink-0 text-xs text-text-faint">runs here</span>
    </>
  );
}

function RowName(props: { children: string }) {
  return (
    <span
      data-testid="mention-suggestion-name"
      className="min-w-0 flex-1 truncate font-medium text-foreground"
    >
      {props.children}
    </span>
  );
}

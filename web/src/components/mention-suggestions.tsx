import { HashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import { agentDisplayName } from "~/lib/agent-message";
import {
  mentionOptionKey,
  mentionOptionTarget,
  type AgentCandidate,
  type MentionCandidate,
  type MentionOption,
} from "~/lib/mentions";
import { cn } from "~/lib/utils";
import { AgentMark } from "./agent-persona-mark";
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
            data-mri={mentionOptionTarget(option)?.mri}
            data-agent={option.kind === "agent" ? option.agent.backend : undefined}
            data-persona={option.kind === "agent" ? option.agent.persona ?? undefined : undefined}
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
            ) : option.kind === "channel" ? (
              <ChannelRow channel={option.channel} />
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
 * The CHANNEL the message can notify — the widest thing an "@" reaches here, and the one
 * row of this list that is not one person.
 *
 * Drawn as a channel and never as a person, for the reason the agent's row below is:
 * `Avatar` would seed tinted initials from a THREAD id, which is a face for a colleague
 * who does not exist (the wrong-face rule § A tracker user who is also a colleague states,
 * and the chess engine's own seat follows). So it takes the mark-in-a-square shape with no
 * disc behind it, and its own line says what the press costs — whoever follows the channel
 * is notified, which is the one fact the reader needs BEFORE the press and cannot undo
 * after.
 */
function ChannelRow(props: { channel: MentionCandidate }) {
  return (
    <>
      <span className="grid size-7 shrink-0 place-items-center text-text-dim">
        <HugeiconsIcon icon={HashIcon} className="size-4" strokeWidth={1.4} aria-hidden />
      </span>
      <RowName>{props.channel.name}</RowName>
      <span className="shrink-0 text-xs text-text-faint">notifies the channel</span>
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
  const { agent } = props;
  return (
    <>
      <span className="grid size-7 shrink-0 place-items-center">
        <AgentMark backend={agent.backend} persona={agent.persona} className="size-4" />
      </span>
      <RowName>{agent.name}</RowName>
      {/* A CUSTOM AGENT says which CLI is behind it, because that is the one thing its own
          name cannot say — and it is what the reader is choosing between when two of their
          agents differ only in that. A provider's own row says "runs here": the mark has
          already named the CLI, and repeating it would be the same fact twice. */}
      <span className="shrink-0 text-xs text-text-faint">
        {agent.persona ? agentDisplayName(agent.backend) : "runs here"}
      </span>
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

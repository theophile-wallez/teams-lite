import { HugeiconsIcon } from "@hugeicons/react";
import { SparklesIcon } from "@hugeicons/core-free-icons";
import type { AgentModel } from "~/lib/agent";
import { cn } from "~/lib/utils";

/**
 * The marks of the agent CLIs this app can run, and the coin an answer wears.
 *
 * A reply is posted through the user's own account, so nothing about the message says a
 * machine wrote it — which is why it signs itself in the thread (AGENTS.md § The local
 * agent). In this app the mark carries that same fact, and carries it better: it is on
 * the bubble before a word of the answer has arrived, and it is the first thing the eye
 * lands on rather than the last line it reads.
 *
 * Both marks are the vendors' own artwork, inlined rather than fetched: the app is
 * local-first and displaying a message must make no network request (see the same rule
 * for mail bodies in AGENTS.md), so a logo hotlinked from a CDN is out of the question.
 */

/** Anthropic's Claude symbol, from the SVG published at
 *  commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg — that file's single path,
 *  unaltered. */
const CLAUDE_PATH =
  "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";

/** Claude's coral, which is the symbol's own fill in that file. */
const CLAUDE_CORAL = "#D97757";

export function ClaudeLogo(props: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      fill={CLAUDE_CORAL}
      xmlns="http://www.w3.org/2000/svg"
      data-testid="claude-logo"
      className={props.className}
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      {props.title && <title>{props.title}</title>}
      <path d={CLAUDE_PATH} />
    </svg>
  );
}

/**
 * opencode's mark: the blocky "o" that opens their wordmark, taken from the logo
 * published at opencode.ai/brand (`logoLight` / `logoDark`, the first glyph of the
 * 234×42 wordmark — hence the `0 6 24 30` window, which is exactly the box that glyph
 * occupies).
 *
 * They ship two versions whose geometry is identical and whose fills differ, one per
 * background, so both palettes live here and the theme picks one. That is what
 * "handle light and dark" means for this mark: not a filter over one file, the vendor's
 * own two.
 */
const OPENCODE_RING = "M18 12H6V30H18V12ZM24 36H0V6H24V36Z";
const OPENCODE_COUNTER = "M18 30H6V18H18V30Z";

export function OpencodeLogo(props: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 6 24 30"
      xmlns="http://www.w3.org/2000/svg"
      data-testid="opencode-logo"
      className={props.className}
      role={props.title ? "img" : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
    >
      {props.title && <title>{props.title}</title>}
      <path d={OPENCODE_COUNTER} className="fill-[#CFCECD] dark:fill-[#4B4646]" />
      <path d={OPENCODE_RING} className="fill-[#656363] dark:fill-[#B7B1B1]" />
    </svg>
  );
}

/** The mark of whichever CLI answered. A name this app does not know still gets a
 *  mark — a machine wrote the message either way, and that is what the coin says. */
export function AgentLogo(props: { backend: string; className?: string; title?: string }) {
  switch (props.backend) {
    case "opencode":
      return <OpencodeLogo className={props.className} title={props.title} />;
    case "claude":
      return <ClaudeLogo className={props.className} title={props.title} />;
    default:
      return (
        <HugeiconsIcon
          icon={SparklesIcon}
          className={cn("text-primary", props.className)}
          strokeWidth={1.6}
          role={props.title ? "img" : undefined}
          aria-label={props.title}
          aria-hidden={props.title ? undefined : true}
        />
      );
  }
}

/**
 * Whose mark belongs beside one model's name.
 *
 * A model is not the CLI that runs it: opencode drives `provider/model` for whichever
 * providers the machine authenticated, so its list is mostly other vendors' models —
 * `amazon-bedrock/eu.anthropic.claude-opus-5` is a Claude model reached through
 * Bedrock, and reading Anthropic's mark beside it is the point of having one.
 *
 * Only marks this app actually holds are named. Anthropic's is one of the two above,
 * so a model of theirs wears it whichever CLI runs it; every other vendor falls back
 * to the CLI's own mark rather than to invented artwork. The test is the model's own
 * words — a model that another vendor named after Claude would be misread, which costs
 * a wrong logo in a picker and nothing else.
 */
export function modelMark(backend: string, model: AgentModel): string {
  return /anthropic|claude/i.test(`${model.vendor} ${model.id}`) ? "claude" : backend;
}

/**
 * The mark, bare — no coin, no fill, no shadow. It sits in a line of text beside the
 * name, not where a person's photo would go: a chip behind it would read as an avatar,
 * and the agent is not a member of the thread. Each vendor's artwork carries its own
 * colour, so it holds up on either theme with nothing behind it.
 *
 * `busy` makes it breathe while the run is going, so the thread shows life from the
 * moment the trigger lands (`.agent-mark-busy` in app.css; the global reduced-motion
 * rule neutralizes it).
 */
export function AgentCoin(props: {
  backend: string;
  busy?: boolean;
  className?: string;
}) {
  return (
    <span
      data-testid="agent-coin"
      data-backend={props.backend}
      data-busy={props.busy ? "true" : undefined}
      className={cn("grid shrink-0 place-items-center", props.busy && "agent-mark-busy", props.className)}
    >
      <AgentLogo backend={props.backend} className="size-full" title={props.backend} />
    </span>
  );
}

/**
 * The colour of the light that travels a bubble's edge while that CLI writes into it
 * (see `AgentBubbleShine`).
 *
 * Claude's own coral, so the edge and the mark inside the bubble are the same vendor —
 * the choice the composer's tag chips already make. Anything else takes the app's accent
 * as a `var()`, so it follows the theme: opencode's mark is graphite, and graphite
 * travelling round a grey bubble is a light nobody can see.
 */
export function agentShineColor(backend: string): string {
  return backend === "claude" ? CLAUDE_CORAL : "var(--primary)";
}


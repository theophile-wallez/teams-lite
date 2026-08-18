import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { agentDisplayName } from "~/lib/agent-message";
import { agentPersonaNamed } from "~/lib/agent-persona";
import { cn } from "~/lib/utils";
import { AgentMark } from "./agent-persona-mark";
import { useOptionalAppState } from "./controller-context";

/**
 * An agent tag: the CLI's own mark and its name, on a wash of the vendor's own colour
 * (`.agent-tag` in styles/app.css — Claude's coral, opencode's graphite).
 *
 * It is deliberately NOT the blue mention chip. A person mention is a promise to notify
 * somebody; this is a promise to start a program on the machine the backend runs on, and
 * the two must not read as one thing. The mark carries which program, which is the part
 * that matters and the part a name alone would blur.
 *
 * The composer draws it while the message is written ({@link AgentTagView}) and the thread
 * draws the same one once it is sent, from the prefix read back out of the body
 * (lib/agent-tag.ts, rendered by components/rich-content.tsx). One component, because
 * tagging an agent and reading the message back are one thing, not two that look alike.
 */
export function AgentTagChip(props: {
  backend: string;
  /** The CUSTOM AGENT this tag summons, by address (`bebou`), or null for the provider
   *  itself. It decides the FACE and the NAME; the provider still decides the palette,
   *  because a persona is that provider wearing a name (see lib/agent-persona.ts). */
  persona?: string | null;
  className?: string;
}) {
  const label = usePersonaLabel(props.persona);
  return (
    <span
      data-testid="agent-tag"
      data-agent={props.backend}
      data-persona={props.persona ?? undefined}
      className={cn("agent-tag", props.className)}
    >
      <AgentMark backend={props.backend} persona={props.persona} className="agent-tag-logo" />
      {label ?? agentDisplayName(props.backend)}
    </span>
  );
}

/**
 * How a custom agent is NAMED on a chip: the label the user gave it, else its address.
 *
 * The address is the fallback rather than the provider's name, and that matters on a message
 * this machine no longer holds the record for — a tag the user typed before deleting the
 * persona. `@bebou` is what they wrote and what the thread shows; drawing "Claude" there
 * would rewrite their own words.
 */
function usePersonaLabel(name: string | null | undefined): string | null {
  // Optional, because a message body is rendered where there is no store at all
  // (`RichContent` is pure given its props). No record means the address, which is what the
  // author typed and what the thread shows.
  const agent = useOptionalAppState((s) => s.agent, null);
  if (!name) return null;
  return agentPersonaNamed(agent, name)?.label ?? name;
}

/**
 * The chip as the composer draws it, for the atomic node in agent-tag-extension.ts.
 *
 * A node view (rather than plain `renderHTML` markup) so the mark is the same component
 * the thread's own agent replies wear — one piece of vendor artwork, not two. The node's
 * `renderHTML` stays the plain prefix, because that is what has to survive into the
 * message body.
 */
export function AgentTagView(props: ReactNodeViewProps) {
  const persona = props.node.attrs.persona;
  return (
    <NodeViewWrapper as="span" className="agent-tag-node">
      <AgentTagChip
        backend={String(props.node.attrs.backend ?? "")}
        persona={typeof persona === "string" && persona ? persona : null}
      />
    </NodeViewWrapper>
  );
}

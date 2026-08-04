import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { agentDisplayName } from "~/lib/agent-message";
import { cn } from "~/lib/utils";
import { AgentLogo } from "./agent-logo";

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
export function AgentTagChip(props: { backend: string; className?: string }) {
  return (
    <span
      data-testid="agent-tag"
      data-agent={props.backend}
      className={cn("agent-tag", props.className)}
    >
      <AgentLogo backend={props.backend} className="agent-tag-logo" />
      {agentDisplayName(props.backend)}
    </span>
  );
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
  return (
    <NodeViewWrapper as="span" className="agent-tag-node">
      <AgentTagChip backend={String(props.node.attrs.backend ?? "")} />
    </NodeViewWrapper>
  );
}

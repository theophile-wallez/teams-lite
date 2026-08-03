import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { agentHint, agentModeFor, agentRunnable, availableBackends } from "~/lib/agent";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/**
 * The switch that lets ONE conversation answer an `@claude` message, in the header of
 * the conversation it applies to (see lib/agent.ts and src/agent_policy.rs).
 *
 * It sits here, and not in Settings, because the thing being decided is per
 * conversation: "this machine may post an answer under my name, in THIS thread". A
 * global list of thread ids would be the same data with the consent taken out of the
 * place the user can see who reads it.
 *
 * Three things it deliberately does not do:
 *
 * - **It never claims a state it has not been told.** Until `agent_status` answers, the
 *   switch is off and disabled, because "off" is what the backend defaults to and a
 *   hopeful switch would be a lie about where a machine posts.
 * - **It says why, when it cannot.** A backend with no CLI on its PATH, or a read-only
 *   one, can never answer — so the menu states that instead of offering a switch whose
 *   only effect would be a silent thread.
 * - **It waits for the backend before it looks on.** The write can be refused (a page
 *   without the write token), and the answer that lands in state is the backend's own.
 */
export function AgentMenu(props: { conversationId: string }) {
  const controller = useController();
  const status = useAppState((s) => s.agent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mode = agentModeFor(status, props.conversationId);
  const on = mode === "reply";
  const runnable = agentRunnable(status);
  const backends = availableBackends(status);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await controller.setAgentMode(props.conversationId, next ? "reply" : "off");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Non-modal, for the reason calendar-view-menu.tsx spells out: a modal Radix menu
    // parks `pointer-events: none` on the body until its close animation ends, which
    // swallows the next click — and the next click here is usually the composer.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        data-testid="agent-menu"
        data-agent-mode={mode}
        aria-label="Local agent for this conversation"
        className={cn(
          "ml-auto grid size-9 shrink-0 place-items-center rounded-lg transition-colors",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          on ? "text-primary" : "text-text-faint hover:text-foreground",
        )}
      >
        <Bot className="size-5" strokeWidth={1.6} />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Local agent</DropdownMenuLabel>

        <DropdownMenuCheckboxItem
          data-testid="agent-mode-toggle"
          checked={on}
          disabled={busy || !runnable}
          onCheckedChange={(next) => void toggle(next === true)}
          // Radix closes a menu on select, and the answer takes a round-trip: keeping
          // it open is how the user sees the switch settle, or the reason it did not.
          onSelect={(event) => event.preventDefault()}
        >
          Answer here
          {busy && <Loader2 className="ml-auto size-3.5 animate-spin" strokeWidth={1.8} />}
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />

        <p data-testid="agent-hint" className="px-2 py-1.5 text-[11px] leading-snug text-text-faint">
          {error ?? agentHint(status)}
        </p>

        {runnable && on && (
          <p className="px-2 pb-1.5 text-[11px] leading-snug text-text-faint">
            Only a message YOU write triggers it, and the answer is posted under your
            name, signed by {backends.map((b) => b.name).join(" or ")}.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

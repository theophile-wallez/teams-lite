import { convLabel } from "~/lib/protocol";
import { useAppState, useController } from "./controller-context";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

/**
 * Ctrl+K fuzzy conversation jump, mirroring the TUI's command palette. cmdk
 * handles filtering and keyboard navigation; selecting opens the conversation.
 */
export function CommandPalette(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const conversations = useAppState((s) => s.conversations);
  const controller = useController();

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange} label="Go to conversation">
      <CommandInput placeholder="Search conversations…" />
      <CommandList>
        <CommandEmpty>No conversations found.</CommandEmpty>
        <CommandGroup heading="Conversations">
          {conversations.map((c) => (
            <CommandItem
              key={c.id}
              value={`${convLabel(c)} ${c.id}`}
              onSelect={() => {
                void controller.openConversation(c.id);
                props.onOpenChange(false);
              }}
            >
              <span className="truncate">{convLabel(c)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

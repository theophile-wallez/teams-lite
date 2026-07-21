import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { THEME_LIST } from "~/lib/theme-list.gen";
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
 * Ctrl+P theme picker with live preview: the highlighted theme (via keyboard or
 * mouse — driven by cmdk's active value) previews immediately, matching the
 * TUI's live settings preview. Selecting commits and persists it; dismissing
 * without selecting reverts to the committed theme.
 */
export function SettingsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const controller = useController();
  const themeId = useAppState((s) => s.themeId);
  const [highlighted, setHighlighted] = useState<string>(themeId);

  // When the picker opens, start highlighting the committed theme.
  useEffect(() => {
    if (props.open) setHighlighted(themeId);
  }, [props.open, themeId]);

  // Preview whatever is currently highlighted while the picker is open.
  useEffect(() => {
    if (props.open) controller.previewTheme(highlighted);
  }, [props.open, highlighted, controller]);

  const close = (open: boolean) => {
    if (!open) controller.revertPreview();
    props.onOpenChange(open);
  };

  return (
    <CommandDialog
      open={props.open}
      onOpenChange={close}
      label="Choose a theme"
      value={highlighted}
      onValueChange={setHighlighted}
    >
      <CommandInput placeholder="Search themes…" />
      <CommandList>
        <CommandEmpty>No themes found.</CommandEmpty>
        <CommandGroup heading="Theme">
          {THEME_LIST.map((t) => (
            <CommandItem
              key={t.id}
              value={t.id}
              keywords={[t.name]}
              onSelect={() => {
                controller.setTheme(t.id);
                props.onOpenChange(false);
              }}
            >
              <ThemeSwatch id={t.id} />
              <span className="flex-1 truncate">{t.name}</span>
              {themeId === t.id && <Check className="size-4 text-primary" />}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

// A small preview of a theme's primary/background, rendered by scoping the
// theme's own [data-theme] variables to this element.
function ThemeSwatch(props: { id: string }) {
  return (
    <span
      data-theme={props.id}
      className="grid size-4 place-items-center overflow-hidden rounded-full border border-border bg-background"
    >
      <span className="size-2 rounded-full bg-primary" />
    </span>
  );
}

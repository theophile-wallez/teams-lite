import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { CalendarViewMode } from "~/lib/calendar";
import type { CalendarSettings } from "~/lib/store";
import { cn } from "~/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// The view switcher, after the reference design: one button naming the current view,
// and a menu holding both the other views and how they are drawn.
//
// A menu rather than four tabs because the settings belong WITH the views (they are
// all "how do I want to look at this?"), and because the header still has to fit on a
// phone. Nothing is lost to the extra click: every view has a single-key shortcut, and
// the menu shows it.

const VIEWS: { value: CalendarViewMode; label: string; shortcut: string }[] = [
  { value: "month", label: "Month", shortcut: "M" },
  { value: "week", label: "Week", shortcut: "W" },
  { value: "day", label: "Day", shortcut: "D" },
  { value: "agenda", label: "Agenda", shortcut: "A" },
];

const SETTINGS: { key: keyof CalendarSettings; label: string; hint: string }[] = [
  { key: "showWeekends", label: "Weekends", hint: "Saturday and Sunday" },
  { key: "showDeclined", label: "Declined events", hint: "struck through" },
  { key: "showWeekNumbers", label: "Week numbers", hint: "ISO weeks" },
];

export function CalendarViewMenu(props: {
  mode: CalendarViewMode;
  settings: CalendarSettings;
  onSelectMode: (mode: CalendarViewMode) => void;
  onToggleSetting: (key: keyof CalendarSettings) => void;
}) {
  const current = VIEWS.find((view) => view.value === props.mode);
  // Controlled, so the panel's own focus handling below can tell "the user closed this"
  // from "the user has already reopened it".
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    // Non-modal on purpose. A modal Radix menu parks `pointer-events: none` on the
    // body until its close animation finishes, so a click landing in that window — the
    // very next click, when someone picks a view and immediately reaches for an event —
    // is swallowed. Nothing here needs the scroll lock a modal menu buys.
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger
        ref={triggerRef}
        data-testid="calendar-view-menu"
        aria-label="Calendar view"
        className="flex shrink-0 items-center gap-1 rounded-lg bg-card px-2.5 py-1.5 text-[13px] font-medium text-text-dim shadow-chip transition-colors hover:text-foreground data-[state=open]:text-foreground"
      >
        {current?.label ?? "View"}
        <ChevronDown className="size-3.5 text-text-faint" strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        // Radix returns focus to the trigger when the closing panel finally unmounts,
        // and picking a view takes the app a frame or two to redraw — so that unmount
        // lands a good 300ms later, by which time the user may have opened this menu
        // again or clicked an event. Focus arriving on the trigger then reads as "focus
        // left me" to whatever floating surface they just opened, and dismisses it.
        //
        // So the restore is ours, and conditional: put focus back on the trigger only
        // when the unmount left it NOWHERE (on the body). If it has landed anywhere
        // else, the user has moved on and their focus is not ours to take.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const active = document.activeElement;
          if (!open && (!active || active === document.body)) triggerRef.current?.focus();
        }}
      >
        {VIEWS.map((view) => (
          <DropdownMenuItem
            key={view.value}
            data-testid={`calendar-view-${view.value}`}
            onSelect={() => props.onSelectMode(view.value)}
            className="pl-2"
          >
            <span className="grid size-4 shrink-0 place-items-center text-primary">
              <Check
                className={cn("size-3.5", props.mode !== view.value && "invisible")}
                strokeWidth={2.4}
              />
            </span>
            {view.label}
            <kbd className="ml-auto rounded border border-border-subtle bg-element px-1.5 text-[11px] font-medium text-text-faint">
              {view.shortcut}
            </kbd>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Show</DropdownMenuLabel>

        {SETTINGS.map((setting) => (
          <DropdownMenuCheckboxItem
            key={setting.key}
            data-testid={`calendar-setting-${setting.key}`}
            checked={props.settings[setting.key]}
            onCheckedChange={() => props.onToggleSetting(setting.key)}
          >
            {setting.label}
            <span className="ml-auto text-[11px] text-text-faint">{setting.hint}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

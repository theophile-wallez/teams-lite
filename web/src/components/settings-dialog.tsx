import { Check, Monitor, MoonStar, Sun, type LucideIcon } from "lucide-react";
import { APPEARANCES, appearanceLabel, type Appearance } from "~/lib/appearance";
import { cn } from "~/lib/utils";
import { useAppState, useController } from "./controller-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const ICONS: Record<Appearance, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: MoonStar,
};

const HINTS: Record<Appearance, string> = {
  system: "Match your device",
  light: "Always light",
  dark: "Always dark",
};

/**
 * Ctrl+P appearance picker: choose Light, Dark, or System (follow the OS). The
 * hovered/focused option previews live; clicking commits and persists it, and
 * dismissing without choosing reverts to the committed appearance.
 */
export function SettingsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const controller = useController();
  const appearance = useAppState((s) => s.appearance);

  const close = (open: boolean) => {
    if (!open) controller.revertAppearance();
    props.onOpenChange(open);
  };

  const choose = (pref: Appearance) => {
    controller.setAppearance(pref);
    props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className="max-w-md" showClose={false}>
        <DialogHeader>
          <DialogTitle>Appearance</DialogTitle>
          <DialogDescription>Choose how teams-lite looks.</DialogDescription>
        </DialogHeader>

        <div
          className="grid grid-cols-3 gap-2"
          onMouseLeave={() => controller.previewAppearance(appearance)}
        >
          {APPEARANCES.map((pref) => {
            const Icon = ICONS[pref];
            const active = appearance === pref;
            return (
              <button
                key={pref}
                type="button"
                data-testid="appearance-option"
                data-value={pref}
                aria-pressed={active}
                onMouseEnter={() => controller.previewAppearance(pref)}
                onFocus={() => controller.previewAppearance(pref)}
                onClick={() => choose(pref)}
                className={cn(
                  "group relative flex flex-col items-center gap-2 rounded-xl bg-card px-3 py-4 text-center transition-all",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "text-foreground shadow-card ring-1 ring-primary/40"
                    : "text-muted-foreground shadow-chip hover:text-foreground hover:shadow-card",
                )}
              >
                {active && (
                  <span className="absolute right-2 top-2 text-primary">
                    <Check className="size-3.5" strokeWidth={2} />
                  </span>
                )}
                <Icon
                  className={cn("size-5", active ? "text-primary" : "text-current")}
                  strokeWidth={1.4}
                />
                <span className="text-[13px] font-medium">{appearanceLabel(pref)}</span>
                <span className="text-[11px] text-text-faint">{HINTS[pref]}</span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

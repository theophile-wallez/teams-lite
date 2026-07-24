import * as React from "react";
import { cn } from "~/lib/utils";

// A small, self-contained, accessible tab set in the shadcn visual idiom, without
// pulling in @radix-ui/react-tabs. It implements the WAI-ARIA tabs pattern:
// `role="tablist"` with roving focus (Arrow/Home/End move and activate), each
// trigger `role="tab"` with `aria-selected` + `aria-controls`, and an optional
// `TabsPanel` wired back with `aria-labelledby`. Controlled: the parent owns the
// active value (here, the controller's sidebar tab), so selection survives the
// tree that renders around it.

type TabsContextValue = {
  value: string;
  setValue: (v: string) => void;
  baseId: string;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const ctx = React.useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be used inside <Tabs>`);
  return ctx;
}

export function Tabs(props: {
  value: string;
  onValueChange: (value: string) => void;
  /** Base id for the generated tab/panel ids; auto-generated when omitted. */
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const generatedId = React.useId();
  const baseId = props.id ?? generatedId;
  const ctx = React.useMemo<TabsContextValue>(
    () => ({ value: props.value, setValue: props.onValueChange, baseId }),
    [props.value, props.onValueChange, baseId],
  );
  return (
    <TabsContext.Provider value={ctx}>
      <div className={props.className}>{props.children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList(props: {
  "aria-label": string;
  className?: string;
  children: React.ReactNode;
}) {
  // Roving keyboard navigation across the tabs (automatic activation, the common
  // default for horizontal tabs): moving focus also selects, so arrowing through
  // switches the visible list as you go.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    if (tabs.length === 0) return;
    const current = tabs.findIndex((t) => t === document.activeElement);
    let next = current;
    switch (e.key) {
      case "ArrowRight":
        next = current < 0 ? 0 : (current + 1) % tabs.length;
        break;
      case "ArrowLeft":
        next = current <= 0 ? tabs.length - 1 : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
    }
    e.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };

  return (
    <div
      role="tablist"
      aria-label={props["aria-label"]}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg bg-card p-1 shadow-chip",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

export function TabsTrigger(props: {
  value: string;
  className?: string;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const ctx = useTabs("TabsTrigger");
  const selected = ctx.value === props.value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${props.value}`}
      aria-selected={selected}
      aria-controls={`${ctx.baseId}-panel-${props.value}`}
      tabIndex={selected ? 0 : -1}
      data-testid={props["data-testid"]}
      data-state={selected ? "active" : "inactive"}
      onClick={() => ctx.setValue(props.value)}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "bg-background text-foreground shadow-chip"
          : "text-text-dim hover:text-foreground",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

export function TabsPanel(props: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = useTabs("TabsPanel");
  const selected = ctx.value === props.value;
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${props.value}`}
      aria-labelledby={`${ctx.baseId}-tab-${props.value}`}
      hidden={!selected}
      // Only mount the active panel's subtree: the chats panel virtualizes its
      // list and must not measure a display:none scroll container, and unmounting
      // the inactive tree keeps the two lists fully independent.
      className={cn(!selected && "hidden", props.className)}
    >
      {selected ? props.children : null}
    </div>
  );
}

import { HugeiconsIcon } from "@hugeicons/react";
import { Loading02Icon } from "@hugeicons/core-free-icons";

/**
 * Full-screen boot splash shown until the client connects to the backend.
 * A calm, centered brand mark with a status line. SSR renders this immediately
 * so the first paint is never blank.
 */
export function Splash(props: { message: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="grid size-16 place-items-center rounded-2xl bg-primary/10 text-primary shadow-card animate-in fade-in-0 zoom-in-95 duration-500 ease-out">
          <span className="text-2xl font-medium tracking-tight">t</span>
        </div>
        <h1 className="text-lg font-medium tracking-tight text-foreground animate-in fade-in-0 slide-in-from-bottom-1 duration-500 ease-out delay-100">
          teams-lite
        </h1>
      </div>
      <div className="flex items-center gap-2 text-sm text-text-faint">
        <HugeiconsIcon icon={Loading02Icon} className="size-4 animate-spin" strokeWidth={1.6} />
        <span>{props.message}…</span>
      </div>
    </div>
  );
}

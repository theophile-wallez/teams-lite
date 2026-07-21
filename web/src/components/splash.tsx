import { Loader2 } from "lucide-react";

/**
 * Full-screen boot splash shown until the client connects to the backend.
 * Mirrors the terminal UI's splash: a calm, centered brand mark with a status
 * line. SSR renders this immediately so the first paint is never blank.
 */
export function Splash(props: { message: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="grid size-16 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30">
          <span className="text-2xl font-bold tracking-tight">t</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight">teams-lite</h1>
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{props.message}…</span>
      </div>
    </div>
  );
}

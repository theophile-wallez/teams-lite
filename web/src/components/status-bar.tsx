import { useAppState } from "./controller-context";

/**
 * The bottom status bar: realtime connection dot, status text, and an update
 * notice pinned to the right when a newer build exists. Mirrors the TUI's
 * StatusBar (ui/src/app.tsx).
 */
export function StatusBar() {
  const live = useAppState((s) => s.live);
  const status = useAppState((s) => s.status);
  const update = useAppState((s) => s.update);

  return (
    <footer
      data-testid="status-bar"
      className="flex h-7 shrink-0 items-center gap-2 border-t border-border-subtle bg-background px-4 text-[11px] text-text-faint"
    >
      <span className="flex items-center gap-1.5">
        <span
          data-testid="live-dot"
          data-state={live}
          className={
            "inline-block size-2 rounded-full transition-colors " +
            (live === "connected"
              ? "bg-success"
              : live === "connecting"
                ? "animate-pulse bg-warning"
                : "bg-destructive")
          }
          aria-hidden
        />
        <span className="sr-only">{live}</span>
      </span>
      <span className="truncate">{status}</span>
      <span className="flex-1" />
      {update && (
        <a
          href={update.url}
          target="_blank"
          rel="noreferrer"
          className="text-warning underline-offset-2 hover:underline"
        >
          ↑ update available ({update.latest}) — reinstall to update
        </a>
      )}
    </footer>
  );
}

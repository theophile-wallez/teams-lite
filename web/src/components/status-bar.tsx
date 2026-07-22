import { useAppState } from "./controller-context";

/**
 * A compact status line pinned to the bottom of the sidebar (not full width). It
 * shows the realtime connection dot plus the single most important message: a
 * pending-update notice when the connection is healthy and a newer build exists,
 * otherwise the current status text (conversation count, transient feedback such
 * as "Copied", or connection/error messages).
 */
export function StatusBar() {
  const live = useAppState((s) => s.live);
  const status = useAppState((s) => s.status);
  const update = useAppState((s) => s.update);

  return (
    <footer
      data-testid="status-bar"
      className="flex h-7 shrink-0 items-center gap-2 border-t border-border-subtle px-4 text-[11px] text-text-faint"
    >
      <span
        data-testid="live-dot"
        data-state={live}
        className={
          "inline-block size-2 shrink-0 rounded-full transition-colors " +
          (live === "connected"
            ? "bg-success"
            : live === "connecting"
              ? "animate-pulse bg-warning"
              : "bg-destructive")
        }
        aria-hidden
      />
      <span className="sr-only">{live}</span>
      {update && live === "connected" ? (
        <a
          href={update.url}
          target="_blank"
          rel="noreferrer"
          className="truncate text-warning underline-offset-2 hover:underline"
        >
          ↑ update available ({update.latest})
        </a>
      ) : (
        <span className="truncate">{status}</span>
      )}
    </footer>
  );
}

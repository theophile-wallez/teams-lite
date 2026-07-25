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
      className="flex min-h-7 shrink-0 items-center gap-2 border-t border-border-subtle px-4 pb-[env(safe-area-inset-bottom)] text-[11px] text-text-faint"
    >
      <BackendBadge />
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

/**
 * Dev-only badge naming which backend this app is talking to: green `MOCK` for
 * `web/mock/server.ts`, red `LIVE` for anything else — which, in practice, means
 * the user's real Teams account.
 *
 * It exists for two readers. A human sees at a glance (and on any screenshot)
 * that a keystroke here would go out for real. Automation reads
 * `[data-testid="backend-badge"]`'s `data-backend` attribute and refuses to type
 * unless it says `mock` (see `web/scripts/preview.ts`) — the badge is the
 * sentinel's public surface, so keep the attribute stable.
 *
 * The `LIVE` half is dev-only — in a production build, live is simply the point
 * of the app. The `MOCK` half always renders, so the E2E suite (which runs a
 * production build against `web/mock/server.ts`) can assert it too. Absence of
 * the badge therefore never means "mock": it means "unproven", which every
 * caller must treat as live.
 */
function BackendBadge() {
  const isMock = useAppState((s) => s.backendIsMock);
  if (!isMock && !import.meta.env.DEV) return null;
  return (
    <span
      data-testid="backend-badge"
      data-backend={isMock ? "mock" : "live"}
      title={
        isMock
          ? "Connected to web/mock/server.ts — nothing leaves this machine."
          : "Connected to the real backend: anything you send goes out as you, for real."
      }
      className={
        "shrink-0 rounded-sm px-1 font-mono text-[10px] leading-4 font-semibold tracking-wide " +
        (isMock ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive")
      }
    >
      {isMock ? "MOCK" : "LIVE"}
    </span>
  );
}

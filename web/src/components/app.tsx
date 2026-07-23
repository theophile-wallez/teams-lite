import { useCallback, useEffect, useState } from "react";
import { Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { ControllerProvider, useAppState, useController } from "./controller-context";
import { ConversationList } from "./conversation-list";
import { MessagePane } from "./message-pane";
import { SettingsPane } from "./settings-pane";
import { CommandPalette } from "./command-palette";
import { SettingsDialog } from "./settings-dialog";
import { ImageLightboxProvider } from "./image-lightbox";
import { Splash } from "./splash";
import { TooltipProvider } from "./ui/tooltip";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

// Duration of the mobile detail-pane slide, kept in sync with the Tailwind
// `duration-300` on the pane so the deferred conversation close (see AppInner)
// lines up with the animation.
const PANE_SLIDE_MS = 300;

export function App() {
  return (
    <ControllerProvider>
      <TooltipProvider delayDuration={300}>
        <ImageLightboxProvider>
          <AppInner />
        </ImageLightboxProvider>
      </TooltipProvider>
    </ControllerProvider>
  );
}

function AppInner() {
  const controller = useController();
  const navigate = useNavigate();
  const ready = useAppState((s) => s.ready);
  const fatal = useAppState((s) => s.fatal);
  const splashMessage = useAppState((s) => s.splashMessage);
  const conversations = useAppState((s) => s.conversations);
  const openId = useAppState((s) => s.openId);
  const replyingTo = useAppState((s) => s.replyingTo);

  // The URL is the source of truth for which conversation is open. `/` means no
  // conversation; `/c/<id>` means that conversation. `strict: false` lets this
  // shell read the param whether or not a conversation route is matched.
  const { conversationId } = useParams({ strict: false });
  const routeConversationId = conversationId ?? null;

  // Whether the settings route is active. When it is, the right pane shows the
  // settings surface instead of a conversation; the sidebar stays put.
  const matchRoute = useMatchRoute();
  const onSettings = !!matchRoute({ to: "/settings" });

  // Below the `md` breakpoint the UI is single-pane: the conversation list is the
  // home screen and a conversation (or Settings) slides in over it as a separate
  // "page", Teams-style. `paneOpen` drives that slide. On desktop both columns are
  // always on screen, so it only feeds the subtle parallax on the list.
  const isMobile = useIsMobile();
  const paneOpen = !!routeConversationId || onSettings;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const goToConversation = useCallback(
    (id: string) => {
      void navigate({ to: "/c/$conversationId", params: { conversationId: id } });
    },
    [navigate],
  );
  const goToList = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);
  const goToSettings = useCallback(() => {
    void navigate({ to: "/settings" });
  }, [navigate]);

  // Reconcile the controller with the URL: open the conversation named in the
  // path, or close the open one when we're back on the list. The controller
  // stays the single owner of message loading, drafts and live fan-in; routing
  // only decides which conversation that machinery targets. Gated on `ready` so
  // a deep link waits for the WebSocket handshake before opening.
  //
  // Closing is immediate on desktop (both panes are visible) and whenever Settings
  // is shown. On mobile, returning to the list slides the message pane out of
  // view; closing right away would swap its content to the empty state mid-slide,
  // so we leave the conversation mounted and let the deferred effect below close
  // it once the pane is off-screen.
  useEffect(() => {
    if (!ready) return;
    if (routeConversationId) {
      if (openId !== routeConversationId) void controller.openConversation(routeConversationId);
      return;
    }
    if (openId && (onSettings || !isMobile)) controller.closeConversation();
  }, [ready, routeConversationId, onSettings, openId, isMobile, controller]);

  // Mobile only: once the detail pane has slid fully out of view (paneOpen went
  // false) close the still-open conversation. The delay matches the slide so the
  // messages stay put throughout the animation; a timeout (rather than
  // transitionend) also covers reduced-motion and interrupted transitions. If the
  // pane reopens first, the cleanup cancels the close and reopening is instant.
  useEffect(() => {
    if (!isMobile || paneOpen || !openId) return;
    const timer = setTimeout(() => controller.closeConversation(), PANE_SLIDE_MS + 40);
    return () => clearTimeout(timer);
  }, [isMobile, paneOpen, openId, controller]);

  // Keep the selection in range as the conversation list changes.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, conversations.length - 1)));
  }, [conversations.length]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Dialogs own their own keys while open.
      if (paletteOpen || settingsOpen) return;

      if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.ctrlKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.key === "Escape") {
        if (replyingTo) {
          controller.cancelReply();
          return;
        }
        if (routeConversationId || onSettings) {
          goToList();
          return;
        }
      }

      // List navigation is only active when no conversation is open and we're not
      // on settings (otherwise the composer / settings form own the keyboard),
      // mirroring the TUI.
      if (routeConversationId || onSettings) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, conversations.length - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const c = conversations[selectedIndex];
        if (c) goToConversation(c.id);
      }
    },
    [
      paletteOpen,
      settingsOpen,
      replyingTo,
      routeConversationId,
      onSettings,
      conversations,
      selectedIndex,
      controller,
      goToConversation,
      goToList,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  if (!ready) return <Splash message={splashMessage} />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="relative flex min-h-0 flex-1">
        <ConversationList
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSettingsPage={goToSettings}
          settingsActive={onSettings}
          chatOpen={paneOpen}
        />
        {/* The detail pane. On mobile it is a full-screen overlay that slides in
            from the right over the conversation list (translate-x driven by
            `paneOpen`); at `md` and up it collapses into a static second column
            that is always visible, so the desktop two-pane layout is unchanged. */}
        <div
          data-testid="detail-pane"
          data-open={paneOpen ? "true" : undefined}
          className={cn(
            "absolute inset-0 z-20 flex bg-background",
            "transition-transform duration-300 ease-out will-change-transform",
            "md:static md:z-auto md:flex-1 md:translate-x-0 md:transition-none md:will-change-auto",
            paneOpen ? "translate-x-0" : "translate-x-full",
          )}
        >
          {onSettings ? <SettingsPane onBack={goToList} /> : <MessagePane onBack={goToList} />}
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {fatal && <FatalOverlay message={fatal} />}

      {/* The conversation routes render nothing themselves; the shell above is
          the whole UI. Rendering the Outlet keeps the matched route mounted so
          its URL (and thus the open conversation) stays authoritative. */}
      <Outlet />
    </div>
  );
}

/** Tracks whether the viewport is under the `md` breakpoint (the single-pane
 *  mobile layout). Defaults to false so SSR and the first client paint assume the
 *  desktop layout; the true value is read on mount. The column layout itself is
 *  pure CSS (Tailwind `md:` utilities), so an initial wrong guess never changes
 *  what is rendered — this flag only tunes behavioural timing (the deferred
 *  mobile close), which is why reading it a beat late is harmless. */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767.98px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isMobile;
}

function FatalOverlay(props: { message: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-2xl bg-card p-6 text-center shadow-pop">
        <p className="text-sm text-destructive">{props.message}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          Reconnect
        </Button>
      </div>
    </div>
  );
}

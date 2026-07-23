import { useCallback, useEffect, useState } from "react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { ControllerProvider, useAppState, useController } from "./controller-context";
import { ConversationList } from "./conversation-list";
import { MessagePane } from "./message-pane";
import { CommandPalette } from "./command-palette";
import { SettingsDialog } from "./settings-dialog";
import { ImageLightboxProvider } from "./image-lightbox";
import { Splash } from "./splash";
import { TooltipProvider } from "./ui/tooltip";
import { Button } from "./ui/button";

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

  // Reconcile the controller with the URL: open the conversation named in the
  // path, or close the open one when we're back on the list. The controller
  // stays the single owner of message loading, drafts and live fan-in; routing
  // only decides which conversation that machinery targets. Gated on `ready` so
  // a deep link waits for the WebSocket handshake before opening.
  useEffect(() => {
    if (!ready) return;
    if (routeConversationId) {
      if (openId !== routeConversationId) void controller.openConversation(routeConversationId);
    } else if (openId) {
      controller.closeConversation();
    }
  }, [ready, routeConversationId, openId, controller]);

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
        if (routeConversationId) {
          goToList();
          return;
        }
      }

      // List navigation is only active when no conversation is open (otherwise
      // the composer owns the keyboard), mirroring the TUI.
      if (routeConversationId) return;
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
      <div className="flex min-h-0 flex-1">
        <ConversationList
          selectedIndex={selectedIndex}
          onSelect={setSelectedIndex}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <MessagePane />
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

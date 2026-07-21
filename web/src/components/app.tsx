import { useCallback, useEffect, useState } from "react";
import { ControllerProvider, useAppState, useController } from "./controller-context";
import { ConversationList } from "./conversation-list";
import { MessagePane } from "./message-pane";
import { StatusBar } from "./status-bar";
import { CommandPalette } from "./command-palette";
import { SettingsDialog } from "./settings-dialog";
import { Splash } from "./splash";
import { TooltipProvider } from "./ui/tooltip";
import { Button } from "./ui/button";

export function App() {
  return (
    <ControllerProvider>
      <TooltipProvider delayDuration={300}>
        <AppInner />
      </TooltipProvider>
    </ControllerProvider>
  );
}

function AppInner() {
  const controller = useController();
  const ready = useAppState((s) => s.ready);
  const fatal = useAppState((s) => s.fatal);
  const splashMessage = useAppState((s) => s.splashMessage);
  const conversations = useAppState((s) => s.conversations);
  const openId = useAppState((s) => s.openId);
  const replyingTo = useAppState((s) => s.replyingTo);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

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
        if (openId) {
          controller.closeConversation();
          return;
        }
      }

      // List navigation is only active when no conversation is open (otherwise
      // the composer owns the keyboard), mirroring the TUI.
      if (openId) return;
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
        if (c) void controller.openConversation(c.id);
      }
    },
    [paletteOpen, settingsOpen, replyingTo, openId, conversations, selectedIndex, controller],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  if (!ready) return <Splash message={splashMessage} />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1">
        <ConversationList selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
        <MessagePane />
      </div>
      <StatusBar />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {fatal && <FatalOverlay message={fatal} />}
    </div>
  );
}

function FatalOverlay(props: { message: string }) {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background/95 backdrop-blur">
      <p className="text-sm text-destructive">{props.message}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        Reconnect
      </Button>
    </div>
  );
}

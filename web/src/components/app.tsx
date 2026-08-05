import { useCallback, useEffect, useState } from "react";
import { Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { ControllerProvider, useAppState, useController } from "./controller-context";
import { CalendarPane } from "./calendar-pane";
import { ConversationList } from "./conversation-list";
import { MailPane } from "./mail-pane";
import { MessagePane } from "./message-pane";
import { SettingsPane } from "./settings-pane";
import { TasksPanel } from "./tasks-panel";
import { CommandPalette } from "./command-palette";
import { SettingsDialog } from "./settings-dialog";
import { CallBar } from "./call-bar";
import { IncomingCallBanner } from "./incoming-call-banner";
import { Splash } from "./splash";
import { useChatSections } from "./use-chat-sections";
import { TooltipProvider } from "./ui/tooltip";
import { Button } from "./ui/button";
import { hasModifier } from "~/lib/platform";
import { cn } from "~/lib/utils";
import { installVirtualKeyboardState } from "~/lib/virtual-keyboard";

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
  const navigate = useNavigate();
  const ready = useAppState((s) => s.ready);
  const fatal = useAppState((s) => s.fatal);
  // Survives the socket drop, because it is plain state rather than connection state.
  const repairing = useAppState((s) => s.brokerStatus?.repairing ?? false);
  const splashMessage = useAppState((s) => s.splashMessage);
  const sidebarTab = useAppState((s) => s.sidebarTab);
  const openId = useAppState((s) => s.openId);
  const replyingTo = useAppState((s) => s.replyingTo);
  const mailMessages = useAppState((s) => s.mailMessages);
  const openMailId = useAppState((s) => s.openMailId);
  const tasksPanelOpen = useAppState((s) => s.tasksPanelOpen);
  const { chats: visibleChats } = useChatSections();

  // The URL is the source of truth for what is open. `/` means nothing; `/c/<id>` a
  // conversation; `/m/<id>` a mail. `strict: false` lets this shell read either
  // param whether or not its route is the matched one.
  const { conversationId, mailId } = useParams({ strict: false });
  const routeConversationId = conversationId ?? null;
  const routeMailId = mailId ?? null;

  // Whether the settings route is active. When it is, the right pane shows the
  // settings surface instead of a conversation; the sidebar stays put.
  const matchRoute = useMatchRoute();
  const onSettings = !!matchRoute({ to: "/settings" });

  // Below the `md` breakpoint the UI is single-pane: the conversation list is the
  // home screen and a conversation (or Settings) takes the screen over it as a
  // separate "page", Teams-style. `paneOpen` decides which page is up. The switch is
  // immediate — there is no transition between the two pages. On desktop both
  // columns are always on screen.
  // The calendar has no list-then-detail shape: its sidebar rail is a picker, not a
  // list of things to open, so on mobile the grid IS the page and the pane is up as
  // soon as the tab is.
  const paneOpen =
    !!routeConversationId || !!routeMailId || onSettings || sidebarTab === "calendar";

  // Whether the CalendarPane is the surface in that slot — Settings wins over it, and a
  // conversation or a mail takes the pane over the grid. Named once because two things
  // depend on it: the render below, and the keyboard, since that pane binds `t` to "today"
  // on a window listener of its own and is the one place the task panel's `t` stands
  // aside. Gating on the tab alone would have made `t` dead with a thread open beside it.
  const onCalendar =
    !onSettings && sidebarTab === "calendar" && !routeConversationId && !routeMailId;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => installVirtualKeyboardState(), []);

  const goToConversation = useCallback(
    (id: string) => {
      void navigate({ to: "/c/$conversationId", params: { conversationId: id } });
    },
    [navigate],
  );
  const goToMail = useCallback(
    (id: string) => {
      void navigate({ to: "/m/$mailId", params: { mailId: id } });
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
  // Closing is immediate on every layout: the detail pane hides at once, so no
  // animation can catch the pane mid-swap.
  useEffect(() => {
    if (!ready) return;
    if (routeConversationId) {
      if (openId !== routeConversationId) void controller.openConversation(routeConversationId);
      return;
    }
    if (openId) controller.closeConversation();
  }, [ready, routeConversationId, openId, controller]);

  // The same reconciliation for mail: `/m/<id>` opens that message through the
  // controller, and leaving the route closes it. Mail bodies are cached (locally and
  // in the backend), so moving between messages and back is instant.
  useEffect(() => {
    if (!ready) return;
    if (routeMailId) {
      if (openMailId !== routeMailId) void controller.openMail(routeMailId);
      return;
    }
    if (openMailId) controller.closeMail();
  }, [ready, routeMailId, openMailId, controller]);

  // The keyboard-navigable list is whichever the active tab shows: chats or mail.
  // (The channel tree is a tree, not a flat list, and the calendar is a grid — both
  // use click/Tab focus, and the calendar pane owns its own arrow keys.)
  //
  // For chats it is the list AS RENDERED — the sidebar's own sections, minus whatever
  // is folded away (see `useChatSections`). The selection is an index into that order,
  // so deriving it from anywhere else is how ArrowDown ends up opening a chat other
  // than the highlighted row.
  const keyboardList = sidebarTab === "mail" ? mailMessages : visibleChats;

  // Keep the selection in range as the active list changes.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, keyboardList.length - 1)));
  }, [keyboardList.length]);

  // Switching tabs starts the selection over: index 3 of the chat list means
  // nothing in the mail list.
  useEffect(() => {
    setSelectedIndex(0);
  }, [sidebarTab]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Dialogs own their own keys while open.
      if (paletteOpen || settingsOpen) return;

      // Every shortcut takes Ctrl or Cmd, so the Mac keystroke works as typed.
      if (hasModifier(e) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (hasModifier(e) && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.key === "Escape") {
        if (replyingTo) {
          controller.cancelReply();
          return;
        }
        // The panel is the thing on top — literally so on a phone, where it covers the
        // conversation — so Escape puts it away before it walks back to the list.
        if (tasksPanelOpen) {
          controller.closeTasksPanel();
          return;
        }
        if (routeConversationId || routeMailId || onSettings) {
          goToList();
          return;
        }
      }

      // From here down every shortcut is a BARE key, so three things disqualify the event
      // first, and ONE guard does it for all of them. Focus in a field means the user is
      // writing — `isContentEditable` is what covers the composer, which is a TipTap
      // contenteditable rather than a <textarea>, and which the list keys below only
      // avoided because a composer exists on the routes they already skip. A floating layer
      // owns the keyboard while it has the focus, and a menu's own typeahead is letters, so
      // `t` inside one must never reach the app behind it (`dialog` is spelled beside the
      // two roles because the picture lightbox is a NATIVE <dialog>, whose role is implicit
      // and so unmatched by an attribute selector). And a held modifier means a shortcut:
      // Cmd+K must never also move the selection up.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          target.closest('dialog,[role="dialog"],[role="menu"]'))
      ) {
        return;
      }
      if (hasModifier(e) || e.altKey) return;

      // The task panel. Bare, because every modifier pair worth having is taken —
      // Cmd+K/Cmd+P are this app's, Cmd+T/Cmd+Shift+T/Cmd+J the browser's, Cmd+B bold in
      // the composer — and above the list keys, because the panel is meant to be read
      // BESIDE an open thread. The one exception is the calendar's own `t` (see
      // `onCalendar`): two handlers on one key would fire both.
      if ((e.key === "t" || e.key === "T") && !onCalendar) {
        e.preventDefault();
        controller.toggleTasksPanel();
        return;
      }

      // List navigation is only active when nothing is open and we're not on
      // settings (otherwise the composer / settings form own the keyboard). It
      // drives whichever virtualized list the active tab shows — Chats or Mail;
      // the Channels tab is a tree and uses click/Tab focus.
      if (routeConversationId || routeMailId || onSettings) return;
      if (sidebarTab === "channels" || sidebarTab === "calendar") return;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, keyboardList.length - 1));
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const item = keyboardList[selectedIndex];
        if (!item) return;
        if (sidebarTab === "mail") goToMail(item.id);
        else goToConversation(item.id);
      }
    },
    [
      paletteOpen,
      settingsOpen,
      replyingTo,
      tasksPanelOpen,
      routeConversationId,
      routeMailId,
      onSettings,
      onCalendar,
      sidebarTab,
      keyboardList,
      selectedIndex,
      controller,
      goToConversation,
      goToMail,
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
        />
        {/* The detail pane. On mobile it is a full-screen overlay parked off the
            right edge until `paneOpen`, then flush over the conversation list — the
            `translate-x` switches with no transition, so one page replaces the other
            at once; at `md` and up it collapses into a static second column that is
            always visible, so the desktop two-pane layout is unchanged. */}
        <div
          data-testid="detail-pane"
          data-open={paneOpen ? "true" : undefined}
          className={cn(
            "absolute inset-0 z-20 flex bg-background",
            "md:static md:z-auto md:flex-1 md:translate-x-0",
            paneOpen ? "translate-x-0" : "translate-x-full",
          )}
        >
          {/* Which surface the detail pane shows. Settings wins; then the calendar
              when its tab is up; then a mail — either one addressed by the URL, or
              the Mail tab's own empty state, so switching to Mail does not leave a
              chat's empty state on the right. */}
          {onSettings ? (
            <SettingsPane onBack={goToList} />
          ) : onCalendar ? (
            <CalendarPane onBack={() => controller.setSidebarTab("chats")} />
          ) : routeMailId || (sidebarTab === "mail" && !routeConversationId) ? (
            <MailPane onBack={goToList} />
          ) : (
            <MessagePane onBack={goToList} />
          )}
        </div>

        {/* After the detail pane and inside the same flex row, which is what makes the
            wide shape narrow the message pane rather than cover it. Below `md` it is a
            full-screen sheet of its own (z-40, over the pane's z-20). */}
        {tasksPanelOpen && <TasksPanel />}
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* The real call, over the awareness banner: one is a call this machine can
          answer, the other is a note that a call happened somewhere. */}
      <CallBar />
      <IncomingCallBanner />

      {/* A repair restarts the backend on purpose, so the socket drops and the
          reconnect can outlast its 35 s give-up window. Telling the user the backend
          is "lost" at the exact moment they asked for a repair reads as a failure —
          say what is actually happening instead. */}
      {fatal && <FatalOverlay message={repairing ? REPAIRING_MESSAGE : fatal} />}

      {/* The conversation routes render nothing themselves; the shell above is
          the whole UI. Rendering the Outlet keeps the matched route mounted so
          its URL (and thus the open conversation) stays authoritative. */}
      <Outlet />
    </div>
  );
}

/** What the overlay says while a broker repair is running — the backend is meant to be
 *  down at that moment, so "backend lost" would be a lie of emphasis. */
const REPAIRING_MESSAGE =
  "Repairing sign-in — the Intune container is restarting. This takes about a minute, and the app reconnects on its own.";

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

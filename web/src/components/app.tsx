import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { ControllerProvider, useAppState, useController } from "./controller-context";
import { CalendarPane } from "./calendar-pane";
import { ConversationList } from "./conversation-list";
import { GitLabPane } from "./gitlab-pane";
import { MailPane } from "./mail-pane";
import { MessagePane } from "./message-pane";
import { SettingsPane } from "./settings-pane";
import { CommandPalette } from "./command-palette";
import { SettingsDialog } from "./settings-dialog";
import { CallBar } from "./call-bar";
import { CallStageProvider, useCallStage } from "./call-stage-context";
import { GitLabDiffPage } from "./gitlab-diff-page";
import { GitLabReviewPage } from "./gitlab-review-page";
import { GitLabJobLogPage } from "./gitlab-job-log-page";
import { IncomingCallBanner } from "./incoming-call-banner";
import { AppToaster } from "./app-toaster";
import { SigninPanel } from "./signin-panel";
import { Splash } from "./splash";
import { TrackerRefsProvider } from "./tracker-refs-context";
import { useChatSections } from "./use-chat-sections";
import { TooltipProvider } from "./ui/tooltip";
import { Button } from "./ui/button";
import { callStageIsUp } from "~/lib/call-stage";
import {
  mergeRequestId as gitlabRowId,
  parseMergeRequestId,
  sameMergeRequest,
} from "~/lib/gitlab-mr";
import { aLayerWasOpen, aModalIsOpen, hasModifier, watchOpenLayers } from "~/lib/platform";
import { cn } from "~/lib/utils";
import { installVirtualKeyboardState } from "~/lib/virtual-keyboard";

/**
 * The chess PAGE carries the rules engine and the board renderer, so it is reached through a lazy
 * chunk and never sits on the path of a chat — the rule `@pierre/diffs` holds for the diff and the
 * board's own card already holds in the history.
 */
const ChessPage = lazy(() => import("./chess-page").then((m) => ({ default: m.ChessPage })));

export function App() {
  return (
    <ControllerProvider>
      <TooltipProvider delayDuration={300}>
        {/* Which shape the live call is in, and which of its panels is open. It sits above
            the whole shell because two surfaces read it: the call itself, and the message
            pane — which gives up its composer while the call's chat panel holds it (see
            `useCallOwnsComposer`). */}
        <CallStageProvider>
          {/* What this machine can read a tracker reference with — the GitLab host and the
              Linear workspace. Above the whole shell because every surface that draws words
              draws a reference: a message, a card, an agent's answer, a merge request's own
              description (see components/tracker-refs-context.tsx). */}
          <TrackerRefsProvider>
            <AppInner />
          </TrackerRefsProvider>
        </CallStageProvider>
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
  const gitlabList = useAppState((s) => s.gitlabList);
  const openMergeRequest = useAppState((s) => s.openMergeRequest);
  const openJobId = useAppState((s) => s.gitlabJobId);
  const { chats: visibleChats } = useChatSections();
  // Whether a live call is drawn over the whole app right now (see call-stage.tsx).
  const callStage = useCallStage();
  const liveCall = useAppState((s) => s.callStatus.call);
  const callHasTheScreen = callStage.mode === "full" && callStageIsUp(liveCall);

  // The URL is the source of truth for what is open. `/` means nothing; `/c/<id>` a
  // conversation; `/m/<id>` a mail; `/mr/<project>!<iid>` a merge request. `strict: false`
  // lets this shell read any of those params whether or not its route is the matched one.
  const { conversationId, mailId, mergeRequestId, jobId, gameId } = useParams({ strict: false });
  const routeConversationId = conversationId ?? null;
  const routeMailId = mailId ?? null;
  // A malformed id resolves to null, which reads as "nothing open" — the page then shows
  // its own empty state instead of asking the backend about an address that names nothing.
  const routeMergeRequest = useMemo(
    () => (mergeRequestId ? parseMergeRequestId(mergeRequestId) : null),
    [mergeRequestId],
  );
  // Which SURFACE the URL asks for is the route, not the parse: an id that names nothing
  // still asked for the merge-request page, and answering it with a chat's empty state would
  // send the reader looking for a chat they never opened.
  const onMergeRequestRoute = mergeRequestId != null;

  // Whether the settings route is active. When it is, the right pane shows the
  // settings surface instead of a conversation; the sidebar stays put.
  const matchRoute = useMatchRoute();
  const onSettings = !!matchRoute({ to: "/settings" });
  // The DIFF of a merge request is a page of its own — two columns, the changed files and one
  // of them — so it takes the whole screen rather than the detail pane: a third column of chat
  // rows beside it would leave neither of its own two enough room (see gitlab-diff-page.tsx).
  const onDiffRoute = !!matchRoute({ to: "/mr/$mergeRequestId/diff" });
  // THE READING takes the whole screen for the diff's own reason and one of its own: it is a long
  // document with real patches in it, so a column of chat rows beside it would leave the prose
  // nowhere near a readable measure and the code narrower still.
  const onReviewRoute = !!matchRoute({ to: "/mr/$mergeRequestId/review" });
  // ONE job's LOG takes the whole screen for the diff's own reason: it is 4 000 lines of
  // monospace, one of which measured 22 KB, and a column of chat rows beside it would leave it
  // none of the width it needs. A malformed id resolves to null, which reads as "no job open" —
  // the page then says it is reading nothing rather than asking the backend about a job that
  // names nothing.
  const routeJobId = useMemo(() => {
    if (jobId === undefined) return null;
    const parsed = Number(jobId);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [jobId]);
  const onJobRoute = !!matchRoute({ to: "/mr/$mergeRequestId/jobs/$jobId" });
  // ONE GAME OF CHESS takes the whole screen for the diff's own reasons: the board, the score
  // sheet and the conversation's own chat are three columns, and a fourth of chat rows beside them
  // would leave none of them the room. The game is named by the six hex characters its messages
  // already carry (see lib/chess-wire.ts).
  const onChessRoute = !!matchRoute({ to: "/c/$conversationId/chess/$gameId" });
  const routeGameId = typeof gameId === "string" ? gameId : null;

  // Below the `md` breakpoint the UI is single-pane: the conversation list is the
  // home screen and a conversation (or Settings) takes the screen over it as a
  // separate "page", Teams-style. `paneOpen` decides which page is up. The switch is
  // immediate — there is no transition between the two pages. On desktop both
  // columns are always on screen.
  // The calendar has no list-then-detail shape: its sidebar rail is a picker, not a
  // list of things to open, so on mobile the grid IS the page and the pane is up as
  // soon as the tab is.
  const paneOpen =
    !!routeConversationId ||
    !!routeMailId ||
    onMergeRequestRoute ||
    onSettings ||
    sidebarTab === "calendar";

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => installVirtualKeyboardState(), []);
  // Whether a dismissable layer was open when a key was pressed, recorded in the CAPTURE phase
  // so the Escape handler below can ask a question that is impossible to answer later (see
  // lib/platform.ts `watchOpenLayers`). Installed at mount, which is what puts it ahead of every
  // layer's own listener.
  useEffect(() => watchOpenLayers(), []);

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
  const goToMergeRequest = useCallback(
    (id: string) => {
      void navigate({ to: "/mr/$mergeRequestId", params: { mergeRequestId: id } });
    },
    [navigate],
  );
  const goToMergeRequestDiff = useCallback(
    (id: string) => {
      void navigate({ to: "/mr/$mergeRequestId/diff", params: { mergeRequestId: id } });
    },
    [navigate],
  );
  const goToMergeRequestPipeline = useCallback(
    (id: string) => {
      void navigate({ to: "/mr/$mergeRequestId/pipelines", params: { mergeRequestId: id } });
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

  // The same reconciliation for a merge request: `/mr/<id>` opens it through the
  // controller, and leaving the route closes it — which also stops the pipeline poll, so a
  // page nobody is looking at asks GitLab nothing.
  useEffect(() => {
    if (!ready) return;
    if (routeMergeRequest) {
      if (!sameMergeRequest(openMergeRequest, routeMergeRequest)) {
        void controller.openMergeRequestPage(routeMergeRequest);
      }
      return;
    }
    if (openMergeRequest) controller.closeMergeRequestPage();
  }, [ready, routeMergeRequest, openMergeRequest, controller]);

  // The same reconciliation for ONE JOB's log: `/mr/<id>/jobs/<jobId>` opens it through the
  // controller, and leaving the route closes it — which stops its poll, so a log nobody is looking
  // at asks GitLab nothing. It waits for the merge request itself to be open, because the log is
  // read under that merge request's own cache prefix.
  useEffect(() => {
    if (!ready) return;
    if (routeMergeRequest && routeJobId !== null) {
      if (openJobId !== routeJobId) void controller.openJobLog(routeMergeRequest, routeJobId);
      return;
    }
    if (openJobId !== null) controller.closeJobLog();
  }, [ready, routeMergeRequest, routeJobId, openJobId, controller]);

  // The keyboard-navigable list is whichever the active tab shows: chats or mail.
  // (The channel tree is a tree, not a flat list, and the calendar is a grid — both
  // use click/Tab focus, and the calendar pane owns its own arrow keys.)
  //
  // For chats it is the list AS RENDERED — the sidebar's own sections, minus whatever
  // is folded away (see `useChatSections`). The selection is an index into that order,
  // so deriving it from anywhere else is how ArrowDown ends up opening a chat other
  // than the highlighted row.
  // A merge-request row is keyed by its own pair rather than by an `id`, so the shared
  // list shape is built for it here — the keyboard walks the rows as rendered, exactly as
  // it does for chats and mail.
  // Memoized because the GitLab branch DERIVES its rows: a fresh array on every render
  // would re-attach the window's keydown listener on every render, since `onKeyDown`
  // closes over this list.
  const gitlabKeyboardRows = useMemo(
    () =>
      gitlabList.map((row) => ({
        id: gitlabRowId({ projectPath: row.project_path, iid: row.iid }),
      })),
    [gitlabList],
  );
  const keyboardList =
    sidebarTab === "mail"
      ? mailMessages
      : sidebarTab === "gitlab"
        ? gitlabKeyboardRows
        : visibleChats;

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

      // A full-screen call owns the screen, so neither dialog is OPENED behind it: both are
      // modal and trap the keyboard, and one opened under an opaque surface would take every
      // keystroke somewhere nobody can see. Folding the call away (Escape, or the control in
      // its header) hands the shortcuts straight back.
      if (callHasTheScreen && hasModifier(e)) return;

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
        // A LAYER THE READER WAS LOOKING AT OWNS THE KEY, and whether one was is answered from
        // the capture phase rather than from here — `watchOpenLayers` asks before Radix has
        // moved anything, because by the time this bubble handler runs the layer it dismissed
        // already reads `closed` and is still mounted for its exit animation. That timing is
        // the whole of it, and both wrong answers shipped: reading nothing let one Escape close
        // the conversation's own menu AND leave the conversation, and reading mere PRESENCE let
        // a menu that was closing swallow the Escape that cancels the pending reply its own row
        // had just started.
        if (aLayerWasOpen()) return;
        // AND A DIALOG THAT IS UP BUT NEVER SAW THE KEY still owns it. A native
        // `datetime-local` input eats Escape for its own calendar (§ Sending a message LATER),
        // so nothing above ever hears it — while the dialog is plainly still what the reader
        // was dismissing.
        if (aModalIsOpen()) return;
        if (replyingTo) {
          controller.cancelReply();
          return;
        }
        // A BOARD is left for the conversation it is being played in, never for the chat list:
        // the reader is two surfaces deep, and one Escape does one thing (see § A HOLD is how a
        // phone reaches a menu for the same rule about one press meaning one thing).
        if (onChessRoute && routeConversationId) {
          void navigate({ to: "/c/$conversationId", params: { conversationId: routeConversationId } });
          return;
        }
        if (routeConversationId || routeMailId || onMergeRequestRoute || onSettings) {
          goToList();
          return;
        }
      }

      // List navigation is only active when nothing is open and we're not on
      // settings (otherwise the composer / settings form own the keyboard). It
      // drives whichever virtualized list the active tab shows — Chats or Mail;
      // the Channels tab is a tree and uses click/Tab focus.
      if (routeConversationId || routeMailId || onMergeRequestRoute || onSettings) return;
      if (sidebarTab === "channels" || sidebarTab === "calendar") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      // A held modifier means a shortcut, not list navigation: Cmd+K must never also
      // move the selection up.
      if (hasModifier(e) || e.altKey) return;

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
        else if (sidebarTab === "gitlab") goToMergeRequest(item.id);
        else goToConversation(item.id);
      }
    },
    [
      paletteOpen,
      settingsOpen,
      replyingTo,
      routeConversationId,
      routeMailId,
      onMergeRequestRoute,
      onSettings,
      sidebarTab,
      keyboardList,
      selectedIndex,
      controller,
      goToConversation,
      goToMail,
      goToMergeRequest,
      goToList,
      callHasTheScreen,
      onChessRoute,
      navigate,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKeyDown]);

  if (!ready) return <Splash message={splashMessage} />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* The DIFF is the one surface that takes the whole screen rather than the detail pane.
          It is two columns of its own — the changed files and one of them read in full — and a
          third column of chat rows beside them would leave neither enough room. Everything
          else stays mounted below it in the tree, so leaving the diff costs no re-read: the
          merge request the reader came from is still open in the controller. */}
      {onJobRoute ? (
        <div className="flex min-h-0 flex-1">
          {/* Back leaves the log for the PIPELINE the reader pressed a card on, not for the
              merge request: that is where they were, and the strip above is how they go
              anywhere else. */}
          <GitLabJobLogPage
            onBack={() =>
              mergeRequestId ? goToMergeRequestPipeline(mergeRequestId) : goToList()
            }
          />
        </div>
      ) : onDiffRoute ? (
        <div className="flex min-h-0 flex-1">
          <GitLabDiffPage
            onBack={() => (mergeRequestId ? goToMergeRequest(mergeRequestId) : goToList())}
          />
        </div>
      ) : onReviewRoute ? (
        <div className="flex min-h-0 flex-1">
          {/* A press on a file name in the reading opens that file in the FEED, which is the
              surface built for reading a patch at length. The file is named to the controller
              first, because the diff page reads where to OPEN from that state (`openAt`) — so
              navigating without it would land the reader at the top of the branch instead. */}
          <GitLabReviewPage
            onBack={() => (mergeRequestId ? goToMergeRequest(mergeRequestId) : goToList())}
            onOpenFile={(path) => {
              controller.setGitLabDiffFile(path);
              if (mergeRequestId) goToMergeRequestDiff(mergeRequestId);
            }}
            // And a press on a NAME in the reading's prose leaves for the same page with that
            // name's own occurrences panel open on it — the surface built for a list of places,
            // which is where a coarse pointer is sent because a floating card cannot be drawn over
            // a 317px document (see review-code-chip.tsx). The name is resolved to a PLACE first,
            // for the reason the file is named first: the diff page reads where to open from that
            // state, so navigating without it lands the reader at the top of the branch.
            onOpenSymbol={(symbol, place) => {
              controller.openGitLabReviewSymbol(symbol, place);
              if (mergeRequestId) goToMergeRequestDiff(mergeRequestId);
            }}
          />
        </div>
      ) : onChessRoute && routeConversationId && routeGameId ? (
        <div className="flex min-h-0 flex-1">
          {/* Back leaves the board for the CONVERSATION the game is being played in — that is
              where the reader was, and the game is one row of it. */}
          <Suspense
            fallback={
              <div
                data-testid="chess-page-loading"
                aria-hidden
                className="flex-1 animate-pulse bg-panel/40"
              />
            }
          >
            <ChessPage
              conversationId={routeConversationId}
              gameId={routeGameId}
              onBack={() =>
                void navigate({
                  to: "/c/$conversationId",
                  params: { conversationId: routeConversationId },
                })
              }
            />
          </Suspense>
        </div>
      ) : (
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
              always visible, so the desktop two-pane layout is unchanged.

              `min-w-0` is what makes every pane inside it able to SHORTEN a long line. A
              flex item may not shrink below its own content by default, and a `truncate`d
              title is one unbreakable line as wide as its words — so a merge request whose
              title lists every ticket it closes grew this column past the window, which
              pushed the article and its controls off the right of the screen. Each pane
              already declares its own `min-w-0`; this is the link above them. */}
          <div
            data-testid="detail-pane"
            data-open={paneOpen ? "true" : undefined}
            className={cn(
              "absolute inset-0 z-20 flex min-w-0 bg-background",
              "md:static md:z-auto md:flex-1 md:translate-x-0",
              paneOpen ? "translate-x-0" : "translate-x-full",
            )}
          >
            {/* Which surface the detail pane shows. Settings wins; then a merge request —
                either one addressed by the URL, or the GitLab tab's own empty state; then
                the calendar when its tab is up; then a mail, on the same two conditions.
                Each tab owning its own empty state is what stops switching sections from
                leaving another section's empty state on the right. */}
            {onSettings ? (
              <SettingsPane onBack={goToList} />
            ) : onMergeRequestRoute ||
              (sidebarTab === "gitlab" && !routeConversationId && !routeMailId) ? (
              <GitLabPane
                onBack={goToList}
                onOpenDiff={() => mergeRequestId && goToMergeRequestDiff(mergeRequestId)}
                onOpenPipeline={() => mergeRequestId && goToMergeRequestPipeline(mergeRequestId)}
              />
            ) : sidebarTab === "calendar" && !routeConversationId && !routeMailId ? (
              <CalendarPane onBack={() => controller.setSidebarTab("chats")} />
            ) : routeMailId || (sidebarTab === "mail" && !routeConversationId) ? (
              <MailPane onBack={goToList} />
            ) : (
              <MessagePane onBack={goToList} />
            )}
          </div>
        </div>
      )}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* Signing in again, when the identity broker asks a human. It draws itself off the
          app's own `signin` state, so it appears on whichever page is open — including one
          that connects mid-flow, which is the normal way this is used: press it on the
          laptop, finish it on the phone (see signin-panel.tsx and SIGN-IN.md). */}
      <SigninPanel />

      {/* The real call, over the awareness banner: one is a call this machine can
          answer, the other is a note that a call happened somewhere. */}
      <CallBar />
      <IncomingCallBanner />

      {/* Where a transient notice lands — one sentence about something that happened,
          which leaves on its own (see lib/notice.ts). It sits above the call bar rather
          than over it, and the bar reserves that room itself. */}
      <AppToaster />

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

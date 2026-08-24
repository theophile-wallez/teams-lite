import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CallIcon,
  ChessPawnIcon,
  Loading02Icon,
  LockIcon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import {
  agentGrantIsOn,
  agentHint,
  agentIsUnrestricted,
  agentModeFor,
  agentRunnable,
  agentToolGrants,
  agentToolsWithGrant,
  usableBackends,
  type AgentToolGrant,
} from "~/lib/agent";
import {
  callUnavailableReason,
  canJoinMeeting,
  canPlaceCall,
  conversationCallAction,
  isMeetingJoinLink,
  meetingAddressOf,
  meetingUnavailableReason,
} from "~/lib/call";
import type { ChessGame } from "~/lib/chess-thread";
import { newChessGameId, type ChessColor } from "~/lib/chess-wire";
import { convLabel, isGroupChat } from "~/lib/protocol";
import { sealCanBeUsed, sealMenuLabel } from "~/lib/seal";
import { cn } from "~/lib/utils";
import { chessButtonState, chessChallengeLabel, conversationHoldsChess } from "./chess-button";
import { useAppState, useController } from "./controller-context";
import { SealDialog } from "./seal-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** Every row carries its glyph in the same gutter, so the labels read as one column rather than
 *  as one group per feature — the rule chat-menu.tsx states for the sidebar's own "…". */
const ITEM_ICON = "size-4 shrink-0 text-text-dim";

/**
 * Everything a conversation offers, behind ONE trigger in its header.
 *
 * It used to be three controls side by side — the call, chess, the agent — and each one drew
 * itself only where it would work, which is the right rule for a control and the wrong shape
 * for a row of them: **the thing the reader aims at moved between conversations.** A 1:1 has a
 * call; a meeting chat has a Join in that slot instead; Notes has neither, so the agent switch
 * slid left into the space; a channel has only the agent. So the second control from the right
 * was a different action in every thread, which on a phone is a mis-tap and on a desktop is a
 * hesitation. One trigger, in one place, in every conversation, is steadier — and it is what
 * the user asked for.
 *
 * **The cost is honest and worth saying: a call is now two presses.** That is the trade — a
 * target that never moves, paid for with one extra press on the commonest action here. What is
 * bought back is that every OTHER action is two presses as well rather than hidden behind a
 * glyph the reader had to recognise first, and that the menu has room for WORDS: a refusal used
 * to live in a tooltip, which on a coarse pointer is a sentence that does not exist.
 *
 * Nothing about the gates moved with the controls. Each row is drawn under exactly the
 * condition its button was drawn under, carries the same `aria-label`, and states the same
 * reason where it cannot act (see components/call-button.tsx, chess-button.tsx and
 * agent-menu.tsx, which is where each of these rules is argued).
 *
 * Two things stay OUTSIDE the closed menu, because a signal inside one says nothing:
 *
 * - **the attention DOT** the chess control carried. Its whole job is to say the game wants
 *   something from the reader — their move, or their answer to a challenge — while the board is
 *   a screen away, so it moves onto the trigger;
 * - **the agent's own "on"**, as the trigger's accent. "A machine may post under my name in
 *   this thread" is the sharpest state this header ever stated, and a consent that can only be
 *   read by opening a menu is one the reader stops checking.
 *
 * The two do not compete: the accent is a standing state, the dot is a thing waiting to be
 * done, and this app already spells them that way in both places they came from.
 */
export function ConversationMenu(props: { conversationId: string; games: ChessGame[] }) {
  const controller = useController();
  const conversation = useAppState((s) =>
    s.conversations.find((c) => c.id === props.conversationId),
  );
  const callStatus = useAppState((s) => s.callStatus);
  const agent = useAppState((s) => s.agent);
  const sealStatus = useAppState((s) => s.sealStatus);

  const [open, setOpen] = useState(false);
  const [sealOpen, setSealOpen] = useState(false);
  const [challenging, setChallenging] = useState(false);
  const [color, setColor] = useState<"w" | "b" | "random">("random");
  const [chessError, setChessError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // ---- the call, or the meeting this thread was minted for -------------------
  //
  // One question, two answers, and the conversation decides which — the split
  // `conversationCallAction` already owns. A meeting is JOINED rather than rung, because
  // ringing everybody invited answers the same question and is not what the thread is for.
  const action = conversationCallAction(conversation);
  const meeting = meetingAddressOf(conversation);
  // An address this app cannot join is not offered at all, which is the Join button's own
  // rail: a small port of `calling::MeetingJoin::from_join_url`, checked again by the backend,
  // so the worst a disagreement costs is a row that reports a refusal.
  const joinable =
    !!meeting && (meeting.kind === "thread" || isMeetingJoinLink(meeting.joinUrl));
  // Notes has nobody to ring and a channel is not in this list at all, so both get no row —
  // absent rather than disabled, because a row that cannot do the thing it names is worse than
  // no row. `enabled: false` is the one exception, below: the feature is real and this WINDOW
  // is not where it happens, which is a reason worth stating.
  const showCallRow = action === "call" || (action === "join" && joinable);
  const callReady = action === "join" ? canJoinMeeting(callStatus) : canPlaceCall(callStatus);
  const callReason =
    action === "join" ? meetingUnavailableReason(callStatus) : callUnavailableReason(callStatus);
  const group = !!conversation && isGroupChat(conversation);
  const conversationName = conversation ? convLabel(conversation) : "";
  // The three labels the buttons carried, verbatim. A group call rings EVERY member at once,
  // so it names what the press reaches rather than one person — the fact the user needs before
  // the click and the one thing they cannot take back after it.
  const callLabel =
    action === "join"
      ? "Join this meeting with audio"
      : group
        ? `Call everybody in ${conversationName}`
        : `Call ${conversation?.name || "this person"}`;

  // ---- chess ----------------------------------------------------------------
  //
  // The pure half comes from chess-button.tsx rather than being restated here: which state the
  // control is in, and what a challenge reaches, are decisions with tests of their own, and two
  // spellings of them would drift at the first group chat.
  const holdsChess = conversationHoldsChess(conversation);
  const chess = chessButtonState(props.games);
  // The game in flight, or nothing — asked once, because the trigger's dot, the trigger's own
  // attributes and the row all answer from it, and three separate readings of the same pair of
  // conditions is where one of them ends up drawn in a conversation that holds no game.
  const liveGame = holdsChess && chess.kind === "open" ? chess : null;

  // ---- the local agent ------------------------------------------------------
  const mode = agentModeFor(agent, props.conversationId);
  const agentOn = mode === "reply";
  const runnable = agentRunnable(agent);
  // Only the providers that would really answer: a hint must never name a prefix one of the
  // user's own settings drops.
  const backends = usableBackends(agent);
  const grants = agentToolGrants(agent);
  const unrestricted = agentIsUnrestricted(agent);

  // ---- the seal -------------------------------------------------------------
  //
  // Asked of the CONVERSATION rather than of the open id, which is what keeps a channel out:
  // `sealCanBeUsed` recognises a channel by the backend's own thread-id shape, and a channel
  // opened here is simply not in this list at all — the surer signal, and the same one the call
  // and chess rows are drawn under.
  const canSeal = !!conversation && sealCanBeUsed(conversation.kind, props.conversationId);

  const toggleAgentMode = async (next: boolean) => {
    setBusy(true);
    setAgentError(null);
    try {
      await controller.setAgentMode(props.conversationId, next ? "reply" : "off");
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleUnrestricted = async (next: boolean) => {
    setBusy(true);
    setAgentError(null);
    try {
      await controller.setAgentUnrestricted(next);
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleGrant = async (grant: AgentToolGrant, next: boolean) => {
    if (!agent) return;
    setBusy(true);
    setAgentError(null);
    try {
      await controller.setAgentTools(agentToolsWithGrant(agent, grant, next));
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const challenge = async () => {
    // Random is resolved HERE, into the colour the challenge really carries: the wire never
    // says "random", because a colour nothing decided is a game whose two clients could
    // disagree about who moves first.
    const mine: ChessColor = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color;
    setChessError(null);
    const sent = await controller.sendChessMessage(props.conversationId, {
      game: newChessGameId(),
      body: { kind: "open", color: mine },
    });
    if (sent) setOpen(false);
    else setChessError("The challenge did not go out — nothing was posted. Try again.");
  };

  return (
    <>
      {/* Non-modal, for the reason calendar-view-menu.tsx spells out: a modal Radix menu parks
          `pointer-events: none` on the body until its close animation ends, which swallows the
          next click — and the next click here is usually the composer. */}
      <DropdownMenu
        modal={false}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A closed menu forgets that a challenge was being set up, and forgets a refusal it
          // reported: reopening it a minute later to flip the agent switch must not present a
          // half-filled form, and a stale failure sentence would be a report about a press
          // the reader has moved on from. The COLOUR is deliberately kept — it is a
          // preference, not a step.
          if (!next) {
            setChallenging(false);
            setChessError(null);
          }
        }}
      >
        <DropdownMenuTrigger
          data-testid="conversation-menu"
          // What the menu holds, stated on the thing that opens it — so a driver, a spec and a
          // capture can read the state without opening it, exactly as the three controls stated
          // their own. `data-agent-mode` kept its spelling because it is the same fact.
          data-agent-mode={mode}
          data-chess-game={liveGame?.game.id}
          data-your-turn={liveGame?.ourTurn ? "true" : undefined}
          data-awaiting-answer={liveGame?.awaitingUs ? "true" : undefined}
          aria-label={
            liveGame?.wantsUs
              ? liveGame.awaitingUs
                ? "This conversation — you have been challenged to chess"
                : "This conversation — your move"
              : "What this conversation offers"
          }
          className={cn(
            "relative grid size-9 shrink-0 place-items-center rounded-lg transition-colors",
            "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            // The accent says a machine may post under the user's name in this thread. It is
            // the one standing state in here worth reading from across the room.
            agentOn ? "text-primary" : "text-text-dim hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} className="size-5" strokeWidth={1.6} />
          {/* The game wants something from the reader — their move, or their answer to a
              challenge. The board may be a screen away, and inside a closed menu this would say
              nothing at all, which is why it rides the trigger rather than the row. */}
          {liveGame?.wantsUs && (
            <span
              data-testid="chess-your-turn"
              aria-hidden
              className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </DropdownMenuTrigger>

        {/* Bounded and scrolling, because this menu is as long as the conversation makes it:
            a chat that seals, holds a game and grants four tool groups is taller than a phone.
            The app's own ceiling for a tall floating panel (see notifications-bell.tsx). */}
        <DropdownMenuContent
          data-testid="conversation-menu-content"
          align="end"
          className="max-h-[min(32rem,70vh)] w-72 overflow-y-auto"
        >
          {showCallRow && (
            <>
              <DropdownMenuItem
                // The BUTTON's own testid and the BUTTON's own address, kept: this row IS that
                // control now, and `call-live.ts` / `join-live.ts` prove their target by
                // reading exactly these attributes off the app's state immediately before the
                // click. An outward action a driver cannot prove is one it must not take.
                data-testid={action === "join" ? "meeting-join-here" : "call-button"}
                data-conversation-id={action === "join" ? undefined : props.conversationId}
                data-join-url={
                  action === "join" && meeting?.kind === "link" ? meeting.joinUrl : undefined
                }
                data-meeting-thread={
                  action === "join" && meeting?.kind === "thread" ? meeting.thread : undefined
                }
                disabled={!callReady}
                // The words plus the reason, where there is one: the label alone used to be
                // replaced by the reason, which cost a screen reader what the row is FOR.
                aria-label={callReady ? callLabel : `${callLabel} — ${callReason}`}
                onSelect={() => {
                  if (action === "join" && meeting) {
                    void controller.joinMeeting(meeting, conversationName || undefined);
                  } else {
                    void controller.startCall(props.conversationId);
                  }
                }}
              >
                {/* The HANDSET for both, the choice the two buttons already made: it is not a
                    claim that this rings anybody, it says "start talking to the people in this
                    conversation, here". The WORDS are what tell the two apart, which is the one
                    thing a menu has and a row of glyphs did not. */}
                <HugeiconsIcon icon={CallIcon} className={ITEM_ICON} strokeWidth={1.8} />
                {action === "join" ? "Join the meeting" : group ? "Call everybody here" : "Call"}
              </DropdownMenuItem>

              {/* A disabled row fires no pointer events, so a tooltip could never be reached —
                  and this app is read from a phone, where a hover is a sentence that does not
                  exist. The reason therefore stands in the menu, at full contrast, under the
                  row it explains. */}
              {!callReady && callReason && (
                <p
                  data-testid="conversation-call-reason"
                  className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint"
                >
                  {callReason}
                </p>
              )}
            </>
          )}

          {holdsChess && (
            <>
              {showCallRow && <DropdownMenuSeparator />}
              <DropdownMenuLabel>Chess</DropdownMenuLabel>

              {liveGame ? (
                <DropdownMenuItem
                  data-testid="chess-button"
                  data-chess-game={liveGame.game.id}
                  aria-label={
                    liveGame.awaitingUs
                      ? `${liveGame.game.challenger.name} challenged you to chess — go to the board`
                      : liveGame.ourTurn
                        ? "Your move — go to the chess board"
                        : "Go to the chess board"
                  }
                  onSelect={() =>
                    controller.requestScrollToMessage(
                      props.conversationId,
                      liveGame.game.challengeMessageId,
                    )
                  }
                >
                  <HugeiconsIcon icon={ChessPawnIcon} className={ITEM_ICON} strokeWidth={1.8} />
                  {liveGame.awaitingUs
                    ? "You have been challenged"
                    : liveGame.ourTurn
                      ? "Your move — go to the board"
                      : "Go to the board"}
                </DropdownMenuItem>
              ) : (
                <>
                  {/* The challenge was a POPOVER hanging off its own button, and a popover cannot
                      live inside a menu row. What it held is three toggles, a sentence and a
                      press, which is what a menu draws well — so it is a DISCLOSURE in the menu
                      rather than a dialog: a dialog for picking a colour would be a second
                      surface for one choice.
                      It stays folded, and that is not tidiness. Expanded, every reader who opened
                      this menu to flip the agent switch would be handed a chess setup form — and
                      the fold keeps the two-step the popover had, so the sentence about what the
                      press costs still arrives on a press of its own rather than in passing. */}
                  <DropdownMenuItem
                    data-testid="chess-button"
                    aria-expanded={challenging}
                    aria-label={chessChallengeLabel(conversationName, group)}
                    onSelect={(event) => {
                      event.preventDefault();
                      setChessError(null);
                      setChallenging((was) => !was);
                    }}
                  >
                    <HugeiconsIcon icon={ChessPawnIcon} className={ITEM_ICON} strokeWidth={1.8} />
                    {group ? "Challenge everybody here" : "Challenge to chess"}
                  </DropdownMenuItem>

                  {challenging && (
                    <>
                      <p className="px-2.5 pb-1 text-[11px] leading-snug text-text-dim">
                        {chessChallengeLabel(conversationName, group)}
                      </p>
                      <div className="flex items-center gap-1 px-2.5 pb-1.5">
                        {(["random", "w", "b"] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            data-testid={`chess-color-${option}`}
                            onClick={() => setColor(option)}
                            aria-pressed={color === option}
                            className={cn(
                              "rounded-md px-2 text-xs transition-colors",
                              // 44px under a thumb, the floor every row of this menu clears
                              // through the shared primitive — these three are drawn by hand,
                              // so they carry it themselves.
                              "min-h-8 [@media(pointer:coarse)]:min-h-11",
                              color === option
                                ? "bg-primary font-medium text-primary-foreground"
                                : "border border-border-subtle text-text-dim hover:bg-accent hover:text-foreground",
                            )}
                          >
                            {option === "random" ? "Random" : option === "w" ? "White" : "Black"}
                          </button>
                        ))}
                      </div>
                      {/* What the press costs, before it is pressed: it is the one fact the user
                          needs and the one thing they cannot take back after. */}
                      <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint">
                        This posts a message under your name, and everybody in this conversation
                        sees it. They need teams-lite to play.
                      </p>
                      <DropdownMenuItem
                        data-testid="chess-challenge"
                        // Held open for the answer, the rule the agent switches follow and the
                        // popover followed before them: an outward action that failed must never
                        // be left looking like it worked, and the report belongs where the press
                        // was made.
                        onSelect={(event) => {
                          event.preventDefault();
                          void challenge();
                        }}
                      >
                        <HugeiconsIcon
                          icon={ChessPawnIcon}
                          className={ITEM_ICON}
                          strokeWidth={1.8}
                        />
                        Send the challenge
                      </DropdownMenuItem>
                      {chessError && (
                        <p
                          data-testid="chess-challenge-error"
                          className="px-2.5 pb-1.5 text-[11px] leading-snug text-destructive"
                        >
                          {chessError}
                        </p>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}

          {canSeal && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-testid="conversation-seal" onSelect={() => setSealOpen(true)}>
                {/* One padlock in all three states, closed. The WORDS say where the chat
                    stands (`sealMenuLabel`), and a second glyph for the same fact would ask
                    the reader to read the mark and the label against each other. */}
                <HugeiconsIcon icon={LockIcon} className={ITEM_ICON} strokeWidth={1.8} />
                {sealMenuLabel(sealStatus, props.conversationId)}
              </DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Local agent</DropdownMenuLabel>

          <DropdownMenuCheckboxItem
            data-testid="agent-mode-toggle"
            checked={agentOn}
            disabled={busy || !runnable}
            onCheckedChange={(next) => void toggleAgentMode(next === true)}
            // Radix closes a menu on select, and the answer takes a round-trip: keeping it open
            // is how the user sees the switch settle, or the reason it did not.
            onSelect={(event) => event.preventDefault()}
          >
            Answer here
            {busy && (
              <HugeiconsIcon
                icon={Loading02Icon}
                className="ml-auto size-3.5 animate-spin"
                strokeWidth={1.8}
              />
            )}
          </DropdownMenuCheckboxItem>

          {/* One line, two meanings — so the colour has to say which one it is. A refused write
              in the faint grey of a hint reads as advice about how the feature works, which is
              exactly how a backend that does not know the method reads as a working switch. */}
          <p
            data-testid="agent-hint"
            data-error={agentError ? "true" : undefined}
            className={cn(
              "px-2.5 py-1.5 text-[11px] leading-snug",
              agentError ? "text-destructive" : "text-text-faint",
            )}
          >
            {agentError ?? agentHint(agent)}
          </p>

          {runnable && agentOn && (
            <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint">
              Only a message YOU write triggers it, and the answer is posted under your name,
              signed by {backends.map((b) => b.name).join(" or ")}.
            </p>
          )}

          {grants.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-normal text-text-faint">
                What it may do
              </DropdownMenuLabel>

              {/* The wider setting first, because it decides whether the groups below apply at
                  all. */}
              <DropdownMenuCheckboxItem
                data-testid="agent-unrestricted-toggle"
                checked={unrestricted}
                disabled={busy || !runnable}
                onCheckedChange={(next) => void toggleUnrestricted(next === true)}
                onSelect={(event) => event.preventDefault()}
                className="items-start"
              >
                <span className="flex flex-col gap-0.5">
                  <span>My own Claude Code config</span>
                  <span className="text-[11px] leading-snug text-text-faint">
                    Every MCP server and tool your settings hold, and your own permission mode —
                    the run your terminal gives you.
                  </span>
                </span>
              </DropdownMenuCheckboxItem>

              {unrestricted && (
                <p
                  data-testid="agent-unrestricted-warning"
                  className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint"
                >
                  Your settings decide, so the groups below do not apply. Everything written in
                  this thread reaches that agent as part of its prompt.
                </p>
              )}

              {!unrestricted &&
                grants.map((grant) => {
                  const granted = agentGrantIsOn(agent, grant);
                  return (
                    <DropdownMenuCheckboxItem
                      key={grant.key}
                      data-testid={`agent-tool-grant-${grant.key}`}
                      data-granted={granted}
                      checked={granted}
                      disabled={busy || !runnable}
                      onCheckedChange={(next) => void toggleGrant(grant, next === true)}
                      onSelect={(event) => event.preventDefault()}
                      className="items-start"
                    >
                      <span className="flex flex-col gap-0.5">
                        <span>{grant.label}</span>
                        <span className="text-[11px] leading-snug text-text-faint">
                          {grant.detail}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  );
                })}

              {!unrestricted && (
                <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint">
                  Reading only — nothing here can write to Grafana, Sentry or Linear.
                </p>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* A SIBLING of the menu, never a child of it: the select that opens this dialog also
          closes the menu, and a dialog mounted inside the menu would be unmounted by the very
          close that makes room for it — the lesson the custom-time picker of § Sending a
          message LATER already paid for. */}
      {canSeal && (
        <SealDialog
          conversationId={props.conversationId}
          open={sealOpen}
          onOpenChange={setSealOpen}
        />
      )}
    </>
  );
}

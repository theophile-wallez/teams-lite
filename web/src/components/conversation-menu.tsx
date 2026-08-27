import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CallIcon,
  CatIcon,
  ChessPawnIcon,
  CpuIcon,
  Download04Icon,
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
import { CHESS_DEFAULT_TIME, CHESS_TIME_CONTROLS, chessTimeControlsMatch } from "~/lib/chess-clock";
import {
  CHESS_ENGINE_DEFAULT_ELO,
  CHESS_ENGINE_STRENGTHS,
  chessEngineRowLabel,
  megabytes,
} from "~/lib/chess-engine";
import {
  clockWords,
  newChessGameId,
  newChessLedger,
  type ChessColor,
  type ChessTimeControl,
} from "~/lib/chess-wire";
import { convLabel, isGroupChat, type ChatMessage } from "~/lib/protocol";
import {
  petPublishFor,
  petSpawnIsOffered,
  petSpawnIsTravelling,
  type PetSpawnReceipt,
} from "~/lib/pet-act";
import { PET_DEFAULT_SKIN, PET_SKINS } from "~/lib/pet-skin";
import { usePrefersReducedMotion } from "~/lib/platform";
import { petSlotKey, type Pet } from "~/lib/pet-thread";
import { sealCanBeUsed, sealMenuLabel } from "~/lib/seal";
import { cn } from "~/lib/utils";
import {
  chessChallengeLabel,
  chessGameRowLabel,
  chessMenuState,
  chessPagePath,
  conversationHoldsChess,
  conversationHoldsEngineChess,
} from "~/lib/chess-menu";
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
 * reason where it cannot act. The rules those two of them came with are kept here, because the
 * components that used to argue them (`call-button.tsx`, `agent-menu.tsx`) drew nothing once
 * this file existed and were removed rather than left as dead files with living comments in
 * them. The chess helpers moved to `lib/chess-menu.ts` — a module of pure decisions, read below — and
 * `meeting-join-button.tsx` survives too, since the calendar and the incoming-call banner
 * still draw the real button.
 *
 * THE CALL, from `call-button.tsx`:
 *
 * - A chat with people in it is CALLED — one person in a 1:1, everybody at once in a group,
 *   which is the same POST and the same call. A thread Teams minted FOR a meeting is JOINED
 *   instead, addressed by that thread, so a meeting the user was invited to is reachable from
 *   the chat list without going to the calendar for its link.
 * - The row is drawn only where it would really work: the calling connection up, and no call
 *   already in flight. Everywhere else it is ABSENT rather than dead — a control that cannot do
 *   the thing it names is worse than no control.
 * - The one exception is a window whose backend does not take calls at all: a read-only one, or
 *   the second install that runs beside the user's app. There the row stays, disabled, with the
 *   reason beside it — the feature exists, this window is not where it happens, and a missing
 *   row would leave them looking for it.
 * - A group call's label says what the click REACHES ("Call everybody in Design crew"), because
 *   that is the fact the user needs before it and the one thing they cannot undo after.
 *
 * THE AGENT, from `agent-menu.tsx`:
 *
 * - The switch is per CONVERSATION, and it is here rather than in Settings because that is what
 *   is being decided: "this machine may post an answer under my name, in THIS thread". A global
 *   list of thread ids would be the same data with the consent taken out of the place the user
 *   can see who reads it.
 * - **It never claims a state it has not been told.** Until `agent_status` answers, the switch
 *   is off and disabled: "off" is what the backend defaults to, and a hopeful switch would be a
 *   lie about where a machine posts.
 * - **It says why, when it cannot.** A backend with no CLI on its PATH, or a read-only one, can
 *   never answer — so it states that instead of offering a switch whose only effect would be a
 *   silent thread. And it waits for the backend before it looks on, because the write can be
 *   refused and the answer that lands in state is the backend's own.
 * - Under it sits the second half of the same consent: what the agent may DO. The wider setting
 *   comes first because it overrides the other — **my own Claude Code config** hands the child
 *   the user's own configuration, every MCP server and tool and their own permission mode, and
 *   the rows say plainly that everything written in the thread then reaches a program that can
 *   write. The **read-only groups** are what applies otherwise, and the backend pins that every
 *   group reads, so no group here can post to Grafana, Sentry or Linear.
 *
 * THE COMPANION, whose spawn is the one press in this whole feature that no creature can carry:
 *
 * - **A pet is per conversation and per person, which is exactly this menu's shape** — so taking one
 *   belongs here beside the game of chess, and not in Settings, where the consent to post in THIS
 *   thread could not be read off the thread. It also reaches the one place the layer never does: a
 *   conversation with no messages at all, where the overlay deliberately mounts nothing.
 * - **It is ONE PRESS and it is never armed.** A spawn posts one message everybody in the thread
 *   sees, and the reader takes it back from the creature's own menu — so asking twice, which is
 *   reserved for what nothing undoes (Remove, a deletion, the merge), would teach them that this
 *   app's confirmations mean nothing. What the press costs is stated above it instead.
 * - **The section is UNFOLDED, unlike the chess challenge**, and the reason is that it removes
 *   itself: it is drawn only while the reader has no creature here, so the one press they came for
 *   is the last thing this section ever asks of them. The challenge's own fold exists because that
 *   row is in every chat for ever; a companion setup form that a spawn deletes for good is not
 *   furniture in the same way, and the feature is unreachable from anywhere else.
 * - **It needs NO gate of its own.** A spawn is `publishPetLedger`, i.e. the `send` that is already
 *   an `OUTWARD_METHODS` entry — the rule a channel post's title and a pasted picture already
 *   follow: a thing riding an existing gated call is part of that call and not a second action.
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
/**
 * One press in a row of presses — the shape this menu picks a colour, a clock and a strength with.
 *
 * It is ONE component because there are four such rows now, and a control the reader learns once
 * must not be four slightly different controls. Each carries the 44px touch floor itself: these are
 * drawn by hand rather than through `DropdownMenuItem`, which is where every row of this menu
 * otherwise gets it.
 */
function PickButton(props: {
  testid: string;
  picked: boolean;
  label: string;
  title?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      onClick={props.onPick}
      aria-pressed={props.picked}
      {...(props.title ? { title: props.title } : {})}
      className={cn(
        "rounded-md px-2 text-xs transition-colors",
        "min-h-8 [@media(pointer:coarse)]:min-h-11",
        props.picked
          ? "bg-primary font-medium text-primary-foreground"
          : "border border-border-subtle text-text-dim hover:bg-accent hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

export function ConversationMenu(props: {
  conversationId: string;
  games: ChessGame[];
  /**
   * Every companion this thread holds, and the history they were folded out of — BOTH from the
   * pane's own memo (`petsInThread`), which is where `games` comes from and for its reason.
   *
   * They arrive as a pair on purpose. `petPublishFor` reads our own ledger back out of the history
   * the pets were derived from and FAILS CLOSED when the two disagree, so a `pets` prop beside a
   * `messages` read from the store inside this component would be two sources that can differ by a
   * frame — and the whole cost of that is a Spawn row drawn, enabled, pressed, and doing nothing at
   * all, silently. Two props from one render of one component cannot disagree.
   */
  pets: Pet[];
  messages: ChatMessage[];
}) {
  const controller = useController();
  const conversation = useAppState((s) =>
    s.conversations.find((c) => c.id === props.conversationId),
  );
  const callStatus = useAppState((s) => s.callStatus);
  const agent = useAppState((s) => s.agent);
  const sealStatus = useAppState((s) => s.sealStatus);

  const [open, setOpen] = useState(false);
  const [sealOpen, setSealOpen] = useState(false);
  const navigate = useNavigate();
  const [challenging, setChallenging] = useState(false);
  const [color, setColor] = useState<"w" | "b" | "random">("random");
  // THE COMPUTER: whether its rows are disclosed, and at what strength the next game is opened. The
  // STRENGTH is kept across an open and close of the menu exactly as the colour and the clock are —
  // it is a preference. The DISCLOSURE is not: it is folded on close like the challenge's own form.
  const [engineOpen, setEngineOpen] = useState(false);
  const [engineElo, setEngineElo] = useState(CHESS_ENGINE_DEFAULT_ELO);
  // THE CLOCK the next challenge carries. Ten minutes out of the box, which is what somebody who
  // says "fancy a game?" in a chat means — and it is kept across an open and close of the menu
  // exactly as the colour is, because it is a preference rather than a step.
  const [time, setTime] = useState<ChessTimeControl | null>(CHESS_DEFAULT_TIME);
  /**
   * THE CLOCK A GAME AGAINST THE COMPUTER CARRIES, and it is NO CLOCK out of the box.
   *
   * A separate state from the human challenge's, and the split is the point rather than a
   * convenience: a clock is an agreement between two people about how long each may think, and there
   * is nobody on the other side of an engine game to hold to one. Worse, it cannot be a fair one —
   * an engine's clock is drawn as STATED rather than counted down (see `engineSide` in
   * lib/chess-clock.ts), because a machine cannot think while the app is closed — so an engine game
   * can be LOST on time and never won on time. Ten minutes inherited from the human default was
   * therefore a countdown against a player whose own clock does not really run.
   *
   * It is still OFFERED, in a row of its own beside the strength: a reader who wants to practise
   * blitz against a machine is asking for exactly the clock this refuses to assume. It is kept
   * across an open and close of the menu like every other pick here — a preference, not a step.
   */
  const [engineTime, setEngineTime] = useState<ChessTimeControl | null>(null);
  // THE ART the next companion is taken in. Kept across an open and close of the menu exactly as the
  // colour, the clock and the strength are, because it is a preference rather than a step.
  const [petSkinName, setPetSkinName] = useState(PET_DEFAULT_SKIN);
  /**
   * WHAT THE LAST SPAWN PRESS LEFT BEHIND — the pet it was about, which is the one id this menu
   * cannot look up, and the CONVERSATION it was made in.
   *
   * A refusal is reported at `petError[petSlotKey(conversation, pet)]` (see `publishPetLedger`), and
   * a FIRST spawn's pet is a freshly minted id — so it is kept from the publish this component
   * computed rather than guessed at from the pets, which by definition do not hold it yet. A
   * RE-spawn keys on the record's own id, which is the same read.
   *
   * The conversation is on it because THIS COMPONENT IS MOUNTED UNKEYED (`message-pane.tsx`, inside
   * `{openId && …}`, and `MessagePane` is unkeyed too): walking to another chat re-renders the same
   * instance with a new `conversationId`, so a bare pet id would say "a spawn is travelling" in every
   * conversation the reader opened afterwards — a Spawn row disabled with no sentence, for the life of
   * the page. It is retired by what it names rather than by a reset (see `petSpawnIsTravelling`).
   */
  const [spawnedPet, setSpawnedPet] = useState<PetSpawnReceipt>(null);
  const [chessError, setChessError] = useState<string | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
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
  // The pure half comes from lib/chess-menu.ts rather than being restated here: which state the
  // control is in, and what a challenge reaches, are decisions with tests of their own, and two
  // spellings of them would drift at the first group chat.
  const engine = useAppState((s) => s.chessEngine);
  /**
   * The press that starts the game, brought INTO VIEW whenever the block that holds it is on screen.
   *
   * The engine's disclosure is FIVE rows tall — a sentence, seven strengths, three sides, nine
   * clocks and the press — and this menu already lists every running game above it, so the one row
   * the reader came for opens below the fold. The rule the merge-request page holds for its own
   * actions: `nearest`, so nothing moves when it is already readable.
   *
   * It fires on the disclosure OPENING, which is why the disclosure itself is folded when the menu
   * closes (see `onOpenChange`) — left standing, a second open of the menu changed neither
   * dependency and nothing scrolled, so the reader was handed a form with its action row off the
   * bottom. That went unseen because a spec opens the row fresh every time.
   */
  const enginePlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (engineOpen && engine.present) enginePlayRef.current?.scrollIntoView({ block: "nearest" });
  }, [engineOpen, engine.present]);

  const holdsChess = conversationHoldsChess(conversation);
  // NOTES offers no game against a colleague — there is nobody in it — but the COMPUTER is somebody,
  // so the chat with oneself is exactly where a solo game belongs.
  const holdsEngineChess = conversationHoldsEngineChess(conversation);
  const chess = chessMenuState(props.games);
  // EVERY live game, most urgent first, and the FIRST of them is what the trigger states — one
  // reading of the same pair of conditions, because three separate ones is where one of them ends
  // up drawn in a conversation that holds no game. A conversation may hold several games at once
  // (§ Chess in a conversation), so the menu names them all and still offers a challenge.
  const liveGames = holdsChess ? chess.games : [];
  const liveGame = liveGames[0] ?? null;
  const chessWantsUs = holdsChess && chess.wantsUs;

  // ---- the companion --------------------------------------------------------
  //
  // Whether the row is drawn at all is `petSpawnIsOffered`'s (lib/pet-act.ts), which is where its
  // four refusals are argued and tested. The two window-level flags are read HERE because they are
  // this window's own — the layer reads exactly the same pair, and a second answer to "would a
  // creature be drawn?" is how a spawn posts a message its own presser never sees.
  //
  // `petsShown` reads its hopeful default until `start()` has read the browser's own preference,
  // which is what makes the LAYER gate on real pet data rather than on the route. It costs this row
  // nothing: it is inside a closed menu until the reader presses the trigger, and a press is many
  // effects later than the first committed render.
  // **AND THE REDUCED-MOTION READ IS THE LAYER'S OWN, LIVE.** It was motion/react's `useReducedMotion`
  // here while `PetLayer` read `usePrefersReducedMotion` (lib/platform.ts), so the two answered
  // differently the moment the query MOVED — the mount-only hook latches its value into a `useState`
  // initialiser it never updates, and this component is mounted unkeyed for the life of the page. Both
  // directions were wrong: turning Reduce Motion ON unmounted the layer and left this row saying "Take
  // a cat", which is a message everybody in the thread receives whose own presser is shown nothing (the
  // fourth refusal in `petSpawnIsOffered` exists for exactly that), and turning it OFF left the row
  // hidden until a reload, which is the stranding `usePrefersReducedMotion` was added to end.
  const petsShown = useAppState((s) => s.petsShown);
  const reduceMotion = usePrefersReducedMotion();
  const spawnOffered = petSpawnIsOffered({
    conversation,
    pets: props.pets,
    shown: petsShown,
    reduce: reduceMotion,
  });
  // A publish already in flight in this conversation. The ENTRY is the signal and never its `act`,
  // which is null for a spawn exactly as it is for a despawn and a skin change: those three have no
  // optimistic draw, so a second press inside a round trip would be a dead control with no sentence
  // and no cue (the rule pet-menu.tsx's own rows hold, in its words).
  const petPending = useAppState((s) => s.petPending[props.conversationId]);
  const petBusy = petPending !== undefined;
  // The refusal, under the pet the press was about — the same slot the creature's own menu reads, so
  // the two cannot disagree about a spawn that did not go out. Read only where the receipt was
  // WRITTEN: keying it on the receipt's own conversation without that check would draw one chat's
  // refusal in another.
  const spawnError = useAppState((s) =>
    spawnedPet && spawnedPet.conversation === props.conversationId
      ? s.petError[petSlotKey(spawnedPet.conversation, spawnedPet.pet)]
      : undefined,
  );
  /**
   * A SPAWN THAT LEFT AND WHOSE LEDGER HAS NOT COME BACK YET — the second window this row is out for,
   * decided by `petSpawnIsTravelling`, where the whole argument for it lives and is tested.
   *
   * Three things about it are this component's own, and each was a defect once:
   *
   *   - it is scoped to the CONVERSATION the press was made in, because this component is mounted
   *     unkeyed and would otherwise carry the receipt into every other chat;
   *   - it is retired by a ledger of ours ARRIVING, `gone` or not, because the press on a `gone`
   *     record is an EDIT — the arm that emits before it answers, and the one that never needed a
   *     window;
   *   - it needs NO reset anywhere, which is why nothing resets it — and a reset is not merely
   *     redundant, it is a BUG: one fired on a conversation change, which re-opened the window on the
   *     RETURN path (press in A, walk to B where the row is correctly live, come back to A before the
   *     echo, and the row is live again with the send still travelling). `setSpawnedPet` therefore
   *     appears exactly once in this file, and a test counts it.
   *
   * Three things it does NOT cover, all the same root — the receipt is ONE page-local slot — and each
   * recorded rather than fixed, because each is smaller than the window this closes: a spawn in
   * ANOTHER conversation OVERWRITES this one's receipt, so A's row is live again on return (only a
   * `Record<string, string>` closes that); a receipt whose conversation the reader LEAVES dies with
   * the menu, since the chat list makes `openId` falsy and unmounts it, which is fine as it stands;
   * and the write is where it is because the window starts at the PRESS — moving it after the await
   * is near-equivalent today only because the release and the write land in one React batch.
   *
   * `petPublishFor` cannot help, and it is worth saying why: it is pure over `pets`/`messages`, and
   * inside this window those are byte-identical to "I have no companion here" — there is nothing for
   * it to fail closed on. Making `publishPetLedger` hold the pending slot across the echo is the
   * root-cause fix and was deliberately NOT taken: the slot would need a release path that is not the
   * promise, which is more machinery for the same result. TWO OPEN PAGES still share neither slot, so
   * a second window's row stays live for the whole window whatever this gate does — inherent to a
   * page-local pending, and chess has the same property.
   */
  const spawnTravelling = petSpawnIsTravelling({
    receipt: spawnedPet,
    conversation: props.conversationId,
    pets: props.pets,
    refused: spawnError !== undefined,
  });
  // A companion that has gone home comes BACK rather than being minted again — `petPublishFor`'s
  // spawn branch re-uses the record's own id and its whole history — so the row says which of the
  // two the press is, because "the same creature" is the whole difference to a reader.
  const petComesBack = props.pets.some((pet) => pet.owner.isSelf && pet.gone);
  const petSkinLabel = (PET_SKINS.find((skin) => skin.name === petSkinName) ?? PET_SKINS[0]!).label;

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

  /** Open a game against the ENGINE, at the strength the reader picked. */
  const playEngine = async () => {
    const mine: ChessColor = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color;
    setChessError(null);
    const sent = await controller.publishChessLedger(props.conversationId, {
      game: newChessGameId(),
      messageId: null,
      ledger: {
        ...newChessLedger(mine),
        opened: true,
        // The engine's OWN clock pick, which is no clock unless the reader asked for one: a time
        // control is an agreement between two people, and a machine's clock cannot really run.
        time: engineTime,
        // The token that says the opponent is a machine — and the whole reason one ledger may carry
        // both sides' moves (see lib/chess-wire.ts).
        engineElo,
      },
    });
    if (sent) setOpen(false);
    else setChessError("The game did not go out — nothing was posted. Try again.");
  };

  /** Fetch the engine onto this machine. The reader's own press, and the only thing that ever
   *  downloads it. */
  const fetchEngine = async () => {
    setEngineBusy(true);
    setChessError(null);
    const ok = await controller.downloadChessEngine();
    setEngineBusy(false);
    if (!ok) setChessError("The engine did not download. Check the machine's network and try again.");
  };

  /**
   * Take a companion — or bring one back — in the art the picker offered.
   *
   * The publish is computed HERE rather than inside the store because its `pet` is the answer to
   * "which slot does a refusal land in", and for a first spawn that is an id nothing else has ever
   * seen. `petPublishFor` decides everything else, including the re-spawn: this component neither
   * mints an id nor reads one off a ledger.
   *
   * A null publish does NOTHING and says nothing: it is the guard behind a press that was legal when
   * the menu opened (the reader took a creature in another window meanwhile), never this surface's
   * own decision about what to draw.
   */
  const spawnPet = async () => {
    const publish = petPublishFor({
      press: { kind: "spawn", skin: petSkinName },
      pets: props.pets,
      messages: props.messages,
      now: Date.now(),
    });
    if (!publish) return;
    // THE RECEIPT THIS ONE REPLACES TAKES ITS SENTENCE WITH IT. A refused first spawn leaves a
    // `petError` slot under a pet id nothing else has ever seen (see `PetSpawnReceipt`), and the retry
    // mints a FRESH one — so without this the old slot is a string no surface can draw again, one more
    // on every attempt. It is dropped here and only here, because this is the one moment both ids exist
    // at once: `publishPetLedger` knows the new key and can never know the old.
    if (spawnedPet && spawnedPet.pet !== publish.pet) {
      controller.forgetPetError(spawnedPet.conversation, spawnedPet.pet);
    }
    setSpawnedPet({ conversation: props.conversationId, pet: publish.pet });
    // CLOSED ON SUCCESS, held open on a refusal — the rule the challenge and the engine's own press
    // follow. It is NOT what keeps a second press out of the window between the send answering and
    // the ledger arriving: a close only raises the effort, since reopening the menu draws the row
    // again. `spawnTravelling` is what holds it shut, and it is why this component keeps
    // `spawnedPet` across a close.
    if (await controller.publishPetLedger(props.conversationId, publish)) setOpen(false);
  };

  const challenge = async () => {
    // Random is resolved HERE, into the colour the challenge really carries: the wire never
    // says "random", because a colour nothing decided is a game whose two clients could
    // disagree about who moves first.
    const mine: ChessColor = color === "random" ? (Math.random() < 0.5 ? "w" : "b") : color;
    setChessError(null);
    const sent = await controller.publishChessLedger(props.conversationId, {
      game: newChessGameId(),
      // The challenge is the first message of the game, so it SENDS; every move after it edits
      // this same message (see lib/chess-wire.ts on the ledger).
      messageId: null,
      ledger: {
        ...newChessLedger(mine),
        opened: true,
        // The clock the game is played with, stated by whoever proposed it. Ten minutes unless
        // the reader picked otherwise, which is what somebody who says "fancy a game?" means.
        time,
      },
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
          // the reader has moved on from. The COLOUR, the CLOCKS and the STRENGTH are deliberately
          // kept — they are preferences, not steps.
          //
          // The COMPUTER's disclosure is folded for the same reason the challenge's is, and it used
          // to be kept: it is a form five rows tall, not a preference, and left standing it also
          // stopped its own action row from being scrolled into view on the next open (see
          // `enginePlayRef`).
          if (!next) {
            setChallenging(false);
            setEngineOpen(false);
            setChessError(null);
            // AND `spawnedPet` IS DELIBERATELY *NOT* DROPPED HERE, which is the one place this menu
            // breaks its own "a closed menu forgets" rule. The close is the very event the spawn
            // window OPENS on — see `spawnTravelling` — so clearing it on close erased the only
            // memory of a spawn that had just gone out, and the row came back live. What it costs is
            // that a refusal's sentence survives a close; that is the pet MENU's own behaviour for
            // the same slot (`petError` is store state and nothing there resets it either), and the
            // row it sits under is the row that RETRIES it — the next press clears the slot before
            // it asks. The SKIN is kept as well, exactly as the colour and the clock are.
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
          data-chess-games={liveGames.length > 0 ? liveGames.length : undefined}
          data-your-turn={liveGames.some((entry) => entry.ourTurn) ? "true" : undefined}
          data-awaiting-answer={liveGames.some((entry) => entry.awaitingUs) ? "true" : undefined}
          aria-label={
            chessWantsUs
              ? liveGames.some((entry) => entry.awaitingUs)
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
          {chessWantsUs && (
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

              {/* A ROW PER LIVE GAME, most urgent first. It used to be one row for one game,
                  because one game in flight per conversation was the rule; a group chat holds a
                  game per pair of people, so the row became a short list. Each one goes to that
                  game's own PAGE rather than scrolling the history to its board: the page is
                  where a game is played, and a row that scrolled a conversation to a row was
                  what the page replaced. */}
              {liveGames.map((entry) => (
                <DropdownMenuItem
                  key={entry.game.id}
                  // ITS OWN id, and `chess-button` stays the CHALLENGE row's. The header's single
                  // control carried `chess-button` while a conversation held one game and offered
                  // either a board or a challenge; both are drawn at once now, so one id cannot
                  // mean both — it would resolve to two elements and every existing assertion
                  // would fail on the ambiguity rather than on the behaviour.
                  data-testid="chess-game-row"
                  data-chess-game={entry.game.id}
                  data-your-turn={entry.ourTurn ? "true" : undefined}
                  aria-label={
                    entry.awaitingUs
                      ? `${entry.game.challenger.name} challenged you to chess — go to the board`
                      : entry.ourTurn
                        ? "Your move — go to the chess board"
                        : "Go to the chess board"
                  }
                  onSelect={() => {
                    setOpen(false);
                    void navigate({ to: chessPagePath(props.conversationId, entry.game.id) });
                  }}
                >
                  <HugeiconsIcon icon={ChessPawnIcon} className={ITEM_ICON} strokeWidth={1.8} />
                  <span className="flex-1 truncate">{chessGameRowLabel(entry)}</span>
                  {entry.game.time && (
                    <span className="shrink-0 text-[11px] text-text-faint">
                      {clockWords(entry.game.time)}
                    </span>
                  )}
                  {entry.wantsUs && (
                    <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
                  )}
                </DropdownMenuItem>
              ))}
              {
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
                    {liveGames.length > 0
                      ? "Start another game"
                      : group
                        ? "Challenge everybody here"
                        : "Challenge to chess"}
                  </DropdownMenuItem>

                  {challenging && (
                    <>
                      <p className="px-2.5 pb-1 text-[11px] leading-snug text-text-dim">
                        {chessChallengeLabel(conversationName, group)}
                      </p>
                      <div className="flex items-center gap-1 px-2.5 pb-1.5">
                        {(["random", "w", "b"] as const).map((option) => (
                          <PickButton
                            key={option}
                            testid={`chess-color-${option}`}
                            picked={color === option}
                            onPick={() => setColor(option)}
                            label={
                              option === "random" ? "Random" : option === "w" ? "White" : "Black"
                            }
                          />
                        ))}
                      </div>
                      {/* THE CLOCK, in the same shape as the colour: a row of presses rather than
                          a select, because there are nine of them and every one is one press.
                          Ten minutes is what it opens on. "No clock" is kept because every game
                          played before this feature had none, and a game with no clock is a real
                          thing two people may want. */}
                      <div className="flex flex-wrap items-center gap-1 px-2.5 pb-1.5">
                        {CHESS_TIME_CONTROLS.map((option) => (
                          <PickButton
                            key={option.label}
                            testid={`chess-time-${option.time ? `${option.time.base}-${option.time.increment}` : "none"}`}
                            picked={chessTimeControlsMatch(option.time, time)}
                            onPick={() => setTime(option.time)}
                            label={option.label}
                          />
                        ))}
                      </div>
                      {/* What the press costs, before it is pressed: it is the one fact the user
                          needs and the one thing they cannot take back after. */}
                      <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint">
                        This posts a message under your name, and everybody in this conversation
                        sees it. They need teams-lite to play. {clockWords(time)}.
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
              }
            </>
          )}

          {/* THE COMPUTER. It is its own row rather than a colour in the challenge above, because it
              answers a different question: a challenge waits for a colleague, and this one starts a
              game that is playable the moment it is posted. It is also the one game NOTES can hold —
              there is nobody in that chat, and the computer is somebody. */}
          {holdsEngineChess && (
            <>
              {!holdsChess && <DropdownMenuSeparator />}
              {!holdsChess && <DropdownMenuLabel>Chess</DropdownMenuLabel>}
              <DropdownMenuItem
                data-testid="chess-engine-row"
                data-engine-present={engine.present ? "true" : undefined}
                aria-expanded={engineOpen}
                onSelect={(event) => {
                  event.preventDefault();
                  setChessError(null);
                  setEngineOpen((was) => !was);
                }}
              >
                <HugeiconsIcon icon={CpuIcon} className={ITEM_ICON} strokeWidth={1.8} />
                <span className="flex-1 truncate">
                  {engine.present ? "Play the computer" : chessEngineRowLabel(engine)}
                </span>
              </DropdownMenuItem>

              {engineOpen && (
                <>
                  {/* THE ENGINE IS NOT IN THIS APP. The row says what fetching it costs before the
                      press, which is the one fact the reader decides with — and it is fetched once
                      per machine, by the backend, verified against a digest this build pins. */}
                  {!engine.present ? (
                    <>
                      <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-dim">
                        {engine.downloading
                          ? chessEngineRowLabel(engine)
                          : `${engine.label} is ${megabytes(engine.bytes)} and is not on this machine yet. It is fetched once, verified, and runs in this browser — nothing about your games leaves it.`}
                      </p>
                      <DropdownMenuItem
                        data-testid="chess-engine-download"
                        disabled={engineBusy || engine.downloading}
                        onSelect={(event) => {
                          event.preventDefault();
                          void fetchEngine();
                        }}
                      >
                        <HugeiconsIcon
                          icon={Download04Icon}
                          className={ITEM_ICON}
                          strokeWidth={1.8}
                        />
                        {engine.downloading ? chessEngineRowLabel(engine) : "Fetch the engine"}
                      </DropdownMenuItem>
                      {engine.error && (
                        <p
                          data-testid="chess-engine-error"
                          className="px-2.5 pb-1.5 text-[11px] leading-snug text-destructive"
                        >
                          {engine.error}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {/* THE STRENGTH, in the engine's own scale. The floor is the engine's
                          (1320) and the top is its full strength — both are measured off the
                          binary, so the picker offers nothing it cannot really play. */}
                      <p className="px-2.5 pb-1 text-[11px] leading-snug text-text-dim">
                        How strong should it play?
                      </p>
                      <div className="flex flex-wrap items-center gap-1 px-2.5 pb-1.5">
                        {CHESS_ENGINE_STRENGTHS.map((rung) => (
                          <PickButton
                            key={rung.elo}
                            testid={`chess-elo-${rung.elo}`}
                            picked={engineElo === rung.elo}
                            onPick={() => setEngineElo(rung.elo)}
                            label={String(rung.elo)}
                            title={rung.note ? `${rung.elo} — ${rung.note}` : `${rung.elo}`}
                          />
                        ))}
                      </div>
                      {/* WHICH SIDE, which the reader could not choose at all until this row: the
                          human challenge's own colour sits behind a different disclosure, and NOTES
                          draws no challenge — so half of every engine game opened there was a
                          random colour nobody picked. One state behind both rows, so the two can
                          never disagree. */}
                      <p className="px-2.5 pb-1 text-[11px] leading-snug text-text-dim">
                        Which side do you play?
                      </p>
                      <div className="flex items-center gap-1 px-2.5 pb-1.5">
                        {(["random", "w", "b"] as const).map((option) => (
                          <PickButton
                            key={option}
                            testid={`chess-engine-color-${option}`}
                            picked={color === option}
                            onPick={() => setColor(option)}
                            label={
                              option === "random" ? "Random" : option === "w" ? "White" : "Black"
                            }
                          />
                        ))}
                      </div>
                      {/* THE CLOCK, and it is the engine's OWN pick rather than the human
                          challenge's — no clock unless the reader asks for one. A time control is
                          an agreement between two people about how long each may think, and an
                          engine's clock is drawn as stated rather than counted down, so an engine
                          game can be lost on time and never won on it. */}
                      <p className="px-2.5 pb-1 text-[11px] leading-snug text-text-dim">
                        On a clock?
                      </p>
                      <div className="flex flex-wrap items-center gap-1 px-2.5 pb-1.5">
                        {CHESS_TIME_CONTROLS.map((option) => (
                          <PickButton
                            key={option.label}
                            testid={`chess-engine-time-${option.time ? `${option.time.base}-${option.time.increment}` : "none"}`}
                            picked={chessTimeControlsMatch(option.time, engineTime)}
                            onPick={() => setEngineTime(option.time)}
                            label={option.label}
                          />
                        ))}
                      </div>
                      {/* The clock LAST, as the fragment the human challenge's own sentence ends
                          with: `clockWords` is lowercase, so "no clock" opening a sentence read as
                          a line somebody had not finished writing. */}
                      <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint">
                        The game is posted here under your name, so it replays on every device — and
                        everybody in this conversation can see it. {clockWords(engineTime)}.
                      </p>
                      <DropdownMenuItem
                        ref={enginePlayRef}
                        data-testid="chess-engine-play"
                        onSelect={(event) => {
                          event.preventDefault();
                          void playEngine();
                        }}
                      >
                        <HugeiconsIcon icon={CpuIcon} className={ITEM_ICON} strokeWidth={1.8} />
                        Play Stockfish {engineElo}
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </>
          )}

          {/* THE COMPANION. It is the only way into the feature — every other control it has is on a
              creature that already exists — so it is drawn unfolded, and only while the reader has
              none of their own here (see `petSpawnIsOffered` for all four refusals). One press
              publishes; nothing is armed. */}
          {spawnOffered && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Companion</DropdownMenuLabel>
              {/* THE ART, in the same shape as the colour, the clock and the strength — three
                  presses through the one `PickButton` this menu picks everything with, because four
                  rows of presses must not be four slightly different controls. */}
              <div className="flex flex-wrap items-center gap-1 px-2.5 pb-1.5">
                {PET_SKINS.map((skin) => (
                  <PickButton
                    key={skin.name}
                    // `pet-spawn-skin-…` and not `pet-skin-…`, which is the creature's OWN menu's
                    // row for changing the art it wears (pet-menu.tsx). The two are mutually
                    // exclusive by state — one is drawn only while the reader has a pet here and the
                    // other only while they have none — so one spelling would resolve to whichever
                    // menu happened to be open, which is a test that passes for the wrong reason.
                    testid={`pet-spawn-skin-${skin.name}`}
                    picked={petSkinName === skin.name}
                    onPick={() => setPetSkinName(skin.name)}
                    label={skin.label}
                  />
                ))}
              </div>
              {/* What the press costs, before it is pressed. A spawn reaches everybody in the thread
                  and it is the reader's own creature from then on, which are the two facts they
                  decide with. */}
              <p className="px-2.5 pb-1.5 text-[11px] leading-snug text-text-faint">
                {petComesBack
                  ? "Your companion comes back with everything it has done — the same creature, in the art you pick. This posts under your name, and everybody in this conversation sees it."
                  : "This posts one message under your name, and everybody in this conversation sees it. Your companion lives in that message, walks over this conversation and ages. Only teams-lite draws it."}
              </p>
              <DropdownMenuItem
                data-testid="pet-spawn"
                // One press, and never armed: it is taken back from the creature's own menu, and
                // asking twice belongs to what nothing undoes. It is OUT for two windows rather than
                // one — a publish in flight anywhere in this conversation, and a spawn of ours whose
                // ledger has not reached this page yet (see `spawnTravelling`, which is the longer of
                // the two and the one a second press turns into a duplicate arrival message).
                disabled={petBusy || spawnTravelling}
                onSelect={(event) => {
                  event.preventDefault();
                  void spawnPet();
                }}
              >
                <HugeiconsIcon icon={CatIcon} className={ITEM_ICON} strokeWidth={1.8} />
                {petComesBack
                  ? `Bring your ${petSkinLabel.toLowerCase()} back`
                  : `Take a ${petSkinLabel.toLowerCase()}`}
              </DropdownMenuItem>
              {spawnError && (
                // The sentence the reader acts on, at the press that failed — the composer's own
                // rule. The status line keeps the raw failure for whoever reads a screenshot.
                <p
                  data-testid="pet-spawn-error"
                  className="px-2.5 pb-1.5 text-[11px] leading-snug text-destructive"
                >
                  {spawnError}
                </p>
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

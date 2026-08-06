import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  callStageChatConversation,
  callStageIsUp,
  type CallStageMode,
  type CallStagePanel,
  type StagePoint,
} from "~/lib/call-stage";
import { useAppState } from "./controller-context";

/**
 * Which shape the call is in, and which panel it has open.
 *
 * It is a context rather than store state on purpose: it describes a WINDOW, not the
 * call. Two open pages are in the same call and may perfectly well have it folded in one
 * and full in the other — the backend's `call_state` is what they must agree about, and
 * this is what each of them chose to do with it. It dies with the page, and it is reset
 * for every new call: a stage left folded by the last call would hide the next one.
 */
type CallStageValue = {
  mode: CallStageMode;
  panel: CallStagePanel | null;
  /** Where the user dragged the mini window, or null while they never have — which is
   *  what lets the home corner follow a resize until they choose a place themselves. */
  position: StagePoint | null;
  setMode: (mode: CallStageMode) => void;
  /** Open a panel, or close the open one by naming it again — the way a toggle in a row of
   *  toggles behaves everywhere else in this app. */
  togglePanel: (panel: CallStagePanel) => void;
  setPosition: (point: StagePoint) => void;
};

const CallStageContext = createContext<CallStageValue | null>(null);

export function CallStageProvider(props: { children: ReactNode }) {
  const call = useAppState((s) => s.callStatus.call);
  // The call this state belongs to. A new call is a new window: full, no panel, and back
  // in its home corner.
  const callId = callStageIsUp(call) ? call.id : null;
  const [mode, setMode] = useState<CallStageMode>("full");
  const [panel, setPanel] = useState<CallStagePanel | null>(null);
  const [position, setPosition] = useState<StagePoint | null>(null);

  // A new call opens as a page, with no panel, in the home corner. The END of a call is
  // deliberately NOT a reset: the surface is still on screen for the length of its own fade,
  // and unfolding it there would draw a full-screen page nobody asked for as the call goes.
  useEffect(() => {
    if (!callId) return;
    setMode("full");
    setPanel(null);
    setPosition(null);
  }, [callId]);

  const togglePanel = useCallback((next: CallStagePanel) => {
    setPanel((current) => (current === next ? null : next));
  }, []);

  const value = useMemo<CallStageValue>(
    () => ({ mode, panel, position, setMode, togglePanel, setPosition }),
    [mode, panel, position, togglePanel],
  );

  return <CallStageContext.Provider value={value}>{props.children}</CallStageContext.Provider>;
}

export function useCallStage(): CallStageValue {
  const value = useContext(CallStageContext);
  if (!value) throw new Error("useCallStage: no CallStageProvider above this component");
  return value;
}

/**
 * Whether the CALL holds the app's one composer right now.
 *
 * There is exactly one composer in this app, and there has to be: it carries the live
 * sentinel `sandbox-live.ts` proves its target with (`data-conversation-id`), and two of
 * them would leave that driver — and every spec that reaches for the box — with a
 * question that has two answers. So the stage's chat panel does not add a second one; it
 * TAKES the one there is, and the message pane behind it renders none while it does.
 *
 * Nothing is hidden by that: the panel only holds the composer while the stage is full,
 * and a full stage covers the pane completely. Folding the call, closing the panel or
 * walking to another conversation each hand it straight back.
 */
export function useCallOwnsComposer(): boolean {
  const { mode, panel } = useCallStage();
  const call = useAppState((s) => s.callStatus.call);
  const openId = useAppState((s) => s.openId);
  if (mode !== "full" || panel !== "chat") return false;
  if (!callStageIsUp(call)) return false;
  return !!openId && callStageChatConversation(call, (id) => id === openId) === openId;
}

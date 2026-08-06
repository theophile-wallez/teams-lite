/**
 * The call as a PAGE, and the small window it folds into.
 *
 * A call used to be a card in the corner of the app. It is now the surface the app
 * gives its whole screen to while it runs, because that is what the thing on screen is
 * about — and it folds into a draggable window when the user has something else to do
 * in this app, which is the other half of the same fact: a call is long, and an app
 * that hid the conversation for its whole length would be worse than the card was.
 *
 * Everything here is pure: geometry, labels and the roster rows. The state comes from
 * the backend's own `call_status`, the actions live on the controller, and nothing in
 * this file reaches the network or touches the DOM. {@link ../components/call-stage}
 * draws it.
 */

import { callDurationLabel, callPhaseLabel, isLive, isMeeting, type ActiveCall } from "./call";
import type { LocalVideo, RemoteVideo } from "./call-media";

/** Which of the two shapes the stage is in.
 *
 *  Two, and not three: there is no "closed" — a live call is always on screen in one of
 *  them, because a call this app holds and shows nowhere is a microphone the user cannot
 *  find the off switch for. */
export type CallStageMode = "full" | "mini";

/** The side panel the full stage has open, or `null` for none.
 *
 *  One at a time: they answer two different questions about the same call ("who is
 *  here" / "what is being said"), and a column narrow enough to hold both would hold
 *  neither well. */
export type CallStagePanel = "people" | "chat";

/**
 * The panel a NEW call opens with: its CHAT, wherever there is one.
 *
 * A call in a conversation is half a conversation — what is being said in the thread while
 * people are talking is the other half — so the sidebar starts open rather than waiting for
 * a click nobody would think to make. There is no second condition: the panel is open by
 * default in every call that has a thread behind it, on every screen.
 *
 * The one call it opens closed is the one with nothing to show: a meeting joined from a
 * calendar LINK names no thread at all (`callStageChatConversation`).
 */
export function initialCallStagePanel(
  call: ActiveCall,
  hasConversation: (id: string) => boolean,
): CallStagePanel | null {
  return callStageChatConversation(call, hasConversation) ? "chat" : null;
}

/** How wide the viewport has to be for the side panel to sit BESIDE the picture rather than
 *  over it. Below it, 21rem of text beside a video leaves neither readable. */
export const PANEL_BESIDE_PX = 640;

/**
 * Whether this call is one the STAGE draws.
 *
 * A ringing call is not. It is an offer, not a call: nothing is connected, no microphone
 * is open, and the whole of it is one question with two answers — which a card beside the
 * conversation asks better than a page that took the screen for something the user may
 * decline. Everything after that answer is the stage's, dialling included, because the
 * microphone opens there.
 */
export function callStageIsUp(call: ActiveCall | null): call is ActiveCall {
  return !!call && isLive(call) && call.phase !== "ringing";
}

/** A point, in viewport pixels, of the mini window's top-left corner. */
export type StagePoint = { x: number; y: number };

/** A viewport, in CSS pixels. */
export type StageViewport = { width: number; height: number };

/** The widest the mini window gets. It is the size of a picture that can still be READ,
 *  because the thing it usually carries is somebody's shared screen and a thumbnail of a
 *  screen full of text says only that a screen is being shared. */
export const MINI_WIDTH = 320;

/** And the narrowest. Below this the picture says nothing and the three controls in the bar
 *  stop being targets. */
export const MINI_MIN_WIDTH = 208;

/** The height of the bar under the picture: one row of controls beside the name. */
export const MINI_BAR_HEIGHT = 44;

/** How close to the edge of the viewport the mini window may be dropped. It is never
 *  flush: a window touching an edge reads as stuck to it, and on a phone the bottom
 *  inset is where the home indicator lives. */
export const MINI_MARGIN = 16;

/** A size, in CSS pixels. */
export type StageSize = { width: number; height: number };

/**
 * How big the folded window is, which depends on the screen it is folded away ON.
 *
 * A phone's whole viewport is some 390px wide: a 320px window there is not a call folded
 * away, it is the app with a hole punched in it — and folding exists precisely so the user
 * can read the conversation underneath. So the window takes a share of a narrow viewport
 * and its own full width on anything roomy, and the height is 16:9 plus the control bar
 * either way, because a picture that is not 16:9 is a picture with black edges.
 */
export function miniSize(viewport: StageViewport): StageSize {
  const share = Math.max(MINI_MIN_WIDTH, Math.min(MINI_WIDTH, viewport.width * MINI_SHARE));
  // The room between the margins caps it LAST, so the floor above can never produce a window
  // wider than the screen it has to sit on — the clamp can only place one that fits.
  const room = Math.max(MINI_MARGIN, viewport.width - 2 * MINI_MARGIN);
  const width = Math.round(Math.min(share, room));
  return { width, height: Math.round((width * 9) / 16) + MINI_BAR_HEIGHT };
}

/** How much of a narrow viewport's width the folded window may take. Just over half: enough
 *  for the picture to read, and little enough that the conversation behind it still does. */
const MINI_SHARE = 0.55;

/** Where the mini window sits before the user has ever dragged it: the bottom-right
 *  corner, which is where this app's own call card always was and where a picture in
 *  picture is expected. */
export function miniHomePosition(viewport: StageViewport): StagePoint {
  const { width, height } = miniSize(viewport);
  return clampMiniPosition(
    { x: viewport.width - width - MINI_MARGIN, y: viewport.height - height - MINI_MARGIN },
    viewport,
  );
}

/**
 * The nearest position that keeps the whole mini window on screen.
 *
 * It runs on every drop AND on every viewport change, because the second is how a
 * window gets lost: a phone rotated, a desktop window narrowed, or the keyboard opening
 * would otherwise leave the call — and its hang-up button — somewhere nobody can reach.
 * A viewport smaller than the window itself pins it to the top-left rather than
 * returning a negative corner, so the controls stay reachable even then.
 *
 * The size is DERIVED from the viewport rather than passed in, so a caller can never
 * clamp one size against a window drawn at another.
 */
export function clampMiniPosition(point: StagePoint, viewport: StageViewport): StagePoint {
  const { width, height } = miniSize(viewport);
  const maxX = viewport.width - width - MINI_MARGIN;
  const maxY = viewport.height - height - MINI_MARGIN;
  return {
    x: Math.round(Math.min(Math.max(point.x, MINI_MARGIN), Math.max(MINI_MARGIN, maxX))),
    y: Math.round(Math.min(Math.max(point.y, MINI_MARGIN), Math.max(MINI_MARGIN, maxY))),
  };
}

/** What the stage's header calls this call.
 *
 *  The backend's own words in every case: a meeting's subject, a group chat's title, or
 *  the person on the other end. Only the two empty cases are ours to name, and each says
 *  what the thing IS rather than guessing at who is in it. */
export function callStageTitle(call: ActiveCall): string {
  if (call.peer.trim()) return call.peer.trim();
  return isMeeting(call) ? "Meeting" : "Unknown caller";
}

/** The line under the title: what the call is doing, or who is in it once it is up.
 *
 *  It is deliberately the same sentence the card used to show ({@link callPhaseLabel}),
 *  so the state of a call reads identically wherever it is drawn — the stage, the mini
 *  window and the ringing card are one call in three shapes, not three surfaces with
 *  three vocabularies. */
export function callStageSubtitle(call: ActiveCall): string {
  return callPhaseLabel(call);
}

/** The wall-clock time this call's audio started, as "14:32" — the answer to "how long
 *  has this been going on" that a duration alone does not give somebody who joined late.
 *
 *  Empty before audio starts, because a call that is still connecting started nothing
 *  yet. The locale is the reader's own, so a 12-hour machine says "2:32 PM". */
export function callStartClockLabel(
  call: ActiveCall,
  locale?: string,
  timeZone?: string,
): string {
  if (!call.connected_at_ms) return "";
  return new Date(call.connected_at_ms).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}

/** The time block's own title, in one sentence: how long, and since when. */
export function callStageTimeTitle(call: ActiveCall, nowMs: number, locale?: string): string {
  const started = callStartClockLabel(call, locale);
  const duration = callDurationLabel(call, nowMs);
  if (!started) return callStageSubtitle(call);
  return duration ? `${duration} in this call, since ${started}` : `Started at ${started}`;
}

/** One row of the People panel. */
export type StageParticipant = {
  /** A stable key for the row: the MRI when there is one, and the name otherwise — the
   *  roster names people the directory could not resolve. */
  key: string;
  name: string;
  /** Empty for somebody the roster named without an MRI, and for the user's own row:
   *  {@link StageParticipant.you} says who that is. */
  mri: string;
  /** The user's own row, which is always the first one. */
  you: boolean;
  /** Whether this person is publishing a camera, and whether they are sharing a screen —
   *  read from the roster's own `mediaStreams` (see `PublishedStream`), never guessed
   *  from the sections this page happens to have subscribed to. */
  camera: boolean;
  sharing: boolean;
};

/**
 * Everybody in the call, the user first.
 *
 * The user's own row is first and always there, because a meeting they are alone in
 * still has one person in it and a list that said "nobody" would be wrong about the one
 * person reading it. Everybody else comes from the backend's roster in the order it
 * states them, with the empty names dropped — a roster frame carries an entry before the
 * directory has named it, and a blank row is a row nobody can read.
 */
export function callStageParticipants(
  call: ActiveCall,
  self: { name?: string; camera: boolean; sharing: boolean },
): StageParticipant[] {
  const rows: StageParticipant[] = [
    {
      key: "self",
      name: self.name?.trim() ? `${self.name.trim()} (You)` : "You",
      mri: "",
      you: true,
      camera: self.camera,
      sharing: self.sharing,
    },
  ];
  call.others.forEach((raw, index) => {
    const name = raw.trim();
    if (!name) return;
    const mri = call.other_mris[index]?.trim() ?? "";
    const published = call.publishing.find((person) => person.mri === mri);
    rows.push({
      key: mri || `name:${name}`,
      name,
      mri,
      you: false,
      camera: !!published?.streams.some((stream) => stream.camera),
      sharing: !!published?.streams.some((stream) => stream.shared_screen),
    });
  });
  return rows;
}

/** The one sentence about the people who cannot hear the user yet, or "" when nobody is
 *  waiting. A meeting states this; a call has no lobby at all. */
export function callStageLobbyLabel(call: ActiveCall): string {
  if (call.waiting_in_lobby <= 0) return "";
  return call.waiting_in_lobby === 1
    ? "1 person is waiting in the lobby"
    : `${call.waiting_in_lobby} people are waiting in the lobby`;
}

/**
 * The conversation whose chat the stage may show, or null when there is none.
 *
 * Two things have to be true, and the second is why this is a function rather than a
 * field. The call has to NAME a thread — a meeting joined from a calendar link names
 * none, the service resolves it from the code and never tells us — and this app has to
 * HOLD that conversation, because the chat panel is the app's own thread rendered in a
 * column, not a second history loader. Either one missing means no Chat tab at all,
 * which is this app's own rule: the disclosure exists exactly when there is something
 * behind it.
 */
export function callStageChatConversation(
  call: ActiveCall,
  hasConversation: (id: string) => boolean,
): string | null {
  const id = call.conversation_id?.trim();
  if (!id) return null;
  return hasConversation(id) ? id : null;
}

/** One tile in the row of faces: somebody else's camera, or the user's own. */
export type StageTile =
  | { kind: "remote"; key: string; video: RemoteVideo }
  | { kind: "local"; key: string; video: LocalVideo };

/** How the stage's content is laid out, decided once and read by both shapes. */
export type StageLayout = {
  /** The picture the content gives its whole self to: a screen somebody shared. Null when
   *  nobody is sharing one. */
  shared: RemoteVideo | null;
  /** Further shared screens, which become tiles. Two people sharing at once is rare and
   *  the stage can only have one subject, so the first one keeps it. */
  tiles: StageTile[];
  /** The user's own screen capture, which is always a corner preview. */
  ownScreen: LocalVideo | null;
  /** True when nothing at all is being sent as a picture, which is what makes the stage
   *  draw the avatar card instead. */
  empty: boolean;
};

/**
 * What the stage draws, from the streams that have arrived.
 *
 * Four rules, and each one is a decision rather than an ordering detail:
 *
 * - **A shared SCREEN takes the whole content.** Somebody shares a screen because they
 *   want it read, and a screen is text: it is the only thing in a call that a tile is too
 *   small for. Faces read at any size, so they give way to it.
 * - **The user's own camera is a TILE among the faces.** It belongs with the people, not
 *   in a corner: it is what they look like to the meeting, and beside the others is where
 *   that comparison is made.
 * - **The user's own SCREEN never takes the content, and is never absent either.** A
 *   mirror of one's own screen inside itself is a hall of mirrors, but the only way
 *   somebody can tell what the meeting is seeing is to see it too — so it is a corner
 *   preview, always.
 * - **Nothing to draw draws nothing.** An empty layout is what the avatar card answers,
 *   which is the same rule the old floating strip followed: a black rectangle waiting for
 *   a stream nobody started is worse than no rectangle.
 */
export function callStageLayout(
  remote: readonly RemoteVideo[],
  local: readonly LocalVideo[],
): StageLayout {
  const shares = remote.filter((video) => video.sharing);
  const cameras = remote.filter((video) => !video.sharing);
  const ownCamera = local.find((video) => video.kind === "camera") ?? null;
  const ownScreen = local.find((video) => video.kind === "screen") ?? null;
  const tiles: StageTile[] = [
    ...cameras.map((video) => ({ kind: "remote", key: video.mid, video }) as StageTile),
    ...shares.slice(1).map((video) => ({ kind: "remote", key: video.mid, video }) as StageTile),
    ...(ownCamera ? [{ kind: "local", key: "local-camera", video: ownCamera } as StageTile] : []),
  ];
  return {
    shared: shares[0] ?? null,
    tiles,
    ownScreen,
    empty: !shares[0] && tiles.length === 0 && !ownScreen,
  };
}

/**
 * The ONE picture the mini window carries, or null when it carries the avatar instead.
 *
 * A 320px window holds one thing, so it holds the most informative one: a shared screen
 * over a face, and a face over nothing. It is deliberately not the user's own preview —
 * folding the call away to do something else and being shown yourself would answer the
 * one question the window is not being asked.
 */
export function callMiniPicture(layout: StageLayout): StageTile | null {
  if (layout.shared) return { kind: "remote", key: layout.shared.mid, video: layout.shared };
  return layout.tiles.find((tile) => tile.kind === "remote") ?? null;
}


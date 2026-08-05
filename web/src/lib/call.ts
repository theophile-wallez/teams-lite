/**
 * Audio calling, as the backend describes it (`call_status` / `call_state` in
 * src/bin/server.rs, over src/calling.rs — and NATIVE-CALLING.md for the protocol).
 *
 * Two facts shape everything in this module and the next:
 *
 * - **The backend signals; this page carries the audio.** The tokens never reach a
 *   browser and the microphone is only reachable from one, so an SDP crosses the local
 *   WebSocket in each direction and nothing else about a call does. See
 *   {@link ./call-media}.
 * - **Calling is off until the user turns it on**, because turning it on registers this
 *   machine with Teams as a device their calls ring on. So this is not a display of a
 *   setting — it IS the consent gate, exactly like the agent's per-thread mode.
 *
 * Everything here is pure. The state comes from the backend, the actions live on the
 * controller, and nothing in this file reaches the network.
 */

import type { ConversationKind } from "./protocol";

/** How far along a call is, as the backend states it. */
export type CallPhase = "ringing" | "dialing" | "connecting" | "connected" | "ended";

/** Which way it was set up. */
export type CallDirection = "incoming" | "outgoing";

/** A one-to-one call, or a meeting this machine joined. It changes what the UI says and
 *  what the roster means — the signaling is the same either way. */
export type CallKind = "call" | "meeting";

/** The one call this machine is in, as every client is shown it.
 *
 *  It deliberately carries no SDP, no links and no credentials: those leave the backend
 *  only through a token-gated method, and only to the page that asked to place or answer
 *  this exact call. */
export type ActiveCall = {
  id: string;
  direction: CallDirection;
  kind: CallKind;
  phase: CallPhase;
  /** The chat, channel or meeting thread the call belongs to, when it has one. */
  conversation_id: string | null;
  /** Who is on the other end of a one-to-one call. A meeting names its own title here
   *  instead, because "who" is the roster below. */
  peer: string;
  peer_mri: string;
  /** Everybody else in a meeting, by name. Empty for a one-to-one call. */
  others: string[];
  /** Their MRIs, aligned with `others`, for their faces. */
  other_mris: string[];
  /** True while the meeting has us in its LOBBY: joined, and waiting to be let in. */
  in_lobby: boolean;
  /** How many of `others` are themselves still in the lobby — people who cannot hear
   *  the user yet. */
  waiting_in_lobby: number;
  muted: boolean;
  /** When audio started (epoch ms), so a duration counts from the backend's clock. */
  connected_at_ms: number | null;
  /** Why it ended, on the one frame that says it did. */
  end_reason: string | null;
  /** What everybody ELSE in the meeting is publishing, so this page can ask for it. Empty
   *  for a one-to-one call and for a backend too old to say. */
  publishing: PublishingParticipant[];
  /** Whether answering is possible — decided by the backend, which holds the links. */
  can_accept: boolean;
  can_hangup: boolean;
};

/** One person in the meeting and the streams they publish. */
export type PublishingParticipant = {
  mri: string;
  name: string;
  streams: PublishedStream[];
};

/**
 * One stream somebody publishes into the meeting.
 *
 * **`source_id` is why this type exists.** It is the media source id a subscription is
 * addressed by, and the roster is the only place it exists (NATIVE-CALLING.md § 10.2). It is
 * per meeting and it moves between joins, so it is never cached across calls.
 */
export type PublishedStream = {
  /** `main-audio` / `main-video` / `applicationsharing-video` / `data`. */
  label: string;
  kind: string;
  source_id: number;
  direction: string;
  server_muted: boolean;
  /** Whether this is somebody's screen being shared. Decided by the backend, so the label
   *  vocabulary is known in one place rather than two. */
  shared_screen: boolean;
  /** Whether this is somebody's camera, actually being sent. */
  camera: boolean;
};

/** Everything `call_status` reports, and the payload of every `call_state` event. */
export type CallStatus = {
  /** Whether the user turned calling on. False on a read-only backend whatever the
   *  store says. */
  enabled: boolean;
  /** Whether a call could start right now: the calling connection is up and
   *  registered. A switch that is on while this is false is honest about a connection
   *  that has not come back yet. */
  ready: boolean;
  call: ActiveCall | null;
};

/** What `call_prepare` hands back: what one `RTCPeerConnection` needs, and — when
 *  answering — the offer to answer. */
export type CallPreparation = {
  call_id: string;
  /** ICE servers in the shape `RTCPeerConnection` takes. */
  ice_servers: RTCIceServer[];
  /** The caller's SDP offer. Present only when answering. */
  offer_sdp?: string;
};

/** The `call_media` event: the far side's SDP, which is the frame that turns a call
 *  that is ringing into audio. */
export type CallMediaSignal = {
  call_id: string;
  sdp: string;
  kind: "answer" | "offer";
};

/** The status a client holds before the backend has answered.
 *
 *  Both flags are false on purpose. `enabled` false is what the backend defaults to,
 *  and `ready` false means no call can start — a hopeful `true` on either would tell
 *  the user their calls ring here while nothing is registered. */
export const UNKNOWN_CALL_STATUS: CallStatus = { enabled: false, ready: false, call: null };

/** Whether this app could place a call at all: the user turned it on, the connection is
 *  up, and no call is in flight (one at a time — one microphone). */
export function canPlaceCall(status: CallStatus): boolean {
  return status.enabled && status.ready && !isLive(status.call);
}

/** Whether a call is still going on. `ended` arrives once, so the UI can say why. */
export function isLive(call: ActiveCall | null): boolean {
  return !!call && call.phase !== "ended";
}

/** Whether the microphone should be open for this call: from the moment the user
 *  answered (or dialled) until the call is over. */
export function holdsMicrophone(call: ActiveCall | null): boolean {
  return !!call && call.phase !== "ended" && call.phase !== "ringing";
}

/** Whether a conversation is one this app can call: a one-to-one chat, and nothing
 *  else. A group call needs a roster, a mixer and more than one audio element, so it is
 *  refused up front rather than half-offered.
 *
 *  The value is the backend's own (`ConversationKind::OneOnOne` → `"one_on_one"`), never
 *  a guess: a spelling that matches nothing would silently hide the button everywhere. */
export function conversationIsCallable(kind: ConversationKind | undefined): boolean {
  return kind === "one_on_one";
}

/** What the call is doing, in the words the UI shows. Written for somebody glancing at
 *  a bar while doing something else, so it names the person once and the state once.
 *
 *  A meeting says different things for the same phases: nobody is being rung, and the
 *  lobby is a state a call does not have. */
export function callPhaseLabel(call: ActiveCall): string {
  if (call.kind === "meeting") {
    if (call.phase === "ended") return "Meeting left";
    if (call.in_lobby) return "Waiting to be let in…";
    if (call.phase === "connected") return meetingPresenceLabel(call);
    return "Joining…";
  }
  switch (call.phase) {
    case "ringing":
      return "Incoming call";
    case "dialing":
      return "Calling…";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "In a call";
    case "ended":
      return "Call ended";
  }
}

/** Who else is in the meeting, in the fewest words that are true.
 *
 *  One or two people are NAMED — that is what somebody glancing at the bar wants to
 *  know — and a crowd is counted, because six names do not fit and would not be read.
 *  A roster that has not arrived says nothing about it rather than "0 others". */
export function meetingPresenceLabel(call: ActiveCall): string {
  const others = call.others.filter((name) => name.trim().length > 0);
  if (others.length === 0) return "In the meeting";
  if (others.length <= 2) return `With ${others.join(" and ")}`;
  return `With ${others.length} others`;
}

/** Whether this call is a meeting the user joined. */
export function isMeeting(call: ActiveCall | null): boolean {
  return call?.kind === "meeting";
}

/** A running call duration as "0:07" / "12:45" / "1:02:03", from the backend's own
 *  clock so two open pages agree. Returns "" before audio started, because a call that
 *  is still ringing has no duration to state. */
export function callDurationLabel(call: ActiveCall | null, nowMs: number): string {
  if (!call?.connected_at_ms) return "";
  const seconds = Math.max(0, Math.floor((nowMs - call.connected_at_ms) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** Why the call is over, in one short line — or "" when there is nothing worth saying.
 *
 *  The service's own phrases are machine words ("CallEndReasonHangup"), and the ordinary
 *  endings need no explanation at all: a call the user hung up does not have to be
 *  reported back to them. Only the endings they did not cause get a line. */
export function callEndLabel(call: ActiveCall | null): string {
  const reason = call?.end_reason;
  if (!reason) return "";
  switch (reason) {
    case "CallEndReasonHangup":
    case "CallEndReasonDeclined":
      return "";
    case "CallEndReasonPlaceFailed":
      return "The call could not be placed.";
    case "CallEndReasonAcceptFailed":
      return "The call could not be answered.";
    case "CallEndReasonJoinFailed":
      return "The meeting could not be joined.";
    case "CallEndReasonNoAcceptLink":
      return "This call cannot be answered here.";
    case "CallEndReasonReconnected":
      return "The connection moved, so the call ended.";
    case "CallEndReasonCallingTurnedOff":
      return "Calling was turned off.";
    default:
      return "The call ended.";
  }
}

/**
 * Whether a URL is a Teams meeting link this app can join.
 *
 * A small port of `calling::MeetingJoin::from_join_url`, and deliberately only the part
 * that decides whether to OFFER the join: the path names a meetup-join, and it addresses
 * a thread. The backend parses it again and refuses anything it disagrees with, so the
 * worst a mismatch here costs is a button that reports a refusal — never a join to
 * somewhere else.
 */
export function isMeetingJoinLink(url: string | undefined | null): boolean {
  if (!url) return false;
  const base = url.split("?")[0] ?? "";
  // The SHORT shape Teams' newer meetings use: `…/meet/{code}`. It names no thread —
  // the service resolves one from the code — so the code is what makes it a join link.
  const code = base.split("/meet/")[1]?.split("/")[0] ?? "";
  if (code.length > 0 && /^[A-Za-z0-9]+$/.test(code)) return true;
  // The long shape: `…/l/meetup-join/{thread}/{message}`.
  const after = base.split("/meetup-join/")[1];
  if (!after) return false;
  return decodeURIComponentSafe(after.split("/")[0] ?? "").startsWith("19:");
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Whether a meeting could be joined right now: calling is on, the connection is up, and
 *  this machine is not already in a call.
 *
 *  The one-to-one rule does NOT apply — a meeting is many people by definition, and it is
 *  the service that mixes them. What still applies is one call at a time. */
export function canJoinMeeting(status: CallStatus): boolean {
  return status.enabled && status.ready && !isLive(status.call);
}

/** Why a meeting cannot be joined right now, for the tooltip on a disabled Join button.
 *  Empty when it can. */
export function meetingUnavailableReason(status: CallStatus): string {
  if (!status.enabled) return "Turn calling on in Settings to join a meeting here.";
  if (!status.ready) return "This machine is not registered for calls yet.";
  if (isLive(status.call)) return "This app holds one call at a time.";
  return "";
}

/** Why calling cannot be used right now, for the tooltip on a disabled call button.
 *  Empty when it can. */
export function callUnavailableReason(status: CallStatus, callable: boolean): string {
  if (!status.enabled) return "Turn calling on in Settings to call from here.";
  if (!status.ready) return "This machine is not registered for calls yet.";
  if (isLive(status.call)) return "This app holds one call at a time.";
  if (!callable) return "Only a one-to-one chat can be called.";
  return "";
}

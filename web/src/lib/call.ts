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

/** The one call this machine is in, as every client is shown it.
 *
 *  It deliberately carries no SDP, no links and no credentials: those leave the backend
 *  only through a token-gated method, and only to the page that asked to place or answer
 *  this exact call. */
export type ActiveCall = {
  id: string;
  direction: CallDirection;
  phase: CallPhase;
  /** The chat the call belongs to, when it has one. */
  conversation_id: string | null;
  /** Who is on the other end, named the way every other surface names them — the
   *  user's own nickname for them included. */
  peer: string;
  peer_mri: string;
  muted: boolean;
  /** When audio started (epoch ms), so a duration counts from the backend's clock. */
  connected_at_ms: number | null;
  /** Why it ended, on the one frame that says it did. */
  end_reason: string | null;
  /** Whether answering is possible — decided by the backend, which holds the links. */
  can_accept: boolean;
  can_hangup: boolean;
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
 *  a bar while doing something else, so it names the person once and the state once. */
export function callPhaseLabel(call: ActiveCall): string {
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

/** Why calling cannot be used right now, for the tooltip on a disabled call button.
 *  Empty when it can. */
export function callUnavailableReason(status: CallStatus, callable: boolean): string {
  if (!status.enabled) return "Turn calling on in Settings to call from here.";
  if (!status.ready) return "This machine is not registered for calls yet.";
  if (isLive(status.call)) return "This app holds one call at a time.";
  if (!callable) return "Only a one-to-one chat can be called.";
  return "";
}

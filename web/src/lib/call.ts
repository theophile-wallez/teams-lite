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

import type { Conversation, ConversationKind } from "./protocol";

/** How far along a call is, as the backend states it. */
export type CallPhase = "ringing" | "dialing" | "connecting" | "connected" | "ended";

/** Which way it was set up. */
export type CallDirection = "incoming" | "outgoing";

/** A one-to-one call, a call that rang a whole group chat, or a meeting this machine
 *  joined. It changes what the UI says and what the roster means — the signaling is the
 *  same in all three. A `group` and a `meeting` both name the CONVERSATION where a 1:1
 *  names the person, because several people have no one name. */
export type CallKind = "call" | "group" | "meeting";

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
  /** What this MACHINE is sending beyond audio: `"camera"`, `"screen"`, or neither. Published
   *  by the backend so two open pages agree and a reconnecting one is told rather than
   *  guessing from its own memory. */
  sending: string[];
  /** Whether answering is possible — decided by the backend, which holds the links. */
  can_accept: boolean;
  can_hangup: boolean;
  /** Whether new media can be offered at all. The service refuses it on a call that is not
   *  established, and only the backend knows whether the link exists. */
  can_send_media: boolean;
};

/** The modality name the service reads for one of the two things this app can send.
 *
 *  `ScreenSharer` and not `ScreenViewer`: sending a screen and watching one are two different
 *  modalities, and the one that says "my screen is on the wire" is this. */
export function modalityFor(kind: "camera" | "screen"): string {
  return kind === "camera" ? "Video" : "ScreenSharer";
}

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
  /** Whether this window's backend takes calls at all. True on every install the user
   *  can open — each registers as a device their calls ring on, like every other Teams
   *  client they are signed in on, and two on one machine are two devices. False on the
   *  ONE backend they never opened: a read-only one. There is no switch. */
  enabled: boolean;
  /** Whether a call could start right now: the calling connection is up and
   *  registered. A backend that calls while this is false is honest about a connection
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
 *  Both flags are false on purpose: no call can start through a backend that has not
 *  spoken yet, and a hopeful `true` on either would tell the user their calls ring here
 *  while nothing is registered. The backend says otherwise within one round trip. */
export const UNKNOWN_CALL_STATUS: CallStatus = { enabled: false, ready: false, call: null };

/** Whether this app could place a call at all: this backend takes calls, the connection
 *  is up, and no call is in flight (one at a time — one microphone). */
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

/** Whether a conversation is one this app can call: a chat with people in it to ring.
 *
 *  A one-to-one rings the one person; a GROUP chat rings every member at once, which is
 *  the same POST (`calling::invitation_payload`) and the same call this UI already draws —
 *  the service mixes the voices, the page keeps one `<audio>` per remote stream, and "who
 *  is in it" is the roster a meeting already answers from. The backend still decides how
 *  many is too many (`MAX_GROUP_CALL_PEOPLE`), because that is a fact about the thread it
 *  has to fetch and this is a pure function.
 *
 *  Notes — the chat with oneself — is the one chat with nobody to ring. A CHANNEL is not a
 *  conversation here at all (it has no row in this list), and a MEETING chat is joined
 *  rather than rung: see {@link conversationCallAction}.
 *
 *  The value is the backend's own (`ConversationKind::OneOnOne` → `"one_on_one"`), never
 *  a guess: a spelling that matches nothing would silently hide the button everywhere. */
export function conversationIsCallable(kind: ConversationKind | undefined): boolean {
  return kind === "one_on_one" || kind === "group" || kind === "unknown";
}

/** What a conversation's header offers: nothing, a call it places, or a meeting it joins.
 *
 *  One control per conversation, and the conversation's own origin decides which. A thread
 *  Teams minted FOR a meeting is joined — that meeting is the thing the thread is about, and
 *  it is reachable from here without going to the calendar for a link, which is what this
 *  pair of buttons exists for. Every other chat with somebody in it is called.
 *
 *  A meeting chat therefore does not offer a ring. Both would fit, but they answer the same
 *  question twice ("talk to these people now") and only one of them is what the thread is
 *  for — and the person who wants the other one still has the 1:1s and real Teams. */
export type ConversationCallAction = "none" | "call" | "join";

export function conversationCallAction(
  conversation: Conversation | undefined,
): ConversationCallAction {
  if (!conversation) return "none";
  // The ADDRESS decides, never a flag about the thread's origin: CSA also calls a thread a
  // meeting through `thread_type`, and a row flagged that way whose id names no meeting has
  // nothing to JOIN. Deciding on the flag would leave that row with no control at all,
  // where deciding on the address leaves it the call every other group chat gets.
  if (meetingAddressOf(conversation)) return "join";
  return conversationIsCallable(conversation.kind) ? "call" : "none";
}

/**
 * How a meeting is ADDRESSED, in the two ways the user can reach one.
 *
 * `link` is what a calendar event carries (`onlineMeeting.joinUrl`), in either shape Teams
 * writes one. `thread` is the meeting's own conversation out of the chat list, which is an
 * address on its own — `calling::MeetingJoin::from_thread_id`. Both exist because each
 * covers what the other cannot: this tenant's invitations carry the short `/meet/{code}`
 * link, whose code lives in the calendar event and nowhere in the conversation, while a
 * meeting whose event has rolled out of the synced window still has its chat.
 */
export type MeetingAddress = { kind: "link"; joinUrl: string } | { kind: "thread"; thread: string };

/** The meeting address of a THREAD id, or null when it names no meeting.
 *
 *  A port of the same `19:meeting_` rule the backend applies (`MeetingJoin::from_thread_id`),
 *  so a button is offered only where the backend would agree — and the backend parses it
 *  again, so the worst a disagreement costs is a button that reports a refusal.
 *
 *  It takes the bare id, because a call is reached from two states that hold two different
 *  things: a chat header has the whole {@link Conversation}, and the incoming-call banner has
 *  only the id the awareness event named. One spelling of the rule, for both. */
export function meetingAddressOfThread(id: string | undefined | null): MeetingAddress | null {
  if (!id?.startsWith("19:meeting_")) return null;
  return { kind: "thread", thread: id };
}

/** The meeting address of a conversation, or null when it names no meeting. */
export function meetingAddressOf(conversation: Conversation | undefined): MeetingAddress | null {
  return meetingAddressOfThread(conversation?.id);
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
    if (call.phase === "connected") return callPresenceLabel(call);
    return "Joining…";
  }
  // A GROUP call rang several phones, so who is in it is a fact that CHANGES while it runs
  // and the roster is the only thing that knows: one person may pick up while two never do.
  // Until it is connected it says the same words a 1:1 does — the bar names the conversation
  // beside this, so "Calling…" over a group's title is already the whole sentence.
  if (call.kind === "group" && call.phase === "connected") {
    return callPresenceLabel(call);
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

/** Who else is in this meeting or group call, in the fewest words that are true.
 *
 *  One or two people are NAMED — that is what somebody glancing at the bar wants to
 *  know — and a crowd is counted, because six names do not fit and would not be read.
 *  A roster that has not arrived says nothing about it rather than "0 others". */
export function callPresenceLabel(call: ActiveCall): string {
  const others = call.others.filter((name) => name.trim().length > 0);
  if (others.length === 0) return call.kind === "meeting" ? "In the meeting" : "In the call";
  if (others.length <= 2) return `With ${others.join(" and ")}`;
  return `With ${others.length} others`;
}

/** Whether this call is a meeting the user joined. */
export function isMeeting(call: ActiveCall | null): boolean {
  return call?.kind === "meeting";
}

/** Whether this call is about a CONVERSATION rather than one person — a meeting, or a
 *  call that rang a whole group chat.
 *
 *  It is what the UI reads before drawing a face: `peer_mri` is empty on both, so an
 *  avatar seeded from it would be a tinted circle standing in for a group of five. And
 *  it is what makes the roster worth stating, because in both there is more than one
 *  person the answer could be. */
export function callNamesAConversation(call: ActiveCall | null): boolean {
  return call?.kind === "meeting" || call?.kind === "group";
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

/**
 * The backend's name for a call that rang nothing, because the callee has no client signed
 * in — `calling::END_REASON_UNREACHABLE`, spelled once here.
 *
 * The pair is pinned from the Rust side (`the_page_knows_the_name_of_an_unreachable_ending`),
 * because two spellings of it would silently put the user back in front of "The call ended."
 */
export const CALL_END_UNREACHABLE = "CallEndReasonNobodyReachable";

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
    // The service could not ring anybody: nothing of theirs is signed in (`calling::
    // END_REASON_UNREACHABLE`, and `calling::invite_failed` for how it is known). It reads
    // exactly like this app dropping the call after two seconds, which is what it looked
    // like to the user until the reason was carried this far — so it names the person and
    // it names the cause, and it never says a device rang.
    case CALL_END_UNREACHABLE:
      return call.kind === "group" || call.kind === "meeting"
        ? "Nobody could be reached: none of their devices is signed in."
        : `${call.peer || "They"} could not be reached: no device of theirs is signed in.`;
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
      // No switch says this any more: this machine stopped being a device calls ring on,
      // which is what the app does as it shuts down.
      return "This machine stopped taking calls.";
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

/** Whether a meeting could be joined right now: this backend takes calls, the connection
 *  is up, and this machine is not already in a call.
 *
 *  The one-to-one rule does NOT apply — a meeting is many people by definition, and it is
 *  the service that mixes them. What still applies is one call at a time. */
export function canJoinMeeting(status: CallStatus): boolean {
  return status.enabled && status.ready && !isLive(status.call);
}

/** Why a meeting cannot be joined right now, for the tooltip on a disabled Join button.
 *  Empty when it can.
 *
 *  `enabled` false is no longer something the user can fix — there is no switch, so it
 *  says what this window IS rather than what to go and turn on. It is a read-only backend
 *  or a second install, and the app they launched is the one that joins. */
export function meetingUnavailableReason(status: CallStatus): string {
  if (!status.enabled) return "This window cannot take calls, so it cannot join a meeting.";
  if (!status.ready) return "This machine is not registered for calls yet.";
  if (isLive(status.call)) return "This app holds one call at a time.";
  return "";
}

/** Why calling cannot be used right now, for the tooltip on a disabled call button.
 *  Empty when it can.
 *
 *  It names only the three things about this MACHINE, because the button is drawn where a
 *  call is possible in the first place ({@link conversationCallAction}) — a conversation
 *  nothing can be done with has no control to hang a reason off. */
export function callUnavailableReason(status: CallStatus): string {
  if (!status.enabled) return "This window cannot take calls, so it cannot place one.";
  if (!status.ready) return "This machine is not registered for calls yet.";
  if (isLive(status.call)) return "This app holds one call at a time.";
  return "";
}

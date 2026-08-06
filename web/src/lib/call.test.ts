import { describe, expect, it } from "vitest";
import {
  UNKNOWN_CALL_STATUS,
  callDurationLabel,
  CALL_END_UNREACHABLE,
  callEndLabel,
  callPhaseLabel,
  callNamesAConversation,
  callPresenceLabel,
  callUnavailableReason,
  canJoinMeeting,
  canPlaceCall,
  conversationCallAction,
  conversationIsCallable,
  holdsMicrophone,
  isLive,
  isMeeting,
  isMeetingJoinLink,
  meetingAddressOf,
  meetingUnavailableReason,
  type ActiveCall,
  type CallPhase,
  type CallStatus,
} from "./call";
import type { Conversation } from "./protocol";

function call(overrides: Partial<ActiveCall> = {}): ActiveCall {
  return {
    id: "call-1",
    direction: "incoming",
    kind: "call",
    phase: "ringing",
    conversation_id: "19:thread@thread.v2",
    peer: "Riley Carter",
    peer_mri: "8:orgid:riley",
    others: [],
    other_mris: [],
    in_lobby: false,
    waiting_in_lobby: 0,
    publishing: [],
    sending: [],
    muted: false,
    connected_at_ms: null,
    end_reason: null,
    can_accept: true,
    can_send_media: false,
    can_hangup: true,
    ...overrides,
  };
}

function status(overrides: Partial<CallStatus> = {}): CallStatus {
  return { enabled: true, ready: true, call: null, ...overrides };
}

describe("the unknown state", () => {
  /** The backend defaults to off, so the client's own default has to say off. A
   *  hopeful `enabled` would tell the user their calls ring here while nothing is
   *  registered — the same rule the agent's mode switch follows. */
  it("claims nothing before the backend answers", () => {
    expect(UNKNOWN_CALL_STATUS.enabled).toBe(false);
    expect(UNKNOWN_CALL_STATUS.ready).toBe(false);
    expect(UNKNOWN_CALL_STATUS.call).toBeNull();
    expect(canPlaceCall(UNKNOWN_CALL_STATUS)).toBe(false);
  });
});

describe("whether a call is live", () => {
  it("counts every phase but the last", () => {
    const phases: CallPhase[] = ["ringing", "dialing", "connecting", "connected"];
    for (const phase of phases) expect(isLive(call({ phase }))).toBe(true);
    expect(isLive(call({ phase: "ended" }))).toBe(false);
    expect(isLive(null)).toBe(false);
  });

  /** The microphone is the thing a mistake here leaves switched on, so it is its own
   *  question: a call that is only RINGING has not opened it yet, and a call that
   *  ended must not be holding it. */
  it("only holds the microphone once the call was answered", () => {
    expect(holdsMicrophone(call({ phase: "ringing" }))).toBe(false);
    expect(holdsMicrophone(call({ phase: "dialing" }))).toBe(true);
    expect(holdsMicrophone(call({ phase: "connecting" }))).toBe(true);
    expect(holdsMicrophone(call({ phase: "connected" }))).toBe(true);
    expect(holdsMicrophone(call({ phase: "ended" }))).toBe(false);
    expect(holdsMicrophone(null)).toBe(false);
  });
});

describe("whether a call can be placed", () => {
  it("needs the setting, the connection, and a free machine", () => {
    expect(canPlaceCall(status())).toBe(true);
    expect(canPlaceCall(status({ enabled: false }))).toBe(false);
    expect(canPlaceCall(status({ ready: false }))).toBe(false);
    expect(canPlaceCall(status({ call: call({ phase: "connected" }) }))).toBe(false);
    // A call that ended frees the machine again.
    expect(canPlaceCall(status({ call: call({ phase: "ended" }) }))).toBe(true);
  });

  /** A chat with somebody to ring is callable — one person, or a whole group at once,
   *  which is the same POST. Notes is the one chat with nobody in it. */
  it("offers a call wherever there is somebody to ring", () => {
    // The backend's own spellings (`ConversationKind`), not a guess: a mismatch here
    // hides the button in every chat.
    expect(conversationIsCallable("one_on_one")).toBe(true);
    expect(conversationIsCallable("group")).toBe(true);
    // A row the backend synced an id for and nothing else. Every one observed so far is a
    // meeting thread, which the action below sends to Join — and a call is a better
    // fallback than no control for one that is not.
    expect(conversationIsCallable("unknown")).toBe(true);
    for (const kind of ["notes", undefined] as const) {
      expect(conversationIsCallable(kind)).toBe(false);
    }
  });

  it("says why it cannot, in the order the user can act on", () => {
    // A window that does not call at all is a read-only backend or the second install, and
    // neither is something the user turns on: the sentence says what this window IS, and
    // never sends them to a switch that no longer exists.
    expect(callUnavailableReason(status({ enabled: false }))).toMatch(/cannot take calls/);
    expect(callUnavailableReason(status({ enabled: false }))).not.toMatch(/Settings/);
    expect(callUnavailableReason(status({ ready: false }))).toMatch(/not registered/);
    expect(callUnavailableReason(status({ call: call() }))).toMatch(/one call at a time/);
    expect(callUnavailableReason(status())).toBe("");
  });
});

describe("what a conversation's header offers", () => {
  function conversation(overrides: Partial<Conversation> = {}): Conversation {
    return {
      id: "19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2",
      name: "Design crew",
      last_message_time: 0,
      kind: "group",
      last_message_preview: "",
      last_message_sender: "",
      last_message_from_me: false,
      is_read: true,
      is_muted: false,
      is_pinned: false,
      is_hidden: false,
      thread_type: "chat",
      draft: "",
      ...overrides,
    };
  }

  /** The whole point of the pair: a meeting in the chat list is JOINED, without going to
   *  the calendar for its link, and every other chat is CALLED. */
  it("joins a meeting thread and calls every other chat", () => {
    const meetingChat = conversation({
      id: "19:meeting_YWI2Y2E5MDIt@thread.v2",
      thread_type: "meeting",
      name: "Daily",
    });
    expect(conversationCallAction(meetingChat)).toBe("join");
    expect(meetingAddressOf(meetingChat)).toEqual({
      kind: "thread",
      thread: "19:meeting_YWI2Y2E5MDIt@thread.v2",
    });

    expect(conversationCallAction(conversation())).toBe("call");
    expect(conversationCallAction(conversation({ kind: "one_on_one" }))).toBe("call");
    expect(conversationCallAction(conversation({ kind: "notes", id: "48:notes" }))).toBe("none");
    expect(conversationCallAction(undefined)).toBe("none");
  });

  /** The ADDRESS decides, never CSA's flag about the thread's origin: a row flagged
   *  `meeting` whose id names no meeting has nothing to join, and it must not be left with
   *  no control at all. */
  it("falls back to a call when the flag says meeting but no address does", () => {
    const flagged = conversation({ thread_type: "meeting" });
    expect(meetingAddressOf(flagged)).toBeNull();
    expect(conversationCallAction(flagged)).toBe("call");
  });

  /** A 1:1 has one person to name, so it is never a meeting address whatever else is
   *  true of it. */
  it("never reads a chat as a meeting on anything but its id", () => {
    expect(meetingAddressOf(conversation({ kind: "one_on_one" }))).toBeNull();
    expect(meetingAddressOf(undefined)).toBeNull();
  });
});

describe("what the bar says", () => {
  it("names each phase once", () => {
    expect(callPhaseLabel(call({ phase: "ringing" }))).toBe("Incoming call");
    expect(callPhaseLabel(call({ phase: "dialing" }))).toBe("Calling…");
    expect(callPhaseLabel(call({ phase: "connecting" }))).toBe("Connecting…");
    expect(callPhaseLabel(call({ phase: "connected" }))).toBe("In a call");
    expect(callPhaseLabel(call({ phase: "ended" }))).toBe("Call ended");
  });

  /** A GROUP call rang several phones, so once it is up "who is in it" is a fact that
   *  changes — one person may pick up while two never do — and only the roster knows. Until
   *  then it says what a 1:1 says: the bar names the conversation beside it. */
  it("answers a group call from its roster once it is up", () => {
    const group = (overrides: Partial<ActiveCall> = {}) =>
      call({ kind: "group", peer: "Design crew", peer_mri: "", ...overrides });
    expect(callPhaseLabel(group({ phase: "dialing" }))).toBe("Calling…");
    expect(callPhaseLabel(group({ phase: "connected" }))).toBe("In the call");
    expect(callPhaseLabel(group({ phase: "connected", others: ["Ava", "Liam"] }))).toBe(
      "With Ava and Liam",
    );
    // It is not a meeting: there is no lobby, and leaving it is hanging up.
    expect(isMeeting(group())).toBe(false);
    // But it names a CONVERSATION rather than a person, so the bar draws the group mark
    // instead of a face seeded from an empty mri.
    expect(callNamesAConversation(group())).toBe(true);
    expect(callNamesAConversation(call())).toBe(false);
    expect(callNamesAConversation(null)).toBe(false);
  });

  it("counts the duration from the backend's own clock", () => {
    const started = 1_700_000_000_000;
    const live = call({ phase: "connected", connected_at_ms: started });
    expect(callDurationLabel(live, started)).toBe("0:00");
    expect(callDurationLabel(live, started + 7_000)).toBe("0:07");
    expect(callDurationLabel(live, started + 65_000)).toBe("1:05");
    expect(callDurationLabel(live, started + 3_723_000)).toBe("1:02:03");
    // A clock that disagrees with the backend must not count backwards.
    expect(callDurationLabel(live, started - 5_000)).toBe("0:00");
    // Nothing to state before audio started.
    expect(callDurationLabel(call(), started)).toBe("");
    expect(callDurationLabel(null, started)).toBe("");
  });

  /** An ending the user caused needs no explanation: they were there. Every other one
   *  gets a sentence, because the alternative is a call that vanishes with no reason. */
  it("explains an ending the user did not cause, and stays quiet about the rest", () => {
    expect(callEndLabel(call({ end_reason: "CallEndReasonHangup" }))).toBe("");
    expect(callEndLabel(call({ end_reason: "CallEndReasonDeclined" }))).toBe("");
    expect(callEndLabel(call({ end_reason: null }))).toBe("");
    expect(callEndLabel(null)).toBe("");
    expect(callEndLabel(call({ end_reason: "CallEndReasonPlaceFailed" }))).toMatch(/not be placed/);
    expect(callEndLabel(call({ end_reason: "CallEndReasonAcceptFailed" }))).toMatch(
      /not be answered/,
    );
    expect(callEndLabel(call({ end_reason: "CallEndReasonReconnected" }))).toMatch(/connection/);
    expect(callEndLabel(call({ end_reason: "CallEndReasonCallingTurnedOff" }))).toMatch(
      /stopped taking calls/,
    );
    // A code we have never seen still says something rather than nothing.
    expect(callEndLabel(call({ end_reason: "code 486" }))).toBe("The call ended.");
  });

  /** A call that rang NOTHING — nobody's client is signed in. Measured against the tenant:
   *  the service invites nobody and ends the conversation two seconds later, which is
   *  indistinguishable from this app dropping the call unless the sentence says otherwise. */
  it("names the person a call could not reach, and the cause", () => {
    const ended = callEndLabel(
      call({ end_reason: CALL_END_UNREACHABLE, peer: "Gabriel CRETI", kind: "call" }),
    );
    expect(ended).toMatch(/Gabriel CRETI could not be reached/);
    expect(ended).toMatch(/no device of theirs is signed in/);
    // Never the service's own words: a sub-code and `addParticipantFailure` are written for
    // whoever holds the socket.
    expect(ended).not.toMatch(/endpoint|subCode|addParticipant/i);
    // A group and a meeting have no one person to name, so they say it of everybody.
    expect(callEndLabel(call({ end_reason: CALL_END_UNREACHABLE, kind: "group" }))).toMatch(
      /Nobody could be reached/,
    );
  });
});

describe("joining a meeting", () => {
  const meeting = (overrides: Partial<ActiveCall> = {}) =>
    call({ kind: "meeting", direction: "outgoing", peer: "Quarterly planning", ...overrides });

  /** The check that decides whether a Join button is drawn at all. It is a small port of
   *  the Rust parse, so it has to agree with it on both answers. */
  it("recognises a Teams meeting link, and nothing else", () => {
    expect(
      isMeetingJoinLink(
        "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_x%40thread.v2/0?context=%7B%7D",
      ),
    ).toBe(true);
    // A channel meeting is another real shape.
    expect(
      isMeetingJoinLink("https://teams.microsoft.com/l/meetup-join/19%3Aabc%40thread.tacv2/17194"),
    ).toBe(true);
    // And the SHORT shape Teams' newer meetings use — a code and a passcode, no thread.
    // It is the shape the user's own meetings have, and refusing it hid the button.
    expect(isMeetingJoinLink("https://teams.microsoft.com/meet/35017215452446?p=4QyEW")).toBe(true);
    expect(isMeetingJoinLink("https://teams.microsoft.com/meet/12345")).toBe(true);
    for (const url of [
      "",
      null,
      undefined,
      "https://teams.microsoft.com/l/channel/19%3Aabc%40thread.tacv2/General",
      "https://zoom.us/j/123",
      // The path is right, the thread is not one.
      "https://teams.microsoft.com/l/meetup-join/quarterly-planning",
      // And a short path with no code names no meeting.
      "https://teams.microsoft.com/meet/",
    ]) {
      expect(isMeetingJoinLink(url)).toBe(false);
    }
  });

  /** A meeting is many people by definition, so the one-to-one rule does not apply to
   *  it. One call at a time still does — there is one microphone. */
  it("needs calling on and a free machine, and no one-to-one rule", () => {
    expect(canJoinMeeting(status())).toBe(true);
    expect(canJoinMeeting(status({ enabled: false }))).toBe(false);
    expect(canJoinMeeting(status({ ready: false }))).toBe(false);
    expect(canJoinMeeting(status({ call: meeting({ phase: "connected" }) }))).toBe(false);
    expect(meetingUnavailableReason(status({ enabled: false }))).toMatch(/cannot take calls/);
    expect(meetingUnavailableReason(status({ enabled: false }))).not.toMatch(/Settings/);
    expect(meetingUnavailableReason(status({ call: meeting() }))).toMatch(/one call at a time/);
    expect(meetingUnavailableReason(status())).toBe("");
  });

  /** The lobby is its own state. "Connecting…" would hide the one thing the user has to
   *  know: nobody has let them in yet. */
  it("says the lobby, the join, and who is there", () => {
    expect(callPhaseLabel(meeting({ phase: "connecting" }))).toBe("Joining…");
    expect(callPhaseLabel(meeting({ phase: "connecting", in_lobby: true }))).toMatch(
      /Waiting to be let in/,
    );
    // Admitted, but the roster has not arrived: it says nothing about who is there
    // rather than "0 others".
    expect(callPhaseLabel(meeting({ phase: "connected" }))).toBe("In the meeting");
    expect(callPhaseLabel(meeting({ phase: "ended" }))).toBe("Meeting left");
  });

  /** One or two people are named, because that is what a glance wants. A crowd is
   *  counted, because six names do not fit and would not be read. */
  it("names a couple of people and counts a crowd", () => {
    expect(callPresenceLabel(meeting({ others: ["Ava"] }))).toBe("With Ava");
    expect(callPresenceLabel(meeting({ others: ["Ava", "Liam"] }))).toBe("With Ava and Liam");
    expect(callPresenceLabel(meeting({ others: ["Ava", "Liam", "Priya"] }))).toBe(
      "With 3 others",
    );
    // A roster of blanks is a roster that has not arrived, and each kind says where the
    // user is in its own words.
    expect(callPresenceLabel(meeting({ others: ["", " "] }))).toBe("In the meeting");
    expect(callPresenceLabel(call({ kind: "group", others: [] }))).toBe("In the call");
  });

  it("tells a meeting apart from a call", () => {
    expect(isMeeting(meeting())).toBe(true);
    expect(isMeeting(call())).toBe(false);
    expect(isMeeting(null)).toBe(false);
  });

  it("explains a join that failed", () => {
    expect(callEndLabel(meeting({ end_reason: "CallEndReasonJoinFailed" }))).toMatch(
      /could not be joined/,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  UNKNOWN_CALL_STATUS,
  callDurationLabel,
  callEndLabel,
  callPhaseLabel,
  callUnavailableReason,
  canJoinMeeting,
  canPlaceCall,
  conversationIsCallable,
  holdsMicrophone,
  isLive,
  isMeeting,
  isMeetingJoinLink,
  meetingPresenceLabel,
  meetingUnavailableReason,
  type ActiveCall,
  type CallPhase,
  type CallStatus,
} from "./call";

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

  /** One microphone, one audio element, no roster UI: a group call is refused up front
   *  rather than half-offered. */
  it("offers a call in a one-to-one chat and nowhere else", () => {
    // The backend's own spelling (`ConversationKind::OneOnOne`), not a guess: a
    // mismatch here hides the button in every chat.
    expect(conversationIsCallable("one_on_one")).toBe(true);
    for (const kind of ["group", "notes", "unknown", undefined] as const) {
      expect(conversationIsCallable(kind)).toBe(false);
    }
  });

  it("says why it cannot, in the order the user can act on", () => {
    expect(callUnavailableReason(status({ enabled: false }), true)).toMatch(/Settings/);
    expect(callUnavailableReason(status({ ready: false }), true)).toMatch(/not registered/);
    expect(callUnavailableReason(status({ call: call() }), true)).toMatch(/one call at a time/);
    expect(callUnavailableReason(status(), false)).toMatch(/one-to-one/);
    expect(callUnavailableReason(status(), true)).toBe("");
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
      /turned off/,
    );
    // A code we have never seen still says something rather than nothing.
    expect(callEndLabel(call({ end_reason: "code 486" }))).toBe("The call ended.");
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
    expect(meetingUnavailableReason(status({ enabled: false }))).toMatch(/Settings/);
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
    expect(meetingPresenceLabel(meeting({ others: ["Ava"] }))).toBe("With Ava");
    expect(meetingPresenceLabel(meeting({ others: ["Ava", "Liam"] }))).toBe("With Ava and Liam");
    expect(meetingPresenceLabel(meeting({ others: ["Ava", "Liam", "Priya"] }))).toBe(
      "With 3 others",
    );
    // A roster of blanks is a roster that has not arrived.
    expect(meetingPresenceLabel(meeting({ others: ["", " "] }))).toBe("In the meeting");
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

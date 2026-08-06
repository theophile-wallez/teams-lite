import { describe, expect, it } from "vitest";
import {
  MINI_BAR_HEIGHT,
  MINI_MARGIN,
  MINI_MIN_WIDTH,
  MINI_WIDTH,
  callMiniPicture,
  callStageChatConversation,
  callStageIsUp,
  callStageLayout,
  callStageLobbyLabel,
  callStageParticipants,
  callStageSubtitle,
  callStageTimeTitle,
  callStageTitle,
  callStartClockLabel,
  clampMiniPosition,
  miniHomePosition,
  miniSize,
} from "./call-stage";
import type { ActiveCall, PublishingParticipant } from "./call";
import type { LocalVideo, RemoteVideo } from "./call-media";

function remote(mid: string, sharing: boolean): RemoteVideo {
  return {
    mid,
    streamMsid: `msid-${mid}`,
    label: sharing ? "applicationsharing-video" : "main-video",
    sharing,
    // A stream is never touched by these functions — they sort pictures, they do not draw
    // them — so the fixture does not need a real one.
    stream: {} as MediaStream,
  };
}

function local(kind: LocalVideo["kind"]): LocalVideo {
  return { kind, stream: {} as MediaStream };
}

function call(overrides: Partial<ActiveCall> = {}): ActiveCall {
  return {
    id: "call-1",
    direction: "outgoing",
    kind: "meeting",
    phase: "connected",
    conversation_id: "19:meeting_abc@thread.v2",
    peer: "Architecture guild",
    peer_mri: "",
    others: [],
    other_mris: [],
    in_lobby: false,
    waiting_in_lobby: 0,
    publishing: [],
    sending: [],
    muted: false,
    connected_at_ms: null,
    end_reason: null,
    can_accept: false,
    can_send_media: true,
    can_hangup: true,
    ...overrides,
  };
}

function publishing(mri: string, kinds: { camera?: boolean; sharing?: boolean }): PublishingParticipant {
  return {
    mri,
    name: "whoever",
    streams: [
      {
        label: "main-audio",
        kind: "audio",
        source_id: 2400,
        direction: "sendrecv",
        server_muted: false,
        shared_screen: false,
        camera: false,
      },
      ...(kinds.camera
        ? [
            {
              label: "main-video",
              kind: "video",
              source_id: 2401,
              direction: "sendrecv",
              server_muted: false,
              shared_screen: false,
              camera: true,
            },
          ]
        : []),
      ...(kinds.sharing
        ? [
            {
              label: "applicationsharing-video",
              kind: "applicationsharing-video",
              source_id: 2402,
              direction: "sendonly",
              server_muted: false,
              shared_screen: true,
              camera: false,
            },
          ]
        : []),
    ],
  };
}

const VIEWPORT = { width: 1280, height: 800 };
/** A phone in portrait, which is where this app is read most. */
const PHONE = { width: 390, height: 844 };
const DESKTOP_MINI = miniSize(VIEWPORT);

describe("which calls the stage draws", () => {
  /** A ringing call is an offer, not a call: nothing is connected and no microphone is
   *  open, so it stays the card beside the conversation. Taking the whole screen for
   *  something the user may decline would be the app deciding for them. */
  it("draws every live call except a ringing one", () => {
    expect(callStageIsUp(null)).toBe(false);
    expect(callStageIsUp(call({ phase: "ringing" }))).toBe(false);
    expect(callStageIsUp(call({ phase: "ended" }))).toBe(false);
    expect(callStageIsUp(call({ phase: "dialing" }))).toBe(true);
    expect(callStageIsUp(call({ phase: "connecting" }))).toBe(true);
    expect(callStageIsUp(call({ phase: "connected" }))).toBe(true);
  });
});

describe("the mini window's position", () => {
  it("starts in the bottom-right corner, clear of both edges", () => {
    expect(miniHomePosition(VIEWPORT)).toEqual({
      x: 1280 - DESKTOP_MINI.width - MINI_MARGIN,
      y: 800 - DESKTOP_MINI.height - MINI_MARGIN,
    });
  });

  /** The clamp is what keeps a call findable. A window dropped half off the screen — or
   *  left where it was while the viewport shrank under it — would take the hang-up button
   *  with it, so every drop and every resize goes through here. */
  it("keeps the whole window on screen, whichever edge it was pushed past", () => {
    expect(clampMiniPosition({ x: -400, y: -400 }, VIEWPORT)).toEqual({
      x: MINI_MARGIN,
      y: MINI_MARGIN,
    });
    expect(clampMiniPosition({ x: 99_999, y: 99_999 }, VIEWPORT)).toEqual({
      x: 1280 - DESKTOP_MINI.width - MINI_MARGIN,
      y: 800 - DESKTOP_MINI.height - MINI_MARGIN,
    });
  });

  /** A viewport narrower than the window itself is a real state — a phone in portrait
   *  with the keyboard up — and the answer must still be a corner somebody can reach,
   *  never a negative one that parks the controls off screen. */
  it("pins to the top-left when the viewport is smaller than the window", () => {
    expect(clampMiniPosition({ x: 500, y: 500 }, { width: 200, height: 120 })).toEqual({
      x: MINI_MARGIN,
      y: MINI_MARGIN,
    });
  });
});

describe("what the stage says about the call", () => {
  it("names the meeting, the group or the person — the backend's own words", () => {
    expect(callStageTitle(call({ peer: "Architecture guild" }))).toBe("Architecture guild");
    expect(callStageTitle(call({ kind: "call", peer: "Ava Thompson" }))).toBe("Ava Thompson");
  });

  /** The two empty cases say what the thing IS. A meeting whose subject never arrived is
   *  still a meeting; a caller the directory could not name is still a call. */
  it("falls back to what the call is, never to a blank title", () => {
    expect(callStageTitle(call({ peer: "" }))).toBe("Meeting");
    expect(callStageTitle(call({ kind: "call", peer: "  " }))).toBe("Unknown caller");
  });

  /** One vocabulary for the state of a call, wherever it is drawn: the stage, the mini
   *  window and the ringing card all read the same sentence. */
  it("reuses the call's own phase sentence", () => {
    expect(callStageSubtitle(call({ in_lobby: true }))).toBe("Waiting to be let in…");
    expect(callStageSubtitle(call({ others: ["Ava Thompson"] }))).toBe("With Ava Thompson");
  });

  it("says when the call started, and nothing before audio does", () => {
    const started = Date.UTC(2026, 7, 6, 12, 32);
    expect(callStartClockLabel(call({ connected_at_ms: started }), "en-GB", "UTC")).toBe("12:32");
    expect(callStartClockLabel(call({ connected_at_ms: null }))).toBe("");
  });

  it("puts how long and since when in one sentence, and the phase when there is no clock", () => {
    const started = Date.UTC(2026, 7, 6, 12, 32);
    const title = callStageTimeTitle(call({ connected_at_ms: started }), started + 65_000, "en-GB");
    expect(title).toContain("1:05");
    expect(title).toContain("12:32");
    expect(callStageTimeTitle(call({ phase: "connecting" }), started)).toBe("Joining…");
  });

  it("counts the people the meeting has not let in yet, and says nothing when none wait", () => {
    expect(callStageLobbyLabel(call({ waiting_in_lobby: 0 }))).toBe("");
    expect(callStageLobbyLabel(call({ waiting_in_lobby: 1 }))).toBe(
      "1 person is waiting in the lobby",
    );
    expect(callStageLobbyLabel(call({ waiting_in_lobby: 3 }))).toContain("3 people");
  });
});

describe("who is in the call", () => {
  /** The user is always in it, and always first: a meeting they are alone in still holds
   *  one person, and a list that said "nobody" would be wrong about its own reader. */
  it("puts the user first, whether or not anybody else has arrived", () => {
    const rows = callStageParticipants(call(), { camera: false, sharing: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ you: true, name: "You" });
  });

  it("names the user when the page knows their name", () => {
    const rows = callStageParticipants(call(), {
      name: "Théophile WALLEZ",
      camera: false,
      sharing: false,
    });
    expect(rows[0]?.name).toBe("Théophile WALLEZ (You)");
  });

  it("keeps the roster's own order and drops the rows nobody could read", () => {
    const rows = callStageParticipants(
      call({
        others: ["Ava Thompson", "   ", "Liam Nguyen"],
        other_mris: ["8:orgid:ava", "8:orgid:ghost", "8:orgid:liam"],
      }),
      { camera: false, sharing: false },
    );
    expect(rows.map((row) => row.name)).toEqual(["You", "Ava Thompson", "Liam Nguyen"]);
    expect(rows[1]?.mri).toBe("8:orgid:ava");
    // The MRI travels with the NAME it was aligned with, so a dropped row cannot shift
    // everybody below it onto somebody else's face.
    expect(rows[2]?.mri).toBe("8:orgid:liam");
  });

  /** What somebody is sending comes from the ROSTER, not from the sections this page
   *  happens to have subscribed to: a camera is on for the meeting whether or not this
   *  machine asked to see it. */
  it("reads the camera and the screen off the roster's own streams", () => {
    const rows = callStageParticipants(
      call({
        others: ["Ava Thompson", "Liam Nguyen"],
        other_mris: ["8:orgid:ava", "8:orgid:liam"],
        publishing: [
          publishing("8:orgid:ava", { camera: true }),
          publishing("8:orgid:liam", { sharing: true }),
        ],
      }),
      { camera: false, sharing: false },
    );
    expect(rows[1]).toMatchObject({ camera: true, sharing: false });
    expect(rows[2]).toMatchObject({ camera: false, sharing: true });
  });

  it("says what the user themselves is sending, which no roster reports back", () => {
    const rows = callStageParticipants(call(), { camera: true, sharing: true });
    expect(rows[0]).toMatchObject({ you: true, camera: true, sharing: true });
  });

  it("gives a row a stable key even when the roster named nobody it could resolve", () => {
    const rows = callStageParticipants(call({ others: ["Guest"], other_mris: [""] }), {
      camera: false,
      sharing: false,
    });
    expect(rows[1]?.key).toBe("name:Guest");
  });
});

describe("the chat the stage may show", () => {
  const holds = (id: string) => id === "19:meeting_abc@thread.v2";

  it("is the call's own thread, when this app holds it", () => {
    expect(callStageChatConversation(call(), holds)).toBe("19:meeting_abc@thread.v2");
  });

  /** A meeting joined from a calendar LINK names no thread — the service resolves one
   *  from the code and never tells us — so there is no chat to show and no tab to offer. */
  it("is nothing when the call names no conversation", () => {
    expect(callStageChatConversation(call({ conversation_id: null }), holds)).toBeNull();
    expect(callStageChatConversation(call({ conversation_id: "  " }), holds)).toBeNull();
  });

  /** And nothing when the app does not hold it: this panel renders the app's own thread
   *  in a column, so a conversation the sidebar never synced has nothing behind it. */
  it("is nothing when the app does not hold that conversation", () => {
    expect(callStageChatConversation(call({ conversation_id: "19:other@thread.v2" }), holds)).toBeNull();
  });
});

describe("what the stage draws", () => {
  it("draws nothing at all when nothing is being sent", () => {
    const layout = callStageLayout([], []);
    expect(layout).toMatchObject({ shared: null, tiles: [], ownScreen: null, empty: true });
  });

  /** A screen is the one thing in a call a tile is too small for: it is text, and somebody
   *  shared it because they want it read. Faces read at any size, so they give way. */
  it("gives the whole content to a shared screen and tiles the faces", () => {
    const layout = callStageLayout([remote("1", false), remote("3", true)], []);
    expect(layout.shared?.mid).toBe("3");
    expect(layout.tiles.map((tile) => tile.key)).toEqual(["1"]);
    expect(layout.empty).toBe(false);
  });

  /** The content can only have one subject, so a second share becomes a tile rather than
   *  splitting the stage in half. */
  it("keeps the first shared screen and tiles a second one", () => {
    const layout = callStageLayout([remote("3", true), remote("5", true)], []);
    expect(layout.shared?.mid).toBe("3");
    expect(layout.tiles.map((tile) => tile.key)).toEqual(["5"]);
  });

  /** The user's own camera belongs WITH the faces: it is what they look like to the
   *  meeting, and beside the others is where that comparison is made. */
  it("puts the user's own camera among the faces, last", () => {
    const layout = callStageLayout([remote("1", false)], [local("camera")]);
    expect(layout.tiles.map((tile) => tile.kind)).toEqual(["remote", "local"]);
    expect(layout.empty).toBe(false);
  });

  /** A mirror of one's own screen inside itself is a hall of mirrors — but the only way to
   *  know what the meeting is seeing is to see it too, so it is a corner preview and never
   *  the content. */
  it("never gives the content to the user's own screen, and never drops it", () => {
    const layout = callStageLayout([], [local("screen")]);
    expect(layout.shared).toBeNull();
    expect(layout.tiles).toEqual([]);
    expect(layout.ownScreen?.kind).toBe("screen");
    // It counts as a picture: the stage has something to show, so the avatar card would be
    // wrong.
    expect(layout.empty).toBe(false);
  });
});

describe("the one picture the mini window carries", () => {
  it("prefers a shared screen, then a face, then nothing", () => {
    expect(callMiniPicture(callStageLayout([remote("1", false), remote("3", true)], []))?.key).toBe(
      "3",
    );
    expect(callMiniPicture(callStageLayout([remote("1", false)], []))?.key).toBe("1");
    expect(callMiniPicture(callStageLayout([], []))).toBeNull();
  });

  /** Folding the call away to do something else and being shown yourself would answer the
   *  one question the window is not being asked. */
  it("is never the user's own preview", () => {
    expect(callMiniPicture(callStageLayout([], [local("camera"), local("screen")]))).toBeNull();
  });
});

describe("the mini window's size", () => {
  /** It is a 16:9 picture plus one row of controls, because what it usually carries is
   *  somebody's shared SCREEN — and a thumbnail of a screen full of text says only that a
   *  screen is being shared. */
  it("holds a readable picture rather than a chip", () => {
    expect(DESKTOP_MINI.width).toBe(MINI_WIDTH);
    expect(DESKTOP_MINI.height).toBe(Math.round((MINI_WIDTH * 9) / 16) + MINI_BAR_HEIGHT);
  });

  /** On a phone a 320px window is not a call folded away, it is the app with a hole punched
   *  in it — and folding exists so the conversation underneath can be read. */
  it("takes a share of a phone's screen, and leaves the app visible behind it", () => {
    const phone = miniSize(PHONE);
    expect(phone.width).toBeLessThan(MINI_WIDTH);
    expect(phone.width).toBeGreaterThanOrEqual(MINI_MIN_WIDTH);
    expect(PHONE.width - phone.width).toBeGreaterThan(120);
    // 16:9 plus the bar, at every width: a picture that is not 16:9 is one with black edges.
    expect(phone.height).toBe(Math.round((phone.width * 9) / 16) + MINI_BAR_HEIGHT);
  });

  /** And it never asks for more room than there is: the clamp above can only place a window
   *  that fits. */
  it("never exceeds the room between the margins", () => {
    const tiny = miniSize({ width: 200, height: 300 });
    expect(tiny.width).toBeLessThanOrEqual(200 - 2 * MINI_MARGIN);
  });
});

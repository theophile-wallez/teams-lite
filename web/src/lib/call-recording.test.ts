import { describe, expect, it } from "vitest";
import type { ActiveCall } from "./call";
import type { LocalVideo, RemoteVideo } from "./call-media";
import {
  RECORDING_GAP,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
  RECORD_HINT,
  callCanBeRecorded,
  pickRecordingMimeType,
  recordingBelongsInHistory,
  recordingDrawBox,
  recordingDurationLabel,
  recordingFileName,
  recordingLayout,
  recordingPeopleLabel,
  recordingSizeLabel,
  recordingSources,
  recordingsInConversation,
  recordingsTotalSize,
  recordingSavedMessage,
  type CallRecording,
} from "./call-recording";

function remote(mid: string, sharing = false): RemoteVideo {
  return {
    mid,
    streamMsid: `stream-${mid}`,
    label: sharing ? "applicationsharing-video" : "main-video",
    sharing,
    stream: {} as MediaStream,
  };
}

function local(kind: "camera" | "screen"): LocalVideo {
  return { kind, stream: {} as MediaStream };
}

function call(patch: Partial<ActiveCall> = {}): ActiveCall {
  return {
    id: "call-1",
    direction: "outgoing",
    kind: "call",
    phase: "connected",
    conversation_id: "19:chat@thread.v2",
    peer: "Lucas Silva",
    peer_mri: "8:orgid:lucas",
    others: [],
    other_mris: [],
    in_lobby: false,
    waiting_in_lobby: 0,
    muted: false,
    connected_at_ms: 1,
    end_reason: null,
    publishing: [],
    sending: [],
    can_accept: false,
    can_hangup: true,
    can_send_media: true,
    ...patch,
  };
}

function recording(patch: Partial<CallRecording> = {}): CallRecording {
  return {
    id: "rec-1",
    callId: "call-1",
    conversationId: "19:chat@thread.v2",
    title: "Lucas Silva",
    startedAtMs: Date.UTC(2026, 7, 6, 12, 32),
    endedAtMs: Date.UTC(2026, 7, 6, 12, 34),
    durationMs: 120_000,
    size: 4_500_000,
    mimeType: "video/webm;codecs=vp9,opus",
    participants: ["You", "Lucas Silva"],
    ...patch,
  };
}

describe("what may be recorded", () => {
  it("is a call whose audio is up, and nothing before it", () => {
    expect(callCanBeRecorded(call({ phase: "connected" }))).toBe(true);
    for (const phase of ["ringing", "dialing", "connecting", "ended"] as const) {
      expect(callCanBeRecorded(call({ phase }))).toBe(false);
    }
    expect(callCanBeRecorded(null)).toBe(false);
  });

  it("does not care which kind of call it is: the streams are the same", () => {
    for (const kind of ["call", "group", "meeting"] as const) {
      expect(callCanBeRecorded(call({ kind }))).toBe(true);
    }
  });

  it("says in the words on the control that nobody on the call is told", () => {
    expect(RECORD_HINT).toMatch(/nobody on the call is told/i);
    expect(RECORD_HINT).toMatch(/Teams never sees it/i);
  });
});

describe("the container", () => {
  it("takes the first type the browser really writes", () => {
    expect(pickRecordingMimeType(() => true)).toBe("video/webm;codecs=vp9,opus");
    // A browser without VP9 gets the next one down rather than the plain container.
    expect(pickRecordingMimeType((type) => !type.includes("vp9"))).toBe(
      "video/webm;codecs=vp8,opus",
    );
  });

  it("falls back to letting the browser choose rather than refusing to record", () => {
    expect(pickRecordingMimeType(() => false)).toBe("");
  });
});

describe("what goes into the picture", () => {
  it("puts screens first, so the frame's subject is one of them", () => {
    const sources = recordingSources([remote("2"), remote("3", true)], [local("camera")]);
    expect(sources.map((source) => source.key)).toEqual([
      "remote:3",
      "remote:2",
      "local:camera",
    ]);
  });

  it("keeps the user's own SCREEN, which the stage only previews", () => {
    const sources = recordingSources([], [local("screen"), local("camera")]);
    expect(sources.map((source) => source.key)).toEqual(["local:screen", "local:camera"]);
    expect(sources[0]!.sharing).toBe(true);
  });

  it("prefers a colleague's screen to the user's own as the subject", () => {
    const sources = recordingSources([remote("4", true)], [local("screen")]);
    expect(sources[0]!.key).toBe("remote:4");
  });

  it("mirrors the user's own camera and nothing else", () => {
    const sources = recordingSources([remote("2")], [local("camera"), local("screen")]);
    expect(sources.find((s) => s.key === "local:camera")!.mirrored).toBe(true);
    expect(sources.find((s) => s.key === "local:screen")!.mirrored).toBe(false);
    expect(sources.find((s) => s.key === "remote:2")!.mirrored).toBe(false);
  });

  it("names a source from the roster when the subscription recorded one", () => {
    const sources = recordingSources([remote("2"), remote("3", true)], [], {
      "2": "Ana Costa",
      "3": "Ana Costa",
    });
    expect(sources.map((s) => s.label)).toEqual(["Ana Costa — screen", "Ana Costa"]);
  });

  it("says what a picture IS when nothing named whose it is", () => {
    const sources = recordingSources([remote("2"), remote("3", true)], []);
    expect(sources.map((s) => s.label)).toEqual(["Shared screen", "Camera"]);
  });
});

describe("the layout of one frame", () => {
  const frame = { width: RECORDING_WIDTH, height: RECORDING_HEIGHT };

  it("draws nothing when there is nothing", () => {
    expect(recordingLayout([], frame)).toEqual([]);
  });

  it("gives one source the whole frame", () => {
    const [placement] = recordingLayout(recordingSources([remote("2")], []), frame);
    expect(placement!.rect).toEqual({
      x: RECORDING_GAP,
      y: RECORDING_GAP,
      width: RECORDING_WIDTH - 2 * RECORDING_GAP,
      height: RECORDING_HEIGHT - 2 * RECORDING_GAP,
    });
  });

  it("puts two faces side by side, in one row", () => {
    const places = recordingLayout(recordingSources([remote("2"), remote("3")], []), frame);
    expect(places).toHaveLength(2);
    expect(places[0]!.rect.y).toBe(places[1]!.rect.y);
    expect(places[0]!.rect.x).toBeLessThan(places[1]!.rect.x);
    expect(places[0]!.rect.height).toBe(RECORDING_HEIGHT - 2 * RECORDING_GAP);
  });

  it("puts four faces in a square", () => {
    const places = recordingLayout(
      recordingSources([remote("2"), remote("3"), remote("4"), remote("5")], []),
      frame,
    );
    expect(new Set(places.map((p) => p.rect.y)).size).toBe(2);
    expect(new Set(places.map((p) => p.rect.x)).size).toBe(2);
  });

  it("centres a short last row", () => {
    const places = recordingLayout(
      recordingSources([remote("2"), remote("3"), remote("4")], []),
      frame,
    );
    const last = places[2]!.rect;
    const middleOfLast = last.x + last.width / 2;
    expect(Math.abs(middleOfLast - RECORDING_WIDTH / 2)).toBeLessThanOrEqual(1);
  });

  it("gives a shared screen the frame, and the faces a strip under it", () => {
    const sources = recordingSources([remote("9", true), remote("2"), remote("3")], []);
    const places = recordingLayout(sources, frame);
    const [subject, ...strip] = places;
    expect(subject!.source.sharing).toBe(true);
    expect(subject!.rect.width).toBe(RECORDING_WIDTH - 2 * RECORDING_GAP);
    // The strip sits below the subject, and every face in it is the same height.
    for (const face of strip) {
      expect(face.rect.y).toBeGreaterThan(subject!.rect.y + subject!.rect.height - 1);
      expect(face.rect.height).toBe(strip[0]!.rect.height);
    }
    // And the screen keeps most of the frame.
    expect(subject!.rect.height).toBeGreaterThan(RECORDING_HEIGHT * 0.7);
  });

  it("gives a lone shared screen everything, with no empty strip", () => {
    const places = recordingLayout(recordingSources([remote("9", true)], []), frame);
    expect(places).toHaveLength(1);
    expect(places[0]!.rect.height).toBe(RECORDING_HEIGHT - 2 * RECORDING_GAP);
  });

  it("drops the faces that do not fit the strip rather than slivering them", () => {
    const many = Array.from({ length: 40 }, (_, i) => remote(`m${i}`));
    const places = recordingLayout(recordingSources([remote("9", true), ...many], []), frame);
    const strip = places.slice(1);
    expect(strip.length).toBeGreaterThan(0);
    expect(strip.length).toBeLessThan(many.length);
    for (const face of strip) expect(face.rect.width).toBeGreaterThan(40);
  });

  it("never lays a tile outside the frame", () => {
    for (const count of [1, 2, 3, 5, 7, 9]) {
      const sources = recordingSources(
        Array.from({ length: count }, (_, i) => remote(`m${i}`)),
        [],
      );
      for (const { rect } of recordingLayout(sources, frame)) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(RECORDING_WIDTH);
        expect(rect.y + rect.height).toBeLessThanOrEqual(RECORDING_HEIGHT);
      }
    }
  });
});

describe("how one picture fills its tile", () => {
  const tile = { x: 100, y: 50, width: 640, height: 360 };

  it("fits a screen whole and centres it, so nothing at its edges is lost", () => {
    // A 4:3 screen in a 16:9 tile: the whole picture is drawn, narrower than the tile.
    const box = recordingDrawBox({ width: 1024, height: 768 }, tile, "contain");
    expect(box.source).toEqual({ x: 0, y: 0, width: 1024, height: 768 });
    expect(box.dest.height).toBe(tile.height);
    expect(box.dest.width).toBeLessThan(tile.width);
    expect(box.dest.x + box.dest.width / 2).toBe(tile.x + tile.width / 2);
  });

  it("crops a face to fill its tile", () => {
    const box = recordingDrawBox({ width: 1000, height: 1000 }, tile, "cover");
    expect(box.dest).toEqual(tile);
    // A square picture in a 16:9 tile keeps its full width and loses top and bottom.
    expect(box.source.width).toBe(1000);
    expect(box.source.height).toBeLessThan(1000);
    expect(box.source.y).toBeGreaterThan(0);
  });

  it("survives a picture whose size the browser has not reported yet", () => {
    const box = recordingDrawBox({ width: 0, height: 0 }, tile, "cover");
    expect(box.dest).toEqual(tile);
  });
});

describe("what a recording says about itself", () => {
  it("counts its own length, not the call's", () => {
    expect(recordingDurationLabel(0)).toBe("0:00");
    expect(recordingDurationLabel(7_400)).toBe("0:07");
    expect(recordingDurationLabel(765_000)).toBe("12:45");
    expect(recordingDurationLabel(3_723_000)).toBe("1:02:03");
  });

  it("states a size in the units a person reads", () => {
    expect(recordingSizeLabel(512)).toBe("512 B");
    expect(recordingSizeLabel(831_488)).toBe("812 KB");
    expect(recordingSizeLabel(4_404_019)).toBe("4.2 MB");
    expect(recordingSizeLabel(2_000_000_000)).toBe("1.9 GB");
  });

  it("names the file after the call and the moment", () => {
    const name = recordingFileName(recording(), new Date(Date.UTC(2026, 7, 6, 14, 32)));
    expect(name).toBe("teams-lite-lucas-silva-2026-08-06-1432.webm");
  });

  it("still names a file for a call with no title", () => {
    expect(recordingFileName(recording({ title: "  " }), new Date(Date.UTC(2026, 7, 6, 9, 5)))).toBe(
      "teams-lite-call-2026-08-06-0905.webm",
    );
  });

  it("names the people, and counts a crowd", () => {
    expect(recordingPeopleLabel(recording())).toBe("You, Lucas Silva");
    expect(
      recordingPeopleLabel(recording({ participants: ["You", "A", "B", "C", "D"] })),
    ).toBe("You, A and 3 others");
    expect(recordingPeopleLabel(recording({ participants: [] }))).toBe("");
  });

  it("says where it went, and a link-joined meeting's says Settings", () => {
    expect(recordingSavedMessage(recording())).toMatch(/in this conversation/);
    expect(recordingSavedMessage(recording({ conversationId: null }))).toMatch(
      /Settings › Call recordings/,
    );
  });
});

describe("where a recording is drawn", () => {
  it("belongs to its own conversation and to no other", () => {
    expect(recordingBelongsInHistory(recording(), "19:chat@thread.v2")).toBe(true);
    expect(recordingBelongsInHistory(recording(), "19:other@thread.v2")).toBe(false);
  });

  it("belongs to no conversation at all when the meeting named none", () => {
    expect(recordingBelongsInHistory(recording({ conversationId: null }), "19:chat@thread.v2")).toBe(
      false,
    );
  });

  it("reads a conversation's recordings oldest first, like a history", () => {
    const older = recording({ id: "a", endedAtMs: 10 });
    const newer = recording({ id: "b", endedAtMs: 20 });
    const elsewhere = recording({ id: "c", conversationId: "19:other" });
    const rows = recordingsInConversation([newer, elsewhere, older], "19:chat@thread.v2");
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("adds up what they all cost", () => {
    expect(recordingsTotalSize([recording({ size: 10 }), recording({ size: 32 })])).toBe(42);
  });
});

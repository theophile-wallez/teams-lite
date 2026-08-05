import { describe, expect, it } from "vitest";

import { fromMsSdp, toMsSdp } from "./ms-sdp";

/** What Chrome writes for one audio track over DTLS-SRTP, trimmed to the lines that
 *  matter here. The real thing is longer; nothing else in it is touched. */
const CHROME_OFFER = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS *",
  "m=audio 51234 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126",
  "c=IN IP4 192.0.2.10",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=candidate:1 1 udp 2113937151 192.0.2.10 51234 typ host",
  "a=ice-ufrag:hL0N",
  "a=ice-pwd:PN1CqQeqxYtsVBaCBDpNbn5A",
  "a=fingerprint:sha-256 AB:CD:EF:00:11:22:33:44",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
].join("\r\n");

describe("toMsSdp", () => {
  it("rewrites the transport profile the service refuses", () => {
    // The whole reason this module exists: `conversationEnd 410,
    // UnrecognizedTransportProfile` is what a browser's own profile earns.
    const out = toMsSdp(CHROME_OFFER);
    expect(out).toContain("m=audio 51234 RTP/SAVP 111 63 9 0 8 13 110 126");
    expect(out).not.toContain("UDP/TLS/RTP/SAVPF");
  });

  it("changes nothing else about the blob", () => {
    const out = toMsSdp(CHROME_OFFER).split("\r\n");
    const untouched = CHROME_OFFER.split("\r\n").filter((line) => !line.startsWith("m="));
    // Every line that is not an `m=` line survives, in order. The codecs, the
    // fingerprint, the candidates and the ICE credentials are the browser's own.
    for (const line of untouched) expect(out).toContain(line);
    expect(out).toContain("a=fingerprint:sha-256 AB:CD:EF:00:11:22:33:44");
    expect(out).toContain("a=candidate:1 1 udp 2113937151 192.0.2.10 51234 typ host");
  });

  it("names the media line the way the client does", () => {
    // `getLabel` in the client's own bundle: audio is `main-audio`.
    expect(toMsSdp(CHROME_OFFER)).toContain("a=label:main-audio");
  });

  it("never states a label twice", () => {
    const already = toMsSdp(CHROME_OFFER);
    const twice = toMsSdp(already);
    expect(twice.split("a=label:main-audio")).toHaveLength(2);
  });

  it("keeps the line ending it was given", () => {
    expect(toMsSdp("v=0\nm=audio 1 UDP/TLS/RTP/SAVPF 111")).toBe(
      "v=0\nm=audio 1 RTP/SAVP 111\na=label:main-audio",
    );
  });
});

describe("fromMsSdp", () => {
  it("restores the profile a browser accepts, for a DTLS answer", () => {
    // The service answers in its own spelling, and `setRemoteDescription` refuses it —
    // which would be a call whose signaling all looked fine and carried no audio.
    const answer = [
      "v=0",
      "a=fingerprint:sha-256 99:88:77",
      "m=audio 3478 RTP/SAVP 111",
      "a=setup:active",
    ].join("\r\n");
    expect(fromMsSdp(answer)).toContain("m=audio 3478 UDP/TLS/RTP/SAVPF 111");
  });

  it("reads the fingerprint of the section as well as of the session", () => {
    const answer = ["v=0", "m=audio 3478 RTP/SAVP 111", "a=fingerprint:sha-256 99:88"].join("\r\n");
    expect(fromMsSdp(answer)).toContain("m=audio 3478 UDP/TLS/RTP/SAVPF 111");
  });

  it("falls back to the plain profile when nothing says DTLS", () => {
    const answer = ["v=0", "m=audio 3478 RTP/SAVP 111", "a=crypto:1 AES_CM_128_HMAC_SHA1_80 x"].join(
      "\r\n",
    );
    expect(fromMsSdp(answer)).toContain("m=audio 3478 RTP/SAVPF 111");
  });

  it("leaves a profile it did not write alone", () => {
    const answer = ["v=0", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel"].join("\r\n");
    expect(fromMsSdp(answer)).toContain("m=application 9 UDP/DTLS/SCTP webrtc-datachannel");
  });

  it("undoes what toMsSdp did to the profile", () => {
    const round = fromMsSdp(toMsSdp(CHROME_OFFER));
    expect(round).toContain("m=audio 51234 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126");
  });
});

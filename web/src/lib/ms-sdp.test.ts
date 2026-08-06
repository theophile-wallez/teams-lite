import { describe, expect, it } from "vitest";

import { fromMsSdp, labelsByMid, SHARING_LABEL, toMsSdp } from "./ms-sdp";

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

  it("folds an ICE-TCP candidate's role into its transport", () => {
    const offer = [
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=candidate:1 1 tcp 2105524479 192.0.2.10 9 typ host tcptype active generation 0 network-id 1",
    ].join("\r\n");
    const out = toMsSdp(offer);
    expect(out).toContain("a=candidate:1 1 tcp-act 2105524479 192.0.2.10 9 typ host");
    // …and the three attributes the client strips are gone with it.
    expect(out).not.toContain("tcptype");
    expect(out).not.toContain("generation");
    expect(out).not.toContain("network-id");
  });

  it("leaves a UDP candidate as the browser wrote it", () => {
    const offer = [
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=candidate:1 1 udp 2113937151 192.0.2.10 51234 typ host",
    ].join("\r\n");
    expect(toMsSdp(offer)).toContain("a=candidate:1 1 udp 2113937151 192.0.2.10 51234 typ host");
  });

  it("encodes the two header-extension URIs the service spells with backslashes", () => {
    const offer = [
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
      "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
      "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    ].join("\r\n");
    const out = toMsSdp(offer);
    expect(out).toContain(
      "a=extmap:2 http:\\\\www.webrtc.org\\experiments\\rtp-hdrext\\abs-send-time",
    );
    expect(out).toContain(
      "a=extmap:3 http:\\\\www.ietf.org\\id\\draft-holmer-rmcat-transport-wide-cc-extensions-01",
    );
    // Every other extension is left exactly alone: only those two are spelled this way.
    expect(out).toContain("a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level");
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

  it("unfolds an ICE-TCP candidate a browser cannot parse", () => {
    // The line that really came back, and the whole answer was thrown away for it:
    // "Failed to parse SessionDescription … Unsupported transport type".
    const answer = [
      "v=0",
      "a=fingerprint:sha-256 99:88",
      "m=audio 3478 RTP/SAVP 111",
      "a=candidate:3 1 tcp-pass 18087935 52.115.132.195 3478 typ relay raddr 10.0.16.144 rport 3478",
      "a=candidate:1 1 UDP 54001663 52.115.132.195 3478 typ relay raddr 10.0.16.144 rport 3478",
    ].join("\r\n");
    const out = fromMsSdp(answer);
    expect(out).toContain(
      "a=candidate:3 1 tcp 18087935 52.115.132.195 3478 typ relay raddr 10.0.16.144 rport 3478 tcptype passive",
    );
    expect(out).not.toContain("tcp-pass");
    // A UDP candidate is left exactly as it came, uppercase and all.
    expect(out).toContain("a=candidate:1 1 UDP 54001663 52.115.132.195 3478 typ relay");
  });

  it("knows all three roles, and leaves anything else alone", () => {
    const of = (transport: string) =>
      fromMsSdp(`m=audio 1 RTP/SAVP 111\r\na=candidate:1 1 ${transport} 9 1.2.3.4 5 typ host`);
    expect(of("tcp-act")).toContain("1 1 tcp 9 1.2.3.4 5 typ host tcptype active");
    expect(of("tcp-pass")).toContain("tcptype passive");
    expect(of("tcp-so")).toContain("tcptype so");
    expect(of("udp")).toContain("a=candidate:1 1 udp 9 1.2.3.4 5 typ host");
    expect(of("udp")).not.toContain("tcptype");
  });

  it("promotes the service's IPv6 candidates into real ones", () => {
    // The client merges these before the browser sees the description. Left alone they
    // are an unknown attribute a browser ignores, so a phone on IPv6 would lose them.
    const answer = [
      "m=audio 3478 RTP/SAVP 111",
      "a=x-candidate-ipv6:4 1 tcp-pass 18087935 2603:1063:111::486 3478 typ relay",
    ].join("\r\n");
    const out = fromMsSdp(answer);
    expect(out).toContain(
      "a=candidate:4 1 tcp 18087935 2603:1063:111::486 3478 typ relay tcptype passive",
    );
    expect(out).not.toContain("x-candidate-ipv6");
  });

  it("decodes them again, or Chrome sees two extensions claiming one id", () => {
    // The exact refusal: "RTP extension ID reassignment not supported (collision on
    // active MID 0, id=3 …)" — the encoded uri reads as a different extension.
    const answer = [
      "m=audio 3478 RTP/SAVP 111",
      "a=extmap:3 http:\\\\www.ietf.org\\id\\draft-holmer-rmcat-transport-wide-cc-extensions-01",
    ].join("\r\n");
    expect(fromMsSdp(answer)).toContain(
      "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    );
  });

  it("makes an extmap round trip exactly", () => {
    const line = "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time";
    const sdp = `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n${line}`;
    expect(fromMsSdp(toMsSdp(sdp))).toContain(line);
  });

  it("undoes what toMsSdp did to the profile", () => {
    const round = fromMsSdp(toMsSdp(CHROME_OFFER));
    expect(round).toContain("m=audio 51234 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126");
  });
});

/**
 * The service's own renegotiation offer, trimmed to the lines this reads — measured against
 * the tenant on 2026-08-05 while a colleague shared their screen (NATIVE-CALLING.md
 * § 10.3a). The mids are its own: audio at 0, the shared screen at 3, data at 4.
 */
const SERVICE_OFFER = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "t=0 0",
  "m=audio 3478 RTP/SAVP 111",
  "a=rtpmap:111 opus/48000/2",
  "a=label:main-audio",
  "a=mid:0",
  "m=video 3481 RTP/SAVP 107",
  "a=rtpmap:107 H264/90000",
  "a=label:applicationsharing-video",
  "a=mid:3",
  "a=sendonly",
  "a=x-ssrc-range:8313-8412",
  "m=x-data 3480 RTP/SAVP 127",
  "a=label:data",
  "a=mid:4",
  "",
].join("\r\n");

describe("the labels a section carries", () => {
  it("reads one per mid out of the service's own offer", () => {
    const labels = labelsByMid(SERVICE_OFFER);
    expect(labels.get("0")).toBe("main-audio");
    expect(labels.get("3")).toBe(SHARING_LABEL);
    expect(labels.get("4")).toBe("data");
    expect(labels.size).toBe(3);
  });

  it("finds nothing in an SDP that labels nothing, rather than guessing", () => {
    expect(labelsByMid(CHROME_OFFER).size).toBe(0);
  });

  /**
   * The bug this parameter exists for: a shared screen and a camera are both `m=video`, so a
   * label chosen from the KIND calls somebody's screen `main-video` — and that label is what
   * the service reads to tell the two apart.
   */
  it("puts the offer's own label back on an answer, not the one its kind implies", () => {
    const answer = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "m=video 9 UDP/TLS/RTP/SAVPF 107",
      "a=mid:3",
      "a=recvonly",
      "",
    ].join("\r\n");
    const out = toMsSdp(answer, labelsByMid(SERVICE_OFFER));
    expect(out).toContain("a=label:applicationsharing-video");
    expect(out).not.toContain("a=label:main-video");
    // And with no override the kind decides, which is right for a section we offer.
    expect(toMsSdp(answer)).toContain("a=label:main-video");
  });

  it("never states a label twice, whichever way it was chosen", () => {
    const already = ["m=video 9 UDP/TLS/RTP/SAVPF 107", "a=mid:3", "a=label:main-video", ""].join(
      "\r\n",
    );
    const labels = new Map([["3", SHARING_LABEL]]);
    const out = toMsSdp(already, labels);
    expect(out.match(/a=label:/g)).toHaveLength(1);
  });
});

// The SSRCs a section carries, stated the service's own way. The captured client offer adds
// `a=x-ssrc-range` to every section and keeps `a=ssrc:` beside it (§ 2.5), and the service
// declares one on every section of its own offers.

describe("toMsSdp: the SSRC range", () => {
  const lines = (sdp: string) => sdp.split("\r\n");

  it("states the range beside the browser's own a=ssrc lines", () => {
    const sdp = [
      "v=0",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=ssrc:4195875351 cname:abc",
      "a=ssrc:4195875351 msid:stream track",
      "",
    ].join("\r\n");
    const out = lines(toMsSdp(sdp));
    // ADDED, not substituted: the client keeps both.
    expect(out).toContain("a=x-ssrc-range:4195875351-4195875351");
    expect(out).toContain("a=ssrc:4195875351 cname:abc");
    // One line per section, however many attributes repeat the same id.
    expect(out.filter((l) => l.startsWith("a=x-ssrc-range:")).length).toBe(1);
  });

  it("gives every section its own range", () => {
    const sdp = [
      "v=0",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=ssrc:111 cname:a",
      "m=video 9 UDP/TLS/RTP/SAVPF 107",
      "a=mid:1",
      "a=ssrc:222 cname:b",
      "a=ssrc:333 cname:b",
      "",
    ].join("\r\n");
    const out = lines(toMsSdp(sdp));
    expect(out).toContain("a=x-ssrc-range:111-111");
    // Two SSRCs on one section — a simulcast or an rtx stream — span a range.
    expect(out).toContain("a=x-ssrc-range:222-333");
  });

  it("says nothing for a section that declares no SSRC", () => {
    // A RESERVED section carries no track, so it has no SSRC to state — and a rejected one
    // (port 0) has nothing either.
    const sdp = ["v=0", "t=0 0", "m=video 9 UDP/TLS/RTP/SAVPF 107", "a=mid:1", "a=inactive", ""].join(
      "\r\n",
    );
    expect(toMsSdp(sdp)).not.toContain("x-ssrc-range");
  });

  it("never states one twice", () => {
    // An SDP that already carries the line — one of ours, sent back through — keeps the one
    // it has: two ranges on a section is not the same SDP.
    const sdp = [
      "v=0",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=x-ssrc-range:9-9",
      "a=ssrc:111 cname:a",
      "",
    ].join("\r\n");
    const out = lines(toMsSdp(sdp)).filter((l) => l.startsWith("a=x-ssrc-range:"));
    expect(out).toEqual(["a=x-ssrc-range:9-9"]);
  });
});

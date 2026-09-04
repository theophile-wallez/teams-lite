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

  it("keeps what is the browser's to say", () => {
    const out = toMsSdp(CHROME_OFFER).split("\r\n");
    // The codecs, the fingerprint, the candidates and the ICE credentials are the browser's
    // own and travel exactly as it wrote them. What this module replaces, it replaces because
    // the captured client offer does (§ 2.5): the transport profile, the `c=` line, `a=rtcp:`
    // and `a=msid-semantic:`.
    const ours = ["m=", "c=", "a=rtcp:", "a=msid-semantic:", "b="];
    const untouched = CHROME_OFFER.split("\r\n").filter(
      (line) => !ours.some((prefix) => line.startsWith(prefix)),
    );
    for (const line of untouched) expect(out).toContain(line);
    expect(out).toContain("a=fingerprint:sha-256 AB:CD:EF:00:11:22:33:44");
    expect(out).toContain("a=candidate:1 1 udp 2113937151 192.0.2.10 51234 typ host");
  });

  // The rest of the captured client's own transform (§ 2.5). Audio is accepted without ANY of
  // it, which is why none of it was here — and then every video section this app offered was
  // rejected with no word about why, at two different mids, with the label, the codec list,
  // the SSRC range and the presenter session all in place. So the offer is made to look like
  // the one the service is known to accept, and what remains is measured rather than argued.

  it("states the transport the bundle really runs on, per section", () => {
    // A browser writes the address on the section that carries candidates and `9` /
    // `IN IP4 0.0.0.0` on every other. The client copies the real pair onto each, so a
    // service reading a section's own transport finds one rather than a placeholder.
    const bundled = [
      CHROME_OFFER,
      "m=video 9 UDP/TLS/RTP/SAVPF 107",
      "c=IN IP4 0.0.0.0",
      "a=rtcp:9 IN IP4 0.0.0.0",
      "a=mid:1",
      "a=sendonly",
      "",
    ].join("\r\n");
    const out = toMsSdp(bundled).split("\r\n");
    expect(out).toContain("m=video 51234 RTP/SAVP 107");
    expect(out.filter((line) => line === "c=IN IP4 192.0.2.10").length).toBe(2);
    // The placeholder is gone, in both places it appeared.
    expect(out).not.toContain("c=IN IP4 0.0.0.0");
    expect(out).not.toContain("a=rtcp:9 IN IP4 0.0.0.0");
  });

  it("states a=rtcp on an offer and leaves an ANSWER alone", () => {
    // The client's own `rtcpTransform` writes `{port}` on an offer. An answer is left exactly as
    // the browser wrote it, additions and all: one carrying them was refused by the service
    // three times over (`SdpParsingFailure`), and the capture § 2.5 measured is an OFFER.
    expect(toMsSdp(CHROME_OFFER)).toContain("a=rtcp:51234");
    const answer = CHROME_OFFER.replace("a=setup:actpass", "a=setup:active");
    const out = toMsSdp(answer);
    expect(out).toContain("a=rtcp:9 IN IP4 0.0.0.0");
    expect(out).not.toContain("b=CT:4000");
    // What an answer still does: the profile, the label and the SSRC range.
    expect(out).toContain("RTP/SAVP");
    expect(out).toContain("a=label:main-audio");
  });

  it("reads an offer by its actpass, not by a section's own role", () => {
    // One rejected section carrying `a=setup:active` was enough to make a whole OFFER read as an
    // answer, and every rewrite stood down with it.
    const withRejected = [
      CHROME_OFFER,
      "m=x-data 0 UDP/TLS/RTP/SAVPF 0",
      "c=IN IP4 0.0.0.0",
      "a=setup:active",
      "a=mid:4",
      "",
    ].join("\r\n");
    expect(toMsSdp(withRejected)).toContain("b=CT:4000");
  });

  it("gives every live section one fingerprint, and never two", () => {
    // The client copies the session's onto each section. A section that already carried one
    // must not end up with both, and the count is what says so.
    const two = [
      CHROME_OFFER,
      "m=video 9 UDP/TLS/RTP/SAVPF 107",
      "c=IN IP4 0.0.0.0",
      "a=mid:1",
      "a=sendonly",
      "",
    ].join("\r\n");
    const out = toMsSdp(two).split("\r\n");
    expect(out.filter((line) => line.startsWith("a=fingerprint:")).length).toBe(2);
    // One per section, in the section it belongs to. Split on the `m=` lines and check each
    // half: a count alone would pass with both fingerprints on one section.
    const starts = out.flatMap((line, index) => (line.startsWith("m=") ? [index] : []));
    expect(starts.length).toBe(2);
    for (let i = 0; i < starts.length; i += 1) {
      const section = out.slice(starts[i]!, starts[i + 1] ?? out.length);
      expect(section.filter((line) => line.startsWith("a=fingerprint:")).length).toBe(1);
    }
  });

  it("states the session's own bandwidth and stream token", () => {
    const out = toMsSdp(CHROME_OFFER);
    expect(out).toContain("b=CT:4000");
    // BEFORE `t=`, which is where the grammar puts it. After it the service refuses the whole
    // description: "Unexpected field 'b' found. The field may be undefined or in the wrong
    // order." — the first thing it ever explained, and it cost one live join to hear.
    const lines = out.split("\r\n");
    expect(lines.indexOf("b=CT:4000")).toBeLessThan(lines.findIndex((l) => l.startsWith("t=")));
    // A browser writes `a=msid-semantic: WMS` with no token.
    expect(out).toContain("a=msid-semantic: WMS *");
  });

  it("writes a REJECTED section as the stub the client writes", () => {
    // `Kn(e) = e.port === 0` in the client's own transform: every key but the kind, the port,
    // the profile, the payloads, the mid and the label is deleted, and the payload list becomes
    // `34`. Sending Chrome's whole description for a section it had rejected earned
    // `SdpParsingFailure` and ended the call a second after the answer went out.
    const withRejected = [
      CHROME_OFFER,
      "m=x-data 0 UDP/TLS/RTP/SAVPF 0",
      "c=IN IP4 0.0.0.0",
      "a=rtcp:9 IN IP4 0.0.0.0",
      "a=ice-options:trickle",
      "a=setup:active",
      "a=mid:4",
      "a=rtcp-mux",
      "",
    ].join("\r\n");
    const out = toMsSdp(withRejected, new Map([["4", "data"]])).split("\r\n");
    const at = out.findIndex((line) => line.startsWith("m=x-data"));
    expect(at).toBeGreaterThan(-1);
    expect(out[at]).toBe("m=x-data 0 RTP/SAVP 34");
    // A connection line, its mid and its label — and nothing else. The `c=` is required: the
    // RFC asks for one per media description when the session level has none, and a browser's
    // SDP has none. Without it the service refused the whole answer (`SdpParsingFailure`).
    expect(out.slice(at + 1).filter((line) => line !== "")).toEqual([
      "c=IN IP4 0.0.0.0",
      "a=mid:4",
      "a=label:data",
    ]);
  });

  it("keeps a live section whole while stubbing the rejected one beside it", () => {
    // The stub rule must not reach a section that carries anything: the codecs, the direction
    // and the transport of a live one are the whole point of the description.
    const mixed = [
      CHROME_OFFER,
      "m=video 9 UDP/TLS/RTP/SAVPF 107",
      "c=IN IP4 0.0.0.0",
      "a=mid:3",
      "a=recvonly",
      "a=rtpmap:107 H264/90000",
      "m=x-data 0 UDP/TLS/RTP/SAVPF 0",
      "c=IN IP4 0.0.0.0",
      "a=mid:4",
      "",
    ].join("\r\n");
    const out = toMsSdp(mixed).split("\r\n");
    expect(out).toContain("m=video 51234 RTP/SAVP 107");
    expect(out).toContain("a=rtpmap:107 H264/90000");
    expect(out).toContain("a=recvonly");
    expect(out).toContain("m=x-data 0 RTP/SAVP 34");
  });

  it("says nothing new when no section carries a candidate", () => {
    // A description gathered with no candidates at all: there is nothing truer to copy, so the
    // placeholder stays rather than being replaced by an invention.
    const bare = ["v=0", "t=0 0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", ""].join(
      "\r\n",
    );
    const out = toMsSdp(bare);
    expect(out).toContain("m=audio 9 RTP/SAVP 111");
    expect(out).toContain("c=IN IP4 0.0.0.0");
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

  it("gives every section its own range, over the PRIMARY ssrc alone", () => {
    // Real SSRCs, because that is the whole point: a browser picks them at random, so the span
    // of a media SSRC and its `rtx` companion is meaningless. Measured 2026-09-04, min-to-max
    // produced `a=x-ssrc-range:341013634-993826282` — a claim on 652 million SSRCs — and every
    // video section this app offered was answered with a zeroed port, a camera as much as a
    // screen. The service's own ranges are `1000-1000` and `2403-2502`.
    const sdp = [
      "v=0",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=ssrc:1532221031 cname:a",
      "m=video 9 UDP/TLS/RTP/SAVPF 107",
      "a=mid:1",
      "a=ssrc-group:FID 993826282 341013634",
      "a=ssrc:993826282 cname:b",
      "a=ssrc:341013634 cname:b",
      "",
    ].join("\r\n");
    const out = lines(toMsSdp(sdp));
    // Audio carries one SSRC, so this is byte-for-byte what it always was — and it is the shape
    // the service has accepted on every run.
    expect(out).toContain("a=x-ssrc-range:1532221031-1532221031");
    // The video section states its MEDIA ssrc, not the span across the rtx one.
    expect(out).toContain("a=x-ssrc-range:993826282-993826282");
    expect(out.join("\n")).not.toContain("341013634-993826282");
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

// The header extensions a BUNDLE may carry. Chrome refuses a whole description whose bundled
// sections give one id two meanings — "A BUNDLE group contains a codec collision for header
// extension id=3. The id must be the same across all bundled media descriptions" — and this
// service really does that on the renegotiation that carries a colleague's shared screen
// (measured 2026-08-06). Losing an extension costs a little quality; losing the description
// costs the picture.

describe("fromMsSdp: header extensions across a bundle", () => {
  const offer = (...media: string[]) =>
    ["v=0", "t=0 0", "a=group:BUNDLE 0 3", ...media, ""].join("\r\n");

  it("moves a clashing extension to a free id rather than dropping it", () => {
    // Dropping it was the first fix and it moved the problem: with the extension gone from one
    // section Chrome numbered it freely in its ANSWER — id 2 on audio, id 1 on video — and the
    // service refused THAT with `SdpParsingFailure`. Both measured against the tenant.
    const out = fromMsSdp(
      offer(
        "m=audio 3478 RTP/SAVP 111",
        "a=mid:0",
        "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
        "m=video 3481 RTP/SAVP 107",
        "a=mid:3",
        "a=extmap:3 urn:3gpp:video-orientation",
      ),
    ).split("\r\n");
    // Both survive, on different ids.
    const declared = out.filter((line) => line.startsWith("a=extmap:"));
    expect(declared.length).toBe(2);
    const ids = declared.map((line) => line.slice("a=extmap:".length).split(" ")[0]);
    expect(new Set(ids).size).toBe(2);
    // The first one keeps the id it asked for; the second takes the lowest free one.
    expect(out).toContain(
      "a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
    );
    expect(out).toContain("a=extmap:1 urn:3gpp:video-orientation");
  });

  it("gives one extension ONE id across every section it appears on", () => {
    // The rule Chrome states: "The id must be the same across all bundled media descriptions."
    const out = fromMsSdp(
      offer(
        "m=audio 3478 RTP/SAVP 111",
        "a=mid:0",
        "a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
        "m=video 3481 RTP/SAVP 107",
        "a=mid:3",
        "a=extmap:7 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
      ),
    ).split("\r\n");
    const ids = out
      .filter((line) => line.includes("abs-send-time"))
      .map((line) => line.slice("a=extmap:".length).split(" ")[0]);
    expect(ids).toEqual(["2", "2"]);
  });

  it("never leaves one id meaning two things", () => {
    const out = fromMsSdp(
      offer(
        "m=audio 3478 RTP/SAVP 111",
        "a=mid:0",
        "a=extmap:3 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        "m=video 3481 RTP/SAVP 107",
        "a=mid:3",
        "a=extmap:3 urn:3gpp:video-orientation",
        "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
      ),
    ).split("\r\n");
    const byId = new Map<string, Set<string>>();
    for (const line of out.filter((l) => l.startsWith("a=extmap:"))) {
      const rest = line.slice("a=extmap:".length);
      const at = rest.indexOf(" ");
      const id = rest.slice(0, at).split("/")[0]!;
      const uri = rest.slice(at + 1);
      byId.set(id, (byId.get(id) ?? new Set()).add(uri));
    }
    for (const [id, uris] of byId) expect(uris.size, `id ${id}`).toBe(1);
  });

  it("keeps the SAME extension repeated on every section", () => {
    // Agreeing sections are the normal case and must be left alone: an extension declared
    // identically on each is exactly what the bundle rule asks for.
    const out = fromMsSdp(
      offer(
        "m=audio 3478 RTP/SAVP 111",
        "a=mid:0",
        "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
        "m=video 3481 RTP/SAVP 107",
        "a=mid:3",
        "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid",
      ),
    ).split("\r\n");
    expect(out.filter((line) => line.startsWith("a=extmap:4 ")).length).toBe(2);
  });

  it("reads an id with a direction suffix as the same id", () => {
    // `a=extmap:3/sendonly <uri>` is id 3. Reading it as a different one would let the very
    // collision this exists to stop straight through.
    const out = fromMsSdp(
      offer(
        "m=audio 3478 RTP/SAVP 111",
        "a=mid:0",
        "a=extmap:3 urn:ietf:params:rtp-hdrext:ssrc-audio-level",
        "m=video 3481 RTP/SAVP 107",
        "a=mid:3",
        "a=extmap:3/sendonly urn:3gpp:video-orientation",
      ),
    ).split("\r\n");
    expect(out.filter((line) => line.startsWith("a=extmap:3")).length).toBe(1);
  });

  it("resolves the MS spelling before it compares", () => {
    // The service writes two URIs with backslashes. Restored first, they are the SAME extension
    // as the slashed form — so comparing before the rewrite would drop a line that agreed.
    const uri = "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time";
    const out = fromMsSdp(
      offer(
        "m=audio 3478 RTP/SAVP 111",
        "a=mid:0",
        `a=extmap:2 ${uri}`,
        "m=video 3481 RTP/SAVP 107",
        "a=mid:3",
        `a=extmap:2 ${uri.replace(/\//g, "\\")}`,
      ),
    ).split("\r\n");
    expect(out.filter((line) => line === `a=extmap:2 ${uri}`).length).toBe(2);
  });
});

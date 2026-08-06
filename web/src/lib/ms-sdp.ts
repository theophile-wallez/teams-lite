/**
 * The one difference between a browser's SDP and the one Teams' calling service reads.
 *
 * `application/sdp-ngc-1.0` is a LABEL on ordinary WebRTC SDP — that part of
 * NATIVE-CALLING.md holds — but the label is not the whole story: the web client passes
 * every offer through `toMsSdp` on the way out and `fromMsSdp` on the way back, and the
 * service refuses what has not been through it. The refusal names itself, which is how
 * this was found:
 *
 *     conversationEnd 410 — "UnrecognizedTransportProfile: Unrecognized transport profile"
 *
 * The transport profile is the third token of an `m=` line. Chrome writes
 * `UDP/TLS/RTP/SAVPF`; the client rewrites every media line to `RTP/SAVP`
 * (`PROFILES.rtpSavp` in its own bundle) and the service answers in the same spelling.
 * Chrome will not accept that answer, so the return direction has to be undone as well —
 * `UDP/TLS/RTP/SAVPF` when the section carries a DTLS fingerprint, `RTP/SAVPF` when it
 * does not, which is exactly the branch the client's own `fromMsSdp` takes.
 *
 * These are pure string functions and they live beside `call-media.ts` for one reason:
 * the browser is the only place that ever looks inside an SDP. The backend passes the
 * blob through untouched (see `src/calling.rs`), so a rewrite there would be a second
 * place that has to know this, and the one that got forgotten is the bug.
 */

/** The profile the calling service reads, on every media line it is given. */
const MS_PROFILE = "RTP/SAVP";

/** What a browser writes when the transport is DTLS-SRTP. */
const WEBRTC_DTLS_PROFILE = "UDP/TLS/RTP/SAVPF";

/** What a browser writes when it is not: SDES, or a profile with no transport. */
const WEBRTC_PLAIN_PROFILE = "RTP/SAVPF";

/**
 * The label the client gives each kind of media line (`getLabel` in its own bundle).
 *
 * **A kind is not enough to choose one, and that is why {@link toMsSdp} takes an override.**
 * A shared screen and a camera are both `m=video`; only the label tells them apart, and the
 * service reads it — its own test for an incoming share is
 * `direction === "sendonly" && label === "applicationsharing-video"`. So this table is the
 * DEFAULT for a section this app is offering itself, and an answer to the service's own
 * offer echoes the label that offer stated (see {@link labelsByMid}).
 */
const MEDIA_LABELS: Record<string, string> = {
  audio: "main-audio",
  video: "main-video",
};

/** The label a shared screen's section carries, in both directions. */
export const SHARING_LABEL = "applicationsharing-video";

/**
 * Read `a=label:` per `a=mid:` out of an SDP.
 *
 * Used on the service's own offer so an answer can put each label back where it came from:
 * the service names mid 3 `applicationsharing-video`, and an answer that called it
 * `main-video` would be describing a different stream on the section it was handed.
 */
export function labelsByMid(sdp: string): Map<string, string> {
  const out = new Map<string, string>();
  let label: string | null = null;
  let mid: string | null = null;
  const flush = () => {
    if (mid && label) out.set(mid, label);
    label = null;
    mid = null;
  };
  for (const line of splitLines(sdp).lines) {
    if (line.startsWith("m=")) flush();
    else if (line.startsWith("a=label:")) label = line.slice("a=label:".length).trim();
    else if (line.startsWith("a=mid:")) mid = line.slice("a=mid:".length).trim();
  }
  flush();
  return out;
}

/**
 * The labels of the sections an SDP REJECTS — the ones whose `m=` line carries port 0.
 *
 * That is how the far side says a section is gone: it answers, or offers, with the section
 * still written down and its port zeroed. The browser reads it and STOPS the transceiver, so
 * the live path never needs this (it asks the transceiver, which is the authoritative
 * answer). What needs it is the simulated media, which has no transceivers at all and is the
 * only place that failure can be reviewed with nothing leaving the machine.
 */
export function rejectedLabels(sdp: string): Set<string> {
  const out = new Set<string>();
  let rejected = false;
  let label: string | null = null;
  const flush = () => {
    if (rejected && label) out.add(label);
    label = null;
  };
  for (const line of splitLines(sdp).lines) {
    if (line.startsWith("m=")) {
      flush();
      // `m=<kind> <port> <profile> …` — a zero port is the rejection.
      rejected = line.split(" ")[1] === "0";
    } else if (line.startsWith("a=label:")) label = line.slice("a=label:".length).trim();
  }
  flush();
  return out;
}

/**
 * How the two sides spell an ICE-TCP candidate's role — the client's own
 * `tcpTypeMapping`, verbatim.
 *
 * A browser writes the transport as `tcp` and states the role in a separate `tcptype`
 * attribute; the service folds the role INTO the transport. Chrome does not merely ignore
 * the folded spelling, it refuses the whole description:
 *
 *     Failed to parse SessionDescription.
 *     a=candidate:3 1 tcp-pass 18087935 … typ relay …
 *     Unsupported transport type
 *
 * One line out of forty, and the answer is thrown away whole — which looked exactly like
 * a join that connected and then hung up on its own.
 */
const TCP_TYPES: ReadonlyArray<{ jsep: string; ms: string }> = [
  { jsep: "active", ms: "tcp-act" },
  { jsep: "passive", ms: "tcp-pass" },
  { jsep: "so", ms: "tcp-so" },
];

/**
 * Attributes a browser adds to its own candidates and the service is never sent.
 *
 * `transformCandidate` in the client's bundle deletes exactly these three before a
 * candidate goes out.
 */
const CANDIDATE_EXTRAS = ["generation", "network-id", "network-cost"];

/** Rewrite one `a=candidate:` line into the service's spelling. */
function candidateToMs(line: string): string {
  const fields = line.slice("a=candidate:".length).split(" ");
  // `<foundation> <component> <transport> <priority> …` — the transport is the third.
  const transport = fields[2]?.toLowerCase();
  if (transport === "tcp") {
    const at = fields.findIndex((f) => f === "tcptype");
    const role = at >= 0 ? fields[at + 1] : undefined;
    const folded = TCP_TYPES.find((t) => t.jsep === role);
    if (folded) {
      fields[2] = folded.ms;
      fields.splice(at, 2);
    }
  }
  return `a=candidate:${withoutExtras(fields).join(" ")}`;
}

/** Rewrite one `a=candidate:` line back into what a browser can parse. */
function candidateFromMs(line: string): string {
  const fields = line.slice("a=candidate:".length).split(" ");
  const folded = TCP_TYPES.find((t) => t.ms === fields[2]?.toLowerCase());
  if (!folded) return line;
  fields[2] = "tcp";
  fields.push("tcptype", folded.jsep);
  return `a=candidate:${fields.join(" ")}`;
}

/**
 * The two RTP header-extension URIs the service spells with BACKSLASHES.
 *
 * `MSSDP_ENCODED_URI: uri.replace(/\//g, "\\")` in the client's own bundle — every slash,
 * and only for these two. Chrome does not ignore the difference: it reads the encoded form
 * as a DIFFERENT extension claiming an id it already gave the real one, and refuses the
 * answer outright:
 *
 *     Failed to set remote answer sdp: RTP extension ID reassignment not supported
 *     (collision on active MID 0, id=3, old_uri="http://www.ietf.org/id/draft-holmer-…",
 *      new_uri="http:\\www.ietf.org\id\draft-holmer-…")
 *
 * The list is exactly the client's. A third extension spelled this way would have to be
 * added here — a blanket "turn every backslash into a slash" would rewrite attributes
 * this module has no business touching.
 */
const ENCODED_EXTENSIONS = [
  "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
  "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
].map((uri) => ({ jsep: uri, ms: uri.replace(/\//g, "\\") }));

/** Rewrite one `a=extmap:` line in either direction. */
function extmap(line: string, to: "ms" | "jsep"): string {
  for (const { jsep, ms } of ENCODED_EXTENSIONS) {
    const from = to === "ms" ? jsep : ms;
    const into = to === "ms" ? ms : jsep;
    if (line.endsWith(` ${from}`)) return `${line.slice(0, -from.length)}${into}`;
  }
  return line;
}

/** Drop the trailing `key value` pairs the service is never sent. */
function withoutExtras(fields: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    if (CANDIDATE_EXTRAS.includes(fields[i] ?? "")) {
      i += 1; // and its value
      continue;
    }
    out.push(fields[i] as string);
  }
  return out;
}

/** The session bandwidth the captured client offer states (`b=CT:4000`, § 2.5). */
const SESSION_BANDWIDTH_KBPS = 4000;

/**
 * The port and `c=` line the BUNDLE really runs on: the first section that carries candidates.
 *
 * A browser writes the real address on that section alone and `9` / `IN IP4 0.0.0.0` on every
 * other one; the client copies the real pair onto each, so a service reading a section's own
 * transport finds one. Nothing is returned when no section carries a candidate — there is then
 * nothing truer to copy, and a placeholder is better than an invention.
 */
function bundleTransport(lines: string[]): { port: string; connection: string } | null {
  let port: string | null = null;
  let connection: string | null = null;
  let candidates = false;
  for (const line of lines) {
    const media = readMediaLine(line);
    if (media) {
      if (candidates && port && connection) break;
      port = media.port;
      connection = null;
      candidates = false;
      continue;
    }
    if (line.startsWith("c=")) connection = line.slice(2).trim();
    if (line.startsWith("a=candidate:")) candidates = true;
  }
  if (!candidates || !port || !connection || port === "0" || port === "9") return null;
  return { port, connection };
}

/**
 * Whether this description is an ANSWER, which is what decides `a=rtcp:`.
 *
 * An answer states the setup role it TOOK — `active` or `passive` — while an offer offers
 * `actpass`. It is the one signal inside the blob itself, and this module is only ever handed
 * the blob.
 */
function isAnswer(lines: string[]): boolean {
  return lines.some((line) => line === "a=setup:active" || line === "a=setup:passive");
}

/** One `m=` line, split into the pieces this module cares about. */
type MediaLine = { kind: string; head: string; port: string; profile: string; tail: string };

/** Read an `m=` line, or nothing when the line is not one. */
function readMediaLine(line: string): MediaLine | null {
  if (!line.startsWith("m=")) return null;
  // `m=<kind> <port> <profile> <payloads…>` — the profile is the third field, and the
  // payload list may be empty on a rejected section.
  const match = /^m=(\S+) (\S+) (\S+)(.*)$/.exec(line);
  const [, kind, port, profile, tail] = match ?? [];
  if (!kind || !port || !profile) return null;
  return { kind, head: `m=${kind} ${port}`, port, profile, tail: tail ?? "" };
}

/** Write an `m=` line back with a different profile. */
function withProfile(media: MediaLine, profile: string): string {
  return `${media.head} ${profile}${media.tail}`;
}

/** Write it back with the service's profile and the port the bundle really runs on. */
function withPort(media: MediaLine, port: string): string {
  return `m=${media.kind} ${port} ${MS_PROFILE}${media.tail}`;
}

/** Split an SDP into its lines, keeping the line ending the sender used.
 *
 *  An SDP is CRLF-delimited by the RFC and every browser writes it that way, but a
 *  service that answered with bare LF must not have its answer mangled — so the ending
 *  is read rather than assumed. */
function splitLines(sdp: string): { lines: string[]; ending: string } {
  const ending = sdp.includes("\r\n") ? "\r\n" : "\n";
  return { lines: sdp.split(/\r?\n/), ending };
}

/**
 * Rewrite a browser's offer or answer into what the calling service reads.
 *
 * Three changes, all of them the client's own: every media line's profile becomes
 * `RTP/SAVP`, a media line with no `a=label:` gets one — from `labels` when the caller has an
 * offer to echo, and from the section's kind otherwise — and each section states the SSRCs it
 * carries as `a=x-ssrc-range`. Everything else — the codecs, the fingerprint, the candidates,
 * the ICE credentials — travels exactly as the browser wrote it.
 *
 * The range is ADDED beside `a=ssrc:` rather than replacing it, which is what the captured
 * client offer shows (§ 2.5: "ADDED (the `a=ssrc:` line stays too)"). Audio is accepted
 * without it, so it is not what makes a section work — but the service declares one on every
 * section of its OWN offers, and a send section it must allocate a channel for is the place
 * that would notice. It costs one line per section.
 *
 * `labels` is what makes a shared screen possible at all: it and a camera are both
 * `m=video`, so an answer built from kinds alone labels somebody's screen `main-video` and
 * describes the wrong stream on the section it was handed.
 */
export function toMsSdp(sdp: string, labels?: Map<string, string>): string {
  const { lines, ending } = splitLines(sdp);
  const out: string[] = [];
  // The session's own fingerprint, and the transport the BUNDLE really runs on. A browser
  // writes candidates on the first section only and gives every other one the placeholder
  // `9` / `IN IP4 0.0.0.0`; the client copies the real port and `c=` line onto each
  // (`transformBundle`) and copies the session fingerprint onto every live section. Both are
  // read before anything is written, because they live above the sections that need them.
  const fingerprint = lines.find((line) => line.startsWith("a=fingerprint:"));
  const transport = bundleTransport(lines);
  const answering = isAnswer(lines);
  // The section being read, so a label can be added at its end rather than guessed at
  // its start: `a=label` may already be there, and stating it twice is not the same SDP.
  // Its mid is read on the way through, because the override is keyed by mid and an
  // `a=mid:` line comes after the `m=` line it belongs to.
  let section: {
    kind: string;
    hasLabel: boolean;
    mid: string | null;
    /** Every SSRC the section declares, for the range below. */
    ssrcs: number[];
    hasSsrcRange: boolean;
  } | null = null;

  const closeSection = () => {
    if (!section) return;
    // The override first: on an ANSWER the service has already said what each section is,
    // and a shared screen is an `m=video` whose kind cannot tell us.
    const label =
      (section.mid ? labels?.get(section.mid) : undefined) ?? MEDIA_LABELS[section.kind];
    if (label && !section.hasLabel) out.push(`a=label:${label}`);
    // The SSRCs the section carries, stated the service's own way. `a=ssrc:` stays exactly
    // where the browser wrote it — the client ADDS this line rather than replacing them.
    if (section.ssrcs.length > 0 && !section.hasSsrcRange) {
      const low = Math.min(...section.ssrcs);
      const high = Math.max(...section.ssrcs);
      out.push(`a=x-ssrc-range:${low}-${high}`);
    }
    section = null;
  };

  for (const line of lines) {
    const media = readMediaLine(line);
    if (media) {
      closeSection();
      section = { kind: media.kind, hasLabel: false, mid: null, ssrcs: [], hasSsrcRange: false };
      // A REJECTED section keeps its own port: zero is the whole statement, and the client
      // describes no transport for one either.
      const rejected = media.port === "0";
      out.push(
        rejected || !transport ? withProfile(media, MS_PROFILE) : withPort(media, transport.port),
      );
      if (!rejected && transport) {
        out.push(`c=${transport.connection}`);
        // `a=rtcp:<port>` on an OFFER and nothing on an answer — the client's own
        // `rtcpTransform`. A browser writes `a=rtcp:9 IN IP4 0.0.0.0`, which names a
        // placeholder rather than the port the section really runs on.
        if (!answering) out.push(`a=rtcp:${transport.port}`);
      }
      if (!rejected && fingerprint) out.push(fingerprint);
      continue;
    }
    // The lines just replaced: a browser's own `c=` restates the placeholder and its
    // `a=rtcp:` names one too, and the session fingerprint is now stated per section, so a
    // section's own copy would state it twice.
    if (section && transport && (line.startsWith("c=") || line.startsWith("a=rtcp:"))) continue;
    if (section && fingerprint && line.startsWith("a=fingerprint:")) continue;
    // A trailing empty line ends the last section without belonging to it.
    if (line === "") {
      closeSection();
      out.push(line);
      continue;
    }
    if (section && line.startsWith("a=mid:")) section.mid = line.slice("a=mid:".length).trim();
    if (section && line.startsWith("a=label:")) section.hasLabel = true;
    if (section && line.startsWith("a=x-ssrc-range:")) section.hasSsrcRange = true;
    if (section && line.startsWith("a=ssrc:")) {
      // `a=ssrc:<id> <attribute>` — one id, repeated once per attribute it carries.
      const id = Number.parseInt(line.slice("a=ssrc:".length), 10);
      if (Number.isFinite(id) && !section.ssrcs.includes(id)) section.ssrcs.push(id);
    }
    // The session's own two lines, in the client's spelling. `WMS *` is what it writes where
    // a browser writes `WMS` with no token, and `b=CT` is the session bandwidth it adds — a
    // video section the service must allocate for is where an absence would tell.
    if (!section && line.startsWith("a=msid-semantic:")) {
      out.push("a=msid-semantic: WMS *");
      continue;
    }
    // BEFORE `t=`, which is where the grammar puts a session bandwidth and where the captured
    // client offer has it. After it, the service refuses the whole description by name:
    // `SdpParsingError … Unexpected field 'b' found. The field may be undefined or in the wrong
    // order.` — measured 2026-08-06, and the first thing this service ever explained.
    if (!section && line.startsWith("t=")) {
      out.push(`b=CT:${SESSION_BANDWIDTH_KBPS}`);
      out.push(line);
      continue;
    }
    if (!section && line.startsWith("b=")) continue;
    if (line.startsWith("a=candidate:")) {
      out.push(candidateToMs(line));
      continue;
    }
    if (line.startsWith("a=extmap:")) {
      out.push(extmap(line, "ms"));
      continue;
    }
    out.push(line);
  }
  closeSection();
  return out.join(ending);
}

/**
 * Undo it, so a browser can read the service's answer.
 *
 * `RTP/SAVP` is not a profile Chrome accepts for a DTLS-SRTP session, so an answer left
 * as it arrived is rejected by `setRemoteDescription` and the call carries no audio while
 * every signaling step looks fine. Which profile to restore is decided per section by
 * whether it carries a fingerprint, exactly as the client's own transform decides it.
 */
export function fromMsSdp(sdp: string): string {
  const { lines, ending } = splitLines(sdp);
  const out: string[] = [];
  // Where each section starts, so its own lines can be scanned for a fingerprint.
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("m=")) starts.push(index);
  });
  // The fingerprint may be stated once for the whole session or once per section, and it
  // is what says the transport is DTLS. Session level is everything before the first
  // `m=` line, so it is a slice rather than a search: two identical lines in one SDP
  // must not both resolve to the first one.
  const firstMedia = starts[0] ?? lines.length;
  const sessionHasFingerprint = lines
    .slice(0, firstMedia)
    .some((line) => line.startsWith("a=fingerprint:"));

  const sectionHasFingerprint = (start: number): boolean => {
    const next = starts.find((s) => s > start) ?? lines.length;
    for (let i = start + 1; i < next; i += 1) {
      if (lines[i]?.startsWith("a=fingerprint:")) return true;
    }
    return false;
  };

  lines.forEach((line, index) => {
    if (line.startsWith("a=candidate:")) {
      out.push(candidateFromMs(line));
      return;
    }
    // The service lists IPv6 candidates under a name of its own; the client's
    // `candidateTransform.fromMsSdp` merges them into `candidates` before the browser
    // ever sees the description, so an answer that reaches a phone on IPv6 has somewhere
    // to connect. Anything else it cannot parse would be an unknown attribute, which a
    // browser ignores — this one has to become a candidate or it is simply lost.
    if (line.startsWith("a=x-candidate-ipv6:")) {
      out.push(candidateFromMs(`a=candidate:${line.slice("a=x-candidate-ipv6:".length)}`));
      return;
    }
    if (line.startsWith("a=extmap:")) {
      out.push(extmap(line, "jsep"));
      return;
    }
    const media = readMediaLine(line);
    if (!media) {
      out.push(line);
      return;
    }
    // A section the service rejected keeps whatever it says: port 0 negotiates nothing,
    // and rewriting it would claim a transport for a stream that does not exist.
    if (media.profile !== MS_PROFILE) {
      out.push(line);
      return;
    }
    const dtls = sessionHasFingerprint || sectionHasFingerprint(index);
    out.push(withProfile(media, dtls ? WEBRTC_DTLS_PROFILE : WEBRTC_PLAIN_PROFILE));
  });
  return out.join(ending);
}

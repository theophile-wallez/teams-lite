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

/** The label the client gives each kind of media line (`getLabel` in its own bundle). */
const MEDIA_LABELS: Record<string, string> = {
  audio: "main-audio",
  video: "main-video",
};

/** One `m=` line, split into the pieces this module cares about. */
type MediaLine = { kind: string; head: string; profile: string; tail: string };

/** Read an `m=` line, or nothing when the line is not one. */
function readMediaLine(line: string): MediaLine | null {
  if (!line.startsWith("m=")) return null;
  // `m=<kind> <port> <profile> <payloads…>` — the profile is the third field, and the
  // payload list may be empty on a rejected section.
  const match = /^m=(\S+) (\S+) (\S+)(.*)$/.exec(line);
  const [, kind, port, profile, tail] = match ?? [];
  if (!kind || !port || !profile) return null;
  return { kind, head: `m=${kind} ${port}`, profile, tail: tail ?? "" };
}

/** Write an `m=` line back with a different profile. */
function withProfile(media: MediaLine, profile: string): string {
  return `${media.head} ${profile}${media.tail}`;
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
 * Two changes, both of them the client's own: every media line's profile becomes
 * `RTP/SAVP`, and a media line with no `a=label:` gets the one for its kind. Everything
 * else — the codecs, the fingerprint, the candidates, the ICE credentials — travels
 * exactly as the browser wrote it.
 */
export function toMsSdp(sdp: string): string {
  const { lines, ending } = splitLines(sdp);
  const out: string[] = [];
  // The section being read, so a label can be added at its end rather than guessed at
  // its start: `a=label` may already be there, and stating it twice is not the same SDP.
  let section: { kind: string; hasLabel: boolean } | null = null;

  const closeSection = () => {
    if (!section) return;
    const label = MEDIA_LABELS[section.kind];
    if (label && !section.hasLabel) out.push(`a=label:${label}`);
    section = null;
  };

  for (const line of lines) {
    const media = readMediaLine(line);
    if (media) {
      closeSection();
      section = { kind: media.kind, hasLabel: false };
      out.push(withProfile(media, MS_PROFILE));
      continue;
    }
    // A trailing empty line ends the last section without belonging to it.
    if (line === "") {
      closeSection();
      out.push(line);
      continue;
    }
    if (section && line.startsWith("a=label:")) section.hasLabel = true;
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

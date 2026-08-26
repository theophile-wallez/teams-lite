/**
 * THE TRAILING LINE A FEATURE SIGNS A MESSAGE BODY WITH, TAKEN OFF A PREVIEW — for every feature
 * that signs one, in ONE spelling.
 *
 * A game of chess and a companion are each carried by ordinary Teams messages whose last block is
 * `— <keyword> <6 lowercase hex> <payload>, via teams-lite`, read from the WORDS rather than from
 * markup. No surface that shows a message as a LINE OF TEXT may show that line: a chat row, a
 * channel row, and the page's own desktop notification all go through here, and the two features
 * used to hold a near-identical copy of the rule apiece. This module exists because that is where
 * the third feature's copy drifts — and it already had: the cut rules below were fixed in Rust and
 * on one of the two page copies, leaving the other showing a wire dump. It is the twin of
 * `push_policy::without_wire_line`, which serves a PUSH the same way and for the same reason (a
 * push has no page to strip on its behalf).
 *
 * **IT RE-VALIDATES THE TAIL BEFORE CUTTING**, never just cuts at the marker: a naive
 * `split(marker)[0]` truncates a real message that happens to contain the words. So the LAST
 * occurrence of the marker is found and then what follows it has to be a line — which is what
 * keeps an agent's own `— claude, via teams-lite` and a colleague's prose intact.
 *
 * **THREE SHAPES COUNT AS ONE, because a preview is the body's first 120 characters** and a record
 * is one message rewritten on every act (`teams_read::preview_from_html`): a WHOLE line, one whose
 * PAYLOAD the cut broke, and one whose ID the cut landed inside. Each feature's own measured
 * crossing points are on its own strip; what matters here is that all three arrive in practice and
 * a rule holding only the first does nothing at all for a record anybody has used.
 *
 * **THE TWO CUT RULES' PROOF IS WEAKER THAN THE WHOLE LINE'S, and both costs are nil-probability
 * rather than impossible.** What is left structurally is the marker, hex, and the cut. On the
 * PAYLOAD rule that is a six-character all-hex word, and English has those (`facade`, `decade`,
 * `deface`, `beaded`), so `"…— pet facade beats…"` is cut. On the ID rule it is **any hex-initial
 * word** — it fires at one character, so roughly 30% of English words by initial letter reach it
 * against roughly 0.5% for a full six-hex word, which is a widening of some 60x rather than of one
 * notch: `"…thanks ever — pet b…"` is cut, and so would `cage`, `bed`, `dish`, `food` and `bowl`
 * be, all of which a colleague could plainly write about a pet. The improbable part is the CUT
 * landing inside that 1–6 character window rather than the words. And an author's own trailing
 * ellipsis is indistinguishable from the preview's cut marker, so both rules fire on an
 * untruncated message that simply ends in one. None of them loses a message: the cost is a
 * trailing clause, which is what makes the trade acceptable.
 *
 * **CASE: LOWERCASE ONLY, in both languages.** A real id is `toString(16)`, so it can only ever be
 * lowercase — and Rust's `is_lower_hex` decides the same question the same way. Case-insensitive
 * here would therefore never admit a real ledger and only ever widen the prose paths above, and it
 * was unpinned in both directions until a test named it. Each feature's own `whole` pattern keeps
 * whatever case rule it already had: that grammar is the feature's, and it is also the branch prose
 * cannot reach.
 */

/** The PAYLOAD was cut: a whole id, a space, and then whatever fitted before the cut marker.
 *  LOWERCASE, matching Rust's `is_lower_hex` — see the case rule above. */
const PAYLOAD_CUT = /^[0-9a-f]{6}\s+.*…$/;

/** The ID ITSELF was cut: only hex, then the cut marker, and no payload at all. Measured on chess —
 *  words of 104–108 characters put the 120th code point inside the id, and 8 of 48 realistic
 *  engine-game ledgers landed there, leaking the marker fragment onto the row. LOWERCASE, for the
 *  reason above; the trailing space is unreachable from a real preview (`preview_from_html` trims
 *  before it appends the `…`) and is kept because it costs nothing and the rule is about the shape. */
const ID_CUT = /^[0-9a-f]{1,6} ?…$/;

/**
 * `text` with its trailing wire line removed, or `text` unchanged when the tail is not one.
 *
 * `marker` is the feature's own `— <keyword> ` — passed rather than merged, because which keyword a
 * body carries is exactly what tells the features apart. `whole` is that feature's own whole-line
 * pattern, which is where its version and payload grammar live.
 */
export function withoutSignedLine(text: string, marker: string, whole: RegExp): string {
  const at = text.lastIndexOf(marker);
  if (at < 0) return text;
  const tail = text.slice(at).trim();
  const rest = tail.slice(marker.length);
  if (!whole.test(tail) && !PAYLOAD_CUT.test(rest) && !ID_CUT.test(rest)) return text;
  return text.slice(0, at).trim();
}

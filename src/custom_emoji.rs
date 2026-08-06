//! Custom emoji substitution: turning `:shipit:` in outbound message text into the
//! inline emoji markup Teams renders.
//!
//! A custom emoji reaches the wire as the literal text `:shipit:`, and the backend
//! substitutes the markup on the way out. That is deliberate — the app's `edit` path
//! sends plain text only, so an emoji living in composer markup would be destroyed by
//! every edit, and Slack renders a hand-typed `:shipit:` too. The nearest precedent
//! in this codebase is the agent tag (web/src/components/agent-tag-extension.ts and
//! src/agent_policy.rs::split_prefix): a chip in the composer, bare text on the wire,
//! read back by the backend.
//!
//! Two regions are skipped: `<code>` and `<pre>` (because Slack does not render an
//! emoji inside code either), and reply quotes (which hold a colleague's own words —
//! substituting our art into them would rewrite what they wrote).

/// The largest custom emoji this app accepts, in bytes. Slack's limit, copied
/// deliberately. Nothing here re-encodes, so an image over the limit is refused
/// rather than scaled — the cap is a contract, not a hint.
pub const MAX_CUSTOM_EMOJI_BYTES: usize = 128 * 1024;

/// The widest or tallest emoji accepted, in pixels. Slack's limit, copied
/// deliberately. An image over the limit is refused rather than scaled.
pub const MAX_CUSTOM_EMOJI_DIMENSION: u32 = 512;

/// MIME types accepted for custom emoji. Slack's set, copied deliberately. SVG is
/// excluded because an emoji is a bitmap, not a document — these bytes come back out
/// of this app inside an `<img>`.
pub const CUSTOM_EMOJI_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// One custom emoji held in the pack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomEmoji {
    pub name: String,
    pub alias_of: String,
    pub content_type: String,
    pub width: u32,
    pub height: u32,
    pub source: String,
    pub added_ms: i64,
}

/// Whether `name` is a valid custom emoji name: 1..64 characters, first character must
/// be a lowercase letter or digit, remaining characters may also be `-`, `_` or `+`.
/// No uppercase, no spaces, no colons (which would end the code early).
///
/// Slack's emoji name rule, copied deliberately. The first-character restriction exists
/// because Slack's does — a name starting with punctuation would sort strangly and
/// could collide with Slack's own syntax.
pub fn is_valid_name(name: &str) -> bool {
    let len = name.len();
    if len == 0 || len > 64 {
        return false;
    }
    let bytes = name.as_bytes();
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' || b == b'+')
}

/// What art really is: the type sniffed from the BYTES and the dimensions read out of
/// them, or the sentence to refuse it with.
///
/// Never the type a client declared or a server's own header claimed, and never a size a
/// client measured. The caps in this module are a store invariant — every row holds a
/// raster image inside them — and an invariant a caller can talk its way past is a
/// comment. The dialog measures the picture too, so the user is told before they wait
/// for an upload; this is what makes that a courtesy rather than the check.
///
/// One function because there are four ways into the pack — a file or a paste, a URL, a
/// colleague's message, an imported pack — and a check written four times is a check
/// three of them will eventually be missing.
pub fn measure_art(bytes: &[u8]) -> anyhow::Result<(&'static str, u32, u32)> {
    let content_type = crate::sender_icon::image_kind(bytes)
        .filter(|kind| CUSTOM_EMOJI_TYPES.contains(kind))
        .ok_or_else(|| anyhow::anyhow!("an emoji must be a PNG, JPEG, GIF or WebP image"))?;
    anyhow::ensure!(
        bytes.len() <= MAX_CUSTOM_EMOJI_BYTES,
        "an emoji must be {} KB or smaller",
        MAX_CUSTOM_EMOJI_BYTES / 1024
    );
    let (width, height) = crate::sender_icon::image_dimensions(bytes)
        .ok_or_else(|| anyhow::anyhow!("Could not read image dimensions"))?;
    anyhow::ensure!(
        width <= MAX_CUSTOM_EMOJI_DIMENSION && height <= MAX_CUSTOM_EMOJI_DIMENSION,
        "an emoji must be {} pixels or smaller on a side",
        MAX_CUSTOM_EMOJI_DIMENSION
    );
    Ok((content_type, width, height))
}

const CUSTOM_REACTION_PREFIX: &str = "tlcustom-";

/// The Teams emotion key for a custom emoji reaction: our prefix, then the URL of the
/// AMS object the art was uploaded to. The key carries the ART and nothing else.
///
/// The NAME deliberately does not travel. It cannot: a name may hold digits and hyphens
/// (`blob-2` and `parrot-1` are legal), an AMS id starts with one, and no character in
/// the name charset `[a-z0-9_+-]` can separate the two — so a key spelling both could
/// not be split back apart. Carrying the URL instead also hands the reader something
/// complete: a full URL for the media proxy rather than a bare id with no host, since
/// Teams rewrites the AMS host it serves an object from. What a reader loses is the
/// name, which only ever labelled the reaction — and a label is resolved locally or
/// stated neutrally, while art must come from the message.
///
/// Length is not a concern: the service accepted a 289-character key when it was
/// measured (`examples/custom_emoji_reaction_probe.rs`) and an object URL is ~100.
pub fn custom_reaction_key(object_url: &str) -> String {
    format!("{CUSTOM_REACTION_PREFIX}{object_url}")
}

/// Every distinct `:name:` code in `html`'s text runs, outside tags, outside
/// `<code>`/`<pre>`, outside reply quotes, in first-appearance order.
///
/// A code the pack does not hold is still reported — the caller decides which names
/// to upload.
pub fn codes_in_body(html: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut codes = Vec::new();
    for segment in walk(html) {
        if let Segment::Text(text) = segment {
            for (_, _, code) in code_spans_in_text(text) {
                if seen.insert(code.clone()) {
                    codes.push(code);
                }
            }
        }
    }
    codes
}

/// Replace each `:name:` code in `html` with the inline emoji markup Teams renders,
/// where `art(name)` returns the AMS `src` for a name the pack holds and `None`
/// otherwise. Everything outside a code — tags, attributes, other text — is byte
/// identical.
pub fn substitute_codes(html: &str, art: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(html.len());
    for segment in walk(html) {
        match segment {
            Segment::Raw(s) => out.push_str(s),
            Segment::Text(text) => {
                let mut pos = 0;
                for (start, end, name) in code_spans_in_text(text) {
                    out.push_str(&text[pos..start]);
                    if let Some(src) = art(&name) {
                        // These four attributes were measured against the live tenant on
                        // 2026-08-05: they survive Teams' server-side sanitizer, so the emoji
                        // render inline at text size in stock clients rather than as a picture.
                        out.push_str(r#"<img itemtype="http://schema.skype.com/Emoji" itemid=""#);
                        out.push_str(&name);
                        out.push_str(r#"" alt=":"#);
                        out.push_str(&name);
                        out.push_str(r#":" src=""#);
                        out.push_str(&src);
                        out.push_str(r#"" width="20" height="20">"#);
                    } else {
                        out.push_str(&text[start..end]);
                    }
                    pos = end;
                }
                out.push_str(&text[pos..]);
            }
        }
    }
    out
}

/// A region the substitution never enters, and why: `code`/`pre` because Slack does not
/// render an emoji inside code either, and a REPLY QUOTE because it holds a colleague's
/// own words — substituting our art into them would rewrite what they wrote.
const SKIPPED_TAGS: [&str; 3] = ["code", "pre", "blockquote"];

/// A segment of HTML: either raw (tags, attributes, skipped content) or text (where codes live).
#[derive(Debug)]
enum Segment<'a> {
    Raw(&'a str),
    Text(&'a str),
}

/// Walk `html` once, yielding every text run outside a tag and outside a skipped region as
/// `Segment::Text`, and every other byte as `Segment::Raw`. This is the only place that knows
/// how a body is traversed, so `codes_in_body` and `substitute_codes` can never disagree about
/// where a code is.
fn walk(html: &str) -> impl Iterator<Item = Segment<'_>> {
    WalkIter {
        html,
        pos: 0,
        skip_depth: vec![0; SKIPPED_TAGS.len()],
    }
}

struct WalkIter<'a> {
    html: &'a str,
    pos: usize,
    skip_depth: Vec<usize>,
}

impl<'a> Iterator for WalkIter<'a> {
    type Item = Segment<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.html.len() {
            return None;
        }

        let bytes = self.html.as_bytes();

        if let Some(skip_idx) = self.skip_depth.iter().position(|&d| d > 0) {
            if let Some(close_start) = find_close_tag(&bytes[self.pos..], SKIPPED_TAGS[skip_idx]) {
                let segment_start = self.pos;
                let segment_end = self.pos + close_start + SKIPPED_TAGS[skip_idx].len() + 3;
                self.skip_depth[skip_idx] -= 1;
                self.pos = segment_end;
                return Some(Segment::Raw(&self.html[segment_start..segment_end]));
            } else {
                let segment_start = self.pos;
                self.pos = self.html.len();
                return Some(Segment::Raw(&self.html[segment_start..]));
            }
        }

        if bytes[self.pos] == b'<' {
            let tag_end = bytes[self.pos + 1..]
                .iter()
                .position(|&b| b == b'>')
                .map(|p| self.pos + 1 + p + 1);

            if let Some(end) = tag_end {
                let tag_content = &self.html[self.pos + 1..end - 1];

                for (i, &skip_tag) in SKIPPED_TAGS.iter().enumerate() {
                    if tag_content.starts_with(skip_tag)
                        && (tag_content.len() == skip_tag.len()
                            || tag_content.as_bytes()[skip_tag.len()].is_ascii_whitespace()
                            || tag_content.as_bytes()[skip_tag.len()] == b'>')
                    {
                        self.skip_depth[i] += 1;
                        break;
                    }
                }

                let segment_start = self.pos;
                self.pos = end;
                return Some(Segment::Raw(&self.html[segment_start..end]));
            } else {
                let segment_start = self.pos;
                self.pos = self.html.len();
                return Some(Segment::Raw(&self.html[segment_start..]));
            }
        } else {
            let run_end = bytes[self.pos..]
                .iter()
                .position(|&b| b == b'<')
                .map(|p| self.pos + p)
                .unwrap_or(bytes.len());
            let segment_start = self.pos;
            self.pos = run_end;
            return Some(Segment::Text(&self.html[segment_start..run_end]));
        }
    }
}

/// Find the start position of `</tag>` in `haystack`, accounting for nested same-named tags.
fn find_close_tag(haystack: &[u8], tag: &str) -> Option<usize> {
    let mut nesting = 1;
    let mut pos = 0;
    let open_pattern = format!("<{}", tag);
    let close_pattern = format!("</{}>", tag);

    while pos < haystack.len() {
        if pos + close_pattern.len() <= haystack.len()
            && &haystack[pos..pos + close_pattern.len()] == close_pattern.as_bytes()
        {
            nesting -= 1;
            if nesting == 0 {
                return Some(pos);
            }
            pos += close_pattern.len();
        } else if pos + open_pattern.len() <= haystack.len()
            && &haystack[pos..pos + open_pattern.len()] == open_pattern.as_bytes()
            && (pos + open_pattern.len() == haystack.len()
                || haystack[pos + open_pattern.len()].is_ascii_whitespace()
                || haystack[pos + open_pattern.len()] == b'>')
        {
            nesting += 1;
            pos += open_pattern.len();
        } else {
            pos += 1;
        }
    }
    None
}

/// Every code span in `text`: (start byte offset, end byte offset, name).
/// The name scanner shares `is_valid_name`'s character set so the two cannot drift.
fn code_spans_in_text(text: &str) -> impl Iterator<Item = (usize, usize, String)> + '_ {
    let bytes = text.as_bytes();
    let mut pos = 0;
    std::iter::from_fn(move || {
        while pos < bytes.len() {
            if bytes[pos] == b':' {
                let start = pos;
                pos += 1;
                let name_start = pos;

                if pos < bytes.len() && (bytes[pos].is_ascii_lowercase() || bytes[pos].is_ascii_digit()) {
                    pos += 1;
                    while pos < bytes.len() {
                        let b = bytes[pos];
                        if b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' || b == b'+' {
                            pos += 1;
                        } else {
                            break;
                        }
                    }

                    if pos < bytes.len() && bytes[pos] == b':' {
                        let name = &text[name_start..pos];
                        if name.len() <= 64 {
                            pos += 1; // consume closing ':'
                            return Some((start, pos, name.to_string()));
                        }
                    }
                }
            } else {
                pos += 1;
            }
        }
        None
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn art(name: &str) -> Option<String> {
        match name {
            "shipit" => Some("https://ams.example/v1/objects/0-a/views/imgo".into()),
            "party" => Some("https://ams.example/v1/objects/0-b/views/imgo".into()),
            _ => None,
        }
    }

    #[test]
    fn a_name_is_lowercase_and_short() {
        assert!(is_valid_name("shipit"));
        assert!(is_valid_name("ship-it_2+"));
        assert!(is_valid_name("0"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("ShipIt"), "uppercase is not a Slack emoji name");
        assert!(!is_valid_name("-ship"), "must start alphanumeric");
        assert!(!is_valid_name("ship it"));
        assert!(!is_valid_name("ship:it"), "a colon would end the code early");
        assert!(!is_valid_name(&"a".repeat(65)));
    }

    #[test]
    fn codes_are_read_from_text_runs_only() {
        assert_eq!(codes_in_body("<p>ship :shipit: now</p>"), vec!["shipit"]);
        // Twice in the body is ONE upload.
        assert_eq!(codes_in_body("<p>:shipit: :shipit:</p>"), vec!["shipit"]);
        // First-appearance order, so a body's own reading order decides.
        assert_eq!(codes_in_body("<p>:party: :shipit:</p>"), vec!["party", "shipit"]);
        // Not inside a tag or an attribute.
        assert_eq!(codes_in_body(r#"<img alt=":shipit:" src="x">"#), Vec::<String>::new());
        // Not a code the pack does not hold — that filtering is the caller's, so the
        // scanner reports every well-formed code and `substitute_codes` decides.
        assert_eq!(codes_in_body("<p>:nope:</p>"), vec!["nope"]);
    }

    #[test]
    fn code_blocks_and_quotes_are_left_alone() {
        assert_eq!(codes_in_body("<pre><code>:shipit:</code></pre>"), Vec::<String>::new());
        assert_eq!(codes_in_body("<p>a <code>:shipit:</code> b</p>"), Vec::<String>::new());
        let quote = r#"<blockquote itemtype="http://schema.skype.com/Reply">:shipit:</blockquote><p>:party:</p>"#;
        assert_eq!(codes_in_body(quote), vec!["party"], "a colleague's words are not ours to redraw");
    }

    #[test]
    fn substitution_emits_teams_own_emoji_markup() {
        let out = substitute_codes("<p>ship :shipit: now</p>", &art);
        assert_eq!(
            out,
            "<p>ship <img itemtype=\"http://schema.skype.com/Emoji\" itemid=\"shipit\" \
             alt=\":shipit:\" src=\"https://ams.example/v1/objects/0-a/views/imgo\" \
             width=\"20\" height=\"20\"> now</p>"
        );
    }

    #[test]
    fn an_unknown_code_stays_text() {
        let out = substitute_codes("<p>:nope: :shipit:</p>", &art);
        assert!(out.contains(":nope:"), "a code the pack does not hold is the user's own text");
        assert!(out.contains("itemid=\"shipit\""));
    }

    #[test]
    fn everything_around_a_code_is_byte_identical() {
        let body = "<p>a &amp; b <strong>c</strong> :nope: <a href=\"http://x/:shipit:\">l</a></p>";
        assert_eq!(substitute_codes(body, &art), body, "no code the pack holds, no change");
    }

    /// A PNG stating a size. The first 24 bytes are all `image_dimensions` reads, and the
    /// signature is all `image_kind` reads, so this is a whole image as far as both go.
    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn art_is_measured_from_its_bytes_and_never_from_a_claim() {
        assert_eq!(measure_art(&png_of(20, 20)).unwrap(), ("image/png", 20, 20));

        // An SVG is a document, not a bitmap. It used to be enough to CALL it a PNG.
        let refusal = measure_art(br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#)
            .unwrap_err()
            .to_string();
        assert!(refusal.contains("PNG, JPEG, GIF or WebP"), "{refusal}");

        // The dimension cap holds against the picture rather than against the numbers
        // beside it, which is what makes it a store invariant.
        let refusal = measure_art(&png_of(513, 20)).unwrap_err().to_string();
        assert!(refusal.contains("512 pixels"), "{refusal}");

        let mut heavy = png_of(20, 20);
        heavy.resize(MAX_CUSTOM_EMOJI_BYTES + 1, 0);
        let refusal = measure_art(&heavy).unwrap_err().to_string();
        assert!(refusal.contains("128 KB"), "{refusal}");
    }

    #[test]
    fn a_custom_reaction_key_is_prefixed_and_carries_the_url() {
        let url = "https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo";
        let key = custom_reaction_key(url);
        assert_eq!(key, format!("tlcustom-{url}"));

        // A name that would have been unparseable in the old shape: it is simply not
        // in the key, so `blob-2` and `parrot-1` cost nothing.
        let key = custom_reaction_key("https://eu-api.asm.skype.com/v1/objects/0-b/views/imgo");
        assert_eq!(key, "tlcustom-https://eu-api.asm.skype.com/v1/objects/0-b/views/imgo");
    }
}

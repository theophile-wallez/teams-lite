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

/// The largest custom emoji this app accepts, in bytes. Matches [`crate::teams_send::MAX_IMAGE_BYTES`]
/// because the upload path and the storage are the same.
pub const MAX_CUSTOM_EMOJI_BYTES: usize = 128 * 1024;

/// The widest or tallest emoji accepted, in pixels. Smaller than image uploads
/// because an emoji is a character substitute, not an attachment.
pub const MAX_CUSTOM_EMOJI_DIMENSION: u32 = 512;

/// MIME types accepted for custom emoji. A subset of the raster types image uploads
/// take; SVG is excluded because an emoji is bitmap content, not a document.
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

/// Whether `name` is a valid custom emoji name: 1..64 ASCII lowercase alphanumerics,
/// hyphens, underscores or plus signs, starting with an alphanumeric. No uppercase,
/// no spaces, no colons (which would end the code early).
///
/// Slack's emoji name rule, measured.
pub fn is_valid_name(name: &str) -> bool {
    let len = name.len();
    if len == 0 || len > 64 {
        return false;
    }
    let bytes = name.as_bytes();
    // ponytail: must start with lowercase alphanumeric
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes.iter().all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' || b == b'+')
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
            for code in codes_in_text(text) {
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
                        // ponytail: Teams' own emoji markup, verified against the tenant
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

        // ponytail: if we're inside a skipped region, find its close tag
        if let Some(skip_idx) = self.skip_depth.iter().position(|&d| d > 0) {
            if let Some(close_start) = find_close_tag(&bytes[self.pos..], SKIPPED_TAGS[skip_idx]) {
                let segment_start = self.pos;
                let segment_end = self.pos + close_start + SKIPPED_TAGS[skip_idx].len() + 3;
                self.skip_depth[skip_idx] -= 1;
                self.pos = segment_end;
                return Some(Segment::Raw(&self.html[segment_start..segment_end]));
            } else {
                // ponytail: no close tag found, rest is raw
                let segment_start = self.pos;
                self.pos = self.html.len();
                return Some(Segment::Raw(&self.html[segment_start..]));
            }
        }

        if bytes[self.pos] == b'<' {
            // ponytail: find the end of this tag
            let tag_end = bytes[self.pos + 1..]
                .iter()
                .position(|&b| b == b'>')
                .map(|p| self.pos + 1 + p + 1);

            if let Some(end) = tag_end {
                let tag_content = &self.html[self.pos + 1..end - 1];

                // ponytail: check if this opens a skipped tag
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
                // ponytail: malformed, treat rest as raw
                let segment_start = self.pos;
                self.pos = self.html.len();
                return Some(Segment::Raw(&self.html[segment_start..]));
            }
        } else {
            // ponytail: text run until next tag
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

/// Every code in `text`, as owned strings. Used by `codes_in_body`.
fn codes_in_text(text: &str) -> impl Iterator<Item = String> + '_ {
    code_spans_in_text(text).map(|(_, _, name)| name)
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

                // ponytail: scan a name using is_valid_name's character set
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

                    // ponytail: closing colon and length check
                    if pos < bytes.len() && bytes[pos] == b':' {
                        let name = &text[name_start..pos];
                        if name.len() <= 64 {
                            pos += 1; // consume closing ':'
                            return Some((start, pos, name.to_string()));
                        }
                    }
                }
                // ponytail: not a code, keep scanning from after the opening ':'
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
}

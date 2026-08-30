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
//! - `@Name` and `@[Name]` become a real Teams @mention, but ONLY for a name this
//!   thread already holds ([`Mentionable`]). Everything else stays the text it is.
//!
//! The mention is the one place where the answer does something outward: a mention
//! notifies the person it names. Four rails hold it, and each is a rule in the code
//! below rather than a note in a prompt:
//!
//! - The caller supplies the people. An answer can name a member of the thread it is
//!   posted in and nobody else, so a model cannot ping a colleague who is not there.
//! - A name that resolves to nobody stays plain text. A typo reads as a typo; it never
//!   silently notifies the nearest match.
//! - The span shows the name the THREAD holds, not the text the answer typed, so the
//!   message cannot show one person's name over another person's MRI.
//! - At most [`crate::teams_send::MAX_MENTIONS`] mentions resolve in one answer.

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

/// Somebody an answer is allowed to @mention: one person of the thread the answer is
/// posted in.
///
/// The caller builds this list from that thread's own roster (`thread_mentionable_people`
/// in src/bin/server.rs), which is what keeps an answer from notifying anybody the
/// conversation does not contain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mentionable {
    /// The person's MRI — what makes Teams notify them.
    pub mri: String,
    /// The name this thread holds for them, and the text the span shows.
    pub name: String,
}

/// How much text `@[…]` may hold before it stops being a name. Bounds the search for
/// the closing bracket, so a lone `@[` costs one short scan rather than the whole line.
const MENTION_NAME_CHARS: usize = 128;

/// How many names the note in the system prompt lists. See [`mention_note`].
///
/// It bounds the `<people>` block of the same prompt too — `agent_policy::PEOPLE_LISTED` is
/// this constant, not a copy of it — because the two are read side by side.
pub(crate) const MENTION_NOTE_NAMES: usize = 40;

/// Render an answer as the HTML body of a Teams message, mentioning nobody.
pub fn to_html(markdown: &str) -> String {
    to_html_with_mentions(markdown, &[]).0
}

/// Render an answer, turning `@Name` and `@[Full Name]` into real Teams @mentions for
/// the people in `people` — and into nothing at all for anybody else.
///
/// Returns the body and the mentions it names, which belong together: the body's span
/// carries only an index, and the returned list is what says who that index is. The
/// send path refuses one without the other (`build_body` in src/teams_send.rs).
pub fn to_html_with_mentions(
    markdown: &str,
    people: &[Mentionable],
) -> (String, Vec<crate::teams_send::Mention>) {
    let mut resolver = Resolver::new(people);
    let html = render(markdown, &mut resolver);
    (html, resolver.found)
}

/// The paragraph appended to the system prompt naming who this thread can be mentioned
/// with, and how to write it.
///
/// A capability the model is not told about is a capability it never uses, so the names
/// travel with the run. Bounded to [`MENTION_NOTE_NAMES`]: the list arrives with the
/// recent contributors first, and a prompt is not a directory.
///
/// Returns an empty string when nobody can be mentioned, so the prompt gains no
/// paragraph about a thread with no roster.
pub fn mention_note(people: &[Mentionable]) -> String {
    let names: Vec<&str> = people
        .iter()
        .take(MENTION_NOTE_NAMES)
        .map(|person| person.name.as_str())
        .collect();
    if names.is_empty() {
        return String::new();
    }
    format!(
        "\n\nYou can @mention the people in this conversation, and a mention notifies \
         them: write `@[Full Name]` (or `@Name` when it is unambiguous) and it becomes a \
         real Teams mention. These are the people you can name: {}. A name that is not \
         one of them stays plain text and notifies nobody. Mention somebody because the \
         message is for them, not to decorate an answer.",
        names.join(", ")
    )
}

fn render(markdown: &str, resolver: &mut Resolver) -> String {
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
            html.push_str(&format!("<li>{}</li>", inline(resolver, list_item_text(trimmed))));
            while let Some(next) = lines.peek() {
                let next = next.trim_end();
                if list_kind(next) != Some(kind) {
                    break;
                }
                html.push_str(&format!("<li>{}</li>", inline(resolver, list_item_text(next))));
                lines.next();
            }
            html.push_str(close);
            continue;
        }
        if let Some(quoted) = trimmed.trim_start().strip_prefix("> ") {
            html.push_str(&format!("<blockquote><p>{}</p></blockquote>", inline(resolver, quoted)));
            continue;
        }
        // A heading has no place in a chat message (the system prompt says so), so it
        // becomes a bold paragraph rather than an <h1> nobody wants in a thread.
        let heading = trimmed.trim_start_matches('#');
        if heading.len() < trimmed.len() && !heading.trim().is_empty() {
            html.push_str(&format!("<p><strong>{}</strong></p>", inline(resolver, heading.trim())));
            continue;
        }
        // A paragraph: consecutive non-blank lines, joined by <br>.
        let mut paragraph = inline(resolver, trimmed.trim());
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
            paragraph.push_str(&inline(resolver, next.trim()));
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

/// Escape one line and turn `` `code` ``, `**bold**` and a known `@Name` into markup.
///
/// One pass, with the code state tracked, so `**` inside a code span stays two
/// asterisks — which is what it is. A mention inside a code span is code too: an answer
/// quoting `@claude` as an example must not ping anybody.
fn inline(resolver: &mut Resolver, text: &str) -> String {
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
            '@' if !in_code && starts_a_word(&chars, i) => {
                match resolver.take(&chars[i + 1..]) {
                    Some((span, consumed)) => {
                        out.push_str(&span);
                        i += 1 + consumed;
                    }
                    None => {
                        out.push('@');
                        i += 1;
                    }
                }
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

/// Whether the `@` at `i` opens a word rather than sitting inside one. `bob@corp.example`
/// is an address, not a mention of `corp`.
fn starts_a_word(chars: &[char], i: usize) -> bool {
    match i.checked_sub(1).and_then(|before| chars.get(before)) {
        None => true,
        Some(c) => !c.is_alphanumeric(),
    }
}

/// Matches the people of one thread against the `@…` the answer writes, and collects
/// the mentions the body ends up carrying.
///
/// Stateful for one reason: an `itemid` numbers a span within ONE message, so the
/// counter has to outlive the line. The same person mentioned twice gets two spans and
/// two entries, which is exactly what the composer does too.
struct Resolver<'a> {
    people: &'a [Mentionable],
    found: Vec<crate::teams_send::Mention>,
}

impl<'a> Resolver<'a> {
    fn new(people: &'a [Mentionable]) -> Self {
        Self { people, found: Vec::new() }
    }

    /// Resolve the text just after an `@`. Returns the span to emit and how many chars
    /// it consumed, or `None` when this `@` names nobody in the thread.
    ///
    /// `after` is already HTML-escaped, so the name is compared against the escaped
    /// form of each person's name — otherwise `@Ben O&#39;Neill` would never match the
    /// `Ben O'Neill` the roster holds.
    fn take(&mut self, after: &[char]) -> Option<(String, usize)> {
        if self.found.len() >= crate::teams_send::MAX_MENTIONS {
            return None;
        }
        let (person, consumed) = match self.bracketed(after) {
            Some(found) => found,
            None => self.bare(after)?,
        };
        // The span shows the name the THREAD holds, escaped once more here because
        // `person.name` comes from the roster and has never been through `escape`.
        let itemid = self.found.len() as u32;
        self.found.push(crate::teams_send::Mention {
            itemid,
            mri: person.mri.clone(),
            display_name: person.name.clone(),
            // A PERSON, always: an agent's answer may name the people of its own thread and
            // nothing wider. Notifying a whole channel is the reader's own press in the
            // composer, and a model must not reach it by writing a name.
            kind: crate::teams_send::MentionKind::Person,
        });
        Some((
            format!(
                "<span itemscope=\"\" itemtype=\"http://schema.skype.com/Mention\" \
                 itemid=\"{itemid}\">{}</span>",
                escape(&person.name)
            ),
            consumed,
        ))
    }

    /// `@[Full Name]` — the explicit form, which is the only one that can name somebody
    /// whose name the surrounding sentence would otherwise swallow.
    fn bracketed(&self, after: &[char]) -> Option<(&'a Mentionable, usize)> {
        if after.first() != Some(&'[') {
            return None;
        }
        let close = after
            .iter()
            .take(MENTION_NAME_CHARS + 2)
            .position(|c| *c == ']')?;
        let name: String = after[1..close].iter().collect();
        let person = self.person_named(name.trim())?;
        Some((person, close + 1))
    }

    /// `@Some Name` — the natural form, matched against the whole name and against the
    /// first name alone, so both `@Ada Lovelace` and `@Ada` reach Ada.
    ///
    /// The LONGEST match wins, so a thread holding both "Ada" and "Ada Lovelace"
    /// resolves `@Ada Lovelace` to the second rather than to the first followed by a
    /// stray surname. A length that fits two DIFFERENT people resolves to nobody, for
    /// the reason [`Resolver::person_named`] gives.
    fn bare(&self, after: &[char]) -> Option<(&'a Mentionable, usize)> {
        let mut best: Option<(&'a Mentionable, usize)> = None;
        let mut ambiguous = false;
        for (person, candidate) in self.candidates() {
            let candidate: Vec<char> = candidate.chars().collect();
            if candidate.is_empty() || after.len() < candidate.len() {
                continue;
            }
            if !after[..candidate.len()]
                .iter()
                .zip(&candidate)
                .all(|(a, b)| a.eq_ignore_ascii_case(b))
            {
                continue;
            }
            // The name must end where a word ends: `@Ada` must not match "Adam" and
            // hand Ada's MRI a span reading "Ada" in the middle of somebody else's name.
            if after.get(candidate.len()).is_some_and(|c| c.is_alphanumeric()) {
                continue;
            }
            match best {
                Some((_, len)) if len > candidate.len() => {}
                Some((held, len)) if len == candidate.len() && held.mri != person.mri => {
                    ambiguous = true;
                }
                Some((_, len)) if len == candidate.len() => {}
                _ => {
                    best = Some((person, candidate.len()));
                    ambiguous = false;
                }
            }
        }
        if ambiguous {
            return None;
        }
        best
    }

    /// Every spelling a person can be written as, escaped like the text it is matched
    /// against: their whole name, and their first name when the name has more than one
    /// word.
    fn candidates(&self) -> impl Iterator<Item = (&'a Mentionable, String)> {
        self.people.iter().flat_map(|person| {
            let whole = escape(&person.name);
            let first = whole.split_whitespace().next().unwrap_or_default().to_string();
            let short = (first != whole && !first.is_empty()).then_some((person, first));
            std::iter::once((person, whole)).chain(short)
        })
    }

    /// The person a written name refers to, matched case-insensitively against the whole
    /// name and then against the first name alone.
    ///
    /// `written` arrives ALREADY escaped — it was cut out of an escaped line — which is
    /// why it is compared against the escaped spelling of each name rather than escaped
    /// again here.
    ///
    /// A name that fits two people resolves to NOBODY: the answer meant one of them, and
    /// notifying the wrong one is worse than not notifying anybody.
    fn person_named(&self, written: &str) -> Option<&'a Mentionable> {
        if written.is_empty() {
            return None;
        }
        let mut hits = self
            .candidates()
            .filter(|(_, candidate)| candidate.eq_ignore_ascii_case(written))
            .map(|(person, _)| person);
        let person = hits.next()?;
        hits.all(|other| other.mri == person.mri).then_some(person)
    }
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

    // ---- @mentions ---------------------------------------------------------
    //
    // The one part of an answer that acts on somebody: a mention notifies the person it
    // names. Every test below pins one rail on that.

    fn person(name: &str, mri: &str) -> Mentionable {
        Mentionable { mri: mri.into(), name: name.into() }
    }

    /// The thread these tests answer in.
    fn thread() -> Vec<Mentionable> {
        vec![
            person("Ada Lovelace", "8:orgid:ada"),
            person("Grace Hopper", "8:orgid:grace"),
        ]
    }

    /// The span for `itemid`, exactly as the send path expects to find it.
    fn span(itemid: u32, name: &str) -> String {
        format!(
            "<span itemscope=\"\" itemtype=\"http://schema.skype.com/Mention\" \
             itemid=\"{itemid}\">{name}</span>"
        )
    }

    #[test]
    fn a_known_name_becomes_a_mention_span_and_its_entry() {
        let (html, mentions) = to_html_with_mentions("@Ada Lovelace can you look?", &thread());
        assert_eq!(html, format!("<p>{} can you look?</p>", span(0, "Ada Lovelace")));
        assert_eq!(mentions, vec![crate::teams_send::Mention {
            itemid: 0,
            mri: "8:orgid:ada".into(),
            display_name: "Ada Lovelace".into(),
            // A PERSON, and this assertion is what pins it: an answer that could write a
            // CHANNEL mention would notify everybody following the channel from a name the
            // model typed.
            kind: crate::teams_send::MentionKind::Person,
        }]);
    }

    #[test]
    fn a_first_name_and_a_bracketed_name_reach_the_same_person() {
        for written in ["@Ada", "@[Ada Lovelace]", "@[ ada ]", "@ada"] {
            let (html, mentions) = to_html_with_mentions(&format!("{written} hello"), &thread());
            assert_eq!(mentions.len(), 1, "{written} named nobody");
            assert_eq!(mentions[0].mri, "8:orgid:ada", "{written}");
            // The span shows the name the THREAD holds, never the text that was typed.
            assert!(html.contains(">Ada Lovelace</span>"), "{written} -> {html}");
        }
    }

    #[test]
    fn a_name_the_thread_does_not_hold_stays_plain_text() {
        // The rail that matters most: an answer cannot notify somebody who is not here.
        let (html, mentions) = to_html_with_mentions("@Alan Turing and @nobody", &thread());
        assert_eq!(html, "<p>@Alan Turing and @nobody</p>");
        assert!(mentions.is_empty());
    }

    #[test]
    fn an_ambiguous_first_name_names_nobody() {
        // Two Adas: the answer meant one of them, and notifying the wrong one is worse
        // than notifying neither.
        let people = vec![person("Ada Lovelace", "8:orgid:ada"), person("Ada Byron", "8:orgid:byron")];
        let (html, mentions) = to_html_with_mentions("@Ada look", &people);
        assert_eq!(html, "<p>@Ada look</p>");
        assert!(mentions.is_empty());
        // Written in full, the same thread resolves it.
        let (_, mentions) = to_html_with_mentions("@[Ada Byron] look", &people);
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0].mri, "8:orgid:byron");
    }

    #[test]
    fn the_longest_name_wins() {
        // "Ada" alone must not eat the surname and leave "Lovelace" hanging.
        let people = vec![person("Ada", "8:orgid:short"), person("Ada Lovelace", "8:orgid:ada")];
        let (html, mentions) = to_html_with_mentions("@Ada Lovelace hi", &people);
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0].mri, "8:orgid:ada");
        assert_eq!(html, format!("<p>{} hi</p>", span(0, "Ada Lovelace")));
    }

    #[test]
    fn a_name_must_end_where_a_word_ends() {
        // `@Adam` is not Ada, and `bob@ada.example` is an address.
        let (html, mentions) = to_html_with_mentions("@Adam wrote to bob@Ada.example", &thread());
        assert_eq!(html, "<p>@Adam wrote to bob@Ada.example</p>");
        assert!(mentions.is_empty());
    }

    #[test]
    fn a_mention_inside_code_stays_code() {
        // An answer explaining the syntax must not ping anybody while it does so.
        let (html, mentions) = to_html_with_mentions("write `@Ada` to ping her", &thread());
        assert_eq!(html, "<p>write <code>@Ada</code> to ping her</p>");
        assert!(mentions.is_empty());
        let (html, mentions) = to_html_with_mentions("```\n@Ada Lovelace\n```", &thread());
        assert_eq!(html, "<pre><code>@Ada Lovelace</code></pre>");
        assert!(mentions.is_empty());
    }

    #[test]
    fn the_same_person_twice_gets_two_spans_and_two_entries() {
        // What the composer does too: an itemid numbers a span, not a person.
        let (html, mentions) = to_html_with_mentions("@Ada and @Ada again", &thread());
        assert!(html.contains(&span(0, "Ada Lovelace")), "{html}");
        assert!(html.contains(&span(1, "Ada Lovelace")), "{html}");
        assert_eq!(mentions.len(), 2);
        assert_eq!(mentions[1].itemid, 1);
        assert!(mentions.iter().all(|m| m.mri == "8:orgid:ada"));
    }

    #[test]
    fn every_itemid_the_body_carries_has_an_entry_and_the_reverse() {
        // The pair the send path enforces, checked here so a rendering bug fails as a
        // unit test rather than as a message Teams silently refuses.
        let (html, mentions) =
            to_html_with_mentions("- @Ada\n- @Grace Hopper\n\n> @Ada again", &thread());
        let spans = crate::teams_send::mention_span_itemids(&html);
        let entries: Vec<u32> = mentions.iter().map(|m| m.itemid).collect();
        assert_eq!(spans, entries, "{html}");
        assert_eq!(spans.len(), 3);
    }

    #[test]
    fn a_mention_is_escaped_like_any_other_text() {
        // A name with an apostrophe still matches, and the span shows it escaped.
        let people = vec![person("Ben O'Neill", "8:orgid:ben")];
        let (html, mentions) = to_html_with_mentions("@[Ben O'Neill] hi", &people);
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0].display_name, "Ben O'Neill", "the entry holds the real name");
        assert!(html.contains(">Ben O&#39;Neill</span>"), "{html}");
        // And a name that carries markup cannot inject it.
        let hostile = vec![person("<b>Eve</b>", "8:orgid:eve")];
        let (html, _) = to_html_with_mentions("@[<b>Eve</b>] hi", &hostile);
        assert!(html.contains("&lt;b&gt;Eve&lt;/b&gt;</span>"), "{html}");
        assert!(!html.contains("<b>"), "{html}");
    }

    #[test]
    fn an_answer_stops_at_the_mention_limit() {
        let people = vec![person("Ada", "8:orgid:ada")];
        let over = crate::teams_send::MAX_MENTIONS + 5;
        let answer = "@Ada ".repeat(over);
        let (html, mentions) = to_html_with_mentions(&answer, &people);
        assert_eq!(mentions.len(), crate::teams_send::MAX_MENTIONS);
        // The ones past the limit are still the words they were.
        assert_eq!(
            crate::teams_send::mention_span_itemids(&html).len(),
            crate::teams_send::MAX_MENTIONS
        );
    }

    #[test]
    fn to_html_mentions_nobody() {
        // The old entry point still exists and is still inert: `@Ada` is text to it.
        assert_eq!(to_html("@Ada Lovelace hi"), "<p>@Ada Lovelace hi</p>");
    }

    #[test]
    fn a_lone_bracket_is_not_a_mention() {
        let (html, mentions) = to_html_with_mentions("@[unclosed and @[]", &thread());
        assert_eq!(html, "<p>@[unclosed and @[]</p>");
        assert!(mentions.is_empty());
    }

    #[test]
    fn the_prompt_note_lists_the_thread_and_nothing_else() {
        let note = mention_note(&thread());
        assert!(note.contains("Ada Lovelace, Grace Hopper"), "{note}");
        assert!(note.contains("@[Full Name]"), "{note}");
        // A thread with no roster gains no paragraph about mentioning people.
        assert_eq!(mention_note(&[]), "");
    }
}

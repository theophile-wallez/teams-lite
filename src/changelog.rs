// What changed between two builds, in the words the commits were written in.
//
// teams-lite has no version number: a build IS the commit it was compiled from (see
// src/update.rs). So "what am I about to install?" can only be answered by the commits
// between the build that is running and the one the release holds — which is what this
// module turns into something a person can read.
//
// It is ONE implementation for two readers, deliberately:
//
//   • GitHub — CI renders the markdown of this module into every release body
//     (examples/changelog.rs, called from .github/workflows/build.yml), so the release
//     history on github.com IS this list.
//   • the app — the backend fetches the commits between the two builds from GitHub's
//     compare API and publishes THIS structure in the `update_available` payload, and
//     the update button shows it (web/src/components/update-button.tsx).
//
// A markdown renderer in bash beside a grouper in Rust would be two spellings of one
// list, drifting apart at the first commit type nobody thought of. There is one, and the
// tests below own it.
//
// THE SUBJECT IS NOT THE CHANGE — IT IS THE TITLE OF ONE. A commit here carries a subject
// of some 75 characters and then several paragraphs saying what was wrong before, what it
// costs and why it is shaped the way it is: measured over 20 commits of master, 1 501
// bytes of subject against 22 171 bytes of body. This module read the subject alone, so a
// release page held one line for a fortnight of work and 94% of what the author wrote
// reached nobody. The body travels as `Change::body` now.
//
// The TWO READERS get different amounts of it, because they have different room and
// different questions:
//
//   • the RELEASE PAGE renders the body, bounded by [`MAX_BODY_BYTES`]. Somebody who
//     opens it is asking what a build changed and has a whole page for the answer.
//   • the APP is handed the summaries alone (`body` is `#[serde(skip)]`). Its list is a
//     hover panel over a sidebar showing the newest few — a paragraph an entry there is a
//     wall of text in a 20rem card, and 200 changes of prose is a 400 KB payload on a
//     socket built for JSON. What the panel is for is deciding to update; the page is for
//     reading what it brings.
//
// It is still ONE list, grouped once: what differs is how much of each entry a surface
// has the room to draw.
//
// NO SHA APPEARS HERE, and that is the same rule the button obeys (web/src/lib/update.ts):
// a commit id reads as a fault code, and it is not what the reader is asking. They are
// asking what changed. The identity of a build stays in the protocol, where the BACKEND
// compares it — never in the words either surface shows.

use serde::Serialize;

/// How many changes travel to the app at most.
///
/// The list is a scrolling panel, so this is not a display limit — it is a bound on the
/// payload and the DOM for the case that makes one necessary: a build left running for a
/// week is 130-odd commits behind, and a machine that never updates is 500. What is cut is
/// COUNTED and said out loud (`omitted`), because a list that silently stops reads as a
/// complete one.
pub const MAX_CHANGES: usize = 200;

/// How many bytes of commit BODY a rendered release page carries in total.
///
/// A budget rather than a per-entry cut, because the entries are not equal: the first
/// group is what is new, and a reader who runs out of page has lost the least by losing
/// the housekeeping note at the foot. Nothing is truncated mid-sentence — an entry either
/// carries its whole body or carries none, since half a paragraph reads as a fault.
///
/// 40 000 is well inside GitHub's own 125 000-character limit on a release body, which is
/// the ceiling this exists to stay under: a release that exceeded it would be REFUSED, and
/// a build that publishes no notes is worse than one that publishes short ones.
pub const MAX_BODY_BYTES: usize = 40_000;

/// One change: what it touched, what it says, and what the author wrote under it.
///
/// `scope` is the conventional-commit scope (`fix(media): …` → `media`), kept apart from
/// the summary so a reader can see WHERE a change landed before reading what it was, and
/// so the two can be drawn differently. `None` for a commit that declared none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    pub summary: String,
    /// The commit declared itself breaking (`feat!:`). Carried rather than folded into
    /// the group, so a breaking change is still marked when it is read on its own.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub breaking: bool,
    /// The commit's body — the author's own paragraphs, whitespace-normalised and
    /// otherwise untouched. `None` for a commit that wrote only a subject.
    ///
    /// It NEVER travels to the app (see the module header): the panel there has no room
    /// for it, and the payload is a socket message. So this field is the one part of a
    /// change that exists for the release page alone, and `to_markdown` is its only
    /// reader.
    #[serde(skip)]
    pub body: Option<String>,
}

/// A heading and the changes under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Group {
    pub title: String,
    pub changes: Vec<Change>,
}

/// Everything between two builds, grouped for a reader.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Changelog {
    pub groups: Vec<Group>,
    /// How many commits there were in total — including any this list does not carry, so
    /// the count is never a count of what survived a cap.
    pub total: usize,
    /// How many are missing from `groups`, whether because of [`MAX_CHANGES`] or because
    /// GitHub's own compare API stopped at 250. Zero on the ordinary case.
    pub omitted: usize,
}

impl Changelog {
    /// Nothing to show. Distinct from "not fetched yet", which is `None` at the call site:
    /// an empty changelog is a comparison that came back with no commits in it.
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }
}

/// The conventional-commit types this project writes, in the order a reader wants them,
/// with the heading each one gets.
///
/// The order is by what the reader gains: what is new, what is repaired, what was taken
/// back, what got faster, and then — under [`DEVELOPMENT`] — the changes that alter
/// nothing they can see. A `revert` sits with `fix` rather than at the foot, because
/// something the reader had is gone and that is a fact about the app.
///
/// Anything unrecognised falls to [`OTHER`], which is what keeps a commit written outside
/// the convention in the list rather than out of it.
const TYPES: &[(&str, &str)] = &[
    ("feat", "New"),
    ("fix", "Fixed"),
    ("revert", "Reverted"),
    ("perf", "Faster"),
    ("refactor", "Reworked"),
    ("style", "Reworked"),
    ("docs", "Documented"),
    ("test", "Tests"),
    ("chore", "Housekeeping"),
    ("build", "Housekeeping"),
    ("ci", "Housekeeping"),
];

/// The headings that describe the WORK rather than the app.
///
/// A reader opening a release page is asking what changed for them. A refactor alters no
/// behaviour by definition, a test proves what already shipped, and a bumped dependency is
/// somebody's Tuesday — so on a page that has something to say, these are folded away
/// behind one disclosure instead of standing between the reader and the features.
///
/// They are never DROPPED, for the reason `docs` was always kept: they are why a release
/// exists on a day nobody shipped a feature. That is also the one case the fold is wrong —
/// see [`to_markdown`], which leaves them open when they are all there is, because a page
/// whose whole content is folded reads as a page with nothing on it.
const DEVELOPMENT: &[&str] = &["Reworked", "Documented", "Tests", "Housekeeping"];

/// The summary line of the disclosure [`DEVELOPMENT`] is folded behind.
const DEVELOPMENT_SUMMARY: &str = "Development notes";

/// The heading for a commit that declared no type this module knows.
///
/// It is NOT development work: a subject this module could not classify may say anything,
/// and folding it away would hide a real change on the strength of a missing prefix.
const OTHER: &str = "Other";

/// The heading breaking changes are lifted to, above everything else.
const BREAKING: &str = "Breaking";

/// Group commit messages into a changelog.
///
/// `messages` are the commits between the two builds, newest first — which is the order
/// GitHub's compare API and `git log` both hand over, and the order they stay in inside
/// each group: a reader scanning "Fixed" wants the newest fix first. `total` is how many
/// commits there really were, so a caller that already knows GitHub truncated its own
/// answer can say so; pass `messages.len()` when it did not.
///
/// A message is a subject and then, usually, the paragraphs under it. Both are read here
/// (the subject becomes the heading, the scope and the summary; the body becomes
/// [`Change::body`]), which is what lets ONE function serve the workflow's `git log` and
/// the compare API's `commit.message` alike. A caller that has only a subject passes one:
/// a message with no second line simply carries no body.
///
/// Merge commits are dropped. They say who merged what, never what changed, and this
/// project's own history is linear anyway — so one in the list is noise from a branch
/// somebody landed by hand.
pub fn from_commits(messages: &[String], total: usize) -> Changelog {
    let mut kept: Vec<(usize, Change)> = Vec::new();
    let mut counted = 0usize;

    for message in messages.iter().filter(|m| !is_merge(m)) {
        counted += 1;
        if kept.len() >= MAX_CHANGES {
            continue;
        }
        kept.push(parse(message));
    }

    // The heading order is TYPES' own, so a group can never appear twice and the sort is
    // by the rank the table already states.
    let mut titles: Vec<&str> = Vec::new();
    for (_, title) in TYPES {
        if !titles.contains(title) {
            titles.push(title);
        }
    }
    titles.push(OTHER);

    let mut groups: Vec<Group> = Vec::new();
    // Breaking first, whatever type declared it: it is the one thing a reader must not
    // scroll to find.
    for wanted in std::iter::once(BREAKING).chain(titles.into_iter()) {
        let changes: Vec<Change> = kept
            .iter()
            .filter(|(rank, change)| {
                if wanted == BREAKING {
                    change.breaking
                } else {
                    !change.breaking && *rank == first_rank_of_title(wanted)
                }
            })
            .map(|(_, change)| change.clone())
            .collect();
        if !changes.is_empty() {
            groups.push(Group { title: wanted.to_string(), changes });
        }
    }

    // The count is of CHANGES, not of commits, and the two differ in both directions.
    // A merge we were handed is not one, so it is not counted. A commit GitHub never sent
    // (its compare stops at 250) has to be, because the alternative is understating how far
    // behind the reader is — and it cannot be inspected to see whether it was a merge.
    let hidden = total.saturating_sub(messages.len());
    let total = counted + hidden;
    Changelog { groups, total, omitted: total.saturating_sub(kept.len()) }
}

/// The rank of the FIRST type carrying a heading, so two types that share one (`style`
/// and `refactor` are both "Reworked") land in the same group instead of two. It is the
/// group key: [`OTHER`] names no type, so it falls past the end of the table, which is
/// exactly where [`parse`] puts a subject it did not recognise.
fn first_rank_of_title(title: &str) -> usize {
    TYPES.iter().position(|(_, t)| *t == title).unwrap_or(TYPES.len())
}

/// Read one commit message as a change, with its group's rank.
///
/// `type(scope)!: summary` is the shape of the first line; everything about it is optional
/// in practice, and a subject that is none of it is still a change — it goes to [`OTHER`]
/// with its words untouched. Nothing is capitalised or re-punctuated: these are the
/// author's sentences, and this project writes them lower case on purpose.
///
/// Everything after the first line is the body, read by [`body_of`].
fn parse(message: &str) -> (usize, Change) {
    let (subject, body) = match message.split_once('\n') {
        Some((subject, rest)) => (subject.trim(), body_of(rest)),
        None => (message.trim(), None),
    };
    let plain = |summary: &str| Change {
        scope: None,
        summary: summary.to_string(),
        breaking: false,
        body: body.clone(),
    };

    let Some((head, summary)) = subject.split_once(':') else {
        return (TYPES.len(), plain(subject));
    };
    let head = head.trim();
    // A colon inside prose ("note: this") must not read as a type. A conventional head is
    // one word, optionally with a parenthesised scope, and nothing else.
    if head.is_empty() || head.len() > 40 || head.contains(' ') {
        return (TYPES.len(), plain(subject));
    }

    let breaking = head.ends_with('!');
    let head = head.trim_end_matches('!');
    let (kind, scope) = match head.split_once('(') {
        Some((kind, rest)) => {
            let scope = rest.trim_end_matches(')').trim();
            (kind, if scope.is_empty() { None } else { Some(scope.to_string()) })
        }
        None => (head, None),
    };

    let summary = summary.trim().to_string();
    match TYPES.iter().position(|(t, _)| *t == kind.to_ascii_lowercase()) {
        // A recognised type: the scope and the summary are what the author meant them to
        // be, and the type itself becomes the heading rather than words in the line.
        Some(i) => (
            first_rank_of_title(TYPES[i].1),
            Change { scope, summary, breaking, body },
        ),
        // Not one of ours: keep the WHOLE subject, because the part before the colon is
        // then somebody's prose and cutting it would change what they wrote.
        None => (
            TYPES.len(),
            Change { scope: None, summary: subject.to_string(), breaking, body },
        ),
    }
}

/// The paragraphs under a subject, as the author wrote them.
///
/// Only the WHITESPACE is touched: every line is right-trimmed and a run of blank lines
/// becomes one, so a body written with a stray trailing space renders as one paragraph
/// break rather than three. The words, the case, the punctuation, the backticks and the
/// line breaks inside a paragraph are left exactly as they are — this is the one place in
/// the project where somebody's prose is republished, and rewriting it would be this module
/// putting words in their mouth.
///
/// A body of nothing but whitespace is `None`, so "has a body" and "has words" are the
/// same question at every call site.
fn body_of(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut blank = 0usize;
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            // The run is collapsed to ONE blank line, and a run at the very top is dropped
            // with it: `%s%n%b` puts an empty line between the subject and the body.
            out.push('\n');
            if blank > 0 {
                out.push('\n');
            }
        }
        blank = 0;
        out.push_str(line);
    }
    (!out.is_empty()).then_some(out)
}

/// Is this subject a merge commit's?
fn is_merge(subject: &str) -> bool {
    let s = subject.trim_start();
    s.starts_with("Merge pull request") || s.starts_with("Merge branch") || s.starts_with("Merge remote")
}

/// Render a changelog as the markdown of a GitHub release body.
///
/// Called by CI through examples/changelog.rs, so the release history on github.com and
/// the list inside the app are the same list — see the module header.
///
/// This is the surface with ROOM, so it is the one that renders what the author actually
/// wrote. Two rules shape the page, and each is pinned by a test below:
///
///   • the BODY is rendered under its bullet, in order, until [`MAX_BODY_BYTES`] is
///     spent — and the first entry that would not fit ends the PROSE for the rest of the
///     page. A reader then gets whole entries and then summaries, rather than paragraphs
///     appearing and vanishing down the page by the accident of their length.
///   • the [`DEVELOPMENT`] groups are FOLDED behind one disclosure, unless they are all
///     there is: a release whose whole content is a refactor and a test is a release about
///     a refactor and a test, and folding that would publish a page which looks empty.
pub fn to_markdown(log: &Changelog) -> String {
    if log.is_empty() {
        return "No changes.".to_string();
    }
    let is_development = |group: &&Group| DEVELOPMENT.contains(&group.title.as_str());
    let above: Vec<&Group> = log.groups.iter().filter(|g| !is_development(g)).collect();
    let folded: Vec<&Group> = log.groups.iter().filter(is_development).collect();
    // Nothing to put above the fold means nothing to fold: the work IS the release.
    let (above, folded) = if above.is_empty() { (folded, Vec::new()) } else { (above, folded) };

    let mut out = String::new();
    let mut budget = MAX_BODY_BYTES;
    for group in above {
        push_group(&mut out, group, &mut budget);
    }
    if !folded.is_empty() {
        // The blank line after `<summary>` is what makes GitHub render the markdown inside
        // the block rather than print it as text.
        out.push_str(&format!("<details>\n<summary>{DEVELOPMENT_SUMMARY}</summary>\n\n"));
        for group in folded {
            push_group(&mut out, group, &mut budget);
        }
        out.push_str("</details>\n\n");
    }
    if log.omitted > 0 {
        out.push_str(&format!(
            "_and {} more commit{}._\n",
            log.omitted,
            if log.omitted == 1 { "" } else { "s" }
        ));
    }
    out.trim_end().to_string()
}

/// One heading and its bullets, spending `budget` on whatever body fits.
fn push_group(out: &mut String, group: &Group, budget: &mut usize) {
    out.push_str(&format!("### {}\n\n", group.title));
    for change in &group.changes {
        match &change.scope {
            Some(scope) => out.push_str(&format!("- **{scope}** — {}\n", change.summary)),
            None => out.push_str(&format!("- {}\n", change.summary)),
        }
        push_body(out, change, budget);
    }
    out.push('\n');
}

/// The author's paragraphs under their own bullet, indented to belong to it.
///
/// Two spaces, because a continuation line of a `- ` item that is not indented is a new
/// paragraph of the LIST rather than of the entry — the words would still be on the page
/// and would no longer say which change they were about.
fn push_body(out: &mut String, change: &Change, budget: &mut usize) {
    let Some(body) = change.body.as_deref() else { return };
    if body.len() > *budget {
        // Spending the rest on a shorter entry further down would interleave paragraphs
        // with bare summaries, so the page stops carrying prose here.
        *budget = 0;
        return;
    }
    *budget -= body.len();
    out.push('\n');
    for line in body.lines() {
        if line.is_empty() {
            out.push('\n');
        } else {
            out.push_str("  ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subjects(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    fn log(lines: &[&str]) -> Changelog {
        let s = subjects(lines);
        from_commits(&s, s.len())
    }

    #[test]
    fn a_conventional_subject_splits_into_a_scope_and_a_summary() {
        let got = log(&["fix(media): never let a sender's own words name a file on disk"]);
        assert_eq!(got.groups.len(), 1);
        assert_eq!(got.groups[0].title, "Fixed");
        assert_eq!(
            got.groups[0].changes[0],
            Change {
                scope: Some("media".into()),
                summary: "never let a sender's own words name a file on disk".into(),
                breaking: false,
                body: None,
            }
        );
    }

    #[test]
    fn a_type_without_a_scope_keeps_its_summary_alone() {
        let got = log(&["feat: join a meeting with a microphone"]);
        assert_eq!(got.groups[0].title, "New");
        assert_eq!(got.groups[0].changes[0].scope, None);
        assert_eq!(got.groups[0].changes[0].summary, "join a meeting with a microphone");
    }

    /// The reader's order: what is new, then what is repaired, then the rest. It is the
    /// whole reason `TYPES` is a table and not a map.
    #[test]
    fn groups_come_in_the_order_a_reader_wants_them() {
        let got = log(&[
            "docs(calling): map video and screen sharing",
            "chore: bump a dependency",
            "fix(media): keep the open picture's own right-click",
            "feat(calendar): join a meeting from an event",
            "perf(history): stop measuring every row twice",
        ]);
        let titles: Vec<&str> = got.groups.iter().map(|g| g.title.as_str()).collect();
        assert_eq!(titles, vec!["New", "Fixed", "Faster", "Documented", "Housekeeping"]);
    }

    /// Newest first inside a group, because that is the order the commits arrive in and
    /// the order somebody scanning "Fixed" is asking for.
    #[test]
    fn a_group_keeps_the_newest_change_first() {
        let got = log(&["fix: the newer one", "fix: the older one"]);
        let summaries: Vec<&str> =
            got.groups[0].changes.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["the newer one", "the older one"]);
    }

    /// Two types share one heading, and they must share one GROUP — not print it twice.
    #[test]
    fn types_that_share_a_heading_share_one_group() {
        let got = log(&["refactor(store): one query", "style(web): sort the imports"]);
        assert_eq!(got.groups.len(), 1);
        assert_eq!(got.groups[0].title, "Reworked");
        assert_eq!(got.groups[0].changes.len(), 2);
    }

    /// A breaking change is lifted above everything, whatever type declared it — a reader
    /// must not have to scroll to find the one entry that can cost them something.
    #[test]
    fn a_breaking_change_comes_first_and_says_so() {
        let got = log(&["fix: an ordinary one", "feat(protocol)!: rename every event"]);
        assert_eq!(got.groups[0].title, "Breaking");
        assert!(got.groups[0].changes[0].breaking);
        assert_eq!(got.groups[0].changes[0].scope.as_deref(), Some("protocol"));
        assert_eq!(got.groups[1].title, "Fixed");
    }

    /// A subject written outside the convention is still a change. Keeping it whole is the
    /// point: cutting at a colon in prose would rewrite what somebody said.
    #[test]
    fn a_subject_outside_the_convention_keeps_its_own_words() {
        let got = log(&["note: this is prose, not a type", "no colon at all here"]);
        assert_eq!(got.groups.len(), 1);
        assert_eq!(got.groups[0].title, "Other");
        let summaries: Vec<&str> =
            got.groups[0].changes.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["note: this is prose, not a type", "no colon at all here"]);
    }

    // ---- the body: most of what an author wrote -------------------------------

    /// The reason this module exists in its present shape. Measured over 20 commits of
    /// master: 1 501 bytes of subject against 22 171 bytes of body, and the body used to
    /// reach nobody at all.
    #[test]
    fn the_paragraphs_under_a_subject_travel_as_the_body() {
        let got = log(&[
            "fix(web): the mention list activates a row on mousemove\n\nA bare \"@\" opens \
             the list over the field the reader just clicked.\n\nSo a row appearing beneath \
             a STATIONARY cursor took the active row away from the keyboard.",
        ]);
        assert_eq!(
            got.groups[0].changes[0].body.as_deref(),
            Some(
                "A bare \"@\" opens the list over the field the reader just clicked.\n\nSo a \
                 row appearing beneath a STATIONARY cursor took the active row away from the \
                 keyboard."
            )
        );
    }

    /// Only whitespace is touched: a run of blank lines becomes one, and the blank line
    /// `%s%n%b` leaves between the subject and the body is not a paragraph break of its own.
    #[test]
    fn a_body_is_whitespace_normalised_and_nothing_more() {
        let got = log(&["fix: one\n\n\n\nfirst   \n\n\n\nsecond \t\n\n"]);
        assert_eq!(got.groups[0].changes[0].body.as_deref(), Some("first\n\nsecond"));
    }

    /// "Has a body" and "has words" must be the same question at every call site.
    #[test]
    fn a_body_of_nothing_is_none() {
        assert_eq!(log(&["fix: one\n\n   \n\t\n"]).groups[0].changes[0].body, None);
        assert_eq!(log(&["fix: one"]).groups[0].changes[0].body, None);
    }

    /// A subject outside the convention keeps its body too: the words under it are the
    /// author's whether or not this module could classify the line above them.
    #[test]
    fn a_subject_outside_the_convention_keeps_its_body() {
        let got = log(&["no colon at all here\n\nand a paragraph under it"]);
        assert_eq!(got.groups[0].title, "Other");
        assert_eq!(got.groups[0].changes[0].body.as_deref(), Some("and a paragraph under it"));
    }

    #[test]
    fn a_merge_commit_is_not_a_change() {
        let got = log(&["Merge pull request #3 from a/b", "fix: a real change"]);
        assert_eq!(got.groups.len(), 1);
        assert_eq!(got.total, 1, "a merge is not counted either");
    }

    /// The cap bounds the payload, and what it drops is COUNTED — a list that silently
    /// stops reads as a complete one.
    #[test]
    fn the_cap_is_stated_rather_than_silent() {
        let many: Vec<String> = (0..MAX_CHANGES + 5).map(|i| format!("fix: number {i}")).collect();
        let got = from_commits(&many, many.len());
        assert_eq!(got.groups[0].changes.len(), MAX_CHANGES);
        assert_eq!(got.total, MAX_CHANGES + 5);
        assert_eq!(got.omitted, 5);
    }

    /// GitHub's compare API stops at 250 commits but states the real total, so a caller
    /// that knows more happened than it was handed can say so.
    #[test]
    fn a_total_the_caller_knows_beats_what_it_was_handed() {
        let s = subjects(&["fix: the only one we were given"]);
        let got = from_commits(&s, 400);
        assert_eq!(got.total, 400);
        assert_eq!(got.omitted, 399);
    }

    #[test]
    fn no_commits_is_an_empty_changelog() {
        let got = from_commits(&[], 0);
        assert!(got.is_empty());
        assert_eq!(to_markdown(&got), "No changes.");
    }

    #[test]
    fn markdown_is_a_heading_and_a_bullet_per_change() {
        let got = log(&["feat(calendar): join a meeting", "fix: a small one"]);
        let md = to_markdown(&got);
        assert_eq!(
            md,
            "### New\n\n- **calendar** — join a meeting\n\n### Fixed\n\n- a small one"
        );
    }

    /// The page has the room, so it renders what the author wrote — indented to belong to
    /// its own bullet, because an unindented continuation line is a paragraph of the LIST
    /// and no longer says which change it is about.
    #[test]
    fn markdown_renders_the_body_under_its_own_bullet() {
        let md = to_markdown(&log(&["feat(calendar): join a meeting\n\nwhy\n\nand why not"]));
        assert_eq!(
            md,
            "### New\n\n- **calendar** — join a meeting\n\n  why\n\n  and why not"
        );
    }

    /// The budget bounds the PAGE — GitHub refuses a release body over 125 000 characters,
    /// and a build that publishes no notes is worse than one that publishes short ones. What
    /// it must never do is cut a paragraph in half, so an entry carries all of its body or
    /// none, and the first that does not fit ends the prose for the rest of the page.
    #[test]
    fn the_budget_ends_the_prose_rather_than_cutting_one() {
        let long = "x".repeat(MAX_BODY_BYTES - 10);
        let first = format!("feat: the first one\n\n{long}");
        let got = log(&[
            first.as_str(),
            "feat: the second one\n\nshort enough on its own",
            "feat: the third one\n\nalso short",
        ]);
        let md = to_markdown(&got);
        assert!(md.contains(&format!("  {long}")), "the first entry's body fits");
        assert!(
            !md.contains("short enough on its own") && !md.contains("also short"),
            "once the page runs out, every later entry is its summary alone: {}",
            md.len()
        );
        // And the changes themselves are all still on the page. A budget bounds the prose,
        // never the list — dropping an entry is what `omitted` is for, and it says so.
        for summary in ["the first one", "the second one", "the third one"] {
            assert!(md.contains(summary), "{summary} is missing");
        }
    }

    /// A reader opening a release page is asking what changed for THEM. A refactor alters no
    /// behaviour, a test proves what already shipped: folded, they stop standing between the
    /// reader and the features — and they are still on the page, one press away.
    #[test]
    fn development_work_is_folded_under_what_the_reader_can_see() {
        let md = to_markdown(&log(&[
            "test(emoji): pin the sort",
            "refactor(store): one query",
            "feat(calendar): join a meeting",
        ]));
        let (visible, hidden) = md.split_once("<details>").expect("a disclosure");
        assert!(visible.contains("### New") && visible.contains("join a meeting"));
        assert!(!visible.contains("### Tests") && !visible.contains("### Reworked"));
        assert!(hidden.contains(DEVELOPMENT_SUMMARY));
        assert!(hidden.contains("### Reworked") && hidden.contains("### Tests"));
        assert!(hidden.contains("</details>"));
        // The blank line after `<summary>` is what makes GitHub render the markdown inside
        // the block instead of printing it.
        assert!(hidden.contains(&format!("<summary>{DEVELOPMENT_SUMMARY}</summary>\n\n")));
    }

    /// The one case the fold is wrong. Housekeeping is why a release exists on a day nobody
    /// shipped a feature, and a page whose whole content is folded reads as an empty page.
    #[test]
    fn development_work_stands_open_when_it_is_all_there_is() {
        let md = to_markdown(&log(&["test(emoji): pin the sort", "chore: bump a dependency"]));
        assert!(!md.contains("<details>"), "{md}");
        assert!(md.starts_with("### Tests"), "{md}");
        assert!(md.contains("### Housekeeping"));
    }

    /// A revert takes away something the reader HAD, so it belongs with the changes they can
    /// see rather than behind the fold with the work.
    #[test]
    fn a_revert_is_something_the_reader_can_see() {
        let md = to_markdown(&log(&["revert: take back the jumbo emoji", "chore: bump a dep"]));
        let (visible, _) = md.split_once("<details>").expect("a disclosure");
        assert!(visible.contains("### Reverted"), "{md}");
    }

    /// A subject this module could not classify may say anything, so hiding it on the
    /// strength of a missing prefix would fold away a real change.
    #[test]
    fn an_unclassified_change_is_never_folded_away() {
        let md = to_markdown(&log(&["hotfix the thing by hand", "chore: bump a dep"]));
        let (visible, _) = md.split_once("<details>").expect("a disclosure");
        assert!(visible.contains("### Other") && visible.contains("hotfix the thing by hand"));
    }

    #[test]
    fn markdown_states_what_it_left_out() {
        let s = subjects(&["fix: one"]);
        let md = to_markdown(&from_commits(&s, 3));
        assert!(md.ends_with("_and 2 more commits._"), "{md}");
    }

    /// The rule the button obeys too (web/src/lib/update.ts): a commit id is a fault code
    /// to the person reading it, and it is not what they asked. So what this module
    /// publishes is the author's words and two counts — nothing that names a build.
    ///
    /// It also pins the BODY out of the payload. The app's list is a hover panel over a
    /// sidebar and a paragraph an entry is a wall of text in it, while 200 changes of prose
    /// is a 400 KB message on a socket built for JSON. The release page is the surface with
    /// the room, and `to_markdown` is the only reader of that field.
    ///
    /// Pinned on the SERIALIZED shape rather than on the source, because the payload is
    /// what reaches the app: a field added here would travel whatever the comments say.
    #[test]
    fn what_travels_to_the_app_names_no_build() {
        let got = log(&[
            "feat(protocol)!: one\n\nand a paragraph the panel has no room for",
            "fix: two",
        ]);
        assert!(got.groups[0].changes[0].body.is_some(), "the body was read");
        let json: serde_json::Value = serde_json::to_value(&got).unwrap();

        let mut top: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        top.sort();
        assert_eq!(top, vec!["groups", "omitted", "total"]);

        let mut group: Vec<&str> =
            json["groups"][0].as_object().unwrap().keys().map(String::as_str).collect();
        group.sort();
        assert_eq!(group, vec!["changes", "title"]);

        let mut change: Vec<&str> = json["groups"][0]["changes"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        change.sort();
        assert_eq!(change, vec!["breaking", "scope", "summary"]);

        // And an ordinary change carries neither of the two optional fields, so the
        // common entry on the wire is one word-bearing key.
        let plain = &json["groups"][1]["changes"][0];
        assert_eq!(plain.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["summary"]);
    }
}

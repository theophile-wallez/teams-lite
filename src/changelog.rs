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

/// One change: what it touched, and what it says.
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
/// The order is by what the reader gains: what is new, what is repaired, what got faster,
/// then the changes that alter no behaviour at all. `docs` is last of the real work and
/// housekeeping after it, because "the calendar plane is documented" is not why anybody
/// takes an update — but it IS why a release exists on a day nobody shipped a feature, so
/// it is never dropped. Anything unrecognised falls to [`OTHER`], which is what keeps a
/// commit written outside the convention in the list rather than out of it.
const TYPES: &[(&str, &str)] = &[
    ("feat", "New"),
    ("fix", "Fixed"),
    ("perf", "Faster"),
    ("refactor", "Reworked"),
    ("style", "Reworked"),
    ("docs", "Documented"),
    ("test", "Tests"),
    ("chore", "Housekeeping"),
    ("build", "Housekeeping"),
    ("ci", "Housekeeping"),
    ("revert", "Reverted"),
];

/// The heading for a commit that declared no type this module knows.
const OTHER: &str = "Other";

/// The heading breaking changes are lifted to, above everything else.
const BREAKING: &str = "Breaking";

/// Group commit subjects into a changelog.
///
/// `subjects` are the first lines of the commits between the two builds, newest first —
/// which is the order GitHub's compare API and `git log` both hand over, and the order
/// they stay in inside each group: a reader scanning "Fixed" wants the newest fix first.
/// `total` is how many commits there really were, so a caller that already knows GitHub
/// truncated its own answer can say so; pass `subjects.len()` when it did not.
///
/// Merge commits are dropped. They say who merged what, never what changed, and this
/// project's own history is linear anyway — so one in the list is noise from a branch
/// somebody landed by hand.
pub fn from_commits(subjects: &[String], total: usize) -> Changelog {
    let mut kept: Vec<(usize, Change)> = Vec::new();
    let mut counted = 0usize;

    for subject in subjects.iter().filter(|s| !is_merge(s)) {
        counted += 1;
        if kept.len() >= MAX_CHANGES {
            continue;
        }
        kept.push(parse(subject));
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
    let hidden = total.saturating_sub(subjects.len());
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

/// Read one commit subject as a change, with its group's rank.
///
/// `type(scope)!: summary` is the shape; everything about it is optional in practice, and
/// a subject that is none of it is still a change — it goes to [`OTHER`] with its words
/// untouched. Nothing is capitalised or re-punctuated: these are the author's sentences,
/// and this project writes them lower case on purpose.
fn parse(subject: &str) -> (usize, Change) {
    let subject = subject.trim();
    let Some((head, summary)) = subject.split_once(':') else {
        return (TYPES.len(), Change { scope: None, summary: subject.to_string(), breaking: false });
    };
    let head = head.trim();
    // A colon inside prose ("note: this") must not read as a type. A conventional head is
    // one word, optionally with a parenthesised scope, and nothing else.
    if head.is_empty() || head.len() > 40 || head.contains(' ') {
        return (TYPES.len(), Change { scope: None, summary: subject.to_string(), breaking: false });
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
        Some(i) => (first_rank_of_title(TYPES[i].1), Change { scope, summary, breaking }),
        // Not one of ours: keep the WHOLE subject, because the part before the colon is
        // then somebody's prose and cutting it would change what they wrote.
        None => (
            TYPES.len(),
            Change { scope: None, summary: subject.to_string(), breaking },
        ),
    }
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
pub fn to_markdown(log: &Changelog) -> String {
    if log.is_empty() {
        return "No changes.".to_string();
    }
    let mut out = String::new();
    for group in &log.groups {
        out.push_str(&format!("### {}\n\n", group.title));
        for change in &group.changes {
            match &change.scope {
                Some(scope) => out.push_str(&format!("- **{scope}** — {}\n", change.summary)),
                None => out.push_str(&format!("- {}\n", change.summary)),
            }
        }
        out.push('\n');
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
    /// Pinned on the SERIALIZED shape rather than on the source, because the payload is
    /// what reaches the app: a field added here would travel whatever the comments say.
    #[test]
    fn what_travels_to_the_app_names_no_build() {
        let got = log(&["feat(protocol)!: one", "fix: two"]);
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

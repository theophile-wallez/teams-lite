//! Render a release body from commit subjects on stdin. CI's half of `src/changelog.rs`.
//!
//! It exists so the release notes on github.com and the list the update button shows are
//! the SAME list, grouped by the same code. The alternative was an awk pipeline in
//! .github/workflows/build.yml beside the Rust grouper, which is two spellings of one
//! thing — drifting apart at the first commit type nobody thought of.
//!
//! It talks to nothing. One read of stdin, one write to stdout, no network and no tenant,
//! which is what makes it safe to run from a workflow:
//!
//!     git log --no-merges --pretty=format:%s "$prev..$GITHUB_SHA" \
//!       | cargo run --quiet --example changelog
//!
//! The commit that a release was built from is NOT printed here. It is added by the
//! workflow, once, on its own line — `src/update.rs` reads it back out of the notes when
//! GitHub resolves `target_commitish` to a branch name, so it has to be exactly one
//! 40-character run and nothing near a commit subject can be mistaken for it.

use std::io::Read as _;

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        // Nothing readable on stdin is not a failure: a release with no changelog is
        // better than no release, and the workflow must not fail on it.
        println!("No changes.");
        return;
    }
    let subjects: Vec<String> = input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    let log = teams_lite::changelog::from_commits(&subjects, subjects.len());
    println!("{}", teams_lite::changelog::to_markdown(&log));
}

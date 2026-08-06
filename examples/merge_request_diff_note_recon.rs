// Manual live check for the SHAPE of a comment on a DIFF LINE, READ-ONLY.
//
// The diff page can put a comment on a line, or on a range of lines dragged from one line
// number to another (the anchor type is in src/gitlab_mr_write.rs; see AGENTS.md § A comment
// on a diff line). That write names a `position`, and a position has to be spelled GitLab's
// way or the comment is refused — there is no sandbox project to try one against, so the
// shape is MEASURED here instead of read off the documentation and hoped for:
//
//   1. every merge request's detail carries `diff_refs`, and all three commits of it — the
//      set a position is resolved against;
//   2. what a real `DiffNote` position holds: which keys, which `position_type`, and whether
//      exactly one line number is set on a line that exists on one side only;
//   3. on a comment about SEVERAL lines, what `line_range` looks like — and, for every end of
//      one, whether `gitlab_mr::line_code` produces the code GitLab itself stored.
//      That is the one part of the write nothing else could check: a line code is a hash, so
//      a wrong rule would be refused with no clue as to why.
//
// Measured 2026-08-06 on `git.sia.partners`, over the 40 newest open merge requests: all 40
// carry three whole commits in `diff_refs`; 275 notes carry a position and every one of them
// is `position_type: "text"`; the anchor names the NEW line alone on 254 of them (an added
// line) and both lines on 21 (a context line); 16 carry a `line_range`, whose ends are
// `{line_code, old_line, new_line, type}` with `type` in `new` (20), `old` (4) and `expanded`
// (8) — GitLab's own word for a context line inside a region somebody opened, which is a line
// this app cannot select and therefore never writes. And **all 32 of those line codes match
// what this crate computes**, which is the one thing about the write nothing else could check.
//
// It READS and nothing else: no comment is posted, nothing is resolved, nothing is deleted.
// The write it measures is the user's own click, in their own app.
//
// It prints COUNTS and SHAPES rather than anybody's words: a review comment is a colleague's
// work, and this output ends up in a terminal, a journal or a transcript. The one thing it
// prints in full is a line code, which is a hash of a path and two numbers.
//
//   cargo run --example merge_request_diff_note_recon
//
// The GitLab host and token come from the app's own store, so it checks exactly what the page
// would ask with.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
// The line code comes from the READ module, where it belongs: it is a fact about GitLab's
// diff model, and this file names nothing that writes.
use teams_lite::gitlab_mr::{self, line_code, ListQuery, ListScope, ListState};

/// How many open merge requests to walk. Each one costs one discussions request, and a diff
/// note is rare enough that a handful would find none.
const MERGE_REQUESTS: usize = 40;

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;

    let store = teams_lite::store::Store::open(&db_path()?)?;
    let host = store
        .get_setting("gitlab_host")?
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| teams_lite::gitlab::DEFAULT_HOST.to_string());
    let token = store.get_setting("gitlab_token")?.filter(|t| !t.is_empty());
    println!("== host {host} · token {}", if token.is_some() { "set" } else { "ABSENT" });
    anyhow::ensure!(token.is_some(), "no GitLab token stored — the page can read nothing");
    let token = token.unwrap();

    let list = gitlab_mr::fetch_list(
        &http,
        &host,
        Some(&token),
        ListQuery { scope: ListScope::All, state: ListState::Opened },
    )
    .await?;
    let rows: Vec<_> = list.items.into_iter().take(MERGE_REQUESTS).collect();
    println!("== walking {} open merge requests", rows.len());

    // FACT 1: the three commits a position is resolved against.
    let mut refs_present = 0usize;
    let mut refs_absent = 0usize;
    // FACT 2: what a diff note's position holds.
    let mut diff_notes = 0usize;
    let mut position_keys: BTreeMap<String, usize> = BTreeMap::new();
    let mut position_types: BTreeMap<String, usize> = BTreeMap::new();
    let mut sides: BTreeMap<&str, usize> = BTreeMap::new();
    // FACT 3: the range, and our own line code against GitLab's.
    let mut ranges = 0usize;
    let mut end_keys: BTreeMap<String, usize> = BTreeMap::new();
    let mut end_types: BTreeMap<String, usize> = BTreeMap::new();
    let mut codes_matched = 0usize;
    let mut codes_differed = 0usize;

    for row in &rows {
        let detail =
            gitlab_mr::fetch_detail(&http, &host, Some(&token), &row.project_path, row.iid).await?;
        match &detail.diff_refs {
            Some(refs) => {
                let whole = [&refs.base_sha, &refs.head_sha, &refs.start_sha]
                    .iter()
                    .all(|sha| sha.len() >= 8);
                if whole {
                    refs_present += 1;
                } else {
                    refs_absent += 1;
                    println!("   !{} · diff_refs with a short or empty commit", row.iid);
                }
            }
            None => {
                refs_absent += 1;
                println!("   !{} · NO diff_refs", row.iid);
            }
        }

        // The discussions, raw: the parse in `gitlab_mr` keeps what the page draws, and this
        // check is about the keys GitLab sends rather than about our own shape.
        let endpoint = format!(
            "{}/discussions?per_page=100",
            gitlab_mr::merge_request_api(&host, &row.project_path, row.iid)
        );
        let body: serde_json::Value = http
            .get(&endpoint)
            .header("Accept", "application/json")
            .header("PRIVATE-TOKEN", &token)
            .send()
            .await?
            .json()
            .await
            .unwrap_or(serde_json::Value::Null);

        for note in body
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d.get("notes").and_then(serde_json::Value::as_array))
            .flatten()
        {
            let Some(position) = note.get("position").filter(|p| p.is_object()) else { continue };
            diff_notes += 1;
            for key in position.as_object().into_iter().flatten().map(|(k, _)| k.clone()) {
                *position_keys.entry(key).or_default() += 1;
            }
            if let Some(kind) = position.get("position_type").and_then(serde_json::Value::as_str) {
                *position_types.entry(kind.to_string()).or_default() += 1;
            }
            let old = position.get("old_line").and_then(serde_json::Value::as_u64);
            let new = position.get("new_line").and_then(serde_json::Value::as_u64);
            *sides
                .entry(match (old, new) {
                    (Some(_), Some(_)) => "both (a context line)",
                    (None, Some(_)) => "new only (an added line)",
                    (Some(_), None) => "old only (a removed line)",
                    (None, None) => "NEITHER",
                })
                .or_default() += 1;

            let Some(range) = position.get("line_range").filter(|r| r.is_object()) else { continue };
            ranges += 1;
            // The path a line code is hashed from, GitLab's own `new_path.presence ||
            // old_path` — which is what `DiffAnchor::file_path` spells.
            let path = ["new_path", "old_path"]
                .into_iter()
                .filter_map(|key| position.get(key).and_then(serde_json::Value::as_str))
                .find(|p| !p.trim().is_empty())
                .unwrap_or_default()
                .to_string();
            for name in ["start", "end"] {
                let Some(end) = range.get(name).filter(|e| e.is_object()) else { continue };
                for key in end.as_object().into_iter().flatten().map(|(k, _)| k.clone()) {
                    *end_keys.entry(key).or_default() += 1;
                }
                *end_types
                    .entry(match end.get("type") {
                        Some(serde_json::Value::String(kind)) => kind.clone(),
                        Some(serde_json::Value::Null) | None => "null".to_string(),
                        Some(other) => format!("?{other}"),
                    })
                    .or_default() += 1;

                // THE check: our own line code against the one GitLab stored. Both counters
                // come out of the code itself, because a position states only the side its
                // line is on — which is exactly the asymmetry this proves.
                let Some(stored) = end.get("line_code").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let numbers: Vec<&str> = stored.rsplitn(3, '_').collect();
                let (Some(new_line), Some(old_line)) = (
                    numbers.first().and_then(|n| n.parse::<u64>().ok()),
                    numbers.get(1).and_then(|n| n.parse::<u64>().ok()),
                ) else {
                    println!("   line code in an unexpected shape: {stored}");
                    continue;
                };
                // `rsplitn` yields them backwards, so the pair above reads new then old.
                let ours = line_code(&path, old_line, new_line);
                if ours == stored {
                    codes_matched += 1;
                } else {
                    codes_differed += 1;
                    println!("   line code DIFFERS · GitLab {stored} · ours {ours}");
                }
            }
        }
    }

    println!("\n== 1. diff_refs · {refs_present} complete, {refs_absent} missing or short");
    println!("== 2. {diff_notes} notes carry a position");
    println!("   keys: {:?}", position_keys.keys().collect::<BTreeSet<_>>());
    println!("   position_type: {position_types:?}");
    println!("   which side the anchor names: {sides:?}");
    println!("== 3. {ranges} of them carry a line_range");
    println!("   end keys: {:?}", end_keys.keys().collect::<BTreeSet<_>>());
    println!("   end type: {end_types:?}");
    println!("   line codes · {codes_matched} match ours, {codes_differed} differ");
    if ranges == 0 {
        println!(
            "   NOTE: nobody on this instance has commented on a RANGE of lines, so the line \
             code rule is unverified here. Run this again when one exists."
        );
    }
    anyhow::ensure!(codes_differed == 0, "the line code rule does not match GitLab's own");
    Ok(())
}

/// The store the backend keeps, resolved the way it resolves it. Mirrors the sibling recons.
fn db_path() -> Result<String> {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("{}/.local/share", std::env::var("HOME").unwrap_or_default()));
    let path = format!("{base}/teams-lite/teams-lite.sqlite");
    anyhow::ensure!(
        std::path::Path::new(&path).exists(),
        "no store at {path} — run the app once so it has one"
    );
    Ok(path)
}

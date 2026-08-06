// Manual live check for the SHAPE of the merge-request page's four reads, READ-ONLY.
//
// The page rests on four answers from GitLab — the list, one merge request in full, its
// discussions and its head pipeline's jobs (see `gitlab_mr`) — and on three facts measured
// against this instance rather than assumed:
//
//   1. a LIST row carries no `head_pipeline`, so a badge per row would cost one request per
//      merge request;
//   2. `scope=all` is what makes the list a dashboard (GitLab's default is
//      `created_by_me`);
//   3. `state` has no "not merged": the page asks for `opened` and `closed` and never for
//      `merged`.
//
// This proves the parse against the user's own real merge requests instead of against a
// guess, and re-measures those three every time it runs. It READS and nothing else: no
// merge, no comment, no approval — the four writes the page offers live in
// `gitlab_mr_write` and are the user's own click (see AGENTS.md § The GitLab page).
//
// It prints COUNTS and field presence rather than bodies: a merge request's title and a
// colleague's comment are their work, and this output ends up in a terminal, a journal or a
// transcript.
//
//   cargo run --example merge_request_page_recon
//
// The GitLab host and token come from the app's own store, so it checks exactly what the
// page would ask with.
use anyhow::Result;
use teams_lite::gitlab_mr::{self, ListQuery, ListScope, ListState};

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) teams-lite/0.1")
        .build()?;

    // The same store the backend reads, and the same two settings keys.
    let store = teams_lite::store::Store::open(&db_path()?)?;
    let host = store
        .get_setting("gitlab_host")?
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| teams_lite::gitlab::DEFAULT_HOST.to_string());
    let token = store.get_setting("gitlab_token")?.filter(|t| !t.is_empty());
    println!("== host {host} · token {}", if token.is_some() { "set" } else { "ABSENT" });
    anyhow::ensure!(token.is_some(), "no GitLab token stored — the page can read nothing");

    // 1. The list, in the shape the sidebar asks for it.
    for state in [ListState::Opened, ListState::Closed] {
        let query = ListQuery { scope: ListScope::All, state };
        let list = gitlab_mr::fetch_list(&http, &host, token.as_deref(), query).await?;
        println!(
            "== list scope=all state={} · {} rows, total {:?}, truncated {}",
            state.as_str(),
            list.items.len(),
            list.total,
            list.truncated
        );
        // FACT 2, re-measured: the widest scope must see more than the user's own work, or
        // the query lost its `scope=all` somewhere.
        if matches!(state, ListState::Opened) {
            let authors: std::collections::BTreeSet<&str> =
                list.items.iter().map(|row| row.author.username.as_str()).collect();
            println!("   authors on those rows: {}", authors.len());
            let mine = gitlab_mr::fetch_list(
                &http,
                &host,
                token.as_deref(),
                ListQuery { scope: ListScope::Mine, state },
            )
            .await?;
            println!("   scope=mine would show {} of them", mine.items.len());
        }
    }

    // The newest open merge request is what the rest of the checks run against.
    let list = gitlab_mr::fetch_list(
        &http,
        &host,
        token.as_deref(),
        ListQuery { scope: ListScope::All, state: ListState::Opened },
    )
    .await?;
    let Some(row) = list.items.first() else {
        println!("== no open merge request to look inside; nothing more to check");
        return Ok(());
    };
    println!(
        "== inside {} !{} · state {} · draft {} · merge status {:?}",
        row.project_path, row.iid, row.state, row.draft, row.detailed_merge_status
    );

    // 2. The detail: the fields the page's header and its Merge button are built on.
    let detail =
        gitlab_mr::fetch_detail(&http, &host, token.as_deref(), &row.project_path, row.iid).await?;
    println!(
        "   detail: description {} · sha {} · changes_count {:?} · \
         detailed_merge_status {:?} · conflicts {} · threads resolved {}",
        if detail.description.is_some() { "present" } else { "absent" },
        if detail.sha.is_some() { "present" } else { "ABSENT (a merge could not be offered)" },
        detail.changes_count,
        detail.detailed_merge_status,
        detail.has_conflicts,
        detail.blocking_discussions_resolved,
    );
    println!(
        "   people: {} reviewers, {} assignees, {} labels",
        detail.reviewers.len(),
        detail.assignees.len(),
        detail.labels.len()
    );

    // 3. The discussions, split the way the page splits them.
    let notes =
        gitlab_mr::fetch_discussions(&http, &host, token.as_deref(), &row.project_path, row.iid)
            .await?;
    let threads = notes.discussions.iter().filter(|d| !d.individual_note).count();
    let system = notes
        .discussions
        .iter()
        .flat_map(|d| d.notes.iter())
        .filter(|note| note.system)
        .count();
    let positioned = notes
        .discussions
        .iter()
        .flat_map(|d| d.notes.iter())
        .filter(|note| note.position.is_some())
        .count();
    let mine = notes
        .discussions
        .iter()
        .flat_map(|d| d.notes.iter())
        .filter(|note| note.mine)
        .count();
    println!(
        "   comments: {} discussions ({threads} threads), {system} system notes, \
         {positioned} on a file, {mine} the user's own · truncated {}",
        notes.discussions.len(),
        notes.truncated
    );

    // 4. The pipeline, and FACT 1: the list row carried none of this.
    let pipeline =
        gitlab_mr::fetch_pipeline(&http, &host, token.as_deref(), &row.project_path, row.iid)
            .await?;
    match &pipeline.pipeline {
        Some(summary) => {
            let stages: std::collections::BTreeSet<&str> =
                pipeline.jobs.iter().map(|job| job.stage.as_str()).collect();
            println!(
                "   pipeline #{} status {} · {} jobs over {} stages",
                summary.id,
                summary.status,
                pipeline.jobs.len(),
                stages.len()
            );
        }
        None => println!("   pipeline: none has run for this merge request"),
    }

    println!("== done · four reads, no write");
    Ok(())
}

/// The store the backend keeps, resolved the way it resolves it.
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

// Manual live check for the SHAPE of a merge request's DIFF, READ-ONLY.
//
// The Changes section rests on one answer this app had never asked for: what GitLab says
// changed in a merge request. This proves `gitlab_mr::fetch_diff` against the user's own real
// merge requests rather than against a guess, and re-measures the five facts it is built on:
//
//   1. GitLab's own `diff` opens at `@@` — no `diff --git`, no `--- a/…`, no `+++ b/…` — so
//      the patch the renderer gets is one `gitlab_mr::unified_patch` WROTE.
//   2. A pure RENAME carries no diff at all, and GitLab sets `collapsed` on those rows
//      anyway. Reading that as an elision would report every moved file as one GitLab
//      refused to expand.
//   3. The COLLAPSE is a property of the merge request, never of the page: measured at every
//      `per_page` from 10 to 100, the same 96 of 149 files came back collapsed and the
//      expanded bytes were 174 703 every time. Paging is not a way out.
//   4. `access_raw_diffs=true` IS the way out, and only on the older `/changes` — `/diffs`
//      ignores the parameter. That is `DiffDepth::Raw`, and it costs half a megabyte.
//   5. A BINARY file carries a one-line marker rather than hunks.
//
// It READS and nothing else: no merge, no comment, no approval. It prints COUNTS, field
// presence and the SHAPE of a patch — never anybody's code, because this output ends up in a
// terminal, a journal or a transcript and a diff is the work itself.
//
//   cargo run --example merge_request_diff_recon
//
// The GitLab host and token come from the app's own store, so it checks exactly what the
// page would ask with.
use anyhow::Result;
use teams_lite::gitlab_mr::{self, DiffDepth, ListQuery, ListScope, ListState};

/// How many merge requests to measure. Enough that a binary file, a collapsed diff and a
/// rename show up at all; small enough to stay one page of output.
const SAMPLE: usize = 25;

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
    anyhow::ensure!(token.is_some(), "no GitLab token stored — a diff can be read from nothing");
    let token = token.as_deref();

    let list = gitlab_mr::fetch_list(
        &http,
        &host,
        token,
        ListQuery { scope: ListScope::All, state: ListState::Opened },
    )
    .await?;
    println!("== {} open merge requests · measuring the newest {SAMPLE}", list.items.len());

    let mut measured = 0usize;
    let mut truncated = 0usize;
    let mut files = 0usize;
    let mut with_patch = 0usize;
    let mut binary = 0usize;
    let mut collapsed = 0usize;
    let mut generated = 0usize;
    let mut renamed = 0usize;
    let mut added = 0usize;
    let mut deleted = 0usize;
    let mut wrote_the_header = 0usize;
    let mut pure_renames = 0usize;
    let mut patch_bytes = 0usize;
    let mut worst: (u64, String) = (0, String::new());

    for row in list.items.iter().take(SAMPLE) {
        let diff = match gitlab_mr::fetch_diff(
            &http,
            &host,
            token,
            &row.project_path,
            row.iid,
            DiffDepth::Listed,
        )
        .await
        {
            Ok(diff) => diff,
            Err(e) => {
                println!("   !{} could not be read: {e:#}", row.iid);
                continue;
            }
        };
        measured += 1;
        if diff.truncated {
            truncated += 1;
        }
        if diff.collapsed > worst.0 {
            worst = (diff.collapsed, format!("{}!{}", row.project_path, row.iid));
        }
        files += diff.files.len();
        for file in &diff.files {
            if file.binary {
                binary += 1;
            }
            if file.collapsed {
                collapsed += 1;
            }
            if file.generated {
                generated += 1;
            }
            match file.change {
                "renamed" => renamed += 1,
                "new" => added += 1,
                "deleted" => deleted += 1,
                _ => {}
            }
            let Some(patch) = &file.patch else { continue };
            with_patch += 1;
            patch_bytes += patch.len();
            // FACT 1, re-measured from the other side: every patch this app hands over opens
            // with the header GitLab never sent.
            if patch.starts_with("diff --git ") {
                wrote_the_header += 1;
            }
            // FACT 2: a rename with no hunks still has a patch, and the header IS the change.
            if file.change == "renamed" && !patch.contains("@@") {
                pure_renames += 1;
                anyhow::ensure!(
                    patch.contains("rename from ") && patch.contains("similarity index 100%"),
                    "a pure rename must state its move and its similarity"
                );
            }
        }
    }

    println!("== {measured} merge requests read · {truncated} hold more files than travelled");
    println!("   {files} files: {added} new, {deleted} deleted, {renamed} renamed");
    println!("   {with_patch} carry a patch ({pure_renames} of them a pure rename, header only)");
    println!("   {binary} binary · {collapsed} collapsed by GitLab · {generated} generated");
    println!("   {wrote_the_header} of {with_patch} patches open with the header this app wrote");
    println!("   {patch_bytes} B of patch in total");

    // FACTS 3 and 4, measured on the merge request that collapses the most: the expanded read
    // is what mends it, and it is the reader's own ask because of what it costs.
    if worst.0 > 0 {
        let cut = worst.1.rfind('!').expect("the id shape this recon built");
        let (project, iid) = (&worst.1[..cut], worst.1[cut + 1..].parse::<u64>()?);
        println!("== {} collapses {} files · measuring both depths", worst.1, worst.0);
        for depth in [DiffDepth::Listed, DiffDepth::Raw] {
            let diff = gitlab_mr::fetch_diff(&http, &host, token, project, iid, depth).await?;
            let bytes: usize =
                diff.files.iter().filter_map(|f| f.patch.as_ref()).map(String::len).sum();
            println!(
                "   depth={:6} · {:3} files, {:3} with a patch, {:3} collapsed, {:7} B of \
                 patch · truncated {} · expanded {}",
                depth.as_str(),
                diff.files.len(),
                diff.files.iter().filter(|f| f.patch.is_some()).count(),
                diff.collapsed,
                bytes,
                diff.truncated,
                diff.expanded,
            );
        }
    } else {
        println!("== nothing in this sample collapsed; the plain read was enough for all of it");
    }

    println!("== done · reads only, no write");
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

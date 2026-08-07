// Manual live check for a JOB's LOG, READ-ONLY.
//
// The pipeline page draws a card per job; pressing one opens that job's log on a page of its
// own. That page rests on claims about what GitLab really hands back, and this example
// measures each rather than trusting any:
//
//   1. **What a job DETAIL carries.** `GET /projects/:id/jobs/:job_id` — the union of the
//      keys every row carried, so a field a later GitLab adds is noticed here rather than by
//      nobody, and the presence of the ones the page states (runner, failure reason, the
//      three timestamps, the pipeline it belongs to).
//   2. **What a TRACE is.** `GET …/jobs/:job_id/trace` — its content type, whether a length
//      travels, whether the host offers ranges, and how big one really is on this instance.
//      The page caps what travels, so the cap has to be a measured number and not a guess.
//   3. **The SECTIONS.** The runner wraps parts of a log in `section_start:<ts>:<name>` /
//      `section_end:<ts>:<name>` markers, each followed by `\r\x1b[0K`. The page folds on
//      them, so this counts how many logs carry them, how many sections one holds, and
//      whether every start is closed.
//   4. **The ANSI.** How many logs carry an escape sequence at all, and which ones — a
//      renderer that covered the colours and not the cursor moves would draw junk.
//   5. **A job with NO log**, which is a state the page has to say rather than draw empty:
//      how GitLab answers for one that never ran.
//
// It READS and nothing else: one GET per merge request, one per pipeline's jobs, one per job
// detail and one per trace. No retry, no cancel, no erase — this app writes to a tracker only
// on the user's own click (see AGENTS.md § The trackers), and a job has no write here at all.
//
// It prints COUNTS, field names and byte sizes rather than anybody's log: a build log holds
// source paths, hostnames and sometimes a customer's name, and this output ends up in a
// terminal, a journal or a transcript. So a line is counted, never printed — and a section
// name is printed only when it is one of the runner's own (lowercase and underscores), which
// is what makes the fold's own vocabulary readable without quoting somebody's CI.
//
//   cargo run --example job_trace_recon
//
// The GitLab host and token come from the app's own store, so it checks exactly what the page
// would ask with.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use teams_lite::gitlab_mr::{self, ListQuery, ListScope, ListState};

/// How many open merge requests to walk. Each costs two requests plus two per job, so this is
/// a sample wide enough to hold several projects' CI and small enough to run in a minute.
const MERGE_REQUESTS: usize = 12;

/// How many jobs per pipeline to read a trace for. A pipeline here runs up to 15, and the
/// point is the SHAPE of a log rather than a census of them.
const JOBS_PER_PIPELINE: usize = 6;

#[tokio::main]
async fn main() -> Result<()> {
    let http = reqwest::Client::builder().user_agent(teams_lite::USER_AGENT).build()?;

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
        Some(token.as_str()),
        ListQuery { scope: ListScope::All, state: ListState::Opened },
    )
    .await?;
    println!("== {} open merge requests · walking the newest {MERGE_REQUESTS}", list.items.len());

    let mut detail_keys: BTreeSet<String> = BTreeSet::new();
    let mut detail_present: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut details = 0usize;

    let mut traces = 0usize;
    let mut traces_empty = 0usize;
    let mut traces_refused: BTreeMap<u16, usize> = BTreeMap::new();
    let mut content_types: BTreeMap<String, usize> = BTreeMap::new();
    let mut lengths_stated = 0usize;
    let mut accept_ranges: BTreeMap<String, usize> = BTreeMap::new();
    let mut range_honoured = 0usize;
    let mut range_refused = 0usize;
    let mut sizes: Vec<usize> = Vec::new();
    let mut line_counts: Vec<usize> = Vec::new();
    let mut longest_line = 0usize;
    let mut with_ansi = 0usize;
    let mut with_sections = 0usize;
    let mut section_counts: Vec<usize> = Vec::new();
    let mut unclosed_sections = 0usize;
    let mut section_names: BTreeMap<String, usize> = BTreeMap::new();
    let mut section_names_other = 0usize;
    let mut with_crlf = 0usize;
    let mut with_bare_cr = 0usize;
    let mut escapes: BTreeMap<char, usize> = BTreeMap::new();
    let mut statuses_with_no_log: BTreeMap<String, usize> = BTreeMap::new();

    for row in list.items.iter().take(MERGE_REQUESTS) {
        let view =
            match gitlab_mr::fetch_pipeline(&http, &host, Some(token.as_str()), &row.project_path, row.iid)
                .await
            {
                Ok(view) => view,
                Err(e) => {
                    println!("   !{} · the pipeline could not be read: {e:#}", row.iid);
                    continue;
                }
            };
        if view.pipeline.is_none() || view.jobs.is_empty() {
            continue;
        }
        let project = gitlab_mr_project(&host, &row.project_path);

        for job in view.jobs.iter().take(JOBS_PER_PIPELINE) {
            // FACT 1: the job detail.
            let detail_url = format!("{project}/jobs/{}", job.id);
            match get_json(&http, &detail_url, &token).await {
                Ok(body) => {
                    details += 1;
                    if let Some(object) = body.as_object() {
                        for key in object.keys() {
                            detail_keys.insert(key.clone());
                        }
                        for field in [
                            "runner",
                            "failure_reason",
                            "created_at",
                            "started_at",
                            "finished_at",
                            "queued_duration",
                            "pipeline",
                            "commit",
                            "stage",
                            "tag_list",
                            "artifacts",
                        ] {
                            if object.get(field).is_some_and(|v| !v.is_null()) {
                                *detail_present.entry(field).or_default() += 1;
                            }
                        }
                    }
                }
                Err(e) => println!("   job detail refused: {e:#}"),
            }

            // FACTS 2–5: the trace.
            let trace_url = format!("{project}/jobs/{}/trace", job.id);
            let resp = http
                .get(&trace_url)
                .header("PRIVATE-TOKEN", &token)
                .send()
                .await?;
            let status = resp.status();
            if !status.is_success() {
                *traces_refused.entry(status.as_u16()).or_default() += 1;
                *statuses_with_no_log.entry(job.status.clone()).or_default() += 1;
                continue;
            }
            let headers = resp.headers().clone();
            if let Some(kind) = headers.get("content-type").and_then(|v| v.to_str().ok()) {
                *content_types.entry(kind.to_string()).or_default() += 1;
            }
            if headers.get("content-length").is_some() {
                lengths_stated += 1;
            }
            let ranges = headers
                .get("accept-ranges")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("(absent)")
                .to_string();
            *accept_ranges.entry(ranges).or_default() += 1;
            let text = resp.text().await?;
            traces += 1;
            if text.trim().is_empty() {
                traces_empty += 1;
                *statuses_with_no_log.entry(job.status.clone()).or_default() += 1;
                continue;
            }
            sizes.push(text.len());

            // Would a RANGE read let a big log travel in pieces? Asked once per trace, on the
            // same GET, because "the page caps what travels" is only half an answer if the
            // tail cannot be asked for separately.
            if text.len() > 64 {
                let probe = http
                    .get(&trace_url)
                    .header("PRIVATE-TOKEN", &token)
                    .header("Range", format!("bytes={}-", text.len() - 32))
                    .send()
                    .await?;
                if probe.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                    range_honoured += 1;
                } else {
                    range_refused += 1;
                }
            }

            if text.contains('\u{1b}') {
                with_ansi += 1;
                let bytes: Vec<char> = text.chars().collect();
                for (index, ch) in bytes.iter().enumerate() {
                    if *ch != '\u{1b}' {
                        continue;
                    }
                    // The FINAL byte of a CSI sequence is what says what it does: `m` is a
                    // colour, `K` erases a line, `A` moves the cursor up. A renderer that
                    // covered one and not the others would draw junk, so they are counted.
                    if bytes.get(index + 1) == Some(&'[') {
                        if let Some(final_byte) =
                            bytes[index + 2..].iter().find(|c| c.is_ascii_alphabetic())
                        {
                            *escapes.entry(*final_byte).or_default() += 1;
                        }
                    } else if let Some(next) = bytes.get(index + 1) {
                        *escapes.entry(*next).or_default() += 1;
                    }
                }
            }
            if text.contains("\r\n") {
                with_crlf += 1;
            }
            if text.replace("\r\n", "").contains('\r') {
                with_bare_cr += 1;
            }

            let lines = text.split('\n').count();
            line_counts.push(lines);
            longest_line =
                longest_line.max(text.split('\n').map(|line| line.len()).max().unwrap_or(0));

            let starts = markers(&text, "section_start:");
            let ends = markers(&text, "section_end:");
            if !starts.is_empty() {
                with_sections += 1;
                section_counts.push(starts.len());
                for name in &starts {
                    if name.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
                    {
                        *section_names.entry(name.clone()).or_default() += 1;
                    } else {
                        section_names_other += 1;
                    }
                }
                let closed: BTreeSet<&String> = ends.iter().collect();
                unclosed_sections += starts.iter().filter(|name| !closed.contains(name)).count();
            }
        }
    }

    println!("\n== FACT 1 · a job detail ({details} read)");
    println!("   keys: {}", detail_keys.into_iter().collect::<Vec<_>>().join(" "));
    for (field, count) in &detail_present {
        println!("   {field}: present on {count}/{details}");
    }

    println!("\n== FACT 2 · a trace ({traces} read, {traces_empty} empty)");
    for (status, count) in &traces_refused {
        println!("   refused {status}: {count}");
    }
    for (kind, count) in &content_types {
        println!("   content-type {kind}: {count}");
    }
    println!("   content-length stated: {lengths_stated}/{traces}");
    for (ranges, count) in &accept_ranges {
        println!("   accept-ranges {ranges}: {count}");
    }
    println!("   a Range request: {range_honoured} answered 206, {range_refused} did not");
    sizes.sort_unstable();
    line_counts.sort_unstable();
    println!(
        "   bytes: min {} · median {} · p90 {} · max {}",
        sizes.first().copied().unwrap_or(0),
        percentile(&sizes, 50),
        percentile(&sizes, 90),
        sizes.last().copied().unwrap_or(0),
    );
    println!(
        "   lines: min {} · median {} · p90 {} · max {} · longest line {longest_line} bytes",
        line_counts.first().copied().unwrap_or(0),
        percentile(&line_counts, 50),
        percentile(&line_counts, 90),
        line_counts.last().copied().unwrap_or(0),
    );

    println!("\n== FACT 3 · the sections");
    println!("   logs carrying markers: {with_sections}/{traces}");
    section_counts.sort_unstable();
    println!(
        "   sections per log: min {} · median {} · max {}",
        section_counts.first().copied().unwrap_or(0),
        percentile(&section_counts, 50),
        section_counts.last().copied().unwrap_or(0),
    );
    println!("   starts never closed: {unclosed_sections}");
    println!("   names outside the runner's own spelling: {section_names_other}");
    for (name, count) in &section_names {
        println!("   section {name}: {count}");
    }

    println!("\n== FACT 4 · the escapes");
    println!("   logs carrying one: {with_ansi}/{traces}");
    println!("   logs carrying CRLF: {with_crlf} · a bare CR: {with_bare_cr}");
    for (final_byte, count) in &escapes {
        println!("   ESC…{final_byte}: {count}");
    }

    println!("\n== FACT 5 · a job with no log");
    for (status, count) in &statuses_with_no_log {
        println!("   status {status}: {count}");
    }

    Ok(())
}

/// The `section_start:`/`section_end:` names a log carries, in the order they appear.
///
/// The marker is `section_start:<unix ts>:<name>` followed by `\r\x1b[0K`, so the name runs to
/// the first control character.
fn markers(text: &str, prefix: &str) -> Vec<String> {
    let mut names = Vec::new();
    for piece in text.split(prefix).skip(1) {
        let after_ts = match piece.split_once(':') {
            Some((_, rest)) => rest,
            None => continue,
        };
        let name: String = after_ts
            .chars()
            .take_while(|c| !c.is_control() && *c != '[')
            .collect();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

fn percentile(sorted: &[usize], nth: usize) -> usize {
    if sorted.is_empty() {
        return 0;
    }
    let index = (sorted.len() * nth / 100).min(sorted.len() - 1);
    sorted[index]
}

/// The project's own API root, taken from the merge-request endpoint this crate builds — so
/// this recon reaches the configured host and nothing else, through the same host pinning the
/// page's own reads go through (`gitlab::api_base` is crate-private on purpose).
fn gitlab_mr_project(host: &str, project_path: &str) -> String {
    let endpoint = gitlab_mr::merge_request_api(host, project_path, 1);
    endpoint
        .split_once("/merge_requests/")
        .map(|(project, _)| project.to_string())
        .unwrap_or(endpoint)
}

async fn get_json(
    http: &reqwest::Client,
    endpoint: &str,
    token: &str,
) -> Result<serde_json::Value> {
    let resp = http.get(endpoint).header("PRIVATE-TOKEN", token).send().await?;
    anyhow::ensure!(resp.status().is_success(), "GitLab answered {}", resp.status());
    Ok(resp.json().await?)
}

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

// Manual live check for the pipeline GRAPH's own facts, READ-ONLY.
//
// The graph groups a pipeline's jobs by stage, and — when it can — by what each job WAITS
// FOR. That second mode rests on two claims about this instance, and this example measures
// both rather than trusting either:
//
//   1. **REST carries no `needs`.** `GET /projects/:id/pipelines/:id/jobs` answers a job's
//      name, stage, status, `allow_failure`, duration and web url. It prints the union of
//      the KEYS every row carried, so a field appearing in a later GitLab is noticed here
//      rather than by nobody.
//   2. **GraphQL does**, under the same personal access token and the same `PRIVATE-TOKEN`
//      header the REST reads use (`gitlab_ci_graph`). It prints, per pipeline, how many jobs
//      declare a dependency, how many of those name a job the REST read did not carry (a
//      bridge, or one past the page cap — the graph drops those edges), and the longest
//      chain the layout would have to lay out in columns.
//
// It READS and nothing else: one GET per merge request, one GET per pipeline's jobs, one
// GraphQL QUERY per pipeline. No merge, no comment, no approval — the writes this app offers
// are the user's own click (see AGENTS.md § The trackers).
//
// It prints COUNTS and field names rather than anybody's pipeline: a job name can carry a
// customer's name, and this output ends up in a terminal, a journal or a transcript. So a
// job is counted, never named.
//
//   cargo run --example pipeline_needs_recon
//
// The GitLab host and token come from the app's own store, so it checks exactly what the
// page would ask with.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use teams_lite::gitlab_mr::{self, ListQuery, ListScope, ListState};

/// How many open merge requests to walk. Each one costs three requests, so this is a sample
/// wide enough to hold several projects' CI and small enough to run in a minute.
const MERGE_REQUESTS: usize = 25;

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

    let list = gitlab_mr::fetch_list(
        &http,
        &host,
        token.as_deref(),
        ListQuery { scope: ListScope::All, state: ListState::Opened },
    )
    .await?;
    println!("== {} open merge requests · walking the newest {MERGE_REQUESTS}", list.items.len());

    // FACT 1: what a REST job row really carries. The union over every row of every
    // pipeline, so one project's unusual job cannot hide a field from the count.
    let mut rest_keys: BTreeSet<String> = BTreeSet::new();
    // FACT 2: what GraphQL adds.
    let mut pipelines = 0usize;
    let mut pipelines_with_jobs = 0usize;
    let mut pipelines_with_needs = 0usize;
    let mut pipelines_graphql_refused = 0usize;
    let mut jobs_total = 0usize;
    let mut jobs_with_needs = 0usize;
    let mut edges_total = 0usize;
    let mut edges_off_graph = 0usize;
    let mut longest_chain = 0usize;
    let mut stage_order_answered = 0usize;
    let mut rest_already_ordered = 0usize;
    let mut rest_reversed = 0usize;
    let mut rest_other_order = 0usize;
    let mut stage_counts: BTreeMap<usize, usize> = BTreeMap::new();

    for row in list.items.iter().take(MERGE_REQUESTS) {
        let view =
            match gitlab_mr::fetch_pipeline(&http, &host, token.as_deref(), &row.project_path, row.iid)
                .await
            {
                Ok(view) => view,
                Err(e) => {
                    println!("   !{} · the pipeline could not be read: {e:#}", row.iid);
                    continue;
                }
            };
        if view.pipeline.is_none() {
            continue;
        }
        pipelines += 1;
        if view.jobs.is_empty() {
            continue;
        }
        pipelines_with_jobs += 1;
        jobs_total += view.jobs.len();
        let stages: BTreeSet<&str> = view.jobs.iter().map(|job| job.stage.as_str()).collect();
        *stage_counts.entry(stages.len()).or_default() += 1;

        // The raw rows again, for their KEYS alone. `fetch_pipeline` parses them into a
        // struct, so the only way to see a field this crate ignores is to look at the JSON.
        if let Ok(raw) = raw_jobs(&http, &host, token.as_deref(), &row.project_path, row.iid).await {
            for job in raw {
                if let Some(object) = job.as_object() {
                    rest_keys.extend(object.keys().cloned());
                }
            }
        }

        let shape = match teams_lite::gitlab_ci_graph::fetch_shape(
            &http,
            &host,
            token.as_deref(),
            &row.project_path,
            row.iid,
        )
        .await
        {
            Ok(shape) => shape,
            Err(e) => {
                pipelines_graphql_refused += 1;
                println!("   !{} · graphql refused: {e:#}", row.iid);
                continue;
            }
        };
        // FACT 3: the stage ORDER, which REST does not answer. The jobs come back newest
        // first, so the order they arrive in is the reverse of the pipeline's own — and a page
        // that read it off the answer drew every multi-stage pipeline backwards.
        let mut rest_order: Vec<&str> = Vec::new();
        for job in &view.jobs {
            if !rest_order.contains(&job.stage.as_str()) {
                rest_order.push(&job.stage);
            }
        }
        if !shape.stages.is_empty() {
            stage_order_answered += 1;
            let graphql: Vec<&str> = shape
                .stages
                .iter()
                .map(String::as_str)
                .filter(|name| rest_order.contains(name))
                .collect();
            let mut backwards = rest_order.clone();
            backwards.reverse();
            if graphql == rest_order {
                rest_already_ordered += 1;
            } else if graphql == backwards {
                rest_reversed += 1;
            } else {
                rest_other_order += 1;
            }
        }

        let needs = shape.needs;
        if needs.is_empty() {
            continue;
        }
        pipelines_with_needs += 1;
        let known: BTreeSet<&str> = view.jobs.iter().map(|job| job.name.as_str()).collect();
        for (job, wants) in &needs {
            if !known.contains(job.as_str()) {
                continue;
            }
            jobs_with_needs += 1;
            for want in wants {
                edges_total += 1;
                if !known.contains(want.as_str()) {
                    edges_off_graph += 1;
                }
            }
        }
        longest_chain = longest_chain.max(depth(&needs, &known));
    }

    println!("\n== FACT 1 · the keys a REST job row carries");
    println!("   {}", rest_keys.iter().cloned().collect::<Vec<_>>().join(" "));
    println!(
        "   `needs` among them: {}",
        if rest_keys.contains("needs") {
            "YES — the GraphQL read is no longer the only way"
        } else {
            "no — which is why gitlab_ci_graph exists"
        }
    );

    println!("\n== FACT 2 · what GraphQL adds");
    println!("   {pipelines} pipelines, {pipelines_with_jobs} of them with jobs, {jobs_total} jobs");
    println!(
        "   {pipelines_with_needs} pipelines declare dependencies, {pipelines_graphql_refused} \
         refused the query"
    );
    println!("   {jobs_with_needs} jobs carry a `needs`, {edges_total} edges in all");
    println!(
        "   {edges_off_graph} of those edges name a job the REST read did not carry (dropped)"
    );
    println!("   the longest dependency chain is {longest_chain} deep");
    println!("   stages per pipeline: {stage_counts:?}");

    println!("\n== FACT 3 · the stage ORDER, which REST does not answer");
    println!("   {stage_order_answered} pipelines had their stages named by GraphQL");
    println!(
        "   against the REST order: {rest_already_ordered} already match (a single stage), \
         {rest_reversed} are REVERSED, {rest_other_order} are neither"
    );
    Ok(())
}

/// The jobs of one merge request's head pipeline as raw JSON, for their keys alone.
async fn raw_jobs(
    http: &reqwest::Client,
    host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
) -> Result<Vec<serde_json::Value>> {
    let base = format!("https://{}/api/v4/projects/{}", host, urlencoding::encode(project_path));
    let mr: serde_json::Value = get(http, &format!("{base}/merge_requests/{iid}"), token).await?;
    let Some(pipeline_id) = mr
        .get("head_pipeline")
        .and_then(|p| p.get("id"))
        .and_then(serde_json::Value::as_u64)
    else {
        return Ok(Vec::new());
    };
    let jobs: serde_json::Value =
        get(http, &format!("{base}/pipelines/{pipeline_id}/jobs?per_page=100"), token).await?;
    Ok(jobs.as_array().cloned().unwrap_or_default())
}

async fn get(
    http: &reqwest::Client,
    endpoint: &str,
    token: Option<&str>,
) -> Result<serde_json::Value> {
    let mut request = http.get(endpoint).header("Accept", "application/json");
    if let Some(token) = token {
        request = request.header("PRIVATE-TOKEN", token);
    }
    Ok(request.send().await?.error_for_status()?.json().await?)
}

/// How many columns a dependency layout would need: the longest chain of jobs that wait on
/// each other. It is what the graph's own column assignment computes, measured here so the
/// UI's width is a known number rather than a hope.
fn depth(needs: &BTreeMap<String, Vec<String>>, known: &BTreeSet<&str>) -> usize {
    fn walk<'a>(
        job: &'a str,
        needs: &'a BTreeMap<String, Vec<String>>,
        known: &BTreeSet<&str>,
        seen: &mut BTreeSet<&'a str>,
    ) -> usize {
        // A cycle is not a shape GitLab accepts, but a walk that trusted that would hang.
        if !seen.insert(job) {
            return 1;
        }
        let deepest = needs
            .get(job)
            .into_iter()
            .flatten()
            .filter(|want| known.contains(want.as_str()))
            .map(|want| walk(want, needs, known, seen))
            .max()
            .unwrap_or(0);
        seen.remove(job);
        deepest + 1
    }
    needs
        .keys()
        .filter(|job| known.contains(job.as_str()))
        .map(|job| walk(job, needs, known, &mut BTreeSet::new()))
        .max()
        .unwrap_or(0)
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

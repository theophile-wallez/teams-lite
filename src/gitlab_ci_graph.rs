// What each CI job WAITS FOR: the `needs` of a pipeline's jobs, read over GraphQL.
//
// The pipeline graph (§ The pipeline is a GRAPH) draws a pipeline the way GitLab's own page
// does, and its second mode groups jobs by DEPENDENCY rather than by stage — a job's card
// sits one column right of the last job it needs, with a curve from each. That needs one
// fact the REST reads in [`crate::gitlab_mr`] cannot supply, and this module is the whole of
// how it is obtained.
//
// **REST does not carry it.** `GET /projects/:id/pipelines/:id/jobs` answers a job's name,
// stage, status, `allow_failure`, duration and web url, and no field naming another job —
// measured by `examples/pipeline_needs_recon.rs`, which re-measures it every run. GitLab
// publishes `needs` on `CiJob` in its GraphQL API and nowhere else, so the graph's
// dependency mode either speaks GraphQL or does not exist.
//
// It is a READ, and it carries the read path's rails — the same three
// [`crate::linear`] carries, for the same reasons:
//
//   - **HOST PINNING.** The endpoint is [`gitlab::origin`] plus [`GRAPHQL_PATH`], built
//     from the configured host and nothing else. A GraphQL endpoint is one URL for every
//     question, so there is no path here derived from anything a client sent.
//   - **QUERIES ONLY.** A GitLab token carries whatever scopes the user granted it, and
//     GraphQL is one POST whose BODY decides whether it reads or writes — so the verb says
//     nothing and the body is what is guarded. Every request goes through [`run_query`],
//     [`tests::the_module_sends_graphql_queries_only`] scans this file's own source for
//     `mutation`, and [`tests::the_rest_of_the_crate_names_no_graphql_endpoint`] keeps the
//     endpoint out of every other file. The writes this app offers live in
//     [`crate::gitlab_mr_write`] and [`crate::gitlab_approval`], each behind its own
//     consent gate; a write must never arrive here as a query with a different word in it.
//   - **BEST-EFFORT.** A pipeline graph is drawn from the REST read alone; what this adds
//     is the dependency MODE. So a GitLab too old for the field, a token GraphQL refuses,
//     an instance with GraphQL switched off and a network failure all cost that one mode
//     and nothing else — [`attach`] reports them to the journal and leaves the jobs
//     as they were. Never make the pipeline panel wait on this.
//
// Two decisions inside it are worth the next reader's minute:
//
//   - **A dependency is matched by job NAME.** `needs:` is declared per job name in
//     `.gitlab-ci.yml`, so every retry of a job shares one set — and the REST read and this
//     one are two requests, so a push between them can even show them two different head
//     pipelines. A name means the same thing across both; a job id would not, and matching
//     on one would silently draw no edges at all. [`Needs`] is therefore keyed by name.
//   - **A name the graph does not hold is DROPPED.** A `needs` may point at a job outside
//     what travelled — a bridge (a trigger job, which the REST jobs endpoint omits
//     altogether) or a job past the REST read's own page cap. An edge to a card that is not
//     on screen is an edge to nothing, so [`attach`] keeps only the names the jobs
//     themselves carry.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use anyhow::{Context, Result};

use crate::gitlab;
use crate::gitlab_mr::PipelineView;

/// GitLab's GraphQL endpoint, under the configured host. One path for every question, so
/// unlike the REST reads there is nothing here to build out of a caller's parameters.
pub const GRAPHQL_PATH: &str = "/api/graphql";

/// How long to wait on the answer. Shorter than the REST page reads: the pipeline panel is
/// already drawn by then, and this only decides whether the graph can be grouped by
/// dependency — so a slow instance must cost a mode rather than a page.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// How many jobs one query asks for. Above [`crate::gitlab_mr`]'s own page of jobs on
/// purpose: a job whose `needs` never travelled would lose its edges, and losing an edge is
/// worse than reading a few rows nothing draws.
const JOBS_PER_QUERY: usize = 200;

/// How many dependencies one job's own `needs` list carries. GitLab's own ceiling on
/// `needs:` is 50, so this is that ceiling and not a guess.
const NEEDS_PER_JOB: usize = 50;

/// The dependency edges of one pipeline: for each job's name, the names of the jobs it
/// waits for. Keyed by name — see the module header for why an id would be wrong.
pub type Needs = BTreeMap<String, Vec<String>>;

/// What one query answers: the edges, and the pipeline's own STAGE ORDER.
///
/// The two travel together because they come from one request and are needed by one surface.
/// Either may be empty on its own: a pipeline can declare no dependency and still have five
/// stages, and a GitLab that refuses the whole query leaves both empty (see [`attach`]).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PipelineShape {
    pub needs: Needs,
    /// The stage names, first to last, as the pipeline itself declares them.
    ///
    /// It is here rather than derived from the REST answer because **GitLab's jobs endpoint
    /// answers NEWEST FIRST**, which for one pipeline is reverse stage order — measured on this
    /// instance: of 12 merge requests, 8 came back reversed and the other 4 had a single stage,
    /// so reading the answer's order drew every multi-stage pipeline backwards. GraphQL states
    /// the real order, and this is it.
    pub stages: Vec<String>,
}

/// The query. One request for the whole pipeline: a query per job would be 15 round trips
/// on this tenant's own pipelines, and GraphQL exists precisely so it is one.
const SHAPE_QUERY: &str = r#"
query pipelineShape($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      headPipeline {
        stages(first: STAGES_PER_QUERY) {
          nodes { name }
        }
        jobs(first: JOBS_PER_QUERY) {
          nodes {
            name
            needs(first: NEEDS_PER_JOB) {
              nodes { name }
            }
          }
        }
      }
    }
  }
}
"#;

/// How many stages one query asks for. The deepest pipeline on this instance runs 8, so this
/// is generous and still bounded.
const STAGES_PER_QUERY: usize = 50;

/// Read the shape of one merge request's head pipeline: its stage order, and its edges.
///
/// The head pipeline is asked for through the MERGE REQUEST rather than by the id the REST
/// read returned, so nothing has to be threaded between two requests — and a push between
/// them is harmless, because the edges are matched by name (see the module header).
pub async fn fetch_shape(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
) -> Result<PipelineShape> {
    let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) else {
        anyhow::bail!("reading a pipeline's shape needs a GitLab token");
    };
    let body = run_query(http, gitlab_host, token, project_path, iid).await?;
    Ok(PipelineShape { needs: needs_from_json(&body), stages: stages_from_json(&body) })
}

/// Put the stage order and the dependency edges on a pipeline the REST read already answered.
///
/// BEST-EFFORT by construction: it returns nothing and fails at nothing. Whatever goes
/// wrong — no token, GraphQL refused, a field this instance does not publish — the jobs keep
/// the `needs` they arrived with (none) and the view names no stage order, so the page groups
/// by stage and orders those stages by the jobs' own ids (see `pipelineStages`). The journal
/// keeps one line, because a mode that quietly stopped working is the failure nobody would
/// report.
pub async fn attach(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    view: &mut PipelineView,
) {
    if view.jobs.is_empty() {
        return;
    }
    match fetch_shape(http, gitlab_host, token, project_path, iid).await {
        Ok(shape) => {
            apply_needs(view, &shape.needs);
            // Only the stages this pipeline's own jobs are in, in the order GitLab named them:
            // a pipeline definition can declare a stage no job ran in, and a column for one
            // would be an empty column.
            let held: BTreeSet<&str> = view.jobs.iter().map(|job| job.stage.as_str()).collect();
            view.stages =
                shape.stages.iter().filter(|name| held.contains(name.as_str())).cloned().collect();
        }
        Err(e) => {
            eprintln!("[gitlab] the pipeline's shape could not be read: {e:#}");
        }
    }
}

/// Write the edges onto the jobs, keeping only the ones the graph can draw.
///
/// A name no job in this view carries is dropped — a bridge, or a job past the REST page —
/// because an edge to a card that is not on screen is an edge to nothing. The order GitLab
/// answered in is kept, and a duplicate is dropped: the graph reads them as a set.
fn apply_needs(view: &mut PipelineView, needs: &Needs) {
    let known: BTreeSet<String> = view.jobs.iter().map(|job| job.name.clone()).collect();
    for job in &mut view.jobs {
        let Some(names) = needs.get(&job.name) else {
            continue;
        };
        let mut kept = Vec::new();
        for name in names {
            // A job that needs itself is not a shape GitLab accepts, and drawing it would be
            // a cycle in a graph the layout walks. Refuse it here rather than downstream.
            if name == &job.name || !known.contains(name) || kept.contains(name) {
                continue;
            }
            kept.push(name.clone());
        }
        job.needs = kept;
    }
}

/// Ask GitLab, and hand back the answer's `data`.
///
/// The ONE request this module makes. Its body is a query and its variables are the merge
/// request's own coordinates — nothing a client sent reaches the URL.
async fn run_query(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: &str,
    project_path: &str,
    iid: u64,
) -> Result<serde_json::Value> {
    let endpoint = format!("{}{GRAPHQL_PATH}", gitlab::origin(gitlab_host));
    let query = SHAPE_QUERY
        .replace("STAGES_PER_QUERY", &STAGES_PER_QUERY.to_string())
        .replace("JOBS_PER_QUERY", &JOBS_PER_QUERY.to_string())
        .replace("NEEDS_PER_JOB", &NEEDS_PER_JOB.to_string());
    let resp = http
        .post(&endpoint)
        .header("Accept", "application/json")
        // GitLab's GraphQL API takes the same personal access token the REST reads use,
        // under the same header — verified against this instance by the recon.
        .header("PRIVATE-TOKEN", token)
        .timeout(HTTP_TIMEOUT)
        .json(&serde_json::json!({
            "query": query,
            "variables": { "fullPath": project_path, "iid": iid.to_string() },
        }))
        .send()
        .await
        .context("gitlab graphql request")?;

    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", crate::gitlab_mr::refusal(status, "the pipeline's shape"));
    }
    let body: serde_json::Value = resp.json().await.context("gitlab graphql body")?;
    // GraphQL answers 200 with an `errors` array, so the status alone says nothing. The
    // MESSAGE is what a journal line has to carry: "this field does not exist" and "this
    // token may not read that project" are different problems for whoever reads it.
    if let Some(message) = first_error(&body) {
        anyhow::bail!("gitlab graphql error: {message}");
    }
    Ok(body.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

/// The first error message a GraphQL body carries, if any.
fn first_error(body: &serde_json::Value) -> Option<String> {
    body.get("errors")?
        .as_array()?
        .iter()
        .filter_map(|error| error.get("message")?.as_str())
        .map(str::to_string)
        .find(|message| !message.is_empty())
}

/// Read the STAGE ORDER out of one answer. Empty when the field is absent, which is what
/// `pipelineStages` reads as "order these by the jobs' own ids instead".
fn stages_from_json(data: &serde_json::Value) -> Vec<String> {
    head_pipeline(data)
        .and_then(|pipeline| pipeline.get("stages"))
        .and_then(|stages| stages.get("nodes"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| node.get("name")?.as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

/// The head pipeline of the answer, if it holds one.
fn head_pipeline(data: &serde_json::Value) -> Option<&serde_json::Value> {
    data.get("project")?.get("mergeRequest")?.get("headPipeline")
}

/// Read the edges out of one answer. A job with no `needs` is left out of the map entirely,
/// so an empty map means "this pipeline declares no dependencies" — which is a real and
/// common shape (a pipeline whose stages are its only ordering).
fn needs_from_json(data: &serde_json::Value) -> Needs {
    let mut needs = Needs::new();
    let nodes = head_pipeline(data)
        .and_then(|pipeline| pipeline.get("jobs"))
        .and_then(|jobs| jobs.get("nodes"))
        .and_then(serde_json::Value::as_array);
    for node in nodes.into_iter().flatten() {
        let Some(name) = node.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let names: Vec<String> = node
            .get("needs")
            .and_then(|needs| needs.get("nodes"))
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|need| need.get("name")?.as_str())
            .filter(|need| !need.is_empty())
            .map(str::to_string)
            .collect();
        if names.is_empty() {
            continue;
        }
        // A retried job appears twice under one name. The two carry the same `needs:` from
        // the same file, so the first is kept and the second changes nothing.
        needs.entry(name.to_string()).or_insert(names);
    }
    needs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitlab_mr::Job;

    fn job(name: &str, stage: &str) -> Job {
        Job {
            id: 1,
            name: name.to_string(),
            stage: stage.to_string(),
            status: "success".to_string(),
            allow_failure: false,
            duration: None,
            web_url: None,
            finished_at: None,
            needs: Vec::new(),
        }
    }

    fn answer(jobs: &[(&str, &[&str])]) -> serde_json::Value {
        let nodes: Vec<serde_json::Value> = jobs
            .iter()
            .map(|(name, needs)| {
                let need_nodes: Vec<serde_json::Value> =
                    needs.iter().map(|need| serde_json::json!({ "name": need })).collect();
                serde_json::json!({ "name": name, "needs": { "nodes": need_nodes } })
            })
            .collect();
        serde_json::json!({
            "project": { "mergeRequest": { "headPipeline": { "jobs": { "nodes": nodes } } } }
        })
    }

    /// Strip `//` line comments so a source-scanning guardrail inspects CODE, not the prose
    /// that explains it. A `//` preceded by `:` is left alone so the `https://` inside a
    /// string literal survives. Mirrors `linear.rs` and `gitlab_approval.rs`.
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .map(|line| {
                let bytes = line.as_bytes();
                let mut cut = line.len();
                for i in 0..bytes.len().saturating_sub(1) {
                    if bytes[i] == b'/' && bytes[i + 1] == b'/' && (i == 0 || bytes[i - 1] != b':') {
                        cut = i;
                        break;
                    }
                }
                &line[..cut]
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// A GraphQL request is a POST whether it reads or writes, so the VERB guards nothing
    /// here and the body is what a scan has to read. This module sends one query and knows
    /// no other word.
    #[test]
    fn the_module_sends_graphql_queries_only() {
        let source = include_str!("gitlab_ci_graph.rs");
        let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source));
        assert!(code.contains("async fn run_query"), "scanned the wrong text");
        for forbidden in ["mutation", "Mutation"] {
            assert!(
                !code.contains(forbidden),
                "src/gitlab_ci_graph.rs must send GraphQL queries only, found `{forbidden}`. \
                 Reading a tracker is what this module is for; writing to one is a deliberate \
                 feature with its own consent gate (see src/gitlab_mr_write.rs)."
            );
        }
        // ONE request, and it is that query. A second `.post(` would be a request this
        // module's own name does not cover.
        assert_eq!(code.matches(".post(").count(), 1);
        for verb in [".put(", ".patch(", ".delete("] {
            assert!(!code.contains(verb), "src/gitlab_ci_graph.rs names `{verb}`");
        }
    }

    /// And the endpoint lives HERE, nowhere else. Every other GitLab module speaks REST and
    /// is scanned for every verb but GET; a `/api/graphql` appearing in one of them would be
    /// a POST those scans cannot see.
    #[test]
    fn the_rest_of_the_crate_names_no_graphql_endpoint() {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    out.push(path);
                }
            }
        }
        let mut files = Vec::new();
        walk(std::path::Path::new("src"), &mut files);
        assert!(files.len() > 5, "no Rust sources found to scan");
        for file in files {
            if file.ends_with("gitlab_ci_graph.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(&source));
            assert!(
                !code.contains(GRAPHQL_PATH),
                "{} names `{GRAPHQL_PATH}`. The one GraphQL read lives in \
                 src/gitlab_ci_graph.rs, whose own scan keeps it a query.",
                file.display()
            );
        }
    }

    #[test]
    fn the_endpoint_is_built_from_the_configured_host() {
        assert_eq!(
            format!("{}{GRAPHQL_PATH}", gitlab::origin("gitlab.example.com")),
            "https://gitlab.example.com/api/graphql"
        );
    }

    #[test]
    fn reads_the_edges_of_every_job_that_declares_one() {
        let needs = needs_from_json(&answer(&[
            ("build", &[]),
            ("test", &["build"]),
            ("deploy", &["test", "build"]),
        ]));
        // A job with no dependency is absent rather than empty: an empty map is what says
        // "this pipeline is ordered by its stages alone".
        assert_eq!(needs.get("build"), None);
        assert_eq!(needs.get("test").map(Vec::as_slice), Some(&["build".to_string()][..]));
        assert_eq!(
            needs.get("deploy").map(Vec::as_slice),
            Some(&["test".to_string(), "build".to_string()][..])
        );
    }

    #[test]
    fn a_pipeline_with_no_dependencies_answers_an_empty_map() {
        assert!(needs_from_json(&answer(&[("build", &[]), ("test", &[])])).is_empty());
        // A merge request with no head pipeline at all, and a body that is not one.
        assert!(needs_from_json(&serde_json::json!({ "project": null })).is_empty());
        assert!(needs_from_json(&serde_json::Value::Null).is_empty());
    }

    #[test]
    fn a_retried_job_keeps_one_set_of_edges() {
        // GitLab lists a retried job twice under one name, carrying the same `needs:`.
        let needs = needs_from_json(&answer(&[("test", &["build"]), ("test", &["build"])]));
        assert_eq!(needs.get("test").map(Vec::as_slice), Some(&["build".to_string()][..]));
    }

    /// An edge is only drawn to a card the graph holds. A bridge — a trigger job, which the
    /// REST jobs endpoint omits altogether — and a job past the REST page are both named by
    /// a `needs` and drawn by nothing.
    #[test]
    fn an_edge_to_a_job_that_did_not_travel_is_dropped() {
        let mut view = PipelineView {
            pipeline: None,
            jobs: vec![job("build", "build"), job("test", "test")],
            stages: Vec::new(),
        };
        let needs = needs_from_json(&answer(&[("test", &["build", "trigger-downstream"])]));
        apply_needs(&mut view, &needs);
        assert_eq!(view.jobs[1].needs, vec!["build".to_string()]);
        assert!(view.jobs[0].needs.is_empty());
    }

    #[test]
    fn a_job_never_depends_on_itself_or_twice_on_one_job() {
        let mut view = PipelineView {
            pipeline: None,
            jobs: vec![job("build", "build"), job("test", "test")],
            stages: Vec::new(),
        };
        let needs = needs_from_json(&answer(&[("test", &["test", "build", "build"])]));
        apply_needs(&mut view, &needs);
        assert_eq!(view.jobs[1].needs, vec!["build".to_string()]);
    }

    #[tokio::test]
    async fn a_read_with_no_token_is_refused_before_the_network() {
        let http = reqwest::Client::new();
        let err = fetch_shape(&http, "gitlab.example.com", None, "acme/app", 42).await.unwrap_err();
        assert!(err.to_string().contains("needs a GitLab token"), "{err}");
    }
}

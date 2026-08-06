// The merge-request surface: everything the GitLab page READS.
//
// `src/gitlab.rs` enriches ONE link into a card. This module answers the other question
// — "what is waiting for me, and what is going on inside it?" — which is the whole of the
// GitLab page: a list of merge requests that are not merged, and for one of them its
// description, its live pipeline, its approvals and its comments.
//
// It is a read path, and it carries the read path's rails unchanged:
//
//   - **HOST PINNING.** Every request is built from [`gitlab::api_base`], so the user's
//     token can only ever reach the host they configured. A merge request is addressed by
//     its `project_path` and `iid` here rather than by a URL, and those are re-derived
//     from GitLab's OWN `web_url` through [`gitlab::parse_url`] — the same parse the card
//     uses, so there is one host check in this app and not two.
//   - **GET ONLY.** A GitLab token carries whatever scopes the user granted it, so
//     [`tests::module_issues_only_get_requests`] scans this file's own source. The writes
//     the page offers — merge, comment, close — live in [`crate::gitlab_mr_write`], each
//     behind its own consent gate.
//   - **A TOKEN IS REQUIRED.** Unlike a public card, "the merge requests I can see" is a
//     question only an account can answer, so a tokenless read is refused here rather
//     than sent as an anonymous request GitLab would answer with somebody else's world.
//
// Three measured facts shaped it, and each is a trap for the next reader:
//
//   - **The LIST endpoint carries no pipeline.** Measured on this tenant: neither
//     `head_pipeline` nor `pipeline` is present on a row of `GET /merge_requests`, so a
//     status badge per row would cost one request per merge request — 109 of them on the
//     first screen. The row therefore states `detailed_merge_status`, which IS on the row
//     and is what GitLab's own merge button reads, and the pipeline lives on the DETAIL
//     page where it is polled live.
//   - **`state` has no "not merged".** GitLab accepts `opened`, `closed`, `locked`,
//     `merged` and `all`; "not merged" is the union of the first three (measured: 109
//     opened, 929 closed, 0 locked). So [`ListState`] names the two the page offers and
//     never asks for `merged` at all — a page about what is still open must not be able
//     to fetch 5 000 landed merge requests by mistake.
//   - **A note's body is MARKDOWN, and a discussion is not always a thread.** GitLab
//     returns `individual_note: true` for a standalone comment and `false` for a real
//     thread; a `DiffNote` carries the file and line it hangs on. Both shapes travel, so
//     the code-review section this page will grow has the position it needs already.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::gitlab::{self, person, Resource};

/// How long to wait on the GitLab API. Longer than the 8 s enrichment timeout: this is a
/// page the user opened and is looking at, not a card that may quietly stay a link.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// How many merge requests one list read asks for. One request, no pagination: a sidebar
/// nobody scrolls past a hundred rows of is a sidebar, and a page that silently paged
/// 1 038 closed merge requests into memory would be a performance bug wearing a feature's
/// clothes. The count GitLab reports (`x-total`) travels beside the rows, so the list can
/// say what it left out instead of looking complete.
const LIST_PER_PAGE: usize = 100;

/// How many discussions one comment read asks for. GitLab pages at 100 and a merge request
/// with more than that is one nobody reads to the end of in a side panel.
const DISCUSSIONS_PER_PAGE: usize = 100;

/// How many jobs of the head pipeline travel. A stage view is what this shows, so the cap
/// is generous enough for a real pipeline (the largest on this tenant runs 3) and bounded
/// so a 500-job monorepo pipeline cannot push a page over.
const JOBS_PER_PAGE: usize = 100;

/// Which merge requests a list read asks for. Both halves are closed sets rather than
/// strings from the client: a scope is a query parameter GitLab interprets, and a page
/// that forwarded whatever a client sent would be a way to ask this token questions the
/// page never offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListScope {
    /// Every merge request the token can see (`scope=all`). GitLab's default is
    /// `created_by_me`, which is why a dashboard that forgot this shows only the user's
    /// own — measured: 12 rows and one author, against 109 rows and 25 authors.
    All,
    /// Assigned to the user (`scope=assigned_to_me`).
    Assigned,
    /// Written by the user (`scope=created_by_me`).
    Mine,
    /// The user is a REVIEWER. Not a `scope` value at all — it is `reviewer_id`, which
    /// needs the account's own numeric id, so this is the one scope that costs a
    /// `GET /user` first (cached for the process).
    Reviewing,
}

impl ListScope {
    /// The name the page uses on the wire, and what a client may send.
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "assigned" => Some(Self::Assigned),
            "mine" => Some(Self::Mine),
            "reviewing" => Some(Self::Reviewing),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Assigned => "assigned",
            Self::Mine => "mine",
            Self::Reviewing => "reviewing",
        }
    }
}

/// Which state a list read asks for. `merged` is deliberately absent: this page is about
/// the merge requests that are NOT merged (see the module header).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListState {
    Opened,
    Closed,
}

impl ListState {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "opened" => Some(Self::Opened),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Opened => "opened",
            Self::Closed => "closed",
        }
    }
}

/// One list read, and the cache key it stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListQuery {
    pub scope: ListScope,
    pub state: ListState,
}

impl ListQuery {
    /// The key this read is cached under (see [`crate::store::Store::gitlab_read`]).
    pub fn cache_key(&self) -> String {
        format!("list:{}:{}", self.scope.as_str(), self.state.as_str())
    }
}

/// The prefix every cached read of ONE merge request shares.
///
/// One prefix is what makes a write's invalidation whole: merging, commenting or closing
/// makes the detail, the comments and the pipeline wrong in the same instant, so
/// [`crate::store::Store::forget_gitlab_reads`] drops them together and a caller cannot
/// forget one and leave another behind.
pub fn cache_prefix(project_path: &str, iid: u64) -> String {
    format!("mr:{project_path}!{iid}:")
}

/// The key one read of one merge request is cached under. `kind` names the read — `detail`,
/// `notes`, `pipeline` — and sits at the END, under the shared prefix above.
pub fn cache_key(project_path: &str, iid: u64, kind: &str) -> String {
    format!("{}{kind}", cache_prefix(project_path, iid))
}

/// One merge request as the sidebar draws it. Deliberately narrow: this list is 100 rows
/// long and every field costs bytes on the socket and a re-render on the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergeRequestRow {
    /// Full project path, "group/sub/project" — how the detail read addresses it, and
    /// what the row shows above the title.
    pub project_path: String,
    pub iid: u64,
    /// GitLab's own short reference, "!42".
    pub reference: String,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub web_url: String,
    pub source_branch: String,
    pub target_branch: String,
    pub author: Person,
    /// GitLab's own verdict on whether this can merge — `mergeable`, `not_approved`,
    /// `ci_must_pass`, `conflict`, … It is on the LIST row (the pipeline is not), and it
    /// is what GitLab's own button reads, so the sidebar states it rather than guessing
    /// from a status it would have to fetch per row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detailed_merge_status: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    pub user_notes_count: u64,
    pub upvotes: u64,
    pub downvotes: u64,
    /// ISO 8601, GitLab's own. The list is ordered by it, and the row shows it relative.
    pub updated_at: String,
    pub created_at: String,
}

/// A page of merge requests, plus what it left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergeRequestList {
    pub scope: &'static str,
    pub state: &'static str,
    pub items: Vec<MergeRequestRow>,
    /// How many merge requests match, when GitLab says (`x-total`). `None` when it does
    /// not — it omits the header on an expensive count — and then the page says how many
    /// it holds instead of inventing a total.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// True when `total` is larger than what travelled, so the list can say so. A list
    /// that stops without saying it stopped reads as a complete one.
    pub truncated: bool,
}

/// One person GitLab names, and who they are in Teams when this app knows them.
///
/// Re-exported from [`crate::gitlab`], where it lives because the preview CARD names people
/// too: one shape across every GitLab surface is what lets one rule name them all. The `teams`
/// field the page reads is added to the ANSWER rather than parsed here — see
/// [`crate::tracker_people`] and `with_teams_people` in src/bin/server.rs — because it is
/// local, current, and must never be frozen into the response cache these reads are stored in.
pub use crate::gitlab::Person;

/// One merge request in full, as the page's header and sidebar panels need it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergeRequestDetail {
    pub project_path: String,
    pub iid: u64,
    pub reference: String,
    pub title: String,
    /// The raw MARKDOWN body, as the author wrote it. Rendered on the page by the same
    /// subset every other markdown in this app goes through, never by GitLab's own HTML
    /// endpoint: that would be a second renderer and a second set of remote references.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub state: String,
    pub draft: bool,
    pub web_url: String,
    pub source_branch: String,
    pub target_branch: String,
    pub author: Person,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub assignees: Vec<Person>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reviewers: Vec<Person>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
    /// The head commit the page acted on. It travels to the MERGE, which is what stops a
    /// merge landing a commit the reader never saw (see [`crate::gitlab_mr_write`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_status: Option<String>,
    /// GitLab's own reason, in one word, for whether this can merge right now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detailed_merge_status: Option<String>,
    pub has_conflicts: bool,
    /// Whether every thread that blocks a merge is resolved. The project decides whether
    /// it blocks at all, so the page reports it rather than deriving a verdict.
    pub blocking_discussions_resolved: bool,
    /// Whether the project asks for the branch to be squashed. Carried so the merge sends
    /// back what the merge request already says instead of a default of ours.
    pub squash: bool,
    /// Whether the source branch is removed on merge, when the merge request says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub should_remove_source_branch: Option<bool>,
    /// How many files changed, GitLab's own string ("11", or "1000+").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes_count: Option<String>,
    pub user_notes_count: u64,
    pub upvotes: u64,
    pub downvotes: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    /// The head pipeline as the detail body states it. The LIVE view comes from
    /// [`fetch_pipeline`], which the page re-reads while it runs; this is what the first
    /// paint draws so the panel is never empty for a round trip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<PipelineSummary>,
}

/// A pipeline, without its jobs: what a badge needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PipelineSummary {
    pub id: u64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// The head pipeline plus its jobs, in GitLab's own order — which is stage order, so the
/// page groups on `stage` without sorting anything itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PipelineView {
    /// `None` when the merge request has no pipeline at all (a branch with no CI, or one
    /// that has not run yet). The page then says so rather than drawing an empty panel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<PipelineSummary>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub jobs: Vec<Job>,
}

/// One CI job.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Job {
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub status: String,
    /// A job whose failure does not fail the pipeline. It is drawn differently, because a
    /// red mark on a job nobody has to fix is a red mark that trains people to ignore red.
    pub allow_failure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

/// One comment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Note {
    pub id: u64,
    pub author: Person,
    /// Raw MARKDOWN, as written.
    pub body: String,
    /// A note GitLab wrote itself — "changed the description", "approved this merge
    /// request". The page draws these as a timeline line rather than as a comment,
    /// because they are events and not what anybody said.
    pub system: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Whether this note can be resolved, and whether it is. Both are GitLab's, and only
    /// a thread note has them.
    pub resolvable: bool,
    pub resolved: bool,
    /// True when the note belongs to the account this token holds — so the page offers to
    /// delete only what the user themselves wrote. Matched on GitLab's user ID, never on
    /// a display name.
    pub mine: bool,
    /// Where a code comment hangs, when it is one. The file and the line are what the
    /// code-review section will anchor on; until then the page names the file so a diff
    /// comment is not a comment about nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<NotePosition>,
}

/// The file and line a `DiffNote` is attached to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotePosition {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u64>,
}

/// One discussion: a standalone comment, or a thread with replies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Discussion {
    /// GitLab's own discussion id — what a REPLY is posted to, so a reply lands in the
    /// thread instead of starting a new one.
    pub id: String,
    /// True for a standalone comment. A thread (`false`) can be replied to and resolved.
    pub individual_note: bool,
    pub notes: Vec<Note>,
}

/// Every discussion on one merge request, oldest first — GitLab's own order, which is
/// the order a conversation happened in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscussionList {
    pub discussions: Vec<Discussion>,
    /// True when GitLab holds more than one page of them. The page says so; it does not
    /// pretend the conversation ended.
    pub truncated: bool,
}

// ---- reads ------------------------------------------------------------------

/// The merge requests matching `query`, newest activity first.
///
/// Requires a token: "every merge request I can see" is a question about an account.
pub async fn fetch_list(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    query: ListQuery,
) -> Result<MergeRequestList> {
    let token = require_token(token)?;
    let mut endpoint = format!(
        "{}/merge_requests?state={}&order_by=updated_at&sort=desc&per_page={LIST_PER_PAGE}\
         &with_labels_details=false&with_merge_status_recheck=false",
        gitlab::api_base(gitlab_host),
        query.state.as_str(),
    );
    // `scope=all` is what makes this a dashboard rather than a list of the user's own
    // merge requests: GitLab's default is `created_by_me`. `Reviewing` is not a scope,
    // so it asks with `reviewer_id` on top of the widest scope.
    match query.scope {
        ListScope::All => endpoint.push_str("&scope=all"),
        ListScope::Assigned => endpoint.push_str("&scope=assigned_to_me"),
        ListScope::Mine => endpoint.push_str("&scope=created_by_me"),
        ListScope::Reviewing => {
            let me = fetch_user_id(http, gitlab_host, token)
                .await?
                .context("GitLab would not say who this token belongs to, so \"I review\" \
                          cannot be answered")?;
            endpoint.push_str(&format!("&scope=all&reviewer_id={me}"));
        }
    }

    let resp = get(http, &endpoint, Some(token)).await.context("gitlab merge requests")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", refusal(status, "merge requests"));
    }
    // GitLab publishes the match count on this endpoint (measured: `x-total: 109`), and
    // omits it when counting would be expensive. Read before the body, since consuming
    // the response moves it.
    let total = resp
        .headers()
        .get("x-total")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let body: serde_json::Value = resp.json().await.context("gitlab merge requests body")?;

    let items: Vec<MergeRequestRow> = body
        .as_array()
        .map(|rows| rows.iter().filter_map(|row| row_from_json(row, gitlab_host)).collect())
        .unwrap_or_default();
    Ok(MergeRequestList {
        scope: query.scope.as_str(),
        state: query.state.as_str(),
        truncated: total.is_some_and(|t| t > items.len() as u64),
        total,
        items,
    })
}

/// One merge request in full.
pub async fn fetch_detail(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
) -> Result<MergeRequestDetail> {
    let token = require_token(token)?;
    let endpoint = merge_request_api(gitlab_host, project_path, iid);
    let body = read_json(http, &endpoint, token, "merge request").await?;
    detail_from_json(&body, project_path, iid)
        .context("GitLab answered with something that is not a merge request")
}

/// The head pipeline of one merge request, with its jobs.
///
/// Two requests, and the second only when there is a pipeline at all. This is the read
/// the page repeats while CI runs, so it is deliberately the smallest pair that can draw
/// a stage view.
pub async fn fetch_pipeline(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
) -> Result<PipelineView> {
    let token = require_token(token)?;
    // The merge request's own body carries the head pipeline. Asking for
    // `/pipelines` instead would answer with every pipeline the branch ever ran, newest
    // first — which is nearly the same thing and one more page to sort through.
    let body = read_json(http, &merge_request_api(gitlab_host, project_path, iid), token, "merge request")
        .await?;
    let Some(pipeline) = pipeline_summary(&body) else {
        return Ok(PipelineView { pipeline: None, jobs: Vec::new() });
    };

    let jobs_endpoint = format!(
        "{}/projects/{}/pipelines/{}/jobs?per_page={JOBS_PER_PAGE}",
        gitlab::api_base(gitlab_host),
        gitlab::encode_path(project_path),
        pipeline.id,
    );
    // A pipeline whose jobs cannot be listed is still a pipeline with a status: the badge
    // is the half that matters, so the jobs are best-effort and their absence costs the
    // stage rows and nothing else.
    let jobs = match read_json(http, &jobs_endpoint, token, "pipeline jobs").await {
        Ok(body) => body
            .as_array()
            .map(|rows| rows.iter().filter_map(job_from_json).collect())
            .unwrap_or_default(),
        Err(e) => {
            eprintln!("[gitlab] the pipeline's jobs could not be read: {e:#}");
            Vec::new()
        }
    };
    Ok(PipelineView { pipeline: Some(pipeline), jobs })
}

/// Every discussion on one merge request, oldest first.
pub async fn fetch_discussions(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
) -> Result<DiscussionList> {
    let token = require_token(token)?;
    let endpoint = format!(
        "{}/discussions?per_page={DISCUSSIONS_PER_PAGE}",
        merge_request_api(gitlab_host, project_path, iid)
    );
    let resp = get(http, &endpoint, Some(token)).await.context("gitlab discussions")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", refusal(status, "the comments"));
    }
    let more = resp
        .headers()
        .get("x-next-page")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !v.trim().is_empty());
    let body: serde_json::Value = resp.json().await.context("gitlab discussions body")?;

    // Whose comments are the user's own, so the page offers to delete only those. One
    // request, and only when there is something to attribute.
    let me = match body.as_array().map(|rows| rows.is_empty()) {
        Some(true) | None => None,
        Some(false) => fetch_user_id(http, gitlab_host, token)
            .await
            .inspect_err(|e| eprintln!("[gitlab] who the token belongs to is unknown: {e:#}"))
            .unwrap_or(None),
    };

    let discussions = body
        .as_array()
        .map(|rows| rows.iter().filter_map(|row| discussion_from_json(row, me)).collect())
        .unwrap_or_default();
    Ok(DiscussionList { discussions, truncated: more })
}

/// The numeric id of the account a token belongs to, cached for the life of the process.
///
/// Two reads need it — "merge requests I review" and "which comments are mine" — and it
/// is a property of the token rather than of a request, so asking GitLab once is right.
/// A cache miss costs one request; a wrong answer would mis-attribute a comment, so a
/// host change (the only way the answer can move) clears it.
pub async fn fetch_user_id(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: &str,
) -> Result<Option<u64>> {
    use std::sync::Mutex;
    static CACHED: Mutex<Option<(String, u64)>> = Mutex::new(None);
    // The key is the host plus the token, so neither a re-pointed host nor a replaced
    // token can be answered with the previous account's id.
    let key = format!("{gitlab_host}\u{0}{token}");
    if let Some((cached_key, id)) = CACHED.lock().unwrap().as_ref() {
        if *cached_key == key {
            return Ok(Some(*id));
        }
    }

    let endpoint = format!("{}/user", gitlab::api_base(gitlab_host));
    let resp = get(http, &endpoint, Some(token)).await.context("gitlab user request")?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: serde_json::Value = resp.json().await.context("gitlab user body")?;
    let id = body.get("id").and_then(serde_json::Value::as_u64);
    if let Some(id) = id {
        *CACHED.lock().unwrap() = Some((key, id));
    }
    Ok(id)
}

// ---- plumbing ---------------------------------------------------------------

/// The API base of one merge request.
pub(crate) fn merge_request_api(gitlab_host: &str, project_path: &str, iid: u64) -> String {
    format!(
        "{}/projects/{}/merge_requests/{iid}",
        gitlab::api_base(gitlab_host),
        gitlab::encode_path(project_path)
    )
}

/// A token, or the sentence that says why this read cannot happen without one.
pub(crate) fn require_token(token: Option<&str>) -> Result<&str> {
    token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .context("the GitLab page needs a personal access token (Settings → Integrations)")
}

/// One authenticated GET against the configured host.
async fn get(
    http: &reqwest::Client,
    endpoint: &str,
    token: Option<&str>,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut request = http.get(endpoint).header("Accept", "application/json").timeout(HTTP_TIMEOUT);
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        request = request.header("PRIVATE-TOKEN", token);
    }
    request.send().await
}

/// One authenticated GET whose body is JSON, with GitLab's refusal turned into a sentence.
async fn read_json(
    http: &reqwest::Client,
    endpoint: &str,
    token: &str,
    what: &str,
) -> Result<serde_json::Value> {
    let resp = get(http, endpoint, Some(token)).await.with_context(|| format!("gitlab {what}"))?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", refusal(status, what));
    }
    resp.json().await.with_context(|| format!("gitlab {what} body"))
}

/// What a failed read says. One sentence naming the cause the status code stands for: a
/// bare "404" on a page the user opened deliberately is a number they can do nothing with.
pub(crate) fn refusal(status: reqwest::StatusCode, what: &str) -> String {
    match status {
        reqwest::StatusCode::UNAUTHORIZED => {
            format!("GitLab refused: the stored token is not accepted, so {what} cannot be read")
        }
        reqwest::StatusCode::FORBIDDEN => {
            format!("GitLab refused: this account may not read {what}")
        }
        reqwest::StatusCode::NOT_FOUND => {
            format!("GitLab has no {what} there, or the token cannot see it")
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            "GitLab is rate-limiting this token — it will answer again shortly".to_string()
        }
        other => format!("GitLab answered {other} for {what}"),
    }
}

fn str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn u64_field(value: &serde_json::Value, key: &str) -> u64 {
    value.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0)
}

fn bool_field(value: &serde_json::Value, key: &str) -> bool {
    value.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false)
}

fn labels_field(value: &serde_json::Value) -> Vec<String> {
    value
        .get("labels")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn people(value: &serde_json::Value, key: &str) -> Vec<Person> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().map(|entry| person(Some(entry))).collect())
        .unwrap_or_default()
}

/// A merge request's `draft` flag, under either of the two names GitLab has used for it.
fn draft(value: &serde_json::Value) -> bool {
    value
        .get("draft")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| value.get("work_in_progress").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

/// The project path a merge request belongs to, read from GitLab's OWN `web_url` through
/// the card's parser — so the host pin is applied to what the API answered, and a row
/// pointing anywhere else is dropped rather than addressed.
fn project_path_of(value: &serde_json::Value, gitlab_host: &str) -> Option<String> {
    let web_url = str_field(value, "web_url")?;
    match gitlab::parse_url(&web_url, gitlab_host)? {
        Resource::MergeRequest { project_path, .. } => Some(project_path),
        Resource::Issue { .. } | Resource::Project { .. } => None,
    }
}

/// One sidebar row from a list entry, or `None` when the entry is not a merge request on
/// the configured host.
fn row_from_json(value: &serde_json::Value, gitlab_host: &str) -> Option<MergeRequestRow> {
    let project_path = project_path_of(value, gitlab_host)?;
    let iid = value.get("iid").and_then(serde_json::Value::as_u64)?;
    Some(MergeRequestRow {
        reference: value
            .get("references")
            .and_then(|r| str_field(r, "short"))
            .unwrap_or_else(|| format!("!{iid}")),
        title: str_field(value, "title").unwrap_or_else(|| format!("Merge request !{iid}")),
        state: str_field(value, "state").unwrap_or_default(),
        draft: draft(value),
        web_url: str_field(value, "web_url").unwrap_or_default(),
        source_branch: str_field(value, "source_branch").unwrap_or_default(),
        target_branch: str_field(value, "target_branch").unwrap_or_default(),
        author: person(value.get("author")),
        detailed_merge_status: str_field(value, "detailed_merge_status")
            .or_else(|| str_field(value, "merge_status")),
        labels: labels_field(value),
        user_notes_count: u64_field(value, "user_notes_count"),
        upvotes: u64_field(value, "upvotes"),
        downvotes: u64_field(value, "downvotes"),
        updated_at: str_field(value, "updated_at").unwrap_or_default(),
        created_at: str_field(value, "created_at").unwrap_or_default(),
        project_path,
        iid,
    })
}

/// The full detail from a single-merge-request body. `project_path` and `iid` are the
/// caller's — they are how the page addressed this read, and echoing them back is what
/// keeps every later call (a comment, a merge) aimed at the same resource.
fn detail_from_json(
    value: &serde_json::Value,
    project_path: &str,
    iid: u64,
) -> Option<MergeRequestDetail> {
    value.get("iid").and_then(serde_json::Value::as_u64)?;
    Some(MergeRequestDetail {
        project_path: project_path.to_string(),
        iid,
        reference: value
            .get("references")
            .and_then(|r| str_field(r, "short"))
            .unwrap_or_else(|| format!("!{iid}")),
        title: str_field(value, "title").unwrap_or_else(|| format!("Merge request !{iid}")),
        description: str_field(value, "description"),
        state: str_field(value, "state").unwrap_or_default(),
        draft: draft(value),
        web_url: str_field(value, "web_url").unwrap_or_default(),
        source_branch: str_field(value, "source_branch").unwrap_or_default(),
        target_branch: str_field(value, "target_branch").unwrap_or_default(),
        author: person(value.get("author")),
        assignees: people(value, "assignees"),
        reviewers: people(value, "reviewers"),
        labels: labels_field(value),
        milestone: value.get("milestone").and_then(|m| str_field(m, "title")),
        sha: str_field(value, "sha"),
        merge_status: str_field(value, "merge_status"),
        detailed_merge_status: str_field(value, "detailed_merge_status"),
        has_conflicts: bool_field(value, "has_conflicts"),
        blocking_discussions_resolved: bool_field(value, "blocking_discussions_resolved"),
        squash: bool_field(value, "squash"),
        should_remove_source_branch: value
            .get("should_remove_source_branch")
            .and_then(serde_json::Value::as_bool)
            .or_else(|| value.get("force_remove_source_branch").and_then(serde_json::Value::as_bool)),
        changes_count: str_field(value, "changes_count"),
        user_notes_count: u64_field(value, "user_notes_count"),
        upvotes: u64_field(value, "upvotes"),
        downvotes: u64_field(value, "downvotes"),
        created_at: str_field(value, "created_at").unwrap_or_default(),
        updated_at: str_field(value, "updated_at").unwrap_or_default(),
        merged_at: str_field(value, "merged_at"),
        closed_at: str_field(value, "closed_at"),
        pipeline: pipeline_summary(value),
    })
}

/// The head pipeline of a merge-request body, under either of the two keys GitLab uses.
/// A JSON `null` (no pipeline) is skipped rather than read as a value.
fn pipeline_summary(value: &serde_json::Value) -> Option<PipelineSummary> {
    let pipeline = ["head_pipeline", "pipeline"]
        .into_iter()
        .filter_map(|key| value.get(key).filter(|v| v.is_object()))
        .next()?;
    Some(PipelineSummary {
        id: pipeline.get("id").and_then(serde_json::Value::as_u64)?,
        status: str_field(pipeline, "status")?,
        web_url: str_field(pipeline, "web_url"),
        source: str_field(pipeline, "source"),
        created_at: str_field(pipeline, "created_at"),
        updated_at: str_field(pipeline, "updated_at"),
    })
}

fn job_from_json(value: &serde_json::Value) -> Option<Job> {
    Some(Job {
        id: value.get("id").and_then(serde_json::Value::as_u64)?,
        name: str_field(value, "name").unwrap_or_default(),
        // A job with no stage is drawn under one heading rather than under an empty one.
        stage: str_field(value, "stage").unwrap_or_else(|| "other".to_string()),
        status: str_field(value, "status").unwrap_or_default(),
        allow_failure: bool_field(value, "allow_failure"),
        duration: value.get("duration").and_then(serde_json::Value::as_f64),
        web_url: str_field(value, "web_url"),
        finished_at: str_field(value, "finished_at"),
    })
}

fn note_from_json(value: &serde_json::Value, me: Option<u64>) -> Option<Note> {
    let author = value.get("author");
    let author_id = author.and_then(|a| a.get("id")).and_then(serde_json::Value::as_u64);
    Some(Note {
        id: value.get("id").and_then(serde_json::Value::as_u64)?,
        author: person(author),
        body: str_field(value, "body").unwrap_or_default(),
        system: bool_field(value, "system"),
        created_at: str_field(value, "created_at").unwrap_or_default(),
        updated_at: str_field(value, "updated_at"),
        resolvable: bool_field(value, "resolvable"),
        resolved: bool_field(value, "resolved"),
        // Both halves must be known: an unknown account owns nothing, so the page offers
        // no deletion rather than offering one GitLab would refuse.
        mine: match (me, author_id) {
            (Some(me), Some(author)) => me == author,
            _ => false,
        },
        position: note_position(value.get("position")),
    })
}

fn note_position(value: Option<&serde_json::Value>) -> Option<NotePosition> {
    let value = value.filter(|v| v.is_object())?;
    let position = NotePosition {
        new_path: str_field(value, "new_path"),
        old_path: str_field(value, "old_path"),
        new_line: value.get("new_line").and_then(serde_json::Value::as_u64),
        old_line: value.get("old_line").and_then(serde_json::Value::as_u64),
    };
    // A position naming no file at all says nothing; drop it rather than draw an empty
    // anchor on a comment.
    if position.new_path.is_none() && position.old_path.is_none() {
        return None;
    }
    Some(position)
}

fn discussion_from_json(value: &serde_json::Value, me: Option<u64>) -> Option<Discussion> {
    let notes: Vec<Note> = value
        .get("notes")
        .and_then(serde_json::Value::as_array)
        .map(|arr| arr.iter().filter_map(|note| note_from_json(note, me)).collect())
        .unwrap_or_default();
    // A discussion with no readable note is nothing to draw.
    if notes.is_empty() {
        return None;
    }
    Some(Discussion {
        id: str_field(value, "id")?,
        individual_note: bool_field(value, "individual_note"),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Strip `//` line comments so a source-scanning guardrail inspects CODE, not the
    /// prose that explains it. A `//` preceded by `:` is left alone so the `https://`
    /// inside a string literal survives. Mirrors `gitlab.rs`.
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

    /// The no-write guarantee of the GitLab page's READ half, enforced on this module's
    /// own source. Everything the page writes — a merge, a comment, a close — lives in
    /// `src/gitlab_mr_write.rs`, each behind its own gate; a verb added here would ride
    /// the read path's permissions, which nobody was asked for.
    #[test]
    fn module_issues_only_get_requests() {
        let source = include_str!("gitlab_mr.rs");
        let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source));
        assert!(code.contains("pub async fn fetch_list"), "scanned the wrong text");
        for verb in [".post(", ".put(", ".patch(", ".delete(", ".request("] {
            assert!(
                !code.contains(verb),
                "src/gitlab_mr.rs must issue GET requests only, found `{verb}`. The page's \
                 writes live in src/gitlab_mr_write.rs, behind their own consent gates."
            );
        }
    }

    /// The page never asks for merged merge requests, and the type system is what stops
    /// it: `ListState` has two spellings and neither is `merged`.
    #[test]
    fn the_list_can_only_ask_for_what_is_not_merged() {
        assert_eq!(ListState::from_str("opened"), Some(ListState::Opened));
        assert_eq!(ListState::from_str("closed"), Some(ListState::Closed));
        assert_eq!(ListState::from_str("merged"), None);
        assert_eq!(ListState::from_str("all"), None);
        assert_eq!(ListState::from_str(""), None);
    }

    #[test]
    fn a_scope_is_a_closed_set() {
        for name in ["all", "assigned", "mine", "reviewing"] {
            assert_eq!(ListScope::from_str(name).map(ListScope::as_str), Some(name));
        }
        // Anything a client invents is refused rather than forwarded to GitLab as a
        // query parameter.
        assert_eq!(ListScope::from_str("created_by_me"), None);
        assert_eq!(ListScope::from_str("all&private_token=x"), None);
    }

    #[test]
    fn a_list_query_keys_its_own_cache_entry() {
        let key = ListQuery { scope: ListScope::Reviewing, state: ListState::Opened }.cache_key();
        assert_eq!(key, "list:reviewing:opened");
        // Two different queries never collide, which is what keeps a filter switch from
        // showing the previous filter's rows.
        assert_ne!(
            ListQuery { scope: ListScope::All, state: ListState::Opened }.cache_key(),
            ListQuery { scope: ListScope::All, state: ListState::Closed }.cache_key()
        );
    }

    /// Every read of one merge request shares one prefix, which is what lets a write
    /// forget all of them at once instead of leaving a stale half behind.
    #[test]
    fn one_merge_request_s_reads_share_one_prefix() {
        let prefix = cache_prefix("group/sub/app", 42);
        for kind in ["detail", "notes", "pipeline"] {
            assert!(
                cache_key("group/sub/app", 42, kind).starts_with(&prefix),
                "{kind} must sit under the shared prefix"
            );
        }
        // A neighbouring merge request in the same project is NOT under it, or closing !42
        // would empty the cache of !4.
        assert!(!cache_key("group/sub/app", 4, "detail").starts_with(&prefix));
        // And neither is another project whose path merely starts the same way.
        assert!(!cache_key("group/sub/app-two", 42, "detail").starts_with(&prefix));
    }

    #[test]
    fn builds_the_endpoint_gitlab_documents() {
        // A nested group path travels as ONE segment, or GitLab reads it as a project of
        // its own and answers 404.
        assert_eq!(
            merge_request_api("gitlab.example.com", "group/sub/app", 7),
            "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests/7"
        );
    }

    #[tokio::test]
    async fn a_tokenless_read_never_reaches_the_network() {
        let http = reqwest::Client::new();
        let err = fetch_list(
            &http,
            "gitlab.com",
            None,
            ListQuery { scope: ListScope::All, state: ListState::Opened },
        )
        .await
        .expect_err("the dashboard cannot be read anonymously");
        assert!(err.to_string().contains("needs a personal access token"), "{err}");

        let err = fetch_detail(&http, "gitlab.com", Some("  "), "a/b", 1)
            .await
            .expect_err("a blank token is no token");
        assert!(err.to_string().contains("needs a personal access token"), "{err}");
    }

    /// A row is addressed by what GitLab's own `web_url` says, through the card's parser
    /// — so the host pin holds on the way back too.
    #[test]
    fn a_row_off_the_configured_host_is_dropped() {
        let row = serde_json::json!({
            "iid": 42,
            "title": "Add the page",
            "web_url": "https://gitlab.example.com/group/app/-/merge_requests/42",
        });
        assert_eq!(
            row_from_json(&row, "gitlab.example.com").map(|r| r.project_path),
            Some("group/app".to_string())
        );
        assert!(row_from_json(&row, "gitlab.com").is_none());
        // An issue is not a merge request, whatever the rest of the row says.
        let issue = serde_json::json!({
            "iid": 9,
            "web_url": "https://gitlab.example.com/group/app/-/issues/9",
        });
        assert!(row_from_json(&issue, "gitlab.example.com").is_none());
    }

    #[test]
    fn reads_a_list_row_the_way_the_tenant_answers_it() {
        // The shape measured against the real instance: no `head_pipeline` on a list row,
        // and `detailed_merge_status` present.
        let row = serde_json::json!({
            "iid": 297,
            "title": "feat: lambda policy update",
            "state": "opened",
            "draft": false,
            "web_url": "https://gitlab.example.com/group/infra/terraform/-/merge_requests/297",
            "source_branch": "feat/policy",
            "target_branch": "main",
            "author": { "name": "Leonor Groell", "username": "leonor.groell", "avatar_url": "https://gitlab.example.com/uploads/x.png" },
            "references": { "short": "!297", "full": "group/infra/terraform!297" },
            "detailed_merge_status": "not_approved",
            "labels": ["infra"],
            "user_notes_count": 3,
            "upvotes": 1,
            "updated_at": "2026-08-05T19:25:34.889Z",
            "created_at": "2026-08-01T10:00:00.000Z",
        });
        let parsed = row_from_json(&row, "gitlab.example.com").expect("a merge request row");
        assert_eq!(parsed.project_path, "group/infra/terraform");
        assert_eq!(parsed.iid, 297);
        assert_eq!(parsed.reference, "!297");
        assert_eq!(parsed.detailed_merge_status.as_deref(), Some("not_approved"));
        assert_eq!(parsed.author.name, "Leonor Groell");
        assert_eq!(parsed.labels, vec!["infra"]);
        assert_eq!(parsed.user_notes_count, 3);
        assert_eq!(parsed.downvotes, 0);
    }

    #[test]
    fn a_person_with_no_display_name_falls_back_to_the_handle() {
        let p = person(Some(&serde_json::json!({ "username": "grace" })));
        assert_eq!(p.name, "grace");
        assert_eq!(p.username, "grace");
        assert_eq!(p.avatar_url, None);
        // And a missing user object is a blank rather than a panic.
        assert_eq!(person(None).name, "");
    }

    #[test]
    fn reads_the_detail_the_tenant_answers() {
        let body = serde_json::json!({
            "iid": 596,
            "title": "HA replicas + PodDisruptionBudgets",
            "description": "Adds **two** replicas.",
            "state": "opened",
            "draft": false,
            "web_url": "https://gitlab.example.com/group/app/-/merge_requests/596",
            "source_branch": "feature/ha",
            "target_branch": "rc/9.0",
            "sha": "e2607442e33693652508637a6a02eb9997d496ff",
            "merge_status": "checking",
            "detailed_merge_status": "checking",
            "has_conflicts": false,
            "blocking_discussions_resolved": false,
            "squash": false,
            "force_remove_source_branch": null,
            "changes_count": "11",
            "user_notes_count": 3,
            "author": { "name": "Théophile", "username": "theophile" },
            "reviewers": [{ "name": "Ada", "username": "ada" }],
            "references": { "short": "!596" },
            "head_pipeline": { "id": 190933, "status": "manual", "web_url": "https://gitlab.example.com/p/1" },
            "created_at": "2026-08-04T11:00:00.000Z",
            "updated_at": "2026-08-05T09:00:00.000Z",
        });
        let d = detail_from_json(&body, "group/app", 596).expect("a detail");
        assert_eq!(d.reference, "!596");
        assert_eq!(d.description.as_deref(), Some("Adds **two** replicas."));
        assert_eq!(d.detailed_merge_status.as_deref(), Some("checking"));
        assert!(!d.blocking_discussions_resolved);
        assert_eq!(d.changes_count.as_deref(), Some("11"));
        assert_eq!(d.reviewers.len(), 1);
        assert_eq!(d.sha.as_deref(), Some("e2607442e33693652508637a6a02eb9997d496ff"));
        let pipeline = d.pipeline.as_ref().expect("a head pipeline");
        assert_eq!(pipeline.id, 190933);
        assert_eq!(pipeline.status, "manual");
        // The absent halves stay off the wire, so the TypeScript mirror can treat every
        // optional as truly optional.
        let json = serde_json::to_value(&d).unwrap();
        assert!(json.get("milestone").is_none());
        assert!(json.get("assignees").is_none());
        assert!(json.get("merged_at").is_none());
    }

    #[test]
    fn a_null_pipeline_is_absence_and_not_a_value() {
        assert!(pipeline_summary(&serde_json::json!({ "head_pipeline": null })).is_none());
        assert!(pipeline_summary(&serde_json::json!({})).is_none());
        // A pipeline with no id cannot be addressed, so it is no pipeline for us.
        assert!(pipeline_summary(&serde_json::json!({ "head_pipeline": { "status": "running" } })).is_none());
        // The terser `pipeline` key is read when `head_pipeline` is absent.
        let summary = pipeline_summary(&serde_json::json!({
            "pipeline": { "id": 7, "status": "running" }
        }))
        .expect("a pipeline");
        assert_eq!((summary.id, summary.status.as_str()), (7, "running"));
    }

    #[test]
    fn a_job_with_no_stage_still_has_a_heading() {
        let job = job_from_json(&serde_json::json!({
            "id": 1, "name": "test", "status": "success", "allow_failure": false
        }))
        .expect("a job");
        assert_eq!(job.stage, "other");
        assert_eq!(job.duration, None);
        // A job with no id cannot be linked to, so it is dropped rather than drawn.
        assert!(job_from_json(&serde_json::json!({ "name": "x" })).is_none());
    }

    #[test]
    fn reads_a_standalone_comment_and_a_thread_apart() {
        let standalone = serde_json::json!({
            "id": "7d1a37eb",
            "individual_note": true,
            "notes": [{
                "id": 69848, "system": false, "body": "Looks good",
                "author": { "id": 12, "username": "ada", "name": "Ada" },
                "created_at": "2026-08-04T11:42:17.515Z",
                "resolvable": false, "resolved": null,
            }],
        });
        let parsed = discussion_from_json(&standalone, Some(12)).expect("a discussion");
        assert!(parsed.individual_note);
        assert_eq!(parsed.notes.len(), 1);
        assert!(parsed.notes[0].mine, "id 12 wrote it");
        assert!(!parsed.notes[0].system);
        assert_eq!(parsed.notes[0].position, None);

        // A thread carrying a code comment keeps the file and the line the review section
        // will anchor on.
        let thread = serde_json::json!({
            "id": "9b4a0ff4",
            "individual_note": false,
            "notes": [{
                "id": 69852, "system": false, "type": "DiffNote",
                "body": "MEDIUM: the preStop command interpolates",
                "author": { "id": 77, "username": "bot" },
                "created_at": "2026-08-04T11:46:49.409Z",
                "resolvable": true, "resolved": false,
                "position": { "new_path": "charts/app/templates/deploy.yaml", "new_line": 42 },
            }],
        });
        let parsed = discussion_from_json(&thread, Some(12)).expect("a discussion");
        assert!(!parsed.individual_note);
        assert!(parsed.notes[0].resolvable && !parsed.notes[0].resolved);
        assert!(!parsed.notes[0].mine, "id 77 is somebody else");
        let position = parsed.notes[0].position.as_ref().expect("a position");
        assert_eq!(position.new_path.as_deref(), Some("charts/app/templates/deploy.yaml"));
        assert_eq!(position.new_line, Some(42));
    }

    #[test]
    fn an_unknown_account_owns_no_comment() {
        // `mine` decides whether a deletion is offered, so an unknown token owns nothing.
        let note = serde_json::json!({
            "id": 1, "body": "hi", "author": { "id": 5, "username": "x" },
            "created_at": "now",
        });
        assert!(!note_from_json(&note, None).unwrap().mine);
        // And an authorless note is nobody's either.
        let authorless = serde_json::json!({ "id": 2, "body": "hi", "created_at": "now" });
        assert!(!note_from_json(&authorless, Some(5)).unwrap().mine);
    }

    #[test]
    fn a_discussion_with_nothing_readable_is_dropped() {
        assert!(discussion_from_json(&serde_json::json!({ "id": "x", "notes": [] }), None).is_none());
        // No id: a reply could not be addressed to it.
        assert!(discussion_from_json(
            &serde_json::json!({ "notes": [{ "id": 1, "body": "a", "created_at": "n" }] }),
            None
        )
        .is_none());
    }

    #[test]
    fn a_position_naming_no_file_is_dropped() {
        assert!(note_position(Some(&serde_json::json!({ "new_line": 3 }))).is_none());
        assert!(note_position(Some(&serde_json::json!("not an object"))).is_none());
        assert!(note_position(None).is_none());
    }

    #[test]
    fn a_refusal_says_what_the_user_can_act_on() {
        assert!(refusal(reqwest::StatusCode::UNAUTHORIZED, "merge requests").contains("not accepted"));
        assert!(refusal(reqwest::StatusCode::NOT_FOUND, "the comments").contains("cannot see"));
        assert!(refusal(reqwest::StatusCode::TOO_MANY_REQUESTS, "x").contains("rate-limiting"));
        assert!(refusal(reqwest::StatusCode::IM_A_TEAPOT, "x").contains("418"));
    }
}

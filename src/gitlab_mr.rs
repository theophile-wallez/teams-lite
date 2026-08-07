// The merge-request surface: everything the GitLab page READS.
//
// `src/gitlab.rs` enriches ONE link into a card. This module answers the other question
// — "what is waiting for me, and what is going on inside it?" — which is the whole of the
// GitLab page: a list of merge requests that are not merged, and for one of them its
// description, its live pipeline, its approvals, its DIFF and its comments.
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
//     thread; a `DiffNote` carries the file and line it hangs on. Both shapes travel, so a
//     review comment always names the file it hangs on even when the diff shows another.
//
// The DIFF has four measured facts of its own, and they are the sharpest in this file —
// they are in the section header above [`DiffFile`], with the recon that measured them.
//
// The PICTURES a description and a comment carry are the sixth read ([`fetch_upload`]), and
// they carry a measured fact of the same kind: an upload is served by GitLab's own API route
// and NOT by the web path its markdown writes. See [`UploadRef::endpoint`].

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

/// How many changed files one diff read asks for. GitLab's own maximum, and the number its
/// own diff view caps a merge request at; `x-total` travels beside the rows, so a merge
/// request with more says what it left out rather than looking complete.
const DIFF_PER_PAGE: usize = 100;

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

/// The kind one JOB's log is cached under. It names the job, because a pipeline holds up to
/// fifteen of them and each log is its own read — and it sits under the merge request's own
/// prefix like every other, so a write drops them all together.
pub fn job_cache_kind(job_id: u64) -> String {
    format!("job-{job_id}")
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
    /// The three commits a comment on a diff LINE is addressed by. They travel for the same
    /// reason `sha` does: GitLab places a positioned note against the diff those three
    /// commits describe, so a comment written on a page whose diff has since moved is
    /// refused rather than hung on whichever line now holds that number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_refs: Option<DiffRefs>,
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

/// The three commits GitLab addresses one merge request's diff by.
///
/// Every positioned comment carries all three, so they are read as a set: `base_sha` is
/// where the branch left the target, `head_sha` is the commit the page drew, and `start_sha`
/// is the target's own head at that moment. GitLab resolves a line number against the diff
/// those three describe — which is what makes a comment refer to the line the reader was
/// looking at rather than to whatever now sits at that number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffRefs {
    pub base_sha: String,
    pub head_sha: String,
    pub start_sha: String,
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
    /// The pipeline's stage names, first to last. **The jobs above are NOT in that order**:
    /// GitLab's jobs endpoint answers newest first, which for one pipeline is reverse stage
    /// order (measured — 8 of 12 merge requests on this instance came back reversed, and the
    /// other 4 had one stage). So the order is read separately, over GraphQL, by
    /// [`crate::gitlab_ci_graph::attach`], and is empty whenever that read could not be made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<String>,
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
    /// The names of the jobs this one waits for, and the one field here GitLab's REST API
    /// does not answer: it is filled in afterwards by [`crate::gitlab_ci_graph`] over
    /// GraphQL, and stays empty whenever that read cannot be made. So an empty list means
    /// "nothing is known to be waited for", never "this job starts immediately" — the
    /// graph reads it as the former and groups by stage when no job carries one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<String>,
}

// ---- one job's LOG ----------------------------------------------------------
//
// Pressing a job card opens that job's log on a page of its own. Everything below was
// measured against this instance by `examples/job_trace_recon.rs` — READ-ONLY, over 58 jobs
// of the 12 newest open merge requests — and each fact decides something here:
//
//   - **The trace is `text/plain`, and a LENGTH always travels** (58/58). So nothing about it
//     is JSON, which is why it has a reader of its own below.
//   - **A RANGE READ IS REFUSED.** No `accept-ranges` on any answer, and a `Range` request
//     was answered `200` with the whole log 48 times out of 48. So a log too big to travel
//     cannot be asked for in pieces: the only choice is WHICH end travels, and it is the
//     TAIL — a job fails at the end of its log, which is what a reader opening one is after.
//   - **It is small, until it is not.** Median 11 KB, p90 148 KB, largest 510 KB; median 192
//     lines, largest 4 238 — and the longest single LINE measured 22 129 bytes, which is why
//     the page never wraps by default.
//   - **A job with NO log answers 200 with an empty body** (10 of 58 — 8 `manual`, 2
//     `created`), never a 404. Both are stated rather than drawn as an empty page.
//   - **`failure_reason` is present only on a job that failed** (2 of 58), and `runner`,
//     `started_at`, `finished_at` and `queued_duration` only once a job has really run
//     (48 of 58). Every one of them is therefore optional here.

/// How much of one job's log travels.
///
/// Twice the largest log measured on this instance (510 KB), so nothing real is cut — and a
/// ceiling all the same, because a monorepo job can produce tens of megabytes and this payload
/// crosses a WebSocket into a phone. What travels is the TAIL (see [`tail_of`]): a Range read
/// is refused by this instance, so choosing an end is the only choice there is.
const MAX_TRACE_BYTES: usize = 1024 * 1024;

/// One CI job in full: what the log page's header states.
///
/// Wider than [`Job`], which is a card in a graph — this is the one job a reader opened, so it
/// carries why it failed, what ran it and how long it waited. Every field GitLab omits until a
/// job has run is optional, because a `manual` job carries none of them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobDetail {
    pub id: u64,
    pub name: String,
    pub stage: String,
    pub status: String,
    pub allow_failure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// How long the job waited for a runner. GitLab's own job page states it, and it is the
    /// difference between a slow job and a busy fleet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// GitLab's own word for why a job failed — `script_failure`, `runner_system_failure`,
    /// `job_execution_timeout`. It is the one thing a log cannot always say for itself: a job
    /// killed for taking too long ends mid-sentence with nothing to explain it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    /// What ran it, as the runner describes itself. Nothing about the reader travels here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    /// When somebody ERASED the log. An erased job is why a finished job can have no log at
    /// all, and saying so is the difference between "there is nothing" and "there was
    /// something".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub erased_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline_id: Option<u64>,
}

/// One job's log, with the job it belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JobLog {
    pub job: JobDetail,
    /// The log itself, ANSI and section markers as the runner wrote them — the page parses
    /// both (`web/src/lib/gitlab-job-log.ts`). Empty when the job produced none.
    pub trace: String,
    /// How many bytes GitLab holds, which is more than `trace` when it was cut.
    pub bytes: u64,
    /// Whether `trace` is the TAIL of a longer log. The page says so, and offers GitLab's own
    /// job page for the whole of it — the only thing left, since a Range read is refused.
    pub truncated: bool,
    /// Whether this log is FINISHED. It decides two things: whether the page keeps re-reading
    /// it, and how long the answer is cached — a settled log never changes again.
    pub complete: bool,
    /// Why the LOG could not be read, when the job itself could.
    ///
    /// It is the difference between "this job printed nothing" and "this app does not know what
    /// it printed", and the page says whichever is true — GitLab answers 404 for a job whose
    /// trace file is gone, so both are real states. Without it a refusal was drawn as an empty
    /// log, which is this app stating something it was never told.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_error: Option<String>,
}

/// Whether a job's status means its log will never change again.
///
/// `manual`, `created` and `pending` are deliberately NOT settled: each is a job that has not
/// run yet and may still run, so its empty log is a state rather than a result.
pub fn job_is_settled(status: &str) -> bool {
    matches!(status, "success" | "failed" | "canceled" | "skipped")
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
///
/// `new_line` and `old_line` name the ANCHOR — the one line the thread hangs under, which on
/// a comment about several lines is the LAST of them. Exactly one of the two is set on a line
/// that exists on one side only (an added line has no old line), and both are set on a
/// context line. That is GitLab's own convention and it is deliberately not smoothed over
/// here: which side a line is on is what tells a reader whether a comment is about code that
/// arrived, code that went, or code that stayed.
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
    /// Both ends, when the comment was written about a RANGE of lines. Absent on a comment
    /// about one line, which is what a reader of this field must not have to guess: a range
    /// of one is drawn as a line, because that is what it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_range: Option<NoteLineRange>,
}

/// The two ends of a comment on several lines, in reading order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteLineRange {
    pub start: NoteLineEnd,
    pub end: NoteLineEnd,
}

/// One end of such a range. The line numbers follow [`NotePosition`]'s own convention, and
/// `kind` is GitLab's own word for which side the end sits on — absent on a context line,
/// which belongs to both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteLineEnd {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u64>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
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

// ---- the diff -----------------------------------------------------------------
//
// What one merge request CHANGED, as the Changes section reads it. Everything here follows
// from what `examples/merge_request_diff_recon.rs` measured against the real instance, and
// each measurement is a trap for the next reader:
//
//   - **GitLab's own `diff` opens at `@@`.** There is no `diff --git`, no `--- a/…` and no
//     `+++ b/…` on it — measured on 338 of the 342 rows that carried one, the other four
//     being binary markers. So a renderer that takes a patch has to be handed one this app
//     WROTE, which is [`unified_patch`]: the paths, the modes and the rename come from the
//     row's own fields, and only the hunks are GitLab's text.
//   - **A pure RENAME carries no diff at all**, and its `collapsed` flag is noise. A rename
//     with no content change has nothing to show by definition, so the header alone says it
//     — and reading that empty string as an elision would report every moved file as one
//     GitLab refused to expand.
//   - **The COLLAPSE is a property of the merge request, never of the page.** The same 96 of
//     149 files came back collapsed at every `per_page` from 10 to 100, and the expanded
//     bytes were 174 703 every time: GitLab expands a diff collection up to a byte budget
//     and collapses the rest. So paging is not a way out, `access_raw_diffs` is — and it is
//     only on the older `/changes` (measured: identical row shape, 146 of those 149
//     expanded, 500 KB in one answer, and `/diffs` ignores the parameter). That read is
//     [`DiffDepth::Raw`] and it happens on the reader's own ask, never by default.
//   - **A BINARY file carries a one-line marker** (`Binary files a/… and /dev/null differ`)
//     rather than hunks. It is stated as a binary file; running that sentence through a code
//     renderer would draw GitLab's prose as somebody's code.

/// How a file changed, in the one word the tree and the header both read.
///
/// A closed set rather than the four booleans GitLab sends, because every surface asks the
/// same question — what happened to this file — and four flags is four chances to answer it
/// differently. `renamed` covers both of GitLab's renames: whether the content moved as well
/// is the patch's business, not the tree's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileChange {
    New,
    Deleted,
    Renamed,
    Changed,
}

impl FileChange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Changed => "changed",
        }
    }

    /// Which change a row's own flags describe. `new` and `deleted` win over `renamed`,
    /// because GitLab sets neither pair together and a file that arrived did not move.
    fn from_flags(new: bool, deleted: bool, renamed: bool) -> Self {
        if new {
            Self::New
        } else if deleted {
            Self::Deleted
        } else if renamed {
            Self::Renamed
        } else {
            Self::Changed
        }
    }
}

/// One changed file, and the patch that shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffFile {
    /// The path the file has NOW — its old one for a deletion, since that is the only path
    /// a deleted file ever had. What the tree is keyed on, so every surface names one file
    /// one way.
    pub path: String,
    /// Where it was, when that differs from `path`. Absent otherwise, so a rename is the
    /// one case a surface has two names to draw.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub change: &'static str,
    /// A COMPLETE unified patch for this one file — the `diff --git` header this app wrote
    /// over the hunks GitLab sent. `None` when there is nothing to render: a binary file, or
    /// one GitLab did not expand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch: Option<String>,
    /// Lines added and removed, counted from the hunks. Zero on a file with no patch, which
    /// is honest: nothing arrived to count.
    pub additions: u64,
    pub deletions: u64,
    /// A file GitLab described with a marker instead of hunks. The section says so; it never
    /// draws the marker as code.
    pub binary: bool,
    /// A file GitLab did not expand, because the merge request's diff crossed its own byte
    /// budget. The one state that a second read can mend (see [`DiffDepth::Raw`]).
    pub collapsed: bool,
    /// GitLab's own `generated_file` — a lockfile, a bundle, anything its `.gitattributes`
    /// marks. Carried so the tree can say which files are worth a reader's attention; never
    /// used to hide one, because a generated file is where a surprising change hides.
    pub generated: bool,
}

/// Everything one merge request changed, and what this read left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergeRequestDiff {
    pub files: Vec<DiffFile>,
    /// How many files changed in total, when GitLab says (`x-total`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// True when GitLab holds more files than travelled. A list that stops without saying it
    /// stopped reads as a complete one.
    pub truncated: bool,
    /// How many of the files that DID travel carry no patch because GitLab collapsed them.
    /// The number the section offers its second read for; `0` means there is nothing to ask.
    pub collapsed: u64,
    /// Whether this answer is the EXPANDED read. The section states it, because "GitLab
    /// would not expand these" and "we did not ask it to" are different sentences.
    pub expanded: bool,
}

/// Which of the two diff reads to make.
///
/// A closed set rather than a boolean from the client, for the reason [`ListScope`] is one:
/// the two are different endpoints with different costs, and the page offers exactly these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffDepth {
    /// `GET …/diffs` — the modern endpoint, one page, and whatever GitLab chose to expand.
    /// What opening the Changes section costs.
    Listed,
    /// `GET …/changes?access_raw_diffs=true` — the older endpoint, which reads from Gitaly
    /// and expands everything. Measured at 500 KB for a 149-file merge request, so it is
    /// the reader's own ask and never the default.
    Raw,
}

impl DiffDepth {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "listed" => Some(Self::Listed),
            "raw" => Some(Self::Raw),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Listed => "listed",
            Self::Raw => "raw",
        }
    }

    /// The cache entry this depth's answer is stored under, beneath the merge request's own
    /// prefix — so a write forgets both together.
    pub fn cache_kind(self) -> &'static str {
        match self {
            Self::Listed => "diff",
            Self::Raw => "diff-raw",
        }
    }
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
        return Ok(PipelineView { pipeline: None, jobs: Vec::new(), stages: Vec::new() });
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
    Ok(PipelineView { pipeline: Some(pipeline), jobs, stages: Vec::new() })
}

/// One job in full, with its log.
///
/// Two requests, and the second cannot fail the first: a job whose TRACE is refused is still a
/// job whose state, timing and failure reason the page can state — which is the same contract
/// the jobs list holds inside [`fetch_pipeline`]. An empty log is not a failure at all: it is
/// what GitLab answers for a job that has not run (measured: 10 of 58, all `manual` or
/// `created`), and the page says so.
///
/// The job is addressed by its own id rather than by the merge request, because that is how
/// GitLab addresses one — the merge request travels only to key the cache under the same prefix
/// as every other read of it, so a write drops this too.
pub async fn fetch_job_log(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    job_id: u64,
) -> Result<JobLog> {
    let token = require_token(token)?;
    let base = format!(
        "{}/projects/{}/jobs/{job_id}",
        gitlab::api_base(gitlab_host),
        gitlab::encode_path(project_path),
    );
    let body = read_json(http, &base, token, "the job").await?;
    let job = job_detail_from_json(&body)
        .context("GitLab answered with something that is not a job")?;

    let (trace, trace_error) = match read_text(http, &format!("{base}/trace"), token).await {
        Ok(text) => (text, None),
        Err(e) => {
            // A log that cannot be read costs the LOG and nothing else — the contract the jobs
            // list already holds inside `fetch_pipeline` — but the reason travels with it, because
            // "the job printed nothing" and "we could not read what it printed" are different
            // sentences and only one of them is true.
            eprintln!("[gitlab] the log of job {job_id} could not be read: {e:#}");
            (String::new(), Some(format!("{e:#}")))
        }
    };
    let bytes = trace.len() as u64;
    let complete = job_is_settled(&job.status);
    let (trace, truncated) = tail_of(trace, MAX_TRACE_BYTES);
    Ok(JobLog { job, trace, bytes, truncated, complete, trace_error })
}

/// The LAST `limit` bytes of a log, cut on a line boundary, and whether anything was cut.
///
/// The tail rather than the head because a job fails at the END of its log — and cut at a
/// newline because half a line is half an ANSI sequence, which a renderer would draw as junk.
/// A log that fits is returned untouched, which is nearly every one of them (measured: the
/// largest on this instance is 510 KB against a 1 MiB ceiling).
fn tail_of(trace: String, limit: usize) -> (String, bool) {
    if trace.len() <= limit {
        return (trace, false);
    }
    let from = trace.len() - limit;
    // Searched over the BYTES, because `from` may land inside a character and slicing a `str`
    // there panics. A `\n` byte cannot appear inside a multi-byte character, so the index after
    // one is always a safe place to cut.
    let bytes = trace.as_bytes();
    // The first WHOLE line at or after the cut is where the tail starts. A cut landing exactly
    // on a line's first byte keeps that line — dropping it would throw away a line that fits —
    // and a window holding no newline at all falls back to the next character boundary.
    let start = if from == 0 || bytes[from - 1] == b'\n' {
        from
    } else {
        match bytes[from..].iter().position(|byte| *byte == b'\n') {
            Some(at) => from + at + 1,
            None => (from..trace.len())
                .find(|at| trace.is_char_boundary(*at))
                .unwrap_or(trace.len()),
        }
    };
    (trace[start..].to_string(), true)
}

/// One authenticated GET whose body is TEXT, with GitLab's refusal turned into a sentence.
///
/// A job's log is the one read on this page that is not JSON (measured: `text/plain` on every
/// answer), so it has a reader of its own rather than a flag on [`read_json`].
async fn read_text(http: &reqwest::Client, endpoint: &str, token: &str) -> Result<String> {
    let resp = get(http, endpoint, Some(token)).await.context("gitlab job log")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", refusal(status, "the job's log"));
    }
    resp.text().await.context("gitlab job log body")
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

/// What one merge request changed.
///
/// Two endpoints behind one shape (see [`DiffDepth`]), because the row GitLab returns is
/// byte-for-byte the same on both — measured: `a_mode b_mode collapsed deleted_file diff
/// generated_file new_file new_path old_path renamed_file too_large`, on all 149 rows of
/// `/changes?access_raw_diffs=true` and all 508 rows of `/diffs`. One parser is what keeps
/// the expanded read from being a second, drifting spelling of the plain one.
pub async fn fetch_diff(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    depth: DiffDepth,
) -> Result<MergeRequestDiff> {
    let token = require_token(token)?;
    let base = merge_request_api(gitlab_host, project_path, iid);
    let endpoint = match depth {
        DiffDepth::Listed => format!("{base}/diffs?per_page={DIFF_PER_PAGE}"),
        DiffDepth::Raw => format!("{base}/changes?access_raw_diffs=true"),
    };

    let resp = get(http, &endpoint, Some(token)).await.context("gitlab diff")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", refusal(status, "the changes"));
    }
    // Read before the body, since consuming the response moves it. Only `/diffs` paginates,
    // so only it publishes a count — the expanded read carries every file by construction.
    let total = resp
        .headers()
        .get("x-total")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok());
    let body: serde_json::Value = resp.json().await.context("gitlab diff body")?;

    // `/diffs` answers with the array itself; `/changes` wraps it in the whole merge request.
    let rows = match depth {
        DiffDepth::Listed => body.as_array(),
        DiffDepth::Raw => body.get("changes").and_then(serde_json::Value::as_array),
    };
    let files: Vec<DiffFile> =
        rows.map(|rows| rows.iter().filter_map(diff_file_from_json).collect()).unwrap_or_default();

    let collapsed = files.iter().filter(|file| file.collapsed).count() as u64;
    Ok(MergeRequestDiff {
        truncated: total.is_some_and(|t| t > files.len() as u64),
        collapsed,
        expanded: matches!(depth, DiffDepth::Raw),
        total: total.or(Some(files.len() as u64)),
        files,
    })
}

/// One picture a description or a comment points at, as it travels to the page.
pub struct Upload {
    /// What the BYTES say they are, never what GitLab claimed: this instance answers an
    /// upload `application/octet-stream` (measured), so the claimed type says nothing.
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// An upload named the way its markdown names it: the project it belongs to, GitLab's own
/// secret for the file, and the file's name.
///
/// The page sends these three PRIMITIVES rather than a URL, so no client can aim the token at
/// an address this app did not spell — the rail `gitlab_diff_anchor` already holds for a
/// comment's position. Both halves are shape-checked by [`UploadRef::parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRef {
    pub project_path: String,
    pub secret: String,
    pub filename: String,
}

/// Longest upload this app will carry into a page (bytes). A pasted screenshot is a few
/// hundred KB (the one measured on this instance is 104 KB at 777x312); the cap is the
/// composer's own per-picture ceiling, and anything past it is refused with a sentence
/// rather than buffered whole into a base64 WebSocket frame.
pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;

impl UploadRef {
    /// Check the three parts and keep them, or refuse.
    ///
    /// The secret is GitLab's own `SecureRandom.hex(16)` — 32 hex characters on this
    /// instance — and the filename is one path SEGMENT: neither may carry a slash, a `..` or
    /// anything else that would let a request address something other than one upload of one
    /// project.
    pub fn parse(project_path: &str, secret: &str, filename: &str) -> Result<Self> {
        let project_path = project_path.trim();
        let secret = secret.trim();
        let filename = filename.trim();
        anyhow::ensure!(!project_path.is_empty(), "an upload names no project");
        anyhow::ensure!(
            !secret.is_empty()
                && secret.len() <= 64
                && secret.chars().all(|c| c.is_ascii_hexdigit()),
            "that is not a GitLab upload secret"
        );
        anyhow::ensure!(
            !filename.is_empty()
                && filename.len() <= 255
                && !filename.contains('/')
                && !filename.contains('\\')
                && filename != ".."
                && !filename.chars().any(char::is_control),
            "that is not a GitLab upload filename"
        );
        Ok(Self {
            project_path: project_path.to_string(),
            secret: secret.to_string(),
            filename: filename.to_string(),
        })
    }

    /// The API endpoint that serves the bytes.
    ///
    /// GitLab's own upload API (`GET /projects/:id/uploads/:secret/:filename`) and NOT the web
    /// path the markdown writes (`/uploads/<secret>/<name>`): measured 2026-08-06 on
    /// `git.sia.partners` (18.6.4-ee), that web path answers **404** to this app's token in all
    /// three spellings — the header, the `?private_token=` query and no credential at all —
    /// while this endpoint answers 200 with the picture. It goes through
    /// [`gitlab::api_base`] like every other request this crate makes, which is the host
    /// pinning: the token can only ever reach the host the user configured.
    pub fn endpoint(&self, gitlab_host: &str) -> String {
        format!(
            "{}/projects/{}/uploads/{}/{}",
            gitlab::api_base(gitlab_host),
            gitlab::encode_path(&self.project_path),
            self.secret,
            urlencoding::encode(&self.filename),
        )
    }
}

/// Fetch one upload — a screenshot somebody pasted into a description or a comment.
///
/// This is what makes a picture on the page a picture at all: an upload is served to a SESSION
/// or a token, so a browser asking for it directly is answered 404 (measured, above) — and
/// § The GitLab page promises that nothing on it is fetched from GitLab by the browser. So the
/// bytes travel the way a Teams inline image and a colleague's face already do: the backend
/// asks with the credential it holds, and the page renders a local blob.
///
/// Two rails beyond the host pinning, both mirroring [`crate::sender_icon`]:
///   - a SIZE CAP, checked against the length GitLab publishes before the bytes are read, and
///     again on what really arrived;
///   - the bytes must SNIFF as a raster image (`image_kind`), never on the strength of the
///     type the server claimed — and never SVG, which is a document rather than a bitmap.
pub async fn fetch_upload(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    upload: &UploadRef,
) -> Result<Upload> {
    let token = require_token(token)?;
    let resp = http
        .get(upload.endpoint(gitlab_host))
        .header("PRIVATE-TOKEN", token)
        .header("Accept", "image/*")
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab upload")?;

    let status = resp.status();
    if !status.is_success() {
        // Not [`refusal`]: its sentences are built around a noun phrase like "the changes",
        // and "GitLab has no that picture there" is not a sentence. A picture that cannot be
        // drawn says so where it would have been, so the words are its own.
        anyhow::bail!(
            "{}",
            match status {
                reqwest::StatusCode::NOT_FOUND =>
                    "GitLab no longer holds this picture, or the token cannot see it".to_string(),
                reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN =>
                    "GitLab refused this picture to the stored token".to_string(),
                other => format!("GitLab answered {other} for this picture"),
            }
        );
    }
    // The published length first, so a huge file costs one header rather than its bytes.
    if let Some(length) = resp.content_length() {
        anyhow::ensure!(
            length as usize <= MAX_UPLOAD_BYTES,
            "that picture is larger than {} MB",
            MAX_UPLOAD_BYTES / (1024 * 1024)
        );
    }
    let bytes = resp.bytes().await.context("gitlab upload body")?;
    anyhow::ensure!(
        bytes.len() <= MAX_UPLOAD_BYTES,
        "that picture is larger than {} MB",
        MAX_UPLOAD_BYTES / (1024 * 1024)
    );
    let content_type = crate::sender_icon::image_kind(&bytes)
        .context("GitLab answered with something that is not a picture")?;
    Ok(Upload { content_type: content_type.to_string(), bytes: bytes.to_vec() })
}

/// One changed file from a diff row, or `None` when the row names no file.
fn diff_file_from_json(value: &serde_json::Value) -> Option<DiffFile> {
    // A row with neither path is not a file. Either one alone is enough: GitLab sets both on
    // every row it sends, and a row missing one is still addressable by the other.
    let new_path = str_field(value, "new_path");
    let old_path = str_field(value, "old_path");
    let (new_path, old_path) = match (new_path, old_path) {
        (Some(new_path), Some(old_path)) => (new_path, old_path),
        (Some(path), None) | (None, Some(path)) => (path.clone(), path),
        (None, None) => return None,
    };

    let change = FileChange::from_flags(
        bool_field(value, "new_file"),
        bool_field(value, "deleted_file"),
        bool_field(value, "renamed_file"),
    );
    let hunks = value.get("diff").and_then(serde_json::Value::as_str).unwrap_or("");
    // GitLab's marker for a file it will not diff. Matched on the text because that IS how it
    // travels — the row carries no flag for it, measured on all four such rows.
    let binary = hunks.starts_with("Binary files");
    // A pure rename has no hunks BY DEFINITION, so its empty diff is not an elision — and
    // GitLab sets `collapsed` on those rows anyway, which is what would have made every moved
    // file report as one it refused to expand.
    let collapsed = hunks.is_empty() && !matches!(change, FileChange::Renamed);

    // A file with nothing to render carries no patch at all, so the page states what it is
    // rather than drawing an empty one (see the section header for the three ways that
    // happens). Every other file gets the header this app writes over GitLab's hunks.
    let patch = if binary || collapsed {
        None
    } else {
        Some(unified_patch(value, &old_path, &new_path, change, hunks))
    };
    let (additions, deletions) = count_changed_lines(hunks);

    Some(DiffFile {
        // A deleted file's `new_path` is the path it HAD (GitLab echoes it rather than
        // blanking it), so the same field names every file — but the old path is then not a
        // second name and must not be drawn as a move.
        path: if matches!(change, FileChange::Deleted) { old_path.clone() } else { new_path },
        old_path: if matches!(change, FileChange::Renamed) { Some(old_path) } else { None },
        change: change.as_str(),
        patch,
        additions,
        deletions,
        binary,
        collapsed,
        generated: bool_field(value, "generated_file"),
    })
}

/// A complete unified patch for one file: the header this app writes, over GitLab's hunks.
///
/// GitLab sends the hunks alone (measured — see the section header), so everything a patch
/// parser reads about the FILE has to be written here. The shape is git's own, because that
/// is what every diff renderer parses and because it is the one spelling that can express a
/// pure rename — which carries no hunks at all, and would otherwise be a file with no patch.
fn unified_patch(
    value: &serde_json::Value,
    old_path: &str,
    new_path: &str,
    change: FileChange,
    hunks: &str,
) -> String {
    let a_mode = str_field(value, "a_mode");
    let b_mode = str_field(value, "b_mode");
    let mut patch = format!("diff --git a/{old_path} b/{new_path}\n");
    match change {
        FileChange::New => {
            patch.push_str(&format!("new file mode {}\n", b_mode.as_deref().unwrap_or("100644")));
        }
        FileChange::Deleted => {
            patch.push_str(&format!("deleted file mode {}\n", a_mode.as_deref().unwrap_or("100644")));
        }
        FileChange::Renamed => {
            // `similarity index` is what tells a parser a rename with no hunks is a PURE one
            // rather than a truncated patch, so it is stated from what the hunks say.
            patch.push_str(if hunks.is_empty() {
                "similarity index 100%\n"
            } else {
                "similarity index 90%\n"
            });
            patch.push_str(&format!("rename from {old_path}\nrename to {new_path}\n"));
        }
        FileChange::Changed => {}
    }
    // A mode that CHANGED is stated on a file that neither arrived nor left, because a
    // permission change with no hunks is otherwise a file with an empty patch.
    if matches!(change, FileChange::Changed | FileChange::Renamed) {
        if let (Some(a), Some(b)) = (&a_mode, &b_mode) {
            if a != b {
                patch.push_str(&format!("old mode {a}\nnew mode {b}\n"));
            }
        }
    }

    // The `---` / `+++` pair, which is what a hunk hangs under. `/dev/null` on the side the
    // file does not have, exactly as git writes it.
    if !hunks.is_empty() {
        patch.push_str(&match change {
            FileChange::New => format!("--- /dev/null\n+++ b/{new_path}\n"),
            FileChange::Deleted => format!("--- a/{old_path}\n+++ /dev/null\n"),
            _ => format!("--- a/{old_path}\n+++ b/{new_path}\n"),
        });
        patch.push_str(hunks);
        if !hunks.ends_with('\n') {
            patch.push('\n');
        }
    }
    patch
}

/// How many lines a patch adds and removes, from its hunks alone.
///
/// The `+++` and `---` header lines are never in `hunks` (GitLab does not send them), but the
/// guard stays: this counts what it is given, and a caller that one day hands it a full patch
/// must not have its file header counted as one added and one removed line.
fn count_changed_lines(hunks: &str) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in hunks.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
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
///
/// `pub` rather than crate-private because the READ-ONLY recon examples address a merge
/// request the way this module does — one spelling of the endpoint, measured rather than
/// re-typed (see `examples/merge_request_diff_recon.rs`).
pub fn merge_request_api(gitlab_host: &str, project_path: &str, iid: u64) -> String {
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
        diff_refs: diff_refs(value.get("diff_refs")),
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
        // Never on a REST job row — measured, and re-measured by
        // `examples/pipeline_needs_recon.rs`. `gitlab_ci_graph::attach` fills it.
        needs: Vec::new(),
    })
}

/// One job in full, from the job endpoint's own body.
///
/// A row with no id is not a job; everything else defaults or stays absent, because a `manual`
/// job carries no runner, no timing and no reason — and drawing "0s" over a job that never ran
/// would state something GitLab did not say.
fn job_detail_from_json(value: &serde_json::Value) -> Option<JobDetail> {
    Some(JobDetail {
        id: value.get("id").and_then(serde_json::Value::as_u64)?,
        name: str_field(value, "name").unwrap_or_default(),
        stage: str_field(value, "stage").unwrap_or_else(|| "other".to_string()),
        status: str_field(value, "status").unwrap_or_default(),
        allow_failure: bool_field(value, "allow_failure"),
        duration: value.get("duration").and_then(serde_json::Value::as_f64),
        queued_duration: value.get("queued_duration").and_then(serde_json::Value::as_f64),
        web_url: str_field(value, "web_url"),
        created_at: str_field(value, "created_at"),
        started_at: str_field(value, "started_at"),
        finished_at: str_field(value, "finished_at"),
        failure_reason: str_field(value, "failure_reason"),
        // The runner DESCRIBES itself, and its description is what a reader recognises a
        // fleet's machine by. Its name is the fallback, because an unnamed runner still ran it.
        runner: value
            .get("runner")
            .filter(|runner| !runner.is_null())
            .and_then(|runner| {
                str_field(runner, "description").or_else(|| str_field(runner, "name"))
            }),
        erased_at: str_field(value, "erased_at"),
        pipeline_id: value
            .get("pipeline")
            .and_then(|pipeline| pipeline.get("id"))
            .and_then(serde_json::Value::as_u64),
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

/// GitLab's own identifier for one line of one file: the SHA-1 of the path, and the line's
/// place in each file.
///
/// It lives on the READ side because it is a fact about GitLab's diff model rather than about
/// writing to one: `line_range` names its two ends by it, so anything that reads a diff note
/// or writes one has to spell it the same way. The one caller today is
/// [`crate::gitlab_mr_write::DiffAnchor`], and `examples/merge_request_diff_note_recon.rs`
/// checks this function against the codes GitLab itself stored on real comments — READ-ONLY,
/// so the write it feeds rests on a measurement rather than on a reading of the
/// documentation. It is an identifier and never a security primitive; SHA-1 is GitLab's
/// choice, not one made here.
///
/// BOTH counters always travel, added and removed lines included: a line that exists on one
/// side still carries the place it holds in the other file. That is the asymmetry with a
/// position, which states only the side its line is really on.
pub fn line_code(path: &str, old_line: u64, new_line: u64) -> String {
    use sha1::{Digest as _, Sha1};
    let digest = Sha1::digest(path.as_bytes());
    let mut hex = String::with_capacity(40);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(hex, "{byte:02x}");
    }
    format!("{hex}_{old_line}_{new_line}")
}

/// The three commits a positioned comment is addressed by, when the body carries them.
///
/// All three or none: a position built from two of them names a diff GitLab cannot resolve,
/// so half an answer must not travel as if it were one.
fn diff_refs(value: Option<&serde_json::Value>) -> Option<DiffRefs> {
    let value = value.filter(|v| v.is_object())?;
    Some(DiffRefs {
        base_sha: str_field(value, "base_sha")?,
        head_sha: str_field(value, "head_sha")?,
        start_sha: str_field(value, "start_sha")?,
    })
}

fn note_position(value: Option<&serde_json::Value>) -> Option<NotePosition> {
    let value = value.filter(|v| v.is_object())?;
    let position = NotePosition {
        new_path: str_field(value, "new_path"),
        old_path: str_field(value, "old_path"),
        new_line: value.get("new_line").and_then(serde_json::Value::as_u64),
        old_line: value.get("old_line").and_then(serde_json::Value::as_u64),
        line_range: note_line_range(value.get("line_range")),
    };
    // A position naming no file at all says nothing; drop it rather than draw an empty
    // anchor on a comment.
    if position.new_path.is_none() && position.old_path.is_none() {
        return None;
    }
    Some(position)
}

/// Both ends of a comment on several lines, when GitLab sent both.
///
/// One end alone is dropped: a range with no start is not a range, and drawing it as one
/// would state a span this app cannot read the other side of. `line_code` travels on each end
/// in GitLab's answer and is deliberately NOT kept — it is a hash of the file path with both
/// line counters, so this app can compute the one it needs (see
/// [`crate::gitlab_mr_write::line_code`]) and has no use for one it was handed.
fn note_line_range(value: Option<&serde_json::Value>) -> Option<NoteLineRange> {
    let value = value.filter(|v| v.is_object())?;
    Some(NoteLineRange {
        start: note_line_end(value.get("start"))?,
        end: note_line_end(value.get("end"))?,
    })
}

fn note_line_end(value: Option<&serde_json::Value>) -> Option<NoteLineEnd> {
    let value = value.filter(|v| v.is_object())?;
    let end = NoteLineEnd {
        new_line: value.get("new_line").and_then(serde_json::Value::as_u64),
        old_line: value.get("old_line").and_then(serde_json::Value::as_u64),
        kind: str_field(value, "type"),
    };
    // An end that names no line at all cannot be drawn against anything.
    if end.new_line.is_none() && end.old_line.is_none() {
        return None;
    }
    Some(end)
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

    /// An upload is addressed by GitLab's own API route, and every part of it is checked.
    ///
    /// The endpoint is the measured one (see [`UploadRef::endpoint`]): the web path the
    /// markdown writes answers 404 to this app's token, so a request built from it would
    /// draw a broken picture on every merge request that carries one.
    #[test]
    fn an_upload_is_addressed_by_the_api_route_and_its_parts_are_checked() {
        let upload = UploadRef::parse("group/sub/app", "b37e2830ce128df533186454689df4cd", "image.png")
            .expect("a real upload reference");
        assert_eq!(
            upload.endpoint("git.example.com"),
            "https://git.example.com/api/v4/projects/group%2Fsub%2Fapp/uploads/\
             b37e2830ce128df533186454689df4cd/image.png"
        );
        // A name with characters a path cannot carry raw is encoded, not refused: GitLab
        // keeps the name the author's file had.
        let spaced = UploadRef::parse("app", "abc123", "screen shot (2).png").unwrap();
        assert!(spaced.endpoint("git.example.com").ends_with("/screen%20shot%20%282%29.png"));

        // Nothing that could address something other than one upload of one project.
        for (secret, filename) in [
            ("", "image.png"),
            ("not-hex-!", "image.png"),
            ("abc123", ""),
            ("abc123", "../../../etc/passwd"),
            ("abc123", "sub/image.png"),
            ("abc123", ".."),
        ] {
            assert!(
                UploadRef::parse("app", secret, filename).is_err(),
                "accepted secret {secret:?} filename {filename:?}"
            );
        }
        assert!(UploadRef::parse("", "abc123", "image.png").is_err());
    }

    /// A line code is GitLab's own spelling: the SHA-1 of the file path, then the line's
    /// place in each file. The hash is pinned against `sha1sum` rather than against this
    /// function's own output, and `examples/merge_request_diff_note_recon.rs` checks it
    /// against the codes GitLab itself stored on real comments.
    #[test]
    fn a_line_code_is_the_path_hashed_with_both_line_numbers() {
        assert_eq!(
            line_code("src/server/health.ts", 3, 9),
            "306bf1fe4ea9f8a8810c1131e313b0e1e163da6a_3_9"
        );
        assert_eq!(
            line_code("charts/user-facing/values.yaml", 12, 12),
            "e3ab9281f6234480d8a671315eede03af0c56a02_12_12"
        );
        // The path is hashed as its own bytes, so nothing about it is normalised: a rename
        // is two files to GitLab and two line codes here.
        assert_ne!(line_code("a.ts", 1, 1), line_code("b.ts", 1, 1));
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
            "diff_refs": {
                "base_sha": "aa11",
                "head_sha": "bb22",
                "start_sha": "cc33",
            },
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
        // The three commits a comment on a diff line is placed against. All three or none:
        // GitLab cannot resolve a position built from two of them.
        let refs = d.diff_refs.as_ref().expect("diff refs");
        assert_eq!((refs.base_sha.as_str(), refs.head_sha.as_str()), ("aa11", "bb22"));
        assert_eq!(refs.start_sha, "cc33");
        assert!(
            diff_refs(Some(&serde_json::json!({ "base_sha": "a", "head_sha": "b" }))).is_none(),
            "two of the three commits name no diff"
        );
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

    /// The job endpoint's own body, as `examples/job_trace_recon.rs` measured it on this
    /// instance — including the two shapes that decide what the page can state: a job that
    /// RAN carries a runner, its timings and, when it failed, GitLab's own reason; a `manual`
    /// job carries none of them, and every one of those fields is absent rather than zero.
    #[test]
    fn reads_the_job_the_tenant_answers() {
        let ran = job_detail_from_json(&serde_json::json!({
            "id": 1_284_501,
            "name": "unit tests",
            "stage": "test",
            "status": "failed",
            "allow_failure": false,
            "duration": 214.63,
            "queued_duration": 3.1,
            "failure_reason": "script_failure",
            "created_at": "2026-08-06T09:12:00.000Z",
            "started_at": "2026-08-06T09:12:04.000Z",
            "finished_at": "2026-08-06T09:15:38.000Z",
            "web_url": "https://git.example.com/g/app/-/jobs/1284501",
            "runner": { "id": 9, "description": "shared-runner-04", "name": "gitlab-runner" },
            "pipeline": { "id": 55_120, "status": "failed" },
        }))
        .expect("a job");
        assert_eq!(ran.failure_reason.as_deref(), Some("script_failure"));
        // The runner DESCRIBES itself, and the description wins over the name.
        assert_eq!(ran.runner.as_deref(), Some("shared-runner-04"));
        assert_eq!(ran.pipeline_id, Some(55_120));
        assert!(job_is_settled(&ran.status));

        let manual = job_detail_from_json(&serde_json::json!({
            "id": 7,
            "name": "deploy",
            "stage": "deploy",
            "status": "manual",
            "allow_failure": false,
            "duration": null,
            "runner": null,
            "failure_reason": null,
        }))
        .expect("a job");
        assert_eq!((manual.duration, manual.queued_duration), (None, None));
        assert_eq!((manual.runner, manual.failure_reason, manual.started_at), (None, None, None));
        // A job that has not run yet is NOT settled: its empty log is a state, and it may
        // still be started by somebody — so nothing may cache it as final.
        assert!(!job_is_settled(&manual.status));
        for state in ["running", "pending", "created", "waiting_for_resource"] {
            assert!(!job_is_settled(state), "{state} is not a finished job");
        }
        for state in ["success", "failed", "canceled", "skipped"] {
            assert!(job_is_settled(state), "{state} is a finished job");
        }
        // A body that is not a job at all is refused rather than drawn as an empty header.
        assert!(job_detail_from_json(&serde_json::json!({ "name": "x" })).is_none());
    }

    /// A log too big to travel is cut at the END, on a line boundary.
    ///
    /// The tail because a job fails at the end of its log; the boundary because half a line is
    /// half an ANSI sequence. A Range read is refused by this instance
    /// (`examples/job_trace_recon.rs`), so which end travels is the only choice there is.
    #[test]
    fn a_log_too_big_to_travel_keeps_its_tail_whole_lines_only() {
        let whole = "one\ntwo\nthree\n".to_string();
        assert_eq!(tail_of(whole.clone(), 1024), (whole, false));

        let (tail, truncated) = tail_of("aaaa\nbbbb\ncccc\ndddd\n".to_string(), 10);
        assert!(truncated);
        // The tail starts after a newline, so the first line is a whole one.
        assert_eq!(tail, "cccc\ndddd\n");
        assert!(!tail.starts_with('\n'));

        // A log with no newline in the window at all still cuts on a character boundary rather
        // than panicking in the middle of one.
        let (tail, truncated) = tail_of("héllo wörld".to_string(), 4);
        assert!(truncated);
        assert!("héllo wörld".ends_with(&tail));

        // The ceiling is generous against what was measured (510 KB the largest), so a real
        // log travels whole.
        assert!(MAX_TRACE_BYTES > 512 * 1024);
    }

    /// One job's log sits under its merge request's own prefix, so a write drops it with
    /// everything else — and each job keys its own entry, because a pipeline holds fifteen.
    #[test]
    fn every_job_log_sits_under_the_merge_requests_prefix() {
        let prefix = cache_prefix("group/sub/app", 42);
        let one = cache_key("group/sub/app", 42, &job_cache_kind(1_284_501));
        let other = cache_key("group/sub/app", 42, &job_cache_kind(1_284_502));
        assert!(one.starts_with(&prefix) && other.starts_with(&prefix));
        assert_ne!(one, other);
        assert_ne!(one, cache_key("group/sub/app", 42, "pipeline"));
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
        assert_eq!(position.line_range, None, "one line is not a range");
    }

    /// A comment about SEVERAL lines carries both of its ends, in the shape measured on this
    /// instance's own range comments — `{line_code, old_line, new_line, type}`. The line code
    /// is deliberately dropped: it is a hash of the path with both counters, which this crate
    /// computes (see [`line_code`]) and has no use for second-hand.
    #[test]
    fn reads_both_ends_of_a_comment_about_several_lines() {
        let note = serde_json::json!({
            "id": 70001, "body": "This whole block drains twice.",
            "author": { "id": 12, "username": "ada" },
            "position": {
                "new_path": "src/server/health.ts",
                "old_path": "src/server/health.ts",
                "position_type": "text",
                "old_line": null,
                "new_line": 11,
                "line_range": {
                    "start": {
                        "line_code": "306bf1fe4ea9f8a8810c1131e313b0e1e163da6a_8_9",
                        "type": null,
                        "old_line": 8,
                        "new_line": 9,
                    },
                    "end": {
                        "line_code": "306bf1fe4ea9f8a8810c1131e313b0e1e163da6a_8_11",
                        "type": "new",
                        "old_line": null,
                        "new_line": 11,
                    },
                },
            },
        });
        let parsed = note_from_json(&note, Some(12)).expect("a note");
        let position = parsed.position.expect("a position");
        // The ANCHOR is the LAST line of the range, which is where GitLab draws the thread.
        assert_eq!((position.new_line, position.old_line), (Some(11), None));
        let range = position.line_range.expect("a range");
        assert_eq!((range.start.old_line, range.start.new_line), (Some(8), Some(9)));
        assert_eq!(range.start.kind, None, "a context end names no side");
        assert_eq!(range.end.kind.as_deref(), Some("new"));
        // Half a range is not a range: an end nobody can read leaves nothing to draw a span
        // between, so the whole range is dropped rather than half-stated.
        assert!(note_line_range(Some(&serde_json::json!({ "start": { "new_line": 3 } }))).is_none());
        assert!(note_line_range(Some(&serde_json::json!({}))).is_none());
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

    /// Every read of one merge request shares one prefix — the DIFF included, or a merge
    /// would leave the changes of the branch it just landed in the cache.
    #[test]
    fn both_diff_reads_sit_under_the_merge_requests_own_prefix() {
        let prefix = cache_prefix("group/sub/app", 42);
        for depth in [DiffDepth::Listed, DiffDepth::Raw] {
            assert!(
                cache_key("group/sub/app", 42, depth.cache_kind()).starts_with(&prefix),
                "{} must sit under the shared prefix",
                depth.as_str()
            );
        }
        // The two depths are different answers and must never share an entry: the plain read
        // is what opening the section costs, and serving it as the expanded one would report
        // collapsed files as expanded.
        assert_ne!(DiffDepth::Listed.cache_kind(), DiffDepth::Raw.cache_kind());
    }

    #[test]
    fn a_diff_depth_is_a_closed_set() {
        for name in ["listed", "raw"] {
            assert_eq!(DiffDepth::from_str(name).map(DiffDepth::as_str), Some(name));
        }
        // A client cannot invent one, for the reason a scope cannot: it decides which GitLab
        // endpoint the token reaches.
        assert_eq!(DiffDepth::from_str("changes"), None);
        assert_eq!(DiffDepth::from_str("access_raw_diffs=true"), None);
        assert_eq!(DiffDepth::from_str(""), None);
    }

    /// The shape the tenant really answers with, and the patch this app writes over it.
    #[test]
    fn writes_the_header_gitlab_never_sends() {
        // Measured: `diff` opens at `@@`, with no `diff --git` and no `---` / `+++`.
        let row = serde_json::json!({
            "old_path": "src/lib/greet.ts",
            "new_path": "src/lib/greet.ts",
            "a_mode": "100644",
            "b_mode": "100644",
            "new_file": false,
            "renamed_file": false,
            "deleted_file": false,
            "generated_file": false,
            "collapsed": false,
            "too_large": false,
            "diff": "@@ -1,3 +1,4 @@\n export function greet() {\n-  return \"hi\";\n+  const out = \"hello\";\n+  return out;\n }\n",
        });
        let file = diff_file_from_json(&row).expect("a changed file");
        assert_eq!(file.path, "src/lib/greet.ts");
        assert_eq!(file.old_path, None, "an unmoved file has no second name");
        assert_eq!(file.change, "changed");
        assert_eq!((file.additions, file.deletions), (2, 1));
        assert!(!file.binary && !file.collapsed && !file.generated);
        let patch = file.patch.expect("a patch");
        // The header is what a diff renderer reads the file from, and GitLab sent none of it.
        assert!(patch.starts_with("diff --git a/src/lib/greet.ts b/src/lib/greet.ts\n"), "{patch}");
        assert!(patch.contains("--- a/src/lib/greet.ts\n+++ b/src/lib/greet.ts\n"), "{patch}");
        // GitLab's own hunks travel untouched, under it.
        assert!(patch.contains("@@ -1,3 +1,4 @@\n"), "{patch}");
        assert!(patch.ends_with('\n'), "a patch ends in a newline");
    }

    #[test]
    fn a_new_file_and_a_deleted_one_name_dev_null_on_the_side_they_lack() {
        let added = diff_file_from_json(&serde_json::json!({
            "old_path": "docs/new.md", "new_path": "docs/new.md",
            "a_mode": "0", "b_mode": "100644",
            "new_file": true, "renamed_file": false, "deleted_file": false,
            "diff": "@@ -0,0 +1,2 @@\n+# Title\n+Body\n",
        }))
        .expect("a new file");
        assert_eq!(added.change, "new");
        assert_eq!((added.additions, added.deletions), (2, 0));
        let patch = added.patch.expect("a patch");
        assert!(patch.contains("new file mode 100644\n"), "{patch}");
        assert!(patch.contains("--- /dev/null\n+++ b/docs/new.md\n"), "{patch}");

        let gone = diff_file_from_json(&serde_json::json!({
            "old_path": "docs/old.md", "new_path": "docs/old.md",
            "a_mode": "100644", "b_mode": "0",
            "new_file": false, "renamed_file": false, "deleted_file": true,
            "diff": "@@ -1,2 +0,0 @@\n-# Title\n-Body\n",
        }))
        .expect("a deleted file");
        assert_eq!(gone.change, "deleted");
        // A deleted file is named by the path it HAD, and that path is not a second name.
        assert_eq!(gone.path, "docs/old.md");
        assert_eq!(gone.old_path, None);
        let patch = gone.patch.expect("a patch");
        assert!(patch.contains("deleted file mode 100644\n"), "{patch}");
        assert!(patch.contains("--- a/docs/old.md\n+++ /dev/null\n"), "{patch}");
    }

    /// A pure rename carries NO diff, and that empty string is not an elision.
    ///
    /// Measured on this tenant: every renamed row came back with `diff: ""`, and several of
    /// them with `collapsed: true` as well. Reading either as "GitLab would not expand this"
    /// would report every moved file as one the reader has to ask again for.
    #[test]
    fn a_pure_rename_is_a_rename_and_never_a_collapsed_file() {
        let file = diff_file_from_json(&serde_json::json!({
            "old_path": "src/old/name.ts", "new_path": "src/new/name.ts",
            "a_mode": "100644", "b_mode": "100644",
            "new_file": false, "renamed_file": true, "deleted_file": false,
            "collapsed": true,
            "diff": "",
        }))
        .expect("a renamed file");
        assert_eq!(file.change, "renamed");
        assert!(!file.collapsed, "a rename with no hunks has nothing to expand");
        assert_eq!(file.path, "src/new/name.ts");
        assert_eq!(file.old_path.as_deref(), Some("src/old/name.ts"));
        let patch = file.patch.expect("a rename still has a patch — its header IS the change");
        assert!(patch.contains("similarity index 100%\n"), "{patch}");
        assert!(patch.contains("rename from src/old/name.ts\nrename to src/new/name.ts\n"), "{patch}");
        // With no hunks there is nothing for a `---` / `+++` pair to hang under.
        assert!(!patch.contains("---"), "{patch}");

        // A rename that ALSO changed content keeps both halves.
        let moved = diff_file_from_json(&serde_json::json!({
            "old_path": "a.ts", "new_path": "b.ts",
            "a_mode": "100644", "b_mode": "100644",
            "new_file": false, "renamed_file": true, "deleted_file": false,
            "diff": "@@ -1 +1 @@\n-one\n+two\n",
        }))
        .expect("a renamed file");
        let patch = moved.patch.expect("a patch");
        assert!(patch.contains("similarity index 90%\n"), "{patch}");
        assert!(patch.contains("--- a/a.ts\n+++ b/b.ts\n"), "{patch}");
    }

    #[test]
    fn a_binary_file_is_stated_and_never_rendered_as_code() {
        // GitLab's own marker, which is how a binary file travels — there is no flag for it.
        let file = diff_file_from_json(&serde_json::json!({
            "old_path": "docs/diagram.png", "new_path": "docs/diagram.png",
            "a_mode": "100644", "b_mode": "0",
            "new_file": false, "renamed_file": false, "deleted_file": true,
            "diff": "Binary files a/docs/diagram.png and /dev/null differ\n",
        }))
        .expect("a binary file");
        assert!(file.binary);
        assert!(!file.collapsed, "GitLab answered about this file — it simply will not diff it");
        assert_eq!(file.patch, None, "a marker sentence is not somebody's code");
        assert_eq!((file.additions, file.deletions), (0, 0));
    }

    #[test]
    fn a_collapsed_file_carries_no_patch_and_says_so() {
        let file = diff_file_from_json(&serde_json::json!({
            "old_path": "src/big.ts", "new_path": "src/big.ts",
            "a_mode": "100644", "b_mode": "100644",
            "new_file": false, "renamed_file": false, "deleted_file": false,
            "collapsed": true, "too_large": false,
            "diff": "",
        }))
        .expect("a collapsed file");
        assert!(file.collapsed);
        assert_eq!(file.patch, None);
        assert_eq!(file.change, "changed");
    }

    #[test]
    fn a_mode_only_change_states_the_mode() {
        let file = diff_file_from_json(&serde_json::json!({
            "old_path": "bin/run.sh", "new_path": "bin/run.sh",
            "a_mode": "100644", "b_mode": "100755",
            "new_file": false, "renamed_file": false, "deleted_file": false,
            "diff": "@@ -1 +1 @@\n-#!/bin/sh\n+#!/usr/bin/env bash\n",
        }))
        .expect("a file");
        let patch = file.patch.expect("a patch");
        assert!(patch.contains("old mode 100644\nnew mode 100755\n"), "{patch}");
    }

    #[test]
    fn a_row_naming_no_file_is_dropped() {
        assert!(diff_file_from_json(&serde_json::json!({ "diff": "@@ -1 +1 @@\n+x\n" })).is_none());
        // One path alone is enough: it still names a file.
        let file = diff_file_from_json(&serde_json::json!({
            "new_path": "only.txt", "diff": "@@ -0,0 +1 @@\n+x\n", "new_file": true
        }))
        .expect("a file");
        assert_eq!(file.path, "only.txt");
    }

    #[test]
    fn counts_only_the_lines_a_hunk_changed() {
        // A `+++` / `---` pair is never in GitLab's hunks, but a caller that hands one over
        // must not have the file header counted as a change.
        assert_eq!(
            count_changed_lines("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n"),
            (1, 1)
        );
        assert_eq!(count_changed_lines(""), (0, 0));
        // A context line that happens to start with a space is neither.
        assert_eq!(count_changed_lines("@@ -1 +1 @@\n x\n"), (0, 0));
    }

    #[tokio::test]
    async fn a_tokenless_diff_read_never_reaches_the_network() {
        let http = reqwest::Client::new();
        for depth in [DiffDepth::Listed, DiffDepth::Raw] {
            let err = fetch_diff(&http, "gitlab.com", None, "a/b", 1, depth)
                .await
                .expect_err("a diff cannot be read anonymously");
            assert!(err.to_string().contains("needs a personal access token"), "{err}");
        }
    }

    #[test]
    fn a_refusal_says_what_the_user_can_act_on() {
        assert!(refusal(reqwest::StatusCode::UNAUTHORIZED, "merge requests").contains("not accepted"));
        assert!(refusal(reqwest::StatusCode::NOT_FOUND, "the comments").contains("cannot see"));
        assert!(refusal(reqwest::StatusCode::TOO_MANY_REQUESTS, "x").contains("rate-limiting"));
        assert!(refusal(reqwest::StatusCode::IM_A_TEAPOT, "x").contains("418"));
    }
}

// The six writes the GitLab page makes, and nothing else.
//
// Everything this app knows about a tracker reads (`src/gitlab.rs` and `src/gitlab_mr.rs`
// issue GET requests only, and a test on each one's source keeps it that way). Two modules
// write, both deliberately: `src/gitlab_approval.rs` holds an approval and its undo, and
// this one holds what the merge request PAGE offers on top of it —
//
//   1. **MERGE** the branch (`PUT …/merge`).
//   2. **COMMENT** on it — `POST …/notes` for a comment of its own, `POST
//      …/discussions/{id}/notes` for a reply into a thread, and `POST …/discussions` with a
//      `position` for a comment on a DIFF LINE. Three shapes of one write: they reach the
//      same people, they are undone by the same deletion, and they differ only in where
//      GitLab files the words.
//   3. **DELETE one of the user's OWN comments** (`DELETE …/notes/{id}`) — the undo of 2.
//   4. **EDIT one of the user's OWN comments** (`PUT …/notes/{id}`) — rewrite what they posted.
//   5. **RESOLVE a thread, or open it again** (`PUT …/discussions/{id}` with `resolved`), which
//      are each other's undo.
//   6. **CLOSE or REOPEN** it (`PUT …` with `state_event`), which are each other's undo.
//
// Every one is an `OUTWARD_METHODS` entry in `src/bin/server.rs`: the write token, refused
// by a read-only backend, and the automation hook refuses a command line that names the
// endpoint. Each carries out one click the user just made, and nothing here ever acts on
// its own.
//
// **The MERGE is the one write in this app that cannot be taken back**, and that is stated
// rather than hidden. § The trackers in AGENTS.md refuses an irreversible write on
// principle — it is why `forceavailability` is banned and why the approval was acceptable
// — and a merge is the deliberate exception the user asked for, so it carries every rail
// that can be put in front of it:
//
//   - **The head commit travels with it.** GitLab refuses a merge whose `sha` is not the
//     branch's head, so a merge request that moved after the page read it is refused by
//     GitLab rather than landing a commit the reader never saw. The page sends the `sha`
//     it drew, never a fresh one.
//   - **The user asks twice.** The button arms a confirmation naming the target branch,
//     the same shape Delete uses for a message.
//   - **It is offered only where GitLab would accept it.** `detailed_merge_status` says
//     whether the merge request can merge at all, so a blocked one offers a disabled
//     control with the reason on it instead of a refusal after the fact.
//   - **The outcome is reported where the click was made**, in GitLab's own words on a
//     failure. An outward action that failed must never be left looking like it worked.
//
// The five others are ordinary because each has an undo, and each undo is on the same page:
// a comment is deleted by whoever wrote it, a close is undone by a reopen, a resolution by
// opening the thread again. The EDIT is the one with an asterisk — it can be edited back, but
// the words that were there are gone, which is exactly where a Teams message edit sits — and it
// is offered only on the user's OWN comment, checked before the network like the deletion.
// Every one of them still reaches every person watching the merge request, under the user's
// name, so each is gated exactly like a send and never written by anything but their own press.
//
// **A comment on a diff LINE names a commit, and that is the second place in this module
// where a commit is a rail rather than a detail.** A line number means nothing on its own
// across a push — the diff moves and the number stays — so a [`DiffAnchor`] carries the three
// commits the diff was read at, and GitLab refuses a position it cannot place in that diff.
// So a comment written on a page that has since gone stale is refused instead of landing on
// whichever line now holds that number, which is the failure this rail exists for and the
// only one a reader could not detect for themselves.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;

use crate::gitlab;
use crate::gitlab_mr::{self, line_code, DiffRefs, Person};

/// How long to wait on the GitLab API. The same 15 s the page's reads take: this is an
/// action the user is watching the outcome of.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Longest comment accepted, in bytes. GitLab's own limit is 1 000 000 characters; this is
/// a chat-shaped composer, and a cap here means a runaway paste is refused on this machine
/// instead of after a megabyte crossed the network.
pub const MAX_COMMENT_BYTES: usize = 64 * 1024;

/// What a merge asks for. Every field is the merge request's OWN state as the page read it
/// — never a default invented here, because each one changes what lands in the branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRequest {
    pub project_path: String,
    pub iid: u64,
    /// The head commit the reader was looking at. GitLab refuses the merge when the branch
    /// has moved past it, which is the whole reason it travels.
    pub sha: String,
    /// Squash the branch into one commit. The project asks for this per merge request
    /// (`squash` on the body), so the page echoes what it read.
    pub squash: bool,
    /// Remove the source branch afterwards, when the merge request says so.
    pub remove_source_branch: Option<bool>,
}

/// What one merge answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MergeResult {
    /// GitLab's state afterwards — `merged` on success.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_commit_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merged_at: Option<String>,
}

/// Which way a state change goes. Two spellings, each the other's undo — a set of two
/// rather than a string, so nothing else can ever be sent as a `state_event`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateChange {
    Close,
    Reopen,
}

impl StateChange {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "close" => Some(Self::Close),
            "reopen" => Some(Self::Reopen),
            _ => None,
        }
    }

    /// GitLab's own `state_event` value.
    fn event(self) -> &'static str {
        match self {
            Self::Close => "close",
            Self::Reopen => "reopen",
        }
    }
}

/// What one comment answered: the note as GitLab stored it, so the page draws what really
/// landed rather than what was typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PostedNote {
    pub id: u64,
    pub author: Person,
    pub body: String,
    pub created_at: String,
    /// The discussion it belongs to, when GitLab says. A reply carries the thread it
    /// landed in; a new standalone comment usually carries its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discussion_id: Option<String>,
}

/// Merge one merge request.
///
/// THE irreversible write. See the module header for the four rails in front of it; this
/// function holds the last two: a token is required, and the head commit travels so GitLab
/// can refuse a branch that moved.
pub async fn merge(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    request: &MergeRequest,
) -> Result<MergeResult> {
    let token = gitlab_mr::require_token(token)?;
    anyhow::ensure!(
        !request.sha.trim().is_empty(),
        "a merge needs the commit the page read, so GitLab can refuse a branch that moved"
    );

    let endpoint = format!(
        "{}/merge",
        gitlab_mr::merge_request_api(gitlab_host, &request.project_path, request.iid)
    );
    let mut body = json!({
        "sha": request.sha,
        "squash": request.squash,
    });
    if let Some(remove) = request.remove_source_branch {
        body["should_remove_source_branch"] = json!(remove);
    }

    let resp = http
        .put(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .json(&body)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab merge request")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", merge_refusal(status, &read_gitlab_message(resp).await));
    }

    let answered: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(MergeResult {
        state: string_field(&answered, "state").unwrap_or_else(|| "merged".to_string()),
        merge_commit_sha: string_field(&answered, "merge_commit_sha")
            .or_else(|| string_field(&answered, "squash_commit_sha")),
        merged_at: string_field(&answered, "merged_at"),
    })
}

/// Close or reopen one merge request. Each direction is the other's undo, which is why
/// both live in one call behind one gate.
pub async fn set_state(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    change: StateChange,
) -> Result<String> {
    let token = gitlab_mr::require_token(token)?;
    let endpoint = gitlab_mr::merge_request_api(gitlab_host, project_path, iid);
    let resp = http
        .put(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .json(&json!({ "state_event": change.event() }))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab merge request state")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", state_refusal(status, change, &read_gitlab_message(resp).await));
    }
    let answered: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(string_field(&answered, "state").unwrap_or_else(|| match change {
        StateChange::Close => "closed".to_string(),
        StateChange::Reopen => "opened".to_string(),
    }))
}

/// Which side of a diff one line sits on.
///
/// A closed set rather than a string from the client, for the reason [`StateChange`] is one:
/// it decides which line numbers a position may state, and GitLab refuses a position whose
/// numbers do not match the line it names. A context line is `Both` — it exists in each file
/// — and GitLab's own answer names no side for one, which is why [`Self::range_type`]
/// returns nothing there rather than picking a side on its behalf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineSide {
    /// A line that was REMOVED: it exists in the old file only.
    Old,
    /// A line that was ADDED: it exists in the new file only.
    New,
    /// A line that did not change, so it exists in both.
    Both,
}

impl LineSide {
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "old" => Some(Self::Old),
            "new" => Some(Self::New),
            "both" => Some(Self::Both),
            _ => None,
        }
    }

    /// GitLab's own word for the side a RANGE END sits on, and `None` for a context line,
    /// which belongs to both files and which GitLab's own model names with a nil there.
    ///
    /// Measured over this instance's own range comments: their ends carry `new`, `old` and
    /// `expanded` — the last being GitLab's word for a context line inside a region somebody
    /// OPENED, which is a line this app cannot select (its patch holds the hunks GitLab sent
    /// and nothing beyond them), so it is deliberately never written here.
    fn range_type(self) -> Option<&'static str> {
        match self {
            Self::Old => Some("old"),
            Self::New => Some("new"),
            Self::Both => None,
        }
    }
}

/// One line of a diff, as GitLab addresses one.
///
/// Both counters always travel, because GitLab's own line identity is the PAIR: a line code
/// is `SHA1(<path>)_<old>_<new>` for every line, added and removed ones included — a line
/// that exists on one side still carries the position it holds in the other file. What
/// `side` decides is narrower and separate: which of the two the POSITION states, since
/// GitLab refuses an `old_line` on a line that was added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnchorLine {
    /// Where this line sits in the old file — for an added line, the line it follows.
    pub old: u64,
    /// Where it sits in the new file — for a removed line, the line it followed.
    pub new: u64,
    pub side: LineSide,
}

impl AnchorLine {
    /// The `old_line` a position states for this line, which is nothing on a line that was
    /// added: it is not in the old file, so naming a number there describes another line.
    fn position_old_line(self) -> Option<u64> {
        matches!(self.side, LineSide::Old | LineSide::Both).then_some(self.old)
    }

    fn position_new_line(self) -> Option<u64> {
        matches!(self.side, LineSide::New | LineSide::Both).then_some(self.new)
    }

    /// One end of a `line_range`, in GitLab's own shape.
    fn range_end(self, path: &str) -> serde_json::Value {
        let mut end = json!({ "line_code": line_code(path, self.old, self.new) });
        if let Some(kind) = self.side.range_type() {
            end["type"] = json!(kind);
        }
        if let Some(old) = self.position_old_line() {
            end["old_line"] = json!(old);
        }
        if let Some(new) = self.position_new_line() {
            end["new_line"] = json!(new);
        }
        end
    }
}

/// Where on a diff a comment hangs: the file, the line, and the commits that line is a line
/// OF.
///
/// Every field of it is MEASURED rather than read off the documentation, because there is no
/// sandbox project to try a comment against: `examples/merge_request_diff_note_recon.rs`
/// walks the positions GitLab itself stored on this instance's own comments, READ-ONLY, and
/// checks each rule here against them — that a position is always `text`, that it states the
/// new line alone on an added line and both on a context line, that a range's ends are
/// `{line_code, old_line, new_line, type}`, and that the line code this crate computes is the
/// one GitLab wrote.
///
/// The three commits are what make this a comment about the code the reader was reading. A
/// line number on its own means nothing across a push — the diff moves and the number stays
/// — so GitLab resolves the position against the diff `base_sha`, `head_sha` and `start_sha`
/// describe, and refuses one it cannot place. That refusal is the feature: it is the same
/// rail the merge's own `sha` is (see the module header), applied to the one other write
/// here that names a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffAnchor {
    pub refs: DiffRefs,
    /// The path the file has now. Empty on a deleted file, which has only ever had one.
    pub new_path: String,
    /// The path it had. Empty on a file that was added.
    pub old_path: String,
    /// The line the thread hangs under — the LAST line when the comment is about several,
    /// which is where GitLab draws one and therefore where this app must ask for it.
    pub line: AnchorLine,
    /// The FIRST line, when the comment is about several. `None` for one line, because a
    /// range of one is a line and GitLab's own answer carries no `line_range` for it.
    pub start: Option<AnchorLine>,
}

impl DiffAnchor {
    /// The path a line code is hashed from: GitLab's own `new_path.presence || old_path`, so
    /// a deleted file's lines are addressed by the only path it ever had.
    fn file_path(&self) -> &str {
        if self.new_path.trim().is_empty() { &self.old_path } else { &self.new_path }
    }

    /// This anchor as the `position` GitLab takes.
    fn position(&self) -> serde_json::Value {
        let path = self.file_path();
        let mut position = json!({
            // The only kind of position this app writes. GitLab also places notes on an
            // image, which is a different surface with a different gesture.
            "position_type": "text",
            "base_sha": self.refs.base_sha,
            "head_sha": self.refs.head_sha,
            "start_sha": self.refs.start_sha,
        });
        // Each path is stated only when the file really has one, so an added file is not
        // described as having moved from the empty string.
        if !self.new_path.trim().is_empty() {
            position["new_path"] = json!(self.new_path);
        }
        if !self.old_path.trim().is_empty() {
            position["old_path"] = json!(self.old_path);
        }
        if let Some(old) = self.line.position_old_line() {
            position["old_line"] = json!(old);
        }
        if let Some(new) = self.line.position_new_line() {
            position["new_line"] = json!(new);
        }
        if let Some(start) = self.start {
            position["line_range"] = json!({
                "start": start.range_end(path),
                "end": self.line.range_end(path),
            });
        }
        position
    }

    /// Whether this anchor is one GitLab could place, checked before the network.
    fn check(&self) -> Result<()> {
        for (name, sha) in [
            ("base_sha", &self.refs.base_sha),
            ("head_sha", &self.refs.head_sha),
            ("start_sha", &self.refs.start_sha),
        ] {
            anyhow::ensure!(
                !sha.trim().is_empty(),
                "a comment on a diff line needs the commits that diff is of, and `{name}` is \
                 missing — reload the page and look again"
            );
        }
        anyhow::ensure!(
            !self.file_path().trim().is_empty(),
            "a comment on a diff line needs the file it is about"
        );
        for line in [Some(self.line), self.start].into_iter().flatten() {
            anyhow::ensure!(
                line.old > 0 && line.new > 0,
                "a diff line is addressed by its place in both files, and one of those is missing"
            );
        }
        Ok(())
    }
}

/// Comment on one merge request — a new standalone comment, a reply into an existing
/// discussion when `discussion_id` names one, or a new thread on a DIFF LINE when `anchor`
/// names one.
///
/// Everybody watching the merge request is told, under the user's own name, so this is
/// gated exactly like a send and is only ever called from their own Enter.
///
/// The three shapes are one write and are deliberately one function: they reach the same
/// people, they are undone by the same deletion, and they differ only in where GitLab files
/// the words. Splitting them would be three consent gates for one act.
pub async fn comment(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    discussion_id: Option<&str>,
    anchor: Option<&DiffAnchor>,
    body: &str,
) -> Result<PostedNote> {
    let token = gitlab_mr::require_token(token)?;
    let body = body.trim();
    anyhow::ensure!(!body.is_empty(), "an empty comment says nothing, so it is not posted");
    anyhow::ensure!(
        body.len() <= MAX_COMMENT_BYTES,
        "that comment is too long for one GitLab note ({} bytes, the cap is {MAX_COMMENT_BYTES})",
        body.len()
    );

    let discussion = discussion_id.map(str::trim).filter(|id| !id.is_empty());
    // Two addresses for one comment is not a comment with two addresses: a reply lands in a
    // thread that already hangs where it hangs, so a position beside it would be a second,
    // contradicting claim about where the words go. Refused here rather than resolved by
    // picking one.
    anyhow::ensure!(
        !(discussion.is_some() && anchor.is_some()),
        "a reply lands in the thread it answers, so it cannot also name a diff line"
    );
    if let Some(anchor) = anchor {
        anchor.check()?;
    }

    let base = gitlab_mr::merge_request_api(gitlab_host, project_path, iid);
    // A reply goes into the thread it answers; a comment on a diff line starts a THREAD, so
    // it is posted as a discussion; without either it is a standalone comment of its own.
    // Sending a reply as a new comment is the mistake this branch exists to prevent: the
    // words land, in the wrong place, and nothing reports it.
    let endpoint = match (discussion, anchor) {
        (Some(discussion), _) => {
            format!("{base}/discussions/{}/notes", urlencoding::encode(discussion))
        }
        (None, Some(_)) => format!("{base}/discussions"),
        (None, None) => format!("{base}/notes"),
    };
    let mut request = json!({ "body": body });
    if let Some(anchor) = anchor {
        request["position"] = anchor.position();
    }

    let resp = http
        .post(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .json(&request)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab comment")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!(
            "{}",
            comment_refusal(status, anchor.is_some(), &read_gitlab_message(resp).await)
        );
    }
    let answered: serde_json::Value = resp.json().await.context("gitlab comment body")?;
    Ok(posted_note(&answered, discussion, body))
}

/// The note GitLab stored, out of whichever of the two bodies it answered with.
///
/// A note endpoint answers with the NOTE; the discussions endpoint answers with the whole
/// DISCUSSION, whose `id` is the thread's and whose single note is the comment. Reading the
/// first shape's rule into the second is a real mistake with a quiet symptom: the thread's id
/// would be stored as the note's, so the deletion offered on that comment would name
/// something that is not a note.
fn posted_note(answered: &serde_json::Value, discussion: Option<&str>, typed: &str) -> PostedNote {
    let thread = answered.get("notes").and_then(serde_json::Value::as_array);
    let (note, thread_id) = match thread.and_then(|notes| notes.first()) {
        Some(first) => (first, string_field(answered, "id")),
        None => (answered, None),
    };
    PostedNote {
        id: note.get("id").and_then(serde_json::Value::as_u64).unwrap_or_default(),
        author: person_from(note.get("author")),
        body: string_field(note, "body").unwrap_or_else(|| typed.to_string()),
        created_at: string_field(note, "created_at").unwrap_or_default(),
        discussion_id: string_field(note, "discussion_id")
            .or(thread_id)
            .or_else(|| discussion.map(str::to_string)),
    }
}

/// Edit one of the user's OWN comments — rewrite the words they already posted.
///
/// The BACKEND refuses a note that is not the user's own before the network, exactly as
/// [`delete_comment`] does and for its reason: GitLab itself refuses a colleague's note here,
/// but this app must not depend on that refusal to keep a promise of its own.
///
/// **It is not fully reversible, and that is stated rather than smoothed over.** An edit can be
/// edited back, but the words that were there are gone — GitLab keeps no history this API can
/// read. So it sits where a Teams message edit sits (§ Sending messages: an edit rewrites, a
/// reaction toggles off, a deletion is final): one press, like the chat's own edit, and never a
/// second confirmation, because asking twice for a rewrite and once for a message that reaches
/// the same people would teach the reader that the dialog means nothing.
pub async fn edit_comment(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    note_id: u64,
    body: &str,
) -> Result<PostedNote> {
    let token = gitlab_mr::require_token(token)?;
    let body = body.trim();
    // An empty edit is a DELETION with none of a deletion's rails — no second press, and the
    // words gone for good. GitLab refuses it too; refusing here says which act was meant.
    anyhow::ensure!(
        !body.is_empty(),
        "an edit cannot empty a comment — delete it instead, which asks first"
    );
    anyhow::ensure!(
        body.len() <= MAX_COMMENT_BYTES,
        "that comment is too long for one GitLab note ({} bytes, the cap is {MAX_COMMENT_BYTES})",
        body.len()
    );

    let endpoint = format!(
        "{}/notes/{note_id}",
        gitlab_mr::merge_request_api(gitlab_host, project_path, iid)
    );
    let resp = http
        .put(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .json(&json!({ "body": body }))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab comment edit")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", comment_refusal(status, false, &read_gitlab_message(resp).await));
    }
    let answered: serde_json::Value = resp.json().await.context("gitlab comment edit body")?;
    Ok(posted_note(&answered, None, body))
}

/// Resolve one thread, or open it again.
///
/// Each direction is the other's undo, which is what makes this an ordinary gated write —
/// the shape [`StateChange`] and the approval both have. So it is one press and no
/// confirmation: nothing here needs a rail in place of an undo it does have.
///
/// Only a THREAD can be resolved. A standalone comment carries no such state, and GitLab
/// refuses one with its own words rather than inventing a state for it.
pub async fn set_thread_resolved(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    discussion_id: &str,
    resolved: bool,
) -> Result<bool> {
    let token = gitlab_mr::require_token(token)?;
    let discussion = discussion_id.trim();
    anyhow::ensure!(!discussion.is_empty(), "a thread is resolved by its own id, and none was given");
    let endpoint = format!(
        "{}/discussions/{}",
        gitlab_mr::merge_request_api(gitlab_host, project_path, iid),
        urlencoding::encode(discussion)
    );
    let resp = http
        .put(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .json(&json!({ "resolved": resolved }))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab thread resolution")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", resolve_refusal(status, resolved, &read_gitlab_message(resp).await));
    }
    // GitLab answers with the whole discussion. What it says about its own notes is the truth
    // about the outcome, so it is read back rather than echoed from the request: a thread whose
    // notes are not resolvable can answer 200 and change nothing.
    let answered: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok(thread_is_resolved(&answered).unwrap_or(resolved))
}

/// Whether the thread GitLab answered with is resolved: true when every note that CAN be
/// resolved is. `None` when the body says nothing about any note, which is what makes the
/// caller fall back to what it asked for rather than reporting a state nobody stated.
fn thread_is_resolved(discussion: &serde_json::Value) -> Option<bool> {
    let notes = discussion.get("notes").and_then(serde_json::Value::as_array)?;
    let mut resolvable = notes
        .iter()
        .filter(|note| note.get("resolvable").and_then(serde_json::Value::as_bool) == Some(true))
        .peekable();
    resolvable.peek()?;
    Some(resolvable.all(|note| note.get("resolved").and_then(serde_json::Value::as_bool) == Some(true)))
}

/// Delete one comment — the undo of [`comment`], and the reason a comment is offered here
/// at all.
///
/// The BACKEND refuses a note that is not the user's own before the network
/// (`gitlab_mr_delete_comment` in src/bin/server.rs reads the note's `mine` flag from the
/// discussion list). GitLab itself would let a maintainer remove a colleague's comment;
/// this app never offers that, exactly as it refuses to delete a Teams message that is not
/// the user's own.
pub async fn delete_comment(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    note_id: u64,
) -> Result<()> {
    let token = gitlab_mr::require_token(token)?;
    let endpoint = format!(
        "{}/notes/{note_id}",
        gitlab_mr::merge_request_api(gitlab_host, project_path, iid)
    );
    let resp = http
        .delete(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab comment deletion")?;
    let status = resp.status();
    // GitLab answers 204 with no body. A 404 here means the note is already gone, which is
    // the state the caller asked for — reporting a failure would send them looking for a
    // comment that no longer exists.
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    // A deletion names a note by its id and never a diff position, so it has no placement to
    // fail — `false` is the fact rather than a default.
    anyhow::bail!("{}", comment_refusal(status, false, &read_gitlab_message(resp).await));
}

// ---- refusals ---------------------------------------------------------------

/// GitLab's own explanation, read off a failed response. Consuming the body is why this
/// takes the response whole; the parse itself is [`gitlab_message`], which is what the
/// tests hold to the two shapes GitLab uses.
async fn read_gitlab_message(resp: reqwest::Response) -> String {
    match resp.json::<serde_json::Value>().await {
        Ok(body) => gitlab_message(&body),
        Err(_) => String::new(),
    }
}

/// GitLab's own explanation, when it sends one. Its error bodies carry `message` or
/// `error`, sometimes as a list; anything else is dropped rather than shown raw, because a
/// JSON blob in a one-line report is noise.
fn gitlab_message(body: &serde_json::Value) -> String {
    for key in ["message", "error"] {
        match body.get(key) {
            Some(serde_json::Value::String(text)) if !text.is_empty() => return text.clone(),
            Some(serde_json::Value::Array(items)) => {
                let joined = items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
                    .join("; ");
                if !joined.is_empty() {
                    return joined;
                }
            }
            _ => {}
        }
    }
    String::new()
}

/// One sentence for a failed merge, naming the cause its status code stands for. A merge
/// is the one action here whose failure the user must be able to act on without opening
/// GitLab, so each code says what moved.
fn merge_refusal(status: reqwest::StatusCode, detail: &str) -> String {
    let cause = match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            "this account may not merge that merge request (or the token lacks the `api` scope)"
        }
        reqwest::StatusCode::NOT_FOUND => "that merge request is not visible to this token",
        reqwest::StatusCode::METHOD_NOT_ALLOWED => {
            "GitLab will not merge it yet — a pipeline, an approval, a conflict or an \
             unresolved thread is in the way"
        }
        reqwest::StatusCode::CONFLICT => {
            "the branch moved since this page read it, so nothing was merged — reload and \
             look again"
        }
        reqwest::StatusCode::UNPROCESSABLE_ENTITY => {
            "GitLab could not merge it — the branch cannot be merged as it stands"
        }
        _ => "GitLab refused the merge",
    };
    with_detail(&format!("GitLab refused: {cause}"), status, detail)
}

fn state_refusal(status: reqwest::StatusCode, change: StateChange, detail: &str) -> String {
    let action = match change {
        StateChange::Close => "close",
        StateChange::Reopen => "reopen",
    };
    let cause = match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            format!("this account may not {action} that merge request")
        }
        reqwest::StatusCode::NOT_FOUND => {
            "that merge request is not visible to this token".to_string()
        }
        _ => format!("the {action} did not go through"),
    };
    with_detail(&format!("GitLab refused: {cause}"), status, detail)
}

/// One sentence for a refused comment. `anchored` is whether it named a diff line, because
/// that is the one shape with a failure of its own to explain: GitLab resolves a position
/// against the diff it was written on, so a merge request that was pushed to since the page
/// read it is refused — and the reader's next move is to look at the new diff, which no
/// generic "it was not posted" would send them to.
fn comment_refusal(status: reqwest::StatusCode, anchored: bool, detail: &str) -> String {
    let cause = match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            "this account may not comment there (or the token lacks the `api` scope)"
        }
        reqwest::StatusCode::NOT_FOUND => {
            "that merge request — or that thread — is not visible to this token"
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            "GitLab is rate-limiting this token, so the comment was not posted"
        }
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNPROCESSABLE_ENTITY
            if anchored =>
        {
            "GitLab could not place that comment on the diff — somebody may have pushed since \
             this page read it, so reload the changes and look at the line again"
        }
        _ => "the comment was not posted",
    };
    with_detail(&format!("GitLab refused: {cause}"), status, detail)
}

/// One sentence for a refused resolution. The 400 is the one worth naming: GitLab answers it
/// for a comment that is not a THREAD, which is a state rather than a fault, and "it did not go
/// through" would send the reader looking for a problem that is not there.
fn resolve_refusal(status: reqwest::StatusCode, resolved: bool, detail: &str) -> String {
    let action = if resolved { "resolve" } else { "reopen" };
    let cause = match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            format!("this account may not {action} that thread")
        }
        reqwest::StatusCode::NOT_FOUND => {
            "that thread is not on this merge request any more".to_string()
        }
        reqwest::StatusCode::BAD_REQUEST => {
            "GitLab does not offer that: only a thread can be resolved, and this is a comment \
             of its own"
                .to_string()
        }
        _ => format!("the {action} did not go through"),
    };
    with_detail(&format!("GitLab refused: {cause}"), status, detail)
}

/// Append GitLab's own words when it sent any, and the status code when it did not. The
/// code is a last resort rather than the first thing the user reads.
fn with_detail(sentence: &str, status: reqwest::StatusCode, detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        return format!("{sentence} ({})", status.as_u16());
    }
    format!("{sentence} — GitLab said: {detail}")
}

fn string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// One person from a GitLab user object, in the read path's own shape so a posted comment
/// renders exactly like a read one.
fn person_from(value: Option<&serde_json::Value>) -> Person {
    let value = value.cloned().unwrap_or(serde_json::Value::Null);
    let username = string_field(&value, "username").unwrap_or_default();
    Person {
        name: string_field(&value, "name").unwrap_or_else(|| username.clone()),
        username,
        avatar_url: string_field(&value, "avatar_url"),
    }
}

/// The API base of one project, for the endpoints that hang off a project rather than a
/// merge request. Present so every request in this module is built from
/// [`gitlab::api_base`] — the host pin — and never from a URL a client supplied.
#[allow(dead_code)]
fn project_api(gitlab_host: &str, project_path: &str) -> String {
    format!(
        "{}/projects/{}",
        gitlab::api_base(gitlab_host),
        gitlab::encode_path(project_path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Strip `//` line comments so a source-scanning guardrail inspects CODE, not the
    /// prose that explains it. Mirrors `gitlab.rs` and `gitlab_approval.rs`.
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

    fn code() -> String {
        let source = include_str!("gitlab_mr_write.rs");
        strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source))
    }

    /// THE shape of this module: six writes, named once each, and no seventh.
    ///
    /// The neighbours GitLab offers on the same resource are what this test keeps out —
    /// each would be a write the module's own name does not cover, riding a consent gate
    /// somebody else asked for: a rebase rewrites the branch, `/subscribe` speaks for the
    /// user, a label or an assignee edit changes what other people are told to do, and
    /// `/projects` is a whole tracker rather than one merge request.
    #[test]
    fn the_module_writes_six_things_and_names_no_others() {
        let code = code();
        assert!(code.contains("pub async fn merge"), "scanned the wrong text");
        // The six, and the undo that makes the comment acceptable.
        assert!(code.contains("/merge\""), "the merge endpoint");
        assert!(code.contains("/notes\""), "the comment endpoint");
        // A comment on a diff line starts a thread, so it is posted as a discussion. It is
        // the same write as the two above — same people, same undo — and the endpoint is
        // named here so its arrival stays a deliberate act rather than a quiet third one.
        assert!(code.contains("/discussions\""), "the diff comment's endpoint");
        assert!(code.contains("/notes/{note_id}"), "the comment's undo, and its edit");
        assert!(code.contains("/discussions/{}"), "the thread's own resolution");
        assert!(code.contains("state_event"), "the close and its reopen");
        // And each write verb appears exactly as often as it has a reason to.
        assert_eq!(code.matches(".post(").count(), 1, "one comment POST");
        assert_eq!(code.matches(".delete(").count(), 1, "one note DELETE");
        assert_eq!(
            code.matches(".put(").count(),
            4,
            "the merge, the state change, the comment edit and the thread resolution"
        );
        assert_eq!(code.matches(".patch(").count(), 0);
        for endpoint in ["/rebase", "/subscribe", "/unsubscribe", "/todo", "/approve", "/award_emoji"] {
            assert!(
                !code.contains(endpoint),
                "src/gitlab_mr_write.rs names `{endpoint}`, which is not one of its four writes. \
                 A further tracker write is a deliberate feature with its own consent gate."
            );
        }
    }

    /// A close and a reopen are each other's undo, and they are a closed set: nothing else
    /// can ever travel as a `state_event`. `merge` is deliberately not among them — it is
    /// not a state change, and folding it in would hide the one irreversible write behind
    /// the reversible pair's reasoning.
    #[test]
    fn a_state_change_is_one_of_two_and_they_undo_each_other() {
        assert_eq!(StateChange::from_str("close").map(StateChange::event), Some("close"));
        assert_eq!(StateChange::from_str("reopen").map(StateChange::event), Some("reopen"));
        assert_eq!(StateChange::from_str("merge"), None);
        assert_eq!(StateChange::from_str("close; drop"), None);
        assert_eq!(StateChange::from_str(""), None);
    }

    /// And the write lives HERE, nowhere else. A `/merge` or a `state_event` that appeared
    /// beside the read path would be a write with no gate in front of it — the same rule
    /// `gitlab_approval` holds for its own endpoints.
    #[test]
    fn the_rest_of_the_crate_names_no_merge_endpoint() {
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
            if file.ends_with("gitlab_mr_write.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(&source));
            for endpoint in ["/merge\"", "state_event"] {
                assert!(
                    !code.contains(endpoint),
                    "{} names `{endpoint}`. The merge and the close live in \
                     src/gitlab_mr_write.rs, behind their own consent gates.",
                    file.display()
                );
            }
        }
    }

    #[tokio::test]
    async fn no_write_reaches_the_network_without_a_token() {
        let http = reqwest::Client::new();
        let request = MergeRequest {
            project_path: "a/b".to_string(),
            iid: 1,
            sha: "deadbeef".to_string(),
            squash: false,
            remove_source_branch: None,
        };
        for err in [
            merge(&http, "gitlab.com", None, &request).await.expect_err("no token"),
            set_state(&http, "gitlab.com", None, "a/b", 1, StateChange::Close)
                .await
                .expect_err("no token"),
            comment(&http, "gitlab.com", Some(""), "a/b", 1, None, None, "hi")
                .await
                .expect_err("blank token"),
            delete_comment(&http, "gitlab.com", None, "a/b", 1, 5).await.expect_err("no token"),
            edit_comment(&http, "gitlab.com", None, "a/b", 1, 5, "hi").await.expect_err("no token"),
            set_thread_resolved(&http, "gitlab.com", None, "a/b", 1, "d-1", true)
                .await
                .expect_err("no token"),
        ] {
            assert!(err.to_string().contains("needs a personal access token"), "{err}");
        }
    }

    /// A merge with no head commit is refused HERE. Without the `sha` GitLab merges
    /// whatever the branch holds now, which is exactly the commit the reader never saw.
    #[tokio::test]
    async fn a_merge_with_no_head_commit_is_refused_before_the_network() {
        let http = reqwest::Client::new();
        let err = merge(
            &http,
            "gitlab.com",
            Some("tok"),
            &MergeRequest {
                project_path: "a/b".to_string(),
                iid: 1,
                sha: "  ".to_string(),
                squash: false,
                remove_source_branch: None,
            },
        )
        .await
        .expect_err("a merge with no sha must be refused");
        assert!(err.to_string().contains("the commit the page read"), "{err}");
    }

    #[tokio::test]
    async fn an_empty_or_oversized_comment_never_reaches_the_network() {
        let http = reqwest::Client::new();
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, None, "   \n ")
            .await
            .expect_err("an empty comment says nothing");
        assert!(err.to_string().contains("empty comment"), "{err}");

        let huge = "x".repeat(MAX_COMMENT_BYTES + 1);
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, None, &huge)
            .await
            .expect_err("a runaway paste is refused here");
        assert!(err.to_string().contains("too long"), "{err}");
    }

    /// An EDIT may rewrite a comment; it may not empty one. That is a deletion with none of a
    /// deletion's rails — no second press, and the words gone for good — so it is refused here
    /// and named as the act it really is.
    #[tokio::test]
    async fn an_edit_cannot_empty_a_comment() {
        let http = reqwest::Client::new();
        let err = edit_comment(&http, "gitlab.com", Some("tok"), "a/b", 1, 5, "  \n ")
            .await
            .expect_err("an empty edit is a deletion in disguise");
        assert!(err.to_string().contains("delete it instead"), "{err}");

        let huge = "x".repeat(MAX_COMMENT_BYTES + 1);
        let err = edit_comment(&http, "gitlab.com", Some("tok"), "a/b", 1, 5, &huge)
            .await
            .expect_err("a runaway paste is refused here too");
        assert!(err.to_string().contains("too long"), "{err}");
    }

    /// A thread is resolved by its own id, and a blank one names nothing — GitLab would answer
    /// about the whole merge request's discussions instead, which is not what was asked.
    #[tokio::test]
    async fn a_resolution_needs_the_thread_it_is_about() {
        let http = reqwest::Client::new();
        let err = set_thread_resolved(&http, "gitlab.com", Some("tok"), "a/b", 1, "  ", true)
            .await
            .expect_err("a thread with no id is not a thread");
        assert!(err.to_string().contains("its own id"), "{err}");
    }

    /// What a resolution ANSWERED is read out of GitLab's own body rather than echoed from the
    /// request: a thread whose notes cannot be resolved can answer 200 and change nothing.
    #[test]
    fn a_thread_is_resolved_when_every_resolvable_note_is() {
        let resolved = json!({ "notes": [
            { "resolvable": true, "resolved": true },
            { "resolvable": false, "resolved": false },
        ] });
        assert_eq!(thread_is_resolved(&resolved), Some(true));

        let half = json!({ "notes": [
            { "resolvable": true, "resolved": true },
            { "resolvable": true, "resolved": false },
        ] });
        assert_eq!(thread_is_resolved(&half), Some(false));

        // A thread with nothing resolvable in it says NOTHING about resolution, so the caller
        // keeps what it asked for instead of reporting a state GitLab never stated.
        assert_eq!(thread_is_resolved(&json!({ "notes": [{ "resolvable": false }] })), None);
        assert_eq!(thread_is_resolved(&json!({ "notes": [] })), None);
        assert_eq!(thread_is_resolved(&serde_json::Value::Null), None);
    }

    #[test]
    fn a_refused_resolution_names_the_state_rather_than_a_fault() {
        // GitLab answers 400 for a comment that is not a thread. That is a state, and "it did
        // not go through" would send the reader hunting a problem that is not there.
        let plain = resolve_refusal(reqwest::StatusCode::BAD_REQUEST, true, "");
        assert!(plain.contains("only a thread can be resolved"), "{plain}");
        assert!(resolve_refusal(reqwest::StatusCode::FORBIDDEN, false, "").contains("may not reopen"));
        assert!(resolve_refusal(reqwest::StatusCode::NOT_FOUND, true, "").contains("not on this merge request"));
    }

    // ---- a comment on a diff line -------------------------------------------

    fn refs() -> DiffRefs {
        DiffRefs {
            base_sha: "base".to_string(),
            head_sha: "head".to_string(),
            start_sha: "start".to_string(),
        }
    }

    fn anchor(line: AnchorLine, start: Option<AnchorLine>) -> DiffAnchor {
        DiffAnchor {
            refs: refs(),
            new_path: "src/server/health.ts".to_string(),
            old_path: "src/server/health.ts".to_string(),
            line,
            start,
        }
    }

    /// A position states the side the line is ON, and never the other one. GitLab refuses an
    /// `old_line` on a line that was added — it is not in the old file, so the number would
    /// describe a different line — and both counters still travel inside the line code.
    #[test]
    fn a_position_states_only_the_side_a_line_is_on() {
        let added = anchor(AnchorLine { old: 8, new: 9, side: LineSide::New }, None).position();
        assert_eq!(added["new_line"], json!(9));
        assert!(added.get("old_line").is_none(), "an added line has no old line: {added}");

        let removed = anchor(AnchorLine { old: 8, new: 9, side: LineSide::Old }, None).position();
        assert_eq!(removed["old_line"], json!(8));
        assert!(removed.get("new_line").is_none(), "a removed line has no new line: {removed}");

        let context = anchor(AnchorLine { old: 8, new: 9, side: LineSide::Both }, None).position();
        assert_eq!((&context["old_line"], &context["new_line"]), (&json!(8), &json!(9)));

        // The three commits and the kind travel on every one of them.
        for position in [&added, &removed, &context] {
            assert_eq!(position["position_type"], json!("text"));
            assert_eq!(position["base_sha"], json!("base"));
            assert_eq!(position["head_sha"], json!("head"));
            assert_eq!(position["start_sha"], json!("start"));
        }
    }

    /// A comment about SEVERAL lines names both ends; one about a single line names none.
    /// GitLab's own answers carry no `line_range` for a single line, so writing a range of
    /// one would describe a comment as something it is not.
    #[test]
    fn a_range_names_both_ends_and_a_single_line_names_none() {
        let single = anchor(AnchorLine { old: 8, new: 9, side: LineSide::New }, None).position();
        assert!(single.get("line_range").is_none(), "one line is not a range: {single}");

        let ranged = anchor(
            AnchorLine { old: 8, new: 11, side: LineSide::New },
            Some(AnchorLine { old: 8, new: 9, side: LineSide::Both }),
        )
        .position();
        let range = &ranged["line_range"];
        // The ANCHOR is the last line — where GitLab draws the thread — and the range's own
        // start is the first, so the two together say which way the reader dragged.
        assert_eq!(ranged["new_line"], json!(11));
        assert_eq!(
            range["start"]["line_code"],
            json!("306bf1fe4ea9f8a8810c1131e313b0e1e163da6a_8_9")
        );
        assert_eq!(
            range["end"]["line_code"],
            json!("306bf1fe4ea9f8a8810c1131e313b0e1e163da6a_8_11")
        );
        assert_eq!(range["end"]["type"], json!("new"));
        // A context end names no side: it belongs to both files, and GitLab names none there.
        assert!(range["start"].get("type").is_none(), "a context end has no side: {range}");
    }

    /// The path a line code is hashed from is the file's own — its new one, or the only one
    /// a deleted file ever had.
    #[test]
    fn a_deleted_file_is_addressed_by_the_path_it_had() {
        let deleted = DiffAnchor {
            refs: refs(),
            new_path: String::new(),
            old_path: "src/old.ts".to_string(),
            line: AnchorLine { old: 4, new: 4, side: LineSide::Old },
            start: None,
        };
        assert_eq!(deleted.file_path(), "src/old.ts");
        let position = deleted.position();
        assert_eq!(position["old_path"], json!("src/old.ts"));
        assert!(position.get("new_path").is_none(), "a deleted file has no new path");
    }

    /// Two addresses for one comment is refused rather than resolved. A reply lands in a
    /// thread that already hangs where it hangs, so a diff line beside it would be a second,
    /// contradicting claim about where the words go.
    #[tokio::test]
    async fn a_comment_cannot_name_both_a_thread_and_a_diff_line() {
        let http = reqwest::Client::new();
        let anchor = anchor(AnchorLine { old: 8, new: 9, side: LineSide::New }, None);
        let err = comment(
            &http,
            "gitlab.com",
            Some("tok"),
            "a/b",
            1,
            Some("d-1"),
            Some(&anchor),
            "hi",
        )
        .await
        .expect_err("a reply cannot also name a line");
        assert!(err.to_string().contains("cannot also name a diff line"), "{err}");
    }

    /// An anchor GitLab could not place is refused HERE. Without the three commits the
    /// position names no diff at all, and a line with no place in one of the two files is
    /// not a line GitLab can find.
    #[tokio::test]
    async fn an_unplaceable_anchor_never_reaches_the_network() {
        let http = reqwest::Client::new();
        let mut blank = anchor(AnchorLine { old: 8, new: 9, side: LineSide::New }, None);
        blank.refs.head_sha = "  ".to_string();
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, Some(&blank), "hi")
            .await
            .expect_err("a position with no head commit is not a position");
        assert!(err.to_string().contains("`head_sha` is missing"), "{err}");

        let zero = anchor(AnchorLine { old: 0, new: 9, side: LineSide::New }, None);
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, Some(&zero), "hi")
            .await
            .expect_err("a line with no place in the old file is not addressable");
        assert!(err.to_string().contains("place in both files"), "{err}");

        let nameless = DiffAnchor {
            refs: refs(),
            new_path: String::new(),
            old_path: "   ".to_string(),
            line: AnchorLine { old: 1, new: 1, side: LineSide::Both },
            start: None,
        };
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, Some(&nameless), "hi")
            .await
            .expect_err("a comment on a line needs the file");
        assert!(err.to_string().contains("needs the file"), "{err}");
    }

    /// A side is one of three words and nothing else can travel as one.
    #[test]
    fn a_line_side_is_one_of_three() {
        assert_eq!(LineSide::from_str("old"), Some(LineSide::Old));
        assert_eq!(LineSide::from_str("new"), Some(LineSide::New));
        assert_eq!(LineSide::from_str("both"), Some(LineSide::Both));
        assert_eq!(LineSide::from_str("additions"), None);
        assert_eq!(LineSide::from_str(""), None);
        // Only a real side is a side GitLab names on a range end.
        assert_eq!(LineSide::Both.range_type(), None);
    }

    /// The discussions endpoint answers with the THREAD; the notes endpoints answer with the
    /// note. The comment is read out of either, and the thread's id never becomes the note's
    /// — a deletion offered against it would name something that is not a note.
    #[test]
    fn a_posted_comment_is_read_from_a_discussion_body_too() {
        let thread = json!({
            "id": "8c9a1f0e",
            "individual_note": false,
            "notes": [{
                "id": 70_001,
                "author": { "username": "ada", "name": "Ada Lovelace" },
                "body": "This drops the drain timeout.",
                "created_at": "2026-08-06T09:00:00.000Z",
            }],
        });
        let note = posted_note(&thread, None, "This drops the drain timeout.");
        assert_eq!(note.id, 70_001);
        assert_eq!(note.discussion_id.as_deref(), Some("8c9a1f0e"));
        assert_eq!(note.author.username, "ada");

        // And the plain note body is unchanged by that branch.
        let plain = json!({ "id": 5, "body": "hi", "discussion_id": "d-9" });
        assert_eq!(posted_note(&plain, None, "hi").id, 5);
        assert_eq!(posted_note(&plain, None, "hi").discussion_id.as_deref(), Some("d-9"));
    }

    #[test]
    fn a_merge_refusal_names_the_cause_and_gitlab_s_own_words() {
        let blocked = merge_refusal(reqwest::StatusCode::METHOD_NOT_ALLOWED, "");
        assert!(blocked.contains("will not merge it yet"), "{blocked}");
        assert!(blocked.contains("405"), "the code is the last resort: {blocked}");

        let moved = merge_refusal(reqwest::StatusCode::CONFLICT, "SHA does not match HEAD of source branch");
        assert!(moved.contains("the branch moved"), "{moved}");
        assert!(moved.contains("GitLab said: SHA does not match"), "{moved}");

        assert!(state_refusal(reqwest::StatusCode::FORBIDDEN, StateChange::Reopen, "")
            .contains("may not reopen"));
        assert!(comment_refusal(reqwest::StatusCode::TOO_MANY_REQUESTS, false, "")
            .contains("rate-limiting"));

        // A refused POSITION says what a reader can do about it, and only when the comment
        // really named a line: the same 400 on an ordinary comment is not about a diff that
        // moved, and sending them to reload the changes would be a wrong instruction.
        let moved = comment_refusal(reqwest::StatusCode::BAD_REQUEST, true, "");
        assert!(moved.contains("reload the changes"), "{moved}");
        assert!(
            !comment_refusal(reqwest::StatusCode::BAD_REQUEST, false, "")
                .contains("reload the changes"),
            "an ordinary comment's refusal must not name the diff"
        );
    }

    #[test]
    fn gitlab_s_own_message_is_read_from_either_shape() {
        // A string `message`, a list of them, and a body with neither: the third must
        // leave the sentence to name the status code rather than print JSON at the user.
        assert_eq!(
            gitlab_message(&json!({ "message": "Branch cannot be merged" })),
            "Branch cannot be merged"
        );
        assert_eq!(gitlab_message(&json!({ "error": ["a", "b"] })), "a; b");
        assert_eq!(gitlab_message(&json!({ "message": "" })), "");
        assert_eq!(gitlab_message(&json!({ "unrelated": 1 })), "");
        assert_eq!(gitlab_message(&serde_json::Value::Null), "");
    }

    #[test]
    fn a_posted_comment_carries_the_shape_a_read_one_has() {
        // The author of a note GitLab just stored is read exactly as the read path reads
        // one, so a comment does not change appearance the moment the page reloads.
        let author = person_from(Some(&json!({ "username": "ada", "name": "Ada Lovelace" })));
        assert_eq!((author.name.as_str(), author.username.as_str()), ("Ada Lovelace", "ada"));
        assert_eq!(person_from(Some(&json!({ "username": "grace" }))).name, "grace");
    }

    #[test]
    fn every_endpoint_is_built_from_the_pinned_host() {
        assert_eq!(
            project_api("gitlab.example.com", "group/sub/app"),
            "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp"
        );
    }
}

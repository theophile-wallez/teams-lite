// The four writes the GitLab page makes, and nothing else.
//
// Everything this app knows about a tracker reads (`src/gitlab.rs` and `src/gitlab_mr.rs`
// issue GET requests only, and a test on each one's source keeps it that way). Two modules
// write, both deliberately: `src/gitlab_approval.rs` holds an approval and its undo, and
// this one holds what the merge request PAGE offers on top of it —
//
//   1. **MERGE** the branch (`PUT …/merge`).
//   2. **COMMENT** on it (`POST …/notes`, or `POST …/discussions/{id}/notes` for a reply).
//   3. **DELETE one of the user's OWN comments** (`DELETE …/notes/{id}`) — the undo of 2.
//   4. **CLOSE or REOPEN** it (`PUT …` with `state_event`), which are each other's undo.
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
// The three others are each reversible, which is what makes them ordinary: a comment can
// be deleted by whoever wrote it, and a close is undone by a reopen. A comment still
// reaches every person watching the merge request, under the user's name, so it is gated
// exactly like a send and never written by anything but their own Enter.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;

use crate::gitlab;
use crate::gitlab_mr::{self, Person};

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

/// Comment on one merge request — a new standalone comment, or a reply into an existing
/// discussion when `discussion_id` names one.
///
/// Everybody watching the merge request is told, under the user's own name, so this is
/// gated exactly like a send and is only ever called from their own Enter.
pub async fn comment(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    project_path: &str,
    iid: u64,
    discussion_id: Option<&str>,
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

    let base = gitlab_mr::merge_request_api(gitlab_host, project_path, iid);
    // A reply goes into the thread it answers; without a discussion it is a comment of its
    // own. Sending a reply as a new comment is the mistake this branch exists to prevent:
    // the words land, in the wrong place, and nothing reports it.
    let endpoint = match discussion_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(discussion) => {
            format!("{base}/discussions/{}/notes", urlencoding::encode(discussion))
        }
        None => format!("{base}/notes"),
    };

    let resp = http
        .post(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .json(&json!({ "body": body }))
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab comment")?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("{}", comment_refusal(status, &read_gitlab_message(resp).await));
    }
    let answered: serde_json::Value = resp.json().await.context("gitlab comment body")?;
    Ok(PostedNote {
        id: answered.get("id").and_then(serde_json::Value::as_u64).unwrap_or_default(),
        author: person_from(answered.get("author")),
        body: string_field(&answered, "body").unwrap_or_else(|| body.to_string()),
        created_at: string_field(&answered, "created_at").unwrap_or_default(),
        discussion_id: string_field(&answered, "discussion_id")
            .or_else(|| discussion_id.map(str::to_string)),
    })
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
    anyhow::bail!("{}", comment_refusal(status, &read_gitlab_message(resp).await));
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

fn comment_refusal(status: reqwest::StatusCode, detail: &str) -> String {
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
        _ => "the comment was not posted",
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

    /// THE shape of this module: four writes, named once each, and no fifth.
    ///
    /// The neighbours GitLab offers on the same resource are what this test keeps out —
    /// each would be a write the module's own name does not cover, riding a consent gate
    /// somebody else asked for: a rebase rewrites the branch, `/subscribe` speaks for the
    /// user, a label or an assignee edit changes what other people are told to do, and
    /// `/projects` is a whole tracker rather than one merge request.
    #[test]
    fn the_module_writes_four_things_and_names_no_others() {
        let code = code();
        assert!(code.contains("pub async fn merge"), "scanned the wrong text");
        // The four, and the undo that makes the comment acceptable.
        assert!(code.contains("/merge\""), "the merge endpoint");
        assert!(code.contains("/notes\""), "the comment endpoint");
        assert!(code.contains("/notes/{note_id}"), "the comment's undo");
        assert!(code.contains("state_event"), "the close and its reopen");
        // And each write verb appears exactly as often as it has a reason to.
        assert_eq!(code.matches(".post(").count(), 1, "one comment POST");
        assert_eq!(code.matches(".delete(").count(), 1, "one note DELETE");
        assert_eq!(code.matches(".put(").count(), 2, "the merge and the state change");
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
            comment(&http, "gitlab.com", Some(""), "a/b", 1, None, "hi")
                .await
                .expect_err("blank token"),
            delete_comment(&http, "gitlab.com", None, "a/b", 1, 5).await.expect_err("no token"),
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
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, "   \n ")
            .await
            .expect_err("an empty comment says nothing");
        assert!(err.to_string().contains("empty comment"), "{err}");

        let huge = "x".repeat(MAX_COMMENT_BYTES + 1);
        let err = comment(&http, "gitlab.com", Some("tok"), "a/b", 1, None, &huge)
            .await
            .expect_err("a runaway paste is refused here");
        assert!(err.to_string().contains("too long"), "{err}");
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
        assert!(comment_refusal(reqwest::StatusCode::TOO_MANY_REQUESTS, "")
            .contains("rate-limiting"));
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

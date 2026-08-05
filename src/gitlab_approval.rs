// Merge request approvals: the ONE write this app makes to a tracker.
//
// Everything else about GitLab here reads (src/gitlab.rs issues GET requests only, and
// a test on its own source keeps it that way). This module is the deliberate exception
// AGENTS.md § The trackers describes: an approval the user asks for from the message
// that carries the merge request, with its own consent gate — the `gitlab_set_approval`
// RPC is an `OUTWARD_METHODS` entry, so it needs the write token, a read-only backend
// refuses it, and the automation hook refuses a command line that names the endpoint.
//
// Four things make it defensible, and each is load-bearing:
//
//   - **It is REVERSIBLE, and both halves live here.** GitLab publishes `/approve` and
//     `/unapprove`, so the user can take an approval back from the same menu they gave
//     it in. That is why this write exists at all and a comment or a merge does not: a
//     write whose off switch cannot undo its on switch is the failure
//     `teams_presence::forceavailability` is refused for.
//   - **It names ONE resource kind.** [`gitlab::parse_url`] is what parses the link, so
//     the host pinning of the read path holds unchanged — the token only ever reaches
//     the configured host — and anything that is not a merge request is refused before
//     the network.
//   - **It says who approved, so the UI never guesses.** The approval state names the
//     people on it, and whether the user themselves is among them is answered by
//     comparing GitLab's own ids ([`fetch_user`]), never by matching a display name.
//     "Approve" and "Revoke approval" are opposite actions and offering the wrong one
//     is the one mistake a reader cannot see coming.
//   - **The write needs a token; the read does not.** A public merge request enriches
//     for anybody, but an approval is an act by a GitLab account, so a missing token is
//     refused here rather than sent as an anonymous POST GitLab would reject.

use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::gitlab::{self, Resource};

/// How long to wait on the GitLab API. Longer than the enrichment timeout: this is one
/// action the user is watching the outcome of, not a card that may quietly stay a link.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// The approval state of one merge request, as the UI needs it.
///
/// Every count is optional because GitLab's Community Edition omits the approval-rule
/// fields the Premium tiers carry, and a UI that read a missing count as zero would tell
/// the user an approval was still needed when none was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Approval {
    /// Short human reference of the merge request: "!42". So a report of what changed
    /// names the thing that changed rather than a URL.
    pub reference: String,
    /// GitLab's own verdict on whether the merge request is approved. Its meaning
    /// differs by edition (rules satisfied on Premium, at least one approval on
    /// Community), which is exactly why it is surfaced rather than derived here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals_required: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals_left: Option<u64>,
    /// The people who have approved, by display name, in GitLab's own order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub approved_by: Vec<String>,
    /// Whether the user's OWN account is among them — matched on GitLab's user id, so a
    /// colleague sharing a display name can never be mistaken for them. `false` when
    /// there is no token to identify the account with.
    pub mine: bool,
}

/// Read the approval state of the merge request named by `url`.
///
/// - `Ok(Some(state))` — the merge request was found and its approvals read.
/// - `Ok(None)` — the URL is not a merge request on the configured host, or the resource
///   is private/absent (401/403/404). The UI then offers no approval at all.
/// - `Err(_)` — a transient failure the caller may retry.
pub async fn fetch(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    url: &str,
) -> Result<Option<Approval>> {
    let Some((project_path, iid)) = merge_request(url, gitlab_host) else {
        return Ok(None);
    };
    let endpoint = format!("{}/approvals", merge_request_api(gitlab_host, &project_path, iid));

    let resp = get(http, &endpoint, token).await.context("gitlab approvals request")?;
    let status = resp.status();
    if matches!(
        status,
        reqwest::StatusCode::UNAUTHORIZED
            | reqwest::StatusCode::FORBIDDEN
            | reqwest::StatusCode::NOT_FOUND
    ) {
        return Ok(None);
    }
    if !status.is_success() {
        anyhow::bail!("gitlab approvals -> {status}");
    }
    let body: serde_json::Value = resp.json().await.context("gitlab approvals body")?;

    // Who the token belongs to, so "did I approve?" is answered on ids. Only asked when
    // somebody has approved at all: an empty list answers it already, and this is a
    // second request on a path the user is waiting on.
    let me = match token {
        Some(token) if !approver_ids(&body).is_empty() => fetch_user(http, gitlab_host, token)
            .await
            // A directory hiccup must not cost the read: the state is still worth
            // showing, and `mine` then stays false — which offers "Approve", the action
            // GitLab accepts twice, rather than a revoke of an approval that may not
            // exist.
            .inspect_err(|e| eprintln!("[gitlab] who the token belongs to is unknown: {e:#}"))
            .unwrap_or(None),
        _ => None,
    };
    Ok(Some(build_approval(iid, &body, me)))
}

/// Give or take back the user's own approval of the merge request named by `url`, and
/// return the state GitLab reports afterwards.
///
/// Requires a token: an approval is an act by a GitLab account, so an anonymous POST
/// would only earn a refusal from the far end. A URL that is not a merge request on the
/// configured host is refused before the network, for the same reason the read path
/// refuses it — the token reaches one host and one resource kind.
pub async fn set(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: Option<&str>,
    url: &str,
    approved: bool,
) -> Result<Approval> {
    let token = token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .context("approving a merge request needs a GitLab token (Settings → Integrations)")?;
    let (project_path, iid) = merge_request(url, gitlab_host)
        .context("not a merge request on the configured GitLab host")?;

    let base = merge_request_api(gitlab_host, &project_path, iid);
    // The two endpoints this module exists for, and the only writes this app makes to a
    // tracker. `unapprove` is what makes `approve` acceptable, so they are spelled
    // together and neither may leave without the other.
    let endpoint = if approved { format!("{base}/approve") } else { format!("{base}/unapprove") };

    let resp = http
        .post(&endpoint)
        .header("Accept", "application/json")
        .header("PRIVATE-TOKEN", token)
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .context("gitlab approval request")?;
    let status = resp.status();
    if !status.is_success() {
        // The reason matters here in a way it does not on a read: the user pressed a
        // button and is owed a sentence. GitLab answers 401 to an account that may not
        // approve, and 404 to one that cannot even see the merge request.
        anyhow::bail!("{}", refusal(status));
    }

    // `approve` answers with the merge request plus its approval fields; `unapprove`
    // answers 204 with no body at all, so that half reads the state back. One shape for
    // both, and it is GitLab's own answer either way.
    //
    // `mine` is NOT re-derived from ids on this path: GitLab just accepted this exact
    // write, so whether the user's approval is on is what they asked for — and asking
    // `/user` again would be a second request on a path they are waiting in front of.
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    let mut state = if body.get("approvals_required").is_some() || body.get("approved_by").is_some()
    {
        build_approval(iid, &body, None)
    } else {
        fetch(http, gitlab_host, Some(token), url)
            .await?
            .context("the approval went through, but its new state could not be read back")?
    };
    state.mine = approved;
    Ok(state)
}

/// What a failed approval says to the user. One sentence, naming the cause GitLab's
/// status code stands for — a bare "401" is a number they can do nothing with.
fn refusal(status: reqwest::StatusCode) -> String {
    match status {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            "GitLab refused: this account may not approve that merge request (or the token \
             lacks the `api` scope)"
                .to_string()
        }
        reqwest::StatusCode::NOT_FOUND => {
            "GitLab refused: that merge request is not visible to this token".to_string()
        }
        reqwest::StatusCode::CONFLICT => {
            "GitLab refused: the merge request moved on since this page read it".to_string()
        }
        other => format!("GitLab refused the approval ({other})"),
    }
}

/// The merge request `url` names, on the configured host, or `None` for anything else.
/// The parse — and with it the host pinning — is the read path's own.
fn merge_request(url: &str, gitlab_host: &str) -> Option<(String, u64)> {
    match gitlab::parse_url(url, gitlab_host)? {
        Resource::MergeRequest { project_path, iid } => Some((project_path, iid)),
        Resource::Issue { .. } | Resource::Project { .. } => None,
    }
}

/// The API base of one merge request: `https://host/api/v4/projects/<path>/merge_requests/<iid>`.
fn merge_request_api(gitlab_host: &str, project_path: &str, iid: u64) -> String {
    format!(
        "{}/projects/{}/merge_requests/{iid}",
        gitlab::api_base(gitlab_host),
        gitlab::encode_path(project_path)
    )
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

/// The numeric id of the account a token belongs to (`GET /user`), or `None` when
/// GitLab will not say. Used for one question only: is the user's own approval on this
/// merge request?
async fn fetch_user(
    http: &reqwest::Client,
    gitlab_host: &str,
    token: &str,
) -> Result<Option<u64>> {
    let endpoint = format!("{}/user", gitlab::api_base(gitlab_host));
    let resp = get(http, &endpoint, Some(token)).await.context("gitlab user request")?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: serde_json::Value = resp.json().await.context("gitlab user body")?;
    Ok(body.get("id").and_then(serde_json::Value::as_u64))
}

/// The user ids on an approval body, in GitLab's order.
fn approver_ids(body: &serde_json::Value) -> Vec<u64> {
    body.get("approved_by")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("user").unwrap_or(entry).get("id"))
                .filter_map(serde_json::Value::as_u64)
                .collect()
        })
        .unwrap_or_default()
}

/// The display names on an approval body, in GitLab's order, dropping the empty ones.
fn approver_names(body: &serde_json::Value) -> Vec<String> {
    body.get("approved_by")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let user = entry.get("user").unwrap_or(entry);
                    user.get("name")
                        .or_else(|| user.get("username"))
                        .and_then(serde_json::Value::as_str)
                })
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Build the UI's [`Approval`] from a GitLab approvals body. `me` is the id of the
/// account the token belongs to, when it is known.
fn build_approval(iid: u64, body: &serde_json::Value, me: Option<u64>) -> Approval {
    Approval {
        reference: format!("!{iid}"),
        approved: body.get("approved").and_then(serde_json::Value::as_bool),
        approvals_required: body.get("approvals_required").and_then(serde_json::Value::as_u64),
        approvals_left: body.get("approvals_left").and_then(serde_json::Value::as_u64),
        approved_by: approver_names(body),
        mine: me.is_some_and(|me| approver_ids(body).contains(&me)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Strip `//` line comments so a source-scanning guardrail inspects CODE, not the
    /// prose that explains it. A `//` preceded by `:` is left alone so the `https://`
    /// inside a string literal survives. Mirrors `mail.rs` and `linear.rs`.
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

    /// THE shape of the one tracker write: two endpoints, opposite each other, and no
    /// other verb. An edit that added a comment, an assignment, a label or a merge here
    /// would be a second write hiding behind the consent gate this one asked for.
    #[test]
    fn the_module_writes_nothing_but_an_approval_and_its_undo() {
        let source = include_str!("gitlab_approval.rs");
        let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(source));
        assert!(code.contains("async fn set"), "scanned the wrong text");
        // The undo is not optional: it is what makes the approval acceptable.
        assert!(code.contains("/approve") && code.contains("/unapprove"));
        for verb in [".put(", ".patch(", ".delete("] {
            assert!(
                !code.contains(verb),
                "src/gitlab_approval.rs names `{verb}`. This module is the ONE tracker write \
                 and it is an approval plus its undo — anything else is a deliberate feature \
                 with its own consent gate, not an edit here."
            );
        }
        // ONE request is a write, and it is that pair. A second `.post(` would be a
        // write the module's own name does not cover.
        assert_eq!(code.matches(".post(").count(), 1);
        // The neighbours GitLab offers on the same resource, and what each would do that
        // an approval does not: a note is a comment under the user's name, a merge lands
        // the branch, a rebase rewrites it.
        for endpoint in ["/notes", "/merge\"", "/rebase"] {
            assert!(
                !code.contains(endpoint),
                "src/gitlab_approval.rs names `{endpoint}`, which is not an approval."
            );
        }
    }

    /// And the write lives HERE, nowhere else. `src/gitlab.rs` is the read path and
    /// stays one: a `/approve` that appeared beside the enrichment would be a write with
    /// no gate in front of it.
    #[test]
    fn the_rest_of_the_crate_names_no_approval_endpoint() {
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
            if file.ends_with("gitlab_approval.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            let code = strip_line_comments(source.split("#[cfg(test)]").next().unwrap_or(&source));
            for endpoint in ["/approve", "/unapprove"] {
                assert!(
                    !code.contains(endpoint),
                    "{} names `{endpoint}`. The one tracker write lives in \
                     src/gitlab_approval.rs, behind the `gitlab_set_approval` consent gate.",
                    file.display()
                );
            }
        }
    }

    #[test]
    fn only_a_merge_request_on_the_configured_host_is_approvable() {
        assert_eq!(
            merge_request("https://gitlab.com/acme/app/-/merge_requests/42", "gitlab.com"),
            Some(("acme/app".to_string(), 42))
        );
        // An issue is not a merge request, and a project is not either.
        assert_eq!(merge_request("https://gitlab.com/acme/app/-/issues/9", "gitlab.com"), None);
        assert_eq!(merge_request("https://gitlab.com/acme/app", "gitlab.com"), None);
        // The host pin of the read path holds: the token reaches one host.
        assert_eq!(
            merge_request("https://gitlab.evil.example/acme/app/-/merge_requests/1", "gitlab.com"),
            None
        );
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
    async fn a_write_with_no_token_never_reaches_the_network() {
        let http = reqwest::Client::new();
        let err = set(&http, "gitlab.com", None, "https://gitlab.com/a/b/-/merge_requests/1", true)
            .await
            .expect_err("a tokenless approval must be refused here");
        assert!(err.to_string().contains("needs a GitLab token"), "{err}");

        // And neither does one aimed at something that is not a merge request.
        let err = set(&http, "gitlab.com", Some("tok"), "https://gitlab.com/a/b/-/issues/1", true)
            .await
            .expect_err("an issue is not approvable");
        assert!(err.to_string().contains("not a merge request"), "{err}");
    }

    #[test]
    fn reads_the_approval_state_and_whose_approval_it_is() {
        let body = serde_json::json!({
            "approved": true,
            "approvals_required": 2,
            "approvals_left": 1,
            "approved_by": [
                { "user": { "id": 77, "name": "Ada Lovelace", "username": "ada" } },
                { "user": { "id": 12, "username": "grace" } },
            ],
        });
        let state = build_approval(42, &body, Some(12));
        assert_eq!(state.reference, "!42");
        assert_eq!(state.approved, Some(true));
        assert_eq!(state.approvals_required, Some(2));
        assert_eq!(state.approvals_left, Some(1));
        // A missing display name falls back to the handle, never to a blank row.
        assert_eq!(state.approved_by, vec!["Ada Lovelace", "grace"]);
        assert!(state.mine, "id 12 approved");

        // Another account's approval is not the user's, whatever it is called.
        assert!(!build_approval(42, &body, Some(99)).mine);
        // And an unknown account claims nothing: "Approve" is the safe offer, since
        // GitLab accepts it twice while a revoke would undo somebody else's decision.
        assert!(!build_approval(42, &body, None).mine);
    }

    #[test]
    fn a_community_edition_body_keeps_its_counts_absent() {
        // No approval rules: the counts are missing, not zero. A UI reading them as zero
        // would say "no approval needed" on a merge request that wants one.
        let body = serde_json::json!({ "approved_by": [] });
        let state = build_approval(5, &body, Some(1));
        assert_eq!(state.approvals_required, None);
        assert_eq!(state.approvals_left, None);
        assert_eq!(state.approved, None);
        assert!(state.approved_by.is_empty());
        assert!(!state.mine);
        // The absent halves stay off the wire, so the TypeScript mirror can treat every
        // optional as truly optional.
        let value = serde_json::to_value(&state).unwrap();
        assert!(value.get("approvals_required").is_none());
        assert!(value.get("approved_by").is_none());
        assert_eq!(value["mine"], false);
    }

    #[test]
    fn a_refusal_says_what_the_user_can_act_on() {
        assert!(
            refusal(reqwest::StatusCode::UNAUTHORIZED).contains("may not approve"),
            "an ineligible approver must be told so"
        );
        assert!(refusal(reqwest::StatusCode::NOT_FOUND).contains("not visible"));
        assert!(refusal(reqwest::StatusCode::IM_A_TEAPOT).contains("418"));
    }
}

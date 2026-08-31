// A conversation's roster: who is in a chat, which is what the composer's @mention
// list offers.
//
//   GET {chatService}/v1/threads/{threadId}?view=msnp24Equivalent
//
// Verified against the tenant (examples/thread_members_recon.rs). Two findings shape
// this module:
//
//   - A `members` entry names its member by MRI only. `friendlyName` exists in the
//     payload and is EMPTY on every member of every thread tried, so a name is never
//     read from here: the caller resolves it, from the local store first and from the
//     short-profile endpoint for whoever is left (see the `members` RPC).
//   - A CHANNEL (`@thread.tacv2`) reports a roster of ONE — us. The team's members
//     are not exposed on the thread, so a channel's mention list cannot come from
//     here; the caller falls back to the people who have written in that channel.
//
// This module is READ-ONLY, and the roster is the one thing it reads. Membership is
// outward-facing in a way a message is not: adding or removing a member changes what
// other people see in their own client and cannot be undone from here, so no code
// names those endpoints and a test below scans this module for any verb but GET.

use anyhow::{Context, Result};
use serde_json::Value;

/// One member of a conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadMember {
    /// The member's MRI (e.g. `8:orgid:<guid>`) — what a mention actually points at.
    pub mri: String,
    /// The name Teams holds for them in this thread. Empty far more often than not,
    /// so a caller that needs a name resolves it (see `display_name_for_mri`).
    pub display_name: String,
}

/// A member entry Teams no longer counts as part of the thread. A left/removed
/// member keeps its row with this role, so it must not reach a mention list.
const GONE_ROLES: [&str; 2] = ["ReadOnly", "None"];

/// Fetch a conversation's own thread payload — the ONE `GET /v1/threads/{id}` this app
/// makes, and the one place its URL is spelled.
///
/// Two facts are read off it and neither belongs to the other: the ROSTER
/// ([`parse_thread_members`], below) and how a channel is LAID OUT
/// (`crate::channel_layout`, which delegates here rather than repeating the request). A
/// second spelling of this GET would be a second thing to keep in step with the
/// endpoint, and it would slip past this module's own GET-only scan.
///
/// Uses the `Authentication: skypetoken=…` scheme the rest of the chatService read
/// path uses (never a Bearer).
///
/// Best-effort by contract: a thread the tenant will not expose answers an error for
/// the caller's retry policy, and a caller that only wants suggestions treats that
/// as "nothing known" rather than as a failure.
pub async fn fetch_thread(
    http: &reqwest::Client,
    session: &crate::teams::Session,
    conversation_id: &str,
) -> Result<Value> {
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let url = format!(
        "{chat_service}/v1/threads/{}?view=msnp24Equivalent",
        urlencoding::encode(conversation_id)
    );
    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("thread request")?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("thread -> {status}");
    }
    serde_json::from_str(&body).context("parse thread")
}

/// Fetch a conversation's roster. Returns every member the thread reports, including
/// us — the caller filters itself out, exactly like the read-receipt path does.
pub async fn fetch_thread_members(
    http: &reqwest::Client,
    session: &crate::teams::Session,
    conversation_id: &str,
) -> Result<Vec<ThreadMember>> {
    Ok(parse_thread_members(&fetch_thread(http, session, conversation_id).await?))
}

/// Parse a thread payload into its members. Pure, so the wire shape is pinned by a
/// unit test against a captured payload instead of by a live call.
///
/// Only a person is kept: a thread's roster also lists bots (`28:`) and the thread
/// itself (`19:`), and neither is someone a mention can name. A member Teams has
/// demoted out of the thread is dropped too (see [`GONE_ROLES`]), as is one it marks
/// `hidden`.
pub fn parse_thread_members(payload: &Value) -> Vec<ThreadMember> {
    let Some(list) = payload.get("members").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<ThreadMember> = Vec::new();
    for entry in list {
        let Some(mri) = entry
            .get("id")
            .or_else(|| entry.get("mri"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|mri| crate::teams_profiles::is_person_mri(mri))
        else {
            continue;
        };
        let role = entry.get("role").and_then(Value::as_str).unwrap_or("");
        if GONE_ROLES.contains(&role) {
            continue;
        }
        if entry.get("hidden").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        // `friendlyName` is empty on every member this tenant returns, so this is a
        // fallback that almost never fires rather than the naming path.
        let display_name = entry
            .get("friendlyName")
            .or_else(|| entry.get("friendlyname"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if out.iter().any(|m| crate::store::same_user(&m.mri, mri)) {
            continue;
        }
        out.push(ThreadMember { mri: mri.to_string(), display_name });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// One member verbatim as the tenant returns it, captured with
    /// `examples/thread_members_recon.rs` — `friendlyName` empty included, because
    /// that is what every live member carries.
    fn thread_payload() -> Value {
        json!({
            "id": "19:abc@thread.v2",
            "type": "Thread",
            "version": 1784217926767i64,
            "rosterVersion": 1769073991115i64,
            "members": [
                {
                    "capabilities": ["kickMember"],
                    "cid": "0",
                    "hidden": false,
                    "id": "8:orgid:me",
                    "isFollowing": false,
                    "linkedMri": "",
                    "meetingRole": "None",
                    "rangeEnd": 253402300800000i64,
                    "rangeStart": 1718713057771i64,
                    "role": "Admin",
                    "type": "ThreadMember",
                    "userLink": "https://fr.ng.msg.teams.microsoft.com/v1/users/8:orgid:me"
                },
                { "id": "8:orgid:other", "role": "User", "friendlyName": "Ada Lovelace" },
                { "id": "28:bot-guid", "role": "User", "friendlyName": "Some App" },
                { "id": "19:abc@thread.v2", "role": "User", "friendlyName": "" },
                { "id": "8:orgid:left", "role": "ReadOnly", "friendlyName": "Left Person" },
                { "id": "8:orgid:ghost", "role": "User", "hidden": true }
            ]
        })
    }

    #[test]
    fn parses_people_and_drops_bots_threads_and_departed_members() {
        let members = parse_thread_members(&thread_payload());
        assert_eq!(
            members,
            vec![
                ThreadMember { mri: "8:orgid:me".into(), display_name: String::new() },
                ThreadMember { mri: "8:orgid:other".into(), display_name: "Ada Lovelace".into() },
            ],
            "an app, the thread itself, a demoted member and a hidden one are not \
             mentionable people"
        );
    }

    #[test]
    fn a_member_listed_twice_is_kept_once() {
        // Twice as the same identity, and twice as the two spellings Teams mixes (the
        // bare MRI and the user URL the payload also carries).
        let payload = json!({
            "members": [
                { "id": "8:orgid:abc", "friendlyName": "Ada" },
                { "id": "8:orgid:abc", "friendlyName": "Ada" },
                { "id": "https://fr.ng.msg.teams.microsoft.com/v1/users/8:orgid:abc" }
            ]
        });
        assert_eq!(parse_thread_members(&payload), vec![ThreadMember {
            mri: "8:orgid:abc".into(),
            display_name: "Ada".into(),
        }]);
    }

    #[test]
    fn a_payload_without_members_yields_nothing() {
        assert!(parse_thread_members(&json!({ "id": "19:x" })).is_empty());
        assert!(parse_thread_members(&json!({ "members": "not an array" })).is_empty());
        assert!(parse_thread_members(&json!({})).is_empty());
    }

    /// The roster is read, never written. Adding or removing a member changes what
    /// other people see in their own Teams client and cannot be undone from here, so
    /// this module must issue GET requests only — a future edit that reaches for a
    /// membership write fails this test instead of quietly gaining the ability to
    /// change a thread's roster as the user.
    #[test]
    fn module_issues_only_get_requests() {
        let source = include_str!("teams_members.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        let code: String = code
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(code.contains("http\n        .get("), "scanned the wrong text");
        for verb in [".post(", ".put(", ".patch(", ".delete("] {
            assert!(
                !code.contains(verb),
                "src/teams_members.rs must issue GET requests only, found `{verb}`. The roster is \
                 read-only by construction: a membership change is visible to everyone in the \
                 thread and cannot be undone from here, so a write path is a deliberate feature \
                 that needs its own consent gate."
            );
        }
    }
}

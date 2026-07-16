// Teams read API — the network layer that feeds the local-first store (slice 1).
//
// Two endpoints, both proven by the src/bin/read.rs recon spike:
//
//   1. conversation list  (CSA aggregator, host teams.microsoft.com)
//        GET /api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true
//        Bearer = chatsvcagg-audience token (NOT ic3). Returns { chats, teams, ... }.
//
//   2. message history    (chatService, host {region}.ng.msg.teams.microsoft.com)
//        GET {chatService}/v1/users/ME/conversations/{id}/messages?pageSize=N&view=msnp24Equivalent
//        Header: `Authentication: skypetoken=...`  (NOT a Bearer).
//        Newest-first. Pagination into the PAST = timestamp window:
//        add &startTime=1&endTime={oldest_composetime_ms - 1}. The opaque
//        _metadata.syncState is a FORWARD/live cursor and 400s on backfill —
//        do not use it here (that belongs to slice 2 gap-sync).
//
// This module does pure networking + parsing into domain types; wiring into the
// store lives in the caller. No raw tokens are ever logged.

use anyhow::{Context, Result};
use serde_json::Value;

use crate::store::Message;
use crate::teams::Session;

/// The chatsvcagg audience — the conversation-list aggregator rejects the ic3 token.
pub const CSA_SCOPE: &str = "https://chatsvcagg.teams.microsoft.com/.default";

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";
const DEFAULT_PAGE_SIZE: u32 = 30;

/// A conversation summary as surfaced by the CSA aggregator. This is what the
/// conversation list (and cmd+K palette, later) is built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub chat_type: String,
    pub is_one_on_one: bool,
    /// Compose time (epoch ms) of the last message, for sort order. 0 if unknown/empty.
    pub last_message_time: i64,
    /// True when the thread has never had a message (empty meeting rooms, etc.).
    pub is_empty: bool,
    /// For a 1:1, the mri of the OTHER member (not us). Empty otherwise. Used to
    /// resolve the conversation's display name via the profiles endpoint.
    pub other_member_mri: String,
}

/// One page of history, oldest-first (ready to feed the store in seq order).
pub struct MessagePage {
    pub messages: Vec<Message>,
    /// The cursor to request the NEXT older page: compose time (epoch ms) of the
    /// oldest message in this page. `None` when there is nothing older to fetch.
    pub next_before_ms: Option<i64>,
    /// False once the server returns a short/empty page — we've hit the top.
    pub has_more_older: bool,
}

/// Fetch the full conversation list from the CSA aggregator.
///
/// `csa_token` must be an access token for [`CSA_SCOPE`]; the aggregator 401s on
/// the ic3 token. Returns conversations best-effort: malformed items are skipped
/// rather than failing the whole sync.
pub async fn fetch_conversations(
    http: &reqwest::Client,
    session: &Session,
    csa_token: &str,
) -> Result<Vec<Conversation>> {
    let resp = http
        .get(CSA_URL)
        .bearer_auth(csa_token)
        .header("x-skypetoken", &session.skypetoken)
        .send()
        .await
        .context("CSA users/me request")?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("CSA users/me -> {status}");
    }
    let v: Value = serde_json::from_str(&body).context("parse CSA users/me")?;
    Ok(parse_conversations_with_self(&v, &session.self_mri))
}

/// Fetch one page of a conversation's history, walking into the past.
///
/// Pass `before_ms = None` for the newest page (initial open), or the previous
/// page's `next_before_ms` to page further back. Messages come back oldest-first.
pub async fn fetch_messages_page(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    before_ms: Option<i64>,
    page_size: u32,
) -> Result<MessagePage> {
    let chat_service = session
        .endpoint("chatService")
        .context("no chatService endpoint in regionGtms")?
        .trim_end_matches('/');
    let mut url = format!(
        "{chat_service}/v1/users/ME/conversations/{}/messages?pageSize={page_size}&view=msnp24Equivalent",
        urlencoding::encode(conversation_id)
    );
    if let Some(before) = before_ms {
        // Timestamp-window pagination into the past (proven by the recon spike).
        url.push_str(&format!("&startTime=1&endTime={}", before.saturating_sub(1)));
    }

    let resp = http
        .get(&url)
        .header("authentication", format!("skypetoken={}", session.skypetoken))
        .send()
        .await
        .context("chatService messages request")?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        anyhow::bail!("chatService messages -> {status}");
    }
    let v: Value = serde_json::from_str(&body).context("parse messages page")?;
    Ok(parse_message_page(&v, conversation_id, page_size))
}

/// Convenience: page size default used by the app.
pub async fn fetch_newest(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
) -> Result<MessagePage> {
    fetch_messages_page(http, session, conversation_id, None, DEFAULT_PAGE_SIZE).await
}

// ---- sync orchestration (network -> local-first store) ----------------------
//
// These keep the store as the single source of truth: the network only writes
// through the store, dedup happens in SQLite (INSERT OR IGNORE), and the backfill
// cursor (oldest compose time in ms) is persisted per conversation.

use crate::store::Store;

/// Sync the conversation list into the store. Empty threads are skipped so the
/// list only shows conversations that actually have content.
///
/// Returns the number of conversations written.
pub async fn sync_conversation_list(
    http: &reqwest::Client,
    session: &Session,
    csa_token: &str,
    store: &Store,
) -> Result<usize> {
    let convs = fetch_conversations(http, session, csa_token).await?;
    Ok(persist_conversations(store, &convs))
}

/// Persist a fetched conversation list into the store (pure/sync, no `.await`).
/// Empty threads are skipped. Returns how many were written.
pub fn persist_conversations(store: &Store, convs: &[Conversation]) -> usize {
    let mut written = 0;
    for c in convs {
        if c.is_empty {
            continue;
        }
        if store.upsert_conversation(&c.id, &c.title, c.last_message_time).is_ok() {
            written += 1;
        }
    }
    written
}

/// Load the newest page of a conversation into the store (initial open) and record
/// the backfill cursor. Idempotent: re-running only inserts messages not already held.
///
/// Returns the number of newly-inserted messages.
pub async fn sync_newest_page(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    store: &Store,
) -> Result<usize> {
    let page = fetch_newest(http, session, conversation_id).await?;
    persist_page(store, conversation_id, &page)
}

/// Fetch the next older page from the network, but ONLY at the cache frontier:
/// the caller decides to call this when the UI scrolls past the oldest cached
/// message. Uses the persisted cursor; a `None` cursor means "start from newest".
///
/// Returns the number of newly-inserted messages (0 when history is exhausted).
pub async fn backfill_older(
    http: &reqwest::Client,
    session: &Session,
    conversation_id: &str,
    store: &Store,
) -> Result<usize> {
    let (cursor, has_more) = store.oldest_cursor(conversation_id)?;
    if !has_more {
        return Ok(0); // already reached the top; don't hit the network
    }
    // The persisted cursor is the oldest compose time (ms) we hold, as a string.
    let before_ms = cursor.as_deref().and_then(|s| s.parse::<i64>().ok());
    let page = fetch_messages_page(http, session, conversation_id, before_ms, DEFAULT_PAGE_SIZE).await?;
    persist_page(store, conversation_id, &page)
}

/// Insert a page's messages and advance the persisted backfill cursor.
///
/// Pure/sync store work — no network, no `.await` — so callers can keep the
/// non-`Send` `Store` out of async scopes (fetch first, then persist).
///
/// The cursor is monotonic into the past: it only ever moves to an OLDER compose
/// time. This matters because `sync_newest_page` (initial open, or a reconnect
/// refresh) fetches recent messages whose oldest timestamp is NEWER than how far
/// back we've already paged — we must not let that regress the backfill frontier.
pub fn persist_page(store: &Store, conversation_id: &str, page: &MessagePage) -> Result<usize> {
    let mut inserted = 0;
    for m in &page.messages {
        if store.insert_message(m)? {
            inserted += 1;
        }
    }

    let (prev_cursor, _) = store.oldest_cursor(conversation_id)?;
    let prev_ms = prev_cursor.as_deref().and_then(|s| s.parse::<i64>().ok());

    match (prev_ms, page.next_before_ms) {
        // Empty conversation / empty page: leave the cursor untouched.
        (_, None) => {}
        // First cursor we've ever recorded for this conversation.
        (None, Some(new_ms)) => {
            store.set_oldest_cursor(conversation_id, Some(&new_ms.to_string()), page.has_more_older)?;
        }
        // Only move the frontier if this page reached OLDER history than before.
        (Some(prev), Some(new_ms)) if new_ms < prev => {
            store.set_oldest_cursor(conversation_id, Some(&new_ms.to_string()), page.has_more_older)?;
        }
        // This page was newer than our frontier (e.g. a reconnect refresh): keep
        // the older frontier and its has_more flag intact.
        (Some(_), Some(_)) => {}
    }
    Ok(inserted)
}

// ---- parsing (pure, unit-tested against real shapes) ------------------------

#[cfg(test)]
fn parse_conversations(v: &Value) -> Vec<Conversation> {
    parse_conversations_with_self(v, "")
}


/// Parse the CSA chat list. `self_mri` lets us pick the OTHER member of a 1:1 for
/// name resolution; pass "" if unknown (then other_member_mri may be either party).
fn parse_conversations_with_self(v: &Value, self_mri: &str) -> Vec<Conversation> {
    let mut out = Vec::new();
    for chat in v.get("chats").and_then(|c| c.as_array()).into_iter().flatten() {
        let Some(id) = chat.get("id").and_then(|x| x.as_str()) else { continue };
        // Keep an empty title empty (do NOT substitute a placeholder here) so the
        // store's 1:1 name derivation and profile resolution can fill it.
        let title = chat
            .get("title")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string();
        let chat_type = chat.get("chatType").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let is_one_on_one = chat.get("isOneOnOne").and_then(|x| x.as_bool()).unwrap_or(false);
        let is_empty = chat.get("isEmptyConversation").and_then(|x| x.as_bool()).unwrap_or(false)
            || chat.pointer("/lastMessage/id").and_then(|x| x.as_str()).is_none();
        let last_message_time = chat
            .pointer("/lastMessage/composeTime")
            .and_then(|x| x.as_str())
            .map(parse_iso_ms)
            .unwrap_or(0);

        // For a 1:1, find the member that isn't us.
        let other_member_mri = if is_one_on_one {
            chat.get("members")
                .and_then(|m| m.as_array())
                .and_then(|members| {
                    members
                        .iter()
                        .filter_map(|m| m.get("mri").and_then(|x| x.as_str()))
                        .find(|mri| *mri != self_mri)
                })
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };

        out.push(Conversation {
            id: id.to_string(),
            title,
            chat_type,
            is_one_on_one,
            last_message_time,
            is_empty,
            other_member_mri,
        });
    }
    out
}

fn parse_message_page(v: &Value, conversation_id: &str, page_size: u32) -> MessagePage {
    let raw = v.get("messages").and_then(|m| m.as_array()).cloned().unwrap_or_default();
    let count = raw.len();

    let mut messages: Vec<Message> = raw.iter().filter_map(|m| parse_message(m, conversation_id)).collect();
    // The API returns newest-first; the store orders by seq, but we normalize to
    // oldest-first here so callers can insert in natural order.
    messages.sort_by_key(|m| m.seq);

    // Cursor for the next older page = oldest compose time we now hold.
    let next_before_ms = messages.first().map(|m| m.compose_time).filter(|&t| t > 0);
    // A short page means we've reached the top of history.
    let has_more_older = count as u32 >= page_size && next_before_ms.is_some();

    MessagePage { messages, next_before_ms, has_more_older }
}

/// Parse a single message resource (shared by the read API and trouter events —
/// both deliver the same message shape). `conversation_id` is passed in because
/// the read API groups by conversation; for a live event, derive it from the
/// resource's `conversationid`/`conversationLink` before calling.
pub(crate) fn parse_message(m: &Value, conversation_id: &str) -> Option<Message> {    let id = m.get("id").and_then(|x| x.as_str())?.to_string();
    // Skip control/system frames that carry no displayable content.
    let content = m.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let seq = m.get("sequenceId").and_then(|x| x.as_i64()).unwrap_or(0);
    let compose_time = m.get("composetime").and_then(|x| x.as_str()).map(parse_iso_ms).unwrap_or(0);
    let sender = m
        .get("imdisplayname")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| m.get("from").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();
    Some(Message {
        id,
        conversation_id: conversation_id.to_string(),
        seq,
        compose_time,
        sender,
        content,
    })
}

/// Parse an ISO-8601 UTC timestamp ("2026-07-16T16:05:26.7670000Z") to epoch millis.
/// Teams uses up to 7 fractional digits; we only need second precision for paging,
/// but we keep the .fff milliseconds when present. Uses Howard Hinnant's
/// days_from_civil algorithm so we avoid pulling in a date crate for one field.
pub fn parse_iso_ms(s: &str) -> i64 {
    let b = s.as_bytes();
    if s.len() < 19 || b.get(4) != Some(&b'-') || b.get(10) != Some(&b'T') {
        return 0;
    }
    let num = |a: usize, e: usize| s.get(a..e).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let (y, mo, d) = (num(0, 4), num(5, 7), num(8, 10));
    let (h, mi, se) = (num(11, 13), num(14, 16), num(17, 19));

    // milliseconds from the fractional part, if present (".7670000" -> 767)
    let mut ms = 0i64;
    if b.get(19) == Some(&b'.') {
        let frac: String = s[20..].chars().take_while(|c| c.is_ascii_digit()).take(3).collect();
        if !frac.is_empty() {
            let padded = format!("{frac:0<3}");
            ms = padded.parse::<i64>().unwrap_or(0);
        }
    }

    let yy = if mo <= 2 { y - 1 } else { y };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    (days * 86400 + h * 3600 + mi * 60 + se) * 1000 + ms
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn iso_ms_roundtrip() {
        // 2026-07-16T16:05:26.767Z. Verify against a known epoch (computed independently).
        let t = parse_iso_ms("2026-07-16T16:05:26.7670000Z");
        // 2026-07-16T16:05:26Z = 1784217926 s (sanity: > 2025, < 2027)
        assert_eq!(t, 1784217926767);
        // no fractional part
        assert_eq!(parse_iso_ms("2026-07-16T16:05:26Z"), 1784217926000);
        // epoch anchor
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), 0);
        // garbage -> 0, never panics
        assert_eq!(parse_iso_ms("not-a-date"), 0);
        assert_eq!(parse_iso_ms(""), 0);
    }

    #[test]
    fn parses_conversation_list() {
        let v = json!({
            "chats": [
                {
                    "id": "19:abc@thread.v2",
                    "title": " Team Chat ",
                    "chatType": "meeting",
                    "isOneOnOne": false,
                    "isEmptyConversation": false,
                    "lastMessage": { "id": "123", "composeTime": "2026-07-16T16:05:26.767Z" }
                },
                {
                    "id": "19:empty@thread.v2",
                    "title": "Empty room",
                    "chatType": "meeting",
                    "isEmptyConversation": true,
                    "lastMessage": { "id": null, "composeTime": null }
                },
                { "title": "no id — skipped" }
            ]
        });
        let convs = parse_conversations(&v);
        assert_eq!(convs.len(), 2); // the id-less one is skipped
        assert_eq!(convs[0].id, "19:abc@thread.v2");
        assert_eq!(convs[0].title, "Team Chat"); // trimmed
        assert_eq!(convs[0].last_message_time, 1784217926767);
        assert!(!convs[0].is_empty);
        assert!(convs[1].is_empty); // flagged empty
        assert_eq!(convs[1].last_message_time, 0);
    }

    #[test]
    fn one_on_one_extracts_other_member_mri() {
        let v = json!({
            "chats": [{
                "id": "19:dm@unq.gbl.spaces",
                "title": "",
                "chatType": "chat",
                "isOneOnOne": true,
                "isEmptyConversation": false,
                "lastMessage": { "id": "1", "composeTime": "2026-07-16T16:05:26.767Z" },
                "members": [
                    { "mri": "8:orgid:me", "objectId": "me" },
                    { "mri": "8:orgid:other", "objectId": "other" }
                ]
            }]
        });
        // we are "8:orgid:me" -> the other member is picked
        let convs = parse_conversations_with_self(&v, "8:orgid:me");
        assert_eq!(convs.len(), 1);
        assert!(convs[0].is_one_on_one);
        assert_eq!(convs[0].other_member_mri, "8:orgid:other");
        assert_eq!(convs[0].title, ""); // blank -> to be resolved by name lookup
    }

    #[test]
    fn parses_message_page_oldest_first_with_cursor() {
        // API returns newest-first; two messages, page_size 30 => short page => top reached.
        let v = json!({
            "messages": [
                {
                    "id": "1784217926767", "sequenceId": 9186,
                    "composetime": "2026-07-16T16:05:26.767Z",
                    "content": "<p>plus récent</p>", "contenttype": "Text",
                    "messagetype": "RichText/Html", "imdisplayname": "Clément BOSLE"
                },
                {
                    "id": "1784216583240", "sequenceId": 9180,
                    "composetime": "2026-07-16T15:43:03.240Z",
                    "content": "<p>plus ancien</p>", "messagetype": "RichText/Html",
                    "imdisplayname": "Alice"
                }
            ],
            "_metadata": { "syncState": "opaque" }
        });
        let page = parse_message_page(&v, "19:abc@thread.v2", 30);
        assert_eq!(page.messages.len(), 2);
        // normalized oldest-first
        assert_eq!(page.messages[0].seq, 9180);
        assert_eq!(page.messages[1].seq, 9186);
        assert_eq!(page.messages[0].sender, "Alice");
        assert_eq!(page.messages[0].content, "<p>plus ancien</p>");
        // cursor = oldest compose time
        assert_eq!(page.next_before_ms, Some(1784216583240));
        // short page (2 < 30) => no more older history
        assert!(!page.has_more_older);
    }

    #[test]
    fn full_page_signals_more_history() {
        let mut msgs = Vec::new();
        for i in 0..30 {
            msgs.push(json!({
                "id": format!("m{i}"), "sequenceId": 1000 + i,
                "composetime": "2026-07-16T15:43:03.240Z",
                "content": "x", "imdisplayname": "Bob"
            }));
        }
        let v = json!({ "messages": msgs });
        let page = parse_message_page(&v, "c1", 30);
        assert_eq!(page.messages.len(), 30);
        assert!(page.has_more_older); // full page => keep paging
        assert!(page.next_before_ms.is_some());
    }

    // ---- store wiring: local-first cursor + dedup ---------------------------

    fn page(seqs: &[i64], oldest_ms: i64, has_more: bool) -> MessagePage {
        let messages = seqs
            .iter()
            .enumerate()
            .map(|(i, &seq)| Message {
                id: format!("id{seq}"),
                conversation_id: "c1".into(),
                seq,
                // oldest message carries oldest_ms; others just need to be >= it
                compose_time: oldest_ms + i as i64,
                sender: "s".into(),
                content: "c".into(),
            })
            .collect();
        MessagePage { messages, next_before_ms: Some(oldest_ms), has_more_older: has_more }
    }

    #[test]
    fn persist_dedups_and_counts_only_new() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_conversation("c1", "Chat", 0).unwrap();

        let p1 = page(&[10, 11, 12], 1000, true);
        assert_eq!(persist_page(&store, "c1", &p1).unwrap(), 3);
        // re-persisting the same page inserts nothing (dedup by id in SQLite)
        assert_eq!(persist_page(&store, "c1", &p1).unwrap(), 0);
    }

    #[test]
    fn cursor_is_monotonic_into_the_past() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_conversation("c1", "Chat", 0).unwrap();

        // initial newest page: oldest ms = 5000
        persist_page(&store, "c1", &page(&[100, 101], 5000, true)).unwrap();
        assert_eq!(store.oldest_cursor("c1").unwrap(), (Some("5000".into()), true));

        // backfill reaches older history: oldest ms = 3000 -> frontier advances
        persist_page(&store, "c1", &page(&[90, 91], 3000, true)).unwrap();
        assert_eq!(store.oldest_cursor("c1").unwrap(), (Some("3000".into()), true));

        // a reconnect refresh brings NEWER messages (oldest ms = 8000): frontier
        // must NOT regress, and has_more_older stays true.
        persist_page(&store, "c1", &page(&[200], 8000, false)).unwrap();
        assert_eq!(store.oldest_cursor("c1").unwrap(), (Some("3000".into()), true));

        // reaching the very top: older page, short (has_more=false) -> frontier
        // advances and paging stops.
        persist_page(&store, "c1", &page(&[80], 1000, false)).unwrap();
        assert_eq!(store.oldest_cursor("c1").unwrap(), (Some("1000".into()), false));
    }
}

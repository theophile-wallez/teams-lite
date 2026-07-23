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

use crate::store::{ConversationKind, Message};
use crate::teams::Session;

/// The chatsvcagg audience — the conversation-list aggregator rejects the ic3 token.
pub const CSA_SCOPE: &str = "https://chatsvcagg.teams.microsoft.com/.default";

const CSA_URL: &str =
    "https://teams.microsoft.com/api/csa/api/v1/teams/users/me?isPrefetch=false&enableMembershipSummary=true";
pub const DEFAULT_PAGE_SIZE: u32 = 40;

/// True when an error from this module was caused by an expired/rejected
/// credential (HTTP 401). Callers use this to force-refresh tokens and retry
/// once, since broker tokens can die before their nominal TTL (device sleep,
/// conditional-access re-evaluation, clock skew).
pub fn is_unauthorized(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        let s = cause.to_string();
        s.contains("401") || s.contains("Unauthorized")
    })
}

/// A conversation summary as surfaced by the CSA aggregator. This is what the
/// conversation list (and cmd+K palette, later) is built from.
///
/// The extra fields beyond id/title mirror what the Teams desktop sidebar shows,
/// so the TUI can render a faithful list: a last-message preview line, an unread
/// marker, and muted/pinned/hidden state. All of it comes from the SAME CSA call
/// (`users/me`) with zero extra round-trips — the `lastMessage` sub-object holds
/// the preview body and sender, and the chat carries the state booleans.
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
    /// Plain-text, HTML-stripped preview of the last message (`lastMessage.content`).
    /// Empty for system frames or when the body is absent.
    pub last_message_preview: String,
    /// Display name of the last message's sender (`lastMessage.imDisplayName`).
    /// Empty when unknown. The UI renders "You:" instead when `last_message_from_me`.
    pub last_message_sender: String,
    /// True when we sent the last message — the UI prefixes the preview with "You:".
    pub last_message_from_me: bool,
    /// False when the thread has unread messages. Drives the unread marker.
    pub is_read: bool,
    /// True when the user muted this conversation.
    pub is_muted: bool,
    /// True when the conversation is pinned to the top of the list (`isSticky`).
    pub is_pinned: bool,
    /// True when the conversation is hidden from the list until a new message.
    pub is_hidden: bool,
    /// Finer-grained thread classification from CSA (e.g. "chat", "meeting",
    /// "sfbinteropchat"). `chat_type`/`kind()` stay the primary classifier; this
    /// is carried through for faithful rendering and future use.
    pub thread_type: String,
}

impl Conversation {
    /// Classify this conversation into a storable `ConversationKind`.
    ///
    /// Priority: a self "Notes" chat (Teams uses the `48:` id prefix, e.g.
    /// `48:notes`) is detected first, since it can also carry a generic chat
    /// type. Then the explicit 1:1 flag, then the group fallback. When we have
    /// no signal at all we return `Unknown` so the store never guesses.
    pub fn kind(&self) -> ConversationKind {
        if self.id.starts_with("48:") {
            return ConversationKind::Notes;
        }
        if self.is_one_on_one || self.chat_type.eq_ignore_ascii_case("oneonone") {
            return ConversationKind::OneOnOne;
        }
        match self.chat_type.to_ascii_lowercase().as_str() {
            "group" | "meeting" | "topic" => ConversationKind::Group,
            "" => ConversationKind::Unknown,
            // an unmapped-but-present chat type: treat as a group (shows names,
            // which never hides information) rather than misclassifying as 1:1.
            _ => ConversationKind::Group,
        }
    }
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
    let mut changed = 0;
    for c in convs {
        if c.is_empty {
            continue;
        }
        // The activity feed is a system thread, not a chat — keep it out of the
        // conversation list entirely (it is surfaced in the notifications panel).
        if crate::teams_activity::is_notifications_thread(&c.id) {
            continue;
        }
        // Count only conversations that were actually inserted or modified, so
        // the caller emits `conversations_changed` ONLY on a real change. A
        // blanket "upsert succeeded" count would report a change on every sync
        // of identical data and spin the UI's refresh->sync->event loop.
        let update = crate::store::ConversationUpdate {
            id: &c.id,
            display_name: &c.title,
            last_message_time: c.last_message_time,
            kind: c.kind(),
            last_message_preview: &c.last_message_preview,
            last_message_sender: &c.last_message_sender,
            last_message_from_me: c.last_message_from_me,
            is_read: c.is_read,
            is_muted: c.is_muted,
            is_pinned: c.is_pinned,
            is_hidden: c.is_hidden,
            thread_type: &c.thread_type,
        };
        if store.upsert_conversation_full(&update).unwrap_or(false) {
            changed += 1;
        }
    }
    changed
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
    persist_backfill_page(store, conversation_id, &page)
}

/// Persist a page fetched from the historical frontier. An empty page is a
/// definitive end-of-history signal, so remember it instead of retrying the same
/// empty request every time the user reaches the top.
pub fn persist_backfill_page(
    store: &Store,
    conversation_id: &str,
    page: &MessagePage,
) -> Result<usize> {
    let inserted = persist_page(store, conversation_id, page)?;
    if page.messages.is_empty() && !page.has_more_older {
        let (cursor, _) = store.oldest_cursor(conversation_id)?;
        store.set_oldest_cursor(conversation_id, cursor.as_deref(), false)?;
    }
    Ok(inserted)
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
        let new_row = store.insert_message(m)?;
        if new_row {
            inserted += 1;
        } else {
            // Existing row (INSERT skipped it): heal a legacy row that was
            // stored before we captured the sender MRI.
            store.backfill_sender_mri(&m.conversation_id, &m.id, &m.sender_mri)?;
        }
        // Reconcile reactions when this frame carried an emotions snapshot (an
        // empty sentinel means the frame said nothing about reactions). This lets
        // a history refresh pick up a changed reaction set on an already-stored
        // message — `insert_message`'s content-only conflict ignores it. Count a
        // reaction-only change so the caller refreshes the open view.
        if !m.reactions.is_empty()
            && store
                .update_message_reactions(&m.conversation_id, &m.id, &m.reactions)?
                .is_some()
            && !new_row
        {
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

        // Sidebar state, straight from the chat object (see the CSA capture spike).
        // NB: the `lastMessage` sub-object uses camelCase field names
        // (`imDisplayName`, `composeTime`) — NOT the lowercase names the
        // chatService messages endpoint uses. Do not reuse `parse_message` here.
        let last_message_preview = chat
            .pointer("/lastMessage/content")
            .and_then(|x| x.as_str())
            .map(preview_from_html)
            .unwrap_or_default();
        let last_message_sender = chat
            .pointer("/lastMessage/imDisplayName")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| chat.pointer("/lastMessage/fromDisplayNameInToken").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();
        let last_message_from_me = chat.get("isLastMessageFromMe").and_then(|x| x.as_bool()).unwrap_or(false);
        // `isRead` absent -> assume read, so a partial payload never floods the UI
        // with false unread markers.
        let is_read = chat.get("isRead").and_then(|x| x.as_bool()).unwrap_or(true);
        let is_muted = chat.get("isMuted").and_then(|x| x.as_bool()).unwrap_or(false);
        let is_pinned = chat.get("isSticky").and_then(|x| x.as_bool()).unwrap_or(false);
        let is_hidden = chat.get("hidden").and_then(|x| x.as_bool()).unwrap_or(false);
        let thread_type = chat.get("threadType").and_then(|x| x.as_str()).unwrap_or("").to_string();

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
            last_message_preview,
            last_message_sender,
            last_message_from_me,
            is_read,
            is_muted,
            is_pinned,
            is_hidden,
            thread_type,
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

    // Cursor for the next older page = oldest compose time in the RAW page, not
    // just among the displayable messages. `parse_message` drops control/system
    // frames (typing/presence, member & topic changes), so deriving the cursor
    // from `messages` would stall — or silently truncate — backfill whenever a
    // page happens to be entirely non-chat frames.
    let next_before_ms = raw
        .iter()
        .filter_map(|m| m.get("composetime").and_then(|x| x.as_str()).map(parse_iso_ms))
        .filter(|&t| t > 0)
        .min();
    // A short page means we've reached the top of history.
    let has_more_older = count as u32 >= page_size && next_before_ms.is_some();

    MessagePage { messages, next_before_ms, has_more_older }
}

/// True when a message frame carries user-visible chat content, as opposed to a
/// control/system frame that Teams multiplexes onto the SAME message channel.
///
/// Both the read history endpoint and the trouter live feed deliver, tagged by
/// `messagetype`: chat bodies (`Text`, `RichText`, `RichText/Html`,
/// `RichText/Media_*`, `RichText/UriObject`, …) AND machinery that must never
/// render as a chat bubble — `Control/*` (typing/presence, whose body is a bare
/// `notifications.skype.net` endpoint URL or a `<partlist>` roster),
/// `ThreadActivity/*` (member/topic changes: `<addmember>`, `<topicupdate>`, …),
/// `Event/*` (calls) and `Signal/*`. Only the chat families are displayable.
///
/// An absent/empty `messagetype` is treated as displayable: real frames always
/// carry one, so absence only occurs for synthetic inputs, and defaulting to
/// "show" guarantees a genuinely-typed message is never hidden by a missing field.
fn is_displayable_message_type(messagetype: &str) -> bool {
    let t = messagetype.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("Text") {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    lower == "richtext" || lower.starts_with("richtext/")
}

/// Parse a single message resource (shared by the read API and trouter events —
/// both deliver the same message shape). `conversation_id` is passed in because
/// the read API groups by conversation; for a live event, derive it from the
/// resource's `conversationid`/`conversationLink` before calling.
pub(crate) fn parse_message(m: &Value, conversation_id: &str) -> Option<Message> {
    let id = m.get("id").and_then(|x| x.as_str())?.to_string();
    // Skip control/system frames (typing/presence, member & topic changes, call
    // events). Teams pushes them alongside chat — notably as live `NewMessage`
    // resources — so gate on `messagetype` and keep only user-visible bodies.
    let messagetype = m
        .get("messagetype")
        .or_else(|| m.get("messageType"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if !is_displayable_message_type(messagetype) {
        return None;
    }
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
    let sender_mri = m
        .get("from")
        .and_then(|x| x.as_str())
        .map(normalize_mri)
        .unwrap_or_default();
    Some(Message {
        id,
        conversation_id: conversation_id.to_string(),
        seq,
        compose_time,
        sender,
        sender_mri,
        content,
        attachments: parse_attachments(m),
        reactions: parse_emotions(m),
    })
}

/// Extract file attachments from a message's `properties` into the wire shape the
/// UI renders: a JSON array string `[{name, content_type, url, kind}]`.
///
/// Teams delivers files shared in a chat under `properties.files`, each carrying
/// a title, a file type, and an authenticated `objectUrl` (fetched through the
/// backend media proxy — see `teams_media`). `properties` and `files` are each
/// frequently delivered as a JSON-ENCODED STRING rather than a nested object, so
/// we parse a level deeper when needed (same double-encoding as `userDetails` in
/// `teams::fetch_self_identity`).
///
/// Inline images embedded directly in the message HTML (`<img>` in `content`) are
/// NOT recorded here — the UI extracts and renders those from the content itself.
///
/// Best-effort by design: an absent, malformed, or empty `properties`/`files`
/// yields `"[]"`, never an error, so a surprising attachment shape can never
/// break message ingestion.
fn parse_attachments(m: &Value) -> String {
    let files = message_files(m);
    let list: Vec<Value> = files.iter().filter_map(file_to_attachment).collect();
    Value::Array(list).to_string()
}

/// Extract a message's reactions ("emotions") from its `properties` into the
/// Teams-shaped JSON array string the store and UI use:
/// `[{"key":"like","users":[{"mri":"8:...","time":<ms>}]}]`.
///
/// Returns the EMPTY string when `properties.emotions` is ABSENT — the sentinel
/// meaning "this frame carried no reaction info" (see `store::Message.reactions`),
/// so a plain edit `MessageUpdate` never clobbers an existing reaction set.
/// Returns `"[]"` when reactions are present but empty (e.g. the last reaction
/// was removed), so a genuine clear propagates. Emotions whose `users` list is
/// empty are dropped (Teams sometimes ships `{"key":"heart","users":[]}`).
///
/// `properties` and `emotions` may each be delivered as a JSON-encoded STRING
/// rather than a nested value — the same double-encoding as `properties.files` —
/// so we parse a level deeper when needed. Best-effort: a malformed shape yields
/// the sentinel (leave existing reactions untouched) rather than an error, so a
/// surprising reaction payload can never break message ingestion.
fn parse_emotions(m: &Value) -> String {
    let props = match m.get("properties") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    };
    let Some(emotions_raw) = props.get("emotions") else {
        return String::new(); // sentinel: this frame said nothing about reactions
    };
    let emotions = match emotions_raw {
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        v => v.clone(),
    };
    // The key WAS present, so "not a usable array" means "no reactions" ("[]"),
    // not the sentinel — a present-but-empty emotions clears the set.
    let Some(list) = emotions.as_array() else {
        return "[]".to_string();
    };
    let out: Vec<Value> = list
        .iter()
        .filter_map(|entry| {
            let key = entry.get("key").and_then(Value::as_str)?;
            let users: Vec<Value> = entry
                .get("users")
                .and_then(Value::as_array)
                .map(|us| {
                    us.iter()
                        .filter_map(|u| {
                            let mri = u.get("mri").and_then(Value::as_str)?;
                            let time = u.get("time").and_then(Value::as_i64).unwrap_or(0);
                            Some(serde_json::json!({ "mri": mri, "time": time }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if users.is_empty() {
                return None; // drop an emotion nobody currently reacts with
            }
            Some(serde_json::json!({ "key": key, "users": users }))
        })
        .collect();
    Value::Array(out).to_string()
}

/// Read `properties.files` as an array of file objects, transparently decoding
/// the JSON-encoded-string form of either level. Returns an empty vec when
/// absent or unparseable.
fn message_files(m: &Value) -> Vec<Value> {
    // `properties` may be an object or a JSON-encoded string.
    let props = match m.get("properties") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    };
    // `files` may itself be an array or a JSON-encoded string of an array.
    match props.get("files") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok(),
        Some(v @ Value::Array(_)) => Some(v.clone()),
        _ => None,
    }
    .as_ref()
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
}

/// Normalize one Teams file object into `{name, content_type, url, kind}`, or
/// `None` when it carries no usable URL.
fn file_to_attachment(f: &Value) -> Option<Value> {
    let first_str = |keys: &[&str]| {
        keys.iter()
            .find_map(|k| f.get(*k).and_then(Value::as_str))
            .map(str::to_string)
    };
    // Teams has used several key spellings across message shapes; accept them all.
    let url = first_str(&["objectUrl", "fileUrl", "baseUrl", "url"]).filter(|u| !u.is_empty())?;
    let name = first_str(&["title", "fileName", "name"]).unwrap_or_else(|| "attachment".to_string());
    let file_type = first_str(&["fileType", "type"]).unwrap_or_default();
    let (content_type, kind) = classify_attachment(&file_type, &name);
    Some(serde_json::json!({
        "name": name,
        "content_type": content_type,
        "url": url,
        "kind": kind,
    }))
}

/// Map a Teams file type / filename to a MIME type and a coarse kind
/// ("image" | "file"). The kind lets the UI decide whether to render a thumbnail
/// (via the media proxy) or a file chip.
fn classify_attachment(file_type: &str, name: &str) -> (String, &'static str) {
    // Prefer the explicit type; fall back to the filename extension.
    let ext = if file_type.is_empty() {
        name.rsplit('.').next().unwrap_or("")
    } else {
        file_type
    }
    .trim_start_matches('.')
    .to_ascii_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" => ("image/jpeg".into(), "image"),
        "png" => ("image/png".into(), "image"),
        "gif" => ("image/gif".into(), "image"),
        "webp" => ("image/webp".into(), "image"),
        "bmp" => ("image/bmp".into(), "image"),
        "svg" => ("image/svg+xml".into(), "image"),
        "heic" | "heif" => (format!("image/{ext}"), "image"),
        "pdf" => ("application/pdf".into(), "file"),
        "" => ("application/octet-stream".into(), "file"),
        other => (format!("application/{other}"), "file"),
    }
}

/// Extract a bare MRI ("8:orgid:<guid>", "8:<skypename>", ...) from a message's
/// `from` field, which Teams delivers either as a bare MRI or as a contacts URL
/// like ".../v1/users/ME/contacts/8:orgid:<guid>". We keep the last path segment
/// so a URL and a bare MRI for the same user compare equal.
pub(crate) fn normalize_mri(from: &str) -> String {
    from.rsplit('/').next().unwrap_or(from).to_string()
}

/// Turn a Teams message body (HTML like `<p>hello <b>world</b></p>`) into a
/// short, single-line plain-text preview for the conversation list — the same
/// role as the second line under a chat title in the Teams desktop sidebar.
///
/// Best-effort and dependency-free: strip tags, decode the handful of entities
/// Teams actually emits, collapse whitespace, and cap the length so a long
/// message can't blow up a list row. Not a general HTML sanitizer.
pub(crate) fn preview_from_html(html: &str) -> String {
    const MAX_CHARS: usize = 120;
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if in_tag => {}
            _ => text.push(c),
        }
    }
    // Decode the common entities Teams emits (order matters: &amp; last).
    let text = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#160;", " ")
        .replace("&amp;", "&");
    // Collapse any run of whitespace (incl. newlines) to a single space.
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > MAX_CHARS {
        let truncated: String = collapsed.chars().take(MAX_CHARS).collect();
        format!("{}…", truncated.trim_end())
    } else {
        collapsed
    }
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
    fn parses_last_message_preview_and_sidebar_flags() {
        // Shape mirrors the real CSA capture: lastMessage uses camelCase field
        // names, and the chat carries the sidebar state booleans.
        let v = json!({
            "chats": [{
                "id": "19:grp@thread.v2",
                "title": "Backend",
                "chatType": "group",
                "threadType": "chat",
                "isOneOnOne": false,
                "isEmptyConversation": false,
                "isRead": false,
                "isMuted": true,
                "isSticky": true,
                "hidden": false,
                "isLastMessageFromMe": false,
                "lastMessage": {
                    "id": "1784575974716",
                    "composeTime": "2026-07-16T16:05:26.767Z",
                    "content": "<p>ship it &amp; <b>relax</b></p>",
                    "imDisplayName": "Clément BOSLE",
                    "from": "8:orgid:clement",
                    "messageType": "RichText/Html"
                }
            }]
        });
        let convs = parse_conversations(&v);
        assert_eq!(convs.len(), 1);
        let c = &convs[0];
        assert_eq!(c.last_message_preview, "ship it & relax");
        assert_eq!(c.last_message_sender, "Clément BOSLE");
        assert!(!c.last_message_from_me);
        assert!(!c.is_read); // unread
        assert!(c.is_muted);
        assert!(c.is_pinned); // isSticky
        assert!(!c.is_hidden);
        assert_eq!(c.thread_type, "chat");
    }

    #[test]
    fn missing_flags_default_to_read_and_unmuted() {
        // A chat with only the minimum fields must not surface a false unread
        // marker or spurious muted/pinned/hidden state.
        let v = json!({
            "chats": [{
                "id": "19:x@thread.v2",
                "title": "Minimal",
                "chatType": "group",
                "lastMessage": { "id": "1", "composeTime": "2026-07-16T16:05:26.767Z" }
            }]
        });
        let c = &parse_conversations(&v)[0];
        assert!(c.is_read); // absent isRead -> treated as read
        assert!(!c.is_muted);
        assert!(!c.is_pinned);
        assert!(!c.is_hidden);
        assert_eq!(c.last_message_preview, ""); // no content -> empty preview
        assert_eq!(c.last_message_sender, "");
    }

    #[test]
    fn preview_from_html_strips_collapses_and_truncates() {
        // tags stripped, entities decoded, whitespace collapsed
        assert_eq!(
            preview_from_html("<p>hello&nbsp;&amp; <b>bye</b>\n  now</p>"),
            "hello & bye now"
        );
        // empty / plain passthrough
        assert_eq!(preview_from_html(""), "");
        assert_eq!(preview_from_html("just text"), "just text");
        // long content is capped with an ellipsis
        let long = format!("<p>{}</p>", "x".repeat(300));
        let out = preview_from_html(&long);
        assert!(out.chars().count() <= 121); // 120 + the ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn conversation_kind_classification() {
        let base = Conversation {
            id: "19:x@thread.v2".into(),
            title: "".into(),
            chat_type: "".into(),
            is_one_on_one: false,
            last_message_time: 0,
            is_empty: false,
            other_member_mri: "".into(),
            last_message_preview: String::new(),
            last_message_sender: String::new(),
            last_message_from_me: false,
            is_read: true,
            is_muted: false,
            is_pinned: false,
            is_hidden: false,
            thread_type: String::new(),
        };

        // explicit 1:1 flag
        let one = Conversation { is_one_on_one: true, ..base.clone() };
        assert_eq!(one.kind(), ConversationKind::OneOnOne);

        // chat type says oneOnOne even if the flag is missing
        let one2 = Conversation { chat_type: "oneOnOne".into(), ..base.clone() };
        assert_eq!(one2.kind(), ConversationKind::OneOnOne);

        // self "Notes" chat detected by the 48: id prefix, wins over other signals
        let notes = Conversation { id: "48:notes".into(), is_one_on_one: true, ..base.clone() };
        assert_eq!(notes.kind(), ConversationKind::Notes);

        // known group types
        let group = Conversation { chat_type: "group".into(), ..base.clone() };
        assert_eq!(group.kind(), ConversationKind::Group);

        // no signal at all -> Unknown (store never guesses)
        assert_eq!(base.kind(), ConversationKind::Unknown);

        // present-but-unmapped type -> Group (shows names, never hides info)
        let weird = Conversation { chat_type: "federated".into(), ..base.clone() };
        assert_eq!(weird.kind(), ConversationKind::Group);
    }

    #[test]
    fn extracts_sender_mri_from_from_field() {
        // `from` as a contacts URL -> bare MRI; imdisplayname stays the sender name.
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "hi", "imdisplayname": "Théophile WALLEZ",
            "from": "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:abc-123"
        });
        let parsed = parse_message(&m, "c1").unwrap();
        assert_eq!(parsed.sender, "Théophile WALLEZ");
        assert_eq!(parsed.sender_mri, "8:orgid:abc-123");

        // a bare MRI in `from` is kept as-is
        assert_eq!(normalize_mri("8:orgid:abc-123"), "8:orgid:abc-123");
        // a URL is reduced to its last segment
        assert_eq!(normalize_mri(".../contacts/8:orgid:xyz"), "8:orgid:xyz");
    }

    #[test]
    fn skips_control_and_system_frames() {
        // A displayable chat body is kept regardless of casing, and an absent
        // messagetype defaults to displayable (real frames always carry one).
        for mt in ["Text", "RichText", "RichText/Html", "RichText/Media_GenericFile", "richtext/html"] {
            let m = json!({
                "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
                "content": "<p>hi</p>", "imdisplayname": "Alice", "messagetype": mt
            });
            assert!(parse_message(&m, "c1").is_some(), "{mt} must be displayable");
        }
        let no_type = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "<p>hi</p>", "imdisplayname": "Alice"
        });
        assert!(parse_message(&no_type, "c1").is_some(), "absent messagetype defaults to displayable");

        // Control/system frames are dropped, whatever body they carry — the
        // typing/presence push whose content is a bare notifications endpoint URL
        // (the reported bug) and the ThreadActivity member/topic changes whose
        // content is a raw <partlist>/<addmember>/… XML frame.
        let typing = json!({
            "id": "2", "sequenceId": 2, "composetime": "2026-07-16T16:05:27.000Z",
            "messagetype": "Control/Typing",
            "content": "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:bea5de00-723a-4526-b216-4cc52ac383f9",
            "from": "8:orgid:bea5de00-723a-4526-b216-4cc52ac383f9"
        });
        assert!(parse_message(&typing, "c1").is_none(), "typing control frame must be skipped");
        for mt in ["Control/ClearTyping", "ThreadActivity/AddMember", "ThreadActivity/TopicUpdate", "Event/Call", "Signal/Flamingo"] {
            let m = json!({
                "id": "3", "sequenceId": 3, "composetime": "2026-07-16T16:05:28.000Z",
                "messagetype": mt, "content": "<partlist alt=\"\"><part/></partlist>"
            });
            assert!(parse_message(&m, "c1").is_none(), "{mt} must be skipped");
        }
    }

    #[test]
    fn control_frames_do_not_truncate_backfill_cursor() {
        // A full page whose only displayable message is the newest — the rest
        // being typing/activity frames — must still page into the past: the cursor
        // comes from the oldest RAW compose time, not the oldest surviving message.
        let v = json!({
            "messages": [
                {
                    "id": "1784217926767", "sequenceId": 9186,
                    "composetime": "2026-07-16T16:05:26.767Z",
                    "content": "<p>real</p>", "messagetype": "RichText/Html", "imdisplayname": "Alice"
                },
                {
                    "id": "typing-1", "sequenceId": 9185,
                    "composetime": "2026-07-16T15:00:00.000Z",
                    "messagetype": "Control/Typing",
                    "content": "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:x"
                }
            ]
        });
        let page = parse_message_page(&v, "19:abc@thread.v2", 2);
        assert_eq!(page.messages.len(), 1, "only the real message is stored");
        assert_eq!(page.messages[0].content, "<p>real</p>");
        // cursor = oldest RAW compose time (the typing frame's), so backfill continues
        assert_eq!(page.next_before_ms, Some(parse_iso_ms("2026-07-16T15:00:00.000Z")));
        assert!(page.has_more_older, "a full raw page must still signal more history");
    }

    #[test]
    fn message_without_properties_has_empty_attachments() {
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "<p>just text</p>", "imdisplayname": "Alice"
        });
        let parsed = parse_message(&m, "c1").unwrap();
        assert_eq!(parsed.attachments, "[]");
    }

    #[test]
    fn parses_file_attachment_from_json_encoded_properties() {
        // Teams double-encodes `properties`, and `files` inside it, as JSON strings.
        let files = r#"[{"title":"quarterly.pdf","type":"pdf","objectUrl":"https://eu-api.asm.skype.com/v1/objects/0-eu-d1/content"}]"#;
        let properties = serde_json::to_string(&json!({ "files": files })).unwrap();
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "<p>here is the report</p>", "imdisplayname": "Alice",
            "properties": properties
        });

        let parsed = parse_message(&m, "c1").unwrap();
        let attachments: Value = serde_json::from_str(&parsed.attachments).unwrap();
        let a = &attachments.as_array().unwrap()[0];
        assert_eq!(a["name"], "quarterly.pdf");
        assert_eq!(a["content_type"], "application/pdf");
        assert_eq!(a["kind"], "file");
        assert_eq!(
            a["url"],
            "https://eu-api.asm.skype.com/v1/objects/0-eu-d1/content"
        );
    }

    #[test]
    fn classifies_image_attachment_by_type() {
        // `properties` given directly as an object, `files` as a real array.
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "", "imdisplayname": "Alice",
            "properties": { "files": [
                { "title": "photo.PNG", "fileType": "png", "objectUrl": "https://eu-api.asm.skype.com/v1/objects/x/views/original" }
            ]}
        });

        let parsed = parse_message(&m, "c1").unwrap();
        let attachments: Value = serde_json::from_str(&parsed.attachments).unwrap();
        let a = &attachments.as_array().unwrap()[0];
        assert_eq!(a["kind"], "image");
        assert_eq!(a["content_type"], "image/png");
        assert_eq!(a["name"], "photo.PNG");
    }

    #[test]
    fn drops_files_without_a_usable_url() {
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "", "imdisplayname": "Alice",
            "properties": { "files": [ { "title": "broken.txt" } ] }
        });
        let parsed = parse_message(&m, "c1").unwrap();
        assert_eq!(parsed.attachments, "[]");
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

    // ---- reactions (emotions) parsing ---------------------------------------

    #[test]
    fn parse_emotions_absent_returns_sentinel() {
        // No properties at all, and properties present but without an emotions
        // key, both mean "this frame carried no reaction info" (the sentinel).
        assert_eq!(parse_emotions(&json!({ "id": "1" })), "");
        assert_eq!(parse_emotions(&json!({ "properties": { "files": "[]" } })), "");
    }

    #[test]
    fn parse_emotions_present_but_empty_clears() {
        // An empty emotions array, or one whose only key has no users, both
        // normalize to "[]" (a genuine clear), NOT the sentinel.
        assert_eq!(parse_emotions(&json!({ "properties": { "emotions": [] } })), "[]");
        assert_eq!(
            parse_emotions(&json!({ "properties": { "emotions": [ { "key": "heart", "users": [] } ] } })),
            "[]"
        );
    }

    #[test]
    fn parse_emotions_normalizes_and_drops_empty_keys() {
        let m = json!({ "properties": { "emotions": [
            { "key": "heart", "users": [] },
            { "key": "like", "users": [
                { "mri": "8:orgid:a", "time": 111, "value": "111" },
                { "mri": "8:orgid:b", "time": 222 }
            ] }
        ] } });
        let parsed: Value = serde_json::from_str(&parse_emotions(&m)).unwrap();
        let arr = parsed.as_array().unwrap();
        assert_eq!(arr.len(), 1, "the users-less 'heart' key is dropped");
        assert_eq!(arr[0]["key"], "like");
        assert_eq!(arr[0]["users"].as_array().unwrap().len(), 2);
        assert_eq!(arr[0]["users"][0]["mri"], "8:orgid:a");
        assert_eq!(arr[0]["users"][0]["time"], 111);
        // only mri + time are carried; Teams' "value" string is dropped
        assert!(arr[0]["users"][0].get("value").is_none());
    }

    #[test]
    fn parse_emotions_decodes_json_encoded_properties() {
        // Teams sometimes double-encodes `properties` as a JSON string.
        let m = json!({
            "properties": "{\"emotions\":[{\"key\":\"laugh\",\"users\":[{\"mri\":\"8:x\",\"time\":9}]}]}"
        });
        let parsed: Value = serde_json::from_str(&parse_emotions(&m)).unwrap();
        assert_eq!(parsed[0]["key"], "laugh");
        assert_eq!(parsed[0]["users"][0]["mri"], "8:x");
    }

    #[test]
    fn parse_message_carries_reactions() {
        let m = json!({
            "id": "m1", "messagetype": "RichText/Html", "content": "hi",
            "sequenceId": 5, "composetime": "2026-07-16T15:43:03.240Z",
            "imdisplayname": "Bob", "from": "8:orgid:bob",
            "properties": { "emotions": [ { "key": "like", "users": [ { "mri": "8:orgid:a", "time": 1 } ] } ] }
        });
        let parsed = parse_message(&m, "c1").unwrap();
        let reactions: Value = serde_json::from_str(&parsed.reactions).unwrap();
        assert_eq!(reactions[0]["key"], "like");
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
                sender_mri: String::new(),
                content: "c".into(),
                attachments: "[]".into(),
                reactions: "[]".into(),
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

    fn conv(id: &str, title: &str, last_message_time: i64) -> Conversation {
        Conversation {
            id: id.into(),
            title: title.into(),
            chat_type: "group".into(),
            is_one_on_one: false,
            last_message_time,
            is_empty: false,
            other_member_mri: String::new(),
            last_message_preview: String::new(),
            last_message_sender: String::new(),
            last_message_from_me: false,
            is_read: true,
            is_muted: false,
            is_pinned: false,
            is_hidden: false,
            thread_type: "group".into(),
        }
    }

    // Regression for the conversation-list freeze: syncing the SAME conversations
    // twice must report 0 changes the second time. persist_conversations is what
    // gates the `conversations_changed` event; if it counted every upsert (not
    // just real changes), the event would fire on every sync and the UI's
    // refresh -> sync -> event -> refresh loop would amplify until the TUI froze.
    #[test]
    fn persist_conversations_counts_only_real_changes() {
        let store = Store::open_in_memory().unwrap();
        let convs = vec![conv("a", "Alpha", 100), conv("b", "Bravo", 200)];

        // first sync inserts both -> two changes
        assert_eq!(persist_conversations(&store, &convs), 2);
        // an identical re-sync changes nothing -> no `conversations_changed`
        assert_eq!(persist_conversations(&store, &convs), 0);
        // only a genuinely newer conversation counts
        let bumped = vec![conv("a", "Alpha", 100), conv("b", "Bravo", 300)];
        assert_eq!(persist_conversations(&store, &bumped), 1);
        assert_eq!(persist_conversations(&store, &bumped), 0);
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

    #[test]
    fn empty_backfill_marks_history_complete() {
        let store = Store::open_in_memory().unwrap();
        store.upsert_conversation("c1", "Chat", 0).unwrap();
        persist_page(&store, "c1", &page(&[100], 5000, true)).unwrap();

        let empty = MessagePage {
            messages: Vec::new(),
            next_before_ms: None,
            has_more_older: false,
        };
        persist_backfill_page(&store, "c1", &empty).unwrap();

        assert_eq!(store.oldest_cursor("c1").unwrap(), (Some("5000".into()), false));
    }
}

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
use serde_json::{json, Value};

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

/// True when a thread id belongs to a team channel. Teams routes channel posts
/// through `@thread.tacv2` threads, distinct from group chats (`@thread.v2`),
/// 1:1s (`@unq.gbl.spaces`) and system threads (`48:*`). This is the single
/// discriminant the live-message path uses to keep a channel post out of the
/// chat sidebar (see the trouter loop in the server).
///
/// A channel post / deep link appends a `;messageid=<root>` suffix to the thread
/// id (e.g. `19:...@thread.tacv2;messageid=123`), so we match the thread-id part
/// before any `;` — a bare `ends_with("@thread.tacv2")` misses that form and lets
/// a per-post channel thread leak into the chat list.
pub fn is_channel_thread_id(id: &str) -> bool {
    id.split(';').next().unwrap_or(id).ends_with("@thread.tacv2")
}

/// One team surfaced by the CSA aggregator, with its channels. Teams are the
/// top level of the channel tree the sidebar renders (team → channels), exactly
/// like the Microsoft Teams desktop app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Team {
    pub id: String,
    pub display_name: String,
    /// The AAD group id (a bare GUID) backing this team, from CSA
    /// `teamSiteInformation.groupId`. This — NOT the team thread id — is what the
    /// profile-picture endpoint accepts for a team photo. Empty when CSA omits it.
    pub group_id: String,
    pub channels: Vec<Channel>,
}

/// One channel within a team. A channel is a distinct thread (`@thread.tacv2`)
/// whose messages reuse the SAME message pipeline as chats — only the sidebar
/// grouping (under its team) and the chat/channel separation differ. The
/// last-message fields mirror [`Conversation`] so the channel list renders a
/// faithful preview line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel {
    pub id: String,
    /// The parent team's id (its General channel / team thread id).
    pub team_id: String,
    /// The parent team's display name, denormalized so the sidebar can group and
    /// label channels without a second lookup.
    pub team_name: String,
    /// The parent team's AAD group id (bare GUID), denormalized so a channel row
    /// can request its team's photo without walking back up to the team. Empty
    /// when CSA omits it; the UI then falls back to a tinted `#` glyph.
    pub team_group_id: String,
    pub display_name: String,
    /// True for the team's General channel (its id equals the team id, or CSA
    /// flags it `isGeneral`). The UI sorts General first within a team.
    pub is_general: bool,
    /// True when the user favorited/followed the channel (`isFavorite`).
    pub is_favorite: bool,
    /// Compose time (epoch ms) of the last message, for sort order. 0 if unknown/empty.
    pub last_message_time: i64,
    /// True when the channel has never had a (displayable) message.
    pub is_empty: bool,
    pub last_message_preview: String,
    pub last_message_sender: String,
    pub last_message_from_me: bool,
    /// False when the channel has unread messages. Drives the unread marker.
    pub is_read: bool,
}

/// The last-message fields common to a CSA chat and a CSA channel: both carry a
/// `lastMessage` sub-object with the SAME camelCase shape (`imDisplayName`,
/// `composeTime`, `messageType`, `content`). Parsed once here so chats and
/// channels build an identical, gate-consistent preview line.
struct LastMessage {
    time: i64,
    /// Whether the container has a real last message (`lastMessage.id` present).
    /// The caller ORs this with any container-specific empty flag.
    has_message: bool,
    preview: String,
    sender: String,
}

/// Parse the shared `lastMessage` sub-object of a CSA chat or channel container.
///
/// The preview mirrors the message-history display gate so a system frame
/// (typing/presence, a member/topic change) never leaks its raw machine XML into
/// the sidebar; a call event gets a short human label instead of being blanked.
fn parse_last_message(container: &Value) -> LastMessage {
    let has_message = container.pointer("/lastMessage/id").and_then(|x| x.as_str()).is_some();
    let time = container
        .pointer("/lastMessage/composeTime")
        .and_then(|x| x.as_str())
        .map(parse_iso_ms)
        .unwrap_or(0);
    let content = container.pointer("/lastMessage/content").and_then(|x| x.as_str()).unwrap_or("");
    let message_type = container.pointer("/lastMessage/messageType").and_then(|x| x.as_str()).unwrap_or("");
    let preview = if let Some(event) = parse_call_event(message_type, content) {
        call_event_label(&event).to_string()
    } else if let Some(recording) = parse_call_recording(message_type, content) {
        // A meeting recording previews as a clean event-style label (like a call),
        // never the raw URIObject text (which would leak the stray "Play" link);
        // an in-progress notice shows nothing.
        match recording {
            CallRecording::Ready(_) => "Meeting recording".to_string(),
            CallRecording::Pending => String::new(),
        }
    } else if is_displayable_message_type(message_type) && !is_system_frame_content(content) {
        preview_from_html(content)
    } else {
        String::new()
    };
    let sender = container
        .pointer("/lastMessage/imDisplayName")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .or_else(|| container.pointer("/lastMessage/fromDisplayNameInToken").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();
    LastMessage { time, has_message, preview, sender }
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

/// Fetch the full conversation list AND the team/channel tree from the CSA
/// aggregator in a SINGLE request. The `users/me` payload carries both `chats`
/// and `teams`, so parsing both here keeps chats and channels perfectly in sync
/// (one snapshot, one round-trip) and never double-fetches.
///
/// `csa_token` must be an access token for [`CSA_SCOPE`]; the aggregator 401s on
/// the ic3 token. Best-effort: malformed items are skipped rather than failing
/// the whole sync.
pub async fn fetch_csa(
    http: &reqwest::Client,
    session: &Session,
    csa_token: &str,
) -> Result<(Vec<Conversation>, Vec<Team>)> {
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
    let convs = parse_conversations_with_self(&v, &session.self_mri);
    let teams = parse_teams_with_self(&v, &session.self_mri);
    Ok((convs, teams))
}

/// Fetch just the conversation list from the CSA aggregator. Thin wrapper over
/// [`fetch_csa`] for callers that don't need the channel tree.
///
/// Returns conversations best-effort: malformed items are skipped rather than
/// failing the whole sync.
pub async fn fetch_conversations(
    http: &reqwest::Client,
    session: &Session,
    csa_token: &str,
) -> Result<Vec<Conversation>> {
    Ok(fetch_csa(http, session, csa_token).await?.0)
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
///
/// The whole list is written as ONE transaction. A CSA sync touches every
/// conversation the user has, and committing per row made the first sync of a
/// 600-conversation account spend 2.2 s in the write path (27 ms batched).
pub fn persist_conversations(store: &Store, convs: &[Conversation]) -> usize {
    store
        .transaction(|| Ok(upsert_conversations(store, convs)))
        .unwrap_or_else(|e| {
            eprintln!("[sync] conversations not persisted: {e}");
            0
        })
}

fn upsert_conversations(store: &Store, convs: &[Conversation]) -> usize {
    let mut changed = 0;
    for c in convs {
        if c.is_empty {
            continue;
        }
        // Activity streams (`48:notifications`, `48:mentions`, `48:threads`, …)
        // are system feeds, not chats — keep them out of the conversation list
        // entirely (they are surfaced in the notifications panel's tabs).
        if crate::teams_activity::is_system_feed_thread(&c.id) {
            continue;
        }
        // A team channel (incl. its `;messageid=` post threads) is not a chat —
        // never write it into the conversations table. The read-time filter in
        // `Store::conversations` also gates on this, but skipping the write keeps
        // channel rows out of the table entirely so they can't accumulate.
        if is_channel_thread_id(&c.id) {
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

/// Persist a fetched team/channel tree into the store (pure/sync, no `.await`).
///
/// Empty channels are skipped so the list only shows channels that actually have
/// content, matching the chat path. Also HEALS a channel that a prior live
/// message leaked into the `conversations` table before we knew it was a channel:
/// its conversation row is deleted (its messages are kept — the message pipeline
/// is shared by id), so it can never appear in both the Chats and Channels lists.
///
/// Returns `(channels_changed, healed_leaks)`: the first is how many channel rows
/// were inserted/updated (gates `channels_changed`), the second how many leaked
/// conversation rows were removed (gates a `conversations_changed`, since the
/// chat list shrank). Both converge to 0 on a steady re-sync, so a repeated sync
/// of identical data emits no further change events.
///
/// Written as ONE transaction, for the same reason as [`persist_conversations`].
pub fn persist_channels(store: &Store, teams: &[Team]) -> (usize, usize) {
    store
        .transaction(|| Ok(upsert_channels(store, teams)))
        .unwrap_or_else(|e| {
            eprintln!("[sync] channels not persisted: {e}");
            (0, 0)
        })
}

fn upsert_channels(store: &Store, teams: &[Team]) -> (usize, usize) {
    let mut changed = 0;
    let mut healed = 0;
    // `team_pos`/`channel_pos` are the array indices, capturing the user's own
    // team/channel order as Microsoft Teams reports it (skipped empty channels
    // leave gaps, which is harmless — only the relative order is used for sorting).
    for (team_idx, team) in teams.iter().enumerate() {
        for (chan_idx, c) in team.channels.iter().enumerate() {
            if c.is_empty {
                continue;
            }
            // A channel post that arrived live before this sync may have created a
            // conversation row (the trouter loop upserts by id). Remove that row so
            // the channel lives only in the channels table; its messages stay.
            if store.delete_conversation_row(&c.id).unwrap_or(false) {
                healed += 1;
            }
            let update = crate::store::ChannelUpdate {
                id: &c.id,
                team_id: &c.team_id,
                team_name: &c.team_name,
                team_group_id: &c.team_group_id,
                display_name: &c.display_name,
                is_general: c.is_general,
                is_favorite: c.is_favorite,
                last_message_time: c.last_message_time,
                last_message_preview: &c.last_message_preview,
                last_message_sender: &c.last_message_sender,
                last_message_from_me: c.last_message_from_me,
                is_read: c.is_read,
                team_pos: team_idx as i64,
                channel_pos: chan_idx as i64,
            };
            if store.upsert_channel_full(&update).unwrap_or(false) {
                changed += 1;
            }
        }
    }
    (changed, healed)
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
///
/// The page and its cursor land in ONE transaction, so a page is either fully
/// persisted or not at all — and a 50-message page costs one commit instead of up
/// to 200 (184 ms of fsync under autocommit, 1.6 ms batched).
pub fn persist_page(store: &Store, conversation_id: &str, page: &MessagePage) -> Result<usize> {
    store.transaction(|| persist_page_rows(store, conversation_id, page))
}

fn persist_page_rows(store: &Store, conversation_id: &str, page: &MessagePage) -> Result<usize> {
    let mut inserted = 0;
    for m in &page.messages {
        let new_row = store.insert_message(m)?;
        if new_row {
            inserted += 1;
        } else {
            // Existing row (INSERT skipped it): heal a legacy row that was
            // stored before we captured the sender MRI or the message's mentions.
            store.backfill_sender_mri(&m.conversation_id, &m.id, &m.sender_mri)?;
            store.backfill_mentions(&m.conversation_id, &m.id, &m.mentions)?;
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

        // Sidebar state, straight from the chat object (see the CSA capture spike).
        // NB: the `lastMessage` sub-object uses camelCase field names
        // (`imDisplayName`, `composeTime`, `messageType`) — NOT the lowercase names
        // the chatService messages endpoint uses; `parse_last_message` handles it.
        let lm = parse_last_message(chat);
        let is_empty = chat.get("isEmptyConversation").and_then(|x| x.as_bool()).unwrap_or(false)
            || !lm.has_message;
        let last_message_time = lm.time;
        let last_message_preview = lm.preview;
        let last_message_sender = lm.sender;
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

#[cfg(test)]
fn parse_teams(v: &Value) -> Vec<Team> {
    parse_teams_with_self(v, "")
}

/// Parse the CSA `teams` array into the team → channel tree the sidebar renders.
///
/// The shape is tolerant by design — CSA has shipped several spellings for a
/// team/channel display name (`displayName`, `name`, `title`) and marks the
/// General channel either with an explicit `isGeneral` flag or by giving it the
/// same id as the team. `self_mri` is currently unused for channels (their
/// last-message sender comes straight from `imDisplayName`) but is threaded
/// through for symmetry with [`parse_conversations_with_self`] and future use.
///
/// Best-effort: a team or channel without an id is skipped rather than failing
/// the whole sync.
fn parse_teams_with_self(v: &Value, _self_mri: &str) -> Vec<Team> {
    let name_of = |o: &Value| -> String {
        ["displayName", "name", "title"]
            .iter()
            .find_map(|k| o.get(*k).and_then(|x| x.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string()
    };

    let mut out = Vec::new();
    for team in v.get("teams").and_then(|t| t.as_array()).into_iter().flatten() {
        let team_id = team
            .get("id")
            .or_else(|| team.get("teamId"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if team_id.is_empty() {
            continue;
        }
        let team_name = name_of(team);
        // The AAD group id backing this team — the only id the team-photo endpoint
        // accepts. It lives under `teamSiteInformation.groupId`; a couple of
        // fallbacks cover payload variants seen across tenants.
        // Extract the string at each level *before* falling back, so a present-
        // but-null or non-string `teamSiteInformation.groupId` still falls through
        // to the alternatives rather than short-circuiting the chain to empty.
        let group_id = team
            .get("teamSiteInformation")
            .and_then(|s| s.get("groupId"))
            .and_then(|x| x.as_str())
            .or_else(|| team.get("groupId").and_then(|x| x.as_str()))
            .or_else(|| team.get("aadGroupId").and_then(|x| x.as_str()))
            .unwrap_or("")
            .to_string();

        let mut channels = Vec::new();
        for ch in team.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
            let Some(id) = ch.get("id").and_then(|x| x.as_str()) else { continue };
            let is_general = ch.get("isGeneral").and_then(|x| x.as_bool()).unwrap_or(false)
                || id == team_id;
            let is_favorite = ch.get("isFavorite").and_then(|x| x.as_bool()).unwrap_or(false);
            let lm = parse_last_message(ch);
            channels.push(Channel {
                id: id.to_string(),
                team_id: team_id.to_string(),
                team_name: team_name.clone(),
                team_group_id: group_id.clone(),
                display_name: name_of(ch),
                is_general,
                is_favorite,
                last_message_time: lm.time,
                is_empty: !lm.has_message,
                last_message_preview: lm.preview,
                last_message_sender: lm.sender,
                last_message_from_me: ch.get("isLastMessageFromMe").and_then(|x| x.as_bool()).unwrap_or(false),
                // `isRead` absent -> assume read, so a partial payload never floods
                // the UI with false unread markers (mirrors the chat path).
                is_read: ch.get("isRead").and_then(|x| x.as_bool()).unwrap_or(true),
            });
        }

        out.push(Team { id: team_id.to_string(), display_name: team_name, group_id, channels });
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
/// [`is_system_frame_content`] backstops that default so an untyped system frame
/// (e.g. a call event) still cannot render as a chat bubble.
fn is_displayable_message_type(messagetype: &str) -> bool {
    let t = messagetype.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("Text") {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    lower == "richtext" || lower.starts_with("richtext/")
}

/// True when a message BODY is an unambiguous machine/system frame that must
/// never render as a chat bubble AND carries nothing worth surfacing, so it is
/// dropped outright — regardless of its `messagetype`.
///
/// This backstops [`is_displayable_message_type`]: its empty-messagetype→show
/// default would otherwise let such a frame through as garbage if one ever
/// arrives without a type. The recognised shapes are a raw participant roster
/// (`<partlist>`) and a `<meetingpolicyupdated>` thread-activity frame.
///
/// Call/meeting events are handled EARLIER by [`parse_call_event`], which turns
/// them into a structured `system_event` the UI renders as a centered line — they
/// never reach this check. A real chat body never matches either: `RichText/Html`
/// begins with text or a standard HTML tag (`<p>`, `<div>`, `<blockquote>`, `<h1>`…)
/// and a media/card body is a `<URIObject>`. Kept deliberately narrow so it can
/// only ever hit genuine throwaway system frames.
fn is_system_frame_content(content: &str) -> bool {
    let c = content.trim_start().to_ascii_lowercase();
    ["<partlist", "<meetingpolicyupdated"].iter().any(|root| c.starts_with(root))
}

/// True when a message body is the JSON call marker Teams posts into a meeting
/// chat (`19:meeting_…@thread.v2`) when a call starts there, e.g.
/// `{\"callId\":\"…\",\"meetingOrganizerId\":\"…\",\"iCalUid\":\"…\",…}`. Its quotes are
/// typically backslash-escaped on the wire, so recognition matches the bare key
/// substrings (which survive either escaping) rather than parsing the JSON. Both
/// `callId` and `meetingOrganizerId` are required so an unrelated JSON body cannot
/// match, and the body must be a JSON object (`{`). Unlike the XML
/// `<callEventType>` frame this carries no start/end, duration, or participant
/// detail — [`parse_call_event`] turns it into a plain "Call started" line.
fn is_meeting_call_json(content: &str) -> bool {
    content.starts_with('{') && content.contains("callId") && content.contains("meetingOrganizerId")
}

/// Parse a Teams call/meeting frame into the structured `system_event` payload the
/// UI renders as a centered line, or `None` when the frame is not a call event.
///
/// Two body shapes are recognised:
///
/// 1. The `Event/Call` XML frame — recognised by its `messagetype` (`Event/Call`)
///    or, when that is absent/mis-reported (e.g. a legacy stored row, where
///    `messagetype` is passed as `""`), by its body shape: a `<callEventType>`
///    element or a leading `<ended>`/`<started>` marker. It looks like:
///    `<ended/><partlist count="5"><part><displayName>…</displayName><duration>600</duration></part>…</partlist>…<callEventType>callEnded</callEventType>`
///    and yields the event type, longest duration, and participant roster.
///
/// 2. The meeting-thread JSON call marker (see [`is_meeting_call_json`]) — the
///    `{…"callId"…"meetingOrganizerId"…}` blob Teams posts into a meeting chat
///    when a call starts there. It carries no start/end/duration/roster detail, so
///    it always presents as a bare "Call started" line and is flagged `meeting` so
///    the live path never rings for it (see `call_event_json` in `server.rs`).
///
/// Returns a JSON object:
/// `{"kind":"call","event":"ended|missed|started","duration_seconds":<max part duration>,"participant_count":<n>,"participants":["…"],"meeting"?:true}`.
/// A bare `<partlist>` roster (no call marker) is NOT a call event — it returns
/// `None` and is dropped by [`is_system_frame_content`] instead.
pub(crate) fn parse_call_event(messagetype: &str, content: &str) -> Option<Value> {
    let trimmed = content.trim_start();

    // Shape 2 (the meeting-thread JSON marker) starts with `{`, so it can never
    // collide with the `<…>` XML shape below. It carries nothing to extract, so
    // return the fixed "started" event straight away.
    if is_meeting_call_json(trimmed) {
        return Some(serde_json::json!({
            "kind": "call",
            "event": "started",
            "duration_seconds": 0,
            "participant_count": 0,
            "participants": [],
            "participant_mris": [],
            "meeting": true,
        }));
    }

    let lower = trimmed.to_ascii_lowercase();
    let is_call = messagetype.eq_ignore_ascii_case("Event/Call")
        || lower.contains("<calleventtype>")
        || lower.starts_with("<ended")
        || lower.starts_with("<started");
    if !is_call {
        return None;
    }

    let event = match xml_first_value(content, "callEventType") {
        Some(v) if v.eq_ignore_ascii_case("callMissed") => "missed",
        Some(v) if v.eq_ignore_ascii_case("callStarted") => "started",
        // callEnded, and any unknown call-event type, present as "ended".
        Some(_) => "ended",
        // No explicit type: infer from the leading marker.
        None if lower.starts_with("<started") => "started",
        None => "ended",
    };

    // Each `<part>` is a participant: its `<displayName>` paired with its
    // `identity` MRI (used to fetch a real profile photo, empty when absent).
    let people = call_participants(content);
    let participants: Vec<String> = people.iter().map(|(name, _)| name.clone()).collect();
    let participant_mris: Vec<String> = people.iter().map(|(_, mri)| mri.clone()).collect();
    // Call length ≈ the longest participant duration (seconds).
    let duration_seconds = xml_values(content, "duration")
        .iter()
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .max()
        .unwrap_or(0);

    Some(serde_json::json!({
        "kind": "call",
        "event": event,
        "duration_seconds": duration_seconds,
        "participant_count": participants.len(),
        "participants": participants,
        // Aligned index-for-index with `participants`; empty string where a part
        // carries no identity, so the UI can zip them and fall back per-slot.
        "participant_mris": participant_mris,
    }))
}

/// Each participant in a call `<partlist>`, as `(display name, identity MRI)`.
/// The MRI comes from the part's `identity="…"` attribute (e.g. `8:orgid:<guid>`,
/// directly usable as a `user` avatar id) and is empty when the part carries none
/// (an anonymous or PSTN leg), so the UI falls back to a generated avatar. Names
/// are entity-decoded and trimmed; a part with an empty name is dropped, keeping
/// the name/MRI arrays the UI zips index-aligned.
///
/// Walks `<part …>` elements directly — rather than flat-scanning `<displayName>`
/// — so each name pairs with the identity from its *own* opening tag. `<partlist>`
/// (which also begins with `<part`) is skipped: the char after `part` is a letter,
/// not a tag delimiter.
fn call_participants(content: &str) -> Vec<(String, String)> {
    let hay = content.to_ascii_lowercase();
    let bytes = hay.as_bytes();
    // Byte offsets where a genuine `<part` element opens.
    let mut starts = Vec::new();
    let mut i = 0usize;
    while let Some(o) = hay[i..].find("<part") {
        let pos = i + o;
        if matches!(
            bytes.get(pos + 5),
            Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/')
        ) {
            starts.push(pos);
        }
        i = pos + 5;
    }

    let mut out = Vec::new();
    for (idx, &start) in starts.iter().enumerate() {
        // This part's slice runs until the next part opens (or the frame ends).
        let end = starts.get(idx + 1).copied().unwrap_or(content.len());
        let block = &content[start..end];
        let name = xml_first_value(block, "displayName")
            .map(|s| preview_from_html(&s))
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        // `identity` lives only in the opening `<part …>` tag; bound the search to
        // it so nothing downstream in the slice can be mistaken for an attribute.
        let open_end = block.find('>').map(|g| g + 1).unwrap_or(block.len());
        let mri = xml_attr(&block[..open_end], "identity").unwrap_or_default();
        out.push((name, mri));
    }
    out
}

/// The value of a double-quoted attribute (`name="value"`) in an XML opening tag,
/// or `None`. Minimal: finds the first case-insensitive `name="` and reads to the
/// next `"`. Sufficient for the `identity` attribute on a call `<part>`.
fn xml_attr(tag: &str, name: &str) -> Option<String> {
    let hay = tag.to_ascii_lowercase();
    let needle = format!("{}=\"", name.to_ascii_lowercase());
    let at = hay.find(&needle)?;
    let start = at + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Collect the inner text of every `<tag>…</tag>` occurrence in `xml`, matched
/// case-insensitively. A minimal, dependency-free extractor for the handful of
/// simple, non-nested elements a Teams call frame carries (`displayName`,
/// `duration`, `callEventType`). Not a general XML parser.
///
/// Byte indices from the lowercased haystack map 1:1 onto `xml` because
/// ASCII-lowercasing preserves length and never touches multi-byte UTF-8, and the
/// slice boundaries fall on single-byte `<`/`>` delimiters.
fn xml_values(xml: &str, tag: &str) -> Vec<String> {
    let hay = xml.to_ascii_lowercase();
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(o) = hay[i..].find(&open) {
        let start = i + o + open.len();
        let Some(c) = hay[start..].find(&close) else { break };
        let end = start + c;
        out.push(xml[start..end].to_string());
        i = end + close.len();
    }
    out
}

/// The inner text of the FIRST `<tag>…</tag>` occurrence, or `None`.
fn xml_first_value(xml: &str, tag: &str) -> Option<String> {
    xml_values(xml, tag).into_iter().next()
}

/// A short, English sidebar label for a parsed call event (see [`parse_call_event`]).
/// The in-thread line adds duration/participants; the sidebar stays terse.
fn call_event_label(event: &Value) -> &'static str {
    match event.get("event").and_then(Value::as_str) {
        Some("missed") => "Missed call",
        Some("started") => "Call started",
        _ => "Call ended",
    }
}

/// Outcome of inspecting a message body for a Teams meeting-recording notice — a
/// `<URIObject type="Video.2/CallRecording.1">`. Teams posts one such frame each
/// time the recording changes state, but only the final, stored one is playable.
pub(crate) enum CallRecording {
    /// The recording is still being produced (`RecordingStatus` is `Initial` or
    /// `ChunkFinished`) so it carries no playable link yet — dropped as noise.
    Pending,
    /// The recording finished (`RecordingStatus` `Success`): a synthetic
    /// `{name, content_type, url, kind:"recording", thumbnail_url, duration_seconds}`
    /// attachment, ready for the UI to frame as a video card.
    Ready(Value),
}

/// Recognise a meeting-recording notice and, when the recording is ready, turn it
/// into a media attachment. Returns `None` for any body that is NOT a recording
/// URIObject, so the caller can handle it as a normal message.
///
/// Teams posts a `<URIObject type="Video.2/CallRecording.1">` into a meeting/call
/// chat as the recording progresses — `RecordingStatus` walks `Initial` →
/// `ChunkFinished` → `Success`. Only `Success` carries a real `<a href>` (the
/// SharePoint/OneDrive video the "Play" button opens), a poster thumbnail, and a
/// duration; the earlier states are noise and map to [`CallRecording::Pending`].
/// A `Success` that somehow lacks a usable link is also treated as pending — a
/// linkless card is worse than nothing.
///
/// The attachment mirrors [`file_to_attachment`]'s shape plus a `thumbnail_url`
/// (a Teams AMS poster, loaded through the media proxy) and `duration_seconds`,
/// tagged `kind:"recording"` so the UI frames it as a video card rather than a
/// plain image or file. Detection is by body shape (not `messagetype`), matching
/// how [`parse_call_event`] recognises a call frame, so it works on live frames,
/// history rows, and the legacy-row migration alike.
pub(crate) fn parse_call_recording(_messagetype: &str, content: &str) -> Option<CallRecording> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("<URIObject") || !trimmed.contains("CallRecording") {
        return None;
    }
    // Only the final, stored recording is playable; earlier states carry no link.
    let ready = xml_attr(trimmed, "status")
        .map(|s| s.eq_ignore_ascii_case("Success"))
        .unwrap_or(false);
    if !ready {
        return Some(CallRecording::Pending);
    }
    let Some(url) = recording_play_url(trimmed) else {
        return Some(CallRecording::Pending);
    };
    let title = xml_first_value(trimmed, "Title")
        .map(|s| preview_from_html(&s))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Meeting recording".to_string());
    let thumbnail = xml_attr(trimmed, "url_thumbnail").unwrap_or_default();
    let duration_seconds = xml_attr(trimmed, "duration")
        .map(|d| parse_hms_to_seconds(&d))
        .unwrap_or(0);
    Some(CallRecording::Ready(serde_json::json!({
        "name": title,
        "content_type": "video/mp4",
        "url": url,
        "kind": "recording",
        "thumbnail_url": thumbnail,
        "duration_seconds": duration_seconds,
    })))
}

/// The playable URL for a finished recording: the `<a href>` Teams renders as the
/// "Play" button (a SharePoint/OneDrive video viewer), falling back to the
/// `onedriveForBusinessVideo` media item. `None` when neither is a usable
/// `http(s)` URL. Only `https` SharePoint viewer URLs are expected; we keep the
/// check to `http(s)` so a malformed frame can't smuggle in another scheme.
fn recording_play_url(content: &str) -> Option<String> {
    let is_http = |u: &str| u.starts_with("https://") || u.starts_with("http://");
    if let Some(href) = xml_attr(content, "href").filter(|u| is_http(u)) {
        return Some(href);
    }
    // Fallback: the OneDrive/SharePoint video item, whose `uri` sits in the same
    // `<item type="onedriveForBusinessVideo" uri="…">` opening tag.
    let idx = content.find("onedriveForBusinessVideo")?;
    let tag = &content[idx..];
    let end = tag.find('>').map(|g| g + 1).unwrap_or(tag.len());
    xml_attr(&tag[..end], "uri").filter(|u| is_http(u))
}

/// Parse a Teams recording `duration` attribute ("H:MM:SS[.frac]" or "MM:SS")
/// into whole seconds; `0` when it is absent, zero, or unparseable. The
/// fractional part (e.g. `03.92`) is discarded — the UI shows whole minutes.
fn parse_hms_to_seconds(s: &str) -> i64 {
    let whole = |x: &str| x.split('.').next().unwrap_or("").trim().parse::<i64>().ok();
    let parts: Vec<&str> = s.trim().split(':').collect();
    match parts.as_slice() {
        [h, m, sec] => match (whole(h), whole(m), whole(sec)) {
            (Some(h), Some(m), Some(sec)) => h * 3600 + m * 60 + sec,
            _ => 0,
        },
        [m, sec] => match (whole(m), whole(sec)) {
            (Some(m), Some(sec)) => m * 60 + sec,
            _ => 0,
        },
        _ => 0,
    }
}

/// Parse a single message resource (shared by the read API and trouter events —
/// both deliver the same message shape). `conversation_id` is passed in because
/// the read API groups by conversation; for a live event, derive it from the
/// resource's `conversationid`/`conversationLink` before calling.
pub(crate) fn parse_message(m: &Value, conversation_id: &str) -> Option<Message> {
    let id = m.get("id").and_then(|x| x.as_str())?.to_string();
    let messagetype = m
        .get("messagetype")
        .or_else(|| m.get("messageType"))
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let content = m.get("content").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let deleted = is_deleted(m);
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

    // A call/meeting event becomes a structured system message (rendered as a
    // centered line), NOT a chat bubble — so it is recognised before the
    // messagetype gate that would otherwise drop `Event/*`.
    if let Some(event) = parse_call_event(messagetype, &content) {
        return Some(Message {
            id,
            conversation_id: conversation_id.to_string(),
            seq,
            compose_time,
            sender,
            sender_mri,
            content: String::new(),
            attachments: "[]".to_string(),
            reactions: String::new(),
            system_event: event.to_string(),
            thread_root_id: String::new(),
            thread_subject: String::new(),
            deleted: false,
            mentions: "[]".to_string(),
        });
    }

    // A meeting-recording notice becomes a media message (a video card), not a
    // chat bubble of raw `<URIObject>` XML. Teams posts one each time the
    // recording changes state; only the final, playable one is surfaced, and the
    // in-progress notices are dropped as noise. Recognised by body shape before
    // the messagetype gate below (which would otherwise let it through as a
    // `RichText/*` bubble). The `from` on these frames is a bare contacts-endpoint
    // URL and `imdisplayname` is empty, so `sender` is blanked rather than left as
    // that URL — the card is self-describing and needs no author line.
    match parse_call_recording(messagetype, &content) {
        Some(CallRecording::Ready(attachment)) => {
            let (thread_root_id, thread_subject) = parse_thread(m);
            return Some(Message {
                id,
                conversation_id: conversation_id.to_string(),
                seq,
                compose_time,
                sender: String::new(),
                sender_mri,
                content: String::new(),
                attachments: Value::Array(vec![attachment]).to_string(),
                reactions: parse_emotions(m),
                system_event: String::new(),
                thread_root_id,
                thread_subject,
                deleted: false,
                mentions: "[]".to_string(),
            });
        }
        Some(CallRecording::Pending) => return None,
        None => {}
    }

    // Otherwise keep only user-visible chat bodies. Teams multiplexes control/
    // system frames (typing/presence, member & topic changes) onto the SAME
    // message channel — notably as live `NewMessage` resources — so gate on
    // `messagetype`, with a content backstop for a system frame that arrives
    // untyped (see `is_system_frame_content`). A DELETION frame is exempt from
    // both gates: it carries a `deletetime`, an empty body (never a system-frame
    // shape), and a `messagetype` we don't want to depend on — dropping it would
    // leave the previously-visible bubble stranded, so it must always reach the
    // store to flip the `deleted` flag on the existing row.
    if !deleted {
        if !is_displayable_message_type(messagetype) {
            return None;
        }
        if is_system_frame_content(&content) {
            return None;
        }
    }
    let (thread_root_id, thread_subject) = parse_thread(m);
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
        system_event: String::new(),
        thread_root_id,
        thread_subject,
        deleted,
        mentions: parse_mentions(m),
    })
}

/// Whether a message resource represents a message the sender has DELETED. Teams
/// marks a deletion by setting `properties.deletetime` (an epoch-ms timestamp)
/// and blanking the body — the `messagetype` is otherwise unchanged. `properties`
/// may arrive as a nested object OR a JSON-encoded string (the same double
/// encoding as `files`/`emotions`/`subject`), so decode a level deeper when
/// needed. Best-effort: a surprising shape reads as "not deleted" rather than
/// erroring, so it can never break message ingestion.
fn is_deleted(m: &Value) -> bool {
    let props = match m.get("properties") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    };
    match props.get("deletetime") {
        Some(Value::String(s)) => !s.is_empty() && s != "0",
        Some(Value::Number(n)) => n.as_i64().map(|v| v > 0).unwrap_or(false),
        _ => false,
    }
}

/// Extract the channel-thread linkage from a message resource: the thread ROOT's
/// message id and (only on the root itself) its subject/title.
///
/// Teams tags every channel (`@thread.tacv2`) message with a top-level
/// `rootMessageId`; the `;messageid=<root>` suffix of `conversationLink`/
/// `conversationid` carries the SAME value and backs it up when the top-level
/// field is absent. `properties.subject` is set only on the thread ROOT, so a
/// reply returns an empty subject — the UI reads the title off the root message
/// (whose `id` == root id). Chats and group messages have no thread structure and
/// yield empty strings. Best-effort by design: a surprising shape yields empty,
/// never an error, so it can never break message ingestion.
fn parse_thread(m: &Value) -> (String, String) {
    let root_id = m
        .get("rootMessageId")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            m.get("conversationLink")
                .or_else(|| m.get("conversationid"))
                .and_then(|x| x.as_str())
                .and_then(|link| link.split(";messageid=").nth(1))
                .map(|s| s.to_string())
        })
        .unwrap_or_default();
    // `properties` may be a nested object or a JSON-encoded string (same double
    // encoding as files/emotions); decode a level deeper when needed.
    let props = match m.get("properties") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    };
    let subject = props.get("subject").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    (root_id, subject)
}

/// Extract a message's @mentions from its `properties` into the wire shape the UI
/// renders: a JSON array string `[{itemid, mri, kind, display_name}]`.
///
/// A mention in the body is an empty-ish span that carries ONLY an index —
/// `<span itemtype="…/Mention" itemid="2">James</span>` — while who was mentioned
/// lives in `properties.mentions`, keyed by that same `itemid` (proven by recon):
/// `[{"@type":"…/Mention","itemid":0,"mri":"8:orgid:<guid>","mentionType":"person",
///    "displayName":"James"}]`. Joining the two is the only way back from the
/// rendered "@James" to the person, which is what lets the UI show their card.
///
/// `mentionType` is kept as `kind`: a mention can point at a person, a channel, a
/// team or a tag (a channel mention's mri is the THREAD, not a human), and only a
/// person is cardable. Unknown kinds are passed through rather than dropped.
///
/// `properties` and `mentions` may each arrive as a JSON-encoded STRING instead of
/// a nested value (the same double-encoding as `files`/`emotions`), so we parse a
/// level deeper when needed. Best-effort: an absent or malformed shape yields
/// `"[]"`, never an error, so a surprising mention payload cannot break ingestion.
fn parse_mentions(m: &Value) -> String {
    let props = match m.get("properties") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    };
    let raw = match props.get("mentions") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        Some(v) => v.clone(),
        _ => Value::Null,
    };
    let list: Vec<Value> = raw
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            // `itemid` is a number on the wire but has shown up as a string on
            // adjacent properties (`links`), so accept either.
            let itemid = entry.get("itemid").and_then(|x| {
                x.as_i64().or_else(|| x.as_str().and_then(|s| s.parse::<i64>().ok()))
            })?;
            let mri = entry.get("mri").and_then(|x| x.as_str()).filter(|s| !s.is_empty())?;
            let kind = entry
                .get("mentionType")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown");
            let display_name = entry
                .get("displayName")
                .and_then(|x| x.as_str())
                .unwrap_or_default();
            Some(json!({
                "itemid": itemid,
                "mri": mri,
                "kind": kind,
                "display_name": display_name,
            }))
        })
        .collect();
    Value::Array(list).to_string()
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
    fn sidebar_preview_labels_or_hides_system_frame_last_message() {
        // When the newest frame in a chat is a call event, the sidebar shows a
        // short human label — never the raw machine XML.
        let v = json!({
            "chats": [{
                "id": "19:meeting@thread.v2",
                "title": "[Stratumn] Daily",
                "chatType": "meeting",
                "lastMessage": {
                    "id": "9",
                    "composeTime": "2026-07-23T13:10:00.000Z",
                    "messageType": "Event/Call",
                    "content": "<ended/><partlist alt=\"\" count=\"1\"><part identity=\"8:orgid:x\">\
                        <displayName>Leonor GROELL</displayName></part></partlist>\
                        <callEventType>callEnded</callEventType>"
                }
            }]
        });
        let c = &parse_conversations(&v)[0];
        assert_eq!(c.last_message_preview, "Call ended", "a call-event last message shows a label");

        // A bare roster / other system frame still renders no preview (blanked).
        let v = json!({
            "chats": [{
                "id": "19:x@thread.v2", "title": "X", "chatType": "group",
                "lastMessage": {
                    "id": "9b", "composeTime": "2026-07-23T13:10:00.000Z",
                    "messageType": "ThreadActivity/AddMember",
                    "content": "<addmember><target>8:orgid:x</target></addmember>"
                }
            }]
        });
        assert_eq!(parse_conversations(&v)[0].last_message_preview, "");

        // A finished meeting recording as the last message previews as a clean,
        // event-style label — never the raw URIObject text (which would leak the
        // "Play" link the stripper leaves behind).
        let v = json!({
            "chats": [{
                "id": "19:meeting@thread.v2",
                "title": "[Stratumn] Daily",
                "chatType": "meeting",
                "lastMessage": {
                    "id": "10",
                    "composeTime": "2026-07-23T13:11:00.000Z",
                    "messageType": "RichText/Media_CallRecording",
                    "content": "<URIObject type=\"Video.2/CallRecording.1\"><RecordingStatus status=\"Success\" code=\"200\"/><Title>Daily</Title><a href=\"https://t-my.sharepoint.com/:v:/g/x\">Play</a></URIObject>"
                }
            }]
        });
        let c = &parse_conversations(&v)[0];
        assert_eq!(c.last_message_preview, "Meeting recording");

        // An in-progress recording notice as the last message previews as nothing
        // (it is noise the message list drops entirely).
        let v = json!({
            "chats": [{
                "id": "19:meeting2@thread.v2", "title": "Daily", "chatType": "meeting",
                "lastMessage": {
                    "id": "11", "composeTime": "2026-07-23T13:12:00.000Z",
                    "messageType": "RichText/Media_CallRecording",
                    "content": "<URIObject type=\"Video.2/CallRecording.1\"><RecordingStatus status=\"Initial\" code=\"0\"/><a href=\"\">Play</a></URIObject>"
                }
            }]
        });
        assert_eq!(parse_conversations(&v)[0].last_message_preview, "");
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

    /// A message body whose mention spans are addressed by `itemid`, exactly as
    /// the tenant delivers them (`properties.mentions` is a JSON-encoded STRING).
    fn mention_message() -> Value {
        json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-25T09:00:00.000Z",
            "messagetype": "RichText/Html", "imdisplayname": "James BASSE",
            "content": "<p><span itemtype=\"http://schema.skype.com/Mention\" itemscope=\"\" itemid=\"0\">Leonor</span> and <span itemtype=\"http://schema.skype.com/Mention\" itemscope=\"\" itemid=\"1\">[Run]</span></p>",
            "properties": {
                "mentions": "[{\"@type\":\"http://schema.skype.com/Mention\",\"itemid\":0,\"mri\":\"8:orgid:6f44df20\",\"mentionType\":\"person\",\"displayName\":\"Leonor\"},{\"@type\":\"http://schema.skype.com/Mention\",\"itemid\":1,\"mri\":\"19:yf2-R9Z4M9@thread.tacv2\",\"mentionType\":\"channel\",\"displayName\":\"[Run]\"}]"
            }
        })
    }

    #[test]
    fn parses_mentions_with_their_itemid_and_kind() {
        let parsed = parse_message(&mention_message(), "c1").unwrap();
        let mentions: Value = serde_json::from_str(&parsed.mentions).unwrap();
        assert_eq!(
            mentions,
            json!([
                { "itemid": 0, "mri": "8:orgid:6f44df20", "kind": "person", "display_name": "Leonor" },
                { "itemid": 1, "mri": "19:yf2-R9Z4M9@thread.tacv2", "kind": "channel", "display_name": "[Run]" }
            ]),
            "a channel mention is kept but marked, so only people get a person card",
        );
    }

    #[test]
    fn mentions_accept_a_nested_properties_object_and_a_string_itemid() {
        // `properties` un-encoded, `mentions` an array, `itemid` a string.
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-25T09:00:00.000Z",
            "messagetype": "RichText/Html", "content": "<p>hi</p>",
            "properties": { "mentions": [
                { "itemid": "3", "mri": "8:orgid:aaa", "mentionType": "person", "displayName": "Ada" }
            ]}
        });
        let mentions: Value =
            serde_json::from_str(&parse_message(&m, "c1").unwrap().mentions).unwrap();
        assert_eq!(mentions, json!([{ "itemid": 3, "mri": "8:orgid:aaa", "kind": "person", "display_name": "Ada" }]));
    }

    #[test]
    fn messages_without_mentions_carry_an_empty_list() {
        for m in [
            json!({ "id": "1", "messagetype": "RichText/Html", "content": "<p>hi</p>" }),
            json!({ "id": "1", "messagetype": "RichText/Html", "content": "<p>hi</p>", "properties": { "mentions": "[]" } }),
            // Malformed / unexpected shapes degrade to "no mentions", never an error.
            json!({ "id": "1", "messagetype": "RichText/Html", "content": "<p>hi</p>", "properties": { "mentions": "not json" } }),
            json!({ "id": "1", "messagetype": "RichText/Html", "content": "<p>hi</p>", "properties": { "mentions": [{ "displayName": "no mri" }] } }),
        ] {
            assert_eq!(parse_message(&m, "c1").unwrap().mentions, "[]");
        }
    }

    #[test]
    fn detects_a_deleted_message_by_its_deletetime() {
        // A deletion: the body is blanked and `properties.deletetime` is set. The
        // frame must survive parsing (so the store can flag the existing row) and
        // carry `deleted = true` with empty content.
        let m = json!({
            "id": "1", "sequenceId": 1, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "", "imdisplayname": "Alice", "messagetype": "RichText/Html",
            "properties": { "deletetime": "1752684326767" }
        });
        let parsed = parse_message(&m, "c1").expect("a deletion frame must not be dropped");
        assert!(parsed.deleted);
        assert_eq!(parsed.content, "");

        // `properties` double-encoded as a JSON string is decoded a level deeper,
        // like files/emotions/subject.
        let encoded = json!({
            "id": "2", "sequenceId": 2, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "", "imdisplayname": "Alice", "messagetype": "RichText/Html",
            "properties": "{\"deletetime\":\"1752684326767\"}"
        });
        assert!(parse_message(&encoded, "c1").unwrap().deleted);

        // A normal message is not deleted; a zero/empty deletetime is not a deletion.
        let live = json!({
            "id": "3", "sequenceId": 3, "composetime": "2026-07-16T16:05:26.767Z",
            "content": "<p>hi</p>", "imdisplayname": "Alice", "messagetype": "RichText/Html"
        });
        assert!(!parse_message(&live, "c1").unwrap().deleted);
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
        for mt in ["Control/ClearTyping", "ThreadActivity/AddMember", "ThreadActivity/TopicUpdate", "Signal/Flamingo"] {
            let m = json!({
                "id": "3", "sequenceId": 3, "composetime": "2026-07-16T16:05:28.000Z",
                "messagetype": mt, "content": "<partlist alt=\"\"><part/></partlist>"
            });
            assert!(parse_message(&m, "c1").is_none(), "{mt} must be skipped");
        }
        // A bare participant roster with NO call marker is a throwaway system frame
        // even when it arrives untyped — it must be dropped, not treated as a call.
        let roster = json!({
            "id": "3b", "sequenceId": 3, "composetime": "2026-07-16T16:05:28.000Z",
            "content": "<partlist alt=\"\"><part/></partlist>"
        });
        assert!(parse_message(&roster, "c1").is_none(), "a bare partlist roster must be skipped");

        // ...but a FINISHED recording card (a URIObject carrying a playable link) is
        // a real message and stays — surfaced as a media card, not dropped as a
        // system frame. (Its exact shape, and the dropping of the in-progress
        // notices Teams also posts, are covered by `parse_call_recording_shapes` /
        // `recording_becomes_a_media_message`.)
        let recording = json!({
            "id": "5", "sequenceId": 5, "composetime": "2026-07-16T16:05:30.000Z",
            "messagetype": "RichText/Media_CallRecording",
            "content": "<URIObject type=\"Video.2/CallRecording.1\">\
                <RecordingStatus status=\"Success\" code=\"200\"/><Title>Daily</Title>\
                <a href=\"https://t-my.sharepoint.com/:v:/g/x\">Play</a></URIObject>",
            "imdisplayname": "Alice"
        });
        assert!(parse_message(&recording, "c1").is_some(), "a finished recording card must be kept");
    }

    #[test]
    fn call_event_becomes_a_system_message() {
        // A call/meeting event is NOT dropped — it is parsed into a structured
        // `system_event` (rendered as a centered line), with the raw XML replaced
        // by an empty `content`. This holds whether the frame is properly typed
        // `Event/Call` or arrives untyped (the reported "callEnded" body), so the
        // empty->displayable default can never leak the raw XML.
        let call_ended = "<ended/><partlist alt=\"\" count=\"2\"><part identity=\"8:orgid:x\">\
            <displayName>Leonor GROELL</displayName><duration>600</duration></part>\
            <part identity=\"8:orgid:y\"><displayName>Matthieu GAUCHER</displayName>\
            <duration>540</duration></part></partlist><callEventType>callEnded</callEventType>";
        for mt in [None, Some("Event/Call"), Some("Text"), Some("RichText/Html")] {
            let mut m = json!({
                "id": "4", "sequenceId": 4, "composetime": "2026-07-16T16:05:29.000Z",
                "content": call_ended, "from": "8:orgid:x"
            });
            if let Some(mt) = mt {
                m["messagetype"] = json!(mt);
            }
            let parsed = parse_message(&m, "c1").expect("call event must be kept as a system message");
            assert_eq!(parsed.content, "", "raw call XML must not become bubble content ({mt:?})");
            let ev: Value = serde_json::from_str(&parsed.system_event).unwrap();
            assert_eq!(ev["kind"], "call");
            assert_eq!(ev["event"], "ended");
            assert_eq!(ev["duration_seconds"], 600, "longest participant duration");
            assert_eq!(ev["participant_count"], 2);
            assert_eq!(ev["participants"][0], "Leonor GROELL");
            // Each part's `identity` MRI rides along, aligned with `participants`,
            // so the UI can load a real profile photo per reader.
            assert_eq!(ev["participant_mris"], json!(["8:orgid:x", "8:orgid:y"]));
        }

        // A missed call carries no duration/roster.
        let missed = json!({
            "id": "6", "sequenceId": 6, "composetime": "2026-07-16T16:05:31.000Z",
            "messagetype": "Event/Call", "content": "<partlist alt=\"\"/><callEventType>callMissed</callEventType>"
        });
        let ev: Value = serde_json::from_str(&parse_message(&missed, "c1").unwrap().system_event).unwrap();
        assert_eq!(ev["event"], "missed");
        assert_eq!(ev["duration_seconds"], 0);
        assert_eq!(ev["participant_count"], 0);

        // The meeting-thread JSON call marker flows through the same path: kept as
        // a `started` system event (flagged `meeting`), never a raw JSON bubble.
        let meeting = json!({
            "id": "8", "sequenceId": 8, "composetime": "2026-07-16T16:05:33.000Z",
            "messagetype": "RichText/Media_Calling",
            "content": "{\\\"callId\\\":\\\"c\\\",\\\"meetingOrganizerId\\\":\\\"8:orgid:x\\\"}",
            "from": "8:orgid:x"
        });
        let parsed = parse_message(&meeting, "c1").expect("meeting call marker kept as a system message");
        assert_eq!(parsed.content, "", "raw JSON must not become bubble content");
        let ev: Value = serde_json::from_str(&parsed.system_event).unwrap();
        assert_eq!(ev["event"], "started");
        assert_eq!(ev["meeting"], true);

        // A normal chat message never carries a system_event.
        let chat = json!({
            "id": "7", "sequenceId": 7, "composetime": "2026-07-16T16:05:32.000Z",
            "messagetype": "RichText/Html", "content": "<p>hi</p>", "imdisplayname": "Alice"
        });
        assert_eq!(parse_message(&chat, "c1").unwrap().system_event, "");
    }

    #[test]
    fn parse_call_event_shapes() {
        // A non-call body is not a call event.
        assert!(parse_call_event("RichText/Html", "<p>hello</p>").is_none());
        assert!(parse_call_event("", "<partlist alt=\"\"><part/></partlist>").is_none());

        // Event type inferred from a leading marker when there is no callEventType.
        let started = parse_call_event("", "<started/><partlist/>").unwrap();
        assert_eq!(started["event"], "started");

        // An explicit callEventType wins; participant names are entity-decoded.
        let ev = parse_call_event(
            "Event/Call",
            "<ended/><partlist><part><displayName>Ben &amp; Jerry</displayName>\
             <duration>12</duration></part></partlist><callEventType>callEnded</callEventType>",
        )
        .unwrap();
        assert_eq!(ev["event"], "ended");
        assert_eq!(ev["participants"][0], "Ben & Jerry");
        assert_eq!(ev["duration_seconds"], 12);
        // The part carried no `identity` attribute → an empty MRI slot (still
        // present so the array stays aligned; the UI falls back to a coin).
        assert_eq!(ev["participant_mris"], json!([""]));

        // The meeting-thread JSON call marker (quotes backslash-escaped, as on the
        // wire) becomes a plain "started" event flagged `meeting`, with no roster —
        // regardless of the reported messagetype.
        let meeting = parse_call_event(
            "RichText/Media_Calling",
            "{\\\"scopeId\\\":\\\"s\\\",\\\"callId\\\":\\\"c\\\",\\\"meetingOrganizerId\\\":\\\"8:orgid:x\\\"}",
        )
        .unwrap();
        assert_eq!(meeting["event"], "started");
        assert_eq!(meeting["meeting"], true);
        assert_eq!(meeting["participant_count"], 0);
        assert_eq!(meeting["participants"].as_array().unwrap().len(), 0);
        // Plain (unescaped) quotes are recognised too.
        assert!(parse_call_event("", "{\"callId\":\"c\",\"meetingOrganizerId\":\"o\"}").is_some());
        // A JSON body missing the meeting keys is NOT a call event.
        assert!(parse_call_event("RichText/Html", "{\"foo\":1}").is_none());
        assert!(parse_call_event("", "{\"callId\":\"c\"}").is_none());
    }

    #[test]
    fn call_participants_pair_name_with_identity() {
        // Names pair with their own part's `identity`; a part without one yields an
        // empty MRI slot, and `<partlist>`/`<part/>` never masquerade as a person.
        let content = "<ended/><partlist alt=\"\" count=\"3\">\
            <part identity=\"8:orgid:aaa\"><displayName>Ada L</displayName><duration>30</duration></part>\
            <part><displayName>No Id</displayName><duration>10</duration></part>\
            <part identity=\"8:orgid:ccc\"><displayName>Grace &amp; Co</displayName></part>\
            </partlist><callEventType>callEnded</callEventType>";
        assert_eq!(
            call_participants(content),
            vec![
                ("Ada L".to_string(), "8:orgid:aaa".to_string()),
                ("No Id".to_string(), String::new()),
                ("Grace & Co".to_string(), "8:orgid:ccc".to_string()),
            ]
        );
        // A self-closing `<part/>` (no name) contributes nothing.
        assert!(call_participants("<partlist alt=\"\"/>").is_empty());
        assert!(call_participants("<partlist><part/></partlist>").is_empty());
    }

    /// A finished (`Success`) recording URIObject, as Teams posts it — trimmed to
    /// the parts the parser reads (status, title, the "Play" link, the poster
    /// thumbnail on the root, and the duration on `<RecordingContent>`).
    const RECORDING_SUCCESS: &str = "<URIObject format_version=\"1.1\" \
        type=\"Video.2/CallRecording.1\" \
        url_thumbnail=\"https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frs/views/thumbnail_small\" \
        uri=\"\" version=\"1.0\"><RecordingStatus status=\"Success\" code=\"200\"/>\
        <Title>Keynote #3 du Lab Eng X Gen AI</Title>\
        <a href=\"https://siapartners1-my.sharepoint.com/:v:/g/personal/x/IQCm\">Play</a>\
        <RecordingContent contentTypes=\"Recording+Transcript\" duration=\"1:08:03.92\">\
        <item type=\"onedriveForBusinessVideo\" uri=\"https://siapartners1-my.sharepoint.com/:v:/g/personal/x/IQCm\"/>\
        </RecordingContent></URIObject>";

    #[test]
    fn parse_call_recording_shapes() {
        // A finished recording → a `recording` attachment with the title, the
        // SharePoint "Play" link, the poster thumbnail, and whole-second duration.
        let att = match parse_call_recording("", RECORDING_SUCCESS) {
            Some(CallRecording::Ready(a)) => a,
            _ => panic!("a Success recording must parse as Ready"),
        };
        assert_eq!(att["kind"], "recording");
        assert_eq!(att["name"], "Keynote #3 du Lab Eng X Gen AI");
        assert_eq!(att["url"], "https://siapartners1-my.sharepoint.com/:v:/g/personal/x/IQCm");
        assert_eq!(
            att["thumbnail_url"],
            "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frs/views/thumbnail_small"
        );
        assert_eq!(att["duration_seconds"], 4083); // 1*3600 + 8*60 + 3
        assert_eq!(att["content_type"], "video/mp4");

        // The in-progress notices Teams also posts carry no link → Pending (noise).
        for status in ["Initial", "ChunkFinished"] {
            let body = format!(
                "<URIObject type=\"Video.2/CallRecording.1\" url_thumbnail=\"\">\
                 <RecordingStatus status=\"{status}\" code=\"0\"/>\
                 <Title>x</Title><a href=\"\">Play</a></URIObject>"
            );
            assert!(
                matches!(parse_call_recording("", &body), Some(CallRecording::Pending)),
                "{status} recording must be Pending"
            );
        }

        // A `Success` whose `<a>` link is empty falls back to the OneDrive item uri.
        let fallback = "<URIObject type=\"Video.2/CallRecording.1\">\
            <RecordingStatus status=\"Success\" code=\"200\"/><Title>t</Title><a href=\"\">Play</a>\
            <RecordingContent duration=\"0:05:00\">\
            <item type=\"onedriveForBusinessVideo\" uri=\"https://t-my.sharepoint.com/:v:/g/x\"/>\
            </RecordingContent></URIObject>";
        let att = match parse_call_recording("", fallback) {
            Some(CallRecording::Ready(a)) => a,
            _ => panic!("fallback recording must parse as Ready"),
        };
        assert_eq!(att["url"], "https://t-my.sharepoint.com/:v:/g/x");
        assert_eq!(att["duration_seconds"], 300);

        // Non-recording bodies are not recordings (the caller handles them normally).
        assert!(parse_call_recording("", "<p>hello</p>").is_none());
        assert!(parse_call_recording("", "<URIObject type=\"SWIFT.1\"><Swift/></URIObject>").is_none());
        // A real message that merely MENTIONS the marker in text is not a recording.
        assert!(parse_call_recording("", "<p>see the CallRecording docs</p>").is_none());
    }

    #[test]
    fn recording_becomes_a_media_message() {
        // A finished recording is surfaced as a media message: empty body, a lone
        // `recording` attachment, and a BLANK sender (the frame's `from` is a bare
        // contacts-endpoint URL we must not show as an author) — but its MRI is kept.
        let m = json!({
            "id": "42", "sequenceId": 42, "composetime": "2026-07-21T16:01:44.000Z",
            "messagetype": "RichText/Media_CallRecording",
            "content": RECORDING_SUCCESS,
            "from": "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:1c34ddea"
        });
        let parsed = parse_message(&m, "19:meeting_x@thread.v2").expect("recording kept as a message");
        assert_eq!(parsed.content, "", "raw URIObject XML must not become bubble content");
        assert_eq!(parsed.sender, "", "the bare contacts-URL `from` must not show as a sender");
        assert_eq!(parsed.sender_mri, "8:orgid:1c34ddea", "the organizer MRI is still captured");
        assert_eq!(parsed.system_event, "", "a recording is media, not a system event");
        let atts: Value = serde_json::from_str(&parsed.attachments).unwrap();
        assert_eq!(atts.as_array().unwrap().len(), 1);
        assert_eq!(atts[0]["kind"], "recording");
        assert_eq!(atts[0]["name"], "Keynote #3 du Lab Eng X Gen AI");

        // An in-progress notice is dropped entirely (returns no message).
        let pending = json!({
            "id": "43", "sequenceId": 43, "composetime": "2026-07-21T16:01:39.000Z",
            "messagetype": "RichText/Media_CallRecording",
            "content": "<URIObject type=\"Video.2/CallRecording.1\"><RecordingStatus status=\"Initial\" code=\"0\"/><a href=\"\">Play</a></URIObject>"
        });
        assert!(parse_message(&pending, "19:meeting_x@thread.v2").is_none(), "an in-progress recording notice is dropped");
    }

    #[test]
    fn parse_hms_to_seconds_handles_teams_durations() {
        assert_eq!(parse_hms_to_seconds("1:08:03.92"), 4083);
        assert_eq!(parse_hms_to_seconds("0:00:00"), 0);
        assert_eq!(parse_hms_to_seconds("05:30"), 330);
        assert_eq!(parse_hms_to_seconds("2:00:00"), 7200);
        assert_eq!(parse_hms_to_seconds(""), 0);
        assert_eq!(parse_hms_to_seconds("garbage"), 0);
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
                system_event: String::new(),
                thread_root_id: String::new(), thread_subject: String::new(),
                deleted: false,
                mentions: "[]".into(),
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

    // ---- channels (teams tree) ----------------------------------------------

    #[test]
    fn is_channel_thread_id_discriminates() {
        assert!(is_channel_thread_id("19:abc@thread.tacv2"));
        // a channel post / deep link carries a `;messageid=` suffix — still a channel
        assert!(is_channel_thread_id("19:abc@thread.tacv2;messageid=1784899486984"));
        assert!(!is_channel_thread_id("19:abc@thread.v2")); // group chat
        assert!(!is_channel_thread_id("19:abc@thread.v2;messageid=1")); // group-chat deep link
        assert!(!is_channel_thread_id("19:abc@unq.gbl.spaces")); // 1:1
        assert!(!is_channel_thread_id("48:notes")); // system thread
        assert!(!is_channel_thread_id(""));
    }

    #[test]
    fn parses_teams_and_channels() {
        // Mirrors the CSA `teams` shape: a team with a General channel (id ==
        // team id) plus a named channel, each carrying the same camelCase
        // `lastMessage` sub-object as a chat.
        let v = json!({
            "teams": [{
                "id": "19:team-general@thread.tacv2",
                "displayName": " Platform ",
                "teamSiteInformation": { "groupId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
                "channels": [
                    {
                        "id": "19:team-general@thread.tacv2",
                        "displayName": "General",
                        "isFavorite": true,
                        "isRead": false,
                        "isLastMessageFromMe": true,
                        "lastMessage": {
                            "id": "1", "composeTime": "2026-07-16T16:05:26.767Z",
                            "content": "<p>welcome &amp; hi</p>", "imDisplayName": "Ada",
                            "messageType": "RichText/Html"
                        }
                    },
                    {
                        "id": "19:announcements@thread.tacv2",
                        "name": "Announcements",
                        "isGeneral": false,
                        "lastMessage": {
                            "id": "2", "composeTime": "2026-07-16T17:00:00.000Z",
                            "content": "<p>ship day</p>", "imDisplayName": "Grace",
                            "messageType": "RichText/Html"
                        }
                    }
                ]
            }]
        });
        let teams = parse_teams(&v);
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].id, "19:team-general@thread.tacv2");
        assert_eq!(teams[0].display_name, "Platform"); // trimmed
        // The AAD group id (for the team photo) is lifted from teamSiteInformation
        // and denormalized onto every channel of the team.
        assert_eq!(teams[0].group_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!(teams[0].channels.len(), 2);

        let general = &teams[0].channels[0];
        assert_eq!(general.team_group_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert_eq!(general.display_name, "General");
        assert!(general.is_general, "id == team id -> General");
        assert!(general.is_favorite);
        assert!(!general.is_read); // unread
        assert!(general.last_message_from_me);
        assert_eq!(general.last_message_preview, "welcome & hi");
        assert_eq!(general.last_message_sender, "Ada");
        assert_eq!(general.team_name, "Platform");
        assert_eq!(general.team_id, "19:team-general@thread.tacv2");
        assert!(!general.is_empty);

        let ann = &teams[0].channels[1];
        assert_eq!(ann.display_name, "Announcements"); // `name` fallback
        assert!(!ann.is_general);
        assert!(ann.is_read); // absent isRead -> read
        assert!(!ann.last_message_from_me);
        assert_eq!(ann.last_message_preview, "ship day");
    }

    #[test]
    fn group_id_falls_back_past_a_null_team_site_group_id() {
        // A team whose `teamSiteInformation.groupId` is present but JSON null must
        // still resolve its group id from the top-level fallback — the null must
        // not short-circuit the chain to empty.
        let v = json!({
            "teams": [{
                "id": "19:t@thread.tacv2",
                "displayName": "Fallbacks",
                "teamSiteInformation": { "groupId": null },
                "groupId": "11111111-2222-3333-4444-555555555555",
                "channels": [{ "id": "19:t@thread.tacv2", "displayName": "General" }]
            }]
        });
        let teams = parse_teams(&v);
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].group_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(teams[0].channels[0].team_group_id, "11111111-2222-3333-4444-555555555555");

        // With neither teamSiteInformation nor a top-level groupId, aadGroupId wins.
        let v2 = json!({
            "teams": [{
                "id": "19:t@thread.tacv2",
                "displayName": "AadOnly",
                "aadGroupId": "99999999-8888-7777-6666-555555555555",
                "channels": [{ "id": "19:t@thread.tacv2", "displayName": "General" }]
            }]
        });
        let teams2 = parse_teams(&v2);
        assert_eq!(teams2[0].group_id, "99999999-8888-7777-6666-555555555555");
    }

    #[test]
    fn teams_tolerate_missing_ids_and_empty_channels() {
        let v = json!({
            "teams": [
                { "displayName": "no id — skipped" },
                {
                    "teamId": "19:t2@thread.tacv2", "title": "Fallback Name",
                    "channels": [
                        { "name": "no id — skipped" },
                        {
                            "id": "19:empty@thread.tacv2", "displayName": "Empty",
                            "lastMessage": { "id": null }
                        }
                    ]
                }
            ]
        });
        let teams = parse_teams(&v);
        assert_eq!(teams.len(), 1, "the id-less team is skipped");
        assert_eq!(teams[0].id, "19:t2@thread.tacv2"); // teamId fallback
        assert_eq!(teams[0].display_name, "Fallback Name"); // title fallback
        assert_eq!(teams[0].channels.len(), 1, "the id-less channel is skipped");
        assert!(teams[0].channels[0].is_empty, "no lastMessage id -> empty");
    }

    #[test]
    fn channel_call_event_last_message_shows_label() {
        // A channel whose newest frame is a call event shows the short label, not
        // the raw XML — same gate as the chat path (shared `parse_last_message`).
        let v = json!({
            "teams": [{
                "id": "19:t@thread.tacv2", "displayName": "Ops",
                "channels": [{
                    "id": "19:c@thread.tacv2", "displayName": "Standup",
                    "lastMessage": {
                        "id": "9", "composeTime": "2026-07-23T13:10:00.000Z",
                        "messageType": "Event/Call",
                        "content": "<ended/><callEventType>callEnded</callEventType>"
                    }
                }]
            }]
        });
        assert_eq!(parse_teams(&v)[0].channels[0].last_message_preview, "Call ended");
    }

    #[test]
    fn persist_channels_heals_leaked_conversation_and_counts_changes() {
        let store = Store::open_in_memory().unwrap();
        let ch = Channel {
            id: "19:c@thread.tacv2".into(),
            team_id: "19:t@thread.tacv2".into(),
            team_name: "Ops".into(),
            team_group_id: "00000000-1111-2222-3333-444444444444".into(),
            display_name: "Standup".into(),
            is_general: false,
            is_favorite: false,
            last_message_time: 100,
            is_empty: false,
            last_message_preview: "hi".into(),
            last_message_sender: "Ada".into(),
            last_message_from_me: false,
            is_read: true,
        };
        let teams = vec![Team {
            id: "19:t@thread.tacv2".into(),
            display_name: "Ops".into(),
            group_id: "00000000-1111-2222-3333-444444444444".into(),
            channels: vec![ch.clone()],
        }];

        // A live post leaked the channel into the conversations table beforehand.
        store.upsert_conversation(&ch.id, "", 100).unwrap();
        assert!(!store.is_channel(&ch.id).unwrap(), "not yet a channel row");

        // First sync: one channel written, one leaked conversation healed.
        let (changed, healed) = persist_channels(&store, &teams);
        assert_eq!((changed, healed), (1, 1));
        assert!(store.is_channel(&ch.id).unwrap(), "now a channel row");
        // the conversations list no longer surfaces it
        assert!(store.conversations("").unwrap().iter().all(|c| c.id != ch.id));

        // Identical re-sync converges to no changes (no event storm).
        assert_eq!(persist_channels(&store, &teams), (0, 0));

        // Empty channels are skipped.
        let empty_teams = vec![Team {
            id: "19:t@thread.tacv2".into(),
            display_name: "Ops".into(),
            group_id: "00000000-1111-2222-3333-444444444444".into(),
            channels: vec![Channel { id: "19:empty@thread.tacv2".into(), is_empty: true, ..ch.clone() }],
        }];
        assert_eq!(persist_channels(&store, &empty_teams), (0, 0));
        assert!(!store.is_channel("19:empty@thread.tacv2").unwrap());
    }
}

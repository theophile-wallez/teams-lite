// Local-first message store (SQLite). The UI reads from here; the network only
// backfills at the cache frontier. Source of truth for conversations + messages.
//
// Design notes:
//   - messages are deduplicated by (conversation_id, id) — a live push and a
//     history fetch can return the same message; never duplicate it.
//   - ordering key is `seq` (Teams sequenceId), monotonic within a conversation.
//   - pagination state per conversation: `oldest_cursor` (server cursor to fetch
//     messages older than what we hold) + `has_more_older`.
//
// Performance shape (see `tune`, `INDEXES` and [`Store::transaction`]): every
// statement goes through the connection's prepared-statement cache, batches commit
// once instead of once per row, and no read path is allowed to scan `messages`.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS conversations (
    id                    TEXT PRIMARY KEY,
    display_name          TEXT,
    last_message_time     INTEGER NOT NULL DEFAULT 0,
    oldest_cursor         TEXT,
    has_more_older        INTEGER NOT NULL DEFAULT 1,
    kind                  TEXT NOT NULL DEFAULT 'unknown',
    last_message_preview  TEXT NOT NULL DEFAULT '',
    last_message_sender   TEXT NOT NULL DEFAULT '',
    -- Who wrote that preview, as an identity rather than as a name, so the sidebar's
    -- "Bob: hello" line follows a `person_overrides` nickname like every other name
    -- this app states. Empty for a preview whose frame carried no `from`.
    last_message_sender_mri TEXT NOT NULL DEFAULT '',
    last_message_from_me  INTEGER NOT NULL DEFAULT 0,
    is_read               INTEGER NOT NULL DEFAULT 1,
    is_muted              INTEGER NOT NULL DEFAULT 0,
    is_pinned             INTEGER NOT NULL DEFAULT 0,
    is_hidden             INTEGER NOT NULL DEFAULT 0,
    thread_type           TEXT NOT NULL DEFAULT '',
    draft                 TEXT NOT NULL DEFAULT '',
    -- A group chat's own uploaded picture, as an absolute media-proxy URL. Empty
    -- for a chat with none (see `teams_read::parse_thread_picture`).
    picture_url           TEXT NOT NULL DEFAULT '',
    -- Our OWN read position, kept locally: the `last_message_time` the user has read
    -- up to (0 = never). A thread counts as read when Teams says so OR when this
    -- reaches its last message, which is what clears the marker the instant the user
    -- opens it — before the CSA sync catches up, and for good in Ghost mode, where
    -- Teams is never told (see `mark_thread_read`).
    local_read_time       INTEGER NOT NULL DEFAULT 0,
    -- 1 when that local position was NEVER sent to Teams (Ghost mode), so the UI can
    -- say so: read here, still unread for the sender.
    local_read_ghost      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 0,
    compose_time    INTEGER NOT NULL DEFAULT 0,
    sender          TEXT,
    sender_mri      TEXT,
    messagetype     TEXT NOT NULL DEFAULT '',
    content         TEXT,
    attachments     TEXT NOT NULL DEFAULT '[]',
    reactions       TEXT NOT NULL DEFAULT '[]',
    system_event    TEXT NOT NULL DEFAULT '',
    thread_root_id  TEXT NOT NULL DEFAULT '',
    thread_subject  TEXT NOT NULL DEFAULT '',
    deleted         INTEGER NOT NULL DEFAULT 0,
    mentions        TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (conversation_id, id)
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- What the USER decided to call somebody, and the face they gave them. Teams has
-- neither: a colleague's name and photo are theirs to set, so this is the one thing
-- in the store that no sync can ever supply and no sync may ever overwrite.
--
-- A LOCAL OVERRIDE, exactly like a fold, a pin or a local read position: it wins over
-- the Teams-sourced value from here on, and nothing writes it back. Publishing a name
-- or a picture to the user's account would be an outward action needing its own
-- consent gate (see AGENTS.md), and Teams offers no such call anyway.
--
-- Keyed by MRI rather than by name, because a name is a cache derived from the MRI
-- (see `Message::sender_mri`) — and because an override keyed on a display name would
-- rename everybody who shares it. A row exists only while at least one half is set:
-- clearing both deletes it, so "no override" is the absence of a row and every read
-- can treat an empty table as the common case.
--
-- The avatar is held as BYTES, not as a path or a URL. A path would break the moment
-- the user moved the file, and a URL would make rendering a colleague's face a network
-- request to a third party — the same reason a mail body is stripped of remote
-- references. The bytes are capped at `MAX_PERSON_AVATAR_BYTES` on the way in.
CREATE TABLE IF NOT EXISTS person_overrides (
    mri                 TEXT PRIMARY KEY,
    -- What the user wants to see instead of the directory's name. Empty means they
    -- overrode only the picture.
    display_name        TEXT NOT NULL DEFAULT '',
    -- The MIME type of `avatar_bytes`, so the UI can build a blob without sniffing.
    -- Empty (with NULL bytes) means they overrode only the name.
    avatar_content_type TEXT NOT NULL DEFAULT '',
    avatar_bytes        BLOB,
    updated_at          INTEGER NOT NULL DEFAULT 0
);
-- Custom emoji: Slack-style `:name:` substitution for outbound messages. The
-- pack is held locally (nothing pulls from a server), and each emoji is either
-- ART (raster bytes + dimensions) or an ALIAS (pointing to another name the
-- pack holds). A row exists only while it is one or the other; clearing both
-- deletes it, so "no emoji" is the absence of a row. The bytes are stored
-- verbatim; validating the type and size is the RPC's job (where a client's
-- input arrives), exactly like `person_overrides`.
--
-- The bytes are held as BYTES, not as a path or a URL. A path would break the
-- moment the user moved the file, and a URL would make rendering an emoji a
-- network request to a third party — the same reason a mail body is stripped
-- of remote references, and the same reason a colleague's avatar lives here
-- as bytes. The bytes are capped at `custom_emoji::MAX_CUSTOM_EMOJI_BYTES` on
-- the way in.
CREATE TABLE IF NOT EXISTS custom_emoji (
    name         TEXT PRIMARY KEY,
    alias_of     TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT '',
    bytes        BLOB,
    width        INTEGER NOT NULL DEFAULT 0,
    height       INTEGER NOT NULL DEFAULT 0,
    source       TEXT NOT NULL DEFAULT '',
    added_ms     INTEGER NOT NULL DEFAULT 0
);
-- Team channels, kept SEPARATE from `conversations` so channel posts never mix
-- into the chat list. A channel's messages still live in the shared `messages`
-- table keyed by its thread id, so open/backfill/send/react reuse the same
-- pipeline unchanged. Fresh stores get the full column set here; stores created
-- before a column was added are healed by the guarded ALTERs in migrate().
-- `team_pos`/`channel_pos` hold the CSA array order, which is the ONLY order the
-- payload states: no team and no channel carries a rank, an order or a position key,
-- and the array order matches no sort of any field CSA does send. It is a server-held
-- arrangement, and it IS the user's own: verified against the real Teams client on
-- 2026-08-03, whose team order the v1 array reproduces exactly. It also moves when the
-- user re-arranges their teams, and a sync then re-writes `team_pos` (see
-- examples/team_order_recon.rs, which pins all of it — including that the v2
-- aggregator returns a different, non-client order, so nothing must switch to it).
-- One thing the array does NOT settle: CSA puts General LAST in a team (index 41 of 42
-- in the biggest one), and the read forces it first.
CREATE TABLE IF NOT EXISTS channels (
    id                    TEXT PRIMARY KEY,
    team_id               TEXT NOT NULL DEFAULT '',
    team_name             TEXT NOT NULL DEFAULT '',
    team_group_id         TEXT NOT NULL DEFAULT '',
    display_name          TEXT NOT NULL DEFAULT '',
    is_general            INTEGER NOT NULL DEFAULT 0,
    -- Whether the channel is SHOWN in the user's team list (CSA calls it
    -- `isFavorite`, its historical name for Show/Hide) and whether the user pinned
    -- it. Two different things: see `crate::teams_read::Channel`. Both default to
    -- the visible, ungrouped answer, so a row written before these columns existed
    -- reads as a plain shown channel.
    is_shown              INTEGER NOT NULL DEFAULT 1,
    is_pinned             INTEGER NOT NULL DEFAULT 0,
    -- Whether the user has this channel's TEAM folded in their own Teams client, from
    -- that team's `isCollapsed`. Denormalized onto every channel of the team, like
    -- `team_name` above, because a sidebar row is a channel and there is no teams
    -- table. 0 (expanded) is the safe default: a team wrongly folded looks lost.
    team_collapsed        INTEGER NOT NULL DEFAULT 0,
    last_message_time     INTEGER NOT NULL DEFAULT 0,
    last_message_preview  TEXT NOT NULL DEFAULT '',
    last_message_sender   TEXT NOT NULL DEFAULT '',
    -- The identity behind that name, for the same reason as on `conversations`.
    last_message_sender_mri TEXT NOT NULL DEFAULT '',
    last_message_from_me  INTEGER NOT NULL DEFAULT 0,
    is_read               INTEGER NOT NULL DEFAULT 1,
    draft                 TEXT NOT NULL DEFAULT '',
    team_pos              INTEGER NOT NULL DEFAULT 0,
    channel_pos           INTEGER NOT NULL DEFAULT 0,
    -- The user's own per-channel notification setting in Microsoft Teams, stored
    -- as the decision (see `ChannelAlerts`) rather than the three raw CSA signals
    -- it is derived from. 'mentions_only' is Teams' default, so a row written
    -- before this column existed keeps the behaviour it already had.
    alerts                TEXT NOT NULL DEFAULT 'mentions_only',
    -- Our own local read position and its Ghost-mode flag, exactly as on
    -- `conversations` above.
    local_read_time       INTEGER NOT NULL DEFAULT 0,
    local_read_ghost      INTEGER NOT NULL DEFAULT 0
);
-- Outlook mail (READ-ONLY mirror; see src/mail.rs). Kept in its own tables rather
-- than folded into conversations/messages: mail is ordered by an ISO timestamp
-- instead of a Teams `seq`, addressed by folder instead of thread, and carries
-- recipients and a rendered body. Sharing the chat tables would have meant a dozen
-- nullable columns and two meanings per row.
CREATE TABLE IF NOT EXISTS mail_folders (
    id               TEXT PRIMARY KEY,
    -- The folder's own, LOCALIZED name as Outlook shows it ("Boîte de réception").
    display_name     TEXT NOT NULL DEFAULT '',
    -- Stable English label for a well-known folder ("Inbox", "Sent"), else empty.
    -- Graph has no `wellKnownName` here, so this comes from the path alias.
    well_known       TEXT NOT NULL DEFAULT '',
    total_count      INTEGER NOT NULL DEFAULT 0,
    unread_count     INTEGER NOT NULL DEFAULT 0,
    position         INTEGER NOT NULL DEFAULT 0,
    -- History frontier: the oldest message we hold for this folder, and whether the
    -- server has anything older (the mail analogue of `conversations.oldest_cursor`).
    oldest_received  TEXT NOT NULL DEFAULT '',
    has_more_older   INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS mail_messages (
    id                     TEXT PRIMARY KEY,
    folder_id              TEXT NOT NULL,
    conversation_id        TEXT NOT NULL DEFAULT '',
    subject                TEXT NOT NULL DEFAULT '',
    from_name              TEXT NOT NULL DEFAULT '',
    from_address           TEXT NOT NULL DEFAULT '',
    -- Recipients as JSON arrays of {name, address}.
    to_addresses           TEXT NOT NULL DEFAULT '[]',
    cc_addresses           TEXT NOT NULL DEFAULT '[]',
    -- ISO 8601 UTC, whole seconds. Fixed-width, so ordering and keyset paging run
    -- on the text directly (see graph_time::normalize_timestamp).
    received               TEXT NOT NULL DEFAULT '',
    -- The SERVER's own read flag, from Graph's `isRead`. Never written by a read
    -- made here: the mailbox is read-only (src/mail.rs).
    is_read                INTEGER NOT NULL DEFAULT 1,
    -- Our own read mark, set when the user opens the mail in THIS app (see
    -- `Store::mark_mail_read_locally`). Kept apart from `is_read` so the poll can
    -- keep writing the server's flag verbatim and neither one can clobber the
    -- other; the effective state the UI shows is the OR of the two
    -- (`MailMessageRow::is_read`). Only ever set while the server says unread, and
    -- cleared as soon as the server itself reports the mail read.
    local_read             INTEGER NOT NULL DEFAULT 0,
    has_attachments        INTEGER NOT NULL DEFAULT 0,
    importance             TEXT NOT NULL DEFAULT 'normal',
    preview                TEXT NOT NULL DEFAULT '',
    -- The sanitized, self-contained body, cached on first open. `body_loaded`
    -- distinguishes "not fetched yet" from "fetched and genuinely empty".
    body_html              TEXT NOT NULL DEFAULT '',
    body_loaded            INTEGER NOT NULL DEFAULT 0,
    blocked_remote_images  INTEGER NOT NULL DEFAULT 0,
    body_truncated         INTEGER NOT NULL DEFAULT 0,
    attachments            TEXT NOT NULL DEFAULT '[]'
);
-- Teams/Outlook calendar (READ-ONLY mirror; see src/calendar.rs). Its own tables
-- for the same reason mail has its own: an event is a RANGE (two timestamps) rather
-- than a point, addressed by calendar instead of folder or thread, and carries
-- attendees and a response state.
CREATE TABLE IF NOT EXISTS calendars (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    -- Outlook's own colour as '#rrggbb', or empty for a calendar on the automatic
    -- colour (the UI then falls back to its own palette, keyed by position).
    hex_color   TEXT NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    -- What Outlook itself would allow. Recorded for display honesty only: this app
    -- never writes to a calendar, whatever the flag says.
    can_edit    INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calendar_events (
    -- Graph's OCCURRENCE id: a weekly meeting yields one row per week, because the
    -- view endpoint expands recurrence server-side.
    id                 TEXT PRIMARY KEY,
    calendar_id        TEXT NOT NULL,
    subject            TEXT NOT NULL DEFAULT '',
    preview            TEXT NOT NULL DEFAULT '',
    -- ISO 8601 UTC, whole seconds; `end_utc` is EXCLUSIVE (Graph's convention).
    -- Fixed-width, so every range predicate is a plain string comparison.
    start_utc          TEXT NOT NULL DEFAULT '',
    end_utc            TEXT NOT NULL DEFAULT '',
    is_all_day         INTEGER NOT NULL DEFAULT 0,
    is_cancelled       INTEGER NOT NULL DEFAULT 0,
    is_organizer       INTEGER NOT NULL DEFAULT 0,
    organizer_name     TEXT NOT NULL DEFAULT '',
    organizer_address  TEXT NOT NULL DEFAULT '',
    location           TEXT NOT NULL DEFAULT '',
    join_url           TEXT NOT NULL DEFAULT '',
    web_link           TEXT NOT NULL DEFAULT '',
    show_as            TEXT NOT NULL DEFAULT 'unknown',
    response           TEXT NOT NULL DEFAULT 'none',
    series             TEXT NOT NULL DEFAULT 'singleInstance',
    recurrence         TEXT NOT NULL DEFAULT '',
    importance         TEXT NOT NULL DEFAULT 'normal',
    sensitivity        TEXT NOT NULL DEFAULT 'normal',
    -- JSON arrays: categories of strings, attendees of {name, address, response, kind}.
    categories         TEXT NOT NULL DEFAULT '[]',
    attendees          TEXT NOT NULL DEFAULT '[]',
    attendee_count     INTEGER NOT NULL DEFAULT 0,
    has_attachments    INTEGER NOT NULL DEFAULT 0,
    reminder_minutes   INTEGER NOT NULL DEFAULT -1
);
-- Which calendar-months have been synced, so a re-opened month is served from
-- SQLite with no network at all. The sync unit is a whole month rather than the
-- window the user is looking at, because a week view straddling two months would
-- otherwise never be a cache hit (see the src/calendar.rs module doc).
CREATE TABLE IF NOT EXISTS calendar_months (
    calendar_id  TEXT NOT NULL,
    -- 'YYYY-MM'.
    month        TEXT NOT NULL,
    synced_at    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (calendar_id, month)
);
-- Devices that asked for push notifications (see src/push.rs). One row per
-- installed web app: an iPhone Home Screen app and a laptop browser are two rows,
-- each with its own endpoint and its own encryption keys.
--
-- Durable on purpose: the phone's subscription must outlive a backend restart, or
-- notifications would stop until the user opened the app again — which is exactly
-- the situation push exists to cover.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    -- The push service URL. Unique per device, so it is the natural key.
    endpoint    TEXT PRIMARY KEY,
    -- The device's public key and auth secret, base64url, straight from the
    -- browser's PushSubscription.
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    -- A human label for the Settings list ("iPhone · Safari"), from the client.
    label       TEXT NOT NULL DEFAULT '',
    created_ms  INTEGER NOT NULL DEFAULT 0,
    -- Last successful delivery, and the last failure text. Both exist so the user
    -- can tell a working subscription from a dead one without reading a journal.
    last_ok_ms  INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT NOT NULL DEFAULT ''
);
-- One row per live message already ACTED ON, so it is acted on EXACTLY once.
--
-- Not an optimization: two send-capable backends share this store by design (the
-- always-on service on 19420 and the user's dev one on 19421 — see the Ports table
-- in AGENTS.md), both run a trouter, and both see every live message. Without a
-- claim they would both push and the phone would buzz twice per message — and both
-- answer an `@claude` trigger, which would post the same reply twice. Rows are
-- pruned after a day (see [`Store::prune_claims`]).
--
-- The table keeps its original push-only name; the key space is what separates the
-- users (`<conversation>/<message>` for a push, `agent/…` for an agent reply).
CREATE TABLE IF NOT EXISTS push_deliveries (
    -- conversation_id + '/' + message_id.
    dedupe_key TEXT PRIMARY KEY,
    claimed_ms INTEGER NOT NULL DEFAULT 0
);
-- One row per agent run in flight: the message it is writing into, from the moment the
-- placeholder is posted until the final edit lands (see `agent_reply` in
-- src/bin/server.rs).
--
-- It exists for the one case nothing else covers: the process is KILLED mid-run — the
-- always-on service restarts on every re-stage, and a run outlives no restart — so the
-- terminal edit never goes out and the message keeps its "claude is thinking…" body
-- forever, in a thread everybody reads. The row is what a later process reads to find
-- that message and close it honestly.
--
-- Hence durable rather than in-memory: the question "was this message left mid-answer"
-- has to be answerable by a process that is not the one that left it.
--
-- `heartbeat_ms` is what separates a dead run from a live one. A run refreshes it while
-- it writes, so a stale row is an abandoned one — and that test holds ACROSS processes,
-- which is what matters here: the service (19420) and the user's dev backend (19421)
-- share this store, and neither may close a run the other is still writing.
CREATE TABLE IF NOT EXISTS agent_runs (
    conversation_id TEXT NOT NULL,
    -- The posted message being edited into the answer — what a repair rewrites.
    message_id      TEXT NOT NULL,
    -- The TRIGGER's message id, i.e. the `run_id` every `agent_stream` frame carries.
    -- Kept so a repair can also tell the app's own pages that the run they are drawing
    -- is over, instead of leaving a bubble writing until their staleness guard fires.
    trigger_id      TEXT NOT NULL DEFAULT '',
    -- Which CLI is answering (`agent_policy::BACKENDS`), because the body a repair
    -- writes names it.
    backend         TEXT NOT NULL DEFAULT '',
    started_ms      INTEGER NOT NULL DEFAULT 0,
    heartbeat_ms    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, message_id)
);
-- The icon of an organisation that mails the user, fetched from its own domain (see
-- `sender_icon`). Durable, and that is the point rather than a convenience: this is
-- the one place the app requests something from a stranger's server, so the row is
-- what makes it happen ONCE per organisation instead of once per mail — and a row
-- with no `bytes` is the cached answer "this domain serves none", which is the
-- answer for 7 senders in 18 and must not be asked again either.
CREATE TABLE IF NOT EXISTS sender_icons (
    -- The REGISTRABLE domain, lowercased — never a subdomain, because a per-recipient
    -- host is exactly what must never be requested.
    domain       TEXT PRIMARY KEY,
    content_type TEXT NOT NULL DEFAULT '',
    bytes        BLOB,
    fetched_ms   INTEGER NOT NULL DEFAULT 0
);
"#;

/// Indexes, applied AFTER [`migrate`] because several of them cover columns that a
/// legacy store only grows once the guarded ALTERs have run (`sender_mri`,
/// `is_pinned`). Every one of them exists to keep a hot read path off a table scan
/// — the plans they enforce are asserted by the tests at the bottom of this file.
const INDEXES: &str = r#"
-- Serves the message pages (`conversation_id` + `seq` ordering) AND makes the two
-- correlated lookups in `conversations()` (1:1 title, avatar MRI) index-only, so
-- listing the sidebar never touches the messages table itself.
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq_sender ON messages(conversation_id, seq, sender, sender_mri);
-- Superseded by the index above: same leading columns, so it only cost writes.
DROP INDEX IF EXISTS idx_msg_conv_seq;
-- `display_name_for_mri` runs on every typing frame and once per read receipt;
-- without this it scanned every message row and sorted the matches.
CREATE INDEX IF NOT EXISTS idx_msg_sender_mri ON messages(sender_mri, seq);
-- The sidebar's exact ORDER BY, so listing conversations needs no temp b-tree.
CREATE INDEX IF NOT EXISTS idx_conv_sidebar_order ON conversations(is_pinned DESC, last_message_time DESC, id ASC);
-- The mail list's exact ORDER BY and its keyset paging predicate, so neither the
-- first page nor a scroll-up ever scans the folder. `body_html` is deliberately not
-- covered: a list read never touches it (bodies are up to ~135 KB each).
CREATE INDEX IF NOT EXISTS idx_mail_folder_received ON mail_messages(folder_id, received DESC, id ASC);
-- The mail a folder's unread count has to discount: read HERE while the server still
-- calls it unread (see `Store::mail_folders`). PARTIAL, so it holds only the handful
-- of rows the user has opened in this app since the mailbox last caught up — the
-- count then costs an index lookup per folder instead of a scan of the mirror.
CREATE INDEX IF NOT EXISTS idx_mail_local_read ON mail_messages(folder_id)
    WHERE local_read = 1 AND is_read = 0;
-- Every calendar read is a range scan over `start_utc` (a view's window, and the
-- window a sync reconciles), so without this each one scans the whole calendar.
-- The trailing columns are the rest of the read's shape: `end_utc` completes the
-- overlap predicate, `id` completes its ORDER BY (without it the last term needs a
-- temp b-tree), and `calendar_id` serves the visible-calendars filter.
CREATE INDEX IF NOT EXISTS idx_calendar_event_range ON calendar_events(start_utc, end_utc, id, calendar_id);
"#;

/// Version of everything the file must physically contain: `SCHEMA`, [`migrate`]
/// and `INDEXES`. Recorded in SQLite's `user_version` header field so that pass
/// runs ONCE per store instead of on every open — which is what makes it safe to
/// put index DDL and `ANALYZE` in it (re-running those per open would be a real
/// regression, whereas re-running the schema batch and ~25 ALTERs that all fail
/// with "duplicate column" was merely pointless). Bump it whenever any of the
/// three change.
///
/// v2 adds the read-only Outlook mirror (`mail_folders`, `mail_messages` and their
/// index). Bumping the version is what makes an existing store grow them: `open`
/// re-runs `initialize`, whose `CREATE TABLE IF NOT EXISTS` batch adds the new
/// tables and leaves every existing one untouched.
///
/// v3 adds `messages.messagetype`, so a `Text` body can be told apart from HTML.
/// A store that already sat at v2 has to run the pass again to grow the column,
/// which is exactly what a fresh bump buys.
///
/// v4 adds the read-only calendar mirror (`calendars`, `calendar_events`,
/// `calendar_months` and their index), the same way.
///
/// v5 adds the Web Push tables (`push_subscriptions`, `push_deliveries`), so a
/// phone that installed the app keeps its subscription across restarts.
///
/// v6 adds `conversations.picture_url`, the picture a group chat's members gave it.
/// Without the bump an existing store never grows the column and every query that
/// names it fails outright — the sidebar goes empty, which is how this was caught.
///
/// v7 adds `local_read_time` / `local_read_ghost` on `conversations` AND `channels`,
/// our own read position (see [`read_state`]). Shipped without the bump first, with
/// exactly the v6 consequence: the user's store kept the old column set and both
/// sidebar queries failed outright. Hence [`schema_columns_are_pinned_to_the_version`],
/// which now refuses the next such change mechanically.
///
/// v9 adds `channels.team_collapsed`, the parent team's fold state in the user's own
/// Teams client. Additive, so an older binary keeps working on a v9 store.
///
/// v10 adds `agent_runs`, the runs in flight, so a run killed by a restart can be told
/// from one still writing. A whole new table rather than columns, and additive: an
/// older binary never names it.
///
/// v8 renames `channels.is_favorite` to `channels.is_shown` (the CSA flag means
/// Show/Hide, not a favorites list) and adds `channels.is_pinned`, Teams' real
/// channel pin. The FIRST migration to rename rather than add, so it is also the
/// first that an OLDER binary cannot read: a backend still running the previous
/// build queries `is_favorite` and gets nothing. Restart every backend that shares
/// the store — the always-on service does it on re-stage.
///
/// v11 adds `mail_messages.local_read` and its partial index, our own read mark on a
/// mail (the mailbox itself stays read-only — see [`Store::mark_mail_read_locally`]).
/// Additive, so an older binary keeps working on a v11 store.
///
/// v12 adds `person_overrides` — the name and the face the USER gave somebody — and
/// `last_message_sender_mri` on `conversations` and `channels`, so the sidebar's
/// preview attribution can follow a nickname. Additive on both counts: an older
/// binary names neither, and a store with no overrides reads exactly as before.
///
/// v13 adds `sender_icons`, the icon of an organisation that mails the user (see
/// [`Store::sender_icon`]). A whole new table rather than columns, and additive: an
/// older binary never names it.
const SCHEMA_VERSION: i64 = 14;

/// Revision of the one-shot legacy cleanups the server runs at startup
/// ([`Store::reparent_thread_link_messages`], [`Store::purge_control_frames`],
/// [`Store::purge_payloadless_control_frames`],
/// [`Store::convert_legacy_call_events`], [`Store::convert_legacy_call_recordings`],
/// [`Store::convert_legacy_thread_activities`], [`Store::convert_legacy_cards`],
/// [`Store::blank_identity_senders`]). Each is a full scan of `content`, so they
/// are gated on this revision — recorded in `settings` once they have run —
/// instead of being replayed on every boot. Bump it when a cleanup is added or
/// broadened, and every store runs the new pass exactly once.
///
/// They REWRITE message rows, so a backend that must not write to the user's store
/// (`TEAMS_LITE_READ_ONLY=1`) skips them entirely — see `prepare_store` in
/// `src/bin/server.rs`.
pub const CLEANUP_REVISION: i64 = 3;

/// Key under which [`CLEANUP_REVISION`] is recorded once the pass has run.
const CLEANUP_SETTING: &str = "cleanup_revision";

/// Keys under which the signed-in account's own identity is remembered
/// ([`Store::remember_self`]).
const SETTING_SELF_NAME: &str = "self_name";
const SETTING_SELF_MRI: &str = "self_mri";

/// Who this store belongs to: the account's own display name and mri.
///
/// Read back by [`Store::remembered_self`] when the identity broker cannot mint a
/// token, which is what lets stored history be read during a sign-in outage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfIdentity {
    /// The account's own display name, as Teams spells it. May be empty: the mri is
    /// the reliable half, and a blank name only costs the name-based fallbacks.
    pub name: String,
    /// The account's own mri (e.g. `8:orgid:<guid>`). Never empty.
    pub mri: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub compose_time: i64,
    pub sender: String,
    /// The sender's MRI (e.g. "8:orgid:<guid>"), extracted from the message's
    /// `from` field. The reliable way to tell whose message this is — matching on
    /// `sender` (a display name) is fragile. May be empty for legacy rows stored
    /// before this column existed, or for system frames without a `from`.
    pub sender_mri: String,
    /// The Teams `messagetype` of the frame this row came from, verbatim
    /// (`Text`, `RichText/Html`, `RichText/Media_Card`, `Event/Call`, …). Two jobs:
    ///
    ///   - RENDERING. A `Text` body is plain text, NOT HTML, so parsing it as HTML
    ///     eats any angle-bracketed text the sender typed (`Vec<String>` renders as
    ///     `Vec`). The front-end needs the type to escape instead of parse.
    ///   - PROVENANCE. It is the first thing to look at when a stored row makes no
    ///     sense (an empty bubble from a real sender), and the store kept no trace
    ///     of it before.
    ///
    /// Empty for legacy rows stored before this column existed; the next sync or
    /// live update that carries the message heals it (see [`Store::insert_message`]).
    pub message_type: String,
    pub content: String,
    /// File/card attachments shared in the message, as a JSON array string (the
    /// same shape the UI receives: `[{name, content_type, url, kind}]`). Inline
    /// images embedded in `content` as `<img>` are NOT recorded here — the UI
    /// extracts and renders those from the content HTML directly. Defaults to
    /// `"[]"` for messages without attachments and for legacy rows.
    ///
    /// `kind` is `"image"`/`"file"` for a shared file, `"recording"` for a meeting
    /// recording, and `"card"` for an adaptive/connector card — which carries one
    /// extra key, `card`: `{title, text, facts:[{title,value}], actions:[{title,url}]}`
    /// (see [`crate::teams_cards`]).
    pub attachments: String,
    /// Reactions (Teams "emotions") on the message, as a JSON array string in the
    /// Teams shape: `[{"key":"like","users":[{"mri":"8:...","time":<ms>}]}]`. A
    /// key whose `users` list is empty means "nobody currently reacts with it".
    ///
    /// Sentinel: an EMPTY string (`""`) means "this frame carried no emotions
    /// information" (e.g. a plain edit `MessageUpdate`), as opposed to `"[]"`
    /// which means "explicitly no reactions". The store never persists the
    /// sentinel — [`row_to_msg`] coerces it to `"[]"` on read, and the ingestion
    /// path uses it to avoid clobbering a real reaction set with a frame that
    /// simply didn't mention reactions. Reactions arrive as full snapshots (a
    /// whole-set overwrite), never incremental deltas.
    pub reactions: String,
    /// The system/activity event this message represents, as a JSON object string,
    /// or `""` for a normal chat message. When set, the UI renders a centered
    /// system line (not a chat bubble) and `content` is empty. Two kinds, each
    /// tagged by `kind`:
    ///
    ///   - a call/meeting event —
    ///     `{"kind":"call","event":"ended|missed|started","duration_seconds":600,"participant_count":5,"participants":["…"],"participant_mris":["…"]}`;
    ///   - a thread activity (membership / pin change) —
    ///     `{"kind":"thread_activity","event":"member_added|pinned|unpinned","time_ms":<ms>,"actor_mri":"8:orgid:…","members":["…"],"member_mris":["…"]}`;
    ///   - a meeting activity (scheduled / cancelled / moved) —
    ///     `{"kind":"meeting","event":"scheduled|cancelled|updated","title":"…","start_ms":<ms>,"end_ms":<ms>,"location":"…","organizer_mri":"8:orgid:…","join_url":"https://…"}`
    ///     (see [`crate::teams_read::parse_meeting_activity`]).
    ///
    /// Legacy rows stored before this column existed carry `""` and are upgraded
    /// in place by [`Store::convert_legacy_call_events`] /
    /// [`Store::convert_legacy_thread_activities`].
    pub system_event: String,
    /// For a team-channel message, the id of the thread's ROOT message (Teams
    /// `rootMessageId` / the `;messageid=<root>` in `conversationLink`). A root
    /// message carries its OWN id here. Empty for chats/group messages and for
    /// legacy rows stored before this column existed. The UI groups a channel's
    /// flat, `seq`-ordered messages into threads by this key.
    pub thread_root_id: String,
    /// For a team-channel thread ROOT, the thread's title (Teams
    /// `properties.subject`), shown as the thread heading. Empty for replies,
    /// chats, and legacy rows.
    pub thread_subject: String,
    /// Whether the sender has DELETED this message on Teams (its `properties`
    /// carried a `deletetime`). A deleted message keeps whatever `content` we had
    /// already stored — the ingestion path never blanks it (see
    /// [`Store::insert_message`]) — so the UI can render a "message deleted"
    /// placeholder and still offer to reveal the cached original. `false` for a
    /// live message and for legacy rows stored before this column existed. A
    /// deletion that arrives for a message we never stored yields a row with
    /// `deleted: true` and empty `content` (nothing to reveal).
    pub deleted: bool,
    /// The @mentions the message body points at, as a JSON array string:
    /// `[{"itemid":0,"mri":"8:orgid:…","kind":"person","display_name":"James"}]`.
    /// A mention span in `content` carries only its `itemid`, so this is the ONLY
    /// way back from the rendered "@James" to WHO was mentioned — which is what
    /// lets the UI show a person card for a mention. Defaults to `"[]"` for
    /// messages without mentions and for legacy rows.
    pub mentions: String,
}

/// The nature of a conversation. Modeled as an enum (not a bool) because there
/// are more than two categories: a self "Notes" chat is neither a 1:1 nor a
/// group. `Unknown` is the safe fallback for a legacy row or a chat type Teams
/// introduces that we don't map yet — the UI treats it like a group (shows
/// sender names), which never hides information.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationKind {
    OneOnOne,
    Group,
    Notes,
    Unknown,
}

impl ConversationKind {
    /// Stable wire/storage token. Kept in sync with `from_str` and the UI union.
    pub fn as_str(self) -> &'static str {
        match self {
            ConversationKind::OneOnOne => "one_on_one",
            ConversationKind::Group => "group",
            ConversationKind::Notes => "notes",
            ConversationKind::Unknown => "unknown",
        }
    }

    /// Parse a stored/wire token. Anything unrecognized maps to `Unknown` rather
    /// than panicking, so an unexpected value never takes the process down.
    pub fn from_str(s: &str) -> Self {
        match s {
            "one_on_one" => ConversationKind::OneOnOne,
            "group" => ConversationKind::Group,
            "notes" => ConversationKind::Notes,
            _ => ConversationKind::Unknown,
        }
    }
}

/// How much a team channel is allowed to notify — the user's own per-channel
/// notification setting in Microsoft Teams, as CSA reports it.
///
/// Modeled as an enum (not an `is_muted` bool) because Teams offers four states,
/// and the two ends of the range mean opposite things: `Muted` must silence a
/// channel that mentions the user, while `AllNewPosts` must notify about a post
/// that mentions nobody. `MentionsOnly` is Teams' own default and the safe
/// fallback for a channel whose setting we have not seen.
///
/// Where each state comes from is documented on the CSA derivation in
/// `teams_read::channel_alerts`; the delivery rules live in
/// [`crate::push_policy`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelAlerts {
    /// The user muted this channel, or muted the whole team it belongs to.
    Muted,
    /// Only an @mention of the user notifies. Teams' default for a channel.
    MentionsOnly,
    /// Every new post notifies, replies excepted.
    AllNewPosts,
    /// Every new post AND every reply inside a post's thread notifies.
    AllNewPostsAndReplies,
}

impl ChannelAlerts {
    /// Stable wire/storage token. Kept in sync with `from_str` and the UI union.
    pub fn as_str(self) -> &'static str {
        match self {
            ChannelAlerts::Muted => "muted",
            ChannelAlerts::MentionsOnly => "mentions_only",
            ChannelAlerts::AllNewPosts => "all_new_posts",
            ChannelAlerts::AllNewPostsAndReplies => "all_new_posts_and_replies",
        }
    }

    /// Parse a stored/wire token. Anything unrecognized maps to `MentionsOnly` —
    /// Teams' own default — rather than panicking, so an unexpected value can
    /// neither take the process down nor silence a channel.
    pub fn from_str(s: &str) -> Self {
        match s {
            "muted" => ChannelAlerts::Muted,
            "all_new_posts" => ChannelAlerts::AllNewPosts,
            "all_new_posts_and_replies" => ChannelAlerts::AllNewPostsAndReplies,
            _ => ChannelAlerts::MentionsOnly,
        }
    }
}

/// A conversation row for the list pane, most-recent first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationRow {
    pub id: String,
    pub display_name: String,
    pub last_message_time: i64,
    pub kind: ConversationKind,
    /// Plain-text preview of the last message (HTML already stripped upstream).
    pub last_message_preview: String,
    /// Display name of the last message's sender (empty when unknown).
    pub last_message_sender: String,
    /// True when we sent the last message (UI renders "You:").
    pub last_message_from_me: bool,
    /// False when the conversation has unread messages. Teams' own flag OR our local
    /// read position (see `local_read_time` in the schema), so opening a thread
    /// clears the marker immediately and keeps it clear in Ghost mode.
    pub is_read: bool,
    /// True when this thread is read HERE ONLY: the user read it in Ghost mode, so
    /// Teams still holds it unread and the sender sees no read receipt.
    pub is_ghost_read: bool,
    pub is_muted: bool,
    pub is_pinned: bool,
    pub is_hidden: bool,
    pub thread_type: String,
    /// Unsent composer text, stored locally and scoped to this conversation.
    pub draft: String,
    /// For a 1:1 chat, the other party's MRI — used to fetch their profile photo.
    /// Empty for groups (no single face) and for 1:1s where we hold no message
    /// from the other party yet; the UI then falls back to tinted initials.
    pub avatar_mri: String,
    /// The picture the members gave this group chat, as an absolute media-proxy
    /// URL. Empty when the chat has none; the UI then falls back to its tinted
    /// initials. The 1:1 counterpart is `avatar_mri` — a group has no single face,
    /// but it can have a face of its own.
    pub picture_url: String,
}

/// Decide a thread's effective read state from Teams' own flag and our local read
/// position. The single place that rule lives — both list queries select the raw
/// columns and come through here, so a chat and a channel can never disagree.
///
/// A thread is read when Teams says so, OR when the user has read it here up to its
/// last message. The second half is what clears the marker the instant a thread is
/// opened (before the CSA sync catches up) and what keeps it clear in Ghost mode,
/// where Teams is never told. It is a high-water mark, so the next incoming message
/// moves `last_message_time` past it and the thread is unread again.
///
/// Returns `(is_read, is_ghost_read)`. `is_ghost_read` is the narrow case the UI
/// badges: read here only, still unread for the sender.
///
/// `local_read_time` must be a REAL position (`> 0`) to count. Zero is the column's
/// default — "never read here" — and a thread with no last message carries
/// `last_message_time = 0` too, so without that clause an unread-on-Teams thread that
/// has never been marked would read as read. A local position can only ever CLEAR a
/// marker, never raise one, so the default has to mean nothing at all.
fn read_state(
    teams_is_read: bool,
    local_read_time: i64,
    local_read_ghost: bool,
    last_message_time: i64,
) -> (bool, bool) {
    let read_locally = local_read_time > 0 && local_read_time >= last_message_time;
    (teams_is_read || read_locally, !teams_is_read && read_locally && local_read_ghost)
}

/// Rich conversation metadata from a CSA sync, fed to [`Store::upsert_conversation_full`].
/// Grouped into a struct rather than a long positional argument list so callers
/// can't transpose fields, and so adding a sidebar field is a one-line change.
///
/// Only the CSA sync path (`persist_conversations`) has this data. Live trouter
/// events and name resolution use [`Store::upsert_conversation`], which leaves
/// every field here untouched.
#[derive(Debug, Clone)]
pub struct ConversationUpdate<'a> {
    pub id: &'a str,
    pub display_name: &'a str,
    pub last_message_time: i64,
    pub kind: ConversationKind,
    pub last_message_preview: &'a str,
    pub last_message_sender: &'a str,
    /// Who wrote the preview, as an MRI, so the sidebar's attribution follows a
    /// nickname. Empty when the frame carried no `from`.
    pub last_message_sender_mri: &'a str,
    pub last_message_from_me: bool,
    pub is_read: bool,
    pub is_muted: bool,
    pub is_pinned: bool,
    pub is_hidden: bool,
    pub thread_type: &'a str,
    /// The group chat's own picture as an absolute media-proxy URL, or "" when it
    /// has none. Written verbatim — including empty — so a picture the members
    /// REMOVE disappears on the next sync instead of lingering forever.
    pub picture_url: &'a str,
}

/// A channel row for the sidebar's channel tree, carrying the same preview/unread
/// fields as [`ConversationRow`] plus its team grouping. Its `draft` is stored on
/// the row (composer text is per-thread, chat or channel alike).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelRow {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    /// The parent team's AAD group id (bare GUID), used to fetch the team photo.
    /// Empty when CSA omits it; the UI then keeps the tinted `#` glyph.
    pub team_group_id: String,
    pub display_name: String,
    pub is_general: bool,
    /// Whether Teams shows the channel in the team list; see
    /// [`crate::teams_read::Channel::is_shown`].
    pub is_shown: bool,
    /// Whether the user pinned the channel in Teams; see
    /// [`crate::teams_read::Channel::is_pinned`].
    pub is_pinned: bool,
    /// Whether the user has this channel's TEAM folded in their own Teams client; see
    /// [`crate::teams_read::Team::is_collapsed`]. Every channel of a team carries the
    /// same value.
    pub team_collapsed: bool,
    pub last_message_time: i64,
    pub last_message_preview: String,
    pub last_message_sender: String,
    pub last_message_from_me: bool,
    /// False when the channel has unread messages — Teams' own flag OR our local read
    /// position, exactly as on [`ConversationRow::is_read`].
    pub is_read: bool,
    /// True when the channel is read HERE ONLY (Ghost mode). See
    /// [`ConversationRow::is_ghost_read`].
    pub is_ghost_read: bool,
    /// What the user's own Microsoft Teams notification setting allows here.
    pub alerts: ChannelAlerts,
    /// Unsent composer text, stored locally and scoped to this channel.
    pub draft: String,
}

/// Rich channel metadata from a CSA sync, fed to [`Store::upsert_channel_full`].
/// Mirrors [`ConversationUpdate`] but for channels; `draft` is deliberately NOT
/// here — network syncs never write a local draft (same rule as conversations).
#[derive(Debug, Clone)]
pub struct ChannelUpdate<'a> {
    pub id: &'a str,
    pub team_id: &'a str,
    pub team_name: &'a str,
    /// The parent team's AAD group id (bare GUID) for team-photo fetches.
    pub team_group_id: &'a str,
    pub display_name: &'a str,
    pub is_general: bool,
    pub is_shown: bool,
    pub is_pinned: bool,
    pub last_message_time: i64,
    pub last_message_preview: &'a str,
    pub last_message_sender: &'a str,
    /// Who wrote the preview, as an MRI. Same job as on [`ConversationUpdate`].
    pub last_message_sender_mri: &'a str,
    pub last_message_from_me: bool,
    pub is_read: bool,
    /// Zero-based index of the parent team in the CSA `teams` array. Drives the
    /// sidebar's team ordering, because CSA states no rank of its own (see the
    /// `channels` DDL above).
    pub team_pos: i64,
    /// Zero-based index of the channel within its team's `channels` array. General is
    /// still pinned first by the query — CSA does not put it there.
    pub channel_pos: i64,
    /// What the user's own Microsoft Teams notification setting allows here.
    pub alerts: ChannelAlerts,
    /// The parent team's fold state in the user's own Teams client, denormalized onto
    /// every channel of the team (see [`ChannelRow::team_collapsed`]).
    pub team_collapsed: bool,
}

/// A mail folder row for the sidebar, in `position` order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailFolderRow {
    pub id: String,
    /// The folder's own, localized name (what Outlook shows).
    pub display_name: String,
    /// Stable English label for a well-known folder ("Inbox", …), else empty.
    pub well_known: String,
    pub total_count: i64,
    /// What the badge shows: the mailbox's own unread count, less the mail read HERE
    /// that the mailbox still calls unread (see [`Store::mail_folders`]).
    pub unread_count: i64,
    pub position: i64,
    /// Oldest message held locally (ISO 8601 UTC), or empty when the folder has
    /// never been paged. The keyset from which a scroll-up continues.
    pub oldest_received: String,
    /// Whether the server has anything older than [`Self::oldest_received`].
    pub has_more_older: bool,
}

/// Folder metadata from a network sync, fed to [`Store::upsert_mail_folder`].
/// Grouped like [`ConversationUpdate`] so callers cannot transpose fields. The
/// history frontier is deliberately absent: it is local paging state, and a folder
/// sync must never reset it (see [`Store::set_mail_frontier`]).
#[derive(Debug, Clone)]
pub struct MailFolderUpdate<'a> {
    pub id: &'a str,
    pub display_name: &'a str,
    pub well_known: &'a str,
    pub total_count: i64,
    pub unread_count: i64,
    pub position: i64,
}

/// One mail as the store holds it: the list fields, plus the cached body once it
/// has been opened. `body_loaded` is what separates "never fetched" from "fetched
/// and empty" — a real case (a mail whose entire content was remote images).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailMessageRow {
    pub id: String,
    pub folder_id: String,
    pub conversation_id: String,
    pub subject: String,
    pub from_name: String,
    pub from_address: String,
    /// JSON array of `{name, address}`.
    pub to_addresses: String,
    /// JSON array of `{name, address}`.
    pub cc_addresses: String,
    /// ISO 8601 UTC, whole seconds — the ordering and paging key.
    pub received: String,
    /// The MAILBOX's own read flag (Graph's `isRead`). Not what the UI shows on its
    /// own — see [`MailMessageRow::is_read`].
    pub is_read_on_server: bool,
    /// True when the user opened this mail HERE while the mailbox still called it
    /// unread. Local for good: nothing publishes it, so Outlook keeps the mail
    /// unread and its sender learns nothing (see
    /// [`Store::mark_mail_read_locally`]).
    pub is_read_locally: bool,
    pub has_attachments: bool,
    pub importance: String,
    pub preview: String,
    pub body_html: String,
    pub body_loaded: bool,
    pub blocked_remote_images: i64,
    pub body_truncated: bool,
    /// JSON array of `{id, name, content_type, size, is_inline}`.
    pub attachments: String,
}

impl MailMessageRow {
    /// The read state to show: read in the mailbox, OR read here. The single place
    /// that rule lives, so a list row, a reading pane and a folder's unread count
    /// can never disagree — the mail analogue of [`read_state`] for a thread.
    pub fn is_read(&self) -> bool {
        self.is_read_on_server || self.is_read_locally
    }
}

/// One mail's list fields from a network fetch, fed to
/// [`Store::upsert_mail_message`]. The body is NOT here: it is fetched separately
/// and written by [`Store::set_mail_body`], so re-syncing a list never discards a
/// body we already rendered and cached.
#[derive(Debug, Clone)]
pub struct MailMessageUpdate<'a> {
    pub id: &'a str,
    pub folder_id: &'a str,
    pub conversation_id: &'a str,
    pub subject: &'a str,
    pub from_name: &'a str,
    pub from_address: &'a str,
    pub to_addresses: &'a str,
    pub cc_addresses: &'a str,
    pub received: &'a str,
    pub is_read: bool,
    pub has_attachments: bool,
    pub importance: &'a str,
    pub preview: &'a str,
}

/// A rendered body to cache, from [`crate::mail_html::SanitizedBody`] plus the
/// message's attachment list.
#[derive(Debug, Clone)]
pub struct MailBodyUpdate<'a> {
    pub html: &'a str,
    pub blocked_remote_images: i64,
    pub truncated: bool,
    pub attachments: &'a str,
}

/// One calendar row, in sidebar order (default calendar first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarRow {
    pub id: String,
    pub name: String,
    pub hex_color: String,
    pub is_default: bool,
    pub can_edit: bool,
    pub position: i64,
}

/// Calendar metadata from a network sync, fed to [`Store::upsert_calendar`].
#[derive(Debug, Clone)]
pub struct CalendarUpdate<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub hex_color: &'a str,
    pub is_default: bool,
    pub can_edit: bool,
    pub position: i64,
}

/// One event as the store holds it. Attendees and categories stay JSON strings all
/// the way to the UI, exactly like a mail's recipient lists: nothing in the backend
/// looks inside them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarEventRow {
    pub id: String,
    pub calendar_id: String,
    pub subject: String,
    pub preview: String,
    pub start_utc: String,
    /// EXCLUSIVE end (Graph's convention), kept verbatim.
    pub end_utc: String,
    pub is_all_day: bool,
    pub is_cancelled: bool,
    pub is_organizer: bool,
    pub organizer_name: String,
    pub organizer_address: String,
    pub location: String,
    pub join_url: String,
    pub web_link: String,
    pub show_as: String,
    pub response: String,
    pub series: String,
    pub recurrence: String,
    pub importance: String,
    pub sensitivity: String,
    pub categories: String,
    pub attendees: String,
    pub attendee_count: i64,
    pub has_attachments: bool,
    pub reminder_minutes: i64,
}

/// One event from a network fetch, fed to [`Store::upsert_calendar_event`].
#[derive(Debug, Clone)]
pub struct CalendarEventUpdate<'a> {
    pub id: &'a str,
    pub calendar_id: &'a str,
    pub subject: &'a str,
    pub preview: &'a str,
    pub start_utc: &'a str,
    pub end_utc: &'a str,
    pub is_all_day: bool,
    pub is_cancelled: bool,
    pub is_organizer: bool,
    pub organizer_name: &'a str,
    pub organizer_address: &'a str,
    pub location: &'a str,
    pub join_url: &'a str,
    pub web_link: &'a str,
    pub show_as: &'a str,
    pub response: &'a str,
    pub series: &'a str,
    pub recurrence: &'a str,
    pub importance: &'a str,
    pub sensitivity: &'a str,
    pub categories: &'a str,
    pub attendees: &'a str,
    pub attendee_count: i64,
    pub has_attachments: bool,
    pub reminder_minutes: i64,
}

/// One device subscribed to push notifications, as stored.
///
/// `p256dh`/`auth` are the device's own encryption keys: the payload is encrypted
/// to them, so the push service in the middle forwards bytes it cannot read (see
/// the [`crate::push`] module doc).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushSubscriptionRow {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub label: String,
    pub created_ms: i64,
    pub last_ok_ms: i64,
    pub last_error: String,
}

/// One agent run in flight, as stored (see the `agent_runs` note in [`SCHEMA`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRun {
    pub conversation_id: String,
    /// The posted message the answer is being edited into.
    pub message_id: String,
    /// The trigger's message id — the `run_id` an `agent_stream` frame carries.
    pub trigger_id: String,
    pub backend: String,
    pub started_ms: i64,
    pub heartbeat_ms: i64,
}

/// What the user decided to call somebody, and the face they gave them — the whole
/// row, avatar bytes included. See the `person_overrides` note in [`SCHEMA`].
///
/// A row always overrides at least one of the two: `display_name` is empty when only
/// the picture was replaced, and `avatar_bytes` is empty when only the name was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonOverride {
    pub mri: String,
    pub display_name: String,
    pub avatar_content_type: String,
    pub avatar_bytes: Vec<u8>,
    pub updated_at: i64,
}

/// One override without its avatar bytes, for listing them all. `has_avatar` is what
/// the UI needs to say "a picture is set"; fetching it is a separate, per-person read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonOverrideSummary {
    pub mri: String,
    pub display_name: String,
    pub has_avatar: bool,
    pub updated_at: i64,
}

pub struct Store {
    conn: Connection,
}

/// SQL for "the name the user gave this person, or the one Teams gave them".
///
/// `$mri` and `$name` are the column references holding the person's MRI and their
/// Teams-sourced display name. It builds a `COALESCE` over a primary-key lookup in
/// `person_overrides`, so it costs one index probe on a table that stays EMPTY unless
/// the user renamed somebody.
///
/// It exists as a macro rather than a function so the result is still a `&'static str`
/// and can be baked into the `const` column lists below. That matters: putting the
/// resolution in the column list is what makes EVERY read state the chosen name — a
/// message page, a single row re-read after an edit, the row a push notification is
/// built from — instead of leaving each of a dozen callers to remember.
///
/// The name is a local override and never travels back to Teams. See the
/// `person_overrides` note in [`SCHEMA`].
macro_rules! nicknamed {
    ($mri:expr, $name:expr) => {
        concat!(
            "COALESCE(NULLIF((SELECT o.display_name FROM person_overrides o WHERE o.mri = ",
            $mri,
            "), ''), ",
            $name,
            ")"
        )
    };
}

/// The other party of a 1:1 chat, as a scalar subquery correlated on `c` (the
/// `conversations` row) and on `?1` (our own display name): the newest message sender
/// who is not us. NULL for anything but a 1:1, because a group has no single face and
/// no single name.
///
/// Written once and used twice by [`Store::conversations`] — for the photo it hands
/// the UI, and for the nickname that titles the row — so the two can never disagree
/// about which person a 1:1 is with.
const OTHER_PARTY_MRI: &str = "SELECT messages.sender_mri FROM messages
     WHERE c.kind = 'one_on_one'
       AND messages.conversation_id = c.id
       AND messages.sender_mri IS NOT NULL AND messages.sender_mri <> ''
       AND messages.sender <> '' AND messages.sender <> ?1
     ORDER BY messages.seq DESC LIMIT 1";

fn row_to_msg(row: &Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        seq: row.get(2)?,
        compose_time: row.get(3)?,
        sender: row.get(4)?,
        sender_mri: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        message_type: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        content: row.get(7)?,
        attachments: row
            .get::<_, Option<String>>(8)?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".to_string()),
        reactions: row
            .get::<_, Option<String>>(9)?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".to_string()),
        system_event: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        thread_root_id: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
        thread_subject: row.get::<_, Option<String>>(12)?.unwrap_or_default(),
        deleted: row.get::<_, Option<i64>>(13)?.unwrap_or(0) != 0,
        mentions: row
            .get::<_, Option<String>>(14)?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".to_string()),
    })
}

/// The columns [`row_to_msg`] reads, in its order. `sender` is resolved through the
/// user's own nickname for the author (see [`nicknamed`]) rather than read raw, so a
/// person the user renamed is renamed on every message of theirs ever stored — which
/// is the only way a rename can hold, since [`Store::insert_message`] freezes a
/// message's `sender` at first insert and no sync ever refreshes it.
const SELECT_COLS: &str = concat!(
    "id, conversation_id, seq, compose_time, ",
    nicknamed!("messages.sender_mri", "sender"),
    ", sender_mri, messagetype, content, attachments, reactions, system_event, thread_root_id, thread_subject, deleted, mentions"
);

fn row_to_mail(row: &Row) -> rusqlite::Result<MailMessageRow> {
    Ok(MailMessageRow {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        conversation_id: row.get(2)?,
        subject: row.get(3)?,
        from_name: row.get(4)?,
        from_address: row.get(5)?,
        to_addresses: row.get(6)?,
        cc_addresses: row.get(7)?,
        received: row.get(8)?,
        is_read_on_server: row.get::<_, i64>(9)? != 0,
        has_attachments: row.get::<_, i64>(10)? != 0,
        importance: row.get(11)?,
        preview: row.get(12)?,
        body_html: row.get(13)?,
        body_loaded: row.get::<_, i64>(14)? != 0,
        blocked_remote_images: row.get(15)?,
        body_truncated: row.get::<_, i64>(16)? != 0,
        attachments: row.get(17)?,
        is_read_locally: row.get::<_, i64>(18)? != 0,
    })
}

const MAIL_SELECT_COLS: &str = "id, folder_id, conversation_id, subject, from_name, from_address, to_addresses, cc_addresses, received, is_read, has_attachments, importance, preview, body_html, body_loaded, blocked_remote_images, body_truncated, attachments, local_read";

fn row_to_event(row: &Row) -> rusqlite::Result<CalendarEventRow> {
    Ok(CalendarEventRow {
        id: row.get(0)?,
        calendar_id: row.get(1)?,
        subject: row.get(2)?,
        preview: row.get(3)?,
        start_utc: row.get(4)?,
        end_utc: row.get(5)?,
        is_all_day: row.get::<_, i64>(6)? != 0,
        is_cancelled: row.get::<_, i64>(7)? != 0,
        is_organizer: row.get::<_, i64>(8)? != 0,
        organizer_name: row.get(9)?,
        organizer_address: row.get(10)?,
        location: row.get(11)?,
        join_url: row.get(12)?,
        web_link: row.get(13)?,
        show_as: row.get(14)?,
        response: row.get(15)?,
        series: row.get(16)?,
        recurrence: row.get(17)?,
        importance: row.get(18)?,
        sensitivity: row.get(19)?,
        categories: row.get(20)?,
        attendees: row.get(21)?,
        attendee_count: row.get(22)?,
        has_attachments: row.get::<_, i64>(23)? != 0,
        reminder_minutes: row.get(24)?,
    })
}

const EVENT_SELECT_COLS: &str = "id, calendar_id, subject, preview, start_utc, end_utc, is_all_day, is_cancelled, is_organizer, organizer_name, organizer_address, location, join_url, web_link, show_as, response, series, recurrence, importance, sensitivity, categories, attendees, attendee_count, has_attachments, reminder_minutes";

/// Canonicalize an MRI for identity comparison: keep only the last path segment
/// (so a `.../contacts/8:orgid:<guid>` URL becomes a bare MRI) and drop a leading
/// `8:` so `8:orgid:<guid>`, `orgid:<guid>` and the URL form all compare equal.
/// Teams is inconsistent about these forms across a message's `from`, the self
/// identity, and a reaction's `users[].mri`, so reaction OWNERSHIP is matched on
/// this canonical id rather than by exact string equality (which silently missed
/// our own reaction — no highlight, and the toggle re-added instead of removing).
pub fn canonical_mri(mri: &str) -> String {
    let bare = mri.rsplit('/').next().unwrap_or(mri);
    bare.strip_prefix("8:").unwrap_or(bare).to_string()
}

/// Whether two MRIs refer to the same user, tolerant of the URL / `8:` prefix
/// variations Teams mixes. Empty MRIs never match (so an unknown self identity
/// can't spuriously claim a reaction).
pub fn same_user(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && canonical_mri(a) == canonical_mri(b)
}

/// The two object ids a one-to-one thread id names, or `None` when the id is not one.
///
/// The shape is `19:<oid>_<oid>@unq.gbl.spaces`, and it is the only conversation id
/// that spells its members out — which is what [`Store::derived_self`] reads the
/// account's own oid out of. Exactly two, both non-empty and different from each
/// other: a malformed id contributes nothing rather than a wrong party.
fn one_to_one_parties(id: &str) -> Option<std::collections::BTreeSet<String>> {
    let core = id.strip_prefix("19:")?.strip_suffix("@unq.gbl.spaces")?;
    let (a, b) = core.split_once('_')?;
    if a.is_empty() || b.is_empty() || a == b || b.contains('_') {
        return None;
    }
    Some([a.to_string(), b.to_string()].into_iter().collect())
}

/// Return the emotion key our own MRI currently reacts with on a message, given
/// its stored reactions JSON, or `None` when we have no reaction. Used to decide
/// a toggle: clicking our current reaction removes it; a different key replaces
/// it (Teams allows one reaction per user per message).
pub fn my_reaction_key(reactions_json: &str, my_mri: &str) -> Option<String> {
    let arr = serde_json::from_str::<serde_json::Value>(reactions_json).ok()?;
    for entry in arr.as_array()? {
        let mine = entry
            .get("users")
            .and_then(|u| u.as_array())
            .map(|us| {
                us.iter()
                    .filter_map(|u| u.get("mri").and_then(|m| m.as_str()))
                    .any(|m| same_user(m, my_mri))
            })
            .unwrap_or(false);
        if mine {
            return entry.get("key").and_then(|k| k.as_str()).map(str::to_string);
        }
    }
    None
}

/// Pure transform: apply our own reaction to a reactions snapshot and return the
/// new JSON. `key = Some(k)` makes our reaction exactly `k` (removing us from any
/// other key); `key = None` removes it. Empty emotions (no users left) are
/// dropped so a cleared key never lingers. Best-effort: a malformed input yields
/// a fresh set rather than an error, so a surprising shape can never break
/// reacting.
fn apply_my_reaction(reactions_json: &str, my_mri: &str, key: Option<&str>, time_ms: i64) -> String {
    let mut entries: Vec<serde_json::Value> = serde_json::from_str::<serde_json::Value>(reactions_json)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();

    // One reaction per user: remove our MRI from every emotion first. Matched on
    // the canonical id so a differently-formatted stored MRI (URL form, or a
    // missing "8:" prefix) is still recognized as ours and removed — otherwise a
    // re-add would leave us listed twice under the same key.
    for entry in &mut entries {
        if let Some(users) = entry.get_mut("users").and_then(|u| u.as_array_mut()) {
            users.retain(|u| !u.get("mri").and_then(|m| m.as_str()).is_some_and(|m| same_user(m, my_mri)));
        }
    }

    // Add ourselves under the requested key, creating the entry if needed.
    if let Some(k) = key {
        let me = serde_json::json!({ "mri": my_mri, "time": time_ms });
        match entries
            .iter_mut()
            .find(|e| e.get("key").and_then(|x| x.as_str()) == Some(k))
            .and_then(|e| e.get_mut("users"))
            .and_then(|u| u.as_array_mut())
        {
            Some(users) => users.push(me),
            None => entries.push(serde_json::json!({ "key": k, "users": [me] })),
        }
    }

    // Drop emotions nobody reacts with anymore, so empty keys never linger.
    entries.retain(|e| {
        e.get("users")
            .and_then(|u| u.as_array())
            .map(|us| !us.is_empty())
            .unwrap_or(false)
    });

    serde_json::Value::Array(entries).to_string()
}

/// Idempotent, additive migrations for databases created before a column existed.
/// `CREATE TABLE IF NOT EXISTS` never alters an existing table, so older stores
/// miss columns added to SCHEMA. We add them here, ignoring the "duplicate column"
/// error that a fresh store (already carrying the column) returns.
fn migrate(conn: &Connection) -> Result<()> {
    // Add a column, treating "already exists" as success so migration is
    // idempotent on both fresh and legacy stores.
    let add_column = |ddl: &str| -> Result<()> {
        match conn.execute(ddl, []) {
            Ok(_) => Ok(()),
            // "duplicate column name" means the column already exists; "no such
            // table" means the table wasn't created on this connection (only
            // happens in isolated migration unit tests — `open` always runs SCHEMA,
            // which defines every table with its full current column set, before
            // migrate). Both are no-ops: an ALTER only heals a pre-existing table.
            Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                if msg.contains("duplicate column") || msg.contains("no such table") =>
            {
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    };

    // Rename a column, but only on a store that still carries the old name — the
    // table's own shape decides, so this is a no-op on a fresh store (SCHEMA already
    // declares the new name), on one that has run this pass before, and on a missing
    // table. Same idempotence contract as `add_column`, which is what makes a rename
    // safe to keep in the migration list forever. It reads `table_info` rather than
    // sniffing an error message because a failed rename is reported as an input
    // error, not as the `SqliteFailure` an ALTER's other refusals produce.
    let rename_column = |table: &str, from: &str, to: &str| -> Result<()> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns: Vec<String> =
            stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<_>>()?;
        let has = |name: &str| columns.iter().any(|c| c == name);
        if has(from) && !has(to) {
            conn.execute(&format!("ALTER TABLE {table} RENAME COLUMN {from} TO {to}"), [])?;
        }
        Ok(())
    };

    // kind: distinguishes 1:1 / group / notes conversations. Defaults to
    // 'unknown' for legacy rows; the next network sync backfills the real value.
    add_column("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown'")?;
    // sender_mri: the sender's MRI, used to reliably tag a message as ours
    // (sender_mri == our own MRI). Legacy rows get NULL; the next network sync
    // backfills it for messages that come through again.
    add_column("ALTER TABLE messages ADD COLUMN sender_mri TEXT")?;
    // attachments: file/card attachments as a JSON array string. Legacy rows and
    // messages without attachments carry the empty-array default.
    add_column("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")?;
    // reactions: Teams "emotions" as a JSON array string. Legacy rows and
    // messages without reactions carry the empty-array default; the next network
    // sync or a live MessageUpdate backfills the real set.
    add_column("ALTER TABLE messages ADD COLUMN reactions TEXT NOT NULL DEFAULT '[]'")?;
    // system_event: a structured system/activity event (currently call events) as
    // a JSON object string, rendered by the UI as a centered line. Legacy rows get
    // the empty default; `convert_legacy_call_events` upgrades raw call-event XML.
    add_column("ALTER TABLE messages ADD COLUMN system_event TEXT NOT NULL DEFAULT ''")?;
    // Channel-thread linkage: the thread root's message id and (on the root) its
    // subject/title. Legacy channel rows get the empty default and simply fall
    // back to ungrouped rendering until the next network sync re-inserts them.
    add_column("ALTER TABLE messages ADD COLUMN thread_root_id TEXT NOT NULL DEFAULT ''")?;
    add_column("ALTER TABLE messages ADD COLUMN thread_subject TEXT NOT NULL DEFAULT ''")?;
    // deleted: set when the sender deletes a message on Teams (its `properties`
    // carried a `deletetime`). Legacy rows default to 0 (not deleted); the flag
    // is set in place on the next sync/live update that carries the deletion.
    add_column("ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")?;
    // mentions: who the body's @mention spans point at, as a JSON array string.
    // Legacy rows and messages without mentions carry the empty-array default;
    // `backfill_mentions` heals a legacy row on the next sync that carries them.
    add_column("ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'")?;
    // messagetype: the Teams frame type, verbatim. The front-end needs it to render
    // a `Text` body as plain text instead of parsing it as HTML, and it is the
    // provenance an unexplainable row was missing. Legacy rows get '' and heal on
    // the next sync/live update that carries the message (see `insert_message`).
    add_column("ALTER TABLE messages ADD COLUMN messagetype TEXT NOT NULL DEFAULT ''")?;

    // Sidebar-fidelity columns (last-message preview + unread/muted/pinned/hidden
    // state), all sourced from the CSA `users/me` sync. Legacy rows get the
    // defaults below and are healed on the next sync. Defaults are chosen so a
    // pre-migration store never shows a false unread marker (is_read defaults 1).
    add_column("ALTER TABLE conversations ADD COLUMN last_message_preview TEXT NOT NULL DEFAULT ''")?;
    add_column("ALTER TABLE conversations ADD COLUMN last_message_sender TEXT NOT NULL DEFAULT ''")?;
    add_column("ALTER TABLE conversations ADD COLUMN last_message_from_me INTEGER NOT NULL DEFAULT 0")?;
    add_column("ALTER TABLE conversations ADD COLUMN is_read INTEGER NOT NULL DEFAULT 1")?;
    add_column("ALTER TABLE conversations ADD COLUMN is_muted INTEGER NOT NULL DEFAULT 0")?;
    add_column("ALTER TABLE conversations ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0")?;
    add_column("ALTER TABLE conversations ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0")?;
    add_column("ALTER TABLE conversations ADD COLUMN thread_type TEXT NOT NULL DEFAULT ''")?;
    add_column("ALTER TABLE conversations ADD COLUMN draft TEXT NOT NULL DEFAULT ''")?;

    // team_pos / channel_pos: the channel's position in the CSA `teams[].channels[]`
    // arrays, so the sidebar renders teams and channels in the user's own Microsoft
    // Teams order instead of alphabetically. Stores created before these columns
    // existed get 0 for every row (a stable, grouping-friendly default); the next
    // CSA sync backfills the real positions.
    add_column("ALTER TABLE channels ADD COLUMN team_pos INTEGER NOT NULL DEFAULT 0")?;
    add_column("ALTER TABLE channels ADD COLUMN channel_pos INTEGER NOT NULL DEFAULT 0")?;

    // team_group_id: the parent team's AAD group id, used to fetch the team photo.
    // Stores created before this column existed get '' (no photo → tinted glyph);
    // the next CSA sync backfills the real id.
    add_column("ALTER TABLE channels ADD COLUMN team_group_id TEXT NOT NULL DEFAULT ''")?;

    // picture_url: a group chat's own uploaded picture. Stores created before this
    // column existed get '' (no picture → tinted initials, exactly what they showed
    // already); the next CSA sync backfills the real URL.
    add_column("ALTER TABLE conversations ADD COLUMN picture_url TEXT NOT NULL DEFAULT ''")?;

    // alerts: the user's own per-channel notification setting (see `ChannelAlerts`).
    // Stores created before this column existed get Teams' default, so a channel
    // keeps notifying on an @mention and nothing else until the next CSA sync
    // reports what the user actually chose.
    add_column("ALTER TABLE channels ADD COLUMN alerts TEXT NOT NULL DEFAULT 'mentions_only'")?;

    // is_shown: the column that used to be called `is_favorite`, after the CSA key it
    // is read from. The name was a mistranslation — `isFavorite` is Teams' Show/Hide
    // switch, true on most channels — and it made the sidebar lift half the user's
    // channels into a "Favorites" group Teams has no equivalent of. The values carry
    // over unchanged; only what they mean (and where they render) is corrected.
    rename_column("channels", "is_favorite", "is_shown")?;
    // A store so old it has neither name gets the column outright.
    add_column("ALTER TABLE channels ADD COLUMN is_shown INTEGER NOT NULL DEFAULT 1")?;
    // is_pinned: the real Teams channel pin, which the parser never read before.
    // Legacy rows get 0 — nothing is pinned until the next CSA sync says so, which is
    // also what this tenant reports (0 of 75 channels).
    add_column("ALTER TABLE channels ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0")?;
    // team_collapsed: the parent team's own fold state in the user's Teams client.
    // Legacy rows get 0, so every team stays expanded until the next CSA sync reports
    // what the user actually left folded.
    add_column("ALTER TABLE channels ADD COLUMN team_collapsed INTEGER NOT NULL DEFAULT 0")?;

    // local_read_time / local_read_ghost: our own read position, held locally (see the
    // DDL above). Legacy rows get 0/0, which means "never read here" — so the marker
    // keeps coming from Teams alone until the user next opens the thread. That is the
    // safe default: 0 can only ever ADD an unread marker, never hide one.
    for table in ["conversations", "channels"] {
        add_column(&format!(
            "ALTER TABLE {table} ADD COLUMN local_read_time INTEGER NOT NULL DEFAULT 0"
        ))?;
        add_column(&format!(
            "ALTER TABLE {table} ADD COLUMN local_read_ghost INTEGER NOT NULL DEFAULT 0"
        ))?;
    }

    // mail_messages.local_read: our own read mark on a mail, held locally (see the
    // DDL above). Legacy rows get 0 — "never read here" — so every mail keeps the
    // read state the mailbox itself reports until the user next opens one. Like the
    // thread columns above, 0 can only ever leave an unread marker standing, never
    // hide one.
    add_column("ALTER TABLE mail_messages ADD COLUMN local_read INTEGER NOT NULL DEFAULT 0")?;

    // last_message_sender_mri: the identity behind the sidebar preview's "Bob: hello"
    // attribution, so it follows a `person_overrides` nickname. Legacy rows get '',
    // which simply means the preview keeps the Teams-sourced name until the next sync
    // — the same thing they showed before the column existed.
    for table in ["conversations", "channels"] {
        add_column(&format!(
            "ALTER TABLE {table} ADD COLUMN last_message_sender_mri TEXT NOT NULL DEFAULT ''"
        ))?;
    }
    Ok(())
}

/// Settings that live on the CONNECTION and must therefore be re-applied by every
/// opener. `journal_mode` deliberately is not among them: it is a persistent
/// property of the file, so it is set once in [`initialize`].
fn tune(conn: &Connection) -> Result<()> {
    // Wait for a concurrent writer instead of failing outright.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    // In WAL mode `NORMAL` stops fsync-ing on every commit (the WAL is still
    // fsynced at checkpoints), which is what makes batched ingestion viable:
    // under the default `FULL`, one commit per row cost ~3.6 ms, so a 50-message
    // history page took 184 ms and a full conversation sync 2.2 s. The trade is
    // bounded and acceptable here: an OS crash or power loss can lose the newest
    // commits but can NEVER corrupt the file, and everything stored is a cache
    // that re-syncs from Teams.
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Every statement in this file goes through the cache (see `Store::exec` /
    // `Store::query_one`), so it must be large enough to hold them all: the hot
    // paths reuse one connection, and re-parsing the multi-kilobyte upserts cost
    // more than executing them (604 conversation upserts: 28 ms -> 5.4 ms).
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
}

/// Bring the file up to [`SCHEMA_VERSION`]: tables, additive column migrations,
/// indexes, planner statistics. Runs on a fresh store and once after an upgrade,
/// never on a steady-state open.
fn initialize(conn: &Connection) -> Result<()> {
    // WAL lets a reader (UI thread) and a writer (network thread) use separate
    // connections to the same file concurrently without blocking each other.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(SCHEMA)?;
    migrate(conn)?;
    conn.execute_batch(INDEXES)?;
    // Give the planner real statistics for the freshly created indexes; without
    // them it falls back on guesses for the sidebar's correlated subqueries.
    conn.execute_batch("ANALYZE")?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

impl Store {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        tune(&conn)?;
        // Self-healing rather than order-dependent: any opener may be the first
        // one, so a store that is missing the current schema gets it here.
        if conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? != SCHEMA_VERSION {
            initialize(&conn)?;
        }
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        tune(&conn)?;
        // A fresh in-memory database is never initialized, so skip the version
        // probe and build the schema outright (WAL is a no-op on `:memory:`).
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        conn.execute_batch(INDEXES)?;
        Ok(Self { conn })
    }

    /// Run `f` as ONE transaction: a single commit instead of one per statement.
    /// Every store method `f` calls joins it (they all share `self.conn`), and an
    /// `Err` rolls the whole batch back — so a caller ingesting a page either
    /// persists all of it or none of it.
    ///
    /// This is the difference between 184 ms and 1.6 ms for a 50-message page:
    /// autocommit made every row its own WAL commit.
    pub fn transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let tx = self.conn.unchecked_transaction()?;
        let out = f()?;
        tx.commit()?;
        Ok(out)
    }

    /// Refresh stale planner statistics. `PRAGMA optimize` only does work for
    /// tables whose contents have drifted far from the last `ANALYZE`, so the
    /// server can call it once per boot for the cost of a few reads.
    pub fn optimize(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA optimize")?;
        Ok(())
    }

    /// Whether the one-shot legacy cleanups still need to run on this store (see
    /// [`CLEANUP_REVISION`]). True on a store that has never recorded a revision,
    /// or recorded an older one.
    pub fn cleanups_pending(&self) -> Result<bool> {
        let done = self
            .get_setting(CLEANUP_SETTING)?
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        Ok(done < CLEANUP_REVISION)
    }

    /// Record that the one-shot legacy cleanups have run, so later boots skip them.
    pub fn mark_cleanups_done(&self) -> Result<()> {
        self.set_setting(CLEANUP_SETTING, &CLEANUP_REVISION.to_string())
    }

    /// Execute a write through the prepared-statement cache; returns rows changed.
    fn exec(&self, sql: &str, params: &[&dyn ToSql]) -> rusqlite::Result<usize> {
        self.conn.prepare_cached(sql)?.execute(params)
    }

    /// Read a single row through the prepared-statement cache.
    fn query_one<T>(
        &self,
        sql: &str,
        params: &[&dyn ToSql],
        f: impl FnOnce(&Row) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        self.conn.prepare_cached(sql)?.query_row(params, f)
    }

    /// Delete control/system frames that older builds persisted as chat messages,
    /// before ingestion started gating on `messagetype`. Three shapes leaked in:
    ///   - typing/presence pushes whose body is a bare Skype notifications
    ///     endpoint URL (`https://notifications.skype.net/…`),
    ///   - `ThreadActivity` member/topic/policy changes whose body is a raw system
    ///     XML frame (`<partlist>`, `<addmember>`, `<topicupdate>`,
    ///     `<meetingpolicyupdated>`, …), and
    ///   - the same typing/presence pushes with an EMPTY body, which render as a
    ///     blank bubble (see [`Store::purge_payloadless_control_frames`]).
    ///
    /// Call/meeting events are NOT deleted here — they carry useful information and
    /// are upgraded into structured `system_event` rows by
    /// [`Store::convert_legacy_call_events`] instead.
    ///
    /// A legitimate `RichText/Html` body never starts with any of these tokens
    /// (it begins with text or a standard HTML tag), a media/card body is a
    /// `<URIObject>`, and chat content is never a bare push endpoint URL, so the
    /// match cannot hit a real message. Meant to run once at startup (like the
    /// `48:notifications` cleanup); idempotent, so a cleaned store deletes nothing
    /// on a later run. Returns rows removed. `LIKE` is ASCII case-insensitive in
    /// SQLite, so tag casing needs no extra patterns.
    pub fn purge_control_frames(&self) -> Result<usize> {
        let n = self.exec(
            "DELETE FROM messages WHERE
                 content LIKE 'https://notifications.skype.net/%'
              OR content LIKE '<partlist%'
              OR content LIKE '<addmember%'
              OR content LIKE '<deletemember%'
              OR content LIKE '<topicupdate%'
              OR content LIKE '<historydisclosed%'
              OR content LIKE '<pictureupdate%'
              OR content LIKE '<roleupdate%'
              OR content LIKE '<joiningenabledupdate%'
              OR content LIKE '<memberjoined%'
              OR content LIKE '<meetingpolicyupdated%'",
            &[],
        )?;
        Ok(n)
    }

    /// Delete the typing/presence frames older builds stored with an EMPTY body —
    /// the ones [`Store::purge_control_frames`] cannot see because their `content`
    /// never held the endpoint URL (it was the frame's `from`). They render as an
    /// empty bubble attributed to a `notifications.skype.net/…/contacts/…` URL, or,
    /// once [`Store::blank_identity_senders`] has run, to nobody at all.
    ///
    /// The predicate is "NOTHING to render AND NOBODY to attribute it to": no body,
    /// no attachment, no system event, not a deletion (a tombstone renders a "message
    /// deleted" placeholder), no reactions (a reacted-to message was real), and an
    /// author that is either the notifications endpoint or absent. That last clause is
    /// what keeps it off the ~20 payload-less rows from REAL senders (item 10 of
    /// `TODO-message-rendering.md`): those still carry a human name, so they survive
    /// here and stay diagnosable — the fix for them is provenance (`messagetype`, the
    /// ingestion log), not deletion.
    ///
    /// Meant to run once at startup, next to [`Store::purge_control_frames`];
    /// idempotent, since it only ever removes rows. Returns rows removed.
    pub fn purge_payloadless_control_frames(&self) -> Result<usize> {
        let n = self.exec(
            "DELETE FROM messages WHERE
                 (content IS NULL OR content = '')
              AND (attachments IS NULL OR attachments IN ('', '[]'))
              AND (system_event IS NULL OR system_event = '')
              AND (reactions IS NULL OR reactions IN ('', '[]'))
              AND deleted = 0
              AND (sender IS NULL OR sender = '' OR sender LIKE 'https://notifications.skype.net/%')",
            &[],
        )?;
        Ok(n)
    }

    /// Upgrade call/meeting event rows that older builds stored raw — either the
    /// `Event/Call` XML frame or the meeting-thread JSON call marker
    /// (`{…"callId"…"meetingOrganizerId"…}`) — into the structured `system_event`
    /// form the UI renders as a centered line. Finds rows whose `content` still
    /// looks like a raw call frame and that have no `system_event` yet, re-parses
    /// each via [`crate::teams_read::parse_call_event`], then blanks the content and
    /// stores the parsed event. The `LIKE` clauses are a cheap prefilter;
    /// `parse_call_event` is the source of truth and skips anything it does not
    /// recognise (so, e.g., an unrelated JSON body is left untouched).
    ///
    /// Meant to run once at startup (next to `purge_control_frames`); idempotent —
    /// a converted row has empty content and an unparseable one is skipped, so a
    /// later run converts nothing. Returns the number of rows upgraded.
    pub fn convert_legacy_call_events(&self) -> Result<usize> {
        let rows = self.rows_matching(
            "SELECT id, conversation_id, content FROM messages
             WHERE system_event = ''
               AND (content LIKE '%<callEventType>%'
                 OR content LIKE '<ended%'
                 OR content LIKE '<started%'
                 OR (content LIKE '%callId%' AND content LIKE '%meetingOrganizerId%'))",
        )?;
        let mut converted = 0;
        for (id, conversation_id, content) in rows {
            // messagetype is unknown for a stored row, so rely on the content shape.
            let Some(event) = crate::teams_read::parse_call_event("", &content) else {
                continue;
            };
            self.exec(
                "UPDATE messages SET content = '', system_event = ?3
                 WHERE conversation_id = ?1 AND id = ?2",
                params![conversation_id, id, event.to_string()],
            )?;
            converted += 1;
        }
        Ok(converted)
    }

    /// Upgrade meeting-recording rows that older builds stored as raw
    /// `<URIObject type="Video.2/CallRecording.1">` bubbles into the media form the
    /// UI now renders (a video card). The final `Success` recording becomes an
    /// empty-body row carrying a `{kind:"recording"}` attachment (and a blanked
    /// sender, since the frame's only author hint is a bare contacts-URL `from`);
    /// the in-progress notices Teams also posts (`Initial`/`ChunkFinished`) are
    /// deleted as noise. [`crate::teams_read::parse_call_recording`] is the source
    /// of truth — a row that merely mentions the marker in real text (so it does
    /// not parse as a recording) is left untouched, never deleted.
    ///
    /// Meant to run once at startup (next to [`Store::convert_legacy_call_events`]);
    /// idempotent — an upgraded row no longer contains the marker in `content`, so
    /// a later run matches nothing. Returns `(upgraded, deleted)`.
    pub fn convert_legacy_call_recordings(&self) -> Result<(usize, usize)> {
        let rows = self.rows_matching(
            "SELECT id, conversation_id, content FROM messages
             WHERE content LIKE '%CallRecording%'",
        )?;
        let (mut upgraded, mut deleted) = (0usize, 0usize);
        for (id, conversation_id, content) in rows {
            match crate::teams_read::parse_call_recording("", &content) {
                Some(crate::teams_read::CallRecording::Ready(attachment)) => {
                    let attachments = serde_json::Value::Array(vec![attachment]).to_string();
                    self.exec(
                        "UPDATE messages SET content = '', sender = '', attachments = ?3
                         WHERE conversation_id = ?1 AND id = ?2",
                        params![conversation_id, id, attachments],
                    )?;
                    upgraded += 1;
                }
                Some(crate::teams_read::CallRecording::Pending) => {
                    self.exec(
                        "DELETE FROM messages WHERE conversation_id = ?1 AND id = ?2",
                        params![conversation_id, id],
                    )?;
                    deleted += 1;
                }
                // Not actually a recording frame (a real message that just mentions
                // the marker) — leave it exactly as it is.
                None => {}
            }
        }
        Ok((upgraded, deleted))
    }

    /// Upgrade `ThreadActivity` frames that older builds stored as a bubble of raw
    /// JSON (`{"eventtime":…,"members":[…]}` for a member added,
    /// `{"eventtime":…,"operation":"pinned"}` for a pin) into the structured
    /// `system_event` form the UI renders as a centered line. Frames we cannot label
    /// are deleted: they are machinery, and a bubble of JSON is strictly worse than
    /// nothing. The sender is blanked at the same time — these frames carry the
    /// THREAD as their `from`, so the row's author was a raw URL.
    ///
    /// [`crate::teams_read::parse_thread_activity`] is the source of truth; the
    /// `LIKE` clause is only a cheap prefilter, so a real message that merely
    /// contains the word `eventtime` is left untouched, never deleted.
    ///
    /// Meant to run once at startup (next to [`Store::convert_legacy_call_events`]);
    /// idempotent — an upgraded row has empty content, so a later run matches
    /// nothing. Returns `(upgraded, deleted)`.
    pub fn convert_legacy_thread_activities(&self) -> Result<(usize, usize)> {
        let rows = self.rows_matching(
            "SELECT id, conversation_id, content FROM messages
             WHERE system_event = '' AND content LIKE '%eventtime%'",
        )?;
        let (mut upgraded, mut deleted) = (0usize, 0usize);
        for (id, conversation_id, content) in rows {
            match crate::teams_read::parse_thread_activity(&content) {
                Some(crate::teams_read::ThreadActivity::Event(event)) => {
                    self.exec(
                        "UPDATE messages SET content = '', sender = '', system_event = ?3
                         WHERE conversation_id = ?1 AND id = ?2",
                        params![conversation_id, id, event.to_string()],
                    )?;
                    upgraded += 1;
                }
                Some(crate::teams_read::ThreadActivity::Noise) => {
                    self.exec(
                        "DELETE FROM messages WHERE conversation_id = ?1 AND id = ?2",
                        params![conversation_id, id],
                    )?;
                    deleted += 1;
                }
                // Not a thread-activity frame — a real message that just mentions the
                // word. Leave it exactly as it is.
                None => {}
            }
        }
        Ok((upgraded, deleted))
    }

    /// Upgrade adaptive/connector card rows that older builds stored as the raw
    /// `<URIObject type="SWIFT.1">` body — which renders as Skype's "Card - access it
    /// on … cards.unsupported" apology, in the bubble AND in the sidebar preview —
    /// into the structured card attachment the UI can render (see
    /// [`crate::teams_cards`]). The decoded card replaces the body, which becomes
    /// empty.
    ///
    /// [`crate::teams_cards::parse_swift_card`] is the source of truth; a row whose
    /// payload cannot be decoded keeps its fallback body rather than being emptied,
    /// so nothing is ever lost. Meant to run once at startup; idempotent — an
    /// upgraded row no longer holds a URIObject. Returns the number of rows upgraded.
    pub fn convert_legacy_cards(&self) -> Result<usize> {
        let rows = self.rows_matching(
            "SELECT id, conversation_id, content FROM messages
             WHERE content LIKE '%SWIFT.1%'",
        )?;
        let mut upgraded = 0;
        for (id, conversation_id, content) in rows {
            let Some(crate::teams_cards::SwiftCard::Card(card)) =
                crate::teams_cards::parse_swift_card(&content)
            else {
                continue;
            };
            let attachments = serde_json::Value::Array(vec![card]).to_string();
            self.exec(
                "UPDATE messages SET content = '', attachments = ?3
                 WHERE conversation_id = ?1 AND id = ?2",
                params![conversation_id, id, attachments],
            )?;
            upgraded += 1;
        }
        Ok(upgraded)
    }

    /// Blank the `sender` of rows whose author is an IDENTITY rather than a name — a
    /// `https://…/v1/users/ME/contacts/8:orgid:<guid>` contacts URL or a bare MRI.
    /// Older builds fell back to the frame's `from` when `imdisplayname` was empty
    /// (meeting scheduled/cancelled notices, thread activities, recordings), so those
    /// bubbles are attributed to a raw URL. Ingestion no longer does that (see
    /// `teams_read::sender_display_name`); this heals what is already stored.
    ///
    /// Blank is the correct value, not a placeholder: the identity still lives in
    /// `sender_mri`, and both the UI and [`Store::display_name_for_mri`] resolve a
    /// name from it. No real display name can match these patterns, so the update
    /// cannot touch a genuine author. Idempotent; returns rows healed.
    pub fn blank_identity_senders(&self) -> Result<usize> {
        let n = self.exec(
            "UPDATE messages SET sender = '' WHERE
                 sender LIKE 'http://%'
              OR sender LIKE 'https://%'
              OR sender LIKE '8:%'
              OR sender LIKE '19:%'
              OR sender LIKE '28:%'
              OR sender LIKE '48:%'",
            &[],
        )?;
        Ok(n)
    }

    /// Re-file the channel posts that older builds stored under a `;messageid=`
    /// DEEP-LINK id, then delete the pseudo-conversations those ids created.
    ///
    /// `19:<channel>@thread.tacv2;messageid=<rootId>` addresses one thread inside a
    /// channel, not a conversation: the live feed used to derive a conversation id
    /// from it verbatim (fixed in `trouter_events::conversation_id_of`), so 14 rows
    /// holding 71 channel posts had piled up in `conversations` under
    /// `kind='unknown'` while the posts were missing from their channel. This heals
    /// what is already stored: each message moves to the base thread id, taking the
    /// suffix's root id as its `thread_root_id` when it has none, and the pseudo-row
    /// is removed.
    ///
    /// A move can COLLIDE — the same post often exists under the real channel id too
    /// (37 of the 71 did), and `(conversation_id, id)` is the primary key — so the
    /// UPDATE is `OR IGNORE` (the duplicate is left behind, then deleted) rather than
    /// an error that would abort the whole migration. Nothing is lost: the surviving
    /// row is the one already filed correctly.
    ///
    /// A base id that is NOT a channel keeps its conversation row (an ordinary chat
    /// deep link): the messages are merged into it and its `last_message_time` is
    /// carried over, so they never become unreachable. Idempotent — no id contains a
    /// `;` afterwards. Returns `(messages re-filed, duplicates dropped, pseudo-rows
    /// deleted)`.
    pub fn reparent_thread_link_messages(&self) -> Result<(usize, usize, usize)> {
        let (mut moved, mut dropped, mut rows_deleted) = (0usize, 0usize, 0usize);
        for link_id in self.thread_link_ids()? {
            let base = crate::teams_read::base_thread_id(&link_id).to_string();
            if base.is_empty() || base == link_id {
                continue; // not a deep-link id after all; never touch it
            }
            let root = crate::teams_read::thread_link_root_id(&link_id).unwrap_or_default();
            moved += self.exec(
                "UPDATE OR IGNORE messages
                    SET conversation_id = ?2,
                        thread_root_id = CASE
                            WHEN thread_root_id = '' AND ?3 <> '' THEN ?3
                            ELSE thread_root_id END
                  WHERE conversation_id = ?1",
                params![link_id, base, root],
            )?;
            // Whatever the UPDATE skipped is a duplicate of a correctly-filed row.
            dropped += self.exec(
                "DELETE FROM messages WHERE conversation_id = ?1",
                params![link_id],
            )?;
            // For a chat (not a channel), keep the merged messages reachable from the
            // base conversation, carrying the pseudo-row's recency with them.
            if !crate::teams_read::is_channel_thread_id(&base) {
                let last_time: i64 = self
                    .query_one(
                        "SELECT last_message_time FROM conversations WHERE id = ?1",
                        params![link_id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                self.upsert_conversation(&base, "", last_time)?;
            }
            if self.delete_conversation_row(&link_id)? {
                rows_deleted += 1;
            }
        }
        Ok((moved, dropped, rows_deleted))
    }

    /// Every conversation id holding a `;messageid=` deep-link suffix, from BOTH the
    /// `conversations` table and the messages themselves — a live post could file
    /// messages under such an id without ever creating a list row (5 of the 19 ids in
    /// the real store were message-only).
    fn thread_link_ids(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id FROM conversations WHERE id LIKE '%;messageid=%'
             UNION
             SELECT DISTINCT conversation_id FROM messages WHERE conversation_id LIKE '%;messageid=%'",
        )?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(ids.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The `(id, conversation_id, content)` of every row a cleanup's prefilter
    /// matches, collected up front so the pass can UPDATE/DELETE while iterating.
    /// `sql` must select exactly those three columns.
    fn rows_matching(&self, sql: &str) -> Result<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare_cached(sql)?;
        let mapped = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })?;
        Ok(mapped.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Returns true when the row was newly inserted or an existing row actually
    /// changed. The guarded `DO UPDATE ... WHERE` makes a no-op upsert modify 0
    /// rows, so callers can emit a `conversations_changed` event ONLY on a real
    /// change. Without this, a repeated sync of unchanged data reports a change
    /// every time and drives an endless refresh->sync->event->refresh loop.
    pub fn upsert_conversation(&self, id: &str, display_name: &str, last_message_time: i64) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO conversations (id, display_name, last_message_time)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                -- never clobber a known title with an empty one (live events carry no title)
                display_name = CASE
                    WHEN excluded.display_name IS NOT NULL AND excluded.display_name <> ''
                    THEN excluded.display_name ELSE conversations.display_name END,
                last_message_time = MAX(conversations.last_message_time, excluded.last_message_time)
             WHERE
                -- only write (and thus report a change) when a column would move
                (excluded.display_name IS NOT NULL AND excluded.display_name <> ''
                    AND excluded.display_name <> conversations.display_name)
                OR excluded.last_message_time > conversations.last_message_time",
            params![id, display_name, last_message_time],
        )?;
        Ok(changed > 0)
    }

    /// Upsert a conversation carrying its full CSA metadata (`kind` + the sidebar
    /// fields). Only the network sync (`persist_conversations`) has this data;
    /// blind upserts (live events, name resolution) use `upsert_conversation`,
    /// which leaves all of it untouched. A known kind is never downgraded to
    /// `unknown` by a later blank sync.
    ///
    /// Returns true when the row was newly inserted or an existing row actually
    /// changed (see `upsert_conversation` for why the `WHERE` guard matters — it
    /// is what keeps a repeated identical sync from spinning the UI's
    /// refresh->sync->`conversations_changed`->refresh loop).
    ///
    /// Message-derived fields (preview, sender, from-me, unread) are only written
    /// when the incoming snapshot is at least as fresh as the stored one
    /// (`last_message_time`), so an out-of-order sync can't regress them. Chat
    /// settings (muted/pinned/hidden/thread_type) take the latest value, since
    /// CSA always returns a full current snapshot.
    pub fn upsert_conversation_full(&self, u: &ConversationUpdate) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO conversations (
                id, display_name, last_message_time, kind,
                last_message_preview, last_message_sender, last_message_sender_mri,
                last_message_from_me,
                is_read, is_muted, is_pinned, is_hidden, thread_type, picture_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?14, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                display_name = CASE
                    WHEN excluded.display_name IS NOT NULL AND excluded.display_name <> ''
                    THEN excluded.display_name ELSE conversations.display_name END,
                last_message_time = MAX(conversations.last_message_time, excluded.last_message_time),
                -- keep a known kind; only overwrite when the new value is meaningful
                kind = CASE
                    WHEN excluded.kind <> 'unknown' THEN excluded.kind
                    ELSE conversations.kind END,
                -- message-derived fields: only take the incoming snapshot when it is
                -- at least as fresh, so a stale/out-of-order sync can't regress them
                last_message_preview = CASE
                    WHEN excluded.last_message_time >= conversations.last_message_time
                    THEN excluded.last_message_preview ELSE conversations.last_message_preview END,
                last_message_sender = CASE
                    WHEN excluded.last_message_time >= conversations.last_message_time
                    THEN excluded.last_message_sender ELSE conversations.last_message_sender END,
                last_message_sender_mri = CASE
                    WHEN excluded.last_message_time >= conversations.last_message_time
                    THEN excluded.last_message_sender_mri
                    ELSE conversations.last_message_sender_mri END,
                last_message_from_me = CASE
                    WHEN excluded.last_message_time >= conversations.last_message_time
                    THEN excluded.last_message_from_me ELSE conversations.last_message_from_me END,
                is_read = CASE
                    WHEN excluded.last_message_time >= conversations.last_message_time
                    THEN excluded.is_read ELSE conversations.is_read END,
                -- chat settings: latest snapshot wins
                is_muted = excluded.is_muted,
                is_pinned = excluded.is_pinned,
                is_hidden = excluded.is_hidden,
                thread_type = CASE
                    WHEN excluded.thread_type <> '' THEN excluded.thread_type
                    ELSE conversations.thread_type END,
                -- the group's own picture: latest snapshot wins outright, so a
                -- picture the members remove is cleared instead of lingering
                picture_url = excluded.picture_url
             WHERE
                -- report a change ONLY when a column would actually move, so an
                -- identical re-sync emits no `conversations_changed`
                (excluded.display_name IS NOT NULL AND excluded.display_name <> ''
                    AND excluded.display_name <> conversations.display_name)
                OR excluded.last_message_time > conversations.last_message_time
                OR (excluded.kind <> 'unknown' AND excluded.kind <> conversations.kind)
                OR (excluded.last_message_time >= conversations.last_message_time AND (
                       excluded.last_message_preview <> conversations.last_message_preview
                    OR excluded.last_message_sender  <> conversations.last_message_sender
                    OR excluded.last_message_sender_mri <> conversations.last_message_sender_mri
                    OR excluded.last_message_from_me <> conversations.last_message_from_me
                    OR excluded.is_read              <> conversations.is_read))
                OR excluded.is_muted  <> conversations.is_muted
                OR excluded.is_pinned <> conversations.is_pinned
                OR excluded.is_hidden <> conversations.is_hidden
                OR (excluded.thread_type <> '' AND excluded.thread_type <> conversations.thread_type)
                OR excluded.picture_url <> conversations.picture_url",
            params![
                u.id,
                u.display_name,
                u.last_message_time,
                u.kind.as_str(),
                u.last_message_preview,
                u.last_message_sender,
                u.last_message_from_me as i64,
                u.is_read as i64,
                u.is_muted as i64,
                u.is_pinned as i64,
                u.is_hidden as i64,
                u.thread_type,
                u.picture_url,
                u.last_message_sender_mri,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Upsert a channel with its full CSA metadata. Mirrors
    /// [`Store::upsert_conversation_full`] — a guarded `WHERE` makes a no-op upsert
    /// modify 0 rows so the caller emits `channels_changed` ONLY on a real change,
    /// and message-derived fields (preview/sender/from-me/unread) only take the
    /// incoming snapshot when it is at least as fresh (`last_message_time`), so an
    /// out-of-order sync can't regress them. `draft` is never written here (a local
    /// draft cannot be clobbered by remote metadata). Returns true on a real change.
    pub fn upsert_channel_full(&self, u: &ChannelUpdate) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO channels (
                id, team_id, team_name, display_name, is_general, is_shown,
                last_message_time, last_message_preview, last_message_sender,
                last_message_sender_mri,
                last_message_from_me, is_read, team_pos, channel_pos, team_group_id,
                alerts, is_pinned, team_collapsed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?18, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(id) DO UPDATE SET
                team_id = excluded.team_id,
                team_name = CASE
                    WHEN excluded.team_name <> '' THEN excluded.team_name
                    ELSE channels.team_name END,
                team_group_id = CASE
                    WHEN excluded.team_group_id <> '' THEN excluded.team_group_id
                    ELSE channels.team_group_id END,
                display_name = CASE
                    WHEN excluded.display_name <> '' THEN excluded.display_name
                    ELSE channels.display_name END,
                is_general = excluded.is_general,
                is_shown = excluded.is_shown,
                is_pinned = excluded.is_pinned,
                team_collapsed = excluded.team_collapsed,
                alerts = excluded.alerts,
                team_pos = excluded.team_pos,
                channel_pos = excluded.channel_pos,
                last_message_time = MAX(channels.last_message_time, excluded.last_message_time),
                -- message-derived fields: only take the incoming snapshot when it is
                -- at least as fresh, so a stale/out-of-order sync can't regress them
                last_message_preview = CASE
                    WHEN excluded.last_message_time >= channels.last_message_time
                    THEN excluded.last_message_preview ELSE channels.last_message_preview END,
                last_message_sender = CASE
                    WHEN excluded.last_message_time >= channels.last_message_time
                    THEN excluded.last_message_sender ELSE channels.last_message_sender END,
                last_message_sender_mri = CASE
                    WHEN excluded.last_message_time >= channels.last_message_time
                    THEN excluded.last_message_sender_mri
                    ELSE channels.last_message_sender_mri END,
                last_message_from_me = CASE
                    WHEN excluded.last_message_time >= channels.last_message_time
                    THEN excluded.last_message_from_me ELSE channels.last_message_from_me END,
                is_read = CASE
                    WHEN excluded.last_message_time >= channels.last_message_time
                    THEN excluded.is_read ELSE channels.is_read END
             WHERE
                -- report a change ONLY when a column would actually move, so an
                -- identical re-sync emits no `channels_changed`
                excluded.team_id <> channels.team_id
                OR (excluded.team_name <> '' AND excluded.team_name <> channels.team_name)
                OR (excluded.team_group_id <> '' AND excluded.team_group_id <> channels.team_group_id)
                OR (excluded.display_name <> '' AND excluded.display_name <> channels.display_name)
                OR excluded.is_general <> channels.is_general
                OR excluded.is_shown <> channels.is_shown
                OR excluded.is_pinned <> channels.is_pinned
                OR excluded.team_collapsed <> channels.team_collapsed
                OR excluded.alerts <> channels.alerts
                OR excluded.team_pos <> channels.team_pos
                OR excluded.channel_pos <> channels.channel_pos
                OR excluded.last_message_time > channels.last_message_time
                OR (excluded.last_message_time >= channels.last_message_time AND (
                       excluded.last_message_preview <> channels.last_message_preview
                    OR excluded.last_message_sender  <> channels.last_message_sender
                    OR excluded.last_message_sender_mri <> channels.last_message_sender_mri
                    OR excluded.last_message_from_me <> channels.last_message_from_me
                    OR excluded.is_read              <> channels.is_read))",
            params![
                u.id,
                u.team_id,
                u.team_name,
                u.display_name,
                u.is_general as i64,
                u.is_shown as i64,
                u.last_message_time,
                u.last_message_preview,
                u.last_message_sender,
                u.last_message_from_me as i64,
                u.is_read as i64,
                u.team_pos,
                u.channel_pos,
                u.team_group_id,
                u.alerts.as_str(),
                u.is_pinned as i64,
                u.team_collapsed as i64,
                u.last_message_sender_mri,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Bump a channel's `last_message_time` (and mark it unread) from a live post,
    /// without touching its CSA-owned metadata — the channel analogue of
    /// [`Store::upsert_conversation`]. Only ever moves the time FORWARD, and marks
    /// the channel unread when the post is not ours. Returns true on a real change,
    /// so the caller emits `channels_changed` only when something moved. A no-op
    /// (unknown id, or an older/equal time with no unread flip) returns false.
    pub fn touch_channel(&self, id: &str, last_message_time: i64, from_me: bool) -> Result<bool> {
        let changed = self.exec(
            "UPDATE channels SET
                last_message_time = MAX(last_message_time, ?2),
                last_message_from_me = ?3,
                is_read = CASE WHEN ?3 THEN is_read ELSE 0 END
             WHERE id = ?1
               AND (?2 > last_message_time OR (NOT ?3 AND is_read))",
            params![id, last_message_time, from_me as i64],
        )?;
        Ok(changed > 0)
    }

    /// One channel's notification setting, for the live push path — which holds a
    /// single message and must decide about it without loading the whole tree.
    ///
    /// An unknown id yields Teams' default ([`ChannelAlerts::MentionsOnly`]) rather
    /// than `None`: a post can arrive in a channel the CSA sync has not reported
    /// yet, and the honest answer for it is "what Teams does by default".
    pub fn channel_alerts(&self, id: &str) -> Result<ChannelAlerts> {
        let stored = self
            .query_one("SELECT alerts FROM channels WHERE id = ?1", params![id], |r| {
                r.get::<_, String>(0)
            })
            .optional()?;
        Ok(stored.map(|s| ChannelAlerts::from_str(&s)).unwrap_or(ChannelAlerts::MentionsOnly))
    }

    /// True when a thread id is a known channel (has a row in the `channels`
    /// table). The live-message path uses this — alongside the id-suffix check —
    /// to route a post to `touch_channel` instead of leaking it into the chat list.
    pub fn is_channel(&self, id: &str) -> Result<bool> {
        let n: i64 = self.query_one(
            "SELECT COUNT(*) FROM channels WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        Ok(n > 0)
    }

    /// All channels, grouped for the sidebar tree in the order CSA reported them: by
    /// the team's CSA position, then General first within a team, then the channel's
    /// CSA position. Alphabetical tie-breakers keep the order deterministic
    /// for rows that share a position (e.g. legacy rows synced before positions
    /// existed, which all default to 0). Empty channels are never inserted, so every
    /// row here has content.
    ///
    /// The CSA channel container carries no last-message BODY, so a channel's stored
    /// preview is always empty — it is derived here from the newest message we hold
    /// (see [`Store::derived_preview`]).
    pub fn channels(&self) -> Result<Vec<ChannelRow>> {
        // A channel's own name is a channel's, never a person's, so only the preview
        // attribution passes through the user's nicknames here.
        let sql = format!(
            "SELECT id, team_id, team_name, display_name, is_general, is_shown,
                    last_message_time, last_message_preview, {PREVIEW_SENDER},
                    last_message_from_me, is_read, draft, team_group_id, alerts,
                    local_read_time, local_read_ghost, is_pinned, team_collapsed
             FROM channels
             ORDER BY team_pos ASC, team_name ASC, team_id ASC,
                      is_general DESC, channel_pos ASC, display_name ASC, id ASC",
            PREVIEW_SENDER =
                nicknamed!("channels.last_message_sender_mri", "last_message_sender"),
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map([], |r| {
            let last_message_time: i64 = r.get(6)?;
            let (is_read, is_ghost_read) = read_state(
                r.get::<_, i64>(10)? != 0,
                r.get(14)?,
                r.get::<_, i64>(15)? != 0,
                last_message_time,
            );
            Ok(ChannelRow {
                id: r.get(0)?,
                team_id: r.get(1)?,
                team_name: r.get(2)?,
                display_name: r.get(3)?,
                is_general: r.get::<_, i64>(4)? != 0,
                is_shown: r.get::<_, i64>(5)? != 0,
                is_pinned: r.get::<_, i64>(16)? != 0,
                team_collapsed: r.get::<_, i64>(17)? != 0,
                last_message_time,
                last_message_preview: r.get(7)?,
                last_message_sender: r.get(8)?,
                last_message_from_me: r.get::<_, i64>(9)? != 0,
                is_read,
                is_ghost_read,
                draft: r.get(11)?,
                team_group_id: r.get(12)?,
                alerts: ChannelAlerts::from_str(&r.get::<_, String>(13)?),
            })
        })?;
        let mut channels: Vec<ChannelRow> = rows.collect::<rusqlite::Result<_>>()?;
        for channel in &mut channels {
            if channel.last_message_preview.is_empty() {
                channel.last_message_preview = self.derived_preview(&channel.id)?;
            }
        }
        Ok(channels)
    }

    /// A sidebar preview derived from the messages we HOLD for a thread, for a
    /// container whose synced preview is empty. Returns `""` when we hold nothing
    /// describable.
    ///
    /// Local-first, and the only way to fill the gaps the CSA snapshot leaves: a
    /// channel container never carries a last-message body, and a chat whose newest
    /// frame is a system event (a call, a member added) previews as nothing — 44
    /// containers with messages showed a blank second line, which reads as "no
    /// messages" when there are hundreds.
    ///
    /// Scans a few newest rows rather than only the last one, so an undescribable
    /// frame at the top (a payload-less row) falls through to the last message that
    /// *can* be described. [`crate::teams_read::preview_for_message`] does the
    /// labelling (text, emoji, `📷 Image`, `📎 File`, a card title, a call line).
    fn derived_preview(&self, thread_id: &str) -> Result<String> {
        /// How far back to look for something describable. Small: this runs per
        /// container on a sidebar read, and a thread whose newest frames are all
        /// undescribable has nothing to say anyway.
        const SCAN_DEPTH: i64 = 5;
        let preview = self
            .newest_messages(thread_id, SCAN_DEPTH)?
            .iter()
            .rev()
            .map(crate::teams_read::preview_for_message)
            .find(|preview| !preview.is_empty())
            .unwrap_or_default();
        Ok(preview)
    }

    // ---- mail (read-only Outlook mirror) ------------------------------------

    /// Upsert one mail folder's metadata from a network sync. Returns true when a
    /// column actually moved, so the caller emits `mail_folders_changed` only on a
    /// real change. Local paging state (`oldest_received` / `has_more_older`) is
    /// never touched here.
    pub fn upsert_mail_folder(&self, u: &MailFolderUpdate) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO mail_folders (id, display_name, well_known, total_count, unread_count, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                well_known   = excluded.well_known,
                total_count  = excluded.total_count,
                unread_count = excluded.unread_count,
                position     = excluded.position
             WHERE excluded.display_name <> mail_folders.display_name
                OR excluded.well_known   <> mail_folders.well_known
                OR excluded.total_count  <> mail_folders.total_count
                OR excluded.unread_count <> mail_folders.unread_count
                OR excluded.position     <> mail_folders.position",
            params![
                u.id,
                u.display_name,
                u.well_known,
                u.total_count,
                u.unread_count,
                u.position,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Every known mail folder, in sidebar order: well-known folders first (Inbox,
    /// Archive, Sent, …) then the user's own, with the name as a deterministic
    /// tie-breaker.
    ///
    /// `unread_count` is the mailbox's own count MINUS the mail read here that the
    /// mailbox still calls unread, floored at zero: a folder whose every unread mail
    /// the user has opened in this app has to badge nothing, or the count contradicts
    /// the rows under it. The subtraction can only ever be an estimate — the mailbox
    /// counts the whole folder while we hold a window of it — so it is deliberately
    /// one-directional: it lowers a count, never raises one, and a row re-fetched
    /// from Graph re-synchronizes both halves.
    pub fn mail_folders(&self) -> Result<Vec<MailFolderRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT f.id, f.display_name, f.well_known, f.total_count,
                    MAX(0, f.unread_count - (
                        SELECT COUNT(*) FROM mail_messages m
                         WHERE m.folder_id = f.id AND m.local_read = 1 AND m.is_read = 0)),
                    f.position, f.oldest_received, f.has_more_older
             FROM mail_folders f
             ORDER BY f.position ASC, f.display_name ASC, f.id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MailFolderRow {
                id: r.get(0)?,
                display_name: r.get(1)?,
                well_known: r.get(2)?,
                total_count: r.get(3)?,
                unread_count: r.get(4)?,
                position: r.get(5)?,
                oldest_received: r.get(6)?,
                has_more_older: r.get::<_, i64>(7)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Record how far back a folder's local history reaches, and whether the server
    /// has more.
    ///
    /// `oldest` only ever moves BACKWARDS (a page of older mail extends the
    /// frontier); a newer value is ignored, so an out-of-order sync cannot pretend
    /// the backlog is shorter than it is. An EMPTY `oldest` means "this page had no
    /// rows" and leaves the frontier alone — it must not read as "history starts at
    /// the beginning of time", which would erase what we know.
    pub fn set_mail_frontier(&self, folder_id: &str, oldest: &str, has_more: bool) -> Result<()> {
        self.exec(
            "UPDATE mail_folders
                SET oldest_received = CASE
                        WHEN ?2 = '' THEN oldest_received
                        WHEN oldest_received = '' OR ?2 < oldest_received THEN ?2
                        ELSE oldest_received END,
                    has_more_older = ?3
              WHERE id = ?1",
            params![folder_id, oldest, has_more as i64],
        )?;
        Ok(())
    }

    /// A folder's history frontier: the oldest message held locally (empty when
    /// none) and whether anything older exists on the server.
    pub fn mail_frontier(&self, folder_id: &str) -> Result<(String, bool)> {
        self.query_one(
            "SELECT oldest_received, has_more_older FROM mail_folders WHERE id = ?1",
            params![folder_id],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .optional()
        // An unknown folder has no history and may have more: the caller then
        // fetches its newest page from the network.
        .map(|row| row.unwrap_or_else(|| (String::new(), true)))
        .map_err(Into::into)
    }

    /// The newest message timestamp held for a folder, or `None` when it is empty.
    /// This is the watermark the live poll asks the server to beat (see
    /// `mail::fetch_since`).
    pub fn newest_mail_received(&self, folder_id: &str) -> Result<Option<String>> {
        let newest: Option<String> = self.query_one(
            "SELECT received FROM mail_messages
              WHERE folder_id = ?1 ORDER BY received DESC, id ASC LIMIT 1",
            params![folder_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
        Ok(newest.filter(|s| !s.is_empty()))
    }

    /// Upsert one mail's list fields. Returns true when something actually changed
    /// (a new mail, or one whose read state / metadata moved), so a re-sync that
    /// reports the same state emits no event.
    ///
    /// The cached body is preserved: this statement never writes `body_html`,
    /// `body_loaded`, `blocked_remote_images`, `body_truncated` or `attachments`.
    ///
    /// Our own read mark is preserved too, with one exception: a sync that reports the
    /// mail READ clears it, because the mailbox's own flag then says everything and a
    /// stale mark would keep a later "mark as unread" in Outlook from coming through
    /// (see [`Store::mark_mail_read_locally`]).
    pub fn upsert_mail_message(&self, u: &MailMessageUpdate) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO mail_messages (
                id, folder_id, conversation_id, subject, from_name, from_address,
                to_addresses, cc_addresses, received, is_read, has_attachments,
                importance, preview)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                folder_id       = excluded.folder_id,
                conversation_id = excluded.conversation_id,
                subject         = excluded.subject,
                from_name       = excluded.from_name,
                from_address    = excluded.from_address,
                to_addresses    = excluded.to_addresses,
                cc_addresses    = excluded.cc_addresses,
                received        = excluded.received,
                is_read         = excluded.is_read,
                local_read      = CASE WHEN excluded.is_read THEN 0
                                       ELSE mail_messages.local_read END,
                has_attachments = excluded.has_attachments,
                importance      = excluded.importance,
                preview         = excluded.preview
             WHERE excluded.folder_id       <> mail_messages.folder_id
                OR excluded.subject         <> mail_messages.subject
                OR excluded.from_name       <> mail_messages.from_name
                OR excluded.from_address    <> mail_messages.from_address
                OR excluded.to_addresses    <> mail_messages.to_addresses
                OR excluded.cc_addresses    <> mail_messages.cc_addresses
                OR excluded.received        <> mail_messages.received
                OR excluded.is_read         <> mail_messages.is_read
                OR excluded.has_attachments <> mail_messages.has_attachments
                OR excluded.importance      <> mail_messages.importance
                OR excluded.preview         <> mail_messages.preview",
            params![
                u.id,
                u.folder_id,
                u.conversation_id,
                u.subject,
                u.from_name,
                u.from_address,
                u.to_addresses,
                u.cc_addresses,
                u.received,
                u.is_read as i64,
                u.has_attachments as i64,
                u.importance,
                u.preview,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Cache one mail's rendered body and attachment list. Idempotent, and the only
    /// writer of the body columns.
    pub fn set_mail_body(&self, id: &str, body: &MailBodyUpdate) -> Result<()> {
        self.exec(
            "UPDATE mail_messages
                SET body_html = ?2,
                    body_loaded = 1,
                    blocked_remote_images = ?3,
                    body_truncated = ?4,
                    attachments = ?5
              WHERE id = ?1",
            params![
                id,
                body.html,
                body.blocked_remote_images,
                body.truncated as i64,
                body.attachments,
            ],
        )?;
        Ok(())
    }

    /// Mark one mail read HERE — and only here.
    ///
    /// The mailbox is read-only (see `crate::mail`), so this writes our own
    /// `local_read` column and nothing else: Outlook keeps the mail unread on every
    /// other client, and its sender is told nothing. What it moves is the marker in
    /// this app, which is what a person means when they say they read a mail.
    ///
    /// Only ever set while the mailbox itself says UNREAD, so `local_read = 1` names
    /// exactly the set a folder's unread count has to discount (see
    /// [`Store::mail_folders`]) and a mail already read needs no mark at all.
    ///
    /// Returns the mail's folder when the mark actually moved — the caller emits that
    /// folder's list and its counts — and `None` when there was nothing to move (no
    /// such mail, already read here, or already read in the mailbox), so re-opening a
    /// read mail spins no refresh.
    pub fn mark_mail_read_locally(&self, id: &str) -> Result<Option<String>> {
        let moved = self.exec(
            "UPDATE mail_messages SET local_read = 1
              WHERE id = ?1 AND local_read = 0 AND is_read = 0",
            params![id],
        )?;
        if moved == 0 {
            return Ok(None);
        }
        Ok(self
            .query_one(
                "SELECT folder_id FROM mail_messages WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .optional()?)
    }

    /// One mail by id, body included when it has been fetched.
    pub fn mail_message(&self, id: &str) -> Result<Option<MailMessageRow>> {
        self.query_one(
            &format!("SELECT {MAIL_SELECT_COLS} FROM mail_messages WHERE id = ?1"),
            params![id],
            row_to_mail,
        )
        .optional()
        .map_err(Into::into)
    }

    /// A page of a folder's mail, newest first. `before` (an ISO timestamp from the
    /// oldest row already shown) pages further back; `None` returns the newest page.
    ///
    /// Ordered and filtered on `received` alone, which the covering index serves
    /// directly — `id` only breaks ties so the order is total and paging cannot
    /// repeat or skip a row.
    pub fn mail_page(
        &self,
        folder_id: &str,
        before: Option<&str>,
        limit: i64,
    ) -> Result<Vec<MailMessageRow>> {
        match before {
            Some(before) => {
                let mut stmt = self.conn.prepare_cached(&format!(
                    "SELECT {MAIL_SELECT_COLS} FROM mail_messages
                      WHERE folder_id = ?1 AND received < ?2
                      ORDER BY received DESC, id ASC LIMIT ?3"
                ))?;
                let rows = stmt.query_map(params![folder_id, before, limit], row_to_mail)?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            }
            None => {
                let mut stmt = self.conn.prepare_cached(&format!(
                    "SELECT {MAIL_SELECT_COLS} FROM mail_messages
                      WHERE folder_id = ?1
                      ORDER BY received DESC, id ASC LIMIT ?2"
                ))?;
                let rows = stmt.query_map(params![folder_id, limit], row_to_mail)?;
                Ok(rows.collect::<rusqlite::Result<_>>()?)
            }
        }
    }

    /// Reconcile a folder's newest window against the server's own view of it.
    ///
    /// Deletes every locally-held mail in `folder_id` that is at least as recent as
    /// `oldest_in_window` but absent from `keep_ids` — i.e. mail that has since been
    /// deleted, archived or moved in real Outlook. Bounded on purpose: the window
    /// the user is looking at mirrors the server exactly, while older mail is
    /// reconciled whenever it is re-fetched. Returns how many rows were removed.
    ///
    /// A no-op when the window is empty, so a failed or empty fetch can never be
    /// mistaken for "the folder is now empty" and wipe the cache.
    pub fn prune_mail_window(
        &self,
        folder_id: &str,
        oldest_in_window: &str,
        keep_ids: &[String],
    ) -> Result<usize> {
        if keep_ids.is_empty() || oldest_in_window.is_empty() {
            return Ok(0);
        }
        let placeholders = std::iter::repeat_n("?", keep_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "DELETE FROM mail_messages
              WHERE folder_id = ?1 AND received >= ?2 AND id NOT IN ({placeholders})"
        );
        let mut args: Vec<&dyn ToSql> = Vec::with_capacity(keep_ids.len() + 2);
        args.push(&folder_id);
        args.push(&oldest_in_window);
        for id in keep_ids {
            args.push(id);
        }
        Ok(self.exec(&sql, &args)?)
    }

    // ---- calendar (read-only Teams/Outlook mirror) ---------------------------

    /// Upsert one calendar's metadata from a network sync. Returns true when a
    /// column actually moved, so the caller emits `calendars_changed` only on a real
    /// change.
    pub fn upsert_calendar(&self, u: &CalendarUpdate) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO calendars (id, name, hex_color, is_default, can_edit, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name       = excluded.name,
                hex_color  = excluded.hex_color,
                is_default = excluded.is_default,
                can_edit   = excluded.can_edit,
                position   = excluded.position
             WHERE excluded.name       <> calendars.name
                OR excluded.hex_color  <> calendars.hex_color
                OR excluded.is_default <> calendars.is_default
                OR excluded.can_edit   <> calendars.can_edit
                OR excluded.position   <> calendars.position",
            params![
                u.id,
                u.name,
                u.hex_color,
                u.is_default as i64,
                u.can_edit as i64,
                u.position,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Every known calendar, default first then Graph's order, with the name as a
    /// deterministic tie-breaker.
    pub fn calendars(&self) -> Result<Vec<CalendarRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, name, hex_color, is_default, can_edit, position
             FROM calendars
             ORDER BY position ASC, name ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CalendarRow {
                id: r.get(0)?,
                name: r.get(1)?,
                hex_color: r.get(2)?,
                is_default: r.get::<_, i64>(3)? != 0,
                can_edit: r.get::<_, i64>(4)? != 0,
                position: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Upsert one event. Returns true when something actually changed (a new event,
    /// or one that has since been moved, renamed, cancelled or re-answered), so a
    /// re-sync that reports the same month emits no event to the UI.
    pub fn upsert_calendar_event(&self, u: &CalendarEventUpdate) -> Result<bool> {
        let changed = self.exec(
            "INSERT INTO calendar_events (
                id, calendar_id, subject, preview, start_utc, end_utc, is_all_day,
                is_cancelled, is_organizer, organizer_name, organizer_address, location,
                join_url, web_link, show_as, response, series, recurrence, importance,
                sensitivity, categories, attendees, attendee_count, has_attachments,
                reminder_minutes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                     ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)
             ON CONFLICT(id) DO UPDATE SET
                calendar_id       = excluded.calendar_id,
                subject           = excluded.subject,
                preview           = excluded.preview,
                start_utc         = excluded.start_utc,
                end_utc           = excluded.end_utc,
                is_all_day        = excluded.is_all_day,
                is_cancelled      = excluded.is_cancelled,
                is_organizer      = excluded.is_organizer,
                organizer_name    = excluded.organizer_name,
                organizer_address = excluded.organizer_address,
                location          = excluded.location,
                join_url          = excluded.join_url,
                web_link          = excluded.web_link,
                show_as           = excluded.show_as,
                response          = excluded.response,
                series            = excluded.series,
                recurrence        = excluded.recurrence,
                importance        = excluded.importance,
                sensitivity       = excluded.sensitivity,
                categories        = excluded.categories,
                attendees         = excluded.attendees,
                attendee_count    = excluded.attendee_count,
                has_attachments   = excluded.has_attachments,
                reminder_minutes  = excluded.reminder_minutes
             WHERE excluded.calendar_id       <> calendar_events.calendar_id
                OR excluded.subject           <> calendar_events.subject
                OR excluded.preview           <> calendar_events.preview
                OR excluded.start_utc         <> calendar_events.start_utc
                OR excluded.end_utc           <> calendar_events.end_utc
                OR excluded.is_all_day        <> calendar_events.is_all_day
                OR excluded.is_cancelled      <> calendar_events.is_cancelled
                OR excluded.is_organizer      <> calendar_events.is_organizer
                OR excluded.organizer_name    <> calendar_events.organizer_name
                OR excluded.organizer_address <> calendar_events.organizer_address
                OR excluded.location          <> calendar_events.location
                OR excluded.join_url          <> calendar_events.join_url
                OR excluded.web_link          <> calendar_events.web_link
                OR excluded.show_as           <> calendar_events.show_as
                OR excluded.response          <> calendar_events.response
                OR excluded.series            <> calendar_events.series
                OR excluded.recurrence        <> calendar_events.recurrence
                OR excluded.importance        <> calendar_events.importance
                OR excluded.sensitivity       <> calendar_events.sensitivity
                OR excluded.categories        <> calendar_events.categories
                OR excluded.attendees         <> calendar_events.attendees
                OR excluded.attendee_count    <> calendar_events.attendee_count
                OR excluded.has_attachments   <> calendar_events.has_attachments
                OR excluded.reminder_minutes  <> calendar_events.reminder_minutes",
            params![
                u.id,
                u.calendar_id,
                u.subject,
                u.preview,
                u.start_utc,
                u.end_utc,
                u.is_all_day as i64,
                u.is_cancelled as i64,
                u.is_organizer as i64,
                u.organizer_name,
                u.organizer_address,
                u.location,
                u.join_url,
                u.web_link,
                u.show_as,
                u.response,
                u.series,
                u.recurrence,
                u.importance,
                u.sensitivity,
                u.categories,
                u.attendees,
                u.attendee_count,
                u.has_attachments as i64,
                u.reminder_minutes,
            ],
        )?;
        Ok(changed > 0)
    }

    /// Every held event that OVERLAPS `[start, end)`, earliest first.
    ///
    /// `calendar_ids` restricts the result to the calendars the user has switched on;
    /// an empty slice means "every calendar", which is what a client that has not
    /// chosen yet gets.
    ///
    /// The overlap predicate is deliberately two clauses rather than the textbook
    /// `start < end AND event_end > start`: an event with a zero-length span (Graph
    /// does emit them, and a missing end is clamped to the start by
    /// `calendar::parse_event`) has `end_utc == start_utc` and would fail the second
    /// clause even while sitting inside the window. `OR start_utc >= start` catches
    /// exactly that case — "starts within the window" — and their union is the real
    /// overlap test.
    pub fn calendar_events(
        &self,
        start: &str,
        end: &str,
        calendar_ids: &[String],
    ) -> Result<Vec<CalendarEventRow>> {
        // `start_utc < ?2` is what the range index serves; the rest filters the rows
        // it returns. That is the right shape at calendar scale — months are synced
        // on demand, so this table holds thousands of rows, not a mailbox's tens of
        // thousands — and it keeps the predicate exactly correct for events that
        // began before the window (a week of leave seen from its last day).
        let mut sql = format!(
            "SELECT {EVENT_SELECT_COLS} FROM calendar_events
              WHERE start_utc < ?2 AND (end_utc > ?1 OR start_utc >= ?1)"
        );
        let mut args: Vec<&dyn ToSql> = vec![&start, &end];
        if !calendar_ids.is_empty() {
            let placeholders = std::iter::repeat_n("?", calendar_ids.len())
                .collect::<Vec<_>>()
                .join(",");
            sql.push_str(&format!(" AND calendar_id IN ({placeholders})"));
            for id in calendar_ids {
                args.push(id);
            }
        }
        sql.push_str(" ORDER BY start_utc ASC, end_utc ASC, id ASC");
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(args.as_slice(), row_to_event)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Reconcile one calendar's window against the server's own view of it.
    ///
    /// Deletes every locally-held event of `calendar_id` overlapping `[start, end)`
    /// that is absent from `keep_ids` — i.e. an event deleted, moved out of the
    /// window, or whose whole series was removed in real Outlook. Returns how many
    /// rows were removed.
    ///
    /// An EMPTY `keep_ids` is meaningful here, unlike the mail equivalent: a month
    /// with no events is a normal answer, and the stale rows must go. A *failed*
    /// fetch never reaches this function — the error propagates from the caller — so
    /// "empty" can never be a network failure in disguise.
    pub fn prune_calendar_window(
        &self,
        calendar_id: &str,
        start: &str,
        end: &str,
        keep_ids: &[String],
    ) -> Result<usize> {
        // Diffed in Rust rather than with a `NOT IN (…)` of every id: a busy month
        // can hold hundreds of events, and this keeps the statement's parameter count
        // fixed no matter how many.
        let held: Vec<String> = {
            let mut stmt = self.conn.prepare_cached(
                "SELECT id FROM calendar_events
                  WHERE calendar_id = ?1 AND start_utc < ?3 AND (end_utc > ?2 OR start_utc >= ?2)",
            )?;
            let rows = stmt.query_map(params![calendar_id, start, end], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let keep: std::collections::HashSet<&str> =
            keep_ids.iter().map(String::as_str).collect();
        let stale: Vec<String> = held
            .into_iter()
            .filter(|id| !keep.contains(id.as_str()))
            .collect();
        if stale.is_empty() {
            return Ok(0);
        }
        self.transaction(|| {
            let mut removed = 0;
            for id in &stale {
                removed += self.exec("DELETE FROM calendar_events WHERE id = ?1", params![id])?;
            }
            Ok(removed)
        })
    }

    /// Record that `month` ("YYYY-MM") of `calendar_id` has been read from Graph, so
    /// the next request for it is served from SQLite with no network at all.
    pub fn mark_calendar_month_synced(&self, calendar_id: &str, month: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.exec(
            "INSERT INTO calendar_months (calendar_id, month, synced_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(calendar_id, month) DO UPDATE SET synced_at = excluded.synced_at",
            params![calendar_id, month, now],
        )?;
        Ok(())
    }

    /// Whether `month` of `calendar_id` has ever been read from Graph.
    ///
    /// This is what tells "the month is empty" apart from "the month is unknown" —
    /// the same distinction `mail_frontier` draws for a folder, and without it an
    /// unsynced week would render as a free one.
    pub fn calendar_month_synced(&self, calendar_id: &str, month: &str) -> Result<bool> {
        let found: Option<i64> = self
            .query_one(
                "SELECT 1 FROM calendar_months WHERE calendar_id = ?1 AND month = ?2",
                params![calendar_id, month],
                |r| r.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Remove a conversation and all of its messages. Used to purge the
    /// `48:notifications` activity feed, which older builds mis-persisted as a
    /// chat (empty-content bubbles under a raw MRI-URL title) before it was
    /// recognized as a system feed. Idempotent: a no-op when the id is absent.
    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.exec("DELETE FROM messages WHERE conversation_id = ?1", params![id])?;
        self.exec("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete ONLY a conversation's list row, KEEPING its messages. Used to heal a
    /// channel that a live post leaked into the conversations table before a CSA
    /// sync identified it as a channel: the row is removed (so it stops showing in
    /// the Chats list) while its messages stay, since the message pipeline is
    /// shared by thread id and the channel now owns the same messages. Returns true
    /// when a row was actually removed, so the caller emits `conversations_changed`
    /// only on a real change (and the heal converges to a no-op on re-sync).
    pub fn delete_conversation_row(&self, id: &str) -> Result<bool> {
        let n = self.exec("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// Insert a message, deduplicated by id. Returns true if it was newly
    /// inserted OR something the UI must re-render changed (an edit, or a newly
    /// deleted message). When the same id arrives again unchanged, this is a
    /// no-op and returns false, so re-fetches stay cheap while genuine edits —
    /// from us or anyone else — propagate.
    ///
    /// Deletion handling: a Teams deletion arrives as a `MessageUpdate` (or a
    /// history row) with `deleted == true` and EMPTY `content`. Two rules keep
    /// the original text revealable rather than destroying it:
    ///   - Content is NEVER overwritten with an empty string. An update whose
    ///     `content` is empty (a deletion, or any frame that simply omits the
    ///     body) keeps whatever we already stored, so a message we saw before it
    ///     was deleted can still be revealed in the UI.
    ///   - `deleted` is monotonic — once set it stays set (`MAX`). The transition
    ///     `0 -> 1` counts as a change so the deletion propagates to the open view.
    /// A deletion for a message we never stored inserts a tombstone row (empty
    /// content, `deleted = 1`) — nothing to reveal, just the placeholder.
    ///
    /// Reactions are stored on a fresh INSERT but left untouched on conflict:
    /// they change independently of content (a reaction is not an edit), so the
    /// ingestion path reconciles them separately via [`Store::update_message_reactions`],
    /// which also lets a plain edit frame (no emotions) avoid clobbering an
    /// existing reaction set. The empty-string sentinel on `m.reactions` ("frame
    /// carried no emotions info") is coerced to `"[]"` here so the column never
    /// stores it.
    ///
    /// Mentions travel WITH the body — a mention span is addressed by an `itemid`
    /// into this list — so they are rewritten exactly when the content is (an edit
    /// can add or drop a mention), and left alone by a frame that carries no body.
    ///
    /// `messagetype` is BACKFILLED on conflict: it is immutable for a given message
    /// (Teams never retypes one), so a row that predates the column takes the
    /// incoming value and then stops changing. That heal counts as a change, because
    /// it is one the UI must re-render — a `Text` body renders differently once its
    /// type is known — and it converges after a single sync per row.
    ///
    /// So are the CHANNEL-THREAD fields and the attachments, under one rule: an EMPTY
    /// stored value takes a non-empty incoming one, and a non-empty stored value is
    /// never clobbered. Without it a row stored before channel threading landed could
    /// never heal — 496 channel posts held no `thread_root_id`, so the UI grouped each
    /// one as its own single-post thread, and no amount of re-fetching fixed it
    /// because the conflict branch only ever wrote `content`/`deleted`. Backfill-only
    /// (rather than "latest wins") is what keeps a frame that merely omits a field —
    /// a plain edit, a reaction echo — from erasing good data.
    pub fn insert_message(&self, m: &Message) -> Result<bool> {
        let reactions = if m.reactions.is_empty() { "[]" } else { m.reactions.as_str() };
        let n = self.exec(
            "INSERT INTO messages (id, conversation_id, seq, compose_time, sender, sender_mri, messagetype, content, attachments, reactions, system_event, thread_root_id, thread_subject, deleted, mentions)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
             ON CONFLICT(conversation_id, id) DO UPDATE SET
                 -- a frame that turns out to be a SYSTEM EVENT drops the body it was
                 -- stored with: the event says it better (and in the reader's own
                 -- language), so a legacy row healed by a refetch ends up exactly like
                 -- a freshly ingested one instead of keeping a stale English sentence
                 content = CASE
                     WHEN excluded.system_event <> '' AND messages.system_event = '' THEN ''
                     WHEN excluded.content = '' THEN messages.content
                     ELSE excluded.content END,
                 mentions = CASE WHEN excluded.content = '' THEN messages.mentions ELSE excluded.mentions END,
                 messagetype = CASE WHEN excluded.messagetype <> '' THEN excluded.messagetype ELSE messages.messagetype END,
                 -- backfill-only: an empty stored field takes the incoming value,
                 -- a filled one is left alone (see the doc comment)
                 thread_root_id = CASE WHEN messages.thread_root_id = '' THEN excluded.thread_root_id ELSE messages.thread_root_id END,
                 thread_subject = CASE WHEN messages.thread_subject = '' THEN excluded.thread_subject ELSE messages.thread_subject END,
                 attachments = CASE
                     WHEN messages.attachments IN ('', '[]') AND excluded.attachments NOT IN ('', '[]')
                     THEN excluded.attachments ELSE messages.attachments END,
                 system_event = CASE WHEN messages.system_event = '' THEN excluded.system_event ELSE messages.system_event END,
                 deleted = MAX(messages.deleted, excluded.deleted)
                 WHERE (excluded.content <> '' AND messages.content <> excluded.content)
                    OR (excluded.deleted = 1 AND messages.deleted = 0)
                    OR (excluded.messagetype <> '' AND messages.messagetype = '')
                    OR (excluded.thread_root_id <> '' AND messages.thread_root_id = '')
                    OR (excluded.thread_subject <> '' AND messages.thread_subject = '')
                    OR (excluded.system_event <> '' AND messages.system_event = '')
                    OR (excluded.attachments NOT IN ('', '[]') AND messages.attachments IN ('', '[]'))",
            params![m.id, m.conversation_id, m.seq, m.compose_time, m.sender, m.sender_mri, m.message_type, m.content, m.attachments, reactions, m.system_event, m.thread_root_id, m.thread_subject, m.deleted as i64, m.mentions],
        )?;
        Ok(n == 1)
    }

    /// Update just the content of an existing message (an in-place edit) and
    /// return the refreshed row. Returns `None` when the id is unknown or the
    /// content is unchanged, so callers can skip a needless live broadcast.
    pub fn update_message_content(
        &self,
        conversation_id: &str,
        id: &str,
        content: &str,
    ) -> Result<Option<Message>> {
        let changed = self.exec(
            "UPDATE messages SET content = ?3
             WHERE conversation_id = ?1 AND id = ?2 AND content <> ?3",
            params![conversation_id, id, content],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let sql = format!(
            "SELECT {SELECT_COLS} FROM messages WHERE conversation_id = ?1 AND id = ?2"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let msg = stmt.query_row(params![conversation_id, id], row_to_msg)?;
        Ok(Some(msg))
    }

    /// Flag a message as DELETED locally and return the refreshed row — the local
    /// half of the user deleting one of their own messages (see the `delete` RPC in
    /// src/bin/server.rs). Returns `None` when the id is unknown or the row already
    /// carried the flag, so callers can skip a needless live broadcast.
    ///
    /// The stored `content` is deliberately KEPT: a deletion arriving from Teams
    /// keeps it too (see [`Store::insert_message`]), which is what lets the UI unveil
    /// what it cached. Monotonic, like the inbound path — this only ever sets the
    /// flag, never clears it.
    pub fn mark_message_deleted(
        &self,
        conversation_id: &str,
        id: &str,
    ) -> Result<Option<Message>> {
        let changed = self.exec(
            "UPDATE messages SET deleted = 1
             WHERE conversation_id = ?1 AND id = ?2 AND deleted = 0",
            params![conversation_id, id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_message(conversation_id, id)
    }

    /// Fetch a single message by id, or `None` when it is not stored. Used to
    /// emit the authoritative row after a live update, so the broadcast reflects
    /// what is persisted (including a reaction set preserved across a plain edit).
    pub fn get_message(&self, conversation_id: &str, id: &str) -> Result<Option<Message>> {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM messages WHERE conversation_id = ?1 AND id = ?2"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let msg = stmt
            .query_row(params![conversation_id, id], row_to_msg)
            .optional()?;
        Ok(msg)
    }

    /// Overwrite a message's reaction set (a whole-set snapshot, the way Teams
    /// delivers `properties.emotions`) and return the refreshed row. Returns
    /// `None` when the id is unknown or the reactions are unchanged, so callers
    /// can skip a needless live broadcast — exactly like [`Store::update_message_content`].
    ///
    /// This is the ONLY writer of the `reactions` column after the initial
    /// INSERT, which is why a reaction change propagates even when the message
    /// content is identical (the case `insert_message` deliberately ignores).
    pub fn update_message_reactions(
        &self,
        conversation_id: &str,
        id: &str,
        reactions: &str,
    ) -> Result<Option<Message>> {
        let changed = self.exec(
            "UPDATE messages SET reactions = ?3
             WHERE conversation_id = ?1 AND id = ?2 AND reactions <> ?3",
            params![conversation_id, id, reactions],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.get_message(conversation_id, id)
    }

    /// Optimistically apply OUR own reaction to a message and return the refreshed
    /// row. `key = Some("like")` makes our reaction exactly that emotion (removing
    /// us from any other, since Teams allows one reaction per user per message);
    /// `key = None` removes our reaction entirely. `time_ms` timestamps the added
    /// reaction. Returns `None` when the id is unknown or nothing changed.
    ///
    /// The server calls this right after the network PUT succeeds so open UIs
    /// reflect the reaction immediately, without waiting for the trouter echo
    /// (mirrors how `edit` optimistically updates content).
    pub fn set_my_reaction(
        &self,
        conversation_id: &str,
        id: &str,
        my_mri: &str,
        key: Option<&str>,
        time_ms: i64,
    ) -> Result<Option<Message>> {
        let Some(current) = self.get_message(conversation_id, id)? else {
            return Ok(None);
        };
        let next = apply_my_reaction(&current.reactions, my_mri, key, time_ms);
        self.update_message_reactions(conversation_id, id, &next)
    }

    /// Persist the unsent composer text for one conversation OR channel. Network
    /// syncs never write this column, so a local draft cannot be clobbered by
    /// remote metadata. A thread id is either a chat or a channel, so we try the
    /// conversations table first and fall through to channels — that way the same
    /// `set_draft` request works for both without the caller knowing which it is.
    pub fn set_draft(&self, thread_id: &str, draft: &str) -> Result<()> {
        let changed = self.exec(
            "UPDATE conversations SET draft = ?2 WHERE id = ?1",
            params![thread_id, draft],
        )?;
        if changed == 1 {
            return Ok(());
        }
        let changed = self.exec(
            "UPDATE channels SET draft = ?2 WHERE id = ?1",
            params![thread_id, draft],
        )?;
        anyhow::ensure!(changed == 1, "unknown conversation or channel: {thread_id}");
        Ok(())
    }

    /// Move our own local read position on one conversation OR channel to its last
    /// message — the local half of marking a thread read (see [`read_state`]).
    ///
    /// `ghost` records whether Teams was told: `false` after a successful
    /// `consumptionhorizon` write, `true` in Ghost mode, where the read state never
    /// leaves this machine. Like [`Store::set_draft`], a thread id is either a chat or
    /// a channel, so the conversations table is tried first and channels second.
    ///
    /// Idempotent, and returns true only when a column actually moved, so a repeated
    /// open emits no `conversations_changed` (the same guard the syncs use). The
    /// position only ever moves FORWARD: re-marking a thread whose last message we have
    /// already read is a no-op.
    pub fn mark_thread_read(&self, thread_id: &str, ghost: bool) -> Result<bool> {
        for table in ["conversations", "channels"] {
            let changed = self.exec(
                &format!(
                    // `last_message_time > 0` because a thread with no last message has
                    // nothing to be read up to — see [`read_state`], where 0 means
                    // "never read here". The rest reports a real change only: a
                    // position that moves, or a Ghost flag that flips at the same
                    // position (the row's badge has to follow it).
                    "UPDATE {table} SET local_read_time = last_message_time,
                                        local_read_ghost = ?2
                     WHERE id = ?1
                       AND last_message_time > 0
                       AND (local_read_time < last_message_time OR local_read_ghost <> ?2)"
                ),
                params![thread_id, ghost as i64],
            )?;
            if changed > 0 {
                return Ok(true);
            }
            // 0 rows can mean "no such thread here" or "already read up to date"; the
            // next table is tried either way, and an unknown id ends up as false.
        }
        Ok(false)
    }

    /// Record a chat's mute after Teams accepted it, so the sidebar dims the row now
    /// rather than on the next CSA sync.
    ///
    /// The mirror is not the truth here — Teams is, and the next sync overwrites this
    /// column from CSA's `isMuted`. That is exactly why this write is safe: it can only
    /// ever be a few seconds ahead of the value it will be told. Returns whether the
    /// row moved, so the caller only announces a real change.
    pub fn set_conversation_muted(&self, conversation_id: &str, muted: bool) -> Result<bool> {
        let changed = self.exec(
            "UPDATE conversations SET is_muted = ?2 WHERE id = ?1 AND is_muted <> ?2",
            params![conversation_id, muted as i64],
        )?;
        Ok(changed > 0)
    }

    /// The id of the newest message we hold for a thread, oldest-to-newest by `seq` —
    /// the read position to publish when marking it read. `None` when we hold no
    /// message (a thread never opened, or one whose history is only a system frame we
    /// dropped), in which case there is nothing to declare as read.
    ///
    /// Deliberately the NEWEST LOCAL message rather than the conversation's
    /// `last_message_time`: a read position must name a message the user could
    /// actually see, and only messages we hold were ever on screen.
    pub fn newest_message_id(&self, conversation_id: &str) -> Result<Option<String>> {
        Ok(self
            .query_one(
                "SELECT id FROM messages
                 WHERE conversation_id = ?1
                 ORDER BY seq DESC, id DESC LIMIT 1",
                params![conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    }

    /// What is cached for one organisation's icon: `Some(Some(media))` when we hold an
    /// icon, `Some(None)` when the domain was asked and serves none we can use, and
    /// `None` when it was never asked at all. The middle case is why this is not an
    /// `Option<Media>`: "there is none" is an answer worth remembering, because
    /// otherwise every list render would ask that server again (see `sender_icon`).
    pub fn sender_icon(&self, domain: &str) -> Result<Option<Option<crate::teams_media::Media>>> {
        let row = self
            .query_one(
                "SELECT content_type, bytes FROM sender_icons WHERE domain = ?1",
                params![domain],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<Vec<u8>>>(1)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(content_type, bytes)| match bytes {
            Some(bytes) if !bytes.is_empty() => Some(crate::teams_media::Media {
                content_type,
                bytes,
            }),
            // A row with no bytes is the remembered "this domain serves none".
            _ => None,
        }))
    }

    /// Remember one organisation's icon, or the fact that it has none (`None`). Written
    /// once per domain; a later fetch overwrites the row rather than adding one.
    pub fn put_sender_icon(
        &self,
        domain: &str,
        icon: Option<&crate::teams_media::Media>,
        fetched_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO sender_icons (domain, content_type, bytes, fetched_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(domain) DO UPDATE SET
                content_type = excluded.content_type,
                bytes        = excluded.bytes,
                fetched_ms   = excluded.fetched_ms",
            params![
                domain,
                icon.map(|i| i.content_type.as_str()).unwrap_or_default(),
                icon.map(|i| i.bytes.as_slice()),
                fetched_ms
            ],
        )?;
        Ok(())
    }

    /// Read one application setting by key. Returns `None` when the key was never
    /// set. This is a simple key/value side table (see `SCHEMA`), used for
    /// durable app configuration such as the GitLab host and access token — data
    /// that is neither a conversation nor a message. Network syncs never touch it.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .query_one(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    }

    /// Write one application setting, inserting or overwriting the existing value.
    /// An empty string is a valid stored value (e.g. "token explicitly cleared"),
    /// distinct from an absent key.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.exec(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// Remember who this store belongs to, so its history reads without the network.
    ///
    /// Every local read needs the account's own name and mri: they decide which
    /// messages are ours, and a 1:1 is titled after the OTHER person. Both used to
    /// come from the live Teams session only, so a broker outage turned a store full
    /// of history into an app that could answer nothing — see `Ctx::identity` in
    /// src/bin/server.rs. The pair never changes for a given account, so writing it
    /// on every successful sign-in costs one statement and covers every later outage.
    pub fn remember_self(&self, name: &str, mri: &str) -> Result<()> {
        if mri.trim().is_empty() {
            return Ok(());
        }
        self.set_setting(SETTING_SELF_NAME, name)?;
        self.set_setting(SETTING_SELF_MRI, mri)?;
        Ok(())
    }

    /// The account this store belongs to, as of the last successful sign-in. `None`
    /// on a store that has never recorded one — see [`Store::derived_self`], which
    /// reads it back out of the history instead.
    pub fn remembered_self(&self) -> Result<Option<SelfIdentity>> {
        let Some(mri) = self.get_setting(SETTING_SELF_MRI)? else {
            return Ok(None);
        };
        if mri.trim().is_empty() {
            return Ok(None);
        }
        let name = self.get_setting(SETTING_SELF_NAME)?.unwrap_or_default();
        Ok(Some(SelfIdentity { name, mri }))
    }

    /// Read the account's identity back out of the history, for a store synced before
    /// anything remembered it.
    ///
    /// [`Store::remember_self`] only fills in on a successful sign-in, so a store that
    /// is years old has nothing to answer with during the very outage this exists for.
    /// The history states it anyway: a one-to-one thread is
    /// `19:<oid>_<oid>@unq.gbl.spaces` and the user is one of its two parties, so the
    /// oid present in EVERY one of them is theirs. Measured on this tenant: 95 such
    /// threads intersect to exactly one oid, and `8:orgid:<that oid>` is the sender of
    /// 4716 stored messages — under the name this then reads back.
    ///
    /// Deliberately strict, because a wrong answer would draw the user's own messages
    /// as a colleague's and a colleague's as theirs. It needs two threads at least (one
    /// alone names two people and cannot say which is the reader) and exactly one
    /// common oid; anything else answers `None` rather than a guess.
    pub fn derived_self(&self) -> Result<Option<SelfIdentity>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id FROM conversations
              WHERE id LIKE '19:%@unq.gbl.spaces' AND instr(id, '_') > 0",
        )?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;

        let mut common: Option<std::collections::BTreeSet<String>> = None;
        let mut threads = 0usize;
        for id in &ids {
            let Some(parties) = one_to_one_parties(id) else { continue };
            threads += 1;
            common = Some(match common {
                None => parties,
                Some(seen) => seen.intersection(&parties).cloned().collect(),
            });
        }
        if threads < 2 {
            return Ok(None);
        }
        let mut oids = common.unwrap_or_default().into_iter();
        let (Some(oid), None) = (oids.next(), oids.next()) else {
            return Ok(None); // no common party, or more than one: never guess
        };

        let mri = format!("8:orgid:{oid}");
        // The name the user's own messages carry. Blank rows exist (an older fallback
        // for frames with no `imdisplayname`), so take the commonest non-empty one
        // rather than the newest, and accept none: the mri is the reliable half.
        let name = self
            .query_one(
                "SELECT sender FROM messages
                  WHERE sender_mri = ?1 AND sender IS NOT NULL AND sender <> ''
                  GROUP BY sender ORDER BY COUNT(*) DESC LIMIT 1",
                params![&mri],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_default();
        Ok(Some(SelfIdentity { name, mri }))
    }

    /// The name to say a message arrived *in*: a chat's display name, or a
    /// channel's "Team · Channel". `""` when the store knows neither — a chat whose
    /// title is derived per-viewer (a 1:1 is titled after the other person, which
    /// the sidebar resolves at read time) or a channel not synced yet.
    ///
    /// Used by the push path, which has a message id and needs one line of context
    /// (see [`crate::push_policy::Placement`]).
    ///
    /// `self_mri` is who WE are, so a 1:1's title can be resolved through the user's
    /// own nickname for the person on the other side and never through their nickname
    /// for themselves. Pass `""` when it is unknown; the title then stays as stored.
    pub fn conversation_context(&self, id: &str, self_mri: &str) -> Result<String> {
        let channel = self
            .query_one(
                "SELECT team_name, display_name FROM channels WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((team, channel)) = channel {
            return Ok(match (team.trim(), channel.trim()) {
                ("", "") => String::new(),
                ("", channel) => channel.to_string(),
                (team, "") => team.to_string(),
                (team, channel) => format!("{team} · {channel}"),
            });
        }
        // A 1:1's stored title IS a person's name, so a nickname has to reach it here
        // too. Without this the push on the user's phone read "Bob · Robert SMITH":
        // the sender renamed, the thread it arrived in not.
        Ok(self
            .query_one(
                "SELECT COALESCE(
                     NULLIF((
                         SELECT o.display_name FROM person_overrides o
                         WHERE c.kind = 'one_on_one' AND ?2 <> '' AND o.mri = (
                             SELECT messages.sender_mri FROM messages
                             WHERE messages.conversation_id = c.id
                               AND messages.sender_mri <> ''
                               AND messages.sender_mri <> ?2
                             ORDER BY messages.seq DESC LIMIT 1
                         )
                     ), ''),
                     c.display_name
                 )
                 FROM conversations c WHERE c.id = ?1",
                params![id, self_mri],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .unwrap_or_default())
    }

    // ---- push notifications (see src/push.rs) ------------------------------

    /// Remember one device's push subscription, replacing the row for the same
    /// endpoint.
    ///
    /// Idempotent because the client re-registers on every launch: a browser may
    /// rotate a subscription's keys under the same endpoint, and re-subscribing is
    /// how the backend learns about it. The bookkeeping (`last_ok_ms`,
    /// `last_error`) resets with the keys, since it describes the old keys.
    pub fn put_push_subscription(
        &self,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        label: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(endpoint) DO UPDATE SET
                 p256dh     = excluded.p256dh,
                 auth       = excluded.auth,
                 label      = excluded.label,
                 last_error = ''",
            params![endpoint, p256dh, auth, label, now_ms],
        )?;
        Ok(())
    }

    /// Forget one device's subscription. `true` when a row went away — the user
    /// turning notifications off on that device, or a push service telling us the
    /// subscription is gone.
    pub fn delete_push_subscription(&self, endpoint: &str) -> Result<bool> {
        Ok(self.exec("DELETE FROM push_subscriptions WHERE endpoint = ?1", params![endpoint])? > 0)
    }

    /// Every subscribed device, oldest first.
    pub fn push_subscriptions(&self) -> Result<Vec<PushSubscriptionRow>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT endpoint, p256dh, auth, label, created_ms, last_ok_ms, last_error
             FROM push_subscriptions ORDER BY created_ms ASC, endpoint ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PushSubscriptionRow {
                    endpoint: row.get(0)?,
                    p256dh: row.get(1)?,
                    auth: row.get(2)?,
                    label: row.get(3)?,
                    created_ms: row.get(4)?,
                    last_ok_ms: row.get(5)?,
                    last_error: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// How many devices are subscribed. Its own query because the live-message path
    /// asks it per message, and a user who never turned notifications on should pay
    /// one count rather than a row decode.
    pub fn count_push_subscriptions(&self) -> Result<i64> {
        Ok(self.query_one("SELECT COUNT(*) FROM push_subscriptions", params![], |row| row.get(0))?)
    }

    /// Record the outcome of a delivery: the time on success, the reason on
    /// failure. A success clears the stored error, so the Settings list shows the
    /// current state of the device rather than the worst thing that ever happened
    /// to it.
    pub fn mark_push_delivery(&self, endpoint: &str, now_ms: i64, error: &str) -> Result<()> {
        if error.is_empty() {
            self.exec(
                "UPDATE push_subscriptions SET last_ok_ms = ?2, last_error = '' WHERE endpoint = ?1",
                params![endpoint, now_ms],
            )?;
        } else {
            self.exec(
                "UPDATE push_subscriptions SET last_error = ?2 WHERE endpoint = ?1",
                params![endpoint, error],
            )?;
        }
        Ok(())
    }

    /// Claim the right to act on one live message, exactly once across every process
    /// sharing this store. `true` means "it is yours"; `false` means another backend
    /// already took it (see the `push_deliveries` note in `SCHEMA`).
    ///
    /// Two callers, one key space each: a push notification claims
    /// `<conversation>/<message>`, an agent reply claims `agent/…`.
    ///
    /// The claim is the INSERT itself — SQLite's primary key does the arbitration,
    /// so there is no window between checking and claiming.
    pub fn claim_once(&self, dedupe_key: &str, now_ms: i64) -> Result<bool> {
        Ok(self.exec(
            "INSERT OR IGNORE INTO push_deliveries (dedupe_key, claimed_ms) VALUES (?1, ?2)",
            params![dedupe_key, now_ms],
        )? > 0)
    }

    /// Record a run as in flight, from the moment its placeholder is in the thread.
    ///
    /// Replaces any row on the same message: a re-registration is the same run saying
    /// so again, never a second one — a Teams message has exactly one body.
    pub fn begin_agent_run(&self, run: &AgentRun) -> Result<()> {
        self.exec(
            "INSERT OR REPLACE INTO agent_runs
                 (conversation_id, message_id, trigger_id, backend, started_ms, heartbeat_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                run.conversation_id,
                run.message_id,
                run.trigger_id,
                run.backend,
                run.started_ms,
                run.heartbeat_ms,
            ],
        )?;
        Ok(())
    }

    /// Say the run is still writing. The absence of these beats is the ONLY signal
    /// that a run died, so this must keep ticking through a long silent tool call.
    pub fn touch_agent_run(
        &self,
        conversation_id: &str,
        message_id: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.exec(
            "UPDATE agent_runs SET heartbeat_ms = ?3
             WHERE conversation_id = ?1 AND message_id = ?2",
            params![conversation_id, message_id, now_ms],
        )?;
        Ok(())
    }

    /// Forget a run that ended, however it ended. Called on every exit path of a
    /// reply: the row means "left mid-answer", and a run that reached its own last
    /// edit did not.
    pub fn finish_agent_run(&self, conversation_id: &str, message_id: &str) -> Result<()> {
        self.exec(
            "DELETE FROM agent_runs WHERE conversation_id = ?1 AND message_id = ?2",
            params![conversation_id, message_id],
        )?;
        Ok(())
    }

    /// Every run that has not said anything since `quiet_before_ms` — the runs a
    /// process abandoned, oldest first.
    pub fn abandoned_agent_runs(&self, quiet_before_ms: i64) -> Result<Vec<AgentRun>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT conversation_id, message_id, trigger_id, backend, started_ms, heartbeat_ms
             FROM agent_runs WHERE heartbeat_ms < ?1 ORDER BY started_ms ASC",
        )?;
        let rows = stmt
            .query_map(params![quiet_before_ms], |row| {
                Ok(AgentRun {
                    conversation_id: row.get(0)?,
                    message_id: row.get(1)?,
                    trigger_id: row.get(2)?,
                    backend: row.get(3)?,
                    started_ms: row.get(4)?,
                    heartbeat_ms: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Take an abandoned run for repair. `true` means it is yours to close.
    ///
    /// The DELETE itself is the arbitration, exactly like [`Store::claim_once`]: two
    /// backends sweeping the same store both see the row, and only one of them removes
    /// it — so only one edits the message. The heartbeat is re-checked here rather than
    /// trusted from the listing, because a run whose process came back to life between
    /// the two must keep its message.
    ///
    /// A caller whose repair then FAILS puts the row back
    /// ([`Store::begin_agent_run`]), so the next sweep tries again. That is why the
    /// claim is the row and not a `push_deliveries` key: a key, once taken, is taken
    /// for a day, and a message left frozen is the thing this whole table exists to
    /// prevent.
    pub fn take_abandoned_agent_run(
        &self,
        conversation_id: &str,
        message_id: &str,
        quiet_before_ms: i64,
    ) -> Result<bool> {
        Ok(self.exec(
            "DELETE FROM agent_runs
             WHERE conversation_id = ?1 AND message_id = ?2 AND heartbeat_ms < ?3",
            params![conversation_id, message_id, quiet_before_ms],
        )? > 0)
    }

    /// Drop claims older than `before_ms`. They only exist to stop two backends
    /// acting twice on a LIVE message, and every policy already refuses anything older
    /// than a few minutes, so keeping them forever would grow a table nobody reads.
    pub fn prune_claims(&self, before_ms: i64) -> Result<usize> {
        Ok(self.exec("DELETE FROM push_deliveries WHERE claimed_ms < ?1", params![before_ms])?)
    }

    /// Backfill `sender_mri` on an existing row that predates the column (its MRI
    /// is NULL or empty). `insert_message` only ever updates `content` on
    /// conflict, so a re-fetch never rewrites `sender_mri` on its own — this
    /// heals legacy history so our own old messages get tagged as ours. No-op
    /// when the MRI is already set or the incoming MRI is empty.
    pub fn backfill_sender_mri(&self, conversation_id: &str, id: &str, sender_mri: &str) -> Result<()> {
        if sender_mri.is_empty() {
            return Ok(());
        }
        self.exec(
            "UPDATE messages SET sender_mri = ?3
             WHERE conversation_id = ?1 AND id = ?2
               AND (sender_mri IS NULL OR sender_mri = '')",
            params![conversation_id, id, sender_mri],
        )?;
        Ok(())
    }

    /// Backfill `mentions` on an existing row that has none recorded — either a
    /// legacy row stored before the column existed, or one ingested by a frame
    /// whose body was unchanged (`insert_message` only rewrites mentions when it
    /// rewrites content). This is what makes already-synced history show person
    /// cards on its @mentions after a refresh. No-op when the row already lists
    /// mentions or the incoming list is empty.
    pub fn backfill_mentions(&self, conversation_id: &str, id: &str, mentions: &str) -> Result<()> {
        if mentions.is_empty() || mentions == "[]" {
            return Ok(());
        }
        self.exec(
            "UPDATE messages SET mentions = ?3
             WHERE conversation_id = ?1 AND id = ?2
               AND (mentions IS NULL OR mentions = '' OR mentions = '[]')",
            params![conversation_id, id, mentions],
        )?;
        Ok(())
    }

    /// All conversations, most-recently-active first, for the list pane.
    ///
    /// Conversations with an empty stored title (1:1 chats) get their name derived
    /// from the most recent message sender that is not `self_name`. `self_name`
    /// may be empty (then no derivation happens).
    pub fn conversations(&self, self_name: &str) -> Result<Vec<ConversationRow>> {
        // Correlated subqueries fill the blank 1:1 titles, pick each 1:1's other
        // party, and resolve both names the row states through the user's own
        // nicknames — all in a single pass.
        let sql = format!(
            "SELECT c.id,
                    -- A 1:1's title IS a person, so the user's own name for them wins
                    -- over both the synced title and the derived one. The other-party
                    -- subquery tests the kind itself, so a group is never retitled by
                    -- renaming one of its members: its title names no single person.
                    COALESCE(
                        NULLIF((
                            SELECT o.display_name FROM person_overrides o
                            WHERE o.mri = ({OTHER_PARTY_MRI})
                        ), ''),
                        NULLIF(c.display_name, ''),
                        (
                            SELECT {SENDER} FROM messages
                            WHERE messages.conversation_id = c.id
                              AND messages.sender <> '' AND messages.sender <> ?1
                            ORDER BY messages.seq DESC LIMIT 1
                        ),
                        ''
                    ) AS name,
                    c.last_message_time,
                    c.kind,
                    c.last_message_preview,
                    {PREVIEW_SENDER} AS last_message_sender,
                    c.last_message_from_me,
                    c.is_read,
                    c.is_muted,
                    c.is_pinned,
                    c.is_hidden,
                    c.thread_type,
                    c.draft,
                    -- the other party's MRI, for their profile photo. Only for 1:1
                    -- chats (a group has no single face); the newest message sender
                    -- that isn't us, mirroring the name-derivation filter above.
                    COALESCE(({OTHER_PARTY_MRI}), '') AS avatar_mri,
                    -- the group's own uploaded picture (empty for a 1:1, which has a
                    -- face already, and for a group that never set one)
                    c.picture_url,
                    c.local_read_time,
                    c.local_read_ghost
             FROM conversations c
             -- a channel that leaked into the conversations table (a live post that
             -- landed before the CSA sync classified it) must never show in the chat
             -- list; exclude any id the channels table now owns. persist_channels
             -- also deletes such rows, so this is belt-and-suspenders. The channels
             -- table only covers channels CSA has actually surfaced, though — a
             -- `@thread.tacv2` thread CSA never classified would slip through here, so
             -- the collect below applies is_channel_thread_id as the canonical gate.
             WHERE c.id NOT IN (SELECT id FROM channels)
             ORDER BY c.is_pinned DESC, c.last_message_time DESC, c.id ASC",
            OTHER_PARTY_MRI = OTHER_PARTY_MRI,
            SENDER = nicknamed!("messages.sender_mri", "messages.sender"),
            PREVIEW_SENDER = nicknamed!("c.last_message_sender_mri", "c.last_message_sender"),
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![self_name], |r| {
            let last_message_time: i64 = r.get(2)?;
            let (is_read, is_ghost_read) = read_state(
                r.get::<_, i64>(7)? != 0,
                r.get(15)?,
                r.get::<_, i64>(16)? != 0,
                last_message_time,
            );
            Ok(ConversationRow {
                id: r.get(0)?,
                display_name: r.get(1)?,
                last_message_time,
                kind: ConversationKind::from_str(&r.get::<_, String>(3)?),
                last_message_preview: r.get(4)?,
                last_message_sender: r.get(5)?,
                last_message_from_me: r.get::<_, i64>(6)? != 0,
                is_read,
                is_ghost_read,
                is_muted: r.get::<_, i64>(8)? != 0,
                is_pinned: r.get::<_, i64>(9)? != 0,
                is_hidden: r.get::<_, i64>(10)? != 0,
                thread_type: r.get(11)?,
                draft: r.get(12)?,
                avatar_mri: r.get(13)?,
                picture_url: r.get(14)?,
            })
        })?;
        // Canonical chat/channel gate, mirroring the live-message path in the
        // server (is_channel_thread_id || is_channel). The SQL above only knows the
        // channels table; this drops any tacv2 thread CSA has not yet classified so
        // a channel can never leak into the chat sidebar.
        let mut conversations: Vec<ConversationRow> = rows
            .filter(|r| {
                r.as_ref()
                    .map(|c| !crate::teams_read::is_channel_thread_id(&c.id))
                    .unwrap_or(true)
            })
            .collect::<rusqlite::Result<_>>()?;
        // A synced preview can be empty (the newest frame was a system event, or an
        // emoji/image-only body an older build previewed as nothing); derive one from
        // what we hold rather than showing a blank row.
        for conversation in &mut conversations {
            if conversation.last_message_preview.is_empty() {
                conversation.last_message_preview = self.derived_preview(&conversation.id)?;
            }
        }
        Ok(conversations)
    }

    /// Derive a display name for a conversation whose stored title is empty
    /// (typically a 1:1 chat, whose CSA `title` is blank and whose `members`
    /// carry no names). Heuristic: the most recent message sender that is NOT us.
    /// Returns None when we hold no message from the other party yet.
    pub fn other_party_name(&self, conversation_id: &str, self_name: &str) -> Result<Option<String>> {
        let sql = format!(
            "SELECT {SENDER} FROM messages
             WHERE messages.conversation_id = ?1
               AND messages.sender <> '' AND messages.sender <> ?2
             ORDER BY messages.seq DESC LIMIT 1",
            SENDER = nicknamed!("messages.sender_mri", "messages.sender"),
        );
        let name: Option<String> = self
            .query_one(&sql, params![conversation_id, self_name], |r| r.get(0))
            .ok();
        Ok(name)
    }

    /// Resolve a display name for a sender MRI without going to the network. Used by
    /// the typing indicator (a `Control/Typing` frame carries the typer's MRI but no
    /// display name) and by the read receipts.
    ///
    /// The user's own nickname for that person answers first, so a rename holds even
    /// for somebody who has never written in a thread we hold; otherwise it is the
    /// most recent non-empty `sender` we stored for that MRI. None when neither exists.
    pub fn display_name_for_mri(&self, sender_mri: &str) -> Result<Option<String>> {
        if sender_mri.is_empty() {
            return Ok(None);
        }
        let name: Option<String> = self
            .query_one(
                "SELECT COALESCE(
                     NULLIF((SELECT o.display_name FROM person_overrides o WHERE o.mri = ?1), ''),
                     (SELECT sender FROM messages
                      WHERE sender_mri = ?1 AND sender <> ''
                      ORDER BY seq DESC LIMIT 1)
                 )",
                params![sender_mri],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
        Ok(name)
    }

    /// The name TEAMS holds for a person, from the messages we already store, with no
    /// override applied. The counterpart to [`Store::display_name_for_mri`], and the
    /// reason a rename is not a lie: the surface that offers the rename shows this
    /// beside it, so the user can always see who a renamed person actually is.
    pub fn teams_display_name_for_mri(&self, sender_mri: &str) -> Result<Option<String>> {
        if sender_mri.is_empty() {
            return Ok(None);
        }
        let name: Option<String> = self
            .query_one(
                "SELECT sender FROM messages
                 WHERE sender_mri = ?1 AND sender <> ''
                 ORDER BY seq DESC LIMIT 1",
                params![sender_mri],
                |r| r.get(0),
            )
            .ok();
        Ok(name)
    }

    // ---- person overrides (the name and face the USER gave somebody) ------------

    /// Read back the override the user set for one person, or None when they set
    /// none. The avatar bytes come with it, because the only caller that wants the
    /// row at all is either serving that picture or showing the user what they set.
    pub fn person_override(&self, mri: &str) -> Result<Option<PersonOverride>> {
        if mri.is_empty() {
            return Ok(None);
        }
        let row = self.query_one(
            "SELECT mri, display_name, avatar_content_type, avatar_bytes, updated_at
             FROM person_overrides WHERE mri = ?1",
            params![mri],
            |r| {
                Ok(PersonOverride {
                    mri: r.get(0)?,
                    display_name: r.get(1)?,
                    avatar_content_type: r.get(2)?,
                    avatar_bytes: r.get::<_, Option<Vec<u8>>>(3)?.unwrap_or_default(),
                    updated_at: r.get(4)?,
                })
            },
        );
        match row {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Every person the user renamed or gave a face, newest change first — without the
    /// avatar BYTES, which the caller does not need to list them and which would make
    /// listing cost megabytes. `has_avatar` says whether a picture is set; the bytes
    /// come from [`Store::person_override`], one person at a time, the way the UI asks
    /// for a photo anyway.
    pub fn person_overrides(&self) -> Result<Vec<PersonOverrideSummary>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT mri, display_name, avatar_bytes IS NOT NULL, updated_at
             FROM person_overrides ORDER BY updated_at DESC, mri ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(PersonOverrideSummary {
                mri: r.get(0)?,
                display_name: r.get(1)?,
                has_avatar: r.get::<_, i64>(2)? != 0,
                updated_at: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Set — or with `None`, clear — the name the user wants to see for one person.
    /// The picture they set is left alone: the two halves of an override are
    /// independent, so renaming somebody never drops the face they were given.
    ///
    /// Clearing the last half of an override DELETES the row, so "no override" is
    /// always the absence of a row (see the `person_overrides` note in [`SCHEMA`]).
    pub fn set_person_name(&self, mri: &str, name: Option<&str>, now_ms: i64) -> Result<()> {
        anyhow::ensure!(!mri.is_empty(), "a person override needs an MRI");
        let name = name.unwrap_or("").trim();
        self.exec(
            "INSERT INTO person_overrides (mri, display_name, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(mri) DO UPDATE SET display_name = ?2, updated_at = ?3",
            params![mri, name, now_ms],
        )?;
        self.prune_empty_person_override(mri)?;
        Ok(())
    }

    /// Set — or with `None`, clear — the picture the user gave one person. The name
    /// they set is left alone, for the same reason as above.
    ///
    /// The bytes are stored verbatim; validating the type and the size is the RPC's
    /// job (see `set_person_avatar` in `src/bin/server.rs`), because that is where a
    /// client's input arrives.
    pub fn set_person_avatar(
        &self,
        mri: &str,
        avatar: Option<(&str, &[u8])>,
        now_ms: i64,
    ) -> Result<()> {
        anyhow::ensure!(!mri.is_empty(), "a person override needs an MRI");
        let (content_type, bytes) = match avatar {
            Some((t, b)) => (t, Some(b)),
            None => ("", None),
        };
        self.exec(
            "INSERT INTO person_overrides (mri, avatar_content_type, avatar_bytes, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(mri) DO UPDATE SET
                avatar_content_type = ?2, avatar_bytes = ?3, updated_at = ?4",
            params![mri, content_type, bytes, now_ms],
        )?;
        self.prune_empty_person_override(mri)?;
        Ok(())
    }

    /// Drop an override row that no longer overrides anything, so every read can treat
    /// the presence of a row as "the user decided something about this person".
    fn prune_empty_person_override(&self, mri: &str) -> Result<()> {
        self.exec(
            "DELETE FROM person_overrides
             WHERE mri = ?1 AND display_name = '' AND avatar_bytes IS NULL",
            params![mri],
        )?;
        Ok(())
    }

    /// Every custom emoji in the pack, ordered by name ascending, bytes excluded.
    pub fn custom_emoji(&self) -> Result<Vec<crate::custom_emoji::CustomEmoji>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT name, alias_of, content_type, width, height, source, added_ms
             FROM custom_emoji ORDER BY name ASC"
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(crate::custom_emoji::CustomEmoji {
                name: r.get(0)?,
                alias_of: r.get(1)?,
                content_type: r.get(2)?,
                width: r.get(3)?,
                height: r.get(4)?,
                source: r.get(5)?,
                added_ms: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The raster art for one custom emoji: `(content_type, bytes)`, following one
    /// alias hop. Returns `None` when the name is not in the pack or when an alias
    /// points at a name that does not exist.
    pub fn custom_emoji_art(&self, name: &str) -> Result<Option<(String, Vec<u8>)>> {
        // ponytail: follow one hop, an alias may not point at an alias
        let row: Option<(String, String, Option<Vec<u8>>)> = self.conn
            .query_row(
                "SELECT alias_of, content_type, bytes FROM custom_emoji WHERE name = ?1",
                params![name],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;

        match row {
            None => Ok(None),
            Some((alias_of, _, _)) if !alias_of.is_empty() => {
                // This row is an alias; follow one hop to the target.
                let target: Option<(String, Vec<u8>)> = self.conn
                    .query_row(
                        "SELECT content_type, bytes FROM custom_emoji
                         WHERE name = ?1 AND alias_of = ''",
                        params![alias_of],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                Ok(target)
            }
            Some((_, content_type, Some(bytes))) => {
                // This row holds art directly.
                Ok(Some((content_type, bytes)))
            }
            Some((_, _, None)) => Ok(None),
        }
    }

    /// Set — or with both `None`, remove — one custom emoji. Exactly one of `art` or
    /// `alias_of` must be present; both or neither is refused. An alias may not point
    /// at an alias. The name is validated, and dimensions are capped. Validating the
    /// byte cap and content type is the RPC's job (where a client's input arrives),
    /// exactly like `set_person_avatar`.
    pub fn set_custom_emoji(
        &self,
        name: &str,
        art: Option<(&str, &[u8], u32, u32)>,
        alias_of: Option<&str>,
        source: &str,
        now_ms: i64,
    ) -> Result<()> {
        anyhow::ensure!(
            crate::custom_emoji::is_valid_name(name),
            "invalid custom emoji name: {name}"
        );

        match (art, alias_of) {
            (Some((content_type, bytes, width, height)), None) => {
                anyhow::ensure!(
                    width <= crate::custom_emoji::MAX_CUSTOM_EMOJI_DIMENSION,
                    "emoji width {width} exceeds {}", crate::custom_emoji::MAX_CUSTOM_EMOJI_DIMENSION
                );
                anyhow::ensure!(
                    height <= crate::custom_emoji::MAX_CUSTOM_EMOJI_DIMENSION,
                    "emoji height {height} exceeds {}", crate::custom_emoji::MAX_CUSTOM_EMOJI_DIMENSION
                );
                self.exec(
                    "INSERT INTO custom_emoji (name, alias_of, content_type, bytes, width, height, source, added_ms)
                     VALUES (?1, '', ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(name) DO UPDATE SET
                        alias_of = '', content_type = ?2, bytes = ?3,
                        width = ?4, height = ?5, source = ?6, added_ms = ?7",
                    params![name, content_type, bytes, width, height, source, now_ms],
                )?;
            }
            (None, Some(target)) => {
                // An alias may not point at an alias.
                let target_row: Option<String> = self.conn
                    .query_row(
                        "SELECT alias_of FROM custom_emoji WHERE name = ?1",
                        params![target],
                        |r| r.get(0),
                    )
                    .optional()?;
                anyhow::ensure!(
                    target_row == Some(String::new()),
                    "an alias may not point at an alias"
                );
                self.exec(
                    "INSERT INTO custom_emoji (name, alias_of, content_type, bytes, width, height, source, added_ms)
                     VALUES (?1, ?2, '', NULL, 0, 0, ?3, ?4)
                     ON CONFLICT(name) DO UPDATE SET
                        alias_of = ?2, content_type = '', bytes = NULL,
                        width = 0, height = 0, source = ?3, added_ms = ?4",
                    params![name, target, source, now_ms],
                )?;
            }
            (None, None) => {
                anyhow::bail!("a custom emoji is either art or an alias");
            }
            (Some(_), Some(_)) => {
                anyhow::bail!("a custom emoji is either art or an alias, not both");
            }
        }
        Ok(())
    }

    /// Remove one custom emoji. Returns `true` when it was there, `false` when it was not.
    pub fn remove_custom_emoji(&self, name: &str) -> Result<bool> {
        let count = self.exec("DELETE FROM custom_emoji WHERE name = ?1", params![name])?;
        Ok(count > 0)
    }

    /// Everybody who has written in a conversation, most recent contributor first:
    /// their MRI and the display name their newest message carries (empty when we
    /// never captured one), resolved through the user's own nickname for them.
    /// Local and network-free.
    ///
    /// This is what an @mention list is built from in a CHANNEL, whose roster Teams
    /// does not expose on the thread (see src/teams_members.rs), and what completes a
    /// chat's roster with the names it already knows. `MAX(seq)` makes `sender` a
    /// well-defined bare column in SQLite — the value from the row that holds the
    /// maximum — so each person is named by their latest message, not an arbitrary one.
    pub fn thread_senders(&self, conversation_id: &str, limit: i64) -> Result<Vec<(String, String)>> {
        // The nickname is resolved OUTSIDE the aggregate, on the grouping key, so it
        // cannot depend on which row `MAX(seq)` picked.
        let sql = format!(
            "SELECT sender_mri, {SENDER}, MAX(seq) AS last_seq FROM messages
             WHERE conversation_id = ?1 AND sender_mri <> ''
             GROUP BY sender_mri
             ORDER BY last_seq DESC
             LIMIT ?2",
            SENDER = nicknamed!("messages.sender_mri", "sender"),
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![conversation_id, limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The newest `limit` messages of a conversation, ordered oldest -> newest (for display).
    pub fn newest_messages(&self, conversation_id: &str, limit: i64) -> Result<Vec<Message>> {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT ?2"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![conversation_id, limit], row_to_msg)?;
        let mut v: Vec<Message> = rows.collect::<rusqlite::Result<_>>()?;
        v.reverse(); // oldest -> newest
        Ok(v)
    }

    /// The `limit` messages immediately older than `before_seq`, ordered oldest -> newest.
    /// Used when the UI scrolls up; if it returns fewer than `limit`, the caller should
    /// check `has_more_older` and fetch the next page from the network.
    pub fn messages_before(&self, conversation_id: &str, before_seq: i64, limit: i64) -> Result<Vec<Message>> {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM messages
             WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt.query_map(params![conversation_id, before_seq, limit], row_to_msg)?;
        let mut v: Vec<Message> = rows.collect::<rusqlite::Result<_>>()?;
        v.reverse();
        Ok(v)
    }

    /// Record how far back we have synced from the server for a conversation.
    pub fn set_oldest_cursor(&self, conversation_id: &str, cursor: Option<&str>, has_more: bool) -> Result<()> {
        self.exec(
            "UPDATE conversations SET oldest_cursor = ?2, has_more_older = ?3 WHERE id = ?1",
            params![conversation_id, cursor, has_more as i64],
        )?;
        Ok(())
    }

    /// (server cursor for the next older page, whether more history exists).
    pub fn oldest_cursor(&self, conversation_id: &str) -> Result<(Option<String>, bool)> {
        let row = self.query_one(
            "SELECT oldest_cursor, has_more_older FROM conversations WHERE id = ?1",
            params![conversation_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? != 0)),
        );
        match row {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok((None, true)),
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(conv: &str, seq: i64) -> Message {
        Message {
            id: format!("m{seq}"),
            conversation_id: conv.to_string(),
            seq,
            compose_time: seq,
            sender: "alice".into(),
            sender_mri: String::new(),
            content: format!("message {seq}"),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }
    }

    /// Minimal `ConversationUpdate` for the kind/change-detection tests: only the
    /// id/name/time/kind vary; the sidebar fields take neutral defaults.
    fn upd<'a>(id: &'a str, name: &'a str, time: i64, kind: ConversationKind) -> ConversationUpdate<'a> {
        ConversationUpdate {
            id,
            display_name: name,
            last_message_time: time,
            kind,
            last_message_preview: "",
            last_message_sender: "",
            last_message_sender_mri: "",
            last_message_from_me: false,
            is_read: true,
            is_muted: false,
            is_pinned: false,
            is_hidden: false,
            thread_type: "",
            picture_url: "",
        }
    }

    /// Minimal `ChannelUpdate` for the channel tests: id/team/name/time/read vary,
    /// the rest take neutral defaults.
    fn chan_upd<'a>(
        id: &'a str,
        team_id: &'a str,
        team_name: &'a str,
        name: &'a str,
        time: i64,
    ) -> ChannelUpdate<'a> {
        ChannelUpdate {
            id,
            team_id,
            team_name,
            team_group_id: "",
            display_name: name,
            is_general: false,
            is_shown: true,
            is_pinned: false,
            team_collapsed: false,
            last_message_time: time,
            last_message_preview: "",
            last_message_sender: "",
            last_message_sender_mri: "",
            last_message_from_me: false,
            is_read: true,
            alerts: ChannelAlerts::MentionsOnly,
            team_pos: 0,
            channel_pos: 0,
        }
    }

    /// A unique on-disk path: `user_version`, WAL and the schema-skip path only
    /// exist for a real file, so these cannot use `:memory:`.
    fn temp_db(tag: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("teams-lite-store-{tag}-{}.sqlite", std::process::id()));
        remove_db(&p);
        p
    }

    fn remove_db(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = path.as_os_str().to_owned();
            p.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
    }

    /// The planner's chosen plan for `sql`, one step per line.
    fn query_plan(s: &Store, sql: &str) -> String {
        let mut stmt = s.conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let steps: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        steps.join("\n")
    }

    #[test]
    fn open_records_the_schema_version_and_reopens_without_rebuilding() {
        let path = temp_db("version");
        let p = path.to_str().unwrap();
        {
            let s = Store::open(p).unwrap();
            s.upsert_conversation("c1", "Chat", 100).unwrap();
            s.insert_message(&msg("c1", 1)).unwrap();
            assert_eq!(
                s.conn
                    .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                SCHEMA_VERSION
            );
        }
        // Re-opening an initialized store skips the schema pass and keeps the data.
        let s = Store::open(p).unwrap();
        assert_eq!(s.newest_messages("c1", 10).unwrap().len(), 1);
        assert_eq!(s.conversations("").unwrap().len(), 1);
        // WAL is a property of the file, so it survives an open that never sets it.
        let mode: String = s
            .conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        // ...whereas durability is per-connection and must be re-applied: WAL +
        // NORMAL (1) is what keeps a commit from fsync-ing.
        let sync: i64 = s
            .conn
            .pragma_query_value(None, "synchronous", |r| r.get(0))
            .unwrap();
        assert_eq!(sync, 1, "expected synchronous=NORMAL");
        drop(s);
        remove_db(&path);
    }

    #[test]
    fn open_upgrades_a_store_that_predates_the_schema_version() {
        let path = temp_db("legacy");
        let p = path.to_str().unwrap();
        // A store as an older build left it: no `user_version`, the narrow message
        // index, and none of the columns the guarded ALTERs add.
        {
            let conn = Connection::open(p).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversations (id TEXT PRIMARY KEY, display_name TEXT, last_message_time INTEGER NOT NULL DEFAULT 0, oldest_cursor TEXT, has_more_older INTEGER NOT NULL DEFAULT 1);
                 CREATE TABLE messages (id TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, compose_time INTEGER NOT NULL DEFAULT 0, sender TEXT, content TEXT, PRIMARY KEY (conversation_id, id));
                 CREATE INDEX idx_msg_conv_seq ON messages(conversation_id, seq);
                 INSERT INTO conversations (id, display_name) VALUES ('c1', 'Chat');
                 INSERT INTO messages (id, conversation_id, seq, sender, content) VALUES ('m1', 'c1', 1, 'alice', 'hello');",
            )
            .unwrap();
        }

        let s = Store::open(p).unwrap();

        // The legacy rows survive, now readable through the current column set.
        let stored = s.newest_messages("c1", 10).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].content, "hello");
        assert_eq!(stored[0].mentions, "[]", "legacy row gets the column default");

        let indexes: Vec<String> = {
            let mut stmt = s
                .conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
                .unwrap();
            stmt.query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        for expected in [
            "idx_conv_sidebar_order",
            "idx_msg_conv_seq_sender",
            "idx_msg_sender_mri",
        ] {
            assert!(indexes.iter().any(|i| i == expected), "missing {expected} in {indexes:?}");
        }
        assert!(
            !indexes.iter().any(|i| i == "idx_msg_conv_seq"),
            "the narrow index is superseded and must be dropped: {indexes:?}"
        );
        drop(s);
        remove_db(&path);
    }

    /// A column added to `migrate()` only reaches an EXISTING store when
    /// SCHEMA_VERSION is bumped with it: `open` runs the pass ONLY when the file's
    /// recorded version differs from the current one.
    ///
    /// Regression: `conversations.picture_url` shipped without the bump. Every store
    /// already at the previous version kept the old column set, so every query naming
    /// the column failed outright — an empty sidebar, on the user's own machine, with
    /// a full test suite passing on fresh in-memory stores.
    #[test]
    fn open_grows_a_column_the_previous_version_lacked() {
        let path = temp_db("column_bump");
        let p = path.to_str().unwrap();
        // A store as the previous build left it: a `conversations` table without the
        // column, carrying real rows, and STAMPED — which is the whole point, since a
        // stamped store is the one `open` would otherwise leave alone.
        {
            let conn = Connection::open(p).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversations (
                    id TEXT PRIMARY KEY,
                    display_name TEXT,
                    last_message_time INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO conversations (id, display_name) VALUES ('c1', 'Chat');",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION - 1).unwrap();
        }

        let s = Store::open(p).unwrap();

        // The pass ran: the column is back with its default, the row survived, and
        // the sidebar query that names the column answers instead of failing.
        let rows = s.conversations("").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].display_name, "Chat");
        assert_eq!(rows[0].picture_url, "");
        drop(s);
        remove_db(&path);
    }

    /// Every column this file can create, in one canonical list: the `SCHEMA` batch's
    /// own definitions plus every `ADD COLUMN` in [`migrate`]. Read out of the module's
    /// own source, so it cannot drift from what the code actually does.
    fn declared_columns(source: &str) -> Vec<String> {
        let mut columns = Vec::new();
        let mut table = String::new();
        for raw in source.lines() {
            let line = raw.trim();
            if let Some(rest) = line.strip_prefix("CREATE TABLE IF NOT EXISTS ") {
                table = rest.split_whitespace().next().unwrap_or("").to_string();
                continue;
            }
            if line.starts_with(')') {
                table.clear();
                continue;
            }
            // `ALTER TABLE <t> ADD COLUMN <c> …`, in either spelling migrate uses
            // (a literal, or a `format!` whose table name is `{table}`).
            if let Some(rest) = line.split(" ADD COLUMN ").nth(1) {
                if let Some(alter) = line.split("ALTER TABLE ").nth(1) {
                    let altered = alter.split_whitespace().next().unwrap_or("");
                    let column = rest.split_whitespace().next().unwrap_or("");
                    columns.push(format!("{altered}.{column}"));
                }
                continue;
            }
            // A column definition inside the SCHEMA batch: `name TYPE …,`. Comments,
            // table constraints and index DDL are skipped.
            if table.is_empty() || line.starts_with("--") || line.is_empty() {
                continue;
            }
            let mut words = line.split_whitespace();
            let (Some(name), Some(kind)) = (words.next(), words.next()) else { continue };
            if !matches!(kind.trim_end_matches(','), "TEXT" | "INTEGER" | "REAL" | "BLOB") {
                continue;
            }
            columns.push(format!("{table}.{name}"));
        }
        columns.sort();
        columns.dedup();
        columns
    }

    /// A stable fingerprint (FNV-1a) of that list. No dependency, and stable across
    /// runs and machines, which a `DefaultHasher` is explicitly not.
    fn fingerprint(columns: &[String]) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in columns.join(",").bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    /// The column set this file creates, pinned to [`SCHEMA_VERSION`].
    ///
    /// THE BUG THIS EXISTS FOR, twice over: a column was added to `SCHEMA`/[`migrate`]
    /// and the version was not bumped. `open` runs the DDL pass only when the file's
    /// recorded `user_version` differs, so every EXISTING store — the user's own —
    /// kept the old column set, and every query naming the new column failed outright.
    /// The sidebar went empty on a live machine while the whole suite passed, because a
    /// fresh in-memory store always has every column.
    ///
    /// `open_grows_a_column_the_previous_version_lacked` cannot catch it: it stamps a
    /// store one version behind, so the pass runs whether or not the bump happened.
    /// This test compares the DDL itself against a recorded fingerprint, so touching a
    /// column forces the same change that makes existing stores grow it.
    #[test]
    fn schema_columns_are_pinned_to_the_version() {
        // Bump SCHEMA_VERSION and paste the printed fingerprint here, together.
        const PINNED: (i64, u64) = (14, 0xc4a6_c768_8fef_28a7);
        let columns = declared_columns(include_str!("store.rs"));
        let actual = fingerprint(&columns);
        assert_eq!(
            (SCHEMA_VERSION, actual),
            PINNED,
            "the store's column set changed ({} columns).\n\
             Bump SCHEMA_VERSION (existing stores only run the DDL pass when it moves) \
             and set PINNED to ({}, {:#018x}).",
            columns.len(),
            SCHEMA_VERSION,
            actual,
        );
    }

    #[test]
    fn hot_read_paths_never_scan_the_messages_table() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "", 100).unwrap();
        for i in 1..=20 {
            let mut m = msg("c1", i);
            m.sender_mri = "8:orgid:alice".into();
            s.insert_message(&m).unwrap();
        }

        // The typing indicator / read-receipt name lookup, once per frame.
        let plan = query_plan(
            &s,
            "SELECT sender FROM messages WHERE sender_mri = '8:orgid:alice' AND sender <> '' ORDER BY seq DESC LIMIT 1",
        );
        assert!(plan.contains("idx_msg_sender_mri"), "plan was:\n{plan}");
        assert!(!plan.contains("SCAN messages"), "plan was:\n{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "plan was:\n{plan}");

        // A message page.
        let plan = query_plan(
            &s,
            "SELECT content FROM messages WHERE conversation_id = 'c1' ORDER BY seq DESC LIMIT 51",
        );
        assert!(plan.contains("idx_msg_conv_seq_sender"), "plan was:\n{plan}");
        assert!(!plan.contains("SCAN messages"), "plan was:\n{plan}");

        // The sidebar list: ordered by index (no sort pass) and its correlated
        // name/avatar lookups served entirely from the covering index.
        let plan = query_plan(
            &s,
            "SELECT c.id, COALESCE((SELECT m.sender FROM messages m WHERE m.conversation_id = c.id AND m.sender <> '' AND m.sender <> 'me' ORDER BY m.seq DESC LIMIT 1), '')
             FROM conversations c WHERE c.id NOT IN (SELECT id FROM channels)
             ORDER BY c.is_pinned DESC, c.last_message_time DESC, c.id ASC",
        );
        assert!(plan.contains("idx_conv_sidebar_order"), "plan was:\n{plan}");
        assert!(plan.contains("COVERING INDEX idx_msg_conv_seq_sender"), "plan was:\n{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "plan was:\n{plan}");
    }

    #[test]
    fn transaction_commits_the_batch_and_rolls_back_on_error() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let inserted = s
            .transaction(|| {
                let mut n = 0;
                for i in 1..=10 {
                    if s.insert_message(&msg("c1", i))? {
                        n += 1;
                    }
                }
                Ok(n)
            })
            .unwrap();
        assert_eq!(inserted, 10);
        assert_eq!(s.newest_messages("c1", 50).unwrap().len(), 10);

        // A failure part-way through leaves the store exactly as it was.
        let failed: Result<()> = s.transaction(|| {
            s.insert_message(&msg("c1", 11))?;
            anyhow::bail!("halfway failure")
        });
        assert!(failed.is_err());
        assert_eq!(
            s.newest_messages("c1", 50).unwrap().len(),
            10,
            "a rolled-back batch must not leave partial rows behind"
        );
    }

    #[test]
    fn cleanups_run_once_per_revision() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.cleanups_pending().unwrap(), "a fresh store has never cleaned");
        s.mark_cleanups_done().unwrap();
        assert!(!s.cleanups_pending().unwrap(), "the recorded revision skips the scans");
        // A store that recorded an older revision runs the new pass again.
        s.set_setting("cleanup_revision", &(CLEANUP_REVISION - 1).to_string())
            .unwrap();
        assert!(s.cleanups_pending().unwrap());
    }

    #[test]
    fn settings_get_returns_none_when_unset() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.get_setting("gitlab_token").unwrap(), None);
    }

    #[test]
    fn settings_set_then_get_roundtrips() {
        let s = Store::open_in_memory().unwrap();
        s.set_setting("gitlab_host", "gitlab.example.com").unwrap();
        assert_eq!(
            s.get_setting("gitlab_host").unwrap().as_deref(),
            Some("gitlab.example.com")
        );
    }

    #[test]
    fn settings_set_overwrites_existing_value() {
        let s = Store::open_in_memory().unwrap();
        s.set_setting("gitlab_token", "first").unwrap();
        s.set_setting("gitlab_token", "second").unwrap();
        assert_eq!(s.get_setting("gitlab_token").unwrap().as_deref(), Some("second"));
    }

    #[test]
    fn settings_empty_string_is_stored_and_distinct_from_unset() {
        let s = Store::open_in_memory().unwrap();
        s.set_setting("gitlab_token", "").unwrap();
        // An explicitly-cleared token is an empty string, not an absent key.
        assert_eq!(s.get_setting("gitlab_token").unwrap().as_deref(), Some(""));
    }

    #[test]
    fn pagination_and_dedup() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        for i in 1..=100 {
            assert!(s.insert_message(&msg("c1", i)).unwrap());
        }

        // dedup: re-inserting an existing id is ignored
        assert!(!s.insert_message(&msg("c1", 50)).unwrap());

        // initial open: newest page, ordered oldest -> newest
        let newest = s.newest_messages("c1", 10).unwrap();
        assert_eq!(newest.len(), 10);
        assert_eq!(newest.first().unwrap().seq, 91);
        assert_eq!(newest.last().unwrap().seq, 100);

        // scroll up: older page before seq 91
        let older = s.messages_before("c1", 91, 10).unwrap();
        assert_eq!(older.len(), 10);
        assert_eq!(older.first().unwrap().seq, 81);
        assert_eq!(older.last().unwrap().seq, 90);

        // reaching the very top returns fewer than requested
        let top = s.messages_before("c1", 3, 10).unwrap();
        assert_eq!(top.len(), 2); // seq 1 and 2
        assert_eq!(top.first().unwrap().seq, 1);
    }

    #[test]
    fn edit_updates_content_and_reports_change() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        assert!(s.insert_message(&msg("c1", 1)).unwrap());

        // Re-inserting the same id with identical content is a no-op.
        assert!(!s.insert_message(&msg("c1", 1)).unwrap());

        // The same id with new content counts as a change (an edit echo).
        let mut edited = msg("c1", 1);
        edited.content = "edited body".into();
        assert!(s.insert_message(&edited).unwrap());
        assert_eq!(s.newest_messages("c1", 10).unwrap()[0].content, "edited body");

        // update_message_content returns the refreshed row only on a real change.
        let again = s.update_message_content("c1", "m1", "edited body").unwrap();
        assert!(again.is_none(), "no-op edit must not report a change");
        let changed = s
            .update_message_content("c1", "m1", "final body")
            .unwrap()
            .expect("a real content change returns the row");
        assert_eq!(changed.content, "final body");
        assert_eq!(changed.seq, 1, "an edit keeps the original seq");

        // An unknown id yields None rather than an error.
        assert!(s.update_message_content("c1", "nope", "x").unwrap().is_none());
    }

    #[test]
    fn deletion_flags_the_row_but_keeps_the_cached_content() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        // A message we saw before it was deleted.
        let mut original = msg("c1", 1);
        original.content = "the original body".into();
        assert!(s.insert_message(&original).unwrap());

        // The deletion arrives as the SAME id with empty content + deleted = true.
        let mut deletion = msg("c1", 1);
        deletion.content = String::new();
        deletion.deleted = true;
        assert!(
            s.insert_message(&deletion).unwrap(),
            "the 0 -> 1 deletion transition counts as a change to broadcast"
        );

        let row = &s.newest_messages("c1", 10).unwrap()[0];
        assert!(row.deleted, "the row is now flagged deleted");
        assert_eq!(
            row.content, "the original body",
            "the cached content survives the deletion so it can be revealed"
        );

        // A repeat deletion frame is a no-op (already deleted, content unchanged).
        assert!(!s.insert_message(&deletion).unwrap());
    }

    // The local half of the user deleting their OWN message: the row is flagged the
    // same way an inbound deletion flags it, so the UI shows one placeholder in both
    // cases — and the cached body still survives for the reveal.
    #[test]
    fn marking_our_own_message_deleted_flags_the_row_and_keeps_the_body() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let mut original = msg("c1", 1);
        original.content = "delete me".into();
        assert!(s.insert_message(&original).unwrap());

        let row = s
            .mark_message_deleted("c1", &original.id)
            .unwrap()
            .expect("a real change returns the row");
        assert!(row.deleted);
        assert_eq!(row.content, "delete me", "the body survives for the reveal");
        assert_eq!(row.seq, 1, "a deletion keeps the original seq");

        // Idempotent: a second call reports no change, so nothing is re-broadcast.
        assert!(s.mark_message_deleted("c1", &original.id).unwrap().is_none());
        // An unknown id yields None rather than an error.
        assert!(s.mark_message_deleted("c1", "nope").unwrap().is_none());
    }

    #[test]
    fn deletion_of_an_unseen_message_is_a_tombstone() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        // A deletion for a message we never stored: a tombstone, nothing to reveal.
        let mut deletion = msg("c1", 1);
        deletion.content = String::new();
        deletion.deleted = true;
        assert!(s.insert_message(&deletion).unwrap());

        let row = &s.newest_messages("c1", 10).unwrap()[0];
        assert!(row.deleted);
        assert_eq!(row.content, "", "no prior content to reveal");
    }

    #[test]
    fn an_empty_update_never_blanks_existing_content() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let mut original = msg("c1", 1);
        original.content = "keep me".into();
        assert!(s.insert_message(&original).unwrap());

        // An update carrying empty content (no deletion flag) must not wipe the
        // stored body — it is treated as "this frame said nothing new".
        let mut blank = msg("c1", 1);
        blank.content = String::new();
        assert!(!s.insert_message(&blank).unwrap());
        assert_eq!(s.newest_messages("c1", 10).unwrap()[0].content, "keep me");
    }

    #[test]
    fn purge_removes_control_frames_only() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let frame = |id: &str, content: &str| Message {
            id: id.into(),
            conversation_id: "c1".into(),
            seq: 1,
            compose_time: 1,
            sender: "x".into(),
            sender_mri: String::new(),
            content: content.into(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        };

        // Real chat messages that must survive — including one that merely mentions
        // a notifications URL inside normal HTML (it does not START with it), and a
        // call-recording card (a URIObject with a real title/link) that mentions a
        // call but is genuine content, NOT a system frame.
        s.insert_message(&frame("real1", "<p>hello world</p>")).unwrap();
        s.insert_message(&frame("real2", "<p>see https://notifications.skype.net/x</p>")).unwrap();
        s.insert_message(&frame("real3", "<URIObject type=\"Video.2/CallRecording.1\"><Title>Daily</Title><SessionEndReason value=\"CallEnded\" /></URIObject>")).unwrap();
        // A call-ended event must NOT be purged — it is upgraded to a system_event
        // by convert_legacy_call_events (see converts_legacy_call_events).
        s.insert_message(&frame("call1", "<ended/><partlist alt=\"\"><part><displayName>Leonor GROELL</displayName><duration>600</duration></part></partlist><callEventType>callEnded</callEventType>")).unwrap();
        // Control/system frames that must be purged.
        s.insert_message(&frame("junk1", "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:bea5de00")).unwrap();
        s.insert_message(&frame("junk2", "<partlist alt=\"\"><part/></partlist>")).unwrap();
        s.insert_message(&frame("junk3", "<addmember><target>8:orgid:x</target></addmember>")).unwrap();
        s.insert_message(&frame("junk4", "<topicupdate><value>New</value></topicupdate>")).unwrap();
        s.insert_message(&frame("junk5", "<meetingpolicyupdated><value>x</value></meetingpolicyupdated>")).unwrap();

        let removed = s.purge_control_frames().unwrap();
        assert_eq!(removed, 5, "only the five control/system frames are deleted");

        let mut left: Vec<_> = s
            .newest_messages("c1", 50)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        left.sort();
        assert_eq!(left, ["call1", "real1", "real2", "real3"], "chat + call events are untouched");

        // Idempotent: a cleaned store deletes nothing on the next pass.
        assert_eq!(s.purge_control_frames().unwrap(), 0);
    }

    /// A row with nothing to render AND nobody to attribute it to is a stored
    /// typing/presence frame — but a payload-less row from a REAL sender is the
    /// still-undiagnosed shape of item 10, and must survive.
    #[test]
    fn purge_removes_payloadless_frames_but_keeps_rows_from_real_senders() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let row = |id: &str, sender: &str| Message {
            id: id.into(),
            conversation_id: "c1".into(),
            seq: 1,
            compose_time: 1,
            sender: sender.into(),
            sender_mri: "8:orgid:bea5de00".into(),
            content: String::new(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(),
            system_event: String::new(),
            thread_root_id: String::new(),
            thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        };

        // Control frames: the raw contacts URL an older build stored as the author,
        // and the same row after `blank_identity_senders` blanked it.
        s.insert_message(&row("junk1", "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:bea5de00")).unwrap();
        s.insert_message(&row("junk2", "")).unwrap();
        // Survivors, each for a different reason.
        s.insert_message(&row("real1", "Matthieu GAUCHER")).unwrap(); // a human author
        let mut with_body = row("real2", "");
        with_body.content = "<p>hello</p>".into();
        s.insert_message(&with_body).unwrap();
        let mut with_file = row("real3", "");
        with_file.attachments = "[{\"kind\":\"file\",\"name\":\"a.pdf\"}]".into();
        s.insert_message(&with_file).unwrap();
        let mut with_event = row("real4", "");
        with_event.system_event = "{\"kind\":\"call\",\"event\":\"ended\"}".into();
        s.insert_message(&with_event).unwrap();
        let mut tombstone = row("real5", "");
        tombstone.deleted = true;
        s.insert_message(&tombstone).unwrap();
        let mut reacted = row("real6", "");
        reacted.reactions = "[{\"key\":\"like\",\"users\":[{\"mri\":\"8:orgid:x\"}]}]".into();
        s.insert_message(&reacted).unwrap();

        assert_eq!(s.purge_payloadless_control_frames().unwrap(), 2);
        let mut left: Vec<_> = s.newest_messages("c1", 50).unwrap().into_iter().map(|m| m.id).collect();
        left.sort();
        assert_eq!(left, ["real1", "real2", "real3", "real4", "real5", "real6"]);
        // Idempotent.
        assert_eq!(s.purge_payloadless_control_frames().unwrap(), 0);
    }

    /// Channel posts filed under a `;messageid=` deep-link id move back into their
    /// channel, duplicates are dropped instead of erroring, and the phantom
    /// conversation rows disappear from the chat list.
    #[test]
    fn reparents_thread_link_messages_into_their_channel() {
        let s = Store::open_in_memory().unwrap();
        let channel = "19:chan@thread.tacv2";
        let link = "19:chan@thread.tacv2;messageid=100";
        s.upsert_channel_full(&chan_upd(channel, "team", "Team", "General", 0)).unwrap();
        s.upsert_conversation(link, "", 500).unwrap();

        // Two posts under the phantom id: one already filed under the channel too
        // (the collision), one only here.
        let post = |conv: &str, id: &str| Message {
            id: id.into(),
            conversation_id: conv.into(),
            seq: id.parse().unwrap(),
            compose_time: id.parse().unwrap(),
            sender: "Alice".into(),
            sender_mri: String::new(),
            content: format!("post {id}"),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(),
            system_event: String::new(),
            thread_root_id: String::new(),
            thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        };
        s.insert_message(&post(channel, "100")).unwrap(); // the root, already correct
        s.insert_message(&post(link, "100")).unwrap(); // ...and its duplicate
        s.insert_message(&post(link, "101")).unwrap(); // only under the phantom id
        // A phantom id with messages but NO conversation row must be healed too.
        let orphan_link = "19:other@thread.tacv2;messageid=200";
        s.insert_message(&post(orphan_link, "201")).unwrap();

        let (moved, dropped, rows) = s.reparent_thread_link_messages().unwrap();
        assert_eq!((moved, dropped, rows), (2, 1, 1));

        let ids: Vec<_> = s.newest_messages(channel, 50).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["100", "101"], "both posts now live under the channel");
        // The moved post takes the deep link's root id; the one already filed keeps
        // whatever it had (empty here — a refetch backfills it, see item 6).
        let moved_post = s.get_message(channel, "101").unwrap().unwrap();
        assert_eq!(moved_post.thread_root_id, "100");
        assert_eq!(moved_post.content, "post 101", "the surviving row keeps its body");
        assert!(s.newest_messages(link, 50).unwrap().is_empty(), "nothing left under the phantom id");
        assert_eq!(s.newest_messages("19:other@thread.tacv2", 50).unwrap().len(), 1);
        assert!(
            !s.conversations("").unwrap().iter().any(|c| c.id == link),
            "the phantom conversation is gone from the chat list"
        );

        // Idempotent: nothing left to re-file.
        assert_eq!(s.reparent_thread_link_messages().unwrap(), (0, 0, 0));
    }

    /// A non-channel deep link (an ordinary chat) keeps a reachable conversation:
    /// the messages merge into the base chat, which inherits the phantom's recency.
    #[test]
    fn reparenting_a_chat_deep_link_keeps_the_chat_reachable() {
        let s = Store::open_in_memory().unwrap();
        let link = "19:grp@thread.v2;messageid=100";
        s.upsert_conversation(link, "", 700).unwrap();
        let mut m = msg(link, 5);
        m.id = "500".into();
        s.insert_message(&m).unwrap();

        let (moved, dropped, rows) = s.reparent_thread_link_messages().unwrap();
        assert_eq!((moved, dropped, rows), (1, 0, 1));

        let convs = s.conversations("").unwrap();
        let base = convs
            .iter()
            .find(|c| c.id == "19:grp@thread.v2")
            .expect("the base chat exists");
        assert_eq!(base.last_message_time, 700, "recency carried over from the phantom row");
        assert_eq!(s.newest_messages("19:grp@thread.v2", 10).unwrap().len(), 1);
    }

    /// A re-fetch must HEAL a legacy row that predates channel threading: 496 stored
    /// channel posts had no `thread_root_id`, and the old conflict clause (content +
    /// deleted only) meant no sync could ever fill it in.
    #[test]
    fn insert_message_backfills_thread_fields_and_attachments_without_clobbering() {
        let s = Store::open_in_memory().unwrap();
        let channel = "19:chan@thread.tacv2";
        // As stored before threading landed: body only.
        let mut legacy = msg(channel, 1);
        legacy.content = "<p>root post</p>".into();
        assert!(s.insert_message(&legacy).unwrap());

        // The same message as a refetch delivers it now.
        let mut refetched = legacy.clone();
        refetched.thread_root_id = "m1".into();
        refetched.thread_subject = "Release notes".into();
        refetched.attachments = "[{\"kind\":\"file\",\"name\":\"notes.pdf\"}]".into();
        assert!(s.insert_message(&refetched).unwrap(), "the heal is a change the UI must render");
        let healed = s.get_message(channel, "m1").unwrap().unwrap();
        assert_eq!(healed.thread_root_id, "m1");
        assert_eq!(healed.thread_subject, "Release notes");
        assert_eq!(healed.attachments, "[{\"kind\":\"file\",\"name\":\"notes.pdf\"}]");

        // A later frame that carries none of it (a plain edit, a reaction echo) must
        // never blank what we now hold.
        let mut sparse = legacy.clone();
        sparse.content = "<p>root post edited</p>".into();
        assert!(s.insert_message(&sparse).unwrap());
        let after_edit = s.get_message(channel, "m1").unwrap().unwrap();
        assert_eq!(after_edit.content, "<p>root post edited</p>");
        assert_eq!(after_edit.thread_root_id, "m1", "thread linkage survives an edit");
        assert_eq!(after_edit.thread_subject, "Release notes");
        assert_eq!(after_edit.attachments, "[{\"kind\":\"file\",\"name\":\"notes.pdf\"}]");
        // ...and a different root id is never overwritten either (first value wins).
        let mut other_root = legacy.clone();
        other_root.thread_root_id = "m999".into();
        s.insert_message(&other_root).unwrap();
        assert_eq!(s.get_message(channel, "m1").unwrap().unwrap().thread_root_id, "m1");

        // Converged: replaying the refetch is now a no-op.
        assert!(!s.insert_message(&refetched).unwrap());
    }

    /// A legacy row whose frame turns out to be a SYSTEM EVENT heals completely on a
    /// refetch: the event lands and the body it was stored with (a localised
    /// "Scheduled a meeting", a raw call frame) goes away, so it ends up identical to
    /// a freshly ingested row instead of a system line with a stale bubble behind it.
    #[test]
    fn insert_message_drops_the_body_of_a_row_that_becomes_a_system_event() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 10).unwrap();
        let mut legacy = msg("c1", 1);
        legacy.content = "Scheduled a meeting".into();
        s.insert_message(&legacy).unwrap();

        let mut refetched = legacy.clone();
        refetched.content = String::new();
        refetched.system_event = "{\"kind\":\"meeting\",\"event\":\"scheduled\"}".into();
        assert!(s.insert_message(&refetched).unwrap());
        let healed = s.get_message("c1", "m1").unwrap().unwrap();
        assert_eq!(healed.system_event, "{\"kind\":\"meeting\",\"event\":\"scheduled\"}");
        assert_eq!(healed.content, "", "the stale body is gone");
        // Converged, and a plain frame afterwards cannot resurrect a body either.
        assert!(!s.insert_message(&refetched).unwrap());

        // A row that already carries an event keeps its content rule (an edit still
        // applies), so this only ever fires on the transition into a system event.
        let mut edited = refetched.clone();
        edited.content = "<p>real text</p>".into();
        assert!(s.insert_message(&edited).unwrap());
        assert_eq!(s.get_message("c1", "m1").unwrap().unwrap().content, "<p>real text</p>");
    }

    /// The sidebar never shows a blank second line for a thread we hold messages
    /// for: a channel container carries no preview at all in the CSA snapshot, and a
    /// chat whose newest frame is a call event previews as nothing.
    #[test]
    fn sidebar_previews_fall_back_to_the_newest_stored_message() {
        let s = Store::open_in_memory().unwrap();
        let channel = "19:chan@thread.tacv2";
        s.upsert_channel_full(&chan_upd(channel, "team", "Team", "General", 10)).unwrap();
        s.upsert_conversation("c1", "Chat", 10).unwrap();
        s.upsert_conversation("c2", "Quiet", 10).unwrap();

        let mut text = msg(channel, 1);
        text.content = "<p>ship it</p>".into();
        s.insert_message(&text).unwrap();
        // Newest in the channel: an image-only body -> a typed label.
        let mut image = msg(channel, 2);
        image.content = "<p><img itemtype=\"http://schema.skype.com/AMSImage\" src=\"https://x/imgo\"></p>".into();
        s.insert_message(&image).unwrap();

        // The chat's newest row is a call event; the one before it is real text.
        let mut chat_text = msg("c1", 1);
        chat_text.content = "<p>see you</p>".into();
        s.insert_message(&chat_text).unwrap();
        let mut call = msg("c1", 2);
        call.content = String::new();
        call.system_event = "{\"kind\":\"call\",\"event\":\"missed\"}".into();
        s.insert_message(&call).unwrap();

        assert_eq!(s.channels().unwrap()[0].last_message_preview, "📷 Image");
        let convs = s.conversations("").unwrap();
        let preview = |id: &str| {
            convs.iter().find(|c| c.id == id).unwrap().last_message_preview.clone()
        };
        assert_eq!(preview("c1"), "Missed call");
        assert_eq!(preview("c2"), "", "a thread with no messages still previews as nothing");

        // A synced preview is authoritative: the fallback only fills a blank one.
        s.upsert_conversation_full(&ConversationUpdate {
            last_message_preview: "from the sync",
            last_message_time: 20,
            ..upd("c1", "Chat", 20, ConversationKind::Group)
        })
        .unwrap();
        let convs = s.conversations("").unwrap();
        assert_eq!(
            convs.iter().find(|c| c.id == "c1").unwrap().last_message_preview,
            "from the sync"
        );
    }

    #[test]
    fn converts_legacy_call_events() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let frame = |id: &str, content: &str| Message {
            id: id.into(),
            conversation_id: "c1".into(),
            seq: 1,
            compose_time: 1,
            sender: "x".into(),
            sender_mri: String::new(),
            content: content.into(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        };

        // A legacy call-ended row stored as raw XML, a legacy meeting-thread JSON
        // call marker (quotes escaped as on the wire), plus a normal chat message.
        s.insert_message(&frame("call1", "<ended/><partlist alt=\"\" count=\"2\"><part><displayName>Alice</displayName><duration>600</duration></part><part><displayName>Bob</displayName><duration>600</duration></part></partlist><callEventType>callEnded</callEventType>")).unwrap();
        s.insert_message(&frame("call2", "{\\\"callId\\\":\\\"c\\\",\\\"meetingOrganizerId\\\":\\\"8:orgid:x\\\"}")).unwrap();
        s.insert_message(&frame("chat1", "<p>hello</p>")).unwrap();

        let converted = s.convert_legacy_call_events().unwrap();
        assert_eq!(converted, 2, "both raw call-event rows are upgraded");

        let msgs = s.newest_messages("c1", 50).unwrap();
        let call = msgs.iter().find(|m| m.id == "call1").unwrap();
        assert_eq!(call.content, "", "raw XML content is cleared once structured");
        assert!(call.system_event.contains("\"event\":\"ended\""), "event captured: {}", call.system_event);
        assert!(call.system_event.contains("\"duration_seconds\":600"), "duration captured: {}", call.system_event);
        assert!(call.system_event.contains("\"participant_count\":2"), "participants captured: {}", call.system_event);

        // The meeting-thread JSON marker is upgraded to a `started` event flagged
        // `meeting`, its raw JSON content cleared.
        let call2 = msgs.iter().find(|m| m.id == "call2").unwrap();
        assert_eq!(call2.content, "", "raw JSON content is cleared once structured");
        assert!(call2.system_event.contains("\"event\":\"started\""), "meeting call captured: {}", call2.system_event);
        assert!(call2.system_event.contains("\"meeting\":true"), "meeting flag captured: {}", call2.system_event);

        // A normal chat message is left completely untouched.
        let chat = msgs.iter().find(|m| m.id == "chat1").unwrap();
        assert_eq!(chat.content, "<p>hello</p>");
        assert_eq!(chat.system_event, "");

        // Idempotent: a converted store upgrades nothing on the next pass.
        assert_eq!(s.convert_legacy_call_events().unwrap(), 0);
    }

    #[test]
    fn converts_legacy_call_recordings() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let frame = |id: &str, content: &str| Message {
            id: id.into(),
            conversation_id: "c1".into(),
            seq: 1,
            compose_time: 1,
            sender: "Meeting".into(),
            sender_mri: String::new(),
            content: content.into(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        };

        // A finished recording (upgraded to a media card), an in-progress notice
        // (deleted as noise), and a real chat message that merely mentions the
        // marker word in text (must be left untouched — it is not a recording).
        s.insert_message(&frame("rec1", "<URIObject type=\"Video.2/CallRecording.1\" url_thumbnail=\"https://x.asyncgw.teams.microsoft.com/t\"><RecordingStatus status=\"Success\" code=\"200\"/><Title>Daily</Title><a href=\"https://t-my.sharepoint.com/:v:/g/x\">Play</a><RecordingContent duration=\"0:05:30\"/></URIObject>")).unwrap();
        s.insert_message(&frame("rec2", "<URIObject type=\"Video.2/CallRecording.1\"><RecordingStatus status=\"Initial\" code=\"0\"/><a href=\"\">Play</a></URIObject>")).unwrap();
        s.insert_message(&frame("chat1", "<p>read the CallRecording docs</p>")).unwrap();

        let (upgraded, deleted) = s.convert_legacy_call_recordings().unwrap();
        assert_eq!((upgraded, deleted), (1, 1), "one recording upgraded, one notice removed");

        let msgs = s.newest_messages("c1", 50).unwrap();
        let ids: std::collections::HashSet<_> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert!(!ids.contains("rec2"), "the in-progress notice is deleted");

        // The finished recording became an empty-body row with a blank sender and a
        // lone `recording` attachment holding the SharePoint link.
        let rec = msgs.iter().find(|m| m.id == "rec1").unwrap();
        assert_eq!(rec.content, "", "raw URIObject content is cleared once structured");
        assert_eq!(rec.sender, "", "the recording's placeholder sender is blanked");
        let atts: serde_json::Value = serde_json::from_str(&rec.attachments).unwrap();
        assert_eq!(atts.as_array().unwrap().len(), 1);
        assert_eq!(atts[0]["kind"], "recording");
        assert_eq!(atts[0]["name"], "Daily");
        assert_eq!(atts[0]["url"], "https://t-my.sharepoint.com/:v:/g/x");
        assert_eq!(atts[0]["duration_seconds"], 330);

        // The real chat message is left completely untouched.
        let chat = msgs.iter().find(|m| m.id == "chat1").unwrap();
        assert_eq!(chat.content, "<p>read the CallRecording docs</p>");
        assert_eq!(chat.sender, "Meeting");

        // Idempotent: an upgraded row no longer holds the marker, so a second pass
        // matches (and changes) nothing.
        assert_eq!(s.convert_legacy_call_recordings().unwrap(), (0, 0));
    }

    #[test]
    fn converts_legacy_thread_activities() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let frame = |id: &str, content: &str| {
            let mut m = msg("c1", 1);
            m.id = id.into();
            m.content = content.into();
            // These rows were stored with the thread's contacts URL as their author.
            m.sender = "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/19:x@thread.v2".into();
            m
        };

        // A member added, a pin, an operation we do not model, and a real message
        // that merely contains the word `eventtime`.
        s.insert_message(&frame(
            "act1",
            "{\"eventtime\":1784726018187,\"initiator\":\"8:orgid:init\",\"members\":[{\"id\":\"8:orgid:added\",\"friendlyname\":\"Théophile WALLEZ\"}]}",
        )).unwrap();
        s.insert_message(&frame(
            "act2",
            "{\"eventtime\":1781884089268,\"userId\":\"8:orgid:pinner\",\"operation\":\"pinned\"}",
        )).unwrap();
        s.insert_message(&frame(
            "act3",
            "{\"eventtime\":1781884089268,\"userId\":\"8:orgid:x\",\"operation\":\"somethingelse\"}",
        )).unwrap();
        s.insert_message(&frame("chat1", "<p>the eventtime field is epoch ms</p>")).unwrap();

        let (upgraded, deleted) = s.convert_legacy_thread_activities().unwrap();
        assert_eq!((upgraded, deleted), (2, 1), "two labelled activities, one unlabelled dropped");

        let msgs = s.newest_messages("c1", 50).unwrap();
        let ids: std::collections::HashSet<_> = msgs.iter().map(|m| m.id.as_str()).collect();
        assert!(!ids.contains("act3"), "an activity we cannot label is removed");

        let added = msgs.iter().find(|m| m.id == "act1").unwrap();
        assert_eq!(added.content, "", "the raw JSON body is cleared once structured");
        assert_eq!(added.sender, "", "the thread-URL author is blanked");
        let event: serde_json::Value = serde_json::from_str(&added.system_event).unwrap();
        assert_eq!(event["kind"], "thread_activity");
        assert_eq!(event["event"], "member_added");
        assert_eq!(event["time_ms"], 1784726018187i64);
        assert_eq!(event["actor_mri"], "8:orgid:init");
        assert_eq!(event["members"], serde_json::json!(["Théophile WALLEZ"]));
        assert_eq!(event["member_mris"], serde_json::json!(["8:orgid:added"]));

        let pinned: serde_json::Value =
            serde_json::from_str(&msgs.iter().find(|m| m.id == "act2").unwrap().system_event).unwrap();
        assert_eq!(pinned["event"], "pinned");
        assert_eq!(pinned["actor_mri"], "8:orgid:pinner");

        // The real message is left completely untouched.
        let chat = msgs.iter().find(|m| m.id == "chat1").unwrap();
        assert_eq!(chat.content, "<p>the eventtime field is epoch ms</p>");
        assert_eq!(chat.system_event, "");

        // Idempotent: converted rows hold no body, so a second pass does nothing.
        assert_eq!(s.convert_legacy_thread_activities().unwrap(), (0, 0));
    }

    #[test]
    fn converts_legacy_cards() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let payload = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            serde_json::json!({
                "summary": "n-Alerts",
                "attachments": [{
                    "contentType": "application/vnd.microsoft.teams.card.o365connector",
                    "content": { "text": "<p>Filebeat error(s)</p>" }
                }]
            })
            .to_string(),
        );
        let card_body = format!(
            "<URIObject type=\"SWIFT.1\">Card - access it on <a href=\"https://go.skype.com/cards.unsupported\">…</a>. <Title>Card</Title><Swift b64=\"{payload}\"/></URIObject>"
        );

        let frame = |id: &str, content: &str| {
            let mut m = msg("c1", 1);
            m.id = id.into();
            m.content = content.into();
            m
        };
        s.insert_message(&frame("card1", &card_body)).unwrap();
        // A card whose payload cannot be decoded keeps its fallback body: an
        // undecodable card is still better than an empty bubble.
        s.insert_message(&frame("card2", "<URIObject type=\"SWIFT.1\"><Title>Card</Title></URIObject>")).unwrap();
        s.insert_message(&frame("chat1", "<p>SWIFT.1 is the card body type</p>")).unwrap();

        assert_eq!(s.convert_legacy_cards().unwrap(), 1);

        let msgs = s.newest_messages("c1", 50).unwrap();
        let card = msgs.iter().find(|m| m.id == "card1").unwrap();
        assert_eq!(card.content, "", "the Skype fallback sentence is cleared");
        let atts: serde_json::Value = serde_json::from_str(&card.attachments).unwrap();
        assert_eq!(atts.as_array().unwrap().len(), 1);
        assert_eq!(atts[0]["kind"], "card");
        assert_eq!(atts[0]["name"], "n-Alerts");
        assert_eq!(atts[0]["card"]["title"], "n-Alerts");
        assert_eq!(atts[0]["card"]["text"], "Filebeat error(s)");

        assert_eq!(
            msgs.iter().find(|m| m.id == "card2").unwrap().content,
            "<URIObject type=\"SWIFT.1\"><Title>Card</Title></URIObject>",
            "an undecodable card keeps its body",
        );
        assert_eq!(
            msgs.iter().find(|m| m.id == "chat1").unwrap().content,
            "<p>SWIFT.1 is the card body type</p>",
            "a message that merely names the type is untouched",
        );

        // Idempotent: an upgraded row no longer holds a URIObject.
        assert_eq!(s.convert_legacy_cards().unwrap(), 0);
    }

    // A store synced before anything recorded an identity still states it: the reader is
    // the one party every one-to-one thread has in common. Measured on the real tenant —
    // 95 threads, one common oid, 4716 messages sent by it.
    #[test]
    fn the_account_is_read_back_out_of_the_one_to_one_thread_ids() {
        let s = Store::open_in_memory().unwrap();
        let me = "2367c029-149d-4ebd-a96c-1fe12bfc24cf";
        for other in ["06dd3880-8f29-4180-ba04-36ac400604cc", "0ec52592-c6d2-4e70-b53a-e8f16308"] {
            s.upsert_conversation(&format!("19:{other}_{me}@unq.gbl.spaces"), "", 1).unwrap();
        }
        // Group chats and channels name nobody, so they must not disturb the answer.
        s.upsert_conversation("19:21d2695ae8ff4e25ace9c662e5c326cb@thread.v2", "Sandbox", 1).unwrap();

        let mut mine = msg("19:x_y@unq.gbl.spaces", 1);
        mine.sender = "Théophile WALLEZ".into();
        mine.sender_mri = format!("8:orgid:{me}");
        s.insert_message(&mine).unwrap();

        let derived = s.derived_self().unwrap().expect("the common party");
        assert_eq!(derived.mri, format!("8:orgid:{me}"));
        assert_eq!(derived.name, "Théophile WALLEZ", "named from their own messages");
    }

    // The cost of a wrong answer is every message attributed to the wrong person, so
    // anything short of proof answers nothing at all.
    #[test]
    fn an_ambiguous_history_names_no_account_at_all() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.derived_self().unwrap().is_none(), "an empty store names nobody");

        // One thread names two people and cannot say which of them is the reader.
        s.upsert_conversation("19:aaa_bbb@unq.gbl.spaces", "", 1).unwrap();
        assert!(s.derived_self().unwrap().is_none(), "one thread proves nothing");

        // Two threads between the same pair have TWO parties in common.
        s.upsert_conversation("19:bbb_aaa@unq.gbl.spaces", "", 1).unwrap();
        assert!(s.derived_self().unwrap().is_none(), "two common parties is not an answer");

        // Two threads sharing exactly one party do prove it.
        s.upsert_conversation("19:aaa_ccc@unq.gbl.spaces", "", 1).unwrap();
        assert_eq!(s.derived_self().unwrap().unwrap().mri, "8:orgid:aaa");
    }

    #[test]
    fn blank_identity_senders_only_touches_identity_authors() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        let authored = |id: &str, sender: &str| {
            let mut m = msg("c1", 1);
            m.id = id.into();
            m.sender = sender.into();
            m
        };
        s.insert_message(&authored("a", "https://fr.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:abc")).unwrap();
        s.insert_message(&authored("b", "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:abc")).unwrap();
        s.insert_message(&authored("c", "8:orgid:abc")).unwrap();
        s.insert_message(&authored("d", "19:x@thread.v2")).unwrap();
        s.insert_message(&authored("e", "Théophile WALLEZ")).unwrap();

        assert_eq!(s.blank_identity_senders().unwrap(), 4);
        let msgs = s.newest_messages("c1", 50).unwrap();
        for id in ["a", "b", "c", "d"] {
            assert_eq!(
                msgs.iter().find(|m| m.id == id).unwrap().sender,
                "",
                "{id}: an identity is not a display name",
            );
        }
        assert_eq!(
            msgs.iter().find(|m| m.id == "e").unwrap().sender,
            "Théophile WALLEZ",
            "a real author is never touched",
        );
        // Idempotent.
        assert_eq!(s.blank_identity_senders().unwrap(), 0);
    }

    #[test]
    fn migration_adds_messagetype_to_existing_store() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (id TEXT PRIMARY KEY);
             INSERT INTO messages (id) VALUES ('m1');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let messagetype: String = conn
            .query_row("SELECT messagetype FROM messages WHERE id = 'm1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(messagetype, "", "a legacy row defaults to an unknown type");
    }

    #[test]
    fn migration_renames_is_favorite_and_keeps_its_values() {
        // A store from before the rename: the column is `is_favorite`, and it holds
        // Teams' Show/Hide answer for each channel.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE channels (id TEXT PRIMARY KEY, is_favorite INTEGER NOT NULL DEFAULT 0);
             INSERT INTO channels (id, is_favorite) VALUES ('shown', 1), ('hidden', 0);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        // The values carry over under the honest name — a rename, not a reset.
        let shown: i64 = conn
            .query_row("SELECT is_shown FROM channels WHERE id = 'shown'", [], |r| r.get(0))
            .unwrap();
        let hidden: i64 = conn
            .query_row("SELECT is_shown FROM channels WHERE id = 'hidden'", [], |r| r.get(0))
            .unwrap();
        assert_eq!((shown, hidden), (1, 0));
        // And the pin arrives empty: nothing is pinned until the next CSA sync.
        let pinned: i64 = conn
            .query_row("SELECT is_pinned FROM channels WHERE id = 'shown'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(pinned, 0);

        // Running the pass again changes nothing (a second open must not fail).
        migrate(&conn).unwrap();
        let still: i64 = conn
            .query_row("SELECT is_shown FROM channels WHERE id = 'shown'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still, 1);
    }

    #[test]
    fn messagetype_roundtrips_and_heals_a_legacy_row() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();

        // A plain-text message: the type is what tells the UI not to parse it as HTML.
        let mut m = msg("c1", 1);
        m.content = "pour moi c'est <yyyy>-<id>".into();
        m.message_type = "Text".into();
        assert!(s.insert_message(&m).unwrap());
        assert_eq!(s.newest_messages("c1", 10).unwrap()[0].message_type, "Text");

        // Re-ingesting the identical frame is still a no-op.
        assert!(!s.insert_message(&m).unwrap(), "an unchanged frame reports no change");

        // A row stored before the column existed (type '') heals on the next sync,
        // and that heal IS a change — the body renders differently once typed.
        let mut legacy = msg("c1", 2);
        legacy.message_type = String::new();
        s.insert_message(&legacy).unwrap();
        let mut typed = legacy.clone();
        typed.message_type = "RichText/Html".into();
        assert!(s.insert_message(&typed).unwrap(), "the backfill is a real change");
        let stored = s.get_message("c1", &typed.id).unwrap().unwrap();
        assert_eq!(stored.message_type, "RichText/Html");
        // Converged: the same frame again changes nothing.
        assert!(!s.insert_message(&typed).unwrap());

        // A frame that carries no type never erases a known one.
        assert!(!s.insert_message(&legacy).unwrap());
        assert_eq!(
            s.get_message("c1", &legacy.id).unwrap().unwrap().message_type,
            "RichText/Html",
        );
    }

    #[test]
    fn cursor_roundtrip() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 0).unwrap();
        assert_eq!(s.oldest_cursor("c1").unwrap(), (None, true));
        s.set_oldest_cursor("c1", Some("cursor-xyz"), false).unwrap();
        assert_eq!(s.oldest_cursor("c1").unwrap(), (Some("cursor-xyz".to_string()), false));
    }

    #[test]
    fn display_name_for_mri_uses_latest_known_sender() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 0).unwrap();
        let with_mri = |seq: i64, name: &str, mri: &str| {
            let mut m = msg("c1", seq);
            m.sender = name.into();
            m.sender_mri = mri.into();
            s.insert_message(&m).unwrap();
        };
        with_mri(1, "Clément DELBARRE", "8:orgid:bea5de00");
        with_mri(2, "Théophile WALLEZ", "8:orgid:2367c029");

        assert_eq!(
            s.display_name_for_mri("8:orgid:bea5de00").unwrap().as_deref(),
            Some("Clément DELBARRE"),
        );
        // Unknown MRI and empty MRI resolve to None (caller falls back gracefully).
        assert_eq!(s.display_name_for_mri("8:orgid:unknown").unwrap(), None);
        assert_eq!(s.display_name_for_mri("").unwrap(), None);
    }

    #[test]
    fn conversations_listed_recent_first() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("a", "Alpha", 100).unwrap();
        s.upsert_conversation("b", "Bravo", 300).unwrap();
        s.upsert_conversation("c", "Charlie", 200).unwrap();
        let convs = s.conversations("").unwrap();
        let names: Vec<_> = convs.iter().map(|c| c.display_name.as_str()).collect();
        assert_eq!(names, ["Bravo", "Charlie", "Alpha"]); // by last_message_time desc
    }

    #[test]
    fn tacv2_thread_never_shows_in_chat_list() {
        // A channel post can land in the conversations table before CSA sync has
        // classified it into the channels table. The chat list must still exclude
        // it on the canonical suffix rule, not just channels-table membership.
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("19:plain@thread.v2", "Group Chat", 100).unwrap();
        s.upsert_conversation("19:leaked@thread.tacv2", "Ops / Standup", 200).unwrap();
        // a channel post / deep link carries a `;messageid=` suffix, so the bare id
        // does not end in @thread.tacv2 — it must still be filtered out.
        s.upsert_conversation("19:post@thread.tacv2;messageid=1784899486984", "Post", 300).unwrap();
        let ids: Vec<_> = s.conversations("").unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["19:plain@thread.v2"]); // both tacv2 forms filtered out
    }

    #[test]
    fn live_event_does_not_clobber_known_title() {
        let s = Store::open_in_memory().unwrap();
        // history sync sets a real title
        s.upsert_conversation("c1", "Team Chat", 100).unwrap();
        // a live trouter event upserts with no title (empty) but a newer time
        s.upsert_conversation("c1", "", 200).unwrap();
        let c = s.conversations("").unwrap();
        assert_eq!(c[0].display_name, "Team Chat"); // title preserved
        assert_eq!(c[0].last_message_time, 200); // time advanced
    }

    #[test]
    fn kind_defaults_unknown_and_is_sticky() {
        let s = Store::open_in_memory().unwrap();
        // a blind upsert (live event / name resolution) never sets kind
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::Unknown);

        // a network sync establishes the real kind
        s.upsert_conversation_full(&upd("c1", "Chat", 150, ConversationKind::OneOnOne))
            .unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::OneOnOne);

        // a later blank/unknown sync must NOT downgrade a known kind
        s.upsert_conversation_full(&upd("c1", "", 200, ConversationKind::Unknown))
            .unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::OneOnOne);

        // but a meaningful kind change is honored
        s.upsert_conversation_full(&upd("c1", "", 250, ConversationKind::Group))
            .unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::Group);
    }

    // Regression: the upsert must report a change ONLY when a column actually
    // moves. If it reported a change on every identical sync, the server would
    // emit `conversations_changed` endlessly and the UI's
    // refresh -> sync -> event -> refresh loop would never settle (the freeze).
    #[test]
    fn upsert_conversation_reports_change_only_on_real_change() {
        let s = Store::open_in_memory().unwrap();
        // first insert is a change
        assert!(s.upsert_conversation("c1", "Chat", 100).unwrap());
        // an identical upsert changes nothing
        assert!(!s.upsert_conversation("c1", "Chat", 100).unwrap());
        // a newer last_message_time is a change
        assert!(s.upsert_conversation("c1", "Chat", 200).unwrap());
        // an older time with an empty title moves nothing
        assert!(!s.upsert_conversation("c1", "", 150).unwrap());
        // same time again: still nothing
        assert!(!s.upsert_conversation("c1", "Chat", 200).unwrap());
        // a new, differing, non-empty name is a change; repeating it is not
        assert!(s.upsert_conversation("c1", "Renamed", 200).unwrap());
        assert!(!s.upsert_conversation("c1", "Renamed", 200).unwrap());
    }

    // Regression: same invariant for the kind-carrying upsert used by the network
    // conversation sync — the origin of the `conversations_changed` storm.
    #[test]
    fn upsert_conversation_full_reports_change_only_on_real_change() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.upsert_conversation_full(&upd("c1", "Chat", 100, ConversationKind::Group)).unwrap());
        // identical sync: no change
        assert!(!s.upsert_conversation_full(&upd("c1", "Chat", 100, ConversationKind::Group)).unwrap());
        // blank title + unknown kind + same time: nothing moves
        assert!(!s.upsert_conversation_full(&upd("c1", "", 100, ConversationKind::Unknown)).unwrap());
        // a meaningful kind change is a change; repeating it is not
        assert!(s.upsert_conversation_full(&upd("c1", "", 100, ConversationKind::OneOnOne)).unwrap());
        assert!(!s.upsert_conversation_full(&upd("c1", "", 100, ConversationKind::OneOnOne)).unwrap());
    }

    #[test]
    fn sidebar_fields_persist_and_read_back() {
        let s = Store::open_in_memory().unwrap();
        let u = ConversationUpdate {
            id: "c1",
            display_name: "Backend",
            last_message_time: 100,
            kind: ConversationKind::Group,
            last_message_preview: "ship it",
            last_message_sender: "Clément",
            last_message_sender_mri: "",
            last_message_from_me: false,
            is_read: false,
            is_muted: true,
            is_pinned: true,
            is_hidden: false,
            thread_type: "chat",
            picture_url: "",
        };
        assert!(s.upsert_conversation_full(&u).unwrap());
        let convs = s.conversations("").unwrap();
        let row = &convs[0];
        assert_eq!(row.last_message_preview, "ship it");
        assert_eq!(row.last_message_sender, "Clément");
        assert!(!row.last_message_from_me);
        assert!(!row.is_read);
        assert!(row.is_muted);
        assert!(row.is_pinned);
        assert!(!row.is_hidden);
        assert_eq!(row.thread_type, "chat");
    }

    #[test]
    fn draft_is_scoped_to_conversation_and_survives_network_sync() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation_full(&upd("c1", "First", 100, ConversationKind::Group)).unwrap();
        s.upsert_conversation_full(&upd("c2", "Second", 100, ConversationKind::Group)).unwrap();

        s.set_draft("c1", "unfinished message").unwrap();
        s.upsert_conversation_full(&upd("c1", "First renamed", 200, ConversationKind::Group)).unwrap();

        let convs = s.conversations("").unwrap();
        let first = convs.iter().find(|c| c.id == "c1").unwrap();
        let second = convs.iter().find(|c| c.id == "c2").unwrap();
        assert_eq!(first.draft, "unfinished message");
        assert_eq!(second.draft, "");

        s.set_draft("c1", "").unwrap();
        assert_eq!(s.conversations("").unwrap().iter().find(|c| c.id == "c1").unwrap().draft, "");
    }

    #[test]
    fn migration_adds_draft_to_existing_store() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY);
             CREATE TABLE messages (id TEXT PRIMARY KEY);
             INSERT INTO conversations (id) VALUES ('c1');",
        ).unwrap();

        migrate(&conn).unwrap();

        let draft: String = conn.query_row(
            "SELECT draft FROM conversations WHERE id = 'c1'",
            [],
            |row| row.get(0),
        ).unwrap();
        assert_eq!(draft, "");
    }

    #[test]
    fn pinned_conversations_sort_above_newer_unpinned() {
        let s = Store::open_in_memory().unwrap();
        // older, but pinned
        let mut pinned = upd("pin", "Pinned", 100, ConversationKind::Group);
        pinned.is_pinned = true;
        s.upsert_conversation_full(&pinned).unwrap();
        // newer, not pinned
        s.upsert_conversation_full(&upd("new", "Newer", 500, ConversationKind::Group)).unwrap();

        let convs = s.conversations("").unwrap();
        assert_eq!(convs[0].id, "pin"); // pinned floats to the top despite the older time
        assert_eq!(convs[1].id, "new");
    }

    // A stale/out-of-order CSA sync (older last_message_time) must not overwrite a
    // fresher preview or flip an unread thread back to read. Only the time is
    // reconciled via MAX and never regresses.
    #[test]
    fn stale_sync_does_not_regress_preview_or_unread() {
        let s = Store::open_in_memory().unwrap();
        let mut fresh = upd("c1", "Chat", 200, ConversationKind::Group);
        fresh.last_message_preview = "newest";
        fresh.is_read = false;
        s.upsert_conversation_full(&fresh).unwrap();

        let mut stale = upd("c1", "Chat", 150, ConversationKind::Group);
        stale.last_message_preview = "older";
        stale.is_read = true;
        s.upsert_conversation_full(&stale).unwrap();

        let convs = s.conversations("").unwrap();
        let row = &convs[0];
        assert_eq!(row.last_message_preview, "newest"); // stale preview rejected
        assert!(!row.is_read); // still unread
        assert_eq!(row.last_message_time, 200); // time never regresses
    }

    #[test]
    fn kind_from_str_falls_back_to_unknown() {
        assert_eq!(ConversationKind::from_str("one_on_one"), ConversationKind::OneOnOne);
        assert_eq!(ConversationKind::from_str("group"), ConversationKind::Group);
        assert_eq!(ConversationKind::from_str("notes"), ConversationKind::Notes);
        assert_eq!(ConversationKind::from_str("something_new"), ConversationKind::Unknown);
        assert_eq!(ConversationKind::from_str(""), ConversationKind::Unknown);
    }

    #[test]
    fn one_to_one_name_derived_from_other_party() {
        let s = Store::open_in_memory().unwrap();
        // a 1:1 conversation has no title
        s.upsert_conversation("dm", "", 500).unwrap();
        // messages from me and from the other person
        let me = "Théophile WALLEZ";
        s.insert_message(&Message {
            id: "m1".into(), conversation_id: "dm".into(), seq: 1, compose_time: 1,
            sender: me.into(), sender_mri: String::new(), content: "salut".into(), attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }).unwrap();
        s.insert_message(&Message {
            id: "m2".into(), conversation_id: "dm".into(), seq: 2, compose_time: 2,
            sender: "Leonor GROELL".into(), sender_mri: String::new(), content: "hello".into(), attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }).unwrap();

        // direct derivation
        assert_eq!(s.other_party_name("dm", me).unwrap(), Some("Leonor GROELL".into()));
        // and the list fills the blank title with the other party's name
        let convs = s.conversations(me).unwrap();
        assert_eq!(convs[0].display_name, "Leonor GROELL");
    }

    #[test]
    fn one_to_one_without_other_message_stays_blank() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("dm", "", 500).unwrap();
        let me = "Moi";
        // only my own message present -> cannot derive the other name yet
        s.insert_message(&Message {
            id: "m1".into(), conversation_id: "dm".into(), seq: 1, compose_time: 1,
            sender: me.into(), sender_mri: String::new(), content: "coucou".into(), attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }).unwrap();
        assert_eq!(s.other_party_name("dm", me).unwrap(), None);
        assert_eq!(s.conversations(me).unwrap()[0].display_name, "");
    }

    #[test]
    fn avatar_mri_is_the_other_party_for_one_on_one_only() {
        let s = Store::open_in_memory().unwrap();
        let me = "Théophile WALLEZ";

        // A 1:1: avatar_mri resolves to the other party's most-recent sender_mri.
        s.upsert_conversation_full(&upd("dm", "", 500, ConversationKind::OneOnOne)).unwrap();
        s.insert_message(&Message {
            id: "m1".into(), conversation_id: "dm".into(), seq: 1, compose_time: 1,
            sender: me.into(), sender_mri: "8:orgid:me".into(), content: "salut".into(),
            attachments: "[]".into(), reactions: "[]".into(), message_type: String::new(), system_event: String::new(), thread_root_id: String::new(), thread_subject: String::new(), deleted: false, mentions: "[]".into(),        }).unwrap();
        s.insert_message(&Message {
            id: "m2".into(), conversation_id: "dm".into(), seq: 2, compose_time: 2,
            sender: "Leonor GROELL".into(), sender_mri: "8:orgid:leonor".into(), content: "hello".into(),
            attachments: "[]".into(), reactions: "[]".into(), message_type: String::new(), system_event: String::new(), thread_root_id: String::new(), thread_subject: String::new(), deleted: false, mentions: "[]".into(),        }).unwrap();

        // A group: even though it has non-self senders, a group has no single face.
        s.upsert_conversation_full(&upd("grp", "Team chat", 400, ConversationKind::Group)).unwrap();
        s.insert_message(&Message {
            id: "g1".into(), conversation_id: "grp".into(), seq: 1, compose_time: 1,
            sender: "Grace HOPPER".into(), sender_mri: "8:orgid:grace".into(), content: "hi all".into(),
            attachments: "[]".into(), reactions: "[]".into(), message_type: String::new(), system_event: String::new(), thread_root_id: String::new(), thread_subject: String::new(), deleted: false, mentions: "[]".into(),        }).unwrap();

        let by_id = |id: &str| {
            s.conversations(me).unwrap().into_iter().find(|c| c.id == id).unwrap()
        };
        assert_eq!(by_id("dm").avatar_mri, "8:orgid:leonor");
        assert_eq!(by_id("grp").avatar_mri, "", "a group has no single-person avatar");
    }

    /// Insert a message from one person, so a nickname has something to override.
    fn msg_from(conv: &str, seq: i64, sender: &str, mri: &str) -> Message {
        let mut m = msg(conv, seq);
        m.sender = sender.into();
        m.sender_mri = mri.into();
        m
    }

    #[test]
    fn a_nickname_renames_the_person_on_every_message_they_ever_sent() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation_full(&upd("grp", "Team chat", 500, ConversationKind::Group)).unwrap();
        s.insert_message(&msg_from("grp", 1, "Robert SMITH", "8:orgid:rob")).unwrap();
        s.insert_message(&msg_from("grp", 2, "Grace HOPPER", "8:orgid:grace")).unwrap();
        // A second message from the same person, so this pins that the rename is not a
        // one-row update: `insert_message` freezes `sender` at first insert, so every
        // stored message has to be renamed on the way OUT or none of them is.
        s.insert_message(&msg_from("grp", 3, "Robert SMITH", "8:orgid:rob")).unwrap();

        s.set_person_name("8:orgid:rob", Some("Bob"), 1_000).unwrap();

        let senders: Vec<String> =
            s.newest_messages("grp", 50).unwrap().into_iter().map(|m| m.sender).collect();
        assert_eq!(senders, vec!["Bob", "Grace HOPPER", "Bob"]);
        // The identity never moves — it is what the override is keyed on.
        assert!(s.newest_messages("grp", 50).unwrap().iter().all(|m| !m.sender_mri.is_empty()));

        // And the same name comes back from the lookups the typing line, the read
        // receipts and the @mention list use.
        assert_eq!(s.display_name_for_mri("8:orgid:rob").unwrap().as_deref(), Some("Bob"));
        assert_eq!(
            s.thread_senders("grp", 10).unwrap(),
            vec![
                ("8:orgid:rob".to_string(), "Bob".to_string()),
                ("8:orgid:grace".to_string(), "Grace HOPPER".to_string()),
            ]
        );
        // Teams' own name stays readable, so the UI can always say who this really is.
        assert_eq!(
            s.teams_display_name_for_mri("8:orgid:rob").unwrap().as_deref(),
            Some("Robert SMITH")
        );
    }

    #[test]
    fn a_nickname_titles_a_one_to_one_but_never_a_group() {
        let s = Store::open_in_memory().unwrap();
        let me = "Théophile WALLEZ";

        // A 1:1 whose title Teams DID supply — the nickname still wins, or renaming
        // somebody would work on their messages and not on their chat.
        s.upsert_conversation_full(&upd("dm", "Robert SMITH", 500, ConversationKind::OneOnOne))
            .unwrap();
        s.insert_message(&msg_from("dm", 1, me, "8:orgid:me")).unwrap();
        s.insert_message(&msg_from("dm", 2, "Robert SMITH", "8:orgid:rob")).unwrap();

        // A group Robert also writes in. Its title is the group's, not his.
        s.upsert_conversation_full(&upd("grp", "Team chat", 400, ConversationKind::Group)).unwrap();
        s.insert_message(&msg_from("grp", 1, "Robert SMITH", "8:orgid:rob")).unwrap();

        let title = |id: &str| {
            s.conversations(me).unwrap().into_iter().find(|c| c.id == id).unwrap().display_name
        };
        assert_eq!(title("dm"), "Robert SMITH");

        s.set_person_name("8:orgid:rob", Some("Bob"), 1_000).unwrap();
        assert_eq!(title("dm"), "Bob");
        assert_eq!(title("grp"), "Team chat", "renaming a member must not retitle a group");

        // Clearing it puts Teams' own title back.
        s.set_person_name("8:orgid:rob", None, 2_000).unwrap();
        assert_eq!(title("dm"), "Robert SMITH");
        assert_eq!(s.person_override("8:orgid:rob").unwrap(), None, "the row is gone");
    }

    #[test]
    fn a_nickname_follows_the_sidebar_preview_attribution() {
        let s = Store::open_in_memory().unwrap();
        let me = "Théophile WALLEZ";
        let mut u = upd("grp", "Team chat", 500, ConversationKind::Group);
        u.last_message_preview = "ship it";
        u.last_message_sender = "Robert SMITH";
        u.last_message_sender_mri = "8:orgid:rob";
        s.upsert_conversation_full(&u).unwrap();

        let sender = || {
            s.conversations(me).unwrap().into_iter().find(|c| c.id == "grp").unwrap().last_message_sender
        };
        assert_eq!(sender(), "Robert SMITH");
        s.set_person_name("8:orgid:rob", Some("Bob"), 1_000).unwrap();
        assert_eq!(sender(), "Bob");

        // The same for a channel row.
        let mut c = chan_upd("19:general@thread.tacv2", "19:t@thread.tacv2", "Eng", "General", 600);
        c.last_message_preview = "ship it";
        c.last_message_sender = "Robert SMITH";
        c.last_message_sender_mri = "8:orgid:rob";
        s.upsert_channel_full(&c).unwrap();
        assert_eq!(s.channels().unwrap()[0].last_message_sender, "Bob");
    }

    #[test]
    fn the_two_halves_of_an_override_are_independent() {
        let s = Store::open_in_memory().unwrap();
        let mri = "8:orgid:rob";
        let png: &[u8] = &[0x89, b'P', b'N', b'G'];

        s.set_person_name(mri, Some("Bob"), 100).unwrap();
        s.set_person_avatar(mri, Some(("image/png", png)), 200).unwrap();
        let o = s.person_override(mri).unwrap().unwrap();
        assert_eq!(o.display_name, "Bob");
        assert_eq!(o.avatar_bytes, png);
        assert_eq!(o.avatar_content_type, "image/png");

        // Undoing the rename keeps the face.
        s.set_person_name(mri, None, 300).unwrap();
        let o = s.person_override(mri).unwrap().unwrap();
        assert_eq!(o.display_name, "");
        assert_eq!(o.avatar_bytes, png, "clearing a name must not drop the picture");

        // Only when the last half goes does the row go, so "no override" is always
        // the absence of a row.
        s.set_person_avatar(mri, None, 400).unwrap();
        assert_eq!(s.person_override(mri).unwrap(), None);

        // A name is trimmed, and a blank one is a clear rather than an empty name.
        s.set_person_name(mri, Some("  Bob  "), 500).unwrap();
        assert_eq!(s.person_override(mri).unwrap().unwrap().display_name, "Bob");
        s.set_person_name(mri, Some("   "), 600).unwrap();
        assert_eq!(s.person_override(mri).unwrap(), None);
    }

    #[test]
    fn overrides_list_without_their_bytes_newest_first() {
        let s = Store::open_in_memory().unwrap();
        s.set_person_name("8:orgid:rob", Some("Bob"), 100).unwrap();
        s.set_person_avatar("8:orgid:grace", Some(("image/png", &[1, 2, 3])), 200).unwrap();

        let list = s.person_overrides().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].mri, "8:orgid:grace", "newest change first");
        assert!(list[0].has_avatar);
        assert_eq!(list[0].display_name, "");
        assert_eq!(list[1].mri, "8:orgid:rob");
        assert!(!list[1].has_avatar);
        assert_eq!(list[1].display_name, "Bob");
    }

    #[test]
    fn an_override_needs_an_mri_and_never_matches_a_legacy_row() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.set_person_name("", Some("Bob"), 100).is_err());
        assert!(s.set_person_avatar("", Some(("image/png", &[1])), 100).is_err());

        // A message stored before `sender_mri` existed has an empty MRI. Nothing may
        // ever rename it: an override row with an empty key would rewrite the author
        // of every such message at once.
        s.upsert_conversation_full(&upd("grp", "Team chat", 500, ConversationKind::Group)).unwrap();
        s.insert_message(&msg_from("grp", 1, "Legacy AUTHOR", "")).unwrap();
        s.set_person_name("8:orgid:rob", Some("Bob"), 100).unwrap();
        assert_eq!(s.newest_messages("grp", 10).unwrap()[0].sender, "Legacy AUTHOR");
        assert_eq!(s.display_name_for_mri("").unwrap(), None);
    }

    #[test]
    fn a_nickname_answers_for_somebody_who_never_wrote_here() {
        let s = Store::open_in_memory().unwrap();
        // Nothing stored from this person at all — a colleague who only ever typed.
        assert_eq!(s.display_name_for_mri("8:orgid:rob").unwrap(), None);
        s.set_person_name("8:orgid:rob", Some("Bob"), 100).unwrap();
        assert_eq!(s.display_name_for_mri("8:orgid:rob").unwrap().as_deref(), Some("Bob"));
        assert_eq!(s.teams_display_name_for_mri("8:orgid:rob").unwrap(), None);
    }

    #[test]
    fn migration_adds_the_person_overrides_table_to_an_existing_store() {
        let path = temp_db("person_overrides_migration");
        {
            // A store from before the table and the column existed.
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversations (id TEXT PRIMARY KEY, display_name TEXT,
                     last_message_time INTEGER NOT NULL DEFAULT 0,
                     last_message_sender TEXT NOT NULL DEFAULT '');
                 CREATE TABLE messages (id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                     seq INTEGER NOT NULL DEFAULT 0, compose_time INTEGER NOT NULL DEFAULT 0,
                     sender TEXT, content TEXT, PRIMARY KEY (conversation_id, id));",
            )
            .unwrap();
        }
        let s = Store::open(path.to_str().unwrap()).unwrap();
        // The table is there and usable, and so is the preview's MRI column.
        s.set_person_name("8:orgid:rob", Some("Bob"), 100).unwrap();
        assert_eq!(s.person_override("8:orgid:rob").unwrap().unwrap().display_name, "Bob");
        assert!(s.conversations("me").is_ok());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn group_picture_round_trips_and_a_removed_one_is_cleared() {
        let s = Store::open_in_memory().unwrap();
        let picture = "https://fr-prod.asyncgw.teams.microsoft.com/v1/objects/0-frs-d4-abc/views/avatar_fullsize";
        let with_picture = |url: &'static str| ConversationUpdate {
            picture_url: url,
            ..upd("grp", "Saturn Core", 100, ConversationKind::Group)
        };

        assert!(s.upsert_conversation_full(&with_picture(picture)).unwrap());
        assert_eq!(s.conversations("").unwrap()[0].picture_url, picture);
        // Re-syncing the same picture is NOT a change (else the UI's
        // refresh->sync->conversations_changed->refresh loop spins).
        assert!(!s.upsert_conversation_full(&with_picture(picture)).unwrap());

        // The members remove the picture: CSA drops the field, and the row must
        // clear rather than keep serving a picture the chat no longer has.
        assert!(s.upsert_conversation_full(&with_picture("")).unwrap());
        assert_eq!(s.conversations("").unwrap()[0].picture_url, "");
    }

    #[test]
    fn backfill_sender_mri_heals_legacy_rows_only() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        // legacy row: no MRI captured
        s.insert_message(&Message {
            id: "m1".into(), conversation_id: "c1".into(), seq: 1, compose_time: 1,
            sender: "Me".into(), sender_mri: String::new(), content: "hi".into(), attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }).unwrap();

        // backfill fills the empty MRI
        s.backfill_sender_mri("c1", "m1", "8:orgid:me").unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].sender_mri, "8:orgid:me");

        // it never overwrites an already-set MRI
        s.backfill_sender_mri("c1", "m1", "8:orgid:someone-else").unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].sender_mri, "8:orgid:me");

        // empty incoming MRI is a no-op
        s.backfill_sender_mri("c1", "m1", "").unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].sender_mri, "8:orgid:me");
    }

    #[test]
    fn attachments_roundtrip_and_default_empty_array() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        // a message carrying a file attachment
        s.insert_message(&Message {
            id: "m1".into(), conversation_id: "c1".into(), seq: 1, compose_time: 1,
            sender: "Me".into(), sender_mri: String::new(), content: "see file".into(),
            attachments: r#"[{"name":"report.pdf","content_type":"application/pdf","url":"https://x.skype.com/o/1","kind":"file"}]"#.into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }).unwrap();
        // a message without attachments keeps the empty-array default
        s.insert_message(&Message {
            id: "m2".into(), conversation_id: "c1".into(), seq: 2, compose_time: 2,
            sender: "Me".into(), sender_mri: String::new(), content: "hi".into(),
            attachments: "[]".into(),
            reactions: "[]".into(),
            message_type: String::new(), system_event: String::new(),
            thread_root_id: String::new(), thread_subject: String::new(),
            deleted: false,
            mentions: "[]".into(),
        }).unwrap();

        let msgs = s.newest_messages("c1", 10).unwrap();
        assert!(msgs[0].attachments.contains("report.pdf"));
        assert_eq!(msgs[1].attachments, "[]");
    }

    #[test]
    fn migration_backfills_attachments_default_on_legacy_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY);
             CREATE TABLE messages (
                id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                PRIMARY KEY (conversation_id, id));
             INSERT INTO messages (id, conversation_id) VALUES ('m1', 'c1');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let attachments: String = conn
            .query_row("SELECT attachments FROM messages WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(attachments, "[]");
    }

    #[test]
    fn reactions_roundtrip_on_insert() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let mut m = msg("c1", 1);
        m.reactions = r#"[{"key":"like","users":[{"mri":"8:a","time":1}]}]"#.into();
        s.insert_message(&m).unwrap();
        assert!(s.newest_messages("c1", 1).unwrap()[0].reactions.contains("like"));
    }

    #[test]
    fn mentions_roundtrip_and_follow_an_edited_body() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let leonor = r#"[{"itemid":0,"mri":"8:orgid:leonor","kind":"person","display_name":"Leonor"}]"#;
        let mut m = msg("c1", 1);
        m.content = "<p>hi @Leonor</p>".into();
        m.mentions = leonor.into();
        s.insert_message(&m).unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].mentions, leonor);

        // An edit rewrites the body AND who it mentions (they are addressed by
        // position in that body, so they must never drift apart).
        let ada = r#"[{"itemid":0,"mri":"8:orgid:ada","kind":"person","display_name":"Ada"}]"#;
        let mut edited = m.clone();
        edited.content = "<p>hi @Ada</p>".into();
        edited.mentions = ada.into();
        assert!(s.insert_message(&edited).unwrap());
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].mentions, ada);

        // A frame with no body (a deletion, a reaction-only update) leaves them be.
        let mut bodiless = m.clone();
        bodiless.content = String::new();
        bodiless.mentions = "[]".into();
        s.insert_message(&bodiless).unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].mentions, ada);
    }

    #[test]
    fn backfill_mentions_heals_rows_without_any() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        s.insert_message(&msg("c1", 1)).unwrap(); // legacy row: no mentions
        let list = r#"[{"itemid":0,"mri":"8:orgid:leonor","kind":"person","display_name":"Leonor"}]"#;

        s.backfill_mentions("c1", "m1", list).unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].mentions, list);

        // Never overwrites a row that already lists mentions, and an empty
        // incoming list is a no-op.
        s.backfill_mentions("c1", "m1", r#"[{"itemid":9,"mri":"8:orgid:x"}]"#).unwrap();
        s.backfill_mentions("c1", "m1", "[]").unwrap();
        s.backfill_mentions("c1", "m1", "").unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].mentions, list);
    }

    #[test]
    fn migration_backfills_mentions_default_on_legacy_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (
                id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                PRIMARY KEY (conversation_id, id));
             INSERT INTO messages (id, conversation_id) VALUES ('m1', 'c1');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let mentions: String = conn
            .query_row("SELECT mentions FROM messages WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mentions, "[]");
    }

    #[test]
    fn insert_coerces_empty_reactions_sentinel_to_array() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let mut m = msg("c1", 1);
        m.reactions = String::new(); // sentinel: this frame carried no emotions info
        s.insert_message(&m).unwrap();
        assert_eq!(s.newest_messages("c1", 1).unwrap()[0].reactions, "[]");
    }

    #[test]
    fn update_message_reactions_reports_change_only_when_changed() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        s.insert_message(&msg("c1", 1)).unwrap();

        let set = r#"[{"key":"heart","users":[{"mri":"8:a","time":1}]}]"#;
        let row = s.update_message_reactions("c1", "m1", set).unwrap().expect("a real change returns the row");
        assert!(row.reactions.contains("heart"));
        // idempotent: the same snapshot reports no change
        assert!(s.update_message_reactions("c1", "m1", set).unwrap().is_none());
        // an unknown id yields None rather than an error
        assert!(s.update_message_reactions("c1", "nope", set).unwrap().is_none());
        // clearing back to [] is itself a change
        assert!(s.update_message_reactions("c1", "m1", "[]").unwrap().is_some());
    }

    #[test]
    fn set_my_reaction_toggles_replaces_and_removes() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        s.insert_message(&msg("c1", 1)).unwrap();
        let me = "8:orgid:me";

        // add "like"
        let row = s.set_my_reaction("c1", "m1", me, Some("like"), 10).unwrap().expect("added");
        assert_eq!(my_reaction_key(&row.reactions, me).as_deref(), Some("like"));

        // replace with "heart" — one reaction per user, so "like" is gone
        let row = s.set_my_reaction("c1", "m1", me, Some("heart"), 20).unwrap().expect("replaced");
        assert_eq!(my_reaction_key(&row.reactions, me).as_deref(), Some("heart"));
        assert!(!row.reactions.contains("like"), "the emptied 'like' key is dropped");

        // remove
        let row = s.set_my_reaction("c1", "m1", me, None, 0).unwrap().expect("removed");
        assert_eq!(row.reactions, "[]");
        assert!(my_reaction_key(&row.reactions, me).is_none());
    }

    #[test]
    fn set_my_reaction_never_touches_other_users() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let mut m = msg("c1", 1);
        m.reactions = r#"[{"key":"like","users":[{"mri":"8:other","time":1}]}]"#.into();
        s.insert_message(&m).unwrap();
        let me = "8:orgid:me";

        // I also like it: both users sit under "like"
        let row = s.set_my_reaction("c1", "m1", me, Some("like"), 5).unwrap().expect("added");
        let parsed: serde_json::Value = serde_json::from_str(&row.reactions).unwrap();
        assert_eq!(parsed[0]["users"].as_array().unwrap().len(), 2);

        // removing mine leaves the other person's like intact
        let row = s.set_my_reaction("c1", "m1", me, None, 0).unwrap().expect("removed");
        assert_eq!(my_reaction_key(&row.reactions, "8:other").as_deref(), Some("like"));
        assert!(my_reaction_key(&row.reactions, me).is_none());
    }

    #[test]
    fn canonical_mri_normalizes_url_and_prefix() {
        assert_eq!(canonical_mri("8:orgid:guid"), "orgid:guid");
        assert_eq!(canonical_mri("orgid:guid"), "orgid:guid");
        assert_eq!(
            canonical_mri("https://x/v1/users/ME/contacts/8:orgid:guid"),
            "orgid:guid",
        );
        // same user across all three forms
        assert!(same_user("8:orgid:guid", "orgid:guid"));
        assert!(same_user("https://x/contacts/8:orgid:guid", "8:orgid:guid"));
        // empties never match (an unknown self identity can't claim a reaction)
        assert!(!same_user("", "8:orgid:guid"));
        assert!(!same_user("8:orgid:guid", ""));
        assert!(!same_user("8:orgid:a", "8:orgid:b"));
    }

    #[test]
    fn my_reaction_key_matches_across_mri_forms() {
        // Our reaction was stored with a bare (no "8:") MRI, but self identity is
        // the "8:orgid:..." form: canonical matching must still find it as ours.
        let reactions = r#"[{"key":"like","users":[{"mri":"orgid:me","time":1}]}]"#;
        assert_eq!(my_reaction_key(reactions, "8:orgid:me").as_deref(), Some("like"));
    }

    #[test]
    fn set_my_reaction_dedupes_across_mri_forms() {
        // Regression: a message already reacted in real Teams stored our MRI in a
        // different form than self identity. Re-picking the same emoji must TOGGLE
        // it off (recognize it as ours), never list us twice or re-add.
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        let mut m = msg("c1", 1);
        m.reactions = r#"[{"key":"like","users":[{"mri":"orgid:me","time":1}]}]"#.into();
        s.insert_message(&m).unwrap();
        let me = "8:orgid:me";

        // It is recognized as ours despite the differing MRI form.
        assert_eq!(my_reaction_key(&m.reactions, me).as_deref(), Some("like"));

        // Adding "like" again canonically removes the old entry first, so we are
        // listed exactly once (no double-count), not twice.
        let row = s.set_my_reaction("c1", "m1", me, Some("like"), 9).unwrap().expect("changed");
        let parsed: serde_json::Value = serde_json::from_str(&row.reactions).unwrap();
        assert_eq!(parsed[0]["users"].as_array().unwrap().len(), 1);

        // And removing it clears the key entirely.
        let row = s.set_my_reaction("c1", "m1", me, None, 0).unwrap().expect("removed");
        assert_eq!(row.reactions, "[]");
    }

    #[test]
    fn migration_backfills_reactions_default_on_legacy_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE conversations (id TEXT PRIMARY KEY);
             CREATE TABLE messages (
                id TEXT NOT NULL, conversation_id TEXT NOT NULL,
                PRIMARY KEY (conversation_id, id));
             INSERT INTO messages (id, conversation_id) VALUES ('m1', 'c1');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let reactions: String = conn
            .query_row("SELECT reactions FROM messages WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(reactions, "[]");
    }

    // ---- channels -----------------------------------------------------------

    #[test]
    fn channel_upsert_counts_only_real_changes() {
        let s = Store::open_in_memory().unwrap();
        let u = chan_upd("19:c@thread.tacv2", "19:t@thread.tacv2", "Ops", "Standup", 100);

        assert!(s.upsert_channel_full(&u).unwrap(), "first insert is a change");
        assert!(!s.upsert_channel_full(&u).unwrap(), "identical re-sync is a no-op");

        // A newer last_message_time is a real change.
        let bumped = ChannelUpdate { last_message_time: 200, ..u.clone() };
        assert!(s.upsert_channel_full(&bumped).unwrap());
        assert!(!s.upsert_channel_full(&bumped).unwrap());

        // An older snapshot never regresses the row (no change reported).
        assert!(!s.upsert_channel_full(&u).unwrap());
        assert_eq!(s.channels().unwrap()[0].last_message_time, 200);
    }

    #[test]
    fn channels_are_grouped_general_first_then_by_name() {
        let s = Store::open_in_memory().unwrap();
        // Team B, then Team A (inserted out of order); within A, General + two named.
        s.upsert_channel_full(&chan_upd("19:b1@thread.tacv2", "19:tb@thread.tacv2", "Beta", "Random", 10)).unwrap();
        s.upsert_channel_full(&ChannelUpdate {
            is_general: true,
            ..chan_upd("19:ag@thread.tacv2", "19:ta@thread.tacv2", "Alpha", "General", 5)
        }).unwrap();
        s.upsert_channel_full(&chan_upd("19:az@thread.tacv2", "19:ta@thread.tacv2", "Alpha", "Zeta", 20)).unwrap();
        s.upsert_channel_full(&chan_upd("19:am@thread.tacv2", "19:ta@thread.tacv2", "Alpha", "Meta", 30)).unwrap();

        let rows = s.channels().unwrap();
        let order: Vec<&str> = rows.iter().map(|c| c.display_name.as_str()).collect();
        // Alpha's channels first (team_name asc), General before the alphabetical
        // Meta/Zeta; Beta's channel last. Sort is grouping-based, NOT time-based.
        assert_eq!(order, ["General", "Meta", "Zeta", "Random"]);
        assert!(rows[0].is_general);
    }

    #[test]
    fn channels_follow_csa_team_and_channel_order() {
        let s = Store::open_in_memory().unwrap();
        // "Zeta Team" is FIRST in Microsoft Teams (team_pos 0) even though it sorts
        // last alphabetically; "Alpha Team" is second (team_pos 1). Inside Zeta the
        // user's channel order is Deploy(1) then Build(2); General is pinned first
        // regardless of its stored channel_pos. This proves the CSA position wins
        // over the alphabetical tie-breakers.
        s.upsert_channel_full(&ChannelUpdate {
            team_pos: 0,
            channel_pos: 2,
            ..chan_upd("19:zb@thread.tacv2", "19:tz@thread.tacv2", "Zeta Team", "Build", 10)
        })
        .unwrap();
        s.upsert_channel_full(&ChannelUpdate {
            team_pos: 0,
            channel_pos: 1,
            ..chan_upd("19:zd@thread.tacv2", "19:tz@thread.tacv2", "Zeta Team", "Deploy", 10)
        })
        .unwrap();
        s.upsert_channel_full(&ChannelUpdate {
            is_general: true,
            team_pos: 0,
            channel_pos: 5,
            ..chan_upd("19:zg@thread.tacv2", "19:tz@thread.tacv2", "Zeta Team", "General", 10)
        })
        .unwrap();
        s.upsert_channel_full(&ChannelUpdate {
            team_pos: 1,
            channel_pos: 0,
            ..chan_upd("19:ar@thread.tacv2", "19:ta@thread.tacv2", "Alpha Team", "Random", 10)
        })
        .unwrap();

        let rows = s.channels().unwrap();
        let order: Vec<&str> = rows.iter().map(|c| c.display_name.as_str()).collect();
        assert_eq!(order, ["General", "Deploy", "Build", "Random"]);
        let teams: Vec<&str> = rows.iter().map(|c| c.team_name.as_str()).collect();
        assert_eq!(teams, ["Zeta Team", "Zeta Team", "Zeta Team", "Alpha Team"]);
    }

    #[test]
    fn channel_reorder_is_a_real_change() {
        // A pure position change (team/channel moved in Teams) must be reported so
        // the UI re-renders the tree, and must converge to a no-op on re-sync.
        let s = Store::open_in_memory().unwrap();
        let base = chan_upd("19:c@thread.tacv2", "19:t@thread.tacv2", "Ops", "Standup", 100);
        assert!(s.upsert_channel_full(&base).unwrap());
        let moved = ChannelUpdate { team_pos: 3, channel_pos: 2, ..base.clone() };
        assert!(s.upsert_channel_full(&moved).unwrap(), "a reorder is a real change");
        assert!(!s.upsert_channel_full(&moved).unwrap(), "re-sync of the same order is a no-op");
    }

    #[test]
    fn touch_channel_bumps_time_and_unread() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_channel_full(&chan_upd("19:c@thread.tacv2", "19:t@thread.tacv2", "Ops", "Standup", 100)).unwrap();

        // An incoming post from someone else bumps the time and marks it unread.
        assert!(s.touch_channel("19:c@thread.tacv2", 200, false).unwrap());
        let row = &s.channels().unwrap()[0];
        assert_eq!(row.last_message_time, 200);
        assert!(!row.is_read);
        assert!(!row.last_message_from_me);

        // An older time with the channel already unread is a no-op.
        assert!(!s.touch_channel("19:c@thread.tacv2", 150, false).unwrap());

        // Our own post keeps it read and never regresses the time.
        assert!(s.touch_channel("19:c@thread.tacv2", 300, true).unwrap());
        let row = &s.channels().unwrap()[0];
        assert_eq!(row.last_message_time, 300);
        assert!(row.last_message_from_me);

        // Unknown channel id is a no-op, never an error.
        assert!(!s.touch_channel("19:missing@thread.tacv2", 999, false).unwrap());
    }

    // Opening an unread thread clears the marker here even though Teams still reports
    // it unread — the whole point of the local read position. The next message makes it
    // unread again, because the position is a high-water mark.
    #[test]
    fn marking_a_conversation_read_clears_the_marker_until_the_next_message() {
        let s = Store::open_in_memory().unwrap();
        let mut u = upd("19:chat@thread.v2", "Chat", 100, ConversationKind::Group);
        u.is_read = false;
        s.upsert_conversation_full(&u).unwrap();
        assert!(!s.conversations("me").unwrap()[0].is_read);

        assert!(s.mark_thread_read("19:chat@thread.v2", false).unwrap());
        let row = &s.conversations("me").unwrap()[0];
        assert!(row.is_read);
        assert!(!row.is_ghost_read, "Teams was told, so this is a normal read");

        // Re-marking the same position changes nothing (no `conversations_changed`).
        assert!(!s.mark_thread_read("19:chat@thread.v2", false).unwrap());

        // A newer message arrives, still unread on Teams' side -> unread again.
        u.last_message_time = 200;
        s.upsert_conversation_full(&u).unwrap();
        assert!(!s.conversations("me").unwrap()[0].is_read);

        // Unknown thread id is a no-op, never an error.
        assert!(!s.mark_thread_read("19:missing@thread.v2", false).unwrap());
    }

    // Ghost mode: read here, never declared to Teams. The CSA sync keeps reporting the
    // thread unread, so the local position is the only thing holding the marker down —
    // and `is_ghost_read` is what the UI badges to say so.
    #[test]
    fn a_ghost_read_survives_a_sync_that_still_reports_unread() {
        let s = Store::open_in_memory().unwrap();
        let mut u = upd("19:chat@thread.v2", "Chat", 100, ConversationKind::Group);
        u.is_read = false;
        s.upsert_conversation_full(&u).unwrap();

        assert!(s.mark_thread_read("19:chat@thread.v2", true).unwrap());
        let row = &s.conversations("me").unwrap()[0];
        assert!(row.is_read);
        assert!(row.is_ghost_read);

        // Teams re-asserts "unread" on every sync; the local position outlives it.
        s.upsert_conversation_full(&u).unwrap();
        let row = &s.conversations("me").unwrap()[0];
        assert!(row.is_read);
        assert!(row.is_ghost_read);

        // Teams itself reporting the thread read retires the ghost badge.
        u.is_read = true;
        s.upsert_conversation_full(&u).unwrap();
        let row = &s.conversations("me").unwrap()[0];
        assert!(row.is_read);
        assert!(!row.is_ghost_read);
    }

    // The same rule on a channel, and the ghost flag flipping in place: a thread read in
    // Ghost mode and then re-read with Ghost off must lose the badge.
    #[test]
    fn marking_a_channel_read_carries_the_ghost_flag_both_ways() {
        let s = Store::open_in_memory().unwrap();
        let mut u = chan_upd("19:c@thread.tacv2", "19:t@thread.tacv2", "Ops", "Standup", 100);
        u.is_read = false;
        s.upsert_channel_full(&u).unwrap();
        assert!(!s.channels().unwrap()[0].is_read);

        assert!(s.mark_thread_read("19:c@thread.tacv2", true).unwrap());
        assert!(s.channels().unwrap()[0].is_ghost_read);

        // Same position, Ghost off — a real change, because the badge must go.
        assert!(s.mark_thread_read("19:c@thread.tacv2", false).unwrap());
        let row = &s.channels().unwrap()[0];
        assert!(row.is_read);
        assert!(!row.is_ghost_read);
    }

    // The default local position (0) must mean "never read here", not "read": a thread
    // with no last message carries last_message_time = 0 too, and a legacy row carries
    // both, so a naive `>=` would silently clear a marker Teams is still raising.
    #[test]
    fn a_thread_with_no_local_position_keeps_teams_read_state() {
        let s = Store::open_in_memory().unwrap();
        let mut u = upd("19:empty@thread.v2", "Empty", 0, ConversationKind::Group);
        u.is_read = false;
        s.upsert_conversation_full(&u).unwrap();
        let row = &s.conversations("me").unwrap()[0];
        assert!(!row.is_read, "unread on Teams, never read here");
        assert!(!row.is_ghost_read);

        // And there is nothing to mark: no last message means no read position.
        assert!(!s.mark_thread_read("19:empty@thread.v2", false).unwrap());
        assert!(!s.mark_thread_read("19:empty@thread.v2", true).unwrap());
        assert!(!s.conversations("me").unwrap()[0].is_read);
    }

    // The read position must name a message the user could see, so it comes from the
    // newest message we HOLD, by `seq` — not from the conversation's last-message time.
    #[test]
    fn newest_message_id_is_the_read_position_we_publish() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.newest_message_id("19:chat@thread.v2").unwrap(), None);
        for seq in [3, 1, 2] {
            s.insert_message(&msg("19:chat@thread.v2", seq)).unwrap();
        }
        assert_eq!(
            s.newest_message_id("19:chat@thread.v2").unwrap().as_deref(),
            Some("m3")
        );
        // Scoped to the thread — another conversation's newer message never leaks in.
        s.insert_message(&msg("19:other@thread.v2", 9)).unwrap();
        assert_eq!(
            s.newest_message_id("19:chat@thread.v2").unwrap().as_deref(),
            Some("m3")
        );
    }

    #[test]
    fn is_channel_and_conversations_exclusion() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("19:chat@thread.v2", "Chat", 100).unwrap();
        // Same id lives in BOTH tables (simulating a leak) — the channel wins.
        s.upsert_conversation("19:c@thread.tacv2", "leaked", 50).unwrap();
        s.upsert_channel_full(&chan_upd("19:c@thread.tacv2", "19:t@thread.tacv2", "Ops", "Standup", 60)).unwrap();

        assert!(s.is_channel("19:c@thread.tacv2").unwrap());
        assert!(!s.is_channel("19:chat@thread.v2").unwrap());

        // The chat list excludes any id owned by the channels table.
        let convs = s.conversations("").unwrap();
        assert!(convs.iter().any(|c| c.id == "19:chat@thread.v2"));
        assert!(convs.iter().all(|c| c.id != "19:c@thread.tacv2"));
    }

    #[test]
    fn delete_conversation_row_keeps_messages() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("19:c@thread.tacv2", "leaked", 50).unwrap();
        s.insert_message(&msg("19:c@thread.tacv2", 1)).unwrap();

        assert!(s.delete_conversation_row("19:c@thread.tacv2").unwrap());
        // gone from the conversations list...
        assert!(s.conversations("").unwrap().is_empty());
        // ...but its messages survive (the channel now owns them by id).
        assert_eq!(s.newest_messages("19:c@thread.tacv2", 10).unwrap().len(), 1);
        // idempotent: a second delete removes nothing.
        assert!(!s.delete_conversation_row("19:c@thread.tacv2").unwrap());
    }

    #[test]
    fn set_draft_falls_through_to_channels() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("19:chat@thread.v2", "Chat", 100).unwrap();
        s.upsert_channel_full(&chan_upd("19:c@thread.tacv2", "19:t@thread.tacv2", "Ops", "Standup", 60)).unwrap();

        // A chat draft writes the conversations row.
        s.set_draft("19:chat@thread.v2", "chat draft").unwrap();
        assert_eq!(s.conversations("").unwrap().iter().find(|c| c.id == "19:chat@thread.v2").unwrap().draft, "chat draft");

        // A channel draft falls through to the channels row.
        s.set_draft("19:c@thread.tacv2", "channel draft").unwrap();
        assert_eq!(s.channels().unwrap()[0].draft, "channel draft");

        // An unknown thread id is an error.
        assert!(s.set_draft("19:nope@thread.v2", "x").is_err());
    }

    // ---- mail (read-only Outlook mirror) ------------------------------------

    /// Minimal `MailFolderUpdate`: id/name/label/position vary, counts default.
    fn folder<'a>(id: &'a str, name: &'a str, well_known: &'a str, position: i64) -> MailFolderUpdate<'a> {
        MailFolderUpdate {
            id,
            display_name: name,
            well_known,
            total_count: 0,
            unread_count: 0,
            position,
        }
    }

    /// Minimal `MailMessageUpdate`: id/folder/received/read vary, the rest are
    /// neutral defaults.
    fn mail<'a>(id: &'a str, folder_id: &'a str, received: &'a str, is_read: bool) -> MailMessageUpdate<'a> {
        MailMessageUpdate {
            id,
            folder_id,
            conversation_id: "conv",
            subject: "Subject",
            from_name: "Lucas Silva",
            from_address: "lucas@example.com",
            to_addresses: "[]",
            cc_addresses: "[]",
            received,
            is_read,
            has_attachments: false,
            importance: "normal",
            preview: "preview",
        }
    }

    #[test]
    fn mail_folders_sort_well_known_first_then_user_folders() {
        let s = Store::open_in_memory().unwrap();
        // Inserted out of order, and with a localized display name — the sidebar
        // order must come from `position`, never from the (translated) name.
        s.upsert_mail_folder(&folder("f-user", "Projets", "", 7)).unwrap();
        s.upsert_mail_folder(&folder("f-sent", "Éléments envoyés", "Sent", 2)).unwrap();
        s.upsert_mail_folder(&folder("f-inbox", "Boîte de réception", "Inbox", 0)).unwrap();

        let ids: Vec<String> = s.mail_folders().unwrap().into_iter().map(|f| f.id).collect();
        assert_eq!(ids, vec!["f-inbox", "f-sent", "f-user"]);
        assert_eq!(s.mail_folders().unwrap()[0].display_name, "Boîte de réception");
        assert_eq!(s.mail_folders().unwrap()[0].well_known, "Inbox");
    }

    #[test]
    fn upserting_a_folder_reports_only_real_changes() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.upsert_mail_folder(&folder("f", "Inbox", "Inbox", 0)).unwrap());
        // An identical re-sync must not emit `mail_folders_changed`.
        assert!(!s.upsert_mail_folder(&folder("f", "Inbox", "Inbox", 0)).unwrap());
        // A moved unread count is a real change.
        let mut update = folder("f", "Inbox", "Inbox", 0);
        update.unread_count = 3;
        assert!(s.upsert_mail_folder(&update).unwrap());
        assert_eq!(s.mail_folders().unwrap()[0].unread_count, 3);
    }

    #[test]
    fn mail_pages_newest_first_and_keyset_pages_older() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_folder(&folder("f", "Inbox", "Inbox", 0)).unwrap();
        for (id, received) in [
            ("m1", "2026-07-01T09:00:00Z"),
            ("m2", "2026-07-02T09:00:00Z"),
            ("m3", "2026-07-03T09:00:00Z"),
            ("m4", "2026-07-04T09:00:00Z"),
        ] {
            s.upsert_mail_message(&mail(id, "f", received, true)).unwrap();
        }
        // Another folder's mail never leaks into the page.
        s.upsert_mail_folder(&folder("other", "Archive", "Archive", 1)).unwrap();
        s.upsert_mail_message(&mail("x1", "other", "2026-07-05T09:00:00Z", true)).unwrap();

        let newest: Vec<String> = s.mail_page("f", None, 2).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(newest, vec!["m4", "m3"]);

        // Paging before the oldest row shown continues exactly where it left off:
        // no repeat, no gap.
        let older: Vec<String> = s
            .mail_page("f", Some("2026-07-03T09:00:00Z"), 10)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(older, vec!["m2", "m1"]);
    }

    #[test]
    fn a_re_synced_list_never_discards_a_cached_body() {
        // The property that makes re-opening a mail free: the list upsert and the
        // body write own different columns.
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", false)).unwrap();
        s.set_mail_body(
            "m1",
            &MailBodyUpdate {
                html: "<p>body</p>",
                blocked_remote_images: 4,
                truncated: false,
                attachments: r#"[{"id":"a1"}]"#,
            },
        )
        .unwrap();

        // The mail is re-synced (it was read elsewhere, so its metadata moved).
        assert!(s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", true)).unwrap());

        let row = s.mail_message("m1").unwrap().expect("still there");
        assert!(row.is_read_on_server, "the list field updated");
        assert_eq!(row.body_html, "<p>body</p>", "the cached body survived");
        assert!(row.body_loaded);
        assert_eq!(row.blocked_remote_images, 4);
        assert_eq!(row.attachments, r#"[{"id":"a1"}]"#);
    }

    #[test]
    fn reading_a_mail_here_clears_its_marker_without_touching_the_server_flag() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_folder(&folder("f", "Inbox", "Inbox", 0)).unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", false)).unwrap();

        assert_eq!(s.mark_mail_read_locally("m1").unwrap().as_deref(), Some("f"));

        let row = s.mail_message("m1").unwrap().unwrap();
        assert!(row.is_read(), "the marker is clear here");
        assert!(row.is_read_locally);
        assert!(!row.is_read_on_server, "the mailbox was never told");

        // Re-opening the same mail moves nothing, so no client is asked to refresh.
        assert_eq!(s.mark_mail_read_locally("m1").unwrap(), None);
        // Neither does a mail we do not hold.
        assert_eq!(s.mark_mail_read_locally("nope").unwrap(), None);
    }

    #[test]
    fn a_mail_the_mailbox_calls_read_needs_no_local_mark() {
        // `local_read = 1` must name exactly "read here while the mailbox says
        // unread" — the set the folder count discounts below.
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", true)).unwrap();
        assert_eq!(s.mark_mail_read_locally("m1").unwrap(), None);
        assert!(!s.mail_message("m1").unwrap().unwrap().is_read_locally);
    }

    #[test]
    fn a_sync_that_reports_a_mail_read_drops_our_own_mark() {
        // Once the mailbox itself says read, its flag says everything — and a stale
        // mark would swallow a later "mark as unread" made in Outlook.
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", false)).unwrap();
        s.mark_mail_read_locally("m1").unwrap();

        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", true)).unwrap();
        assert!(!s.mail_message("m1").unwrap().unwrap().is_read_locally);

        // The mail is then marked unread again in Outlook: that comes through.
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", false)).unwrap();
        assert!(!s.mail_message("m1").unwrap().unwrap().is_read());
    }

    #[test]
    fn a_folder_count_discounts_the_mail_read_here() {
        let s = Store::open_in_memory().unwrap();
        let mut f = folder("f", "Inbox", "Inbox", 0);
        f.unread_count = 2;
        s.upsert_mail_folder(&f).unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", false)).unwrap();
        s.upsert_mail_message(&mail("m2", "f", "2026-07-02T09:00:00Z", false)).unwrap();

        s.mark_mail_read_locally("m1").unwrap();
        assert_eq!(s.mail_folders().unwrap()[0].unread_count, 1);

        // A count can only ever be lowered, never taken below zero: the mailbox counts
        // the whole folder while we hold a window of it, so the two can disagree.
        s.mark_mail_read_locally("m2").unwrap();
        s.upsert_mail_message(&mail("m3", "f", "2026-07-03T09:00:00Z", false)).unwrap();
        s.mark_mail_read_locally("m3").unwrap();
        assert_eq!(s.mail_folders().unwrap()[0].unread_count, 0);
    }

    #[test]
    fn the_folder_count_reads_its_local_reads_from_an_index() {
        // `mail_folders` runs on every open of the Mail tab and on every
        // `mail_folders_changed`, so its subtraction must not scan the mirror.
        let s = Store::open_in_memory().unwrap();
        let plan = query_plan(
            &s,
            "SELECT COUNT(*) FROM mail_messages WHERE folder_id = 'f' AND local_read = 1 AND is_read = 0",
        );
        assert!(plan.contains("idx_mail_local_read"), "plan was:\n{plan}");
        assert!(!plan.contains("SCAN mail_messages"), "plan was:\n{plan}");
    }

    #[test]
    fn body_loaded_distinguishes_never_fetched_from_fetched_and_empty() {
        // A real case: a mail whose entire content was remote images sanitizes to
        // nothing. Without this flag the UI would re-fetch it forever.
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", true)).unwrap();
        assert!(!s.mail_message("m1").unwrap().unwrap().body_loaded);

        s.set_mail_body(
            "m1",
            &MailBodyUpdate { html: "", blocked_remote_images: 7, truncated: false, attachments: "[]" },
        )
        .unwrap();
        let row = s.mail_message("m1").unwrap().unwrap();
        assert!(row.body_loaded);
        assert_eq!(row.body_html, "");
        assert_eq!(row.blocked_remote_images, 7);
    }

    #[test]
    fn the_history_frontier_only_ever_moves_backwards() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_folder(&folder("f", "Inbox", "Inbox", 0)).unwrap();
        // Unknown folder: no history, and more may exist.
        assert_eq!(s.mail_frontier("nope").unwrap(), (String::new(), true));

        s.set_mail_frontier("f", "2026-07-03T09:00:00Z", true).unwrap();
        assert_eq!(
            s.mail_frontier("f").unwrap(),
            ("2026-07-03T09:00:00Z".to_string(), true)
        );

        // A page of older mail extends the frontier.
        s.set_mail_frontier("f", "2026-07-01T09:00:00Z", false).unwrap();
        assert_eq!(
            s.mail_frontier("f").unwrap(),
            ("2026-07-01T09:00:00Z".to_string(), false)
        );

        // An out-of-order sync reporting a NEWER oldest must not shrink the backlog.
        s.set_mail_frontier("f", "2026-07-09T09:00:00Z", true).unwrap();
        assert_eq!(s.mail_frontier("f").unwrap().0, "2026-07-01T09:00:00Z");

        // An EMPTY page reports "nothing older", and must leave the frontier we
        // already know intact rather than resetting it to the epoch.
        s.set_mail_frontier("f", "", false).unwrap();
        assert_eq!(
            s.mail_frontier("f").unwrap(),
            ("2026-07-01T09:00:00Z".to_string(), false)
        );
    }

    #[test]
    fn newest_received_is_the_live_poll_watermark() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.newest_mail_received("f").unwrap(), None);
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", true)).unwrap();
        s.upsert_mail_message(&mail("m2", "f", "2026-07-04T09:00:00Z", true)).unwrap();
        s.upsert_mail_message(&mail("x", "other", "2026-07-09T09:00:00Z", true)).unwrap();
        assert_eq!(
            s.newest_mail_received("f").unwrap().as_deref(),
            Some("2026-07-04T09:00:00Z")
        );
    }

    #[test]
    fn pruning_the_newest_window_removes_mail_deleted_elsewhere() {
        let s = Store::open_in_memory().unwrap();
        for (id, received) in [
            ("old", "2026-07-01T09:00:00Z"),
            ("gone", "2026-07-03T09:00:00Z"),
            ("kept", "2026-07-04T09:00:00Z"),
        ] {
            s.upsert_mail_message(&mail(id, "f", received, true)).unwrap();
        }
        // The server's newest window holds only `kept`, from 07-03 onwards.
        let removed = s
            .prune_mail_window("f", "2026-07-03T09:00:00Z", &["kept".to_string()])
            .unwrap();
        assert_eq!(removed, 1);
        let ids: Vec<String> = s.mail_page("f", None, 10).unwrap().into_iter().map(|m| m.id).collect();
        // `gone` was deleted in Outlook; `old` predates the window and is untouched.
        assert_eq!(ids, vec!["kept", "old"]);
    }

    #[test]
    fn pruning_with_an_empty_window_is_a_no_op() {
        // A failed or empty fetch must never be read as "the folder is empty now",
        // which would wipe the local cache the UI is showing.
        let s = Store::open_in_memory().unwrap();
        s.upsert_mail_message(&mail("m1", "f", "2026-07-01T09:00:00Z", true)).unwrap();
        assert_eq!(s.prune_mail_window("f", "2026-07-01T09:00:00Z", &[]).unwrap(), 0);
        assert_eq!(s.prune_mail_window("f", "", &["m1".to_string()]).unwrap(), 0);
        assert_eq!(s.mail_page("f", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn the_mail_list_page_never_scans_the_table() {
        // The mail equivalent of the chat query-plan assertions above: the covering
        // index must serve both the ORDER BY and the keyset predicate, or a mailbox
        // with thousands of messages makes every keystroke in the list expensive.
        let s = Store::open_in_memory().unwrap();
        let plan = query_plan(
            &s,
            &format!(
                "SELECT {MAIL_SELECT_COLS} FROM mail_messages
                  WHERE folder_id = 'f' AND received < '2026-07-03T09:00:00Z'
                  ORDER BY received DESC, id ASC LIMIT 40"
            ),
        );
        assert!(
            plan.contains("USING INDEX idx_mail_folder_received"),
            "the mail page must use its covering index, got: {plan}"
        );
        assert!(
            !plan.contains("SCAN mail_messages"),
            "the mail page must not scan the table, got: {plan}"
        );
        assert!(
            !plan.contains("TEMP B-TREE"),
            "the mail page must not sort in a temp b-tree, got: {plan}"
        );
    }

    // ---- calendar ------------------------------------------------------------

    /// Minimal `CalendarEventUpdate`: only id, calendar and the span vary, which is
    /// what every range and pruning test turns on.
    fn event<'a>(
        id: &'a str,
        calendar_id: &'a str,
        start: &'a str,
        end: &'a str,
    ) -> CalendarEventUpdate<'a> {
        CalendarEventUpdate {
            id,
            calendar_id,
            subject: "Stand-up",
            preview: "",
            start_utc: start,
            end_utc: end,
            is_all_day: false,
            is_cancelled: false,
            is_organizer: false,
            organizer_name: "",
            organizer_address: "",
            location: "",
            join_url: "",
            web_link: "",
            show_as: "busy",
            response: "none",
            series: "singleInstance",
            recurrence: "",
            importance: "normal",
            sensitivity: "normal",
            categories: "[]",
            attendees: "[]",
            attendee_count: 0,
            has_attachments: false,
            reminder_minutes: 15,
        }
    }

    fn event_ids(rows: &[CalendarEventRow]) -> Vec<String> {
        rows.iter().map(|e| e.id.clone()).collect()
    }

    #[test]
    fn calendar_events_returns_everything_overlapping_the_window() {
        let s = Store::open_in_memory().unwrap();
        for (id, start, end) in [
            // Entirely before the window.
            ("before", "2026-07-05T09:00:00Z", "2026-07-05T10:00:00Z"),
            // Ends exactly when the window starts — adjacent, not overlapping.
            ("adjacent", "2026-07-12T09:00:00Z", "2026-07-13T00:00:00Z"),
            // Started before the window and still running inside it: a week of leave
            // seen from a day in the middle. The case a naive "starts within" filter
            // loses.
            ("straddles", "2026-07-11T00:00:00Z", "2026-07-16T00:00:00Z"),
            ("inside", "2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z"),
            // Starts exactly when the window ends — the next day's event.
            ("after", "2026-07-14T00:00:00Z", "2026-07-14T01:00:00Z"),
        ] {
            s.upsert_calendar_event(&event(id, "cal", start, end)).unwrap();
        }
        let rows = s
            .calendar_events("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z", &[])
            .unwrap();
        assert_eq!(event_ids(&rows), vec!["straddles", "inside"]);
    }

    #[test]
    fn calendar_events_includes_a_zero_length_event_inside_the_window() {
        // Graph does emit these, and a missing end is clamped to the start by
        // `calendar::parse_event`. The textbook `end > window_start` predicate alone
        // would drop one sitting exactly on the window's first instant.
        let s = Store::open_in_memory().unwrap();
        s.upsert_calendar_event(&event(
            "point",
            "cal",
            "2026-07-13T00:00:00Z",
            "2026-07-13T00:00:00Z",
        ))
        .unwrap();
        let rows = s
            .calendar_events("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z", &[])
            .unwrap();
        assert_eq!(event_ids(&rows), vec!["point"]);
    }

    #[test]
    fn calendar_events_filters_to_the_visible_calendars() {
        let s = Store::open_in_memory().unwrap();
        for (id, calendar) in [("work", "cal-main"), ("birthday", "cal-birthdays")] {
            s.upsert_calendar_event(&event(id, calendar, "2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z"))
                .unwrap();
        }
        let window = ("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z");
        // No filter means every calendar.
        assert_eq!(s.calendar_events(window.0, window.1, &[]).unwrap().len(), 2);
        let only_work = s
            .calendar_events(window.0, window.1, &["cal-main".to_string()])
            .unwrap();
        assert_eq!(event_ids(&only_work), vec!["work"]);
    }

    #[test]
    fn calendar_events_are_ordered_earliest_first() {
        let s = Store::open_in_memory().unwrap();
        for (id, start) in [
            ("noon", "2026-07-13T12:00:00Z"),
            ("dawn", "2026-07-13T06:00:00Z"),
            ("dusk", "2026-07-13T20:00:00Z"),
        ] {
            s.upsert_calendar_event(&event(id, "cal", start, "2026-07-13T23:00:00Z"))
                .unwrap();
        }
        let rows = s
            .calendar_events("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z", &[])
            .unwrap();
        assert_eq!(event_ids(&rows), vec!["dawn", "noon", "dusk"]);
    }

    #[test]
    fn upserting_an_event_reports_only_real_changes() {
        let s = Store::open_in_memory().unwrap();
        let mut e = event("e1", "cal", "2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z");
        assert!(s.upsert_calendar_event(&e).unwrap(), "a new event is a change");
        assert!(!s.upsert_calendar_event(&e).unwrap(), "an identical re-sync is not");
        // A meeting moved half an hour later.
        e.start_utc = "2026-07-13T09:30:00Z";
        assert!(s.upsert_calendar_event(&e).unwrap());
        // An invitation answered.
        e.response = "accepted";
        assert!(s.upsert_calendar_event(&e).unwrap());
    }

    #[test]
    fn pruning_a_window_removes_events_deleted_elsewhere() {
        let s = Store::open_in_memory().unwrap();
        for (id, start) in [
            ("kept", "2026-07-13T09:00:00Z"),
            ("cancelled-in-outlook", "2026-07-13T14:00:00Z"),
            ("next-month", "2026-08-02T09:00:00Z"),
        ] {
            s.upsert_calendar_event(&event(id, "cal", start, "2026-07-13T23:00:00Z"))
                .unwrap();
        }
        let removed = s
            .prune_calendar_window(
                "cal",
                "2026-07-01T00:00:00Z",
                "2026-08-01T00:00:00Z",
                &["kept".to_string()],
            )
            .unwrap();
        assert_eq!(removed, 1);
        // Outside the pruned window, August is untouched.
        let august = s
            .calendar_events("2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", &[])
            .unwrap();
        assert_eq!(event_ids(&august), vec!["next-month"]);
    }

    #[test]
    fn pruning_an_empty_month_clears_it() {
        // Unlike mail, an empty answer here is meaningful: a month with nothing in it
        // is normal, and the stale rows must go. A failed fetch never reaches this
        // call — the error propagates from the caller instead.
        let s = Store::open_in_memory().unwrap();
        s.upsert_calendar_event(&event("gone", "cal", "2026-07-13T09:00:00Z", "2026-07-13T10:00:00Z"))
            .unwrap();
        assert_eq!(
            s.prune_calendar_window("cal", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", &[])
                .unwrap(),
            1
        );
        assert!(s
            .calendar_events("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn pruning_one_calendar_leaves_the_others_alone() {
        let s = Store::open_in_memory().unwrap();
        for calendar in ["cal-main", "cal-holidays"] {
            s.upsert_calendar_event(&event(
                calendar,
                calendar,
                "2026-07-13T09:00:00Z",
                "2026-07-13T10:00:00Z",
            ))
            .unwrap();
        }
        s.prune_calendar_window("cal-main", "2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", &[])
            .unwrap();
        let rows = s
            .calendar_events("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z", &[])
            .unwrap();
        assert_eq!(event_ids(&rows), vec!["cal-holidays"]);
    }

    #[test]
    fn a_synced_month_is_remembered_per_calendar() {
        // The distinction that keeps an unsynced week from rendering as a free one.
        let s = Store::open_in_memory().unwrap();
        assert!(!s.calendar_month_synced("cal", "2026-07").unwrap());
        s.mark_calendar_month_synced("cal", "2026-07").unwrap();
        assert!(s.calendar_month_synced("cal", "2026-07").unwrap());
        assert!(!s.calendar_month_synced("cal", "2026-08").unwrap());
        assert!(!s.calendar_month_synced("other", "2026-07").unwrap());
        // Idempotent: re-marking is a refresh, not a duplicate row.
        s.mark_calendar_month_synced("cal", "2026-07").unwrap();
        assert!(s.calendar_month_synced("cal", "2026-07").unwrap());
    }

    #[test]
    fn calendars_list_puts_the_default_first() {
        let s = Store::open_in_memory().unwrap();
        for (id, name, position, is_default) in [
            ("cal-birthdays", "Birthdays", 1, false),
            ("cal-main", "Calendar", 0, true),
        ] {
            s.upsert_calendar(&CalendarUpdate {
                id,
                name,
                hex_color: "",
                is_default,
                can_edit: is_default,
                position,
            })
            .unwrap();
        }
        let rows = s.calendars().unwrap();
        assert_eq!(
            rows.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
            vec!["cal-main", "cal-birthdays"]
        );
        assert!(rows[0].is_default);
    }

    #[test]
    fn the_calendar_range_query_never_scans_the_table() {
        // The calendar equivalent of the assertions above: every view is a range
        // read, so the index must serve it rather than the table.
        let s = Store::open_in_memory().unwrap();
        let plan = query_plan(
            &s,
            &format!(
                "SELECT {EVENT_SELECT_COLS} FROM calendar_events
                  WHERE start_utc < '2026-08-01T00:00:00Z'
                    AND (end_utc > '2026-07-01T00:00:00Z' OR start_utc >= '2026-07-01T00:00:00Z')
                  ORDER BY start_utc ASC, end_utc ASC, id ASC"
            ),
        );
        assert!(
            plan.contains("idx_calendar_event_range"),
            "the calendar range read must use its index, got: {plan}"
        );
        assert!(
            !plan.contains("SCAN calendar_events"),
            "the calendar range read must not scan the table, got: {plan}"
        );
        assert!(
            !plan.contains("TEMP B-TREE"),
            "the calendar range read must not sort in a temp b-tree, got: {plan}"
        );
    }

    #[test]
    fn conversation_context_names_a_chat_or_a_teams_channel() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("19:group@thread.v2", "Release train", 100).unwrap();
        assert_eq!(s.conversation_context("19:group@thread.v2", "8:orgid:me").unwrap(), "Release train");

        s.upsert_channel_full(&ChannelUpdate {
            id: "19:chan@thread.tacv2",
            team_id: "t1",
            team_name: "Engine",
            team_group_id: "",
            display_name: "General",
            is_general: true,
            is_shown: true,
            is_pinned: false,
            team_collapsed: false,
            last_message_time: 100,
            last_message_preview: "",
            last_message_sender: "",
            last_message_sender_mri: "",
            last_message_from_me: false,
            is_read: true,
            alerts: ChannelAlerts::MentionsOnly,
            team_pos: 0,
            channel_pos: 0,
        })
        .unwrap();
        assert_eq!(s.conversation_context("19:chan@thread.tacv2", "8:orgid:me").unwrap(), "Engine · General");
        assert_eq!(s.conversation_context("19:unknown@thread.v2", "8:orgid:me").unwrap(), "");
    }

    #[test]
    fn a_push_subscription_round_trips_and_re_registering_replaces_it() {
        let s = Store::open_in_memory().unwrap();
        s.put_push_subscription("https://web.push.apple.com/a", "key-a", "auth-a", "iPhone", 100)
            .unwrap();
        s.put_push_subscription("https://web.push.apple.com/b", "key-b", "auth-b", "Laptop", 200)
            .unwrap();

        let subs = s.push_subscriptions().unwrap();
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].endpoint, "https://web.push.apple.com/a");
        assert_eq!(subs[0].label, "iPhone");
        assert_eq!(subs[0].p256dh, "key-a");

        // A browser may rotate the keys under the same endpoint; re-registering
        // updates the row instead of adding a second one for the same device.
        s.put_push_subscription("https://web.push.apple.com/a", "key-a2", "auth-a2", "iPhone", 300)
            .unwrap();
        let subs = s.push_subscriptions().unwrap();
        assert_eq!(subs.len(), 2, "re-registering must not duplicate the device");
        assert_eq!(subs[0].p256dh, "key-a2");
        assert_eq!(subs[0].created_ms, 100, "the original subscription date is kept");
    }

    #[test]
    fn a_delivery_outcome_is_recorded_and_a_success_clears_the_error() {
        let s = Store::open_in_memory().unwrap();
        s.put_push_subscription("https://web.push.apple.com/a", "k", "a", "iPhone", 100).unwrap();

        s.mark_push_delivery("https://web.push.apple.com/a", 500, "push service answered 500")
            .unwrap();
        let sub = s.push_subscriptions().unwrap().remove(0);
        assert_eq!(sub.last_error, "push service answered 500");
        assert_eq!(sub.last_ok_ms, 0);

        s.mark_push_delivery("https://web.push.apple.com/a", 900, "").unwrap();
        let sub = s.push_subscriptions().unwrap().remove(0);
        assert_eq!(sub.last_error, "", "a success clears the stale failure");
        assert_eq!(sub.last_ok_ms, 900);
    }

    #[test]
    fn deleting_a_subscription_reports_whether_a_row_went_away() {
        let s = Store::open_in_memory().unwrap();
        s.put_push_subscription("https://web.push.apple.com/a", "k", "a", "", 100).unwrap();
        assert!(s.delete_push_subscription("https://web.push.apple.com/a").unwrap());
        assert!(!s.delete_push_subscription("https://web.push.apple.com/a").unwrap());
        assert!(s.push_subscriptions().unwrap().is_empty());
    }

    #[test]
    fn only_the_first_claim_of_a_live_message_wins() {
        // Two backends share this store and both see every live message; the claim
        // is what keeps the phone from buzzing twice — and one `@claude` trigger from
        // being answered twice.
        let s = Store::open_in_memory().unwrap();
        assert!(s.claim_once("c1/m1", 1_000).unwrap());
        assert!(!s.claim_once("c1/m1", 1_000).unwrap());
        assert!(s.claim_once("c1/m2", 1_000).unwrap());
        // The two users share the table and cannot collide: different key spaces.
        assert!(s.claim_once("agent/c1/m1", 1_000).unwrap());

        assert_eq!(s.prune_claims(1_001).unwrap(), 3);
        // Pruned claims are re-claimable, which is fine: every policy refuses a
        // message that old anyway.
        assert!(s.claim_once("c1/m1", 2_000).unwrap());
    }

    fn a_run(message_id: &str, heartbeat_ms: i64) -> AgentRun {
        AgentRun {
            conversation_id: "19:c@thread.v2".into(),
            message_id: message_id.into(),
            trigger_id: "1000".into(),
            backend: "claude".into(),
            started_ms: 1_000,
            heartbeat_ms,
        }
    }

    #[test]
    fn a_run_is_abandoned_only_once_its_heartbeat_goes_quiet() {
        let s = Store::open_in_memory().unwrap();
        s.begin_agent_run(&a_run("2000", 1_000)).unwrap();
        assert!(s.abandoned_agent_runs(1_000).unwrap().is_empty(), "not quiet yet");

        // A run that keeps saying so keeps its message, however long it takes. This is
        // the case that must never be repaired: an agent thinking for five minutes.
        s.touch_agent_run("19:c@thread.v2", "2000", 9_000).unwrap();
        assert!(s.abandoned_agent_runs(5_000).unwrap().is_empty());

        let abandoned = s.abandoned_agent_runs(10_000).unwrap();
        assert_eq!(abandoned.len(), 1);
        assert_eq!(abandoned[0].message_id, "2000");
        assert_eq!(abandoned[0].trigger_id, "1000", "the run id a stream frame needs");
        assert_eq!(abandoned[0].heartbeat_ms, 9_000);
    }

    #[test]
    fn a_finished_run_leaves_nothing_to_repair() {
        let s = Store::open_in_memory().unwrap();
        s.begin_agent_run(&a_run("2000", 1_000)).unwrap();
        s.finish_agent_run("19:c@thread.v2", "2000").unwrap();
        assert!(s.abandoned_agent_runs(i64::MAX).unwrap().is_empty());
        // Registering twice is the same run, not two: one message, one body.
        s.begin_agent_run(&a_run("2000", 1_000)).unwrap();
        s.begin_agent_run(&a_run("2000", 2_000)).unwrap();
        assert_eq!(s.abandoned_agent_runs(i64::MAX).unwrap().len(), 1);
    }

    #[test]
    fn only_one_sweeper_takes_an_abandoned_run() {
        // Two backends share this store and both sweep it; the message must be edited
        // once. The DELETE is the arbitration, so the loser gets `false`.
        let s = Store::open_in_memory().unwrap();
        s.begin_agent_run(&a_run("2000", 1_000)).unwrap();
        assert!(s.take_abandoned_agent_run("19:c@thread.v2", "2000", 5_000).unwrap());
        assert!(!s.take_abandoned_agent_run("19:c@thread.v2", "2000", 5_000).unwrap());

        // A run that spoke again between the listing and the take keeps its message.
        s.begin_agent_run(&a_run("2001", 9_000)).unwrap();
        assert!(!s.take_abandoned_agent_run("19:c@thread.v2", "2001", 5_000).unwrap());
        assert_eq!(s.abandoned_agent_runs(i64::MAX).unwrap().len(), 1);
    }

    #[test]
    fn a_custom_emoji_round_trips_with_its_bytes() {
        let s = Store::open_in_memory().unwrap();
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47];
        s.set_custom_emoji("shipit", Some(("image/png", png, 128, 128)), None, "upload", 100).unwrap();
        let all = s.custom_emoji().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "shipit");
        assert_eq!(all[0].width, 128);
        assert_eq!(all[0].source, "upload");
        assert_eq!(s.custom_emoji_art("shipit").unwrap().unwrap(), ("image/png".to_string(), png.to_vec()));
    }

    #[test]
    fn an_alias_resolves_to_its_targets_art() {
        let s = Store::open_in_memory().unwrap();
        let png: &[u8] = &[1, 2, 3];
        s.set_custom_emoji("shipit", Some(("image/png", png, 64, 64)), None, "upload", 100).unwrap();
        s.set_custom_emoji("ship", None, Some("shipit"), "upload", 101).unwrap();
        assert_eq!(s.custom_emoji_art("ship").unwrap().unwrap().1, png.to_vec());
    }

    #[test]
    fn an_alias_never_points_at_an_alias() {
        let s = Store::open_in_memory().unwrap();
        s.set_custom_emoji("shipit", Some(("image/png", &[1], 8, 8)), None, "upload", 100).unwrap();
        s.set_custom_emoji("ship", None, Some("shipit"), "upload", 101).unwrap();
        assert!(
            s.set_custom_emoji("s", None, Some("ship"), "upload", 102).is_err(),
            "a chain would make one read walk an unbounded graph"
        );
    }

    #[test]
    fn a_name_is_validated_in_the_store_too() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.set_custom_emoji("Ship It", Some(("image/png", &[1], 8, 8)), None, "upload", 1).is_err());
    }

    #[test]
    fn removing_one_says_whether_it_was_there() {
        let s = Store::open_in_memory().unwrap();
        s.set_custom_emoji("shipit", Some(("image/png", &[1], 8, 8)), None, "upload", 100).unwrap();
        assert!(s.remove_custom_emoji("shipit").unwrap());
        assert!(!s.remove_custom_emoji("shipit").unwrap());
        assert!(s.custom_emoji().unwrap().is_empty());
    }

    #[test]
    fn an_emoji_is_either_art_or_an_alias() {
        let s = Store::open_in_memory().unwrap();
        assert!(
            s.set_custom_emoji("x", None, None, "upload", 1).is_err(),
            "a row that is neither art nor an alias names nothing"
        );
    }
}

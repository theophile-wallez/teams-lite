// Local-first message store (SQLite). The UI reads from here; the network only
// backfills at the cache frontier. Source of truth for conversations + messages.
//
// Design notes:
//   - messages are deduplicated by (conversation_id, id) — a live push and a
//     history fetch can return the same message; never duplicate it.
//   - ordering key is `seq` (Teams sequenceId), monotonic within a conversation.
//   - pagination state per conversation: `oldest_cursor` (server cursor to fetch
//     messages older than what we hold) + `has_more_older`.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};

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
    last_message_from_me  INTEGER NOT NULL DEFAULT 0,
    is_read               INTEGER NOT NULL DEFAULT 1,
    is_muted              INTEGER NOT NULL DEFAULT 0,
    is_pinned             INTEGER NOT NULL DEFAULT 0,
    is_hidden             INTEGER NOT NULL DEFAULT 0,
    thread_type           TEXT NOT NULL DEFAULT '',
    draft                 TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 0,
    compose_time    INTEGER NOT NULL DEFAULT 0,
    sender          TEXT,
    sender_mri      TEXT,
    content         TEXT,
    attachments     TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (conversation_id, id)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

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
    pub content: String,
    /// File/card attachments shared in the message, as a JSON array string (the
    /// same shape the UI receives: `[{name, content_type, url, kind}]`). Inline
    /// images embedded in `content` as `<img>` are NOT recorded here — the UI
    /// extracts and renders those from the content HTML directly. Defaults to
    /// `"[]"` for messages without attachments and for legacy rows.
    pub attachments: String,
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
    /// False when the conversation has unread messages.
    pub is_read: bool,
    pub is_muted: bool,
    pub is_pinned: bool,
    pub is_hidden: bool,
    pub thread_type: String,
    /// Unsent composer text, stored locally and scoped to this conversation.
    pub draft: String,
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
    pub last_message_from_me: bool,
    pub is_read: bool,
    pub is_muted: bool,
    pub is_pinned: bool,
    pub is_hidden: bool,
    pub thread_type: &'a str,
}

pub struct Store {
    conn: Connection,
}

fn row_to_msg(row: &Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        seq: row.get(2)?,
        compose_time: row.get(3)?,
        sender: row.get(4)?,
        sender_mri: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        content: row.get(6)?,
        attachments: row
            .get::<_, Option<String>>(7)?
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "[]".to_string()),
    })
}

const SELECT_COLS: &str = "id, conversation_id, seq, compose_time, sender, sender_mri, content, attachments";

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
            // rusqlite surfaces "duplicate column name" when the column already exists
            Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column") => Ok(()),
            Err(e) => Err(e.into()),
        }
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
    Ok(())
}

impl Store {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        // WAL lets a reader (UI thread) and a writer (network thread) use separate
        // connections to the same file concurrently without blocking each other.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    /// Delete control/system frames that older builds persisted as chat messages,
    /// before ingestion started gating on `messagetype`. Two shapes leaked in:
    ///   - typing/presence pushes whose body is a bare Skype notifications
    ///     endpoint URL (`https://notifications.skype.net/…`), and
    ///   - `ThreadActivity` member/topic changes whose body is a raw system XML
    ///     frame (`<partlist>`, `<addmember>`, `<deletemember>`, `<topicupdate>`, …).
    ///
    /// A legitimate `RichText/Html` body never starts with any of these tokens
    /// (it begins with text or a standard HTML tag), and chat content is never a
    /// bare push endpoint URL, so the match cannot hit a real message. Meant to
    /// run once at startup (like the `48:notifications` cleanup); idempotent, so a
    /// cleaned store deletes nothing on a later run. Returns rows removed. `LIKE`
    /// is ASCII case-insensitive in SQLite, so tag casing needs no extra patterns.
    pub fn purge_control_frames(&self) -> Result<usize> {
        let n = self.conn.execute(
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
              OR content LIKE '<memberjoined%'",
            [],
        )?;
        Ok(n)
    }

    /// Returns true when the row was newly inserted or an existing row actually
    /// changed. The guarded `DO UPDATE ... WHERE` makes a no-op upsert modify 0
    /// rows, so callers can emit a `conversations_changed` event ONLY on a real
    /// change. Without this, a repeated sync of unchanged data reports a change
    /// every time and drives an endless refresh->sync->event->refresh loop.
    pub fn upsert_conversation(&self, id: &str, display_name: &str, last_message_time: i64) -> Result<bool> {
        let changed = self.conn.execute(
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
        let changed = self.conn.execute(
            "INSERT INTO conversations (
                id, display_name, last_message_time, kind,
                last_message_preview, last_message_sender, last_message_from_me,
                is_read, is_muted, is_pinned, is_hidden, thread_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                    ELSE conversations.thread_type END
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
                    OR excluded.last_message_from_me <> conversations.last_message_from_me
                    OR excluded.is_read              <> conversations.is_read))
                OR excluded.is_muted  <> conversations.is_muted
                OR excluded.is_pinned <> conversations.is_pinned
                OR excluded.is_hidden <> conversations.is_hidden
                OR (excluded.thread_type <> '' AND excluded.thread_type <> conversations.thread_type)",
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
            ],
        )?;
        Ok(changed > 0)
    }

    /// Remove a conversation and all of its messages. Used to purge the
    /// `48:notifications` activity feed, which older builds mis-persisted as a
    /// chat (empty-content bubbles under a raw MRI-URL title) before it was
    /// recognized as a system feed. Idempotent: a no-op when the id is absent.
    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Insert a message, deduplicated by id. Returns true if it was newly
    /// inserted OR its content changed (an edit). When the same id arrives again
    /// with identical content, this is a no-op and returns false, so re-fetches
    /// stay cheap while genuine edits — from us or anyone else — propagate.
    pub fn insert_message(&self, m: &Message) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT INTO messages (id, conversation_id, seq, compose_time, sender, sender_mri, content, attachments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(conversation_id, id) DO UPDATE SET content = excluded.content
                 WHERE messages.content <> excluded.content",
            params![m.id, m.conversation_id, m.seq, m.compose_time, m.sender, m.sender_mri, m.content, m.attachments],
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
        let changed = self.conn.execute(
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
        let mut stmt = self.conn.prepare(&sql)?;
        let msg = stmt.query_row(params![conversation_id, id], row_to_msg)?;
        Ok(Some(msg))
    }

    /// Persist the unsent composer text for one conversation. Network syncs never
    /// write this column, so a local draft cannot be clobbered by remote metadata.
    pub fn set_draft(&self, conversation_id: &str, draft: &str) -> Result<()> {
        let changed = self.conn.execute(
            "UPDATE conversations SET draft = ?2 WHERE id = ?1",
            params![conversation_id, draft],
        )?;
        anyhow::ensure!(changed == 1, "unknown conversation: {conversation_id}");
        Ok(())
    }

    /// Read one application setting by key. Returns `None` when the key was never
    /// set. This is a simple key/value side table (see `SCHEMA`), used for
    /// durable app configuration such as the GitLab host and access token — data
    /// that is neither a conversation nor a message. Network syncs never touch it.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
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
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
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
        self.conn.execute(
            "UPDATE messages SET sender_mri = ?3
             WHERE conversation_id = ?1 AND id = ?2
               AND (sender_mri IS NULL OR sender_mri = '')",
            params![conversation_id, id, sender_mri],
        )?;
        Ok(())
    }

    /// All conversations, most-recently-active first, for the list pane.
    ///
    /// Conversations with an empty stored title (1:1 chats) get their name derived
    /// from the most recent message sender that is not `self_name`. `self_name`
    /// may be empty (then no derivation happens).
    pub fn conversations(&self, self_name: &str) -> Result<Vec<ConversationRow>> {
        // Correlated subquery fills the blank 1:1 titles in a single pass.
        let mut stmt = self.conn.prepare(
            "SELECT c.id,
                    CASE
                        WHEN c.display_name IS NOT NULL AND c.display_name <> ''
                        THEN c.display_name
                        ELSE COALESCE((
                            SELECT m.sender FROM messages m
                            WHERE m.conversation_id = c.id
                              AND m.sender <> '' AND m.sender <> ?1
                            ORDER BY m.seq DESC LIMIT 1
                        ), '')
                    END AS name,
                    c.last_message_time,
                    c.kind,
                    c.last_message_preview,
                    c.last_message_sender,
                    c.last_message_from_me,
                    c.is_read,
                    c.is_muted,
                    c.is_pinned,
                    c.is_hidden,
                    c.thread_type,
                    c.draft
             FROM conversations c
             ORDER BY c.is_pinned DESC, c.last_message_time DESC, c.id ASC",
        )?;
        let rows = stmt.query_map(params![self_name], |r| {
            Ok(ConversationRow {
                id: r.get(0)?,
                display_name: r.get(1)?,
                last_message_time: r.get(2)?,
                kind: ConversationKind::from_str(&r.get::<_, String>(3)?),
                last_message_preview: r.get(4)?,
                last_message_sender: r.get(5)?,
                last_message_from_me: r.get::<_, i64>(6)? != 0,
                is_read: r.get::<_, i64>(7)? != 0,
                is_muted: r.get::<_, i64>(8)? != 0,
                is_pinned: r.get::<_, i64>(9)? != 0,
                is_hidden: r.get::<_, i64>(10)? != 0,
                thread_type: r.get(11)?,
                draft: r.get(12)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Derive a display name for a conversation whose stored title is empty
    /// (typically a 1:1 chat, whose CSA `title` is blank and whose `members`
    /// carry no names). Heuristic: the most recent message sender that is NOT us.
    /// Returns None when we hold no message from the other party yet.
    pub fn other_party_name(&self, conversation_id: &str, self_name: &str) -> Result<Option<String>> {
        let name: Option<String> = self
            .conn
            .query_row(
                "SELECT sender FROM messages
                 WHERE conversation_id = ?1 AND sender <> '' AND sender <> ?2
                 ORDER BY seq DESC LIMIT 1",
                params![conversation_id, self_name],
                |r| r.get(0),
            )
            .ok();
        Ok(name)
    }

    /// Resolve a display name for a sender MRI from the messages we already hold.
    /// Used by the typing indicator: a `Control/Typing` frame carries the typer's
    /// MRI but no display name, and this is a local, network-free lookup (in a
    /// group chat the person has almost always sent a message we've stored).
    /// Returns the most recent non-empty `sender` for that MRI, or None.
    pub fn display_name_for_mri(&self, sender_mri: &str) -> Result<Option<String>> {
        if sender_mri.is_empty() {
            return Ok(None);
        }
        let name: Option<String> = self
            .conn
            .query_row(
                "SELECT sender FROM messages
                 WHERE sender_mri = ?1 AND sender <> ''
                 ORDER BY seq DESC LIMIT 1",
                params![sender_mri],
                |r| r.get(0),
            )
            .ok();
        Ok(name)
    }

    /// The newest `limit` messages of a conversation, ordered oldest -> newest (for display).
    pub fn newest_messages(&self, conversation_id: &str, limit: i64) -> Result<Vec<Message>> {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT ?2"
        );
        let mut stmt = self.conn.prepare(&sql)?;
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
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![conversation_id, before_seq, limit], row_to_msg)?;
        let mut v: Vec<Message> = rows.collect::<rusqlite::Result<_>>()?;
        v.reverse();
        Ok(v)
    }

    /// Record how far back we have synced from the server for a conversation.
    pub fn set_oldest_cursor(&self, conversation_id: &str, cursor: Option<&str>, has_more: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE conversations SET oldest_cursor = ?2, has_more_older = ?3 WHERE id = ?1",
            params![conversation_id, cursor, has_more as i64],
        )?;
        Ok(())
    }

    /// (server cursor for the next older page, whether more history exists).
    pub fn oldest_cursor(&self, conversation_id: &str) -> Result<(Option<String>, bool)> {
        let row = self.conn.query_row(
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
            last_message_from_me: false,
            is_read: true,
            is_muted: false,
            is_pinned: false,
            is_hidden: false,
            thread_type: "",
        }
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
        };

        // Real chat messages that must survive — including one that merely mentions
        // a notifications URL inside normal HTML (it does not START with it).
        s.insert_message(&frame("real1", "<p>hello world</p>")).unwrap();
        s.insert_message(&frame("real2", "<p>see https://notifications.skype.net/x</p>")).unwrap();
        // Control/system frames that must be purged.
        s.insert_message(&frame("junk1", "https://notifications.skype.net/v1/users/ME/contacts/8:orgid:bea5de00")).unwrap();
        s.insert_message(&frame("junk2", "<partlist alt=\"\"><part/></partlist>")).unwrap();
        s.insert_message(&frame("junk3", "<addmember><target>8:orgid:x</target></addmember>")).unwrap();
        s.insert_message(&frame("junk4", "<topicupdate><value>New</value></topicupdate>")).unwrap();

        let removed = s.purge_control_frames().unwrap();
        assert_eq!(removed, 4, "only the four control/system frames are deleted");

        let mut left: Vec<_> = s
            .newest_messages("c1", 50)
            .unwrap()
            .into_iter()
            .map(|m| m.id)
            .collect();
        left.sort();
        assert_eq!(left, ["real1", "real2"], "real chat messages are untouched");

        // Idempotent: a cleaned store deletes nothing on the next pass.
        assert_eq!(s.purge_control_frames().unwrap(), 0);
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
        let mut with_mri = |seq: i64, name: &str, mri: &str| {
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
            last_message_from_me: false,
            is_read: false,
            is_muted: true,
            is_pinned: true,
            is_hidden: false,
            thread_type: "chat",
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
        }).unwrap();
        s.insert_message(&Message {
            id: "m2".into(), conversation_id: "dm".into(), seq: 2, compose_time: 2,
            sender: "Leonor GROELL".into(), sender_mri: String::new(), content: "hello".into(), attachments: "[]".into(),
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
        }).unwrap();
        assert_eq!(s.other_party_name("dm", me).unwrap(), None);
        assert_eq!(s.conversations(me).unwrap()[0].display_name, "");
    }

    #[test]
    fn backfill_sender_mri_heals_legacy_rows_only() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 100).unwrap();
        // legacy row: no MRI captured
        s.insert_message(&Message {
            id: "m1".into(), conversation_id: "c1".into(), seq: 1, compose_time: 1,
            sender: "Me".into(), sender_mri: String::new(), content: "hi".into(), attachments: "[]".into(),
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
        }).unwrap();
        // a message without attachments keeps the empty-array default
        s.insert_message(&Message {
            id: "m2".into(), conversation_id: "c1".into(), seq: 2, compose_time: 2,
            sender: "Me".into(), sender_mri: String::new(), content: "hi".into(),
            attachments: "[]".into(),
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
}

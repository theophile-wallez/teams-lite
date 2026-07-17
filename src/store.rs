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
use rusqlite::{params, Connection, Row};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS conversations (
    id                TEXT PRIMARY KEY,
    display_name      TEXT,
    last_message_time INTEGER NOT NULL DEFAULT 0,
    oldest_cursor     TEXT,
    has_more_older    INTEGER NOT NULL DEFAULT 1,
    kind              TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE IF NOT EXISTS messages (
    id              TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 0,
    compose_time    INTEGER NOT NULL DEFAULT 0,
    sender          TEXT,
    sender_mri      TEXT,
    content         TEXT,
    PRIMARY KEY (conversation_id, id)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);
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
    })
}

const SELECT_COLS: &str = "id, conversation_id, seq, compose_time, sender, sender_mri, content";

/// Idempotent, additive migrations for databases created before a column existed.
/// `CREATE TABLE IF NOT EXISTS` never alters an existing table, so older stores
/// miss columns added to SCHEMA. We add them here, ignoring the "duplicate column"
/// error that a fresh store (already carrying the column) returns.
fn migrate(conn: &Connection) -> Result<()> {
    // kind: distinguishes 1:1 / group / notes conversations. Defaults to
    // 'unknown' for legacy rows; the next network sync backfills the real value.
    match conn.execute(
        "ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown'",
        [],
    ) {
        Ok(_) => {}
        // rusqlite surfaces "duplicate column name" when the column already exists
        Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column") => {}
        Err(e) => return Err(e.into()),
    }
    // sender_mri: the sender's MRI, used to reliably tag a message as ours
    // (sender_mri == our own MRI). Legacy rows get NULL; the next network sync
    // backfills it for messages that come through again.
    match conn.execute("ALTER TABLE messages ADD COLUMN sender_mri TEXT", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column") => {}
        Err(e) => return Err(e.into()),
    }
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

    pub fn upsert_conversation(&self, id: &str, display_name: &str, last_message_time: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conversations (id, display_name, last_message_time)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                -- never clobber a known title with an empty one (live events carry no title)
                display_name = CASE
                    WHEN excluded.display_name IS NOT NULL AND excluded.display_name <> ''
                    THEN excluded.display_name ELSE conversations.display_name END,
                last_message_time = MAX(conversations.last_message_time, excluded.last_message_time)",
            params![id, display_name, last_message_time],
        )?;
        Ok(())
    }

    /// Upsert a conversation carrying its `kind`. Only the network sync
    /// (`persist_conversations`) knows this; blind upserts (live events, name
    /// resolution) use `upsert_conversation`, which leaves the kind untouched.
    /// A known kind is never downgraded to `unknown` by a later blank sync.
    pub fn upsert_conversation_full(
        &self,
        id: &str,
        display_name: &str,
        last_message_time: i64,
        kind: ConversationKind,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conversations (id, display_name, last_message_time, kind)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                display_name = CASE
                    WHEN excluded.display_name IS NOT NULL AND excluded.display_name <> ''
                    THEN excluded.display_name ELSE conversations.display_name END,
                last_message_time = MAX(conversations.last_message_time, excluded.last_message_time),
                -- keep a known kind; only overwrite when the new value is meaningful
                kind = CASE
                    WHEN excluded.kind <> 'unknown' THEN excluded.kind
                    ELSE conversations.kind END",
            params![id, display_name, last_message_time, kind.as_str()],
        )?;
        Ok(())
    }

    /// Insert a message, deduplicated by id. Returns true if it was newly inserted.
    pub fn insert_message(&self, m: &Message) -> Result<bool> {
        let n = self.conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, seq, compose_time, sender, sender_mri, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![m.id, m.conversation_id, m.seq, m.compose_time, m.sender, m.sender_mri, m.content],
        )?;
        Ok(n == 1)
    }

    /// Backfill `sender_mri` on an existing row that predates the column (its MRI
    /// is NULL or empty). `insert_message` uses INSERT OR IGNORE, so a re-fetched
    /// message never overwrites the stored row — this heals legacy history so our
    /// own old messages get tagged as ours. No-op when the MRI is already set or
    /// the incoming MRI is empty.
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
                    c.kind
             FROM conversations c
             ORDER BY c.last_message_time DESC, c.id ASC",
        )?;
        let rows = stmt.query_map(params![self_name], |r| {
            Ok(ConversationRow {
                id: r.get(0)?,
                display_name: r.get(1)?,
                last_message_time: r.get(2)?,
                kind: ConversationKind::from_str(&r.get::<_, String>(3)?),
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
        }
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
    fn cursor_roundtrip() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_conversation("c1", "Chat", 0).unwrap();
        assert_eq!(s.oldest_cursor("c1").unwrap(), (None, true));
        s.set_oldest_cursor("c1", Some("cursor-xyz"), false).unwrap();
        assert_eq!(s.oldest_cursor("c1").unwrap(), (Some("cursor-xyz".to_string()), false));
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
        s.upsert_conversation_full("c1", "Chat", 150, ConversationKind::OneOnOne)
            .unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::OneOnOne);

        // a later blank/unknown sync must NOT downgrade a known kind
        s.upsert_conversation_full("c1", "", 200, ConversationKind::Unknown)
            .unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::OneOnOne);

        // but a meaningful kind change is honored
        s.upsert_conversation_full("c1", "", 250, ConversationKind::Group)
            .unwrap();
        assert_eq!(s.conversations("").unwrap()[0].kind, ConversationKind::Group);
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
            sender: me.into(), sender_mri: String::new(), content: "salut".into(),
        }).unwrap();
        s.insert_message(&Message {
            id: "m2".into(), conversation_id: "dm".into(), seq: 2, compose_time: 2,
            sender: "Leonor GROELL".into(), sender_mri: String::new(), content: "hello".into(),
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
            sender: me.into(), sender_mri: String::new(), content: "coucou".into(),
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
            sender: "Me".into(), sender_mri: String::new(), content: "hi".into(),
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
}

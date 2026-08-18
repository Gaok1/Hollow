//! Durable history for servers and direct messages.
//!
//! Hollow has no server to keep anything on, so every member keeps the whole
//! conversation themselves and the copies are reconciled peer to peer. That
//! decision is what this module exists to support: it is not a cache in front of
//! an authority, it *is* the authority, and it has to stay correct when the same
//! message arrives twice, arrives out of order, or arrives months late from
//! someone who was offline the whole time.
//!
//! The trick that makes that cheap is the message identity. A message is
//! `(conversation, author, seq)`, where `seq` counts up per author and never
//! restarts. No shared clock is needed to decide whether we already have
//! something, deduplication is the primary key doing its job, and working out
//! what a peer is missing is one integer comparison per author.
//!
//! `at` is the author's wall clock and is used only to order the transcript for
//! reading. A peer with a wrong clock puts its own lines in the wrong place; it
//! cannot corrupt anyone's history or cause a message to be dropped.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use hollow_steam::SteamId;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// Wall clock in milliseconds, the unit every timestamp here is in.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// What a conversation is for.
///
/// Both kinds share one table and one sync path on purpose: a direct message is
/// a two-person server without a name, and giving it its own storage would mean
/// writing the reconciliation twice and fixing every bug in it twice.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Server,
    Dm,
}

impl ConversationKind {
    fn as_str(self) -> &'static str {
        match self {
            ConversationKind::Server => "server",
            ConversationKind::Dm => "dm",
        }
    }

    fn parse(raw: &str) -> Self {
        match raw {
            "dm" => ConversationKind::Dm,
            _ => ConversationKind::Server,
        }
    }
}

/// The id of a direct message, derived rather than agreed.
///
/// Both ends compute this from the same two ids in the same order, so a DM needs
/// no handshake to exist: the first message to arrive already names the
/// conversation it belongs to, and the receiver reaches the identical string
/// without having been told anything.
pub fn dm_id(a: SteamId, b: SteamId) -> String {
    let (low, high) = if a.raw() <= b.raw() { (a, b) } else { (b, a) };
    format!("dm:{low}:{high}")
}

/// A fresh server id.
///
/// Owner plus creation time is unique without a UUID crate: one account cannot
/// create two servers in the same millisecond, and two accounts cannot collide
/// because their ids differ.
pub fn new_server_id(owner: SteamId) -> String {
    format!("server:{owner}-{}", now_ms())
}

/// A member of a conversation, as it is stored.
///
/// Only the id and a name to fall back on. Avatars and online state are live
/// facts that Steam already knows and that would be stale the moment they were
/// written down, so they are merged in from the friends list on the way to the
/// UI rather than kept here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub id: SteamId,
    pub persona: String,
}

/// A conversation and everyone in it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub kind: ConversationKind,
    pub name: String,
    /// Who created a server. `None` for a direct message, which has no owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<SteamId>,
    pub created_at: i64,
    pub members: Vec<Member>,
}

/// One message, in the shape it takes both on disk and on the wire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub author: SteamId,
    pub seq: u64,
    /// The author's wall clock, in milliseconds. Ordering only — see the module
    /// comment for why it is never trusted for identity.
    pub at: i64,
    pub text: String,
}

/// Where a page of history starts from, reading backwards.
///
/// All three fields, not just the timestamp: a backfill can write a hundred
/// messages carrying the same millisecond, and a cursor that only knows `at`
/// would either repeat that page forever or step over the middle of it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub at: i64,
    pub author: SteamId,
    pub seq: u64,
}

/// What we already hold for a conversation: the highest `seq` seen per author.
///
/// This is the whole sync request. It is proportional to the number of people
/// who have ever spoken, not to the size of the history.
pub type VersionVector = HashMap<SteamId, u64>;

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("cannot create {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("cannot open {}", path.display()))?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    /// An empty database that never touches the disk. Used by the tests.
    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let store = Self {
            conn: Connection::open_in_memory()?,
        };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<()> {
        // WAL so a long read cannot block the write that a newly arrived message
        // is waiting on. `foreign_keys` is left off deliberately: a message from
        // a conversation we have since left is still worth keeping until the
        // conversation itself is deleted, and cascading that automatically has
        // no upside here.
        self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;

             CREATE TABLE IF NOT EXISTS conversations (
               id         TEXT PRIMARY KEY,
               kind       TEXT NOT NULL,
               name       TEXT NOT NULL,
               owner      TEXT,
               created_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS members (
               conversation TEXT    NOT NULL,
               steam_id     TEXT    NOT NULL,
               persona      TEXT    NOT NULL,
               joined_at    INTEGER NOT NULL,
               PRIMARY KEY (conversation, steam_id)
             );

             CREATE TABLE IF NOT EXISTS messages (
               conversation TEXT    NOT NULL,
               author       TEXT    NOT NULL,
               seq          INTEGER NOT NULL,
               at           INTEGER NOT NULL,
               text         TEXT    NOT NULL,
               PRIMARY KEY (conversation, author, seq)
             );

             CREATE INDEX IF NOT EXISTS messages_by_time
               ON messages (conversation, at, author, seq);

             CREATE TABLE IF NOT EXISTS read_state (
               conversation TEXT PRIMARY KEY,
               last_read_at INTEGER NOT NULL
             );",
        )?;
        Ok(())
    }

    // --- conversations ------------------------------------------------------

    pub fn conversations(&self) -> Result<Vec<Conversation>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, name, owner, created_at FROM conversations ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        rows.into_iter()
            .map(|(id, kind, name, owner, created_at)| {
                let members = self.members(&id)?;
                Ok(Conversation {
                    kind: ConversationKind::parse(&kind),
                    name,
                    owner: owner.and_then(|o| o.parse().ok()),
                    created_at,
                    members,
                    id,
                })
            })
            .collect()
    }

    pub fn conversation(&self, id: &str) -> Result<Option<Conversation>> {
        let row = self
            .conn
            .query_row(
                "SELECT kind, name, owner, created_at FROM conversations WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;

        let Some((kind, name, owner, created_at)) = row else {
            return Ok(None);
        };

        Ok(Some(Conversation {
            id: id.to_string(),
            kind: ConversationKind::parse(&kind),
            name,
            owner: owner.and_then(|o| o.parse().ok()),
            created_at,
            members: self.members(id)?,
        }))
    }

    pub fn exists(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM conversations WHERE id = ?1",
                params![id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Record a conversation, leaving an existing name and creation time alone.
    ///
    /// Upsert rather than insert because both ends of a DM open it independently
    /// and an invite can be delivered twice; neither should be an error, and
    /// neither should reset the row to whatever the second caller happened to
    /// pass.
    pub fn upsert_conversation(
        &self,
        id: &str,
        kind: ConversationKind,
        name: &str,
        owner: Option<SteamId>,
        created_at: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO conversations (id, kind, name, owner, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO NOTHING",
            params![
                id,
                kind.as_str(),
                name,
                owner.map(|o| o.to_string()),
                created_at
            ],
        )?;
        Ok(())
    }

    /// Forget a conversation and everything in it.
    ///
    /// Leaving a server is destructive by design. Keeping the transcript of a
    /// room you walked out of, invisible in the UI but sitting on disk, is a
    /// surprise nobody asked for.
    ///
    /// Four statements rather than a transaction: nothing reads a table by
    /// anything but its conversation id, so the worst a crash halfway through
    /// leaves behind is rows belonging to an id that no longer resolves, and
    /// the next delete of the same id finishes the job.
    pub fn remove_conversation(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM messages WHERE conversation = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM members WHERE conversation = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM read_state WHERE conversation = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- members ------------------------------------------------------------

    pub fn members(&self, conversation: &str) -> Result<Vec<Member>> {
        let mut stmt = self.conn.prepare(
            "SELECT steam_id, persona FROM members WHERE conversation = ?1 ORDER BY joined_at",
        )?;
        let members = stmt
            .query_map(params![conversation], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(id, persona)| id.parse().ok().map(|id| Member { id, persona }))
            .collect();
        Ok(members)
    }

    pub fn add_member(&self, conversation: &str, member: &Member) -> Result<()> {
        self.conn.execute(
            "INSERT INTO members (conversation, steam_id, persona, joined_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(conversation, steam_id) DO UPDATE SET persona = excluded.persona",
            params![
                conversation,
                member.id.to_string(),
                member.persona,
                now_ms()
            ],
        )?;
        Ok(())
    }

    pub fn remove_member(&self, conversation: &str, who: SteamId) -> Result<()> {
        self.conn.execute(
            "DELETE FROM members WHERE conversation = ?1 AND steam_id = ?2",
            params![conversation, who.to_string()],
        )?;
        Ok(())
    }

    /// Add everyone in `members`, keeping anyone already recorded.
    ///
    /// Additive rather than a replacement: a peer's idea of the roster can be
    /// older than ours — it may not have heard about the person who joined a
    /// minute ago — and letting a stale list win would silently remove them.
    /// People leave through `remove_member`, which is explicit.
    pub fn merge_members(&self, conversation: &str, members: &[Member]) -> Result<()> {
        for member in members {
            self.add_member(conversation, member)?;
        }
        Ok(())
    }

    /// Everyone we share any conversation with.
    ///
    /// This is what widens the Steam gate: these are the accounts allowed to
    /// open a peer session with us when no call is running.
    pub fn known_peers(&self) -> Result<Vec<SteamId>> {
        let mut stmt = self.conn.prepare("SELECT DISTINCT steam_id FROM members")?;
        let peers = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|id| id.parse().ok())
            .collect();
        Ok(peers)
    }

    // --- messages -----------------------------------------------------------

    /// The number to stamp on our next message in this conversation.
    pub fn next_seq(&self, conversation: &str, author: SteamId) -> Result<u64> {
        let highest: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE conversation = ?1 AND author = ?2",
            params![conversation, author.to_string()],
            |row| row.get(0),
        )?;
        Ok(highest as u64 + 1)
    }

    /// Store one message. Returns false when we already had it.
    ///
    /// The caller uses that answer to decide whether to tell the UI, which is
    /// what keeps a backfill from replaying a conversation the user is already
    /// looking at.
    pub fn insert(&self, conversation: &str, message: &Message) -> Result<bool> {
        let changed = self.conn.execute(
            "INSERT INTO messages (conversation, author, seq, at, text)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(conversation, author, seq) DO NOTHING",
            // `seq` crosses as i64: SQLite has no unsigned integer, and rusqlite
            // refuses the lossy cast rather than silently wrapping it.
            params![
                conversation,
                message.author.to_string(),
                message.seq as i64,
                message.at,
                message.text
            ],
        )?;
        Ok(changed > 0)
    }

    /// The highest `seq` we hold per author.
    pub fn version_vector(&self, conversation: &str) -> Result<VersionVector> {
        let mut stmt = self.conn.prepare(
            "SELECT author, MAX(seq) FROM messages WHERE conversation = ?1 GROUP BY author",
        )?;
        let vector = stmt
            .query_map(params![conversation], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(author, seq)| author.parse().ok().map(|a| (a, seq as u64)))
            .collect();
        Ok(vector)
    }

    /// Everything we hold that `have` does not.
    ///
    /// One indexed range scan per author rather than one clever query: the
    /// primary key is `(conversation, author, seq)`, so `seq > n` for a known
    /// author is a seek and not a scan, and a conversation has a handful of
    /// authors, not thousands. The obvious version is also the fast one here.
    pub fn messages_since(
        &self,
        conversation: &str,
        have: &VersionVector,
        limit: usize,
    ) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, at, text FROM messages
             WHERE conversation = ?1 AND author = ?2 AND seq > ?3
             ORDER BY seq",
        )?;

        let mut out = Vec::new();
        for author in self.authors(conversation)? {
            let floor = have.get(&author).copied().unwrap_or(0) as i64;
            let rows = stmt
                .query_map(params![conversation, author.to_string(), floor], |row| {
                    Ok(Message {
                        author,
                        seq: row.get::<_, i64>(0)? as u64,
                        at: row.get(1)?,
                        text: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out.extend(rows);
        }

        // Oldest first, so a reply never crosses the wire ahead of the line it
        // is replying to even when the answer is truncated.
        out.sort_by(|a, b| {
            a.at.cmp(&b.at)
                .then(a.author.raw().cmp(&b.author.raw()))
                .then(a.seq.cmp(&b.seq))
        });
        out.truncate(limit);
        Ok(out)
    }

    fn authors(&self, conversation: &str) -> Result<Vec<SteamId>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT author FROM messages WHERE conversation = ?1")?;
        let authors = stmt
            .query_map(params![conversation], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|a| a.parse().ok())
            .collect();
        Ok(authors)
    }

    /// One page of transcript, newest first, ending just before `before`.
    ///
    /// Returned oldest-first so the caller can render it directly.
    pub fn history(
        &self,
        conversation: &str,
        before: Option<Cursor>,
        limit: usize,
    ) -> Result<Vec<Message>> {
        let mut stmt = self.conn.prepare(
            "SELECT author, seq, at, text FROM messages
             WHERE conversation = ?1
               AND (?2 IS NULL OR (at, author, seq) < (?2, ?3, ?4))
             ORDER BY at DESC, author DESC, seq DESC
             LIMIT ?5",
        )?;

        let mut page = stmt
            .query_map(
                params![
                    conversation,
                    before.map(|c| c.at),
                    before.map(|c| c.author.to_string()),
                    before.map(|c| c.seq as i64),
                    limit as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(author, seq, at, text)| {
                author.parse().ok().map(|author| Message {
                    author,
                    seq: seq as u64,
                    at,
                    text,
                })
            })
            .collect::<Vec<_>>();

        page.reverse();
        Ok(page)
    }

    // --- read state ---------------------------------------------------------

    /// How many messages from other people arrived since this was last read.
    pub fn unread(&self, conversation: &str, me: SteamId) -> Result<u64> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages
             WHERE conversation = ?1
               AND author <> ?2
               AND at > COALESCE(
                     (SELECT last_read_at FROM read_state WHERE conversation = ?1), 0)",
            params![conversation, me.to_string()],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    pub fn mark_read(&self, conversation: &str, at: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO read_state (conversation, last_read_at) VALUES (?1, ?2)
             ON CONFLICT(conversation) DO UPDATE SET
               last_read_at = MAX(last_read_at, excluded.last_read_at)",
            params![conversation, at],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: SteamId = SteamId(1);
    const BOB: SteamId = SteamId(2);

    fn msg(author: SteamId, seq: u64, at: i64, text: &str) -> Message {
        Message {
            author,
            seq,
            at,
            text: text.into(),
        }
    }

    fn seeded() -> Store {
        let store = Store::in_memory().unwrap();
        store
            .upsert_conversation("server:1-0", ConversationKind::Server, "Test", Some(ALICE), 0)
            .unwrap();
        store
    }

    #[test]
    fn dm_id_is_the_same_from_both_ends() {
        assert_eq!(dm_id(ALICE, BOB), dm_id(BOB, ALICE));
        assert_eq!(dm_id(ALICE, BOB), "dm:1:2");
    }

    #[test]
    fn the_same_message_twice_is_stored_once() {
        let store = seeded();
        let message = msg(ALICE, 1, 100, "hello");

        assert!(store.insert("server:1-0", &message).unwrap());
        // A backfill from two peers delivers the same line twice. The second
        // must be silent, not an error and not a duplicate on screen.
        assert!(!store.insert("server:1-0", &message).unwrap());

        assert_eq!(store.history("server:1-0", None, 50).unwrap().len(), 1);
    }

    #[test]
    fn seq_counts_up_per_author() {
        let store = seeded();
        assert_eq!(store.next_seq("server:1-0", ALICE).unwrap(), 1);

        store.insert("server:1-0", &msg(ALICE, 1, 100, "a")).unwrap();
        assert_eq!(store.next_seq("server:1-0", ALICE).unwrap(), 2);
        // Bob's counter is his own; Alice speaking does not advance it.
        assert_eq!(store.next_seq("server:1-0", BOB).unwrap(), 1);
    }

    #[test]
    fn version_vector_reports_the_high_water_mark() {
        let store = seeded();
        for seq in 1..=3 {
            store
                .insert("server:1-0", &msg(ALICE, seq, seq as i64, "a"))
                .unwrap();
        }
        store.insert("server:1-0", &msg(BOB, 1, 10, "b")).unwrap();

        let vector = store.version_vector("server:1-0").unwrap();
        assert_eq!(vector.get(&ALICE), Some(&3));
        assert_eq!(vector.get(&BOB), Some(&1));
    }

    #[test]
    fn messages_since_sends_only_what_the_peer_lacks() {
        let store = seeded();
        for seq in 1..=3 {
            store
                .insert("server:1-0", &msg(ALICE, seq, seq as i64 * 10, "a"))
                .unwrap();
        }
        store.insert("server:1-0", &msg(BOB, 1, 5, "b")).unwrap();

        // A peer that has Alice up to 2 and has never heard of Bob.
        let mut have = VersionVector::new();
        have.insert(ALICE, 2);

        let missing = store.messages_since("server:1-0", &have, 50).unwrap();
        assert_eq!(missing.len(), 2);
        // Oldest first: Bob's line at 5 precedes Alice's third at 30.
        assert_eq!(missing[0].author, BOB);
        assert_eq!(missing[1], msg(ALICE, 3, 30, "a"));
    }

    #[test]
    fn a_caught_up_peer_is_sent_nothing() {
        let store = seeded();
        store.insert("server:1-0", &msg(ALICE, 1, 10, "a")).unwrap();

        let have = store.version_vector("server:1-0").unwrap();
        assert!(store.messages_since("server:1-0", &have, 50).unwrap().is_empty());
    }

    #[test]
    fn history_pages_backwards_through_a_tied_timestamp() {
        let store = seeded();
        // A backfill writing a whole conversation at once: every line carries
        // the same millisecond. A cursor that only knew `at` would loop here.
        for seq in 1..=5 {
            store
                .insert("server:1-0", &msg(ALICE, seq, 42, &format!("line {seq}")))
                .unwrap();
        }

        // A page comes back oldest-first, so the last entry is the newest of it.
        let newest = store.history("server:1-0", None, 2).unwrap();
        assert_eq!(newest.len(), 2);
        assert_eq!((newest[0].seq, newest[1].seq), (4, 5));

        let cursor = Cursor {
            at: newest[0].at,
            author: newest[0].author,
            seq: newest[0].seq,
        };
        let older = store.history("server:1-0", Some(cursor), 2).unwrap();
        assert_eq!((older[0].seq, older[1].seq), (2, 3));
        // The point of the test: no line is served twice and none is skipped,
        // even though every one of them shares a timestamp.
        assert!(older.iter().all(|m| m.seq < newest[0].seq));
    }

    #[test]
    fn unread_ignores_our_own_messages() {
        let store = seeded();
        store.insert("server:1-0", &msg(BOB, 1, 100, "hi")).unwrap();
        store.insert("server:1-0", &msg(ALICE, 1, 200, "hi back")).unwrap();

        assert_eq!(store.unread("server:1-0", ALICE).unwrap(), 1);

        store.mark_read("server:1-0", 200).unwrap();
        assert_eq!(store.unread("server:1-0", ALICE).unwrap(), 0);

        store.insert("server:1-0", &msg(BOB, 2, 300, "still here")).unwrap();
        assert_eq!(store.unread("server:1-0", ALICE).unwrap(), 1);
    }

    #[test]
    fn a_stale_roster_cannot_remove_anyone() {
        let store = seeded();
        store
            .merge_members(
                "server:1-0",
                &[
                    Member { id: ALICE, persona: "Alice".into() },
                    Member { id: BOB, persona: "Bob".into() },
                ],
            )
            .unwrap();

        // A peer who has not yet heard that Bob joined sends its older list.
        store
            .merge_members("server:1-0", &[Member { id: ALICE, persona: "Alice".into() }])
            .unwrap();

        assert_eq!(store.members("server:1-0").unwrap().len(), 2);
    }

    #[test]
    fn leaving_takes_the_transcript_with_it() {
        let store = seeded();
        store.insert("server:1-0", &msg(ALICE, 1, 10, "a")).unwrap();
        store
            .add_member("server:1-0", &Member { id: ALICE, persona: "Alice".into() })
            .unwrap();

        store.remove_conversation("server:1-0").unwrap();

        assert!(!store.exists("server:1-0").unwrap());
        assert!(store.history("server:1-0", None, 50).unwrap().is_empty());
        assert!(store.members("server:1-0").unwrap().is_empty());
    }
}

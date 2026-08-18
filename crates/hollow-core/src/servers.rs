//! Servers and direct messages, and keeping their transcripts in step.
//!
//! There is no server behind Hollow's servers. A server is a row in everyone's
//! local database and nothing else, which means the interesting problem is not
//! storing a message but agreeing on the set of them — and doing it without any
//! participant being authoritative, without a shared clock, and while people
//! come and go at random.
//!
//! The scheme is anti-entropy over a version vector. Everyone tracks the highest
//! `seq` they hold per author; to catch up with a peer you send yours and they
//! send back whatever exceeds it. It converges no matter what order anything
//! arrives in, costs one small message per conversation per peer coming online,
//! and needs nobody to be in charge.
//!
//! Its one real limitation is worth stating plainly, because the UI has to say
//! it too: a message only reaches you while somebody who already holds it is
//! online at the same time as you. Two people who are never online together
//! never sync. That is the price of having nothing in the middle, and it is not
//! a bug to be fixed later without adding one.

use std::collections::{HashMap, HashSet};

use anyhow::{Result, anyhow};
use hollow_steam::{Channel, Peer, PersonaState, SteamCommand, SteamId};
use serde_json::{Value, json};

use crate::protocol::ServerFrame;
use crate::rpc::Sink;
use crate::store::{
    Conversation, ConversationKind, Cursor, Member, Message, Store, VersionVector, dm_id,
    new_server_id, now_ms,
};

/// How much transcript one page of scrollback carries.
const HISTORY_PAGE: usize = 50;

/// The most messages one sync answer will carry.
///
/// A cap rather than the whole backlog: Steam's reliable messages have a size
/// limit, and someone returning after a month should get the recent
/// conversation immediately and the rest as they scroll, not one enormous frame
/// that fails to send at all.
const SYNC_BATCH: usize = 200;

pub struct Servers {
    store: Store,
    me: Peer,
    /// Live calls per conversation, learned from peers and never written down.
    /// A lobby id is meaningless once the lobby is gone, so persisting it would
    /// only produce a "join" button that leads nowhere after a restart.
    calls: HashMap<String, SteamId>,
    /// Invites announced to the UI and awaiting a decision.
    pending: HashMap<String, ServerFrame>,
}

impl Servers {
    pub fn new(store: Store, me: Peer) -> Self {
        Self {
            store,
            me,
            calls: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    pub fn set_me(&mut self, me: Peer) {
        self.me = me;
    }

    fn my_member(&self) -> Member {
        Member {
            id: self.me.id,
            persona: self.me.persona.clone(),
        }
    }

    // --- what the UI sees ---------------------------------------------------

    /// Every conversation, with live Steam facts merged over the stored ones.
    pub fn list(&self, friends: &[Peer]) -> Result<Value> {
        let conversations = self.store.conversations()?;
        let mut out = Vec::with_capacity(conversations.len());
        for conversation in conversations {
            out.push(self.describe(&conversation, friends)?);
        }
        Ok(Value::Array(out))
    }

    fn describe(&self, conversation: &Conversation, friends: &[Peer]) -> Result<Value> {
        let members: Vec<Peer> = conversation
            .members
            .iter()
            .map(|m| self.enrich(m, friends))
            .collect();

        Ok(json!({
            "id": conversation.id,
            "kind": conversation.kind,
            "name": self.display_name(conversation, &members),
            "owner": conversation.owner,
            "createdAt": conversation.created_at,
            "members": members,
            "unread": self.store.unread(&conversation.id, self.me.id)?,
            "call": self.calls.get(&conversation.id),
        }))
    }

    /// A direct message is named after the other person, not after a row in the
    /// database: personas change, and a DM titled with last year's nickname is
    /// a small daily annoyance nobody should have to fix by hand.
    fn display_name(&self, conversation: &Conversation, members: &[Peer]) -> String {
        if conversation.kind == ConversationKind::Dm
            && let Some(other) = members.iter().find(|p| p.id != self.me.id)
        {
            return other.persona.clone();
        }
        conversation.name.clone()
    }

    /// Merge a stored member with what Steam knows right now.
    ///
    /// The database holds a name to fall back on and nothing else; avatars and
    /// online state come from the friends list, which is the only place they are
    /// ever current.
    fn enrich(&self, member: &Member, friends: &[Peer]) -> Peer {
        if member.id == self.me.id {
            return self.me.clone();
        }
        if let Some(friend) = friends.iter().find(|f| f.id == member.id) {
            return friend.clone();
        }
        Peer {
            id: member.id,
            persona: member.persona.clone(),
            state: PersonaState::Offline,
            avatar: None,
            in_hollow: false,
        }
    }

    pub fn history(&self, conversation: &str, before: Option<Cursor>) -> Result<Value> {
        let page = self.store.history(conversation, before, HISTORY_PAGE)?;
        Ok(json!({
            "conversation": conversation,
            "messages": page,
            // Short page means the top; the UI stops asking for more.
            "exhausted": page.len() < HISTORY_PAGE,
        }))
    }

    pub fn mark_read(&self, conversation: &str, at: i64) -> Result<()> {
        self.store.mark_read(conversation, at)
    }

    /// Everyone we share a conversation with, for the Steam gate.
    pub fn known_peers(&self) -> Result<Vec<SteamId>> {
        self.store.known_peers()
    }

    // --- creating and joining -----------------------------------------------

    pub fn create(&mut self, name: &str) -> Result<String> {
        let id = new_server_id(self.me.id);
        self.store.upsert_conversation(
            &id,
            ConversationKind::Server,
            name,
            Some(self.me.id),
            now_ms(),
        )?;
        self.store.add_member(&id, &self.my_member())?;
        Ok(id)
    }

    /// Open — or re-open — the direct message with one person.
    ///
    /// Idempotent, because the id is derived from the two accounts rather than
    /// allocated: asking twice returns the same conversation with its history
    /// intact.
    pub fn open_dm(&mut self, other: &Peer) -> Result<String> {
        if other.id == self.me.id {
            return Err(anyhow!("there is no direct message with yourself"));
        }
        let id = dm_id(self.me.id, other.id);
        self.store.upsert_conversation(
            &id,
            ConversationKind::Dm,
            &other.persona,
            None,
            now_ms(),
        )?;
        self.store.add_member(&id, &self.my_member())?;
        self.store.add_member(
            &id,
            &Member {
                id: other.id,
                persona: other.persona.clone(),
            },
        )?;
        Ok(id)
    }

    pub fn invite(
        &self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        conversation: &str,
        to: SteamId,
    ) -> Result<()> {
        let record = self
            .store
            .conversation(conversation)?
            .ok_or_else(|| anyhow!("no such server"))?;
        if record.kind != ConversationKind::Server {
            return Err(anyhow!("a direct message cannot be invited to"));
        }

        send(
            steam,
            to,
            &ServerFrame::Invite {
                conversation: record.id,
                name: record.name,
                owner: record.owner.unwrap_or(self.me.id),
                created_at: record.created_at,
                members: record.members,
            },
        )
    }

    pub async fn accept_invite(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        conversation: &str,
    ) -> Result<()> {
        let invite = self
            .pending
            .remove(conversation)
            .ok_or_else(|| anyhow!("no pending invite for {conversation}"))?;

        let ServerFrame::Invite {
            conversation,
            name,
            owner,
            created_at,
            members,
        } = invite
        else {
            return Err(anyhow!("that invite was not an invite"));
        };

        self.store.upsert_conversation(
            &conversation,
            ConversationKind::Server,
            &name,
            Some(owner),
            created_at,
        )?;
        self.store.merge_members(&conversation, &members)?;
        self.store.add_member(&conversation, &self.my_member())?;

        // Tell everyone already inside, then ask them for the backlog. Both are
        // best-effort: whoever is offline finds out at their next sync.
        let me = self.my_member();
        for member in self.others(&conversation)? {
            let _ = send(
                steam,
                member,
                &ServerFrame::Joined {
                    conversation: conversation.clone(),
                    member: me.clone(),
                },
            );
        }
        self.sync_conversation(steam, &conversation)?;

        sink.emit("conv.changed", json!({ "id": conversation })).await;
        Ok(())
    }

    pub fn decline_invite(&mut self, conversation: &str) -> Result<()> {
        self.pending
            .remove(conversation)
            .map(|_| ())
            .ok_or_else(|| anyhow!("no pending invite for {conversation}"))
    }

    pub fn leave(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        conversation: &str,
    ) -> Result<()> {
        for member in self.others(conversation)? {
            let _ = send(
                steam,
                member,
                &ServerFrame::Left {
                    conversation: conversation.to_string(),
                    member: self.me.id,
                },
            );
        }
        self.calls.remove(conversation);
        self.store.remove_conversation(conversation)
    }

    // --- messages -----------------------------------------------------------

    pub async fn post(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        conversation: &str,
        text: &str,
    ) -> Result<Message> {
        if text.is_empty() {
            return Err(anyhow!("a message needs some text"));
        }
        if !self.store.exists(conversation)? {
            return Err(anyhow!("no such conversation: {conversation}"));
        }

        let message = Message {
            author: self.me.id,
            seq: self.store.next_seq(conversation, self.me.id)?,
            at: now_ms(),
            text: text.to_string(),
        };
        self.store.insert(conversation, &message)?;

        // Written first, sent second. A message that reached nobody is still
        // ours and still has to survive; the sync will deliver it the moment
        // anyone is reachable.
        for member in self.others(conversation)? {
            let _ = send(
                steam,
                member,
                &ServerFrame::Post {
                    conversation: conversation.to_string(),
                    message: message.clone(),
                },
            );
        }

        sink.emit(
            "conv.message",
            json!({ "conversation": conversation, "message": message }),
        )
        .await;
        Ok(message)
    }

    // --- calls --------------------------------------------------------------

    pub fn call(&self, conversation: &str) -> Option<SteamId> {
        self.calls.get(conversation).copied()
    }

    /// Announce that a call is running here, and remember it locally.
    pub fn announce_call(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        conversation: &str,
        lobby: Option<SteamId>,
    ) -> Result<()> {
        let frame = match lobby {
            Some(lobby) => {
                self.calls.insert(conversation.to_string(), lobby);
                ServerFrame::CallStarted {
                    conversation: conversation.to_string(),
                    lobby,
                }
            }
            None => {
                self.calls.remove(conversation);
                ServerFrame::CallEnded {
                    conversation: conversation.to_string(),
                }
            }
        };

        for member in self.others(conversation)? {
            let _ = send(steam, member, &frame);
        }
        Ok(())
    }

    /// Which conversation, if any, a lobby belongs to.
    pub fn conversation_for_lobby(&self, lobby: SteamId) -> Option<String> {
        self.calls
            .iter()
            .find(|(_, id)| **id == lobby)
            .map(|(conversation, _)| conversation.clone())
    }

    // --- sync ---------------------------------------------------------------

    /// Ask one peer for anything we are missing, in every conversation we share.
    pub fn sync_with(
        &self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        peer: SteamId,
    ) -> Result<()> {
        for conversation in self.store.conversations()? {
            if !conversation.members.iter().any(|m| m.id == peer) {
                continue;
            }
            let have = self.store.version_vector(&conversation.id)?;
            let _ = send(
                steam,
                peer,
                &ServerFrame::Sync {
                    conversation: conversation.id,
                    have: have.into_iter().collect(),
                },
            );
        }
        Ok(())
    }

    /// Ask everyone in one conversation for anything we are missing.
    fn sync_conversation(
        &self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        conversation: &str,
    ) -> Result<()> {
        let have: Vec<(SteamId, u64)> = self
            .store
            .version_vector(conversation)?
            .into_iter()
            .collect();
        for member in self.others(conversation)? {
            let _ = send(
                steam,
                member,
                &ServerFrame::Sync {
                    conversation: conversation.to_string(),
                    have: have.clone(),
                },
            );
        }
        Ok(())
    }

    // --- inbound ------------------------------------------------------------

    /// Handle one frame from a peer.
    ///
    /// Every arm answers the same question first: is the sender someone we
    /// already share this conversation with? The Steam gate has established
    /// they are a friend or a fellow member of *something*, which is not the
    /// same as being entitled to write into *this*.
    pub async fn handle(
        &mut self,
        steam: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        from: SteamId,
        frame: ServerFrame,
    ) -> Result<()> {
        match frame {
            ServerFrame::Invite { .. } => {
                let ServerFrame::Invite {
                    ref conversation,
                    ref name,
                    ..
                } = frame
                else {
                    unreachable!()
                };
                // Already in it: an invite sent twice, or sent by two people.
                if self.store.exists(conversation)? {
                    return Ok(());
                }
                let (id, name) = (conversation.clone(), name.clone());
                self.pending.insert(id.clone(), frame);
                sink.emit(
                    "server.invite",
                    json!({ "id": id, "name": name, "from": from.to_string() }),
                )
                .await;
            }

            ServerFrame::Joined {
                conversation,
                member,
            } => {
                // Someone announcing *themselves* is the one case where the
                // sender cannot already be in our roster — that is the whole
                // content of the message. Requiring membership here would drop
                // every genuine join and leave the newcomer invisible to
                // everyone who had not been told about them some other way.
                //
                // What is still required is that we are in this conversation
                // ourselves: the id is only known to its members, so this is not
                // a way into anyone's database.
                let announcing_self = from == member.id;
                if !self.store.exists(&conversation)?
                    || !(announcing_self || self.is_member(&conversation, from)?)
                {
                    return Ok(());
                }
                self.store.add_member(&conversation, &member)?;
                sink.emit("conv.changed", json!({ "id": conversation })).await;
            }

            ServerFrame::Left {
                conversation,
                member,
            } => {
                // Only ever about themselves. Otherwise anyone in a server could
                // evict anyone else from everyone's copy of the roster.
                if from != member || !self.is_member(&conversation, from)? {
                    return Ok(());
                }
                self.store.remove_member(&conversation, member)?;
                sink.emit("conv.changed", json!({ "id": conversation })).await;
            }

            ServerFrame::Post {
                conversation,
                message,
            } => {
                if message.author != from {
                    return Ok(());
                }
                if !self.admit(&conversation, from)? {
                    return Ok(());
                }
                // Silent when we already had it: a message can arrive both as a
                // push and in a sync answer, and the user should see one line.
                if self.store.insert(&conversation, &message)? {
                    sink.emit(
                        "conv.message",
                        json!({ "conversation": conversation, "message": message }),
                    )
                    .await;
                }
            }

            ServerFrame::Sync { conversation, have } => {
                if !self.is_member(&conversation, from)? {
                    return Ok(());
                }
                let have: VersionVector = have.into_iter().collect();
                let messages = self.store.messages_since(&conversation, &have, SYNC_BATCH)?;
                let members = self.store.members(&conversation)?;
                send(
                    steam,
                    from,
                    &ServerFrame::SyncReply {
                        conversation: conversation.clone(),
                        messages,
                        members,
                        call: self.calls.get(&conversation).copied(),
                    },
                )?;
            }

            ServerFrame::SyncReply {
                conversation,
                messages,
                members,
                call,
            } => {
                if !self.is_member(&conversation, from)? {
                    return Ok(());
                }
                self.store.merge_members(&conversation, &members)?;

                let mut fresh = Vec::new();
                for message in messages {
                    if self.store.insert(&conversation, &message)? {
                        fresh.push(message);
                    }
                }
                if let Some(lobby) = call {
                    self.calls.insert(conversation.clone(), lobby);
                }

                // One event for the whole backfill rather than one per line: a
                // week of catching up should redraw the conversation once.
                sink.emit(
                    "conv.synced",
                    json!({
                        "conversation": conversation,
                        "messages": fresh,
                        "call": call,
                    }),
                )
                .await;
            }

            ServerFrame::CallStarted {
                conversation,
                lobby,
            } => {
                if !self.is_member(&conversation, from)? {
                    return Ok(());
                }
                self.calls.insert(conversation.clone(), lobby);
                sink.emit(
                    "server.call",
                    json!({ "conversation": conversation, "lobby": lobby }),
                )
                .await;
            }

            ServerFrame::CallEnded { conversation } => {
                if !self.is_member(&conversation, from)? {
                    return Ok(());
                }
                self.calls.remove(&conversation);
                sink.emit(
                    "server.call",
                    json!({ "conversation": conversation, "lobby": Value::Null }),
                )
                .await;
            }
        }
        Ok(())
    }

    // --- helpers ------------------------------------------------------------

    fn is_member(&self, conversation: &str, who: SteamId) -> Result<bool> {
        Ok(self
            .store
            .members(conversation)?
            .iter()
            .any(|m| m.id == who))
    }

    /// Like [`Self::is_member`], but opens a direct message on first contact.
    ///
    /// A DM has no invite step: its id names both accounts, so a message
    /// arriving for `dm:<them>:<me>` from one of those two accounts is
    /// self-authorising and self-describing. Anything else is refused, which
    /// keeps this from being a way to conjure conversations on someone's disk.
    fn admit(&mut self, conversation: &str, from: SteamId) -> Result<bool> {
        if self.is_member(conversation, from)? {
            return Ok(true);
        }
        if self.store.exists(conversation)? {
            return Ok(false);
        }
        if conversation != dm_id(self.me.id, from) {
            return Ok(false);
        }

        self.store.upsert_conversation(
            conversation,
            ConversationKind::Dm,
            &format!("User {from}"),
            None,
            now_ms(),
        )?;
        self.store.add_member(conversation, &self.my_member())?;
        self.store.add_member(
            conversation,
            &Member {
                id: from,
                persona: format!("User {from}"),
            },
        )?;
        Ok(true)
    }

    /// Everyone in a conversation except us.
    fn others(&self, conversation: &str) -> Result<Vec<SteamId>> {
        Ok(self
            .store
            .members(conversation)?
            .into_iter()
            .map(|m| m.id)
            .filter(|id| *id != self.me.id)
            .collect())
    }
}

/// Who among `friends` just became reachable.
///
/// Sync is driven by this rather than by a timer: a peer coming online is the
/// only moment at which asking them for the backlog can succeed, and asking on
/// a schedule instead would mean either missing them or waking the network up
/// for nothing all day.
pub fn newly_online(previous: &HashSet<SteamId>, friends: &[Peer]) -> Vec<SteamId> {
    friends
        .iter()
        .filter(|f| f.state.is_online() && !previous.contains(&f.id))
        .map(|f| f.id)
        .collect()
}

pub fn online_ids(friends: &[Peer]) -> HashSet<SteamId> {
    friends
        .iter()
        .filter(|f| f.state.is_online())
        .map(|f| f.id)
        .collect()
}

fn send(
    steam: &crossbeam_channel::Sender<SteamCommand>,
    to: SteamId,
    frame: &ServerFrame,
) -> Result<()> {
    let payload = serde_json::to_vec(frame)?;
    steam
        .send(SteamCommand::Send {
            to,
            channel: Channel::Servers,
            payload,
        })
        .map_err(|_| anyhow!("steam thread is gone"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: u64, persona: &str, state: PersonaState) -> Peer {
        Peer {
            id: SteamId(id),
            persona: persona.into(),
            state,
            avatar: None,
            in_hollow: false,
        }
    }

    #[test]
    fn only_the_transition_to_online_triggers_a_sync() {
        let friends = vec![
            peer(1, "Alice", PersonaState::Online),
            peer(2, "Bob", PersonaState::Offline),
        ];

        // First look: everyone already online counts as newly reachable, which
        // is what makes a cold start ask for the backlog.
        let none = HashSet::new();
        assert_eq!(newly_online(&none, &friends), vec![SteamId(1)]);

        // Second look with nothing changed: nobody, so no repeated asking.
        let seen = online_ids(&friends);
        assert!(newly_online(&seen, &friends).is_empty());

        let friends = vec![
            peer(1, "Alice", PersonaState::Online),
            peer(2, "Bob", PersonaState::Online),
        ];
        assert_eq!(newly_online(&seen, &friends), vec![SteamId(2)]);
    }

    fn servers_for(me: u64) -> Servers {
        Servers::new(
            Store::in_memory().unwrap(),
            peer(me, "Me", PersonaState::Online),
        )
    }

    #[test]
    fn a_dm_opens_itself_on_first_contact() {
        let mut servers = servers_for(10);
        let id = dm_id(SteamId(10), SteamId(20));

        assert!(servers.admit(&id, SteamId(20)).unwrap());
        assert!(servers.store.exists(&id).unwrap());
        assert_eq!(servers.store.members(&id).unwrap().len(), 2);
    }

    #[test]
    fn a_stranger_cannot_conjure_a_conversation() {
        let mut servers = servers_for(10);

        // A DM id that does not name us.
        let not_ours = dm_id(SteamId(20), SteamId(30));
        assert!(!servers.admit(&not_ours, SteamId(20)).unwrap());
        assert!(!servers.store.exists(&not_ours).unwrap());

        // A DM between us and someone else, pushed by a third party.
        let ours = dm_id(SteamId(10), SteamId(20));
        assert!(!servers.admit(&ours, SteamId(30)).unwrap());
        assert!(!servers.store.exists(&ours).unwrap());

        // And a server id, which always needs a real invite.
        assert!(!servers.admit("server:99-1", SteamId(20)).unwrap());
        assert!(!servers.store.exists("server:99-1").unwrap());
    }

    #[test]
    fn a_dm_is_named_after_the_other_person() {
        let mut servers = servers_for(10);
        let them = peer(20, "Bob", PersonaState::Online);
        let id = servers.open_dm(&them).unwrap();

        let listed = servers.list(std::slice::from_ref(&them)).unwrap();
        let entry = &listed.as_array().unwrap()[0];
        assert_eq!(entry["id"], id);
        assert_eq!(entry["name"], "Bob");

        // Renamed on Steam: the DM follows, because the name is never stored.
        let renamed = peer(20, "Roberto", PersonaState::Online);
        let listed = servers.list(&[renamed]).unwrap();
        assert_eq!(listed.as_array().unwrap()[0]["name"], "Roberto");
    }

    /// Move whatever one side has queued for Steam into the other side.
    ///
    /// Only the `Servers` channel, and only frames — the point is to exercise
    /// the real wire format, not a shortcut around it.
    async fn pump(
        outbox: &crossbeam_channel::Receiver<SteamCommand>,
        into: &mut Servers,
        into_outbox: &crossbeam_channel::Sender<SteamCommand>,
        sink: &Sink,
        sender: SteamId,
    ) {
        while let Ok(command) = outbox.try_recv() {
            let SteamCommand::Send {
                channel: Channel::Servers,
                payload,
                ..
            } = command
            else {
                continue;
            };
            let frame: ServerFrame = serde_json::from_slice(&payload).unwrap();
            into.handle(into_outbox, sink, sender, frame).await.unwrap();
        }
    }

    /// The property the whole feature rests on, end to end and over real frames:
    /// somebody who was away comes back and ends up holding everything that was
    /// said while they were gone, exactly once.
    #[tokio::test]
    async fn a_peer_who_was_offline_catches_up_completely() {
        let (alice_out, alice_in) = crossbeam_channel::unbounded();
        let (bob_out, bob_in) = crossbeam_channel::unbounded();
        let sink = Sink::new();
        let (alice_id, bob_id) = (SteamId(1), SteamId(2));

        let mut alice = servers_for(1);
        let mut bob = servers_for(2);

        // Alice makes a server and invites Bob, who accepts.
        let conversation = alice.create("Test").unwrap();
        alice.invite(&alice_out, &conversation, bob_id).unwrap();
        pump(&alice_in, &mut bob, &bob_out, &sink, alice_id).await;
        bob.accept_invite(&bob_out, &sink, &conversation)
            .await
            .unwrap();

        // Bob's arrival, and his first sync, reach Alice.
        pump(&bob_in, &mut alice, &alice_out, &sink, bob_id).await;
        assert!(
            alice.is_member(&conversation, bob_id).unwrap(),
            "a newcomer announcing themselves must land in everyone's roster"
        );
        pump(&alice_in, &mut bob, &bob_out, &sink, alice_id).await;

        // Bob goes offline: Alice keeps talking and nothing is delivered.
        for line in ["one", "two", "three"] {
            alice
                .post(&alice_out, &sink, &conversation, line)
                .await
                .unwrap();
        }
        while alice_in.try_recv().is_ok() {}

        assert!(
            bob.store.history(&conversation, None, 50).unwrap().is_empty(),
            "nothing should have reached Bob while he was away"
        );

        // Bob comes back and asks.
        bob.sync_with(&bob_out, alice_id).unwrap();
        pump(&bob_in, &mut alice, &alice_out, &sink, bob_id).await;
        pump(&alice_in, &mut bob, &bob_out, &sink, alice_id).await;

        let caught_up = bob.store.history(&conversation, None, 50).unwrap();
        assert_eq!(
            caught_up.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
            ["one", "two", "three"],
        );

        // Asking again changes nothing — the second copy of every line is
        // recognised and dropped rather than shown twice.
        bob.sync_with(&bob_out, alice_id).unwrap();
        pump(&bob_in, &mut alice, &alice_out, &sink, bob_id).await;
        pump(&alice_in, &mut bob, &bob_out, &sink, alice_id).await;
        assert_eq!(bob.store.history(&conversation, None, 50).unwrap().len(), 3);

        // And it converges both ways: Bob replies, Alice hears it.
        bob.post(&bob_out, &sink, &conversation, "four")
            .await
            .unwrap();
        pump(&bob_in, &mut alice, &alice_out, &sink, bob_id).await;
        let alice_side = alice.store.history(&conversation, None, 50).unwrap();
        assert_eq!(alice_side.len(), 4);
        assert_eq!(alice_side[3].text, "four");
    }

    #[test]
    fn opening_the_same_dm_twice_keeps_its_history() {
        let mut servers = servers_for(10);
        let them = peer(20, "Bob", PersonaState::Online);

        let first = servers.open_dm(&them).unwrap();
        servers
            .store
            .insert(
                &first,
                &Message {
                    author: SteamId(20),
                    seq: 1,
                    at: 100,
                    text: "hello".into(),
                },
            )
            .unwrap();

        let second = servers.open_dm(&them).unwrap();
        assert_eq!(first, second);
        assert_eq!(servers.store.history(&first, None, 50).unwrap().len(), 1);
    }
}

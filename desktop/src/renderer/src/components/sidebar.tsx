import { useMemo, useState, type DragEvent } from 'react'
import { useStore } from '../store'
import type { Conversation, Peer } from '../types'
import { FileSendIcon, PlusIcon, RefreshIcon, SteamIcon } from './icons'

/** Steam avatars are not always available; fall back to an initial. */
function Avatar({ peer, size = 32 }: { peer: Peer; size?: number }) {
  if (peer.avatar) {
    return (
      <img
        className="avatar"
        src={peer.avatar}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <div className="avatar avatar--fallback" style={{ width: size, height: size }}>
      {peer.persona.slice(0, 1).toUpperCase()}
    </div>
  )
}

export { Avatar }

/**
 * Send files to one person by dropping them on their row.
 *
 * The paths come from Electron, not the browser: the daemon streams the file
 * off disk itself, so reading it into the page first would be gigabytes of
 * pure waste. This works with no call running, which is the point — it is what
 * Hollow did before it could do anything else.
 */
function usePeerDrop(peerId: string) {
  const sendFiles = useStore((s) => s.sendFiles)
  const [over, setOver] = useState(false)

  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        event.stopPropagation()
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent<HTMLElement>) => {
        event.preventDefault()
        // Otherwise the drop also reaches the call behind this row and the file
        // goes to everyone as well as to the person it was aimed at.
        event.stopPropagation()
        setOver(false)
        const paths = [...event.dataTransfer.files]
          .map((file) => window.hollow.getFilePath(file))
          .filter(Boolean)
        if (paths.length > 0) void sendFiles(peerId, paths)
      },
    },
  }
}

function FriendRow({ peer }: { peer: Peer }) {
  const room = useStore((s) => s.room)
  const inviteFriend = useStore((s) => s.inviteFriend)
  const openDm = useStore((s) => s.openDm)
  const sendFilesTo = useStore((s) => s.sendFilesTo)
  const [busy, setBusy] = useState(false)
  const { over, handlers } = usePeerDrop(peer.id)

  const invite = async () => {
    setBusy(true)
    try {
      await inviteFriend(peer.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`friend ${over ? 'friend--drop' : ''}`} {...handlers}>
      <button className="friend__identity" onClick={() => void openDm(peer.id)} title="Open chat">
        <div className="friend__avatar">
          <Avatar peer={peer} />
          <span className={`dot dot--${peer.state}`} aria-hidden />
        </div>
        <div className="friend__text">
          <span className="friend__name">{peer.persona}</span>
          <span className="friend__state">
            {peer.inHollow ? 'In Hollow' : peer.state === 'offline' ? 'Offline' : 'Online'}
          </span>
        </div>
      </button>

      <div className="friend__actions">
        <button
          className="iconbtn"
          onClick={() => void sendFilesTo(peer.id)}
          title="Send files"
          aria-label={`Send files to ${peer.persona}`}
        >
          <FileSendIcon />
        </button>
        {room && peer.state !== 'offline' && (
          <button className="btn btn--ghost btn--tiny" onClick={invite} disabled={busy}>
            Invite
          </button>
        )}
      </div>
    </li>
  )
}

/** One open direct message, under Home. */
function DmRow({ conversation }: { conversation: Conversation }) {
  const me = useStore((s) => s.me)
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.selectConversation)

  const other = conversation.members.find((m) => m.id !== me?.id)
  if (!other) return null

  return (
    <li>
      <button
        className={`dm ${selected === conversation.id ? 'dm--on' : ''}`}
        onClick={() => void select(conversation.id)}
      >
        <div className="friend__avatar">
          <Avatar peer={other} size={26} />
          <span className={`dot dot--${other.state}`} aria-hidden />
        </div>
        <span className="dm__name">{conversation.name}</span>
        {conversation.unread > 0 && (
          <span className="dm__badge">{conversation.unread > 9 ? '9+' : conversation.unread}</span>
        )}
      </button>
    </li>
  )
}

/** Home: who you can talk to, and the conversations already open. */
function HomeSidebar() {
  const friends = useStore((s) => s.friends)
  const conversations = useStore((s) => s.conversations)
  const room = useStore((s) => s.room)
  const createRoom = useStore((s) => s.createRoom)
  const refreshFriends = useStore((s) => s.refreshFriends)
  const [filter, setFilter] = useState('')

  const [inHollow, others] = useMemo(() => {
    const term = filter.trim().toLowerCase()
    const matching = term
      ? friends.filter((f) => f.persona.toLowerCase().includes(term))
      : friends
    return [matching.filter((f) => f.inHollow), matching.filter((f) => !f.inHollow)]
  }, [friends, filter])

  const dms = conversations.filter((c) => c.kind === 'dm')

  return (
    <>
      {!room && (
        <button className="btn btn--primary btn--block" onClick={() => createRoom('Hollow')}>
          <PlusIcon />
          Start a call
        </button>
      )}

      <div className="sidebar__search">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search friends"
          spellCheck={false}
        />
      </div>

      <nav className="sidebar__friends">
        {dms.length > 0 && !filter && (
          <>
            <h2 className="sidebar__heading">
              Messages <span className="count">{dms.length}</span>
            </h2>
            <ul>
              {dms.map((conversation) => (
                <DmRow key={conversation.id} conversation={conversation} />
              ))}
            </ul>
          </>
        )}

        {inHollow.length > 0 && (
          <>
            <h2 className="sidebar__heading">
              In Hollow <span className="count">{inHollow.length}</span>
            </h2>
            <ul>
              {inHollow.map((peer) => (
                <FriendRow key={peer.id} peer={peer} />
              ))}
            </ul>
          </>
        )}

        <h2 className="sidebar__heading">
          Friends <span className="count">{others.length}</span>
          <button
            className="sidebar__refresh"
            onClick={() => void refreshFriends()}
            title="Reload from Steam"
            aria-label="Reload friends from Steam"
          >
            <RefreshIcon />
          </button>
        </h2>
        <ul>
          {others.map((peer) => (
            <FriendRow key={peer.id} peer={peer} />
          ))}
        </ul>

        {friends.length === 0 && (
          <div className="sidebar__empty">
            <p>
              No friends loaded yet. Steam fills this in a moment or two after it
              finishes signing in.
            </p>
            <button className="btn btn--ghost btn--tiny" onClick={() => void refreshFriends()}>
              Reload from Steam
            </button>
          </div>
        )}
      </nav>
    </>
  )
}

/** One member of a server, with the same file drop a friend row has. */
function MemberRow({ peer }: { peer: Peer }) {
  const me = useStore((s) => s.me)
  const sendFilesTo = useStore((s) => s.sendFilesTo)
  const openDm = useStore((s) => s.openDm)
  const { over, handlers } = usePeerDrop(peer.id)
  const mine = peer.id === me?.id

  return (
    <li className={`friend ${over ? 'friend--drop' : ''}`} {...(mine ? {} : handlers)}>
      <button
        className="friend__identity"
        onClick={() => !mine && void openDm(peer.id)}
        disabled={mine}
        title={mine ? undefined : 'Open chat'}
      >
        <div className="friend__avatar">
          <Avatar peer={peer} size={28} />
          <span className={`dot dot--${peer.state}`} aria-hidden />
        </div>
        <div className="friend__text">
          <span className="friend__name">
            {peer.persona}
            {mine && <span className="chat__you">you</span>}
          </span>
        </div>
      </button>

      {!mine && (
        <div className="friend__actions">
          <button
            className="iconbtn"
            onClick={() => void sendFilesTo(peer.id)}
            title="Send files"
            aria-label={`Send files to ${peer.persona}`}
          >
            <FileSendIcon />
          </button>
        </div>
      )}
    </li>
  )
}

/** A server: who is in it, what its call is doing, and how to add people. */
function ServerSidebar({ conversation }: { conversation: Conversation }) {
  const friends = useStore((s) => s.friends)
  const invite = useStore((s) => s.inviteToServer)
  const leave = useStore((s) => s.leaveServer)
  const startCall = useStore((s) => s.startServerCall)
  const joinCall = useStore((s) => s.joinServerCall)
  const callConversation = useStore((s) => s.callConversation)
  const [adding, setAdding] = useState(false)

  const outsiders = friends.filter((f) => !conversation.members.some((m) => m.id === f.id))
  // Being in the call is not an invitation to join it.
  const here = callConversation === conversation.id

  return (
    <nav className="sidebar__friends">
      <div className="server__call">
        {here ? (
          <p className="notice notice--live">You're in this call.</p>
        ) : conversation.call ? (
          <button className="btn btn--primary btn--block" onClick={() => void joinCall(conversation.id)}>
            Join the call
          </button>
        ) : (
          <button className="btn btn--ghost btn--block" onClick={() => void startCall(conversation.id)}>
            <PlusIcon />
            Start a call
          </button>
        )}
      </div>

      <h2 className="sidebar__heading">
        Members <span className="count">{conversation.members.length}</span>
        <button
          className="sidebar__refresh"
          onClick={() => setAdding((open) => !open)}
          title="Add a friend to this server"
          aria-label="Add a friend to this server"
          aria-pressed={adding}
        >
          <PlusIcon size={14} />
        </button>
      </h2>

      {adding && (
        <ul className="server__add">
          {outsiders.length === 0 && (
            <li className="sidebar__empty">
              <p>Everyone on your friends list is already in here.</p>
            </li>
          )}
          {outsiders.map((friend) => (
            <li key={friend.id}>
              <button
                className="dm"
                onClick={() => {
                  setAdding(false)
                  void invite(conversation.id, friend.id)
                }}
              >
                <Avatar peer={friend} size={24} />
                <span className="dm__name">{friend.persona}</span>
                <span className="dm__hint">Invite</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul>
        {conversation.members.map((member) => (
          <MemberRow key={member.id} peer={member} />
        ))}
      </ul>

      {/*
        The honest small print. Without a server in the middle, a message only
        reaches someone while they and somebody who already has it are online at
        the same time — and a chat that silently does not arrive is worse than
        one that says when it might not.
      */}
      <p className="notice">
        History is kept on each member's machine and catches up whenever two of
        you are online together.
      </p>

      <button className="btn btn--ghost btn--block" onClick={() => void leave(conversation.id)}>
        Leave this server
      </button>
    </nav>
  )
}

export function Sidebar() {
  const me = useStore((s) => s.me)
  const info = useStore((s) => s.info)
  const selected = useStore((s) => s.selected)
  const conversations = useStore((s) => s.conversations)

  const server = conversations.find((c) => c.id === selected && c.kind === 'server')

  return (
    <aside className="sidebar">
      <header className="sidebar__me">
        {me && <Avatar peer={me} size={40} />}
        <div className="sidebar__me-text">
          <span className="sidebar__persona">{me?.persona ?? 'Connecting…'}</span>
          <span className="sidebar__backend">
            <SteamIcon size={13} />
            {info?.backend === 'steam' ? 'Steam' : 'Offline mode'}
          </span>
        </div>
      </header>

      {info?.backend === 'mock' && (
        <p className="notice notice--warn" title={info.backendNote}>
          {info.backendNote}
        </p>
      )}

      {server ? <ServerSidebar conversation={server} /> : <HomeSidebar />}
    </aside>
  )
}

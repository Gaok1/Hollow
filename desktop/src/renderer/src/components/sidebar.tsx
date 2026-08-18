import { useMemo, useState } from 'react'
import { useStore } from '../store'
import type { Peer } from '../types'
import { PlusIcon, SteamIcon } from './icons'

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

function FriendRow({ peer }: { peer: Peer }) {
  const room = useStore((s) => s.room)
  const inviteFriend = useStore((s) => s.inviteFriend)
  const [busy, setBusy] = useState(false)

  const invite = async () => {
    setBusy(true)
    try {
      await inviteFriend(peer.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="friend">
      <div className="friend__identity">
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
      </div>
      {room && peer.state !== 'offline' && (
        <button className="btn btn--ghost btn--tiny" onClick={invite} disabled={busy}>
          Invite
        </button>
      )}
    </li>
  )
}

export function Sidebar() {
  const me = useStore((s) => s.me)
  const info = useStore((s) => s.info)
  const friends = useStore((s) => s.friends)
  const room = useStore((s) => s.room)
  const createRoom = useStore((s) => s.createRoom)
  const [filter, setFilter] = useState('')

  const [inHollow, others] = useMemo(() => {
    const term = filter.trim().toLowerCase()
    const matching = term
      ? friends.filter((f) => f.persona.toLowerCase().includes(term))
      : friends
    return [matching.filter((f) => f.inHollow), matching.filter((f) => !f.inHollow)]
  }, [friends, filter])

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
        </h2>
        <ul>
          {others.map((peer) => (
            <FriendRow key={peer.id} peer={peer} />
          ))}
        </ul>

        {friends.length === 0 && (
          <p className="sidebar__empty">
            No friends loaded yet. Hollow reads your Steam friends list.
          </p>
        )}
      </nav>
    </aside>
  )
}

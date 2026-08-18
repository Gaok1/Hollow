import { useState } from 'react'
import { useStore } from '../store'
import type { Conversation } from '../types'
import { CallIcon, HomeIcon, PlusIcon } from './icons'

/**
 * The column of servers down the left edge.
 *
 * Home first, then one button per server. Direct messages deliberately do not
 * appear here — they belong to a person, and people are already listed under
 * Home. Putting them in both places would mean two ways to reach the same
 * conversation and two places to look for an unread badge.
 */

/** Servers have no picture, so they get their initials, like a person without
 * an avatar does. Two characters, because one is not enough to tell "Gaming"
 * from "General" at 44 pixels. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

function RailButton({
  label,
  selected,
  unread,
  live,
  onClick,
  children,
}: {
  label: string
  selected: boolean
  unread?: number
  /** A call is running in here. */
  live?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`rail__item ${selected ? 'rail__item--on' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={selected}
    >
      {children}
      {live && (
        <span className="rail__live" aria-label="Someone is in a call here">
          <CallIcon size={11} />
        </span>
      )}
      {!!unread && unread > 0 && <span className="rail__badge">{unread > 9 ? '9+' : unread}</span>}
    </button>
  )
}

export function Rail() {
  const conversations = useStore((s) => s.conversations)
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.selectConversation)
  const createServer = useStore((s) => s.createServer)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')

  const servers = conversations.filter((c: Conversation) => c.kind === 'server')
  // Anything unread that is not a server has to surface somewhere, and Home is
  // where direct messages live.
  const homeUnread = conversations
    .filter((c) => c.kind === 'dm')
    .reduce((total, c) => total + c.unread, 0)

  const create = () => {
    const name = draft.trim()
    setNaming(false)
    setDraft('')
    if (name) void createServer(name)
  }

  return (
    <nav className="rail" aria-label="Servers">
      <RailButton label="Home" selected={selected === null} unread={homeUnread} onClick={() => void select(null)}>
        <HomeIcon size={18} />
      </RailButton>

      <div className="rail__rule" aria-hidden />

      {servers.map((server) => (
        <RailButton
          key={server.id}
          label={server.name}
          selected={selected === server.id}
          unread={server.unread}
          live={Boolean(server.call)}
          onClick={() => void select(server.id)}
        >
          <span className="rail__initials">{initials(server.name)}</span>
        </RailButton>
      ))}

      {naming ? (
        <form
          className="rail__new"
          onSubmit={(event) => {
            event.preventDefault()
            create()
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={create}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setNaming(false)
                setDraft('')
              }
            }}
            placeholder="Name"
            spellCheck={false}
            aria-label="Server name"
          />
        </form>
      ) : (
        <button
          className="rail__item rail__item--new"
          onClick={() => setNaming(true)}
          title="Create a server"
          aria-label="Create a server"
        >
          <PlusIcon size={18} />
        </button>
      )}
    </nav>
  )
}

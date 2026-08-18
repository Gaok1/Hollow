import { useState, type DragEvent } from 'react'
import { useStore } from '../store'
import { CloseIcon } from './icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * Active and pending file transfers.
 *
 * Sits above the control bar rather than in a panel: a transfer is transient
 * and wants to be visible without the user going to look for it.
 */
export function Transfers() {
  const transfers = useStore((s) => s.transfers)
  const respond = useStore((s) => s.respondToOffer)
  const dismiss = useStore((s) => s.dismissTransfer)
  const room = useStore((s) => s.room)
  const friends = useStore((s) => s.friends)
  const conversations = useStore((s) => s.conversations)

  if (transfers.length === 0) return null

  /**
   * Who this transfer is with.
   *
   * Three places to look, because a transfer no longer implies a call: the room
   * covers the old case, the friends list covers sending someone a file out of
   * the blue, and the conversations cover a fellow server member who is not on
   * the friends list. Falling through all three would print "peer", which tells
   * nobody anything.
   */
  const peerFor = (id: string) =>
    room?.members.find((m) => m.id === id) ??
    friends.find((f) => f.id === id) ??
    conversations.flatMap((c) => c.members).find((m) => m.id === id)

  return (
    <div className="transfers">
      {transfers.map((transfer) => {
        const peer = peerFor(transfer.peer)
        const pct = transfer.size > 0 ? transfer.transferred / transfer.size : 0

        return (
          <div key={transfer.id} className="transfer">
            <div className="transfer__text">
              <span className="transfer__name">{transfer.name}</span>
              <span className="transfer__meta">
                {transfer.direction === 'in' ? 'from' : 'to'} {peer?.persona ?? 'peer'} ·{' '}
                {transfer.state === 'done'
                  ? 'complete'
                  : `${formatBytes(transfer.transferred)} of ${formatBytes(transfer.size)}`}
              </span>
              {transfer.state === 'active' && (
                <div className="meter">
                  <div className="meter__fill" style={{ transform: `scaleX(${pct})` }} />
                </div>
              )}
            </div>

            {transfer.state === 'offered' ? (
              <div className="transfer__actions">
                <button
                  className="btn btn--ghost btn--tiny"
                  onClick={() => void respond(transfer.id, false)}
                >
                  Decline
                </button>
                <button
                  className="btn btn--primary btn--tiny"
                  onClick={() => void respond(transfer.id, true)}
                >
                  Accept
                </button>
              </div>
            ) : (
              <button
                className="iconbtn"
                onClick={() => dismiss(transfer.id)}
                aria-label="Dismiss"
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Drop files onto the call to send them to everyone in it.
 *
 * Electron exposes the real filesystem path on dropped files, which is what the
 * daemon needs — the browser `File` object alone would mean reading the whole
 * thing into the renderer first.
 */
export function useFileDrop() {
  const room = useStore((s) => s.room)
  const me = useStore((s) => s.me)
  const sendFiles = useStore((s) => s.sendFiles)
  const [dragging, setDragging] = useState(false)

  const handlers = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!room) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault()
      setDragging(false)
      if (!room) return

      const paths = [...event.dataTransfer.files]
        .map((file) => window.hollow.getFilePath(file))
        .filter(Boolean)
      if (paths.length === 0) return

      for (const member of room.members) {
        if (member.id !== me?.id) void sendFiles(member.id, paths)
      }
    },
  }

  return { dragging, handlers }
}

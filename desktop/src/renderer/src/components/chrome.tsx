import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { CloseIcon, MaximizeIcon, MinimizeIcon } from './icons'
import { Avatar } from './sidebar'

export function TitleBar() {
  const room = useStore((s) => s.room)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => window.hollow.window.onStateChange(setMaximized), [])

  return (
    <header className="titlebar">
      {/* The drag region has to be an element, not the bar itself, or the
          buttons inside would drag the window instead of clicking. */}
      <div className="titlebar__drag">
        <span className="titlebar__brand">Hollow</span>
        {room && (
          <span className="titlebar__room">
            {room.name}
            <span className="titlebar__count">
              {room.members.length}/{room.maxMembers}
            </span>
          </span>
        )}
      </div>

      <div className="titlebar__actions">
        <button
          className="titlebar__btn"
          onClick={() => window.hollow.window.minimize()}
          aria-label="Minimise"
        >
          <MinimizeIcon />
        </button>
        <button
          className="titlebar__btn"
          onClick={() => window.hollow.window.maximize()}
          aria-label={maximized ? 'Restore' : 'Maximise'}
        >
          <MaximizeIcon />
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          onClick={() => window.hollow.window.close()}
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  const accept = useStore((s) => s.acceptInvite)
  const respondToServer = useStore((s) => s.respondToServerInvite)

  if (toasts.length === 0) return null

  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.kind}`}>
          {toast.from && <Avatar peer={toast.from} size={32} />}
          <span className="toast__message">{toast.message}</span>

          {toast.kind === 'invite' ? (
            <div className="toast__actions">
              <button className="btn btn--ghost btn--tiny" onClick={() => dismiss(toast.id)}>
                Ignore
              </button>
              <button className="btn btn--primary btn--tiny" onClick={() => void accept(toast)}>
                Join
              </button>
            </div>
          ) : toast.kind === 'server' ? (
            // A server invite is a decision, not a notification: accepting puts
            // a conversation on this machine and this account on other people's
            // member lists, so it does not time out on its own.
            <div className="toast__actions">
              <button
                className="btn btn--ghost btn--tiny"
                onClick={() => void respondToServer(toast, false)}
              >
                Decline
              </button>
              <button
                className="btn btn--primary btn--tiny"
                onClick={() => void respondToServer(toast, true)}
              >
                Join
              </button>
            </div>
          ) : (
            <button className="iconbtn" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function FatalError({ message }: { message: string }) {
  return (
    <div className="fatal">
      <h1>Hollow stopped</h1>
      <p>{message}</p>
      <p className="fatal__hint">
        The background service is what talks to Steam and captures audio. Restart Hollow to bring
        it back.
      </p>
    </div>
  )
}

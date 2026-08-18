import { useEffect, useRef, useState } from 'react'
import { useStore, type ChatMessage } from '../store'
import type { Peer } from '../types'
import { Avatar } from './sidebar'
import { AlertIcon, CloseIcon, SendIcon } from './icons'

/**
 * Room chat, for the length of the call and no longer.
 *
 * Nothing here is written to disk at either end and nothing survives leaving
 * the room — a call is a conversation, not a record of one. It rides Steam's
 * own P2P messaging on a channel of its own, so it works exactly as far as the
 * call does and needs no server either.
 */

/** Two turns from the same person within this window read as one. */
const GROUP_WINDOW_MS = 5 * 60_000

/** Past this the composer scrolls instead of growing further. */
const COMPOSER_MAX_PX = 120

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Says what became of one of our own messages.
 *
 * Only ever renders when something went wrong, or briefly while it is in
 * flight: a tick beside every line that worked is noise.
 */
function Delivery({ state }: { state: ChatMessage['delivery'] }) {
  if (!state || state === 'sent') return null
  if (state === 'sending') return <span className="chat__pending" aria-label="Sending" />
  return (
    <span
      className={`chat__failed ${state === 'partial' ? 'chat__failed--partial' : ''}`}
      title={
        state === 'partial'
          ? 'Steam would not take this for everyone in the room.'
          : 'This reached nobody. The call may have lost its connection.'
      }
    >
      <AlertIcon size={12} />
      {state === 'partial' ? 'Not everyone got this' : 'Not delivered'}
    </span>
  )
}

export function ChatPanel() {
  const open = useStore((s) => s.chatOpen)
  const messages = useStore((s) => s.chat)
  const room = useStore((s) => s.room)
  const me = useStore((s) => s.me)
  const toggle = useStore((s) => s.toggle)
  const sendChat = useStore((s) => s.sendChat)

  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Stick to the newest message. Chat that does not follow itself is chat you
  // have to scroll to read, which is chat nobody reads. Driving scrollTop
  // rather than `scrollIntoView` keeps the effect inside this box: the latter
  // walks up the ancestors and can move the whole layout with it.
  useEffect(() => {
    const box = scrollRef.current
    if (open && box) box.scrollTop = box.scrollHeight
  }, [messages, open])

  // Grow with the draft rather than hiding it behind a one-line box.
  useEffect(() => {
    const box = composerRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(COMPOSER_MAX_PX, box.scrollHeight)}px`
  }, [draft, open])

  if (!open) return null

  const others = (room?.members ?? []).filter((m) => m.id !== me?.id)

  const submit = () => {
    if (!draft.trim()) return
    void sendChat(draft)
    setDraft('')
  }

  return (
    <aside className="panel panel--chat">
      <header className="panel__head">
        <h2>Chat</h2>
        <button className="iconbtn" onClick={() => toggle('chat')} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <div className="chat__scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat__empty">
            Nothing yet. Messages live only as long as the call does — nothing is written down,
            here or on anyone else's machine.
          </p>
        )}

        {messages.map((message, index) => {
          const previous = messages[index - 1]
          const opensGroup =
            !previous ||
            previous.from !== message.from ||
            message.at - previous.at > GROUP_WINDOW_MS

          const author: Peer = room?.members.find((m) => m.id === message.from) ?? {
            id: message.from,
            persona: message.persona,
            state: 'online',
            inHollow: true,
          }

          return (
            <div
              key={message.id}
              className={`chat__line ${opensGroup ? 'chat__line--opens' : ''}`}
            >
              <div className="chat__gutter">{opensGroup && <Avatar peer={author} size={28} />}</div>
              <div className="chat__body">
                {opensGroup && (
                  <div className="chat__meta">
                    <span className="chat__author">
                      {message.persona}
                      {message.mine && <span className="chat__you">you</span>}
                    </span>
                    <span className="chat__time">{timeOf(message.at)}</span>
                  </div>
                )}
                <p className="chat__text">{message.text}</p>
                {message.mine && <Delivery state={message.delivery} />}
              </div>
            </div>
          )
        })}
      </div>

      <form
        className="chat__compose"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line — the convention every
            // other chat has taught people to expect.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={
            others.length > 0 ? 'Message the room' : 'Nobody else is here to read this yet'
          }
          rows={1}
          spellCheck={false}
        />
        <button
          className="iconbtn chat__send"
          type="submit"
          disabled={!draft.trim()}
          aria-label="Send"
        >
          <SendIcon />
        </button>
      </form>
    </aside>
  )
}

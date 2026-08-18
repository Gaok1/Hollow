import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore, type ChatMessage } from '../store'
import type { Peer, StoredMessage } from '../types'
import { Avatar } from './sidebar'
import { AlertIcon, CloseIcon, SendIcon } from './icons'

/**
 * Text, in the two lifetimes Hollow gives it.
 *
 * A call started from nowhere has a chat that lives as long as the call and is
 * never written down; a server or a direct message has one that is on disk on
 * every member's machine and is reconciled between them. They render through
 * the same components on purpose — the difference is where the words are kept,
 * and that is not something the user should have to see two layouts to learn.
 */

/** Two turns from the same person within this window read as one. */
const GROUP_WINDOW_MS = 5 * 60_000

/** Past this the composer scrolls instead of growing further. */
const COMPOSER_MAX_PX = 120

/** How close to the top counts as asking for more scrollback. */
const LOAD_MORE_PX = 80

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** One rendered line, whichever kind of chat it came from. */
interface Line {
  key: string
  from: string
  persona: string
  text: string
  at: number
  mine: boolean
  /** Only on the ad-hoc chat, which is the only one that can fail to arrive. */
  delivery?: ChatMessage['delivery']
}

const linesFromChat = (messages: ChatMessage[]): Line[] =>
  messages.map((message) => ({
    key: String(message.id),
    from: message.from,
    persona: message.persona,
    text: message.text,
    at: message.at,
    mine: message.mine,
    delivery: message.delivery,
  }))

const linesFromStored = (
  messages: StoredMessage[],
  members: Peer[],
  meId: string | undefined,
): Line[] =>
  messages.map((message) => ({
    // Author and seq, the same identity the daemon and the database use.
    key: `${message.author}:${message.seq}`,
    from: message.author,
    persona: members.find((m) => m.id === message.author)?.persona ?? `User ${message.author}`,
    text: message.text,
    at: message.at,
    mine: message.author === meId,
  }))

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

function MessageList({
  lines,
  members,
  empty,
  onReachTop,
}: {
  lines: Line[]
  members: Peer[]
  empty: React.ReactNode
  /** Called when the reader scrolls near the top, to page further back. */
  onReachTop?: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousHeight = useRef(0)
  const previousCount = useRef(0)

  // Stick to the newest message when the conversation grows at the bottom, and
  // hold position when it grows at the top. Without the second half, loading
  // scrollback yanks the reader away from the line they were reading — which is
  // the one thing that makes people stop scrolling back at all.
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return

    const grewAtTop = lines.length > previousCount.current && previousHeight.current > 0
    const nearBottom =
      box.scrollHeight - box.scrollTop - box.clientHeight < previousHeight.current * 0.2

    if (grewAtTop && !nearBottom) {
      box.scrollTop += box.scrollHeight - previousHeight.current
    } else {
      box.scrollTop = box.scrollHeight
    }

    previousHeight.current = box.scrollHeight
    previousCount.current = lines.length
  }, [lines])

  return (
    <div
      className="chat__scroll"
      ref={scrollRef}
      onScroll={(event) => {
        if (onReachTop && event.currentTarget.scrollTop < LOAD_MORE_PX) onReachTop()
      }}
    >
      {lines.length === 0 && <p className="chat__empty">{empty}</p>}

      {lines.map((line, index) => {
        const previous = lines[index - 1]
        const opensGroup =
          !previous || previous.from !== line.from || line.at - previous.at > GROUP_WINDOW_MS

        const author: Peer = members.find((m) => m.id === line.from) ?? {
          id: line.from,
          persona: line.persona,
          state: 'online',
          inHollow: true,
        }

        return (
          <div key={line.key} className={`chat__line ${opensGroup ? 'chat__line--opens' : ''}`}>
            <div className="chat__gutter">{opensGroup && <Avatar peer={author} size={28} />}</div>
            <div className="chat__body">
              {opensGroup && (
                <div className="chat__meta">
                  <span className="chat__author">
                    {line.persona}
                    {line.mine && <span className="chat__you">you</span>}
                  </span>
                  <span className="chat__time">{timeOf(line.at)}</span>
                </div>
              )}
              <p className="chat__text">{line.text}</p>
              {line.mine && <Delivery state={line.delivery} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Composer({
  placeholder,
  onSubmit,
}: {
  placeholder: string
  onSubmit: (text: string) => void
}) {
  const [draft, setDraft] = useState('')
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Grow with the draft rather than hiding it behind a one-line box.
  useEffect(() => {
    const box = composerRef.current
    if (!box) return
    box.style.height = 'auto'
    box.style.height = `${Math.min(COMPOSER_MAX_PX, box.scrollHeight)}px`
  }, [draft])

  const submit = () => {
    if (!draft.trim()) return
    onSubmit(draft)
    setDraft('')
  }

  return (
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
        placeholder={placeholder}
        rows={1}
        spellCheck={false}
      />
      <button className="iconbtn chat__send" type="submit" disabled={!draft.trim()} aria-label="Send">
        <SendIcon />
      </button>
    </form>
  )
}

/**
 * What the chat beside a call is showing.
 *
 * A call inside a server shows that server's real, kept transcript. A call that
 * belongs to nothing gets the throwaway one, because there is nowhere to keep
 * it and inventing somewhere would mean inventing a server nobody asked for.
 */
function useCallChat() {
  const callConversation = useStore((s) => s.callConversation)
  const conversations = useStore((s) => s.conversations)
  const stored = useStore((s) => (callConversation ? s.messages[callConversation] : undefined))
  const ephemeral = useStore((s) => s.chat)
  const room = useStore((s) => s.room)
  const me = useStore((s) => s.me)

  const conversation = conversations.find((c) => c.id === callConversation)

  if (conversation) {
    return {
      conversation,
      lines: linesFromStored(stored ?? [], conversation.members, me?.id),
      members: conversation.members,
      kept: true,
    }
  }
  return {
    conversation: undefined,
    lines: linesFromChat(ephemeral),
    members: room?.members ?? [],
    kept: false,
  }
}

/** The 320px panel that opens beside a call. */
export function ChatPanel() {
  const open = useStore((s) => s.chatOpen)
  const toggle = useStore((s) => s.toggle)
  const sendChat = useStore((s) => s.sendChat)
  const sendMessage = useStore((s) => s.sendMessage)
  const selectConversation = useStore((s) => s.selectConversation)
  const { conversation, lines, members, kept } = useCallChat()

  // Load the transcript when the panel opens on a server call whose history has
  // not been fetched yet.
  //
  // Keyed on the id, never on the conversation itself: the object is rebuilt
  // from a fresh array every time the daemon re-sends the list, so depending on
  // it would re-run this effect, which refreshes the list, which rebuilds the
  // object — a loop that never settles.
  const conversationId = conversation?.id
  useEffect(() => {
    if (open && conversationId) void selectConversation(conversationId)
  }, [open, conversationId, selectConversation])

  if (!open) return null

  const alone = members.length <= 1

  return (
    <aside className="panel panel--chat">
      <header className="panel__head">
        <h2>{conversation ? conversation.name : 'Chat'}</h2>
        <button className="iconbtn" onClick={() => toggle('chat')} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <MessageList
        lines={lines}
        members={members}
        empty={
          kept
            ? 'Nothing here yet. Whatever is said stays — on your machine and on everyone else’s.'
            : 'Nothing yet. Messages live only as long as the call does — nothing is written down, here or on anyone else’s machine.'
        }
      />

      {/*
        Keyed by conversation so an unsent draft cannot follow you into a
        different one and be sent to the wrong people.
      */}
      <Composer
        key={conversation?.id ?? 'call'}
        placeholder={alone ? 'Nobody else is here to read this yet' : 'Message the room'}
        onSubmit={(text) => {
          if (conversation) void sendMessage(conversation.id, text)
          else void sendChat(text)
        }}
      />
    </aside>
  )
}

/**
 * The full-width transcript, shown when a conversation is selected and no call
 * is running. The same list and composer as the panel, given the room to be
 * read in.
 */
export function ChatView({ conversationId }: { conversationId: string }) {
  const conversations = useStore((s) => s.conversations)
  const messages = useStore((s) => s.messages[conversationId])
  const me = useStore((s) => s.me)
  const sendMessage = useStore((s) => s.sendMessage)
  const loadMore = useStore((s) => s.loadMoreHistory)
  const startCall = useStore((s) => s.startServerCall)
  const joinCall = useStore((s) => s.joinServerCall)
  const callConversation = useStore((s) => s.callConversation)

  const conversation = conversations.find((c) => c.id === conversationId)
  if (!conversation) return null

  // This view only renders when no call is on screen, but the daemon can still
  // be in one — leave the button out rather than offering to join where we are.
  const here = callConversation === conversation.id

  const others = conversation.members.filter((m) => m.id !== me?.id)
  const lines = linesFromStored(messages ?? [], conversation.members, me?.id)

  return (
    <section className="chatview">
      <header className="chatview__head">
        <h2>{conversation.name}</h2>
        <div className="chatview__actions">
          {here ? null : conversation.call ? (
            <button
              className="btn btn--primary btn--tiny"
              onClick={() => void joinCall(conversation.id)}
            >
              Join call
            </button>
          ) : (
            <button
              className="btn btn--ghost btn--tiny"
              onClick={() => void startCall(conversation.id)}
            >
              Start a call
            </button>
          )}
        </div>
      </header>

      <MessageList
        lines={lines}
        members={conversation.members}
        onReachTop={() => void loadMore(conversation.id)}
        empty={
          others.length === 0
            ? 'Nobody else is in here yet. Invite someone from the list on the left.'
            : 'Nothing here yet. Whatever is said stays — on your machine and on everyone else’s.'
        }
      />

      <Composer
        key={conversation.id}
        placeholder={`Message ${conversation.name}`}
        onSubmit={(text) => void sendMessage(conversation.id, text)}
      />
    </section>
  )
}

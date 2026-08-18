import { create } from 'zustand'
import { Mesh, type LinkHealth } from './lib/mesh'
import {
  BroadcastAudio,
  MIC_BOOST_MAX,
  PEER_VOLUME_MAX,
  openCamera,
  openMicrophone,
  openScreen,
  retuneScreen,
  type MicrophoneSource,
} from './lib/media'
import type {
  AppInfo,
  Conversation,
  FileTransfer,
  HistoryCursor,
  MixerSnapshot,
  Peer,
  Presence,
  Room,
  ScreenSource,
  StoredMessage,
  TrackSlot,
} from './types'

/**
 * The mesh holds live `RTCPeerConnection`s and must not be recreated on render,
 * so it lives beside the store rather than in it.
 */
let mesh: Mesh | null = null
const broadcastAudio = new BroadcastAudio()

/**
 * The live microphone chain, for the same reason the mesh lives out here: it
 * owns a device and an audio graph, neither of which survives being copied into
 * a new state object on every render.
 */
let micSource: MicrophoneSource | null = null

const rpc = <T = unknown,>(method: string, params?: unknown): Promise<T> =>
  window.hollow.request(method, params) as Promise<T>

/**
 * Write one line to Hollow's log file.
 *
 * The renderer is where a call actually fails, and an installed build has no
 * console to fail into. Everything that would have been a `console.warn` about
 * signaling, media or devices goes here instead, so a call that connected to
 * nobody can be read back afterwards.
 */
const log = (line: string): void => window.hollow.log.write(line)

/**
 * One line of room chat.
 *
 * Chat is deliberately memory-only: nothing is written to disk at either end,
 * and leaving the room drops the history. A call is a conversation, not a
 * record of one, and a log nobody asked for is a liability.
 */
export interface ChatMessage {
  id: number
  /** SteamID64 of the author. */
  from: string
  persona: string
  text: string
  at: number
  mine: boolean
  /** Only on our own messages: what Steam did with it. */
  delivery?: 'sending' | 'sent' | 'partial' | 'failed'
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'invite' | 'server'
  message: string
  /** Present on call invites: accepting joins this room. */
  roomId?: string
  /** Present on server invites: accepting joins this conversation. */
  serverId?: string
  from?: Peer
}

/**
 * Merge new messages into a conversation without duplicating or reordering.
 *
 * The same line legitimately arrives twice — once pushed as it was written, once
 * again in a sync answer from somebody else who has it — so identity is
 * `author:seq`, exactly as it is on disk. Order is by the author's clock, with
 * the same tiebreak the daemon uses, so both ends show the transcript the same
 * way round.
 */
export function mergeMessages(
  existing: StoredMessage[],
  incoming: StoredMessage[],
): StoredMessage[] {
  if (incoming.length === 0) return existing

  const byId = new Map(existing.map((m) => [`${m.author}:${m.seq}`, m]))
  let changed = false
  for (const message of incoming) {
    const key = `${message.author}:${message.seq}`
    if (byId.has(key)) continue
    byId.set(key, message)
    changed = true
  }
  if (!changed) return existing

  return [...byId.values()].sort(
    (a, b) => a.at - b.at || a.author.localeCompare(b.author) || a.seq - b.seq,
  )
}

export interface Settings {
  microphoneId?: string
  cameraId?: string
  /** Screen share frame rate. 60 for motion, 15 for reading documents. */
  screenFrameRate: number
  /**
   * Tallest the share is allowed to be, or 0 for the display's own resolution.
   *
   * Paired with the frame rate rather than derived from it: the two trade
   * against each other inside one bitrate, and which one to give up is a
   * judgement about what is being shared, not something to guess.
   */
  screenHeight: number
  /**
   * Whether a share carries the machine's audio.
   *
   * `auto` sends it only where the daemon can capture applications one by one.
   * Without that, all there is to capture is the whole output — which includes
   * the call itself, so everyone would hear themselves come back. See
   * {@link systemAudioWanted}.
   */
  systemAudio: 'auto' | 'on' | 'off'
  /** Master gain over the outgoing broadcast mix, where 1 is untouched. */
  broadcastGain: number
  /**
   * Gain applied to the microphone before it is sent, where 1 is untouched.
   * See {@link MIC_BOOST_MAX}.
   */
  micBoost: number
  /**
   * How loud each person is played, keyed by SteamID64, where 1 is untouched.
   *
   * Kept rather than reset per call: someone who records quiet records quiet
   * every time, and having to find the slider again on every call is the kind
   * of small tax that makes people stop bothering. Only entries that differ
   * from 1 are stored, so this stays the size of the problem.
   */
  peerVolume: Record<string, number>
  /** Optional TURN relay for peers behind symmetric NAT. */
  turnUrl?: string
  turnUsername?: string
  turnCredential?: string
}

const DEFAULT_SETTINGS: Settings = {
  screenFrameRate: 30,
  screenHeight: 1080,
  systemAudio: 'auto',
  broadcastGain: 1,
  micBoost: 1,
  peerVolume: {},
}

/** How much of the broadcast may be turned up before it is asking for trouble. */
export const BROADCAST_GAIN_MAX = 2

/**
 * Does a share on this machine carry system audio?
 *
 * The honest answer on Windows 10 is no by default. Per-application capture
 * arrived in build 20348; before it, the only thing that can be captured is the
 * render endpoint, and Hollow is playing the call into that endpoint. Sending it
 * on means every peer hears their own voice a moment late, which is worse than
 * silent game audio — so it is offered as a switch and left off.
 */
export const systemAudioWanted = (
  choice: Settings['systemAudio'],
  perProcessCapture: boolean,
): boolean => (choice === 'auto' ? perProcessCapture : choice === 'on')

/**
 * A gain, in range and to two decimals.
 *
 * The rounding is what makes "is this untouched?" answerable. A range input
 * stepping by 0.05 can hand back 1.0000000000000002, and a peer volume that is
 * merely almost 1 would be stored forever as an override nobody set.
 */
const clampGain = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.round(Math.min(max, Math.max(0, value)) * 100) / 100 : 1

const SETTINGS_KEY = 'hollow.settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const stored = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings
    // Written by an older build, or by hand. A gain read back as undefined
    // would silence the microphone, which is a poor way to learn about it.
    return {
      ...stored,
      micBoost: Number.isFinite(stored.micBoost) ? stored.micBoost : 1,
      broadcastGain: Number.isFinite(stored.broadcastGain) ? stored.broadcastGain : 1,
      screenHeight: Number.isFinite(stored.screenHeight) ? stored.screenHeight : 1080,
      peerVolume: stored.peerVolume ?? {},
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * Steam carries signaling, but WebRTC media negotiates its own path and still
 * needs STUN to discover a reflexive address.
 *
 * Peers that are both behind symmetric NAT cannot reach each other with STUN
 * alone and need a TURN relay, which Hollow does not host — that is what the
 * TURN fields in settings are for.
 */
function iceServers(settings: Settings): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ]
  if (settings.turnUrl) {
    servers.push({
      urls: settings.turnUrl,
      username: settings.turnUsername,
      credential: settings.turnCredential,
    })
  }
  return servers
}

/**
 * Names one video feed: a person and which of their two cameras it is.
 *
 * The stage needs to talk about "that screen" and "that camera" separately —
 * one person can be sending both — and a plain peer id cannot say which.
 */
export const feedKey = (peerId: string, slot: 'camera' | 'screen'): string => `${peerId}:${slot}`

/** The peer half of a {@link feedKey}. */
export const feedPeer = (key: string): string => key.slice(0, key.lastIndexOf(':'))

interface State {
  info: AppInfo | null
  me: Peer | null
  friends: Peer[]
  room: Room | null
  /** Remote presence, keyed by SteamID64. */
  presence: Record<string, Presence>
  /** What each link is doing, keyed by SteamID64. Drives every status the UI shows. */
  health: Record<string, LinkHealth>
  /**
   * Who is silenced for us only, keyed by SteamID64.
   *
   * Deliberately not persisted, unlike the volumes beside it: a volume is an
   * opinion about how someone sounds, silencing them is an opinion about right
   * now. Coming back to a call where a friend is inexplicably mute, with no
   * memory of having done it, is a bug report waiting to happen.
   */
  peerMuted: Record<string, boolean>
  chat: ChatMessage[]
  /** Messages that arrived while the panel was closed. */
  chatUnread: number

  /** Every server and direct message, as the daemon last described them. */
  conversations: Conversation[]
  /**
   * What the rail has selected, or null for Home.
   *
   * Home is the friends list and the idle stage; a selection is one server or
   * one direct message.
   */
  selected: string | null
  /** Loaded transcript per conversation, oldest first. */
  messages: Record<string, StoredMessage[]>
  /** Conversations whose scrollback has reached the beginning. */
  historyDone: Record<string, boolean>
  /**
   * Which server the live call belongs to, or null for a call that belongs to
   * nobody. That distinction is what decides whether the chat beside the call
   * is written down or thrown away when it ends.
   */
  callConversation: string | null

  remoteTracks: Record<string, Partial<Record<TrackSlot, MediaStreamTrack>>>

  local: Partial<Record<TrackSlot, MediaStreamTrack>>
  localPresence: Presence
  /**
   * Which feed fills the stage, as a {@link feedKey}, or null to let the stage
   * decide — which means whoever is sharing, and the grid when nobody is.
   */
  focus: string | null
  /**
   * Feeds folded away into the dock, as {@link feedKey}s.
   *
   * A share nobody is watching still arrives, still costs bandwidth and still
   * belongs to the person who started it, so this hides the window rather than
   * closing anything down.
   */
  minimized: string[]

  mixer: MixerSnapshot | null
  /** Broadcast gains, keyed by pid. */
  gains: Record<number, { gain: number; muted: boolean }>

  screenSources: ScreenSource[]
  pickerOpen: boolean
  settingsOpen: boolean
  mixerOpen: boolean
  chatOpen: boolean
  settings: Settings
  transfers: FileTransfer[]
  toasts: Toast[]
  fatal: string | null

  init(): Promise<void>
  createRoom(name: string): Promise<void>
  joinRoom(id: string): Promise<void>
  leaveRoom(): Promise<void>
  inviteFriend(id: string): Promise<void>
  openInviteOverlay(): Promise<void>

  toggleMic(): Promise<void>
  toggleDeafen(): Promise<void>
  toggleCamera(): Promise<void>
  openPicker(): Promise<void>
  closePicker(): void
  startShare(sourceId: string): Promise<void>
  stopShare(): Promise<void>

  setGain(pid: number, gain: number, muted: boolean): Promise<void>
  refreshBroadcastAudio(): Promise<void>
  setMasterGain(gain: number): Promise<void>

  /** Gain on what we send, 0 to {@link MIC_BOOST_MAX}. Applies to the live call at once. */
  setMicBoost(boost: number): void
  /** Gain on what we hear from one person, 0 to {@link PEER_VOLUME_MAX}. */
  setPeerVolume(peerId: string, volume: number): void
  togglePeerMuted(peerId: string): void

  sendChat(text: string): Promise<void>

  refreshConversations(): Promise<void>
  selectConversation(id: string | null): Promise<void>
  loadMoreHistory(id: string): Promise<void>
  createServer(name: string): Promise<void>
  inviteToServer(conversationId: string, peerId: string): Promise<void>
  leaveServer(id: string): Promise<void>
  /** Open the direct message with someone and select it. */
  openDm(peerId: string): Promise<void>
  sendMessage(conversationId: string, text: string): Promise<void>
  startServerCall(id: string): Promise<void>
  joinServerCall(id: string): Promise<void>
  respondToServerInvite(toast: Toast, accept: boolean): Promise<void>
  /** Ask for files and send them to one person. No call required. */
  sendFilesTo(peerId: string): Promise<void>

  refreshFriends(): Promise<void>
  openLog(): Promise<void>
  /** Put a shareable diagnostic report on the clipboard. */
  copyReport(): Promise<boolean>
  revealLog(): Promise<void>
  updateSettings(patch: Partial<Settings>): void
  setFocus(key: string | null): void
  toggleMinimized(key: string): void
  toggle(panel: 'settings' | 'mixer' | 'chat'): void
  dismissToast(id: number): void
  acceptInvite(toast: Toast): Promise<void>
  sendFiles(to: string, paths: string[]): Promise<void>
  respondToOffer(id: number, accept: boolean): Promise<void>
  dismissTransfer(id: number): void
}

let toastSeq = 1
/** Shared by sent and received messages so React keys never collide. */
let chatSeq = 1
/**
 * Conversations with a scrollback request in flight.
 *
 * Beside the store rather than in it: this is not something anything renders,
 * and putting it in state would redraw the transcript twice for every page.
 */
const loadingHistory = new Set<string>()

export const useStore = create<State>((set, get) => ({
  info: null,
  me: null,
  friends: [],
  room: null,
  presence: {},
  health: {},
  peerMuted: {},
  chat: [],
  chatUnread: 0,
  conversations: [],
  selected: null,
  messages: {},
  historyDone: {},
  callConversation: null,
  remoteTracks: {},
  local: {},
  focus: null,
  minimized: [],
  localPresence: {
    micMuted: true,
    deafened: false,
    cameraOn: false,
    sharingScreen: false,
    sharingAudio: false,
  },
  pinned: null,
  mixer: null,
  gains: {},
  screenSources: [],
  pickerOpen: false,
  settingsOpen: false,
  mixerOpen: false,
  chatOpen: false,
  settings: loadSettings(),
  transfers: [],
  toasts: [],
  fatal: null,

  async init() {
    /**
     * Build the mesh once we know who we are.
     *
     * Needed from two places: the daemon's `ready` event, and the `app.info`
     * fallback below. `ready` is emitted once at daemon startup, so a renderer
     * reload only ever sees the latter — and without the mesh, no call connects.
     */
    const ensureMesh = (info: AppInfo) => {
      if (mesh) return
      mesh = new Mesh(
        info.me.id,
        {
          onTrack: (peerId, slot, track) =>
            set((s) => {
              const next = { ...(s.remoteTracks[peerId] ?? {}) }
              if (track) next[slot] = track
              else delete next[slot]
              return { remoteTracks: { ...s.remoteTracks, [peerId]: next } }
            }),
          onHealth: (peerId, health) =>
            set((s) => ({ health: { ...s.health, [peerId]: health } })),
          send: (peerId, signalPayload) => {
            void rpc('signal.send', { to: peerId, payload: signalPayload }).catch((err) =>
              log(`signal.send to ${peerId} failed — ${err}`),
            )
          },
          log,
        },
        iceServers(get().settings),
      )
    }

    /**
     * Reconcile the mesh with a room snapshot.
     *
     * Shared between the `room` event and the `app.info` fallback: a renderer
     * reload mid-call gets its room from the latter, and the daemon will not
     * re-emit the event until membership actually churns.
     */
    const applyRoom = (room: Room | null, conversation: string | null = null) => {
      const previous = get().room
      set({ room, callConversation: room ? conversation : null })

      if (!room) {
        log('room: left')
        mesh?.closeAll()
        // The *ad-hoc* chat dies with the room. A server's chat is on disk and
        // is not this state at all, which is the whole point of the split.
        set({
          remoteTracks: {},
          health: {},
          presence: {},
          peerMuted: {},
          focus: null,
          minimized: [],
          chat: [],
          chatUnread: 0,
          chatOpen: false,
        })
        void get().stopShare()
        void get().refreshConversations()
        return
      }

      // Open a connection to everyone we are not already talking to, and drop
      // anyone who left. Room updates are authoritative; the join and leave
      // events are just faster.
      const me = get().me?.id
      const wanted = new Set(room.members.map((m) => m.id).filter((id) => id !== me))
      log(`room: ${room.name} with ${room.members.length} member(s)`)
      for (const id of wanted) void mesh?.connect(id)
      for (const id of mesh?.peerIds ?? []) {
        if (!wanted.has(id)) mesh?.disconnect(id)
      }
      // Health entries outlive their links otherwise, and a stale "Connecting"
      // badge on someone who already left is worse than no badge.
      set((s) => ({
        health: Object.fromEntries(Object.entries(s.health).filter(([id]) => wanted.has(id))),
      }))
      if (!previous) {
        // Publish our starting state so late tiles are not blank.
        void rpc('presence.set', get().localPresence)
      }
    }

    const pushToast = (toast: Omit<Toast, 'id'>) => {
      const id = toastSeq++
      set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
      // Invitations wait for an answer. Everything else is a notification and
      // gets out of the way on its own.
      if (toast.kind !== 'invite' && toast.kind !== 'server') {
        setTimeout(() => get().dismissToast(id), 6000)
      }
    }

    window.hollow.onEvent((event, payload) => {
      const data = payload as never

      switch (event) {
        case 'ready': {
          const info = data as AppInfo
          set({ info, me: info.me })
          ensureMesh(info)
          break
        }

        case 'identity':
          set({ me: (data as { me: Peer }).me })
          break

        case 'friends':
          set({ friends: data as Peer[] })
          break

        case 'room': {
          const payload = data as { room: Room; conversation: string | null } | null
          applyRoom(payload?.room ?? null, payload?.conversation ?? null)
          break
        }

        case 'conversations':
          set({ conversations: data as Conversation[] })
          break

        case 'conv.changed':
          void get().refreshConversations()
          break

        case 'conv.message': {
          const { conversation, message } = data as {
            conversation: string
            message: StoredMessage
          }
          set((s) => {
            const loaded = s.messages[conversation]
            return {
              // Only grow a transcript already on screen. Appending to one that
              // was never opened would leave a hole between it and the history
              // the daemon would hand over on opening.
              messages: loaded
                ? { ...s.messages, [conversation]: mergeMessages(loaded, [message]) }
                : s.messages,
            }
          })
          if (get().selected === conversation) {
            void rpc('conv.markRead', { id: conversation, at: message.at })
          }
          void get().refreshConversations()
          break
        }

        case 'conv.synced': {
          const { conversation, messages } = data as {
            conversation: string
            messages: StoredMessage[]
          }
          if (messages.length > 0) {
            log(`sync: ${messages.length} message(s) arrived for ${conversation}`)
            set((s) => {
              const loaded = s.messages[conversation]
              return {
                messages: loaded
                  ? { ...s.messages, [conversation]: mergeMessages(loaded, messages) }
                  : s.messages,
              }
            })
          }
          void get().refreshConversations()
          break
        }

        case 'server.invite': {
          const { id, name, from } = data as { id: string; name: string; from: string }
          const who = get().friends.find((f) => f.id === from)
          pushToast({
            kind: 'server',
            message: `${who?.persona ?? 'Someone'} invited you to ${name}`,
            serverId: id,
            from: who,
          })
          break
        }

        case 'server.call':
          void get().refreshConversations()
          break

        case 'peer.joined': {
          const peer = data as Peer
          if (peer.id !== get().me?.id) void mesh?.connect(peer.id)
          pushToast({ kind: 'info', message: `${peer.persona} joined` })
          break
        }

        case 'peer.left': {
          const { id } = data as { id: string }
          mesh?.disconnect(id)
          set((s) => {
            const remoteTracks = { ...s.remoteTracks }
            const health = { ...s.health }
            delete remoteTracks[id]
            delete health[id]
            // Their windows go with them, focus included.
            return {
              remoteTracks,
              health,
              focus: s.focus && feedPeer(s.focus) === id ? null : s.focus,
              minimized: s.minimized.filter((key) => feedPeer(key) !== id),
            }
          })
          break
        }

        case 'signal': {
          const { from, payload: signalPayload } = data as { from: string; payload: unknown }
          void mesh?.handleSignal(from, signalPayload)
          break
        }

        case 'chat': {
          const { from, text } = data as { from: string; text: string }
          const author =
            get().room?.members.find((m) => m.id === from) ??
            get().friends.find((f) => f.id === from)
          set((s) => ({
            chat: [
              ...s.chat,
              {
                id: chatSeq++,
                from,
                persona: author?.persona ?? `User ${from}`,
                text,
                at: Date.now(),
                mine: false,
              },
            ],
            chatUnread: s.chatOpen ? s.chatUnread : s.chatUnread + 1,
          }))
          break
        }

        case 'chat.delivery': {
          const { id, recipients, failed } = data as {
            id: number
            recipients: number
            failed: string[]
          }
          if (failed.length > 0) {
            log(`chat ${id}: ${failed.length} of ${recipients} recipient(s) refused`)
          }
          const delivery: ChatMessage['delivery'] =
            failed.length === 0
              ? 'sent'
              : failed.length >= recipients
                ? 'failed'
                : 'partial'
          set((s) => ({
            chat: s.chat.map((m) => (m.id === id ? { ...m, delivery } : m)),
          }))
          break
        }

        case 'presence': {
          const { peer, presence } = data as { peer: string; presence: Presence }
          set((s) => ({ presence: { ...s.presence, [peer]: presence } }))
          break
        }

        case 'invite': {
          const { from, room } = data as { from: Peer; room: string }
          pushToast({
            kind: 'invite',
            message: `${from.persona} invited you to a call`,
            roomId: room,
            from,
          })
          break
        }

        case 'mixer':
          set({ mixer: data as MixerSnapshot })
          break

        case 'file.offer': {
          const offer = data as { id: number; from: string; name: string; size: number }
          set((s) => ({
            transfers: [
              ...s.transfers,
              {
                id: offer.id,
                direction: 'in',
                name: offer.name,
                size: offer.size,
                transferred: 0,
                peer: offer.from,
                state: 'offered',
              },
            ],
          }))
          break
        }

        case 'file.progress': {
          const progress = data as { id: number; transferred: number; size: number }
          set((s) => ({
            transfers: s.transfers.map((t) =>
              t.id === progress.id
                ? { ...t, transferred: progress.transferred, state: 'active' }
                : t,
            ),
          }))
          break
        }

        case 'file.done': {
          const done = data as { id: number; path: string }
          set((s) => ({
            transfers: s.transfers.map((t) =>
              t.id === done.id ? { ...t, state: 'done', path: done.path } : t,
            ),
          }))
          break
        }

        case 'error': {
          const { message, fatal } = data as { message: string; fatal?: boolean }
          log(`core error${fatal ? ' (fatal)' : ''}: ${message}`)
          if (fatal) set({ fatal: message })
          else pushToast({ kind: 'error', message })
          break
        }
      }
    })

    // `ready` fires once, when the daemon starts. A renderer reload misses it
    // entirely — and without this the mesh would never be built and no call
    // would ever connect.
    try {
      const info = await rpc<AppInfo>('app.info')
      set({ info, me: info.me })
      ensureMesh(info)
      // A reload during a call: rebuild the mesh from the room the daemon is
      // still in, which it will not announce again on its own.
      if (info.room) applyRoom(info.room, info.conversation ?? null)
    } catch (err) {
      // Daemon not up yet; its own `ready` event will do this instead.
      log(`app.info failed, waiting for the daemon's ready event — ${err}`)
    }

    // Same reasoning as the friends list below: the daemon pushes the
    // conversation list when something changes, and "the window just opened" is
    // not something it can see.
    await get().refreshConversations()

    // The daemon pushes the friends list once, at its own startup — which is
    // before this window exists, so that first push lands nowhere. After it the
    // list is only re-sent when something about a friend actually changes,
    // which is why the sidebar could sit empty until an unrelated Steam event
    // (accepting an invite, a friend launching a game) shook it loose. Ask.
    await get().refreshFriends()
  },

  async sendChat(text) {
    const trimmed = text.trim()
    if (!trimmed) return

    const me = get().me
    const id = chatSeq++
    // Shown before it is sent, and corrected when the daemon reports back:
    // a chat that waits for a round trip to echo feels broken even when it
    // is working.
    set((s) => ({
      chat: [
        ...s.chat,
        {
          id,
          from: me?.id ?? '',
          persona: me?.persona ?? 'You',
          text: trimmed,
          at: Date.now(),
          mine: true,
          delivery: 'sending',
        },
      ],
    }))

    try {
      await rpc('chat.send', { id, text: trimmed })
    } catch (err) {
      log(`chat.send failed — ${err}`)
      set((s) => ({
        chat: s.chat.map((m) => (m.id === id ? { ...m, delivery: 'failed' } : m)),
      }))
    }
  },

  async refreshConversations() {
    try {
      set({ conversations: await rpc<Conversation[]>('conv.list') })
    } catch (err) {
      log(`conv.list failed — ${err}`)
    }
  },

  async selectConversation(id) {
    set({ selected: id })
    if (!id) return

    // Load the tail once and keep it. Re-fetching on every visit would throw
    // away the scrollback the user just paged through.
    if (!get().messages[id]) {
      try {
        const page = await rpc<{ messages: StoredMessage[]; exhausted: boolean }>(
          'conv.history',
          { id },
        )
        set((s) => ({
          messages: { ...s.messages, [id]: page.messages },
          historyDone: { ...s.historyDone, [id]: page.exhausted },
        }))
      } catch (err) {
        log(`conv.history for ${id} failed — ${err}`)
      }
    }

    await rpc('conv.markRead', { id }).catch((err) => log(`conv.markRead failed — ${err}`))
    await get().refreshConversations()
  },

  async loadMoreHistory(id) {
    const loaded = get().messages[id]
    if (!loaded || loaded.length === 0 || get().historyDone[id]) return
    // A scroll produces a burst of events, and every one of them would ask for
    // the same page with the same cursor.
    if (loadingHistory.has(id)) return
    loadingHistory.add(id)

    const oldest = loaded[0]
    const before: HistoryCursor = { at: oldest.at, author: oldest.author, seq: oldest.seq }
    try {
      const page = await rpc<{ messages: StoredMessage[]; exhausted: boolean }>('conv.history', {
        id,
        before,
      })
      set((s) => ({
        messages: { ...s.messages, [id]: mergeMessages(s.messages[id] ?? [], page.messages) },
        historyDone: { ...s.historyDone, [id]: page.exhausted },
      }))
    } catch (err) {
      log(`conv.history for ${id} failed — ${err}`)
    } finally {
      loadingHistory.delete(id)
    }
  },

  async createServer(name) {
    const { id } = await rpc<{ id: string }>('servers.create', { name })
    await get().refreshConversations()
    await get().selectConversation(id)
  },

  async inviteToServer(conversationId, peerId) {
    await rpc('servers.invite', { id: conversationId, to: peerId })
  },

  async leaveServer(id) {
    await rpc('servers.leave', { id })
    set((s) => {
      const messages = { ...s.messages }
      delete messages[id]
      return { messages, selected: s.selected === id ? null : s.selected }
    })
    await get().refreshConversations()
  },

  async openDm(peerId) {
    const { id } = await rpc<{ id: string }>('dm.open', { with: peerId })
    await get().refreshConversations()
    await get().selectConversation(id)
  },

  async sendMessage(conversationId, text) {
    const trimmed = text.trim()
    if (!trimmed) return
    try {
      // The daemon writes it, then echoes it back as `conv.message`. No
      // optimistic copy here, unlike the ad-hoc chat: this one is on disk
      // before it is on the wire, so the round trip is a local write and not a
      // network one.
      await rpc('conv.send', { id: conversationId, text: trimmed })
    } catch (err) {
      log(`conv.send failed — ${err}`)
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: toastSeq++, kind: 'error', message: `Message not sent: ${err}` },
        ],
      }))
    }
  },

  async startServerCall(id) {
    const conversation = get().conversations.find((c) => c.id === id)
    await rpc('server.call.start', { id, name: conversation?.name ?? 'Hollow' })
  },

  async joinServerCall(id) {
    await rpc('server.call.join', { id })
  },

  async respondToServerInvite(toast, accept) {
    get().dismissToast(toast.id)
    if (!toast.serverId) return
    try {
      await rpc(accept ? 'servers.accept' : 'servers.decline', { id: toast.serverId })
      await get().refreshConversations()
      if (accept) await get().selectConversation(toast.serverId)
    } catch (err) {
      log(`server invite response failed — ${err}`)
    }
  },

  async sendFilesTo(peerId) {
    const paths = await window.hollow.pickFiles()
    if (paths.length === 0) return
    await get().sendFiles(peerId, paths)
  },

  async refreshFriends() {
    await rpc('friends.refresh').catch((err) => log(`friends.refresh failed — ${err}`))
  },

  async openLog() {
    await window.hollow.log.open()
  },

  async revealLog() {
    await window.hollow.log.reveal()
  },

  /**
   * Everything worth pasting into a bug report, in one go.
   *
   * The point is that a report is complete without anyone knowing what to
   * include: build, backend, what every link settled on, and the tail of the
   * log from all three processes.
   */
  async copyReport() {
    const { info, room, me, health, settings, peerMuted } = get()
    const lines: string[] = [
      `Hollow ${info?.version ?? '?'} — ${info?.backend ?? '?'} backend, app id ${info?.appId ?? '?'}`,
      `Windows build ${info?.capabilities.windowsBuild ?? '?'}, per-process capture ${
        info?.capabilities.perProcessCapture ? 'yes' : 'no'
      }`,
      `Room: ${room ? `${room.name} (${room.members.length}/${room.maxMembers})` : 'none'}`,
      // "They sound quiet" and "they are at 40% here" are the same report until
      // one of them is written down.
      `Microphone boost: ${Math.round(settings.micBoost * 100)}%`,
      '',
      'Links:',
    ]

    const peers = (room?.members ?? []).filter((m) => m.id !== me?.id)
    if (peers.length === 0) lines.push('  (nobody else in the room)')
    for (const peer of peers) {
      const link = health[peer.id]
      const heard = peerMuted[peer.id]
        ? ', silenced here'
        : settings.peerVolume[peer.id] !== undefined
          ? `, played at ${Math.round(settings.peerVolume[peer.id] * 100)}%`
          : ''
      if (!link) {
        lines.push(`  ${peer.persona}: no link${heard}`)
        continue
      }
      const candidates = Object.entries(link.candidates)
        .map(([kind, count]) => `${kind}x${count}`)
        .join(' ')
      lines.push(
        `  ${peer.persona}: ${link.connection}/${link.ice}, ` +
          `${link.negotiated ? 'negotiated' : 'NOT negotiated'}, ` +
          `receiving [${link.receiving.join(' ') || 'nothing'}], ` +
          `route ${link.quality.route}, rtt ${link.quality.rttMs}ms, ` +
          `loss ${(link.quality.loss * 100).toFixed(1)}%, ` +
          `up ${Math.round(link.quality.outBps / 1000)}kbps down ${Math.round(
            link.quality.inBps / 1000,
          )}kbps, avail ${Math.round(link.quality.availableBps / 1000)}kbps, ` +
          `offers unanswered ${link.unansweredOffers}, candidates ${candidates || 'none'}` +
          heard,
      )
    }

    lines.push('', 'Log:', await window.hollow.log.tail(200))

    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      return true
    } catch (err) {
      log(`could not write the report to the clipboard — ${err}`)
      return false
    }
  },

  async createRoom(name) {
    log('room: creating')
    await rpc('room.create', { name, maxMembers: 6 })
  },

  async joinRoom(id) {
    log(`room: joining ${id}`)
    await rpc('room.join', { id })
  },

  async leaveRoom() {
    await get().stopShare()
    const { local } = get()
    // The track we sent is the far end of the gain chain, so stopping it frees
    // nothing — only the chain owns the device.
    micSource?.stop()
    micSource = null
    local.camera?.stop()
    await mesh?.setLocalTrack('mic', null)
    await mesh?.setLocalTrack('camera', null)
    set({
      local: {},
      localPresence: {
        micMuted: true,
        deafened: false,
        cameraOn: false,
        sharingScreen: false,
        sharingAudio: false,
      },
    })
    await rpc('room.leave')
  },

  async inviteFriend(id) {
    await rpc('room.invite', { id })
  },

  async openInviteOverlay() {
    await rpc('room.inviteOverlay')
  },

  async toggleMic() {
    const { local, localPresence, settings } = get()

    if (local.mic) {
      // Keep the track, flip its enabled flag: reacquiring the device on every
      // toggle costs hundreds of milliseconds and can pop.
      const muted = !localPresence.micMuted
      local.mic.enabled = !muted
      const presence = { ...localPresence, micMuted: muted }
      set({ localPresence: presence })
      await rpc('presence.set', presence)
      return
    }

    try {
      // A chain left over from a failed open would keep the device to itself.
      micSource?.stop()
      micSource = await openMicrophone(settings.microphoneId, settings.micBoost)
      await mesh?.setLocalTrack('mic', micSource.track)
      const presence = { ...localPresence, micMuted: false }
      set({ local: { ...local, mic: micSource.track }, localPresence: presence })
      await rpc('presence.set', presence)
    } catch (err) {
      log(`microphone failed — ${err}`)
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: toastSeq++, kind: 'error', message: `Microphone unavailable: ${err}` },
        ],
      }))
    }
  },

  async toggleDeafen() {
    const { localPresence } = get()
    const deafened = !localPresence.deafened

    // Deafening implies muting: hearing nobody while they still hear you is a
    // trap people fall into once and never forgive.
    const presence = {
      ...localPresence,
      deafened,
      micMuted: deafened ? true : localPresence.micMuted,
    }
    const mic = get().local.mic
    if (mic) mic.enabled = !presence.micMuted

    set({ localPresence: presence })
    await rpc('presence.set', presence)
  },

  async toggleCamera() {
    const { local, localPresence, settings } = get()

    if (local.camera) {
      local.camera.stop()
      await mesh?.setLocalTrack('camera', null)
      const presence = { ...localPresence, cameraOn: false }
      const next = { ...local }
      delete next.camera
      set({ local: next, localPresence: presence })
      await rpc('presence.set', presence)
      return
    }

    try {
      const track = await openCamera(settings.cameraId)
      await mesh?.setLocalTrack('camera', track)
      const presence = { ...localPresence, cameraOn: true }
      set({ local: { ...local, camera: track }, localPresence: presence })
      await rpc('presence.set', presence)
    } catch (err) {
      log(`camera failed — ${err}`)
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: toastSeq++, kind: 'error', message: `Camera unavailable: ${err}` },
        ],
      }))
    }
  },

  async openPicker() {
    const sources = await window.hollow.screen.sources()
    set({ screenSources: sources, pickerOpen: true })
  },

  closePicker() {
    set({ pickerOpen: false })
  },

  async startShare(sourceId) {
    const { info, settings, local, localPresence } = get()
    set({ pickerOpen: false })

    const perProcess = info?.capabilities.perProcessCapture ?? false
    const wantsAudio = systemAudioWanted(settings.systemAudio, perProcess)

    try {
      const video = await openScreen(sourceId, settings.screenFrameRate, settings.screenHeight)
      await mesh?.setLocalTrack('screen', video)

      let audioTrack: MediaStreamTrack | null = null

      // Broadcast audio always comes from the daemon, in both capture modes.
      // It is the only source that can be shaped without touching what this
      // machine is playing: the gains live in the mixer thread, on the way out.
      if (wantsAudio && info) {
        await rpc('audio.start')
        await rpc('audio.master', { gain: settings.broadcastGain })
        audioTrack = await broadcastAudio.start(info.audioPipe)
      }

      if (audioTrack) await mesh?.setLocalTrack('screenAudio', audioTrack)

      // The user stopping the share from Windows' own overlay must be honoured.
      video.onended = () => void get().stopShare()

      const presence = {
        ...localPresence,
        sharingScreen: true,
        sharingAudio: Boolean(audioTrack),
      }
      set({
        local: {
          ...local,
          screen: video,
          ...(audioTrack ? { screenAudio: audioTrack } : {}),
        },
        localPresence: presence,
        mixerOpen: true,
      })
      await rpc('presence.set', presence)
    } catch (err) {
      log(`screen share failed — ${err}`)
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: toastSeq++, kind: 'error', message: `Could not start sharing: ${err}` },
        ],
      }))
    }
  },

  async stopShare() {
    const { local, localPresence } = get()
    if (!local.screen && !local.screenAudio) return

    local.screen?.stop()
    local.screenAudio?.stop()
    await mesh?.setLocalTrack('screen', null)
    await mesh?.setLocalTrack('screenAudio', null)
    await broadcastAudio.stop()
    await rpc('audio.stop').catch(() => {})

    const next = { ...local }
    delete next.screen
    delete next.screenAudio
    const presence = { ...localPresence, sharingScreen: false, sharingAudio: false }
    set({ local: next, localPresence: presence, mixerOpen: false })
    await rpc('presence.set', presence).catch(() => {})
  },

  async setGain(pid, gain, muted) {
    const gains = { ...get().gains, [pid]: { gain, muted } }
    set({ gains })
    const tracks = Object.entries(gains).map(([key, value]) => ({
      pid: Number(key),
      gain: value.gain,
      muted: value.muted,
    }))
    await rpc('audio.tracks', { tracks })
  },

  /**
   * Start or stop sending the machine's audio, without interrupting the share.
   *
   * The switch for this sits in the mixer, which opens the moment a share
   * starts — so "not until you share again" would be the wrong answer to
   * flicking it. `replaceTrack` needs no renegotiation, so the video never
   * stutters for it.
   */
  async refreshBroadcastAudio() {
    const { info, settings, local, localPresence } = get()
    if (!info || !localPresence.sharingScreen) return

    const wanted = systemAudioWanted(settings.systemAudio, info.capabilities.perProcessCapture)
    if (wanted === Boolean(local.screenAudio)) return

    if (wanted) {
      await rpc('audio.start')
      await rpc('audio.master', { gain: settings.broadcastGain })
      const track = await broadcastAudio.start(info.audioPipe)
      await mesh?.setLocalTrack('screenAudio', track)
      set((s) => ({
        local: { ...s.local, screenAudio: track },
        localPresence: { ...s.localPresence, sharingAudio: true },
      }))
    } else {
      local.screenAudio?.stop()
      await mesh?.setLocalTrack('screenAudio', null)
      await broadcastAudio.stop()
      await rpc('audio.stop').catch(() => {})
      set((s) => {
        const next = { ...s.local }
        delete next.screenAudio
        return { local: next, localPresence: { ...s.localPresence, sharingAudio: false } }
      })
    }
    await rpc('presence.set', get().localPresence).catch(() => {})
  },

  async setMasterGain(gain) {
    get().updateSettings({ broadcastGain: clampGain(gain, BROADCAST_GAIN_MAX) })
    await rpc('audio.master', { gain: get().settings.broadcastGain })
  },

  setMicBoost(boost) {
    get().updateSettings({ micBoost: clampGain(boost, MIC_BOOST_MAX) })
    // The chain is already negotiated and sending; this only moves a gain node,
    // so a boost changed mid-sentence is heard on the next word.
    micSource?.setBoost(get().settings.micBoost)
  },

  setPeerVolume(peerId, volume) {
    const next = clampGain(volume, PEER_VOLUME_MAX)
    const peerVolume = { ...get().settings.peerVolume }
    if (next === 1) delete peerVolume[peerId]
    else peerVolume[peerId] = next
    get().updateSettings({ peerVolume })
  },

  togglePeerMuted(peerId) {
    set((s) => ({ peerMuted: { ...s.peerMuted, [peerId]: !s.peerMuted[peerId] } }))
  },

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    mesh?.setIceServers(iceServers(settings))

    const screen = get().local.screen
    if (screen && (patch.screenFrameRate !== undefined || patch.screenHeight !== undefined)) {
      void retuneScreen(screen, settings.screenFrameRate, settings.screenHeight)
    }
    if (patch.systemAudio !== undefined) void get().refreshBroadcastAudio()
  },

  setFocus(key) {
    // Enlarging a window that was folded away is a request to see it.
    set((s) => ({ focus: key, minimized: s.minimized.filter((other) => other !== key) }))
  },

  toggleMinimized(key) {
    set((s) => ({
      minimized: s.minimized.includes(key)
        ? s.minimized.filter((other) => other !== key)
        : [...s.minimized, key],
      focus: s.focus === key ? null : s.focus,
    }))
  },

  toggle(panel) {
    // One panel at a time: the layout has a single column for them, and two
    // open at once would just push the stage out of the window.
    set((s) => {
      const open = !s[`${panel}Open` as const]
      return {
        settingsOpen: panel === 'settings' && open,
        mixerOpen: panel === 'mixer' && open,
        chatOpen: panel === 'chat' && open,
        // Opening it is reading it.
        chatUnread: panel === 'chat' && open ? 0 : s.chatUnread,
      }
    })
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  async acceptInvite(toast) {
    get().dismissToast(toast.id)
    if (toast.roomId) await get().joinRoom(toast.roomId)
  },

  async sendFiles(to, paths) {
    try {
      await rpc('files.send', { to, paths })
    } catch (err) {
      // Worth saying out loud. Outside a call this is the only feedback there
      // is: nothing appears in the transfer strip until the other side accepts,
      // so a silent failure looks exactly like a friend who has not answered.
      log(`files.send to ${to} failed — ${err}`)
      set((s) => ({
        toasts: [
          ...s.toasts,
          { id: toastSeq++, kind: 'error', message: `Could not send: ${err}` },
        ],
      }))
    }
  },

  async respondToOffer(id, accept) {
    await rpc(accept ? 'files.accept' : 'files.reject', { id })
    set((s) => ({
      transfers: accept
        ? s.transfers.map((t) => (t.id === id ? { ...t, state: 'active' } : t))
        : s.transfers.filter((t) => t.id !== id),
    }))
  },

  dismissTransfer(id) {
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) }))
  },
}))

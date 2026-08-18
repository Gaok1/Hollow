import { create } from 'zustand'
import { Mesh, type LinkHealth } from './lib/mesh'
import { BroadcastAudio, openCamera, openMicrophone, openScreen } from './lib/media'
import type {
  AppInfo,
  FileTransfer,
  MixerSnapshot,
  Peer,
  Presence,
  Room,
  ScreenSource,
  TrackSlot,
} from './types'

/**
 * The mesh holds live `RTCPeerConnection`s and must not be recreated on render,
 * so it lives beside the store rather than in it.
 */
let mesh: Mesh | null = null
const broadcastAudio = new BroadcastAudio()

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

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'invite'
  message: string
  /** Present on invites: accepting joins this room. */
  roomId?: string
  from?: Peer
}

export interface Settings {
  microphoneId?: string
  cameraId?: string
  /** Screen share frame rate. 60 for motion, 15 for reading documents. */
  screenFrameRate: number
  /** Optional TURN relay for peers behind symmetric NAT. */
  turnUrl?: string
  turnUsername?: string
  turnCredential?: string
}

const DEFAULT_SETTINGS: Settings = { screenFrameRate: 30 }

const SETTINGS_KEY = 'hollow.settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS
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

interface State {
  info: AppInfo | null
  me: Peer | null
  friends: Peer[]
  room: Room | null
  /** Remote presence, keyed by SteamID64. */
  presence: Record<string, Presence>
  /** What each link is doing, keyed by SteamID64. Drives every status the UI shows. */
  health: Record<string, LinkHealth>
  remoteTracks: Record<string, Partial<Record<TrackSlot, MediaStreamTrack>>>

  local: Partial<Record<TrackSlot, MediaStreamTrack>>
  localPresence: Presence
  /** Which peer's screen fills the stage; null picks automatically. */
  pinned: string | null

  mixer: MixerSnapshot | null
  /** Broadcast gains, keyed by pid. */
  gains: Record<number, { gain: number; muted: boolean }>

  screenSources: ScreenSource[]
  pickerOpen: boolean
  settingsOpen: boolean
  mixerOpen: boolean
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
  setSessionVolume(pid: number, volume: number, muted: boolean): Promise<void>
  setMasterGain(gain: number): Promise<void>

  refreshFriends(): Promise<void>
  openLog(): Promise<void>
  revealLog(): Promise<void>
  updateSettings(patch: Partial<Settings>): void
  setPinned(peerId: string | null): void
  toggle(panel: 'settings' | 'mixer'): void
  dismissToast(id: number): void
  acceptInvite(toast: Toast): Promise<void>
  sendFiles(to: string, paths: string[]): Promise<void>
  respondToOffer(id: number, accept: boolean): Promise<void>
  dismissTransfer(id: number): void
}

let toastSeq = 1

export const useStore = create<State>((set, get) => ({
  info: null,
  me: null,
  friends: [],
  room: null,
  presence: {},
  health: {},
  remoteTracks: {},
  local: {},
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
    const applyRoom = (room: Room | null) => {
      const previous = get().room
      set({ room })

      if (!room) {
        log('room: left')
        mesh?.closeAll()
        set({ remoteTracks: {}, health: {}, presence: {}, pinned: null })
        void get().stopShare()
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
      if (toast.kind !== 'invite') {
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

        case 'room':
          applyRoom(data as Room | null)
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
            return { remoteTracks, health, pinned: s.pinned === id ? null : s.pinned }
          })
          break
        }

        case 'signal': {
          const { from, payload: signalPayload } = data as { from: string; payload: unknown }
          void mesh?.handleSignal(from, signalPayload)
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
      if (info.room) applyRoom(info.room)
    } catch (err) {
      // Daemon not up yet; its own `ready` event will do this instead.
      log(`app.info failed, waiting for the daemon's ready event — ${err}`)
    }

    // The daemon pushes the friends list once, at its own startup — which is
    // before this window exists, so that first push lands nowhere. After it the
    // list is only re-sent when something about a friend actually changes,
    // which is why the sidebar could sit empty until an unrelated Steam event
    // (accepting an invite, a friend launching a game) shook it loose. Ask.
    await get().refreshFriends()
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
    local.mic?.stop()
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
      const track = await openMicrophone(settings.microphoneId)
      await mesh?.setLocalTrack('mic', track)
      const presence = { ...localPresence, micMuted: false }
      set({ local: { ...local, mic: track }, localPresence: presence })
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

    // Per-process capture means the Rust mixer owns broadcast audio and can
    // include or exclude individual apps. Without it, Electron's whole-system
    // loopback is the only option available.
    const perProcess = info?.capabilities.perProcessCapture ?? false

    try {
      const capture = await openScreen(sourceId, !perProcess, settings.screenFrameRate)
      await mesh?.setLocalTrack('screen', capture.video)

      let audioTrack: MediaStreamTrack | null = capture.audio

      if (perProcess && info) {
        await rpc('audio.start')
        audioTrack = await broadcastAudio.start(info.audioPipe)
      } else {
        // Even without per-process capture the mixer panel is useful: it drives
        // the Windows session volumes, which is what shapes the loopback mix.
        await rpc('audio.start')
      }

      if (audioTrack) await mesh?.setLocalTrack('screenAudio', audioTrack)

      // The user stopping the share from Windows' own overlay must be honoured.
      capture.video.onended = () => void get().stopShare()

      const presence = {
        ...localPresence,
        sharingScreen: true,
        sharingAudio: Boolean(audioTrack),
      }
      set({
        local: {
          ...local,
          screen: capture.video,
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

  async setSessionVolume(pid, volume, muted) {
    await rpc('audio.session', { pid, volume, muted })
  },

  async setMasterGain(gain) {
    await rpc('audio.master', { gain })
  },

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch }
    set({ settings })
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    mesh?.setIceServers(iceServers(settings))
  },

  setPinned(peerId) {
    set({ pinned: peerId })
  },

  toggle(panel) {
    if (panel === 'settings') set((s) => ({ settingsOpen: !s.settingsOpen, mixerOpen: false }))
    else set((s) => ({ mixerOpen: !s.mixerOpen, settingsOpen: false }))
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  async acceptInvite(toast) {
    get().dismissToast(toast.id)
    if (toast.roomId) await get().joinRoom(toast.roomId)
  },

  async sendFiles(to, paths) {
    await rpc('files.send', { to, paths })
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

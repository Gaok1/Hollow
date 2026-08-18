/** Mirrors the Rust types crossing the JSON boundary. */

export type PersonaState =
  | 'offline'
  | 'online'
  | 'busy'
  | 'away'
  | 'snooze'
  | 'lookingtotrade'
  | 'lookingtoplay'

export interface Peer {
  /** SteamID64 as a string — it exceeds JavaScript's safe integer range. */
  id: string
  persona: string
  state: PersonaState
  avatar?: string
  inHollow: boolean
}

export interface Presence {
  micMuted: boolean
  deafened: boolean
  cameraOn: boolean
  sharingScreen: boolean
  sharingAudio: boolean
}

export interface Room {
  id: string
  owner: string
  name: string
  members: Peer[]
  maxMembers: number
}

export type CaptureMode = 'perProcess' | 'systemLoopback' | 'off'

export interface Capabilities {
  windowsBuild: number
  perProcessCapture: boolean
  note: string
}

export interface AppAudioSession {
  id: string
  pid: number
  name: string
  executable?: string
  icon?: string
  peak: number
  volume: number
  muted: boolean
  active: boolean
  broadcast: boolean
}

export interface MixerSnapshot {
  mode: CaptureMode
  sessions: AppAudioSession[]
  masterPeak: number
  masterGain: number
}

export interface AppInfo {
  me: Peer
  backend: 'steam' | 'mock'
  backendNote: string
  appId: number
  capabilities: Capabilities
  audioPipe: string
  downloadDir: string
  version: string
  /** The call already in progress, when the renderer reloads mid-call. */
  room?: Room | null
  /** Which server that call belongs to, if any. */
  conversation?: string | null
}

/**
 * A server or a direct message.
 *
 * Both are the same thing to everything below the UI: a list of people and a
 * transcript that survives the app closing. A server has a name and an owner; a
 * DM is named after whoever is on the other end.
 */
export interface Conversation {
  id: string
  kind: 'server' | 'dm'
  name: string
  owner?: string
  createdAt: number
  members: Peer[]
  unread: number
  /** The lobby of the call running in here, or null when nobody is talking. */
  call: string | null
}

/**
 * One stored message.
 *
 * Identified by author and `seq` rather than by anything global: see the Rust
 * side for why. `at` is the author's clock and is used only for ordering.
 */
export interface StoredMessage {
  author: string
  seq: number
  at: number
  text: string
}

/** Where a page of scrollback starts, reading backwards. */
export interface HistoryCursor {
  at: number
  author: string
  seq: number
}

/** An invitation to a server, waiting for the user to decide. */
export interface ServerInvite {
  id: string
  name: string
  from: string
}

export interface ScreenSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail: string | null
  appIcon: string | null
}

/** Which slot a media track occupies in the fixed transceiver layout. */
export type TrackSlot = 'mic' | 'screenAudio' | 'camera' | 'screen'

export interface FileTransfer {
  id: number
  direction: 'in' | 'out'
  name: string
  size: number
  transferred: number
  peer: string
  state: 'offered' | 'active' | 'done' | 'rejected' | 'cancelled'
  path?: string
}

declare global {
  interface Window {
    hollow: {
      request(method: string, params?: unknown): Promise<unknown>
      onEvent(handler: (event: string, data: unknown) => void): () => void
      getFilePath(file: File): string
      pickFiles(): Promise<string[]>
      screen: {
        sources(): Promise<ScreenSource[]>
        choose(sourceId: string | null): Promise<void>
      }
      audio: {
        connect(pipeName: string): Promise<void>
        disconnect(): Promise<void>
        onPcm(handler: (chunk: ArrayBuffer) => void): () => void
      }
      log: {
        write(line: string): void
        open(): Promise<void>
        tail(lines: number): Promise<string>
        reveal(): Promise<void>
      }
      window: {
        minimize(): Promise<void>
        maximize(): Promise<void>
        close(): Promise<void>
        onStateChange(handler: (maximized: boolean) => void): () => void
      }
    }
  }
}

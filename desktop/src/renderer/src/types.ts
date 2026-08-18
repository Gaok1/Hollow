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
      screen: {
        sources(): Promise<ScreenSource[]>
        choose(sourceId: string | null): Promise<void>
      }
      audio: {
        connect(pipeName: string): Promise<void>
        disconnect(): Promise<void>
        onPcm(handler: (chunk: ArrayBuffer) => void): () => void
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

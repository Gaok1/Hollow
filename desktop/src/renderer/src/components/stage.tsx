import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { meterTrack } from '../lib/media'
import type { Peer, TrackSlot } from '../types'
import { Avatar } from './sidebar'
import { MicOffIcon, PinIcon, ScreenIcon, SpeakerIcon } from './icons'

/** Binds a track to a media element and keeps it bound as the track changes. */
function useTrack<T extends HTMLMediaElement>(track: MediaStreamTrack | undefined) {
  const ref = useRef<T>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (!track) {
      element.srcObject = null
      return
    }
    element.srcObject = new MediaStream([track])
    // Autoplay can still be refused if the window has never been interacted
    // with; the call button counts, so this is belt and braces.
    element.play().catch(() => {})
  }, [track])

  return ref
}

/** Remote audio never has a visible element, but it does have to be played. */
function RemoteAudio({ track, muted }: { track: MediaStreamTrack | undefined; muted: boolean }) {
  const ref = useTrack<HTMLAudioElement>(track)
  useEffect(() => {
    if (ref.current) ref.current.muted = muted
  }, [muted, ref])
  return <audio ref={ref} autoPlay />
}

function useSpeaking(track: MediaStreamTrack | undefined): boolean {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!track) {
      setLevel(0)
      return
    }
    return meterTrack(track, setLevel)
  }, [track])

  // Low enough to catch normal speech, high enough to ignore fan noise.
  return level > 0.08
}

interface TileProps {
  peer: Peer
  video?: MediaStreamTrack
  audio?: MediaStreamTrack
  micMuted: boolean
  sharing: boolean
  isSelf: boolean
  compact?: boolean
  onPin?: () => void
}

function Tile({ peer, video, audio, micMuted, sharing, isSelf, compact, onPin }: TileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  const speaking = useSpeaking(isSelf ? undefined : audio)
  const connection = useStore((s) => s.connection[peer.id])

  // Only worth saying something while it is not working. A settled connection
  // needs no badge.
  const status =
    isSelf || connection === 'connected' || connection === undefined
      ? null
      : connection === 'failed'
        ? 'Reconnecting'
        : connection === 'disconnected'
          ? 'Unstable'
          : 'Connecting'

  return (
    <div
      className={`tile ${compact ? 'tile--compact' : ''} ${speaking ? 'tile--speaking' : ''}`}
      onDoubleClick={onPin}
    >
      {status && <span className="tile__status">{status}</span>}
      {video ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Our own camera is a mirror; everyone else's is not.
          className={isSelf ? 'tile__video tile__video--mirrored' : 'tile__video'}
          muted
        />
      ) : (
        <div className="tile__placeholder">
          <Avatar peer={peer} size={compact ? 40 : 72} />
        </div>
      )}

      <div className="tile__overlay">
        <span className="tile__name">
          {peer.persona}
          {isSelf && <span className="tile__you">you</span>}
        </span>
        <span className="tile__badges">
          {sharing && <ScreenIcon size={14} />}
          {micMuted ? <MicOffIcon size={14} className="muted" /> : speaking && <SpeakerIcon size={14} />}
        </span>
      </div>
    </div>
  )
}

export function Stage() {
  const me = useStore((s) => s.me)
  const room = useStore((s) => s.room)
  const remoteTracks = useStore((s) => s.remoteTracks)
  const presence = useStore((s) => s.presence)
  const local = useStore((s) => s.local)
  const localPresence = useStore((s) => s.localPresence)
  const pinned = useStore((s) => s.pinned)
  const setPinned = useStore((s) => s.setPinned)
  const createRoom = useStore((s) => s.createRoom)

  const members = room?.members ?? []

  /**
   * Whoever is sharing takes the stage. An explicit pin wins; otherwise the
   * first active share does, which is the right guess in the overwhelmingly
   * common case of exactly one person presenting.
   */
  const presenter = useMemo(() => {
    if (pinned) return pinned
    if (localPresence.sharingScreen) return me?.id ?? null
    const sharer = members.find((m) => presence[m.id]?.sharingScreen)
    return sharer?.id ?? null
  }, [pinned, localPresence.sharingScreen, members, presence, me])

  const presenterTrack: MediaStreamTrack | undefined =
    presenter === me?.id ? local.screen : remoteTracks[presenter ?? '']?.screen

  const presenterRef = useTrack<HTMLVideoElement>(presenterTrack)

  const trackFor = (peerId: string, slot: TrackSlot): MediaStreamTrack | undefined =>
    peerId === me?.id
      ? (local[slot] as MediaStreamTrack | undefined)
      : remoteTracks[peerId]?.[slot]

  if (!room) {
    return (
      <section className="stage stage--idle">
        <div className="idle">
          <h1>Nobody's here yet</h1>
          <p>
            Start a call and invite friends from your Steam list. Everything runs peer to peer —
            no server sits between you.
          </p>
          <button className="btn btn--primary" onClick={() => createRoom('Hollow')}>
            Start a call
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="stage">
      {/* Remote audio, always mounted so it survives layout changes. */}
      <div className="audio-sinks" aria-hidden>
        {members
          .filter((m) => m.id !== me?.id)
          .map((m) => (
            <div key={m.id}>
              <RemoteAudio track={remoteTracks[m.id]?.mic} muted={localPresence.deafened} />
              <RemoteAudio track={remoteTracks[m.id]?.screenAudio} muted={localPresence.deafened} />
            </div>
          ))}
      </div>

      {presenterTrack ? (
        <div className="presenter">
          <video ref={presenterRef} autoPlay playsInline muted className="presenter__video" />
          <div className="presenter__label">
            <ScreenIcon size={14} />
            {members.find((m) => m.id === presenter)?.persona ?? 'Someone'} is sharing
            {pinned && (
              <button className="btn btn--ghost btn--tiny" onClick={() => setPinned(null)}>
                Unpin
              </button>
            )}
          </div>

          <div className="filmstrip">
            {members.map((member) => (
              <Tile
                key={member.id}
                compact
                peer={member}
                video={trackFor(member.id, 'camera')}
                audio={trackFor(member.id, 'mic')}
                micMuted={
                  member.id === me?.id
                    ? localPresence.micMuted
                    : (presence[member.id]?.micMuted ?? true)
                }
                sharing={
                  member.id === me?.id
                    ? localPresence.sharingScreen
                    : (presence[member.id]?.sharingScreen ?? false)
                }
                isSelf={member.id === me?.id}
                onPin={() => setPinned(member.id)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="grid" data-count={members.length}>
          {members.map((member) => (
            <Tile
              key={member.id}
              peer={member}
              video={trackFor(member.id, 'camera')}
              audio={trackFor(member.id, 'mic')}
              micMuted={
                member.id === me?.id
                  ? localPresence.micMuted
                  : (presence[member.id]?.micMuted ?? true)
              }
              sharing={
                member.id === me?.id
                  ? localPresence.sharingScreen
                  : (presence[member.id]?.sharingScreen ?? false)
              }
              isSelf={member.id === me?.id}
              onPin={() => setPinned(member.id)}
            />
          ))}
        </div>
      )}

      {members.length === 1 && (
        <div className="stage__hint">
          <PinIcon size={14} />
          You're the only one here. Invite a friend from the sidebar.
        </div>
      )}
    </section>
  )
}

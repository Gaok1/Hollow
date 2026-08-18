import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { meterTrack } from '../lib/media'
import type { LinkHealth } from '../lib/mesh'
import type { Peer, TrackSlot } from '../types'
import { Avatar } from './sidebar'
import { AlertIcon, MicOffIcon, PinIcon, ScreenIcon, SpeakerIcon } from './icons'

/**
 * How long a link may sit unconnected before Hollow stops saying "connecting"
 * and starts saying what is probably wrong. Long enough to cover a slow relay
 * handshake, short enough that nobody stares at a spinner wondering.
 */
const STUCK_MS = 12_000

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

/**
 * What to say about a link, in the two words a tile has room for.
 *
 * `connectionState` on its own cannot separate "they have not answered us" from
 * "we agreed and the media path is not coming up", and those fail for different
 * reasons — the first is signaling, the second is NAT. Saying which is the
 * difference between a user who can act and a user who can only wait.
 */
function tileStatus(health: LinkHealth | undefined): string | null {
  if (!health) return 'Connecting'
  switch (health.connection) {
    case 'connected': {
      // Connected is not the same as working. Loss is what is actually heard
      // as choppy audio, and latency is what is felt as people talking over
      // each other, so both are worth a word before anyone blames the app.
      const { loss, rttMs } = health.quality
      if (loss > 0.05) return `Losing ${Math.round(loss * 100)}%`
      if (rttMs > 300) return `${rttMs} ms delay`
      return null
    }
    case 'failed':
      return 'Reconnecting'
    case 'disconnected':
      return 'Unstable'
    case 'closed':
      return 'Disconnected'
    default:
      return health.negotiated ? 'Connecting' : 'No answer yet'
  }
}

/** Re-renders every second, so elapsed time can be shown without a prop drill. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/**
 * The banner that explains a call which is not working.
 *
 * Hollow's failure mode has always been silence: everybody sits in a room,
 * nobody hears anybody, and nothing on screen says whether the call setup never
 * arrived or the media path never opened. This says which, and what to do.
 */
function CallStatus() {
  const room = useStore((s) => s.room)
  const me = useStore((s) => s.me)
  const health = useStore((s) => s.health)
  const openLog = useStore((s) => s.openLog)
  const toggle = useStore((s) => s.toggle)

  const others = (room?.members ?? []).filter((m) => m.id !== me?.id)
  const pending = others.filter((m) => health[m.id]?.connection !== 'connected')
  const now = useNow(pending.length > 0)

  if (pending.length === 0) return null

  const names = pending.map((m) => m.persona).join(', ')
  const stuck = pending.some((m) => {
    const link = health[m.id]
    return !link || now - link.since > STUCK_MS
  })

  if (!stuck) {
    return (
      <div className="callstatus">
        <span className="callstatus__spinner" aria-hidden />
        Connecting to {names}…
      </div>
    )
  }

  // Nothing came back from them at all: the call setup itself is not crossing.
  const unanswered = pending.filter((m) => !health[m.id]?.negotiated)
  // STUN never produced a reflexive candidate, so nothing off this network can
  // be reached — a much narrower fault than "it did not connect".
  const noReflexive = pending.some((m) => {
    const link = health[m.id]
    return link !== undefined && link.candidates.srflx === undefined
  })

  return (
    <div className="callstatus callstatus--warn">
      <AlertIcon size={15} />
      <div className="callstatus__text">
        <strong>Still connecting to {names}.</strong>{' '}
        {unanswered.length > 0
          ? 'Their side has not answered, so the call setup is not getting through Steam. Both of you being on the latest version is the first thing to check.'
          : noReflexive
            ? 'The session was agreed but no route to them exists. This machine could not reach a STUN server, which usually means a firewall is blocking it.'
            : 'The session was agreed but no media path opened. Two peers both behind strict NAT need a TURN relay, which Settings can take.'}
      </div>
      <div className="callstatus__actions">
        <button className="btn btn--ghost btn--tiny" onClick={() => toggle('settings')}>
          Settings
        </button>
        <button className="btn btn--ghost btn--tiny" onClick={() => void openLog()}>
          Open log
        </button>
      </div>
    </div>
  )
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
  /** Their presence says the camera is on, whether or not the video arrived. */
  cameraOn: boolean
  isSelf: boolean
  compact?: boolean
  onPin?: () => void
}

function Tile({
  peer,
  video,
  audio,
  micMuted,
  sharing,
  cameraOn,
  isSelf,
  compact,
  onPin,
}: TileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  // Metered for everyone including ourselves: seeing your own ring light up is
  // the only way to know the microphone is picking anything up before you find
  // out from someone else that it never was.
  const speaking = useSpeaking(audio)
  const health = useStore((s) => s.health[peer.id])

  // Only worth saying something while it is not working. A settled connection
  // needs no badge.
  const status = isSelf ? null : tileStatus(health)

  // They turned the camera on and the frames are not here. That is a different
  // problem from a camera that is off, and it deserves different words.
  const awaitingVideo = !isSelf && cameraOn && !video && health?.connection === 'connected'

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
          {awaitingVideo && !compact && (
            <span className="tile__waiting">Camera on — no video arriving</span>
          )}
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
  const cameraOnFor = (peerId: string): boolean =>
    peerId === me?.id ? localPresence.cameraOn : (presence[peerId]?.cameraOn ?? false)

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
      <CallStatus />

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
                cameraOn={cameraOnFor(member.id)}
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
              cameraOn={cameraOnFor(member.id)}
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

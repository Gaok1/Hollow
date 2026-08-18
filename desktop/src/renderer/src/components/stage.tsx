import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { useStore } from '../store'
import {
  MIC_BOOST_MAX,
  MIC_BOOST_MIN,
  PEER_VOLUME_MAX,
  meterTrack,
  playRemoteTrack,
  type AudioSink,
} from '../lib/media'
import type { LinkHealth } from '../lib/mesh'
import type { Peer, TrackSlot } from '../types'
import { Avatar } from './sidebar'
import {
  AlertIcon,
  MicIcon,
  MicOffIcon,
  PinIcon,
  ScreenIcon,
  SpeakerIcon,
  SpeakerOffIcon,
} from './icons'

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

/**
 * Remote audio never has a visible element, but it does have to be played — at
 * whatever volume this end has decided this person needs.
 *
 * The element stays in the tree because the sink still needs it; what it does
 * not do any more is set the volume, since it cannot go above 100%.
 */
function RemoteAudio({ track, volume }: { track: MediaStreamTrack | undefined; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null)
  const sink = useRef<AudioSink | null>(null)
  // Read by the attach effect, which must not re-run when only the volume moves.
  const wanted = useRef(volume)
  wanted.current = volume

  useEffect(() => {
    const element = ref.current
    if (!element || !track) return
    const attached = playRemoteTrack(track, element)
    attached.setVolume(wanted.current)
    sink.current = attached
    return () => {
      sink.current = null
      attached.close()
    }
  }, [track])

  useEffect(() => {
    sink.current?.setVolume(volume)
  }, [volume])

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

interface MenuAt {
  peerId: string
  x: number
  y: number
}

/**
 * The right-click menu on a tile.
 *
 * Volume belongs on the person, not in a settings page: the question is always
 * "this one is too quiet", and the fastest way to say which one is to point at
 * them. Right-clicking a participant is where every other voice app has put
 * this, so it is also where people will look for it.
 *
 * Your own tile gets the microphone boost instead, because you have no incoming
 * audio to turn up — the thing that needs adjusting is what everyone else is
 * hearing.
 */
function PeerMenu({ peerId, x, y, onClose }: MenuAt & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const me = useStore((s) => s.me)
  const room = useStore((s) => s.room)
  const settings = useStore((s) => s.settings)
  const muted = useStore((s) => s.peerMuted[peerId] ?? false)
  const pinned = useStore((s) => s.pinned)
  const setPeerVolume = useStore((s) => s.setPeerVolume)
  const togglePeerMuted = useStore((s) => s.togglePeerMuted)
  const setMicBoost = useStore((s) => s.setMicBoost)
  const setPinned = useStore((s) => s.setPinned)
  const toggle = useStore((s) => s.toggle)
  const [at, setAt] = useState({ left: x, top: y })

  // Opened at the pointer, then pulled back inside the window. A menu that
  // spills off the bottom edge is a menu whose last item cannot be clicked.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const pad = 8
    setAt({
      left: Math.max(pad, Math.min(x, window.innerWidth - box.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - box.height - pad)),
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // Capture, so a click that lands on a button elsewhere still closes this.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const peer = room?.members.find((m) => m.id === peerId)
  // They left while the menu was open. Nothing left to adjust.
  if (!peer) return null

  const isSelf = peer.id === me?.id
  const volume = settings.peerVolume[peer.id] ?? 1

  return (
    <div className="menu" ref={ref} style={at} role="menu">
      <div className="menu__head">
        <Avatar peer={peer} size={22} />
        <span className="menu__name">{isSelf ? 'Your microphone' : peer.persona}</span>
      </div>

      {isSelf ? (
        <>
          <div className="menu__row">
            <MicIcon size={14} />
            <input
              className="slider"
              type="range"
              min={MIC_BOOST_MIN}
              max={MIC_BOOST_MAX}
              step={0.05}
              value={settings.micBoost}
              onChange={(e) => setMicBoost(Number(e.target.value))}
            />
            <span className="menu__value">{Math.round(settings.micBoost * 100)}%</span>
          </div>
          <p className="menu__hint">
            Changes what everyone else hears, not what you do. A limiter catches the peaks, so
            pushing this will not turn your voice into crackle.
          </p>
          {settings.micBoost !== 1 && (
            <button className="menu__item" onClick={() => setMicBoost(1)}>
              Reset to 100%
            </button>
          )}
          <button
            className="menu__item"
            onClick={() => {
              toggle('settings')
              onClose()
            }}
          >
            Open settings
          </button>
        </>
      ) : (
        <>
          <div className="menu__row">
            <button
              className="iconbtn"
              onClick={() => togglePeerMuted(peer.id)}
              aria-label={muted ? 'Unmute for me' : 'Mute for me'}
            >
              {muted ? <SpeakerOffIcon size={14} /> : <SpeakerIcon size={14} />}
            </button>
            <input
              className="slider"
              type="range"
              min={0}
              max={PEER_VOLUME_MAX}
              step={0.05}
              value={volume}
              disabled={muted}
              onChange={(e) => setPeerVolume(peer.id, Number(e.target.value))}
            />
            <span className="menu__value">{Math.round(volume * 100)}%</span>
          </div>
          <p className="menu__hint">
            Only you hear the difference. Nothing is sent, and {peer.persona} is not told.
          </p>
          <button className="menu__item" onClick={() => togglePeerMuted(peer.id)}>
            {muted ? `Unmute ${peer.persona} for me` : `Mute ${peer.persona} for me`}
          </button>
          {volume !== 1 && (
            <button className="menu__item" onClick={() => setPeerVolume(peer.id, 1)}>
              Reset to 100%
            </button>
          )}
        </>
      )}

      <button
        className="menu__item"
        onClick={() => {
          setPinned(pinned === peer.id ? null : peer.id)
          onClose()
        }}
      >
        {pinned === peer.id ? 'Unpin from the stage' : 'Pin to the stage'}
      </button>
    </div>
  )
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
  onMenu?: (event: MouseEvent) => void
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
  onMenu,
}: TileProps) {
  const videoRef = useTrack<HTMLVideoElement>(video)
  // Metered for everyone including ourselves: seeing your own ring light up is
  // the only way to know the microphone is picking anything up before you find
  // out from someone else that it never was.
  const speaking = useSpeaking(audio)
  const health = useStore((s) => s.health[peer.id])
  const micBoost = useStore((s) => s.settings.micBoost)
  const volume = useStore((s) => s.settings.peerVolume[peer.id] ?? 1)
  const locallyMuted = useStore((s) => s.peerMuted[peer.id] ?? false)

  // A boost is invisible by definition, and a person silenced by us sounds
  // exactly like a person whose connection died. Both are worth a badge.
  const gain = isSelf ? micBoost : volume
  const silenced = !isSelf && locallyMuted

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
      onContextMenu={onMenu}
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
          {silenced && (
            <span title="Silenced for you only">
              <SpeakerOffIcon size={14} className="muted" />
            </span>
          )}
          {!silenced && gain !== 1 && (
            <span className="tile__gain" title={isSelf ? 'Microphone boost' : 'Their volume, here'}>
              {Math.round(gain * 100)}%
            </span>
          )}
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
  const peerVolume = useStore((s) => s.settings.peerVolume)
  const peerMuted = useStore((s) => s.peerMuted)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  // Stable, so the menu's outside-click listener is not torn down and rebuilt
  // on every stats tick.
  const closeMenu = useCallback(() => setMenu(null), [])
  const cameraOnFor = (peerId: string): boolean =>
    peerId === me?.id ? localPresence.cameraOn : (presence[peerId]?.cameraOn ?? false)

  const members = room?.members ?? []

  /** Deafening beats silencing one person, which beats their stored volume. */
  const volumeFor = (peerId: string): number => {
    if (localPresence.deafened || peerMuted[peerId]) return 0
    return peerVolume[peerId] ?? 1
  }

  const openMenu = (peerId: string) => (event: MouseEvent) => {
    event.preventDefault()
    // Filmstrip tiles sit inside the presenter, which has its own handler; the
    // tile the pointer is actually over is the one that should win.
    event.stopPropagation()
    setMenu({ peerId, x: event.clientX, y: event.clientY })
  }

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
              <RemoteAudio track={remoteTracks[m.id]?.mic} volume={volumeFor(m.id)} />
              <RemoteAudio track={remoteTracks[m.id]?.screenAudio} volume={volumeFor(m.id)} />
            </div>
          ))}
      </div>

      {presenterTrack ? (
        <div
          className="presenter"
          // The filmstrip tile is still there, but the thing filling the screen
          // is what a right-click will land on.
          onContextMenu={presenter ? openMenu(presenter) : undefined}
        >
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
                onMenu={openMenu(member.id)}
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
              onMenu={openMenu(member.id)}
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

      {menu && <PeerMenu {...menu} onClose={closeMenu} />}
    </section>
  )
}

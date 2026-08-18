import type { TrackSlot } from '../types'

/**
 * A full-mesh WebRTC session: one `RTCPeerConnection` per remote participant.
 *
 * # Why mesh
 *
 * Hollow has no media server, so every peer sends directly to every other peer.
 * That keeps the whole product serverless, at the cost of upload bandwidth: a
 * peer sharing their screen encodes and uploads one copy per viewer. Six people
 * is where a typical home connection stops keeping up at 1080p, which is why
 * rooms are capped there.
 *
 * Simulcast is deliberately absent. It exists so an SFU can forward different
 * qualities to different viewers from one upload; in a mesh each peer connection
 * already has its own encoder, so per-peer `maxBitrate` achieves the same thing
 * without the overhead. See {@link Mesh.retuneBitrates}.
 *
 * # Why the transceiver layout is fixed
 *
 * Both sides create the same four transceivers, in the same order, before the
 * first offer. Turning the camera on or starting a screen share then only calls
 * `replaceTrack`, which needs no renegotiation. Without this, every toggle in a
 * six-person room would trigger a storm of offers racing each other.
 *
 * # Why there is no glare handling
 *
 * For any pair, the peer with the numerically lower SteamID64 is the offerer.
 * Both sides know both ids, so the roles are settled before a single message is
 * sent and an offer collision cannot happen.
 */

/** Order is the m-line order. Both peers must build this identically. */
const LAYOUT: { slot: TrackSlot; kind: 'audio' | 'video' }[] = [
  { slot: 'mic', kind: 'audio' },
  { slot: 'screenAudio', kind: 'audio' },
  { slot: 'camera', kind: 'video' },
  { slot: 'screen', kind: 'video' },
]

/**
 * Total upload a peer will spend on outgoing screen video, split across
 * viewers. Sized for a ~25 Mbit/s residential uplink with headroom for audio,
 * camera and the rest of the household.
 */
const SCREEN_BUDGET_BPS = 12_000_000
/** Never drop a share below this; past here it is unreadable anyway. */
const SCREEN_FLOOR_BPS = 900_000
const CAMERA_BUDGET_BPS = 2_400_000
const CAMERA_FLOOR_BPS = 200_000

export interface MeshEvents {
  /** A remote track arrived or was replaced. `track` is null when it stopped. */
  onTrack(peerId: string, slot: TrackSlot, track: MediaStreamTrack | null): void
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void
  /** Send a signaling payload to one peer via the Steam channel. */
  send(peerId: string, payload: unknown): void
}

interface Link {
  pc: RTCPeerConnection
  /** Transceivers in LAYOUT order; index matches. */
  transceivers: RTCRtpTransceiver[]
  /** Candidates that arrived before the remote description was set. */
  earlyCandidates: RTCIceCandidateInit[]
  remoteDescriptionSet: boolean
}

export class Mesh {
  private links = new Map<string, Link>()
  private local: Partial<Record<TrackSlot, MediaStreamTrack | null>> = {}

  constructor(
    private readonly selfId: string,
    private readonly events: MeshEvents,
    private iceServers: RTCIceServer[],
  ) {}

  /** Replace the ICE configuration. Takes effect on connections opened after. */
  setIceServers(servers: RTCIceServer[]): void {
    this.iceServers = servers
  }

  get peerIds(): string[] {
    return [...this.links.keys()]
  }

  /**
   * Open a connection to a peer. Safe to call repeatedly; the second call is a
   * no-op, which matters because room updates and join events can both fire.
   */
  async connect(peerId: string): Promise<void> {
    if (this.links.has(peerId) || peerId === this.selfId) return

    const link = this.createLink(peerId)
    this.links.set(peerId, link)

    if (this.isOfferer(peerId)) {
      await this.sendOffer(peerId, link)
    }
    this.retuneBitrates()
  }

  disconnect(peerId: string): void {
    const link = this.links.get(peerId)
    if (!link) return
    this.links.delete(peerId)
    link.pc.close()
    for (const { slot } of LAYOUT) this.events.onTrack(peerId, slot, null)
    this.retuneBitrates()
  }

  closeAll(): void {
    for (const peerId of [...this.links.keys()]) this.disconnect(peerId)
  }

  /**
   * Publish a local track into every connection, or clear it with null.
   *
   * `replaceTrack` on an already-negotiated transceiver avoids renegotiation
   * entirely, so this is cheap enough to call on every mute toggle.
   */
  async setLocalTrack(slot: TrackSlot, track: MediaStreamTrack | null): Promise<void> {
    this.local[slot] = track
    const index = LAYOUT.findIndex((entry) => entry.slot === slot)
    if (index < 0) return

    await Promise.all(
      [...this.links.values()].map(async (link) => {
        const sender = link.transceivers[index]?.sender
        if (!sender) return
        try {
          await sender.replaceTrack(track)
        } catch (err) {
          console.warn(`replaceTrack(${slot}) failed`, err)
        }
      }),
    )
    this.retuneBitrates()
  }

  /** Handle a signaling payload relayed from a peer. */
  async handleSignal(peerId: string, payload: unknown): Promise<void> {
    const message = payload as {
      kind?: string
      sdp?: RTCSessionDescriptionInit
      candidate?: RTCIceCandidateInit
    }

    let link = this.links.get(peerId)
    if (!link) {
      // An offer can beat the room update that tells us this peer exists.
      if (message.kind !== 'offer') return
      link = this.createLink(peerId)
      this.links.set(peerId, link)
    }

    try {
      switch (message.kind) {
        case 'offer': {
          if (!message.sdp) return
          await link.pc.setRemoteDescription(message.sdp)
          link.remoteDescriptionSet = true
          await this.flushCandidates(link)
          const answer = await link.pc.createAnswer()
          await link.pc.setLocalDescription(answer)
          this.events.send(peerId, { kind: 'answer', sdp: link.pc.localDescription })
          break
        }
        case 'answer': {
          if (!message.sdp || link.pc.signalingState !== 'have-local-offer') return
          await link.pc.setRemoteDescription(message.sdp)
          link.remoteDescriptionSet = true
          await this.flushCandidates(link)
          break
        }
        case 'ice': {
          if (!message.candidate) return
          if (!link.remoteDescriptionSet) {
            // Candidates routinely arrive before the description they belong to.
            link.earlyCandidates.push(message.candidate)
          } else {
            await link.pc.addIceCandidate(message.candidate)
          }
          break
        }
      }
    } catch (err) {
      console.error(`signaling from ${peerId} failed`, err)
    }
  }

  /** Live sender statistics, for the connection quality indicator. */
  async stats(peerId: string): Promise<{ rttMs: number; outKbps: number; packetLoss: number }> {
    const link = this.links.get(peerId)
    if (!link) return { rttMs: 0, outKbps: 0, packetLoss: 0 }

    const report = await link.pc.getStats()
    let rttMs = 0
    let bytesSent = 0
    let packetsSent = 0
    let packetsLost = 0

    report.forEach((stat) => {
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.currentRoundTripTime) {
        rttMs = Math.round(stat.currentRoundTripTime * 1000)
      }
      if (stat.type === 'outbound-rtp') {
        bytesSent += stat.bytesSent ?? 0
        packetsSent += stat.packetsSent ?? 0
      }
      if (stat.type === 'remote-inbound-rtp') {
        packetsLost += stat.packetsLost ?? 0
      }
    })

    return {
      rttMs,
      outKbps: Math.round((bytesSent * 8) / 1000),
      packetLoss: packetsSent > 0 ? packetsLost / packetsSent : 0,
    }
  }

  // --- internals -------------------------------------------------------------

  private createLink(peerId: string): Link {
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      // One transport for everything; separate ones would mean separate ICE
      // checks per m-line for no benefit.
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })

    const transceivers = LAYOUT.map(({ kind }) =>
      pc.addTransceiver(kind, { direction: 'sendrecv' }),
    )

    const link: Link = { pc, transceivers, earlyCandidates: [], remoteDescriptionSet: false }

    // Attach whatever is already live locally.
    for (const [index, { slot }] of LAYOUT.entries()) {
      const track = this.local[slot]
      if (track) void transceivers[index].sender.replaceTrack(track)
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.events.send(peerId, { kind: 'ice', candidate: event.candidate.toJSON() })
      }
    }

    pc.ontrack = (event) => {
      const index = pc.getTransceivers().indexOf(event.transceiver)
      const slot = LAYOUT[index]?.slot
      if (!slot) return

      this.events.onTrack(peerId, slot, event.track)
      // A remote `replaceTrack(null)` surfaces as the track muting, not as a
      // new track event, so the tile has to watch the track itself.
      event.track.onended = () => this.events.onTrack(peerId, slot, null)
    }

    pc.onconnectionstatechange = () => {
      this.events.onConnectionState(peerId, pc.connectionState)
      if (pc.connectionState === 'failed') {
        // ICE restart is the standard recovery and keeps the m-line layout, so
        // no tracks are disturbed.
        void this.restartIce(peerId, link)
      }
    }

    return link
  }

  private async sendOffer(peerId: string, link: Link): Promise<void> {
    try {
      const offer = await link.pc.createOffer()
      await link.pc.setLocalDescription(offer)
      this.events.send(peerId, { kind: 'offer', sdp: link.pc.localDescription })
    } catch (err) {
      console.error(`could not offer to ${peerId}`, err)
    }
  }

  private async restartIce(peerId: string, link: Link): Promise<void> {
    if (!this.isOfferer(peerId)) return
    try {
      const offer = await link.pc.createOffer({ iceRestart: true })
      await link.pc.setLocalDescription(offer)
      this.events.send(peerId, { kind: 'offer', sdp: link.pc.localDescription })
    } catch (err) {
      console.error(`ICE restart for ${peerId} failed`, err)
    }
  }

  private async flushCandidates(link: Link): Promise<void> {
    const queued = link.earlyCandidates.splice(0)
    for (const candidate of queued) {
      try {
        await link.pc.addIceCandidate(candidate)
      } catch (err) {
        console.warn('queued candidate rejected', err)
      }
    }
  }

  /**
   * The peer with the lower SteamID64 offers. BigInt because these ids are far
   * past `Number.MAX_SAFE_INTEGER` and string comparison would order "9…"
   * after "10…".
   */
  private isOfferer(peerId: string): boolean {
    try {
      return BigInt(this.selfId) < BigInt(peerId)
    } catch {
      return this.selfId < peerId
    }
  }

  /**
   * Split the upload budget across current viewers.
   *
   * Called whenever the peer count or the set of local tracks changes: sending
   * 1080p to five people at the bitrate that suited one is the fastest way to
   * saturate an uplink and make every stream stutter at once.
   */
  private retuneBitrates(): void {
    const viewers = Math.max(1, this.links.size)
    const screenBps = Math.max(SCREEN_FLOOR_BPS, Math.floor(SCREEN_BUDGET_BPS / viewers))
    const cameraBps = Math.max(CAMERA_FLOOR_BPS, Math.floor(CAMERA_BUDGET_BPS / viewers))

    const screenIndex = LAYOUT.findIndex((e) => e.slot === 'screen')
    const cameraIndex = LAYOUT.findIndex((e) => e.slot === 'camera')

    for (const link of this.links.values()) {
      applyBitrate(link.transceivers[screenIndex]?.sender, screenBps, 'detail')
      applyBitrate(link.transceivers[cameraIndex]?.sender, cameraBps, 'motion')
    }
  }
}

/**
 * @param hint `detail` keeps text legible by dropping frames under pressure;
 * `motion` does the opposite. Screen shares are usually read, not watched.
 */
function applyBitrate(
  sender: RTCRtpSender | undefined,
  maxBitrate: number,
  hint: 'detail' | 'motion',
): void {
  if (!sender) return
  const params = sender.getParameters()
  if (!params.encodings || params.encodings.length === 0) {
    // Chromium populates this lazily; skipping now is fine because the next
    // retune will find it.
    params.encodings = [{}]
  }
  params.encodings[0].maxBitrate = maxBitrate
  params.degradationPreference = hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate'
  sender.setParameters(params).catch((err) => console.warn('setParameters failed', err))
}

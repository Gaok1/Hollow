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

/**
 * Signaling rides Steam's P2P messaging, which drops anything sent before the
 * remote side has accepted the session — and it accepts only once it has seen
 * us join the lobby, which is a race it can lose. A dropped offer is a call
 * that never connects and never explains why, so re-send until an answer lands.
 */
const OFFER_RETRY_MS = 1_500
const OFFER_RETRIES = 6
/**
 * After the fast attempts, keep asking — slowly, and for as long as the link is
 * still waiting on an answer.
 *
 * Giving up at nine seconds leaves a call that cannot recover without everyone
 * leaving and rejoining, and the thing being waited on (Steam's relay network
 * coming up on a cold client) can take longer than that. The cost of not giving
 * up is one small message every five seconds; the cost of giving up is the
 * call.
 */
const OFFER_RETRY_SLOW_MS = 5_000

/**
 * Everything the UI needs to say what a link is actually doing.
 *
 * `connectionState` alone cannot tell "we are still trying" apart from "we
 * agreed on a session and no media is coming", and those two have different
 * causes and different answers. Reporting the whole picture is what lets a
 * stuck call say which half is stuck.
 */
export interface LinkHealth {
  connection: RTCPeerConnectionState
  ice: RTCIceConnectionState
  /** True once both sides have a session: we answered, or we were answered. */
  negotiated: boolean
  /** Remote slots delivering media right now. Empty on a connected but silent link. */
  receiving: TrackSlot[]
  /** Offers sent with no answer back. Non-zero means signaling is being lost. */
  unansweredOffers: number
  /** Which kinds of local candidate ICE found. No `srflx` means STUN never answered. */
  candidates: Record<string, number>
  /** When the link was opened, so the UI can say how long this has been going on. */
  since: number
}

export interface MeshEvents {
  /** A remote track arrived or was replaced. `track` is null when it stopped. */
  onTrack(peerId: string, slot: TrackSlot, track: MediaStreamTrack | null): void
  /** The link's state changed in a way worth showing. */
  onHealth(peerId: string, health: LinkHealth): void
  /** Send a signaling payload to one peer via the Steam channel. */
  send(peerId: string, payload: unknown): void
  /** One line for the log file. A call that fails silently is not debuggable. */
  log(line: string): void
}

interface Link {
  pc: RTCPeerConnection
  /** Transceivers in LAYOUT order; index matches. */
  transceivers: RTCRtpTransceiver[]
  /** Candidates that arrived before the remote description was set. */
  earlyCandidates: RTCIceCandidateInit[]
  remoteDescriptionSet: boolean
  /** Pending offer re-send, cleared once an answer arrives. */
  offerRetry: ReturnType<typeof setTimeout> | null
  health: LinkHealth
  /** Remote slots currently unmuted, backing `health.receiving`. */
  live: Set<TrackSlot>
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
    this.events.log(
      `link ${peerId}: opened as ${this.isOfferer(peerId) ? 'offerer' : 'answerer'}`,
    )

    if (this.isOfferer(peerId)) {
      await this.sendOffer(peerId, link)
    }
    this.retuneBitrates()
  }

  disconnect(peerId: string): void {
    const link = this.links.get(peerId)
    if (!link) return
    this.links.delete(peerId)
    if (link.offerRetry) clearTimeout(link.offerRetry)
    link.pc.close()
    this.events.log(`link ${peerId}: closed`)
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
    this.events.log(
      `local ${slot}: ${track ? 'published' : 'cleared'} to ${this.links.size} peer(s)`,
    )

    await Promise.all(
      [...this.links.values()].map(async (link) => {
        const sender = link.transceivers[index]?.sender
        if (!sender) return
        try {
          await sender.replaceTrack(track)
        } catch (err) {
          this.events.log(`replaceTrack(${slot}) failed — ${err}`)
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
      if (message.kind !== 'offer') {
        this.events.log(`link ${peerId}: dropped a ${message.kind} for an unknown peer`)
        return
      }
      link = this.createLink(peerId)
      this.links.set(peerId, link)
      this.events.log(`link ${peerId}: opened by their offer`)
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
          link.health.negotiated = true
          this.report(peerId, link)
          this.events.log(`link ${peerId}: answered their offer`)
          break
        }
        case 'answer': {
          if (!message.sdp || link.pc.signalingState !== 'have-local-offer') return
          await link.pc.setRemoteDescription(message.sdp)
          link.remoteDescriptionSet = true
          if (link.offerRetry) {
            clearTimeout(link.offerRetry)
            link.offerRetry = null
          }
          await this.flushCandidates(link)
          link.health.negotiated = true
          link.health.unansweredOffers = 0
          this.report(peerId, link)
          this.events.log(`link ${peerId}: answer received`)
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
      this.events.log(`link ${peerId}: signaling (${message.kind}) failed — ${err}`)
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

    const link: Link = {
      pc,
      transceivers,
      earlyCandidates: [],
      remoteDescriptionSet: false,
      offerRetry: null,
      live: new Set(),
      health: {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        negotiated: false,
        receiving: [],
        unansweredOffers: 0,
        candidates: {},
        since: Date.now(),
      },
    }

    // Attach whatever is already live locally.
    for (const [index, { slot }] of LAYOUT.entries()) {
      const track = this.local[slot]
      if (track) void transceivers[index].sender.replaceTrack(track)
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Counting these by type is the cheapest NAT diagnosis there is: no
        // `srflx` means STUN never answered and nothing beyond the local
        // network will ever connect; no `relay` with a TURN server configured
        // means the relay is not working either.
        const type = event.candidate.type ?? 'unknown'
        link.health.candidates[type] = (link.health.candidates[type] ?? 0) + 1
        this.events.send(peerId, { kind: 'ice', candidate: event.candidate.toJSON() })
        return
      }
      // A null candidate is the end of gathering.
      this.report(peerId, link)
      this.events.log(
        `link ${peerId}: gathered ${JSON.stringify(link.health.candidates)}`,
      )
    }

    pc.ontrack = (event) => {
      const index = link.transceivers.indexOf(event.transceiver)
      const slot = LAYOUT[index]?.slot
      if (!slot) return

      // Because the whole layout is negotiated up front, a receiver track
      // exists for every slot from the first answer — long before the peer
      // publishes anything into it. `muted` is the flag that actually says
      // whether media is flowing: it clears when the first packet arrives and
      // comes back when the sender calls `replaceTrack(null)`.
      //
      // Reporting the bare track instead would put a permanently black video
      // in every tile, and leave the last frame of a camera or a screen share
      // frozen on screen after it was turned off.
      const track = event.track
      const publish = () => {
        const flowing = !track.muted
        if (flowing) link.live.add(slot)
        else link.live.delete(slot)
        link.health.receiving = [...link.live]
        this.events.onTrack(peerId, slot, flowing ? track : null)
        this.report(peerId, link)
      }
      track.onunmute = () => {
        this.events.log(`link ${peerId}: ${slot} is live`)
        publish()
      }
      track.onmute = () => {
        this.events.log(`link ${peerId}: ${slot} went quiet`)
        publish()
      }
      track.onended = () => {
        link.live.delete(slot)
        link.health.receiving = [...link.live]
        this.events.onTrack(peerId, slot, null)
        this.report(peerId, link)
      }
      publish()
    }

    pc.oniceconnectionstatechange = () => {
      link.health.ice = pc.iceConnectionState
      this.report(peerId, link)
      this.events.log(`link ${peerId}: ice ${pc.iceConnectionState}`)
    }

    pc.onconnectionstatechange = () => {
      link.health.connection = pc.connectionState
      this.report(peerId, link)
      this.events.log(`link ${peerId}: connection ${pc.connectionState}`)
      if (pc.connectionState === 'failed') {
        // ICE restart is the standard recovery and keeps the m-line layout, so
        // no tracks are disturbed.
        void this.restartIce(peerId, link)
      }
    }

    this.report(peerId, link)
    return link
  }

  /** Hand the current picture of a link to the UI. */
  private report(peerId: string, link: Link): void {
    this.events.onHealth(peerId, { ...link.health, candidates: { ...link.health.candidates } })
  }

  private async sendOffer(peerId: string, link: Link): Promise<void> {
    try {
      const offer = await link.pc.createOffer()
      await link.pc.setLocalDescription(offer)
      this.events.send(peerId, { kind: 'offer', sdp: link.pc.localDescription })
      this.events.log(`link ${peerId}: offer sent`)
      this.scheduleOfferRetry(peerId, link, 1)
    } catch (err) {
      this.events.log(`link ${peerId}: could not create an offer — ${err}`)
    }
  }

  /**
   * Re-send the current offer while no answer has come back.
   *
   * `have-local-offer` is exactly the state that means "the peer never replied":
   * either the offer or the answer was lost on the way. Re-sending the same
   * description is idempotent for the peer — it just answers again — and the
   * retry also forces Steam to open a fresh P2P session if the first attempt
   * was refused because the peer had not seen us join yet.
   */
  private scheduleOfferRetry(peerId: string, link: Link, attempt: number): void {
    if (link.offerRetry) clearTimeout(link.offerRetry)

    // Nothing here leaks: the timer stops itself once the link is replaced or
    // leaves `have-local-offer`, and `disconnect` clears it outright.
    const delay = attempt <= OFFER_RETRIES ? OFFER_RETRY_MS : OFFER_RETRY_SLOW_MS

    link.offerRetry = setTimeout(() => {
      link.offerRetry = null
      if (this.links.get(peerId) !== link) return
      if (link.pc.signalingState !== 'have-local-offer') return

      link.health.unansweredOffers = attempt
      this.report(peerId, link)
      this.events.log(`link ${peerId}: no answer, re-sending offer (${attempt})`)
      this.events.send(peerId, { kind: 'offer', sdp: link.pc.localDescription })
      this.scheduleOfferRetry(peerId, link, attempt + 1)
    }, delay)
  }

  private async restartIce(peerId: string, link: Link): Promise<void> {
    if (!this.isOfferer(peerId)) return
    try {
      const offer = await link.pc.createOffer({ iceRestart: true })
      await link.pc.setLocalDescription(offer)
      this.events.send(peerId, { kind: 'offer', sdp: link.pc.localDescription })
      this.events.log(`link ${peerId}: ICE restart offered`)
      this.scheduleOfferRetry(peerId, link, 1)
    } catch (err) {
      this.events.log(`link ${peerId}: ICE restart failed — ${err}`)
    }
  }

  private async flushCandidates(link: Link): Promise<void> {
    const queued = link.earlyCandidates.splice(0)
    for (const candidate of queued) {
      try {
        await link.pc.addIceCandidate(candidate)
      } catch (err) {
        this.events.log(`queued candidate rejected — ${err}`)
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

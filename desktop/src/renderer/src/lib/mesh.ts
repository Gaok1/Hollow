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
 * How often every link is sampled.
 *
 * The sample is what makes the budgets above a ceiling rather than a guess:
 * Chromium measures what each path will actually carry, and two seconds is
 * often enough to follow a link degrading without spending the CPU that a
 * per-second `getStats` over a full mesh costs.
 */
const STATS_INTERVAL_MS = 2_000

/**
 * Bandwidth held back from video on every link, for the audio slots.
 *
 * Voice breaking up because a screen share filled the pipe is the one failure
 * worth paying headroom to avoid — nobody minds a blurry share, everybody
 * minds not being understood.
 */
const AUDIO_RESERVE_BPS = 320_000

/** Opus ceilings. The microphone is mono speech; screen audio is music. */
const MIC_BPS = 64_000
const SCREEN_AUDIO_BPS = 160_000

/** What screen video may take of a link's spare capacity when a camera is also on. */
const SCREEN_SHARE_WITH_CAMERA = 0.75

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
/** What the link is measurably doing, sampled from `getStats`. */
export interface LinkQuality {
  /** Round trip on the pair ICE settled on, in milliseconds. */
  rttMs: number
  /** Chromium's own estimate of what this link will carry, in bits per second. */
  availableBps: number
  /** Share of our outbound packets the far end reports missing, 0 to 1. */
  loss: number
  /** What is actually crossing right now, in bits per second. */
  outBps: number
  inBps: number
  /**
   * How the media is routed. `relay` means it is going through TURN and paying
   * for it; `host` means the two peers are on the same network.
   */
  route: 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown'
}

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
  quality: LinkQuality
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
  /** Previous byte counters, for turning running totals into rates. */
  lastSample: { at: number; bytesSent: number; bytesReceived: number } | null
}

export class Mesh {
  private links = new Map<string, Link>()
  private local: Partial<Record<TrackSlot, MediaStreamTrack | null>> = {}
  /** Runs only while there is something to measure. */
  private statsTimer: ReturnType<typeof setInterval> | null = null

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
    this.startSampling()
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
    if (this.links.size === 0) this.stopSampling()
  }

  closeAll(): void {
    for (const peerId of [...this.links.keys()]) this.disconnect(peerId)
    this.stopSampling()
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
      this.startSampling()
    }

    try {
      switch (message.kind) {
        case 'offer': {
          if (!message.sdp) return
          await link.pc.setRemoteDescription(message.sdp)
          link.remoteDescriptionSet = true
          await this.flushCandidates(link)
          const answer = await link.pc.createAnswer()
          await this.setLocalTuned(link, answer)
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

  // --- internals -------------------------------------------------------------

  private startSampling(): void {
    if (this.statsTimer) return
    this.statsTimer = setInterval(() => void this.sample(), STATS_INTERVAL_MS)
  }

  private stopSampling(): void {
    if (!this.statsTimer) return
    clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  /** Measure every link, then spend what was measured. */
  private async sample(): Promise<void> {
    await Promise.all(
      [...this.links.entries()].map(([peerId, link]) => this.sampleLink(peerId, link)),
    )
    this.retuneBitrates()
  }

  private async sampleLink(peerId: string, link: Link): Promise<void> {
    if (link.pc.connectionState !== 'connected') return

    let report: RTCStatsReport
    try {
      report = await link.pc.getStats()
    } catch {
      return
    }
    // The link can go away while `getStats` is in flight.
    if (this.links.get(peerId) !== link) return

    const candidates = new Map<string, { candidateType?: string }>()
    let pair: Record<string, number | string | boolean | undefined> | null = null
    let bytesSent = 0
    let bytesReceived = 0
    let packetsSent = 0
    let packetsLost = 0

    report.forEach((stat) => {
      switch (stat.type) {
        case 'local-candidate':
        case 'remote-candidate':
          candidates.set(stat.id, stat)
          break
        case 'candidate-pair':
          // `nominated` is the pair ICE actually chose; without that check a
          // discarded pair's numbers can win the race.
          if (stat.state === 'succeeded' && stat.nominated !== false) pair = stat
          break
        case 'outbound-rtp':
          bytesSent += stat.bytesSent ?? 0
          packetsSent += stat.packetsSent ?? 0
          break
        case 'inbound-rtp':
          bytesReceived += stat.bytesReceived ?? 0
          break
        case 'remote-inbound-rtp':
          // Reported by the far end: what it did not get from us.
          packetsLost += stat.packetsLost ?? 0
          break
      }
    })

    const selected = pair as {
      currentRoundTripTime?: number
      availableOutgoingBitrate?: number
      localCandidateId?: string
      remoteCandidateId?: string
    } | null

    const localType = selected?.localCandidateId
      ? candidates.get(selected.localCandidateId)?.candidateType
      : undefined
    const remoteType = selected?.remoteCandidateId
      ? candidates.get(selected.remoteCandidateId)?.candidateType
      : undefined
    // Either end relaying means the media is relayed.
    const route =
      localType === 'relay' || remoteType === 'relay'
        ? 'relay'
        : ((localType ?? 'unknown') as LinkQuality['route'])

    const now = Date.now()
    const previous = link.lastSample
    const elapsed = previous ? (now - previous.at) / 1000 : 0
    const rate = (bytes: number, before: number): number =>
      elapsed > 0 ? Math.max(0, Math.round(((bytes - before) * 8) / elapsed)) : 0

    link.health.quality = {
      rttMs: Math.round((selected?.currentRoundTripTime ?? 0) * 1000),
      availableBps: Math.round(selected?.availableOutgoingBitrate ?? 0),
      loss: packetsSent > 0 ? Math.min(1, packetsLost / packetsSent) : 0,
      outBps: previous ? rate(bytesSent, previous.bytesSent) : 0,
      inBps: previous ? rate(bytesReceived, previous.bytesReceived) : 0,
      route,
    }
    link.lastSample = { at: now, bytesSent, bytesReceived }
    this.report(peerId, link)
  }


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
      lastSample: null,
      health: {
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        negotiated: false,
        receiving: [],
        unansweredOffers: 0,
        candidates: {},
        since: Date.now(),
        quality: {
          rttMs: 0,
          availableBps: 0,
          loss: 0,
          outBps: 0,
          inBps: 0,
          route: 'unknown',
        },
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
    this.events.onHealth(peerId, {
      ...link.health,
      candidates: { ...link.health.candidates },
      quality: { ...link.health.quality },
    })
  }

  /**
   * Apply a local description with Opus widened, falling back to the original.
   *
   * Munged SDP is only ever an optimisation here, so a Chromium that refuses it
   * must cost the tuning and not the call.
   */
  private async setLocalTuned(link: Link, description: RTCSessionDescriptionInit): Promise<void> {
    const tuned = tuneOpus(description.sdp)
    if (tuned !== description.sdp) {
      try {
        await link.pc.setLocalDescription({ ...description, sdp: tuned })
        return
      } catch (err) {
        this.events.log(`opus tuning refused, using the plain description — ${err}`)
      }
    }
    await link.pc.setLocalDescription(description)
  }

  private async sendOffer(peerId: string, link: Link): Promise<void> {
    try {
      const offer = await link.pc.createOffer()
      await this.setLocalTuned(link, offer)
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
      await this.setLocalTuned(link, offer)
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
    // The uplink is shared across every link, so these stay a hard ceiling.
    const screenCap = Math.max(SCREEN_FLOOR_BPS, Math.floor(SCREEN_BUDGET_BPS / viewers))
    const cameraCap = Math.max(CAMERA_FLOOR_BPS, Math.floor(CAMERA_BUDGET_BPS / viewers))

    // With nothing to send in the other video slot, one takes the whole link.
    const sendingScreen = Boolean(this.local.screen)
    const sendingCamera = Boolean(this.local.camera)
    const screenShare = sendingCamera ? SCREEN_SHARE_WITH_CAMERA : 1
    const cameraShare = sendingScreen ? 1 - SCREEN_SHARE_WITH_CAMERA : 1

    const index = (slot: TrackSlot): number => LAYOUT.findIndex((e) => e.slot === slot)

    for (const link of this.links.values()) {
      // Before the first sample there is no estimate, and a ceiling with no
      // measurement under it is the old behaviour — which is the right thing
      // to fall back to.
      const available = link.health.quality.availableBps
      const spare = available > 0 ? Math.max(0, available - AUDIO_RESERVE_BPS) : Number.POSITIVE_INFINITY

      this.applyEncoding(link, index('screen'), {
        maxBitrate: Math.max(SCREEN_FLOOR_BPS, Math.min(screenCap, Math.floor(spare * screenShare))),
        // Text stays legible when the encoder is squeezed; the alternative is
        // a smooth but unreadable blur.
        degradation: 'maintain-resolution',
        priority: 'low',
      })
      this.applyEncoding(link, index('camera'), {
        maxBitrate: Math.max(CAMERA_FLOOR_BPS, Math.min(cameraCap, Math.floor(spare * cameraShare))),
        degradation: 'maintain-framerate',
        priority: 'medium',
      })
      // Audio is priced separately and cheaply, and marked so the transport
      // starves video first when the link tightens.
      this.applyEncoding(link, index('mic'), { maxBitrate: MIC_BPS, priority: 'high' })
      this.applyEncoding(link, index('screenAudio'), {
        maxBitrate: SCREEN_AUDIO_BPS,
        priority: 'medium',
      })
    }
  }

  /**
   * Set one sender's encoding, skipping the call when nothing changed.
   *
   * `retuneBitrates` now runs on every sample rather than only on churn, and
   * `setParameters` is not free — it can interrupt the encoder.
   */
  private applyEncoding(
    link: Link,
    index: number,
    wanted: {
      maxBitrate: number
      priority: RTCPriorityType
      degradation?: RTCDegradationPreference
    },
  ): void {
    const sender = link.transceivers[index]?.sender
    if (!sender) return

    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      // Chromium populates this lazily; skipping now is fine because the next
      // retune will find it.
      params.encodings = [{}]
    }
    const encoding = params.encodings[0]

    const unchanged =
      encoding.maxBitrate === wanted.maxBitrate &&
      encoding.networkPriority === wanted.priority &&
      (wanted.degradation === undefined || params.degradationPreference === wanted.degradation)
    if (unchanged) return

    encoding.maxBitrate = wanted.maxBitrate
    encoding.priority = wanted.priority
    encoding.networkPriority = wanted.priority
    if (wanted.degradation) params.degradationPreference = wanted.degradation

    sender.setParameters(params).catch((err) => this.events.log(`setParameters failed — ${err}`))
  }
}

/**
 * Widen Opus on the way out.
 *
 * Chromium negotiates it conservatively — mono, no in-band FEC, an average
 * bitrate sized for speech — which is right for a phone call and wrong for
 * sharing a game's audio. In-band FEC also conceals a lost packet instead of
 * letting it be heard, which is the cheapest quality win voice has.
 *
 * One fmtp line covers both audio streams because a bundled session gives them
 * the same payload type, and that is fine: `maxaveragebitrate` is a ceiling,
 * and each sender's own `maxBitrate` is what actually holds it down.
 */
function tuneOpus(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp
  const payload = /^a=rtpmap:(\d+) opus\/48000\/2/im.exec(sdp)?.[1]
  if (!payload) return sdp

  const fmtp = new RegExp(`^a=fmtp:${payload} (.*)$`, 'im')
  const existing = fmtp.exec(sdp)

  const params = new Map<string, string>()
  for (const pair of existing?.[1].split(';') ?? []) {
    const [key, value] = pair.split('=')
    if (key?.trim()) params.set(key.trim(), (value ?? '').trim())
  }
  params.set('stereo', '1')
  params.set('sprop-stereo', '1')
  params.set('useinbandfec', '1')
  params.set('maxaveragebitrate', String(SCREEN_AUDIO_BPS))

  const line = `a=fmtp:${payload} ${[...params]
    .map(([key, value]) => `${key}=${value}`)
    .join(';')}`

  if (existing) return sdp.replace(fmtp, line)
  return sdp.replace(
    new RegExp(`^(a=rtpmap:${payload} opus/48000/2)$`, 'im'),
    `$1\r\n${line}`,
  )
}

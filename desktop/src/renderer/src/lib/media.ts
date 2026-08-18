/**
 * Local capture: microphone, camera, screen, and the broadcast audio track fed
 * by the Rust mixer.
 */

/**
 * Runs inside the AudioWorklet thread. Drains PCM blocks posted from the main
 * thread into the audio graph.
 *
 * The bounded queue matters: if the graph ever falls behind the daemon, the
 * right answer for realtime audio is to drop the backlog, not to play an
 * ever-growing delay.
 */
const PCM_PLAYER_WORKLET = /* js */ `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.port.onmessage = (event) => {
      this.queue.push(new Float32Array(event.data))
      // ~400ms at 10ms per block. Past this we are not going to catch up.
      while (this.queue.length > 40) this.queue.shift()
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const left = out[0]
    const right = out[1] ?? out[0]

    for (let i = 0; i < left.length; i++) {
      const chunk = this.queue[0]
      if (!chunk) {
        left[i] = 0
        right[i] = 0
        continue
      }
      left[i] = chunk[this.offset]
      right[i] = chunk[this.offset + 1]
      this.offset += 2
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-player', PcmPlayer)
`

export interface DeviceChoice {
  microphoneId?: string
  cameraId?: string
}

/**
 * How far the microphone may be pushed before sending.
 *
 * Three is enough to rescue a genuinely quiet headset. Past it the limiter is
 * doing all the work and the noise floor comes up with the voice, so there is
 * nothing left to gain.
 */
export const MIC_BOOST_MAX = 3

/**
 * And how far down.
 *
 * Halving is the fix for a microphone that is too hot; going all the way to
 * silence is not, because a microphone that is silently off is exactly the bug
 * this whole feature exists to make visible. Mute does that job, and says so.
 */
export const MIC_BOOST_MIN = 0.5

/** How far one person's incoming audio may be pushed. */
export const PEER_VOLUME_MAX = 2

const clampGain = (value: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 1

/**
 * A limiter, not a compressor.
 *
 * Gain above 1 is the point of a booster and also the quickest way to turn
 * speech into square waves. One of these sits after every boost with its
 * threshold just under full scale: inaudible until something would have
 * clipped, and catching it when it does.
 */
function createLimiter(context: AudioContext): DynamicsCompressorNode {
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -3
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.003
  limiter.release.value = 0.25
  return limiter
}

/** A gain change, ramped. Stepping a gain node is an audible click. */
const ramp = (gain: GainNode, value: number, context: AudioContext): void => {
  gain.gain.setTargetAtTime(value, context.currentTime, 0.02)
}

/**
 * The microphone, and the boost applied to it before anyone else hears it.
 *
 * The track handed out is not the device's — it is the far end of a gain stage,
 * so the boost is baked into what WebRTC sends rather than into what this
 * machine plays. That is the whole reason the chain exists: a microphone nobody
 * can hear is not fixed by turning your own speakers up.
 */
export interface MicrophoneSource {
  /** What to send. Muting still works: it is a `MediaStreamTrack` like any other. */
  track: MediaStreamTrack
  /** Change the boost mid-call. Costs no renegotiation — the track is unchanged. */
  setBoost(boost: number): void
  /** Releases the device. The track alone cannot: it is ours, not the device's. */
  stop(): void
}

/**
 * Microphone capture.
 *
 * Echo cancellation, noise suppression and gain control are all on: this track
 * carries a person talking in a room where the call is also playing out of the
 * speakers. The screen-audio track deliberately gets none of them.
 *
 * The boost is applied after all three. Chromium's own gain control runs inside
 * the capture pipeline, so it has already had its say by the time the signal
 * reaches this graph and will not quietly undo the setting.
 */
export async function openMicrophone(
  deviceId?: string,
  boost = 1,
): Promise<MicrophoneSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  })
  const device = stream.getAudioTracks()[0]

  const context = sharedAudioContext()
  // Awaited here and nowhere else: a suspended context would hand back a track
  // that carries silence, and silence is indistinguishable from a call that is
  // working until somebody says so. Everything else in this file can afford to
  // start a beat late.
  await context.resume().catch(() => {})

  const source = context.createMediaStreamSource(stream)
  const gain = context.createGain()
  gain.gain.value = clampGain(boost, MIC_BOOST_MAX)
  const limiter = createLimiter(context)
  const destination = context.createMediaStreamDestination()
  source.connect(gain).connect(limiter).connect(destination)

  const track = destination.stream.getAudioTracks()[0]
  // The device ending — unplugged, or taken by another app — has to reach the
  // track we handed out, or the call goes silent with nothing to show for it.
  device.onended = () => track.stop()

  return {
    track,
    setBoost: (next) => ramp(gain, clampGain(next, MIC_BOOST_MAX), context),
    stop() {
      source.disconnect()
      gain.disconnect()
      limiter.disconnect()
      track.stop()
      device.stop()
    },
  }
}

export async function openCamera(deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  })
  return stream.getVideoTracks()[0]
}

/**
 * Capture constraints for a share.
 *
 * A height of 0 means whatever the display is. Capping it is the cheapest way
 * to make a share readable on a thin connection: a 4K desktop scaled into the
 * same bitrate as a 1080p one spends every bit on pixels nobody can read.
 */
function screenConstraints(frameRate: number, height: number): MediaTrackConstraints {
  return {
    frameRate: { ideal: frameRate, max: frameRate },
    ...(height > 0 ? { height: { max: height } } : {}),
  }
}

/**
 * Capture a screen or window.
 *
 * Audio is never asked for here. Chromium's loopback capture fails outright on
 * plenty of Windows machines — a busy exclusive-mode endpoint, an unusual driver
 * stack — and where it works it hands back the whole endpoint mix with no way to
 * shape it. The daemon's own capture is the one path for broadcast audio, in
 * both capture modes; see {@link BroadcastAudio}.
 *
 * The source is staged in the main process first, because Electron's
 * display-media handler cannot ask the renderer which source to use once the
 * request is in flight.
 */
export async function openScreen(
  sourceId: string,
  frameRate: number,
  height: number,
): Promise<MediaStreamTrack> {
  await window.hollow.screen.choose(sourceId)

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: screenConstraints(frameRate, height),
    audio: false,
  })

  const video = stream.getVideoTracks()[0]
  // Text stays legible when the encoder is squeezed; the alternative is a
  // smooth but unreadable blur.
  if ('contentHint' in video) video.contentHint = 'detail'
  return video
}

/**
 * Re-apply frame rate and resolution to a share that is already running.
 *
 * Changing either in settings mid-share and having nothing happen until the
 * next one is the kind of control people conclude is broken, so this is applied
 * live. A driver that refuses is not worth interrupting a call over.
 */
export async function retuneScreen(
  track: MediaStreamTrack,
  frameRate: number,
  height: number,
): Promise<void> {
  try {
    await track.applyConstraints(screenConstraints(frameRate, height))
  } catch (error) {
    console.warn('The share kept its previous capture settings', error)
  }
}

/**
 * Turns the Rust mixer's PCM stream into a `MediaStreamTrack`.
 *
 * This is the per-application audio path: the daemon captures each selected app
 * separately, applies the mixer's gains, and streams the result here. An
 * AudioWorklet feeds it into a `MediaStreamAudioDestinationNode`, whose track
 * WebRTC treats like any other.
 */
export class BroadcastAudio {
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private destination: MediaStreamAudioDestinationNode | null = null
  private unsubscribe: (() => void) | null = null

  async start(pipeName: string): Promise<MediaStreamTrack> {
    await this.stop()

    // 48kHz to match the daemon exactly, so no resampling happens here.
    this.context = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })

    const blob = new Blob([PCM_PLAYER_WORKLET], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await this.context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    this.node = new AudioWorkletNode(this.context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    this.destination = this.context.createMediaStreamDestination()
    this.node.connect(this.destination)

    this.unsubscribe = window.hollow.audio.onPcm((chunk) => {
      // Transfer rather than copy; the buffer is ours alone.
      this.node?.port.postMessage(chunk, [chunk])
    })
    await window.hollow.audio.connect(pipeName)

    const track = this.destination.stream.getAudioTracks()[0]
    if ('contentHint' in track) track.contentHint = 'music'
    return track
  }

  async stop(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await window.hollow.audio.disconnect().catch(() => {})
    this.node?.disconnect()
    this.node = null
    this.destination = null
    if (this.context) {
      await this.context.close().catch(() => {})
      this.context = null
    }
  }
}

/**
 * One `AudioContext` shared by every meter, boost and sink on the page.
 *
 * A meter used to open its own, which is fine at one or two and stops being
 * fine in a full room: one per tile, plus the control bar, plus the mixer, plus
 * a gain stage for the microphone and one per person being listened to.
 * Analysers are cheap, contexts are not, and Chromium caps how many a document
 * may hold at once.
 */
let audioContext: AudioContext | null = null

function sharedAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext()
  }
  // Autoplay policy can leave it suspended until the page is interacted with.
  void audioContext.resume().catch(() => {})
  return audioContext
}

/**
 * Plays one remote track, at a volume that may exceed 100%.
 *
 * `HTMLMediaElement.volume` stops at 1, which is no use to someone whose friend
 * simply records quiet, so playback goes through a gain node instead and the
 * element is kept muted beside it — both as the sink that keeps a remote stream
 * being pulled, and as the fallback below.
 *
 * That fallback matters more than the boost does. If the shared context is
 * suspended, routing playback through it would mean hearing nobody at all, so a
 * context that is not running hands the audio back to the element and gives up
 * only the part above 100%.
 */
export interface AudioSink {
  /** 0 to {@link PEER_VOLUME_MAX}, where 1 is untouched. */
  setVolume(volume: number): void
  close(): void
}

export function playRemoteTrack(
  track: MediaStreamTrack,
  element: HTMLAudioElement,
): AudioSink {
  const stream = new MediaStream([track])
  element.srcObject = stream
  // Autoplay can still be refused if the window has never been interacted with;
  // joining a call counts, so this is belt and braces.
  void element.play().catch(() => {})

  const context = sharedAudioContext()
  const source = context.createMediaStreamSource(stream)
  const gain = context.createGain()
  const limiter = createLimiter(context)
  source.connect(gain).connect(limiter).connect(context.destination)

  let volume = 1
  let closed = false

  const route = () => {
    if (closed) return
    if (context.state === 'running') {
      element.muted = true
      ramp(gain, volume, context)
    } else {
      element.muted = volume === 0
      element.volume = Math.min(1, volume)
    }
  }

  context.addEventListener('statechange', route)
  route()

  return {
    setVolume(next) {
      volume = clampGain(next, PEER_VOLUME_MAX)
      route()
    },
    close() {
      closed = true
      context.removeEventListener('statechange', route)
      source.disconnect()
      gain.disconnect()
      limiter.disconnect()
      element.srcObject = null
    },
  }
}

/**
 * Watch how loud a track is, for the speaking indicator and mixer meters.
 *
 * @returns a stop function.
 */
export function meterTrack(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
): () => void {
  const context = sharedAudioContext()
  const source = context.createMediaStreamSource(new MediaStream([track]))
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  // Smooths the needle without making it feel laggy.
  analyser.smoothingTimeConstant = 0.6
  source.connect(analyser)

  const samples = new Float32Array(analyser.fftSize)
  let raf = 0
  let running = true

  const tick = () => {
    if (!running) return
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const sample of samples) sum += sample * sample
    // RMS, then a gentle curve so quiet speech still moves the meter.
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3))
    raf = requestAnimationFrame(tick)
  }
  tick()

  return () => {
    running = false
    cancelAnimationFrame(raf)
    source.disconnect()
    analyser.disconnect()
    // The context is shared, so it outlives this meter deliberately.
  }
}

export async function listDevices(): Promise<{
  microphones: MediaDeviceInfo[]
  cameras: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    microphones: devices.filter((d) => d.kind === 'audioinput'),
    cameras: devices.filter((d) => d.kind === 'videoinput'),
    speakers: devices.filter((d) => d.kind === 'audiooutput'),
  }
}

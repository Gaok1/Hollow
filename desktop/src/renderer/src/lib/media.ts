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
 * Microphone capture.
 *
 * Echo cancellation, noise suppression and gain control are all on: this track
 * carries a person talking in a room where the call is also playing out of the
 * speakers. The screen-audio track deliberately gets none of them.
 */
export async function openMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
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
  return stream.getAudioTracks()[0]
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

export interface ScreenCapture {
  video: MediaStreamTrack
  /** Present only when Electron's loopback capture supplied system audio. */
  audio: MediaStreamTrack | null
}

/**
 * Capture a screen or window.
 *
 * The source is staged in the main process first, because Electron's
 * display-media handler cannot ask the renderer which source to use once the
 * request is in flight.
 *
 * @param withSystemAudio ask Electron for loopback audio. Used on Windows
 * builds without per-process capture; where per-process capture exists the
 * audio comes from the Rust mixer instead, via {@link BroadcastAudio}.
 */
export async function openScreen(
  sourceId: string,
  withSystemAudio: boolean,
  frameRate: number,
): Promise<ScreenCapture> {
  await window.hollow.screen.choose(sourceId)

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: frameRate, max: frameRate } },
    audio: withSystemAudio,
  })

  const video = stream.getVideoTracks()[0]
  // Text stays legible when the encoder is squeezed; the alternative is a
  // smooth but unreadable blur.
  if ('contentHint' in video) video.contentHint = 'detail'

  const audio = withSystemAudio ? (stream.getAudioTracks()[0] ?? null) : null
  if (audio && 'contentHint' in audio) audio.contentHint = 'music'

  return { video, audio }
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
 * Watch how loud a track is, for the speaking indicator and mixer meters.
 *
 * @returns a stop function.
 */
export function meterTrack(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
): () => void {
  const context = new AudioContext()
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
    void context.close()
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

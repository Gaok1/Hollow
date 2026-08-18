import net from 'node:net'
import { EventEmitter } from 'node:events'

/**
 * Reads mixed broadcast PCM from `hollow-core` over its named pipe.
 *
 * The daemon writes interleaved stereo float32 at 48kHz. Chunks are forwarded
 * to the renderer, where an AudioWorklet turns them into an ordinary
 * `MediaStreamTrack` for WebRTC.
 *
 * Only used when per-process capture is available. On builds without it the
 * renderer takes screen audio from Electron's own loopback capture instead.
 */
export class AudioPipe extends EventEmitter {
  private socket: net.Socket | null = null
  private retry: NodeJS.Timeout | null = null
  private name: string | null = null
  /** Samples are 4 bytes; hold any partial sample split across reads. */
  private tail: Buffer = Buffer.alloc(0)

  connect(pipeName: string): void {
    this.name = pipeName
    this.stopSocket()
    this.open()
  }

  private open(): void {
    if (!this.name) return

    const socket = net.connect({ path: this.name })
    this.socket = socket

    socket.on('connect', () => {
      console.log('[audio] pipe connected')
      this.tail = Buffer.alloc(0)
    })

    socket.on('data', (chunk: Buffer) => {
      const data = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk
      const usable = data.length - (data.length % 4)
      this.tail = usable === data.length ? Buffer.alloc(0) : data.subarray(usable)
      if (usable === 0) return

      // Copy out: the Buffer is pooled and would be recycled under us.
      const out = new ArrayBuffer(usable)
      new Uint8Array(out).set(data.subarray(0, usable))
      this.emit('pcm', out)
    })

    const reconnect = () => {
      if (this.socket !== socket) return
      this.socket = null
      // The daemon recreates the pipe between clients, so a drop is routine
      // rather than fatal.
      if (this.retry) clearTimeout(this.retry)
      this.retry = setTimeout(() => this.open(), 500)
    }

    socket.on('error', reconnect)
    socket.on('close', reconnect)
  }

  private stopSocket(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
    if (this.socket) {
      const socket = this.socket
      this.socket = null
      socket.destroy()
    }
  }

  stop(): void {
    this.name = null
    this.stopSocket()
  }
}

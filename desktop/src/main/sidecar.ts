import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Manages the `hollow-core` daemon and the newline-delimited JSON protocol
 * spoken over its stdio.
 *
 * The daemon is a child process rather than a service: it inherits our lifetime,
 * so quitting Hollow cannot leave a Steam session or an audio capture running.
 */
export class Sidecar extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  /** stdout arrives in arbitrary chunks; hold the incomplete tail here. */
  private buffer = ''

  start(): void {
    const bin = resolveBinary()
    if (!bin) {
      this.emit('fatal', new Error('hollow-core executable not found. Run `cargo build --release`.'))
      return
    }

    this.child = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))

    // The daemon logs to stderr precisely so it never corrupts the JSON stream.
    // An installed build has no console attached, so this is emitted rather
    // than printed: the main process is what decides where it lands.
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.emit('log', line.trim())
      }
    })

    this.child.on('exit', (code) => {
      this.rejectAllPending(new Error(`hollow-core exited with code ${code}`))
      this.emit('exit', code)
    })

    this.child.on('error', (err) => this.emit('fatal', err))
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue

      let message: Record<string, unknown>
      try {
        message = JSON.parse(line)
      } catch {
        this.emit('log', `unparseable line: ${line.slice(0, 200)}`)
        continue
      }

      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id)
        if (!waiter) continue
        this.pending.delete(message.id)
        if (message.ok) waiter.resolve(message.result ?? null)
        else waiter.reject(new Error(String(message.error ?? 'request failed')))
      } else if (typeof message.event === 'string') {
        this.emit('event', message.event, message.data)
      }
    }
  }

  /** Issue a request and wait for its matching response. */
  request(method: string, params: unknown = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error('hollow-core is not running'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  stop(): void {
    if (!this.child) return
    // Closing stdin is the documented shutdown signal; the daemon leaves its
    // Steam lobby and stops capture on its way out.
    this.child.stdin.end()
    const child = this.child
    this.child = null
    setTimeout(() => {
      if (!child.killed) child.kill()
    }, 1500)
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}

/**
 * Find `hollow-core`. Packaged builds carry it in `resources`; during
 * development it comes from the cargo target directory.
 */
function resolveBinary(): string | null {
  const exe = process.platform === 'win32' ? 'hollow-core.exe' : 'hollow-core'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, exe)]
    : [
        join(__dirname, '../../../target/release', exe),
        join(__dirname, '../../../target/debug', exe),
      ]

  return candidates.find((path) => existsSync(path)) ?? null
}

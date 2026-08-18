import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, desktopCapturer, dialog, ipcMain, session, shell } from 'electron'
import { Sidecar } from './sidecar'
import { AudioPipe } from './audio-pipe'

/**
 * Main process: owns the window, the `hollow-core` child process and the
 * privileged Electron APIs. The renderer gets a narrow, explicit surface
 * through the preload bridge and never sees Node.
 */

let window: BrowserWindow | null = null
const sidecar = new Sidecar()
const audioPipe = new AudioPipe()

/**
 * The screen or window the user picked, set just before the renderer calls
 * `getDisplayMedia`. Electron's display-media handler has no way to ask the
 * renderer mid-flight, so the choice is staged here.
 */
let pendingScreenSource: string | null = null

/**
 * Where a failed call explains itself.
 *
 * An installed build has no console: the daemon's stderr and the renderer's
 * WebRTC trace both go nowhere, which leaves "nobody could hear anything" with
 * no evidence attached to it. Both ends append here instead, and Settings can
 * open the file.
 */
const logPath = join(app.getPath('userData'), 'hollow.log')

function log(source: string, line: string): void {
  try {
    appendFileSync(logPath, `${new Date().toISOString()} [${source}] ${line}\n`)
  } catch {
    // Logging must never be the thing that breaks a call.
  }
}

/**
 * Start each run with an empty file.
 *
 * The question this log answers is always about the session that just failed,
 * and a file that grows across every run is one nobody scrolls back through.
 */
function startLog(): void {
  try {
    writeFileSync(logPath, '')
    log('app', `Hollow ${app.getVersion()} on ${process.platform} ${process.getSystemVersion()}`)
  } catch {
    // Same rule: never fatal.
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Screen capture and WebRTC both need the full renderer, and the preload
      // bundle is CommonJS. contextIsolation is what keeps the boundary honest.
      sandbox: false,
    },
  })

  window.once('ready-to-show', () => window?.show())

  // Anything that wants a new window is an external link; hand it to the OS
  // browser rather than opening an unsandboxed Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    window = null
  })

  window.on('maximize', () => window?.webContents.send('window:state', true))
  window.on('unmaximize', () => window?.webContents.send('window:state', false))
}

function configureSession(): void {
  const ses = session.defaultSession

  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const chosen = sources.find((s) => s.id === pendingScreenSource) ?? sources[0]
      if (!chosen) {
        callback({})
        return
      }
      // Video only, on purpose. Electron's loopback capture is refused
      // outright by a good number of Windows machines, and where it does work it
      // returns the whole endpoint mix with no way to shape it or to leave the
      // call itself out. Broadcast audio comes from the daemon's own capture.
      callback({ video: chosen })
    },
    // Hollow draws its own picker so it can show the windows by name.
    { useSystemPicker: false },
  )

  // Only the mic and camera are ever requested, and only from our own page.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  // Chromium asks this one synchronously, on a different path from the request
  // above: it gates device labels in `enumerateDevices` and the capture check
  // `getUserMedia` runs before it ever prompts. Left at Electron's default the
  // settings dropdowns come back as blank entries with no names.
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media')
}

app.whenReady().then(() => {
  startLog()
  configureSession()
  createWindow()

  sidecar.on('event', (name: string, data: unknown) => {
    // The daemon's own diagnostics stop here: they are for the file, and
    // forwarding them would only give the renderer a case it has to ignore.
    if (name === 'log') {
      const entry = data as { source?: string; message?: string }
      log(entry.source ?? 'core', entry.message ?? '')
      return
    }
    window?.webContents.send('core:event', name, data)
  })
  sidecar.on('log', (line: string) => log('core', line))
  sidecar.on('fatal', (err: Error) => {
    log('core', `fatal: ${err.message}`)
    window?.webContents.send('core:event', 'error', { message: err.message, fatal: true })
  })
  sidecar.on('exit', (code: number | null) => {
    log('core', `hollow-core exited with code ${code}`)
    window?.webContents.send('core:event', 'error', {
      message: `hollow-core stopped (code ${code}). Restart Hollow.`,
      fatal: true,
    })
  })
  sidecar.start()

  audioPipe.on('pcm', (chunk: ArrayBuffer) => {
    // Realtime path: if the window is gone there is nothing to feed.
    window?.webContents.send('audio:pcm', chunk)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sidecar.stop()
  audioPipe.stop()
  app.quit()
})

app.on('before-quit', () => {
  sidecar.stop()
  audioPipe.stop()
})

// --- IPC ---------------------------------------------------------------------

ipcMain.handle('core:request', (_e, method: string, params: unknown) =>
  sidecar.request(method, params),
)

/** Screen and window sources, with thumbnails, for Hollow's own picker. */
ipcMain.handle('screen:sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 240 },
    fetchWindowIcons: true,
  })
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
  }))
})

/** Stage the chosen source; the display-media handler reads it next. */
ipcMain.handle('screen:choose', (_e, sourceId: string | null) => {
  pendingScreenSource = sourceId
})

/**
 * Pick files to send someone.
 *
 * Paths, not contents: the daemon streams the file off disk a chunk at a time,
 * so reading gigabytes through the renderer to hand them straight back would be
 * pure waste. Modal on the window so it cannot end up behind it.
 */
ipcMain.handle('files:pick', async () => {
  const owner = window
  const result = owner
    ? await dialog.showOpenDialog(owner, {
        title: 'Send files',
        buttonLabel: 'Send',
        properties: ['openFile', 'multiSelections'],
      })
    : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('audio:connect', (_e, pipeName: string) => {
  audioPipe.connect(pipeName)
})

ipcMain.handle('audio:disconnect', () => audioPipe.stop())

/**
 * The renderer's half of the log.
 *
 * WebRTC only explains itself from inside the page — which peer answered, which
 * ICE state it reached, which track arrived — and none of that survives in an
 * installed build. `send` rather than `invoke` because a signaling trace should
 * not cost a promise per line.
 */
ipcMain.on('log:write', (_e, line: string) => log('ui', line))

/**
 * The tail of the log, for the report Settings puts on the clipboard.
 *
 * Reading it back rather than keeping a second copy in the renderer means the
 * report carries the daemon's lines too, which are the ones that explain a
 * Steam problem.
 */
ipcMain.handle('log:tail', (_e, lines: number) => {
  try {
    const all = readFileSync(logPath, 'utf8').split('\n')
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  } catch {
    return ''
  }
})

/** Open the log in whatever the OS uses for text files. */
ipcMain.handle('log:open', () => shell.openPath(logPath))

/** Show it in Explorer instead, for when it needs to be attached to something. */
ipcMain.handle('log:reveal', () => shell.showItemInFolder(logPath))

ipcMain.handle('window:minimize', () => window?.minimize())
ipcMain.handle('window:maximize', () => {
  if (!window) return
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
})
ipcMain.handle('window:close', () => window?.close())

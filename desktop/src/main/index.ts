import { join } from 'node:path'
import { BrowserWindow, app, desktopCapturer, ipcMain, session, shell } from 'electron'
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

  // Screen share. `audio: 'loopback'` captures what the machine is playing;
  // it is Windows-only, which is fine because Hollow is Windows-only today.
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const chosen = sources.find((s) => s.id === pendingScreenSource) ?? sources[0]
      if (!chosen) {
        callback({})
        return
      }
      callback({
        video: chosen,
        ...(request.audioRequested ? { audio: 'loopback' as const } : {}),
      })
    },
    // Hollow draws its own picker so it can show which sources carry audio.
    { useSystemPicker: false },
  )

  // Only the mic and camera are ever requested, and only from our own page.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
}

app.whenReady().then(() => {
  configureSession()
  createWindow()

  sidecar.on('event', (name: string, data: unknown) => {
    window?.webContents.send('core:event', name, data)
  })
  sidecar.on('fatal', (err: Error) => {
    window?.webContents.send('core:event', 'error', { message: err.message, fatal: true })
  })
  sidecar.on('exit', (code: number | null) => {
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

ipcMain.handle('audio:connect', (_e, pipeName: string) => {
  audioPipe.connect(pipeName)
})

ipcMain.handle('audio:disconnect', () => audioPipe.stop())

ipcMain.handle('window:minimize', () => window?.minimize())
ipcMain.handle('window:maximize', () => {
  if (!window) return
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
})
ipcMain.handle('window:close', () => window?.close())

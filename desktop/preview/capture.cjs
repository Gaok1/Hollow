/**
 * Captures the README screenshots from the preview server.
 *
 * Electron rather than a headless browser because it is already a dependency
 * here and it is the same Chromium the app itself renders in — the images are
 * what the window actually looks like, not an approximation of it.
 */
const { app, BrowserWindow } = require('electron')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const OUT = join(__dirname, '..', '..', 'docs')
const scenes = [
  { name: 'server', file: 'server.png' },
  // Hovering a friend is what reveals the send-file button.
  { name: 'home', file: 'home.png', hover: [190, 344] },
  { name: 'call', file: 'call.png' },
]

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    frame: false,
    backgroundColor: '#0a0c11',
  })

  for (const scene of scenes) {
    await win.loadURL(`http://localhost:5199/?scene=${scene.name}`)
    // The stub drives the app into the scene on a timer after mount.
    await wait(2500)

    if (scene.hover) {
      // A real pointer, so the row shows the state it genuinely shows on hover
      // rather than one forced on with injected CSS.
      const [x, y] = scene.hover
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
      await wait(400)
    }

    const image = await win.webContents.capturePage()
    writeFileSync(join(OUT, scene.file), image.toPNG())
    console.log(`wrote ${scene.file}`)
  }

  app.quit()
})

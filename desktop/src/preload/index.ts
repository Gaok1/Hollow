import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The entire surface the renderer gets. Everything privileged — the daemon, the
 * capture APIs, the window chrome — is reachable only through these calls.
 */
const api = {
  /** Issue a JSON-RPC request to `hollow-core`. */
  request: (method: string, params: unknown = {}): Promise<unknown> =>
    ipcRenderer.invoke('core:request', method, params),

  /** Subscribe to daemon events. Returns an unsubscribe function. */
  onEvent: (handler: (event: string, data: unknown) => void): (() => void) => {
    const listener = (_e: unknown, name: string, data: unknown) => handler(name, data)
    ipcRenderer.on('core:event', listener)
    return () => ipcRenderer.off('core:event', listener)
  },

  /**
   * Real filesystem path of a dropped file.
   *
   * `File.path` was removed in Electron 32; `webUtils` is the replacement and
   * only works from the preload. The daemon streams files off disk, so it needs
   * the path rather than the contents.
   */
  getFilePath: (file: File): string => webUtils.getPathForFile(file),

  screen: {
    sources: (): Promise<ScreenSource[]> => ipcRenderer.invoke('screen:sources'),
    choose: (sourceId: string | null): Promise<void> =>
      ipcRenderer.invoke('screen:choose', sourceId),
  },

  audio: {
    connect: (pipeName: string): Promise<void> => ipcRenderer.invoke('audio:connect', pipeName),
    disconnect: (): Promise<void> => ipcRenderer.invoke('audio:disconnect'),
    /** Mixed broadcast PCM from the Rust mixer. Returns an unsubscribe function. */
    onPcm: (handler: (chunk: ArrayBuffer) => void): (() => void) => {
      const listener = (_e: unknown, chunk: ArrayBuffer) => handler(chunk)
      ipcRenderer.on('audio:pcm', listener)
      return () => ipcRenderer.off('audio:pcm', listener)
    },
  },

  /**
   * Hollow's log file, shared by the daemon, the main process and the page.
   * A call that fails on someone else's machine is only diagnosable if the
   * renderer's side of it was written down too.
   */
  log: {
    write: (line: string): void => ipcRenderer.send('log:write', line),
    open: (): Promise<void> => ipcRenderer.invoke('log:open'),
    tail: (lines: number): Promise<string> => ipcRenderer.invoke('log:tail', lines),
    reveal: (): Promise<void> => ipcRenderer.invoke('log:reveal'),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onStateChange: (handler: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: unknown, maximized: boolean) => handler(maximized)
      ipcRenderer.on('window:state', listener)
      return () => ipcRenderer.off('window:state', listener)
    },
  },
}

export interface ScreenSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail: string | null
  appIcon: string | null
}

contextBridge.exposeInMainWorld('hollow', api)

export type HollowApi = typeof api

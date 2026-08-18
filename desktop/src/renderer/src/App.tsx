import { useEffect } from 'react'
import { useStore } from './store'
import { FatalError, TitleBar, Toasts } from './components/chrome'
import { Sidebar } from './components/sidebar'
import { Stage } from './components/stage'
import { ControlBar, ScreenPicker } from './components/controls'
import { MixerPanel, SettingsPanel } from './components/panels'
import { ChatPanel } from './components/chat'
import { Transfers, useFileDrop } from './components/transfers'

export default function App() {
  const init = useStore((s) => s.init)
  const fatal = useStore((s) => s.fatal)
  const mixerOpen = useStore((s) => s.mixerOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const chatOpen = useStore((s) => s.chatOpen)
  const { dragging, handlers } = useFileDrop()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="app">
      <TitleBar />

      {fatal ? (
        <FatalError message={fatal} />
      ) : (
        <div
          className={`layout ${mixerOpen || settingsOpen || chatOpen ? 'layout--panelled' : ''}`}
        >
          <Sidebar />
          <main className="main" {...handlers}>
            <Stage />
            <Transfers />
            <ControlBar />
            {dragging && <div className="dropzone">Drop to send to everyone in the call</div>}
          </main>
          <MixerPanel />
          <SettingsPanel />
          <ChatPanel />
        </div>
      )}

      <ScreenPicker />
      <Toasts />
    </div>
  )
}

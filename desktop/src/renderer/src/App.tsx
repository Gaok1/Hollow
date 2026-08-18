import { useEffect } from 'react'
import { useStore } from './store'
import { FatalError, TitleBar, Toasts } from './components/chrome'
import { Rail } from './components/rail'
import { Sidebar } from './components/sidebar'
import { Stage } from './components/stage'
import { ControlBar, ScreenPicker } from './components/controls'
import { MixerPanel, SettingsPanel } from './components/panels'
import { ChatPanel, ChatView } from './components/chat'
import { Transfers, useFileDrop } from './components/transfers'

export default function App() {
  const init = useStore((s) => s.init)
  const fatal = useStore((s) => s.fatal)
  const mixerOpen = useStore((s) => s.mixerOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const chatOpen = useStore((s) => s.chatOpen)
  const room = useStore((s) => s.room)
  const selected = useStore((s) => s.selected)
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
          <Rail />
          <Sidebar />
          {/*
            A live call owns the middle of the window; it is the thing with
            moving pictures in it and the thing that stops working if it is
            hidden. Reading a conversation while a call runs happens in the
            panel on the right instead.
          */}
          <main className="main" {...handlers}>
            {room ? (
              <>
                <Stage />
                <Transfers />
                <ControlBar />
                {dragging && <div className="dropzone">Drop to send to everyone in the call</div>}
              </>
            ) : selected ? (
              <>
                <ChatView conversationId={selected} />
                <Transfers />
              </>
            ) : (
              <>
                <Stage />
                <Transfers />
                <ControlBar />
              </>
            )}
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

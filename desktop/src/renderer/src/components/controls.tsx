import { useState, type ReactNode } from 'react'
import { useStore } from '../store'
import {
  CameraIcon,
  CameraOffIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  MixerIcon,
  ScreenIcon,
  ScreenOffIcon,
  SettingsIcon,
  SpeakerIcon,
  SpeakerOffIcon,
} from './icons'

interface ControlProps {
  label: string
  active?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}

function Control({ label, active, danger, onClick, children }: ControlProps) {
  return (
    <button
      className={`control ${active ? 'control--active' : ''} ${danger ? 'control--danger' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  )
}

export function ControlBar() {
  const room = useStore((s) => s.room)
  const localPresence = useStore((s) => s.localPresence)
  const toggleMic = useStore((s) => s.toggleMic)
  const toggleDeafen = useStore((s) => s.toggleDeafen)
  const toggleCamera = useStore((s) => s.toggleCamera)
  const openPicker = useStore((s) => s.openPicker)
  const stopShare = useStore((s) => s.stopShare)
  const leaveRoom = useStore((s) => s.leaveRoom)
  const toggle = useStore((s) => s.toggle)
  const mixerOpen = useStore((s) => s.mixerOpen)
  const settingsOpen = useStore((s) => s.settingsOpen)

  if (!room) return null

  return (
    <footer className="controlbar">
      <div className="controlbar__group">
        <Control
          label={localPresence.micMuted ? 'Unmute microphone' : 'Mute microphone'}
          active={!localPresence.micMuted}
          onClick={toggleMic}
        >
          {localPresence.micMuted ? <MicOffIcon /> : <MicIcon />}
        </Control>

        <Control
          label={localPresence.deafened ? 'Undeafen' : 'Deafen'}
          active={!localPresence.deafened}
          onClick={() => void toggleDeafen()}
        >
          {localPresence.deafened ? <SpeakerOffIcon size={20} /> : <SpeakerIcon size={20} />}
        </Control>

        <Control
          label={localPresence.cameraOn ? 'Turn camera off' : 'Turn camera on'}
          active={localPresence.cameraOn}
          onClick={toggleCamera}
        >
          {localPresence.cameraOn ? <CameraIcon /> : <CameraOffIcon />}
        </Control>

        <Control
          label={localPresence.sharingScreen ? 'Stop sharing' : 'Share your screen'}
          active={localPresence.sharingScreen}
          onClick={() => (localPresence.sharingScreen ? void stopShare() : void openPicker())}
        >
          {localPresence.sharingScreen ? <ScreenOffIcon /> : <ScreenIcon />}
        </Control>
      </div>

      <div className="controlbar__group">
        <Control label="Audio mixer" active={mixerOpen} onClick={() => toggle('mixer')}>
          <MixerIcon />
        </Control>
        <Control label="Settings" active={settingsOpen} onClick={() => toggle('settings')}>
          <SettingsIcon />
        </Control>
        <Control label="Leave call" danger onClick={() => void leaveRoom()}>
          <LeaveIcon />
        </Control>
      </div>
    </footer>
  )
}

export function ScreenPicker() {
  const open = useStore((s) => s.pickerOpen)
  const sources = useStore((s) => s.screenSources)
  const close = useStore((s) => s.closePicker)
  const startShare = useStore((s) => s.startShare)
  const info = useStore((s) => s.info)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'screen' | 'window'>('screen')

  if (!open) return null

  const shown = sources.filter((s) => s.kind === tab)
  const perProcess = info?.capabilities.perProcessCapture ?? false

  return (
    <div className="modal" role="dialog" aria-modal onClick={close}>
      <div className="modal__panel modal__panel--wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>Share your screen</h2>
          <div className="tabs">
            <button
              className={tab === 'screen' ? 'tabs__tab tabs__tab--on' : 'tabs__tab'}
              onClick={() => setTab('screen')}
            >
              Screens
            </button>
            <button
              className={tab === 'window' ? 'tabs__tab tabs__tab--on' : 'tabs__tab'}
              onClick={() => setTab('window')}
            >
              Windows
            </button>
          </div>
        </header>

        <div className="sources">
          {shown.map((source) => (
            <button
              key={source.id}
              className={`source ${selected === source.id ? 'source--on' : ''}`}
              onClick={() => setSelected(source.id)}
              onDoubleClick={() => void startShare(source.id)}
            >
              <div className="source__thumb">
                {source.thumbnail ? (
                  <img src={source.thumbnail} alt="" />
                ) : (
                  <div className="source__blank" />
                )}
              </div>
              <span className="source__name">
                {source.appIcon && <img className="source__icon" src={source.appIcon} alt="" />}
                {source.name}
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="sidebar__empty">Nothing to show here.</p>}
        </div>

        <p className="notice">
          {perProcess
            ? 'Audio comes from the mixer, so you choose exactly which apps are heard. Muting an app there does not change what you hear.'
            : `System audio is shared as a whole on Windows build ${info?.capabilities.windowsBuild ?? '?'}. The mixer adjusts Windows' own volume levels, so muting an app there mutes it for you too.`}
        </p>

        <footer className="modal__foot">
          <button className="btn btn--ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!selected}
            onClick={() => selected && void startShare(selected)}
          >
            Share
          </button>
        </footer>
      </div>
    </div>
  )
}

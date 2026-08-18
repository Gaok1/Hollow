import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { listDevices } from '../lib/media'
import type { AppAudioSession } from '../types'
import { CloseIcon, SpeakerIcon, SpeakerOffIcon } from './icons'

/** A peak meter. Rendered as a bar rather than a number: nobody reads dBFS. */
function Meter({ level, active }: { level: number; active: boolean }) {
  return (
    <div className="meter" aria-hidden>
      <div
        className={`meter__fill ${active ? '' : 'meter__fill--idle'}`}
        style={{ transform: `scaleX(${Math.min(1, level)})` }}
      />
    </div>
  )
}

function SessionRow({ session }: { session: AppAudioSession }) {
  const mixer = useStore((s) => s.mixer)
  const gains = useStore((s) => s.gains)
  const setGain = useStore((s) => s.setGain)
  const setSessionVolume = useStore((s) => s.setSessionVolume)

  const perProcess = mixer?.mode === 'perProcess'

  // In per-process mode the slider is a broadcast gain Hollow owns. Otherwise
  // it is the Windows session volume, which is shared with everything else on
  // the machine — including what the user hears.
  const gain = gains[session.pid]?.gain ?? (session.broadcast ? 1 : 0)
  const muted = perProcess ? (gains[session.pid]?.muted ?? false) : session.muted
  const value = perProcess ? gain : session.volume

  const onValue = (next: number) => {
    if (perProcess) void setGain(session.pid, next, muted)
    else void setSessionVolume(session.pid, next, muted)
  }

  const onMute = () => {
    if (perProcess) void setGain(session.pid, gain, !muted)
    else void setSessionVolume(session.pid, session.volume, !session.muted)
  }

  const included = perProcess ? !muted && gain > 0 : true

  return (
    <li className={`session ${session.active ? '' : 'session--idle'}`}>
      <div className="session__icon">
        {session.icon ? (
          <img src={session.icon} alt="" />
        ) : (
          <div className="session__icon-blank">{session.name.slice(0, 1)}</div>
        )}
      </div>

      <div className="session__body">
        <div className="session__head">
          <span className="session__name" title={session.executable ?? session.name}>
            {session.name}
          </span>
          {perProcess && (
            <label className="switch" title="Include this app in the broadcast">
              <input
                type="checkbox"
                checked={included}
                onChange={(e) => setGain(session.pid, e.target.checked ? 1 : 0, false)}
              />
              <span className="switch__track">
                <span className="switch__thumb" />
              </span>
            </label>
          )}
        </div>

        <Meter level={session.peak} active={session.active && !muted} />

        <div className="session__controls">
          <button className="iconbtn" onClick={onMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <SpeakerOffIcon size={14} /> : <SpeakerIcon size={14} />}
          </button>
          <input
            className="slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={value}
            onChange={(e) => onValue(Number(e.target.value))}
            disabled={muted}
          />
          <span className="session__value">{Math.round(value * 100)}</span>
        </div>
      </div>
    </li>
  )
}

export function MixerPanel() {
  const open = useStore((s) => s.mixerOpen)
  const mixer = useStore((s) => s.mixer)
  const info = useStore((s) => s.info)
  const toggle = useStore((s) => s.toggle)
  const setMasterGain = useStore((s) => s.setMasterGain)
  const [master, setMaster] = useState(1)

  if (!open) return null

  const perProcess = info?.capabilities.perProcessCapture ?? false
  const sessions = mixer?.sessions ?? []

  return (
    <aside className="panel">
      <header className="panel__head">
        <h2>Broadcast mixer</h2>
        <button className="iconbtn" onClick={() => toggle('mixer')} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <p className={`notice ${perProcess ? '' : 'notice--warn'}`}>
        {info?.capabilities.note}
      </p>

      {perProcess && (
        <div className="master">
          <span className="master__label">Master</span>
          <Meter level={mixer?.masterPeak ?? 0} active />
          <input
            className="slider"
            type="range"
            min={0}
            max={1.5}
            step={0.01}
            value={master}
            onChange={(e) => {
              const next = Number(e.target.value)
              setMaster(next)
              void setMasterGain(next)
            }}
          />
        </div>
      )}

      <ul className="sessions">
        {sessions.map((session) => (
          <SessionRow key={session.id} session={session} />
        ))}
      </ul>

      {sessions.length === 0 && (
        <p className="sidebar__empty">
          No applications are playing audio right now. Start something and it will appear here.
        </p>
      )}
    </aside>
  )
}

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const info = useStore((s) => s.info)
  const toggle = useStore((s) => s.toggle)
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listDevices>> | null>(null)

  useEffect(() => {
    if (open) void listDevices().then(setDevices)
  }, [open])

  if (!open) return null

  return (
    <aside className="panel">
      <header className="panel__head">
        <h2>Settings</h2>
        <button className="iconbtn" onClick={() => toggle('settings')} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <section className="field">
        <label htmlFor="mic">Microphone</label>
        <select
          id="mic"
          value={settings.microphoneId ?? ''}
          onChange={(e) => update({ microphoneId: e.target.value || undefined })}
        >
          <option value="">System default</option>
          {devices?.microphones.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Microphone'}
            </option>
          ))}
        </select>
      </section>

      <section className="field">
        <label htmlFor="cam">Camera</label>
        <select
          id="cam"
          value={settings.cameraId ?? ''}
          onChange={(e) => update({ cameraId: e.target.value || undefined })}
        >
          <option value="">System default</option>
          {devices?.cameras.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || 'Camera'}
            </option>
          ))}
        </select>
      </section>

      <section className="field">
        <label htmlFor="fps">Screen share frame rate</label>
        <select
          id="fps"
          value={settings.screenFrameRate}
          onChange={(e) => update({ screenFrameRate: Number(e.target.value) })}
        >
          <option value={15}>15 fps — documents and code</option>
          <option value={30}>30 fps — balanced</option>
          <option value={60}>60 fps — games and video</option>
        </select>
        <p className="field__hint">
          Higher frame rates spend the same bandwidth on more, blurrier frames. Text stays sharpest
          at 15.
        </p>
      </section>

      <section className="field">
        <label htmlFor="turn">TURN relay (optional)</label>
        <input
          id="turn"
          placeholder="turn:host:3478"
          value={settings.turnUrl ?? ''}
          onChange={(e) => update({ turnUrl: e.target.value || undefined })}
          spellCheck={false}
        />
        <div className="field__row">
          <input
            placeholder="username"
            value={settings.turnUsername ?? ''}
            onChange={(e) => update({ turnUsername: e.target.value || undefined })}
            spellCheck={false}
          />
          <input
            placeholder="credential"
            type="password"
            value={settings.turnCredential ?? ''}
            onChange={(e) => update({ turnCredential: e.target.value || undefined })}
          />
        </div>
        <p className="field__hint">
          Steam carries the call setup, but media negotiates its own path. Two peers both behind
          strict (symmetric) NAT need a relay to reach each other. Leave this empty unless a call
          fails to connect.
        </p>
      </section>

      <section className="about">
        <div>
          <span>Version</span>
          <span>{info?.version ?? '—'}</span>
        </div>
        <div>
          <span>Steam app id</span>
          <span>{info?.appId ?? '—'}</span>
        </div>
        <div>
          <span>Windows build</span>
          <span>{info?.capabilities.windowsBuild ?? '—'}</span>
        </div>
        <div>
          <span>Downloads</span>
          <span title={info?.downloadDir}>{info?.downloadDir ?? '—'}</span>
        </div>
      </section>
    </aside>
  )
}

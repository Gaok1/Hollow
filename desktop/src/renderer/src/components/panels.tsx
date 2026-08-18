import { useEffect, useState } from 'react'
import { BROADCAST_GAIN_MAX, systemAudioWanted, useStore } from '../store'
import { MIC_BOOST_MAX, MIC_BOOST_MIN, listDevices } from '../lib/media'
import type { Settings } from '../store'
import type { AppAudioSession } from '../types'
import { useMicLevel } from './controls'
import { CloseIcon, SpeakerIcon, SpeakerOffIcon } from './icons'
import { Slider } from './slider'

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

function SessionRow({ session, perProcess }: { session: AppAudioSession; perProcess: boolean }) {
  const gains = useStore((s) => s.gains)
  const setGain = useStore((s) => s.setGain)

  const gain = gains[session.pid]?.gain ?? (session.broadcast ? 1 : 0)
  const muted = gains[session.pid]?.muted ?? false
  const included = !muted && gain > 0

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

        {perProcess ? (
          <div className="session__controls">
            <button
              className="iconbtn"
              onClick={() => setGain(session.pid, gain, !muted)}
              aria-label={muted ? 'Unmute in the broadcast' : 'Mute in the broadcast'}
            >
              {muted ? <SpeakerOffIcon size={14} /> : <SpeakerIcon size={14} />}
            </button>
            <Slider
              min={0}
              max={1}
              value={gain}
              disabled={muted}
              onChange={(next) => void setGain(session.pid, next, muted)}
            />
            <span className="session__value">{Math.round(gain * 100)}</span>
          </div>
        ) : (
          session.muted && <span className="session__note">Muted in Windows</span>
        )}
      </div>
    </li>
  )
}

export function MixerPanel() {
  const open = useStore((s) => s.mixerOpen)
  const mixer = useStore((s) => s.mixer)
  const info = useStore((s) => s.info)
  const sharing = useStore((s) => s.localPresence.sharingScreen)
  const settings = useStore((s) => s.settings)
  const toggle = useStore((s) => s.toggle)
  const update = useStore((s) => s.updateSettings)
  const setMasterGain = useStore((s) => s.setMasterGain)

  if (!open) return null

  const perProcess = info?.capabilities.perProcessCapture ?? false
  const sessions = mixer?.sessions ?? []
  const sending = systemAudioWanted(settings.systemAudio, perProcess)

  return (
    <aside className="panel">
      <header className="panel__head">
        <h2>Broadcast mixer</h2>
        <button className="iconbtn" onClick={() => toggle('mixer')} aria-label="Close">
          <CloseIcon />
        </button>
      </header>

      <div className="master__row">
        <label className="switch" title="Send this machine's audio with the share">
          <input
            type="checkbox"
            checked={sending}
            onChange={(e) => update({ systemAudio: e.target.checked ? 'on' : 'off' })}
          />
          <span className="switch__track">
            <span className="switch__thumb" />
          </span>
        </label>
        <span className="master__label">Send system audio</span>
      </div>

      {/* Nothing here writes a Windows volume: every gain below is applied on
          the way out, in the daemon's mixer thread. What this machine plays is
          left exactly as the user set it. */}
      <p className={`notice ${perProcess ? '' : 'notice--warn'}`}>
        {perProcess
          ? 'Each app can be included on its own, and the levels here change only what the others hear.'
          : 'This Windows build cannot capture applications separately, so the only thing available to send is the whole output — which includes the call itself, and comes back to everyone as an echo. Per-app control needs Windows build 20348 or later.'}
      </p>

      {sending && (
        <div className="master">
          <span className="master__label">Master</span>
          <Meter level={mixer?.masterPeak ?? 0} active={sharing} />
          <Slider
            min={0}
            max={BROADCAST_GAIN_MAX}
            value={settings.broadcastGain}
            onChange={(next) => void setMasterGain(next)}
            aria-label="Broadcast volume"
          />
          <span className="session__value">{Math.round(settings.broadcastGain * 100)}</span>
        </div>
      )}

      <ul className="sessions">
        {sessions.map((session) => (
          <SessionRow key={session.id} session={session} perProcess={perProcess} />
        ))}
      </ul>

      {sessions.length === 0 && (
        <p className="sidebar__empty">
          No applications are playing audio right now. Start something and it will appear here.
        </p>
      )}

      <p className="field__hint">{info?.capabilities.note}</p>
    </aside>
  )
}

/**
 * Per-peer link state, in the terms that identify a fault rather than restate
 * it: whether the two sides agreed a session, what ICE settled on, what media
 * is arriving, and which candidate types were found at all.
 */
function Diagnostics() {
  const room = useStore((s) => s.room)
  const me = useStore((s) => s.me)
  const health = useStore((s) => s.health)

  const peers = (room?.members ?? []).filter((m) => m.id !== me?.id)
  if (peers.length === 0) {
    return <p className="field__hint">Nothing to report — you are not in a call with anyone.</p>
  }

  return (
    <ul className="diag">
      {peers.map((peer) => {
        const link = health[peer.id]
        const candidates = Object.entries(link?.candidates ?? {})
        return (
          <li key={peer.id} className="diag__row">
            <span className="diag__name">{peer.persona}</span>
            <span className={`diag__state diag__state--${link?.connection ?? 'none'}`}>
              {link?.connection ?? 'no link'}
            </span>
            <span className="diag__detail">
              ice {link?.ice ?? '—'} ·{' '}
              {link?.negotiated ? 'session agreed' : 'no answer yet'} ·{' '}
              {link && link.receiving.length > 0 ? link.receiving.join(' + ') : 'no media'}
              {candidates.length > 0 &&
                ` · ${candidates.map(([kind, count]) => `${kind}×${count}`).join(' ')}`}
            </span>
            {link && link.connection === 'connected' && (
              <span className="diag__detail">
                {link.quality.route} · {link.quality.rttMs} ms ·{' '}
                {(link.quality.loss * 100).toFixed(1)}% loss · ↑
                {Math.round(link.quality.outBps / 1000)} ↓
                {Math.round(link.quality.inBps / 1000)} kbps
                {link.quality.availableBps > 0 &&
                  ` · link fits ${Math.round(link.quality.availableBps / 1000)} kbps`}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const info = useStore((s) => s.info)
  const toggle = useStore((s) => s.toggle)
  const openLog = useStore((s) => s.openLog)
  const revealLog = useStore((s) => s.revealLog)
  const copyReport = useStore((s) => s.copyReport)
  const setMicBoost = useStore((s) => s.setMicBoost)
  const mic = useStore((s) => s.local.mic)
  const micMuted = useStore((s) => s.localPresence.micMuted)
  const micLevel = useMicLevel()
  const perProcess = info?.capabilities.perProcessCapture ?? false
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listDevices>> | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (open) void listDevices().then(setDevices)
  }, [open])

  // The confirmation is worth nothing if it stays there.
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(id)
  }, [copied])

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
        <label htmlFor="boost">Microphone boost</label>
        <div className="boost">
          <Slider
            id="boost"
            min={MIC_BOOST_MIN}
            max={MIC_BOOST_MAX}
            step={0.05}
            value={settings.micBoost}
            onChange={setMicBoost}
          />
          <span className="boost__value">{Math.round(settings.micBoost * 100)}%</span>
        </div>
        <Meter level={micLevel} active={Boolean(mic) && !micMuted} />
        <p className="field__hint">
          {!mic
            ? 'The meter moves once you are in a call with your microphone on.'
            : micMuted
              ? 'Unmute to watch the level while you set this.'
              : 'The meter shows what the others receive, boost included. Aim for the bar moving well across on normal speech — a limiter catches the peaks, so this will not clip.'}
        </p>
        {settings.micBoost !== 1 && (
          <button className="btn btn--ghost btn--tiny" onClick={() => setMicBoost(1)}>
            Reset to 100%
          </button>
        )}
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
        <label htmlFor="height">Screen share resolution</label>
        <select
          id="height"
          value={settings.screenHeight}
          onChange={(e) => update({ screenHeight: Number(e.target.value) })}
        >
          <option value={0}>Whatever the display is</option>
          <option value={1440}>1440p</option>
          <option value={1080}>1080p</option>
          <option value={900}>900p</option>
          <option value={720}>720p — small text goes soft</option>
          <option value={540}>540p — motion over detail</option>
        </select>
        <p className="field__hint">
          Frame rate and resolution spend the same bandwidth, so one is bought with the other. Text
          stays sharpest tall and slow; a game reads better short and fast. Both apply to a share
          already running.
        </p>
      </section>

      <section className="field">
        <label htmlFor="sysaudio">System audio in a share</label>
        <select
          id="sysaudio"
          value={settings.systemAudio}
          onChange={(e) => update({ systemAudio: e.target.value as Settings['systemAudio'] })}
        >
          <option value="auto">
            Automatic — {perProcess ? 'sent, app by app' : 'not sent on this build'}
          </option>
          <option value="on">Always send it</option>
          <option value="off">Never send it</option>
        </select>
        <p className="field__hint">
          {perProcess
            ? 'This build can capture applications one at a time, so the mixer decides which of them the others hear. Nothing here changes what you hear.'
            : 'Windows only offers this build the whole output, and the call is playing into it — so sending it means everyone hears themselves a moment late. Turn it on for a moment if a game matters more than that; the mixer is where it lives while a share is running.'}
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

      <section className="field">
        <p className="field__label">Connection</p>
        <Diagnostics />
        <button
          className="btn btn--ghost btn--block"
          onClick={async () => setCopied(await copyReport())}
        >
          {copied ? 'Copied — paste it into the report' : 'Copy a report'}
        </button>
        <div className="field__row">
          <button className="btn btn--ghost btn--tiny" onClick={() => void openLog()}>
            Open log file
          </button>
          <button className="btn btn--ghost btn--tiny" onClick={() => void revealLog()}>
            Show in folder
          </button>
        </div>
        <p className="field__hint">
          The report is everything above plus the tail of the log, which covers all three parts of
          Hollow: Steam, the background service and this window. The log holds this run only, and
          is the fastest way to see where a call that never connected actually stopped.
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

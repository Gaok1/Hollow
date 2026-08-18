import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@app/App'
import '@app/styles.css'

/**
 * A stubbed daemon, so the README can show the real interface.
 *
 * Everything below the UI needs Steam and a running `hollow-core`; neither is
 * available where the screenshots are taken. So `window.hollow` is answered
 * here with invented people and invented conversations, and the components,
 * layout and stylesheet are the ones that ship.
 */

const scene = new URLSearchParams(location.search).get('scene') ?? 'server'

/** A flat avatar, so the tiles and rows are not all fallback initials. */
const avatar = (letter: string, hue: number) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
      `<rect width="64" height="64" fill="hsl(${hue} 42% 32%)"/>` +
      `<text x="32" y="43" font-family="Segoe UI, sans-serif" font-size="30" font-weight="600" ` +
      `fill="hsl(${hue} 60% 86%)" text-anchor="middle">${letter}</text></svg>`,
  )

const me = {
  id: '76561198000000001',
  persona: 'nadia',
  state: 'online',
  avatar: avatar('N', 168),
  inHollow: true,
}

// Alice and Bob get to be here, because the whole sync scheme is their problem:
// two people who are never online at the same time never hear each other.
const friends = [
  { id: '76561198000000002', persona: 'alice', state: 'online', avatar: avatar('A', 292), inHollow: true },
  { id: '76561198000000003', persona: 'bob', state: 'online', avatar: avatar('B', 24), inHollow: true },
  { id: '76561198000000004', persona: 'oskar', state: 'away', avatar: avatar('O', 210), inHollow: false },
  { id: '76561198000000005', persona: 'juno', state: 'online', avatar: avatar('J', 340), inHollow: false },
  { id: '76561198000000006', persona: 'wren', state: 'offline', avatar: avatar('W', 100), inHollow: false },
  { id: '76561198000000007', persona: 'signe', state: 'offline', avatar: avatar('S', 260), inHollow: false },
]

const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000

const SERVER = 'server:76561198000000001-1723900000000'
const DM = 'dm:76561198000000001:76561198000000002'

const transcript = [
  { author: friends[1].id, seq: 4, at: at(212), text: 'anyone else getting packet loss on the eu route or is it just me' },
  { author: me.id, seq: 7, at: at(210), text: 'not here. what does the report say' },
  { author: friends[1].id, seq: 5, at: at(208), text: '11% loss, rtt 180ms, relayed. so: not just you' },
  { author: friends[0].id, seq: 12, at: at(96), text: 'ok i pushed the fix for the mixer thing, it was the master gain being applied twice' },
  { author: friends[0].id, seq: 13, at: at(95), text: 'that is why everything sounded like it was recorded in a bucket' },
  { author: me.id, seq: 8, at: at(94), text: 'ha. i thought that was just oskar’s microphone' },
  { author: friends[2].id, seq: 2, at: at(41), text: 'i was offline all weekend and this whole thread was just sitting here waiting for me' },
  { author: friends[0].id, seq: 14, at: at(38), text: 'that is the entire point of it, yes' },
  { author: friends[1].id, seq: 6, at: at(6), text: 'starting a call in a minute if anyone wants to look at the audio graph together' },
]

const dmTranscript = [
  { author: friends[0].id, seq: 21, at: at(180), text: 'sending you the capture from yesterday, it is about 400mb' },
  { author: me.id, seq: 15, at: at(178), text: 'go ahead' },
  { author: friends[0].id, seq: 22, at: at(176), text: 'done. no call needed, which is the nice part' },
]

const conversations = [
  {
    id: SERVER,
    kind: 'server',
    name: 'Hollow dev',
    owner: me.id,
    createdAt: at(60 * 24 * 40),
    members: [me, friends[0], friends[1], friends[2]],
    unread: 0,
    call: scene === 'call' ? '109775241000000001' : null,
  },
  {
    id: 'server:76561198000000003-1723100000000',
    kind: 'server',
    name: 'saturday games',
    owner: friends[1].id,
    createdAt: at(60 * 24 * 90),
    members: [me, friends[1], friends[3], friends[4]],
    unread: 3,
    call: null,
  },
  {
    id: DM,
    kind: 'dm',
    name: friends[0].persona,
    createdAt: at(60 * 24 * 5),
    members: [me, friends[0]],
    unread: scene === 'home' ? 2 : 0,
    call: null,
  },
]

const room = {
  id: '109775241000000001',
  owner: friends[0].id,
  name: 'Hollow dev',
  members: [me, friends[0], friends[1]],
  maxMembers: 6,
}

let emit: (event: string, data: unknown) => void = () => {}

const info = {
  me,
  backend: 'steam',
  backendNote: '',
  appId: 480,
  capabilities: { windowsBuild: 22631, perProcessCapture: true, note: '' },
  audioPipe: '\\\\.\\pipe\\hollow-audio-0',
  downloadDir: 'C:\\Users\\nadia\\Downloads\\Hollow',
  version: '0.4.0',
  room: scene === 'call' ? room : null,
  conversation: scene === 'call' ? SERVER : null,
}

const request = async (method: string, params: Record<string, unknown> = {}) => {
  switch (method) {
    case 'app.info':
      return info
    case 'conv.list':
      return conversations
    case 'conv.history':
      return {
        conversation: params.id,
        messages: params.id === DM ? dmTranscript : transcript,
        exhausted: true,
      }
    case 'friends.refresh':
      setTimeout(() => emit('friends', friends), 0)
      return null
    default:
      return null
  }
}

;(window as unknown as { hollow: unknown }).hollow = {
  request,
  onEvent: (handler: (event: string, data: unknown) => void) => {
    emit = handler
    setTimeout(() => {
      handler('friends', friends)
      if (scene === 'call') handler('room', { room, conversation: SERVER })
    }, 0)
    return () => {}
  },
  getFilePath: () => '',
  pickFiles: async () => [],
  screen: { sources: async () => [], choose: async () => {} },
  audio: { connect: async () => {}, disconnect: async () => {}, onPcm: () => () => {} },
  log: { write: () => {}, open: async () => {}, tail: async () => '', reveal: async () => {} },
  window: {
    minimize: async () => {},
    maximize: async () => {},
    close: async () => {},
    onStateChange: () => () => {},
  },
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Drive the app into the scene once it has mounted and finished its own init.
setTimeout(async () => {
  const { useStore } = await import('@app/store')
  if (scene === 'server') await useStore.getState().selectConversation(SERVER)
  if (scene === 'home') await useStore.getState().selectConversation(null)
  if (scene === 'call') {
    await useStore.getState().selectConversation(SERVER)
    // A call with no mesh behind it would sit on "Connecting…" forever. These
    // are the same link facts the real `Mesh` reports once a call is up.
    const link = {
      connection: 'connected',
      ice: 'connected',
      negotiated: true,
      receiving: ['mic'],
      unansweredOffers: 0,
      candidates: { host: 2, srflx: 1 },
      quality: { route: 'direct', rttMs: 24, loss: 0.002, inBps: 96_000, outBps: 96_000, availableBps: 3_400_000 },
    }
    useStore.setState({
      chatOpen: true,
      presence: {
        [friends[0].id]: { micMuted: false, deafened: false, cameraOn: false, sharingScreen: false, sharingAudio: false },
        [friends[1].id]: { micMuted: true, deafened: false, cameraOn: false, sharingScreen: false, sharingAudio: false },
      },
      localPresence: { micMuted: false, deafened: false, cameraOn: false, sharingScreen: false, sharingAudio: false },
    })
    // The real `Mesh` is running behind this and keeps reporting what it
    // actually sees — which is nothing, since there is no peer on the other
    // end. Reassert the connected state faster than it overwrites it.
    setInterval(() => {
      useStore.setState({ health: { [friends[0].id]: link, [friends[1].id]: link } })
    }, 120)
  }
  document.body.dataset.ready = 'yes'
}, 300)

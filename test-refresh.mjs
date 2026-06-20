// Simulate refreshes: write a real file (meta + blob chunks), then repeatedly
// tear down and reconnect with a fresh empty doc (= what a page refresh does).
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const WS = 'wss://ws.flow.dev.reearth.io'
const ROOM = 'netdisk-refresh-' + Math.random().toString(36).slice(2, 8)
const CHUNK = 64 * 1024
const log = (...a) => console.log(...a)

function client(disableBc) {
  const doc = new Y.Doc()
  const p = new WebsocketProvider(WS, ROOM, doc, { WebSocketPolyfill: WebSocket, params: { token: 'netdisk' }, disableBc })
  return { doc, p, files: doc.getMap('files'), blobs: doc.getMap('blobs'),
           synced: new Promise(r => p.once('sync', r)) }
}

log('room:', ROOM)
const A = client(true); await A.synced
const data = new Uint8Array(150 * 1024).map((_, i) => i & 0xff)
const n = Math.ceil(data.length / CHUNK)
A.doc.transact(() => {
  for (let i = 0; i < n; i++) A.blobs.set(`f1/${i}`, data.slice(i * CHUNK, (i + 1) * CHUNK))
  A.files.set('f1', { name: 'a.bin', size: data.length, type: '', time: Date.now(), chunks: n, dir: '' })
})
log('A uploaded. files =', A.files.size, 'blob keys =', A.blobs.size)
await new Promise(r => setTimeout(r, 1500))
A.p.disconnect(); A.p.destroy(); A.doc.destroy()

for (let r = 1; r <= 3; r++) {
  await new Promise(res => setTimeout(res, 1200))   // gap between "refreshes"
  const c = client(false)                           // disableBc:false, like the browser
  await c.synced
  await new Promise(res => setTimeout(res, 1000))
  log(`refresh #${r}: files =`, c.files.size, 'blobs =', c.blobs.size, [...c.files.keys()])
  c.p.disconnect(); c.p.destroy(); c.doc.destroy()
}
process.exit(0)

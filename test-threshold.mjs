// Find the size at which a freshly-reconnected client can no longer pull the doc.
// Upload via small 64KB chunks (upstream OK), disconnect, reconnect fresh, check.
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const WS = 'wss://ws.flow.dev.reearth.io'
const CHUNK = 64 * 1024
const log = (...a) => console.log(...a)

function client(room, disableBc = true) {
  const doc = new Y.Doc()
  const p = new WebsocketProvider(WS, room, doc, { WebSocketPolyfill: WebSocket, params: { token: 'netdisk' }, disableBc })
  return { doc, p, blobs: doc.getMap('blobs'), files: doc.getMap('files'),
           synced: new Promise(r => p.once('sync', r)) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (const mb of [1, 4, 8, 16]) {
  const room = `netdisk-th-${mb}-` + Math.random().toString(36).slice(2, 7)
  const size = mb * 1024 * 1024
  const n = Math.ceil(size / CHUNK)
  const A = client(room); await A.synced
  for (let i = 0; i < n; i++) A.blobs.set(`f/${i}`, new Uint8Array(CHUNK))
  A.files.set('f', { name: `${mb}mb.bin`, size, chunks: n })
  await sleep(2000)
  A.p.disconnect(); A.p.destroy(); A.doc.destroy()
  await sleep(1500)

  const B = client(room, false); await B.synced; await sleep(1500)
  const ok = B.files.size > 0 && B.blobs.size === n
  log(`${String(mb).padStart(2)}MB  →  fresh reconnect: files=${B.files.size} blobs=${B.blobs.size}/${n}  ${ok ? '✅ OK' : '❌ LOST'}`)
  B.p.disconnect(); B.p.destroy(); B.doc.destroy()
  await sleep(500)
}
process.exit(0)

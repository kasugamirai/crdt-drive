// Verify the netdisk scheme against the real CRDT server: upload from client A,
// read back identical bytes from a fresh client B.
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const WS = 'wss://ws.flow.dev.reearth.io'
const ROOM = 'netdisk-verify-' + Math.random().toString(36).slice(2, 8)
const CHUNK = 64 * 1024
const log = (...a) => console.log(...a)

function client() {
  const doc = new Y.Doc()
  const p = new WebsocketProvider(WS, ROOM, doc, { WebSocketPolyfill: WebSocket, params: { token: 'netdisk' }, disableBc: true })
  const meta = doc.getMap('files'), blobs = doc.getMap('blobs')
  const synced = new Promise(res => p.once('sync', res))
  return { doc, p, meta, blobs, synced }
}

// make a pseudo-file: 150KB => 3 chunks
const data = new Uint8Array(150 * 1024).map((_, i) => i & 0xff)
const id = 'file-1'

log('room:', ROOM)
const A = client()
await A.synced
log('A synced. uploading', data.length, 'bytes')
const n = Math.ceil(data.length / CHUNK)
for (let i = 0; i < n; i++) A.blobs.set(`${id}/${i}`, data.slice(i * CHUNK, (i + 1) * CHUNK))
A.meta.set(id, { name: 'test.bin', size: data.length, type: 'application/octet-stream', time: Date.now(), chunks: n })
await new Promise(r => setTimeout(r, 1500)) // let updates flush to server

// fresh client B, no shared memory with A
const B = client()
await B.synced
await new Promise(r => setTimeout(r, 800))
const f = B.meta.get(id)
log('B sees meta:', f && JSON.stringify({ name: f.name, size: f.size, chunks: f.chunks }))
let ok = !!f
const parts = []
if (f) for (let i = 0; i < f.chunks; i++) { const c = B.blobs.get(`${id}/${i}`); if (!c) { ok = false; break } parts.push(c) }
if (ok) {
  const got = new Uint8Array(parts.reduce((a, c) => a + c.length, 0))
  let o = 0; for (const c of parts) { got.set(c, o); o += c.length }
  ok = got.length === data.length && got.every((v, i) => v === data[i])
  log('reassembled', got.length, 'bytes, byte-identical:', ok)
}
log(ok ? '✅ PASS — netdisk round-trip works on the real server' : '❌ FAIL')
A.p.destroy(); B.p.destroy()
process.exit(ok ? 0 : 1)

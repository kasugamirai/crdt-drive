// Test the reearth-flow CRDT (Y-WebSocket) endpoint.
// Source: server/websocket — route is `/{doc_id}`, auth via `?token=` query param,
// protocol is the standard Yjs sync protocol (yrs on the server).
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const BASE = process.argv[2] || 'wss://flow.dev.reearth.io'
const DOC = process.argv[3] || 'test-doc'
const TOKEN = process.argv[4] || process.env.TOKEN || ''

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

// ---- Phase 1: raw handshake, observe HTTP upgrade / close code ----
function rawProbe() {
  return new Promise((resolve) => {
    const url = `${BASE}/${DOC}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`
    log('RAW  connecting:', url)
    const ws = new WebSocket(url)
    const t = setTimeout(() => { log('RAW  timeout (no open/close in 8s)'); ws.terminate(); resolve() }, 8000)
    ws.on('upgrade', (res) => log('RAW  HTTP upgrade status:', res.statusCode, JSON.stringify(res.headers.server || '')))
    ws.on('open', () => { log('RAW  OPEN — handshake accepted'); })
    ws.on('message', (d) => log('RAW  message:', d.length, 'bytes', [...d.slice(0, 8)]))
    ws.on('close', (code, reason) => { clearTimeout(t); log('RAW  CLOSE code=', code, 'reason=', reason.toString()); resolve() })
    ws.on('error', (e) => { log('RAW  ERROR:', e.message) })
    ws.on('unexpected-response', (_req, res) => {
      log('RAW  unexpected-response:', res.statusCode, res.statusMessage)
      let body = ''
      res.on('data', (c) => body += c)
      res.on('end', () => { log('RAW  body:', body.slice(0, 300)); clearTimeout(t); resolve() })
    })
  })
}

// ---- Phase 2: full Yjs sync via y-websocket ----
function yjsProbe() {
  return new Promise((resolve) => {
    const doc = new Y.Doc()
    const params = TOKEN ? { token: TOKEN } : {}
    log('YJS  connecting:', `${BASE}/${DOC}`, 'params=', JSON.stringify(params))
    const provider = new WebsocketProvider(BASE, DOC, doc, { WebSocketPolyfill: WebSocket, params, connect: true })
    const t = setTimeout(() => { log('YJS  done (8s window). synced=', provider.synced); provider.destroy(); resolve() }, 8000)
    provider.on('status', (e) => log('YJS  status:', e.status))
    provider.on('sync', (s) => {
      log('YJS  sync event:', s)
      if (s) {
        const m = doc.getMap('root')
        log('YJS  doc top-level keys after sync:', [...m.keys()])
        log('YJS  doc share keys:', [...doc.share.keys()])
      }
    })
    provider.on('connection-close', (e) => log('YJS  connection-close code=', e?.code, 'reason=', e?.reason))
    provider.on('connection-error', (e) => log('YJS  connection-error:', e?.message || e))
  })
}

await rawProbe()
log('---')
await yjsProbe()
process.exit(0)

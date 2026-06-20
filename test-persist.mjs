// Does the server persist a room after the LAST client disconnects?
// A connects + writes, A fully disconnects, wait, fresh B connects and checks.
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const WS = 'wss://ws.flow.dev.reearth.io'
const ROOM = 'netdisk-persist-' + Math.random().toString(36).slice(2, 8)
const log = (...a) => console.log(...a)

function client() {
  const doc = new Y.Doc()
  const p = new WebsocketProvider(WS, ROOM, doc, { WebSocketPolyfill: WebSocket, params: { token: 'netdisk' }, disableBc: true })
  return { doc, p, files: doc.getMap('files'), synced: new Promise(r => p.once('sync', r)) }
}

log('room:', ROOM)
const A = client(); await A.synced
A.files.set('id1', { name: 'hello.txt', size: 5, chunks: 0 })
log('A wrote 1 file; files size =', A.files.size)
await new Promise(r => setTimeout(r, 1500))   // let it flush to server

A.p.disconnect(); A.p.destroy(); A.doc.destroy()
log('A disconnected. waiting 6s with NOBODY connected…')
await new Promise(r => setTimeout(r, 6000))

const B = client(); await B.synced
await new Promise(r => setTimeout(r, 1000))
log('B connected. files size =', B.files.size, '→', [...B.files.keys()])
log(B.files.size > 0
  ? '✅ 服务端持久化了房间(刷新不该清空,另有原因)'
  : '❌ 服务端未持久化:最后一个客户端断开后房间被清空(这就是刷新丢数据的原因)')
B.p.destroy(); process.exit(0)

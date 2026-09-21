// One-shot: download a dmhy .torrent (bytes) and upload via Store to plateau Flow.
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { parseDmhyRss, parseTopicTorrentUrl, safeFileBase } from './src/dmhy-parse.js'

// Polyfill browser APIs used by crypto.js / store.js under Node
if (!globalThis.crypto?.subtle) {
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto = webcrypto
}
globalThis.WebSocket = WebSocket
// y-websocket in browser path; force polyfill via provider opts below
const { Store } = await import('./src/store.js')

const WS = process.env.VITE_FLOW_WS || 'wss://ws.flow.plateau.reearth.io'
const TOKEN = process.env.VITE_FLOW_TOKEN || 'netdisk'
const ROOM = process.env.VITE_DMHY_ROOM || ('dmhy-verify-' + Math.random().toString(36).slice(2, 8))

const rss = await (await fetch('https://share.dmhy.org/topics/rss/rss.xml')).text()
const items = parseDmhyRss(rss)
if (!items.length) throw new Error('no rss items')
const it = items.find(x => x.link) || items[0]
console.log('item:', it.title?.slice(0, 80))
console.log('hash:', it.infoHash)

const page = await (await fetch(it.link.replace(/^http:/, 'https:'))).text()
const tUrl = parseTopicTorrentUrl(page)
if (!tUrl) throw new Error('no torrent url on topic page')
const tRes = await fetch(tUrl)
const bytes = new Uint8Array(await tRes.arrayBuffer())
if (bytes[0] !== 0x64) throw new Error('not a bencode torrent')
console.log('downloaded torrent bytes:', bytes.byteLength, 'from', tUrl)

const store = new Store(WS, TOKEN)
// Patch _openRoom / connect to use ws polyfill
const _open = store._openRoom.bind(store)
store._openRoom = function (name) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(this.wsUrl, name, doc, {
    WebSocketPolyfill: WebSocket, params: { token: this.token }, disableBc: true,
  })
  const ready = new Promise(res => provider.once('sync', res))
  return { doc, provider, ready, blobs: doc.getMap('blobs') }
}
store.connect = function (room) {
  if (this.provider) { this.provider.destroy(); this.doc.destroy() }
  this.room = room
  this.doc = new Y.Doc()
  this.meta = this.doc.getMap('files')
  this.dirs = this.doc.getMap('dirs')
  this.namePlain = new Map()
  this.shardCache = new Map()
  this.shardInflight = new Map()
  this.keyReady = import('./src/crypto.js').then(c => c.deriveKey(room).then(k => (this.key = k)))
  this.provider = new WebsocketProvider(this.wsUrl, room, this.doc, {
    WebSocketPolyfill: WebSocket, params: { token: this.token }, disableBc: true,
  })
  this.provider.on('status', e => this.emit('status', e.status))
}

store.connect(ROOM)
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('sync timeout')), 20000)
  store.provider.once('sync', () => { clearTimeout(t); res() })
})
console.log('synced to', WS, ROOM)

const name = safeFileBase(it.title, it.infoHash) + '.torrent'
const file = new File([bytes], name, { type: 'application/x-bittorrent' })
const id = await store.upload(file, 'dmhy')
console.log('uploaded id=', id, 'name=', name)

// re-read metadata from a fresh provider
const doc2 = new Y.Doc()
const p2 = new WebsocketProvider(WS, ROOM, doc2, {
  WebSocketPolyfill: WebSocket, params: { token: TOKEN }, disableBc: true,
})
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('B sync timeout')), 20000)
  p2.once('sync', () => { clearTimeout(t); res() })
})
await new Promise(r => setTimeout(r, 800))
const meta = doc2.getMap('files')
const entry = meta.get(id)
console.log('remote meta size=', entry?.size, 'shards=', entry?.shards)
const ok = entry && entry.size === bytes.byteLength
console.log(ok ? '✅ PASS — torrent bytes uploaded to plateau Flow' : '❌ FAIL')
store.provider.destroy(); p2.destroy()
process.exit(ok ? 0 : 1)

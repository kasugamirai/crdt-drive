// CRDT data layer (multi-room sharding).
//
// The sync service's persistence has two hard limits we design around:
//   1. It cannot store binary (Uint8Array) — a doc containing any comes back EMPTY
//      after reload. So file bytes are stored as base64 STRINGS.
//   2. A persisted doc has a total-size ceiling (~12MB of base64).
//
// So a file's bytes are split into SHARDS, each kept in its OWN room (doc), sized
// under the ceiling. The main "drive" room holds only small metadata, so the file
// LIST always reloads (refresh never clears it). Large files are uploaded /
// downloaded shard-by-shard: connect a shard room → transfer → disconnect → next.
//
// Drive room:  files: Y.Map  id -> { name, size, type, time, dir, shards }
//              dirs:  Y.Map  dirPath -> { time }
// Shard room `${drive}::${id}::${k}`:  blobs: Y.Map  "i" -> base64(64KB chunk)
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { parentPath, pathJoin, bytesToB64, b64ToBytes } from './util.js'
import { deriveKey, encryptBytes, decryptBytes, encryptToB64, decryptFromB64 } from './crypto.js'

const CHUNK = 64 * 1024          // 64KB raw per chunk
const SHARD_RAW = 6 * 1024 * 1024 // ≤6MB raw per shard room (≈8MB base64, safely under the ~12MB ceiling)
const CONCURRENCY = 20           // how many shard rooms to transfer in parallel (up & down)
const sleep = ms => new Promise(r => setTimeout(r, ms))

export class Store {
  constructor(wsUrl, token) {
    this.wsUrl = wsUrl
    this.token = token
    this.handlers = {}
    this.room = null
  }

  on(ev, cb) { (this.handlers[ev] ||= []).push(cb); return this }
  emit(ev, d) { (this.handlers[ev] || []).forEach(cb => cb(d)) }

  connect(room) {
    if (this.provider) { this.provider.destroy(); this.doc.destroy() }
    this.room = room
    this.doc = new Y.Doc()
    this.meta = this.doc.getMap('files')
    this.dirs = this.doc.getMap('dirs')
    this.namePlain = new Map()              // id -> { name, type } (decrypted, cached)
    this.keyReady = deriveKey(room).then(k => (this.key = k))

    this.provider = new WebsocketProvider(this.wsUrl, room, this.doc, { params: { token: this.token } })
    this.provider.on('status', e => this.emit('status', e.status))
    this.provider.awareness.setLocalState({ t: Date.now() })
    this.provider.awareness.on('change', () => this.emit('online', this.provider.awareness.getStates().size))

    this.meta.observe(() => this._decryptNames())
    this.dirs.observe(() => this.emit('change'))
    this._decryptNames()
  }

  // Decrypt file names/types for any new metadata entries into namePlain, then
  // trigger a re-render. Keeps the query/render path synchronous.
  async _decryptNames() {
    await this.keyReady
    let added = false
    for (const [id, m] of this.meta.entries()) {
      if (this.namePlain.has(id)) continue
      try {
        if (m.enc) this.namePlain.set(id, JSON.parse(await decryptFromB64(this.key, m.enc)))
        else this.namePlain.set(id, { name: m.name || '未命名', type: m.type || '' }) // legacy plaintext
      } catch { this.namePlain.set(id, { name: '🔒 无法解密', type: '' }) }
      added = true
    }
    for (const id of [...this.namePlain.keys()]) if (!this.meta.has(id)) this.namePlain.delete(id)
    this.emit('change')
    return added
  }

  // ---- shard-room helpers ----
  _shardName(id, k) { return `${this.room}::${id}::${k}` }

  _openRoom(name) {
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(this.wsUrl, name, doc, { params: { token: this.token }, disableBc: true })
    const ready = new Promise(res => provider.once('sync', res))
    return { doc, provider, ready, blobs: doc.getMap('blobs') }
  }

  // wait until the outgoing ws buffer drains, then give the server time to persist
  async _flush(provider) {
    for (let i = 0; i < 200; i++) {
      const ws = provider.ws
      if (ws && ws.bufferedAmount === 0 && provider.synced) break
      await sleep(50)
    }
    await sleep(1500)
  }
  _close(r) { r.provider.destroy(); r.doc.destroy() }

  // ---- queries ----
  allFolderPaths() {
    const set = new Set()
    const addAncestors = p => { let cur = p; while (cur) { set.add(cur); cur = parentPath(cur) } }
    for (const key of this.dirs.keys()) addAncestors(key)
    for (const [, f] of this.meta) if (f.dir) addAncestors(f.dir)
    return set
  }

  listDir(cwd) {
    const folders = [...this.allFolderPaths()]
      .filter(p => parentPath(p) === cwd)
      .map(p => ({ path: p, name: p.slice(cwd ? cwd.length + 1 : 0) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const files = [...this.meta.entries()]
      .filter(([, f]) => (f.dir || '') === cwd)
      .map(([id, f]) => this._withName(id, f))
      .sort((a, b) => b.time - a.time)
    return { folders, files }
  }

  // merge decrypted name/type onto a metadata entry
  _withName(id, f) {
    const p = this.namePlain.get(id) || { name: '🔒 解密中…', type: f.type || '' }
    return { id, ...f, name: p.name, type: p.type }
  }

  allFiles() {
    return [...this.meta.entries()].map(([id, f]) => this._withName(id, f)).sort((a, b) => b.time - a.time)
  }

  totalSize() { let t = 0; for (const [, f] of this.meta) t += f.size; return t }

  // ---- mutations ----
  createFolder(cwd, name) {
    const path = pathJoin(cwd, name.trim())
    if (path) this.dirs.set(path, { time: Date.now() })
  }

  // Upload one File into `dir`. Splits into shard rooms; metadata written last so
  // peers only see the file once every shard is persisted. onProgress(0..1).
  async upload(file, dir, onProgress) {
    await this.keyReady
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(performance.now())}`
    const buf = new Uint8Array(await file.arrayBuffer())
    const shards = Math.max(1, Math.ceil(buf.length / SHARD_RAW))
    const total = buf.length || 1
    const prog = new Array(shards).fill(0)
    const report = () => onProgress?.(prog.reduce((a, b) => a + b, 0) / total)
    let next = 0
    const worker = async () => {
      while (true) {
        const k = next++
        if (k >= shards) return
        const slice = buf.subarray(k * SHARD_RAW, (k + 1) * SHARD_RAW)
        await this._writeShard(this._shardName(id, k), slice, p => { prog[k] = p * slice.length; report() })
        prog[k] = slice.length; report()
      }
    }
    // a thrown shard rejects Promise.all → upload throws → metadata never written (no partial file)
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shards) }, worker))
    const type = file.type || 'application/octet-stream'
    const enc = await encryptToB64(this.key, JSON.stringify({ name: file.name, type }))
    this.namePlain.set(id, { name: file.name, type })
    this.meta.set(id, { enc, size: buf.length, time: Date.now(), dir: dir || '', shards })
    return id
  }

  // write one shard room; each 64KB chunk is AES-GCM encrypted before base64
  async _writeShard(name, bytes, onProgress) {
    const r = this._openRoom(name)
    await r.ready
    const n = Math.ceil(bytes.length / CHUNK)
    for (let i = 0; i < n; i++) {
      const ct = await encryptBytes(this.key, bytes.subarray(i * CHUNK, (i + 1) * CHUNK))
      r.blobs.set(String(i), bytesToB64(ct))
      if (i % 8 === 0) { onProgress?.(i / n); await sleep(0) }
    }
    onProgress?.(1)
    await this._flush(r.provider)
    this._close(r)
  }

  // Read a whole file by downloading its shard rooms in parallel (up to
  // DL_CONCURRENCY at once), reassembling them in order. onProgress(0..1).
  // Returns Uint8Array, or null if a shard is missing / still syncing.
  async readFile(id, onProgress) {
    const f = this.meta.get(id); if (!f) return null
    if (!f.size) return new Uint8Array(0)
    await this.keyReady
    const shards = f.shards ?? 1
    const results = new Array(shards)
    let next = 0, done = 0, failed = false
    const worker = async () => {
      while (!failed) {
        const k = next++            // synchronous claim, no race between awaits
        if (k >= shards) return
        const bytes = await this._readShard(id, k)
        if (bytes == null) { failed = true; return }
        results[k] = bytes
        onProgress?.(++done / shards)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, shards) }, worker))
    if (failed) return null
    const out = new Uint8Array(results.reduce((a, c) => a + c.length, 0))
    let o = 0; for (const c of results) { out.set(c, o); o += c.length }
    return out
  }

  // download a single shard room → Uint8Array (null if empty / not synced)
  async _readShard(id, k) {
    const r = this._openRoom(this._shardName(id, k))
    try {
      await r.ready
      await sleep(300)
      const keys = [...r.blobs.keys()].map(Number).sort((a, b) => a - b)
      if (keys.length === 0) return null
      const parts = []
      for (const i of keys) parts.push(await decryptBytes(this.key, b64ToBytes(r.blobs.get(String(i)))))
      const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0))
      let o = 0; for (const c of parts) { out.set(c, o); o += c.length }
      return out
    } finally {
      this._close(r)
    }
  }

  async readBlob(id, onProgress) {
    const f = this.meta.get(id)
    const bytes = await this.readFile(id, onProgress)
    return bytes ? new Blob([bytes], { type: f.type }) : null
  }

  deleteFile(id) {
    const f = this.meta.get(id); if (!f) return
    this.meta.delete(id)                       // instant UI removal for everyone
    this._wipeShards(id, f.shards ?? 1)        // best-effort cleanup of shard rooms
  }

  async _wipeShards(id, shards) {
    for (let k = 0; k < shards; k++) {
      try {
        const r = this._openRoom(this._shardName(id, k)); await r.ready
        r.doc.transact(() => { for (const key of [...r.blobs.keys()]) r.blobs.delete(key) })
        await this._flush(r.provider); this._close(r)
      } catch { /* best effort */ }
    }
  }

  deleteFolder(path) {
    const under = p => p === path || p.startsWith(path + '/')
    const victims = [...this.meta.entries()].filter(([, f]) => under(f.dir || ''))
    this.doc.transact(() => {
      for (const [id] of victims) this.meta.delete(id)
      for (const key of [...this.dirs.keys()]) if (under(key)) this.dirs.delete(key)
    })
    for (const [id, f] of victims) this._wipeShards(id, f.shards ?? 1)
  }
}

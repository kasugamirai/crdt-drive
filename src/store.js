// CRDT data layer: wraps the Yjs doc + y-websocket provider and exposes
// file/folder operations. Storage schema in the shared doc:
//   files: Y.Map  id -> { name, size, type, time, chunks, dir }
//   dirs:  Y.Map  dirPath -> { time }            (explicit folders, incl. empty)
//   blobs: Y.Map  `${id}/${i}` -> Uint8Array     (64KB chunks)
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { parentPath, pathJoin } from './util.js'

const CHUNK = 64 * 1024
// The sync service's persistence cannot store binary (Uint8Array) values — a doc
// containing any breaks reload and the whole room comes back empty after everyone
// disconnects. So file bytes are stored as base64 STRINGS, which persist correctly.
// Persisted docs also have a total-size ceiling (~12MB of base64); keep a margin.
const DURABLE_BUDGET = 9 * 1024 * 1024 // max raw bytes per room (≈12MB base64)

function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

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
    this.meta  = this.doc.getMap('files')
    this.dirs  = this.doc.getMap('dirs')
    this.blobs = this.doc.getMap('blobs')

    this.provider = new WebsocketProvider(this.wsUrl, room, this.doc, { params: { token: this.token } })
    this.provider.on('status', e => this.emit('status', e.status))
    this.provider.awareness.setLocalState({ t: Date.now() })
    this.provider.awareness.on('change', () => this.emit('online', this.provider.awareness.getStates().size))

    this.meta.observe(() => this.emit('change'))
    this.dirs.observe(() => this.emit('change'))
    this.emit('change')
  }

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
      .map(([id, f]) => ({ id, ...f }))
      .sort((a, b) => b.time - a.time)
    return { folders, files }
  }

  allFiles() {
    return [...this.meta.entries()].map(([id, f]) => ({ id, ...f })).sort((a, b) => b.time - a.time)
  }

  totalSize() {
    let t = 0; for (const [, f] of this.meta) t += f.size; return t
  }

  // ---- mutations ----
  createFolder(cwd, name) {
    const path = pathJoin(cwd, name.trim())
    if (path) this.dirs.set(path, { time: Date.now() })
  }

  // remaining durable budget (raw bytes) before the room hits the persistence ceiling
  remainingBudget() { return DURABLE_BUDGET - this.totalSize() }

  // upload one File into `dir`. onProgress(0..1). Chunks stored as base64 strings
  // (binary doesn't survive server persistence); meta written last so peers see
  // complete data first. Throws if it would exceed the durable budget.
  async upload(file, dir, onProgress) {
    if (file.size > this.remainingBudget()) {
      const e = new Error(`容量不足:本网盘可持久化总量约 ${Math.round(DURABLE_BUDGET / 1024 / 1024)}MB,「${file.name}」放不下`)
      e.code = 'BUDGET'; throw e
    }
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(performance.now())}`
    const buf = new Uint8Array(await file.arrayBuffer())
    const n = Math.ceil(buf.length / CHUNK)
    for (let i = 0; i < n; i++) {
      this.blobs.set(`${id}/${i}`, bytesToB64(buf.subarray(i * CHUNK, (i + 1) * CHUNK)))
      onProgress?.((i + 1) / n)
      if (i % 16 === 0) await new Promise(r => setTimeout(r))
    }
    this.meta.set(id, {
      name: file.name, size: buf.length,
      type: file.type || 'application/octet-stream',
      time: Date.now(), chunks: n, dir: dir || ''
    })
    return id
  }

  deleteFile(id) {
    const f = this.meta.get(id); if (!f) return
    this.doc.transact(() => {
      for (let i = 0; i < f.chunks; i++) this.blobs.delete(`${id}/${i}`)
      this.meta.delete(id)
    })
  }

  deleteFolder(path) {
    const under = p => p === path || p.startsWith(path + '/')
    this.doc.transact(() => {
      for (const [id, f] of [...this.meta.entries()]) {
        if (under(f.dir || '')) {
          for (let i = 0; i < f.chunks; i++) this.blobs.delete(`${id}/${i}`)
          this.meta.delete(id)
        }
      }
      for (const key of [...this.dirs.keys()]) if (under(key)) this.dirs.delete(key)
    })
  }

  // reassemble bytes from base64 chunks; null if any chunk hasn't synced yet
  getBytes(id) {
    const f = this.meta.get(id); if (!f) return null
    const parts = []
    for (let i = 0; i < f.chunks; i++) {
      const c = this.blobs.get(`${id}/${i}`); if (c == null) return null
      parts.push(b64ToBytes(c))
    }
    const out = new Uint8Array(parts.reduce((a, c) => a + c.length, 0))
    let o = 0; for (const c of parts) { out.set(c, o); o += c.length }
    return out
  }

  getBlob(id) {
    const f = this.meta.get(id); const bytes = this.getBytes(id)
    return bytes ? new Blob([bytes], { type: f.type }) : null
  }
}

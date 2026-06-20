// CRDT data layer: wraps the Yjs doc + y-websocket provider and exposes
// file/folder operations. Storage schema in the shared doc:
//   files: Y.Map  id -> { name, size, type, time, chunks, dir }
//   dirs:  Y.Map  dirPath -> { time }            (explicit folders, incl. empty)
//   blobs: Y.Map  `${id}/${i}` -> Uint8Array     (64KB chunks)
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { parentPath, pathJoin } from './util.js'

const CHUNK = 64 * 1024

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

  // upload one File into `dir`. onProgress(0..1). Chunks sent individually
  // (small ws frames); meta written last so peers see complete data first.
  async upload(file, dir, onProgress) {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.round(performance.now())}`
    const buf = new Uint8Array(await file.arrayBuffer())
    const n = Math.ceil(buf.length / CHUNK)
    for (let i = 0; i < n; i++) {
      this.blobs.set(`${id}/${i}`, buf.slice(i * CHUNK, (i + 1) * CHUNK))
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

  // reassemble bytes; null if any chunk hasn't synced yet
  getBytes(id) {
    const f = this.meta.get(id); if (!f) return null
    const parts = []
    for (let i = 0; i < f.chunks; i++) {
      const c = this.blobs.get(`${id}/${i}`); if (!c) return null
      parts.push(c)
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

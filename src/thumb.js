// Lazy thumbnail generation for the grid view.
//
// There's no server to make thumbnails, so we build small JPEG data-URLs on the
// client and cache them by file id (re-renders are frequent under CRDT sync, so
// caching is essential). Images are read + downscaled; videos grab a poster
// frame through the streaming bridge (range-fetches just enough to decode it).
import { categoryOf } from './util.js'
import { mediaUrl, streamingAvailable } from './media.js'

const MAX = 480                       // longest thumbnail edge, px
const IMG_LIMIT = 25 * 1024 * 1024    // don't full-download huge images just for a thumb
const cache = new Map()               // id -> dataURL | '' (failed/unsupported)
const inflight = new Map()            // id -> Promise

// Synchronous peek: dataURL, '' (no thumb), or undefined (not built yet).
export function getThumb(id) { return cache.get(id) }

export async function ensureThumb(store, file) {
  const hit = cache.get(file.id)
  if (hit !== undefined) return hit
  if (inflight.has(file.id)) return inflight.get(file.id)
  const p = (async () => {
    try {
      const url = await build(store, file)
      if (url) cache.set(file.id, url)        // cache successes
      return url || ''                        // null = skip for now, don't cache (allow retry)
    } catch { cache.set(file.id, ''); return '' } // cache hard failures to avoid retry storms
    finally { inflight.delete(file.id) }
  })()
  inflight.set(file.id, p)
  return p
}

function build(store, file) {
  const cat = categoryOf(file.type, file.name)
  if (cat === 'image') return file.size <= IMG_LIMIT ? imageThumb(store, file) : Promise.resolve(null)
  if (cat === 'video') return streamingAvailable() ? videoThumb(store, file) : Promise.resolve(null)
  return Promise.resolve(null)
}

async function imageThumb(store, file) {
  const bytes = await store.readFile(file.id)
  if (!bytes) return null
  const url = URL.createObjectURL(new Blob([bytes], { type: file.type }))
  try { const img = await loadImg(url); return draw(img, img.naturalWidth, img.naturalHeight) }
  finally { URL.revokeObjectURL(url) }
}

async function videoThumb(store, file) {
  let blobUrl = null, src
  if (streamingAvailable()) src = mediaUrl(file.id)
  else {
    const bytes = await store.readFile(file.id); if (!bytes) return null
    src = blobUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }))
  }
  const v = document.createElement('video')
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = src
  try {
    await once(v, 'loadeddata', 20000)
    const t = (isFinite(v.duration) && v.duration > 0) ? Math.min(1, v.duration / 2) : 0
    if (t > 0) { v.currentTime = t; await once(v, 'seeked', 20000) }
    return draw(v, v.videoWidth, v.videoHeight)
  } finally {
    v.removeAttribute('src'); try { v.load() } catch {}
    if (blobUrl) URL.revokeObjectURL(blobUrl)
  }
}

function draw(src, w, h) {
  if (!w || !h) return null
  const scale = Math.min(1, MAX / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale))
  const c = document.createElement('canvas'); c.width = cw; c.height = ch
  c.getContext('2d').drawImage(src, 0, 0, cw, ch)
  return c.toDataURL('image/jpeg', 0.72)
}

function loadImg(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('img error')); i.src = url })
}

function once(el, ev, ms) {
  return new Promise((res, rej) => {
    const done = ok => { clearTimeout(t); el.removeEventListener(ev, onOk); el.removeEventListener('error', onErr); ok ? res() : rej(new Error('media error')) }
    const onOk = () => done(true), onErr = () => done(false)
    const t = setTimeout(onErr, ms)
    el.addEventListener(ev, onOk); el.addEventListener('error', onErr)
  })
}

// Page side of the media-streaming bridge (see public/sw.js).
//
// Registers the service worker and answers its byte-range requests by reading
// the requested range out of the CRDT store. Exposes mediaUrl(id) — a same-origin
// URL a <video>/<audio> element can stream from, playing while it loads + seeking.
const MAX_WINDOW = 4 * 1024 * 1024     // cap each response so an open-ended request streams in chunks
let store = null
let ready = false

export async function initMedia(s) {
  store = s
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return
  try {
    await navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js')
    await navigator.serviceWorker.ready
    navigator.serviceWorker.addEventListener('message', onMessage)
    if (!navigator.serviceWorker.controller) {
      await new Promise(res => {
        const t = setTimeout(res, 1500)
        navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(t); res() }, { once: true })
      })
    }
    ready = true
  } catch (e) { console.warn('media streaming unavailable:', e); ready = false }
}

export function streamingAvailable() { return ready && !!navigator.serviceWorker.controller }

export function mediaUrl(id) { return import.meta.env.BASE_URL + '__media/' + encodeURIComponent(id) }

async function onMessage(event) {
  const d = event.data
  if (!d || d.type !== 'media-read') return
  const port = event.ports[0]
  try {
    const payload = await serveRange(d.id, d.range)
    port.postMessage({ ok: true, payload }, [payload.buf])   // transfer the ArrayBuffer, no copy
  } catch (e) {
    port?.postMessage({ ok: false, error: e.message || String(e) })
  }
}

async function serveRange(id, rangeHeader) {
  const info = store?.fileInfo(id)
  if (!info) throw new Error('file not found')
  const size = info.size
  let start = 0, end = size - 1, status = 200
  const m = rangeHeader && /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (m) {
    if (m[1]) start = parseInt(m[1], 10)
    end = m[2] ? parseInt(m[2], 10) : size - 1
    status = 206
  }
  if (end - start + 1 > MAX_WINDOW) end = start + MAX_WINDOW - 1
  if (end > size - 1) end = size - 1
  if (start > end) start = end
  const bytes = await store.readRange(id, start, end + 1)
  return { status, size, start, end, mime: info.type, buf: bytes.buffer }
}

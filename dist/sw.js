// Media-streaming service worker.
//
// It owns no data. For each request to /__media/<id> it asks the controlling
// page (which holds the decryption key + CRDT store) for the requested byte
// range over a MessageChannel, then returns a proper 200 / 206 response. That
// lets a native <video>/<audio> element play while loading and seek freely —
// the browser's own media pipeline handles every codec, including MP4 files
// whose `moov` atom sits at the end (it just range-fetches the tail first).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const at = url.pathname.indexOf('/__media/')
  if (at === -1) return
  const id = decodeURIComponent(url.pathname.slice(at + '/__media/'.length))
  event.respondWith(serve(event, id))
})

async function serve(event, id) {
  const client = await pickClient(event)
  if (!client) return new Response('media bridge offline', { status: 503 })
  let r
  try {
    r = await ask(client, { type: 'media-read', id, range: event.request.headers.get('range') })
  } catch (e) {
    return new Response(String((e && e.message) || e), { status: 502 })
  }
  const headers = {
    'Content-Type': r.mime,
    'Content-Length': String(r.end - r.start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (r.status === 206) headers['Content-Range'] = `bytes ${r.start}-${r.end}/${r.size}`
  return new Response(r.buf, { status: r.status, headers })
}

async function pickClient(event) {
  const id = event.clientId || event.resultingClientId
  if (id) { const c = await self.clients.get(id); if (c) return c }
  const all = await self.clients.matchAll({ type: 'window' })
  return all[0] || null
}

function ask(client, msg) {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = e => {
      const d = e.data || {}
      if (d.ok) resolve(d.payload); else reject(new Error(d.error || 'media read failed'))
    }
    client.postMessage(msg, [ch.port2])
  })
}

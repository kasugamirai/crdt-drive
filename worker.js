// Cloudflare Worker: static assets + CORS-safe dmhy.org proxy.
// Browser cannot fetch share.dmhy.org / dl.dmhy.org directly; this Worker
// exposes same-origin `/api/dmhy/*` that the uploader page uses.

const DMHY_RSS = 'https://share.dmhy.org/topics/rss/rss.xml'
const ALLOWED_HOSTS = new Set(['share.dmhy.org', 'www.dmhy.org', 'dmhy.org', 'dl.dmhy.org'])

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/dmhy/rss' || url.pathname === '/api/dmhy/rss.xml') {
      return proxyGet(DMHY_RSS, { accept: 'application/rss+xml, application/xml, text/xml, */*' })
    }

    if (url.pathname === '/api/dmhy/fetch') {
      const target = url.searchParams.get('url')
      if (!target) return json({ error: 'missing url' }, 400)
      let parsed
      try { parsed = new URL(target) } catch { return json({ error: 'invalid url' }, 400) }
      if (!ALLOWED_HOSTS.has(parsed.hostname)) return json({ error: 'host not allowed' }, 403)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return json({ error: 'bad protocol' }, 400)
      // normalize //host → https
      if (parsed.protocol === 'http:') parsed.protocol = 'https:'
      return proxyGet(parsed.toString())
    }

    // Static SPA (Vite dist/) for everything else
    if (env.ASSETS) return env.ASSETS.fetch(request)
    return new Response('Not found', { status: 404 })
  },
}

async function proxyGet(target, headers = {}) {
  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'crdt-drive-dmhy-proxy/1.0',
        ...headers,
      },
      redirect: 'follow',
    })
    const out = new Headers(res.headers)
    out.set('Access-Control-Allow-Origin', '*')
    out.set('Cache-Control', 'public, max-age=60')
    // Drop hop-by-hop / encoding issues for browsers
    out.delete('content-encoding')
    out.delete('content-length')
    out.delete('transfer-encoding')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  } catch (e) {
    return json({ error: 'upstream fetch failed', detail: String(e?.message || e) }, 502)
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

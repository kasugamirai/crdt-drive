import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

const DMHY_RSS = 'https://share.dmhy.org/topics/rss/rss.xml'
const ALLOWED = new Set(['share.dmhy.org', 'www.dmhy.org', 'dmhy.org', 'dl.dmhy.org'])

function dmhyProxyPlugin() {
  return {
    name: 'dmhy-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = new URL(req.url || '/', 'http://localhost')
          if (url.pathname === '/api/dmhy/rss' || url.pathname === '/api/dmhy/rss.xml') {
            const up = await fetch(DMHY_RSS, {
              headers: { 'User-Agent': 'crdt-drive-dmhy-proxy/1.0', Accept: 'application/rss+xml, text/xml, */*' },
            })
            const body = Buffer.from(await up.arrayBuffer())
            res.statusCode = up.status
            res.setHeader('Content-Type', up.headers.get('content-type') || 'application/xml')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(body)
            return
          }
          if (url.pathname === '/api/dmhy/fetch') {
            const target = url.searchParams.get('url')
            if (!target) { res.statusCode = 400; res.end('missing url'); return }
            let parsed
            try { parsed = new URL(target) } catch { res.statusCode = 400; res.end('invalid url'); return }
            if (!ALLOWED.has(parsed.hostname)) { res.statusCode = 403; res.end('host not allowed'); return }
            if (parsed.protocol === 'http:') parsed.protocol = 'https:'
            const up = await fetch(parsed.toString(), {
              headers: { 'User-Agent': 'crdt-drive-dmhy-proxy/1.0' },
              redirect: 'follow',
            })
            const body = Buffer.from(await up.arrayBuffer())
            res.statusCode = up.status
            res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(body)
            return
          }
        } catch (e) {
          res.statusCode = 502
          res.end(String(e?.message || e))
          return
        }
        next()
      })
    },
  }
}

// base './' so the built dist/ also works when opened from the filesystem
export default defineConfig({
  base: './',
  plugins: [tailwindcss(), dmhyProxyPlugin()],
  server: { open: true },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        dmhy: 'dmhy.html',
        nostr: 'nostr.html',
      },
    },
  },
})

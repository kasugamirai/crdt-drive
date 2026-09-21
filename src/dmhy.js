import './style.css'
import { Store } from './store.js'
import { WS_PRESETS } from './servers.js'
import { esc, fmt } from './util.js'
import {
  parseDmhyRss,
  parseTopicTorrentUrl,
  safeFileBase,
  magnetInfoHash,
} from './dmhy-parse.js'

// Config: Vite env overrides; defaults match existing app conventions.
const TOKEN = import.meta.env.VITE_FLOW_TOKEN || 'netdisk'
const DEFAULT_WS = import.meta.env.VITE_FLOW_WS || WS_PRESETS.find(p => p.key === 'plateau')?.url || WS_PRESETS[0].url
const DEFAULT_ROOM = import.meta.env.VITE_DMHY_ROOM || 'dmhy-bt'
const DEFAULT_LIMIT = Number(import.meta.env.VITE_DMHY_LIMIT || 10)
const RSS_PATH = import.meta.env.VITE_DMHY_RSS || '/api/dmhy/rss'
const AUTO_START = String(import.meta.env.VITE_DMHY_AUTO ?? '1') !== '0'
// Idle delay between passes when nothing new was uploaded (avoids tight-loop).
const IDLE_MS = Math.max(1000, Number(import.meta.env.VITE_DMHY_IDLE_MS || 5000))
const ERROR_BACKOFF_MS = Math.max(1000, Number(import.meta.env.VITE_DMHY_ERROR_MS || 8000))
// Max torrents downloading+uploading at once (no larger prefetch into memory).
const CONCURRENCY = Math.max(1, Math.min(3, Number(import.meta.env.VITE_DMHY_CONCURRENCY || 3) || 3))

const $ = id => document.getElementById(id)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const store = new Store(localStorage.getItem('crdt-ws') || DEFAULT_WS, TOKEN)
let running = false
let abort = false
let pass = 0
let statusHandlerBound = false

function log(msg, kind = 'info') {
  const el = $('log')
  const line = document.createElement('div')
  line.className = 'text-xs font-mono leading-relaxed ' + (
    kind === 'err' ? 'text-red-300' : kind === 'ok' ? 'text-emerald-300' : 'text-slate-400'
  )
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  el.prepend(line)
  while (el.children.length > 200) el.lastChild.remove()
}

function setStatus(text, on = null) {
  $('run-status').textContent = text
  if (on === true) { $('dot').className = 'dot dot-on' }
  else if (on === false) { $('dot').className = 'dot dot-off' }
}

function proxyFetchUrl(absoluteUrl) {
  return `/api/dmhy/fetch?url=${encodeURIComponent(absoluteUrl)}`
}

async function fetchRss() {
  const res = await fetch(RSS_PATH, { cache: 'no-store' })
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`)
  return parseDmhyRss(await res.text())
}

function looksLikeTorrent(bytes, contentType = '') {
  if (!bytes || bytes.byteLength < 16) return false
  // bencode torrents start with `d` (dict); reject HTML/error pages
  if (bytes[0] !== 0x64 /* 'd' */) return false
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('text/html') || ct.includes('application/json')) return false
  return true
}

/** Download actual .torrent file bytes only (never magnet/metadata stubs). */
async function fetchTorrentBytes(item) {
  const tried = []

  // 1) Topic page → authoritative //dl.dmhy.org/...torrent link
  if (item.link) {
    const topicUrl = item.link.replace(/^http:/, 'https:')
    tried.push(topicUrl)
    try {
      const pageRes = await fetch(proxyFetchUrl(topicUrl), { cache: 'no-store' })
      if (pageRes.ok) {
        const html = await pageRes.text()
        const tUrl = parseTopicTorrentUrl(html)
        if (tUrl) {
          tried.push(tUrl)
          const tRes = await fetch(proxyFetchUrl(tUrl), { cache: 'no-store' })
          if (tRes.ok) {
            const buf = new Uint8Array(await tRes.arrayBuffer())
            if (looksLikeTorrent(buf, tRes.headers.get('content-type'))) {
              return { bytes: buf, source: tUrl }
            }
          }
        }
      }
    } catch (e) {
      log(`topic scrape failed: ${e.message}`, 'err')
    }
  }

  // 2) Guessed dl.dmhy.org paths from RSS pubDate + hex infohash
  for (const url of item.torrentCandidates || []) {
    if (tried.includes(url)) continue
    tried.push(url)
    try {
      const tRes = await fetch(proxyFetchUrl(url), { cache: 'no-store' })
      if (!tRes.ok) continue
      const buf = new Uint8Array(await tRes.arrayBuffer())
      if (looksLikeTorrent(buf, tRes.headers.get('content-type'))) {
        return { bytes: buf, source: url }
      }
    } catch { /* try next */ }
  }

  throw new Error(`no .torrent bytes (tried ${tried.length} urls)`)
}

function existingNames() {
  return new Set(store.allFiles().map(f => f.name))
}

function waitSynced(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (store.provider?.synced) return resolve()
    const t = setTimeout(() => reject(new Error('sync timeout')), timeoutMs)
    const onSync = (s) => {
      if (s) { clearTimeout(t); store.provider.off('sync', onSync); resolve() }
    }
    store.provider?.on('sync', onSync)
  })
}

async function ensureConnected(room) {
  store.wsUrl = DEFAULT_WS
  localStorage.setItem('crdt-ws', DEFAULT_WS)
  if (store.room !== room || !store.provider) {
    store.connect(room)
    if (!statusHandlerBound) {
      statusHandlerBound = true
      store.on('status', s => {
        if (running) {
          if (s === 'connected') { /* keep pass status */ }
          else if (s === 'connecting') setStatus('连接中…', false)
          else setStatus('已断开', false)
        }
      })
    }
  }
  setStatus('连接 Flow…', false)
  await waitSynced()
  if (!store.dirs.has('dmhy')) store.createFolder('', 'dmhy')
  await sleep(200)
}

async function uploadItem(item, names) {
  const base = safeFileBase(item.title, item.infoHash)
  const fileName = base + '.torrent'
  if (names.has(fileName)) {
    return { skipped: true, fileName }
  }
  // Reserve name before download so concurrent workers don't fetch the same file twice.
  names.add(fileName)

  // Local temps only — cleared in finally so each file's buffer can GC immediately.
  let bytes = null
  let file = null
  let source = ''
  try {
    const payload = await fetchTorrentBytes(item)
    bytes = payload.bytes
    source = payload.source
    payload.bytes = null
    const size = bytes.byteLength
    file = new File([bytes], fileName, { type: 'application/x-bittorrent' })
    // Drop the Uint8Array view before upload; File holds the blob for Store.upload.
    bytes = null

    const id = await store.upload(file, 'dmhy')
    // Scalar metadata only — never return Uint8Array / File / ArrayBuffer.
    return {
      skipped: false,
      fileName,
      id,
      bytes: size,
      source,
      infoHash: item.infoHash || magnetInfoHash(item.magnet),
    }
  } catch (e) {
    names.delete(fileName) // allow retry on a later pass
    throw e
  } finally {
    bytes = null
    file = null
    source = ''
  }
}

function renderList(items) {
  const box = $('items')
  box.innerHTML = ''
  for (const it of items) {
    const row = document.createElement('div')
    row.className = 'rounded-xl border border-white/10 bg-white/[.03] px-3 py-2'
    row.innerHTML = `
      <div class="text-sm text-slate-100 break-words">${esc(it.title || '(untitled)')}</div>
      <div class="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span>${esc(it.category || '—')}</span>
        <span class="font-mono">${esc((it.infoHash || '').slice(0, 16) || 'no-hash')}</span>
      </div>`
    box.appendChild(row)
  }
}

/** One scrape → download → upload pass. Returns { ok, skip, fail }. */
async function runPass(limit) {
  pass++
  setStatus(`第 ${pass} 轮 · 拉取 RSS…`, true)
  log(`pass #${pass}: fetch RSS`)
  const all = await fetchRss()
  const items = all.slice(0, limit)
  log(`pass #${pass}: RSS ${all.length} items, batch ${items.length}, concurrency ${CONCURRENCY}`)
  renderList(items)
  $('count').textContent = String(items.length)

  const names = existingNames()
  let ok = 0, skip = 0, fail = 0, done = 0, next = 0
  const report = () => {
    $('bar').style.width = `${Math.round((done / Math.max(items.length, 1)) * 100)}%`
    setStatus(`第 ${pass} 轮 · ${done}/${items.length}（并行≤${CONCURRENCY}）`, true)
  }

  // Worker pool: claim next index only when a slot is free — no prefetch of torrent bytes.
  const worker = async () => {
    while (!abort) {
      const i = next++
      if (i >= items.length) return
      const it = items[i]
      try {
        const r = await uploadItem(it, names)
        if (r.skipped) {
          skip++
          log(`skip exists: ${r.fileName}`)
        } else {
          ok++
          log(`ok torrent ${fmt(r.bytes)} → ${r.fileName}`, 'ok')
        }
      } catch (e) {
        fail++
        log(`fail: ${it.title?.slice(0, 40)} — ${e.message}`, 'err')
      }
      done++
      report()
    }
  }

  const n = Math.min(CONCURRENCY, items.length)
  if (n > 0) await Promise.all(Array.from({ length: n }, () => worker()))
  $('bar').style.width = '100%'
  log(`pass #${pass} done ok=${ok} skip=${skip} fail=${fail}`, fail ? 'err' : 'ok')
  return { ok, skip, fail }
}

async function runLoop() {
  if (running) return
  running = true
  abort = false
  pass = 0
  $('btn-run').disabled = true
  $('btn-stop').disabled = false

  const room = ($('room').value || DEFAULT_ROOM).trim()
  const limit = Math.max(1, Math.min(50, Number($('limit').value) || DEFAULT_LIMIT))
  localStorage.setItem('dmhy-room', room)
  localStorage.setItem('dmhy-limit', String(limit))

  let errStreak = 0
  log(`loop start → ${DEFAULT_WS} room=${room} (idle ${IDLE_MS}ms when nothing new)`)

  try {
    while (!abort) {
      try {
        await ensureConnected(room)
        const { ok, skip, fail } = await runPass(limit)
        if (abort) break
        errStreak = 0

        if (ok > 0) {
          // New torrents landed — scrape again immediately for the latest.
          setStatus(`第 ${pass} 轮完成 · 立即下一轮…`, true)
          continue
        }

        // All skips / no new uploads — wait so we don't tight-loop.
        const wait = IDLE_MS
        setStatus(`无新资源 · ${Math.round(wait / 1000)}s 后再抓…`, true)
        log(`no new uploads (skip=${skip} fail=${fail}); sleep ${wait}ms`)
        await sleep(wait)
      } catch (e) {
        errStreak++
        const wait = Math.min(ERROR_BACKOFF_MS * errStreak, 60_000)
        setStatus(`错误 · ${Math.round(wait / 1000)}s 后重试`, false)
        log(`loop error: ${e.message}; backoff ${wait}ms`, 'err')
        if (abort) break
        await sleep(wait)
      }
    }
  } finally {
    running = false
    $('btn-run').disabled = false
    $('btn-stop').disabled = true
    setStatus(abort ? '已停止' : '待命', abort ? false : null)
    log(abort ? 'loop stopped by user' : 'loop ended')
  }
}

function boot() {
  $('ws').textContent = DEFAULT_WS
  $('room').value = localStorage.getItem('dmhy-room') || DEFAULT_ROOM
  $('limit').value = localStorage.getItem('dmhy-limit') || String(DEFAULT_LIMIT)
  $('btn-run').onclick = () => runLoop()
  $('btn-stop').onclick = () => {
    abort = true
    setStatus('正在停止…', false)
    log('stop requested — finishing current item then exiting loop')
  }
  $('open-drive').href = `./index.html#room=${encodeURIComponent($('room').value || DEFAULT_ROOM)}`
  $('room').addEventListener('change', () => {
    $('open-drive').href = `./index.html#room=${encodeURIComponent($('room').value || DEFAULT_ROOM)}`
  })

  if (AUTO_START) {
    log('auto-start: continuous dmhy → Flow loop until Stop')
    runLoop()
  } else {
    setStatus('待命 · 点击「开始抓取并上传」')
    log('auto-start off (VITE_DMHY_AUTO=0) — click Run to loop')
  }
}

boot()

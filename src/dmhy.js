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

const $ = id => document.getElementById(id)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const store = new Store(localStorage.getItem('crdt-ws') || DEFAULT_WS, TOKEN)
let running = false
let abort = false

function log(msg, kind = 'info') {
  const el = $('log')
  const line = document.createElement('div')
  line.className = 'text-xs font-mono leading-relaxed ' + (
    kind === 'err' ? 'text-red-300' : kind === 'ok' ? 'text-emerald-300' : 'text-slate-400'
  )
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  el.prepend(line)
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

async function uploadItem(item, names) {
  const base = safeFileBase(item.title, item.infoHash)
  const fileName = base + '.torrent'
  if (names.has(fileName)) {
    return { skipped: true, fileName }
  }

  // Must obtain real .torrent bytes before any upload
  const payload = await fetchTorrentBytes(item)
  const file = new File([payload.bytes], fileName, { type: 'application/x-bittorrent' })
  const id = await store.upload(file, 'dmhy')
  names.add(fileName)
  return {
    skipped: false,
    fileName,
    id,
    bytes: payload.bytes.byteLength,
    source: payload.source,
    infoHash: item.infoHash || magnetInfoHash(item.magnet),
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

async function runPipeline() {
  if (running) return
  running = true
  abort = false
  $('btn-run').disabled = true
  $('btn-stop').disabled = false
  setStatus('抓取 RSS…')

  const room = ($('room').value || DEFAULT_ROOM).trim()
  const limit = Math.max(1, Math.min(50, Number($('limit').value) || DEFAULT_LIMIT))
  localStorage.setItem('dmhy-room', room)
  localStorage.setItem('dmhy-limit', String(limit))

  try {
    store.wsUrl = DEFAULT_WS
    localStorage.setItem('crdt-ws', DEFAULT_WS)
    store.connect(room)
    setStatus('连接 Flow…', false)
    store.on('status', s => {
      if (s === 'connected') setStatus('已连接 · 同步中', true)
      else if (s === 'connecting') setStatus('连接中…', false)
      else setStatus('已断开', false)
    })
    await waitSynced()
    if (!store.dirs.has('dmhy')) store.createFolder('', 'dmhy')
    await sleep(300)

    log(`connected ${DEFAULT_WS} / room=${room}`)
    setStatus('拉取 dmhy RSS…', true)
    const all = await fetchRss()
    const items = all.slice(0, limit)
    log(`RSS items: ${all.length}, uploading first ${items.length}`)
    renderList(items)
    $('count').textContent = String(items.length)

    const names = existingNames()
    let ok = 0, skip = 0, fail = 0
    for (let i = 0; i < items.length; i++) {
      if (abort) { log('aborted by user'); break }
      const it = items[i]
      setStatus(`上传 ${i + 1}/${items.length}`, true)
      $('bar').style.width = `${Math.round((i / items.length) * 100)}%`
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
      await sleep(200)
    }
    $('bar').style.width = '100%'
    setStatus(`完成 · 成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`, true)
    log(`done ok=${ok} skip=${skip} fail=${fail}`, fail ? 'err' : 'ok')
  } catch (e) {
    setStatus('失败: ' + e.message, false)
    log(e.message, 'err')
  } finally {
    running = false
    $('btn-run').disabled = false
    $('btn-stop').disabled = true
  }
}

function boot() {
  $('ws').textContent = DEFAULT_WS
  $('room').value = localStorage.getItem('dmhy-room') || DEFAULT_ROOM
  $('limit').value = localStorage.getItem('dmhy-limit') || String(DEFAULT_LIMIT)
  $('btn-run').onclick = () => runPipeline()
  $('btn-stop').onclick = () => { abort = true; log('stop requested…') }
  $('open-drive').href = `./index.html#room=${encodeURIComponent($('room').value || DEFAULT_ROOM)}`
  $('room').addEventListener('change', () => {
    $('open-drive').href = `./index.html#room=${encodeURIComponent($('room').value || DEFAULT_ROOM)}`
  })

  if (AUTO_START) {
    log('auto-start enabled — fetching dmhy and uploading to plateau Flow')
    runPipeline()
  } else {
    setStatus('待命 · 点击「开始抓取并上传」')
    log('auto-start off (VITE_DMHY_AUTO=0) — click Run')
  }
}

boot()

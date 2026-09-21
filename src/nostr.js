import './style.css'
import { Store } from './store.js'
import { WS_PRESETS } from './servers.js'
import { esc, fmt } from './util.js'

// Config — mirrors dmhy page conventions; room stays separate from dmhy-bt.
const TOKEN = import.meta.env.VITE_FLOW_TOKEN || 'netdisk'
const DEFAULT_WS = import.meta.env.VITE_FLOW_WS || WS_PRESETS.find(p => p.key === 'plateau')?.url || WS_PRESETS[0].url
const DEFAULT_ROOM = import.meta.env.VITE_NOSTR_ROOM || 'nostr'
const DEFAULT_LIMIT = Number(import.meta.env.VITE_NOSTR_LIMIT || 40)
const AUTO_START = String(import.meta.env.VITE_NOSTR_AUTO ?? '1') !== '0'
const IDLE_MS = Math.max(1000, Number(import.meta.env.VITE_NOSTR_IDLE_MS || 5000))
const ERROR_BACKOFF_MS = Math.max(1000, Number(import.meta.env.VITE_NOSTR_ERROR_MS || 8000))
const PASS_WAIT_MS = Math.max(500, Number(import.meta.env.VITE_NOSTR_PASS_MS || 2500))

// Fallback when live ranking sources are unreachable (task-specified).
const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

const $ = id => document.getElementById(id)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const store = new Store(localStorage.getItem('crdt-ws') || DEFAULT_WS, TOKEN)
let running = false
let abort = false
let pass = 0
let statusHandlerBound = false
let sinceTs = 0 // created_at watermark for "newer than last pass"
const savedIds = new Set() // in-memory dedupe across the session

let RELAYS = [...FALLBACK_RELAYS]
let RELAY_WHY = 'Using task fallback relays (relay.damus.io, nos.lol, relay.primal.net) — live ranking APIs were unreachable from this environment.'

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

/**
 * Try public popularity sources; on failure keep FALLBACK_RELAYS.
 * nostr.watch ranking endpoints and nostrmash APIs are often SPA/CF-gated.
 */
async function pickRelays() {
  const candidates = [
    'https://api.nostr.watch/v1/online',
    'https://api.nostr.watch/v1/nip/11',
  ]
  for (const url of candidates) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
      clearTimeout(t)
      if (!res.ok) continue
      const data = await res.json()
      const list = normalizeRelayList(data)
      if (list.length >= 3) {
        RELAYS = list.slice(0, 3)
        RELAY_WHY = `Top 3 from ${url} (public online/ranking snapshot).`
        return
      }
    } catch { /* try next */ }
  }
  RELAYS = [...FALLBACK_RELAYS]
  RELAY_WHY = 'nostr.watch / live ranking APIs failed or returned no list — using fallback: relay.damus.io, nos.lol, relay.primal.net (also current top public relays by NIP-65 adoption on Nostr Archives).'
}

function normalizeRelayList(data) {
  const out = []
  const push = (u) => {
    if (!u || typeof u !== 'string') return
    const s = u.trim()
    if (!s.startsWith('wss://')) return
    if (!out.includes(s)) out.push(s)
  }
  if (Array.isArray(data)) {
    for (const row of data) {
      if (typeof row === 'string') push(row)
      else if (row && typeof row === 'object') push(row.url || row.relay || row.addr)
    }
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('wss://')) push(k)
      else if (v && typeof v === 'object') push(v.url || k)
    }
  }
  return out
}

function renderRelays() {
  $('relay-why').textContent = RELAY_WHY
  const ul = $('relays')
  ul.innerHTML = ''
  for (const r of RELAYS) {
    const li = document.createElement('li')
    li.textContent = r
    ul.appendChild(li)
  }
}

/** Fetch latest kind:1 notes from one relay (REQ → EVENT* → EOSE). */
function fetchFromRelay(relayUrl, { limit, since }, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const events = []
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      try { ws.close() } catch { /* */ }
      resolve(events)
    }
    let ws
    try {
      ws = new WebSocket(relayUrl)
    } catch {
      resolve(events)
      return
    }
    const subId = 'n' + Math.random().toString(36).slice(2, 10)
    const timer = setTimeout(done, timeoutMs)
    ws.onopen = () => {
      const filter = { kinds: [1], limit }
      if (since > 0) filter.since = since
      ws.send(JSON.stringify(['REQ', subId, filter]))
    }
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return }
      if (!Array.isArray(msg)) return
      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
        const e = msg[2]
        if (e.kind === 1 && e.id && typeof e.content === 'string') events.push(e)
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        clearTimeout(timer)
        try { ws.send(JSON.stringify(['CLOSE', subId])) } catch { /* */ }
        done()
      }
    }
    ws.onerror = () => { clearTimeout(timer); done() }
    ws.onclose = () => { clearTimeout(timer); done() }
  })
}

async function fetchLatestNotes(limit) {
  const results = await Promise.all(
    RELAYS.map(async (url) => {
      try {
        const evs = await fetchFromRelay(url, { limit, since: sinceTs })
        return { url, evs, err: null }
      } catch (e) {
        return { url, evs: [], err: e.message }
      }
    }),
  )
  const byId = new Map()
  const status = []
  for (const r of results) {
    status.push(`${r.url.replace(/^wss:\/\//, '')}:${r.err ? 'err' : r.evs.length}`)
    if (r.err) log(`relay ${r.url}: ${r.err}`, 'err')
    for (const e of r.evs) {
      if (!byId.has(e.id)) byId.set(e.id, e)
    }
  }
  $('relay-status').textContent = status.join(' · ')
  // Newest first
  return [...byId.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
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
        if (!running) return
        if (s === 'connecting') setStatus('连接 Flow…', false)
        else if (s !== 'connected') setStatus('已断开', false)
      })
    }
  }
  await waitSynced()
  if (!store.dirs.has('nostr')) store.createFolder('', 'nostr')
  await sleep(150)
  // Seed savedIds from drive filenames once per connect
  for (const name of existingNames()) {
    const m = name.match(/^([0-9a-f]{64})\.json$/i)
    if (m) savedIds.add(m[1].toLowerCase())
  }
}

function fileNameFor(id) {
  return `${String(id).toLowerCase()}.json`
}

/** Save one note; drop all payload refs in finally. */
async function saveNote(event, names) {
  const id = String(event.id).toLowerCase()
  const fileName = fileNameFor(id)
  if (savedIds.has(id) || names.has(fileName)) {
    savedIds.add(id)
    return { skipped: true, fileName }
  }
  savedIds.add(id)
  names.add(fileName)

  let text = null
  let file = null
  try {
    // Minimal JSON document — only what we need to persist
    text = JSON.stringify({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    })
    const size = text.length
    file = new File([text], fileName, { type: 'application/json' })
    text = null
    await store.upload(file, 'nostr')
    return { skipped: false, fileName, bytes: size }
  } catch (e) {
    savedIds.delete(id)
    names.delete(fileName)
    throw e
  } finally {
    text = null
    file = null
  }
}

function renderPreview(events) {
  const box = $('items')
  box.innerHTML = ''
  for (const e of events.slice(0, 12)) {
    const row = document.createElement('div')
    row.className = 'rounded-xl border border-white/10 bg-white/[.03] px-3 py-2'
    const snippet = String(e.content || '').replace(/\s+/g, ' ').slice(0, 120)
    row.innerHTML = `
      <div class="text-sm text-slate-100 break-words">${esc(snippet || '(empty)')}</div>
      <div class="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
        <span class="font-mono">${esc(String(e.id || '').slice(0, 12))}…</span>
        <span>${e.created_at ? new Date(e.created_at * 1000).toLocaleString() : ''}</span>
      </div>`
    box.appendChild(row)
  }
}

async function runPass(limit) {
  pass++
  setStatus(`第 ${pass} 轮 · 拉取 Nostr…`, true)
  log(`pass #${pass}: REQ kind:1 limit=${limit}` + (sinceTs ? ` since=${sinceTs}` : ' (latest)'))

  // Hold events only for this pass; clear after saving.
  let events = await fetchLatestNotes(limit)
  $('count').textContent = String(events.length)
  renderPreview(events)
  log(`pass #${pass}: ${events.length} unique notes from relays`)

  const names = existingNames()
  let ok = 0, skip = 0, fail = 0
  for (let i = 0; i < events.length; i++) {
    if (abort) break
    const ev = events[i]
    // Clear slot in the array so the big content string isn't retained after save.
    events[i] = null
    setStatus(`第 ${pass} 轮 · 保存 ${i + 1}/${events.length}`, true)
    $('bar').style.width = `${Math.round(((i + 1) / Math.max(events.length, 1)) * 100)}%`
    try {
      const r = await saveNote(ev, names)
      if (r.skipped) {
        skip++
      } else {
        ok++
        log(`ok ${fmt(r.bytes)} → ${r.fileName}`, 'ok')
      }
      if (ev.created_at && ev.created_at > sinceTs) sinceTs = ev.created_at
    } catch (e) {
      fail++
      log(`fail ${String(ev.id).slice(0, 12)}: ${e.message}`, 'err')
    }
    // Drop event object reference
    // (content already unused after saveNote copied JSON string and nulled locals)
  }
  events = null
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
  const limit = Math.max(1, Math.min(100, Number($('limit').value) || DEFAULT_LIMIT))
  localStorage.setItem('nostr-room', room)
  localStorage.setItem('nostr-limit', String(limit))

  let errStreak = 0
  log(`loop start → ${DEFAULT_WS} room=${room}`)
  log(`relays: ${RELAYS.join(', ')}`)

  try {
    while (!abort) {
      try {
        await ensureConnected(room)
        const { ok, skip, fail } = await runPass(limit)
        if (abort) break
        errStreak = 0

        if (ok > 0) {
          setStatus(`第 ${pass} 轮完成 · 立即下一轮…`, true)
          await sleep(200)
          continue
        }

        const wait = IDLE_MS
        setStatus(`无新笔记 · ${Math.round(wait / 1000)}s 后再拉…`, true)
        log(`no new saves (skip=${skip} fail=${fail}); sleep ${wait}ms`)
        // After first "latest" pass, advance watermark so later REQ uses since=
        // (still limited — never backfills full history).
        if (sinceTs === 0) sinceTs = Math.floor(Date.now() / 1000) - 60
        await sleep(wait)
      } catch (e) {
        errStreak++
        const wait = Math.min(ERROR_BACKOFF_MS * errStreak, 60_000)
        setStatus(`错误 · ${Math.round(wait / 1000)}s 后重试`, false)
        log(`loop error: ${e.message}; backoff ${wait}ms`, 'err')
        if (abort) break
        await sleep(wait)
      }
      // Brief pause even on hot path to let relays breathe when we continue immediately
      if (!abort && PASS_WAIT_MS && errStreak === 0) { /* already handled above */ }
    }
  } finally {
    running = false
    $('btn-run').disabled = false
    $('btn-stop').disabled = true
    setStatus(abort ? '已停止' : '待命', abort ? false : null)
    log(abort ? 'loop stopped by user' : 'loop ended')
  }
}

async function boot() {
  $('ws').textContent = DEFAULT_WS
  $('room').value = localStorage.getItem('nostr-room') || DEFAULT_ROOM
  $('limit').value = localStorage.getItem('nostr-limit') || String(DEFAULT_LIMIT)
  $('btn-run').onclick = () => runLoop()
  $('btn-stop').onclick = () => {
    abort = true
    setStatus('正在停止…', false)
    log('stop requested')
  }
  $('open-drive').href = `./index.html#room=${encodeURIComponent($('room').value || DEFAULT_ROOM)}`
  $('room').addEventListener('change', () => {
    $('open-drive').href = `./index.html#room=${encodeURIComponent($('room').value || DEFAULT_ROOM)}`
  })

  setStatus('选择继电器…')
  await pickRelays()
  renderRelays()
  log(RELAY_WHY)

  if (AUTO_START) {
    log('auto-start: continuous Nostr → Flow loop until Stop')
    runLoop()
  } else {
    setStatus('待命 · 点击「开始拉取并保存」')
    log('auto-start off (VITE_NOSTR_AUTO=0)')
  }
}

boot()

// Shareable "watch online" page.
//
// A share link (#watch=<room>&v=<id>) carries only the room name + file id — the
// decryption key is derived from the room name, so anyone with the link can play
// the file. Opening such a link connects to the room, waits for the file's
// metadata to sync, then streams it through the same service-worker media bridge
// (play-while-loading + seeking), falling back to a full download when needed.
import { initMedia, mediaUrl, streamingAvailable } from './media.js'
import { previewKind, esc } from './util.js'

const MEDIA = 'max-h-[82vh] max-w-[92vw] rounded-xl shadow-2xl'

// Parse a #watch link, or null for normal app mode.
export function watchTarget() {
  const m = location.hash.match(/watch=([^&]+)&v=([^&]+)/)
  return m ? { room: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : null
}

export function shareWatchUrl(room, id) {
  return `${location.origin}${location.pathname}#watch=${encodeURIComponent(room)}&v=${encodeURIComponent(id)}`
}

export async function runWatch(store, { room, id }) {
  initMedia(store)
  store.connect(room)

  document.title = '在线观看 · CRDT Drive'
  document.body.className = 'min-h-screen bg-black text-slate-100 antialiased'
  document.body.innerHTML = `
    <div class="flex min-h-screen flex-col">
      <header class="flex items-center gap-3 border-b border-white/10 px-5 py-3">
        <span class="text-lg">▶️</span>
        <h1 id="w-title" class="flex-1 truncate text-sm font-medium text-slate-300">加载中…</h1>
        <a id="w-open" href="#" class="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:bg-white/10">打开网盘</a>
      </header>
      <div id="w-stage" class="flex flex-1 items-center justify-center p-4">
        <div class="text-sm text-slate-400">正在连接「${esc(room)}」…</div>
      </div>
    </div>`
  const open = document.getElementById('w-open')
  open.href = `${location.pathname}#room=${encodeURIComponent(room)}`
  open.onclick = e => { e.preventDefault(); location.hash = `room=${encodeURIComponent(room)}`; location.reload() }

  const stage = document.getElementById('w-stage')
  const info = await waitForFile(store, id)
  if (!info) {
    stage.innerHTML = `<div class="text-center text-sm text-slate-400">文件不存在、已被删除,或还在同步中。<br/>稍后刷新页面重试。</div>`
    return
  }
  const file = { id, ...info }
  document.getElementById('w-title').textContent = file.name || '未命名'
  document.title = (file.name || '在线观看') + ' · CRDT Drive'
  renderPlayer(store, file, stage)
}

function renderPlayer(store, file, stage) {
  const kind = previewKind(file.type, file.name) || 'video'
  if ((kind === 'video' || kind === 'audio') && streamingAvailable()) {
    const url = mediaUrl(file.id)
    stage.innerHTML = kind === 'video'
      ? `<video src="${url}" controls autoplay playsinline class="${MEDIA}"></video>`
      : `<audio src="${url}" controls autoplay></audio>`
    stage.querySelector(kind === 'video' ? 'video' : 'audio')
      .addEventListener('error', () => renderFull(store, file, kind, stage), { once: true })
    return
  }
  renderFull(store, file, kind, stage)
}

let blobUrl = null
async function renderFull(store, file, kind, stage) {
  stage.innerHTML = `<div class="text-sm text-slate-400">加载中… <span id="w-pct">0%</span></div>`
  let bytes
  try {
    bytes = await store.readFile(file.id, p => {
      const el = document.getElementById('w-pct'); if (el) el.textContent = Math.round(p * 100) + '%'
    })
  } catch (e) { stage.innerHTML = `<div class="text-sm text-slate-400">加载失败:${esc(e.message)}</div>`; return }
  if (!bytes) { stage.innerHTML = `<div class="text-sm text-slate-400">文件还在同步中或分片缺失,请稍候再试</div>`; return }
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  blobUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }))
  if (kind === 'video') stage.innerHTML = `<video src="${blobUrl}" controls autoplay class="${MEDIA}"></video>`
  else if (kind === 'audio') stage.innerHTML = `<audio src="${blobUrl}" controls autoplay></audio>`
  else if (kind === 'image') stage.innerHTML = `<img src="${blobUrl}" alt="${esc(file.name)}" class="${MEDIA}" />`
  else if (kind === 'pdf') stage.innerHTML = `<iframe src="${blobUrl}" title="${esc(file.name)}" class="h-[82vh] w-[92vw] rounded-xl border-0 bg-white"></iframe>`
  else stage.innerHTML = `<a href="${blobUrl}" download="${esc(file.name)}" class="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium">下载 ${esc(file.name)}</a>`
}

// Resolve once the file's metadata (incl. decrypted name/type) has synced in.
function waitForFile(store, id, ms = 20000) {
  return new Promise(resolve => {
    let done = false
    const ready = () => store.meta?.has(id) && store.namePlain?.has(id)
    const finish = () => { if (done) return; done = true; resolve(ready() ? store.fileInfo(id) : null) }
    if (ready()) return finish()
    store.on('change', () => { if (ready()) finish() })
    setTimeout(finish, ms)
  })
}

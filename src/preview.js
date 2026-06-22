// Inline preview modal for images / video / audio / pdf / text.
//
// Video & audio stream through the service worker (see media.js) so they play
// and seek *while loading*. If streaming is unavailable, or the stream errors
// (e.g. a shard is still syncing), we fall back to downloading the whole file.
// Images / pdf / text use the full-read path; text reads only its first 512KB.
import { previewKind, fmt, esc } from './util.js'
import { mediaUrl, streamingAvailable } from './media.js'

const MEDIA = 'max-h-[78vh] max-w-[86vw] rounded-lg'
const LOADING = 'p-10 text-sm text-slate-400'
const TEXT_MAX = 512 * 1024

let curUrl = null
let curStore = null
function cleanup() {
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null }
  curStore?.clearMediaCache?.()
}

export function canPreview(file) { return !!previewKind(file.type, file.name) }

export async function openPreview(store, file) {
  const kind = previewKind(file.type, file.name)
  curStore = store
  const modal = document.getElementById('modal')
  const body = document.getElementById('modal-body')
  document.getElementById('modal-title').textContent = file.name
  modal.classList.remove('hidden'); modal.classList.add('flex')
  cleanup()

  // Stream video/audio when the SW bridge is up — start playing right away.
  if ((kind === 'video' || kind === 'audio') && streamingAvailable()) {
    renderStream(kind, file, body)
    return
  }
  await renderFull(kind, store, file, body)
}

function renderStream(kind, file, body) {
  const url = mediaUrl(file.id)
  if (kind === 'video') {
    body.innerHTML = `<video src="${url}" controls autoplay playsinline class="${MEDIA}"></video>`
  } else {
    body.innerHTML = `<div class="px-8 py-6 text-center"><div class="mb-4 text-6xl">🎵</div><audio src="${url}" controls autoplay></audio></div>`
  }
  // Stream failed (missing shard / unsupported) → fall back to a full download.
  body.querySelector(kind === 'video' ? 'video' : 'audio')
    .addEventListener('error', () => renderFull(kind, curStore, file, body), { once: true })
}

async function renderFull(kind, store, file, body) {
  body.innerHTML = `<div class="${LOADING}">加载中… <span id="pv-pct">0%</span></div>`
  let bytes
  try {
    bytes = kind === 'text'
      ? await store.readRange(file.id, 0, TEXT_MAX + 1)
      : await store.readFile(file.id, p => {
          const el = document.getElementById('pv-pct'); if (el) el.textContent = Math.round(p * 100) + '%'
        })
  } catch (e) { body.innerHTML = `<div class="${LOADING}">加载失败：${esc(e.message)}</div>`; return }
  if (!bytes) { body.innerHTML = `<div class="${LOADING}">文件还在同步中或分片缺失，请稍候再试</div>`; return }
  cleanup()
  curUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }))

  if (kind === 'image') {
    body.innerHTML = `<img src="${curUrl}" alt="${esc(file.name)}" class="${MEDIA}" />`
  } else if (kind === 'video') {
    body.innerHTML = `<video src="${curUrl}" controls autoplay class="${MEDIA}"></video>`
  } else if (kind === 'audio') {
    body.innerHTML = `<div class="px-8 py-6 text-center"><div class="mb-4 text-6xl">🎵</div><audio src="${curUrl}" controls autoplay></audio></div>`
  } else if (kind === 'pdf') {
    body.innerHTML = `<iframe src="${curUrl}" title="${esc(file.name)}" class="h-[78vh] w-[86vw] rounded-lg border-0 bg-white"></iframe>`
  } else if (kind === 'text') {
    const text = new TextDecoder().decode(bytes.slice(0, TEXT_MAX))
    body.innerHTML = `<pre class="max-h-[78vh] max-w-[86vw] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-4 font-mono text-[13px] leading-relaxed"></pre>`
    body.querySelector('pre').textContent = text + (file.size > TEXT_MAX ? '\n\n… （已截断，完整内容请下载）' : '')
  } else {
    body.innerHTML = `<div class="${LOADING}">该类型不支持预览（${esc(file.type || '未知')}，${fmt(file.size)}）</div>`
  }
}

export function initPreview() {
  const modal = document.getElementById('modal')
  const close = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); document.getElementById('modal-body').innerHTML = ''; cleanup() }
  document.getElementById('modal-close').onclick = close
  modal.addEventListener('click', e => { if (e.target === modal) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
}

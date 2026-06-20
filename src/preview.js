// Inline preview modal for images / video / audio / pdf / text.
import { previewKind, fmt, esc } from './util.js'

let curUrl = null
function cleanup() { if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null } }

export function canPreview(file) { return !!previewKind(file.type, file.name) }

export function openPreview(store, file) {
  const kind = previewKind(file.type, file.name)
  const modal = document.getElementById('modal')
  const body = document.getElementById('modal-body')
  const title = document.getElementById('modal-title')
  const LOADING = 'p-10 text-sm text-slate-400'
  title.textContent = file.name
  body.innerHTML = `<div class="${LOADING}">加载中…</div>`
  modal.classList.remove('hidden'); modal.classList.add('flex')

  const bytes = store.getBytes(file.id)
  if (!bytes) { body.innerHTML = `<div class="${LOADING}">文件还在同步中，请稍候再试</div>`; return }
  cleanup()
  curUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }))

  if (kind === 'image') {
    body.innerHTML = `<img src="${curUrl}" alt="${esc(file.name)}" class="max-h-[78vh] max-w-[86vw] rounded-lg" />`
  } else if (kind === 'video') {
    body.innerHTML = `<video src="${curUrl}" controls autoplay class="max-h-[78vh] max-w-[86vw] rounded-lg"></video>`
  } else if (kind === 'audio') {
    body.innerHTML = `<div class="px-8 py-6 text-center"><div class="mb-4 text-6xl">🎵</div><audio src="${curUrl}" controls autoplay></audio></div>`
  } else if (kind === 'pdf') {
    body.innerHTML = `<iframe src="${curUrl}" title="${esc(file.name)}" class="h-[78vh] w-[86vw] rounded-lg border-0 bg-white"></iframe>`
  } else if (kind === 'text') {
    const text = new TextDecoder().decode(bytes.slice(0, 512 * 1024))
    body.innerHTML = `<pre class="max-h-[78vh] max-w-[86vw] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-4 font-mono text-[13px] leading-relaxed"></pre>`
    body.querySelector('pre').textContent = text + (bytes.length > 512 * 1024 ? '\n\n… （已截断，完整内容请下载）' : '')
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

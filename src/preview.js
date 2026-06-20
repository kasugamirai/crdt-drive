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
  title.textContent = file.name
  body.innerHTML = '<div class="modal-loading">加载中…</div>'
  modal.classList.add('show')

  const bytes = store.getBytes(file.id)
  if (!bytes) { body.innerHTML = '<div class="modal-loading">文件还在同步中,请稍候再试</div>'; return }
  cleanup()
  curUrl = URL.createObjectURL(new Blob([bytes], { type: file.type }))

  if (kind === 'image') {
    body.innerHTML = `<img src="${curUrl}" alt="${esc(file.name)}" />`
  } else if (kind === 'video') {
    body.innerHTML = `<video src="${curUrl}" controls autoplay></video>`
  } else if (kind === 'audio') {
    body.innerHTML = `<div class="audio-wrap"><div class="big-icon">🎵</div><audio src="${curUrl}" controls autoplay></audio></div>`
  } else if (kind === 'pdf') {
    body.innerHTML = `<iframe src="${curUrl}" title="${esc(file.name)}"></iframe>`
  } else if (kind === 'text') {
    const text = new TextDecoder().decode(bytes.slice(0, 512 * 1024))
    body.innerHTML = `<pre class="text-preview"></pre>`
    body.querySelector('pre').textContent = text + (bytes.length > 512 * 1024 ? '\n\n… (已截断,完整内容请下载)' : '')
  } else {
    body.innerHTML = `<div class="modal-loading">该类型不支持预览(${esc(file.type || '未知')},${fmt(file.size)})</div>`
  }
}

export function initPreview() {
  const modal = document.getElementById('modal')
  const close = () => { modal.classList.remove('show'); document.getElementById('modal-body').innerHTML = ''; cleanup() }
  document.getElementById('modal-close').onclick = close
  modal.addEventListener('click', e => { if (e.target === modal) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
}

// Small helpers: formatting, path math, file categorization, base64.

export function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
export function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function fmt(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return (i ? n.toFixed(1) : n) + ' ' + u[i]
}

export function esc(s) {
  const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML
}

// ---- path helpers. paths use "/" separator, no leading slash, root = "" ----
export const pathJoin = (a, b) => (a ? a + '/' + b : b)
export const parentPath = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i) }
export const baseName = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1) }
export const dirName = (p) => parentPath(p)

const EXT = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')

export function categoryOf(type = '', name = '') {
  const t = type.toLowerCase(), e = EXT(name)
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(e)) return 'image'
  if (t.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'].includes(e)) return 'video'
  if (t.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(e)) return 'audio'
  if (t === 'application/pdf' || e === 'pdf') return 'doc'
  if (t.startsWith('text/') || ['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'html', 'csv', 'log', 'xml', 'yml', 'yaml'].includes(e)) return 'doc'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(e) || t.includes('zip') || t.includes('compressed')) return 'archive'
  return 'other'
}

export const CATEGORY_LABEL = { image: '图片', video: '视频', audio: '音频', doc: '文档', archive: '压缩包', other: '其他' }
export const CATEGORY_ICON  = { image: '🖼️', video: '🎬', audio: '🎵', doc: '📄', archive: '🗜️', other: '📦' }

// what kind of inline preview a file supports, or null
export function previewKind(type = '', name = '') {
  const t = type.toLowerCase(), e = EXT(name)
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(e)) return 'image'
  if (t.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(e)) return 'video'
  if (t.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(e)) return 'audio'
  if (t === 'application/pdf' || e === 'pdf') return 'pdf'
  if (t.startsWith('text/') || ['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'html', 'csv', 'log', 'xml', 'yml', 'yaml'].includes(e)) return 'text'
  return null
}

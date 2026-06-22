import './style.css'
import { Store } from './store.js'
import { initPreview, openPreview, canPreview } from './preview.js'
import { initMedia } from './media.js'
import { watchTarget, runWatch, shareWatchUrl } from './watch.js'
import { fmt, esc, fmtDuration, pathJoin, baseName, dirName, categoryOf, CATEGORY_LABEL, CATEGORY_ICON, previewKind } from './util.js'

const WS_PRESETS = [
  { label: 'PLATEAU · ws.flow.plateau.reearth.io', url: 'wss://ws.flow.plateau.reearth.io' },
  { label: 'Prod · ws.flow.reearth.io', url: 'wss://ws.flow.reearth.io' },
  { label: 'Test · ws.flow.test.reearth.dev', url: 'wss://ws.flow.test.reearth.dev' },
  { label: 'Dev · ws.flow.dev.reearth.io', url: 'wss://ws.flow.dev.reearth.io' },
]
const TOKEN = 'netdisk'                          // server does not validate
const DEFAULT_ROOM = 'netdisk-public-room'

const $ = id => document.getElementById(id)
const savedWs = localStorage.getItem('crdt-ws')
const store = new Store(savedWs || WS_PRESETS[0].url, TOKEN)

// app state
const state = { cwd: '', search: '', cat: 'all' }

// ---------- connection ----------
store.on('status', s => {
  const on = s === 'connected'
  $('dot').className = 'dot ' + (on ? 'dot-on' : 'dot-off')
  $('status').textContent = on ? '已连接' : (s === 'connecting' ? '连接中…' : '已断开')
})
store.on('online', n => $('online').textContent = n)
store.on('change', render)

function roomFromUrl() {
  const m = location.hash.match(/room=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : DEFAULT_ROOM
}
function connect(room) {
  state.cwd = ''; state.search = ''; state.cat = 'all'
  $('search').value = ''
  store.connect(room)
  $('room').value = room
  location.hash = 'room=' + encodeURIComponent(room)
  renderChips()
}

// ---------- WS server switcher ----------
function buildServerSelect() {
  const sel = $('server'); sel.innerHTML = ''
  for (const p of WS_PRESETS) {
    const o = document.createElement('option'); o.value = p.url; o.textContent = p.label; sel.appendChild(o)
  }
  const custom = document.createElement('option'); custom.value = '__custom__'; custom.textContent = '自定义…'; sel.appendChild(custom)
  if (WS_PRESETS.some(p => p.url === store.wsUrl)) {
    sel.value = store.wsUrl
  } else { // current url is a custom one
    custom.value = store.wsUrl; custom.textContent = '自定义:' + store.wsUrl; sel.value = store.wsUrl
  }
  sel.onchange = () => {
    let url = sel.value
    if (url === '__custom__') { url = (prompt('输入 WebSocket 服务器地址 (wss://…)', store.wsUrl) || '').trim(); if (!url) return buildServerSelect() }
    setServer(url)
  }
}
function setServer(url) {
  store.wsUrl = url
  localStorage.setItem('crdt-ws', url)
  buildServerSelect()
  connect(store.room || roomFromUrl())   // reconnect current room on the new server
}

// ---------- rendering ----------
function render() {
  $('total').textContent = fmt(store.totalSize())
  renderBreadcrumb()

  const searching = state.search.trim().length > 0
  let folders = [], files = []
  if (searching) {
    const q = state.search.trim().toLowerCase()
    files = store.allFiles().filter(f => f.name.toLowerCase().includes(q))
  } else {
    const d = store.listDir(state.cwd); folders = d.folders; files = d.files
  }
  if (state.cat !== 'all') files = files.filter(f => categoryOf(f.type, f.name) === state.cat)

  const list = $('list'); list.innerHTML = ''

  if (!searching) for (const folder of folders) list.appendChild(folderRow(folder))
  for (const f of files) list.appendChild(fileRow(f, searching))

  const empty = folders.length + files.length === 0
  $('empty').style.display = empty ? 'block' : 'none'
  $('empty').textContent = searching ? '没有匹配的文件'
    : state.cat !== 'all' ? '该分类下没有文件'
    : '这里还没有内容,上传或新建文件夹吧 👆'
}

const ROW = 'border-t border-white/5 transition hover:bg-white/[.03]'
const CELL = 'px-4 py-3 align-middle'

function folderRow(folder) {
  const tr = document.createElement('tr')
  tr.className = ROW
  tr.innerHTML = `
    <td class="${CELL}">
      <button class="nav flex items-center gap-2 text-left font-medium transition hover:text-brand-400">
        <span class="text-lg">📁</span><span class="fname break-all"></span>
      </button>
    </td>
    <td class="${CELL} text-slate-500">—</td>
    <td class="${CELL} text-sm text-slate-500">文件夹</td>
    <td class="${CELL}"></td>
    <td class="${CELL} whitespace-nowrap text-right"><button class="iconbtn del hover:text-red-400">删除</button></td>`
  tr.querySelector('.fname').textContent = folder.name
  tr.querySelector('.nav').onclick = () => { state.cwd = folder.path; render() }
  tr.querySelector('.del').onclick = e => {
    e.stopPropagation()
    if (confirm(`删除文件夹「${folder.name}」及其中所有内容?`)) store.deleteFolder(folder.path)
  }
  return tr
}

function fileRow(f, showPath) {
  const cat = categoryOf(f.type, f.name)
  const tr = document.createElement('tr')
  tr.className = ROW
  const pk = previewKind(f.type, f.name)
  const can = !!pk
  const canShare = pk === 'video' || pk === 'audio'   // streamable online via a share link
  const nameInner = `<span class="text-lg">${CATEGORY_ICON[cat]}</span><span class="fname break-all font-medium"></span>${showPath ? '<small class="path text-slate-500"></small>' : ''}`
  tr.innerHTML = `
    <td class="${CELL}">
      ${can
        ? `<button class="pvname flex items-center gap-2 text-left transition hover:text-brand-400">${nameInner}</button>`
        : `<div class="flex items-center gap-2">${nameInner}</div>`}
    </td>
    <td class="${CELL} text-slate-400">${fmt(f.size)}</td>
    <td class="${CELL} text-sm text-slate-400">${esc(CATEGORY_LABEL[cat])}</td>
    <td class="${CELL} text-sm text-slate-500">${new Date(f.time).toLocaleString()}</td>
    <td class="${CELL} whitespace-nowrap text-right">
      ${can ? '<button class="iconbtn pv">预览</button>' : ''}
      ${canShare ? '<button class="iconbtn share">🔗 分享</button>' : ''}
      <button class="iconbtn dl">下载</button>
      <button class="iconbtn del hover:text-red-400">删除</button>
    </td>`
  tr.querySelector('.fname').textContent = f.name
  if (showPath) tr.querySelector('.path').textContent = '· ' + (f.dir || '根目录') + '/'
  if (can) {
    tr.querySelector('.pvname').onclick = () => openPreview(store, f)
    tr.querySelector('.pv').onclick = () => openPreview(store, f)
  }
  const sh = tr.querySelector('.share')
  if (sh) sh.onclick = async () => {
    const link = shareWatchUrl(store.room, f.id)
    try { await navigator.clipboard.writeText(link) }
    catch { prompt('复制此链接分享,对方可在线观看:', link); return }
    const old = sh.textContent; sh.textContent = '✅ 已复制'; setTimeout(() => sh.textContent = old, 1500)
  }
  tr.querySelector('.dl').onclick = () => downloadFile(f)
  tr.querySelector('.del').onclick = () => { if (confirm(`删除「${f.name}」?所有人都将看不到。`)) store.deleteFile(f.id) }
  return tr
}

async function downloadFile(f) {
  dlShow(f.name)
  const start = performance.now()
  let blob
  try { blob = await store.readBlob(f.id, p => dlUpdate(p, start, f.size)) }
  catch (e) { dlHide(); alert(`下载失败:${e.message}`); return }
  dlHide()
  if (!blob) { alert('文件还在同步中或分片缺失,请稍候再试'); return }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = f.name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

// ---------- download progress toast ----------
function dlShow(name) {
  $('dl-name').textContent = name
  $('dl-pct').textContent = '0%'
  $('dl-bar').style.width = '0%'
  $('dl-eta').textContent = '准备中…'
  $('dl-toast').classList.remove('hidden')
}
function dlUpdate(p, start, size) {
  const pct = Math.round(p * 100)
  $('dl-pct').textContent = pct + '%'
  $('dl-bar').style.width = pct + '%'
  const elapsed = (performance.now() - start) / 1000
  if (p > 0 && elapsed > 0.3) {
    const speed = (p * size) / elapsed                 // bytes/s
    $('dl-eta').textContent = `${fmt(speed)}/s · 剩余约 ${fmtDuration((1 - p) * size / speed)}`
  }
}
function dlHide() { $('dl-toast').classList.add('hidden') }

function renderBreadcrumb() {
  const bc = $('breadcrumb'); bc.innerHTML = ''
  const crumb = (label, path) => {
    const s = document.createElement('span'); s.className = 'crumb'; s.textContent = label
    s.onclick = () => { state.cwd = path; state.search = ''; $('search').value = ''; render() }
    return s
  }
  bc.appendChild(crumb('🏠 根目录', ''))
  if (state.cwd) {
    let acc = ''
    for (const part of state.cwd.split('/')) {
      acc = pathJoin(acc, part)
      bc.appendChild(Object.assign(document.createElement('span'), { className: 'text-slate-600', textContent: '/' }))
      bc.appendChild(crumb(part, acc))
    }
  }
}

function renderChips() {
  const wrap = $('chips'); wrap.innerHTML = ''
  const cats = ['all', 'image', 'video', 'audio', 'doc', 'archive', 'other']
  for (const c of cats) {
    const b = document.createElement('button')
    b.className = 'chip' + (state.cat === c ? ' chip-active' : '')
    b.textContent = c === 'all' ? '全部' : CATEGORY_ICON[c] + ' ' + CATEGORY_LABEL[c]
    b.onclick = () => { state.cat = c; renderChips(); render() }
    wrap.appendChild(b)
  }
}

// ---------- uploads ----------
async function uploadMany(files, baseDir, useRelative) {
  if (!files.length) return
  showBar(true)
  let done = 0
  for (const file of files) {
    // folder upload preserves structure via webkitRelativePath
    const rel = useRelative && file.webkitRelativePath ? file.webkitRelativePath : file.name
    const sub = dirName(rel)
    const dir = sub ? pathJoin(baseDir, sub) : baseDir
    if (sub) store.createFolder(baseDir, sub.split('/')[0]) // ensure top folder visible
    try {
      await store.upload(file, dir, p => setBar((done + p) / files.length))
    } catch (e) {
      alert(`上传「${file.name}」失败:${e.message}`)
      break
    }
    done++
  }
  showBar(false)
}

function showBar(on) { $('bar').style.display = on ? 'block' : 'none'; if (!on) setBar(0) }
function setBar(p) { $('bar').firstElementChild.style.width = Math.round(p * 100) + '%' }

// ---------- wiring ----------
function init() {
  const target = watchTarget()
  if (target) { runWatch(store, target); return }   // shared "watch online" link → dedicated player page

  initPreview()
  initMedia(store)        // register the media-streaming service worker
  renderChips()
  buildServerSelect()

  const drop = $('drop'), fileInput = $('file'), folderInput = $('folder')
  drop.onclick = () => fileInput.click()
  fileInput.onchange = () => { uploadMany([...fileInput.files], state.cwd, false); fileInput.value = '' }
  folderInput.onchange = () => { uploadMany([...folderInput.files], state.cwd, true); folderInput.value = '' }
  $('btn-upload').onclick = () => fileInput.click()
  $('btn-upfolder').onclick = () => folderInput.click()

  ;['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot') }))
  ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot') }))
  drop.addEventListener('drop', e => uploadMany([...e.dataTransfer.files], state.cwd, false))

  $('btn-newfolder').onclick = () => {
    const name = prompt('新文件夹名称')
    if (name && name.trim()) store.createFolder(state.cwd, name)
  }

  let t
  $('search').oninput = e => { clearTimeout(t); t = setTimeout(() => { state.search = e.target.value; render() }, 150) }

  $('switch').onclick = () => { const r = $('room').value.trim(); if (r) connect(r) }
  $('share').onclick = async () => {
    await navigator.clipboard.writeText(location.href).catch(() => {})
    $('share').textContent = '已复制!'; setTimeout(() => $('share').textContent = '复制分享链接', 1500)
  }
  window.addEventListener('hashchange', () => { const r = roomFromUrl(); if (r !== store.room) connect(r) })

  connect(roomFromUrl())
}

init()

import './style.css'
import { Store } from './store.js'
import { initPreview, openPreview, canPreview } from './preview.js'
import { fmt, esc, pathJoin, baseName, dirName, categoryOf, CATEGORY_LABEL, CATEGORY_ICON, previewKind } from './util.js'

const WS_URL = 'wss://ws.flow.dev.reearth.io'  // verified-working CRDT link
const TOKEN = 'netdisk'                          // server does not validate
const DEFAULT_ROOM = 'netdisk-public-room'

const $ = id => document.getElementById(id)
const store = new Store(WS_URL, TOKEN)

// app state
const state = { cwd: '', search: '', cat: 'all' }

// ---------- connection ----------
store.on('status', s => {
  const on = s === 'connected'
  $('dot').className = 'dot ' + (on ? 'on' : 'off')
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

// ---------- rendering ----------
function render() {
  $('wsurl').textContent = WS_URL
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

function folderRow(folder) {
  const tr = document.createElement('tr')
  tr.className = 'folder'
  tr.innerHTML = `
    <td class="name">📁 <span></span></td>
    <td>—</td><td><small class="muted">文件夹</small></td><td></td>
    <td class="actions"><button class="iconbtn del">删除</button></td>`
  tr.querySelector('span').textContent = folder.name
  tr.querySelector('.name').onclick = () => { state.cwd = folder.path; render() }
  tr.querySelector('.del').onclick = e => {
    e.stopPropagation()
    if (confirm(`删除文件夹「${folder.name}」及其中所有内容?`)) store.deleteFolder(folder.path)
  }
  return tr
}

function fileRow(f, showPath) {
  const cat = categoryOf(f.type, f.name)
  const tr = document.createElement('tr')
  const can = !!previewKind(f.type, f.name)
  tr.innerHTML = `
    <td class="name">${CATEGORY_ICON[cat]} <span class="fname"></span>${showPath ? ' <small class="muted path"></small>' : ''}</td>
    <td>${fmt(f.size)}</td>
    <td><small class="muted">${esc(CATEGORY_LABEL[cat])}</small></td>
    <td><small class="muted">${new Date(f.time).toLocaleString()}</small></td>
    <td class="actions">
      ${can ? '<button class="iconbtn pv">预览</button>' : ''}
      <button class="iconbtn dl">下载</button>
      <button class="iconbtn del">删除</button>
    </td>`
  tr.querySelector('.fname').textContent = f.name
  if (showPath) tr.querySelector('.path').textContent = '· ' + (f.dir || '根目录') + '/'
  if (can) {
    tr.querySelector('.name').classList.add('clickable')
    tr.querySelector('.name').onclick = () => openPreview(store, f)
    tr.querySelector('.pv').onclick = () => openPreview(store, f)
  }
  tr.querySelector('.dl').onclick = () => downloadFile(f)
  tr.querySelector('.del').onclick = () => { if (confirm(`删除「${f.name}」?所有人都将看不到。`)) store.deleteFile(f.id) }
  return tr
}

function downloadFile(f) {
  const blob = store.getBlob(f.id)
  if (!blob) { alert('文件还在同步中,请稍候再试'); return }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = f.name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

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
      bc.appendChild(Object.assign(document.createElement('span'), { className: 'sep', textContent: '/' }))
      bc.appendChild(crumb(part, acc))
    }
  }
}

function renderChips() {
  const wrap = $('chips'); wrap.innerHTML = ''
  const cats = ['all', 'image', 'video', 'audio', 'doc', 'archive', 'other']
  for (const c of cats) {
    const b = document.createElement('button')
    b.className = 'chip' + (state.cat === c ? ' active' : '')
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
    await store.upload(file, dir, p => setBar((done + p) / files.length))
    done++
  }
  showBar(false)
}

function showBar(on) { $('bar').style.display = on ? 'block' : 'none'; if (!on) setBar(0) }
function setBar(p) { $('bar').firstElementChild.style.width = Math.round(p * 100) + '%' }

// ---------- wiring ----------
function init() {
  initPreview()
  renderChips()

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

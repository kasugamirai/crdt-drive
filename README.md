# CRDT 网盘

一个**没有自建后端**的实时多人网盘:文件本身被当作 CRDT 数据存进一个共享的 Yjs 文档里,通过 WebSocket 在所有访客之间自动同步。打开同一个「网盘名」的人,都能实时看到、上传、下载、删除彼此的文件,并支持文件夹、搜索、分类和在线预览。

> 数据存放在 reearth-flow 的**共享开发版 Y-WebSocket 服务**（`wss://ws.flow.dev.reearth.io`）上。该服务无鉴权、不保证持久化与隐私，仅适合演示 / 学习，请勿上传敏感文件。

---

## 核心原理

### 1. 把"文件"变成"协同数据"

传统网盘 = 前端 + 自建后端（数据库 + 对象存储 + 接口）。

本项目把这一整套换成**一个 CRDT 文档**：

- **CRDT**（Conflict-free Replicated Data Type，无冲突复制数据类型）是一种数据结构，多个副本各自修改后能**自动合并、最终一致**，不需要中心服务器做协调。
- 我们用 [Yjs](https://docs.yjs.dev/)（浏览器端 CRDT 实现，服务端是 Rust 的 `yrs`）。一个 Yjs 文档（`Y.Doc`）里可以放 `Y.Map` / `Y.Array` 等共享类型，任何客户端改了它，改动会同步给所有连着同一文档的人。

所以**"上传文件"在这里 = 往共享 `Y.Map` 里写数据**，"看到别人的文件" = 监听这个 Map 的变化。

### 2. 连接：复用现成的 Y-WebSocket 服务

文档的同步靠一个 Y-WebSocket 服务中转。本项目直接复用了 reearth-flow（一个开源 ETL 工具，源码 https://github.com/reearth/reearth-flow ）的协同服务：

```
wss://ws.flow.dev.reearth.io/<doc_id>?token=<任意值>
```

- `<doc_id>`（路径参数）= 房间号 = 我们的"网盘名"。同一个 doc_id 的人共享同一份文档。
- `token`（query 参数）该服务端**不做校验**，传任意值即可连上。
- 协议是标准的 **Yjs sync protocol**：客户端连上后服务端先发 `SyncStep1`（携带它的状态向量），双方交换增量更新，达到一致。

> 这个地址是从前端运行时配置 `https://flow.dev.reearth.io/reearth_config.json` 的 `websocket` 字段拿到的，并用 `y-websocket` 实测连通、跑通过端到端往返（见 `verify-netdisk.mjs`）。

### 3. 数据模型

共享文档里有三个顶层 `Y.Map`：

| Y.Map   | 键                | 值                                                   | 作用 |
|---------|-------------------|------------------------------------------------------|------|
| `files` | 文件 id（uuid）   | `{ name, size, type, time, chunks, dir }`            | 文件元数据 |
| `dirs`  | 文件夹路径        | `{ time }`                                            | 显式文件夹（含空文件夹） |
| `blobs` | `${id}/${块号}`   | `Uint8Array`（每块 64KB）                            | 文件二进制内容，分块存放 |

- **文件夹是"虚"的**：靠文件元数据里的 `dir` 字段（父目录路径，根目录为 `""`）+ `dirs` 集合表达层级，并不存在真正的目录实体。面包屑、子目录都是从这两个 Map 实时算出来的。

### 4. 上传 / 下载流程

**上传**（`store.upload`）：

1. 用 `file.arrayBuffer()` 读出字节，切成 64KB 的块；
2. **每块单独写入** `blobs`（一次写 = 一个很小的 WebSocket 消息，避免单帧过大）；
3. 所有块写完后，**最后**才写 `files` 的元数据。

> 为什么元数据最后写？同一条 WebSocket 连接上消息是**保序**的，所以其他客户端一定先收到全部数据块、再收到元数据。这样别人一旦在列表里看到这个文件，它的内容必然已经齐全，不会下载到半截。

**下载 / 预览**（`store.getBytes`）：按元数据里的 `chunks` 数量，从 `blobs` 取出 `id/0 … id/n-1` 拼回完整 `Uint8Array`，再包成 `Blob` 触发浏览器下载或喂给预览组件。若某块还没同步到，则提示"同步中"。

**删除**：在一个 `doc.transact` 事务里同时删掉元数据和它的所有数据块（删文件夹则递归删除其下所有文件与子目录），同步给所有人。

### 5. 其他特性怎么实现的

- **实时刷新**：`files.observe` / `dirs.observe` 一变就重渲染列表；在线人数靠 Yjs 的 **awareness** 协议统计。
- **搜索**：对 `files` 里全部条目按文件名前端过滤（跨目录），结果带显示所在路径。
- **分类**：根据 MIME 类型 + 扩展名归到 图片/视频/音频/文档/压缩包/其他，做 chips 过滤。
- **在线预览**：按类型把 `Blob` 的 object URL 塞进 `<img>/<video>/<audio>/<iframe>`，文本类直接解码展示（超 512KB 截断）。
- **分享 / 跨标签页**：房间号写进 URL 的 `#room=xxx`，分享链接即同一网盘；`y-websocket` 默认还用 BroadcastChannel 在同浏览器多标签间同步。

### 一图概括

```
浏览器 A ─┐                            ┌─ 浏览器 B
          │   Y.Doc(files/dirs/blobs)  │
          ├──────── wss ───────────────┤
          │   ws.flow.dev.reearth.io   │
浏览器 C ─┘        (yrs 中转/合并)       └─ 浏览器 D

上传 = 往共享 Map 写分块数据  →  CRDT 自动同步  →  所有人实时看到
```

---

## 运行

```bash
npm install
npm run dev       # 开发服务器，自动打开浏览器
npm run build     # 打包到 dist/
npm run preview   # 预览打包结果
```

打开后在「网盘名」里填一个房间号（或用默认），把链接发给别人即可共享同一个网盘。

---

## 工程结构

```
index.html          Vite 入口（纯结构，引用 /src/main.js）
vite.config.js      base:'./'，dev 自动开浏览器
src/
  store.js          CRDT 数据层：Yjs doc + provider，文件/文件夹增删查
  main.js           页面逻辑：导航、搜索、分类、上传、渲染
  preview.js        预览弹窗（图片/视频/音频/PDF/文本）
  util.js           格式化、路径运算、类型分类
  style.css         样式
test-crdt.mjs       CRDT 链接连通性测试（Node）
verify-netdisk.mjs  端到端往返验证：A 上传 → 全新 B 读回，字节一致（Node）
```

验证脚本可单独跑：

```bash
node test-crdt.mjs wss://ws.flow.dev.reearth.io <doc_id> anytoken
node verify-netdisk.mjs
```

---

## 限制与注意

- **共享公开服务**：`wss://ws.flow.dev.reearth.io` 是 reearth-flow 的开发版协同服务，**无鉴权、无隐私、不保证持久化**。任何知道网盘名的人都能读写，别放敏感文件。
- **无单文件大小上限，但有客观成本**：上传时整个文件会先读进内存；且文档存量越大，每个新访客同步时下载越久（CRDT 文档会被全量拉取）。超大文件场景建议改成流式上传 + 按需取块。
- **技术栈**：Vite + 原生 JS（无框架）+ Yjs + y-websocket。

## 致谢

CRDT 协同服务来自开源项目 [reearth/reearth-flow](https://github.com/reearth/reearth-flow)（Rust `yrs` + Y-WebSocket）。

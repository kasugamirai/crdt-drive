# CRDT Drive · 实时协同网盘

一个**无需自建后端**的实时多人网盘:文件被建模为 CRDT 数据,通过 WebSocket 在所有在线用户之间自动、无冲突地同步。打开同一个「网盘名」的人,可实时看到、上传、下载、删除彼此的文件,并支持文件夹、搜索、分类与在线预览。

界面基于 **Vite + Tailwind CSS** 构建,深色质感、响应式布局。

---

## 核心原理

### 1. 把"文件"变成"协同数据"

传统网盘 = 前端 + 一整套后端(数据库 + 对象存储 + 业务接口)。本项目把这套基础设施换成**一个共享的 CRDT 文档**:

- **CRDT**(Conflict-free Replicated Data Type,无冲突复制数据类型)是一种多副本可**自动合并、最终一致**的数据结构,不需要中心服务器做协调或加锁。
- 我们使用 [Yjs](https://docs.yjs.dev/) 作为浏览器端 CRDT 实现。一个 Yjs 文档(`Y.Doc`)里可以放 `Y.Map` / `Y.Array` 等共享类型,任一客户端的修改会自动分发并合并到所有连接同一文档的客户端。

因此在本项目里:**"上传文件" = 往共享 `Y.Map` 写数据;"看到别人的文件" = 监听这个 Map 的变化。** 多人同时操作天然不冲突。

### 2. 实时同步

文档的同步通过一个 **Y-WebSocket 同步服务**中转,走标准的 **Yjs sync protocol**:

```
wss://<同步服务>/<doc_id>
```

- `<doc_id>`(路径参数)= 房间号 = "网盘名"。同一个 `doc_id` 的人共享同一份文档。
- 客户端连上后,服务端先发 `SyncStep1`(携带状态向量),双方交换增量更新直至一致;之后任何改动以增量形式实时广播。
- 同步服务地址在 `src/main.js` 顶部配置,可替换为自有后端。

### 3. 数据模型

共享文档中有三个顶层 `Y.Map`:

| Y.Map   | 键              | 值                                          | 作用 |
|---------|-----------------|---------------------------------------------|------|
| `files` | 文件 id(uuid)  | `{ name, size, type, time, chunks, dir }`   | 文件元数据 |
| `dirs`  | 文件夹路径      | `{ time }`                                   | 显式文件夹(含空文件夹) |
| `blobs` | `${id}/${块号}` | base64 字符串(每块 64KB 原始数据)           | 文件内容,分块存放 |

**文件夹是逻辑层级**:由文件元数据里的 `dir` 字段(父目录路径,根目录为 `""`)+ `dirs` 集合表达,面包屑与子目录均实时计算得出。

### 4. 上传 / 下载流程

**上传**(`store.upload`):

1. `file.arrayBuffer()` 读出字节,切成 64KB 的块;
2. **每块单独写入** `blobs`(一次写 = 一个很小的同步消息,避免单帧过大);
3. 全部块写完后,**最后**才写 `files` 元数据。

> 元数据最后写是关键:同一连接上消息**保序**,所以其他客户端一定先收到全部数据块、再收到元数据。这样别人一旦在列表看到文件,其内容必然已齐全,不会下到半截。

**下载 / 预览**(`store.getBytes`):按元数据的 `chunks` 数,从 `blobs` 取出 `id/0 … id/n-1` 拼回完整 `Uint8Array`,包成 `Blob` 触发下载或喂给预览组件。

**删除**:在一个 `doc.transact` 事务里同时删除元数据与其全部数据块(删文件夹则递归删除其下所有文件与子目录),实时同步给所有人。

### 5. 其他能力的实现

- **实时刷新**:`files.observe` / `dirs.observe` 变化即重渲染;在线人数靠 Yjs 的 **awareness** 协议统计。
- **搜索**:对全部文件按文件名前端过滤(跨目录),结果显示所在路径。
- **分类**:按 MIME 类型 + 扩展名归类为 图片/视频/音频/文档/压缩包/其他,做标签过滤。
- **在线预览**:按类型把 `Blob` 的 object URL 注入 `<img>/<video>/<audio>/<iframe>`,文本类直接解码展示。
- **分享 / 跨标签页**:房间号写入 URL 的 `#room=xxx`,分享链接即同一网盘;`y-websocket` 还通过 BroadcastChannel 在同浏览器多标签间同步。

### 一图概括

```
用户 A ─┐                              ┌─ 用户 B
        │   Y.Doc(files/dirs/blobs)    │
        ├──────────  wss  ─────────────┤
        │     Y-WebSocket 同步服务      │
用户 C ─┘        (CRDT 合并/中转)        └─ 用户 D

上传 = 往共享 Map 写分块数据  →  CRDT 自动同步  →  所有人实时看到
```

---

## 运行

```bash
npm install
npm run dev       # 开发服务器,自动打开浏览器
npm run build     # 打包到 dist/
npm run preview   # 本地预览打包结果
```

打开后在「网盘名」填一个房间号(或用默认),把链接发给他人即可共享同一个网盘。

### 部署(Cloudflare Workers 静态资源)

仓库内置 `wrangler.jsonc`,将 `dist/` 作为静态资源部署:

```bash
npm run build && npx wrangler deploy
```

---

## 工程结构

```
index.html          页面入口(Tailwind 布局,引用 /src/main.js)
vite.config.js      Vite + @tailwindcss/vite
wrangler.jsonc      Cloudflare 静态资源部署配置
src/
  store.js          CRDT 数据层:Yjs doc + provider,文件/文件夹增删查
  main.js           页面逻辑:导航、搜索、分类、上传、渲染
  preview.js        预览弹窗(图片/视频/音频/PDF/文本)
  util.js           格式化、路径运算、类型分类
  style.css         Tailwind 入口与组件类
```

---

## 技术栈

- **前端**:Vite + 原生 JS(无框架)+ Tailwind CSS v4
- **协同**:Yjs(CRDT)+ y-websocket(Yjs sync protocol)
- **部署**:Cloudflare Workers 静态资源

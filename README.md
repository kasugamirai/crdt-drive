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
- 同步服务器可在**网页顶部「同步服务器」下拉框**切换(内置 Test / Dev 预设,也支持自定义 `wss://…`,选择记入 `localStorage`);预设列表与默认值在 `src/main.js` 的 `WS_PRESETS` 配置。

### 3. 数据模型:多房间分片

同步服务的持久化有两个硬性限制,直接决定了存储结构:

1. **不能存二进制**:文档里只要含 `Uint8Array`,重载后整个房间会变空。→ 文件内容一律存成 **base64 字符串**。
2. **单文档持久化总量上限约 12MB(base64)**:超过后重载丢失。

因此一个文件的内容被**切成多个分片(shard),每个分片放在独立的房间(文档)里**,每片控制在上限之内;主"网盘"房间只存很小的元数据。这样**文件列表永远能加载(刷新不再清空)**,大文件则逐片传输。

| 房间 | Y.Map | 键 | 值 |
|------|-------|----|----|
| 主网盘房间 | `files` | 文件 id | `{ enc, size, time, dir, shards }` |
| 主网盘房间 | `dirs`  | 文件夹路径 | `{ time }` |
| 分片房间 `${网盘}::${id}::${k}` | `blobs` | `"块号"` | base64(AES-GCM 密文)(每块 64KB) |

`enc` = 加密后的 `{name, type}`(文件名、类型),`blobs` 里每块内容也都是 AES-GCM 密文 —— **服务器和任何直连文档的人只能看到密文**。详见下方「加密」。

**文件夹是逻辑层级**:由元数据 `dir` 字段(父目录路径,根目录 `""`)+ `dirs` 集合表达,面包屑与子目录实时计算得出。

### 4. 上传 / 下载流程

**上传**(`store.upload`):

1. 文件按 ≤6MB 切成若干分片(每片 ≈8MB base64,稳在 12MB 上限内);
2. **并发上传分片(工作池,默认 20 路并行;`CONCURRENCY` 可调)**:每路连接分片房间 → 写入 64KB 加密块 → **等待发送缓冲清空 + 留时间给服务端持久化** → 断开;
3. 所有分片落盘后,**最后**才往主房间写 `files` 元数据(任一分片失败则不写,不产生残缺文件)。

> 元数据最后写是关键:别人一旦在列表看到文件,其所有分片必然已持久化完成。

**下载 / 预览**(`store.readFile`,异步):读元数据拿到 `shards` 数 → **并发下载分片房间(工作池,默认 20 路并行;同一 `CONCURRENCY`):各自连接 → 同步 → 取块 → 断开** → 结果按序号归位、解密 + 解码拼回完整 `Uint8Array` → 包成 `Blob` 触发下载或喂给预览组件,带进度回调。

**删除**:主房间事务里删元数据(列表即时更新),再后台逐个清空其分片房间。

### 5. 其他能力的实现

- **实时刷新**:`files.observe` / `dirs.observe` 变化即重渲染;在线人数靠 Yjs 的 **awareness** 协议统计。
- **搜索**:对全部文件按文件名前端过滤(跨目录),结果显示所在路径。
- **分类**:按 MIME 类型 + 扩展名归类为 图片/视频/音频/文档/压缩包/其他,做标签过滤。
- **在线预览**:图片 / PDF 把 `Blob` 的 object URL 注入 `<img>/<iframe>`,文本类只取前 512KB 解码展示。
- **边加载边播放(流式)**:视频 / 音频不再整文件下载完才播,而是由一个 **Service Worker**(`public/sw.js`)对外提供 `/__media/<id>` 虚拟地址。`<video>/<audio>` 向它发起带 `Range` 的请求,SW 通过 `MessageChannel` 向页面索要对应字节区间,页面用 `store.readRange()` **只解密命中的那几个分片**(带 8 片 LRU 缓存 + 并发去重)并回以 `206 Partial Content`。于是浏览器原生管线接管:**点开即播、可任意拖动进度条**,任意编码、`moov` 在尾部的 MP4 也能播(它会先 range 取文件尾)。SW 不可用时自动回退到整文件下载预览。
- **分享 / 跨标签页**:房间号写入 URL 的 `#room=xxx`,分享链接即同一网盘;`y-websocket` 还通过 BroadcastChannel 在同浏览器多标签间同步。
- **分享视频/音频在线观看**:视频、音频卡片有 `🔗 分享` 按钮,弹窗里可**选择中转(relay)服务器**,生成 `#watch=<房间>&v=<文件id>&relay=<服务器>` 链接(`watch.js`)。对方打开即进入一个**专门的全屏播放页**:按链接里的 relay 连上该房间 → 等元数据同步 → 走同一套流式播放(`mediaUrl`),即点即看、可拖动进度;无需进网盘界面、也无需手动切换服务器。解密密钥由房间名推导,故有链接即可解密播放。
- **图床(图片)**:图片卡片的 `🔗` 按钮打开图床弹窗,提供两种链接 ——(1)**在线查看链接**(同上的 `#watch` 机制,可选 relay);(2)**图片直链**:把图片读出并生成自包含的 **Data URL**(`data:<mime>;base64,…`),它是一个真正可移植的图片源,能直接贴进任意网页 `<img>`、Markdown、论坛显示,**无需任何服务器**;弹窗一并给出 Markdown / HTML 嵌入代码与一键复制。直链体积约为原图 1.33 倍,过大图片提供「仍要生成」确认。

### 6. 加密(默认开启)

所有文件内容与文件名在**浏览器端写入前就加密**,服务器/任何直连文档的人只能看到密文。

- 算法:**AES-GCM 256**(Web Crypto),每块内容独立随机 IV;文件名/类型加密进元数据的 `enc` 字段。
- 密钥:由 **应用密钥(`src/crypto.js` 的 `APP_SECRET`)+ 房间名** 经 PBKDF2 派生 —— 不同网盘不同密钥,密钥不写入文档、不发往服务器。
- 解密只发生在我们网站运行的代码里:列表加载时异步解出文件名(缓存),下载/预览时解出内容。
- 轮换 `APP_SECRET` 即可使所有历史数据失效。

> 安全模型:应用密钥内置于前端包,用于"只能通过我们网站正常访问"——服务器拿不到明文。若要更强的零知识(连前端包都不含密钥),把密钥放进分享链接的 URL fragment(`#key=…`),它永不到达服务器与构建产物。

### 一图概括

```
              主网盘房间(元数据,小,永久)
用户 A ─┐      files / dirs                  ┌─ 用户 B
        ├──────────────  wss  ───────────────┤
        │        Y-WebSocket 同步服务         │
用户 C ─┘      (CRDT 合并 / 持久化)           └─ 用户 D
              分片房间 ::id::0  ::id::1  …    (各 ≤6MB,大文件内容)

上传/下载 = 主房间存元数据 + 逐个分片房间传内容  →  CRDT 自动同步
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

### dmhy → Flow BT 上传页

打开 `/dmhy.html`：自动抓取 [动漫花园](https://www.dmhy.org/) 最新条目 → **下载 `.torrent` 文件字节** → 用同一套 `Store.upload` 上传到 `wss://ws.flow.plateau.reearth.io`（默认房间 `dmhy-bt`）。开发时由 Vite 中间件、部署时由 `worker.js` 提供 `/api/dmhy/*` 代理以绕过 CORS。可选环境变量见 `VITE_FLOW_TOKEN` / `VITE_DMHY_ROOM` / `VITE_DMHY_LIMIT` / `VITE_DMHY_AUTO`。

---

## 工程结构

```
index.html          页面入口(Tailwind 布局,引用 /src/main.js)
dmhy.html           dmhy BT 抓取并上传到 Flow 的页面
worker.js           Cloudflare Worker：静态资源 + /api/dmhy/* 代理
vite.config.js      Vite + Tailwind + 本地 dmhy 代理
wrangler.jsonc      Cloudflare 部署(Worker + dist assets)
src/
  store.js          CRDT 数据层:Yjs doc + provider,文件/文件夹增删查;readRange 按区间读分片
  main.js           页面逻辑:导航、搜索、分类、上传、渲染
  dmhy.js           dmhy 抓取 / .torrent 下载 / Flow 上传
  dmhy-parse.js     RSS 与 topic 页解析
  preview.js        预览弹窗(图片/视频/音频/PDF/文本),视频/音频走流式播放
  media.js          流式播放页面侧桥:注册 SW、应答字节区间请求、给出 mediaUrl(id)
  watch.js          分享链接全屏播放页:#watch=<房间>&v=<id>,连房间→流式播放
  util.js           格式化、路径运算、类型分类
  style.css         Tailwind 入口与组件类
public/
  sw.js             媒体流 Service Worker:把 /__media/<id> 的 Range 请求转交页面,返回 206
```

---

## 技术栈

- **前端**:Vite + 原生 JS(无框架)+ Tailwind CSS v4
- **协同**:Yjs(CRDT)+ y-websocket(Yjs sync protocol)
- **部署**:Cloudflare Workers 静态资源

# 02b 前端（React/TS）资产清单

> 审计员：`audit-frontend` ｜ 审计对象：`E:\legadoQ-archive\`（只读）｜ 产出路径：`E:\legadoQ\REBUILD_PLAN\_parts\02b_frontend_inventory.md`
> 标注约定：**【事实】**= 有 `文件:行号` 直接证据；**【推断】**= 基于多处证据的推理；**【建议】**= 重建时的取向主张；**【未确认】**= 未能从源码确认。

---

## 0. 审计范围与方法

### 0.1 覆盖口径

| 项 | 数值 | 命令 / 证据 |
|---|---|---|
| 源码根 | `product/web/src/` | — |
| `src/**/*.ts` | 105 | `find src -type f \| sed 's/.*\.//' \| sort \| uniq -c` |
| `src/**/*.tsx` | 94 | 同上 |
| **`src` 合计 `.ts/.tsx`** | **199** | `find src -type f \( -name '*.ts' -o -name '*.tsx' \) \| wc -l` |
| `src` 其它文件 | `styles.css` + `ui/material/glass.css` + `ui/README.md` + `md-raw.d.ts` | `.css`×2 / `.md`×1 / `.d.ts`×1 |
| `test/` 合计文件 | 147（其中 `*.test.ts` **139**，辅助/脚本 **8**） | `ls -1 *.test.ts \| wc -l` |
| `src` 总行数 | **36,973** | `find … -exec wc -l {} + \| tail -1` |

### 0.2 **与任务书的数字冲突（以源码为准）**

> 纪律第 4 条：冲突以源码为准并记录。

| 任务书说法 | 实测 | 结论 |
|---|---|---|
| 「`src` 347 个 .ts/.tsx」 | **199**（`src`），若把 `test/` 的 147 也算进来则 346，加上 `src/md-raw.d.ts` 之外的计数差异正好 ≈347 | 【事实】任务书的 347 实为 **`src` + `test` 合并计数**，不是纯 `src`。本文一律用 **199**（纯源码）。 |
| `ReaderScreen.tsx` ~2346 行 | **2403** 行 | 【事实】已漂移（`wc -l features/reader/ReaderScreen.tsx`）。 |
| `ShelfPage.tsx` ~1240 行 | **943** 行 | 【事实】已漂移；现状比任务书**更小**（已拆过）。 |
| `SourcesPage.tsx` ~933 行 | **933** 行（一致，巧合） | 【事实】 |
| `main.tsx` ~733 行 | **803** 行 | 【事实】漂移。 |
| `lib/api/types.ts` ~932 行 | **956** 行 | 【事实】漂移。 |
| `openccData.ts` 239KB 数据文件 | **244,601 字节 / 120 行** | 【事实】行数少是因为单行超长；只判断用途，未读内容（见 §8.5）。 |

### 0.3 方法

- 只读操作：`ls` / `find` / `wc` / `grep` / `sed -n 'A,Bp'`（40–120 行窗口）/ `git log`。**未运行** `npm install` / build / test / dev server。
- 未知路径先用 `grep -rn` 定位行号，再读窗口；巨型文件（`ReaderScreen.tsx` / `ShelfPage.tsx` / `SourcesPage.tsx` / `main.tsx` / `lib/api/types.ts`）**无一处整篇读取**。
- 禁读区一律未触碰：`node_modules/**`、`dist/**`、`product/data/**`、`docs/archive/**`、`**/build/**`。
- 后端交叉验证只读了 `product/app/src/main/kotlin/io/legado/` 下 4 个片段（`data/SourcesDao.kt`、`data/SourceHealthDao.kt`、`http/SourcesRoutes.kt` 的 grep、`model/` grep），用于判定「前后端两份实现」。

---

## 1. 目录与模块清单

### 1.1 顶层分布【事实】

```
src/
├── main.tsx            803 行  组合根：App 组件 + 全部单例浮层 + 深链
├── icons.tsx           (icons 集)
├── md-raw.d.ts         (?raw 导入类型声明)
├── styles.css        6,757 行  唯一全局样式表
├── app/          2 文件  AppHeader.tsx / pages.tsx（页面切换表）
├── components/  22 文件  跨 feature 共用组件（Modal / Select / Toast …）
├── features/    96 文件  6 个子域
│   ├── reader/        72  ← 最热区
│   ├── source-editor/ 10
│   ├── settings/       5
│   ├── bookshelf/      5
│   ├── rss/            3
│   └── explore/        1
├── lib/         50 文件  shared：API 客户端 + 20 余个自研 store/纯函数
├── lib/api/             client.ts / index.ts / types.ts / domains/×7
├── plugins/     15 文件  扩展槽 + 5 个插件页
├── ui/          10 文件  设计内核（color / material / motion / theme）
└── i18n/         1 文件  zh.ts（19 行）
```

证据：`for d in */; do find … | wc -l`；`find . -type d`。

### 1.2 各模块职责与关键导出

| 模块 | 文件数 | 职责【事实】 | 关键导出（`file:line`） |
|---|---|---|---|
| `app/pages.tsx` | 2 | 页面 → 组件映射表（替代 router） | `renderPage(page, ctx)` `app/pages.tsx:43`；`PageContext` `:23` |
| `app/AppHeader.tsx` | 352 行 | 顶栏：品牌字、一级导航、菜单 | 见 `lib/pageMeta.ts:42` 的 `PRIMARY_PAGES` 消费 |
| `components/` | 22 | 跨 feature 共用；含 22 个自研弹层/控件 | `Select`（305 行，自研下拉+虚拟滚动）、`ContextMenu`、`Toast`、`PageDialog`、`SourceSwitchModal`、`SourceChoiceList` |
| `features/reader/` | 72 | 阅读器整屏态：正文渲染 / 分页 / TTS / 漫画 / 笔记 / 目录 / 设置 | `ReaderScreen`（状态中枢）、6 个 `useReader*` hook、`content/` 纯函数目录 |
| `features/source-editor/` | 10 | 书源列表/编辑器/登录/体检/调试流 | `SourcesPage`(933)、`SourceLoginModal`(737)、`SourceHealthModal`(625)、`sourceHealthRun`(291) |
| `features/bookshelf/` | 5 | 书架 / 书库 / 书籍管理 | `ShelfPage`(943)、`LibraryPage`(416)、`shelfPaging` |
| `features/settings/` | 5 | 设置页壳 + 分区表 + Cookie/Wallpaper 大区块 | `SettingsPage`、`settingsSections`（分区数据权威源） |
| `features/rss/` | 3 | RSS 与订阅 | `RssPanel`(403)、`SourceSubscriptionPanel` |
| `features/explore/` | 1 | 发现页 | `ExplorePage`(287) |
| `lib/api/` | 10 | **唯一 HTTP 出口** | `request()` `lib/api/client.ts:43`；`api` 门面 136 个方法 `lib/api/index.ts:129` |
| `lib/` 其它 | 40 | 自研 store + 领域纯函数（**业务逻辑主要藏身处**） | `searchStore`、`offlineStorage`、`sourceInspector`、`sourceGrouping`… |
| `plugins/` | 15 | Extension/Slot 机制 + 5 个插件（about/changelog/backup/reading-log/source-health） | `extensionRegistry`、`slotRegistry`、`attachmentStore`、`ExtensionSlot` |
| `ui/` | 10 | 设计内核：38 个 M3 角色、弹簧动效、玻璃材质 | `ui/index.ts:1-35`（**唯一对外门面**，35 行） |
| `i18n/` | 1 | 单语言字符串表 | `zh` `i18n/zh.ts:18`（**全表只有 1 个键**） |

---

## 2. 页面与路由

### 2.1 有没有 router 库？**【事实】没有**

- `product/web/package.json` 的 `dependencies` 只有 6 项：`@material/material-color-utilities`、`@vitejs/plugin-react`、`hls.js`、`react`、`react-dom`、`typescript`、`vite`。**无** `react-router` / `wouter` / `@tanstack/router`。
- 证据：`product/web/package.json:20-26`（dependencies 全文）。

### 2.2 路由实现：`hash` + 纯数据表 + `renderPage` 三件套

| 环节 | 实现 | 证据 |
|---|---|---|
| 路由唯一真源 | `PAGES: PageMeta[]`（7 条，纯数据、零 React 依赖） | `lib/pageMeta.ts:31-39` |
| hash → 页面 | `pageFromHash()`，认不出就回 `'library'`（"深链写错不该白屏"） | `lib/pageMeta.ts:47-49` |
| 页面 → 组件 | `renderPage(page, ctx)` 的 `switch` | `app/pages.tsx:43-83` |
| 当前页状态 | `const [page, setPage] = useState<Page>(pageFromHash)` | `main.tsx:148` |
| 编程式跳转 | `navigate(next)`：**同时写** `location.hash` **和** `setPage` | `main.tsx:439-444` |
| 前进/后退 | 只有一条 `hashchange` 监听，内部再分派「深链→浮层」或「换页」 | `main.tsx:447-465` |
| 浮层深链兼容 | `MODAL_DEEP_LINKS`（4 条老链接 → `AppModal`） | `main.tsx:69-74` |

**页面数：7 个路由（6 个一级 + 阅读器整屏）**【事实】

| key | 顶栏 | primary | 组件 | 证据 |
|---|---|---|---|---|
| `library` 书库 | ✓ | ✓ | `LibraryPage` | `lib/pageMeta.ts:32`；`app/pages.tsx:76` |
| `shelf` 书架 | ✓ | ✓ | `ShelfPage` | `:33`；`app/pages.tsx:60` |
| `sources` 书源 | ✓ | ✓ | `SourcesPage` | `:34`；`app/pages.tsx:47` |
| `explore` 发现 | ✓ | ✓ | `ExplorePage` | `:35`；`app/pages.tsx:69` |
| `subscriptions` 订阅 | ✓ | ✓ | `RssPage` | `:36`；`app/pages.tsx:55` |
| `settings` 设置 | ✓ | ✓ | `SettingsPage` | `:37`；`app/pages.tsx:57` |
| `reader` 阅读 | ✗ | ✗ | `ReaderScreen`（整屏） | `:38`；`main.tsx:715` 之外由 `reader` state 驱动 |

### 2.3 第二层"页面"：21 个单例浮层

- `AppModal` 联合类型共 **21** 个字面量，`lib/nav.ts:12-50`。
- 同一时刻只开一个，由 `const [openModal, setOpenModal] = useState<AppModal | null>` 承载（`main.tsx:274`），渲染为 14 条 `openModal === '…'` 分支（`main.tsx:738-764`）。
- 另有 1 个 `PageDialogKind = 'rules'`（"不占导航栏也不占整页"，`lib/nav.ts:5`）。
- **设计意图（有注释）**：「加新弹窗往这里加一个字面量，不必再加一个 useState」`lib/nav.ts:7`。

### 2.4 内部"页中页"（未进路由）：**建议**重建时收敛

| 现状 | 证据 |
|---|---|
| 书源的「详情/编辑/登录/体检/分组/分享/调试」全是浮层，不是子路由，**深链不可达、刷新即回列表** | `features/source-editor/` 下 6 个 `*Modal.tsx` + `SourcesPage.tsx` |
| 阅读器内部的「设置抽屉 / TOC 抽屉 / 其它设置」用 `activeDrawer: 'toc'\|'settings'\|'other'\|null` 单 state 表达 | `ReaderScreen.tsx:134` |
| 设置页面的二级编辑器"回到原来的编辑器，实现仍然只有一份" | `features/settings/settingsSections.ts:1-30`（注释明示） |

---

## 3. 状态管理全景

### 3.1 用了什么？**【事实】零第三方状态库**

`package.json` 无 `zustand` / `redux` / `jotai` / `recoil` / `react-query` / `swr`（`product/web/package.json:20-37` 全文核对）。

实际是 **4 种自研模式并存**：

| 模式 | 机制 | 代表 | 证据 |
|---|---|---|---|
| A. `useSyncExternalStore` + 模块级单例 | 类 store：`listeners: Set<() => void>` + `getSnapshot` | `SearchStore` | `lib/searchStore.ts:182-205`、`:525-540` |
| B. 裸模块变量 + `emit()` | 更轻量，只有 get/set/subscribe 三函数 | `selectionStore`、`brandStore`、`readerProgress`、`dynamicTheme`、`sourceFocus` | `lib/selectionStore.ts:38-53`；`lib/brandStore.ts:25-49`；`reader/content/readerProgress.ts:17-38`；`ui/theme/store.ts:63-85`；`lib/sourceFocus.ts:7-15` |
| C. `useState` 上提 + props 下传 | 组合根持有，页面通过 `PageContext` 拿回调 | 阅读器开关、`page`、`openModal` | `main.tsx:148/264/274/288/323`；`app/pages.tsx:23-42`（`PageContext`） |
| D. localStorage/sessionStorage/IndexedDB 直读 | 无 store 层，模块自带 `read*/write*` | 书架布局、侧栏宽、阅读设置、离线缓存 | `lib/shelfLayout.ts:43-54`；`lib/sidebarWidth.ts:18-45`；`readerSettings.ts:192/673`；`lib/offlineStorage.ts:38-50` |

### 3.2 store 全表

| store（`file:line`） | 管什么 | 写入方 | 读取方 | 是否重复维护同一状态 |
|---|---|---|---|---|
| `lib/searchStore.ts:182` `SearchStore`（571 行） | 搜索会话：结果、分组、源选择状态（`SourceChoiceStatus`）、在途请求 | `searchStore` 内部方法（`main.tsx` / `ShelfPage` / `ExplorePage` 触发 `streamSearch`） | `useSearchStore` `:527`、`useSearchSlice` `:568`（书架/发现/阅读器搜书） | **否**（搜索状态确实只有一份，做得最好） |
| `lib/selectionStore.ts:38` 模块变量 | 阅读器划词选区（≤2000 字，`MAX_SELECTION` `:36`） | `setSelection` `:62`、`setSelectionFromDraft` `:68` | `getSelection` / `subscribeSelection`（`ReaderOverlays` 的标注菜单） | 否 |
| `lib/offlineStorage.ts`（551 行） | IndexedDB `legado_offline_db`（v2）章节缓存 + `legado_shelf_snapshot` + `legado_offline_progress_queue` | `putOfflineChapter` `:98`、`enqueueOfflineProgress` `:447`、`saveShelfSnapshot` `:408` | `getOfflineChapter` `:148`、`getOfflineStorageStats` `:285`、`flushOfflineProgress` `:462`（`main.tsx:335` 上线时刷） | **是**：进度队列 → `api.saveProgress`（见 §3.3） |
| `lib/brandStore.ts:25` 模块变量 | 站点显示名 / 内置名 / 图标 / themeColor | `reportBrand` `:42`（`main.tsx:406-414` 启动拉一次） | 顶栏、`document.title`（`ReaderScreen.tsx:422` 注释明示"名字读单一来源"） | 否（注释记录过"硬编码把新名字冲回去"的旧 bug） |
| `ui/theme/store.ts:63` `dynamicTheme` | 封面取色算出的 M3 主题（`origin: 'cover'\|'wallpaper'`） | `setDynamicTheme` `:89`、`clearDynamicTheme` `:107` | `main.tsx:181-230`（三 effect 接线） | **是**：与「皮肤」系统叠加（见 §3.3） |
| `features/reader/content/readerProgress.ts:17` `snapshot` | 底栏进度条：`{chapterIndex,total,fraction}`，**每帧**变 | `reportProgress` `:30`（`ReaderScreen.tsx:1777/1740` 等处） | `subscribeProgress` `:20`、`overallProgress` `:41` | **是**：与 `chapterIndex` state、服务端进度三处并存 |
| `features/source-editor/sourceHealthRun.ts:82` `HealthRunState` | 书源批量体检运行态（`HEALTH_CHUNK=128` `:20`、baseline `:27`） | `startHealthRun` `:182`、`stopHealthRun` `:270`、`dropHealthResults` `:287` | `useHealthRun` `:121`（`SourceHealthModal`） | 与 `lib/sourceInspector.ts` 的**逐源体检**并存（两套机制） |
| `lib/sourceFocus.ts:7` `pendingSourceFocus` | 一次性"跳到某个书源"的意图 | `setPendingSourceFocus` `:10` | `takePendingSourceFocus` `:15` | 否（典型的跨页 intent 传递，设计合理） |
| `lib/uiPrefs.ts:50` `UI_PREF_STORAGE` | localStorage↔服务端偏好对齐（**因为 localStorage 按 origin 隔离，换端口就丢**） | `pushUiPref` `:126`（防抖 600ms） | `hydrateUiPrefs` `:106`（**React 渲染前**补回） | 否，但它是"重复维护"的**补丁**而不是解法（注释 `lib/uiPrefs.ts:5-7` 自陈根因） |
| `lib/selectionStore` 之外的 `lib/shelfLayout.ts:86/101` | 书架布局 / 排序（`SEARCH_KEY`、`SORT_KEY`） | `writeShelfLayout` `:52` | `readShelfLayout` `:43` | 与 `shelfLayout` 服务端镜像并存（`:72` 注释"同步到服务端"） |
| `lib/sidebarWidth.ts:18` `SIDEBAR_WIDTH_KEY` | 书源侧栏拖拽宽 | `:41` | `:29` | 同上，也上行服务端（`:45`） |
| `main.tsx:161` `sessionStorage['legado-open-book-v1']` | 当前打开的书（刷新活下来） | `main.tsx` reader 状态 | 启动恢复 | **是**：`ShelfPage` 的 `items[].chapterIndex` 是另一份 |

### 3.3 **跨页面重复维护的同一状态（重建重点）**

| 状态 | 并存份数 | 各处证据 | 冲突风险【推断】 |
|---|---|---|---|
| **阅读进度** | **4** | ① `ReaderScreen.tsx:815-826` `persist()` → `api.saveProgress`（直写服务端）② `lib/offlineStorage.ts:447` 离线队列 → `main.tsx:335-339` 上线补写 ③ `readerProgress.ts:17` 内存 store（UI 用）④ `ShelfPage.tsx:356` 自己重算 `((chapterIndex??0)+1)/Math.max(1,totalChapters\|\|1)` | 两套写路径无排序保证；④ 的分母在后端 `BookshelfItem` 里**不存在 `progress` 字段**（`lib/api/types.ts:212-236` 全字段核对，后端 `model/BookshelfModels.kt` grep `progress` 无命中） |
| **主题/皮肤** | **3** | ① `readerSettings.theme` + `customSkins` + `builtinSkinOverrides`（7 套内置在 `styles.css`，`readerSettings.ts:20/193`）② `ui/theme/store.ts` 封面取色的 M3 覆盖层 ③ `brandStore.themeColor`（`lib/api/types.ts:57`）→ `<meta theme-color>` | `main.tsx:185-230` 里注释自陈「两个 effect 抢同一份状态」且「以前无条件 clear 会把壁纸取色那层一起扫掉」 |
| **当前书 / 打开的书** | **3** | ① `main.tsx:161` reader/sessionStorage ② `ReaderScreen.tsx:70` `currentBook` 本地 state（**可被换源改写** `setCurrentBook`）③ `ShelfPage` items | 换源后"当前书"的身份（`bookUrl` 变了）与书架条目如何对齐，未见统一约定【未确认】 |
| **localStorage 偏好** | 2 套语义 | 本机 `localStorage` vs 服务端 UI 偏好（`lib/uiPrefs.ts`） | `uiPrefs` 白名单 10 项（`lib/uiPrefs.ts:20-31`）**已含** `reader-settings`/`shelf-layout`/`shelf-sort`/`sidebar-width`/`wallpaper`/`tts-bar-position`/`search-history`/`agreement`/`pwa-banner`/`search-layout`。**不在**白名单的：`lib/offlineStorage` 的章节缓存与书架快照、`ui/theme` 的动态主题（`lib/uiPrefs.ts:44-48` 注释明示"不收录"）→ 这几类换端口仍会丢，且是**有意为之** |
| **书架快照** | 2 | `offlineStorage.saveShelfSnapshot` `:408` vs `api.shelfGroups`/`bookshelf.list` | 离线快照无版本/时间戳校验（`:421` 仅 `JSON.parse` 兜错） |

---

## 4. API 调用层与类型契约

### 4.1 是否唯一出口？**结论：几乎是，且有可验证的窄口** 【事实】

分层：

```
业务代码
  └── api.<method>()            lib/api/index.ts:129   （136 个方法门面，含 streamSearch）
        └── domains/*.ts        lib/api/domains/*.ts（7 个域文件）
              └── request<T>()  lib/api/client.ts:43  （4 个变体：request/requestText/requestBlob/requestArrayBuffer :43/53/62/71）
                    └── fetchWithMetrics()  lib/performance.ts:204   ← 唯一真实 fetch
```

**`fetch(` 全仓计数（`src` 内）：2 处，其中 1 处就是闸门本身**

| 位置 | 性质 |
|---|---|
| `lib/performance.ts:204` | **闸门自身**（性能采集 + 超时 + signal 合并）。所有请求经此。 |
| `main.tsx:373` | `fetch('/healthz')` —— **唯一业务级裸 fetch**，启动探活循环（含 `AbortController` 超时）。绕过 client.ts，但 `/healthz` 不属业务 API。 |

其它传输通道（同样非 fetch，但都在 domain 层封装）：
- `WebSocket`：`lib/api/index.ts:98`、`lib/api/domains/search.ts:39`（`/api/search/stream`，**两处重复实现**）
- `EventSource`：`features/source-editor/SourceDebugModal.tsx:41`（`api.debugStreamUrl`）、`features/reader/tts/ttsEngine.ts:455`（TTS 音频流）

**绕过 domain 层、直接 import `client.ts` 的 3 处**（仍在闸门内，但破坏"域"封装）：

| 文件 | 说明 |
|---|---|
| `lib/cookieApi.ts` | Cookie 域未进 `domains/`，独立成文件 |
| `lib/fontLibrary.ts` | 字体上传/下载（3–5MB 二进制，ArrayBuffer 路径） |
| `plugins/backup/BackupPage.tsx` | **插件页直接调 HTTP**（插件层穿透 lib 层，边界问题） |

调用量：`domains/*` 内 `request*` 共 **135** 处；`api` 门面 **136** 个键，逐键 `grep "api\.<key>"` 无一处「零调用」【事实】。

### 4.2 类型契约：**手写，非生成** 【事实】

`lib/api/types.ts:1-5` 原注释（逐字）：

> 「前后端契约类型：与后端 `resources/agent-api.json` / Kotlin 模型保持一致。
> 书源字段的增删在后端契约中修改，**应通过构建流程自动生成此文件**，消除手动同步漂移。
> **目前先手动维护**，待契约生成脚本接入后再迁出至 `generated/`。」

- 文件 **956 行**，是前端第 2 大文件；无 generator 标注、无 `DO NOT EDIT` 标记、无 `codegen` 配置（`grep -n "generated\|DO NOT EDIT\|自动生成\|codegen" lib/api/types.ts` 只命中上述注释本身）。
- 后端契约文件为 `product/app/src/main/resources/agent-api.json`（144 端点口径，与任务书/AGENTS.md §4 一致）。
- `lib/api.ts`（4 行）只是旧路径别名：`export * from './api/index'`，注释标 `@deprecated`（`lib/api.ts:1-4`）。

### 4.3 与后端 DTO 是否一一对应？**部分不对应** 【事实 + 推断】

| 检查点 | 结果 | 证据 |
|---|---|---|
| `BookshelfItem` | 前端**多字段**、后端 `BookshelfModels.kt` grep `progress` **零命中**：进度是前端算的 | `lib/api/types.ts:212-236`；后端 grep |
| `AboutInfo.ai` | 前端仍留 `ai?: boolean` 并注释「2026-11-17 起产品默认关」 | `lib/api/types.ts:41` |
| `AppModal` 里 7 个 `ai-*` 字面量 | 前端类型仍有、`main.tsx` **无渲染分支** → 死类型 | `lib/nav.ts:35-48` vs `main.tsx:738-764` |
| 端点覆盖 | 后端 `agent-api.json` 声明 **145** 条 `path`（去重后 **101** 条路径，任务书口径 144 端点）vs 前端门面 136 键 | 见 §4.4 逐条核对 |

### 4.4 「后端有、前端没入口」逐条核对（本轮已确认部分）

方法（可复现）：把 `agent-api.json` 的 `path` 抽出 → 去 `{…}` 参数段、折叠 `//` → 101 条唯一路径 → 逐条 `grep -rF` 到 `web/src`。

> **口径警告**：参数化路径（`/api/sources/{id}/login-ui` 等 23 条）前端用模板字符串拼（`/api/sources/${encodeURIComponent(id)}/login-ui`），字面 grep 会全判"缺失"。这 23 条**已核实大部分在用**（`lib/api/domains/sources.ts:195-271` 的 `sourceBrowser` 段就是这样拼的），因此下面只列**不带参数**的真缺失。

| 缺失端点 | 方法 | 后端用途（`agent-api.json` 原文） | 判定 |
|---|---|---|---|
| `/api/books/content-process` | POST / DELETE | 「AI 闭环：落一份『AI 净化/润色覆盖正文』，下一次读这一章就回覆盖版」/「撤掉某一章的 AI 覆盖」 | 【事实】前端 0 引用 —— **AI 配套端点，主树前端已无入口**（与 `150949a` 搬走 AI 一致） |
| `/api/books/local/asset` | GET | 「取本机书（EPUB 那类）里内嵌的一张图/一个资源」 | 【事实】前端 0 引用 —— **本机 EPUB 内嵌图走不通**【推断】前端改用 `bookImage`/`bookMedia` 代理族，此处是后端预留 |
| `/api/replace-rules/export` | GET | 「导出规则（不给 id 就是全部）」 | 【事实】前端 0 引用 —— 只有导入路径（`ReplaceRulesModal.tsx`），**导出规则没有按钮** |
| `/api/sources/{id}/browser/submit` | GET / POST | 「以 GET/POST 方式提交登录表单……门是 session 令牌 t」 | 【事实】前端 `sourceBrowser` 段（`lib/api/domains/sources.ts:193-271`）有 session/cookies/page/inline/external-login，**唯独没有 submit** → 内置浏览器登录表单提交无前端入口 |

**「有界面、但后端无对应持久化/无对应能力」**

| 界面能力 | 后端状况 | 证据 |
|---|---|---|
| 自定义皮肤库（每套含**完整 CSS**）、内置皮肤改名/换 CSS | **实际会传到服务端**（`pushUiPref('reader-settings')` 推整份 settings 到 `/api/ui-prefs/reader-settings`），但 `readerSettings.ts:91` 的注释说「全部只存 localStorage …… 不上传服务端，也不进备份包」→ **注释与源码冲突，以源码为准** | `readerSettings.ts:758-764`（`saveReaderSettings`）+ `lib/api/domains/prefs.ts:19-25` + `lib/uiPrefs.ts:26`；冲突点 `readerSettings.ts:76`、`:91`、`:166`（三处均称"不上传服务端"） |
| 阅读背景预设（`ReaderBackground`，颜色+图片+压暗） | 同上，随 `reader-settings` 整份上传 | `readerSettings.ts:70-84` |
| 书架「按进度排序」 | 后端 `BookshelfItem` **无 `progress` 字段**，进度由前端算 | `ShelfPage.tsx:356`；`lib/api/types.ts:212-236` |
| 书源体检的逐本 VIP/正文判定 | 后端只存取结论（`SourceHealthDao.kt:16/48`），判定逻辑在浏览器 | §8.2 |
| 点按区（TapMap）编辑 | 存在 `readerSettings.tapZones` 里 → 随 `reader-settings` 上传，无独立端点 | `readerSettings.ts:178`、`:232`、`:719-720` |
| 离线正文缓存 / 书架快照 | 纯 IndexedDB，后端无对应（**有意设计**） | `lib/offlineStorage.ts:38-50`；`lib/uiPrefs.ts:44-48` |

---

## 5. UI 体系 / 主题 / i18n

### 5.1 有没有自研组件库？**【事实】半成品：有设计内核，没有组件库**

| 层 | 有无 | 证据 |
|---|---|---|
| 设计 token（颜色） | **有**，可计算 | `ui/color/scheme.ts:39` `COLOR_ROLES` = **38 个 M3 语义角色**，7 种 `ThemeVariant`；依赖 `@material/material-color-utilities`（`package.json:21`） |
| 旧皮肤桥接 | **有** | `ui/color/legacy.ts:118` 行，`LEGACY_VARS` 17 个变量 → `skinCss()` |
| 动效 token | **有** | `ui/motion/spring.ts`（253 行）`SPRINGS` / `springVars()` |
| 材质 token | **有** | `ui/material/glass.ts`（201 行）+ `glass.css`（182 行） |
| **组件库** | **无** | `components/` 是 22 个**各自实现**的组件：31 个文件各自写一套 `*-backdrop` 弹层（§7.2）；`Select.tsx` 305 行自研下拉是唯一的"通用控件"，只被 10 个文件使用 |
| 门面纪律 | **有** | `ui/index.ts`（35 行）是唯一入口，`ui/README.md:1-30` 明确「`ui/**` 禁止 import `features/` `components/` `app/` `plugins/` `lib/api/`」，且由 `test/ArchitectureBoundary.test.ts` 守 |

### 5.2 样式体系：**6,757 行单文件全局 CSS**

| 项 | 数值 | 证据 |
|---|---|---|
| `styles.css` | **6,757 行** | `wc -l src/styles.css` |
| 另一份 CSS | `ui/material/glass.css` 182 行 | — |
| CSS 自定义属性（去重） | **84 个** | `grep -o "\-\-[a-z0-9-]*:" styles.css \| sort -u \| wc -l` |
| 内联 style 对象 | **101 处** `style={{…}}` | `grep -rn "style={{" --include=*.tsx \| wc -l` |
| 无 CSS Modules / CSS-in-JS | 无 `.module.css`，无 styled-components/emotion | `find . -name '*.module.css'` 空；`package.json` 无相关依赖 |

`ui/README.md:3-4` 自陈目标：「把『颜色 / 动效 / 材质』三件目前散落在 **6,600 行** `styles.css` 里的硬编码，收成可计算、可测试、可替换的纯数据层」——**迁移尚未完成**，两边并存。

### 5.3 主题系统：3 套并存（见 §3.3）

| 系统 | 载体 | 生效方式 | 证据 |
|---|---|---|---|
| ① 内置 7 套皮肤 | `styles.css` 里的 `.theme-<id>` | 类名挂在 `<main>` | `readerSettings.ts:20` `BuiltinSkinId = 'light'\|'paper'\|'dark'\|'qingzhu'\|'mulan'\|'meigui'\|'shimo'`；`colored themeClassNames(settings)` `ReaderScreen.tsx:2241` |
| ② 用户自定义皮肤库 | `readerSettings.customSkins: CustomSkin[]`（id + name + **完整 CSS**） | `main.tsx:87-108` `SkinStyle`：`document.createElement('style')` + `textContent`（**故意不用 `dangerouslySetInnerHTML`**，注释解释 `</style>` 注入风险） | `readerSettings.ts:50-69`；`main.tsx:80-108` |
| ③ 封面取色 M3 覆盖层 | `ui/theme/store.ts` + `applyDynamicTheme` | 重写 `<style>`，`origin: 'cover'\|'wallpaper'` 区分来源 | `ui/theme/types.ts:16`；`main.tsx:181-230` |
| 存储键 | `legado-reader-settings-v2`（回落到 `-v1`）、`legado-dynamic-theme-v1`（动态主题，**混淆键名**）、`sessionStorage['legado-open-book-v1']` | — | `readerSettings.ts:192/673`；`ui/theme/store.ts:18`；`main.tsx:59` |

### 5.4 i18n：**1 种语言、1 个键、24 个文件引用** 【事实】

| 指标 | 数值 | 证据 |
|---|---|---|
| 支持语言 | **1**（中文），源码中无 `locale` 参数、无 `en.ts` | `find src/i18n -type f` → 只有 `zh.ts` |
| 已抽取字符串 | **1 个键**（`common.close`） | `i18n/zh.ts:18-21` |
| 引用文件数 | **24** | `grep -rln "from '.*i18n"` |
| 覆盖率 | **<1%**【推断】 | `i18n/zh.ts:13-15` 注释自陈：「分批推进：**本批只收**『跨文件真重复』的通用标签（如 overlay 的『关闭』，15 处同一串）。各组件里那些只出现一次的文案，按页/组件在后续批次陆续搬进来」 |
| 设计取向【事实】 | **不是为翻译，是为去重 + tsc 拦错键** | `i18n/zh.ts:4-9`：「这台服务目前只有中文、没有第二语言在计划里，抽字典的价值是去重与单一来源……以后真要第二语言，再在这份结构上叠一个 locale 参数即可」 |

【建议】重建时不要把 i18n 当"已具备能力"；它只是**字符串常量化的一小步**。若未来确定单语言，直接删掉 `i18n/`、把文案就地内联更诚实；若要多语言，现有结构（分组对象 + 属性访问）**不能直接复用**（无插值、无复数、无 fallback），需换方案。

---

## 6. 阅读器子系统专项

### 6.1 分工现状【事实】：72 文件，已抽出 **7 个 hook** + **6 个展示组件** + **5 个纯函数目录**（`content/` `interaction/` `notes/` `tts/` `settingsPanel/`），但中枢仍 2,403 行

| 层 | 文件 | 行数 | 职责 |
|---|---|---|---|
| **中枢** | `ReaderScreen.tsx` | **2,403** | 见 §6.2 |
| 展示组件 | `ReaderBody.tsx` / `ReaderOverlays.tsx` / `ReaderChrome.tsx` | 296 / 238 / 218 | 正文本体 / 12 个浮层槽 / 外壳（+`Md3Chrome` 131） |
| 其它展示 | `ReaderCatalog` 149、`ReaderHeader` 72、`ReaderSheet` 39、`VirtualChapterList` 172、`ReaderContentSkeleton` 26、`NoteHighlights` 47、`IconButton` 9 | — | — |
| 状态 hook | `useReaderChapterContent` 136 / `useReaderCacheStatus` 139 / `usePaginationMeasurement` 190 / `useReaderPageTurn` 77 / `useReadingLog` 46 / `useReaderNotes` 193 / `useReaderPositionJump` 120 | 901 | 见下方签名 |
| 纯函数·内容 | `content/`：`readerFlow` 199、`logicalPosition` 142、`mangaPages` 86、`virtualSlice` 87、`scriptConvert` 147、`chunkedRender` 32、`readerProgress` 44、`mediaKind` 56、`paragraphs` 19、`contentImages` 23、`readerImage` 16、`fontSizeControl` 19 | 870 | 可单测 |
| 纯函数·交互 | `interaction/`：`tapZones` 213、`readerInteractions` 240、`shortcuts` 119、`readerMenu` 58、`pageTurn` 59 | 689 | 可单测 |
| 纯函数·笔记 | `notes/`：`reanchor` 121、`bookmark` 58、`noteExport` 107、`noteFilter` 18 | 304 | 可单测 |
| TTS 子系统 | `tts/`：`ttsEngine` 638、`useReaderTts` 369、`TtsSettingsModal` 364、`ReaderTtsManager` 233、`ttsBarPosition` 209、`TtsPlayerBar` 160、`ttsTextProcessor` 145、`ReaderTtsContext` 28 | 2,146 | **自成一域，规模超过很多独立 feature** |
| 设置面板 | `settingsPanel/`：`readerSettings` 769、`SkinModal` 437、`BackgroundLibrary` 224、`TypographyTab` 145、`backupPreferences` 144、`ColorTab` 138、`OtherSettingsPanel` 131、`ReaderSettingsSheet` 122、`BehaviorTab` 55、`SettingRow` 45、`ReaderSettingsControls` 56 | 2,266 | 设置状态 + UI 挤在同一目录 |
| 字典数据 | `dict/openccData.ts`（244,601 B / 120 行） | — | **纯数据，动态 import**（`content/scriptConvert.ts` 使用），未读内容 |

已抽出 hook 的入参/出参（`grep "export function"`）：

| hook | 签名要点 |
|---|---|
| `useReaderChapterContent` `useReaderChapterContent.ts:32` | 返回 `scrollPosition / charOffset / paragraphAnchor / positionChecksum / progress` 类型 |
| `useReaderNotes` `useReaderNotes.ts:33` | 入参 `{currentBook, bookName, chapter, content, paragraphStarts, positionChecksum, chapterIndex}` |
| `useReaderPositionJump` `useReaderPositionJump.ts:39` | 导航原语：`jumpToNote` / `jumpToSearchHit` / `jumpToNotePosition`（AGENTS.md §3 明确"要看跳转原语来这里，别回 ReaderScreen"） |
| `usePaginationMeasurement` `usePaginationMeasurement.ts:37` | 分页测量（190 行，最重的 hook） |
| `useReaderCacheStatus` `useReaderCacheStatus.ts:28` | 缓存状态 + `error` |
| `useReaderPageTurn` `useReaderPageTurn.ts:21` | `{pageMode, pageAnim, pageIndex, setPageIndex}` |
| `useReadingLog` `useReadingLog.ts:20` | `{sourceId, bookUrl, bookName, chapterIndex}` |

### 6.2 `ReaderScreen.tsx` 职责拆解【事实】

**规模证据**：2,403 行；`useState` **34 处**、`useEffect` **27 处**、`useCallback` **20 处**、`useMemo` **9 处**、`useRef` **11 处**（`grep -c` 各自口径）。

**34 个 state 分类表**

| 类别 | state（行号） | 数量 |
|---|---|---|
| 书籍/章节身份 | `currentBook`(70)、`chapterIndex`(130)、`flowKey`(107) | 3 |
| 正文内容与分块 | `flowTail`(101)、`flowHead`(125)、`renderLimit`(485)、`pageIndex`(168) | 4 |
| 脚本/繁简转换 | `convert`(85) | 1 |
| 目录规则 | `tocRuleOptions`(96) | 1 |
| 抽屉/工具条/全屏 | `activeDrawer`(134)、`tapZoneEditing`(136)、`toolbarsVisible`(137)、`isFullscreen`(150)、`settingsTab`(633) | 5 |
| 弹层开关 | `showSourceSwitch`(149)、`showReplaceRules`(160)、`offlineStatsModal`(161)、`showRefreshChapters`(162)、`bookSearchOpen`(626)、`reviewsOpen`(628) | 6 |
| 提示/状态字 | `boundaryMessage`(147)、`remainingSeconds`(148)、`slowLoad`(1376)、`searchFlash`(630) | 4 |
| 离线同步 | `localSyncing`(163)、`localSyncProgress`(164) | 2 |
| 图片/灯箱 | `lightboxSrc`(435)、`imageGeneration`(444)、`failedImages`(445) | 3 |
| 漫画 | `mangaIndex`(519) | 1 |
| 布局测量 | `viewportWidth`(520)、`readingLeft`(2102) | 2 |
| 刻度拖动 | `scrubIndex`(464) | 1 |
| 一次性 UI 版本 | `uiV2`(139) | 1 |

**27 个 effect 分类表（含行号区间）**

| 类别 | 行号 | 干什么 |
|---|---|---|
| 繁简转换加载 | `86-92` | `loadScriptConverter(settings.scriptMode)` |
| 全屏监听 | `151-154` | `fullscreenchange` |
| 目录规则拉取 | `320-324` | 本地书首开拉 `api.tocRules()` |
| 文档标题 | `422-429` | 从 `brandStore` 读名字写 `document.title` |
| 分块渲染 | `489`、`495-503` | `setRenderLimit(CHUNK_SIZE)`；`IntersectionObserver` 补块 |
| 视口变化 | `521-524` | `resize` → `setViewportWidth` |
| 漫画预取 | `537-…`、`605-…` | 预取下一屏图片；退出漫画复位 |
| 搜索高亮自清 | `810-814` | 6 秒后 `setSearchFlash(null)` |
| 滚动翻页（滚轮） | `1147-…`、`1668-…` | **两个各自独立的滚轮处理 effect**（不同模式） |
| 慢加载提示 | `1377-1385` | 8 秒后 `setSlowLoad(true)` |
| 跨章续接 | `1389-…` | 非文本章不续接（音频/视频/文件） |
| 分页测量/上报 | `1740-…`、`1767-…` | 分母口径"这一章有几页" |
| 漫画进度上报 | `1777-…` | `mangaFraction` |
| TTS 收尾 | `1795-1798` | 卸载时 `stopAllEngines()` |
| TTS 自动续章 | `1800-1808` | `autoPlayNextChapterRef` |
| TTS 定时器 | `1810-…` | 睡眠定时 |
| MediaSession | `1832-1851` | 锁屏控制 |
| WakeLock | `1853-1868` | 朗读时保持屏幕 |
| TTS 跟读滚动 | `1870-1893` | 按段补块 + 滚动 |
| 边界提示定时器清理 | `1895` | — |
| **全局快捷键** | `1898-2009` | 111 行，键盘表 |
| Ctrl+滚轮字号 | `2011-…` | — |
| 点按区测量 | `2103-…` | `tapZoneEditing` 时测 `readingLeft` |

**渲染结构（已成分层）**：`ReaderScreen.tsx:2241` `<main class="reader-workspace theme-…">` → `:2243 <ReaderChrome>` → `:2305 <ReaderBody>` → `:2343-2352` **旧移动底栏 `!uiV2 && <nav className="mobile-reader-nav">`**（注释自陈与新 MD3 底栏三层重叠）→ `:2355 <ReaderOverlays dialogs={…12 个} actions={…22 个回调}>`。

### 6.3 哪些已抽出、哪些仍是中枢耦合

| 已抽出 ✅ | 证据 |
|---|---|
| 笔记状态 + 增删改 | `useReaderNotes.ts`（193 行） |
| 跳转原语 | `useReaderPositionJump.ts`（120 行） |
| 分页测量 | `usePaginationMeasurement.ts`（190 行） |
| 章节内容装载 | `useReaderChapterContent.ts` |
| 缓存状态 | `useReaderCacheStatus.ts` |
| 点按区 / 菜单 / 快捷键（纯函数） | `interaction/tapZones.ts`、`readerMenu.ts`、`shortcuts.ts` |
| 正文/浮层/外壳 | `ReaderBody` / `ReaderOverlays` / `ReaderChrome` |

| 仍是中枢耦合 ❌ | 证据 / 理由 |
|---|---|
| **书签** | `toggleBookmark` 仍在 `ReaderScreen.tsx`（AGENTS.md §3 明确"本轮留原地降风险"） |
| **进度上报+持久化** | `persist()` 定义在 `ReaderScreen.tsx:815-826`；调用点在多个 effect 内 |
| **TTS 编排** | `useReaderTts` 虽已抽出，但 Provider 由 `ReaderScreen` 自己发（`ReaderScreen.tsx:2241 <TtsContext.Provider>`），注释说明之所以这样是因为"父组件读不到子组件的 Context"（`ReaderScreen.tsx:830-840`）—— **架构债现状记录** |
| **漫画分屏/预取** | state `mangaIndex`(519) + 2 个 effect(537/605) 在屏内 |
| **图片生成/失败/灯箱** | 3 个 state(435/444/445)，无独立 hook |
| **全屏/WakeLock/MediaSession** | 3 个 effect 直接操作浏览器 API |
| **离线整本下载** | `localSyncing`(163) / `localSyncProgress`(164) 在屏内 |
| **目录规则选项** | `tocRuleOptions`(96) + effect(320) |
| **34 个 state 全部在同一个组件内**，无 reducer、无分组 context | `grep "useState" ReaderScreen.tsx` |

---

## 7. 巨型组件与重复组件

### 7.1 >500 行文件清单（`wc -l` 降序；`src` 内共 **16** 个）【事实】

> 口径：`find src -exec wc -l {} + | awk '$1>500'`。**注意**：前一轮统计曾把 478/456/437/433/417/416/406/403 行的文件误计入"巨型"，已更正为 **16**。

| # | 行数 | 文件 | 性质 |
|---|---|---|---|
| 1 | 2,403 | `features/reader/ReaderScreen.tsx` | 阅读器中枢 |
| 2 | 956 | `lib/api/types.ts` | 手写契约类型 |
| 3 | 943 | `features/bookshelf/ShelfPage.tsx` | 书架页 |
| 4 | 933 | `features/source-editor/SourcesPage.tsx` | 书源页 |
| 5 | 803 | `main.tsx` | 组合根 |
| 6 | 769 | `features/reader/settingsPanel/readerSettings.ts` | 设置状态+序列化 |
| 7 | 737 | `features/source-editor/SourceLoginModal.tsx` | 书源登录 |
| 8 | 727 | `components/ReplaceRulesModal.tsx` | 替换规则 |
| 9 | 693 | `features/source-editor/bookSourceFields.ts` | 书源字段表 |
| 10 | 638 | `features/reader/tts/ttsEngine.ts` | TTS 引擎 |

> 完整 16 项见上表。**接近但未过线**（400–500 行，重建时同属"拆"的对象）：`lib/api/domains/reader.ts` 478、`lib/sourceInspector.ts` 456、`settingsPanel/SkinModal.tsx` 437、`features/settings/CookieSection.tsx` 433、`components/BookDetailModal.tsx` 417、`features/bookshelf/LibraryPage.tsx` 416、`plugins/backup/BackupPage.tsx` 406、`features/rss/RssPanel.tsx` 403。

**分布特征**【推断】：16 个巨型文件里 **10 个是 `.tsx`（UI）**、**6 个是 `.ts`（状态/数据/逻辑）**。即"大文件"不只在 UI，`lib/` 也在长胖（`searchStore` 571、`offlineStorage` 551、`sourceInspector` 456）。这说明重建要拆的不只是组件。

### 7.2 重复组件：**31 处各自实现弹层**【事实】

`grep -rln "modal-backdrop\|overlay-backdrop\|dialog-backdrop\|sheet-backdrop" --include=*.tsx` → **31 个文件**。全部清单：

```
app/AppHeader.tsx                                          components/{BookDetailModal, BrandModal, FirstRunAgreement,
components/LogsModal, OfflineCacheModal, PageDialog,         ReplaceRulesModal, ServerPortModal, SourceSwitchModal,
TocRulesModal}                                            features/bookshelf/{BookInfoEditModal, BookManageModal}
features/reader/{ReaderOverlays, ReaderSheet}              features/reader/dialogs/{BookSearchDialog, RefreshChaptersModal}
features/reader/interaction/ShortcutHelp                    features/reader/reviews/ChapterReviewsDialog
features/reader/settingsPanel/SkinModal                     features/reader/tts/{ReaderTtsManager, TtsSettingsModal}
features/rss/RssPanel                                       features/settings/{CookieSection, WallpaperModal}
features/source-editor/{SourceDebugModal, SourceGroupModal,  SourceHealthModal, SourceLoginModal,
                        SourceLoginUiPanel, SourceShareModal}
```

**部分共享化已经发生，但不彻底**：

| 共享件 | 使用文件数 | 结论 |
|---|---|---|
| `lib/useFocusTrap.ts` | **12** | 31→12，**19 个弹层没有焦点陷阱**（a11y 缺口） |
| `lib/useEscapeClose.ts` | **31** | Esc 已全覆盖（与 31 个弹层数一致），但"关闭"以外仍各写各的 |
| `lib/overlayGeometry.ts`（`OVERLAY_EDGE` / `clampOverlay`） | **2** | 夹视口算法只被 `Select.tsx:4` 等复用，右键菜单等仍在各写 |
| `components/PageDialog.tsx` | 1（只 `main.tsx:734` 用） | 有通用壳，但**没被推广** |
| `components/Select.tsx`（305 行，自研下拉+虚拟滚动+过滤框） | 10 | 唯一的成功抽象 |

**功能重叠的其他簇**：

| 簇 | 成员 | 重叠点【推断】 |
|---|---|---|
| **书源选择** | `components/SourceSwitchModal.tsx`(548) + `components/SourceChoiceList.tsx` + `components/BookDetailModal.tsx` | 三处都在渲染"可切换的书源列表 + 体检徽章"（`SourceChoiceList.tsx:129` `health-checking` 徽章） |
| **书籍详/管/编辑** | `components/BookDetailModal.tsx`(417) + `features/bookshelf/BookManageModal.tsx` + `features/bookshelf/BookInfoEditModal.tsx` | 三个弹层都在编辑同一本 `BookshelfItem` |
| **书源体检** | `lib/sourceInspector.ts`(456，逐本) + `features/source-editor/sourceHealthRun.ts`(291，批量) + `SourceHealthModal.tsx`(625) + `plugins/source-health/SourceHealthModalEntry.tsx` | **两套体检机制**（§8.2） |
| **搜索流** | `lib/api/index.ts:98` 与 `lib/api/domains/search.ts:39` | **同一个 `/api/search/stream` WebSocket 两处实现** |
| **阅读器底栏** | `ReaderScreen.tsx:2343` 旧 `mobile-reader-nav` vs `Md3Chrome` 的 `.md3-bottombar` | 注释自陈"三层叠在一起" |
| **写端口的偏好** | `lib/shelfLayout.ts:72`、`lib/sidebarWidth.ts:45`、`lib/uiPrefs.ts` | 三套"localStorage + 上行服务端"的相似代码 |

---

## 8. 业务逻辑泄漏清单

### 8.1 分组标签词表：**前后端两份，靠测试锁死**【事实】

| 侧 | 位置 | 内容 |
|---|---|---|
| 前端 | `lib/sourceGrouping.ts:18-23` `HEALTH_TAGS` | `good:'体检可用'`、`pending:'体检待确认'`、`unconfigured:'未配搜索'`、`bad:'体检异常'` |
| 后端 | `data/SourcesDao.kt:361-362` `HEALTH_GROUP_TAGS` | `listOf("体检可用","体检待确认","未配搜索","体检异常")` |
| 防漂移判据 | `test/HealthTagVocabulary.test.ts:23-41` | **读 Kotlin 源文件、正则抽出字面量、与前端数组 `deepEqual`** |

后端注释自陈（`data/SourcesDao.kt:357-360`）：
> 「体检标签的词表。**必须与前端 `web/src/lib/sourceGrouping.ts` 的 `HEALTH_TAGS` 逐字一致** —— 那边负责打标签，这边负责在导入覆盖分组时把它们捞回来。」

前端还额外把 `statusCategory` 字符串分类成档位（`lib/sourceGrouping.ts:36-40` `tierOf`），且 `GOOD`/`BAD`/`UNCONFIGURED` 三个集合（`:26-35`）是对**后端枚举值的硬编码副本**。

【推断】这是"同一份领域知识在两处实现 + 一个测试当胶水"的典型形态。**重建时必须把词表和 tier 映射收到后端**，前端只消费。

### 8.2 书源体检：**前端自己跑完全部探测与判定**（最重的泄漏）【事实】

- 前端 `lib/sourceInspector.ts`（**456 行**）完整实现：拉详情 → 拉目录 → 抽章 → 拉正文 → 评分 → 判 VIP，`inspectSingleSource` `:186`、并发调度 `inspectAllSourcesConcurrently` `:384`。
- 前端内嵌**领域启发式规则常量**：
  - `VIP_DETECTION_REGEX` `lib/sourceInspector.ts:33`（20+ 个中文短语正则）
  - `NON_MAIN_CHAPTER_TITLE_REGEX` `:36`（请假/感言/番外说明…）
  - `NOTICE_CONTENT_REGEX` `:39`
  - `MIN_LEGITIMATE_CHAPTER_LENGTH = 450` `:42`
  - `VIP_DROP_RATIO_THRESHOLD = 0.35` `:43`
  - `findMainChapter` `:54`、`inspectChapterContent` `:82`
- **同时后端也有一条体检通道**：`http/SourcesRoutes.kt:250-258` `post("/sources/health-check")` → `repositoryFor(call).healthCheck(req)`；后端 `data/SourceHealthDao.kt` 只负责存取（100 行，`saveHealthResults` `:16`、`listHealthResults` `:48`）。
- 前端**两条都用了**：`features/source-editor/sourceHealthRun.ts:213` 调 `api.healthCheckSources(chunk, 5000)`（后端批量）；`components/BookDetailModal.tsx:10` 又用 `inspectAllSourcesConcurrently`（前端逐本）。
- 后果【推断】：**N+1 个 HTTP 往返从浏览器打向后端**（每本书 × 每源 × 抽章数），且启发式阈值调一次要改 TS。

【建议】重建时把 `sourceInspector.ts` 整份移到后端 `rules/` 或 `data/`，前端只保留"进度显示 + 结果排序"。

### 8.3 阅读进度计算：前端 2 套公式【事实】

| 公式 | 位置 |
|---|---|
| 章内比例（滚动=滚动比，分页=`pageIndex/(pageCount-1)`） | `reader/content/readerProgress.ts:41-44` `overallProgress`；`ReaderScreen.tsx:1769` |
| 书架排序用"章序号/总章数" | `features/bookshelf/ShelfPage.tsx:356` `((chapterIndex ?? 0) + 1) / Math.max(1, totalChapters \|\| 1)` |
| 后端**不提供** `progress` 字段 | `lib/api/types.ts:212-236` `BookshelfItem` 无该字段；后端 grep `progress` in `BookshelfModels.kt` / `BookshelfRepository.kt` **零命中** |

### 8.4 章节筛选/排序与"正文章节"判定：前端判【事实】

- `findMainChapter(chapters, preferredIndex)` `lib/sourceInspector.ts:54` —— 「哪一章才是正文」是**规则引擎级**判断，却在前端。
- `ShelfPage.tsx:357-363` 排序：`name`/`author`/`progress`/`lastReadAt`，用 `localeCompare(…, 'zh-CN')`（`:359-360`）—— 中文排序规则写死在前端。
- `lib/sourceOrder.ts`、`lib/dragSort.ts` + `lib/dragSortMath.ts`：书源拖拽排序的数学在客户端。

### 8.5 规则预览解析 / 脚本转换 / TTS 分段【事实】

| 领域逻辑 | 位置 | 说明 |
|---|---|---|
| 规则预览 | `lib/api/domains/reader.ts:371` `replaceRules` 域含 `preview`（`api.previewReplaceRule`，`lib/api/index.ts` 内）；**预览执行在后端，前端只渲染** | 这条**没有泄漏**（正面案例） |
| 规则解析/校验 | `lib/sourceInspector.ts` 之外，`features/source-editor/bookSourceFields.ts`（**693 行**）是书源字段表的**前端权威**：字段名、类型、默认值、分组 | 【推断】书源 JSON schema 的单一真源在前端，后端 `SourceModels.kt` 是另一份 |
| 简繁转换 | `features/reader/content/scriptConvert.ts`(147) + `dict/openccData.ts`（244KB 数据，注释 `:1-14` 说明"自动生成、别手改、只在开了简繁转换时动态载入"） | 数据合法地在前端（纯转换表），**但转换逻辑也在前端** |
| TTS 分段 | `features/reader/tts/ttsTextProcessor.ts`(145)：`cleanTextForSpeech` `:34`、`splitSentences` `:55`、`processChapterForTts` `:81` → `TtsParagraph`/`TtsChunk` `:9/:16` | **中文断句规则在浏览器**。后端另有 `tts/TtsSessionService.kt`（AGENTS.md §8.4）管理会话；两边如何分工未逐行核【未确认】 |
| TTS 引擎 | `tts/ttsEngine.ts`(638) 直连 `EventSource`(`:455`)，含 `TtsEngineType = 'webSpeech'\|'edge'\|'custom'`（`readerSettings.ts:40`） | 三引擎切换逻辑在前端 |
| 漫画分页 | `content/mangaPages.ts`(86) `mangaFraction` | 双页对开/单页对 LTR/RTL 的排版决策在前端 |

---

## 9. 前端测试资产

### 9.1 规模与结构【事实】

| 指标 | 数值 | 证据 |
|---|---|---|
| `test/` 文件总数 | **147** | `ls -1 \| wc -l` |
| `*.test.ts` | **139** | `ls -1 *.test.ts \| wc -l` |
| 非测试辅助/脚本 | **8** | `discover.ts`、`run-all.ts`、`run-locks.ts`、`perfCriteria.ts`、`capture-review-screenshots.ts`、`e2e-browser-stress.ts`、`e2e-local-book-browser.ts`、`e2e-source-batch-health.ts` |
| Runner | **自研**：`tsx test/run-all.ts`（**不是 vitest**） | `product/web/package.json:15` |
| 扫描方式 | **扫目录不手抄清单** | `test/run-all.ts:1-30`；`discover.ts` |
| 防"假绿"闸 | 扫出 <60 份直接 `exit 1` | `test/run-all.ts:18-21` |

### 9.2 覆盖什么 / 漏什么

**覆盖：90 / 199 个 `src` 文件被测试直接 import（45.2%）**【事实】
（方法：`grep -rho "from '\.\./src/[^']*'" test/*.test.ts` → 解析扩展名 → `comm`）

按类型分：

| 测试类型 | 数量 | 代表 | 说明 |
|---|---|---|---|
| **静态源码判据**（`fs.readFileSync` 读源码文本后断言） | **88 / 139** | `ArchitectureBoundary.test.ts`、`NamingConventions.test.ts`、`HealthTagVocabulary.test.ts`、`UiContract.test.ts`、`SourceTextReads.test.ts` | 守"分层/命名/词表一致/不许出现某写法"。**这是本仓最有特色的资产** |
| 纯函数单测 | 约 35 | `ChunkedRender`、`LogicalPosition`、`MangaPages`、`TapZones`、`PageTurn`、`Reanchor`、`DragSortMath`、`TtsTextProcessor`、`ui/color/*`、`ui/motion/spring` | 质量高、跑得快 |
| 组件渲染（`react-dom/server`） | **15** | `ReaderScreenSmoke`、`SettingsPage`、`HeaderMenu`、`ChapterReviews`、`ReplaceRulesModal`、`VirtualChapterList`、`TtsEngineSwitch`、`Wallpaper`、`ErrorBoundary`、`Changelog`、`CustomizeSkin`、`Shortcuts`、`backup-page`、`mediaKind`、`tap-zone-editor` | 只有 smoke 级，不是交互测试 |
| 集成/后端契约 | 少数 | `api-client.test.ts`、`ApiCatalog.test.ts`、`source-login.test.ts`、`source-batch-health.test.ts` | — |
| e2e（需真实浏览器、不进默认 runner） | 3 | `e2e-browser-stress.ts`、`e2e-local-book-browser.ts`、`e2e-source-batch-health.ts` | `package.json:19` `test:e2e` |

**漏（109 个未被任何测试 import 的文件）**—— 关键缺失清单：

| 未覆盖的核心资产 | 行数 | 风险【推断】 |
|---|---|---|
| `main.tsx`（组合根：路由/深链/13 个 effect） | 803 | **前端最该有测试的文件**，零覆盖 |
| `app/pages.tsx`（路由分派表） | 83 | 加错分支 = 白屏 |
| `features/bookshelf/ShelfPage.tsx` | 943 | 书架全流程 |
| `features/source-editor/SourcesPage.tsx` | 933 | 书源全流程 |
| `features/source-editor/SourceEditorPanel.tsx` | 579 | 书源编辑器 |
| `features/source-editor/bookSourceFields.ts` | 693 | **书源 schema 前端真源** |
| `features/reader/` 全部 6 个 `useReader*` hook + `usePaginationMeasurement` | 901 | 抽出来的 hook **没有一份有测试** |
| `features/reader/ReaderBody/Overlays/Chrome/Catalog` | 296/238/218/149 | 阅读器展示层 |
| `lib/api/domains/*`（7 个）+ `lib/api/index.ts` + `lib/api/types.ts` | 1,049 | 契约层零单测 |
| `lib/bookType.ts`、`lib/selectionStore.ts`、`lib/brandStore.ts`、`lib/fontLibrary.ts`、`lib/scrollProgress.ts`、`lib/agreement.ts` | — | 纯函数也没测 |
| `plugins/**` 全部（ExtensionSlot / extensionRegistry / slotRegistry / attachmentStore） | — | **扩展机制零覆盖** |
| `components/` 中 16/22：`BookDetailModal`、`BrandModal`、`ContextMenu`、`Cover`、`Select`、`SourceChoiceList`、`TocRulesModal`、`PageDialog`… | — | 通用控件不可回归 |

**"漏"的结构性原因**【推断】：139 份测试里 88 份是"读源码文本"判据 —— 它们能守架构/命名/词表，**天然覆盖不到运行时行为**；而仅有的 15 份渲染测试只到 `renderToString` smoke（不触发交互、不 mock fetch）。

---

## 10. 证据索引表

| ID | 结论 | 证据（相对 `E:\legadoQ-archive\`） |
|---|---|---|
| E-0-1 | 无第三方状态/路由库 | `product/web/package.json:20-37` |
| E-1-1 | `src` 199 个 .ts/.tsx，36,973 行 | `find src -type f \( -name '*.ts' -o -name '*.tsx' \) \| wc -l`；`wc -l` 汇总 |
| E-1-2 | 目录文件数分布 | `for d in */; do find … \| wc -l`（features 96 / lib 50 / components 22 / plugins 15 / ui 10 / app 2 / i18n 1） |
| E-2-1 | 7 条路由 + 元数据单真源 | `product/web/src/lib/pageMeta.ts:31-49` |
| E-2-2 | 页面→组件 switch | `product/web/src/app/pages.tsx:43-83` |
| E-2-3 | `navigate` 同时写 hash 与 state | `product/web/src/main.tsx:439-444` |
| E-2-4 | hashchange 单监听 + 深链浮层 | `product/web/src/main.tsx:69-74`、`:447-465` |
| E-2-5 | 21 个 `AppModal` 字面量 | `product/web/src/lib/nav.ts:12-50` |
| E-2-6 | 只渲染 14 个，7 个 `ai-*` 死类型 | `product/web/src/main.tsx:738-764`（无 `ai` 分支） |
| E-2-7 | AI 前端已搬走（提交记录） | `git log`: `150949a refactor(web): 前端 AI 也一并搬走 —— 主树不再有 AI 代码` |
| E-3-1 | `SearchStore` 类实现 | `product/web/src/lib/searchStore.ts:182-205`、`:525-540` |
| E-3-2 | 裸模块变量 store 模式 | `product/web/src/lib/selectionStore.ts:38-53`；`lib/brandStore.ts:25-49`；`lib/sourceFocus.ts:7-15` |
| E-3-3 | 每帧进度用外部 store 的理由 | `product/web/src/features/reader/content/readerProgress.ts:1-7`、`:17-38` |
| E-3-4 | localStorage 按 origin 隔离 → 需要 uiPrefs 补丁 | `product/web/src/lib/uiPrefs.ts:5-7`、`:50`、`:106`、`:126` |
| E-3-5 | 进度 4 份 + 2 条写路径 | `ReaderScreen.tsx:815-826`；`lib/offlineStorage.ts:447`；`main.tsx:335-339`；`ShelfPage.tsx:356` |
| E-3-6 | "两个 effect 抢同一份状态" | `product/web/src/main.tsx:190-193` |
| E-4-1 | 唯一 fetch 闸门 | `product/web/src/lib/performance.ts:204`；`lib/api/client.ts:15-41` |
| E-4-2 | 唯一业务裸 fetch（/healthz） | `product/web/src/main.tsx:373` |
| E-4-3 | 4 个 request 变体 | `product/web/src/lib/api/client.ts:43/53/62/71` |
| E-4-4 | 门面 136 方法 | `product/web/src/lib/api/index.ts:129-…` |
| E-4-5 | 绕过 domain 的 3 处 | `lib/cookieApi.ts`；`lib/fontLibrary.ts`；`plugins/backup/BackupPage.tsx` |
| E-4-6 | 类型手写、非生成 | `product/web/src/lib/api/types.ts:1-5` |
| E-4-7 | `/api/search/stream` 双实现 | `lib/api/index.ts:98` vs `lib/api/domains/search.ts:39` |
| E-4-8 | 4 条后端端点前端 0 引用 | `grep -rF` 到 `web/src` 全空：`/api/books/content-process`、`/api/books/local/asset`、`/api/replace-rules/export`、`/api/sources/{id}/browser/submit`（后端见 `agent-api.json:1004-1025 / 1336-1344 / 937-945 / 514-534`） |
| E-4-9 | 注释称"不上传服务端"但实际上传 | `readerSettings.ts:758-764`（`pushUiPref`）vs `readerSettings.ts:76/91/166`（注释）；`lib/api/domains/prefs.ts:19-25` |
| E-5-1 | `ui/` 门面 35 行 + 分层纪律 | `product/web/src/ui/index.ts:1-35`；`ui/README.md:1-30` |
| E-5-2 | 38 个 M3 角色 | `product/web/src/ui/color/scheme.ts:39` |
| E-5-3 | 6,757 行全局 CSS / 84 个 CSS 变量 | `wc -l src/styles.css`；`grep -o "\-\-[a-z0-9-]*:" src/styles.css \| sort -u \| wc -l` |
| E-5-4 | i18n 只有 1 个键 | `product/web/src/i18n/zh.ts:13-21` |
| E-5-5 | 7 套内置皮肤 + 自定义皮肤库 | `product/web/src/features/reader/settingsPanel/readerSettings.ts:20`、`:50-69`、`:94-98` |
| E-5-6 | 用户 CSS 用 textContent 注入（安全） | `product/web/src/main.tsx:87-108` |
| E-6-1 | ReaderScreen 2,403 行 / 34 state / 27 effect | `wc -l`；`grep -c "useState<\|useState("`；`grep -c "useEffect("` |
| E-6-2 | 已抽 hook 列表 | `features/reader/useReader{PositionJump,Notes,ChapterContent,CacheStatus,PageTurn}.ts`、`usePaginationMeasurement.ts`、`useReadingLog.ts` |
| E-6-3 | TTS Provider 由 ReaderScreen 发（架构债） | `product/web/src/features/reader/ReaderScreen.tsx:830-840`、`:2241` |
| E-6-4 | 旧移动底栏与 MD3 底栏重叠 | `product/web/src/features/reader/ReaderScreen.tsx:2343-2352` |
| E-7-1 | 16 个 >500 行文件 | `find src -exec wc -l {} + \| awk '$1>500'`（16 行） |
| E-7-2 | 31 处自实现弹层 | `grep -rln "modal-backdrop\|overlay-backdrop\|dialog-backdrop\|sheet-backdrop" --include=*.tsx`（31） |
| E-7-3 | 焦点陷阱只覆盖 12 个 / Esc 覆盖 31 个 | `grep -rln useFocusTrap --include=*.tsx`（12）；`grep -rln useEscapeClose`（31） |
| E-8-1 | 前端 `HEALTH_TAGS` | `product/web/src/lib/sourceGrouping.ts:18-23`、`:26-40` |
| E-8-2 | 后端 `HEALTH_GROUP_TAGS` + 逐字一致要求 | `product/app/src/main/kotlin/io/legado/data/SourcesDao.kt:357-362` |
| E-8-3 | 词表防漂移判据 | `product/web/test/HealthTagVocabulary.test.ts:23-41` |
| E-8-4 | 前端体检全流程 + VIP/正文启发式 | `product/web/src/lib/sourceInspector.ts:33-43`、`:54`、`:82`、`:186`、`:384` |
| E-8-5 | 后端也有 `/sources/health-check`（只存取） | `product/app/src/main/kotlin/io/legado/http/SourcesRoutes.kt:250-258`；`data/SourceHealthDao.kt:16/48` |
| E-8-6 | 前端两条体检路径并存 | `features/source-editor/sourceHealthRun.ts:213`；`components/BookDetailModal.tsx:10` |
| E-8-7 | 书架进度前端算 | `product/web/src/features/bookshelf/ShelfPage.tsx:356-363`；`lib/api/types.ts:212-236` |
| E-8-8 | 书源字段表 693 行在前端 | `product/web/src/features/source-editor/bookSourceFields.ts` |
| E-8-9 | 简繁转换表自动生成、动态载入 | `product/web/src/features/reader/dict/openccData.ts:1-14`（244,601 B） |
| E-8-10 | TTS 中文断句在前端 | `product/web/src/features/reader/tts/ttsTextProcessor.ts:34/55/81` |
| E-9-1 | 自研 runner 扫目录 | `product/web/test/run-all.ts:1-30`；`test/discover.ts` |
| E-9-2 | 139 个 *.test.ts / 88 个用 readFileSync | `ls -1 *.test.ts \| wc -l`；`grep -l readFileSync *.test.ts \| wc -l` |
| E-9-3 | 覆盖率 90/199 | `grep -rho "from '\.\./src/[^']*'" test/*.test.ts` → `comm` 比对 |
| E-9-4 | 15 个 renderToString 渲染测试 | `grep -l "renderToString\|react-dom/server" *.test.ts` |

---

## 11. 未确认事项

| # | 事项 | 为什么没确认 | 建议怎么确认 |
|---|---|---|---|
| U-1 | ~~后端端点中具体哪几条前端没有入口~~ **已部分闭环**（见 §4.4）：4 条不带参端点确认为 0 引用（`/api/books/content-process`、`/api/books/local/asset`、`/api/replace-rules/export`、`/api/sources/{id}/browser/submit`）。**剩余未确认**：23 条参数化路径因前端用模板拼接，逐条人工核对未做完 | 字面 grep 无法判定模板拼接路径 | 用后端路由文件反查每个 `post(`/`get(` 是否被 `lib/api/domains/*` 覆盖；或补一份"端点 ↔ 客户端方法"映射测试（这才是治本做法） |
| U-1b | **注释与源码冲突**：`readerSettings.ts` 三处注释称自定义皮肤/背景/内置改名"不上传服务端、不进备份包"，但 `saveReaderSettings` 实际 `pushUiPref('reader-settings')` 把整份 settings（含 `customSkins[].css`）推到 `/api/ui-prefs/reader-settings` | 已按纪律 4 以源码为准记录（§4.4） | 重建时明确"外观配置是否跨端"的产品决定，再二选一：删掉上传 或 改掉注释 |
| U-2 | `bookSourceFields.ts`（693 行）与后端 `SourceModels.kt` 的字段集是否一致 | 需读完两份大文件字段表并 diff；超出本次窗口纪律 | 抽字段名做集合 diff（`grep -o '"[a-zA-Z]*":'`） |
| U-3 | TTS 前端 `ttsEngine.ts` 与后端 `tts/TtsSessionService.kt` 的职责边界 | 只读了前端 EventSource 调用点 | 读 `TtsRoutes.kt` + `TtsSessionService.kt` 的会话生命周期 |
| U-4 | 换源后「当前书」身份如何与书架条目对齐 | `setCurrentBook` 在 ReaderScreen 内，能否回写书架未见统一路径 | grep `setCurrentBook` 全部分支 + 后端 `saveProgress` 的 `bookUrl` 语义 |
| U-5 | `styles.css` 6,757 行里真正的**设计 token 断言**覆盖率 | 只统计了 84 个 CSS 变量与 101 处内联 style，没做"硬编码色值"扫描 | `grep -oE "#[0-9a-fA-F]{3,8}" styles.css \| sort \| uniq -c \| sort -rn` |
| U-6 | 是否有未提交/并行 agent 的半成品 | 只 `git log` 读了 8 条 | `git status`（纪律要求动手前先看，本次审计只读，未执行） |
| U-7 | e2e 三脚本实际能跑通否 | 禁止运行 | 由主控在环境内实跑 |
| U-8 | `plugins/` 的 Extension/Slot 机制**是否有任何实际插件在用** | `ExtensionSlot` 只被 `ReaderChrome.tsx` 引用 1 处 | grep `attach(` / `registerExtension(` 的调用点 |

---

## 12. 覆盖率声明

**已分析 N / 共 199**

| 深度 | 数量 | 占 199 | 说明 |
|---|---|---|---|
| **A. 结构级**（列入清单、计行数、按目录归类、导出名 grep） | **199 / 199（100%）** | 100% | 每个文件都跑过 `find`/`wc -l`，`lib/`+`reader/`+`api/` 全部 `grep "^export"` |
| **B. 内容窗口级**（读了 40–120 行正文片段，用于下结论） | **约 42 / 199（21%）** | — | 见下表 |
| **C. 整篇读取** | **0**（巨型文件全部 0 整篇） | 0% | 遵守纪律 5 |

**B 类具体清单（42）**：
`main.tsx`(803，5 段窗口)、`app/pages.tsx`、`lib/nav.ts`、`lib/pageMeta.ts`、`lib/api/client.ts`、`lib/api/index.ts`、`lib/api/types.ts`(3 段窗口)、`lib/api.ts`、`lib/searchStore.ts`(导出+store 段)、`lib/selectionStore.ts`、`lib/brandStore.ts`、`lib/uiPrefs.ts`、`lib/offlineStorage.ts`(导出段)、`lib/shelfLayout.ts`(键段)、`lib/sidebarWidth.ts`(键段)、`lib/sourceGrouping.ts`(HEALTH_TAGS 段)、`lib/sourceInspector.ts`(常量段+`inspectSingleSource` 段)、`lib/bookType.ts`、`ui/index.ts`、`ui/README.md`、`ui/color/scheme.ts`、`ui/theme/store.ts`、`ui/theme/types.ts`、`i18n/zh.ts`、`features/reader/ReaderScreen.tsx`(6 段窗口：70-170 / 320-520 / 626-640 / 800-840 / 1740-1900 / 2240-2403)、`features/reader/useReader*.ts`(7 个导出段)、`features/reader/content/readerProgress.ts`、`features/reader/tts/ttsTextProcessor.ts`(导出段)、`features/reader/settingsPanel/readerSettings.ts`(类型段)、`features/bookshelf/ShelfPage.tsx`(排序段)、`features/source-editor/sourceHealthRun.ts`(导出段)、`components/Select.tsx`(头 30 行)、`features/settings/settingsSections.ts`(头 30 行)、`plugins/extensionRegistry.ts`(头 25 行)、`product/web/package.json`、`test/run-all.ts`、`test/HealthTagVocabulary.test.ts`、后端的 `data/SourcesDao.kt`(350-400)、`data/SourceHealthDao.kt`(grep)、`http/SourcesRoutes.kt`(grep)、`model/BookshelfModels.kt`+`BookshelfRepository.kt`(grep)。

**未分析 / 分析不足的部分（157 个文件只到 A 级）**：

| 未深入区域 | 文件数（估） | 原因 |
|---|---|---|
| `features/reader/` 的展示组件与 `settingsPanel/`、`tts/` 内部实现 | ~45 | 只读导出与行数；结论来自命名 + 注释 + 引用关系 |
| `features/source-editor/` 除 `sourceHealthRun` 外的 9 个文件（含 5 个巨型） | 9 | `SourceLoginModal`(737)/`SourceLoginUiPanel`(582)/`SourceEditorPanel`(579)/`bookSourceFields`(693)/`SourceHealthModal`(625) 全部只到 A 级 → **U-2** |
| `features/bookshelf/` 除 `ShelfPage` 排序段外 | 4 | — |
| `features/settings/`（`CookieSection` 433、`WallpaperSection` 296 等） | 5 | — |
| `plugins/` 5 个插件的页面实现 | ~11 | 只读了 registry |
| `components/` 22 个中 20 个 | 20 | 只做 backdrop / 使用量统计 |
| `lib/` 40 个中未列 B 类的约 24 个（`openBook`、`wallpaper`、`fontLibrary`、`exploreGroups`、`scrollProgress`、`syncErrors`…） | 24 | 只到 A 级 |
| `lib/api/domains/*` 7 个（1,049 行） | 7 | 只统计方法与 `request` 次数，未读每个端点语义 → **U-1** |
| `ui/` 的 `color/legacy.ts`、`color/seed.ts`、`motion/spring.ts`、`material/glass.ts`、`theme/apply.ts` | 5 | 只读 `index.ts` 门面与 README |
| `features/rss/`、`features/explore/` | 4 | — |
| `icons.tsx`、`md-raw.d.ts`、两份 CSS | 4 | 无逻辑 |

**结论可信度自评**：
- 「无 router / 无状态库 / 唯一 fetch 出口 / 0 处业务裸 fetch」——**高**（依赖清单 + 全仓 grep 硬数字）。
- 「阅读器中枢 34 state / 27 effect」——**高**（`grep -c` 硬数字）。
- 「业务逻辑泄漏清单」——**中高**：常量与函数体都读到了；后端对应实现只做了 grep 级确认（U-1/U-3 留口）。
- 「16 个巨型文件 / 31 处弹层」——**高**（`wc -l` / `grep -rln` 硬数字，行数会漂移）。
- 「测试覆盖 90/199」——**中**：口径是"被 `*.test.ts` 直接 import 的源文件"，**不等于**可执行行覆盖率；真实行覆盖率须跑 `npm --prefix product run coverage`（本审计禁止运行）。

# 前端宿主化 · 第一阶段分析（包内分层止血）

> ⚠️ **本文的计数（177 个 ts/tsx、110 份测试）测量于 2026-11-05 早期，已过期**；当前事实以 [facts.md](./facts.md) 为准。
>
> ⚠️ **2026-11-06 结构已变**：`features/reader` 的 50 个平铺文件按组拆进
> `tts/ interaction/ content/ notes/ dialogs/ settingsPanel/`，根目录只剩 8 个屏级文件；
> `depth-check` 的前端上限相应从 2 层改到 3 层（`web/src/<分区>/<域>/<组>/File`，第 4 层仍禁止）。
> 本文 §1.2 的「reader/ 57 个文件」是拆分前的数字。
>
> 范围：`product/web/src`，**只读分析**，不动任何 `.ts/.tsx`，不搬家、不改版本号。
> 目标：把「前端从打进 jar 的内置 UI 升级为可扩展宿主（shell / features / shared + 扩展装载复活）」
> 的第一阶段——**包内分层止血**——落到可执行的迁移清单，重点是**现有扩展面接缝的真实形状**。
>
> 所有结论均带 `文件:行号`。测量时间：2026-11-05，工作区 HEAD 干净（`git status --short` 为空）。
>
> 与任务简报的两处出入，以实测为准：
> - 顶层 `ts/tsx` 实为 **177** 个（简报写 ~147）；`web/test/*.test.ts` 实为 **110** 份。
> - 简报所说「后端侧 5 modified + 1 untracked」在本轮实测时**工作区已是干净的**，
>   应为其他成员已提交。本文档全程未触碰 git。

---

## 0. 一句话结论

**扩展面是一具保存完好的骨架，但已经没有任何肌肉连着它。**

四个 `plugins/` 契约文件都在、都在编译、都被判据引用，但：

- `attach()`（`product/web/src/plugins/attachmentStore.ts:46`）**零调用方**；
- `registerExtension()`（`product/web/src/plugins/extensionRegistry.ts:28`）**零调用方**；
- 5 个内置槽位里只有 1 个真的渲染（`ReaderScreen.tsx:2481`），而它**永远渲染空**。

也就是说：`<ExtensionSlot name="reader.toolbar.right" />` 这条链路
「注册表 → 挂载 → 渲染」中间断在**注册**这一环。这不是 bug，是 2026-10-26
「不再做插件」那次拆除的遗留物——契约被留下了，注册方全被删了
（见 `product/docs/plugin-framework.md:3` 的废弃声明）。

**复活外部装载的难点不在槽位**（槽位、挂载、订阅这套 97 行已经能跑），
**而在槽位之外的四件事：发现、生命周期、失败隔离、可信边界。** 详见 §3.4。

---

## 1. 目录现状

### 1.1 顶层清单（实测）

`product/web/src` 顶层共 11 项（3 个文件 + 8 个目录）：

| 顶层项 | 文件数 | 行数 | 职责 | 归属朝代 |
|---|---:|---:|---|---|
| `features/` | 97 | 21613 | 按功能域切分的业务实现 | **新** |
| `lib/` | 34 | 5694 | API 客户端、store、纯工具 | 旧（部分已迁） |
| `components/` | 21 | 4114 | 跨页面通用/半通用组件 | 旧 |
| ~~`pages/`~~ | ~~9~~ **0** | ~~2049~~ **0** | **旧层已消失**（2026-11 迁移完成，见 §1.3 / §3.2） | 旧 → **已清除** |
| `plugins/` | 10 | 376 | 4 个扩展契约 + 6 个浮层内容 | **混合（见 §3.1）** |
| `app/` | 2 | 125 | 路由元数据 + 页面渲染分派 | 新（薄壳） |
| `i18n/` | 1 | 19 | 文案集中表（仅 1 条） | 新（起步） |
| `main.tsx` | 1 | 714 | 应用外壳：全局状态 + 浮层接线 | 旧（宿主本体） |
| `icons.tsx` | 1 | 111 | 图标资源模块 | 中性 |
| `styles.css` | 1 | 6420 | 全局样式（**无 CSS Module**） | 旧 |
| `md-raw.d.ts` | 1 | — | `?raw` 类型声明 | 中性 |

`features/` + `lib/api/` 是唯一已成体系的现代结构；`pages/`、`components/`、
`main.tsx` 是这次要拆的对象。

### 1.2 已迁入 `features/` 的域（6 个）

| feature | 文件 | 行数 | 内容概貌 |
|---|---:|---:|---|
| `reader/` | 57 | 10294 | 阅读器全家桶：屏、目录、TTS、排版、点按区、笔记、词典（`dict/`）、设置面板（`settingsPanel/`、`typeset/`） |
| `source-editor/` | 16 | 5929 | 书源编辑、登录、分组、体检、订阅、分享、调试 |
| `ai/` | 11 | 2428 | AI 对话、连接、工具、技能、提示词、悬浮球 |
| `bookshelf/` | 7 | 1681 | 书架页、封面、拖拽排序、布局 |
| `settings/` | 5 | 1213 | 设置页、分区表、Cookie、壁纸、AI 工具分区 |
| `feedback/` | 1 | 68 | 反馈 URL 拼接（纯函数） |

**关键：`features/` 内部已经零互相依赖。** 全仓扫描 `features/A/**` 里
`from '../../features/B/...'` 形式的跨域 import，实测 **0 条**。
这意味着 §5 那条判据的基线是 0，可以**直接断言相等**，不需要容忍清单。

### 1.3 仍是旧结构的部分

**`pages/` —— ✅ 已于 2026-11 整体消失（本轮完成，判据已升级为"目录不许存在"）**

迁移前它有 9 个文件 2049 行：`AboutPage(263)`、`BackupPage(327)`、`ChangelogPage(154)`、
`ExplorePage(270)`、`FeatureGuide(96)`、`LibraryPage(410)`、`ReadingLogPage(90)`、
`RssPage(36)`、`RssPanel(403)`。

它当时已**不是**全部页面：`app/pages.tsx` 显示 `ShelfPage`、`SourcesPage`、`SettingsPage`
已从 `features/` 取，而 `ExplorePage`/`LibraryPage`/`RssPage` 仍从 `../pages/` 取 ——
同一个 `renderPage` 的分支里一半新结构一半旧结构。

`pages/` 反向依赖 `features/` 已很密（`LibraryPage` 5 处、`ExplorePage` 2 处、
`RssPage`/`AboutPage`/`BackupPage` 各 1 处），所以它不是「被依赖的底座」而是「依赖别人的上层」——
这正是它该并进 `features/` 的判据，最终也正是这么做的。

> **执行中修正的两条判断**（原计划不准确，以实际落地为准，详见 §3.2）：
> ① `pages/LibraryPage.tsx` 与 `pages/ExplorePage.tsx` 的 feature 依赖是**可以归零的** ——
> 把它们共享的 4 个纯件/多消费者件上提到 `lib/`、`components/` 之后，两者就变成零反向依赖，
> 直接收进已有域即可，**不需要为此新开 `features/library/`**。
> ② 「只服务单个弹窗」的那 5 个页面，去 `plugins/<插件>/` 与它唯一的消费者同目录，
> 而不是另建 `features/about` 等 —— 那 5 个是**已注册的扩展**，把内容放在扩展自己目录里才自洽。

**`components/`（21 个，4114 行）—— 真正的共享层，但混了三种东西**

按对外被引次数（`components/` 之外的文件数）分三档：

| 档 | 组件（被引次数） | 实际身份 |
|---|---|---|
| 通用原子（≥6） | `Toast(11)`、`Select(10)`、`PageDialog(6)` | **shared**：无业务语义 |
| 半通用 | `ContextMenu(4)`、`Notice(3)`、`ErrorBoundary(1)`、`Logo(0)` | **shared**：基础设施 |
| 业务耦合 | `AppHeader(1)`、`BookDetailModal(3)`、`SkinModal(3)`、`ReplaceRulesModal(2)`、`WallpaperModal(2)`、`OfflineCacheModal(2)`、`TocRulesModal(1)`、`SourceChoiceList(1)`、`ServerPortModal(1)`、`PwaManager(1)`、`FirstRunAgreement(1)`、`BrandModal(1)`、`LogsModal(1)`、`WallpaperLayer(1)` | **feature / shell**：见 §2 |

其中已有多处**反向依赖 `features/`**：
`components/AppHeader.tsx:8`、`components/BookDetailModal.tsx:6,8,10,12,14,15`、
`components/OfflineCacheModal.tsx:4`、`components/SkinModal.tsx:23`、
`components/SourceChoiceList.tsx:8`。
「通用组件目录依赖功能目录」是分层倒置——它们不是通用组件，是被放错位置的功能组件。

**`lib/`（34 个，5694 行）—— 大部分是 shared，但有三处倒置**

`lib/api/` 已是好结构：`client.ts(19)` + `index.ts(139)` + `types.ts(838)` +
`domains/{reader 513, sources 305, search 195, agent 184, system 82, backup 29, brand 19}`
——按域切好的后端契约，是天然的 `shared/api`。

但 `lib/` 里有 **3 个文件反向 import `features/`**，是必须先解的环：

| 文件:行 | 反向依赖 |
|---|---|
| `lib/backupPreferences.ts:1,2,3` | `features/reader/readerSettings`、`features/reader/fontSizeControl` |
| `lib/rssImage.ts:2` | `features/source-editor/sourceImport`（`sanitizeImageUrl`） |
| `lib/searchStore.ts:4` | `features/reader/openBook`（`OpenBook` 类型） |

按「依赖方向必须单向」的口径，这三条要么把被依赖的纯函数上提到 `shared/`，
要么承认 `lib/` 与 `features/` 是同一层。**建议前者的最小切口**：
`sanitizeImageUrl`（纯字符串处理）、`OpenBook`（纯类型）、`fontSizeControl.clampFontSize`（纯算术）
三者都不含 React，可无损上提。

**`app/`（1 个，83 行）—— 薄壳，保留；但本报告原先在这里漏了两条真实反向依赖（已修）**
`app/pages.tsx` 是 `renderPage(page, ctx)` 的 switch 分派（`:43-83`），没有业务逻辑，正是 shell 该有的样子。

> ⚠️ **更正（已落地）**：本报告原写「`app/` 2 个文件……没有业务逻辑，正是 shell 该有的样子……原样保留」。
> 实测漏了一点：`app/pageMeta.ts`（路由唯一来源，纯数据）**同时被两个非 shell 层 import** ——
> `components/AppHeader.tsx:3` 与 `features/reader/shortcuts.ts:11`（后者还 re-export `PRIMARY_PAGES`，
> 经 `main.tsx:39` 传下去）。也就是说，它虽然「只放纯数据」，**却正是 shared → shell 与 features → shell
> 两条反向依赖的源头**：**"纯数据"不等于"归属正确"**，这是本报告漏判的根因。
> 已把它搬到 `lib/pageMeta.ts`（shared），并同步改 `components/AppHeader.tsx:3`、`features/reader/shortcuts.ts:11`、
> `main.tsx:50`，以及三份判据文件里的路径（`PageRegistry.test.ts`、`SettingsPage.test.ts`、`Shortcuts.test.ts`）。
> 随之新增第 4 条前端判据「shell（`app/`）只能被组合根 import」，**零基线**（当前实测 0），
> 见 `web/test/ArchitectureBoundary.test.ts`；负向对照已验（探针 `components/__probe.ts → ../app/pages` 精确变红）。

**`i18n/`（1 个，19 行）—— 起步，只有 1 条文案**
`i18n/*.ts:17-21` 只定义了 `zh.common.close`。文件头 `:11-15` 说明了「分批收，
不一次性扫全仓」的策略。**它是 shared，但还不构成一个面**，第一阶段不要把它当卖点。

---

## 2. shell / features / shared 目标划分

### 2.1 三层的定义（本阶段，不移动 `product/` 根）

| 层 | 定义 | 允许依赖 |
|---|---|---|
| `shell/` | 应用外壳：启动、路由、全局状态、浮层容器、扩展宿主运行时 | shell → features → shared（单向） |
| `features/` | 一个功能域的全部实现（页面 + 组件 + 状态 + 纯逻辑） | features → features/shared |
| `shared/` | 无业务语义的原子与契约：UI 原语、API 客户端、纯工具、类型 | shared → **不依赖任何上层** |

**硬约束**：`features/A` 不得 import `features/B`（§5 判据钉这条）。
域间需要协作时，把契约下沉到 `shared/`，由 shell 接线——这就是 `app/pages.tsx` 的 `PageContext` 模式（`:23-41`），它是全仓唯一一处正确的接线方式，应当推广。

### 2.2 迁移清单

#### shell/

| 目标 | 来源 | 理由 |
|---|---|---|
| `shell/main.tsx` | `main.tsx`（714） | 入口本身 |
| `shell/App.tsx` | `main.tsx:110-702` 的 `App()` | 714 行里 `getRoot` 只有 `:710-714` 五行，其余全是外壳 |
| `shell/SkinStyle.tsx` | `main.tsx:87-108` | 皮肤 CSS 注入，全局副作用，属外壳 |
| `shell/AppShell.tsx` | `main.tsx:598-701` 的 JSX | 布局骨架 + 浮层挂载点 |
| `shell/routing/` | `app/pages.tsx`（`pageMeta.ts` 已移出，见上） | `pages.tsx` 是纯分派，原样搬；`lib/pageMeta.ts` 归 shared，**不进 shell** |
| `shell/modals/` | `lib/nav.ts` 的 `AppModal`（`:12-48`）+ `main.tsx:642-692` 的 21 个 `openModal ===` 分支 | 单例浮层容器；**这是 shell 最重的接线，也是扩展最该复用的入口** |
| `shell/extensions/` | `plugins/` 里 4 个契约文件 | 见 §3.1，框架属宿主 |
| ↓ 浮层实现 | `components/{SkinModal,WallpaperModal,ServerPortModal,BrandModal,LogsModal,ReplaceRulesModal,TocRulesModal,OfflineCacheModal,BookDetailModal}.tsx` | 它们是「成熟功能浮层」，由 shell 接线；按 §2.3 规则各回其域 |
| ↓ 外壳组件 | `components/{AppHeader,PwaManager,FirstRunAgreement,WallpaperLayer}.tsx` | 顶栏/PWA/首启协议/壁纸层都是外壳级 |
| ↓ 浮层入口 | `plugins/{about,backup,changelog,reading-log,source-health}/*.tsx` | 6 个小文件（14–37 行）只是「把 `pages/X` 包进 `PageDialog`」，见 §3.1 |

> `AppHeader` 依赖 `features/reader/readerSettings` 的皮肤表（`components/AppHeader.tsx:8`）。
> 搬进 shell 后这条依赖**仍然合法**（shell → features），但它暴露了一个真实张力：
> **皮肤/主题是 shell 级能力，却住在 `features/reader/`**。§4.1 把它列为切点。

#### features/（从旧结构并入）

| 新增 feature | 吸收 | 证据 / 落地结果 |
|---|---|---|
| `features/bookshelf/`（已有，扩容） | ✅ `pages/LibraryPage.tsx`(410) | 原计划新开 `features/library/`。**实际不必**：先把 `Cover` / `shelfLayout` / `sourceOrder` / `sourceGrouping` 上提到 shared，`LibraryPage` 的 feature 依赖即**归零**，直接进已有书库域，省掉一个 feature 与 4 条新增跨域依赖 |
| `features/explore/`（新建） | ✅ `pages/ExplorePage.tsx`(270) | 同上：`Cover` 上提后零 feature 依赖 |
| `features/rss/`（新建） | ✅ `pages/RssPage.tsx`(36) + `pages/RssPanel.tsx`(403) + `features/source-editor/SourceSubscriptionPanel.tsx` | 原计划叫 `features/subscription/`；改名 `rss` 对齐既有的 `/api/rss/*`、`rssImage`、`rssImageSrc` 命名。该面板自身**零 feature 依赖**、唯一消费者就是 `RssPage`，同域后 pages 基线那条一并清零 |
| `plugins/about/` | ✅ `pages/AboutPage.tsx`(263) + `pages/FeatureGuide.tsx`(96) | 原计划建 `features/about/`。**实际这 5 个页面各自只有一个弹窗消费者、且都已是注册扩展**，放进 `plugins/<插件>/` 与消费者同目录更自洽，把 `plugins/` 留给扩展装载（阶段③）而不是塞核心内容 |
| `plugins/changelog/` | ✅ `pages/ChangelogPage.tsx`(154) | 同上 |
| `plugins/backup/` | ✅ `pages/BackupPage.tsx`(327) | 同上；`lib/backupPreferences` → `features/reader` 的反向依赖**仍在** shared 基线里，留给阅读域收口时解决 |
| `plugins/reading-log/` | ✅ `pages/ReadingLogPage.tsx`(90) | 同上 |
| `lib/feedbackUrl.ts` | ✅ `features/feedback/feedbackUrl.ts` | **零依赖纯件**、唯一消费者是 `AboutPage`，属 shared；`features/feedback/` 随之整体消失 |
| `features/settings/`（已有，扩容） | ✅ **只移了 `WallpaperModal`** | `components/WallpaperModal.tsx` → `features/settings/`（唯一消费者就是同域的 `WallpaperSection`）。`BrandModal`/`ServerPortModal`/`LogsModal` **不需要移** —— 它们的 feature 依赖随"依赖上提"一并消失了 |
| `features/reader/`（已有，扩容） | ✅ **只移了 `SkinModal` + `backupPreferences`** | `components/SkinModal.tsx`（另一个消费者 `ColorTab` 已在阅读域内）、`lib/backupPreferences.ts`（它构造的是 `ReaderSettings`，属阅读域逻辑）。`BookDetailModal`/`SourceChoiceList`/`OfflineCacheModal` **不需要移** |
| `app/`（shell，扩容） | ✅ `AppHeader.tsx` | 原在 `components/`，但它**只被 `main.tsx` 渲染一次**，是全局顶栏 —— 是 shell 不是 shared |
| `lib/`（shared，扩容） | ✅ `{scrollProgress,sourceInspector,aiChatStore,dragSort,shelfOrder}.ts` | 纯函数 / 只被 shared 用的模块 / 被两个以上 feature 用的手势与 store |

> ✅ = 已落地（2026-11，`tsc` + 909/909 + 5 条边界判据全绿）；⬜ = 仍在计划中。
>
> **计划被实际推翻的地方**（保留这一节是因为它比结果更有用）：原计划要把
> `components/` 里五六个浮层统统搬进 `features/reader/`、`features/settings/`。
> 实际做下来**只搬了 3 个**，其余全部通过**把依赖上提到 shared** 解决 ——
> 因为那些浮层要的往往只是一个纯函数（`scrollPosition`）或一个本就站错层的模块
> （`sourceInspector` 在 `features/source-editor/` 里零消费者）。
> **搬调用方要改十几处 import 且会把它焊死在某个域上；搬被调方通常只动一个文件。**
>
> 三次都用同一条判据：**先问"这东西属于哪一层"，再问"能不能把它上提到 shared"，
> 最后才考虑搬调用方。** 这条比逐个解环便宜一个数量级，且不会制造新债。

#### shared/

| 目标 | 来源 |
|---|---|
| `shared/ui/` | `components/{Toast,Select,PageDialog,Notice,ContextMenu,Logo,ErrorBoundary}.tsx`、`icons.tsx` |
| `shared/api/` | `lib/api/**`（原样整目录搬，已是好结构） |
| `shared/lib/` | `lib/` 余下纯工具：`searchFilters`、`exploreLabel`、`exploreGroups`、`agreement`、`nav`(类型)、`uiContext`(纯拼接)、`useEscapeClose`、`overlayGeometry`、`sourceFocus`、`swRegistration`、`importFromUrl`、`syncErrors`、`cookieApi`、`aiToolGroups` |
| `shared/i18n/` | `i18n/` |
| `shared/styles/` | `styles.css` **按域切分**（见 §4.1；当前 6420 行单文件是扩展样式隔离的最大障碍） |

#### 三个特判文件的去向

- **`main.tsx`** → 只保留 5 行入口（`:710-714`），其余搬 `shell/App.tsx`。
  它与 `vite.config.ts` 的 `index.html` 入口约定绑定，**路径不动**（`product/web/src/main.tsx`）。
- **`app/`** → 整个进 `shell/routing/`。它已经 125 行、零业务、
  且被 `test/PageRegistry.test.ts:6` 直接 import 测试——搬迁时判据同步改路径。
  注意 `app/pages.tsx:70-72` 有一条**host 特判**（`reader` 页返回 `null`，由 `main.tsx:533-541`
  在进入外壳前单独渲染），这条特判应显式变成「整屏路由 vs 内嵌路由」的声明，而不是 `switch` 里的洞。
- **`pages/`** → ✅ **目录已整体消失**（2026-11 完成），9 个文件按 §3.2 的实际归属迁走。
  这是本阶段收益最大、风险最低的一步：`pages/` 已是纯上层（只被 `app/pages.tsx` 与
  `plugins/*` 引用），没有任何东西依赖它的内部实现。
  判据从"基线只许缩小"**升级为"`src/pages/` 目录不许存在"** —— 比"集合为空"更强的一层，
  防止旧层以任何形式重建。

### 2.3 归属判定规则（写进 `frontend-conventions.md`，避免逐个争论）

1. 文件被 ≥3 个不同 feature 引用 → `shared/`；
2. 文件 import 了任何 `features/**` → 它**不是** shared，回到 §2.2 找它的域；
3. 文件在根挂载点被渲染一次且全站可见（顶栏/壁纸/Toast/PWA/首启）→ `shell/`；
4. 其余 → 按「它服务哪个用户可指名的功能」进 `features/<域>/`。

规则 2 直接判掉当前 `components/` 里 7 个倒置文件和 `lib/` 里 3 个倒置文件。

### 2.4 建议的提交切分（每步独立可跑 `npm run check` + `npm test`）

| 步 | 内容 | 风险 |
|---|---|---|
| A | 建 `shared/`、`shell/` 骨架空目录；`components/` 里 7 个无依赖的进 `shared/ui/` | 低 |
| B | 解 `lib/` 3 条反向依赖（上提 `sanitizeImageUrl` / `OpenBook` / `clampFontSize`） | 低 |
| C | `pages/` 9 个文件并入 6 个 feature；删 `pages/` 目录；更新 `app/pages.tsx` | 中（判据路径） |
| D | `components/` 剩余 14 个按域迁走；删 `components/` | 中 |
| E | 加 §5 边界判据（此时基线应为 0，可直接断言） | 低 |
| F | 拆 `main.tsx` → `shell/`；拆 `styles.css` → `shared/styles/` | 高（714 行 + 6420 行） |
| G | `plugins/` 4 个契约 → `shell/extensions/`；6 个内容 → 各自 feature | 低 |

**E 必须在 C/D 之前或同时落地**，否则 C/D 之后没有东西挡住新的跨域 import。

---

## 3. 扩展面盘点（核心）

### 3.1 `plugins/` 的真实构成（名不副实）

`plugins/` 目录名暗示「插件内容」，实测是**两种东西混住**：

| 类别 | 文件 | 行数 | 身份 |
|---|---:|---:|---|
| **框架契约** | `slotRegistry.ts` | 41 | 槽位声明表 |
| | `extensionRegistry.ts` | 52 | 扩展注册表 |
| | `attachmentStore.ts` | 96 | 槽位↔扩展映射 |
| | `ExtensionSlot.tsx` | 51 | 槽位渲染组件 |
| **浮层内容** | `about/{AboutModal,GuideModal}.tsx` | 28+16 | 把 `pages/AboutPage`、`pages/FeatureGuide` 包进 `PageDialog` |
| | `backup/BackupModal.tsx` | 18 | 包 `pages/BackupPage` |
| | `changelog/ChangelogModal.tsx` | 23 | 包 `pages/ChangelogPage` |
| | `reading-log/ReadingLogModal.tsx` | 14 | 包 `pages/ReadingLogPage` |
| | `source-health/SourceHealthModalEntry.tsx` | 37 | 包 `features/source-editor/SourceHealthModal` |

两点观察：

1. **6 个「内容」文件没有一个是插件。** 它们是 `pages/` 页面到浮层的**适配器**
   （`plugins/backup/BackupModal.tsx:1-4` 一个 import + 一个 `<BackupPage/>`），
   在 `main.tsx:16-21` 被静态 import。旧文档称它们「可独立卸载：
   从 `plugins/index.ts` 的清单里删一行」（`product/docs/plugin-framework.md:250`），
   但**那个 `plugins/index.ts` 清单文件今天已不存在**（`ls plugins/*.ts` 只有 3 个契约文件）。
   所谓「删一行即可卸载」现在是**删一个 import + 一个 JSX 分支**（两处）。
2. **存在一条方向违规**：`plugins/source-health/SourceHealthModalEntry.tsx:2`
   import `../../features/source-editor/SourceHealthModal`。
   按旧教义（`plugin-framework.md:23-29`「依赖方向必须是内容 → 框架，
   `extensions/` 里出现任何 `import '../plugins/...'` 都是夹带」）的反向，
   框架侧 `plugins/` 不应 import 内容侧 `features/`。今天它确实这么做了。
   把 4 个契约搬进 `shell/extensions/` 后（§2.4 G 步），这条违规自动消解。

### 3.2 四个契约文件的公开 API

**`slotRegistry.ts`（41 行）—— 槽位名册**

```ts
export type SlotName = string                                       // :11
export function declareSlot(name: SlotName): void                   // :17  幂等
export function isSlotDeclared(name: SlotName): boolean             // :22
export const BUILTIN_SLOTS = { ... } as const                       // :27-38
// :41  Object.values(BUILTIN_SLOTS).forEach(declareSlot)
```

模块内私有状态：`const declaredSlots = new Set<SlotName>()`（`:14`）。
文件头 `:13` 自己声明 **「文档化用途，运行时不强制必须预先声明」**——
即 `declareSlot` 的返回值从不被任何渲染路径查询，`isSlotDeclared` **零调用方**。
这是一个**纯注释性的注册表**。

`BUILTIN_SLOTS`（`:27-38`）声明 5 个槽：

| 键 | 名 | 谁渲染 |
|---|---|---|
| `bookshelfCardOverlay` | `bookshelf.card.overlay` | **无** |
| `readerToolbarLeft` | `reader.toolbar.left` | **无** |
| `readerToolbarRight` | `reader.toolbar.right` | `ReaderScreen.tsx:2481` |
| `readerSidebar` | `reader.sidebar` | **无** |
| `settingsSection` | `settings.section` | **无** |

**`extensionRegistry.ts`（52 行）—— 扩展注册表**

```ts
export type ExtensionId = string                                    // :11
export interface ExtensionRegistration {                            // :13-23
  id: ExtensionId
  component: ComponentType<{ [key: string]: unknown }>              // :16
  label: string
  defaultSlot?: string
  builtin: boolean
}
export function registerExtension(reg, replace = false): boolean    // :28  已存在且 !replace 返回 false
export function unregisterExtension(id): boolean                    // :35
export function getExtension(id): ExtensionRegistration | null      // :40
export function allExtensions(): ExtensionRegistration[]            // :45
export function hasExtension(id): boolean                           // :50
```

私有状态 `const extensions = new Map<...>()`（`:25`）。

**注意契约里的三处空白**（复活外部装载时必须补，见 §3.4）：
- 组件 props 类型是 `{ [key: string]: unknown }`（`:16`），注释自称「暂定空对象，未来可按需扩展」——
  **没有槽位专属 props 契约**；
- `defaultSlot` 注释明说「**建议值**，实际挂载以 attachmentStore 为准」（`:19`）——
  **注册表不知道谁挂在哪**；
- `builtin: boolean` 是唯一的来源标记，**没有 version / apiVersion / 作者 / 入口**字段。

**`attachmentStore.ts`（96 行）—— 槽位↔扩展映射**

```ts
export type Attachment = { slot: string; extensionId: string; order: number }   // :14-19
export function attach(slot, extensionId, order = 0): void          // :46  slot+ext 重复幂等
export function detach(slot, extensionId): void                     // :58
export function detachSlot(slot): void                              // :67
export function detachExtension(extensionId): void                  // :72
export function attachmentsForSlot(slot): Attachment[]              // :77  按 order 升序
export function useAttachmentStore(): {                             // :87
  attachments; attach; detach; detachSlot; detachExtension; attachmentsForSlot
}
```

实现是**模块级单例**（`:25 let state`、`:27 const listeners`）+ `useSyncExternalStore`
（`:88`，服务端快照复用同一函数，SSR 安全）。`emit`（`:29-32`）整体替换 state 对象，
保证快照引用变化可被 React 察觉。文件头 `:8-9` 说明了「四个纯操作，没引入第三方状态库」
——从注释看它是**从 Zustand 换过来的**（`:84`「保持与旧 Zustand 版一致的调用形状」）。

排序只在 `attach`（`:51-53`）与 `attachmentsForSlot`（`:78`）各做一次，
**同 `order` 的相对次序依赖 `Array.prototype.sort` 的稳定性**（V8 稳定，但这是隐式契约）。

**`ExtensionSlot.tsx`（51 行）—— 渲染组件**

```ts
export interface ExtensionSlotProps {                               // :16-22
  name: string
  props?: Record<string, unknown>
  fallback?: React.ReactNode
}
export function ExtensionSlot({ name, props, fallback })            // :24
```

行为：订阅 → 取该槽 attachments（`:25-26`）→ 空则渲染 `fallback`（`:38-40`）→
否则包一层 `<div className="extension-slot" data-slot={name}>`（`:43`），
每个扩展一个 `<Suspense fallback={null}>`（`:45`），逐个 `getExtension` 后渲染（`:28-36`）。

**三者关系**（这是一个 3 层单向链，无环）：

```
slotRegistry  ──(声明名册，仅文档)──┐
                                   │  无代码引用
extensionRegistry ──getExtension──► ExtensionSlot ──useAttachmentStore──► attachmentStore
        ▲                                                                        ▲
        └──────────────── registerExtension ────────    attach ───────────────────┘
                     （零调用方）                  （零调用方）
```

`ExtensionSlot.tsx:13-14` 是**唯一的连线**：它同时 import `attachmentStore` 与
`extensionRegistry`。其余两个文件（`slotRegistry`）**不被任何人 import**
——`declareSlot`/`isSlotDeclared`/`BUILTIN_SLOTS` 全仓无引用。

### 3.3 唯一槽位 `reader.toolbar.right` 的完整链路

**挂载侧（attach）：不存在。**

**渲染侧（render）：存在但恒空。**

| 步 | 位置 | 内容 |
|---|---|---|
| 1 | `product/web/src/features/reader/ReaderScreen.tsx:24` | `import { ExtensionSlot } from '../../plugins/ExtensionSlot'` |
| 2 | `ReaderScreen.tsx:2479-2480` | 注释：「扩展槽位：第三方/用户可在此注入自定义组件……运行时通过 attachmentStore 挂载」 |
| 3 | `ReaderScreen.tsx:2481` | `<ExtensionSlot name="reader.toolbar.right" />` |
| 4 | `ExtensionSlot.tsx:26` | `attachmentsForSlot('reader.toolbar.right')` |
| 5 | `attachmentStore.ts:78` | `state.attachments.filter(...)` → `[]`（因为无人 attach） |
| 6 | `ExtensionSlot.tsx:38-40` | `attachments.length === 0` → `return <>{fallback}</>` |
| 7 | — | `fallback` 未传 → 返回 `<>{undefined}</>` → **渲染零 DOM** |

**验证方法**（本文档实际执行）：全仓 `--include=*.ts --include=*.tsx` 的
`registerExtension|attach|attachmentStore|ExtensionSlot|slotRegistry|extensionRegistry`
grep，命中 23 处，**全部**分布在 `plugins/` 4 个文件自身、`ReaderScreen.tsx:24,2480,2481`
（import + 注释 + 渲染）、以及 test 目录的字符串断言中。
**没有任何一处调用 `attach(...)` 或 `registerExtension(...)`。**

结论：`reader.toolbar.right` 是**一条接好了但两端都没插线的槽**。
`ExtensionSlot` 的渲染逻辑本身是对的（订阅、排序、fallback、Suspense 都在），
缺的只是**生产者**。

**另注**：槽位渲染点位于 `ReaderScreen` 返回 JSX 的**顶部层级**（`:2481`），
在所有浮层/抽屉（`:2485` 起）之前。它 `return <>{fallback}</>` 时零 DOM，
所以今天不占位、不影响布局——这是一个**容易被误认为「已支持扩展」的巧合**：
一旦真有扩展挂上，那颗组件会**立刻挤进阅读器顶栏布局**，
而当前没有任何栅格/尺寸约定（`extension-slot` 这个 className 在 `styles.css` 里也搜不到规则）。

### 3.4 「复活插件式扩展装载」还缺什么

把问题拆成「槽位系统已有」与「外部装载没有」两半。

#### 已有（不用重做）

- 槽位命名与声明（`slotRegistry.ts`）；
- 扩展注册 + 幂等 + 反注册（`extensionRegistry.ts:28,35`）；
- 槽位挂载 + 排序 + 幂等 + 批量反注册（`attachmentStore.ts:46,58,67,72`）；
- 订阅式渲染 + 空槽 fallback + Suspense（`ExtensionSlot.tsx:24-50`）；
- **纯内存、无编译依赖**——`attach` 在运行时改 state，页面不重编译（`attachmentStore.ts:6`）。

#### 缺的四件事（最小接口集）

**缺口 1：发现（Discovery）—— 谁把扩展摆到宿主面前**

现状：**零**。没有 manifest 类型、没有清单文件、没有加载器。
旧文档设想的入口 `web/src/extensions/registry.ts`（`plugin-framework.md:17`）
与清单 `plugins/index.ts`（`:250`）**两者都已不存在**。

| 最小接口 | 建议落点 | 形状 |
|---|---|---|
| `ExtensionManifest` | `shared/host/manifest.ts` | `{ id, name, version, apiVersion, entry, contributes: { slots: string[] } }` |
| `discoverExtensions(): Promise<ExtensionManifest[]>` | `shell/extensions/discovery.ts` | 第一阶段可先只做「内置清单常量」，第二阶段再做 `fetch('/api/extensions')` 或远端 manifest |
| `validateManifest(raw): Result<ExtensionManifest>` | 同上 | 拒绝空 id、非法 version、未知 slot（用 `isSlotDeclared`，**这是 `slotRegistry` 第一次真正被用上**） |

> 这里能顺手解决一个当前设计缺陷：`slotRegistry` 今天是「只在注释里存在的名册」。
> 一旦 manifest 声明 `contributes.slots`，`isSlotDeclared` 就有了**真实调用方**，
> 槽位名册从文档变成**校验入口**。

**缺口 2：生命周期（Activation）—— 组件不够，扩展要有「装/卸」**

现状：注册的只有 `component`（`extensionRegistry.ts:16`），**没有钩子**。
后果：
- 扩展无法在建槽位之前做初始化（注册设置分区、订阅事件、拉自己的配置）；
- `unregisterExtension`（`:35`）删掉注册项，但 `attachmentStore` 里的
  attachment **不会被级联删除**——`detachExtension`（`:72`）要手动调。
  换句话说**卸载是两处调用，漏一处就留下指向空组件的悬挂 attachment**
  （渲染侧 `ExtensionSlot.tsx:30-31` 会 `getExtension` 返回 `null` 而静默跳过，
  **失败是静默的**）。

| 最小接口 | 建议落点 | 形状 |
|---|---|---|
| `ExtensionModule` | `shared/host/extension.ts` | `{ manifest, activate(ctx): void \| Promise<void>, deactivate?(): void \| Promise<void> }` |
| `ExtensionContext` | 同上 | `{ registerExtension, attach, registerSettingsSection, toast, api }` —— 宿主注入，**扩展不直接 import 内部模块** |
| `deactivate(id)` | `shell/extensions/loader.ts` | 必须**同时**调 `unregisterExtension(id)` + `detachExtension(id)`，把「两处调用」收敛成一处 |

**缺口 3：版本协商（Version Negotiation）**

现状：**零**。`ExtensionRegistration` 里没有任何 version 字段（`:13-23`）。

至少要协商两个版本：

| 版本 | 含义 | 不同版本时的行为 |
|---|---|---|
| `apiVersion` | 宿主扩展 API 的版本（本文件 §3.4 定义的接口集） | 不匹配 → **拒绝装载并留痕**，不是尽力而为 |
| React 版本 | 扩展 bundle 编译时的 React major/minor | 不匹配 → 见下方「三类问题」第 1 条 |

建议 `apiVersion` 用**整数单调递增**（`1`, `2`, …），宿主声明 `SUPPORTED_API = [1]`，
manifest 声明它编译时针对的 `apiVersion`。**不做范围匹配**——范围匹配是给人看的，
整数相等才是能断言的。判据见 §5。

**缺口 4：失败隔离（Failure Isolation）**

现状：**半个**。

- `ExtensionSlot.tsx:45` 有 `<Suspense fallback={null}>` —— 只兜**异步挂起**，
  **兜不住渲染期 throw**；
- 全仓 `ErrorBoundary` 只有 2 个用法，都在 `main.tsx`：
  `:533`（包阅读器整支）、`:711`（根兜底）。**`ExtensionSlot` 内部一个都没有。**
- 按 `components/ErrorBoundary.tsx:9-12` 的说明，React 渲染期抛错会**卸载整棵树**——
  一个第三方扩展炸了，用户看到的是**整个阅读器白屏**，而不是那颗扩展消失。

这是当前扩展面**最危险的缺口**，且修法极小：

```tsx
// ExtensionSlot.tsx:44-48 的位置，把 Suspense 换成「Suspense 套 ErrorBoundary」
<ErrorBoundary key={a.extensionId} region={`扩展 ${a.extensionId}`}>
  <Suspense fallback={null}>{renderExtension(a.extensionId)}</Suspense>
</ErrorBoundary>
```

`ErrorBoundary` 已存在于 `components/ErrorBoundary.tsx`，props 是
`{ region: string; onExit?: () => void; children }`（`:18-21`），
**无需新增任何组件**。配套判据见 §5。

另外两个隔离缺口：
- `attachmentsForSlot` 每次调用都 `filter + sort`（`attachmentStore.ts:78`）——
  槽位多、扩展多时是 O(n log n)/次渲染，且**每次返回新数组**，
  会让任何 `useMemo` 依赖它的下游失效。当前 0 扩展所以没暴露。
- `ExtensionSlot` 的 `props?: Record<string, unknown>`（`:19`）与
  `ExtensionRegistration.component` 的 `{ [key: string]: unknown }`（`:16`）之间
  **没有类型连接**，props 错配是运行时静默 undefined。

### 3.5 三类真实问题（不回避）

任务要求如实写出「React 组件跨包注入」带来的三类问题。逐条给当前代码的具体证据。

#### 问题一：React 版本一致性 —— 双 React 实例会击穿 hooks

**当前状态**：`product/web/package.json:28-29` 钉 `react`/`react-dom` `19.1.0`，
`vite` 6.3.5 单入口打包。今天不存在这个问题，因为**根本没有第二个包**。

**一旦外部扩展是一个独立构建的 bundle**，它会带来自己的 React：

- 扩展 bundle 里 `import { useState } from 'react'` 解析到**它自己的** React 副本；
- 宿主 `createRoot`（`main.tsx:710`）用的是宿主的 React 副本；
- 两个副本的 `ReactCurrentDispatcher` 是**不同对象** → hooks 报
  「Invalid hook call」或**静默读到错误 fiber**；
- `useSyncExternalStore`（`attachmentStore.ts:88`）是 React 18+ 才有的 API，
  低版本 React 的扩展 bundle 会直接 `undefined is not a function`；
- Context 跨副本**永远读不到**（`Context._currentValue` 各自独立）。

**必须的约束**（写成 manifest 字段 + 判据）：

1. `react` / `react-dom` 必须声明为 **peerDependency 且 external**，
   扩展构建产物里**不得内联 React**（判据可扫 bundle 里的
   `react-dom.production.min.js` 指纹或 `__SECRET_INTERNALS` 标记）；
2. 宿主要通过 **import map 或全局句柄**把 React 交给扩展
   （ESM `import map` 指向宿主的 `react` 入口，或 `window.__LEGADO_HOST__.react`）；
3. manifest 里记扩展编译时的 React 版本，宿主启动时比对 major。

**代价要讲清楚**：这三条会**显著抬高扩展作者的门槛**——
他不能直接在浏览器里 `<script type="module">` 就写起来，
必须按宿主的构建约定产出 ESM。这是「插件式扩展」的固有成本，不是本项目的实现缺陷。

#### 问题二：样式隔离 —— 6420 行全局 CSS，双向泄漏

**当前状态**：`product/web/src/styles.css` **6420 行，纯全局类名，零 CSS Module、
零 Shadow DOM、零 `@scope`**。全仓所有 className 共享一个命名空间。

具体证据：

- `styles.css` 有**三个** `:root` 块（`:1`、`:4456`、`:5898`），
  文件头 `:11-24` 专门论证了「颜色基线必须在最开头那个 `:root`，
  因为与 `.theme-*` 同为 (0,1,0) 特异性，靠源序定胜负」——
  **这套配色系统是靠源码顺序维持的，不是靠作用域**。
  第三方 CSS 一插进来，源序假设立刻失效。
- 皮肤系统正是「注入外部 CSS」的**现存先例**：
  `main.tsx:87-108` 的 `SkinStyle` 用 `document.createElement('style')` +
  `textContent`（`:100-104`）把用户 CSS 挂到 `document.head`。
  注释 `:83-85` 明确要求用户**自己写完整选择器** `.theme-<id> { … }`——
  即**用户 CSS 与全站样式在同一个全局命名空间里肉搏**。
  `readerSettings.ts:524-529` 还专门实现了「跳过自家 marker 节点」的逻辑
  （`:529 if (owner?.id === 'legado-custom-skin') continue`），
  说明**泄漏已经真实发生过**。
- 槽位容器的 className 是 `extension-slot`（`ExtensionSlot.tsx:43`），
  但 `styles.css` 里**搜不到 `.extension-slot` 规则**——
  第三方组件进来时**连宿主给的容器样式都没有**，只能自备。

**必须的约束**：

1. 槽位容器提供**最小、稳定、有文档**的样式契约
   （建议：`display: contents` 或 flex 容器 + 明确的尺寸继承规则），
   而不是今天这样「一个没有任何规则的裸 div」；
2. 扩展 CSS 必须**作用域化**：Shadow DOM（强隔离，但切断继承的 CSS 变量，
   与 §4.1 的主题契约冲突）或**强制前缀/`@scope`**（弱隔离，但保留变量继承）。
   考虑到主题系统**完全建立在 CSS 变量继承上**（`main.tsx:133-138` 把
   `.theme-*` 挂到 `<html>`，`:144-147` 从 `<html>` 读 `--canvas`），
   **建议走 `@scope` / 前缀方案而非 Shadow DOM**——否则第三方组件拿不到主题变量；
3. `styles.css` 拆分（§2.2 的 `shared/styles/`）应在扩展装载**之前**完成，
   否则无法界定「哪些规则属于宿主基线、哪些属于某个 feature」。

#### 问题三：可信边界 —— 同源任意 JS，且后端无鉴权

**当前状态**：前端是单 bundle，**无外部代码入口**，所以今天边界清晰。
但要注意宿主本身的暴露面：

- 后端默认 `127.0.0.1:1234` 且**无账号/token**（项目背景已确认）；
- `vite.config.ts:145` 的 dev server 代理 `/api` → 后端，
  即**前端页面与后端 API 同源**（`vite.config.ts:143` 注释确认了同源判定是设计约束）。

**一旦允许加载外部扩展**，等价于：

> 任何能让宿主加载一个扩展的人，都能在**用户浏览器里、与 API 同源的上下文**中
> 执行任意 JavaScript。

这条与后端文档 `product/docs/plugin-framework.md:154-175`（§1.3a「`discoverFrom`
从目录加载 jar = 执行任意代码」）是**同一个形状，但前端的后果更重**。
前提说明：**后端那套机制也已移除**——`product/app/src/main/kotlin/io/legado/plugin/`
目录今天已不存在（`plugin-framework.md:3` 的废弃声明，`product/AGENTS.md` 亦确认
「插件装载已移除，代码里已无 `plugin/` 包」）。所以下表的左列是**历史形态**，
它的价值在于：那套机制已经踩过的坑，前端装载器会**原样再踩一遍**。

| 对比 | 后端插件（jar，已移除） | 前端扩展（bundle，待建） |
|---|---|---|
| 执行位置 | legadoQ 服务进程 | **用户浏览器** |
| 能否读同源存储 | 否 | **能**：`localStorage`、`sessionStorage`、`IndexedDB`（`lib/offlineStorage.ts`、`lib/fontLibrary.ts` 都往里写） |
| 能否调后端 API | 需自己发请求 | **能**，且**同源免 CORS**（`vite.config.ts:145`） |
| 进程隔离 | 可借 OS 权限/容器 | **无**——浏览器同源策略在**同源内不提供任何隔离** |
| 后端可拦 | 是（路由在后端） | **否**，请求看起来就是宿主发的 |

后端文档 §1.3a 的四条对策（不放网络盘、只装亲手构建的、不因绑 127.0.0.1 就以为安全、
进程级沙箱才是手段）——**没有一条能直接搬到前端**：
浏览器里没有「进程级沙箱」给同源脚本用。

**必须如实记录的结论**：
1. 第一阶段**不要**做「从网络 URL 动态加载扩展」。先做**本地内置清单**
   （扩展与宿主同仓同构建），把接口集跑通；
2. 若将来要做外部装载，**第一道闸不是前端沙箱，而是后端的扩展签名/白名单校验**
   ——前端拿不到可信根，浏览器同源模型里也不存在可信根；
3. 扩展能拿到的宿主 API（§3.4 的 `ExtensionContext`）应当**白名单化**，
   而不是把 `api` 对象整个递出去——后者等于把 157 个后端端点全交给扩展；
4. 需要用户可见的**信任提示**（「此扩展可读取你的书架与阅读记录」），
   而不是静默装载。当前 `ExtensionRegistration` 连 `builtin` 之外
   没有任何来源/权限信息（`extensionRegistry.ts:22`）。

---

## 4. 三个开放面现状

### 4.1 主题：**已经是 CSS 变量契约，但没有任何类型约束**

**答案：是 CSS 变量，不是硬编码。** 而且这套东西**已经接近一个真正的契约**。

证据链：

| 层 | 位置 | 内容 |
|---|---|---|
| 令牌基线 | `styles.css:25-42` | `:root` 里 16 个颜色令牌：`--canvas`、`--surface`、`--surface-muted`、`--ink`、`--muted`、`--line`、`--accent`、`--accent-soft`、`--accent-ink`、`--accent-solid`、`--accent-solid-hover`、`--on-accent`、`--danger`、`--danger-solid`、`--on-danger`、`--shadow` |
| 7 套内置皮肤 | `styles.css:72-78` | `.theme-{light,paper,dark,qingzhu,mulan,meigui,shimo}`，每套**完整重定义同一组 16 个令牌** |
| 类型 | `readerSettings.ts:7-8` | `ReaderTheme = 'light' \| 'paper' \| 'dark' \| (string & {})`——**开放集合**，注释明说「配合注入 `.theme-<id>` 的 CSS 变量即可加皮肤，不必改这个类型」 |
| 解析 | `readerSettings.ts:407` `resolveTheme()` | 归一化 → 内置/自定义裁决；`:512-514` `themeClassNames()` 拼 `theme-<id>` |
| 挂载 | `main.tsx:133-138` | 把 `.theme-*` 挂到 **`<html>`**（不是 `.app-shell`），理由见 `:126-132`：portal 浮层要能取到变量 |
| 派生 | `main.tsx:144-147` | 从 `<html>` 读**算出来的** `--canvas` 写进 `<meta name="theme-color">` |
| 自定义 | `main.tsx:87-108` | `SkinStyle` 注入用户 CSS；`readerSettings.ts:524-529` 检测自家 marker |

**为什么说「接近契约」**：令牌名与数量在 7 套皮肤里高度一致，
`main.tsx:145` 已经在**用 CSS 变量做跨层通信**（用 `getComputedStyle` 读值而不是查表），
这说明「变量是接口」这个模式已经在用了。

**抽象成契约的切点**：

1. **把 16 个令牌显式化成 TS 类型与常量表**，放 `shared/theme/tokens.ts`：
   `export const THEME_TOKENS = ['--canvas', ...] as const`。
   当前这些名字**只存在于 CSS 文本里**，TS 侧一个都不知道——
   皮肤少写一个令牌不会报错，只会「用户自定义时某个元素颜色不对」。
2. **判据**：断言 `styles.css:72-78` 的 7 个 `.theme-*` 块**每个都定义了全部 16 个令牌**。
   这一条今天就能跑（纯文本扫描），且能抓到真实错误——见 §5.4。
3. **把 `styles.css` 的 `:root` 令牌块单独切出来**（`shared/theme/tokens.css`），
   与组件样式分离。理由见 `styles.css:11-24` 那段论证：**配色正确性依赖源序**，
   混在 6420 行里无法保证。这是 §3.5 问题二的**前置条件**。
4. 槽位应能声明**自己需要哪些令牌**（配合 §3.4 的 manifest `contributes`），
   宿主校验后注入——而不是让扩展自己猜变量名。

### 4.2 阅读/翻页模式：**`settings.pageMode` 上的三元分支散在 45 处**

**类型**：`readerSettings.ts:15` `export type ReaderPageMode = 'scroll' | 'paginate'`；
解析 `:252-253 parsePageMode`（非法值落 `'scroll'`）；默认 `:177 pageMode: 'scroll'`。

**分支密度**：`grep -c pageMode features/reader/ReaderScreen.tsx` = **45**。
这不是一个「两种模式」的抽象，而是**两条实现路径在同一个 2863 行组件里交织**。

三个最有代表性的位置：

| 位置 | 代码 | 性质 |
|---|---|---|
| `ReaderScreen.tsx:227` | `const pageAnim = settings.pageMode === 'paginate' ? settings.pageAnim : 'none'` | 派生状态 |
| `ReaderScreen.tsx:2559-2567` | `map={settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll}` + 回写时再判一次 | **同一个判断写了两遍**（读一遍、写一遍） |
| `ReaderScreen.tsx:2576` | `{settings.pageMode === 'paginate' ? (<div className="reader-paginated-wrap">…) : (<article className="reading-content">…)}` | **整个渲染主体的二选一** |

**已经抽干净的部分**（这是好消息，说明方向可行）：

| 模块 | 行数 | 已抽出的纯逻辑 |
|---|---|---|
| `features/reader/pageTurn.ts` | 59 | `PageTurnAnim`(`:20`)、`planNextPage`(`:30`)、`planPrevPage`(`:36`)、`pageTurnAnim`(`:48`)、`coverDirection`(`:57`) |
| `features/reader/readerFlow.ts` | ~90 | `chapterConsumed`(`:33`)、`flowAdvance`(`:48`)、`holdScroll`(`:62`)、`sectionAtPage`(`:73`)、`pageProgress`(`:83`) |
| `features/reader/readerInteractions.ts` | 226 | `calculatePaginationLayout` 等（`ReaderScreen.tsx:12` 一次 import 13 个符号） |
| `features/reader/tapZones.ts` | 213 | `DEFAULT_MAPS: Record<'paginate' \| 'scroll', TapMap>`(`:50`)——**已经按模式建表，是正确形状的雏形** |

`pageTurn.ts:8-10` 的注释自己指出了目标：「把决策收成纯函数之后，
逐页翻 / 跨章 / 接章 / 动画选择都能在 `web/test/PageTurn.test.ts` 里直接钉，不必起浏览器」。

**抽象成契约的切点**：

定义一个 `ReaderView` 实现接口，两种模式各一个实现：

```ts
interface ReaderView {
  readonly mode: ReaderPageMode
  renderSections(ctx: ReaderRenderCtx): ReactNode   // 对应 :2576 的两个分支
  measure(viewport: ViewportBounds): void           // 分页量栏 / 滚动量节
  goNextPage(): PageTurnPlan                        // 复用 pageTurn.ts:30
  goPrevPage(): PageTurnPlan                        // 复用 pageTurn.ts:36
  scrollToProgress(p: number): void                 // 复用 readerFlow.ts / logicalPosition.ts
  tapMap(): TapMap                                  // 复用 tapZones.DEFAULT_MAPS
}
```

**为什么这个切点是安全的**：它不发明新逻辑，只是把 45 处 `if` 的**两个分支体**
包成两个对象。`pageTurn.ts`、`readerFlow.ts`、`readerInteractions.ts`、
`tapZones.ts` 全部原样复用，`ReaderScreen.tsx:2576` 的三元变成 `view.renderSections(ctx)`。

**并且它直接服务于扩展目标**：`pageMode` 从封闭 union `'scroll' | 'paginate'`
（`readerSettings.ts:15`）变成**开放注册表**后，
「仿真翻页（卷页，需要 canvas）」——`pageTurn.ts:18` 明说「将来若要加 `仿真`，
加一个值 + 一处渲染即可」——就变成**注册一个新 `ReaderView` 实现**，
这正是「阅读模式可扩展」的落点。

### 4.3 TTS：**后端接口已成形，前端引擎抽象已存在但未注册**

**前端调后端的接口形状**——`product/web/src/lib/api/domains/reader.ts:447-513` 的 `tts` 对象，
5 个方法（经 `lib/api/index.ts:41,87` 聚合，`lib/api.ts:187-193` 保留旧名别名）：

| 方法 | 行 | HTTP | 形状 |
|---|---|---|---|
| `voices()` | `:448-456` | `GET /api/tts/voices` | `Array<{id, name, lang, gender, localeName, engine, description?}>` |
| `createSession(signal?)` | `:457-462` | `POST /api/tts/session` | `{ sessionId, audioUrl, eventsUrl }` |
| `appendChunk(sessionId, chunk)` | `:463-479` | `POST /api/tts/session/{id}/chunks` | chunk = `{text, chapterIndex, paragraphIndex, engine, voice, rate, pitch, customUrl?, customHeader?, customMethod?, customBody?}` → `{accepted}` |
| `control(sessionId, action)` | `:480-484` | `POST /api/tts/session/{id}/control` | action = `'pause'\|'resume'\|'stop'` → `{accepted}` |
| `delete(sessionId)` | `:485-488` | `DELETE /api/tts/session/{id}` | `void` |
| `speak(req)` | `:489-512` | `POST /api/tts/speak` | **直接 `fetch`，不走 `request()`**，返回 `Blob`（`:511`），错误取 `err.message`（`:508-509`） |

观察：`speak` 是**唯一绕过 `request()` 封装**的方法（`:501` 直接用 `fetch`），
因为它要拿 `Blob` 而不是 JSON。它硬编码了 `credentials: 'same-origin'`（`:504`）。

**前端已有的引擎抽象**——`product/web/src/features/reader/ttsEngine.ts`：

```ts
export type TtsPlayState = 'idle' | 'buffering' | 'playing' | 'paused'      // :4
export type TtsSpeakMode = 'replace' | 'continue'                            // :5
export type TtsChunkContext = { chunkId?; chapterIndex?; paragraphIndex? }   // :6-10
export interface ITtsEngine {                                               // :27-42
  speak(text, settings, onEnd, onError, mode?, context?): void
  pause(): void; resume(): void; stop(): void
}
export class WebSpeechEngine implements ITtsEngine { ... }                   // :44
export class HttpAudioTtsEngine implements ITtsEngine { ... }                // :161
```

**这不只是一个接口，是已经在跑的接缝**：`useReaderTts.ts:95`
`getTtsEngine(type: TtsEngineType): ITtsEngine` 里按 type 分支
（`:98 new WebSpeechEngine()` / `:103 new HttpAudioTtsEngine()`），
`ReaderScreen.tsx:47` 三者全量 import。

**抽象成契约的切点**（比阅读模式更近，改动更小）：

1. `ITtsEngine` 已经是对的契约形状——**缺的只是「注册」而不是「分支」**。
   建 `shared/tts/registry.ts`：`registerTtsEngine(id, factory)` /
   `createTtsEngine(id, deps)`，把 `useReaderTts.ts:95-105` 的 if/else 换成查表。
   这与 §3.2 的 `extensionRegistry` **是同一个形状**，应当共用一套注册表实现。
2. `TtsEngineType`（当前是 union）变成开放 id 之后，
   「接一个新 TTS 引擎」就等价于「注册一个 `ITtsEngine`」——**这是三个开放面里最先能兑现的扩展点**。
3. 契约的**输入边界**要收：`speak()` 当前直接收整个 `ReaderSettings`（`ttsEngine.ts:30`），
   意味着任何引擎实现都耦合了全部阅读设置。应改为收一个窄接口
   `TtsSpeakOptions { engine, voice, rate, pitch, customUrl… }`
   ——这正好是 `lib/api/domains/reader.ts:463-475` chunk 的形状，**两边可以对齐成同一个类型**。
4. `isEffectiveText`（`ttsEngine.ts:17-25`）是引擎无关的护栏，
   应上提到 registry 层，而不是留在某个具体引擎里（现由 `WebSpeechEngine` 路径使用）。

---

## 5. 判据设计

### 5.1 参照物：后端 `ArchitectureBoundaryTest` 的做法

`product/app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt`（206 行）的三条结构：

1. **`java` 桥白名单**（`:39-56`）——扫源码提取集合，与常量 `BRIDGE_WHITELIST`（`:164-189`）
   **断言完全相等**：`added` 与 `removed` 分别断言为空，
   **两个方向都红**（`:43-55`）。注释 `:24` 明说「多一个＝未登记就扩面（红）；
   少一个＝有人删了桥方法却没同步白名单（红，逼你确认删除是有意的）」。
2. **`model/` 反向依赖基线 0**（`:61-73`）——扫 `model/` 下所有 `.kt` 的 import 行，
   过滤出指向非 `model` 包的，断言 `violations.isEmpty()`（`:68-72`），
   因为「当前实测 0，此判据把它锁死」（`:26`）。
3. **`rules/` 横穿基线**（`:78-97`）——同样的双向断言，但基线是一组已知条目
   `RULES_CONCRETE_BASELINE`（`:198+`），注释 `:30` 声明**「基线只允许单调缩小」**，
   并记录了 25 → … → 1 的收敛史（`:28`、`:193-197`）。

**关键技术手段**（`:106-120` `scanCodeLines`）：
先 `.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "")` **剥注释**，
再 `trimStart()` 后**只保留以 `import ` 开头的行**（`:117-118`）。
注释 `:105` 解释了为什么：「`import` 顶格才计，注释里的示例不误伤」。
这一步是必要的——本仓库注释里大量出现 `import` 示例（如 `plugin-framework.md` 里的代码块、
`ReaderScreen.tsx` 里的说明）。

**前端要照搬的是这套形状，不是这套代码**。

### 5.2 前端同款判据（三条，第一阶段）

新建 `product/web/test/ArchitectureBoundary.test.ts`。它**零新增依赖**，
只用 `node:test` + `node:assert/strict` + `node:fs`——与现有
`test/NamingConventions.test.ts:1-4` 完全一致。

**判据 1：`features/*` 之间不得互相 import**

```ts
// 剥注释后只留 import 行（照搬 ArchitectureBoundaryTest.kt:106-120 的口径）
const IMPORT_RE = /^\s*import[^'"]*['"]([^'"]+)['"]/gm
const specifierOf = (line: string) => line.match(/['"]([^'"]+)['"]/)?.[1] ?? ''

// 对每个 features/<域>/ 下的文件，解析其所有相对 import，
// 归一化后若落在 features/<另一个域>/ → 违规
const CROSS_FEATURE = /(?:^|\/)features\/([^/]+)\//
```

断言 `offenders` 与**显式基线 `CROSS_FEATURE_BASELINE` 完全相等**（双向）——
即使基线今天是**空集**，也照样写双向断言：这样将来有人「顺手加一条」时
第一个方向红，有人「端口化消掉一条」时第二个方向红、逼他缩基线。
把 `ArchitectureBoundaryTest.kt:30` 的「基线只允许单调缩小」原话写进失败消息。

**当前实测基线 = `[]`（0 条）**，所以这条判据**今天就能绿**，
且它挡住的正是 §2 里 `pages/` 与 `components/` 归位之后最容易出现的新耦合。

**判据 2：分层方向不得倒置**

```ts
const LAYER_RULES = [
  // shared 不得依赖 features / shell
  { from: /^shared\//,   forbid: /^(?:features|shell)\// },
  // 不允许任何东西依赖 shell（shell 是叶子消费者）
  { from: /^(?:shared|features)\//, forbid: /^shell\// },
]
```

这条**今天会红**，因为 §1.3 实测到：
`lib/backupPreferences.ts:1,2,3`、`lib/rssImage.ts:2`、`lib/searchStore.ts:4`
反向依赖 `features/`，以及 `components/` 下 **11 处（6 个文件）**同类。
**正确的接法是先给基线，再逐步缩**（照搬 `RULES_CONCRETE_BASELINE` 的做法）：

> ✅ **已落地**：`web/test/ArchitectureBoundary.test.ts`（5 例，随 `test/run-all.ts` 目录扫描自动登记）
> 已把本节三层反向依赖做成可执行判据 —— 扫源码 + 显式基线 + **断言集合相等**：
> 新违规立刻红；基线条目被修掉却不从基线删除，同样红（只许单调缩小）。
> 落地时实测的真值：**跨 feature 9 条**（本节原先没有统计这一项）、
> **shared（`lib/`+`components/`）→features 15 条**、**`pages/`→features 13 条**；
> `app/`（shell / 组合根）的 5 条按设计**豁免**（与后端 `Application.kt` 装配 `http/` 同理）。
>
> ⚠️ **更正 §1.3 与 §6 的两个数字**：`components/` 的反向依赖不是「7 处」而是 **11 处 / 6 个文件** ——
> 漏掉的是 `components/WallpaperModal.tsx:4`（`../features/settings/WallpaperSection`），
> 且 `BookDetailModal.tsx` 是 6 处而非 3 处。`lib/` 的「3 个文件」正确，但按行计是 **4 处**。
> 更要紧的是 **feature 之间的互引此前完全没测，实际有 9 条**。
> 数字以 `ArchitectureBoundary.test.ts` 里的基线数组为准（那才是可执行、会变红的那一份）。
>
> 🔻 **已收窄一轮：9 / 15 / 13 → **5 / 10 / 8**（共清 14 条）。** 做法是把 **4 个错放位置的纯件**下沉到 shared：
> `features/bookshelf/bookType.ts`（36 行、**零 import**）→ `lib/`、
> `features/reader/openBook.ts`（5 行纯类型）→ `lib/`、
> `features/source-editor/sourceImport.ts`（48 行、**零 import**）→ `lib/`、
> `features/bookshelf/EmptyGuide.tsx`（36 行通用组件）→ `components/`。
>
> 一刀能清 14 条，是因为 **`lib/` 与 `components/` 本来就在反向够这 4 个件** ——
> 同一次下沉同时消掉跨 feature（4）、shared→feature（5）、pages→feature（5）三类。
> 而这 4 个件**没有一个是真耦合**，全是分类错放：纯函数 / 纯类型 / 通用组件本就不该住在某个 feature 里。
>
> 教训：**先问"这东西属于哪一层"，比逐个解环便宜一个数量级。** 逐个解环要动 9 个 feature 的调用点，
> 而重新归类只需移动 4 个文件 + 22 行 import。
>
> 🔻 **第二轮收窄：5 / 10 / 8 → **5 / 8 / 3**（再清 7 条）。** 这次上提的是 4 个**多消费者或纯件**：
> `features/bookshelf/Cover.tsx`（3 个 feature 外消费者：`components/BookDetailModal` + 两个 page）→ `components/`、
> `features/bookshelf/shelfLayout.ts`（**零 import**）→ `lib/`、
> `features/source-editor/sourceOrder.ts`（**零 import**）→ `lib/`、
> `features/source-editor/sourceGrouping.ts`（**零 import**）→ `lib/`。
>
> 这一轮的价值不只是数字：它让 `pages/LibraryPage.tsx` 与 `pages/ExplorePage.tsx` 的
> **feature 依赖归零**，从而**变成可迁移的**。如果反过来把这两个 page 塞进某个 feature，
> 会**新增 4 条跨 feature 违规** —— 那是拿一种债换另一种债，且违反"基线只许缩小"的纪律。
> **方向判据：能让基线缩小的是上提共享件，不是搬动组合者。**
>
> ⚠️ 本轮踩到的坑：替换脚本的"命中次数断言"只保证**搜到了**，**不保证替换后的路径正确** ——
> 我把 `features/bookshelf/ShelfPage.tsx` 到 `components/` 的相对深度写成了 `../` （应为 `../../`），
> 22/22 全"命中"却编译不过。**这类断言必须配一次 `tsc` 才算验完。**

```ts
const LAYERING_BASELINE = new Set([
  'lib/backupPreferences.ts:1', 'lib/backupPreferences.ts:2', 'lib/backupPreferences.ts:3',
  'lib/rssImage.ts:2', 'lib/searchStore.ts:4',
  'components/AppHeader.tsx:8', 'components/BookDetailModal.tsx:6', /* … 完整清单见 test/ArchitectureBoundary.test.ts */
])
```

基线项用 **`<相对路径>:<import 行号>`** 而不是「文件名」——
这样「同一个文件里新增一处倒置」也能被抓到（只记文件名的基线会漏掉它）。
每条基线项配一行注释说明它属于 §2.4 的哪一步。

**判据 3：槽位契约不得静默失效（扩展面专属）**

这是本文档独有的、针对 §3 的三条：

```ts
test('每个 ExtensionSlot 渲染点的槽位名，必须在 BUILTIN_SLOTS 里声明', () => {
  // 扫 src 下所有 <ExtensionSlot name="..." /> 的字面量
  // 排除已有的 5 个之外 → 红
})

test('ExtensionSlot 内部必须有 per-extension ErrorBoundary', () => {
  const src = read('src/plugins/ExtensionSlot.tsx')
  assert.match(src, /ErrorBoundary/, '§3.4 缺口 4：一个扩展抛错会卸载整棵树')
})

test('extension-slot 容器必须在 styles.css 里有规则', () => {
  // §3.5 问题二：容器今天没有任何样式，第三方组件进来无法定位
})
```

第一条今天会**绿**（`reader.toolbar.right` 在 `BUILTIN_SLOTS:33`），
但它锁定的是「新增槽位必须登记」；
第二条与第三条今天**红**，它们是 §3.4 / §3.5 那两个缺口的**可执行形态**——
把「要修」变成「不修就红」。

### 5.3 接入 `web/test/run-all.ts`（零改动）

**不需要改任何接入代码。** `product/web/test/run-all.ts:12-27` 的机制是
「扫目录，不手抄清单」：

- `:12` `import { testFiles } from './discover.ts'`；
- `:15` `const files = testFiles(dir)`；
- `:18-21` 扫出来 `< 60` 份就**拒绝当通过**（防止过滤器写坏导致假绿）；
- `:25-27` `for (const name of files) await import('./' + name)`。

而 `test/discover.ts` 的 `testFiles()` 用
`fs.readdirSync(dir, { recursive: true })` + `.filter(name => name.endsWith('.test.ts'))`
——**递归、按后缀、自动排序**。

所以**新文件只要叫 `product/web/test/ArchitectureBoundary.test.ts` 就自动被跑**。
`discover.ts:26-28` 还专门处理了 Windows 的 `\` → `/` 归一化。

运行方式：
```bash
cd product/web && npm test          # package.json scripts.test = "tsx test/run-all.ts"
# 或单独跑一份（run-all 不做过滤，单独调试直接 tsx）：
cd product/web && npx tsx --test test/ArchitectureBoundary.test.ts
```

**注意 `discover.ts:12-18` 记录的历史教训**：这个仓库
「已经栽过三次同一条 —— 手抄清单的失效方式不是报错，是少跑」。
所以**判据设计里也不得出现任何手抄的「要检查哪些文件」清单**，
只能扫目录。基线集合（`CROSS_FEATURE_BASELINE` / `LAYERING_BASELINE`）
是**允许的**——它不是「要跑哪些文件」，而是「已知的违规条目」，
其语义是「必须恰好这些，多一条少一条都红」，与手抄清单相反。

### 5.4 判据 4（可选，把 §4.1 的主题契约也钉住）

```ts
test('styles.css 的 7 套 .theme-* 每套都必须定义全部 16 个令牌', () => {
  const css = read('src/styles.css')
  const tokens = [...css.matchAll(/(--[a-z-]+)\s*:/g)].map(m => m[1])
  // 以 :root 基线块为准取 THEME_TOKENS（16 个）
  for (const name of ['light','paper','dark','qingzhu','mulan','meigui','shimo']) {
    const block = new RegExp(`\\.theme-${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    for (const t of THEME_TOKENS) assert.ok(block.includes(`${t}:`), `.theme-${name} 缺 ${t}`)
  }
})
```

这条今天应当**绿**（§4.1 实测 7 套皮肤看着一致），
但它把「令牌集合」从**约定**变成**可断言的东西**——
并且这正是 §3.5 问题二（样式隔离）的前置：**先能界定基线的边界，才谈得上隔离**。

---

## 6. 风险排序（给第一阶段的优先级建议）

| # | 风险 | 证据 | 建议 |
|---|---|---|---|
| 1 | **扩展抛错卸载整棵树** | `ExtensionSlot.tsx:45` 只有 `Suspense`，无 `ErrorBoundary`；`main.tsx:711` 是唯一根兜底 | **最先修**：复用 `components/ErrorBoundary.tsx`，约 3 行改动 + 1 条判据 |
| 2 | **样式隔离无任何基础** | `styles.css` 6420 行全全局、三个 `:root`、源序敏感的配色（`:11-24`）；`main.tsx:87-108` 已有注入外部 CSS 的先例 | 扩展装载**之前**必须拆 `styles.css` |
| 3 | **四条边界全部归零**：跨 feature **0**、shared→feature **0**、`pages/`→feature **0**（目录已删）、shell 被引 **0**。判据从"只许缩小的基线"升级为**零基线 + 无豁免通道** | 初测 **9 / 15 / 13**，四轮共清掉 **37 条**。关键不是数量，是解法：**没有一条靠"改调用点"解掉**，全是重新归类或上提依赖 | §2.4 B 步，已完成 |
| 4 | **卸载不彻底（悬挂 attachment）** | `unregisterExtension`(`extensionRegistry.ts:35`) 与 `detachExtension`(`attachmentStore.ts:72`) 是两次独立调用，漏一次则渲染侧静默跳过（`ExtensionSlot.tsx:30-31`） | 收敛成一个 `deactivate(id)` |
| 5 | **`pages/` 目录是一半的页面** | `app/pages.tsx:2-5`（旧）vs `:5-7`（新）混用 | §2.4 C 步，收益大风险低 |
| 6 | React 双实例 | 今天不存在（单 bundle，`package.json:28-29` 钉 19.1.0） | **在引入第一个外部 bundle 之前**先定 import map / external 约定，否则事后无法补 |
| 7 | 可信边界 | 同源 + 后端无鉴权（`vite.config.ts:143-145`） | 第一阶段**不做**网络动态加载，只做内置清单 |

---

## 附：本文档引用的关键位置索引

| 主题 | 位置 |
|---|---|
| 扩展契约 · 槽位名册 | `product/web/src/plugins/slotRegistry.ts:11,17,22,27-38,41` |
| 扩展契约 · 注册表 | `product/web/src/plugins/extensionRegistry.ts:11,13-23,28,35,40,45,50` |
| 扩展契约 · 挂载表 | `product/web/src/plugins/attachmentStore.ts:14-19,25,27,46,58,67,72,77,87` |
| 扩展契约 · 渲染 | `product/web/src/plugins/ExtensionSlot.tsx:16-22,24,26,38-40,43,45` |
| 唯一槽位渲染点 | `product/web/src/features/reader/ReaderScreen.tsx:24,2479-2481` |
| 插件框架废弃声明 | `product/docs/plugin-framework.md:3` |
| 旧契约路径（已不存在） | `product/docs/plugin-framework.md:17,23-29,250` |
| 后端任意代码警告 | `product/docs/plugin-framework.md:154-175` |
| 路由唯一来源 | `product/web/src/lib/pageMeta.ts:24-32,40-42`（原 `app/pageMeta.ts`，本轮移入 shared） |
| 页面渲染分派 | `product/web/src/app/pages.tsx:2-11,23-41,43-83` |
| 浮层状态机 | `product/web/src/lib/nav.ts:3,5,12-48`；`product/web/src/main.tsx:164-194,642-692` |
| 主题令牌基线 | `product/web/src/styles.css:1,25-42` |
| 7 套内置皮肤 | `product/web/src/styles.css:72-78` |
| 主题解析 | `product/web/src/features/reader/readerSettings.ts:7-8,15,177,252-253,407,512-514` |
| 皮肤注入 | `product/web/src/main.tsx:87-108,133-138,144-147` |
| 翻页模式分支 | `product/web/src/features/reader/ReaderScreen.tsx:227,2559,2576`（共 45 处） |
| 翻页纯逻辑 | `product/web/src/features/reader/pageTurn.ts:20,30,36,48,57` |
| 连续流纯逻辑 | `product/web/src/features/reader/readerFlow.ts:33,48,62,73,83` |
| TTS 后端接口 | `product/web/src/lib/api/domains/reader.ts:447-513` |
| TTS 引擎抽象 | `product/web/src/features/reader/ttsEngine.ts:4,5,27-42,44,161` |
| TTS 引擎选择 | `product/web/src/features/reader/useReaderTts.ts:95,98,103` |
| 错误边界（可复用） | `product/web/src/components/ErrorBoundary.tsx:9-12,18-21`；`main.tsx:533,711` |
| 判据扫描机制 | `product/web/test/run-all.ts:12,15,18-21,25-27`；`product/web/test/discover.ts` |
| 结构判据范例 | `product/web/test/NamingConventions.test.ts:1-4,20-32` |
| 后端边界判据范本 | `product/app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt:24,30,39-56,61-73,78-97,105-120,164-189,198+` |
| 独立开发能力 | `product/web/vite.config.ts:143-145`；`product/web/package.json:17,26-31` |

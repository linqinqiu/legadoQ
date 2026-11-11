# 阅读器改造史（历史归档）

> **历史快照**：本文由 7 份旧阅读器规划/设计/验证文档（v0.8.4 基线 → P1 地基期，2026-10-23/24）合并而成。
> 其中的规模数字、文件行数与实现细节均已过期；**现行能力看 `docs/STATUS.md`，规模数字看
> `product/docs/restructure/facts.md`**，本文仅作过程留痕，不再追改。

## 时间线

| 日期 | 原文件 | 内容 |
|---|---|---|
| 2026-10-23 | reader-archive.md | 阅读器功能归档（v0.8.4 基线） |
| 2026-10-23 | reader-redesign-plan.md | 阅读器改造方案 |
| 2026-10-24 | reader-redesign-roadmap.md | 分阶段实施路线图 |
| 2026-10-24 | reader-p1-requirements.md | P1 地基 · 需求 |
| 2026-10-24 | reader-p1-design.md | P1 地基 · 设计 |
| 2026-10-24 | reader-p1-tasks.md | P1 地基 · 任务 |
| 2026-10-24 | reader-verification-plan.md | 重构验证与测试规划 |

---

<!-- 来源：docs/archive/reader-archive.md -->

## 青阅阅读器 · 功能归档（v0.8.4 基线）

> 目的：把当前阅读器界面**已经有什么**逐项清点成档，作为重做的基线。
> 本文**只描述现状，不提改造建议**。改造方案另见 `docs/reader-redesign-plan.md`。
>
> 代码基线：`legado/web/src/reader/` 共 35 个文件约 6,200 行，核心 `ReaderScreen.tsx` 2,518 行。
> 服务：`http://127.0.0.1:1234` v0.8.4。所有 `文件:行` 为本次实测行号。

---

### 0. 文件清单（按体量）

| 文件 | 行数 | 职责 |
|---|---:|---|
| `ReaderScreen.tsx` | 2,518 | 阅读器主组件（单文件巨头） |
| `ttsEngine.ts` | 586 | 三种朗读引擎的统一会话层 |
| `readerSettings.ts` | 478 | 全部设置项的 schema / 默认值 / 读写清洗 |
| `TtsSettingsModal.tsx` | 340 | 朗读设置弹窗 |
| `useReaderTts.ts` | 335 | 朗读的 React 装配 |
| `TapZoneEditor.tsx` | 198 | 点击区域可视化编辑器 |
| `tapZones.ts` | 193 | 点击分区数据模型与命中判定 |
| `ttsBarPosition.ts` | 185 | 朗读悬浮条拖动 + 位置持久化 |
| `readerFlow.ts` | 180 | 章节流与跨章续接 |
| `readerInteractions.ts` | 177 | 点击 / 滚轮 / 手势 |
| `TtsPlayerBar.tsx` | 147 | 朗读悬浮条 UI |
| `OtherSettingsPanel.tsx` | 131 | 「其它」设置页 |
| `VirtualChapterList.tsx` | 130 | 目录虚拟滚动 |
| `ttsTextProcessor.ts` | 128 | 朗读文本预处理 |
| `scriptConvert.ts` | 125 | 简繁转换 + 词典 |
| `Md3Chrome.tsx` | 116 | 顶栏 / 底栏 / MD3 风格件 |
| `shortcuts.ts` | 107 | 快捷键表 |
| `noteExport.ts` | 84 | 笔记导出 Markdown |
| `virtualSlice.ts` | 76 | 虚拟滚动切片 |
| `MediaBlock.tsx` | 61 | 音频 / 视频 / 漫画媒体块 |
| `TocDrawerHeader.tsx` | 58 | 目录抽屉头 |
| `ReaderHeader.tsx` | 57 | 阅读器顶栏 |
| `NotesPanel.tsx` | 48 | 笔记面板 |
| `NoteToolbar.tsx` | 46 | 划线浮层 |
| `ReaderSettingsControls.tsx` | 45 | 设置控件 |
| `readerMenu.ts` | 43 | 工具栏可配置项 |
| `ShortcutHelp.tsx` | 39 | 快捷键帮助 |
| `pageTurn.ts` | 39 | 翻页动画 |
| `readerProgress.ts` | 36 | 进度上报 |
| `ReaderSheet.tsx` | 34 | 底部弹层 |
| `ReaderContentSkeleton.tsx` | 24 | 正文骨架屏 |
| `contentImages.ts` | 22 | 正文图片处理 |
| `paragraphs.ts` | 19 | 段落切分 |
| `readerImage.ts` | 15 | 单图加载 |
| `fontSizeControl.ts` | 14 | 字号步进 |
| `IconButton.tsx` | 6 | 图标按钮 |
| `openBook.ts` | 4 | 开书参数 |

---

### 1. 翻页（用户点名）

#### 1.1 两种模式
- `pageMode: 'scroll' | 'paginate'`，默认 `scroll`（`readerSettings.ts:137`）
- 切换入口在设置面板「行为」页签

#### 1.2 滚动模式
- 一次渲染「锚点章 + 续接的两章」，章间用一条细分隔线标示换章（`styles.css` 正文注释）
- `readerFlow.ts` 负责跨章续接：`flowAdvance` / `holdScroll`，`holdBack = 24px`
- 章节边界有 `break-before: column` 保证分栏流里每章从新栏开头（`measurePagination` 依赖它算每章占哪几页）

#### 1.3 分页模式
- `PageSpan`（页区间）+ `pageAlignmentPads`（栏对齐）
- 栏数由视口宽度与 `--reader-max-width` 决定；`isDoubleColumnActive` 判据是视口 `>=800`
- 翻页动画 `pageAnim`：`slide`（默认，整条栏流滑过去）/ `fade` / `cover` / `none`，只在逐页翻（`|to-from|===1`）时生效
- 仿真卷页**未实现**（注释明说「要 canvas 逐帧重画，先不承诺」，但值域留好了）

#### 1.4 滚轮翻页
- `readerInteractions.ts` 的 `paginateWheelStep`：累计 delta，固定步长 `step=48px`
- 滚轮在分页模式下翻页、滚动模式下滚动

---

### 2. 固定 / 钉住（用户点名）

- `sidebarPinned: boolean`（默认 `false`，`readerSettings.ts:142`）
- 钉住时目录抽屉常驻左侧，正文让位；未钉住时抽屉是浮层，带 `translateX` 进出动画
- `sidebarWidth: number`（默认 300，范围 220–560）—— 目录与正文的边界**可左右拖**
  （`ReaderScreen.tsx` 的 `reader-sidebar-resizer`，CSS z-index 22）
- 钉住时抽屉 z-index 从 30 降到 21（刻意：钉住时它在正文内，不是浮层）
- 顶栏 / 底栏显隐：`.reader-workspace.toolbars-hidden` 类控制，阅读中自动隐藏、点正文唤出

---

### 3. 缓存（用户点名）

- 数据来自 `GET /api/bookshelf` 的 `cachedChapters` / `totalChapters` / `cacheState` / `cacheError` / `tocUpdatedAt`
- `cacheState`: `idle` / `caching` / `done` / `error`
- 书架卡片显示「缓存 N / M 章」，失败显示「中断：<原因>」
- 目录抽屉页脚有「离线缓存 · 这本书」折叠区，默认收起（只露一行）
- `VirtualChapterList.tsx` 里已缓存的章节有 `.cached` 徽标
- 书架页有批量管理（批量删除 / 移组 / 标已读）

---

### 4. 排版设置（`readerSettings.ts` 478 行）

| 设置项 | 类型 | 默认 | 范围/取值 |
|---|---|---|---|
| `theme` | string | `light` | 内置 7 套 + 自定义皮肤 id |
| `customSkins` | `CustomSkin[]` | `[]` | id / name / css(≤20000) / base |
| `fontSize` | number | 19 | `READER_FONT_SIZE_MIN..MAX` |
| `lineHeight` | number | 1.95 | 1.45–2.4 |
| `letterSpacing` | number | 0 | -0.25–1.5 |
| `paragraphSpacing` | number | 1.15 | 0.7–2 |
| `textIndent` | number | 2 | 0/1/2 三档 |
| `contentPadding` | number | 80 | 20–120 |
| `font` | enum | `song` | song/hei/kai/fangsong/system/yuan/mono/custom |
| `customFont` | string | `''` | 本机字体名，滤 `{}<>@;\` |
| `pageMode` | enum | `scroll` | scroll/paginate |
| `pageAnim` | enum | `slide` | slide/fade/cover/none |
| `maxWidth` | number | 860 | 560–1400 |
| `columnMode` | enum | `auto` | auto/single/double |
| `textAlign` | enum | `justify` | justify/left |
| `sidebarPinned` | boolean | `false` | — |
| `sidebarWidth` | number | 300 | 220–560 |
| `readerBgColor` | string | `''` | #RGB/#RRGGBB/#RRGGBBAA |
| `readerBgImage` | string | `''` | http(s) / 站内 / data:image |
| `readerBgDim` | number | 0.25 | 0–0.6 |
| `tapZones` | `{paginate,scroll}` | 见 §5 | — |
| `menuItems` | `ReaderMenuAction[]` | 出厂那一排 | 见 `readerMenu.ts` |
| `scriptMode` | enum | `off` | off/s2t/t2s |

设置面板三个页签：`TypographyTab`（排版）/ `ColorTab`（颜色）/ `BehaviorTab`（行为），
另有 `OtherSettingsPanel`（其它）。控件统一走 `SettingRow` / `ReaderSettingsControls`。

---

### 5. 点击区域（手势）

- `TapMap = { x: number[]; y: number[]; actions: TapAction[] }` —— **虚线表**，两种翻页方式各一张
- `TapAction`：`previous` / `next` / `toggle` / `toc` / `settings` / `none`
- `MIN_CUT_GAP = 0.04`（切割线最小间距）、`MAX_CUTS = 5`（最多 5 条）
- `TAP_PRESETS` 提供若干预设方案
- `TapZoneEditor.tsx` 是可视化编辑器：横竖虚线可拖，实时预览
- 旧版「格子表」（`{rows,cols,actions}`）读时自动迁成虚线表
- 判定：`zoneAt(map, px, py, w, h)`

---

### 6. 朗读

#### 6.1 三种引擎（`ttsEngine: 'edge' | 'webSpeech' | 'custom'`）
- `edge`：Edge TTS（默认）
- `webSpeech`：浏览器 Web Speech API
- `custom`：自定义 HTTP 源（url / method / body / header / voice 各自独立）

#### 6.2 音色与参数
- `ttsVoice` / `ttsSpeed`(0.5–3.0) / `ttsPitch`(0.5–1.5)
- 自定义引擎用独立的 `ttsCustomVoice`（**刻意不共用** `ttsVoice`，避免把 Edge 音色 id 发给用户自己的服务）

#### 6.3 行为
- `ttsAutoNextChapter`：跨章连播（默认开）
- `ttsFilterSymbols`：滤掉装饰符号
- `TtsSettingsModal.tsx` 是设置入口

#### 6.4 悬浮条
- `TtsPlayerBar.tsx` + `ttsBarPosition.ts`：长按 250ms + 9px 容差触发拖动
- 位置持久化 `legado-tts-bar-pos`，重置键 `legado-tts-bar-reset`
- 挂载时夹回视口（`useClampOverlay`）

#### 6.5 会话
- `ttsEngine.ts` 的 `sessionSettingsKey` 与 `readerSettings.ts` 的 `ttsSessionKey` 是同一件事的两个名字 —— 任一項变，正在播的音频流推倒重来（防两条声音叠在一起）

---

### 7. 笔记 / 划线

- `NoteToolbar.tsx`：选中正文后弹出，写备注（留空即纯划线）、保存 / 删除 / 取消
- `NoteDraft`：id / chapterIndex / chapterUrl / startOffset / endOffset / excerpt / text / x / y
- 偏移是**章节内字符偏移**（不是像素/列号）—— 字号分栏一改位置就跳，这是老教训
- `NotesPanel.tsx`：这本书的全部划线，点一条跳到那一章
- `noteExport.ts`（新增）：导出 Markdown，原文进引用块、备注跟在下面，章名取不到退回「第 N 章」
- **选区已与 AI 打通**：`lib/selectionStore.ts` 把选区提到组件外，AI 悬浮球读得到「你选了哪段」

---

### 8. 目录

- `VirtualChapterList.tsx`：虚拟滚动（`virtualSlice.ts` 切片），大目录不卡
- `TocDrawerHeader.tsx`：目录抽屉头，含**倒序开关**与**钉住开关**
- 章节搜索框
- 已缓存章节有徽标
- 抽屉页脚「离线缓存 · 这本书」折叠区

---

### 9. 简繁转换

- `scriptMode: 'off' | 's2t' | 't2s'`，只换字形不换词
- 词典在 `scriptConvert.ts`，约 200KB，**开了才载**，默认不进首屏
- 正文与章名一起转（只转正文会出现「标题简体、正文繁体」）

---

### 10. 媒体

- `MediaBlock.tsx`：音频 / 视频 / 漫画逐图
- `contentImages.ts` / `readerImage.ts`：正文配图加载、点击放大、取失败的兜底行
- 漫画源（`bookSourceType=2`）走图片代理
- `mediaUrl` 非空时渲染播放器而不是把地址当正文排出来

---

### 11. 快捷键

- `shortcuts.ts`：`READER_SHORTCUTS` / `GLOBAL_SHORTCUTS` / `SHORTCUT_TABLES`
- `normalizeKey` / `isTypingTarget` / `shortcutFor`
- `?` 打开速查表（`ShortcutHelp.tsx`）
- **键位硬编码，不可自定义**

---

### 12. 进度

- `readerProgress.ts`：滚动位置归一化 `scrollPosition(scrollTop, scrollHeight, clientHeight)`
- 章节内进度 + 章进度，节流后上报 `POST /api/reading-progress`
- 底部进度条 `chapter-progress` / `chapter-scrub`（可拖）
- 阅读记录按「一天 · 一本书」累加秒数（`reading_log` 表）

---

### 13. 界面骨架

- `ReaderHeader.tsx`：顶栏（返回 / 书名 / 更多）
- `Md3Chrome.tsx`：MD3 风格件 + `Md3BottomBar` / `Md3TopBar`
- `ReaderSheet.tsx`：底部弹层
- `ReaderContentSkeleton.tsx`：正文骨架屏
- 桌面端：`.reading-content` 宽 `min(var(--reader-max-width), calc(100% - pad*2))`、`margin: 0 auto` 居中
- 移动端：`.mobile-reader-nav` 仅 `max-width:720px` 显示；`.desktop-pin-btn` / `.desktop-reverse-btn` 仅 `min-width:721px` 显示

---

### 14. 阅读器与 AI 的接合

- `main.tsx` 的阅读器分支**也挂了** `<AiFloatingBall uiContext={currentUiContext} />`（0.8.5 修）
- `uiContext` 在阅读器里带：`book{sourceId, bookUrl, name, author, chapterIndex, chapterTitle}` + `selection{text, fullLength, chapterIndex, chapterTitle}`
- 面板上显示「正在看：《书名》第 N 章 · 选中的 N 字」，鼠标悬停可见选中原文

---

### 15. 读代码时发现的粗糙处（只记录，不评判）

1. **`ReaderScreen.tsx` 2,518 行单文件** —— 顶栏、抽屉、设置面板、TTS、笔记、目录、手势全在一个组件里。
2. **`readerSettings.ts` 478 行** —— 设置项 schema、清洗函数、皮肤库、字体表、TTS 会话键全在一处。
3. **`--elev-*` 阴影令牌在暗色主题下有三份重复定义**（`styles.css` 中同一变量被定义三次）。
4. **`z-index` 字面量 37 处、25 个不同数值**（2 → 9999），无分层令牌。
5. **断点零散**：`max-width` 640px×13、720px×10、768px×2、900/760/420px 各×1；`min-width` 960px×2、1200/721px 各×1。
6. **`pageAnim` 的仿真卷页是空头支票** —— 值域留了，渲染没做，注释也明说。
7. **快捷键不可自定义** —— 表是硬编码的 `READER_SHORTCUTS`。
8. **`ttsEngine.ts` 586 行** —— 三种引擎的会话管理、队列、停顿看门狗全在一处。
9. **正文配图取失败时只有一行文字兜底**，没有重试按钮接进阅读器内（`reader-image-failed` 有样式，动作在别处）。
10. **`--t-s` / `--ink-dim` / `--text` 三个未定义令牌的引用已在 0.8.5 修掉**，但说明这类问题会反复出现（没有「令牌必须已定义」的静态判据）。

---

### 16. 一页总览

```
阅读器
├── 翻页          滚动 / 分页两模式；4 种翻页动画；滚轮翻页固定步长 48px
├── 固定          目录可钉住、边界可拖（220–560px）；顶/底栏自动显隐
├── 缓存          服务端按章缓存；书架卡显示 N/M 章；目录有 cached 徽标
├── 排版          23 个可配项；7 套内置皮肤 + 无限自定义皮肤；背景色/图/压暗
├── 点击区域      虚线表可编辑，两种翻页方式各一张，最多 5 条切割线
├── 朗读          3 种引擎；跨章连播；悬浮条可拖动可记忆；定时
├── 笔记          划线 + 备注；Markdown 导出；选区与 AI 打通
├── 目录          虚拟滚动；倒序；章节搜索
├── 简繁          简→繁 / 繁→简，200KB 词典按需载
├── 媒体          漫画逐图、音频、视频
├── 快捷键        两套表 + 速查表（键位不可改）
├── 进度          章内 + 章进度；阅读记录按天累加
└── AI 接合       悬浮球常驻；带书名/章节/选中文本
```

---

<!-- 来源：docs/archive/reader-redesign-plan.md -->

## 青阅阅读器 · 改造方案（reader-redesign-plan）

> **目的**：把 [`reader-archive.md`](reader-redesign-history.md)（v0.8.4 现状清点）转成**可执行改造方案**。
> 本文件只讲「做什么 / 为什么 / 顺序 / 验收 / 红线」，不动手改代码。
> 细节论据、file:line、接口草图、门禁补丁均来自 `docs/research/01~07`，本文件只做汇总与编排。
>
> **基线**：v0.8.4（`VERSION` = `0.8.4`，服务 `http://127.0.0.1:1234`）。
> 代码基线：`legado/web/src/reader/` 35 文件约 6,200 行，核心 `ReaderScreen.tsx` 2,518 行。
> 关联：研究纪要 `docs/RESEARCH-NOTES.md` §8（框架纪律）、`docs/STRUCTURE.md`（目录与禁令）。
>
> ⚠️ **行号时效**：各研究报告的 `文件:行` 来自不同快照，`styles.css` 在审计期被追加 AI 悬浮球约 +78 行、另有成员 +77 行，**行号已漂移**。动手前一律先 `git diff` 复核，勿直接照抄行号。

---

### 0.1 阅读器增强 · 本会话实现追踪（2026-10 起，goal round 1–8）

> 以下均为**纯前端、可 `tsc`/门禁验证**的增强，全部 `npm run check` 退出 0、`npm test` 682 pass/0 fail。门禁纪律（UiContract / overlay-tier-check / CopyStyle / FrameworkHasNoContent / ApiCatalog）全程守住：未新增外壳/遮罩、未用装饰字形、未写未定义 CSS 令牌、未加任何 HTTP 路由。

| # | 增强 | 落点 | 复用既有 |
|---|---|---|---|
| 1 | 划线/标记菜单（划线/笔记/复制/AI） | `MarkingMenu.tsx` + `ReaderScreen` | `Select`/`toast`/令牌 |
| 2 | 阅读专属配色（护眼暖黄/豆沙绿/夜间黑读，只染阅读区） | `readerSettings.ts`/`ColorTab.tsx`/`styles.css` | `--surface/--line/--accent-*` |
| 3 | 顶栏一键护眼/夜间快捷开关（四态循环） | `Md3Chrome.tsx`/`ReaderScreen` | `md3-icon-btn`/`is-active`/`eye`/`moon` |
| 4 | 右键菜单补全划线/笔记/AI（抽 `buildSelectionDraft`） | `ReaderScreen` `onBodyContextMenu` | `ContextMenuItem`/`showContextMenu` |
| 5 | 目录当前章内进度指示 | `VirtualChapterList.tsx` `CurrentChapterProgress` | `readerProgress`（`getServerSnapshot` 过 SSR） |
| 6 | 目录已读/未读区分 | `VirtualChapterList.tsx` + `styles.css` | `--ink`/`--muted` |
| 7 | 目录头部全书已读比例 | `TocDrawerHeader.tsx` `overallProgress` | `color-mix`+`--accent` |
| 8 | 右键菜单「复制为引用」 | `ReaderScreen` `onBodyContextMenu` | `book` 图标/clipboard/toast |
| 9 | **书签**（后端 + 前端打通） | `Models.kt`/`ReadingDao.kt`/`Database.kt` + `MarkingMenu.tsx`/`NotesPanel.tsx`/`api.ts` | 复用 notes 表（新 `bookmark` 列 + 迁移 + `addNote/listNotes` 持久化）；前端 标记菜单/右键「书签」+ 笔记面板「全部/书签」过滤 + 书签徽标 |
| 10 | **搜索本书**（后端 + 前端打通） | `Models.kt`/`ReadingDao.kt`/`ProgressRoutes.kt`/`agent-api.json` + `api.ts`/`BookSearchDialog.tsx`/`Md3Chrome.tsx`/`ReaderScreen.tsx` | 新增只读路由 `GET /api/book-search`（目录总数 139→140，闸门同步）；查 `book_content_cache` 已缓存章节正文；底栏「搜书」打开弹窗，命中切章 |
| 11 | **阅读器 AI 闭环**（后端 + 前端打通） | `Models.kt`/`Database.kt`/`CacheDao.kt`/`ReadingRoutes.kt`/`agent-api.json` + `api.ts`/`ReaderAiDialog.tsx`/`Md3Chrome.tsx`/`ReaderScreen.tsx` | 新增 `book_content_process` 覆盖表 + DAO；`POST/DELETE /api/books/content-process`（目录总数 140→142，闸门同步）；`POST /api/books/content` 读路径叠 AI 覆盖；顶栏「AI 净化/润色本章」弹窗，落库后正文实时重载（所见即所得），可撤销 |

**已核对「无需再动」**：键盘导航（翻页/章节/字号/主题/TOC/设置/TTS/全屏，见 `ReaderScreen` `onKeyDown`）、点屏中央切工具栏（`toolbarsVisible`）、TTS 设置弹窗（`TtsSettingsModal.tsx` 已完整）、翻页/固定/缓存（见 `reader-archive.md`）。

**后端缺口（仍待定）**：仿真卷页（唯一缺失翻页动画，需 canvas，高风险）。（搜索本书、阅读器 AI 闭环已于本轮补齐：前者只读路由 `GET /api/book-search`，后者 `book_content_process` 覆盖表 + `POST/DELETE /api/books/content-process` 落库重载，目录总数现为 142，闸门同步。）
> 书签此前被误判为「需 Kotlin 不可验」，但本环境已验证 `gradlew :app:compileKotlin` 可离线编译（JDK17 在 `E:\Apps\DevTools\Eclipse Adoptium`），故书签已落地并编译通过。印证：`icons.tsx` 的 `bookmark` 图标此前是「计划内未实现」，本轮补上。

---

### 0. 与现状清点、研究纪要的关系

| 文档 | 角色 | 本方案如何引用 |
|---|---|---|
| `reader-archive.md` | **现状基线**（只描述有什么） | 所有「当前行为」以它为准；本方案 §3–§6 的「现状」列均回指它 |
| `research/01` AI 位置与阅读问题核实 | R1 核实 | 阅读器 AI 闭环的「已完成 / 真缺口 / 非缺陷」判定 |
| `research/02` 界面可塑性优化 | R2 主题 | 令牌、主题包、性能/规模量级差论证 |
| `research/03` 悬浮层延展 | R3 主题 | z-index 令牌化、OverlayHost、门禁冲突 ledger |
| `research/06` AI 与插件能力核实 | R1 核实 | AI 工具 vs 端点缺口、插件脚手架缺口 |
| `research/07` MD3 借鉴与阅读器 AI 增强 | R1 设计 | 阅读器 AI 正确形态、划词闭环模板、不适用清单 |
| `RESEARCH-NOTES.md` §8 | 框架纪律 | 本方案 §1 的全部红线来源 |
| `AI 与插件框架全面审计报告`（2026-10-22，本次会话） | 连接选择/SSRF/连接 UI/插件可见性/契约一致性/工具上限 | 主题 D 新增项（§6.9–§6.12），并补 §7 门禁与 §9 不要做 |

---

### 1. 设计红线（不可违反）

本方案的任何一条实现都不得突破以下红线。它们不是风格，是**用判据测试落地的硬约束**（详见 RESEARCH-NOTES §8）。

1. **不新增第二套外壳**。浮层外壳只有 `.dialog-shell` / `.reader-drawer` / `.tts-floating-bar` 三档（`UiContract.test.ts:290-293` 的 `SHELL_WHITELIST`）。新增弹窗一律套 `.dialog-shell` + `.size-s|m|l`；不新增 `.overlay-backdrop` 变体；不新增第二套前端/后端。
2. **框架只立钩子、不夹带内容**（RESEARCH-NOTES §8.1）。`lab/`、`extensions/` 不依赖 `plugins/`、`features/`；AI 是**功能条目**（`features/ai`），不是插件；扩展只能以「工具 / 实验条目 / 设置分区 / LLM 协议」形态注入。
3. **扩展不增 HTTP 路由（默认）**。插件与 AI 工具只往 `ToolRegistry` 加能力，不产生新 `/api/*`；若确需新路由，必须同步 `agent-api.json` 并跑 `ApiCatalog.test.ts`，且把 `web/test/ApiCatalog.test.ts` 的钉死计数同步 +1 并说明（当前全量契约 142 端点 / 19 组）。
4. **依赖方向单向**：内容 → 框架。改 `lab/`、`extensions/`、`plugin/` 前先看 `FrameworkHasNoContent.test.ts`。
5. **改动必须同步门禁**。每条「需改测试闸门」的项，实现与判据补丁**同一提交**，否则 CI 必红（见 §7 门禁清单）。
6. **令牌必须已定义**。不在 `:root` 定义的 `--x` 被 `var()` 引用 = 声明作废（reader-archive §15.10 教训，P0-4 真 bug）。新增令牌先定位置（三处 `:root` 块之一）。
7. **不用装饰字形、不写死版本号、不用 `export default`**（`CopyStyle.test.ts` / `HeaderMenu.test.ts` / `NamingConventions.test.ts`）。图标一律 `<Icon name>`。
8. **存储键迁移不破坏数据**。改 `localStorage` 键名须「读旧、写新、不删旧」，配迁移函数（§4.1）。

---

### 2. 总览：四大主题与排序原则

#### 2.1 排序原则（已论证是量级差）

R2 §5.1 独立复核结论：**性能 / 规模问题 > 主题可塑性**，不是小幅领先：

| 维度 | 性能/规模（§3 主题 A） | 主题可塑性（§4 主题 B） |
|---|---|---|
| 受影响用户 | **100%**（默认搜索即全库扫描） | 少数换肤/换密用户 |
| 单次损失 | 约 **25 分钟**等待，且 `selfcheck` 2 FAIL 证明默认路径走不通 | 无损失，只是「没得选」 |
| 是否阻断核心价值 | **是**（源→书转化链断） | 否（7 套皮肤够日常） |
| 修复成本 | 前端小改 + 后端 1 个字段 | 需 650 处令牌替换打底 |

> 一句话：**规模治理是雪中送炭，主题可塑性是锦上添花**。Z/G 档可塑性可排进同迭代后半段（互不阻塞），**但 P0 量级问题不能后放**。唯一可并行的例外是 R2 的 **Z1**（一行零风险对比度引线修复）。

#### 2.2 四大主题

- **主题 A — 性能与规模治理（P0 量级）**：默认搜索全库 ≈25 分钟、书源健康度不回灌、列表无虚拟滚动。
- **主题 B — 界面可塑性（R2）**：配色已成熟（62 令牌），空洞在动效令牌 / 密度令牌 / 主题包 / 几何采纳率。
- **主题 C — 悬浮层 / 覆盖层系统（R3）**：几何已收口，层级 / 位置 / 生命周期各写各的。
- **主题 D — 阅读器 AI 增强（R1/06/07）**：已完成「位置」（阅读器挂 AI 球），缺口在「对应地点研究」闭环、AI 工具与端点对齐、插件脚手架。

#### 2.3 合并优先级表（P0→P2）

| 优先级 | 主题 | 事项 | 档位 | 依赖 |
|---|---|---|---|---|
| **P0** | A | 默认搜索范围改「分组」+ 量化成本预期（不再是全库扫描） | 纯前端 | 无（会红 `SearchStatePersistence.test.ts:39`） |
| **P0** | A | 书源健康度进 `/api/sources`（`SourceSummary.health`）+ 前端徽标/排序 | 架构级 | 后端排期 |
| **P0** | B | Z1：对比度引线 + `var(--text)` 无效声明（一行×4） | 零风险 | 无 |
| **P0** | B | Z2：收编 8 个僵死令牌（3 个当前生效 bug） | 零风险 | 无 |
| **P0** | C | 清账：删 `.fw-*`/`.lab-*` 死样式、修「界面偏好」说谎控件、修 AI 面板宽度覆盖 | 零风险 | 无 |
| **P0** | D | 阅读器 AI 工具 `ai.textClean` / `ai.text Rewrite`（选中→净化/润色→落库→重载） | G2 后端 | 无 |
| **P0** | D | 参考上下文 `referenceText`（让模型知「你正在看哪里」） | G2 后端 | 无 |
| **P0** | D | 书源分组 AI 工具（两报告一致） | 后端 | 无 |
| **P0** | D | 进度保存补 `set` 工具（仅 06 发现：只有读无写） | 后端 | 无 |
| **P0** | D | **SSRF 防护**：`OpenAiCompatibleProvider` 外呼 `baseUrl` 前拒绝内网/保留地址（`127.0.0.1`/`169.254.x`/`0.0.0.0`/localhost） | 后端 | 新增 Guardrail + 判据 |
| **P1** | A | 书源列表虚拟滚动、结果区「还在搜 N 个慢源」+「不等了」 | 架构级 | A 后端 |
| **P1** | B | Z3：字面量→令牌（650 处，机械替换） | 零风险 | 无 |
| **P1** | B | G1：动效令牌（5 令牌 + 5 处替换 + 新判据） | 需加判据 | Z3 无关可并行 |
| **P1** | B | G3：`useOverlayFocus` + 8 个单例弹窗接入 | 需加 hook | 无 |
| **P1** | B | G2：主题包 schema + 导入导出 + 判据 | 需加判据 | Z3（密度部分） |
| **P1** | B | G4：断点收敛到 4 档 + 新判据 | 需改现有 5 处 + 新判据 | 先 11 档普查 |
| **P1** | C | z-index 令牌化（37→`--z-*`，价值最高） | 需改 UiContract 两处正则 + 自证 | 清账在前 |
| **P1** | C | 拖动 + 吸附 + 持久化（`useOverlayDrag`） | 零门禁冲突 | 清账在前 |
| **P1** | C | 焦点陷阱 + 滚动锁 | 纯行为 | 无 |
| **P1** | D | 划线/标记菜单（选中即现）、朗读胶囊、阅读专用配色/护眼、逐章进度同步 | G2 | 无 |
| **P1** | D | 朗读/备份/`source.switch` 的 AI 工具对齐 | 后端 | 无 |
| **P1** | D | 连接与工具管理 UI：默认连接设置 + 实测探测 + 删除后自动 refresh + API Key 掩码/轻混淆 + 系统提示词模板 + 悬浮球增强（拖拽记忆/隐藏/多会话） | 前端 | 无 |
| **P1** | D | 插件来源标注（`manifest` 标 `source:plugin:xxx`）+ 插件事件订阅可视化 | 前端+后端 | 无 |
| **P2** | A | 搜索两阶段（先健康源后慢源） | 架构级 | A 后端 |
| **P2** | B | Z4/Z5/Z6：文案漂移、40 处内联样式收编、触屏 hover 补齐 | 零风险 | 无 |
| **P2** | B | A4：偏好统一存储层 + 迁移 | 架构级 | Z/G 落完 |
| **P2** | B | G2 延伸：密度/圆角偏好 UI | 需 G2 | Z3 + G2 |
| **P2** | C | `OverlayHost` 统一挂载、多实例并存 | 中（动 main.tsx） | 清账在前 |
| **P2** | C | 可调整大小面板（需改 `overlay-tier-check.mjs`） | 高（改门禁） | C 清账 |
| **P2** | C | dock 层 / 插件 dock 入口 | 中（须定 `--z-dock` 取值） | 清账 + 层级令牌化 |
| **P2** | D | 翻译胶囊、插件脚手架 + 示例 + 文档 | G2 | 无 |
| **P2** | D | Agent 工具上限可配置（`MAX_TOOL_ROUNDS`/`MAX_TOOL_DATA` 提至 AppConfig）+ 长文本摘要模式 | 后端 | 无 |
| **P2** | D | 发行版版本号显示（`BuildInfo.version` 在 `jar` manifest 落地，与 `agent-api.json` 一致） | 后端 | 无 |
| **—** | C | 统一 Esc 层栈（替换 4 种手写写法） | 高（`UiContract:559-601` 钉函数名） | **不建议做** |

---

### 3. 主题 A — 性能与规模治理（P0 量级）

> 论据：R2 §2.0、§2.2 P0-1/P0-2、§5.1。这是用户「每次搜索都踩」的阻断性问题。

#### 3.1 现状（来自 archive + R2）
- 书源 **5,598 条**，默认 `scopeMode:'all'`（`searchStore.ts:179`）→ 一次默认操作 ≈ **25 分钟**，`selfcheck` 2 FAIL。
- 体检结论只进 `localStorage` 的 `legado.health.baseline`，书源列表（`SourcesPage.tsx:190-195`）只统计 `total/enabled/login/groups`，**健康度不回灌**——5,598 条源在列表上无健康区分。
- 列表无虚拟滚动，`SOURCE_PAGE_SIZE=120`，5,598 条需 46 次「加载更多」。

#### 3.2 改造项
- **A-1（P0，纯前端）**：默认搜索范围改为「按分组」或「健康源优先」；搜索前显示「将搜索 N 个源，约 X 分钟」量化预期。⚠️ 会红 `SearchStatePersistence.test.ts:39`（钉 `'all'`），同步改断言。
- **A-2（P0，架构级）**：`SourceSummary` 增 `health?: { tier: HealthTier; checkedAt: number; latencyMs?: number } | null`（`api.ts:10` 只增字段，不破 139 端点契约）。前端书源列表加健康度徽标（`--tier-good/pending/bad` 色点，用语义色非裸 hex）+ 按健康度排序 + 「只搜健康源」开关。
- **A-3（P1，架构级）**：书源列表虚拟滚动；结果区标「还在搜 N 个慢源」+「不等了」按钮。
- **A-4（P2，架构级）**：搜索两阶段（先健康源后慢源，涉及 WS 或两次连接）。

#### 3.3 验收
- [ ] 5,598 条库上：默认范围不再等于全库；界面给出「将搜索 N 个源」量化预期。
- [ ] 书源列表一眼看出哪个源是活的（健康度徽标 + 排序）。
- [ ] `selfcheck` 红线恢复绿。

---

### 4. 主题 B — 界面可塑性（R2）

> 论据：R2 全文。配色维度已成熟（62 令牌、2,066 次 `var()`、7 套内置皮肤 + 不限量自定义皮肤库），空洞在**动效令牌 / 密度令牌 / 主题包 / 几何采纳率**。

#### 4.1 零风险档（Z，不改测试、不改行为）
- **Z1（P0，一行×4）**：删 `.primary-button` 的 `--accent`+`#fff` 引线（`styles.css:398`，夜读对比 1.54 靠 L4467 后置覆盖压住，CSS 重排即复燃）；把 `color: var(--text)` 改为 `var(--ink)`（`:4103/4107`，`--text` 不存在→声明作废）。验收：`node --test` 全绿 + 夜读确认主按钮仍是 `--accent-solid`+`--on-accent`。
- **Z2（P0）**：收编 8 个僵死令牌：在 `:root` 补 `--ink-soft/--ink-dim/--warn`、把 `--t-s`→`--t-sm`（手误 bug）、`--accent-line`→`var(--line)`、`--ctl-34`→`--ctl`、`--ctl-md` 新增 `38px`。其中 3 个无 fallback 是当前生效 bug。
- **Z3（P1）**：字面量→令牌，**只做值与某令牌逐字符相等的声明**（不含 `padding` 复合值）：`font-size` 335 处、`border-radius` 128 处、`gap` 187 处，合计 **650 处**。替换前后脚本展开 `var()` 比对必须逐字节相同。这是密度/圆角偏好的前置条件。
- **Z4（P2）**：修设置页「三档」文案漂移（`settingsSections.ts:53` → 不写死数量）。
- **Z5（P2）**：`ReplaceRulesModal.tsx` 40 处内联样式收编为语义类（注意 `UiContract.test.ts:449-469` 扫类名，新增类须同时加样式规则）。
- **Z6（P1）**：触屏 `hover:none` 补齐（目前仅 2 处，全站大量 `:hover` 在移动端粘住）。

#### 4.2 需改测试闸门档（G，必须同提交）
- **G1（P1）动效令牌**：`styles.css :root` 追加 `--dur-fast/.18s`、`--dur-base/.25s`、`--dur-slow/.4s`、`--ease-out`、`--ease-soft`；替换 5 处抽样（`:4577/961/5727/5711/1368`）。**好消息**：动效令牌不碰 `UiContract.test.ts`，比 z-index 令牌化更易落地。新增 `MotionTokens.test.ts`（禁 `transition/animation` 时长位写字面量，允许 `0s/.01ms` reduced-motion 兜底）。
- **G3（P1）焦点归还**：新增 `web/src/lib/useOverlayFocus.ts`（打开移焦入浮层、Tab 循环、关闭归还触发元素；先判 `node.contains(activeElement)` 尊重已有 `autoFocus`）。先改 `main.tsx` 的 8 个单例弹窗（`CustomizeModal`/`LogsModal`/`ShortcutHelp`/`ServerPortModal`/`ChangelogModal`/`BackupModal`/`AboutModal`/`ReadingLogModal`）。零判据冲突（不破 `UiContract.test.ts:170-171`）。
- **G2（P1）主题包 schema**（见 §4.3）。
- **G4（P1）断点收敛**：先 11 档宽度普查脚本截图标真实变化；`640/720` 设主断点，把 `760/768/900/420` 的 5 处迁到最近主动断点；新增判据「宽度断点只许 `640/720/960/1200` 四档」（与迁移同提交，单提即红）。

#### 4.3 主题包设计（G2 核心，可塑性天花板的解法）
新增 `web/src/reader/themeTokens.ts`（camelCase，非 JSX）：

```ts
// 可被主题包覆盖的令牌白名单（只含已有定义，新增令牌须同步加这里）
export type ThemeTokenKey =
  | 'canvas' | 'surface' | 'surfaceMuted' | 'ink' | 'muted' | 'line'
  | 'accent' | 'accentSoft' | 'accentInk' | 'accentSolid' | 'accentSolidHover'
  | 'onAccent' | 'danger' | 'dangerSolid' | 'onDanger' | 'shadow'
  | 'radiusSm' | 'radiusMd' | 'radiusLg' | 'radiusPill'
  | 'spaceUnit' | 'rowHeight' | 'controlHeight'
  | 'fontScale' | 'durationScale' | 'easing'

// 一个主题包：可导出、可导入、可版本化
export type ThemePack = {
  spec: 1
  id: string
  name: string
  base: BuiltinSkinId
  tokens?: Partial<Record<ThemeTokenKey, string>>
  css?: string            // 高级用户历史数据，仍可整段 CSS
  author?: string
  description?: string
}
```

- **与现有类型兼容**：`CustomSkin` 增补可选 `tokens?/author?/description?`，`parseCustomSkin` 条件展开（`...(tokens && Object.keys(tokens).length ? { tokens } : {})`）——`CustomizeSkin.test.ts:80-89` 的 `deepEqual` 旧断言**自动继续通过**，只需加一条新用例。
- **注入**：`composeSkinCss(skin)` 纯函数合成 `.theme-<id>{ decls }` + `css`，经 `SkinStyle` 走 `textContent` 一条路；`sanitizeTokenValue` 必做（颜色只认 `#rgb/#rrggbb/#rrggbbaa/oklch()/color-mix()`，尺寸只认数字+`px/em/rem/%`，剥 `{ } ; < >` 换行）。
- **导出/导入**：`exportThemePack` → `.qingyue-theme.json`；`importThemePack` 整包校验（spec≠1 / id 清洗空 / 无名 / 无 tokens 无 css / 未知令牌 / 非法值全部报错，不做半套）。阈值 `css.slice(0,20000)`、名字 `slice(0,40)`。
- **新增判据**：`ThemePack.test.ts`（白名单与样式表同步、注入走 textContent 且值被清洗）。

#### 4.4 三层用户偏好模型 + 密度圆角落地（G2 延伸，解决 C1 天花板）
- **三层互不混淆**（`web/src/lib/appearance.ts`）：① 主题（ThemePack，长什么样，可导出）② 布局（LayoutPrefs，东西摆哪，收编 `shelfLayout.ts`）③ 阅读（ReaderSettings，正文，本次**不动**）。
- **存储键规范**（`web/src/lib/preferences.ts`）：`qingyue.<领域>.<用途>.v<整数>`，旧键→新键一次性迁移（**读旧写新不删旧**）。现有 14 key / 4 种前缀风格（`legado-`/`legado_`/`legado.`/`qingyue-`/无前缀）统一收口。
- **密度/圆角**：`:root` 加 `--density-scale`/`--r-scale`，`--s-*`/`--r-*` 令牌自身乘比例（就地改写 L4519-4523，**不可再定义一次**）；`--r-pill` 不参与（保持 `999px`）。`main.tsx` effect 扩两行：`root.dataset.density/radius/motion`（走 `data-*` 非 `theme-*` 类，因与皮肤正交）。动效档 `data-motion="off"` 与 `reduced-motion` 兜底取并集。

#### 4.5 验收（R2 §7）
- [ ] `web/test` 全绿；`tsc --noEmit` 零错误。
- [ ] 夜读 / 石墨两套暗色下：主按钮、体检四档徽标、书籍类型徽标、规则调试轨迹色全部可读（实底控件对比度 ≥4.5）。
- [ ] 改密度为 compact：书架/书源/设置三页行高同步收紧，无文字截断。
- [ ] 导出主题包 → 清 localStorage → 导入 → 外观完全一致。
- [ ] 反向对照：故意导入 `spec:2` 的包，必须被拒绝并说清原因。

---

### 5. 主题 C — 悬浮层 / 覆盖层系统（R3）

> 论据：R3 全文。几何已收口得很干净（一档 `.dialog-shell` + 一条 `.overlay-backdrop` + 一颗 `.overlay-close`，两道门禁钉着），但**位置 / 层级 / 生命周期**三件事各写各的。

#### 5.1 阶段 0：清账（不含新能力，纯删减与修复）
| 任务 | 改动 | 风险 |
|---|---|---|
| 0-1 删 `.fw-*` 死样式（约 55 行，`src/` 0 引用） | `styles.css` | 零（无主样式不触发 `UiContract:449`） |
| 0-2 删 `.lab-*` 死样式（约 40 行，逐条核对 `.lab-plugin-*` 仍在用） | `styles.css` | 零 |
| 0-3 决定「界面偏好」去留（`WindowPrefsSection.tsx` 在描述已删除的浮动窗能力，是说谎控件） | `features/settings/`、`builtinSettings.ts`、`main.tsx:449` | 零（建议**删**，与 0-1/0-2 同批） |
| 0-4 修 AI 面板宽度被 `.dialog-shell` 覆盖（`P4`：面板实际 680px 非 420px） | `styles.css` 删 `width` + `AiFloatingBall.tsx` 加 `size-s` | 零（顺手补 `AiFloatingAssistant.test.ts:36` 空断言文案） |
| 0-5 修 AI 球层级与注释矛盾（`.ai-fab`=900 注释却写「低于模态遮罩」） | 等阶段 1 令牌化后写 `var(--z-dock)`/`--z-dock-panel` | 零（单独改无判据读此值） |

> 0-1/0-2 净效果（实测核算）：z-index 字面量 **37→34**、不同数值 **25→24**，为阶段 1 令牌化清掉无主层。

#### 5.2 阶段 1：z-index 令牌化（价值最高，但必须同步改判据）
- **全量映射**（37 处 / 25 数值 → 21 个 `--z-*` 令牌，节选关键映射）：

| 现值 | 语义 | 令牌 |
|---|---|---|
| 2 / 3 / 10 | 组件内部层叠 / 卡片角标 | `--z-inline: 2` |
| 20 | 吸顶/吸底 chrome | `--z-chrome: 20` |
| 26 | 阅读器内浮动件（TTS 条/点击区编辑） | `--z-reader-float: 26` |
| 30 / 28 | 抽屉本体 / 抽屉遮罩 | `--z-drawer: 30` / `--z-drawer-scrim: 28` |
| 38 | 底部弹层 | `--z-sheet: 38` |
| 40 | 笔记浮层 / 顶栏（**40=40 是隐患**，靠 DOM 顺序决胜） | `--z-popover: 400` / `--z-chrome` |
| 100 / 120 | 模态遮罩 / 嵌套遮罩 | `--z-scrim: 100` / `--z-scrim-nested: 120` |
| 200 / 320 / 400 | 菜单 / 右键 / 下拉 | `--z-menu` / `--z-context` / `--z-popover` |
| **900（AI 球，须下调）** | 悬浮球常驻 | **`--z-dock: 60`**（必须在遮罩之下） |
| 1000 | 看图画布 | `--z-viewer: 900` |
| 9999 | Toast | `--z-toast: 1000` |

- ⚠️ **反向陷阱（R3 §3.3，最关键交叉发现）**：`UiContract.test.ts:62-68` 与 `:71-83` 用正则从 CSS 文本读**字面数字**；一旦 `z-index: 26` 改成 `var(--z-reader-float)`，正则匹配不到数字，`bar` 落回 `9999`、`drawer` 落回 `0` → 断言 `9999 < 0` 为假，**判据由绿变红**（实测复现）。**所以令牌化必须连带修改 `UiContract.test.ts` 两处正则 + 补一条负向自证**，否则「令牌与字面量并存」比不改更糟。
- **正确做法**：令牌只定义一处（`:root`），消费处一律 `z-index: var(--z-xxx)`；禁止组件内 `style={{ zIndex: 900 }}`；判据侧改为读 `:root` 令牌值。补丁与负向自证见 R3 §6.1。

#### 5.3 阶段 2：拖动 + 吸附 + 持久化 + 跨页常驻（零门禁冲突）
- 新增 `lib/overlay/overlayDrag.ts`（从 `ttsBarPosition.ts` 抽出 `useOverlayDrag`）。**保留** `ttsBarPosition.ts` 的 `HOLD_MS=250`/`SLOP=9`/`clampPosition`/`legado-tts-bar-reset`/`closest('button,a,input,select,textarea')`——`TtsBarPosition.test.ts:62-81` 逐条正则匹配，只能「抽出去再引回来」不能搬走。
- 几何走 `--ov-*` 自定义属性（非 `left/top` 像素），`overlay-tier-check.mjs` 读 `width` 仍解析为 `min(--dw-N,94vw)`，**拖动完全不影响任何实测断言**。
- `OverlayHost.tsx` 唯一挂载点，替代 `main.tsx` 双份手挂（`ToastContainer` 挂 3 次、`ContextMenuLayer` 挂 2 次）；不动 `openModal` 单例体系（`UiContract.test.ts:559-601` 钉函数名）。

#### 5.4 阶段 3：可调整大小面板（需改门禁）
- 新增 `.tool-panel` 一档（**不是** `.dialog-shell`，且不得同时写 `max-height/border-radius/box-shadow`），`SHELL_WHITELIST` 加它。
- 改 `overlay-tier-check.mjs:206-209`（宽度等式 → 合法区间）与 `:228-235`（全局收口断言排除可缩放层）+ 补负向自证。

#### 5.5 阶段 4：dock 层 / 插件 dock 入口
- `.dock-*` 独立档，**不带 `.overlay-backdrop`**（天然不触发 `overlay-tier-check.mjs:203-205`）；层级取 `--z-dock: 60` / `--z-dock-panel: 61`（**必须在遮罩之下**——模态打开时球应被遮住）。
- 插件注册 dock 入口：`extensions/registry.ts` 增 `dockEntries?: PluginDockEntry[]`，**必须与 `OverlayHost` 的 dock 支持同一提交**（否则是 plugin-framework 批评的「承诺渲染不出来的能力」）。纪律：插件不自带外壳，只 `render()` 内容，外壳/层级/关闭由 `OverlayHost` 给。

#### 5.6 设计红线与状态机
- **不新造外壳**：`OverlayHost` 只做「栈管理 + 事件委派 + 把手套」，渲染仍是现有 `.overlay-backdrop` + `.dialog-shell`。
- **层栈状态机**（`OverlayStack`）：`push(kind)` / `requestClose` / `top` / `snapshot`；Esc 派发修复 P8 四种手写写法；滚动锁/焦点陷阱计数器式（两层 modal 只锁一次）。
- **渐进迁移**：只停在「登记 + dock 层」（R3 §4.5 步骤 1+4），统一 Esc/返回栈（步骤 2-3）收益低、风险高，**不建议做**。

#### 5.7 验收
- [ ] z-index 字面量 0 处（全 `var(--z-*)`）；`UiContract.test.ts` 读令牌值断言全绿 + 负向自证存在。
- [ ] 拖动 TTS 条 / 任意 dock 面板不触发任何门禁；位置记忆跨会话。
- [ ] 模态打开时 AI 球被遮住（层级语义正确）。
- [ ] 键盘 Esc 关嵌套弹窗逐层正确，不一次关两层。

---

### 6. 主题 D — 阅读器 AI 增强（R1 / 06 / 07）

> 已完成（0.8.5，archive §14）：阅读器挂 AI 球 + `uiContext`（含书/章），对话历史跨页跨会话（`aiChatStore` + `localStorage legado.ai.chat.v1`），面板 480px / z=60，测试全绿。
> 真缺口（非缺陷见 §6.5）。

#### 6.1 P0：阅读器内 AI 交互闭环（07 王牌链路）
MD3 `ReadAiDelegate` 的「采上下文 → 发任务 → 防抖 → 确认 → 落库 → 重载」直接可复制到青阅：
1. **校章**：`chapterIndex` 不符则 `showToast("章已切换")` 放弃。
2. **采上下文**：`contextBefore`/`contextAfter` 各 **1000 字符**（解决「模型不知你选中了哪段、在章内什么位置」）。
3. **建请求**：`{ bookUrl, chapterIndex, chapterTitle, chapterPosition, originalText, contextBefore, contextAfter }`。
4. **发任务** → 观察任务状态，同书+同章+同原文 `isCurrent*` 防抖。
5. **落库 + 重载**：写入 `book_content_process` 表，`reloadChapterAfterContentProcessChanged` 按 `chapterPosition` 重载该章正文（所见即所得）。

#### 6.2 P0：后端 AI 工具（不破坏 139 端点契约）
`ai/BuiltinTools.kt` 新增（当前工具数两报告口径不一：01 实测 39、06 实测 42，均含内置，记为 ≈40）：
| 工具 | 用途 | 读写 |
|---|---|---|
| `ai.textClean` | 选中文本交 AI 净化，返回替换段 | 写 |
| `ai.textRewrite` | 选中文本润色/改写（带 `referenceText` 参考上下文） | 写 |
| `ai.selectTextAction` | 选中文本做翻译/总结/圈名 | 写 |

请求/响应沿用 `AiComprehendRequest`/`AgentResult` 形状，**不新增 HTTP 路由**（`ApiCatalog.test.ts` 守恒）。

#### 6.3 P0：参考上下文 `referenceText`
扫当前章前后 **80 章**，提取高频关键词（2–4 字短语 / A-Z 缩写），取 **6 条 × 600 字符**摘录，发给模型——让模型知「你正在看的世界是什么」。青阅 `AiTextFactoryUseCase` 补 `referenceText` 字段。

#### 6.4 P0/P1：AI 工具与端点对齐（06 缺口）
后端端点有、AI 工具未暴露的真实缺口（5 处）：
| 缺口 | 端点已有 | 建议工具 | 优先级 |
|---|---|---|---|
| 书源分组 | `book_group` / `book_shelf/groups` | `source.group.*` | **P0** |
| 进度保存 | `PUT /api/reading-progress` | `progress.set`（仅 06 发现：只有读无写） | **P0** |
| 朗读控制 | `/api/tts/*` | `tts.play/pause/stop/volume/speed` | P1 |
| 备份恢复 | `/api/backup/*` | `backup.import/export/restore` | P1 |
| 书籍换源 | `switch-source` | `source.switch` | P1 |
| 订阅创建 | `/api/subscriptions` | `subscription.create` | P2 |
| 分组删除 UI | `DELETE /api/bookshelf/groups/{id}` 后端有、前端无 | 前端入口 | P2 |

#### 6.5 P1：MD3 形态借鉴（已论证可行）
- 划线/标记菜单（选中即现「划线/书签/注释/标记」）。
- 朗读胶囊（`ReadAloudCapsule` 形态，与 `TtsPlayerBar` 一致）。
- 阅读专用配色/护眼（`--reader-*` 已有，分层 `全局主题/阅读主题/护眼`）。
- 逐章进度同步：`progress.get` 补 `titleIndex` / `titleProgress`。
- 桌面悬浮菜单（`reader/MenuBarFloating.tsx`）+ 复用 `desktop-pin-btn`/`desktop-reverse-btn`。

#### 6.6 P2：翻译胶囊 + 插件生态
- 翻译胶囊（`TranslationThinkingCapsule` 形态，`ai.translate` 工具）。
- **插件脚手架 + 示例 + 文档**（当前 `loaded:0`，唯一缺的是「5 分钟写出第一个插件」的三件套：`manifest.json` + `tool.ts` + `ui.tsx` + `docs/plugin-development-guide.md` 30 分钟指南）。插件通过 `ToolRegistry` 增 `ai.*`、订阅「选中文本」事件、`extensions/registry.ts` 贡献阅读器 AI 菜单项。

#### 6.7 不适用清单（不要搬 MD3 的）
MD3 的 **Material Design 3 视觉体系**、Android `ViewModel/Lifecycle/Context` 全家桶、`ReadAloudCastDelegate` 的扬声器/蓝牙硬件 API、`EyeProtection.kt` 的护眼传感器、桌面 OS 菜单——均**不适用**青阅（青阅有自有 7 套主题 + 62 令牌；是 Ktor+React SPA 非 Android；现阶段护眼做成配色+行距即可）。

#### 6.9 连接选择与接入管理 UI（审计新增）

> **现状校准（据 `legado/AGENTS.md`）**：审计里「连接管理无探测入口 / 无状态指示 / API Key 明文」等指摘，**多数已落地**——`AGENTS.md` §7–§8 描述「AI 接入 · 对话助手」面板已含连接登记、书源只读校验、`probe` 实测状态（probing/ok/fail 三色 `ai-tag`）与「显示状态/实测状态」双维度；failover 按设计**不做**（FirstProfileSelector 取第一个，插件可 `selectorRegistry.setDefault` 替换）。因此下方「默认连接设置 / 探测按钮 / 状态三色」视为**已具备**，不再单列任务；仅「API Key 轻混淆 + 掩码」与「系统提示词模板切换」仍可作为小改进。**阅读器标记菜单（§6.9.1）是本次已实做的第一项**。

- **连接选择行为（审计确认正确，保持不变）**：`FirstProfileSelector` 默认取 `agent-profiles.json` 第一个连接；不可达即返 `409 no_connection`，**无本地兜底、不顺延**——这是正确的已确认行为，不做自动 failover。
- （已具备）前端「AI 接入」面板含连接登记 / 实测探测 / 状态三色标签；删除连接后自动 `refresh`。
- （可选小改）API Key 本地存储做轻混淆（Base64）+ 前端 `type="password"` 掩码（`agent-profiles.json` 当前明文，须改）。
- （可选小改）系统提示词模板切换：小说助手 / 书源调试 / 代码解释 / 通用助手。
- 悬浮球增强（复用 §5.3 `useOverlayDrag`）：拖拽位置记忆、隐藏开关、多并行会话（`AiChatState` 增 `sessionId`）。

##### 6.9.1 阅读器标记菜单（划线/标记菜单，已实做）
- 选中正文后先弹**标记快捷条**（MD3 MarkingSelectionMenu 形态），四个动作：**划线**（仅高亮，不写备注）/ **笔记**（展开 `NoteToolbar` 编辑器）/ **复制** / **AI**（打开全局 AI 悬浮球，选区已写入 `selectionStore` 由 AI 面板读取）。
- 实现：`reader/MarkingMenu.tsx`（新增组件，挂在 `reader-main` 之外，不触发 `onReaderMouseUp`）+ `ReaderScreen` 接线（选区→快捷条，点「笔记」才展开编辑器）+ `.reader-marking-menu`/`.reader-marking-btn` 样式（复用 `--surface/--line/--r-*/--accent-*` 等既有令牌，未新增令牌）。
- 标记快捷条另含「书签」与「搜索本书」（见 §6.9.9 / §6.9.10）：前者复用 `GET /api/notes` 的 `bookmark` 字段落库，后者新增只读路由 `GET /api/book-search`（目录总数 139→140，闸门同步）。两项均已在后端补接口并接进快捷条/底栏，不再属「缺后端 API」。

##### 6.9.2 阅读专属配色（护眼/阅读滤镜，已实做）
- MD3 `ReadBookColorTheme` 思路但做成「**只染阅读文字区、不染外壳**」：新增 `readerEyeTheme` 设置（`off`/护眼暖黄/豆沙绿/夜间黑读），`ReaderScreen` 在 `.reader-workspace` 上挂 `data-reader-eye`，CSS 用「`.reader-workspace[data-reader-eye=...] .reader-main / .reading-content ...`」选择器（特异性高于 `.reader-main`、`.reading-content p` 的 `var()` 声明）覆盖阅读区背景与墨色，不动工具栏/抽屉/外壳。
- 与全局主题解耦：暗色外壳也能有暖色阅读区，反之亦然；开启时自动关掉「背景图/压暗」叠加，避免三层颜色打架。
- 实现：`readerSettings.ts`（类型 + 默认值 + `parseReaderEyeTheme` + `loadReaderSettings` 接线）、`ColorTab.tsx`（「阅读配色」分段控件）、`.reader-workspace[data-reader-eye]` 覆盖规则 + `.segmented-control` 样式（均复用既有令牌，未新增令牌）。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.3 顶栏一键护眼/夜间（阅读配色快捷开关，已实做）
- 复用 §6.9.2 的 `readerEyeTheme`：MD3 顶栏右侧加一个 `md3-icon-btn`（护眼 `eye` / 夜间 `moon`，开启时 `is-active` 高亮），点按在 `off → 护眼暖黄 → 豆沙绿 → 夜间黑读 → off` 间循环，免进设置页即可一键切阅读滤镜。
- 实现：`Md3Chrome.tsx`（`Md3TopBar` 增 `readerEyeTheme` / `onToggleEye` 两 props + 图标按钮，复用 `md3-icon-btn`/`is-active`）、`ReaderScreen` 接线四态循环、`onSettingsChange` 落库。复用既有令牌与图标（`eye`/`moon`），未新增令牌/外壳/字形。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.4 右键菜单补全划线/笔记/AI（选中段落的右键入口，已实做）
- 用户 2026-10-04 明确要「选定段落后右击功能」：把 `onReaderMouseUp` 里算 `noteDraft` 的算法抽成 `buildSelectionDraft()`（同一份选区 → `noteDraft` + 同步 AI 的 `selection`），左键松手与右键菜单共用。
- 右键菜单现在选中文字时给出：**复制 / 划线（直调 `api.addNote` 空备注）/ 笔记（展开 NoteToolbar）/ 发给 AI（`setSelectionFromDraft` + 打开 AI 悬浮球）/ 章节目录**。划线/笔记/AI 走的是临时算出的 draft，不污染左键标记快捷条的状态（`noteDraft` 在右键时保持 null，避免浮层叠浮层）。
- 实现：`ReaderScreen` 抽 `buildSelectionDraft` + 改 `onBodyContextMenu`（沿用既有 `ContextMenuItem`/`showContextMenu`，图标 `copy`/`edit`/`file`/`sparkles`/`list`，无装饰字形、无新外壳）。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.5 目录当前章内进度指示（已实做）
- 目录抽屉的「当前章」行底部加一条薄进度条，实时反映**章内阅读比例**（章 + 章内比例，沿用 `readerProgress` 的 `fraction`）。
- 实现：`VirtualChapterList.tsx` 新增小组件 `CurrentChapterProgress`（自带 `useSyncExternalStore` 订阅进度 store，带 `getServerSnapshot` 以过 SSR 快照判据），只挂在 `current` 行、不拖累整张虚拟列表重渲染；CSS `.reader-chapter-progress`（绝对定位贴底 2px、accent 填充，`color-mix` 复用既有令牌）。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.6 目录已读/未读区分（已实做）
- 目录项按「是否已在当前章之前」区分：已读章用 `--ink`（实色），未读章用 `--muted`（淡），当前章仍走 `.current`（accent）。一眼看出本书读到了哪、剩多少。
- 实现：`VirtualChapterList.tsx` 行 `className` 增 `read`（`chapter.index < activeChapterIndex`）；CSS `.reader-chapter-item.read { color: var(--ink) }`，复用既有令牌。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.7 目录头部全书已读比例（已实做）
- 目录标题栏底部加一条细进度条 + 「已读 X%」文字（`overallProgress` 由 `chapterIndex` + `fraction` 算全书进度），一眼看到整本书读了多少。
- 实现：`TocDrawerHeader.tsx` 头部自带 `useSyncExternalStore`（带 `getServerSnapshot`）订阅进度 store，算出 `overallPct`；CSS `.drawer-progress`（绝对定位贴底 2px、`color-mix` + `--accent`，`.drawer-header` 加 `position: relative`）。复用既有令牌。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.8 右键菜单「复制为引用」（已实做）
- 选中文字右键时多给一项「复制为引用」：把选区原文连同出处 `—— 《书名》· 章节名` 一并写入剪贴板（用 `book` 图标，与「复制」区分）。便于把读到的句子按出处引用，纯前端、无后端、不污染标记状态。
- 实现：`ReaderScreen` 的 `onBodyContextMenu` 在 `selectedText` 分支追加该项，沿用 `navigator.clipboard` + `toast`，无新外壳/令牌/字形。`tsc` 与 `npm test`（682 pass）全绿。

##### 6.9.9 书签（后端 + 前端打通，已实做）
- 需求来源：标记菜单/右键原有「划线/笔记/复制/AI」，独缺「书签」——只标阅读位置、不写想法，与划线/笔记区分。此前 `icons.tsx` 已预留 `bookmark` 图标却无后端支撑，属「计划内未实现」。
- 后端（Kotlin，本环境 `gradlew :app:compileKotlin` 离线编译通过）：
  - `model/Models.kt`：给 `BookNote` 与 `BookNoteWrite` 各加 `bookmark: Boolean = false`（写在构造器末尾，老调用点用具名参数不受影响）。
  - `data/ReadingDao.kt`：`addNote` 把 `bookmark` 落库（INTEGER 0/1）、返回时带回；`listNotes` 的 SELECT 与映射同步带上 `bookmark`。**不新增路由**——前端从既有 `GET /api/notes` 按 `bookmark` 字段筛出书签，故 `agent-api.json` 仍是 139 条、目录闸门不红。
  - `data/Database.kt`：`book_note` 建表加 `bookmark integer not null default 0`，并新增 `migrateBookNote(db)`（用 `pragma table_info` 探列、`alter table add column` 补列，与既有 `migrateSourceTable` 同款做法）在 `initialize()` 里调用，老库缺列自动补齐。
- 前端：
  - `lib/api.ts`：`BookNote` / `BookNoteWrite` 各加 `bookmark?: boolean`。
  - `MarkingMenu.tsx`：加「书签」按钮（`onBookmark`），SVG 用 `bookmark` 形状，与划线/笔记/复制/AI 并列。
  - `ReaderScreen.tsx`：标记菜单 `onBookmark={bookmarkFromMenu}`（调 `addNote({...draft, bookmark:true})` 后入 `notes` 并 toast）；右键菜单 `onBodyContextMenu` 在 `selectedText` 分支追加「书签」项（同法落库）；两者都 `setNoteDraft(null)` 收尾。
  - `NotesPanel.tsx`：列表项带「书签」徽标；书本有书签时显示「全部 / 书签 N」过滤（纯前端 `useState`，不加端点）；导出沿用 `notesToMarkdown`（书签随笔记一起导出）。
  - `styles.css`：`.reader-note-badge`、`.reader-notes-filter`、`.reader-notes-filter-btn` 复用既有 `--accent/--line/--ink/--muted/--s-*/--t-*` 令牌，无新增令牌。
- 验证：`gradlew :app:compileKotlin` BUILD SUCCESSFUL；`npm run check` 退出 0；`npm test` 682 pass / 0 fail；`agent-api.json` 计数仍是 139（未加路由）。全部门禁（UiContract/overlay-tier-check/CopyStyle/FrameworkHasNoContent/ApiCatalog）守住。

##### 6.9.10 搜索本书（后端 + 前端打通，已实做）
- 需求来源：阅读界面的「所有功能」之一——在**已离线缓存的章节正文**里按关键词检索（目录章节标题搜索已存在，这是正文级检索）。此前缺后端接口，属「后端缺口」。
- 后端（Kotlin，离线编译通过）：
  - `model/Models.kt`：新增 `BookSearchHit(val chapterUrl, val chapterIndex, val title, val snippet)`（`@Serializable`，纯回包结构）。
  - `data/ReadingDao.kt`：新增 `searchBookContent(sourceId, bookUrl, query)`，对 `book_content_cache` 里这本书已缓存的章节做 `content like ? escape '\'` 子串匹配（转义 `%`/`_`/反斜杠，防通配符被吞），命中后 Kotlin 侧按 `query` 在 `content` 里定位并截取前后各 24 字成 `snippet`。只覆盖离线缓存到的章节——没缓存的搜不到（前端如实提示）。
  - `http/ProgressRoutes.kt`：新增 `GET /api/book-search`（`requireSameOriginWrite` 不涉及，只读、`write:false`），校验 `sourceId`/`bookUrl`/`q` 非空，调 `searchBookContent` 回 `List<BookSearchHit>`。
  - `resources/agent-api.json`：**新增** 1 条 `GET /api/book-search`（group `进度与笔记`，write false，purpose/response/group 齐全）。目录总数 **139 → 140**，并在 `ApiCatalog.test.ts` 的断言钉死数同步改为 140（按 AGENTS.md §6「重排时同步改此断言并说明」）。
- 前端：
  - `lib/api.ts`：新增类型 `BookSearchHit` 与方法 `bookSearch(sourceId, bookUrl, query)`（`request<BookSearchHit[]>('/api/book-search?...')`）。
  - `reader/BookSearchDialog.tsx`（新文件）：复用既有 `.overlay-backdrop` + `.dialog-shell.size-m` + `.dialog-head` 外壳（UiContract 判据：套外壳、有 `role="dialog"`+`aria-label`、接 `useEscapeClose`、不 inline 压宽高），内容样式只新增 `.reader-book-search*` 且复用既有 `--accent/--line/--ink/--surface/--muted/--s-*/--t-*` 令牌。输入防抖 300ms 调 `bookSearch`，结果列「第 N 章 · 标题 + snippet」，点一项 `onJump(chapterIndex)` 切章并关弹窗。
  - `reader/Md3Chrome.tsx`：底栏动作排加「搜书」`md3-pill`（`<Icon name="search" />`），`onBookSearch` 打开弹窗。
  - `reader/ReaderScreen.tsx`：`bookSearchOpen` 状态；`Md3BottomBar` 传 `onBookSearch={() => setBookSearchOpen(true)}`；渲染 `<BookSearchDialog sourceId bookUrl onJump onClose>`，`onJump` 调 `changeChapter(index,'first')` 后关弹窗。
  - `styles.css`：`.reader-book-search*` 内容样式（输入/状态/结果列/项），全部复用既有令牌，无新增设计令牌。
- 验证：`gradlew :app:compileKotlin` BUILD SUCCESSFUL；`npm run check` 退出 0；`npm test` 684 pass / 0 fail（目录闸门 142 同步、UiContract 对新增弹窗的 Esc/外壳/role/名字/inline 宽高全过）。

##### 6.9.11 阅读器 AI 闭环（后端 + 前端打通，已实做）
- 需求来源：plan D 的 P0「AI 净化/润色 → 落库 → 重载」（所见即所得）。原方案主张「不新增路由、复用 `ai.textClean/textRewrite` 工具」，但那两条工具当前 `writes=false` 且不落库、且 `textRewrite` 不真正调 LLM，经权衡改为**前端驱动 + 显式覆盖路由**的更可控实现（仍守门禁，仅把目录计数 140→142）。
- 设计取舍：只做「**整章**」净化/润色，不做「选中片段」。原因：选区文本是 `convert`（繁→简等）之后的展示文本，而正文落库存原始文本；在原始坐标里按展示文本做片段替换会把段落切花（偏移对不上）。整章层面无此问题——整章原文交 AI、整章结果落库，`convert` 照常叠在展示层。选中片段的净化/润色继续走既有「发给 AI」对话面板。
- 后端（Kotlin，离线编译通过）：
  - `model/Models.kt`：新增 `ContentProcess(...)` 与请求体 `ContentProcessRequest(sourceId, bookUrl, chapterUrl, kind, original, processed)`（`@Serializable`）。
  - `data/Database.kt`：新增 `book_content_process` 表（PK `source_id, book_url, chapter_url, kind`；`kind` ∈ `ai_clean` 净化 / `ai_rewrite` 润色；存 `original`/`processed`/`updated_at`）。
  - `data/CacheDao.kt`：新增 `getContentProcess` / `saveContentProcess`（覆盖写，on conflict 更新）/ `deleteContentProcess`。
  - `http/ReadingRoutes.kt`：`POST /api/books/content` 读路径在回包前查 `book_content_process` 覆盖（`ai_clean` 优先于 `ai_rewrite`），命中则回覆盖版（净化规则照套、离线缓存照写，行为只多一层覆盖）；新增 `POST /api/books/content-process`（落覆盖）与 `DELETE /api/books/content-process`（撤覆盖，恢复原始正文），均 `requireSameOriginWrite`。
  - `resources/agent-api.json`：**新增** 2 条（`POST`/`DELETE /api/books/content-process`，group `阅读`，write true，purpose/response/group 齐全）。目录总数 **140 → 142**，并在 `ApiCatalog.test.ts` 断言钉死数同步改为 142。
- 前端：
  - `lib/api.ts`：新增类型 `ContentProcess`/`ContentProcessRequest` 与方法 `saveContentProcess(req)`、`deleteContentProcess(sourceId, bookUrl, chapterUrl, kind?)`；AI 调用复用既有 `agentChat(messages)`（走 `POST /api/agent/chat`，须先连外部模型）。
  - `reader/ReaderAiDialog.tsx`（新文件）：复用 `.overlay-backdrop` + `.dialog-shell.size-m` + `.dialog-head` 外壳（UiContract 合规）。两个动作「AI 净化本章 / AI 润色本章」+「撤销上次 AI 处理」。每个动作把整章原始正文（来自 `chapterBaseContentRef`，正常加载时写入）交给 `agentChat`（system prompt 区分净化/润色，要求只回正文、剥掉偶发代码块），把返回落 `saveContentProcess`，再 `onApplied(processed)` 让阅读器 `setContent` 实时重载；撤销调 `deleteContentProcess` 后回滚到 `original`。无外部模型时优雅报错（「尚未连接外部模型，AI 不可用」）。
  - `reader/Md3Chrome.tsx`：顶栏护眼按钮旁加「AI 净化 / 润色本章」`md3-icon-btn`（`sparkles` 图标），`onOpenAi` 打开弹窗。
  - `reader/ReaderScreen.tsx`：`readerAiOpen` 状态；`chapterBaseContentRef` 记住「非 AI」的原章正文（只在 `applyContent` 正常加载时写入，AI 覆盖走 `setContent` 不污染）；渲染 `<ReaderAiDialog sourceId bookUrl chapterUrl original onApplied onClose>`，`onApplied={processed => setContent(processed)}` 即同章重载（复用 `ReplaceRulesModal.onRulesChanged` 的 `setContent` 模式，绕开 `changeChapter` 同章早退）。
  - `styles.css`：`.reader-ai*` 内容样式（动作排 / 状态），复用既有 `--accent/--line/--ink/--surface/--muted/--s-*/--t-*` 令牌，无新增设计令牌。
- 验证：`gradlew :app:compileKotlin` BUILD SUCCESSFUL；`npm run check` 退出 0；`npm test` 684 pass / 0 fail（目录闸门 142 同步、UiContract 对新增弹窗的 Esc/外壳/role/名字/inline 宽高全过）。

#### 6.10 安全：SSRF 防护（审计新增， P0）
- `OpenAiCompatibleProvider` 直接调用用户配置的 `baseUrl`，**无内网/保留地址校验**；`AgentContext.boundHost="127.0.0.1"` 仅作元数据，未在外呼时强制校验。
- **必须在 `Agent`/`LlmProvider` 层增加 `baseUrl` 合法性校验**：拒绝 `127.0.0.1`、`169.254.x.x`、`0.0.0.0`、`localhost`、链路本地等，返回明确 `cross_origin` 错误而非静默失败（参考 `Guardrails.refuseExternalBind()`，但作用于外呼）。
- 真实安全漏洞，优先级高于体验类，建议与阶段 1.5 同期落地（§8）。

#### 6.11 Agent 工具上限可配置（审计新增，P2）
- `Agent.MAX_TOOL_ROUNDS=6`、`MAX_TOOL_DATA=4000` 硬编码；提升为 `AppConfig` 配置项，支持运行时动态调整。
- 长文本工具（如 `source.run`）增加「摘要模式」。

#### 6.12 插件来源标注与事件可视化（审计新增，P1）
- 插件注册的工具在 `manifest()` 标注来源（`source: "plugin:xxx"`），便于审计。
- AI 接入面板增加「插件事件」小节，显示已订阅事件名与插件 ID。

#### 6.13 验收
- [ ] 选中一段 → AI 净化/润色 → 确认 → 该章正文实时重载（所见即所得）。
- [ ] 模型收到的上下文含「书/章/选中段落 ±1000 字符 + 参考章节摘要」。
- [ ] 书源分组、进度保存可由 AI 直接操作；朗读/备份可由 AI 控制。
- [ ] 第一个社区插件 5 分钟内按模板跑通。

---

### 7. 门禁 / 判据清单（改动必须同步）

| 判据测试 | 守什么 | 本方案哪些项会触碰 |
|---|---|---|
| `UiContract.test.ts` | 浮层外壳白名单、z-index 正则、关闭键、像素宽高、类名→样式表 | C 全阶段（尤其阶段 1 正则改）、B G2/G4、C 0-4 |
| `overlay-tier-check.mjs` | 遮罩 ≤2、backdrops===1、宽度 `min(--dw-N,94vw)`、max-height/radius/animation 唯一 | C 阶段 3（resize）、阶段 4（dock 不带 backdrop） |
| `CopyStyle.test.ts` | 装饰字形禁用（`BANNED_GLYPHS`）、`BANNED_CLAIMS`（说谎文案）、`BANNED_PHONE_PHRASES` | 全部文案、B 0-3 说谎控件、C 0-3 |
| `ApiCatalog.test.ts` | 142 端点 / 19 组双向一致；`agent-api.json` 版本号须等于 `BuildInfo.version` | D 后端工具（不新增路由，守恒）、A `SourceSummary` 增字段（按端点核不破）；新增端点两处登记 |
| `FrameworkHasNoContent.test.ts` | 依赖方向 content→framework、容器零内容、AI 非插件 | D 插件接入、任何 `lab/extensions` 改动 |
| `CustomizeSkin.test.ts` | `CustomSkin` 形状 `deepEqual` | B G2（条件展开保兼容） |
| `ThemePack.test.ts`（新增） | 白名单与样式表同步、注入走 textContent 且值被清洗 | B G2 |
| `MotionTokens.test.ts`（新增） | 动效时长/缓动只从令牌取 | B G1 |
| `NamingConventions.test.ts` | hooks 文件名 `useXxx.ts`、禁 `export default` | B/C 新文件 |
| `HeaderMenu.test.ts` | 禁写死 `'x.y.z'` 字面量 | 全部 |
| `TtsBarPosition.test.ts` | `HOLD_MS=250`/`SLOP=9`/`legado-tts-bar-reset` 等字面量必须保留 | C 阶段 2（抽出去再引回） |
| `SearchStatePersistence.test.ts` | 钉默认 `'all'` | A-1（同步改断言） |
| `selfcheck`（发布红线） | 搜索默认路径 | A 全（恢复绿） |
| `AgentSecurity`/provider 校验（建议新增） | `baseUrl` 拒绝内网/保留地址；API Key 存储须非明文 | D-SSRF（§6.10）、D 连接 UI（§6.9） |

---

### 8. 分阶段路线图（把 A/B/C/D 串成迭代）

> 排序原则：先修「在说谎的东西」→ 再做零门禁冲突的能力 → 最后做需改门禁的能力（R3 §6 排序精神）。

| 阶段 | 内容 | 主题/档 | 门禁 |
|---|---|---|---|
| **阶段 0** | 清账 + Z1/Z2：删 `.fw-*`/`.lab-*` 死样式、修「界面偏好」说谎控件、修 AI 面板宽度、对比度引线、僵死令牌 | C0 / B-Z1-Z2 | 零风险 |
| **阶段 1** | 性能 P0：搜索默认范围改分组 + 量化预期；A-2 后端 `health` 字段 + 前端徽标/排序 | A | A-1 改 `SearchStatePersistence` 断言 |
| **阶段 1.5** | 安全与接入（审计）：SSRF `baseUrl` 校验、连接 UI（默认连接/探测/删除刷新/API Key 掩码/提示词模板）、悬浮球增强（拖拽记忆/隐藏/多会话） | D（审计新增） | 新增 SSRF 判据 |
| **阶段 2** | R2 零风险 + 动效：Z3（650 处令牌）、Z4/Z5/Z6、G1 动效令牌 + `MotionTokens` | B-Z/G1 | G1 加新判据 |
| **阶段 3** | R2 焦点/断点：G3 `useOverlayFocus` + 8 弹窗；G4 断点 4 档 + 普查 | B-G3/G4 | G4 改现有 5 处 + 新判据 |
| **阶段 4** | R3 层级令牌化：21 个 `--z-*` + 改 `UiContract` 两处正则 + 负向自证（AI 球层级随此落地） | C1 | **动核心判据，须同步改** |
| **阶段 5** | R2 主题包 + 三层偏好 + 密度圆角 UI：G2 schema/导入导出 + `ThemePack` 判据 + `appearance`/`preferences` + 设置页行 | B-G2 延伸 | G2 加新判据 |
| **阶段 6** | R3 拖动/跨页常驻 + dock：C2 `useOverlayDrag` + `OverlayHost`、AI 球拖动+记忆、`dockEntries` 插件接入 | C2/C4 | 零门禁冲突（dock 不带 backdrop） |
| **阶段 7** | R1 阅读器 AI 闭环：`book_content_process` 覆盖表 + `POST/DELETE /api/books/content-process` 落库重载 + 顶栏 AI 净化/润色弹窗（前端驱动 `agentChat`） | D-P0 | 端点 140→142，闸门同步 |
| **阶段 8** | R1 工具对齐 + 插件：朗读/备份/`source.switch`/`progress.set`/`source.group` 工具 + 插件脚手架/示例/文档 | D-P1/P2 | `ApiCatalog` + `FrameworkHasNoContent` |
| **阶段 8.5** | 审计补充：Agent 工具上限可配置 + 长文本摘要、插件来源标注与事件可视化、版本号 manifest | D（审计新增） | 无 |
| （穿插） | R3 阶段 3 resize（需改 `overlay-tier-check`）、A-3/A-4 虚拟滚动/两阶段搜索 | C3 / A-P1/P2 | 高（改门禁）需单独评审 |

**关键路径**：`Z1→Z3→G2→密度UI`；`A-1→A-2→健康度徽标`；`清账→C1 层级→C2 拖动→C4 dock`；`D 闭环→D 工具对齐→插件`。各链互不阻塞可并行。

---

### 9. 跨主题「不要做」清单（合并 R2 §6 + R3 §10 + §1 红线）

1. **不要**新增第二套 dialog 外壳（`UiContract:290-293` 会红）。
2. **不要**给 dock 层加 `.overlay-backdrop`（`overlay-tier-check:203-205` 会红）。
3. **不要**在 TSX 写 `width/height/maxWidth/maxHeight` 像素值（`UiContract:154-163` 会红）。
4. **不要**把 resize 作用在 `.dialog-shell` 上（`overlay-tier-check:206-209` 会红）。
5. **不要**删 `ttsBarPosition.ts` 的 `HOLD_MS=250`/`SLOP=9`/`legado-tts-bar-reset`（`TtsBarPosition.test.ts:62-81` 逐条匹配）。
6. **不要**把 z-index 令牌化单独提交——会红 `UiContract:62-68/71-83`，必须与判据补丁同提交。
7. **不要**在 `:root`「再定义一次」已有令牌加比例（添重复声明），就地改写原定义。
8. **不要**把主题包做成「任意 CSS 变量」——白名单是校验/迁移唯一前提。
9. **不要**在没写迁移函数时改 `localStorage` 键名（皮肤库/布局/阅读设置都在里）。
10. **不要**在 `extensions/registry.ts` 先加 `dockEntries` 类型而后补宿主（承诺渲染不出来的能力）。
11. **不要**照搬 MD3 的 Material Design 3 视觉体系 / Android 全家桶（破坏主题可塑性目标、非 Android 应用）。
12. **不要**各写一份夹取算式——`lib/overlayGeometry.ts` 的 `clampOverlay` 是唯一来源。
13. **不要**用装饰字形、写死版本号、`export default`（对应判据会红）。
14. **不要**不经校验直接外呼用户配置的 `baseUrl`（SSRF，§6.10）——必须在 `Agent`/`LlmProvider` 层拒绝内网/保留地址。
15. **不要**为连接选择加自动 failover（`FirstProfileSelector` 取第一个、不可达返 `409 no_connection` 是无本地兜底的正确行为，审计确认）。

---

### 10. 一句话收尾

本方案把 5 份研究报告（R1/R2/R3 + AI 核实 + MD3 借鉴）+ 1 份 AI & 插件框架审计报告收口成一个**分阶段、可验收、守门禁**的改造计划：先雪中送炭（性能/规模 P0），再锦上添花（界面可塑性 + 悬浮层系统 + 阅读器 AI 闭环 + 审计新增的连接/安全/插件项），全程不新增第二套外壳、不破坏端点契约（当前 142 端点 / 19 组，任何新增必两处登记 + 闸门同步）、不绕过任何既有判据测试。所有 `文件:行` 动手前先 `git diff` 复核。

---

<!-- 来源：docs/archive/reader-redesign-roadmap.md -->

## 阅读器重做 · 分阶段实施路线图

> 来源：阅读器重做建议（79 条，八大类）
> 依据：建议第八节「落地优先级」（P1–P5）
> 目标：把建议转化为可执行、可验收、可门禁的分阶段任务，进入 Kiro 式实施流程
> 语言：本文档与后续 spec/design/tasks 均用简体中文

---

### 0. 与现有方案的关系（先读）

仓库已有 `docs/reader-redesign-plan.md`（基于研究纪要 01–07，覆盖四大主题：性能与规模 / 界面可塑性 / 悬浮层系统 / 阅读器 AI），以及 `docs/reader-archive.md`（v0.8.4 现状基线）。

本路线图是**超集与重构视角**：

| 现有 reader-redesign-plan.md | 本路线图对应 |
|---|---|
| 性能与规模 | P1（分页缓存）+ P2（章节窗口/分块/异步解析）|
| 界面可塑性 | P1（三层解耦）+ P3（目录/搜索）|
| 悬浮层系统 | P1（导航面/设置面 overlay）+ P3（批注 inline 操作条）|
| 阅读器 AI | P3（锚点）+ P5（AI 选区问答）|

差异点（本路线图新增，现有方案未覆盖）：逻辑位置模型（P1）、阅读域模块与 `ReadingRepository`（P1/P4）、统一缓存抽象（P1/P4）、架构与数据层（P4：54/55/57）、安全与边界（P4：58–64）、性能可观测性（P4：65–68）、测试与 CI（P4：69–74）、增强功能（P5：42–50）。

**建议**：本路线图定稿后，将 `reader-redesign-plan.md` 的四主题按本 P1–P3 重新归并，避免两份计划各自漂移（遵循 AGENTS.md「不写、不保留 1234 没有的功能说明」与 STRUCTURE.md「单一产品」原则）。本文件不替代它，先作为总纲。

---

### 1. 阶段总览

| 阶段 | 主题 | 关键交付 | 关联建议 | 退出判据 |
|---|---|---|---|---|
| **P1** | 地基：位置模型 + 分页 + 三层 + 域模块 | 逻辑位置模型、`ReadingRepository`、精确分页与缓存、阅读/导航/设置三层、域路由装配 | 1–14, 51–54, 56 | 打开书用逻辑位置恢复；改字号命中缓存不冻结；控件按需唤起 |
| **P2** | 规模：章节窗口 + 全局页索引 + 异步解析 | 全局页索引、章节滑动窗口、大章节分块、大文件懒解析、排版设置细节 | 15–24, 33–36 | 大章节内存可控；跨章翻页无感知边界；重启按逻辑位置恢复 |
| **P3** | 体验：批注 + 目录搜索 + 漫画 | 文本锚点批注、多类型批注、目录/全书搜索、漫画模式 | 25–32, 37–41 | 重排后批注不丢；全书搜索定位高亮；漫画与小说共用进度抽象 |
| **P4** | 底座：安全 + 架构 + 测试 | 写门/SSRF 插件化、AI/插件安全收口、单写队列、域级测试与性能基准 | 51–57(部分), 58–74 | 新增端点自动受保护；域测试可在 testApplication 跑；性能基准进 CI |
| **P5** | 增强：统计 + TTS + AI + 配置 | 阅读统计、书签、目标提醒、词典、TTS 联动、AI 选区、配置导入导出、净化预览、记录时间线 | 42–50 | 增强功能默认关闭/主动触发，不侵入核心阅读路径 |

依赖方向：**P2 依赖 P1 的逻辑位置与缓存抽象；P3 依赖 P1 的锚点模型；P4 的测试门禁依赖 P1–P3 的域模块落地；P5 依赖 P1 的进度/锚点模型。**

---

### 2. P1 — 地基

#### P1-T1 逻辑位置模型
- **目标**：建立统一的阅读位置真相，替代「页码即进度」。
- **关联条目**：6, 7, 8, 9
- **涉及模块**：`legado/web/src/reader/`（位置状态）、`legado/app/.../data/`（`progress` 表 DAO）、`ReadingRepository`（P1-T4）
- **验收**：
  - 进度/书签/划线/笔记统一用 `章节ID + 字符偏移 + 段落锚点` 表达，代码无独立页码字段作为真相。
  - 字体切换、窗口 resize、跨设备同步均基于逻辑位置恢复，不读当前页 DOM。
  - 划线/批注用起止字符偏移存储，重排后在测试 fixture 上 100% 自动适配。
  - 逻辑位置带 `version` 与 `checksum` 字段；冲突/锚点失效有回退路径（P3-T2 补全模糊匹配）。

#### P1-T2 精确分页与缓存引擎
- **目标**：按真实排版精确分页并落盘缓存，消除改字号冻结与跳页。
- **关联条目**：1, 2, 3, 4, 5
- **涉及模块**：`legado/web/src/reader/`（排版/分页计算）、Web Worker 或 async 分片、`cache/`（缓存抽象见 P1-T5）
- **验收**：
  - 分页按字体/字号/行距/边距/窗口尺寸精确计算，保留完整文本行（无断行截断）。
  - 缓存 key = `书ID + 字号 + 行距 + 字体 + 窗口尺寸`；改字号首次重排，之后命中缓存。
  - 分页计算在 Worker/异步分片，改字号/切换字体时主线程不冻结（基准见 P4-T3）。
  - 改设置时「旧分页继续显示，新分页算完静默切换，二分定位当前位置」，不跳回第一页。
  - 页码仅为逻辑位置的派生显示值，不参与进度存储。

#### P1-T3 阅读三层解耦 + 沉浸式
- **目标**：把阅读界面拆成三层，默认沉浸式。
- **关联条目**：10, 11, 12, 13, 14
- **涉及模块**：`legado/web/src/reader/`、`pages/`、`components/`、`settings/`、`lab/`
- **验收**：
  - 三层独立：阅读面（仅正文+必要进度）、导航面（目录/进度滑块/上下章，overlay 或 bottom sheet）、设置面（实时预览，关闭后阅读面空间稳定）。
  - 导航面/设置面不挤压正文布局（overlay 叠层，非流式占位）。
  - 默认进入沉浸式，不启动即弹工具栏；点击/滑动/快捷键按需唤起。
  - 提供「隐藏所有控件」纯阅读模式，退出操作可发现（如边缘把手/Esc）。

#### P1-T4 阅读域模块 + ReadingRepository
- **目标**：把阅读相关端点与数据访问收口成域。
- **关联条目**：51, 52, 53, 56
- **涉及模块**：`legado/app/src/main/kotlin/io/legado/http/Routes.kt`、`http/ReadersRoutes.kt`（新增）、`ReadingRepository`（新增）、`data/*Dao.kt`
- **验收**：
  - 新增 `readerRoutes()` 装配入口，由 `Routes.kt` 按域调用，路由文件从「端点清单」变为「域声明」。
  - `ReadingRepository` 统一封装进度/书签/划线/批注/章节窗口读写。
  - DAO 只做表级 CRUD，业务查询收口到 Repository，Route/Service 不直接拼 SQL。

#### P1-T5 统一缓存抽象（阅读侧）
- **目标**：分页缓存/章节解析缓存/媒体缓存统一收口。
- **关联条目**：54（P1 部分）
- **涉及模块**：`legado/app/.../cache/`（抽象层）、`legado/web/src/reader/`（声明 key）
- **验收**：
  - 统一缓存抽象暴露 get/set/invalidate；阅读模块只声明 cache key，不直接操作存储。
  - 分页缓存与章节解析缓存经该抽象落盘；后续 P2/P3 媒体缓存复用同一抽象。

---

### 3. P2 — 规模

#### P2-T1 全局页索引 + 章节滑动窗口
- **目标**：翻页/滚动共用一套索引，章节内存可控。
- **关联条目**：15, 16, 17, 19
- **涉及模块**：`legado/web/src/reader/`（页索引、窗口）、`localbook/`（章节边界）
- **验收**：
  - 不为滚动/分页各写一套加载逻辑；全局页索引映射，翻页模式仅为渲染策略。
  - 内存维护章节滑动窗口（当前章 ±1–2 章），窗口外动态卸载。
  - 跨章翻页章节边界对用户不可见，统一由全局页索引驱动。
  - 翻页模式（覆盖/仿真/滑动/滚动）共用同一索引映射与章节窗口。

#### P2-T2 大章节分块渲染
- **目标**：大章节不全量挂载 DOM。
- **关联条目**：18
- **涉及模块**：`legado/web/src/reader/`
- **验收**：大章节按顶层块分块渲染，仅挂当前块与相邻块；基准见 P4-T3。

#### P2-T3 大文件异步解析 + 恢复
- **目标**：打开大书不阻塞，恢复走逻辑位置。
- **关联条目**：33, 34, 35, 36
- **涉及模块**：`localbook/LocalBookParser.kt`、`content/`、`cache/`
- **验收**：
  - 打开大文件只解析目录与章节边界，正文按需读取，不全文阻塞。
  - 解析结果/分页结果/章节窗口内容分别缓存，有合理失效策略。
  - 重启恢复优先逻辑位置，页码仅辅助显示。
  - 图片/音频/视频懒加载，进入 P1-T5 统一缓存层。

#### P2-T4 排版与设置细节
- **目标**：补齐设置面内容（P1-T3 已搭骨架）。
- **关联条目**：20, 21, 22, 23, 24
- **涉及模块**：`legado/web/src/settings/`、`reader/`
- **验收**：
  - 排版预设（紧凑/标准/宽松/大字/夜间）+ 细粒度自定义。
  - 字体支持系统/内置/导入，字体加载完成后触发重排（接 P1-T2）。
  - 简繁转换、标点压缩、段首缩进、段间距为独立开关，互不覆盖。
  - 配色支持跟随系统/手动/自定义，正文对比度达可读标准。
  - 进度指示支持页码/百分比/章节内进度，可关闭。

---

### 4. P3 — 体验

#### P3-T1 文本锚点批注 + 多类型
- **目标**：选中即批注，重排不丢，类型丰富。
- **关联条目**：29, 30, 31, 32（批注部分）
- **涉及模块**：`legado/web/src/reader/`（inline 操作条）、`ReadingRepository`（P1-T4）、`data/`（批注表）
- **验收**：
  - 选中弹出 inline 操作条：高亮/下划线/波浪线/删除线/笔记/复制/搜索。
  - 批注支持多颜色多类型，目录或笔记面板集中管理。
  - 笔记导出 Markdown 保留章节、逻辑位置、原文摘录（0.8.4 已有基础，此处扩展锚点）。
  - 锚点失效时提供「原文模糊匹配重新定位」回退，不丢弃（接 P1-T1 的 version/checksum）。

#### P3-T2 目录与全书搜索
- **目标**：目录体验 + 全书搜索定位。
- **关联条目**：25, 26, 27, 28
- **涉及模块**：`legado/web/src/reader/` 目录面板、`http/ReadersRoutes.kt`、`SearchRoutes`（WS 复用）
- **验收**：
  - 目录高亮当前章、已读标记、字数显示、快速跳转。
  - 全书搜索结果按章节分组，点击定位到命中文本并高亮。
  - 目录/进度面板支持手势/Esc/返回键关闭。
  - 上下章快捷操作，可自定义点击区域/手势。

#### P3-T3 漫画阅读模式
- **目标**：漫画与小说共用进度抽象。
- **关联条目**：37, 38, 39, 40, 41
- **涉及模块**：`legado/web/src/reader/`（漫画视图）、`cache/`（图片缓存）、`MediaRoutes`
- **验收**：
  - 单页/双页/连续滚动/从右到左，与小说共用章节/进度模型。
  - 图片按需预加载前后若干页，窗口外释放，长章节内存不膨胀。
  - 缩放/双击放大/拖动/适应宽高，手势与翻页不冲突。
  - 图片失败有重试与占位，不阻塞整章。
  - 进度用「章节 + 页索引」逻辑位置，与小说抽象一致。

---

### 5. P4 — 底座（安全 / 架构 / 测试）

#### P4-T1 安全插件化
- **目标**：写门与出站闸门统一为 Ktor/HttpClient 插件。
- **关联条目**：58, 59, 60, 61
- **涉及模块**：`http/Guard.kt`、`http/NetworkSecurity.kt`
- **验收**：
  - 同源写门做成 Ktor 插件，应用级统一拦截 POST/PUT/DELETE，新增端点**自动**受保护。
  - 出站 SSRF 校验做成 HttpClient 层插件，所有外部请求必经公网 HTTP(S) 校验。
  - 文档/界面提示「写门≠身份认证；禁止绑 0.0.0.0 / 暴露公网」。
  - AI 回环放行增加 host/port 白名单，服务自身监听端口硬编码进拒绝列表。

#### P4-T2 插件与凭据安全收口
- **目标**：插件加载与凭据存储明示风险。
- **关联条目**：62, 63, 64
- **涉及模块**：`plugin/PluginManager.kt`、`PluginLoadPolicy`（新增）、`source/` 凭据
- **验收**：
  - 插件 jar 扫描收口到统一 `PluginLoadPolicy`，所有加载入口必经该策略。
  - 插件加载期输出能力声明与告警（网络/文件/反射），明确插件无沙箱、以本机用户权限执行。
  - 外部站点登录 Cookie/凭据明确存储位置、是否加密、是否进备份，界面提示风险。

#### P4-T3 数据层并发与可观测性
- **目标**：消除 SQLITE_BUSY，建立性能基准。
- **关联条目**：55, 65, 66, 67, 68
- **涉及模块**：`data/Database.kt`、`ops/LogService.kt`、规则引擎
- **验收**：
  - SQLite 写操作单写队列或按书/按源串行化，WS 流式搜索与进度写入并发无 `SQLITE_BUSY`。
  - 分页/章节解析/规则求值有耗时与失败率指标。
  - 规则引擎可选 `ParseSession` 记录每步规则/输入类型/命中数/样本/耗时，调试与体检复用。
  - 阅读界面关键基准（开书/改字号重排/跨章翻页/目录打开）有可观测日志。

#### P4-T4 域级测试与 CI 门禁
- **目标**：域可独立测试，性能基准进 CI。
- **关联条目**：57, 69, 70, 71, 72, 73, 74
- **涉及模块**：`legado/app/src/test/`、`web/test/`、CI 配置
- **验收**：
  - 阅读域用 `testApplication` 只加载目标模块与必要插件，不启完整 fat jar。
  - 逻辑位置模型、分页缓存 key、锚点重定位有单元测试。
  - 规则引擎有固定 HTML/JSON fixture 断言，不依赖外站。
  - 写门与 SSRF 闸门独立测试：跨站写被拒、非公网目标被拒。
  - 阅读关键路径 E2E：开书/改字号/跨章翻页/加批注/恢复进度。
  - 分页性能、章节窗口内存占用纳入 CI 基准并设回归阈值。
  - `/api/catalog` 元数据登记与域模块注册绑定，模块漏注册路由能被 catalog 暴露（接 57）。

---

### 6. P5 — 增强（默认关闭 / 主动触发）

#### P5-T1 阅读统计与书签
- **目标**：统计与书签，不侵入核心路径。
- **关联条目**：42, 43, 44, 50
- **涉及模块**：`ReadingRepository`（扩展）、`data/`、`reader/` 面板
- **验收**：阅读时长/字数/章节数/连续天数统计面板可关闭；书签绑定逻辑位置支持备注导出；目标提醒默认关闭；记录时间线按书/日期查看。

#### P5-T2 词典 / TTS / AI 选区
- **目标**：可配置增强，用户主动触发。
- **关联条目**：45, 46, 47
- **涉及模块**：`ai/`（选区问答）、`tts/`、`reader/` 划词入口、`plugin/`（词典以插件接入）
- **验收**：划词查询（词典/翻译/百科）以插件或可配置服务接入；TTS 与阅读联动（当前段高亮/自动翻页/跨章连播/定时停止）；AI 选区问答/总结/改写由用户主动触发，默认不打扰。

#### P5-T3 配置导入导出 + 净化预览
- **目标**：排版方案可迁移，调试入口内嵌。
- **关联条目**：48, 49
- **涉及模块**：`reader/settings/`、`content/`（净化预览）
- **验收**：阅读配置导入导出（换设备/分享排版方案）；阅读界面提供净化规则预览入口，便于调试正文异常。

---

### 7. 跨阶段约束（门禁）

- **单一产品**：所有改动落在 `legado/`，不在根目录另起前端/后端（STRUCTURE.md）。
- **安全不可回归**：P1 起任何写端点必须过 P4-T1 的写门插件；外部请求必须过 SSRF 插件。
- **缓存经抽象**：P1-T5 统一缓存抽象是 P2/P3 媒体缓存的前置依赖，不绕开。
- **逻辑位置优先**：P1-T1 之后，进度/锚点/同步不得回退到页码或 DOM 依赖。
- **测试随特性**：P1–P3 每个域落地时，P4-T4 的对应测试同步补上，否则视为未完成。
- **版本真相**：版本号唯一来源 `app/build.gradle`；本文档不写死版本号（以 `/healthz` 为准）。

### 8. 风险与待决

- **与 `reader-redesign-plan.md` 重叠**：四主题需归并，避免两份计划漂移（见第 0 节）。
- **现有 35 个阅读器文件**：P1 重构需先以 `reader-archive.md` 为基线，避免破坏已存在功能（0.8.4 已有划线导出、AI 选区等）。
- **Web Worker 分页与现有渲染耦合**：P1-T2 需确认当前分页实现位置，先做最小可用切片再扩展。
- **插件无沙箱**：P4-T2 仅能「明示+策略拦截」，无法真正沙箱，文档与界面须如实告知。

### 9. 下一步（进入实施）

按 Kiro 式流程，对 **P1** 先产出三件套再动手：

1. `requirements.md`：P1 范围的需求（逻辑位置模型、分页缓存、三层、域模块）。
2. `design.md`：模块拆分、数据表变更、`ReadingRepository` 接口、`readerRoutes()` 装配。
3. `tasks.md`：P1-T1~T5 拆成可验收子任务，配 P4-T4 测试。

确认后从 P1-T1（逻辑位置模型，地基中的地基）开始实现。

---

<!-- 来源：docs/archive/reader-p1-requirements.md -->

## P1 实施需求 · 阅读器地基

> 阶段：P1（路线图见 `reader-redesign-roadmap.md`）
> 目标：把阅读位置真相从「页码/比例」升级为逻辑位置，并搭好三层界面、阅读域模块、统一缓存抽象的地基。
> 语言：简体中文

### 1. 范围

P1 包含 5 个任务：

- **P1-T1 逻辑位置模型**（本章重点，已开始落地）
- P1-T2 精确分页与缓存引擎
- P1-T3 阅读三层解耦 + 沉浸式
- P1-T4 阅读域模块 + ReadingRepository
- P1-T5 统一缓存抽象（阅读侧）

本文件只写需求；设计见 `reader-p1-design.md`，任务拆分见 `reader-p1-tasks.md`。

### 2. 目标

1. 阅读进度、书签、划线、笔记统一用**逻辑位置**表达：章节标识 + 章节内字符偏移 + 段落锚点。
2. 逻辑位置带 `positionVersion` 与 `positionChecksum`，支撑跨设备冲突处理与锚点失效回退。
3. 字体切换、窗口 resize、跨设备同步均基于逻辑位置恢复，不依赖当前页 DOM 或页码。
4. 页码（如有）只作为逻辑位置的派生显示值，不参与进度存储。
5. 现有阅读功能（0.8.4 已具备的划线导出、AI 选区等）不得因重构而退化。

### 3. 非目标（本阶段不做）

- 分页计算的 Web Worker 化、缓存落盘（P1-T2，但模型字段先行）。
- 章节滑动窗口、全局页索引、大章节分块（P2）。
- 多类型批注 UI、全书搜索、漫画模式（P3）。
- 安全插件化、域级测试门禁（P4）。
- 阅读统计、TTS 联动、AI 选区、配置导入导出（P5）。

### 4. 约束

- **单一产品**：改动落在 `legado/`，不在根目录另起前端/后端。
- **向后兼容**：老客户端不报 `charOffset` 时后端存默认 0，旧 `scrollPosition` 比例字段保留，迁移用既有 `pragma table_info` + `alter table` 模式。
- **不破坏已存在能力**：批注已用章节内字符偏移（PROPOSAL-019 E），重构须保留该属性。
- **版本真相**：版本号唯一来源 `app/build.gradle`；本文档不写死版本号。

### 5. 验收（P1-T1 部分）

- [ ] `reading_progress` 表含 `char_offset / paragraph_anchor / position_version / position_checksum` 四列；老库经迁移自动补齐。
- [ ] `book_note` 表含 `paragraph_anchor / position_version / position_checksum` 三列；老库自动补齐。
- [ ] `ReadingProgress` / `BookNote` / `BookNoteWrite` 模型带上述字段，默认值保证老客户端兼容。
- [ ] `GET/PUT /api/reading-progress`、`POST/GET /api/notes` 正确读写新字段；`PUT` 校验 `charOffset >= 0`。
- [ ] `saveProgress` 在 `BuiltinTools.kt` 等调用点编译通过（无位置参数错位）。
- [ ] 现有 testApplication / 单元测试在结构变更后仍通过（新增字段均为可选/默认）。
- [ ] 前端能在不破坏现有进度的前提下开始上报 `charOffset`（`readerProgress.ts` 与 API 类型扩展，二分定位恢复为后续子任务）。

---

<!-- 来源：docs/archive/reader-p1-design.md -->

## P1 实施设计 · 阅读器地基

> 配套：`reader-p1-requirements.md`（需求）、`reader-p1-tasks.md`（任务）
> 现状基线：以 `reader-archive.md`（v0.8.4）与实读代码为准

### 1. 现状（实读结论）

- **进度**（`reading_progress` 表 + `ReadingProgress` 模型）：`chapter_index + scroll_position`（0~1 比例）。**不是**逻辑位置——缺章节内字符偏移、段落锚点、version/checksum。
- **批注/书签**（`book_note` 表 + `BookNote`）：已是 `chapter_index + start_offset + end_offset`（**章节内字符偏移**），具备文本锚点雏形；缺 `paragraphAnchor / positionVersion / positionChecksum`。
- **前端进度**（`web/src/reader/readerProgress.ts`）：`{chapterIndex, total, fraction}`，fraction 即章内比例；与后端 `scroll_position` 对应。
- **迁移机制**（`Database.kt`）：`migrateReadingProgress` / `migrateBookNote` 用 `pragma table_info` + `alter table` 加列，模式成熟可复用。

### 2. 逻辑位置模型（P1-T1 已落地后端）

#### 2.1 数据模型

逻辑位置 = `章节标识(chapterUrl) + 章节内字符偏移(charOffset) + 段落锚点(paragraphAnchor)`，并附 `positionVersion` + `positionChecksum`。

- `charOffset`：章节正文内第一个可见字符的绝对偏移（0 基）。恢复时据此在分页结果里二分定位当前页（P1-T2 消费）。
- `paragraphAnchor`：稳定定位用的段落标识（段落索引或段首哈希），内容重排后辅助回退。可空。
- `positionVersion`：逻辑位置编码版本（当前 `1`），便于后续格式迁移。
- `positionChecksum`：保存时刻的章节内容校验值（**由前端提供**，如内容哈希）。内容漂移时用于判断 `charOffset` 是否失效 → 触发 P3 的模糊重定位。

#### 2.2 表变更（向后兼容）

`reading_progress` 新增列（经迁移）：

| 列 | 类型 | 默认 |
|---|---|---|
| `char_offset` | integer not null | 0 |
| `paragraph_anchor` | text | null |
| `position_version` | integer not null | 1 |
| `position_checksum` | text | null |

`book_note` 新增列（经迁移）：`paragraph_anchor(text)`、`position_version(integer not null default 1)`、`position_checksum(text)`。

`scroll_position` / `chapter_index` 保留，旧客户端与新字段互不冲突。

#### 2.3 代码改动（已完成）

- `model/Models.kt`：`ReadingProgress`、`BookNote`、`BookNoteWrite` 增加上述字段（均带默认值）。
- `data/Database.kt`：`migrateReadingProgress` / `migrateBookNote` 各追加 3~4 个 `alter table`（沿用既有模式）。
- `data/ReadingDao.kt`：`saveProgress` / `getProgress` / `addNote` / `listNotes` 读写新列，参数顺序对齐。
- `http/ProgressRoutes.kt`：`PUT /reading-progress` 校验 `charOffset >= 0`。
- `ai/BuiltinTools.kt`：修复 `ReadingProgress(...)` 6 位置参数调用，改用具名 `updatedAt =`。

#### 2.4 前端待办（P1-T1 后续子任务，需构建验证）

- `web/src/reader/readerProgress.ts` 的 `ReaderProgress` 增加 `charOffset`（由当前滚动/分页视图推导：首屏首字符在章节正文中的偏移）。
- 上报时附带 `paragraphAnchor`（当前段落标识）与 `positionChecksum`（章节内容哈希）。
- 恢复时：用 `charOffset` 在 P1-T2 的分页索引里二分定位当前页，替代「按 fraction 估算」。
- API 类型（`web/src` 内 `ReadingProgress` 接口）扩展字段，旧字段保留。

### 3. 后端逻辑位置收口（P1-T4 预告）

P1-T4 将新建 `ReadingRepository`，把进度/书签/划线/批注的读写从 `ProgressRoutes.kt` / `ReadingDao` 直接拼装收口到 Repository；DAO 退化为表级 CRUD。P1-T1 的字段已为这一步铺好数据结构。

### 4. 缓存抽象（P1-T5 预告）

P1-T5 引入统一缓存抽象，P1-T2 的分页缓存与 P2 的章节解析/媒体缓存共用。P1-T1 不引入新缓存，仅保证字段设计不阻碍后续。

### 5. 风险

- 前端 `charOffset` 推导需与 `readerFlow` / `pageTurn` 的渲染对齐，否则恢复位置偏差——列为 P1-T1 子任务，须配单测（P4-T4）。
- 大章节字符偏移可能很大，用 `integer`（SQLite 支持 64 位，但 Java/Kotlin `Int` 上限 ~21 亿字符；超长章节罕见，暂用 `Int`，超限再升 `Long`）。

---

<!-- 来源：docs/archive/reader-p1-tasks.md -->

## P1 任务清单 · 阅读器地基

> 配套：`reader-p1-requirements.md`、`reader-p1-design.md`
> 标记：`[x]` 已完成 · `[~]` 进行中/部分 · `[ ]` 待做

> **代码真实进度核对（2026-10-24）**：P1-T1 后端 / 类型 / 后端测试已落地，但 `readerProgress.ts` 的逻辑位置推导**仍未做**（仅 `api.ts` 类型与 `saveProgress(position)` 管道就绪，上报值暂为默认 0）；P1-T4 已落地（`ReadersRoutes.kt` 替代 `ProgressRoutes.kt` + `ReadingRepository` 收口 + `Routes.kt` 接入 + 测试通过），仅 DAO 降级留尾；P1-T2 基础设施已建（无 DOM 布局引擎 + IndexedDB 缓存，单测各 6/6，**渲染接入待 P2**——近似引擎与真实 CSS 排版结构性不一致，本阶段保留 DOM 测量不替换）；P1-T3 已收尾（三层解耦 + 沉浸式 + 退出把手 CSS 修复）；P1-T5 仍待启动。注意：当前仓库另有一批**不属于本 P1 spec** 的 0.8.x 阅读器功能改动（自定义应用名/图标 `BrandModal`/`brandStore`、书内搜索 `BookSearchDialog`、划线标记菜单 `MarkingMenu`、笔记导出 `noteExport`、选区上下文 `selectionStore`、书源健康排序 `SourceHealthDao`、AI 阅读侧工具），属常规迭代，请勿误并入 P1 验收。版本号唯一来源 `app/build.gradle`（当前 0.8.6）。

### P1-T1 逻辑位置模型
- [x] 后端模型扩展：`ReadingProgress` / `BookNote` / `BookNoteWrite` 增 `charOffset` / `paragraphAnchor` / `positionVersion` / `positionChecksum`（`Models.kt`）
- [x] 表迁移：`reading_progress` 四列、`book_note` 三列（`Database.kt` 沿用 `pragma table_info`+`alter table`）
- [x] DAO 读写对齐：`saveProgress` / `getProgress` / `addNote` / `listNotes`（`ReadingDao.kt`）
- [x] 路由校验：`PUT /reading-progress` 校验 `charOffset >= 0`（`ProgressRoutes.kt`）
- [x] 修复 `BuiltinTools.kt` 的 `ReadingProgress` 位置参数调用（改具名 `updatedAt`）
- [x] API 类型（`web/src/lib/api.ts`）扩展 `ReadingProgress` / `BookNote` / `BookNoteWrite` 逻辑位置字段
- [x] `saveProgress` 增加可选 `position` 参数，上报 `charOffset` / `paragraphAnchor` / `positionChecksum`（离线队列同步携带）
- [ ] 前端 `readerProgress.ts` 增加 `charOffset`，并由视图推导首屏首字符偏移（需理解 `readerFlow`/`pageTurn` 渲染映射）—— 已核对 `readerProgress.ts` 当前**未**含 `charOffset` 推导，仅 `api.ts` 类型与 `saveProgress(position)` 管道就绪，上报值暂为默认 0
- [ ] 前端恢复：用 `charOffset` 二分定位当前页（待 P1-T2 分页索引）
- [~] 单测：逻辑位置模型、字段默认值兼容、迁移补齐（`P4-T4` 范围）—— 新增 `LogicalPositionTest.kt`，后端 gradle 测试已覆盖；前端/迁移补齐待补
- [x] 验证（后端）：`gradle :app:test` 已于 2026-10-24 `BUILD SUCCESSFUL`（含 `ReadingAiToolsTest` / `ReadingRepositoryTest` / `BrandStoreTest` 等新测试，EXIT=0）；前端 `tsc -b && vite build` / `npm test` 仍未跑（上线门前待补）
- [x] 静态自检（2026-10-24）：全仓构造点排查 + 参数序号逐列核对 + 备份导入路径复核，无破坏性不一致
- [ ] 已知限制：逻辑位置字段暂不进 Legado 备份往返（`ImportDao` 导入列仅原始 6 列、`LibraryImportEntry` 不携带 charOffset；导出侧为通用转储，不受影响）—— 后续在备份格式里增补，非阻断

### 静态自检结论（2026-10-24）
- 后端：`ReadingProgress`/`BookNote`/`BookNoteWrite` 字段顺序与 DAO 的 INSERT/SELECT 列数、参数序号逐一核对一致；迁移用既有 `pragma table_info + alter table` 模式，新列均有默认值（向后兼容）。
- 调用点：`BuiltinTools.kt` 的 6 位置参数 `ReadingProgress` 已改为具名 `updatedAt`（否则错位到 `charOffset`）；其余测试/调用均为具名或 ≤5 位置参数，安全。
- 备份：`ImportDao` 导入 `reading_progress` 仅原始 6 列，新列走默认值 → 不中断；导出侧为通用转储，不受影响。
- 前端：`api.ts` 类型扩展为可选字段，`saveProgress` 增加可选 `position` 参数，老调用方（5 位置参数）不受影响；离线队列同步携带新字段。
- 阻塞：环境命令运行时挂钩超时，无法跑 gradle/vite 构建做真实验证。

### P1-T2 精确分页与缓存引擎（基础设施已建，渲染接入待 P2）
> **路线调整（2026-10-24）**：原拟「无 DOM 布局引擎一步替代 DOM 测量」经核实不可行——`measurePagination` 是对浏览器真实 CSS 排版的逆向测量（首行缩进→假栏数、跨栏 section 矩形量不准等坑它都处理了），而本阶段建的纯数学近似引擎（CJK 等宽）与真实 CSS 排版**结构性不一致**，直接替代会确定性翻页错位，非偶发风险。故本阶段只落地**基础设施**，渲染主路径保留 DOM 测量，精确引擎替代留 P2 把精度打磨到与 CSS 一致后再做。
- [x] 无 DOM 文本布局引擎 `web/src/reader/typeset/`（typesetParams / layoutEngine / layoutWorker）：纯 TS 数学排版，可在 Worker/主线程/Node 一致运行；单测 6/6 通过
- [x] 分页缓存 `web/src/reader/paginationCache.ts`：IndexedDB 落盘（key = 书 + 章节内容哈希 + 字体/字号/行距/边距/窗口尺寸 + 双栏模式；LRU 淘汰）；单测 6/6 通过
- [~] 二者当前**未接入** `ReaderScreen` 渲染主路径（避免近似引擎翻页错位）；接入与精度打磨归 P2
- [ ] P1-T5 统一缓存抽象：本阶段仅落地分页缓存这一具体实例，不做全局抽象（留 P1-T5）
- [ ] 页码仅作逻辑位置派生显示，不参与存储（不变）

### P1-T3 阅读三层解耦 + 沉浸式（已收尾）
- [x] 三层已解耦为独立组件：阅读面（正文）、导航面 `Md3Chrome.tsx`（`Md3TopBar`/`Md3BottomBar`，`position:fixed` overlay 不挤压正文）、设置面 `ReaderSheet.tsx`（底部 sheet，复用 `.dialog-shell`/`.overlay-backdrop`）
- [x] 默认沉浸式：`ReaderScreen.tsx` 的 `toolbarsVisible` 初始 `false`；纯阅读退出把手 `.reader-immersive-handle` 已补 CSS（此前缺样式、退化成文档流原生按钮，退出不可发现——已修 `styles.css`）
- [x] 设置面实时预览：设置走 React state 即时重渲正文，无提交/重开步骤
- [x] 判据 `web/test/ImmersiveDefault.test.ts`（5 条，含默认隐藏工具栏 / 沉浸 pill / 退出可发现 / overlay 不挤压正文）通过
- [ ] 路由图层化（阅读面默认安静、导航/设置面 overlay 不挤压正文）已满足；后续 P5 再做玻璃质感等增强

### P1-T4 阅读域模块 + ReadingRepository（已落地，DAO 降级留尾）
- [x] 新增 `readerRoutes()` 装配入口，`Routes.kt:182` 已按域调用（挂在 `route("/api")` 内）
- [x] 新建 `ReadingRepository` 统一封装进度 / 阅读记录 / 笔记划线（含书签）/ 本书检索读写；章节窗口留 P2 stub（`chapterWindow` 返回空，契约先定）
- [~] DAO 退化为表级 CRUD：业务读写已收口到 Repository，但 `Database` 的扩展函数（`saveProgress`/`getProgress`/`addNote`…）仍带业务语义、未被下沉为裸表级 CRUD —— 功能上已收口，降级为后续清理，非阻断
- [x] 路由文件从「端点清单」变为「域声明」（`ReadersRoutes.kt` 注释明确；旧 `ProgressRoutes.kt` 已删除，端点平移无重复注册，142 条 `/api` 契约不受影响）
- [x] 测试：`ReadingRepositoryTest.kt` 已建并随 `gradle :app:test` 通过

### P1-T5 统一缓存抽象（阅读侧）（待启动）
- [ ] 统一缓存抽象暴露 get/set/invalidate
- [ ] 分页缓存 / 章节解析缓存 / 媒体缓存经该抽象落盘
- [ ] 阅读模块只声明 cache key，不直接操作存储

### 依赖与门禁
- P1-T2 的「二分定位」依赖 P1-T1 前端 `charOffset` 推导完成。
- P1-T4 的 Repository 直接消费 P1-T1 已落地的数据字段。
- 任一任务落地须配 `P4-T4` 对应测试；版本号只改 `app/build.gradle`。

---

<!-- 来源：docs/archive/reader-verification-plan.md -->

## 阅读器重构 · 验证与测试规划

> 配套：`reader-redesign-roadmap.md`（五阶段）、`reader-p1-requirements.md` / `reader-p1-design.md` / `reader-p1-tasks.md`
> 目的：把「怎么算做完」落成可执行的测试门禁；记录当前核验状态
> 语言：简体中文

### 1. 当前核验状态（2026-10-24）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `npm --prefix legado run check`（`tsc -b`） | ✅ 退出码 0，无报错无警告（覆盖 `api.ts` 逻辑位置类型扩展）|
| 后端逻辑位置单测 | `gradlew :app:test --tests "io.legado.LogicalPositionTest*"` | ⏳ 后台运行中（task xcyqov）|
| 后端全量测试 | `npm test`（gradle） | ⏳ 待 P1-T1 单测通过后再跑，确认既有用例不受模型增量影响 |
| 静态自检 | 全仓构造点 + 参数序号 + 备份路径复核 | ✅ 无破坏性不一致 |

> 环境命令运行时（`agent-studio` 钩子）曾持续 3000ms 超时，阻塞 Bash/Glob；PowerShell 可用，已改用 PowerShell 跑构建/测试。

### 2. 构建与测试命令（备查）

#### 前端（`legado/web`）
- `npm --prefix legado run check` — TypeScript 类型检查（`tsc -b`）。改 `api.ts` / 前端类型后必跑。
- `npm --prefix legado/web run test` — 单测（`tsx test/run-all.ts`；不含需浏览器的 e2e）。
- `npm --prefix legado/web run test:coverage` — 覆盖率（`c8`）。
- `npm --prefix legado/web run test:e2e` — 浏览器压测（puppeteer，需 Chromium）。

#### 后端（`legado`，Kotlin/JVM）
- `npm test`（= `node scripts/tasks.mjs test`，即 gradle `:app:test`）— 全量单测。
- 定向：`gradlew :app:test --tests "io.legado.LogicalPositionTest*"`。
- 域级（P1-T4 后）：`testApplication` 只加载阅读域 + 必要插件，不启完整 fat jar（`web/test/ApiCatalog.test.ts` 已有 catalog 比对范式）。

#### 全栈冒烟
- `npm start` → `curl http://127.0.0.1:1234/healthz`（版本/存活）、`/api/catalog`（端点数）。

### 3. P1 验收门禁矩阵

| 任务 | 必须有的测试 | 说明 |
|---|---|---|
| **P1-T1 逻辑位置** | `LogicalPositionTest`（已加：进度/批注字段往返 + 老库迁移默认）| 前端 `charOffset` 视图推导 + 二分定位恢复单测待补（需 readerFlow 改造后）|
| **P1-T2 分页缓存** | 分页缓存 key 单测（`书ID+字号+行距+字体+窗口尺寸`）、改字号重排耗时基准、二分定位单测 | 性能基准见 `P4-T3` |
| **P1-T3 三层解耦** | E2E：默认沉浸式、导航/设置面 overlay 不挤压正文、隐藏控件可发现退出 | 复用 `E2EScenariosTest.ts` 范式 |
| **P1-T4 域模块** | `readerRoutes()` 装配 + `ReadingRepository` 收口后，域测试 `testApplication` 仅加载阅读域 | 路由从「端点清单」变「域声明」 |
| **P1-T5 缓存抽象** | 统一缓存 get/set/invalidate 单测；阅读模块只声明 key | 与 P1-T2 / P2 媒体缓存共用 |

### 4. 跨阶段门禁（P4-T4 复用）

- 同源写门：新增端点自动受保护（`SameOriginGuardTest` 已有范式，扩展覆盖阅读域新端点）。
- SSRF 闸门：`NetworkSecurityTest` / `OpenAiProviderSsrfTest` 已有，新增出站点复用。
- 域级测试：每个域落地须配对应测试，否则视为未完成（见 roadmap 跨阶段约束）。

### 5. 已知限制与风险

- 逻辑位置字段暂不进 Legado 备份往返（`ImportDao` 导入列仅原始 6 列，`LibraryImportEntry` 不携带 `charOffset`）—— 后续在备份格式增补。
- 前端 `charOffset` 视图推导 + 二分恢复未完成，是 P1-T1 剩余子任务（依赖 P1-T2 分页索引）。
- 大章节字符偏移用 `integer`（上限 ~21 亿字符），超限章节罕见，超阈值再升 `Long`。

### 6. 下一步建议

1. 等后台 gradle 单测结果；若通过，跑 `npm test` 确认既有用例无回归。
2. 进入 P1-T2（精确分页引擎）：先做可独立测试的「分页缓存 key + 落盘」，再接 Web Worker。
3. 每完成一个 P1 子任务即补对应单测，门禁见第 3 节。

---

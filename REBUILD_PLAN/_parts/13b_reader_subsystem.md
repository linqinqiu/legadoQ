# 13b — 阅读器子系统（ReaderScreen 之外）+ 交叉审计

> Phase 0.5「阅读器深读」· 审计员 deep-reader-subsystem
> 源码基线：`E:\legadoQ-archive\`（只读；不 build、不测、不改）
> 证据标注：**confirmed**（已读源码逐行确认）/ **likely**（静态可推但未验证运行时）/ **needs-runtime-test**
> 行号会漂移，引用为"读取时快照行号"。

## 0. 状态

- [x] 骨架落盘
- [x] §1 文件清单
- [x] §2 八个 reader hook 解剖
- [x] §3 纯函数目录价值评估
- [x] §4 阅读进度端到端链路
- [x] §5 章节内容数据模型
- [x] §6 缓存与正文加载职责边界
- [x] §7 交叉审计六问
- [x] §8 证据索引 + 未确认 + 覆盖率

## 1. Reader 子系统文件清单

`features/reader/` 共 **70 个文件 / 约 11,000 行**（`find | wc -l` 实测：`content/` 16、`tts/` 8、`interaction/` 7、`settingsPanel/` 11、`notes/` 6、`dialogs/` 3、`reviews/` 1、`dict/` 1、根层 17）。分类如下。

### 1.1 hook（8 个，含 TTS）

| 文件 | 行 | 职责一句话 | 核心导出 | 被谁引用（grep 实证） |
|---|---|---|---|---|
| `useReaderChapterContent.ts` | 136 | 章节正文的加载/预取/取消/重试 | `useReaderChapterContent`, `ReaderChapterProgress` | `ReaderScreen.tsx:35`（仅此一处） |
| `useReaderCacheStatus.ts` | 139 | 服务端书架缓存状态 + 浏览器 IndexedDB 合成一张缓存表 | `useReaderCacheStatus` | `ReaderScreen.tsx:34` |
| `usePaginationMeasurement.ts` | 190 | 分页模式把 DOM 排成栏、算页区间与页码落点 | `usePaginationMeasurement` | `ReaderScreen.tsx:37` |
| `useReaderPageTurn.ts` | 77 | 翻页动画状态（slide/fade/cover 收尾三路） | `useReaderPageTurn` | `ReaderScreen.tsx:36` |
| `useReadingLog.ts` | 46 | 停留计时，30 秒一段上报阅读记录 | `useReadingLog` | `ReaderScreen.tsx:38` |
| `useReaderNotes.ts` | 193 | 笔记/划线状态 + 选区→草稿 + 增删改 | `useReaderNotes` | `ReaderScreen.tsx:39` |
| `useReaderPositionJump.ts` | 120 | 跳转到笔记/搜索命中的导航原语 | `useReaderPositionJump` | `ReaderScreen.tsx:40` |
| `tts/useReaderTts.ts` | 369 | 朗读集群：19 状态 + 播放/暂停/分片/跨章续播 | `useReaderTts` | `ReaderScreen.tsx:43`, `tts/ReaderTtsContext.tsx:2`（仅类型） |

**结论**：8 个 hook **全部只被 `ReaderScreen.tsx` 消费**，没有一个被第二个页面/组件复用 —— 它们是"从 2403 行组件里切出来的切片"，不是通用能力库。confirmed（grep 全量 `src` 只有上表命中）。

### 1.2 纯函数目录（无 React、可单测）

| 文件 | 行 | 职责 | 核心导出 | 被谁引用 |
|---|---|---|---|---|
| `content/logicalPosition.ts` | 142 | 逻辑位置（字符偏移/锚点/校验值）+ DOM 小工具 | `buildParagraphStarts`, `offsetToParagraph`, `paragraphAnchor`, `checksumText`, `textOffsetWithin`, `textOffsetRect`, `caretOffsetWithin`, `LogicalPosition` | `ReaderScreen.tsx:31`, `usePaginationMeasurement.ts:4`, `useReaderPositionJump.ts:3` |
| `content/readerFlow.ts` | 199 | 滚动连续流 + 分页网格算术 | `chapterConsumed`, `flowAdvance`, `holdScroll`, `sectionAtPage`, `pageProgress`, `pageWindowShift`, `prependLandingPage`, `pageAlignmentPads`, `pageAlignmentStarts`, `sectionProgress`, `resolveMeasuredPage` | `ReaderScreen.tsx:29`, `usePaginationMeasurement.ts:3` |
| `interaction/readerInteractions.ts` | 240 | 点击分区（旧三区）/手势/滚轮归一/分页布局/段落相交/图片占位行 | `scrollTapZone`, `paginateTapZone`, `isTapGesture`, `swipeDirection`, `isInteractiveReaderTarget`, `wheelPixels`, `paginateWheelStep`, `calculatePaginationLayout`, `findFirstFullyIntersecting…`, `findFirstIntersectingParagraphIndex`, `contentImageUrl`, `isSameSiteAsset`, `TOC_ROW_HEIGHT` | `ReaderCatalog.tsx:7`, `ReaderScreen.tsx:11/30`, `usePaginationMeasurement.ts:2`, `VirtualChapterList.tsx:8`, `tts/ttsTextProcessor.ts:1`, `tts/useReaderTts.ts:20`, `content/contentImages.ts:3`, `content/mangaPages.ts:3`（8 处） |
| `interaction/tapZones.ts` | 213 | 虚线模型点击分区表 + 预设 + 清洗/迁移 | `zoneAt`, `clampCut`, `addCut`, `removeCut`, `remapActions`, `sanitizeMap`, `migrateGrid`, `DEFAULT_MAPS`, `TAP_PRESETS` | `ReaderScreen.tsx:14`, `ReaderChrome.tsx:7`, `settingsPanel/readerSettings.ts:2`, `interaction/TapZoneEditor.tsx:21` |
| `interaction/pageTurn.ts` | 59 | 翻页决策状态机（逐页/跨章/动画选择） | `planNextPage`, `planPrevPage`, `pageTurnAnim`, `coverDirection` | `ReaderScreen.tsx:28`, `useReaderPageTurn.ts:2`, `settingsPanel/readerSettings.ts:6` |
| `interaction/shortcuts.ts` | 119 | 快捷键表（唯一来源） | `READER_SHORTCUTS`, `GLOBAL_SHORTCUTS`, `normalizeKey`, `isTypingTarget`, `shortcutFor` | `main.tsx:38`, `ReaderScreen.tsx:45`, `interaction/ShortcutHelp.tsx:5` |
| `interaction/readerMenu.ts` | 58 | 工具栏菜单项唯一来源 | `parseReaderMenu`, `toggleReaderMenu`, `moveReaderMenu`, `DEFAULT_READER_MENU` | `ReaderScreen.tsx:26`, `Md3Chrome.tsx:2`, `ReaderHeader.tsx:2`, `settingsPanel/OtherSettingsPanel.tsx:7`, `settingsPanel/readerSettings.ts:3`（5 处，复用最好的一份） |
| `content/chunkedRender.ts` | 32 | 超大章节分块阈值/补块 | `shouldChunk`, `growLimit`, `ensureLimit` | `ReaderScreen.tsx:48` |
| `content/mangaPages.ts` | 86 | 漫画分页/双页/页↔偏移 | `mangaPages`, `mangaSpreadSize`, `mangaSpreadStart`, `mangaNextStart`, `mangaPrevStart`, `mangaSpreadPages`, `mangaIndexAtOffset`, `mangaPageLabel`, `mangaFraction` | `ReaderScreen.tsx:49`, `settingsPanel/readerSettings.ts:5` |
| `content/readerProgress.ts` | 44 | 底栏进度的外部 store（避开整屏重渲染） | `reportProgress`, `getProgress`, `subscribeProgress`, `overallProgress` | `ReaderScreen.tsx:21`, `VirtualChapterList.tsx:11` |
| `content/virtualSlice.ts` | 87 | 定高虚拟列表算术 | 窗口切片/偏移计算 | `VirtualChapterList.tsx`（目录 5000 章） |
| `content/paragraphs.ts` | 19 | 正文切段 | `splitParagraphs` | `ReaderScreen.tsx`（`splitBody`） |
| `content/mediaKind.ts` | 56 | 媒体地址分类（直链/HLS/播放页） | `mediaKind` 等 | `content/MediaBlock.tsx`, `content/HlsVideo.tsx` |
| `content/scriptConvert.ts` | 147 | 简繁转换逻辑（字典动态载入） | `loadScriptConverter`, `SCRIPT_MODE_OPTIONS` | `ReaderScreen.tsx`, `settingsPanel/OtherSettingsPanel.tsx` |
| `content/contentImages.ts` | 23 | 正文图片预热 | `warmContentImages` | `ReaderScreen.tsx` |
| `content/readerImage.ts` | 16 | 正文配图地址唯一算法 | `readerImageSrc` | `content/MediaBlock.tsx`, `ReaderBody.tsx` |
| `content/fontSizeControl.ts` | 19 | 字号唯一口径 15–28 | `clampFontSize`, `stepFontSize`, `READER_FONT_SIZE_MIN/MAX` | `settingsPanel/TypographyTab.tsx`, `readerSettings.ts`, `backupPreferences.ts` |
| `notes/bookmark.ts` | 58 | 书签判重/摘要/写入体 | `findBookmarkAt`, `bookmarkExcerpt`, `bookmarkPayload` | `ReaderScreen.tsx:16`, `useReaderNotes.ts:7` |
| `notes/reanchor.ts` | 121 | 批注锚点重定位（6 级降级） | `normalizeWithMap`, `relocateNote`, `reanchorNotes` | `useReaderNotes.ts:8` |
| `notes/noteExport.ts` | 107 | 笔记导出 Markdown | `notesToMarkdown`, `downloadMarkdown` | `notes/NotesPanel.tsx` |
| `notes/noteFilter.ts` | 18 | 笔记三档筛选 | `filterNotes`, `noteCounts` | `notes/NotesPanel.tsx` |
| `searchTerm.ts` | 23 | 关键词切片高亮 | `splitByTerm` | `dialogs/BookSearchDialog.tsx`, `ReaderBody.tsx` |
| `settingsPanel/backupPreferences.ts` | 144 | 备份包 → 本机 ReaderSettings 映射 | 映射函数 | `plugins/backup/BackupPage.tsx` |
| `dict/openccData.ts` | 120 | OpenCC 字表/词表（自动生成数据） | 数据常量 | `content/scriptConvert.ts`（动态 import） |

### 1.3 UI 组件

| 文件 | 行 | 职责 | 被谁引用 |
|---|---|---|---|
| `ReaderScreen.tsx` | 2403 | 状态中枢：正文/分页/TTS/漫画/导航/持久化 | `main.tsx`（路由渲染） |
| `ReaderChrome.tsx` | 218 | 外壳（工具栏/抽屉/浮层布局） | `ReaderScreen.tsx:22` |
| `ReaderBody.tsx` | 296 | 正文本体（滚动流 / 分页轨道） | `ReaderScreen.tsx:20` |
| `ReaderOverlays.tsx` | 238 | 各类弹层装配 | `ReaderScreen.tsx:23` |
| `ReaderCatalog.tsx` | 149 | 目录抽屉 | `ReaderChrome.tsx:4` |
| `ReaderHeader.tsx` | 72 | 顶栏 | `ReaderScreen.tsx` |
| `Md3Chrome.tsx` | 131 | MD3 外壳 | `ReaderScreen.tsx` |
| `VirtualChapterList.tsx` | 172 | 定高虚拟目录 | `ReaderCatalog.tsx:6` |
| `ReaderSheet.tsx` 39 · `IconButton.tsx` 9 · `ReaderContentSkeleton.tsx` 26 · `NoteHighlights.tsx` 47 | — | 底部弹层 / 图标按钮 / 骨架屏 / 高亮渲染 | 各 1–3 处 |
| `settingsPanel/` 11 文件（769+437+224+145+138+131+122+56+55+45+144） | 2,266 | 设置：`ReaderSettingsSheet` 容器、`ReaderSettingsControls` 三标签、`Typography/Color/Behavior` 三页、`OtherSettingsPanel` 工具页、`SkinModal`/`BackgroundLibrary` 皮肤背景编辑器、`SettingRow` 行控件、`readerSettings.ts` 类型+解析+存取 | `ReaderScreen`, `main.tsx:10`, `BackupPage.tsx:6` |
| `interaction/` 3 组件（`TapZoneEditor` 209 / `MarkingMenu` 48 / `ShortcutHelp` 40） | 297 | 分区编辑器 / 标记快捷条 / 快捷键表 | `ReaderScreen.tsx`, `main.tsx` |
| `notes/` 2 组件（`NotesPanel` 107 / `NoteToolbar` 49） | 156 | 笔记面板 / 笔记浮层 | `ReaderOverlays.tsx` |
| `tts/` 4 组件（`ReaderTtsManager` 233 / `TtsPlayerBar` 160 / `TtsSettingsModal` 364 / `ReaderTtsContext` 28）+ `ttsBarPosition.ts` 209 | 994 | 朗读管理器 / 悬浮条 / 设置弹窗 / Context / 悬浮条位置记忆 | `ReaderScreen.tsx` |
| `dialogs/` 3（`RefreshChaptersModal` 259 / `BookSearchDialog` 116 / `TocDrawerHeader` 87） | 462 | 批量刷新正文 / 本书检索 / 目录标题栏 | `ReaderOverlays.tsx`, `ReaderCatalog.tsx` |
| `reviews/ChapterReviewsDialog.tsx` | 251 | 段评只读详情层 | `ReaderScreen.tsx`（`reviewsOpen`） |

### 1.4 引擎

| 文件 | 行 | 职责 | 备注 |
|---|---|---|---|
| `tts/ttsEngine.ts` | 638 | 两个引擎实现：`WebSpeechEngine`（浏览器）/`HttpAudioTtsEngine`（服务端 `/api/tts/*` 流式分片 + prefetch + resetSession） | 被 `useReaderTts.ts:18`、`TtsPlayerBar.tsx:3`、`ReaderChrome.tsx:9`、`ReaderHeader.tsx:3`、`Md3Chrome.tsx:3` 引用 |
| `tts/ttsTextProcessor.ts` | 145 | 章节 → 分片（title + 句子，带 `paragraphIndex`/`globalIndex`） | 被 `useReaderTts.ts:19` |
| `settingsPanel/readerSettings.ts` | 769 | 设置的类型/默认值/解析/迁移/localStorage 存取 | 也被 `main.tsx:10`、`BackupPage.tsx:6` 引用（唯一跨 feature 复用的 reader 文件） |
| `content/scriptConvert.ts` + `dict/openccData.ts` | 147+120 | 简繁转换（字典动态载入） | 唯一按需 chunk 加载的一块 |

## 2. 八个 reader hook 逐个解剖

统一口径：**"可独立测试"= 能否在 node:test 里不起 React 渲染/不起浏览器直接钉行为**。现状只有 1 个 hook 有独立判据（见 §3.4）。

### 2.1 `useReaderChapterContent`（136 行）
- **职责**：当前章正文的请求、状态、预取（前后各若干章）、取消、手动重试。
- **内部 state**：`content`, `mediaUrl`, `loadedChapterUrl`, `message`, `loading`, `reloadToken`（`useReaderChapterContent.ts:41-50`）。
- **内部 ref**：`preloadedContentRef`（`Map<url,string>`，上限 12 条 LRU，`:54-61`）、`preloadingRef`、`onLoadedRef`（`:51-52`，避免回调进依赖导致每帧重请求）。
- **外部 store/API**：`api.content(sourceId, chapterUrl, bookUrl)`（`:69`, `:104`）→ `POST /api/books/content`。
- **持久化**：**间接**。它自己不写库；`api.content` 内部会 `putOfflineChapter(...)`（`lib/api/domains/search.ts:112`）写浏览器 IndexedDB。
- **与 ReaderScreen 耦合方式**：**全 props 注入**（`chapter/chapters/sourceId/bookUrl/startIndex/progress/onLoaded`），唯一的回调 `onLoaded` 放 ref。这是 8 个 hook 里**解耦最干净**的一个。
- **可独立测试**：**是（理论上）**，只需 mock `api.content`。现状：无独立判据（`TtsEngineSwitch.test.ts:174` 只断言"预载命中要在绘制前换好正文"，是源码字符串判据）。
- ⚠ **缺陷**：`useLayoutEffect` 依赖数组含 `progress?.scrollPosition/charOffset/paragraphAnchor/positionChecksum`（`:116`）。父组件把 `currentBook.progress` 传进来后**若对象被替换**（例如刷新书架/重进），这四个字段一变就重新请求整章正文。confirmed。

### 2.2 `useReaderCacheStatus`（139 行）
- **职责**：合成"服务端书架 `book_cache_status` + 浏览器 IndexedDB 章节集合"的离线缓存状态；caching 期间 3s 轮询。
- **内部 state**：`cacheStatus`（state/cached/total/error）、`cachedChapterUrls`、`chapterWordCounts`、`inShelf`、`shelfTocRule`（`:34-47`）。
- **外部 store/API**：`api.bookshelf()`（整份书架！`:66`）、`api.getCachedChapters`（`:67`）、`getOfflineChaptersSet`（`:68`）三者 `Promise.all`。
- **持久化**：只读，不写。
- **耦合**：props 注入 4 项（bookName/sourceId/bookUrl/chapterCount），但**返回值被 ReaderScreen 直接改**（`setCachedChapterUrls`/`setChapterWordCounts` 在 `ReaderScreen.tsx:251-259` 被直接调用）—— 说明"hook 拥有状态、父组件直写"的边界是软的。
- **可独立测试**：部分（需 mock 三个 api + IndexedDB）。现状：无。
- ⚠ **性能隐患**：`syncCacheStatus` 依赖 `[bookName, bookUrl, chapterCount, sourceId]`，caching 期间每 3 秒拉一次**整份书架** `api.bookshelf()`（`:118-124` 注释自认"几千本时是 MB 级"）。needs-runtime-test。

### 2.3 `usePaginationMeasurement`（190 行）
- **职责**：分页模式唯一的重活 —— 量 DOM 算出每章占几栏、页区间、首屏恢复页码。搬出时"一个字节都没改"（`:26-36` 注释）。
- **内部 state**：`pageCount`, `pageFillers`, `columnWidth`, `stride`, `isDoubleColumn`（`:50-55`）。
- **内部 ref**：`pageSpansRef`, `measuredStartsRef`, `columnsPerPageRef`, `pageAlignedRef`, `pendingPageRef`（`:57-63`）。
- **外部 store/API**：**无网络调用**；读 `performanceMonitor.record('pagination_measure')`（`:118`）；写 `setPageIndex`（父传入）。
- **持久化**：无。
- **耦合**：10 个 props，其中 4 个是 ref（`targetInitialPageRef`/`initialPagePositionRef`/`initialLogicalPositionRef`/`logicalMetaRef`）—— **通过 ref 与父组件共享可变状态**，这是最强的耦合形式（父组件在 `handleChapterLoaded` 里写这些 ref，`ReaderScreen.tsx:270-281`）。
- **可独立测试**：**难**（要真 DOM 排版 + Range 测量）。现状：无直接判据；`ReaderPagination.test.ts` 只测其依赖的 `calculatePaginationLayout`。

### 2.4 `useReaderPageTurn`（77 行）
- **职责**：三种翻页动画的状态机（slide 只在页码差 1 时；fade 淡出淡回；cover 延迟提交 `setPageIndex`）。
- **内部 state**：`fading`, `coverTurn`, `coverEntered`；ref `prevPageIndexRef`, `coverTurnRef`（`:23-39`）。
- **外部**：`pageTurnAnim`（纯函数）、`setPageIndex`（父传入）。
- **持久化**：无。**耦合**：4 props，最轻。
- **可独立测试**：**是**（逻辑几乎全在 `pageTurn.ts` 纯函数里，已测 `PageTurn.test.ts`）；hook 本身的三条收尾路径（transitionend / 600ms 兜底 / finishCover 去重）无判据。

### 2.5 `useReadingLog`（46 行）
- **职责**：页面可见时计时，每 30 秒 `api.addReadingLog` 一段；换章与卸载时把零头也报掉。
- **内部 state**：无 React state，全是闭包变量（`pending`/`last`/`visible`，`:23-25`）。
- **外部**：`api.addReadingLog` → `POST /api/reading-log`。
- **持久化**：写 `reading_log` 表（服务端，`ReadingDao.kt:58`）。
- **耦合**：4 props，最轻。**可独立测试**：是（但需 mock `document.visibilityState`）。判据：`ReadingLog.test.ts:52` 断言接线（源码字符串）。
- ⚠ **重复计时风险**：`useReaderTts` 的 TTS 播放期同样在"阅读页可见"状态里，TTS 自动续章会走 `changeChapter` → 卸载重挂 effect → `tick()` 收尾上报，秒数不会重复计（每次都是新闭包）。**likely**，未实测。

### 2.6 `useReaderNotes`（193 行）
- **职责**：笔记/划线的状态、选区→草稿（`buildSelectionDraft`）、增删改、标记快捷条动作。
- **内部 state**：`notes`, `noteDraft`, `notesPanel`, `noteEditorOpen`（`:34,55,57,59`）。
- **外部 store/API**：`api.notes/addNote/updateNote/deleteNote`（`:37,132,142,157`）、`setSelection/setSelectionFromDraft`（`lib/selectionStore`，为 AI 悬浮球同步选区，`:3,124`）、`toast`。
- **持久化**：写 `book_note` 表（`ReadingDao.kt:90/118/124`）。**重定位只改内存不写库**（`reanchor.ts` 顶部注释 + `useReaderNotes.ts:47-50`）。
- **耦合**：props 7 项 + **直接 `window.getSelection()` / 直接读 DOM `data-paragraph-index`**（`:76-93`）—— 它是"逻辑 + DOM 读"混在一起，不是纯逻辑 hook。
- **可独立测试**：难（要真 selection/DOM）。判据：`Note.test.ts:22` 是源码字符串断言，`Reanchor.test.ts` 钉的是纯函数 `relocateNote`。

### 2.7 `useReaderPositionJump`（120 行）
- **职责**：`jumpToNote` / `jumpToSearchHit` 两个导航原语 + 跨章落点 effect。
- **内部 state**：无 state；**19 个 props**（`useReaderPositionJump.ts:9-31`），包括 4 个 ref 回调。
- **外部**：无 API；全靠父传入的 `changeChapter`/`scrollToLogicalPosition`/`revealParagraph`。
- **持久化**：无（`changeChapter` 会触发父的 `persist()`）。
- **耦合**：**最重**（19 props，且 `pendingNoteJumpRef` 是父子共享可变 ref）。
- **可独立测试**：中（落点算法依赖 DOM 与 `offsetToParagraph`）。判据：`Bookmark.test.ts:98`、`SearchJump.test.ts:43` 为源码字符串接线断言。

### 2.8 `tts/useReaderTts`（369 行）
- **职责**：朗读集群。19 个状态/ref + 9 个回调 + 2 个 effect（`:1-8` 自述）。
- **内部 state**：`ttsActive`, `ttsPlayState`, `currentChunkIndex`, `sleepTimer`, `showTtsSettings`, `offlineTtsConfirmOpen`（`:70-75`）；ref：`autoPlayNextChapterRef`, `webSpeechEngineRef`, `httpAudioEngineRef`, `playTtsChunkRef`（`:77-82`）。
- **外部 store/API**：`ttsEngine.ts` 两个引擎（HTTP 引擎走 `/api/tts/session`、`/chunks`、`/control`、`/speak`，见 `lib/api/domains/reader.ts:424-477`）。
- **持久化**：**不写阅读进度，但会触发父的 `persist()`** 3 处（`:147` 章末自动续章、`:318` 上一章、`:326` 下一章）。
- **耦合**：11 项 deps，其中 `changeChapterRef`/`playTtsChunkRef` 是**为了打破 `playTtsChunk ↔ changeChapter` 循环依赖**而引入的 ref 环（`:47-52`, `ReaderScreen.tsx:830-831`）。
- **可独立测试**：难。判据：`TtsEngineSwitch.test.ts`（源码 + 纯函数 `ttsSessionKey`）、`tts.test.ts`（`ttsTextProcessor` 纯函数）。

### 2.9 hook 层小结

| hook | 行 | props/deps 数 | 是否直接读 DOM | 是否直接调 API | 是否有独立判据 |
|---|---|---|---|---|---|
| useReaderChapterContent | 136 | 7 | 否 | 是（content） | 否 |
| useReaderCacheStatus | 139 | 4 | 否 | 是（3 个） | 否 |
| usePaginationMeasurement | 190 | 10（4 ref） | 是（重度） | 否 | 否（依赖项有） |
| useReaderPageTurn | 77 | 4 | 否 | 否 | 依赖项有 |
| useReadingLog | 46 | 4 | 否（document） | 是（log） | 源码断言 |
| useReaderNotes | 193 | 7 | 是 | 是（4 个） | 部分（纯函数部分） |
| useReaderPositionJump | 120 | 19 | 是 | 否 | 源码断言 |
| useReaderTts | 369 | 11（2 ref） | 是（querySelector） | 是（引擎内部） | 部分 |
| **合计** | **1,170** | — | 5/8 | 5/8 | 0 个可算"业务判据" |

**核心结论（confirmed）**：hook 化的收益是**阅读性**，不是**可测性**。8 个 hook 没有一份行为判据会真的驱动它们跑一遍；判据只覆盖它们调用的纯函数（`readerFlow`/`logicalPosition`/`pageTurn`/`mangaPages`/`relocateNote`）与源码字符串。这是本轮重建必须补的第一类判据缺口。

## 3. 纯函数目录的价值评估

### 3.1 真正可复用、可单测的原语（建议重建时保留为独立模块）

| 模块 | 函数（行号） | 为什么是真原语 | 已有判据 |
|---|---|---|---|
| `content/logicalPosition.ts` | `buildParagraphStarts:21` `offsetToParagraph:32` `paragraphAnchor:54` `checksumText:59` `textOffsetWithin:69` `textOffsetRect:86` `caretOffsetWithin:120` | 4 个消费方（进度保存、批注锚定、分页恢复、TTS 起始句）共用同一套"字符偏移 ↔ DOM"算法；纯算术 + 标准 DOM API，无业务状态 | `LogicalPosition.test.ts:11-50`（6 条，含"页首半段也要算"） |
| `content/readerFlow.ts` | `chapterConsumed:33` `flowAdvance:48` `holdScroll:62` `sectionAtPage:73` `pageProgress:83` `pageWindowShift:97` `prependLandingPage:114` `pageAlignmentPads:131` `pageAlignmentStarts:145` `sectionProgress:162` `resolveMeasuredPage:186` | 全是"滚动/分页位置算术"，每条都有反向对照判据（"按高度算就会漏掉分隔线边距"） | `ReaderFlow.test.ts:21-135`（12 条） |
| `interaction/pageTurn.ts` | `planNextPage:30` `planPrevPage:36` `pageTurnAnim:48` `coverDirection:57` | 状态机决策与 DOM 完全分离 | `PageTurn.test.ts:14-49`（5 条） |
| `content/mangaPages.ts` | `mangaPages:16` `mangaSpreadSize:28` `mangaSpreadStart:33` `mangaNextStart:39` `mangaPrevStart:45` `mangaSpreadPages:54` `mangaIndexAtOffset:65` `mangaPageLabel:76` `mangaFraction:83` | 漫画双页/rtl/末屏边界，"在 DOM 里试很贵"（文件头自述） | `MangaMode.test.ts:34-101`（7 条） |
| `notes/reanchor.ts` | `normalizeWithMap:23` `relocateNote:54` `reanchorNotes:109` | 6 级降级重定位，每级一条判据 | `Reanchor.test.ts:22-80`（9 条） |
| `notes/bookmark.ts` | `findBookmarkAt:12` `bookmarkExcerpt:24` `bookmarkPayload:30` | 判重/摘要/写入体三件事都有边界 | `Bookmark.test.ts:24-67`（5 条） |
| `interaction/tapZones.ts` | `zoneAt:85` `countBelow:93` `cellCenter:100` `clampCut:110` `addCut:117` `removeCut:140` `remapActions:144` `sanitizeMap:162` `migrateGrid:192` `looksLikeGrid:211` | 表代数 + 清洗 + 一次性迁移；`removeCut` 的注释记录了一个真实静默 bug（`filter((_, item) => item !== index)` 拿值比下标） | `TapZones.test.ts:32-126`（12 条） |
| `content/chunkedRender.ts` | `shouldChunk:15` `growLimit:20` `ensureLimit:29` | 3 个纯算式，阈值/块大小集中 | `ChunkedRender.test.ts:15-28`（3 条） |
| `content/fontSizeControl.ts` | `clampFontSize` `stepFontSize` + 15/28 常量 | 3 处（设置/快捷键/Ctrl+滚轮）原本各抄一份边界 | `FontSizeControl.test.ts` |
| `content/virtualSlice.ts` | 窗口切片/偏移 | 目录 5000 章的虚拟化；原本产品与判据各一份 | `VirtualChapterList.test.ts:24-192` |
| `content/paragraphs.ts` | `splitParagraphs:9` | 19 行，纯 | `ReaderOptimization.test.ts:112` |
| `content/mediaKind.ts` | 媒体地址分类 | 56 行纯函数 | `mediaKind.test.ts` |
| `interaction/readerMenu.ts` | `parseReaderMenu:30` `toggleReaderMenu:44` `moveReaderMenu:50` | **唯一来源**模式的最佳范例（工具栏 + 设置面板共用） | `ReaderMenu.test.ts` |
| `interaction/shortcuts.ts` | `normalizeKey:28` `isTypingTarget:45` `shortcutFor:53` + 两张表 | 同上，唯一来源 | `Shortcuts.test.ts` |
| `content/readerProgress.ts` | `reportProgress:30` `overallProgress:41` | 外部 store（非 React state），避免每帧整屏重渲染；阈值 0.002 去抖 | 无（`VirtualChapterList` 有间接用法） |
| `notes/noteExport.ts` / `noteFilter.ts` | 导出 Markdown / 三档筛选 | 纯 | `NoteExport.test.ts` |

### 3.2 实质是"从大组件里搬出来的胶水"

| 文件 | 行 | 判断依据 |
|---|---|---|
| `interaction/readerInteractions.ts` | 240 | **混合体**。一半是真原语（`calculatePaginationLayout:107`、`findFirstIntersectingParagraphIndex:201`、`contentImageUrl:229`、`paginateWheelStep:79`），一半是**产品里已经不用的旧实现**：`scrollTapZone:3` / `paginateTapZone:10` / `mobileTapZone:17`（硬编码 0.3/0.7 三段）已被 `tapZones.zoneAt` 取代，全 `src` 只剩 `ReaderScreen.tsx:2038` 一句**注释**提到它们（confirmed，grep 全仓）。**但 `ReaderPagination.test.ts` 有 16 处、`reader-interactions-settings.test.ts` 有 10 处断言在测这三个死函数** —— 判据在给死代码背书。 |
| `content/contentImages.ts` | 23 | 只是把 `contentImageUrl` + `readerImageSrc` 串起来（`warmContentImages`），无独立算法。 |
| `searchTerm.ts` | 23 | 关键词切片，只服务搜索弹窗与正文高亮两处，可合进 `BookSearchDialog`。 |
| `settingsPanel/backupPreferences.ts` | 144 | 备份包字段名 → 本机字段名的映射表 + 夹取，业务只有一份消费者（`BackupPage.tsx`）。 |
| `content/readerImage.ts` | 16 | 4 行有效逻辑（拼 `/api/book/image` 参数 + 同源判定），但**它是对的**：渲染/预热/重取三处必须同址，收一处是正确决定。属"小而必要的胶水"。 |
| `tts/ttsBarPosition.ts` | 209 | 209 行只为"悬浮条可拖动 + 记忆位置 + 双击复位"，其中位置记忆还写 `pushUiPref`（服务端 UiPrefs）。体量与价值不成比例。 |

### 3.3 结论

- **可复用原语约 15 个模块 / ~1,400 行**，都有纯函数判据，重建时应**原样保留 + 保留判据**。
- **胶水约 6 个文件 / ~650 行**，其中 `readerInteractions.ts` 的旧点击分区（`scrollTapZone`/`paginateTapZone`/`mobileTapZone`）是**应当删除 + 同步删除对应 26 处断言**的技术债（否则重建后判据仍会对着旧实现变绿）。
- 纯函数目录的**判据密度是全子系统最高的**（`ReaderFlow` 12 条、`TapZones` 12 条、`Reanchor` 9 条），这是这套代码最值钱的部分。

### 3.4 判据覆盖统计（reader 相关测试文件）

| 测试文件 | 行数 | 测的是 |
|---|---|---|
| `ReaderPagination.test.ts` | 414 | 旧点击分区（**死代码**）、边界、手势、分栏布局 |
| `VirtualChapterList.test.ts` | 305 | 目录虚拟化 |
| `ReadThroughFixes.test.ts` | 230 | 一批回归钉（含"晚到响应不许写回"） |
| `ChapterReviews.test.ts` | 208 | 段评分层错误 |
| `ReaderOptimization.test.ts` | 202 | 分段/进度/预载 LRU |
| `TtsEngineSwitch.test.ts` | 191 | 朗读会话身份 + 接线 |
| `ReaderFlow.test.ts` | 173 | 连续流/分页网格 |
| `ReadingLog.test.ts` | 157 | 阅读统计 |
| `MangaMode.test.ts` | 135 | 漫画 |
| `TapZones.test.ts` | 130 | 点击分区表 |
| `Bookmark.test.ts` | 107 | 书签 |
| `TtsBarPosition.test.ts` | 91 | 悬浮条位置 |
| `Reanchor.test.ts` | 85 | 锚点重定位 |
| `SearchJump.test.ts` 66 · `LogicalPosition.test.ts` 62 · `PageTurn.test.ts` 56 · `Note.test.ts` 47 · `ChunkedRender.test.ts` 47 · `ReaderReload.test.ts` ~30 · `RefreshChapters.test.ts` 66 · `tts.test.ts` 72 · `ReaderScreenSmoke.test.ts` | — | 各自纯函数/源码接线 |
| `ReaderScreenSmoke.test.ts` | ~90 | **唯一真的渲染阅读器**的判据（`renderToStaticMarkup`，`ReaderScreenSmoke.test.ts:47-58`），且动机就是"118 份判据没有一份渲染过阅读器"（`:19`） |
| **合计** | **约 3,100 行 / 24 个文件** | — |

## 4. 阅读进度的端到端链路（重点）

### 4.1 写入链路（保存）

```
[前端触发] ReaderScreen.persist()                       features/reader/ReaderScreen.tsx:816-828
      │  readLogicalPosition(chapter) 取语义位置          ReaderScreen.tsx:735-783
      │  clampScrollPosition(current.position)           lib/scrollProgress.ts:14
      ▼
api.saveProgress(...)                                   lib/api/index.ts:274 → domains/reader.ts:153-185
      │  body = {sourceId, bookUrl, chapterUrl, chapterIndex, scrollPosition,
      │          charOffset?, paragraphAnchor, positionVersion:1, positionChecksum?, updatedAt:Date.now()}
      ▼  PUT /api/reading-progress                       reader.ts:181-184
[后端路由] ReadersRoutes.kt:36-41  put("/reading-progress")
      │  requireSameOriginWrite()                        ReadersRoutes.kt:37
      │  校验：sourceId/bookUrl/chapterUrl 非空、chapterIndex>=0、charOffset>=0、
      │        scrollPosition 有限且 ∈[0,1]                ReadersRoutes.kt:39
      ▼
[Repository] ReadingRepository.saveProgress             reading/ReadingRepository.kt:40-41
      ▼
[DAO] Database.saveProgress  (write{})                  data/ReadingDao.kt:15-47
      ├─ charOffset == null → 只 UPDATE 4 列（chapter_url,chapter_index,scroll_position,updated_at）:21-25
      │                        命中 0 行则 INSERT 7 列（position 列走表默认值）:28-32
      └─ charOffset != null → 10 列 upsert（含 paragraph_anchor / position_version / position_checksum）:36-41
      └─ 顺带 UPDATE book_shelf.last_read_at              data/ReadingDao.kt:43-45
[表] reading_progress
     主键 (source_id, book_url)                          data/db/Schema.kt:44-48
     列：chapter_url, chapter_index, updated_at（建表）  Schema.kt:45-46
     + scroll_position / char_offset / paragraph_anchor /
        position_version / position_checksum（迁移补）    data/db/Migration.kt:110-124
```

### 4.2 读取链路（恢复）

```
书架点书 main.tsx:547-564
  Promise.all([ api.chapters(...), api.progress(...) ])   main.tsx:548-549
  resumeIdx = progress.chapterIndex ?? item.chapterIndex ?? 0   main.tsx:551
  openReader({...progress}, resumeIdx, 'shelf')           main.tsx:552-564
  （progress 取不到时用书架行的 chapterIndex/scrollPosition 拼一个**降级进度**，无 charOffset）main.tsx:556-563

GET /api/reading-progress?sourceId=&bookUrl=             domains/reader.ts:148-152
  → ReadersRoutes.kt:30-35 → ReadingRepository.getProgress:37 → ReadingDao.kt:49
  → 无记录回 204 No Content（前端得到 undefined）

ReaderScreen 消费：
  handleChapterLoaded(content, media, ch)                ReaderScreen.tsx:246-282
    position = 首屏 ? progress.scrollPosition : 0         :268
    initialLogicalPositionRef = progress.charOffset!=null
        && progress.positionChecksum ? {...} : null        :270-278
    initialPagePositionRef = position                     :281
  分页模式恢复：usePaginationMeasurement.measurePagination  :139-158
    校验 pendingLogical.positionChecksum === logicalMetaRef.checksum
      → offsetToParagraph + textOffsetRect → 栏号 → 页码   :141-157
    校验不过 → resolveMeasuredPage(null, initialPagePositionRef) 按**比例**兜底 :174
  滚动模式恢复：useLayoutEffect                            ReaderScreen.tsx:1425-1483
    校验 checksum 匹配 → scrollToLogicalPosition（段落级）  :1463-1464
    否则 maxScroll * initialPos 比例兜底                   :1471-1472
    （分块章节目标段还没挂 → 先 revealParagraph，交给 pendingNoteJumpRef）:1448-1456
  漫画恢复：mangaIndexAtOffset(paragraphStarts, pages, charOffset)  :618-623
```

### 4.3 进度字段语义（前端产生 → 后端存 → 恢复时用）

| 字段 | 前端怎么产生 | 后端怎么存 | 恢复时怎么用 |
|---|---|---|---|
| `scrollPosition` (0..1) | `sectionProgress()`（滚动，分母=本章）/ `pageProgress()`（分页，分母=本章页数）/ `mangaFraction()`；经 `clampScrollPosition` 夹取 | `real not null default 0`（`Migration.kt:111`） | **降级坐标**：语义位置校验不过时按比例落点（`ReaderScreen.tsx:1471`, `usePaginationMeasurement.ts:174`）；书架行也读它（`ShelfDao.kt:21` 的 `p.scroll_position`） |
| `charOffset` (int, 章节内绝对字符偏移) | `readLogicalPosition()` = `meta.starts[段落index] + 段内偏移`（`ReaderScreen.tsx:778-782`）；段内偏移来自 `caretOffsetWithin`（`logicalPosition.ts:120`，`scriptMode==='off'` 时）否则 0 | `integer not null default 0`（`Migration.kt:114`）；`null` = 本次没提交，走"只更新位置"分支（`ReadingDao.kt:18-33`）—— **注意：`charOffset=0` 是有效值（章首），不能被当成没传**（`ReadingDao.kt:35` 注释） | 主坐标：`offsetToParagraph` 二分回段落 + 段内偏移 → `textOffsetRect` 取矩形 → 栏/滚动位置 |
| `paragraphAnchor` (string, `p<index>`) | `paragraphAnchor(index)`（`logicalPosition.ts:54`） | `text`（`Migration.kt:117`） | **只存不用**：恢复路径完全按 `charOffset` 二分，`paragraphAnchor` 在进度恢复里**没有被读**（grep `paragraphAnchor` 于 ReaderScreen：仅用于写进度/书签判重/跳笔记）。`ReadingRepository.kt:107-109` 的注释还写着"`paragraphAnchor` 这一列前端还没有生成规则（只透传、不产出）" —— **该注释已过时**（前端 `logicalPosition.ts:54` 早在产出 `p<idx>`），后端注释与前端实现不一致。 |
| `positionVersion` | 硬编码 `1`（`reader.ts:175`） | `integer not null default 1` | 不读，仅格式迁移预留 |
| `positionChecksum` (FNV-1a 32 位 hex) | `checksumText(content)`（`logicalPosition.ts:59`），`logicalMetaRef.checksum` | `text`（`Migration.kt:122-124`） | **有效性闸门**：`pendingLogical.positionChecksum === logicalMetaRef.current.checksum` 才用 charOffset，否则退回比例（`usePaginationMeasurement.ts:141`, `ReaderScreen.tsx:1463`）。重建时这条闸门必须保留 |

### 4.4 **进度保存是否有唯一入口？**

**结论：HTTP 层有唯一入口（`PUT /api/reading-progress`），"应用层"没有单一 owner，且其中一条前端写入通路是死代码。** 逐条证据：

#### 前端写入点（全部收敛到 `persist()`，但有 11 个调用点）

| # | 触发时机 | 位置 | 备注 |
|---|---|---|---|
| 1 | 切章（含目录跳转/章末推/续接顶窗口） | `ReaderScreen.tsx:1065` | `changeChapter` 内，**先 persist 再切** |
| 2 | 顶栏/底栏「上一章」 | `:1133` | |
| 3 | 「下一章」 | `:1138` | |
| 4 | 滚动流顶掉已读章 | `:1702` | 与 `setChapterIndex` 同一帧 |
| 5 | 滚动停下 1200ms 去抖 | `:1718-1723` | 唯一"静默自动保存" |
| 6 | 页面转入后台（`visibilitychange` hidden） | `:1726-1728` | 手机锁屏/切标签页 |
| 7 | 阅读器卸载 / 切翻页模式（effect cleanup） | `:1736` | 离开阅读器的落库点 |
| 8 | 分页翻页 1200ms 去抖 | `:1754-1758` | |
| 9 | 漫画翻屏 1200ms 去抖 | `:1786-1790` | |
| 10 | 左上角「返回」 | `:2271` | `onBack: () => { persist(); stopTts(); onClose() }` |
| 11 | 朗读跨章（章末自动续播 / 上一章 / 下一章） | `tts/useReaderTts.ts:147, 318, 326` | 经 hook deps 传入的 `persist` |

去抖共用一个 `timerRef`（`ReaderScreen.tsx:1718`/`:1754`/`:1786`）：**三种模式共用一个定时器**，滚动模式与分页模式互斥所以不冲突；但 `persist()` 一触发就会读到"当前 ref 里的位置"，**同一时刻只有一个 pending 写**。confirmed。

#### 前端第二条写入通路：存在但是**死代码**

- `main.tsx:334-344` 监听 `window 'online'` → `flushOfflineProgress(...)` → `api.saveProgress(...)`（`main.tsx:339`）。
- 但 `enqueueOfflineProgress()`（`lib/offlineStorage.ts:447-460`）在**整个 `web/src` 里没有任何调用点**（confirmed：`grep -rn enqueueOfflineProgress src` 只命中定义本身）。
- ⇒ 队列 `legado_offline_progress_queue` 永远是空的，`flushOfflineProgress` 每次 `return 0`。**"离线进度补发"是一条已建好但从没接上的管子**。`offline-pwa.test.ts:339`（`OfflineStorage - Offline Reading Progress Queue Lifecycle and Flush`）测的是这条管子本身能通，测不出"没人往里灌"。**这是本轮最值得记录的假绿判据之一。**

#### 后端其他写入点（非 HTTP 进度接口）

| # | 写入者 | 位置 | 覆盖关系 |
|---|---|---|---|
| A | 备份/书库导入 | `data/ImportDao.kt:148-168` | 只写 `chapter_index`/`char_offset`/`updated_at`（`chapter_url` 置空串、`scroll_position` 置 0），并**主动把 `paragraph_anchor`、`position_checksum` 置 null**（`:157-158`），且带 `where excluded.updated_at >= reading_progress.updated_at` 的**乐观并发闸门**（`:159`）—— 全系统唯一一处并发保护 |
| B | 目录重切后夹进度 | `data/ShelfDao.kt:77-85` `clampShelfProgress` | 只改 `chapter_index`（夹到新章数-1），不动位置列 |
| C | 删书 / 批量删 / 换源 | `data/ShelfDao.kt:241, 265, 335` | 直接 `delete from reading_progress` |
| D | 批量标已读/未读 | `http/ShelfRoutes.kt:281-290` | **已不再碰 `reading_progress`**（`:276-280` 注释记录的正是"以前改进度导致界面不变 + 抹掉进度"的教训） |

#### 覆盖关系与风险

- **同一本书的并发写**：`ReadingDao.saveProgress` 用 `updated_at = System.currentTimeMillis()`（服务端时钟，`:16`），**完全忽略**前端传来的 `progress.updatedAt`（`reader.ts:179` 送了这个字段，后端不读）。所以多标签页/多设备是**最后到达者胜**，没有版本比较。severity **中**（单机单用户场景下几乎不可见；一旦多端同时读同一本就会出现"进度倒退"）。
- **前端 in-flight 乱序**：`persist()` 是 `void api.saveProgress(...).catch(()=>undefined)`，**不排队、不取消、不比对 `updatedAt`**。1200ms 去抖只能降低频率；一次慢请求（服务端在跑规则引擎回源）期间的第二次 persist 可能先落地、第一次后落地 → 进度倒退。**needs-runtime-test**，severity **中**。
- **导入覆盖阅读进度**：A 的闸门用的是导入包里 `readAt`（可能是旧时间戳），所以只在"备份比本机新"时覆盖 —— 设计正确。但 `paragraph_anchor`/`position_checksum` 被清空意味着**导入后首次恢复一定退回比例坐标**，精度下降。severity **低**（有注释说明是刻意取舍）。

## 5. 章节内容的数据模型（几套？）

### 5.1 前端有 5 个相关类型，其中 4 个描述"正文/进度"形状

| # | 形状 | 定义位置 | 字段 | 层 |
|---|---|---|---|---|
| F1 | `Chapter` | `lib/api/types.ts:129-134` | `index` `title` `url` `isVolume?` | 目录条目 |
| F2 | 章节正文响应（**匿名内联类型，没有命名**） | `lib/api/domains/search.ts:102-105` | `title?` `content` `mediaUrl?` | `POST /api/books/content` 返回 |
| F3 | `OfflineChapterRecord` | `lib/offlineStorage.ts:7-16` | `key` `sourceId` `bookUrl` `chapterUrl` `title` `content` `cachedAt` `byteSize` | 浏览器 IndexedDB |
| F4 | `ReaderChapterProgress` | `features/reader/useReaderChapterContent.ts:4-9` | `scrollPosition?` `charOffset?` `paragraphAnchor?` `positionChecksum?` | 只做 hook 入参 |
| F5 | `ContentProcess`（AI 覆盖正文） | 前端经 `book/content-process` 收发，**无独立类型**（请求体在 `ReaderScreen.tsx` 内联） | `sourceId/bookUrl/chapterUrl/kind/original/processed` | 覆盖层 |

### 5.2 后端有 2 套

| # | 形状 | 定义位置 | 字段 |
|---|---|---|---|
| B1 | `Chapter` | `model/ReadingModels.kt:21` | `index` `title` `url` `isVolume=false` |
| B2 | `ChapterContent` | `model/ReadingModels.kt:45-53` | `title?` `content` **`mediaUrl?`** |

### 5.3 一致性核对

| 对比 | 结论 |
|---|---|
| F1 vs B1 | **完全一致**（字段名/可空性/默认值都对得上），JSON 直通。confirmed |
| F2 vs B2 | **字段一致，但 F2 是匿名类型**：前端没有任何地方声明 `ChapterContent`，同一形状在 `search.ts:102-105` 内联一次、在 `useReaderChapterContent.ts:105` 靠推断传递。重建时只要有人改动返回值，编译器不会有第二处提醒。severity **低**（类型层面）/ 见下一行（运行期）。 |
| **F3 vs B2：`mediaUrl` 缺失 —— 线索属实** | `offlineStorage.ts:7-16` 的 `OfflineChapterRecord` **没有 `mediaUrl`**；`downloadChaptersToOffline` 的回调签名只有 `{title?, content}`（`offlineStorage.ts:502`）；`putOfflineChapter` 参数也没有（`offlineStorage.ts:98-104`）。写 IndexedDB 的唯一入口 `search.ts:112` 只传 `res.title/content`。confirmed。 |
| **服务端 `book_content_cache` 也没有 `media_url`** | `data/db/Schema.kt:74-79` 只有 `source_id,book_url,chapter_url,chapter_index,title,content,cached_at`；`CacheDao.cachedContent:230-232` 回构 `ChapterContent(title, content)`，**`mediaUrl` 恒为 null**。 |
| ⇒ **推论（关键）** | `ReadingRoutes.kt:182-183` 缓存命中时直接 `respond(override(cached))` —— **音频/视频章第一次读有 `mediaUrl`，第二次读就没了**。前端只能靠"`content` 本身就是地址"兜底（`ReaderScreen.tsx:679-694` 注释与代码自认这一点，`mediaSrc` 计算见 `:684-694`）。severity **中**：媒体源在"缓存命中 + 书源类型声明不准"时可能退化成把 URL 排成文字。**needs-runtime-test**（真实音频源第二次进入阅读器）。 |

### 5.4 结论

- **"章节条目"模型是单一的**（F1 = B1，干净）。
- **"章节正文"模型有 4 份拷贝**（B2 声明型；F2 匿名型；F3 离线型，缺 `mediaUrl`；F5 AI 覆盖型，缺 `title`/`mediaUrl`），其中 **`mediaUrl` 在除了"首次线上返回"以外的每一条路径上都会丢失**（服务端缓存丢一次、IndexedDB 再丢一次）。
- 重建建议（记录给负责人，不在本轮实施）：把 `ChapterContent` 定为唯一 DTO，`book_content_cache` 加 `media_url text` 列，`OfflineChapterRecord` 同步加；否则媒体类书源永远处于"靠兜底嗅探"的状态。

## 6. 缓存与正文加载的职责边界

### 6.1 四层存储，各自的职责（实测）

| 层 | 承载物 | 谁写入 | 谁读 | 生命周期 |
|---|---|---|---|---|
| **L1 服务端正文缓存** | `book_content_cache`（`Schema.kt:74-80`）+ `book_cache_status`（缓存队列状态） | `CacheDao.cacheBookContent:326`（读正文时顺手写 `ReadingRoutes.kt:188`；批量刷新 `:221`；整本缓存队列 `POST /api/bookshelf/cache`） | `CacheDao.cachedContent:230`（`ReadingRoutes.kt:153`） | 服务端持久；7 天图片缓存另算 |
| **L2 浏览器 IndexedDB** | `legado_offline_db/chapters`（`offlineStorage.ts:38-47`） | `putOfflineChapter:98` ← ①`api.content` 成功即写（`search.ts:112`，**fire-and-forget**）②`downloadChaptersToOffline:498`（用户点"离线同步"） | `getOfflineChapter:148`（仅在请求失败时）、`getOfflineChaptersSet:179`（UI 状态）、`getOfflineStorageStats:285`（占用统计） | 浏览器配额；`QuotaExceededError` 时按 `lastCachedAt` LRU 整本淘汰（`offlineStorage.ts:384-403`） |
| **L3 内存章节窗口** | `preloadedContentRef`（`Map`，上限 12 章，`useReaderChapterContent.ts:47,54-61`）+ 连续流已挂章 `flowHead/flowTail`（`ReaderScreen.tsx:1093-1094`） | 预取 `preload:63`、续接 `prependPreviousChapter` | 加载 effect（`useReaderChapterContent.ts:100-102`） | 组件生命周期；换书不自动清（`clearPreload` 存在但是否被调用见 §8 未确认） |
| **L4 React state** | `content`/`mediaUrl`/`loadedChapterUrl` | 同上 | 渲染 | — |

### 6.2 **谁负责决定"用哪一份"？**

**答案：`lib/api/domains/search.ts` 的 `content()` 是唯一决策点，而且它是隐式的 —— 阅读器完全不知道拿到的是哪一份。**

`search.ts:94-126` 的策略：
1. 先 `POST /api/books/content`（服务端会再自行决定 L1 命中还是回源，`ReadingRoutes.kt:182-195`）；
2. 成功 → 顺手 `putOfflineChapter(...)`（`:111-113`，不 await，失败静默）；
3. 失败（且 `!force`）→ 读 L2 `getOfflineChapter`（`:118-123`），命中就当成功返回；
4. `force=true`（用户点"刷新本章"）→ **不许**用 L2 兜底（`:116-118` 注释：否则"刷新了还是这些字"）。

⇒ **决策顺序是"服务端先、本地兜底"，但反过来的语义从未实现**："本地有就不用发网络"是不成立的（离线时每次翻页都要等一次失败的 HTTP 往返）。severity **中**（离线阅读体验；`needs-runtime-test`：断网下翻页是否会卡住一个 RTT）。

`useReaderChapterContent` 在 L3 之上又加了一层优先级：**预取命中 → 直接用，不发请求**（`:100-102`），且此时传 `mediaUrl = null`（`:102` `apply(preloaded, null)`），因为预取只记住了 `content` 字符串（`:70` `remember(target.url, result.content)`）。**⇒ 预取过的媒体章一定丢 `mediaUrl`**（与 §5.3 的结论叠加）。confirmed。

### 6.3 三处交叠与打架

| 交叠 | 现象 | 证据 |
|---|---|---|
| **"离线缓存"是两个不同功能，共用一套文案** | ①服务端队列：`handleCacheAll` → `POST /api/bookshelf/cache` → `book_cache_status.state='caching'` → 3s 轮询（`ReaderScreen.tsx:1204-1216`, `useReaderCacheStatus.ts:118-124`），按钮文案"缓存全本/离线缓存"（`ShelfPage.tsx:754`）；②浏览器同步：`handleSyncToLocal` → `downloadChaptersToOffline` → IndexedDB（`ReaderScreen.tsx:1218-1257`），文案"离线同步"。**两者写的是不同的库、不同的容量、不同的失效方式**，用户看到的都是"缓存了几章"。severity **中** |
| UI 的"已缓存"标记是两个来源的并集 | `useReaderCacheStatus.syncCacheStatus` 把 `cachedChapterUrls`（服务端）与 `getOfflineChaptersSet`（IndexedDB）合并（`:74-85`）；`chapterWordCounts` 只来自服务端 `cachedWordCounts` | `useReaderCacheStatus.ts:65-86` |
| 服务端 `cachedChapters` 与并集取大 | `cached: Math.max(item.cachedChapters, mergedSet.size)`（`:102`）—— `Math.max` 而不是并集大小，两个数不同量纲时进度条会跳 | `useReaderCacheStatus.ts:100-105` |
| 浏览器缓存的淘汰与服务端队列互不知情 | IndexedDB 配额满会**整本**淘汰别的书（`offlineStorage.ts:384-403`），但不清 `book_cache_status`，也不通知阅读器；服务端仍认为"缓存好了" | `offlineStorage.ts:129-134`, `:384` |
| 图片另有第三套 | `/api/book/image` 代理磁盘缓存 7 天 + 浏览器侧 `v=` 代次参数（`content/readerImage.ts:9-16`），与章节缓存完全无关 | `content/readerImage.ts` |

### 6.4 结论

- **职责边界在"数据层"是清楚的**（L1 服务端 / L2 浏览器 / L3 内存互不覆盖），**在"决策层"是混的**：决策被塞进 API 客户端（`search.ts:94-126`），既不属于数据层也不属于阅读器，且阅读器无法感知来源（拿不到"这条是缓存还是回源"的标志）。
- **两套离线缓存共用文案**，是最容易在重建时被合并错的地方：合并成一套会丢"服务端整本缓存"这个跨设备能力；保持两套就必须在 UI 上区分（当前没有，只在阅读器里叫"离线同步"、书架上叫"缓存全本"）。
- L3 只记住 `content`、不记 `mediaUrl`，是 §5 `mediaUrl` 丢失链路的第三环。

## 7. 交叉审计六问

### 问 1：Reader 是否直接依赖规则引擎内部实现？

**结论：前端零依赖（干净）；后端阅读路由直接依赖 `RuleRunner` 门面 + 构造 `JsSandbox`（轻度越界）。严重度：低。**

| 证据 | 内容 |
|---|---|
| 前端无任何 rules 相关 import | `grep -rn "RuleRunner\|JsSandbox\|ruleContent\|ruleToc" product/web/src` 无命中；阅读器只认 `Chapter`/`content` 字符串（`lib/api/domains/search.ts:94-126`）。**confirmed** |
| 后端阅读路由直接持 `RuleRunner` | `fun Route.readingRoutes(database: Database, runner: RuleRunner)`（`http/ReadingRoutes.kt:53-56`），直接调 `runner.details/chapters/content/reviews`（`:75, :115, :119, :187, :219`） |
| 更近一步：阅读路由**自己 new 一个 JsSandbox** | `val jsSandbox = JsSandbox(runner)`（`http/ReadingRoutes.kt:166`），用于本地书正文的净化管道。HTTP 层直接构造规则引擎内部对象，是"路由 → rules 内部"的越界（AGENTS 的分层只约束 Repository 位置，没约束这一条） |
| 规则引擎不认识阅读器 | `RuleRunner` 无 reader 概念，`content()` 的入参只有 `sourceJson, chapterUrl, bookName, bookUrl`（`ReadingRoutes.kt:187`） |

**重建含义**：规则引擎与阅读器的**接口面本来就是干净的**（`ChapterContent`/`Chapter` 两个 DTO + 一个 `content()` 方法）。越界只发生在 HTTP 装配层，重建时把 `JsSandbox` 的构造收进 `ContentProcessor` 或一个 `ContentService` 即可，不需要动规则引擎。

### 问 2：Rules 是否知道 Reader 的 UI 状态？

**结论：不知道。规则引擎对阅读器的全部认知是"书名 + 章节地址 + 书源 JSON"。严重度：低（这是好事）。**

| 证据 | 内容 |
|---|---|
| 净化管道收到的上下文 | `ContentProcessor.processContent(cached.content, rules, jsSandbox, bookName, chapterTitle)`（`ReadingRoutes.kt:167`）—— 只有 `bookName` 与 `chapterTitle` 两个字符串 |
| 替换规则的 scope | `database.getEnabledReplaceRulesForScope(bookName, "local://")`（`ReadingRoutes.kt:165`）：按书名限定作用域，与 UI 无关 |
| 反向确认 | 前端 `ttsEngine`/`pageMode`/`fontSize` 等设置从不进入任何 HTTP 请求体（grep `pageMode` 于 `lib/api`：仅 TTS 请求里没有；`ReaderSettings` 只在 `main.tsx` 与 `BackupPage` 本地用） |
| 唯一的"UI 影响规则"通道是**书源字段** | `BookDetails.imageStyle` / `sourceType`（`ReadingModels.kt:16-19`）由书源决定渲染，反向不成立 |

### 问 3：阅读器是否直接访问 DAO？/ 前端是否在做本该服务端做的数据操作？

**结论：前端当然碰不到 DAO；但**确实在客户端做了 5 类本该服务端做（或至少该有服务端副本）的数据操作**。严重度：中。**

| # | 客户端做数据操作 | 位置 | 为什么算问题 |
|---|---|---|---|
| 3a | **本地拼阅读进度**（章序号 + 字符偏移 + 内容校验值） | `ReaderScreen.tsx:816-828` + `logicalPosition.ts:59`（FNV-1a 校验值在浏览器算） | 服务端只存不算。同一份"校验值算法"在服务端**没有实现**，所以服务端永远无法判断一个 `charOffset` 是否还有效 —— 有效性只有客户端知道（`usePaginationMeasurement.ts:141`）。重建若要做"服务端校验"，必须把算法搬到服务端或定义成契约 |
| 3b | **本地算章节序 / 加章边界判定** | `changeChapter`（`ReaderScreen.tsx:1046-1097`）里跳过 `isVolume` 卷头（`:1056-1058`）、边界提示"已是第一章/最后一章"（`:1049, :1061`）；`planNextPage`（`pageTurn.ts:30-39`）判定跨章 | 服务端有 `tocChapters` 与 `clampShelfProgress`（`ShelfDao.kt:77`），但"下一章是谁"的判定权在前端。两处规则必须一致，否则进度夹取与跳章会打架 |
| 3c | **本地做批注锚点重定位**（6 级降级 + stale 标记） | `notes/reanchor.ts:54-103`，调用点 `useReaderNotes.ts:47-50` | 只改内存不写库（刻意）。**后果**：服务端的 `paragraph_anchor`/`position_checksum` 永远是"写入时的那个"，服务端无法知道某条批注已经 stale |
| 3d | **本地做 IndexedDB LRU 淘汰 + 空间统计** | `offlineStorage.ts:285-403`（`getOfflineStorageStats` / `evictLruOfflineBooks`） | 服务端完全不知道浏览器删了什么；`book_cache_status` 会与实际不符 |
| 3e | **本地做"本书检索"的结果高亮切片**（检索本身在服务端） | 服务端 `ReadingDao.searchBookContent:139`；前端 `searchTerm.splitByTerm` + `SearchFlash` 6 秒过期（`ReaderScreen.tsx:809-814`） | 这一条**分工正确**，列出以示对照 |

**没有发现的**：前端没有任何 SQL/直接存储访问、没有自己实现 DAO、没有绕过 `/api` 的裸 fetch（`BareFetch.test.ts` 守着）。

### 问 4：进度保存是否有统一入口？

**结论：HTTP 层唯一（`PUT /api/reading-progress`）；应用层不唯一（前端 11 个触发点、4 条后端写入路径、1 条死代码通路）；并发无保护。严重度：中。** 详见 §4.4。摘要：

- ✅ 唯一 HTTP 写入口 `PUT /api/reading-progress`（`ReadersRoutes.kt:36`），唯一 DAO 函数 `Database.saveProgress`（`ReadingDao.kt:15`）。
- ⚠ 前端所有保存都过 `persist()`，但 `persist()` 有 **11 个调用点**，且 `persist` 本身不排队、不去重、不比对 `updatedAt`。
- ⚠ 后端另有 4 条非 HTTP 写入：备份导入（`ImportDao.kt:152`，**唯一带并发闸门的一处**）、目录重切夹取（`ShelfDao.kt:77`）、删书/换源删除（`ShelfDao.kt:241/265/335`）。
- ⚠ "离线补发队列"是**死代码**：`enqueueOfflineProgress`（`offlineStorage.ts:447`）无调用者，`main.tsx:335` 的 `flushOfflineProgress` 永远处理空队列。
- ⚠ 前端送的 `updatedAt`（`reader.ts:179`）后端**不读**，DAO 一律用服务端 `System.currentTimeMillis()`（`ReadingDao.kt:16`）⇒ 多端/多标签页**最后到达者胜**，可能进度倒退。

### 问 5：章节内容是否存在多套数据模型？

**结论：存在 4 套"正文"形状，且 `mediaUrl` 在 3 条路径上会丢。严重度：中。** 详见 §5。

- 单一：`Chapter` 目录条目（前端 `types.ts:129` == 后端 `ReadingModels.kt:21`）。
- 多套：正文有 `ChapterContent`（后端声明）、匿名内联响应类型（前端 `search.ts:102`）、`OfflineChapterRecord`（缺 `mediaUrl`）、`book_content_process`（AI 覆盖，只有 `original/processed`）。
- 服务端缓存表 `book_content_cache` 无 `media_url` 列（`Schema.kt:74-79`）⇒ 缓存命中即丢；预取只记 `content` ⇒ 再丢；IndexedDB 结构无 ⇒ 三丢。

### 问 6：缓存与正文加载是否职责混乱？

**结论：数据分层清楚，决策权错位，文案撞车。严重度：中。** 详见 §6。

- 决策点塞在 API 客户端 `search.ts:94-126`（服务端先、IndexedDB 兜底），阅读器**拿不到来源标记**；"本地有就不发网络"未实现。
- **两套离线缓存功能共用"离线缓存"文案**：服务端队列（`POST /api/bookshelf/cache`）vs 浏览器同步（`downloadChaptersToOffline`）。
- 三处"已缓存"判定（服务端 `cachedChapterUrls`、IndexedDB 集合、服务端 `cachedChapters` 计数）用 `Math.max` 合成一个数（`useReaderCacheStatus.ts:102`），量纲不同时会跳。

### 7.7 六问汇总

| 问 | 结论 | 严重度 |
|---|---|---|
| 1 Reader 依赖规则引擎内部实现 | 前端零依赖；HTTP 层直接 `new JsSandbox(runner)`（`ReadingRoutes.kt:166`） | **低** |
| 2 Rules 知道 Reader UI 状态 | 不知道，只传 bookName/chapterTitle | **低**（良性） |
| 3 前端在客户端做服务端的事 | 5 类：进度拼装/校验值、章节序判定、批注重定位、IndexedDB LRU、（检索高亮为正确分工） | **中** |
| 4 进度唯一入口 | HTTP 唯一，应用层 11+4+1 条路径，无并发保护 | **中** |
| 5 章节内容多套模型 | 4 套正文形状，`mediaUrl` 三处丢失 | **中** |
| 6 缓存与加载职责 | 分层清楚、决策错位、两套离线缓存撞文案 | **中** |

## 8. 证据索引 + 未确认 + 覆盖率

### 8.1 证据索引（按结论分组，全部可复核）

**进度链路**
| 结论 | 证据 |
|---|---|
| 唯一前端保存函数 `persist()` | `features/reader/ReaderScreen.tsx:816-828` |
| 语义位置产生 | `ReaderScreen.tsx:735-783`（`readLogicalPosition`），依赖 `logicalPosition.ts:21/32/54/59/120` |
| 唯一 HTTP 写入口 | `lib/api/domains/reader.ts:153-185` → `http/ReadersRoutes.kt:36-41` |
| 唯一 Repository 方法 | `reading/ReadingRepository.kt:40-41` |
| 唯一 DAO 函数（两个分支） | `data/ReadingDao.kt:15-47`（null 分支 `:21-33`，upsert 分支 `:36-41`） |
| 表与列 | `data/db/Schema.kt:44-48` + `data/db/Migration.kt:110-124` |
| 读入口 | `http/ReadersRoutes.kt:30-35` → `ReadingRepository.kt:37` → `ReadingDao.kt:49` |
| 前端读调用 | `main.tsx:547-564`（`api.progress` 与 `api.chapters` 并行） |
| 恢复：分页 | `features/reader/usePaginationMeasurement.ts:139-158`（checksum 闸门 `:141`） |
| 恢复：滚动 | `features/reader/ReaderScreen.tsx:1425-1483`（checksum 闸门 `:1463`） |
| 恢复：漫画 | `ReaderScreen.tsx:605-624`（`mangaIndexAtOffset`） |
| 11 个 persist 调用点 | `ReaderScreen.tsx:1065, 1133, 1138, 1702, 1721, 1727, 1736, 1757, 1789, 2271`；`tts/useReaderTts.ts:147, 318, 326` |
| 死代码离线队列 | 定义 `lib/offlineStorage.ts:447-460`；消费 `main.tsx:334-344`；**无生产者**（grep 全 `src`） |
| 后端非 HTTP 写入 | `data/ImportDao.kt:148-168`（唯一并发闸门 `:159`）、`data/ShelfDao.kt:77-85`、`ShelfDao.kt:241/265/335` |
| 后端不读前端 `updatedAt` | 前端送 `reader.ts:179`；DAO 用 `ReadingDao.kt:16` 的服务端时钟 |

**内容模型 / 缓存**
| 结论 | 证据 |
|---|---|
| `Chapter` 前后端一致 | `web/src/lib/api/types.ts:129-134` == `app/.../model/ReadingModels.kt:21` |
| 正文响应是匿名类型 | `web/src/lib/api/domains/search.ts:102-105` |
| `ChapterContent.mediaUrl` | `model/ReadingModels.kt:45-53` |
| 服务端缓存表无 media_url | `data/db/Schema.kt:74-80`；`data/CacheDao.kt:230-232`（回构时 `mediaUrl` 恒空） |
| 缓存命中丢 mediaUrl | `http/ReadingRoutes.kt:182-183` |
| IndexedDB 结构无 mediaUrl | `lib/offlineStorage.ts:7-16`, `:98-104`, `:498-505` |
| 预取丢 mediaUrl | `useReaderChapterContent.ts:70`（只存 content）、`:102`（`apply(preloaded, null)`） |
| 预取上限 12 章 | `useReaderChapterContent.ts:54-61` |
| 加载决策点 | `lib/api/domains/search.ts:94-126`（失败兜底 `:118-123`，force 禁兜底 `:116-118`） |
| 两套离线缓存 | 服务端队列 `ReaderScreen.tsx:1204-1216` + `domains/reader.ts:67-82`；浏览器同步 `ReaderScreen.tsx:1218-1257` + `offlineStorage.ts:498-551` |
| 缓存状态三源合成 | `useReaderCacheStatus.ts:63-112`（`Math.max` `:102`） |
| IndexedDB LRU 淘汰 | `offlineStorage.ts:384-403`（配额分支 `:126-137`） |

**规则引擎边界**
| 结论 | 证据 |
|---|---|
| 阅读路由直接持 RuleRunner | `http/ReadingRoutes.kt:53-56`, `:75, :115, :119, :187, :219` |
| HTTP 层 new JsSandbox | `http/ReadingRoutes.kt:166` |
| 规则上下文只有书名/章名 | `http/ReadingRoutes.kt:165-168` |
| 前端零 rules 依赖 | 全量 grep 无命中（`RuleRunner`/`JsSandbox`/`ruleContent`） |

**纯函数 / 死代码**
| 结论 | 证据 |
|---|---|
| 旧点击分区在产品里已死 | `interaction/readerInteractions.ts:3/10/17` 三个函数；全 `src` 仅 `ReaderScreen.tsx:2038` 注释提及 |
| 判据仍在测死代码 | `web/test/ReaderPagination.test.ts`（16 处）、`web/test/reader-interactions-settings.test.ts`（10 处） |
| 新分区模型 | `interaction/tapZones.ts:85-173`；调用 `ReaderScreen.tsx:2135, 2140` |
| 后端过时注释 | `reading/ReadingRepository.kt:107-109`（称 `paragraphAnchor` "前端还没有生成规则"，实际 `logicalPosition.ts:54` 早已产出） |

### 8.2 未确认（需运行期或超出本轮读取范围）

| # | 未确认项 | 建议验证方式 | 当前判断 |
|---|---|---|---|
| U1 | 两次并发 `PUT /reading-progress` 是否会导致进度倒退 | 断点/慢网下快速翻页后检查 `reading_progress.updated_at` 与最终 `chapter_index` | **likely 会**（无排序、无版本比较） |
| U2 | `useReaderChapterContent` 依赖 `progress.*` 四字段，父组件换 progress 对象时是否重拉整章 | 打开书 → 触发 `syncCacheStatus`（`api.bookshelf`）→ 观察 `/api/books/content` 是否二次请求 | **likely 会**（依赖数组静态可读） |
| U3 | 断网阅读时每次翻页是否要等一个失败 RTT | 断网 + 翻页，量 TTI | **likely 会**（`search.ts:101` 先请求） |
| U4 | 音频/视频源第二次进入是否真的丢 `mediaUrl`（是否被 `mediaSrc` 兜底救回） | 用 sourceType=1 的源读两遍同一章 | **likely 丢；兜底是否够用取决于 `content` 是否为裸地址** |
| U5 | `clearPreload()` 是否被调用（换书时内存窗口是否清空） | grep 调用点 | **需读 ReaderScreen 剩余 1800–2403 段**（本轮未读） |
| U6 | `persist()` 在"切书"瞬间是否会把 A 书的进度写成 B 书 | 快速连续开两本书 | 静态上看 `persist` 闭包绑 `currentBook`，**likely 安全** |
| U7 | `useReadingLog` 在 TTS 自动续章时是否重复计时 | TTS 连读两章后看 `reading_log.seconds` | **likely 不重复** |
| U8 | `book_cache_status.cachedChapters` 与 IndexedDB 集合大小不同量纲导致进度条跳变 | 只服务端缓存过的书 + 浏览器同步后对比 | **needs-runtime-test** |

### 8.3 覆盖率（诚实口径）

| 维度 | 实测 | 说明 |
|---|---|---|
| `features/reader/` 文件总数 | **72**（`find . -type f \| wc -l`） | 含 12,416 行 |
| **整篇通读**的文件 | **20 个 / 2,595 行** | 8 个 hook + 12 个纯函数模块（`logicalPosition`/`readerFlow`/`chunkedRender`/`mangaPages`/`readerProgress`/`tapZones`/`pageTurn`/`shortcuts`/`readerMenu`/`readerInteractions`/`bookmark`/`reanchor`） |
| **分块深读** | **2 个 / ~760 行** | `ReaderScreen.tsx` 读 12 个窗口约 460/2403（19%）；`readerSettings.ts` 读类型/默认/解析/存取约 300/769（39%） |
| **只看职责（文件头 8–14 行）** | **~45 个** | 全部 UI 组件、`ttsEngine`(638)、`ttsTextProcessor`(145)、`SkinModal`(437)、`BackgroundLibrary`(224) 等 |
| 前端 reader 行覆盖 | **约 3,355 / 12,416 ≈ 27%** | 但**关键路径覆盖接近 100%**：进度/内容/缓存/翻页/笔记/朗读的每一处读写落点都定位到行 |
| 前端 API 层 | `lib/api/domains/reader.ts` 478 行 **100%**；`lib/offlineStorage.ts` 551 行 **100%**；`lib/api/types.ts` 相关段 **100%** | — |
| 后端 | `ReadersRoutes.kt` 92、`ReadingRoutes.kt` 314、`ReadingRepository.kt` 116、`ReadingDao.kt` 173、`ReadingModels.kt` 268 **全读**；`Schema.kt`/`Migration.kt`/`CacheDao.kt`/`ImportDao.kt`/`ShelfDao.kt` 为**定向窗口** | 约 2,240 行 |
| 累计精读 | **约 5,600 行** | 前端 3,355 + API/后端 2,240 |

**未覆盖且影响判断的部分**：`ttsEngine.ts`(638) 的会话/resetSession 细节（只读了注释与导出）、`ReaderScreen.tsx` 1800–2403（含工具栏接线、`toggleBookmark` 之外剩余部分）、各 Modal 的交互细节。这些不影响 §4–§7 的六问结论，但会在**交互矩阵**里表现为"判据缺口"。

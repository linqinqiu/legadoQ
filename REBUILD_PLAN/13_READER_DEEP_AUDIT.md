# 13 阅读器深度审计（Phase 0.5）

> **本册由两份并行深读合并**：13a `ReaderScreen.tsx` 全文解剖 · 13b 阅读器子系统与交叉审计。
> 审计对象：`E:\legadoQ-archive\`（只读归档）。静态深读：未构建、未跑测试、未改动归档。
> 标注约定：**confirmed** / **likely** / **needs-runtime-test**（附复现步骤）。
> 覆盖率：`ReaderScreen.tsx` **2,403 / 2,403 行 = 100%**（分 6 块全文读）；`features/reader/` 共 72 文件 / 12,416 行，整篇通读 20 文件、分块深读 2 文件、其余结构级巡检；`lib/api/domains/reader.ts` 与 `lib/offlineStorage.ts` 100%；后端进度链路 5 文件全读。

---

## 0. 四句话结论

1. **真实规模比上一轮记录的更大**：`useState` **34**（其中 **6 个死状态**）、`useEffect` **27 + `useLayoutEffect` 4 = 31**、`useRef` **35**、`useMemo` 9、`useCallback` 20、自定义 hook **8 个**（不是 7 个——漏了 `useReaderTts`）。真实"可写状态位"约 **94** 个，其中约 60 个来自 8 个 hook，全部挂在同一组件的重渲染上。详见 13a §2/§3。
2. **问题不在"文件太大"，在"没有状态机"**：`persist()` 一个函数有 **11 个调用点**，进度保存靠"哪条交互顺手就调一下"；三条"重取正文"路径各写各的取消逻辑；三个进度 effect 把同一套段落库逻辑写了 3 遍。**拆成更多文件不解决这些**。
3. **进度是最脆的一环**：HTTP 层入口唯一（一个 `PUT` + 一个 DAO 函数），但**应用层有 11 + 4 + 1（死代码）条写入路径**，前端不校验当前章、后端不读客户端 `updatedAt`、失败 `catch` 静默 ⇒ **进度可倒退、可丢失、且用户完全无感**。交互矩阵里 4 行"高缺口"全在这条链上（`15`）。
4. **有真实缺陷，不是"理论风险"**：①分页/漫画模式卸载后仍会落库（1.2s 去抖窗口内退出阅读器，用已离开那章的 `currentRef` 发 PUT）；②`persist` 不校验当前章（慢网跨章后把新章位置记到旧章）；③换源无任何竞态保护（连点两次可让旧书覆盖新书）。每条都有复现步骤（13a §5）。

---

## 1. 本册使用建议

| 你要做什么 | 读哪一节 |
|---|---|
| 判断"要不要引入状态机" | 13a §2（state 全表）+ §3（effect 与互相触发链）+ 本册 §2 |
| 判断"哪些能留、哪些必须重写" | 13a §7（剩余 2,403 行按段剖析）+ 13b §3（纯函数目录价值评估） |
| 判断"进度为什么会丢" | 13b §4（端到端链路）+ 13a §5（缺陷清单） |
| 判断"哪类交互没有判据" | `15_READER_INTERACTION_MATRIX.md`（23 行，端到端覆盖 0 行） |
| 判断"前端是不是在做服务端的事" | 13b §7（交叉审计六问） |

## 2. 关键数字一览（13a/13b 实测）

| 项 | 实测 | 含义 |
|---|---:|---|
| `ReaderScreen.tsx` | 2,403 行 | 状态中枢 |
| `useState` | 34（6 个死状态） | 其中 6 个弹层开关、5 个抽屉/全屏 |
| effect（含 layout） | 31 | 上一轮只数 `useEffect`（27），漏了 4 个 `useLayoutEffect` |
| `useRef` | 35（17 个是"意图位/闸门位"） | 靠 ref 做去抖/闸门，绕开 React 数据流 |
| `useCallback` | 20 | — |
| 自定义 hook | 8（1,170 行） | **全部只被 ReaderScreen 消费** |
| `persist()` 调用点 | 11 | 进度保存无统一时机 |
| 进度写入路径（全栈） | 11（前端）+ 4（后端）+ 1（死代码） | HTTP 唯一，应用层不唯一 |
| 交互矩阵行数 | 23 | 有行为判据 10 行、**端到端 0 行**、高缺口 4 行 |
| `features/reader/` | 72 文件 / 12,416 行 | 前端最热区 |

---

# 附册 13a · ReaderScreen.tsx 全文解剖


- **被审文件**：`E:\legadoQ-archive\product\web\src\features\reader\ReaderScreen.tsx`
- **实测行数**：`wc -l` = **2,403**（与任务书一致）
- **rev**：`2aa71a7fefa1b68db873f71ff696ca19841cffd0f972c947b1799cb8eddfd137`（bytes=123367）
- **读法**：全文分 6 块读完（1–400 / 401–800 / 801–1200 / 1201–1600 / 1601–2000 / 2001–2403），**覆盖率 100%**，无跳读、无仅 grep。
- **交叉核对**：`useReaderChapterContent.ts`(136 行全读) · `ReaderOverlays.tsx`(props+dialogs 段) · `ReaderBody.tsx`(props 段) · `ReaderChrome.tsx`(props 段) · `ReaderCatalog.tsx`(props 段) · `lib/api/domains/reader.ts` · `lib/api/index.ts`(映射段) · `lib/api/domains/search.ts`(端点段)
- **标注约定**：`confirmed` = 源码直读可证；`likely` = 源码强烈暗示但需运行期确认；`needs-runtime-test` = 必须跑起来看。

### 修正上一轮的计数（任务明确要求重数）

| 项 | 上一轮记录 | **本轮源码实数** | 说明 |
|---|---|---|---|
| `useState` | 34 | **34** ✅ | 但其中 1 个无 setter（`uiV2`），另有 **6 个只写不读/完全不读的死 state**（见 §5.8） |
| `useEffect` | 27 | **27** ✅ | 另有 **4 个 `useLayoutEffect`** ⇒ **effect 总数 31**（上一轮把 layoutEffect 漏在计数外） |
| `useRef` | 未记录 | **35** | 上一轮没有这个数字 |
| `useMemo` | 未记录 | **9** | |
| `useCallback` | 未记录 | **20** | |
| 自定义 hook 调用 | 未记录 | **8** | `useReaderPageTurn` / `useReaderCacheStatus` / `useReaderChapterContent` / `useReadingLog` / `useReaderNotes` / `usePaginationMeasurement` / `useReaderTts` / `useReaderPositionJump` |

> **口径说明（重要）**：本文件的"状态量"远大于 34。8 个自定义 hook 还各持有自己的 state，被本文件**解构后当作本地变量使用**：`useReaderChapterContent` 5 个（content/mediaUrl/loadedChapterUrl/message/loading）+ `useReaderCacheStatus` 8 个 + `useReaderTts` 约 18 个 + `useReaderNotes` 约 8 个 + `usePaginationMeasurement` 约 8 个 + `useReaderPageTurn` 6 个。**本文件实际"可写状态位"≈ 34 + 60 ≈ 94**，全部挂在同一个组件的 re-render 上。

---

## 1. 组件骨架

### 1.1 Hook 调用逐条清单（带行号与实数）

**`useState` × 34**（行号:变量名）
70 `currentBook` · 85 `convert` · 96 `tocRuleOptions` · 101 `flowTail` · 107 `flowKey` · 125 `flowHead` · 130 `chapterIndex` · 134 `activeDrawer` · 136 `tapZoneEditing` · 137 `toolbarsVisible` · 139 `uiV2`(无 setter) · 147 `boundaryMessage` · 148 `remainingSeconds` · 149 `showSourceSwitch` · 150 `isFullscreen` · 160 `showReplaceRules` · 161 `offlineStatsModal` · 162 `showRefreshChapters` · 163 `localSyncing` · 164 `localSyncProgress` · 168 `pageIndex` · 435 `lightboxSrc` · 444 `imageGeneration` · 445 `failedImages` · 464 `scrubIndex` · 485 `renderLimit` · 519 `mangaIndex` · 520 `viewportWidth` · 626 `bookSearchOpen` · 628 `reviewsOpen` · 630 `searchFlash` · 633 `settingsTab` · 1376 `slowLoad` · 2102 `readingLeft`

**`useRef` × 35**
103 `pendingKeepRef` · 105 `flowAdvanceRef` · 109 `anchorSectionRef` · 111 `flowTailRef` · 126 `flowHeadRef` · 129 `pendingPrependRef` · 132 `chapterIndexRef` · 165 `localSyncAbortRef` · 187 `currentRef` · 188 `timerRef` · 189 `restoredRef` · 190 `wakeLockRef` · 191 `lastScrollYRef` · 192 `pointerStartRef` · 193 `boundaryTimerRef` · 194 `targetInitialPageRef` · 195 `initialPagePositionRef` · 197 `initialLogicalPositionRef` · 199 `pendingNoteJumpRef` · 200 `wheelTimerRef` · 202 `wheelAccumRef` · 203 `wheelIdleRef` · 205 `viewportRef` · 206 `bodyRef` · 208 `readerMainRef` · 212 `currentChapterUrlRef` · 216 `chapterBaseContentRef` · 486 `chunkSentinelRef` · 530 `mangaRef` · 533 `mangaTargetRef` · 535 `mangaRestoredRef` · 567 `logicalMetaRef` · 705 `windowChaptersRef` · 831 `changeChapterRef` · 1146 `autoNextAtRef`

**`useMemo` × 9**：479 `paragraphs` · 516 `mangaPageList` · 517 `mangaImages` · 550 `paragraphStarts` · 562 `positionChecksum` · 681 `mediaSrc` · 702 `windowChapters` · 719 `nextChapterTitle` · 1336 `recovery`

**`useCallback` × 20**：246 `handleChapterLoaded` · 354 `handleChaptersRefreshed` · 401 `handleReplaceRulesChanged` · 478 `splitBody` · 491 `revealParagraph` · 737 `readLogicalPosition` · 786 `scrollToLogicalPosition` · 816 `persist` · 868 `handleUseWebSpeech` · 882 `handleParagraphClick` · 1034 `showBoundaryNotice` · 1046 `changeChapter` · 1131 `goPrevChapter` · 1136 `goNextChapter` · 1349 `handleRecover` · 1568 `settlePrependedPage` · 1587 `goNextPage` · 1614 `prependPreviousChapter` · 1636 `goPrevPage` · 2053 `runTapAction`

**`useEffect` × 27**：86 · 151 · 320 · 422 · 489 · 495 · 521 · 537 · 605 · 810 · 1147 · 1377 · 1389 · 1668 · 1740 · 1767 · 1777 · 1795 · 1800 · 1810 · 1832 · 1853 · 1870 · 1895 · 1898 · 2011 · 2103

**`useLayoutEffect` × 4**：1425 · 1490 · 1514 · 1581（⇒ effect 总计 **31**）

**自定义 hook × 8 调用点**：180 `useReaderPageTurn` · 232 `useReaderCacheStatus` · 301 `useReaderChapterContent` · 312 `useReadingLog` · 572 `useReaderNotes` · 587 `usePaginationMeasurement` · 842 `useReaderTts` · 1102 `useReaderPositionJump`

### 1.2 非 hook 的长函数（纯函数式 handler，全在组件体内重建）
330 `reparseLocalBook` · 448 `refetchChapterImage` · 642 `toggleBookmark` · 891 `renderParagraphContent` · 934 `renderImageFailure` · 942 `renderContentBlock` · 997 `renderMangaPage` · 1019 `renderMangaContent` · 1165 `toggleShelf` · 1192 `handleCacheBook` · 1204 `handleCacheAll` · 1218 `handleSyncToLocal` · 1259 `handleCancelCache` · 1269 `handleSwitchSource` · 156 `toggleFullscreen` · 2036 `onPointerDown` · 2111 `onPointerUp` · 2152 `onBodyContextMenu` · 2211 `onWheelPaginate` · 2088 `readingRect`

### 1.3 渲染树（2240–2402）

```
<TtsContext.Provider value={ttsCtx}>                      2241
 └ <main.reader-workspace>  style={readerStyle}            2242   // 主题类/toolbars-open/drawer-open
    ├ <ReaderChrome ... actions={18 个回调} />              2243–2302
    │    └ 内部：MD3/legacy 顶栏·底栏·目录抽屉(ReaderCatalog)·设置抽屉(ReaderSettingsSheet)
    │             ·点击区域编辑器(TapZoneEditor)·抽屉遮罩
    ├ <ReaderBody ...>                                      2305–2340
    │    ├ 分页轨道 或 滚动续接（内部按 pageMode 分支，见 ReaderBody.tsx:117-120）
    │    └ {boundaryMessage && <p.reader-boundary-message>} 2339   ← 唯一直接渲染的浮层类元素
    ├ {!uiV2 && <nav.mobile-reader-nav>}                    2345–2353  // 5 键：目录/换源/朗读/设置/夜读
    └ <ReaderOverlays dialogs={12 个开关} ... />             2355–2399
         └ 内部渲染 12 个弹层（ReaderOverlays.tsx:94–236）
```

**条件渲染点（本文件内）**：`boundaryMessage`(2339) · `!uiV2`(2345) · `!isBuiltinSkinHidden(settings,'dark') && …'light'`(2350) · 12 个 `dialogs.*` 布尔在 `ReaderOverlays` 内部(94/108/119/130/140/142/154/192/199/208/219/228)。

**浮层归属统计**：仓库共 21 个单例浮层；**本文件的状态直接驱动其中 12 个**（换源 2357 / TTS 播放条 2358 / TTS 设置 2359 / 净化规则 2360 / 缓存统计 2361 / 刷新正文 2362 / 离线语音确认 2363 / 图片预览 2364 / 本书搜索 2365 / 选中标记菜单 2366 / 笔记编辑器 2367 / 段评 2368）+ **2 个抽屉状态**（`activeDrawer` 的 toc/settings，以及 `tapZoneEditing` 编辑层）+ **1 条边界提示**（2339）。**合计 15 个浮层/提示的开关都由这 2,403 行持有。**

---

## 2. 全部 State 表（核心）

### 2.1 34 个 `useState`（写入/读取行号均为源码实测）

| # | 变量名 | 类型 | 初值 | 写入位置(行) | 读取位置(行) | 用途一句话 | 归属域 | 潜在问题 |
|---|---|---|---|---|---|---|---|---|
| 1 | `currentBook` | `OpenBook` | prop `openBook` | 70(声明) 336 1313 | 210 217 234-236 262 268-270 282 303-307 313-315 321-323 331-335 363-364 395 407 420 466 518 543-545 572 618-624 655-656 680 720-721 725 821-822 828 845 948 954 1047-1060 1096-1097 1103 1137-1140 1151 1163 1169-1182 1207-1219 1229-1233 1261 1273-1296 1316 1339-1345 1400-1416 1422 1503-1511 1616-1634 1698 1712 1738 1769-1792 1837-1839 1850 2186 2234 2247-2267 2285 2300 2317 2328 2370 | 当前这本书的完整对象（details+chapters+progress）**同时充当章节表与进度源** | 章节/导航 | 换源(1313)/重切目录(336)整对象替换；progress 只在换源时手写，读中从不回写（见 §5.5） |
| 2 | `convert` | `ScriptConverter` | `IDENTITY_CONVERTER` | 85 89 91（`setConvert(()=>x)` 防惰性/updater 坑，见 78-84 注释） | 426 432 478 848 2158 2265 2327 | 简繁转换函数，全屏所有文字都过它 | 设置 | 异步加载，词表未到位时首屏是原文再突变；`positionChecksum` 故意不含转换后正文(562-565) |
| 3 | `tocRuleOptions` | `TocRuleOption[]` | `[]` | 96 322 | 96 321 323 2269 | 本地书可选目录规则清单 | 设置(本地书) | effect 依赖 `tocRuleOptions.length`(323)：取回空表会**每轮重取**（服务端返空即无限重试）—— `likely` |
| 4 | `flowTail` | `{chapter,content}[]` | `[]` | 101 374 1093 1322 1392 1419 | 101 112(ref) 475(注释) 703-704 730 1534 2318 | 续接在锚点**后面**的 1–2 章正文 | 分页/章节 | 6 个写入点；1392 媒体章直接清空 |
| 5 | `flowKey` | `string` | 首章 url ‖ bookUrl (107) | 107 1096 1324 | 2308 | 容器 key：只有主动跳章/换源才换，续接推进不动它 | 章节 | 换 key = 整子树重挂 + 重放入场动画，误触发即白闪 |
| 6 | `flowHead` | `{chapter,content}[]` | `[]` | 125 376 1094 1323 1510 1632 | 125 127(ref) 703-704 730 1533 2318 | 接在锚点**前面**的章（往回翻对称方案） | 分页/章节 | 1510 在分页顶窗口时清空；与 `pendingPrependRef` 强耦合（1572 判首节） |
| 7 | `chapterIndex` | `number` | `startIndex`(prop) | 130 337 1085 1314 1506 1703 | 132(ref) 133 197 199 210 273 316 465 572 619 630 658 720 725 786-790 844 891 900 988 1047-1060 1097 1104 1128-1140 1151 1159 1163 1219 1307 1358 1364 1400-1422 1591-1604 1640 1665 1712 1769-1792 1937-1954 2008 2061 2070 2080 2187 2250 2317 2328 2332 2370 | **当前锚点章索引**，全书状态的真中心 | 章节/导航 | 6 个写入点；无"正在切章"标记，只靠 `loading`+`loadedChapterUrl` 间接表达 |
| 8 | `activeDrawer` | `'toc'\|'settings'\|'other'\|null` | `null` | 134 1086 1109 1932 1985 1989 2075 2118 2207 2272 2273 2277 2281 2282 2284 2289 2346 2349 | 134 1931 2008 2041 2117 2153 2212 2242 2245 | 抽屉开关（目录/设置/其它） | 弹层 | **18 个写入点**；`'other'` 分支无写入者（只有类型允许）—— 半死枚举 |
| 9 | `tapZoneEditing` | `boolean` | `false` | 136 2289 2290 | 136 2104 2109 2259 | 「在正文上编辑点击区域」层 | 弹层/设置 | 2104 effect 只在开时量 `readingLeft` |
| 10 | `toolbarsVisible` | `boolean` | `false` | 137 1680 1682 2079 | 137 2242 | 外壳工具栏显隐 | 导航 | scroll 监听里按位移自动收放(1679-1683)；分页模式只能靠点击切换(2079) |
| 11 | `uiV2` | `boolean` | `?ui=legacy/md3` 优先，否则 `localStorage['reader-ui-v2']!=='0'` (139-146) | 139（**无 setter**） | 139 2244 2307 2345 | MD3 外壳 vs legacy 的**一次性**开关 | 设置 | 用 state 存常量，可 `useMemo`/模块级常量；localStorage 直读在渲染期（try/catch 包住，144） |
| 12 | `boundaryMessage` | `string` | `''` | 147 1034 1038 | 147 2339 | "已是第一章/最后一章"提示条 | 错误/导航 | 1400ms 定时自动清(1036-1039)；卸载清理在 1895 |
| 13 | `remainingSeconds` | `number\|null` | `null` | 148 1812 1816 1818 | 148 2371 | 睡眠定时倒计时秒数 | TTS | 声明在阅读器、语义属 TTS（见 §5.8） |
| 14 | `showSourceSwitch` | `boolean` | `false` | 149 1351 2284 2347 2373 | 149 2357 | 换源弹窗 | 弹层 | 1351 无备选时兜底打开 |
| 15 | `isFullscreen` | `boolean` | `false` | 150 152 | 150 2252 | 全屏状态镜像 | 导航 | 只由 `fullscreenchange` 事件同步(151-155)，覆盖 `toggleFullscreen`(156) 两侧 |
| 16 | `showReplaceRules` | `boolean` | `false` | 160 2288 2379 | 160 2360 | 净化规则弹窗 | 弹层 | 关闭后 `handleReplaceRulesChanged`(401) 重取当前章 |
| 17 | `offlineStatsModal` | `boolean` | `false` | 161 2380 | 161 2361 | 离线缓存统计弹窗 | 弹层 | 关闭时顺手 `syncCacheStatus()`(2380) |
| 18 | `showRefreshChapters` | `boolean` | `false` | 162 2285 2381 | 162 2362 | 刷新正文章节弹窗 | 弹层 | 本地书不给入口(2285) |
| 19 | `localSyncing` | `boolean` | `false` | 163 1224 1254 | **无读取** | 本机离线同步进行中 | 弹层/缓存 | **死 state**：唯一使用者 `handleSyncToLocal`(1218) 本身无调用者 |
| 20 | `localSyncProgress` | `{current,total}` | `{0,0}` | 164 1225 1236 | **无读取** | 本机同步进度 | 缓存 | **死 state**（同上） |
| 21 | `pageIndex` | `number` | `0` | 168 184(hook) 594(hook) 1123(hook) 1578 1599 1647 1890 | 168 183 715 1497-1511 1595 1604 1644 1665 1744-1745 1761 1769-1770 2312 | 当前页码（相对当前窗口） | 分页 | **8 个写入点，其中 4 个来自 hook/测量**；跨章时不清零，靠 `targetInitialPageRef`+测量纠正(1071-1077) |
| 22 | `lightboxSrc` | `string\|null` | `null` | 435 967 1010 2385 | 435 2364 | 正文配图点击放大 | 弹层/图片 | 切章不重置（图还在看，可接受）；Esc/Ctrl 关闭统一走 `useEscapeClose`(ReaderOverlays:90) |
| 23 | `imageGeneration` | `Record<string,number>` | `{}` | 444 451 | 444 543 545 948 1001 | 每张图重取次数（改浏览器缓存键） | 图片 | **按原图 URL 增长、永不清洗**（跨章跨书累积）—— `likely` 内存增长 |
| 24 | `failedImages` | `Record<string,string>` | `{}` | 445 452 459 975 1013 | 445 936 949 1002 | 哪张图失败 + 原因 | 图片/错误 | 同上，键集只增不减；换书后旧失败态仍在 |
| 25 | `scrubIndex` | `number\|null` | `null` | 464 2331 2332 | 464 465 2324 2332 | 拖进度条时的临时章索引 | 导航 | 只在 `onScrubCommit` 清(2332)；`changeChapter` 不重置它 |
| 26 | `renderLimit` | `number` | `CHUNK_SIZE` | 485 489 492 500 2330 | 485 487 496 504 1119 1450 1873 1893 2323 | 超大章节分块渲染上限 | 章节/渲染 | 换 content/章即重置(489)；`IntersectionObserver` 兜底按钮(2330) |
| 27 | `mangaIndex` | `number` | `0` | 519 607 616 617 620 623 1592 1641 1907 | 519 528 1590 1604 1639 1665 | 漫画当前屏首图索引 | 漫画 | 换章落点 effect(605) 用 `mangaRestoredRef` 做一次性闸 |
| 28 | `viewportWidth` | `number` | `window.innerWidth` | 520 522 | 520 526 | 视口宽（决定双页对开） | 漫画 | 只服务 `mangaSpreadSize`(526)；`resize` 无节流(521-525) |
| 29 | `bookSearchOpen` | `boolean` | `false` | 626 1110 2276 2387 | 626 2365 | 本书正文检索弹窗 | 弹层 | 1110 由 `useReaderPositionJump` 关闭 |
| 30 | `reviewsOpen` | `boolean` | `false` | 628 2203 2391 2393 | 628 2368 | 段评浮层 | 弹层 | 只读详情层 |
| 31 | `searchFlash` | `{chapterIndex,offset,term}\|null` | `null` | 630 812 1111 | 630 811 814 900-905 | 刚跳来的搜索命中高亮 | 笔记/搜索 | 6s 自动清(810-814)；渲染处再校 `ownerIndex===chapterIndex`(900) |
| 32 | `settingsTab` | `'reader'\|'other'` | `'reader'` | 633（**无 setter 调用**） | **无读取** | 设置弹层顶层标签页 | 设置 | **完全死 state**：声明后既没写也没读，标签页状态实际在 `ReaderSettingsSheet` 内部 |
| 33 | `slowLoad` | `boolean` | `false` | 1376 1378 1379 | 1376 2322 | "等了 8 秒还没出来" | 错误 | 只在 `loading && !content && !message` 时计时(1378)；`message` 存在即判非卡住 |
| 34 | `readingLeft` | `number` | `0` | 2102 2105 | 2102 2260 | 正文区左缘（点击区域编辑层定位） | 弹层/设置 | 仅 `tapZoneEditing` 期间量(2103-2109)，**本该局部** |

### 2.2 35 个 `useRef`

| # | 变量名 | 类型 | 初值 | 写入位置(行) | 读取位置(行) | 用途一句话 | 归属域 | 潜在问题 |
|---|---|---|---|---|---|---|---|---|
| R1 | `pendingKeepRef` | `number\|null` | null | 103 1090 1320 1430-1432 1700 | 1430 | 摘掉顶部章后新锚点该停的滚动位 | 分页/滚动 | 靠 1425 layoutEffect 消费，写而不消费会永久留值 |
| R2 | `flowAdvanceRef` | `boolean` | false | 105 266 1089 1319 1701 | 265 | "这一帧是续接推进、不许 scrollTo" | 章节 | 105/265-266 一次性标记，配 `handleChapterLoaded`(267) |
| R3 | `anchorSectionRef` | `HTMLElement\|null` | null | 109 | 109 1877 1910 2309 | 锚点章的 DOM 节（TTS 跟读限定范围） | TTS/正文 | 由 `ReaderBody` 的 refs 注入 |
| R4 | `flowTailRef` | `{chapter,content}[]` | [] | 111 112 | 373 1153 1696 | 长闭包里读 flowTail | 章节 | 与 state 同帧同步(112) |
| R5 | `flowHeadRef` | 同上 | [] | 126 127 | 375 1510 1617 1654 | 长闭包里读 flowHead | 章节 | 同上 |
| R6 | `pendingPrependRef` | `string\|null` | null | 129 1095 1321 1577 1631 1661 | 1569 1651 1654 1582 | "刚接到前面的是哪一章、还没结账" | 分页 | **卡死风险**：1651 分支若无 `measurePagination` 命中会一直不清（有 1654 兜底）—— `needs-runtime-test` |
| R7 | `chapterIndexRef` | `number` | chapterIndex | 132 133 | 1504 1699 1712 | 长闭包里读当前章号 | 章节 | 与 state 同帧同步 |
| R8 | `localSyncAbortRef` | `AbortController\|null` | null | 165 1220 1222 | 1220 | 本机同步取消句柄 | 缓存 | **死 ref**（唯一使用者 1218 无调用者） |
| R9 | `currentRef` | `{chapter,position}\|null` | null | 187 280 | 697 817 1675 1746 1780 | **进度真源**：屏幕上是哪一章 + 读到哪 | 进度 | 只在 `handleChapterLoaded`(280) 与三个进度 effect 写；**与 chapterIndex 无同步保证**（§5.5） |
| R10 | `timerRef` | `number\|null` | null | 188 1719-1720 1735 1755-1756 1787-1788 | 1718 1754 1786 | 1200ms 进度保存去抖 | 进度 | **只有滚动 effect 的 cleanup 清它**(1735)；分页/漫画模式下卸载**无人清**（§5.4） |
| R11 | `restoredRef` | `boolean` | false | 189 279 | 268 270 | 首屏恢复只做一次 | 进度 | 换源/重切后**不复位**(1313-1325 未重置) ⇒ 新书不再走逻辑位恢复 |
| R12 | `wakeLockRef` | `WakeLockSentinel\|null` | null | 190 1857 1861 1865 | 1860 1864 | 屏幕常亮句柄 | TTS | 依赖 `ttsActive && playing`(1855) |
| R13 | `lastScrollYRef` | `number` | 0 | 191 803 1436 1476 1684 | 1678 | 上次滚动位（判收放工具栏 + delta） | 导航 | 程序化 scrollTo 后手动同步(803/1436/1476) |
| R14 | `pointerStartRef` | `{x,y,target,hadSelection}\|null` | null | 192 2046 2113 | 2112-2115 | 指针落点手势起点 | 导航 | `hadSelection` 必须在按下那刻抓(2042-2046) |
| R15 | `boundaryTimerRef` | `number\|null` | null | 193 1036-1037 | 1035 | 边界提示定时器 | 错误 | 卸载清理 1895 ✅ |
| R16 | `targetInitialPageRef` | `'first'\|'last'\|null` | null | 194 595(hook) 1075 1458 | 1441 | 换章后首屏落点意图 | 分页 | 由 `changeChapter`(1075) 设、layoutEffect(1458) 消费；**hook 也能写**(595) |
| R17 | `initialPagePositionRef` | `number\|null` | null | 195 281 596(hook) 1459 | 1442 | 首屏恢复的 fraction | 进度 | 同上，双写者 |
| R18 | `initialLogicalPositionRef` | `LogicalPosition&{chapterIndex}\|null` | null | 197 270 597(hook) 1451 1460 | 1443 | 首屏恢复的语义位置（优先于 fraction） | 进度 | 三写者（270/1451/460），语义位置校验失败才退 fraction |
| R19 | `pendingNoteJumpRef` | 同上 | null | 199 1453 | 1113 | 跨章跳笔记的待落点 | 笔记 | 传给 `useReaderPositionJump`(1113) |
| R20 | `wheelTimerRef` | `number\|null` | null | 200 2229 | 2226 | 滚轮翻页 140ms 冷却 | 分页 | 只在 handler 内自清(2229) |
| R21 | `wheelAccumRef` | `number` | 0 | 202 2218 2220 2228 | 2213 | 滚轮增量累计（像素） | 分页 | 500ms 空闲清零(2220) |
| R22 | `wheelIdleRef` | `number\|null` | null | 203 2219-2220 2227 | 2219 2227 | 上面那个空闲定时器 | 分页 | 卸载不清（低危，仅清 ref 值） |
| R23 | `viewportRef` | `HTMLDivElement\|null` | null | 205 | 588 762 851 1518 2309 | 分页视口元素 | 分页 | 注入 `usePaginationMeasurement`(588) |
| R24 | `bodyRef` | `HTMLDivElement\|null` | null | 206 | 589 755 1121 1884 2309 | 分页正文轨元素 | 分页 | 注入测量 hook 与跳转 hook |
| R25 | `readerMainRef` | `HTMLElement\|null` | null | 208 | 2089 2105 2309 | 正文区容器（点击分区基准） | 导航 | 按它算矩形而非整窗(2088-2097) |
| R26 | `currentChapterUrlRef` | `string` | `''` | 212 213 | 377 381 409 414 418 | **过期响应闸门** | 错误/竞态 | 全文件仅 3 处用它挡旧响应(381/409/418)；其余异步回调**没有** |
| R27 | `chapterBaseContentRef` | `string` | `''` | 216 247 383 | 247 383 | 本章原始正文（AI 覆盖前那版） | 章节/笔记 | 只在正常加载与刷新时写；`setContent` 直改不污染（214-215 注释） |
| R28 | `chunkSentinelRef` | `HTMLDivElement\|null` | null | 486 | 497 2309 | 分块补块的哨兵节点 | 渲染 | IntersectionObserver 目标(499-503) |
| R29 | `mangaRef` | `{start,pages}` | `{0,[]}` | 530 531 | 746 | 长闭包里读漫画当前屏 | 漫画 | 与 state 同帧同步(531) |
| R30 | `mangaTargetRef` | `'first'\|'last'\|null` | null | 533 615 1079 | 614 | 漫画换章落点意图 | 漫画 | 由 `changeChapter`(1079) 设、effect(605-615) 消费 |
| R31 | `mangaRestoredRef` | `string` | `''` | 535 608 613 | 612 | 已按存档恢复过的章 URL（去重） | 漫画 | 清空仅在退出漫画模式(608) |
| R32 | `logicalMetaRef` | `{starts,checksum}` | 当前值 | 567 568 | 598 738 787 1122 1448-1449 | 长闭包里读段起点与校验值 | 进度 | 与两个 useMemo 同帧同步(568) |
| R33 | `windowChaptersRef` | `Chapter[]` | windowChapters | 705 706 | 1501 1572-1573 | 长闭包里读窗口章节表 | 分页 | 顺序必须与 DOM `.reader-page-chapter` 一致(699-701) |
| R34 | `changeChapterRef` | `(i:number)=>void` | 空函数 | 831 1099 | 855 | 打破 TTS↔changeChapter 循环依赖 | TTS/章节 | 每次渲染重赋值(1099) |
| R35 | `autoNextAtRef` | `number` | 0 | 1146 1158 | 1157 | 滚到底翻章 1.2s 冷却 | 章节 | handler 内自读自写 |

### 2.3 从 hook 解构来的状态（本文件不持有但可写，直接受父组件 re-render 影响）
`content/setContent`(285-286) · `mediaUrl/setMediaUrl`(287-288, 写 384) · `loadedChapterUrl/setLoadedChapterUrl`(289-290, 写 404/411) · `message/setMessage`(291-292, 写 415/2003) · `loading/setLoading`(293-294, 写 406/1084/2002) ＋ `preloadedContentRef/preloadingRef/preloadNextChapter/preloadPrevChapter/reload`(295-300；其中 **`clearPreload` 与 `preloadingRef` 在本文件解构后从未使用** —— 死解构 296/299)。
`cacheStatus/setCacheStatus`(221-222, 写 1212/1262) · `cachedChapterUrls/setCachedChapterUrls`(223-224) · `chapterWordCounts/setChapterWordCounts`(225-226) · `inShelf/setInShelf`(227-228) · `shelfTocRule/setShelfTocRule`(229-230) · `syncCacheStatus`(231)。
`ttsActive/setTtsActive` · `ttsPlayState/setTtsPlayState` · `currentChunkIndex` · `sleepTimer/setSleepTimer` · `showTtsSettings/setShowTtsSettings` · `offlineTtsConfirmOpen/setOfflineTtsConfirmOpen` · `ttsParagraphs` · `ttsData` · `currentChunk` · `activeParagraphIndex` · `activeSentenceText`（857-865）。
`notesApi.*`（572 返回值，含 `notes/setNotes/noteDraft/noteEditorOpen/notesPanel/…`，全文件 40+ 处引用）。
`pageCount/pageFillers/columnWidth/stride/isDoubleColumn/measurePagination/pageSpansRef/measuredStartsRef/columnsPerPageRef/pageAlignedRef/pendingPageRef`（575-586）。
`pageAnim/fading/slideAnimOn/coverTurn/setCoverTurn/coverEntered/onCoverTransitionEnd`（172-185）。

---

## 3. 全部 Effect 表（核心）

> **实数：`useEffect` 27 + `useLayoutEffect` 4 = 31**。下表逐条。

### 3.1 `useEffect`（27）

| # | 行号 | 依赖数组 | 触发条件 | 做了什么（含 API） | 清理函数 | 写的 state | 潜在问题 |
|---|---|---|---|---|---|---|---|
| E1 | 86–93 | `[settings.scriptMode]` | 简繁档位变化 | `loadScriptConverter()` 动态载词表(88) | `alive=false`(92) ✅ | `convert` | 无兜底超时；失败静默退回原文(91) |
| E2 | 151–155 | `[]` | 挂载 | 监听 `fullscreenchange` → `setIsFullscreen` | 移除监听 ✅ | `isFullscreen` | 只用事件镜像，F11 之外的手势也覆盖 |
| E3 | 320–323 | `[currentBook.details.sourceId, tocRuleOptions.length]` | 本地书且清单为空 | `api.tocRules()`(`/api/books/toc-rules`, reader.ts:269) | 无 | `tocRuleOptions` | **服务端返空表 → length 仍为 0 → 每轮重取**（`likely` 请求风暴） |
| E4 | 422–432 | `[bookName, chapter?.title, convert]` | 书/章/转换器变 | 写 `document.title`(428) | 还原品牌名(429-431) ✅ | 无（DOM 副作用） | 卸载时还原成品牌名，若上层自己有标题策略会被覆盖 |
| E5 | 489 | `[content, chapter?.index]` | 正文或章变 | `setRenderLimit(CHUNK_SIZE)` | 无 | `renderLimit` | 与 E17(1873 `revealParagraph`) 抢写：刚补的块可能被归零（同帧竞态）—— `needs-runtime-test` |
| E6 | 495–504 | `[chunked, renderLimit, paragraphs.length]` | 分块且未挂完 | `IntersectionObserver`(499-503)，`rootMargin:'800px'` | `disconnect()` ✅ | `renderLimit` | 每次 `renderLimit` 变都重建 observer（翻一块建一个） |
| E7 | 521–525 | `[]` | 挂载 | `resize` → `setViewportWidth` | 移除 ✅ | `viewportWidth` | 无节流：拖动窗口期每 px 一次 render |
| E8 | 537–545 | `[isMangaMode, mangaStart, mangaSpread, mangaImages, chapter?.url, imageGeneration, currentBook.details.sourceId]` | 漫画换屏 | `new Image().src=readerImageSrc(...)` 预取下一屏(539-544) | 无 | 无 state（图片缓存副作用） | 无取消；`mangaImages` 数组身份变即重跑 |
| E9 | 605–624 | `[chapter?.url, chapter?.index, isMangaMode, mangaImages.length, mangaPageList, paragraphStarts, currentBook.progress]` | 漫画模式换章 | 落点：`last`→末屏 / `first`→首屏 / 存档 `charOffset`→`mangaIndexAtOffset`(620) | 无 | `mangaIndex`、`mangaRestoredRef` | 依赖 `currentBook.progress` **对象**：progress 一变就重跑，靠 `mangaRestoredRef`(612) 去重 |
| E10 | 810–814 | `[searchFlash]` | 有搜索命中高亮 | `setTimeout(6000)` 自动清除 | `clearTimeout` ✅ | `searchFlash` | 无 |
| E11 | 1147–1163 | `[changeChapter, chapterIndex, content, currentBook.chapters.length, loading, settings.pageMode]` | 滚动模式 + 滚到底再向下滚 | `changeChapter(i+1,'first')`(1159)，1.2s 冷却(1156-1158) | 移除 wheel ✅ | `chapterIndex` 等（经 changeChapter） | 判据含 `flowTailRef.length>0` 早退(1153)；`changeChapter` 身份变就重挂监听 |
| E12 | 1377–1381 | `[loading, content, message]` | 真在等（无正文无错） | `setTimeout(8000)` → `setSlowLoad(true)` | `clearTimeout` ✅ | `slowLoad` | 首屏冷启动必弹；无取消按钮联动（靠 ReaderBody 的 `onExit`） |
| E13 | 1389–1422 | `[settings.pageMode, chapterIndex, chapter?.url, content, loadedChapterUrl, currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId]` | 锚点正文就位 | 组装后 1–2 章 → 命中 `preloadedContentRef` 直接用，否则 **`api.content` 逐章拉**(1412) → `warmContentImages`(1416) | `cancelled=true`(1421) ✅ | `flowTail`、`preloadedContentRef` | ①不查 `preloadingRef`（与 hook 的 `preload` 并发 ⇒ 同章重复请求，§5.2）②某章失败即 `break`(1413) → 窗口只填一半 ③`loadedChapterUrl!==chapter.url` 时 `return`(1396) 保留旧窗口（有意） |
| E14 | 1668–1738 | `[persist, preloadNextChapter, preloadPrevChapter, settings.pageMode, currentBook.chapters]` | 滚动模式 | `scroll`(raf 去抖) + `visibilitychange`；算 `sectionProgress`(1693)/`flowAdvance`(1695) → 可能跨章(1697-1705)；`reportProgress`(1712)；0.7/0.3 预载(1713-1717)；1200ms 去抖 `persist`(1718-1723) | 移除两个监听 + `cancelAnimationFrame` + `clearTimeout(timerRef)` + **`persist()`**(1731-1737) ✅ | `toolbarsVisible`、`currentRef.current.position`、`pendingKeepRef`、`flowAdvanceRef`、`chapterIndex`；经 `persist` 落库 | **cleanup 里 `persist()` 会在切 `pageMode`/`chapters` 变化时也触发一次**（不是只在卸载）；`currentBook.chapters` 在依赖里 ⇒ 任何新 chapters 数组都重挂监听 |
| E15 | 1740–1761 | `[chapter, pageCount, pageIndex, persist, preloadNextChapter, preloadPrevChapter, settings.pageMode, isMangaMode]` | 分页模式翻页 | 算 `pageProgress`(1744) 写 `currentRef.position`(1748)；预载；1200ms 去抖 `persist`(1754-1759) | **无** | `currentRef.current.position`、`timerRef`；经 `persist` 落库 | **无 cleanup ⇒ 卸载后 1200ms 仍会 `api.saveProgress`**（§5.4）；与 E14 共用 `timerRef` 而只有 E14 清它 |
| E16 | 1767–1770 | `[chapterIndex, pageIndex, pageCount, settings.pageMode, isMangaMode, currentBook.chapters.length]` | 分页翻页 | `reportProgress(...)`(1769) | 无 | 外部 store（进度条） | 与 E15 几乎同依赖，重复上报（一处给底栏、一处给持久化） |
| E17 | 1777–1792 | `[isMangaMode, chapter, chapterIndex, mangaStart, mangaImages.length, currentBook.chapters.length, persist, preloadNextChapter, preloadPrevChapter]` | 漫画翻屏 | `mangaFraction`→`currentRef.position`(1782)、`reportProgress`(1783)、预载、去抖 `persist`(1786-1791) | **无** | `currentRef.position`、`timerRef` | 同 E15：卸载后定时器无人清 |
| E18 | 1795–1797 | `[stopAllEngines]` | 仅卸载 | `stopAllEngines()`(1796) | 自身即 cleanup ✅ | 引擎内部状态 | 依赖 `stopAllEngines` 身份：若 hook 每次给新函数，会**每帧 stop**（`likely`）—— `needs-runtime-test` |
| E19 | 1800–1807 | `[content, loading, loadedChapterUrl, chapter?.url]` | 跨章自动续播标记 | `setTtsActive(true)` + `playTtsChunkRef.current(0,'continue')`(1804-1805) | 无 | `ttsActive` | 标志位 `autoPlayNextChapterRef` 先清后用(1803)；若正则加载抖动可重复触发 |
| E20 | 1810–1829 | `[sleepTimer, stopTts]` | 睡眠定时档位变 | `setInterval(1s)` 递减；归零时 `toast.info`+`stopTts()`(1821-1823) | `clearInterval` ✅ | `remainingSeconds`；经 `stopTts` 改 tts 状态 | 归零后 `setSleepTimer` 未复位（停在 `'0'` 档），下次进 TTS 设置要手动改 |
| E21 | 1832–1850 | `[ttsActive, ttsPlayState, chapter?.title, bookName, currentBook.details.author, currentBook.details.coverUrl, resumeTts, pauseTts, handlePrevChunk, handleNextChunk]` | 朗读开启 | 设 `mediaSession.metadata/playbackState` + 4 个 `setActionHandler` | **无** | 浏览器 MediaSession | 处理器每次重设但不注销；`chapter?.title` 变即整块重跑 |
| E22 | 1853–1867 | `[ttsActive, ttsPlayState]` | 播放态变化 | `wakeLock.request('screen')` / `release()` | ✅：`release()` | `wakeLockRef` | 请求失败静默(1858)；visibility 切回不复申请（`likely` 长朗读熄屏） |
| E23 | 1870–1893 | `[activeParagraphIndex, ttsActive, settings.pageMode, stride, pageCount, chunked, renderLimit, revealParagraph]` | 朗读跟读到新段 | 分块未挂出→`revealParagraph`(1873)；滚动→`scrollIntoView`(1879)；分页→按矩形差算页 `setPageIndex`(1884-1890) | 无 | `renderLimit`（经 reveal）、`pageIndex` | **与 E5 抢写 `renderLimit`**；`setPageIndex` 再触发 E15/E16 → 又 persist（跟读会持续写进度） |
| E24 | 1895 | `[]` | 仅卸载 | 清 `boundaryTimerRef` | 自身 ✅ | 无 | 只清这一个定时器；`timerRef`/`wheelTimerRef`/`wheelIdleRef` 不在内（§5.4） |
| E25 | 1898–2008 | `[activeDrawer, changeChapter, chapterIndex, goNextPage, goPrevPage, onSettingsChange, settings, toggleTts, isMangaMode, mangaImages.length]` | 键按下 | `shortcutFor(READER_SHORTCUTS)` → 17 个 case(1929-1999)；异常兜底 `setLoading(false)`+`setMessage`(2000-2004) | 移除 keydown ✅ | `activeDrawer`、`pageIndex`、`chapterIndex`、`mangaIndex`、`remainingSeconds`…（经各分支） | 依赖含整个 `settings` 对象 ⇒ **每次改设置都重挂 keydown**；`chapterIndex` 亦在依赖 |
| E26 | 2011–2020 | `[settings, onSettingsChange]` | Ctrl/⌘+滚轮 | `stepFontSize` → `onSettingsChange` | 移除 wheel(passive:false) ✅ | 上级 settings（非本地 state） | 与 E11 同挂 `wheel`：事件序不确定（`passive:true` vs `false`）—— `likely` |
| E27 | 2103–2109 | `[tapZoneEditing]` | 进入点击区域编辑 | 量 `readerMainRef.left` → `setReadingLeft` | 移除 resize ✅ | `readingLeft` | 只在开时量；进编辑层前后版面变化不重量 |

### 3.2 `useLayoutEffect`（4）

| # | 行号 | 依赖数组 | 触发条件 | 做了什么 | 清理函数 | 写的 state | 潜在问题 |
|---|---|---|---|---|---|---|---|
| L1 | 1425–1483 | `[content, loading, positionChecksum, scrollToLogicalPosition, settings.pageMode]` | 滚动模式正文就位 | ①`pendingKeepRef` 分支：`holdScroll` + `window.scrollTo`(1435-1437) ②分块章的逻辑位还没挂出→`revealParagraph`(1454) ③否则清三个 ref(1458-1460) 后 `scrollToLogicalPosition`/fraction/首末期落点，再 rAF 复查(1481-1482) | 只在 `scrollToTarget` 路径返回 `cancelAnimationFrame`(1482) —— 1439 分支返回 `undefined` | refs（`pendingKeepRef`/`targetInitialPageRef`/`initialPagePositionRef`/`initialLogicalPositionRef`/`pendingNoteJumpRef`/`lastScrollYRef`）、`window.scrollTo`、经 `revealParagraph` 写 `renderLimit` | ①`positionChecksum` 依赖在简繁切换后变化 ⇒ 重跑一次落位（可能把用户滚过的位置拉回）②清理函数**返回值不一致**（一处函数一处 undefined）③1451 把逻辑位转存 `pendingNoteJumpRef` 借道跳笔记通道 |
| L2 | 1490–1511 | `[pageIndex, settings.pageMode, currentBook.chapters]` | 分页翻到窗口边界 | `pageWindowShift`(1497) → `pendingPageRef`(1505) + `setChapterIndex`(1506) + 清 `flowHead`(1510) | 无 | `pendingPageRef`、`chapterIndex`、`flowHead` | 三重门槛 `pendingPageRef===null`(1491)/`pageAlignedRef`(1496)/`targetIndex<=chapterIndexRef`(1504)，任一不满足即不挪（沉默失败，只能靠继续翻页自愈） |
| L3 | 1514–1548 | `[settings.pageMode, content, loading, flowHead, flowTail, pageFillers, settings.fontSize, lineHeight, letterSpacing, paragraphSpacing, textIndent, contentPadding, maxWidth, columnMode, font, measurePagination]` | 分页模式内容/排版变 | `measurePagination()`(1517) + 挂 `ResizeObserver(measurePagination)`(1523-1525) | `disconnect()` ✅ | 经 hook 写 `pageCount`/`pageFillers`/`pageIndex` 等 | **16 项依赖**，含 `measurePagination`（hook 的 useCallback 身份）：若它不稳定 → 每帧重量 → `setPageCount` → 再跑（§5.7 的循环嫌疑）`needs-runtime-test` |
| L4 | 1581–1585 | `[content, loading, measurePagination, pageFillers, settings.pageMode, settlePrependedPage, windowChapters]` | 有"刚接到前面的章"未结账 | `measurePagination()`(1583) + `settlePrependedPage()`(1584) → `setPageIndex(prependLandingPage(...))`(1578) | 无 | `pageIndex`（经 settle）、`pendingPrependRef` | 与 L3 相邻、依赖重叠 ⇒ 接章那一帧**连量两次**；`settlePrependedPage` 判据苛刻(1570-1576)，不满足会留 `pendingPrependRef` 卡住往回翻 |

### 3.3 effect 互相触发的真实链条（至少 3 条，全部带行号）

**链条 A — 主动切章主轴（最长的一条）**
`changeChapter(1046)` → `setLoading(true)(1084)` + `setChapterIndex(1085)` + `setFlowTail([])(1093)` → `useReaderChapterContent` 的 `useLayoutEffect`(useReaderChapterContent.ts:88) 看到 `chapter` 变 → `setLoading(true)`(:90) → 命中预载 `apply`(:100-102) 或 `api.content`(:104) → `apply`(:92-99) `setContent` → `onLoadedRef.current` = `handleChapterLoaded(246)` → `setChapterWordCounts(251)` + `setCachedChapterUrls(259)` + `currentRef.current=…(280)` + `initialLogicalPositionRef(270)` → 于是 **E5(489)** 把 `renderLimit` 归零、**E13(1389)** 去拉后面 1–2 章 → `setFlowTail(1419)` → **L3(1514)** 重量 → hook `setPageCount/pageFillers` → **L2(1490)** 分页时按 `pageWindowShift` 再 `setChapterIndex(1506)`（跨章翻页）→ **E15(1740)** 算 `pageProgress` → 1200ms 后 `persist(816)` → `api.saveProgress(820)`。

**链条 B — 滚动模式"顶窗口"（跨章不跳转）**
`scroll`(监听 1729) → `onScroll(1671)` rAF → `sectionProgress(1693)` 写 `current.position` → `flowAdvance(1695)` 判定跨节 → `pendingKeepRef.current=keepTop(1700)` + `flowAdvanceRef.current=true(1701)` + `persist()(1702)` + `setChapterIndex(1703)` → hook 重载正文 → `handleChapterLoaded` 里 `advancing=true` ⇒ `position=null`(267) ⇒ 不 scrollTo → **L1(1425)** 走 `pendingKeepRef` 分支(1430-1439) → `holdScroll` + `window.scrollTo` 校正 → 同时 **E13(1389)** 重算 tail 窗口。

**链条 C — 分页"往回翻接一章"（三步接力）**
`goPrevPage(1636)` → `planPrevPage(1644)` 返回 `prepend` → `prependPreviousChapter(1614)` → `api.content(1626)` → `pendingPrependRef=url(1631)` + `setFlowHead(1632)` → **L3(1514)** 因 `flowHead` 在依赖里而重量 → 新 `pageFillers` 渲染 → **L4(1581)** 再量 + `settlePrependedPage(1568)` → `setPageIndex(prependLandingPage(starts[1], columnsPerPage))(1578)` → 页码整体后移，`pendingPrependRef=null(1577)` → 若又翻到窗口首，**L2(1490)** `pageWindowShift` 接管。

**链条 D — TTS 跟读的自我反馈（写状态 → 触发测量 → 再写状态）**
hook 里 `activeParagraphIndex` 变 → **E23(1870)** → 分块未挂出则 `revealParagraph(1873)` → `setRenderLimit(492)` → **E6(495)** 因 `renderLimit` 变而重建 observer → 下一帧再滚；已挂出则分页分支 `setPageIndex(1890)` → **E15(1740)** + **E16(1767)** 双跑 → 去抖 `persist` → `api.saveProgress`。**即"朗读跟读会持续产生进度写入"。**

**链条 E — 设置改动 → 全量重量 → 再落库**
`E26(2011)` Ctrl+滚轮 或 `E25` 的 `bumpFontSize(1919)` → `onSettingsChange` → 父级 `settings` 新对象 → **L3(1514)**（字号/行距/字距/段距/缩进/边距/最大宽/分栏/字体 9 项都在依赖里）→ `measurePagination` → `setPageCount`（可能变）→ **E15(1740)** → 去抖 `persist`。**改一次字号 = 一次全量重排 + 一次进度写入。**

**链条 F — 睡眠定时收尾**
`setSleepTimer`（经 `TtsSettingsModal` 2376）→ **E20(1810)** `setInterval` → `setRemainingSeconds` 每秒一次 render → 归零 `stopTts()(1822)` → `ttsActive=false` → **E22(1853)** 释放 wakeLock + **E21(1832)** 早退 + **E18(1795)** 只在卸载跑。

---

## 4. 八类交互的完整调用链

格式：`用户动作 → handler(行号) → state 变化 → effect(行号) → API → 持久化`。**每条都落到函数名与行号。**

### 4.1 章节加载与切换

| 触发入口 | handler | state 变化 | effect | API | 持久化 |
|---|---|---|---|---|---|
| 点目录某章 | `actions.onSelectChapter`(2281) → `changeChapter(index)`(1046) | `setLoading(true)`(1084)、`setChapterIndex`(1085)、`setActiveDrawer(null)`(2281)、`setFlowTail([])`(1093)、`setFlowHead([])`(1094)、`setFlowKey`(1096)、`targetInitialPageRef`(1075)、`mangaTargetRef`(1079) | `useReaderChapterContent` layoutEffect(`useReaderChapterContent.ts:88`) → E5(489)/E13(1389)/L3(1514)/L2(1490) | `GET /api/books/content`(search.ts:106，调用点 hook:104) | `persist()` 在**切之前**先落旧章(1065) → `POST /api/reading-progress`(reader.ts:181) |
| 章末"下一章"提示条 / 底栏 | `onNextChapter: changeChapter`(2329)；`goNextChapter`(1136) | 同上 | 同上 | 同上 | `persist()`(1138) |
| 键盘 ←→ / PageUp/Down | E25 keydown(1898) → `case 'chapter-prev/next'`(1946-1955) → `changeChapter`/`goPrevPage`/`goNextPage` | 同上 | 同上 | 同上 | 经 `persist` |
| 滚动到底再滚一下 | E11 wheel(1147) → `changeChapter(i+1,'first')`(1159) | 同上（1.2s 冷却 1156-1158） | 同上 | 同上 | 经 `persist` |
| 滚动模式跨章顶窗 | E14 `onScroll`(1671) → `setChapterIndex(1703)` | `pendingKeepRef`(1700)、`flowAdvanceRef`(1701) | L1(1425) `pendingKeepRef` 分支 | 无（命中 `flowTail` 已取正文） | `persist()(1702)` |
| 媒体章播完 | `onMediaEnded`(2328) → `changeChapter(i+1)` | 同上 | 同上 | 同上 | 经 `persist` |
| 本地书换目录规则 | `reparseLocalBook`(330) | `setCurrentBook`(336)、`setChapterIndex(0)`(337)、`setShelfTocRule`(338)、`preloadedContentRef.clear()`(339) | 全部加载链 | `POST /api/books/reparse-local`(reader.ts:306) + `GET /api/books/chapters`(search.ts:89) | **`sessionStorage['legado-open-book-v1']`**(340) |

### 4.2 翻页与分页

| 动作 | handler | state 变化 | effect | API | 持久化 |
|---|---|---|---|---|---|
| 点右侧/滑动左 | `onPointerUp`(2111) → `swipeDirection`(2124)/`isTapGesture`(2133) → `runTapAction(2053)` → `goNextPage`(1587) | `setPageIndex`(1599) 或 `setCoverTurn`(1598) 或 `setMangaIndex`(1592) | E15(1740) → E16(1767) | 无 | 去抖 `persist`(1754-1759) |
| 点左侧/滑动右 | 同上 → `goPrevPage`(1636) | `setPageIndex`(1647)/`setCoverTurn`(1646)/`setMangaIndex`(1641)/`prependPreviousChapter`(1657) | E15/L4(1581)/L2(1490) | `GET /api/books/content`（接前一章 1626） | 去抖 `persist` |
| 滚轮（分页模式） | `onWheelPaginate`(2211) → `paginateWheelStep`(2213) 累计 → 140ms 冷却(2229) → `goNextPage/goPrevPage`(2230-2231) | `wheelAccumRef`/`wheelTimerRef`(2228-2229) + `pageIndex` | E15 | 无 | 去抖 `persist` |
| 键盘 PageUp/Down | E25 `case 'page-up'/'page-down'`(1934-1945) | `pageIndex` / `window.scrollBy` | E15 / E14 | 无 | 经 `persist` |
| 跨章（分页） | `goNextPage` 到本章末页 → `changeChapter(i+1,'first', keepContainer=true)`(1603) | 见 4.1 | L1/L3 | `content` | `persist`(1065) |
| 往回跨章（分页） | `goPrevPage` → `planPrevPage='prepend'`(1644) → `prependPreviousChapter`(1614) | `pendingPrependRef`(1631)、`setFlowHead`(1632) | L3(1514) → L4(1581) → `settlePrependedPage`(1568) → `setPageIndex`(1578) | `content`(1626) | 去抖 `persist` |
| 分页测量 | **不是用户动作**：L3(1514)/L4(1581) `measurePagination()`(1517/1583) | hook 写 `pageCount/pageFillers/pageIndex`（`setPageIndex` 经 594 传入） | 引发 E15/E16 | 无 | 去抖 `persist` |
| 阅读进度滑条拖动 | `onScrub: setScrubIndex`(2331) → `onScrubCommit`(2332) → `changeChapter(scrubIndex)` | `scrubIndex`(464)、`chapterIndex` | 见 4.1 | `content` | `persist`(1065) |

### 4.3 阅读进度保存与恢复

**保存（唯一出口 `persist` 816）**
`persist()` 读 `currentRef.current`(817) → `readLogicalPosition(current.chapter)`(819，737) 量视口 → `api.saveProgress(sourceId, bookUrl, chapter.url, chapter.index, clampScrollPosition(position), logical)`(820-827)。

| 写入触发点 | 行号 | 时机 |
|---|---|---|
| `changeChapter` 开头 | 1065 | 切章前先落旧章 |
| `goPrevChapter` / `goNextChapter` | 1133 / 1138 | 顶栏/快捷键切章 |
| 滚动跨章顶窗 | 1702 | 跨节那一刻 |
| 滚动去抖 | 1718-1723（1200ms） | 滚动结束 1.2s |
| `visibilitychange` hidden | 1727 | 切后台/关标签 |
| 滚动 effect cleanup | 1736 | 切 pageMode / chapters 变 / 卸载 |
| 分页去抖 | 1754-1759（1200ms） | 翻页后 1.2s |
| 漫画去抖 | 1786-1791（1200ms） | 翻屏后 1.2s |
| `onBack` 返回书架 | 2271 | 退出阅读器 |
| TTS 内部（`persist` 作为参数传入 853） | — | 朗读跨章/停止时（hook 内） |

**恢复（首屏）**
`handleChapterLoaded`(246) 在**首次加载且 `loadedChapter.index === startIndex` 且 `!restoredRef.current`**(268) 时：`initialLogicalPositionRef` = 存档的 `{charOffset, paragraphAnchor, positionChecksum}`(270-278)；否则 `position=0`。然后 `restoredRef.current=true`(279)、`currentRef.current`(280)、`initialPagePositionRef`(281)。
落点消费在 **L1(1425)**：逻辑位优先且校验 `positionChecksum` 相符 → `scrollToLogicalPosition`(786)（1463-1464）；否则 fraction `maxScroll*initialPos`(1472) 或 `first/last`(1467-1470)。分页模式走 `usePaginationMeasurement`（`initialLogicalPositionRef` 经 597 传入）。漫画模式走 **E9(605)**：`charOffset` → `mangaIndexAtOffset`(620)。

### 4.4 字体 / 字号 / 行距 / 背景设置

| 动作 | handler | state 变化 | effect | API | 持久化 |
|---|---|---|---|---|---|
| 设置抽屉里的滑杆/选项 | `ReaderChrome` 的 `actions.onSettingsChange`(2299) ← `ReaderSettingsSheet`（ReaderChrome.tsx:11 导入，本轮只做 props 级核对） | **本文件不持 state**：`settings` 是 prop(58)，`onSettingsChange`(59) 由上级写 | L3(1514)（9 项排版参数在依赖里）→ `measurePagination`；样式由 `readerStyle`(2022-2033) 以 CSS 变量下发：`--reader-font-size`/`--reader-line-height`/`--reader-letter-spacing`/`--reader-paragraph-spacing`/`--reader-text-indent`/`--reader-content-padding`/`--reader-max-width`/`--reader-font-family`/`readerBackgroundVars(settings)`(2032) | 无 | **持久化在上级**（本文件不落盘）；本文件只有 `uiV2`(139-146) 直读 localStorage |
| 字号快捷键 | E25 `case 'font-increase/decrease'`(1964-1971) → `bumpFontSize(1919)` → `stepFontSize`(1922)（口径唯一出处 `content/fontSizeControl.ts`） | 同上 | 同上 | 无 | 上级 |
| Ctrl/⌘+滚轮 | E26(2011-2020) → `stepFontSize`(2015) | 同上 | 同上 | 无 | 上级 |
| 换肤（T 键） | E25 `case 'theme-next'`(1972-1982) → `BUILTIN_SKINS.filter(!isBuiltinSkinHidden)`(1976) → `resolveTheme`(1978) | 同上 | 主题类名经 `themeClassNames(settings)`(2242) | 无 | 上级 |
| 点击区域编辑 | `onEditTapZones`(2289) → `setTapZoneEditing(true)`；`onTapZoneMap`(2291-2296)/`onTapZoneMode`(2297)/`onTapZonePreset`(2298) | `tapZoneEditing`(136)、`readingLeft`(2102) | E27(2103) 量左缘 | 无 | 上级（`settings.tapZones`） |

### 4.5 目录跳转

`ReaderChrome` → `ReaderCatalog`（ReaderChrome.tsx:6 导入，props 含 `onSelectChapter`/`onCloseDrawer`，`ReaderCatalog.tsx:23-36`）→ `actions.onSelectChapter`(**2281**) → `changeChapter(index)`(1046) + `setActiveDrawer(null)`(2281)。
`changeChapter` 内部：**卷分组跳过**(1053-1058，`isVolume`/无 `url` 沿方向跳到最近真章) → 越界提示 `showBoundaryNotice`(1049/1061) → `persist()`(1065) → `stopTts()`/`stopAllEngines()`(1066-1070) → `targetInitialPageRef`(1075-1077) → `mangaTargetRef`(1079) → `setLoading(true)`(1084) → `setChapterIndex`(1085) → 清窗口(1093-1095) → `setFlowKey`(1096)。
之后走 4.1 的加载链；落点由 L1(1425)（滚动）/`usePaginationMeasurement`（分页）/E9(605)（漫画）消费。**持久化：`sessionStorage` 不含目录跳转**（只有 340/1325 两处写），进度走 `persist`。

另外两条与"目录"相关的入口：笔记面板 `onJumpNote`(2287) → `jumpToNote`（`useReaderPositionJump.ts`，注入点 1102-1124）；本书搜索 `onJumpSearchHit`(2386) → `jumpToSearchHit`（同一 hook）→ `setSearchFlash`(1111) → E10(810) 6 秒后自清。

### 4.6 书签与笔记

**书签（`toggleBookmark` 642，仍在本文档内）**
`onToggleBookmark`(2278) → `toggleBookmark`(642) → `readLogicalPosition(chapter)`(644/737)（失败则 toast 645）→ `findBookmarkAt`(646，`notes/bookmark.ts`)：
- 已存在 → `api.deleteNote(id)`(648，`DELETE /api/notes/{id}` reader.ts:223) → `notesApi.setNotes(filter)`(650) → toast(651)
- 不存在 → `bookmarkPayload({... text: content.slice(off, off+60)})`(654-664) → `api.addNote(payload)`(666，`POST /api/notes` reader.ts:213) → `notesApi.setNotes([...list, created])`(668)

**划线 / 笔记（右键菜单 2152 / 选中浮层）**
`onBodyContextMenu`(2152) → `window.getSelection()`(2154) → `notesApi.buildSelectionDraft()`(2157)：
- 复制/复制为引用 → `navigator.clipboard.writeText`(2163/2173)
- 划线 → `api.addNote({startOffset,endOffset,excerpt,note:''})`(2185-2189) → `notesApi.setNotes`(2190)
- 笔记 → `notesApi.setNoteDraft(draft)` + `setNoteEditorOpen(true)`(2198) → 弹层 `NoteToolbar`（ReaderOverlays.tsx:219-227）→ `onSaveNote`(2395) → `notesApi.saveNote()`（hook 内 `POST/PATCH /api/notes`）
- 段评 → `setReviewsOpen(true)`(2203)
- 章节目录 → `setActiveDrawer('toc')`(2207)

**高亮渲染**：`renderParagraphContent`(891) → `renderNoteHighlights(rawLine, ownerIndex, notesApi.notes, notesApi.openNote)`(893，`NoteHighlights.tsx`)。**持久化全部走 `/api/notes`**，本文件不写 localStorage。

### 4.7 图片与特殊内容渲染

**正文配图**：`renderContentBlock`(942) → `contentImageUrl(line)`(943) 认出 `![图片](url)` → `readerImageSrc(image, referer, imageGeneration[image]??0, sourceId)`(948，走 `/api/book/image` reader.ts:356) → `<figure><img>`(955-979)，`aspectRatio:'3/4'` 占位(966) → `onLoad` 归还原比例 + 分页模式 `measurePagination()`(968-972) → `onClick` `setLightboxSrc(src)`(967) → ReaderOverlays 的图片预览(192-197)。
失败：`onError`(973-976) → `hidden=true` + `setFailedImages`(975) → 下轮渲染走 `renderImageFailure`(934) → 「重取这一张」→ `refetchChapterImage`(448) → `api.refreshBookImage`(450，`/api/book/image/refresh` reader.ts:343) → `setImageGeneration+1`(451) + `setFailedImages` 删键(452-456)。
预热：`handleChapterLoaded` 里 `warmContentImages(nextContent, url, sourceId)`(262)。

**漫画**：`isMangaMode = sourceType===2 && settings.mangaSinglePage && mangaImages.length>0`(518) → `mangaPages(paragraphs)`(516) → `renderMangaContent`(1019) → `mangaSpreadPages`(1020) → `renderMangaPage`(997) → `readerImageSrc`(1001)（失败同上一套 1002）；翻屏 `goNextPage`(1589-1594)/`goPrevPage`(1638-1643)；换章落点 E9(605-624)；下一屏预取 E8(537-545)。页码角标 `mangaPageLabel`(1029)。

**音视频/文件**：`sourceType`(680) + `isMediaType`(684) → `mediaSrc`(681-694)：服务端 `mediaUrl` 优先，其次嗅 `content` 是否是纯 URL(686-689)，外域走 `api.bookMedia`(693，`/api/book/media` reader.ts:366) → 传给 `ReaderBody` 的 `content.mediaSrc`(2322) → `MediaBlock`（ReaderBody.tsx:13 导入）；播完 `onMediaEnded`(2328) 进下一章。

### 4.8 异常恢复（正文加载失败 / 换源 / 重试）

| 场景 | 链路 |
|---|---|
| **正文加载失败** | hook `.catch` → `setMessage(err)`(`useReaderChapterContent.ts:106-108`) → `message` 经 2322 给 ReaderBody 渲染错误态；同时 E12(1377) 因 `message` 非空**不**计时 `slowLoad` |
| **重新加载（同章重试）** | `onRetryChapter: reloadChapter`(2333) → hook `reload`(`:83-86`)：删预载缓存 + `setReloadToken+1` → hook layoutEffect 依赖含 `reloadToken`(`:116`) → 重新 `api.content`。**不换章、不重挂容器** |
| **读不出来讨出路（换源）** | `onRecover: handleRecover`(2334) → `recovery = resolveContentRecovery(...)`(1336-1346，`lib/shelfSourceFallback`) + `recoveryLabel`(1347/2335)。若 `kind!=='switch-alternate'` → `setShowSourceSwitch(true)`(1351) → 换源弹窗；否则 `api.details`(1355) + `api.chapters(details.tocUrl)`(1356) → `matchBestChapter(chapters, chapter?.title, chapterIndex)`(1358，与换源弹窗同口径) → `handleSwitchSource`(1359) |
| **换源落地** | `handleSwitchSource`(1269) → `api.details`(1270) → `safeDetails` 清洗（`cleanTitle`/`cleanAuthor` 1278-1279）→ `api.switchBookshelfSource`(1285) → 组 `newOpenBook`(1299-1311) → `setCurrentBook`(1313) + `setChapterIndex`(1314) + `preloadedContentRef.clear`(1315) + `stopTts`(1318) + 清窗口/refs(1319-1324) + **`sessionStorage['legado-open-book-v1']`**(1325) |
| **慢加载** | E12(1377-1381) 8 秒 → `slowLoad`(2322) → ReaderBody 显示"还没出来"并保证 `onExit`(2336) 始终可点 |
| **净化规则改了** | `onRulesChanged: handleReplaceRulesChanged`(2378) → (401)：`setLoadedChapterUrl('')`(404)+`setContent('')`(405)+`setLoading(true)`(406) → `api.content`(407) → **URL 对得上才回写**(409/414/418) |
| **手动刷新正文** | `onRefreshed: handleChaptersRefreshed`(2382) → (354)：清预载(357)、并集缓存标记(358-362)、`updateFlow` 重取 tail/head(365-376)、当前章重取(379-393，含 `currentChapterUrlRef` 闸门 381)、`syncCacheStatus()`(394) |
| **边界** | `showBoundaryNotice`(1034-1040) 1.4s 自动清；键盘 `isAtTopBoundary`/`isAtBottomBoundary`(1937/1943) |

---

## 5. 状态管理缺陷清单

> 判定口径：**存在** = 源码可证且无保护；**部分存在** = 主路径有保护、旁路径没有；**不存在** = 有明确保护机制（附证据行号）。

### 5.1 竞态条件（两次请求先后返回，旧覆盖新）—— **部分存在**

| 路径 | 判定 | 证据 | 触发场景 | 后果 |
|---|---|---|---|---|
| 主正文加载 | **不存在** ✅ | `useReaderChapterContent.ts:89` `cancelled` + `:113-115` cleanup；`apply` 首行 `if (cancelled) return`(:93) | 快速连点目录切章 | 旧响应被丢弃，正确 |
| 净化规则重取 | **不存在** ✅ | 401–420，四处 `currentChapterUrlRef.current !== requestedUrl` 才写(409/414/418) | 改规则后立刻切章 | 正确 |
| 手动刷新正文 | **不存在** ✅ | 381 `if (currentChapterUrlRef.current !== currentUrl) return` | 刷新时切章 | 正确 |
| 换源 `handleSwitchSource` | **存在** ❌ | 1269–1326：`await api.details`(1270) → `await api.switchBookshelfSource`(1285) → **无条件** `setCurrentBook`(1313)/`setChapterIndex`(1314)。**无 requestId、无 AbortController、无 URL 闸门** | ①慢网下连点两次「换源」并选不同源 ②`handleRecover`(1349) 的异步 IIFE 与手动换源同时进行 | 先发的那次后返回 → **旧书覆盖新书**；`sessionStorage`(1325) 也写成旧书 → 刷新页面回到错误的源 |
| `prependPreviousChapter` | **存在** ❌ | 1614–1634：`await api.content`(1626) 后**无条件** `setFlowHead`(1632) | 分页模式往回翻触发接章（慢网）→ 立刻用目录跳到远端章节 | 旧章被接到**新锚点前面**；`pendingPrependRef`(1631) 还留着 → 见 5.6 的"往回翻卡死" |
| `handleRecover` 内部 | **存在** ❌ | 1349–1364 无取消；`chapter?.title`/`chapterIndex` 是闭包捕获 | 点「换源试试」后立刻手动切章 | `matchBestChapter` 用旧章名定位，跳到错误章 |
| `refetchChapterImage` | 低危 | 448–461 无闸门，但写入按 `image` 键 | 边重取边切章 | 只影响该图键值，不串章 |

### 5.2 重复请求（同一章节被请求多次）—— **存在**

| # | 重复来源 | 证据 | 场景 |
|---|---|---|---|
| D1 | **续接窗口 E13 不查"在飞"集合** | `useReaderChapterContent` 的 `preload` 用 `preloadedContentRef.has \|\| preloadingRef.has`(`:67`) 去重；而 **E13 只查 `preloadedContentRef.current.get`(1407)**，未查 `preloadingRef` → 随后 `api.content`(1412) | 滚动读到 70% → E14(1714) `preloadNextChapter` 发出请求（结果还在路上）；同一轮 `content/loadedChapterUrl` 变化使 E13 跑 → 对**同一 URL**再发一次 ⇒ 同章 2 个 `GET /api/books/content`。`confirmed`（代码级）/ 时序 `needs-runtime-test` |
| D2 | **接前一章同样不查在飞集合** | 1623–1630 只查 `preloadedContentRef` | 往回翻与预载上一章（E14 的 `position<=0.3` → 1716）撞车 |
| D3 | **换源链路把详情取两遍** | `handleRecover` `api.details`(1355) → `handleSwitchSource` 又 `api.details`(1270) | 走「读不出来→换用备选源」必现 2 次 `/api/books/details` |
| D4 | 主加载 effect 重跑 | 依赖含 `chapter`(hook `:116`)、`startIndex`、`progress?.*` 四个原语 | `currentBook.progress` 在阅读中**从不被回写**（persist 只发服务端 820），故不会自触发 ✅；但换源/重切目录后 `chapter` 对象换 → 必然重取（合理） |
| D5 | `reloadToken` | hook `:50/85`，只在点「重新加载」时自增 ✅ | 不构成重复 |

### 5.3 过期异步响应覆盖新状态（有无 requestId / abort / cancelled）—— **部分存在**

- **有**：`alive`(87/92) 用于简繁词表；`cancelled`(1397/1413/1419/1421) 用于 E13；`cancelled`(hook:89/113) 用于主加载；`currentChapterUrlRef` 闸门 3 处（381/409/414/418）；`localSyncAbortRef`(165/1221-1238) —— **但它在死代码里（1218 无调用者），等于全文件实际只用 1 个 `AbortController` 且没人用**。
- **没有**：`handleSwitchSource`(1269-1326)、`handleRecover`(1349-1364)、`prependPreviousChapter`(1614-1634)、`toggleBookmark`(642-670)、`toggleShelf`(1165-1190)、`handleCacheAll`(1204-1216)、`handleCancelCache`(1259-1267)、`refetchChapterImage`(448-461)、`handleChaptersRefreshed` 的 `updateFlow`(365-376)：`next !== tailBefore`(374/376) 是**数组引用比较**——无命中时返回原数组(366) 故不写 ✅，一旦命中就 `Promise.all` 新数组 ⇒ **恒为真**，哪怕内容逐字相同也会多一次 state 写与一次重渲染。
- **无全局 requestId 机制**：全文件 0 处 `requestId`（grep 实证）。

### 5.4 组件卸载后的异步更新（有无 cleanup 保护）—— **存在**

| 项 | 判定 | 证据 | 后果 |
|---|---|---|---|
| **1200ms 进度去抖定时器** | **存在** ❌ | `timerRef`(188) 在 E15(1754-1759)/E17(1786-1791) 里被设，但**只有 E14 的 cleanup 清它**(1735)；E24(1895) 只清 `boundaryTimerRef`。分页/漫画模式下卸载**无人清** | 退出阅读器后 1.2 秒仍发一次 `POST /api/reading-progress`，且用的是**已离开那一章**的 `currentRef`。切书后这条写入会落到旧书上（`persist` 的 sourceId/bookUrl 来自闭包 821-822，是旧值 ⇒ 写旧书，勉强"对"，但用户在**新书**里退出时，两个组件实例的写入互相覆盖同一本书的进度 = §5.5 的根因之一）。`likely` |
| 主正文请求 | **不存在** ✅ | hook `cancelled` | 正确 |
| E13 续接请求 | **不存在** ✅ | `cancelled`(1421) | 正确 |
| `toggleShelf` | **存在**（低危） | `setInShelf`(1170/1184) 在 await 后无条件写 | 卸载后丢弃，无警告 |
| `handleCacheAll` | **存在**（低危） | `setCacheStatus`(1212) | 同上 |
| `handleCancelCache` | **存在**（低危） | `setCacheStatus`(1262) | 同上 |
| `handleSwitchSource` | **存在** | `setCurrentBook`(1313) 等 8 处 | 卸载后整批丢弃 |
| `refetchChapterImage` | **存在**（低危） | `setImageGeneration`(451) | 丢弃 |
| 引擎/wakeLock/定时器 | **不存在** ✅ | E18(1795-1797) `stopAllEngines`、E22(1863-1866) `release`、E20(1828) `clearInterval`、E24(1895) 清边界定时器 | 正确 |
| `wheelTimerRef`/`wheelIdleRef` | **存在**（极低危） | 只在 handler 内自清(2229/2220) | 卸载后空转一次 |

### 5.5 阅读进度被覆盖或丢失 —— **存在**

1. **写入点过多且无顺序保证（10 处，见 §4.3）**：`persist` 是 fire-and-forget（`.catch(()=>undefined)` 827），**没有任何序号/时间戳/串行化**。两条并发 `POST /api/reading-progress` 落到服务端是"后到者赢"，与"谁先发"无关。最典型的撞车：**跨章瞬间** `persist()(1702 或 1065) 立即发一次` + `1200ms 去抖(1721/1757) 再发一次`，两次携带的是不同章/不同 fraction。`needs-runtime-test`
2. **`persist` 不校验"当前章"**：`currentRef.current` 只在 `handleChapterLoaded`(280) 写。切章后到正文落地之间（慢网 >1.2s），E14 的 `onScroll` 已把 `current.position` 按**新窗口的锚点节**重算(1693 `boxes[0]`)，但 `current.chapter` 仍是旧章 ⇒ **把新章的进度记到旧章上**。`likely`（复现：滚动模式、慢源、跨章后立刻继续滚 → 1200ms 定时器触发）
3. **恢复只做一次且不复位**：`restoredRef`(189) 置 true(279) 后**永不复位**，换源(1313-1325)、重切目录(336-337) 都不重置 ⇒ 新书首章不再走语义位恢复（且 L1 已把 `initialLogicalPositionRef` 清空 1458-1460）。后果轻（新书进度本就是 0），但语义上是"换源后丢失进度恢复能力"。
4. **`positionChecksum` 变化会重跑落位**：L1 依赖含 `positionChecksum`(1483)，它由 `content + settings.scriptMode` 算出(562-565) ⇒ 切简繁档位 → L1 重跑 → 若逻辑位校验通过就 `scrollToLogicalPosition`(1463-1464) **把用户已滚到的位置拉回存档位**。`needs-runtime-test`
5. **无节流上限**：`persist` 每次滚动停止都发；长章节快速翻页时每个 1200ms 窗口 1 次 + 每次切章 1 次，**无最小间隔、无合并**。
6. **`beforeunload`/`pagehide` 未挂**：只靠 `visibilitychange`(1726-1728)。桌面浏览器关闭标签时 `visibilitychange` 通常会到（`likely` 够用），但**直接崩溃/强杀进程**则丢失最后一屏进度。

### 5.6 章节切换期间的状态污染（切章时哪些 state 没重置）—— **存在**

`changeChapter`(1046-1097) **显式重置**：`loading`(1084)、`chapterIndex`(1085)、`activeDrawer`(1086)、`flowAdvanceRef`(1089)、`pendingKeepRef`(1090)、`flowTail`(1093)、`flowHead`(1094)、`pendingPrependRef`(1095)、`flowKey`(1096)、`targetInitialPageRef`(1075)、`mangaTargetRef`(1079)；`renderLimit` 由 E5(489) 间接重置。

**未重置**：

| state/ref | 后果 |
|---|---|
| `imageGeneration`(444)、`failedImages`(445) | 跨章跨书**只增不减**（键是原图 URL）⇒ 长阅读内存单调增长；换书后旧图的"失败态"仍在（若 URL 复用会误显失败） |
| `scrubIndex`(464) | 只在 `onScrubCommit`(2332) 清；`changeChapter` 不清 ⇒ 若提交与关闭抽屉交错，进度条可能显示旧章位置 |
| `lightboxSrc`(435) | 切章后图片预览仍开着（可接受，但图已不属于当前章） |
| `searchFlash`(630) | 不清；靠渲染处 `ownerIndex===chapterIndex && searchFlash.chapterIndex===chapterIndex`(900) 兜住 ✅ |
| `pendingNoteJumpRef`(199) | 故意保留（跨章跳笔记），由 `useReaderPositionJump` 消费 |
| `pageIndex`(168) | 故意不清，依赖 `targetInitialPageRef`(1075-1077) + `measurePagination` 夹取(`usePaginationMeasurement.ts:132-134`)；若测量延后，一瞬落在旧页码 ⇒ 已由 1071-1077 注释记录的历史 bug 的同类风险 |
| `restoredRef`(189) | 见 5.5-3 |
| `toolbarsVisible`(137) | 切换后仍保持上一章的显隐 |
| **`pendingPrependRef` 卡死**（特殊） | `prependPreviousChapter` 成功后不清它(1658-1659 注释明说"活到量出页数那一刻")；若 `settlePrependedPage` 的 5 个前提(1570-1576)任一不满足（尤其 `windowChaptersRef[0]?.url !== url` 1572，例如用户随后用目录跳章），它**永久留值** ⇒ 之后 `goPrevPage` 走 1651 分支，只会 `measurePagination()` 而**不再接章** ⇒ 「往回翻」失效直到某次条件偶然满足。`needs-runtime-test`（复现：分页双栏 → 往回翻一次 → 接章未结账前用目录跳章 → 再往回翻） |

### 5.7 多个 effect 互相触发（循环 / 多余渲染）—— **死循环：不存在；多余渲染与多余测量：存在**

- **不存在无限循环**（有实证）：`measurePagination` 的依赖是 `[columnGap, columnMode, content, loading]`(`usePaginationMeasurement.ts:174`)，不是每帧新身份；`setPageFillers` 有逐项相等比较、相等则返回原引用(`:119-120`)；`setPageCount` 写原始值（相等即 bail）。故 L3 依赖 `pageFillers` 只会在真的变时再跑一轮。
- **多余渲染 1**：`E16(1767)` 与 `E15(1740)` 依赖几乎相同，翻一页跑两遍进度计算（一处上报底栏、一处落库）。
- **多余渲染 2**：`E5(489)` 与 `E23(1873)` 都能写 `renderLimit`；`E6(495)` 又依赖 `renderLimit` ⇒ 一次补块引发 observer 重建（一次翻页期间可建多个）。
- **多余渲染 3（最重）**：**所有子组件都没有 `memo`**（`grep "memo(" ReaderBody/ReaderChrome/ReaderOverlays/ReaderCatalog` 无命中）。任意一个布尔（如 `setLightboxSrc`(967)、`setToolbarsVisible`(1680)、`setReadingLeft`）变化 ⇒ **整棵 2,403 行组件 + 全部段落重渲染**。
- **多余触发 4**：`E14` 的 cleanup 会 `persist()`(1736)，而它的依赖含 `persist` 身份与 `currentBook.chapters` ⇒ **切 pageMode（含点按区切模式 2297）也会触发一次额外落库**。
- **多余触发 5**：`E25(1898)` 依赖整个 `settings` 对象 ⇒ 每次拖字号滑杆都 `removeEventListener`+`addEventListener` 一次 keydown。
- **多余触发 6**：`E20(1810)` 每秒 `setRemainingSeconds` ⇒ 每秒整棵阅读器重渲染（按 5.7-3，等于每秒重渲染全部段落）。`likely`（长章节下有可感卡顿）

### 5.8 不必要的全局状态（本该局部却提到顶层）—— **存在**

| 项 | 判定 | 证据 | 说明 |
|---|---|---|---|
| `settingsTab` | **死状态** ❌ | 声明 633，**全文件 0 读 0 写** | 标签页状态实际由 `ReaderSettingsSheet` 内部持有；这里是重构残留 |
| `localSyncing` / `localSyncProgress` | **死状态** ❌ | 163/164，唯一写入者在 `handleSyncToLocal`(1218)，而它**无任何调用者** | 连同 `localSyncAbortRef`(165)、`downloadChaptersToOffline` 导入(52-53) 一起是死代码；`api.content(...signal)`(1233) 也因此从没跑过 |
| `handleCacheBook` / `handleCacheAll` / `handleCancelCache` | **死代码** ❌ | 1192/1204/1259，`grep` 无调用点（`handleCacheAll` 只被死的 `handleCacheBook` 调 1193） | `api.cacheBookshelfRange`(1206) 与 `api.cancelBookCache`(1261) 在本界面**不可达** |
| `setOfflineStatsModal(true)` | **不可达** ❌ | 161 声明 + 2380 只有 `false`；`grep` 全仓 `features/reader/`、`components/` 无 `true` | **缓存统计弹层永远打不开**（`dialogs.offlineStats` 恒 false） |
| `cachePercent` | **死计算** ❌ | 2234 唯一出现处，未被使用、未下传 | |
| `clearPreload` / `preloadingRef` | **死解构** ❌ | 299/296 解构后从未使用 | |
| `readingLeft` | 本可局部 | 2102 只服务 `ReaderChrome` 的 `TapZoneEditor`(2260) | 应下移到编辑器或 `ReaderChrome` |
| `viewportWidth` | 本可局部 | 520 只服务 `mangaSpreadSize`(526) | |
| `remainingSeconds` | 归属错位 | 148/1810-1829 | 语义属 TTS（`sleepTimer` 已在 `useReaderTts` 内），此处另立一份 |
| 12 个浮层布尔 | 未合并 | 149/160/161/162/435/626/628 + tts 3 个 + notes 2 个 | 12 个独立布尔 ⇒ 12 条独立 re-render 路径；合成一个 `overlay` 联合值可把"打开任意弹层"的代价降到 1 条 |

---

## 6. 与外部世界的依赖

### 6.1 直接调用的 API 端点（method + path + 本文件调用行 + 端点定义处）

| API | method + path | 端点定义 | 本文件调用行 |
|---|---|---|---|
| `api.content` | `GET /api/books/content` | `domains/search.ts:106` | **1412**（E13 续接）、**1626**（接前一章）、**379**（刷新当前章）、**407**（净化规则重取）、**369**（`updateFlow` 重取 head/tail）、1233（**死代码**） |
| `api.chapters` | `GET /api/books/chapters` | `domains/search.ts:89` | 334（重切目录）、1356（换源备选取目录） |
| `api.details` | `GET /api/books/details` | `domains/search.ts:83` | 1270（换源）、1355（`handleRecover`） |
| `api.saveProgress` | `POST /api/reading-progress` | `domains/reader.ts:181`（`progress.save`，映射 `index.ts:274`） | **820（唯一出口）** |
| `api.addNote` | `POST /api/notes` | `domains/reader.ts:213` | 666（书签）、2185（划线） |
| `api.deleteNote` | `DELETE /api/notes/{id}` | `domains/reader.ts:223` | 648（取消书签） |
| `api.tocRules` | `GET /api/books/toc-rules` | `domains/reader.ts:269` | 322 |
| `api.reparseLocalBook` | `POST /api/books/reparse-local` | `domains/reader.ts:306` | 333 |
| `api.refreshBookImage` | `GET /api/book/image/refresh?url=` | `domains/reader.ts:343` | 450 |
| `api.addToBookshelf` | `POST /api/bookshelf` | `domains/reader.ts:37`（`bookshelf.add`，`index.ts:196`） | 1175 |
| `api.removeFromBookshelf` | `DELETE /api/bookshelf?sourceId&bookUrl` | `domains/reader.ts:43-44`（`bookshelf.remove`） | 1169 |
| `api.switchBookshelfSource` | `POST /api/bookshelf/switch-source` | `domains/reader.ts:121` | **1285** |
| `api.cacheBookshelfRange` | `POST /api/bookshelf/cache` | `domains/reader.ts:68-79`（`cache.range`，`index.ts:202`） | 1206（**死代码**） |
| `api.cancelBookCache` | `DELETE /api/bookshelf/cache?...clearData=true` | `domains/reader.ts:96`（`cache.cancel`） | 1261（**死代码**） |

**间接（本文件只造 URL，由浏览器去取）**：
- `api.bookMedia(raw, chapter.url)`(**693**) 返回 `/api/book/media?...`（`reader.ts:366`）→ 给 `<MediaBlock>`。
- `readerImageSrc(...)`（948/1001/543）→ `/api/book/image?...`（`reader.ts:356`）。
- `contentImageUrl(line)`（943）认出正文里的图片占位。

**不在本文件里、但由它下传的取数**：`GET /api/notes`（`useReaderNotes`）、`GET /api/bookshelf/cached-chapters`（`useReaderCacheStatus`）、`/api/reading-log`（`useReadingLog`）、TTS 音频（`useReaderTts`）。

### 6.2 直接读写的 storage

| 存储 | 键 | 读/写 | 行号 |
|---|---|---|---|
| `localStorage` | `reader-ui-v2` | **读**（渲染期、try/catch 包住） | 144 |
| `sessionStorage` | `legado-open-book-v1` | **写**（重切目录后） | 340 |
| `sessionStorage` | `legado-open-book-v1` | **写**（换源后） | 1325 |
| IndexedDB | — | **本文件不直接读写**；经 `downloadChaptersToOffline`(1228，死代码)、`useReaderCacheStatus`、`offlineStorage` 间接 | 1228 |

> 注：`sessionStorage` 的**读**发生在别处（`lib/openBook`，本文件只写不读）⇒ 两处写入点必须格式一致，否则上层解析失败。见 8.2 未确认项。

### 6.3 是否直接参与分页计算 —— **是，而且是主要的"编排者"**

| 参与方式 | 证据（行号） |
|---|---|
| 列间距常量 | `columnGap = 40`(169)，直接喂给 `usePaginationMeasurement`(593) 与 `ReaderBody`(2312) |
| 视口→逻辑位置（读） | `readLogicalPosition`(737-783)：`findFirstIntersectingParagraphIndex`(772)、`caretOffsetWithin`(775-777)、段起点表 `paragraphStarts`(550-556) |
| 逻辑位置→滚动（写） | `scrollToLogicalPosition`(786-806)：`offsetToParagraph`(794)、`textOffsetRect`(801) |
| 页窗推进（分页跨章） | L2(1490-1511)：`pageWindowShift`(1497)、`windowChaptersRef[shift.lead]`(1501)、`pendingPageRef`(1505) |
| 接章落点 | `settlePrependedPage`(1568-1579)：`prependLandingPage(starts[1], columnsPerPageRef.current)`(1578) |
| 进度分母 | `pageProgress(pageSpansRef, pageIndex)`(1744)、`sectionProgress`(1693)、`mangaFraction`(1779) |
| 页脚章名 | `sectionAtPage(spans, pageIndex)`(715) |
| 测量触发 | L3(1514-1548) 16 项依赖 + `ResizeObserver`(1523) |
| 翻页决策 | `planNextPage`(1595)、`planPrevPage`(1644)、`mangaNextStart/mangaPrevStart`(1590/1639) |

> 结论：**分页的"数学"在 `content/readerFlow.ts`、`interaction/pageTurn.ts`、`content/mangaPages.ts` 与 `usePaginationMeasurement.ts` 里，但"何时量、量完把页码挪到哪、什么时候跨章"全在这一层决定** —— 这也是它最难拆的原因（见 §7）。

### 6.4 本文件持有的业务规则（本该是领域规则）

| 规则 | 行号 | 重复实现处 |
|---|---|---|
| **"有效章节"判据**（跳过 `isVolume` 与无 `url`） | 1053-1058（`changeChapter`）、1400-1404（E13）、1619-1621（接前一章）、719-725（下一章标题）、720-722 | **5 处各写一遍**；hook 里还有第 6 份（`useReaderChapterContent.ts:65`） |
| **"是不是第一章/最后一章"** | 1047-1051、1132、1137、1151、2328 | 边界提示文案也散在 1049/1061/1662 |
| **进度封顶/夹取** | `clampScrollPosition`(825/1693)、`pageProgress`(1744) | 函数在 `settingsPanel/readerSettings.ts`（口径单源 ✅） |
| **媒体章不续接/不往回接** | 1392、1616（另 `isMangaMode` 分支 518/1591/1640） | 2 处 |
| **预载阈值 0.7 / 0.3** | 1713-1717、1749-1752、1784-1785 | **3 处硬编码** |
| **魔法时间常数** | 1200ms 去抖(1721/1757/1790)、1200ms 跨章冷却(1157)、140ms 滚轮冷却(2229)、500ms 滚轮空闲(2220)、6000ms 高亮(812)、8000ms 慢加载(1379)、1400ms 边界提示(1039) | **7 个**，全部写死在组件体内 |
| **字号步进口径** | `stepFontSize`(1922/2015) | 单源 ✅（`content/fontSizeControl.ts`） |
| **图片 Referer 归属**（续接章的图不能拿锚点章当来源） | 947 | 单处，但依赖调用方正确传 `owner`(988) |

---

## 7. 拆分现状评估

### 7.1 已抽出的 hook（**实数 8 个**，任务书写"7 个"——第 8 个是 2026-11-06 新增的 `useReaderTts`，见 833-841 注释）

| hook | 实测行数 | 承担了什么 | 留给 ReaderScreen 的耦合点 |
|---|---|---|---|
| `useReaderChapterContent`(301) | 136 | 正文/媒体地址/message/loading 五个 state、预取 Map（上限 12 章）、预取在飞集合、`reload` 令牌、请求与 `cancelled` 取消 | `onLoaded` 回调（246）与 `progress` 透传；`chapter` 对象身份即重取触发 |
| `useReaderCacheStatus`(232) | 139 | 书架记录 + IndexedDB 的并集、字数表、`syncCacheStatus` | 4 个 setter 被本文件直接调用（251/259/338/358/385） |
| `usePaginationMeasurement`(587) | 190 | 全部页数测量：`pageCount/pageFillers/stride/columnWidth/isDoubleColumn` + 5 个 ref（`pageSpansRef/measuredStartsRef/columnsPerPageRef/pageAlignedRef/pendingPageRef`）+ `measurePagination` | 本文件通过 3 个 ref 注入"落点意图"（`targetInitialPageRef`/`initialPagePositionRef`/`initialLogicalPositionRef`）并在 4 个 layoutEffect 里指挥它何时跑 |
| `useReaderPageTurn`(180) | 77 | 翻页动画（slide/fade/cover）状态机 | 只有 6 个返回值 + `pageIndex` 双向 |
| `useReadingLog`(312) | 46 | 停留计时与 30s 分段上报 | 只进不出（无返回值） |
| `useReaderNotes`(572) | 193 | 笔记/划线的加载、重锚、草稿、增删改、选中浮层、笔记面板开关 | **19 个字段被本文件使用**（`notesApi.*`，40+ 处引用）；但 `toggleBookmark`(642) 仍留在本文件 |
| `useReaderTts`(842) | 369 | 朗读全部：引擎、分片、播放态、睡眠定时、跨章续播、离线确认 | 17 个返回值；本文件仍持有 6 个 TTS 专属 effect（1795/1800/1810/1832/1853/1870） |
| `useReaderPositionJump`(1102) | 120 | `jumpToNote`/`jumpToSearchHit`/`jumpToNotePosition` + 跨章落点 effect | 需要 20 个入参（1103-1123） |

### 7.2 已抽出的展示组件（直接由本文件组合的 3 个 + 其内部 3 个；目录里另有 5 个更小的）

| 组件 | 实测行数 | 职责 |
|---|---|---|
| `ReaderChrome` | 218 | 顶栏（MD3/legacy）+ 底栏 + 目录抽屉 + 设置抽屉 + 抽屉遮罩 + 点击区域编辑器；内部再组合 `ReaderCatalog`(149) / `ReaderHeader`(72) / `Md3Chrome`(131) |
| `ReaderBody` | 296 | 正文画布：分页轨道（含 cover 覆盖层）与滚动续接两形态；内部 `VirtualChapterList`(172) / `ReaderContentSkeleton`(26) / `MediaBlock` |
| `ReaderOverlays` | 238 | 12 个弹层 |
| 其它（未直接 import 于本文件） | `NoteHighlights`(47) / `ReaderSheet`(39) / `IconButton`(9) | 纯函数或小件，由上面三者使用 |

> 抽出去的部分合计 **≈1,900 行**（8 hook 1,170 + 6 展示 1,124 − 重叠引用），本文件仍剩 2,403 行。

### 7.3 剩下这 2,403 行到底在做什么（按行区间分段；行号会有漂移，看区间职责而非精确边界）

| 行区间 | 约行数 | 职责 | 备注 |
|---|---|---|---|
| 1–67 | 67 | **头部**：51 行 import（28 个本地模块）+ `ReaderScreenProps` 类型 | import 面就是它的耦合面：交互、内容、笔记、TTS、设置、API、品牌、离线、性能 8 个域 |
| 69–167 | 99 | **状态声明 + 3 个短 effect**：书/简繁/续接窗口 key/章号/抽屉/工具栏/uiV2/5 个弹层布尔/分页 index；`convert` 加载(86-93)、全屏镜像(151-155)、`toggleFullscreen`(156-159) | 21 个 `useState` 挤在这里，**没有任何分组**（导航/弹层/分页/TTS 混成一列） |
| 168–218 | 51 | 翻页动画 hook 接线 + **20 个 `useRef`**（DOM 引用、首屏落点意图、滚动位、手势起点、定时器） | 17 个 ref 是"跨 render 的可变寄存器"，是本文件最不可测的部分 |
| 219–318 | 100 | **hook 接线区**：缓存状态(232)、`handleChapterLoaded`(246-282)、正文 hook(301)、阅读记录(312)、本地书规则清单(320) | `handleChapterLoaded` 是"正文到了之后"的唯一汇合点（字数/缓存标记/图片预热/首屏意图/`currentRef`） |
| 320–432 | 113 | **本地书重切目录**(330) + **手动刷新正文**(354) + **净化规则重取**(401) + 文档标题(422) | 三条"重取正文"路径各写一遍 setState 顺序与过期判断 |
| 434–547 | 114 | **图片子系统**：lightbox(435)、重取代次(444)、失败表(445)、`refetchChapterImage`(448) + 进度条 scrub(464) + **分块渲染**(485-504) + **漫画模式**(516-545，含下一屏预取) | 三个互不相干的子系统塞在同一段 |
| 549–634 | 86 | 段偏移表(550)、位置校验值(562)、`logicalMetaRef`(567)、notes hook(572)、分页测量 hook(587)、漫画落点 effect(605)、3 个弹层布尔(626-633) | `paragraphStarts` + `positionChecksum` 是"进度可恢复"的地基 |
| 635–806 | 172 | **书签 `toggleBookmark`**(642) + 媒体源推导(681-694) + 窗口章表(702) + 页脚章名(712) + 下一章名(719) + **`readLogicalPosition`(737-783)** + **`scrollToLogicalPosition`(786-806)** | 两个位置函数是本文件最核心的算法（DOM 量测 + 偏移换算） |
| 808–928 | 121 | 搜索高亮定时(810) + **`persist`(816-828)** + TTS 接线与解构(842-865) + 离线确认(868) + 段落点击(882) + `renderParagraphContent`(891-928) | `persist` 只有 13 行，却是 10 处调用的唯一落库口 |
| 929–1040 | 112 | 图片失败渲染(934) + **`renderContentBlock`(942-991)** + **漫画渲染(997-1032)** + 边界提示(1034-1040) | 渲染函数直接闭包 8 个 state（`imageGeneration`/`failedImages`/`ttsActive`/`activeParagraphIndex`/`activeSentenceText`…） |
| 1041–1163 | 123 | **`changeChapter`(1046-1097，54 行，全文件最重函数)** + `changeChapterRef`(1099) + 跳转 hook(1102) + `goPrev/NextChapter`(1131/1136) + 滚动到底翻章 effect(1147) | `changeChapter` 一个函数里干了 8 件事：边界判定、卷头跳过、落库、停/续朗读、落点意图、清窗口、换 key |
| 1165–1364 | 200 | 书架增删(1165) + **整段死代码**(1192-1267：缓存队列/本机同步/取消缓存) + **换源(1269-1326)** + 恢复推导(1336) + **`handleRecover`(1349)** | 死代码约 76 行；换源是全文件唯一"整本书替换"的写点 |
| 1366–1422 | 57 | 慢加载计时(1377) + **续接窗口 effect(1389-1422)** | 唯一"预取 + 组装 tail"的地方，也是重复请求源（§5.2-D1） |
| 1424–1585 | 162 | **三个 layoutEffect**：滚动落位(1425-1483)、分页顶窗(1490-1511)、分页测量(1514-1548) + `settlePrependedPage`(1568) + 接章结账(1581) | 全部"绘制前必须完成"的几何校正；注释占约 40%，是本文件最难改的一段 |
| 1587–1665 | 79 | `goNextPage`(1587) + **`prependPreviousChapter`(1614)** + `goPrevPage`(1636) | 翻页三入口；往回翻与往前翻**不对称**（接章 vs 顶窗） |
| 1667–1792 | 126 | **三个进度 effect**：滚动(1668-1738，含跨章顶窗 + 预载 + 去抖落库)、分页(1740)、漫画(1777) + 分页上报(1767) | 落库逻辑写了 3 遍（同一段形状复制到分页与漫画） |
| 1794–1893 | 100 | 卸载停引擎(1795) + 跨章自动续播(1800) + **睡眠定时(1810)** + MediaSession(1832) + WakeLock(1853) + **TTS 跟读滚屏(1870)** | 5 个纯副作用 effect，与正文/分页无关，本该整体搬进 TTS 层 |
| 1895–2020 | 126 | 定时器清理(1895) + **快捷键 17 个 case(1898-2008)** + Ctrl 滚轮字号(2011) + `readerStyle` CSS 变量(2022-2033) | 快捷键表本身已在 `interaction/shortcuts.ts`，这里只剩"动作分发" |
| 2035–2232 | 198 | 指针手势(2036/2111) + **点击分区 `runTapAction`(2053)** + 阅读矩形(2088) + `readingLeft`(2102) + **右键上下文菜单(2152)** + **滚轮翻页(2211)** | 手势与弹层/章节/分页三域交叉；`onWheelPaginate` 有 4 个 ref 参与角标状态机 |
| 2234–2402 | 169 | **渲染装配**：`cachePercent`(死) + `main` + `ReaderChrome`(60 行 props) + `ReaderBody`(34 行 props) + legacy 底栏 + `ReaderOverlays`(45 行 props) | 纯装配，但 160 行 props 意味着**任何新增能力都要在这里穿一次线** |

### 7.4 "大在哪里"——四个真实病灶

1. **它同时是 6 个不同生命周期的主人**：章节加载、分页几何、阅读进度、TTS 播放、图片缓存、弹层 UI。这 6 条时间线的 state 与 effect 交织在同一作用域（§3.3 链条 A–F），任何一条改动都要求理解另外 5 条。
2. **它持有一套"跨 render 的可变寄存器"**：35 个 `useRef` 中有 **17 个**是"意图位/闸门位"（`pendingKeepRef`/`pendingPrependRef`/`targetInitialPageRef`/`initialLogicalPositionRef`/`flowAdvanceRef`/`mangaTargetRef`/`restoredRef`…），它们的读写分布在 4 个 layoutEffect、3 个进度 effect、6 个 handler 里，**没有单一 owner，也没有断言**。这是"改了 A 坏 B"的主因。
3. **三个几何模式各写一遍**（滚动续接 / 分页轨道 / 漫画单页）：跨章、落点、进度、预载四件事各 3 份实现（E14/E15/E17、L1/L2/E9、1702/1740/1777、1713/1749/1784）。
4. **约 76 行死代码 + 大量失效解构**（§5.8）仍在编译产物里，且它们**看起来**像在用（`handleCacheBook` 调 `handleCacheAll` 再调真 API），会持续误导下一个改造者。

### 7.5 拆分优先级建议（供负责人排期，**本轮不实施**）

| 优先级 | 切点 | 依据 | 风险 |
|---|---|---|---|
| P0（纯删） | 删 `handleSyncToLocal`/`handleCacheBook`/`handleCacheAll`/`handleCancelCache`/`localSyncing`/`localSyncProgress`/`localSyncAbortRef`/`cachePercent`/`settingsTab`/`clearPreload` 解构/`downloadChaptersToOffline` import；或**反过来**把「缓存统计」入口接上（`setOfflineStatsModal(true)`） | §5.8，全部 0 调用点 | 极低（要么删，要么补一颗按钮） |
| P1 | 把 6 个纯副作用 effect（1795/1800/1810/1832/1853/1870 + `remainingSeconds`）并入 `useReaderTts` | 与正文/分页零依赖 | 低；`useReaderTts` 已 369 行，可再拆 `useTtsSession` |
| P1 | 抽 `useReaderOverlays`：12 个布尔 → 一个 `overlay` 联合值 + 统一 open/close | 12 条独立 re-render 路径（§5.8） | 低 |
| P2 | 抽 `useReaderFlowWindow`：`flowHead/flowTail/flowKey/pendingPrependRef/pendingKeepRef/flowAdvanceRef` + E13 + `prependPreviousChapter` + L2/L4 | 这 6 个状态只有它们自己读写，边界清晰 | 中：跨章行为极易回归，需先补 e2e |
| P2 | 抽 `useReaderProgress`：`persist` + 3 个进度 effect + `currentRef`/`timerRef`/`restoredRef` + `readLogicalPosition` | 顺带修 §5.4/§5.5 的定时器与 currentRef 校验 | 中：动"进度"就等于动用户数据，必须补回归 |
| P3 | 抽 `useReaderImages`：`lightboxSrc/imageGeneration/failedImages/refetchChapterImage` + 提取 `renderContentBlock` 的图片分支 | 三个 state 全是"按图 URL 的键值表"，且有界性问题 | 低 |
| P3 | 把"有效章节判据"收成 `chapters/effectiveChapter.ts` 单函数，替换 6 处 | §6.4 | 低 |

---

## 8. 证据索引 + 未确认 + 覆盖率

### 8.1 读取记录与覆盖率

| 块 | 行区间 | 行数 | 状态 |
|---|---|---|---|
| 1 | 1–400 | 400 | ✅ 全文 |
| 2 | 401–800 | 400 | ✅ 全文 |
| 3 | 801–1200 | 400 | ✅ 全文 |
| 4 | 1201–1600 | 400 | ✅ 全文 |
| 5 | 1601–2000 | 400 | ✅ 全文 |
| 6 | 2001–2403 | 403 | ✅ 全文 |
| **合计** | **1–2403** | **2,403 / 2,403** | **覆盖率 100%** |

交叉核对文件（按任务允许的窗口）：`useReaderChapterContent.ts` **1–136 全读** · `ReaderOverlays.tsx` 1–238（props+12 弹层）· `ReaderBody.tsx` 1–120（props）· `ReaderChrome.tsx` 1–70（props）· `ReaderCatalog.tsx` 1–45（props）· `usePaginationMeasurement.ts`（节选 112–130 / 163–182）· `lib/api/domains/reader.ts`（端点 grep）· `lib/api/domains/search.ts`（端点 grep）· `lib/api/index.ts`（映射 grep）。

**行数/计数均用命令实测**：`wc -l`＝2403；`grep -c` 统计 `useState` 34 / `useRef` 35 / `useEffect` 27 / `useLayoutEffect` 4 / `useMemo` 9 / `useCallback` 20（均已扣除 import 行那一处 token）。

### 8.2 关键结论 → 证据行号索引

| 结论 | 证据 |
|---|---|
| state/effect/ref 实数 34/31(27+4)/35 | §1.1 逐条行号 |
| 12 个弹层开关全部由本文件持有 | 2357-2368；`ReaderOverlays.tsx:19-33`(dialogs 类型) |
| 主正文加载**有**取消保护 | `useReaderChapterContent.ts:89/93/113-115` |
| 3 处 URL 闸门 | 381/409/414/418 |
| 换源**无**任何闸门 | 1269-1326（尤其 1313 无条件写） |
| 接前一章**无**闸门 | 1626→1632 |
| 续接窗口与预载**可能重复请求** | 1407（只查 `preloadedContentRef`） vs `useReaderChapterContent.ts:67`（查两个集合） |
| 进度共 10 个写入触发点 | 1065/1133/1138/1702/1718-1723/1727/1736/1754-1759/1786-1791/2271 |
| `persist` 只信任 `currentRef` | 816-828；`currentRef` 只在 280 写 |
| 分页/漫画去抖定时器**卸载不清** | 1754-1759 / 1786-1791 无 cleanup；清理只在 1735 |
| `restoredRef` 永不复位 | 189/279，1313-1325 未重置 |
| `measurePagination` 依赖稳定、无死循环 | `usePaginationMeasurement.ts:174` 依赖 `[columnGap,columnMode,content,loading]`；`:119-120` 引用相等短路 |
| 子组件全部未 memo | `grep "memo("` 于 4 个展示组件 → 0 命中 |
| 5 处重复"有效章节"判据 | 1053-1058 / 1400-1404 / 1619-1621 / 719-725 / `useReaderChapterContent.ts:65` |
| 3 处 0.7/0.3 预载阈值 | 1713-1717 / 1749-1752 / 1784-1785 |
| 死代码清单 | 1192/1204/1218/1259/2234/633/163/164/165/296/299 |
| 缓存统计弹层不可达 | 161 声明、2380 只置 false，全仓无 `setOfflineStatsModal(true)` |
| 端点归属 | `search.ts:83/89/106`、`reader.ts:181/213/223/269/306/343/366/37/43/121/96/68`、`index.ts:196/202/230/274` |

### 8.3 未确认 / 需运行期验证（共 12 项）

| # | 事项 | 为什么未确认 | 建议复现步骤 |
|---|---|---|---|
| U1 | 重复请求 D1 是否真发生 | 需观测两个请求的实际时间窗（源码只能证明"没有去重闸门"） | DevTools Network 过滤 `books/content`：滚动模式读一本长书到 70%，观察同一 chapter url 是否出现 2 条 |
| U2 | 分页模式卸载后 1.2s 的 `reading-progress` 写入 | 需确认 React 卸载时 `timerRef` 真的未清（源码显示只有 E14 cleanup 清） | 分页模式翻一页 → **1.2 秒内**点返回 → Network 看是否仍有 POST |
| U3 | 慢网下"新章 fraction 记到旧章" | 取决于网络时长是否 > 1200ms | 用 DevTools 限速 Slow 3G，滚动跨章后立刻继续滚，查服务端进度记录 |
| U4 | `pendingPrependRef` 卡死导致往回翻失效 | 需确认 `settlePrependedPage` 的 5 个前提确实可能长期不满足 | 分页双栏：往回翻一次 → 接章未结账时用目录跳远端章 → 再往回翻 3 次 |
| U5 | `tocRuleOptions` 空表导致每轮重取 | 需后端在无自定义规则时返回空 `options` | 打开一本本地书（无自定义 txt 规则），看 Network `toc-rules` 次数 |
| U6 | E18(`[stopAllEngines]`) 是否每帧 stop | 取决于 `useReaderTts` 是否给稳定函数（本轮只读其签名，未读 369 行实现） | 朗读中打开 React DevTools Profiler，看 `stopAllEngines` 调用次数 |
| U7 | 简繁切换把阅读位置拉回存档位 | 取决于校验值是否仍匹配 | 滚动到章中 → 切简繁 → 观察是否跳回上次落库位置 |
| U8 | `pageIndex` 跨章瞬间落到旧页码 | 需真机时序 | 分页模式从 15 页的章跳到 3 页的章，观察首帧页码 |
| U9 | 每秒 `setRemainingSeconds` 造成的重渲染开销 | 需 profile | 长章节（>1000 段）开睡眠定时，看 FPS/Profiler commit 时长 |
| U10 | E11/E26 两个 `wheel` 监听的事件序 | `passive:true`(1161) 与 `passive:false`(2018) 同时挂 | Ctrl+滚轮在滚动模式下反复滚动，看是否偶发"翻章 + 变字号"同时发生 |
| U11 | `E16/E15` 双跑是否真的产生两次落库 | 去抖共用 `timerRef`，理论上被合并 | 分页模式单页翻动 20 次，数 `reading-progress` 请求数 |
| U12 | `sessionStorage['legado-open-book-v1']` 写入格式是否被上层正确消费 | 本文件只写（340/1325），读取在 `lib/openBook`（本轮未读，超范围） | 换源后刷新页面，看是否回到新书新章 |

### 8.4 本轮明确未做 / 超范围

- 未读 `useReaderTts.ts`(369) / `useReaderNotes.ts`(193) / `useReaderCacheStatus.ts`(139) / `useReaderPositionJump.ts`(120) / `usePaginationMeasurement.ts` 全文 —— 只在"本文件的读写点"处交叉核对，**它们内部的竞态/清理情况属 13b 其他审计员范围**。
- 未读 `settingsPanel/readerSettings.ts`(769) / `interaction/*` / `content/*` 纯函数实现 —— 只按本文件调用点核对口径。
- 未 build、未跑测试、未改任何源码、未建 commit（遵守本轮纪律）。
- 唯一写入：`E:\legadoQ\REBUILD_PLAN\_parts\13a_reader_screen.md`（本文件）。


---

# 附册 13b · 阅读器子系统与交叉审计


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

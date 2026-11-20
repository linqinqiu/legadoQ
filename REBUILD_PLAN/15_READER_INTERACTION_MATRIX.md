# 15 阅读器交互矩阵（Phase 0.5）

> 用途：供负责人评审"**每一类交互的判据在哪**"——即：如果重建时把这条交互改坏了，会不会有东西变红。
> 源码基线：`E:\legadoQ-archive\`（只读）。与 `13_READER_DEEP_AUDIT.md` 配套阅读：13 讲"代码怎么写的"，本册讲"改坏了谁会发现"。
>
> **读表口径**
> - 「现有测试覆盖」列写 `文件:行号` 的是**实际断言行**；写「无」= 没有任何判据会因这一条交互改坏而变红。
> - 缺口等级：**高** = 改坏时无判据会红、且用户可感知；**中** = 只有间接判据或"源码字符串断言"；**低** = 有行为判据。
> - 判据分级说明：本项目 139 个前端测试文件里，**88 份是"读源码文本"判据**（`grep` 式断言），能守架构与词表，但**天然覆盖不到运行时行为**——这类一律记为「间接」。

## 0. 汇总（先看这四个数字）

| 指标 | 数值 |
|---|---:|
| 矩阵行数（覆盖的交互类别） | 23 |
| 有行为判据的行 | 10 |
| **端到端有判据的行** | **0** |
| 缺口等级为「高」的行 | **4**（全部落在"进度"一条链上：进入阅读器/开书、进度保存·自动、进度保存·切章离开、恢复进度） |

> 这 4 行的共同点：**它们是用户最能感知的（"我上次读到哪"），却一条判据都没有**。任何重构只要碰 `persist()` 的调用点或恢复逻辑，都不会有测试变红。

---


> Phase 0.5「阅读器深读」· 审计员 deep-reader-subsystem
> 源码基线：`E:\legadoQ-archive\`（只读）
> 用途：供负责人评审"每一类交互的判据在哪"。有测试写 `测试文件:行号`，无测试写「无」并给缺口等级。

## 0. 状态

- [x] 骨架落盘
- [x] 矩阵表填充（23 行）
- [x] 缺口汇总（含 2 个新发现缺陷 + 3 条假绿判据）

## 1. 交互矩阵

> 路径前缀：前端 `product/web/src/`，后端 `product/app/src/main/kotlin/io/legado/`。
> "测试覆盖"列：`文件:行号` 为实际断言行；「无」= 没有任何判据会因这一条交互改坏而变红。
> 缺口等级：**高** = 改坏时无任何判据会红且用户可感知；**中** = 只有间接/源码字符串判据；**低** = 有行为判据。

| # | 交互类别 | 用户触发 | 入口 handler (file:line) | 状态迁移（前→后） | 涉及 state | 涉及 effect | 调用 API | 持久化点 | 失败路径与用户可见反馈 | 现有测试覆盖 | 判据缺口 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **进入阅读器 / 开书** | 书架点书 / 详情弹窗「开始阅读」 | `main.tsx:520-571` `openBookFromShelf`；渲染 `ReaderScreen` | 无阅读器 → `ReaderScreen` 挂载，`currentBook` 就位、章号= `resumeIdx` | `openReader` 入参、`currentBook`、`chapterIndex` | 目录+进度并行 `Promise.all`（`main.tsx:547-550`） | `POST /api/books/chapters`；`GET /api/reading-progress` | 无（只读） | 目录取不到 → `toast.error('无法打开《X》…')` 且**不进入阅读器**（`main.tsx:565-570`，注释说明"以前会伪造一章"）；进度取不到 → 静默降级用书架行（`:549` `.catch`） | `ReaderScreenSmoke.test.ts:47-58`（只渲染静态骨架） | **高**（"开书"整条链无端到端判据） |
| 2 | **章节切换 · 上一章** | 顶栏/底栏「上一章」、`←`、`PageUp`、点击上段 | `ReaderScreen.tsx:1131-1135` `goPrevChapter` → `changeChapter:1046`；键盘 `:1946-1950`；点按 `:2056-2063` | `chapterIndex: n → n-1`；滚动模式 `position→0` 或 `last`；分页 `targetInitialPageRef='last'` | `chapterIndex`, `flowKey`, `flowHead/flowTail=[]`, `loading=true` | 切章前 `persist()`（`:1065`）；`stopTts()`（`:1067`） | `POST /api/books/content` | `PUT /api/reading-progress`（切章前） | 首章 → `showBoundaryNotice('已是第一章')` 1.4s 气泡（`:1049`, `:1034-1040`） | `PageTurn.test.ts:21`（`planPrevPage`）；`:49`（接线源码断言）；`ReaderFlow.test.ts:114`（`prependLandingPage`） | **中**（边界提示、滚动 vs 分页双路径无判据） |
| 3 | **章节切换 · 下一章** | 「下一章」、`→`、`PageDown`/空格、滚到底再滚、点下段 | `goNextChapter:1136-1140`；键盘 `:1951-1955`；滚动触底 `:1147-1160`（1.2s 冷却 `:1156-1157`）；点按 `:2065-2072` | 同上反向；`flowAdvanceRef` 参与判定不重复跳 | 同上 | `persist()`（`:1065`，注意 `goNextChapter` 自己在 `:1138` 又调一次 → **两次 PUT**） | `POST /api/books/content` | `PUT /api/reading-progress` ×2 | 末章 → `showBoundaryNotice('已是最后一章')` | `PageTurn.test.ts:14`；`ReaderOptimization.test.ts:138`（70% 预载） | **中**；⚠ 双写见 §2.1 |
| 4 | **章节切换 · 目录跳转** | 目录抽屉点某一章 | `ReaderCatalog.tsx:140` `onSelect` → `onSelectChapter` → `ReaderScreen.tsx` 传入的 `changeChapter`（`:2374` 附近接线） | 任意 `n → m`；强制 `targetPage='first'`（`auto` 时 `:1075-1077`） | `chapterIndex`, `activeDrawer=null`（`:1086`）, `flowKey` 重挂（`:1096`） | 预载命中则零请求（`useReaderChapterContent.ts:100-102`） | `POST /api/books/content` | `PUT /api/reading-progress` | 卷头 `isVolume` 自动跳过（`:1056-1058`）；越界 → 气泡 | `VirtualChapterList.test.ts:24-192`（虚拟化算术）、`:231`（同 url 章节） | **中**（"点了哪一章就落在哪一章"无判据） |
| 5 | **翻页 · 滚动模式** | 滚轮 / 触摸滚动 / 点击上下段 / `PageUp/PageDown` | 滚动：`ReaderScreen.tsx:1668-1738` `onScroll`；点击 `:2138-2141` `zoneAt(settings.tapZones.scroll,…)`；键盘 `:1934-1945` | `scrollY` 变 → `current.position` 重算（`:1693` `sectionProgress`）；跨越已读章 → `flowAdvance` 顶窗口（`:1695-1705`） | `current.position`, `toolbarsVisible`（`:1679-1683`）, `chapterIndex`, `flowHead/Tail` | rAF 节流（`:1670-1673`）；`holdScroll` 校正（`:1430-1439`）；`persist` 1200ms（`:1718-1723`） | 无（纯本地滚动，70% 触发预载） | `PUT /api/reading-progress` | 无错误路径（滚动不会失败）；顶窗口失败时 `pendingKeepRef` 残留 → 下一帧画面偏移 | `ReaderFlow.test.ts:21-135`（12 条算术 + 反向对照） | **中**（算术有判据，"滚动→顶窗口→不跳"这条体感无判据） |
| 6 | **翻页 · 分页模式** | 左右轻扫 / 点两侧 / 滚轮一格 / `←→` | 触控 `ReaderScreen.tsx:2111-2143`（滑动 `:2124-2131`、点击 `:2133-2136`）；滚轮 `:2211-2232`（累计 `:2213`，冷却 140ms `:2229`）；页码 `goNextPage:1587` / `goPrevPage:1636` | `pageIndex: p → p±1`；末页 → 跨章 `{kind:'chapter'}`（`pageTurn.ts:30-39`）；cover 动画延迟提交（`useReaderPageTurn.ts:46-51`） | `pageIndex`, `coverTurn`, `fading`, `wheelAccumRef`, `pageCount` | 测量 `measurePagination`（`usePaginationMeasurement.ts:65`）；persist 1200ms（`:1754-1758`） | 无（页内）；跨章才请求 | `PUT /api/reading-progress` | 首/末页跨章失败 → `showBoundaryNotice`；`transitionend` 不来 → 600ms 兜底（`useReaderPageTurn.ts:60-64`） | `PageTurn.test.ts:14-49`；`ReaderPagination.test.ts:133-189`（布局+页码映射）；`ReaderFlow.test.ts:97-117` | **中** |
| 7 | **进度保存 · 自动（去抖）** | 停手 1.2s（滚动/翻页/漫画各自触发） | `ReaderScreen.tsx:1718-1723` / `:1754-1758` / `:1786-1790` → `persist():816` | `reading_progress` 行不变 → 覆盖为当前逻辑位置 | `currentRef.position`, `timerRef` | 三条 effect 共用一个 `timerRef` | `PUT /api/reading-progress` | `reading_progress`(10 列) + `book_shelf.last_read_at` | 失败**完全静默**（`:827` `.catch(()=>undefined)`）→ 用户不知道进度没存 | `api-client.test.ts:181-198`（**只测请求体字段裁剪**，不测何时发） | **高** |
| 8 | **进度保存 · 切章 / 离开** | 切章、返回键、切后台、关阅读器 | 切章 `:1065`；返回 `:2271`；`visibilitychange hidden` `:1726-1728`；卸载 cleanup `:1736` | 同上 | 同上 | 卸载时 effect cleanup 是**最后一次**保存 | 同上 | 同上 | 同上（静默）；若此时网络已断 → 进度丢失（离线队列是死代码，见 13b §4.4） | 无 | **高** |
| 9 | **恢复进度 · 重新打开** | 再次点开同一本书 | `main.tsx:547-564` 取 progress → `ReaderScreen.handleChapterLoaded:246-282` 建 `initialLogicalPositionRef` → 滚动 `:1425-1483` / 分页 `usePaginationMeasurement.ts:139-158` | 空屏 → 落到上次的段落（checksum 通过）或按比例（不通过） | `initialLogicalPositionRef`, `initialPagePositionRef`, `targetInitialPageRef`, `restoredRef` | 两个 `useLayoutEffect`（绘制前落点） | `GET /api/reading-progress` | 只读 | checksum 不匹配 → 静默退回比例坐标（`:1471`），用户看到"位置略偏"而非报错 | `LogicalPosition.test.ts:11-50`（算术）；`ReaderPagination.test.ts:189`（restore 映射）；**端到端无** | **高** |
| 10 | **阅读设置 · 字号/行距/字体** | 设置弹层滑杆、`+/-`、`Ctrl+滚轮` | `ReaderScreen.tsx:1919-1923` `bumpFontSize`；`ReaderSettingsSheet` → `TypographyTab` → `onChange` → `main.tsx` `setSettings` | `settings.fontSize` 变 → 分页重排 → `measurePagination` 重跑 | `settings`, `pageIndex`（测量会夹取，`readerFlow.ts:186-198`） | `:2010-2020` Ctrl+滚轮；`main.tsx:330-332` `saveReaderSettings` | 无 | `localStorage['legado-reader-settings-v2']` + `pushUiPref('reader-settings')`（`readerSettings.ts:758-762`） | `localStorage` 配额满/隐私模式 → 静默（`:763-765`）；字号越界 → `clampFontSize` 夹取 | `FontSizeControl.test.ts`、`ReaderTypography.test.ts`、`ReaderPagination.test.ts:80-131` | **低** |
| 11 | **阅读设置 · 背景/主题/简繁** | 颜色页选主题、背景库、简繁下拉 | `ColorTab.tsx`、`BackgroundLibrary.tsx`、`OtherSettingsPanel.tsx` → `onChange` → `main.tsx` | `settings.theme/readerBg*/scriptMode` 变 → 正文重新分段（`splitBody` 依赖 `convert`，`ReaderScreen.tsx:478-479`） | `settings`, `paragraphs`（简繁切换会整章重转） | 简繁字典 `loadScriptConverter()` 动态载入（`scriptConvert.ts`） | 无 | 同 #10 | 字典 chunk 载入失败 → 转换器退化为原文（`scriptConvert.ts` 注释）；`T` 键循环只在内置未隐藏皮肤（`:1974-1981`） | `CustomizeSkin.test.ts`、`ScriptConvert.test.ts`、`Wallpaper*.test.ts`、`SettingsSections.test.ts` | **低** |
| 12 | **目录打开与定位** | 点 `D` / 工具栏「目录」/ 点分区设为 toc | `ReaderScreen.tsx:1983-1986`（键盘）、`:2074-2076`（点按 `toc`）；渲染 `ReaderChrome` → `ReaderCatalog` | `activeDrawer: null → 'toc'`；目录滚到当前章并居中 | `activeDrawer` | `VirtualChapterList` 居中算术（`content/virtualSlice.ts`） | `POST /api/books/chapters`（如目录未取过） | 无 | 空目录 → 目录区空态；取目录失败 → 阅读器侧 `message` | `VirtualChapterList.test.ts:87`（居中）、`:248`（行高唯一来源 `TOC_ROW_HEIGHT`）、`TOCPerformanceScenario.test.ts` | **中**（"打开即定位当前章"无判据） |
| 13 | **书签增删** | 顶栏书签键 / 旧工具栏 / 笔记面板 | `ReaderScreen.tsx:642-670` `toggleBookmark` | 同一段落：有 → 删（`api.deleteNote`）；无 → 增（`api.addNote`，`bookmark:true`） | `notesApi.notes` | 位置取自 `readLogicalPosition`（`:644`，与进度同一算法） | `POST /api/notes` / `DELETE /api/notes/{id}` | `book_note` 表（`ReadingDao.kt:90/124`） | 未排版好 → `toast.warning('这一章还没排版好…')`（`:645`）；保存失败 → `toast.warning('书签没能保存')`（`:667`）；取消失败 → `'书签没能取消'`（`:649`）—— **三条路径都有用户可见反馈，是本矩阵里最完整的** | `Bookmark.test.ts:24-98`（判重/摘要/写入体/三处入口/跳转落点，共 7 条） | **低** |
| 14 | **笔记增删与锚定重定位** | 选中正文松手 → 标记条 → 划线/笔记；点已有高亮 | `useReaderNotes.ts:117-125` `onReaderMouseUp` → `buildSelectionDraft:75` → `saveNote:128` / `removeNote:154` / `openNote:181` | `noteDraft: null → {...}`；保存后 `notes` 追加/替换 | `notes`, `noteDraft`, `noteEditorOpen`, `notesPanel` | 正文变更 → `reanchorNotes`（`:47-50`，只改内存）；`setSelection` 同步给 AI 悬浮球（`:124`） | `POST/PUT/DELETE /api/notes*` | `book_note` 表；**重定位结果不落库** | 保存失败 → `created` 为 null **无提示**（`:136-140`，只在成功时 toast）→ **静默丢失**；删除失败无提示（`:157-158`） | `Note.test.ts:22`（源码断言）、`Reanchor.test.ts:22-80`（9 条纯函数）、`NoteExport.test.ts` | **中**；⚠ 保存失败静默 |
| 15 | **图片放大** | 点正文插图 | `ReaderScreen.tsx:967` / `:1010`（`onClick` → `setLightboxSrc(src)`）；渲染 `ReaderOverlays.tsx:192-196` | `lightboxSrc: null → url`；点遮罩/关闭键 → null（`:2385`） | `lightboxSrc` | 无 | 无（图已由 `/api/book/image` 代理） | 无 | 取图失败 → 该图位置显示错误行 + 「重取这一张」（`refetchChapterImage:448-461`，`failedImages`）；**放大层本身无错误路径** | `ReaderImage.test.ts`（地址算法 + "失败不许静默藏掉"） | **中**（放大层开/关/点穿无判据；`isInteractiveReaderTarget` 已被 `readerInteractions.ts:52-58` 修过"点图顺手翻页"） |
| 16 | **漫画双页** | 设置开启双页 + 宽屏 ≥720px；点两侧/滑动 | `ReaderScreen.tsx:526-531`（`mangaSpread`/`mangaStart`）；翻屏 `goNextPage/goPrevPage` 内漫画分支（`:1620-1643`） | `mangaIndex: i → 下一屏首张`；跨章 → `changeChapter(±1, 'last'/'first')` | `mangaIndex`, `mangaSpread`, `mangaTargetRef` | 换章落点 effect（`:605-624`）；进度上报（`:1777-1792`） | 无（图走代理） | `PUT /api/reading-progress`（偏移=首张所在段） | 末屏只剩一张 → `mangaNextStart` 返回 null → 换章；退回单页无提示（设计） | `MangaMode.test.ts:34-126`（9 条，含 rtl/末屏/角标/接线） | **低** |
| 17 | **TTS 播放与停止** | 工具栏「朗读」/ `M` / 悬浮条 | `useReaderTts.ts:286-304` `toggleTts` → `playTtsChunk:136`；停止 `stopTts:113`；切章停 `ReaderScreen.tsx:1067-1070` | `ttsActive: false→true`；`ttsPlayState: idle→playing→paused` | `ttsActive`, `ttsPlayState`, `currentChunkIndex`, `sleepTimer` | 换引擎/音色 effect（`:212-218`）；媒体章停朗读（`:120-122`）；章末自动续章（`:139-153`） | `POST /api/tts/session`、`/chunks`、`/control`、`/speak`（`domains/reader.ts:424-477`） | 跨章时 `persist()`（`:147/318/326`） | 离线 + 非系统语音 → 弹确认框改用系统语音（`:290-292`，`ReaderScreen.tsx:868-873`）；播放错误 → `toast.warning(err.message)` + `paused`（`:175-179`）；媒体章不响应（`:288`） | `tts.test.ts:5-68`、`TtsEngineSwitch.test.ts:70-174`、`TtsBarPosition.test.ts` | **中**（"读到哪句→高亮哪段→进度落哪"无端到端判据） |
| 18 | **正文加载失败与换源重试** | 正文取不到 → 错误区块「重新加载」/「换源」 | `useReaderChapterContent.ts:83-86` `reload`；`ReaderBody` `onRetryChapter`；换源 `ReaderScreen.tsx:1349-1364` `handleRecover` → `handleSwitchSource:1269` | `message: '' → 错误文案`；重试 → `reloadToken+1` 重跑加载；换源 → 换 `currentBook` | `message`, `reloadToken`, `showSourceSwitch`, `currentBook` | 重试**先删预取缓存**（`:84`），否则命中旧空值 | `POST /api/books/content`（不带 `force`）→ 失败再兜底 IndexedDB；换源 `POST /api/bookshelf/switch-source` | 换源：`book_shelf` 更新 + **旧书 `reading_progress` 被删**（`ShelfDao.kt:335`）；新书进度= `scrollPosition:0` 无 charOffset（`:1303-1310`） | 失败 → 错误区块 + 重试键（两处渲染分支都有，`ReaderReload.test.ts:18-24`）；换源失败 → `toast.error('换源失败')`（`:1361`）；目录空 → `'这个书源没取到目录，换一个试试'`（`:1357`） | `ReaderReload.test.ts`（3 条源码断言）、`RefreshChapters.test.ts:33-51`、`ReadThroughFixes.test.ts:83`（晚到响应）、`ShelfSourceFallback.test.ts` | **中**；⚠ **换源后进度归零且旧进度被删**，只有"章名匹配"保位置 |
| 19 | **离线缓存 · 下载** | 阅读器「离线缓存」/ 书架「缓存全本」/ 「离线同步」 | `ReaderScreen.tsx:1204-1216` `handleCacheAll`（服务端队列）；`:1218-1257` `handleSyncToLocal`（浏览器同步） | ①`cacheStatus.state: idle → caching`，3s 轮询（`useReaderCacheStatus.ts:118-124`）②`localSyncing: true`，进度 `{current,total}` | `cacheStatus`, `localSyncing`, `localSyncProgress`, `cachedChapterUrls` | caching → ready 时**只弹一次** toast（`useReaderCacheStatus.ts:92-99`） | `POST /api/bookshelf/cache`；或逐章 `POST /api/books/content` | `book_cache_status`；或 IndexedDB `chapters`（`offlineStorage.ts:98`） | 发起失败 → `toast.error`（`:1214`）；中断 → `'离线同步中断'`（`:1250`）；配额满 → LRU 整本淘汰别的书（`offlineStorage.ts:126-137`）；服务端缓存失败 → `toast.warning('《X》缓存中断：…')`（`useReaderCacheStatus.ts:96-98`） | `offline-pwa.test.ts:392`（缓存范围算术）、`:374-452`（统计/LRU/配额）、`SourceSwitchAndCache.test.ts` | **中**；⚠ **两套"离线缓存"共用文案**（见 13b §6.3），无判据区分 |
| 20 | **离线缓存 · 删除** | 「取消缓存」/ 离线缓存管理弹窗删除某书 | `ReaderScreen.tsx:1259-1265` `handleCancelCache`；`OfflineCacheModal.tsx:71` `clearOfflineBook` | `cacheStatus.state → failed('已取消缓存')`；IndexedDB 该书记录清空 | `cacheStatus` | 无 | `DELETE /api/bookshelf/cache`；IndexedDB 直删 | `book_cache_status` / IndexedDB | 失败 → `toast.error('无法取消缓存')`（`:1265`）；弹窗侧取不到统计 → "取失败不许画成你确实没有缓存"（`offline-pwa.test.ts:471`） | `offline-pwa.test.ts:302-339`（存取/队列）、`:523-548`（统计对账） | **中** |
| 21 | **段评浮层** | 右键菜单「段评」/ 标记条「段评」 | `ReaderScreen.tsx:2200-2204`（`setReviewsOpen(true)`）→ `reviews/ChapterReviewsDialog.tsx` | `reviewsOpen: false → true`；分页加载第一页 | `reviewsOpen` | 只读层，不写任何状态 | `POST /api/books/reviews`（`ReadingRoutes.kt:79-88`） | 无 | 书源没配规则 → 界面直说"这个书源没有段评"而非报错（`ChapterReviews.test.ts:167`）；失败 → 错误文案 + 重试键（`:90`），已读到的段评不清空（`:72`） | `ChapterReviews.test.ts:42-184`（11 条，覆盖最完整的一个弹层） | **低** |
| 22 | **搜索命中定位** | 本书检索结果点一条 | `useReaderPositionJump.ts:98-109` `jumpToSearchHit` → `jumpToNotePosition:48` | `bookSearchOpen: true→false`；`searchFlash` 高亮 6 秒后自清（`ReaderScreen.tsx:809-814`）；跨章则 `changeChapter(index,'first')` + `pendingNoteJumpRef` | `searchFlash`, `pendingNoteJumpRef`, `chapterIndex` | 落点 effect（`:112-117`，等正文进 DOM） | `GET /api/book-search`（`ReadersRoutes.kt:64-70`） | 跳转不写进度；但 `changeChapter` 会 `persist()` | 关键词为空/无命中 → 空态；`offset` 与正文不一致（AI 覆盖）时高亮会偏（`ReadingModels.kt:156` 注释自认） | `SearchJump.test.ts:43-59`（源码接线 + 5 条上限）；`LogicalPosition.test.ts:19` | **中** |
| 23 | **换源（手动）** | 目录顶栏「换源」 | `ReaderChrome.tsx:54/173` `onOpenSourceSwitch` → `ReaderOverlays.tsx:95` `SourceSwitchModal` → `ReaderScreen.tsx:2374` `onSwitchSource: handleSwitchSource` | `currentBook: 旧源 → 新源`；`preloadedContentRef.clear()`；朗读停（`:1315-1324`） | `currentBook`, `chapterIndex`, `flowKey`, `flowHead/Tail` | `sessionStorage['legado-open-book-v1']` 写入（`:1325`） | `POST /api/bookshelf/switch-source` | `book_shelf` 替换 + 旧 `reading_progress` 删除（`ShelfDao.kt:335`）+ `book_note` 归属留在旧书 | 详情/目录取不到 → 上层 `toast.error`；**新进度无 charOffset、scrollPosition=0** ⇒ 换源后必然从章首开始 | `ShelfSourceFallback.test.ts`（书架侧回退） | **中**；⚠ 进度语义在换源时整段丢失 |

### 1.1 矩阵统计

- **行数**：**23**
- **有行为（真·可执行）判据覆盖的行**：**10** 行 —— #10、#11、#13、#16、#19、#20、#21、#22（纯函数/弹层）、#5、#9（算术层）。若只算"覆盖这条交互端到端行为"的，则 **0 行**。
- **只有源码字符串/接线断言的行**：#2、#4、#12、#14、#17、#18
- **完全无判据（「无」）的行**：**#1、#7、#8**（三行全是"进度/开书"核心链）
- **缺口等级 = 高**：**#1 进入阅读器/开书、#7 进度保存·自动、#8 进度保存·切章离开、#9 恢复进度** —— **全部集中在"进度端到端"这一条链上**。
- **缺口等级 = 低**：5 行（#10、#11、#13、#16、#21）
- **缺口等级 = 中**：14 行

## 2. 判据缺口汇总

### 2.1 缺口集中在一条链上：**"进度"没有任何行为判据**

| 缺口 | 现状 | 后果 |
|---|---|---|
| `persist()` 何时被调用 | 11 个调用点，**0 条判据** | 删掉一个 `persist()`（例如 `:1736` 卸载清理）不会有任何测试变红，用户表现为"退出后进度回到上次切章处" |
| `PUT` 请求体里的语义位置 | 只有 `api-client.test.ts:181-198` 测"没传 position 就一个字段都不带、显式 0 仍要发" | 这只守住序列化，守不住"什么时候该带 position" |
| 恢复落点 | 只有 `offsetToParagraph`/`resolveMeasuredPage` 的算术判据 | "checksum 校验不过要退回比例"（`usePaginationMeasurement.ts:141`、`ReaderScreen.tsx:1463`）这条**闸门本身**无判据 |
| 端到端 | 无 | 无任何一条判据会"开一本书 → 翻几页 → 关闭 → 重开 → 断言落点" |

### 2.2 发现的两个新增缺陷（写入本矩阵时才暴露）

**缺陷 A：`goNextChapter` / `goPrevChapter` 会写两次进度**
`goNextChapter:1136-1140` 与 `goPrevChapter:1131-1135` 各自 `persist()` 一次，随后调 `changeChapter`，而 `changeChapter:1065` 又 `persist()` 一次。两次写的都是**切章前**的位置（`changeChapter` 在 `setChapterIndex` 之前调用），所以**内容相同、不是数据错误**，但是 2 倍的 `PUT` + 2 次 `readLogicalPosition`（每次都做一遍 DOM 测量 + `caretOffsetWithin`）。severity **低**（性能/日志噪音）。confirmed（三处代码逐行可读）。

**缺陷 B：笔记保存/删除失败是静默的**
`useReaderNotes.saveNote:132-140` 与 `removeNote:157-158` 都是 `await api.addNote(...).catch(() => null)`，`created` 为 null 时**不做任何提示**，随后照样 `setNoteDraft(null)` 关掉浮层（`:148-151`）。用户看到浮层关闭，以为存了。对比书签的 `toggleBookmark` 三条失败路径都有 `toast.warning`（`ReaderScreen.tsx:645/649/667`）—— **同一张表、两个入口，错误反馈口径不一致**。severity **中**。

### 2.3 假绿判据（会误导重建）

| 假绿 | 位置 | 问题 |
|---|---|---|
| 旧点击分区判据 | `ReaderPagination.test.ts`（16 处）+ `reader-interactions-settings.test.ts`（10 处）断言 `scrollTapZone`/`paginateTapZone`/`mobileTapZone` | 这三个函数在产品代码里**已无调用**（只剩 `ReaderScreen.tsx:2038` 一句注释），改产品分区行为它们不会红 |
| 离线进度队列判据 | `offline-pwa.test.ts:339` | 测的是"队列能进能出"，而**生产者 `enqueueOfflineProgress` 从未被调用**（`lib/offlineStorage.ts:447` 无调用者）—— 测了一条永远空的管子 |
| 阅读器冒烟 | `ReaderScreenSmoke.test.ts:47-58` | 用 `renderToStaticMarkup`，只渲染首帧骨架；一切"点了之后"的行为都不覆盖 |

### 2.4 §2 小结（给负责人的一句话）

**23 行交互里，5 行有低缺口（纯函数/弹层覆盖良好），14 行中等，4 行高 —— 而 4 行"高"全在"进度：开书 / 自动保存 / 离开保存 / 恢复"这一条链上。** 这条链恰好是用户唯一能感知"这软件靠不靠谱"的地方，也是本轮重建最先会被重写的地方。建议把"进度端到端"作为 0.5→1 阶段的第一条验收判据（脚本：开书→翻页→关闭→重开→断言 `charOffset` 落点一致），它能一次盖住矩阵里 4 行高危缺口。

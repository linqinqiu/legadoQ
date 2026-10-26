# 青阅阅读器 · 功能归档（v0.8.4 基线）

> 目的：把当前阅读器界面**已经有什么**逐项清点成档，作为重做的基线。
> 本文**只描述现状，不提改造建议**。改造方案另见 `docs/reader-redesign-plan.md`。
>
> 代码基线：`legado/web/src/reader/` 共 35 个文件约 6,200 行，核心 `ReaderScreen.tsx` 2,518 行。
> 服务：`http://127.0.0.1:1234` v0.8.4。所有 `文件:行` 为本次实测行号。

---

## 0. 文件清单（按体量）

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

## 1. 翻页（用户点名）

### 1.1 两种模式
- `pageMode: 'scroll' | 'paginate'`，默认 `scroll`（`readerSettings.ts:137`）
- 切换入口在设置面板「行为」页签

### 1.2 滚动模式
- 一次渲染「锚点章 + 续接的两章」，章间用一条细分隔线标示换章（`styles.css` 正文注释）
- `readerFlow.ts` 负责跨章续接：`flowAdvance` / `holdScroll`，`holdBack = 24px`
- 章节边界有 `break-before: column` 保证分栏流里每章从新栏开头（`measurePagination` 依赖它算每章占哪几页）

### 1.3 分页模式
- `PageSpan`（页区间）+ `pageAlignmentPads`（栏对齐）
- 栏数由视口宽度与 `--reader-max-width` 决定；`isDoubleColumnActive` 判据是视口 `>=800`
- 翻页动画 `pageAnim`：`slide`（默认，整条栏流滑过去）/ `fade` / `cover` / `none`，只在逐页翻（`|to-from|===1`）时生效
- 仿真卷页**未实现**（注释明说「要 canvas 逐帧重画，先不承诺」，但值域留好了）

### 1.4 滚轮翻页
- `readerInteractions.ts` 的 `paginateWheelStep`：累计 delta，固定步长 `step=48px`
- 滚轮在分页模式下翻页、滚动模式下滚动

---

## 2. 固定 / 钉住（用户点名）

- `sidebarPinned: boolean`（默认 `false`，`readerSettings.ts:142`）
- 钉住时目录抽屉常驻左侧，正文让位；未钉住时抽屉是浮层，带 `translateX` 进出动画
- `sidebarWidth: number`（默认 300，范围 220–560）—— 目录与正文的边界**可左右拖**
  （`ReaderScreen.tsx` 的 `reader-sidebar-resizer`，CSS z-index 22）
- 钉住时抽屉 z-index 从 30 降到 21（刻意：钉住时它在正文内，不是浮层）
- 顶栏 / 底栏显隐：`.reader-workspace.toolbars-hidden` 类控制，阅读中自动隐藏、点正文唤出

---

## 3. 缓存（用户点名）

- 数据来自 `GET /api/bookshelf` 的 `cachedChapters` / `totalChapters` / `cacheState` / `cacheError` / `tocUpdatedAt`
- `cacheState`: `idle` / `caching` / `done` / `error`
- 书架卡片显示「缓存 N / M 章」，失败显示「中断：<原因>」
- 目录抽屉页脚有「离线缓存 · 这本书」折叠区，默认收起（只露一行）
- `VirtualChapterList.tsx` 里已缓存的章节有 `.cached` 徽标
- 书架页有批量管理（批量删除 / 移组 / 标已读）

---

## 4. 排版设置（`readerSettings.ts` 478 行）

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

## 5. 点击区域（手势）

- `TapMap = { x: number[]; y: number[]; actions: TapAction[] }` —— **虚线表**，两种翻页方式各一张
- `TapAction`：`previous` / `next` / `toggle` / `toc` / `settings` / `none`
- `MIN_CUT_GAP = 0.04`（切割线最小间距）、`MAX_CUTS = 5`（最多 5 条）
- `TAP_PRESETS` 提供若干预设方案
- `TapZoneEditor.tsx` 是可视化编辑器：横竖虚线可拖，实时预览
- 旧版「格子表」（`{rows,cols,actions}`）读时自动迁成虚线表
- 判定：`zoneAt(map, px, py, w, h)`

---

## 6. 朗读

### 6.1 三种引擎（`ttsEngine: 'edge' | 'webSpeech' | 'custom'`）
- `edge`：Edge TTS（默认）
- `webSpeech`：浏览器 Web Speech API
- `custom`：自定义 HTTP 源（url / method / body / header / voice 各自独立）

### 6.2 音色与参数
- `ttsVoice` / `ttsSpeed`(0.5–3.0) / `ttsPitch`(0.5–1.5)
- 自定义引擎用独立的 `ttsCustomVoice`（**刻意不共用** `ttsVoice`，避免把 Edge 音色 id 发给用户自己的服务）

### 6.3 行为
- `ttsAutoNextChapter`：跨章连播（默认开）
- `ttsFilterSymbols`：滤掉装饰符号
- `TtsSettingsModal.tsx` 是设置入口

### 6.4 悬浮条
- `TtsPlayerBar.tsx` + `ttsBarPosition.ts`：长按 250ms + 9px 容差触发拖动
- 位置持久化 `legado-tts-bar-pos`，重置键 `legado-tts-bar-reset`
- 挂载时夹回视口（`useClampOverlay`）

### 6.5 会话
- `ttsEngine.ts` 的 `sessionSettingsKey` 与 `readerSettings.ts` 的 `ttsSessionKey` 是同一件事的两个名字 —— 任一項变，正在播的音频流推倒重来（防两条声音叠在一起）

---

## 7. 笔记 / 划线

- `NoteToolbar.tsx`：选中正文后弹出，写备注（留空即纯划线）、保存 / 删除 / 取消
- `NoteDraft`：id / chapterIndex / chapterUrl / startOffset / endOffset / excerpt / text / x / y
- 偏移是**章节内字符偏移**（不是像素/列号）—— 字号分栏一改位置就跳，这是老教训
- `NotesPanel.tsx`：这本书的全部划线，点一条跳到那一章
- `noteExport.ts`（新增）：导出 Markdown，原文进引用块、备注跟在下面，章名取不到退回「第 N 章」
- **选区已与 AI 打通**：`lib/selectionStore.ts` 把选区提到组件外，AI 悬浮球读得到「你选了哪段」

---

## 8. 目录

- `VirtualChapterList.tsx`：虚拟滚动（`virtualSlice.ts` 切片），大目录不卡
- `TocDrawerHeader.tsx`：目录抽屉头，含**倒序开关**与**钉住开关**
- 章节搜索框
- 已缓存章节有徽标
- 抽屉页脚「离线缓存 · 这本书」折叠区

---

## 9. 简繁转换

- `scriptMode: 'off' | 's2t' | 't2s'`，只换字形不换词
- 词典在 `scriptConvert.ts`，约 200KB，**开了才载**，默认不进首屏
- 正文与章名一起转（只转正文会出现「标题简体、正文繁体」）

---

## 10. 媒体

- `MediaBlock.tsx`：音频 / 视频 / 漫画逐图
- `contentImages.ts` / `readerImage.ts`：正文配图加载、点击放大、取失败的兜底行
- 漫画源（`bookSourceType=2`）走图片代理
- `mediaUrl` 非空时渲染播放器而不是把地址当正文排出来

---

## 11. 快捷键

- `shortcuts.ts`：`READER_SHORTCUTS` / `GLOBAL_SHORTCUTS` / `SHORTCUT_TABLES`
- `normalizeKey` / `isTypingTarget` / `shortcutFor`
- `?` 打开速查表（`ShortcutHelp.tsx`）
- **键位硬编码，不可自定义**

---

## 12. 进度

- `readerProgress.ts`：滚动位置归一化 `scrollPosition(scrollTop, scrollHeight, clientHeight)`
- 章节内进度 + 章进度，节流后上报 `POST /api/reading-progress`
- 底部进度条 `chapter-progress` / `chapter-scrub`（可拖）
- 阅读记录按「一天 · 一本书」累加秒数（`reading_log` 表）

---

## 13. 界面骨架

- `ReaderHeader.tsx`：顶栏（返回 / 书名 / 更多）
- `Md3Chrome.tsx`：MD3 风格件 + `Md3BottomBar` / `Md3TopBar`
- `ReaderSheet.tsx`：底部弹层
- `ReaderContentSkeleton.tsx`：正文骨架屏
- 桌面端：`.reading-content` 宽 `min(var(--reader-max-width), calc(100% - pad*2))`、`margin: 0 auto` 居中
- 移动端：`.mobile-reader-nav` 仅 `max-width:720px` 显示；`.desktop-pin-btn` / `.desktop-reverse-btn` 仅 `min-width:721px` 显示

---

## 14. 阅读器与 AI 的接合

- `main.tsx` 的阅读器分支**也挂了** `<AiFloatingBall uiContext={currentUiContext} />`（0.8.5 修）
- `uiContext` 在阅读器里带：`book{sourceId, bookUrl, name, author, chapterIndex, chapterTitle}` + `selection{text, fullLength, chapterIndex, chapterTitle}`
- 面板上显示「正在看：《书名》第 N 章 · 选中的 N 字」，鼠标悬停可见选中原文

---

## 15. 读代码时发现的粗糙处（只记录，不评判）

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

## 16. 一页总览

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

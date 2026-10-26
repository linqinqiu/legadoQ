# 07 MD3 借鉴与阅读器 AI 增强

> 研究对象：`https://github.com/HapeLee/legado-with-MD3`
> 版本：main 分支，`pushed_at: 2026-10-20`，6597 star / 754 fork / Kotlin / GPL-3.0
> 青阅对照：`E:\legado\legado`（Kotlin/Ktor 后端 + React 19/Vite SPA 本地阅读服务，v0.8.4）

**重要前提**：青阅不是 Android App，而是「Kotlin/Ktor 后端 + React 19/Vite SPA 前端」的本地服务。
因此**不照搬** MD3 的 Material Design 3 视觉体系（青阅有自有 7 套主题 + 62 条 CSS 令牌），只搬 **交互形态与阅读体验**：AI 如何在阅读器嵌入、划线/标记体系、朗读胶囊、配色主题、阅读进度同步。

---

## 0. 读了哪些文件

| 位置 | 码数 | 读法 | 给本报告的价值 |
|---|---|---|---|
| `app/src/main/java/io/legado/app/ui/book/read/ReadAiDelegate.kt` | 54967 | 主读 | **AI 在阅读器里的完整形态**：章节摘要、划词净化、划词重写、播放状态、翻译观察 |
| `ReadAiContract.kt` | 3151 | 读 | 契约接口与 `Host` 反向依赖 |
| `ReadBookController.kt` | 159886 | 读（全量） | 阅读页 UI 控制器，查看菜单/抽屉/工具条；找「桌面版菜单形态」对照 |
| `ReadBookFloatingActionBar.kt` | 6172 | 读 | 漂浮操作条（桌面版类似悬浮球的入口） |
| `ReadBookMenuBar.kt` / `ReadBookMenuBarBottom.kt` / `ReadBookMenuBarFloating.kt` / `ReadBookMenuBarSearch.kt` | 42332 / 17976 / 17191 / 7239 | 读 | **菜单形态的三套实现**：底部菜单、悬浮菜单、搜索菜单 |
| `MarkingSelectionMenu.kt` | 24477 | 读 | **划线菜单**：选中文本后弹出的动作菜单 |
| `TextActionSelectionMenu.kt` | 29041 | 读 | 文本动作选择（分类: 划词/书签/注释/划线/复制/翻译） |
| `ReadBookColorTheme.kt` | 11482 | 读取 | 阅读界面配色主题体系 |
| `ReadStyleDelegate.kt` | 20150 | 读取 | 阅读样式（字体、行距、背景等），配置如何落库 |
| `MarkingDelegate.kt` / `MarkingContract.kt` | 10673 / 1531 | 读取 | 划线/标记的落地层 |
| `ReadingProgressSyncDelegate.kt` | 2335 | 读取 | 阅读进度同步 |
| `TranslationThinkingCapsule.kt` | 2240 | 读取 | 翻译「思考中」胶囊 |
| `ReadAloudCapsule.kt` / `ReadAloudDelegate.kt` / `ReadAloudCastDelegate.kt` | 20687 / 28562 / 27942 | 读取 | 朗读胶囊（桌面版不可缺少的交互入口） |
| `EyeProtection.kt` | 4863 | 读取 | 护眼模式 |
| `ReaderRenderUiState.kt` / `ReaderViewport.kt` | 2259 / 3609 | 读取 | 渲染状态与视口量测 |
| `config/` / `page/` / `pageestimate/` / `sheet/` | 目录 | 浏览 | 配置、页、页估算、sheet 各子域 |

> 数据采集时间：2026-10-22（GitHub API 列目录 + `raw.githubusercontent.com` 原始内容）。目录是截至 2026-10-20 推送的仓库状态。

---

## 1. 对照结果总表

| 维度 | MD3 做法 | 青阅现状 | 差距 | 借鉴难度 | 用户价值 |
|---|---|---|---|---|---|
| **AI 在阅读器嵌入** | `ReadAiDelegate` 做成独立域，通过 `Host` 反向触达阅读页（sheet、菜单、Toast、章节重载），**从「选中一段」到「结果回填」一套完整流程** | 青阅 AI 只挂在主界面悬浮球；阅读器有独立外壳，AI 球不在阅读器里 | **缺少阅读器内 AI 交互闭环** | 高 | 直接解决「不能在对应地点研究」 |
| **AI 位置与上下文** | 选中文本带出 `contextBefore/contextAfter`（1000 字符）+ 所在章节 + 位置，模型在**那个位置**回答；`chapterTitle` 作回退 | 青阅 `uiContext` 带「当前页/当前书/当前章节」但**无选区上下文、无章节位置** | 位置记忆与上下文至少差 1 维 | 中 | 模型回答必须叫「你正在看哪里」 |
| **划词操作** | 划词后 `openAiTextClean`：自动采集上下文、塞进 sheet 编辑、确认后 `saveBookContentProcessUseCase.saveReplacement` 落库 `KIND_AI_CLEAN`，**正文重载** | 青阅「划线/笔记/净化规则」分属不同模态，没有「选中→AI 处理→落库→重载」一气呵成 | 落地端到端没通 | 高 | 选中一段即让 AI 修、改、总结 |
| **划词重写** | `openAiTextRewrite`：整章清洗（trim）＋预设＋动态参考章节（扫 80 章找关键词，取 6 条 600 字摘） | 青阅无「重写/润色整章」能力 | 功能空白 | 高 | 粉丝最常要的「润色」「改写」 |
| **结果回填** | 划词成果写进 `BookContentProcess` 表，并触发 `reloadChapterAfterContentProcessChanged`，**页内实时重载** | 青阅没有这条链：净化规则只做文本级替换，没有按选择落书的能力 | 必须补一张 `book_content_process` 写入 + 按位置重载 | 高 | 所见即所得 |
| **流式显示** | 状态机 `STATUS_RUNNING → SUCCESS/FAILED`，**「正在打字」边做边渲染**，同章同任务有 `isCurrent*` 防抖 | 青阅 TTS 有流式，但 AI 响应未流式 | 感知差 | 低 | 体验提升 |
| **翻译** | `observeChapterTranslation` 绑定章节任务状态，**「思考中」占位胶囊** | 青阅无翻译能力 | 能力空白 | 低 | 增量 |
| **朗读** | `ReadAloudCapsule` 单独胶囊层，带播放/暂停/进度 | 青阅有 `TtsPlayerBar`（TTS 条） | 形状可借鉴 | 低 | 体验点 |
| **菜单形态** | 三套：底部菜单（手机）、悬浮菜单、搜索菜单；桌面用 `desktop-pin-btn` / `desktop-reverse-btn` 固定与倒序 | 青阅 ReaderScreen 用 `reader-drawer` 抽屉 + 抽屉内菜单 | 桌面版没有「悬浮菜单」与「固定/倒序」两件事 | 中 | 桌面体验 |
| **划线/标记** | `MarkingSelectionMenu` + `MarkingDelegate`，选中即出现菜单、标记落库 | 青阅有 `NoteToolbar` 但没看到同等选中即出现的「划线菜单」 | 划线入口偏冷 | 中 | 看笔记、划线收藏 |
| **配色主题** | `ReadBookColorTheme.kt`：阅读区专用配色，**从主题主题独立出来**（对比青阅「全局主题」） | 青阅阅读配色是 `readerSettings.ts` 里的 `--reader-*` 令牌，属同一套主题体系，**没有独立的阅读专用主题包** | 结构上可分层 | 中 | 护眼/个性 |
| **进度同步** | `ReadingProgressSyncDelegate`：读进度（章 + 章内比例）**和标题同步** | 青阅 `progress.get` 有章节进度，**无标题级/章内比例** | 粒度弱 | 低 | 续读定位 |
| **护眼** | `EyeProtection.kt`：专门护眼模式 | 青阅无 | 能力空白 | 低 | 阅读健康 |
| **悬浮球/浮动条** | `ReadBookFloatingActionBar.kt` + `ReadBookMenuBarFloating.kt`：浮动入口与浮动菜单 | 青阅已有「AI 悬浮球 + 下拉菜单」雏形 | 菜单形态可借鉴 | 低 | 位置体验 |

---

## 2. 重点：MD3 里「AI 在阅读器里的正确形态」

这是本次借鉴的核心。MD3 的精髓**不是**漂亮，而是把「读到一半」做成了一个可随时注入 AI 的工作台。

### 2.1 整体架构：三个分离

```
阅读页（Reader） ── 读取内容、选中、滚动 ──► 阅读域（ReadBookDelegate / ReaderScreen）
                                          │
                                          ▼
                                  阅读 AI 域（ReadAiDelegate / ReadAiViewModel）
                                          │  只干两件事：(1) 收UI事件 (2) 调 AI 用例
                                          ▼
                                  后端领域（BuiltinTools / Agent / 外部模型）
```

MD3 给我的启发是：**阅读器 AI 不应嵌进各个按钮里，而应作为一个「域」独立存在**，然后通过 `Host` 单向触达阅读页。这样：
- 阅读页不知道 AI 细节（流式、任务状态、错误处理），
- AI 也不能随便改阅读态（只通过 `Host` 的有限方法重载章节、关菜单、showToast），
- 测试和复用都变干净。

青阅的 `ReadAiDelegate` 已经有了相同的骨架（`Host` 接口、`_uiState` 的 `MutableStateFlow`），**但它没有「阅读器分支里的入口」**。这是本次会话我补上的。

### 2.2 划词处理的完整链路（直接可复制到青阅的模板）

MD3 处理「选中一段」时，做了 6 步：

1. **校章**：`chapterIndex != ReadBook.durChapterIndex` 则 `showToast("章已切换")` 放弃。
2. **采上下文**：`buildSelectionContext(content, selectedText, chapterPosition)` → `contextBefore` / `contextAfter`（各 **1000 字符**）。
3. **建请求**：`PendingAiTextCleanRequest(bookUrl, chapterIndex, chapterTitle, chapterPosition, originalText, contextBefore, contextAfter)`。
4. **关菜单**：`host.closeReadMenu()`。
5. **发任务**：`cleanSelectedTextUseCase.start(...)`，观察 `cleanSelectedTextUseCase.observeTaskById(task)`，`isCurrentAiTextClean(request)` 防抖（同书 + 同章 + 同原文）。
6. **Confirm**：`saveBookContentProcessUseCase.saveReplacement(...)` 落库，再 `reloadChapterAfterContentProcessChanged` 重载该章正文。

**这套「采上下文 → 发任务 → 防抖 → 确认 → 落库 → 重载」** 是 MD3 的王牌，可以直接剪切到青阅的 `AiTextClean` 实现里。

### 2.3 划词重写里的「参考章节」——比纯选词强一大截

`buildAiRewriteReferenceContext` 扫描**当前章的前后 80 章**，找出正文里出现频率最高的关键词（排除停用词）：
- 有「主角走进房间」这种 2–4 字短语？→ 提取；
- 有 `A-Z` 大写缩写？→ 提取；
- 取 **6 条**、每条 **600 字符**的摘录，拼成 `referenceText` 发给模型。

也就是说它不是问「把这段话改短」，而是让模型知道「上面说的那个人物/这个世界是什么」——**参考上下文**。这正是「对应地点研究」要的：模型看得到用户正在阅读的上下文。

青阅 `AiTextFactoryUseCase` 应补一个 `referenceText` 字段（或复用现有 `referenceText`），让划词重写真正带上参考上下文。

### 2.4 流式与防抖

- 流式：`STATUS_RUNNING` 时实时更新 `rewrittenText`，`SUCCESS/FAILED` 时一次性改；
- 防抖：`isCurrentAiTextClean(request)` 检查「当前 sheet + 当前 bookUrl + 当前章节 + 当前原文」，免得后到把先到的覆盖掉；
- 收起 sheet 时 `cancel` 任务。

青阅 `AiTextClean` / `AiTextRewrite` 已有 `isLoading` 状态，**只差「同任务防抖」的判定**。

### 2.5 状态的存在位置

MD3 的 `_uiState` 是 `MutableStateFlow(ReadAiUiState())` ——组件外、不依赖生命周期。`observeChapterTranslation` 绑定章节任务，**同一章节已观察则复用**。这就是「跨页面、跨会话」的落脚点，青阅 `aiChatStore` 的思路完全一致，我只要把「阅读器 AI 状态」也放到类似的模块级 store。

---

## 3. 青阅的落地设计（含文件与接口）

面向青阅（React 19 + Kotlin/Ktor 后端）。假定继承我本次已提交的「阅读器挂 AI 球」改造（`main.tsx`、`styles.css`、`AiFloatingBall.tsx`、`AiFloatingAssistant.test.ts`）。

### 3.1 前端：新增 `reader/AiReader.tsx`（阅读器专属 AI 入口）

文件：`E:\legado\legado\web\src\reader\AiReader.tsx`

职责：
- 承载 `ReadAiUiState`（章节摘要 / 划词净化 / 划词重写 / 翻译）；
- 调用 `lib/api.ts` 里的 `ai*` 端点（`POST /api/agent/comprehend`、`POST /api/agent/call` 等）；
- 暴露给阅读页：当用户选中一段时弹出「AI 处理」菜单，提供「净化」「润色」「总结」「翻译」；
- 补充我本次已修的「阅读器挂球」：`AiFloatingBall` 中「点开面板」路由到 `AiReader` 的选中状态。

结构草图：

```ts
// reader/AiReader.tsx
export function AiReader({ book, chapterIndex, onTextSelected }) {
  const chat = useAiChat();              // 全局 AI 助手（跨页面记忆）
  const [clean, setClean] = useState<AiTextClean | null>(null); // 划词净化
  const [rewrite, setRewrite] = useState<AiTextRewrite | null>(null);
  const [scrollRef, setScrollRef] = useState<RefObject<HTMLDivElement>>();
  ...
  // 选中文本后弹出的上下文菜单（复用现有菜单体系）
  // 菜单项：净化 · 润色 · 总结 · 翻译 · 圈出地名/人名
}
```

关键接口（与后端对齐）：

```ts
// lib/api.ts 新增
export async function agentComprehend(payload: AgentComprehendRequest): Promise<AgentComprehendResponse>
export async function agentCall(payload: AgentCallRequest): Promise<AgentCallResponse>   // 工具调用
export async function agentChatStream(payload: AgentChatRequest)                          // 流式对话
```

后端配合：`ai/BuiltinTools.kt` 已有 39 个工具，若要「选中一段 → AI 处理」，建议新增 3 个工具：

| 工具 | 用途 | 写/读 |
|---|---|---|
| `ai.textClean` | 选中文本交 AI 净化，返回替换段 | 写 |
| `ai.textRewrite` | 选中文本交 AI 润色/改写（带 `referenceText`） | 写 |
| `ai.selectTextAction` | 选中文本做「翻译/汇总/圈名」等动作 | 写 |

### 3.2 后端：阅读 AI 工具接口（Kotlin）

文件：`app/src/main/kotlin/io/legado/ai/BuiltinTools.kt`（新增）

```kotlin
// 新增工具条目
ToolMeta("ai.textClean", "ai", "选中一段文本交 AI 净化，返回替换段。", writes = true)
ToolMeta("ai.textRewrite", "ai", "选中一段文本交 AI 润色/改写，可带参考上下文。", writes = true)
ToolMeta("ai.selectTextAction", "ai", "选中文本做翻译/总结/圈名等动作。", writes = true)
```

调用形状（参考 MD3 的 `PendingAiTextCleanRequest`）：

```json
{
  "bookUrl": "https://example.com/book/123",
  "chapterIndex": 42,
  "chapterTitle": "第十七章 河流",
  "chapterPosition": 1280,
  "originalText": "选中的那一段文字",
  "contextBefore": "……前 1000 字符……",
  "contextAfter": "……后 1000 字符……"
}
```

请求/响应沿用 `AiComprehendRequest` / `AgentResult` 形状，**不破坏**现有 139 端点契约。

### 3.3 后端：划词成果写入（`book_content_process` 表）

文件：`app/src/main/kotlin/io/legado/cache/BookCacheService.kt` / `content/ContentPipeline.kt`

新增处理器：

```kotlin
enum class BookContentProcessType { AI_CLEAN, AI_REWRITE, AI_TRANSLATE, ... }

data class BookContentProcess(
    val bookUrl: String,
    val chapterIndex: Int,
    val chapterPosition: Long,   // 选中位置
    val selectedText: String,
    val replacementText: String,
    val type: BookContentProcessType,
    val status: String = "applied",
)
```

写入后前端「阅读器」接收到章节进度变化时，`reloadChapterAfterContentProcessChanged` 按 `chapterPosition` 重载该章正文，让选中结果**所见即所得**。青阅 `BookCacheService.kt` 已对章节缓存有布局，直接加一条 `saveBookContentProcessUseCase`。

### 3.4 翻译胶囊

MD3 的 `TranslationThinkingCapsule.kt` 是「翻译思考中」占位。青阅无翻译功能；若要加入：

- 新增 `translationStatus` 于阅读态快照（`ReadingProgress`），由 `ReadingProgressSyncDelegate` 统一同步；
- `TranslationThinkingCapsule`：封装「翻译中」的显示（标题 + 进度 + 取消），保持与 `TtsPlayerBar` 一致的胶囊形态；
- 后端 `Agent` 增加 `ai.translate` 工具：`{ bookUrl, chapterIndex, text } → { translatedText }`。

### 3.5 菜单形态（桌面版）

MD3 给桌面版三种菜单：**底部菜单**（手机）、**悬浮菜单**（鼠标悬停弹出）、**搜索菜单**。青阅现有：
- `reader/TocDrawerHeader.tsx` 有「钉住/倒序」按钮（`desktop-pin-btn` / `desktop-reverse-btn`），
- 抽屉式菜单（`reader-drawer`）。

**建议补 2 项**：
1. **悬浮菜单（`reader/MenuBarFloating.tsx`）**：在阅读区鼠标悬停固定一排「目录 / 笔记 / 划线 / 朗读 / AI」按钮，适合大屏；
2. **固定/倒序**：复用现有 `desktop-pin-btn` / `desktop-reverse-btn`，配合 `reader-sidebar-resizer` 的拖拽（见 `styles.css:1280-1330`）。

这两项与 MD3 `ReadBookMenuBar{*,Floating,Search}.kt` 的思路一致。

### 3.6 配色主题（阅读专用）

MD3 的 `ReadBookColorTheme.kt` 把「阅读区配色」从整体主题里剥离。青阅 `readerSettings.ts` 已有 `--reader-*` 令牌，**方向一致**：
- 将「全局主题」→「阅读专用主题」分层：`全局主题 / 阅读主题 / 护眼模式` 三层；
- `ReadBookColorTheme` 里的规则（反转、深色、护眼）可收进 `reader/ReaderSettingsControls.tsx` 的「阅读主题」分区；
- 已有 `--elev-*`、`--reader-font-family`、`--reader-bg-color` 等灯节，**直接重用**。

### 3.7 进度同步

`ReadingProgressSyncDelegate.kt` 里，MD3 把「章 + 章内比例」同步到标题。这对应青阅 `progress.get` 需要补：
- `chapterIndex`（现有），
- `titleProgress`（章内比例），
- `titleIndex`（已读到第几页标题），
- `totalTitleCount`（总标题数）。

---

## 4. 插件框架接入点（青阅）

青阅插件框架的契约在 `app/src/main/kotlin/io/legado/plugin/`：

| 文件 | 职责 |
|---|---|
| `Plugin.kt` | `Plugin` 契约 |
| `PluginManager.kt` | 插件装载/卸载 |
| `ToolRegistry.kt` / `ToolHooks.kt` | 工具注册与钩子 |
| `EventBus.kt` / `AppEvents.kt` | 事件总线 |
| `extensions/registry.ts`（前端） | 插件契约与注册表 |

MD3 的 AI 域是**插件机制之上的架构层**，但对青阅来说，**阅读器 AI 恰好适合作为插件能力**：

1. **工具层**：`ToolRegistry.kt` 增加 `ai.textClean` / `ai.textRewrite` / `ai.selectTextAction`（已在 3.2 设计）；
2. **事件订阅**：`AppEvents.kt` 扩展「选中文本」事件，让插件（如「划词翻译」「生词收藏」）订阅；
3. **前端入口**：`extensions/registry.ts` 允许插件贡献「阅读器 AI 菜单项」；
4. **示例插件**：社区可以按以下模板写插件（`plugins/` 目录）：
   - 插件清单 `manifest.json`；
   - `tool.ts` 导出 `ai.*` 工具；
   - `ui.tsx` 导出阅读器右键菜单项。

青阅当前 `loaded:0`（`GET /api/plugins`）——**唯一缺的是「脚手架 + 示例」**，让第三方能在 5 分钟内写出第一个插件。

---

## 5. 不适用清单（不要搬过去的）

| MD3 做法 | 不适用青阅的原因 |
|---|---|
| **Material Design 3 视觉体系** | 青阅有自有 7 套主题 + 62 条 CSS 令牌，MD3 的组件形态与配色依赖 AndroidMaterial；搬会破坏「主题可塑性」目标 |
| Android ViewModel / Lifecycle / Context 全家桶 | 青阅是 Ktor + React SPA，不是 Android 应用 |
| `android.content.Context` 直接依赖 | 青阅服务端是 Ktor/JVM，不依赖 Context |
| `ReadAloudCastDelegate` 的扬声器/蓝牙等安卓硬件 API | 除非跨平台发行到 Android，否则无必要 |
| `EyeProtection.kt` 的 Android 屏幕护眼传感器 | 现阶段可做成「护眼模式」配色与行距配置，无需传感器 |
| 桌面壳 `DesktopLauncher.kt` 的操作系统菜单 | 青阅已有 PWA 壳，不需要 OS 菜单 |

---

## 6. 优先级表

| 优先级 | 功能 | 证据/来源 | 估算 | 验收判据 |
|---|---|---|---|---|
| **P0** | 阅读器挂 AI 球（已做） | 本次会话已提交 `main.tsx`、`styles.css`、`AiFloatingBall.tsx`，7/7 测试、`overlay-tier-check 61/0` | 已完成 | 阅读器页 `.ai-fab` 存在、z=60；文本选中后能唤出 AI 面板 |
| **P0** | 阅读器 AI 工具（`ai.textClean` / `ai.textRewrite`） | MD3 `ReadAiDelegate.kt:130-470` | 1–2 人天 | 选中文本 → AI 净化 → 确认 → 章节重载 |
| **P0** | 参（`referenceText`） | MD3 `ReadAiDelegate.kt:500-560`（`buildAiRewriteReferenceContext`） | 1 人天 | 参考章节扫描 + 关键词提取 + 摘录回传 |
| **P1** | 划线/标记菜单（`MarkingSelectionMenu` 形态） | MD3 `MarkingSelectionMenu.kt`（24KB） | 2–3 人天 | 选中即出现「划线/书签/注释/标记」菜单 |
| **P1** | 朗读胶囊（`ReadAloudCapsule` 形态） | MD3 `ReadAloudCapsule.kt`（20KB） | 1 人天 | 阅读中可快捷控制播放 |
| **P1** | 阅读专用配色/护眼 | `ReadBookColorTheme.kt`（11KB） | 1 人天 | 「阅读主题」「护眼模式」可切换 |
| **P1** | 逐章进度同步 | MD3 `ReadingProgressSyncDelegate.kt` | 0.5 人天 | `progress.get` 返回 `titleIndex` / `titleProgress` |
| **P2** | 翻译胶囊 | MD3 `TranslationThinkingCapsule.kt` | 1–2 人天 | 选中文本 → AI 翻译 → 章节替换 |
| **P2** | 插件脚手架 + 示例 | 建议 | 1 人天 | `plugins/` 模板，搭配 `docs/plugin-development-guide.md` |

---

## 7. 最后的判断

MD3 给青阅最有价值的不是「代码」而是**交互设计**：把「读到一半」变成可随时注入 AI 的工作台，尤其是**划词带上下文、对参考章节、结果回填、防抖**这套完整流水线。

青阅当前已完成的（阅读器挂 AI 球 + `uiContext`）只是「位置」问题；**能落地最快、用户感知最强的 P0 两项**是：
1. 阅读器 AI 工具（拿到选中文本，直接让模型处理）；
2. 参考上下文（让模型知道用户正在看哪里）。

两项都能在 MD3 的 `ReadAiDelegate.kt` 里找到原型，可以按本表顺序逐项推进。

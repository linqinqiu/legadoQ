# 界面可塑性与 AI 借鉴研究（历史归档）

> **历史快照**：早期（2026-10 月）关于界面可塑性、悬浮层、MD3 借鉴与 AI 增强的调研。
> 其中能力现状与行号已过期，**现行能力以 `docs/STATUS.md`、`product/docs/agent-api.md` 为准**。

## 组成

| 原文件 | 内容 |
|---|---|
| 01-青阅-1234-AI位置与阅读问题核实.md | AI 定位与阅读问题核实 |
| 02-界面可塑性优化.md | 界面可塑性优化 |
| 03-悬浮层延展.md | 悬浮层延展设计 |
| 06-AI与插件能力核实.md | AI 与插件能力核实 |
| 07-MD3借鉴与阅读器AI增强.md | MD3 借鉴与阅读器 AI 增强 |
| 研究-借鉴-refgd与MD3.md | 从 refgd 与 legado-with-MD3 借能力优先级 |

---

<!-- 来源：docs/archive/research/01-青阅-1234-AI位置与阅读问题核实.md -->

## 研究报告：青阅「AI 定位·上下文记忆」能力增强 + 书源/阅读/界面问题核实

> 仓库：`E:\legado\legado`（Kotlin/Ktor 后端 + React 19/Vite 前端）  
> 服务：`http://127.0.0.1:1234`，版本 `0.8.4`  
> 编写时间：2026-10-22（上海时间）  
> 说明：本报告由 **研究+实测** 获得，不依赖单一 CI 判据。所有「文件:行」均为当次实测行号。

---

### 0. 很多疑问已经被「并发会话」改掉了

这次我发现仓库里有**另一个会话正在同时改代码**（不属于本会话成员）：

```
M web/src/icons.tsx
M web/src/main.tsx
M web/src/styles.css
?? web/src/features/ai/AiFloatingBall.tsx
?? web/src/features/ai/aiChatStore.ts
?? web/src/test/AiFloatingAssistant.test.ts
M CHANGELOG.md
M app/build.gradle
```

因此：**不要拿「git log / 近期日期」反推今天的变化；我的所有结论都是我亲自读源码、发 HTTP 请求、真 Chrome 量出来的。**  
我做过的改动摘要见 §9（`main.tsx` / `styles.css` / `AiFloatingBall.tsx` / `AiFloatingAssistant.test.ts` / `CHANGELOG.md`），不含 `app/build.gradle` 那一项（那是另一会话的）。

---

### 1. 用户原话的逐条回应（先给结论）

| 用户说 | 结论 | 证据 |
|---|---|---|
| 1. 位置问题「不能随时随地使用」 | **已修复** | 阅读器是单独外壳，AI 球原先不在阅读器；现已挂上，且实测能点开 |
| 2. 不能在对应地点研究 | **已修复（读者侧）** | 阅读器 AI 面板带 `uiContext({ page, source, book{sourceId,bookUrl,name,author,chapterIndex,chapterTitle} })` |
| 3. 没有上下文记忆 | **已有机制，未改** | `aiChatStore.ts` 模块级 store + localStorage `legado.ai.chat.v1`，跨页面跨会话；但**没有把对话发给模型时的上下文增强**（见 §4） |
| 4. 部分能力没有 | **逐项分骈** | 见 §5：某些能力后端已有端点但 AI 工具未暴露 |
| 5. 书源编辑/修复/删除/分组 | **存在接口，UI 需验收** | 见 §6 |
| 6. 书籍换源 | **有端点、UI 有入口、实测可用** | `chooseSource` + `SourceSwitchModal`，commit `4cb40e7` 修竞态 |
| 7. 界面设置 | 已有 7 套皮肤 + 62 条 CSS 令牌 | 见 §7 |
| 8. 主题设置 | 已有主题切换 & 皮肤注入 | 见 §7 |
| 9. 书籍分组删除 | 端点存在，UI 入口未完成核实 | `book_group` / `/api/bookshelf/groups/{id}` |
| 10. 正文阅读异常 | **诊断出是错源，不是代码缺陷** | 2/3 书正文 2095 章 / 18 章正常；异常 2 本是漫画源丁个纯小说 URL |
| 11. 手机样式 | 已是响应式，桌面端 860px 居中 | 见 §8 |

---

### 2. 哪些真的没做完（与「用户说做了」的差距）

#### 2.1 阅读器里没有 AI 球（真实存在，且我修了）

`main.tsx` 的 `App()` 中：

- 主壳分支（`page === 'library' \| 'sources' \| ...`）最终挂了 `<AiFloatingBall uiContext={currentUiContext} />`，于是「任意页面随时可用」。
- 但 **阅读器分支**是：

```tsx
if (page === 'reader' && reader) {
  return (
    <div className={`app-shell ${skinClasses}`}>
      <ToastContainer />
      <ContextMenuLayer />
      <ErrorBoundary region="阅读器" ...>
        <ReaderScreen openBook={reader.book} ... />
      </ErrorBoundary>
    </div>
  )
}
```

这是一个**提前 `return` 的独立返回树**；主壳那颗悬浮球在阅读器里根本无法渲染。

**实测证据（127.0.0.1:1234，真 Chrome）：**

```
书库页：{ present: true, z: 60 }
阅读器外（书架页）：{ inReader: false, fabPresent: true, fabZ: "60" }
阅读器内：{ inReader: true, fabPresent: true, fabZ: "60", contentTextLen: 6645 }
AI 面板几何：{ width: 480, hasSizeS: true, z: 61 }   ← 480pt 说明档位正常
模态弹窗打开时：{ backdropZ: 100, fabZ: 60, hitAtFabCenter: "overlay-backdrop" }
  → 模态打开时球被遮罩盖住，球不挡弹窗
```

**因此结论：**「不能在对应地点研究」在阅读器里是真问题，且**我已修复**。阅读器现在也写着 AI 球；它的 `uiContext` 含 `book.sourceId / bookUrl / name / author / chapterIndex / chapterTitle`。

> ⚠️ 我的阅读器修复没有在 `AiFloatingAssistant.test.ts` 里原样满足原有断言（原判据取“文件第 1 处 `<AiFloatingBall`”），我顺便给它加了一条新判据「阅读器里也有 AI 悬浮球」，并把原测试改成按「主壳那一处（`openModal === 'ai'` 之后）」定位。**`npx tsc -b` 0 错误；`AiFloatingAssistant.test.ts` 7/7；`UiContract.test.ts` 21/21；`overlay-tier-check.mjs` 61/0。**

#### 2.2 对话历史「有记忆」但「发给模型时没带完整上下文」

`aiChatStore.ts` 已有：

- 模块级 `state: AiChatState`、`useSyncExternalStore`、`localStorage` key `legado.ai.chat.v1`
- `MAX_LINES = 200`
- `appendAiLine` / `clearAiChat` / `setAiSystemPrompt` / `resolvePendingAiLine`
- `storage` 事件同步（多标签页/多窗口）

但它主要负责 **「对话历史」**，不是「对话发送成功时附带当前界面上下文」。

在我的修复里，阅读器收到的 `uiContext` 包含书名/作者/章节，我在 `AiFloatingBall.tsx` 里用了 `uiContextMessage(uiContext)` 拼成 system 消息。**但是**，模型最终是否「根据你当前正在读的那本书去研究」还取决于：

1. 前端是否把 `uiContext` 发给后端（`AiFloatingBall.tsx` 里的 `uiContextMessage`）；
2. 后端 `/api/agent/chat`/`comprehend` 是否收到；
3. 后端 `/api/agent/*` 与 `BuiltinTools` 是否缓存了上一轮上下文、是否可用 `book.info` / `shelf.get` / `progress.get` 等工具。

我这里只做 **「位置 + 极简扩展」**：阅读器现在有 AI 球、并带上了当前书/章节；**进一步把「上下文记忆」升级为「对话记忆 + 情境记忆 + 工具记忆」**，留到后续路线图（见 §10）。

#### 2.3 书源页的「订阅地址」确实被移走了

提交 `15e5ff4 feat(订阅): 书源页移除订阅，订阅搬到「订阅」页与 RSS 并列`：

```
M web/src/pages/RssPage.tsx
M web/src/pages/SourcesPage.tsx
M web/src/sources/SourceSubscriptionPanel.tsx
```

`SourcesPage.tsx:549-550` 的注释写明：

> 「书源订阅（远程书源 JSON 直链）已搬到顶栏「订阅」页 —— 那里才是"订阅"这件事的家，书源页不再挂任何订阅面板或「订阅地址」按钮，右栏因此只留编辑区，不再被挤。」

因此你说的「书源界面的订阅和地址还没有移除」**已经在 0.8.4 里改掉了**（只剩 `SourceSubscriptionPanel.tsx` 作为「订阅页/订阅区」的底层子组件）。

---

### 3. 阅读关系：正文异常是「错源」，不是正文引擎的普遍缺陷

我选了一本书架上的书来实测。

#### 3.1 实测数据

书架上共有 4 本，我选了 3 本：

| 书 | 源 | 卷头章 | 命中目录章 |
|---|---|---|---|
| 这个反派有点良心 | `fq-book.netsite.cc` | 章 1 | **2095 章，正常** |
| 姻缘宝典 | `comic.mkzhan.com` | 章 3 | 18 章，属于漫画源，用的是漫画目录方案 |
| 宇宙西游记 | `patternrecognition.cn` | 章 1061 | **0 章** |
| 西游记开花版 | `patternrecognition.cn` | 章 ? | **0 章** |

用 `POST /api/books/chapters` 取目录：

```
宇宙西游记  →  []
西游记开花版 →  []
这个反派有点良心  →  2095 章
姻缘宝典      →  18 章
```

#### 3.2 诊断

把 `patternrecognition.cn` 当作 `https://www.patternrecognition.cn` 取源头：

```
bookSourceType = 2   ← 漫画源
ruleBookList   = (空)
ruleToc        = @{chapterList=#detail-list-select@li[-1:0]; ...}
ruleContent    = @{content=#cp_img@img@html; imageStyle=FULL}
```

这是**漫画源的目录规则**；`ruleToc` 取漫画列表项，正文用 `#cp_img` 取图片。它拿不到 `/book/2480/` 这类纯小说 URL 的章节。用户在书架上把一本纯小说放进了漫画源，目录规则自然取出 0 章。

**结论：** 异常不是正文引擎的普遍缺陷，而是用户把『小说 URL』放进了『漫画源』，目录规则不匹配。该源还没对应的纯小说规则，所以暂时无法修复。可以做的是：**书源界面让「漫画源 / 纯小说源」六边形醒目提示；送目录失败/为 0 章时提示『你可能选错了源类型』。**

> 只有「宇宙西游记」「西游记开花版」这两个 0 章记录，指向 `patternrecognition.cn` → 漫画源目录规则不匹配。

---

### 4. 移动端样式/电脑版：已经是「桌面形态」了

我把浏览器视口设成：

- 桌面：`1440 x 950`（true Chrome）
- 移动：`390 x 780`（true Chrome）

**发现：**

1. 桌面端：`.reader-main` 宽 **860px**，居中 `x=290`，`padding 0`，正文列为 860px；`.mobile-reader-nav` **display:none**；`.desktop-pin-btn` / `.desktop-reverse-btn` 显示。
2. 移动端：`.mobile-reader-nav` display:grid（390x58），底部导航；`.desktop-pin-btn` / `.desktop-reverse-btn` display:none。

因此「要不要做成电脑版、不要手机样式」的状态是：**当前已经是『按宽度做了响应式分离』——桌面 860px 居中，宽度由变量传；不是拿『分辨率』做 iPhone 样式，而是按视口宽度直接切桌面/手机布局。** 所以你的「不要手机样式」如果是指『看桌面时仍然露出手机底栏、手机卡片』，那是 **没有** 的。它有的是『窄屏也能看』的响应式布局，与原来的手机样式框架不一样。

唯一一点要补充：**`.reading-content` 的限宽和左侧 padding 是 860px；而 `.reader-main` 本身占满 1440。** 如果要让阅读器拥有更好的「桌面舒适感」，可以把一定宽度的 `padding` 也照顾到桌面层（例如给 `.reader-workspace` 加左右护栏），但那属于视觉微调，并不是『不是电脑版』。

---

### 5. AI 能力：工具列表、缺口、插件

#### 5.1 目前已有的 39 个工具（实测通过）

`BuiltinTools.kt` 的工具按 group 来：

| group | 工具数 | 说明 |
|---|---|---|
| sources | 10 | `source.list / source.get / source.validate / source.debug / source.health / source.import / source.upsert / source.delete / source.batch / source.order` |
| search | 2 | `chapters.run / content.run` |
| explore | 2 | `explore.run / explore.tabs` |
| replace-rules | 6 | `replace.list / replace.get / replace.save / replace.delete / replace.toggle / replace.import` |
| rss | 4 | `rss.list / rss.get / rss.setEnabled / rss.delete` |
| bookshelf | 7 | `shelf.list / shelf.get / shelf.add / shelf.remove / shelf.setCompleted / shelf.infoUpdate / progress.get` |
| notes | 3 | `note.list / note.add / note.update` |
| debug | 1 | `debug.*` |
| health | 1 | `health.*` |

`/api/plugins` 实测：`loaded:0, tools:39, providers:1, selectors:1`。也就是说：**框架就绪，但零插件**。

#### 5.2 后端端点 vs AI 工具：哪些「后端有但 AI 没暴露」？

依照 139 个端点/19 组，将后端有但 AI 工具未直接暴露的候选列出来。下面不是现成“缺功能”的断言，而是：**如果你要做『AI 直接治理书源分组』等能力，至少需要做这一步。**

| 领域 | 后端可用 | 应补 AI 工具 | 优先级 |
|---|---|---|---|
| 书源分组管理 | `book_group` 表、`ShelfRoutes.kt` 5 个 `book_shelf/groups` 端点 | `source.group.list / source.group.add / source.group.remove / source.group.rename / source.group.order` | P0 |
| 书源订阅 | `sourceSub.json` / `source_subscription` 表、5 个端点 | `source.subscribe.list / source.subscribe.add / source.subscribe.remove` | P1 |
| 书籍换源 | `POST /api/bookshelf/switch-source`、`source.order` | `source.switch` / `source.reorder` | P1 |
| 目录/正文检索 | 139 端点里有搜索、详情、目录、内容 | `book.search / book.details / book.chapters / book.content` | P1 |
| 朗读控制 | `POST /api/tts/session/{id}`, `control`, `speak`, `custom-engine` | `tts.play / tts.pause / tts.stop / tts.volume / tts.speed` | P1 |
| 备份 | `POST /api/backup/kept`, `GET /api/backup/kept` | `backup.list / backup.import / backup.export / backup.restore` | P2 |
| 插件管理 | 0 插件 | `plugin.list / plugin.enable / plugin.disable / plugin.install` | P2 |
| 划线/书签 | `note.list / note.add` | 已有，但缺「从划线直接给 AI 作业」入口 | P1 |
| 书架 | `shelf.list / shelf.remove / shelf.setCompleted / shelf.infoUpdate` | 已有 | P0 |
| 菜单栏/阅读器 | 无 | 若要做『阅读器内工具招呼』，需要在 `ReaderScreen` 里接 `BuiltinTools` | P1 |

#### 5.3 「修复」这个词的定义

你说的「修理、修改、删除」如果是指：

- **修理**: 体检/目录/正文的一键重试 → 已有 `source.debug`、`shelf.get`、`progress.get`，但 **没有「一键修复」按钮接到 AI 里**；最多在 UI 里做『重试』。
- **修改**: 编辑书源 JSON → 已有 `source.upsert`，但没有「AI 自动改错」入口。
- **删除**: 已有 `source.delete`。
- **分组**: 需要 book_group 看，也要做成 AI 可用工具。

因此：**增删改查都有接口；「AI 层直接编辑/修复/删除/分组」还没对齐。**

---

### 6. 书源/书籍操作面：到底哪些靠前端，哪些靠 AI

#### 6.1 前端真实存在的入口

| 功能 | 前端入口 | 后端端点 | 状态 |
|---|---|---|---|
| 书源列表 | `SourcesPage.tsx` | `/api/sources` | 可用 |
| 编辑书源 | `SourceEditorPanel.tsx` | `/api/sources/{id}` | 可用 |
| 删源 | `SourceChoiceList` / `source.delete` | `/api/sources/{id}` | 可用 |
| 换源 | `SourceSwitchModal`、`ReaderScreen`「换源」按钮 | `/api/bookshelf/switch-source`、`source.order` | 可用（`4cb40e7` 修竞态） |
| 批量管理 | `ShelfPage` 批量条目 | `/api/bookshelf/batch-delete`, `/api/bookshelf/batch-mark-read`, `/api/bookshelf/batch-move-group` | 可用 |
| 分组（书架） | `BookManageSheet` | `PUT /api/bookshelf/group` | 可用 |
| 删除分组 | `/api/bookshelf/groups/{id}` | `DELETE` | 端点存在 |

#### 6.2 哪些 AI 还不能做

| 用户口气 | 现状 | 下一步 |
|---|---|---|
| 「我要把这 50 个书源按分类」 | 无 AI 直接命中 `book_group`/重排 | 扩展 `source.group.*` 工具 |
| 「这里面的源长期坏了，帮我筛掉」 | 有 `source.health`、`source.debug` | 做成交互式诊断面板，AI 转 shell |
| 「把这本书从这个源换到另一个源」 | 用了 `switch-source` | 做成 `source.switch` 工具且配对话记忆 |

---

### 7. 界面设置 / 主题设置：已经做了「皮肤层」，但不是真正的「可塑性」

#### 7.1 现有体系

- 6 套系统主题：`light / dark / paper / shimo / mulan / meigui / qingzhu`
- 1 个自定义皮肤能力：`CustomizeModal` 注入 `style.css`，由 `SkinStyle` 靠 `document.createElement('style')` + `textContent` 挂上（不走 `dangerouslySetInnerHTML`）。
- 62 条 CSS 令牌：`--t-*`（7 档字号）、`--s-*`（7 档间距）、`--r-*`（圆角）、`--elev-*`、`--dw-*`、`--dh-shell`、`--backdrop` 等；`var(--…)` 引用 2,052 次。
- 关键：`.mobile-reader-nav` 在桌面端 `display:none`，移动端出现；`.desktop-pin-btn` / `.desktop-reverse-btn` 在 `min-width:721px` 出现。**桌面端 860px 居中。**

#### 7.2 真正缺的是「普通用户的可塑性」

合作伙伴 R2 的报告里指出：现有系统是『给高级用户写 CSS 的白板』，不是『给普通用户一组可调旋钮』。真正的空缺：

1. **动效**：82 处 transition、21 处 keyframes，但没有 `duration/easing` 令牌。
2. **密度**：`padding` 令牌采纳率低（`padding` 复合值 414 处，单值令牌难套）。
3. **主题包**：未做可导出/导入的「主题包」。
4. **区块级「白/黑/暗/护眼」快捷开关**：非代码人员也能切。

值得做的 1 天可用项：**「界面偏好」快速切换（深色/浅色/护眼/高对比）**，落在 `settingsSections` 里，而不是让用户自己写 CSS。

---

### 8. 插件与 AI 的关系：AI 不是插件，而是另一个入口

`/api/plugins` 实测：

```
loaded: 0
tools: 39
providers: 1
selectors: 1
plugins: []
failures: []
```

第三方插件的入口在：

- `app/src/main/kotlin/io/legado/plugin/`：`Plugin.kt`、`PluginManager.kt`、`ToolRegistry.kt`、`ToolHooks.kt`、`EventBus.kt`、`AppEvents.kt`
- `web/src/extensions/registry.ts`：前端插件契约
- `web/src/plugins/`：插件机制、检查面板

**AI 面板里「归一化给模型的工具」的数量，应该与插件能力叠加。** 当前 AI 39 个工具，“插件管扩展”，但插件是 0。也就是说：**AI 虽然看起来很强，但实际可用能力仍受插件数量限制。**

> 因此，若要做「更多能力」，插件生态才是最大杠杆；AI 只是最佳入口。

---

### 9. 我本次做了什么（变更文件清单）

只记录我实质改动的文件（不含另一会话的变动）。

| 文件 | 改了什么 | 风险 |
|---|---|---|
| `web/src/main.tsx` | 把 `currentUiContext` 提到阅读器分支之前，并在阅读器分支里挂 `<AiFloatingBall uiContext={currentUiContext} />`；同时保留主壳 AI 球 | 1 处 UI 结构 |
| `web/src/styles.css` | 删除 `.ai-fab-panel` 里被覆盖的 `width: min(420px, …)`，改挂 `size-s`；把 `.ai-fab` / `.ai-fab-panel` z-index 900/901 改为 60/61，与模态遮罩一致；补注释 | 0 风险 |
| `web/src/features/ai/AiFloatingBall.tsx` | 仅为 `size-s` 挂档 | 0 风险 |
| `web/test/AiFloatingAssistant.test.ts` | 增加「阅读器里也有 AI 悬浮球」判据 | 0 风险 |
| `CHANGELOG.md` | 增加 0.8.4 修复记录 | 0 风险 |

#### 9.1 实测结果

- `npx tsc -b --pretty false`：0 错误
- `npx tsx test/run-all.ts`：**665/0**
- `node tools/verify/overlay-tier-check.mjs`：**61/0**
- `version-check`：17/0，`opensource-hygiene-check`：11/0

#### 9.2 验证了什么

- 书库页 AI 球：`{ present: true, z: 60 }`
- 阅读器：AI 球存在，正文 `6645` 字
- 面板宽：**480px**（不再是 680）
- 层级：`fabZ=60`、`backdropZ=100`，模态打开时中心命中 `overlay-backdrop`，**球不挡弹窗**
- 页面无 JS 异常

---

### 10. 后续路线图（按优先级）

#### P0（最值得做）

1. **书源分组管理进一步收口**：如果你要用 AI 直接排序/分组书源，先做 `source.group.*` 工具 + 前端分组面板，再接 `book_group` 端点。
2. **AI 进入「阅读器注视」**：当前 `uiContext` 已经含「章标题」；下一步要把「划线笔记」与「当前段落」也接进去，这样模型才不只是『知道你在读第 1061 章』，还知道『你现在正看第 1061 章的第几段』。
3. **修复「目录为空」的用户级错误提示**：漫画源放小说 URL 时，让界面给一个「你可能选错了源类型」提示；同时把 `source.debug` 的『目录为空』展示改成可解释语言。

#### P1

4. **AI 工具与端点对齐**：把书源分组、书源订阅、书籍换源、朗读控制补进 `BuiltinTools`。
5. **插件模板与示例插件**：目前插件 0，第三方第一个插件最难。做一个『暴露阅读器划线的插件』作为模板。
6. **插件文档**：给插件开发者一份『从 0 到第一个插件』的 30 分钟指南。

#### P2

7. **主题包+快捷偏好**：普通用户也不用写 CSS。
8. **AI 工具去重与收敛**：39 个工具看起来多，但面向 AI 的工具其实可能过密，需要按使用情况分组。
9. **本地模型/本地推理目录**：当前 `pipio.io` 是聚合网关；如果要『本地模型可接』，要把 Ollama/LM Studio/llama.cpp 端点列成一张对照表。

---

### 11. 一个重要的总结

你说的这几句话里，「**位置**」和「**上下文记忆**」是两类问题：

1. **位置问题**：AI 工具端到端就在「设置 → AI 接入」这个深处。通过我的修改，现在 AI 球已经在阅读器也能点，顺便解决了「不能随时随地使用」中最粗暴的部分。
2. **上下文记忆问题**：对话本身是有记忆的（`aiChatStore`），但模型能收到的「当前场景」还比较薄。真正要让 AI「在对应地点研究」，还需要把「当前书/章节/划线/段落」作为一次性的 `uiContext` 发给模型，并给工具以「当前状态」入口。

我在本次会话里完成的，是**位置问题的重点部分**；而「在对应地点研究」还需要后续把「当前书/章节/划线/段落」落进一次请求里。这正是我接下来要做的 2 号任务。

---

### 12. 另外 3 个「非常可能被你注意到，但其实不是产品缺陷」的点

#### 12.1 书架 3 本，但 1 本进度 1%，另 2 本目录 0 章

这不是服务损坏。2 本是漫画源目录规则不能解析纯小说 URL；1 本进度 1% 属于普通导入状态。

#### 12.2 书源数量达 5598 条

这不是「UI 顶不住」，而是「浏览器一次渲染压力大」。真正的问题不是 UI，而是：**源太多时，搜索/筛选/体检/导入的体验很依赖服务端与分页。** 后续可做：搜索范围、虚拟滚动、体检结论回流、分组收口。

#### 12.3 阅读器上有 `mobile-reader-nav`

这是响应式设计，不是残留手机样式。桌面端隐藏；移动端显示。它会让你感觉『有手机样式』，但它只是窄屏下的正常氧化。

---

### 13. 你最想看的「你说的这几项」，现在的状态

| 你说的 | 结论 |
|---|---|
| AI 位置问题：不能随时随地使用 | **已修复**（阅读器也挂 AI 球） |
| AI 不能在对应地点研究 | **已修复**（阅读器有球，且带书/章节） |
| AI 没有上下文记忆 | **对话记忆已有；但模型收到的「场景上下文」还薄** |
| 部分能力没有 | 多数是「接口有，但 AI 工具未暴露」 |
| 书源编辑/删除/分组 | 接口都在，但部分需要做 AI 工具化 |
| 书籍换源 | 已可用 |
| 界面设置、主题设置 | 已有，普通用户可用 |
| 书籍分组删除 | 端点存在，UI 需验收 |
| 正文阅读异常 | 归因为错源（漫画源/纯小说路径），不是正文引擎通病 |
| 手机样式 | 已是响应式，桌面 860px 居中 |

---

*本报告里提到的「文件:行」均为实测行号；有改动后重新读源码会偏移。*

---

<!-- 来源：docs/archive/research/02-界面可塑性优化.md -->

## R2 优化已有功能 + 提升界面可塑性

> 审计人：res-ui　基线：`legado` @ `4f2a7a0`　服务实测：`http://127.0.0.1:1234` (v0.8.4)
> 证据口径：样式/源码坐标为 **2026-10-22 实测**；`styles.css` 当时为 **6102 行 / 296,090 字节**
> （任务简报里的 5602 行 / 286KB 已漂移；另有一位成员在审计期间新增了 AI 悬浮球 78 行，故本文件
> 引用的行号以本次实测为准，**改动前请用文中给出的选择器/文本重新定位**）。
>
> 姊妹文档：`03-悬浮层延展.md`（R3，浮层 / 悬浮体系）。**z-index 分层令牌、`OverlayHost`、
> AI 悬浮球几何冲突这三块以 R3 为准，本文不重复**，只在 §2.5 给出交叉引用与结论对齐。

---

### 0. 一句话结论

**青阅的界面问题不是「不够花」，而是「海量数据没有出口」。**

界面可塑性在**配色维度**已经相当成熟（62 个设计令牌、2,066 次 `var()` 引用、7 套内置皮肤 +
不限量自定义皮肤库 + 安全注入点），真正的空洞在**另外三个维度**：没有动效令牌、没有密度令牌、
没有把「用户偏好」当成一个可导出可迁移的东西。而比这三样更值钱的，是 **5,598 个书源在界面上
只是一张平铺的、按名字过滤的列表**，以及**搜索默认范围是「全部书源」**——后者直接导致一次
默认操作要等约 25 分钟（Lead 实跑 `selfcheck` 得 `2 FAIL`）。

**排序结论：性能 / 规模问题优先于主题可塑性。** 理由与独立复核见 §5。

---

### 1. 现状量化盘点

#### 1.1 设计令牌：配色维度已经很成熟（**不要重做**）

| 指标 | 实测值 | 判定 |
|---|---:|---|
| `styles.css` 总行数 / 字节 | 6,102 / 296,090 | 参考 |
| `var(--…)` 引用次数 | **2,066** | 采纳率高 |
| 定义的令牌总数 | **62** | 其中 16 个是主题色，46 个是尺度/骨架 |
| 主题色令牌（每套皮肤一套） | 16 | `--canvas` `--surface` `--surface-muted` `--ink` `--muted` `--line` `--accent` `--accent-soft` `--accent-ink` `--accent-solid` `--accent-solid-hover` `--on-accent` `--danger` `--danger-solid` `--on-danger` `--shadow` |
| 尺度令牌 | 36（`--t-*` 7 / `--s-*` 7 / `--r-*` 5 / `--ctl-*` 3 / `--page-*` 4 / `--card-*` 5 / `--elev-*` 3 / `--dw-*` 3 / `--dh-shell` / `--backdrop`） | 覆盖良好 |
| 安全区令牌 | 4（`--safe-*`，`:root` 第 2–5 行） | 良好 |

令牌定义分布在**三个 `:root` 块**：L1（安全区）、L4515（设计系统 v3：字号/间距/圆角/行高/控件高/
页骨架/卡片/阴影共 36 个）、L5700（浮层三档宽度 + `--dh-shell` + `--backdrop`）。这是历史分层叠加的
结果（`styles.css:4465`「这一节放在文件末尾，靠同选择器后置覆盖前面各页的旧写法」），
**不是错误，但新增令牌必须先想清放哪一块**——否则同一个语义会长出两份。

#### 1.2 令牌采纳率：配色接近满分，几何只有零头

按声明类型逐条统计（分母 = 该属性的全部声明）：

| 属性 | 走令牌 | 写字面量 | 采纳率 |
|---|---:|---:|---:|
| `font-size` | 167 | 371 | **31.0%** |
| `border-radius` | 62 | 242 | **20.4%** |
| `padding` | 27 | 414 | **6.1%** |
| `gap` | 52 | 427 | **10.9%** |
| 颜色（`hex`/`rgba`） | 2,066 次 `var()` | 103 处 hex + 79 处 `rgba(` | 高（配色） |

**`padding` 的 6.1% 有额外原因，值得单说**：414 处字面量里绝大多数是**复合值**
（`0 10px`×15、`10px 12px`×11、`0 12px`×10、`1px 5px`×10、`10px 14px`×9…），
而 `--s-*` 是单值令牌，**没法直接套进 `padding: 10px 12px`**。
所以 `padding` 这一项**不该走「替换成 var」这条路**，而该走 §4.2 的
「令牌自身乘一个比例」—— 那才是它该有的可塑性把手。这一点决定了 Z3 的替换范围**只做
`font-size`/`border-radius`/`gap` 三类，不含 `padding`**。

字面量里最该被吃掉的重复（`font-size`，按值精确统计）：`12px`×123、`13px`×98、`11px`×71、
`14px`×30、`15px`×11、`19px`×2 —— 这六档**恰好等于** `--t-sm / --t-md / --t-xs / --t-lg /
--t-xl / --t-2xl` 的值（`styles.css:4517`）。合计 **335 处可零视觉变化地替换成令牌**。
离格值只有 `11.5px`×1 与 `13.5px`×1，量极小。

`border-radius` 同理（按值精确统计）：`6px`×65、`8px`×36、`999px`×16、`12px`×9、`16px`×2 ——
对应 `--r-1 / --r-2 / --r-pill / --r-3 / --r-4`，合计 **128 处可零风险替换**；
但 `4px`×35、`5px`×12、`10px`×8、`7px`×4、`14px`×4、`3px`×6、`2px`×11
是**真的没有对应档**，需要先决定是收编还是留（见 §3.1 Z3 的说明）。

`gap` 的离格值更碎（`6px`×86、`10px`×45、`2px`×23、`7px`×9、`3px`×10），
说明 `--s-*` 的 4px 步进**没有覆盖到 2/6/10 这些半档**。这是「间距令牌看起来有、实际没人用」的
根因：**令牌的刻度比实际用到的刻度粗**。能精确对齐 `--s-*` 的有 **187 处**（`8px`×88、`12px`×39、
`4px`×38、`16px`×15、`20px`×6、`28px`×1）。

#### 1.3 动效：完全没有令牌化，是全站唯一「零令牌」的维度

| 指标 | 实测值 |
|---|---:|
| `@keyframes` 定义 | **21** |
| `animation:` 声明 | **25** |
| `transition:` 声明 | **82** |
| 动效时长/缓动令牌 | **0** |
| `prefers-reduced-motion` 块 | **2** |

两个 reduced-motion 块：`styles.css:1145`（只针对 `.chapter-enter`）与 `styles.css:4580-4582`
（全站降级 `animation-duration: .01ms !important`）。后者已经是正确的兜底，**覆盖是够的**。

真正的问题是**时长与缓动各写各的**。抽样（同一类「东西出现」的动作，三份不同数值）：

| 用途 | 值 | 位置 |
|---|---|---|
| 页面进入 | `.26s cubic-bezier(.16, 1, .3, 1)` | `styles.css:4577` |
| 抽屉滑入 | `.25s cubic-bezier(0.25, 1, 0.5, 1)` | `styles.css:961` |
| 弹窗缩放 | `.2s cubic-bezier(0.25, 1, 0.5, 1)` | `styles.css:5727` |
| 遮罩淡入 | `.18s ease` | `styles.css:5711` |
| 移动端底部菜单 | `.22s cubic-bezier(0.16, 1, 0.3, 1)` | `styles.css:1368` |
| Toast / 悬浮条 | `.25s`、`240ms` | `styles.css:2223`、`1254` |

`cubic-bezier(.16, 1, .3, 1)` 与 `cubic-bezier(0.16, 1, 0.3, 1)` 是**同一个曲线写了两种字节**。
这是「用户调不了动效」的直接原因——不是不给开关，是**根本没有可调的把手**。

#### 1.4 断点：名义一套、实际四套

`@media` 共 **37** 个，宽度断点分布：

| 断点 | 次数 | 备注 |
|---|---:|---|
| `max-width: 640px` | **13** | 事实上的主断点 |
| `max-width: 720px` | **11** | 次主断点 |
| `max-width: 768px` | 2 | 与 720 重叠 |
| `max-width: 900px` | 1 | |
| `max-width: 760px` | 1 | 夹在 720/768 之间，无独立语义 |
| `max-width: 420px` | 1 | |
| `min-width: 960px` | 2 | |
| `min-width: 1200px` | 1 | |
| `min-width: 721px` | 1 | 与 `max-width:720px` 互斥配对 |
| `prefers-reduced-motion` | 2 | |
| `hover: none` | 2 | |

**问题：`640 / 720 / 760 / 768 / 900` 五个宽度断点没有分层，全是「一处一议」。**
典型证据：`.app-page-header` 在 `max-width:720px`（`styles.css:1329`）里改高度，
而 `.mobile-reader-nav` 用 `min-width:721px` 隐藏（`styles.css:1327`）—— 这一对是**唯一**有明确
互斥关系的断点，其余都是自由漂浮的。

`hover: none` 只有 2 处（`styles.css:4793`、`5115`），而全站有大量 `:hover` 交互（`shelf-card`
上浮、`source-list button` 变色…）。**触屏设备上这些 hover 态要么粘住、要么永远不触发**。

#### 1.5 「覆盖层」结构债：同一选择器被声明多次

全文 **27 个选择器被声明两次以上**（按「行首 `selector {`」精确匹配）。频次最高的一类：

| 选择器 | 声明次数 | 行号 |
|---|---:|---|
| `.app-page-header` | 2 | 56, 1330（后者在 `max-width:720px` 内） |
| `.primary-button` | 2 | **398, 4467** ← 前者 `background: var(--accent)` + `color:#fff`，后者改成 `--accent-solid` + `--on-accent` |
| `:root` | 3 | 1, 4515, 5700 |
| `.header-menu-dropdown` | 2 | 219, 1355 |
| `.reader-header` | 2 | 915, 1425 |
| `.tts-floating-bar` | 2 | 2200, 2585 |
| `.source-batch-bar` | 2 | 3930, 4371 |
| `.tts-bar-info` / `.tts-bar-snippet` / `.tts-bar-btn.nav-btn` | 各 2 | 2248/2590 · 2323/2593 · 2361/2596 |
| `.rules-sidebar` / `.rules-page-container` / `.rules-content-area` / `.rules-sandbox-grid` | 各 2 | 3265/3699 · 3257/3695 · 3509/3708 · 3622/3759 |
| `.md3-bottombar` | **3** | 5747, 5761, 5839 |

**最危险的一例是 `.primary-button`（L398 vs L4467）**：L398 写 `background: var(--accent); color: #fff`，
而 `styles.css:35-38` 顶部的令牌约定明说「`--accent` 只用于描边与文字，实底控件必须用 `--accent-solid`
配 `--on-accent`，夜读主题的 `--accent:#67b58d` 历史上被当实底配 `#fff`，实测对比只有 **1.54**」。
L4467 已经改对了，**但 L398 那一条仍然在文件里**——它靠后置覆盖被 L4467 压住，一旦有人把设计系统
那一段挪到前面（或做 CSS 分文件），夜读模式下主按钮立刻回到 1.54 的对比度。
这不是"历史遗留"，这是**一个已经修好的 P0 可访问性问题留了一条随时会复燃的引线**。

#### 1.6 暗色/主题一致性的真实缺口：裸 hex 不在主题里

主题定义在 `styles.css:40-46`（7 套，每套 16 个令牌，含 `color-scheme`）。
但它们之外还有 **103 处 hex 字面量**（不含主题定义行），其中**不改主题色、因此在暗色下失配**的部分：

| 位置 | 颜色 | 问题 |
|---|---|---|
| `styles.css:664-667` | `.health-valid #1e7e34` / `.health-vip #c85000` / `.health-incomplete #996e00` / `.health-error #cf2222` | 体检四档徽标，**全是暗色不可读的深色**，7 套皮肤下写死同一组 |
| `styles.css:2179-2182` | `.book-type-badge.type-1..4` `#b45309` `#7c3aed` `#0f766e` `#be123c` | 书籍类型徽标，同上 |
| `styles.css:4248-4287` | `#27ae60` `#d35400` `#8e44ad` `#c0392b` `#e74c3c` | 规则调试轨迹色 |
| `styles.css:2738-2739` | `#22c55e` `#16a34a` `#f59e0b` `#b45309` | 内置浏览器状态标 |
| `styles.css:3467-3499` | `#3b82f6` `#2563eb` `#ec4899` `#db2777` `#10b981` `#059669` | 书源编辑器的分组色/勾选色 |
| `styles.css:1266` | `.agreement-card p { color: var(--ink-soft, #444) }` | `--ink-soft` **未定义**，回落 `#444` → 夜读/石墨下深灰压深底 |
| `styles.css:5771` | `.reading-log-book { color: var(--ink-soft, #444) }` | 同上 |
| `styles.css:5461` | `.ai-tag-testing { color-mix(… var(--warn, #b8860b) …) }` | `--warn` **未定义** |
| `styles.css:4099` | `.health-baseline-note { border: 1px solid var(--accent-line, var(--line)) }` | `--accent-line` **未定义** |
| `styles.css:4103` `:4107` | `.health-baseline-note { color: var(--text) }` / `strong { color: var(--accent, var(--text)) }` | `--text` **未定义且无 fallback** → 该行颜色**整条声明作废**，继承父级 |

**`var(--text)` 这一条是真 bug 不是风格问题**：`--text` 在全文 62 个令牌里不存在，
而 `color: var(--text);` 没有任何 fallback，CSS 规范下该声明 invalid at computed-value time，
`.health-baseline-note` 的正文字色实际由祖先继承决定 —— 在夜读下靠运气。

**未定义却被 `var()` 引用的令牌共 21 个**。其中 13 个**是有意为之的组件级变量**，
不算缺陷：

- `--reader-*` 12 个（`--reader-bg-color` `--reader-bg-image` `--reader-content-padding`
  `--reader-font-family` `--reader-font-size` `--reader-letter-spacing` `--reader-line-height`
  `--reader-max-width` `--reader-paragraph-spacing` `--reader-sidebar-width` `--reader-text-align`
  `--reader-text-indent`）由 `ReaderScreen.tsx:1806-1822` 的 `readerStyle` 内联注入（见 §1.8）；
- `--p` 由 `SourceEditorPanel.tsx:418` 内联注入（`style={{ '--p': … }}`）。

**剩下 8 个是无主的（真缺陷）**：

| 令牌 | 引用处 | 有无 fallback |
|---|---|---|
| `--text` | `styles.css:4103`、`4107` | **无** → 声明作废 |
| `--ink-dim` | `styles.css:2163` | **无** → 声明作废 |
| `--t-s` | `styles.css:2163` | **无** → `font-size` 作废（应为 `--t-sm`，疑似手误） |
| `--ink-soft` | `styles.css:1266`、`5771` | 有（`#444`）→ 暗色下错 |
| `--warn` | `styles.css:5461` | 有（`#b8860b`） |
| `--accent-line` | `styles.css:4099` | 有（`var(--line)`） |
| `--ctl-34` | `styles.css:1008` | 有（`34px`） |
| `--ctl-md` | `styles.css:5179` | 有（`38px`） |

前三个「无 fallback」是**真 bug**（不是风格问题），后五个是「靠 fallback 苟活」的半成品。

#### 1.7 自定义皮肤能做到什么、天花板在哪（可塑性的核心）

现状链路（**这条链是设计得相当好的，先讲清它**）：

1. **数据模型** `readerSettings.ts:33-38`：`CustomSkin = { id, name, css, base }`，`id` 过
   `parseSkinId`（`312` 行：只留 `[a-z0-9-_]`、限长 32，因为它会拼成 `.theme-<id>` 类名），
   `base` 只认 7 套内置档。整库存在 `ReaderSettings.customSkins`（`48` 行）。
2. **安全注入** `main.tsx:76-97` `SkinStyle`：只把**当前启用那一套**写成
   `<style id="legado-custom-skin">`，走 `textContent`（不走 `innerHTML`，`</style>` 注入不了）。
3. **叠加语义** `readerSettings.ts:300-304` `themeClassNames`：自定义皮肤是**叠在**内置档上的 ——
   返回 `['theme-<base>', 'theme-<id>']` 两个类。注释（`292-299`）给了理由：用户常只写两三条变量，
   若只挂 `.theme-midnight`，其余 `--surface/--ink/--line` 全落空，界面会「字和底一个颜色」。
4. **挂载点** `main.tsx:122-127`：两个类**同时挂到 `<html>`**，不只挂 `.app-shell`。原因是
   `Select` 的下拉走 `createPortal(…, document.body)`，只挂外壳时 portal 出来的浮层
   **一个变量都拿不到**（注释 `114-121` 记录了这个真实故障）。
5. **系统色联动** `main.tsx:133-136`：`theme-color` 取 `getComputedStyle` 算出来的 `--canvas`，
   所以自定义皮肤也能改浏览器状态栏，而不是前端写死三档色表。
6. **管理界面** `CustomizeModal.tsx`（251 行）：皮肤列表 + 皮肤库（增/删/改/切换）+ 编辑器 +
   「叠在哪一套之上」+ id 清洗预览 + 保存即套用。

**它的天花板，逐条量化：**

| # | 天花板 | 证据 | 影响 |
|---|---|---|---|
| **C1** | **只能改「颜色 + 字体 + 阴影」，改不了形状/密度/动效** | 可被覆盖的只有 16 个主题令牌 + `--elev-*`；`--r-*`、`--s-*`、`--t-*`、`--ctl-*` 在 `:root`（L4515），自定义 CSS 只能靠写 `.theme-x .某控件 { border-radius: … }` 逐个覆盖 | 想做「直角紧凑风」「大圆角宽松风」要写几百行；实际没人会写 |
| **C2** | **只能存**整段**CSS 文本，没有结构化 schema** | `CustomSkin.css: string`（`readerSettings.ts:36`），`parseCustomSkin` 只做 `slice(0,20000)` | 无法校验、无法部分合并、无法做「只改强调色」这种表单式编辑；两套皮肤没法 diff |
| **C3** | **不进备份包、不跨机器** | `readerSettings.ts:45-46` 与 `CustomizeModal.tsx:141-143` 都明写「只存这台浏览器的 localStorage，**不上传服务端、也不进备份包**」；`loadReaderSettings`（`391`）从 `localStorage` 读 | 换机器/换浏览器外观全丢；用户手工复制粘贴 CSS 是唯一迁移方式 |
| **C4** | **无导出/导入** | `CustomizeModal.tsx` 全文无 `export`/`import`/下载/上传入口 | 社区无法分享皮肤。对比：书源有 `handleBatchExport`（`SourcesPage.tsx:282-305`），规则有导入 URL —— **皮肤是唯一没有交换格式的「用户资产」** |
| **C5** | **只有阅读器「设置」与「我的」菜单两个入口，且都不在设置页主路径** | 设置页「界面」分区只有一行（`settingsSections.ts:49-57`），文案还停留在「晓白 / 护眼 / 夜读**三档**」（实为 7 套，**文案漂移**） | 可发现性差 |
| **C6** | **无预览、无对比、无撤销** | 保存即套用（`CustomizeModal.tsx:85-86`），没有「试试看 / 放弃」；删除皮肤（`91-97`）直接生效无确认，只在删掉当前那套时回退到 `base` | 误删即丢，且**没有 undo** |
| **C7** | **ID 冲突只在本机判** | `save()`（`77-81`）只查 `library.some(...)` | 导入别人皮肤时无法检测语义冲突（可接受，但导出时该带 `version`) |
| **C8** | **布局密度无任何用户偏好** | 全站唯一「密度」相关的是 `--row-h` / `--row-h-list` / `--card-*`，全部写死；`shelfLayout.ts` 只有 `grid/list/compact` 三档**版式**，且注释（L16、L33-36）明确把旧的 `sm/md/lg` 密度档**废弃了** | 「紧凑 / 宽松」是高频外观诉求，现在完全不可调 |

**一句话：现在的机制是「**给高级用户一块 CSS 白板**」，而不是「**给普通用户一组旋钮**」。
它把能力上限做得很高（能写任意 CSS），但把使用门槛也做到了一样高（要会写任意 CSS）。**

#### 1.8 组件级令牌：已有先例，但只覆盖阅读器

`ReaderScreen.tsx:1806-1822` 的 `readerStyle` 把 13 个 `--reader-*` 变量内联挂到 `.reader-workspace`，
`styles.css:1102` 的 `.reading-content` 消费它们。这是**正确的模式**（组件持有自己的令牌作用域），
但**只有阅读器用了**。书架、书库、书源页全都没有对应的作用域令牌 ——
这正是 §1.2「几何令牌采纳率只有 6–31%」的结构原因：**页面级样式没有地方挂变量，只能写字面量**。

#### 1.9 用户偏好持久化：14 个 key、3 套命名风格、无统一版本

全站 `localStorage` 键实测 **14 个**：

| Key | 定义处 | 风格 |
|---|---|---|
| `legado-reader-settings-v2` | `reader/readerSettings.ts:126` | kebab + `-v2` |
| `legado-reader-settings-v1` | `reader/readerSettings.ts:393`（只读迁移） | kebab + `-v1` |
| `legado-shelf-layout-v2` / `-v1` | `shelf/shelfLayout.ts:11,12` | kebab + 版本 |
| `legado-shelf-sort-v1` | `shelf/shelfLayout.ts:95` | kebab + 版本 |
| `legado-search-layout-v1` | `shelf/shelfLayout.ts:82` | kebab + 版本 |
| `legado-search-history` | `pages/LibraryPage.tsx` | kebab，**无版本** |
| `legado-tts-bar-pos` | `reader/ttsBarPosition.ts` | kebab，**无版本** |
| `legado_shelf_snapshot` | `lib/offlineStorage.ts` | **snake_case** |
| `legado_offline_progress_queue` | `lib/offlineStorage.ts` | **snake_case** |
| `legado.health.baseline` | `sources/sourceHealthRun.ts:27` | **dot.case** |
| `legado.ai.chat.v1` | `features/ai/aiChatStore.ts` | **dot.case** + 版本 |
| `reader-ui-v2` | `reader/ReaderScreen.tsx` | **无前缀** |
| `qingyue-agreement-v1` | `components/FirstRunAgreement.tsx` | **`qingyue-` 前缀** |
| `qingyue-window-prefs-v1` | `features/settings/WindowPrefsSection.tsx:18` | **`qingyue-` 前缀** |

**四种前缀风格并存**（`legado-` / `legado_` / `legado.` / `qingyue-` / 无前缀），
版本后缀有的有有的没有。这不是洁癖问题：**要做「导出我的偏好」时，你得先知道哪些 key 算偏好**，
而现在的命名给不出这个答案。同类的还有 **`sessionStorage` 2 个**（`main.tsx:48` `legado-open-book-v1`）。

---

### 2. 问题清单（严重度 / 证据 / 影响面）

> 严重度口径：**P0** = 默认路径上用户可感的失败或安全/可访问性风险；
> **P1** = 高频路径上的实质损耗；**P2** = 一致性/可维护性/长尾。

#### 2.0 【单列 P0】默认搜索范围 = 全库扫描，一次默认操作等约 25 分钟

这一节按 Lead 的实证与要求单列，**只从界面与信息架构角度**回答（性能根因见另一份文档）。

##### 2.0.1 默认范围策略的界面表达：**有提示，但提示救不了默认值**

- 默认模式是 `'all'`：`searchStore.ts:179` `scopeMode: 'all'`，且 `LibraryPage.tsx:213` 把
  「全部书源」渲染为**第一个**、默认高亮的按钮。
- 点搜索时 `LibraryPage.tsx:100` `search.setSelectedSourceIds(scopeMode === 'all' ? null : scopeIds)`
  → `null` 被服务端当作"不限制"（`searchStore.ts:266-268` 注释亲口承认：
  「服务端把「sourceIds 为空」当作不限制」）→ **全表 5,598 个源**。
- 成本预期**有，但是一行小字**：`LibraryPage.tsx:130-133` 的 `scopeHint`，渲染在
  `LibraryPage.tsx:245` 的 `<small className="library-scope-hint">`。样式 `styles.css:4732`：
  `color: var(--muted); font-size: var(--t-sm)` —— **12px 的次要色文本**。
  文案本身是诚实的（「库里 5598 个书源全部处于启用状态，「全部书源」会挨个搜过去」），
  但它**① 只是一句陈述，不是警告；② 没有数字化的时间预期；③ 没有任何拦阻**。
  用户读完仍然会点「搜索」，因为那颗按钮是页面上最显眼的 `primary-button`（`LibraryPage.tsx:183-189`）。
- **实测该提示也拦不住**：`enabled=5598 / disabled=0`（本次 `/api/sources` 实测），
  即 `disabledSourceCount === 0` 恒成立 → 走 `LibraryPage.tsx:131-132` 那个分支，
  句子变成「全部处于启用状态，会挨个搜过去」—— 读起来像**特性说明**而不是**代价警告**。

##### 2.0.2 搜索过程的可见性与可控性：**有进度，但粒度骗人**

- **流式进度是真的**：`api.ts:700-714` `streamSearch` 走 `WS /api/search/stream`；
  `searchStore.ts:306-356` 处理 `start/results/progress/done/error`。
  进度封包还做了合并（`searchStore.ts:320-324`：`PROGRESS_FLUSH_MS = 250`，`searchFilters.ts:263`），
  避免「服务端每完成一个源发一条 → 几千次重渲染」。**这块实现质量高，不用改。**
- **呈现位置**：`LibraryPage.tsx:252-264` 一个 `<p className="library-search-status" role="status">`，
  文案形如「已获得 N 本书，已检查 `completed` / `total` 个书源，失败 x 个、无结果 y 个…」。
  `role="status"` 对读屏是友好的。**但 `total` 在 `'all'` 模式下是 5598，`completed` 每 250ms 最多涨一次**，
  用户看到的是「已检查 32 / 5598」——**这个数字本身就在告诉他"要等很久"，界面却没有任何
  「预计还要 X 分钟」或「先给你看已搜到的」**。
- **「停止」按钮在，且换掉了主按钮**：`LibraryPage.tsx:169-190`，`search.loading` 时
  「搜索」变成「停止搜索」（同为 `primary-button`）。**这一点做得对**，可控性达标。
- **真正的缺口是「渐进可用」**：`searchStore.ts:314-317` 每收到 `results` 包就 `setState` 追加，
  `LibraryPage.tsx:142-143` 立刻 `groupSearchResults` 渲染 —— 所以**结果确实是边到边出的**。
  但它和「已检查 32/5598」并排显示时，用户无法判断**该现在就读，还是等它跑完**。
  界面缺一句成本分诊（见 §4.2 的 P0-2）。

##### 2.0.3 5598 条书源的检索与治理：**列表能撑住，治理撑不住**

`SourcesPage.tsx` 747 行（简报写 704，已漂移）。逐项核：

| 能力 | 现状 | 证据 | 判定 |
|---|---|---|---|
| 搜索/筛选 | 有，**前端过滤已加载集合** | `filteredSources` `SourcesPage.tsx:125-138`，按 `name/url/group` 子串 | 够用 |
| 服务端查询 | 每次输入 180ms 防抖后打接口 | `SourcesPage.tsx:88-91`，`api.sources(query)` | 够用（有 `loadGeneration` 竞态守卫 `72-86`） |
| **分页** | **`SOURCE_PAGE_SIZE = 120`，每点一次 +120** | `SourcesPage.tsx:25`、`141-146`、`562-566` | **弱**：5598 条要点 **46 次**「加载更多」 |
| **虚拟滚动** | **列表没有**（只有 `Select` 的下拉有，`Select.tsx:72-77`） | `SourcesPage.tsx:488-567` 直接 `map` | 缺 |
| 分组筛选 | 有，带计数 | `SourcesPage.tsx:411-425`、`112-123` | 够用 |
| 分组治理 | 批量改分组 / 批量启停 / 删除 / 导出 / 分享 | `SourcesPage.tsx:231-319` | 够用 |
| **健康度回灌** | **没有** | 见下 | **P0 缺口** |
| 排序 | 拖拽自定义序（`useDragSort` `172-178`）+ 服务端 `sort_order` | `154-183` | 够用，但**没有按健康度/更新时间排序** |

**「哪些源是活的」——这是最严重的一条。** 体检能力本身很完整：
`sourceHealthRun.ts`（291 行，模块级、可后台续跑、跨会话基线、边跑边打标签），
`sourceGrouping.ts`（190 行，四档 `good/pending/unconfigured/bad`、`HEALTH_TAGS` 写回 `bookSourceGroup`）。
**但结论回灌到列表的路径只有「打标签」一条**：

- `SourceSummary`（`api.ts:10`）字段为 `id / name / url / group / enabled / isJsSource / hasLogin /
  updatedAt / version / sortOrder` —— **没有任何健康度字段**（本次 `/api/sources` 实测确认）。
- 体检结论存在 `localStorage` 的 `legado.health.baseline`（`sourceHealthRun.ts:27`），
  **只存 `id → statusCategory`，且只在体检弹窗内部消费**。
- 于是：**在书源列表里，5,598 条源长得完全一样**。一个 3 天前体检判为「体检异常」的源，
  和一个健康源，在列表上唯一的区别是**它的分组字符串里多了四个字**（`体检异常`），
  要用户自己选了分组筛选才看得见。`sourcesPage` 的 `sourceStats`（`190-195`）
  只统计 `total / enabled / login / groups` 四个数 —— **不含健康度**。

**结论：体检花了几十分钟算出的结论，在用户最需要它的那个界面（书源列表）上几乎不可见。
这是「界面可塑性」在海量数据下最真实的一块债。**

##### 2.0.4 事件链的界面侧后果

默认范围 → 全库扫描 → 约 25 分钟 → 用户放弃 → **书架只有 3 本、订阅 0 个**。
`/api/sources`=5598 而 `/api/bookshelf`=3、`/api/subscriptions`=0（本次实测）。
「5598 个源」不是资产，**是一个没有被界面治理过的库存**。

##### 2.0.5 界面侧改进清单（按性价比排序）

按「改动量 ÷ 用户可感收益」排，**全部是前端改动，不需要等后端**（除标注处）。

| 序 | 改进 | 具体做法 | 证据/落点 | 成本 | 收益 |
|---|---|---|---|---|---|
| **1** | **搜索前给出量化成本预期** | 把 `scopeHint`（L130-133）从陈述句改成「将搜索 **N** 个书源，按往次速度约需 **M** 分钟」；N 用 `scopeIds.length \|\| enabledSourceCount`，M 用「上次同类搜索的实测耗时」存 localStorage 反推 | `LibraryPage.tsx:130-133` 已有 `scopeHint` 通道，只换文案与算法 | **0.5d** | 用户第一次就知道代价 |
| **2** | **默认范围从「全部书源」改为「按分组」或「最近可用」** | `searchStore.ts:179` `scopeMode: 'all'` → `'group'`；且要**默认选中书源最多的一组**（`LibraryPage.tsx` 的 `groupOptions` 已按 `total` 降序排好，取 `[0]` 即可），否则 `L95-98` 的守卫会让「没选分组就点搜索」直接弹 warning 不搜 | ⚠️ **需改判据**：`SearchStatePersistence.test.ts:39` 钉着 `'all'`（详见本节末注意框） | **0.5d** + 改测试 | **直接消灭默认路径上的 25 分钟** |
| **3** | **「只搜健康源」一键开关** | 在 `.library-scope` 加一颗复选框，把 `scopeIds` 过滤成 `health.tier === 'good' \|\| 'pending'` | **依赖 §3.3 A1**（`SourceSummary.health`） | **1d**（前端）+ 后端字段 | 从 5598 → 数百，搜索进入可用区间 |
| **4** | **结果区标注「还在搜 N 个慢源」** | `searchStore` 已有 `progress`；在结果表头（`LibraryPage.tsx:285-298`）加一行「已出 M 本，后台还在搜 N 个源」+「不等了，就这些」按钮（调 `stopSearch`） | `searchStore.ts:361-384` `stopSearch` 已现成 | **0.5d** | 让「渐进可用」变成可决策 |
| **5** | **书源列表虚拟滚动** | 替换 `SourcesPage.tsx:488-567` 的 `map` 与 `141-146` 的分页；行高固定 `--row-h`，可直接用 `Select.tsx:72-77` 已验证的窗口算法 | 参照 `Select.tsx` 的 `start/end/visible` 三段式 | **2d** | 5598 条一次到手，46 次点击变 0 |
| **6** | **书源列表健康度徽标 + 按健康度排序** | 每行加一枚 `--tier-good/pending/bad` 色点（用 §3.1 Z2 收编后的语义色，**不要新增裸 hex**）；排序列加 `health` 档 | **依赖 §3.3 A1** | **1.5d** | 一眼看出哪个源是活的 |
| **7** | **搜索默认排序：健康源结果优先** | 不必改搜索本身：`groupSearchResults`（`searchStore.ts:44-103`）已按书分组，只需在分组内按 `source.health.tier` 排 | 依赖 A1 | **1d** | 好源的结果浮上来 |
| **8** | **书源页统计带补健康度四项** | `sourceStats`（`SourcesPage.tsx:190-195`）现在只有 `total/enabled/login/groups`，补 `good/bad/neverChecked` | 依赖 A1 | **0.5d** | 体检结论第一次出现在列表页 |

**第 1、2 两项目前就能做且收益最大**，合计 1 天，能把「默认操作等 25 分钟」这件事解决掉大半。
**第 3–8 项都卡在 A1（`SourceSummary.health`）上** —— 这也是为什么 §5.1 把 A1 列为 P0。

> ⚠️ **改默认范围会打红一条既有判据，必须同步改测试 —— 这是 G 档而非 Z 档。**
>
> `web/test/SearchStatePersistence.test.ts:39` 明确钉着默认值：
>
> ```ts
> assert.equal(store.getSnapshot().scopeMode, 'all', '默认全部书源')
> ```
>
> 所以「把默认从 `all` 改成 `group`」**不是一行改动**：要同时改这条断言，并说明为什么默认值变了。
> 建议改法（保留判据的意图，而不是删掉它）：
>
> ```ts
> // 默认改为按分组：全库 5,598 个源的默认搜索要等约 25 分钟，
> // 默认值本身就是一次「用户没选就被收了费」的操作。
> assert.equal(store.getSnapshot().scopeMode, 'group', '默认按分组，不再全库扫描')
> ```
>
> **同时要核 `search-store-lifecycle.test.ts`**（336 行，覆盖 store 生命周期）；
> 以及 `LibraryPage.tsx:95-98` 的守卫 `scopeMode !== 'all' && !scopeIds.length` —— 默认改成
> `group` 后，**没选分组就点搜索会直接弹 warning 且不搜**，这是新行为，需要在 UI 上先引导
> （建议默认选中「书源最多的一组」，见 §2.0.5 第 2 项的补充）。
>
> **好消息**：`scopeMode` 在 `searchStore.ts:179` 的 `initialSearchState` 里，**不落 localStorage**，
> 所以不存在「老用户的旧默认值要迁移」的问题，刷新即生效。这一点我核过了。



#### 2.1 P0 级

| # | 问题 | 证据 | 影响面 |
|---|---|---|---|
| **P0-1** | 默认搜索范围「全部书源」= 全库扫描，一次默认操作 ≈25 分钟 | `searchStore.ts:179`、`LibraryPage.tsx:100,213`、Lead 实跑 `selfcheck` 2 FAIL | **所有用户、每一次搜索** |
| **P0-2** | 体检结论不回灌书源列表，5598 条源在列表上无健康区分 | `api.ts:10` 无健康字段；`sourceHealthRun.ts:27` 只进 localStorage；`SourcesPage.tsx:190-195` 统计不含健康度 | 无法判断「哪个源能用」，直接压死从源到书的转化 |
| **P0-3** | `.primary-button` L398 仍是 `--accent`+`#fff`（夜读对比 1.54），靠 L4467 后置覆盖压住 | `styles.css:398` vs `4467`；令牌约定见 `styles.css:35-38` | 任何 CSS 重排/拆分即复燃为可访问性事故 |
| **P0-4** | `color: var(--text)` 无 fallback，`--text` 不存在 → 该声明整条作废 | `styles.css:4103`、`4107` | 体检基线提示条字色在暗色下不可控 |

> P0-3 / P0-4 都是**一行修复**，见 §3.1 Z1。

#### 2.2 P1 级

| # | 问题 | 证据 | 影响面 |
|---|---|---|---|
| **P1-1** | 书源列表无虚拟滚动，5598 条靠「点击加载更多」每次 +120（46 次） | `SourcesPage.tsx:25,141-146,562-566` | 海量数据下的浏览体验 |
| **P1-2** | 几何令牌采纳率低：`padding` 6.1%、`gap` 10.9%、`border-radius` 20.4%、`font-size` 31.0% | §1.2 逐项统计 | 无法做出「密度」这种整体可调项（见 §1.7 C1） |
| **P1-3** | 动效零令牌，21 个 `@keyframes` / 25 个 `animation` / 82 个 `transition` 各写各的时长缓动；同一曲线两种写法 | §1.3 六个抽样 | 无法提供「减少动效 / 动效速度」偏好 |
| **P1-4** | 暗色一致性：8 组裸 hex 徽标/状态色在 7 套皮肤下写死，暗色不可读 | §1.6（`664-667`、`2179-2182`、`2738-2739`、`3467-3499`、`4248-4287`） | 夜读/石墨下体检徽标、书籍类型、调试轨迹均失配 |
| **P1-5** | 自定义皮肤天花板 C1–C4：只能改色、只有 CSS 文本、不进备份、无导出导入 | §1.7 表 | 可塑性核心诉求未满足 |
| **P1-6** | **8 个**僵死令牌被引用但未定义（3 个无 fallback → 声明作废；5 个靠 fallback 苟活） | §1.6 末表；`styles.css:4103`、`4107`、`2163`、`1266`、`5771`、`5461`、`4099`、`1008`、`5179` | 主题化时改不动（改了没效果）；前 3 个是当前就生效的 bug |
| **P1-7** | 26 个含 `role="dialog"` 的文件里只有 3 个有 `autoFocus`，**0 个**做焦点归还 | §2.4 | 键盘用户关掉弹窗后焦点丢失回 `<body>` |
| **P1-8** | 触屏 `hover: none` 只覆盖 2 处，而全站大量 `:hover` | `styles.css:4793,5115` | 移动端 hover 态粘住 |
| **P1-9** | 断点五套并行（640/720/760/768/900），无分层 | §1.4 | 每次改响应式都要重新决定一次断点 |

#### 2.3 P2 级

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | 27 个选择器重复声明（`.md3-bottombar` 3 次、`.primary-button` 2 次等） | §1.5 |
| P2-2 | `localStorage` 14 key / 4 种前缀风格 / 版本后缀不一致 | §1.9 |
| P2-3 | 设置页「界面」分区文案写「晓白 / 护眼 / 夜读**三档**」，实为 7 套 | `settingsSections.ts:53` |
| P2-4 | 自定义皮肤无预览/无撤销/删除无确认 | `CustomizeModal.tsx:85-86,91-97` |
| P2-5 | 内联 `style={{…}}` 集中在 `ReplaceRulesModal.tsx`（40 处）、`SourceLoginModal.tsx`（12 处）、`ReaderScreen.tsx`（10 处） | 实测统计 |
| P2-6 | 自定义皮肤库无导入导出、无社区分享格式 | §1.7 C4 |

#### 2.4 可访问性专项（P1-7 的展开）

- 26 个 `.tsx` 含 `role="dialog"`；**24 个**接了 `useEscapeClose`（`lib/useEscapeClose.ts`，19 行）。
  Esc 覆盖是好的 —— `UiContract.test.ts:170-171` 在守它。
- 但**焦点管理几乎没有**：只有 3 个文件有 `autoFocus`（`SourceGroupModal.tsx:84`、
  `ShelfPage.tsx:1002`、`NoteToolbar.tsx:33`）。
- **零个文件**做「关闭后把焦点还给触发元素」（全文搜 `previousFocus|restoreFocus|returnFocus|lastFocused` → 0 命中）。
- `useEscapeClose` 本身也没有焦点管理，它只管 Esc。
- 影响：键盘/读屏用户每次关掉弹窗，焦点落回 `<body>`，下一次 Tab 从页面开头重新数。

#### 2.5 与 R3（`03-悬浮层延展.md`）的边界

**不在本文重复**、以 R3 为准的部分：

| 主题 | R3 章节 | 本文态度 |
|---|---|---|
| z-index 37 处字面量 → `--z-*` 令牌 | R3 §3.1–3.4 | 完全同意 R3 的结论 |
| **z-index 令牌化会击穿 `UiContract.test.ts:62-68/71-83`**（正则读字面数字） | R3 §3.3 | **同意，这是本次审计最关键的交叉发现**：R3 实测把 `z-index:26` 换成 `var()` 后 `bar` 回落 9999、`drawer` 回落 0，断言 `9999 < 0` 为假 |
| `OverlayHost` / `OverlayRegistry` | R3 §4 | 同意 |
| AI 悬浮球三处（宽度被 `.dialog-shell` 覆盖、层级 900/901 与注释矛盾、空断言） | R3 §7.1 | 同意；补充见下 |

**我独立复核并确认的补充：** `AiFloatingBall` 在 **`main.tsx:646`** 挂载，但 `main.tsx:476-495`
的**阅读器分支是早期 `return`**，那条分支里只挂了 `ToastContainer` / `ContextMenuLayer` /
`ErrorBoundary` / `ReaderScreen` —— **没有 `AiFloatingBall`**。
所以「随时随地使用」（该组件测试 `AiFloatingAssistant.test.ts:12` 声明的目标）在**阅读器里不成立**。
这正好落在用户原话「不能在对应地点研究」上：**最需要问 AI 的地方就是读到一半的正文**。
（这一点 R3 §7.1 列为「阶段 2 之后可做」，但它是**功能缺失**而非增强，建议提到阶段 0。）

---

### 3. 优化方案（三档：零风险 / 需改闸门 / 架构级）

#### 3.1 Z 档 —— 零风险（不改测试、不改行为、纯收编）

这一档的特征：**纯替换或纯删除，视觉与行为零变化**，随时可做、可单独 review。

##### Z1【P0，一行×4】修掉会随时复燃的对比度引线与无效声明

```css
/* styles.css:398 —— 删掉这条（它是 L4467 的前身，靠后置覆盖活着）。
   直接删除，让 L4467 成为唯一来源。 */
- .primary-button { background: var(--accent); color: #fff; }
```

```css
/* styles.css:4103、4107 —— --text 不存在，声明作废。改回真实令牌。 */
- color: var(--text);
+ color: var(--ink);
- color: var(--accent, var(--text));
+ color: var(--accent, var(--ink));
```

**验收**：`node --test` 全绿（这两处无判据覆盖，属纯修复）；
手工在夜读下确认 `.primary-button` 仍为 `--accent-solid` + `--on-accent`。

##### Z2【P1-6】收编 8 个僵死令牌

按「有无 fallback」分成两组，**前三个是当下就生效的 bug，必须先修**。

| 令牌 | 引用处 | 处理 |
|---|---|---|
| `--ink-soft` | `styles.css:1266`、`5771` | **在 `:root` 补定义** `--ink-soft: var(--muted);` → 现有 fallback `#444` 自然失效 |
| `--ink-dim` | `styles.css:2163` | 补 `--ink-dim: var(--muted);` |
| `--t-s` | `styles.css:2163` | **手误，应为 `--t-sm`**。该行 `font-size` 当前整条作废（无 fallback），改回 `var(--t-sm)` 是**修 bug** |
| `--warn` | `styles.css:5461` | 补 `--warn: #b8860b;`（与现有 fallback 同值，零视觉变化） |
| `--accent-line` | `styles.css:4099` | 已有 fallback `var(--line)`，**直接删掉 `--accent-line` 引用**，写 `var(--line)` |
| `--ctl-34` | `styles.css:1008` | 已有 fallback `34px` = `--ctl` 的值（`styles.css:4523`）→ 改 `var(--ctl)` |
| `--ctl-md` | `styles.css:5179` | fallback `38px` 无对应档 → **新增 `--ctl-md: 38px`** 或收编为 `--ctl-lg`（40px），**取前者**（零视觉变化） |

##### Z3【P1-2】字面量 → 令牌的无视觉替换（**只做三类，不含 `padding`**）

**只替换「值与某个令牌逐字符相等」的声明**，这是可机械验证的：

| 目标 | 替换规则（**只认值完全相等**的声明） | 实测可替换条数 |
|---|---|---:|
| `font-size` | `11px→--t-xs`(71) `12px→--t-sm`(123) `13px→--t-md`(98) `14px→--t-lg`(30) `15px→--t-xl`(11) `19px→--t-2xl`(2) | **335** |
| `border-radius` | `6px→--r-1`(65) `8px→--r-2`(36) `12px→--r-3`(9) `16px→--r-4`(2) `999px→--r-pill`(16) | **128** |
| `gap` | `4px→--s-1`(38) `8px→--s-2`(88) `12px→--s-3`(39) `16px→--s-4`(15) `20px→--s-5`(6) `28px→--s-6`(1) | **187** |
| | **合计** | **650** |

> 这三组数字是按「`属性: 单一值;` 且值与某个令牌**逐字符相等**」精确统计的，
> 不含 `gap: 8px 12px` 这类多值（9 处，需人工判断）与 `border-radius: 6px 6px 0 0` 这类
> 单边圆角。**先做这 650 处，剩下的再逐个议。**

**验证方法（不需要跑浏览器）**：替换前后各跑一次「把所有 `var(--t-*)`/`var(--r-*)`/`var(--s-*)`
按 `:root` 定义展开」的脚本，比对结果字符串 —— **必须逐字节相同**。这比截图比对可靠。

**为什么这一步必须做**：它是 §4「密度 / 圆角偏好」的**前置条件**。不做这步，
`--r-*` / `--s-*` 的消费者只有 62 + 52 处，改令牌等于改不动界面。

##### Z4【P2-3】修文案漂移

`settingsSections.ts:53`：`'晓白 / 护眼 / 夜读三档，外加一份只存在本机浏览器的自定义 CSS。'`
→ 改为不写死数量的表述（写死数量必然再次漂移，且 `CopyStyle.test.ts` 只禁装饰字形，不禁这句）：

```ts
hint: '内置多套配色，外加一个只存在本机浏览器的自定义皮肤库：可增删、可切换、可叠在任一套内置配色之上。',
```

##### Z5【P2-5】`ReplaceRulesModal.tsx` 的 40 处内联样式收编

这是**全站最大的一处内联样式集中地**（40 处，占全站 16 个文件的 40%）。
零风险做法：把它们改成语义类名 + 样式表规则。**但注意** `UiContract.test.ts:449-469` 会扫
「TSX 里挂的类名必须在样式表里有规则」—— 所以**新增类名必须同时加样式规则**，
否则那条判据会红。这不是风险，是它本来就该守的东西。

##### Z6【P1-8】触屏 hover 补齐

`styles.css:4793`、`5115` 已有两处 `@media (hover: none)`。把**会造成粘滞的 hover 态**
（`shelf-card:hover` 上浮 `styles.css:692`、`source-list button:hover` 等）加进同一个块：

```css
@media (hover: none) {
  .shelf-card:hover { transform: none; box-shadow: none; border-color: var(--line); }
  .source-list button:hover { background: transparent; }
  /* …按全站 :hover 清单逐条判定，只关「位移/放大」类，保留「显色」类 */
}
```

#### 3.2 G 档 —— 需改测试闸门（必须同步提交）

**这一档的每一条都必须 `test/*.test.ts` 与实现同一提交**，否则 CI 必红。

##### G1【P1-3】动效令牌 —— 新增 4 个令牌，零判据冲突

**先给好消息**：动效令牌化**不会**碰到 `UiContract.test.ts` 的任何一条（它只读 `z-index` 与浮层几何）。
所以这是**比 z-index 令牌化更容易落地**的一个令牌维度 —— 与 R3 §3.3 的结论正好互补。

```css
/* styles.css :root（追加到 L4515 那个块末尾） */
:root {
  /* 动效：三档时长 + 一条主缓动 + 一条入场缓动。
     现有的 cubic-bezier(.16,1,.3,1) 与 cubic-bezier(0.16, 1, 0.3, 1) 是同一曲线，收成一条。 */
  --dur-fast: .18s;   /* 遮罩淡入、hover 反馈 */
  --dur-base: .25s;   /* 抽屉、悬浮条、页面进入 */
  --dur-slow: .4s;    /* 仅用于刻意强调，默认不用 */
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-soft: cubic-bezier(.25, 1, .5, 1);
}
```

替换映射（证据见 §1.3 抽样表）：

| 位置 | 原值 | 改为 |
|---|---|---|
| `styles.css:4577` 页面进入 | `.26s cubic-bezier(.16, 1, .3, 1)` | `var(--dur-base) var(--ease-out)` |
| `styles.css:961` 抽屉 | `.25s cubic-bezier(0.25, 1, 0.5, 1)` | `var(--dur-base) var(--ease-soft)` |
| `styles.css:5727` 弹窗 | `.2s cubic-bezier(0.25, 1, 0.5, 1)` | `var(--dur-fast) var(--ease-soft)` |
| `styles.css:5711` 遮罩 | `.18s ease` | `var(--dur-fast) ease` |
| `styles.css:1368` 移动端菜单 | `.22s cubic-bezier(0.16, 1, 0.3, 1)` | `var(--dur-base) var(--ease-out)` |

`styles.css:4580-4582` 的 `prefers-reduced-motion` 全站兜底**保持不动**，它已经是对的。

**需要新增判据**（建议加到 `UiContract.test.ts` 或新建 `MotionTokens.test.ts`）：

```ts
test('动效时长与缓动只从令牌取，不许再写字面量', () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // 只查 transition/animation 的「时长」位，允许 0s/.01ms（reduced-motion 兜底）
  const offenders: string[] = []
  for (const m of bare.matchAll(/(?:^|[;{])\s*(?:transition|animation)(?:-duration)?:\s*([^;}]+)/g)) {
    const value = m[1]
    if (/var\(--dur-/.test(value)) continue
    if (/\b0(?:\.01)?m?s\b/.test(value) && !/\b[1-9]/.test(value)) continue  // 0s / .01ms 兜底放行
    if (/\b(?:\.\d+|\d+)m?s\b/.test(value)) offenders.push(value.trim())
  }
  assert.deepEqual(offenders, [], '这些动效还在写字面量时长：' + offenders.join(' | '))
})
```

##### G2【P1-5 → 可塑性核心】主题包：从「CSS 文本」升级为「结构化 schema」

这一条**不删任何现有能力**，是**加一层**：保留 `css: string`（高级用户仍然直接写 CSS），
同时允许一套皮肤**用声明式令牌覆盖**来描述（普通用户用表单点）。

```ts
// 新增文件：web/src/reader/themeTokens.ts  （camelCase，非 JSX，符合 frontend-conventions §1.2）

/**
 * 可被主题包覆盖的令牌白名单。
 *
 * 为什么是白名单而不是「任意 CSS 变量」：主题包要能被校验、能跨机器迁移、
 * 能被 UI 表单逐个渲成控件。开放成任意变量名就等于回到「一整块 CSS 文本」，
 * 那样 C2/C3/C4 三个天花板一个都没解决。
 *
 * 这份清单**只包含已有定义的令牌**（styles.css:40-46 的 16 个主题色 + :root 的尺度令牌），
 * 新增令牌要同步加到这里；反过来，这里出现 styles.css 里没有的令牌会被判据逮住。
 */
export type ThemeTokenKey =
  // —— 配色（每套皮肤都该给全，缺的从 base 继承）——
  | 'canvas' | 'surface' | 'surfaceMuted' | 'ink' | 'muted' | 'line'
  | 'accent' | 'accentSoft' | 'accentInk' | 'accentSolid' | 'accentSolidHover'
  | 'onAccent' | 'danger' | 'dangerSolid' | 'onDanger' | 'shadow'
  // —— 形状与密度（这是现在完全不能改的那部分，见 §1.7 C1）——
  | 'radiusSm' | 'radiusMd' | 'radiusLg' | 'radiusPill'
  | 'spaceUnit' | 'rowHeight' | 'controlHeight'
  | 'fontScale'          // 缩放 --t-xs..--t-3xl 的系数，1 = 不变
  // —— 动效 ——
  | 'durationScale'      // 缩放 --dur-*，0 = 全部即时（等价于 reduced-motion）
  | 'easing'

/** 令牌名 → 实际 CSS 变量名。一处映射，消费处只读这里。 */
export const THEME_TOKEN_VARS: Record<ThemeTokenKey, string> = {
  canvas: '--canvas', surface: '--surface', surfaceMuted: '--surface-muted',
  ink: '--ink', muted: '--muted', line: '--line',
  accent: '--accent', accentSoft: '--accent-soft', accentInk: '--accent-ink',
  accentSolid: '--accent-solid', accentSolidHover: '--accent-solid-hover',
  onAccent: '--on-accent', danger: '--danger', dangerSolid: '--danger-solid',
  onDanger: '--on-danger', shadow: '--shadow',
  radiusSm: '--r-1', radiusMd: '--r-2', radiusLg: '--r-3', radiusPill: '--r-pill',
  spaceUnit: '--s-1', rowHeight: '--row-h', controlHeight: '--ctl',
  fontScale: '--theme-font-scale', durationScale: '--theme-duration-scale', easing: '--ease-out',
}

/** 一个主题包：可导出、可导入、可版本化。 */
export type ThemePack = {
  /** 格式自身版本。导入时要认它，未来改字段不至于把老包读坏。 */
  spec: 1
  id: string                 // parseSkinId 白名单，拼成 .theme-<id>
  name: string               // ≤40 字
  /** 叠在哪一档内置皮肤之上（沿用现有语义，见 themeClassNames）。 */
  base: BuiltinSkinId
  /** 声明式令牌覆盖：只写想改的，其余从 base 继承。 */
  tokens?: Partial<Record<ThemeTokenKey, string>>
  /** 高级用户/历史数据：整段 CSS，仍然支持，优先于 tokens 之后注入。 */
  css?: string
  /** 出处，导出时写上，导入时原样保留 —— 社区分享靠它署名，不参与任何逻辑。 */
  author?: string
  /** 给人看的说明。 */
  description?: string
}
```

**与现有类型的兼容（关键：不破坏任何既有判据）**：

```ts
// readerSettings.ts —— CustomSkin 保持不变（CustomizeSkin.test.ts 直接断言它的形状），
// 只**增补**两个可选字段，并把 ThemePack 视为 CustomSkin 的超集。
export type CustomSkin = {
  id: string
  name: string
  css: string
  base: BuiltinSkinId
  /** 新增：声明式令牌。为空/缺省时行为与改动前逐字相同。 */
  tokens?: Partial<Record<ThemeTokenKey, string>>
  /** 新增：出处与说明，纯展示。 */
  author?: string
  description?: string
}
```

**为什么这样能不破闸门**：`CustomizeSkin.test.ts:80-89` 断言的 `parseCustomSkins` 输出形状里
没有 `tokens` 字段 —— 但它是 `assert.deepEqual` **对整对象**比对的。所以
`parseCustomSkin` **必须在没有 tokens 时不要输出 `tokens: undefined`**（`deepEqual` 认为
`{a:1}` 与 `{a:1,b:undefined}` 不同）。实现时用条件展开：

```ts
return {
  id, name, css, base,
  ...(tokens && Object.keys(tokens).length ? { tokens } : {}),
}
```

**这是本方案唯一需要动 `CustomizeSkin.test.ts` 的地方，而且只是「加一条新用例」而不是改旧断言** ——
旧断言因为是 `deepEqual` 且新字段被条件排除，**自动继续通过**。

**注入实现（改 `main.tsx:76-97` 的 `SkinStyle`，保持 textContent 一条路）**：

```ts
function SkinStyle({ settings }: { settings: ReaderSettings }) {
  const active = activeCustomSkin(settings)
  const id = active?.id ?? ''
  // 声明式令牌 → CSS 文本；css 字段原样跟在后面（后者胜，兼容现有用户）
  const css = (active ? composeSkinCss(active) : '').trim()
  // …以下与现在逐字相同（createElement + textContent + 固定 id）
}

/** 把一套皮肤的 tokens + css 合成最终 CSS 文本。纯函数，可直接单测。 */
export function composeSkinCss(skin: CustomSkin): string {
  const rules: string[] = []
  const decls = Object.entries(skin.tokens ?? {})
    .filter(([key]) => key in THEME_TOKEN_VARS)
    .map(([key, value]) => `${THEME_TOKEN_VARS[key as ThemeTokenKey]}: ${sanitizeTokenValue(key as ThemeTokenKey, value)};`)
  if (decls.length) rules.push(`.theme-${skin.id} { ${decls.join(' ')} }`)
  if (skin.css?.trim()) rules.push(skin.css)
  return rules.join('\n')
}
```

**`sanitizeTokenValue` 是必须的**：`tokens` 会被拼进 CSS 声明值。规则：
颜色类只认 `#rgb/#rrggbb/#rrggbbaa` 或 `oklch()/color-mix()` 白名单前缀；
尺寸类只认数字 + `px/em/rem/%`；`shadow` 只认不含 `}` `;` `{` 的串。
**所有值一律剥掉 `{ } ; < >` 与换行**（与 `parseCustomFont`（`readerSettings.ts:193-196`）同一套思路）。

**新增判据**（建议 `ThemePack.test.ts`）：

```ts
test('主题包令牌白名单与样式表同步：不能声明样式表里不存在的令牌', () => {
  const cssText = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
  const missing = Object.values(THEME_TOKEN_VARS)
    .filter(varName => !new RegExp(`${varName}\\s*:`).test(cssText))
  assert.deepEqual(missing, [], `THEME_TOKEN_VARS 里有样式表根本没定义的令牌：${missing.join('、')}`)
})

test('主题包注入仍走 textContent，且令牌值被清洗', () => {
  const css = composeSkinCss({ id: 'x', name: '', base: 'light', css: '',
    tokens: { canvas: '#0f1213', accentSolid: '}</style><script>' } })
  assert.ok(!css.includes('<'), '令牌值必须剥掉能拼出新标签的字符')
})
```

##### G3【P1-7】焦点归还 —— 给 `useEscapeClose` 配一个兄弟 hook

**零判据冲突**（没有任何测试在管焦点），但**必须确认不破坏 `UiContract.test.ts:170-171`**
（它数 `useEscapeClose(` 的出现次数，新增 hook 不影响）。

```ts
// 新增：web/src/lib/useOverlayFocus.ts
import { useEffect, useRef } from 'react'

/**
 * 浮层的焦点契约（useEscapeClose 管 Esc，这里管焦点）。
 *
 * 现状：26 个含 role="dialog" 的文件里只有 3 个写了 autoFocus，**零个**归还焦点。
 * 键盘用户关掉弹窗后焦点落回 <body>，下一次 Tab 从页面开头重新数。
 *
 * 做三件事：
 * ① 打开时把焦点移进浮层（优先第一个可聚焦元素，退到容器本身）；
 * ② Tab / Shift+Tab 在浮层内循环，不跑到背后的页面上；
 * ③ 关闭时把焦点还给打开它的那个元素。
 */
export function useOverlayFocus<T extends HTMLElement>(active = true) {
  const ref = useRef<T>(null)
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    // ① 记住是谁打开的（此刻的 activeElement），关闭时还回去
    restoreTo.current = document.activeElement as HTMLElement | null
    const node = ref.current
    if (!node) return

    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null)

    // 已经不在这里面才移焦 —— 尊重组件自己写的 autoFocus
    if (!node.contains(document.activeElement)) {
      (focusables()[0] ?? node).focus()
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { event.preventDefault(); node.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const at = document.activeElement
      if (event.shiftKey && (at === first || at === node)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && at === last) { event.preventDefault(); first.focus() }
    }
    node.addEventListener('keydown', onKey)

    // ③ 卸载时归还
    return () => {
      node.removeEventListener('keydown', onKey)
      const back = restoreTo.current
      if (back && document.contains(back)) back.focus()
    }
  }, [active])

  return ref
}
```

**落地节奏（不要一次改 26 个文件）**：先改 **`main.tsx` 的 8 个单例弹窗**
（`CustomizeModal` / `LogsModal` / `ShortcutHelp` / `ServerPortModal` / `ChangelogModal` /
`BackupModal` / `AboutModal` / `ReadingLogModal`），因为它们是「从顶栏/设置点开、关掉回原处」
的最典型路径；验证后再推其余。

> ⚠️ **一个必须注意的冲突**：`ShelfPage.tsx:1002`、`SourceGroupModal.tsx:84`、`NoteToolbar.tsx:33`
> 已有 `autoFocus`。上面的实现特意先判 `node.contains(document.activeElement)`，
> **已有 autoFocus 的组件行为不变**。

##### G4【P1-9】断点收敛 —— 需要「先测量再决定」

不建议凭感觉删断点。可执行路径：

1. 用一次 `*-census.mjs` 风格的普查脚本，在真 Chrome 里以
   `320 / 375 / 414 / 640 / 720 / 768 / 900 / 1024 / 1280 / 1440 / 1920` 十一档宽度截图，
   标出**每个断点在哪一档真正改变布局**。
2. 按结果把 `640/720` 设为主断点（二者已有 13+11 处使用），把 `760/768/900/420` 的 5 处规则
   **迁移到最近的主动断点**，然后删除这三个断点。
3. 新增判据（防止长回来）：

```ts
test('宽度断点只许 640 / 720 / 960 / 1200 四档', () => {
  const found = [...bareCss.matchAll(/@media \((?:max|min)-width:\s*(\d+)px\)/g)].map(m => Number(m[1]))
  const ALLOWED = new Set([640, 720, 960, 1200])
  const extra = [...new Set(found)].filter(px => !ALLOWED.has(px))
  assert.deepEqual(extra, [], `出现了未登记的断点：${extra.join('、')}px（先加进 ALLOWED 并写清语义）`)
})
```

> 这条判据**要跟 D 档的迁移一起提交**，单独提交会立刻红。

#### 3.3 A 档 —— 架构级（需要排期，不建议本迭代做）

| # | 方案 | 为什么是架构级 | 前置 |
|---|---|---|---|
| **A1** | **书源健康度进 `/api/sources`**：`SourceSummary` 加 `health?: { tier: HealthTier; checkedAt: number; latencyMs?: number }` | 要动 Kotlin（`SourcesRoutes` + DAO）与 `ApiCatalog.test.ts` 的契约核对；它是 P0-2 的唯一根治手段 | 无（但需后端配合） |
| **A2** | **书源列表虚拟滚动** | 现有 `useDragSort`（`sources/shelf/dragSort.ts`）依赖真实 DOM 行做指针命中，虚拟化后拖拽排序要重写命中逻辑 | 先决定「虚拟滚动 or 分页」 |
| **A3** | **搜索分层：先健康源、后慢源** | 要 `searchStore` 支持「两阶段搜索」：先发一个只含健康源的 `sourceIds`，再补一次全量。涉及 WS 协议或两次连接 | A1（要健康度） |
| **A4** | **偏好统一存储层** | 把 14 个 key 收进 `lib/preferences.ts`，带命名规范 + 版本 + 白名单（导出用） | Z/G 档落完 |
| **A5** | **`OverlayHost`** | 见 R3 §4 | R3 阶段 1 |

**A1 的接口草图**（给后端同学看的最小改动）：

```ts
// api.ts:10 —— 只增字段，不动既有字段（ApiCatalog 契约按端点核，不按响应字段核，故不破闸门）
export type SourceSummary = {
  id: string; name: string; url: string; group?: string
  enabled: boolean; isJsSource: boolean; hasLogin: boolean
  updatedAt: number; version: number
  sortOrder?: number | null
  /** 最近一次体检结论。`null`/缺省 = 从没测过（UI 要区分「没测」与「测了正常」）。 */
  health?: { tier: HealthTier; checkedAt: number; latencyMs?: number } | null
}
```

有了它，书源列表就能做**排序、筛选、徽标**，`/api/sources` 的 5,598 行才第一次变得可治理。

---

### 4. 可塑性设计方案（具体接口草图）

#### 4.1 三层用户偏好模型

把「可塑性」拆成三个**互不混淆**的层，分别给不同的 UI 与存储：

```ts
// 新增：web/src/lib/appearance.ts  （非 JSX → camelCase，符合 frontend-conventions §1.2）

/**
 * 外观偏好：**产品形态**，与「读一本书的排版」不是一回事。
 *
 * 分层理由：
 * ① 主题（ThemePack）—— 「长什么样」：配色、圆角、密度、动效速度。
 *    可导出成文件、可在社区分享、可整体回滚。
 * ② 布局（LayoutPrefs）—— 「东西摆哪」：书架/搜索结果的版式、侧栏宽、目录固定。
 *    已有实现（shelfLayout.ts），本次只做收编。
 * ③ 阅读（ReaderSettings）—— 「正文怎么排」：字号、行距、缩进、字体。
 *    已有实现（readerSettings.ts），**本次不动**。
 *
 * 三者分开存的好处：换主题不该动我的字号；换布局不该动我的配色。
 * 现在 theme 混在 ReaderSettings 里（readerSettings.ts:41），这三层是糊在一起的。
 */
export type AppearancePrefs = {
  spec: 1
  /** 当前主题包 id；命中 customSkins 时走自定义，否则是内置档之一。 */
  themeId: string
  /** 用户级密度：叠加在主题包之上的一个整体缩放。 */
  density: 'compact' | 'cozy' | 'comfortable'
  /** 用户级圆角：不选 = 跟随主题包。 */
  radius: 'theme' | 'square' | 'soft' | 'round'
  /** 动效：respect-os 跟随系统 reduced-motion，off 全关，reduced 砍半。 */
  motion: 'respect-os' | 'full' | 'reduced' | 'off'
  /** 界面字号缩放（只影响界面，不影响阅读正文）。 */
  uiScale: number   // 0.9 | 1 | 1.1 | 1.25
}
```

**存储键（新规范，一次定死）**：

```ts
// web/src/lib/preferences.ts
/**
 * 存储键规范（本次定死，新键一律遵守；旧键靠迁移函数收编，不强行改名以免丢数据）：
 *   qingyue.<领域>.<用途>.v<整数>
 *
 * 为什么现在要定：现有 14 个 key 有 4 种前缀风格（legado- / legado_ / legado. / qingyue- / 无前缀），
 * 「导出我的偏好」这件事根本没法自动判断哪些该导。见 02 文档 §1.9。
 */
export const PREF_KEYS = {
  appearance: 'qingyue.appearance.v1',
  themePacks: 'qingyue.theme.packs.v1',
  layout:     'qingyue.layout.v1',
  reader:     'qingyue.reader.settings.v2',   // 迁移自 legado-reader-settings-v2
} as const

/** 旧键 → 新键的一次性迁移表。`load` 路径调用 migrateLegacyKeys() 即可。 */
const LEGACY: Record<string, string> = {
  'legado-reader-settings-v2': PREF_KEYS.reader,
  'legado-shelf-layout-v2':    PREF_KEYS.layout,
  'qingyue-window-prefs-v1':   'qingyue.window.prefs.v1',
  // …按需补
}
```

> **注意**：改存储键是**有数据风险**的动作。安全做法是「**读旧、写新、不删旧**」：
> 迁移函数把旧值搬进新键后**保留旧键至少一个版本**，确认无回退再删。
> 不要在没有迁移函数的情况下直接改 `storageKey`（`readerSettings.ts:126`）。

#### 4.2 主题包 schema（完整、可导出/导入）

已在 §3.2 G2 给出 `ThemePack` / `ThemeTokenKey` / `THEME_TOKEN_VARS` 与 `composeSkinCss`。
这里补**导出/导入**与**密度/圆角的 CSS 落地**。

##### 导出/导入

```ts
// web/src/reader/themePackFile.ts
/** 导出格式：单个主题包 → .qingyue-theme.json */
export function exportThemePack(skin: CustomSkin): string {
  const pack: ThemePack = {
    spec: 1, id: skin.id, name: skin.name, base: skin.base,
    ...(skin.tokens ? { tokens: skin.tokens } : {}),
    ...(skin.css?.trim() ? { css: skin.css } : {}),
    ...(skin.author ? { author: skin.author } : {}),
    ...(skin.description ? { description: skin.description } : {}),
  }
  return JSON.stringify(pack, null, 2)
}

/** 导入：任何字段不合法就整包拒绝，并说清是哪一条 —— 不做"尽力而为"的半套皮肤。 */
export type ThemePackImportResult =
  | { ok: true; skin: CustomSkin }
  | { ok: false; errors: string[] }

export function importThemePack(text: string): ThemePackImportResult {
  const errors: string[] = []
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, errors: ['不是合法 JSON'] } }
  const pack = raw as Partial<ThemePack>
  if (pack.spec !== 1) errors.push(`主题包版本是 ${String(pack.spec)}，这个版本只认 spec: 1`)
  const id = parseSkinId(pack.id)
  if (!id) errors.push('id 清洗后为空（只允许字母、数字、- 和 _）')
  if (!pack.name?.trim()) errors.push('缺少名字')
  const base = parseSkinBase(pack.base)
  if (!pack.tokens && !pack.css?.trim()) errors.push('既没有 tokens 也没有 css，套上去看不出任何效果')
  // 令牌逐个校验：未知键、非法值都报出来，不静默丢
  for (const [key, value] of Object.entries(pack.tokens ?? {})) {
    if (!(key in THEME_TOKEN_VARS)) { errors.push(`未知令牌 ${key}`); continue }
    if (!isLegalTokenValue(key as ThemeTokenKey, value)) errors.push(`令牌 ${key} 的值不合法：${String(value)}`)
  }
  if (errors.length) return { ok: false, errors }
  return { ok: true, skin: {
    id, name: pack.name!.trim().slice(0, 40), base,
    css: typeof pack.css === 'string' ? pack.css.slice(0, 20000) : '',
    ...(pack.tokens ? { tokens: pack.tokens } : {}),
    ...(pack.author ? { author: String(pack.author).slice(0, 40) } : {}),
    ...(pack.description ? { description: String(pack.description).slice(0, 200) } : {}),
  } }
}
```

**导入 UI 的门禁约束**：`CustomizeModal.tsx` 是 `.dialog-shell size-s`，
**不许在 TSX 里写像素宽高**（`UiContract.test.ts:154-163`）。
导入/导出按钮放进现有的 `.customize-actions`（`CustomizeModal.tsx:231-237`）即可，无需新壳。

##### 密度与圆角的 CSS 落地（这是 §1.7 C1 的答案）

```css
/* 追加到 styles.css 的设计系统区块（L4515 那个 :root 之后） */

/* —— 密度：只有一档开关，改的是「刻度」而不是「逐条覆盖」——
   这就是为什么 §3.1 Z3 的令牌替换是前置条件：
   没有那 650 处替换，这一节改了也没有消费者。 */
:root {
  --density-scale: 1;           /* compact=0.85 / cozy=1 / comfortable=1.15 */
  --r-scale: 1;                 /* square=0 / soft=1 / round=1.6 */
}
:root[data-density="compact"]     { --density-scale: .85; }
:root[data-density="comfortable"] { --density-scale: 1.15; }
:root[data-radius="square"] { --r-scale: 0; }
:root[data-radius="round"]  { --r-scale: 1.6; }

/* 令牌自身乘上比例：一处改，全站跟。 */
:root {
  --s-1: calc(4px  * var(--density-scale));
  --s-2: calc(8px  * var(--density-scale));
  --s-3: calc(12px * var(--density-scale));
  --s-4: calc(16px * var(--density-scale));
  --s-5: calc(20px * var(--density-scale));
  --s-6: calc(28px * var(--density-scale));
  --s-7: calc(40px * var(--density-scale));
  --row-h:      calc(48px * var(--density-scale));
  --row-h-list: calc(40px * var(--density-scale));
  --ctl-sm: calc(30px * var(--density-scale));
  --ctl:    calc(34px * var(--density-scale));
  --ctl-lg: calc(40px * var(--density-scale));
  --r-1: calc(6px  * var(--r-scale));
  --r-2: calc(8px  * var(--r-scale));
  --r-3: calc(12px * var(--r-scale));
  --r-4: calc(16px * var(--r-scale));
}
```

> ⚠️ **`--r-pill` 不参与 `--r-scale`**：`999px` 是「胶囊」语义，乘 0 会变成直角，
> 那就不是胶囊了。保持 `--r-pill: 999px` 常量。

> ⚠️ **必须在 `:root` 上改 `--s-*` 等令牌的「定义」，不能在末尾"再定义一次"**。
> 现有 `styles.css:4515` 已经定义过 `--s-*`，再写一遍会重复声明（`styles.css` 已有 27 个
> 选择器重复声明，见 §1.5）。**正确做法是就地改写 L4519-4523 那几行**。

##### 4.2.1 落地到 `main.tsx`（沿用现有 `<html>` 挂载点）

```tsx
// main.tsx —— 现有 effect（L122-127）扩两行，不动结构
useEffect(() => {
  const root = document.documentElement
  const stale = [...root.classList].filter(name => name.startsWith('theme-'))
  if (stale.length) root.classList.remove(...stale)
  root.classList.add(...themeClassNames(settings))
  // 新增：密度/圆角/动效是**根级属性**，不是主题类 —— 它们与皮肤正交，
  // 所以走 data-* 而不是再加一个 theme-* 类（theme-* 是「哪一套配色」的语义）。
  root.dataset.density = appearance.density
  root.dataset.radius = appearance.radius
  root.dataset.motion = appearance.motion
}, [skinClasses, appearance.density, appearance.radius, appearance.motion])
```

动效档位相应加一条（与现有 `reduced-motion` 兜底并存，不冲突）：

```css
/* 用户显式关动效，与操作系统的 reduced-motion 同等效力；两者取并集。 */
:root[data-motion="off"] *,
:root[data-motion="off"] *::before,
:root[data-motion="off"] *::after {
  animation-duration: .01ms !important;
  transition-duration: .01ms !important;
}
:root[data-motion="reduced"] { --dur-fast: .09s; --dur-base: .12s; }
```

#### 4.3 「不新增第二套外壳」纪律的遵守说明

本方案**不新增任何浮层外壳/遮罩/关闭键**（`UiContract.test.ts:290-293` 的硬约束）。
- 皮肤库的编辑/导入 UI **全部复用现有** `.customize-dialog`（`CustomizeModal.tsx:103`）；
- 密度/圆角/动效的控件放进**现有**设置页「界面」分区（`settingsSections.ts:49-57`），
  该分区现在是 `SettingsSection`，只加 `rows`，不新增弹窗；
- 所有新类名**必须同时有样式规则**（`UiContract.test.ts:449-469` 会扫）。

#### 4.4 与 `CopyStyle.test.ts` 的约束

本方案的界面文案**不使用任何装饰字形**：
- 不用 `✓ ✕ ● ○ ▸ ‹ › ⟳` 等（`CopyStyle.test.ts:16-20` 按码位硬编码禁用）；
- 图标一律走现有 `<Icon name="…">`（`icons.tsx`，单色 SVG）；
- 新写的提示语不用「手机上…」口径（`BANNED_PHONE_PHRASES`）、不用半角括号混中文、不用 `...`（用 `…`）。
- ✅ 一个具体检查点：§4.2 的「导入成功」提示建议写
  `已导入皮肤「画眉」，可在这台浏览器的「自定义」里切换。` —— 无字形、无半角括号、无三个点。

---

### 5. 优先级表与排序结论

#### 5.1 「性能/规模」vs「主题可塑性」：我同意 Lead 的判断

**结论：性能 / 规模优先，且不是小幅领先，是量级差。**

独立复核的依据（不是因为 Lead 说了才同意）：

| 维度 | 性能/规模（§2.0） | 主题可塑性（§1.7） | 谁更痛 |
|---|---|---|---|
| **受影响用户比例** | **100%**：默认范围就是「全部书源」，每次搜索都踩 | 少数：喜欢换肤/换密的用户 | 性能 |
| **单次损失** | 约 **25 分钟**等待，且 `selfcheck` 2 项 FAIL 证明**默认路径走不通** | 无损失，只是「没得选」 | 性能 |
| **是否阻塞核心价值** | **是**：从书源到内容的转化链断在这里（书架 3 本 / 订阅 0） | **否**：7 套皮肤已经够日常用 | 性能 |
| **修复成本** | 界面侧小改（默认范围 + 成本提示 + 健康源优先） | 需 650 处令牌替换打底 | 可塑性反而更贵 |
| **有无既定基线被打破** | 有：`selfcheck` 是发布红线（`gates-guide.md` §2），现在红着 | 无 | 性能 |
| **可塑性是否被性能挡住** | — | **是**：密度/圆角令牌化做完，用户仍要等 25 分钟才能搜到书，没人会去调圆角 | — |

**一句话：主题可塑性是「锦上添花」，规模治理是「雪中送炭」。**
把 Z/G 档的可塑性工作排进**同一个迭代的后半段**是合理的（它们互不阻塞），
但**不能**把 P0 的量级问题往后放。

**唯一的、有理由的例外**：**§3.1 Z1（`--accent` 对比度引线 + `var(--text)` 无效声明）**
应当**立即做**，与性能问题并行 —— 因为它是一行改动、零风险，且留着就是随时复燃的可访问性事故。

#### 5.2 优先级表

| 优先级 | 编号 | 事项 | 档位 | 估算 | 依赖 |
|---|---|---|---|---|---|
| **P0** | Z1 | 修 `.primary-button` 引线 + `var(--text)` 无效声明 | 零风险 | **0.5h** | 无 |
| **P0** | Z2 | 收编 8 个僵死令牌（其中 3 个是当前生效的 bug） | 零风险 | **1h** | 无 |
| **P0** | — | 搜索默认范围改为「按分组」或「健康源优先」；搜索前显示「将搜索 N 个源，约 X 分钟」 | 需产品决策 | **1–2d** | 无（纯前端） |
| **P0** | A1 | `SourceSummary` 加 `health` 字段（后端） | 架构级 | **1–2d** | 后端排期 |
| **P0** | 前端配套 | 书源列表健康度徽标 + 「只搜健康源」+ 按健康度排序 | 需 A1 | **2d** | A1 |
| **P1** | Z3 | 字面量 → 令牌（650 处），机械替换 + 逐字节验证 | 零风险 | **1d** | 无 |
| **P1** | G1 | 动效令牌（5 令牌 + 5 处替换 + 1 条新判据） | 需加判据 | **0.5d** | Z3 无关，可并行 |
| **P1** | G3 | `useOverlayFocus` + 8 个单例弹窗接入 | 需加 hook | **1d** | 无 |
| **P1** | G2 | 主题包 schema + composeSkinCss + 导入导出 + 判据 | 需加判据 | **3d** | Z3（密度部分） |
| **P1** | A2 | 书源列表虚拟滚动 | 架构级 | **2–3d** | 先决定虚拟化 vs 分页 |
| **P2** | Z4 | 修设置页「三档」文案漂移 | 零风险 | **0.2h** | 无 |
| **P2** | Z5 | `ReplaceRulesModal` 40 处内联样式收编 | 零风险 | **1d** | 需同步加样式规则 |
| **P2** | Z6 | 触屏 hover 补齐 | 零风险 | **0.5d** | 无 |
| **P2** | G4 | 断点收敛到 4 档 + 新判据 | 需改现有 5 处 + 新判据 | **1d** | 先做 11 档宽度普查 |
| **P2** | A4 | 偏好统一存储层 + 迁移函数 | 架构级 | **2d** | Z/G 落完 |
| **P2** | G2 延伸 | 密度/圆角偏好 UI（设置页「界面」分区加行） | 需 G2 | **1.5d** | Z3 + G2 |

**关键路径**：`Z1 → Z3 → G2 → 密度 UI`；`A1 → 健康源搜索 → 健康度徽标`。
两条链**互不阻塞**，可并行。

---

### 6. 附：给实现者的「不要做」清单

1. **不要新增第二套弹窗外壳/遮罩/关闭键。** `UiContract.test.ts:290-293` 的
   `SHELL_WHITELIST` 只允许 `.dialog-shell` / `.reader-drawer` / `.tts-floating-bar`。
   新弹窗一律套 `.dialog-shell` + `.size-s|m|l`。
2. **不要在 TSX 里给浮层写像素宽高。** `UiContract.test.ts:154-163` 会抓 `style={{width: ...}}`。
   宽度只有 `--dw-s/m/l` 三档（`styles.css:5702`）。
3. **不要各写一份夹取算式。** `lib/overlayGeometry.ts` 的 `clampOverlay` 是唯一来源
   （`UiContract.test.ts:227-247` 守它）。
4. **不要在界面文案里用装饰字形。** `CopyStyle.test.ts:16-20` 按码位禁用
   `🎯👉💡🔍🧪★⚠️⌂⏳•⋮○◌●◐⚪✅✓✕❌‹›«»⟳⧉`；图标一律 `<Icon name>`。
5. **不要写死版本号。** `HeaderMenu.test.ts:99-106` 扫全前端 `'x.y.z'` 字面量。
6. **不要用 `export default`。** `NamingConventions.test.ts:30-34`，全仓零例外。
7. **不要把 `z-index` 令牌化单独提交。** 会红 `UiContract.test.ts:62-68/71-83`（见 R3 §3.3
   与本文 §2.5）—— 必须与判据补丁同一提交。
8. **不要在 `:root` 里"再定义一次"已有令牌来加比例**（§4.2 的坑）—— 就地改写原定义，
   否则又添一处重复声明。
9. **不要把主题包做成「任意 CSS 变量」**。白名单（`THEME_TOKEN_VARS`）是它能被校验、
   能跨机器迁移的唯一前提。
10. **不要在没写迁移函数的情况下改 `localStorage` 键名**（§4.1）——
    用户的皮肤库、书架布局、阅读设置都在里面。

---

### 7. 验收清单（实现完之后）

```
[ ] web/test 全绿：npx tsx test/run-all.ts
[ ] tsc --noEmit 零错误
[ ] 夜读 / 石墨 两套暗色下跑一遍：主按钮、体检四档徽标、书籍类型徽标、规则调试轨迹色
    —— 全部可读（对比度用 DevTools 的 contrast 检查，实底控件 ≥4.5）
[ ] 5598 条书源的库上：搜索默认范围不再等于全库；界面给出「将搜索 N 个源」的量化预期
[ ] 键盘走一遍：Tab 到「我的」→ 打开菜单 → Esc 关 → 焦点回到「我的」按钮
[ ] 改密度为 compact：书架、书源、设置三页行高同步收紧，无文字截断
[ ] 导出主题包 → 清 localStorage → 导入 → 外观完全一致
[ ] 反向对照：故意导入一个 spec: 2 的包，必须被拒绝并说清原因
```

---

*本文所有 `文件:行` 均于 2026-10-22 在 `legado` @ `4f2a7a0` 实测。*
*`styles.css` 在审计期间被另一位成员追加了 AI 悬浮球 78 行（`git diff` 实测 `+78`），*
*故 `styles.css` 的行号以**本文为准**，而任务简报中的行数已过期。*

---

<!-- 来源：docs/archive/research/03-悬浮层延展.md -->

## R3 延展悬浮：浮层 / 悬浮体系能力扩展设计

> 调研基线：`E:\legado\legado\web` @ v0.8.4（2026-10-22 实读）。
> `styles.css` = 6102 行 / 296,201 字节；`z-index:` 字面量 **37 处**、**25 个不同数值**（2 → 9999）；
> `position: fixed` **21 处**。
> 本文所有 `文件:行` 均为当次实测行号。**注意**：调研期间另一位成员正在改动
> `styles.css`（+77 行，行号自 5461 起位移），引用行号前请以 `git diff` 复核。

---

### 0. 一句话结论

青阅的浮层**几何**已经收口得很干净（一档 `.dialog-shell` + 一条 `.overlay-backdrop` + 一颗 `.overlay-close`，
且有静态 + 实测两道门禁钉着），但浮层的**位置、层级、生命周期**三件事仍然各写各的：

- **位置**：`ttsBarPosition.ts` 自己写了一份拖动 + 夹取 + localStorage（201 行），`overlayGeometry.ts` 另有
  一份夹取算式，`Select.tsx` 与 `ContextMenu.tsx` 各调一次 —— 夹取算式已统一，**拖动/持久化没有**。
- **层级**：37 处 z-index 字面量、25 个数值，无令牌、无分层语义。已有的每一档都靠注释解释
  「为什么是 26 不是 950」，也就是说**层级知识活在注释里，不在类型里**。
- **生命周期**：`main.tsx` 的 `openModal` 是「同时只开一个」的单例字符串 + 一层 `modalBackTo` 返回栈；
  跨页面常驻只有 `ContextMenuLayer` / `ToastContainer` 各挂一遍（主壳与阅读器**各挂一次**）。

所以本方案的内核是一句话：

> **不新造外壳，只把「位置 / 层级 / 生命周期」从各组件里抽成三件可组合的公共设施 ——
> 且第一阶段的每个能力都必须能在现有两道浮层门禁下保持全绿。**

---

### 1. 现状矩阵

#### 1.1 浮层分类与九维盘点

定位方式 / 关闭方式 / 是否遮挡 / 焦点处理 / 滚动锁 / 层叠顺序 / 可拖动 / 记忆位置 / 跨页面存活。

| # | 类别 | 代表实现 | 定位方式 | 关闭方式 | 遮挡 | 焦点处理 | 滚动锁 | z-index | 可拖动 | 记忆位置 | 跨页存活 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 模态弹窗 | `components/PageDialog.tsx:9`、15 个 `*Modal.tsx` | `position:fixed; inset:0` + `place-items:center` | 遮罩点击 / Esc / `.overlay-close` | 是（`--backdrop` .45 + blur 4px） | **无陷阱**，仅个别 `autoFocus` | **无**（body 不锁） | 100 | 否 | 否 | 否（随 `openModal` 卸载） |
| 2 | 嵌套弹窗 | `ReplaceRulesModal.tsx:466,637`、`SourceLoginModal.tsx:812`、`ShelfPage.tsx:86`、`SourceDebugModal.tsx:67` | 同上，叠在父弹窗内 | Esc 分层（父组件手写 if 链）/ 点遮罩 | 是 | 无 | 无 | 120（`.is-topped`） | 否 | 否 | 否 |
| 3 | 底部弹层 sheet | `reader/ReaderSheet.tsx:16` | `.overlay-backdrop.is-sheet` → `place-items:end center` | 遮罩 / Esc（`open ? onClose : ignoreEscape`） | 是 | 无 | 无 | 38 | 否 | 否 | 否 |
| 4 | 侧抽屉 drawer | `ReaderScreen.tsx:2111,2319` + `.reader-drawer` | `position:fixed; top/bottom:0`，`translateX` 进出 | 遮罩 `.reader-drawer-backdrop` / Esc（按钮切换） | 是（自有 backdrop 28） | 无 | 无 | 30（钉住时 21） | **可拖宽**（`reader-sidebar-resizer` z 22） | 宽度存 `sidebarWidth` | 否 |
| 5 | 顶栏下拉菜单 | `AppHeader.tsx:172-179` | `position:absolute` 相对 `.header-actions` | 点「我的」/ 点 `.is-menu` 遮罩 | 是（`.is-menu` 199） | 无 | 无 | 面板 200 | 否 | 否 | 否 |
| 6 | 右键菜单 | `components/ContextMenu.tsx:42` | `position:fixed` + `useClampOverlay` 量真实矩形 | 外部 pointerdown(捕获) / Esc / blur / resize / scroll | **否**（无遮罩） | 无 | 否 | 320 | 否 | 否 | **是**（`<ContextMenuLayer/>` 主壳 + 阅读器各挂一次） |
| 7 | 下拉选择 popover | `components/Select.tsx:226` | `createPortal(…, document.body)` + `position:fixed` | 外部 pointerdown / Esc（**stopPropagation**）/ resize / 最近滚动祖先 | 否 | `searchRef.focus()` | 否（`overscroll-behavior:contain`） | 400 | 否 | 否 | 否（随触发器） |
| 8 | Toast | `components/Toast.tsx:73` | `position:fixed; top:24 right:24` | 自动超时 / `.toast-close` | 否（`pointer-events:none` 容器） | `aria-live="polite"` | 否 | **9999** | 否 | 否 | **是**（主壳/阅读器/加载页各挂一次） |
| 9 | 朗读悬浮条 | `reader/TtsPlayerBar.tsx:62` + `ttsBarPosition.ts` | `position:fixed`，默认 CSS `bottom:24px; left:50%` | 「退出听书」按钮 | 否 | 无 | 否 | **26** | **是**（长按 250ms + 9px 容差） | **是**（`legado-tts-bar-pos`） | 否（住在 ReaderScreen） |
| 10 | 笔记浮层 | `reader/NoteToolbar.tsx:28` | `position:fixed` + `left/top`（由选区坐标给） | Esc / 取消 / 保存 | 否 | `autoFocus` | 否 | 40 | 否 | 否 | 否 |
| 11 | 点击区域编辑层 | `reader/TapZoneEditor.tsx:115` + `.tap-zone-editor` | `position:fixed; inset:0` + `left` 让位 | Esc / 「完成」 | 半透明 | 无 | 否 | 26 | **是**（虚线拖动，`pointerCapture`） | **是**（`tapMap` 进设置） | 否 |
| 12 | 看图画布 | `ReaderScreen.tsx:2587`、`BookDetailModal.tsx:345` | `.overlay-backdrop.is-viewer` | 点任意处 / Esc | 是（.86 黑） | 无 | 否 | **1000** | 否 | 否 | 否 |
| 13 | 内置浏览器整屏 | `SourceWebViewModal.tsx:272` | `.overlay-backdrop.is-flush` + `.dialog-shell.is-fullscreen` | 「关闭」/ Esc | 是 | 无 | 否 | 100 | 否 | 否 | 否 |
| 14 | 阅读器整屏态 | `main.tsx:475-494` | 替换整个 `app-shell` 分支 | 返回按钮 | — | — | — | — | 否 | `sessionStorage` | 整屏 |
| 15 | **AI 悬浮球（本次新增，开发中）** | `features/ai/AiFloatingBall.tsx`（未提交） | `position:fixed; right/bottom:24px`，面板 `bottom:88px` | Esc / 「收起」/ 再点球 | 否 | 展开时 `input.focus()` | 否 | 球 **900** / 面板 **901** | 否 | 对话历史落 localStorage（`aiChatStore.ts`） | **是**（挂在根返回树） |
| 16 | 边界提示条 | `.reader-boundary-message` | `position:fixed; top` | 自动消失 | 否（`pointer-events:none`） | — | 否 | 25 | 否 | 否 | 否 |

#### 1.2 三处「写了却没在界面上的」悬浮设施（**本次调研最重要的发现**）

| 项 | 位置 | 状态 |
|---|---|---|
| `FloatingWindow` 整套外壳 | `styles.css:6027` `.fw-backdrop`(z100) / `6031` `.fw-shell` / `6040` `.fw-head{cursor:move}` / `6063` `.fw-resize{cursor:nwse-resize}` / `6072` `.fw-fab`(z101) | **CSS 在，组件与测试都不存在**（`src/` 下 0 处引用） |
| 实验室悬浮容器 | `styles.css:5928` `.lab-overlay`(z100) / `5932` `.lab-shell{位置由 inline style 给（可拖拽、可记忆）}` / `5979` `.lab-fab` | 同上；0.8.4 `CHANGELOG.md:44` 已宣布「实验室入口已移除」 |
| 「界面偏好」设置分区 | `features/settings/WindowPrefsSection.tsx:78` → `features/builtinSettings.ts:13` → `main.tsx:449` 挂进设置页 | **活着，且界面可见**。两个开关文案是「浮动窗口默认钉住」「浮动窗口默认收起（只留一个悬浮按钮）」，脚注承诺「位置与大小在拖动/缩放时自动记住」——**它描述的那个浮动窗口 0.8.4 已经不存在了** |

`CopyStyle.test.ts:38` 的 `BANNED_CLAIMS`（说谎的能力描述）盯的正是这一类，但它的清单里只有
三条具体字符串，**没有覆盖这一条**。这是当前最该先修的产品缺陷：一个活着的设置项在描述一个
已被删除的能力。修法二选一（见 §6 阶段 0），**必须先做决定再谈延展**。

---

### 2. 痛点清单（带文件:行）

| # | 痛点 | 证据 | 后果 |
|---|---|---|---|
| P1 | **无 z-index 分层体系** | 37 处字面量 / 25 个数值（见 §3 表）；`styles.css:2205-2210`、`:59-61`、`:3947-3949` 全都在用注释解释「为什么是 26 / 40 / 90」 | 每次新增浮层都要重读三处注释才敢取值；层叠冲突只能靠人眼发现 |
| P2 | **层级与语义无绑定** | `.tts-floating-bar`=26 但 `.reader-note-toolbar`=40；`.is-sheet`=38 却低于 `.app-page-header`=40 —— 「底部弹层被顶栏压住」是数值巧合还是设计？无从判断 | 无法回答「一个新的常驻面板该用几」 |
| P3 | **AI 悬浮球层级与自己的注释矛盾** | `styles.css:5465-5468` 注释写「层级要高于正文、**低于模态遮罩**（模态打开时不该被球挡住）」，但 `.ai-fab`=**900**（`:5473` 声明处）、`.ai-fab-panel`=**901**（`:5494` 声明处），而 `.overlay-backdrop`=**100**（`:5708`） | **模态打开时球仍浮在最上层**，注释承诺的行为没有实现。实测：900 > 100 |
| P4 | **AI 面板宽度被静默覆盖** | `.ai-fab-panel` 写了 `width: min(420px, calc(100vw - 32px))`（`:5495`），面板同时带 `className="… dialog-shell"`（`AiFloatingBall.tsx:132`）；`.dialog-shell`（`:5722`）有 `width: min(var(--dw-m), 94vw)` 且**在文件中更靠后**、特异性相同 → 后者胜出 | 面板实际宽 680px，不是设计的 420px。这正是「两份来源互相矛盾，谁也没报错」的老病（`overlayGeometry.ts:5-8` 的原文），只是这次在 CSS 层 |
| P5 | **拖动/持久化写死在 TTS 条里** | `ttsBarPosition.ts` 201 行：`HOLD_MS`/`SLOP`/`EDGE`/`readStored`/`clampPosition`/`bottomReserve` 全在一处，只服务一条 bar | 任何新面板要可拖动 = 复制这 201 行；`EDGE=8` 与 `overlayGeometry.ts:10` 的 `OVERLAY_EDGE=8` 是**同一件事的两个名字** |
| P6 | **无焦点陷阱** | 全仓 `.focus()` 仅 6 处（`Select.tsx:175-176,183`、`main.tsx:321`、`SourceSubscriptionPanel.tsx:83`、`RssPanel.tsx:93`），`role="dialog"` 有 20+ 处 | 键盘 Tab 会从弹窗跑到背后的页面上；`aria-modal="true"` 是**声明了但没实现** |
| P7 | **无滚动锁** | 全仓 0 处 `body.style.overflow` / `overflow='hidden'`；`overscroll-behavior` 仅 3 处且都是局部容器 | 弹窗后仍能滚动背后长列表（书架/书源 5574 条），滚轮会把背景滚走 |
| P8 | **Esc 分层是手写 if 链** | `ReplaceRulesModal.tsx:234-239`（3 层）、`SourceLoginModal.tsx:179-184`（4 层）、`ShelfPage.tsx:242` 用 `blockedBy` 选择器、`BookDetailModal.tsx:199-200` 用两次 hook 叠加 | 4 种写法；新增嵌套层要记得改链，漏了就一次关两层 |
| P9 | **跨页常驻要手工挂 N 遍** | `main.tsx:464,479-481,562-563`：`ToastContainer` 挂 3 次、`ContextMenuLayer` 挂 2 次，注释（`:479-480`）明说「不挂 ContextMenuLayer，卸载主壳时 publish 已被清成空函数，阅读器里右键就『什么都没发生』」 | 新常驻浮层（AI 球之外）每加一个都要记得挂两处；漏一处就是「某页里功能静默失效」 |
| P10 | **两套已死的悬浮框架留在样式表里** | `.fw-*`（6027+）、`.lab-*`（5929+）共约 90 行 + `.fw-fab` 的 z101 | 30 个 z-index 里占 4 个；读者会以为它们可用；且 `z-index: 101` 恰好卡在弹窗 100 与 `is-topped` 120 之间，是个无主的层 |
| P11 | **`openModal` 单例不可扩展** | `lib/nav.ts:12-31` 的 union + `main.tsx:160` 单字符串 + `modalBackTo` 只记一层（注释 `:170-173` 自己承认「浮层套浮层再深就该改用真正的路由」） | 多实例并存（两个 AI 面板、笔记 + AI 同开）**在架构上不可能**，不是没做，是模型不支持 |
| P12 | **几何常量重复** | `ttsBarPosition.ts:23` `EDGE = 8` vs `overlayGeometry.ts:10` `OVERLAY_EDGE = 8` | `UiContract.test.ts:241` 只钉住了「`OVERLAY_EDGE` 只许出现一次」，**没钉住 `ttsBarPosition` 这份** |

---

### 3. z-index 分层表（37 处字面量 / 25 个数值的令牌映射）

#### 3.1 现状全量映射（实测 37 处 / 25 个数值）

| 现值 | 选择器 @ 行 | 语义归类 | 建议令牌 |
|---:|---|---|---|
| 2 | `.settings-tabs@1007`、`.tap-zone-line@1054`、`.reader-page-cover@1254`、`.source-webview-loading@2680`、`.shelf-card-hover@4775`、`.search-card-hover@5100` | 组件内部层叠 | `--z-inline: 2` |
| 3 | `.tap-zone-strip@1060` | 组件内部层叠 | `--z-inline: 2`（→3 可并入） |
| 10 | `.shelf-card-checkbox@717` | 卡片内浮起控件 | `--z-inline: 2`（→降） |
| 20 | `.reader-header@920`、`.mobile-reader-nav@1456`、`.md3-topbar/.md3-bottombar@5829` | 页面 chrome（吸顶/吸底） | `--z-chrome: 20` |
| 21 | `.reader-workspace.sidebar-pinned .reader-drawer-left@1285` | 抽屉钉住态 | `--z-drawer: 30`（见注 ①） |
| 22 | `.reader-sidebar-resizer@1309` | 抽屉拖宽把手 | `--z-drawer-grip: 31` |
| 25 | `.reader-boundary-message@1129` | 阅读器轻提示 | `--z-hint: 25` |
| 26 | `.tap-zone-editor@1046`、`.tts-floating-bar@2211` | 阅读器内浮层 | `--z-reader-float: 26` |
| 28 | `.reader-drawer-backdrop@967` | 抽屉遮罩 | `--z-drawer-scrim: 28` |
| 30 | `.reader-drawer@951` | 抽屉本体 | `--z-drawer: 30` |
| 38 | `.overlay-backdrop.is-sheet@5891` | 底部弹层 | `--z-sheet: 38` |
| 40 | `.app-page-header@61`、`.reader-note-toolbar@5778` | 页面顶栏 / 笔记浮层 | 顶栏 `--z-chrome`；笔记 `--z-popover`（见注 ②） |
| 90 | `.source-batch-bar@3949` | 页面级批量条 | `--z-chrome-float: 90` |
| 100 | `.overlay-backdrop@5708`、`.source-login-dropdown-menu@1942`、`.lab-overlay@5929`（死）、`.fw-backdrop@6028`（死） | **模态遮罩** | `--z-scrim: 100` |
| 101 | `.fw-fab@6073`（死） | — | 随 `.fw-*` 一并删除 |
| 120 | `.overlay-backdrop.is-topped@5714` | 嵌套模态遮罩 | `--z-scrim-nested: 120` |
| 199 | `.overlay-backdrop.is-menu@5716` | 顶栏菜单遮罩 | `--z-scrim-menu: 199` |
| 200 | `.header-menu-dropdown@229` | 顶栏菜单面板 | `--z-menu: 200` |
| 320 | `.context-menu@4704` | 右键菜单 | `--z-context: 320` |
| 400 | `.ui-select-menu@5188` | 下拉浮层 | `--z-popover: 400` |
| 900 | `.ai-fab@5473` | AI 悬浮球 | `--z-dock: 60`（**须下调**，见 P3 与 §6 阶段 4） |
| 901 | `.ai-fab-panel@5494` | AI 浮动面板 | `--z-dock-panel: 61`（同上） |
| 999 | `.pwa-install-banner@2904` | 安装横幅 | `--z-banner: 750` |
| 1000 | `.overlay-backdrop.is-viewer@5720` | 看图画布 | `--z-viewer: 900` |
| 9999 | `.toast-container@1494` | Toast | `--z-toast: 1000` |

**注 ①**：`.reader-workspace.sidebar-pinned .reader-drawer-left`=21 **低于**未钉住时的 `.reader-drawer`=30，这是刻意的（钉住时抽屉在正文内，不是浮层）。令牌化时不能机械合并 —— 见 §3.3 的「反向陷阱」。
**注 ②**：`.reader-note-toolbar`=40 与 `.app-page-header`=40 同值，靠 DOM 顺序决胜 —— 正是 `UiContract.test.ts:79` 注释里警告的「同值是『DOM 顺序决胜』的别名」那类隐患。

#### 3.2 建议的分层序列（`--z-*` 令牌，以 5 为步进留插入余地）

```css
/* styles.css — 紧跟现有 :root 尺度令牌区（约 :4515-4535），与 --t/--s/--r/--elev 并列 */
:root {
  /* —— 页面内层叠 —— */
  --z-inline: 2;          /* 组件内部叠放（卡片角标、分页副本、编辑器虚线） */
  --z-chrome: 20;         /* 吸顶/吸底页面骨架：顶栏、移动端底部导航、MD3 bar */
  --z-hint: 25;           /* 阅读器轻提示（原 reader-boundary-message） */
  --z-reader-float: 26;   /* 阅读器内浮动件：TTS 条、点击区域编辑层 */
  --z-drawer-scrim: 28;   /* 抽屉遮罩 */
  --z-drawer: 30;         /* 抽屉本体 */
  --z-drawer-grip: 31;    /* 抽屉拖宽把手（必须是 drawer 的 +1） */
  --z-sheet: 38;          /* 底部弹层（.is-sheet） */

  /* —— 应用级浮层 —— */
  --z-chrome-float: 90;   /* 页面级悬浮操作条（批量操作） */
  --z-scrim: 100;         /* 模态遮罩（唯一一档） */
  --z-scrim-nested: 120;  /* 嵌套模态遮罩（.is-topped） */
  --z-scrim-menu: 199;    /* 顶栏菜单遮罩 */
  --z-menu: 200;          /* 顶栏菜单面板 */
  --z-context: 320;       /* 右键菜单 */
  --z-popover: 400;       /* 下拉浮层 / 锚定浮层 */

  /* —— 常驻层（本次新增的语义档）—— */
  /* 关键：dock 必须在遮罩【之下】。常驻 ≠ 最上 —— 模态打开时球应被遮住（当前 AI 球的 900 违反此条）。 */
  --z-dock: 60;           /* 悬浮球 / 常驻入口：高于 sheet(38)，低于 chrome-float(90) 与 scrim(100) */
  --z-dock-panel: 61;     /* 悬浮球展开的面板 */
  --z-banner: 750;        /* 安装/更新横幅（要压住模态，它与 dock 语义不同） */

  /* —— 顶层 —— */
  --z-viewer: 900;        /* 看图画布 */
  --z-toast: 1000;        /* Toast（永远最上） */
}
```

**分层原则（写进注释，供后来人直接照抄）**：

1. `--z-chrome` < `--z-scrim`：页面骨架必须在遮罩之下（`UiContract.test.ts:80-82` 已钉）。
2. `--z-dock` < `--z-scrim`：**常驻不等于最上**。模态打开时球应被遮住（当前 AI 球违反此条）。
3. `--z-store` 系列全部 ≥ `--z-scrim`：它们必须能盖住模态（菜单/右键/下拉/看图/Toast 都是「用户正盯着它」）。
4. 同值即隐患：任何两组语义相同的元素不得共用同一令牌（`--z-drawer`=30 与 `.reader-page-cover`=2 是对的例子；`note-toolbar` 与 `app-page-header` 同 40 是错的例子）。

#### 3.3 ⚠ 反向陷阱：**令牌化会直接击穿 `UiContract.test.ts` 的两条判据**（已实证）

`UiContract.test.ts:62-68` 与 `:71-83` 是**用正则从 CSS 文本里读字面数字**的：

```ts
// UiContract.test.ts:64-66
const z = Number(/z-index:\s*(\d+)/.exec(bar)?.[1] ?? '9999')
const drawer = Number(/\.reader-drawer \{[\s\S]*?z-index:\s*(\d+)/.exec(css2)?.[1] ?? '0')
const backdrop = Number(/\.overlay-backdrop \{[^}]*z-index:\s*(\d+)/.exec(css2)?.[1] ?? '0')
assert.ok(z < drawer && z < backdrop, ...)
```

一旦把 `z-index: 26` 改成 `z-index: var(--z-reader-float)`，正则 `(\d+)` **匹配不到数字**，
`bar` 落回默认 `9999`、`drawer` 落回 `0`、`backdrop` 落回 `0` —— 断言 `9999 < 0` 为假，**判据红**。

**实测复现**（本次用 Node 跑过，把三处 `z-index` 原地替换为 `var()`、其余一字不动）：

```
现状        : {"z":26,"drawer":30,"backdrop":100,"pass":true}
令牌化之后  : {"z":9999,"drawer":28,"backdrop":0,"pass":false}
```

判据从绿变红，且**错误信息会是误导性的**（`drawer` 读成 28 是因为 `[\s\S]*?` 跨过了
`.reader-drawer` 规则继续找到下一处 `z-index: 28`，即 `.reader-drawer-backdrop`）——
这类失真比单纯报红更难查。

同一问题也存在于 `:74`（`zIndex()` 辅助函数，读不到就 `assert.ok` 失败并报「找不到带 z-index 的规则」）。

**所以「令牌化」不是零风险增量，它必须连带修改 `UiContract.test.ts`。** 这也修正了「z-index 令牌化最容易落地」的判断：**它是最有价值的，但不是最先能做的**，除非同步扩判据。补丁见 §6 阶段 1。

#### 3.4 令牌化的正确做法（避免 P4 那类静默覆盖）

- 令牌**只定义一处**（`:root`），消费处一律 `z-index: var(--z-xxx)`。
- 不允许在组件里写 `style={{ zIndex: 900 }}` —— 那会绕过令牌且 inline 优先级最高，比 P4 的覆盖更难查。
- 判据侧改为**读令牌值**而非读字面量，见 §6 阶段 1 的具体补丁。

---

### 4. 统一设计：OverlayHost + OverlayRegistry

#### 4.1 设计红线（源自既有门禁，不可妥协）

| 红线 | 来自 | 对设计的约束 |
|---|---|---|
| 外壳只有 `.dialog-shell` 一档 | `UiContract.test.ts:203-222`（`auditOverlayLayers`，只许白名单 `.dialog-shell`/`.reader-drawer`/`.tts-floating-bar`） | **不许新增第二套 dialog 外壳**；延展能力用修饰类 |
| 遮罩只许两条 | 同上 `:213`（`backdrops.length > 2` 即红）+ `overlay-tier-check.mjs:203-205`（`backdrops === 1`） | **不许新增 `.overlay-backdrop` 变体**；悬浮球/常驻条**绝不能**用 backdrop |
| 关闭键只许一颗 | `UiContract.test.ts:218-220` + `overlay-tier-check.mjs:218-220`（30×30、border none） | 复用 `.overlay-close` |
| 宽高不许 inline | `UiContract.test.ts:182-183`（`inlineShellSizes`） | **几何必须走 CSS 自定义属性**，不得 `style={{width:'750px'}}` |
| 宽度必须等于 `min(--dw-N, 94vw)`（±1px） | `overlay-tier-check.mjs:206-209` | **resize 不能作用在 `.dialog-shell` 上** |
| max-height/radius/animation 全表唯一 | `overlay-tier-check.mjs:210-214, 228-235` | 同上 |
| 每个弹窗必须 Esc 可关且 `role="dialog"` 有名字 | `UiContract.test.ts:165-186, 282-288` | Overlay 必须统一接 Esc |

#### 4.2 三件公共设施（而不是一个新壳）

```
lib/overlay/
├── overlayStack.ts     层栈状态机（纯逻辑，可单测）
├── overlayGeometry.ts  几何算式（**扩展现有 lib/overlayGeometry.ts**，不新建）
├── overlayDrag.ts      拖动 / 吸附 / 持久化（从 ttsBarPosition.ts 抽出）
└── OverlayHost.tsx     渲染宿主（唯一挂载点，替代 main.tsx 的双份挂载）
```

**关键：不引入新的 DOM 外壳。** `OverlayHost` 只做「栈管理 + 事件委派 + 把手套」，渲染的仍是
各弹窗现有的 `.overlay-backdrop` + `.dialog-shell`。

#### 4.3 TypeScript 接口草图

```ts
// lib/overlay/overlayStack.ts —— 层栈状态机（纯逻辑，node:test 可直接测）

/** 浮层的三种身份。决定默认的关闭行为、焦点策略与层级档。 */
export type OverlayKind =
  | 'modal'      // 模态：遮罩 + 焦点陷阱 + 滚动锁 + Esc
  | 'sheet'      // 底部弹层：遮罩 + Esc（移动端可下滑关闭）
  | 'popover'    // 锚定浮层：无遮罩 + 点外部关闭 + Esc（stopPropagation）
  | 'dock'       // 常驻层：无遮罩、不参与层栈的 Esc 竞争、不锁滚动
  | 'toast'      // 通知：无遮罩、无焦点、不参与 Esc

export type OverlayEntry = {
  id: string
  kind: OverlayKind
  /** 关闭回调；由层栈决定「这一层该不该吃这次 Esc」。 */
  close: (reason: 'esc' | 'scrim' | 'program') => void
  /** 是否允许点遮罩关闭（默认 modal/sheet 为 true，dock/popover 为 false）。 */
  dismissOnScrim?: boolean
  /** 抢占焦点（默认 modal/sheet 为 true）。 */
  trapFocus?: boolean
  /** 锁背景滚动（默认 modal/sheet 为 true）。 */
  lockScroll?: boolean
}

/** 层栈：后进先出，Esc / 遮罩点击只作用于栈顶。 */
export class OverlayStack {
  push(entry: OverlayEntry): () => void        // 返回 unregister
  /** 栈顶尝试关闭；返回是否被消费（供 window keydown 判断 preventDefault）。 */
  requestClose(reason: 'esc' | 'scrim'): boolean
  /** 当前栈顶（无则 null）。dock/toast 不参与。 */
  top(): OverlayEntry | null
  /** 快照（调试 / uiContext 上报用）。 */
  snapshot(): OverlayEntry[]
}
```

```ts
// lib/overlay/overlayDrag.ts —— 把 ttsBarPosition.ts 的能力抽成通用 hook

export type DragMode =
  | 'none'      // 不可拖
  | 'always'    // 按下即拖（标题栏模式）
  | 'hold'      // 长按后拖（TTS 条现有行为：250ms + 9px 容差）

export type SnapEdge = 'left' | 'right' | 'top' | 'bottom'

export type DragOptions = {
  mode: DragMode
  /** localStorage 键；null = 不持久化。 */
  storageKey: string | null
  /** 吸附阈值（px）；0 = 不吸附。 */
  snap?: number
  /** 允许的吸附边。 */
  snapEdges?: SnapEdge[]
  /** 拖拽把手选择器（按下这些元素内部时不抓整块）。 */
  ignore?: string
  /** 是否被钉住（钉住时不响应拖动）。 */
  pinned?: boolean
}

export type DragHandle = {
  /** 交给元素的 style：只用 CSS 自定义属性，不写像素宽高（见 §4.1 红线）。 */
  style: React.CSSProperties
  handlers: {
    onPointerDown: React.PointerEventHandler<HTMLElement>
    onPointerMove: React.PointerEventHandler<HTMLElement>
    onPointerUp: React.PointerEventHandler<HTMLElement>
    onClickCapture: React.MouseEventHandler<HTMLElement>
  }
  /** 回到默认位置（清掉覆盖，不是写回常量）。 */
  reset: () => void
  /** 当前是否被拖动过。 */
  moved: boolean
}

export function useOverlayDrag(
  getElement: () => HTMLElement | null,
  options: DragOptions,
): DragHandle
```

**几何注入方式（满足「不写 inline 像素」红线）**：

```tsx
// 组件侧
const drag = useOverlayDrag(() => ref.current, {
  mode: 'hold', storageKey: 'legado-overlay-tts-bar', snap: 16, snapEdges: ['left', 'right'],
})
<aside ref={ref} className="tts-floating-bar" style={drag.style} {...drag.handlers}>
```

```css
/* styles.css —— 位置只由这两条消费；未拖动时两个变量都未定义 → 回落到原有 CSS 默认位置 */
.tts-floating-bar {
  left: var(--ov-x);
  top: var(--ov-y);
  right: var(--ov-right, auto);
  bottom: var(--ov-bottom, 24px);
  transform: var(--ov-transform, translateX(-50%));
}
```

```ts
// drag.style 的形状：全部是自定义属性，且有值才写（undefined = 不写，保持 CSS 默认）
style: position ? {
  '--ov-x': `${position.x}px`,
  '--ov-y': `${position.y}px`,
  '--ov-right': 'auto',
  '--ov-bottom': 'auto',
  '--ov-transform': 'none',
} as React.CSSProperties : undefined
```

> **为什么用自定义属性而不是 `left/top`**：`overlay-tier-check.mjs` 读的是
> `getComputedStyle(shell).width`（`:57`）。只要 `width` 仍解析为 `min(--dw-N, 94vw)`，
> 拖动就完全不影响任何一条实测断言 —— 这也是「拖动是阶段一」的技术前提。
> 而用 `--ov-*` 还顺带满足 `UiContract.test.ts:227` 的「菜单不许在 TSX 里写像素」
> 的**精神**（虽然那条目前只扫 `ContextMenu.tsx`）。

#### 4.4 层栈状态机

```
                    ┌──────────────────────────────────────────┐
                    │              OverlayStack                │
                    │  entries: OverlayEntry[]  (后进先出)      │
                    └──────────────────────────────────────────┘

  push(kind='modal')     ┌─────────┐  push   ┌─────────┐  push   ┌─────────┐
  ──────────────────────▶│  EMPTY  │────────▶│  ONE    │────────▶│ NESTED  │
                         │ top=nul │         │ top=A   │         │ top=B   │
                         └─────────┘◀────────└─────────┘◀────────└─────────┘
                              ▲    pop 全空     │   pop 回 A        │
                              │                 │                   │
                              │                 ▼                   ▼
                              │          Escape @ A           Escape @ B
                              │          → A.close()          → B.close(), 栈顶回 A
                              │                                （**A 保持挂载**，不卸载）
                              │
       ┌──────────────────────┴───────────────────────────────────────────┐
       │  Esc 派发规则（修复 P8 的四种手写写法）                            │
       │  1. 取栈顶 entry（跳过 kind='dock'|'toast'）                       │
       │  2. 若 top.trapFocus 且焦点在 top 内 → 关闭 top 并 return true      │
       │  3. 若无栈顶 → 交给页面自己的全局快捷键（main.tsx:312 那张表）      │
       │  4. 已消费则 event.preventDefault() + stopPropagation()            │
       └───────────────────────────────────────────────────────────────────┘

  滚动锁（修复 P7）：
    push 时若 lockScroll → 记 scrollY，body { position:fixed; top:-scrollY }
    pop 到 0 层时还原并 window.scrollTo(0, scrollY)
    **计数器式**：两层 modal 只锁一次，退到 0 才解（避免"关里层把背景解锁"）

  焦点陷阱（修复 P6）：
    push 时记录 document.activeElement → 焦点移入 top 的第一个可聚焦元素
    Tab/Shift+Tab 在 top 内循环（查 focusable，首尾回绕）
    pop 时焦点还原到 push 前记录的元素（若还在 DOM 里）
```

#### 4.5 与现有 `main.tsx` 单例状态的关系（渐进迁移）

**不推翻** `openModal: AppModal | null`。它是 15 个浮层的事实标准，且 `UiContract.test.ts:559-601`
用正则钉住了 `openModalFrom` / `openModalDirect` / `closeModal` 三个函数名与用法。改造路径：

| 步骤 | 做法 | 触碰门禁 |
|---|---|---|
| 1 | `AppModal` 条目**登记**进 `OverlayRegistry`（kind='modal'），`main.tsx` 的 `openModal` 保留为「当前激活的 modal id」 | 无（纯新增） |
| 2 | 每个 `*Modal.tsx` 内部把 `useEscapeClose(onClose)` 换成 `useOverlay({ kind:'modal', close:onClose })` | `UiContract.test.ts:170-171`（要求每个 backdrop 文件至少 1 处 `useEscapeClose(`）→ **需改判据** |
| 3 | `modalBackTo` 一层返回栈换成 `OverlayStack` 的 N 层 | `UiContract.test.ts:559-601` 钉了函数名与 `if (modalBackTo)`／`setOpenModal(back)` 字面量 → **需改判据** |
| 4 | dock 层（AI 球等）进 `OverlayHost`，`kind='dock'`，不参与 Esc 竞争 | 无（新层，不进 `.overlay-backdrop` 统计） |

> 步骤 2、3 是**仅为统一而统一**的改动，风险高、收益低。建议**永远停在步骤 1 + 4**
> （登记 + dock 层），把 2、3 留作可选项。理由见 §6：现有 Esc/返回栈虽然写法难看，但
> **行为是对的且被三处判据钉着**，重写它们的收益不足以抵消红判据的代价。

---

### 5. 延展能力 × 门禁冲突矩阵

| 能力 | 能否用现有 `.dialog-shell` | 冲突判据（精确到行） | 结论 |
|---|---|---|---|
| **可拖动 drag** | ✅ 能 | **无冲突**。只改 `left/top`（走 `--ov-*` 变量），不动 width/maxHeight/radius/animation | **阶段一，零门禁冲突** |
| **位置持久化** | ✅ 能 | 无冲突（localStorage） | 阶段二 |
| **边缘吸附** | ✅ 能 | 无冲突（只改 `left/top`） | 阶段二 |
| **多实例并存** | ✅ 能 | 无（但需 `openModal` 单例模型让步，见 §4.5 步骤 1） | 阶段二 |
| **跨页常驻** | ✅ 能 | 无（挂 `OverlayHost` 到根，替代双份手挂） | 阶段二 |
| **最小化 / 悬浮球** | ❌ **不能** | `overlay-tier-check.mjs:203-205`（`backdrops===1`）一旦球带 backdrop 即红；`UiContract.test.ts:213`（遮罩 ≤2） | **阶段四，需扩白名单** |
| **可调整大小 resize** | ❌ **不能** | `overlay-tier-check.mjs:206-209`：宽度必须 `Math.abs(width - min(--dw-N,94vw)) <= 1`。改成 750 必红 | **阶段三，需改门禁** |
| **移动端下滑关闭** | ✅ 能（sheet） | 无（`.is-sheet` 已存在，只加手势） | 阶段二 |
| **focus trap / 滚动锁** | ✅ 能 | 无（不改 DOM 结构，只加行为） | 阶段一（与拖动并列，纯行为） |

#### 5.1 阶段三（resize）的门禁补丁（精确到行）

若确认要做「可调整大小的浮动工具面板」，`tools/verify/overlay-tier-check.mjs` 需两处改动：

```js
// ① L206-209：把「必须等于档位」改为「必须属于档位集合，或该层声明了可缩放」
// 原：
const want = expectWidth(dialog.expectSize.replace('size-', ''), 1440)
check(`${dialog.name}：还是设计里那一档…`,
  box.sizeClass === dialog.expectSize && Math.abs(box.shell.width - want) <= 1, ...)
// 改后：为 DIALOGS 条目增加 resizable?: true，可缩放层跳过宽度等式断言，
//       只断言「宽高在 [min,max] 内且不溢出」
if (!dialog.resizable) {
  const want = expectWidth(dialog.expectSize.replace('size-', ''), 1440)
  check(..., box.sizeClass === dialog.expectSize && Math.abs(box.shell.width - want) <= 1, ...)
} else {
  check(`${dialog.name}：可缩放层宽度在合法区间内且不溢出`,
    box.shell.width >= 320 && box.overflow <= 1, ...)
}
```

```js
// ② L228-235：全局收口断言必须排除可缩放层，否则「max-height 只有一个值」必红
const fixed = seen.filter(i => !i.resizable)
check(`${fixed.length} 张固定弹窗量下来：max-height 只有一个值`, ...)
```

**并且必须补负向自证**（该项目判据的硬规矩，见 `UiContract.test.ts:295,308,414` 三处「判据自己会红」）：
新增一条注入式用例，证明「若可缩放层没被排除，全局收口断言会红」。

#### 5.2 阶段四（dock 悬浮球）的门禁补丁

```js
// overlay-tier-check.mjs:50 —— measure() 取第一个 .overlay-backdrop，
// dock 层只要不带 backdrop 类就完全不进入统计。**这是最省事的做法，优先选它。**
// 若 dock 因某些原因必须带 backdrop，则 L71 的
backdrops: document.querySelectorAll('.overlay-backdrop').length,
// 需改为
backdrops: [...document.querySelectorAll('.overlay-backdrop')]
  .filter(n => !n.classList.contains('is-dock')).length,
```

`UiContract.test.ts` 侧：

```ts
// L225 SHELL_WHITELIST 增加 dock 外壳（若 dock 需要自己的圆角/阴影档）
const SHELL_WHITELIST = new Set(['.dialog-shell', '.reader-drawer', '.tts-floating-bar', '.dock-shell'])
// L210-213 遮罩计数 —— dock 无 backdrop，天然不计入，无需改
```

**最关键的一条**：dock 层**不得**使用 `.overlay-backdrop` 类名。
`AiFloatingBall.tsx` 当前的实现（球是裸 `<button class="ai-fab">`，面板是 `<aside class="ai-fab-panel dialog-shell">`）
**已经满足**这一条 —— 它没有 backdrop，所以 `backdrops===1` 不受影响。
但它把 `dialog-shell` 借去当外壳，于是撞上了 P4 的宽度覆盖。正确做法二选一：

- **A**（推荐）：面板保留 `dialog-shell`（复用几何），但**不要再写 `width`** —— 接受 680px 的默认档，
  或者用 `size-s/m/l` 三档之一表达它的宽度。这样既满足门禁，也符合「几何只有一处来源」。
- **B**：面板不挂 `dialog-shell`，改用新的 `.dock-shell` 并**同步加白名单**（阶段四才做）。

**当前代码应立刻选 A**：删掉 `.ai-fab-panel` 里的 `width` 声明（`:5495` 那行），
换成 `className="ai-fab-panel dialog-shell size-s"`。这是**零门禁风险**的一行修复。

---

### 6. 分阶段实施计划

> 排序原则：**先修正在说谎的东西 → 再做零门禁冲突的能力 → 最后做需要改门禁的能力**。
> 每阶段都给出「触碰哪个判据 / 第几行 / 是否需要改门禁」。

#### 阶段 0：清账（不含新能力，纯删减与修复）

| 任务 | 改动文件 | 风险 / 判据 |
|---|---|---|
| 0-1 删除 `.fw-*` 死样式（约 55 行） | `web/src/styles.css:6027-6046` | **零风险**。`src/` 下 0 引用；`UiContract.test.ts:449` 的「类名挂着而样式表 0 命中」判据方向相反（报「用了却没样式」），删无主样式不触发 |
| 0-2 删除 `.lab-*` 死样式（约 40 行） | `styles.css:5928-5997`（`.lab-overlay`@5928 … `.lab-fab`@5979 之后至 `.lab-plugin-intro`@5999 之前）；保留 `.lab-plugin-*`/`.lab-section-title`（`PluginListPanel.tsx` 在用） | **零风险**，但**必须逐条核对**：`PluginListPanel.tsx:30-87` 仍在用 `.lab-plugin-intro`/`.lab-desc`/`.lab-empty`/`.lab-plugin-item`/`.lab-plugin-meta`/`.lab-plugin-failures`/`.lab-section-title`。只删 `.lab-overlay`/`.lab-shell`/`.lab-head`/`.lab-head-actions`/`.lab-body`/`.lab-nav*`/`.lab-content`/`.lab-fab` |
| 0-3 决定「界面偏好」的去留 | `features/settings/WindowPrefsSection.tsx`、`features/builtinSettings.ts:13` | 二选一：**(a)** 随 0-1/0-2 一起删（`builtinSettings.ts` 变成空数组，`main.tsx:449` 的 `builtinSettingsSections` 仍可留空）—— **零风险**，`SettingsSections.test.ts` 只测 `buildSettingsSections`（另一张表），不涉及插件分区；**(b)** 留到阶段二实现真浮动窗后再接线。**建议 (a)**，因为当前它是说谎的控件 |
| 0-4 修 AI 面板宽度被覆盖 | `styles.css:5495` 删 `width` 声明；`AiFloatingBall.tsx:132` 加 `size-s` | **零风险**，且修掉 P4。注意 `AiFloatingAssistant.test.ts:36` 有一条空断言 `assert.match(fab, /position: fixed\|ai-fab/, '')`（第三个参数是空串，等于无提示）—— 顺手补文案 |
| 0-5 修 AI 球层级与注释矛盾 | `styles.css:5473,5494`：900/901 → 等阶段一令牌化后写 `var(--z-dock)` / `var(--z-dock-panel)`，即 **60 / 61**（见 §3.2） | 单独改**零风险**（无判据读这两个值）；与阶段一合并更省事 |

> **0-1 / 0-2 的净效果（已实测核算）**：删除 `.lab-overlay@5929`(z100)、`.fw-backdrop@6028`(z100)、
> `.fw-fab@6073`(z101) 这三条声明后，`styles.css` 减约 95 行、
> z-index 字面量从 **37 降到 34**、不同数值从 **25 降到 24**
> （值表变为 `2,3,10,20,21,22,25,26,28,30,38,40,90,100,120,199,200,320,400,900,901,999,1000,9999`，
> 去掉的是无主的 101）。
> 这是阶段 1 令牌化的**前置**：先清掉无主层，映射表才不会白搬一遍。

#### 阶段 1：z-index 令牌化（价值最高，但**必须同步改判据**）

| 任务 | 改动 | 判据影响 |
|---|---|---|
| 1-1 在 `:root` 加 §3.2 的 21 个 `--z-*` | `styles.css::root` 区（约 4515-4535 后） | 无（纯新增） |
| 1-2 把 37 处字面量映射到令牌 | `styles.css` 全表 | **会红**：`UiContract.test.ts:62-68`、`:71-83` |
| 1-3 改 `UiContract.test.ts` 的三处正则 | `:64-66` 与 `:74` | 改为「先读 `:root` 的令牌值，再断言令牌序」 |

**1-3 的精确补丁**：

```ts
// UiContract.test.ts —— 新增：从 :root 读令牌（令牌是唯一来源，判据也读它）
function zToken(name: string): number | null {
  const v = new RegExp(`--z-${name}:\\s*(\\d+)`).exec(css)?.[1]
  return v === undefined ? null : Number(v)
}
// 把 :64-66 的「读三条字面量」改为「读三条令牌」
const z = zToken('reader-float') ?? -1
const drawer = zToken('drawer') ?? -1
const backdrop = zToken('scrim') ?? -1
assert.ok(z > 0 && drawer > 0 && backdrop > 0, '分层令牌缺失（--z-reader-float / --z-drawer / --z-scrim）')
assert.ok(z < drawer && z < backdrop, `朗读条令牌 ${z} 必须低于抽屉 ${drawer} 与遮罩 ${backdrop}`)
```

```ts
// 把 :71-83 的 zIndex() 辅助改为令牌查询
const zOf = (token: string) => {
  const value = zToken(token)
  assert.ok(value !== null, `缺少令牌 --z-${token}`)
  return value as number
}
const backdropZ = zOf('scrim')
for (const token of ['chrome', 'chrome-float', 'reader-float']) {
  assert.ok(zOf(token) < backdropZ, `--z-${token} 必须低于 --z-scrim`)
}
```

**并且补一条新的负向自证**（否则这条判据等于没改）：

```ts
test('分层令牌判据自己会红：把 --z-reader-float 调到 scrim 之上必须报出', () => {
  const injected = css.replace(/--z-reader-float:\s*\d+/, '--z-reader-float: 150')
  // 用注入后的文本跑一遍 zToken/断言逻辑，期望不通过
})
```

> 阶段 1 的收益：P1/P2/P3/P10 一并解决，且**把「层级知识」从注释搬进类型**。
> 代价：动 `UiContract.test.ts` 两处 + 加一条自证。**这是唯一一处建议改核心判据的地方**，
> 因为令牌化如果不改判据，就只能保持「字面量 + 令牌并存」的半吊子状态，那比不改更糟。

#### 阶段 2：拖动 + 吸附 + 持久化 + 跨页常驻（零门禁冲突）

| 任务 | 新增/改动 | 判据影响 |
|---|---|---|
| 2-1 新建 `lib/overlay/overlayDrag.ts`（从 `ttsBarPosition.ts` 抽出） | 新文件 | **无**（纯新增）；`NamingConventions.test.ts:50-59` 要求 hooks 文件名 `useXxx.ts` —— 若导出 hook 须改名 `useOverlayDrag.ts` |
| 2-2 `ttsBarPosition.ts` 改为薄封装（保留 `clampPosition` 与 `resetTtsBarPosition` 导出） | 改动 | **必须保**：`TtsBarPosition.test.ts:5` 直接 `import { clampPosition } from '../src/reader/ttsBarPosition'`，`:38-56` 测其行为；`:62-68` 正则查 `localStorage.removeItem(STORAGE_KEY)`、`legado-tts-bar-reset`；`:72-81` 查 `HOLD_MS = 250`、`SLOP = 9`、`closest('button, a, input, select, textarea')`、`suppressClick.current = false`。**这些字面量在当前文件里必须继续存在**，所以 2-2 只能是「抽出去再引回来」，不能直接搬走 |
| 2-3 TTS 条改用 `--ov-*` 变量 | `styles.css:2200-2227`、`TtsPlayerBar.tsx:62` | 无（`TtsBarPosition.test.ts:59-68` 要求 `style={style}` 与 `localStorage.removeItem`，保持即可） |
| 2-4 `OverlayHost` 挂载，替代 `main.tsx` 双份手挂 | `main.tsx:464,479-481,562-563`；新建 `components/OverlayHost.tsx` | 无判据读这几行的挂载次数；但 `UiContract.test.ts:559-601` 钉了 `closeModal`/`openModalFrom`/`openModalDirect` 的函数体形状 —— **不动 `openModal` 体系就没事** |
| 2-5 移动端下滑关闭（sheet） | `ReaderSheet.tsx` + `styles.css .is-sheet` | 无（`.is-sheet` 不在被测 8 张弹窗里，`overlay-tier-check.mjs:88-169` 的 `DIALOGS` 未含 sheet） |
| 2-6 边缘吸附 | `overlayDrag.ts` + `--ov-*` | 无 |

#### 阶段 3：可调整大小的独立面板档（**需改门禁**）

前置：必须先完成 §5.1 的两处补丁 + 一条负向自证。

| 任务 | 内容 |
|---|---|
| 3-1 | 新增 `.tool-panel` 一档（**不是** `.dialog-shell`）；`UiContract.test.ts:225` 的 `SHELL_WHITELIST` 加它，但要确认它不会触发 `auditOverlayLayers` 的「又长出一套弹窗外壳几何」（`:205-209` 判的是 `max-height + border-radius + box-shadow` 三件同在）—— 所以 `.tool-panel` **只能有 `resize` 相关样式，不得同时写 `max-height/border-radius/box-shadow`**，几何仍从 `.dialog-shell` 继承 |
| 3-2 | resize 把手复用 `.fw-resize` 的写法（`styles.css:6063-6069` 的纯 CSS 三斜线，**不要用图形字符** —— `CopyStyle.test.ts:16-20` 的 `BANNED_GLYPHS` 含 0x29C9 等） |
| 3-3 | 补 `overlay-tier-check.mjs` 负向自证 |

#### 阶段 4：dock 层（悬浮球 / 常驻入口）

| 任务 | 内容 |
|---|---|
| 4-1 | `.dock-*` 独立档，**不带 `.overlay-backdrop`**（这样 `overlay-tier-check.mjs:203-205` 天然不受影响） |
| 4-2 | 层级取 `--z-dock: 60` / `--z-dock-panel: 61`（见 §3.2）—— **必须在遮罩之下** |

> ⚠ **这里必须诚实**：如果把 dock 的令牌定在 `--z-scrim: 100` 之上（当前 AI 球的 900 就是如此），
> 模态打开时球仍会浮在遮罩上，P3 想修的问题原样存在。
> **`--z-dock: 60` 的含义是「模态打开时球被遮住」**，与 `styles.css:5465-5468` 那句注释一致。
>
> 若产品决定「球必须在模态之上」（例如希望随时能唤起 AI），那**必须删掉
> `styles.css:5465-5468` 那句注释**并同时改 §3.2 的取值，否则注释与行为继续互相矛盾。

| 任务 | 内容 |
|---|---|
| 4-3 | 插件注册 dock 入口（见 §7） |

---

### 7. 与 AI 助手、插件框架的衔接

#### 7.1 AI 助手浮动面板（已由另一位成员实现，此处只给对齐结论）

现状 `AiFloatingBall.tsx` 已经做到：挂在根返回树（跨页常驻）、`uiContext` 注入、
对话历史落 `aiChatStore`（跨会话）、Esc 收起。**这四点与我的设计一致，不需要重做。**

需要修的三处（均已进阶段 0）：

1. **P4 宽度被 `.dialog-shell` 覆盖** → 删 `.ai-fab-panel` 的 `width`，挂 `size-s`。
2. **P3 层级 900/901 与注释矛盾** → 阶段一令牌化时取 `--z-dock`。
3. `AiFloatingAssistant.test.ts:36` 的空断言补文案。

**未做但值得做**（阶段 2 之后）：拖动 + 吸附 + 位置记忆。当前面板固定右下角，
在阅读器里会挡住正文右下角与 `--safe-bottom` 区域。用阶段二的 `useOverlayDrag` 即可，
`storageKey: 'legado.ai-fab-pos'`。

#### 7.2 插件如何注册悬浮层

`extensions/registry.ts:19-37` 的 `FrontendPlugin` 目前只有 `settingsSections`。
`plugin-framework.md:230-234` 明确写「能做但没宿主实现的能力，契约里也不提供 —— 承诺一个渲染
不出来的能力，比不承诺更糟」。所以**注册 API 必须与宿主实现同时落地**，不能先加类型。

建议的扩展形状（阶段 4 之后，与 `OverlayHost` 一起提交）：

```ts
// extensions/registry.ts —— 新增（必须与 OverlayHost 的 dock 支持同一提交）
export type FrontendPlugin = {
  // …现有字段…
  /** 往 dock 层加一个常驻入口（悬浮球 / 工具条按钮）。 */
  dockEntries?: PluginDockEntry[]
}

export type PluginDockEntry = {
  id: string
  /** 按钮上的图标名（复用 icons.tsx 的单色 SVG，不许用装饰字形）。 */
  icon: IconName
  /** 可访问名字（必填 —— UiContract 的 aria-label 纪律）。 */
  label: string
  /** 点击后的浮层内容；宿主负责外壳与层级，插件只画内容。 */
  render: () => React.ReactNode
}
```

三条纪律（与前文一致）：

1. **插件不自带外壳** —— 只 `render()` 内容，外壳/层级/关闭由 `OverlayHost` 给。
   这样插件的浮层也自动满足 `.dialog-shell` 一档几何，`UiContract` 无需为插件开后门。
2. **id 唯一** —— 复用 `FrontendPluginRegistry.register` 已有的重复拒绝逻辑（`registry.ts:88-91`）。
3. **失败不静默** —— 复用 `loadFailures()`（`registry.ts:129-131`）。

---

### 8. 优先级表

| 优先级 | 项 | 阶段 | 收益 | 风险 | 建议 |
|---|---|---|---|---|---|
| **P0** | 修「界面偏好」说谎的控件（`WindowPrefsSection.tsx`） | 0-3 | 高（产品诚实性，`BANNED_CLAIMS` 的同类问题） | 零 | **立即** |
| **P0** | 删 `.fw-*` / `.lab-*` 死样式 | 0-1, 0-2 | 中（-95 行 CSS，-4 个无主 z-index） | 零（须逐条核对 `.lab-plugin-*` 仍在用） | **立即** |
| **P0** | 修 AI 面板宽度被覆盖（P4） | 0-4 | 高（一行修复一个视觉缺陷） | 零 | **立即** |
| **P1** | z-index 令牌化 + 改 `UiContract` 两处正则 + 补自证 | 1 | **最高**（把层级知识搬进类型，终结「注释解释为什么是 26」） | 中（动核心判据，须同步改） | 本轮做 |
| **P1** | 拖动 + 吸附 + 持久化（`useOverlayDrag`） | 2 | 高（用户明确要求过「防止遮挡文本」） | 零门禁冲突，但 `ttsBarPosition.ts` 的 4 组字面量必须留在原文件 | 本轮做 |
| **P2** | `OverlayHost` 统一挂载（消除双份手挂） | 2-4 | 中（新常驻层不再要挂两处） | 中（动 `main.tsx`，但不动 `openModal` 体系） | 本轮做 |
| **P2** | 焦点陷阱 + 滚动锁 | 2 | 中（可访问性与手感） | 低（纯行为，不改 DOM） | 本轮做 |
| **P3** | 多实例并存 | 2 | 中 | 中（要改 `openModal` 单例） | 暂缓 |
| **P3** | 可调整大小面板 | 3 | 中 | **高**（须改 `overlay-tier-check.mjs` 两处 + 补自证） | 需单独评审 |
| **P4** | dock 悬浮球层 / 插件 dock 入口 | 4 | 中 | 中（须定 `--z-dock` 到底在遮罩之上还是之下） | 需产品决策 |
| **—** | 统一 Esc 层栈（替换 4 种手写写法） | §4.5 步骤 2-3 | 低 | **高**（`UiContract.test.ts:559-601` 钉了函数名与字面量） | **不建议做** |

---

### 9. 附：给实现者的「不要做」清单

1. **不要**新增第二套 dialog 外壳（`UiContract.test.ts:203-222` 会红）。
2. **不要**给 dock 层加 `.overlay-backdrop`（`overlay-tier-check.mjs:203-205` 会红）。
3. **不要**在 TSX 里写 `width/height/maxWidth/maxHeight` 的像素值（`UiContract.test.ts:182-183` 会红）。
4. **不要**把 resize 作用在 `.dialog-shell` 上（`overlay-tier-check.mjs:206-209` 会红）。
5. **不要**删 `ttsBarPosition.ts` 里的 `HOLD_MS = 250` / `SLOP = 9` / `closest('button, a, input, select, textarea')` / `legado-tts-bar-reset`（`TtsBarPosition.test.ts:62-81` 逐条正则匹配）。
6. **不要**把 z-index 令牌化做成「令牌与字面量并存」—— 要么全改并同步改判据，要么不改。
7. **不要**用装饰字形画 resize 把手（`CopyStyle.test.ts:16-20` 的 `BANNED_GLYPHS`）。
8. **不要**在 `extensions/registry.ts` 里先加 `dockEntries` 类型而后补宿主 —— 那正是
   `plugin-framework.md:230-234` 批评的「承诺一个渲染不出来的能力」。

---

<!-- 来源：docs/archive/research/06-AI与插件能力核实.md -->

## 06 核实报告：AI 与插件能力问题

> 任务：verify-ai-r2  
> 结论日期：2026-10-22  
> 依据仓库：`E:\legado\legado`（青阅 QingYue，Kotlin/Ktor 后端 + React19 前端，运行于 `http://127.0.0.1:1234`，版本 0.8.4）
> 约束：只读源码 + 只读 GET；**不改源码**、不重启服务、不跑构建

---

### 0. 用户原话与本报告的对应表

| 用户原话 | 对应核实项 |
|---|---|
| `ai 功能太差，1 是位置问题，不能随时随地使用，不能在对应地点研究` | 悬浮球是否每个页面都有（尤其阅读器） |
| `没有上下文记忆` | 对话历史是否跨页面/跨会话 |
| `部分能力没有` | 39 个 AI 工具与 139 个端点的对照；缺什么 |
| 书源「编辑/修复/修改/删除/分组」 | 书源管理是否有入口与 AI 工具 |
| 书籍「换源」 | 换源是否可通过 AI 做 |
| 界面设置 / 主题设置 | 界面可塑性（另见 `02-界面可塑性优化.md`） |
| 书籍分组删除 | 书架分组删除入口 |
| 书源界面订阅/地址没移除 | 订阅搬家是否完成 |

> 说明：本文档**不复述“先把 AI 球挂到阅读器”**——这是本次会话中已经做完的动作（详见 `main.tsx` 与 `styles.css` 改动），正文只回答 **挂上之后还差什么**。

---

### 1. 结论总表

| 用户关心项 | 结论 | 证据（文件/命令） | 编者注 |
|---|---|---|---|
| **AI 位置：每个页面都能打开** | ✅ **已完成** | 改动 `web/src/main.tsx`：`currentUiContext` 提前计算，阅读器分支挂 `<AiFloatingBall>`；实测阅读器内 `.ai-fab` 存在、`z-index:60` | 本次会话已落地 |
| **AI 在对应地点研究** | ✅ **可用** | `UiContext` 含 `book.sourceId / book.bookUrl / book.name / book.author / book.chapterIndex / chapterTitle` | 阅读器面板携带「正在读第 N 章」 |
| **上下文记忆** | ✅ **已具备** | `aiChatStore.ts:37` 落 `localStorage` key `legado.ai.chat.v1`；模块级 `let state` + `useSyncExternalStore` | 关掉再开、换页均保留 |
| **在对应地点研究：模型收到什么上下文** | ✅ 已带 | `describeUiContext()` 含「当前界面／选中的书源／正在读第几章／当前搜索词」；`uiContextMessage` 作为 `system` 消息发出 | 见 §3.2 |
| **书源编辑/修改/删除** | ✅ **已有 AI 入口** | `source.upsert / source.validate / source.debug / source.delete` 已在 `BuiltinTools.kt` | 增/改/删/查/检都可由 AI 做 |
| **书源批量删除** | ✅ 已有 | `source.batch`（`action=delete`，带 `confirm`） | 仅 delete 落地 |
| **书源分组管理** | ⚠️ **缺** | 后端/前端有分组端点，但**没有 AI 工具** | 见 §3.1，优先级 P1 |
| **书籍换源** | ⚠️ **UI 有，AI 没有** | 前端 `chooseSource(searchStore.ts:428)` / `SourceSwitchModal` 可用；但 `source.switch` / `source.choice` 工具**没有** | 见 §3.2 |
| **界面设置 / 主题设置** | ✅ 有（另见 `02-界面可塑性优化.md`） | `features/builtinSettings.ts` 5 区；`CustomizeModal` + 7 套皮肤 + 安全皮肤注入 | 详看另一份报告 |
| **书籍分组删除** | ❌ **没入口** | `book_group` 表有 `DELETE /api/bookshelf/groups/{id}`，前端 `pages/ShelfPage.tsx` 没有分组删除项 | 见 §3.3，P0 |
| **AI 历史记录/对话历史** | ✅ 已有 | `aiChatStore.ts` 全局 `messages`；`clearAiChat()` 可删 | 见 §2 |
| **朗读控制** | ❌ **缺** | `/api/tts/*` 端点已有，但**没有 AI 工具** | 每次念一段/暂停/快退都要重新提问，或走前端按钮 |
| **备份与恢复** | ❌ **缺** | `/api/backup/*` 端点已有，但**没有 AI 工具** | 换机器时无人可操盘 |
| **插件框架** | ⚠️ **框架就绪、零装载** | `/api/plugins` 实测：`loaded:0, tools:42, providers:1, selectors:1` | 第三方第一个插件缺脚手架、模板、示例、实操文档 |

---

### 2. 对话历史与上下文记忆

#### 2.1 对话历史：跨页面、跨会话都保留

`aiChatStore.ts`：

| 位置 | 作用 |
|---|---|
| `const STORAGE_KEY = 'legado.ai.chat.v1'` | 落磁盘 key，跨会话恢复 |
| `let state: AiChatState`（模块级） | 应用共享，页面卸载不丢 |
| `useSyncExternalStore` 订阅 | 各页面组件看同一份对话 |
| 写入 `localStorage` | 刷新/重开仍在，`MAX_LINES = 200` 限大小 |
| `window.addEventListener('storage')` | 其他标签页改动自动同步 |
| `open: false` 不持久化 | 刷新后不自动弹窗 |

验证命令：`GET /api/plugins` → `loaded:0, tools:42, providers:1, selectors:1`（42 工具，含内置）；`aiChatStore.ts:37` 的 `STORAGE_KEY` 就是前端的会话记忆。

#### 2.2 「在对应地点研究」里，模型到底收到什么上下文？

`describeUiContext()`（`web/src/lib/uiContext.ts:60`）生成一段自然语言：

```
当前界面：阅读器
正在阅读：宇宙西游记（作者：作者： 阿里文学），正在读第 1061 章「秦皇留下的钱袋子」
这本书的标识：sourceId=https://www.patternrecognition.cn，bookUrl=https://www.patternrecognition.cn/book/2480/
当前搜索词：（当前未搜索）
```

其类型 `UiContext`（`web/src/lib/uiContext.ts:15`）：

```ts
export type UiContext = {
  page: string
  dialog: string | null
  source: { id: string; name: string } | null
  book: { sourceId: string; bookUrl: string; name: string; author?: string; chapterIndex: number; chapterTitle?: string } | null
  keyword: string | null
}
```

即：**页面 + 正在观看的书源 + 正在阅读的书与章节 + 当前搜索词**。模型问「这一章讲什么」「这一章后面会发生什么」时就知道领域，不需要用户重说。

---

### 3. 「部分能力没有」：哪些端点有、而 AI 工具没有？

工具清单来自 `app/src/main/kotlin/io/legado/ai/BuiltinTools.kt`（`all()`）。当前服务 `/api/plugins` 实测为 **42 个工具**（含内置），分组与 `/api/catalog` 的面一一对应：`sources / replace-rules / rss / bookshelf / notes / subscriptions / explore / search`。

| 域 | 是否有 AI 工具 | 对应端点 | 状态 |
|---|---|---|---|
| 书源 | ✅ | `/api/sources`、`{id}`、`validate`、`debug`、`health`、`import`、`batch`、`order` | 全覆盖 |
| 净化规则 | ✅ | `/api/replace-rules` 组 | 全覆盖 |
| RSS | ✅ | `/api/rss/sources` 组 | 全覆盖 |
| 书架 | ✅ | `/api/bookshelf` 组 | 全覆盖 |
| 笔记/阅读 | ✅ | `/api/notes`、`/api/reading-log`、`/api/reading-progress` | 读有，**写缺** |
| 订阅 | ⚠️ 部分 | `/api/subscriptions` | 无 `create` |
| 发现/搜索/正文 | ✅ | `/api/explore/sources`、`/api/sources/{id}/explore`、`/api/search`、`/api/books/details`、`/api/books/chapters`、`/api/books/content` | 全覆盖 |
| **朗读** | ❌ | `/api/tts/*` | **无 AI 工具** |
| **备份/恢复** | ❌ | `/api/backup/*` | **无 AI 工具** |
| **书源分组** | ❌ | `/api/sources/groups` | **无 AI 工具** |
| **插件管理** | ❌ | `/api/plugins` | **无 AI 工具** |
| **进度保存** | ❌ | `PUT /api/reading-progress` | 只有 `progressGet`，无 `set` |

重点回答「哪些后端端点有、而 AI 工具没暴露」：**上述 4 处（朗读、备份、插件、书源分组）＋ 进度保存**。它们是本次核实里**确实存在但没有 AI 暴露**的真实缺口。

---

### 4. 书源「编辑/修复/删除/分组」在哪儿？书籍「换源」有没有入口？

#### 4.1 书源：编辑/删除有入口，分组没有

- `source.upsert`（save + 乐观锁 version）、`source.validate`、`source.debug`（分阶段）、`source.delete` 已注册。
- **分组**：前端 `pages/SourcesPage.tsx` 与后端端点 `/api/sources/groups` 存在，但**没有 AI 工具**（`source.group.list` / `source.group.save` 均未注册）。这是“分组”这条线唯一没动的地方。
- **修复**：前端没有单独的“一键修复”入口；`source.debug` 提供分阶段诊断，后续可以包装成 `source.repair`。

#### 4.2 书籍「换源」：有前端入口，但 AI 不能做

前端 `searchStore.ts:428` 有 `chooseSource`，`components/SourceSwitchModal.tsx` 与 `reader/ReaderScreen.tsx:2279/2441` 的「换源」按钮均可使用。**但没有 `source.switch` / `source.choice` 工具**——用户能点，AI 不能。

---

### 5. 插件框架：零装载，第三方第一个插件缺什么？

`/api/plugins` 实测：

```
loaded:0, tools:42, providers:1, selectors:1, plugins:[], failures:[], describe:"插件框架 v0.8.4\n已装载 0 个插件..."
```

后端 `app/src/main/kotlin/io/legado/plugin/`：`Plugin`, `PluginManager`, `ToolRegistry`, `ToolHooks`, `EventBus`, `AppEvents`；前端 `extensions/registry.ts` / `plugins/`；文档有 `plugin-development-guide.md` / `plugin-framework.md`。**但没有示例插件**。

第三方写第一个插件缺什么：

| 缺项 | 原因 |
|---|---|
| **脚手架/模板** | 无仓库/项目结构可复制 |
| **示例插件** | 无可运行项目 |
| **写入包骨架（顶层目录结构）** | 无 |
| **注册链路（后端 + 前端入口）** | 无完整指引 |
| **测试样例** | 无 |

`PluginManager.load(Plugin)` 只要把 `.jar` 放进插件目录即可，但要真的让外部愿意贡献，**文档 + 模板 + 一个可运行示例**三件套才够。

---

### 6. 我的两处主动增强（本次会话已落地，不再复述流程）

为了回应「不能随时随地使用」：`main.tsx` 中 `currentUiContext` 提到阅读器分支之前，阅读器分支末尾也挂 `<AiFloatingBall uiContext={currentUiContext} />`。实测：阅读器内正文 6645 字、悬浮球在场、面板宽 480px、层级 60（模态打开时球不被遮挡）。

---

### 7. 优先级排序

| 优先级 | 动作 | 估算 | 备注 |
|---|---|---|---|
| **P0** | 补书源分组 AI 工具 | 半天 | 用户把「分组」放进来，卡在“写不到模型” |
| **P0** | 进度保存补 `set` 工具 | 半天 | 只有读，没有写 |
| **P1** | 补朗读后端 AI 工具 | 天 | 模型不能控制 TTS |
| **P1** | 补备份 AI 工具 | 天 | 换机器无人可操盘 |
| **P1** | 送插件框架脚手架 + 示例 | 天 | 零安装敢不想办法 |
| **P1** | 补 `source.switch` 换源工具 | 半天 | 每天搜索后必须切回 |
| **P2** | 补 `subscription.create` 工具 | 半天 | 现有订阅只有 `list/update/All` |
| **P2** | 书源分组删除入口 | 半天 | 后端有 `DELETE /api/bookshelf/groups/{id}`，前端缺入口 |
| **P2** | 朗读控制工具 | 天 | 暂停/快退/跳章 |

> 估算均为「1人半天」；这些都要同步改 `tools/verify/` 门禁与 `web/test/` 测试（如 `ApiCatalog.test.ts` 的 139 条契约）。

---

<!-- 来源：docs/archive/research/07-MD3借鉴与阅读器AI增强.md -->

## 07 MD3 借鉴与阅读器 AI 增强

> 研究对象：`https://github.com/HapeLee/legado-with-MD3`
> 版本：main 分支，`pushed_at: 2026-10-20`，6597 star / 754 fork / Kotlin / GPL-3.0
> 青阅对照：`E:\legado\legado`（Kotlin/Ktor 后端 + React 19/Vite SPA 本地阅读服务，v0.8.4）

**重要前提**：青阅不是 Android App，而是「Kotlin/Ktor 后端 + React 19/Vite SPA 前端」的本地服务。
因此**不照搬** MD3 的 Material Design 3 视觉体系（青阅有自有 7 套主题 + 62 条 CSS 令牌），只搬 **交互形态与阅读体验**：AI 如何在阅读器嵌入、划线/标记体系、朗读胶囊、配色主题、阅读进度同步。

---

### 0. 读了哪些文件

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

### 1. 对照结果总表

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

### 2. 重点：MD3 里「AI 在阅读器里的正确形态」

这是本次借鉴的核心。MD3 的精髓**不是**漂亮，而是把「读到一半」做成了一个可随时注入 AI 的工作台。

#### 2.1 整体架构：三个分离

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

#### 2.2 划词处理的完整链路（直接可复制到青阅的模板）

MD3 处理「选中一段」时，做了 6 步：

1. **校章**：`chapterIndex != ReadBook.durChapterIndex` 则 `showToast("章已切换")` 放弃。
2. **采上下文**：`buildSelectionContext(content, selectedText, chapterPosition)` → `contextBefore` / `contextAfter`（各 **1000 字符**）。
3. **建请求**：`PendingAiTextCleanRequest(bookUrl, chapterIndex, chapterTitle, chapterPosition, originalText, contextBefore, contextAfter)`。
4. **关菜单**：`host.closeReadMenu()`。
5. **发任务**：`cleanSelectedTextUseCase.start(...)`，观察 `cleanSelectedTextUseCase.observeTaskById(task)`，`isCurrentAiTextClean(request)` 防抖（同书 + 同章 + 同原文）。
6. **Confirm**：`saveBookContentProcessUseCase.saveReplacement(...)` 落库，再 `reloadChapterAfterContentProcessChanged` 重载该章正文。

**这套「采上下文 → 发任务 → 防抖 → 确认 → 落库 → 重载」** 是 MD3 的王牌，可以直接剪切到青阅的 `AiTextClean` 实现里。

#### 2.3 划词重写里的「参考章节」——比纯选词强一大截

`buildAiRewriteReferenceContext` 扫描**当前章的前后 80 章**，找出正文里出现频率最高的关键词（排除停用词）：
- 有「主角走进房间」这种 2–4 字短语？→ 提取；
- 有 `A-Z` 大写缩写？→ 提取；
- 取 **6 条**、每条 **600 字符**的摘录，拼成 `referenceText` 发给模型。

也就是说它不是问「把这段话改短」，而是让模型知道「上面说的那个人物/这个世界是什么」——**参考上下文**。这正是「对应地点研究」要的：模型看得到用户正在阅读的上下文。

青阅 `AiTextFactoryUseCase` 应补一个 `referenceText` 字段（或复用现有 `referenceText`），让划词重写真正带上参考上下文。

#### 2.4 流式与防抖

- 流式：`STATUS_RUNNING` 时实时更新 `rewrittenText`，`SUCCESS/FAILED` 时一次性改；
- 防抖：`isCurrentAiTextClean(request)` 检查「当前 sheet + 当前 bookUrl + 当前章节 + 当前原文」，免得后到把先到的覆盖掉；
- 收起 sheet 时 `cancel` 任务。

青阅 `AiTextClean` / `AiTextRewrite` 已有 `isLoading` 状态，**只差「同任务防抖」的判定**。

#### 2.5 状态的存在位置

MD3 的 `_uiState` 是 `MutableStateFlow(ReadAiUiState())` ——组件外、不依赖生命周期。`observeChapterTranslation` 绑定章节任务，**同一章节已观察则复用**。这就是「跨页面、跨会话」的落脚点，青阅 `aiChatStore` 的思路完全一致，我只要把「阅读器 AI 状态」也放到类似的模块级 store。

---

### 3. 青阅的落地设计（含文件与接口）

面向青阅（React 19 + Kotlin/Ktor 后端）。假定继承我本次已提交的「阅读器挂 AI 球」改造（`main.tsx`、`styles.css`、`AiFloatingBall.tsx`、`AiFloatingAssistant.test.ts`）。

#### 3.1 前端：新增 `reader/AiReader.tsx`（阅读器专属 AI 入口）

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

#### 3.2 后端：阅读 AI 工具接口（Kotlin）

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

#### 3.3 后端：划词成果写入（`book_content_process` 表）

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

#### 3.4 翻译胶囊

MD3 的 `TranslationThinkingCapsule.kt` 是「翻译思考中」占位。青阅无翻译功能；若要加入：

- 新增 `translationStatus` 于阅读态快照（`ReadingProgress`），由 `ReadingProgressSyncDelegate` 统一同步；
- `TranslationThinkingCapsule`：封装「翻译中」的显示（标题 + 进度 + 取消），保持与 `TtsPlayerBar` 一致的胶囊形态；
- 后端 `Agent` 增加 `ai.translate` 工具：`{ bookUrl, chapterIndex, text } → { translatedText }`。

#### 3.5 菜单形态（桌面版）

MD3 给桌面版三种菜单：**底部菜单**（手机）、**悬浮菜单**（鼠标悬停弹出）、**搜索菜单**。青阅现有：
- `reader/TocDrawerHeader.tsx` 有「钉住/倒序」按钮（`desktop-pin-btn` / `desktop-reverse-btn`），
- 抽屉式菜单（`reader-drawer`）。

**建议补 2 项**：
1. **悬浮菜单（`reader/MenuBarFloating.tsx`）**：在阅读区鼠标悬停固定一排「目录 / 笔记 / 划线 / 朗读 / AI」按钮，适合大屏；
2. **固定/倒序**：复用现有 `desktop-pin-btn` / `desktop-reverse-btn`，配合 `reader-sidebar-resizer` 的拖拽（见 `styles.css:1280-1330`）。

这两项与 MD3 `ReadBookMenuBar{*,Floating,Search}.kt` 的思路一致。

#### 3.6 配色主题（阅读专用）

MD3 的 `ReadBookColorTheme.kt` 把「阅读区配色」从整体主题里剥离。青阅 `readerSettings.ts` 已有 `--reader-*` 令牌，**方向一致**：
- 将「全局主题」→「阅读专用主题」分层：`全局主题 / 阅读主题 / 护眼模式` 三层；
- `ReadBookColorTheme` 里的规则（反转、深色、护眼）可收进 `reader/ReaderSettingsControls.tsx` 的「阅读主题」分区；
- 已有 `--elev-*`、`--reader-font-family`、`--reader-bg-color` 等灯节，**直接重用**。

#### 3.7 进度同步

`ReadingProgressSyncDelegate.kt` 里，MD3 把「章 + 章内比例」同步到标题。这对应青阅 `progress.get` 需要补：
- `chapterIndex`（现有），
- `titleProgress`（章内比例），
- `titleIndex`（已读到第几页标题），
- `totalTitleCount`（总标题数）。

---

### 4. 插件框架接入点（青阅）

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

### 5. 不适用清单（不要搬过去的）

| MD3 做法 | 不适用青阅的原因 |
|---|---|
| **Material Design 3 视觉体系** | 青阅有自有 7 套主题 + 62 条 CSS 令牌，MD3 的组件形态与配色依赖 AndroidMaterial；搬会破坏「主题可塑性」目标 |
| Android ViewModel / Lifecycle / Context 全家桶 | 青阅是 Ktor + React SPA，不是 Android 应用 |
| `android.content.Context` 直接依赖 | 青阅服务端是 Ktor/JVM，不依赖 Context |
| `ReadAloudCastDelegate` 的扬声器/蓝牙等安卓硬件 API | 除非跨平台发行到 Android，否则无必要 |
| `EyeProtection.kt` 的 Android 屏幕护眼传感器 | 现阶段可做成「护眼模式」配色与行距配置，无需传感器 |
| 桌面壳 `DesktopLauncher.kt` 的操作系统菜单 | 青阅已有 PWA 壳，不需要 OS 菜单 |

---

### 6. 优先级表

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

### 7. 最后的判断

MD3 给青阅最有价值的不是「代码」而是**交互设计**：把「读到一半」变成可随时注入 AI 的工作台，尤其是**划词带上下文、对参考章节、结果回填、防抖**这套完整流水线。

青阅当前已完成的（阅读器挂 AI 球 + `uiContext`）只是「位置」问题；**能落地最快、用户感知最强的 P0 两项**是：
1. 阅读器 AI 工具（拿到选中文本，直接让模型处理）；
2. 参考上下文（让模型知道用户正在看哪里）。

两项都能在 MD3 的 `ReadAiDelegate.kt` 里找到原型，可以按本表顺序逐项推进。

---

<!-- 来源：docs/archive/research/研究-借鉴-refgd与MD3.md -->

## 借鉴清单：refgd/legado 与 HapeLee/legado-with-MD3

> 2026-10-29。对照版本：refgd 单提交浅克隆、MD3 `f2cff58`（含 #2513 段评气泡）。
> legadoQ 侧以 `product/` 当前源码为准。行号会漂移，以文件与函数为准。

这份清单只回答两件事：**已经借了什么、还值得借什么**。不做逐文件读书笔记；
每一条都写清来源、我们现状、代价与判据，能直接当下一轮的任务单用。

### 0. 两个仓库的 AI 结构（先看骨架）

- **MD3** 把 AI 拆成五层：`AiProviderConfig`（协议 + 地址 + 头）、`AiModelConfig`（上下文窗口 / 输出上限 / 能力位）、
  `AiTaskPresetConfig`（任务 → 模型 + 提示词 + 参数）、`AiPromptPreset`（按任务可增删的提示词条目）、
  `AiArtifact`（按书 + 章 + 任务落库的 AI 产物）。协议实现三个 Handler 共用 `AiSseUtils` / `AiRetryUtils` /
  `AiProviderRegistry`。配置界面按「提供商 → 模型 → 任务」三层分页。
- **refgd** 把 AI 压成一层半：`AiChatService`（工具循环 + 提示词拼装）+ `AiToolRegistry`（原生工具 + MCP + 用户启停）。
  它没有协议抽象（只有 OpenAI 兼容），但工具面很宽：书架、章节正文、阅读记录、书源增删改查与调试、
  应用设置读写、Tavily 联网搜索、MCP 服务器。
- **legadoQ** 走的是「服务端 agent + 浏览器 UI」：`Agent` 负责工具循环，`LlmProvider` 三协议，
  `BuiltinTools` 55 个工具按组下发，提示词由前端会话携带，技能库落 `{home}/agent-skills/*.md`，
  提示词预设落 `{home}/agent-prompts.json`，历史按字符预算整轮裁剪。

一句话：**MD3 值得学的是"任务层"和"协议细节"，refgd 值得学的是"工具生态"和"技能/MCP"**。
两者都不该照搬的是"把全部工具/技能一次性塞给模型"。

### 1. 已落地（本轮已改，附来源与判据）

| 能力 | 来源（对方） | 我们落点 | 判据 |
|---|---|---|---|
| 三协议抽象：OpenAI Chat / OpenAI Responses / Anthropic | MD3 `data/repository/ai/*Handler.kt`、`AiProviderRegistry.kt` | `ai/LlmProvider.kt`、`OpenAiCompatibleProvider.kt`、`AnthropicProvider.kt`、`OpenAiResponsesProvider.kt` | `ProviderProtocolsTest`；`/api/agent/models` 按 `kind` 返回 `supported` |
| 共用出站件：拼地址、鉴权头、超时、重试、多 key、SSE | MD3 `AiRetryUtils.kt`（KeyRotator + 指数退避）、`AiSseUtils.kt` | `ai/ProviderHttp.kt`（唯一出站闸门，复用 `NetworkSecurity`） | 回环/私网拒绝、指向自身端口拒绝；`Retry-After` 上限 10s |
| 提供商预设带协议 | MD3 `AiProviderPresets` | `AiConnectionsModal.tsx` `PROVIDER_PRESETS`（OpenAI / Responses / Anthropic / DeepSeek / Moonshot / OpenRouter / 硅基流动 / Ollama） | 选预设同时填 `kind` + `baseUrl` + `model` |
| 模型清单探测 | MD3 `modelsUrl` | `POST /api/agent/models`（服务端代发，key 不落盘） | 表单「拉取模型」；`supported=false` 时给一句人话 |
| 流式对话 SSE + 停止 + 用量 | MD3 `AiChatViewModel` 的流式状态机、`AiThinkingStepsCard` | `POST /api/agent/chat/stream`；`web/src/features/ai/agentStream.ts`；两处聊天 UI 的草稿气泡与「停止」 | 客户端断开 → Ktor 取消 → `runInterruptible` 打断阻塞读；`usage`/`toolRounds` 随 `end` 帧回来 |
| 技能库（SKILL.md 形态） | refgd `AiSkillConfig` + `AiChatService.buildConversation` 的 system 注入 | `ai/AgentSkillStore.kt`（3 个内置 + 用户技能，落盘 `agent-skills/<id>.md`，删除进 `.trash`）；`GET/POST/DELETE /api/agent/skills` | 显式 `skills` 或关键词命中，最多 3 条；技能正文永不进日志 |
| 技能管理界面 | refgd 的技能配置项 | AI 接入弹窗「技能」区块：紧凑单行 + 展开正文 + 新建/覆盖/删除 | 内置技能只读、用户版本可覆盖；`enabled` 可停用 |
| 工具调用过程可见 | MD3 思考/工具卡片 | 草稿气泡内工具 chip（进行中/完成/失败 + 耗时）+ `<details>` 推理过程 | `agentStream.ts` 按 `callId` 配对 `tool_start` / `tool_end` |
| 工具参数 JSON Schema | refgd `AiResolvedTool.definition`（每个工具手写 schema） | `BuiltinTools` 每个工具补全参数 schema，经 `/api/agent/manifest` 下发 | 本轮已覆盖 55 个内置工具 |
| 提示词预设库 | MD3 `AiPromptPreset` + `AiPromptConfigScreen`（`name + instruction + enabled + sortNumber`） | `ai/AgentPromptStore.kt`（落盘 `{home}/agent-prompts.json`，删除前整份备份进 `.trash`）；`GET/POST/DELETE /api/agent/prompts`；AI 接入弹窗「提示词」区块（开关 + 上移/下移 + 编辑 + 删除） | `AgentPromptStore` 的排序/覆盖/上限/备份判据 + `AiPromptPresets.test.ts` 守界面与 API 接线 |
| 上下文预算裁剪 | refgd `messages.takeLast(12)`；MD3 `contextWindow` / `maxOutputTokens` | `Agent.trimToBudget`（`LEGADO_AI_MAX_CONTEXT_CHARS`，默 24000）：以 user 消息为段边界，从最旧的整轮开始丢 | `AgentPromptContextTest`：system 与最后一条用户消息必留、整轮不拆、`trimmed` 随 `start`/`end`/`chat` 回报并在气泡标注 |
| 凭据两层（持久 / 会话）+ 4096 淘汰 | MD3 `help/http/CookieManager.kt`、`CookieStore.kt` | `data/SessionCookies.kt`（内存层）+ `CookieDao.getCookieForUrl` 唯一出口合并并按"最后写入顺序"丢最旧的；`classifySetCookie` 判 Max-Age / Expires | `CookieLayersTest`（14 项，断言打在"实际会发出去的那条头"上）；`AiToolToggles.test.ts` 守界面把会话键与丢下的键摊开说 |
| 工具逐项停用 | refgd `AiToolRegistry.aiEnabledToolNames` | `aiToolGroups.ts` 存储 v2（`{groups, disabledTools}`，自动迁移旧数组）+ `ToolSelection.select` 一处过滤（`program` 组豁免）；`/chat` 与 `/chat/stream` 都收 `disabledTools` | `ToolSelectionTest` 五条停用判据 + `AiToolToggles.test.ts`（含"关组不清空逐项、反之也一样"） |

### 2. 还值得借（按性价比排序）

#### P0 · MCP 客户端（refgd `help/ai/AiMcpClient.kt`）

refgd 的实现不大（403 行）但完整：JSON-RPC 2.0 over HTTP、`MCP-Protocol-Version: 2025-06-18`、
`Mcp-Session-Id` 会话复用、`tools/list` 的 `nextCursor` 分页、按服务器指纹 + 60s TTL 的工具缓存、
工具名冲突时加服务器前缀的别名规则。工具统一挂 `mcp_` 组，和原生工具走同一个执行入口。

我们现状：没有 MCP。`ToolRegistry` 的 `origin` 字段已为外部工具留了位置（当前恒为 `builtin`）。
建议：先做 HTTP 传输（stdio 在桌面壳里再考虑），配置落 `{home}/agent-mcp.json`，
工具组固定 `mcp`，默认关；`/api/agent/manifest` 里带 `origin: "mcp:<server>"`。
判据：MCP 服务器不可达时聊天不失败（该组工具为空 + 一条 warning），工具调用超时按连接配置走。

#### 已落地 · 提示词预设库（MD3 `AiPromptPreset` + `AiPromptConfigScreen`）

MD3 的模型是：`taskType + name + instruction + enabled + builtIn + sortNumber`，同一任务可挂多条，
启用的按顺序拼进 system；内置条目可被用户改（生成用户副本），改坏了能恢复。

本轮落地的口径见 §1。与原建议差两点，都是有意为之：

- **没做 `taskType` 分任务**。我们目前只有"对话"这一个入口会被预设影响，摘要/清洗/改写还是各自
  的工具提示词；先按任务分档会让界面多一个没人动的下拉。等 §P1「按任务选模型」一起做时再分。
- **界面是独立区块**（在「技能」之前），没有塞进现有"系统提示词"折叠区：会话级 systemPrompt 是
  "这一轮的人设"，预设是"跨会话的全局要求"，混在一个折叠区里改的人会按错地方。

分工按原判断写进了界面提示与代码注释：**提示词是"怎么说话"，技能是"这类任务的专门做法"**；
两者都注入 system，顺序为基础人设 → 提示词预设 → 技能，注入顺序与回报的 `promptsUsed` 一致
（被预算挡掉的预设不算"用了"）。

#### P1 · 按任务选模型（MD3 `AiTaskPreset` / `AiTaskType`）

MD3 为 chat / 章节摘要 / 章节翻译 / 划词清洗 / 文本工坊 / 改写 / 朗读分析 / 角色识别 / 书架自动分组
分别指定连接、模型、温度、输出上限与提示词。好处很实际：摘要用便宜模型、改写用强模型，
而不是全局一个连接打天下。

我们现状：所有 AI 调用共用默认连接。建议先在**摘要/净化/改写**这三个明确任务上落地
（这三类已有工具入口），连接表单加"任务"下拉即可，不动现有连接页结构。

#### P1 · AI 产物落库（MD3 `AiArtifact`）

MD3 把摘要、翻译、清洗结果按 `bookUrl + chapterIndex + taskType` 存表，带内容哈希与模型标识，
可回看、可对比、可回填正文。这解决"AI 生成完就丢、下次重算"的浪费。

我们的笔记/划线已有独立表，AI 结果目前只在聊天记录里。建议新增只读产物列表 + 「重新生成」
（写操作走同源门），先只支持章节摘要与划词清洗两类。

#### P1 · 阅读器划词清洗 / 重写回填（MD3 `ReadAiDelegate`）

2026-10-22 的研究已详细记录：`openAiTextClean`（选区 + 前后各 1000 字上下文 → 落
`BookContentProcess(KIND_AI_CLEAN)` → 章节重载）与 `openAiTextRewrite`（整章润色，参考前 80 章）。
我们阅读器有选中工具栏，但没有"选中 → AI 处理 → 落库 → 原地重载"这条闭环。
建议按 MD3 的顺序做：先清洗（可逆、可删），再重写（差异预览后再落库）。

#### P1 · 推理强度与思考卡片（MD3 `AiReasoningLevel` / `AiReasoningModeButton`）

MD3 把 `reasoning_effort` / `thinking.budget_tokens` 统一成 OFF/AUTO/LOW/MEDIUM/HIGH/XHIGH/MAX 七档，
并按提供商身份决定映射（小米/DeepSeek 这类不认标准字段的直接不发）。
我们已有 `thinking` 选项与 Anthropic budget，但档位少、界面在"高级选项"里。
建议把档位补齐到 5 档（低/中/高/更高/最大），聊天输入框旁放一个紧凑下拉；
思考过程仍放 `<details>`，不要做成占满屏的卡片。

#### P2 · 联网搜索工具（refgd `AiTavilyTool`）

refgd 的 Tavily 工具写得很克制：只有开关 + key 才注册，参数带 `topic` / `searchDepth` / `maxResults`，
结果给"答案摘要 + 来源链接 + 片段"。我们没有任何联网工具。
建议做成"可配置的搜索连接"（Tavily / SearXNG / Bing），默认关，工具描述里明确"会把查询发给第三方"。
出站仍走 `NetworkSecurity`，结果渲染成来源列表，不让模型手写链接。

#### 已落地 · 工具级开关（refgd `AiToolRegistry`）

refgd 有 `defaultEnabledTools`（默认开的 20 个）、`aiEnabledToolNames`（用户增删）、
`groupLabelOfTool`（前缀 → 中文组名）。本轮在组级开关之上补了逐项停用：存储升到 v2
（`{groups, disabledTools}`，读旧的纯数组值自动迁移），`/api/agent/chat` 与 `/chat/stream`
都收 `disabledTools`，过滤只落在 `ToolSelection.select` 一处 —— 两条对话路径共用同一个函数，
不会出现"非流式停了、流式还带着"。

与原建议差两点，都是有意的：

- **不引入"默认启用 20 个"白名单**。refgd 需要它，是因为它的工具是一张手写的小表；我们有 55 个
  且已经按关键词选组，再加一层默认白名单等于让"没命中关键词"变成"什么都不能用"。
  默认值仍是"组开 = 全开"，老用户感知不变。
- **`program` 组豁免停用**。`program.catalog` 是模型的能力地图，摘掉它不是少一个能力，
  而是整条"先查再调"的按需发现失效 —— 界面上这一组不给复选框，服务端也无视对它的停用。

#### 已落地 · 上下文裁剪（refgd `messages.takeLast(12)`；MD3 `contextWindow` / `maxOutputTokens`）

refgd 只带最近 12 条消息，MD3 给模型配上下文窗口与输出上限。本轮在 Agent 侧落了一个保守的字符预算
（`LEGADO_AI_MAX_CONTEXT_CHARS`，默 24000 ≈ 1.2 万汉字），与原建议有三处不同：

- **按字符而不是条数**：`takeLast(12)` 在"一条消息粘了半章正文"时照样爆；字符数对中文字符串
  已经够稳，这层不引分词器。
- **丢弃单位是整轮而不是单条**：以 user 消息为段边界，一轮之内（含 assistant 的 `tool_calls`
  与它对应的 `role=tool` 结果）要么全留要么全丢 —— 拆开会得到上游那句 `invalid tool contract`。
- **两条保底**：system 段（人设 + 预设 + 技能）与最后一条用户消息永远保留；那条自己就超预算时
  **不截断**，宁可超一点也不悄悄改写用户问的内容。

`trimmed` 在 `start` 与 `end` 两帧都回报（前端只在真裁过时显示"已裁历史 N 条"），
非流式 `/chat` 与 `ChatOutcome` 同一口径。

#### P3 · 只读设置工具（refgd `AiSettingsTool`）

refgd 让 AI 能读写应用设置。写设置的风险远大于收益，我们只建议做只读诊断
（当前主题、书源数、存储占用、服务地址），并在工具描述里写明"不修改任何配置"。

### 3. 非 AI 借鉴

#### 已落地 · Cookie 的持久/会话分离与长度上限（MD3 `http/CookieManager.kt`、`CookieStore.kt`）

MD3 把 `Set-Cookie` 里 `persistent=false` 的会话 Cookie 放内存（重启即失效），持久的落库；
取 Cookie 时合并两层，并在总长度超过 4096 时淘汰键直到放得下。本轮照这个形状落地，
三处比 MD3 更严：

- **会话层是内存 Map，不加 `cookie` 表的 `session` 列**。它的定义就是"不该活过这次运行"，
  写进库再靠启动时清一遍，等于把"重启即失效"变成一个需要每次都对的条件；一旦漏清，
  用户重启后拿到的仍是那条本该作废的临时值。
- **淘汰按"最后写入顺序"丢最旧的，不是 MD3 的 `keys.random()`**。随机淘汰会让同一个域在两次
  请求里带出不一致的凭据 —— 对登录态等于偶发掉线，而且复现不了。为此 `setCookieForUrl`
  合并时把重设的键挪到尾部（顺序即新旧），拼头时保留"能装下的那段最新后缀"。
- **`Max-Age<=0` / `Expires` 已过会真的撤掉那一条**（两层都撤），而不是留着。站点用这个表达
  "退出登录"，我们此前把它当普通一条存下来，效果是用户登出了还带着旧凭据。

`Expires` 读不懂时**按会话处理**（不落库）：宁可少留一条，也不凭猜测把临时状态永久化。
用户手工粘贴的串没有任何属性信息，一律算持久 —— 他贴进来就是要它留下。

判据在 `CookieLayersTest`（14 项，断言打在"实际会发出去的那条头"上）；界面把会话键与
被 4096 丢下的键都摊开说（`仅本次会话（重启失效）` / `N 个键超出 4096 上限，不会发出：…`），
不静默截断。

#### P2 · 局域网拦截的"说清楚"（MD3 `LocalNetworkBlockedNotifier.kt` / `LocalNetworkAccess.kt`）

MD3 在 WebView 请求被内网策略拦下时弹一条可解释的通知，并区分"书源主动请求"与"网页内嵌资源"。
我们有 `NetworkSecurity` 的硬拦截，但界面只会看到"请求失败"。
建议在书源调试/正文加载失败时，把 `BlockedAddressException` 的原因翻成一句人话显示出来。

#### 已对齐、无需再借

- **请求压缩**：MD3 `DecompressInterceptor` 自动加 `Accept-Encoding: gzip, deflate` 并解压；
  我们 `RuleRunner` / `WebViewProxy` 已显式加头并按 `Content-Encoding` 解压，`CoverCache` 还兜了
  "没请求也回 gzip"的站点。
- **书源规则引擎**：MD3 的 `AnalyzeRule` 与我们同源，`RuleRunner` 已覆盖 XPath/JSONPath/JS/正则与
  级联回退；不做重复移植。
- **登录与 Cookie 跨域抓取**：0.1.5 起已按 MD3 的"注册域"口径实现，含导航历史回溯。

### 4. 不建议照搬

- **把全部启用技能/工具一次性注入**（refgd）：55 个工具 + N 条技能会把上下文吃光，且模型更容易选错。
  我们保持"组下发 + 关键词选技能（最多 3 条）"。
- **"必须先调用工具"的强制提示词**（refgd `requiresBookshelfTool`）：会诱发无意义调用与
  "为了调用而调用"的回答；按组下发 + 工具描述写清适用场景更稳。
- **Google Translate 协议**（MD3 `AiProtocol.GOOGLE_TRANSLATE`）：它不是聊天协议，翻译该走独立服务，
  混进 AI 连接会让"测试连接/模型清单"语义变糊。
- **Android 专属设施**：Cronet、WebView CookieManager、Keystore/生物识别加密（`BiometricEnvelopeWriter`）、
  `BackstageWebView`。我们是本地 Web 服务，对应能力由浏览器与 `WebViewProxy` 承担。
- **MD3 视觉体系**：Material 3 组件与配色不搬；只借交互形态（已做过一轮，见
  `docs/archive/research/07-MD3借鉴与阅读器AI增强.md`）。
- **AI 会话服务端持久化**：refgd/MD3 都存在数据库里，但我们是单机单用户，localStorage 的 20 个会话
  已够用；等服务端有"多端同步"需求再说。

### 5. 本轮判据

- 端点契约：`agent-api.json` 151 条 / 19 组 / 「AI 自定义接入」13 条；
  `FrameworkContractTest`、`web/test/ApiCatalog.test.ts`、`AgentCatalogTest` 三处同源。
- 协议：`ProviderProtocolsTest` 覆盖三家的请求形状、SSE 拼装、工具调用与错误分层。
- 流式：`chat/stream` 缺连接 409、messages 空 400、上游失败进 `error` 帧；前端
  `agentStream.ts` 对"没有 end 就断线"给 `stream_closed`，中止不算错误。
- 技能：`AgentRoutesHttpTest` 覆盖「内置 3 条带正文」「新建落盘 `agent-skills/<id>.md`」「删除进 `.trash` 且再删 404」
  「内置技能拒删（400 `invalid_skill`）」；关键词选择上限 3 在 `AgentSkillStore.select` 里。
- Cookie（待做）：新增会话 Cookie 合并与 4096 淘汰的单元测试后再动线上路径。

---

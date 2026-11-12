# 前端命名与文件组织规范

> 现状是**大体统一、局部不一致**。这份规范的目的不是推倒重来，
> 而是把已经在做的事写下来，并收掉那几处例外。

## 0. 现状体检（2026-10-21 实测）

| 项 | 现状 | 结论 |
|---|---|---|
| 导出方式 | 130 个文件全部 named export，**零 `export default`** | ✅ 已统一，写进规范 |
| 组件文件命名 | 全部 PascalCase，`NamingConventions.test.ts` 断言违规集合为空（例外仅 `main.tsx` / `app/pages.tsx` / `icons.tsx`） | ✅ 已统一，写进规范 |
| hooks 命名 | 2 个，都是 `useXxx` | ✅ 已统一 |
| 目录分层 | `app/`（shell）`features/`（7 个业务域）`plugins/`（扩展）`components/`+`lib/`（shared）`i18n/` `icons.tsx` `main.tsx`；**`pages/` 已消失** | ✅ 有判据守着 |

## 1. 文件命名

### 1.1 含 JSX 的组件文件 → **PascalCase**

```
✅ ReaderScreen.tsx   AppHeader.tsx   SourceHealthModal.tsx
❌ aboutPanel.tsx     labHost.tsx     main.tsx（入口例外，见 §1.4）
```

理由：文件叫什么，import 时看到的就是什么。`aboutPanel.tsx` 里导出的是 `AboutModal`，
文件名与导出名对不上，搜索时容易漏。

### 1.2 不含 JSX 的模块 → **camelCase**

```
✅ readerSettings.ts   searchStore.ts   openBook.ts   pageMeta.ts
```

### 1.3 hooks → `useXxx.ts`，导出 `useXxx`

```
✅ lib/useEscapeClose.ts   → export function useEscapeClose()
✅ reader/useReaderTts.ts  → export function useReaderTts()
```

### 1.4 三个例外（写死，别再争）

| 文件 | 为什么例外 |
|---|---|
| `main.tsx` | Vite 入口约定，必须叫这个 |
| `app/pages.tsx` | 导出的是 `renderPage` 函数（渲染分派），不是组件 |
| `icons.tsx` | 导出 `Icon` 与图标名表，是资源模块不是单一组件 |

## 2. 导出方式

**一律 named export，不用 `export default`。**

```ts
✅ export function ReaderScreen() {}
✅ export const PAGES: PageMeta[] = []
❌ export default function ReaderScreen() {}
```

理由（不是洁癖）：
- 改名时 IDE 能自动跟；default 导出改名要手改调用点。
- 搜索 `import { X } from` 能找到全部使用处；default 导出搜不到。
- 现在 130 个文件全是 named，**保持零例外**比"大部分是"更好守。

## 3. 组件命名

| 类型 | 后缀 | 例 |
|---|---|---|
| 页面级 | `XxxPage` | `ShelfPage`、`LibraryPage`、`RssPage` |
| 浮层 / 弹窗 | `XxxModal` | `AboutModal`、`PluginsModal` |
| 面板（浮层里的内容块） | `XxxPanel` | `PluginListPanel` |
| 通用小组件 | 名词本身 | `Icon`、`Logo`、`Select` |
| 错误边界 / 容器 | `XxxBoundary` / `XxxHost` | `ErrorBoundary`、`labHost` |

## 4. 目录职责

```
web/src/
├── app/          shell / 组合根：路由表与页面分派（`pages.tsx`）+ 全局顶栏（`AppHeader.tsx`）
│                 这里的东西**只许被 `main.tsx` 引用**，不许被 shared 或 features 反向 import
├── features/     产品自带内容，按业务域纵向切分
│   ├── ai/            AI 接入
│   ├── bookshelf/     书架与书库（含 LibraryPage）
│   ├── explore/       发现页
│   ├── reader/        阅读器内核
│   ├── rss/           RSS 与书源订阅（含 RssPage / RssPanel）
│   ├── settings/      设置
│   └── source-editor/ 书源编辑
├── plugins/      扩展：注册机制（extensionRegistry / slotRegistry / ExtensionSlot）
│                  + 每个扩展自带的浮层与其内容页
├── components/   共享组件
├── lib/          无 UI 的模块（api、store、工具函数）
├── i18n/         文案集中表
├── icons.tsx     图标资源模块
└── main.tsx      应用外壳（宿主本体）
```

**依赖方向**（由 `web/test/ArchitectureBoundary.test.ts` 逐条守着）：

- `components/` `lib/`（**shared**）**不许** import `features/` —— 否则共享层被焊死在某个业务上；
- `features/` **之间不许互相 import** —— 互引即等于切分名存实亡；
- `app/`（**shell**）**可以** import features，且**不许被别的层 import**；
- **不再有 `pages/`** —— 2026-11 已整体迁走（页面进 `features/<域>/`，只服务单个弹窗的进
  `plugins/<扩展>/` 与消费者同目录），判据会断言该目录**不存在**，防止旧层重建。

三条基线（跨 feature / shared→feature / pages→feature）都**只许单调缩小**；前两条的剩余条目
见 `docs/restructure/frontend-host.md` §3.2，第三、四条已是零基线、无豁免通道。

## 5. 判据（已经有的，别破坏）

| 判据 | 守什么 |
|---|---|
| `ApiCatalog.test.ts` | 端点契约双向核对（绝对计数以 `ApiCatalog.test.ts` 的断言与 `agent-api.json` 的 `count` 为准，这里不抄） |
| `CopyStyle.test.ts` | 界面文案不许用装饰字形 |
| `HeaderMenu.test.ts` | 前端不许出现字面量版本号 |
| `UiContract.test.ts` | 浮层只有一档几何（不许弹窗套弹窗） |

## 6. 新增文件时自检

1. 含 JSX 吗？→ PascalCase；不含 → camelCase。
2. 是 hook 吗？→ `useXxx.ts`。
3. 用 named export 了吗？→ 必须。
4. 放对目录了吗？→ 按 §4 的目录职责表。
5. 组件后缀对吗？→ 按 §3。
6. 跑 `npm run check` 与 `npm test`。

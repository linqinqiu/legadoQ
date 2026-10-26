# 前端命名与文件组织规范

> 现状是**大体统一、局部不一致**。这份规范的目的不是推倒重来，
> 而是把已经在做的事写下来，并收掉那几处例外。

## 0. 现状体检（2026-10-21 实测）

| 项 | 现状 | 结论 |
|---|---|---|
| 导出方式 | 130 个文件全部 named export，**零 `export default`** | ✅ 已统一，写进规范 |
| 组件文件命名 | 67 个 PascalCase / 7 个 camelCase | ⚠️ 这 7 个要收 |
| hooks 命名 | 2 个，都是 `useXxx` | ✅ 已统一 |
| 目录分层 | `lab/` `extensions/` `plugins/` `features/` `pages/` `reader/` `shelf/` `sources/` `components/` `lib/` `app/` | ✅ 有判据守着 |

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
| 页面级（`pages/`） | `XxxPage` | `ShelfPage`、`SourcesPage` |
| 浮层 / 弹窗 | `XxxModal` | `AboutModal`、`PluginsModal` |
| 面板（浮层里的内容块） | `XxxPanel` | `PluginListPanel` |
| 通用小组件 | 名词本身 | `Icon`、`Logo`、`Select` |
| 错误边界 / 容器 | `XxxBoundary` / `XxxHost` | `ErrorBoundary`、`labHost` |

## 4. 目录职责

```
web/src/
├── app/          路由表与页面分派（纯数据 + renderPage）
├── extensions/   插件**契约**（FrontendPlugin 形状、注册表）
├── plugins/      插件**机制**（装配点、清单）
├── features/     产品自带内容
│   ├── ai/         AI 接入（独立一类）
│   ├── plugins/    插件查看面板（独立一类）
│   └── settings/   产品自带的设置分区
├── pages/        一级页面
├── reader/       阅读器内核
├── shelf/        书架
├── sources/      书源
├── components/   通用组件
└── lib/          无 UI 的模块（api、store、工具函数）
```

**依赖方向**：`extensions/` 不许 import `plugins/`、`features/`（插件契约不认识具体插件/功能）。

## 5. 判据（已经有的，别破坏）

| 判据 | 守什么 |
|---|---|
| `ApiCatalog.test.ts` | 端点契约 142/19 双向核对 |
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

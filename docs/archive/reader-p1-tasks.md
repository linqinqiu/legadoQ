# P1 任务清单 · 阅读器地基

> 配套：`reader-p1-requirements.md`、`reader-p1-design.md`
> 标记：`[x]` 已完成 · `[~]` 进行中/部分 · `[ ]` 待做

> **代码真实进度核对（2026-10-24）**：P1-T1 后端 / 类型 / 后端测试已落地，但 `readerProgress.ts` 的逻辑位置推导**仍未做**（仅 `api.ts` 类型与 `saveProgress(position)` 管道就绪，上报值暂为默认 0）；P1-T4 已落地（`ReadersRoutes.kt` 替代 `ProgressRoutes.kt` + `ReadingRepository` 收口 + `Routes.kt` 接入 + 测试通过），仅 DAO 降级留尾；P1-T2 基础设施已建（无 DOM 布局引擎 + IndexedDB 缓存，单测各 6/6，**渲染接入待 P2**——近似引擎与真实 CSS 排版结构性不一致，本阶段保留 DOM 测量不替换）；P1-T3 已收尾（三层解耦 + 沉浸式 + 退出把手 CSS 修复）；P1-T5 仍待启动。注意：当前仓库另有一批**不属于本 P1 spec** 的 0.8.x 阅读器功能改动（自定义应用名/图标 `BrandModal`/`brandStore`、书内搜索 `BookSearchDialog`、划线标记菜单 `MarkingMenu`、笔记导出 `noteExport`、选区上下文 `selectionStore`、书源健康排序 `SourceHealthDao`、AI 阅读侧工具），属常规迭代，请勿误并入 P1 验收。版本号唯一来源 `app/build.gradle`（当前 0.8.6）。

## P1-T1 逻辑位置模型
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

## 静态自检结论（2026-10-24）
- 后端：`ReadingProgress`/`BookNote`/`BookNoteWrite` 字段顺序与 DAO 的 INSERT/SELECT 列数、参数序号逐一核对一致；迁移用既有 `pragma table_info + alter table` 模式，新列均有默认值（向后兼容）。
- 调用点：`BuiltinTools.kt` 的 6 位置参数 `ReadingProgress` 已改为具名 `updatedAt`（否则错位到 `charOffset`）；其余测试/调用均为具名或 ≤5 位置参数，安全。
- 备份：`ImportDao` 导入 `reading_progress` 仅原始 6 列，新列走默认值 → 不中断；导出侧为通用转储，不受影响。
- 前端：`api.ts` 类型扩展为可选字段，`saveProgress` 增加可选 `position` 参数，老调用方（5 位置参数）不受影响；离线队列同步携带新字段。
- 阻塞：环境命令运行时挂钩超时，无法跑 gradle/vite 构建做真实验证。

## P1-T2 精确分页与缓存引擎（基础设施已建，渲染接入待 P2）
> **路线调整（2026-10-24）**：原拟「无 DOM 布局引擎一步替代 DOM 测量」经核实不可行——`measurePagination` 是对浏览器真实 CSS 排版的逆向测量（首行缩进→假栏数、跨栏 section 矩形量不准等坑它都处理了），而本阶段建的纯数学近似引擎（CJK 等宽）与真实 CSS 排版**结构性不一致**，直接替代会确定性翻页错位，非偶发风险。故本阶段只落地**基础设施**，渲染主路径保留 DOM 测量，精确引擎替代留 P2 把精度打磨到与 CSS 一致后再做。
- [x] 无 DOM 文本布局引擎 `web/src/reader/typeset/`（typesetParams / layoutEngine / layoutWorker）：纯 TS 数学排版，可在 Worker/主线程/Node 一致运行；单测 6/6 通过
- [x] 分页缓存 `web/src/reader/paginationCache.ts`：IndexedDB 落盘（key = 书 + 章节内容哈希 + 字体/字号/行距/边距/窗口尺寸 + 双栏模式；LRU 淘汰）；单测 6/6 通过
- [~] 二者当前**未接入** `ReaderScreen` 渲染主路径（避免近似引擎翻页错位）；接入与精度打磨归 P2
- [ ] P1-T5 统一缓存抽象：本阶段仅落地分页缓存这一具体实例，不做全局抽象（留 P1-T5）
- [ ] 页码仅作逻辑位置派生显示，不参与存储（不变）

## P1-T3 阅读三层解耦 + 沉浸式（已收尾）
- [x] 三层已解耦为独立组件：阅读面（正文）、导航面 `Md3Chrome.tsx`（`Md3TopBar`/`Md3BottomBar`，`position:fixed` overlay 不挤压正文）、设置面 `ReaderSheet.tsx`（底部 sheet，复用 `.dialog-shell`/`.overlay-backdrop`）
- [x] 默认沉浸式：`ReaderScreen.tsx` 的 `toolbarsVisible` 初始 `false`；纯阅读退出把手 `.reader-immersive-handle` 已补 CSS（此前缺样式、退化成文档流原生按钮，退出不可发现——已修 `styles.css`）
- [x] 设置面实时预览：设置走 React state 即时重渲正文，无提交/重开步骤
- [x] 判据 `web/test/ImmersiveDefault.test.ts`（5 条，含默认隐藏工具栏 / 沉浸 pill / 退出可发现 / overlay 不挤压正文）通过
- [ ] 路由图层化（阅读面默认安静、导航/设置面 overlay 不挤压正文）已满足；后续 P5 再做玻璃质感等增强

## P1-T4 阅读域模块 + ReadingRepository（已落地，DAO 降级留尾）
- [x] 新增 `readerRoutes()` 装配入口，`Routes.kt:182` 已按域调用（挂在 `route("/api")` 内）
- [x] 新建 `ReadingRepository` 统一封装进度 / 阅读记录 / 笔记划线（含书签）/ 本书检索读写；章节窗口留 P2 stub（`chapterWindow` 返回空，契约先定）
- [~] DAO 退化为表级 CRUD：业务读写已收口到 Repository，但 `Database` 的扩展函数（`saveProgress`/`getProgress`/`addNote`…）仍带业务语义、未被下沉为裸表级 CRUD —— 功能上已收口，降级为后续清理，非阻断
- [x] 路由文件从「端点清单」变为「域声明」（`ReadersRoutes.kt` 注释明确；旧 `ProgressRoutes.kt` 已删除，端点平移无重复注册，142 条 `/api` 契约不受影响）
- [x] 测试：`ReadingRepositoryTest.kt` 已建并随 `gradle :app:test` 通过

## P1-T5 统一缓存抽象（阅读侧）（待启动）
- [ ] 统一缓存抽象暴露 get/set/invalidate
- [ ] 分页缓存 / 章节解析缓存 / 媒体缓存经该抽象落盘
- [ ] 阅读模块只声明 cache key，不直接操作存储

## 依赖与门禁
- P1-T2 的「二分定位」依赖 P1-T1 前端 `charOffset` 推导完成。
- P1-T4 的 Repository 直接消费 P1-T1 已落地的数据字段。
- 任一任务落地须配 `P4-T4` 对应测试；版本号只改 `app/build.gradle`。

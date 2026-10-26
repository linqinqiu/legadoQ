# 阅读器重构 · 验证与测试规划

> 配套：`reader-redesign-roadmap.md`（五阶段）、`reader-p1-requirements.md` / `reader-p1-design.md` / `reader-p1-tasks.md`
> 目的：把「怎么算做完」落成可执行的测试门禁；记录当前核验状态
> 语言：简体中文

## 1. 当前核验状态（2026-10-24）

| 项 | 命令 | 结果 |
|---|---|---|
| 前端类型检查 | `npm --prefix legado run check`（`tsc -b`） | ✅ 退出码 0，无报错无警告（覆盖 `api.ts` 逻辑位置类型扩展）|
| 后端逻辑位置单测 | `gradlew :app:test --tests "io.legado.LogicalPositionTest*"` | ⏳ 后台运行中（task xcyqov）|
| 后端全量测试 | `npm test`（gradle） | ⏳ 待 P1-T1 单测通过后再跑，确认既有用例不受模型增量影响 |
| 静态自检 | 全仓构造点 + 参数序号 + 备份路径复核 | ✅ 无破坏性不一致 |

> 环境命令运行时（`agent-studio` 钩子）曾持续 3000ms 超时，阻塞 Bash/Glob；PowerShell 可用，已改用 PowerShell 跑构建/测试。

## 2. 构建与测试命令（备查）

### 前端（`legado/web`）
- `npm --prefix legado run check` — TypeScript 类型检查（`tsc -b`）。改 `api.ts` / 前端类型后必跑。
- `npm --prefix legado/web run test` — 单测（`tsx test/run-all.ts`；不含需浏览器的 e2e）。
- `npm --prefix legado/web run test:coverage` — 覆盖率（`c8`）。
- `npm --prefix legado/web run test:e2e` — 浏览器压测（puppeteer，需 Chromium）。

### 后端（`legado`，Kotlin/JVM）
- `npm test`（= `node scripts/tasks.mjs test`，即 gradle `:app:test`）— 全量单测。
- 定向：`gradlew :app:test --tests "io.legado.LogicalPositionTest*"`。
- 域级（P1-T4 后）：`testApplication` 只加载阅读域 + 必要插件，不启完整 fat jar（`web/test/ApiCatalog.test.ts` 已有 catalog 比对范式）。

### 全栈冒烟
- `npm start` → `curl http://127.0.0.1:1234/healthz`（版本/存活）、`/api/catalog`（端点数）。

## 3. P1 验收门禁矩阵

| 任务 | 必须有的测试 | 说明 |
|---|---|---|
| **P1-T1 逻辑位置** | `LogicalPositionTest`（已加：进度/批注字段往返 + 老库迁移默认）| 前端 `charOffset` 视图推导 + 二分定位恢复单测待补（需 readerFlow 改造后）|
| **P1-T2 分页缓存** | 分页缓存 key 单测（`书ID+字号+行距+字体+窗口尺寸`）、改字号重排耗时基准、二分定位单测 | 性能基准见 `P4-T3` |
| **P1-T3 三层解耦** | E2E：默认沉浸式、导航/设置面 overlay 不挤压正文、隐藏控件可发现退出 | 复用 `E2EScenariosTest.ts` 范式 |
| **P1-T4 域模块** | `readerRoutes()` 装配 + `ReadingRepository` 收口后，域测试 `testApplication` 仅加载阅读域 | 路由从「端点清单」变「域声明」 |
| **P1-T5 缓存抽象** | 统一缓存 get/set/invalidate 单测；阅读模块只声明 key | 与 P1-T2 / P2 媒体缓存共用 |

## 4. 跨阶段门禁（P4-T4 复用）

- 同源写门：新增端点自动受保护（`SameOriginGuardTest` 已有范式，扩展覆盖阅读域新端点）。
- SSRF 闸门：`NetworkSecurityTest` / `OpenAiProviderSsrfTest` 已有，新增出站点复用。
- 域级测试：每个域落地须配对应测试，否则视为未完成（见 roadmap 跨阶段约束）。

## 5. 已知限制与风险

- 逻辑位置字段暂不进 Legado 备份往返（`ImportDao` 导入列仅原始 6 列，`LibraryImportEntry` 不携带 `charOffset`）—— 后续在备份格式增补。
- 前端 `charOffset` 视图推导 + 二分恢复未完成，是 P1-T1 剩余子任务（依赖 P1-T2 分页索引）。
- 大章节字符偏移用 `integer`（上限 ~21 亿字符），超限章节罕见，超阈值再升 `Long`。

## 6. 下一步建议

1. 等后台 gradle 单测结果；若通过，跑 `npm test` 确认既有用例无回归。
2. 进入 P1-T2（精确分页引擎）：先做可独立测试的「分页缓存 key + 落盘」，再接 Web Worker。
3. 每完成一个 P1 子任务即补对应单测，门禁见第 3 节。

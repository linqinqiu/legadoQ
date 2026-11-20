# 17 运行时测试基线（Phase 0.6 · RT-13）

> 目的：在**不修任何代码**的前提下，采集"当前代码在干净工作区里能不能跑通"的客观基线，作为后续 12 条运行时验证的参照系。
> 执行日期：2026-11-17 23:27 – 23:45（Asia/Shanghai）
> 执行位置：`E:\legadoQ`（`refactor/rebuild` 分支，HEAD `771b311`，工作树无源码改动）
> 记录原则：原始输出全部落盘（`18_RUNTIME_TEST_RAW_LOGS/`），本文只做汇总与解读，不改写任何结果。

---

## 1. 结论摘要

| 套件 | 总数 | 通过 | 失败 | 跳过 | 耗时 | 退出码 |
|---|---:|---:|---:|---:|---:|---|
| 后端 `:app:test` | **992** | **986** | **0** | **6** | 12m27s（首次，含编译） | **0（BUILD SUCCESSFUL）** |
| 前端 `web test`（独占运行） | **1,091** | **1,091** | **0** | 0 | **23.2s** | **0** |
| 前端 `web test`（与后端并发时） | 1,091 | 1,090 | **1** | 0 | 81.2s | 见 §5.3 |
| 全量入口 `npm --prefix product test` | 三步全绿 | — | 0 | — | 前端 23.2s + 后端 `UP-TO-DATE` | **0** |

**一句话**：**这套测试在一个干净克隆上是能跑通的**——后端 992 项零失败，前端 1,091 项在独占运行时全绿。唯一的失败出现在"前端测试与后端 Gradle 测试并发"的场景，且已通过隔离重跑证明是**测试自身用真实时钟断言**导致的时序抖动，不是产品缺陷。

**因此：基线可用。** 后续 12 条运行时验证可以以"后端 992/0/6、前端 1091/0/0"作为参照。

---

## 2. 环境（完整记录）

| 项 | 值 | 采集方式 |
|---|---|---|
| 操作系统 | **Windows 11 Home**，10.0.26200，64-bit | `Get-CimInstance Win32_OperatingSystem` |
| CPU 核数（Gradle 并行 fork 上限依据） | 4（`maxParallelForks = min(4, availableProcessors)`） | `app/build.gradle:39` |
| JDK | **Temurin 17.0.19+10**（`openjdk version "17.0.19" 2026-04-21`） | `java -version` |
| `JAVA_HOME` | `E:\Apps\DevTools\Eclipse Adoptium\jdk-17.0.19.10-hotspot` | 环境 |
| Gradle | **8.14.4**（wrapper 自带，dist 已缓存于 `~/.gradle/wrapper/dists/gradle-8.14.4-bin`） | 日志 `BUILD SUCCESSFUL` |
| Node.js | **v24.18.0** | `node -v` |
| npm | **11.16.0** | `npm -v` |
| 项目引擎要求 | `node >= 20.0.0`、`npm >= 10.0.0` | `product/package.json` |
| 前端依赖安装 | `npm ci --prefix product/web` → **402 packages in 1m**（首次；`node_modules` 不存在，已被 `.gitignore` 忽略） | 命令输出 |
| 后端测试并行度 | 4 forks，worker 堆上限 `768m` | `app/build.gradle:31,39` |
| 测试临时目录 | **`E:\legadoQ-runtime\testtmp`**（`LEGADO_TEST_TMP`，仓库外） | 见 §3 |

### 2.1 隔离措施（对应"不得污染旧项目数据"）

| 风险 | 处置 | 结果 |
|---|---|---|
| 测试写到归档的真实书库 `E:\legadoQ-archive\product\data` | 测试全程只在 `E:\legadoQ` 运行，归档未被访问（`git -C E:\legadoQ-archive status --porcelain` 为空） | ✅ 零接触 |
| 测试临时库落到系统 temp 或仓库内 | `LEGADO_TEST_TMP=E:\legadoQ-runtime\testtmp`（项目自带开关，`app/build.gradle:17-24`）；用例本身用 `Files.createTempFile/createTempDirectory` | ✅ 全部落在仓库外 |
| 前端测试写仓库文件 | 前端 139 份判据全程只读源码 + 内存断言；`node_modules` 由 `npm ci` 生成（gitignored） | ✅ 无源码改动 |
| 误改源码以求通过 | 全程未编辑任何源码/测试/断言/配置（`git status` 见 §7） | ✅ |

---

## 3. 执行方式（可复现命令）

```bash
# 0) 隔离目录（仓库外）
mkdir -p /e/legadoQ-runtime/testtmp
export LEGADO_TEST_TMP='E:\legadoQ-runtime\testtmp'

# 1) 后端（按负责人要求先单独跑）
cd /e/legadoQ/product && ./gradlew :app:test --no-daemon --console=plain \
  2>&1 | tee /e/legadoQ/REBUILD_PLAN/18_RUNTIME_TEST_RAW_LOGS/01_backend_app_test.log

# 2) 前端（先装依赖，再跑）
cd /e/legadoQ && npm ci --prefix product/web
npm --prefix product/web test 2>&1 | tee .../02_frontend_web_test.log

# 3) 全量入口（= 更新日志门禁 + 前端 + 后端）
cd /e/legadoQ && npm --prefix product test 2>&1 | tee .../03_full_npm_test.log

# 4) 覆盖率（后端已由 finalizedBy jacocoTestReport 自动产出；前端单独跑）
npm --prefix product/web run test:coverage 2>&1 | tee .../04_frontend_coverage.log
```

**全量入口的实际构成**（`product/scripts/tasks.mjs:38-45`）：`0/3` 更新日志门禁 → `1/3` 前端用例 → `2/3` 后端用例。

---

## 4. 后端结果（`./gradlew :app:test --no-daemon`）

### 4.1 汇总

| 指标 | 值 |
|---|---|
| 测试套件（XML 文件） | **139** |
| 用例总数 | **992** |
| 失败 / 错误 | **0 / 0** |
| 跳过 | **6** |
| 各套件耗时代数和 | 687s（4 fork 并行，墙钟约 8–9 分钟） |
| Gradle 墙钟 | **12m27s**（含首次编译 1,508 个 class + jacoco 报告） |
| 结果 | `BUILD SUCCESSFUL` |

> 与历史口径的差异：`facts.md`（2026-11-11）记 1,110 个静态 `@Test`、实跑 1,109；本次为 **992 项**。差额来自 2026-11-17 把 AI 子系统 54 文件 / 25 个测试类整体移出编译路径（`a105588`），**不是测试被删**。本次静态 `@Test` 计数为 993，实跑 992（1 项未被任何套件执行，属历史已知现象）。

### 4.2 最慢的套件（Top 6）

| 套件 | 耗时 |
|---|---:|
| `ApiRoutesHttpTest` | 81.8s |
| `ApiCompressionHttpTest` | 52.9s |
| `E2EScenariosTest` | 44.9s |
| `BackupSnapshotsEndpointTest` | 31.5s |
| `BackupImportAtomicTest` | 25.5s |
| `BackupImportTest` | 21.5s |

> 这些套件都起 `testApplication` 并跑真实 HTTP 栈。历史上它们在高负载下会以 `UncompletedCoroutinesError: After waiting for 1m…` 的形式"假红"（`facts.md` 记录过 12 例）。**本轮零复现**。

### 4.3 跳过的 6 项（全部是设计内跳过，非失败）

| 套件 | 用例 | 原因 |
|---|---|---|
| `BrandStoreTest` | 坏掉的 brand json 不炸 回落到内置外观 | `assumeTrue` 未满足（依赖构建产物） |
| `BrandStoreTest` | 带 BOM 的配置文件也读得动 | 同上 |
| `StaticAssetsHttpTest` | index html still never caches and unknown assets do not leak | 同上 |
| `StaticAssetsHttpTest` | healthz reports which frontend build is actually running | 同上 |
| `StaticAssetsHttpTest` | assets gzip when the client accepts it and stay whole after inflate | 同上 |
| `StaticAssetsHttpTest` | etag revalidation answers 304 and head is served | 同上 |

**机制**（`StaticAssetsHttpTest.kt:27,63,79,81`）：干净检出里没有 `product/web/dist`（未跑 `npm run build`），用例用 `Assume.assumeTrue(asset.isNotEmpty())` **主动跳过而不是假红**。本轮 `dist` 确实不存在，所以 4 项被跳过符合预期。

### 4.4 编译期告警（不影响本次结果，但有两处值得记账）

| 位置 | 内容 | 性质 |
|---|---|---|
| `rules/RuleValue.kt:773-775` | `JXDocument` 三个构造函数已弃用 | 依赖弃用（JsoupXpath） |
| `rules/ScriptConvert.kt:58` | 非空断言 `!!` 多余 | 代码卫生 |
| **`JsSandboxHostAmplificationTest.kt:59`** | `Check for instance is always 'true'. This will become an error in language version 2.4` | **潜在编译期风险**：Kotlin 2.4 起会变成 error，届时构建直接红 |
| `DatabaseLifecycleTest.kt:89,124,161,186,284,314,339,368` | 表达式未使用 ×8 | 代码卫生 |
| `SourceLoginTest.kt:250,254,482`、`SubscriptionServiceHttpTest.kt:44` | 多余 `!!` | 代码卫生 |
| `JsGuardLimitsTest.kt:158`、`JavaPackagesEntryBaselineTest.kt:38` | `optimizationLevel` 已弃用 | Rhino API 漂移 |

---

## 5. 前端结果（`npm --prefix product/web test`）

### 5.1 汇总（独占运行，即全量入口里的 `1/3`）

| 指标 | 值 |
|---|---|
| 测试文件 | **139**（`run-all.ts` 扫目录，<60 份直接 `exit 1` 防"假绿"） |
| 用例总数 | **1,091** |
| 通过 / 失败 / 跳过 / 取消 | **1,091 / 0 / 0 / 0** |
| 耗时 | **23.2s**（`duration_ms 23220`） |

> 与历史文档（`facts.md`：1,056 项、20–40s；`STATUS.md`：1,157 项）相比：本次 1,091 项、23.2s，量级一致。差异来自后续增删（含 AI 前端测试移出）。

### 5.2 最慢的 10 个用例

| 耗时 | 用例 |
|---:|---|
| 17,600ms* | Challenger 2 Focus 2.3: Scroll Debounced Persistence and Preload Threshold |
| 6,348ms* | 变体开关 - 七个变体都能出主题 |
| 4,673ms | RELEASES.md 每一行都能被 git 复算 |
| 4,070ms | 流式合并的规模：常驻判重表线性 |
| 3,346ms | 确定性 - 同一输入两次结果完全相等 |
| 1,850ms | 量化打分 - 一半红一半蓝的图返回两种颜色 |
| 1,792ms | M3 基线 - tonalSpot 浅色 primary 就是种子本身 |
| 1,482ms | 对比度参数 - 越界夹到 [-1,1] |
| 1,238ms | 全黑与灰阶 - 同样被过滤 |
| 1,177ms | Challenger 1: Search Filtering Speed Benchmark across 5,000 and 20,000 chapters |

\* 这两项耗时来自**并发运行**那一次（与后端 Gradle 并行），独占运行时会显著下降。它们都是**用真实时钟/性能断言**的用例，是本轮唯一不稳定来源（见 §5.3）。

### 5.3 唯一的失败：`PerformanceMonitor.test.ts`（时序断言）

| 项 | 内容 |
|---|---|
| 失败用例 | `慢请求的两个阈值不是同一个数：300ms 报 warn，500ms 才进 bottlenecks` |
| 位置 | `product/web/test/PerformanceMonitor.test.ts:131` |
| 断言 | `assert.equal(performanceMonitor.report().bottlenecks.length, 0)` — 注入 310ms 延迟，期望**不进** 500ms 阈值 |
| 实际 | `1 !== 0`（既然"进了 bottlenecks"，说明实测耗时 > 500ms） |
| 发生场景 | 前端测试与后端 Gradle 测试**并发**运行时（日志 02） |
| 隔离重跑 | `npx tsx test/PerformanceMonitor.test.ts` → **9/9 全过**，该用例耗时 **940.9ms**（注入 310ms + 等待开销 630ms） |
| 独占全量重跑 | 全量入口的 `1/3` 步 → **1,091/1,091 全过** |
| 判定 | **测试缺陷（真实时钟断言对机器负载敏感）**，非产品缺陷。详见 `19_RUNTIME_TEST_CLASSIFICATION.md` C-1 |

---

## 6. 全量入口结果（`npm --prefix product test`）

| 步骤 | 内容 | 结果 |
|---|---|---|
| `0/3` | 更新日志门禁 `changelog.mjs --check` | ✅ `[changelog] 没有待记录的改动（自查 0 条提交，边界 771b311）` |
| `1/3` | 前端用例 | ✅ 1,091/1,091，23.2s |
| `2/3` | 后端用例 | ⚠️ **`> Task :app:test UP-TO-DATE`**（Gradle 判定输入未变，**未重新执行**），`BUILD SUCCESSFUL in 1m12s` |
| 汇总 | — | ✅ 退出码 0 |

**必须说明的一点（流程坑，不是缺陷）**：因为第 1 步刚跑过同一份编译产物，Gradle 的增量判定把 `:app:test` 标为 `UP-TO-DATE`，**这一步实际上没有重跑任何用例**。所以：

- 本次"后端 992/0/6"的权威结果来自**第 1 步那次真实执行**（12m27s）；
- 若要让"全量入口"真正端到端跑一遍，必须先 `./gradlew :app:cleanTest`（或用 `--rerun-tasks`）。

这条对后续 RT-1…RT-12 有直接影响：**不能拿"`npm test` 绿了"当成"后端测试跑过了"**。

---

## 7. 覆盖率基线

### 7.1 后端（JaCoCo，本次 `:app:test` 的 `finalizedBy jacocoTestReport` 自动产出）

| 计数器 | 覆盖率 |
|---|---|
| 行 | **72.92%**（10,973 / 15,049） |
| 指令 | 59.79%（106,964 / 178,887） |
| 分支 | 45.40%（7,350 / 16,188） |
| 方法 | 68.68%（2,908 / 4,234） |
| 类 | 68.66%（598 / 871） |

> 与 `facts.md`（2026-11-09：后端行 70.04%）**不可直接比较**：那次统计含 AI 子系统的 3,987 行，本次 AI 已移出编译路径，分母从 18,860 降到 15,049。**新的可比基线是 72.92% / 15,049 行。**

### 7.2 前端（c8，`npm --prefix product/web run test:coverage`）

| 计数器 | 覆盖率 |
|---|---|
| 行 / 语句 | **65.8%**（17,516 / 26,619） |
| 分支 | 79.8%（2,410 / 3,020） |
| 函数 | 67.93%（623 / 917） |

> 与 `facts.md`（2026-11-09：前端行 63.51%）相比 +2.3pp，但两次的 `include/exclude` 规则与源文件集不同（AI 前端已移出），**照样只作趋势参考，不作精确对比**。

---

## 8. 不稳定与环境依赖（本轮实测）

| # | 现象 | 触发条件 | 证据 | 性质 |
|---|---|---|---|---|
| 1 | `PerformanceMonitor` 310ms 用例偶发失败 | 与其他 CPU 密集任务并发 | 隔离重跑通过、实测 940ms | 测试缺陷（真实时钟） |
| 2 | 6 项 `assumeTrue` 跳过 | `product/web/dist` 不存在（未构建前端） | `StaticAssetsHttpTest.kt:27,63` | 环境依赖（设计内） |
| 3 | 前端套件耗时 23s ↔ 81s | 并发负载 | 两次 `duration_ms` | 环境（非缺陷） |
| 4 | 后端全套 12m27s | 首次编译 1,508 class + 939 项起 Ktor | Gradle 日志 | 环境（首次成本） |
| 5 | 历史"并发假红"（`UncompletedCoroutinesError`） | 4 个审计任务同机并发 | **本轮零复现** | 环境（未能复现，记录在案） |
| 6 | Node 24 超出项目声明范围（`engines: >=20`） | 运行时版本 | `node -v` | 环境风险（未观测到异常） |

---

## 9. 原始日志清单（`18_RUNTIME_TEST_RAW_LOGS/`）

| 文件 | 大小 | 内容 |
|---|---:|---|
| `01_backend_app_test.log` | 8.4 KB | 后端 `:app:test` 完整控制台输出（含全部编译告警、任务序列、`BUILD SUCCESSFUL`） |
| `02_frontend_web_test.log` | 96.9 KB | 前端 1,091 项逐条结果 + 唯一失败用例的完整堆栈 |
| `03_full_npm_test.log` | 97.6 KB | 全量入口三步完整输出（含 `0/3` 门禁原话、`1/3` 逐条、`2/3` 的 `UP-TO-DATE`） |
| `04_frontend_coverage.log` | 见目录 | c8 逐文件覆盖率表 + 汇总 |

> 后端逐用例结果另有 Gradle 原生产物：`product/app/build/test-results/test/*.xml`（139 份，含 `testcase` 级耗时与跳过原因），以及 HTML 报告 `product/app/build/reports/tests/test/index.html`、覆盖率 `product/app/build/reports/jacoco/test/html/index.html`。

---

## 10. 局限（不要把这些当成已验证）

1. **未跑**：`test:e2e`（`e2e-browser-stress.ts`，需真浏览器）、`product/tools/verify/*-check.mjs`（47 个需活服务 + headless Chrome）、Docker 构建。
2. **未验证**：前端 139 份判据中 **88 份是"读源码文本"式断言**（`grep` 语义），它们在本次全绿只说明"源码文本符合预期"，**不构成运行时行为证据**。
3. **未验证**：`@Test` 静态 993 与实跑 992 的差 1（历史已知），本轮未定位是哪一条。
4. **可比性**：覆盖率数字与历史快照不可直接比较（AI 子系统移出改变了分母），本册给出的 72.92% / 65.8% 是**新基线**。
5. **本次未做任何修复**（按授权），所有失败与告警只记录、不处理。

---

## 11. 对后续 12 条验证的影响（结论）

1. **基线可信**：后端 992/0/6、前端 1091/0/0 可作为参照系；后续任何"多出失败"都能判定为新引入。
2. **必须显式重跑后端**：跑 RT-1…RT-12 时若要顺带回归，用 `cleanTest` 或 `--rerun-tasks`，否则会拿到 `UP-TO-DATE` 的假绿。
3. **避免并发跑**：时序类用例（`PerformanceMonitor`、`Scroll Debounced Persistence`、性能基准）在并发负载下会抖；建议运行时验证**串行**执行，并记录机器负载。
4. **6 项跳过是有条件的**：如果后续需要覆盖静态资源/品牌相关行为，先 `npm --prefix product/web run build` 生成 `dist` 再跑。

# 19 运行时测试失败分类（Phase 0.6 · RT-13）

> 配套：`17_RUNTIME_TEST_BASELINE.md`（结果与数据）、`18_RUNTIME_TEST_RAW_LOGS/`（原始输出）。
> 分类口径严格区分四类，**不允许把"环境问题"写成"代码缺陷"来博眼球，也不允许把"测试缺陷"洗成"偶发"**。

---

## 0. 分类口径

| 类别 | 定义 | 处理方式（本阶段） |
|---|---|---|
| **代码缺陷** | 产品源码的行为与预期不符，且换个环境也应当复现 | 记录复现条件 + 源码位置 + 影响范围，**不修** |
| **环境问题** | 与机器/版本/负载/缺失产物有关，换环境可能不出现 | 记录触发条件与规避方式，**不修** |
| **测试缺陷** | 测试自身的断言方式/依赖不可控因素，导致结果不稳定或断言无效 | 记录并给出"它本该怎么写"，**不修** |
| **不确定** | 证据不足以归入以上三类 | 记录待查点与验证方法 |

---

## 1. 总览

| # | 现象 | 分类 | 严重度 | 是否影响基线可信度 |
|---|---|---|---|---|
| **C-1** | `PerformanceMonitor` 310ms 阈值用例在并发负载下失败 | **测试缺陷**（+ 环境负载诱因） | 中 | 否（独占运行全绿） |
| **C-2** | 6 项 `assumeTrue` 跳过（`BrandStoreTest` 2 / `StaticAssetsHttpTest` 4） | **环境问题**（设计内） | 低 | 否（设计如此） |
| **C-3** | 全量入口 `2/3` 步 `Task :app:test UP-TO-DATE` | **流程问题**（不是缺陷） | 中 | **是**（易误判为"后端跑过了"） |
| **C-4** | `JsSandboxHostAmplificationTest.kt:59` "always true" 告警，Kotlin 2.4 将变 error | **代码缺陷**（潜在，尚未发生） | 中 | 否（当前不影响） |
| **C-5** | 4 处 `JXDocument` 弃用 + 2 处 Rhino `optimizationLevel` 弃用 | **代码缺陷/技术债**（依赖漂移） | 低 | 否 |
| **C-6** | Node 24 超出 `engines: >=20` 声明范围 | **环境问题**（未观测到异常） | 低 | 否（但需记账） |
| **C-7** | 前端 139 份判据中 88 份是"读源码文本"式断言 | **测试缺陷**（覆盖性质，不是失败） | 高 | **是**（"全绿"不等于行为对） |
| **C-8** | 历史记录的高负载 `UncompletedCoroutinesError` 假红 | **环境问题**（本轮零复现） | 低 | 否 |
| **C-9** | `@Test` 静态 993 vs 实跑 992（差 1） | **不确定** | 低 | 否（不影响失败判定） |
| **C-10** | **RT-3 运行时验证：`ruleData` 跨书源变量污染** | **代码缺陷（设计缺陷）** | **P1** | 是（影响规则正确性，见 §12） |

**结论**：**0 个"当前会失败的产品缺陷"**；1 个测试缺陷导致的不稳定（C-1）；1 个流程陷阱（C-3）与 1 个覆盖性质问题（C-7）会**实质影响后续验证的可信度**，必须写进方法论；2 个潜在/技术债项（C-4/C-5）；1 个不确定项（C-9）。

---

## 2. C-1 `PerformanceMonitor` 时序断言失败 —— **测试缺陷**

### 2.1 事实

- 失败用例：`慢请求的两个阈值不是同一个数：300ms 报 warn，500ms 才进 bottlenecks`
- 位置：`product/web/test/PerformanceMonitor.test.ts:131`
- 注入 310ms 延迟，断言 `performanceMonitor.report().bottlenecks.length === 0`（因为 310ms < 500ms 阈值）
- 实际：`1 !== 0` ⇒ 实测耗时被记为 > 500ms

### 2.2 证据链

| 观察 | 结果 |
|---|---|
| 与后端 Gradle 测试并发时（日志 `02`） | ❌ 失败（`1 !== 0`） |
| 单文件隔离重跑（`npx tsx test/PerformanceMonitor.test.ts`） | ✅ 9/9 通过，该用例耗时 **940.9ms**（注入 310 + 等待开销 630） |
| 独占全量重跑（`npm --prefix product test` 的 `1/3`） | ✅ 1,091/1,091 通过 |

### 2.3 判定

**测试缺陷**。根因不是产品代码，而是用例**用真实时钟测量真实 `setTimeout`**：
- 它把"注入 310ms 延迟"当成"实测就是 310ms"，但 `slowFetch` 内部 `await new Promise(r => setTimeout(r, ms))` 在负载下可能实际耗时 500ms+（证据：隔离环境该用例已测到 940ms）。
- 也就是说：**即使没有并发，这条断言也只在"机器足够空闲"时成立**。

### 2.4 它本该怎么写（只记录，不实施）

- 把 `performanceMonitor` 的时间源做成可注入（`now: () => number`），用假时钟而非真实 `setTimeout`；
- 或断言"占比/相对值"而非绝对阈值；
- 项目里已有先例：该文件其它用例用的是"记录一次耗时再断言"，只有这一条绑定了绝对毫秒线。

### 2.5 影响

- 对产品：无。
- 对基线：**有方法论影响**——后续 12 条运行时验证必须**串行执行并记录机器负载**，否则会把这类抖动误判为产品缺陷。

---

## 3. C-2 6 项 `assumeTrue` 跳过 —— **环境问题（设计内）**

| 套件 | 用例 | 跳过机制 | 缺什么 |
|---|---|---|---|
| `BrandStoreTest` | 坏掉的 brand json 不炸 回落到内置外观 | `Assume.assumeTrue` | 品牌资源/构建产物 |
| `BrandStoreTest` | 带 BOM 的配置文件也读得动 | 同上 | 同上 |
| `StaticAssetsHttpTest` | index html still never caches… | `assumeTrue(asset.isNotEmpty())`（`:63,79,81`） | `product/web/dist` |
| `StaticAssetsHttpTest` | healthz reports which frontend build… | 同上 | 同上 |
| `StaticAssetsHttpTest` | assets gzip when the client accepts it… | 同上 | 同上 |
| `StaticAssetsHttpTest` | etag revalidation answers 304… | 同上 | 同上 |

**判定**：设计内行为，源码注释明写「干净检出（没跑过 `npm run build`）里没这份资源，用 `assumeTrue` 跳过而不是假红」（`StaticAssetsHttpTest.kt:27`）。**不是缺陷，也不掩盖问题**——但如果将来要用测试覆盖静态资源行为，必须先 `npm --prefix product/web run build`。

**给后续验证的规避方式**：需要跑这 6 项时，先构建前端再把 `dist` 放到位。

---

## 4. C-3 全量入口的后端 `UP-TO-DATE` —— **流程问题（影响基线可信度）**

### 4.1 事实

`npm --prefix product test` 的三步：

```
0/3 更新日志门禁   → ✅ 没有待记录的改动
1/3 前端用例       → ✅ 1,091/1,091（23.2s）
2/3 服务端用例     → ⚠️ Task :app:test UP-TO-DATE（未执行）+ BUILD SUCCESSFUL in 1m12s
```

### 4.2 为什么这是"流程问题"而不是"缺陷"

Gradle 的增量判定认为输入（源码/资源/测试类）与上次执行一致，于是跳过。这在日常开发里是**优点**，但在"采集基线"和"发版前确认"场景下是**陷阱**：退出码 0 会被读成"后端测试通过"。

### 4.3 影响与规避

- 本次的权威后端结果是**第 1 步单独执行**的那次（12m27s、992/0/6）；
- 任何"我要确认后端真的跑过"的场景：`./gradlew :app:cleanTest :app:test` 或 `--rerun-tasks`；
- **建议**（不改代码，只记录）：后续若要让 `npm test` 真正端到端，可在 tasks.mjs 里给 `2/3` 加上 `cleanTest`——这属于 Phase 1 的工程改进，不在本阶段处理。

---

## 5. C-4 `JsSandboxHostAmplificationTest.kt:59` —— **代码缺陷（潜在，编译期）**

```
w: .../JsSandboxHostAmplificationTest.kt:59:40 Check for instance is always 'true'.
   This will become an error in language version 2.4.
```

### 判定与影响

- **今天不是失败**（只是 warning）。
- **将来会变成构建失败**：Kotlin 语言版本升到 2.4 时，这条直接 error。
- 位置在**测试代码**里，所以影响的是"能不能编译测试"，不是产品运行时。
- 同类还有 8 处 `DatabaseLifecycleTest` 的"表达式未使用"（`Expression is unused`）——那些只是卫生问题，不会变 error。

**给后续的建议**：Phase 1 统一 Kotlin 语言版本/插件版本时，这一条会先红；届时是"一行改动"级别，不应与结构重构混在一起。

---

## 6. C-5 依赖弃用 —— **技术债**

| 位置 | 弃用内容 | 归属依赖 | 风险 |
|---|---|---|---|
| `rules/RuleValue.kt:773,774,775` | `JXDocument(Document/Elements/String)` 构造 | `JsoupXpath 2.5.1` | 该库已停更（`03` §6 已记录），下次升级可能直接移除 | 
| `JsGuardLimitsTest.kt:158`、`JavaPackagesEntryBaselineTest.kt:38` | `optimizationLevel` 属性 | Rhino 1.8.0 | Rhino 升级时必须重跑沙箱不变量判据（`12c` §9.2） |
| `rules/ScriptConvert.kt:58`、`SourceLoginTest` ×3、`SubscriptionServiceHttpTest` ×1 | 多余 `!!` | Kotlin | 纯卫生 |

---

## 7. C-6 Node 24 超出声明范围 —— **环境问题（记账）**

- 项目声明：`engines.node >= 20`（`product/package.json`），npm `>= 10`。
- 实跑：**Node v24.18.0 / npm 11.16.0**。
- 观测结果：前端 1,091 项独占运行全绿、`tsc` 类型检查未单独跑、构建未跑。
- 判定：**当前未见异常**，但项目文档（`STATUS.md` §8）自己记过"Web runner 与 TypeScript 构建信息文件受 Node / 文件权限环境影响"，所以这条要记账：**后续若出现"只有某些机器红"，先怀疑 Node 版本**。

---

## 8. C-7 "全绿"的覆盖性质 —— **测试缺陷（最需要警惕的一条）**

前端 139 份判据里，**88 份是"读源码文本"式断言**（`grep` 语义，例如断言"某个字符串出现在源码里""某文件不允许 import 另一包"）。这类判据：

- ✅ 能有效守住**架构边界、词表一致性、文件存在性**（这是它们的价值，也是 `04` §A11 列为资产的原因）；
- ❌ **天然覆盖不到运行时行为**。

所以本轮"前端 1,091/1,091 全绿"的准确含义是：**"源码文本符合 88 类静态约束 + 少数真行为判据通过"**，不等于"阅读器行为正确"。

这与 `15_READER_INTERACTION_MATRIX.md` 的结论完全一致：**23 行交互里端到端有判据 0 行**，4 个"高缺口"全在进度链上。**任何"改阅读器但测试没红"的情况，都不能当作安全信号。**

---

## 9. C-8 历史"并发假红"未复现 —— **环境问题**

`facts.md` 记录过：满负载复跑时后端出现 12 例失败，全部是 `UncompletedCoroutinesError: After waiting for 1m, the test body did not run to completion`，集中在 `AgentRoutesHttpTest`(8) 与 `AgentErrorClassHttpTest`(4)——而这两个类已随 AI 子系统移出编译路径（`a105588`）。

本轮：4 fork 并行 + 前端测试并发，**零复现**。判定：历史现象与"AI 测试类 + 高负载"绑定，当前代码集已不具备该条件。

---

## 10. C-9 `@Test` 静态 993 vs 实跑 992 —— **不确定**

- 静态 `grep -rho '@Test' | wc -l` = **993**
- JaCoCo/JUnit XML 统计 = **992**（其中 6 项 skipped）
- 差 1，历史文档（`facts.md`）也记过同样现象："静态 1,110 与实跑 1,109 的差 1 是历史现象（有一条用例没有被任何测试类执行）"，但未定位具体是哪一条。

本轮**未定位**（属于"不值得为 1 条用例花时间"的范畴）。记为不确定项；若后续要精确对账，可用 `grep -rn "@Test" -A2` 与测试类方法名做集合差。

---

## 11. 对后续 12 条运行时验证的 4 条硬要求

1. **串行执行**，避免 C-1 类时序抖动；每次记录执行前后的机器负载。
2. **显式重跑**后端：`cleanTest` 或 `--rerun-tasks`，避免 C-3 的假绿。
3. **区分"文本判据绿"与"行为正确"**：涉及阅读器/进度的验证，必须以**实际请求/实际 DB 变化**为准，不能引用"C-7 类测试通过"。
4. **保持只记录不修复**：本轮 0 个产品缺陷失败，所以后续如果出现失败，**优先怀疑环境/时序/未提交改动**（本项目历史上有并行 agent 半成品的情况，见 `AGENTS.md` §0）。

---

## 12. C-10 RT-3 运行时验证结果：`ruleData` 跨源变量污染 —— **代码缺陷（设计缺陷），P1**

> 完整报告：`20_RT3_RULEDATA_ISOLATION.md`；原始日志：`20_RT3_RAW_LOGS/`（同一套实验 3 遍，结论一致）。
> 本轮**未修复**（按授权：只记录复现条件、日志、源码位置与影响范围）。

### 12.1 分类

**代码缺陷（设计缺陷），不是环境问题、不是测试缺陷。**

判定依据：污染由源码结构决定，与环境无关——`ruleData` 的键是**纯 URL**，不含 sourceId
（`RuleRunner.kt:135-142`、`:1743-1757`），且该表是 **RuleRunner 实例级、进程长寿**的
（`Application.kt:168` 单例装配）。同一份驱动连跑 3 遍结论完全一致。

### 12.2 复现条件（最小）

1. 两个书源 A、B，各自的规则里都 `@put:{tag:…}`；
2. A 在**搜索**里写入变量（键 = 解析出的 `bookUrl`）；
3. B 用**同一个 bookUrl** 取详情（或 A 的 `tocUrl` 被 B 当 bookUrl 用）；
4. B 的 `tocUrl` / `chapterUrl` 里带 `@get:{tag}` → 拼出来的是 **A 的 tag**。

### 12.3 实测结果（标签按负责人四档）

| 标签 | 结论 |
|---|---|
| **CONFIRMED** | 跨源污染（同 bookUrl、跨阶段键碰撞、目录链路）；并发 last-writer-wins；跨线程共享；实例级隔离；键上限 4096；同执行内共享；不同 URL 不串 |
| **NOT_REPRODUCED** | 规则执行失败后变量残留（三次均无残留） |
| **LIKELY** | "换源后新源继承旧源变量"（未驱动 `switchBookshelf`，按同一 bookUrl 推得） |
| **NEEDS_MORE_TEST** | 真实语料里 URL 碰撞的实际比例；生产并发下的碰撞频率；多页目录 `pageUrl` 键行为 |

### 12.4 影响范围

- **会静默出错**：拼出错误 URL → 空目录 / 空正文 / 上游 404·422，界面无任何提示；
- **不涉及**：写库、删数据、越权、出网（变量只影响请求 URL 拼装）；
- **现实触发面**：同一本书被多源收录、**换源**、聚合站 URL 复用、并发搜索后的详情/目录读取。

### 12.5 源码位置

| 位置 | 作用 |
|---|---|
| `rules/RuleRunner.kt:135` | 表创建（`newRuleDataCache(MAX_RULE_DATA_KEYS)`） |
| `rules/RuleRunner.kt:137-142` | `rememberRuleData(key: String?, …)` / `recallRuleData(key: String?)`——**键只有 URL** |
| `rules/RuleRunner.kt:273` | 写入点 1：搜索条目（键 = bookUrl） |
| `rules/RuleRunner.kt:690` | 写入点 2：详情解析完（键 = tocUrl，值为「旧值 ∪ 本次 put」） |
| `rules/RuleRunner.kt:647, 814, 957` | 读取点：详情 / 目录首页（含翻页 `pageUrl`）/ 正文 |
| `rules/RuleRunner.kt:1743-1757` | LRU 工厂（4096 键，`accessOrder=true`） |
| `rules/RuleValue.kt:43, 376-388, 511-519` | `ruleVariables` 本体 + `@put`/`@get` 解析 + `snapshot/seed` |
| `Application.kt:168,172` | 生产端单例装配（并注入离线缓存） |

### 12.6 为什么它没有在 RT-13 的测试基线里暴露

后端 992 项测试**没有一个跨书源驱动 `ruleData`**：现有用例要么单源单书、要么用
`responseFetcher` 桩只验单个规则的结果。这与 `14_RULE_COMPATIBILITY_MATRIX.md` 的结论一致——
矩阵覆盖的是**单条规则语义**，不覆盖**跨执行状态**。本轮 RT-3 恰好补的是这块空白。

### 12.7 对后续验证的影响

1. RT-4（进度倒退）与 RT-3 无耦合，可独立进行；
2. 但**任何涉及"多源/换源"的验证都要先把这条记在案**：拿到"空目录"时先排除变量污染，再怀疑书源失效；
3. 修它属于 Phase 1 的设计输入（`20` §6 给了三个方向），**不在运行时验证阶段动手**。

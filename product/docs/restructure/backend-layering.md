# 后端分层分析：domain / engine / api 三层止血（第一阶段）

> 状态：**分析已定稿，本阶段不改任何代码**。本文只描述现状、判据与迁移清单，**不移动任何文件、不改任何行为**。
>
> 取证方式：直接扫 `product/app/src/main/kotlin/io/legado/` 源码树（Node 脚本解析 `package` 与 `import`，剥注释时**保留换行**以保证行号真实）＋ 逐文件人工核对关键行。所有 `文件:行号` 均可按文中路径复查。
>
> 口径约定：本文路径一律以仓库根为基准；行号取 **当前工作区 HEAD**（`bebd824`）的真实行号。
>
> 相关文档：[architecture-audit.md](../../docs/architecture-audit.md)（三条既有边界）、[frontend-host.md](./frontend-host.md)（前端宿主侧，同批产出）。

---

> ## ⚠️ 执行后更正（本文写完后，T5 / P-final-B 已落地，且本文对它的评估是错的）
>
> 本文 §3.2 的 **T5（`KernelPorts` 聚合）** 与 §3.3 的「明确不动」判断**已被实际执行推翻**，在此更正：
>
> - **本文预判**：清零最后 1 条基线要把 `RuleRunner.database` / `JsExecutionContext.database` 换成端口集合，**波及 49 个测试构造点 + 20 个测试文件**，故列为"面最广、必须单列一轮、不可与别的事混做"。
> - **实际做法**：实测 `rules/` **从未调用 `Database` 的任何原始方法** —— 全部经由 `asCookieStore()` / `asVariableStore()` / `asScriptCacheStore()` / `asLoginStateStore()` / `asReader()` 取窄端口（14/10/5/4/3 处）。因而只需把**这组访问器**提成 `io.legado.port.PortBundle` 接口、让 `Database` 实现它，`rules/` 只认接口。
> - **实际波及**：**1 个新接口文件 + `Database` 类声明 + 4 个文件里的类型名（共 15 处）**。`RuleRunner(db)` 等 **53 个既有构造点一处都没改** —— 因为 `Database : PortBundle`，子类型关系让调用点自动兼容。
> - **结论**：`RULES_CONCRETE_BASELINE = emptySet()`，`rules→data` / `rules→source` / `rules→http` **均为 0**，判据 3 与判据 2、4 一样成为零基线无豁免。负向对照已验（探针 `rules/__BoundaryProbe.kt` 的 `import io.legado.data.Database` 使其精确变红）。
> - **教训**：**"牵面最广"是接口形状选出来的，不是问题的固有属性。** 本文因假定"必须把 5 个端口作为独立参数传进构造器"而把波及面放大了一个数量级。评估重构面之前应先问：能不能让改动只落在**类型关系**上？
>
> 下文 §3.2/§3.3 保留原样作为当时的判断记录，**请以本节为准**。
>
> 另外，本文 §0 第 2 条「当前 1 条」现已过期 —— 本轮已清零。§5.2 里「测试 49 处 / 20 个测试文件」的统计本身没错（`RuleRunner(` 确实有 53 个构造点），错的是"必须逐个改写"这个推论。
>
> **本文点出的最大盲区也已补上判据**：§4 说「真实 2-环 15 对」而此前**没有任何判据覆盖环**。现已新增第 6 条判据「包之间不得存在双向依赖」，按一级子包粒度实测 **4 对**（组合根除外）：`data<->source`、`cache<->data`、`data<->ops`、`content<->rules`。含组合根的 7 对 `root↔X` 按设计排除（组合根装配一切是职责）。数字与本文的「15 对」不一致是口径差异（本文疑似把 root 计入且粒度更细），**以判据基线为准**。
> 该判据自带空转哨兵（边数 < 20 即红）—— 它第一次写完时正则少了 `(?m)`，一条边都没扫到却报了"无 2-环"的假绿。**"空集合满足断言"是这类安全判据的通用陷阱。**

## 0. 先声明：与任务书不符的五处实测事实

任务书的部分「已知事实」与工作区当前状态不一致。按「仓库实际状态优先」的口径，先列出实测结果，后续章节一律以实测为准。

| # | 任务书陈述 | 实测结果 | 取证 |
|---|---|---|---|
| 1 | 工作区有 5 个 modified + 1 个 untracked（正在进行的「断开 rules↔source 成环」改动），要求原样保留 | **工作区完全干净**（`git status --porcelain` 空输出，`git stash list` 空）。所述改动**已全部提交**：`ae1615a` 端口化 ScriptCache+LoginState、`202a1e0` 断开 rules↔source 成环、`bebd824` 端口化只读投影组。`port/SourceUrlProbe.kt` 已被 git 跟踪 | `git status --porcelain`（空）；`git ls-files --error-unmatch .../port/SourceUrlProbe.kt` 命中；`git log --oneline -3` |
| 2 | `RULES_CONCRETE_BASELINE` 当前 **5 条**（data.Database、getEnabledReplaceRulesForScope、getSource、getTocCache、shelfBook） | **当时实测 1 条**（本轮已清零成 `emptySet()`，见文首更正节）：`setOf("data.Database")`。复刻该测试的正则扫 `rules/`，实际集合恰为 `["data.Database"]`，即后四条已由 `bebd824` 消掉 | [ArchitectureBoundaryTest.kt:198-204](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt#L198-L204)；复扫结果 `count = 1`，三处 import 为 JsSandbox.kt:24 / RuleRunner.kt:49 / ScriptCache.kt:3（同一符号，计 1 条） |
| 3 | infra 含 `desktop` 包 | **不存在 `io.legado.desktop` 包**。`DesktopLauncher.kt` 位于根包 `io.legado` | `find . -type d` 无 desktop；root 包 9 个文件含 DesktopLauncher.kt |
| 4 | 包清单未提及 `reading` | **存在 `io.legado.reading`**（1 文件 116 行，`ReadingRepository.kt`），是进度/笔记/阅读记录的域收口 | [reading/ReadingRepository.kt:1-25](../../app/src/main/kotlin/io/legado/reading/ReadingRepository.kt#L1-L25) |
| 5 | 后端约 930 项测试 | **935 个 `@Test`，119 个测试文件**（`grep -rho "@Test"` 精确计数，无 Parameterized 变体） | `grep -rho "@Test" product/app/src/test --include=*.kt \| wc -l` = 935 |

**对硬约束的处置**：因为「必须保留的未提交改动」在实测中不存在，本文**没有触发任何保留动作**——没有 stash、没有 checkout、没有 reset。全程只读源码，只新增 `product/docs/restructure/backend-layering.md` 这一个文件（同目录的 `frontend-host.md` 是并行队友产出，未触碰）。

---

## 1. 包现状清单

### 1.1 全量清单（20 个包，123 个 .kt，32153 行）

行数用 `find -exec cat {} + | wc -l`；`files` 只计该目录**直属**的 `.kt`（不含子包）。

| 包 | 建议层 | files | lines | 归类依据（源码行为已确认） |
|---|---|---|---|---|
| `io.legado`（根） | **root / 组合根** | 9 | 1815 | `Application.kt` 装配全部模块；`DesktopLauncher.kt` 桌面壳；`StaticWeb.kt` 静态资源；`AppConfig`/`BuildInfo`/`ServerConfig`/`BrandManifest`/`BrandStore` 为进程级配置；`TextDecoding.kt` 是被上下游共用的纯解码工具 |
| `io.legado.model` | **domain** | 1 | 1037 | 单一 `Models.kt`，纯 `@Serializable` DTO；`ArchitectureBoundaryTest` 已锁「0 条反向依赖」 |
| `io.legado.port` | **domain** | 2 | 166 | `StorePorts.kt` 只声明接口（CookieStore/VariableStore/ScriptCacheStore/LoginStateStore/KernelReader），仅 import `model`；`SourceUrlProbe.kt` 为主机/域名判定纯函数 |
| `io.legado.rules` | **engine** | 16 | 7819 | `RuleRunner`（类注释自陈 server-safe）、`JsSandbox`、`RuleProcessor`、`RuleSplit`/`RuleValue`/`PagingRule` 等规则求值内核 |
| `io.legado.rules.processor` | **engine** | 4 | 116 | XPath/Jsoup/JsonPath/Rhino 四种 `RuleProcessor` 实现，仅被 `rules` 调度 |
| `io.legado.rules.processor.demo` | **engine** | 2 | 85 | 两个 demo 处理器，仅 import `rules` |
| `io.legado.content` | **engine** | 3 | 421 | `ContentProcessor`（替换规则匹配/应用）、`ContentPipeline`、`LooseJson`；无持久化、无 Ktor |
| `io.legado.localbook` | **engine** | 2 | 1014 | `LocalBookParser`（EPUB/TXT 解析，**零 `io.legado.data` 依赖**）、`TxtTocRule` |
| `io.legado.source` | **engine** | 5 | 1886 | `SourceCodec`（源 JSON 编解码）、`SourceDebugger`、`SourceHealth`、`ExternalBrowserLogin`、`WebViewProxy`（反向代理取数） |
| `io.legado.http` | **api** | 20 | 4080 | 19 个 `*Routes.kt` + `Routes.kt`（`apiRoutes` 聚合）+ `RouteCatalog` + `Guard` + 两个严格编解码器 + `SearchSession` |
| `io.legado.http.system` | **api** | 1 | 124 | `SystemRoutes.kt`，`/api/system` 与 `/api/about` 处理体 |
| `io.legado.data` | **infra** | 17 | 3423 | `Database` + 16 个 `*Dao.kt`（全是 `fun Database.xxx` 扩展）+ `StoreAdapters` |
| `io.legado.data.db` | **infra** | 4 | 570 | `ConnectionPool`/`Migration`/`Schema`/`CookieUtil`，SQLite 底层 |
| `io.legado.cache` | **infra** | 2 | 419 | `BookCacheService`（正文落盘缓存）、`CoverCache`（封面/音频代取缓存） |
| `io.legado.ops` | **infra（混合，见 §1.3）** | 5 | 728 | `NetworkSecurity`+`GuardedHttpClient`+`Metrics` 为**纯 JDK 内核原语**；`LogService`+`UpdateCheck` 为依赖 `data`/`model` 的基础设施服务 |
| `io.legado.ai` | **infra** | 23 | 6334 | LLM Provider/连接/工具注册/护栏，且 `AgentRoutes.kt` 内**直接实现 Ktor 路由处理体** |
| `io.legado.tts` | **infra** | 2 | 942 | `EdgeTtsService`（外呼 Edge TTS）、`TtsSessionService`（会话状态） |
| `io.legado.backup` | **infra** | 3 | 914 | `BackupStore`/`BackupImporter`/`LegacyBackup`，文件级备份 |
| `io.legado.subscription` | **infra** | 1 | 144 | `SubscriptionService` 定时抓取 |
| `io.legado.reading` | **infra** | 1 | 116 | `ReadingRepository`，对 `data.ReadingDao` 扩展的薄封装（注释自称「阅读域收口 P1-T4」） |

**合计：20 个包，123 个 .kt，32153 行。** 规模分布极不均衡：`rules`(7819) + `ai`(6334) + `http`(4080) + `data`+`data.db`(3993) 四块占 69%。

### 1.2 归类理由（三层的判据）

- **domain**：不依赖任何 `io.legado.*`（`model` 实测 0 条），或只依赖 `model`（`port` 实测 6 条，全部指向 `model`）。两者都可在**无 SQLite、无 Ktor、无 HTTP** 的环境下编译运行。
- **engine**：承载「书源规则 + 文本/本地书解析」的业务算法，**可以**依赖 `model`，但**不应**依赖 `http`/`data` 的具体实现。实测 `engine→api` = 0、`engine→domain` = 20（健康）。`rules`/`content`/`localbook` 均已由离线测试证明可在不传 `Database` 的前提下跑通（`RuleRunner({ url -> … })` 构造式，[RuleRunner.kt:83](../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt#L83)）。
- **api**：唯一职责是「把领域能力投影成 HTTP + 序列化 + 同源写闸」。`http/` 全部文件 import Ktor。
- **infra**：需要 SQLite / 文件系统 / 外部进程或网络会话的**宿主适配**层。

### 1.3 必须点名的两处归类含混（推断，需评审）

**(a) `ops` 是一个被两类东西共用的包，不属于任何单层。** 表内 5 个文件可分两组：

| 文件 | io.legado 依赖 | 性质 |
|---|---|---|
| `ops/NetworkSecurity.kt`（137 行） | **0** | 纯 JDK SSRF 闸门 |
| `ops/GuardedHttpClient.kt`（89 行） | **0** | 纯 JDK 受控 HttpClient 外壳 |
| `ops/Metrics.kt`（113 行） | **0** | 纯 JDK 计数器 |
| `ops/LogService.kt`（221 行） | `data.Database` + 5 个 data 扩展 | 落库的日志服务 |
| `ops/UpdateCheck.kt`（168 行） | `model.UpdateCheckResult` | 外呼 GitHub releases |

前三个是**引擎必须能用的内核原语**（`rules/RuleRunner.kt:50` 拿 `NetworkSecurity` 建 HttpClient，[RuleRunner.kt:92](../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt#L92)），后两个是基础设施服务。把 `ops` 整体判为 infra，会让 §4 的判据一上线就背 13 条 `engine→ops` 豁免（见 §2.4-E）。**建议：把前三个文件视为 `kernel`（与 domain 同级、零 `io.legado` 依赖），把 `ops` 只留给 `LogService`/`UpdateCheck`。** 这是本文最重要的归类修正建议。

**(b) `ai/AgentRoutes.kt`（687 行）是 api 层代码住在 infra 包里。** 它 import `io.ktor.server.*`、接收 `ApplicationCall`、直接 `respond`，并在 [AgentRoutes.kt:20-26](../../app/src/main/kotlin/io/legado/ai/AgentRoutes.kt#L20-L26) 自述「`/api/agent/` 这一组的真实处理体……各路由在 `Routes.kt` 里仍是字面注册」。也就是说 `http/AgentApiRoutes.kt` 只是转发壳。**归类为 api 更准确**，但本阶段不动（见 §3.3）。

---

## 2. 依赖方向审计（本文最重要部分）

### 2.1 方法

对 `product/app/src/main/kotlin/io/legado/**` 全部 123 个 `.kt`：

1. 读 `package` 声明 → 定位该文件所属包（长包名优先，如 `io.legado.http.system` 不被误判为 `io.legado`）；
2. 扫顶格 `import io.legado.*` 行，**剥块注释与行注释时保留换行**，保证行号与真实文件一致（已用 8 个文件逐行人工比对验证）；
3. 把 import 的 FQN 归属到「已存在的包」的最长前缀 → 得到 `源包 → 目标包` 边；
4. 同包自引剔除；包内子包互引（如 `rules → rules.processor`）保留但不计入跨层。

**已知的方法边界**：本审计只看**直接 import 边**。通过「全局单例 / 顶层函数 facade」建立的联系不可见，§2.6 单独补一条实测到的此类隐式耦合。抽样验证过的抽样点全部命中，未发现漏边。

### 2.2 全量跨包边表（91 个包对，664 条边）

按条数降序，`api→*`（下游，健康）与 `root→*`（组合根，健康）不在违规之列：

| 边 | 条数 | 方向判定 |
|---|---|---|
| `http → model` | 102 | 健康（api→domain） |
| `http → data` | 99 | 健康（api→infra） |
| `data → model` | 65 | 健康（infra→domain） |
| `ai → data` | 40 | 健康（infra→infra） |
| `http → ai` | 20 | 健康（api→infra） |
| `cache → data` | 13 | 健康（infra→infra） |
| `reading → data` | 12 | 健康（infra→infra） |
| `rules → model` | 12 | 健康（engine→domain） |
| `rules.processor → rules` | 12 | 健康（engine 内部） |
| `http → source` | 11 | 合法方向（api→engine），但见 §2.4-H 的裁决 |
| `data → port` | 10 | 健康（infra→domain） |
| `http → rules` | 10 | 合法方向（api→engine），同上 |
| `ai → model` | 9 | 健康 |
| `data → source` | 9 | **违规**（infra→engine，成环） |
| `http → ops` | 8 | 健康 |
| `http → io.legado`（根） | 8 | 健康（api 用 `decodeStrict`/`charsetOf` 等根工具，见 §2.5） |
| `ai → io.legado`（根） | 7 | 违规（infra→root，见 §2.4-F） |
| `backup → data` | 7 | 健康 |
| `data.db → data` | 7 | 健康 |
| `io.legado → http` | 6 | 健康（组合根） |
| `ai → source` | 6 | **违规**（infra→engine） |
| `ai → ops` | 6 | 健康 |
| `http → cache` | 6 | 健康 |
| `ops → data` | 6 | 违规（infra→infra 环） |
| `port → model` | 6 | 健康（domain 内部） |
| `reading → model` | 6 | 健康 |
| `rules → ops` | 6 | 见 §2.4-E |
| `rules.processor.demo → rules` | 6 | 健康（engine 内部） |
| `source → data` | 6 | **违规**（engine→infra） |
| `subscription → data` | 6 | 健康 |
| `tts → model` | 6 | 健康 |
| （其余 60 个包对，每条 ≤5） | 0–5 | 详见 §2.4 各类违规明细 |

### 2.3 分层矩阵（518 条跨层边）

| 源层 ↓ / 目标层 → | domain | engine | api | infra | root | 合计 |
|---|---|---|---|---|---|---|
| **root**（组合根） | 3 | 1 | 6 | 13 | — | 23（允许） |
| **api** | 107 | 28 | 4 | 150 | 9 | 298（**允许**，合法下游） |
| **engine** | 20 | 28 | **0** | **22** | **6** | 76 |
| **infra** | 105 | **29** | **2** | 39 | **17** | 192 |

读法：**api 行是被允许的**（组合根与 HTTP 层当然要够到一切）。真正要治理的是 **engine 行与 infra 行**。

### 2.4 违规边穷尽清单

#### A. `domain → 非 domain`：**0 条** ✅

`model` 与 `port` 都不 import 任何非 domain 的 `io.legado.*`。`model` 实测 0（既有判据 2 已锁死）；`port` 的 6 条边全部指向 `model`（[StorePorts.kt:3-8](../../app/src/main/kotlin/io/legado/port/StorePorts.kt#L3-L8)）。

#### B. `engine → api`：**0 条** ✅

即 `rules`/`content`/`localbook`/`source`/`rules.processor*` 无一 import `io.legado.http.*`。这条是 §4 新增判据的主体，**当前真值为 0，可零基线直接断言**。

#### C. `infra → api`：**2 条** ❌（本次新发现）

```
ai/ProviderHttp.kt:5      import io.legado.http.ServerIdentity
cache/CoverCache.kt:22    import io.legado.http.proxyRequestHeaders
```

- `ServerIdentity` 定义在 [http/Guard.kt:30](../../app/src/main/kotlin/io/legado/http/Guard.kt#L30)，语义是**运行时监听地址持有者**，与 HTTP 路由无关；`ai/ProviderHttp.kt` 用它拼出站回调地址。
- `proxyRequestHeaders` 定义在 [http/ProxyHeaders.kt:20](../../app/src/main/kotlin/io/legado/http/ProxyHeaders.kt#L20)，是纯 header 组装函数；`cache/CoverCache.kt` 用它给代取资源补请求头。

两者都是「住在 api 包里的非 api 原语」。修法与 `NetworkSecurity` 从 `http/` 下沉到 `ops/` 完全同构（见 [architecture-audit.md](../../docs/architecture-audit.md) §3 第 3 行）。

#### D. `engine → infra（非 ops）`：**9 条** ❌（= 既有基线 1 条 + `source/` 的 6 条 + `source/ExternalBrowserLogin` 2 条）

```
rules/JsSandbox.kt:24             import io.legado.data.Database
rules/RuleRunner.kt:49            import io.legado.data.Database
rules/ScriptCache.kt:3            import io.legado.data.Database
source/ExternalBrowserLogin.kt:21 import io.legado.data.Database
source/ExternalBrowserLogin.kt:22 import io.legado.data.setCookieForUrl
source/WebViewProxy.kt:22         import io.legado.data.Database
source/WebViewProxy.kt:23         import io.legado.data.cookieBucketsForHosts
source/WebViewProxy.kt:24         import io.legado.data.getCookieForUrl
source/WebViewProxy.kt:25         import io.legado.data.setCookieFromSetCookie
```

关键发现：**既有边界测试只扫 `rules/` 目录**（[ArchitectureBoundaryTest.kt:79](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt#L79) `serverDir().resolve("rules")`），所以 `source/` 下这 6 条 `data` 横穿**从未被任何判据覆盖**。`RULES_CONCRETE_BASELINE = {"data.Database"}` 只是 `rules` 包的账，不是 engine 的账。这是本次审计最有价值的覆盖缺口。

三条 `data.Database` 是**同一个符号**（宽句柄 `RuleRunner.database: Database?`，[RuleRunner.kt:78](../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt#L78) 与 `JsExecutionContext.database`，[JsSandbox.kt:31](../../app/src/main/kotlin/io/legado/rules/JsSandbox.kt#L31)），因此算 1 条基线条目、3 个计点。

#### E. `engine → ops`：**13 条**（若 `ops` 判为 infra，即为违规）

```
content/ContentProcessor.kt:5,6   logParsing / logRuleExecution
localbook/TxtTocRule.kt:5,6       logParsing / logSystem
rules/RuleRunner.kt:50            NetworkSecurity
rules/RuleRunner.kt:57            LogLevel
rules/RuleRunner.kt:58-61         logEngine / logNetwork / logParsing / logRuleExecution
source/WebViewProxy.kt:26         NetworkSecurity
source/WebViewProxy.kt:28,29      LogLevel / logSystem
```

拆开看：**内核原语 2 条**（`NetworkSecurity` ×2，零依赖，合理）+ **日志门面 11 条**（`logXxx`/`LogLevel`）。后者不是简单的 import 问题——`LogService` 自己持有 `Database`（[LogService.kt:46](../../app/src/main/kotlin/io/legado/ops/LogService.kt#L46) `private var database: Database?`），所以**引擎每次写日志都在间接触达 SQLite**（§2.6）。这是 §1.3(a) 建议 `ops` 拆分的内核依据。

> ### ✅ 执行后更正（2026-11）：日志门面已端口化，engine→ops 13 条降到 2 条
>
> 上面那张表里的 11 条日志门面**已经清零**。做法不是"给日志造一个 capability 端口"
> （那会让每个调用点都得先拿到端口实例，11 个文件都要改调用方式），而是**把门面下沉到域层**：
>
> - 新 `port/Logging.kt`：`LogCategory`、`LogLevel`、`interface LogSink`、八个 `Any.logXxx` 便捷函数
> - `ops/LogService.kt` 只留**实现**：`object LogService : LogSink`，落库 / 去重 / 写文件仍在 infra
> - 装配走 `LogService.install()`（幂等；`initialize()` 会先调它），实现由组合根在最早处装进来
> - 装配之前是 `StdoutLogSink` 兜底 —— **打到标准输出，不静默丢弃**。启动早期那几行日志恰恰最需要看见，
>   丢掉它们会把"服务起不来"变成没有线索的黑盒
>
> 理由：日志是**横切关注点**，不是某一层的专属能力。把它当"能力依赖"从一开始就归类错了。
>
> **实测结果：判据 5 的基线从 6 条降到 4 条，只清掉 2 条**（`content/ContentProcessor`、`localbook/TxtTocRule`）。
> `rules/RuleRunner` **没有**跟着消失 —— 它除了日志还用 `NetworkSecurity`。
> 这正是本判据按**文件**而不是按包对记账的价值：按包对记会以为"日志搬完 RuleRunner 就干净了"。
> **这次是判据当场纠正了我的预期**，不是我先算对了再让它复核。
>
> ⚠️ **必须说清它没解决什么**：上面那句「引擎每次写日志都在间接触达 SQLite」在运行时**依然成立** ——
> 门面下沉只修掉了 *import 上的* 向上依赖，没修掉运行时的依赖倒挂。依赖倒置本来就不解决这个。
>
> 但它**第一次让这件事变得可测**，而且这条判据已经落地了 ——
> `LogServiceTest.门面是唯一出口：换掉 sink 之后引擎日志既进得了探针也进不了库`：
> 换上一个记录型 `LogSink`，断言 (a) 日志确实交到了它手上、(b) 此刻 `LogService.getRecentLogs()`
> 里**不该**同时出现这条。两个方向合起来才排除了"绕过门面的第二条路径"。
> 在门面还长在 `ops/LogService.kt` 里的时候，`RuleRunner` 一旦写日志就**必然**碰到 `LogService`，
> 这个断言根本无从下手。
>
> **该判据做过双向反向对照**（不是只看它绿）：
> ① 让 `logParsing` 不再转交 sink → (a) 红，报 `门面必须把日志交给当前 sink`；
> ② 在测试里模拟"有人在 engine 补了一句直调 `LogService.log`" → (b) 红，报
> `换掉 sink 之后，日志仍然被 LogService 收走了`。两处破坏都确认是**断言失败而非编译失败**，
> 且还原后两个文件逐字节一致。§2.6 那条内核独立性论证此前只能靠读代码推断，现在有哨兵了。

#### F. `engine → root`：**6 条**

```
localbook/LocalBookParser.kt:3    import io.legado.decodeTextAuto
rules/JsGuard.kt:6                import io.legado.AppConfig
rules/RuleRunner.kt:42            import io.legado.AppConfig
rules/RuleRunner.kt:43            import io.legado.charsetOf
rules/RuleRunner.kt:47            import io.legado.decodeStrict
rules/RuleRunner.kt:48            import io.legado.decodeTextAuto
```

两条实质：**进程级配置 `AppConfig`**（2 条）与**纯文本解码工具 `TextDecoding.kt` 的顶层函数**（4 条）。后者与业务无关，是「工具函数恰好住在根包」；`infra→root` 的 17 条里也有一大半是同一批解码函数（`subscription/SubscriptionService.kt:24,31`、`backup/BackupImporter.kt:27`、`MediaRoutes.kt:14,19` 等）。

#### G. `infra → engine`：**29 条** ❌（架构上最严重的一组）

```
ai/AgentContext.kt:4,5,6          source.SourceDebugger / source.SourceHealth / rules.RuleRunner
ai/AgentModule.kt:7,8,9           rules.RuleRunner / source.SourceDebugger / source.SourceHealth
ai/AgentRoutes.kt:15              source.SourceCodec
ai/BuiltinTools.kt:38,46          content.ContentProcessor / source.SourceCodec
backup/BackupImporter.kt:32       source.SourceCodec
cache/BookCacheService.kt:33      localbook.LocalBookParser
cache/BookCacheService.kt:35,36   rules.RuleExecutionException / rules.RuleRunner
data/CacheDao.kt:3,4              localbook.LocalBookParser / localbook.ParsedBook
data/CookieDao.kt:4               source.WebViewProxy
data/Database.kt:21               content.ContentProcessor
data/Database.kt:25,26            localbook.LocalBookParser / localbook.ParsedBook
data/Database.kt:40,41,42,43      source.ParsedRssSource / ParsedSource / SourceCodec / WebViewProxy
data/db/CookieUtil.kt:4           source.WebViewProxy
data/ImportDao.kt:6,7             source.ParsedRssSource / SourceCodec
data/ReplaceRuleDao.kt:3          content.ContentProcessor
data/SourcesDao.kt:6,7            source.ParsedSource / SourceCodec
```

关键读法：**`data`（持久层）依赖 engine，是本项目最深的结构倒置**。`data/Database.kt` 一个文件就 9 条（21、25、26、40-43）。含义是：想单独编译/测试持久层，必须先带上规则引擎与解析器。

#### H. `api → engine`（28 条）——**降级为「待观察」，但需要裁决**

```
http → source: 11 条（Routes.kt:21,22,23、SourcesRoutes.kt:67-74 等）
http → rules:  10 条（Routes.kt:19,20、ReadingRoutes.kt:33-35、SourcesRoutes.kt:66、RssRoutes.kt:22、SearchRoutes.kt:22、ReplaceRulesRoutes.kt:30,31）
其余 7 条 = `content`×2（ReadingRoutes.kt:10、ReplaceRulesRoutes.kt:13）+ `localbook`×5（ReadingRoutes.kt:23、ShelfRoutes.kt:36、TocRulesRoutes.kt:15,16、Routes.kt:17）
```

`api → engine` **方向本身合法**（HTTP 层当然要调规则引擎），所以这 28 条**不是违规**。但它们是「api 层的 route handler 直接 `new RuleRunner(db)` 并内联规则编排」的证据——典型如 [SourcesRoutes.kt:66-74](../../app/src/main/kotlin/io/legado/http/SourcesRoutes.kt#L66-L74) 一次 import 9 个 engine 符号。目标是「后端退为领域引擎」时，这 28 条是**必须逐步换成应用服务调用**的清单。本阶段不动，登记备查。

### 2.5 真实 2-环（15 对，双向边同时存在）

| 环 | 方向 A | 方向 B | 层间 |
|---|---|---|---|
| `data ↔ source` | data→source 9 | source→data 6 | **infra ↔ engine** ❌ |
| `data ↔ ops` | data→ops 2 | ops→data 6 | infra ↔ infra ❌ |
| `cache ↔ data` | cache→data 13 | data→cache 2 | infra ↔ infra |
| `data ↔ data.db` | data→data.db 3 | data.db→data 7 | infra ↔ infra（父子包，可接受） |
| `ai ↔ http` | ai→http 1 | http→ai 20 | **infra ↔ api** ❌ |
| `cache ↔ http` | cache→http 1 | http→cache 6 | **infra ↔ api** ❌ |
| `content ↔ rules` | content→rules 1 | rules→content 3 | engine ↔ engine（可接受） |
| `http ↔ http.system` | http→system 1 | system→http 3 | api ↔ api（可接受） |
| `io.legado ↔ ai` | root→ai 2 | ai→root 7 | root ↔ infra |
| `io.legado ↔ cache` | root→cache 2 | cache→root 1 | root ↔ infra |
| `io.legado ↔ data` | root→data 4 | data→root 1 | root ↔ infra |
| `io.legado ↔ http` | root→http 6 | http→root 8 | root ↔ api |
| `io.legado ↔ rules` | root→rules 1 | rules→root 5 | root ↔ engine |
| `io.legado ↔ subscription` | root→subscription 1 | subscription→root 3 | root ↔ infra |
| `io.legado ↔ tts` | root→tts 2 | tts→root 2 | root ↔ infra |

**必须消掉的两个**：`data ↔ source`（唯一跨 engine/infra 的真环）与 `ai ↔ http`（api 被 infra 反向依赖）。两个环的成因是同一个：**宽 `Database` 句柄 + 住在 api 包里的共享原语**。

### 2.6 直接 import 边看不见的耦合（实测补充）

`rules` 已经不 import `data` 的 Cookie/变量/脚本缓存/登录态实现（已端口化），但**引擎仍在运行时触达 SQLite**：

1. `rules/RuleRunner.kt:58-61` 调 `logEngine/logNetwork/logParsing/logRuleExecution` → `ops/LogService.kt`；
2. `LogService` 自己持 `Database`（[LogService.kt:46,49](../../app/src/main/kotlin/io/legado/ops/LogService.kt#L46-L49) `private var database: Database?`，`Database(databasePath)`），并在写入时调 `data` 的 `insertLog`/`bumpLogRepeat`（LogService.kt:12-16）；
3. 于是「离线跑 `RuleRunner({ url -> … })`」这条内核独立性论证，在**日志落库路径上并不成立**——只是它被 facade 挡住了。

**结论（推断，但由源码行支撑）**：`RuleRunner` 的无 `Database` 构造式能跑通，是因为 `LogService` 的 `database` 为 `null` 时整条链静默降级（`database?.let { … }`），而不是因为引擎真的不依赖持久层。这削弱了「引擎已可独立运行」的强度，也说明 §4 的 import 级判据只能守住**编译期**方向，守不住运行期。

---

## 3. 迁移清单

### 3.1 本阶段（止血轮）：**零文件移动，只加判据**

理由：任务书要求「第一阶段是包内分层止血，不移动 `product/` 根目录、不改外部行为」。当前 `engine→api = 0`、`domain→非domain = 0`，两条最硬的边界**已经成立**，此时加守卫的成本最低、收益最高（把既成事实钉死，防回流）。

本阶段唯一动作 = 新增 §4 的判据 + 更新 [architecture-audit.md](../../docs/architecture-audit.md) §3 的状态行（后者由 Lead 决定是否随本轮做）。

### 3.2 后续阶段候选移动（按「收益/波及面」排序）

**T1 — 共享原语下沉（清 `infra→api` = 2，低风险）**

| 类型 | 从 | 到 | 消掉的边 |
|---|---|---|---|
| `ServerIdentity` | `http/Guard.kt:30` | `ops/`（或未来 `kernel/`） | `ai/ProviderHttp.kt:5` |
| `proxyRequestHeaders` | `http/ProxyHeaders.kt:20` | `ops/` | `cache/CoverCache.kt:22` |

先例：`NetworkSecurity`+`GuardedHttpClient` 已用同一手法从 `http/` 搬到 `ops/`（[architecture-audit.md](../../docs/architecture-audit.md) §3），波及 `Guard.kt` 的 `AppConfig` import 需要一并处理。预计动的调用点：`ai/ProviderHttp.kt`、`cache/CoverCache.kt`、`http/system/SystemRoutes.kt:23`、`Application.kt:27`、`http/Guard.kt` 自身。

**T2 — 文本工具与配置离开根包（清 `engine→root` 6 与大部分 `infra→root` 17，低风险）**

| 类型 | 从 | 到 | 消掉的边 |
|---|---|---|---|
| `decodeTextAuto`/`charsetOf`/`decodeStrict`（`TextDecoding.kt`） | `io.legado`（根） | `ops/`（或 `text/`） | `localbook:3`、`rules/RuleRunner.kt:43,47,48`、`subscription:24,31`、`backup:27`、`api:14,19` 等 |
| `AppConfig`（`AppConfig.kt`） | `io.legado`（根） | `ops/`（或 `platform/`） | `rules/JsGuard.kt:6`、`rules/RuleRunner.kt:42`、`ai/Agent.kt:4`、`ai/AgentModule.kt:3`、`data/Database.kt:19`、`data/db/ConnectionPool.kt:3`、`data/db/Migration.kt:3`、`subscription:23`、`tts:22,27`、`backup/BackupImporter.kt:27` 等 |

`AppConfig` 是全局单例配置，属进程级资源；让它住根包，等于让引擎与 infra 都反向依赖组合根。

**T3 — 值类归位（清 `infra→engine` 中的 ~13 条，中风险）**

| 类型 | 从 | 到 | 消掉的边 |
|---|---|---|---|
| `ParsedSource`/`ParsedRssSource` | `source/` | `model/` | `data/Database.kt:40,41`、`data/ImportDao.kt:6`、`data/SourcesDao.kt:6` |
| `ParsedBook`/`ParsedChapter` | `localbook/` | `model/` | `data/CacheDao.kt:4`、`data/Database.kt:26` |
| `SourceCodec` | `source/` | `model/` 或新 `codec/` | `data/Database.kt:42`、`data/ImportDao.kt:7`、`data/SourcesDao.kt:7`、`ai/AgentRoutes.kt:15`、`ai/BuiltinTools.kt:46`、`backup/BackupImporter.kt:32` |

判据：这些都是**纯数据形状与纯编解码**，没有 HTTP、没有 SQLite。搬进 `model` 后 `data→source` 从 9 降到 3（只剩 `WebViewProxy`），`data→localbook` 从 4 降到 2。

**T4 — `AgentRoutes.kt` 移入 api（中风险，但概念最清晰）**

`ai/AgentRoutes.kt`（687 行）→ `http/agent/`。它已 import Ktor 并自述是路由处理体（[AgentRoutes.kt:20-26](../../app/src/main/kotlin/io/legado/ai/AgentRoutes.kt#L20-L26)）。移动后 `ai` 包只剩 Provider/工具/存储，层性变纯。风险：`AiCatalog` 门禁按端点逐条核对，路径与包名变化需同步 `agent-api.json` 与 `web/test/ApiCatalog.test.ts`。

**T5 — `KernelPorts` 聚合，消除宽 `Database` 句柄（**最高风险，单列一轮**）**

这是唯一能同时清掉以下三组的手段：
- `rules → data.Database`（3 个计点，既有基线唯一残留）；
- `source/WebViewProxy.kt:22-25` + `source/ExternalBrowserLogin.kt:21,22` 的 6 条；
- `data ↔ source` 这个唯一的 engine↔infra 真环（`data/CookieDao.kt:4`、`data/db/CookieUtil.kt:4`、`data/Database.kt:43` 反向够 `WebViewProxy`）。

落地形态：`io.legado.port.KernelPorts` 聚合 `asCookieStore/asVariableStore/asScriptCacheStore/asLoginStateStore/asReader`（[StorePorts.kt](../../app/src/main/kotlin/io/legado/port/StorePorts.kt) 五个接口已就位），把 `RuleRunner.database: Database?`（[RuleRunner.kt:78](../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt#L78)）与 `JsExecutionContext.database`（[JsSandbox.kt:31](../../app/src/main/kotlin/io/legado/rules/JsSandbox.kt#L31)）换成端口集合。

**波及面（实测）**：主源码 `RuleRunner(` 构造点 2 处（`Application.kt`、`rules/RuleRunner.kt` 的 `constructor(database: Database)` 重载，[RuleRunner.kt:82-84](../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt#L82-L84)）；**测试 49 处，分布在 20 个测试文件**（§5.2）。这正是 [architecture-audit.md](../../docs/architecture-audit.md) §3「P-final-B」描述的「面最广」的一步。

### 3.3 明确不动（本阶段与可预见阶段都保留）

| 项 | 现状证据 | 不动的理由 |
|---|---|---|
| **`RuleRunner.database: Database?` 宽句柄** | [RuleRunner.kt:78](../../app/src/main/kotlin/io/legado/rules/RuleRunner.kt#L78) | 见 T5；49 个测试构造点，必须单列一轮 + 全量兜底 |
| **`RULES_CONCRETE_BASELINE = {"data.Database"}`** | [ArchitectureBoundaryTest.kt:198-204](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt#L198-L204) | 基线只能单调缩小；T5 做掉它才允许删 |
| **`data` 的 16 个 `fun Database.xxx` 扩展函数** | `http → data` 99 条、`ai → data` 40 条直接调用 | 删扩展会波及整个 http/ai；端口化走「加适配器、不删扩展」（[StoreAdapters.kt:16-21](../../app/src/main/kotlin/io/legado/data/StoreAdapters.kt#L16-L21) 已确立此纪律） |
| **`rules ↔ data` 的**其它**既有耦合** | `rules→data` 实测仅 `data.Database` 1 条符号 | 除 T5 外已无残留，无需再动 |
| **`model/Models.kt` 单文件 1037 行** | 1 文件承载全部 DTO | 拆文件不带来任何边界收益，纯 churn |
| **`ops` 包整体位置** | 5 文件 728 行 | 只建议在判据里把它当「kernel + infra」两段看（§4.3），不搬文件 |
| **`http/RouteCatalog`、`http/Guard`、`SearchSession`** | api 层自有职责 | 无跨层依赖问题（除 T1 的 `ServerIdentity`/`proxyRequestHeaders`） |
| **`rules/processor/demo`** | 2 文件 85 行 | 插件处理器示范，engine 内部 |
| **Gradle 多模块 / convention plugin** | `settings.gradle` 仅 `:app` | [architecture-audit.md](../../docs/architecture-audit.md) §5 已列为「有意不做」 |
| **Widget DSL / slot catalogue / 命令分发** | — | 同上，§5 明确不做 |

---

## 4. 新增判据设计（第 4 条边界）

### 4.1 判据主体：`api 层不得被 domain/engine 反向依赖`

**实测真值：0 条。** 因此可以比照既有判据 2（`model` 反向依赖），做成**零基线、无豁免通道**的硬断言——这正是最理想的第 4 条判据形态：上线即绿，且任何新增立刻红。

伪代码级实现（与 [ArchitectureBoundaryTest.kt](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt) 现有风格完全一致，复用 `scanCodeLines` 与 `findServerSourceDir`）：

```kotlin
// ===== 4. api 层不得被 domain/engine 反向依赖 =====

@Test
fun `domain 与 engine 不得 import api 层`() {
    val violations = scanCodeLines(serverDir()).flatMap { (file, lines) ->
        val pkg = packageOf(file)                      // 新增辅助，见下
        if (!isDomainOrEngine(pkg)) return@flatMap emptyList()
        lines.mapNotNull { API_IMPORT.find(it) }
             .map { "${file.fileName}:${it.value}" }   // it.value = 整条 import 原文
    }
    assertTrue(
        "api 层（io.legado.http.*）被 domain/engine 反向依赖：$violations。\n" +
            "HTTP 是叶子消费方，规则内核与领域模型不得知道 Ktor 路由/网关的存在。" +
            "若确需共享原语（如 ServerIdentity/proxyRequestHeaders），" +
            "按 docs/architecture-audit.md §3 的先例把它下沉到 io.legado.ops，而不是反向 import。",
        violations.isEmpty(),
    )
}

/** 读文件首行 package 声明；找不到时按根包处理（不会命中判据）。 */
private fun packageOf(file: Path): String =
    file.readText().lineSequence()
        .firstOrNull { it.trimStart().startsWith("package ") }
        ?.trim()?.removePrefix("package ")?.trim()
        ?: "io.legado"

private fun isDomainOrEngine(pkg: String): Boolean =
    pkg == "io.legado.model" || pkg == "io.legado.port" ||
        pkg == "io.legado.rules" || pkg.startsWith("io.legado.rules.") ||
        pkg == "io.legado.content" || pkg == "io.legado.localbook" ||
        pkg == "io.legado.source"

// companion object 内：
/** 只匹配顶格 import（scanCodeLines 已剥注释、已 trimStart，注释里的示例不会误伤）。 */
val API_IMPORT = Regex("""^import\s+io\.legado\.http\.""")
```

**设计要点**

1. **判定依据是「文件所在包」，不是「import 的目标符号」**——与既有判据 3 用符号集合不同。因为 api 层是一个**包级**概念，用包判定不会因新增路由文件而需要维护白名单。
2. **基线 = 空集，不设 `API_REVERSE_BASELINE` 常量**。任何一条新边直接红；这与判据 2 的「无豁免通道」一致（[architecture-audit.md](../../docs/architecture-audit.md) §4 第 3 行）。
3. **`io.legado.http.system` 自动被覆盖**：`Regex("""^import\s+io\.legado\.http\.""")` 会匹配 `io.legado.http.system.SystemRoutes`，而 `http` 自身不在 `isDomainOrEngine` 里，所以 api 内部互引不误伤。
4. **`root` 与 `infra` 被刻意排除在判据外**：根包是组合根（`Application.kt:26-30` import 6 个 http 符号是必须的），infra 的 2 条留给 §4.2。
5. **注释不误伤**：`scanCodeLines` 已做块注释/行注释剥离，且只保留 `trimStart()` 后以 `import ` 开头的行（[ArchitectureBoundaryTest.kt:106-120](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt#L106-L120)），KDoc 或行注释里出现的 `io.legado.http.*` 字样永远不会进入匹配集合。（实测佐证：`grep -rn "io\.legado\.http" product/app/src/main/kotlin/io/legado/rules/` 当前零命中，连注释里都没有这样的示例。）

### 4.2 可选追加：判据 4b「infra 不得依赖 api（组合根除外）」

若本轮想一次收干净，把判据 4 的 `isDomainOrEngine` 换成 `isNotApiAndNotRoot` 即可，此时**必须有基线**（实测 2 条）：

```kotlin
val API_REVERSE_IMPORT_BASELINE = setOf(
    "ProviderHttp.kt:ServerIdentity",     // ai/ProviderHttp.kt:5
    "CoverCache.kt:proxyRequestHeaders",  // cache/CoverCache.kt:22
)
```

断言方式照搬判据 3 的「**相等**、双向都红」：

```kotlin
val actual = ... // Set<String>，形如 "ProviderHttp.kt:ServerIdentity"
val fresh  = actual - API_REVERSE_IMPORT_BASELINE   // 新横穿 → 红
val shrunk = API_REVERSE_IMPORT_BASELINE - actual   // 已下沉却不删基线 → 红
assertTrue(fresh.isEmpty()); assertTrue(shrunk.isEmpty())
```

**基线值取实测真值 2**，并且只允许单调缩小：做完 §3.2 的 T1（`ServerIdentity`、`proxyRequestHeaders` 下沉到 `ops/`）后必须把基线清成空集，否则测试自己会红——这条自我强制正是判据 3 已经验证过的机制（`RULES_CONCRETE_BASELINE` 从 25 一路降到 1，每次端口化都靠它逼着删条目）。

**建议**：本轮**只上判据 4（零基线）**，判据 4b 等 T1 落地时与基线删除同一个提交里做。理由是 4 已经是「上线即绿、永不欠债」，4b 会立刻引入一条需要维护的债务清单。

### 4.3 与 `ops` 归类的关系（必须一并写进判据注释）

如果后续把 `ops` 整体判为 infra 并纳入判据 4b 的口径，会一次性引入 **13 条 `engine→ops`** 需要豁免（§2.4-E），其中 11 条是日志门面。**建议维持 `ops` 不在 domain/engine 判据的「禁止目标」里**，并在注释中写明：`ops` 的 `NetworkSecurity`/`GuardedHttpClient`/`Metrics` 是零依赖内核原语，引擎依赖它们不算向上依赖。若将来要严格化，正确顺序是先把 `ops` 拆成 `kernel` + `ops`（§1.3a），再收紧判据——**不要反过来**，否则判据一上线就是一堆豁免，重蹈「基线当垃圾桶」的覆辙。

---

## 5. 回归面

### 5.1 总量（实测）

| 指标 | 值 |
|---|---|
| 后端测试文件 | **119** |
| `@Test` 方法总数 | **935** |
| 主源码 `.kt` | 123（32153 行） |
| 触及不同层的测试文件数 | engine **58** / infra **56** / domain **29** / api **15** |

分层触及数按测试文件的 `import io.legado.*` 归属统计（一个文件可计入多层），说明**任何一层的包级改动都会牵动过半测试**。

### 5.2 `RuleRunner` 相关（本轮风险中心）

- **构造点：测试 49 处，分布 20 个文件**；主源码 2 处（`Application.kt`、`rules/RuleRunner.kt` 的 `constructor(database: Database)` 重载）。
- 这是 §3.2 T5 的全部波及面，也是本阶段**唯一**会造成大规模编译波及的改动。

| 测试文件 | `RuleRunner(` 构造点 | `@Test` 总数 | 备注 |
|---|---|---|---|
| `SourceLoginTest.kt` | 18 | 30 | 登录态端口化的主验证场 |
| `RuleRunnerTest.kt` | 8 | **62** | 全仓最大测试文件；含离线 `RuleRunner({ url -> … })` 构造式 |
| `LlmProviderFrameworkTest.kt` | 4 | 10 | |
| `JsResponseCookieTest.kt` | 2 | 13 | |
| `RuleVariableHandoffTest.kt` | 2 | 2 | 变量跨调用存活（对应 `VariableStore` 端口语义） |
| 另 15 个文件各 1 处 | 15 | — | `AgentConnectionTest`、`AgentFrameworkTest`、`AgentInfrastructureTest`、`AgentPromptContextTest`、`AgentToolCallingTest`、`BookCacheServiceTest`、`ConnectionSelectorTest`、`JsCachePackagesBridgeTest`、`LooseUrlOptionsTest`、`PagingDetectionTest`、`ReadingAiToolsTest`、`ReplaceRuleTest`、`RuleRunnerExtendedTest`、`RuleUrlScriptsTest`、`SourceDebuggerTest` |

### 5.3 分层直接相关的高价值测试文件

| 测试文件 | `@Test` | 对应层 | 本轮是否需要动 |
|---|---|---|---|
| [ArchitectureBoundaryTest.kt](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt) | 3 | 判据本身 | **是**：新增第 4 条判据（§4.1） |
| [StorePortEquivalenceTest.kt](../../app/src/test/kotlin/io/legado/StorePortEquivalenceTest.kt) | 5 | domain/port ↔ infra | 否：端口等值契约，本轮零移动即零影响 |
| `RuleRunnerTest.kt` | 62 | engine | 否（T5 时才动） |
| `SourceLoginTest.kt` | 30 | engine↔infra | 否（T5 时才动） |
| `WebViewProxyTest.kt` | 15 | engine（`source/`） | 否，但 **§2.4-D 提示 `source/` 无判据覆盖**，建议在 T1/T3 后补一条 `source→data` 的守卫 |
| `CookieLayersTest.kt` | 15 | infra（`data`） | 否 |
| `DatabaseTest.kt` / `DatabaseLifecycleTest.kt` | 22 / 9 | infra | 否 |
| `ApiRoutesHttpTest.kt` / `AgentRoutesHttpTest.kt` | 9 / 15 | api | 否 |
| `CrossFeatureBackendTest.kt` / `E2EScenariosTest.kt` | 7 / 5 | 跨层端到端 | 否，作为 T1–T5 的兜底回归 |

### 5.4 本轮（只加判据）的回归命令

```bash
cd product && ./gradlew :app:test --tests "*ArchitectureBoundaryTest"   # 4 条判据
cd product && ./gradlew :app:test                                      # 935 项全量兜底
```

零文件移动 + 零行为变更，预期两条命令均绿，无需改任何既有测试。

---

## 6. 最大风险与建议执行顺序

### 6.1 最大风险

**「新增判据 4 的覆盖面远小于直觉，容易被误读成边界已收干净」。** 判据 4 只守 `engine→api`，而实测真正的大头在别处：`infra→engine` **29 条**、`engine→infra` **22 条**（含 13 条 ops）、`infra→root` **17 条**、真实 2-环 **15 对**。其中 **`data ↔ source` 是唯一跨 engine/infra 的真环**，且它的清账手段（宽 `Database` 句柄 → `KernelPorts`）恰好是波及 **49 个测试构造点** 的那一步。也就是说：**判据 4 可以零成本上线，但「三层真的干净」离得很远，中间隔着一次全仓级改动。**

次大风险：**既有判据 3 只扫 `rules/` 目录**（[ArchitectureBoundaryTest.kt:79](../../app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt#L79)），`source/` 的 6 条 `data` 横穿完全在守卫视野之外（§2.4-D）。若只上判据 4 而不扩判据 3 的目录，`source/` 会长期成为「没有哨兵的国境」。

### 6.2 建议顺序

1. **本轮**：只做 §4.1 判据 4（零基线）+ 更新 [architecture-audit.md](../../docs/architecture-audit.md) §3 状态行。零风险、上线即绿。
2. **下一轮（低风险）**：T1 共享原语下沉（清 `infra→api` 2）→ 顺手把判据 4b 与空基线一起提交；T2 文本工具与 `AppConfig` 离开根包（清 root 双向环）。
3. **再下一轮（中风险）**：T3 值类归位（`data→source` 9→3）；同时**扩展判据 3 的扫描目录**，让 `source/` 也进基线账。
4. **最后单列一轮（高风险）**：T5 `KernelPorts` 聚合——一次动 `Application.kt` + 49 个测试构造点 + `WebViewProxy`/`ExternalBrowserLogin`/`ScriptCache`。这一步做完，`RULES_CONCRETE_BASELINE` 才能清成空集，`data ↔ source` 环才算断。

---

## 附：本文与任务书差异一览（供 Lead 决策）

- 工作区**干净**，无未提交改动可保留（§0.1）——硬约束 2 未触发。
- 既有基线是 **1** 不是 5（§0.2）。
- 无 `desktop` 包，多出 `reading` 包（§0.3/§0.4）。
- 测试 **935** 项（§0.5）。
- **新增发现**（任务书未提）：`infra→api` 2 条、`source/` 6 条 `data` 横穿无判据覆盖、`infra→engine` 29 条、15 对真实 2-环、`LogService` 持有 `Database` 造成的引擎→SQLite 隐式路径。

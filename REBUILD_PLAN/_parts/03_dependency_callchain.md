# 03 模块依赖与调用关系

> Phase 0 审计 · 审计员：依赖与调用链
> 审计对象（只读）：`E:\legadoQ-archive\`
> 标注约定：**【事实】**=已用命令/源码验证；**【推断】**=由事实外推，未逐条验证；**【建议】**=给重建的动作建议；**【未确认】**=本轮没做到。
> 路径前缀约定：`BE:` = `product/app/src/main/kotlin/io/legado/`，`FE:` = `product/web/src/`，`TEST:` = `product/app/src/test/kotlin/io/legado/`。

---

## 0. 方法与数据来源（命令、统计口径）

### 0.1 实际执行的命令（本轮全部为只读）

```bash
# 包清单与文件数
ls BE/ ; for d in . ai backup cache content data http localbook model ops port reading rules source subscription tts; do
  find "$d" -maxdepth 1 -name '*.kt' | wc -l; done

# 一次抓全内部 import，避免 per-file×per-package 的 O(n²) grep（实测该写法在 Windows 上会超时）
grep -rn "^import io\.legado\." --include=*.kt . > imports.txt      # 605 行
# 聚合为「源包 → 目标包」边
awk 按文件路径取一级目录作源包；按 import 首段取目标包；uniq -c 计数

# 端点面
grep -rhoE '(get|post|put|delete|webSocket)\("…"' http/*Routes.kt     # 106 个路径串
python 读 app/src/main/resources/agent-api.json → 144 条 method+path

# DTO 双侧比对
python 正则抽取 BE 的 @Serializable data class 字段 vs FE types.ts 的 export type 字段，求差集
```

### 0.2 统计口径（重要，避免误读）

| 口径 | 说明 |
|---|---|
| 源包 | 按**文件所在的一级目录**判定（`data/db/CookieUtil.kt` → 源包 `data`）；`BE/` 根下的 10 个顶层文件（`Application.kt`/`StaticWeb.kt`/…）记为 `root`（= 组合根） |
| 目标包 | 按 `import io.legado.<一级子包>.` 判定 |
| `root` 的两类来源 | ① `import io.legado.AppConfig` 这种**根包类**；② `import io.legado.decodeTextAuto` / `charsetOf` / `decodeStrict` 这种**根包顶层函数**（初版脚本把它们误当成包名，已归并进 `root`） |
| 矩阵数字 | 单元格 `文件数/import 数`：左边=**至少 import 过一次目标包的文件个数**，右边=**import 语句条数**。左侧更能反映「有多少个接触面」，故排序以文件数为准 |
| 端点条数 | 以 `agent-api.json` 的 `count`（144）为唯一真源，不手数、不抄注释 |

### 0.3 覆盖到的范围

| 范围 | 文件数 | 说明 |
|---|---|---|
| BE 主源码（16 包 + 组合根） | 123 个 `.kt` | 全量参与 import 统计（grep 全扫，非抽样） |
| BE 测试 | 130 个 `.kt` | 只精读 `ArchitectureBoundaryTest.kt`（441 行），其余只列名 |
| FE `lib/api/domains/*` | 7 文件 1152 行 | 全量提取路径 |
| FE `lib/api/types.ts` | 932 行 | 只读窗口 + 脚本比对，未整读 |
| 外部依赖 | `product/app/build.gradle`、`product/build.gradle`、`gradle/libs.versions.toml`、`product/web/package.json`、`product/package.json` | 全量 |

**禁读区遵守情况**：本轮未读 `**/build/**`、`node_modules/**`、`dist/**`、`product/data/**`、`docs/archive/**`、任何 `*.jar`；`RuleRunner.kt`(1679)、`JsSandbox.kt`(2066)、`ReaderScreen.tsx`(2346)、`types.ts`(932) 等大文件一律 `grep -n` 定位后只读 ≤40 行窗口。

---

## 1. 后端包级依赖矩阵（含循环依赖与违规清单）

### 1.1 包清单与体量【事实】

| 包 | 文件数 | 定位（依 `ArchitectureBoundaryTest.kt:305-320` 的分层声明） |
|---|---|---|
| `root`（组合根） | 10 | 装配层，不属于任何包 |
| `model` | 7 | domain（纯数据类） |
| `port` | 4 | domain（端口/门面） |
| `rules` | 26 + `processor/` | engine |
| `content` | 3 | engine |
| `localbook` | 2 | engine |
| `source` | 5 | engine |
| `data` | 20（+`db/` 4 个） | infra |
| `cache` | 3 | infra |
| `ops` | 9 | infra |
| `backup` | 4 | infra |
| `subscription` | 1 | infra |
| `reading` | 1 | infra |
| `tts` | 2 | infra |
| `http` | 19（+`system/` 2 个） | api |
| `ai` | **0** | 目录仍在但**已无 .kt**（AI 2026-11-17 挪到 `product/experimental/ai/`，见 `AGENTS.md` §8.2）【事实】 |

> `ai/` 空目录仍被 `ArchitectureBoundaryTest.kt:307` 的 `API_LAYER_CALLERS` 与 `:313` 的 `INFRA_PACKAGES` 列表引用 —— 判据里点着一个不存在的目录，属**判据自身的失效引用**（不产生假红，但也守不到任何东西）。

### 1.2 包级依赖矩阵（行=源包，列=目标包；单元格 `文件数/import数`，`-` 表示 0）【事实】

| 源\目标 | root | model | port | rules | content | localbook | source | data | cache | ops | backup | subscription | reading | tts | http |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **root** | – | 2/3 | 1/1 | 1/1 | – | – | – | 1/4 | 1/2 | 1/2 | – | 1/1 | – | 1/2 | **2/5** |
| **model** | – | – | – | – | – | – | – | – | – | – | – | – | – | – | – |
| **port** | – | 1/6 | – | – | – | – | – | – | – | – | – | – | – | – | – |
| **rules** | 2/4 | 4/22 | 5/12 | 2/8 | **2/4** | – | – | – | – | **1/2** | – | – | – | – | – |
| **content** | – | 1/1 | 1/1 | **1/1** | – | – | – | – | – | – | – | – | – | – | – |
| **localbook** | 1/1 | – | 1/2 | – | – | – | – | – | – | – | – | – | – | – | – |
| **source** | – | 3/4 | 1/3 | 2/4 | – | – | – | **2/6** | – | 1/1 | – | – | – | – | – |
| **data** | 3/3 | 15/76 | 3/13 | **1/1** | 2/2 | 3/5 | **6/12** | 6/11 | **3/7** | **2/2** | – | – | – | – | – |
| **cache** | 1/1 | 2/2 | – | **1/2** | – | 1/1 | – | **2/13** | – | 1/2 | – | – | – | – | – |
| **ops** | – | 1/1 | 2/6 | – | – | – | – | 1/6 | – | – | – | – | – | – | – |
| **backup** | 1/1 | 3/11 | – | – | – | – | 1/1 | 2/13 | – | – | – | – | – | – | – |
| **subscription** | 1/1 | 1/2 | – | – | – | – | – | 1/6 | – | 1/1 | – | – | – | – | – |
| **reading** | – | 1/6 | – | – | – | – | – | 1/12 | – | – | – | – | – | – | – |
| **tts** | 1/2 | 2/6 | – | – | – | – | – | – | – | – | – | – | – | – | – |
| **http** | 3/3 | 17/103 | 5/7 | 6/16 | 2/2 | 3/4 | 2/9 | 13/81 | 3/7 | 8/14 | 3/5 | 2/2 | 1/1 | 2/4 | 2/3 |

**读法（三条最有信息量的读法）【事实】**

1. **`model` 行全空**（0 条内部 import）—— domain 层是真正的叶子，反向依赖**实测 0**，与 `ArchitectureBoundaryTest.kt:82` 的判据一致。
2. **`http` 行是全图最宽的一行**：15 个目标列里 15 个都非空（含 `backup`/`subscription`/`tts`/`localbook`），即路由层是唯一横跨所有子系统的模块。这是「换协议就要改内核」风险的量化形态。
3. **`data` 行是第二宽（10 列非空）**：`data → model` 76 条 import 是最大单边（`data` 把 `model` 当共享词汇表用，合理）；但 `data → source 6 文件 / data → cache 3 文件 / data → rules 1 文件` 三条都是 infra 向上伸手。

### 1.3 循环依赖清单（双向 import 的具体文件对）【事实】

`ArchitectureBoundaryTest.kt:378-388` 里登记了 4 对（`PACKAGE_CYCLE_BASELINE`），本轮**独立实测到同样 4 对，另加组合根相关的环**：

#### 环 1 · `data ↔ source`（唯一的跨层真环：infra ↔ engine）

| 方向 | 证据 |
|---|---|
| `data → source` | `BE:data/Database.kt:41-44`（`ParsedRssSource`/`ParsedSource`/`SourceCodec`/`WebViewProxy`）· `BE:data/CookieDao.kt:4`（`WebViewProxy`）· `BE:data/ImportDao.kt:6-7` · `BE:data/SourceRepository.kt:12-13` · `BE:data/SourcesDao.kt:6-7` · `BE:data/db/CookieUtil.kt:4` |
| `source → data` | `BE:source/WebViewProxy.kt:22-25`（`Database` / `cookieBucketsForHosts` / `getCookieForUrl` / `setCookieFromSetCookie`）· `BE:source/ExternalBrowserLogin.kt:21-22`（`Database` / `setCookieForUrl`） |

**后果**：存储层的 `CookieDao`/`CookieUtil` 为了判域名安全要够书源层的 `WebViewProxy`；书源层的 `WebViewProxy` 为了读写 Cookie 又要够存储层。两者**无法被拆到两个进程/两个模块**，也就是说「Cookie 域」当前是一个隐式的跨层模块。

#### 环 2 · `cache ↔ data`（infra 内互指）

| 方向 | 证据 |
|---|---|
| `data → cache` | `BE:data/BookshelfRepository.kt:3-8`（`BookCacheService`/`CachedCover`/`CoverCache`/`tryCacheCover`/`tryFindCachedCover`）· `BE:data/Database.kt:20` · `BE:data/ShelfDao.kt:3` |
| `cache → data` | `BE:cache/BookCacheService.kt:24-33`（10 个 `data.*` 扩展函数）· `BE:cache/CoverCache.kt:18-20` |

**后果**：`BookshelfRepository`（data）编排离线缓存队列，而 `BookCacheService`（cache）反向读写书架表 —— 「加入书架」与「离线缓存」是同一件事被切成两半。

#### 环 3 · `data ↔ ops`（infra 内互指，且跨的是 DTO）

| 方向 | 证据 |
|---|---|
| `data → ops` | `BE:data/Database.kt:34`（`import io.legado.ops.LogEntry`）· `BE:data/LogDao.kt:3`（同） |
| `ops → data` | `BE:ops/LogService.kt` 内的 `database?.let { db -> db.clearLogEntries() }`（`LogService.kt:174` 一带）· `BE:data` 被 `ops` 反向调用 |

**后果**：`LogEntry` 这个 **HTTP 响应 DTO 被定义在 `ops/LogService.kt:178`，不在 `model/`**，导致 `data` 要 import `ops` 才能持久化它。这是「DTO 位置错」直接造出的一个包环，不是业务需要。

#### 环 4 · `content ↔ rules`（engine 内互指）

| 方向 | 证据 |
|---|---|
| `content → rules` | `BE:content/ContentProcessor.kt:7`（`import io.legado.rules.JsSandbox`） |
| `rules → content` | `BE:rules/RuleRunner.kt:46-48`（`ContentProcessor`/`LooseJson`/`applyReplaceEntry`）· `BE:rules/RuleUrlSupport.kt:3`（`LooseJson`） |

**后果**：替换规则（content）需要 JS 沙箱（rules）做纯文本替换；规则引擎（rules）需要内容处理（content）做正文净化。**两者共用同一份文本加工语义，却互相当对方的底层。**

#### 环 5 · `root ↔ X`（判据里被排除的 7 对，实测至少 4 对真实存在）【事实】

| 方向 | 证据 |
|---|---|
| `root → http` | `BE:Application.kt:26-30`（`SameOriginWriteGate`/`StrictJsonConverter`/`apiRoutes`/`requireLoopbackBind`）· `BE:StaticWeb.kt:12`（`requireSameOriginWrite`） |
| `http → root` | `BE:http/Guard.kt:13`（`AppConfig`）· `BE:http/SearchRoutes.kt:10`（`AppConfig`）· `BE:http/system/SystemRoutes.kt:10`（`BuildInfo`） |

**后果（本轮最该记的一条）**：`StaticWeb.kt` 既是组合根（被 `Application` 装配），又**自己注册了业务路由** `/brand`（6 条，`StaticWeb.kt:177-237`）。所以「组合根只做装配」这条前提在这份代码里**不成立** —— 见 §4.3。

### 1.4 跨层违规清单

> 分层方向（`ArchitectureBoundaryTest.kt:44` 写死）：`domain ← engine ← infra ← api`，箭头只能从右往左。

#### 1.4.1 engine → infra（向上，判据 5 有守，基线 4 条）【事实】

| 违规 | 证据 | 性质 |
|---|---|---|
| `rules → ops` | `BE:rules/RuleRunner.kt:3`（`Metrics`）· `:52`（`NetworkSecurity`） | 拿了出站闸门 + 指标打点 |
| `source → ops` | `BE:source/WebViewProxy.kt`（`WebViewProxy.kt:21` 一带 import `ops`） | 同上 |
| `source → data` | `BE:source/WebViewProxy.kt:22-25` · `BE:source/ExternalBrowserLogin.kt:21-22` | Cookie 域名的安全判定，唯一实现落在 infra |

这 4 条已在基线里，`ArchitectureBoundaryTest.kt:44x` 的 `ENGINE_TO_INFRA_BASELINE` 断言**相等**（新增即红，删了不缩也红）。

#### 1.4.2 infra → engine（方向合法，但组成环时才有害）【事实】

| 边 | 证据 | 判断 |
|---|---|---|
| `data → rules` | `BE:data/SourceRepository.kt:11`（`import io.legado.rules.RuleRunner`） | 方向合法（infra 可用 engine），**但** `SourceRepository` 因此不能在没有规则引擎的情况下构造 —— 书源 CRUD 与规则求值被焊在一起 |
| `data → source`,`data → cache` | 见 §1.3 环 1、环 2 | 组环，真问题 |
| `cache → rules` | `BE:cache/BookCacheService.kt:36-37`（`RuleExecutionException`/`RuleRunner`） | 离线缓存直接持有规则引擎，只能整块搬 |

#### 1.4.3 `http` 绕过 Repository 直接调 DAO【事实，且是本轮最普遍的一类】

`http/` 有 **13 个文件 / 81 条** `import io.legado.data.*`，其中大量是**顶层扩展函数**（= DAO 层，不是 Repository）。实例：

| 路由文件 | 直接 import 的 DAO 函数（file:line） |
|---|---|
| `BE:http/ReadingRoutes.kt:12-22` | `cacheBookContent`/`cachedContent`/`getContentProcess`/`saveContentProcess`/`getTocCache`/`saveTocCache`/`listBookshelf`/`getSource`/`getEnabledReplaceRulesForScope` —— 11 条 DAO 函数，一条 Repository 也没走 |
| `BE:http/MediaRoutes.kt:17-19` | `coverContentType`/`getCookieForUrl`/`getSource` |
| `BE:http/ReplaceRulesRoutes.kt:15-19` | `deleteReplaceRule`/`deleteReplaceRules`/`exportReplaceRules`/`getEnabledReplaceRulesForScope`/`getReplaceRule` |
| `BE:http/TocRulesRoutes.kt:12` | `clampShelfProgress`（见 §2.4，这一条直接改阅读进度） |
| `BE:http/BackupRoutes.kt:17` | `DbSnapshot` |

【事实】同一批数据面上，**三种访问风格并存**：
- 有 Repository 的：`ReadingRepository`（`BE:reading/ReadingRepository.kt`）、`BookshelfRepository`（`BE:data/BookshelfRepository.kt`）、`SourceRepository`（`BE:data/SourceRepository.kt`）
- 只有 DAO 的：目录缓存、正文缓存、替换规则、Cookie、日志、订阅
- `ReadingRoutes.kt:62` 与 `ReadingRoutes.kt:243` 一带甚至**同时**用 `database.xxx()`（DAO 扩展）与 `runner.xxx()`（engine），中间没有服务层。

【推断】「Repository 层」在这份代码里**不是一个完整层，而是四个文件的选择性包装**：`ReadersRoutes` 走 Repository，`ReadingRoutes` 完全不走。重建时若假设「所有落库都经过 Repository」，会立刻踩空。

### 1.5 `model/` 反向依赖检查【事实】

实测 `model/` 7 个文件 **0 条** `import io.legado.<其它包>`，与 `ArchitectureBoundaryTest.kt:82-97` 断言一致。但**DTO 有外溢**：

| 外溢的 DTO | 定义位置 | 谁在用 |
|---|---|---|
| `LogEntry` | `BE:ops/LogService.kt:178` | `BE:data/Database.kt:34`、`BE:data/LogDao.kt:3`、`http/system/SystemRoutes.kt` |
| `ApiError` | `BE:http/` 内 | 全部路由（HTTP 专属，可接受） |
| `RuleResult` | `BE:rules/RuleProcessor.kt`（`@Serializable`） | 规则扩展点返回值 |

【建议】重建时把 `LogEntry` 移进 `model/`，`data ↔ ops` 环当场消失（一环一改）。

---

## 2. 关键调用链（7 条）

> 链路图例：`HTTP 入口 → 路由 → 服务/仓储 → 引擎 → 网络 → 落库/返回`
> 每条都给真实函数名 + `file:line`。JS 沙箱边界单独标 `【JS】`。

### 2.1 搜索（含流式）【事实】

**同步版：`POST /api/search`**

```
FE lib/api/domains/search.ts:74  api.search(...)
  └─ POST /api/search                      BE:http/SearchRoutes.kt:53
     ├─ requireSameOriginWrite()            BE:http/SearchRoutes.kt:54      ← 写门（POST 但要过同源闸门）
     ├─ call.receive<SearchRequest>         BE:http/SearchRoutes.kt:55
     ├─ database.listSearchSourceRecords()  BE:http/SearchRoutes.kt:58      ← DAO，不经 Repository
     ├─ orderByHealth(records, healthOrder) BE:http/SearchRoutes.kt:66 → :311
     ├─ collectWithDeadline(…, AppConfig.searchTotalTimeoutMs)  BE:http/SearchRoutes.kt:76 → :331
     │   ├─ 总截止：AppConfig.searchTotalTimeoutMs（配置项，非硬编码）
     │   ├─ 并发：sourceSearchConcurrency() = CPU 核数  BE:http/SearchRoutes.kt:262
     │   └─ 到点 work.cancel() + 返回已收部分     BE:http/SearchRoutes.kt:364-368
     ├─ readableSearchResults(runner, …)    BE:http/SearchRoutes.kt:189
     └─ searchSourceOutcome(…)              BE:http/SearchRoutes.kt:225
        └─ withTimeout(SEARCH_TIMEOUT_MS=30s) { withContext(Dispatchers.IO) { runner.search(...) } }
                                           BE:http/SearchRoutes.kt:230,243
           └─ 【JS】书源 ruleSearch 内 JS 走 JsSandbox（BE:rules/RuleRunner.kt）
     └─ call.respond(outcome.values.flatten())  BE:http/SearchRoutes.kt:95
        响应头：X-Search-Total / -Completed / -Truncated   BE:http/SearchRoutes.kt:88-90
```

**关键结论（三处会被重建踩到的设计）**

1. **搜索结果不落库**【事实】：`SearchRoutes.kt:95` 直接 `respond`，全链路没有任何写表；只有 `Metrics.recordSearchRequest(...)`（`:82`）与体检顺序 `database.healthSearchOrder()` 读库。所以「搜索历史/结果缓存」在服务端**不存在**，重建时若照抄「搜索→落库」假设会凭空造表。
2. **超时是两级的**【事实】：单源 30s `withTimeout`（`:243`）+ 全局 `searchTotalTimeoutMs`（`:76`）。源码注释明确写：`HttpClient.send()` 是**阻塞**的，单源 `withTimeout` **取消不掉**它，所以必须再加一层总量截止 —— `SearchRoutes.kt:69-72` 记录了 65 个慢站能把请求拖过 300 秒的实测。
3. **截断要显式说出来**【事实】：`X-Search-Truncated` 头 + 服务端 info 日志（`:91-94`），不静默返回半份。

**流式版：`WS /api/search/stream`**

```
FE lib/api/domains/search.ts:39  new WebSocket(`${protocol}//${location.host}/api/search/stream`)
  └─ webSocket("/search/stream")          BE:http/SearchRoutes.kt:97
     ├─ originMatchesHost(call) 否则 VIOLATED_POLICY 关闭   :99-102
     ├─ 首帧尺寸闸门（WS_SEARCH_MAX_FRAME_BYTES）           :105-109
     ├─ SearchSession(records, concurrency, action)        :111-113 → BE:http/SearchSession.kt:25
     │    └─ events(): Flow<SearchStreamEvent> = channelFlow  SearchSession.kt:30
     │         └─ Semaphore(concurrency)                    SearchSession.kt:33
     ├─ launch { session.events().collect { send(Frame) } } :114-118
     ├─ launch { 读后续帧，见 "cancel" 即 streaming.cancel() } :119-141
     └─ streaming.join(); cancelWatch.cancel()              :145-146
```

**协程/取消边界【事实】**

| 关注点 | 实现 | 证据 |
|---|---|---|
| 取消传播 | 客户端发 `"cancel"` 文本帧 → `streaming.cancel()` | `SearchRoutes.kt:135-137` |
| 泄漏防护 | 正常收尾后 `cancelWatch.cancel()`，避免监听协程吊住 scope | `SearchRoutes.kt:146`（注释明写「别让它吊着整个 scope」） |
| 帧数上限 | `WS_SEARCH_MAX_MESSAGES`（64） | `SearchRoutes.kt:174-176` 一带 |
| 独立 scope | 源码注释称「不挂在请求协程树上」 | `SearchRoutes.kt:289` —— 但**同一函数内未见 `supervisorScope`**，【未确认】该注释与 `collectWithDeadline`(`:331`) 的实现是否完全对齐 |

### 2.2 书源 JSON 导入【事实】

```
FE lib/api/domains/sources.ts  POST /api/sources/import {sources:[rawJson,...]}
  └─ post("/sources/import")                 BE:http/SourcesRoutes.kt:266
     ├─ requireSameOriginWrite()             :267
     ├─ repositoryFor(call).importSources(...)  :269
     │    └─ SourceRepository.importSources   BE:data/SourceRepository.kt:172
     │        └─ database.importSources(raw)  BE:data/SourcesDao.kt:312
     │            ├─ transaction { importSourcesOn(it, raw) }        SourcesDao.kt:313   ← 事务边界①
     │            │    ├─ SourceCodec.parse(raw) per item            SourcesDao.kt:324   ← 解析+校验（逐条 try，坏条目只进 errors）
     │            │    ├─ 去重：linkedMapOf<id, ParsedSource>（后写覆盖前写）  SourcesDao.kt:321-325
     │            │    └─ upsert source(...) on conflict(id)         SourcesDao.kt:341-354
     │            │         · enabled 故意不覆盖（保本机启用状态）    SourcesDao.kt:333
     │            │         · source_group 合并体检标签 mergeHealthTags(parsed, local)  SourcesDao.kt:350
     │            └─ invalidateSourceCaches()                        SourcesDao.kt:313 → Database.kt:221
     │                 ├─ sourceSummariesCache = null                Database.kt:222
     │                 ├─ exploreSourcesCache = null                 Database.kt:223
     │                 ├─ cookieMentions.invalidate()                Database.kt:224
     │                 └─ MentionsWarmer.schedule(this)              Database.kt:225
     └─ call.respond(ImportResponse)         :270
```

**事务边界【事实】**：唯一事务在 `SourcesDao.kt:313`（`transaction { }`），**解析失败是逐条容错而非整批回滚**（`:322-329` 把错误收进 `errors` 列表后继续）。因此「导入 100 条、其中 3 条坏」的结果是 97 条入库 + 3 条错误信息，**没有 all-or-nothing 语义**。

**缓存/索引失效【事实】**：只有 4 个内存缓存被显式失效（`Database.kt:221-226`），且**发生在事务之外**（`SourcesDao.kt:313` 的 `.also{}`）。若事务已 commit 而 `invalidateSourceCaches()` 抛错，会留下「库已变、缓存仍旧」的窗口 —— 无补偿逻辑。【推断】窗口极短（同一线程紧邻调用），未发现实际故障记录。

**伏笔（重建必看）**：`SourcesDao.kt:361-364` 明写 `source_group` 里的体检标签词表**必须与 `FE:lib/sourceGrouping.ts` 的 `HEALTH_TAGS` 逐字一致**，靠 `web/test/HealthTagVocabulary.test.ts` 守。这是**前后端共享词表、无共享定义**的典型（见 §5.2）。

### 2.3 取目录 + 取正文（规则分派 / JS 沙箱 / 缓存命中）【事实】

#### 2.3.1 取目录 `POST /api/books/chapters`

```
FE domains/search.ts  api.chapters()
  └─ post("/books/chapters")                        BE:http/ReadingRoutes.kt:89
     ├─ requireSameOriginWrite()                     :90
     ├─ getTocCache(sourceId, bookUrl)               :92   ← 缓存命中①
     │    └─ 未命中再试 bookUrl 去掉 /toc 再拼回      :92-93（目录地址≠书页地址的兜底）
     ├─ getCachedChaptersFallback(...)               :97   ← 缓存命中②（从已缓存正文反推目录）
     ├─ 本地书短路（LOC_BOOK_SOURCE_ID）              :98-106
     ├─ getSource(sourceId)                          :107
     └─ respondCatching {
          withContext(Dispatchers.IO) {
            withTimeout(4000) {                       :118   ← 单次网络超时 4s
              runner.chapters(json, bookUrl)          :119
              ├─ 空则 runner.details(...).tocUrl 再取  :121-123
              └─ saveTocCache(sourceId, …)            :124,127
            } } }
        catch:
          ├─ 真取消（CancellationException 且非 TimeoutCancellationException）原样抛出  :130-131
          ├─ 否则回落 fallbackFromContent           :133
          └─ 否则抛 RuleExecutionException          :136
```

**【事实】这里有一个明确、写进注释的协程语义选择**：`ReadingRoutes.kt:129-131` 把「客户端断开导致的取消」与「本地 `withTimeout` 超时」区分开 —— 前者必须原样上抛（否则会对着已断连接 `respond`），后者才走回落。重建时这是必须保留的不变量。

#### 2.3.2 取正文 `POST /api/books/content`

```
FE domains/search.ts:99  api.content()（手写内联类型，见 §5.2 实例 1）
  └─ post("/books/content")                        BE:http/ReadingRoutes.kt:140
     ├─ 校验 sourceId/chapterUrl                    :142-145
     ├─ bookUrl 推导（local:// 时从 chapterUrl 截）  :146-149
     ├─ listBookshelf() 找书名（给替换规则做作用域）  :150-152   ← DAO，无索引，全表 listBookshelf
     ├─ cachedContent(sourceId, bookUrl, chapterUrl) :153  ← 缓存命中①
     ├─ fun override(base)  ← AI 净化/润色覆盖        :156-163
     │    ├─ getContentProcess(..., "ai_clean")     :158
     │    └─ 否则 getContentProcess(..., "ai_rewrite") :159
     ├─ 本地书分支：ContentProcessor.processContent(cached, rules, JsSandbox(runner))  :165-172
     │    【JS】这里 new JsSandbox(runner) 只为跑替换规则里的 JS
     ├─ getSource(sourceId)                         :180
     ├─ 缓存命中且非 force → override(cached)         :184-186  ← 缓存命中②（最快路径）
     └─ 否则 respondCatching { IO { runner.content(...).also { cacheBookContent(...) } } }  :187-191
        失败：非 force 且有旧正文 → 回旧正文；否则抛  :192-194
```

**规则链如何按类型分派【事实】**（`BE:rules/RuleProcessor.kt`）

```
NodeValue.value(rule) / RuleRunner.nodes(body, rule)
  └─ 先问扩展点：RuleDispatcher.claim(rule)          RuleProcessor.kt:104-107  ← 单值
                 RuleDispatcher.claimNodeRule(rule)  RuleProcessor.kt:110-114 ← 列表（只问 producesNodes=true 的）
      └─ 命中 → processor.execute(rule, input, ctx)  RuleProcessor.kt:57
      └─ 未命中 → 内建四种类型（CSS / XPath / JSONPath / JS）RuleProcessor.kt:16-18
```

三条不可动摇的语义【事实】（`RuleProcessor.kt:20-25` 注释与代码一致）：
1. **`execute` 是同步的** —— 取值在解析热路径上，一次搜索要对几千条记录求值；要联网的处理器请放宿主层。
2. **认领即拥有** —— 处理器返回空就是「这条规则没值」，**不回落**内建链路（否则自定义类型会被当 CSS 选择器，抛看不懂的 `SelectorParseException`）。
3. **`RuleInput.evaluateBuiltin` 不走扩展点** —— 供处理器「先按老规则取值再加工」而不自递归。

派发器线程安全：`CopyOnWriteArrayList`（`RuleProcessor.kt:90`），同 `type` 再注册覆盖旧的（`:96-99`）。
【事实】当前 `rules/processor/` 下**只有 demo 两个实现**（`DemoHelloProcessor.kt`/`DemoMarkdownProcessor.kt`），即扩展点在生产路径上没有真实使用者。

**JS 沙箱何时介入【事实】**

| 介入点 | 触发条件 | 证据 |
|---|---|---|
| 书源规则求值 | 规则串是 JS（`<js>…</js>` / `@js:` / 含 JS 取值） | `BE:rules/RuleRunner.kt` + `BE:rules/JsSandbox.kt` |
| 替换规则 | 本地书分支显式 `JsSandbox(runner)` | `BE:http/ReadingRoutes.kt:167` |
| 图片解密 | 书源配了 `ruleContent.imageDecode` | `BE:http/MediaRoutes.kt:136-140`（`runner.imageDecoder(json)`） |
| 书源 JS 里的 Java 桥 | `Packages.xxx` 调用（hutool / okhttp3 / jsoup 模拟） | `BE:rules/JavaPackages.kt:626-637` |

### 2.4 阅读进度写入（本轮重点）【事实】

**答案：写 `reading_progress` 表的位置一共 6 处**（3 处写值 + 3 处删除），**其中「完整语义的权威实现」只有 1 处**；另有 2 条前端入口，其中 1 条是死代码。

#### 2.4.1 服务端 6 处写点全表

| # | 函数 | 位置 | SQL | 触发入口 | 语义 |
|---|---|---|---|---|---|
| ① | `Database.saveProgress` | `BE:data/ReadingDao.kt:15` | `update`(21) / `insert`(28) / `upsert`(36) | `PUT /api/reading-progress` ← `ReadingRepository.saveProgress`（`BE:reading/ReadingRepository.kt:36-37`）← `ReadersRoutes.kt:36-41` | **权威实现**：唯一同时处理 `charOffset`/`paragraphAnchor`/`positionVersion`/`positionChecksum` 全组，且 `charOffset==null` 时"只更新位置、不碰 position 列"（`ReadingDao.kt:19-34`） |
| ② | `Database.clampShelfProgress` | `BE:data/ShelfDao.kt:77`（SQL 在 `:78`） | `update reading_progress set chapter_index=? … and chapter_index > ?` | `TocRulesRoutes.kt:194`（换规则重切目录后夹回范围） | **第二处写值**：只改 `chapter_index`，条件更新（只在超出时改） |
| ③ | `Database.importLibraryOn` | `BE:data/ImportDao.kt:150-166`（SQL 在 `:153`） | `insert … on conflict … where excluded.updated_at >= reading_progress.updated_at` | 备份导入 `BackupImporter`（§2.5） | **第三处写值**：备份恢复，比 ①多了**单调性守卫**，并把 `paragraph_anchor`/`position_checksum` 置 null（`ImportDao.kt:159-161`） |
| ④ | `Database.removeBookshelf` | `BE:data/ShelfDao.kt:234`（delete 在 `:241`） | `delete from reading_progress …` | `DELETE /api/bookshelf` | 删除 |
| ⑤ | `Database.batchRemoveBookshelf` | `BE:data/ShelfDao.kt:254`（delete 在 `:265`） | 同 | `POST /api/bookshelf/batch-delete`（`ShelfRoutes.kt:253-264`） | 删除 |
| ⑥ | `Database.switchBookshelf` | `BE:data/ShelfDao.kt:316`（delete 在 `:335`） | 同（针对 **old**SourceId/oldBookUrl） | `POST /api/bookshelf/switch-source` | 换源时删旧书进度 |

#### 2.4.2 前端 2 条入口（1 活 1 死）

| # | 入口 | 位置 | 状态 |
|---|---|---|---|
| ⑦ | 阅读器 `persist()` | `FE:features/reader/ReaderScreen.tsx:816-829`（`api.saveProgress` 在 `:820`） | **活**：阅读器唯一写进度路径 |
| ⑧ | 回到在线时刷离线队列 | `FE:main.tsx:335-341`（`flushOfflineProgress` 在 `:335`） | **半死**：`flushOfflineProgress`（`FE:lib/offlineStorage.ts:462`）读 localStorage 队列并逐条 `api.saveProgress`，但**入队函数 `enqueueOfflineProgress`（`offlineStorage.ts:447`）全仓 0 调用** —— 队列永远是空的 |

`enqueueOfflineProgress` 零调用已实测确认：`grep -rn enqueueOfflineProgress FE/` 只命中定义行本身（`offlineStorage.ts:447`）。

#### 2.4.3 三处语义不对称（重建时最容易漏的部分）

1. **①没有单调性守卫，③有**。`ReadingDao.kt:36` 的 upsert 是**无条件覆盖**；`ImportDao.kt:159` 的 upsert 带 `where excluded.updated_at >= reading_progress.updated_at`。也就是说**备份恢复比日常阅读写入更"小心"**，方向反过来才对。
2. **前端传的 `updatedAt` 被服务端丢弃**。`FE:lib/api/domains/reader.ts:172-176` 组装请求体时带 `updatedAt: Date.now()`；`BE:model/ReadingModels.kt:77` 确实有 `updatedAt: Long = 0` 字段能收下；但 `ReadingDao.kt:16` 用 `val now = System.currentTimeMillis()` 覆盖它，末尾 `progress.copy(updatedAt = now)`（`:46`）。**客户端时间戳进来就被扔掉**，因此无法在服务端做「谁更新」的对比。
3. **写进度顺带改书架时间戳**。`ReadingDao.kt:43-45` 在同一次 `write{}` 里 `update book_shelf set last_read_at=?`。所以 `saveProgress` 其实是**跨两张表**的写操作，`getProgress`（`:49`）却只读一张。

【推断】风险场景：标签页 A 离线期间读到 30 章，回到在线触发 ⑧（一旦有人把入队补上）把 30 章写库；此时标签页 B 已在线读到 5 章并写入过 —— ①无条件覆盖 + 丢弃客户端时间戳 = **A 的旧位置盖掉 B 的新位置**。今天因为 ⑧ 的队列是空的，该路径不可达；但代码结构已经埋好。

【建议】重建时：①加单调守卫（照抄 `ImportDao.kt:159`）；②`updatedAt` 用客户端值并参与比较；③把 `clampShelfProgress` 收进同一个服务方法，禁止路由层直调 DAO 改进度（现况 `TocRulesRoutes.kt:12,194` 就是绕过）。

#### 2.4.4 不写进度的两个"看起来会写"的入口（澄清）

- `POST /api/bookshelf/batch-mark-read`（`ShelfRoutes.kt:283-289`）**不写进度**：源码注释（`ShelfRoutes.kt:275-279`）明确记录了历史 bug —— 它原来「已读=把进度推到最后一章、未读=删掉 reading_progress」，导致界面无变化且抹掉用户实际进度，现在改走 `repository.batchMarkAsRead`（只改 `book_shelf.completed`）。
- `ReadingDao.addReadingLog`（`:59`）写的是 `reading_log` 表（按天累加秒数），与 `reading_progress` 无关。

### 2.5 备份导出 / 导入【事实】

#### 2.5.1 导出 `GET /api/backup/export`

```
FE plugins/backup/BackupPage.tsx:213  requestBlob('/api/backup/export')
  └─ get("/backup/export")                    BE:http/BackupRoutes.kt:83
     ├─ domain 参数（all/source/replacerule/group/rss/shelf）   :84-107
     └─ respondZip(call, "legadoq-backup-<stamp>.zip") { BackupExporter.exportAll(database, this) }
                                               :93, :182
        └─ respondOutputStream：直接把 zip 写进 HTTP 流
```

【事实】导出**不落盘**：`respondZip`（`BackupRoutes.kt:182`）是流式回包，服务端磁盘上没有备份文件；`else` 分支对未知 domain 回 400（`:108-115`）。**与"数据库快照"是两条完全不同的路**：快照走 `get("/backup/snapshots")`（`:52`）与 `post("/backup/snapshots/restore")`（`:56`），后者只回 `BackupRestoreScheduled(scheduled=true, restartRequired=true)`（`BackupRoutes.kt:171-173` 定义）——**排定，不是即时生效**。

#### 2.5.2 导入 `POST /api/backup/import`（反向链路 + 回滚点）

```
FE domains/backup.ts  POST /api/backup/import (multipart: file + password?)
  └─ post("/backup/import")                   BE:http/BackupRoutes.kt:113
     ├─ requireSameOriginWrite()              :114
     ├─ receiveMultipart() 取 password + 第一个 FileItem   :115-125
     ├─ bytes.size > MAX_BACKUP_BYTES(64 MiB) → 413        :135-140
     ├─ Files.createTempFile("legado-backup-", ".bin") 暂存 :141-142
     │    （不再按扩展名判类型：zip 头 PK 由 BackupImporter 判）  :128-133 注释
     ├─ withContext(Dispatchers.IO) { BackupImporter(database, backupKeep).import(staged, password) }
     │                                          :144-146
     │   └─ BackupImporter.import              BE:backup/BackupImporter.kt:97
     │      └─ importZip / importJson          BackupImporter.kt:103 / :168
     │         └─ applyAll(...)                BackupImporter.kt:238 起
     │            └─ database.transaction { db -> }        BackupImporter.kt:253   ★唯一事务边界
     │               ├─ stepHook("sources")  importSourcesOn(db, sources)     :254-255
     │               ├─ stepHook("rules")    importReplaceRulesOn(db, rules)  :256-257
     │               ├─ stepHook("groups")   importBookGroupsOn(db, groups)   :259-260
     │               ├─ stepHook("library")  importLibraryOn(db, shelf…)      :262-263
     │               ├─ stepHook("rss")      importRssSourcesOn(db, rss)      :264-265
     │               └─ stepHook("cookies")  cookies()                        :266-267
     │            └─ 事务外：database.invalidateSourceCaches()   BackupImporter.kt:270
     ├─ 失败：非 CancellationException → 400 invalid_backup      :148-152
     └─ finally: Files.deleteIfExists(staged)                    :166
```

**回滚点【事实】**：**只有一个** —— `BackupImporter.kt:253` 的外层 `database.transaction{}`。它内部 6 个 step 全部用 `*On(db, …)` 形式（复用传入连接），因此：

- 任一步抛错 → 外层 `rollback()` → **六节全回滚**（`Database.kt:145-152`）；
- 内层若再嵌套 `transaction`，走 `SAVEPOINT legado_tx_<depth>` 而不是 `commit`（`Database.kt:139-141`）。
- `invalidateSourceCaches()` 在**事务外**（`BackupImporter.kt:270`），源码注释解释了原因：「回滚时库里没变，清缓存纯属白做」。
- 文件暂存区的清理在 HTTP 层 `finally`（`BackupRoutes.kt:166`），与数据库事务**不同生命周期**。

**事务内不做 IO 的纪律**：`Database.kt:132-134` 明文规定「事务内不要做网络/文件 IO（单写连接被独占，所有写请求排队）」。但 `BackupImporter.kt:254-267` 的 6 步全在事务内，其中 `cookies()` 会解密 AES 密文（CPU 活，非 IO），符合纪律；【未确认】`importLibraryOn` 是否触碰文件系统（本轮未读该函数体）。

### 2.6 TTS【事实】

```
FE lib/api/domains（tts 段）
  ├─ POST /api/tts/session                       BE:http/TtsRoutes.kt:31
  │    └─ ttsSessions.create(LOCAL_TTS_OWNER)    → TtsSessionService.kt:47
  ├─ POST /api/tts/session/{id}/chunks           TtsRoutes.kt:35
  │    └─ session.append(TtsSessionChunkRequest) → TtsSessionService.kt:110 → process() :194
  │         └─ engine=="custom" ? streamCustom(chunk) : streamEdge(chunk)   :205
  │              ├─ streamCustom  → EdgeTtsService.synthesizeCustom(req)    :237
  │              └─ streamEdge    → EdgeTtsService.synthesize(...)         :225
  │                   └─ wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1
  │                                     BE:tts/EdgeTtsService.kt:49
  ├─ GET /api/tts/session/{id}/audio             TtsRoutes.kt:82
  │    └─ respondBytesWriter(ContentType.Audio.MPEG) { session.streamAudio(this) }
  │                                       TtsRoutes.kt:94-96 → TtsSessionService.kt:141
  │       响应头：Cache-Control no-store / X-Accel-Buffering no / Connection keep-alive
  ├─ GET /api/tts/session/{id}/events            TtsRoutes.kt:96
  │    └─ respondTextWriter(Text.EventStream) { session.streamEvents(this) }  :106-108
  ├─ POST /api/tts/session/{id}/control          TtsRoutes.kt:53（pause/resume/stop）
  ├─ DELETE /api/tts/session/{id}                TtsRoutes.kt:72
  ├─ POST /api/tts/speak                         TtsRoutes.kt:110  ← 一次性合成，直接回 bytes
  └─ GET  /api/tts/speak?text=                   TtsRoutes.kt:146
```

**音频回传形状【事实】**：两条路 —— ①**流式**：`streamAudio(output: ByteWriteChannel)`（`TtsSessionService.kt:141`）把音频字节写进 Ktor 的字节通道，前端用 `<audio src="/api/tts/session/{id}/audio">` 消费；②**一次性**：`POST /speak`/`GET /speak` 直接 `respondBytes`（`TtsRoutes.kt:128-134`）。
**MP3 时长**由自研 `Mp3DurationEstimator`（`TtsSessionService.kt:342`，配套 `Mp3DurationEstimatorTest`）解析帧头估算，属**自己实现的解析**（不是库）。

**安全边界【事实】**：`POST /speak` 的 `customUrl` 允许请求体指定服务端抓取地址，`TtsRoutes.kt:111-113` 注释明确记录了历史漏洞（「之前只验会话不验 CSRF，任何网页发个简单跨站请求就能借这台机器去打内网」），现在过 `requireSameOriginWrite()`。`EdgeTtsService.kt:30-33` 另注明自定义 TTS 客户端**不自动跟随重定向**（`NORMAL` 会被跟到内网/云元数据端点）。

### 2.7 图片 / 封面【事实】

```
FE readerImage.ts / api.cover(key)
  ├─ GET /api/covers/{key}                  BE:http/MediaRoutes.kt:43
  │    ├─ coverCache.file(key) 未命中 → 404     :45
  │    ├─ SVG 降级成 octet-stream（同源 SVG 可带脚本）  :47-52
  │    ├─ Cache-Control max-age=7d private      :53
  │    └─ respond(LocalFileContent(file))       :54
  ├─ GET /api/covers/proxy?url=&referer=     MediaRoutes.kt:64
  │    ├─ 只接 http/https（否则 400）            :66-69
  │    └─ coverCache.cacheContentImage(url, referer)   :75
  │         ├─ SSRF 校验（只许公网 http/https）
  │         ├─ 只收图片类型、拒 SVG、5 MiB 上限、gzip 解码
  │         ├─ Referer 走完整个重定向链
  │         └─ Cookie 按每跳落地域名现取（proxyRequestHeaders）→ 已下沉 ops/
  │    └─ 失败：logNetwork 留一行警告 + 502 image_failed   :84-96
  ├─ GET /api/book/image?url=&page=&sourceId= MediaRoutes.kt:125
  │    └─ sourceId 且 ruleContent.imageDecode 时 runner.imageDecoder(json)  :136-140
  │       └─ coverCache.cacheContentImage(url, referer, decoder, "#decode:$sourceId")  :143
  │       （解密结果单独缓存：key 带源与解密标记）
  ├─ POST /api/book/image/refresh            MediaRoutes.kt:168
  │    └─ coverCache.refetchContentImage(...) 绕开盘上副本，原子覆盖
  │       （前端另带代次参数绕开浏览器 7 天 max-age 与 SW 的 SWR 30 天）
  └─ GET /api/book/media（Range 透传，不落盘）  MediaRoutes.kt:201
```

**缓存三层【事实】**：①服务端磁盘 `CoverCache`（key = `sha256(url)`，`#decode:<sourceId>` 后缀区分解密版）；②HTTP `Cache-Control: max-age=7d, private`；③前端 Service Worker 的 `legado-covers` SWR 30 天。三层各有各的失效方式，`/book/image/refresh` 的存在就是为了同时打穿三层（`MediaRoutes.kt:158-166` 注释）。

---

## 3. 事务与并发边界（写连接、协程、锁）

### 3.1 单写连接 + 全局锁【事实】

| 机制 | 实现 | 证据 |
|---|---|---|
| 写连接 | **全局唯一一条**，复用 | `BE:data/db/ConnectionPool.kt:59-66` |
| 写锁 | `ReentrantLock`，全局 | `ConnectionPool.kt:19`、`useWrite` 在 `:70-74` |
| 读连接 | `ConcurrentLinkedQueue` 池化 + `select 1` 健康检查 | `ConnectionPool.kt:40-57` |
| WAL / 同步级别 / 忙等 | `WAL` + `NORMAL` + `busy_timeout=10000` + 外键开 | `ConnectionPool.kt:27-32` |

**这意味着**：任何一条慢写（大备份导入、批量删书）会把**全部**写请求排队；读不受影响（独立池）。这是 §2.6 音频流、§2.7 图片代理都**不落盘**的根本原因。

### 3.2 可嵌套事务【事实】

`Database.transaction{}`（`BE:data/Database.kt:135-160`）：
- 深度 0 → `autoCommit=false` + 末尾 `commit()`；深度 >0 → `SAVEPOINT legado_tx_<depth>`（`:139-145`）
- 深度用 `ThreadLocal`（`:119-120`），理由是「写连接由 `writeLock` 独占，同一时刻只有一个线程在事务里」
- `catch` 里 `runCatching { rollback }` 不覆盖原异常（`:150-152`）
- `finally` 深度归零时复位 `autoCommit = true`（`:158`）

**已知历史事故（源码注释记录）**【事实】：`Database.kt:125-134` 写「库里有六七个函数自己写 `autoCommit = false … commit() … autoCommit = true`，把它们串成一个整批事务时，直接在外层套 `write { autoCommit = false }` 会静默失效 —— 第一个内层函数在 `finally` 把 `autoCommit` 复位成 true，外层事务当场被提交掉；**0.2.35 的批量删书事故就是这条**。」

**残留风险**【事实】：同一注释 `:133-134` 承认仍有「自己管 `autoCommit` 的 DAO（`ShelfDao` / `CacheDao` 里的老函数）」，**它们会把外层事务提交掉**。重建时必须把这一类彻底清成 `transaction{}`/`write{}`，否则任何"把若干操作包进一个事务"的改造都会静默失效。

### 3.3 协程边界汇总【事实】

| 位置 | 语义 | 证据 |
|---|---|---|
| 搜索单源 | `withTimeout(30s)` + `Dispatchers.IO` | `SearchRoutes.kt:230,243` |
| 搜索全局 | `collectWithDeadline` 到点 `work.cancel()` 并返回部分结果 | `SearchRoutes.kt:331-368` |
| 搜索流 | `channelFlow` + `Semaphore(concurrency)` | `SearchSession.kt:30-33` |
| 目录 | `withTimeout(4000)` | `ReadingRoutes.kt:118` |
| 目录取消 | 真取消上抛 / 超时走回落（显式区分） | `ReadingRoutes.kt:129-131` |
| 备份导入 | `withContext(Dispatchers.IO)` 包住整个导入 | `BackupRoutes.kt:144-146` |
| 备份导入取消 | `if (error is CancellationException) throw error` | `BackupRoutes.kt:149` |
| 读正文 | `Dispatchers.IO` | `ReadingRoutes.kt:188` |
| 书源体检 | `suspend fun healthCheck` | `SourceRepository.kt:91` |

**阻塞点**：`HttpClient.send()` 是**阻塞**调用（`SearchRoutes.kt:69-72` 注释），`withTimeout` **取消不掉**它 —— 所以任何"以为加了超时就安全"的推理都是错的，必须靠外层总量截止兜底。

---

## 4. 架构边界测试守住了什么、漏了什么

被测文件：`TEST:ArchitectureBoundaryTest.kt`（441 行，JUnit 4，零外部依赖，用「扫源码 + 显式基线 + 断言相等」实现 ArchUnit 等价效果 —— 见 `:13-20`）。

### 4.1 六条判据（守住了什么）【事实】

| # | 判据 | 断言方式 | 行号 |
|---|---|---|---|
| 1 | `java` 桥暴露面 == `BRIDGE_WHITELIST`（68 个方法名） | **完全相等**（多一个红 = 未登记就扩面；少一个红 = 删了桥方法没同步） | `:60-80`、白名单 `:410-441` 一带 |
| 2 | `model/` 不得 import 其它 `io.legado.*` 包 | 实测 0，**零基线** | `:82-97` |
| 3 | `rules/` 不得 import `data`/`source`/`http` 的**具体实现类** | 基线 `RULES_CONCRETE_BASELINE`，**现已清零**（25→0，五轮端口化的成果） | `:99-121`、基线 `:441` |
| 4 | `http/` 只能被 `http/` 自身与组合根 import（14 个包一律不得 import `io.legado.http.*`） | **零基线、不设豁免** | `:123-143`、扫描面 `:305-311` |
| 5 | engine（`rules`/`content`/`localbook`/`source`）不得依赖 infra（`data`/`cache`/`ai`/`ops`/`tts`/`backup`/`subscription`/`reading`） | 基线 4 条（按**文件**记账），断言相等，基线只许单调缩小 | `:145-173`、基线 `:445-456` 一带 |
| 6 | 包间不得有 2-环 | 基线 4 对 + **空转哨兵**（边数 <20 即红） | `:175-202`、基线 `:378-388` |

**判据 6 的空转哨兵值得单独记**【事实】：`:390-397` 注释写「少了 `(?m)`，`^` 只匹配位置 0，`findAll` 一条边都扫不到，而空集合恰好满足『没有 2-环』—— 判据会变成永远绿的摆设。本判据第一次写完就是这个样子（报 0 失败，实测却有 4 对环），所以配套加了 `edges.size >= 20` 的空转哨兵」。

### 4.2 它没守住什么（举反例）【事实】

#### 反例 1 · 组合根整包被排除 → `StaticWeb.kt` 里的业务路由无人管

`ArchitectureBoundaryTest.kt:212-215` 注释：「组合根（`package io.legado`，取不到一级子包）**整包排除** —— 它装配一切本来就是职责」。实测 `root ↔ {cache,data,http,model,ops,port,rules,subscription,tts}` 全部双向。
**具体后果**：`BE:StaticWeb.kt:177-237` 在根包注册了 6 条 `/brand` 业务端点（`GET/PUT/DELETE /brand`、`GET/POST/DELETE /brand/icon`），它们**不在 `http/` 下、不在任何 `*Routes.kt` 里、不在 `/api` 前缀下**。于是同时躲过了：
- 判据 4（不扫组合根）
- `web/test/ApiCatalog.test.ts`（只扫 `http/**/*Routes.kt`，且假定全部挂在 `/api` 之下，见 `product/web/test/ApiCatalog.test.ts:20-40`）
- `agent-api.json`（实测 `grep -c brand` = **0**，144 条目录里一条都没有）

#### 反例 2 · 只查 2-环，看不见 3-环【推断，基于实测边集】

当前边集下 `{data, rules, ops}` 构成一个 3-环：`data→rules`（`SourceRepository.kt:11`）→ `rules→ops`（`RuleRunner.kt:3,52`）→ `ops→data`（`ops/LogService.kt` 调 `clearLogEntries`）。它今天"看得见"纯属巧合 —— 因为 `data↔ops` 本身就是被登记的 2-环。一旦有人按 §1.3 环 3 的建议把 `LogEntry` 移进 `model/` 断掉 `data↔ops`，判据 6 会**保持绿**，而真实的 `data→rules→ops→data` 环仍然存在。
（本轮已穷举当前边集的全部 3-环，未发现"完全不含任何已登记 2-环"的 3-环，所以这是**结构缺陷而非现存漏报**。）

#### 反例 3 · `http → data` 的 DAO 直连不在任何判据的射程内

判据 4 只关心「谁 import 了 `http`」，不关心「`http` import 了什么」。于是 `ReadingRoutes.kt:12-22`（11 条 DAO 函数）、`TocRulesRoutes.kt:12`（`clampShelfProgress`）这类**绕过 Repository、直接改表**的写法完全合规。

#### 反例 4 · 判据 3 的"清零"是扫 `data|source|http` 的**具体类**，不管顶层扩展函数

`RULES_CONCRETE_IMPORT` 正则（`:289`）是 `^import\s+io\.legado\.(data|source|http)\.([A-Za-z][A-Za-z0-9_]*)` —— 只按首字母大写匹配，即**只认类名**。若 `rules/` 某天 `import io.legado.data.saveProgress`（小写顶层扩展），正则命中不了，判据 3 保持绿。【事实】当前 `rules/` 对 `data` 实测 0 条，所以不是现存洞，是**守卫口径的洞**。

#### 反例 5 · `ai/` 空目录仍在判据名单里

`:307` 的 `API_LAYER_CALLERS` 与 `:313` 的 `INFRA_PACKAGES` 都写着 `"ai"`，而该目录**已无 .kt**（`find ai -name '*.kt'` 空）。判据对一个不存在的目录做 `Files.walk`，静默 0 命中。

#### 反例 6 · 完全不覆盖前端与跨端契约

判据只扫 `app/src/main/kotlin`。前后端 DTO 一致性靠的是**另一套**东西：`web/test/ApiCatalog.test.ts`（路径/方法/写门三个维度）—— 它**不比对字段形状**（见 §5）。

### 4.3 与文档的漂移【事实】

- `product/app/build.gradle` 的注释写「端点计数以 `agent-api.json` 为准（当前 **165 条 / 19 组**）」，实测 `count` = **144**、AGENTS.md 也写 144/18。注释自己都说「不抄数字 —— 本注释曾长期停在 141 端点」，结果**它又抄了一个错的**。
- `ArchitectureBoundaryTest.kt:44` 的分层表述是 `domain ← engine ← infra ← api`，但 `port/` 未被任一常量列为 domain 成员（`INFRA_PACKAGES` 不含 `port`，`ENGINE_PACKAGES` 也不含）——【未确认】判据 5 实际把 `port` 当哪一层。

---

## 5. 前后端契约耦合分析（含不一致实例）

### 5.1 前端调用面 ↔ 后端路由映射【事实】

`FE:lib/api/domains/` 共 7 个域、**103 条**去重的 `/api/*` 路径；后端 `agent-api.json` **144 条**（110 条去重路径）。

| 前端域 | 文件 | 主要覆盖的后端路由组 | 路径条数 |
|---|---|---|---|
| `reader.ts` | 478 行 | `/bookshelf*`、`/reading-progress`、`/reading-log`、`/notes`、`/book/image*`、`/book/media`、`/covers*`、`/replace-rules*`、`/books/toc-rules*`、`/books/reparse-local` | 39 |
| `sources.ts` | 305 行 | `/sources*`（含 `/{id}/browser/*`、`/{id}/login-*`、`/{id}/validate`、`/{id}/debug`）、`/cookies*`、`/subscriptions*`、`/explore*` | 37 |
| `search.ts` | 203 行 | `/search`、`/books/{details,chapters,content,content-refresh,reviews}`、`/explore*`、`/book-search`、`/rss/*` | 15 |
| `system.ts` | 79 行 | `/about*`、`/catalog`、`/changelog`、`/diagnostics`、`/logs`、`/server*` | 9 |
| `backup.ts` | 43 行 | `/backup/*` | 5 |
| `prefs.ts` | 25 行 | `/ui-prefs` | 1 |
| `brand.ts` | 19 行 | **`/brand*`（无 `/api` 前缀，6 条）** | 5 |

#### 5.1.1 前端调了但后端不存在【事实】

脚本比对（103 FE 路径 vs 110 BE 去重路径，`{}`/`:p` 归一化）后**只剩 1 条**：`/api/covers/<key>` —— 位于 `FE:lib/api/domains/reader.ts` 的**注释**里（写法是占位符 `<key>` 而非 `${…}`），不是真实调用。**结论：前端无悬空调用。**

#### 5.1.2 后端有但前端不调（10 条）【事实】

| 后端端点 | 谁在用 / 为何不在 domains 里 |
|---|---|
| `/api/backup/export` | `FE:plugins/backup/BackupPage.tsx:213`，走 `requestBlob` 而非 `domains/*` |
| `/api/search/stream` | `FE:lib/api/domains/search.ts:39` / `FE:lib/api/index.ts:98`，走原生 `WebSocket` |
| `/api/tts/session/{id}/audio`、`/events` | 走 `<audio src>` / EventSource，非 fetch |
| `/api/books/local/asset` | 走 `<img src>` |
| `/api/replace-rules/export` | 走下载链接 |
| `/api/ui-prefs/{key}` | **前端确实没用**（`prefs.ts` 只调 `/api/ui-prefs` 整体） |
| `/api/sources/{id}/browser/res`、`/submit` | 服务端 WebView 代理自用（`WebViewProxy` 抓子资源），不是前端调用 |
| **`/api/books/content-process`** | **孤儿端点**：`grep -rn content-process FE/` = **0 命中**。它写/删 `ContentProcess`（`ReadingRoutes.kt:232`），消费方是 2026-11-17 被移出产品的 AI 闭环前端。后端仍在注册、仍占 144 条目录的一格 |

### 5.2 共享契约的实际情况：**手写两份，无生成器、无共享 schema** 【事实】

- 后端：Kotlin `@Serializable data class`，分散在 `BE:model/` 7 个文件（`SystemModels.kt`/`SourceModels.kt`/`DiscoveryModels.kt`/`ReadingModels.kt`/`BookshelfModels.kt`/`ReplaceRuleModels.kt`/`BackupModels.kt`），另有一个漏在 `BE:ops/LogService.kt:178`。
- 前端：`FE:lib/api/types.ts`（932 行，86 个 `export type`）。
- **没有任何代码生成**（无 openapi/无 ktlint 导出），唯一机械保障是 `web/test/ApiCatalog.test.ts`，而它只比 **method + path + 是否写**，**不比字段**。

**量化（脚本实测）**：后端 `@Serializable data class` **184 个**，前端 `export type` **86 个**；**同名可比的只有 57 个**，其中 4 个有字段差；另有 **127 个后端类**在前端完全没有对应类型（多为 request-only 或内部类型），**29 个前端类型**在后端无同名类（多为改名：`BookshelfWrite`↔`BookshelfWriteRequest`、`BrandInfo`↔`Brand`，或 AI 遗留：`AgentChatMessage` 等 16 个）。

#### 不一致实例（≥3，两侧 file:line）

**实例 1 · `/api/books/content` 有两份手写形状，且其中一份丢了 `mediaUrl`**

| 侧 | 内容 |
|---|---|
| 后端（唯一真源） | `BE:model/ReadingModels.kt:45-53` —— `ChapterContent(title: String?=null, content: String, mediaUrl: String?=null)`；`mediaUrl` 注释：「书源正文 JS 给 `yp_url` 赋值时填这个；前端据此渲染播放器」 |
| 前端 A | `FE:lib/api/domains/search.ts:99-103` —— 内联匿名类型 `{ title?: string; content: string; mediaUrl?: string }` ✅ 与后端一致 |
| 前端 B | `FE:lib/offlineStorage.ts:502` —— `fetchChapterContent: (chapterUrl) => Promise<{ title?: string \| null; content: string }>` ❌ **无 `mediaUrl`** |

**后果**【事实】：离线批量下载（`downloadChaptersToOffline`，`offlineStorage.ts:498`）落盘的章节**结构上不带 `mediaUrl`**；`FE:features/reader/ReaderScreen.tsx:679-686` 因此必须自己写一段兜底嗅探，注释原文：「优先用服务端给的 `mediaUrl`；离线缓存没有它，但音频源的 `content` 本身就是那串地址，故兜底」。**同一 DTO 两个形状，逼出一个启发式补丁。**

**实例 2 · `BookDetails.alternateSources` 前端声明、后端从不发送**

| 侧 | 内容 |
|---|---|
| 后端 | `BE:model/ReadingModels.kt:6-20` —— `BookDetails` 11 个字段（`sourceId`…`imageStyle`），**没有 `alternateSources`**；`POST /api/books/details` 直接 `respond` 引擎返回值（`BE:http/ReadingRoutes.kt:74`：`runner.details(...)`） |
| 前端 | `FE:lib/api/types.ts:122` —— `alternateSources?: SearchResult[]` |

**谁在读**【事实】：`FE:features/reader/ReaderOverlays.tsx:102`（`knownAlternateSources={details.alternateSources}`）、`FE:main.tsx:502,510`、`FE:features/reader/ReaderScreen.tsx:1174`。
**真相**：该字段由前端**自己**注入 —— `FE:lib/searchStore.ts:153-157` 在 `loadSourceBook` 里 `safeDetails = {...details, alternateSources: …}`。
**结论**：`BookDetails` 一个类型同时承担「wire DTO」与「客户端富化后的视图模型」两个角色，**类型系统无法区分**；任何照类型写后端的人都以为该发这个字段。

**实例 3 · `AboutInfo.ai` 声明了一个没人发的字段（AI 迁移遗留）**

| 侧 | 内容 |
|---|---|
| 后端 | `BE:model/SystemModels.kt:31-37` —— `AboutInfo(title, version, repository, build = "0")`，4 字段无 `ai`；`GET /api/about` 就这 4 个（`BE:http/system/SystemRoutes.kt:106-108`） |
| 前端 | `FE:lib/api/types.ts:37-38` —— `ai?: boolean`，注释写「AI 能力面是否启用（`/healthz` 的 `ai`）；2026-11-17 起产品默认关」 |

**后果**【事实】：`grep` 全前端**无任何读取点**（`info.ai`/`about.ai` 均 0 命中）→ 死字段。它记录了一次**契约移除没同步到类型**的迁移（AI 从 `http/` 挪到 `product/experimental/ai/` 时 `/api/agent` 整组不再注册，见 `AGENTS.md` §8.2）。

**实例 4 · `SourceRecord.weight` 后端有、前端没有（但无害，值得记）**

| 侧 | 内容 |
|---|---|
| 后端 | `BE:model/SourceModels.kt:301-312` —— `SourceRecord(id, json, version, updatedAt, weight: Int = 0)` |
| 前端 | `FE:lib/api/types.ts:24-28` —— `SourceRecord = { id; json; version; updatedAt }`，**无 `weight`** |

**但**【事实】`weight` 不是独立列，而是从 payload 里取出来的：`BE:data/SourcesDao.kt:129` 用 `coalesce(json_extract(payload,'$.weight'),0)`。前端在书源编辑器里直接编辑 payload 里的 `weight`（`FE:features/source-editor/bookSourceFields.ts:681`、`SourceEditorPanel.tsx:20`）。所以**不丢数据**，只是「后端暴露了一个前端不认的只读派生字段」。

**实例 5（合法但需登记）· `BookNote.stale` 前端专有**

`FE:lib/api/types.ts:182-183` 有 `stale?: boolean`，注释明写「只在前端：正文改过、这条批注的位置已对不上原文（`notes/reanchor.ts` 标出来的，**不落库**）」。后端 `BE:model/ReadingModels.kt:103-124` 无此字段 —— 这是**设计如此**，但它与实例 2 混在同一种"类型声明"里，读代码的人分不出来。

### 5.3 类型漂移风险点（结论）【推断，依据上述实测】

1. **`Long` → `number` 全线降级**：后端凡是 `Long`（`version`/`updatedAt`/`id`/`groupId`/`bytes`/`seconds`/`timeoutMillisecond`），前端一律 `number`（IEEE-754 双精度，安全整数上限 2^53）。当前值域（毫秒时间戳、行号、条数）远未触顶，**没有实例风险**；但 `.ts` 侧无法表达这个约束。
2. **可空性漂移方向单向**：后端 `val x: T = default`（非空）↔ 前端 `x?: T`（可缺）。这一路方向安全（前端更宽松）；反过来（后端必填、前端可选）才会炸，本轮**未发现**。
3. **`String` 枚举被前端收紧成 union**：`BookshelfItem.cacheState` 后端是 `String = "idle"`（`BE:model/ReadingModels.kt:255`），前端是 `'idle'|'caching'|'ready'|'failed'`（`FE:lib/api/types.ts:224`）。**后端可以发出第五种值而 TypeScript 编译期毫不知情** —— 这是最典型的一类"手写两份"风险，且当前无任何运行时校验。
4. **request-only 类型 100% 靠人对齐**：127 个后端类在前端无对应（`ContentRequest`/`BookshelfWriteRequest`/`BatchMarkReadRequest`…），前端用**内联对象字面量**发这些请求（如 `FE:lib/api/domains/search.ts:110` 直接 `JSON.stringify({sourceId, chapterUrl, bookUrl, force})`）。后端 `ignoreUnknownKeys = true`（`BE:Application.kt:226`）会把**拼错的可选字段静默忽略**，不会 400。

【建议】重建时**必须**用 schema-first（OpenAPI 或 kotlinx 导出 TS），并把 `cacheState` 这类字符串枚举改成 sealed/enum 的生成类型；否则「167 条路径 / 184 个类」的对齐成本会随版本线性上升。

---

## 6. 外部依赖清单与风险

### 6.1 后端（`product/app/build.gradle` `dependencies{}` 段，逐条）【事实】

| 依赖 | 版本 | 用途 | 维护状态 | 替代风险 |
|---|---|---|---|---|
| `io.ktor:ktor-server-netty` | 3.4.3 | **主引擎**（2026-11-17 从 CIO 换过来，解决停读客户端占线程） | 活跃 | 低；但**两套引擎并存**（见下） |
| `io.ktor:ktor-server-cio` | 3.4.3 | 已非默认引擎；`build.gradle` 注释：「`stalled-client-check` 对照实验要用它；删掉只需改这一行与 `Application.kt`」 | 活跃 | **应删**（装着一个不跑的引擎） |
| `io.ktor:ktor-server-core` | 3.4.3 | 核心 | 活跃 | 低 |
| `io.ktor:ktor-server-content-negotiation` | 3.4.3 | JSON 协商 | 活跃 | 低 |
| `io.ktor:ktor-serialization-kotlinx-json` | 3.4.3 | kotlinx JSON 适配 | 活跃 | 低 |
| `io.ktor:ktor-server-sessions` | 3.4.3 | 会话 | 活跃 | 【未确认】实际用到多少（`LOCAL_TTS_OWNER` 是常量而非 session） |
| `io.ktor:ktor-server-websockets` | 3.4.3 | `/api/search/stream` | 活跃 | 低 |
| `io.ktor:ktor-server-status-pages` | 3.4.3 | 统一错误页 | 活跃 | 低 |
| `io.ktor:ktor-server-compression` | 3.4.3 | 仅压 JSON（书源清单 ~1MB） | 活跃 | 低 |
| `org.xerial:sqlite-jdbc` | 3.49.1.0 | **唯一存储**（无 ORM、手写 SQL） | 活跃 | 低（但要自己管连接池，见 §3.1） |
| `org.jsoup:jsoup` | **1.18.3** | HTML 解析（CSS/XPath 基础） | 活跃 | 低；**但版本与版本目录冲突**，见 §6.3 |
| `cn.wanghaomiao:JsoupXpath` | **2.5.1** | `@xpath` 方言（与上游 Legado 同款） | 低活跃（2019 后几乎停更） | **高**：这是最该考虑自研/替换的一个；且版本与目录冲突（目录写 2.5.3） |
| `com.jayway.jsonpath:json-path` | **2.9.0** | `$.` JSONPath 规则 | 活跃 | 低；目录写 3.0.0（冲突） |
| `org.mozilla:rhino` | 1.8.0 | **JS 沙箱运行时**（`JsSandbox`/`JavaPackages`） | 活跃 | 中：上游 Legado 用的是 HtmlUnit fork（目录里有 `htmlunit-core-js = 5.3.0-legado.3`），两者**行为不同**，黄金测试是唯一护栏 |
| `org.slf4j:slf4j-simple` | 2.0.16 | 日志门面实现 | 活跃 | 低（但项目自研了 `ops/LogService`，两层并存） |
| `io.ktor:ktor-server-test-host` | 3.4.3 | 测试 | 活跃 | – |
| `io.ktor:ktor-client-content-negotiation` | 3.4.3 | 测试 | 活跃 | – |
| `libs.junit` → `junit:junit` | 4.13.2 | 测试（**全仓 JUnit 4，无 JUnit 5**） | 维护模式 | 低；注释 `build.gradle` 明确「不能写 `useJUnitPlatform`」 |

**出站 HTTP 栈（不在依赖表里，但必须记）**【事实】：`java.net.http.HttpClient` 是**唯一**出站栈（15 个文件：`rules/RuleHttp.kt`、`rules/RuleRunner.kt`、`ops/GuardedHttpClient.kt`、`ops/NetworkSecurity.kt`、`ops/PinnedProxy.kt`、`ops/UpdateCheck.kt`、`cache/CoverCache.kt`、`source/WebViewProxy.kt`、`source/ExternalBrowserLogin.kt`、`subscription/SubscriptionService.kt`、`tts/EdgeTtsService.kt`、`http/MediaRoutes.kt`、`http/ReplaceRulesRoutes.kt`、`DesktopLauncher.kt`、`TextDecoding.kt`）。**零 Ktor client、零 OkHttp 依赖** —— 但 `BE:rules/JavaPackages.kt:626-637` **为书源 JS 模拟了一套 okhttp3**（`new Packages.okhttp3.OkHttpClient()` / `Request.Builder`），所以「书源作者以为的 HTTP 栈」与「真实 HTTP 栈」是两套。这是重建时 JS 兼容层最容易被忽略的一块。

### 6.2 前端（`product/web/package.json`）【事实】

| 依赖 | 版本 | 用途 | 维护 | 风险/备注 |
|---|---|---|---|---|
| `react` / `react-dom` | 19.1.0 | UI | 活跃 | – |
| `vite` | 6.3.5 | 构建 | 活跃 | **放在 `dependencies` 而非 `devDependencies`**（会在生产安装里被拉下来） |
| `typescript` | 5.8.3 | 类型 | 活跃 | 同上 |
| `@vitejs/plugin-react` | 4.6.0 | Vite 插件 | 活跃 | 同上 |
| `@material/material-color-utilities` | ^0.4.0 | MD3 主题色算法（`ui/color/`） | 低活跃（官方已基本冻结） | 中：主题是产品差异点，建议重建时**冻结版本并保留一份实现** |
| `hls.js` | ^1.7.3 | 音频/HLS 播放（TTS/媒体） | 活跃 | 低 |
| `vite-plugin-pwa` | ^1.3.0 | Service Worker（`legado-covers` SWR 30 天） | 活跃 | 中：SW 缓存策略与 §2.7 三层缓存耦合 |
| `c8` | ^12.0.0 | 覆盖率 | 活跃 | – |
| `tsx` | ^4.23.12 | **测试 runner 的执行器**（`test/run-all.ts`，非 vitest） | 活跃 | 低，但记得「别用 npx vitest」 |
| `puppeteer-core` | ^25.11.0 | E2E 压力测试（`test/e2e-browser-stress.ts`） | 活跃 | 低 |
| `@types/node` | ^26.4.0 | 类型 | – | 【未确认】`@types/node@26` 与 Node 20 引擎要求（`product/package.json` `engines.node>=20`）是否匹配 |

**没有**：UI 组件库、CSS 框架、状态库（自研 `lib/*Store.ts`）、HTTP 库（原生 `fetch` 包在 `lib/api/client.ts` 的 `fetchWithMetrics`）。前端依赖面**极窄**，这是重建的利好。

### 6.3 版本落后 / 冲突 / 重复【事实，本轮最脏的一块】

#### 冲突 1 · `gradle/libs.versions.toml` 是**旧 Android 工程遗留**，且只被用到 3 处

`libs.versions.toml` 声明了 AGP 8.13.2、androidx、glide、room、media3、exoplayer、firebase-bom、compose、soraEditor、zxing… 共 **~60 个 version + ~90 个 library**，全部是**安卓端**的东西。而 `app/build.gradle` 里只用了三处：`libs.plugins.kotlin.jvm`、`libs.plugins.kotlin.serialization`、`testImplementation libs.junit`。其余**全部用硬编码字符串**（`"io.ktor:ktor-server-netty:3.4.3"` 等）。

**后果**：版本真源被劈成两半，且那个"目录"里 95% 是死的。

#### 冲突 2 · 同一个库在「目录」与「build.gradle」里版本不同（3 例）

| 库 | `libs.versions.toml` | `app/build.gradle` | 注释怎么说 |
|---|---|---|---|
| `jsoup` | **1.16.2**（带 `#noinspection NewerVersionAvailable` + 「issue #3811，不要更新版本，新版引入破坏性变更」） | **1.18.3** | 目录明确要求钉 1.16.2，实际跑的是 1.18.3 |
| `JsoupXpath` | **2.5.3** | **2.5.1** | – |
| `json-path` | **3.0.0** | **2.9.0** | – |

【推断】这些不匹配今天**没有造成故障**（构建用的是 `build.gradle` 里的值，目录值根本没被解析成依赖），但它让「想查版本时该信哪个文件」这个问题没有答案。

#### 重复 1 · 两套 HTTP 引擎

`ktor-server-netty`（主）+ `ktor-server-cio`（对照实验用，注释自认「删掉只需改这一行」）。→ **该删**。

#### 重复 2 · 三套 HTTP 栈的"认知"

真实栈 = `java.net.http`；测试栈 = `ktor-client`（仅 test-host/content-negotiation）；**书源 JS 看到的栈 = 模拟的 okhttp3 + 模拟的 hutool**（`BE:rules/JavaPackages.kt`）。三者语义不同（重定向策略、Cookie、GZip 都各自实现），是 JS 兼容层最大的隐性风险。

#### 重复 3 · 两套 JSON 处理配置，共 **12 个** `Json { }` 实例

`BE:Application.kt:226`（`ignoreUnknownKeys+explicitNulls=false+encodeDefaults=true`）、`BrandManifest.kt:30`、`BrandStore.kt:49`、`source/SourceCodec.kt:44`、`rules/RuleRunner.kt:118`、`rules/SearchFlow.kt:56`、`ops/UiPrefsStore.kt:73`、`ops/UpdateCheck.kt:54`、`localbook/TxtTocRule.kt:51`、`http/ReplaceRulesRoutes.kt:139`、`http/SourcesRoutes.kt:755`（`debugJson`，只因 `encodeDefaults` 必须开）、外加自研的 `content/LooseJson.kt`（把书源里不规范的 JS 对象字面量规范化成严格 JSON，注释称「4,876 源里严格 JSON 失败 1,571 处」）。
**风险**：`encodeDefaults` 在 `Application.kt:222-225` 有长注释解释「不开会把取值等于默认值的字段整个省掉」—— 说明**每新增一个 `Json{}` 都可能重踩一次**。

#### 重复 4 · 两套 HTML 解析路线

`jsoup`（CSS/结构）+ `JsoupXpath`（`@xpath` 方言，独立库、几乎停更）+ `BE:rules/JsoupBridge.kt`（JS 侧 jsoup 模拟）。三条路都活着，且 `RuleRunner` 要按规则前缀分派到不同路线。

#### 落后 1 · `build.gradle` 注释与真实端点数的漂移

注释写「当前 **165 条 / 19 组**」，实测 `count`=**144**、AGENTS.md 写 144/18。同一行注释自己承认「本注释曾长期停在 141 端点」—— **它又错了**。

#### 落后 2 · 前端 `@types/node@^26` vs `engines.node>=20`

【未确认】未核实 `@types/node` 26 是否要求 Node ≥22 的类型面；本轮只记录矛盾存在。

### 6.4 对外部依赖的判断【建议】

**必须留（换掉等于重写核心）**
1. `sqlite-jdbc` —— 数据模型、`reading_progress`/`book_shelf`/`source` 的 SQL 全是手写的，没有 ORM 可替换。
2. `kotlinx.serialization` + Ktor 全家桶 —— 但**建议把 Ktor 的版本与配置收进一处**（12 个 `Json{}` 合 1～2 个）。
3. `jsoup` —— 规则引擎的 HTML 基础。建议**明确钉一个版本并在 build.gradle 与目录之间二选一**。
4. `rhino` —— JS 沙箱。可留，但**必须保留 `GoldenRuleTest` 逐字节比对**；上游用的是 HtmlUnit fork，切换前要跑真实语料抽样。

**该换/该删**
1. `ktor-server-cio` —— 删（自认「删掉只需改这一行」）。
2. `JsoupXpath 2.5.1` —— 停更库，且只支持一个方言。建议重建时评估：要么自研 XPath→jsoup 适配，要么明确接受它并写死版本。
3. `gradle/libs.versions.toml` —— 把安卓遗留的 ~150 条声明**整体删除**，只保留实际在用的（或干脆全删、全用硬编码 + 一个 versions 常量块）。
4. `slf4j-simple` —— 与自研 `ops/LogService`（落库 + 去重 + 文件）并存，建议只留自研那套。
5. `jsoup` 的版本冲突 + `JsoupXpath`/`json-path` 的目录冲突 —— 立即统一。
6. 前端 `vite`/`typescript`/`@vitejs/plugin-react` 移进 `devDependencies`。

---

## 7. 耦合来源排序（哪些耦合点最阻碍重建，为什么）

| # | 耦合点 | 证据 | 为什么最阻碍重建 | 断法 |
|---|---|---|---|---|
| **1** | **`http/` 同时是"路由层 + 业务编排层 + DAO 调用者"** | `ReadingRoutes.kt:12-22`（11 条 DAO import）；`http/` 有 19 个文件、触摸 15 个包、103 条 `model` import + 81 条 `data` import | 换协议（CLI/桌面 IPC）时**没有任何可复用的服务层** —— 业务逻辑在 Ktor 的 `Route` lambda 里。`ReadingRoutes.kt` 的"取正文"整段（140-195）就是业务规则，不是路由 | 把 `ReadingRoutes`/`ShelfRoutes` 里的编排抽成 `reading/`、`bookshelf/` 服务；路由只做 verify→call service→respond |
| **2** | **`data ↔ source` 跨层环（Cookie 域）** | `Database.kt:41-44`、`CookieDao.kt:4`、`db/CookieUtil.kt:4` ↔ `WebViewProxy.kt:22-25`、`ExternalBrowserLogin.kt:21-22` | `data`（存储）与 `source`（书源接入）**无法分模块**：拆分时两边互相要对方类型，只能整块搬。这是唯一跨层的真环 | 把 Cookie 的「域匹配判定」下沉到 `port/CookieStore`（判据 3 已用同样手法清零过 25 条横穿，可照抄） |
| **3** | **DTO 与业务类型混在非 `model/` 包，直接制造包环** | `ops/LogService.kt:178`（`LogEntry`）被 `data/Database.kt:34`、`data/LogDao.kt:3` import；`rules/RuleProcessor.kt` 的 `RuleResult` | `data ↔ ops` 环的**唯一成因**是 DTO 放错位置，不是能力依赖。改一行 import 位置就能断 | `LogEntry` → `model/`；`RuleResult` → `model/` |
| **4** | **进度写入 6 处 + 单调性守卫只有 1 处有** | §2.4.1 全表；对比 `ReadingDao.kt:36`（无守卫）与 `ImportDao.kt:159`（有守卫） | 重建时最容易"照抄一个写点"就以为完事，然后丢掉 `clampShelfProgress` 的边界语义与备份导入的 `paragraph_anchor=null` 语义 —— 表现为"换规则后进度卡在 900 章"或"恢复后跳到错行" | 收成**一个** `ReadingProgressService`，内部按来源（reader/import/clamp）分支，统一守卫 |
| **5** | **契约无单一真源：184 后端类 vs 86 前端 type，靠人肉对齐** | §5.2；`ApiCatalog.test.ts` 只比 method/path/写门 | 字段级不一致**不会被任何门禁发现**（实例 1 的 `mediaUrl` 缺失靠 `ReaderScreen.tsx:679-686` 的启发式兜底才没炸）。重建等于把 184 个类再手抄一遍 | schema-first 生成 TS |
| **6** | **`root`（组合根）把业务塞进 `StaticWeb.kt`** | `StaticWeb.kt:177-237`（6 条 `/brand` 端点） | 它同时躲过判据 4、`ApiCatalog.test.ts`、`agent-api.json` 三道门。**"144 条端点"这个数字本身就不是全部暴露面** | `/brand` 挪进 `http/BrandRoutes.kt` 挂在 `/api` 下（或明确声明为非 API 的静态资源面并纳入目录） |
| **7** | **判据 6 只查 2-环** | `ArchitectureBoundaryTest.kt:378-388` | 修好 #3 之后 `data→rules→ops→data` 会变成**看不见的环**，架构会往"看起来干净、实际耦合"的方向滑 | 把环检测改成 Tarjan 强连通分量（SCC），基线记 SCC 成员集 |
| **8** | **单写连接 + 事务内禁 IO，但仍有 DAO 自己管 `autoCommit`** | `ConnectionPool.kt:19,70-74`；`Database.kt:125-134`（"0.2.35 批量删书事故"） | 任何"把多步收进一个事务"的重构都会**静默失效**（内层 `finally` 复位 `autoCommit` → 外层当场提交）。这是最难在 code review 里看出来的坑 | 全面清理 `ShelfDao`/`CacheDao` 里自管 `autoCommit` 的老函数 |
| **9** | **`rules/` 与 `content/` 互相当底层** | `ContentProcessor.kt:7` ↔ `RuleRunner.kt:46-48`、`RuleUrlSupport.kt:3` | 文本加工语义（`LooseJson`、`applyReplaceEntry`）被两边都用，拆开时必须先抽一个 `text/` 原语包 | 抽 `io.legado.text`（纯函数：宽松 JSON、替换、正文清洗） |
| **10** | **外部依赖版本双源 + 停更库** | §6.3：`libs.versions.toml` 95% 死条目 + 3 处版本冲突 + `JsoupXpath` 停更 | 不是"耦合"，但会让"升级/替换"这件事在重建期无人敢碰 —— 尤其 `jsoup 1.16.2 vs 1.18.3`（目录注明 1.16.2 是为避 issue #3811 破坏性变更） | 删目录、统一版本、给 jsoup 升级补一条规则回归 |

---

## 8. 证据索引表

| ID | 结论 | 证据（相对 `E:\legadoQ-archive\`） |
|---|---|---|
| E01 | 16 包 + 组合根，`ai/` 已空 | `find product/app/src/main/kotlin/io/legado -type d`；`ls ai`（空） |
| E02 | 内部 import 共 605 条 | `grep -rn "^import io\.legado\." --include=*.kt` → 605 行 |
| E03 | `model/` 零反向依赖 | `grep "^import io.legado" model/` = 0；判据在 `product/app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt:82-97` |
| E04 | `data ↔ source` 环 | `data/Database.kt:41-44`、`data/CookieDao.kt:4`、`data/db/CookieUtil.kt:4` ↔ `source/WebViewProxy.kt:22-25`、`source/ExternalBrowserLogin.kt:21-22` |
| E05 | `cache ↔ data` 环 | `data/BookshelfRepository.kt:3-8`、`data/Database.kt:20`、`data/ShelfDao.kt:3` ↔ `cache/BookCacheService.kt:24-33`、`cache/CoverCache.kt:18-20` |
| E06 | `data ↔ ops` 环（DTO 放错） | `data/Database.kt:34`、`data/LogDao.kt:3` ↔ `ops/LogService.kt:174`、`ops/LogService.kt:178` |
| E07 | `content ↔ rules` 环 | `content/ContentProcessor.kt:7` ↔ `rules/RuleRunner.kt:46-48`、`rules/RuleUrlSupport.kt:3` |
| E08 | 判据 6 只查 2-环 + 空转哨兵 | `ArchitectureBoundaryTest.kt:175-202`、`:378-397` |
| E09 | 组合根被排除 + `StaticWeb` 自带业务路由 | `ArchitectureBoundaryTest.kt:212-215`；`product/app/src/main/kotlin/io/legado/StaticWeb.kt:177-237` |
| E10 | `agent-api.json` = 144 条，无 brand | `product/app/src/main/resources/agent-api.json`（`count=144`，`grep -c brand`=0） |
| E11 | `build.gradle` 注释写 165 条 | `product/app/build.gradle`（`verifyFramework` 上方注释） |
| E12 | `http` 直调 DAO 绕过 Repository | `http/ReadingRoutes.kt:12-22`、`http/MediaRoutes.kt:17-19`、`http/TocRulesRoutes.kt:12`、`http/ReplaceRulesRoutes.kt:15-19` |
| E13 | 搜索不落库 + 两级超时 | `http/SearchRoutes.kt:76,82,88-95,225-243,331-368` |
| E14 | 搜索流取消语义 | `http/SearchRoutes.kt:97-146`、`http/SearchSession.kt:30-33` |
| E15 | 书源导入事务边界 + 逐条容错 + 4 个缓存失效 | `data/SourcesDao.kt:312-358`、`data/Database.kt:221-226` |
| E16 | 目录 4s 超时与取消区分 | `http/ReadingRoutes.kt:89-138`（关键 `:118,:129-131`） |
| E17 | 正文缓存命中 + AI 覆盖 + force 语义 | `http/ReadingRoutes.kt:140-195` |
| E18 | 规则扩展点认领机制 | `rules/RuleProcessor.kt:16-30,57,90-99,104-114,124-143` |
| E19 | 进度写入 6 处 | `data/ReadingDao.kt:15-47`；`data/ShelfDao.kt:77-84,234-241,254-265,316-335`；`data/ImportDao.kt:150-166` |
| E20 | 进度单调守卫不对称 | `data/ReadingDao.kt:36`（无）vs `data/ImportDao.kt:159`（`where excluded.updated_at >= …`） |
| E21 | 服务端丢弃客户端 `updatedAt` | `web/src/lib/api/domains/reader.ts:172-176` → `data/ReadingDao.kt:16,46` |
| E22 | 前端 2 条进度入口 + 1 条死队列 | `web/src/features/reader/ReaderScreen.tsx:816-829`、`web/src/main.tsx:335-341`、`web/src/lib/offlineStorage.ts:447,462`（`enqueueOfflineProgress` 0 调用） |
| E23 | 备份导入单一事务 6 步 | `backup/BackupImporter.kt:238-272`（事务在 `:253`） |
| E24 | 备份导出流式不落盘 / 快照需重启 | `http/BackupRoutes.kt:83-115,182`、`:171-173` |
| E25 | TTS 链路 + 外部引擎 wss | `http/TtsRoutes.kt:27-150`、`tts/TtsSessionService.kt:47,110,141,194-243`、`tts/EdgeTtsService.kt:49` |
| E26 | 图片/封面三层缓存 + SSRF 闸门 | `http/MediaRoutes.kt:43-200` |
| E27 | 单写连接 + 全局写锁 + WAL | `data/db/ConnectionPool.kt:19,27-32,59-74` |
| E28 | 可嵌套事务 + 历史提交事故 | `data/Database.kt:113-160`（注释 `:125-134`） |
| E29 | 契约实例 1：`mediaUrl` 两形状 | `model/ReadingModels.kt:45-53` vs `web/src/lib/api/domains/search.ts:99-103` vs `web/src/lib/offlineStorage.ts:502`；补丁在 `web/src/features/reader/ReaderScreen.tsx:679-686` |
| E30 | 契约实例 2：`alternateSources` 后端不发 | `model/ReadingModels.kt:6-20`、`http/ReadingRoutes.kt:74` vs `web/src/lib/api/types.ts:122`；前端自注入 `web/src/lib/searchStore.ts:153-157`；读取点 `ReaderOverlays.tsx:102` |
| E31 | 契约实例 3：`AboutInfo.ai` 死字段 | `model/SystemModels.kt:31-37`、`http/system/SystemRoutes.kt:106-108` vs `web/src/lib/api/types.ts:37-38`（0 读取点） |
| E32 | 契约实例 4：`SourceRecord.weight` | `model/SourceModels.kt:301-312` vs `web/src/lib/api/types.ts:24-28`；派生自 payload `data/SourcesDao.kt:129` |
| E33 | 前后端路径比对：FE 无悬空；BE 10 条非 domains 消费 | 脚本比对 103 FE vs 110 BE；孤儿 `/api/books/content-process`（`http/ReadingRoutes.kt:232`，FE 0 命中） |
| E34 | DTO 数量差：184 后端类 / 86 前端 type / 57 同名 | 脚本抽取 `@Serializable data class` 与 `export type` 求交 |
| E35 | 12 个 `Json{}` 实例 | `Application.kt:226`、`BrandManifest.kt:30`、`BrandStore.kt:49`、`source/SourceCodec.kt:44`、`rules/RuleRunner.kt:118`、`rules/SearchFlow.kt:56`、`ops/UiPrefsStore.kt:73`、`ops/UpdateCheck.kt:54`、`localbook/TxtTocRule.kt:51`、`http/ReplaceRulesRoutes.kt:139`、`http/SourcesRoutes.kt:755`、`content/LooseJson.kt:19` |
| E36 | 依赖版本双源 + 3 处冲突 | `product/app/build.gradle` vs `product/gradle/libs.versions.toml`（jsoup 1.18.3/1.16.2；JsoupXpath 2.5.1/2.5.3；json-path 2.9.0/3.0.0） |
| E37 | 两套 Ktor 引擎 | `product/app/build.gradle`（`ktor-server-netty` + `ktor-server-cio`，后者注释自认可删） |
| E38 | 出站栈唯一是 `java.net.http`；okhttp3 只是 JS 模拟 | 15 文件 `java.net.http`；`rules/JavaPackages.kt:626-637`（字符串形式模拟） |
| E39 | 前端依赖面极窄，无 UI/CSS/状态/HTTP 库 | `product/web/package.json` |
| E40 | `enqueueOfflineProgress` 零调用 | `grep -rn enqueueOfflineProgress product/web/src` → 仅定义行 `offlineStorage.ts:447` |

---

## 9. 未确认事项

| # | 事项 | 为什么没确认 | 建议怎么确认 |
|---|---|---|---|
| U01 | `SearchRoutes.kt:289` 注释称「自己的工作独立 supervisor scope」，但同一函数内未见 `supervisorScope` | 只读了 `331-368` 窗口，未读全 `readableSearchResults`（`:189-198`）周围 | 读 `http/SearchRoutes.kt:185-230` 全段 |
| U02 | 判据 5 把 `port/` 算哪一层（`INFRA_PACKAGES`/`ENGINE_PACKAGES` 都不含它） | 只读常量定义，未读判据 5 的过滤逻辑全貌 | 读 `ArchitectureBoundaryTest.kt:145-175` |
| U03 | `ktor-server-sessions` 的实际使用面 | 只 grep 了依赖声明，未追 session 装配 | `grep -rn "install(Sessions" product/app/src/main` |
| U04 | `importLibraryOn` 是否在事务内触碰文件系统（违反 `Database.kt:132-134` 纪律） | 该函数 109-170 行，本轮只读了其中的 SQL 段 | 读 `data/ImportDao.kt:109-170` 全段 |
| U05 | 备份导入的 `cookies()` 是否真的只做 CPU 解密、无网络 | 只读了 `BackupImporter.kt:313-320` 注释 | 读 `BackupImporter.kt:315-380` |
| U06 | 前端 `@types/node@^26` 与 `engines.node>=20` 是否冲突 | 未查 `@types/node` 26 的 engines 声明 | 查 npm registry 或 `node_modules/@types/node/package.json`（禁读区外，可读） |
| U07 | 「一次搜索要对几千条记录求值」等性能口径 | 来自源码注释，未实测 | 属主控/性能审计员范围 |
| U08 | `product/experimental/ai/` 的依赖面（是否仍 import 主源码包） | 不在本任务审计范围（已不参与编译） | 若有需要另开一轮 |
| U09 | 4 条 engine→infra 基线是否真的都"不是能力依赖" | 判据注释如此声明（`ArchitectureBoundaryTest.kt:445` 一带），本轮未逐条验证调用点上下文 | 逐个读 `RuleRunner.kt:3,52`、`WebViewProxy.kt:21`、`ExternalBrowserLogin.kt:21` 的实际用法 |
| U10 | `reading_progress` 表列定义与 `positionVersion` 的迁移策略 | 只读了 `Schema.kt:44` 一行 | 读 `data/db/Schema.kt:44-60` + `db/Migration.kt:104` |
| U11 | 前端 `lib/api/index.ts` 与 `domains/*` 的重复导出面 | 只确认 `index.ts:274` 转发 `progress.save`，未全量比对 | `wc -l web/src/lib/api/index.ts` + 逐段 |
| U12 | 3-环穷举的完备性 | 基于 `imports.txt` 的 605 条边做人工+脚本穷举，未用图算法形式化 | 用 `networkx`/Tarjan 跑同样的边集 |

---

## 10. 覆盖率声明

### 10.1 后端（`product/app/src/main/kotlin/io/legado/`，123 个 `.kt`）

| 维度 | 覆盖 | 说明 |
|---|---|---|
| `import` 全量统计 | **123/123 文件（100%）** | grep 全扫，无抽样 |
| 包结构/文件数 | 16 包 + 组合根，100% | `find` |
| `ArchitectureBoundaryTest.kt` | 读 **~230/441 行（52%）**：表头 1-60、判据体 60-200 摘要、常量 285-441 | 未逐字读判据 1/3/5 的断言细节 |
| `http/`（19 文件） | 深读 **7 个**：`SearchRoutes`(53-150)、`ReadingRoutes`(57-200)、`ReadersRoutes`(20-80)、`ShelfRoutes`(250-290)、`BackupRoutes`(83-182)、`MediaRoutes`(40-200)、`TtsRoutes`(20-150)、`SourcesRoutes`(260-300)；其余（`Guard`/`RouteCatalog`/`StrictJsonConverter`/`Routes`/`Rss`/`Subscriptions`/`TocRules`/`ReplaceRules`/`Prefs`/`SearchSession`/`system`）**只 grep** | 路由层 **42%** 深读 |
| `data/`（20+4 文件） | 深读 **6 个**：`ReadingDao`(1-90)、`ShelfDao`(70-110/236-270/330-340)、`Database`(95-175/221-233)、`ConnectionPool`(全 95 行)、`SourcesDao`(312-364)、`ImportDao`(135-170)；其余 18 个**只 grep 符号** | 存储层 **25%** 深读 |
| `rules/`（26+ 文件） | 深读 `RuleProcessor.kt` 全 143 行；`RuleRunner`/`JsSandbox`/`JavaPackages` **只 grep 定位**（1679/2066/1361 行，按纪律不整读） | 规则层 **约 5%** 正文 |
| `backup/` | 深读 `BackupImporter`(238-320)；`BackupExporter`/`BackupStore`/`LegacyBackup` **未读** | **25%** |
| `tts/` | `TtsSessionService` 只 grep 函数签名 + 读 40 行；`EdgeTtsService` 读 40-100 | **约 15%** |
| `cache/` `ops/` `source/` `port/` `content/` `localbook/` `subscription/` `reading/` `model/` | `reading/ReadingRepository` 读 60 行；`ops/LogService` 读 170-195；`content/LooseJson` 读 1-30；`model/` 按需读 6 个类定义；其余**只 grep import 与函数名** | **约 10-20%/包** |
| 7 条调用链 | **7/7 覆盖**（搜索/导入/目录+正文/进度/备份/TTS/图片），每条有真实函数名 + file:line | 主任务完成 |

### 10.2 前端（`product/web/src/`）

| 维度 | 覆盖 | 说明 |
|---|---|---|
| `lib/api/domains/*` | **7/7 文件（100%）** 路径全量提取 | grep 提取，非整读 |
| `lib/api/types.ts`（932 行） | **约 25%**：按需读 20 个类型窗口 + 脚本全量比字段 | 用脚本补足人工未读部分 |
| 前端 API 调用点（progress/image/search 三族） | 100% 定位（grep） | – |
| 阅读器 `ReaderScreen.tsx`（2346 行） | **约 1%**（只读 `:808-840` 与 grep 命中的 5 个点） | 按纪律不整读；进度语义由 `lib/api` + backend 侧确定 |
| `lib/offlineStorage.ts` | 读 `:440-540`（进度队列 + 章节下载） | **约 15%** |
| 其余 `features/**`、`lib/**` | **未系统覆盖**，只在证据需要处 grep | 属前端审计员范围 |

### 10.3 本轮**未覆盖**的完整维度

1. **`rules/` 规则求值内核**（`RuleRunner` 1679 行 / `JsSandbox` 2066 / `JavaPackages` 1361）—— 只到"分派机制"层面，未做取值逻辑、字符集、限读、JS 桥能力面的逐项分析。**这是本任务最大的覆盖缺口**，建议单独一轮。
2. **AI 子系统**（`product/experimental/ai/`）—— 明确排除（已不参与编译）。
3. **前端组件级数据流** —— 只到 API 客户端边界。
4. **数据库 schema 全量**（`Schema.kt`/`Migration.kt`）—— 只读了 `reading_progress` 建表位置。
5. **`localbook/` 本地书解析链路** —— 只在目录/正文分支里点到。
6. **`subscription/`（订阅）与 `rss/`** —— 只统计了 import 边与端点，未画链路（不在 7 条必答链内）。
7. **性能与并发实测** —— 全为静态分析，零运行时验证（本轮不构建、不启动）。

### 10.4 数字可靠性分级

| 数字 | 可靠度 | 来源 |
|---|---|---|
| 包文件数（123 个 kt / 16 包） | 高 | `find` 一次成型 |
| import 边与条数（605 条） | 高 | grep 全扫 + awk 聚合，可复算 |
| 端点 144 条 | 高 | `agent-api.json` 的 `count`（唯一真源） |
| 前端路径 103 条 | 高 | grep 提取 + 去重 |
| DTO 184/86/57 | 中 | 正则抽取，可能因嵌套泛型/多行漏算（误差估计 ±5） |
| `StaticWeb` 6 条 brand 端点 | 高 | 逐行 grep |
| 覆盖率百分比 | 低（粗估） | 按行数估算，非工具统计 |

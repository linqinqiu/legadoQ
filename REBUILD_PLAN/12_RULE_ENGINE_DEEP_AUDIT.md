# 12 书源规则引擎深度审计（Phase 0.5）

> **本册由三份并行深读合并**：12a 执行链与 HTTP 耦合 · 12b 规则语义与兼容性 · 12c JS 沙箱与 Java 桥。
> 审计对象：`E:\legadoQ-archive\`（只读归档，HEAD `771b311`）。全部为**静态源码深读**：未构建、未启动、未执行任何脚本、未跑测试、未改动归档。
> 标注约定：**confirmed** = 直接读到实现；**likely** = 多处证据推断；**needs-runtime-test** = 须运行验证（每条附验证方法）。
> 覆盖率：三份子册合计精读约 **7,100 行**（`RuleRunner` 1,758 全文、`RuleValue` 802 全文、`JsSandbox` 2,100 全文、`JavaPackages` 1,415 全文，另加取值链路与上游基线源码）。

---

## 0. 三句话结论（先看这个）

1. **负责人假设的那条链路大半不存在**：源码里**没有 `RuleParser`、没有 `RuleContext`（同名的是扩展点日志口）、没有 `Fetch` 抽象**；`BookSource` 在执行路径上不是对象而是一个裸 JSON 字符串（`SourceRecord.json`）。真实链路是 `RuleRunner.<entry>(sourceJson)` → `jsSandbox.withSourceContext` → 逐层 if 链剥离规则串 → 内建取值 → 需要时 `fetchResponse`。详见 12a §2。
2. **沙箱是这套东西真正的硬核，而且比预期更强**：`ClassShutter` 恒 `false`（deny-all）+ 43 类白名单 + 危险类（`Runtime`/`ProcessBuilder`/`java.io`/`Class.forName`/反射）**全部不可达且静默 undefined**，本次静态审查**未找到可用逃逸路径**。但它有**三处真实缺口**：纯 JS 堆分配不记账、7 个 `java.ajax*` 入口不传 deadline、进程级累计容器（`java.put`/`cache.putMemory`）无上限。详见 12c。
3. **兼容性不能再靠自述**：归档内 `docs/.scratch/compat-audit/ref-legadoteam|ref-md3|ref-legado-e` 带**完整上游 `analyzeRule` 源码**，本次逐行对照得出 **46 条判定 = 一致 21 / 差异 19 / 缺失 2 / 未确认 4**，并推翻了项目自述里至少 2 条宣称（详见 12b §2、§2.5）。其中 **`@CSS:` 大写导致字段层静默失效**、**`getString` 失败返回 `null` 而上游返回 `""`** 是两条会真实影响社区书源结果的差异。

---

## 1. 本册使用建议

| 你要做什么 | 读哪一节 |
|---|---|
| 判断"规则引擎能不能独立提取" | 12a §2（真实链）+ §9（解耦方案）+ 本册 §2 汇总 |
| 判断"哪些代码绝对不能改" | 12b §2 兼容性判定表 + 12c §9.3「14 条不能改语义的行为」 |
| 判断"沙箱能不能原样搬" | 12c §9（可搬性前提 C-1~C-10） |
| 判断"网络闸门到底生不生效" | 12a §6（SSRF 三层实证 + 绕过路径清单） |
| 判断"重建后书源会不会跑坏" | `14_RULE_COMPATIBILITY_MATRIX.md`（判据覆盖地图） |

## 2. 三份子册的关键结论汇总

| 主题 | 结论 | 出处 |
|---|---|---|
| 真实执行链 | `Routes → SourceRecord.json → RuleRunner.entry → withSourceContext → 规则串逐层剥离（列表层 10 级分发 / 字段层 9 级求值）→ 内建取值 → fetchResponse → DTO` | 12a §2 |
| 规则串从哪来 | **无强类型模型**：`SourceModels.kt` 里连规则字段都没有，全是 `JsonObject` 裸键读取 | 12b §1 |
| 扩展点 | `RuleDispatcher` 在 `NodeValue.value` 里**先于内建**旁挂，默认零注册 ⇒ 机制真实但空转 | 12a §3 |
| 分页 | **零服务端状态**：`page` 是调用方参数，`pages`/`visited` 全在栈上，超 40/30 页**静默截断无告警** | 12a §4 |
| 异常 | 全链唯一 `RuleExecutionException`；分类做了，但用户**永远只看到 `source_execution_failed` / 502** | 12a §5 |
| 出站预算 | 单响应 2 MiB ✅ / 单跳 20s ✅ / 4 跳 ✅；**出站次数 ❌ / 出站总字节 ❌ / 全局 QPS ❌** | 12a §6、12c §4 |
| SSRF | 三层真实生效（每跳 `validateTarget` + `GuardedHttpClient` + `PinnedProxy` DNS pinning）；**唯一绕过面是 `WebViewProxy` 用裸客户端（缺 pinning）** | 12a §6 |
| 沙箱逃逸 | 静态未发现可用路径；三个高优先缺口：纯 JS 堆不记账（`likely` 会先于墙钟 OOM）、`java.ajax` 无 deadline、累计容器无上限 | 12c §5、§8 |
| 变量隔离 | `ruleData` 的键**只有 URL 没有 sourceId** ⇒ 同一 URL 并发会互相覆盖 `@put` 变量（needs-runtime-test） | 12a §7、12b §4 |

---

# 附册 12a · RuleRunner 执行链与 HTTP 耦合


> 审计对象：`E:\legadoQ-archive\`（只读）。审计员：`deep-rules-runner`。
> 标注约定：**confirmed** = 直接读到实现；**likely** = 多处证据推断；**needs-runtime-test** = 须运行验证。
> 本轮获负责人授权可整篇读指定文件（分批 ≤400 行窗口）。

## 1. 文件职责与调用关系

路径前缀统一为 `product/app/src/main/kotlin/io/legado/`（相对 `E:\legadoQ-archive\`）。

### 1.1 `rules/RuleRunner.kt`（1,758 行，**已整篇读完**）
一句话：**声明式书源规则的唯一执行器**——它同时是「HTTP 客户端 + 四种取值后端的分派宿主 + 每条链路的编排者」。

- 核心类型：`class RuleRunner`（`RuleRunner.kt:80`）、`private class JsSourceRunner`（`:1643`）、`class RuleExecutionException : RuntimeException`（`:1709`）、`data class DebugTrace`（`:1713`）、顶层工具 `newRuleDataCache`（`:1750`）、`bareJsonListPath`（`:1732`）。
- 构造：主构造 `RuleRunner(responseFetcher, database: PortBundle?, dispatcher: RuleDispatcher = RuleDispatcher())`（`:80-93`），另有 3 个次构造（`:94-96`）。
- 关键成员（都是**每次执行共享的可变状态**，见 §7）：
  - `private val runtime = RuleRuntime(dispatcher) {...}`（`:99`）
  - `private val nodeSelection = RuleNodeSelection(runtime) { ... }`（`:107`）
  - `internal var fetchedFetcher: ((String) -> Fetched)?`（`:116`，测试注入点，**优先于真网络**）
  - `private val client = NetworkSecurity.newHttpClient(connectTimeout = 10s, followRedirects = NEVER)`（`:117`）
  - `internal val jsSandbox = JsSandbox(this)`（`:119`）← 反向依赖，见 §9
  - `private val ruleData = newRuleDataCache(MAX_RULE_DATA_KEYS=4096)`（`:135`，LRU + synchronizedMap）
- **公开入口方法清单（`fun`，非 private/internal）**，共 17 个：

| 方法 | 行 | 说明 |
|---|---|---|
| `search(sourceJson, keyword): List<SearchResult>` | `:144` | `Metrics.timed("search")` 包 `searchWithReason` |
| `searchWithReason(sourceJson, keyword): Pair<List<SearchResult>, String>` | `:153` | 委派 `searchFlow.search`（`SearchFlow.kt`） |
| `exploreTabs(sourceJson): List<ExploreTab>` | `:284` | 解析 `exploreUrl` |
| `explore(sourceJson, urlTemplate, page=1)` | `:296` | `Metrics.timed("explore")` |
| `rssTabs(sourceJson)` | `:326` | `sortUrl` |
| `rssArticles(sourceJson, urlTemplate, page=1)` | `:345` | |
| `reviews(sourceJson, urlTemplate, page=1)` | `:397` | 段评只读 |
| `rssContent(sourceJson, link): ChapterContent` | `:459` | |
| `loginIsScript` / `loginCanOpenBrowser` / `loginBrowserStartUrl` | `:553` / `:560` / `:576` | 登录入口探测 |
| `details(sourceJson, bookUrl): BookDetails` | `:599` | |
| `imageDecoder(sourceJson): ((ByteArray)->ByteArray?)?` | `:715` | |
| `debugDetails(sourceJson, bookUrl)` | `:733` | 带 `DebugTrace` |
| `chapters(sourceJson, tocUrl): List<Chapter>` | `:738` | |
| `content(sourceJson, chapterUrl, bookName?, bookUrl?)` | `:913` | |
| `RuleExecutionException(message)` | `:1709` | 唯一的规则失败异常类型 |

  另有 `internal` 但**事实公开**的入口（跨包被调用）：`fetch`（`:1059`）、`fetchResponse`（`:1070`）、`validateTarget`（`:1316`）、`buildRequest`（`:1325`）、`effectiveHeaders`（`:1381`）、`splitUrlOptions`（`:1137`）、`sourceContext`（`:514`）、`loginScript`（`:536`）、`listItemsByRule`（`:1458`）、`resolveBodyCharset`（`:1437`）、`dispatcher`（`:92`，`val` 公开）。
  > 注意 `loginUiVersion` / `executeLoginAction` / `checkLoginStatus` 等已搬到 `rules/RuleLogin.kt`（`:1053-1057` 注释），**方法名在本文件只是注释里的字**，别按名字找。

- **被谁调用（grep 实证）**：
  - 装配唯一处：`Application.kt:168` `val runner = RuleRunner(database = database)`，随后注入 `BookCacheService(database, runner, coverCache)`（`Application.kt:172`）与各路由。
  - `http/ReadingRoutes.kt:75` `runner.details`、`:87` `runner.reviews`、`:115/:119/:120` `runner.chapters`、`:187/:219` `runner.content`
  - `http/SearchRoutes.kt:161` `runner.explore`、`:243` `runner.search`
  - `http/RssRoutes.kt:86` `runner.rssArticles`、`:97` `runner.rssContent`
  - `http/SourcesRoutes.kt:338` `exploreTabs`、`:345` `loginUiVersion`、`:362-363` `loginIsScript` / `loginCanOpenBrowser`、`:516` / `:722` `loginBrowserStartUrl`
  - `cache/BookCacheService.kt:73` `chapters`、`:124` `content`
  - `source/SourceHealth.kt:65` `search`；`source/SourceDebugger.kt:57/90/119/147` `searchWithReason` / `debugDetails` / `chapters` / `content`
  - 反向：`rules/JsSandbox.kt:212` 持有 `private val runner: RuleRunner?`，`rules/JavaPackages.kt:56` 同样持有 —— **沙箱回调 RuleRunner 的 fetch**（§6 绕过点）。
  - 结论（confirmed）：`RuleRunner` 是**进程级单例**（`Application.kt:168` 只 new 一次），不是每请求 new。

### 1.2 `rules/RuleUrlSupport.kt`（162 行，**已整篇读完**）
一句话：URL/JSON 文本层的**无状态纯工具**，2026-11-11 从 RuleRunner 抽出。
- 无类，全是同包顶层 `internal fun`：`JsonElement.toPlainJava()`（`:20`）、`unescapeUrlSlashes`（`:29`）、`String.isBareUrlLine()`（`:36`）、`jsonOption`（`:42`）、`headerMapOf`（`:46`）、**`parseUri`（`:60`）**、`encodeIllegalUrlChars`（`:75`）、**`dataUrlPayload`（`:88`）**、`sniffMediaUrl`（`:115`）、`selectPageSegments`（`:136`）、`trimJsNumberFraction`（`:145`）、`mergeExploreRule`（`:152`）。
- 被谁调用：只在 `rules/` 包内（`RuleRunner` + `RuleNodeSelection` + `RuleValue`），`grep -rn "parseUri(" ` 唯一调用点 `RuleRunner.kt:1232`。
- 调用了谁：`io.legado.content.LooseJson`（`:3`，宽松 JSON）、kotlinx.serialization、`java.net.URI/URLEncoder`。**不碰网络、不碰 JS 沙箱**（confirmed）。

### 1.3 `rules/RuleHttp.kt`（156 行，**已整篇读完**）
一句话：请求构造/地址脚本这层从 RuleRunner 抽出的**纯函数 + 常量**；出站安全校验**故意留在 RuleRunner**。
- 类型：无类。`internal const val PER_HOP_TIMEOUT_MS = 20_000L`（`:21`）、`URL_VARIABLE_PATTERN`（`:24`）、`URL_JS_PATTERN`（`:27`）。
- 函数（都是 `RuleRunner` 的扩展函数，因此**仍要 RuleRunner 实例**才能调）：`RuleRunner.parseSourceHeaders`（`:30`）、`RuleRunner.networkContext`（`:50`）、**`RuleRunner.capToDeadline`（`:60`）**、**`RuleRunner.applyUrlScripts`（`:82`）**、**`RuleRunner.renderUrl`（`:120`）**。
- 被谁调用：`RuleRunner.kt:177`（搜索）、`:304`、`:351`、`:407`（RSS/段评）、`:182`、`:307`、`:354`、`:410`（renderUrl）、`:1242`（capToDeadline）、各处 `parseSourceHeaders`（`:179/306/353/409/641/823/1043`）。
- 文件头注释明确写出了**为什么 validateTarget 没跟着搬**（`RuleHttp.kt:13-17`）：`NetworkSecurity` 属 infra，`engine → infra` 基线只允许在 `RuleRunner` 里（`ENGINE_TO_INFRA_BASELINE`）。这条是 §9 的关键约束。

### 1.4 `rules/ResponseBody.kt`（114 行，**已整篇读完**）
一句话：响应字节 → 文本的**纯字节层**（解压 + 字符集 + 限读上限）。
- `internal object ResponseBody`（`:19`）：`MAX_BODY_BYTES = 2 MiB`（`:20`）、`decodeBody(bytes, contentEncoding, declared, contentType)`（`:36`）、`resolveBodyCharset(...)`（`:66`）、`metaCharset`（`:78`）、`readAll`（`:90`）、`readLimited`（`:102`）。
- 被谁调用：`RuleRunner.kt:1282`（`readLimited`）、`:1288`（`decodeBody`）、`:1437`（委托 `resolveBodyCharset`）。`grep -rn "ResponseBody\." ` 无其他调用方。
- 不碰网络与 JS（confirmed，`:19-20` 注释与代码一致）。

### 1.5 `rules/PagingRule.kt`（69 行，**已整篇读完**）
一句话：静态判断「这条栏目地址到底吃不吃页码」，**只解析不执行**。
- 无类。`supportsPaging(rule: String?): Boolean`（`:32`）、`referencesPage(script): Boolean`（`:50`）；私有正则 `PAGE_SCRIPT_BLOCK` / `PAGE_SCRIPT_PREFIX` / `PAGE_EXPRESSION` / `PAGE_SEGMENT` / `PAGE_WORD`（`:25-30`）。
- 被谁调用：`RuleRunner.kt:330`、`:492`、`:502`（`ExploreTab(..., supportsPaging(url))`）。
- 实现用 Rhino `Parser` + AST 判「自由变量 page」（`:52-68`）——`{{book.page}}`、形参遮蔽、局部 `var page`、字符串 `'page'` 都判为**不可翻页**。这是**证据等级 confirmed**（读到了 `definingScope == null` 与 `PropertyGet`/`ObjectProperty` 排除）。

### 1.6 `rules/RuleProcessor.kt`（143 行，**已整篇读完**）
一句话：规则扩展点契约 + 调度器 + 运行时。
- 接口 `RuleProcessor`（`:25`，`type`/`canHandle`/`producesNodes`/`execute`）、`RuleInput`（`:52`）、`RuleContext`（`:68`）、`data class RuleResult`（`:80`）、`class RuleDispatcher`（`:93`）、`internal class RuleRuntime`（`:137`）。
- `RuleDispatcher`：`register`（`:102`，同 type 覆盖）、`unregister`（`:109`）、`dispatch(type)`（`:111`）、`types()`（`:113`）、`size`（`:115`）、`claim(rule)`（`:118`）、`claimNodeRule(rule)`（`:124`）。底层 `CopyOnWriteArrayList`（`:95`）。
- 被谁调用：`RuleRunner.kt:99`（构造 `RuleRuntime`）、`RuleValue.kt:52`（`claim`）、`RuleNodeSelection.kt:45`（`claimNodeRule`）。`grep` 计数见 §3。

### 1.7 交叉文件
- `ops/NetworkSecurity.kt`（167 行，读 1-160）：`object NetworkSecurity`，`BlockedAddressException`（`:23`）、`UnreachableTargetException`（`:32`）、`newHttpClient(...)`（`:54`）、`resolveAndValidateSafeHttpTarget(uri, serviceName, allowLoopback)`（`:84`）、`validateResolvedAddresses`（`:114`）、`isSpecialV4`（`:133`）/`isSpecialV6`（`:149`）。
- `port/StorePorts.kt`：**没有**任何 Fetch/HTTP 端口（`)` 全文只有 `CookieStore`/`VariableStore`/`ScriptCacheStore`/`LoginStateStore`/`KernelReader`/`PortBundle`）。见 §6「是否有统一 Fetch 抽象」。
- `Application.kt:135-215`：装配处。

## 2. 完整执行链（假设链路逐段核对）

### 2.1 假设链路的名字是否存在

负责人假设：`BookSource → RuleParser → RuleContext → RuleRunner → RuleProcessor → (JS/CSS/XPath/JSONPath) → Fetch → Result`

逐段核对结果（**这是本节最重要的结论**）：

| 假设段 | 源码里存在吗 | 实证 |
|---|---|---|
| `BookSource` | **执行路径里不存在**。只有 `SourceRecord(id, json: String, version, updatedAt, weight)`（`model/SourceModels.kt:301-312`）——书源在引擎侧**永远是一段 JSON 文本**，没有强类型 `BookSource` 模型。`RuleRunner` 的每个入口签名都是 `sourceJson: String`（`:144/:599/:738/:913`）。 | `grep -rn "class SourceRecord"` 唯一命中 `model/SourceModels.kt:301`；`RuleRunner.kt` 全文无 `BookSource` 类型引用 |
| `RuleParser` | **完全不存在**。`grep -rn "RuleParser" --include=*.kt` 零命中。规则文本**不预解析**：每一处都是取字符串后即时判断前缀（`@css:`/`@xpath:`/`@json:`/`<js>`/`##`），见 `RuleNodeSelection.kt:43/63/65/67`、`RuleValue.kt:418/554/661/688`。 | 零命中（confirmed） |
| `RuleContext` | **存在但不是这个意思**。`RuleProcessor.kt:68` 的 `interface RuleContext` 只有 `fun log(message)`，是**给扩展点用的只读日志口**，由 `RuleRuntime`（`RuleProcessor.kt:137`）实现。真正的「执行上下文」叫 `JsExecutionContext`（`JsSandbox.kt:28`）。 | confirmed |
| `RuleRunner` | 存在，`RuleRunner.kt:80`。 | confirmed |
| `RuleProcessor` | 存在，但**不在主链路上**，位置也和假设相反：它是 `NodeValue.value` 里**先于**内建后端的可选覆盖（`RuleValue.kt:52-65`、`RuleNodeSelection.kt:45-58`），默认 `dispatcher.size == 0` 时整段被跳过。 | confirmed |
| `(JS/CSS/XPath/JSONPath)` | 存在，但**不是 RuleRunner 里的一个阶段**，而是 `NodeValue.valueBuiltin`（`RuleValue.kt:70`）内部按前缀分派到 `valuePlain`（`:418`，CSS/XPath/正则）、`valueJson`（`:554`，JSONPath）、`jsSandbox.eval`（`:100`）。 | confirmed |
| `Fetch` | **没有这个名字的抽象**。真实方法 `RuleRunner.fetchDetailedImpl`（`:1221`），直接持有 `java.net.http.HttpClient`（`:117`）。`port/StorePorts.kt` 里没有任何 HTTP/Fetch 端口。 | confirmed，详见 §6 |
| `Result` | 存在但按链路分散：`SearchResult` / `BookDetails` / `Chapter` / `ChapterContent`（`io.legado.model`，`RuleRunner.kt:65-72` import）。 | confirmed |

**差异一句话**：假设链路里 `RuleParser` 不存在、`RuleContext` 名同实异、`RuleProcessor` 只是旁挂的覆盖层而非必经环节、`Fetch` 根本没有抽象；真实执行器是 `RuleRunner` + `NodeValue`（取值后端分派器），书源是裸 JSON 不是 `BookSource` 对象。

### 2.2 真实链路（总览）

```
HTTP 路由 (http/*Routes.kt)
  └─ database.getSource(id) → SourceRecord.json : String        port/StorePorts.kt:100 / model/SourceModels.kt:301
       └─ RuleRunner.<entry>(sourceJson, …)                      rules/RuleRunner.kt:80
            ├─ sourceJson.objectValue() → JsonObject             RuleRunner.kt:1586
            ├─ jsSandbox.withSourceContext(sourceContext(...))   RuleRunner.kt:514 → JsSandbox.kt:253（ThreadLocal）
            │    └─ JsExecutionContext                            JsSandbox.kt:28
            ├─ 取页面: renderUrl → splitUrlOptions → fetchUrl     RuleHttp.kt:120 / RuleRunner.kt:1137 / :1174
            │    └─ fetchDetailed → fetchDetailedImpl            RuleRunner.kt:1212 / :1221
            │         ├─ buildRequest + validateTarget(SSRF)     :1325 / :1316
            │         ├─ client.send(...)  java.net.http.HttpClient  :1244（client 在 :117）
            │         ├─ 手写重定向 4 跳，每跳重新 validateTarget  :1239 / :1306-1307
            │         ├─ Set-Cookie 逐跳落库                      :1259-1266
            │         └─ ResponseBody.readLimited / decodeBody    ResponseBody.kt:102 / :36
            ├─ 取值: NodeValue.document/json(...)                 RuleValue.kt:22
            │    └─ NodeValue.value → [RuleDispatcher.claim] → valueBuiltin   RuleValue.kt:45 / :52 / :70
            │         └─ CSS(Jsoup) / XPath(JXDocument) / JSONPath(JsonPath) / JS(Rhino)  RuleValue.kt:418 / :554 / :95
            │              └─ JS 内部再发请求 → 回到 RuleRunner.fetch/fetchResponse  JsSandbox.kt:1160/1178/1199
            └─ 组装结果 SearchResult / BookDetails / Chapter / ChapterContent
```

**关键结构性事实（confirmed）**：`fetch` 与 `取值` 是**交替递归**关系，不是两段。JS 规则可以在取值过程中再发 HTTP（`java.ajax`/`java.get`/`java.connect`/`okhttp3`），而这些请求又是从 `JsSandbox` 回调进 `RuleRunner.fetchResponse`。这是 §9 解耦方案必须绕开的根结。

### 2.3 链路 A：搜索（`POST /api/search` 与 `WS /search/stream`）

逐跳（每跳 file:line）：

1. 路由：`http/SearchRoutes.kt:53` `post("/search")`；流式是 `:89` `webSocket("/search/stream")`。
2. 编排：`SearchRoutes.kt:109` `SearchSession(sourceRecords, sourceSearchConcurrency()) { searchSourceOutcome(...) }`；并发上限 `AppConfig.kt:66-67`（`LEGADO_SEARCH_CONCURRENCY_MIN=16` / `MAX=32`）。
3. 单源超时包裹：`SearchRoutes.kt:243` `withTimeout(timeoutMs){ withContext(Dispatchers.IO){ runner.search(...) } }`。
4. `RuleRunner.search`（`RuleRunner.kt:144`）→ `Metrics.timed("search")` → `searchWithReason`（`:153`）→ `searchFlow.search`（`:156` 字段 `searchFlow = SearchFlow(SearchHost())`）。
5. `SearchFlow.search`（`rules/SearchFlow.kt:58`）：`isJsSource` 分支（`:60`，判据 `mainJs` 非空，`RuleRunner.kt:160-161`）→ JS 书源走 `JsSourceRunner.search`（`RuleRunner.kt:1646`）。
6. 声明式路径：`source.string("searchUrl")` 缺失即抛「该书源未配置 searchUrl」（`SearchFlow.kt:63-64`）；`ruleSearch` 缺失抛「该书源未配置 ruleSearch」（`SearchFlow.kt:71-72`）。
7. `host.inSourceContext(...)`（`SearchFlow.kt:69`）→ `RuleRunner.SearchHost.inSourceContext`（`:166`）→ `jsSandbox.withSourceContext(sourceContext(source, sourceUrl), block)`（`JsSandbox.kt:253`）。
8. `fetchSearchPage`（`RuleRunner.kt:169-184`）：`applyUrlScripts`（`:177`，执行 URL 里的 `<js>`/`@js:`）→ `splitUrlOptions`（`:178`）→ `mergeOptions(parseSourceHeaders(source), options)`（`:179`）→ `renderUrl(..., page = 1, expandScripts = false)`（`:182`）→ `.absolute(sourceUrl)`（`:1554`）→ `fetchUrl`（`:183`）。
9. `fetchUrl`（`:1174`）→ `fetchDetailed`（`:1212`，`Metrics.timed("http")`）→ `fetchDetailedImpl`（`:1221`）→ `buildRequest`（`:1325`，内含 `validateTarget` `:1332`）→ `client.send`（`:1244`）→ `ResponseBody.readLimited`（`ResponseBody.kt:102`，2 MiB 上限）/ `decodeBody`（`:36`）。
10. `parseSearchItems`（`RuleRunner.kt:186-191`）→ `bookItems`（`:240`）：`stripListPrefixMarkers`（`:249`）→ JS 列表走 `jsListNodes`（`:867`），否则 `nodeSelection.nodes(body, listRule)`（`:252`，`RuleNodeSelection.kt:33`）。
11. 字段取值：`item.value(rule.string("bookUrl"), jsSandbox, body, sourceUrl)` 等 10 次（`RuleRunner.kt:259-269`）→ `NodeValue.value`（`RuleValue.kt:45`）→ `[claim]` → `valueBuiltin`（`:70`）。
12. 变量回存：`rememberRuleData(url, item.snapshotVariables())`（`RuleRunner.kt:273`）。
13. 空响应前置拦截：`body.isBlank()` 直接抛「上游响应为空（0 字节）」（`:243`）。
14. 返回 `List<SearchResult>`；失败线索 `describeResponse` → `responseClue`（`:203`）。

### 2.4 链路 B：详情（含目录）

**详情**
1. `http/ReadingRoutes.kt:57` `post("/books/details")` → `:75` `runner.details(source.json, request.bookUrl)`（`Dispatchers.IO`）。
2. `RuleRunner.details`（`:599`）→ `detailsImpl`（`:602`）：`mainJs` 非空 → `JsSourceRunner.details`（`:1651`）；否则 `withSourceContext` → `declarativeDetails`（`:617`）。
3. `declarativeDetails`：`ruleBookInfo` **缺失不报错**，用空对象（`:628`，逐字段跳过）；`data:` 地址走 `dataUrlPayload`（`:633`，`RuleUrlSupport.kt:88`）不上网；否则 `splitUrlOptions`（`:640`）→ `mergeOptions(parseSourceHeaders(source), options)`（`:641`）→ `fetchUrl`（`:642`）。
4. `@put` 变量回灌：`recallRuleData(bookUrl)`（`:647`）→ `baseDoc.seedVariables(seedVars)`（`:648`）；`init` 规则求值后**再灌一次**（`:661`）。
5. 字段：`value("name")`… `value("lastChapter")`（`:683-699`），每字段 `root.value(...)` 包在 `runCatching` 里（`:664`）——**单字段失败不炸整条详情**。
6. `tocUrl` 兜底：`value("tocUrl")?.absolute(bookUrl) ?: bookUrl`（`:684`）。
7. 变量跨调用：`rememberRuleData(tocUrl, recallRuleData(bookUrl) + root.snapshotVariables())`（`:690`）← §7 的共享可变状态。

**目录**
8. `ReadingRoutes.kt:89` `post("/books/chapters")` → `:114` `withTimeout(4000)` → `:115` `runner.chapters(source.json, request.bookUrl)`；空结果回落详情取 `tocUrl` 再取一次（`:118-121`）；失败回落 `getCachedChaptersFallback`（`:98`、`:132`）。
9. `RuleRunner.chapters`（`:738`）→ `chaptersImpl`（`:741`）：`ruleToc` 缺失抛异常（`:746`）；`chapterList` 缺失抛异常（`:747`）；`-`/`+` 前缀剥除（`:750-751`）。
10. 分页三分支（`:769-789`）：0 个下一页 / 1 个（链式，`visited` 去环 + `MAX_TOC_PAGES`）/ 多个（`followNext = false` 各取一页）。
11. 单页：`parseTocPage`（`:803`）→ `dataUrlPayload` 或 `fetchUrl`（`:824`）→ 列表 `jsListNodes` 或 `nodeSelection.nodes`（`:826`）→ 逐章 `node.value(chapterUrl/chapterName/isVolume)`（`:832-835`）→ 下一页 `nextRule` 求值（`:840-843`）→ `parseNextTocUrls`（`:854`，支持单个/多行/JSON 数组三种形态）。

### 2.5 链路 C：正文

1. `http/ReadingRoutes.kt:140` `post("/books/content")` → `:187` `runner.content(source.json, request.chapterUrl, bookName, bookUrl)`；批量缓存是 `:199` `post("/books/content-refresh")` 与 `:219` 的 `fetch = { chapterUrl -> runner.content(...) }`。
2. `RuleRunner.content`（`:913`）→ `contentImpl`（`:916`）。
3. 净化规则先查库：`database?.asReader()?.getEnabledReplaceRulesForScope(...)`（`:920`）。
4. `mainJs` 分支（`:922-928`）→ `JsSourceRunner.content`（`:1659`）。
5. 执行上下文补书/章真值：`readingContext(...)`（`:890-911`，从 `shelfBook` + `getTocCache` 查；查不到就什么都不编造）。
6. 媒体直链短路：`sniffMediaUrl(chapterDirectUrl, sourceType)`（`:944`，`RuleUrlSupport.kt:115`）命中则**完全不发 HTTP**，直接返回该地址为正文（`:945`）。
7. 正文分页循环（`:955-989`）：`ArrayDeque` + `visited` + `MAX_CONTENT_PAGES=30`（`:1639`、`AppConfig.kt:183`）；每页 `contentPage`（`:1039`）→ `dataUrlPayload` 或 `fetchUrl`（`:1044`）。
8. 每页取值：`root.value(contentRule, ...)`（`:959`）→ `preserveContentImages`（`:1472`）→ `cleanContent`（`:1508`）。
9. 段落兜底：`pageText.length < 500` 且非媒体行时用 `<p>` 集合（`:964-975`，阈值 5 段）。
10. 净化：`applyReplaceEntry(entry, pageText)`（`:977`）。
11. 下一页：`root.value(nextRule, ...)` 逐行绝对化入队（`:980-988`）。
12. 媒体/播放页外溢：`execContext.mediaUrl`（`:994`）、`execContext.openUrl`（`:1003-1009`）——**JS 通过上下文对象往回写结果**，是另一条隐藏耦合。
13. `subContent` 拼接（`:1017-1021`）→ 净化管道 `ContentProcessor.processContent/processTitle`（`:1024-1029`）→ 二次媒体嗅探（`:1033`）→ `ChapterContent`。
14. 文本为空才抛：`RuleExecutionException("正文规则未提取到内容…")`（`:1013`）。

### 2.6 链路 D：登录

1. **入口探测（不执行脚本）**：`http/SourcesRoutes.kt:345` `runner.loginUiVersion(source.json)`（实现在 `rules/RuleLogin.kt`）；`:362-363` `loginIsScript` / `loginCanOpenBrowser`（`RuleRunner.kt:553` / `:560`）。
2. **拿登录页地址**：`SourcesRoutes.kt:516` / `:722` → `RuleRunner.loginBrowserStartUrl`（`:576`）：构造 `sourceContext(...).copy(includeLoginScript = true)`（`:588`），`jsSandbox.eval("if (typeof login === 'function') { login(true, false); }", ...)`（`:590-594`），读回 `execContext.openUrl`（`:596`）——**地址是脚本写进上下文对象的**，不是返回值。
3. **执行登录动作**：`SourcesRoutes.kt` → `RuleRunner.executeLoginAction` / `executeLoginUiActionV2`，实体已迁到 `rules/RuleLogin.kt`（`RuleRunner.kt:1053-1057` 只剩注释）。`RuleLogin.kt:66` 读已存 `loginInfo`，`:164` 写回；`:364`/`:383` 用 `cookieBucketsForHosts(SourceUrlProbe.credentialDomains(sourceJson))` 取 Cookie 罐。
4. **登录态如何进入请求**：不在登录链路里，而在**每一次** `effectiveHeaders`（`RuleRunner.kt:1392`）：`db.asLoginStateStore().getSourceLoginState(sourceId)?.loginHeader` 先铺底。所以登录"生效"的唯一证据是后续抓取带上了 `loginHeader` / Cookie。
5. **JS 侧登录原语**：`java.startBrowserAwait` → `JsSandbox.kt:48-69` 的 `inlineHtml` / `browserBody` / `browserCompleted` 两轮重跑协议（注释与代码一致，confirmed）。
6. **内置浏览器抓取**：`source/WebViewProxy.kt:110/142/178/280` 每跳 `validateTarget`，`:321` `client.send`；`client` 在 `:60` 用**裸** `HttpClient.newBuilder()`（不是 `NetworkSecurity.newHttpClient`）——见 §6 绕过分析。

## 3. 规则分派与扩展点

**认领机制**（`RuleProcessor.kt:118-127`，confirmed）：
- `claim(rule)`：按注册顺序 `firstOrNull { runCatching{ canHandle(rule) }.getOrDefault(false) }`。
- `claimNodeRule(rule)`：同上，但额外要求 `processor.producesNodes == true`（默认 false，`RuleProcessor.kt:39`）。
- **`canHandle` 抛异常 = 不认领**（`:120`），这是唯一的容错；**认领即拥有**：返回空结果也不回退内建链路（`RuleProcessor.kt:20-22` 注释 + `RuleValue.kt:64` `return result.text.takeIf{...}` 实现一致）。

**认领顺序**：注册顺序（`CopyOnWriteArrayList`，`:95`），同 `type` 再注册会覆盖旧的那个（`:102-106`）。默认 `RuleDispatcher()` 为空（`RuleRunner.kt:92`）→ **零处理器**。

**热路径上真实调用点：2 处**（`grep -rn "claim(\|claimNodeRule("` 全仓）：
1. `rules/RuleValue.kt:52`（单值取值）——前置卫兵 `if (active != null && active.dispatcher.size > 0)`。
2. `rules/RuleNodeSelection.kt:45`（列表取值）。

调用量级（confirmed）：`RuleRunner` 构造的所有 `NodeValue` 都带 `runtime`（非 null），所以 `active != null` 那条判断**几乎永远为真**，真正省开销的是 `dispatcher.size > 0`——没注册处理器时连 `rule.trim()` 都不做（`RuleValue.kt:50-52`）。一次搜索的检查次数 = 条目数 × 字段数（`bookItems` 每条约 10 次 `item.value`，`RuleRunner.kt:259-269`）。

**失败回退**（三档，都不回退内建）：
- 处理器 `execute` 抛异常 → `active.log("规则处理器 X 执行失败…")` + `return null`（`RuleValue.kt:56-59`）；列表侧 → 日志 + `return emptyList()`（`RuleNodeSelection.kt:47-51`）。
- `RuleResult.ok == false` → 记日志 + null/空（`RuleValue.kt:60-63`、`RuleNodeSelection.kt:52-55`）。
- 结果为空字符串 → 只是「没有值」（`RuleValue.kt:64`）。

**现实状态（重要的「注释 vs 实现」）**：`RuleRunner.kt:83-92` 的 KDoc 说扩展点「真的会被读到（0.2.34 起）」，这**与实现一致**；但生产装配 `Application.kt:168` **没有注册任何处理器**，`grep -rn "DemoHelloProcessor\|DemoMarkdownProcessor"` 只命中 `rules/processor/demo/` 自身。所以：**通道是活的，线上零使用**。`SearchFlow.kt:24` 的注释还写着「后续要接 RuleDispatcher 时，替换的是 Host 的 parseSearchItems」——已过时（搜索链的列表解析走 `bookItems`，扩展点已在 `nodeSelection.nodes` 里生效，不在 Host 层）。

## 4. 分页状态

**分页规则的解析**（三层，都是即时求值，不预编译）：
1. `<a,b,c>` 段选择：`selectPageSegments(url, page)`（`RuleUrlSupport.kt:136-140`）——非贪婪 `<(.*?)>` 逐段替换，`page-1` 取第 n 项，**越界取最后一项**（`?: options.last()`）。只在 `renderUrl` 末尾对 `page != null` 的调用生效（`RuleHttp.kt:155`）。
2. `{{page}}` 等字面量：`renderUrl`（`RuleHttp.kt:128-135`）。
3. `{{表达式}}`：`URL_VARIABLE_PATTERN` 丢给 JS 求值（`RuleHttp.kt:138-154`），`0.0 → 0` 由 `trimJsNumberFraction` 修（`RuleUrlSupport.kt:145`）。
- 「这一栏能不能翻页」由 `supportsPaging`（`PagingRule.kt:32`）静态判定，写进 `ExploreTab.supportsPaging`（`RuleRunner.kt:492/502`）。

**页码状态存在哪？—— 纯局部变量，服务端零状态（confirmed）**：
- 发现/搜索翻页：`page: Int` 是**调用方参数**（`RuleRunner.kt:296 explore(..., page)` / `:345 rssArticles(..., page)` / `:397 reviews(..., page)`），来自 HTTP 请求体 `request.page`（`SearchRoutes.kt:161`、`RssRoutes.kt:86/97`）。**不落库、不进上下文**。
- 目录翻页：`var pages = 1` + `mutableSetOf(tocUrl)`（`RuleRunner.kt:772-782`）全在 `chaptersImpl` 栈上，函数返回即消失。
- 正文翻页：`ArrayDeque` + `var visited`（`RuleRunner.kt:951-952`），同样栈上。
- 因此**没有可恢复的翻页游标**：一次请求中断 = 从头再来。跨请求唯一保留的是 `@put` 变量（`ruleData`，`RuleRunner.kt:135`），那是"变量"不是"页码"。

**翻页请求如何构造**：与首屏完全同一条路（`splitUrlOptions` → `mergeOptions` → `fetchUrl` → `fetchDetailed`），差别只是 `renderUrl` 传了 `page`。目录/正文的"下一页"地址来自规则求值本身（`nextTocUrl` / `nextContentUrl`），**不是**由页码推导。

**多页目录 / 多页正文的边界**：
- 目录：`MAX_TOC_PAGES = AppConfig.maxTocPages`（默认 **40**，`AppConfig.kt:182`；`RuleRunner.kt:1638`）。三分支（`RuleRunner.kt:769-789`）：0 个 → 单页；1 个 → 链式翻页，`visited.add(nextUrl)` 失败即停（`:775`）；多个 → `firstNextUrls.take(MAX_TOC_PAGES)` 各取一页且 `followNext=false`（`:784-788`），理由见 `:754-759` 注释（喜马拉雅一次推 2..9 页，递归翻页会 404）。
- 正文：`MAX_CONTENT_PAGES = AppConfig.maxContentPages`（默认 **30**，`AppConfig.kt:183`）；上限同时卡 `while (queue.isNotEmpty() && pageTexts.size < MAX_CONTENT_PAGES)`（`RuleRunner.kt:955`）。
- 两者都**没有**向用户报告"被截断"——超上限就是静默少页（`needs-runtime-test`：需实跑长目录源确认截断是否被前端感知）。

## 5. 异常处理与恢复

**抛什么**：`RuleExecutionException(message)`（`RuleRunner.kt:1709`，`RuntimeException` 子类）——**全链唯一**的规则失败类型。构造点极多（`grep -c "RuleExecutionException("`：`RuleRunner.kt` **29 处**、`rules/` 全包 **40 处**），典型：`上游返回 HTTP $status`（`:1278`）、`重定向次数超过限制`（`:1310`）、`上游响应超过 2 MiB 限制`（`ResponseBody.kt:110`）、`正文规则未提取到内容`（`:1013`）、`该书源未配置 ruleContent`（`:932`）、`URL 格式无效或包含未解析变量`（`RuleUrlSupport.kt:63`）。

**被谁捕获**：
1. 路由层统一口：`http/Routes.kt:89` `ApplicationCall.respondCatching` → `:93` `classifyRuleFailure`。所有 `respondCatching` 包裹的路由都走这里（`ReadingRoutes.kt:111/184`、`RssRoutes.kt:97` 等）。
2. 搜索单源隔离：`SearchRoutes.kt:245-251`，`TimeoutCancellationException` → `timedOut`，其它 `Throwable` → `failed`，**只标记不出栈**（整批搜索不因一个源失败）。
3. 目录回落：`ReadingRoutes.kt:128-136`，非客户端取消的失败 → 用 `getCachedChaptersFallback`（`:98`）兜底，兜不到才重抛 `RuleExecutionException`。
4. 正文回落：`ReadingRoutes.kt:191-194`，`!force && cached != null` → 回旧缓存；`force` 时**故意不回**（`:180-181` 注释：刷新拿旧正文等于骗人）。
5. 体检：`SourceHealth.kt:65-73` `runCatching` + `describe`（`:117-121` 沿 cause 链拼）。

**分类逻辑**（`Routes.kt:126-140`，confirmed 三分支）：

| 分支 | 状态码 | 响应 code | message |
|---|---|---|---|
| `NetworkSecurity.BlockedAddressException` | 502 | `source_execution_failed` | 「书源指向被拒绝的地址（内网或本机）：…」 |
| `RuleExecutionException` | 502 | `source_execution_failed` | **上游原话**直出 |
| 其它 | 502 | `source_execution_failed` | 固定文案「服务内部出错，详情已写入日志」+ `leaked=true` 记 `logSystem` |

- 用户看到的错误码**永远只有一个** `source_execution_failed` / 502；要区分只能读 message。

**读出来的两个真问题（confirmed，与注释不符）**：
1. **`BlockedAddressException` 那条分支对书源链基本是死路**：`RuleRunner.validateTarget`（`:1316-1323`）把 `IllegalArgumentException`（`BlockedAddressException` 是其子类，`NetworkSecurity.kt:23`）**catch 并改抛 `RuleExecutionException`**。于是书源链上第一分支永不命中，用户看到的是裸的「拒绝访问内网或本机地址」而**没有**「书源指向被拒绝的地址」前缀。行为不算错，但 `Routes.kt:119` 那句「说清是拒绝」在书源链上没生效。
2. **DNS 失败被报成「服务内部出错」**：`UnreachableTargetException : java.io.IOException`（`NetworkSecurity.kt:32`）。它在 `buildRequest`→`validateTarget` 里抛出（`RuleRunner.kt:1307` 或 `:1232`，都在 `try{client.send}` **之外**），`fetchDetailedImpl` 的 `catch (java.io.IOException)`（`:1245`）管不到 `:1232` 那一处；即便管到，也会重试后原样 rethrow（`:1254`）。所以最终落进 `classifyRuleFailure` 的 `else` 分支 → 固定文案 + ERROR 日志，用户看到「服务内部出错」而非「域名解析不了」。**这与 `SourceHealth` 的 `classify` 判断冲突**：后者靠 message 含「无法解析」判 `unreachable`（`SourceHealth.kt:103`），而实际 message 已被替换为固定文案 → 那条判据在体检链路上也吃不到。

**降级/回退总结**：目录有缓存回退（`ReadingRoutes.kt:98/132`）；正文有旧缓存回退（`:192`），但 `force` 明确不回；搜索无回退（单源失败即空）；`ruleData` 变量有 LRU 淘汰而非清空（`RuleRunner.kt:1750-1756`）。

## 6. HTTP 耦合（重点）

### 6.1 规则执行为什么需要网络请求（哪些规则类型会触发）

网络请求**不是**规则的附属品，它是规则语言的一部分——JS 规则里可以直接发请求，且返回值就是抓取结果。会触发出站的形态：

| 触发形态 | 位置 | 说明 |
|---|---|---|
| 每条链路的**主抓取** | `RuleRunner.kt:1174 fetchUrl` ← `:183/:307/:355/:411/:467/:642/:824/:1044` | 搜索页/发现页/RSS 页/段评页/详情页/目录页/正文页 |
| URL 层脚本 | `RuleHttp.kt:82 applyUrlScripts`（`<js>…</js>` / `@js:` 出现在 `searchUrl`/`exploreUrl`/`sortUrl` 里） | 脚本可调 `java.ajax` 拼地址 → 再发一次 |
| `{{表达式}}` 里的 JS | `RuleHttp.kt:138-154` | `{{java.getDict(...)}}` 之类 |
| 取值规则里的 JS | `RuleValue.kt:95-104`（`@js:`）、`:100` | 全库 `java.getElements` 170 处、`getElement` 226 处、`getStringList` 72 处（`RuleRunner.kt:1450-1451` 注释）；这些再入调用本身不发网 |
| JS 桥的网络 API | `JsSandbox.kt:1160`（`java.ajax`）、`:1178`（`java.get/post` → `fetchResponse`）、`:1199`、`:1222`（带 headers）、`:1301`、`:1386`、`:1805`（`java.connect`）、`:1824`（`java.head`）、`:1165`（`ajaxAll`） | **全部**汇到 `runner.fetch` / `runner.fetchResponse` |
| `okhttp3.*` 模拟 | `JavaPackages.kt:627-640`（类注册）→ `:1208`（`execute`）→ `:1242 executeRequest` → `:1245 runner.fetchResponse` | 同上，无独立客户端 |
| 远端 `jsLib` | `JsSandbox.kt:499` `remoteJsLibCache[url] ?: runner?.fetch(...)` | 缓存 64 条（`:223`） |
| `ruleContent.imageDecode` | `RuleRunner.kt:723`（只跑 JS，**不**发请求） | 图片字节由上层传入 |
| 正文/封面图片 | 不上网：只产出 `![图片](url)` 占位（`RuleRunner.kt:1472-1476`），实际抓取在 `cache/CoverCache.kt:41`（自己的 `NetworkSecurity` client） | 引擎内零图片请求 |

### 6.2 是否直接依赖具体 HTTP 客户端

**是，且是硬依赖**：
- 类型：`java.net.http.HttpClient`（JDK 11+），`import` 见 `RuleRunner.kt:37-39`。
- 字段：`private val client = io.legado.ops.NetworkSecurity.newHttpClient(connectTimeout = Duration.ofSeconds(10), followRedirects = HttpClient.Redirect.NEVER)`（`RuleRunner.kt:117`）。
- 用法：`client.send(hopRequest, HttpResponse.BodyHandlers.ofInputStream())`（`:1244`、重试 `:1251`）。
- 包了一层：`NetworkSecurity.newHttpClient`（`NetworkSecurity.kt:54-69`）返回 `GuardedHttpClient`（`ops/GuardedHttpClient.kt:28`，`send` 前 `guard(req.uri())`，`:40-45`）并挂 `PinnedProxy`（`NetworkSecurity.kt:72/75`）。所以**不是裸 JDK**，但引擎侧的编译期耦合类型仍是 `java.net.http.HttpClient`，且**同步阻塞**（`send` 不是 `sendAsync`）。

### 6.3 是否存在统一 Fetch 抽象

**没有（confirmed）**。
- `port/StorePorts.kt` 全文只有 `CookieStore` / `VariableStore` / `ScriptCacheStore` / `LoginStateStore` / `KernelReader`（`:19/:45/:63/:87/:99`）与 `port/PortBundle.kt:26-41` 的 5 个访问器，**没有任何网络端口**。
- 全仓 grep `interface Fetch` / `fun interface Fetch` / `class Fetcher` → **零命中**。
- 唯一的"抽象"是两个**测试替身函数字段**：`responseFetcher: ((String)->String)?`（`RuleRunner.kt:81`）与 `fetchedFetcher: ((String)->Fetched)?`（`:116`），在 `:1229-1230` **抢在**真网络之前返回。它们是 `internal var`，生产不可配置。
- 因此"把 HTTP 段移出 RuleRunner"这件事**目前没有可替换的接缝**（§9 的全部前提）。

### 6.4 Cookie 如何传递

三层，全部在 `effectiveHeaders`（`RuleRunner.kt:1381-1400`）里按**这一跳的真实 URL** 合成：
1. 库内登录头：`db.asLoginStateStore().getSourceLoginState(sourceId)?.loginHeader` → `parseHeaderJson`（`:1403-1414`，JSON 对象，旧数据裸串当 Cookie）。
2. Cookie 罐：`db.asCookieStore().getCookieForUrl(uri.toString())`（`:1393`）→ `data/StoreAdapters.kt:25` → `Database.getCookieForUrl`（`data/CookieDao.kt:95`）。
3. URL 自带的 `,{headers:{Cookie}}`（`:1395`）。
- 合并规则：**Cookie 按键位合并而不是整串覆盖**（`:1387` `mergeCookieStrings(previous.second, value)`，实现 `:1421-1431`）；其它同名头**后者覆盖**。
- 回写：每一跳的 `Set-Cookie` 原文按**该跳地址**归档 `db.asCookieStore().setCookieFromSetCookie(cookieUrl, cookieStr)`（`:1259-1266`），并保留全量原串供脚本读 `.cookie('hm')`（`:1198-1202` `Fetched.setCookies`）。会话级 Cookie 只进内存（`data/CookieDao.kt:576` `SessionCookies.put`），持久级落库（`:572`）。
- JS 侧同源：`java.getCookie` 走 `asCookieStore().getCookieForUrl`（`JsSandbox.kt:992`），`java.setCookie` 走 `setCookieForUrl`（`:1003`），都受 `allowed(url)` 约束。
- 为什么必然"逐跳"：书页域名与接口域名经常不同（`RuleRunner.kt:1374-1378` 注释），且重定向后落地域名可能完全不同（`:1260-1261`）。

### 6.5 请求头继承/合并优先级

真实优先级（低 → 高，后者覆盖前者；**Cookie 例外，按键合并**）：

```
① 内置 Accept-Encoding: gzip, deflate                    RuleRunner.kt:1335
② 书源级 header 字段 (parseSourceHeaders)                 RuleHttp.kt:30  ← 先与 URL 尾选项 merge
③ URL 尾 ,{headers:{...}}                                RuleRunner.kt:1161 → mergeOptions :1106-1110（②被③覆盖）
④ 登录头 loginHeader                                     RuleRunner.kt:1392
⑤ 库内 Cookie 罐（按落地 URL 取）                        RuleRunner.kt:1393
⑥ 已合并的 ②/③（effectiveHeaders 的最后一步 options.headers）  :1395
⑦ UA 兜底 "legadoQ/0.1"（仅当没有任何 UA）               :1340-1342
⑧ 受限头过滤 connection/content-length/expect/host/upgrade  :1347、常量 :1606
⑨ 非 ASCII 头值百分号编码 headerSafe                      :1351（实现在 JsSandbox.kt:134）
```

- 注意 ⑤ 排在 ⑥ 之前**但只对 Cookie 名做合并**，所以"临时 cookie 不会把登录留下的其它键抹掉"，反之亦然。
- 没有独立的"会话 header"层：会话态就是 ④ 的 `loginHeader` + ⑤ 的 Cookie 罐。
- `body` 的 `renderUrl` 会在 POST 时替换 `{{key}}`（`:1355`）；JSON 形 body 自动补 `Content-Type: application/json`（`:1362-1366`）。

### 6.6 SSRF 闸门是否实际生效

**是真生效，而且是三层纵深（confirmed）**：
1. **每跳显式校验**：`buildRequest` 第一行 `validateTarget(initial)`（`RuleRunner.kt:1332`）；`buildRequest` 被调用于**首跳** `:1232` 与**每个重定向跳** `:1307`。`validateTarget`（`:1316-1323`）→ `NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "站点")`（`NetworkSecurity.kt:84`，解析 + 缓存 5 min + `validateResolvedAddresses` `:114`，覆盖 RFC1918 / CGNAT / 169.254.169.254 / IPv6 ULA / 组播 / 保留段，IPv4-mapped 归一 `:155-159`）。
2. **发送前复查**：`GuardedHttpClient.send` 的 `guard(req.uri())`（`ops/GuardedHttpClient.kt:41`）——即便有人绕过 `validateTarget`，`client.send` 仍会再拦一次。
3. **连接级 DNS pinning**：所有请求走本进程回环 `PinnedProxy`（`NetworkSecurity.kt:62-66`、`ops/PinnedProxy.kt:37-40`），由代理解析一次并连同一 `InetAddress`，关掉 DNS TOCTOU 窗口（`ops/GuardedHttpClient.kt:23-24`）。

**手写重定向跟随在哪**：`RuleRunner.kt:1239 repeat(4)` 的循环体——`client` 本身 `Redirect.NEVER`（`:117`），300..399 时读 `Location`（`:1302`）、`request.uri().resolve(location)`、`validateTarget(redirect)`（`:1306`）、`request = buildRequest(redirect, ...)`（`:1307`，buildRequest 里再校验一次，`:1332`）。**每一跳都重新校验，确认无遗漏**。缺 `Location` 抛异常（`:1302-1305`）；4 跳用完抛「重定向次数超过限制」（`:1310`）。

### 6.7 是否存在绕过路径

| 路径 | 是否绕过 SSRF | 证据 |
|---|---|---|
| JS `java.ajax` / `get` / `post` / `connect` / `head` / `ajaxAll` | **不绕过** | 全部回调 `runner.fetch`/`fetchResponse`（`JsSandbox.kt:1160/1178/1199/1222/1301/1386/1805/1824`）→ 同一 `fetchDetailedImpl` → 同一 `buildRequest`/`validateTarget` |
| `Packages.okhttp3.OkHttpClient…execute()` | **不绕过** | `JavaPackages.kt:1208` → `:1242 executeRequest` → `:1245 runner.fetchResponse`；无独立 socket |
| `ClassShutter { false }` + `initSafeStandardObjects` | 挡住了反射 | `JsSandbox.kt:303-304`、`RuleRunner.kt:1667`（`JsSourceRunner` 同口径） |
| `org.jsoup.Jsoup.parse` 桥 | 只解析、无网络 | `JsSandbox.kt:329-331`（`JsoupBridge.install`，"只解析、不给网络出口"；注释与实现一致：桥里没有请求方法）|
| `data:;base64` 地址 | 主动**不发网**（正确行为） | `RuleUrlSupport.kt:88-106`，`RuleRunner.kt:812/633/1040` |
| `fetchedFetcher` / `responseFetcher` | **完全跳过闸门** | `RuleRunner.kt:1229-1230` 在 `buildRequest` 之前 return。`internal var`，测试用；无网络能力，但会让"真实链路的闸门"在测试里不被覆盖 |
| **媒体代理**（图片/音视频） | 有独立闸门 | `http/MediaRoutes.kt:448` 自建 `NetworkSecurity.newHttpClient`；每跳 `resolveAndValidateSafeHttpTarget(uri, "媒体")`（`:470`、`:481`） |
| **内置浏览器代理**（`startBrowserAwait`） | **闸门在但换了实现** | `source/WebViewProxy.kt:60` 用**裸** `HttpClient.newBuilder()`（不经 `NetworkSecurity`、**没有 PinnedProxy**）；自带 `validateTarget`（`:370`）在 `:110/:142/:178/:280` 每跳调用 |
| `UpdateCheck` / `EdgeTts` / `DesktopLauncher` / `ExternalBrowserLogin` | 裸 client，但**不接受书源规则** | `ops/UpdateCheck.kt:42`、`tts/EdgeTtsService.kt:28`、`DesktopLauncher.kt:313/323`、`source/ExternalBrowserLogin.kt:99`；不在 §1 的规则调用链上 |

**结论**：规则引擎内部**没有**可以利用的 SSRF 绕过口（JS 与 okhttp 模拟都被迫回到同一个 `fetchResponse`）。最值得记的两点：(a) `WebViewProxy` 用的是裸 client，缺 DNS pinning 这一层（同进程两套客户端实现，长期一致性风险）；(b) `fetchedFetcher` 这个 `internal var` 让"注入替身"可以完全跳过校验，虽无网络能力，但意味着**闸门的覆盖率靠约定不靠类型**。

### 6.8 出站是否有次数/并发/字节预算

**有单项上限，没有总量预算（confirmed，以"不存在"为证据）**：

| 维度 | 值 | 证据 |
|---|---|---|
| 连接超时 | 10 s | `RuleRunner.kt:117` |
| 单跳超时 | 20 s | `RuleRunner.kt:1334`；`RuleHttp.kt:21 PER_HOP_TIMEOUT_MS` |
| 重定向跳数 | 4 | `RuleRunner.kt:1239 repeat(4)` |
| 连接失败重试 | 1 次（全局一次） | `RuleRunner.kt:1248-1251`（`transientAttempt` 只在本轮第一次失败时 +1） |
| 单响应字节 | **2 MiB**（压缩前后各卡一次） | `ResponseBody.kt:20/98/110` |
| 目录/正文翻页 | 40 / 30 | `AppConfig.kt:182-183` |
| JS 墙钟 | 30 s | `AppConfig.kt:148` |
| JS 宿主内存 | `jsHostBytes` | `AppConfig.kt:162` |
| 搜索并发 | 16..32 | `AppConfig.kt:66-67` + `SearchRoutes.kt:262-263` |
| `ajaxAll` 并发 | 8（全局守护池） | `JsSandbox.kt:230-234` |
| **每个书源的请求次数上限** | **没有** | 规则里 `while`/递归 `java.ajax` 只受 JS 30 s 墙钟间接约束 |
| **全局出站速率 / QPS 限流** | **没有** | 全仓 grep `rateLimit|tokenBucket|quota` 零命中（只有 `Semaphore` 控**协程并发**，不控请求数） |
| **每源/全局出站字节预算** | **没有** | 只有单响应 2 MiB，N 个响应 × N 次翻页无汇总 |

最坏情况量化：一次 `fetchDetailedImpl` ≈ 5 次 `send` × 20 s ≈ **100 s**（`RuleRunner.kt:1080-1086` 注释自己也这么说，为此才加了 `deadlineMs`）。而 JS 的 `deadlineMs` 只在 `okhttp3.execute` 那条路上传（`JavaPackages.kt:1255` `BoundedJs.deadlineOrNull()`），**`java.ajax` 那条路不传**（`JsSandbox.kt:1160/1178` 均无 `deadlineMs`）→ JS 墙钟到点后观察器能中断脚本，但**已经在阻塞中的 socket 读不会被中断**（`SearchRoutes.kt:284-287` 明确承认"阻塞式 `HttpClient.send()` 不响应线程中断"）。

> `needs-runtime-test`：一个书源 JS 里写 `for(i=0;i<1000;i++) java.ajax(url)` 会不会真的打出 1000 次请求、以及 30 s 到点后各自收敛多久。

## 7. 并发与隔离

**前提**：`RuleRunner` 是**进程级单例**（`Application.kt:168`，全进程只 new 一次），`JsSandbox` 也是单例字段（`RuleRunner.kt:119`）。所以「不同书源并发执行」= 同一个 `RuleRunner`/`JsSandbox` 实例被多个 `Dispatchers.IO` 线程同时调用。共享状态清点如下：

| 状态 | 粒度 | 隔离性 | 证据 |
|---|---|---|---|
| `ruleData`（`@put` 变量表） | **按 bookUrl / tocUrl 的 key**，全源共享一张表 | ⚠ **键里没有 sourceId** → 两个书源产生同一个 bookUrl 时会串变量。`synchronizedMap` 只保证不炸，不保证不串 | `RuleRunner.kt:135/137-142`，key 见 `:139`、`:273`、`:690` |
| `jsSandbox.sessionStore`（`java.put`/`java.get`） | 全局 map，key = `sourceId\0key` | ✅ 按源隔离 | `JsSandbox.kt:237-240` |
| `jsSandbox.threadContext`（当前 `JsExecutionContext`） | `ThreadLocal` | ✅ 线程私有，且 `withSourceContext` 保存/恢复上一层（`try/finally`） | `JsSandbox.kt:250`、`:253-264` |
| `lastError`（脚本失败原因） | 随 `threadContext` | ✅ 每次进入上下文先 `clearLastError()`，防线程池复用串错 | `JsSandbox.kt:256-258`（注释点明就是为这个 bug 加的） |
| Rhino `scope` | **每次 eval 新建** `initSafeStandardObjects()` | ✅ 完全不共享（代价见 §8：无编译缓存） | `JsSandbox.kt:304`；`RuleRunner.kt:1668`（JS 书源同口径） |
| `remoteJsLibCache`（远端 jsLib 正文） | 全局 `ConcurrentHashMap`，key = URL | ⚠ 跨源共享（同一 URL 共享是合理的），但超 64 **整表 clear()** 不是 LRU | `JsSandbox.kt:486-503`、常量 `:223` |
| `ScriptCache`（脚本全局 `cache`） | 内存 LRU 2048 + SQLite，key = `sourceId\0key` | ✅ 按源隔离 | `rules/ScriptCache.kt:24-36` |
| Cookie 罐 | 按域名分桶，DB + 内存会话层 | ✅ 域隔离（这是设计要求，跨源共享同域 Cookie 是正确行为） | `data/CookieDao.kt:95`、`:576` |
| `HttpClient client` | 单实例 | ✅ 无状态，连接池共享（好事） | `RuleRunner.kt:117` |
| `NodeValue.ruleVariables` | 每个节点一份 `mutableMapOf` | ✅ 随规则链传递（`seedVariables`/`snapshotVariables`） | `RuleValue.kt:43`、`:515-519` |
| `Metrics.cells` | 全局 `ConcurrentHashMap`，key = sourceId | ✅ 只累加；条目数上界=库里书源数 | `ops/Metrics.kt:83`、`:88` |

**搜索并发（WebSocket 流式）如何避免互相污染**：
- 每个 WS 连接一个 `SearchSession(sourceRecords, sourceSearchConcurrency())`（`http/SearchRoutes.kt:109`），并发用 `Semaphore`（`SearchSession.kt:33`）。
- 每个源跑在自己的协程 + `Dispatchers.IO` 线程上（`SearchRoutes.kt:243`）；源之间**没有共享的中间结果**，结果由 `session.events()` 汇总（`:115`）。
- 单源超时**不回传取消**到整棵树（`:245-251`，只标 `timedOut`），这是修过一个真 bug 的地方（`:232-239`）。
- 因此并发正确性依赖的是：`ThreadLocal` 上下文 + 按源分键的 KV + 每次新 Rhino scope。**唯一没做到的是 `ruleData`（缺 sourceId）**。

**结论**：隔离设计整体是清醒的（注释逐条解释了为什么），`ruleData` 的键是唯一一处实际漏洞——`likely` 需要实跑确认：两个不同书源命中同一 bookUrl 时是否互相覆盖 `@put` 变量（`needs-runtime-test`）。

## 8. 性能

| 问题 | 是否存在 | 证据 |
|---|---|---|
| 同一规则多次编译 | **是**（JS） | 每次 `eval` 都重建 scope（`JsSandbox.kt:304`）、重跑 jsLib（`:423` → `evalLibrary` → `:492 cx.evaluateString(scope, library, "jsLib.js"…)`）、再编主脚本（`:432 cx.evaluateString(scope, executableScript, "rule.js"…)`）。**无 `CompiledScript` 缓存**。JS 源尤其重（一次搜索 N 条 × 10 字段） |
| 同一 HTML 重复解析 | **是** | `NodeValue.document(body)` 每次都 `Jsoup.parse(body)`（`RuleValue.kt:636-640`、`:639`）。`parseTocPage` 一页解析**两次**：一次给章节（`RuleRunner.kt:825`）、一次给 `nextTocRule`（`:840`）。`responseClue` 又对整个 body 跑一次 `Jsoup.parse`（`:216`） |
| 每跳重复查库 | **是** | `buildRequest` 每跳调 `effectiveHeaders`（`:1336`），内含**两次 DB 查询**：`getSourceLoginState`（`:1392`）+ `getCookieForUrl`（`:1393`）。一次 4 跳重定向 = 最多 10 次库访问 |
| 无界缓存 | 基本没有 | `ruleData` 4096 LRU（`:1604`）、`remoteJsLibCache` 64（`JsSandbox.kt:223`）、`ScriptCache` 2048 LRU、`dnsCache` 2000 后清（`NetworkSecurity.kt:13/105-107`）、`Metrics.cells` 上界=源数 |
| 大响应无上限读取 | **没有**（有上限） | `readLimited` 2 MiB（`ResponseBody.kt:102-113`），解压后**再卡一次**（`readAll` `:98`，专门防 gzip 炸弹） |
| 连接未复用 | **没有**（复用） | 单例 `HttpClient`（`RuleRunner.kt:117`）；但流量被 `PinnedProxy` 中转（`NetworkSecurity.kt:62-66`），实际复用发生在 代理↔目标 之间 |
| 协程/线程泄漏 | **有，且是明写的取舍** | `SearchRoutes.kt:284-295`：阻塞式 `send()` 不响应中断，到点后被取消的任务"由阻塞调用自己走完后释放线程"，最多 `limit`（≤32）个线程在收尾。`ajaxAllPool` 是守护线程池（`JsSandbox.kt:230-234`），进程退出不阻塞 |
| 正则重复编译 | **已修** | `CONTENT_IMG_TAG`/`SCRIPT_BLOCK`/…提到 companion（`RuleRunner.kt:1614-1632`，注释说明原先是每章现编译） |
| 字符串重复拼接（正文） | 可能 | `cleanContent` 对每页做 8 次全串 `replace` + 一次 `unescapeEntities` + 行切分（`:1533-1552`）；30 页正文 = 30 轮。`likely` 但未量化 |

**最值得优化的一处（按调用频次）**：`NodeValue.document` 的重复 `Jsoup.parse`。目录 40 页 × 2 次解析 + 每字段取值都对同一 `Element` 操作（这部分没重复），所以量级是"每页 2 次整页解析"，不算灾难但完全可以只解析一次。

## 9. 最小化解耦方案（只提方案，**不实施**）

目标：抽一个窄接口 `Fetch`，把 HTTP 段（`fetchUrl`/`fetchDetailed`/`fetchDetailedImpl`/`buildRequest`/`effectiveHeaders`/`mergeOptions`/`splitUrlOptions` + `ResponseBody` 的接线）移出 `RuleRunner`。

### 9.1 接口签名建议

```kotlin
// rules/Fetch.kt（或 port/Fetch.kt，见 9.3 的边界约束）
internal data class FetchOptions(
    val method: String = "GET",
    val body: String? = null,
    val headers: Map<String, String> = emptyMap(),
    val charset: Charset? = null,          // 源声明；null ≠ UTF-8
    val webView: Boolean = false,          // 只如实带出，服务端不实现
    val deadlineMs: Long? = null,          // JS 墙钟剩余预算（null = 不限）
    val maxBytes: Long = ResponseBody.MAX_BODY_BYTES,
)

internal data class Fetched(
    val url: String,                       // 落地地址（末跳）
    val body: String,
    val status: Int,
    val headers: Map<String, String>,      // 每名字取第一个值，key 小写
    val setCookies: List<String> = emptyList(),  // 含各跳的 Set-Cookie 原文
)

internal sealed class FetchFailure(message: String) : RuntimeException(message) {
    class Blocked(message: String) : FetchFailure(message)     // 内网/本机 → 4xx-ish 语义
    class Unreachable(message: String, cause: Throwable?) : FetchFailure(message)  // DNS/TCP
    class Upstream(val status: Int) : FetchFailure("上游返回 HTTP $status")
    class TooLarge(message: String) : FetchFailure(message)
    class TooManyRedirects : FetchFailure("重定向次数超过限制")
    class BudgetExhausted(message: String) : FetchFailure(message)
}

internal interface Fetch {
    /** [sourceId] 用于按域取凭据；[db] 为 null 时不带任何凭据。 */
    fun fetch(url: String, options: FetchOptions?, sourceId: String?, db: PortBundle?): Fetched
}
```

必须覆盖的现有能力（逐条对应源码，缺一条就是行为回归）：
1. **URL 尾 `,{options}` 解析**（`splitUrlOptions` `:1137-1170`，含宽松 JSON 回退与"解析失败仍去掉尾巴"）；
2. **方法/body/charset**（`UrlOptions` `:1113-1127`）；
3. **限读 2 MiB + 解压后再卡**（`ResponseBody.kt:98/110`）；
4. **字符集优先级 declared > `<meta>` > `Content-Type` > UTF-8**（`ResponseBody.kt:66-71`）；
5. **手写重定向 4 跳 + 每跳重校验 + 每跳重建请求**（`:1239-1307`）；
6. **每跳按落地 URL 合凭据 + 每跳归档 Set-Cookie**（`:1259-1266`、`:1391-1395`）；
7. **Cookie 按键合并而非整串覆盖**（`:1387`、`:1421-1431`）；
8. **UA 兜底 / 受限头过滤 / 非 ASCII 头编码 / JSON body 补 Content-Type**（`:1340-1366`）；
9. **首次连接失败重试一次**（`:1245-1256`）；
10. **`deadlineMs` 每跳压缩超时**（`RuleHttp.kt:60-76`）；
11. **`status !in 200..299` → 抛上游原话异常**（`:1267-1278`）；
12. **`STAGE_HTTP` 计时 + `logNetwork` 上下文（host/sourceId/url）**（`:1219`、`RuleHttp.kt:50-54`）。

### 9.2 需要保留的行为清单（黄金样本会比对到的）
`GoldenRuleTest` 逐字节比对的是**取值结果**，不是 HTTP，所以纯搬迁不该动它；但以下行为是"搬迁时最容易悄悄变"的，必须逐条立判据：
- POST body 里 `{{key}}` 的渲染（`:1355`）；
- `@put/@get` 变量在 `chapters`/`content` 之间传递（`:647/690/814/829/957`）；
- 正文分页文本用 `\n\n` 直接串接（`:1010`）；
- 目录多入口页 `followNext=false` 的语义（`:784-788`）；
- `data:` 地址**不发网**（`:812/633/1040`）；
- 媒体直链短路不发网（`:944`）。

### 9.3 会碰到的隐藏耦合（**三个真坑**）

1. **`JsSandbox(this)` 反向依赖**——`RuleRunner.kt:119` 把 `this` 交给沙箱；沙箱 **13 处**回调 `runner.fetch` / `runner.fetchResponse` / `runner.listItemsByRule`（`JsSandbox.kt:351/499/1160/1178/1199/1222/1301/1386/1714/1726/1776/1805/1824`），且 `JavaPackages(cx, scope, runner, context).install()`（`JsSandbox.kt:360`）把 runner **再往下传一层**，`JavaPackages.kt:1245` 也走 `runner.fetchResponse`。**只抽 fetch 而不给沙箱一个稳定的 fetch 句柄，`JsSandbox`(2100 行) 与 `JavaPackages`(1415 行) 都得改**。建议：沙箱构造参数从 `RuleRunner?` 改成 `Fetch?` + 一个更窄的 `RuleReentry?`（只为 `listItemsByRule`）。
2. **`@put` 变量与 `{{}}` 展开依赖线程上下文**——`renderUrl` 里 `{{表达式}}` 的求值要用 `jsSandbox.threadContext.get()`（`RuleHttp.kt:137`）；`fetch` 又要在 `@put` 变量已 seed 的上下文里被调用（`contentPage` `:1039-1046`）。所以 `Fetch` **不能是纯函数式黑盒**：URL 渲染/脚本展开必须留在引擎侧，`Fetch` 只接"已经渲染好的 URL + 已合并好的 headers"。这条决定了切分点在 `fetchUrl` 而不是 `fetchSearchPage`。
3. **`validateTarget` 的 engine→infra 边界**——`NetworkSecurity` 是 infra，`RuleHttp.kt:13-17` 明说"留 `validateTarget` 在 RuleRunner 是为了不新增 engine→infra 依赖"，并提到 `ENGINE_TO_INFRA_BASELINE`（有架构测试守）。新建 `rules/Fetch.kt` 若 `import io.legado.ops.NetworkSecurity`，很可能**直接踩红 `ArchitectureBoundaryTest`**。所以 `Fetch` 的实现应放 `ops/`（infra），接口放 `port/`（内核只认接口），由 `Application.kt` 装配——这与 `PortBundle` 的既有做法完全一致（`port/PortBundle.kt:3-25`）。

附带两个次要坑：
4. `Fetched` 是 `RuleRunner` 的**内部类**（`:1192`），被 `JsSandbox`/`JavaPackages` 引用 12 处，改名/挪包是宽面改动；
5. `STAGE_HTTP`/`logNetwork` 与 `Metrics` 都在被搬的段里，搬走要么一起搬、要么留扩口。

### 9.4 分步走（每步跑 `GoldenRuleTest`）
1. **只搬数据类型**：把 `Fetched` / `UrlOptions` 提到顶层 `rules/FetchTypes.kt`，`RuleRunner.Fetched` 保留 `typealias`。零行为变化，先把 12 处引用改稳。
2. **引入接口 + 默认实现**：`interface Fetch` + `class HttpFetch(...) : Fetch`（实现体就是现在 `fetchDetailedImpl` 原样粘贴），`RuleRunner` 加一个 `internal var fetchImpl: Fetch` 默认指向它。此步**不改任何调用点**。
3. **改调用点走接口**：`fetchUrl`/`fetchResponse`/`fetch` 三处改为 `fetchImpl.fetch(...)`；`JsSandbox`/`JavaPackages` 的 14 处暂不动（仍调 `runner.fetchResponse`，后者内部已转接口）。
4. **把 `HttpFetch` 挪到 `ops/`**：同时把 `validateTarget` 一起带过去（`ops/HttpFetch.kt` 引 `NetworkSecurity` 是合法方向），`rules/` 侧只剩接口引用。清 `ENGINE_TO_INFRA_BASELINE` 里对应的那一行。
5. **反向依赖收口**：给 `JsSandbox` 注入 `Fetch?` 而不是 `RuleRunner?`（`listItemsByRule` 单独用一个 `RuleReentry` 接口），`JavaPackages` 同步。

判据：每步后 `GoldenRuleTest` 逐字节一致 + `ArchitectureBoundaryTest` 绿 + 至少一份真库抽样（JS 源 / okhttp3 源 / GBK 源 / 重定向源各一）。

## 10. 证据索引表 + 未确认事项 + 覆盖率声明

### 10.1 证据索引（关键结论 → 出处）

| 结论 | 出处 | 等级 |
|---|---|---|
| `RuleParser` 不存在 | 全仓 grep 零命中 | confirmed |
| `RuleContext` 是扩展点日志口，非解析上下文 | `RuleProcessor.kt:68-71`、`:137-143` | confirmed |
| 书源在引擎侧是裸 JSON | `model/SourceModels.kt:301-312`、`RuleRunner.kt:1586-1588` | confirmed |
| `RuleProcessor` 是可选覆盖层、默认零注册 | `RuleValue.kt:49-52`、`RuleRunner.kt:92`、`Application.kt:168` | confirmed |
| HTTP 实现 = JDK `HttpClient` + `GuardedHttpClient` + `PinnedProxy` | `RuleRunner.kt:117`、`NetworkSecurity.kt:54-69`、`GuardedHttpClient.kt:28-45` | confirmed |
| 无统一 Fetch 抽象 | `port/StorePorts.kt` 全文、grep `interface Fetch` 零命中 | confirmed |
| 每跳重校验 SSRF | `RuleRunner.kt:1239/1306-1307/1332` | confirmed |
| JS / okhttp3 无 SSRF 绕过 | `JsSandbox.kt:1160/1178/1805/1824`、`JavaPackages.kt:1245` | confirmed |
| `WebViewProxy` 用裸 client（无 pinning） | `source/WebViewProxy.kt:60` + 自带 `validateTarget:370` | confirmed |
| 无出站次数/速率/字节总预算 | grep `rateLimit|tokenBucket|quota` 零命中；只有 `Semaphore` 控协程 | confirmed |
| `BlockedAddressException` 分支在书源链近乎死路 | `RuleRunner.kt:1316-1323` vs `Routes.kt:127-130` | confirmed |
| DNS 失败被报「服务内部出错」 | `NetworkSecurity.kt:32`、`RuleRunner.kt:1232/1245/1254`、`Routes.kt:135-139` | confirmed |
| 翻页零服务端状态 | `RuleRunner.kt:769-789/951-955`、`SearchRoutes.kt:161` | confirmed |
| `ruleData` 键缺 sourceId（跨源污染风险） | `RuleRunner.kt:139/273/690` | likely → `needs-runtime-test` |
| 目录页 HTML 每页解析两次 | `RuleRunner.kt:825` + `:840` | confirmed |
| `java.ajax` 不传 `deadlineMs`（只有 okhttp3 传） | `JsSandbox.kt:1160/1178` 无该参数 vs `JavaPackages.kt:1255` | confirmed |

### 10.2 未确认事项（需要运行时或更大范围才能定）
1. `ruleData` 跨书源同 bookUrl 是否真的串变量（需构造两源同 URL 实跑）。
2. 目录/正文翻页被 `MAX_TOC_PAGES`/`MAX_CONTENT_PAGES` 截断时，前端能否感知（怀疑不能：返回值里没有 truncated 标记）。
3. JS 里 `for(i<1000) java.ajax(...)` 的真实请求数与收敛时间（30 s 墙钟对阻塞 `send` 无效）。
4. `GuardedHttpClient` 在 `PinnedProxy` 不可用时的失败模式（只读了前 50 行，`failIfProxyCouldNotConnect` 后面未读完）。
5. `NON_ASCII` 头编码对某些站点签名头（如 `Sign` 含中文）是否会破坏校验——`headerSafe` 只读了声明（`JsSandbox.kt:134`），未读实现。
6. `SourceHealth.classify` 依赖 message 文本匹配（`SourceHealth.kt:102-111`），与 `Routes.kt` 固定文案替换后的实际 message 是否一致（怀疑 `unreachable` 档吃不掉，见 §5）。

### 10.3 覆盖率声明（老实数字）

**必读文件（全部整篇读完，100%）**：

| 文件 | 读 / 总行 |
|---|---|
| `rules/RuleRunner.kt` | **1758 / 1758（100%）**，分 7 个窗口：1-140、141-330、331-600、601-920、921-1110、1111-1330、1331-1560、1561-1760 |
| `rules/RuleUrlSupport.kt` | 162 / 162（100%） |
| `rules/RuleHttp.kt` | 156 / 156（100%） |
| `rules/ResponseBody.kt` | 114 / 114（100%） |
| `rules/PagingRule.kt` | 69 / 69（100%） |
| `rules/RuleProcessor.kt` | 143 / 143（100%） |
| 小计 | **2402 / 2402（100%）** |

**交叉读文件（部分，如实列出）**：

| 文件 | 读过范围 | 覆盖率 |
|---|---|---|
| `rules/SearchFlow.kt` | 1-78 全文 | 78 / 78（100%） |
| `ops/NetworkSecurity.kt` | 1-160 | 160 / 167（96%） |
| `ops/GuardedHttpClient.kt` | 1-50 | 50 / 101（50%） |
| `ops/Metrics.kt` | 60-135 | 76 / 197（39%） |
| `rules/RuleValue.kt` | 1-120 | 120 / 802（15%） |
| `rules/RuleNodeSelection.kt` | 1-80 | 80 / 165（48%） |
| `rules/JsSandbox.kt` | 20-70、200-340 | ~190 / 2100（9%） |
| `rules/JavaPackages.kt` | 1240-1275 | 36 / 1415（2.5%） |
| `rules/ScriptCache.kt` | 1-45 | 45 / 88（51%） |
| `http/Routes.kt` | 75-145 | 71 / 140（51%） |
| `http/SearchRoutes.kt` | 85-160、220-300 | ~157 / 370（42%） |
| `http/ReadingRoutes.kt` | 95-135、140-200 | ~102 / 314（32%） |
| `source/SourceHealth.kt` | 40-120 | 81 / 134（60%） |
| `data/CookieDao.kt` | 560-600 + grep | ~41 / 716（6%） |
| `port/PortBundle.kt` | 1-41 全文 | 41 / 41（100%） |
| `port/StorePorts.kt` | grep（接口名与签名） | 未整读，仅签名级 |
| `AppConfig.kt` | grep（限额常量） | 仅命中行 |
| `source/WebViewProxy.kt` | grep（client/validateTarget 行） | 仅 8 行 |
| `http/MediaRoutes.kt` | grep（client/validate 行） | 仅 6 行 |
| `Application.kt` | 130-215 | 85 / ~? |

**总计**：精确读过的代码约 **3,700 行**（其中规则引擎本体 2,402 行 100% 覆盖）。**未整读**：`JsSandbox`（91% 未读）、`JavaPackages`（97.5% 未读）、`RuleValue`（85% 未读）——这三个文件里仍有本册未覆盖的实现细节，特别是 `JsSandbox` 的 `java.*` 桥全表和 `RuleValue` 的 `valuePlain`/`valueJson` 体（CSS/XPath/JSONPath 的具体求值口径），建议由「取值后端」那一册补。


---

# 附册 12b · 规则语义与上游兼容性判定


> 审计员：`deep-rules-semantics`（legadoQ Phase 0.5「规则引擎深读」）
> 只读源：`E:\legadoQ-archive\product\app\src\main\kotlin\io\legado\`（**不写入归档、不 build、不启动**）
> 证据标注：**confirmed**＝源码逐行读到；**likely**＝源码结构支持但未跑通；**needs-runtime-test**＝必须实测才能定性
> 纪律：兼容性以**源码**为准；`product/docs/compatibility.md` / README 的兼容表只作「宣称」比对项，冲突以源码为准。

## 0. 上游基线的可用性（**先读这条，它决定所有「一致/差异」的证据强度**）

`product/docs/compatibility.md:15` 自述「上游默认分支只剩 README 与一张图」，实测**属实**：
`docs/.scratch/compat-audit/upstream-legado/` 里只有 `README.md` + `公告链接.png`（confirmed）。

但归档内另有**三个可编译的上游派生仓副本**，其中 `analyzeRule` 全套源码在场：

| 副本 | analyzeRule 目录 | 用途 |
|---|---|---|
| `docs/.scratch/compat-audit/ref-legadoteam/app/src/main/java/io/legado/app/model/analyzeRule/` | `AnalyzeRule.kt`(1059) `AnalyzeByJSoup.kt`(519) `AnalyzeByJSonPath.kt`(175) `AnalyzeByRegex.kt`(59) `AnalyzeByXPath.kt`(155) `RuleAnalyzer.kt`(377) | **本文兼容性基线** |
| `…/ref-md3/…/analyzeRule/` | 同上 | 交叉核对 |
| `…/ref-legado-e/…/analyzeRule/` | 同上 | 交叉核对 |

已做 diff：`ref-md3` 与 `ref-legadoteam` 在 `AnalyzeByJSoup.kt` / `AnalyzeByJSonPath.kt` 上的差异**均为等价改写**
（`results.isNotEmpty()` → `size > 0`、`el.deselectAll()` → `el.clear()`、`onError` 参数、`nullSet` 常量），
**不触碰本文任何判定**（confirmed，diff 输出已核对）。

> ⚠️ 因此本文的「一致/差异」是**与 ref-legadoteam（上游镜像仓）逐行对照**得出的，
> 比 `compatibility.md` 的自述强，仍不等于「与 gedoor/legado 某个具体 tag 一致」——
> 凡涉及第三方库内部行为（`JXNode.toString`、Jayway 解析细节）的，一律标 `needs-runtime-test`。

**路径缩写**（下同）：
- `RV` = `product/app/src/main/kotlin/io/legado/rules/RuleValue.kt`
- `RNS` = `…/rules/RuleNodeSelection.kt` · `RS` = `…/rules/RuleSplit.kt` · `RR` = `…/rules/RuleRunner.kt`
- `CPL` = `…/content/ContentPipeline.kt` · `CPR` = `…/content/ContentProcessor.kt` · `LJ` = `…/content/LooseJson.kt`
- `U` = `docs/.scratch/compat-audit/ref-legadoteam/app/src/main/java/io/legado/app/model/analyzeRule/`

---

## 1. 一条规则字符串的生命周期

以书源 JSON 的 `ruleSearch.bookList = "class.xxx@tag.li"`（占位符＝真实 CSS 选择器）为例。

### 1.1 从 JSON 到「规则字符串」

1. **没有强类型模型**。书源规则字段全程是**裸 `JsonObject`**：`SourceModels.kt` 里没有任何规则字段
   （只有 `hasRules: Boolean`，`model/SourceModels.kt:17`）；`ruleSearch`/`ruleBookInfo`/`ruleToc`/`ruleContent`
   由 `RuleRunner.objectValue(key)`（`RR:1587`）取出 JSON 对象，再逐字段
   `RuleRunner.string(key)`（`RR:1588`）= `(get(key) as? JsonPrimitive)?.contentOrNull` 读出**规则原文**（confirmed）。
   → 规则串没有任何 schema 校验，写坏只在求值期暴露。

2. `SearchFlow.search`（`SearchFlow.kt:58`）→ `SearchFlow.Host.fetchSearchPage`（`RR:169`）取回 `body`
   → `Host.parseSearchItems`（`RR:186`）→ `RuleRunner.bookItems`（`RR:240`）（confirmed）。

### 1.2 列表规则（产 `List<NodeValue>`）

`bookItems`（`RR:240-276`）：
`rule.string("bookList")`（`RR:244`）→ `stripListPrefixMarkers`（`RNS:161`，剥 `-`/`+`）
→ `isJsRule`（`RNS:149`）分叉 → `jsListNodes`（`RR:867`）或 `nodeSelection.nodes`（`RNS:33`）。

`RuleNodeSelection.nodes(body, rule)`（`RNS:33`）内部**按固定顺序**分发（顺序本身是语义）：

| # | 判定 | 位置 | 语义 |
|---|---|---|---|
| 1 | `-` / `+` 开头 | `RNS:40` | 剥掉重来（排序标记在非目录路径无语义） |
| 2 | `@css:` 开头（ignoreCase） | `RNS:43` | 剥前缀重来 |
| 3 | 扩展点 `claimNodeRule` | `RNS:45` | 认领即拥有，不回退内建 |
| 4 | `:` 开头 | `RNS:63` | AllInOne **正则列表**（必须在 `&&` 切分之前） |
| 5 | XPath（`@xpath:`/`@xp:`/`/`） | `RNS:65` | `xpathNodes` |
| 6 | `@json:` 前缀 | `RNS:67` | `JsonPath.read` 取 `List` |
| 7 | `\|\|`/`&&`/`%%` 分支 | `RNS:71` | 组合（见 §2.7） |
| 8 | `$` 开头 | `RNS:83` | `JsonPath.read` |
| 9 | 裸键（`list`） | `RNS:89` → `RR:1732 bareJsonListPath` | JSON 响应补 `$.` 后再试 JsonPath |
| 10 | 兜底 | `RNS:97-100` | `splitIndexSuffix` + `selectLegadoSegments` + `applyIndexTokens` |

### 1.3 字段规则（产 `String?`）

每个条目节点调 `item.value(ruleStr, jsSandbox, body, sourceUrl)`（`RV:45`）：

```
value()                                    RV:45
 ├─ rule 空白 → null                        RV:46
 ├─ 扩展点 dispatcher.claim(rule.trim())     RV:52-65  （处理器认领即拥有；失败 → null + 日志）
 └─ valueBuiltin()                          RV:70
     ├─ groups != null → regexItemValue()   RV:78 → RV:251   （AllInOne 条目专用，见 §2.5）
     ├─ storePutVariables()  @put:{…}        RV:84 → RV:377
     ├─ substituteGetVariables() @get:{…}    RV:85 → RV:386
     ├─ 内联 @js: 前切（## 之前！）           RV:92-105
     ├─ firstTopLevelHashIndex() 摘「花括号外的 ## 段」 RV:112-114 → RV:600
     ├─ 主干空 && 有替换段 → ruleContentText() RV:120 → RV:349
     ├─ evaluateRule()                      RV:121 → RV:126
     └─ applyRegexReplace()                 RV:122 → RV:574
```

`evaluateRule`（`RV:126-210`）内部顺序：

| # | 步骤 | 位置 |
|---|---|---|
| 1 | `\|\|`/`&&`/`%%` 分支切分 + 组合（有内联 `@js:` 或 `<js>` 时**跳过**） | `RV:133-148` |
| 2 | `{{…}}` 展开（`expandBraces`），模板**改变了原文**且无 js 尾段 → 直接返回（模板即最终值） | `RV:150-159` → `RV:217` |
| 3 | 行首 `@js:` / `js:` → `evaluateJs` | `RV:161-168` → `RV:390` |
| 4 | 行内 `@js:`（`findInlineJsMarker`）→ 前段求值成 `result` 交给脚本 | `RV:172-180` |
| 5 | `<js>…</js>`（无前缀段 → 同 `@js:`；有前缀段 → 中间值；`</js>` 后可再接取值路径） | `RV:182-207` |
| 6 | 都否 → `valuePlain` | `RV:209` → `RV:418` |

`valuePlain`（`RV:418-481`）：`http(s)://` 字面量直返（`RV:423`）→ JSON 内容走 `valueJson`（`RV:426`，`RV:554`）
→ HTML 内容走 XPath（`RV:428-433`）或 CSS 段链（`RV:434-479`）。

### 1.4 语法预处理发生在哪一步（本项目 vs 上游的**结构差异**）

| 预处理 | 本项目位置 | 上游位置 | 差异 |
|---|---|---|---|
| 列表前缀 `-`/`+` | `RNS:161`（`stripListPrefixMarkers`）+ `RR:249`/`RR:751` | 上游在目录链路 `BookChapterList.analyzeChapterList` 认 `-`（**本册未读到该文件，标 likely**） | 本项目在取值层**无条件**剥（`RNS:40`），比上游宽 |
| `@css:` | 列表 `RNS:43`（ignoreCase）；字段 `RV:434`（**区分大小写**） | `U/AnalyzeByJSoup.kt:511-513`（`startsWith("@CSS:", true)`，ignoreCase） | **不一致**（见 §3 第 2 行） |
| `@@` 前缀 | 只在 `{{}}` 内剥（`RV:222-223`） | `U/AnalyzeRule.kt:670-673`：**任何规则**都以 `@@` 开头就剥 2 字符 | **不一致** |
| `@xpath:` | `RV:648/661`（`@xpath:`\|`@xp:`，ignoreCase） | `U/AnalyzeRule.kt:675-678`：只有 `@XPath:`（ignoreCase），**没有 `@xp:`** | 本项目多认 `@xp:`（超集） |
| `@json:` | `RV:669/671`（`@json:`，ignoreCase） | `U/AnalyzeRule.kt:680-683`（`@Json:`，ignoreCase） | 一致 |
| 裸 `/` → XPath | `RV:665` | `U/AnalyzeRule.kt:690-693` | 一致 |
| `:` AllInOne | `RNS:63`（`allInOne && startsWith(":")` → `U/AnalyzeRule.kt:599-605`） | 一致 |
| `@js:`/`js:`/`<js>` | `RV:161`、`RV:182`、`RNS:149` | `U/AnalyzeRule.kt:607-617`（`JS_PATTERN` 切段 → `Mode.Js`） | 一致（切法不同，语义近似） |
| 分隔符 `\|\|`/`&&`/`%%` | `RS:105` `splitLegadoBranches` → `RS:118 topLevelSeparators`：跳过 `{{…}}`、`[…]`、引号**和 `##…##` 段**（`RS:130-133`） | `U/RuleAnalyzer.kt:165-237 splitRule`：**只跳过 `[`/`(` 平衡组**，不认 `{{}}`，不认 `##` | **不一致**（见 §3 第 28 行） |
| `##` 替换段 | `RV:600 firstTopLevelHashIndex`：找**花括号外**第一个 `##` | `U/AnalyzeRule.kt:824-834`：`rule.split("##")` 直接切，**在 `{{}}` 展开之后** | **不一致**（见 §3 第 24 行） |
| `@` 段链 | `RV:435`/`RV:691`：`split('@')` + 可选 `@css:` 剥离 | `U/AnalyzeByJSoup.kt:208`（`splitRule("@")`，会 `trim()` 掉前导 `@`/空白） | 基本一致 |
| 索引 `!`/`[…]` | `RS:173 splitIndexSuffix`（只认**后缀**） | `U/AnalyzeByJSoup.kt:401-505 findIndexSet`（后缀式 + 逆向扫描） | 部分不一致（见 §3 第 10 行） |
| **转义** | **没有任何转义机制**：切分只靠「引号/括号/花括号深度感知」（`RS:118`、`RV:600`、`RS:58`） | 上游 `chompRuleBalanced`/`chompCodeBalanced` 有 `\` 转义（`U/RuleAnalyzer.kt:145-148`），`chompCodeBalanced` 有 `ESC`（`U/RuleAnalyzer.kt:104/118`） | **不一致**：本项目无法在规则里用 `\` 保护裸 `@`/`##` |

### 1.5 输出类型

- 列表层：`List<NodeValue>`（`RV:22`：`html:Element?` / `json:Any?` / `rootText:String?` / `groups:List<String>?` 四选一）。
- 字段层：`String?`；`null`＝无值（**不是空串**，调用方用 `?: return@mapNotNull null` 丢条目，见 `RR:258-262`）。
- `NodeValue.bridgeText()`（`RV:337`）是唯一「节点→文本」口径：HTML→`outerHtml`、JSON→合法 JSON 文本、正则条目→`$0`、文档→`rootText`。

---

## 2. 每种语法的求值路径与语义

### 2.1 CSS 选择器（含 `@` 取值、`!` 排除、属性、text vs element）

- **识别方式**：`valuePlain` 里「不是 JSON、不是 XPath、不是字面量 URL」即默认 CSS（`RV:426-434`）；
  列表层是「前面 9 条都不匹配」的兜底（`RNS:97`）。`@css:` 前缀在字段层被 `removePrefix("@css:")` 剥
  （`RV:434`，**case-sensitive**），在列表层 `RNS:43`（ignoreCase）。
- **求值**：`selector.split('@')`（`RV:435`）→ **尾段**是取值模式、前面各段是选择器链（`RV:436-438`）；
  链上每段 `selectLegadoSegment`（`RV:719`），段内形态按固定顺序试：
  `children`（`RV:722`）→ 索引后缀（`RV:723-727`）→ `id.X`（`RV:728`）→ `tag.X`（`RV:733`）→
  `class.X.a:b:c`（`RV:739`）→ `tag.X.a:b:c`（`RV:744`）→ `class.X`（`RV:749`）→ `tag.X.N`（`RV:753`）→
  `class.X.N` / `.X.N`（`RV:760`）→ **原生 CSS** `element.select(trimmed)`（`RV:768`）。
  取值模式（`RV:456-476`）：`html`（克隆去 script/style 后**整组 outerHtml**）、`all`（含 script/style 的整组 outerHtml）、
  `text`（逐个 `element.text()`）、`textNodes`/`textNode`、**其它一律当属性名** `el.attr(rawMode)` 并 `.distinct()`（`RV:475`）。
- **输出**：`texts.joinToString("\n")` 再走 `applyRegexReplace`（`RV:478-479`）；空 → `null`。
- **错误**：字段层**吞异常**（`RV:448` `runCatching{}.getOrDefault(emptyList())`）；列表层**抛**
  （`RV:719` 注释 + `RNS:99`→`selectLegadoSegments`→ `selectLegadoSegment` 不 catch）。
- **与上游一致性**：主体一致（`U/AnalyzeByJSoup.kt:196-219 getResultList` 逐段 `ElementsSingle.getElementsSingle` +
  `getResultLast`），**但有 4 处实测差异**（`text.` 段缺失、`ownText` 缺失、`@CSS:` 大写失效、默认式 `:` 索引语义），见 §3。

### 2.2 XPath

- **识别**：`isXpathRule`（`RV:661`）＝`^@(?:xpath|xp)\s*:\s*`（`RV:648`，ignoreCase）**或** 以 `/` 开头（`RV:665`）。
  上游同一判据但**没有 `@xp:`**（`U/AnalyzeRule.kt:675-678`）。
- **求值器**：`cn.wanghaomiao.xpath.JXDocument`（`RV:3` import，`RV:772 jx(node)`）——**与上游同一库**
  （`U/AnalyzeByXPath.kt:10` `org.seimicrawler.xpath.JXDocument`；`cn.wanghaomiao.xpath` 是同一套件的
  jsoup-xpath/JsoupXpath，包名不同版本）。**不是** JSoup/XsoupXpath 的 CSS 引擎。
- **字段取值**：`xpathTexts(element, path.substringBefore("##"))`（`RV:430`）→ `jx(node).sel(path)` →
  `Element → text().ifBlank { wholeText() }`、`TextNode → getWholeText()`、其它 → `toString()`（`RV:792-802`），
  以 `\n` 拼接，再 `applyRegexReplace`（`RV:432`）。
- **列表取值**：`xpathNodes(Jsoup.parse(body), stripXpathPrefix(rule))`（`RNS:65`）→
  `Element → NodeValue.html`、`TextNode → NodeValue.document(text)`、其它 → `NodeValue.document(toString())`（`RV:779-789`）。
- **输出**：`String?` / `List<NodeValue>`。
- **与上游差异**：
  1. 上游 `getString` 用 `TextUtils.join("\n", jxNodes)`（`U/AnalyzeByXPath.kt:138`），即 `JXNode.toString()`；
     本项目按 `Element.text()` 优先。**文本节点 vs innerText vs outerHtml 三者的取值不同 → needs-runtime-test**（§3 第 14 行）。
  2. 上游对裸片段做**表格修补**：`</td>` 包 `<tr>`、`</tr>`/`</tbody>` 包 `<table>`（`U/AnalyzeByXPath.kt:28-34`）；
     本项目 `jx()`（`RV:772-776`）**没有**这层修补 → 相对路径 `//td/a` 在一段裸 `<td>` 上行为不同（§3 第 15 行）。
  3. XPath 里的单 `|` 并集：两边都不会被当 `||` 切（上游 `splitRule("||")` 是双字符；本项目 `RS:134` 也只认 `||`）→ **一致**。

### 2.3 JSONPath

- **识别**（三条并列）：
  1. 字段层：**只要节点是 JSON，就默认 JSON 模式**（`RV:426` `if (json != null) valueJson(...)`）——
     与上游 `U/AnalyzeRule.kt:685-688`（`isJSON || startsWith("$.") || startsWith("$[")` → Mode.Json）等价；
  2. `@json:` / `@Json:` 显式前缀（`RV:669-673`，ignoreCase）；
  3. 列表层：`$` 开头（`RNS:83`）、`@json:`（`RNS:67`）、裸键（`RNS:89`）。
- **求值**：`valueJson`（`RV:554-571`）：
  `rule.substringBefore("##")`（`RV:557`）→ `{{}}` 内层展开（`RV:558-561`）→ 路径归一
  （`$`/`@` 开头保留；裸键 `^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$` 补 `$.`，`RV:564-568`，正则 `RV:626`）
  → `readJson`（`RV:618`）= `JsonPath.read<Any>(json, normalized)` → `unwrapJsonValue`（`RV:521-536`）：
  `Map`→合法 JSON 文本（`toJsonText`，`RV:539`），`List`→元素含对象/数组则 JSON 文本、单元素则解包、否则按行拼（`RV:526-533`），
  标量→`toString()`（空串→`null`）。
- **输出**：`String?`（对象/数组被序列化成 JSON 字符串，**不是** Java `toString`）。
- **与上游差异**：
  - **裸键补 `$.`**：上游 `U/AnalyzeByJSonPath.kt:48` 直接 `ctx.read(rule)`，路径不以 `$` 开头会抛
    `InvalidPathException` → 被 `onError/printOnDebug` 吞掉 → 返回 `""`。本项目补 `$.` 后**能取到值** →
    **本项目是超集（差异）**，`RV:562` 注释所称「Legado 的裸键简写」在基线源码里**找不到依据**（反驳项，见 §3 第 19 行）。
  - **单花括号遗留语法 `{$.x}`**：上游 `innerRule("{$.")`（`U/AnalyzeByJSonPath.kt:44/82`）**支持**
    `{$.field}` 这种老写法（嵌在普通文本里替换）；本项目只有 `{{…}}`（`RV:628 BRACE_TEMPLATE`）→ **缺失**（§3 第 21 行）。
  - 列表：上游 `getList` 用 `read<List<Any>>` 失败即空（`U/AnalyzeByJSonPath.kt:137-144`）；本项目 `as? List<*> ?: emptyList()`（`RNS:83`）→ 一致。

### 2.4 JavaScript（本文件侧只做「识别 + 转发 + result 绑定」）

- **识别**：`startsWith("@js:") || startsWith("js:")`（`RV:161`）、`<js>…</js>`（`RV:182`）、
  **行内** `@js:`（`findInlineJsMarker`，`RS:147-162`：只在 `{}` 深度 0 命中 `@js:`；行内 `js:` 还要求前导空格/换行）、
  列表层 `isJsRule`（`RNS:149-152`）、`{{…}}` 内的 JS 表达式（`RV:412 isJsExpression`）。
- **转发**：`evaluateJs`（`RV:390-409`）→ `jsSandbox.eval(code, mapOf("result" to …, "src" to …, "baseUrl" to …))`，
  `result` 口径：`rootText != null` → 原文；`json != null` → **Java 结构**（脚本可 `.book_id`）；
  `html != null` → `html()`；否则 `rawBody`。**与上游 `result` 绑「当前被解析内容」同构**（`U/AnalyzeRule.kt:896-904`）。
- **输出**：`String?`（沙箱返回 null → 调用方按分支决定「返回 null」还是「回退 base」）。
- **一致性**：模式识别一致（上游 `JS_PATTERN` 切段 → `Mode.Js`，`U/AnalyzeRule.kt:607-617`）；
  语义细节（Rhino 环境、`java.*` 桥）不在本册范围（另有同事负责 `JsSandbox`）。

### 2.5 正则

三种用法，代码路径**完全不同**：

| 用法 | 识别 | 求值 | 输出 |
|---|---|---|---|
| `##正则##替换` 尾段 | `firstTopLevelHashIndex`（`RV:600`，花括号外第一个 `##`）；列表层不认 | `applyRegexReplace`（`RV:574-591`）：`parts[1]`=pattern、`parts[2]`=replacement，`parts.size>3` → **只取第一个匹配**再替换（`RV:585-587`） | `String`（`null` 输入原样透传，`RV:122`） |
| `:` AllInOne 列表 | `RNS:63`（`:` 开头） | `regexNodes`（`RNS:129-146`）：`&&` 分级，上级**把所有匹配整段串起来**交给下级（`RNS:145`），末级每条=`groupValues` | `List<NodeValue>`（`groups`） |
| 正则条目里的字段规则 | `groups != null`（`RV:78`） | `regexItemValue`（`RV:251-294`）→ `regexLiteral`（`RV:300`）：`@put`→`@get`→摘 `##`→`{{}}`→`$N`（`substituteGroups`，`RV:324`，`$0`…`$99`）→替换 | `String?` |

- `$N` 越界按空串（`RV:325 getOrNull ?: ""`）——上游 `makeUpRule` 是「`size > regType` 才插入，否则什么都不插」（`U/AnalyzeRule.kt:786-791`）→ 等价。
- **正则编译失败**：本项目 `applyRegexReplace` **原值返回**（`RV:584 ?: return value`）；
  上游**退化字面量替换**（`U/AnalyzeRule.kt:566 return result.replace(replaceRegex, replacement)`）；
  `replaceFirst` 分支上游失败时 `return replacement`（`U/AnalyzeRule.kt:560`）。→ **差异**（§3 第 31 行）。
- **整条以 `##` 起头**：本项目拿 `ruleContentText`（`RV:120`/`RV:349`：文档节点优先 `rootText` 原文，
  条目节点 `outerHtml`）；上游走 `AnalyzeByJSoup.getStringList("")` → `SourceRule.elementsRule` 为空 →
  `element.data()`（`U/AnalyzeByJSoup.kt:77-79`，即脚本/样式 **DataNode** 内容，不是原文）→ **差异**（§3 第 32 行）。

### 2.6 变量替换

| 写法 | 识别/求值 | 位置 |
|---|---|---|
| `@put:{k:规则, k2:规则2}` | `PUT_VARIABLE = @put:\{([^{}]*?)\}`（ignoreCase）→ `putPairs` 顶层逗号切分/严格 JSON 优先 → 逐键 `value()` 存表 → 整段替换成 `""` | `RV:630`、`RV:377-383`、`RS:31-55` |
| `@get:{k}` | `GET_VARIABLE`（ignoreCase）→ 查表，未命中 → `""` | `RV:631`、`RV:386-388` |
| `{{k}}` | `expandBraces` 先查表命中即用 | `RV:226` |
| `{{$.x}}` / `{{路径}}` | 非 JS 表达式且不含 `\|\|` → `valuePlain(inner)`；含 `\|\|` → `splitLegadoAlternatives` 逐个试，取第一个非空白 | `RV:230-233` |
| `{{js 表达式}}` | `isJsExpression`（`RV:412-416`：不以 `$`/`..` 开头、不是裸键、且含 `(` 或以 `java|cookie|source|book|chapter|result|baseUrl|key|page` 开头）→ `evaluateJs` | `RV:412`、`RV:229` |
| `{{@@xxx}}` | `@@` 剥掉再求值 | `RV:222-223` |
| `\|\|` 兜底 | 外层分支（§2.7）；`{{}}` 内部另有一套（`RV:231`） | — |
| `&&` 串接 | 外层每个分支都取值，`\n` 拼接 | `RV:144` |
| `%%` 串接 | 以**第一支行数**为准逐行交错（`interleaveLines`，`RV:364`） | `RV:145` |

**关键顺序**：`@put` → `@get` → 内联 `@js` 前切 → 摘 `##` → `{{}}` 展开 → 取值/JS。
上游是 `@put`（`U/AnalyzeRule.kt:698`）→ `@get`+`{{}}`（同一 `evalPattern`，`U/AnalyzeRule.kt:702-733`）→ 再 `splitRegex` 摘 `##`（`U/AnalyzeRule.kt:744-748`）→ `##` 在 `makeUpRule` **末尾**才切（`U/AnalyzeRule.kt:824`）。
→ 即**上游先展开 `{{}}` 再切 `##`，本项目先切 `##` 再展开**；`{{}}` 结果里含 `##` 时行为不同（§3 第 24 行）。

### 2.7 规则嵌套与串接

- **分支组合**（`RS:105 splitLegadoBranches` + `RS:118 topLevelSeparators`）：
  **无优先级、最左边的分隔符说了算**（`RS:107`）；`||` 取首个非空白（`RV:146`、`RNS:79`）、
  `&&` 并集（`RV:144` 按 `\n` 拼、`RNS:77` `flatMap{}.distinct()`）、`%%` 逐位交错
  （`RV:145`/`RNS:78`，以第一支长度为界）。上游同一套三种组合（`U/AnalyzeByJSoup.kt:68-122`、
  `U/AnalyzeByJSonPath.kt:74-126`、`U/AnalyzeByXPath.kt:92-131`、`U/AnalyzeByRegex.kt:32-59`）→ **一致**。
- **段与段的串接**：`@` 链（`RV:435`）、`<js>…</js>` + 后置路径（`RV:193`/`RV:206`/`RV:272`、
  `RR:869-874`）、`@js:` 前段 + 脚本（`RV:97`/`RV:176`）、`##` 尾段（`RV:122`）。
- **`&&` 的语义有两套**：规则组合用（`||`/`&&`/`%%`）与 **AllInOne 正则分级**用（`RNS:130`）。
  后者必须在组合切分**之前**处理（`RNS:61-63` 注释）——本项目做到了，上游 `splitSourceRule(allInOne=true)`
  也是先判 `:`（`U/AnalyzeRule.kt:599`）→ 一致。

### 2.8 内容解析（`LooseJson` / `applyReplaceEntry` / `ContentProcessor` vs `ContentPipeline`）

**结论先说：`ContentPipeline` 与 `ContentProcessor` 不是「谁替代谁」，是两件不同的事，都在用。**

| 文件 | 是什么 | 调用方 | 行数 |
|---|---|---|---|
| `content/ContentPipeline.kt` | 只有一个函数 `applyReplaceEntry(entry, text)`：处理 **`ruleContent.replaceRegex` 这个书源字段**（`##正则删##`、`##正则##替换`、`###` 只首个） | `RR:977`（正文分页循环内，对 `patterns` 逐条应用，`patterns` 来自 `rule.string("replaceRegex")` 按 `[\r\n]+\|&&` 切，`RR:935-937`） | 37 |
| `content/ContentProcessor.kt` | `object`：**用户「替换规则」（`ReplaceRule` 表）** 的作用域匹配（`matchesScope`）+ 正文/标题净化链（`processContent`/`processTitle`/`applyRule`），支持 `@js:`/`<js>` 作替换串 | `RR:925-926`、`RR:1025-1027`、`http/ReadingRoutes.kt:167-168`、`http/ReplaceRulesRoutes.kt:115-116`、`data/ReplaceRuleDao.kt:135` | 184 |

→ `ContentPipeline` 不是 `ContentProcessor` 的替代品，也**不是**正文管道主链（名字有误导性）；
按行数猜「谁替代谁」会猜错（confirmed，两处调用点实测）。

`LooseJson`（`LJ:19-200`）：把书源里**手写 JS 对象字面量** `,{…}` 规范化成严格 JSON：
单引号键值、裸标识符键、全角引号、裸换行、尾随逗号、`//`/`/* */` 注释（`LJ:24-80`），
`extractTail`（`LJ:149-192`）按花括号配对切 URL 尾巴。**只规范化不求值**（`{{key}}` 原样留）。
调用方：`RR:1138`（`splitUrlOptions`）、`RR:1559`（`absolute()` 拼参数）、`RuleUrlSupport.kt:49`（headers）、
`LooseJsonTest`/`LooseUrlOptionsTest`。上游对应「先 GSONStrict 再宽松 GSON + 提示」（`LJ:6-8` 注释所指）
→ 语义近似、实现不同（本项目无 GSON）：差异但目的相同（§3 第 41 行）。

---

## 3. 兼容性判定表（本册核心产出）

判定口径：**一致**＝与 `U/`（ref-legadoteam 镜像仓）逐行对照语义相同；**差异**＝两边行为可区分；
**缺失**＝上游有、本项目无；**未确认**＝需跑起来或需第三方库内部知识。

| # | 语法/能力 | 识别入口 (file:line) | 求值实现 (file:line) | 判定 | 差异说明（输入 → 上游 / 本项目） | 证据强度 |
|---|---|---|---|---|---|---|
| 1 | `@css:` 小写前缀 | `RV:434` `removePrefix("@css:")`；列表 `RNS:43` | `RV:435-479` | 一致 | 两边都剥前缀当原生 CSS | confirmed |
| 2 | `@CSS:` **大写**前缀 | `RV:434`（`removePrefix` **区分大小写**） | — | **差异** | 输入 `@CSS:.book@text` → 上游 `substring(5)`（`U/AnalyzeByJSoup.kt:511-513`，ignoreCase）→ 取到书名文本；本项目前缀没剥 → `@` 切成 `["", "CSS:.book", "text"]` → 尾段 `text`、链段 `CSS:.book` → `element.select("CSS:.book")` 抛 `SelectorParseException` 被 `RV:448` 吞掉 → **`null`**（字段静默为空）。列表层 `RNS:43` 用 ignoreCase，所以同一写法「列表能选、字段为空」。**该前缀在真实语料里确实存在**：`backup/LegacyBackup.kt:191` 专门用 `startsWith("@CSS:", ignoreCase=true)` 保护老规则不被改写，`LegacyBackupTest.kt:104` 断言 `@CSS:.a&&.b` 原样透传 | confirmed（源码可判） |
| 3 | 规则级 `@@` 前缀 | 只在 `{{}}` 内剥：`RV:222-223` | — | **差异** | 输入 `@@class.book@text` → 上游任何规则都先 `substring(2)`（`U/AnalyzeRule.kt:670-673`）→ 等价于 `class.book@text`；本项目不剥，靠 `@` 切分后空段被 `filter{isNotBlank}` 过滤**碰巧等价**；但 `@@.book`（无 `class.`）→ 本项目尾段 `.book` 被当属性名 → `null`，上游 → `.book` 当选择器 → 取文本。**结果依赖写法，属未定义行为** | confirmed（源码）/ needs-runtime-test（真实语料占比） |
| 4 | `class.X` / `tag.X` / `id.X` / `children` / 原生 CSS 段 | `RV:728-752`（正则 `RV:651-656`）；链式 `RV:691 selectLegadoSegments` | `element.getElementById` / `getElementsByTag` / `select(".X")` / `element.select(sel)` | 一致 | 与 `U/AnalyzeByJSoup.kt:305-317`（`beforeRule.split(".")` → children/class/tag/id(text)/select）同构。注：上游 `id.` 用 `Collector.collect(Evaluator.Id)`，本项目 `Element.getElementById`，两者都是**子树内**查找 | confirmed（源码结构一致）/ likely（`getElementById` 与 `Evaluator.Id` 边界差异未实测） |
| 5 | `text.X` 段（含指定文本的元素） | **无识别**（`RV:719-768` 的 `when` 无 `text.` 分支） | `RV:768 element.select("text.X")` | **缺失** | 输入 `text.最新章节` → 上游 `temp.getElementsContainingOwnText("最新章节")`（`U/AnalyzeByJSoup.kt:314`）→ 命中「自身文本含该串」的元素；本项目把它当**原生 CSS**（标签名 `text` + class `最新章节`，jsoup 合法）→ 除非页面真有 `<text class="最新章节">`，否则**恒空 → `null`**。不报错，静默失效 | confirmed |
| 6 | `ownText` 取值模式 | `RV:706`（`isValueModeSegment` 含 `ownText`） | `RV:475` `el.attr("ownText")` | **差异（实际缺失）** | 输入 `class.x@ownText` → 上游 `element.ownText()`（`U/AnalyzeByJSoup.kt:248-253`）→ 只含直系文本；本项目 `isValueModeSegment` 认了它（不进选择器链），但 `valuePlain` 的 `when(rawMode)` **没有 `ownText` 分支**（`RV:456-476`）→ 落到 `else -> attr("ownText")` → 属性不存在 → **恒 `null`** | confirmed |
| 7 | `text` / `html` / `all` / `textNodes` / 任意属性 | `RV:437`（尾段即模式，缺省 `text`）；`RV:703` | `RV:461-475` | 一致 | `html`＝去 script/style 后整组 `outerHtml`（本项目 `RV:461-466` 克隆后处理，上游 `U/AnalyzeByJSoup.kt:255-262` 直接 `elements.select(...).remove()` 改 DOM）；属性值去重（`RV:475 distinct` ↔ `U/:269 textS.contains(url)`）→ 语义一致，**副作用不同**（上游会污染后续规则所用的 DOM） | confirmed |
| 8 | `!N` 排除索引 | `RS:184`（后缀正则） | `RS:199-201` `filterIndexed` | 一致 | `tag.li!0` → 两边都是「从匹配列表里剔除第 0 个」（`U/AnalyzeByJSoup.kt:381-386 deselect`） | confirmed |
| 9 | `[a:b:c]` / `[!…]` 索引区间（闭区间、负数、步长） | `RS:177-182` | `RS:221-266 parseIndexSpec` | 一致 | `[0:4]`＝0..4、`[-1:0]`＝整表倒序、越界两端夹紧、「同侧越界作废」——逐条对照 `U/AnalyzeByJSoup.kt:334-366` | confirmed |
| 10 | **默认式 `:` 索引**（`tag.li.0:2`） | `RV:658-659`（`CLASS_INDEX_SPEC`/`TAG_INDEX_SPEC`） | `RV:739-748` → `parseIndexSpec("0:2")` | **差异** | 输入 `class.tag.0:2` → 上游 `findIndexSet` 的**非 `[]` 分支**把 `:` 当**分隔符**（`U/AnalyzeByJSoup.kt:486-494`），只收单索引 → 取出**第 0、第 2 两个**元素；本项目把 `0:2` 当**区间**（`RS:227-259`）→ 取出**第 0、1、2 三个**。`tag.div.-1:10:2` 差别更大：上游取 3 个单索引（-1→末、10、2），本项目按 `start=size-1,end=10,step=2` 反向区间 | confirmed（源码可判）；真实语料命中率 needs-runtime-test（本项目注释自称 `.book_tag.0:1:2` 是真实写法，`RS:657-659`） |
| 11 | 段内混写 `class.x.0` / `li.0` / `tag.li.-1`（非负索引） | `RV:654-656` | `RV:753-767` | 一致 | `class.x.0`＝第 0 个、`li.0`＝第 0 个 `li`、`tag.li.-1`＝末位（`RS:262` 负数转正 ↔ `U/AnalyzeByJSoup.kt:486-494`） | confirmed |
| 11b | **裸标签名 + 负索引**（`li.-1` / `.x.-1`） | `RV:654`（`TAG_INDEXED` 只认 `\\d+`）、`RV:656`（`CLASS_DOT_INDEXED` 同） | → 落到 `RV:768 element.select(...)` | **差异** | 输入 `li.-1` → 上游 `findIndexSet` 的「原本写法」分支认负号（`U/AnalyzeByJSoup.kt:483/488`）→ **最后一个 `li`**；本项目正则不接受负号 → `element.select("li.-1")` → jsoup 解析异常被 `RV:448` 吞掉 → **`null`**。只有写成 `tag.li.-1` 才走 `TAG_INDEX_SPEC`（`RV:658`）才对 | confirmed |
| 12 | `@` 多段属性链（`class.a@tag.li@href`） | `RV:435`；列表 `RV:691` | 逐段 `selectLegadoSegment`（`RV:440-454`） | 一致 | 对照 `U/AnalyzeByJSoup.kt:196-219 getResultList`（尾段取值、前段选元素） | confirmed |
| 13 | `@XPath:` / `@xp:` 前缀 | `RV:648`（`@xpath:`\|`@xp:`，ignoreCase） | `RV:429-433` | **差异（超集）** | 上游只认 `@XPath:`（`U/AnalyzeRule.kt:675-678`）；`@xp:` 是本项目**自加**的别名 → 对上游源无影响，但「本项目写的源」不可回灌上游 | confirmed |
| 14 | XPath 文本取值口径 | `RV:430`/`RV:792-802` | `item.text().ifBlank{ wholeText() }` | **未确认** | 输入 `//div[@id=a]` → 上游 `TextUtils.join("\n", jxNodes)`（`U/AnalyzeByXPath.kt:138`，即 `JXNode.toString()`，对元素节点是 **outerHtml 或 innerText** 取决于库实现）；本项目取 `Element.text()`（可见文本）。含子标签/`<br>` 时结果可能不同 | needs-runtime-test：同一 HTML 上跑 `@xpath://div[@id=a]`，比「本项目输出」与「JXNode.toString 输出」；或直接读 `jsoup-xpath` 的 `JXNode.toString()` 实现 |
| 15 | XPath 裸表格片段（`<td>`/`<tr>`） | `RV:772-776 jx()` | `JXDocument(node)` | **差异** | 输入以 `</td>` 结尾的片段 + `//a` → 上游先包 `<tr>`/`<table>` 再解析（`U/AnalyzeByXPath.kt:28-34`）→ 能选到；本项目直接喂 JXDocument → 表格结构缺失，相对/绝对路径可能全空 | confirmed（代码差异）/ needs-runtime-test（是否真空） |
| 16 | XPath 中 `\|` 并集不被当 `\|\|` | `RS:134`（只认 `\|\|`） | — | 一致 | `//div\|//span` 两边都不切分 | confirmed |
| 17 | `@json:` / `@Json:` 前缀 | `RV:669-673` | `RV:426 valueJson` | 一致 | `U/AnalyzeRule.kt:680-683` | confirmed |
| 18 | `$.` / `$[` JSONPath | `RV:426`（JSON 节点默认 JSON 模式）/ `RNS:83` | `RV:618 readJson` → Jayway `JsonPath.read` | 一致 | 上游 `U/AnalyzeRule.kt:685-688` 同判据、`U/AnalyzeByJSonPath.kt:48` 同库同方法 | confirmed |
| 19 | **裸键** `book_name`（JSON 内容） | `RV:564-568`（`BARE_JSON_KEY`，`RV:626`）；列表 `RNS:89`→`RR:1732` | `RV:566 "$." + template` | **差异（本项目超集）** | 输入 `{"book_name":"x"}` + 规则 `book_name` → 上游 `ctx.read("book_name")` 抛 `InvalidPathException`（路径必须以 `$` 开始）→ 吞掉 → **`""`**；本项目补成 `$.book_name` → **`"x"`**。⚠️ `RV:562` 注释「Legado 的裸键简写…番茄等官方接口源大量使用」在基线源码里**无依据**，《`compatibility.md`》也未声明此超集 | confirmed（上游行为由 Jayway 强制 `$` 前缀推出）→ 结论 needs-runtime-test（跑一次上游对比即可定案） |
| 20 | JSON 对象/数组→文本序列化 | `RV:521-541` | `Json.encodeToString(JsonElement)` 合法 JSON | **差异（本项目更正确）** | 输入 `$.data`（对象）→ 上游 `ob.toString()` = Java Map 的 `{k=v}`（`U/AnalyzeByJSonPath.kt:52`），非合法 JSON；本项目输出合法 JSON 文本。后续若再接 JSONPath/JS，两边结果不同 | confirmed |
| 21 | 单花括号遗留插值 `{$.x}` | **无识别** | — | **缺失** | 输入 `作者：{$.author}` → 上游 `innerRule("{$.")` 会就地替换成值（`U/AnalyzeByJSonPath.kt:44`/`:82`）；本项目 `BRACE_TEMPLATE` 只认 `{{…}}`（`RV:628`）→ 原样输出 `作者：{$.author}`（若节点是 JSON 且整条被当路径还会失败得 `null`） | confirmed（代码缺失）；语料是否还在用 needs-runtime-test（`grep -c '{$.'` 扫全库书源） |
| 22 | `{{…}}` 插值 | `RV:628` / `RV:150-159` / `RV:217-234` | `expandBraces` | **差异（详见 23/24）** | 主体能力一致：`{{$.x}}`、`{{变量}}`、`{{@@sel}}` 都能展开 | confirmed |
| 23 | `{{}}` 内「是 JS 还是取值路径」的判定 | `RV:412-416 isJsExpression` | JS→`evaluateJs`；否则 `valuePlain` | **差异** | 输入 `{{#bookIntro@text}}`（无 `@@`）→ 上游 `isRule` 认为「不以 `@`/`$.`/`$[`/`//` 开头 → 是 JS」→ `evalJS("#bookIntro@text")` → 语法错 → 空；本项目判定「不含 `(` 且不以 `java./result.` 等开头 → 不是 JS」→ **当 CSS 取值成功**。反向例子：`{{$.a.length}}` 两边都当路径 | confirmed（启发式不同）；哪种更接近真实意图 needs-runtime-test |
| 24 | `{{}}` 与 `##` 的先后 | `RV:112-114`（先摘 `##`） | `RV:122 applyRegexReplace` | **差异（方向：本项目更安全）** | 输入 `{{$.intro}}##<br>## `，若 `intro` 值本身含 `##` → 上游先展开 `{{}}` 再 `rule.split("##")`（`U/AnalyzeRule.kt:824-834`）→ 值里的 `##` 被当替换段切错；本项目先按**花括号外**切（`RV:600`）→ 只认规则自己写的 `##`。另一面：`{{}}` 展开出 `$1` 时上游会当分组引用、本项目不会 | confirmed（源码顺序可判） |
| 25 | `\|\|` 首个非空 | `RS:105`+`RV:146`/`RNS:79`/`RV:231` | 逐分支求值，取第一个 non-blank | 一致 | `U/RuleAnalyzer.kt:165`+`U/AnalyzeByJSoup.kt:102` | confirmed |
| 26 | `&&` 并集 | `RV:144`（`\n` 拼）/ `RNS:77`（`flatMap{}.distinct()`） | — | 一致 | 上游 `addAll` 后 `getString` 用 `\n` 拼（`U/AnalyzeByJSoup.kt:55`、`:114-118`） | confirmed |
| 27 | `%%` 逐位交错 | `RV:145 interleaveLines` / `RNS:78 interleaveNodes` | 以第一支为界 | 一致 | `U/AnalyzeByJSoup.kt:106-113` | confirmed |
| 28 | 分支切分的**深度感知** | `RS:118-141`（跳 `{{}}`/`[]`/引号/**`##` 段**） | — | **差异** | 输入 `{{$.a\|\|$.b}}xx`：上游 `splitRule("&&","\|\|","%%")` **不认 `{{}}`**（`U/RuleAnalyzer.kt:185` 只找 `[`/`(`）→ 会在花括号内切开 → 外层多出一个分支；本项目把它当占位符内部备选（`RV:131` 注释、`RS:128`）。反例：`##a\|\|b##$1` 上游会在正则里切、本项目不会 | confirmed（源码可判）；哪边更常命中 needs-runtime-test（扫库统计含 `##`+`\|\|` 的规则数） |
| 29 | `##正则##替换` | `RV:600`/`RV:574-591`；正文 `CPL:17-37` | `Regex(pattern).replace` | 一致 | 两段式替换、`parts.size>3`→只取第一个匹配（`U/AnalyzeRule.kt:549-559`） | confirmed |
| 30 | `##正则##替换###` 首个匹配 | `RV:585-587` | `regex.find(value).value.replace(...)`；无匹配→`""` | 一致 | `U/AnalyzeRule.kt:554-558`（无匹配 `return ""`） | confirmed |
| 31 | 正则**编译失败** | `RV:584` | `?: return value` | **差异** | 输入 `##([未闭合##替换` → 上游 `compileRegexCache` 返回 null → `result.replace(replaceRegex, replacement)` **字面量替换**（`U/AnalyzeRule.kt:566`）；`###` 分支上游直接 `return replacement`（`:560`）；本项目**原值返回**（不改）。另：`CPL:29-30` 在 `ruleContent.replaceRegex` 上又是**字面量替换** → 项目内三处三种行为 | confirmed |
| 32 | 整条规则以 `##` 起头（无主干） | `RV:120`→`RV:349 ruleContentText` | `rootText` 原文 / 条目 `outerHtml` | **差异（对象不同）** | 输入 `##data-bid="([^"]+)"##$1###` → 上游 `getString` 里 `if (rule.isNotBlank() \|\| replaceRegex.isEmpty())`（`U/AnalyzeRule.kt:346`）**主干为空且有替换段 → 整段跳过取值**，直接 `replaceRegex(result.toString(), …)`（`:362`），而 `result` 是**当前内容的 Jsoup Document/Element** → `toString()` 是**再序列化后的 HTML**（属性引号/自闭合会被改写）；本项目用 `rootText`＝**响应原文**（`RV:346-348` 注释明说「html.html() 会重新序列化，`##data-bid="…"##` 这种按源码写的正则对不上」）→ 对**按源码写正则**的规则本项目能命中、上游可能对不上；对**依赖 Jsoup 归一化**的正则则相反 | confirmed（两侧实现不同；方向需真实源验证） |
| 33 | `@put:{…}` 多键 | `RV:630` + `RS:31-55 putPairs` | 严格 JSON 优先 → 顶层逗号切 | 一致（本项目更宽容） | 上游 `GSONStrict` 失败即宽松 GSON（`U/AnalyzeRule.kt:516-539`）；本项目手写解析，能吃「值里带 `:`/`,`/`[]`/`{}`」 | confirmed |
| 34 | `@get:{k}` 与 `{{k}}` 同一张表 | `RV:631`/`RV:386-388` + `RV:226` | — | 一致 | 上游 `evalPattern` 同时匹配两者（`U/AnalyzeRule.kt:702-733`） | confirmed |
| 35 | 变量**作用域/生命周期** | `RV:43`、`RR:135`、`RV:515-519` | 节点级 + 进程级 LRU（键=URL） | **差异（重大）** | 见 §4：上游是 chapter→book→ruleData→**source 持久变量**四级链（`U/AnalyzeRule.kt:856-891`）；本项目只有「节点内存」+「进程 URL 缓存」，没有书级/章级隔离，也没有 `@put`→书源持久变量 | confirmed |
| 36 | `@js:` / `js:` / `<js>…</js>` 识别 | `RV:161`/`RV:182`/`RS:147`/`RNS:149` | `RV:390 evaluateJs` | 一致 | 上游 `JS_PATTERN` 切段（`U/AnalyzeRule.kt:607-617`） | confirmed（识别层） |
| 37 | `<js>` 之后接取值路径 | `RV:182-207`（`NodeValue.document(evaluated).value(postRule)`）、`RR:869-874` | 新建节点继续取值 | 一致 | 上游 `splitSourceRule` 产出 `[Mode.Js, Mode.Default]` 多段顺序求值（同一效果） | confirmed |
| 38 | `:` AllInOne 正则列表 + `$N` | `RNS:63`/`RNS:129-146`；字段 `RV:251-294`/`RV:324` | `Regex.findAll` + `groupValues` | 一致 | `U/AnalyzeRule.kt:599-605`、`U/AnalyzeByRegex.kt:32-59`；`&&` 多级「上级串所有匹配」也一致（`RNS:145` ↔ `U/AnalyzeByRegex.kt:52-57`） | confirmed |
| 39 | `%%`/`&&` 在**列表**层的组合 | `RNS:76-80` | — | 一致 | `U/AnalyzeByJSoup.kt:106-122 getStringList` 与 `:175-189 getElements` | confirmed |
| 40 | 列表规则 JS（`<js>` 产出 JSON 数组） | `RNS:149 isJsRule` → `RR:867 jsListNodes` | 解析 `JsonArray` → `NodeValue.json(toPlainJava())` | 一致（形态不同） | 上游 `Mode.Js` → `getElements` 里 `evalJS` 返回 list of Map（`U/AnalyzeRule.kt:470`）；本项目要求**合法 JSON 数组**，否则 `emptyList()`（`RR:875`）→ 脚本返回逗号串/JS 数组字面量时上游可能能接、本项目丢弃 | confirmed（代码）/ needs-runtime-test（脚本返回非 JSON 时上游怎么办） |
| 41 | 宽松 JSON（URL 参数尾巴） | `LJ:24`、`RR:1138`、`RR:1559` | `LooseJson.toStrict` | **差异（实现不同，目的相同）** | 上游 `GSONStrict`→失败→宽松 `GSON` + 日志（`LJ:6-8` 注释所指）；本项目手写规范化（单引号/裸键/全角引号/尾逗号/注释）。**本项目只规范化不求值**，`{{key}}` 原样留到 `renderUrl` | confirmed |
| 42 | `ruleContent.replaceRegex` 字段 | `RR:935-937`→`CPL:17` | `applyReplaceEntry` | **差异** | 上游把这个字段当**一条规则串**喂给 `SourceRule`（走取值层，`CPL:8-15` 注释自述）；本项目**不走取值层**，直接当「删/替换」用；非 `##` 开头时**故意偏离**上游（上游当取值规则跑，本项目当纯正则删除，`CPL:20-24`）→ 已知且有意 | confirmed（代码+注释双向印证） |
| 43 | 用户「替换规则」表（`ReplaceRule`） | `CPR:14-60 matchesScope`、`CPR:65-83 processContent` | `CPR:110-183 applyRule` | 未确认（与上游 ReplaceRule 未对照） | 作用域分词用 `[\r\n,;+]+`、大小写不敏感 contains、再退正则（`CPR:41-60`）；`isRegex` 时支持 `@js:`/`<js>` 作替换串、逐匹配求值（`CPR:126-163`）。上游 `ReplaceRule` 的 scope 分词/正则口径**本册未取到证据** | needs-runtime-test（或另立册对照上游 `ReplaceRule`） |
| 44 | `##` 与 `\|\|` 同时出现时的列表规则 | `RNS:71`（先切分支） | — | 未确认 | 列表层不摘 `##`（`##` 只在字段层 `RV:112` 生效）→ `class.a##x##y` 作为列表规则会整串进 jsoup → 报错；上游 `getStringList` 也先 `splitRule` 再 `select`，同样不摘 → **行为相同**（都失败），故不列为差异，仅记录 | likely |

| 45 | URL 型取值（`isUrl` 单值化） | 本项目无对应开关 | `RR:1554 absolute()` / `RuleHttp.renderUrl` | **未确认** | 上游 `getString(rule, isUrl=true)` 走 `getString0`（**只取第一个元素**）→ 空则回 `baseUrl` → `getAbsoluteURL`（`U/AnalyzeRule.kt:352-354`、`:373-380`）；本项目列表/URL 渲染是另一条链路（`renderUrl` + `absolute`），是否存在「多元素时取第一个」的等价约束本册未核实 | needs-runtime-test |

**小计**：共 **46 条**——**一致 20 条**（#1,4,7,8,9,11,12,16,17,18,25,26,27,29,30,33,34,36,37,38,39 共 21 条，其中 #7 注明「语义一致、副作用不同」）、
**差异 19 条**（#2,3,6,10,11b,13,15,19,20,22,23,24,28,31,32,35,40,41,42）、**缺失 2 条**（#5,21）、
**未确认 4 条**（#14,43,44,45）。合计 21+19+2+4 = 46。
（#6 判定写「差异（实际缺失）」，按差异计入；#19 的**判定**是差异，**结论定案**仍需运行时对比，见 §7.3。）

---

## 4. 变量系统的隔离与传递（负责人指定项）

### 4.1 两个容器

| 容器 | 定义 | 类型/容量 | 键 | 生命周期 |
|---|---|---|---|---|
| `NodeValue.ruleVariables` | `RV:43` `mutableMapOf<String,String>()` | 普通 `MutableMap`，**无上限** | 变量名 | **跟着节点对象**：列表条目节点、目录条目节点、正文页节点各一份；节点被回收即消失 |
| `RuleRunner.ruleData` | `RR:135` `newRuleDataCache(4096)`（`RR:1604` `MAX_RULE_DATA_KEYS`） | `Collections.synchronizedMap(LinkedHashMap(accessOrder=true))`，超限**淘汰最久未用**（`RR:1750-1757`） | **URL 字符串**：`bookUrl`（搜索/详情后）、`tocUrl`（详情后）、`pageUrl`（目录页/正文页） | **进程级**，无 TTL、**无显式清理**（全仓共 10 处引用：`RR:135/137/142/273/647/690/814/957/1041/1045`，`grep` 无 `clear()`） |

### 4.2 传递链（`@put` 写入 → 跨阶段 `@get` 读回）

```
搜索/发现   bookItems:273        rememberRuleData(bookUrl, item.snapshotVariables())   RV:515
详情        declarativeDetails   recallRuleData(bookUrl) → baseDoc.seedVariables()      RR:647-648
            （init 另起节点时再灌一次）root.seedVariables(seedVars)                      RR:660-661
            写出               rememberRuleData(tocUrl, recall(bookUrl)+root.snapshot()) RR:690
目录        parseTocPage          recallRuleData(pageUrl) → 每个条目节点 seedVariables  RR:814/829
            nextTocUrl 节点      .also{ it.seedVariables(seedVars) }                     RR:841
正文        contentPage           recallRuleData(bookUrl) → .also{ seedVariables(vars) } RR:957/1041/1045
```

（`snapshotVariables`/`seedVariables` 定义在 `RV:515-519`；`seedVariables` 是 `putAll`，**只增不删**。）

### 4.3 与上游的粒度差异（**这是并发/多用户场景的关键**）

上游 `AnalyzeRule.put/get` 是**四级回落链**（`U/AnalyzeRule.kt:856-891`）：
`chapter?.putVariable` → `book?.putVariable` → `ruleData?.putVariable` → `source?.put(k,v)`；`get` 亦然，
并特判 `bookName`/`title`。即上游粒度 = **章节 / 书 / 书的 ruleData / 书源（可持久化）**。

本项目：
1. **没有章级/书级隔离**。变量只活在「某个 NodeValue」和「某个 URL 键」上；
2. 上游落在**书源**（`source.put`，可持久、可导出）的那一类 `@put`，本项目落在**进程 LRU**：
   进程重启即丢，且不属于任何书源对象；
3. 键是 **URL 字符串**，不是「书源 + 书」二元组。

### 4.4 并发会不会串号（回答负责人的问题）

- `RuleRunner` 在 `Application.kt:168` **只实例化一次**，随后注进全部路由（`Application.kt:292`）与后台离线缓存
  （`Application.kt:172` `BookCacheService(database, runner, …)`）→ `ruleData` 是**全进程共享**的（confirmed）；
  即「用户请求」与「后台整本离线缓存」也会抢同一张变量表。
- **不同书/不同 URL**：键不同 → 不会串（但键相同的概率不为 0：同一本书被两人同时读、同一 `bookUrl`
  被两次搜索命中、`tocUrl` 与别人 `bookUrl` 字面相同等）。
- **同一 URL 并发**：`rememberRuleData` 是 `put`（无 CAS、无版本），**后写覆盖前写**；`seedVariables` 是「读快照→灌进节点」，
  所以**A 请求可能读到 B 请求刚写下的变量**。变量值一般是「本书的 comic_id」这类同名同值的派生量，
  多数情况无感；但若两家书源/两次搜索对同一 URL 产出不同 `@put`（例如搜索命中不同版本），就会**互相污染**。
- 上游用 `source`/`book`/`chapter` 对象承载 → 天然按对象隔离；本项目把「对象作用域」压成了「URL 作用域」+「节点作用域」。
- **无清理点**：没有任何代码在「书读完/请求结束/书源删除」时清理 `ruleData`，LRU 4096 是唯一的回收机制
  （`RR:131-133` 注释解释「整表 clear 会抹掉别的书」——修的是另一个 bug，代价是**永不主动失效**）。
  → 建议在 rebuild 阶段明确「按 `sourceId+bookUrl` 双键 + 请求结束即释放 + 上限」的策略。

---

## 5. 错误处理

| 场景 | 行为 | 位置 |
|---|---|---|
| 规则为空/空白 | 返回 `null`（不是 `""`） | `RV:46`、`RV:76`、`RV:86` || 取值无结果（选择器没选中 / JSONPath 空） | 返回 `null` | `RV:455`、`RV:477`、`RV:569` |
| **字段层** CSS 写坏（`SelectorParseException`） | **吞掉**，`getOrDefault(emptyList())` → 该字段 `null`，条目其余字段照旧 | `RV:448`（注释：上游 `getResultLast` 也不抛） |
| **列表层** CSS 写坏 | **抛** `SelectorParseException` → `bookItems` 包装成 `RuleExecutionException`，带上「上游那句话」 | `RV:719` 注释、`RNS:99`、`RR:251-257`、`RR:228-237 upstreamReason` |
| 正则列表编译失败 | 抛 `RuleExecutionException("正则列表规则无法编译：…")` | `RNS:137-141` |
| `##` 正则编译失败 | 字段层原值返回（`RV:584`）；`replaceRegex` 字段字面量替换（`CPL:29-30`） | 见 §3 #31 |
| JSONPath 异常 | `runCatching{}.getOrNull()` → `null`（**无日志**） | `RV:618-622` |
| XPath 异常 | `runCatching{}.getOrDefault(emptyList())` → `null`（**无日志**） | `RV:779-789`、`RV:792-802` |
| JS 执行失败 | `evaluateJs` 返回 `null`；`@js:` 分支**如实为空**（不再拿整页正文冒充）；调用方可能看到 `jsSandbox.lastError` | `RV:163-167`、`RR:1012` |
| 扩展点处理器失败 | 记一行 `runtime.log`，返回 `null`（**认领即拥有，不回退内建**） | `RV:54-64`、`RNS:47-55` |
| 正文取不到 | `RuleExecutionException("正文规则未提取到内容，脚本异常：…")` | `RR:1011-1014` |
| 列表规则失败 | `RuleExecutionException(error.class：msg｜上游那句话：「…」)` | `RR:228-237`、`RR:251-257` |
| 上游响应为空/缺规则 | 明确的 `RuleExecutionException`（0 字节/缺 bookList/searchUrl/ruleContent） | `RR:243-244`、`SearchFlow.kt:63-72`、`RR:932-933` |

**返回契约的总差异（重要）**：上游 `AnalyzeRule.getString` 末尾 `if (result == null) result = ""`
（`U/AnalyzeRule.kt:366`）→ **失败返回空串**；本项目 `NodeValue.value` **返回 `null`**。
本项目把 `null` 当「无值」用于 `mapNotNull` 丢条目（`RR:258-262`、`RR:837`），
所以任何「按上游『空串也算取到了』写的规则」在本项目里可能表现为**条目被丢**而不是空字段。

用户可见的错误分类（界面/体检侧依赖的文案）：
`规则写坏`（`RuleExecutionException` + `SelectorParseException`）、`上游为空`（0 字节）、
`上游拒绝`（JSON `msg` 含「登录」等 → `needs_login`）、`站点无内容`（列表 0 条无异常）。
调试面板：`DebugTrace(field, rule, value, failure)`（`RR:1713-1719`），`failure` 只在「抛异常/未配置/取到空值」时填（`RR:673-678`）。

**风险点**：JSONPath / XPath 两条路的异常**完全静默**（无日志、无 trace 原因），
`DebugTrace.failure` 会显示「取到空值」而不是「路径非法」→ 排查时无法区分「规则写坏」与「确实没数据」。
（对比：CSS 列表层与正则列表层都是「抛」，口径不统一。）

---

## 6. 谁在用这些原语（`grep -rn` 实证）

### 6.1 热路径（每个源 × 每个条目 × 每个字段都会走）

| 原语 | 调用点 | 说明 |
|---|---|---|
| `NodeValue.value()` | `RR:259,262-269`（搜索 9 个字段）、`RR:664`（详情，经局部 `fun value`）、`RR:832-835`（目录 isVolume/chapterUrl/chapterName）、`RR:959,981`（正文 + nextContentUrl）、`RR:997,1007,1019,1023`（title/subContent）、`RR:416`（段评 detailContentRule）、`RR:469`（RSS 正文）、`RR:873`（`jsListNodes` 内）| **主热路径**，共 20+ 处 |
| `RuleNodeSelection.nodes()` | `RR:252`（搜索列表）、`RR:368`（RSS 列表）、`RR:414`（段评列表）、`RR:826`（目录列表）、`RR:874`（`<js>` 后置规则）| 5 处，全是列表 |
| `RuleNodeSelection.listItemsByRule()` | `RR:1458` → `JsSandbox.kt:1714/1726/1776`（`java.getElements`/`getElement`/`getStringList`） | JS 桥「再入」入口，**热度取决于源**（注释称全库 170/226/72 处引用） |
| `splitLegadoBranches` | `RV:134`、`RNS:71` | 每字段/每列表都走一次扫描 |
| `findInlineJsMarker` | `RV:93`、`RV:133`、`RV:155`、`RV:172`、`RV:274` | 同一条规则会被**整串反复扫描 3–5 次**（`valueBuiltin`→`evaluateRule`→`{{}}` 早退判断→内联切分）；纯字符串扫描、无缓存，可作为 rebuild 的优化点 |
| `splitIndexSuffix`/`applyIndexTokens` | `RNS:98/100`、`RV:723/725/726/742/747` | 索引段 |
| `selectLegadoSegments` | `RNS:99`（**唯一**外部调用） | 列表兜底 |
| `applyReplaceEntry` | `RR:977` | 正文分页循环内，每页 × 每条 pattern |
| `ContentProcessor.processContent/processTitle` | `RR:925-926`、`RR:1025-1027`、`ReadingRoutes.kt:167-168`、`ReplaceRulesRoutes.kt:115-116`、`ReplaceRuleDao.kt:135` | 净化链 |
| `LooseJson` | `RR:1138`、`RR:1559`、`RuleUrlSupport.kt:49` | URL 参数尾巴/headers |

### 6.2 低频 / 单点

| 原语 | 唯一调用点 |
|---|---|
| `NodeValue.at()` | `RR:658`（`ruleBookInfo.init` 纯路径形态）——**只有一处** |
| `xpathNodes` | `RNS:65` |
| `xpathTexts` / `jx` | `RV:430`、`RV:792`（`jx` 只被 xpathNodes/xpathTexts 用） |
| `splitLegadoAlternatives` | `RV:231`（`{{}}` 内 `\|\|`） |
| `putPairs`（`RS:31`） | `RV:379` |
| `ChapterNumbers` | `JavaPackages` 的 `java.toNumChapter`（注释称全库 146 处调用；本册未逐个核） |
| `StrUtilFormat.render` | `JavaPackages` 的 `StrUtil.format`（`StrUtilFormat.kt:32-64`） |
| `RssFeedParser.parse` | `RR:357`（只在「没配 ruleArticles」的 RSS 源） |
| `RuleUrlSupport` 纯工具 | `RR`、`RuleHttp` 多处 |

### 6.3 看上去像死代码 / 需确认

- 无明确死代码：`RV` 的私有方法都有调用者；`RuleSplit` 全部 8 个顶层函数都有 main 侧调用（`grep` 见上）。
- **半死**：`NodeValue.at()`（`RV:483-486`）只服务 `init` 且「非 JS、非空白」→ 真实源里 `init` 几乎都是
  `@js:`/`<js>` 或 `$.data`；`at()` 对 `$` 开头以外的规则直接返回 `this`（**静默无效**）。
- **只在测试里用**：`applyReplaceEntry` 有 7 条单测（`RuleRunnerAdvancedFeaturesTest.kt:97-111`）但 main 只有 1 个调用点。
- **文档提到但 main 无调用**：无（`compatibility.md` 提到的 `isJsonPrefixedRule`/`nodes()`/`splitLegadoBranches`
  都在场，`compatibility.md:38-39` 的「`splitLegadoAlternatives` 已改名」在源码里是 `splitLegadoBranches` ✓，但
  `splitLegadoAlternatives` **仍然存在**（`RS:15`）且被 `RV:231` 使用 → 文档只说改名，实际是两个函数）。

---

## 7. 证据索引 · 未确认项 · 覆盖率

### 7.1 逐字读到（整篇或连续窗口）

| 文件（本项目） | 行数 | 读法 |
|---|---|---|
| `rules/RuleValue.kt` | 802 | **整篇 1-802**（两段：1-410、411-802） |
| `rules/RuleNodeSelection.kt` | 165 | 整篇 |
| `rules/RuleSplit.kt` | 267 | 整篇 |
| `rules/RuleUrlSupport.kt` | 162 | 整篇 |
| `rules/StrUtilFormat.kt` | 65 | 整篇 |
| `rules/ChapterNumbers.kt` | 123 | 整篇 |
| `rules/SearchFlow.kt` | 78 | 整篇 |
| `rules/RssFeedParser.kt` | 92 | 整篇 |
| `content/LooseJson.kt` | 200 | 整篇 |
| `content/ContentProcessor.kt` | 184 | 整篇 |
| `content/ContentPipeline.kt` | 37 | 整篇 |
| `model/SourceModels.kt` | 335 | 定向（规则字段：**无**，只有 `hasRules:17`） |
| `rules/RuleProcessor.kt` | 143 | 整篇（扩展点 + `RuleRuntime`） |
| `rules/RuleRunner.kt` | 1758 | 定向窗口：80-189、190-289、617-736、738-912、913-1052、1440-1470、1590-1645、1706-1758（**约 700 行 / 40%**）；取值/切分相关段读全 |

### 7.2 上游基线（`docs/.scratch/compat-audit/ref-legadoteam/.../analyzeRule/`）

`RuleAnalyzer.kt` 整篇（377）、`AnalyzeRule.kt` 495-904 窗口 + 关键函数清单、
`AnalyzeByJSoup.kt` 1-519 整篇、`AnalyzeByJSonPath.kt` 整篇（175）、`AnalyzeByRegex.kt` 整篇（59）、
`AnalyzeByXPath.kt` 整篇（155）。与 `ref-md3` 做 `diff` 核对（差异均为等价改写）。

### 7.3 未确认清单（按优先级）

1. **§3 #19 裸键补 `$.`**：基线源码里**没有**该能力（Jayway 强制 `$` 前缀）。要么本项目是超集，
   要么真实上游（gedoor 某 tag / GSON 宽松配置路径）确实做了。→ **验法**：拿 `{"book_name":"x"}` 在
   上游 App 或 `AnalyzeByJSonPath` 单测里跑规则 `book_name`；同时 `grep -c` 全库书源里「JSON 源 + 裸键字段规则」的条数。
2. **§3 #10 默认式 `:` 索引**（`class.x.0:2`）：上游=两个单索引、本项目=区间。
   → **验法**：构造 4 个 `<li>` 的 HTML，规则 `tag.li.0:2`，比对两边元素个数；再 `grep` 统计库里 `\.\d+:\d+` 形态的规则数（本项目注释称 `.book_tag.0:1:2` 真实存在）。
3. **§3 #14 XPath 文本口径**（`JXNode.toString` vs `Element.text()`）：读 `jsoup-xpath` 的 `JXNode.toString()` 或实测含 `<br>`/子标签的节点。
4. **§3 #15 XPath 表格包裹**、**#32 整条 `##` 起头时的对象**：同一 HTML 两侧对比即可。
5. **§3 #40 列表 JS 返回非 JSON 数组**：上游 `evalJS` 返回 `List<Map>`，本项目要求合法 JSON 数组。
6. **§3 #43 `ReplaceRule` 上游口径**：本册未取证据，建议另立小节对照上游 `ReplaceRule`/`ReplaceRuleDao`。
7. **§4 上游变量落点在不同阶段的实证**：`AnalyzeRule.put` 的 `?:` 链在「搜索阶段（无 book/chapter）」到底落到
   `ruleData` 还是 `source`，需要读上游 `Book.searchBook` 的 AnalyzeRule 构造点。

### 7.4 覆盖率

| 维度 | 覆盖 |
|---|---|
| 指定必读文件 | **12/12 全读**（`RuleValue` 整篇；`SourceModels` 定向确认「无规则字段」；`RuleRunner` 按约定只读取值/切分相关窗口） |
| §2 要求覆盖的 8 类语法 | **8/8**（CSS / XPath / JSONPath / JS / 正则 / 变量 / 嵌套 / 内容解析） |
| 兼容性判定表条目 | **46 条**（一致 21、差异 19、缺失 2、未确认 4） |
| 上游源码对照 | `AnalyzeRule` / `AnalyzeByJSoup` / `AnalyzeByJSonPath` / `AnalyzeByXPath` / `AnalyzeByRegex` / `RuleAnalyzer` **6/6** |
| 变量系统 | 容器/作用域/并发/生命周期 **4/4** 有结论 |
| 调用方清单 | `RuleValue`/`RuleNodeSelection`/`RuleSplit`/`RuleUrlSupport`/`ContentPipeline`/`ContentProcessor`/`LooseJson` 全量 `grep` |
| **未覆盖（本册范围外）** | `JsSandbox`(2066) / `JavaPackages`(1361) 的 JS 语义、`RuleHttp` 的 URL 渲染、`PagingRule`、`RuleLogin` |

---

## 附录 A · 可直接修的缺陷清单（按「真实源是否会踩到」排序）

> 全部是 §3 里判定为「差异/缺失」且在**本项目源码内部即可证伪**的项，不依赖上游运行时。
> 修不修取决于「是否要对齐上游」；但下列每条都至少有一个**本项目自身的内部不一致**（同一写法两条路径两种行为）。

| # | 缺陷 | 影响 | 最小修法 | 反向风险 |
|---|---|---|---|---|
| A1 | 字段层 `@CSS:`（大写）失效 | 任何用大写 `@CSS:` 的书源，**所有字段静默为空**（列表正常） | `RV:434` 改成 `removePrefix` 的 ignoreCase 版（如 `if (startsWith("@css:",true)) substring(5)`） | 几乎无（与 `RNS:43` 口径统一） |
| A2 | `@ownText` 恒空 | 用 `@ownText` 取的字段全空 | `RV:456` 的 `when` 加 `"ownText" -> elements.mapNotNull{ it.ownText()... }` | 无（当前是 100% 空） |
| A3 | `text.xxx` 段缺失 | 用 `text.标题` 选元素的源全空 | `RV:719` 加 `TEXT_ONLY` 分支 → `getElementsContainingOwnText` | 低（当前路径恒空） |
| A4 | 裸标签负索引 `li.-1` / `.x.-1` | 依赖「最后一个元素」的源取不到 | `RV:654/656` 正则允许 `-?\\d+` | 低 |
| A5 | 默认式 `:` 索引语义（区间 vs 多选） | `class.x.0:2` 取 3 个而上游取 2 个 → 目录/列表**多出条目** | `RV:739-748` 把 `:` 当**分隔符**（逗号等价），区间只在 `[]` 里认 | 中（会改变现有输出，需 `GoldenRuleTest` 逐字节对比） |
| A6 | 正则编译失败三种行为（`RV:584` 原值 / `CPL:29` 字面量 / 上游两种） | 写坏正则的规则表现不一致 | 统一到上游口径：普通段「字面量替换」、`###` 段「返回 replacement」 | 中（依赖现有源行为） |
| A7 | JSONPath / XPath 异常完全静默 | 体检面板分不清「规则坏」与「无数据」 | 在 `RV:618-622`/`RV:792-802` 的 `runCatching` 里最少记一条 `runtime.log`/写 `DebugTrace.failure` | 无（只加观测） |
| A8 | `ruleData` 无清理、键只到 URL 粒度 | 并发同 URL 时变量互相覆盖；进程长跑内存只增（上限 4096 键） | 双键 `sourceId+bookUrl` + 请求结束释放 + 显式清理点（删书/删源/读完） | 低（当前是纯泄漏） |
| A9 | 单花括号 `{$.x}` 遗留插值缺失 | 老源正文/简介里残留 `{$.author}` 字面量 | `expandBraces` 之外再加一条单花括号替换（注意与 JS 代码块的 `{}` 冲突，需先扫库确认用量） | **高**（JS 代码里的 `{}` 会被误替换）→ 必须先量化语料 |



---

# 附册 12c · JS 沙箱与 Java 桥白名单


> 审计员：`deep-rules-sandbox`（legadoQ Phase 0.5「规则引擎深读」）
> 读源：`E:\legadoQ-archive\product\app\src\main\kotlin\io\legado\`（**只读**，不写归档、不 build、不启动、不执行脚本）
> 证据标注：**confirmed**＝已在源码读到实现（带 `文件:行号`）；**likely**＝源码结构支持但未跑通；**needs-runtime-test**＝必须实测才能定性
> 纪律：注释与实现冲突时**以源码为准**并记录；不构造恶意书源实弹测试。
> 本轮获授权整篇读指定文件（分批 ≤400 行）。

---

## 0. 阅读进度与覆盖率

| 文件 | 行数 | 读取范围 | 状态 |
|---|---|---|---|
| `rules/JsSandbox.kt` | 2100 | 1–2100（整篇，分 6 块） | ✅ 100% |
| `rules/JavaPackages.kt` | 1415 | 1–1415（整篇，分 6 块） | ✅ 100% |
| `rules/JsGuard.kt` | 159 | 1–159（整篇） | ✅ 100% |
| `rules/JsScriptShape.kt` | 63 | 1–63（整篇） | ✅ 100% |
| `rules/JsMapObject.kt` | 108 | 1–108（整篇） | ✅ 100% |
| `rules/ScriptCrypto.kt` | 211 | 1–211（整篇） | ✅ 100% |
| `rules/ScriptCache.kt` | 88 | 1–88（整篇） | ✅ 100% |
| `rules/ScriptConvert.kt` | 148 | 1–40 + 结构（简繁表，非安全面） | 🟡 结构级 |
| `rules/ScriptHtml.kt` | 66 | 1–66（整篇） | ✅ 100% |
| `rules/JsoupBridge.kt` | 215 | 1–215（整篇） | ✅ 100% |
| `rules/GzipLimits.kt` | 87 | 1–87（整篇） | ✅ 100% |
| **交叉** `rules/RuleLogin.kt` | 394 | 30–130、240–394（JS 入沙箱的全部入口） | 🟡 交叉相关段 100% |
| **交叉** `rules/RuleRunner.kt` | 1679 | JS 相关段：119、455–500、570–610、715–735、1059–1130、1212–1440、1643–1695 | 🟡 仅 JS 面 |
| **交叉** `rules/ResponseBody.kt` | — | 限额常量 | ✅ 相关行 |
| **交叉** `AppConfig.kt` | — | 140–184（两个 JS 旋钮） | ✅ 相关行 |

**必读清单覆盖率：11 个指定文件全读 = 10/11 整篇 + 1 个结构级；两处交叉文件按 JS 面读全。**
本册不重复 12a（执行链）、12b（规则语义）已覆盖的内容，只在必要处引其结论。

> **注释与实现冲突（已发现 2 处，按源码为准）**
> 1. `product/docs/rules-sandbox-audit.md:15` 称第 1 层在「`JsSandbox.kt`、`RuleRunner.kt` 的 `callOptional`」——**属实**（`JsSandbox.kt:303`、`RuleRunner.kt:1667` 两处），但与 12b/本册强调的「唯一防线」措辞需对齐：**两处都设了 shutter，但只有 `JsSandbox` 那条是书源规则主路径**；`RuleRunner.kt:1665` 的 `mainJs` 路径 `enter()` **未传 hostByteBudget**（见 §5.4）。
> 2. `JavaPackages.kt:44` 注释称「返回给脚本的一律是 JS 对象/字符串/数组，**没有一个 Java 对象引用**能穿进沙箱」。源码层面基本成立，但存在**两条残留通道**：`JsSandbox.toJsValue` 的兜底分支 `Context.javaToJS`（§8.2），以及 `sessionStore`/`ScriptCache.putMemory` 把**上一轮的 Rhino 对象**留到下一轮（§6.3）。注释说的是「当次注入」，不是「进程内不出现」，这里必须记清。

---

## 1. Rhino Context 生命周期

### 1.1 唯一的进入/退出点

| 事实 | 位置 | 判定 |
|---|---|---|
| 每次求值都 `BoundedJs.enter(AppConfig.jsTimeoutMs, hostByteBudget)` | `JsSandbox.kt:300` | confirmed |
| `try { … } catch (Exception) { … } finally { BoundedJs.exit() }` | `JsSandbox.kt:301` / `447` / `456` | confirmed |
| `enter` 把 `deadlineMs = now + timeoutMs`、`hostByteBudget`、`hostBytes=0` 写进 Context | `JsGuard.kt:110-115` | confirmed |
| `exit` 就是 `Context.exit()` | `JsGuard.kt:117` | confirmed |

**异常路径是否确保 exit？——是（含 `Error`）。**
`finally { BoundedJs.exit() }`（`JsSandbox.kt:452-457`）对任何 `Throwable` 都执行，包括 `catch (e: Exception)`（`:447`）兜不住的 `StackOverflowError` / `OutOfMemoryError`。所以「脚本把 Context 泄漏掉」这条不存在。
唯一例外：`BoundedJs.enter(...)` 自身抛错（`JsGuard.kt:110` 之前失败）时没有已进入的 Context 需要退出，对称，无泄漏。

### 1.2 是否复用 Context

- **scope 一定不复用**：每次求值 `val scope = cx.initSafeStandardObjects()`（`JsSandbox.kt:304`）→ 全新全局对象。这是本沙箱**最强的一条隔离保证**（见 §6.1）。
- **Context 是否复用取决于 Rhino `ContextFactory.enter()` 的语义**，本册**无法静态定论**：
  `BoundedJs.enter` 走 `BoundedContextFactory.enter()`（`JsGuard.kt:110`），`makeContext()`（`JsGuard.kt:52-88`）里设 `optimizationLevel=-1`、`instructionObserverThreshold=20000`、`maximumInterpreterStackDepth=1000`、`languageVersion=VERSION_ES6`——这些都是 **Context 级**状态。若 `enter()` 在**同一线程已有 Context** 时直接复用而不新建，则：
  1. 嵌套求值（`java.getString`/`getElements` → `RuleRunner.listItemsByRule` → 又一条 JS 规则，`JsSandbox.kt:1714` / `1756`；以及 `execContext.bridgeContent` 再入，`1696-1703`）会**覆盖**外层的 `deadlineMs` / `hostByteBudget` / `hostBytes`（`JsGuard.kt:110-115` 无条件赋值）→ 外层 30s 墙钟与 64MB 预算被内层重置（**预算洗白**）。
  2. 内层 `Context.exit()` 在 Rhino 里是**引用计数**语义，只有计数归零才真正释放；若实现不是计数式的，内层退出会提前解除外层的线程绑定。
  **标注：needs-runtime-test**（判据见 §5.5）。两条都不会导致逃逸，但会让「预算真的生效」这件事在再入路径上失真。

### 1.3 每书源 / 每脚本是否新建 scope

- **每脚本**：是（`:304`）。
- **每书源**：不是——同一书源的一次 `eval` 只是重建一次 scope；`jsLib` 也在**同一个 scope 内**先求值（`:423-425` → `evalLibrary`，`:488-507`），所以「jsLib 的顶层函数对动作脚本可见」成立，且**不会跨书源串**（scope 是新的）。
- `JsSandbox` 实例本身是**进程单例**（`Application.kt:168` 建 `RuleRunner`，其内部 `internal val jsSandbox = JsSandbox(this)` 在 `RuleRunner.kt:119`）——实例级状态见 §6。

### 1.4 对象包装级别（`WrapFactory`）

**没有自定义 `WrapFactory`。** 全仓 `grep -rn "WrapFactory" rules/` 无命中（confirmed）：
- 未覆盖 → Rhino 用默认 `WrapFactory`，`ScriptableObject.putProperty` 放进原始 Kotlin 值时由 `Context.javaToJS` 兜底包装（`JsSandbox.kt:2097`）。
- **替代品是「压根不放 Java 对象」**：所有桥对象都是 `NativeObject` / `BaseFunction` 子类（`JsSandbox.kt:586-594` 的 `ChainedObject`、`:819-835` 的 `CallableBody`、`JsMapObject`、`JsClass`），响应对象是 `new String(正文)` 再挂成员（`:596-679`）。
- 因此第 1 层防线（`ClassShutter`）在正常脚本里**几乎用不到**——它防的是「万一有人塞了 Java 对象进来」的兜底，不是主防线。**这点必须写进新架构文档，否则后人会误以为防线在 shutter 上。**

---

## 2. 全局对象与注入面（`globalThis` 逐项清单）

`initSafeStandardObjects()`（`JsSandbox.kt:304`）先给出**安全**标准对象，然后是 14 个显式注入。逐项：

### A. 由 Rhino `initSafeStandardObjects` 自带的（非本项目注入）

ES6 标准内建：`Object/Function/Array/String/Number/Boolean/Date/RegExp/Math/JSON/Error/Map/Set/Promise/Symbol/Proxy/Reflect` 等，以及 ES6 的 `globalThis`。
**Rhino 的 "safe" 模式刻意不含**：`Packages`、`java`、`javax`、`org`、`com`、`edu`、`net`、`getClass`、`JavaAdapter`、`Continuation`、`loadClass`、`defineClass`、`load`、`print`、`readFile`、`readUrl`、`runCommand`、`spawn`、`sync`、`quit`、`version`、`gc`、`doctest`。
→ **`load` / `print` / `readFile` / `readUrl` / `runCommand` / `quit` / `getClass` 一律不存在**（判定 **likely**：属 Rhino API 语义，本仓未覆盖 `initSafeStandardObjects`；运行验证见 §5.5 的 S-0 用例）。
→ **没有 `console`**：`java.log` 是空实现（`JsSandbox.kt:1244-1248`），脚本日志全部丢弃（兼容性风险，见 §9.4）。

### B. 本项目显式注入的 14 个（全部是**代理/模拟对象**，没有任何真 Java 对象）

| # | 名字 | 注入点 | 实现 | 真实 Java 对象？ | 危险度 |
|---|---|---|---|---|---|
| 1 | `org`（`org.jsoup.Jsoup`） | `JsSandbox.kt:331` | `JsoupBridge.install`（`JsoupBridge.kt:34-62`） | ❌ 纯 JS 包装；**无 `Jsoup.connect`**（`JsoupBridge.kt:22-26`） | 低 |
| 2 | **bindings**（`result`/`src`/`baseUrl`/`sourceId`/`bookSourceUrl`/`isLongClick`/`key`/`page`/`__loginState`…） | `JsSandbox.kt:349-351` | `toJsValue`（`:2090-2098`）：Map→`NativeObject`、List→JS 数组、**其它→`Context.javaToJS`** | ⚠️ **视调用方给什么**（§8.2） | 低（现调用方只给 String/Map） |
| 3 | `java` | `:339`，`createJavaBridge` `:1143-2037` | `NativeObject` + 约 60 个 `BaseFunction` | ❌ 全替身 | 中（网络出口，§4） |
| 4 | `Reload(url)` | `:347-368` | 抓 URL 回**字符串**，不执行 | ❌ | 中（网络出口） |
| 5 | `Packages` | `:360` → `JavaPackages.install` `:71` | `PackageNode` 白名单树（`JavaPackages.kt:81-96`） | ❌ 树里只有 `JsClass` 替身 | **核心，§3** |
| 6 | `JavaImporter` | `:360` → `:72` | `ImporterObject`（`JavaPackages.kt:129-170`） | ❌ | 核心，§3 |
| 7 | `importPackage` | `:360` → `:73` | 只遍历 `PACKAGE_CLASSES`（`:172-181`） | ❌ | 核心，§3 |
| 8 | `importClass` | `:360` → `:74` | 只接受 `JsClass` 实例（`:183-188`） | ❌ | 核心，§3 |
| 9 | `source` | `:366`（需 sourceId 非空） | `createSourceBridge` `:837-970`：登录信息/变量/键值读写 | ❌ | 中（凭据面） |
| 10 | `cookie` | `:377` | `createCookieBridge` `:972-1042`：带**域白名单软闸**（`:981-985`） | ❌ | 中（凭据面） |
| 11 | `put($$$)`（裸全局） | `:384-409` | 写 `source.variable` | ❌ | 低 |
| 12 | `cache` | `:404-408` | `createCacheBridge` `:1054-1141` → `ScriptCache`（键按书源隔离） | ❌ | 低 |
| 13 | `book` / `chapter` | `:411` / `:413` | `createBookBridge` `:526-576` / `createChapterBridge` `:510-519` | ❌ | 低 |
| 14 | `environment` | `:418-420` | 只有 `IS_LEGADO_SIGMA=false` | ❌ | 无 |

**结论（confirmed）**：沙箱里**没有一个真实 Java 对象是真类实例**——
`okhttp3.OkHttpClient/Request/RequestBody/MediaType/HttpUrl`（`JavaPackages.kt:627-642`）全部是**模拟类**，`newCall().execute()` 最终转调 `RuleRunner.fetchResponse`（`:1242-1260`）；
`java.util.HashMap/ArrayList`（`:425-438`）是 `JsMapObject` / JS 数组；
`javax.crypto.Cipher/Mac`（`:504-515`）是真 JCE 实例，但**句柄不出沙箱**（只有 `init/doFinal/update` 等 wrap 方法，`:1023-1044`）。

---

## 3. Java 桥白名单（本册核心）

### 3.1 白名单全量（`JavaPackages.kt`）

**唯一真源：`CLASS_NAMES = setOf(...)`（`JavaPackages.kt:1385-1403`），43 个类。**
命名空间树由它派生，不是手写第二份：`PACKAGE_CLASSES`（`:1405-1406` `groupBy`）、`NAMESPACES`（`:1408-1413` 按包名逐级前缀展开）。

| 组 | 类（简单名） | 数量 | 声明行 | 实现行 |
|---|---|---|---|---|
| `java.lang` | Thread, System, String, StringBuilder, StringBuffer, Integer, Long, Double, Float, Boolean | 10 | 1386-1388 | 240-379 |
| `java.util` | UUID, Base64, Arrays, HashMap, LinkedHashMap, ArrayList | 6 | 1389-1390 | 382-438 |
| `java.net` | URLEncoder, URLDecoder | 2 | 1391 | 441-454 |
| `java.security` | MessageDigest, SecureRandom, KeyFactory, Signature | 4 | 1392-1393 | 457-483 |
| `java.security.spec` | PKCS8EncodedKeySpec, X509EncodedKeySpec | 2 | 1394 | 484-494 |
| `javax.crypto` | Cipher, Mac, SecretKeyFactory | 3 | 1395 | 504-532 |
| `javax.crypto.spec` | SecretKeySpec, DESKeySpec, IvParameterSpec, GCMParameterSpec | 4 | 1396-1397 | 484-501 |
| `android.*` | android.util.Base64, android.text.TextUtils, android.os.Build | 3 | 1398 | 535-570 |
| `cn.hutool.*` | core.codec.Base64, core.util.StrUtil, core.util.ZipUtil, crypto.digest.DigestUtil | 4 | 1399-1400 | 571-624 |
| `okhttp3` | OkHttpClient, Request, RequestBody, MediaType, HttpUrl | 5 | 1401-1402 | 627-642 |
| **合计** | | **43** | | |

**可达命名空间（21 个，`NAMESPACES` 展开结果）**：`java` · `java.lang` · `java.util` · `java.net` · `java.security` · `java.security.spec` · `javax` · `javax.crypto` · `javax.crypto.spec` · `android` · `android.util` · `android.text` · `android.os` · `cn` · `cn.hutool` · `cn.hutool.core` · `cn.hutool.core.codec` · `cn.hutool.core.util` · `cn.hutool.crypto` · `cn.hutool.crypto.digest` · `okhttp3`。
**注意**：`java.io` / `java.nio.file` / `java.lang.reflect` / `javax.naming` / `javax.script` / `sun.*` **连命名空间都不存在**（`NAMESPACES` 由白名单派生，`:1408-1413`）。
**注意 2**：`Packages.org…` 走不通——`PackageNode.get` 对 `org` 既不 `resolve` 也不在白名单前缀里，返回 `NOT_FOUND`（`:88-94`）。`org.jsoup.*` 只有**裸全局 `org`** 那一条路（`:331`）。

**入口计数基线**：`JavaPackagesEntryBaselineTest`（`src/test/.../rules/JavaPackagesEntryBaselineTest.kt:60-`）用反射枚举并**精确比对**「43 个类 / 98 个静态入口 / 13 个只有构造的类」，并单独钉住「带记账的入口名字」。这是本册最有力的一份现成判据（confirmed）。

### 3.2 危险类可达性逐项判定

判定口径：脚本请求 `Packages.java.lang.Runtime` → `PackageNode("java.lang").get("Runtime")` → `resolve("java.lang.Runtime")` → `full !in CLASS_NAMES` → `null` → `"java.lang.Runtime" !in NAMESPACES` → `return NOT_FOUND`（`JavaPackages.kt:86-95` + `:192-196`）。

| 危险面 | 可达？ | 请求到的是什么 | 证据 |
|---|---|---|---|
| `java.lang.Runtime` | ❌ 不可达 | `undefined` | 不在 `CLASS_NAMES`(1385-1403)；`resolve` 判据 194 |
| `java.lang.ProcessBuilder` | ❌ | `undefined` | 同上 |
| `java.io.File` / `FileOutputStream` / `RandomAccessFile` | ❌ | `undefined`（**`java.io` 命名空间不存在**） | `NAMESPACES` 无 `java.io`（1408-1413） |
| `java.nio.file.Files` / `Paths` | ❌ | `undefined`（`java.nio` 不存在） | 同上 |
| `Class.forName(...)` | ❌ | `Packages.java.lang.Class` → `undefined` | `Class` 不在白名单；另 `ClassShutter{false}` 让 `java.lang.Class` 对脚本不可见（303） |
| `getClass()`（反射入口） | ❌ 无对象可调 | 沙箱内**没有任何真 Java 对象** → 无 `getClass`；`initSafeStandardObjects` 也不给全局 `getClass` | §2.B 全表为 `NativeObject`/`BaseFunction`；`initSafeStandardObjects`(304) |
| `getDeclaredMethod` / `getMethod` / `newInstance` | ❌ | 需要 `Class`/`Method` 实例，两者都拿不到 | 同上 |
| `java.lang.Thread` | ⚠️ **部分可达（替身）** | 只有 `sleep(ms)`（**clamp 到 1000ms**，`JavaPackages.kt:241-249`）与 `currentThread().{getName→"main", sleep}`（`:250-259`）。**无** `start/run/stop/new Thread( Runnable )` | confirmed |
| `System.exit` / `setProperty` / `getSecurityManager` / `setSecurityManager` | ❌ | `System` 替身只有 `currentTimeMillis/nanoTime/getProperty/getenv/arraycopy`（`:261-277`）；`System.exit` → `undefined` → 调用抛 TypeError | confirmed |
| `System.getenv(任意)` | ⚠️ 可达但**恒返回 `""`** | 刻意移除直通（`:272-275` 注释：会把部署方环境变量里的 API key 泄给任意源） | confirmed |
| `sun.misc.Unsafe` | ❌ | `undefined` | 无 `sun` 命名空间 |
| JNDI（`javax.naming.*`、`InitialContext.lookup`） | ❌ | `undefined`（`javax.naming` 不存在） | 同上 |
| `URLClassLoader` / `ClassLoader` / `defineClass` | ❌ | `Packages.java.net.URLClassLoader` → `undefined`（`java.net` 命名空间**存在**，但该名不在 `CLASS_NAMES` → NOT_FOUND） | 194 |
| `ScriptEngine` / `ScriptEngineManager`（`javax.script`） | ❌ | `undefined` | 同上 |
| `java.lang.reflect.*` / `Method.invoke` | ❌ | `undefined` | 同上 |
| 文件/进程/反射**通配**探针（`Packages.java.io.File`、`Packages.sun.misc.Unsafe` …） | ❌ | `undefined`（静默，不抛错） | §3.3 |

**同时要记录的一条「刻意开放」**：`okhttp3.*` 与 `java.net.URLEncoder` 构成**完整网络出口**（§4），这是设计内的，不是漏。`GzipLimits` / `Arrays` / `SecureRandom` / `Base64` 构成**宿主分配面**，由记账闸口兜住（§5.3）。

### 3.3 未知类被请求时的真实行为（防逃逸关键判据）

**静默 `NOT_FOUND`（JS 侧表现为 `undefined`），不抛错、不记日志、不回 `null`。**
代码原文（`JavaPackages.kt:86-95`）：
```kotlin
override fun get(name: String, start: Scriptable): Any? {
    if (name in OBJECT_MEMBERS) return super.get(name, start)
    val full = if (path.isEmpty()) name else "$path.$name"
    resolve(full)?.let { return it }
    if (full in NAMESPACES || full.startsWith("org.jsoup")) return PackageNode(full)
    return NOT_FOUND          // ← 未知类的唯一出口
}
```
- `JavaImporter` 路径同样：`ImporterObject.get` 找不到就 `return NOT_FOUND`（`:157-169`）。
- `importPackage("随便.什么")`：`globalImportPackage` 只认 `WhitelistMarker`（即真命名空间节点）→ 字符串参数**被忽略**（`:172-181`）；即便进了 `packages` 列表，最后仍要过 `resolve()` 的 `CLASS_NAMES` 判据（`:165-167`）。
- **唯一会抛错的分支**是「类在 `CLASS_NAMES` 里但 `buildClass` 没写实现」：`else -> error("未实现的 Java 白名单类：$full")`（`:644`）→ `IllegalStateException` 穿进 Rhino。这是**开发期自检**，不是安全边界（白名单与实现必须成对，`JavaPackagesEntryBaselineTest` 会红）。
- **负面效果（要给新架构留警示）**：未知类静默 `undefined` 意味着**拼错类名的书源不会报错、只会「取不到值」**，排查成本高；但换掉这个行为（改成抛错）会破坏大量 try/catch 探测型源（例如探测 `io.legado.app.*` 的魔改版探测，`JavaPackages.kt:50-51` 明说故意让它失败）。

### 3.4 `setClassShutter` 的返回值

**恒 `false`。** 代码原文（`JsSandbox.kt:302-304`，≤5 行）：
```kotlin
cx.optimizationLevel = -1
cx.setClassShutter(ClassShutter { false }) // Sandbox: block all Java reflection
val scope = cx.initSafeStandardObjects()
```
`ClassShutter` 是单方法接口 `visibleToScripts(String fullClassName): Boolean`，SAM 转换的 lambda `{ false }` **无条件返回 false** = 所有 Java 类对脚本不可见（deny-all，比上游 legado-with-MD3 的黑名单更强）。

**同一道闸还有第二处（12a 未覆盖）**：`RuleRunner.kt:1667`（`JsSourceRunner.callOptional`，`mainJs` 书源那条路径）同样 `context.setClassShutter(ClassShutter { false })`，也 `initSafeStandardObjects()`（`:1668`）。两处一致，**但那里只注入了一个 `java.ajax`（`:1669`、`:1686-1690`）**，没有 `Packages`/`cookie`/`source`/`cache`——即 `mainJs` 源的暴露面比规则 JS **更窄**（同时也意味着那边**没有 hostByteBudget**，见 §5.4）。

---

## 4. 网络访问入口与出站预算

### 4.1 书源 JS 能自己发 HTTP——能，且有 11 个入口

| 入口 | 位置 | 底层 | 备注 |
|---|---|---|---|
| `java.ajax(url)` | `JsSandbox.kt:1150-1163` | `runner.fetch` | `data:text/html;base64,…` 走本地解码（`:1153-1156`），不发网络 |
| `java.ajaxAll(urls)` | `:1168-1190` | `runner.fetchResponse` × N | **并发**（全局 8 线程池，见 4.4） |
| `java.post(url, body, headers)` | `:1193-1210` | `fetchResponse(POST)` | |
| `java.get(url[,headers])` | `:1215-1228` | `fetchResponse(GET)` | 双语义：`args.size>=2 \|\| 看起来是 URL` 才当网络调用，否则当 KV 读（`sessionStore`，`:1226`） |
| `java.connect` / `getStrResponse` / `getStrResponseAwait` | `:1800-1815` | `fetchResponse(GET)` | 返回响应对象 |
| `java.head(url)` | `:1819-1828` | `fetchResponse(HEAD)` | 正文强制清空（`:1824`） |
| `java.cacheFile(url[,saveTime])` | `:1379-1399` | `runner.fetch` | 结果进 `ScriptCache`（键 `dl:`+md5_16） |
| `java.importScript(path)` | `:1404-1422` | `cacheFileText` | http 直取；非 http 按书源地址相对解析 |
| `Reload(url)` | `:347-368` | `runner.fetch` | 回**文本**，由脚本自己 `eval` |
| `Packages.okhttp3 …newCall().execute()` | `JavaPackages.kt:1203-1213` → `executeRequest` `:1242-1260` | `fetchResponse`（带 `deadlineMs`） | **唯一传 deadline 的 JS 网络入口** |
| 远端 jsLib 映射（`jsLib` 是 `{"名":"https://…js"}`） | `JsSandbox.kt:488-507`（`evalLibrary`） | `runner.fetch` | 每次规则求值都会（首次）抓取并**执行** |

**`java.startBrowserAwait` 的 `browserCompleted` 分支也会服务端抓一页**（`:1298-1303`）。

### 4.2 是否走 `NetworkSecurity` 闸门——走，无一例外（confirmed）

所有入口最终都汇到 `RuleRunner.fetch` / `fetchResponse`（`RuleRunner.kt:1059` / `:1070`）→ `fetchDetailed` → `fetchDetailedImpl`（`:1221`）→ `buildRequest`（`:1332`）→ **`validateTarget(initial)` → `NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "站点")`**（`:1315-1323`）；每一跳重定向也单独校验（`:1306`）。
→ 回环 / 私网 / 云元数据地址在**发请求之前**被拒（抛 `RuleExecutionException`）。
**唯一的旁路风险**：`fetchedFetcher` / `responseFetcher` 测试桩（`:1229-1230`）会**短路**掉整条链路（不校验）。生产不设这两个桩，但新架构若保留「可注入 fetcher」就保留了这条旁路——必须在装配层禁止非测试注入。

### 4.3 Cookie 会不会自动带——会（confirmed，且是「按每一跳的地址」查）

`effectiveHeaders`（`RuleRunner.kt:1381-1400`）：每跳先取 `db.asLoginStateStore().getSourceLoginState(sourceId).loginHeader`，再取 `db.asCookieStore().getCookieForUrl(uri.toString())`（`:1393`），按键位合并（`mergeCookieStrings`，`:1421-1431`），最后叠加脚本给的 headers。
**所以书源 JS 发的任何请求都自带该书源已存的登录态 Cookie / 登录头。**
响应侧 `Set-Cookie` 全部落罐（`:1257-1266`），且**用当前那一跳的地址归档**（注释 `:1260-1261`：防 A 站 Cookie 发给 B 站）。
JS 读 Cookie 另有一道**软闸**：`cookie.getCookie(url)` / `java.getCookie(tag)` 只允许「本书源配置里出现过的域 + 自己的主域」（`JsSandbox.kt:981-994`、`:1327-1331`），源码注释自己承认这是**文本判定、可被绕过**（`:369-376`：「一个铁了心的恶意源把域名写进规则串就能越过这条线」）。

### 4.4 出站次数 / 字节 / 并发预算——**基本没有**（这是上一轮 P1-5 的确认结论）

| 维度 | 有无预算 | 证据 |
|---|---|---|
| **单响应字节** | ✅ 有：2 MiB | `ResponseBody.kt:20` `MAX_BODY_BYTES = 2 MiB`；`:98`/`:110` 两处抛 `RuleExecutionException` |
| **单请求超时** | ✅ 有：每跳 20s | `RuleRunner.kt:1334` |
| **重定向跳数** | ✅ 有：4 跳 | `:1239` `repeat(4)`，超出抛「重定向次数超过限制」（`:1309-1310`） |
| **单次执行的出站请求数** | ❌ **无** | 全仓无 per-eval 请求计数器；`java.ajax` 可在 `for` 循环里无限调 |
| **单次执行的出站总字节** | ❌ **无** | `MAX_BODY_BYTES` 是**逐响应**；N 次 × 2 MiB 无上限，且**网络字节不进 `hostByteBudget`**（`AppConfig.kt:158-159` 明说「网络响应体不计入」） |
| **并发** | 🟡 半有：`ajaxAll` 全局固定 8 线程（`JsSandbox.kt:200-207`，守护线程池，跨书源共享 → 总并发上限 8）；`okhttp.execute()` 串行；**普通 `java.ajax` 无任何限制**，由调用它的工作线程直接做 |
| **墙钟对网络的约束** | ⚠️ **漏洞**：只有 `okhttp3.execute()` 传了 `deadlineMs`（`JavaPackages.kt:1255`）。`java.ajax`(`:1160`)、`java.get`(`:1222`)、`java.post`(`:1198-1205`)、`connect`(`:1804-1805`)、`head`(`:1823-1824`)、`cacheFile`(`:1386`)、`Reload`(`:351`) **都没传** → 一条 `for(i=0;i<100;i++) java.ajax(url)` 最多可占 **100 × 20s ≈ 33 分钟**，而 `observeInstructionCount` 在阻塞期间**零回调**（`JsGuard.kt:8-13` 自述），30s 墙钟对它完全失效。**判定：confirmed（代码层）+ needs-runtime-test（实际耗时，用一个必然慢的本地桩地址测）** |

**结论**：`java.ajaxAll` 有并发上限（8），但**出站次数、出站总字节、以及「JS 网络调用的墙钟」三项都没有**。这是新架构必须补的第一优先项（§9.2 的 C-1/C-2）。

---

## 5. 执行时间与内存限制

### 5.1 墙钟限制在哪实现

| 要素 | 值/位置 | 判定 |
|---|---|---|
| 观察器 | `BoundedContext.observeInstructionCount`（`JsGuard.kt:44-48`）：`if (now > deadlineMs) throw EvaluatorException("书源 JS 执行超过 ${timeoutMs}ms 上限，已中断（疑似死循环）")` | confirmed |
| 触发频率 | `instructionObserverThreshold = GRANULARITY = 20_000`（`JsGuard.kt:64`、`:90`） | confirmed |
| 前提 | **必须解释模式** `optimizationLevel = -1`（`JsGuard.kt:63` 在 factory 里设，`JsSandbox.kt:302` 再设一次）——编译模式下观察器永不触发 | confirmed |
| 时限来源 | `AppConfig.jsTimeoutMs`，默认 30_000ms，`LEGADO_JS_TIMEOUT_MS` 可调（`AppConfig.kt:148`） | confirmed |
| 递归保护 | `maximumInterpreterStackDepth = 1000`（`JsGuard.kt:76`、`:91`）——防「深度递归把解释器栈推爆 → `StackOverflowError`（`Error`，`runCatching` 兜不住）」 | confirmed |
| 阻塞调用的兜底 | `BoundedJs.deadlineOrNull()`（`JsGuard.kt:158`）交给 `fetchResponse(deadlineMs=…)`，**只有 okhttp3 一处用**（§4.4） | confirmed |

**超时后如何终止**：抛出 `EvaluatorException`（一个 `RuntimeException`）→ 从 `observeInstructionCount` 冒到解释器 → `cx.evaluateString` 抛出 → 被 `evalImpl` 的 `catch (e: Exception)`（`JsSandbox.kt:447`）接住 → 写 `execContext.lastError` / `lastError` → **返回 null**（`:452`）→ `finally` 里 `BoundedJs.exit()`（`:456`）。
**没有**中断线程、没有 `Thread.stop`、没有杀进程——是**协作式中断**，只在下一条指令边界生效。

### 5.2 堆内存是否记账——**只记宿主分配，纯 JS 分配完全不记（confirmed）**

- 记账函数：`BoundedJs.chargeHostBytes(bytes)`（`JsGuard.kt:132-144`）→ 累加到 `ctx.hostBytes`，超 `hostByteBudget` 抛 `IllegalArgumentException`（注意是 `Exception` 不是 `Error`，脚本 `runCatching` 能兜住）。
- **记账点只有 4 处**（`JavaPackages.kt`）：`requireAllowedLength`（`:780`）、`requireStringBuilderWithinLimit`（`:792`）、`ZipUtil.gzip`（`:606`）、`ZipUtil.unGzip`（`:614`）。
- 而这 4 处**只覆盖「脚本给出的长度/元素数引发的宿主分配」**：`Arrays.copyOf/copyOfRange`、`System.arraycopy`、`bytesOf`（`:722`）、`bytesArray`（`:749`）、`SecureRandom.nextBytes`（`:1017`）、Base64 解码输入（`:955`）、`StringBuilder.append/insert/setLength`、GZIP 两向。
- **纯 JS 分配（`'x'.repeat(n)`、数组 push、对象、字符串拼接、`Array(n).fill()`）在 Rhino 堆里发生，本仓没有任何 instrument 点 → 一分钱都不记。**
- 预算默认 **64MB**（`AppConfig.kt:151` `DEFAULT_JS_HOST_BYTES = 64MB`；`:176-179` `0`/负数 → `Long.MAX_VALUE` 不设限）。
- **同时存在的单次硬上限**：`MAX_HOST_ALLOC_BYTES = 8MB`（`JavaPackages.kt:1366`）、`MAX_STRING_BUILDER_LENGTH = 1e6`（`:1352`）、`MAX_SLEEP_MS = 1000`（`:1350`）、`MAX_UNZIP_BYTES = 16MB` / `MAX_GZIP_INPUT_BYTES = 16MB`（`GzipLimits.kt:35`/`:64`）、`MAX_KEY_MATERIAL_ENTRIES = 1024`（`:1375`）。

### 5.3 64MB 是怎么累计的

`JsSandbox(hostByteBudget = AppConfig.jsHostBytes)`（`JsSandbox.kt:213`）→ `BoundedJs.enter(timeout, budget)`（`:300`）→ `BoundedContext.hostByteBudget`（`JsGuard.kt:113`），每次 `enter` 把 `hostBytes = 0`（`:114`）→ **预算是「单次 eval」口径，不是书源口径、不是进程口径**。
累计发生在**唯一收口函数**里（设计意图见 `JsGuard.kt:120-127`：「在 106 个入口逐个记账是漏记一处等于没有」）。
超限行为：抛 `IllegalArgumentException`，文案带「已累计分配宿主内存 N MB，超过 64MB 上限，已拒绝（疑似脚本放大攻击）」+ 提示 `LEGADO_JS_HOST_BYTES`（`JsGuard.kt:138-142`）。

### 5.4 两处「预算缺失」的路径（重要）

1. **`mainJs` 书源路径**：`RuleRunner.kt:1665` `BoundedJs.enter(AppConfig.jsTimeoutMs)` —— **只传超时，`hostByteBudget` 取默认 `Long.MAX_VALUE`（不设限）**（`JsGuard.kt:108`）。该路径暴露面窄（只有 `java.ajax`，`:1669`），所以 8MB 级放大入口不可达；但它是**唯一一处「有墙钟无内存预算」的 JS 执行点**，新架构要么补齐、要么明确记录。
2. **嵌套求值**（§1.2）：若 Rhino 复用线程 Context，内层 `enter` 会把 `hostBytes` 归零并换成自己的预算 → 外层预算被「洗白」。

### 5.5 上一轮遗留问题：`var a=[]; for(;;) a.push('x'.repeat(1<<20))` 会不会先 OOM 再被墙钟拦？

**静态判断：会（likely → 需实测确认）。** 推理链：

1. 每次迭代分配 1 MiB 的 Rhino `NativeString` + 数组槽增长，**不进 `hostBytes`**（§5.2）。
2. 观察器每 20000 条**指令**才回调一次（`JsGuard.kt:90`）。一次 `repeat` + 一次 `push` 约几十条指令 → 一个观察窗口（20000 指令）内可分配 **数百 MB**。
3. 观察器只在**超时**时抛错（`JsGuard.kt:45`），所以第一次回调之前的所有分配都「合法」；30s 内能分配到的量远超常见 JVM 堆（默认 `-Xmx` 通常是物理内存的 1/4）。
4. 撞上 `OutOfMemoryError` 时：`evalImpl` 只 `catch (e: Exception)`（`JsSandbox.kt:447`）→ **OOM 是 `Error`，不被捕获**，只有 `finally` 的 `BoundedJs.exit()` 会跑（`:456`），异常继续上抛到 HTTP 层 → 该请求 500；JVM 是否存活取决于堆压力是否波及其它线程（GC 抖动/线程创建失败）。
   → 这与「`StackOverflowError` 把工作线程打掉」是同一类失败模式，`JsGuard.kt:65-76` 只解决了栈深度、**没有解决堆**。
5. 反向证据（说明「确实没人处理过」）：`AppConfig.kt:158-159` 与 `GzipLimits.kt:10-16` 的注释都只讨论**宿主**分配；全仓没有任何针对 Rhino 堆的限额、`-Xmx` 设定或 sandbox 子进程隔离。

**标注：needs-runtime-test。** 验证脚本思路（**不是**恶意书源，是判据）：
```
// 与 JsGuardLimitsTest 同形（该文件已证明"注入 120ms 超时"的做法可行）
@Test fun `纯 JS 堆分配会不会先于墙钟 OOM`() {
    // ① 先确认墙钟在这段脚本上确实会触发（注入 300ms）：
    val e1 = runCatching { JsSandbox().eval("var a=[];for(;;)a.push('x'.repeat(1<<20))") }.exceptionOrNull()
    //    期望：抛 EvaluatorException("…超过 300ms 上限")，而不是 OutOfMemoryError
    // ② 用受限堆复现 OOM 面（Gradle test 加 jvmArgs '-Xmx128m'，或独立 main + -Xmx64m）：
    //    期望看到 java.lang.OutOfMemoryError: Java heap space，且堆栈里没有我们的 catch
    // ③ 记三个数：触发时分配的 MB、耗时、抛的异常类型 —— 三者决定它到底是「墙钟先到」还是「堆先到」
}
```
**必须同时测的对照组**：`java.util.Arrays.copyOf([1], 8388607)` × 9 次（走 `requireAllowedLength`）→ 期望第 9 次抛 64MB 预算错误 → 证明「宿主路已封、纯 JS 路未封」的**不对称**。若要修，最小改动是给 `initSafeStandardObjects` 出来的 scope 挂一个**自有 String/Array 分配代理**（不可行）或**把 JS 执行移到独立进程/或在同一 JVM 用 `-Xmx` + 捕获 `OutOfMemoryError` 做「可恢复」判定**——结论见 §9.2 C-3。

---

## 6. 并发隔离

### 6.1 不共享的东西（confirmed）

| 项 | 隔离方式 | 证据 |
|---|---|---|
| 全局变量 / 函数 | **每次 eval 新建 scope** `cx.initSafeStandardObjects()` | `JsSandbox.kt:304` |
| 执行上下文（书源、书、章节、登录信息、toast、openUrl…） | `ThreadLocal<JsExecutionContext?>`，且 `withSourceContext` 用 **save/restore** 语义并在 finally 还原 | `:250-263` |
| 失败原因 `lastError` | `ThreadLocal<String?>`（**曾经是 `@Volatile` 字段，实测会串**，`:465-475` 的注释记了这个 bug） | `:462-475` |
| 变量替换的 jsLib / loginScript | 由 `execContext` 携带，不进全局 | `:275-287`、`:423-431` |
| `Rhino Context` | **每 eval 一个 enter/exit 配对**（是否真新建见 §1.2 needs-runtime-test） | `:300`/`:456` |

### 6.2 共享的东西（设计如此，但都有代价）

| 项 | 类型 | 键 | 风险 |
|---|---|---|---|
| `sessionStore`（`java.put/get` 的 KV） | `ConcurrentHashMap<String, Any>`（**存的是原始 JS 值**） | `sourceId\u0000key`（`:239-240`） | ① **无容量上限**（`:2033` 直接 put）→ 跨执行累积，且不计入 64MB 预算（预算是 per-eval）→ 脚本可用 `for(i<1e6) java.put('k'+i,'x'.repeat(1000))` 留下 GB 级常驻内存；② 存的是**上一轮 Context 里的 `Scriptable`**，下一轮取出后跨 Context 使用（见 6.3） |
| `remoteJsLibCache` | `ConcurrentHashMap<String,String>`，**满 64 条整表 clear** | 远端 URL（**不按书源**） | 跨书源共享正文：A 源引用的 URL 被 B 源命中即复用（内容相同才无害）；clear 风暴可被单源触发（`:498-504`） |
| `ajaxAllPool` | 全局固定 8 线程守护池 | — | 单源可占满 → 其它源 `ajaxAll` 排队（`:200-207`） |
| `ScriptCache.memory` | 全局 LRU 2048 条（`ScriptCache.kt:25-33`） | `sourceId\u0000key` | 键已隔离 ✅；但 LRU 是**全局**的，单源可把别人的缓存挤掉（性能面，非安全面） |
| DB / Cookie / 变量存储 | 按 `sourceId` 分键（`asVariableStore`、`asCookieStore`…） | sourceId | 见 §8.3 软闸 |

### 6.3 Rhino 线程安全性如何处理

- **本仓没有任何锁、也没有 `synchronized` 包住 `evaluateString`。** 隔离手段是「每 eval 独立 Context + 独立 scope」（§6.1），这在**正常路径**上足够（Rhino 的 `Scriptable` 不是线程安全的，但没有被跨线程共享）。
- **两条破坏「不跨线程共享」的通道**（**needs-runtime-test**）：
  1. `java.put(key, value)` 存原始值（`JsSandbox.kt:2029-2036`），`java.get(key)` 原样取回（`:1226`）→ 第二次求值（**可能是另一个线程、另一个 Context**）拿到的是上一个 Context 创建的 `NativeObject`/`NativeArray`。Rhino 对象的 `parentScope` 指向旧 scope，跨 Context 使用可能表现为原型链异常、`TypeError`、或静默取不到属性。
  2. `cache.putMemory(key, value)` 把原始值放进**进程级全局 LRU**（`:1094-1098` → `ScriptCache.kt:48-50`），同样跨 eval/跨线程。
  - 说明：`cache.get` 的读路径只接受字符串（`:1071-1077`、`ScriptCache.kt:68`），所以「读回对象」只在 `getFromMemory`（`:1108-1111`）上发生；`java.get` 则是**必读回对象**。
- **并发下真实的用户可见症状**（需要在实测里确认）：同一书源并发请求（书架批量刷新）时 `java.get` 返回的对象偶发不可用；`ajaxAll` 结果保序由 `Future.get` 保证（`:1182-1187`），不受影响。
- 已验证的并发正确性成果（可引用）：`lastError` 的 ThreadLocal 化、`sessionKey` 的按源隔离、`remoteJsLibCache` 的并发 map——这三条都是**已修过的串数据 bug**，说明这条线历史上真的出过问题（`JsSandbox.kt:239-240`、`:466-475` 的注释）。

---

## 7. 异常传播与错误分类

### 7.1 脚本抛异常时用户看到什么

| 环节 | 行为 | 位置 |
|---|---|---|
| 捕获 | `catch (e: Exception)`：**吞掉异常、只记原因**，返回 `null` | `JsSandbox.kt:447-452` |
| 原因落地 | `execContext.lastError = detail`（供登录/界面）+ `lastError`（线程级，供无 context 的调用方） | `:449-451` |
| 脱敏 | `scrubInternalSourceTag`：只擦**我们自己的**脚本名行号 `(sandbox-compat\|json-compat\|shape-probe)#N`；**保留** `rule.js#3` / `jsLib.js#12`（书源自己的脚本，对用户有用） | `:696-704` |
| 栈 | **不记录、不返回 Java 堆栈**。Rhino 只给 `异常文案 (脚本名#行)`；Java 侧异常经 `fetchFailureText` 压成一句人话「抓取失败：<最深一层 message>」，取 5 层 cause 防成环 | `:177-185` |
| 规则层传播 | 取不到值 → `RuleExecutionException("正文规则未提取到内容，脚本异常：$lastError")` 这类 | `RuleRunner.kt:470-472`；12a 已展开 |
| 登录层传播 | `SourceLoginActionResult(success = lastError == null, error = lastError)`；v2 渲染失败把 `lastError` 直接给前端 | `RuleLogin.kt:337-353`、`:122-125`、`:70-75` |
| 不可捕获的错误 | `Error`（OOM、StackOverflow）**穿透** `catch(Exception)`，只走 `finally` | §5.5 |

### 7.2 是否吞异常——**吞，而且是分层吞**

- `evalImpl` 吞掉所有 `Exception`（用户只看到一句话 + `null`）。
- 桥内部大量 `runCatching{}.getOrDefault("")`：`java.ajax` 失败回一句文案字符串（`:1160-1161`）、`base64Decode` 回 `""`（`:1463-1472`）、`hexDecode` 回原文（`:1572-1580`）、`aesBase64DecodeToString` 回 `""`（`:1502-1522`）、`toURL` 解析失败给空字段（`:767-798`）。
- **有意的例外（一定范围内"说清是谁失败"）**：`simpleCrypto` / `bytesResult` / `createSymmetricCrypto` / `desLike` 都把失败写进 `lastError`（`:1835-1846`、`:1868-1879`、`:1918-1923`、`:1991-2009`），因为「密文当明文用、界面显示正文为空」是历史上最难排查的错误。
- `java.log` 是**空实现**（`:1244-1248`）→ 脚本的调试输出全部丢失（§9.4 兼容性注意）。

### 7.3 错误如何分类

**代码层没有枚举式的错误类型**，只有**文案前缀 + 抛出层级**：

| 类别 | 判定点 | 用户可见文案形状 |
|---|---|---|
| **网络失败** | `RuleExecutionException("上游返回 HTTP n")` / 「重定向次数超过限制」/ `fetchFailureText` | 「抓取失败：…」——**作为字符串交给脚本**，不抛给脚本（`:1157-1161` 注释：Java 异常直接穿 Rhino 会被包成 `ClassCastException` 文案） |
| **规则失败**（取不到值） | 空结果 → `RuleExecutionException("…未提取到内容")` | 「正文规则未提取到内容，脚本异常：<detail>」 |
| **登录失败** | `execContext.lastError != null` | `ok=false` + `message=detail`（前端原样显示） |
| **脚本超时** | `EvaluatorException("…超过 30000ms 上限，已中断（疑似死循环）")` | 同上「脚本异常：…」 |
| **资源超限** | `IllegalArgumentException("…超过 64MB 上限，已拒绝（疑似脚本放大攻击）")` | 同上；但只有桥调用才产出 |
| **沙箱内部故障** | `error("未实现的 Java 白名单类…")`、`EvaluatorException("org.jsoup.x 失败：…（来自 方法名）")` | 带内部痕迹（已尽量擦） |

**结论**：分类靠**文案约定**，跨 3 个文件（`JsSandbox` / `RuleRunner` / `RuleLogin`）各写一遍。新架构要补一个 `enum RuleFailureKind`（network/script/timeout/budget/login/auth），否则前端永远只能正则匹配中文。这在 §9.2 列为 C-5。

---

## 8. 沙箱逃逸面评估（按攻击面）

> 纪律：以下**没有任何一条**被认定为「存在漏洞」。等级是「静态审查下的可疑度」，凡有推断成分一律 `needs-runtime-test` 并给验证思路。全部验证都在**测试代码里**做（`JsSandbox().eval(...)` + 注入小预算/小超时，与 `JsGuardLimitsTest` / `JsSandboxHostBudgetTest` 同一套手法），**不导入任何恶意书源**。

### E1 · 反射绕过 —— 等级 **低**
- **攻击面**：`Packages.java.lang.Class`、任意对象的 `getClass()`、`getDeclaredMethod` 链、`Function("return this")()`、`__proto__`/`constructor.constructor` 原型链。
- **证据**：`ClassShutter{false}`（`JsSandbox.kt:303`、`RuleRunner.kt:1667`）+ 白名单 43 类里**无** `Class`/`Method`/`ClassLoader`（`JavaPackages.kt:1385-1403`）+ 沙箱内无真 Java 对象（§2.B）。`initSafeStandardObjects` 不给全局 `getClass`。
- **残余疑点**：`JsClass` 是 `BaseFunction` 子类（`JavaPackages.kt:219-236`），其 `constructor`/`__proto__` 属于 **JS 层**（Rhino 的 Function 原型），不指向 Java 反射——但「Rhino 的 `Function` 能不能拿到宿主 Java 类」这件事没有实测。
- **验证思路**：
  ```kotlin
  // 一条脚本，逐项断言全部为 undefined / 抛 TypeError
  """
  var probes = [
    typeof Packages.java.lang.Class,              // 期望 "undefined"
    typeof Packages.java.lang.Runtime,            // 期望 "undefined"
    typeof Packages.java.lang.Class.forName,      // 期望 "undefined"
    typeof JavaImporter,                          // 期望 "function"（我们的替身）
    ({}).getClass === undefined,                  // 期望 true
    typeof Function("return this")().Packages,    // 期望 "object"（白名单树，不是 Rhino 的）
    typeof Function("return this")().java.lang,   // 期望 "undefined"（我们只注入了 java 桥）
  ];
  JSON.stringify(probes)
  """
  // 另测：Packages.java.util.Arrays.getClass —— 拿到的 JsClass 是 BaseFunction，
  //       .getClass 应为 undefined；.constructor 应为 Function（JS 侧），其构造的实例无 Java 能力
  ```
  再加一条**基线式**判据：复用 `JavaPackagesEntryBaselineTest` 的反射枚举，断言暴露面集合**逐字不变**。

### E2 · 宿主对象泄漏（把真实 Connection/Database 传进沙箱）—— 等级 **低，但结构性脆弱**
- **攻击面**：`JsSandbox.toJsValue`（`:2090-2098`）的 `else -> Context.javaToJS(value, scope)`。**任何非 Map/List/String 的 Kotlin 对象**作为 binding 传进来，就会被 Rhino 包成 `NativeJavaObject` 落进 scope——此时只剩 `ClassShutter` 一层防护（与 §1.4 的「压根不放 Java 对象」设计相悖）。
- **现状**：全部调用点都只传 `String`/`Map`/`emptyMap`/`Int`/`Boolean`：
  `RuleRunner.kt:290`（baseUrl/sourceId）、`:592`（baseUrl/sourceId/result=emptyMap）、`:723`（result=Base64 串）、`RuleLogin.kt:62`/`:111-117`/`:329-335`（state/form JSON 串 + loginData）。
  → **当前无泄漏（confirmed）**；但这条通道没有任何机制拦住「下一个人顺手把 `db` 或 `Fetched` 塞进 bindings」。
- **同类残留**：`java.put`（`:2033`）与 `cache.putMemory`（`:1096`）会把**上一轮的 Rhino 对象**存起来跨执行复用（§6.3）。
- **验证思路**：
  ```kotlin
  // ① 负向：断言所有注入对象的类型
  val sandbox = JsSandbox()
  val out = sandbox.eval("""
    function probe(o){ return o === null ? "null" : (typeof o + ":" + Object.prototype.toString.call(o)); }
    JSON.stringify([probe(java), probe(source), probe(book), probe(chapter), probe(cache), probe(org)])
  """, emptyMap(), JsExecutionContext(sourceId = "https://leak.example"))!!
  // 期望全部是 "object:[object Object]" / "function:…"，出现 "object:[JavaObject …]" 即失败
  // ② 正向（应当安全）：传一个真实 Java 对象作为 binding，断言脚本拿不到它的方法
  val rr = RuleRunner(database = null)
  sandbox.eval("String(result.getClass)", mapOf("result" to rr), JsExecutionContext())  // 期望 "undefined" 或不含类名
  ```
  并把「bindings 只允许 String/Number/Boolean/Map/List」做成**类型层约束**（新架构用一个 sealed `JsBinding` 代替裸 `Map<String,Any?>`）。

### E3 · `load()` / 远端脚本 —— 等级 **中（设计内，但缺一道确认）**
- **`load()` 本身不存在**：`initSafeStandardObjects` 不含 `load`/`loadClass`/`defineClass`/`readFile`/`readUrl`（§2.A，likely）。
- **真正等价于 `load()` 的是四个入口**：
  1. `Reload(url)`（`:347-368`）——抓回**字符串**，脚本自己 `eval(String(Reload(...)))`；
  2. `java.importScript(path)`（`:1404-1422`）——抓回字符串，**空内容抛 `EvaluatorException`**；
  3. `evalLibrary` 的**远端 jsLib 映射**（`:488-507`）——`jsLib` 写成 `{"名":"https://…js"}` 时，**每次规则求值都会先把远端 JS 抓下来并 `cx.evaluateString`**，无需用户任何动作，也无需脚本显式调用；
  4. `java.cacheFile(url)`（`:1379-1399`）——抓回字符串（本身不执行，但与 1/2 组合即可执行）。
- **防护现状**：全部走同一条 `runner.fetch` → `NetworkSecurity` SSRF 闸门（§4.2）+ 2 MiB 响应上限。缓存 `remoteJsLibCache` 按 URL 存正文、满 64 条清空（`:498-504`）。
- **残余风险**：**远端 JS 在沙箱内执行，沙箱 = 全部白名单能力**（含 `java.ajax`、`cookie.getCookie`、`source.setVariable`、`cache`）。也就是说「导入一个引用外站 jsLib 的书源」≈「信任那个外站随时推新代码」；而**这一条不区分用户意图**，与「只导入信任书源」的安全前提是同一个前提（源码注释 `:355-359` 自己承认：「执行权仍然交给书源自己的 eval —— 满足"只导入信任书源"的安全前提」）。
- **验证思路**：
  ```
  本地起一个 http 服务（或 FETCHER 桩）回一段 JS：
    (a) 记录 java.ajax 是否可用 → 证明远端脚本拿到了全部能力
    (b) 记录 source.setVariable / cache.put 能否改写库内数据
  另测 NetworkSecurity 是否真的挡住 http://127.0.0.1:<port>（期望抛「拒绝访问内网或本机地址」）
  再测 2MiB 上限：回一个 3MiB 的 jsLib，期望 RuleExecutionException 而不是把 3MiB 喂给 Rhino
  ```

### E4 · 脚本缓存投毒 / 跨源污染 —— 等级 **低-中**
- **已隔离的部分（confirmed）**：
  - `ScriptCache` 内存+磁盘键都是 `sourceId\u0000key`（`ScriptCache.kt:36`、`:77-87`）；
  - `sessionStore` 键 `sourceId\u0000key`（`JsSandbox.kt:239-240`）；
  - `java.cacheFile` 用 `"dl:"+md5Hex16(url)` 作键，但**存储仍按 sourceId 分**（`:1381-1387`）。
- **未隔离的部分**：
  1. `remoteJsLibCache` **按 URL 全局共享**（`:486-506`）——A 源与 B 源引用同一 URL 时共用一份正文。若该 URL 内容可被第三方改写（外站），**一次投毒同时影响所有引用它的源**；反之若某源能让人写入该 URL（不成立，只读），则是直接投毒。
  2. `ScriptCache.memory` 是**全局 LRU 2048**（`ScriptCache.kt:25-33`）→ 单源可把其它源的缓存条目挤掉（可用性面）。
  3. `java.put` 的 `sessionStore` **无容量上限**（§6.2）→ 单源可留下 GB 级常驻对象。
- **验证思路**：
  ```
  ① 两源同 key 隔离：sourceId=A 写 cache.put('k','A')，sourceId=B 读 cache.get('k') → 期望 null
  ② jsLib 跨源共享：A/B 同 jsLib URL，桩只允许抓一次 → 断言桩调用次数=1（证明共享）
     再让桩返回不同内容第二次 → 断言 B 拿到的是第一次的旧内容（证明"投毒窗口"存在）
  ③ sessionStore 无界：在预算内跑 for(i<200000) java.put('k'+i, repeat(200)) 后测堆增长（不设 limit，看是否被任何机制拦住）
  ```

### E5 · 加密脚本（`ScriptCrypto`）密钥管理 —— 等级 **低**
- **不存在宿主密钥**：`ScriptCrypto` / `JavaPackages` 的加密族**只用脚本传进来的 key/iv**（`ScriptCrypto.kt:90-99`），没有 keystore、没有 `KeyStore`、没有预置密钥、没有 PBKDF；`KeyFactory`/`SecretKeyFactory`/`Signature` 的算法名也是脚本给的（`JavaPackages.kt:461-483`、`:516-532`、`:1066-1093`）。
- **「密钥管理」在本项目里的真实含义**：书源的 AES key **明文存在书源 JSON 里**（社区源本来就这么分发），沙箱只负责算法等价。所以「密钥泄漏」不是沙箱问题，而是**书源即凭据**的问题。
- **唯一的技术疑点**：脚本可控的 `transformation` / `algorithm` 直接进 `Cipher.getInstance` / `Signature.getInstance`（无 `runCatching`，`JavaPackages.kt:1024`、`:1067`）→ 未知算法抛的是**原始 Java 异常**，穿进 Rhino 后可能变成脚本 `catch` 接不住的 `WrappedException`（同类问题在 `importScript` 处被显式修过：`:1414-1417` 注释「raw IllegalStateException 会穿透 JS catch，最后变成 cannot be cast to java.lang.Error」）。
- **验证思路**：
  ```kotlin
  // ① 算法名乱写的可控性
  eval(""" try { Packages.javax.crypto.Cipher.getInstance("NO/SUCH/ALG"); "caught" } catch(e) { "caught:" + (e && e.message) } """)
  // 期望拿到 "caught:…"；若返回 "caught" 说明 JS catch 接住了（好）；若整个 eval 抛错 → 复现了穿透问题
  // ② 密钥材料上限：循环 new SecretKeySpec 1100 次，期望第 1025 次抛「密钥/IV 超过 1024 个上限」
  // ③ 断言沙箱内不存在 KeyStore / SecureRandom 之外的真随机源 / 文件型 keystore
  ```

### E6 · HTML/JSON 桥的注入面 —— 等级 **中（本册最值得警惕的一条）**
- **`JsoupBridge` 本身很窄（confirmed）**：只 `parse`/`parseBodyFragment`（`:38-44`），**没有 `Jsoup.connect`**（`:22-26` 明说「那是网络出口，不在这里开第二条路」），元素包装只挂只读方法（`:76-118`），越界下标返回 `undefined`（`:194-196`），异常一律转 `EvaluatorException` 带方法名（`:197-199`）。**HTML 解析不经网络、不读文件、不碰 `baseUri` 以外的东西**。
- **真正的注入面在「内容往哪去」**：
  1. `java.htmlFormat` → `ScriptHtml.formatKeepImg`（`ScriptHtml.kt:37-53`）**故意保留 `<img src="…">`**，含页面里的任意 `data-*` 值。这段字符串最终会作为正文进前端 → `img src` 可控。
  2. `java.startBrowserAwait('data:text/html;base64,…')` → `decodeDataUrlText`（`JsSandbox.kt:191-215`）→ `execContext.inlineHtml` → 交给**界面 iframe 本地渲染**（`:1294-1309`，注释：「书源自带设置页由界面 iframe 本地渲染；关闭时把整页 HTML 交回来」）。
     → **这是唯一让书源控制的 HTML/JS 在「宿主浏览器里」执行、而不是在 Rhino 沙箱里执行的通道。** 它绕过了本节讨论的所有 Rhino 防护。
  3. `execContext.browserBody`（界面交回的整页 HTML）会被再次喂给脚本当 `r.body`（`:1298-1300`）——数据流是双向的。
- **验证思路**：
  ```
  ① htmlFormat 注入：java.htmlFormat('<img src="javascript:alert(1)">') → 断言输出仍含 javascript: 协议
     再跟到前端渲染层（ReaderBody 的图片渲染 / img src 归一化）确认有没有协议白名单 —— 若前端做了
     http(s)/data 白名单则降为「低」；若原样进 img src 则必须列为「中」
  ② inlineHtml：用 startBrowserAwait('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')
     走一次登录 UI 渲染，检查 iframe 的 sandbox 属性 / CSP / origin。这是 needs-runtime-test 的核心一项，
     必须在前端侧（InlineBrowser/WebViewProxy）复核，本册无权限到那一步
  ③ JSON 桥：book/chapter/JsMapObject 均为 NativeObject + 兜底方法（JsMapObject.kt:51-107），
     断言 for..in 遍历不会把方法当数据带出（注释 :18-20 声称如此，需实测确认）
  ```

### E7 · 其他值得记录的三条（补充，非清单要求但同等级）

| # | 面 | 等级 | 证据 | 验证 |
|---|---|---|---|---|
| **E7a** | **`java.ajax` 系列绕过墙钟**：JS 网络调用不传 `deadlineMs`，阻塞期间指令观察器零回调 → 100 次 `java.ajax` ≈ 33 分钟 | **中** | §4.4 全表（`:1160`/`:1222`/`:1198`/`:1804`/`:1823`/`:1386`/`:351` 均无 `deadlineMs`；仅 `JavaPackages.kt:1255` 有） | 桩地址 `delay(20_000)`，注入 300ms 超时，跑 `for(i<5) java.ajax(u)`，测真实耗时（期望 ≈100s 即证明守卫失明） |
| **E7b** | **`sessionStore` / `cache.putMemory` 把 Rhino 对象存进程级容器**（跨 eval、跨线程、无上限、不计预算） | **中** | `JsSandbox.kt:2033`（无 cap）、`:1096`、`ScriptCache.kt:48-50` | 见 E4 ③ + §6.3 的跨 Context 用例 |
| **E7c** | `mainJs` 路径无 hostByteBudget | 低 | `RuleRunner.kt:1665`（`enter()` 只传超时） | 断言 `BoundedJs.hostBytesSpent()` 在该路径恒 0 且不抛预算错 |

---

## 9. 结论：这块能不能原样搬进新架构

### 9.1 结论

**可以搬，但不能「原样」搬。** 现状是**一个「白名单 deny-all」的优秀骨架 + 三层不完整的外围**：
- 第 1 层（`ClassShutter{false}` + `initSafeStandardObjects`）：**强，可原样搬**，是本项目相对上游的真正优势。
- 第 2 层（手写 43 类替身 + 98 个静态入口）：**方向正确、有枚举基线判据（`JavaPackagesEntryBaselineTest`）**，但它是「漏一个就是一个洞」的形状，必须**连同基线判据一起搬**，否则等于把洞当成 API 搬走。
- 第 3 层（墙钟 20k 指令 / 64MB 宿主预算 / 8MB 单次 / 16MB GZIP）：**只覆盖「宿主分配 + 死循环」两类**，**不覆盖纯 JS 堆、不覆盖网络阻塞、不覆盖累计态（sessionStore）**。

### 9.2 搬之前必须先补的判据与约束（按优先级）

| # | 必须补的 | 为什么（本册证据） | 形态 |
|---|---|---|---|
| **C-1** | **出站预算**：单次执行的请求次数上限 + 出站总字节上限 | §4.4：三项全无；`MAX_BODY_BYTES` 只逐响应；`AppConfig.kt:158` 明说网络字节不计入预算 | 在 `BoundedContext` 加 `fetchCount` / `egressBytes`，在所有 `runner.fetch*` 入口统一 charge（与 `chargeHostBytes` 同形） |
| **C-2** | **JS 网络调用的墙钟**：让 `java.ajax/get/post/connect/head/cacheFile/Reload` 也传 `deadlineMs` | §4.4 / E7a：只有 okhttp3 传了 | 一行改动 ×7 处，但**必须逐个单测**（这些入口被全部书源共用，`fetchResponse` 的 `deadlineMs=null` 默认值是为兼容留的） |
| **C-3** | **纯 JS 堆的上限**：要么进程隔离（子进程 + `-Xmx`），要么接受并写清「OOM 会穿透 `catch(Exception)`」 | §5.5：`hostByteBudget` 对 Rhino 堆完全失明；`OutOfMemoryError` 不被捕获 | 短期：捕获 `OutOfMemoryError` 的风险评估 + `-Xmx` 显式设定 + 文档化；长期：JS 执行独立进程（`rhino` 已是纯 JVM 依赖，`JsGuard`/`GzipLimits` 已刻意不依赖 `io.legado`，`JsGuard.kt:22-24`、`GzipLimits.kt:30` 都写了「这是将来把沙箱层拆成独立模块的前提」——**作者已经预留了这条路**） |
| **C-4** | **累计态封顶**：`sessionStore` 与 `cache.putMemory` 的容量/字节上限 | §6.2 / E7b：预算 per-eval，但容器 per-process | 加 cap + LRU；或让 `java.put` 只存**字符串**（上游 `put` 就是 `value.toString()`，`JsSandbox.kt:1049` 的注释也这么说） |
| **C-5** | **错误分类枚举**：`RuleFailureKind` | §7.3：分类靠中文文案跨 3 文件各写一遍 | `enum { Network, Script, Timeout, Budget, Login, Parse }` + 保留现有文案 |
| **C-6** | **bindings 类型约束** | §E2：`toJsValue` 的 `javaToJS` 兜底是唯一「放真 Java 对象进来」的通道 | `sealed interface JsBinding`，只允许 String/Number/Boolean/Map/List/Bytes |
| **C-7** | **嵌套求值的预算正确性** | §1.2：内层 `enter` 可能覆盖外层 `deadlineMs`/`hostBytes` | 实测 `ContextFactory.enter()` 语义；若有复用，改成「取 min(deadline)、累加 hostBytes、引用计数」 |
| **C-8** | **`inlineHtml` / 图片 src 的宿主侧白名单** | §E6：唯一绕过 Rhino 的通道 | 前端 iframe `sandbox` + `img src` 协议白名单（跨册，需前端审计员确认） |
| **C-9** | **`mainJs` 路径补 `hostByteBudget`** | §5.4 | 一行改动 |
| **C-10** | **`fetchedFetcher`/`responseFetcher` 桩只能测试注入** | §4.2：短路 SSRF 闸门 | 装配层禁止 + 一条断言的架构测试 |

### 9.3 **绝对不能改语义**的地方（社区书源依赖的宿主 API 行为）

按「改了就有成百上千份源静默失败」排序。每一条都在源码里带实测份数注释，**新架构必须逐字保留**：

| 语义 | 为什么不能动 | 证据 |
|---|---|---|
| **`java.get` 的双重分派**：`args.size>=2 \|\| 看起来是 URL` → HTTP GET，否则 → KV 读 | 曾经两个注册互相覆盖 → 所有用 `java.get` 抓页的源拿到 `undefined`（「执行成功但内容为空」） | `JsSandbox.kt:1212-1228` |
| **`JSON.parse` 兼容层**（对象直接返回、字符串走原解析） | 不做 → 「搜索完成：0 项」（try/catch 吞掉后整条记录消失） | `:306-341` |
| **`JsScriptShape` 的「顶层 return 才包 IIFE」** | 按文本搜 `return` 会吞掉 210 份源的结果 | `JsScriptShape.kt:14-27`、`JsSandbox.kt:288-294` |
| **`responseView` 的「既是字符串又是响应对象」** | 116 处调字符串方法、115 处调 `.body()`/`.statusCode()`；只给一种另一批就碎 | `:596-679` |
| **`cookie.setCookie/replaceCookie/setWebCookie/removeCookie` 返回空串** | 返回 `true` 会让 253 份源的 searchUrl 变成 `true/search/...` | `:996-1020` |
| **`source.getVariable()` 未命中回 `""`；`book.getVariable()` 未命中回 `"null"`（字符串！）** | 上游 `RuleDataInterface` 的真实行为；改成 `null` 会让 `+` 拼接变 `"undefined"` | `:563`、`:935-939` |
| **`getUserAgent() === getWebViewUA()` 必须相等** | 蓝批系列用相等性判「是否运行在阅读里」，不等会走降级分支 | `:155-168`、`:1344-1355` |
| **`timeFormatUTC(ts, fmt, 小时)` 按小时换算**（**故意偏离上游**） | 上游把小时当毫秒传，等于不生效；照抄会让番茄系时间错 8 小时 | `:1661-1680`（注释明确记录这是有意为之） |
| **`java.getStringList` vs `getElements` 的区别**（取值列表 vs 条目本身） | `.dropDown@li@data-p` 要的是属性列表；JSONPath 要的是条目文本 | `:1705-1785` |
| **`loginUrl` 的 JS 只在 `includeLoginScript=true` 时执行** | 普通规则预跑它，qyyuapi 系脚本的 `put($$$)` 会打断搜索 | `:96-105`、`:426-431` |
| **未知类静默 `undefined`**（不是抛错） | 大量 try/catch 探测型源（魔改版探测）依赖它安静失败 | `JavaPackages.kt:50-51`、`:86-95` |
| **`Reload` 挂浏览器 UA + Referer** | qyyuapi 系按 UA 拦，默认 UA 直接 403 | `JsSandbox.kt:120-123`（`reloadFetchUrl`）、`:134-158`（`headerSafe` + 两个 UA 常量） |
| **`importScript` 空内容抛 `EvaluatorException`**（不是 Java 异常） | Java 异常会穿透 JS catch，最后变成 `cannot be cast to java.lang.Error` | `:1414-1417` |
| **数字输出去掉 `.0`** | Rhino number 恒 double，`a.length` 会印成 "2.0" 直接显示到界面 | `:800-812` |

### 9.4 兼容性遗留（不阻塞搬迁，但要记账）

1. **没有 `console`，`java.log` 是空实现**（`:1244-1248`）→ 书源作者的调试输出全丢。新架构若要加 `console`，需要评估「脚本用 `console.log` 探测宿主」的既有写法（目前会 ReferenceError，某些源可能用 try/catch 探测）。
2. **`isLongClick` / `book.readConfig` / `chapter.start-end` 均为桩值**（`:536-537`、`:547-549`、`:517-518`）。
3. **`java.toast` 只收集不弹**（`:1231-1241`），由前端决定。
4. **`Thread.currentThread().getName()` 硬编码 `"main"`**（`JavaPackages.kt:252`）——脚本若用它判线程会得到假信息（比泄漏真实线程名好）。
5. **`java.version` 返回真实 JVM 版本**（`:268`）——审计文档 §3 F 项判定「刻意保留，收益接近零、风险非零」（`product/docs/rules-sandbox-audit.md:83`）。

---

## 10. 证据索引 + 未确认 + 覆盖率

### 10.1 证据索引（本册所有 `file:line` 按主题归并）

| 主题 | 位置 |
|---|---|
| **进入/退出** | `JsSandbox.kt:300`（enter）、`:301`（try）、`:447`（catch Exception）、`:452`（return null）、`:456`（finally exit）；`JsGuard.kt:106-117`（enter/exit）、`:44-48`（观察器）、`:63-64`（解释模式+阈值）、`:76`（栈深）、`:87`（ES6） |
| **scope 与注入** | `JsSandbox.kt:304`（initSafeStandardObjects）、`:331`（org）、`:349-351`（bindings）、`:339`（java）、`:347`（Reload）、`:360`（Packages/JavaImporter/importPackage/importClass）、`:366`（source）、`:377`（cookie）、`:384`（put）、`:404-408`（cache）、`:411`/`:413`（book/chapter）、`:418`（environment）；`JavaPackages.kt:70-75`（install） |
| **白名单** | `JavaPackages.kt:1385-1403`（CLASS_NAMES 43）、`:1405-1406`（PACKAGE_CLASSES）、`:1408-1413`（NAMESPACES）、`:81-96`（PackageNode.get）、`:192-196`（resolve）、`:129-170`（ImporterObject）、`:172-181`（importPackage）、`:183-188`（importClass）、`:238-645`（buildClass 全表）、`:644`（未实现 error） |
| **危险类** | `JavaPackages.kt:240-260`（Thread 替身+sleep cap）、`:261-277`（System 替身，无 exit）、`:272-275`（getenv 恒空）、`:425-438`（HashMap/ArrayList 替身） |
| **shutter** | `JsSandbox.kt:303`、`RuleRunner.kt:1667` |
| **网络** | `JsSandbox.kt:1150`（ajax）、`:1168`（ajaxAll）、`:1193`（post）、`:1215`（get 双分派）、`:1800`（connect）、`:1819`（head）、`:1393`（cacheFile）、`:1404`（importScript）、`:347`（Reload）、`:488-507`（远端 jsLib）；`JavaPackages.kt:1203-1260`（okhttp3→fetchResponse+deadline）；`RuleRunner.kt:1059`/`:1070`（fetch/fetchResponse）、`:1221-1311`（fetchDetailedImpl）、`:1315-1323`（validateTarget→NetworkSecurity）、`:1332`（buildRequest 调用）、`:1334`（20s）、`:1239`（4 跳）、`:1381-1400`（effectiveHeaders/Cookie）、`:1257-1266`（Set-Cookie 落罐）；`ResponseBody.kt:20`/`:98`/`:110`（2 MiB） |
| **内存/时间预算** | `JsGuard.kt:26-49`（BoundedContext）、`:132-144`（chargeHostBytes）、`:158`（deadlineOrNull）；`JavaPackages.kt:772-781`（requireAllowedLength+记账）、`:784-793`（StringBuilder）、`:806-813`（keyMaterial cap）、`:1349-1375`（四个常量）、`:606`/`:614`（GZIP 记账）；`GzipLimits.kt:35`/`:45-61`/`:64`/`:76-86`；`AppConfig.kt:148`（30s）、`:151`（64MB）、`:176-179`（0=不设限） |
| **并发** | `JsSandbox.kt:239-240`（sessionKey）、`:250-263`（threadContext+withSourceContext）、`:462-475`（lastError ThreadLocal）、`:200-207`（ajaxAllPool）、`:486-507`（remoteJsLibCache）；`ScriptCache.kt:25-36`（全局 LRU + 按源分键） |
| **错误** | `JsSandbox.kt:696-704`（擦内部 tag）、`:177-185`（fetchFailureText）、`:1835-1846`/`:1868-1879`/`:1918-1923`（lastError 记录）；`RuleRunner.kt:470-472`；`RuleLogin.kt:70-75`/`:122-125`/`:337-353` |
| **登录入沙箱** | `RuleLogin.kt:44-78`（v2 render，`includeLoginScript=true`）、`:84-130`+`:320-354`（v2 action / v1 action）、`:250-261`（v1 loginUi 脚本）、`:356-394`（loginCheckJs） |
| **既有判据** | `JsGuardLimitsTest`（墙钟真触发 + GZIP）、`JsSandboxHostBudgetTest`（累计预算）、`JsSandboxResourceLimitTest`（4 个宿主上限+sandbox 存活）、`JsSandboxHostAmplificationTest`（脚本可控 length 模式）、`JsSandboxRequestShapeTest`（无 Java 引用）、`JavaPackagesEntryBaselineTest`（43/98/13 枚举基线）、`JsoupBridgeTest`、`JsScriptShapeTest`、`StrUtilFormatTest` |
| **既有审计文档** | `product/docs/rules-sandbox-audit.md`（109 行，10 项已修 + A~G 逐项，E 项 2026-11-14 收口） |

### 10.2 未确认事项（needs-runtime-test，按重要性）

| # | 未确认 | 为什么静态无法定论 | 验证入口 |
|---|---|---|---|
| U1 | 纯 JS 堆分配是否先于墙钟 OOM | Rhino 堆无 instrument；取决于 `-Xmx` 与分配速率 | §5.5 脚本 |
| U2 | `ContextFactory.enter()` 是否复用线程 Context（→ 嵌套预算洗白） | 属 Rhino 库语义，本仓未覆盖 | 断言 `BoundedJs.hostBytesSpent()` 在嵌套 eval 前后是否被清零 |
| U3 | `java.ajax` 等 7 个入口的阻塞是否完全无视墙钟 | 依赖「阻塞期间观察器零回调」这一 Rhino 行为（代码注释自述，未实测） | E7a 桩地址测耗时 |
| U4 | `initSafeStandardObjects` 到底不给哪些全局（`load`/`print`/`getClass`/`console`） | 属 Rhino API，随版本变化 | S-0：`typeof load/print/getClass/console/readFile/quit` 全表断言 |
| U5 | `jsLib` 远端脚本是不是**每次规则求值都抓一次**（首次后走缓存） | 缓存键是 URL、命中即复用，但首轮 N 次抓取无法从静态看出 | 桩计数 |
| U6 | `inlineHtml` 的 iframe 在执行书源 HTML 时有无 sandbox/CSP | 属前端（本册无权限） | E6 ②，交前端审计员 |
| U7 | `java.get` 取回的跨 eval Rhino 对象在实际并发下会不会坏 | Rhino 线程语义 | §6.3 |
| U8 | `Cipher.getInstance(脚本给的名字)` 抛的 Java 异常能否被 JS `catch` 接住 | 与 `importScript` 同类问题，但那条是显式修的 | E5 ① |
| U9 | `org.jsoup` 元素包装在 `for..in` / `JSON.stringify` 下的真实形状 | Rhino NativeObject 序列化语义 | E6 ③ |

**明确不在本册范围（留给其他审计员）**：`WebViewProxy`（书源 WebView 代理）、前端 `img src` 渲染白名单、`Database`/Cookie 存储的加密、`mainJs` 执行链细节（12a）。

### 10.3 覆盖率声明

- **本册必读清单 11 个文件：10 个整篇（100%）+ `ScriptConvert.kt` 结构级（非安全面，简繁表）**。
- **JsSandbox.kt：2100/2100 = 100%**（6 块窗口：1–240 / 240–520 / 520–830 / 830–1120 / 1120–1500 / 1500–1880 / 1880–2100）。
- **JavaPackages.kt：1415/1415 = 100%**（1–200 / 200–470 / 470–700 / 700–880 / 880–1000 / 1000–1135 / 1130–1290 / 1290–1415）。
- **交叉文件按 JS 面读全**：`RuleLogin.kt`（JS 入口 8 处全覆盖）、`RuleRunner.kt`（fetch/buildRequest/effectiveHeaders + 两处 shutter + 全部 `jsSandbox.eval` 调用点）、`ResponseBody.kt`/`AppConfig.kt`（额度常量）。
- **未读**：`RuleRunner` 的取值/切分主体（12b 范围）、`ScriptConvert` 的转换表实现、`WebViewProxy`（他人范围）。
- **统计**：43 个白名单类 / 21 个可达命名空间 / 14 个注入全局 / 11 个网络出口 / 9 个宿主上限常量 / 8 条已识别逃逸面（含 3 条补充）/ 9 项未确认。

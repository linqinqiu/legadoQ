# 12a · RuleRunner 执行链与 HTTP 耦合（Phase 0.5 深读）

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

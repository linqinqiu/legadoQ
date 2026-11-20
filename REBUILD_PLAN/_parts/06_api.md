# 06 API 与前后端契约审计

> 审计对象：只读归档 `E:\legadoQ-archive`（Phase 0 基线）。
> 审计员：API 与前后端契约组。产出时间：2026-11-17。
> 标注约定：**【事实】**＝从源码/文件直接读出并可复现；**【推断】**＝由事实推出但未运行验证；**【建议】**＝重建时的意见；**【未确认】**＝本次未能证实。
> 纪律声明：本次**未启动服务、未发任何 HTTP 请求**；全部结论来自读源码、`grep`、目录清点与文件比对。

## 0. 方法与覆盖

### 0.1 方法

| 步骤 | 做法 | 产物 |
|---|---|---|
| 端点清点（实际注册） | 写了一个只读解析脚本，按**花括号深度 + `route("…")` 前缀栈**遍历 `product/app/src/main/kotlin/io/legado/http/`（含 `system/` 子包）全部 14 个路由文件，识别 `get/post/put/delete/patch/head/options("…")`、无路径的 `get { }`／`post { }`（挂在 `route("/sources/{id}")` 等前缀下）、`webSocket("…")`、以及 `for (verb in listOf(HttpMethod…)) { method(verb) { } }` 的 5 次注册 | 146 条端点 |
| 端点清点（宣称） | 解析 `product/app/src/main/resources/agent-api.json`，取其 `count` 字段与 `endpoints[]` 数组 | 144 条 / 18 组 |
| 双向差异 | 两侧规范化为 `METHOD /path` 排序后 `comm` 比对 | 见 §2 |
| 每个端点的处理器体检 | 同一脚本对每个注册点向下扫到「下一条注册语句」为止的处理器体，抽取 `receive<X>()`、`receiveStrictText()`、`respond(X(…))`、`database.*`／`repositoryFor(call).*`／`webView.*`／`runner.*` 调用、`queryParameters["x"]`、`HttpStatusCode.*`、`requireSameOriginWrite()` | 表 1 的请求体/响应/DAO/鉴权列 |
| 前端侧 | 扫 `product/web/src/**/*.{ts,tsx}` 里所有 `/api/…` 字面量与模板串（含 `${…}` 归一化） | 117 个不同路径形态，全部与后端模板匹配（0 条指向不存在的端点） |
| 测试覆盖 | 扫 `product/app/src/test/kotlin/` 全部测试里的 `client.get/post/put/delete("…")` 与 `HttpMethod.X` 组合，按方法与路径模板（`{id}`→任意段）匹配端点 | 69 / 146 |

### 0.2 只读与边界

- 只读了 `product/app/src/main/kotlin/io/legado/http/**`、`model/**`、`product/web/src/lib/api/**`、`product/app/src/test/kotlin/**`、`product/web/test/ApiCatalog.test.ts`、`product/app/src/main/resources/agent-api.json`、`Application.kt` 的插件段。
- 未进入 `**/build/**`、`node_modules/**`、`dist/**`、`product/data/**`。
- 大文件只取窗口：`SourcesRoutes.kt`（830 行）读了 138–232、280–320、419–470、480–520、556–720 段；`types.ts`（956 行）按类型名 `grep -n` 后取窗口。
- 未对 `agent-api.json` 的 `purpose`／`response` 文案逐条核对——那些是**宣称**，只在源码里拿不到类型时作补充（表 1 中标注「宣称：」）。

### 0.3 一个必须先说清的口径问题

「组」有两个互不相同的数法，混用就会得出错误结论：

| 数法 | 数字 | 依据 |
|---|---|---|
| 目录（`agent-api.json`）的 `group` 字段 | **18 组** | 目录 / 系统 / 书源 / 登录与凭据 / 内置浏览器 / 发现页 / 搜索 / 书架 / 阅读 / 净化规则 / 分章规则 / 图片与媒体 / 进度与笔记 / 朗读 / RSS / 书源订阅 / 备份 / 离线缓存 |
| 文件/子面（本文表 1 的分法） | **17 段** | 按 `*Routes.kt` 文件 + 文件内 `route("…")` 子面切；`SourcesRoutes.kt` 一个文件就覆盖了目录里的「书源」「登录与凭据」「内置浏览器」三组，共 46 条 |

**【事实】** 目录的 18 组不是代码结构，代码里也没有任何 group 元数据：`Routes.kt:70-86` 只有 13 个 `xxxRoutes(...)` 装配调用，`SourcesRoutes.kt` 独占 46/146 条。这是重建时最该先解决的问题之一（见 §9）。

## 1. 端点全表（按组，146 条）

列说明：
- **路由文件:行**＝`product/app/src/main/kotlin/io/legado/http/` 下的相对路径 + 注册语句行号（`grep -n` 可复现）。
- **请求体 DTO**＝处理器里 `call.receive<X>()` / `receiveStrictText()` 读到的类型；`—` 表示不读请求体（只用路径/查询参数）。
- **响应**＝处理器里 `respond(X(...))` 的 DTO；写「宣称：」的是处理器经辅助函数/二进制通道回包、本次未能静态解析出类型，取 `agent-api.json` 的 `response` 字段（**属宣称，未逐条回源验证**）。
- **鉴权**＝该处理器内部是否调 `requireSameOriginWrite()`（`http/Guard.kt:105`）。注意全局插件 `SameOriginWriteGate`（`http/Guard.kt:72`，装于 `Application.kt:273`）对**所有非安全方法**生效，与处理器是否手调无关——区别见 §7。
- **Repository / DAO**＝处理器里直接触达的仓储/DAO 方法名（`database.*` 即 DAO，`repo.*` 是 `repositoryFor(call)` 返回的 `SourceRepository`）。

### 1.1 系统（9 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 1 | `/api/about` | GET | `system/SystemRoutes.kt:106` | — | `AboutInfo` | 读方法直接放行 | — |
| 2 | `/api/about/update-check` | POST | `system/SystemRoutes.kt:109` | — | `UpdateCheck.check` | 写门+全局插件 | — |
| 3 | `/api/catalog` | GET | `system/SystemRoutes.kt:49` | — | 宣称：{service,version,scope,howToConnect,workflow | 读方法直接放行 | — |
| 4 | `/api/changelog` | GET | `system/SystemRoutes.kt:113` | — | 宣称：整篇 Markdown 文本 | 读方法直接放行 | — |
| 5 | `/api/diagnostics` | GET | `system/SystemRoutes.kt:93` | — | `Metrics.snapshot` | 读方法直接放行 | — |
| 6 | `/api/logs` | DELETE | `system/SystemRoutes.kt:87` | — | 宣称：成功是 204，没有响应体 | 写门+全局插件 | — |
| 7 | `/api/logs` | GET | `system/SystemRoutes.kt:80` | — | `LogService.queryLogs` | 读方法直接放行 | — |
| 8 | `/api/server` | GET | `system/SystemRoutes.kt:59` | — | `ServerInfo` | 读方法直接放行 | — |
| 9 | `/api/server/port` | PUT | `system/SystemRoutes.kt:62` | `ServerPortRequest` | `ServerPortResult` | 写门+全局插件 | — |
### 1.2 书源 CRUD/批量/排序/导入导出（10 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 10 | `/api/sources` | GET | `SourcesRoutes.kt:138` | — | 宣称：[{id,name,url,group,enabled,isJsSource,hasLo | 读方法直接放行 | `repo.list` |
| 11 | `/api/sources/batch` | POST | `SourcesRoutes.kt:232` | `BatchSourceRequest` | 宣称：{ok,affected,action,message} | 写门+全局插件 | `repo.batchUpdate` |
| 12 | `/api/sources/export` | GET | `SourcesRoutes.kt:260` | — | 宣称：字符串数组，每个元素是一份书源的 JSON 字符串（可直接喂给 /api/sources | 读方法直接放行 | `repo.exportSources` |
| 13 | `/api/sources/health-check` | POST | `SourcesRoutes.kt:250` | `SourceHealthCheckRequest` | 宣称：{total,successCount,slowCount,failedCount,du | 写门+全局插件 | `repo.healthCheck` |
| 14 | `/api/sources/import` | POST | `SourcesRoutes.kt:266` | `ImportRequest` | 宣称：{imported,updated,skipped,errors[]} | 写门+全局插件 | `repo.importSources` |
| 15 | `/api/sources/order` | DELETE | `SourcesRoutes.kt:284` | — | `OrderResult` | 写门+全局插件 | `repo.clearOrder` |
| 16 | `/api/sources/order` | PUT | `SourcesRoutes.kt:274` | `SourceOrderRequest` | `OrderResult` | 写门+全局插件 | `repo.reorder` |
| 17 | `/api/sources/{id}` | DELETE | `SourcesRoutes.kt:300` | — | 宣称：成功 204 空体 | 写门+全局插件 | `repo.delete` |
| 18 | `/api/sources/{id}` | GET | `SourcesRoutes.kt:289` | — | 宣称：信封 {id,json,version,updatedAt}：json 是整份书源的 J | 读方法直接放行 | `repo.get` |
| 19 | `/api/sources/{id}` | PUT | `SourcesRoutes.kt:293` | `SourceWriteRequest` | 宣称：入库后那一份的信封 {id,json,version,updatedAt} | 写门+全局插件 | `repo.save` |
### 1.3 书源·全局登录凭据（4 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 20 | `/api/cookies` | DELETE | `SourcesRoutes.kt:161` | — | 宣称：{ok,removed} | 写门+全局插件 | `database.removeCookieBucket` |
| 21 | `/api/cookies` | GET | `SourcesRoutes.kt:143` | — | `GlobalCookieListResponse` | 读方法直接放行 | `database.cookieBucketMentions`, `database.listCookieBucketStates` |
| 22 | `/api/cookies` | POST | `SourcesRoutes.kt:196` | `GlobalCookieWriteRequest` | `GlobalCookieWriteResponse` | 写门+全局插件 | `database.cookieBucket`, `database.getCookieForUrl`, `database.parseCookieString`, `database.setCookieForUrl` |
| 23 | `/api/cookies/detail` | GET | `SourcesRoutes.kt:173` | — | 宣称：{domain,cookie,sessionKeys[],droppedKeys[]} | 读方法直接放行 | `database.cookieBucketState`, `database.getCookieForUrl` |
### 1.4 书源·单源调试与登录（15 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 24 | `/api/sources/{id}/credential` | GET | `SourcesRoutes.kt:490` | — | `SourceCredentialStatus` | 读方法直接放行 | `database.cookieBucket`, `database.getCookieForUrl` |
| 25 | `/api/sources/{id}/debug` | GET | `SourcesRoutes.kt:312` | — | 宣称：text/event-stream：event: start / step / done | 读方法直接放行 | `debugger.flow`, `repo.get` |
| 26 | `/api/sources/{id}/explore` | GET | `SourcesRoutes.kt:336` | — | 宣称：[{title,url,supportsPaging}] | 读方法直接放行 | `repo.get`, `runner.exploreTabs` |
| 27 | `/api/sources/{id}/login-action` | POST | `SourcesRoutes.kt:469` | `SourceLoginActionRequest` | 宣称：{success,toastMessages[],openUrl,copyText,up | 写门+全局插件 | `repo.get`, `runner.executeLoginAction` |
| 28 | `/api/sources/{id}/login-check` | GET | `SourcesRoutes.kt:483` | — | 宣称：{loggedIn,message,hasCredential,verified} | 读方法直接放行 | `repo.get`, `runner.checkLoginStatus` |
| 29 | `/api/sources/{id}/login-cookie` | OPTIONS | `SourcesRoutes.kt:419` | — | 【未确认】 | 读方法直接放行 | — |
| 30 | `/api/sources/{id}/login-cookie` | POST | `SourcesRoutes.kt:425` | `SourceLoginCookieUpdateRequest` | `SourceLoginCookieResponse` | 写门+全局插件 | `database.getSourceLoginState`, `database.listSources`, `database.parseCookieString`, `database.saveSourceLoginHeader`, `database.setCookieForUrl`, `repo.get` |
| 31 | `/api/sources/{id}/login-header` | DELETE | `SourcesRoutes.kt:463` | — | 宣称：{ok:true} | 写门+全局插件 | `database.removeSourceLoginHeader` |
| 32 | `/api/sources/{id}/login-header` | POST | `SourcesRoutes.kt:412` | `SourceLoginHeaderUpdateRequest` | 宣称：{ok:true} | 写门+全局插件 | `database.saveSourceLoginHeader` |
| 33 | `/api/sources/{id}/login-info` | DELETE | `SourcesRoutes.kt:406` | — | 宣称：{ok:true} | 写门+全局插件 | `database.removeSourceLoginInfo` |
| 34 | `/api/sources/{id}/login-info` | POST | `SourcesRoutes.kt:399` | `SourceLoginInfoUpdateRequest` | 宣称：{ok:true} | 写门+全局插件 | `database.saveSourceLoginInfo` |
| 35 | `/api/sources/{id}/login-ui` | GET | `SourcesRoutes.kt:342` | — | 宣称：{sourceId,sourceName,hasLogin,loginUi,loginU | 读方法直接放行 | `database.getSourceLoginState`, `repo.get`, `runner.loginCanOpenBrowser`, `runner.loginIsScript`, `runner.loginUiVersion`, `runner.parseLoginUi`, `runner.renderLoginUiV2` |
| 36 | `/api/sources/{id}/login-ui/action` | POST | `SourcesRoutes.kt:378` | `SourceLoginUiActionRequest` | 宣称：{ok,state,error,close,unknownKeys,malformed, | 写门+全局插件 | `repo.get`, `runner.executeLoginUiActionV2` |
| 37 | `/api/sources/{id}/login-ui/render` | POST | `SourcesRoutes.kt:370` | `SourceLoginUiRenderRequest` | `runner.renderLoginUiV2` | 写门+全局插件 | `repo.get`, `runner.renderLoginUiV2` |
| 38 | `/api/sources/{id}/validate` | POST | `SourcesRoutes.kt:304` | `SourceValidateRequest` | 宣称：{valid,errors[],warnings[]} | 写门+全局插件 | `repo.validate` |
### 1.5 书源·内置浏览器/真浏览器/子资源代理（17 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 39 | `/api/sources/{id}/browser/cookies` | DELETE | `SourcesRoutes.kt:549` | — | `SourceCookieRemoveResponse` | 写门+全局插件 | `database.removeCookieBucket`, `repo.get`, `webView.jarSnapshot` |
| 40 | `/api/sources/{id}/browser/cookies` | GET | `SourcesRoutes.kt:541` | — | `SourceBrowserCookieResponse` | 读方法直接放行 | `repo.get`, `webView.jarSnapshot` |
| 41 | `/api/sources/{id}/browser/external-login` | DELETE | `SourcesRoutes.kt:617` | — | 宣称：成功是 204，没有响应体 | 写门+全局插件 | `externalLogin.stop` |
| 42 | `/api/sources/{id}/browser/external-login` | GET | `SourcesRoutes.kt:597` | — | `externalLoginStatus` | 读方法直接放行 | `externalLogin.peekDomains` |
| 43 | `/api/sources/{id}/browser/external-login` | POST | `SourcesRoutes.kt:570` | `StrictText` | `externalLoginStatus` | 写门+全局插件 | `externalLogin.start`, `repo.get` |
| 44 | `/api/sources/{id}/browser/external-login/capture` | POST | `SourcesRoutes.kt:603` | — | `externalLoginStatus` | 写门+全局插件 | `externalLogin.capture`, `repo.get`, `webView.jarSnapshot` |
| 45 | `/api/sources/{id}/browser/inline` | POST | `SourcesRoutes.kt:643` | `SourceBrowserInlineRequest` | `SourceBrowserInlineResponse` | 写门+全局插件 | `webView.registerInlinePage` |
| 46 | `/api/sources/{id}/browser/page` | GET | `SourcesRoutes.kt:623` | — | 宣称：目标站的响应原文（HTML/JSON/图片都可能，不是 legadoQ 的 JSON 信 | 读方法直接放行 | `webView.openInlinePage`, `webView.openPage` |
| 47 | `/api/sources/{id}/browser/res` | DELETE | `SourcesRoutes.kt:663` | — | 宣称：透传目标站的响应原文 | **仅全局插件，处理器未调写门** | — |
| 48 | `/api/sources/{id}/browser/res` | GET | `SourcesRoutes.kt:663` | — | 宣称：上游响应原文（GET/POST/PUT/PATCH/DELETE 五个方法都注册在同一条 | 读方法直接放行 | — |
| 49 | `/api/sources/{id}/browser/res` | PATCH | `SourcesRoutes.kt:663` | — | 宣称：透传目标站的响应原文 | **仅全局插件，处理器未调写门** | — |
| 50 | `/api/sources/{id}/browser/res` | POST | `SourcesRoutes.kt:663` | — | 宣称：透传目标站的响应原文（图片 / CSS / JSON 都可能），不是 legadoQ 的 | **仅全局插件，处理器未调写门** | — |
| 51 | `/api/sources/{id}/browser/res` | PUT | `SourcesRoutes.kt:663` | — | 宣称：透传目标站的响应原文 | **仅全局插件，处理器未调写门** | — |
| 52 | `/api/sources/{id}/browser/session` | DELETE | `SourcesRoutes.kt:536` | — | 宣称：成功是 204，没有响应体 | 写门+全局插件 | `webView.revokeTicket` |
| 53 | `/api/sources/{id}/browser/session` | POST | `SourcesRoutes.kt:500` | `SourceBrowserSessionRequest` | 宣称：{token,startUrl,expiresInSeconds,inlineOnly} | 写门+全局插件 | `repo.get`, `runner.loginBrowserStartUrl`, `webView.isInlineDataUrl`, `webView.issueTicket` |
| 54 | `/api/sources/{id}/browser/submit` | GET | `SourcesRoutes.kt:680` | — | 宣称：目标站响应原文，Set-Cookie 会被这一会话吸收 | 读方法直接放行 | `webView.submitForm` |
| 55 | `/api/sources/{id}/browser/submit` | POST | `SourcesRoutes.kt:694` | — | 宣称：目标站响应原文，Set-Cookie 会被这一会话吸收 | **仅全局插件，处理器未调写门** | `webView.submitForm` |
### 1.6 搜索与发现（4 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 56 | `/api/explore` | POST | `SearchRoutes.kt:152` | `ExploreRequest` | 宣称：SearchResult 数组，项见 POST /api/search | 写门+全局插件 | `database.getSource`, `runner.explore` |
| 57 | `/api/explore/sources` | GET | `SearchRoutes.kt:149` | — | `database.listExploreSources` | 读方法直接放行 | `database.listExploreSources` |
| 58 | `/api/search` | POST | `SearchRoutes.kt:53` | `SearchRequest` | `outcome.values.flatten` | 写门+全局插件 | `database.healthSearchOrder`, `database.listSearchSourceRecords` |
| 59 | `/api/search/stream` | WEBSOCKET | `SearchRoutes.kt:89` | — | 宣称：WebSocket 帧：逐源的结果与计数 | 读方法直接放行 | `database.listSearchSourceRecords` |
### 1.7 书源订阅（5 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 60 | `/api/subscriptions` | GET | `SubscriptionsRoutes.kt:30` | — | `database.listSubscriptions` | 读方法直接放行 | `database.listSubscriptions` |
| 61 | `/api/subscriptions` | POST | `SubscriptionsRoutes.kt:33` | `SubscriptionWriteRequest` | `database.saveSubscription` | 写门+全局插件 | `database.saveSubscription` |
| 62 | `/api/subscriptions/update` | POST | `SubscriptionsRoutes.kt:61` | — | 宣称：{updated,failed} | 写门+全局插件 | `subscriptions.updateAll` |
| 63 | `/api/subscriptions/{id}` | DELETE | `SubscriptionsRoutes.kt:49` | — | 宣称：成功 204 空体 | 写门+全局插件 | `database.deleteSubscription` |
| 64 | `/api/subscriptions/{id}/update` | POST | `SubscriptionsRoutes.kt:54` | — | `subscriptions.updateOne` | 写门+全局插件 | `subscriptions.updateOne` |
### 1.8 备份（6 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 65 | `/api/backup/export` | GET | `BackupRoutes.kt:83` | — | 宣称：application/zip，Content-Disposition 为 attach | 读方法直接放行 | — |
| 66 | `/api/backup/import` | POST | `BackupRoutes.kt:113` | — | 宣称：{sources,sourcesUpdated,rules,rulesUpdated,b | 写门+全局插件 | — |
| 67 | `/api/backup/kept` | GET | `BackupRoutes.kt:47` | — | `backupKeep.list` | 读方法直接放行 | `backupKeep.list` |
| 68 | `/api/backup/kept/{name}` | GET | `BackupRoutes.kt:66` | — | 宣称：那一条的 JSON 原文 | 读方法直接放行 | `backupKeep.read` |
| 69 | `/api/backup/snapshots` | GET | `BackupRoutes.kt:52` | — | `DbSnapshot.list` | 读方法直接放行 | `database.dbPath` |
| 70 | `/api/backup/snapshots/restore` | POST | `BackupRoutes.kt:56` | `SnapshotRestoreRequest` | `SnapshotRestoreScheduled` | 写门+全局插件 | `database.dbPath` |
### 1.9 RSS（7 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 71 | `/api/rss/articles` | POST | `RssRoutes.kt:76` | `RssArticlesRequest` | 宣称：[{origin,title,link,pubDate,description,imag | 写门+全局插件 | `database.getRssSource`, `database.rssSourceIsEnabled`, `runner.rssArticles` |
| 72 | `/api/rss/content` | POST | `RssRoutes.kt:92` | `RssContentRequest` | 宣称：{title,content,mediaUrl}，与书籍正文同一形状（所以阅读器与 RS | 写门+全局插件 | `database.getRssSource`, `runner.rssContent` |
| 73 | `/api/rss/sources` | DELETE | `RssRoutes.kt:58` | — | 宣称：成功 204 空体 | 写门+全局插件 | `database.deleteRssSource` |
| 74 | `/api/rss/sources` | GET | `RssRoutes.kt:41` | — | `database.listRssSources` | 读方法直接放行 | `database.listRssSources` |
| 75 | `/api/rss/sources` | POST | `RssRoutes.kt:46` | `ImportRequest` | 宣称：{imported,updated,skipped,errors} | 写门+全局插件 | `database.importRssSources` |
| 76 | `/api/rss/sources/enabled` | POST | `RssRoutes.kt:52` | `RssSourceEnabledRequest` | 宣称：成功 204 空体 | 写门+全局插件 | `database.setRssSourceEnabled` |
| 77 | `/api/rss/tabs` | GET | `RssRoutes.kt:65` | — | 宣称：[{title,url,supportsPaging}] | 读方法直接放行 | `database.getRssSource`, `database.rssSourceIsEnabled`, `runner.rssTabs` |
### 1.10 阅读（详情/目录/正文）（7 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 78 | `/api/books/chapters` | POST | `ReadingRoutes.kt:89` | `BookRequest` | 宣称：[{index,title,url,isVolume}] | 写门+全局插件 | `database.getCachedChaptersFallback`, `database.getSource`, `database.getTocCache`, `database.saveTocCache`, `runner.chapters`, `runner.details` |
| 79 | `/api/books/content` | POST | `ReadingRoutes.kt:140` | `ContentRequest` | 宣称：{title,content,mediaUrl}：mediaUrl 非空说明这一章其实是 | 写门+全局插件 | `database.cacheBookContent`, `database.cachedContent`, `database.getContentProcess`, `database.getEnabledReplaceRulesForScope`, `database.getSource`, `database.listBookshelf`, `runner.content` |
| 80 | `/api/books/content-process` | DELETE | `ReadingRoutes.kt:246` | — | 宣称：成功 204 空体 | 写门+全局插件 | `database.deleteContentProcess` |
| 81 | `/api/books/content-process` | POST | `ReadingRoutes.kt:232` | `ContentProcessRequest` | `database.saveContentProcess` | 写门+全局插件 | `database.saveContentProcess` |
| 82 | `/api/books/content-refresh` | POST | `ReadingRoutes.kt:199` | `ContentRefreshRequest` | 宣称：{refreshed[],failed[{chapterUrl,message}],re | 写门+全局插件 | `database.cacheBookContent`, `database.getSource`, `database.listBookshelf`, `runner.content` |
| 83 | `/api/books/details` | POST | `ReadingRoutes.kt:57` | `BookRequest` | `BookDetails` | 写门+全局插件 | `database.getSource`, `database.listBookshelf`, `runner.details` |
| 84 | `/api/books/reviews` | POST | `ReadingRoutes.kt:79` | `ReviewsRequest` | 宣称：[{id,avatar,name,badge,content:{text,img,aud | 写门+全局插件 | `database.getSource`, `runner.reviews` |
### 1.11 净化规则（10 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 85 | `/api/replace-rules` | GET | `ReplaceRulesRoutes.kt:49` | — | `database.listReplaceRules` | 读方法直接放行 | `database.listReplaceRules` |
| 86 | `/api/replace-rules` | POST | `ReplaceRulesRoutes.kt:59` | `ReplaceRule` | `database.saveReplaceRule` | 写门+全局插件 | `database.saveReplaceRule` |
| 87 | `/api/replace-rules/delete-batch` | POST | `ReplaceRulesRoutes.kt:84` | — | 宣称：{deleted}：真删掉了几条 | 写门+全局插件 | `database.deleteReplaceRules` |
| 88 | `/api/replace-rules/export` | GET | `ReplaceRulesRoutes.kt:96` | — | 宣称：字符串数组，每元素是一条规则的 JSON 字符串（可直接喂 /api/replace-r | 读方法直接放行 | `database.exportReplaceRules` |
| 89 | `/api/replace-rules/import` | POST | `ReplaceRulesRoutes.kt:103` | `StrictText` | 宣称：{imported,updated,skipped,errors} | 写门+全局插件 | `database.importReplaceRules` |
| 90 | `/api/replace-rules/preview` | POST | `ReplaceRulesRoutes.kt:111` | `ReplaceRulePreviewRequest` | `ReplaceRulePreviewResponse` | 仅全局插件（白名单） | `database.getEnabledReplaceRulesForScope` |
| 91 | `/api/replace-rules/toggle` | POST | `ReplaceRulesRoutes.kt:90` | `ReplaceRuleToggleRequest` | 宣称：{updated}：改了几条 | 写门+全局插件 | `database.toggleReplaceRules` |
| 92 | `/api/replace-rules/{id}` | DELETE | `ReplaceRulesRoutes.kt:78` | — | 宣称：成功 204 空体 | 写门+全局插件 | `database.deleteReplaceRule` |
| 93 | `/api/replace-rules/{id}` | GET | `ReplaceRulesRoutes.kt:55` | — | 宣称：上面那一项 | 读方法直接放行 | `database.getReplaceRule` |
| 94 | `/api/replace-rules/{id}` | PUT | `ReplaceRulesRoutes.kt:68` | `ReplaceRule` | `database.saveReplaceRule` | 写门+全局插件 | `database.saveReplaceRule` |
### 1.12 书架（17 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 95 | `/api/bookshelf` | DELETE | `ShelfRoutes.kt:154` | — | 宣称：成功 204 空体 | 写门+全局插件 | — |
| 96 | `/api/bookshelf` | GET | `ShelfRoutes.kt:55` | — | `database.listBookshelf` | 读方法直接放行 | `database.listBookshelf` |
| 97 | `/api/bookshelf` | POST | `ShelfRoutes.kt:58` | `BookshelfWriteRequest` | 宣称：书架上那一条（同 GET /api/bookshelf 的元素） | 写门+全局插件 | `database.updateBookshelfCover` |
| 98 | `/api/bookshelf/batch-delete` | POST | `ShelfRoutes.kt:253` | `BatchDeleteRequest` | 宣称：{deleted,total} | 写门+全局插件 | — |
| 99 | `/api/bookshelf/batch-mark-read` | POST | `ShelfRoutes.kt:281` | `BatchMarkReadRequest` | 宣称：{marked,total} | 写门+全局插件 | — |
| 100 | `/api/bookshelf/batch-move-group` | POST | `ShelfRoutes.kt:265` | `BatchMoveGroupRequest` | 宣称：{moved,total} | 写门+全局插件 | — |
| 101 | `/api/bookshelf/cache` | DELETE | `ShelfRoutes.kt:196` | — | 宣称：成功是 204，没有响应体 | 写门+全局插件 | — |
| 102 | `/api/bookshelf/cache` | POST | `ShelfRoutes.kt:168` | `BookCacheRangeRequest` | 宣称：202 {status:\"queued\"} | 写门+全局插件 | — |
| 103 | `/api/bookshelf/cached-chapters` | GET | `ShelfRoutes.kt:175` | — | 宣称：{sourceId,bookUrl,cachedChapterUrls[],cached | 读方法直接放行 | — |
| 104 | `/api/bookshelf/group` | PUT | `ShelfRoutes.kt:147` | `BookGroupAssignRequest` | 宣称：更新后的那一条书架项 | 写门+全局插件 | `database.assignBookGroup` |
| 105 | `/api/bookshelf/groups` | GET | `ShelfRoutes.kt:128` | — | `database.listBookGroups` | 读方法直接放行 | `database.listBookGroups` |
| 106 | `/api/bookshelf/groups` | POST | `ShelfRoutes.kt:131` | `BookGroupCreateRequest` | `database.createBookGroup` | 写门+全局插件 | `database.createBookGroup` |
| 107 | `/api/bookshelf/groups/{id}` | DELETE | `ShelfRoutes.kt:140` | — | 宣称：成功 204 空体 | 写门+全局插件 | `database.deleteBookGroup` |
| 108 | `/api/bookshelf/import-local` | POST | `ShelfRoutes.kt:90` | — | `repository.importLocalBooks` | 写门+全局插件 | — |
| 109 | `/api/bookshelf/info` | PUT | `ShelfRoutes.kt:220` | `BookshelfInfoUpdateRequest` | 宣称：更新后的那一条书架项 | 写门+全局插件 | — |
| 110 | `/api/bookshelf/status` | PUT | `ShelfRoutes.kt:209` | `BookshelfStatusRequest` | 宣称：更新后的那一条书架项 | 写门+全局插件 | — |
| 111 | `/api/bookshelf/switch-source` | POST | `ShelfRoutes.kt:230` | `BookshelfSourceSwitchRequest` | 宣称：切换后的那一条书架项 | 写门+全局插件 | — |
### 1.13 分章规则（7 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 112 | `/api/books/reparse-local` | POST | `TocRulesRoutes.kt:160` | `LocalBookReparseRequest` | 宣称：{success,name,totalChapters,tocRuleUsed,rule | 写门+全局插件 | `database.clampShelfProgress`, `database.importLocalBook`, `database.shelfBook` |
| 113 | `/api/books/toc-rules` | GET | `TocRulesRoutes.kt:46` | — | `TocRuleList` | 读方法直接放行 | — |
| 114 | `/api/books/toc-rules/apply-backup` | POST | `TocRulesRoutes.kt:137` | — | `TocRuleApplyResult` | 写门+全局插件 | `backupKeep.read` |
| 115 | `/api/books/toc-rules/delete` | POST | `TocRulesRoutes.kt:110` | `TocRuleToggleRequest` | `TocRuleDeleteResult` | 写门+全局插件 | — |
| 116 | `/api/books/toc-rules/reset` | POST | `TocRulesRoutes.kt:129` | — | `TocRuleResetResult` | 写门+全局插件 | — |
| 117 | `/api/books/toc-rules/save` | POST | `TocRulesRoutes.kt:86` | `TocRuleSaveRequest` | `TocRuleSaveResult` | 写门+全局插件 | — |
| 118 | `/api/books/toc-rules/toggle` | POST | `TocRulesRoutes.kt:71` | `TocRuleToggleRequest` | `TocRuleToggleResult` | 写门+全局插件 | — |
### 1.14 界面偏好（3 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 119 | `/api/ui-prefs` | GET | `PrefsRoutes.kt:30` | — | 宣称：{prefs:{<key>:<任意 JSON>}} | 读方法直接放行 | — |
| 120 | `/api/ui-prefs/{key}` | DELETE | `PrefsRoutes.kt:70` | — | 宣称：204 | 写门+全局插件 | — |
| 121 | `/api/ui-prefs/{key}` | PUT | `PrefsRoutes.kt:36` | — | 宣称：204 无正文 | 写门+全局插件 | — |
### 1.15 图片与媒体（7 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 122 | `/api/book/image` | GET | `MediaRoutes.kt:125` | — | 宣称：图片本体 | 读方法直接放行 | `coverCache.cacheContentImage`, `coverCache.file`, `database.getSource` |
| 123 | `/api/book/image/refresh` | POST | `MediaRoutes.kt:168` | — | `RefreshedImage` | 写门+全局插件 | `coverCache.refetchContentImage`, `database.getSource` |
| 124 | `/api/book/media` | GET | `MediaRoutes.kt:201` | — | 宣称：字节流（支持 206 Partial Content，不落盘缓存，因为媒体可能很大） | 读方法直接放行 | — |
| 125 | `/api/book/media` | HEAD | `MediaRoutes.kt:202` | — | 【未确认】 | 读方法直接放行 | — |
| 126 | `/api/books/local/asset` | GET | `MediaRoutes.kt:99` | — | 宣称：资源本体 | 读方法直接放行 | — |
| 127 | `/api/covers/proxy` | GET | `MediaRoutes.kt:64` | — | 宣称：图片本体（带 7 天 private 缓存头） | 读方法直接放行 | `coverCache.cacheContentImage`, `coverCache.file` |
| 128 | `/api/covers/{key}` | GET | `MediaRoutes.kt:43` | — | 宣称：图片本体 | 读方法直接放行 | `coverCache.file`, `database.coverContentType` |
### 1.16 进度/笔记/本书检索（9 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 129 | `/api/book-search` | GET | `ReadersRoutes.kt:64` | — | `repo.searchBookContent` | 读方法直接放行 | — |
| 130 | `/api/notes` | GET | `ReadersRoutes.kt:57` | — | `repo.listNotes` | 读方法直接放行 | — |
| 131 | `/api/notes` | POST | `ReadersRoutes.kt:71` | `BookNoteWrite` | `repo.addNote` | 写门+全局插件 | — |
| 132 | `/api/notes/{id}` | DELETE | `ReadersRoutes.kt:86` | — | 宣称：成功 204 空体 | 写门+全局插件 | — |
| 133 | `/api/notes/{id}` | PUT | `ReadersRoutes.kt:80` | `BookNoteUpdate` | 宣称：成功 204 空体 | 写门+全局插件 | — |
| 134 | `/api/reading-log` | GET | `ReadersRoutes.kt:43` | — | `repo.listReadingLog` | 读方法直接放行 | — |
| 135 | `/api/reading-log` | POST | `ReadersRoutes.kt:47` | `ReadingLogRequest` | `repo.addReadingLog` | 写门+全局插件 | — |
| 136 | `/api/reading-progress` | GET | `ReadersRoutes.kt:30` | — | 宣称：{sourceId,bookUrl,chapterUrl,chapterIndex,sc | 读方法直接放行 | — |
| 137 | `/api/reading-progress` | PUT | `ReadersRoutes.kt:36` | `ReadingProgress` | `repo.saveProgress` | 写门+全局插件 | — |
### 1.17 朗读（9 条）

| # | 路径 | 方法 | 路由文件:行 | 请求体 DTO | 响应 | 鉴权 | Repository / DAO |
|---|---|---|---|---|---|---|---|
| 138 | `/api/tts/session` | POST | `TtsRoutes.kt:31` | — | `ttsSessions.create` | 写门+全局插件 | `ttsSessions.create` |
| 139 | `/api/tts/session/{id}` | DELETE | `TtsRoutes.kt:72` | — | 宣称：204 空体 | 写门+全局插件 | `ttsSessions.get`, `ttsSessions.remove` |
| 140 | `/api/tts/session/{id}/audio` | GET | `TtsRoutes.kt:82` | — | 宣称：音频字节流（带 Range 语义） | 读方法直接放行 | `ttsSessions.get` |
| 141 | `/api/tts/session/{id}/chunks` | POST | `TtsRoutes.kt:35` | `TtsSessionChunkRequest` | `TtsSessionAck` | 写门+全局插件 | `ttsSessions.get` |
| 142 | `/api/tts/session/{id}/control` | POST | `TtsRoutes.kt:53` | `TtsSessionControlRequest` | `TtsSessionAck` | 写门+全局插件 | `ttsSessions.get`, `ttsSessions.remove` |
| 143 | `/api/tts/session/{id}/events` | GET | `TtsRoutes.kt:96` | — | 宣称：SSE，data 是 {type,sessionId,chunkId,chapterIn | 读方法直接放行 | `ttsSessions.get` |
| 144 | `/api/tts/speak` | GET | `TtsRoutes.kt:146` | — | 宣称：音频字节流 | 读方法直接放行 | `edgeTts.synthesize` |
| 145 | `/api/tts/speak` | POST | `TtsRoutes.kt:110` | `TtsSpeakRequest` | 宣称：音频字节流 | 写门+全局插件 | `edgeTts.synthesize`, `edgeTts.synthesizeCustom` |
| 146 | `/api/tts/voices` | GET | `TtsRoutes.kt:28` | — | `edgeTts.listVoices` | 读方法直接放行 | `edgeTts.listVoices` |

## 2. 端点统计与「宣称 vs 实际」

### 2.1 数字总表

| 口径 | 条数 | 依据 |
|---|---|---|
| **代码实际注册（`/api/*`）** | **146** | 本文 §1 全表，脚本可复现；按方法分：POST 61 / GET 50 / DELETE 20 / PUT 11 / PATCH 1 / HEAD 1 / OPTIONS 1 / WS 1 ＝ 146 |
| `agent-api.json` 自带 `count` | **144** | `resources/agent-api.json`：`"count": 144`；`endpoints[]` 数组同为 144 条 |
| `web/test/ApiCatalog.test.ts` 解析出的「代码侧条数」 | **144** | 该测试 `assert.equal(catalog.endpoints.length, routes.length)` 现在能通过，说明它的解析器也只数出 144 |
| `/healthz`（不在 `/api` 之下） | 1 | `Application.kt:275` |
| 文件数 | 14 个路由文件（含 `system/SystemRoutes.kt`）+ `Routes.kt`（装配点）+ `RouteCatalog.kt` + `Guard.kt` + `SearchSession.kt` + 2 个严格解码工具 | — |

### 2.2 双向差异（实测，非引用文档）

**【事实】** 以 `METHOD /path` 规范化后做 `comm -23 / -13`：

- **「目录里有、代码里没有」＝ 0 条。** 目录已经不含任何 `/api/agent/*`（`grep '"path": "/api/agent' agent-api.json` 命中 0），2026-11-17 的 AI 下线在目录侧是干净的。
- **「代码里有、目录里没有」＝ 2 条：**

| 缺失端点 | 位置 | 为什么漏 |
|---|---|---|
| `HEAD /api/book/media` | `MediaRoutes.kt:202` | 目录的机器核对器 `web/test/ApiCatalog.test.ts:91` 的方法正则是 `(get\|post\|put\|delete\|patch)`，**不含 `head(` 与 `options(`**，所以这两条永远不会被判据看见 |
| `OPTIONS /api/sources/{id}/login-cookie` | `SourcesRoutes.kt:419` | 同上（`options(` 不在正则里）。这条是给书签/扩展做 CORS 预检用的，语义上确实应该公开登记 |

**【推断】** 这两条漏登记不会让「目录 vs 代码」门禁变红：`routes.length` 与 `catalog.endpoints.length` 都是 144，`assert.equal` 通过。也就是说**门禁的 100% 覆盖承诺有 2 条盲区**，而 `RouteCatalog.serve()` 还会把 `count` 用 `endpoints.size` 现数覆盖（`RouteCatalog.kt:45`），所以外部程序从 `/api/catalog` 拿到的 `count` 也同样是 144，差异只存在于源码。

### 2.3 「宣称有 vs 实际注册」的其余差异

除了上面 2 条方法盲区，还有三类**文档/注释宣称与实际不符**，都在源码里可证：

**【事实】**

1. `product/web/src/features/reader/notes/NotesPanel.tsx:18`：「（`/api/catalog` 仍是 **155 条**）」——实际 144。
2. `product/app/src/test/kotlin/io/legado/RouteMountTest.kt:18`：「`agent-api.json`（**161 条**目录）」——实际 144。
3. `web/test/ApiCatalog.test.ts` 的变更流水注释里同时留着 `19 组`（现行断言已是 18）、`157 → 155`、`166 → 144` 等多代数字；`assert.equal(systemGroup.length, 11)` 是对的，但注释里「系统组 8 → 11」与更早的「143 条 / 19 组」并存，读的人无法判断哪个是现值。
4. `AGENTS.md` 的「端点 144 条 / 18 组」与代码的 146 条不一致（这次审计的新发现）。
5. `Guard.kt` 的注释自称「仍手调的 **88** 处」「**89** 处」，同一段注释里出现两个数字（`Guard.kt:70` 与 `Guard.kt:103`）。实测 `grep -c 'requireSameOriginWrite()'` 全 `http/` 共 **91** 处，去掉 `Guard.kt` 自身 3 处（定义+2 处文档引用）为 **88** 处调用点。

## 3. 分层违规清单

### 3.1 先说没问题的部分

**【事实】** `grep -rn -iE 'select |insert into|update .* set |delete from|createStatement|prepareStatement|connection\.' product/app/src/main/kotlin/io/legado/http/` **零命中**。路由层没有一处手拼 SQL，这一点比多数同规模项目干净。

### 3.2 违规清单（按严重度）

| # | 位置 | 违规类型 | 证据 |
|---|---|---|---|
| L1 | `ReadingRoutes.kt:140-197`（`POST /api/books/content`） | **路由里做业务编排**：查缓存 → 查书架取书名 → 读 AI 覆盖层（`ai_clean` 优先于 `ai_rewrite`）→ 本地书分支现场 `new JsSandbox(runner)` 并跑 `ContentProcessor.processContent` → 在线书分支回源 + 写缓存 → 失败时按 `force` 决定回旧正文还是抛 | 单个处理器 58 行，触达 `database.cachedContent` / `database.listBookshelf` / `database.getContentProcess` / `database.getEnabledReplaceRulesForScope` / `database.cacheBookContent` 5 个 DAO 方法 + `runner.content` + `JsSandbox` |
| L2 | `ReadingRoutes.kt:57-78`、`89-139` | 路由直连 DAO 做「能读缓存就先读」的决策与回写（`getCachedChaptersFallback` / `getTocCache` / `saveTocCache`） | 见 §1 表内该两条的 DAO 列 |
| L3 | `SourcesRoutes.kt:565-568`（`route("/external-login")` 内的局部函数 `targetHosts`） | 绕过 Repository 直连 DAO，且源码自己承认：「局部函数拿不到 `call` 的接收者，所以这一处仍直连 DAO」 | 注释 + `database.getSource(id)` |
| L4 | `SourcesRoutes.kt:425-461`（`POST /sources/{id}/login-cookie`） | 路由里做凭据业务：解析 Cookie 串 → 写桶 → **再**判 `loginHeader` 是否为空 → 拼 `{"Cookie": …}` → 写 loginHeader | 4 个 DAO 方法 + JSON 拼装全在处理器内 |
| L5 | `SourcesRoutes.kt:428-430` | 路由里做**模糊匹配业务规则**：`id.contains(sourceId) || sourceId.contains(it.id) || sourceId.contains(it.url) || it.url.contains(sourceId)`，用子串匹配兜「书源 id 认不全」的输入 | 这是把输入校验写成了猜测逻辑，且是全库 `firstOrNull` 扫一遍 |
| L6 | `TocRulesRoutes.kt:160-190`（`POST /books/reparse-local`） | 路由直接调 `database.importLocalBook` + `database.clampShelfProgress` + `database.shelfBook` 三连，等于把「重切目录 → 修进度 → 回书架」这条业务链放在处理器里 | 见 §1 表 |
| L7 | `SearchRoutes.kt:53-148` | 搜索编排（并发、健康度排序、死线、逐源结果归并）写在路由文件里；`DeadlineCollection`（`SearchRoutes.kt:271`）与 `SearchSourceOutcome`（`192`）也定义在路由文件内 | 同类逻辑还有一份在 `SearchSession.kt`（WS 用），**两份实现同一语义** |
| L8 | `MediaRoutes.kt:125-200`（`GET/POST /book/image…`） | 路由里做「先查缓存文件 → 没有再回源抓 → 落缓存」的缓存策略，并直接 `database.getSource` 拿书源配置 | `coverCache.file` / `coverCache.cacheContentImage` / `database.getSource` |
| L9 | `system/SystemRoutes.kt:62-79`（`PUT /server/port`） | 路由做文件 IO：把端口写进安装根的 `port.txt` | 见 §1 表 |
| L10 | `PrefsRoutes.kt:30-35` | 路由**绕过 ContentNegotiation 手工回 JSON**：`call.respondText(prefs.snapshotJson(), ContentType.Application.Json)`，注释解释原因（怕 `JsonElement` 序列化形状漂），但结果是这一条的响应契约不受统一编码器约束 | 与 `Application.kt:221-230` 的 `StrictJsonConverter` 分家 |
| L11 | `http/` 内有 5 个**线上 DTO 就地声明**，而它们的同类却在 `model/` | `BackupRoutes.kt:171` `SnapshotRestoreRequest`、`BackupRoutes.kt:174` `SnapshotRestoreScheduled`、`SourcesRoutes.kt:90` `GlobalCookieWriteRequest`、`102` `GlobalCookieWriteResponse`、`110` `GlobalCookieDetailResponse`；对照 `model/SystemModels.kt:235` `GlobalCookieEntry`、`251` `GlobalCookieListResponse` 在同一文件族里 | DTO 归属无规则：同一个「cookie 写请求/回包」一半在 `http/`、一半在 `model/` |

**【事实】** 直连 DAO 的密度（`database.` 出现次数）：`SourcesRoutes.kt` 24、`ReadingRoutes.kt` 21、`ReplaceRulesRoutes.kt` 10、`RssRoutes.kt` 9、`ShelfRoutes.kt` 6、`SearchRoutes.kt` 5、`MediaRoutes.kt` 4、`SubscriptionsRoutes.kt` 3、`TocRulesRoutes.kt` 3、`BackupRoutes.kt` 2，合计 87 处。

这不是「有 Repository 却不用」——`SourceRepository` 只覆盖书源 CRUD/批量/导入导出/排序（`repo.*` 共 12 个调用点）。**阅读、书架、RSS、净化规则、分章规则、凭据这六块根本没有 Repository 层**，路由与 DAO 直接对接。【推断】重建时若不先把这六块补上仓储，分层纪律无法落地。

## 4. DTO 不一致与漂移风险（含实例）

### 4.1 总量

**【事实】** 后端 DTO 分散在 7 个 `model/*.kt`（共 **161 个 `data class`**：Backup 5 / Bookshelf 27 / Discovery 10 / Reading 25 / ReplaceRule 11 / Source 40 / System 14，另有 5 个就地声明在 `http/`，见 L11），前端 `product/web/src/lib/api/types.ts`（**956 行**）**手写复刻**了 100+ 个同名类型。`types.ts:1-5` 自己写着这是临时状态：「书源字段的增删在后端契约中修改，应通过构建流程自动生成此文件…目前先手动维护」。**没有生成器，没有契约测试比对两侧字段。**

### 4.2 不一致实例（每侧都给 `file:line`）

| # | 概念 | 后端 | 前端 | 不一致性质 |
|---|---|---|---|---|
| **D1** | 书架项的分组归属 | `BookshelfItem.groupId: Long = 0`（非空，0＝未分组）— `model/ReadingModels.kt:259` | `groupId?: number`（**可选**）— `types.ts:231` | **可空性矛盾**：后端恒发 0，前端把「有字段但为 0」和「没这个字段」当成两件事；`if (item.groupId)` 在两侧语义不同 |
| **D2** | `tocRule` 的枚举取值 | 注释只列 `builtin` 或 `txtTocRule.json` 里的 id — `model/ReadingModels.kt:260-265` | `tocRule?: string \| null` 注释写 `auto`/`builtin`/规则 id — `types.ts:233-234` | **枚举值漂移**：`auto` 在后端契约里不存在（后端存的是「实际生效的那条」） |
| **D3** | 缓存状态枚举 | `cacheState: String = "idle"`（**无类型**），写库侧只有 `"caching"`/`"ready"`/`"failed"` — `model/ReadingModels.kt:254`、`data/CacheDao.kt:360,364` | `cacheState: 'idle' \| 'caching' \| 'ready' \| 'failed'`（**封闭联合**）— `types.ts:228` | **枚举靠约定不靠类型**：后端可以发出第五个值而前端的 switch 会静默落到 else |
| **D4** | 全局 Cookie 桶 | `GlobalCookieEntry`（`model/SystemModels.kt:235`）+ `GlobalCookieListResponse`（`:251`） | **两份手写**：匿名内联类型 `domains/sources.ts:92-103`；另有一份具名 `GlobalCookieEntry`/`GlobalCookieList`/`GlobalCookieDetail`/`SaveResult`/`RemoveResult` 在 `lib/cookieApi.ts:12-53` | **同一概念 3 处定义**（后端 1 + 前端 2），且两份前端类型不同名不同构（`types.ts` 里**根本没有** cookie 类型） |
| **D5** | 章节的体积标记 | `isVolume: Boolean = false`（非空 + `encodeDefaults=true` → **每次都发**）— `model/ReadingModels.kt:21` | `isVolume?: boolean`（可选）— `types.ts:132` | 可空性口径不一致（后端「总是有」被写成「可能没有」），同类还有 `BookNote.bookmark`（后端 `:117` 非空 / 前端 `types.ts:173` 可选）、`TocRuleList.enabled/total/fromBackup`（后端 `model/BookshelfModels.kt:34-41` 非空 / 前端 `types.ts:308-312` 全可选） |
| **D6** | 字段命名风格 | `FlexChildStyle` 用 **snake_case**：`layout_flexGrow` / `layout_alignSelf` / `layout_flexBasisPercent` — `model/SourceModels.kt:26-32` | 照抄 snake_case — `types.ts:440-447` | **同一 API 内两种命名风格**并存（其余 160 个 DTO 全 camelCase），且这套字段是从 Legado APK 的 JSON 直通，重建时不改就等于把上游方言固化进自己的契约 |
| **D7** | 流式搜索事件类型 | `type: String`（**无约束**），实际发出 `start` / `results` / `done`（`http/SearchSession.kt:31,39,45`）、`progress`（`SearchRoutes.kt:211,214`）、`error`（`SearchRoutes.kt:104`） | `type: 'start' \| 'results' \| 'progress' \| 'done' \| 'error'`（封闭联合）— `types.ts:100` | 前端比后端**更严格**；后端加第 6 种事件时前端无编译期提示 |
| **D8** | 错误体的 `code` 字段 | `ApiError(code: String, message: String)` — `model/SystemModels.kt:5`；代码里散落 **70 个**不同 code 字面量，无集中枚举 | 前端**完全没有 `ApiError` 类型**；`client.ts:31-34` 只读 `body.message`，`code` 一个字节都没用到 | 契约的一半（`code`）**只有生产方、没有消费方**；前端无法做「按 code 分支」 |
| **D9** | 健康检查 | `HealthStatus.ai: Boolean = true`（`model/SystemModels.kt:26`，注释说「产品默认关」却默认 `true`） | `AboutInfo.ai?: boolean`（`types.ts:37-38`） | 字段挂错了 DTO：`ai` 实际只在 `/healthz` 里存在，前端却把它声明在 `/api/about` 的类型上 |

## 5. 错误契约现状

### 5.1 好消息：核心是统一的

**【事实】** 单一错误体 `ApiError(code, message)`（`model/SystemModels.kt:5`），`Application.kt:244-272` 的 `StatusPages` 有 4 条兜底：

| 异常 | 状态码 | code |
|---|---|---|
| `BadRequestException` | 400 | `invalid_request`（并会从 `deepBadRequestMessage()` 捞出内层原因，`Application.kt:246-254`） |
| `ContentTransformationException` | 400 | `invalid_request` |
| `SerializationException` | 400 | `invalid_request` |
| `Throwable` | 500 | `internal_error`（原文只进日志） |

加一条私有分类器 `classifyRuleFailure`（`Routes.kt:126-139`）：书源规则链失败统一 **502 `source_execution_failed`**，并区分「出站地址被拒」/「书源执行失败（上游原话可外带）」/「其它（固定文案 + 日志，`leaked=true`）」。`Application.kt:221-230` 的请求解码口径也是统一的：`StrictJsonConverter`（`http/StrictJsonConverter.kt:46-59`）与 `receiveStrictText()`（`http/StrictRequestText.kt:22-31`）遇到非法字节直接 400，绝不带 U+FFFD 入库。

### 5.2 坏消息：五处不统一

**【事实】**

1. **状态码用法不统一。** 同样是「资源不存在」，出现的码有 404（绝大多数）、`source_not_found` 404（`SourcesRoutes.kt:572`）与 `not_found` 404（`SourcesRoutes.kt:302`、`ReplaceRulesRoutes.kt:57`）两套 code；同样非法输入，有 400（多数）、`PayloadTooLarge`（`PrefsRoutes.kt:49,74`、`BackupRoutes.kt:113`）、`Conflict`（`SourcesRoutes.kt:293` 版本冲突、`RssRoutes.kt:65,76`）、`ServiceUnavailable`（`SourcesRoutes.kt:590`）、`Accepted`（`ShelfRoutes.kt:168`）、`InternalServerError`（`SourcesRoutes.kt:222`、`ShelfRoutes.kt:90`）。
2. **「not found」有 7 种说法**：`not_found`(37 次) / `source_not_found` / `cookie_not_found` / `tts_session_not_found` / `book_missing` / `no_file` / `not_kept` / `no_backup_entry`。没有任何地方定义它们的区别。
3. **502 只覆盖书源规则链**（`respondCatching` 仅 9 处：`ReadingRoutes.kt` 6、`RssRoutes.kt` 2、`Routes.kt:89` 定义）。同为「回源抓取」的 `POST /api/search`、`POST /api/explore`、`GET /api/sources/{id}/debug` 各自处理异常，未走分类器；其中 `POST /api/search` 的关键词为空回 400，但**单源失败被吞进 200 的结果数组**（`SearchRoutes.kt:53-148` + `SearchSession.kt` 的计数模型）。
4. **11 处响应是裸 `mapOf(...)`**，无 DTO、无 schema：`ReplaceRulesRoutes.kt:88,94`、`ShelfRoutes.kt:261,273,289`、`SourcesRoutes.kt:169,404,410,417,467`、`SubscriptionsRoutes.kt:64`。前端的对应类型只能靠人写（`types.ts` 里 `{ deleted: number }` 之类），契约测试看不见它们。
5. **「200 里套结果」与「200 里套失败」并存**：`POST /api/bookshelf` 批量类端点回 `{deleted,total}`（200，部分成功也算成功）；`POST /api/sources/health-check` 回 200 + 每源 `error` 字段；`POST /api/subscriptions/update` 回 200 + `{updated, failed}`（`SubscriptionsRoutes.kt:61-65`）。**这些不是错误响应的漏洞（前端确实要拿到部分结果），但它们让「非 2xx 即失败」这条前端唯一的判定规则（`client.ts:31`）在语义上不够用。**

### 5.3 前端如何解析错误

**【事实】** `product/web/src/lib/api/client.ts:31-34`：

```ts
if (!response.ok) {
  const body = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
  throw new Error(body.message ?? '请求失败')
}
```

即：**只取 `message`，丢掉 `code`，丢掉状态码**；非 JSON 错误体（例如 SSE 端点或静态 404 的 HTML）退化成 `statusText`。上层拿到的都是 `Error`，无法区分「400 参数错」与「502 书源挂了」——而这正是后端 `classifyRuleFailure` 花了 40 行注释想区分的东西。【推断】这是当前契约里**最浪费的一处**：后端辛苦分了类，前端在 3 行内把它抹平。

## 6. 重复 / 死 / 缺失端点

### 6.1 功能重复（同一件事有多条路）

| # | 重复组 | 证据 | 说明 |
|---|---|---|---|
| R1 | **净化规则的建/改**：`POST /api/replace-rules` 与 `PUT /api/replace-rules/{id}` | `ReplaceRulesRoutes.kt:59-67` vs `68-77` | 两个处理器体几乎逐字相同，唯一差别是 PUT 多做 `.copy(id = id)`，而 `saveReplaceRule` 本身是 upsert。**PUT 完全冗余** |
| R2 | **朗读音频取法**：`POST /api/tts/speak`、`GET /api/tts/speak`、`POST /api/tts/session` + `POST .../chunks` + `GET .../audio` | `TtsRoutes.kt:110` / `146` / `31,35,82` | 三条完全不同的路都能拿到同一段 MP3；前端只用 `POST /speak`（`domains/reader.ts:477`），会话流那套（`createSession`/`appendChunk`）另有实现，`GET /session/{id}/audio` **零消费** |
| R3 | **Cookie 删除**：`DELETE /api/cookies`（全局）与 `DELETE /api/sources/{id}/browser/cookies`（按源） | `SourcesRoutes.kt:161` vs `549` | 两条最终都调 `database.removeCookieBucket(...)`；差别只是第二条顺手回一份 jar 快照 |
| R4 | **Cookie 写入**：`POST /api/cookies`（全局粘贴）与 `POST /api/sources/{id}/login-cookie`（书签/扩展同步）与 `POST /api/sources/{id}/login-header` | `SourcesRoutes.kt:196` / `425` / `412` | 三条都能往同一本书源注入凭据，落库路径分别是 `setCookieForUrl`、`setCookieForUrl`+`saveSourceLoginHeader`、`saveSourceLoginHeader`。**同一个「登录态」概念有三套写入口、三套回包** |
| R5 | **书架分组**：`POST /api/bookshelf/groups`（建组）、`PUT /api/bookshelf/group`（单本归组）、`POST /api/bookshelf/batch-move-group`（批量归组） | `ShelfRoutes.kt:131` / `147` / `265` | 单本归组是批量归组的 N=1 特例，两条契约字段名不同（`groupId` vs `books[]`） |
| R6 | **离线缓存**：`POST /api/bookshelf/cache`（两种语义：整本排 / 区间排）、`GET /api/bookshelf/cached-chapters`、`DELETE /api/bookshelf/cache`（两种语义：取消 / 清数据，靠 `clearData=true` 区分） | `ShelfRoutes.kt:168` / `175` / `196` | 三条路径承载 5 种动作；`DELETE` 用**查询参数布尔**切换「取消」与「清库」，这是最容易被误调的形态。前端也照着这份含糊实现了两对包装：`domains/reader.ts:229`（`cache.book`）与 `:240`（`cache.range`）打的是同一个 URL 同一个方法；`:257`（`clearData`）与 `:262`（`cancel`）只差一个 query |
| R7 | **前端两份 cookies 客户端** | `lib/api/domains/sources.ts:90-118`（`cookies`）与 `lib/cookieApi.ts:55-72`（`cookieApi`） | 同一组端点两套客户端、两套类型；`index.ts:144-147` 只用前者 |
| R8 | **前端两份 `/api/ui-prefs` 前缀常量 + 未导出的域** | `lib/api/domains/prefs.ts:17`（`uiPrefs` 有实现但 **`index.ts` 未导出**，`api` 兼容对象里也没有 ui-prefs 任何键） | 见 6.3 |

### 6.2 后端有、前端产品代码零引用

**【事实】** 用「前端 117 个 `/api/…` 路径形态 × 后端 146 条模板」双向匹配，得 **11 条产品前端零引用**（另有 7 条由**注入脚本**消费，见下）：

| 端点 | 位置 | 判断 |
|---|---|---|
| `GET /api/books/local/asset` | `MediaRoutes.kt:99` | `grep 'local/asset' product/web/src` **零命中**。本地书插图这条路前端没接 |
| `POST /api/books/content-process` | `ReadingRoutes.kt:232` | AI 覆盖正文，消费方已随 AI 一起挪出产品（`product/experimental/ai/`）。后端仍注册、仍读写 `book_content_process` 表 |
| `DELETE /api/books/content-process` | `ReadingRoutes.kt:246` | 同上 |
| `GET /api/replace-rules/export` | `ReplaceRulesRoutes.kt:96` | 前端只 import 不 export（`grep 'replace-rules/export'` 零命中） |
| `GET /api/tts/session/{id}/audio` | `TtsRoutes.kt:82` | 零命中，前端走 `POST /speak` |
| `GET /api/tts/session/{id}/events` | `TtsRoutes.kt:96` | 零命中（SSE 通道没人订阅） |
| `GET/POST/PUT/PATCH/DELETE /api/sources/{id}/browser/res` ×5 | `SourcesRoutes.kt:663` | **不是死端点**：消费者是注入到 WebView 的 JS（`source/WebViewProxy.kt`），不是 `web/`。但它在目录里、在 `ApiCatalog` 判据里，却没有任何前端代码引用——重建时必须知道「这五条的调用方在服务端自己生成的脚本里」 |
| `GET/POST /api/sources/{id}/browser/submit` ×2 | `SourcesRoutes.kt:680,694` | 同上（表单提交走代理） |

### 6.3 前端有类型但后端没有的「影子端点」

**【事实】** `product/web/src/lib/api/types.ts:729-926` 仍保留 **13 个 `Agent*` 类型**（`AgentManifest` / `AgentConnection` / `AgentChatResult` / `AgentStreamEvent` / `AgentModelListResult` / `AgentSkill` / `AgentMcpServer` / `AgentPrompt` / `AgentTaskModel` 等），段首注释写着 `/* ===== 自定义 AI 接入（/api/agent/*）===== */`。这些端点**在代码里已不存在**（0 条 `/api/agent` 注册）。同时 `lib/api/index.ts:9` 的导出清单注释里还写着 `connections / models / agentSources / comprehend / chat / chatStream / skills / prompts / taskModels / mcp` 十个域——**都已被移走**。这是本次审计里体量最大的一处死契约（约 200 行类型 + 1 行文档）。

### 6.4 前端调用但后端不存在

**【事实】** **0 条**。117 个前端路径形态全部能匹配到后端模板。但有 **1 条参数名错**（调得通但会被 400）：

> `DELETE /api/cookies?url=…`（`domains/sources.ts:111-112`）vs 后端只读 `u`（`SourcesRoutes.kt:163-167`，缺 `u` 直接 `400 missing_parameter`）。
> 同一功能的另一个客户端写对了：`lib/cookieApi.ts:69` 用 `?u=`。
> **这是「同一概念两份前端客户端」直接造成的线上缺陷**：点「删除某域凭据」若走 `api.removeCookie` 一律 400。`ApiRoutesHttpTest.kt:749` 测的是后端 `?u=`，所以测不出来。

## 7. 鉴权与暴露面

### 7.1 实际机制（三层，没有身份）

**【事实】** 这套服务**没有账号、没有 token、没有会话**（`Guard.kt:15-28` 明说不设身份）。实际保护是三层：

1. **启动期绑定闸门** `requireLoopbackBind`（`Guard.kt:148-156`，调用点 `Application.kt:138`）：非回环地址（`0.0.0.0` / 局域网 IP / 域名）未设 `LEGADO_ALLOW_EXTERNAL_BIND=1` 时**直接拒绝启动**。判据是字面量（`isLoopbackBindHost`，`Guard.kt:130-134`），不走 DNS。
2. **同源写门** `SameOriginWriteGate`（`Guard.kt:72-96`，装于 `Application.kt:273`＝routing 之前）：所有**非安全方法**（非 GET/HEAD/OPTIONS）若带 `Origin` 且该 Origin 的主机+端口不等于 `ServerIdentity`（服务真实绑定身份，`Guard.kt:163-179`），回 403 `cross_origin`。三个豁免：
   - `READ_ONLY_POSTS` 白名单（`Guard.kt:39-44`）：`/api/replace-rules/preview`、`/api/agent/sources/validate`、`/api/agent/comprehend`、`/api/agent/chat`。**后三条已随 AI 下线成为死条目**——白名单里躺着三条不存在的路径，任何人读到都会以为防线还在原处。
   - `handlesOwnOriginPolicy`（`Guard.kt:57-58`）：`/api/sources/*/login-cookie` 自己判来源（`SourcesRoutes.kt:425-443`），放行「属于该书源域名」的跨站来源（书签/扩展用）。
   - **无 `Origin` 头 → 一律放行**（`Guard.kt:79-80`、`Guard.kt:108`）：curl、脚本、服务间调用、以及**任何非浏览器客户端**都不经这道门。这是设计选择，但它意味着「同源写门」挡的只是「用户在浏览器里打开的恶意页面」，不是「本机任意进程」。
3. **处理器内 `requireSameOriginWrite()` 纵深防御**（`Guard.kt:105-122`）：88 处调用点，覆盖 146 条里的 87 条（另有 1 条走自定义判据 `sameOriginCall`，见下）。它的真实作用不是「判来源」，而是**「看全局插件是否已经发了 403」**——因为 Ktor 的 `onCall` 不阻断后续 pipeline（`Guard.kt:91-94` 与 `:99-103` 两处注释都在讲这件事），处理器必须自己早退，否则写操作会照跑、最后因二次 `respond` 抛异常。

### 7.2 敞开的组（读方法，全部不设防）

**【事实】** 只要方法在 `SAFE_METHODS`（`Guard.kt:30`）里，全局插件立即放行，与处理器无关。146 条里 **53 条是读方法**（GET 50 / HEAD 1 / OPTIONS 1 / WS 1，表 1 的鉴权列全部标「读方法直接放行」），它们没有任何处理器级写门；再加上 6 条未调写门的写处理器（§7.3），**共 59 个处理器完全没有处理器级判断**。读方法里有 6 个**有出站网络副作用**的 GET，跨站页面可以用 `<img>`/`<link>` 打它们（盲 CSRF 式放大器，读取结果受 SOP 限制但副作用已发生）：

| 端点 | 位置 | 副作用 |
|---|---|---|
| `GET /api/tts/speak?text=…` | `TtsRoutes.kt:146-172` | 让本机去请求 Edge TTS 合成音频（无长度/频率限制） |
| `GET /api/book/media?url=…` | `MediaRoutes.kt:201` | 代理任意 http(s) 二进制（有 `NetworkSecurity.resolveAndValidateSafeHttpTarget` 收口，`MediaRoutes.kt:470,481`） |
| `GET /api/covers/proxy?url=…` | `MediaRoutes.kt:64` | 同上（封面代理） |
| `GET /api/sources/{id}/debug?keyword=…` | `SourcesRoutes.kt:312` | 触发整条书源规则链（SSE），对本机是最重的动作之一 |
| `GET /api/sources/{id}/browser/page|res|submit` | `SourcesRoutes.kt:623,663,680` | 带着**用户已登录的 Cookie** 去打上游站点 |
| `GET /api/backup/export` | `BackupRoutes.kt:83` | 导出整库（`HttpSurfaceNegativeTest.kt` 里有路径穿越用例，说明这条已经踩过坑） |

### 7.3 一处真正的漏洞（本次新发现）

**【事实】** `POST /api/sources/{id}/browser/submit`（`SourcesRoutes.kt:694-706`）**处理器内没有 `requireSameOriginWrite()`**。逐个判定 146 个注册点的结果是：**非安全方法（POST/PUT/PATCH/DELETE）里共 5 个处理器没有写门** —— `ReplaceRulesRoutes.kt:111`（`POST /replace-rules/preview`，在白名单里，属正常）、`SourcesRoutes.kt:694`（`POST /browser/submit`）、以及 `SourcesRoutes.kt:663` 的 `for (verb in listOf(…)) { method(verb) }` 循环里除 GET 外的 **POST / PUT / PATCH / DELETE 四条 `/browser/res`**（同一个 `handle` 块，唯一一次写门检查都没有）。后果链：

1. 跨站页面 `POST` 到该 URL 且带 `Origin: evil`；
2. 全局插件 `SameOriginWriteGate` 先 `respond(403)`（`Guard.kt:90`）；
3. 但 `onCall` 不中断 pipeline → 处理器继续执行：读 body → `webView.submitForm(sourceId, token, target, "POST", contentType, body)` **真的把表单发出去了**（`SourcesRoutes.kt:705`）；
4. 最后 `call.respondProxied{}` 二次 respond 抛异常 → 用户看到 500（`Application.kt:267` 的 `Throwable` 分支），日志里是一句「Unhandled request failure」。

也就是说：**403 是「发完之后才被看见」的**。这条路径要求攻击者先知道一个有效 `token`（`t` 参数由 `POST /browser/session` 签发），风险被这个前提压住了，但「403 之后仍执行写操作」这个形态本身必须修（见 §9 建议 S5）。

### 7.4 `/api/agent/*` 下线后的遗留引用（全清单）

| 位置 | 内容 | 危害 |
|---|---|---|
| `http/Guard.kt:41-43` | `READ_ONLY_POSTS` 里三条 `/api/agent/*` | 白名单膨胀、误导后来者；且白名单是「只读 POST 免写门」的唯一出口，混着死条目就有被误判为「还该有条 AI 端点」的风险 |
| `app/src/test/kotlin/io/legado/SameOriginGuardTest.kt:152` | `client.post("/api/agent/sources/validate")` 并断言 `status != Forbidden` | **僵尸测试**：该路由已 404，404 ≠ 403，断言恒过。它声称在守「白名单里的只读 POST 跨站不被拦」，实际守的是「路径不存在也不算被拦」 |
| `web/src/lib/api/types.ts:729-926` | 13 个 `Agent*` 类型 + 段注释 | 约 200 行死类型（见 6.3） |
| `web/src/lib/api/index.ts:9` | 注释里的 10 个 agent 域名 | 文档误导 |
| `model/SystemModels.kt:26` | `HealthStatus.ai: Boolean = true` 注释「2026-11-17 起产品默认关」 | 能力已关、字段仍默认 true，`/healthz` 恒报 `ai:true` |
| `ServerConfig.kt:27` | 注释「关着时不注册 `/api/agent` 那一组」 | 注释描述的是一个已不存在的注册点 |
| `docs/agent-api.md` | 完整一份 AI 接入说明仍在仓库里（`product/docs/`） | 外部读者会照它调 404 |
| `ApiCompressionHttpTest.kt:51` | 注释「原来用的 /api/agent/manifest 随 AI 那套挪走后没了」 | 无害，但说明同类漂移曾经发生过 |

## 8. 契约测试覆盖

### 8.1 现有判据与真实覆盖

| 判据 | 位置 | 覆盖什么 | 实测数字 |
|---|---|---|---|
| `ApiCatalog.test.ts`（双向核对） | `product/web/test/ApiCatalog.test.ts` | 目录 ↔ 路由源码文本：多一条、漏一条、`write` 说谎、缺 `purpose`/`response`/`group` 都红；并钉死 `144 条 / 18 组 / 系统组 11 条` | 解析出 **144** 条（**方法正则只有 `get\|post\|put\|delete\|patch`**，`head(`/`options(` 不认，见 §2.2）；断言 `catalog.endpoints.length === routes.length` 因此恒等 |
| `RouteMountTest` | `app/src/test/kotlin/io/legado/RouteMountTest.kt` | 每个 `*Routes.kt` 文件必须被 `Routes.kt` 调用，反之亦然（防「文件在、没挂载」） | 12 个组函数的装配关系 |
| `RouteCatalogTest` | 同目录 | 起真服务打 `GET /api/catalog`：能解析、`count` == `endpoints.size`、`version` == 运行时构建号、`baseUrl` == 运行时地址 | 1 条端点 |
| `ApiRoutesHttpTest` | 同目录（771 行） | 起真服务打常用端点，断言状态码与回包字段 | **64 次 `client.get/post/put/delete` 调用，33 个不同 URL 字面量** |
| `HttpSurfaceNegativeTest`（243 行）、`SameOriginGuardTest`（161 行） | 同目录 | 负向：路径穿越、跨站写、白名单 | 负向用例为主 |
| 全部后端测试合计 | `app/src/test/kotlin/io/legado/**` | 按「方法 + 路径模板」匹配 | **69 / 146 ＝ 47.3%** |

### 8.2 结论

- **有机器可读契约且是双向的**——这在同类项目里算相当好的底子（`ApiCatalog.test.ts:110-190` 的自述与实现都到位）。
- 但 **77 / 146 条端点在 HTTP 层没有任何测试**（`69` 覆盖里还有若干只验状态码）。零覆盖最集中的是：`RSS` 全部 7 条、`分章规则` 全部 7 条、`朗读会话` 4 条、`书架批量/分组` 6 条、`内置浏览器 + 子资源代理` 11 条、`真浏览器登录` 4 条。
- **门禁看不见的盲区已被证实两处**：(a) `head`/`options` 方法（§2.2）；(b) 参数名（§6.4 的 `?url=` vs `?u=`——测试测的是后端偏好写法，前端写错的那个变量没人测）。
- **僵尸判据 1 处**：`SameOriginGuardTest.kt:151-160`（§7.4）。

## 9. 重建建议（只给建议，不改代码）

### S1 先把「组」变成代码事实，而不是文档字段

现状：146 条只有 13 个 `xxxRoutes(...)` 装配点，`SourcesRoutes.kt` 一个文件 46 条、覆盖目录里的三个组，`/api/cookies` 名字挂在书源文件下却语义属于「登录与凭据」。

**【建议】** 以「**域**」为单位重划，一个域 = 一个目录 + 一个装配入口 + 一份 DTO 文件：

```
/api/sources        (书源定义、CRUD、批量、排序、导入导出)      ~12
/api/sources/{id}/login   (登录 UI、登录动作、凭据、Cookie 同步) ~14
/api/browser              (内置浏览器 / 真浏览器 / 子资源代理)     ~17
/api/cookies        (全局凭据)                                  4
/api/reader         (详情/目录/正文/缓存刷新)                     7
/api/shelf          (书架/分组/批量/离线缓存)                    17
/api/search         (搜索/发现/流式)                              4
/api/notes /api/progress /api/logs(阅读)  (进度、笔记、本书检索)   9
/api/tts /api/rss /api/rules(净化+分章+替换) /api/backup /api/system /api/prefs /api/subscriptions /api/media
```

**关键是把「内置浏览器/子资源代理」从 `sources` 里拆出去**：那 17 条的调用方是服务端注入的 JS，鉴权模型（ticket + `t` 参数）与其余完全两套，混在书源组里是当前最难审计的部分。

### S2 版本化与命名

- **【建议】** 保留无版本前缀（本机单用户服务，不需要 `/v1`），但**必须**把「破坏性变更」写进 `/api/catalog` 的 `version`（现在 `version` 被 `RouteCatalog.kt:44` 覆盖成构建号，"契约版本"这个概念已经消失了）。契约版本与技术栈版本应是两个字段：`contractVersion`（人改）、`build`（自动）。
- **【建议】** 路径命名归一到三条规则并写进 lint：资源用复数（`/sources`）、动作式端点用动词后缀（`/sources/{id}/validate`）、**不出现「无 id 的集合级 PUT/DELETE 带语义开关」**（`DELETE /api/bookshelf/cache?clearData=true` 这类一律改成 `/cache/cancel` 与 `/cache/data` 两条）。

### S3 错误契约收口

- **【建议】** `ApiError.code` 变成**枚举**（Kotlin `enum class` + TS 生成），至少收口七类：`invalid_input` / `not_found` / `conflict` / `blocked_outbound` / `upstream_failed` / `internal` / `cross_origin`。现在 70 个自由字符串里，`not_found` 的 7 种写法直接对应 7 个分支 bug 面。
- **【建议】** 「部分成功」显式化：所有批量端点统一回 `{ done: n, failed: [{key, code, message}] }`，前端才能一致地展示，而不是有的回 `{deleted,total}`、有的回 `{updated,failed}`、有的在数组元素里塞 `error`。
- **【建议】** 前端 `client.ts` 抛一个 `ApiError` 类（带 `status` 与 `code`），而不是 `new Error(message)`。这是投入最小、收益最大的一条。

### S4 中间层：把这六块补上 Repository

阅读、书架、RSS、净化规则、分章规则、凭据目前**没有 Repository**（§3.2，87 处直连 DAO）。**【建议】** 重建时按「一个聚合根一个仓储」补：`ReadingRepository`（章节内容 + 缓存 + AI 覆盖）、`ShelfRepository`（书架 + 分组 + 缓存队列）、`CredentialRepository`（桶 + 登录态 + loginHeader/loginInfo 三合一的**单一写入口**——目前有 3 条路能写登录态，见 R4）。路由层只允许：解析 → 调一个仓储方法 → 序列化。

### S5 鉴权：把「全局插件」升级成真闸门

- **【建议】** 不要再依赖「处理器第一行记得早退」这种纵深防御。Ktor 里可用 `install(createRouteScopedPlugin)` 或直接在 plugin 里 `call.respond` 后**不调用 `proceed()`**（`onCall` 换成 `on(CallFailed)`/拦截 pipeline 的正确位置），让 403 真正短路；否则「403 之后仍执行」的形态会在每次新增端点时复现一次（§7.3）。
- **【建议】** 写门判据从「有没有 `Origin`」改成「**有没有票据**」：本机客户端用 `X-Legado-Token`（启动时打印/写文件），浏览器用同源 `Origin`。现在的模型下，任何本机进程/容器内进程都能改库，而「同源写门」挡不住它们——这在单机单人场景可接受，但在「有人把服务跑在 NAS/容器里」时是隐患，至少要把这个取舍写进契约文档而不是只写在注释里。
- **【建议】** 所有有**出站网络副作用**的写操作，禁止提供 GET 形态（`GET /api/tts/speak`、`GET /api/sources/{id}/browser/*`）。GET 形态在这些点位上既是放大器又是缓存友好性灾难。
- **【建议】** 清死条目：`Guard.kt:41-43`、`SameOriginGuardTest.kt:152`、`types.ts:729-926`、`index.ts:9`、`ServerConfig.kt:27` 注释、`docs/agent-api.md`（或标注「历史，端点已下线」）。

### S6 契约生成与门禁补盲

- **【建议】** `types.ts` 由后端生成（`kotlinx.serialization` 的 schema → TS 类型生成器，或用 `JsonElement` schema 的快照测试）。现在 161 个后端 DTO 与 100+ 前端类型靠手抄，D1–D9 就是手抄的必然产物。
- **【建议】** `ApiCatalog.test.ts:91` 的方法正则补上 `head|options`，并把「解析条数」与「目录条数」都钉到**运行时**（起真服务读 `/api/catalog` 的 `endpoints` 与 Ktor 路由树能给出的方法集对比），否则解析器的盲区会一直等于契约的盲区。
- **【建议】** 增加「参数名契约测试」：把每个端点的 `queryParameters["x"]` 也纳入目录（现在目录只有 `body`/`query` 的**描述文字**，不是机器可校验的键名），前端调用时按目录校验——§6.4 的 `?url=`/`?u=` 就是这类 bug 的模板。

## 10. 证据索引表

| 主题 | 关键证据（`file:line`，相对 `E:\legadoQ-archive\`） |
|---|---|
| 路由装配点 | `product/app/src/main/kotlin/io/legado/http/Routes.kt:70-86`（13 个组的挂载）、`:89-105`（`respondCatching`）、`:126-139`（`classifyRuleFailure`） |
| 目录与 self-report | `product/app/src/main/resources/agent-api.json`（`"count": 144`，144 条 `endpoints[]`，18 组）、`http/RouteCatalog.kt:41-50`（`count`/`version`/`baseUrl` 三处运行时覆盖） |
| 鉴权 | `http/Guard.kt:30`（SAFE_METHODS）、`:39-44`（READ_ONLY_POSTS，含 3 条死 agent 路径）、`:57-58`（login-cookie 自管来源）、`:72-96`（全局写门插件）、`:105-122`（处理器写门）、`:130-134`（回环判据）、`:148-156`（启动期绑定闸门）、`:163-179`（同源身份判定）；`Application.kt:273`（插件装配位置：routing 之前） |
| 错误契约 | `model/SystemModels.kt:5`（`ApiError`）、`Application.kt:244-272`（4 条 StatusPages）、`http/StrictJsonConverter.kt:46-59`、`http/StrictRequestText.kt:22-31`、`web/src/lib/api/client.ts:31-34`（前端只取 message） |
| 分层违规 | `http/ReadingRoutes.kt:140-197`、`http/SourcesRoutes.kt:425-461`、`:428-430`、`:565-568`、`http/TocRulesRoutes.kt:160-190`、`http/SearchRoutes.kt:53-148`、`http/MediaRoutes.kt:125-200`、`system/SystemRoutes.kt:62-79`、`http/PrefsRoutes.kt:30-35` |
| DTO 不一致 | D1 `model/ReadingModels.kt:259` vs `web/src/lib/api/types.ts:231`；D2 `:260-265` vs `types.ts:233-234`；D3 `:254` + `data/CacheDao.kt:360,364` vs `types.ts:228`；D4 `model/SystemModels.kt:235,251` vs `domains/sources.ts:92-103` vs `lib/cookieApi.ts:12-53`；D5 `model/ReadingModels.kt:21,117` vs `types.ts:132,173`；D6 `model/SourceModels.kt:26-32` vs `types.ts:440-447`；D7 `http/SearchSession.kt:31,39,45` vs `types.ts:100`；D8 `model/SystemModels.kt:5` vs `client.ts:31-34`；D9 `model/SystemModels.kt:26` vs `types.ts:37-38` |
| DTO 就地声明 | `http/BackupRoutes.kt:171,174`、`http/SourcesRoutes.kt:90,102,110` |
| 重复端点 | R1 `http/ReplaceRulesRoutes.kt:59-77`；R2 `http/TtsRoutes.kt:110,146,31,35,82`；R3 `http/SourcesRoutes.kt:161,549`；R4 `:196,412,425`；R5 `http/ShelfRoutes.kt:131,147,265`；R6 `:168,175,196`；R7 `web/src/lib/api/domains/sources.ts:90-118` + `web/src/lib/cookieApi.ts:55-72`；R8 `web/src/lib/api/domains/prefs.ts:17` + `web/src/lib/api/index.ts:55-83`（未导出 `uiPrefs`） |
| 前端缺陷 | `web/src/lib/api/domains/sources.ts:111-112`（`?url=`）vs `http/SourcesRoutes.kt:163`（只认 `u`）；`web/src/lib/api/domains/reader.ts:229,240`（同 URL 同方法重复包装）、`:257,262`（仅差 query） |
| 零引用端点 | `http/MediaRoutes.kt:99`、`http/ReadingRoutes.kt:232,246`、`http/ReplaceRulesRoutes.kt:96`、`http/TtsRoutes.kt:82,96`、`http/SourcesRoutes.kt:663,680,694` |
| 死契约 | `web/src/lib/api/types.ts:729-926`、`web/src/lib/api/index.ts:9`、`app/src/test/kotlin/io/legado/SameOriginGuardTest.kt:151-160`、`ServerConfig.kt:27`、`docs/agent-api.md` |
| 过时数字 | `web/src/features/reader/notes/NotesPanel.tsx:18`（155）、`app/src/test/kotlin/io/legado/RouteMountTest.kt:18`（161）、`http/Guard.kt:70,103`（88/89 两说） |
| 契约测试 | `web/test/ApiCatalog.test.ts:91`（方法正则盲区）、`:110-190`（双向判据 + 144/18/11 断言）、`app/src/test/kotlin/io/legado/ApiRoutesHttpTest.kt`（64 次调用 / 33 个 URL）、`RouteMountTest.kt`、`RouteCatalogTest.kt` |

## 11. 未确认事项

1. **68 条端点的响应 DTO 未做静态定名**：处理器经 `respondMedia` / `respondProxied` / `respondBytes` / `respondTextWriter` 等辅助函数或二进制通道回包，本脚本抽不到类型。表 1 里这些标「宣称：」的内容**来自 `agent-api.json`，未逐条回源验证**。
2. **`POST /api/sources/{id}/browser/submit` 的 403-后仍执行**（§7.3）是**读代码推断**的：依赖「Ktor `onCall` 不阻断 pipeline」这一前提（`Guard.kt:91-94` 的注释自述、且处理器普遍加了早退作为对策）。未实测（本审计禁止发请求）。
3. **69/146 的测试覆盖是「测试代码里出现过该 URL」的静态计数**，不等于断言有效；有若干只断言状态码。真实行为覆盖需要跑测试并看断言内容，本次未跑（`./gradlew :app:test` 不在只读审计范围）。
4. **前端 117 个路径形态的全覆盖**依赖把 `${…}` 归一化；动态拼接（如 `BASE`、`` `${prefix}/x` ``）可能仍有个别漏判。`_parts` 里 `domains/*.ts` 是唯一出口这一前提来自线索，本次只抽查了 `sources.ts`/`reader.ts`/`search.ts`/`prefs.ts`/`backup.ts`/`system.ts`/`brand.ts` 与 `lib/cookieApi.ts`、`lib/fontLibrary.ts`、`lib/importFromUrl.ts`、`plugins/*` 的 `/api/` 出现点。
5. **`agent-api.json` 的 `write` 标志与代码是否一致**：`ApiCatalog.test.ts` 用「处理器 40 行内有无 `requireSameOriginWrite`／`sameOriginCall`」判定，本审计未逐条复核这 144 个 `write` 值（只复核了「哪些处理器没有写门」这一侧，共 52 处）。
6. **`product/experimental/ai/` 里的 `AgentApiRoutes.kt`**（已不编译）本次未读；`/api/agent/*` 的历史形状只能从 `types.ts` 与 `docs/agent-api.md` 侧面确认。
7. **`/healthz` 之外的静态路由**（`staticWeb` / `staticNext`，`Application.kt:283-284`）未纳入端点表——它们不是契约端点。

## 12. 覆盖率声明

- **实际核对端点数：146 条**（逐条给出方法、路径、注册 `file:line`、请求体、响应、鉴权、DAO，见 §1 全表）。
- **宣称端点数（`agent-api.json`）：144 条 / 18 组**；本文与代码的差异 **2 条**（`HEAD /api/book/media`、`OPTIONS /api/sources/{id}/login-cookie`），**幻影端点 0 条**。
- **覆盖率：146/146 ＝ 100% 的代码注册端点被逐条清点**；其中 **78 条的请求体+响应 DTO 由源码静态确认**，**68 条的响应取目录宣称（§11.1）**。按「宣称」口径则为 144/144 全部在代码中找到对应注册点（100%）。
- **前端侧**：117 个 `/api/…` 路径形态全部核对（0 条指向不存在的端点，1 条参数名缺陷）。
- **测试侧**：146 条中 69 条被后端测试代码触及（47.3%）。

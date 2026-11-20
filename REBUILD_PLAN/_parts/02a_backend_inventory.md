# 02a · 后端资产清单（Phase 0 审计）

> 审计对象：`E:\legadoQ-archive\product\app\src\main\kotlin\io\legado\`
> 采集时间：2026-11-17 · 只读审计（未改动任何源码、未 build、未启动）
> 标注约定：【事实】= 实测/源码直读；【推断】= 由结构或命名推得；【建议】= 审计意见；【未确认】= 本轮未验证
> 路径约定：所有 `文件:行号` 均相对 `E:\legadoQ-archive\`

## 1. 包级清单表

**采集命令（实测，2026-11-17）**

```bash
cd E:/legadoQ-archive/product/app/src/main/kotlin/io/legado
# ① 全仓 .kt 总数（不含 test）
find . -name '*.kt' | wc -l                 # → 123
# ② 每包文件数 + 总行数（follows subdir）
for d in <包>; do echo "$d $(find $d -name '*.kt' | wc -l) $(find $d -name '*.kt' -print0 | xargs -0 cat | wc -l)"; done
# ③ 每包入边（有多少包外 .kt import 了它）
for p in <包>; do grep -rl "import io\.legado\.$p\." --include=*.kt . | grep -v "^\./$p/" | wc -l; done
```

【事实】16 个包 + 根目录 10 个文件合计 **123 个 `.kt` 文件 / 29,553 行**（27504 + 根 2049）。
`ai/` 目录存在但**已空**（0 文件）——AI 子系统按 AGENTS.md §8.2 已移至 `product/experimental/ai/`，主源码树只剩空壳目录。

| # | 包 | 文件数 | 总行数 | 一句话职责 | 被谁调用（入边文件数 / 主要调用方） |
|---|---|--:|--:|---|---|
| 1 | `http/` | 20 | 4072 | Ktor 路由装配点 + 各组业务处理器（书源/书架/搜索/阅读/媒体/备份/RSS/TTS/订阅/替换规则/偏好/守卫） | 2 / `Application.kt`（`apiRoutes`）、`http/system`（`Routes.kt` 装配） |
| 2 | `http/system/` | 1 | 124 | 系统域端点：`/catalog` `/server` `/logs` `/diagnostics` `/about` `/changelog` | 1 / `http/Routes.kt`（`systemRoutes`） |
| 3 | `data/` | 24 | 5116 | 持久层收口：Repository（书源/书架/阅读）、DAO（`Database` 扩展函数写 SQL）、连接池与 schema 迁移外的业务编排 | **23**（最热）/ `http/*`、`rules/*`、`port/*`、`Application.kt` |
| 4 | `data/db/` | 4 | 605 | 连接池（**只一条写连接 + WAL**）、Schema DDL、Migration、Cookie 工具 | 2 / `data/Database.kt` |
| 5 | `rules/` | 28 | 9188 | 规则引擎（Legado 声明式书源协议的服务器安全子集）：取值、列表、分页、登录、HTTP、JS 沙箱 | **12** / `http/*`、`data/SourceRepository`、`source/*`、`content/*` |
| 6 | `rules/processor/` | 2 | 80 | `RuleProcessor` 扩展点的两个 demo 实现（`demo-hello:` / `demo-markdown:`） | 0【事实】仅测试引用（`RuleProcessorTest`），生产未注册 |
| 7 | `source/` | 5 | 1930 | 书源周边：JSON 编解码（`SourceCodec`）、体检（`SourceHealth`）、调试器、**WebView 登录代理**、外部浏览器登录 | 9 / `http/SourcesRoutes`、`data/SourceRepository`、`http/Routes` |
| 8 | `reading/` | 1 | 116 | 阅读域收口：进度 / 阅读记录 / 笔记划线（含书签）/ 本书检索（组合 DAO，不写 SQL） | 1 / `http/ReadingRoutes` |
| 9 | `content/` | 3 | 421 | 正文后处理管线（`ContentPipeline`/`ContentProcessor`）+ 宽松 JSON 解析（`LooseJson`） | 6 / `rules/RuleRunner`、`http/ReadingRoutes` |
| 10 | `backup/` | 4 | 1176 | 备份五域导出/导入（现版本 + Legado App 历史格式）、存储、冲突策略 | 3 / `http/BackupRoutes`、`Application.kt` |
| 11 | `cache/` | 3 | 527 | 正文缓存服务、封面缓存（磁盘 LRU）、封面解析 | 7 / `http/*`、`rules/*`、`Application.kt` |
| 12 | `localbook/` | 2 | 1014 | 本地书解析（TXT/EPUB 等）+ TXT 目录规则（`TxtTocRule`/`TocRules`） | 7 / `http/LocalBook*`（实为 `http/Routes`/`MediaRoutes`）、`data/ImportDao` |
| 13 | `model/` | 7 | 1159 | 共享 DTO（书源/阅读/书架/发现/替换规则/备份/系统），纯 `@Serializable` | **53**（最广）/ 几乎所有包 |
| 14 | `ops/` | 9 | 1345 | 运维横切：`LogService`、`Metrics`、`NetworkSecurity`、`PinnedProxy`、`GuardedHttpClient`、`UiPrefsStore`、`UpdateCheck`、`ServerIdentity` | **15** / `http/*`、`rules/*`、`Application.kt`、`DesktopLauncher` |
| 15 | `port/` | 4 | 348 | 端口化（hexagonal）：让 `rules/` 按能力向宿主索取，而非直接 import `data/`（`PortBundle`/`StorePorts`/`Logging`/`SourceUrlProbe`） | **19** / `rules/*` 为主 |
| 16 | `subscription/` | 1 | 144 | 订阅源拉取/解析（书源订阅） | 3 / `http/SubscriptionsRoutes`、`Application.kt` |
| 17 | `tts/` | 2 | 948 | TTS 会话服务（`TtsSessionService`，含 `Mp3DurationEstimator`）+ Edge TTS 合成 | 3 / `http/TtsRoutes`、`http/Routes`、`Application.kt` |

> 关于「被谁调用」的口径：【事实】数字是**包外 `.kt` 文件的 import 计数**，不等于运行时调用次数。`model/` 与 `port/` 数值高主要因为它们是纯类型/接口契约层，被大面积 import 属预期。

### 1.1 根目录 10 个文件

| 文件 | 行数 | 职责 | 被谁调用 |
|---|--:|---|---|
| `Application.kt` | 303 | `createLegadoEngine()`：装 Ktor 插件（ContentNegotiation/Compression/StatusPages/WebSockets）、启停引擎；**裸跑 jar 与桌面壳共用同一份启动代码**（KDoc 明示） | `main`、`DesktopLauncher` |
| `AppConfig.kt` | 277 | `LEGADO_*` 环境变量 → 配置（含 `jsHostBytes` 等判据可注入项） | 全仓（`rules/JsSandbox`、`ops/*`） |
| `DesktopLauncher.kt` | 621 | 桌面壳入口（jpackage `--main-class io.legado.DesktopLauncherKt`）：探测端口作单实例锁、带 `LEGADO_*` 起引擎、开浏览器/托盘/优雅关闭 | 桌面发行包入口 |
| `StaticWeb.kt` | 294 | 烤进 jar 的 `/assets` 静态托管：Vite 内容哈希 → 一年 `immutable` + gzip + ETag/HEAD；**刻意不装 `ktor-server-compression`**（会误压 SSE/TTS/备份流） | `http/Routes.kt` |
| `BrandStore.kt` | 150 | 品牌/外观清单读写 | `http/PrefsRoutes`、`http/system` |
| `BrandManifest.kt` | 94 | 品牌清单 DTO | `BrandStore` |
| `BuildInfo.kt` | 87 | 构建号 / rev / sha（`/healthz` 返回） | `http/system/SystemRoutes`、`RouteCatalog` |
| `ServerConfig.kt` | 63 | 监听地址/端口派生 | `Application`、`DesktopLauncher` |
| `DesktopDataDir.kt` | 57 | 桌面模式数据目录解析 | `DesktopLauncher` |
| `TextDecoding.kt` | 103 | 文本解码（字符集嗅探兜底） | `rules/ResponseBody`、`localbook/*` |

## 2. 功能级实现状态表

判定口径：【完整实现】= 生产路径全链路可用且有测试；【部分实现】= 主干可用但明确缺一块（缺的那块给出证据）；【仅桩】= 有类型/接口无真实执行路径；【不存在】= 全仓无对应代码。

### 2.1 书源域

| 能力 | 判定 | 证据（`文件:行号`） |
|---|---|---|
| 书源模型 | 完整实现 | `product/app/src/main/kotlin/io/legado/model/SourceModels.kt:6-21`（`SourceSummary`：id/name/url/group/enabled/isJsSource/hasLogin/hasRules/updatedAt/version/sortOrder）；`source/SourceCodec.kt:11-24`（`ParsedSource`，含 `hasRules`、`json` 原文） |
| JSON 编解码 | 完整实现 | `source/SourceCodec.kt:43`（`object SourceCodec`）、`:61-113`（`parse`）、`:44-48`（`ignoreUnknownKeys/isLenient/coerceInputValues` 宽松解析） |
| 扩展字段保留 | **完整实现（有语义限制）** | `source/SourceCodec.kt:94-102`：把整份 `JsonObject` 复制成可变 map，只覆盖 `bookSourceUrl`/`bookSourceName` 两键后整体重新序列化 → **未知/上游扩展字段全部保留**，但**不是字节级原文**（键序与空白被规范化）。落库为 `source.payload` 单列：`data/SourcesDao.kt:23`（select payload）、`:172-174`（upsert payload） |
| 导入 / 导出 | 完整实现 | 端点 `http/SourcesRoutes.kt:260`（`GET /sources/export`）、`:266`（`POST /sources/import`）；业务 `data/SourceRepository.kt:172`（`importSources`）、`:174`（`exportSources`）；DAO `data/ImportDao.kt:16-17`（主键 `sourceUrl`，冲突语义明确为 **整体覆盖、不保留本地改动**） |
| 校验 | 完整实现（含「不兼容扫描」） | `source/SourceCodec.kt:50-59`（`validate` → `parse` + `scanIncompatibilities` 产出 warnings）、`:188`；端点 `http/SourcesRoutes.kt:304`（`POST /validate`）；仓储 `data/SourceRepository.kt:165`（`validate(id, draft)` 支持草稿校验） |
| 分组 | 完整实现 | `source` 表 `source_group` 列 `data/SourcesDao.kt:23`；批量 `data/SourcesDao.kt:207-240`（`set_group` 分支 `:234`）；端点 `http/SourcesRoutes.kt:232`（`POST /sources/batch`） |
| 启用 / 停用 | 完整实现 | `data/SourcesDao.kt:219`（`update source set enabled=1`）、`:227`（`=0`）；生效面 `:106/131/150`（`where enabled = 1` 贯穿列表/导出/离线缓存） |
| 自定义排序 | 完整实现 | `data/SourcesDao.kt:57-80`（写 `sort_order`，`:80` 清空）、`:25`（排序表达式 `order by sort_order is null, sort_order, name`）；端点 `http/SourcesRoutes.kt:274/284`（`PUT`/`DELETE /sources/order`） |
| 书源体检 | 完整实现 | 编排 `data/SourceRepository.kt:91`（`suspend healthCheck`）、`source/SourceHealth.kt`（134 行）、`data/SourceHealthDao.kt`（100 行）；端点 `http/SourcesRoutes.kt:250` |
| 单源调试 | 完整实现 | `source/SourceDebugger.kt`（215 行）；`RuleRunner.kt:733`（`debugDetails` 返回 `DebugTrace`）；端点 `http/SourcesRoutes.kt:312`（`GET /debug`） |
| 登录（UI 声明 / 脚本 / 浏览器） | 完整实现 | `model/SourceModels.kt:35-76`（`SourceLoginUiItem`/`SourceLoginUiResponse`，含 flex 样式、`loginUiVersion`、`loginUiError`）；`rules/RuleLogin.kt`（394 行，v1+v2）；端点群 `http/SourcesRoutes.kt:342/370/378/399/412/425/469/483`；内置浏览器 `source/WebViewProxy.kt:817 行`、`source/ExternalBrowserLogin.kt`（521 行） |
| 书源订阅 | 完整实现 | `subscription/SubscriptionService.kt`（144 行）；`http/SubscriptionsRoutes.kt`（74 行）；`data/SubscriptionDao.kt`（42 行） |

### 2.2 规则引擎

| 能力 | 判定 | 证据 |
|---|---|---|
| CSS（Jsoup） | 完整实现 | `rules/RuleValue.kt:635`（`NodeValue.html`）、`rules/RuleNodeSelection.kt:40-47`（`@css:` 显式前缀 + 选择器方言）；`rules/JsoupBridge.kt`（215 行，供 JS 侧用） |
| XPath | 完整实现 | 与 CSS 同一条 `selectLegadoSegments` 分发（`rules/RuleNodeSelection.kt:36-43` 注释描述前缀分发）【推断：具体分支在 `RuleValue`/`RuleNodeSelection` 的选择器方言内，本轮未逐行确认】 |
| JSONPath | 完整实现 | `rules/RuleValue.kt:636-641`（`document()` 按首字符 `{`/`[` 走 JSON 分支、`json()` 构造）；`rules/LooseJson.kt`（200 行，宽松 JSON 容错） |
| JS | 完整实现（最重） | `rules/JsSandbox.kt:211`（`class JsSandbox`）、`:270-279`（`eval` 带 `Metrics.timed(STAGE_JS)`）、`:281`（`evalImpl`）；Java 桥 `rules/JavaPackages.kt`（1415 行） |
| 正则 / `##替换##` | 完整实现 | `rules/RuleValue.kt:297`（正则条目主段处理顺序：`@put:` → `@get:{}` → `##替换##` → `{{}}` → `$N` → 正则替换）、`:630`（`PUT_VARIABLE` 正则）；`rules/RuleSplit.kt`（267 行） |
| 变量替换语法 | 完整实现 | `rules/RuleValue.kt:81`（`@put:{k:规则}` 求值存表并剔除）、`:225`（`@get:{k}` 与 `{{k}}` 共用一张表）、`:376/385`（`putVariable`/`getVariable`）；跨调用保活 `rules/RuleRunner.kt:124-142`（`rememberRuleData`/`recallRuleData`，`:124` 注释举漫画源 `@put:{bid:$.comic_id}` 实例） |
| 规则嵌套 | 完整实现 | `rules/RuleValue.kt:35-41`（`runtime` 随子节点下传）、`:636-644`（工厂均带 `runtime` 参数）；`RuleRunner.kt:874`（`postRule` 二次取值） |
| 分页 | 完整实现 | `rules/PagingRule.kt:32`（`supportsPaging`）、`:50`（`referencesPage`）；目录翻页 `rules/RuleRunner.kt:761`（`addPage`）、`:854`（`parseNextTocUrls` 多页解析） |
| 请求规则（URL 脚本 / 头 / 超时） | 完整实现 | `rules/RuleHttp.kt:30`（`parseSourceHeaders`）、`:50`（`networkContext`）、`:60`（`capToDeadline` 单跳超时上限）、`:82`（`applyUrlScripts`）、`:120`（`renderUrl`）；合并逻辑 `RuleRunner.kt:1106/1137`（`mergeOptions`/`splitUrlOptions`） |
| 错误处理 / 失败归因 | 完整实现 | `RuleRunner.kt:203`（`responseClue` 从响应体取线索）、`:228`（`upstreamReason` 把上游错误翻成人话）；`rules/RuleExecutionException`（由 `http/Routes.kt:19` import）；测试 `RuleFailureClassifyTest` |
| 扩展点 `RuleProcessor` | **完整实现（已真正接入）** | 契约 `rules/RuleProcessor.kt:25-49`；调度 `:93`（`class RuleDispatcher`）、`:111`（`dispatch`）、`:118`（`claim`）、`:124`（`claimNodeRule`）；两个调用点 `rules/RuleValue.kt:52`（单值）、`rules/RuleNodeSelection.kt:45`（列表）；`RuleRunner.kt:92` 参数 `dispatcher`。**但产品内零自定义类型**：`rules/processor/demo/` 仅 2 个 demo（31+49 行），`dispatcher.register` 无生产调用 |
| 搜索编排 | 完整实现 | `rules/SearchFlow.kt`（78 行，KDoc 自述「只搬编排，不搬解析」）；`http/SearchSession.kt:25-30`（SSE 事件流）；`http/SearchRoutes.kt:53` |
| 替换规则（净化） | 完整实现 | `data/ReplaceRuleDao.kt`（263 行）、`model/ReplaceRuleModels.kt`（103 行）、`http/ReplaceRulesRoutes.kt`（198 行，`:114` 独立 `JsSandbox`） |

### 2.3 网络

| 能力 | 判定 | 证据 |
|---|---|---|
| HTTP 客户端 | 完整实现 | `ops/NetworkSecurity.kt:54`（`newHttpClient`，`:60-72` 按 `allowLoopback` 选严格/宽松 `PinnedProxy`）、`ops/GuardedHttpClient.kt:28`（JDK `HttpClient` 委托包装，`:40/47/55` 三个 send 入口统一过闸） |
| SSRF / 私网拦截 | **完整实现（这是本项目的强项）** | `rules/RuleRunner.kt:1316`（`validateTarget(uri)`，类 KDoc `:3` 明写 "rejects private-network targets"）、`data/SourceRepository` 侧复用；`ops/NetworkSecurity.kt:84`（`resolveAndValidateSafeHttpTarget`）、`:12-35`（DNS 缓存 5 分钟 / 2000 条）；`ops/PinnedProxy.kt:31-206`（**DNS pinning 隧道**，`:206 resolveTarget`、`:213 respondAndClose` 拒绝出口） |
| Cookie | 完整实现 | `data/CookieDao.kt`（716 行，含 `MentionsWarmer`）、`data/SessionCookies.kt`（67 行）、`data/db/CookieUtil.kt`（38 行）；合并 `rules/RuleRunner.kt:1421`（`mergeCookieStrings`）；跨域取用 `data.getCookieForUrl`（`Application.kt:31` import） |
| 请求头 | 完整实现 | `rules/RuleRunner.kt:1381`（`effectiveHeaders`，`:1383` 局部 `put` 做去重）、`:1403`（`parseHeaderJson`）；书源 `header` 字段 `rules/RuleHttp.kt:30` |
| 代理 | **仅出站安全用（非用户可配置代理）** | `ops/PinnedProxy.kt` / `ops/ProxyHeaders.kt` 的「代理」是**进程内 SSRF 闸门**，不是对外 HTTP 代理设置。【未确认】是否有 `LEGADO_*` 出口代理配置项——`AppConfig.kt`（277 行）未逐行读 |
| 重定向 | **完整实现（手写跟随 + 每一跳重校验）** | 关闭内建跟随：`rules/RuleRunner.kt:117`（`followRedirects = HttpClient.Redirect.NEVER`）、`subscription/SubscriptionService.kt:39` 同；改为手写循环 `RuleRunner.kt:1267`（`if (statusCode() !in 300..399)` 终止）、`:1303`（缺 `Location` 报错）、`:1306`（**`validateTarget(redirect)` 对每一跳重新做私网校验**）、`:1307`（重建请求）。这是 SSRF 防护的关键一环——否则 `302 → 127.0.0.1` 就能绕过首跳校验 |
| 编码 / 字符集 | 完整实现 | `rules/RuleRunner.kt:1437`（`resolveBodyCharset(bytes, declared, contentType)`）、`rules/ResponseBody.kt`（114 行）；根 `TextDecoding.kt`（103 行）；测试 `ResponseCharsetTest`、`TextDecodingTest` |
| 超时 | 完整实现 | `rules/RuleHttp.kt:60`（`capToDeadline`，KDoc `:9` 称「单跳超时上限，与 `fetchDetailedImpl` 共用」）；连接超时 `ops/GuardedHttpClient.kt:68` |
| SSL / TLS | 部分实现 | 仅透传：`ops/GuardedHttpClient.kt:71`（`sslContext()`）、`:72`（`sslParameters()`）。**无证书固定 / 无自签放行开关的证据**【推断：证书校验依赖 JDK 默认 truststore】 |
| 图片（封面 / 正文图 / 代理） | 完整实现 | `http/MediaRoutes.kt`（493 行，`:136/177` 走 `runner.imageDecoder`）、`cache/CoverCache.kt`（225 行）、`cache/CoverResolution.kt`（73 行）、`rules/ImageDecode.kt`（60 行）；正文图片保留 `rules/RuleRunner.kt:1472`（`preserveContentImages`）、`:1501`（`imageSrcUrl`） |
| 响应缓存 | 完整实现 | 目录缓存 `data/CacheDao.kt:19/27/62`（`getTocCache`/`tocChapters`/`saveTocCache`）、正文缓存 `:230`（`cachedContent`）、离线抓取 `cache/BookCacheService.kt:39-58`（`:43 start` / `:50 enqueue` / `:58 cancel`）、`data/CacheDao.kt:77`（`importLocalBook`） |
| 限读 / gzip 炸弹防护 | 完整实现 | `rules/GzipLimits.kt`（87 行）、`rules/ResponseBody.kt`（114 行）；`rules/JsSandbox.kt:212`（`hostByteBudget` 宿主字节预算，KDoc `:208` 说明生产走 `AppConfig.jsHostBytes`） |

### 2.4 阅读

| 能力 | 判定 | 证据 |
|---|---|---|
| 阅读模型 | 完整实现 | `model/ReadingModels.kt`（268 行，7 个模型文件中最厚的一个） |
| 目录 | 完整实现 | `rules/RuleRunner.kt:738-867`（`chapters`→`parseTocPage`→`parseNextTocUrls`）；缓存 `data/CacheDao.kt:62`；本地书目录 `localbook/TxtTocRule.kt`（451 行） |
| 正文 | 完整实现 | `rules/RuleRunner.kt:913-1058`（`content`→`contentImpl`→`contentPage`）；后处理 `content/ContentPipeline.kt`（37 行）+ `content/ContentProcessor.kt`（184 行）；清洗 `RuleRunner.kt:1472-1554`（`unwrapTopLevelDivs`/`cleanContent`/`absolute`） |
| 进度 | **完整实现（超出同类产品）** | `data/ReadingDao.kt:36-37`：`reading_progress` 同时存 `scroll_position` / `char_offset` / `paragraph_anchor` / `position_version` / `position_checksum`（**字符偏移 + 段落锚点 + 校验和**三重定位，防改版漂移）；收口 `reading/ReadingRepository.kt:37-41`；`data/ReadingDao.kt:43` 同步 `book_shelf.last_read_at` |
| 分页 | 部分实现（后端薄） | 后端只有规则侧判断 `rules/PagingRule.kt:32/50` + 窗口取章 `reading/ReadingRepository.kt:79`（`chapterWindow`）。**分页测量/翻页是前端职责**（`product/web/src/features/reader/usePaginationMeasurement.ts`）【事实：后端无版面测量代码】 |
| 书签 | 完整实现（与笔记同表） | `data/ReadingDao.kt:92`（`book_note` 建表插入，含 `bookmark`、`paragraph_anchor`、`position_version`、`position_checksum` 列） |
| 笔记 / 划线 | 完整实现 | `reading/ReadingRepository.kt:51-60`（`listNotes`/`addNote`/`updateNote`/`deleteNote`）、`data/ReadingDao.kt:119/125`；本书检索 `reading/ReadingRepository.kt:64`（`searchBookContent`） |
| 阅读记录 / 时长 | 完整实现 | `data/ReadingDao.kt:62-63`（`reading_log` 按 `(day, source_id, book_url)` upsert 累加 seconds）、`reading/ReadingRepository.kt:44/47` |
| 阅读设置 | 完整实现（键值存储，非结构化） | `ops/UiPrefsStore.kt:44`（`class UiPrefsStore(file)`，带 `isKeyAllowed` 白名单与 `TooLargeException` 限额）、`http/PrefsRoutes.kt:28`；【推断】阅读器字号/主题等作为 prefs 键存在，**后端不定义 reader settings 结构体** |

### 2.5 备份

| 能力 | 判定 | 证据 |
|---|---|---|
| 五域导出 | **完整实现** | `backup/BackupExporter.kt:40/43/46/49/52`（常量 `bookSource.json` / `replaceRule.json` / `bookGroup.json` / `rssSources.json` / `bookshelf.json`）、`:209`（`exportAll` 一次打包） |
| 第六域 Cookie | 完整实现 | `backup/BackupImporter.kt:109-113` 五域 + `COOKIE_NAMES`（`:143` 参与合并集合）、`:63-77`（`keyOf`/`encryptBase64`/`decryptBase64`，AES/MD5 派生密钥） |
| 格式 | 完整实现（双格式） | zip：`BackupImporter.kt:98-99`（`PK` magic 检测）、`:103`（`importZip`）；裸 JSON：`:328`（与 zip 同一套写入口径）；历史 Legado App 格式 `backup/LegacyBackup.kt`（268 行，`:25` 描述老转义规则 `|`→`||`） |
| 导入 | **完整实现（容错设计）** | `BackupImporter.kt:97`（`import(file, password)`）、`:97-120`（按条目名匹配，大小写/目录前缀无关，`:108` 归一为 lowercase）、`:310` 注释明写「上游缺密码直接抛错、整个恢复中止；我们只跳过这一节并如实回报」 |
| 冲突策略 | 部分实现（**last-write-wins，无合并/无 dry-run**） | `data/ImportDao.kt:42`（`on conflict(source_url) do update`）、`:126`（书架同语义）；进度只在备份更新时覆盖 `:96`（「仅当备份时间不早于库中进度时覆盖，避免进度回退」）；墓碑条目跳过并计数 `:102`（`skippedDeleted`）。测试 `ImportConflictPolicyTest` |
| 回滚 | **完整实现（文件级快照）** | `data/DbSnapshot.kt`（200 行）：`VACUUM INTO` 文件级一致性快照 + **每份配 SHA-256 sidecar 做完整性判定** + 只留最近 N 份；端点 `http/BackupRoutes.kt:52`（`GET /backup/snapshots`）、`:56`（`POST /backup/snapshots/restore`） |
| 保留区（任意文件） | 完整实现 | `backup/BackupStore.kt`（124 行，`KEEP_NAMES` 白名单）、`BackupRoutes.kt:47/66`（`GET /backup/kept`、`/{name}`） |
| 事务原子性 | 完整实现 | 测试 `BackupImportAtomicTest`；DAL 层写连接纪律见 §5（只一条写连接） |

### 2.6 其他能力面

| 能力 | 判定 | 证据 |
|---|---|---|
| 书架 | 完整实现 | `http/ShelfRoutes.kt`（292 行）、`data/BookshelfRepository.kt`（552 行）、`data/ShelfDao.kt`（423 行）、`model/BookshelfModels.kt`（161 行）；本地书导入端点 `http/ShelfRoutes.kt:96` |
| 搜索 | **完整实现（并发 + 截止 + SSE）** | `http/SearchRoutes.kt`（370 行，`:53 POST /search`、`:217-221` 完成/命中/空/失败/结果数计数、`:278 truncated`、`:360` 截止循环）、`http/SearchSession.kt`（47 行）；测试 4 个：`SearchConcurrencyTest`/`SearchDeadlineTest`/`SearchHealthOrderTest`/`SearchSessionTest` |
| 发现 | 完整实现 | `http/SearchRoutes.kt:149`（`GET /explore/sources`）、`:152`（`POST /explore`）；引擎 `RuleRunner.kt:284-325`（`exploreTabs`/`explore`/`exploreImpl`）、`:484`（`parseExploreTabs`）；模型 `model/DiscoveryModels.kt`（75 行） |
| RSS | 完整实现 | `http/RssRoutes.kt`（102 行）、`rules/RssFeedParser.kt`（92 行）、`data/RssDao.kt`（78 行）；引擎 `RuleRunner.kt:326/345/459`（`rssTabs`/`rssArticles`/`rssContent`）；模型 `model/SourceModels.kt:33-40`（`ParsedRssSource`） |
| 本地书 | 完整实现 | `localbook/LocalBookParser.kt`（563 行，`LOC_BOOK_SOURCE_ID` 虚拟书源 id）、`localbook/TxtTocRule.kt`（451 行）；接入点 `http/ReadingRoutes.kt:60/65/99/163/206`（**以「假 sourceId」分支的方式嵌进阅读路由**，不是独立路由组）；规则存储 `http/Routes.kt:63`（`TocRules.useStore(.../txt_toc_rules.json)`）；端点组「分章规则」7 条（`agent-api.json`） |
| 漫画 | **部分实现（无独立子系统）** | 全仓**无 manga 模型字段**（`grep -rn manga model/ content/ cache/ http/` 零命中）。漫画按「正文里就是图片」处理：`RuleRunner.kt:1472-1507`（`preserveContentImages`/`imageSrcUrl`）、`cache/BookCacheService` 离线把图抓进磁盘缓存（`Application.kt:170-172` 注释明写「否则离线打开漫画只有图片占位、图全裂」）。**无卷轴模式 / 无阅读方向 / 无跨页拼接**（后端侧） |
| TTS | 完整实现 | `tts/TtsSessionService.kt`（417 行，含 `Mp3DurationEstimator`）、`tts/EdgeTtsService.kt`（531 行，**依赖微软 Edge 在线语音服务**）；端点 `http/TtsRoutes.kt:28/31/35/53/72/82`（vocies/session/chunks/control/audio，9 条端点）；测试 `EdgeTtsTest`/`TtsSessionServiceTest` |
| 订阅 | 完整实现 | `subscription/SubscriptionService.kt`（144 行）、`http/SubscriptionsRoutes.kt`（74 行）、`data/SubscriptionDao.kt`（42 行） |
| 缓存（离线） | 完整实现 | 见 §2.3「响应缓存」行；另有 `cache/CoverCache.kt`（225 行，磁盘封面缓存） |
| 日志 / 指标 | **完整实现（超出常见自托管）** | `ops/LogService.kt`（197 行）+ `data/LogDao.kt`（109 行）、`ops/Metrics.kt`（197 行，`:1` 注释「单书源聚合指标 `avgLatencyMs`」+「按阶段：解析/脚本/出站 HTTP」）、端点 `GET /diagnostics`（`http/system/SystemRoutes.kt`，字段对齐 `metrics` DTO）；测试 `MetricsTest`/`MetricsStageTest`/`LogServiceTest` |
| 桌面启动器 | 完整实现 | `DesktopLauncher.kt`（621 行，KDoc `:1-8` 三职责：端口探测兼单实例锁 / 带 `LEGADO_*` 起引擎 / 开浏览器+托盘+优雅关闭）、`DesktopDataDir.kt`（57 行）；复用 `Application.createLegadoEngine`（`Application.kt:37` KDoc 明示「桌面壳用 `start(wait=false)` 拿引擎」） |
| 静态托管 | **完整实现（有明确取舍）** | `StaticWeb.kt`（294 行，KDoc `:1-6`：Vite 内容哈希 → 一年 `immutable` + gzip + ETag/HEAD；**刻意不装 `ktor-server-compression`**，因为会误压 SSE / TTS 音频流 / 备份下载）；测试 `StaticAssetsHttpTest`/`ServerConfigAndStaticTest` |
| 端点目录 / 契约 | 完整实现 | `http/RouteCatalog.kt:34-51`：把随包 `resources/agent-api.json` 发给外部程序，`version`/`count`/`howToConnect.baseUrl` **运行时现盖**而非文件写死；【事实】`agent-api.json` 实测 **144 条端点 / 18 组**（`grep -c '"method"'` → 144；group 分布：内置浏览器 17、登录与凭据 15、书架 14、书源 12、系统 11、净化规则 10、进度与笔记 9、朗读 9、阅读 7、分章规则 7、RSS 7、备份 6、图片与媒体 6、书源订阅 5、离线缓存 3、发现页 3、搜索 2、目录 1） |
| 鉴权 / 守卫 | 完整实现 | `http/Guard.kt`（190 行，含 `SameOriginWriteGate`、`requireLoopbackBind`，见 `Application.kt:32-33` import）；`http/StrictJsonConverter.kt`（61 行）、`http/StrictRequestText.kt`（36 行）强制严格 JSON；测试 `BindGuardTest`/`SameOriginGuardTest`/`StrictJsonRequestTest`/`HttpSurfaceNegativeTest` |
| 更新检查 | 完整实现 | `ops/UpdateCheck.kt`（168 行）；测试 `UpdateCheckTest`/`UpdateCheckReleasesTest` |
| AI / Agent | **不存在（已出主源码树）** | `ai/` 目录存在但 **0 个 `.kt` 文件**（`find ai -type f` 无输出）；`Application.kt:178-180` 注释确认「已挪到 `product/experimental/ai/`，不参与编译与打包；要恢复需挪回并接回这两处」 |

## 3. 规则引擎调用链

【事实】`RuleRunner` 在**全进程只构造一次**：`Application.kt:168`（`RuleRunner(database = database)`），随后按路由组注入（`http/ReadingRoutes.kt:55`、`http/ReplaceRulesRoutes.kt:46`、`http/MediaRoutes.kt:41`、`cache/BookCacheService` 构造参数）。全仓无第二处 `RuleRunner(` 生产构造点。

```text
[HTTP 边界]
http/ReadingRoutes.kt:75/87/115/187        runner.details() / reviews() / chapters() / content()
http/MediaRoutes.kt:136/177                runner.imageDecoder()
  │
  ▼
[RuleRunner 入口 · rules/RuleRunner.kt:80 class RuleRunner]
   :92  val dispatcher: RuleDispatcher  ← 扩展点调度器（0.2.34 起「真的会被读到」）
   :99  private val runtime = RuleRuntime(dispatcher) { logRuleExecution(...) }   ← 绑定日志出口
   :107 private val nodeSelection = RuleNodeSelection(runtime) { ... }            ← 列表取值下沉
   :119 internal val jsSandbox = JsSandbox(this)                                  ← JS 沙箱单例挂载
   :145 search()      → :153 searchWithReason() → :240 bookItems()                ← 搜索主链
   :284 exploreTabs / :296 explore / :326 rssTabs / :345 rssArticles / :397 reviews
   :599 details() → :602 detailsImpl() → :617 declarativeDetails()
   :738 chapters() → :741 chaptersImpl() → :803 parseTocPage()
   :913 content()  → :916 contentImpl() → :1039 contentPage()
  │
  ├─[列表规则] :252 / :368 / :414 / :826 / :874
  │    if (isJsRule(listRule)) :867 jsListNodes(...)  else ──┐
  │                                                          ▼
  │   [rules/RuleNodeSelection.kt:16 class RuleNodeSelection]
  │     :45  runtime.dispatcher.claimNodeRule(rule)?.let { ... }   ← ① 先问扩展点（只问 producesNodes=true 的）
  │     :47  认领即拥有：命中后 return result.nodes，不再落回内建链路
  │     :53  处理器报错/空结果 → 记日志 + emptyList()（不静默退化为 CSS）
  │
  ├─[单值规则] rules/RuleValue.kt:45 NodeValue.value(rule, jsSandbox, rawBody, baseUrl)
  │     :52  active.dispatcher.claim(rule.trim())   ← ② 扩展点优先；size==0 时连 trim 都不做（热路径）
  │     :48  位置刻意在 `@put/@get` 之前：处理器拿到规则原文
  │     :81  `@put:{k:规则}` 求值存变量表并从规则串剔除 → :376 putVariable / :385 getVariable
  │     :225 变量查表（`@get:{k}` 与 `{{k}}` 共用一张正则表）
  │     :297  正则条目主段顺序：`@put:` → `@get:{}` → `##替换##` → `{{}}` → `$N` → 正则替换
  │     内建四种：CSS(Jsoup) / XPath / JSONPath / 正则 → `@js:` / `<js>…</js>`
  │
  ├─[JS 执行]
  │   RuleRunner.kt:481  jsSandbox.eval(code, bindings)         ← evalRuleJs 通用入口
  │   RuleRunner.kt:590  jsSandbox.eval(...)                    ← sourceContext / 登录相关
  │   RuleRunner.kt:723  jsSandbox.eval(script, mapOf("result", "baseUrl"), sourceContext(...)) ← imageDecoder
  │                                                          ▼
  │   [rules/JsSandbox.kt:211 class JsSandbox(runner, hostByteBudget)]
  │     :212/:270  fun eval(script, bindings, execContext) = Metrics.timed(STAGE_JS) { evalImpl(...) }
  │     :281  evalImpl：剥 `@js:`/`js:` 前缀 → 注入 jsLib（**全局作用域**单独求值，Legado 语义）
  │     :475 clearLastError / :613+ `java.*` 桥方法注册（按白名单）
  │                                                          ▼
  │   [rules/JavaPackages.kt · 1415 行]  Java 白名单桥（仅暴露上游书源真实用到的 API）
  │
  └─[出站 HTTP]
      :1059 fetch() / :1070 fetchResponse() / :1174 fetchUrl() / :1212 fetchDetailed() → :1221 fetchDetailedImpl()
      :1316 validateTarget(uri)   ← 拒绝私网目标（SSRF）
      :1325 buildRequest() · :1381 effectiveHeaders() · :1421 mergeCookieStrings()
      :1437 resolveBodyCharset()  ← 字符集嗅探兜底
      （底层 `ops/GuardedHttpClient` / `ops/PinnedProxy` / `ops/NetworkSecurity`）
```

**关键结构判断**

- 【事实】扩展点 `RuleProcessor` **已经真正接入热路径**，不再是装饰：`RuleValue.kt:52`（单值）+ `RuleNodeSelection.kt:45`（列表）两处 claim。【事实】`RuleProcessor.kt:6-24` 的 KDoc 自陈历史缺陷：「此前…`ruleDispatcher` 参数从未被读取，`processor` 包下四个实现全是『尚未实现』…那等于没有扩展点」——现在已修复，且明确「认领即拥有」语义。
- 【事实】`rules/processor/demo/` 只有 2 个 demo（31 + 49 行），生产代码**零注册**（`grep -rn "dispatcher.register"` 无生产命中，仅测试）；即：扩展点可用，但**产品内没有任何自定义规则类型**。
- 【事实】`RuleRunner.kt:1679 行` 仍承担 HTTP 段 + 解析段 + 业务段三职；KDoc（AGENTS.md §7）称已抽走 `RuleNodeSelection` / `ResponseBody` / `RuleUrlSupport` / `RuleLogin`，但 `fetchDetailedImpl`/`buildRequest`/`effectiveHeaders` 一带（约 `:1174-1437`，260 行）仍在主类内。
- 【推断】`NodeValue` 的 `runtime` 会随子节点下传（`RuleValue.kt:35-41` 注释明示），因此扩及点对嵌套/子节点规则同样生效，无需在每一层重复注入。

## 4. 测试资产

**采集命令**

```bash
cd E:/legadoQ-archive/product/app/src/test
find kotlin/io/legado -name '*.kt' | wc -l                    # → 139
find kotlin/io/legado -maxdepth 1 -name '*.kt' | wc -l        # → 128（顶层）
find kotlin -name '*.kt' -print0 | xargs -0 cat | wc -l       # → 24374 行
```

【事实】**139 个测试文件 / 24,374 行**，其中顶层 128 个、子目录 11 个（`content/` 1、`data/` 5、`rules/` 3、`tts/` 2）。测试代码量约为主源码（29,553 行）的 **82%** —— 这是本项目最值钱的资产之一。

### 4.1 顶层测试清单（按守护对象分组）

- **规则引擎（24）**：`GoldenRuleTest` `RuleRunnerTest` `RuleRunnerTest` 系（`RuleRunnerExtendedTest` `RuleRunnerAdvancedFeaturesTest`）`RuleProcessorTest` `RuleNodeSelection` 相关（`IndexSelectorTest` `RuleBranchAndSelectorDialectTest`）`BareJsonListRuleTest` `PagingDetectionTest` `PagingSegmentTest` `RuleFailureClassifyTest` `RuleHttpGuardTest` `RuleLoginGuardTest` `RuleUrlScriptsTest` `RuleVariableHandoffTest` `RuleValue` 相关（`LooseUrlOptionsTest` `PutPairsTest` `StrUtilFormatTest`）`ChapterNumbersTest` `ChapterReviewTest` `RssFeedParserTest` `ResponseCharsetTest`
- **JS 沙箱 / Java 桥（16）**：`JsSandboxHostBudgetTest` `JsSandboxHostAmplificationTest` `JsSandboxResourceLimitTest` `JsSandboxRequestShapeTest` `SandboxErrorScopeTest` `JsGuardLimitsTest` `JsEs6SyntaxTest` `JsScriptShapeTest` `JsScriptConvertBridgeTest` `JsEnvironmentBridgeTest` `JsCachePackagesBridgeTest` `JsCryptoBridgeTest` `JsCryptoResponseBridgeTest` `JsResponseCookieTest` `JsRuleReentryBridgeTest` `JsoupBridgeTest`
- **HTTP 面 / 契约 / 守卫（10）**：`ApiContractTest` `ApiRoutesHttpTest` `ApiCompressionHttpTest` `RouteCatalogTest` `RouteMountTest` `HttpSurfaceNegativeTest` `BindGuardTest` `SameOriginGuardTest` `StrictJsonRequestTest` `DiagnosticsEndpointTest`
- **数据层 / 迁移 / 事务（8）**：`DatabaseTest` `DatabaseLifecycleTest` `TransactionTest` `DbSnapshotTest` `StorePortEquivalenceTest` `LogicalPositionTest` `SchemaVersion` 相关（无独立文件）`ReadingRepositoryTest`
- **备份（6）**：`BackupImportTest` `BackupImportAtomicTest` `BackupExportRoundTripTest` `BackupSnapshotsEndpointTest` `BackupStoreTest` `LegacyBackupTest` `ImportConflictPolicyTest` `ShelfDeletedBookImportTest`
- **搜索（4）**：`SearchConcurrencyTest` `SearchDeadlineTest` `SearchHealthOrderTest` `SearchSessionTest` `SearchRoutesTest`
- **书源（13）**：`SourceCodecTest` `SourceBucketsTest` `SourceCommentEvalTest` `SourceDebuggerTest` `SourceHasRulesTest` `SourceHealthTest` `SourceLoginTest` `SourceOrderTest` `SourceValidateWarningsTest` `WebViewProxyTest` `WebViewProxyRouteTest` `ExternalBrowserLoginTest` `CoverProxyRouteTest`
- **网络 / 安全（6）**：`NetworkSecurityTest` `PinnedProxyTest` `ProxyHeadersTest` `MediaProxyHelpersTest` `MediaUrlSniffTest` `CookieLayersTest`
- **Cookie / 凭据（3）**：`CookieMentionsTest` `CookieMentionsPersistenceTest` `RuleLoginGuardTest`
- **阅读 / 笔记（6）**：`NoteTest` `ReadingLogTest` `ContentRefreshHttpTest` `ReplaceRuleTest` `ReplaceRuleE2EIntegrationTest` `UpstreamReasonTest`
- **本地书（4）**：`LocalBookParserTest` `LocalBookImageTest` `TxtTocRuleTest` `ImageDecodeTest`
- **RSS / 订阅（3）**：`RssFeedParserTest` `RssSubscriptionTest` `SubscriptionParseSourcesTest` `SubscriptionErrorClassHttpTest` `SubscriptionServiceHttpTest`
- **TTS（1）**：`EdgeTtsTest`（+ 子目录 `tts/` 2 个，含 `Mp3DurationEstimatorTest`）
- **缓存（3）**：`BookCacheServiceTest` `CoverCacheTest` `ScriptCacheTtlTest`
- **架构 / 配线 / 运维（10）**：`ArchitectureBoundaryTest` `AppConfigEnvWiringTest` `AppConfigJsHostBytesTest` `LogServiceTest` `MetricsTest` `MetricsStageTest` `UpdateCheckTest` `UpdateCheckReleasesTest` `UiPrefsTest` `BrandStoreTest`
- **入口 / 静态 / 端到端（7）**：`E2EScenariosTest` `CrossFeatureBackendTest` `ServerConfigAndStaticTest` `ServerPortTest` `StaticAssetsHttpTest` `DesktopDataDirTest` `BundledChangelogTest` `BookBridgeTest`

> 上述分组名与本轮实际 `ls` 的 128 项一一对应（个别文件跨组，为可读性归入一处）。

### 4.2 细看的 9 个判据（各读前 25 行注释）

| 测试 | 守什么（摘自文件头 KDoc） |
|---|---|
| `GoldenRuleTest.kt:1-6` | 金标准回归：**离线 fixture 锁住规则引擎当前行为**。理由写得很实在——`RuleRunner` 有 21 个公开方法、跨搜索/详情/目录/正文/登录/JS 六条链路，改一处很容易静默改坏别处 |
| `SearchDeadlineTest.kt:1-8` | 「带总量截止的并发收集」，修的是**同步搜索把请求拖过 300 秒**的真实故障；背景实测「本机 5598 个启用书源，`/api/search` 不带 sourceIds 就是全库扫」 |
| `BackupImportAtomicTest.kt:1-7` | 备份导入原子性：六步落库是**一整笔事务**，任一步失败不许留半套数据；并点出旧缺陷「个性化条目在 commit 之前就写了磁盘，库回滚了文件却留着」 |
| `JsSandboxHostBudgetTest.kt:1-7` | 宿主侧**累计**字节预算：单次上限挡不住「多次小额 + 脚本保留」（一次 8MB `copyOf` 合法，几十次即数百 MB） |
| `ArchitectureBoundaryTest.kt:12-49` | 把三份架构报告收敛出的**四条硬边界**变成可执行断言；`:27` 明确「`rules/` 不得 import `data/` `source/` `http/` 的具体实现类」；`:428` 记录 `rules → data/source/http` 横穿基线「**0 条，已清零**」 |
| `ResponseCharsetTest.kt:1-7` | 远程响应字符集判定；点出这层出错**不抛异常**、只把整页变成乱码并一路脏进书名/章标题/正文/书架（实测样本 `gzmeal.com`） |
| `ApiContractTest.kt:1-12` | 端点契约计数判据；`:3-6` 记录 AI 子系统迁出后原「框架契约」判据大半随之搬走 —— 说明测试是跟着能力面走的重构过 |
| `RuleProcessorTest`（见 §2.2） | 扩展点认领语义（认领即拥有 / 空结果不退化为 CSS） |
| `JsoupBridgeTest` `JsCryptoBridgeTest` `JsEnvironmentBridgeTest` | Java 桥白名单逐项行为锁 |

### 4.3 `test/resources/rule-golden/` 覆盖的规则类型

【事实】`ls` 结果 **6 组 fixture**：

| fixture | 覆盖类型 | 文件 |
|---|---|---|
| `search-css` | CSS 搜索列表规则 | `page.html` `source.json` `expected.json` |
| `content-css` | CSS 正文规则 | `page.html` `source.json` |
| `details-toc-json` | JSONPath 详情 + 目录（**连翻页**） | `book.json` `toc.json` `source.json` `expected.json` |
| `rss-articles` | RSS 文章规则 | `page.html` `source.json` |
| `login-v1-js` | v1 登录脚本 | `source.json` `expected.json` |
| `login-v2-js` | v2 登录脚本 | `source.json` `expected.json` |

【事实】**未覆盖**的类型（金标准维度）：**纯 XPath**（无 fixture，靠 `RuleBranchAndSelectorDialectTest` 等单点测）、**JS 列表规则**（`jsListNodes` 路径无 golden）、**正则列表**（AllInOne `:` 前缀）、**多页目录翻页**（`details-toc-json` 是否含翻页需读 fixture 确认【未确认】）、**图片解密/`imageDecode`**（靠 `ImageDecodeTest` 单测）。【建议】重建时把这 4 类补成 golden，是成本最低的回归保险。

## 5. 死代码 / 半成品 / 重复实现

### 5.1 TODO / FIXME 标记计数（实测）

```bash
cd E:/legadoQ-archive/product
grep -rn "TODO\|FIXME\|XXX\|HACK" app/src/main --include=*.kt | wc -l      # → 0
grep -rin "todo\|fixme\|\bxxx\b\|hack" app/src/main --include=*.kt | wc -l # → 14（全部误报）
grep -rn "尚未实现\|未实现\|暂不实现\|待实现\|还没实现" app/src/main --include=*.kt | wc -l # → 2
```

【事实】**生产源码里真实的 TODO/FIXME/XXX/HACK 标记 = 0 条**。忽略大小写后的 14 条命中全是误报，逐个看过：
`JavaPackages.kt:358/360/361/362/839`、`JsSandbox.kt:719/1081`、`Migration.kt:42` 等是 `toDouble`/`toDoubleOrNull` 含子串 `todo`；
`JsSandbox.kt:422/1081`、`JsScriptShape.kt:17`、`RuleHttp.kt:16`、`RuleRunner.kt:940`、`RuleUrlSupport.kt:24/32` 是注释里的占位符字样 `xxx`（如 `this.xxx`、`runner.xxx(...)`、`xxx.m4a`）。

【事实】中文「未实现」只有 2 条，且都不是待办：`rules/JavaPackages.kt:644`（`else -> error("未实现的 Java 白名单类：$full")` —— 这是**运行期防御分支**，不是欠债）、`rules/RuleProcessor.kt:10`（KDoc 里的**历史描述**，说明旧版本曾如此）。

【事实】中文「占位 / 待补」类命中 37 条，抽检 6 条全部是**功能语义**（`![图片](url)` 图片占位、上游式 `<页1,页2,…>` 分页占位符、`RuleHttp.kt:117` 地址占位写法替换、`JsSandbox.kt:997` Cookie 地址占位符），**没有一条是「此功能待补」**。

> 【推断】这个仓库的「欠债」不写在代码标记里，而是写在 KDoc 的历史段落中（例如 `RuleProcessor.kt:9-11` 直言「此前 ruleDispatcher 从未被读取…那等于没有扩展点」，`Application.kt:178-180` 记录 AI 迁出，`ArchitectureBoundaryTest.kt:28-32` 记录基线从 25 → 0 的收敛过程）。**重建时若只看 TODO 会得到「零欠债」的错误结论。**

### 5.2 半成品 / 名不副实的 10 处代表位置

| # | 位置 | 现象 | 判定 |
|---|---|---|---|
| 1 | `rules/processor/demo/`（`DemoHelloProcessor.kt` 31 行 + `DemoMarkdownProcessor.kt` 49 行） | 扩展点已真接入热路径，但**产品内零自定义规则类型**，只有两个 demo；`dispatcher.register` 无生产调用 | 扩展点「可用但空转」 |
| 2 | `ai/`（`product/app/src/main/kotlin/io/legado/ai/`） | **空目录，0 个 `.kt`**；`Application.kt:178-180` 注释确认整套 AI 已挪到 `product/experimental/ai/`，不编译不打包 | 死目录 |
| 3 | `port/PortBundle.kt:15` KDoc | 注释称「`RuleRunner(db)`、`JsSandbox(database = db)`、`ScriptCache.get(..., db)`，共 53 处」，但 `JsSandbox` 的构造签名已是 `(runner, hostByteBudget)`（`JsSandbox.kt:211-214`），**没有 `database` 参数** | KDoc 漂移（注释比代码旧） |
| 4 | `rules/RuleRunner.kt`（1758 行） | 仍是「HTTP 段 + 解析段 + 业务段」三职一体；AGENTS.md §7 记录的下一步（抽 `fetchDetailedImpl`/`buildRequest`/`effectiveHeaders`，约 `:1174-1437`）**尚未执行** | 半成品重构 |
| 5 | 漫画能力 | 无 `manga` 模型字段、无独立子系统，靠「正文里就是图片」+ `preserveContentImages` 兜住；`Application.kt:170` 注释暴露痛点「否则离线打开漫画只有占位、图全裂」 | 能力以「副作用」形式存在 |
| 6 | `ops/GuardedHttpClient.kt:19` 的约束声明 | KDoc 称「出站 HTTP 只能由 `NetworkSecurity.newHttpClient` 签发：模块拿不到裸的 `HttpClient.newBuilder()`」，但全仓仍有 **6 处裸构造（分布在 5 个文件）**（见 5.3 第 1 条）——该约束**无测试守门** | 声明未落实 |
| 7 | SSL/TLS | 仅 `GuardedHttpClient.kt:71-72` 透传 `sslContext`/`sslParameters`，无证书固定、无自签放行开关 | 薄实现 |
| 8 | 阅读设置 | 后端只有 `UiPrefsStore`（键值 + 白名单），**无 reader settings 结构体**；字号/主题/翻页模式的结构定义在前端 | 后端缺模型 |
| 9 | 阅读分页 | 后端只有 `PagingRule`（规则侧判断）+ `chapterWindow`；版面测量全在前端 | 前后端职责失衡 |
| 10 | `rules/processor` 的入边 | 包外 import 计数 = **0**（见 §1 表），生产零引用 | 与 #1 同源 |

### 5.3 同名能力多份实现（6 例，均实测）

| # | 能力 | 实现 A | 实现 B（及更多） | 性质 |
|---|---|---|---|---|
| 1 | **出站 HTTP 客户端签发** | `ops/NetworkSecurity.kt:54`（合规签发，3 处使用：`RuleRunner.kt:117`、`SubscriptionService.kt:39`、`MediaRoutes.kt:448`） | 裸 `HttpClient.newBuilder()` **6 处 / 5 个文件**：`DesktopLauncher.kt:313`、`DesktopLauncher.kt:323`、`tts/EdgeTtsService.kt:28`、`source/ExternalBrowserLogin.kt:99`、`source/WebViewProxy.kt:60`、`ops/UpdateCheck.kt:42` | **真重复 + 约束漏洞**（`source/` 属 ENGINE_PACKAGES，见 `ArchitectureBoundaryTest.kt:308`） |
| 2 | **字符集判定** | 根 `TextDecoding.kt:33`（`charsetOf`）+ `:96`（`tryDecode`） | `rules/RuleRunner.kt:1437`（`resolveBodyCharset`）、`rules/ResponseBody.kt`（114 行）、`source/WebViewProxy.kt:119/155/160/190`（`detectCharset` 4 处调用） | 4 处入口，口径靠测试对齐（`ResponseCharsetTest`/`TextDecodingTest`） |
| 3 | **书源健康标签词表** | `data/SourcesDao.kt:361`（注释自陈「**必须与前端 `web/src/lib/sourceGrouping.ts` 的 `HEALTH_TAGS` 逐字一致**」） | `product/web/src/lib/sourceGrouping.ts:18`（`HEALTH_TAGS`） | 前后端双份，靠注释+测试（`HealthTagVocabulary`）维持 |
| 4 | **JsSandbox 实例** | `rules/RuleRunner.kt:119`（`internal val jsSandbox = JsSandbox(this)`，随 runner 单例） | `http/ReadingRoutes.kt:166`、`http/ReplaceRulesRoutes.kt:114` 各自 `JsSandbox(runner)` **另建** | 每处独立实例 → 各自一份宿主字节预算记账 |
| 5 | **备份包解析** | `backup/BackupImporter.kt`（现格式：zip + 裸 JSON，`import:97`） | `backup/LegacyBackup.kt`（268 行，老 Legado 格式与转义规则 `:25`） | 有意分层（新旧格式），但两边都要维护条目名映射 |
| 6 | **RSS 解析** | `source/SourceCodec.kt:141`（`parseRss`：解析**书源订阅**里的 RSS 源元数据） | `rules/RssFeedParser.kt`（92 行：解析**文章 RSS 正文**） | 语义不同、**非重复**（列出以澄清易混点） |

**已核对但判定「非重复」的对照项**（避免重建时误合并）：

- `reading/ReadingRepository.kt`（116 行）↔ `data/ReadingDao.kt`（173 行）：Repository 只**组合调用** DAO 扩展函数，KDoc `:1-6` 明写「不重复任何 SQL，也不直接拼 SQL」。是分层，不是双份。
- `data/BookshelfRepository.kt`（552 行）↔ `data/ShelfDao.kt`（423 行）：同上，Repository 含批量编排（`batchDeleteBooks:120`/`batchMoveToGroup:168`/`batchMarkAsRead:202`）。
- `rules/RuleRunner.kt:715 imageDecoder` ↔ `rules/ImageDecode.kt:14`：`ImageDecode` KDoc 明确「只做解析，不跑 JS；JS 执行在 `RuleRunner.imageDecoder` 里」—— 分工清晰，可单测底层。
- `subscription/SubscriptionService.kt` ↔ `http/SubscriptionsRoutes.kt`：Service 有 `client`（`SubscriptionService.kt:39`），路由只装配。

## 6. 证据索引 / 未确认事项 / 覆盖率声明

### 6.1 关键结论 → 证据索引

| 结论 | 证据 | 采集方式 |
|---|---|---|
| 主源码 123 个 `.kt` / 29,553 行；16 包 + 根 10 文件 | 见 §1 采集命令 | `find` + `wc -l` |
| `ai/` 是空壳目录 | `find ai -type f` → 无输出；`Application.kt:178-180` 注释 | `find` + `sed` |
| 端点 144 条 / 18 组 | `product/app/src/main/resources/agent-api.json`（`grep -c '"method"'` = 144；group `uniq -c`） | `grep` |
| `RuleRunner` 全进程只构造一次 | `Application.kt:168`；全仓 `grep -rn "RuleRunner("` 无第二处生产构造 | `grep` |
| 扩展点已真接入热路径 | `rules/RuleValue.kt:52`、`rules/RuleNodeSelection.kt:45`、`rules/RuleRunner.kt:92` | `sed` |
| 扩展点产品内零注册 | `rules/processor/demo/` 仅 2 文件（31+49 行）；`grep` 无生产 `dispatcher.register` | `find` + `grep` |
| 书源扩展字段保留但非字节级 | `source/SourceCodec.kt:94-102` + `data/SourcesDao.kt:23/172-174` | `sed` |
| 备份冲突 = last-write-wins | `data/ImportDao.kt:16-17/42/96/102/126` | `grep` |
| 备份回滚 = 文件级快照 + SHA-256 | `data/DbSnapshot.kt`（KDoc + `SnapshotInfo`）+ `http/BackupRoutes.kt:52/56` | `sed` 1-24 + `grep` |
| 阅读进度三重定位 | `data/ReadingDao.kt:36-37` | `grep` |
| 零真实 TODO/FIXME | §5.1 三条 grep 计数 | `grep` |
| `GuardedHttpClient` 的「只能由 NetworkSecurity 签发」未落实 | `ops/GuardedHttpClient.kt:19` vs 6 处裸构造 / 5 个文件（§5.3 #1） | `grep` |
| 架构四边界 + 基线单调缩小 | `ArchitectureBoundaryTest.kt:27-36/105-114/308/428` | `grep` |
| 测试 139 文件 / 24,374 行 | §4 采集命令 | `find` + `wc -l` |
| rule-golden 6 组 fixture | `ls product/app/src/test/resources/rule-golden/` | `ls` |

### 6.2 未确认事项（【未确认】，本轮未验证，重建前建议补）

1. **XPath 支路的具体实现位置**：只确认了「前缀分发」存在（`RuleNodeSelection.kt:36-43` 注释），未定位 XPath 求值代码本体。
2. **重定向**：已确认主链路为手写跟随 + 每跳重校验（`RuleRunner.kt:1267-1307`）；但其余 5 处裸客户端的策略未读。
3. **是否有用户可配置的出站代理**：`AppConfig.kt`（277 行）未读；`ops.PinnedProxy` 是内网闸门而非 SOCKS/HTTP 代理。【推断】无。
4. **`details-toc-json` fixture 是否含多页目录翻页**：只看了包含的文件名（`book.json`/`toc.json`/`source.json`/`expected.json`），未读内容。
5. **`agent-api.json` 与代码路由的双向对齐**：`RouteCatalog` 只在运行时读 json；对账判据在 `product/web/test/ApiCatalog.test.ts`（AGENTS.md 提及），本轮未读该测试。
6. **`DesktopLauncher.kt:313/323` 裸 `HttpClient` 的用途与豁免依据**：只看到构造点（`connectTimeout` 1200/2000ms，像是本机自探活），未读上下文。
7. **TTS 离线可用性**：`tts/EdgeTtsService.kt:28` 自建客户端指向 Edge 在线语音服务；断网时的降级行为未确认。
8. **`port/` 端口化的实际覆盖比例**：`port/StorePorts.kt` KDoc 称只声明 `rules` 真正用到的 6 个能力、`PortBundle.kt:15` 称「共 53 处」调用点，但 `PortBundle.kt:15` 的 `JsSandbox(database = db)` 描述与现签名不符（§5.2 #3）—— 53 这个数的时效性未验证。
9. **`http/WebViewProxy` 代理路线的并发/资源上限**：`WebViewProxy.kt`（817 行）只读了 KDoc 与前 120 行片段，未验证连接上限。
10. **`content/ContentPipeline.kt`（仅 37 行）是否已取代 `ContentProcessor`（184 行）**：两者关系未读全。

### 6.3 覆盖率声明（老实写）

| 维度 | 数字 | 方法 |
|---|--:|---|
| 主源码 `.kt` 总数 | **123** | `find . -name '*.kt' \| wc -l` |
| 其中**读过内容窗口**（含仅取 KDoc 头、单文件 ≤120 行） | **30** | 逐次调用记录，清单见下 |
| 其中**仅 `grep` 到声明/单行、未读实现** | **14** | 同上 |
| 其中**完全未触碰** | **79** | 123 − 30 − 14 |
| 主源码覆盖率（有任何接触） | **35.8%**（44/123） | — |
| 测试 `.kt` 总数 | **139** | `find kotlin/io/legado -name '*.kt' \| wc -l` |
| 其中细读（前 25–26 行注释） | **9** | `GoldenRuleTest` `RuleRunnerTest` `JsSandboxHostBudgetTest` `BackupImportAtomicTest` `SearchDeadlineTest` `ArchitectureBoundaryTest` `ApiContractTest` `ResponseCharsetTest` `E2EScenariosTest` |
| 测试覆盖率（细读） | **6.5%**（9/139） | 其余仅取名录 |
| **总文件覆盖率（有实质接触）** | **20.2%**（53/262） | (44+9)/(123+139) |
| 主源码**行**覆盖率 | ≪ 20% | 严格单次 ≤120 行，且 5 个最大文件（`JsSandbox` 2100 / `RuleRunner` 1758 / `JavaPackages` 1415 / `WebViewProxy` 817 / `SourcesRoutes` 830）只做 `grep -n` + 小窗口 |

**读过内容窗口的 30 个主源码文件**（A 级）：
`Application.kt` · `StaticWeb.kt` · `DesktopLauncher.kt` · `http/Routes.kt` · `http/RouteCatalog.kt` · `http/system/SystemRoutes.kt` · `http/SourcesRoutes.kt` · `data/SourceRepository.kt` · `data/DbSnapshot.kt` · `data/db/ConnectionPool.kt` · `rules/RuleRunner.kt` · `rules/RuleProcessor.kt` · `rules/RuleValue.kt` · `rules/RuleNodeSelection.kt` · `rules/JsSandbox.kt` · `rules/RuleHttp.kt` · `rules/SearchFlow.kt` · `rules/processor/demo/DemoHelloProcessor.kt` · `source/SourceCodec.kt` · `source/WebViewProxy.kt` · `reading/ReadingRepository.kt` · `content/ContentProcessor.kt` · `backup/BackupImporter.kt` · `cache/BookCacheService.kt` · `localbook/LocalBookParser.kt` · `model/SourceModels.kt` · `ops/Metrics.kt` · `port/StorePorts.kt` · `subscription/SubscriptionService.kt` · `tts/TtsSessionService.kt`

**仅 grep 命中的 14 个**（B 级）：
`data/SourcesDao.kt` · `data/ReadingDao.kt` · `data/ImportDao.kt` · `data/CacheDao.kt` · `data/BookshelfRepository.kt` · `backup/BackupExporter.kt` · `backup/LegacyBackup.kt` · `ops/NetworkSecurity.kt` · `ops/PinnedProxy.kt` · `ops/GuardedHttpClient.kt` · `ops/UiPrefsStore.kt` · `port/PortBundle.kt` · `rules/PagingRule.kt` · `rules/JavaPackages.kt`

> **口径提醒**：本清单是「文件级」覆盖，**不是「行为级」覆盖**。表里的【完整实现】判定，多数依据是「端点存在 + 业务层函数存在 + 有对应测试」三者同时在位（三角验证），**不等于逐行读过实现**。凡涉及具体语义细节（尤其是协议兼容性、边界条件），本文档一律标注【推断】或【未确认】。重建方案若要把某项定为「可复用」，请先按 §6.1 的索引把对应实现读透。

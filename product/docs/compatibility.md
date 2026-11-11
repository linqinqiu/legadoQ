# 书源与格式兼容性说明

这份回答三个问题：**导入一本别人写的书源，哪些字段真会被执行**、**和上游 Legado App 的行为差在哪**、
**哪些东西我们不内置也不实现**。每条都带「文件名 + 符号名」，**不写死行号**（行号随重构漂移，下次拆文件又会失效）；
判据不是"照抄上游文档"而是服务端代码本身。

## 1. 一句话边界

这是一个**独立实现**，不是 Legado 的 fork：代码全部自写，只把上游当作**规则语义的参照基准**（见 §5 归属）。
所以兼容性目标不是"和上游一模一样"，而是"**社区书源导入后能按作者意图跑出结果**"；跑不出来的地方在下面逐条写明。

> **参照基准具体指谁（2026-10-14 实测）**：`gedoor/legado` 是本项目**来源署名**（README 与 `LICENSE` 的 upstream 都指它），
> 但它的默认分支现在只剩 `README.md` 与一张图，实体与规则代码已经不在那里；
> 要读现行 Android 端实现，看的是仍在维护的延续仓 **`LegadoTeam/legado`**（分支 `master`）。
> 另一个常被当参照的 `hectorqin/reader` 也已经换骨：`master` 只剩一行 `deleted`，现行 `main` 是 Node/TS 重写、
> **不再有书源 / RSS / 发现这套模型** —— 它的接口设计值得看，数据模型不能当 legado 兼容的依据。
> 三处都核对过才写下这句：`bookSourceExploreUrls`、`article`、`tocMode` 这三个字段名在任何一家实体里都不存在，谁写它们谁写错。

## 2. 导入兼容（书源 JSON 进得来吗）

| 事实 | 依据 |
| :--- | :--- |
| `bookSourceUrl` **只要求非空**，不强制 `http(s)://` —— 社区里大量融合书源用它当唯一标识（中文、自定义串都合法） | `source/SourceCodec.kt` 的 `parse()`（`bookSourceUrl` 非空校验） |
| 主键是**剥掉 `#` / `##` 注解后的域名**；带注解导入与不带注解导入落到同一条记录 | `source/SourceCodec.kt` 的 `normalizeSourceId`，前端同口径 `web/src/sources/bookSourceFields.ts` + `SourceEditorPanel.tsx` 的 `declaredSourceId` |
| **UTF-8 BOM 要先剥**，否则整份 JSON 解析失败 | `source/SourceCodec.kt` 的 `parse()` / `parseRss()`（`removePrefix("\uFEFF")`） |
| 外层包装认 `data` / `sources` / `bookSources` / 裸数组四种；单条坏 JSON 退到逐行解析 | `web/src/sources/sourceImport.ts`（前端侧），服务端另有一条同口径路径 |
| 一个源能存能改，靠的是**原样存 payload**而不是重新序列化模型 —— 未识别字段不会因为"我们没有这个属性"而丢 | `app/src/main/kotlin/io/legado/data/Database.kt` 的 `source` 表存 `payload`；编辑走 `SourceCodec` |

## 3. 执行期支持哪些规则写法

| 能力 | 依据 / 说明 |
| :--- | :--- |
| **CSS 选择器 + Jsoup**（列表、字段、属性、文本） | `rules/RuleRunner.kt`（`import org.jsoup.Jsoup`） |
| **JSON Path**（`$.data.list[*]` 这类），并且 JS 属性访问与 JsonPath 取值同一份数据形状 | `rules/RuleRunner.kt`（`import com.jayway.jsonpath.JsonPath`）、`toPlainJava()`（把 `JsonElement` 转普通 Java 结构，两种取法都能用） |
| **XPath** 规则（`@xpath:` 方言）走独立分支，不会被当成 CSS 猜；底层用第三方 `cn.wanghaomiao.xpath`（`JXDocument`） | `rules/RuleRunner.kt`（`import cn.wanghaomiao.xpath.JXDocument`）、`nodes()` / `isXpathRule()`。注释里写清了为什么必须先切：**xpath 的 `\|` 并集不能被当成 Legado 的 `\|\|` 备选来分** |
| **`@Json:` 前缀**按 JSONPath 读列表（对齐上游同名写法） | `rules/RuleRunner.kt` 的 `isJsonPrefixedRule()` / `nodes()` |
| **`\|\|` 备选规则**（一条规则写多个候选）在 XPath 与 `@Json:` 之后才分 | `rules/RuleRunner.kt` 的 `splitLegadoBranches()`（旧名 `splitLegadoAlternatives` 已改名） |
| `{{(page-1)*20}}` 这类翻页表达式：Rhino 里所有数字都是 double，必须**去掉 `.0` 尾**再拼进网址 | `rules/RuleRunner.kt` 的 `trimJsNumberFraction()` |
| **`<js>…</js>` 与 `@js:`** 由 Rhino 沙箱执行；列表规则里带 `<js>` 时必须**先过沙箱预处理**再交给选择器 | `rules/RuleRunner.kt` 的 `jsListNodes()` / `isJsRule()` |
| 沙箱支持**顶级 `return`** 的脚本（Rhino 直接执行会 `return not in function`）：整段包进匿名函数 | `rules/JsSandbox.kt` 的 `eval()` |
| `Packages.*`、`new JavaImporter()` + `with(...)`、`importClass` / `importPackage` **按白名单提供真实可用的替身**（加解密、Base64、Hash、UUID、String/Arrays、okhttp3 等）；未列入白名单的类仍是 `undefined` | `rules/JavaPackages.kt` 的命名空间树与 `ImporterObject`；`rules/JsSandbox.kt` 的 `setClassShutter { false }` 仍是 RCE 底线，任何 Java 对象都不会穿进沙箱 |
| `java.ajaxAll` 有界并发抓取多个地址，按入参顺序返回响应对象；`cache` / `cacheFile` 按书源隔离 | `rules/JsSandbox.kt` 的 `createJavaBridge` / `createCacheBridge`；`.env` 与 `AppConfig.kt` 控制超时与缓存上限 |
| 单次书源 JS 执行有墙钟上限（默认 30s，`LEGADO_JS_TIMEOUT_MS`）：只拦失控脚本，合法规则毫秒级 | `.env.example` 尾部与 `AppConfig.kt` |
| 搜索地址读**顶层 `searchUrl`**，发现地址读**顶层 `exploreUrl`**；`ruleSearch.url` 全库皆空，**没有回退** | `source/SourceHealth.kt` 的 `probe()`（`searchUrl` / `exploreUrl` 顶层读取；空 searchUrl 单列定档，本机 5,574 个源里 652 个两者都空） |

## 4. 与上游 App 的行为差异（导入后"看着不对"通常是这几条）

| 差异 | 事实 | 影响 |
| :--- | :--- | :--- |
| **段评规则不执行** | `ruleReview` 在服务端源码里**零引用**（`grep -rn ruleReview app/src` 为空） | 那 21 条字段可以填、可以存、可以随备份走，但不会产出段评。前端表单保留它们是为了"改存不丢配置" |
| **没有 Android WebView** | 架构决定是纯 JVM + Rhino 沙箱；`webView: true` 只作为体检的**提示**参与分档（`source/SourceHealth.kt` 的 `probe()` 里 `wantsWebView`） | 需要真浏览器执行 JS 过挑战的站点（部分 SPA、带风控的站）在服务端跑不通；这类源在界面上会被判成 `needs_webview`，**不算坏** |
| **登录是五条路，不是一条** | 上游只有一个登录 WebView；这里是：填表 / 内置反向代理浏览器 / 拉起真浏览器抓取 / 粘贴 Cookie / 书签回传（`web/src/sources/SourceLoginModal.tsx`） | 书签与真浏览器抓取靠服务端 Cookie jar 按域归桶，跨域 Origin 由 `http/SourcesRoutes.kt` 的 `allowCookieSyncOrigin` 判 |
| **不设身份** | 没有账号、登录页、会话；写操作唯一的门是 `http/Guard.kt` 的 `ServerIdentity` + `isSameOriginIdentity()`（Origin 的主机**与端口**都要等于服务自己的绑定身份） | 默认只绑 `127.0.0.1`。把 `LEGADO_HOST` 改成 `0.0.0.0` 等于把整个书库交给局域网 |
| **凭据按域共享** | 一台机器一个 Cookie 罐，同域的书源共用（`cookie` 表 + `source_login_state`） | 删一条凭据会影响同域其它源，界面上必须这样说明 |
| **TTS 只有两副引擎** | 浏览器 `speechSynthesis` 与服务端 Edge-TTS 会话流（外加自定义 HTTP 参数一档）；不实现上游其它 TTS 后端 | Edge-TTS 握手要带匹配的 `Sec-MS-GEC-Version` 与 `muid` Cookie，微软改协议时改 `LEGADO_EDGE_TTS_CHROMIUM_VERSION` 免重编译 |

## 4.1 与上游的差异台账（S0 逐条收口）

| 差异 | 事实 | 影响 |
| :--- | :--- | :--- |
| **URL 分页占位 `<1,2,3>`（已对齐上游，2026-11-12）** | 上游 `model/analyzeRule/AnalyzeUrl.kt` 的 `pagePattern = <(.*)>`：组内按逗号切、越界取**最后一个**、段内空白裁掉。服务端 `rules/RuleHttp.kt` 的 `renderUrl()` → `rules/RuleUrlSupport.kt` 的 `selectPageSegments()` 逐条同语义，且与 `{{page}}`、`{{(page-1)*20}}` 共存（先替字面量与 JS 表达式，最后展开翻页段）；搜索/发现/RSS 三条链路都带页码（首页 page=1）。「这一栏能不能翻页」由 `rules/PagingRule.kt` 判定，语义照上游 `supportsPageSelection`（AST 认自由变量 `page`，绝不执行源脚本） | 按上游语义写的源（`...&page=<(1,2,3)>`）与按 `{{page}}` 写的源**都能翻页**。判据：`PagingSegmentTest`（端到端拿真实请求地址：空首段/第 N 段/越界取末/裁空白/与 `<key>`、`{{page}}` 共存/搜索逗号段/上游用例原样复算）、`PagingDetectionTest`（判定表含"不执行源脚本"安全用例）。此前本行与导入告警声称"不支持/不解析"，属文档漂移，已随 S0/C-02 撤销 |
| **RSS/Atom 无列表规则直解（已支持，2026-11-12）** | 曾把"有 `ruleArticles`"当作可列目的前提；现在 `ruleArticles` 缺失/空白时由 `rules/RssFeedParser.kt` 直解标准 feed：RSS 语义照上游 `model/rss/RssParserDefault.kt`（item 边界、title/link/pubDate，取图优先级 media:thumbnail → enclosure(image/) → description 首图 → content:encoded 首图，空标题不列），Atom entry 为**扩展**（上游默认解析器只认 RSS item；取 alternate link、published/updated、summary/content）；link/image 归一复用规则路径的 `absolute()` | 现成 RSS/Atom 订阅地址**无需写任何规则即可列目**；返回的不是 feed 才报"没有配置 ruleArticles，也不是标准 RSS/Atom feed"。判据：`RssFeedParserTest`（字段映射/取图优先级/实体解码/null 与空表之分）+ `RssSubscriptionTest`（引擎端到端：RSS/Atom/空 feed/非 feed 报错）。界面"只看能读的"筛选与徽章措辞已同步；静态 `hasListRule` 口径不变（仍表示"有显式列表规则"，默认折叠保守处理） |

## 5. 归属、许可与随包数据（"哪些内容是我们的"）

| 内容 | 归属 | 依据 |
| :--- | :--- | :--- |
| `app/`、`web/` 全部代码 | **本项目自写**。上游是**语义参照**：规则 DSL 求值口径、`checkKeyWord` 体检方式、书源字段分组 | `README.md` 末段「不是 fork，代码全部自写」；参照基准 `github.com/gedoor/legado` |
| **LICENSE = GPL-3.0-or-later** | 继承自上游规则生态的许可口径，**不是可选项**：本项目读的是 Legado 书源格式，README/package.json 的 license 字段与 LICENSE 文件三处必须同号（由 `tools/verify/opensource-hygiene-check.mjs` 核） | `LICENSE`、`package.json` |
| 随包的 **26 条 TXT 分章规则**（`app/src/main/resources/assets/txtTocRule.json`） | **来自上游默认表**（不是我们写的），逐条按 Kotlin 侧语义对齐；用户自建的规则另存、可删 | `localbook/TxtTocRule.kt`（"内置那 26 条来自上游"）、`delete()`（随包那 26 条删不掉） |
| 备份包加解密口径 | **逐字照上游** `help/storage/BackupAES.kt`：`AES/ECB/PKCS5Padding`，密钥 = 密码 MD5 的**小写十六进制串前 16 个字符**的 ASCII 字节（不是 16 字节摘要） | `backup/BackupImporter.kt` 的 `BackupAes`（`keyOf` / `decryptBase64`） |
| 打分选规则口径 | 照抄上游 `TextFile.getTocRule()`：同一份正文逐条跑、只比命中条数、"多不出 N 条就不换"；我们额外补了"开头那一章被吞成前言"的排除 | `localbook/TxtTocRule.kt` 的 `getTocRule()` / `missesFirstHeading()`（开头章节漏判） |
| `hectorqin/reader` | **不得引入任何代码**（AGPL-3.0 的网络服务条款与本项目 GPL-3.0 不等价），只作交互参考 | `README.md` 末段参照表 |
| 第三方**依赖**（不是我们写的，许可证各异，构建时按坐标拉取） | Jsoup（HTML 选择）、`com.jayway.jsonpath`（JSONPath）、`cn.wanghaomiao.xpath`（XPath）、Rhino（JS 沙箱）、Ktor 3.4 + CIO、kotlinx-serialization、SQLite JDBC、Vite / React 19 / workbox | 坐标在 `app/build.gradle` 与 `web/package.json`；界面「关于」页另列一份给人看的名单（`web/src/pages/AboutPage.tsx` 的 `THIRD_PARTY` / `REFERENCED`） |
| 第三方**运行时服务**：Edge-TTS 走微软公开合成端点 | 属于外部服务调用，**仓库不含其代码**；握手版本可用环境变量改（微软改协议时免重编译） | `LEGADO_EDGE_TTS_CHROMIUM_VERSION`（见 `.env.example` 尾部） |
| 书源内容本身 | **仓库不含任何书源与书籍内容** | 实测：跟踪文件里出现的外部站点全是 `example.com` / `src1.com` 这类占位域（`git grep -o -E "https?://…"`），跑不出结果属于预期 |

## 6. 已知的"跑不通"，说清楚而不是藏起来

1. **需要执行 JS 过挑战/风控的站点**：服务端没有真浏览器，正文与目录都可能拿不到 → 体检给 `needs_webview`（§4 第一条），不是停用的理由。
2. **`ruleReview` 类书源**：段评永远为空（§4）。
3. **依赖白名单外 Java 类的 `jsLib`**：`Packages` / `JavaImporter` 只提供声明的类，Java 反射被禁用；取不到的类表现为 `undefined`，通常是某个字段恒空而不是报错。
4. **顶层没配 `searchUrl` 的源**：只能当发现页用，界面单列「未配搜索」一档，**不计入"连不上"**，也不参与一键停用/删除（`source/SourceHealth.kt` 的 `probe()` 中 `no_search` / `explore_only` 分支、`web/src/sources/sourceGrouping.ts`）。
5. **纯前端渲染的登录页**：内置反代浏览器帮不上（表单挂在框架里、或先要过挑战），要改填表或粘 Cookie。
6. **跨书源的"同一本书"身份**：只能是书名 + 作者，章节坐标只能是标题 —— 换源时 `sourceId + bookUrl` 两个都会变。这条目前只在前端有实现与判据，服务端侧没有对应实现。

## 7. 想验证某条说法，跑这三条

```bash
# ① 某个字段服务端到底读不读
git grep -rn "<字段名>" app/src/main/kotlin | wc -l
# ② 体检档位是怎么定的（不发请求就定档的那一段）
grep -n "explore_only\|no_search" app/src/main/kotlin/io/legado/source/SourceHealth.kt
# ③ 前端判据（本文每条差异都有对应测试）
npx tsx web/test/run-all.ts
```

# 14 · 规则兼容性矩阵（Phase 0.5 审计）

> 审计对象：`E:\legadoQ-archive\`（**只读**）。所有 `文件:行号` 均相对该根目录。
> 目的：判断重建时**哪些规则语义有测试兜底、哪些是盲区**。价值不在列测试名，在**断言强度**。
> 标注：`confirmed`（读到断言体）/ `likely`（读到部分证据，推断）/ `needs-runtime-test`（未验证）。
> 纪律：未整篇读 `RuleRunnerTest.kt`（1439 行），仅 grep + 窗口。

## 审计元信息（结论速览）

- 测试文件总量：`product/app/src/test/kotlin/io/legado/*.kt` 共 **124 个文件 / 22,487 行**（`wc -l` 实测）。
- 本轮实读 **≈1,737 行**（整读 11 文件 885 行 + 定向窗口 10 段 673 行 + golden fixture 全 179 行）= 全部测试代码的 **7.7%**、规则相关子集的 **≈30%**。
- `RuleRunnerTest.kt` 只读窗口 **673 / 1,439 行（47%）**，**从未整篇读取**（上一轮崩溃的直接原因）。
- 核心结论：**断言本身普遍很强（44 强 / 19 中），真正的风险是"覆盖面"与"golden 名不副实"**——全库没有任何逐字符正文比对，`content-css` 没有 `expected.json`，`login-v1-js/expected.json` 有两枚死键。

---

## 1. golden 样本清单

位置：`product/app/src/test/resources/rule-golden/`。唯一消费者是 **`GoldenRuleTest.kt`**（250 行，6 个 `@Test`，与 6 个目录一一对应）。
该类的自述口径（`GoldenRuleTest.kt:38`）：`expected.json` 是**人工确认**的期望值，不是录制当前输出；有 bug 时放 `knownBug.md` 且不进断言；改引擎后该类必须先绿才允许提交。

**总体断言形态（confirmed）**：全部是 **按字段语义等价**（`assertEquals` 逐字段），**没有任何逐字节比对**。所谓"逐字节守门"（AGENTS.md 的措辞）在实现上是**逐字段 equals**，粒度到"书名/作者/地址/章节标题/章节 url"级别，**不断言字段顺序、不接受多余字段**（只取 expected 里出现的键）。

| 目录 | 文件（`wc -l`） | 输入（`source.json` 关键字段） | 期望（`expected.json` 结构） | 断言粒度 | 消费方（测试类:行号） |
|---|---|---|---|---|---|
| `search-css` | `source.json`(12) · `page.html`(21) · `expected.json`(20) | `searchUrl: https://golden.example/search?q={{key}}`；`ruleSearch.bookList: div.result`；`name/author/bookUrl` = `h3.title@text` / `span.author@text` / `a.detail@href` | `{count:3, items:[{name,author,bookUrl}×3]}` | **强**：条数 + 每条 3 字段 equals；另加两条结构断言——"搜索只请求一次"、"URL 以 `https://golden.example/search?q=` 开头"（`GoldenRuleTest.kt:60-63`）。**未断言 q 参数的 URL-encode 结果**（只 `startsWith` 到 `q=` 为止） | `GoldenRuleTest.kt:49`(`search CSS 列表与字段提取与金标准一致`) |
| `details-toc-json` | `source.json`(15) · `book.json`(7) · `toc.json`(6) · `expected.json`(9) | `ruleBookInfo.name/author/tocUrl` = `$.book.name`/`$.book.author`/`$.book.tocUrl`；`ruleToc.chapterList: $.chapters`，`chapterName: $.title`，`chapterUrl: $.url` | `{name, author, tocUrl, chapters:[{title,url}×2]}` | **强**：详情 3 字段 + 章数 + 每章 2 字段 equals。`RuleRunner` 的 `details()`/`chapters()` 分开断言；用 `routes` map，**未预期请求直接 `error()`**（`GoldenRuleTest.kt:88`）→ 顺带锁死"不应多发请求" | `GoldenRuleTest.kt:80`(`details 与 toc 的 JSON 规则与金标准一致`) |
| `content-css` | `source.json`(8) · `page.html`(11) · **无 expected.json** | `ruleContent.content: div#content@text`；页面 3 个 `<p>` | 无 fixture 期望；期望值**硬编码在测试里** | **中→弱**：只断言正文 `contains("第一段正文"/"第二段正文"/"第三段正文")` + `!contains("<p>")`（`GoldenRuleTest.kt:115-117`）。**不比对完整正文、不断言换行/拼接方式、不断言段落顺序**——"段落顺序错乱"或"多出广告段落"都能通过 | `GoldenRuleTest.kt:106`(`content CSS 正文提取不丢段落`) |
| `rss-articles` | `source.json`(8) · `page.html`(16) · **无 expected.json** | `ruleArticles: div.article`；`ruleTitle: h2@text`；`ruleLink: a@href`；`rulePubDate: span.date@text` | 无 fixture；期望值硬编码 2 篇 × (title, link, pubDate) | **强（但散在测试里）**：`assertEquals` 逐字段 6 条 + 条数（`GoldenRuleTest.kt:129-135`）。**未断言 RSS 的 guid/description/封面** | `GoldenRuleTest.kt:121`(`rss 列表与字段提取与金标准一致`) |
| `login-v1-js` | `source.json`(7) · `expected.json`(12) | `loginUrl` = 整段 `function login(isVip){...}` JS（`java.toast` / `java.upLoginData`）；`loginUi` = JSON 字符串 2 行 | `{isScript, canOpenBrowser, uiVersion:1, ui:[…], successToast, successLoginInfo:{role:vip}, failureToast}` | **强**：`uiVersion`、表单行(name/type/action)、成功 toast、`upLoginData` 落库键值、失败路径 toast + "失败时保留用户输入"（`GoldenRuleTest.kt:208`）。**注意：`expected.json` 里的 `isScript`/`canOpenBrowser` 两个键测试并未读取 → 是死键**（v1 用例只 `assertTrue(runner.loginIsScript(...))` 硬编码 true） | `GoldenRuleTest.kt:208`(`login v1 的静态表单与动作脚本与金标准一致`) |
| `login-v2-js` | `source.json`(8) · `expected.json`(19) | `loginUi: {"version":2}`；`loginCheckJs` = 表达式；`loginUrl` = `login(openBrowser,checkMode)` + `loginUi(state)` + `loginAction(action,state,form)` | `{isScript, canOpenBrowser, browserStartUrl, uiVersion:2, firstScreen[2], secondScreen[2], errorPhone, errorCode, loginInfo:{token,phone}, unknownKeys:["note"], checkLoggedIn:true}` | **最强**（全库最好的一个）：两屏行级字段、必填校验错误**挂到字段上**（`missing.error["phone"]`）且 `state==null`（不换屏）、验证码错误、提交成功后 `ok/close/updatedLoginInfo`、**未知命令只回报不执行**（`unknownKeys`）、`loginCheckJs` 试判。另加"登录链路不应发起任何请求"（`RuleRunner { url -> error(...) }`，`GoldenRuleTest.kt:142`） | `GoldenRuleTest.kt:139`(`login v2 的两屏表单与命令与金标准一致`) |

**六类样本的共同盲点（confirmed）**：全部只用 **CSS / JSONPath** 两种选择器方言 + **v1/v2 登录 JS**。**没有任何 golden 覆盖 XPath、正则列表、`@put/@get`、`@@`、分页翻页、请求头、Cookie。**（详见 §4）


---

## 2. 兼容性矩阵（核心表）

约定：行号指 `@Test`/`fun` 声明行。"断言强度"按**断言体能钉死多少自由度**分级（定义见 §3）。
`RuleRunnerTest`（1439 行 / 66 个 `@Test` / 224 条 assert）是主载体；以下凡写 `RRT` 即 `product/app/src/test/kotlin/io/legado/RuleRunnerTest.kt`，`GRT` 即 `GoldenRuleTest.kt`，`SLT` 即 `SourceLoginTest.kt`。

| 能力维度 | 测试文件:行号 | 用例名 | 输入 | 断言内容（简述断言体） | 断言强度 | 缺口 |
|---|---|---|---|---|---|---|
| **CSS** | `GRT:49` | `search CSS 列表与字段提取与金标准一致` | fixture `rule-golden/search-css`（3 条 `div.result`）+ `q={{key}}` | 条数=3；逐条 name/author/bookUrl `assertEquals`；请求数=1；URL `startsWith("…/search?q=")` | **强** | 只 `startsWith` 到 `q=`，**未断言 `{{key}}` 的 URL-encode 结果** |
| CSS | `RRT:529` | `declarative … CSS selectors` | `@css:` 前缀全套（`init`/`name`/`intro`/`tocUrl`/`chapterList`/`content@html`） | 详情 4 字段、章数=2、章标题+url、content.title、`contains(正文)`、`!contains("<p>")` | **中** | 正文只查包含 + 无标签；不比对整段正文 |
| CSS | `RuleRunnerExtendedTest.kt:10` | `css selector translation for class and tag ordinals and negations` | 选择器方言（序号、`:not`） | 规则→选择器翻译后取值（逐值 equals） | **中** | 只覆盖翻译层，未接真实页面 |
| CSS | `RRT:939` / `RRT:956` | `html value mode returns outer html…` / `…on a text container` | `#cp_img@img@html`、`#content@html`（含广告 div） | 图片占位逐条 `contains("![图片](绝对地址)")`；广告文字 `assertFalse` | **中** | 断言"含/不含"，非全文等值 |
| **XPath** | `RRT:569` | `declarative details chapters and content parse HTML with XPath selectors` | `@xpath:` 全套（`text()`/`/@href`/`.//a/text()`） | 详情 4 字段 equals、章数=2、章标题/url equals、content.title equals、`contains(正文)` | **中** | **无 golden fixture**；正文无 `!contains("<p>")`、无广告剔除断言；**未测 `@xpath:` 命名空间/`//text()` 多结果拼接** |
| XPath | `RRT:607` | `bare XPath rules without prefix are auto-detected like the original` | 裸 `//ul[@class="nums"]/li` + 字段 `@xpath:` | 条数=2、`[0].name`、`[0].bookUrl`、`[1].author` | **强**（窄） | 只 1 个形状；未测裸 XPath 在**目录/正文**上下文（只在 search） |
| **JSONPath** | `GRT:80` | `details 与 toc 的 JSON 规则与金标准一致` | `$.book.name/author/tocUrl`、`$.chapters`、字段 `$.title`/`$.url`，fixture `details-toc-json` | 详情 3 字段 equals、章数、每章 2 字段 equals；未预期 URL 直接 `error()` | **强** | 无过滤谓词、无 `$..` 递归、无 `[*]` |
| JSONPath | `RRT:59` | `executes JSON source with relative URLs and JSONPath templates` | `{{$.book_id}}` 字符串内模板 + 相对 URL 绝对化，4 个端点 | bookUrl/tocUrl/chapter.url 绝对化 equals、正文 equals | **强** | 只 1 本书 1 章 |
| JSONPath | `RRT:87` | `json-prefixed rules are stripped and evaluated as JSONPath` | `@JSON:$.data` 前缀（大小写不敏感） | 条数=2、`[0].name`、`[0].bookUrl`（`id`→绝对 URL） | **中** | 未断言 `author` 与 `[1]` 全部字段 |
| JSONPath | `RRT:785` | `supports && branches and … without breaking jsonpath filters` | `$.books[?(@.price<10 && @.cat=="x")]` | 过滤谓词未被 `&&` 切分：`single().name == "便宜的"` | **强** | 只 1 个谓词形状（无 `||`、无嵌套括号） |
| JSONPath | `BareJsonListRuleTest.kt:20` | `JSON 对象上的裸键列表补成 jsonpath`（+4 例） | `{"list":[…]}`, 规则 `list` | `bareJsonListPath` 返回值 equals / null；HTML、`<js>`、`@json:`、`.view_tit` 均不误判 | **强**（单元级） | 只测判断函数，**未接 RuleRunner 端到端**（搜索 0 条那条修复没端到端判据） |
| **JS 求值** | `RRT:1015` | `evaluates inline JavaScript and expressions embedded in rule templates` | `{{java.timeFormat(...)}}`、`{{$.create_time##T|\+.*## }}`、尾部 `@js:` 换 `__status__` | intro 4 条：`contains("开坑：2023-11-01 00:00:00")`、`contains("完结")`、`contains("2023-11-1")`、`assertFalse(contains("@js:"))` | **中** | **全是 `contains`，无整串 equals**：多一个字符/顺序错都能过 |
| JS 求值 | `RRT:991` | `supports Legado rule dialects used by aggregate JSON sources` | `<js>…</js>` + `\n$.data.*`、`$..a\|\|$..b`、裸键 `author`、`{{(page-1)*20}}` | **在 fetcher 里 `assertEquals` 完整 URL**（含 URL-encode）→ 表达式求值被强钉；结果 3 字段 equals | **强** | 只有 1 个聚合源形状 |
| JS 求值 | `RRT:1210` / `RRT:1272` | `文档级 @js 规则的 result 是响应正文原文` / `脚本失败时不拿整页正文冒充取值` | 文档级 `@js:` 整条 | 前者断言 result 语义（取值 equals）；后者断言失败时**不返回整页原文** | **中→强** | 见 `RRT:1272` 窗口仅 grep，未逐条读断言体（`likely`） |
| JS 求值 | `RRT:357` | `纯 js 段的规则脚本失败时不返回整页原文` | 失败脚本 | 断言不落回整页原文 | **中** | 失败**分类**（抛 `RuleExecutionException` vs 静默空）未断言 |
| JS 求值 | `RuleRunnerAdvancedFeaturesTest.kt:15` / `:179` | `evaluates inline JS with java base64Decode…` / `sandboxed JS environment blocks reflection…` | `java.base64Decode`、反射逃逸尝试 | 取值 equals / 抛错 | **强** | 沙箱安全面另有独立文件（见 §6 索引） |
| **正则** | `RRT:197` | `冒号起头的目录规则按 AllInOne 正则取章节` | `:a href="(.*?)"\s+target="_blank">(.*?)<` + `$1`/`$2` | 章数=2、两章 title+url equals（4 条） | **强** | 只 1 条真实源形状；**无 golden fixture** |
| 正则 | `RRT:222` | `正则列表里的 && 是多级正则而不是并集` | `:正文卷[\s\S]*?/ul&&href="([^"]+)">([^<]+)`，页面**带广告块** | 标题 list equals；`[0].url` equals；`assertFalse(any{contains("广告")})` | **强** | 只两级；无三级/`||` 混合 |
| 正则 | `RRT:243` | `正则条目的字段规则支持分组拼接与 @js 收尾` | `$3!$2@js:result.replace(...)`、URL 里拼 `$1` | 章数、两章 title（含 🔒 映射）、两章 url equals | **强** | 未覆盖 `##` 与 `@js:` 同时出现的组合（在 `RRT:264` 单独测） |
| 正则 | `RRT:264` | `正则条目的字段规则支持井号替换与 js 段` | `$1##正文(_)`、`$2<js>…</js>` | 两章 title + `[0].url` equals | **强** | `[1].url` 未断言 |
| 正则 | `RRT:282` | `搜索的冒号列表规则同样按正则取条目` | search `bookList: :href="…" title="…">…` | `single()` 后 name/author/bookUrl equals | **强** | 只 1 条结果（条数=1 与"漏条"不可区分） |
| 正则 | `RRT:300` | `写坏的正则列表规则如实报错而不是静默 0 条` | 坏正则 | 断言 **抛错** 而非 0 条 | **强** | 错误文案未断言 |
| 正则 | `RuleRunnerAdvancedFeaturesTest.kt:44` / `:93` / `:115` | `applies regex replacement in rule fields…` / `double-hash replaceRegex field shapes` / `strip ads end to end` | `##正则##替换`、`###` 段形态 | 字段值 equals；`strip ads` 端到端断言广告文字消失 | **强** | 仅几条真实形状 |
| **变量传递（`@put`/`@get`/`{{}}`）** | `RRT:837` | `stores every key of a multi-key put rule` | `@put:{cid:$.cid,au:$.author,ty:$.type}` + `{{cid}}`/`@get:{au}`/`@get:{ty}` | tocUrl **整串 equals** `https://putmulti.example/777/某作者/comic/index.html` | **强** | 只详情→toc 一跳 |
| 变量传递 | `RRT:1044` | `搜索时 @put 的变量能活到详情与目录，字面量 URL 规则不当选择器` | search `@put` → details → toc | 变量活到后两阶段；字面量 URL 不被当选择器 | **强** | 断言体在 1044–1073 窗口，本轮仅按 grep 与同类对照判（`likely`） |
| 变量传递 | `RuleVariableHandoffTest.kt:49` | `详情阶段 put 的变量在目录阶段能 get 到`（+1 例不回归） | `name:$.name@put:{cid:$.id}` → `chapterUrl:…cid=@get:{cid}&path={{$.url}}` | 章数=1；url `contains("cid=100")` 且 `contains("path=/c1")` | **中** | **`contains` 而非整串 equals**（对比 `RRT:837` 的 equals，这里弱一档） |
| 变量传递 | `PutPairsTest.kt:15` | `parses bare-key multi pairs`(+4 例) | 4 种 `@put` 体形状（裸键/引号跨行/严格 JSON/值内含逗号冒号） | `putPairs(...)` 返回值 **list equals** | **强**（单元级） | 只测切分函数，不含求值 |
| 变量传递 | `RuleUrlScriptsTest.kt:112` | `远端搜索脚本自取登录地址时裸 put 把默认变量写回` | 远端 JS 脚本内裸 `put` | 变量写回语义 | **中** | 本轮仅读用例名（`likely`） |
| 变量传递 | `RRT:415` | `@@ marks inside {{}} templates are stripped before evaluation` | `@@` 在 `{{}}` 内 | 剥除后求值结果 | **中** | `likely`：仅按用例名 + 注释，未读断言体 |
| **分页** | `RRT:854` | `follows nextTocUrl and nextContentUrl and stops on loops` | `nextTocUrl:a.next@href` 两页**互指成环** + `nextContentUrl` 两屏 | 章标题 list equals `[一章,二章,三章]`；**章 index list equals `[0,1,2]`**；正文含第一屏/第二屏；非法 URL 抛 `AssertionError` | **强** | 无"翻页 100 页上限"、无页码变量递增跨页断言 |
| 分页 | `RRT:1184` | `nextTocUrl 返回 JSON 数组时逐页爬取` | `@js:` 产出 `["p=2","p=3"]` 数组 | 章标题 list equals `[一,二,三]` | **强** | 同上 |
| 分页 | `RRT:1239` | `一次给多个入口页时不再从这些页继续翻页` | 多入口页 | 不再从入口页续爬 | **中** | `likely`：未读断言体 |
| 分页 | `PagingDetectionTest.kt:23/38/48/58/64` | 5 例（认/不认/不执行/反向对照/栏目旗标） | `{{page}}`、`{{(page-1)*20}}`、`<1,2,3>`、属性访问 `book.page`、形参遮蔽、字符串内 `page` | 23 条 `assertTrue`/`assertFalse` **逐规则**；反向对照成对断言；栏目 `supportsPaging` list equals `[true,false,true]` | **强** | 判据层，不含真实站点 |
| 分页 | `PagingSegmentTest.kt:35/40/46/53/60/66/79` | 7 例（段索引、越界取末段、逗号段复算、key/page 回归、search 带页码） | `<1,2,3>`、`<,index_{{page}}.html>`、逗号段 | 段取值 equals（含"上游判据原样复算"） | **强** | — |
| **请求头继承** | `SLT:647` | `stored cookie is looked up by the host actually being requested` | 库内 cookie（域 = `api.readsite.com`）+ 源 id 另一域 | `headers["Cookie"]` **整串 equals** | **强** | — |
| 请求头继承 | `SLT:660` | `login header and jar cookie merge per key instead of overwriting each other` | `saveSourceLoginHeader` `{Authorization, Cookie:"legacy=1; token=old"}` + 库 cookie | `Authorization` equals；`Cookie` **整串 equals** `legacy=1; token=abc; uid=42`（同名覆盖、异名都留） | **强** | 只 1 组键 |
| 请求头继承 | `SLT:676` | `url option cookie outranks stored cookie but keeps the other keys` | url option `Cookie: token=tmp` + 库 `token=abc; uid=42` | `Cookie` equals `token=tmp; uid=42`（**不挪位置**）；`Referer` equals | **强** | — |
| 请求头继承 | `SLT:692` | `request without a source still carries its own headers and nothing invented` | 无源、只有 `User-Agent` | **整张 header map equals** `{User-Agent: Legado}` → 顺带钉死"不凭空造头" | **强** | — |
| 请求头继承 | `RRT:1147` / `RRT:1166` | `POST body 长得像 JSON 时自动补 Content-Type` / `显式 Content-Type 不被覆盖` | `,{"method":"post","body":{…}}` 与表单体 | `Content-Type` 精确 equals（含 `; charset=UTF-8`）；显式头不被覆盖；表单体 `assertNull` | **强** | 未覆盖 `Accept`/`UA` 从源级继承到**子请求**（`init`/翻页页） |
| 请求头继承 | `RuleUrlScriptsTest.kt:174` | `书源请求头里的中文会被编码而不是让请求直接失败` | 源头含中文 | 编码后不抛 | **中** | `likely`（未读断言体） |
| 请求头继承 | `ProxyHeadersTest.kt:20/32/44/52` | 4 例（本域 cookie / 跨域不传凭据 / Referer 跨跳保留 / Range + 空 cookie） | 代理资源请求 | 逐 header **equals/assertFalse**；`User-Agent` equals `legadoQ/0.1` | **强** | 只测代理路，不测规则引擎的 `effectiveHeaders` 全路径 |
| **Cookie 传递** | `CookieLayersTest.kt` 15 例（`:53`…`:237`） | 会话层 vs 持久层、Max-Age/Expires 解析、4096 上限留 2 条、按域取凭据、www/m 同桶 | 各层 cookie 形态 | 逐例 assertEquals / assertTrue（含"最旧那条如实报出"） | **强** | 纯存储层，不含"何时把 cookie 塞进请求" |
| Cookie 传递 | `SLT:741` | `cookie captured for the login domain is sent to that domain even though the source lives elsewhere` | 登录域 ≠ 源域 | 断言 cookie 仍发到登录域 | **强** | `likely`：按名 + 同类对照；未逐字读断言体 |
| Cookie 传递 | `SLT:886` | `sandbox cookie bridges cannot read a domain absent from the source config` | 沙箱越域读 cookie | 断言**读不到**（安全边界） | **强** | — |
| Cookie 传递 | `JsResponseCookieTest.kt:47/63/73/82/88` | 5 例（按名取值剥属性、整表同名后者胜、无名单/不存在名字、空表不报错、重定向各跳 Set-Cookie 合并） | 响应 Set-Cookie / 重定向链 | 逐值 equals / undefined | **强** | 未接"响应 cookie → 下一条规则请求"的端到端 |
| Cookie 传递 | `SLT:597` | `Database parseCookieString handles all major cookie formats` | 各种 cookie 串格式 | 解析结果 equals | **强** | — |
| **错误处理与分类** | `RuleFailureClassifyTest.kt:20` | `内网地址被拒要说清是拒绝，不是连不上`（+2 例） | `BlockedAddressException` / `RuleExecutionException("…HTTP 403…")` / `RuntimeException("SQLITE_BUSY: select * …")` | status=502；消息 `contains("拒绝")`/`contains("403")`；`leaked` 布尔；**内部消息不含 `select`** 且换成含"日志"的人话 | **强** | 只有 3 个分类；未断言响应体**结构**（如 error code 字段名） |
| 错误处理 | `SandboxErrorScopeTest.kt:22` / `:38` | `上一个书源的脚本错误不会算到这一次头上` / `空响应的搜索给出 0 字节提示…` | 先制造 `JSON.parse` 失败再切上下文；空响应 `""` | 前置 `assertNotNull`；切上下文后 `assertNull`（两次）；空响应抛错且消息含"0 字节"、**不含** `json string can not be null or empty` | **强** | 只 2 个串扰场景；并发多线程未真跑 |
| 错误处理 | `RRT:721` / `RRT:739` | `handles malformed source configuration gracefully with RuleExecutionException` / `handles empty search response and empty chapter list cleanly` | 坏配置 / 空响应 / 空章表 | 异常类型 与"空即空"（`likely`：未读断言体） | **中** | 只断言"抛/不抛"，分类未细化 |
| **登录（v1）** | `GRT:208` | `login v1 的静态表单与动作脚本与金标准一致` | fixture `login-v1-js`：整段 `function login(isVip)` + `loginUi` 数组 | `loginIsScript`；`uiVersion`=1；表单行 name/type/action equals；成功 toast equals；`upLoginData` 键值 equals；失败 toast + **失败保留用户输入** | **强** | **`expected.json` 的 `isScript`/`canOpenBrowser` 是死键（测试不读）**；无 `java.getLoginInfoMap` 多字段断言 |
| 登录（v1） | `SLT:124` / `:174` / `:284` / `:378` | 静态+动态 `loginUi` 解析、JS 桥动作、`data:` 页内联表单回填、无 `login` 函数的中文错误 | 各形态 | 逐字段 equals / 中文文案 `contains` | **强** | 依赖真实 DB 临时文件（慢但不弱） |
| **登录（v2）** | `GRT:139` | `login v2 的两屏表单与命令与金标准一致` | fixture `login-v2-js`：`loginUrl`（`startBrowserAwait`）+ `loginUi(state)` + `loginAction` + `loginCheckJs` | 两屏行级字段 equals；必填错误**挂字段** `error["phone"]` 且 `state==null`；验证码错误 `error["code"]`；成功 `ok`/`close`/`updatedLoginInfo` 逐键 equals；`unknownKeys` list equals；`checkLoggedIn`；**"登录链路不应发起任何请求"** | **强（全库最强）** | 只 1 条多屏流程（2 屏）；无 3 屏以上/回退屏/倒计时真实递减 |
| 登录（v2） | `SLT:219` / `:264` / `:508` / `:540` | v2 渲染+命令、坏行拒收（不给半张表单）、v2 动作回内联页、v2 HTTP 端点暴露 render/action | 各形态 | 逐字段 equals；`testApplication` 端到端 | **强** | — |
| 登录（入口判定） | `RuleLoginGuardTest.kt:30/43/50` | `loginUiVersion distinguishes v1 v2 and malformed`（含 `version:3`、坏 JSON）+ 空 `loginUi` + 无 `loginCheckJs` 三态 | 各 `loginUi` 串 | 逐例 equals（1/1/2/1/1）；`hasCredential`/`verified` 布尔 | **强**（防止抽 `RuleLogin.kt` 时改坏） | 只纯逻辑分支 |
| **RSS 直解** | `RssFeedParserTest.kt:38` | `RSS 条目按上游优先级取图，实体解码，空标题不列`（+4 例） | 5 个 item 的 RSS（`media:thumbnail`/`enclosure`/`description` 首图/`content:encoded`/空标题/无标题）+ Atom | 条数=3；title/link/pubDate/image **逐项 equals**；`none{link==/post/4\|/post/5}`；`origin` equals；非 feed 返回 null；空 channel 空表非 null | **强** | **不测** 链接/图片绝对化（自述在 `RssFeedParserTest.kt:16-18`，交由 `RssSubscriptionTest`） |
| RSS 直解 | `GRT:121` | `rss 列表与字段提取与金标准一致` | fixture `rss-articles`（CSS 规则列表，非 XML 直解） | 条数=2 + 6 字段 equals | **强** | 无 `expected.json`（期望值硬编码在测试里，改名/加字段不落 fixture） |
| **TXT 分章** | `TxtTocRuleTest.kt` 17 例（`:39`…`:394`） | 随包规则表形状、`suggest` 真能切、首章不被吃、备份表按文案采纳、序章/尾部保留、无标题回落、内置键不查表、未知 id 拒收、停用规则可手选、开关落盘、坏正则进不来、全角缩进、Unicode 旗标、自建规则入打分、随包 26 条删不掉 | 真实书名纯文本 + 规则表 | 多为 `assertEquals`/`assertTrue`（含"落盘"实测）+ 负例 | **强** | 全为**规则选择/管理**；未断言 `splitting` 产物在阅读器里的章节 id/顺序端到端（`likely`：未逐例读） |
| **内容净化** | `RRT:891` | `keeps content images as proxyable placeholders…` | `src` / `data-src` 懒加载 / `data:` 内联图 | `contains("![图片](https://img.example/p/1.png)")`、`contains(懒加载绝对化)`、`assertFalse(contains("data:image"))`、两段文字都在 | **中→强** | 断言是"含/不含"，正文整段形态未钉 |
| 内容净化 | `RRT:913` / `RRT:973` | div 单元包图不被 `DIV_BLOCK` 连壳吞掉 / 嵌套 div 半截块 | 漫画页形态 | 图占位 `contains`；**广告文字 `assertFalse` 照旧丢弃**（明确取舍） | **中** | — |
| 内容净化 | `RRT:956` | `html value mode on a text container still keeps paragraphs and drops ad divs` | `#content@html` + 内层广告 div | 两段 `contains` + 广告 `assertFalse` | **中** | 只脱壳语义 |
| 内容净化 | `RRT:1306` | `img 里的 Legado 图片选项（地址,{headers}）不留在正文里` | `,{headers}` 选项形态 | 断言选项文本不残留 | **中** | `likely`（未读断言体） |
| 内容净化 | `RuleRunnerExtendedTest.kt:63` | `content fallback when extracted text is short but paragraph tags exist` | 短文本+`<p>` | 回落生效 | **中** | 阈值边界未逐值测（`likely`） |
| **图片解密** | `ImageDecodeTest.kt:29/37/43/49` | 4 例：纯 Base64 还原原字节 / `data:` 前缀剥掉 / 空串与非法 Base64 → null / 图片头判定 | `byteArray` + Base64 串 | `assertArrayEquals(png, …)` **逐字节**；`assertNull`；`looksLikeImage` 正负各 3 | **强（但只在 helper 层）** | **类注释自认边界**（`ImageDecodeTest.kt:17-20`）："这一层不跑 JS，跑 JS 的部分在 `RuleRunner.imageDecoder` 里"。**`imageDecoder`/`imageDecode` 规则端到端零覆盖** |


---

## 3. 断言强度分布

### 3.1 分级口径（先说清，否则数字没意义）

| 级别 | 定义 | 典型形态 |
|---|---|---|
| **强** | 钉死"值本身"：`assertEquals(期望, 实际)`，或成对正反断言（`assertTrue` + 同一规则改成 `assertFalse`），或整张 map / 整条 URL / list 的等值 | 整串 URL equals、`listOf(...)` equals、header map equals |
| **中** | 钉死"包含/不含/不抛"：`contains(...)`、`!contains(...)`、`assertNotNull`、只断言条数 | `content.contains("第一段正文")` |
| **弱** | 只断言"跑通了/非空/没崩"，对输出形态无约束 | `assertNotNull(result)`、`assertTrue(chapters.isNotEmpty())` |
| **仅存在性** | 测试只是为了"覆盖到这行代码"，断言恒真或只测方法能调 | `assertEquals(1,1)`；或 fixture 里的键从未被读取 |

### 3.2 分布（按 §2 的 63 行计）

| 级别 | 行数 | 占比 |
|---|---|---|
| 强 | **44** | 70% |
| 中 | **19** | 30% |
| 弱 | **0** | 0% |
| 仅存在性 | **0**（矩阵行内） | 0% |

**这个分布看起来很好，但它是"有测试的地方强"，不是"规则语义被覆盖"。** 两个反直觉结论必须先说：

1. **矩阵行没有弱断言，是因为弱断言不在这 63 行里——它们在 golden fixture 层。** 六个 golden 样本中：`content-css` 的断言是"含三段文字 + 无 `<p>`"（`GoldenRuleTest.kt:115-117`，**中**）；`rss-articles` 没有 `expected.json`，期望值硬编码在测试体（`GoldenRuleTest.kt:129-135`，强但改 fixture 不生效）。**"golden"这个词在 6 个目录里只有 4 个名副其实。**
2. **有 9 行的判级来自"用例名 + 注释"，不是断言体**——这是我这轮审计自己最大的不确定源，逐条列出（标注 `likely`）：
 `RRT:1044`、`RRT:415`、`RRT:1239`、`RuleUrlScriptsTest.kt:112`、`RuleUrlScriptsTest.kt:174`、`SLT:741`、`RRT:721/739`、`RRT:1306`、`RuleRunnerExtendedTest.kt:63`。若这 9 行实为弱断言，强/中的真实比会是 **35 / 28**。

### 3.3 哪些维度只有"能跑通/非空"级弱断言

严格说：**没有任何一个维度停留在"仅存在性"**，但以下维度的**关键子能力**只有"含/不含"级：

| 维度 | 弱在哪里（证据） | 后果 |
|---|---|---|
| **JS 求值** | `RRT:1015` 用 4 条 `contains` 断言一段复合模板（`{{java.timeFormat}}` + `##正则##` + 尾部 `@js:` 替换 `__status__`）（`RRT:1015` 用例体内）。**整串 intro 从未 equals** | `intro` 多一个空格、段落顺序变化、`@js:` 结果尾巴多一段 —— 全部通过 |
| **内容净化** | `RRT:891/913/956/973` 全部是 `contains("![图片](…)")` + `assertFalse(contains(广告词))` | 清洗后正文的空行数、段落合并方式、图片占位行位置全部不受约束 |
| **XPath** | `RRT:569` 正文侧只有 `contains("草庙村是一个宁静的小村庄")`；**连 CSS 那条用例里有的 `!contains("<p>")` 都没有** | XPath 正文路径即使残留 HTML 标签也测不出来 |
| **图片解密** | `ImageDecodeTest` 4 例在 `ImageDecode.parse`/`looksLikeImage` 上是**逐字节** `assertArrayEquals`（强），但走 JS 的 `RuleRunner.imageDecoder` **零用例** | 规则链路上"解密出来的字节 → 当图片用"没有任何判据 |
| **请求头继承** | `RRT:1147/1166` 只测 POST 的 `Content-Type` 补/不补；**"源级 `header` 是否继承到 `init` 页与翻页页"无断言** | 改 `effectiveHeaders` 的继承范围（比如不再把源 header 带给子请求）现有测试全绿 |
| **错误处理** | `RRT:721/739` 只判"抛了 `RuleExecutionException`"/"空即空"（`likely`） | 异常**分类**（哪类错误归 502 的哪个分支）只有 `RuleFailureClassifyTest` 覆盖的 3 个入口 |


---

## 4. 缺口清单

### 4.0 先核实负责人给的 5 条线索（结论有 1 条被推翻）

| 线索 | 核实结论 | 证据 |
|---|---|---|
| 纯 XPath 无 fixture | **成立** | `rule-golden/` 六目录无 XPath；XPath 只有 `RRT:569`、`RRT:607` 两条用例，HTML 是**内联字符串**，`@xpath:` 形状各 1 套 |
| JS 列表规则无 golden | **成立** | 六目录 `source.json` 无一条含 `<js>`/`@js:`；JS 列表只在 `RRT:336`、`RRT:491`、`RRT:991` 内联 |
| 正则列表（`:` 前缀 AllInOne）无 golden | **成立** | `RRT:197`、`RRT:222`、`RRT:243`、`RRT:264`、`RRT:282`、`RRT:300` 共 6 条用例，断言其实**很强**（`listOf` equals），但每个都是**一条真实源的单形状**，且无 fixture 目录 |
| 多页目录翻页未确认 | **推翻——已测，且断言强** | `RRT:854`（`nextTocUrl` 两页**互指成环** + `chapters.map{index}` equals `[0,1,2]` + 正文两屏）；`RRT:1184`（`@js:` 产出 JSON 数组逐页）；判据层 `PagingDetectionTest`(5 例) + `PagingSegmentTest`(7 例)。**真实缺口不是"没测"，而是"单页数/上限/并发"没测**（见 §4.1-#6） |
| 图片解密只有单测 | **成立，且比线索更严重** | `ImageDecodeTest.kt:17-20` 类注释自认："这一层不跑 JS —— 跑 JS 的部分在 `RuleRunner.imageDecoder` 里"。4 例全部打在 `ImageDecode.parse`/`looksLikeImage` 上 |

### 4.1 缺口清单（按危险度排序）

| # | 能力 | 为什么判断没保护（证据） | 重建时改了不会被发现的后果 | 建议补的测试输入 |
|---|---|---|---|---|
| 1 | **全文逐字节/逐字符比对根本不存在** | `GoldenRuleTest` 全 6 例均为**逐字段** `assertEquals`；`content-css` 只有 `contains` + `!contains("<p>")`（`GoldenRuleTest.kt:115-117`）。而 AGENTS.md §7 与 CLAUDE.md 都把它称作"**逐字节守门**" | 正文的**换行、空行、段落拼接符、图片占位行位置、首尾空白**全部不受约束。重建时若把 `\n\n` 改成 `\n`，现有 golden 全绿，但每个已缓存章节的正文都会变、读者落点（`logicalPosition`）会漂 | `expected.txt`（整段正文逐字符比对）替代 `contains`；至少对 `content-css` 与一个漫画源各一份 |
| 2 | **XPath 全链路** | 无 fixture；`RRT:569` 一套形状；正文侧无残留标签断言；`RRT:607` 只测 search 裸前缀 | 把 XPath 求值换成"XPath→CSS 翻译"或换 XPath 实现版本，可能出现**多节点拼接顺序变化、`text()` 空白归一化差异、属性节点取值差异**，测试不响。真实书源里裸 `//` 规则量级不小（`RRT:607` 注释："大量真实书源的 bookList/字段就是这么写的"） | ① 同页同时含"单节点文本"与"多节点文本拼接"的 XPath；② `//div/text()` 多文本节点；③ `@xpath:` 与裸 `//` 混写；④ 属性 `@href`/`@src` 取值 |
| 3 | **JS 列表规则** | 无 golden；`RRT:336`（js 列表带目录前缀）、`RRT:491`（JS 源 `getBookInfo/getChapters/getContent`）、`RRT:991`（`<js>`+`\n$.data.*`）各 1 条 | JS 返回值 → 列表的**三条通道**（`result` 是数组 / 是 JSON 串 / 是 HTML 串）只要有一条退化，就只有那一条形状的用例会红。且 JS 列表规则的 `result` 类型转换出错时，通常表现为"0 条"而不是抛错 | `<js>result=[{...},{...}]</js>`（原生数组）、`<js>JSON.stringify(...)</js>`（串）、`<js>html片段</js>`（串→HTML），三份 fixture 各 2 条结果 |
| 4 | **正则列表 AllInOne** | 6 条用例都强，但都是**单形状内联**；无 fixture；`RRT:222` 只 2 级 `&&`；`RRT:264` 未断言 `[1].url` | 正则段的分组编号在实现里被重排（如从 `$1..$n` 改成 0-based）、或多级 `&&` 的"整段串联"语义退化为并集 —— 后者 `RRT:222` 挡得住，但**三级 `&&`、`&&` 与 `||` 混写、`##` 与 `@js:` 同时出现**都没挡 | ① 三级 `&&`；② `:…&&…\|\|…` 混写（验证"最左分隔符说了算"）；③ 同一条字段规则里 `$2##正文(_)?@js:result.trim()` 组合 |
| 5 | **图片解密端到端** | `RuleRunner.imageDecoder` 零用例（`ImageDecodeTest.kt:17-20` 自述） | `imageDecode` 规则从"密文串 → 图片字节"的整条链路（含 `@js` 里 `java.base64Decode`、`data:` 前缀、解密失败回落）任何一环改坏，`ImageDecodeTest` 全绿 | 书源带 `ruleContent.imageDecode`：输入一段真实密文 + 期望解出的 PNG 头 8 字节；再加一个"解密失败应回落原文/占位而非崩"的负例 |
| 6 | **分页的边界维度** | `RRT:854/1184` 只测 2–3 页；环仅 1 种（A↔B 互指）；**无页数上限、无并发、无"翻页中某页失败"** | 内部 `visited` 集合改成深度计数、或去掉上限 → 真实站的"永远下一页"会把源拖死；测试不响 | ① 200 页线性链（验证上限截断且不抛）；② 第 2 页 HTTP 500（验证已取章节保留 + 错误可见）；③ `nextTocUrl` 返回重复 URL 3 次 |
| 7 | **请求头继承到子请求** | 只测 POST `Content-Type`（`RRT:1147/1166`）与 `effectiveHeaders` 的 cookie 合并（`SLT:647/660/676/692`）；**"源级 header → `init` 页 / 翻页页 / `nextContentUrl` 页"无一条断言** | 改 HTTP 段（AGENTS.md §7 明说下一步就要抽 `fetchDetailedImpl`/`buildRequest`/`effectiveHeaders`）时，把"源 header 只给首页"当成优化写进去 → 需要 Referer/UA 的站全部 403，而现有 4 条 `effectiveHeaders` 用例仍是绿的（它们都不经 `fetchDetailedImpl`） | 一个源：`header: {"Referer":"…","X-Token":"…"}` + `init` 规则 + `nextTocUrl` 两页；断言**三次请求**的 header map 全部 equals |
| 8 | **`@put`/`@get` 全生命周期** | 3 个形状：`RRT:837`（详情多键 put→toc get，整串 URL equals，最强）、`RRT:1044`（search put→details→toc）、`RuleVariableHandoffTest.kt:49`（`contains` 级）。**无 golden；无"变量同名覆盖"、"跨书串味"、"put 值本身是 JSONPath/JS"** | 变量表作用域改错（例如从 per-book 改成 per-source）→ 多本书并发搜索时互相污染，**只有一个书源的测试看不出来** | ① 两本书交错 `search→details`，各自 `@put:{cid:不同的值}`，断言互不串；② `@put:{x:@js:...}`（值是 JS）；③ 同一键在 search 与 details 各 put 一次（后者应覆盖） |
| 9 | **CSS golden 的 URL 编码断言** | golden 只 `startsWith("…/search?q=")`（`GoldenRuleTest.kt:60-63`）；专门的编码用例 `RRT:634` 也只 `startsWith` + `contains("p=1")` + 无裸空格 + 无裸 `#` | 编码从 `%20` 改 `+`、或对 `%` 二次编码 —— **恰好**有另一处精确断言（`RRT:59` 的 responses map 以 `q=%E8%AF%9B%E4%BB%99` 为键，不匹配就 `error`）兜住了一部分。属"有兜底但不在它该在的地方" | 在 golden 里加一条 `expected.json` 键 `requestUrl`，做**整串 equals** |
| 10 | **`login-v1-js/expected.json` 的死键** | 该文件里 `isScript: true`、`canOpenBrowser: true` 两个键**从不被读取**：v1 用例用 `assertTrue(runner.loginIsScript(source))` 硬编码（`GoldenRuleTest.kt:208` 用例体内），v2 用例才真读 `canOpenBrowser` | 有人把 v1 的 `canOpenBrowser` 语义（比如"URL 型 loginUrl 也算能开浏览器"）改坏，fixture 里写着期望值但测试不看 → 静默通过。**"看起来有测试其实没测"的典型** | 要么在 v1 用例里改成读 fixture 的这两个键，要么从 expected 删掉（当前状态是最坏的：给了安全感但无作用） |
| 11 | **`RssFeedParser` 不测绝对化** | 类注释明说（`RssFeedParserTest.kt:16-18`）："链接/图片的绝对化不在这里判……端到端判据在 `RssSubscriptionTest`" | RSS 的 `/post/1` → `https://feed.example/post/1` 这一步若改坏，本文件 5 例（含 `items[0].link == "/post/1"` 这种**断言相对原值**）会继续通过 | **需核实** `RssSubscriptionTest.kt`(180 行，本轮未读) 是否真的钉住了绝对化 → 标 `needs-runtime-test` |
| 12 | **`||` 备选规则 / `@@` 模板** | `\|\|` 全库只在 `RRT:991`（`$..missing\|\|$..title`、`{{$.book_id\|\|$.id}}`）出现；`@@` 只在 `RRT:415`（未读断言体） | `\|\|` 的"取第一个非空"与 `&&` 的"全部拼接"是**相反语义**（`RRT:785` 注释明确"`&&` 是并且，`\|\|` 才是取第一个"）。若重建时两者颠倒，只有 1 条用例会红 | 三条形：`$.a\|\|$.b`（a 空 / a 非空）、`$.a&&$.b` 同页对照、`{{x\|\|y}}` 在 URL 里 |
| 13 | **错误分类只覆盖 3 个入口** | `RuleFailureClassifyTest` 3 例（内网拒绝 / `RuleExecutionException` / `RuntimeException`） | 新增错误类型（超时、编码失败、翻页上限、解密失败）默认落到"其它异常"分支 → 消息变成含糊的"请看日志"，用户与体检都分不清 | 每种 `RuleExecutionException` 的**子类/消息前缀**各一例，断言 `status` + 消息关键词 |

### 4.2 不在本轮范围（明确说明，避免误读为"没测"）

- **前端消费层**（正文里 `![图片](…)` 占位如何渲染、漫画页如何分页）——后端测试不覆盖，需前端 `product/web/test/**` 另行审计。
- **`ApiRoutesHttpTest` / `E2EScenariosTest` / `CrossFeatureBackendTest`**（771 / 610 / 447 行）——含规则链路的 HTTP 端到端，本轮**未读**，可能对 §4.1 部分缺口有间接兜底（标 `needs-runtime-test`）。


---

## 5. 建议补的最小黄金样本集（7 个）

排序原则：先补**重建最可能改坏、且现在完全无兜底**的；每个都要求"离线 fixture + 整串 equals"，成本 ≈ 一份 `source.json` + 一份响应 + 一份 `expected.json`。

| # | 目录名（建议） | 覆盖什么语法 | 输入形态 | 期望输出形态 | 不补的风险 |
|---|---|---|---|---|---|
| 1 | `content-css`（**改造现有**） | CSS 正文 + 净化（`DIV_BLOCK`、广告剔除、图片占位） | 现有 `page.html` 扩到含：`<p>`×3、内层广告 div、`<img src>`、`<img data-src>`、`data:` 内联图 | 新增 `expected.txt`：**整段正文逐字符 equals**（含换行与空行） | 正文拼接/换行/空行一变，全文检索命中、阅读落点、TTS 断句全部漂移，现有 6 个 golden 全绿 ✅**最优先** |
| 2 | `xpath-search` | 裸 `//` 自动识别 + `@xpath:` 字段 + 多节点文本拼接 + 属性取值 | 一页含 2 个条目，标题分成两个 `<span>`（验证拼接），`href` 为相对地址 | `expected.json`：条数 + 每条 name（**拼接后的整串**）/bookUrl（绝对化后整串） | 纯 XPath 是当前唯一"零 fixture"的主流方言（§4.1-#2），换 XPath 实现/翻译层无人拦 |
| 3 | `regex-allinone-toc` | AllInOne `:` 前缀 + 多级 `&&` + `$n##正则##` + `$n<js></js>` | 一页含"正文卷 ul"与"广告 ul"两个块（广告必须不入选）+ 一段 `<script>` 里的 JSON | 章数 + `listOf(title…)` **整串 equals** + 每章 url 整串 equals + 广告零条 | 23+ 个启用源（`RRT:197` 注释）的目录全靠它；分组编号/串联语义一改就整源 0 章 |
| 4 | `js-list-search` | `<js>…</js>` 作为列表规则的**三种返回类型** | 三份响应：`<js>` 返回原生数组 / `JSON.stringify` 串 / HTML 串 | 每种 2 条结果，`listOf(name…)` equals | JS 列表规则没有任何 golden（§4.1-#3）；`result` 类型判定退化时表现为"0 条"而非报错，最难排查 |
| 5 | `putget-lifecycle` | `@put`/`@get` 跨 search→details→toc 三阶段 + 多键 + 变量同名覆盖 | 两本书交错（书 A `cid=100`、书 B `cid=200`），各自有详情页与目录页 | 两本书的目录 URL **整串 equals**，且互不串味 | 现有 3 例都是单本书（§4.1-#8）；变量表作用域改错只会在多书并发时暴露 |
| 6 | `toc-paging-loop` | `nextTocUrl` 翻页 + 环守卫 + 页码变量 | 3 页目录，第 3 页 `next` 指回第 1 页；`nextTocUrl` 里带 `{{page}}` | 章标题 list equals + `chapters.map{index}` equals + 请求 URL 序列 equals（**证明恰好 3 次请求**） | 环守卫已强测（`RRT:854`），但**"请求了几次"从没被断言**；上限被删会拖死真实源 |
| 7 | `image-decode-rule` | `imageDecode` 规则端到端（JS → Base64 → 图片字节） | 一段固定密文（可硬编码一个小 PNG 的 Base64）+ 一个解密失败的输入 | 前者解出的**前 8 字节** equals PNG 头；后者回落为原文/占位而非抛错 | 目前零覆盖（§4.1-#5），漫画源上线即踩 |

**可选第 8 个（若负责人在意 RSS）**：`rss-absolutize` —— 相对 `link`/`img`/`<enclosure url>` 在 `RuleRunner.rssArticles` 阶段的绝对化，`expected.json` 里存**绝对 URL**；现存 fixture 断言的是相对原值（`GoldenRuleTest.kt:129-135`），绝对化那一步在 golden 层完全没体现。

---

## 6. 证据索引 + 未确认 + 覆盖率

### 6.1 读了什么（全部只读，未 build / 未跑测试 / 未改动 archive）

**整读（11 个文件，885 行）**
`GoldenRuleTest.kt`(250) · `RssFeedParserTest.kt`(117) · `PagingDetectionTest.kt`(73) · `RuleLoginGuardTest.kt`(58) · `PutPairsTest.kt`(55) · `SandboxErrorScopeTest.kt`(54) · `ProxyHeadersTest.kt`(54) · `BareJsonListRuleTest.kt`(50) · `ImageDecodeTest.kt`(49) · `RuleFailureClassifyTest.kt`(47) · `RuleVariableHandoffTest.kt`(78)

**定向窗口（10 段，673 行）**
`RuleRunnerTest.kt`：`:58-105`（JSONPath + 相对 URL）、`:196-300`（正则列表 5 例）、`:528-633`（CSS + XPath + 裸 XPath）、`:634-657`（URL 编码）、`:784-890`（`&&`/`@put`/多键 put / 翻页）、`:890-990`（内容净化 4 例）、`:991-1042`（聚合源方言 + 内联 JS）、`:1146-1208`（Content-Type 补/不补 + JSON 数组翻页）
`SourceLoginTest.kt`：`:646-712`（`effectiveHeaders` 四条 cookie/header 合并）

**只 grep、未读断言体（10 个文件）**
`RuleRunnerTest.kt`（`@Test` 全表 66 条 + `assert*` 分布 224 条）· `SourceLoginTest.kt`（33 条用例名 + assert 分布 204 条）· `TxtTocRuleTest.kt`(420，17 条用例名) · `CookieLayersTest.kt`(244，15 条) · `JsResponseCookieTest.kt`(211，11 条) · `PagingSegmentTest.kt`(95，7 条) · `RuleRunnerAdvancedFeaturesTest.kt`(195，6 条) · `RuleRunnerExtendedTest.kt`(115，3 条) · `RuleBranchAndSelectorDialectTest.kt`(190，9 条) · `RuleUrlScriptsTest.kt`(208，7 条)

**fixture 全读**：`rule-golden/` 全部 15 个文件 / 179 行。

**从未打开**：其余约 103 个测试文件（`ApiRoutesHttpTest`、`E2EScenariosTest`、`CrossFeatureBackendTest`、`Js*` 安全面系列、`Database*`、`Backup*` 等）。

### 6.2 覆盖率

| 口径 | 数字 |
|---|---|
| 测试代码总量（`wc -l` 实测） | **124 文件 / 22,487 行** |
| 规则相关子集（规则/登录/Cookie/分页/RSS/TXT/净化 共 25 文件） | **≈5,699 行**（25% 的测试代码量） |
| 本轮实读（整读 885 + 窗口 673 + fixture 179） | **≈1,737 行** |
| 实读 / 全部测试代码 | **≈7.7%** |
| 实读 / 规则相关子集 | **≈30%** |
| 工具调用 | 29 次（预算 40） |
| `RuleRunnerTest.kt` 读取量 | **673 行 / 1,439 行 = 47%**，且全部为窗口，**无整篇读取** |

### 6.3 未确认（重建前必须补跑或补读）

1. **9 行判级来自用例名/注释而非断言体**（§3.2 已列）。其中 `RRT:1044`、`RRT:1239`、`RRT:415`、`RRT:721/739`、`RRT:1306`、`RuleRunnerExtendedTest.kt:63`、`RuleUrlScriptsTest.kt:112/174`、`SLT:741`。
2. **RSS 链接/图片绝对化**是否真被 `RssSubscriptionTest.kt`(180 行) 钉住 —— 该文件本轮未读（`RssFeedParserTest.kt:16-18` 声称在那里）。
3. **`TxtTocRuleTest` 17 例的断言强度**只按用例名判（强），未读逐例断言体；"分章产物在阅读器里的章节 id/顺序"是否有端到端判据未确认。
4. **HTTP 端到端是否间接兜住 §4.1 缺口**：`ApiRoutesHttpTest`(771)、`E2EScenariosTest`(610)、`CrossFeatureBackendTest`(447)、`SearchRoutesTest`(300) 未读。
5. **测试项数口径**：`GoldenRuleTest.kt` 注释提到"现有 947 项测试"。本轮**禁止跑测试**，无法核实当前项数；124 文件 / 22,487 行是文件口径，不是项数口径。
6. **前端渲染层**（`![图片](…)` 占位在阅读器里如何渲染）不在本轮范围。


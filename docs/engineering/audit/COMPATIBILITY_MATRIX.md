# legadoQ 书源规则兼容矩阵（COMPATIBILITY_MATRIX）

> 审计日期：2026-11-14 ｜ legadoQ：`main` @ `4291d30` + 当前未提交 WIP
> 性质：**只读兼容性审计**。未修改任何源码、配置或数据。
> 对照基线：`LegadoTeam/legado` @ `330e606`（2026-11-01，原版下架后的延续仓）、`HapeLee/legado-with-MD3` @ `97893ac`（2026-11-14）。
> 真实语料：`liufuyou/read` @ `b148fe2`（2026-11-07）的 `sources/yck-novel.json`（267 条）与 `sources/yiove-novel.json`（714 条），合计 **981 条真实书源**。
> 方法：规则字符串静态分类 + 逐项到 legadoQ 源码找实现点。**未联网执行任何书源**，所以本矩阵回答的是「实现面」，不是「跑通率」。

## 0. 一句话结论

legadoQ 的规则引擎实现面**比第一阶段报告的印象完整**：`&&`、`%%`、索引段、`@put` 多键、`@` 属性、`##` 替换、`:` 正则列表都已落地，且有对应判据。真正的短板集中在 **5 个零实现能力** 和 **1 个无法在服务端成立的形态**（WebView），它们影响的源数在 981 条语料里可以逐条数出来。

## 1. 状态图例

| 标记 | 含义 |
| --- | --- |
| ✅ | 有实现，且在源码里能指到具体处理点 |
| ⚠️ | 有实现，但语义与上游存在已知差异，或只在部分链路生效 |
| ❌ | 零实现：源码里没有执行点，脚本里表现为 `undefined` 或字段被忽略 |
| — | 不适用（服务端形态决定不做） |

## 2. 导入层

| 能力 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- |
| 书源 JSON 解析（裸数组 / `data` / `sources` / `bookSources`） | ✅ | `source/SourceCodec.kt` `parse()` | 单条坏 JSON 退逐行解析 |
| UTF-8 BOM、GB18030 | ✅ | `SourceCodec.parse()` `removePrefix("\uFEFF")`；`decodeTextAuto` | |
| 未识别字段保留 | ✅ | `source` 表存 `payload`，编辑不重新序列化模型 | 这是兼容性的关键底座 |
| 主键归一化（剥 `#` / `##` 注解） | ⚠️ | `SourceCodec.normalizeSourceId` | 上游把带注解的源视为两条独立记录；legadoQ 合并为一条。同名不同注解的源会互相覆盖 |
| RSS 源导入 | ✅ | `SourceCodec.parseRss` | |
| 书源排序 `customOrder` | ❌ | `SourcesDao.importSources` 的 insert 列表无 `sort_order` | 导入后排序丢失，需要用户重排 |

## 3. 规则语法矩阵

语料列是「981 条源里有多少条至少一处用到该写法」；规则列是「命中多少条字段规则」。Java API 行的两个数字是「源数 / 调用次数」。

| 语法 | 状态 | 代码证据 | 语料（源 / 规则） | 备注 |
| --- | --- | --- | --- | --- |
| CSS 选择器 | ✅ | `RuleRunner.kt`（Jsoup） | 绝大多数 | |
| XPath（`@xpath:` 与裸 `//`） | ✅ | `RuleRunner.kt` `isXpathRule()` / `JXDocument` | 63 / 235 | `\|` 并集先切，不被当成 `\|\|` |
| JSONPath（`$.`、`[*]`） | ✅ | `RuleRunner.kt`（jayway JsonPath） | 173 / 2475 | |
| `@Json:` 前缀 | ✅ | `RuleRunner.kt` `isJsonPrefixedRule()` | 5 / 25 | |
| `\|\|` 备选 | ✅ | `RuleSplit.kt:15` | 285 / 789 | 只在 `{{}}` 外切 |
| `&&` 并集 | ✅ | `RuleSplit.kt:105`；`RuleNodeSelection.kt:78` | 439 / 668 | 含 `kind` 283、`search.kind` 133 |
| `%%` 交错 | ✅ | `RuleSplit.kt:136`；`RuleValue.kt:145,364` | 少量 | 与上游「按位交错」一致 |
| `@` 属性选择 | ✅ | `RuleValue.kt:435,691` | 899 / 14436 | 最高频写法 |
| `##正则##替换` | ✅ | `RuleValue.kt:107-125` | 847 / 3586 | 含整条规则以 `##` 起头 |
| `:` 正则列表 | ✅ | `RuleValue.regexItemValue` | 631 / 2178 | |
| `-` / `+` 列表前缀 | ✅ | `RuleRunner.kt:366,412,750` | 10 / 10 | |
| `!` / `[index]` 索引段 | ✅ | `RuleSplit.kt:173-267` | 未单独统计 | 闭区间、负索引、步长 |
| `{{ }}` 表达式 | ✅ | `RuleValue.kt` | 309 / 1010 | 含 `page` 70 / `baseUrl` 131 |
| `@put:{…}` / `@get:{}` | ✅ | `RuleSplit.kt:31` | 未单独统计 | 多键已支持（本机库 492 次、278 次多键） |
| `<js>…</js>` / `@js:` | ✅ | `JsSandbox.kt` | 211+292 | 顶级 `return` 已包函数 |
| `result` / `key` 变量 | ✅ | `JsSandbox` | 348 / 41 | |
| `source.getVariable/putVariable` | ✅ | `JsSandbox.kt:560,568` | 6 / 15 | |
| `source.getLoginInfoMap/putLoginInfo` | ✅ | `JsSandbox.kt:870,880` | 13 / 6 | 回的是真 Map |
| `book.getVariable/putVariable` | ✅ | `JsSandbox` book 对象 | 29 / 24 | |
| `cookie.getCookie/setCookie/removeCookie` | ✅ | `JsSandbox.kt:988,1007,1014` | 4 / 16 | |
| `cache.get/put/delete` | ✅ | `JsSandbox` cache bridge | 3 / 7 | 按书源隔离 |
| `java.ajax` / `java.ajaxAll` | ✅ | `JsSandbox.kt:1150,1168` | 137 / 285；9 / 14 | 有界并发 |
| `java.get` / `java.put` / `java.post` | ✅ | `JsSandbox.kt:954-1000,1193,1215` | 60 / 299；47 / 131；21 / 25 | |
| `java.getString` / `getStringList` | ✅ | `JsSandbox.kt:1733` | 81 / 256；5 / 9 | |
| `java.getElements` / `getElement` / `setContent` | ✅ | `JsSandbox.kt:1676-1699` | 18 / 31；8 / 15；6 / 8 | |
| `java.md5Encode` / `timeFormat` / `timeFormatUTC` / `toNumChapter` | ✅ | `JavaPackages` / `ChapterNumbers` | 32 / 619；53 / 84；11 / 31；30 / 61 | |
| `java.base64Encode` / `base64Decode` / `hexDecodeToString` / `encodeURI` / `createSymmetricCrypto` / `digestHex` | ✅ | `JavaPackages.kt` | 14 / 39；12 / 14；6 / 15；11 / 26；7 / 10；3 次 | 白名单内替身 |
| `java.connect` / `java.getWebViewUA` / `java.randomUUID` | ✅ | `JsSandbox.kt:1793,1325`；`JavaPackages.kt:384` | 9 / 10；6 / 15；7 / 8 | |
| `java.startBrowser` / `startBrowserAwait` | ⚠️ | `JsSandbox.kt:1262,1267` | 5 / 21；12 / 20 | 服务端把「开浏览器」改成界面跳转 + 带 Cookie 回抓；不是真 WebView |
| **`java.t2s` / `java.s2t`** | ❌ | `rules/` 零命中 | **6 / 17；2 / 2** | 简体↔繁体；未实现时脚本抛 `undefined is not a function`，整段规则失败 |
| **`java.webView`** | ❌ | 只有 URL 选项 `webView`（`RuleRunner.kt:1164`），JS 侧无此函数 | **13 源**（含 `jsLib`） | 依赖真浏览器的正文/目录取不到 |
| **`java.refreshTocUrl` / `refreshBookUrl`** | ❌ | `rules/` 零命中 | **9 / 10；2 / 2** | 书源换域名后目录地址不更新 |
| `concurrentRate` | ❌ | 无执行点 | **14** | 并发限速不生效；上游用它防封 |
| `ruleToc.preUpdateJs` | ❌ | 无执行点；仅 `SourceCodec` 告警 | **9** | 上游在更新目录前执行 |
| `ruleToc.formatJs` | ❌ | 无执行点；仅告警 | 本语料 0 | 本机库 6 条（2026-11-13 研究） |
| `ruleContent.webJs` | ❌ | 无执行点；仅告警 | 本语料 0 | 本机库 8 条 |
| `webView: true`（源级开关） | — | 仅体检标记 `needs_webview` | 本语料 0 | 服务端没有 Android WebView，架构决定 |
| `ruleReview` 详情层 | ⚠️ | `RuleRunner.reviews()` | 本语料 0 | 只读详情；统计/回复/写操作零执行 |
| `ruleSearch.checkKeyWord` | ✅ | `SourceHealth.kt:41` | 210 | 用于体检，不参与搜索过滤 |

## 4. 五个零实现能力的真实影响

按 981 条语料计：

| 缺口 | 受影响源 | 典型后果 |
| --- | --- | --- |
| `java.t2s` / `s2t` | 6 + 2 | 正文/字段脚本整段抛错；若在 `ruleContent`，整章空白 |
| `java.webView` | 13 | 正文或目录取不到，体检会落到 `needs_webview` 之外的「失败」档 |
| `java.refreshTocUrl` / `refreshBookUrl` | 9 + 2 | 换域名后目录停在旧地址，表现为「目录一直不更新」 |
| `concurrentRate` | 14 | 请求过快被站点限流/封禁；单源体检可能正常，批量时失败 |
| `ruleToc.preUpdateJs` | 9 | 目录更新前的预处理不执行（常见用途正是 refreshTocUrl） |

合计去重后 **34 条源**（981 的 3.5%）会因这五项直接受影响。这不是「大多数源跑不通」，但正好落在「用户反馈某个源不能用」的高频区间。

## 5. 语义差异（已实现，但可能与上游不一致）

这些项本轮只做到「有实现」，没有逐条跑上游对照，列为**待验证**，不要当成已兼容：

| 项 | 风险点 | 验证方式 |
| --- | --- | --- |
| `@` 属性全集 | 上游支持 `@text/@html/@href/@src/@ownText/@outerHtml` 等；legadoQ 按 `split('@')` 处理，属性名覆盖需逐项比对 | 构造 6 种属性用例，与上游 `AnalyzeByJSoup` 输出对比 |
| `{{ }}` 内 JS 语义 | Rhino 数字是 double、`page` 类型、字符串拼接的 `.0` 处理 | 已有 `trimJsNumberFraction`，需补边界用例 |
| `##` 与 `@js:` 的先后 | legadoQ 注释明确 `##` 是最后一步；上游同类实现需复核 | 用 `##…##$1###@js:` 组合用例 |
| `&&` 在非列表字段的并集顺序 | 上游 `elements.addAll`；legadoQ `RuleNodeSelection` 需确认顺序与去重 | 构造 `a&&b` 两条各 2 项的列表 |
| `:` 正则列表的 `$N` 与空匹配 | `regexItemValue` 对 `$0..$99`、空捕获的处理 | 补空捕获与多分组用例 |
| `-` 前缀与 `[index]` 叠加 | `-` 先反序还是先取索引 | 构造 `-tag[1]` 用例 |

## 6. 建议补齐顺序（按「影响源数 ÷ 实现成本」）

1. **`java.t2s` / `s2t`**：前端已有 OpenCC 词典（`web/src/features/reader/content/dict/openccData.ts`），服务端复用即可，成本最小。
2. **`java.refreshTocUrl` / `refreshBookUrl`**：本质是改 `book.tocUrl` / `book.bookUrl` 的内存值，成本小；不做则 `preUpdateJs` 修了也没用。
3. **`concurrentRate`**：解析 `"N/ms"` 并加单源节流，成本中等，收益是批量体检/缓存不被封。
4. **`java.webView`**：服务端无解，只能明确判 `needs_webview` 并在导入时告警；不要假装支持。
5. **`preUpdateJs` / `formatJs` / `webJs`**：在 1、2 落地后再接执行点，否则脚本里调用的方法仍然是 `undefined`。

## 7. 复现命令

```bash
# 语料语法分布（本轮脚本，未入库）
node docs/.scratch/compat-audit/analyze-sources.mjs

# 某个能力在 legadoQ 是否有执行点
grep -rn '"t2s"\|"refreshTocUrl"\|"webView"' product/app/src/main/kotlin/io/legado/rules/

# 上游对应实现
grep -rn "t2s\|refreshTocUrl" ref-legadoteam/app/src/main/java/io/legado/app/model/
```

## 8. 本轮限制

- 只做静态实现面比对，没有执行任何书源，也没有和上游逐条跑同一份输入对比输出。
- 语料来自两个公开合集，偏向「还能用」的源；失效源、私域源、需要登录的源覆盖不足。
- 未纳入 WebView 形态、登录流程、RSS 规则、TXT 分章规则的兼容性。
- 上游 `gedoor/legado` 已于 2026-05 下架（仓库只剩公告），本矩阵以 `LegadoTeam/legado` 为语义基准；MD3 只用于确认字段/条目差异。

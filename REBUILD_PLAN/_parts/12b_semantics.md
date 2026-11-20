# 12b · 规则语义（Rule Semantics）审计 — CSS / XPath / JSONPath / JS / 正则 / 变量 / 嵌套

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


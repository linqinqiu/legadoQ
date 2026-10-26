# 我方规则引擎实现定位与差距清单

> 范围：`E:\legado\legado`（青阅 0.8.6）。只描述**当前源码真实行为**，行号以本次核对为准。
> 用途：与 [`upstream-rule-engine.md`](upstream-rule-engine.md) 对照，定位要补的洞。

## 摘要

引擎主体在 `rules/RuleRunner.kt`（1617 行），取值层 `rules/RuleValue.kt`，`@put/@get` 拆分在 `rules/RuleSplit.kt`，
`地址,{JSON}` 的切割在 `content/LooseJson.kt`。已确认 **5 个具体差距**：逗号后空白不容忍、
`extractTail` 取到字符串结尾、详情阶段 `@put` 传不到目录、详情 trace 的失败标记恒为真、
`downloadUrls` 后端不读。目录为空时**无兜底**。

---

## 1. 搜索结果的 bookUrl 链路

**入口**：`app/src/main/kotlin/io/legado/rules/RuleRunner.kt:161`

```kotlin
val url = item.value(rule.string("bookUrl"), jsSandbox, body, sourceUrl)?.absolute(sourceUrl)
    ?: return@mapNotNull null
```

**`absolute()`**：同文件 `RuleRunner.kt:1455-1471`

```kotlin
private fun String.absolute(base: String): String = try {
    val cleanBase = base.substringBefore("##").substringBefore("#").trim()
    val withoutSlash = trim().removePrefix("/")
    if (withoutSlash.startsWith("http://", ignoreCase = true) || withoutSlash.startsWith("https:// ignoreCase = true)) {
        return withoutSlash          // ← 已是绝对地址：原样返回，尾巴保留
    }
    ...
```

**结论**：`地址,{JSON}` 形态**能完整穿过搜索→详情链路**。
漫画源 `ruleSearch.bookUrl` 的 JS 规则返回 `"https://…?comic_id=…&client-type=android&…," + JSON.stringify(b)`，
`absolute()` 原样返回，`,{"method":"GET","headers":{…}}` 尾巴不丢。
（这与上游 `NetworkUtils.getAbsoluteURL` 对绝对地址原样返回的行为一致。）

**但仍存在的差异**：上游 `paramPattern = Regex("\\s*,\\s*(?=\\{)")` **容忍逗号前后空白**；
我们 `LooseJson.extractTail` 用 `value.indexOf(",{")`，**只认逗号后紧跟 `{`**。
源里写成 `地址 , {"method":"POST"}`（逗号后有空格）时，我们切不开，整串被当成 URL。

## 2. `splitUrlOptions` / `LooseJson.extractTail` 支持的形态

**文件**：`app/src/main/kotlin/io/legado/content/LooseJson.kt`

**`extractTail`（第 144-168 行）**：

```kotlin
fun extractTail(value: String): Pair<String, String?> {
    val start = value.indexOf(",{")
    if (start < 0) return value to null
    // 按花括号配对往后找闭合 }
    ...
    return value.substring(0, start) to value.substring(start + 1, index + 1)
}
```

函数自己的注释已承认两个限制（第 139-143 行）：

> - 返回 `Pair(去掉尾巴的 URL, 尾巴文本)`；没有 `,{` 或括号不闭合时尾巴为 null。
> - **现有实现是「取到字符串结尾」**，源里 `,{...}` 后面还跟着别的东西时严格 JSON 直接解析失败。

**`splitUrlOptions`（`RuleRunner.kt:976-1008`）**：先 `LooseJson.extractTail` 拿尾巴，
再 `jsonOption(tail)`（严格）→ `jsonOption(LooseJson.toStrict(tail))`（宽松），
解析出 `method / body / headers / charset / webView`。两次都失败则整串当 URL。

**`toStrict` 覆盖的非规范写法**（注释第 9-16 行，基于本机 4876 源实测，严格 JSON 失败 1571 处）：
单引号键值、裸标识符键、全角引号、字符串里裸换行/制表符、尾随逗号、`//` 与 `/* */` 注释。

**差距**：
1. 逗号后空白不容忍（上游容忍）。
2. 括号不闭合 → 尾巴整体丢弃（上游 `paramPattern.find` 至少能切出地址部分）。
3. `MAX_LENGTH = 8192`，超长尾巴直接返回 null。

## 3. `@put` / `@get` 变量表与跨阶段传递

**存储**：`RuleValue.kt:252-256`

```kotlin
internal fun snapshotVariables(): Map<String, String> = ruleVariables.toMap()
internal fun seedVariables(initial: Map<String, String>) {
    if (initial.isNotEmpty()) ruleVariables.putAll(initial)
}
```

变量表活在**单个 NodeValue** 上（`ruleVariables`），跨调用靠 `RuleRunner` 手动存取。

**键的规则**：`rememberRuleData(url, vars)` / `recallRuleData(url)`，**按 URL 字符串做键**。

**详情 → 目录的传递（`RuleRunner.kt:483-485`）**：

```kotlin
val tocUrl = value("tocUrl")?.absolute(bookUrl) ?: bookUrl
// 目录那一侧（chapters）拿到的是 tocUrl，把变量也挂到 tocUrl 上 —— chapterUrl 常写 `@get:{bid}`
rememberRuleData(tocUrl, recallRuleData(bookUrl))
```

**这是已确认并已修复的缺陷**：原来只回灌了 `recallRuleData(bookUrl)`（即**搜索阶段**存的变量），
**详情这一步新 `@put` 的变量没有并进去**。

漫画源正是这个形态：
- `ruleBookInfo.name = $.comic_name@put:{cid:$.comic_id}`（详情阶段 put）
- `ruleToc.chapterUrl = @js: cid='@get:{cid}' …`（目录阶段 get）

结果 `cid` 取空 → 拼出 `.../getchapterdata?comic_id=&chapter_id=…` → 上游回 **422**，
界面上只看到「上游返回 HTTP 422」，看不出是变量没传过去。

**已修复**（`RuleRunner.kt:485`）：`rememberRuleData(tocUrl, recallRuleData(bookUrl) + root.snapshotVariables())`。
判据 `RuleVariableHandoffTest`（2 条，用 `responseFetcher` 注入假响应免网络）：
修复前精确复现 `cid=&path=/c1`，修复后通过；第二条守住「搜索阶段 put 仍能传到目录」不回归。

## 4. `ruleBookInfo.init` 的执行时机与语义

**`RuleRunner.kt:456-467`**：

```kotlin
// init 常写成「JS + 后置取值路径」的规则链（如 <js>…</js>$.data）：必须求值，不能当路径用。
val root = when {
    initRule.isNullOrBlank() -> baseDoc
    initRule.contains("<js>") || initRule.trimStart().startsWith("@js:") || initRule.trimStart().startsWith("js:") ->
        runCatching { baseDoc.value(initRule, jsSandbox, body, bookUrl) }.getOrNull()
            ?.takeIf { it.isNotBlank() }?.let { NodeValue.document(it) } ?: baseDoc
    else -> baseDoc.at(initRule)
}
// at() / NodeValue.document() 会另起一个节点，变量得再灌一次
root.seedVariables(seedVars)
```

**语义**：`init` 的返回值**替换 base document**，后续字段规则都基于这个新 root 取值。
这解释了两件事：
1. 漫画源 `init` 用 `java.aesBase64DecodeToString` 解出真 JSON 后，`$.comic_name` 才有值 —— 我们补上 AES 桥后详情/目录立刻通了。
2. `init` 失败时 `runCatching{}.getOrNull()` 返回 null → **安静退回 `baseDoc`**（原始密文），
   于是后续 JSON 路径取不到值，报的却是 `Unexpected End Of File position 36020` 这类和真因无关的错。

## 5. `bookSourceType` 在引擎里的分叉

**读取点**：`RuleRunner.kt:1475-1476` 与 `1580-1581`

```kotlin
/** 书源 bookSourceType：0 文本 / 1 音频 / 2 图片(漫画) / 3 文件 / 4 视频；缺省或非数字给 0。 */
private fun JsonObject.sourceType(): Int = (get("bookSourceType") as? JsonPrimitive)?.intOrNull ?: 0
```

**使用点**：只作为**数据透传**，不做行为分叉：
- `RuleRunner.kt:126 / 172` → `SearchResult.sourceType`
- `RuleRunner.kt:495` → `BookDetails.sourceType`
- `RuleRunner.kt:1526 / 1531`（JS 书源路径）
- `data/ShelfDao.kt:20` 的 `SHELF_SELECT` 用 `json_extract(src.payload,'$.bookSourceType')` 给书架项

**结论**：引擎**不按类型走不同抓取/渲染路径**。音频(1)/漫画(2)/文件(3)与文本(0)走同一套
「details → chapters → content」，类型只作为标记传给前端，由前端决定怎么渲染。

**`downloadUrls`（文件源相关）未落地**：全仓只在 `web/src/sources/bookSourceFields.ts:349` 的字段描述里出现，
**后端引擎从不读取** —— `ruleBookInfo.downloadUrls` 对文件源(3)无效。

## 6. 目录为空时的兜底

**`http/ReadingRoutes.kt:90-117`**（`POST /api/books/chapters`）：

```kotlin
withTimeout(4000) {
    val direct = runCatching { runner.chapters(source.json, request.bookUrl) }.getOrNull()
    // 目录地址常常不等于书页地址（tocUrl 要从详情里再取一次），
    // 按书页取目录会**安静地返回空列表**而不是报错，所以空结果同样要回落到详情。
    val chapters = if (!direct.isNullOrEmpty()) direct else {
        val details = runner.details(source.json, request.bookUrl)
        runner.chapters(source.json, details.tocUrl).also { database.saveTocCache(...) }
    }
    if (chapters.isNotEmpty()) database.saveTocCache(request.sourceId, request.bookUrl, chapters)
    chapters
}
```

兜底链：**bookUrl 试 → 空则 details → tocUrl 试 → 4 秒超时 → 仍失败则 `fallbackFromContent`**。

**但最后一级兜底仍是空**：三级都试完还是空，就返回 `[]`。
**没有「把书籍页本身当一章」的兜底** —— 音频源 5sing 就是这样死的：
它的 `ruleToc.chapterList = .view_tit`（在歌曲页 HTML 上找），抓到 0 个节点，
三级兜底全空 → 目录 0 章 → 阅读器无从进入。

上游是否有这个兜底，本次未取到证据（见上游报告 §4）。

---

## 未落地

- **音频源目录兜底**：目录三级兜底全空后仍返回 `[]`，没有「把书籍页当成一章」。
  属行为变更，需要先写判据（响应体是真实歌曲页 HTML，宜用 `responseFetcher` 注入）。

## 附：已确认可用的部分（避免重复排查）

- `LooseJson.toStrict` 对单引号/裸键/全角引号/尾随逗号/注释的规范化是**工作**的（基于 4876 源实测）。
- `absolute()` 对绝对地址原样返回，`,{JSON}` 尾巴在搜索→详情链路上**不丢**。
- `init` 替换 base document 的语义**正确**，AES 桥补上后加密源立刻可用。
- 目录链的「bookUrl → tocUrl」两段式兜底**有效**，只是最后一级为空时没有「书籍页即一章」的兜底。

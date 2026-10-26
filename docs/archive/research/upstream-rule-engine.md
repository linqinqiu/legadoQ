# 上游规则引擎经验（HapeLee/legado-with-MD3）

> 对照仓库：`https://github.com/HapeLee/legado-with-MD3`（原创，非 fork；默认分支 `main`；Kotlin；6636 star；最近推送 2026-10-24 20:42）。
> 本地浅克隆：`E:\legado-out\upstream`（--depth 1，无 git 历史，只能读文件不能 git log；2026-10-25 起先移出 E:\legado 工作区、再归并到 E:\legado-out\upstream，避免 3141 个上游文件污染 grep/IDE/构建扫描）。
> 本文件只记录**已取到源码核对**的结论；每条带上上游文件路径。

## 摘要

上游把「URL + 请求描述符」的解析集中在 `AnalyzeUrl.kt` 一个类里，与取值层（`AnalyzeRule.kt`）彻底分离；
变量表是独立的 `RuleData` 类，靠 `putBigVariable/getBigVariable` 跨阶段存活；
书源 JS 的加密能力来自 classpath 里的 Hutool，且 base64 解码被强制走 Hutool 以兼容宽松输入。

---

## 1. `地址,{JSON}` 请求描述符在哪解析

**文件**：`app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt`

处理链在 `initUrl()`（第 164-172 行）：

```kotlin
fun initUrl() {
    ruleUrl = mUrl
    analyzeJs()          // 执行 @js / <js></js>
    replaceKeyPageJs()   // 替换 {{...}} 与 <a,b,c> 页码
    analyzeUrl()         // 切地址与选项
}
```

`analyzeUrl()`（第 235-301 行）是关键：

```kotlin
val urlMatch = paramPattern.find(ruleUrl)
val urlNoOption =
    if (urlMatch != null) ruleUrl.substring(0, urlMatch.range.first) else ruleUrl
url = NetworkUtils.getAbsoluteURL(baseUrl, urlNoOption)
...
if (urlMatch != null) {
    val urlOptionStr = ruleUrl.substring(urlMatch.range.last + 1)
    var urlOption = GSONStrict.fromJsonObject<UrlOption>(urlOptionStr).getOrNull()
    if (urlOption == null) {
        urlOption = GSON.fromJsonObject<UrlOption>(urlOptionStr).getOrNull()
        if (urlOption != null) log("链接参数 JSON 格式不规范，请改为规范格式")
    }
    urlOption?.let { option ->
        option.getMethod()?.let { method = ... }      // POST / HEAD / GET
        option.getHeaderMap()?.forEach { headerMap[it.key] = it.value }   // headers 逐条合并
        option.getBody()?.let { body = it }
        type = option.getType(); charset = option.getCharset()
        retry = option.getRetry(); useWebView = option.useWebView()
        webJs = option.getWebJs(); bodyJs = option.getBodyJs(); dnsIp = option.getDnsIp()
        option.getJs()?.let { evalJS(it, url)?.toString()?.let { u -> url = u } }  // 可再改写 url
        serverID = option.getServerID(); webViewDelayTime = ...
    }
}
```

**切割正则是**（第 799 行）：

```kotlin
val paramPattern: Regex = Regex("\\s*,\\s*(?=\\{)")
```

即：**逗号（前后可有空白）+ 后面必须紧跟 `{`** 才切。这一点比我们宽松。

`UrlOption` 的字段（第 876-923 行）：`method / charset / headers / body / origin / retry / type / webView / webJs / dnsIp / js / bodyJs / serverID / webViewDelayTime`。

**先严后松两次解析**：`GSONStrict` 失败再退 `GSON`，并打日志提示格式不规范。这和我们 `LooseJson.toStrict` 的思路一致，但上游是「严格优先 + 宽松兜底 + 告警」，我们是「自己规范化成严格 JSON」。

### `getAbsoluteURL` 对绝对地址的行为

`NetworkUtils.getAbsoluteURL(baseUrl, relativePath)`：**当 relativePath 已是绝对地址（http/https 开头）时原样返回**，只有非绝对地址才做 URL 拼接。

这条决定了 `地址,{JSON}` 形态能否活到后面：只要前面那截是绝对地址，`,{JSON}` 尾巴就不会被拼接逻辑破坏。

---

## 2. `@put` / `@get` 变量的生命周期

**文件**：`app/src/main/java/io/legado/app/model/analyzeRule/RuleData.kt`（全文 30 行）

```kotlin
class RuleData : RuleDataInterface {
    override val variableMap by lazy { hashMapOf<String, String>() }

    override fun putBigVariable(key: String, value: String?) {
        if (value == null) variableMap.remove(key) else variableMap[key] = value
    }

    override fun getBigVariable(key: String): String? = null

    fun getVariable(): String? =
        if (variableMap.isEmpty()) null else GSON.toJson(variableMap)
}
```

配套接口 `RuleDataInterface.kt`（未逐行读，存在 `putVariable` / `getVariable`）。

**在 AnalyzeUrl 里的落地**（第 409-428 行）：

```kotlin
fun put(key: String, value: String): String {
    chapter?.putVariable(key, value) ?: ruleData?.putVariable(key, value)
    return value
}

fun get(key: String): String {
    when (key) {
        "bookName" -> (ruleData as? Book)?.let { return it.name }
        "title" -> chapter?.let { return it.title }
    }
    return chapter?.getVariable(key)?.takeIf { it.isNotEmpty() }
        ?: ruleData?.getVariable(key)?.takeIf { it.isNotEmpty() }
        ?: ""
}
```

**要点**：
- 变量表挂在 `ruleData`（书这一级的运行时对象）上，**不随单次解析消亡** —— 所以「搜索时 put、目录/正文时 get」合法。
- `chapter` 优先于 `ruleData`：章节级变量覆盖书级。
- `getVariable()` 把整表序列化成 JSON，用于跨进程/跨调用传递。

---

## 3. `init` 规则的语义

`AnalyzeUrl` 自身不处理 `init`；`init` 属于 `ruleBookInfo`，由取值层 `AnalyzeRule.kt` 处理（该文件 1500+ 行，本次未逐行核对 init 分支）。

**已确认的相关事实**：`RuleData` 作为 `ruleData` 传入 `AnalyzeUrl`，而 `ruleBookInfo` 的字段规则（含 `init`）与 URL 规则共用同一个 `ruleData` 实例 —— 这解释了为什么 `name: $.comic_name@put:{cid:$.comic_id}` 里 put 的变量，能被后续 `chapterUrl: @get:{cid}` 取到。

> ⚠️ `init` 的**确切执行时机与返回值语义**（是否整体替换 base document）本次未取到直接证据，标「未逐行核对」，需要时再查 `AnalyzeRule.kt`。

---

## 4. 音频源（bookSourceType=1）目录兜底

**未取到**。本次未在 `AnalyzeUrl.kt` / `RuleData.kt` 中找到「目录为空时把书籍页当一章」的兜底逻辑。该逻辑若存在，应在 `model/analyzeRule/` 之外的 `BookChapter` 列表装配处（可能在 `help/source/BookSourceExtensions.kt` 或 `model/` 的阅读协调器里），本次未核对。

---

## 5. JSON 响应上的裸键列表规则

**未取到直接证据**。上游取值层是 `AnalyzeByJSonPath.kt` + `AnalyzeByJSoup.kt` + `RuleAnalyzer.kt` 分流，本次未逐行核对「裸键是否补 `$.`」。

**但有一条强旁证**：上游 `help/source/SourceHelp.kt`、`BookSourceExtensions.kt` 存在，且 `AGENTS.md` 明确写了
「Rhino 书源/RSS/TTS 规则……属于高行为风险平台能力，迁移前必须建立兼容测试」——
说明上游对书源规则兼容性有专门纪律，但具体到裸键列表的规范化位置，需再查 `AnalyzeByJSonPath.kt`。

---

## 6. 加密与编码能力（AGENTS.md / CLAUDE.md 明确记载）

- **Hutool 5.8.22 固定在 classpath**，两个用途：
  1. 作为**书源 JS 的运行时加密库**（书源直接 `Packages.cn.hutool.*`）；
  2. `help/crypto/CryptoUtils.kt` 的 base64 **解码**统一走 `cn.hutool.core.codec.Base64.decode`，
     以兼容缺 `=` 填充等宽松输入（Kotlin 严格填充会导致部分书源取章名/正文回归）。
- 应用内部加密主体用 JCA（`javax.crypto` / `java.security`）+ `help/crypto` 路径。
- `help/crypto/` 目录实际文件：`AsymmetricCrypto.kt`、`CryptoUtils.kt`、`Sign.kt`、`SymmetricCryptoAndroid.kt`、`README.md`。

**对我们的意义**：书源 JS 里能调 `Packages.cn.hutool.*`，意味着大量源把加解密、Base64、散列都托管给 Hutool。我们补 `java.aesBase64DecodeToString` 是对的，但** Hutool 那一整层是更大的兼容面**（本次未展开核对）。

---

## 7. 其他工程约束（AGENTS.md 原文，对我们有参考价值）

- **jsoup 不得升过 1.16.2**：新版行为影响 `AnalyzeByJSoup.kt` 与 JsoupXpath（jsoup#2017）。
- 代码 namespace `io.legado.app`，但 `applicationId` 是 `io.legato.kazusa`，不要混用。
- minSdk 26、target/compile SDK 37；Release 开 R8 + 资源压缩。
- 架构：Clean Architecture 三层（`data/` / `domain/` / `ui/`），另加 `help/`（HTTP、内容处理、备份、JS 引擎）、`model/`（运行时协调器，非实体）、`service/`、`web/`（内嵌 Ktor WebService）、`lib/`（第三方包装）。
- 长期目标：渐进迁移到 KMP/CMP，文档在 `docs/dev/kmp-cmp-modernization.md`。

---

## 附：与我们代码的对应关系（初步）

| 上游 | 我们 | 备注 |
|---|---|---|
| `model/analyzeRule/AnalyzeUrl.kt` | `rules/RuleRunner.kt` + `content/LooseJson.kt` | 上游一个类扛下 URL+选项，我们拆在引擎与宽松 JSON 里 |
| `model/analyzeRule/RuleData.kt` | `rules/RuleValue.kt` 的 `ruleVariables` + `RuleRunner.rememberRuleData/recallRuleData` | 上游是独立类 + 接口，我们是 NodeValue 上的表 + 按 URL 键的记忆 |
| `paramPattern = \s*,\s*(?=\{)` | `LooseJson.extractTail` 的 `indexOf(",{")` | **我们不容忍逗号前后空白，上游容忍** |
| Hutool 加密库 | `rules/JsSandbox.kt` 的 `java.*` 桥 | 我们缺 Hutool 那一层 |

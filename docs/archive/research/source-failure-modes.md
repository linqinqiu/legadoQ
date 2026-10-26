# 四类书源实测与失败模式清单

> 环境：青阅 0.8.6（`legado/app/build/libs/legado-0.8.6-all.jar`），临时实例 1243，临时库 `legado/tmp/dbg-data`。
> 样本：用户提供的 4 个源（`shareBookSource(5).json`，文本/音频/漫画/文件各一）。
> 核对时间：2026-10-25。所有结论均来自本次实跑，含原始返回。

## 摘要

**2/4 全通，1/4 差最后一步，1/4 卡在目录**。全部失败的根因都不在站点，而在我们的引擎：
详情阶段 `@put` 的变量传不到目录（漫画源正文 422）、目录为空时没有"书籍页即一章"的兜底（音频源 0 章）。
另有一个**调试信息误导**：详情 trace 在取值成功时也标记「取到空值」，本轮排查被它带偏过。

---

## 1. 云中书库（导入）· bookSourceType=3 · ✅ 全通

| 步骤 | 结果 |
|---|---|
| 搜索 `斗破` | 50 条，取《斗破天启》 |
| 详情 | 200，`tocUrl` 同书页、`wordCount=233658` |
| 目录 | 34 章，第一章「第一章 孙氏家族」 |
| 正文 | 3211 字，正文开头正常 |

`bookSourceUrl` 里的 `##@遇知` 后缀被正确剥掉（id 归一为 `http://www.yunxs.info/`）。

## 2. 番茄小说 v3.4.2 · bookSourceType=0 · ✅ 全通

| 步骤 | 结果 |
|---|---|
| 搜索 `斗破` | 10 条，取《炎尘之同行》 |
| 详情 | 200，`tocUrl` 指向 `fanqienovel.com/api/reader/directory/detail?bookId=…` |
| 目录 | 88 章 |
| 正文 | 3245 字 |

`ruleToc.isVolume`、`ruleContent.replaceRegex`、`wordCount` 均正常工作。

## 3. 全免漫画（优）· bookSourceType=2 · ⚠️ 差最后一步

### 现状

| 步骤 | 结果 |
|---|---|
| 搜索 `斗破` | **5 条命中** |
| 详情 | **200**（AES 桥补上后通的） |
| 目录 | **50 章** |
| 正文 | **502 `上游返回 HTTP 422`** |

### 根因：详情阶段 `@put` 的变量没传到目录

调试流（`GET /api/sources/{id}/debug`）里看得清清楚楚：

```
[详情] 《沉香破》｜三福动漫 | ok: true
    · name ← $.comic_name@put:{cid:$.comic_id} => 沉香破
    · tocUrl ←  =>（空）
[目录] 50 章 | ok: true
    · 第1话｜https://api-cdn.kaimanhua.com/…
[正文] 失败：第1话 | ok: false | 上游返回 HTTP 422
```

源规则：

```
ruleBookInfo.name = $.comic_name@put:{cid:$.comic_id}     ← 详情阶段 put cid
ruleToc.chapterUrl = @js: cid='@get:{cid}'; …             ← 目录阶段 get cid
```

我们的 `RuleRunner.kt:485` 只回灌**搜索阶段**的变量：

```kotlin
rememberRuleData(tocUrl, recallRuleData(bookUrl))   // 缺 root.snapshotVariables()
```

于是 `cid` 取空，拼出 `…/getchapterdata?comic_id=&chapter_id=…`，上游回 422。

**期望行为**：详情阶段 `@put` 的变量应随 `tocUrl` 一并传给目录（上游 `RuleData` 挂在书这一级运行时对象上，天然跨阶段存活）。

### 附带发现：`bookUrl` 的 `,{JSON}` 尾巴**没有**丢

搜索返回的原始 bookUrl（完整）：

```
https://api-cdn.kaimanhua.com/comic-api/v2/comic/getcomicdata?comic_id=86351&client-type=android&productname=qmmh&client-channel=xiaomi&platformname=android&client-version=1.4.8erciyuan2020,{"method":"GET","headers":{"User-Agent":"okhttp/4.9.1","m-request-id":"<md5>"}}
```

尾巴在。`RuleRunner.absolute()` 对绝对地址原样返回，`splitUrlOptions`/`LooseJson.extractTail` 能切开。
**（本轮前的怀疑「签名头丢失导致 402」不成立。）** 直接拿这条原始字符串请求详情也是 200。

## 4. 五丁音乐（优+）· bookSourceType=1 · ❌ 卡在目录

### 现状

| 步骤 | 结果 |
|---|---|
| 搜索 `周杰伦` | 10 条，首条 bookUrl `http://5sing.kugou.com/yc/2104925.html` |
| 详情 | 200 |
| 目录 | **0 章** |

### 根因：目录规则匹配不到，且无兜底

源规则：`ruleToc.chapterList = .view_tit`、`chapterName = text`（在歌曲页 HTML 上找）。
我们的目录链（`ReadingRoutes.kt:90-117`）是三级兜底：
`bookUrl 试 → 空则 details → tocUrl 试 → 4 秒超时 → fallbackFromContent`，
**三级全空就返回 `[]`，没有「把书籍页本身当一章」的兜底**。

站点本身正常（`curl` 直连搜索接口 200、返回 `{"list":[…]}`，`bookList: list` 修好后能取到 10 条）。

**期望行为**：目录为空时，至少把书籍页当成单章节，让阅读器能进去（音频源常见形态：一本书 = 一首歌）。

## 5. 本轮顺带修掉的（已验证）

| 问题 | 现象 | 处置 |
|---|---|---|
| JSON 裸键列表规则 | `bookList: list` 被当 CSS，搜索 0 条 | `RuleRunner` 补 `$.` 前缀，5sing 搜索从 0 → 10 条 |
| 缺 AES 解密桥 | 加密源详情 502 `Unexpected End Of File position 36020` | `JsSandbox` 补 `java.aesBase64DecodeToString`，漫画源详情/目录通 |
| `,{JSON}` 尾巴不容忍空白 | `地址 , {"method":"POST"}` 切不开 | `LooseJson.extractTail` 容忍逗号前后空白（对齐上游 `paramPattern`） |

## 6. 排查中被误导的一处（已确认是显示 bug）

详情 trace 对**每个成功取到值**的字段都标了 `✗ 取到空值`：

```
· name ← $.comic_name@put:{cid:$.comic_id} => 沉香破 ✗ 取到空值
· author ← $.author_name => 三福动漫 ✗ 取到空值
· lastChapter ← $.lastchapter_title => 最终话 ✗ 取到空值
```

`RuleRunner.kt:476-477`：

```kotlin
failure = outcome.exceptionOrNull()?.let { … }
    ?: outcome.getOrNull()?.let { "取到空值" }.orEmpty(),
```

`outcome.getOrNull()` 拿到非空值也进第二个分支 —— **成功时也报「取到空值」**。
本轮排查一度据此以为字段全没取到。该 trace 不可信，需要修。

## 7. 已落地：详情 `@put` 变量传给目录

**改动**：`app/src/main/kotlin/io/legado/rules/RuleRunner.kt:485`

```kotlin
// 改前：只回灌搜索阶段的变量
rememberRuleData(tocUrl, recallRuleData(bookUrl))
// 改后：把详情这一步新 put 的变量一并带上
rememberRuleData(tocUrl, recallRuleData(bookUrl) + root.snapshotVariables())
```

**判据**：`app/src/test/kotlin/io/legado/RuleVariableHandoffTest.kt`（2 条）
- 用 `RuleRunner(responseFetcher)` 注入假响应，`details()` → `chapters()` 跑真链路，不碰网络
- 修复前精确复现：`目录 URL 里应带上详情阶段 put 的 cid，实际：https://c.example/ch?cid=&path=/c1`
  —— 与线上漫画源 422 的 URL 形态（`comic_id=&chapter_id=…`）一致
- 第二条守住原能力：搜索阶段 `@put` 仍能传到目录（不回归）

**仍待验证**：真实漫画源的正文链路（需要外网 + 那个微信源文件，本机已不可用）。
判据层面已证明变量传递修好，但「422 是否因此消失」要在真源上复测。

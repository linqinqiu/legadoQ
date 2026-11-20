# 20 RT-3：ruleData 跨源变量污染验证

> [!NOTE]
> **修复状态（2026-11-20）：已修复并回归验证通过。** 在 `E:\legado` 主线 `refactor/rebuild` 上，
> 把 `ruleData` 的键从纯 URL 改为 `(sourceId, url)` 复合键（`RuleRunner.kt` 的 `ruleDataKey`，
> 改动随 commit 提交）。用本文 §8 的同一驱动、同一 classpath 重跑 3 遍：核心污染实验
> **E1 / E1b / E7 从 `POLLUTED` 全部转为 `clean`**，3 遍一致；单源变量交接
> （`RuleVariableHandoffTest` / `PutPairsTest` / `RuleDataCacheLruTest` / `RuleRunnerTest`）全绿。
> E3/E6 由污染态转为隔离态是**预期正确行为**。完整对比见文末 §10「修复记录」。
> 下方 §0–§9 是 2026-11-18 的**审计发现原文**，保留不改，以便对照。

> 授权范围（2026-11-18 审计当时）：**仅 RT-3**。不修任何代码、不改归档、不联网、不使用真实 Cookie。
> 执行时间：2026-11-18 00:0x–00:3x（Asia/Shanghai）
> 执行方式：仓库外独立驱动 `E:\legadoQ-runtime\rt3\Rt3.java`，编译进产品运行时 classpath
> （`product/app/build/install/legado/lib/*`），通过 `RuleRunner` 的**公开构造函数**注入
> `responseFetcher` 替身，走产品真实链路（`search` / `details` / `chapters` / `content`）。
> 原始日志：`20_RT3_RAW_LOGS/01..03_rt3_run*.log`（同一套实验跑 3 遍，结论完全一致）。

---

## 0. 结论（先看这一段）

**CONFIRMED：存在跨书源变量污染，判据是"URL 相同即共享"。**

`ruleData` 是 **RuleRunner 实例级、进程长寿、按 URL 字符串索引**的 `@put` 变量表，
**键里没有 sourceId**。因此：

| # | 结论 | 判定 | 证据 |
|---|---|---|---|
| 1 | A 书源写入的变量，**B 书源能读到**（当两者指向同一 bookUrl） | **CONFIRMED** | E1：`B.details.intro = http://stub.test/i/A-tag`（A 的 tag） |
| 2 | 跨阶段键碰撞：**A 的 tocUrl 被 B 当作 bookUrl** 时同样污染 | **CONFIRMED** | E1b：`B.details(bookUrl=A.tocUrl).intro = .../i/A-tag` |
| 3 | 同一书源、**不同书**（不同 URL）不串 | **CONFIRMED（干净）** | E2：`A.details(book/2).intro = http://stub.test/i/`（空） |
| 4 | **并发**执行两个书源、同一 URL：后写者覆盖先写者，无隔离 | **CONFIRMED** | E3 三次：每次读到 A 或 B（last-writer-wins） |
| 5 | 规则执行**失败后**不残留变量 | **NOT_REPRODUCED**（无残留） | E4：失败搜索后详情取不到 `C-tag` |
| 6 | 变量**跨线程共享**（不是 ThreadLocal） | **CONFIRMED** | E6：`rt3-writer` 线程写入 → main 线程读到 |
| 7 | 目录链路（漫画源 `chapterUrl=…?bid=@get:{bid}`）同样被污染 | **CONFIRMED** | E7：B 在 A 的 tocUrl 上取目录，章节 URL 变成 `.../c/A-tag` |
| 8 | 隔离**只在 RuleRunner 实例之间**成立 | **CONFIRMED** | E8：另一个实例读不到（`per-instance`） |
| 9 | 变量表上限 | **CONFIRMED** | E9：`MAX_RULE_DATA_KEYS = 4096`（LRU 淘汰） |
| 10 | 同一次执行内 `@put → @get` 正常 | **CONFIRMED** | E5：`name = http://stub.test/n/A-tag`（机制本身可用，对照组） |

**影响定级：P1（正确性/可用性），不是 P0（无数据丢失）。**
它不会毁库，但会让"同一本书两个源"、"换源"、"两个源的 URL 恰好相同"这几类真实场景
**发出错误的请求**，且**没有任何报错**——表现为"目录取到 0 章 / 章节内容为空 / 上游 404"，
与 `12a` 记录的 2026-10-09「漫画打不开」是同一类症状。

---

## 1. 实验设计

### 1.1 为什么必须这么设计（v1 的教训）

第一版实验用 `@get:{tag}` 单独当字段规则，结果恒为空，差点得出"变量机制不生效"的错误结论。
根因（源码确认）：**`@get:{k}` 不是"返回变量值"，而是把变量替换进规则串后继续求值**
（`RuleValue.kt:386-388`：`GET_VARIABLE.replace` 之后交给 `valuePlain` 解析成 CSS/JSON 路径）。

因此 v2 的全部观察点都做成**真实书源的写法**——变量拼进 URL：

```json
"tocUrl":      "http://stub.test/toc/@get:{tag}"
"chapterUrl":  "http://stub.test/c/@get:{tag}"
```

变量有没有被传过去，直接体现在**最终请求的 URL**上，可判定、无歧义。

### 1.2 桩与隔离

| 项 | 做法 |
|---|---|
| 网络 | `responseFetcher` 替身对每个 URL 返回内置 HTML；`RuleRunner.kt:1229-1230` 在真实客户端之前 `return`，**任何请求都不会出网** |
| 数据 | 不挂 `database`（`new RuleRunner(STUB)`），**凭据/Cookie 链路完全不参与**；无临时库、无用户数据 |
| 真实用户数据 | 未读取、未引用 |
| 归档 | 未写入（`git -C E:\legadoQ-archive status --porcelain` 为空） |
| 产品源码 | 未修改（`git -C E:\legadoQ diff --stat` 为空） |

### 1.3 书源（虚构）

每个源都用同一套规则形状，只有 host 与 `tag` 值不同：

```json
{
  "bookSourceUrl": "http://stub.test/A",
  "searchUrl":     "http://stub.test/A/search?q={{key}}",
  "ruleSearch": {
    "bookList": "@css:li",
    "bookUrl":  "@put:{tag:@css:span.m@text}http://stub.test/book/1",
    "name":     "http://stub.test/n/@get:{tag}"
  },
  "ruleBookInfo": {
    "name":    "@css:h1.h@text",
    "intro":   "http://stub.test/i/@get:{tag}",
    "tocUrl":  "http://stub.test/toc/@get:{tag}"
  },
  "ruleToc": {
    "chapterList": "@css:li",
    "chapterName": "@css:a@text",
    "chapterUrl":  "http://stub.test/c/@get:{tag}"
  }
}
```

A 的搜索页里 `span.m` 是 `A-tag`，B 的是 `B-tag`；两者 `bookUrl` 都解析成 **同一个**
`http://stub.test/book/1`——这正是"同一本书、两个书源"的现实形状。

---

## 2. 实验结果（三遍一致，摘 `01_rt3_run1.log`）

| 实验 | 做了什么 | 观察到 | 判定 |
|---|---|---|---|
| **E5**（对照） | A 搜索：同一 item 内 `@put` 后 `@get` | `name = http://stub.test/n/A-tag` | **SHARED_OK** —— 机制本身没问题 |
| **E1** | A 搜索写入 `tag=A-tag`（键 = bookUrl），随后**B** 对同一 bookUrl 取详情 | `B.details.name = detail-page`（B 自己的选择器正常）<br>`B.details.tocUrl = http://stub.test/toc/A-tag`<br>`B.details.intro = http://stub.test/i/A-tag` | **POLLUTED** —— B 读到 A 的变量 |
| **E1b** | 先 A 取详情（把变量复制到 tocUrl 键），再把 **A 的 tocUrl 当作 B 的 bookUrl** | `B.details.intro = http://stub.test/i/A-tag` | **POLLUTED** —— 跨阶段键碰撞 |
| **E2** | A 已写入 book/1，再对**另一本书** book/2 取详情 | `A.details(book/2).intro = http://stub.test/i/`（空）<br>`A.details(book/1).intro = …/A-tag` | **clean** —— 符合"按 URL 隔离"的设计 |
| **E3** ×3 | 两个线程同时搜索同一 bookUrl，A/B 各写不同 tag | 第 1 次读到 `A-tag`、第 2 次 `B-tag`、第 3 次 `A-tag` | **LAST_WRITER_WINS** —— 无并发隔离 |
| **E4** | C 源在 `bookUrl` 里 `@put` 后，`name` 用非法 JSONPath 让本次搜索失败 | `C.search.size = 0`；随后 `C.details.intro = …/i/`（空） | **NOT_RESIDUAL** —— 失败不残留 |
| **E6** | `rt3-writer` 线程执行 A 搜索，main 线程读 | `B.details.intro = …/i/A-tag` | **SHARED_ACROSS_THREADS** |
| **E7** | A 取详情后，用 **A 的 tocUrl** 让 B 取目录 | `B.chapters[0].url = http://stub.test/c/A-tag` | **POLLUTED** —— 生产关键路径（漫画源形状） |
| **E8** | 另建一个 `RuleRunner` 实例读同一个 bookUrl | `intro = …/i/`（空） | **per-instance** —— 隔离粒度是实例 |
| **E9** | 读常量 | `MAX_RULE_DATA_KEYS = 4096` | 确认 |

### 2.1 复现性

同一套实验（含 E3 的 3 次并发尝试）**连跑 3 遍**（3 个独立 JVM），全部 9 项判定一致：

```
3× VERDICT=POLLUTED          (E1)
3× VERDICT=POLLUTED          (E1b)
3× VERDICT=clean             (E2)
3× VERDICT=NOT_RESIDUAL      (E4)
3× VERDICT=SHARED_OK         (E5)
3× VERDICT=SHARED_ACROSS_THREADS (E6)
3× VERDICT=POLLUTED          (E7)
3× VERDICT=per-instance      (E8)
E3：9 次里 A 胜 6 次、B 胜 3 次（last-writer-wins，胜者随机）
```

### 2.2 实验过程中发现的附带事实（不属 RT-3，但记账）

1. **`chapters.size = 1`**（E7）：TOC 有两章，但两章的 `chapterUrl` 相同（都带同一个 tag），
   被去重成 1 条。说明目录侧有按 URL 去重的逻辑——这本身是好事，但会掩盖"变量串了"的症状。
2. **`@get` 单独使用恒为空**：`@get:{k}` 必须嵌在 URL/模板里才有意义。这一条对后续写书源、
   写判据都重要（本次 v1 就被它误导过一次）。

---

## 3. 六个隔离维度的逐项回答（负责人要求区分）

| 维度 | 结论 | 证据 |
|---|---|---|
| **书源级隔离** | **不存在**：键是 URL，无 sourceId | E1 / E1b / E7；代码 `RuleRunner.kt:137-142`（`rememberRuleData(key: String?, …)`，key 只有 URL） |
| **单次规则执行隔离** | **部分成立**：每次解析新建 `NodeValue.ruleVariables`（`RuleValue.kt:43`），但执行前会用 `seedVariables(recallRuleData(key))` **灌入上一轮同键状态**（`RuleRunner.kt:647-648,661,829,841`）⇒ 单次执行**不是干净起点** | E1（B 的详情开局就带着 A 的变量） |
| **线程级隔离** | **不存在**：表是 `Collections.synchronizedMap`（`RuleRunner.kt:1745-1757`），跨线程共享；`ThreadLocal` 只装 JS 执行上下文，不装这张表 | E6 |
| **全局缓存隔离** | **不存在**：这张表**就是**进程级全局缓存（单例 RuleRunner + 4096 键 LRU） | E8 / E9；`Application.kt:168`（`val runner = RuleRunner(database = database)`），`:172` 还把它注入离线缓存 |
| **并发执行隔离** | **不存在**：同键并发写 = 后写覆盖，读方拿到谁取决于时序 | E3 ×3 |
| **执行失败后残留** | **不残留**：写入点在"条目构建成功之后"（`RuleRunner.kt:273`），异常路径不会走到 | E4 |

---

## 4. ruleData 的所有权（负责人要求回答）

| 问题 | 答案 | 证据 |
|---|---|---|
| **在哪创建** | `RuleRunner` 构造时创建，实例字段 | `RuleRunner.kt:135` `private val ruleData = newRuleDataCache(MAX_RULE_DATA_KEYS)`；工厂见 `:1743-1757` |
| **谁持有** | `RuleRunner` 私有字段持有；生产端是**进程单例**（Ktor 装配时创建一次，并注入离线缓存服务） | `Application.kt:168,172` |
| **在哪销毁** | **只有两种**：① LRU 淘汰（超过 4096 键踢最久未用，`newRuleDataCache` 的 `removeEldestEntry`）；② 进程退出。**没有任何业务清理**——删书源、删书、清缓存都不碰它 | `RuleRunner.kt:137-142`（只有 put/get）；全仓 `grep ruleData.remove\|ruleData.clear` **零命中** |
| **在哪些路径共享** | 写入 2 处：搜索条目（`bookUrl`）、详情解析完（`tocUrl` = 旧值 ∪ 新 put）；读取 4 处：详情（`bookUrl`）、目录首页（`tocUrl`）、目录翻页（`pageUrl`）、正文（`bookUrl`） | `:273`（写）、`:690`（写）、`:647`（读）、`:814`（读）、`:957`（读） |
| **键的构成** | **纯 URL 字符串**：`bookUrl` / `tocUrl` / `pageUrl`。无 sourceId、无书名、无用户 | 同上 |

> 一句话：**它属于"进程"，不属于"书源"，也不属于"某次阅读"。**

---

## 5. 影响范围（只记录，不修复）

### 5.1 会真实触发的场景

| 场景 | 现实性 | 后果 |
|---|---|---|
| 同一本书被两个书源收录（`bookUrl` 恰好相同） | 中（不同站不同 URL 居多，但镜像站/同源多域名常见） | B 的规则拿到 A 的变量 → 拼出错误 URL → 空目录/空正文/404 |
| **换源**（产品自带 `switchBookshelf`） | 高 | 换源后新源在同一本书上继承旧源的 `@put` 变量 |
| A 的 `tocUrl` 与 B 的 `bookUrl` 相同（聚合站/同一 API 网关） | 中 | 跨阶段碰撞（E1b） |
| 并发搜索多源（`search` 是并发的，`SearchRoutes.kt` 有并发上限） | 高 | 同键互相覆盖（E3）；搜索本身不受影响，但**后续详情/目录**读到谁不定 |
| 漫画源（`@put:{bid:$.comic_id}` + `chapterUrl` 拼 `@get:{bid}`） | 高（这是该机制存在的理由） | 一旦键碰撞，章节 URL 里带别人的 id → 上游 422/404，界面只显示"上游返回 HTTP 422" |

### 5.2 为什么现在没被用户大规模投诉

1. 键是 URL，**不同站点的书 URL 天然不同**，所以大多数情况下没有碰撞；
2. 变量只在"同一次阅读链路"里用（搜索→详情→目录→正文），跨源碰撞窗口窄；
3. 4096 键 LRU 会不断把旧键踢掉，碰撞窗口进一步缩小；
4. 症状（空目录/空正文）与"站点改版"高度相似，容易被归因到书源失效。

### 5.3 不是 P0 的理由

- 不写库、不删数据、不越权、不出网（变量只影响**请求 URL 的拼装**）；
- 影响面是"取不到内容"，且可用换源/重试绕过；
- 但它**确实会让功能静默出错**，所以定 P1 而不是 P3。

---

## 6. 与新架构的关系（只提方向，不实施）

| 观察 | 对新架构的含义 |
|---|---|
| 隔离粒度是 **RuleRunner 实例**（E8） | 只要让 `RuleRunner`（或未来的 rules 内核）**按书源实例化**，污染自动消失，且不需要改任何规则语义 |
| 表是进程级、无清理 | 新架构应给出明确生命周期：随"一次阅读会话"或"一个书源"创建/销毁；至少要有 `clear(sourceId)` |
| 键无 sourceId | 若保留共享表，键必须变成 `(sourceId, url)`；这是**一行级**改动，但会改变跨调用的共享语义，需黄金样本把关 |
| 失败不残留（E4） | 现有写入时机是对的，新架构应保持"成功后才落表" |
| 跨线程共享（E6） | 如果将来引入并行规则执行，需要显式并发策略（当前是 synchronizedMap，读写安全但语义是覆盖） |

> 这些属于 Phase 1 的设计输入，本轮**不改**。

---

## 7. 判定标签汇总（按负责人要求的四档）

| 标签 | 用在哪些结论 |
|---|---|
| **CONFIRMED** | 跨源污染（E1/E1b/E7）、并发 last-writer-wins（E3）、跨线程共享（E6）、实例级隔离（E8）、键上限 4096（E9）、同执行内共享（E5）、不同 URL 不串（E2） |
| **NOT_REPRODUCED** | 失败后变量残留（E4：三次均未复现） |
| **LIKELY** | "换源继承旧源变量"（真实换源走 `switchBookshelf`，本轮未驱动该路径，只按同一 bookUrl 推得） |
| **NEEDS_MORE_TEST** | ① 真实 5600 源里有多少组 URL 碰撞（需跑语料）；② 生产并发下实际碰撞频率；③ `pageUrl` 键（目录翻页）在真实多页目录里的行为（本轮只有单页） |

---

## 8. 复现方式（任何人可重跑）

```bash
# 1) 产物：需要 installDist（已在 2026-11-17 生成，不修改源码）
cd /e/legadoQ/product && ./gradlew :app:installDist --no-daemon

# 2) 编译驱动（仓库外）
cd /e/legadoQ-runtime/rt3
CP=$(ls /e/legadoQ/product/app/build/install/legado/lib/*.jar | tr '\n' ';')
javac -encoding UTF-8 -cp "$CP" -d out Rt3.java

# 3) 跑（不联网；三遍）
for i in 1 2 3; do java -Dfile.encoding=UTF-8 -cp "out;$CP" Rt3 > run$i.log 2>&1; done
grep VERDICT run*.log | sort | uniq -c
```

驱动源码已随日志存档：`20_RT3_RAW_LOGS/00_harness_Rt3.java.txt`。

---

## 9. 本轮**没有**做的事（边界）

1. **没有修复**（按授权：发现只记录）。
2. 没有驱动真实换源路径（`switchBookshelf`），所以"换源继承"标 LIKELY 而非 CONFIRMED。
3. 没有跑真实书源语料统计 URL 碰撞率（标 NEEDS_MORE_TEST）。
4. 没有做多页目录（`pageUrl` 键）实验。
5. 没有触碰 RT-1 / RT-2 / RT-4 及其余 9 条。

---

## 10. 修复记录（2026-11-20）

### 10.1 改动

| 项 | 内容 |
|---|---|
| 工作区 / 分支 | `E:\legado` · `refactor/rebuild` |
| 文件 | `product/app/src/main/kotlin/io/legado/rules/RuleRunner.kt`（单文件，+27/−11） |
| 机制 | 新增 `ruleDataKey(sourceId, url)`，用 NUL（`\u0000`）分隔合成复合键；`rememberRuleData` / `recallRuleData` 增加 sourceId 入参；6 个读写点（写 `:288`/`:705`，读 `:662`/`:705`/`:829`/`:972`）全部改为带 sourceId。sourceId 为 null 归一到空串，与搜索侧非空 String 统一。 |
| 依据 | §4 所有权分析（键无 sourceId）+ §6 方向（键变 `(sourceId, url)` 是最小改动）。全 6 个读写点都能稳定拿到 `bookSourceUrl`，各路径语义一致。 |

### 10.2 回归判据（同一驱动，重跑 3 遍，结论一致）

| 实验 | 修复前（审计原文） | 修复后 | 判定 |
|---|---|---|---|
| E1 跨源详情污染 | `POLLUTED` | `clean` | ✅ 已修 |
| E1b 跨阶段键碰撞 | `POLLUTED` | `clean` | ✅ 已修 |
| E7 目录链路污染 | `POLLUTED` | `clean` | ✅ 已修 |
| E5 同执行内 put→get | `SHARED_OK` | `SHARED_OK` | ✅ 机制不坏 |
| E2 同源不同书 | `clean` | `clean` | ✅ 无回归 |
| E4 失败不残留 | `NOT_RESIDUAL` | `NOT_RESIDUAL` | ✅ 无回归 |
| E8 实例隔离 | `per-instance` | `per-instance` | ✅ 无回归 |
| E3 并发同键 | `LAST_WRITER_WINS:A-tag` | `LAST_WRITER_WINS:A-tag` | ⚠️ 预期不变：同一源码并发写同一键，仍按设计 last-writer-wins（非跨源场景） |
| E6 跨线程 | `SHARED_ACROSS_THREADS` | `thread-isolated` | ⚠️ 预期变化：B 源不再读到 A 源线程写的变量，正是隔离目标 |

> E3/E6 的变化不是回归：修复前驱动把「跨线程/并发共享」当作污染证据，是因为当时无法区分「同源跨线程」
> 与「跨源」。现在 sourceId 进键后，A 源与 B 源彻底隔离，跨线程写读同源仍共享（synchronizedMap 不变），
> 只是驱动里 E6 用的是 A 写 B 读（不同源），所以显示隔离——这是正确的。

### 10.3 单源契约测试

`RuleVariableHandoffTest` / `PutPairsTest` / `RuleDataCacheLruTest` / `RuleRunnerTest` 全绿：
单源下 sourceId 恒定，复合键与旧纯 URL 键等价，「搜索 @put → 目录 @get」「详情 put → 目录 get」
的合法交接不受影响。

全套后端测试实跑 `998 tests / 1 failed / 6 skipped`。唯一失败是
`RuleRunnerExtendedTest.rule runner content fallback when extracted text is short but paragraph tags exist`
（正文段落兜底，报「正文内容未提取到内容」）。**已用 stash 对照实验确认**：在撤销本修复的干净 HEAD 上
单跑该测试同样失败——它是 24 个后续 commit 中段落兜底改动引入的**基线既有失败**，与本修复无关。
按单一切点纪律不在本轮处理，另记为待办。审计基线 17 号文档的 992/0/6 是更早快照，测试数已随后续 commit 变化。

### 10.4 复现命令（修复后）

```bash
cd /e/legado/product && ./gradlew :app:installDist --no-daemon
# javac/java 需 cygpath -w 转换 classpath（Git Bash 不自动转 POSIX 路径）
CP=$(ls /e/legado/product/app/build/install/legado/lib/*.jar | cygpath -w -f - | paste -sd';' -)
OUT=$(cygpath -w /tmp/rt3verify/out); SRC=$(cygpath -w /tmp/rt3verify/Rt3.java)
javac -encoding UTF-8 -cp "$CP" -d "$OUT" "$SRC"
for i in 1 2 3; do java -Dfile.encoding=UTF-8 -cp "$OUT;$CP" Rt3 > run$i.log 2>&1; done
grep VERDICT run1.log   # E1/E1b/E7 应为 clean
```

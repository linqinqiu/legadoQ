# 21 阶段 1 · 架构设计施工图（模块边界表 / R1–R6 / compat 方案）

> 阶段：0 → 1（依据 `09_MIGRATION_ROADMAP.md` §1 退出判据 1.1/1.2/1.3）
> 性质：**设计文档，不含业务代码**。本册把 `08_TARGET_ARCHITECTURE_PROPOSAL.md` 的提案收敛成可签字的施工图。
> 事实基线：`E:\legado` · `refactor/rebuild` @ `8ff04fa`（基于审计基线 `771b311` 前进 30 commit）。
> 生成时间：2026-11-20。所有"当前实测"均带可复现命令，与 11-17 审计快照有出入处已标注。
> **S-1 / S-2 已于 2026-11-20 由负责人确认**（见 §5 签字清单），阶段 1 已批准进入阶段 2。

---

## 0. 结论（先看这一段）

三份交付物齐备，但**有两处必须先由负责人拍板，否则阶段 2 无法开工**：

| # | 开放项 | 为什么卡住 | 我的建议 |
|---|---|---|---|
| **S-1** | compat 断言粒度：逐字节 vs 逐字段语义等价 | `08`/`09` 写"逐字节"，`GoldenRuleTest` 实际是"逐字段 `assertEquals`"，`14` §4.1-#1 直指这是文档与实现的矛盾。口径不统一，阶段 2 的 compat 模块无从实现 | **分层**：正文整段走"逐字符"（`expected.txt`），其余字段走"逐字段等值 + 键集合封闭"（详见 §3.2） |
| **S-2** | 模块边界表按"目标态"还是"当前态"落地 | `08` 的目标（11 域 + kernel 9 包）与当前源码（14 个一级包、无 kernel/、有 port/）差距大；R1-R6 的 grep 判据依赖目标包结构 | 边界表按**目标态**定义；判据自带**迁移期双基线**（目标包名 + 当前包名过渡），见 §2.3 |

其余部分（模块清单、R1-R6 表达式、compat 样本方案）已按审计事实定稿，可直接评审。

---

## 1. 现状对齐（2026-11-20 实测 vs 11-17 审计快照）

> 目的：避免拿过时基线设计判据。`09` 的阶段 2 白名单"今天已知的违例"必须用当前数字。

| 项 | 审计快照（11-17，`09`/`08`） | 当前实测（11-20，`8ff04fa`） | 影响 |
|---|---|---|---|
| 一级包结构 | 目标 11 域 + kernel 9 包 | 实际 14 个：`backup cache content data http localbook model ops port reading rules source subscription tts` | 目标态尚未落地；`kernel/` 不存在，`port/`（4 文件）是过渡物 |
| R4 手动 autoCommit | 12 处待收口（按函数计） | **未收口**：`grep -rn "\.autoCommit\s*="` 共 26 行——DAO 白名单 4 文件（ShelfDao 12 / SourcesDao 8 / SourceHealthDao 2 / CacheDao 2）+ `Database.kt` 门面内 2 行（合法）。注意代码用 `db.autoCommit = false/true` 赋值，**不是** `setAutoCommit()` 方法；按后者写门禁会假绿 | **阶段 3.3 尚未完成**；R4 门禁必须用 `\.autoCommit\s*=` 正则，白名单登记 4 个 DAO 文件 |
| R2 裸 `HttpClient.newBuilder` | 6 处 | 6 处（`DesktopLauncher:313,323`、`UpdateCheck:42`、`ExternalBrowserLogin:99`、`WebViewProxy:60`、`EdgeTtsService:28`）+ 唯一合法签发点 `NetworkSecurity:62` | 数字一致，白名单可沿用 |
| R5 DTO 越界 | `LogEntry`@`ops/LogService.kt:178` | `ops/`、`http/`、`data/`、`rules/` 等 10 个文件含 `@Serializable`（详见 §2.2 R5） | 违例面比审计记录的大，需完整登记 |
| `rules → data/source/http` 横穿 | 已清零 | **仍为 0**（`rules/` 只 import content/model/ops/port/rules） | 保持硬红 |
| 测试总数 | 992/0/6（11-17） | 998/0/6（11-20，见 `20` §10） | compat 基线用 998 |

---

## 2. 交付物一 · 模块边界表（1.1）

### 2.1 目标态分层（取自 `08` §1，D-1 已决策：按域纵切 + 共享内核）

```
组合根 app/（Application / StaticWeb / 路由装配）
   │ 只依赖各域 <domain>Api 接口，唯一 new HttpClient + 唯一装配处
   ▼
域模块 ×11（每域内固定 api/ domain/ data/ 三层）
   source  shelf  reading  search  explore  localbook  media
   backup  rss  tts  login
   ▼ 单向依赖
kernel ×9（无业务语义，被所有域依赖，自己谁也不依赖）
   db  fetch  rules  jssandbox  text  webproxy  model  obs  safety
```

### 2.2 模块边界表

> "公开 Api"= 该包允许被跨域 import 的接口集合；"允许依赖"= 该包可以 import 的包。kernel 内部依赖以 `08` D-2/D-3 为准（rules 只依赖 fetch 窄接口 + text）。

#### kernel（9 包）

| 包 | 职责 | 公开 Api | 允许依赖 |
|---|---|---|---|
| `kernel/db` | 连接池/Schema/Migration/事务门面 | `read{}` `write{}` `transaction{}`、`SchemaVersion` | 仅 `kernel/model` `kernel/obs`；禁止任何域 |
| `kernel/fetch` | 唯一出站原语：SSRF 闸门+IP 固定+重定向+限读+预算 | `Fetch` 接口、`FetchRequest/Response`、`newHttpClient()` 唯一签发 | `kernel/model` `kernel/obs` `kernel/safety` |
| `kernel/rules` | 规则求值引擎（含本次 RT-3 修复的 ruleData） | `RuleRunner` 公开方法（search/details/chapters/content…） | `kernel/fetch` 窄接口、`kernel/text`、`kernel/model` |
| `kernel/jssandbox` | Rhino 沙箱 + Java 桥白名单 | `JsSandbox`、`BoundedJs`、桥白名单注册 | `kernel/model` `kernel/obs` |
| `kernel/text` | 字符集/编解码/净化/模板替换 | 纯函数原语（`Charset`/`cleanContent`/`renderUrl` 等） | 无（纯函数，最低层） |
| `kernel/webproxy` | 内置浏览器登录代理原语 | 代理会话接口 | `kernel/model` `kernel/obs` |
| `kernel/model` | 全部 DTO（一概念一类型） | 所有 `@Serializable` data class / enum | 无（纯数据） |
| `kernel/obs` | 日志/指标/脱敏 | `log`、`Metrics`、脱敏函数 | `kernel/model` |
| `kernel/safety` | 启动闸门/同源写门/凭据域判定 | `requireLoopbackBind`、同源写门、凭据域判定 | `kernel/model` `kernel/obs` |

#### 域模块（11 域，每域 api/domain/data 三层）

| 域 | 职责（`08` §1 原文） | 公开 Api（`api/` 对外） | 允许依赖 |
|---|---|---|---|
| `source` | 书源 CRUD·编解码·导入导出·体检·订阅 | `SourceApi`（查询/保存/健康检查结果） | 全部 kernel；不直接 import 其他域 `data/` |
| `shelf` | 书架·分组·批量·换源 | `ShelfApi`（书架条目/分组/进度写） | kernel；换源需 `source.Api`、`reading.Api` |
| `reading` | 目录·正文·进度·笔记·书签·分页事实 | `ReadingApi`（目录/正文/进度/笔记） | kernel；正文用 `kernel/rules` |
| `search` | 多源并发搜索·流式返回·会话 | `SearchApi`（搜索会话/流） | kernel；用 `source.Api` 取源、`kernel/rules` 求值 |
| `explore` | 发现页 | `ExploreApi`（发现标签/列表） | kernel；用 `source.Api` |
| `localbook` | TXT/EPUB·分章规则 | `LocalBookApi`（本地书解析/分章） | kernel；不依赖 `source`（虚拟源 id 在域内） |
| `media` | 图片·封面·音频·文件代理 | `MediaApi`（图片/封面/文件代理） | kernel/fetch、kernel/model |
| `backup` | 导出·导入·快照·冲突·回滚 | `BackupApi`（导出/导入/快照/恢复） | kernel；跨 6 域数据由组合根编排，不直接 import 域 `data/` |
| `rss` | 订阅源·文章 | `RssApi`（订阅/文章列表） | kernel；文章正文用 `kernel/text` |
| `tts` | provider 接口 + Edge 实现 + 会话 | `TtsApi`（provider 接口/会话） | kernel/fetch、kernel/model |
| `login` | 凭据·Cookie·内置浏览器会话 | `LoginApi`（登录态/凭据查询） | kernel/webproxy、kernel/safety、kernel/model |

### 2.3 迁移期双基线（落地策略）

目标包结构目前不存在，判据不能一步到位。分两段：

- **阶段 2（判据上线）**：R1/R3 用"当前包名"作为过渡白名单——kernel 概念暂由 `rules/ model/ ops/ port/ text相关` 承担，域概念暂由 `source/ reading/ http/` 等承担。判据表达式同时认识目标名与当前名。
- **阶段 3–4（逐域迁移）**：每搬一个域，白名单中删一项；`kernel/` 建立后 R1 切换为硬红。
- **纪律**：白名单只许单调缩小（复用 `depth-check.mjs` 的 `KNOWN_DEEP` 模式，见 `09` §2.1）。

---

## 3. 交付物二 · 依赖规则 R1–R6 可执行形式（1.2）

> 定义来源：`08` §1.1（R1–R6 原文表）。判据形式对齐 `09` §2.1 的 G1–G6。
> **R 与 G 的映射**：R1=G1，R2=G2+G3（SQL 与 HTTP 两条），R4=G4，R5=G5；R3（跨域只走 api）、R6（样式）在 G1–G6 无独立对应，建议阶段 2 增列为 G7/G8。见 §3.3。

### 3.1 R1–R6 判据表

| # | 规则（08 原文） | 可执行 grep 表达式 | 当前白名单基线（11-20 实测） | 对应门禁 |
|---|---|---|---|---|
| **R1** | `kernel/*` 不得 import 任何域 | `grep -rn "import io\.legado\.\(source\|shelf\|reading\|search\|explore\|localbook\|media\|backup\|rss\|tts\|login\)" <kernel路径>` | **0**（当前无 kernel/；`rules/` 对域为 0，可先对 `rules/` 硬红） | G1 |
| **R2a** | 只有 `data/` 能拼 SQL | `grep -rn "executeQuery\|prepareStatement" --include=*.kt \| grep -v "/data/"` | 待登记（审计标注 `http/`、`rules/` 有直连，本轮未精确复测） | G2 |
| **R2b** | 只有 app+kernel/fetch 能 new HTTP 客户端 | `grep -rn "HttpClient\.newBuilder" --include=*.kt \| grep -v "NetworkSecurity.kt"` | **6 处**（DesktopLauncher×2 / UpdateCheck / ExternalBrowserLogin / WebViewProxy / EdgeTtsService）；`NetworkSecurity:62` 为唯一合法签发点 | G3 |
| **R3** | 域之间只走对方 `api/`，不得 import 对方 `data/` | `grep -rn "import io\.legado\.<域>\.data" --include=*.kt`（任意跨域） | 真环 2 对：`data↔source`、`cache↔data`、`data↔ops`、`content↔rules`（`ArchitectureBoundaryTest:344` 基线 4 对） | 建议新增 G7 |
| **R4** | 禁止手动 `autoCommit` | `grep -rn "\.autoCommit\s*=" --include=*.kt \| grep -v "/Database.kt"`（门面内合法；目标态改为 `kernel/db`） | **4 文件**：`data/ShelfDao.kt`(12) `data/SourcesDao.kt`(8) `data/SourceHealthDao.kt`(2) `data/CacheDao.kt`(2)；门面 `Database.kt`(2) 合法。**注意用 `.autoCommit =` 而非 `setAutoCommit()`** | G4 |
| **R5** | DTO 只允许在 `model/` | `grep -rn "@Serializable" --include=*.kt \| grep -v "/model/"` | **11 文件**：`BrandStore` `data/CookieDao` `data/DbSnapshot` `http/BackupRoutes` `http/SourcesRoutes` `localbook/TxtTocRule` `ops/LogService` `ops/Metrics` `rules/RuleProcessor` `rules/RuleRunner` `source/SourceDebugger` | G5 |
| **R6** | 新样式不得进全局 CSS | `wc -l styles.css` 上限 + 增量检查（复用 `depth-check.mjs` 模式） | `styles.css` 6,757 行（目标单调下降） | 建议新增 G8 |

### 3.2 与现有判据的关系

`ArchitectureBoundaryTest.kt`（`product/app/src/test/kotlin/io/legado/`，6 条）已实现的判据：java 桥白名单、model 不反向 import、rules→data/source/http 清零、http 仅自身/组合根 import、engine↛infra、包间无 2-环（基线 4 对）。

- R1 的当前态 ≈ 现有判据 3（`rules→data/source/http=0`），已绿。
- R3 的当前态 ≈ 现有判据 6（无 2-环，基线 4 对），已绿。
- R5 的当前态**弱于** 现有判据——现有判据 2 只查 model 不反向 import，不查 DTO 定义位置；R5 需新增。
- 结论：R1–R6 不是推翻现有 `ArchitectureBoundaryTest`，而是**补齐它没覆盖的 R2/R5/R6**，并把 R1/R3 从"当前包名"迁移到"目标包名"。

### 3.3 需负责人确认：G 集合扩为 8 条

`09` 阶段 2 只列了 G1–G6，缺 R3（跨域走 api）、R6（样式）。建议阶段 2 上线 **G1–G8**，否则 R3/R6 无门禁承载。此项并入 S-2 一并签字。

---

## 4. 交付物三 · compat 方案（1.3）

### 4.1 输入与覆盖目标

- 现有样本：`product/app/src/test/resources/rule-golden/` 6 目录 15 文件（`search-css` `details-toc-json` `content-css` `rss-articles` `login-v1-js` `login-v2-js`）。
- 增量样本：`14` §5 建议补的 7 个 golden + 可选第 8（`rss-absolutize`）；Q-9 决策已定扩到 8–10 类。
- 覆盖链路（`09` §2.2）：搜索 / 详情 / 目录 / 正文 / 登录 v1 / 登录 v2 / RSS / 分页，8 条各 ≥1 样本。
- 录制-回放：新样本的输入响应离线化为 `source.json` + 响应体 + `expected.*`；`GoldenRuleTest.kt:44-46` 已用 classLoader 读 `rule-golden/**`，直接沿用。

### 4.2 断言粒度（S-1，核心决策）

**矛盾事实**：`08`/`09` 写"逐字节一致"，但 `GoldenRuleTest` 6 例实际是逐字段 `assertEquals`（`14` §4.1-#1 原文："全文逐字节/逐字符比对根本不存在"）。两者必须统一，否则阶段 2 的 compat 模块不知道该断什么。

**建议方案（分层断言）**：

| 层 | 对象 | 断言粒度 | 理由（证据） |
|---|---|---|---|
| L1 正文整段 | `content-css` 及新增漫画源样本 | **逐字符** `expected.txt` equals（含 `\n`/空行/图片占位行位置/首尾空白） | `14` §4.1-#1：正文换行变会漂阅读落点 `logicalPosition`，现有 golden 全绿 |
| L2 结构化字段 | 搜索/详情/目录/RSS/登录 | **逐字段等值 + 键集合封闭**（`assertEquals` 每字段 + 断言 DTO 字段集无增无减） | `GoldenRuleTest` 现状即逐字段；封闭键集补上"不接受多余字段"（`14:22`） |
| L3 请求形态 | 需要证明"请求了几次/什么 URL"的样本（putget 生命周期、翻页、header 继承） | **整串 URL equals + 请求序列 equals** | `14` §5-#5/#6/#7：请求次数与 header 继承从没被断言 |
| L4 二进制 | 图片解密 | **逐字节** `assertArrayEquals`（前 8 字节 PNG 头） | `ImageDecodeTest` 既有口径，沿用 |

> 采用 L1–L4 后，"逐字节"只在确有必要的 L1/L4 使用，其余用"逐字段 + 封闭键集"，与 08 的意图（行为不变）一致、与 GoldenRuleTest 现状兼容。需负责人签字确认 S-1。

### 4.3 最小黄金样本集（取自 14 §5，Q-9 已批准扩充）

| # | 目录名 | 覆盖 | 期望输出形态 | 优先级 |
|---|---|---|---|---|
| 1 | `content-css`（改造） | CSS 正文 + 净化 | `expected.txt` 整段逐字符 equals | **最优先** |
| 2 | `xpath-search` | 裸 `//` + `@xpath:` + 多节点拼接 + 属性 | 条数 + 每条 name/bookUrl 整串 | 高 |
| 3 | `regex-allinone-toc` | `:` 前缀 + 多级 `&&` + `$n##` + `$n<js>` | 章数 + 章名/url 整串 equals + 广告零条 | 高 |
| 4 | `js-list-search` | `<js>` 三种返回类型（数组/JSON 串/HTML 串） | 每种 `listOf(name…)` equals | 高 |
| 5 | `putget-lifecycle` | `@put/@get` 三阶段 + 两书交错 + 同名覆盖 | 两本书目录 URL 整串 equals 且互不串味 | 高（**RT-3 修复后应立即补，防回归**） |
| 6 | `toc-paging-loop` | `nextTocUrl` + 环守卫 + `{{page}}` | 章名 list + index list + **请求 URL 序列** equals | 中 |
| 7 | `image-decode-rule` | `imageDecode` 端到端 | 前 8 字节 equals PNG 头 + 失败回落负例 | 中 |
| 8（可选） | `rss-absolutize` | 相对链接绝对化 | `expected.json` 存绝对 URL | 低 |

### 4.4 compat 模块形态（阶段 2 落地目标）

- 位置建议：独立 Gradle module `compat/`，或从 `GoldenRuleTest` 抽出 `compat` source set——**待架构确认**（不引入新依赖，仅复用现有 JUnit + classLoader 读 fixture）。
- 入口：一个参数化的 runner，输入 `source.json + 响应体 + expected.*`，输出逐层断言结果；每个 golden 目录一条 case。
- 退出判据（阶段 2）：不改任何实现，compat 能跑通现有 6 类 + 新增 7 类 golden，全绿；白名单/样本数被打印记录。
- 规则：`任何重建步骤先让 compat 绿`（`08` D-5）。

---

## 5. 签字清单（阶段 1 退出判据）

| # | 需负责人签字 | 当前状态 |
|---|---|---|
| 1.1 模块边界表 | §2（11 域 + kernel 9 包 + 迁移期双基线） | ✅ 成文，待签 |
| 1.2 R1–R6 可执行形式 | §3（表达式 + 当前实测白名单 + G 映射） | ✅ 成文，待签 |
| 1.3 compat 方案 | §4（输入/覆盖/分层断言/样本集） | ✅ **2026-11-20 已签**：采纳 L1–L4 分层断言 |
| S-2 目标态 vs 当前态 | §2.3 / §3.3 | ✅ **2026-11-20 已签**：目标态 + 迁移期双基线；G 扩为 8 条（新增 G7 跨域走 api、G8 样式行数） |
| 前置决策 Q-1/Q-3/Q-5 | `11` §A | ✅ 已决策（README §已明确的决策） |

> **2026-11-20 负责人已确认 S-1 / S-2，阶段 1 退出判据全部满足，批准进入阶段 2。**
> 阶段 2：先造判据（compat 模块 + G1–G8 门禁），白名单按 §3.1 当前实测值登记，只许单调缩小。

---

## 6. 证据索引

| 结论 | 证据 |
|---|---|
| R1–R6 原文定义 | `08_TARGET_ARCHITECTURE_PROPOSAL.md:69-80` |
| 11 域 + kernel 9 包 | `08:36-46`（域）、`08:57-65`（kernel） |
| D-1/D-2/D-5 决策 | `08:86-101`（D-1/D-2）、`08:128-134`（D-5） |
| G1–G6 门禁 | `09_MIGRATION_ROADMAP.md:49-54` |
| compat 覆盖目标 | `09:60-62` |
| golden 现状（6 目录 15 文件、逐字段断言） | `14_RULE_COMPATIBILITY_MATRIX.md:22,134,224`；`GoldenRuleTest.kt:44-46,115-117,129-135` |
| 逐字节 vs 逐字段矛盾 | `14:170`（§4.1-#1） |
| 7 个补充样本 | `14:192-206`（§5） |
| autoCommit 未收口（4 DAO + 门面 2） | `grep -rn "\.autoCommit\s*=" product/app/src/main/kotlin --include=*.kt`；`Database.kt:113,130,138`（门面）；DAO 白名单 ShelfDao/SourcesDao/SourceHealthDao/CacheDao |
| 6 处裸 HttpClient | `grep -rn "HttpClient.newBuilder"`（DesktopLauncher:313,323 / UpdateCheck:42 / ExternalBrowserLogin:99 / WebViewProxy:60 / EdgeTtsService:28）+ `NetworkSecurity:62` 合法签发 |
| G5 越界 DTO 11 文件 | `grep -rln "@Serializable" --include=*.kt \| grep -v "/model/"` |

---

## 7. 阶段 2 落地记录（2026-11-20）

> S-1 / S-2 签字后实施的判据先行成果。原则：`09` §1.1"这一步禁止改任何业务代码"——本阶段只造尺子。

### 7.1 G1–G8 门禁（判据脚本）

- 文件：`product/tools/verify/architecture-check.mjs`
- 模式：照抄 `depth-check.mjs`（显式基线 Set + fresh/shrunk 双向断言 + 空转哨兵 + 末尾打印各门禁基线数量）。
- CI：被 `gates.yml` 的 `for f in tools/verify/*-check.mjs` 通配自动收编，无需改 workflow。
- 当前基线（实测全绿、只许单调缩小）：

| 门禁 | 白名单基线 | 当前命中 | 形态 |
|---|---|---|---|
| G1 kernel→域 import | 0（硬红） | 0 | rules/ 作过渡扫描面 |
| G2 data/ 外 SQL | 0（硬红） | 0 | — |
| G3 NetworkSecurity 外裸 HttpClient | 6 文件 | 6 | 按文件登记（行号会漂移） |
| G4 手动 autoCommit | 4 文件（ShelfDao/SourcesDao/SourceHealthDao/CacheDao） | 4 | 门面 Database.kt 内合法；正则用 `\.autoCommit\s*=` 而非 `setAutoCommit()`（后者会假绿） |
| G5 model/ 外 @Serializable | 11 文件 | 11 | — |
| G6 端点目录一致 | 由 `ApiContractTest.kt` + `web/test/ApiCatalog.test.ts` 承载 | — | 脚本内 NOTE，不重复实现 |
| G7 跨域 import 对方 data/ | 0（硬红） | 0 | — |
| G8 全局 CSS 行数 | 上限 6760（单调下降） | 6760 | — |

- ⚠️ **修正记录**：21 §3.1 原写"R4 setAutoCommit=0 已收口"系误判——代码用 `db.autoCommit = false/true` 赋值，**非** `setAutoCommit()`；按后者写门禁会永远绿（假绿，正是 depth-check 注释警告的陷阱）。已改正则与白名单，见 §1/§3.1。

### 7.2 compat 模块骨架

- 文件：`product/app/src/test/kotlin/io/legado/compat/CompatHarness.kt` + `CompatGoldenTest.kt`
- 形态：复用 `:app` 测试 source set（不建独立 Gradle module——遵循 `ArchitectureBoundaryTest.kt:16-17`"刻意不建多模块"的既有纪律；21 §4.4 的"待确认"在此定为 source set）。
- 内容：把原 `GoldenRuleTest` 的 6 类 golden（search/details+toc/content/rss/login×2）迁进 `compat` 包，断言遵循 S-1 的 L1–L4：
  - L1 正文逐字符：`assertBodyEquals` 已备，待 `14` §5 样本 #1 接入 `expected.txt`；
  - L2 结构化字段：`assertFieldEquals` 逐字段 + `assertDtoShape` 键集合封闭；
  - L3 请求形态：`assertRequestedSingle`；
  - L4 二进制：沿用 `ImageDecodeTest`。
- 原 `GoldenRuleTest.kt` 已删除（等价迁移，避免判据分裂）。
- 验证：`CompatGoldenTest` 6/6 绿；全量后端测试无回归。

### 7.3 退出判据达成情况

| 09 §2.3 退出判据 | 状态 |
|---|---|
| 6 条门禁在 CI 上跑，白名单数量被打印记录 | ✅ G1–G8 落地，基线数量末尾打印；gates.yml 通配收编 |
| compat 能跑通现有 6 类 golden（不改实现） | ✅ `CompatGoldenTest` 6/6 绿 |
| rules→域横穿=0 | `grep` 实测；`ArchitectureBoundaryTest:287,439`；`03:578` |
| 当前一级包 14 个 | `ls -d product/app/src/main/kotlin/io/legado/*/` |

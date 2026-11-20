# 04 保留 / 提取重构 / 重新实现 / 废弃候选

> 本册是 `REBUILD_PLAN` 的**决策册**：把 02–07 六份审计的事实，收敛成四类判断，供重建排期直接使用。
> **本册不删除任何代码**。这里说的「废弃候选」只是「重建后不再移植」的标记，判断依据逐条给出。
> 路径一律相对 `E:\legadoQ-archive\`（HEAD `771b311`）。

---

## 0. 判定标准（先说清楚我按什么分类）

一条代码归到哪一类，只看四个问题：

| 判据 | 问题 | 为什么这么问 |
|---|---|---|
| **C1 正确性有判据吗** | 有没有测试/黄金样本能证明它现在的行为是对的？ | 没有判据的代码，重构等于赌博（本项目已发生一次：54 处类型错误回退） |
| **C2 有真实调用方吗** | 生产路径上真的在用它，还是「写了但没人调用」？ | 本项目已出现两次「零调用方的层」（`http/HttpClients.kt` 被删、`RuleProcessor` 空转） |
| **C3 错了会不会丢用户数据 / 丢兼容性？** | 涉及 DB 迁移、Cookie、备份、书源语义？ | 这类代码的替换成本永远是估算的 3 倍以上 |
| **C4 病在语义还是病在结构？** | 逻辑本身对、只是放错地方 → 提取；逻辑本身错/不可维护 → 重写 | 区分「搬」和「重造」，直接决定工期 |

四类的含义（与项目负责人的定义一致）：

- **A. 保留**：稳定、正确、有明确价值 → **原样移植，不要边搬边改**。
- **B. 提取重构**：业务逻辑有价值，但架构/调用方式/文件组织不合理 → **搬家 + 收口，逻辑不动**。
- **C. 重新实现**：实现质量差到「继续修补不如重写」 → **保留行为契约（测试/判据），重写实现**。
- **D. 废弃候选**：重复、过时、无使用场景 → **标记，不删；先确认没有隐性使用者**。

---

## 1. 四类统计（先看总账）

| 类别 | 条目数 | 涉及后端行数（估） | 涉及前端行数（估） | 重建工作量占比（估） |
|---|---:|---:|---:|---:|
| A. 保留 | 14 | ~9,800 | ~4,200 | **0%**（只做搬运） |
| B. 提取重构 | 13 | ~9,500 | ~6,500 | **45%** |
| C. 重新实现 | 7 | ~1,200 | ~9,500 | **40%** |
| D. 废弃候选 | 11 | ~13,400（其中 13,334 是 AI 子系统） | ~600 | **15%**（主要是清理与决策） |

> 「行数」是量级估计，用来排优先级，不要当精确值。真实依据见下面每条的 `文件:行号`。

---

## 2. A 类 · 保留（14 项）

> 共同特征：**都是「错了就丢用户数据或丢兼容性」的地方，而且都恰好是测试最厚的地方**。
> 纪律：移植时**先原样复制，跑通判据，再考虑动**。任何「顺手改进」都会让判据失效。

### A1 规则取值方言（后端 · 最高价值）
- **内容**：`@put`/`@get` 变量跨调用保活、`{{}}` 模板、`||`/`&&` 兜底、`%%` 串接、`$.` JSONPath 前缀、`##` 正则分割。
- **证据**：`rules/RuleValue.kt:81,225,297`、`rules/RuleSplit.kt`、`rules/RuleNodeSelection.kt:45`。
- **为什么保留**：这是社区书源的事实语义，**不可重新设计**（`README.md` §书源语法兼容性；受 `gedoor/legado` 事实标准约束）。
- **判据**：`product/app/src/test/resources/rule-golden/**`（6 类样本）+ `RuleRunnerTest`。

### A2 JS 沙箱 + Java 桥白名单
- **内容**：45 类白名单、`setClassShutter{false}`、`else -> error`、不向沙箱注入真实 Java 对象、宿主字节累计预算。
- **证据**：`rules/JsSandbox.kt`（2,100 行）、`rules/JavaPackages.kt`（1,415 行）、`rules/JsGuard.kt`。
- **为什么保留**：本次静态审查**未发现可用逃逸路径**（07 分册 §2），这是全项目最难重建的一块。
- **重建前提**：必须先把「沙箱不变量」写成判据（现状靠 `JsSandboxHostBudgetTest` 等 40 个安全向测试部分覆盖）。**Rhino 升级必须重跑**。

### A3 书源编解码与扩展字段保留
- **内容**：`source.payload` 单列存原文，`SourceCodec` 双向转换，非本产品认识的字段不丢。
- **证据**：`source/SourceCodec.kt`、`data/db/Schema.kt:19-28`（`source` 表 `payload` 列）、`data/SourcesDao.kt:129`。
- **为什么保留**：兼容性的根——丢了它，社区书源一导入就残缺。

### A4 出站闸门 + 连接级 IP 固定（SSRF 三重防护）
- **内容**：解析一次 → 逐 IP 判私网/回环/CGNAT/元数据/ULA → 连同一个已校验地址（关掉 DNS 重绑定 TOCTOU 窗口）；客户端内建重定向关闭、手写跟随每跳重校验。
- **证据**：`ops/NetworkSecurity.kt:54-69`、`ops/PinnedProxy.kt`、`rules/RuleRunner.kt:1267-1307,1316`。
- **为什么保留**：同类项目极少做到这一层；重建时唯一要做的是**把它变成强制入口**（见 C5）。

### A5 数据库 Schema 与迁移机制
- **内容**：`pragma user_version` 藏版本、`BASELINE = TARGET = 1`、有序注册表、同事务、降级拒启动、失败拒启动。
- **证据**：`data/db/Schema.kt:19-194`、`data/db/Migration.kt`、`data/SchemaVersion.kt`、`data/Database.kt`。
- **为什么保留**：机制骨架是对的（05 分册 §3 评价"锚点刚装好还没用"）。**但内容必须修**：见 B5 与 05 分册 §7 的 P0/P1。
- **纪律**：保留的是「机制」，不是「那六段补丁」；实库兼容必须保留（含孤儿表 `book_mark` 的迁移方案）。

### A6 备份导入的容错口径
- **内容**：不落盘解压（无 zip-slip）、按真实字节抗谎报、六域单事务、失败整笔回滚、冲突「跳过并如实回报」。
- **证据**：`backup/BackupImporter.kt`、`data/DbSnapshot.kt`（`VACUUM INTO` + SHA-256 sidecar）。
- **为什么保留**：这个口径是踩过坑才有的，重写会重踩。

### A7 前端唯一 fetch 闸门
- **内容**：全仓**只有 2 处 `fetch(`**（1 处是闸门本身 `lib/performance.ts:204`，1 处是 `/healthz` 探活 `main.tsx:373`），业务代码 0 处裸 fetch；门面 136 键全部有调用点。
- **证据**：`lib/api/client.ts:38-41`（4 个 response 变体）、`lib/api/domains/*`。
- **为什么保留**：这是本项目**工程质量最好的一处**，直接照抄到新架构。

### A8 前端路由单真源
- **内容**：无 router 库，`hash` + 纯数据表 `PAGES` + `renderPage` switch；7 条路由 + 21 个单例浮层。
- **证据**：`lib/pageMeta.ts:31-49`、`app/pages.tsx:43`、`lib/nav.ts:12-50`。
- **为什么保留**：「改一页只加一行」，比路由库更适合单页桌面应用外壳。

### A9 设计内核（可计算配色 + 令牌门面）
- **内容**：38 个 M3 角色可计算、弹簧动效、玻璃材质、`ui/index.ts` 35 行门面 + 分层判据。
- **证据**：`ui/color/scheme.ts:39`、`ui/index.ts:1-35`、`lib/color/legacy.ts`。
- **为什么保留**：它是**删掉 6,757 行 `styles.css` 的唯一落点**（见 B11）。

### A10 高频状态的外部 store 范式
- **内容**：`useSyncExternalStore` 外部 store，高频搜索状态不重渲染整屏。
- **证据**：`lib/searchStore.ts:182-205`。
- **为什么保留**：全仓最好的状态范式，应当在重建里成为**默认**而不是例外。

### A11 判据机制本身（不是某个测试，而是"用静态判据守边界"的做法）
- **内容**：`ArchitectureBoundaryTest`（4 条硬边界，`rules→data/source/http` 横穿已清零）、`RouteMountTest`（路由必须挂载）、`web/test/ApiCatalog.test.ts`（端点目录双向钉住）、`depth-check.mjs`（巨型文件预算只许单调缩小）、`run-all.ts:18`（扫出的测试文件 < 60 份直接 `exit 1`，防"假绿"）。
- **证据**：`product/app/src/test/kotlin/io/legado/ArchitectureBoundaryTest.kt`、`product/web/test/ApiCatalog.test.ts:91`、`product/web/test/run-all.ts:18`、`product/tools/verify/depth-check.mjs`。
- **为什么保留**：这是这个项目的**方法论资产**。但注意它也有盲区（见 D2、D6）——重写时要**扩大判据覆盖面**，而不是原样照搬。

### A12 规则黄金样本集
- **内容**：`test/resources/rule-golden/` 下 6 类：`content-css`、`details-toc-json`、`login-v1-js`、`login-v2-js`、`rss-articles`、`search-css`。
- **证据**：`product/app/src/test/resources/rule-golden/**`、`GoldenRuleTest`。
- **为什么保留**：**这是"重建后兼容性没退化"的唯一客观判据**。移植顺序上应当**先搬样本，再搬实现**。

### A13 本地书解析与 TXT 分章规则
- **内容**：`localbook/LocalBookParser.kt`（27K）+ `localbook/TxtTocRule.kt`（23K）+ 分章规则的可编辑模型。
- **证据**：`localbook/`、`TxtTocRuleTest`、`LocalBookParserTest`。
- **为什么保留**：纯函数、有判据、与网络无关，是最容易无损搬迁的一块。

### A14 契约自描述（`agent-api.json` + 运行时注入）
- **内容**：随包端点目录，响应时把 `version`/`count`/`baseUrl` 换成运行时真值（避免"人填的必然漂移"）。
- **证据**：`http/RouteCatalog.kt:45-48`、`product/app/src/main/resources/agent-api.json`。
- **为什么保留**：思路对。**但要修覆盖面**：现在漏 2 条注册端点 + 6 条 `/brand`（见 B12）。

---

## 3. B 类 · 提取重构（13 项）

> 纪律：**逻辑一行不改**，只改承载结构；每次搬家之后必须跑对应判据。

### B1 `RuleRunner` 的 HTTP 段抽出去（最高优先级的结构手术）
- **现状**：规则求值、HTTP 获取、登录、分页全在一个类里（1,758 行），其中 HTTP 段 260 行在 `rules/RuleRunner.kt:1174-1437`。
- **为什么必须动**：`JsSandbox(this)` 反向依赖主类 → **「给脚本外出加预算/加闸门」无处下钩**（07 分册 P1-5：书源 JS 无外呼次数/并发预算）；且抓取+解码逻辑**被复制了 8 份**，其中 3 份漏闸门、漏 `GzipLimits`。
- **怎么动**：抽出窄接口 `Fetch(target, headers, body) -> Response`，把 8 份抓取合并为 1 份，**每份各自的差异（编码、限读、重试）变成参数而不是分叉**。
- **风险**：`AGENTS.md` 已警告「动前先抽窄接口避开 `JsSandbox(this)`」；必须靠 `GoldenRuleTest` 逐字节比对。

### B2 `http/` 里的业务编排搬进服务层
- **现状**：`http/` 既是路由层又是编排层——`http/ReadingRoutes.kt:12-22` 直接 import 11 个 DAO 顶层函数；`http/` 19 个文件接触 15 个包；`ReadingRoutes.kt:140-197` 一个处理器里跑「缓存 → 书架取名 → AI 覆盖层 → 本地书现场 `JsSandbox` → 回源写缓存 → 按 `force` 决定回旧正文」，触达 5 个 DAO。
- **怎么动**：保留路由的**协议职责**（解析/校验/响应码），把编排搬到 `reading/`、`source/`、`backup/` 的服务对象里。已有的 `BookshelfRepository`/`SourceRepository`/`ReadingRepository` 是正确样板，**继续按这个形状收口**。
- **收益**：换协议（CLI / 桌面 IPC / MCP）时才有可复用的服务层。

### B3 统一抓取原语（合并 8 份抓取 + 6 份字符集 + 4 份 Cookie 解析 + 4 份 URL 绝对化）
- **证据**：07 分册 §3-4/5；`rules/RuleHttp.kt`、`source/WebViewProxy.kt:506`（无界 gzip）、`http/MediaRoutes.kt:394`（无界 gzip）、`data/CookieDao.kt`、`data/db/CookieUtil.kt`、`source/SessionCookies.kt`。
- **怎么动**：抽出 `Fetch` / `Charset` / `CookieJar` / `UrlResolve` 四个原语包，所有调用点改为调用原语。**这不是"新功能"，是把已有 8 份实现折叠成 1 份**。

### B4 事务模型收口（12 处手动 `autoCommit`）
- **现状**：`ShelfDao` 6 处、`SourcesDao` 4 处、`CacheDao` 1 处、`SourceHealthDao` 1 处自管 `autoCommit`；被外层 `transaction{}` 包住时会**静默提交、rollback 失效**。`data/Database.kt:128` 自述「0.2.35 批量删书事故就是这条」，且 `:134-136` 的告警**漏报了 `SourcesDao` / `SourceHealthDao`**。
- **怎么动**：删除所有手动 `autoCommit`，一律走 `write{}` / `transaction{}`；把「禁止手动碰 autoCommit」写成静态判据（grep 门禁），因为这条纪律已经**只写在注释里**，靠人记。
- **为什么这是 B 而不是 C**：SQL 与业务逻辑是对的，错的是并发控制方式。

### B5 数据库 Schema 补齐与迁移修正（保留机制、修内容）
- **现状（05 分册实测）**：`Schema.kt` 的建表 SQL **缺 5 列**（`char_offset`/`paragraph_anchor`/`position_version`/`position_checksum`/`scroll_position`），全靠 `Migration.kt:111-123` 补 ⇒ **新建库也必须跑一遍补列**；`book_shelf` 缺 `toc_rule`/`sort_order`、`book_note` 缺 3 列，同理。
- **怎么动**：把「建表 DDL」与「补列迁移」对齐为**终态 DDL**（新库一次到位），保留迁移只为老库；同时修 `Migration.kt:100` 的 `cookie_jar = null`（不可逆抹源数据）与 `:76` 的静默 `return@forEach`。
- **风险**：涉及真实用户库（21 表、66MB 级），必须先有 `DbSnapshot` 前置快照 + 回滚演练。

### B6 `LogEntry` 移出 `ops/`（一行 import 断环）
- **现状**：`LogEntry` 定义在 `ops/LogService.kt:178`，被 `data/Database.kt:34`、`data/LogDao.kt:3` import ⇒ 造成 `data ↔ ops` 环，且暴露「184 个 DTO 里至少 1 个不在 `model/`」。
- **怎么动**：DTO 搬到 `model/`，同时把「DTO 只在 `model/`」写成判据。

### B7 `content/` 与 `rules/` 解耦
- **现状**：`content/ContentProcessor.kt:7` ↔ `rules/RuleRunner.kt:46-48`、`rules/RuleUrlSupport.kt:3` 互相依赖；文本加工语义（`LooseJson`、`applyReplaceEntry`）被两层共用。
- **怎么动**：抽 `text/` 原语包（纯函数、无 IO），两层都依赖它。

### B8 `WebViewProxy`（817 行）拆成「登录会话」子域
- **现状**：内置浏览器登录引擎（HTML 代理、表单提交、postMessage 桥、Cookie 同步）全在一个文件；且**用裸 `HttpClient`，绕过 SSRF 闸门**（`source/WebViewProxy.kt:60-63`，07 分册 P1-3）。
- **怎么动**：拆为「代理传输 / 页面改写 / 表单提交 / 凭据回写」四块，传输层强制走 A4。

### B9 前端领域逻辑搬回后端
- **现状**：`lib/sourceInspector.ts`（456 行）在浏览器里做 VIP 检测正则（`:33`）、正文判定（`:54`）、阈值 `450` / `0.35`（`:42-43`），并且对后端发 N+1 请求；**后端本来就有 `/api/sources/health-check`**（`http/SourcesRoutes.kt:250`）却另跑一套。
- **怎么动**：判定逻辑移回后端体检（已有落点），前端只做展示。

### B10 前端类型契约生成化
- **现状**：`lib/api/types.ts` 956 行（`src` 第二大文件），文件头自陈「目前先手动维护，待契约生成脚本接入」（`:1-5`）；与 144 端点无生成链路 ⇒ 已出现 §0.3 那批漂移。
- **怎么动**：由后端 DTO（`model/*.kt`）生成 TS 类型；`agent-api.json` 已经在描述端点，补一个 schema 生成器即可。**这是「一次投入、永久消除一整类 bug」的投资**。

### B11 `styles.css`（6,757 行）折叠进设计内核
- **现状**：单一全局样式表，54 次提交、+7,509/−752 行；31 处弹层各自实现样式。
- **怎么动**：`ui/` 已有 38 角色可计算配色 + 令牌门面（A9），把 CSS 按组件收敛为令牌 + 组件样式；**先做「新代码不许进 styles.css」的判据**，再逐步迁移存量。

### B12 契约目录补齐
- **现状**：`agent-api.json` 声称 144 条，代码实际注册 **146** 条，漏 `HEAD /api/book/media`（`http/MediaRoutes.kt:202`）与 `OPTIONS /api/sources/{id}/login-cookie`（`http/SourcesRoutes.kt:419`）；另有 `/brand` 系列 **6 条完全不在目录里**（`StaticWeb.kt:177-237`）；门禁为何绿：`web/test/ApiCatalog.test.ts:91` 的方法正则只有 `get|post|put|delete|patch`。
- **怎么动**：扩大门禁的方法集合 + 把 `/brand` 纳入目录 + 让 `RouteCatalog.kt:45` 的 `count` 用真实注册数而不是目录条数。

### B13 TTS 抽象成 provider 接口
- **现状**：`tts/EdgeTtsService.kt`（26K）强依赖在线 Edge 服务；自定义 TTS 出站**完全不判 IP 段**（`tts/EdgeTtsService.kt:341-345,361-375`）。
- **怎么动**：保留 Edge 实现，但抽出 `TtsProvider` 接口，把出站校验统一到 A4。属"搬 + 收口"，不重写协议。

---

## 4. C 类 · 重新实现（7 项）

> 判据：**病在语义**，且已有行为契约可以拿来当回归基线。

### C1 `ReaderScreen.tsx`（2,403 行）交互编排
- **现状**：34 个 `state` + 27 个 `effect` + 20 个 `useCallback`，其中 6 个 state 是弹层开关、5 个是抽屉/全屏；`toggleBookmark` 仍留在里面。已拆出 7 个 hook + 6 个展示组件 + 5 个纯函数目录。
- **为什么重写**：剩下的不是「还能再抽几个 hook」的问题，而是**没有状态机**——翻页落点、划词、图片放大、段落点击、TTS 播放位置互相通过 effect 耦合。项目自己已经因此回退过一次（`docs/ARCHITECTURE.md:690-698`：54 处类型错误）。
- **怎么重写**：引入显式状态机（`idle / loading / reading / error` + 位置子状态），交互事件走 transition，展示层保持现有组件。
- **回归基线**：`features/reader/` 下 5 个纯函数目录（`interaction/`、`content/`、`notes/`）的现有测试 + `readerSettings` 测试。

### C2 31 处各自实现的弹层
- **现状**：31 处弹层，`useFocusTrap` 只覆盖 12/31 ⇒ 19 个弹层无焦点陷阱；无组件库，`Select.tsx` 是唯一成功抽象。
- **怎么重写**：一套 `Dialog` 原语（焦点陷阱 + ESC + 遮罩 + 层级 + 动效），所有弹层改用它。

### C3 `main.tsx`（803 行）组合根
- **现状**：16 state + 13 effect，同时做深链兼容、皮肤注入、探活重试、快捷键、封面取色接线；`lib/nav.ts:35-48` 留 7 个 `ai-*` 死类型，`main.tsx:738-764` 有 0 渲染分支。
- **怎么重写**：拆成 bootstrap（探活/配置）+ shell（导航/主题）+ feature 挂载；死类型随 AI 一起清。

### C4 发布与进程编排
- **现状**：5 个启动入口 / 编排者（`start.mjs` 22.8KB、`stop.mjs`、`DesktopLauncher.kt` 607 行、`Dockerfile`、2 个 `fun main`）；未签名、无 Secrets、`build-jar.yml` 触发面过宽（`docs/ARCHITECTURE.md:696`）。
- **为什么重写**：现状是「能出包」不是「可发布」；编排逻辑散在 JS/Python/Kotlin/Shell 四种语言里。
- **怎么重写**：单一 launcher（Kotlin）承担端口/数据目录/进程守护，打包管线独立（签名 + 校验和 + 可复现构建）。

### C5 `GuardedHttpClient.kt` —— 要么真做，要么删
- **现状**：注释声称「出站只能由 `NetworkSecurity.newHttpClient` 签发」，实际**零强制力**：6 处裸 `HttpClient.newBuilder()` / 5 个文件（`DesktopLauncher.kt:313,323`、`tts/EdgeTtsService.kt:28`、`source/ExternalBrowserLogin.kt:99`、`source/WebViewProxy.kt:60`、`ops/UpdateCheck.kt:42`），且无测试守门。
- **怎么重写**：不写"门面类"，而是**写静态判据**：`ops/` 以外出现 `HttpClient.newBuilder` 直接红。判据能守住的东西不需要门面类守。
- **教训**（写进重建纪律）：`http/HttpClients.kt` 已经因为同一原因被删过一次（2026-11-05，零调用方）——**同一个错误犯过两次**。

### C6 规则扩展点 `RuleProcessor` 的定位
- **现状**：机制真实接入热路径（`RuleValue.kt:52`、`RuleNodeSelection.kt:45`，认领即拥有），但产品内**零自定义处理器**，`rules/processor/` 只剩 2 个 demo（31 + 49 行），包外 `import` = 0。
- **怎么重写 / 或砍掉**：二选一，不要继续挂着。
  - 要它 → 至少有一个真实处理器（建议：把"正文净化/繁简转换/排版后处理"做成真处理器，而不是继续写在 `RuleRunner` 里）；
  - 不要它 → 删除扩展点，减少一层间接。
- **决策点**：见 `11_UNRESOLVED_QUESTIONS.md` Q-3。

### C7 更新检查 `ops/UpdateCheck.kt`
- **现状**：裸 `HttpClient`（`:42`）、无签名校验；发布链路本身也未签名。
- **怎么重写**：与 C4 合并设计（校验和 + 签名），否则"自动更新"会成为新的供应链入口。

---

## 5. D 类 · 废弃候选（11 项，标记不删除）

> **重要**：本类不等于「允许删除」。每一项都需要先确认「没有隐性使用者」，尤其 D1/D5/D6。

| # | 候选 | 证据 | 判断依据 | 处理建议 |
|---|---|---|---|---|
| D1 | `product/experimental/ai/` 54 文件 / 13,334 行 | `54ee9cb`、`a105588`、`150949a`、`a0b8e16`（破坏性：`/api/agent` 下线） | 已移出编译与打包，代码一行未删；上线 12 天后整体下线 | **产品决策**（Q-1）：恢复 / 独立仓库 / 归档出库。**不建议**在二期主树里恢复 |
| D2 | `http/Guard.kt:41-43` 的三条 `/api/agent/*` 白名单 | `http/Guard.kt:41-43` vs 端点已 404 | 只读 POST 白名单指向不存在的端点；若 AI 恢复即成**免闸门写入口** | 删除（1 行风险，收益明确） |
| D3 | 前端 AI 残留：`types.ts:729-926` 13 个 `Agent*` 类型、`lib/nav.ts:35-48` 7 个 `ai-*` 死类型、`main.tsx:738-764` 无渲染分支 | 附册 B §2、`06` §6 | AI 已搬走，零渲染分支 | 随 D1 决策一起处理 |
| D4 | `SameOriginGuardTest.kt:151-160` 僵尸测试 | 断言 `!= 403`，而该路由已 404 | 测试在"守着"一条不存在的路由，绿得没有意义 | 删除或改写判据 |
| D5 | `gradle/libs.versions.toml` | ~150 条声明只被用到 3 处 | 旧安卓工程遗留 | 先确认 3 个使用点，再删（低风险） |
| D6 | `ktor-server-cio` 依赖 | 引擎已换 Netty（`f4d878b`）；`AGENTS.md` 自述"删掉只需改这一行" | 两套引擎同仓 | 删除（需跑一次全量后端测试） |
| D7 | 84 处 `requireSameOriginWrite()` 二次检查 | `docs/ARCHITECTURE.md:600` 自述"幂等无害但已不是防线" | 历史遗留冗余 | 可留可清，**不建议**在重建前批量改（纯噪音 diff） |
| D8 | `book_mark` 表 + 2 个索引（实库孤儿） | 05 分册：源码零命中，实库有 **1 行真实用户书签** | 用户的真实数据，新代码只读 `book_note.bookmark` ⇒ 这条书签永远不可见 | **不是"删表"**：先做一次性迁移（把 `book_mark` 行转成 `book_note.bookmark`），再下线表 |
| D9 | `reading_progress` 的孤儿行与缺列 | 05 分册：实库 5 行中 4 行无书架条目、3 行 `source_id` 已不存在 | 数据卫生问题，不是表的问题 | 迁移时清理孤儿 + 补齐列（B5） |
| D10 | `product/web/src/lib/api.ts`（旧单文件） | 已拆为 `lib/api/client.ts` + `domains/*` | 历史文件，勿再引用 | 确认 0 引用后删除 |
| D11 | `docs/archive/**`、`docs/engineering/audit/directory/*` | `docs/STRUCTURE.md` 已列为禁读区 | 历史快照，占位但体积小（<1MB） | 出库到 `E:\legado-out\assets\archive`（按 STRUCTURE 原则 4） |

---

## 6. 「最值得保留的十项资产」与「最该重写的模块」（与交付要求对齐）

### 6.1 最值得保留的十项（按不可替代性排序）

| 排名 | 资产 | 一句话理由 | 证据 |
|---:|---|---|---|
| 1 | 规则取值方言 + 黄金样本 | 社区书源语义，不可重新设计 | `rules/RuleValue.kt:81,225,297`；`test/resources/rule-golden/**` |
| 2 | JS 沙箱 + Java 桥白名单 | 唯一 RCE 防线，重写风险极高 | `rules/JsSandbox.kt`、`rules/JavaPackages.kt` |
| 3 | 出站闸门 + 连接级 IP 固定 | 比同类项目更严的一层 | `ops/NetworkSecurity.kt:54-69`、`ops/PinnedProxy.kt` |
| 4 | 后端测试体量（993 用例 / 24,374 行） | 行为约定的唯一载体 | `product/app/src/test/**` |
| 5 | 书源编解码与扩展字段保留 | 兼容性的根 | `source/SourceCodec.kt`、`schema.source.payload` |
| 6 | 备份导入容错口径 | 踩坑换来的 | `backup/BackupImporter.kt` |
| 7 | 判据机制（边界/目录/深度/假绿） | 方法是可复用的资产 | `ArchitectureBoundaryTest.kt`、`run-all.ts:18`、`depth-check.mjs` |
| 8 | 前端唯一 fetch 闸门 | 工程质量最好的一处 | `lib/performance.ts:204`、`lib/api/client.ts:38-41` |
| 9 | 设计内核（38 角色可计算配色） | 删 CSS 的落点 | `ui/color/scheme.ts:39`、`ui/index.ts:1-35` |
| 10 | 迁移机制骨架 + `DbSnapshot` | 锚点已装好 | `data/SchemaVersion.kt`、`data/DbSnapshot.kt` |

### 6.2 最该重写的模块（按投入产出比排序）

| 排名 | 模块 | 规模 | 重写理由（一句话） | 风险控制 |
|---:|---|---:|---|---|
| 1 | `ReaderScreen.tsx` 交互编排 | 2,403 行 | 没有状态机，靠 effect 互耦，已回退过一次 | 先补交互判据再动 |
| 2 | 事务模型（12 处手动 `autoCommit`） | 跨 4 个 DAO | 会静默提交外层事务，已造成 0.2.35 批量删书事故 | grep 门禁先立 |
| 3 | `RuleRunner` 的 HTTP 段 | 260 行 / 主类 1,758 行 | 焊死导致外呼预算无处下钩 + 8 份抓取复制 | 黄金样本逐字节比对 |
| 4 | 前端弹层体系 + `styles.css` | 6,757 行 | 31 处各自实现，19 处无焦点陷阱 | 先立"新代码不进 styles.css" |
| 5 | 发布/进程编排（5 个入口） | 4 种语言 | 能出包 ≠ 可发布（未签名） | 与更新检查合并设计 |
| 6 | `WebViewProxy` 登录引擎 | 817 行 | 绕过 SSRF 闸门的最宽入口 | 传输层强制走 A4 |
| 7 | 前端类型契约 | `types.ts` 956 行 | 手写复刻必然漂移，已产生线上 400 | 生成器 + 契约测试 |

---

## 7. 与「三条铁律」的对应（项目负责人提的长期规则）

| 铁律 | 本册如何落实 |
|---|---|
| **每个模块必须有明确负责人（唯一权威实现）** | 已识别的「多权威」清单必须收敛：① 阅读进度 6 处写入（`ReadingDao.kt:15` 唯一权威，其余 5 处收敛）；② 书源体检前端 `sourceInspector.ts` vs 后端 `SourcesRoutes.kt:250`；③ Cookie 解析 4 份；④ 字符集判定 6 份；⑤ 抓取解码 8 份 |
| **每次修改必须有明确范围** | B 类 13 项全部是「逻辑不动、只搬家」，可用 diff 约束验证（改动文件清单必须落在声明范围内） |
| **每个核心模块必须有独立测试** | A 类 14 项已全部有判据；**缺口在 C 类**：`ReaderScreen`、`main.tsx`、7 个 reader hook、`pages.tsx`、`bookSourceFields.ts` 零覆盖（附册 B §9）——重写这些必须先补判据 |

---

## 8. 证据索引（本册引用的关键位置）

| 结论 | 证据 |
|---|---|
| 6 处裸 HTTP 客户端 | `DesktopLauncher.kt:313,323`、`tts/EdgeTtsService.kt:28`、`source/ExternalBrowserLogin.kt:99`、`source/WebViewProxy.kt:60`、`ops/UpdateCheck.kt:42`（`grep -rn "HttpClient.newBuilder()"`） |
| 事务双轨 12 处 | `ShelfDao`(6) / `SourcesDao`(4) / `CacheDao`(1) / `SourceHealthDao`(1)；`data/Database.kt:128,134-137` |
| 进度 6 处写入 | `ReadingDao.kt:15`、`ShelfDao.kt:77,241,265,335`、`ImportDao.kt:153` |
| 8 份抓取 / 6 份字符集 / 4 份 Cookie 解析 | 07 分册 §3-4、§3-5 |
| 端点 146 vs 目录 144 | `06` §2；`web/test/ApiCatalog.test.ts:91` |
| `/brand` 6 条不在目录 | `StaticWeb.kt:177-237`；`grep -c brand agent-api.json` = 0 |
| 扩展点空转 | `rules/processor/demo/*.kt`；包外 `import` = 0 |
| AI 子系统生灭 | `54ee9cb`、`a105588`、`150949a`、`a0b8e16` |
| db 缺列与孤儿表 | `05` §1、§2、§7 |
| ReaderScreen 规模 | `06`… 见附册 B §6（34 state / 27 effect / 20 useCallback，2,403 行） |
| 54 处类型错误回退 | `docs/ARCHITECTURE.md:690-698`；`3e07b00` |

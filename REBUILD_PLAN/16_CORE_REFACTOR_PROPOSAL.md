# 16 核心模块重构提案（rules / reader）

> 本册是 Phase 0.5 的**结论册**：把 `12`（规则引擎）、`13`（阅读器）、`14`（兼容矩阵）、`15`（交互矩阵）的证据，收敛成两个核心模块的重构提案。
> 同时按负责人的调整落定架构口径：**逻辑模块先行、物理模块后置**（`08` 的 11 域 + 9 kernel 包是"逻辑边界"，不立即拆 Gradle module）。
> **本册不含任何代码改动**，也不含时间表之外的承诺。

---

## 0. 九问速答（负责人指定的最终回答）

| # | 问题 | 回答 | 依据 |
|---|---|---|---|
| 1 | **Rules 是否适合独立提取？** | **适合，但只能"半独立"**。取值语义与沙箱可以完全脱离数据层；HTTP 段可以抽成端口。**唯一不能独立的是它必须依赖一个"带凭据的 Fetch 端口"**，而这个端口的实现必须在 `ops/`（`ArchitectureBoundaryTest` 的 `ENGINE_TO_INFRA_BASELINE` 已在 `RuleHttp.kt:13-17` 约束了这一点）。结论：**能抽，但抽出来的形状是"内核 + 两个端口"，不是"零依赖模块"** | 12a §9、§2 |
| 2 | **哪些规则代码绝对不能随意重写？** | **14 条宿主 API 语义 + 2 条契约**（`getString` 失败必须是 `null` 还是 `""`、`@put/@get` 的传递粒度）。每条都带"改了就成百上千份源静默失败"的实测份数注释。完整清单见 §3.2 与 12c §9.3 | 12c §9.3、12b §2 |
| 3 | **RuleRunner 应如何解耦？** | 抽 `Fetch` 窄接口（12 项能力必须全覆盖），切分点放在 **`fetchUrl` 这一层而不是"搜索/详情/正文"层**；`JsSandbox` 改为接收一个窄句柄而不是 `RuleRunner` 实例。分 3 步走：端口 → 实现后移 → 沙箱换句柄 | 12a §9.1–9.3、§3.3 |
| 4 | **Reader 是否应该引入状态机？** | **应该，但不是第一步**。第一步必须是"删死代码 + 统一进度入口 + 统一正文加载入口"，这三刀做完，剩下的状态集合才小到能用状态机表达。**直接上状态机 = 在没有判据的情况下重写交互**（本项目已因此回退过一次） | 13a §5、§7；`15` |
| 5 | **哪些 Reader 代码值得保留？** | 纯函数目录（`interaction/` 翻页算术、`content/` 逻辑位置与分块渲染、`notes/` 重锚定）、`usePaginationMeasurement` 的量测算法、`useReaderPositionJump` 的跳转原语、`useReaderChapterContent` 的预取窗口、以及 8 个 hook 的**边界本身**（它们已经被证明可以脱离 ReaderScreen 存在） | 13b §3、§2 |
| 6 | **哪些状态和 Effect 应合并？** | 6 个死状态删除；6 个弹层开关 + 5 个抽屉/全屏 → 一个 `activeOverlay`；3 个进度 effect（共享一个 `timerRef`）→ 一个 recorder；E15/E16 重复上报 → 合并；3 条"重取正文"路径 → 一个 `reloadContent(reason)`；5 处"有效章节"判据 → 一个函数；17 个"意图位 ref" → 收进 controller。逐条见 §4.3 | 13a §2/§3/§5.2 |
| 7 | **重构 Reader 的最小安全切片是什么？** | **R1 只做"无行为变化"的删除与收口**：删 76 行死代码 + 6 个死状态 + 失效 import（判据：现有 139 个前端测试 + 渲染快照不变）。**任何触碰 `persist()` 与正文加载的改动，必须先补 3 条端到端判据**（开书/自动保存/切章保存），否则不许动 | §4.4 |
| 8 | **两个模块分别需要多少阶段？** | **Rules 4 个阶段**（判据 → Fetch 端口 → 实现后移 → 预算补强），第 5 阶段（纯 JS 堆隔离）单独决策。**Reader 5 个阶段**（判据 → 删死码 → 进度唯一入口 → 正文唯一入口 → 状态机），其中第 5 阶段可延后 | §3.4、§4.5 |
| 9 | **哪些结论必须经过运行时验证？** | **13 条**，逐条给了验证方法（§6）。最高优先 4 条：纯 JS 堆是否先于墙钟 OOM、`java.ajax` 无 deadline 是否真让墙钟失明、`ruleData` 跨源串变量、进度丢失去重（慢网/多标签） | §6 |

---

## 1. 架构口径落定：逻辑模块先行，物理模块后置

### 1.1 采纳负责人的包结构（替代 `08` §1 的物理切分）

```
product/app/src/main/kotlin/io/legado/
├── kernel/                      ← 共享内核：无业务语义，被 features 依赖，自己不依赖 features
│   ├── model/                   ← 全部 DTO（一个概念一个类型）
│   ├── database/                ← 连接池 · Schema · Migration · read/write/transaction 三形态
│   ├── network/                 ← 唯一出站入口：SSRF 闸门 + IP 固定 + 重定向 + 限读
│   ├── rules/                   ← 规则求值 + 取值方言（只依赖 network 的端口 + text 原语）
│   └── safety/                  ← 启动闸门 · 同源写门 · 凭据域 · body limit
├── features/
│   ├── source/                  ← 书源 CRUD/编解码/体检/订阅
│   ├── bookshelf/               ← 书架/分组/批量/换源
│   ├── reader/                  ← 目录/正文/进度/笔记/书签（服务端侧）
│   ├── search/
│   ├── backup/
│   └── rss/
└── adapters/
    ├── http/                    ← 146 条路由：只做协议，不做编排
    └── frontend/                ← 静态托管 + 品牌 + PWA 壳
```

**与 `08` 的差异**：`08` 提的是"11 个域 + 9 个 kernel 包"，本册按负责人口径收敛为 **9 kernel 包 + 6 features + 2 adapters**，并把 `explore/localbook/media/tts/login` 五块**先挂到已有 feature 下**（`media`→`reader`、`localbook`→`reader`、`login`→`source`、`tts`→`reader`、`explore`→`search`），等边界稳定后再决定是否独立。理由：**现在最需要的是减少耦合，不是增加构建系统复杂度**。

### 1.2 三条新纪律（比目录更重要）

| # | 纪律 | 为什么（Phase 0.5 的具体证据） |
|---|---|---|
| N1 | **`kernel/rules` 只允许依赖 `kernel/network` 的端口接口，不允许 import `ops/`** | `RuleHttp.kt:13-17` 已经明写它受 `ENGINE_TO_INFRA_BASELINE` 约束——今天的 `rules → ops` 是"基线允许的例外"，不是设计意图 |
| N2 | **`features/reader` 不允许 `new JsSandbox(runner)`** | `ReadingRoutes.kt:166` 今天在路由层直接构造沙箱（用于本地书正文处理）；这是 adapter 直接碰内核实现 |
| N3 | **进度只有一个写入入口** | 今天 HTTP 层唯一（一个 `PUT` + 一个 DAO 函数），但应用层有 11（前端）+ 4（后端）+ 1（死代码）条路径 |

---

## 2. 六个核心资产保护清单（负责人指定）的落点与判据

| 资产 | 落点 | 保护判据 | 搬迁前提 |
|---|---|---|---|
| **书源规则方言** | `kernel/rules` | `14` 矩阵的 63 行判据 + 新增 7 个 golden 样本 | 兼容性判定必须按 12b §2 的 46 条逐条对齐（**不能再靠项目自述**） |
| **JS 沙箱** | `kernel/rules`（同包，独立子目录） | `JsSandboxHostBudgetTest` 等 40 项安全测试 + 新增 C-1/C-2/C-4 判据 | 12c §9.2 的 C-1~C-10 先补；14 条语义逐字保留 |
| **Java 桥白名单** | `kernel/rules` | `JavaPackagesEntryBaselineTest`（枚举基线） | 必须**连同基线判据一起搬**，否则等于把洞当 API 搬走 |
| **书源编解码** | `features/source` | 扩展字段保留判据（`source.payload` 往返） | 无 |
| **出站网络闸门** | `kernel/network` | 三层 SSRF 判据 + `NetworkSecurityTest`/`PinnedProxyTest` | **必须先修 `WebViewProxy` 的裸客户端**（唯一绕过面） |
| **数据库 Schema 与备份口径** | `kernel/database` + `features/backup` | 建表终态 DDL 对账 + `BackupImportTest`/`BackupExportRoundTripTest` | 前置快照 + 不可逆迁移先修（`05` §7） |

---

## 3. rules 重构提案

### 3.1 为什么只能"半独立"（回答 Q1 的理由）

Phase 0.5 确认了三件事：

1. **取值语义确实可以完全脱离数据层**：`RuleValue`/`RuleNodeSelection`/`RuleSplit` 全是纯函数 + `Jsoup`/`json-path` 调用，没有一个 import `data/`（12b §1）。
2. **HTTP 无法脱离"凭据"**：`effectiveHeaders` 与 Cookie 合并发生在请求构造里（`RuleRunner.kt:1381-1431`），而凭据来自 `data/`。所以规则引擎只能依赖一个**带凭据的 Fetch 端口**。
3. **沙箱反向依赖主类**：`JsSandbox(this)` 共 13 处回调 `RuleRunner`，并且会把 runner 再往下传给 `JavaPackages(cx,scope,runner,…)`（`JsSandbox.kt:360`）。**不换句柄就抽不动**（12a §9.3）。

### 3.2 绝对不能重写的清单（回答 Q2）

**A. 14 条宿主 API 语义**（完整说明见 12c §9.3，每条都带"实测份数"注释）：`java.get` 双重分派、`JSON.parse` 兼容层、`JsScriptShape` 的"顶层 return 才包 IIFE"、`responseView` 双身份、`cookie.*` 返回空串、`source.getVariable()` 回 `""` / `book.getVariable()` 回 `"null"`、`getUserAgent()===getWebViewUA()`、`timeFormatUTC` 按小时换算（**故意偏离上游**）、`getStringList` vs `getElements`、`loginUrl` 的 JS 执行条件、未知类静默 `undefined`、`Reload` 挂浏览器 UA + Referer、`importScript` 空内容抛 `EvaluatorException`、数字输出去掉 `.0`。

**B. 2 条契约**：
- `getString` 失败返回语义（本项目 `null`，上游 `""`）——按上游写法写的规则在本项目里可能**整条被 `mapNotNull` 丢掉**（12b §2.5）；
- `@put/@get` 的传递粒度（`ruleVariables` 跟节点走 + `ruleData` 按 URL 键控，`RuleValue.kt:43`、`RuleRunner.kt:135`）。

**C. 1 处必须修而不是保留的**：`@CSS:` **大写**在字段层失效（`RuleValue.kt:434` 的 `removePrefix` 区分大小写，而列表层 `RuleNodeSelection.kt:43` 却 ignoreCase）→ 同一书源"列表能选、字段全空"。这是 **bug 不是语义**，修它需要先批准"输出会变"（12b 附录 A5/A9 同属此类）。

### 3.3 RuleRunner 解耦方案（回答 Q3，三步）

```
第 1 步  加端口（不动行为）
        kernel/network 定义 interface Fetch { fetch(url, options, sourceId, db): Fetched }
        签名必须覆盖 12 项既有能力：URL 尾 options / 方法·body·charset / 限读 2MiB+解压后再卡
        / 字符集优先级 / 手写 4 跳重定向+每跳校验 / 每跳凭据与 Set-Cookie / Cookie 按键合并
        / UA 兜底与非 ASCII 头 / 首次失败重试一次 / deadlineMs 每跳压缩 / 非 2xx 抛上游原话 / 计时与日志
第 2 步  实现后移
        现有 fetchDetailedImpl/buildRequest/effectiveHeaders 整段搬到 kernel/network 的实现类
        RuleRunner 只保留 fetchUrl 一层（把已渲染 URL + 已合并 headers 交出去）
第 3 步  沙箱换句柄
        JsSandbox 由 RuleRunner 实例改为接收窄句柄（只暴露 fetchResponse / sourceId / ruleData 读写）
```

**三个隐藏耦合（漏一个就白做，12a §9.3）**：
1. `{{}}` / URL 脚本与 `@put` 变量活在 `threadContext` 里（`RuleHttp.kt:137`、`RuleRunner.kt:1039-1046`）⇒ **`Fetch` 必须是"已渲染 URL + 已合并 headers"的黑盒**，切分点只能落在 `fetchUrl`，不能上提到 `fetchSearchPage`；
2. `validateTarget` 依赖 `ops.NetworkSecurity` ⇒ **接口放 `port/`、实现放 `ops/`、装配在组合根**，否则踩红 `ArchitectureBoundaryTest`；
3. 两个 `internal var` 测试替身（`RuleRunner.kt:81/116`，在 `:1229-1230` 抢在真网络前 return）会短路 SSRF 闸门 ⇒ 新架构里**只允许测试注入**，并加一条架构断言禁止生产装配使用。

**搬迁时最容易悄悄变的 3 处**（必须逐条立判据）：POST body 里 `{{key}}` 的渲染、`@put/@get` 在 `chapters`/`content` 之间传递、正文分页文本用 `\n\n` 直接串接。

### 3.4 rules 的阶段（回答 Q8 前半）

| 阶段 | 内容 | 出口判据 | 风险 |
|---|---|---|---|
| **S0 判据** | 补 `14` §5 的 7 个 golden 样本 + C-1/C-2/C-4/C-9 的测试 | 兼容矩阵盲区从 5 条降到 ≤2 条 | 低 |
| **S1 Fetch 端口** | 加接口 + 实现后移（行为零变化） | 全量后端测试 + golden 逐字段一致 | 中 |
| **S2 沙箱换句柄** | `JsSandbox` 不再持 `RuleRunner` | 沙箱 40 项安全测试绿 | 中 |
| **S3 预算补强** | 出站次数/字节预算、7 处 deadline、累计容器封顶、错误枚举 | 新增预算判据全绿 | 中 |
| **S4（单独决策）** | 纯 JS 堆隔离（子进程 + `-Xmx`） | 沙箱不变量仍绿 | 高：作者已在 `JsGuard.kt:22-24`、`GzipLimits.kt:30` 预留了拆独立模块的路，但这会改变部署形态 |

---

## 4. reader 重构提案

### 4.1 是否引入状态机（回答 Q4 的理由）

**应该，但顺序不能倒。** 现状的真实规模是 **34 useState（6 个死状态）+ 31 effect + 35 ref（17 个"意图位/闸门位"）+ 8 hook（约 60 个状态位）**，全部挂在同一组件重渲染上。这个规模下**没有判据的状态机化 = 重写交互**，而本项目刚因为一次无判据的交互重构回退过（54 处类型错误）。

正确的顺序：**先删死码 → 再统一两个唯一入口（进度、正文） → 剩下 20 个左右的状态集合才适合用状态机表达**。

### 4.2 值得保留的部分（回答 Q5）

| 保留 | 理由 |
|---|---|
| `interaction/`（翻页算术、点击分区、快捷键映射） | 纯函数、有 12 条算术判据（`ReaderFlow.test.ts`、`PageTurn.test.ts`） |
| `content/`（逻辑位置、分块渲染、漫画页映射） | 纯函数，`LogicalPosition.test.ts` 单测 |
| `notes/`（书签、重锚定） | 纯函数，正文改版后批注重定位的算法沉淀（`d529db3`） |
| `usePaginationMeasurement` 的量测算法 | 已收敛为"DOM 量栏唯一事实"（`53398ce` 整簇删除 typeset 分页），是全仓少见的单权威改造成功案例 |
| `useReaderPositionJump` | 跳转原语已抽出，19 props 但边界清楚 |
| `useReaderChapterContent` 的预取窗口 | 上限 12 章、有 `preloadedContentRef` |
| 8 个 hook 的**存在** | 它们已被证明能脱离 ReaderScreen 独立存在——这是继续解耦的支点 |

### 4.3 应合并的 state / effect（回答 Q6，逐条可执行）

| # | 合并项 | 现在 | 目标 | 依据 |
|---|---|---|---|---|
| M1 | **死状态** | `settingsTab`(633)、`localSyncing`(163)、`localSyncProgress`(164)、`uiV2`(无 setter) 等 **6 个** | 删除 | 13a §2 |
| M2 | **死代码** | 1192–1267 缓存队列/本机同步/取消缓存（约 **76 行**）+ 死 import + `handleSyncToLocal`/`handleCacheBook`/`handleCacheAll`/`handleCancelCache` | 删除 | 13a §5.8 |
| M3 | **弹层开关** | 6 个独立布尔 + 5 个抽屉/全屏布尔 | 一个 `activeOverlay: Overlay \| null`（枚举） | 13a §2 |
| M4 | **进度 effect** | E14(1735)/E15(1754)/E17(1786) 三条，共享一个 `timerRef`，**同一套段落库逻辑写 3 遍** | 一个 `useProgressRecorder`（统一时机 + 单一取消闸门 + 单一去抖） | 13a §3/§5.7 |
| M5 | **重复上报** | E15 与 E16 几乎同依赖、重复 report | 合并为一个上报出口 | 13a §3 |
| M6 | **重取正文** | 3 条路径（379 刷新当前章 / 407 净化规则重取 / 369 顶窗口重取） | 一个 `reloadContent(reason)` | 13a §7（320–432） |
| M7 | **有效章节判据** | **5 处**各写一遍（1053-1058 / 1400-1404 / 1619-1621 / 719-725 / hook:65） | 一个 `isEffectiveChapter()` | 13a §5 |
| M8 | **意图位 ref** | 35 个 ref 里 17 个是"意图位/闸门位" | 收进 controller，只在必要时保留 ref | 13a §1/§2 |

### 4.4 最小安全切片（回答 Q7）

**R1（无行为变化，可以马上做）**：删 M1 + M2，并补一条"渲染骨架不变"的判据。
- 判据：现有 139 个前端测试 + `ReaderScreenSmoke.test.ts` 仍绿 + `tsc -b` 通过。
- 为什么安全：删的都是**零调用点**的东西（`grep` 已实证 `setOfflineStatsModal(true)` 全仓 0 处、`handleCacheBook` 等无调用者）。

**R2 之前必须先补的 3 条端到端判据**（`15` 矩阵里 4 行"高缺口"的核心）：
1. 开书 → 落在正确章节与位置（`main.tsx:547` + `handleChapterLoaded:246`）；
2. 停手 1.2s → 真的发出一次 `PUT /api/reading-progress`，且 body 字段正确；
3. 切章/离开 → 发出的是**当前章**的进度（防缺陷 ②"新章位置记到旧章"）。

**明确不建议现在做**：把 `ReaderScreen` 拆成"更多文件"。13a §7 已按段说明它大在哪里——**大在状态编排，不在文件组织**。

### 4.5 reader 的阶段（回答 Q8 后半）

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| **R0 判据** | 补上面 3 条端到端 + `15` 矩阵 4 行高缺口 | 端到端判据从 0 → 3 |
| **R1 删死码** | M1 + M2 | 139 测试 + 渲染不变 |
| **R2 进度唯一入口** | M4/M5 → `useProgressRecorder`；后端补"最后写入者"判据或用客户端 `updatedAt` | 3 条端到端 + 乱序场景 |
| **R3 正文唯一入口** | M6/M7 → 一个 `reloadContent` + `isEffectiveChapter`；`useReaderChapterContent` 成为唯一正文获取者 | 重复请求 D1 消失（DevTools 验） |
| **R4 收口** | M3（弹层）+ M8（意图位）+ 4 处无 `memo` 的展示组件 | 交互矩阵缺口重评 |
| **R5 状态机** | 在 R1–R4 之后，用显式状态机替换跨模块 effect 编排 | 8 类交互判据全绿 |

---

## 5. 交叉边界与"Legacy Data Recovery"模块

### 5.1 六问的处置（来自 13b §7）

| # | 现状 | 处置 |
|---|---|---|
| 1 | 前端零依赖规则引擎；但 `ReadingRoutes.kt:166` 在**路由层** `new JsSandbox(runner)` | 挪进 `features/reader` 的服务层，且走 N2 纪律 |
| 2 | Rules 不知道 Reader 的 UI 状态（只拿 bookName/chapterTitle） | 保持（良性） |
| 3 | 前端在做服务端的事 5 类（进度拼装与校验值、章节序判定、批注重定位、IndexedDB LRU、检索高亮） | 校验值与章节序判定移回服务端；其余保留 |
| 4 | 进度应用层 11+4+1 条路径 | R2 收敛 |
| 5 | 章节内容 **4 套形状**，`mediaUrl` 在三处丢失（`Schema.kt:74` 缓存表无该列 / 预取只记 content / IndexedDB 无该字段） | 统一为一个 `ChapterContent`，`mediaUrl` 必须进缓存表与 IndexedDB |
| 6 | 缓存分层清楚但**决策错位**（决策塞在 `search.ts:94-126`），且两套离线缓存共用"离线缓存"文案 | 决策移入 `features/reader` 的缓存策略对象；文案分开 |

### 5.2 建议新增的模块：`features/recovery`（Legacy Data Recovery）

按负责人的要求，孤儿数据**只做恢复不做清理**。提案：

| 职责 | 输入 | 输出 | 判据 |
|---|---|---|---|
| 发现旧数据 | 实库 `sqlite_master` 与代码建表清单的差集 | 孤儿表/孤儿列清单 | `book_mark`（1 行真实书签）、`reading_progress`（4 行无书架条目） |
| 识别孤儿记录 | 表间关联检查 | 可恢复/不可恢复分类 | 每条结论带"关联到的书是哪本"或"关联不到" |
| 尝试关联旧书籍 | `book_url` / `source_id` / 章名匹配 | 候选映射 | 映射不确定时**必须留人工确认** |
| 生成恢复报告 | 上述全部 | 人类可读报告（**不自动写库**） | 报告列出：会迁移什么、会丢弃什么、为什么 |
| 用户确认后执行 | 报告 + 明确确认 | 一次性迁移 + 回滚脚本 | 迁移前 `DbSnapshot` 必须先成功 |

**红线**：绝不因为"看起来是孤儿"就删除。`book_mark` 那 1 行是**真实用户书签**，新代码只读 `book_note.bookmark`，所以它现在**永远不可见**——这是恢复模块存在的直接理由。

---

## 6. 必须运行时验证的 13 条（回答 Q9）

> 原则：凡是"静态能确认的"都不在此列；这里只列**静态证明不了、且错了会导致重构白做或数据损失**的。

| # | 待验证 | 为什么静态证明不了 | 验证方法 | 优先级 |
|---|---|---|---|---|
| RT-1 | **纯 JS 堆是否先于墙钟 OOM** | `chargeHostBytes` 只记 4 个宿主分配点，Rhino 堆无 instrument；`evalImpl` 只 `catch(Exception)`，OOM 是 `Error` | 设预算 0 后跑 `var a=[]; for(;;) a.push('x'.repeat(1<<20))`，或 `-Xmx256m` 复现；观察是 OOM 还是 deadline 先触发 | **P0** |
| RT-2 | **`java.ajax*` 无 deadline 是否真让墙钟失明** | 7 个入口不传 `deadlineMs`，墙钟守卫在阻塞期零回调 | 桩地址 delay 20s + 注入 300ms 超时，跑 `for(i<5) java.ajax(u)`，实测耗时 ≈100s 即证明 | **P0** |
| RT-3 | **`ruleData` 键无 sourceId 是否跨源串 `@put`** | `RuleRunner.kt:139` 只按 URL 分键；静态无法判定并发时序 | 两个书源并发请求同一 URL，各自 `@put` 不同值，断言互不可见 | **P0** |
| RT-4 | **进度是否会倒退** | 前端 11 个写入点 + 后端不读 `updatedAt` + `catch` 静默 | 慢网（Slow 3G）+ 多标签页同时阅读同一本书；观察 `reading_progress` 是否回退 | **P0** |
| RT-5 | 累计容器（`java.put` / `cache.putMemory`）是否可打爆堆 | per-eval 预算 vs per-process 容器 | `for(i<2e5) java.put('k'+i, repeat(200))` 观察堆增长 | P1 |
| RT-6 | `inlineHtml` 通道是否能在宿主 iframe 执行脚本 | 前端 iframe 属性 + CSP 跨册 | base64 塞 `<script>` 走一次登录 UI，查 iframe `sandbox` 与 CSP | P1 |
| RT-7 | 分页/漫画模式卸载后是否真的还会发 PUT | 依赖去抖窗口与卸载时序 | 分页 → 翻页 → 1.2s 内点返回 → 看 Network | P1 |
| RT-8 | `persist` 不校验当前章是否真会导致错记 | 需慢网跨章 | Slow 3G + 滚动跨章后继续滚 | P1 |
| RT-9 | 换源竞态（连点两次）是否真让旧书覆盖新书 | 需并发触发 | 慢网连点两次换源选不同源；或"换源试试"后立刻手动换源 | P1 |
| RT-10 | 重复请求 D1（续接窗口 vs 预取）是否真发生 | 只能证明"没有去重闸门" | DevTools 过滤 `books/content`，长书读到 70% 看同一 chapter 是否 2 条 | P1 |
| RT-11 | `POST /api/sources/{id}/browser/submit` 403 后是否仍执行 | 依赖 Ktor `onCall` 不阻断 pipeline 这一前提（`Guard.kt:91-94` 自述） | 起服务，构造跨源 Origin 请求，看表单是否真的发出 | P1 |
| RT-12 | 兼容性 4 条未确认（`12b §7.3`） | 需真实书源样本 | 用 12b 列出的具体规则形态各跑一次 | P1 |
| RT-13 | **本次一份测试都没跑** | 审计全程只读 | 阶段 2 第一件事：`./gradlew :app:test` + `npm --prefix product/web test` + `npm run coverage`，采集真实基线 | **P0** |

---

## 7. 风险与"不算完成"（本册专属）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **把"拆文件"当成重构** | 13a 已明确：`ReaderScreen` 大在状态编排；继续拆 hook 不会让 11 个 `persist()` 调用点变成 1 个 | 每个阶段出口判据必须是**行为判据**，不是"文件变小了" |
| **用状态机掩盖判据缺失** | 状态机很诱人，但没有 R0 判据就无法证明行为没变 | R5 必须排在 R1–R4 之后 |
| **改掉 `@CSS:` 大小写 bug 时连带改了别的语义** | 该修复会改变输出（12b 附录 A5/A9 同属） | 单独一刀 + 全量语料对比 + 负责人批准"输出会变" |
| **把 Phase 0.5 的结论当成 Phase 1 施工图** | 本册只到"提案 + 判据 + 阶段"，不含接口实现细节 | 阶段 1 需要另出施工图（含 `Fetch` 的最终签名与端口装配） |
| **覆盖率错觉** | `rules` 内核这次读到了 100%，但 `14` 只读了测试代码的 30%（规则相关子集） | 缺口清单（`14` §4.1）就是后续补测清单 |

---

## 8. 需要负责人拍板的 4 件事（新增，来自本轮）

| # | 事项 | 选项 | 我的建议 |
|---|---|---|---|
| NQ-1 | `@CSS:` 大写失效、`li.-1` 负索引、`:` 索引区间语义、单花括号插值 这 4 个**兼容性 bug 要不要修** | ①修（输出会变，需语料普查）②保持原样只在文档记账 | **①修**，但必须单独一刀 + 全量语料对比 + 你批准"允许输出变化" |
| NQ-2 | 纯 JS 堆隔离（C-3）走"文档化 + `-Xmx`"还是"子进程隔离" | ①短期方案 ②独立进程 | **先①**（成本 1 天），把②列入产品化阶段评估 |
| NQ-3 | `ReaderScreen` 状态机化（R5）是否在二期做 | ①做 ②只做 R1–R4，R5 延后 | **②延后**。R1–R4 的收益/风险比明显更好 |
| NQ-4 | 是否新建 `features/recovery` 模块 | ①建 ②并进 `features/backup` | **①建**：它的红线是"只报告不自动写库"，与备份语义不同，混在一起会诱导自动清理 |

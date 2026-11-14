# legadoQ 第二阶段开工前复核（PHASE2_PREFLIGHT_REPORT）

> 复核日期：2026-11-14 ｜ 仓库：`E:\legado` ｜ 分支 `main` ｜ HEAD `4291d30`
> 性质：**只读复核 + 计划制定**。未修改源码、配置、数据库、构建脚本；未提交；未清理任何未跟踪文件。
> 与第一阶段的关系：本报告不重写 `docs/engineering/audit/` 下六份审计报告，只核对它们是否仍然成立。

## 0. 结论（先看这一节）

**可以进入第二阶段，但起点不是干净的 HEAD，而是「HEAD + 并行 WIP」。**

| 问题 | 结论 |
| --- | --- |
| 是否具备开工条件 | 具备。测试基线实跑全绿，四个 P0 的事实基础仍然成立 |
| 已被并行工作修复的 P0 | **0 个**。四个 P0 全部仍然存在 |
| 被并行工作部分缓解的 | P0-2 只改了注释与校验函数提取，未做 IP 固定；P0-1 的冲突策略只补了测试与文档，未改事务 |
| 需要重新验证的 | P0-2 的动态可利用性（仍需运行时对抗测试）；P0-3 对现有库的实际影响（无损坏证据） |
| 第一项应该做什么 | **P0-4 AI 写操作确认闸**，但必须先收口 `tool.call` 这条绕过路径（见 §5.3） |
| 预计涉及文件 | 见 §6 每项的「计划文件」；合计 15 个生产文件 + 6 个测试文件，按项分批，不是一次全改 |

### 0.1 本轮新增、第一阶段报告没有覆盖的三个事实

这三条直接改变整改方案，必须先看：

1. **「给六个导入步骤套一层事务」会失败，而且不会报错。**
   `ImportDao.kt:54/92/167`、`SourcesDao.kt:354` 的 `finally { db.autoCommit = true }` 会在内层函数退出时把外层事务提交掉并复位自动提交。0.2.35 的批量删书就是踩的这个坑（外层 commit 抛 `database in auto-commit mode`，书删了却回 `deleted=0`）。所以 P0-1 的第一步不是改 `BackupImporter`，而是先把 DAO 的事务边界拆出来。

2. **备份导入在事务之前就写了磁盘文件。**
   `BackupImporter.kt:132`、`:186` 在 `commit()` 之前调用 `keep.keep(...)`，`BackupStore.keep` 直接 `Files.move` 落盘（`BackupStore.kt:23-32`）。即使数据库全部回滚，个性化条目文件也已经写进去了。

3. **`tool.call` 直接调用 `target.handler`，绕过 `runTool`。**
   `AgentModule.kt:99-118`。只在 `Agent.runTool` 加确认闸，模型仍可先 `tool.search` 再 `tool.call` 绕过。第一阶段报告只提到 `tool.call` 会绕过「工具停用」，没提它同样绕过确认闸。

### 0.2 对第一阶段报告四处修正的采纳情况

| 修正 | 处理 |
| --- | --- |
| P0-5（AI 34 处 DAO 直连）不应与 P0 并列 | **采纳**，降为 P1-7，归第四阶段；第二阶段只做 P0-4 |
| P0-3 不应描述成「已发生数据损坏」 | **采纳**，见 §3.3 的措辞修正 |
| 上游 MD3 对照不够新 | **采纳**，第三、五阶段开工前重新抓取；本轮不动 |
| 测试数字不能当通过证明 | **采纳**，本轮已实跑，见 §4 |

---

## 1. 复核方法与限制

- 只读手段：`git status/diff/log`、`grep -n`、窗口阅读、`node` 汇总 JUnit XML。
- 实际执行：后端全量测试、前端全量测试、`tsc -b`。执行前后 `git status --porcelain` 均为 27 项，工作区未被改动。
- 未执行：47 项真浏览器门禁（需活服务与浏览器）、覆盖率、e2e 压测、任何攻击性验证。
- 未联网，未重新抓取上游 MD3。
- 运行时类结论一律标 `NEEDS_RUNTIME_TEST`，不与静态结论混写。

---

## 2. Git 工作区现状（只读）

```
分支 main ｜ HEAD 4291d30（origin/main 同步）｜ 唯一 worktree：E:/legado
变更 27 项：已跟踪修改 15、删除 1、未跟踪 11
stash 7 条，全部来自已删分支，与本次无关
```

### 2.1 变更归属（按工作流分类，不按文件类型）

| 工作流 | 文件 | 状态 | 对第二阶段的影响 |
| --- | --- | --- | --- |
| **模型拆分 WIP** | `model/Models.kt`（删除）+ `BackupModels/BookshelfModels/DiscoveryModels/ReadingModels/ReplaceRuleModels/SourceModels/SystemModels.kt`（新增）+ 3 个前端路径判据 | 未提交，已测过全绿 | 与 P0 无关，但**禁止 `git restore` / `checkout`**：会复活 `Models.kt`，与 7 个新文件产生重复声明 |
| **网络层 WIP** | `ops/GuardedHttpClient.kt`、`ops/NetworkSecurity.kt`、`NetworkSecurityTest.kt` | 未提交 | **P0-2 要改的文件正在被别人改**，必须等其提交或明确交接 |
| **导入冲突策略 WIP** | `ImportConflictPolicyTest.kt`、`product/docs/import-conflict-policy.md` | 未提交 | 与 P0-1 同域，测试可复用；整改时不要覆盖这份行为矩阵 |
| **发布完整性 WIP** | `.github/workflows/build-jar.yml` | 未提交 | 第一阶段报告称「发布流程已修复」，依据就是这份未提交改动。**WIP 丢了，结论就回退** |
| **文档刷新 WIP** | `AGENTS.md`、`docs/{ARCHITECTURE,README,ROADMAP,STATUS}.md`、`product/README.md`、`product/web/src/.../bookSourceFields.ts`、`docs/sessions/2026-11-13-models-and-workspace.md` | 未提交 | 纯文档/注释；与整改无冲突 |
| **测试卫生 WIP** | `BookCacheServiceTest.kt` | 未提交 | 修的是资源泄漏，与整改无冲突 |
| **第一阶段审计** | `docs/engineering/audit/`（7 份） | 未跟踪 | 本报告也放这里；归档需要一次提交，但本轮不提交 |

### 2.2 纪律（第二阶段全程有效）

1. 禁止 `git reset --hard`、`git clean`、`git checkout -- .`、`git restore .`、`git stash pop`。
2. 禁止对 `model/`、`ops/GuardedHttpClient.kt`、`ops/NetworkSecurity.kt`、`.github/workflows/build-jar.yml` 做「顺手整理」。
3. 每项整改只碰 §6 列出的文件；碰到清单外文件先停下来说明。
4. 不 bump `BUILD_NUMBER`（`VersionTracks.test.ts` 把它钉在 `RELEASES.md` 末行）。
5. 内部整改提交带 `[no-changelog]`，避免 `changelog:check` 逼着发版。

### 2.3 一个必须先做的决定

并行 WIP 已经跑过全绿，但它**没有主人签字**。建议开工前二选一：

- **A（推荐）**：由 WIP 作者先提交这批改动（模型拆分、网络层、导入策略、CI、文档各一笔），第二阶段从干净 HEAD 起步；
- **B**：用户确认这批 WIP 冻结，第二阶段在「HEAD + 冻结 WIP」上工作，并把上述相关文件加入禁改名单。

在没做这个决定前就开始改 P0-2，等于两个人同时改 `GuardedHttpClient.kt`。

---

## 3. 四个 P0 逐项重验

| 编号 | 第一阶段结论 | 本轮结论 | 关键证据 | 变化 |
| --- | --- | --- | --- | --- |
| P0-1 | 备份导入非原子 | **仍然存在** | `BackupImporter.kt:226-233`；`ImportDao.kt:34/54`、`:72/92`、`:115/167`；`SourcesDao.kt:326/354`；`ReplaceRuleDao.kt:138-192` | 无 |
| P0-2 | SSRF 连接级 TOCTOU | **仍然存在** | `GuardedHttpClient.kt:67-79`；`NetworkSecurity.kt:97` | WIP 只改注释、提取校验函数、补 IPv4-mapped 判定 |
| P0-3 | 无统一 schema version | **仍然存在** | `Schema.kt` 全文无 `user_version`；仅 `:17` 一个 pragma | 无 |
| P0-4 | AI 单写工具无确认闸 | **仍然存在，且比报告更严重** | `Agent.kt:86-124`；`BuiltinTools.kt:85,253`；`AgentModule.kt:99-118` | 新增发现：`tool.call` 绕过 |

### 3.1 P0-1 备份导入非原子（CONFIRMED，且有两处报告没写全）

**事实链**

- `commit()` 顺序调用六步：`importSources → importReplaceRules → importBookGroups → importLibrary → importRssSources → cookies()`（`BackupImporter.kt:226-233`）。
- 五步各自开事务并提交：`ImportDao.kt:34-54`（RSS）、`:72-92`（分组）、`:115-167`（书架）、`SourcesDao.kt:326-354`（书源）、`CookieDao.kt:208-225`（凭据，单条自动提交）。
- **`importReplaceRules` 根本没有事务**：`ReplaceRuleDao.kt:138` 只有 `write { db -> ... }`，循环里逐条 `executeUpdate()`（`:189`），自动提交模式下每条独立落库。这一节内部失败也不回滚。

**报告没写全的两点**

1. **外层包事务会静默失效**（见 §0.1-1）。这不是「加一层 try/catch」能解决的，必须先改事务边界。
2. **文件副作用在事务外**：`keep.keep` 在 `commit()` 之前执行（`BackupImporter.kt:132`、`:186`），数据库回滚不会撤销已写入的个性化条目文件。

**必须保留的正确设计**（整改时逐条写进测试）

- 墓碑防复活：`ImportDao.kt:118-134`（同事务读墓碑，命中即跳过并计入 `skippedDeleted`）。
- 本机 `enabled` 策展不被备份覆盖：`SourcesDao.kt:329-338` 的 `on conflict` 赋值列表刻意不含 `enabled`。
- 书架已存在时保留本机分组：`ImportDao.kt:141-142` 的注释与 SQL。
- 进度不回退：`ImportDao.kt:149-158` 的 `where excluded.updated_at >= ...`。

**幂等性实测判断**

- 书源按 `id` upsert、RSS 按 `source_url` upsert、分组按名字查重、书架按 `(source_id, book_url)` upsert —— 重复导入不产生重复行。
- **例外：替换规则**。`BackupImporter.kt:413` 允许 `id` 为空串；`ReplaceRuleDao.kt:151` 对空 id 生成 `时间戳_uuid`。老格式备份重复导入会产生重复规则。第一阶段报告说「重试会部分重复导入」只在这一处成立，整改时必须点名修。

### 3.2 P0-2 SSRF 连接级 TOCTOU（CONFIRMED，代码自认）

- 现状：`guard()` 先 `resolveAndValidateSafeHttpTarget`，再 `getAllByName` 复查全部应答，然后交给 JDK `HttpClient` 发送（`GuardedHttpClient.kt:67-79`）。
- JDK 17（`product/app/build.gradle:157-158`）的 `java.net.http.HttpClient` **不提供 SocketFactory / DNS 解析钩子**，建连时会再解析一次。WIP 的注释已经明确写了这一点（`GuardedHttpClient.kt:70-72`）。
- 所以：解析期与逐跳校验都在位，**连接层仍可被重绑定**。`NEEDS_RUNTIME_TEST` 只针对「能否稳定利用」，不针对「窗口是否存在」。

**方案评估（本轮只做评估，不实现）**

| 方案 | 可行性 | 代价 | 结论 |
| --- | --- | --- | --- |
| A. 本地回环 CONNECT 代理：`HttpClient` 只看到代理地址，代理内部「解析→校验→连同一个 `InetAddress`」 | 高，JDK 17 可用，TLS/SNI 端到端不变 | 新增约 150-250 行 `ops/` 组件 + 生命周期管理 | **推荐，先做半天 spike** |
| B. 换 OkHttp，用 `Dns` 接口固定 | 高 | 要重写出站封装与全部调用点（`send/sendAsync/BodyHandlers`） | 否决：等于重构网络层 |
| C. 升 JDK 18+，装 `InetAddressResolverProvider` | 中 | 影响全 JVM 解析；jlink/jpackage 打包链路要跟着动 | 备选，需单独评估打包 |
| D. 不修，只记录残余风险 | — | 安全边界留洞 | 不接受 |

方案 A 的注意点：必须只绑回环、端口随机、随进程关闭；`allowLoopback`（本机模型）要单独放行；SSE 与媒体流走隧道必须字节透传，不能缓冲整包。

### 3.3 P0-3 无统一 schema version（CONFIRMED，措辞需修正）

**确认的事实**

- 21 张表（`Schema.kt` 21 条 `create table if not exists`），全文只有 `:17` 的 `pragma journal_mode = wal`。
- 迁移是「缺什么补什么」：`Migration.kt:67/104/128/138/184/207` 六个 `migrate*`，靠 `pragma table_info` 判列。
- `initialize()` 把建表与六个迁移放在一个 `write { }` 里（`Database.kt:117-126`），但 `write` 只加锁、不设 `autoCommit=false`；**每条 DDL/DML 各自提交**，迁移中断仍可能停在半途。

**必须修正的表述**

- 已确认：缺少版本号；历史迁移不可诊断；迁移步骤无序号、无「只升不降」约束。
- **未确认**：现有数据库已经损坏。本轮没有证据支持这一点，第一阶段报告也没有。
- 因此 P0-3 的定性是「**数据可靠性整改**」，不是「事故修复」。

### 3.4 P0-4 AI 单写工具无确认闸（CONFIRMED，且有绕过路径）

- `Agent.runTool`（`Agent.kt:86-124`）只做三件事：`policy.allows` 组过滤、`hooks.runBefore`、执行 `tool.invoke`。**没有任何 confirm 调用**。
- `GuardrailsPolicy` 接口存在（`Guardrails.kt:16-20`），但只被 `sourceBatchTool` 使用：`BuiltinTools.kt:85` 取出 `policy::confirm`，`:253` 在批量删除前调用。
- `writes = true` 的工具共 **26 个**（`BuiltinTools.kt`），加 `tool.call`（`AgentModule.kt:101`）共 27 个写能力入口；**接闸的只有 1 个**（`source.batch`）。
- **绕过路径**：`tool.call` 的 handler 直接 `target.handler(callCtx, inner)`（`AgentModule.kt:118`），不经过 `runTool`。它的描述写着「写操作照常过护栏」，但代码里没有这道护栏。
- **第二条绕过/受影响路径**：调试自检 `AgentModule.selfTest` 用 `conn.call("replace.import")` 与 `conn.call("replace.delete")` 直接写库（`AgentModule.kt:134-152`，仅 `-Dai.debug` 时由 `Application` 调用）。加闸后这两步会被拒绝，自检必须显式传 `confirm=true`——这正好验证「显式意图才放行」，不要给它开后门。
- 影响面：`source.delete`、`replace.delete`、`rss.delete`、`shelf.remove`、`note.delete`、`progress.set`、`subscription.updateAll` 等都能被一句模型指令直接执行。

**P0-5 的处理**：`BuiltinTools.kt` 仍有 34 处 `import io.legado.data.*`，本轮不修。降为 P1-7，归第四阶段（AI 经 Application Service 取数）。第二阶段只做确认闸，不碰分层。

---

## 4. 测试基线（本轮实跑，不是引用文档）

| 项 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 后端全量 | `cd product && ./gradlew :app:test` | **1,171 项 / 153 suite / 0 失败 / 0 跳过**，BUILD SUCCESSFUL | 5m06s |
| 前端全量 | `npm --prefix product/web test` | **1,157 项 / 0 失败** | 40.1s |
| 类型检查 | `npm --prefix product/web run check` | `tsc -b` 通过（无输出） | 22s |

- 后端数字取自 `product/app/build/test-results/test/*.xml` 求和，最新时间戳 `2026-11-14T02:45:43Z`。
- **与文档的差异**：`docs/STATUS.md:7` 写 1,165 项 / 152 suite，实测 1,171 / 153。差额无法只由新增用例解释（`SourceValidateWarningsTest` 12 项 + `JsEnvironmentBridgeTest` 2 项 = +14，suite 却只 +1），说明 STATUS 的计数本身口径不一。**以 XML 求和为准**，第一阶段报告引用的正是这个不可靠数字。
- 未跑：47 项真浏览器门禁（需要活服务 + 浏览器）、`npm run coverage`、e2e。第三阶段用到时再跑。
- 执行前无 `java.exe` 进程；Gradle 提示「3 busy Daemons could not be reused」，说明本机还有别的守护进程，但没有活跃构建。执行后工作区仍为 27 项，无副作用。

**基线口径声明**：这组数字对应「HEAD 4291d30 + 当前未提交 WIP」。WIP 一旦变化（提交、回退、继续改），必须重跑并重新记录，不能沿用。

---

## 5. 开工前必须先解决的三件事

### 5.1 WIP 归属（§2.3 的 A/B 选择）
没有这个决定，P0-2 无法安全开工。

### 5.2 事务基础设施（P0-1 的前置）
不要在 `BackupImporter.commit()` 外面直接套 `write { autoCommit = false }`。需要先引入一个能表达嵌套的事务入口，例如：

```
Database.transaction { db -> ... }   // 深度计数：只有最外层设 autoCommit=false / commit / rollback
```

并把五个导入函数拆成「事务内实现」+「自带事务的公开包装」两层，保证既有调用点（HTTP 导入、测试）行为不变。

### 5.3 工具执行收口（P0-4 的前置）
确认闸必须放在 `runTool` 和 `tool.call` 都会经过的唯一入口。两个候选：

- **A（推荐）**：`ToolRegistry` 增加 `execute(ctx, id, args, policy)`，`runTool` 与 `tool.call` 都改走它；闸在 `execute` 里按 `meta.writes` 判定。
- **B**：`Tool.invoke` 内加闸，policy 从协程上下文取。改动更小，但 `Tool` 会依赖 `ToolPolicyElement`，且测试里直接构造 `Tool` 的路径行为会变。

无论哪种，`tool.call` 的 `writes=true` 不能对「只读目标」也要求确认——闸要判**目标工具**的 `writes`，不是 `tool.call` 自己的。

---

## 6. 逐项整改计划

> 顺序：P0-4 → P0-1 → P0-2 → P0-3 → 补测。每项单独提交、单独跑测试、单独验收；不允许一次性改完再测。

### 6.1 第 1 项：AI 写操作确认闸（P0-4）

| 项 | 内容 |
| --- | --- |
| 当前实现 | `runTool` 无 confirm；`GuardrailsPolicy` 只接批量删除；`tool.call` 直调 handler |
| 问题证据 | `Agent.kt:86-124`；`BuiltinTools.kt:85,253`；`AgentModule.kt:99-118`；26 个 `writes=true` |
| 计划文件 | `ai/Agent.kt`、`ai/AgentModule.kt`、`ai/ToolRegistry.kt`（或新增 `ai/ToolGate.kt`）、`ai/Guardrails.kt`；测试 `AgentFrameworkTest.kt` 或新增 `AgentWriteConfirmTest.kt` |
| 修改范围 | 约 80-120 行生产代码 + 5-6 条测试；不动任何工具实现 |
| 兼容风险 | 模型必须带 `confirm=true`（预期行为变化）；`source.batch` 已有闸，需避免二次提示；`AgentModule.selfTest` 的 `replace.import/delete` 要补 `confirm=true`（`AgentModule.kt:134-152`，仅调试模式） |
| 需要增加的测试 | ① 写工具无 confirm → `confirm_required` 且数据不变；② 带 confirm → 执行成功；③ `tool.call` 调写工具同样被拦；④ 只读工具不受影响；⑤ 批量工具仍只提示一次 |
| 验收标准 | 26 个写工具 + 经 `tool.call` 的间接调用全部可拦；只读工具零影响；1,171 项回归全绿 |
| 回滚方案 | 单提交 revert，无数据/结构变更 |

### 6.2 第 2 项：备份导入原子性（P0-1）

分三步，每步单独提交：

**2a 事务基础设施**

- `data/Database.kt` 增加 `transaction {}`（深度计数），`data/db/ConnectionPool.kt` 不动。
- 把 `importSources` / `importReplaceRules` / `importBookGroups` / `importLibrary` / `importRssSources` / `setCookieForUrl` 拆出 `*On(db)` 实现；公开函数变成「开事务 → 调 `*On`」。
- 验收：现有导入测试全绿，行为零变化。

**2b commit() 单事务 + 文件副作用后置**

- `BackupImporter.commit()` 用 `database.transaction { }` 包住六步。
- `keep.keep` 从解析阶段移到事务提交成功之后（先解析出 `name→text`，提交后再落盘）；失败时文件不写。
- 保留墓碑、`enabled`、分组、进度四条既有语义，逐条加断言。

**2c 替换规则幂等**

- 空 id 的规则：先按 `(pattern, scope, group)` 查重，命中则更新，未命中才生成 id；或给空 id 派生稳定哈希。
- 验收：同一份老格式备份导入两次，`replace_rule` 行数不变。

| 项 | 内容 |
| --- | --- |
| 计划文件 | `backup/BackupImporter.kt`、`backup/BackupStore.kt`（仅调整调用时机）、`data/ImportDao.kt`、`data/SourcesDao.kt`、`data/ReplaceRuleDao.kt`、`data/CookieDao.kt`、`data/Database.kt` |
| 修改范围 | 约 250-350 行（大部分是函数签名拆分，逻辑逐字搬移） |
| 兼容风险 | 单写连接 + ReentrantLock：事务期间所有写请求排队，导入大包时 HTTP 写会变慢；不得在事务内做网络/文件 IO |
| 需要增加的测试 | ① 六步各注入一次失败 → 六个域全部无变化；② 重试两次 → 行数稳定；③ 墓碑内的书不复活；④ 本机 `enabled` 不被覆盖；⑤ 进度不回退；⑥ 文件副作用在失败时不落盘 |
| 失败注入方式 | 在 `BackupImporter` 加 `internal var stepHook: ((String) -> Unit)? = null`（仅测试可见，默认 null），按步骤名抛错。不要做成运行时开关 |
| 验收标准 | 上述 6 条 + 1,171 项回归全绿；导入成功路径的 `BackupImportTest` 14 项行为不变 |
| 回滚方案 | 按 2c → 2b → 2a 逆序 revert；无 schema 变更，数据库文件不受影响 |

### 6.3 第 3 项：SSRF 连接级 IP 固定（P0-2）

**先 spike，后实现。** spike 的交付物是一页结论 + 一个可跑的 PoC 测试，不合并生产代码。

| 项 | 内容 |
| --- | --- |
| 当前实现 | 解析期 + 发送前复查，连接层未固定 |
| 问题证据 | `GuardedHttpClient.kt:67-79`；JDK 17 无 DNS 钩子 |
| 计划文件 | 新增 `ops/PinnedProxy.kt`（方案 A）；`ops/GuardedHttpClient.kt`、`ops/NetworkSecurity.kt` 只做接线；测试新增 `PinnedProxyTest.kt` |
| 修改范围 | 约 200-300 行；不改任何调用点 |
| 兼容风险 | HTTPS CONNECT、SSE 流式、媒体大包、`allowLoopback`（本机模型）、MCP 出站；代理端口冲突与关闭顺序 |
| 需要增加的测试 | ① 可注入解析器：第一次公网、第二次私网 → 连接仍落在已校验 IP；② 应答集含私网 → 发送前拒绝；③ HTTPS 证书仍按原主机名校验；④ SSE 不被缓冲；⑤ 既有 `NetworkSecurityTest` 6 项全绿 |
| 验收标准 | TOCTOU 用例可稳定复现「旧实现失败、新实现通过」；回归全绿 |
| 回滚方案 | 单提交 revert；不保留运行时开关（避免安全边界可被配置关掉） |

### 6.4 第 4 项：SQLite Schema Version（P0-3）

| 项 | 内容 |
| --- | --- |
| 当前实现 | 无版本号；六个幂等补列；建表与迁移每条自动提交 |
| 问题证据 | `Schema.kt`（21 表、仅 `:17` pragma）；`Migration.kt:67-207`；`Database.kt:117-126` |
| 计划文件 | `data/db/Schema.kt`、`data/db/Migration.kt`、`data/Database.kt`；测试 `data/db/MigrationTest.kt` |
| 设计要点 | ① 用 `pragma user_version`（不用 `app_meta` 键，避免与业务键混用）；② 现有库视为 version 0，先跑全部幂等补列，再回填为基线 1；③ 新迁移按 `fromVersion → toVersion` 注册，每步一个事务，`user_version` 在同一事务内更新；④ 失败抛错阻止启动，禁止带病运行；⑤ 不删旧字段，先标废弃 |
| 修改范围 | 约 150-250 行 |
| 兼容风险 | 旧快照恢复 → 版本回退 → 迁移必须可重入（现有补列本身幂等，满足）；`VACUUM` 保留 `user_version`；多进程同时启动不在支持范围（已有单实例探测） |
| 需要增加的测试 | 五类库：全新、当前版、旧版逐级、缺列异常库、万级数据量；另加「迁移中途失败 → 版本不变、库可重试」 |
| 验收标准 | 五类库全部通过；`MigrationTest` 原 9 项不回归；启动失败有明确错误信息 |
| 回滚方案 | 单提交 revert；`user_version` 是附加 pragma，旧代码忽略它即可 |

### 6.5 第 5 项：沙箱与网络边界补测

只补测试，不改行为（S-1 若确认例外过宽，再单独一笔收窄）。

| 项 | 内容 |
| --- | --- |
| P1-5 沙箱 E 项 | 统一预算前置基线；按 `rules-sandbox-audit.md` E 项补判据 |
| S-1 Cookie 例外 | 断言 `Guard.kt:53-58` 只覆盖 `SourcesRoutes.kt:772` 一条路径与必要头 |
| S-2 路径穿越 | 备份包内条目名、媒体/文件 API 的符号路径与 `..` |
| S-3 错误响应 | 抽验各路由错误路径不吐堆栈与绝对路径 |
| 验收标准 | 新增用例全部为「负向断言」（该拒的必须拒），不新增通过型空测试 |

---

## 7. 第二阶段执行门槛

每一项完成时必须同时满足：

1. 只改本项「计划文件」清单内的文件；
2. `./gradlew :app:test` 全绿，且测试总数 ≥ 1,171 + 本项新增；
3. `npm --prefix product/web test` 与 `tsc -b` 全绿（改到前端时）；
4. 提交信息写清「改了什么 / 为什么 / 怎么验证」，内部整改带 `[no-changelog]`；
5. 不 bump 版本号与 `BUILD_NUMBER`；
6. 不执行任何清理型 git 命令。

阶段结束产出：本报告的「执行记录」附录（每项的提交号、测试数字、遗留问题），**不覆盖**本报告正文。

---

## 8. 交付回答（对应开工前复核的六个问题）

1. **当前是否具备进入第二阶段的条件**：具备。基线全绿，四个 P0 事实成立；前提是先做 §2.3 的 WIP 归属决定。
2. **哪些 P0 已被并行工作修复**：没有。另外，第一阶段报告 §0 声称的「发布流程已修复」「导入冲突策略已修复」依据的是未提交 WIP，不算已交付（它们本来也不在这四个 P0 里）。
3. **哪些 P0 仍然存在**：P0-1、P0-2、P0-3、P0-4 全部存在。
4. **哪些问题需要重新验证**：P0-2 的动态可利用性（运行时对抗测试）；P0-3 对现有库的实际影响（当前无损坏证据）；上游 MD3 对照（第三阶段前重新抓取）。
5. **第二阶段第一项应该修改什么**：AI 写操作确认闸，但先按 §5.3 收口 `tool.call` 的执行路径；否则闸只挡住一半入口。
6. **预计涉及哪些文件**：生产代码 15 个 —— `ai/{Agent,AgentModule,ToolRegistry,Guardrails}.kt`、`backup/{BackupImporter,BackupStore}.kt`、`data/{Database,ImportDao,SourcesDao,ReplaceRuleDao,CookieDao}.kt`、`ops/{GuardedHttpClient,NetworkSecurity}.kt`、`data/db/{Schema,Migration}.kt`（按项分批，不是一次全改）；测试 6 个 —— `AgentWriteConfirmTest`（新）、`BackupImportTest`、`MigrationTest`、`NetworkSecurityTest`、`PinnedProxyTest`（新）、`ArchitectureBoundaryTest`（只在新增包时确认基线）。

---

## 9. 本轮未做的事（如实声明）

- 未修改任何源码、配置、数据库、构建脚本。
- 未提交、未暂存、未清理任何文件。
- 未执行攻击性验证，未验证 P0-2 的实际可利用性。
- 未重新抓取上游 MD3。
- 未运行真浏览器门禁、覆盖率与 e2e。
- 未对并行 WIP 的正确性做代码评审，只做了归属分类与基线确认。

---

## 10. 执行记录（第二阶段，按项追加）

> 本附录只记事实：提交号、当时的测试数字、遗留问题。正文不动。

### 10.1 P0-4 AI 写操作确认闸 —— 已完成

| 项 | 内容 |
| --- | --- |
| 提交 | `e534d8c` feat(ai): 写操作统一确认闸（P0-4） |
| 改动 | `ToolMeta.needsConfirm`（默认跟随 `writes`）、`Guardrails.confirmWrite` 单一判定、`Agent.runTool` 与 `tool.call` 都过闸（按**目标工具**判定）、`ToolRegistry` 自动补 `confirm` 参数、`AgentModule.selfTest` 补 `confirm` |
| 测试 | `AgentWriteConfirmTest`（新增 186 行）；全量 1,171 → 1,182 项 |
| 遗留 | `tool.call` 自身 `needsConfirm=false`（不写库）；MCP 工具豁免（参数表由远端 `inputSchema` 决定，本机补不进 `confirm`）。这两条是有意保留，见提交正文。 |

### 10.2 P0-1 备份导入原子性 —— 已完成（2a / 2b / 2c 三笔）

| 步骤 | 提交 | 内容 | 全量测试 |
| --- | --- | --- | --- |
| 2a 事务基础设施 | `36140b5` | `Database.transaction {}`（深度计数 + SAVEPOINT，只有最外层 commit/rollback）；六个导入函数拆成 `*On(db)` + 公开包装；`importReplaceRules` 从「无事务」改为单事务 | 1,182 / 155 suite |
| 2b commit 单事务 + 文件副作用后置 | `9b6902d` | `BackupImporter.commit()` 六步收进一笔事务；`keep.keep` 移到提交成功之后；`invalidateSourceCaches` 移到提交之后；新增 `internal stepHook` 供失败注入 | 1,185 / 156 suite |
| 2c 替换规则幂等 | `772ade2` | 空 id 规则先按内容找已有行（沿用其 id），未命中才用内容 SHA-1 派生 `legacy_<16hex>` | 1,186 / 156 suite |

**新增判据**

- `TransactionTest`（3 项）：内层失败只回滚内层、外层失败整批回滚、导入函数在事务内不提前提交。
- `BackupImportAtomicTest`（4 项）：六步逐一注入失败后六域与个性化文件都为空；成功路径六域齐备且文件在提交后存在；同一份备份连导两次行数稳定；空 id 规则连导两次不堆行。

**执行门槛核对**：只改 §6.2 计划文件（`BackupImporter.kt`、`Database.kt`、`ImportDao.kt`、`SourcesDao.kt`、`ReplaceRuleDao.kt`、`CookieDao.kt`；`BackupStore.kt` 未改，只改调用时机）；未 bump 版本号与 `BUILD_NUMBER`；未执行任何清理型 git 命令；三笔提交均带 `[no-changelog]`。

**遗留问题**

1. 事务期间独占单写连接：大包导入时其它写请求排队，未加超时/取消。读请求不受影响（读连接池独立）。
2. zip 路径的 `cookies.json` 解密仍在事务内读包（文件读，不是写）；如需彻底规避，得把 cookies 解析提前到事务外，属于后续优化。
3. 六步事务的失败注入是测试专用 `stepHook`，不是运行时开关；生产路径没有「部分导入」选项（有意如此）。
4. 多进程同时导入不在支持范围（单实例探测已有）。

### 10.3 P0-2 SSRF 连接级 IP 固定 —— 已完成

| 项 | 内容 |
| --- | --- |
| spike | `79eaaaa`，`docs/research/研究-P0-2-连接级IP固定-spike-2026-11-14.md` |
| 实现 | `d503cf6` feat(ops): 出站改走回环代理，连接级 IP 固定（P0-2） |
| 改动 | 新增 `ops/PinnedProxy`（只绑回环；解析一次 → 校验 → 连同一地址；https CONNECT 盲隧道、http 绝对形式改写转发）；`NetworkSecurity.newHttpClient` 全部请求经代理（严格 / 放行回环两个实例）；`GuardedHttpClient` 把代理建连失败还原成 `UnreachableTargetException` |
| 测试 | 新增 `PinnedProxyTest` 8 项；全量 1,186 → 1,194 项 / 157 suite / 0 失败 |
| 运行时验证 | 启动真实服务后，`curl -x 127.0.0.1:<代理端口>` 访问 `https://www.baidu.com` 与 `http://www.baidu.com` 均 200（CONNECT 与绝对形式两条路径都走通） |
| 遗留 | 明文 http 每请求一条到源站的连接（不复用、不流水线）；隧道线程为每连接两个守护线程，未做池化；真实 SSE 长连接未单独手测（字节透传已有判据） |

### 10.4 后续项状态

| 项 | 状态 |
| --- | --- |
| P0-3 SQLite Schema Version | **未开始**。按 §6.4 设计（`pragma user_version` + 按 `fromVersion → toVersion` 注册迁移） |
| 第 5 项 沙箱与网络边界补测 | **未开始**（只补测试，不改行为） |

### 10.5 补记（2026-11-14 目录与文件资产审计）

- §2.1 所列并行 WIP（模型拆分/网络层/导入冲突策略/发布完整性/文档刷新）已以 `6a19f28` 提交，正文「未提交」表述按快照纪律不回改，以本条为准。
- 第一阶段 P1-3「ARCHITECTURE.md Dao 数字漂移」被证伪：`*Dao*.kt` 实测 13 个，文档正确，不得改数（勘误见 `ARCHITECTURE_MAP.md` §11、`ROADMAP.md` §6、`directory/03-DOCUMENTATION-AUDIT.md` D-1）。
- 目录/文档/脚本卫生线整改计划：`directory/08-RECOMMENDED-STRUCTURE.md`（阶段 A-D）；其中 clean-local.sh 脏 worktree 保护（S-6）建议插队优先。

### 10.6 P0-3 SQLite Schema Version —— 已完成

| 项 | 内容 |
| --- | --- |
| 实现 | 新增 `data/db/SchemaVersion.kt`：版本号存 `pragma user_version`，`BASELINE = TARGET = 1`；注册表 `steps: Map<Int, (Connection) -> Unit>`（只增不改）；`migrate(db, target, plan)` 逐级升级，**每步动作与 `user_version` 同事务**，缺步骤或库版本超前均明确抛错 |
| 接线 | `Database.initialize()` 顺序改为「`Schema.createTables` → `Migration.maybeSnapshot`（迁移前原样快照，VACUUM 不能进事务）→ `transaction { SchemaVersion.migrate(tx) }`」；迁移失败包成 `IllegalStateException` 并带上「停在 vN、已回滚、可重试」，启动直接失败 |
| 基线语义 | 存量库与全新库都是 v0：基线迁移（v0 → v1）把六段历史补列（progress / shelf / source / legacyCookieJar / note / contentCache）各跑一遍，跑完回填 1。补列本身幂等，所以老库升级 = 一次普通启动 |
| 判据 | 新增 `data/db/SchemaVersionTest.kt` **8 项**，按 §6.4 的「五类库」逐类钉住：全新库（v0→1、可重入、已最新不重跑）、已最新版（零动作、不偷偷补列）、旧库逐级（1→2→3、每级落版本）、中途失败（整批回滚、版本不变、原地重试成功）、万级数据（10,000 行不丢）；另加「库比程序新 → 拒绝启动」与「基线一步补齐六段形状」 |
| 测试 | 定向：`SchemaVersionTest` 8 + `MigrationTest` 9 + `DatabaseTest` 24 全绿；**全量回归 1,202 项 / 158 suite / 0 失败 / 0 跳过（4m44s）**，较上一轮 1,194 / 157 正好多出新增的 8 项 |
| 文档 | `docs/ARCHITECTURE.md` 迁移策略段整段重写（原「没有 schema 版本号」已失效）、`docs/STATUS.md` 的 `data/db/` 组成补 `SchemaVersion` |
| 遗留 | ① 旧字段一律不删（只标废弃），等后续版本再单开一步迁移；② 多进程同时升级不在支持范围（沿用单实例探测）；③ 「用户手改库把某列删了但版本号仍是 1」这类自伤不在兜底范围 —— 版本号说了算 |

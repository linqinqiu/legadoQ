# 01 项目整体评估（legadoQ Phase 0）

> 本文是 `REBUILD_PLAN/` 的入口文档。所有分册结论在此汇总；细节与证据见 02–07 分册。
> 本文的每一个数字都有采集命令，采集时点与锚点见 §0。

---

## 0. 审计锚点

| 项 | 值 |
|---|---|
| 审计对象 | `E:\legadoQ-archive`（原 `E:\legado`，2026-11-17 22:08 归档改名） |
| 审计对象 HEAD | `771b311`（2026-11-17，`docs(changelog): 0.3.0 那两条更新日志改成用户能读懂的措辞`） |
| 审计对象工作树 | 干净（`git status --porcelain` 无输出），即 HEAD = 工作树 |
| 产品版本 | `0.3.0` / build `56`（`VERSION`、`BUILD_NUMBER`、`product/app/build.gradle:125`） |
| 新工作区 | `E:\legadoQ`（同一提交的完整克隆 + 新分支 `refactor/rebuild`） |
| 审计方式 | **纯静态只读**：读源码、grep、`git log/show`、只读 sqlite 查询。未构建、未启动服务、未发送任何出站请求、未修改旧项目任何文件 |
| 审计日期 | 2026-11-17 22:0x – 23:xx（Asia/Shanghai） |
| 分册 | 02a 后端清单 / 02b 前端清单 / 03 依赖与调用链 / 05 数据库 / 06 API / 07 安全与技术债务 / 04 Git 历史（本文 §4） |

**口径说明**：旧项目自己的 `product/docs/restructure/facts.md` 数字采集于 **2026-11-11**（HEAD `9564e26`，270 提交），此后代码又变了 112 个提交（其中 AI 子系统整体移出、备份导出补齐五域、引擎换 Netty）。**本文数字一律为本次实测**，与 facts.md 不一致处在 §2 标注差异原因。

---

## 1. 一句话结论

**这不是一个"烂到只能推倒"的旧项目，也不是一个"结构清晰可以直接长"的新项目。**

它是一个**用 22 天、382 个提交、由 AI 高频生成出来的中型单体**：功能面出乎意料地宽（30+ 功能面）、测试量出乎意料地厚（前后端实测 2,000+ 用例、测试代码占后端主源码 82%）、少数关键边界（SSRF、事务、备份导入、契约门禁）做得比同类开源项目更扎实；但同时，它带着所有"AI 高速生成"的典型病：**巨型文件、重复实现、事务双轨、文档宣传与实际能力脱节、一次不落地的重构尝试（77 个编译错误）**。

因此本审计的结论不是"重建 or 不重建"，而是：**用外科手术式重建（strangler）替代推倒重来**——保留 6 个已被测试钉死的兼容内核，替换 4 个真正的结构性瓶颈。理由与迁移成本见 §8 与 `08_TARGET_ARCHITECTURE_PROPOSAL.md`。

---

## 2. 规模实测（HEAD `771b311`，2026-11-17）

| 项 | 值 | 采集命令 |
|---|---:|---|
| 后端主源码 `.kt` | **123** 文件 / **29,553** 行 | `find product/app/src/main/kotlin/io/legado -name '*.kt' \| wc -l`；`-exec cat {} + \| wc -l` |
| 后端测试 `.kt` | **139** 文件 / **24,374** 行 / **993** `@Test` | 同上作用于 `product/app/src/test`；`grep -rho '@Test' product/app/src/test --include=*.kt \| wc -l` |
| 已移出编译路径的 AI 子系统 | **54** 文件 / **13,334** 行（`product/experimental/ai/`） | `find product/experimental -name '*.kt' \| wc -l` |
| 前端 `src` ts/tsx | **199** 文件 / **36,973** 行 | `find product/web/src \( -name '*.ts' -o -name '*.tsx' \) \| wc -l` |
| 前端单一全局样式表 | **6,757** 行（`product/web/src/styles.css`） | `wc -l` |
| 前端测试文件 | **139** | `ls product/web/test/*.test.* \| wc -l` |
| 数据库表 / 索引 / 触发器（源码） | **21 / 14 / 3** | `grep -c "create table if not exists" product/app/src/main/kotlin/io/legado/data/db/Schema.kt` |
| 端点（随包契约 `agent-api.json`） | **144 条 / 18 组** | `grep -o '"group": *"[^"]*"' product/app/src/main/resources/agent-api.json \| sort \| uniq -c` |
| 文档 `.md` | **496** 份 | `find docs product/docs -name '*.md' \| wc -l` |
| Git 提交 | **382** | `git rev-list --count HEAD` |

**与 facts.md（2026-11-11）的差异及原因**：后端主源码 139→123、行数 35,470→29,553 —— 不是删代码，而是 **AI 子系统 54 文件 / 13,334 行于 2026-11-17 整体移出编译路径**（`a105588`）；`@Test` 1,110→993 同理（25 个 AI 测试随之移出）。

**测试密度的含义**（重建的关键资产判断）：后端测试行数 = 主源码的 **82%**；前端 139 个测试文件对 199 个源文件。这类项目**换架构的最大成本不是代码量，而是行为约定的迁移**——好消息是行为约定已经被写下来了。

---

## 3. 产品形态与技术栈

**形态**：单进程、单用户、**无鉴权**的本地阅读服务。默认只听 `127.0.0.1:1234`，数据全在本地 SQLite。它的"安全模型"不是账号体系，而是「只绑回环 + 同源写门 + 出站 SSRF 闸门」三条（`docs/ARCHITECTURE.md:584-621`，本次已在源码复核确认，见 07 分册）。

**技术栈**（`product/app/build.gradle:130-160`、`product/web/package.json`）：

| 层 | 选型 |
|---|---|
| 后端 | Kotlin + **Ktor 3.4.3**（Netty 引擎，0.3.0 前曾是 CIO，因"停读客户端占满 IO 池"换掉，`f4d878b`）+ kotlinx-serialization |
| JDK | 17（`product/.java-version`、toolchain 锁定） |
| 规则解析 | **Jsoup 1.18.3**（CSS）、**JsoupXpath 2.5.1**（XPath）、**json-path 2.9.0**、**Rhino 1.8.0**（JS）、JDK 正则 |
| 存储 | **SQLite**（`sqlite-jdbc 3.49.1.0`，WAL，**池内只有一条写连接**） |
| 前端 | **React 19 + TypeScript + Vite**，自研 node:test runner 测试，单一 `styles.css`，MD3 风格 token |
| 打包 | fat jar / dist zip / jpackage 桌面包 / Docker / `start.mjs` 编排 |

**关键架构事实**（重建必须先接受的前提）：
1. **只有一个写连接**，`write{}` 不可嵌套（`data/Database.kt`）——这个约束塑造了全库事务模型，也是 P0 级事故的根源（见 05 分册 §4）。
2. **书源规则的语义由 JS 沙箱决定**，Rhino 里跑的是社区书源的任意脚本，沙箱是唯一 RCE 防线（`rules/JsSandbox.kt` 2,100 行 + `rules/JavaPackages.kt` 1,415 行）。
3. **前端是"内嵌 UI"而不是独立 SPA 产品**：无 router 库，主屏切换靠自研状态机（`main.tsx` ~733 行）。

---

## 4. Git 历史画像（本次自采，`git log` 全量）

### 4.1 时间与节奏

| 项 | 值 |
|---|---|
| 首个提交 | `92fbf57` 2026-10-26 `chore: 重建仓库基线 0.0.0`（623 个文件一次性入仓） |
| 末个提交 | `771b311` 2026-11-17 |
| 跨度 | **22 天**，382 提交（≈17 提交/天） |
| 提交者 | `linqinqiu` 378 / `lead` 5（**单人主导**） |
| 提交类型 | docs **132** / fix 75 / feat 66 / refactor 43 / chore 41 / test 11 / ci 6 / release 4 / perf 3 / **wip 1** |

**判读**：`docs` 提交数（132）超过 `feat`（66）一倍——这是**AI 辅助开发**的指纹：每轮改动都伴随一份状态/审计/研究文档。好处是决策留痕极完整（`docs/research/` 408KB、`docs/sessions/` 80KB、`docs/engineering/audit/` 11 份专题审计）；坏处是**文档本身成了需要维护的第二个产品**，并且已经出现漂移（见 §6.2）。

### 4.2 三次结构性重组（都成功落地，是正面证据）

| 提交 | 日期 | 规模 | 做了什么 |
|---|---|---|---|
| `d8f683d` | 2026-11-04 | 230 文件 | 后端分层 / 前端 features / API 按域重排，并修掉重排暴露的 5 处真实回归 |
| `b280cf0` | 2026-11-05 | 103 文件 | 前端按「外壳 / 功能模块 / 共享件」三层落位 |
| `695ab5d` | 2026-11-06 | 94 文件 | reader 目录按组拆分，50 个平铺文件收敛为根 8 + 8 组 |
| `a105588` | 2026-11-17 | 74 文件 | AI 子系统整体搬出编译路径（`product/experimental/ai/`），`/api/agent` 下线 |

**意义**：这个仓库**做过大规模机械重组并且活下来了**（有 `ArchitectureBoundaryTest`、`RouteMountTest`、`depth-check.mjs` 这类判据兜底）。这对重建是好消息——说明"搬运 + 判据"的工作方式在这里是被验证过的。

### 4.3 反复修改的文件（真实热点，40 个里最有信息量的）

| 文件 | 提交次数 | +行 | −行 | 判读 |
|---|---:|---:|---:|---|
| `product/web/src/styles.css` | 54 | 7,509 | 752 | **单一 6,757 行样式表**，前端最大的结构性债务 |
| `rules/RuleRunner.kt` | 35 | 2,888 | 1,130 | 规则引擎主类，改一次动全身 |
| `product/web/src/main.tsx` | 28 | 925 | 122 | 应用外壳/主屏状态机 |
| `features/reader/ReaderScreen.tsx` | 25 | 980 | 1,515 | 拆分净减 535 行，但仍是 2,403 行的状态中枢 |
| `rules/JsSandbox.kt` | 20 | 2,248 | 148 | 只增不减的安全边界 |
| `product/web/src/lib/api.ts` → `lib/api/*` | 20 | 1,358 | 1,353 | **净零 = 全量重写一次** |
| `model/Models.kt` → `model/*.kt` | 18 | 1,172 | 1,172 | **净零 = 全量拆分重写一次** |
| `product/app/src/test/.../FrameworkContractTest.kt` | 12 | 329 | 65 | 契约门禁自身在反复修 |

### 4.4 失败与回退事件（重建必须吸取的教训）

| 事件 | 证据 | 教训 |
|---|---|---|
| **一次重构没落地**：拆 ReaderScreen 的提交引用了不存在的字段，产生 **54 处类型错误**，最终**回退到可编译版本** | `docs/ARCHITECTURE.md:690-698` 自述；`3e07b00` | "写了文件 ≠ 做完了"，判据必须是 `tsc` 通过 + 行为不变 |
| **77 个编译错误的在途重构** | `d6f8ae7 fix: 让在途重构达到可构建状态（77 编译错误 → 0），并修正不实文档` | 大重构必须每一步可编译 |
| **重复的分页实现被整簇删除** | `53398ce refactor(reader): typeset 分页簇整簇删除——分页事实只留 DOM 量栏一份` | 同一事实两份实现 = 必有一份在骗人 |
| **"死代码"直读**：分页模式右键菜单整条无效 | `f3d4181` | 只读代码找不到这类问题，要有交互判据 |
| **AI 子系统上线 12 天后整体下线** | 11-05 起 `feat(ai)` 密集提交（MCP、确认闸、provider）→ 11-17 `54ee9cb`/`a105588`/`150949a` 三连移出，`a0b8e16` 记为**破坏性变更** | 功能上线前没人能回答"它解决谁的什么问题" |
| **插件系统整体移除** | `docs/ARCHITECTURE.md` §8.3：2026-10-26 起无 `plugin/` 包、无 jar 扫描开关 | 同上 |

### 4.5 已有的整改史（不是零基础）

`docs/engineering/audit/` 下有 **11 份** 2026-11-14 的专题审计（`SECURITY_THREAT_MODEL` / `DATA_MIGRATION_AUDIT` / `BACKUP_MATRIX` / `TEST_COVERAGE_MAP` / `PHASE2_PREFLIGHT_REPORT` 35KB 等），并已按 P0-1…P0-4 落地整改：备份六步导入收进一整笔事务（`9b6902d`）、可嵌套事务入口（`36140b5`）、库版本号 + 有序迁移（`72183a0`）、出站走回环代理做连接级 IP 固定（`d503cf6`）。

**这决定了本次审计的方法**：不是从零描述现状，而是**核对"上一轮审计声称已修的东西现在是否真的还成立"**。07 与 05 分册都发现了上一轮整改的**残余**（例如事务双轨仍有 12 处手动 `autoCommit`，且 `Database.kt:134-136` 的告警漏报了两个 DAO）。

---

## 5. 与上游生态的关系

| 关系 | 事实 | 证据 |
|---|---|---|
| 本项目 | `https://github.com/linqinqiu/legadoQ`，git 历史**从 2026-10-26 重建基线开始**（更早的两层嵌套历史归档在仓库外 `E:\legado-archive`） | `92fbf57`；`docs/STRUCTURE.md` |
| 上游参考 | `HapeLee/legado-with-MD3`（浅克隆在仓库外 `E:\legado-out\upstream`） | `docs/STRUCTURE.md`；`docs/ROADMAP.md` §3 |
| 原始项目 | `gedoor/legado`（Android 客户端，书源语法的**事实标准**） | `product/docs/compatibility.md` |
| 兼容目标 | **不做逐字节复刻**，目标是"让社区书源按作者意图跑出结果"，差异逐条记录 | `README.md` §书源语法兼容性 |

**这意味着**：书源规则引擎的语义不是本项目可以自由定义的，它受 `gedoor/legado` 的社区事实标准约束；**重建时不能"重新设计一套更干净的规则语义"**，只能重新设计承载它的结构。这是本次审计里最重要的边界条件之一。

---

## 6. 现状评估

### 6.1 真正扎实的部分（重建应当原样继承，而不是重写）

| # | 能力 | 为什么算扎实 |
|---|---|---|
| 1 | **出站 SSRF 三重防护** | 解析一次 → 逐 IP 判私网/回环/CGNAT/元数据/ULA → **连接级 IP 固定**（`ops/PinnedProxy.kt`）→ 关掉客户端内建重定向、**手写跟随且每跳重校验**（`rules/RuleRunner.kt:1267-1307`、`:1316`）。同类项目极少做到这一层 |
| 2 | **JS 沙箱白名单 + 宿主预算** | 45 类白名单 + `setClassShutter{false}` + `else -> error` + **不向沙箱注入真实 Java 对象**；本次静态审查**未发现可用逃逸路径**（07 分册 §2） |
| 3 | **备份导入的容错口径** | 不落盘解压（无 zip-slip）、按**真实字节**抗谎报、六域单事务、失败整笔回滚、冲突"跳过并如实回报"（`backup/BackupImporter.kt`） |
| 4 | **书源编解码与扩展字段保留** | `source.payload` 单列存原文 + `SourceCodec` 双向转换，保证非本产品认识的字段不丢（`source/SourceCodec.kt`）——兼容性的根 |
| 5 | **契约与边界门禁** | `ArchitectureBoundaryTest`（4 条硬边界，`rules→data/source/http` 横穿已清零）、`RouteMountTest`（路由必须挂载）、`ApiCatalog.test.ts`（端点目录双向钉住）、`GoldenRuleTest`（逐字节守规则输出）、47 个真浏览器 `*-check.mjs` |
| 6 | **测试体量** | 后端 993 `@Test` / 前端 139 文件；`test/resources/rule-golden/**` 有 6 类规则黄金样本 |

### 6.2 真正虚的部分（宣传 > 实现）

| # | 声称 | 实际 | 证据 |
|---|---|---|---|
| 1 | README 功能表列 **AI**（模型连接/流式对话/MCP） | 0.3.0 已整体下线，`/api/agent` 不再注册，代码移入 `product/experimental/ai/` | `README.md` vs `a0b8e16`；`product/experimental/README.md` |
| 2 | README：「**备份** …导出尚未支持」 | **导出已实现且五域齐全**（2026-11-17 当天做完） | `README.md` vs `c458a10`/`2ad73dc`/`a1315ce`/`bc00d9f`/`97a531e` |
| 3 | `GuardedHttpClient.kt:19` 注释：外部请求"只能由 `NetworkSecurity.newHttpClient` 签发" | **6 处裸 `HttpClient.newBuilder()` / 5 个文件**，无测试守门 | 02a 分册 §2；07 分册 §3 |
| 4 | 规则扩展点 `RuleProcessor` | **机制真实接入热路径**，但**产品内零自定义处理器**（只剩 2 个 demo，包外 import = 0）= 可用但空转 | `rules/processor/demo/*.kt`；02a §5 |
| 5 | 漫画支持 | 无 manga 模型字段、无独立子系统，靠正文图片占位 + 离线抓图副作用兜住 | 02a 分册 §2 |
| 6 | 可观测性 | `Metrics` 已接到 `/api/diagnostics`，但前端只有控制台 `__legadoPerf.report()`，无界面无持久化 | `docs/STATUS.md:213-218`；02b §3 |
| 7 | 「统一出站客户端层」 | 曾经存在过（`http/HttpClients.kt`），因**零调用方**在 0.2.36 被删 | `docs/ARCHITECTURE.md:684` |

### 6.3 结构性瓶颈（重写的真正候选，只有这四类）

| # | 瓶颈 | 规模 | 为什么不能靠"继续拆文件"解决 |
|---|---|---|---|
| 1 | **`RuleRunner` 仍把 HTTP 获取焊在规则求值里** | 1,758 行，其中 HTTP 段 260 行（`:1174-1437`） | `JsSandbox(this)` 反向依赖，导致"给脚本外出加预算/加闸门"无处下钩；且抓取+解码被复制了 8 份（其中 3 份漏闸门/漏 GzipLimits） |
| 2 | **事务模型双轨** | 12 处手动 `autoCommit`（`ShelfDao` 6 / `SourcesDao` 4 / `CacheDao` 1 / `SourceHealthDao` 1） | 单写连接 + 手动提交 = 被外层 `transaction{}` 包住时**静默提交、rollback 失效**；`Database.kt:128` 自述"0.2.35 批量删书事故就是这条" |
| 3 | **前端状态中枢** | `ReaderScreen.tsx` 2,403 行 + `styles.css` 6,757 行 + `main.tsx` 733 行 | 交互编排（段落点击/划词/图片放大/翻页落点）没有判据就被改坏过两次 |
| 4 | **发布与进程编排** | 5 个启动入口/编排者（`start.mjs` 22.8KB、`stop.mjs`、`DesktopLauncher.kt` 607 行、Dockerfile、2 个 `fun main`）+ Node 运行时前置依赖 | 打包链路是"能出包"而不是"可发布"：未签名、无 Secrets、触发面过宽 |

### 6.4 数据层的坏消息（05 分册实测，含只读实库查询）

- **`reading_progress` 是最大风险表**：实库 5 行里 **4 行无对应书架条目、3 行的 `source_id` 已不存在**；且它的建表 SQL **缺 5 列**（`char_offset`/`paragraph_anchor`/`position_checksum` 等），新建库也必须跑一遍补列迁移。
- **一个永久孤儿表带着真实数据**：实库里有 `book_mark`（1 行真实用户书签）+ 2 个索引，这三个名字在当前 Kotlin 源码里**零命中**，新代码只读 `book_note.bookmark` ⇒ **这条书签永远不可见**。
- **导出只覆盖 5 域，笔记/书签零导出入口**：换设备即永久丢失，且导出时没有任何提示。
- **迁移机制骨架正确但只有 v1 一个基线**（"锚点刚装好还没用"），真实风险在基线里的六段补丁——其中 `Migration.kt:100` 会把 `cookie_jar` 置空，**不可逆**。

---

## 7. 已有审计与本次审计的关系

| 已有资产 | 本次如何处理 |
|---|---|
| `docs/engineering/audit/` 11 份专题（2026-11-14） | 作为**线索**，逐条回源码核对；发现"已修"项的残余（事务双轨、告警漏报） |
| `product/docs/restructure/facts.md`（2026-11-11 数字） | 不采信数字，全部重测；已说明差异原因（AI 移出） |
| `docs/ARCHITECTURE.md`（783 行） | 引用其"已知缺口"表，但发现其 §7「AI 网关」章节整段已失效（代码已下线） |
| `docs/STATUS.md` / `docs/ROADMAP.md` | 只取口径定义，不取结论 |
| `AGENTS.md` 的"任务→位置速查表" | **本次审计直接受益**：它让 6 个并行子审计在不读全仓的前提下定位到真实实现点。它本身也是重建要保留的资产（§6.1-5） |

---

## 8. 评估结论：是否建议整体重建

### 8.1 我的判断：**不建议"推倒重来"，建议"外科式重建"**

理由（三条，全部可验证）：

1. **被测试钉住的行为约定是最大资产，推倒就没了。** 后端 24,374 行测试 / 993 用例、前端 139 个测试文件、6 类规则黄金样本——它们编码的是"社区书源在这个产品上应该跑出什么结果"这种**不可从文档推导、只能从实践中积累**的知识。全量重写意味着重造这批知识，而它恰好是兼容性的全部价值。
2. **书源语义受上游社区事实标准约束，不是自由设计空间。** 重建能改的是结构，不是语义（§5）。所谓"重新设计规则引擎"的收益上限很低，风险很高。
3. **真正的瓶颈只有四类（§6.3），且都不在"领域模型"层，而在"边界承载层"。** 换架构能解决的问题，用"换边界"也能解决，成本差 3–5 倍。

### 8.2 "整体重建"的成本/收益对照（供项目负责人决策，不是我的推荐）

| 方案 | 一次性成本 | 长期收益 | 主要风险 |
|---|---|---|---|
| A. 推倒重来（新空仓，只搬测试） | 最高：29.5k 后端 + 37k 前端全部重写，24k 测试需大面积改写 | 结构最干净 | 兼容性回归**无法在前期发现**（没有等价判据）；§4.4 记录的"54 处类型错误回退"会在更大尺度重演 |
| B. **外科式重建（推荐）**：保留 6 个内核 + 替换 4 个瓶颈层，每步有判据 | 中：约 30–40% 代码被替换，测试基本不动 | 结构显著改善，风险可控 | 需要严格克制"顺手把别的也改了" |
| C. 只做卫生（不重建，只还债） | 低 | 有限 | 四类瓶颈会持续复利 |

### 8.3 若选 B，"保留内核"的六个边界（详见 04 分册）

1. 规则语义与取值方言（`RuleRunner` 的规则分派 + `RuleValue` 的 `@put/@get`/`{{}}`/`||`/`%%` 那套）
2. JS 沙箱与 Java 桥白名单（`JsSandbox` + `JavaPackages`）
3. 书源编解码与扩展字段保留（`SourceCodec` + `source.payload`）
4. 出站闸门与连接级 IP 固定（`NetworkSecurity` + `PinnedProxy`）
5. 数据库 Schema 与迁移机制（`Schema` + `Migration` + `SchemaVersion`），**含实库兼容**
6. 备份导入的容错与事务口径（`BackupImporter` + `DbSnapshot`）

> 这六项的共同特征：**它们都是"错了就丢用户数据或丢兼容性"的地方**。它们也正是测试最厚的地方。

---

## 9. 证据索引（本文引用的关键位置）

| 结论 | 证据 |
|---|---|
| 审计锚点与工作树干净 | `git -C E:/legadoQ-archive log -1`；`git status --porcelain`（空） |
| 版本 0.3.0 / build 56 | `VERSION`、`BUILD_NUMBER`、`product/app/build.gradle:125` |
| 规模数字 | §2 各行的采集命令 |
| 22 天 382 提交、单人主导、docs>feat | `git rev-list --count HEAD`；`git shortlog -sn`；提交类型分布 |
| 三次结构重组 | `d8f683d` / `b280cf0` / `695ab5d` / `a105588` 的 `--shortstat` |
| 热点文件与净零重写 | `git log --numstat` 聚合（本文 §4.3） |
| 54 处类型错误回退 | `docs/ARCHITECTURE.md:690-698` |
| 77 编译错误 | `d6f8ae7` |
| AI 子系统生灭 | `a0b8e16`（破坏性）、`54ee9cb`、`a105588`、`150949a` |
| 单写连接与事务事故 | `data/Database.kt:128`、`:134-137` |
| SSRF 三重防护 | `ops/PinnedProxy.kt`、`ops/NetworkSecurity.kt`、`rules/RuleRunner.kt:1267-1307,1316` |
| 只绑回环 + 同源写门 | `http/Guard.kt:15-50`、`docs/ARCHITECTURE.md:584-621` |
| 上游生态定位 | `README.md`、`docs/STRUCTURE.md`、`docs/ROADMAP.md:125-160` |
| 端点 144 / 18 组 | `product/app/src/main/resources/agent-api.json` |
| 21 表 / 14 索引 / 3 触发器 | `data/db/Schema.kt:19-194` |

---

## 10. 覆盖率与分册指引

| 分册 | 内容 | 本册覆盖率（各子审计自报） |
|---|---|---|
| `02_ASSET_INVENTORY.md` | 后端 123 个源文件 / 前端 199 个源文件的能力清单 | 后端结构巡检 100%、内容精读 35.8%；前端分册 676 行（覆盖率见其 §12） |
| `03_DEPENDENCY_ANALYSIS.md` | 包依赖矩阵、7 条关键调用链、前后端契约 | 见其 §10 |
| `04_REUSE_AND_REWRITE.md` | 保留 / 提取重构 / 重新实现 / 废弃候选 四分类 | 基于 02–07 汇总 |
| `05_DATABASE_AUDIT.md` | 21 表逐字段、迁移六段、事务、数据丢失风险 | DDL 100%，DAO 实现体 ~17% |
| `06_API_AUDIT.md` | 144 端点全表、DTO 漂移、死端点、鉴权 | 见其 §12 |
| `07_SECURITY_AND_TECH_DEBT.md` | 威胁模型、按攻击面发现、P0–P3 债务 | 后端安全代码 ~75%，前端 ~8% |
| `08`–`11` | 目标架构、迁移路线、风险与验收、未决问题 | 基于以上全部 |

**明确没有审计到的部分**（不隐瞒）：
1. `product/experimental/ai/`（13,334 行）——按设计不参与编译与打包，只在 04 分册标为"废弃候选/待决策"。
2. 运行期行为：**没有任何测试被实际执行**（本次是静态审计）。所有"测试存在/覆盖某行为"的表述都基于源码与文档，不等于"当前能跑通"。
3. 47 个真浏览器门禁脚本（`product/tools/verify/*-check.mjs`）只统计数量，未逐个评估有效性。
4. 真实用户数据只做了**只读行数与孤儿判定**，未做内容分析（隐私）。

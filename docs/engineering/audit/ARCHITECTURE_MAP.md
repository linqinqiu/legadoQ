# legadoQ 架构地图（ARCHITECTURE_MAP）

> 审计日期：2026-11-14 ｜ HEAD：4291d30 ｜ VERSION 0.2.42 / BUILD_NUMBER 55
> 性质：第一阶段只读审计，未修改任何源码。所有结论基于本轮源码实测。

## 1. 总体结构

- 仓库 origin：linqinqiu/legadoQ（main @ 4291d30）。
- 后端：product/app（Kotlin + Ktor），核心命名空间 io.legado，业务域按目录划分：http/（路由）、data/（DAO 与数据模型）、rules/（规则引擎）、ai/（Agent 与工具）、ops/（网络安全与 HTTP 客户端）、backup/（备份恢复）、search/、rss/、media/、tts/ 等。
- 前端：product/web（React + TypeScript + Vite），按页面域组织组件，API 层统一封装于 lib/api/。
- 文档与契约：agent-api.json（API 清单，count=165，version 0.2.42）、docs/（工程文档）、product/docs（产品文档）。
- 工程守护：后端 ArchitectureBoundaryTest.kt 与前端 ArchitectureBoundary.test.ts 形成依赖方向测试锁。

## 2. 模块清单与职责边界

| 模块 | 职责 | 边界状态 |
| --- | --- | --- |
| http/ | API 路由与请求处理 | 直连 DAO 是普遍形态（见 §3） |
| data/ | DAO、数据模型、迁移、连接池 | 19 个顶层文件 + data/db/ 4 文件 |
| rules/ | 书源规则解析与执行（Rhino 沙箱） | 有测试锁：RULES_CONCRETE_BASELINE=emptySet |
| ai/ | Agent 会话与内置工具 | 34 处 import io.legado.data 直连（见 §5） |
| ops/ | GuardedHttpClient、NetworkSecurity | 出站网络统一出口 |
| backup/ | 备份导入导出 | P0-1 导入非原子 |
| 前端 lib/api/ | 请求封装 | reviews() 封装存在但零调用 |

## 3. Route 与 DAO 的实际耦合分布（本轮实测）

http/ 下 database. 调用共 87 处：

| 路由文件 | 直连处数 |
| --- | --- |
| SourcesRoutes | 24 |
| ReadingRoutes | 21 |
| ReplaceRules | 10 |
| Rss | 9 |
| Shelf | 6 |
| Search | 5 |
| Media | 4 |
| Subscriptions | 3 |
| TocRules | 3 |
| Backup | 2 |

结论：Route 内直接执行 SQL 是全项目的常态，而非个别文件的技术债。这意味着 Route→UseCase→Repository 的分层改造是第四阶段的主战场，必须先做试点（建议从书架或阅读域开始），不能一次推平。

## 4. 依赖方向守护（现状良好）

- 后端 ArchitectureBoundaryTest.kt：
  - 第 437 行 RULES_CONCRETE_BASELINE=emptySet：rules/ 不允许新增对具体基础设施的依赖。
  - 第 344 行：4 对包之间禁止循环依赖。
  - 第 383 行 ENGINE_TO_INFRA_BASELINE：规则引擎对基础设施依赖有白名单基线。
- 前端 ArchitectureBoundary.test.ts：第 57、77、91 行三条零基线依赖守卫，第 247 行 shell 层零基线，第 274 行扫描器有效性自检。
- 评估：这些测试锁说明工程已具备渐进重构的安全网，是本地图谱中最值得保留的资产。

## 5. AI 模块的实际依赖面

- ai/BuiltinTools.kt 有 34 处 import io.legado.data.*，工具实现直接持有书架、阅读、书源、RSS 等各域 DAO。
- Agent.kt 第 86-122 行 runTool 仅做 policy 组过滤与 before 钩子；Guardrails.kt 第 24-32 行 confirm 只覆盖批量 sourceBatchTool。
- 边界结论：AI 是当前唯一越过所有业务域直接修改数据的模块，属于第四阶段主改造点。第一阶段不改代码，仅记录。

## 6. 规则引擎边界

- RuleRunner.kt 第 1306、1316-1320 行手工逐跳重定向校验；第 1070-1102、1218-1242 行 deadlineMs 超时与取消。
- 沙箱三重限制：JsSandbox.kt ClassShutter 白名单 + optimizationLevel=-1；JsGuard 墙钟与栈深；JavaPackages 白名单（详见 SECURITY_THREAT_MODEL.md）。
- 边界结论：规则引擎与基础设施的依赖已受测试锁约束，但网络与存储能力没有显式接口抽象，Rhino 能力面与 JavaPackages 白名单耦合。第四阶段建议引入显式的网络访问、存储访问、日志、超时四个接口，而不是拆工程模块。

## 7. 数据流概览

- 阅读链路：前端阅读器 → ReadingRoutes（直连 DAO）→ data/（SQLite，WAL，单写连接）→ 返回章节与进度。
- 书源链路：书源管理 → SourcesRoutes → ImportDao/SourcesDao → 规则引擎执行 → 数据落库。
- AI 链路：前端 → Agent → BuiltinTools → 各域 DAO（无 UseCase 中间层）。
- 出站网络：规则引擎与 MCP 均经 GuardedHttpClient + NetworkSecurity 统一出口。
- 备份链路：BackupImporter 依次导入六类数据，各自独立事务（P0-1）。

## 8. 架构问题汇总

| 编号 | 问题 | 严重度 | 归属阶段 |
| --- | --- | --- | --- |
| A-1 | Route 直连 DAO 87 处 | 高（可维护性） | 第四阶段 |
| A-2 | AI 模块 34 处 DAO 直连 | 高 | 第四阶段（P0-4 写闸在第二阶段先修） |
| A-3 | 无 UseCase 层，业务逻辑散落 Route | 中 | 第四阶段 |
| A-4 | 规则引擎无显式能力接口 | 中 | 第四阶段 |
| A-5 | ARCHITECTURE.md 记 13 个 Dao 与实际 19 文件漂移 | 低 | 第四阶段文档校验 |
| A-6 | 前端 reviews() 死代码 | 低 | 第三阶段 |

## 9. 推荐目标架构（渐进，不推倒）

保持 Modular Monolith 单模块，逐步形成：

- Presentation/Routes：仅做参数解析、鉴权委托、响应组装，不含 SQL。
- Application/UseCases：每个业务域先建最小 UseCase（试点从书架域开始），承载跨表操作与事务边界。
- Domain：实体与领域服务（现有 data/ 模型即为雏形）。
- Infrastructure/Repository：以现有 DAO 为底，逐步包一层 Repository 接口，AI 模块只允许经 Application Service 取数。

不做的：不拆微服务、不引入 ORM 重写、不为目录形式机械分层。

## 10. 验收标准（供后续阶段引用）

- 第四阶段完成后：新增加的业务逻辑不再出现在 Route 中；至少一个业务域完成 Route→UseCase→Repository 全链路并有回归测试；AI 模块经 Application Service 取数；ARCHITECTURE.md 数字与代码一致且有自动校验。
- 全阶段：无新增循环依赖（ArchitectureBoundaryTest 全绿是硬门禁）。

## 11. 勘误（2026-11-14 目录与文件资产审计追加，正文不回改）

- **A-5 撤销**：「ARCHITECTURE.md 记 13 个 Dao 与实际 19 文件漂移」是误判。独立复核：`data/*Dao*.kt` 恰为 **13 个**；`data/` 顶层 19 个文件 = 13 Dao + Database + BookshelfRepository + SourceRepository + SessionCookies + DbSnapshot + StoreAdapters。ARCHITECTURE.md 的「13 个 Dao」**正确**，第四阶段不得据此改文档。文档数字自动校验若落地，口径应为 `*Dao.kt` glob 而非目录文件数。证据：`directory/03-DOCUMENTATION-AUDIT.md` D-1。

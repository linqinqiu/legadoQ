# legadoQ 全仓库审计报告（REPOSITORY_AUDIT）

> 审计日期：2026-11-14 ｜ HEAD：4291d30 ｜ VERSION 0.2.42 / BUILD_NUMBER 55
> 性质：第一阶段只读审计，未修改任何源码、配置、构建脚本或依赖。
> 上游参考：HapeLee/legado-with-MD3（v3.26.25 / commit 2e2c63c / 2026-11-08，来源：2026-11-13 对照报告，网络受限未重新抓取）。

## 0. 与 2026-11-13 旧报告的差异声明（必读）

旧报告约 40% 的 P0 结论已被并行开发工作修掉，本报告不沿用旧结论，以下为逐项重验结果：

| 旧报告 P0 结论 | 现状 | 证据 |
| --- | --- | --- |
| 发布流程无校验和 / 持续构建打 tag | 已修复 | `build-jar.yml:231-232` continuous-<sha>、`:309,330` SHA256SUMS、`:321` prerelease=!v*、`:325` make_latest 仅 v*，全文件无 `git tag -f` |
| 导入冲突策略缺失 | 已修复（WIP 交付） | `ImportConflictPolicyTest`（3 项）+ `product/docs/import-conflict-policy.md` 为当前工作树未提交文件 |
| SSRF 无测试 | 已缓解 | `NetworkSecurityTest` 6 项、`BindGuardTest` 4 项 |
| Rhino 无资源预算 | 已部分修复 | `AppConfig.kt:135,149-163` jsHostBytes（默认 64MB，0=不设限）+ `JsGuard.chargeHostBytes:132` + `JsSandboxHostBudgetTest` 3 项 |
| `globalThis.environment` 缺失 | 已实现，但 STATUS.md 未更新 | `JsSandbox.kt:414-420`（IS_LEGADO_SIGMA=false，提交 2cdf9d8）；`STATUS.md:167` 仍列为缺失，属文档滞后 |
| 段评后端不存在 | 旧报告表述不准 | 后端已实现，前端 `lib/api/domains/search.ts:141-142` 有 reviews() 封装但全前端零调用（详见 §7） |

## 1. 项目全景

- 仓库 origin：linqinqiu/legadoQ（main @ 4291d30）。
- 结构：`product/app`（Kotlin + Ktor 后端）、`product/web`（React + TS + Vite 前端）、`product/docs`、`docs/`（工程文档）、`agent-api.json`（API 清单，count=165，version 0.2.42）。
- 当前工作树不干净：并行 agent 正在做 Models.kt 拆 7 个 DTO、GuardedHttpClient/NetworkSecurity 修改、导入冲突策略新增。本审计以 HEAD 4291d30 + 该 WIP 现状为准，未覆盖、未提交、未清理。
- 状态基线：`docs/STATUS.md` §5 记录 2026-11-13 后端 1,165 项测试全绿（152 suite）/ 前端 1,157 项 / tsc 通过。

## 2. 检查范围与方法

只读手段：目录枚举、Select-String 定位 + 40-150 行窗口阅读、git log/show。遵守 E:\legado\AGENTS.md 禁读区（docs/archive、product/data、build 产物、node_modules、dist、jar）。
未做：测试执行、构建、攻击性验证、运行时行为观察。运行时类结论一律标 NEEDS_RUNTIME_TEST。

## 3. P0 问题清单（全部为本轮实测确认）

### P0-1 备份导入非原子（CONFIRMED）
- 位置：`product/app/src/main/kotlin/io/legado/backup/BackupImporter.kt:216-252` commit()。
- 原因：commit() 依次调用 importSources → importReplaceRules → importBookGroups → importLibrary → importRssSources → cookies()，各 import* 各自独立事务（`data/ImportDao.kt:33-54,71-92,114-167`；`data/SourcesDao.kt:312-346`）。
- 影响：中途失败时前面已提交的步骤不回滚，重试会部分重复导入。
- 复现：构造一个在 importLibrary 阶段失败的备份包，观察源/替换规则已写入而书架缺失，重试后数据重复。
- 建议：commit() 外层包单一事务（或失败时执行补偿回退），重用 `DbSnapshot` 的 pre-restore- 副本机制。
- 验证：新增导入中途失败用例，断言全部回滚；重复导入不产生重复行。

### P0-2 SSRF 连接级 TOCTOU 残余（CONFIRMED，代码自认）
- 位置：`product/app/src/main/kotlin/io/legado/ops/GuardedHttpClient.kt:22,71-72`。
- 原因：`NetworkSecurity.kt:67` resolveAndValidateSafeHttpTarget 与 `:97` validateResolvedAddresses（回环/私网/链路本地/CGNAT/0:124/IPv4-mapped:136-141）在解析期校验，连接层未固定 IP，DNS 解析与实际连接之间窗口未关闭——源码注释明确写"narrows but does not close the DNS TOCTOU window"。
- 影响：恶意书源可用 DNS 重绑定绕过私网拦截。
- 复现：控制 DNS 的环境将域名先解析到公网 IP 再切回 169.254.169.254（NEEDS_RUNTIME_TEST）。
- 建议：连接时 pin 已校验 IP（自定义 SocketFactory/DNS 覆盖），逐跳重定向均复用。
- 验证：TOCTOU 对抗测试 + 既有 NetworkSecurityTest 全绿。

### P0-3 无统一 schema version（CONFIRMED）
- 位置：`product/app/src/main/kotlin/io/legado/data/db/Schema.kt`（21 表，全文仅 `:17` 一个 pragma journal_mode=wal）；`data/db/Migration.kt` 幂等补列。
- 原因：数据库无 user_version/schema_version，迁移是"缺什么补什么"的幂等补列，无法表达"只能升不能降""迁移序号""迁移中断"。
- 影响：历史版本兼容性靠枚举补丁维持；异常库（缺字段、半迁移）无法被识别和定向修复。
- 建议：引入 user_version + 有序迁移表，现有幂等补列层保留为兜底（详见 DATA_MIGRATION_AUDIT.md）。
- 验证：构造全新/当前/旧版/缺字段四类库跑迁移测试（MigrationTest 现有 9 项为基础扩展）。

### P0-4 AI 工具写操作缺逐写确认闸（CONFIRMED）
- 位置：`product/app/src/main/kotlin/io/legado/ai/Agent.kt:86-122` runTool 仅做 policy 组过滤 + before 钩子；`ai/Guardrails.kt:24-32` DefaultGuardrailsPolicy 的 confirm 仅接批量 `sourceBatchTool`（`BuiltinTools.kt:83-88,249-262`）。
- 原因：ToolPolicy（Agent.kt:303,553）只做组白名单；单个写工具（source.upsert:228-239、source.delete:242-246、source.order:264-269、replace.delete、rss.delete 等 writes=true）无 confirm 闸。
- 影响：AI 会话可未经确认直接增删改书源/替换规则/RSS 数据。
- 建议：在 runTool 层按 `writes` 能力位统一插 confirm 钩子，批量工具既有闸保留。
- 验证：写工具未确认时拒绝执行 + 确认后放行的双向用例。

### P0-5 AI 模块直连 DAO（CONFIRMED）
- 位置：`ai/BuiltinTools.kt` 34 处 `import io.legado.data.*`。
- 原因：工具实现直接持有各域 DAO 并读写数据。
- 影响：AI 能力边界无法独立演进，属于第四阶段主改造点；数据一致性风险与 P0-4 叠加。
- 建议：先做 P0-4 的写闸（安全优先），分层改造放第四阶段（见 ARCHITECTURE_MAP.md）。

## 4. P1 问题清单

| 编号 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- |
| P1-1 | golden corpus 仅 15 文件（6 目录），书源规则兼容性回归覆盖不足 | rule-golden 目录实测 | 扩充语料，覆盖 java.t2s/s2t、JSONPath 边界 |
| P1-2 | 兼容性缺口：`java.t2s`/`java.s2t` 零实现 | grep 零命中；STATUS.md:167 记 30/7 源受影响 | 实现繁简转换工具方法 |
| P1-3 | ARCHITECTURE.md 写"13 个 Dao"与实际 19 文件漂移 | docs/ARCHITECTURE.md:112,249,721 vs data/ 顶层 19 文件实测 | 文档自动校验（第四阶段） |
| P1-4 | STATUS.md:167 仍列 environment 缺失 | JsSandbox.kt:414-420 已实现 | 更新状态文档 |
| P1-5 | 沙箱审计 rules-sandbox-audit.md E 项（统一预算前置基线未做） | 沙箱审计文档 | 纳入第二阶段沙箱加固 |
| P1-6 | 大文件债务：Models.kt 原文件过大（WIP 正在拆分，避免重复劳动） | 并行 WIP | 等 WIP 合并后复核 |

## 5. 业务模块成熟度速览

| 业务 | 状态 | 依据 |
| --- | --- | --- |
| 书架/阅读/进度/书签 | 基本可用 | ReadingRoutes/Shelf 路由 + ReadingDao/ShelfDao 完整链路 |
| 书源管理 | 基本可用（冲突策略 WIP） | SourcesRoutes 24 处 DAO 直连；ImportConflictPolicyTest WIP |
| 规则引擎 | 基本可用，边界最敏感 | RuleRunner.kt:1306,1316-1320 手工逐跳重定向校验 + deadlineMs（:1070-1102,1218-1242） |
| 段评 | 仅有后端 + 死代码客户端 | 见 §7 |
| RSS | 基本可用 | RssRoutes 9 处直连、RssDao |
| TTS/AI | AI 半成品（写闸缺失），TTS 基本可用 | P0-4/P0-5 |
| 备份恢复 | 存在缺陷（P0-1） | BackupImporter.kt:216-252 |
| 书源体检 | 半成品 UI | 见 §7 |
| 媒体 | 基本可用 | MediaRoutes.kt:447-481 逐跳重校验 + Redirect.NEVER(:450) |

## 6. 架构观察摘要（详见 ARCHITECTURE_MAP.md）

- http/ 下 `database.` 调用 87 处（SourcesRoutes 24、ReadingRoutes 21、ReplaceRules 10、Rss 9、Shelf 6、Search 5、Media 4、Subscriptions 3、TocRules 3、Backup 2）——Route→DAO 直连是普遍形态而非个别现象。
- 依赖方向有测试锁：`ArchitectureBoundaryTest.kt:437` RULES_CONCRETE_BASELINE=emptySet、`:344` 4 对包循环禁令、`:383` ENGINE_TO_INFRA_BASELINE；前端 `ArchitectureBoundary.test.ts:57,77,91` 三条零基线 + :247 shell 零基线 + :274 扫描器有效性守卫。边界约束意识良好，是渐进重构的基础。

## 7. 功能完成度审计

### 段评（半成品：仅有后端）
- 后端：API 与数据模型已实现。
- 前端：`product/web/src/lib/api/domains/search.ts:141-142` reviews() 封装存在，但 `web/src` 全文 `.reviews(` 零调用方（BookInfoEditModal 的 previewSrc 为误匹配）——客户端为死代码，用户无任何入口。
- 结论：段评 = 仅有后端；第三阶段需从"选中文本→锚点→浮层"全链路补 UI。

### 书源体检（半成品 UI）
- 后端检测链路存在（SourceHealthDao、检测执行逻辑）。
- 前端展示/过滤/分档交互不完整，无按状态过滤、详细错误视图、批量启停。
- 结论：基本可用后端 + 半成品 UI。

### 其他半成品检查结果
- 占位按钮/空事件处理器/无效果设置项：本轮窗口阅读未发现新增项（检查范围：web/src 全文 grep 事件绑定与 TODO 标记）。
- 废弃插件文档：docs/ 内存在旧架构说明与失效示例（详见第五节建议清单，逐项判定在第三阶段执行）。

## 8. 安全审计摘要（详见 SECURITY_THREAT_MODEL.md）

- 绑定闸：`Application.kt:93-104` requireLoopbackBind（LEGADO_ALLOW_EXTERNAL_BIND=1 才放行非回环）。
- 写保护：`Guard.kt:30` SAFE_METHODS、`:72` SameOriginWriteGate 全局插件、`:22-27` 0.6.23 改比 ServerIdentity 防 DNS 重绑定、`:57` Cookie 同步例外（SourcesRoutes.kt:772）。
- 无 CORS install（Application.kt 仅 ContentNegotiation/Compression/WebSockets/StatusPages/SameOriginWriteGate）。
- 沙箱：`JsSandbox.kt:303` ClassShutter{false}、`:302` optimizationLevel=-1；`JsGuard.kt:90` GRANULARITY=20_000、:91 栈深 1000 + 墙钟 deadline；`JavaPackages.kt:45-52` 白名单 + requireAllowedLength（:410,593,722）；`JsoupBridge.kt:14-42` 只 parse 不 connect；MCP `McpClient.kt:65,224-230` 走 NetworkSecurity。
- NOT_A_BUG 事项：不能仅因存在 Java 互操作 API 认定沙箱失效——白名单 + ClassShutter + 预算三重限制已在位。

## 9. 数据库审计摘要（详见 DATA_MIGRATION_AUDIT.md）

21 表；WAL 已启用；单写连接 + ReentrantLock（ConnectionPool.kt:60-75, close :77-90）；DbSnapshot 有 SHA-256 sidecar + .pending-restore + pre-restore- 副本回退（DbSnapshot.kt:56,57,83-106）。核心缺口 = 无 schema version（P0-3）+ 导入非原子（P0-1）。

## 10. 桌面与启动（详见 ROADMAP.md 第六阶段衔接）

`DesktopLauncher.kt:84-85` host/port 可配、:91-100 数据目录 LOCALAPPDATA 回退、:109-134 端口顺延 + port.txt、:114-121 单实例探测、:165-168 shutdown hook、:308-322 waitForHealth、:325-354 --app 窗口 + 看门狗。独立服务骨架已存在，产品化差距集中在安装/更新/托盘。

## 11. 审计总结

- 真实成熟度：可用性高于"半成品"印象——152 suite 测试体系、边界测试锁、沙箱三重限制、绑定闸均已落地；主要短板是导入原子性、schema 演进、AI 写闸、SSRF 收口、段评/体检的产品最后一公里。
- 最严重五个问题：P0-1 备份导入非原子、P0-2 SSRF TOCTOU、P0-3 无 schema version、P0-4 AI 写操作无确认闸、P1-2 java.t2s/s2t 缺失影响兼容性。
- 最值得优先处理五个：P0-1（数据安全）、P0-4（AI 安全）、P0-3（迁移基座）、P0-2（收口）、第三阶段段评收口。
- 最容易完成五个：P1-4 更新 STATUS environment 条目、P1-3 修正 ARCHITECTURE.md Dao 数字、段评 reviews() 复用接入、书源体检过滤分档、废弃文档清理。
- 最值得长期投入五个：Route→UseCase→Repository 渐进分层、golden corpus 扩充、schema version + 有序迁移、AI 工具边界 Application Service 化、桌面产品化（Tauri 2 评估）。

## 12. 审计限制

- 未运行测试与构建（只读纪律 + WIP 树），测试数字引自 STATUS.md §5 的 2026-11-13 记录。
- 未做攻击性/渗透验证，P0-2 的 DNS 重绑定复现标 NEEDS_RUNTIME_TEST。
- MD3 对照复用 2026-11-13 报告（网络受限），未重新抓取上游。
- 工作树含并行 WIP，个别 file:line 在 WIP 合并后可能偏移。
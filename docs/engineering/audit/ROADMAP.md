# legadoQ 整改路线图（ROADMAP）

> 审计日期：2026-11-14 ｜ HEAD：4291d30 ｜ 性质：第一阶段只读审计产出。
> 依据：REPOSITORY_AUDIT、SECURITY_THREAT_MODEL、DATA_MIGRATION_AUDIT、TEST_COVERAGE_MAP、UPSTREAM_COMPARISON 五份报告。所有问题编号与上述报告一致。

## 1. 优先级总览

| 优先级 | 问题 | 一句话结论 |
| --- | --- | --- |
| P0-1 | 备份导入非原子 | 六步独立事务，失败不回滚 |
| P0-2 | SSRF 连接级 TOCTOU | 解析期校验在位，连接层 IP 未固定 |
| P0-3 | 无 schema version | 21 表仅靠幂等补列，无版本号 |
| P0-4 | AI 单写工具无确认闸 | 仅批量工具接 confirm |
| P1-1 | golden corpus 仅 15 文件 | 规则兼容回归覆盖不足 |
| P1-2 | java.t2s/s2t 零实现 | 30/7 源受影响 |
| P1-3 | ARCHITECTURE.md Dao 数字漂移 | 13 vs 实际 19 |
| P1-4 | STATUS.md environment 条目滞后 | 已实现仍列缺失 |
| P1-5 | 沙箱统一预算前置基线未做 | 沙箱审计 E 项 |
| P1-6 | 大文件债务 Models.kt | WIP 拆分进行中 |

## 2. 整改顺序（对应手册阶段）

### 第二阶段（P0 安全与数据可靠性）
1. P0-4 AI 写闸（改动最小、收益直接：runTool 层按 writes 位插 confirm，双向测试）。
2. P0-1 导入原子性（commit() 链并入单事务或补偿回退，保留墓碑与 enabled 策展逻辑，补中途失败/重复导入测试）。
3. P0-2 SSRF 收口（连接时 pin 已校验 IP，逐跳复用，补 TOCTOU 对抗测试）。
4. P0-3 schema version（user_version + 有序迁移，保留幂等补列为兜底，五类库迁移测试）。
5. P1-5 沙箱 E 项 + S-1 Cookie 例外窄化 + S-2/S-3 边界测试。

### 第三阶段（半成品收口）
1. 段评 UI：复用 reviews() 封装，从选中文本到锚点全链路（P1-6 收口）。
2. 书源体检 UI：状态过滤、分档、详细错误、批量启停。
3. 废弃插件文档清理（逐项核对代码引用，禁止只删文档）。
4. README 定位强化（不宣传未完成功能）。

### 第四阶段（架构与契约治理）
1. Route→UseCase→Repository 试点（书架域起步，87 处直连不一次推平）。
2. AI 模块经 Application Service 取数（P0-5 的阶段落地）。
3. 规则引擎显式能力接口（网络、存储、日志、超时四接口，不拆工程模块）。
4. API 契约单一事实源（OpenAPI 或类型生成，agent-api.json 165 项为校验基线）。
5. 文档自动校验（P1-3 收口，防 ARCHITECTURE.md 再漂移）。

### 第五阶段（体验与性能）
1. 设计 Token 统一。
2. 阅读器长章节性能（带测量数字）。
3. 移动端与桌面端布局回归（复用 47 项真浏览器门禁）。

### 第六阶段（产品化）
1. 独立服务模式固化（DesktopLauncher 骨架已在位）。
2. Tauri 2 选型评估（基于实际结构，不按宣传材料）。
3. Windows 安装/更新/回滚方案（更新前强制数据库备份）。

## 3. 工作量与验收标准

| 项 | 估量 | 验收标准 |
| --- | --- | --- |
| P0-4 | 小 | 未确认拒绝执行、确认后放行，双向用例全绿 |
| P0-1 | 中 | 中途失败全量回滚、重复导入零重复行，全库行为不变 |
| P0-2 | 中 | TOCTOU 对抗测试通过，NetworkSecurityTest 全绿 |
| P0-3 | 中 | 五类库迁移测试通过，失败明确报错并阻止启动 |
| P1-1 | 中 | corpus 覆盖 t2s/s2t 与 JSONPath 边界 |
| P1-2 | 小 | t2s/s2t 实现并进 corpus |
| P1-3/P1-4 | 小 | 文档数字与代码一致，有自动校验 |
| 段评 | 中 | 选中文本能定位、浮层跨屏适配、失败可恢复阅读 |
| 体检 UI | 中 | 五档过滤 + 批量启停 + 危险操作确认 |

## 4. 明确不做（各阶段约束）

- 不推倒技术栈，不拆微服务，不照搬 Android 架构。
- 不为架构形式机械分层；只修真实问题。
- 不为安全关闭全部 Java 互操作（需兼容性测试集护航）。
- 不把 0.0.0.0 绑定当作访问方案（远程访问需独立认证机制）。
- 不覆盖安装即更新（更新必须有数据库备份与回滚）。

## 5. 阶段门槛

每阶段结束产出对应报告（手册要求），并保留原始报告形成工程记录；后续阶段不得重写上一阶段报告。第二阶段开工前的人工审核检查点：本路线图与五份审计报告的事实基础是否被认可。

## 6. 勘误与状态更新（2026-11-14 目录与文件资产审计追加，正文不回改）

- **P1-3 撤销改数动作**：「ARCHITECTURE.md Dao 数字漂移（13 vs 19）」是误判——`*Dao*.kt` 实测恰为 13 个，19 是 data/ 顶层全部文件数（含 Database/Repository/DbSnapshot 等非 Dao 文件）。ARCHITECTURE.md 正确，不得改。文档自动校验仍可做，口径用 `*Dao.kt` glob。证据：`directory/03-DOCUMENTATION-AUDIT.md` D-1、`ARCHITECTURE_MAP.md` §11。
- **P1-6 可关闭**：Models.kt 拆分 WIP 已以 `6a19f28` 提交（model/ 现存 7 个域文件，无 Models.kt），不再是「进行中」。
- 目录/文档/脚本卫生线的整改计划在 `directory/08-RECOMMENDED-STRUCTURE.md`（阶段 A-D），与本路线图代码整改线并行。
- **P0-3 已交付**（2026-11-14，`data/db/SchemaVersion.kt`）：`pragma user_version` + 有序迁移注册表 + 迁移与版本号同事务 + 失败阻启；现有库视为 v0、基线迁移回填 v1。判据 `SchemaVersionTest` 8 项（五类库 + 版本超前拒启 + 基线形状）。执行记录见 `PHASE2_PREFLIGHT_REPORT.md` §10.6。第二阶段剩余未开工项只有「第 5 项 沙箱与网络边界补测」。

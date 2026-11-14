# legadoQ 测试覆盖图谱（TEST_COVERAGE_MAP）

> 审计日期：2026-11-14 ｜ HEAD：4291d30 ｜ 性质：第一阶段只读审计，未执行测试。
> 测试数字口径：docs/STATUS.md 第 5 节记录的 2026-11-13 全量运行结果。

## 1. 当前测试体系（2026-11-13 口径）

| 体系 | 数量 | 来源 |
| --- | --- | --- |
| 后端测试项 | 1,165 项全绿，152 suite | STATUS.md 第 5 节 |
| 前端测试项 | 1,157 项 | STATUS.md 第 5 节 |
| TypeScript 编译 | tsc 通过 | STATUS.md 第 5 节 |
| 真浏览器门禁 | 47 项 | STATUS.md 记录 |
| agent-api.json | count=165，version 0.2.42 | 该文件第 1866、3 行 |

## 2. 关键守护测试（边界锁）

- ArchitectureBoundaryTest.kt（后端）：
  - 第 437 行 RULES_CONCRETE_BASELINE=emptySet：规则引擎不得新增具体基础设施依赖。
  - 第 344 行：4 对包循环依赖禁令。
  - 第 383 行 ENGINE_TO_INFRA_BASELINE：引擎对基础设施白名单。
- ArchitectureBoundary.test.ts（前端）：第 57、77、91 行三条零基线，第 247 行 shell 零基线，第 274 行扫描器有效性自检。
- NetworkSecurityTest 6 项、BindGuardTest 4 项：SSRF 与绑定闸回归。
- JsSandboxHostBudgetTest 3 项：沙箱资源预算。
- MigrationTest 9 项：缺列补列幂等。
- ImportConflictPolicyTest 3 项（当前工作树未提交 WIP，并行 agent 新增）。

## 3. 覆盖评估

### 已覆盖
- 依赖方向（后端 + 前端双层测试锁）。
- 网络安全基础（解析期校验、绑定闸）。
- 沙箱资源预算（超时、内存记账）。
- 数据库缺列迁移。
- API 契约规模清单（agent-api.json 165 项）。

### 缺失（按优先级）
| 优先级 | 缺口 | 说明 |
| --- | --- | --- |
| 高 | 导入事务边界测试 | P0-1 对应：中途失败全量回滚、重复导入幂等 |
| 高 | SSRF TOCTOU 对抗测试 | P0-2 对应：DNS 重绑定模拟、连接级 IP 固定验证 |
| 高 | AI 写工具确认闸测试 | P0-4 对应：未确认拒绝、确认后放行 |
| 中 | schema version 迁移测试 | P0-3 对应：全新/旧版/异常/大数据量/中断恢复五类库 |
| 中 | golden corpus 扩充 | 当前 6 目录 15 文件，书源规则兼容回归覆盖不足（P1-1） |
| 中 | 备份路径穿越边界测试 | 恶意备份包内路径校验 |
| 低 | API 错误响应泄露抽验 | StatusPages 各路由错误路径 |

## 4. 测试基础设施观察

- 152 suite 的规模说明测试文化已经建立，第一阶段的任务不是补测试数量而是补对抗性场景。
- 真浏览器门禁 47 项提供了前端交互回归底座。
- 测试基线数字全部引自 STATUS.md，本轮未运行验证（只读纪律 + 工作树 WIP），第二阶段执行整改时必须现场重跑并记录实际数字。

## 5. 各阶段测试义务衔接

- 第二阶段：补 §3 高优先三项 + schema 迁移五类库测试。
- 第三阶段：段评 UI 交互（复用真浏览器门禁框架）、书源体检状态过滤。
- 第四阶段：Route→UseCase→Repository 改造必须以现有 1,165 项全绿为回归门禁。
- 第五阶段：性能类改动需带测量数字，不以主观流畅为准。
- 第六阶段：安装/启动/卸载/更新在干净 Windows 环境验证。

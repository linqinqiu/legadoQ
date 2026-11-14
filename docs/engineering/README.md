# docs/engineering/ — 工程审计与整改记录

> 2026-11-14 设立（目录与文件资产审计 D-18/G-5/D-23 收口）。本目录是工程过程记录，不是产品手册；
> 唯一索引入口在 [../README.md](../README.md)，目录职责登记在 [../STRUCTURE.md](../STRUCTURE.md)。

## 子目录职责

| 子目录 | 放什么 | 规则 |
|---|---|---|
| `audit/` | 只读审计快照（代码/安全/数据/兼容性/目录资产） | 每份带「审计日期 + HEAD + 性质」头；**快照不回改**，勘误以追加节写在原文件末尾 |
| `remediation/` | 整改执行记录（按轮/按项） | 也可继续用对应 preflight 报告的「执行记录」附录（如 PHASE2_PREFLIGHT §10），二选一并在报告里写明；只追加不重写 |

## 当前内容

- `audit/` 第一阶段全套 11 份（2026-11-14，HEAD 4291d30 基线）：REPOSITORY_AUDIT、ARCHITECTURE_MAP、SECURITY_THREAT_MODEL、DATA_MIGRATION_AUDIT、BACKUP_MATRIX、COMPATIBILITY_MATRIX、ECOSYSTEM_COMPATIBILITY_AUDIT、UPSTREAM_COMPARISON、TEST_COVERAGE_MAP、ROADMAP（整改阶段 2-6）、PHASE2_PREFLIGHT_REPORT（含 §10 执行记录）。
- `audit/directory/` 目录与文件资产审计 9 份（2026-11-14，HEAD 4cb78b4）：01 根目录～08 建议结构 + FINAL-REPORT。整改计划在 08 分册（阶段 A-D）。

## 与其它过程记录的关系

- `docs/research/`：核查结论与方案取舍（快照）；`docs/sessions/`：按轮工程日志。审计轮可免 session，但审计报告必须进本目录并被 docs/README 索引。
- 新审计一律进 `audit/`，不再放 `product/docs/`（旧审计文档原地保留，有状态头）。
- 外部建议的逐条核对属研究性质，放 `docs/research/研究-*核对*.md`，不放这里。
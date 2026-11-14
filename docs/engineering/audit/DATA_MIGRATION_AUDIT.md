# legadoQ 数据迁移审计（DATA_MIGRATION_AUDIT）

> 审计日期：2026-11-14 ｜ HEAD：4291d30 ｜ 性质：第一阶段只读审计，未修改任何源码。

## 1. 数据表清单（本轮实测）

Schema.kt 共 21 张表，全文仅第 17 行一个 pragma（journal_mode=wal）。表域覆盖：书籍与书架、章节与正文、阅读进度、书签、笔记、书源、替换规则、RSS、TTS、cookie、搜索历史、媒体资源等。表间以书籍 ID、书源 ID 逻辑关联，未声明外键约束（SQLite 默认关闭外键 pragma）。

## 2. 当前迁移机制

- 无 schema version：数据库无 user_version/schema_version pragma（P0-3，CONFIRMED）。
- 迁移实现：data/db/Migration.kt 幂等缺列补列模式：
  - 第 67 行 cookie_jar 补列；
  - 第 104-123 行 progress 补列；
  - 第 128-134 行 bookshelf 补列；
  - 第 138-165 行 source 补列；
  - 第 184 行 bookNote 补列；
  - 第 22-30 行 maybeSnapshot 触发快照；
  - 第 34 行 VACUUM。
- 连接管理：ConnectionPool.kt 单写连接 + ReentrantLock（第 60-75 行），close 第 77-90 行。
- 快照与恢复：DbSnapshot.kt SHA-256 sidecar（第 56 行）+ .pending-restore 标记（第 56 行）+ pre-restore- 副本回退（第 57、83-106 行）。

## 3. 现状评估

### 保留价值（不要重写）
- 幂等补列机制对缺列场景有效，MigrationTest 已有 9 项测试。
- WAL + 单写连接 + 锁的结构在 SQLite 场景下合理。
- DbSnapshot 的校验和 + 回退副本是可靠的恢复底座。

### 缺口
- P0-3：无版本号意味着无法区分迁移序，无法表达只升不降，无法识别半迁移库，无法审计每一步迁移的成败。
- P0-1：BackupImporter.kt 第 216-252 行 commit() 链（importSources → importReplaceRules → importBookGroups → importLibrary → importRssSources → cookies）各步独立事务（ImportDao.kt 第 33-54、71-92、114-167 行；SourcesDao.kt 第 312-346 行），中途失败不回滚前面已提交步骤，重试产生部分重复导入。墓碑防复活已同事务处理（ImportDao.kt 第 117-134 行），enabled 保留本机策展（SourcesDao.kt 第 329-338 行），这两点是正确设计，整改时必须保留。

## 4. 历史兼容风险

- 异常库（缺字段、半迁移、表缺失）目前只能靠枚举补丁逐个兜住，新版本对旧库的兼容靠开发者记忆。
- 无版本号则任何迁移中断后状态不可诊断。
- 附件/媒体文件与数据库记录的关联完整性无校验。

## 5. 迁移方案建议（供第二阶段参考）

1. 引入 user_version pragma 作为 schema 版本号，每次结构变更 +1。
2. 建有序迁移表：每步迁移有唯一编号、前置版本、SQL/代码迁移体、事务包裹。
3. 现有幂等补列层保留为兜底，迁移序先跑补列再升级版本号。
4. 迁移失败明确报错并阻止启动，禁止带病运行。
5. 不直接删除旧字段，先写废弃标记，观察一个版本再清理。

## 6. 必测场景（第二阶段验收基线）

- 全新数据库首次建库。
- 当前版本库（0.2.42）平滑升级。
- 旧版本库逐级升级。
- 缺部分字段的异常库被补齐。
- 大数据量库（万级书籍记录）迁移耗时与锁行为。
- 迁移中断后的恢复与重试。

## 7. 备份恢复链评估

- 备份完整性：DbSnapshot 校验和机制在位。
- 恢复前检查：.pending-restore 标记 + pre-restore- 副本回退在位。
- 恢复原子性：缺 P0-1 整改，导入六步须并入单一事务或补偿回退。
- 路径穿越：备份包内文件路径校验需在第二阶段补边界测试（S-2 关联项）。

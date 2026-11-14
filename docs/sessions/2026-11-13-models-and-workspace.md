# 2026-11-13 模型与工作区整理

## 目标

依据当前 `E:\legado` 工作树与 `linqinqiu/legadoQ` 主线状态，修正过期的现行导航，整理 DTO 模型边界，并清理可确认的本地缓存残留。已有未提交代码不在本次范围内回滚。

## 模型边界

原 `model/Models.kt` 汇集了系统、书源、发现、阅读、书架、替换规则和备份 DTO。现拆成七个同属 `io.legado.model` 包的文件：`SystemModels.kt`、`SourceModels.kt`、`DiscoveryModels.kt`、`ReadingModels.kt`、`BookshelfModels.kt`、`ReplaceRuleModels.kt`、`BackupModels.kt`。包名、类型名和调用 API 不变；逐声明对账确认 133 个声明完整且无重复。

模型包仍然只承载纯数据类型，不向 `data`、`source`、`http` 等实现包反向依赖；现有 `ArchitectureBoundaryTest` 继续守住该边界。`Mp3DurationEstimator` 属于 `tts/TtsSessionService.kt` 的纯字节解析器，不属于模型包。

依赖源码文件布局的 `PagingGate.test.ts`、`SearchJump.test.ts`、`VersionTracks.test.ts` 已改读对应领域文件。架构索引、产品 README 与 AI 协作速查已更新。

## 现行文档

`docs/STATUS.md` 的当前版本与交付更新为 0.2.42；旧测试与规模数字标为历史快照，本轮运行结果单列在下方验证记录。

`docs/ROADMAP.md` 的历史阶段建议与当前交付分开标注，撤销 RSS/Atom 直解与分页尚未支持的陈旧结论。段评只读后端已实现，但源码核查确认阅读器 UI 尚未接入，兼容台账、导入告警及字段表注释同步说明这一边界；S0 未整体标为完成。

`docs/README.md` 不再把 0.2.37 研究列为当前路线；研究索引保留旧快照并注明时效。本记录作为当前工作树整理结果。

## 本机目录治理

确认 PID 6852 原先运行 0.2.42 fat jar，临时目录指向 `product/tmp`；随后该进程已退出。日志、门禁配置目录和三张阅读器错误/慢响应/换源截图保留作诊断依据。数据库与 `.data` 用户状态保留。

根目录与 `product/` 下字面名称 `%SystemDrive%` 的 Windows 缓存残留目录，各含四层空目录，已在确认无占用后移除。日志、浏览器门禁配置与诊断截图均保留；旧 SQLite JDBC 解压缓存不纳入清理，避免误删 Gradle 可能复用的缓存。

## 验证

- 声明对账：133 个类型声明，零缺失、零重复。
- 后端：在 `product/` 执行 `./gradlew :app:test --no-daemon`，全量通过（BUILD SUCCESSFUL）。
- 前端：`npm.cmd --prefix product/web test` 全量通过（146 个文件，1157 项，零失败；上轮 `ENOMEM` 为临时环境问题，复跑恢复正常）。
- 类型检查：`npm.cmd --prefix product/web run check`（`tsc -b`）通过。
- `protocol:sync` 与 `protocol:check` 已通过；`docs:api-check`（165 条 / 19 组）、`version:check`（8 处均为 0.2.42 / build 55）与 `changelog:check` 均通过。最终 `git diff --check` 通过。

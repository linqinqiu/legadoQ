# 07 · 重复与孤儿（DUPLICATES-AND-ORPHANS）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 7/9）
> 纪律：所有「孤儿/死」判定均经引用关系 grep 验证（代码调用、npm scripts、CI、文档索引），不凭文件名。删除建议一律附证据；本轮不执行任何删除。

## 1. 确认为孤儿 / 死代码（有证据）

| # | 对象 | 证据 | 建议 | 风险 |
|---|---|---|---|---|
| O-1 | `product/plugins/README.md` + `product/examples/plugin-hello/`（5 文件） | Application.kt:147「插件系统已移除（2026-10-26）」；主代码 grep PluginManager/discoverFrom/io.legado.plugin/api/plugins 零命中；示例 compileOnly 引用的 Plugin 类已不在主 jar，编译不过；引用方仅自身 README、clean-local.sh:31-32、archive 历史（G-2） | 挂废弃横幅（与 product/docs 两份插件文档同口径）或整体移仓库外 archive；clean-local 对应行同步清理。**前端 web/src/plugins/（about/backup 等页面级插件）是另一套现役机制，勿误删** | 低；历史参考值保留在横幅说明里 |
| O-2 | `scripts/version-reconcile.mjs` | 硬编码 E:/legado 双仓路径；调用方仅 docs/archive（归档）；职责被 version-check.mjs + VersionTracks.test.ts 完全覆盖（S-8） | 退役（移仓库外 archive 或删除，git 历史可恢复） | 低 |
| O-3 | 根 `scripts/gen-api-reference.mjs` | 硬编码 E:/legado 输出路径 + 依赖活服务；product/scripts/ 同名离线版才是 CI/docs:api 用的；root-split.md:179 早已标记碰撞未决（S-9） | 删除根版，保留 product 版 | 低 |
| O-4 | `product/scripts/build-portable.mjs` | 全仓无调用方；产物路径漂进仓内 + rmSync；职责被 package.mjs/package-desktop.mjs 取代（S-11） | 退役 | 低 |
| O-5 | typeset 分页簇：`web/src/features/reader/typeset/`（3 文件）+ `content/paginationCache.ts` + LayoutEngine.test.ts + PaginationCache.test.ts | 引用仅在簇内与两份测试；fontLibrary.ts:45 仅注释提及；ARCHITECTURE.md:494-497 自认「待决不是已交付」（核对报告 N-1） | **决策项**：接入生产或整簇删除。先量 ReaderScreen DOM 测量分页的性能缺口再定，不顺手删 | 中；删错会丢掉未来排版引擎的设计基础，决策须留记录 |

## 2. 半死 / 职责重叠（保留但需收口）

| # | 对象 | 证据 | 建议 |
|---|---|---|---|
| O-6 | `scripts/gen-agent-api.mjs` | 三重校验中版本/count 已被其它门禁钉住；调用方仅会话记录（S-12） | 接进 docs:api-check 前置，或头部标「手动工具，非门禁」 |
| O-7 | 两个 `version-check.mjs`（tools/verify 运行时版 vs scripts 静态版） | 同名异责，gates.yml:95 与 ci.yml:113 各用其一（S-17） | verify 版改名 version-runtime-check.mjs |
| O-8 | 三套打包脚本 package/package-desktop/build-portable | deploy.md 并列前两者；第三者死（S-16/O-4） | 收敛为一条打包链或在 deploy.md 写清分工 |
| O-9 | `product/tools/{dbq.mjs,Guard.java,JpTest.java,check-worktree.sh}` | 未跟踪本机遗留，引旧包名/旧布局/qingyue 旧名（S-15） | 本机移 tmp/ 或清理（非仓库资产，不涉及 git） |
| O-10 | `product/docs/待定功能.md` | 唯一条目已落地，无「待定」项（D-26） | 改名设计记录或迁 archive 留指针，防空壳诱导塞规划 |

## 3. 重复但属有意分层（保留，勿合并）

| 对象 | 判定依据 |
|---|---|
| 根 LICENSE(MIT) vs product/LICENSE(GPL-3.0) | NOTICE.md 按路径分许可，必须两份（G-9） |
| 根 CHANGELOG（指针）vs product/CHANGELOG（权威） | AGENTS 纪律一致（G-9） |
| 根 scripts/start.cmd（4 行转发）vs product/start.cmd（37 行双击启动器） | 职责不同，STRUCTURE:64 明确（G-9） |
| 根 README（仓库总览）vs product/README（产品门面）vs 功能说明.md（用户手册） | 受众分层；但 product/README 文档表应收敛为指向 docs/README 的单链接，根表补 AI 行（D-6） |
| RELEASING（流程）vs RELEASES（自动台账） | 分工清晰（03 分册 §1） |
| docs/ROADMAP（产品长期框架）vs engineering/audit/ROADMAP（整改执行） | 有意分层但命名撞车且互不链接 → 互链 + 索引声明当前执行计划（D-3） |
| architecture-audit.md（已落地纪律）vs ARCHITECTURE_MAP（待裁决提案） | 并存为快照，但须注明裁决状态（D-2） |
| product/docs 旧审计 vs engineering/audit 新审计 | 旧地保留（有状态头），新审计一律进 engineering/audit（D-22） |

## 4. 功能可用但缺文档入口（不是孤儿，补入口）

| 对象 | 证据 | 建议 |
|---|---|---|
| `product/extensions/chrome/`（4 文件） | popup.js:49 调用的后端端点仍在（SourcesRoutes.kt:419-425）；product/README 与 docs/README 均未提及（G-7） | 产品 README/索引补安装入口；HttpOnly Cookie 同步的信任边界与安全文档交叉引用 |
| `product/docs/import-conflict-policy.md` | 11-13 新增行为规范，唯一索引漏收（D-20） | 补入 docs/README |

## 5. 死链与陈旧期望

| 对象 | 证据 | 建议 |
|---|---|---|
| product/README.md:3 图片 `./web/public/favicon.svg` | git ls-files 零命中，文件不存在（G-3） | 改指现存 PNG 或补 SVG |
| snapshot.mjs:26 把已跟踪的 init-mirror.gradle 当未跟踪 | git ls-files 确认已跟踪（S-27） | 从 UNTRACKED_UNIQUE 移除 |
| .codebuddy/agents/code-explorer.md:29 行数 | ReaderScreen(2402)/RuleRunner(2333) vs 实测 2346/1679（S-3） | 改纯符号引用或纳入同步 |

## 6. 小结

真孤儿 5 组（O-1～O-5），其中 O-5 是决策项不是清理项；半死/重叠 5 组收口即可；「重复」大部分是有意分层，**合并反而制造问题**。所有处置走 08 分册的分阶段计划，删除类操作一律 git 历史可恢复或移仓库外 archive，不永久删除。
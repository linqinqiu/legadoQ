# 02 · 目录职责分析（DIRECTORY-ANALYSIS）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 2/9）
> 判定基准：docs/STRUCTURE.md（目录职责权威）。发现编号沿用各分册：G=Git 资产，D=文档，S=脚本。

## 1. product/ 顶层盘点

| 条目 | 跟踪状态 | 职责 | 判定 |
|---|---|---|---|
| `app/` `web/` `gradle/` `scripts/` `tools/`(白名单) | 跟踪 | 源码/构建/门禁 | 合规（tools 另有 10 个本机探针被忽略，.gitignore 有明文设计；其中 4 份旧遗留见 S-15） |
| `build.gradle` `settings.gradle` `gradle.properties` `gradlew(.bat)` `init-mirror.gradle` `compose.yml` `Dockerfile` `package.json` `start.mjs` `start.cmd` `stop.mjs` | 跟踪 | 构建/启动配置 | 合规（Dockerfile Gradle 版本差见 S-21；stop.mjs 仅 Win 见 S-7） |
| `.env.example` `.dockerignore` `.gitattributes` `.gitignore` `.githooks/` `.java-version` `.nvmrc` | 跟踪 | 配置模板/钩子 | 合规（.env.example 仅模板） |
| `CHANGELOG.md` `README.md` `LICENSE`(GPL-3.0) `CONTRIBUTING.md` `SECURITY.md` `docs/` | 跟踪 | 产品文档 | 基本合规；README 死链 G-3、发行资产误述 D-5 |
| `examples/plugin-hello/`(5 文件) `plugins/README.md` | 跟踪 | 已移除插件框架的示例/说明 | **遗留孤儿（G-2）**：主代码零引用，示例引用的 `io.legado.plugin.Plugin` 已不在主 jar，实际编译不过 |
| `extensions/chrome/`(4 文件) | 跟踪 | Cookie 同步浏览器扩展，后端端点仍在（SourcesRoutes.kt:419-425） | 可用但无现行文档入口（G-7） |
| `assets/` | 忽略（product/.gitignore:64） | make-ico.mjs 生成的图标/.lnk，package-desktop.mjs:83-88 缺失时自动重建 | 合规，有意忽略 |
| `data/` `.data/` `app/data/` | 忽略（:42/:25/:44） | 用户书库/运行数据 | 合规，未读内容 |
| `logs/` `app/logs/` `server*.log` `build/` `app/build/` `.gradle/` `.kotlin/` `web/dist/` `web/node_modules/` `web/tsconfig.tsbuildinfo` | 忽略 | 运行/构建产物 | 合规 |
| `agent-profiles.json` | 忽略（:28 + 根 :40 双保险） | 含 apiKey 的运行档案 | 合规，未读内容 |
| `tmp/` | 忽略（:10），38MB | 运行残留（约 20 份 sqlitejdbc.dll 副本+截图） | 建议清理（G-4） |
| `port.txt` | **未跟踪且未忽略** | 界面改端口时写的运行文件 | **应加忽略（G-1）** |
| `app/hs_err_pid*.log` ×39、`replay_pid*.log` ×2 | 忽略（*.log） | JVM 崩溃转储 | 建议清理（G-4） |

## 2. docs/ 子目录职责

| 子目录 | 现状 | 与 STRUCTURE 的一致性 |
|---|---|---|
| 顶层 8 份 md | 总览/API/架构/状态/结构/路线/媒体/性能 | 一致，均被唯一索引收录 |
| `research/`（17 份） | 研究快照，带日期 | 一致；索引漏 3 份（D-19） |
| `sessions/`（7 份） | 按轮工程日志 | 一致 |
| `archive/`（8 份，540K） | 库内轻量归档 | **口径冲突（G-6）**：STRUCTURE 原则 4 要求历史资料出库，AGENTS 却把 docs/archive 当库内禁读区。二选一消除漂移 |
| `engineering/`（今日新增） | audit/ 11 份报告；remediation/product/quality 三空目录 | **未登记（D-18/G-5）**：STRUCTURE 职责表、docs/README、AGENTS 均无此目录；无 README 定义用途（D-23） |
| `.scratch/`（gitignored） | 草稿 + compat-audit 上游克隆与 25MB 语料 | **超范围（D-24）**：README 用途仅限未定稿 md，克隆/语料按 STRUCTURE 应在仓库外 legado-out/assets/refs |

## 3. scripts/ 与 product/scripts/ 分工

根 scripts/（13 文件）= 启停包装 + 仓库级工具（协议生成、版本读写、发布记账、清理）；product/scripts/ = 产品构建/门禁/打包链。委托链单一清晰（根 start/stop → npm --prefix product → product/start.mjs）。问题集中在：两份带硬编码盘符的死脚本（S-8/S-9）、clean-local worktree 段高危（S-6）、sh/cmd 行为分叉（S-13）。详见 05 分册速查表。

## 4. 与 STRUCTURE.md 的偏差汇总

| # | 偏差 | 发现 | 处理方向 |
|---|---|---|---|
| 1 | docs/engineering/ 未登记职责 | D-18/G-5 | STRUCTURE 补行 + engineering/README（或裁空目录） |
| 2 | docs/.scratch/ 未登记且超范围使用 | D-18/D-24 | STRUCTURE 补行；克隆/语料迁仓库外或立例外条款 |
| 3 | docs/archive/ 库内归档 vs 原则 4 出库 | G-6 | STRUCTURE 补「库内轻量归档例外」一句（推荐，体积小且 AGENTS 已承认） |
| 4 | product/port.txt 运行数据未忽略 | G-1 | product/.gitignore 加 `/port.txt` |
| 5 | 插件遗留资产违反「只写现有功能」 | G-2 | 挂废弃横幅或出库；clean-local 对应行同步 |
| 6 | product/docs/ 混放过程记录 | D-22 | 保留原地（有状态头+被索引），索引小节改名，新审计一律进 engineering/audit |

## 5. 结论

目录骨架健康：单一产品、产物出库、运行数据忽略三条核心原则基本落实，偏差集中在**今日新增的 engineering/ 未走登记流程**与少量历史遗留。不需要建议②设想的大规模目录重组；需要的是把既有规则补全并加门禁防再漂移（见 08 分册）。
# 05 · 脚本 / 配置 / 工作流审计（SCRIPTS-AND-CONFIG-AUDIT）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 5/9）。未运行任何脚本。
> 范围：scripts/（13 文件）、product/scripts/、product/tools/、product/start.mjs、product/stop.mjs、.github/workflows/（7 份）、各级 package.json、.gitignore/.gitattributes、compose.yml/Dockerfile/init-mirror.gradle/gradle.properties。

## 1. 委托链与已核无问题项

- 启动链清晰单一：根 `scripts/start.{sh,cmd}` → `npm --prefix product start` → `product/start.mjs`（无两套逻辑）；stop 同构。`product/start.cmd` 是独立双击启动器（探活+开浏览器，UX 层重叠但理由写在头部）。`port-select.mjs` 现役且有 `PortSelect.test.ts` 全覆盖。
- 版本定义点全一致：VERSION=0.2.42、BUILD_NUMBER=55、`app/build.gradle:125`、RELEASES.md 末行 `0.2.42|55`；防漂移三层门禁齐全（version-check 8 抄本 + VersionTracks RELEASES↔tag↔build 且 :279 钉「末行==当前 version/build」+ version-gate tag job）。
- compose.yml（127.0.0.1:8080:8080、legado-data:/data）与 Dockerfile（LEGADO_PORT=8080、LEGADO_DATA_DIR=/data、BUILD_NUMBER 经 ARG 注入且被 VersionTracks:54-55 钉住）一致，路径已统一到 product/ 上下文，无历史遗留。
- gradle.properties 已清 Android 残留；init-mirror.gradle 为显式 `-I` 可选镜像（头部自述「为什么+何时删」），CI 不用，现役手动。
- post-commit 钩子安全（只动 CHANGELOG、不 commit/amend/stage）；install-hooks 不再偷 stage 文件。
- clean-local 合规面：不用 `git clean -fd` / `reset --hard`；TARGETS 全为 gitignored 产物；PROTECTED 含 product/data；不触仓库外 legado-out。符合 STRUCTURE.md:59。**但 worktree 段有高危缺陷，见 S-6。**

## 2. 发现清单（脚本）

### S-6 clean-local.sh 强删所有非主 worktree，不查脏净 —— 高

- 路径：`scripts/clean-local.sh:76-90`
- 证据：`git worktree remove --force "$wt" 2>/dev/null || rm -rf -- "$wt"`——循环跳过主工作树后对**每个**注册 worktree 执行，注释称「过期 worktree」但代码无过期/干净判定。AGENTS.md:13 明示仓里可能有并行 agent 半成品。
- 风险：并行 agent 的未提交改动被毁（分支 ref 保留，未提交内容不保）。
- 建议：默认跳过有未提交改动的 worktree（`git -C "$wt" status --porcelain` 非空即跳过），`--force` 显式开关才强删。

### S-7 stop.mjs 仅 Windows，POSIX 必崩，CI 用 || true 掩盖 —— 中

- 路径：`product/stop.mjs:20,31,54`；`scripts/stop.sh:4`；`.github/workflows/version-gate.yml:223`
- 证据：`netstat -ano`（无 try/catch）+ `powershell Get-CimInstance` + `taskkill`，无 platform 分支；stop.sh 直接 `exec node product/stop.mjs`。version-gate 收尾 `node stop.mjs || true` 在 ubuntu 上静默失败。
- 建议：加 POSIX 分支（ss/lsof + kill，按 jar 命令行匹配），或非 Windows 明确报错退出。

### S-8 死脚本 version-reconcile.mjs：硬编码盘符 + 双仓时代逻辑 —— 中

- 路径：`scripts/version-reconcile.mjs:26-27,173-174`
- 证据：`resolve('E:/legado/product')` / `resolve('E:/legado')`；分别查「应用仓库/父仓库」tag——单仓后两者恒同。调用方仅 docs/archive/version-log-governance.md（归档）；无 npm/CI 引用。findGradleBuildFiles 递归走 product/ 全树（含 product/data 禁读区，只读但违纪且慢）。
- 建议：退役（职责已被 version-check.mjs + VersionTracks.test.ts 完全覆盖）。

### S-9 死脚本 根 gen-api-reference.mjs：硬编码盘符 + 同名碰撞 —— 中

- 路径：`scripts/gen-api-reference.mjs:3,27`
- 证据：依赖活服务 `http://127.0.0.1:1234/api/catalog`；`fs.writeFileSync('E:/legado/docs/API-REFERENCE.md',…)`。`product/scripts/gen-api-reference.mjs`（离线读 agent-api.json、带 --check）才是 CI 与 docs:api 用的那份；docs/API-REFERENCE.md:4 头部也指向 product 版。根版无任何调用方。
- 建议：删除根版，消除同名两份（root-split.md:179 早已标记此碰撞「必须先决定留哪个」，至今未决）。

### S-10 开源卫生门禁扫描面漏掉根 scripts/ —— 中

- 路径：`product/tools/verify/opensource-hygiene-check.mjs:24`；`product/tools/verify/env.mjs:8`
- 证据：`git ls-files -z` 的 cwd=ROOT=product/ → 只扫 product/ 子树。S-8/S-9 两处 `E:/legado` 在**已跟踪**的根 scripts/ 里，门禁「没有个人盘符路径」一条永远扫不到它们。
- 建议：扫描根扩到仓库根（至少纳入根 scripts/、AGENTS.md 等分发面）。

### S-11 build-portable.mjs 疑似死 + 产物路径漂进仓内 + rmSync —— 中

- 路径：`product/scripts/build-portable.mjs:12-13,41-42`
- 证据：注释称「按产物出库放仓库外」，但 `REPO = ROOT/..` 单仓后 = 仓库根，outDir = `<repo>/legado-releases/legadoq-portable-<ver>`（仓内，gitignore 兜底）；`fs.rmSync(outDir,{recursive:true,force:true})`。全仓无调用方（仅自身头部）；legado-releases 历史上放过书库副本。职责被 package.mjs / package-desktop.mjs 取代。
- 建议：退役；若保留，输出改仓库外（legado-out）并删 rmSync 或先校验目录无用户数据。

### S-12 gen-agent-api.mjs 未接 npm/CI，职责重叠 —— 低

- 路径：`scripts/gen-agent-api.mjs:1-14`
- 证据：三重校验（count/字段/版本）中版本已被 version-check.mjs 钉、count/路由已被 ApiCatalog.test.ts 钉；调用方仅 docs/sessions/2026-11-04 会话记录。半死手动工具。
- 建议：接进 docs:api-check 前置，或头部标注「手动工具，非门禁」。

### S-13 clean-local sh/cmd 行为分叉 + 日志清理不全 —— 低

- 路径：`scripts/clean-local.cmd:33-35,38` vs `clean-local.sh:70,76-90`
- 证据：.cmd 只 `git worktree prune` 不删 worktree 目录、PROTECTED 回显少根 node_modules；两版都只删 server.log，留 server.err.log / server.out.log。
- 建议：对齐两版；日志清理改 `product/server*.log`。

### S-14 run-all-gates.mjs 文案与超时不符、集合与 CI 不齐 —— 低

- 路径：`product/scripts/run-all-gates.mjs:57,78`；`.github/workflows/gates.yml:172`
- 证据：GATE_TIMEOUT_MS=600_000（10 分钟）但打印「每个最多 5 分钟」；只跑 `*-check.mjs`，CI full 额外含 selfcheck.mjs → 本地「全部门禁」≠ CI 集合。
- 建议：改文案；纳入 selfcheck 或在 gates-guide 注明差集。

### S-15 product/tools/ 顶层四份未跟踪本机遗留 —— 低

- 路径：`product/tools/{dbq.mjs,Guard.java,JpTest.java,check-worktree.sh}`（均未跟踪，product/.gitignore:74 `/tools/*` 忽略）
- 证据：Guard.java:1,8 引旧包 `io.legado.server.ServerConfig` + `E:/Projects/legado-server/data`；check-worktree.sh:2,17-22 仍是重组前 web//server/ 布局、ai1/ai2 分支、qingyue 旧名。dbq.mjs 为只读 DB 探针（无害）。
- 定性：非仓库资产，不入库，但混在正式工具目录。建议本机移 tmp/ 或清理。

### S-16 三套打包脚本职责重叠 —— 低

- 路径：`product/scripts/{package.mjs,package-desktop.mjs,build-portable.mjs}`
- 证据：package.mjs 出整合包 legadoq-<ver>.zip（仍兼容已弃 next/ 骨架，:33-36）；package-desktop.mjs 出 CI 主推桌面包；build-portable 死。deploy.md:10-11 把前两者并列为「免装 Java」选项。
- 建议：明确分工或收敛为一条打包链。

### S-17 两个 version-check.mjs 同名异责 —— 低

- 路径：`product/tools/verify/version-check.mjs:1-17` vs `product/scripts/version-check.mjs:1-16`
- 证据：前者运行时核验（jar 清单 + /healthz + 浏览器 UI + CHANGELOG，需服务在跑）；后者静态 8 抄本比对。gates.yml:95 用前者、ci.yml:113 用后者——同名易误引。
- 建议：verify 版改名 version-runtime-check.mjs。

## 3. 发现清单（工作流与配置）

### S-18 同一门禁跨工作流重复跑 —— 中

- 路径：`ci.yml:60,95,113`；`contract.yml:64,120`；`build-jar.yml:88,90`；`coverage.yml:73,76`
- 证据：每个 PR 前端全量跑 3 次（ci.web-check、contract.frontend-gate、build-jar.build）+ coverage c8 第 4 次；后端 :app:test 2 次 + testCoverage 第 3 次；scripts/version-check.mjs 2 次（ci.version-consistency 与 contract.doc-gate 完全同脚本同触发）。contract.frontend-gate 与 ci.web-check 整段重叠。
- 建议：contract 前端只跑 ApiCatalog/FrameworkHasNoContent 子集（或并入 ci）；ci 撤 version-consistency（contract 已覆盖）；build-jar 的测试保留（它需要前端在场跑 StaticAssets 那批，ci 纯后端通道有意不跑）。

### S-19 version.mjs 头部 bump 纪律与 AGENTS/门禁矛盾 —— 中

- 路径：`scripts/version.mjs:9-10` vs `AGENTS.md:17`；`product/web/test/VersionTracks.test.ts:279`
- 证据：version.mjs 称「每完成一项改动 bump-build 加一」；VersionTracks 钉 RELEASES 末行 build == 当前 BUILD_NUMBER → 平时 bump 必红。AGENTS「不要提前 bump」才是被门禁执行的纪律。
- 建议：改 version.mjs 注释为「仅发布时 bump（随 RELEASES 记账）」，避免照注释操作触发 CI 红。

### S-20 port.txt 未被忽略 —— 低（与 06 分册 G-1 同一问题）

- `product/port.txt`（内容 12345）是界面改端口时写的本机运行时文件（`product/scripts/runtime.mjs:22-24`），两份 .gitignore 均无条目。建议 `product/.gitignore` 加 `/port.txt`。

### S-21 Dockerfile Gradle 版本与 wrapper 不一致 —— 低

- `product/Dockerfile:18` `gradle:8.13-jdk17` vs `gradle-wrapper.properties` `gradle-8.14.4-bin.zip`。建议镜像升 8.14.4（或改用 wrapper 构建）。

### S-22 工作流注释/名称陈旧 —— 低

- `gates.yml:165-168`（`qingyue.exe`、`dist/qingyue-<版本>.zip`，现为 legadoq，见 build-jar.yml:184-188）；`contract.yml:21` name「契约双锁」实为六锁五 job。随下次改动顺手更新。

### S-23 「Latest」语义两套且未文档化 —— 低

- `docker.yml:89`（GHCR latest 随 main/master push）vs `build-jar.yml:325`（Release Latest 仅 v* tag）。镜像 latest 每次推 main 就动，可能有意（滚动镜像）但无注释。建议 docker.yml 补意图说明，或 latest 也只跟 tag。

### S-24 release-smoke 硬编码 1234 + tag 发布四路构建重叠 —— 低

- `version-gate.yml:205` `curl http://127.0.0.1:1234/healthz`；start.mjs:316-334 端口被占自动顺延 → runner 上 1234 被占时 smoke 假红。另 v* tag 一次发布同时触发 version-gate smoke、build-jar、gates full（release）、docker 四路构建。
- 建议：smoke 从 start.mjs 输出/port.txt 读实际端口；重叠构建属设计取舍，文档注明。

### S-25 web check:test 从不进 CI —— 低

- `product/web/package.json` `check:test`（tsc -p tsconfig.test.json）；7 个工作流均只跑 check/test。建议 ci.web-check 加一行，钉住测试代码类型。

### S-26 .gitattributes/.gitignore 细节 —— 低

- 根 `.gitattributes:9`（`*.bat diff=binary`）vs `product/.gitattributes:9`（`*.bat text`）不一致（eol 都 crlf，无实害）；根 .gitignore:26,28 全局 `*.zip`、`refs/` 可能误伤未来合法资产；AGENTS/CLAUDE/GEMINI/.cursorrules 未 export-ignore，会进发布源码归档（.gitattributes:51 仅 .codebuddy export-ignore）。
- 建议：统一 .bat 规则；评估 AI 指令文件是否一并 export-ignore。

### S-27 snapshot.mjs 仍把已跟踪的 init-mirror.gradle 当未跟踪 —— 低

- `product/tools/verify/snapshot.mjs:26` `UNTRACKED_UNIQUE = ['init-mirror.gradle',…]`；git ls-files 确认已跟踪。从名单移除。

## 4. 脚本速查表（职责 + 调用方 + 状态）

| 脚本 | 职责 | 调用方 | 状态 |
|---|---|---|---|
| scripts/protocol.mjs | 三份 AI 入口生成/校验 | npm protocol:sync/check；contract.yml:132 | 现役 |
| scripts/protocol-template.md | 精简协议唯一源 | protocol.mjs | 现役 |
| scripts/version.mjs | 版本读写/bump/set-external | npm build:bump/version:show；release.mjs；VersionTracks | 现役（注释漂移 S-19） |
| scripts/release.mjs | 发布记账+tag+push | npm release/release:dry | 现役 |
| scripts/version-reconcile.mjs | 旧双仓版本对账 | 仅归档文档 | 疑似死（S-8） |
| scripts/gen-api-reference.mjs | 活服务→API 文档（E:/ 硬编码） | 无 | 疑似死（S-9） |
| scripts/gen-agent-api.mjs | agent-api.json 内部一致性 | 手动 | 半死（S-12） |
| scripts/clean-local.sh/.cmd | 清 gitignored 产物 | STRUCTURE.md:59 手动 | 现役（S-6/S-13） |
| scripts/start.sh/.cmd | 转发 npm --prefix product start | README.md:80 手动 | 现役 |
| scripts/stop.sh/.cmd | 转发 product/stop.mjs | npm stop | 现役（POSIX 坏 S-7） |
| product/start.mjs | 启动器（端口/防陈旧/开浏览器） | npm start；ci/gates/version-gate；start.cmd | 现役 |
| product/stop.mjs | 按端口/jar 停服 | npm stop；version-gate:223 | 现役（仅 Win S-7） |
| product/start.cmd | 双击启动器 | 用户双击；deploy.md:65 | 现役 |
| product/scripts/tasks.mjs | build/test 跨栈编排 | product npm build/test | 现役 |
| product/scripts/runtime.mjs | 安装根/端口/jar/环境共享库 | start/stop/make-cds/bundled-ui-check/verify-version-check | 现役 |
| product/scripts/port-select.mjs | 端口顺延纯逻辑 | start.mjs:6；PortSelect.test.ts | 现役 |
| product/scripts/version-check.mjs | 8 处版本抄本+build 号 | ci.yml:113；contract.yml:120；release.mjs | 现役 |
| product/scripts/gen-api-reference.mjs | agent-api.json→API-REFERENCE | npm docs:api(-check)；contract.yml:125 | 现役 |
| product/scripts/changelog.mjs | 日志起草/--check 门禁 | npm changelog*；tasks.mjs:42；post-commit；contract.yml:84 | 现役 |
| product/scripts/changelog-lib.mjs | 日志纯逻辑 | changelog.mjs:28；web 测试 | 现役（未读正文） |
| product/scripts/coverage-report.mjs | 前后端覆盖率合并报告 | npm coverage；coverage.yml:79 | 现役 |
| product/scripts/install-hooks.mjs | core.hooksPath 安装 | npm prepare/hooks:install | 现役 |
| product/scripts/run-all-gates.mjs | 本地串行全门禁 | gates-guide.md 手动 | 现役（S-14） |
| product/scripts/package.mjs | 整合包 zip | deploy.md:32 手动；package-check 前置 | 现役（S-16） |
| product/scripts/package-desktop.mjs | jlink+jpackage 桌面包 | build-jar.yml:176；deploy.md | 现役 |
| product/scripts/package-readme.txt | 整合包说明模板 | package.mjs:113 | 现役 |
| product/scripts/build-portable.mjs | 旧便携包组装 | 无 | 疑似死（S-11） |
| product/tools/make-cds.mjs | CDS 类归档 | start.mjs:189 自动；deploy.md 手动 | 现役 |
| product/tools/gen-script-dict.mjs | 简繁词表生成 | openccData.ts:5 头部；手动再生 | 现役 |
| product/tools/{dbq.mjs,Guard.java,JpTest.java,check-worktree.sh} | 本机探针/旧自检 | 无（未跟踪） | 本机遗留（S-15） |
| product/tools/verify/（80+ 份） | 门禁/探针集 | gates.yml full 通配；run-all-gates；白名单 .gitignore:160-185 | 现役（未逐份读） |

## 5. 工作流速查表

| 工作流 | 触发器 | 职责 | 状态 |
|---|---|---|---|
| ci.yml | push main/master；PR main/master | 后端 :app:test（纯后端快通道）+ 前端 check/build/test + version-check | 现役（与 contract 重叠 S-18） |
| contract.yml | push main；PR（全分支） | 六锁：前端双锁/后端 verifyFramework/changelog/文档+版本+protocol/目录深度 | 现役（frontend-gate 与 ci 重复） |
| coverage.yml | push main（paths-ignore 文档）；PR main；dispatch | 前后端覆盖率合并报告，无阈值不阻塞 | 现役 |
| gates.yml | push main；PR main；dispatch(full)；release | 真浏览器门禁：PR 冒烟四件，full 全量串行 | 现役（S-22/S-14） |
| version-gate.yml | PR main；push main+v* tag；release；dispatch | PR 代码改动须伴 CHANGELOG/version；tag==gradle；发布冒烟 | 现役（S-24） |
| build-jar.yml | push main/master（paths-ignore 文档）+v* tag；PR；dispatch；release | build→desktop(Win)→release 三资产；v* 才 Latest | 现役（发布触发已修，本轮复核无误） |
| docker.yml | push main/master+v* tag（paths 限定构建输入）；dispatch | GHCR 多架构镜像，BUILD_NUMBER 注入 | 现役（S-21/S-23） |

## 6. 未读声明

仅读头部/定向 grep，未读正文：product/scripts/{changelog-lib,changelog,coverage-report,package,package-desktop,build-portable,runtime}.mjs 正文、product/start.mjs 70-195 与 340-600 行、tools/verify/ 各脚本正文（除 version-check 头部、opensource-hygiene grep、env.mjs grep）、web/test 正文（除 VersionTracks 窗口与 PortSelect grep）、RELEASING.md / STRUCTURE.md 正文（仅 grep 引用）、product/.env.example、docker-entrypoint.sh。

## 7. 优先级建议

先处理 S-6（数据丢失风险）、S-10（门禁盲区，顺带清 S-8/S-9 两份带盘符死脚本）、S-18（CI 成本）、S-19（照注释操作必红）；其余为低危清理项。
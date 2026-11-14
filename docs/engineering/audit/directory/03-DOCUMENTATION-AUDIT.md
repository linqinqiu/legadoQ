# 03 · 文档体系审计（DOCUMENTATION-AUDIT）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：只读（目录与文件资产审计分册 3/9）
> 方法：目录清单 + 定向 grep + ≤150 行窗口阅读 + 脚本核验 98 条相对链接 + git 提交时间线比对。
> 未读声明：docs/archive/** 只列清单；product/data/**、build 产物、.scratch 内 25MB jsonl 与克隆仓只列名；product/CHANGELOG.md 只读顶部 30 行；ARCHITECTURE/ROADMAP/STATUS/agent-api/功能说明/product-README 均为窗口阅读；engineering/audit 中 BACKUP_MATRIX、DATA_MIGRATION、SECURITY_THREAT_MODEL、TEST_COVERAGE_MAP、UPSTREAM_COMPARISON、ECOSYSTEM 六份只读头部与 grep 命中行。
> 编号说明：本分册 D-x 为文档发现；Git 资产见 06 分册 G-x，脚本见 05 分册 S-x；核对报告新增项为 N-x（docs/research/研究-外部建议核对-2026-11-14.md）。

## 1. 重复与权威冲突

### D-1 「13 个 Dao vs 实际 19」是假漂移——新审计报告要把正确数字改错 —— 高

- 证据：`docs/engineering/audit/ARCHITECTURE_MAP.md:82`「A-5 ARCHITECTURE.md 记 13 个 Dao 与实际 19 文件漂移」；`docs/engineering/audit/ROADMAP.md:16` P1-3 沿用。主会话独立复核：`data/*Dao*.kt` 恰为 **13 个**（Sources/SourceHealth/Shelf/Reading/Cache/Import/Rss/Subscription/Log/Login/Cookie/ReplaceRule/ScriptCache）；`data/` 顶层 **19 个文件** = 13 Dao + Database + 2 Repository + SessionCookies + DbSnapshot + StoreAdapters（另有 db/ 子目录）。`docs/ARCHITECTURE.md:112/249/721` 的「13 个 Dao」**正确**。
- 建议：第四阶段执行 P1-3 前先撤销/改写 A-5；「文档数字自动校验」判据应以 `*Dao.kt` glob 为口径，防止把正确文档改错。

### D-2 架构方向两份权威互相矛盾，无裁决记录 —— 中

- 证据：`product/docs/architecture-audit.md:11`「不新建 Gradle 模块、不引入 ArchUnit、不赌未来扩展消费者」（已落地，ArchitectureBoundaryTest 钉住）；`docs/engineering/audit/ARCHITECTURE_MAP.md:89-92` 主张 UseCase/Repository 分层 + 规则引擎四接口。两者互不引用。
- 建议：属不同轮次审计判断，可并存为快照，但须在 ARCHITECTURE.md 或 engineering 索引注明「现行边界以 architecture-audit 六条纪律为准，ARCHITECTURE_MAP §9 是待裁决提案」。

### D-3 两份 ROADMAP.md 并行且互不链接 —— 中

- 证据：`docs/ROADMAP.md:3`（产品长期框架 S0-S4，自标历史决策框架）；`docs/engineering/audit/ROADMAP.md:1-4`（整改阶段 2-6，实际驱动本轮 P0 修复）。docs/README.md:15 只索引前者；后者无入口链接。
- 建议：有意分层（产品 vs 整改）但命名撞车。docs/README 增 engineering 节并互链，声明「当前执行计划 = engineering/audit/ROADMAP + PHASE2_PREFLIGHT §10」。

### D-4 兼容性产品权威漏收审计已确认的缺口 —— 中

- 证据：`COMPATIBILITY_MATRIX.md:68` `java.t2s/s2t` ❌（本轮 grep 复核仍无实现）、`:31` `customOrder` 导入丢排序 ❌；`product/docs/compatibility.md` 全文 grep `t2s|s2t|customOrder|简繁` 零命中。STATUS.md:167 与研究快照已记录 t2s 缺口。
- 建议：RELEASING.md:66 要求兼容变更同步 README 矩阵——把 t2s/s2t、customOrder 两行回补 compatibility.md，审计矩阵保持快照不回改。

### D-5 product/README 的发行资产描述与 CI 事实、deploy.md 三方矛盾 —— 高

- 证据：`product/README.md:25`「桌面程序这一档**当前不在 Releases 上**…只有 legado.jar、legado-dist.zip 与…legadoq-<版本>.zip」（主会话已复核原文）；`build-jar.yml:327-329` 实际上传 `legado.jar / legado-dist.zip / legadoq-desktop-*.zip`，`:287` 推荐桌面包；`deploy.md:16-19` 明确桌面包在 Releases 且 CI 打。另 deploy.md:17 与 product/README 都提到 CI 从不产出的资产名 `legadoq-<版本>.zip`。
- 建议：以 build-jar.yml 为事实源重写 product/README §Windows 桌面程序首段与 deploy.md:17 资产名；RELEASING §4/§6 口径正确可作模板。

### D-6 功能清单三份并存；根 README 功能表缺 AI；product/README 内嵌第二索引 —— 中

- 证据：根 `README.md:14-30` 功能表无 AI 行（AI 有 22 端点，product/README:67-104 大篇幅、功能说明.md:153-162 已覆盖）；product/README「能力」节与功能说明.md 高度重叠；`product/README.md:241-259` 文档表把 agent-api.md 连列三行，与 docs/README.md:3「不再另建索引」相抵触。
- 建议：判定为有意分层（根=入口摘要，product/README=产品门面，功能说明=用户手册），保留但：根表补 AI 行；product/README 文档表收敛为指向 docs/README 的单一链接；RELEASING §3 同步清单加上根 README 功能表。

**已核验为有意分层、无冲突**：根 CHANGELOG（3 行指针）→ product/CHANGELOG 权威；RELEASING（流程）vs RELEASES（自动台账，:3「不要手改」）分工清晰；architecture-audit.md:7 与 facts.md:9 有显式「分工」头指向 ARCHITECTURE.md 为现行权威。

## 2. 过时内容

### D-8 STATUS.md environment 条目滞后 —— 中（确认第一阶段 P1-4）

- `docs/STATUS.md:167`「globalThis.environment 全局缺失」；实现已在 `rules/JsSandbox.kt:414-418`，提交 2cdf9d8（比 STATUS 最后更新晚 1 分钟）。建议缺口表删去 environment 半句（保留四字段零执行告警部分）。

### D-9 NetworkSecurity/ProxyHeaders 已迁 ops/，三份现行文档仍写 http/ —— 中

- 实际位置 `ops/NetworkSecurity.kt`、`ops/ProxyHeaders.kt`（glob 实测）；`docs/ARCHITECTURE.md:39/236/609`、`docs/STATUS.md:35`、`product/README.md:207` 仍列 http/。ARCHITECTURE_MAP:9 已正确记 ops/。
- 建议：三处改 ops/；product/README:218 的 ops/ 描述（仅 LogService·UpdateCheck）顺带补全（现 9 文件含 PinnedProxy/Metrics/GuardedHttpClient）。

### D-10 RELEASING 的版本抄本数过时：7 处 → 实际 8 处，且 set-external 不写 STATUS —— 中

- `RELEASING.md:15-17/112/178`「6 处抄本…7 处一致」；`product/scripts/version-check.mjs:91-101` sources 含 `../docs/STATUS.md` 共 8 项；`scripts/version.mjs` grep STATUS 零命中。sessions/2026-11-13:35 已记「8 处」。
- 建议：RELEASING 改「7 处抄本/8 处一致」，补「STATUS.md 版本行需手改」步骤，或让 version.mjs 同步 STATUS。

### D-11 RELEASING §5 的发布后核对命令在仓库根跑不通 —— 中

- `RELEASING.md:34`「全程在仓库根执行」+ `:168`「node stop.mjs && node start.mjs --no-open」；根目录无 start/stop.mjs（在 product/）。建议改 `npm run stop && npm start -- --no-open`。

### D-12 facts.md 作为「数字唯一真源」自身停在 11-11 —— 中

- `facts.md:7` 最近采集 2026-11-11、`:30` 0.2.39/52、`:96` 20 表、`:125` 161 端点；现行：0.2.42/55、21 表（Schema.kt 实测）、165 端点（agent-api.json:1866）、后端 1,194 项/157 suite（PHASE2_PREFLIGHT:382）。docs/README:14/101 仍称数字以 facts.md 为准。
- 建议：按 facts 自身纪律**追加** 2026-11-14 采集节（带命令），不回改旧节。

### D-13 AGENTS.md 测试数滞后 —— 中

- §2「全量约 1,056 项」、§8.6「134 个」前端测试文件、「142 个」后端测试文件；11-13 实跑前端 1,157/146 文件，11-14 后端已到 1,194/157。
- 建议：AGENTS 改为链接 facts.md/STATUS，不抄数（与其自身 §0 纪律一致）。

### D-14 engineering 报告的「未提交 WIP」表述已过时 —— 中

- REPOSITORY_AUDIT:24、ROADMAP:19 P1-6、PHASE2_PREFLIGHT:66 均称 WIP 未提交；实际拆分已于 6a19f28（11-14 13:18）提交，model/ 现存 7 文件无 Models.kt。§10 执行记录未记 WIP 去向。
- 建议：快照正文不回改，§10 追加一行「并行 WIP 已以 6a19f28 提交」；P1-6 标关闭。

### D-15 .github/SECURITY.md（权威版）版本表、联系邮箱、PGP 声明全部失效 —— 高

- `:9-11` 支持版本 0.8.x/0.7.x/<0.7.0——现行 0.2.42 按此表属「不再维护」；`:21`「security@yourdomain.com (replace with your actual email)」模板占位未填；`:68-75` 声称 GPG 签名 tag + keyserver 占位链接，而 STATUS.md:170 明记「产物未签名」、RELEASING 全文无签名步骤。product/SECURITY.md:3 指向它为权威。
- 建议：重写支持版本表（0.2.x）、填真实报告渠道（GitHub Security Advisories 即可）、删 PGP 节或落地签名。对外安全承诺，优先级最高。

### D-16 .github/CONTRIBUTING.md（权威版）与现实脱节，含占位符与虚构版本 —— 高

- `:36`「cd src/web」（实际 product/web）、`:53`「localhost:3000」（vite.config.ts:145 实为 5174）、`:213`「linqinqiu@example.com」占位、`:226`「版本 v0.9.0-alpha」（从未存在；RELEASING:45 明确不用预发布后缀）、`:173` 承诺的 CONTRIBUTORS.md 不存在、`:100`「git add .」与 RELEASING:92「明确列出文件」相抵触；product/CONTRIBUTING.md:3 称其「英文」实为中文。
- 建议：与 product/CONTRIBUTING.md 合并重写权威版，删虚构版本/奖励承诺；互指关系保留。

### D-17 ARCHITECTURE.md 头部快照日期标签落后于正文 —— 低

- `:4`「端点数与表数是 2026-11-10 快照」，正文 165/21 为 11-12/13 数字。建议头部日期改最近核对日。

**已核验未漂移**：端点 165/19 组（agent-api.json:1866 = 根 README:88 = STATUS §2.2 逐组求和）；21 张表；model/ 七文件（ARCHITECTURE:250 已更新）；gates-guide「79 个 .mjs / 47 个 check」与实测一致；http/ 15 个域路由文件一致；Models.kt、product/AGENTS.md 的旧引用全部位于带过期横幅的快照内，未见现行文档引用已删文件。

## 3. 失效引用与索引覆盖

### D-18 docs/engineering/（今日新增）无任何入口；STRUCTURE 职责表漏两个目录 —— 中

- docs/README.md 全文无 engineering 字样；AGENTS.md grep engineering/audit 零命中；STRUCTURE.md:19-27 职责表无 docs/engineering/、无 docs/.scratch/（后者仅 docs/README:6 提及）。
- 建议：docs/README 增「工程审计」节；STRUCTURE 职责表与「新增文件放哪里」补 engineering/（审计/整改记录）与 .scratch/（草稿，gitignored）。

### D-19 research/README.md 漏索引 3 份现役文件 —— 中

- 目录实测 17 份，索引未含 `研究-C03-段评只读设计-2026-11-12.md`、`研究-十二仓借鉴-2026-11-12.md`、`反馈台账-2026-11-12.md`（用户反馈处置台账，价值高）。
- 建议：补入索引；C03 与 ROADMAP S0 状态直接相关。

### D-20 docs/README 产品手册清单漏 import-conflict-policy.md —— 低

- `product/docs/import-conflict-policy.md`（11-13 新增，:3 要求与 ImportConflictPolicyTest 同步）不在索引任何小节。补入「开发与验证」。

### D-21 docs/README 归档节只列 8 份中的 4 份 —— 低

- 另有 CHANGELOG-0.8.6及以前.md(88KB)、RESEARCH-NOTES.md(29KB)、version-log-governance.md(11KB) 未列。补三行或注明「完整清单见 archive/README」。

**已核验**：11 份顶层文档共 **98 条相对链接全部可达**；STRUCTURE:66 所列 CI workflow 均存在；根 README:108-109 指向的 .github/CONTRIBUTING.md、SECURITY.md 存在（内容问题见 D-15/16）。

## 4. 工程记录与正式文档混杂

### D-22 product/docs/ 混放产品手册与过程记录，审计类文档现在有两个家 —— 中

- architecture-audit.md（外部报告核对快照）、rules-sandbox-audit.md（11-08 审计）、rule-processor-migration-plan.md、restructure/（过程分析+facts）、待定功能.md 与手册同目录；今日同类审计已改放 docs/engineering/audit/。
- 建议：这些是过程记录但均有状态/分工头且被索引，迁移收益低。**保留原地**，docs/README 该小节改名「开发与工程记录」，注明「新审计一律进 docs/engineering/audit/」。

### D-23 engineering 新类别绕过 sessions/research 分工，无放置规则 —— 中

- sessions/README:37-47 分工表明确；11-14 审计轮无 sessions 文件，11 份报告落 engineering/audit（执行记录在 PHASE2_PREFLIGHT §10 附录）；engineering/ 无 README，remediation/product/quality 三子目录全空。
- 建议：给 engineering/ 写 README 定义各子目录用途或裁掉空目录；docs/README 放置规则补「审计报告→engineering/audit，整改执行记录→preflight 附录或 remediation」，说明与 sessions 的关系（审计轮可免 session，但需索引）。

### D-24 .scratch/compat-audit 把上游克隆与 25MB 语料放进仓库树 —— 中

- `docs/.scratch/compat-audit/` 含 upstream-legado、ref-legadoteam、ref-md3、ref-legado-e、ref-legado-server、corpus-liufuyou（带 .git 完整克隆）及 sources-2026-11-13.jsonl（25,357,765 B）；STRUCTURE:10/33 要求上游参照放仓库外 legado-out/assets/refs；.scratch/README:3 用途仅限「未定稿 Markdown」。均已 gitignore，不入库但占工作区。
- 建议：克隆与语料迁 `E:\legado-out\assets\refs`，.scratch 只留分析脚本与 md；或在 STRUCTURE 给 .scratch 增加「临时语料/克隆」例外条款并定期清理。

## 5. 无人维护 / 孤儿文档

### D-25 BOOK-SOURCE-MEDIA 与 PERFORMANCE-MONITORING 均被索引，不是孤儿 —— 低

- 后者头部无日期/状态，「控制台 report()」口径与 STATUS:169 一致，内容未失真。建议补日期头与「范围=采集口径，产品化观测未做」一句。

### D-26 待定功能.md 已无「待定」项，名实不符 —— 低

- `:5-7` 唯一条目「书签（已落地）…不再算待定」；ROADMAP:32 仍引其为设计记录。
- 建议：改名「设计记录-书签.md」或迁 archive 留指针；保留「待定」空壳会诱导后续 AI 往里塞规划（违反 STRUCTURE:8）。

### D-27 根 README 端点总数是未被门禁钉住的手抄数 —— 低

- 根 README:88「165（19 组）」当前正确但属会漂移的抄本（docs/README:113 禁抄会变数字）。建议改链接不写数，或给 ApiCatalog 判据加 README 计数断言。

## 6. 元信息（状态/日期标记）

### D-28 architecture-audit.md 有状态无日期/commit —— 低

- `:3`「写于当次 commit 的快照」但未写哪个 commit/日期。建议头部补「写于 <commit> / 2026-11-11」。

### D-29 发版同步链上的活文档缺「最后同步版本」标记 —— 低

- 功能说明/compatibility/deploy/frontend-conventions/coverage-guide/gates-guide/import-conflict-policy 头部均无版本/日期；RELEASING:66-67 要求随发版同步，读者无法判断是否已同步到 0.2.42。gates-guide 的自漂移声明（「以 --list 为准」）是正面样例。
- 建议：至少给功能说明/compatibility/deploy 三份加「最后核对：0.2.42 / 日期」一行，可纳入发版清单。

### D-30 product/port.txt 未被忽略 —— 低（与 G-1/S-20 同一问题，三处独立发现）

**元信息做得好的（核验通过）**：engineering/audit 11 份全带「审计日期+HEAD+性质」头；restructure 三份均有「数字过期，以 facts 为准」横幅；research 无日期文件名的 5 份内部均有日期；plugin 两份带「已废弃」；agent-api.md:3 带迁移说明；API-REFERENCE 带生成时间与版本；STATUS/ROADMAP 带快照口径节。

## 7. 文档权威地图（草案）

| 主题 | 唯一权威 | 衍生 / 历史 / 快照 |
|---|---|---|
| 版本号 / 构建号 | `product/app/build.gradle` + 根 `BUILD_NUMBER` | 抄本由 version-check 钉住（8 处）；RELEASES.md 自动台账 |
| 用户可见变化 | `product/CHANGELOG.md` | 根 CHANGELOG（指针）；Release 正文自动摘录 |
| 发布流程 | `RELEASING.md`（需修 D-10/11） | RELEASES.md（记录，不手改） |
| 端点契约 | `agent-api.json`（= GET /api/catalog） | API-REFERENCE.md（生成）；根 README/STATUS 计数为抄本 |
| 现行架构 | `docs/ARCHITECTURE.md`（需修 D-9/17） | architecture-audit.md（快照+六条纪律）、ARCHITECTURE_MAP（审计提案，A-5 有误）、restructure/*（过程） |
| 规模 / 测试数字 | `facts.md`（**待追加 11-14 采集**） | STATUS §9、AGENTS §2/§8.6（已漂移）、各研究快照 |
| 当前能力与缺口 | `docs/STATUS.md`（带日期快照） | research 各篇、engineering 审计报告 |
| 产品路线 | `docs/ROADMAP.md`（历史决策框架） | **当前执行**：engineering/audit/ROADMAP.md + PHASE2_PREFLIGHT §10 |
| 书源兼容性 | `product/docs/compatibility.md`（需补 D-4） | 根 README 矩阵（摘要）、COMPATIBILITY/BACKUP/ECOSYSTEM（审计快照） |
| 功能说明 | `product/docs/功能说明.md` | 根 README 功能表、product/README 能力节（需补 AI/修桌面） |
| 目录职责 / 放置规则 | `docs/STRUCTURE.md`（需补 engineering/.scratch） | docs/README 放置规则节、.scratch/README |
| 文档索引 | `docs/README.md`（唯一入口） | research/README（漏 3 份）、sessions/README、product/README 文档表（应收敛） |
| 安全政策 | `.github/SECURITY.md`（**需重写 D-15**） | product/SECURITY.md 中文要点；SECURITY_THREAT_MODEL（快照） |
| 贡献政策 | `.github/CONTRIBUTING.md`（**需重写 D-16**） | product/CONTRIBUTING.md 本地操作要点（准确） |
| AI 接入/媒体/性能/导入冲突 | agent-api.md / BOOK-SOURCE-MEDIA.md / PERFORMANCE-MONITORING.md / import-conflict-policy.md | agent-api.json；相关研究快照 |
| 过程记录 | research=快照结论，sessions=按轮日志，engineering/audit=审计（待立规则），.scratch=草稿，archive=历史 | 待定功能.md 建议转设计记录/归档 |

## 8. 总评

30 条发现（高 4：D-1/D-5/D-15/D-16；中 14；低 12）。「快照+横幅+唯一索引」纪律整体运转良好（98 条链接全可达、旧引用均在带标记快照内）。最急迫：两份 .github 权威政策文档的占位符与虚构版本（对外承诺失真）、product/README 发行资产误述、**撤销「13→19 Dao」错误整改项**。其次是把 docs/engineering/ 纳入索引与 STRUCTURE，给 facts.md 追加最新采集。
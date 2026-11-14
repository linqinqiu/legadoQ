# 08 · 建议结构与治理方案（RECOMMENDED-STRUCTURE）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ 性质：方案制定，未实施（目录与文件资产审计分册 8/9）
> 原则：**不推翻现有结构**。骨架健康（01/02 分册结论），只做补登记、清遗留、防漂移三类动作。所有迁移按建议②四阶段纪律，实施须另起一轮并经确认。

## 1. 目标结构（相对现状的最小 diff）

```
legadoQ/
├── .github/                  # 保留；重写 SECURITY.md/CONTRIBUTING.md 内容（D-15/16）
├── .codebuddy/agents/        # 保留；code-explorer 纳入同步或去行数（S-3）
├── docs/
│   ├── README.md             # 唯一索引：补 engineering 节、import-conflict-policy、归档三行
│   ├── STRUCTURE.md          # 职责权威：补 engineering/、.scratch/、archive 例外三行
│   ├── ARCHITECTURE.md 等顶层 8 份  # 保留；修 D-9/17 漂移
│   ├── engineering/          # 【补登记】工程审计与整改记录
│   │   ├── README.md         # 【新建】定义子目录用途与放置规则
│   │   ├── audit/            # 只读审计快照（现有 11 份 + directory/ 9 份）
│   │   └── remediation/      # 整改执行记录（或继续用 preflight §10 附录，二选一并写明）
│   │   # product/ quality/ 两个空目录：无用途定义则裁掉（G-5）
│   ├── research/  sessions/  archive/   # 保留；research 索引补 4 份（D-19+核对报告）
│   └── .scratch/             # gitignored；只留 md/分析脚本，克隆与语料迁仓库外（D-24）
├── product/
│   ├── plugins/ examples/plugin-hello/  # 挂废弃横幅或移仓库外 archive（O-1）
│   ├── extensions/chrome/    # 保留；补文档入口（G-7）
│   ├── docs/                 # 产品手册 + 旧过程记录原地保留；新审计不进这里
│   └── .gitignore            # 补 /port.txt（G-1）
├── scripts/                  # 退役 version-reconcile、根 gen-api-reference（O-2/O-3）
└── 根目录其余入口文件         # 全部保留（01 分册：21 条目全合规）
```

**明确不做**（对照建议②的目标结构）：不建 `.ai/`（与 AGENTS+protocol 机制重复）；不建顶层 `tests/`（测试随产品，CI 路径已标定）；不把 CONTRIBUTING/SECURITY 搬到根目录（.github 是社区标准位）；不新建 DOCUMENTATION-INDEX.md / AI-WORKFLOW.md 第二权威（职责并入 docs/README 与 AGENTS.md）；不搬 product/docs 旧过程记录（有状态头+被索引，迁移收益低）。

## 2. 三个长期管理文件（采纳建议②的意图，落到现有文件）

| 建议②的文件 | 本仓落点 | 动作 |
|---|---|---|
| STRUCTURE.md（目录职责） | `docs/STRUCTURE.md` 已有 | 补 engineering/.scratch/archive 例外三行 + 「新增文件放哪里」补审计/整改记录两行 |
| DOCUMENTATION-INDEX.md（文档权威） | `docs/README.md` 唯一索引 + 03 分册 §7 权威地图 | 索引补漏；权威地图毕业进 docs/README 或 STRUCTURE 附录（一份，不两处） |
| AI-WORKFLOW.md（AI 读写规则） | `AGENTS.md` §0/§9 + protocol-template.md | 不新建；补 S-1/S-2/S-3 三个同步盲区 |

## 3. 防再漂移机制（CI 卫生门禁提案）

现有门禁已覆盖版本/契约/协议/目录深度，缺的是**文档与目录卫生**。提案新增 `product/tools/verify/doc-hygiene-check.mjs`（接 contract.yml）：

1. **索引覆盖**：docs/ 顶层与 research/、engineering/audit/ 的每份 md 必须被 docs/README 或子索引引用（白名单豁免 README 自身）。
2. **STRUCTURE 登记**：docs/ 与 product/ 顶层新增目录必须出现在 STRUCTURE.md 职责表（防 engineering/ 式先建后登记）。
3. **根目录入口白名单**：根目录新增文件必须命中白名单（现有 21 条目 + 明确审批），否则红。
4. **死链扫描**：顶层文档相对链接可达性（本轮 98 条全可达，固化为判据）。
5. **权威唯一**：同一主题权威文件只许一份（按权威地图清单钉住，如 CHANGELOG 权威=product/）。

先做 1/3/4（机械可判），2/5 随权威地图毕业后再钉。门禁只许单调收紧，豁免须写理由。

## 4. 分阶段迁移计划（实施须另起一轮，经确认）

### 阶段 A：零风险卫生（可随下一次普通提交，无需专门确认）

| 动作 | 发现 | 验证 |
|---|---|---|
| product/.gitignore 加 `/port.txt` | G-1/S-20/D-30 | git check-ignore 命中 |
| docs/README 补 engineering 节 + import-conflict-policy + 归档三行；research/README 补 4 份 | D-18/19/20/21 | 索引覆盖检查 |
| STRUCTURE 补 engineering/.scratch/archive 例外；engineering/README 新建；裁两个空目录 | D-18/G-5/G-6 | 目录与职责表一致 |
| version.mjs 头部 bump 注释改「仅发布时 bump」 | S-19 | 与 VersionTracks 纪律一致 |
| AGENTS.md:140 措辞、snapshot.mjs:26 名单、product/README favicon 死链 | S-4/S-27/G-3 | 前端测试全绿 |
| ARCHITECTURE_MAP A-5 / audit ROADMAP P1-3 追加勘误（13 Dao 正确，撤销改数动作） | D-1 | 勘误以追加形式，不改写快照正文 |

### 阶段 B：文档内容修复（一批提交，逐项带证据）

| 动作 | 发现 |
|---|---|
| 重写 .github/SECURITY.md（0.2.x 支持表、GitHub Security Advisories 渠道、删 PGP 占位）与 CONTRIBUTING.md（真实路径/端口、删虚构版本与占位邮箱） | D-15/16 |
| product/README 发行资产段以 build-jar.yml 为准重写；deploy.md:17 资产名修正 | D-5 |
| STATUS environment 条目、ARCHITECTURE/STATUS/product-README 的 ops/ 路径、ARCHITECTURE 头部日期、RELEASING 抄本数与根目录命令 | D-8/9/10/11/17 |
| facts.md 追加 2026-11-14 采集节（带命令）；AGENTS 测试数改链接 | D-12/13 |
| compatibility.md 回补 t2s/s2t、customOrder 两行；根 README 功能表补 AI 行 | D-4/6 |
| PHASE2_PREFLIGHT §10 追加 WIP 去向（6a19f28），P1-6 关闭 | D-14 |
| 功能说明/compatibility/deploy 加「最后核对版本」头 | D-29 |

### 阶段 C：脚本与 CI 收口（每项单独提交 + 测试）

| 动作 | 发现 | 风险 |
|---|---|---|
| clean-local.sh worktree 段加脏净检查（默认跳过脏 worktree，--force 显式才强删）；sh/cmd 对齐 | S-6/13 | **高优先**：并行 agent 数据安全 |
| 开源卫生门禁扫描根扩到仓库根；随后退役 O-2/O-3 两份盘符死脚本 | S-10/8/9 | 先扩扫描再删脚本，顺序反了会漏检 |
| stop.mjs 加 POSIX 分支；version-gate smoke 读实际端口 | S-7/24 | CI 行为变化，需跑一轮验证 |
| CI 去重（contract 前端子集化、ci 撤 version-consistency）；check:test 进 CI | S-18/25 | 门禁集合变化须文档注明 |
| build-portable 退役；打包链分工写清；verify 版 version-check 改名 | S-11/16/17 | 改名须同步 gates.yml 引用 |
| Dockerfile Gradle 升 8.14.4；docker latest 语义注释；工作流陈旧注释 | S-21/23/22 | 低 |

### 阶段 D：遗留资产与决策项（需用户/属主确认）

| 动作 | 发现 | 确认点 |
|---|---|---|
| 插件遗留（O-1）挂横幅或出库 | G-2 | 保留历史参考 or 出库 |
| .scratch 克隆/语料迁 E:\legado-out\assets\refs | D-24 | 迁移时审计引用路径同步 |
| typeset 分页簇接入或删除 | N-1/O-5 | 先出性能测量，再决策 |
| 待定功能.md 转设计记录 | D-26/O-10 | 低 |
| doc-hygiene 门禁落地（§3） | 防漂移 | 白名单初版须审 |
| 本机残留清理（hs_err ×39、tmp 38MB、tools 四份探针） | G-4/S-15 | 停服后 clean-local；非 git 资产 |

## 5. 与整改主线的关系

本计划是**文档/目录/脚本卫生线**，与 engineering/audit/ROADMAP 的代码整改线（P0-3 schema version → 补测 → 第三阶段半成品收口 → 第四阶段分层）并行不冲突：阶段 A/B 不碰任何 Kotlin/前端源码逻辑；阶段 C 的 clean-local 修复建议插队到最前（数据安全）；阶段 D 的 typeset 决策归第三阶段。两线共用一条纪律：每项单独提交、带证据、快照不回改、删除可恢复。

## 6. 六类文件制度与文档元信息的判定（2026-11-14 补全，对应任务书 §3）

**六类文件管理制度：采纳意图，映射到现有机制，不另立第二套分类。**

| 类别 | 现有机制 | 缺口与处理 |
|---|---|---|
| 正式文件（源码/配置/资源） | git 跟踪 + CI 门禁 | 无 |
| 权威文档 | 权威地图（03 分册 §7）+ docs/README 唯一索引 | doc-hygiene 门禁钉权威唯一（§3，阶段 D） |
| 研究资料 | research/ 快照纪律 + .scratch 草稿隔离 | 克隆/语料迁仓库外 refs（D-24，阶段 D） |
| 工程记录 | sessions/ 按轮日志 + engineering/ 审计整改（README 已立规则） | 无 |
| 临时文件 | .scratch/ + product/tmp/（均 gitignored） | 无 |
| 运行产物 | 根/product 双层 .gitignore 忽略网（注释化白名单） | port.txt 漏洞已补（阶段 A 已交付） |

**文档元信息（YAML frontmatter）：不采纳全量 frontmatter 化。** 理由：需重写全部文档，而现有「审计日期 + HEAD + 性质」头、状态横幅（已废弃/数字过期以 facts 为准）、快照口径节约定已起同等作用，且有 protocol:check 这类门禁样例。采纳最小形式：

- 发版同步链三份活文档（功能说明/compatibility/deploy）加「最后核对：<版本> / <日期>」一行（D-29，阶段 B），纳入发版清单。
- 审计报告头约定已就位（11+9 份全带日期/HEAD/性质），不回改。
- 任务书要求的脚本自动检查（重复文档/无归属文件/过期文档/失效链接/多权威）由 doc-hygiene 门禁实现（§3），按路径与索引判定，不依赖 frontmatter 解析。
# 目录与文件资产审计 · 总报告（FINAL-REPORT）

> 审计日期：2026-11-14 ｜ HEAD：`4cb78b4` ｜ VERSION 0.2.42 / BUILD_NUMBER 55
> 性质：第一阶段只读审计（建议②四阶段纪律）。未修改任何现有文件；本目录 9 份报告与核对报告为新增产物。
> 触发：用户粘贴两份外部建议（战略规划 + 目录审计任务书）。战略建议的逐条取证核对见 `docs/research/研究-外部建议核对-2026-11-14.md`（新增项 N-1～N-4）；本目录执行的是目录/文件资产审计。
> 分册：01 根目录 ｜ 02 目录职责 ｜ 03 文档体系 ｜ 04 AI 指令 ｜ 05 脚本配置工作流 ｜ 06 Git 资产 ｜ 07 重复与孤儿 ｜ 08 建议结构与迁移计划。

## 0. 一句话结论

**仓库不需要大规模目录重组。** 根目录 21 条目全部合规、978 个跟踪文件无敏感/大产物入库、98 条文档链接全可达、AI 指令生成链有效。真正的问题集中在四处：①今日新增的 `docs/engineering/` 未走登记流程；②两份 `.github/` 权威政策文档是占位符/虚构内容（对外承诺失真）；③一条高危脚本缺陷（clean-local 强删脏 worktree）+ 门禁扫描盲区放走了两份硬编码盘符死脚本；④现有审计的一条整改项（P1-3「13→19 Dao」）本身是错的，执行前必须撤销。

## 1. 发现统计

| 分册 | 高 | 中 | 低 | 合计 |
|---|---|---|---|---|
| 03 文档（D-1～D-30） | 4（D-1/5/15/16） | 14 | 12 | 30 |
| 04 AI 指令（S-1～S-5） | 0 | 3 | 2 | 5 |
| 05 脚本配置（S-6～S-27） | 1（S-6） | 8 | 13 | 22 |
| 06 Git 资产（G-1～G-12） | 0 | 2（G-1/2） | 8（含通过项） | 12 |
| 07 重复孤儿（O-1～O-10） | — | — | — | 真孤儿 5 组 + 半死 5 组 |

去重后（port.txt 三处同题等）约 60 条独立发现。**高危 5 条**：D-1（错误整改项）、D-5（发行资产误述）、D-15/16（政策文档失真）、S-6（数据安全）。

## 2. 十个问题的回答（对应审计任务书）

**Q1 当前目录结构有哪些问题？**
骨架健康。问题不在结构而在登记与内容：engineering/ 未登记（D-18）、.scratch 超范围放克隆/语料（D-24）、archive 库内/出库口径冲突（G-6）、product/docs 混放过程记录（D-22，保留原地即可）、port.txt 漏忽略（G-1）。

**Q2 哪些目录应该保留？**
全部现有目录保留：根 21 条目、product/ 源码与配置、docs/ 五类子目录、scripts/ 双层分工。唯一裁撤候选是 engineering/ 下无用途定义的两个空目录（product/、quality/，G-5）。

**Q3 哪些目录应该合并？**
不合并任何目录。看似重复的均为有意分层：两份 LICENSE（路径分许可）、根/product 两套 README 与 CHANGELOG（受众分层）、两份 ROADMAP（产品框架 vs 整改执行，互链即可）、product/docs 旧审计 vs engineering 新审计（旧地保留，新审计进新址）。

**Q4 哪些目录应该拆分？**
不拆。建议②的 docs/architecture|development|decisions 细分与 .ai/ 中心不采纳——现有「顶层权威 + research/sessions/engineering/archive」已覆盖其意图，细分只增加搬运成本。

**Q5 哪些文件应该移动？**
仅两类：.scratch/compat-audit 的上游克隆与 25MB 语料 → 仓库外 `E:\legado-out\assets\refs`（D-24，需确认）；本机遗留探针 product/tools/{dbq.mjs,Guard.java,JpTest.java,check-worktree.sh} → tmp/ 或清理（S-15，非 git 资产）。**无源码/正式文档需要移动。**

**Q6 哪些文件应该归档？**
插件遗留（plugins/README + examples/plugin-hello，O-1）挂废弃横幅或移仓库外 archive；待定功能.md 转设计记录或归档（D-26）；退役脚本 O-2/O-3/O-4 移仓库外 archive（git 历史亦可恢复）。docs/archive 现有 8 份不动。

**Q7 哪些文件应该删除？**
本轮不建议任何永久删除。可退役（删除或出库，二选一，均附证据）：version-reconcile.mjs（O-2，调用方仅归档文档）、根 gen-api-reference.mjs（O-3，product 同名版才是现役）、build-portable.mjs（O-4，零调用方）。typeset 分页簇（O-5）是**决策项**：接入或整簇删，先出性能测量，不顺手删。

**Q8 哪些文件存在重复？**
真重复且漂移：product/README 发行资产段 vs build-jar.yml vs deploy.md（D-5，以 CI 为准重写）；根 gen-api-reference vs product 版（O-3）；两个 version-check.mjs 同名异责（S-17，改名）。其余「重复」为有意分层，见 07 分册 §3，勿合并。

**Q9 哪些文档应该成为权威文档？**
03 分册 §7 给出完整权威地图。要点：版本=build.gradle+BUILD_NUMBER；用户可见变化=product/CHANGELOG；端点=agent-api.json；现行架构=docs/ARCHITECTURE.md；数字=facts.md（待追加 11-14 采集）；兼容=product/docs/compatibility.md；目录=STRUCTURE.md；索引=docs/README.md；安全/贡献=.github 两份（**内容需重写**）；当前执行计划=engineering/audit/ROADMAP + PHASE2_PREFLIGHT §10。

**Q10 如何防止未来再次混乱？**
四件事：①STRUCTURE 补登记 + engineering/README 定放置规则；②doc-hygiene 门禁（索引覆盖/根目录白名单/死链扫描，08 分册 §3）；③AI 指令同步补盲（模板加禁读区与版本纪律、AGENTS↔模板关键规则断言、code-explorer 纳入或去行数）；④发版同步清单加「最后核对版本」头与根 README 功能表。纪律已有（快照不回改、唯一索引、草稿隔离），缺的是把纪律变成门禁。

## 3. 优先行动（跨分册汇总）

1. **S-6 clean-local 脏 worktree 保护**（数据安全，插队最前）。
2. **D-1 撤销错误整改项**（A-5/P1-3 勘误已随本轮追加，防第四阶段把正确文档改错）。
3. **D-15/16 重写两份 .github 政策文档**（对外承诺）。
4. **D-5 发行资产描述以 CI 为准**（用户下载指引错误）。
5. **S-10 门禁扩扫 + O-2/O-3 死脚本退役**（先扩扫再删）。
6. **阶段 A 零风险卫生批**（port.txt 忽略、索引/STRUCTURE 登记、注释修正——随本轮整合提交）。
7. 其余按 08 分册阶段 B/C/D 推进；D 阶段含确认点。

## 4. 与现有审计/整改主线的关系

- 本审计是 `docs/engineering/audit/` 第一阶段（代码/安全/数据，38a82d5）的**目录/文件资产补集**，不重复其结论；其 P1-3 被本审计 D-1 证伪，P1-4/P1-6 的修复动作归入阶段 B。
- 战略建议核对结论：大部分断言已修复/已排期，真正新增项 N-1（typeset 决策）、N-2（备份导出+往返判据）、N-3（本目录治理）、N-4（AI 同步盲区）。N-3 即本计划；N-1 归第三阶段；N-2 建议并入兼容主线排期。
- 第二阶段代码整改（P0-3 schema version、沙箱补测）不受本计划影响，两线并行。

## 5. 审计限制（如实声明）

- 未运行测试/构建/脚本（只读纪律）；测试数字引自 PHASE2_PREFLIGHT §10 执行记录（1,194 项/157 suite，d503cf6 时点）。
- 禁读区（docs/archive 内容、product/data、build/dist/node_modules/jar）只列清单；.env.example、agent-profiles.json、cookie 文件内容未读（按文件名判敏）。
- git 历史大 blob/泄密追溯未做；仓库外 legado-out/legado-archive 实物未盘点。
- tools/verify/ 80+ 门禁脚本未逐份读正文（白名单机制已核）。
- 并行 agent 活跃（审计期间 HEAD 未动，但工作树可能有其半成品）；本报告 file:line 以 4cb78b4 为准，后续提交可能偏移。
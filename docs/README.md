# 文档总目录

> 这是**唯一入口**。找文档先看这里，不再在根目录或 `product/docs/` 下另建索引。
> 现行说明、产品手册、研究快照、工程日志、归档各归一处；会变的数字不抄进索引。
>
> **草稿隔离**：探索性 / 未定稿的 md 先放 `docs/.scratch/`（已 gitignore），毕业后再迁入
> `docs/research/` 或 `docs/sessions/`。禁止在 `docs/` 根或 `product/docs/` 直接散落新 md ——
> 这是防止「工作产生大量不准确文件」的唯一闸门。

## 先看这几份

| 想知道什么 | 看哪份 |
| --- | --- |
| 当前能做什么、还缺什么 | [STATUS.md](STATUS.md)（带日期的快照，数字口径以 [facts.md](../product/docs/restructure/facts.md) 为准） |
| 长期要做什么、按什么顺序 | [ROADMAP.md](ROADMAP.md)（采纳的外部建议框架：L0→L3 分层、S0 兼容内核优先，带采纳状态） |
| 整体架构与模块边界 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 接口完整清单（自动生成） | [API-REFERENCE.md](API-REFERENCE.md) |
| 这一版对用户多了什么 | [product/CHANGELOG.md](../product/CHANGELOG.md) |

## 现行说明

| 文档 | 管什么 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 全景、分层、开书链路、数据布局、启动与安全边界 |
| [API-REFERENCE.md](API-REFERENCE.md) | 端点、同源写门、错误格式（由 `/api/catalog` 生成，不手改） |
| [STATUS.md](STATUS.md) | 当前结构、能力、已知缺口（快照） |
| [STRUCTURE.md](STRUCTURE.md) | 目录职责、文件放置规则、仓库外资产 |
| [BOOK-SOURCE-MEDIA.md](BOOK-SOURCE-MEDIA.md) | 文本 / 图片 / 音频 / 视频 / 文件的解析、代理、HLS 与限制 |
| [PERFORMANCE-MONITORING.md](PERFORMANCE-MONITORING.md) | 前端性能采集与瓶颈报告口径 |

## 产品手册（`product/docs/`）

**部署与兼容**

- [deploy.md](../product/docs/deploy.md) — jar / Docker / Compose / 桌面程序
- [compatibility.md](../product/docs/compatibility.md) — 书源与格式兼容性
- [reverse-proxy-source-guide.md](../product/docs/reverse-proxy-source-guide.md) — 反代书源操作手册

**AI 与插件扩展**

- [plugin-framework.md](../product/docs/plugin-framework.md) — 插件框架（已废弃，仅历史参考）
- [plugin-development-guide.md](../product/docs/plugin-development-guide.md) — 写一个插件（已废弃，仅历史参考）
- [../product/docs/agent-api.md](../product/docs/agent-api.md) — `/api/agent/*` 自定义接入面

**开发与验证**

- [frontend-conventions.md](../product/docs/frontend-conventions.md) — 前端命名与文件组织
- [gates-guide.md](../product/docs/gates-guide.md) — 门禁怎么跑、怎么接 CI
- [coverage-guide.md](../product/docs/coverage-guide.md) — 覆盖率怎么看、先补哪里
- [changelog-guide.md](../product/docs/changelog-guide.md) — 更新日志细则
- [restructure/facts.md](../product/docs/restructure/facts.md) — **实测事实源**（带命令与时间戳）
- [restructure/backend-layering.md](../product/docs/restructure/backend-layering.md) — 后端分层
- [restructure/frontend-host.md](../product/docs/restructure/frontend-host.md) — 前端宿主拆分
- [restructure/root-split.md](../product/docs/restructure/root-split.md) — 仓库根拆分
- [architecture-audit.md](../product/docs/architecture-audit.md) — 架构审计
- [rules-sandbox-audit.md](../product/docs/rules-sandbox-audit.md) — 规则沙箱审计
- [rule-processor-migration-plan.md](../product/docs/rule-processor-migration-plan.md) — 规则处理器迁移计划

**产品说明**

- [功能说明.md](../product/docs/功能说明.md)
- [待定功能.md](../product/docs/待定功能.md)

## 研究与决策（`docs/research/`）

完整索引见 [research/README.md](research/README.md)。当前 frontier 是
[研究-阅读器拆分续-下一步](research/研究-阅读器拆分续-下一步.md) 与
[研究-0.2.37-成果核查与下一步](research/研究-0.2.37-成果核查与下一步.md)。

> 研究文档是**当时快照**：数字、路径、结论都按写作时记，不随代码回改；引用现行数字时用 facts.md。

## 工程日志（`docs/sessions/`）

按日期一轮一份，记「为什么这样做、量到了什么、判据是什么」。命名与骨架见
[sessions/README.md](sessions/README.md)。用户可见的变化不写在这里，写 CHANGELOG。

## 归档（`docs/archive/`）

- [archive/README.md](archive/README.md)
- `reader-redesign-history.md` — 阅读器改造史（旧 7 份合并）
- `delivery-2026-10-19.md` — 2026-10-19 交付三件套（旧 3 份合并）
- `研究-书源规则引擎.md` / `研究-界面与AI借鉴.md` — 早期调研（旧 9 份合并为 2 份）

## 根级元文档

根目录只放仓库级元信息，不放研究与日志：

- [README.md](../README.md) — 项目介绍与上手
- [AGENTS.md](../AGENTS.md) — AI 协作纪律与任务→位置速查
- [CLAUDE.md](../CLAUDE.md) / [GEMINI.md](../GEMINI.md) — 其它工具的入口副本
- [CHANGELOG.md](../CHANGELOG.md) — 指向 `product/CHANGELOG.md`
- [RELEASES.md](../RELEASES.md) / [RELEASING.md](../RELEASING.md) — 发布记录与流程
- [NOTICE.md](../NOTICE.md) — 第三方与参照项目声明
- [product/README.md](../product/README.md) / [product/CONTRIBUTING.md](../product/CONTRIBUTING.md) / [product/SECURITY.md](../product/SECURITY.md)

## 事实口径（防止文档再飘）

| 问题 | 唯一来源 |
| --- | --- |
| 版本号 | `product/app/build.gradle` 的 `version`（`version:check` 钉住 7 处抄本） |
| 端点数量与分组 | `GET /api/catalog`；[API-REFERENCE.md](API-REFERENCE.md) 由它生成 |
| 代码规模、测试数、覆盖率 | [restructure/facts.md](../product/docs/restructure/facts.md)（必须带命令与时间戳） |
| 用户可见变化 | [product/CHANGELOG.md](../product/CHANGELOG.md) |
| 工程决策与量测过程 | `docs/sessions/` |
| 研究结论与方案取舍 | `docs/research/`（快照，不追改） |

文档冲突时的优先级：`product/CHANGELOG.md` > `docs/{ARCHITECTURE,STRUCTURE,API-REFERENCE}.md`
> `product/docs/restructure/facts.md`。

## 放置规则

- 新研究写 `docs/research/研究-<主题>.md`；一轮工程记录写 `docs/sessions/YYYY-MM-DD-<主题>.md`。
- 产品操作手册写 `product/docs/`；根目录只新增仓库级元文档。
- 不在文档里复制会变的测试数、端点数和版本号，改为链接上述事实源。
- 旧快照不回改数字；结论变了就新开一份，并在开头注明承接关系。

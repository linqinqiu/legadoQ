# 文档索引

## 当前产品

- [架构示意](ARCHITECTURE.md) — 全景、分层、开书链路、数据布局、启动与安全边界（已并入原 `ARCHITECTURE-DETAILED.md` 与 `product/docs/architecture.md` 的内容）
- [API 参考](API-REFERENCE.md) — 142 条端点、同源写门、错误格式（由 `/api/catalog` 生成，`node scripts/gen-api-reference.mjs`）
- [目录规划](STRUCTURE.md) — 目录职责、文件放置规则、仓库外资产
- [变更日志](../CHANGELOG.md) — 指向 `product/CHANGELOG.md`

## 阅读器设计（已归档）

> 以下为历史规划与现状清点，已移至 [`archive/`](archive/)：

- [阅读器现状清点](archive/reader-archive.md) — v0.8.4 现状基线
- [阅读器改造方案](archive/reader-redesign-plan.md) — 基于研究纪要的可执行改造计划
- [研究纪要](archive/RESEARCH-NOTES.md) — 架构速查、契约闸门、已知文档漂移对照
- [调研纪要](archive/research/) — 01~07 七份核实/调研

## 交付文档（已归档）

> 2026-10-19 交付文档已移至 [`archive/delivery/`](archive/delivery/)。

## 后端文档

产品后端文档统一放在 `product/docs/`（部署、兼容、插件框架、门禁、规范等）。本目录只保留跨产品的架构与接口文档。

- **AI / 自定义接入面**：[`product/AGENTS.md`](../product/AGENTS.md)（已并入原 `AI-AGENT.md` / `agent-guide.md` / `ai-framework.md`）
- **架构**：见本目录 [`ARCHITECTURE.md`](ARCHITECTURE.md)（已并入原 `product/docs/architecture.md`）

`product/docs/` 其余文档按用途分三组：

**产品与接入**

- `deploy.md` — 部署与运维
- `compatibility.md` — 书源与格式兼容性

**AI 与插件扩展**

- `plugin-framework.md` — 插件框架（后端插件 + 前端插件、实验室、判据）
- `plugin-development-guide.md` — 插件开发教程
- `lab-ai-plugin.md` — 实验室 / AI 接入 / 插件三者的边界

**开发与验证**

- `frontend-conventions.md` — 前端命名与文件组织规范
- `gates-guide.md` — 门禁（`tools/verify`）怎么跑、怎么接 CI
- `coverage-guide.md` — 覆盖率怎么看、怎么补
- `changelog-guide.md` — 更新日志自动记的细则
- `reverse-proxy-source-guide.md` — 反代书源操作手册

另有 `product/docs/sessions/` 目录存放工程日志（按日期，非产品文档）。

## 历史资料

近期规划与历史文档归档在 [`docs/archive/`](archive/)。更早期的历史资料（旧前端、旧框架、proposals 等）已移至仓库外 `<仓库外>/legado-out/assets/archive`。

## 阅读顺序

1. 根 `README.md` — 当前能做什么、不能做什么
2. `docs/ARCHITECTURE.md` — 一张图看懂整体结构
3. `docs/API-REFERENCE.md` — 接口清单
4. `product/CHANGELOG.md` — 版本变化
5. `product/docs/` — 部署、兼容性、AI 框架、插件框架
6. `product/AGENTS.md` — AI / 脚本自定义接入面

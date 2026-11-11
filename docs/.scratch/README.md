# 草稿隔离区（scratch）

> **唯一用途**：未定稿、探索性、临时的 Markdown 先放这里，**不要**直接写进 `docs/` 根、
> `docs/research/`、`docs/sessions/` 或 `product/docs/`。

## 为什么存在

工作过程中 AI / 人会产出大量半成品笔记。若无隔离区，这些草稿会沉淀成永久的「研究/日志」文档，
越堆越多且互相矛盾——这正是「很多文件不准确」的来源。本目录是本仓库防文档污染的唯一闸门。

## 规则

1. 新建的探索性 md → 放 `docs/.scratch/<任意名>.md`（本目录除本 README 外全部被 `.gitignore` 忽略，不会入库）。
2. 定稿后「毕业」：
   - 研究结论 / 方案取舍 → 迁入 `docs/research/研究-<主题>.md`
   - 一轮工程记录 → 迁入 `docs/sessions/YYYY-MM-DD-<主题>.md`
   - 产品操作手册 → 迁入 `product/docs/`
3. 毕业时同步更新 `docs/README.md` 索引（它是唯一入口）。
4. 会变的数字（测试数、端点、行数）不抄进文档，一律指向
   `product/docs/restructure/facts.md`。

## 速查：新文件放哪

| 内容 | 位置 |
|---|---|
| 未定稿草稿 | `docs/.scratch/`（本目录） |
| 研究结论 / 方案 | `docs/research/研究-<主题>.md` |
| 按日工程日志 | `docs/sessions/YYYY-MM-DD-<主题>.md` |
| 产品操作手册 | `product/docs/` |
| 全景架构 / API / 目录规划 | `docs/` |
| 历史（不再更新） | `docs/archive/` |
| 后端功能 | `product/app/src/...` |
| 内置 UI | `product/web/src/...` |

# P1 实施需求 · 阅读器地基

> 阶段：P1（路线图见 `reader-redesign-roadmap.md`）
> 目标：把阅读位置真相从「页码/比例」升级为逻辑位置，并搭好三层界面、阅读域模块、统一缓存抽象的地基。
> 语言：简体中文

## 1. 范围

P1 包含 5 个任务：

- **P1-T1 逻辑位置模型**（本章重点，已开始落地）
- P1-T2 精确分页与缓存引擎
- P1-T3 阅读三层解耦 + 沉浸式
- P1-T4 阅读域模块 + ReadingRepository
- P1-T5 统一缓存抽象（阅读侧）

本文件只写需求；设计见 `reader-p1-design.md`，任务拆分见 `reader-p1-tasks.md`。

## 2. 目标

1. 阅读进度、书签、划线、笔记统一用**逻辑位置**表达：章节标识 + 章节内字符偏移 + 段落锚点。
2. 逻辑位置带 `positionVersion` 与 `positionChecksum`，支撑跨设备冲突处理与锚点失效回退。
3. 字体切换、窗口 resize、跨设备同步均基于逻辑位置恢复，不依赖当前页 DOM 或页码。
4. 页码（如有）只作为逻辑位置的派生显示值，不参与进度存储。
5. 现有阅读功能（0.8.4 已具备的划线导出、AI 选区等）不得因重构而退化。

## 3. 非目标（本阶段不做）

- 分页计算的 Web Worker 化、缓存落盘（P1-T2，但模型字段先行）。
- 章节滑动窗口、全局页索引、大章节分块（P2）。
- 多类型批注 UI、全书搜索、漫画模式（P3）。
- 安全插件化、域级测试门禁（P4）。
- 阅读统计、TTS 联动、AI 选区、配置导入导出（P5）。

## 4. 约束

- **单一产品**：改动落在 `legado/`，不在根目录另起前端/后端。
- **向后兼容**：老客户端不报 `charOffset` 时后端存默认 0，旧 `scrollPosition` 比例字段保留，迁移用既有 `pragma table_info` + `alter table` 模式。
- **不破坏已存在能力**：批注已用章节内字符偏移（PROPOSAL-019 E），重构须保留该属性。
- **版本真相**：版本号唯一来源 `app/build.gradle`；本文档不写死版本号。

## 5. 验收（P1-T1 部分）

- [ ] `reading_progress` 表含 `char_offset / paragraph_anchor / position_version / position_checksum` 四列；老库经迁移自动补齐。
- [ ] `book_note` 表含 `paragraph_anchor / position_version / position_checksum` 三列；老库自动补齐。
- [ ] `ReadingProgress` / `BookNote` / `BookNoteWrite` 模型带上述字段，默认值保证老客户端兼容。
- [ ] `GET/PUT /api/reading-progress`、`POST/GET /api/notes` 正确读写新字段；`PUT` 校验 `charOffset >= 0`。
- [ ] `saveProgress` 在 `BuiltinTools.kt` 等调用点编译通过（无位置参数错位）。
- [ ] 现有 testApplication / 单元测试在结构变更后仍通过（新增字段均为可选/默认）。
- [ ] 前端能在不破坏现有进度的前提下开始上报 `charOffset`（`readerProgress.ts` 与 API 类型扩展，二分定位恢复为后续子任务）。

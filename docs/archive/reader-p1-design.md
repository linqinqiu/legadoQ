# P1 实施设计 · 阅读器地基

> 配套：`reader-p1-requirements.md`（需求）、`reader-p1-tasks.md`（任务）
> 现状基线：以 `reader-archive.md`（v0.8.4）与实读代码为准

## 1. 现状（实读结论）

- **进度**（`reading_progress` 表 + `ReadingProgress` 模型）：`chapter_index + scroll_position`（0~1 比例）。**不是**逻辑位置——缺章节内字符偏移、段落锚点、version/checksum。
- **批注/书签**（`book_note` 表 + `BookNote`）：已是 `chapter_index + start_offset + end_offset`（**章节内字符偏移**），具备文本锚点雏形；缺 `paragraphAnchor / positionVersion / positionChecksum`。
- **前端进度**（`web/src/reader/readerProgress.ts`）：`{chapterIndex, total, fraction}`，fraction 即章内比例；与后端 `scroll_position` 对应。
- **迁移机制**（`Database.kt`）：`migrateReadingProgress` / `migrateBookNote` 用 `pragma table_info` + `alter table` 加列，模式成熟可复用。

## 2. 逻辑位置模型（P1-T1 已落地后端）

### 2.1 数据模型

逻辑位置 = `章节标识(chapterUrl) + 章节内字符偏移(charOffset) + 段落锚点(paragraphAnchor)`，并附 `positionVersion` + `positionChecksum`。

- `charOffset`：章节正文内第一个可见字符的绝对偏移（0 基）。恢复时据此在分页结果里二分定位当前页（P1-T2 消费）。
- `paragraphAnchor`：稳定定位用的段落标识（段落索引或段首哈希），内容重排后辅助回退。可空。
- `positionVersion`：逻辑位置编码版本（当前 `1`），便于后续格式迁移。
- `positionChecksum`：保存时刻的章节内容校验值（**由前端提供**，如内容哈希）。内容漂移时用于判断 `charOffset` 是否失效 → 触发 P3 的模糊重定位。

### 2.2 表变更（向后兼容）

`reading_progress` 新增列（经迁移）：

| 列 | 类型 | 默认 |
|---|---|---|
| `char_offset` | integer not null | 0 |
| `paragraph_anchor` | text | null |
| `position_version` | integer not null | 1 |
| `position_checksum` | text | null |

`book_note` 新增列（经迁移）：`paragraph_anchor(text)`、`position_version(integer not null default 1)`、`position_checksum(text)`。

`scroll_position` / `chapter_index` 保留，旧客户端与新字段互不冲突。

### 2.3 代码改动（已完成）

- `model/Models.kt`：`ReadingProgress`、`BookNote`、`BookNoteWrite` 增加上述字段（均带默认值）。
- `data/Database.kt`：`migrateReadingProgress` / `migrateBookNote` 各追加 3~4 个 `alter table`（沿用既有模式）。
- `data/ReadingDao.kt`：`saveProgress` / `getProgress` / `addNote` / `listNotes` 读写新列，参数顺序对齐。
- `http/ProgressRoutes.kt`：`PUT /reading-progress` 校验 `charOffset >= 0`。
- `ai/BuiltinTools.kt`：修复 `ReadingProgress(...)` 6 位置参数调用，改用具名 `updatedAt =`。

### 2.4 前端待办（P1-T1 后续子任务，需构建验证）

- `web/src/reader/readerProgress.ts` 的 `ReaderProgress` 增加 `charOffset`（由当前滚动/分页视图推导：首屏首字符在章节正文中的偏移）。
- 上报时附带 `paragraphAnchor`（当前段落标识）与 `positionChecksum`（章节内容哈希）。
- 恢复时：用 `charOffset` 在 P1-T2 的分页索引里二分定位当前页，替代「按 fraction 估算」。
- API 类型（`web/src` 内 `ReadingProgress` 接口）扩展字段，旧字段保留。

## 3. 后端逻辑位置收口（P1-T4 预告）

P1-T4 将新建 `ReadingRepository`，把进度/书签/划线/批注的读写从 `ProgressRoutes.kt` / `ReadingDao` 直接拼装收口到 Repository；DAO 退化为表级 CRUD。P1-T1 的字段已为这一步铺好数据结构。

## 4. 缓存抽象（P1-T5 预告）

P1-T5 引入统一缓存抽象，P1-T2 的分页缓存与 P2 的章节解析/媒体缓存共用。P1-T1 不引入新缓存，仅保证字段设计不阻碍后续。

## 5. 风险

- 前端 `charOffset` 推导需与 `readerFlow` / `pageTurn` 的渲染对齐，否则恢复位置偏差——列为 P1-T1 子任务，须配单测（P4-T4）。
- 大章节字符偏移可能很大，用 `integer`（SQLite 支持 64 位，但 Java/Kotlin `Int` 上限 ~21 亿字符；超长章节罕见，暂用 `Int`，超限再升 `Long`）。

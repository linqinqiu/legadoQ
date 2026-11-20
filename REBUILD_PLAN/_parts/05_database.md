# 05 · 数据库审计（legadoQ 二代重建 Phase 0）

> 审计对象：`E:\legadoQ-archive\product\app\src\main\kotlin\io\legado\data\`（只读，未修改任何源码、未对任何 .db 执行写操作）。
> 证据路径一律相对 `E:\legadoQ-archive\`。
> 标注约定：**【事实】**=直接读取源码/命令输出得到；**【推断】**=由代码结构推理但未运行验证；**【建议】**=重建方向建议。

## 0. 审计范围与方法（覆盖率声明见 §8.3）

【事实】**源码侧**（只读）：`E:\legadoQ-archive\product\app\src\main\kotlin\io\legado\data\`（20 个 DAO/装配文件 + `db/` 4 文件）、`backup/`（4 文件）、`SchemaVersion.kt`、`Database.kt`、`AppConfig.kt`、`Application.kt`，以及 `http/`、`rules/`、`source/` 三个目录的 SQL 面。未 build、未启动服务、未改任何源码。

【事实】**运行库侧**（只读查询）：`product/data/legado.sqlite` 用 `sqlite3 -readonly`（`E:/Apps/DevTools/android-sdk/platform-tools/sqlite3.exe`）仅查询 `sqlite_master`、`pragma user_version` 与 `count(*)`。**未执行任何写操作，未读取任何书目/笔记/正文内容字段**（只取计数与 schema）。按 `AGENTS.md` §0，`product/data/**` 属禁读区；本轮越过禁读区**仅限任务显式授权的 `sqlite3 -readonly` 与 `ls -la`**，除此之外未 `cat`/未 `grep` 用户数据。

【事实】**读法纪律**：单次读取 ≤120 行；`db/Schema.kt`(202) 分 3 段、`db/Migration.kt`(261) 分 3 段、`Database.kt`(249) 只读核心窗口 `:96-190` 并对其余用 `grep -n`；DAO 一律"类注释 + `grep -n "fun "` 签名清单"，不读实现体（唯一例外是 `ReadingDao.kt:12-51`，因为 §4.1 需要一个完整写入函数的证据）。

【推断】这份报告的核心发现不是"21 张表长什么样"，而是**源码声称的 21 张表与实库的 22 张表不一致**（§1.1）、**阅读进度有 3 张表 5 条写入/删除路径且实测已产生孤儿行**（§4.1）、**两套互不兼容的事务机制并存且已发生过一次真实事故**（§4.3 / §7 P0-1）。

---

## 1. 全表清单

【事实】建表 DDL **主要**集中在 `db/Schema.kt` 的**单个** `executeUpdate("""...""")` 大语句块内（`db/Schema.kt:18-194`），全部为 `create table if not exists`，无一处 `alter`。表数量核对：源码里 **21 张**，与任务给定数字一致。

【事实】**但实库里有 22 张用户表。** 只读查询 `sqlite_master` 的结果（`product/data/legado.sqlite`）：
- 用户表 **22** 张 = 源码 21 张 + **`book_mark`**；
- 另有 SQLite 内部表 3 张：`sqlite_sequence`、`sqlite_stat1`、`sqlite_stat4`（后者证明 `pragma optimize` 跑过，见 `db/Migration.kt:49`）；
- `pragma user_version` = **1**（与 `SchemaVersion.TARGET = 1` 吻合，§3.1）。

【事实】`book_mark` 的完整 ddl（来自 `sqlite_master`）：
```sql
CREATE TABLE book_mark (
  id integer primary key autoincrement,
  book_key text not null, source_id text not null, book_url text not null,
  book_name text not null, book_author text,
  chapter_index integer not null, chapter_title text not null,
  paragraph_from integer not null, paragraph_to integer not null,
  quote text not null, note text not null default '', created_at integer not null
)
CREATE INDEX book_mark_key_idx on book_mark(book_key, created_at desc)
```
【事实】`book_mark` / `book_mark_key_idx` / `idx_source_updated_at` 三个名字在**当前 Kotlin 源码里一次都没出现**（`grep -rn "book_mark\|book_mark_key_idx\|idx_source_updated_at" --include=*.kt` 全仓返回空）。
【事实】`select count(*) from book_mark` = **1**（有一行真实数据）。

【推断】结论（这是本次审计最有价值的单条发现）：**schema 演进只会 `create ... if not exists`、从不删废弃对象**，于是旧版本的 `book_mark` 表连同它的 1 行用户数据成了**永久孤儿**——当前代码读的是 `book_note.bookmark`（`db/Schema.kt:172`），所以这 1 行书签/笔记用户**永远看不到、也永远不会被迁移**。详见 §7 P1-4。

### 1.1 21 张表（源码口径）

| # | 表名 | 用途（一句话） | 证据 |
|---|------|---------------|------|
| 1 | `source` | 书源本体，规则 JSON 存在 `payload` 单列里 | `db/Schema.kt:19-25` |
| 2 | `app_meta` | 键值表；源码只声明 `source_revision`（书源变更计数），实库另有 2 个运行时缓存键（§2.8） | `db/Schema.kt:29-32` |
| 3 | `reading_progress` | 阅读进度（按 源+书 唯一，记 chapter_url/index） | `db/Schema.kt:44-48` |
| 4 | `cover_cache` | 封面缓存索引（cache_key → content_type，图片本体在文件系统） | `db/Schema.kt:50-52` |
| 5 | `book_shelf` | 书架条目，含 `last_read_at`（与 #3 重叠的第二个"进度"权威） | `db/Schema.kt:54-60` |
| 6 | `book_shelf_tombstone` | 用户删书墓碑，防止备份"合并导入"把删掉的书复活 | `db/Schema.kt:65-68` |
| 7 | `book_group` | 书架分组 | `db/Schema.kt:70-72` |
| 8 | `book_content_cache` | 正文缓存（按 源+书+章） | `db/Schema.kt:74-79` |
| 9 | `book_content_process` | 正文后处理缓存（按 kind 分类型存 original/processed） | `db/Schema.kt:82-86` |
| 10 | `book_cache_status` | 整本缓存任务的聚合状态（总章数/已缓存/state） | `db/Schema.kt:88-93` |
| 11 | `source_subscription` | 书源订阅 URL 列表及拉取状态 | `db/Schema.kt:95-100` |
| 12 | `rss_source` | RSS 源（payload 单列存规则） | `db/Schema.kt:103-106` |
| 13 | `book_toc_cache` | 目录缓存（chapters_json 整段 JSON） | `db/Schema.kt:109-112` |
| 14 | `source_login_state` | 书源登录态：login_info/header/变量/KV/cookie_jar 五列 | `db/Schema.kt:114-122` |
| 15 | `cookie` | 通用 Cookie 罐（按 url 唯一） | `db/Schema.kt:124-128` |
| 16 | `replace_rule` | 替换净化规则 | `db/Schema.kt:130-146` |
| 17 | `log_entry` | 运行日志 | `db/Schema.kt:150-154` |
| 18 | `reading_log` | 阅读时长统计（按 天+源+书） | `db/Schema.kt:158-163` |
| 19 | `book_note` | 笔记/书签共用表（`bookmark` 标志位区分） | `db/Schema.kt:166-174` |
| 20 | `source_health` | 书源体检结果（ok/latency/status_category） | `db/Schema.kt:177-185` |
| 21 | `script_cache` | JS 脚本求值缓存（带 deadline 过期） | `db/Schema.kt:188-192` |

补充【事实】：建表后立刻**无条件 drop 两张旧表**——`app_user` 与 `session`（`db/Schema.kt:196-199`），注释说明"这台服务不设身份"。【推断】意味着 v1 的账号体系数据在首次启动新版即被删除且不可恢复；虽注释称"死重量"，但这是全库唯一一处**主动 DROP 用户表**的路径，重建时若仍要保留多用户能力需重新设计。

### 1.2 索引（14）

| # | 索引名 | 覆盖列 | 证据 |
|---|--------|--------|------|
| 1 | `source_name_idx` | `source(name)` | `db/Schema.kt:26` |
| 2 | `idx_source_name_nocase` | `source(name collate nocase)` | `db/Schema.kt:27` |
| 3 | `book_shelf_last_read_idx` | `book_shelf(last_read_at desc)` | `db/Schema.kt:61` |
| 4 | `book_content_cache_book_idx` | `book_content_cache(source_id, book_url)` | `db/Schema.kt:80` |
| 5 | `source_subscription_enabled_idx` | `source_subscription(enabled)` | `db/Schema.kt:101` |
| 6 | `rss_source_group_idx` | `rss_source(source_group)` | `db/Schema.kt:107` |
| 7 | `idx_replace_rule_enabled` | `replace_rule(is_enabled, sort_order asc)` | `db/Schema.kt:147` |
| 8 | `idx_replace_rule_group` | `replace_rule(group_name)` | `db/Schema.kt:148` |
| 9 | `idx_log_entry_ts` | `log_entry(ts desc)` | `db/Schema.kt:155` |
| 10 | `idx_log_entry_category` | `log_entry(category)` | `db/Schema.kt:156` |
| 11 | `idx_reading_log_day` | `reading_log(day desc)` | `db/Schema.kt:164` |
| 12 | `idx_book_note_book` | `book_note(source_id, book_url, chapter_index)` | `db/Schema.kt:175` |
| 13 | `idx_source_health_rank` | `source_health(ok desc, latency_ms asc)` | `db/Schema.kt:186` |
| 14 | `idx_script_cache_deadline` | `script_cache(deadline)` | `db/Schema.kt:193` |

【事实】数量核对 = **14**，与任务给定一致。

【事实】**但实库有 16 个非自动索引**（`sqlite_master` 里 `name not like 'sqlite_autoindex%'` 共 16 条）+ 18 个 `sqlite_autoindex_*`（主键/唯一约束自动生成），合计 34 —— 与 `select count(*) ... type='index'` = 34 吻合。

实库多出的 **2 个**索引都不在源码里：
- `book_mark_key_idx on book_mark(book_key, created_at desc)` —— 随废止表 `book_mark` 一起遗留（§1 前言）。
- `idx_source_updated_at on source(updated_at)` —— **独立遗留物**：表的其他索引都在 `db/Schema.kt` 里成对出现，唯独这一个是历史版本建的、源码已不再声明。【推断】它说明"按 `source.updated_at` 增量拉取书源"曾是设计的一部分，后来改成了 `app_meta.source_revision` 计数器（`db/Schema.kt:34-42`），但旧索引没清。

【推断】索引缺口（重建时要补的）：
- 表 1/2 重名冗余：`source_name_idx`（大小写敏感）与 `idx_source_name_nocase` 覆盖同一列，前者基本冗余。
- `book_shelf_tombstone` 无任何索引、`reading_progress` 无 `updated_at` 索引、`book_note` 无 `chapter_url` 索引 —— 但都靠主键前缀覆盖，实际影响有限。
- **真正缺口**：`reading_progress` 只有 `(source_id, book_url)` 主键，没有 `updated_at` 索引；"最近在读"若走该表排序会全表扫。

### 1.3 触发器（3）

| # | 名称 | 时机 | 动作 | 证据 |
|---|------|------|------|------|
| 1 | `source_revision_insert` | AFTER INSERT ON `source` | `app_meta['source_revision'] += 1` | `db/Schema.kt:34-36` |
| 2 | `source_revision_update` | AFTER UPDATE ON `source` | 同上 | `db/Schema.kt:37-39` |
| 3 | `source_revision_delete` | AFTER DELETE ON `source` | 同上 | `db/Schema.kt:40-42` |

覆盖列【推断】：三个触发器都是**行级、无 `when` 条件**，即 `source` 表任何写入（包括只改 `sort_order`、`has_rules` 这类无关列、甚至 `updated_at` 心跳）都会把全局 `source_revision` +1。见 §4.4 的隐式写风险。计数核对 = **3**，与任务给定一致。

---

## 2. 表结构详解

【事实】**关键前置结论：`db/Schema.kt` 的建表 SQL 不是完整形状。** 有 3 张表的部分列只存在于 `Migration.kt` 的 `alter` 里（见下表 ⚠ 标记）。`SchemaVersion.kt:91-92` 也明说了这个前提："`Schema.createTables` 已经跑过…这六段只补列、不建表"。所以**新建库 = 建表 + 立刻跑一遍补列**，两者缺一不可。【建议】重建时把 `Schema.kt` 收敛成唯一完整形状，`Migration.kt` 只服务于存量库。

所有类型为 SQLite 弱类型：`text` / `integer` / `real`。布尔一律 `integer`（0/1），时间戳一律 `integer` 毫秒。

### 2.1 书源域

**`source`**（主键 `id`）— `db/Schema.kt:19-25`
| 列 | 类型 | 约束 |
|---|---|---|
| `id` | text | primary key |
| `name` | text | not null |
| `source_url` | text | not null |
| `source_group` | text | 可空 |
| `enabled` | integer | not null |
| `is_js` | integer | not null |
| `payload` | text | not null（整个书源规则 JSON） |
| `version` | integer | not null |
| `updated_at` | integer | not null |
| `has_login` | integer | not null default 0 |
| `sort_order` | integer | 可空 |
| `has_rules` | integer | not null default 1 |

与迁移一致性【事实】：`has_login`/`sort_order`/`has_rules` 三列在建表 SQL 与 `Migration.kt:146/150/165` **两处都有**——`alter` 分支对新建库天然跳过（列已存在），无冲突但存在定义重复。

**`source_health`**（主键 `source_id`）— `db/Schema.kt:177-185`
`source_id` text PK · `name` text not null default '' · `ok` integer not null default 0 · `latency_ms` integer not null default 0 · `status_category` text not null default '' · `error` text · `checked_at` integer not null default 0

**`source_subscription`**（主键 `id` autoincrement，`url` unique）— `db/Schema.kt:95-100`
`id` integer PK autoincrement · `url` text not null **unique** · `enabled` integer not null · `created_at`/`updated_at` integer not null · `last_success_at`/`last_attempt_at` integer · `last_error` text · `last_imported` integer not null default 0 · `content_hash` text

### 2.2 书架域

**`book_shelf`**（主键 `(source_id, book_url)`）— `db/Schema.kt:54-60`
`source_id` text not null · `book_url` text not null · `name` text not null · `author` text · `toc_url` text not null · `cover_url` text · `cover_key` text · `last_read_at` integer not null · `completed` integer not null default 0 · `alternate_sources` text · `group_id` integer not null default 0
⚠ **差异**：`toc_rule` text、`sort_order` integer 两列**不在建表 SQL 里**，只由 `Migration.kt:133-134` 补；且 `sort_order` 两处都**无 not null/default**（可空、无排序基线）。

**`book_shelf_tombstone`**（主键 `(source_id, book_url)`）— `db/Schema.kt:65-68`
`source_id` text not null · `book_url` text not null · `deleted_at` integer not null
【事实】注释（`:63-64`）说明用途：备份导入是"合并"，合并不能盖掉"我已经删了它"这个决定；重新手动加回同一本书时由 `saveBookshelf`/`switchBookshelf` 清掉。

**`book_group`**（主键 `group_id`）— `db/Schema.kt:70-72`
`group_id` integer PK · `name` text not null · `sort_order` integer not null default 0 · `created_at` integer not null
【事实】`group_id` 是纯 `integer primary key`（非 autoincrement）；`book_shelf.group_id default 0` 与 `book_group` **无外键约束**。

### 2.3 阅读域

**`reading_progress`**（主键 `(source_id, book_url)`）— `db/Schema.kt:44-48`
`source_id` text not null · `book_url` text not null · `chapter_url` text not null · `chapter_index` integer not null · `updated_at` integer not null
⚠ **差异（最大）**：建表 SQL 只有上述 5 列。以下 **5 列全部只由迁移补**：
- `scroll_position` real not null default 0 — `Migration.kt:111`
- `char_offset` integer not null default 0 — `Migration.kt:114`
- `paragraph_anchor` text — `Migration.kt:117`
- `position_version` integer not null default 1 — `Migration.kt:120`
- `position_checksum` text — `Migration.kt:123`

**`book_note`**（主键 `id` autoincrement）— `db/Schema.kt:166-174`
`id` integer PK autoincrement · `source_id` text not null · `book_url` text not null · `book_name` text · `chapter_url` text · `chapter_index` integer not null default 0 · `start_offset` integer not null · `end_offset` integer not null · `excerpt` text not null · `note` text not null default '' · `bookmark` integer not null default 0 · `created_at`/`updated_at` integer not null
⚠ **差异**：`paragraph_anchor` text（`Migration.kt:196`）、`position_version` integer default 1（`:199`）、`position_checksum` text（`:202`）三列**不在建表 SQL 里**。
【事实】笔记与书签**共用一张表**，靠 `bookmark` 0/1 区分——这是 §4.1"多权威"的一处隐患来源。

**`reading_log`**（主键 `(day, source_id, book_url)`）— `db/Schema.kt:158-163`
`day` text not null · `source_id` text not null · `book_url` text not null · `book_name` text · `chapter_index` integer not null default 0 · `seconds` integer not null default 0 · `updated_at` integer not null
【事实】`book_name` 是**冗余快照列**（书改名后历史统计不跟随）。

### 2.4 缓存域

**`book_content_cache`**（主键 `(source_id, book_url, chapter_url)`）— `db/Schema.kt:74-79`
`source_id`/`book_url`/`chapter_url` text not null · `chapter_index` integer not null default 0 · `title` text · `content` text not null · `cached_at` integer not null
【事实】`chapter_index` 两处都有（建表已含，`Migration.kt:215` 仅补老库），无冲突。

**`book_content_process`**（主键 `(source_id, book_url, chapter_url, kind)`）— `db/Schema.kt:82-86`
`source_id`/`book_url`/`chapter_url` text not null · `kind` text not null · `original` text not null · `processed` text not null · `updated_at` integer not null

**`book_cache_status`**（主键 `(source_id, book_url)`）— `db/Schema.kt:88-93`
`source_id`/`book_url` text not null · `total_chapters`/`cached_chapters` integer not null default 0 · `state` text not null default 'idle' · `last_error` text · `updated_at` integer not null

**`book_toc_cache`**（主键 `(source_id, toc_url)`）— `db/Schema.kt:109-112`
`source_id`/`toc_url` text not null · `chapters_json` text not null（整段 JSON）· `updated_at` integer not null
【推断】注意主键是 `(source_id, toc_url)`，而 `book_cache_status`/`reading_progress` 主键是 `(source_id, book_url)`——**同一本书在不同表用不同标识体系**，换目录（toc_url 变）即产生孤儿缓存。见 §4.1。

**`cover_cache`**（主键 `cache_key`）— `db/Schema.kt:50-52`
`cache_key` text PK · `content_type` text not null
【事实】只存元数据，封面二进制在文件系统 `product/data/covers/`（该目录 3.4MB，只用 `ls -la` 确认存在）。

**`script_cache`**（主键 `(source_id, key)`）— `db/Schema.kt:188-192`
`source_id`/`key` text not null · `value` text not null · `deadline` integer not null default 0 · `updated_at` integer not null

### 2.5 RSS 与订阅

**`rss_source`**（主键 `source_url`）— `db/Schema.kt:103-106`
`source_url` text PK · `name` text not null · `source_group` text · `source_icon` text · `enabled` integer not null · `has_list_rule` integer not null · `payload` text not null · `updated_at` integer not null
订阅表见 §2.1 的 `source_subscription`（书源订阅与 RSS 源共用同一订阅机制【推断】，`http/SubscriptionsRoutes.kt` 74 行）。

### 2.6 凭据域

**`source_login_state`**（主键 `source_id`）— `db/Schema.kt:114-122`
`source_id` text PK · `login_info` text · `login_header` text · `source_variable` text · `source_kv` text · **`cookie_jar` text** · `updated_at` integer not null
⚠ **差异（语义冲突，不是缺列）**：`cookie_jar` 仍在建表 SQL 里，但 `Migration.migrateLegacyCookieJars` 会**主动清空它**（`Migration.kt:100`）并把内容折叠进 `cookie` 表 —— **这是一个建表有、迁移清、新代码不写的死列**。重建时应直接删掉。

**`cookie`**（主键 `url`）— `db/Schema.kt:124-128`
`url` text PK · `cookie` text not null · `updated_at` integer not null
【事实】`url` 实际存的是 `cookieBucket(host)` 归并后的桶键（见 `Migration.kt:79`），不是原始 URL。

### 2.7 规则域

**`replace_rule`**（主键 `id`）— `db/Schema.kt:130-146`
`id` text PK · `name` text not null · `group_name` text · `pattern` text not null · `replacement` text not null default '' · `is_regex` integer not null default 1 · `scope` text · `exclude_scope` text · `scope_title` integer not null default 0 · `scope_content` integer not null default 1 · `is_enabled` integer not null default 1 · `sort_order` integer not null default 0 · `timeout_ms` integer not null default 3000 · `created_at` integer not null · `updated_at` integer not null
【事实】无迁移补列，与 `Migration.kt` 无交互 —— 唯一"干净"的表。

### 2.8 系统域

**`app_meta`**（主键 `key`）— `db/Schema.kt:29-31`
`key` text PK · `value` text not null；建表时只 `insert or ignore … ('source_revision','0')`（`:32`）。
⚠ **差异（源码只声明 1 个键，实库有 3 个）**：`select key from app_meta` 实测 = `source_revision`、`cookie_mentions_json`、`cookie_mentions_revision`。
【推断】后两个键由 `CookieDao` 的"凭据桶被多少书源提到"缓存在运行时自建（对应 `data/Database.kt:225` 的 `cookieMentions.invalidate()`），**没有任何建表/建键 DDL 声明它们**。
【事实】**不存 schema 版本**（§3.1）——这条设计判断因此更有说服力：`app_meta` 实测已是"业务计数器 + 运行时缓存"混装表。
【建议】重建时把 `app_meta` 拆成 `schema_meta` / `runtime_cache` 两类，禁止业务键与缓存键混放。

**`log_entry`**（主键 `id` autoincrement）— `db/Schema.kt:150-154`
`id` integer PK autoincrement · `ts` integer not null · `category` text not null · `level` text not null · `message` text not null · `context` text · `stack_trace` text
【推断】无任何保留期/清理字段，只能按 `ts` 批量删（`LogDao.kt` 6.2KB）。这是表里唯一"无限增长"嫌疑表之一（另一个是 `book_content_cache`）。

---

## 3. 版本与迁移机制

### 3.1 版本号存放位置与当前值

【事实】版本号存放在 **`pragma user_version`**（SQLite 文件头字段），**不是** `app_meta` 表键。
- 设计理由（源码注释原话）：`app_meta` 会和业务键（`source_revision`）混在一张表里，"谁都可能把它清掉"；`user_version` 不会被任何 `delete from app_meta` 波及，`VACUUM` 也原样保留 —— `SchemaVersion.kt:16-18`。
- 读：`SchemaVersion.current()` → `pragma user_version` —— `SchemaVersion.kt:45-48`
- 写：`SchemaVersion.setCurrent()` → `pragma user_version = $version`（字符串模板拼整数）—— `SchemaVersion.kt:50-52`

【事实】当前值：
- `BASELINE = 1` —— `SchemaVersion.kt:30`
- `TARGET = BASELINE = 1` —— `SchemaVersion.kt:33`
- 结论：**当前 schema 版本 = 1**，且 v1 就是"建表 + 六段历史补列"的基线，此后**尚无任何真正的版本化迁移**（注册表只有一项，见 §3.2）。

【事实】`app_meta` 表只存业务键：`source_revision`（`db/Schema.kt:32`），schema 版本**不**在此表。

### 3.2 升级判定与执行顺序

【事实】启动链路（`Database.kt:163-178`）严格三段顺序：

```
write {                                  // Database.kt:163  单写连接 + 全局写锁
  1. Schema.createTables(db)             // :164  建表/索引/触发器 + drop app_user/session
  2. Migration.maybeSnapshot(db, path)   // :167  迁移前 VACUUM INTO 快照（必须在事务外）
  3. transaction { SchemaVersion.migrate(tx) }  // :170  版本化迁移，整段一笔事务
}
```

【事实】升级判定（`SchemaVersion.migrate`，`SchemaVersion.kt:63-85`）：
1. `version = current(db)`；`if (version > target)` → **抛 `IllegalStateException("数据库版本 $version 高于程序支持的 $target（程序被降级过？），拒绝启动以免写坏数据")`** —— `SchemaVersion.kt:69-74`。**有向上降级保护**，这是本项目少见的正面设计。
2. `while (version < target)`：取 `plan[version+1]`，取不到即抛"缺少 v$version → v$next 的迁移步骤" —— `:75-78`。
3. 执行 `step(db)`，**随后**才 `setCurrent(db, next)` —— `:79-81`。顺序正确：先动作、后抬版本号。
4. 注册表 `steps: Map<Int, (Connection) -> Unit>` 目前只有 `BASELINE to ::baseline` 一项 —— `SchemaVersion.kt:40-42`。

【事实】`baseline(db)`（`SchemaVersion.kt:94-101`）按固定顺序跑六段：
1. `Migration.migrateReadingProgress`（`:95`）
2. `Migration.migrateBookshelf`（`:96`）
3. `Migration.migrateSourceTable`（`:97`）
4. `Migration.migrateLegacyCookieJars`（`:98`）
5. `Migration.migrateBookNote`（`:99`）
6. `Migration.migrateBookContentCache`（`:100`）

### 3.3 逐次迁移清单（版本 → 动作 → 可逆性 → 数据风险）

> 【事实】**这里没有"版本 → 版本"的演进史，只有一次 v0 → v1 基线**。`Migration.kt` 里根本没有版本号概念，六个函数是"看列在不在再补"的**无版本幂等补丁**。下表按 v1 内部的六段拆开列出，因为它们的数据风险差异很大。

| 序 | 迁移（v0→v1 内的一段） | 做了什么 | 证据 | 可逆性 | 数据风险 |
|---|----------------------|---------|------|--------|---------|
| 1 | `migrateReadingProgress` | 给 `reading_progress` 补 5 列：`scroll_position real`、`char_offset int`、`paragraph_anchor text`、`position_version int default 1`、`position_checksum text` | `Migration.kt:104-125`（各 `alter` 在 111/114/117/120/123） | 逻辑可逆（列可留），**但回退代码后新列数据被旧代码忽略** | 低。纯加列带默认值，存量行位置默认 0；【推断】老库用户首次启动后阅读位置显示为开头，需靠 `position_checksum` 兜底 |
| 2 | `migrateBookshelf` | 给 `book_shelf` 补 `completed`、`alternate_sources`、`group_id`、`toc_rule`、`sort_order` | `Migration.kt:128-135`（各 `alter` 在 130-134） | 加列可逆 | 低-中。【推断】`group_id default 0` 意味着老库所有书落到"未分组"，用户自定义分组需另表 `book_group`（`db/Schema.kt:70-72`）配合 |
| 3 | `migrateSourceTable` | 补 `has_login`、`sort_order`、`has_rules`；**并用 `payload like '%"loginUi"%' …` 全表 UPDATE 回填 `has_login`**；再逐行读 `payload` 调 `SourceCodec.hasRules` 批量回填 `has_rules` | `Migration.kt:138-181`（`has_login` alter 146，LIKE 回填 **156**，`has_rules` alter 165，逐行回填 166-179） | 数据可重算，但 `has_rules` 回填**只在加列那一次执行**（`if ("has_rules" !in columns)` 包住，`:164`） | **中**。全表 UPDATE 扫描所有 `source.payload`（注释实测 5,600 行约 0.1 秒，`:162`），期间单写连接被独占。详见 §3.5 的 LIKE 转义坑 |
| 4 | `migrateLegacyCookieJars` | 把 `source_login_state.cookie_jar`（JSON 按 host 分桶）**折叠**进全局 `cookie` 表（`on conflict(url) do update`），然后 **`update source_login_state set cookie_jar = null`** | `Migration.kt:67-101`（读 68-72，按 `cookieBucket(host)` 归并 79-85，upsert 87-98，**清空源列 100**） | **不可逆**：第 100 行把源数据抹成 null，折叠结果只留在 `cookie` 表 | **高（迁移环节最高）**。风险点见 §3.5 |
| 5 | `migrateBookNote` | 给 `book_note` 补 `bookmark`、`paragraph_anchor`、`position_version`、`position_checksum` | `Migration.kt:184-204`（alter 在 192/196/199/202） | 加列可逆 | 低。`bookmark default 0` 把老笔记全部视为"非书签" |
| 6 | `migrateBookContentCache` | 先补 `chapter_index`，再**对缓存里每一本书**读目录重建 `chapter_url → index` 映射，逐章 `update` 回填 | `Migration.kt:207-256`（alter 215，按书遍历 230-253，批量提交 254） | 数据可重算（源目录在则能重建），**但目录已失效的书永远补不上，停留在 index=0** | **中-高（最慢的一段）**。嵌套双层循环 + 每本书再查一次 `book_content_cache`，全在基线那一笔事务里，大库首次升级会长时间持锁 |

补充【事实】：`Migration.kt` 顶部注释自述职责为"旧库缺列补列、旧表折叠（cookie_jar → cookie）、VACUUM 碎片回收"（`Migration.kt:17`）—— 印证它**本来就不是版本化迁移**，`SchemaVersion` 是后来（P0-3）包在外面的壳。

### 3.4 幂等性与失败回滚

【事实】幂等性：
- 机制层：`migrate()` 靠 `user_version` 跳过已完成步骤（`SchemaVersion.kt:75`），且版本号与动作同事务（`:80-81`），所以**整体是幂等的**。
- 步骤层：六段补列全部先查 `pragma table_info(<table>)` 取列名集合再决定是否 `alter`（`Migration.kt:106/129/140/186/209`），**自身也幂等**，重复跑不炸。
- 例外：`migrateBookContentCache` 用 `if ("chapter_index" in columns) return` **整段短路**（`Migration.kt:213`）——一旦列存在就永不回填。若某次回填中途失败（事务回滚则列也不存在，尚可；但若被单独调用且提交过），【推断】会永久留下 `chapter_index = 0` 的缓存行，无自愈路径。

【事实】失败回滚：
- `Database.initialize()` 把 `SchemaVersion.migrate` 包在 `transaction {}` 内（`Database.kt:170`），catch 后转抛 `IllegalStateException("数据库迁移失败（停在 v$…，已回滚到迁移前状态，可修复后重试）")`（`:171-177`）。
- `transaction {}` 在异常时 `db.rollback()`（`Database.kt:154`），并把 `autoCommit = true` 复位（`:158`）。
- 结论：**迁移失败会回滚 + 拒绝启动**（"禁止带病运行"，`SchemaVersion.kt:21-22`）。SQLite 的 `alter table` 与 `pragma user_version` 都参与事务，因此快照语义成立。

【事实】**但有两处不在这笔事务里**，是回滚的盲区：
1. `Schema.createTables(db)` 在 `transaction{}` **之前**、且 `write{}` 内无显式事务（`Database.kt:163-164`）—— 默认 `autoCommit=true` 下逐条提交。其中含 **`drop table if exists app_user` / `drop table if exists session`**（`db/Schema.kt:198-199`）。**这两张表在快照之前就被删掉且不可回滚**。
2. `Migration.maybeSnapshot` 排在 `createTables` **之后**（`Database.kt:167`），因此在快照里 `app_user`/`session` **已经不存在**。注释说"迁移前的原样快照"（`:165-166`），严格说只对"版本化迁移"成立，对"建表期的 DROP"不成立。

【推断】综合两条 = **升级前的备份不覆盖 `app_user`/`session` 的丢失**。若重建后仍需要多用户/会话数据，必须把快照挪到 `createTables` 之前（【建议】见 §7 P1-1）。

### 3.5 迁移机制总评（一句话）

【推断】**机制骨架是对的（`user_version` + 有序注册表 + 同事务 + 降级保护 + 失败拒启动），但目前只有 v1 一个基线版本，等于"刚把锚点装好、还没开始用它"；真正的风险不在版本机制，而在六段基线补丁里的两处不可逆写（清空 `cookie_jar`、DROP `app_user`/`session`）。**

【事实】最危险的三处迁移（详见 §7）：
1. `Migration.kt:100` —— `update source_login_state set cookie_jar = null`：折叠后**主动抹源数据**，不可逆。
2. `db/Schema.kt:198-199` —— 启动即 `drop table app_user / session`，且在自动提交区、在快照之前。
3. `Migration.kt:156` —— 依赖 `like '%"loginUi"%'` 的转义正确性做全表回填；注释（`:153-155`）明说"老写法一个都匹配不上，等于这条回填从来没生效过"，说明该类 bug 曾真实发生过。

---

## 4. 一致性与事务

### 4.1 多权威数据源：阅读进度

【事实】"读到哪了"这一个业务概念，库里有 **3 张表 + 5 条写入/删除路径**：

| # | 载体 | 存什么 | 写入点 | 证据 |
|---|------|--------|--------|------|
| A | `reading_progress` | **权威位置**：`chapter_url` + `chapter_index` + `scroll_position` + `char_offset` + `paragraph_anchor` + `position_version` + `position_checksum` | `ReadingDao.saveProgress`（upsert） | `data/ReadingDao.kt:36-41`（显式位置分支）、`:21-25`+`:28-32`（旧客户端分支） |
| B | `book_shelf.last_read_at` | **只存时间戳**，不存位置 | 与 A **同一个函数**内、A 之后再写一条 | `data/ReadingDao.kt:43-45` |
| C | `reading_log` | 按 `(day, source_id, book_url)` 累计 `seconds` 与 `chapter_index` | `ReadingDao.addReadingLog` | `data/ReadingDao.kt:58-75`（`chapter_index = max(...)` 在 `:65`） |
| D | `reading_progress`（第二个写者） | 只改 `chapter_index`（目录变短时钳位） | `ShelfDao.clampShelfProgress` | `data/ShelfDao.kt:77-78` |
| E | `reading_progress`（三个删除者） | 删进度行 | `removeBookshelf` / `batchRemoveBookshelf` / `switchBookshelf` | `data/ShelfDao.kt:241`、`:265`、`:335` |

【事实】HTTP 层入口只有一个：`http/ReadersRoutes.kt:40` 调用 `repo.saveProgress(progress)`，`:54` 调用 `repo.addReadingLog(entry)`。即 **A/B 的写入在路由层是同一次请求触发的两次独立 DAO 调用**。

【事实】**实测证据（只读计数，未读内容）**——生产库 `legado.sqlite` 当前：

| 表 | 行数 |
|---|---|
| `source` | 5,601（印证 `Migration.kt:162` 注释里的"5,600 行实测"） |
| `book_shelf` | **1** |
| `reading_progress` | **5** |
| `book_note` | **0** |
| `book_mark`（源码已废止的表） | **1** |
| `book_shelf_tombstone` | 130 |
| `book_toc_cache` | 525 |
| `book_content_cache` | 724 |
| `replace_rule` | 288 |
| `cookie` | 616 |
| `reading_log` | 124 |
| `log_entry` | 5,000（跨 2 个自然日 ⇒ 存在 5000 条上限，否则密度不合理） |

对账查询结果：
- `reading_progress` 中**没有对应 `book_shelf` 行**的 = **4 / 5**；
- `reading_progress` 中 **`source_id` 在 `source` 表已不存在**的 = **3 / 5**。

【推断】这三条数字把 §4.1 从"理论上的多权威"变成**已经发生的漂移**：
1. 进度行比书架行多 4 倍 ⇒ 删书路径（E：`ShelfDao.kt:241/265/335`）**并未覆盖所有进度行**。删书事务只删 `(source_id, book_url)` 精确匹配的那一行；而 `reading_progress` 存在其它来源渠道（如换源 `switchBookshelf` 在 `:335` 删旧行、`clampShelfProgress` 在 `:78` 只改不删）。
2. 3 条进度指向已删除书源 ⇒ **无外键、无级联**，删源（`SourcesDao`）不会清理进度。这些行永远读不到，也永远不清。
3. `book_note = 0` 而 `book_mark = 1` ⇒ 用户唯一的那条笔记/书签躺在**废止表**里（§1 前言 / §7 P1-4）。
4. `book_shelf_tombstone = 130` 而 `book_shelf = 1` ⇒ 墓碑远多于在架书，说明"删过又合并导入"是常规路径，**墓碑表是备份合并正确性的关键依赖**，绝不能当垃圾表清掉。

【事实】读取侧把两处来源"缝合"起来：
- `ShelfDao.SHELF_SELECT`（`data/ShelfDao.kt:21`）用 `left join reading_progress p` 取 `chapter_index`/`scroll_position`，同时**另取** `s.last_read_at`。
- 备份导出侧注释明确写了口径："进度不在 `book_shelf` 里（在 `reading_progress`）、分组在 `book_shelf.group_id`… 没有进度行时三个进度字段取 0，`readAt` 退回书架自己的 `last_read_at`" —— `data/ShelfDao.kt:136-137`，实现见 `:142-149`（`coalesce(p.updated_at, s.last_read_at)` 在 `:146`）。

【推断】风险结论：
1. **A 与 B 非原子**（见 §4.2）。若进程在 `ReadingDao.kt:41` 与 `:43` 之间崩溃，`reading_progress` 已更新但 `last_read_at` 未更新 → 书架按 `last_read_at desc` 排序（`data/ShelfDao.kt:60`）会把刚读的书排到后面。**不丢数据，但用户可见的顺序错乱**。
2. **位置有三套坐标并存**：`scroll_position`（旧，百分比/像素）、`char_offset`+`paragraph_anchor`（逻辑位置，`position_version`、`position_checksum` 校验）。`ReadingDao.kt:18-33` 的分支逻辑说明"旧客户端只提交前一套、新客户端提交整组"——**同一行里两套坐标可能不一致**，读取方必须知道哪一套可信。【建议】重建时用显式的 `positionVersion` 判别，甚至把旧坐标列为派生值。
3. **`reading_log` 是第三本账**，`chapter_index` 取 `max()` 单调不减（`:65`）：用户回翻旧章时，日志里的"读到哪里"与 A 会**故意不一致**（历史最大值 vs 当前位置）。这不是 bug，但统计页与继续阅读页会显示不同章号。
4. **不同表用不同主键标识同一本书**：`reading_progress`/`book_shelf`/`book_cache_status` 用 `(source_id, book_url)`；`book_toc_cache` 用 `(source_id, toc_url)`（`db/Schema.kt:111`）。换源/换目录后 `toc_url` 变而 `book_url` 不变 → 目录缓存成孤儿。【推断】需要一条清理路径（未在本次读取范围内确认是否存在）。

### 4.2 多表写与事务边界

【事实】`write {}` **不碰 `autoCommit`**（`Database.kt:112-114` 只有 `pool.useWrite(block)`；`db/ConnectionPool.kt:70-75` 也是纯加锁 + 复用连接，全文无 `autoCommit` 出现）。因此 `write {}` 内的每条语句**各自自动提交**。真正的事务入口是 `Database.transaction {}`（`Database.kt:138-160`）。

【事实】反例（写多表却**没有**外层 `transaction {}`）：
- **`ReadingDao.saveProgress`**（`data/ReadingDao.kt:15-47`）—— 写 `reading_progress`（21/28/36）**再**写 `book_shelf`（43），全程无 `transaction {}`、无 `autoCommit=false` ⇒ **2~3 条独立提交**。这是最典型的多表非原子写。
- **`ReadingDao.addNote` / `updateNote` / `deleteNote`**（`:90`/`:118`/`:124`）—— 单表，无问题。

【事实】正例（自己管 `autoCommit` 的老函数，均已配对 `rollback` + `finally autoCommit=true`）：
`ShelfDao.saveBookshelf`（`:25` 开 / `:36` 收）、`updateBookshelfInfo`（`:186` / `:230`）、`removeBookshelf`（`:235` / `:250`）、`batchRemoveBookshelf`（`:255` / `:287`）、`batchUpdateBookshelfGroup`（`:294` / `:311`）、`switchBookshelf`（`:318` / `:351`）。删书路径把 `book_shelf` + `reading_progress` + 墓碑写在同一个手动事务里——**删书这一侧是原子的，读进度那一侧不是**，这个不对称是历史成因。

【建议】重建时统一：要么全面 `transaction {}`、要么全面 `write{}`，禁止"手动 autoCommit"的第三种形态。

### 4.3 单写连接约束与 `write{}` 嵌套

【事实】池里**只有一个写连接**：`ConnectionPool` 持 `private var _writeConnection`（`db/ConnectionPool.kt:22`）+ `ReentrantLock writeLock`（`:19`），`useWrite` 全程持锁（`:70-75`）。

【事实】源码里的明确禁令（两处互相印证）：
- `data/Database.kt:122-136` —— `transaction {}` 的注释："库里**有六七个函数自己写** `autoCommit = false … commit() … autoCommit = true`（六个备份导入步骤都是这个形状）。把它们串成一个整批事务时，直接在外面套一层 `write { autoCommit = false }` 会**静默失效** —— 第一个内层函数在 `finally` 里把 `autoCommit` 复位成 true，外层事务当场被提交掉；**0.2.35 的批量删书事故就是这条**。"
- `data/Database.kt:134-136` —— "**不要调用仍然自己管 `autoCommit` 的 DAO**（`ShelfDao` / `CacheDao` 里的老函数），它们会把外层事务提交掉。"
- `data/BookshelfRepository.kt:114-115` —— "**不要在外面再包一层 `database.write { autoCommit = false … }`**。池里只有一条写连接，`removeBookshelf` 自己就是一个 `write {}`，它退出时会把…"

【事实】`transaction {}` 用 `ThreadLocal` 记嵌套深度（`Database.kt:120`），内层用 `SAVEPOINT legado_tx_$depth`（`:144`），只有最外层 `commit`/`rollback`（`:150`/`:154`）。

【推断】这意味着系统里同时存在**两套互不兼容的事务机制**：
1. 新的 `transaction {}`（SAVEPOINT 可嵌套，安全）；
2. 老的"函数内手动 `autoCommit=false`"（**不可嵌套，会把外层提交掉**）。
只要有人在 `transaction {}` 里调用一次 `ShelfDao.removeBookshelf`，**外层事务就被静默提交**，rollback 失效 → 批量操作的"部分成功"变"部分永久落盘"。**这是全报告里最容易演变成数据事故的结构性缺陷。**

【事实】`writeAll` 类操作（`batchRemoveBookshelf` 等）目前**没有被外层包过**（`data/BookshelfRepository.kt` 只有 2 处 `write`，且注释就在警告不要包），所以当下是安全的；风险在于**未来调用方**。

### 4.4 触发器带来的隐式写

【事实】`source` 表上三个行级触发器，任何 insert/update/delete 都会执行 `update app_meta set value = cast(cast(value as integer) + 1 as text) where key = 'source_revision'`（`db/Schema.kt:34-42`）。

【事实】读取侧：`Database.sourceRevision()` 读该值（`data/Database.kt:214-219`），配套 `invalidateSourceCaches()` 清内存缓存（`:221-226`，清 `sourceSummariesCache`/`exploreSourcesCache`/`cookieMentions`）。

【推断】四个后果：
1. **隐式写放大**：`source` 的每次写入都额外写一次 `app_meta`，且**无 `when` 条件** —— 只改 `sort_order`、`enabled`、甚至 `updated_at` 心跳，也会让全局 `source_revision` +1，导致所有客户端的书源缓存失效。批量导入 5,600 条书源 ⇒ 5,600 次触发器写（不算致命，但每次都在写事务里）。
2. **`app_meta` 因此不可"只读"**：任何对 `source` 的写都必须持有写连接，已由单写连接天然满足。
3. **触发器与事务同生共死**：回滚则计数器一并回滚，不会漂移 —— 这点是安全的。
4. **脆弱点**：`source_revision` 的初值靠 `insert or ignore … ('source_revision','0')`（`db/Schema.kt:32`）。若有人 `delete from app_meta`，则触发器 `update` 命中 0 行 → 计数器**永久停在"缺失"**，`sourceRevision()` 返回 0（`Database.kt:217` 的 `?: 0L`），缓存失效机制静默失效。【事实】没有 `insert or ignore` 的守卫触发器。【建议】改用 `insert … on conflict do update` 的 upsert 触发器，或在 `sourceRevision()` 缺失时自愈重建。

---

## 5. 访问层与注入

### 5.1 绕过 DAO 的直连 SQL

【事实】先给结论：**`http/`、`rules/`、`source/` 三个目录里一条 SQL 都没有**。
`grep -rn "executeQuery\|prepareStatement" http/ rules/ source/` 返回空（exit 1，无匹配）；扩到 `createStatement` 后全仓扫描，含裸 SQL 的文件**全部落在 `data/`（19 个文件）**：
`BookshelfRepository · CacheDao · CookieDao · Database · DbSnapshot · ImportDao · LogDao · LoginDao · ReadingDao · ReplaceRuleDao · RssDao · SchemaVersion · ScriptCacheDao · ShelfDao · SourceHealthDao · SourcesDao · SubscriptionDao · db/ConnectionPool · db/Migration · db/Schema`。

【推断】这是本项目**最健康的一条架构事实**：数据访问被物理收敛在 `io.legado.data` 包内，路由层只调用 DAO 扩展函数（如 `http/ReadersRoutes.kt:40` `repo.saveProgress(...)`）。重建时应把这条边界写成测试（类似已有的 `ArchitectureBoundaryTest`）而不是靠自觉。

【事实】下面 6 条是"在 `data/` 内部、绕过 DAO 抽象直接手写 SQL"的实例（按风险排序）：

| # | 位置 | SQL 形态 | 评估 |
|---|------|---------|------|
| 1 | `data/DbSnapshot.kt:129` | `execute("VACUUM INTO '$literal'")` | **字符串拼接**（SQLite 的 `VACUUM INTO` 不支持绑定参数）。源码注释 `:127` 自己写明"目标文件名是字面量、不支持绑定参数，**单引号必须成对转义**"。文件名由内部时间戳生成，不接用户输入 ⇒ 实际不可注入，但**这是全库唯一必须靠手工转义的地方**。 |
| 2 | `data/SchemaVersion.kt:51` | `execute("pragma user_version = $version")` | 字符串拼接，变量是 `Int` ⇒ 无注入面。但 `:47` 的读取与 `:51` 的写入不对称（一读一写都是裸 JDBC），没有被 `connect`/`write` 之外的事务语义保护，靠调用方保证。 |
| 3 | `data/db/Migration.kt:106 / 129 / 140 / 186 / 209` | `executeQuery("pragma table_info(<表名>)")` | 表名是字面量常量，无参数化需求。但**首次启动路径上有 5 处裸 Statement**（`reclaimFreePages` 里还有 `:36/:39/:48/:49/:52` 的 `pragma page_count`、`freelist_count`、`VACUUM`、`pragma optimize` 共 5 处）——启动期总共约 10 处裸 SQL。 |
| 4 | `data/ShelfDao.kt:21` | 常量 `SHELF_SELECT` 大段 SQL（8 个 join / 子查询） | 常量前缀 + 常量后缀拼接（`:60/:67/:423`、`BookshelfRepository.kt:518/:529`），**无用户输入参与拼装**。风险不在注入，而在**一个字符串被 5 处复用**：改列顺序会让 5 个调用点的 `rs.getString(n)` 序号集体错位（`toShelf()` 在 `:392`）。【建议】重建时用具名取列或 `ResultSet` 映射器。 |
| 5 | `data/SubscriptionDao.kt:13` | `"select * from source_subscription" + (if (enabledOnly) " where enabled=1" else "") + " order by id"` | 条件拼接，片段均为常量、布尔驱动 ⇒ 无注入面。但 `select *` + 位置取值是同类脆弱模式。 |
| 6 | `data/RssDao.kt:16-17` | `val like = "%${query.replace("%","").replace("_","")}%"` → `setString(1..3, like)` | **正面例子**：用户输入经 `replace` 剥掉 LIKE 通配符后**用 `?` 绑定**。这是本节唯一看到主动做输入净化的地方。 |

### 5.2 字符串拼接进 SQL

【事实】全 `data/` 精确统计：**只有 2 处 `$` 模板插值进 SQL 语句**（`DbSnapshot.kt:129`、`SchemaVersion.kt:51`），**另有 2 处常量 `+` 拼接**（`ShelfDao.kt:21` 的 `SHELF_SELECT` 复用族、`SubscriptionDao.kt:13`）。**用户输入零处直接进 SQL 字符串**。

【事实】已发生过一次 LIKE 通配符真实事故，代码里留了墓碑注释：
> "用 `instr` 而不是 `like '%x%'`：`bookUrl` 里的 `%`/`_` 会被 LIKE 当通配符，**删一本书会连带删掉别的书的目录缓存**。" —— `data/ShelfDao.kt:245`

【推断】这条注释是 §7 里 P1-5 的直接证据：**LIKE 通配符曾导致跨书误删缓存**。修复方式是改用 `instr`。同类风险点仍需逐条确认（`RssDao` 采取的是"剥字符"，`SourcesDao.kt:253` 用 `like ('% ' || ? || ' %')` 且参数绑定，均安全）。

【建议】重建时把"用户输入只能通过 `?` 绑定、且 LIKE 场景必须对 `%`/`_`/`\` 做 `escape` 子句处理"写成 lint 规则，而不是靠注释警告。

---

## 6. 备份与恢复路径

【事实】备份/恢复其实是**两套互不相干的机制**，此前常被混为一谈：

| 机制 | 类 | 产物 | 时机 | 粒度 |
|------|----|------|------|------|
| **A. 内容导出/导入** | `backup/BackupExporter.kt`(217 行) · `backup/BackupImporter.kt`(567 行) · `backup/BackupStore.kt`(124 行) · `backup/LegacyBackup.kt`(268 行) | `.zip` 或 `.json`（分域 `bookSource.json` / `replaceRule.json` / `bookshelf.json` / `bookGroup.json` / `rssSource.json` / `cookie.json` + 个性化条目） | 用户主动触发 | **逻辑内容**（不含 `reading_progress` 之外的运行态、不含日志/体检/缓存） |
| **B. 文件级快照** | `data/DbSnapshot.kt`(200 行) | `backups/<时间戳>` 单文件 + `.sha256` sidecar | **每次启动**（节流） | **整个 SQLite 库** |

### 6.1 是否直接拷 db 文件

【事实】**A 不拷 db 文件**，只做内容导出。`BackupExporter` 的公开面全是"按域导出"：
`exportSources`(`:57`) · `exportRssSources`(`:66`) · `exportBookshelf`(`:77`) · `exportReplaceRules`(`:168`) · `exportBookGroups`(`:196`) · `exportAll`(`:209`)。

【事实】**B 才是文件级备份，而且刻意不裸拷**。源码注释（`data/DbSnapshot.kt:27-30`）：
> "为什么用 `VACUUM INTO` 而不是直接复制 `.db`：WAL 模式下尚未合并的 `-wal` 段不在 `.db` 文件里，**裸拷文件可能拿到"半提交"的状态**（恢复时 `database disk image is malformed`）。`VACUUM INTO` 走 SQLite 自带的在线备份语义，产出**已合并、自包含**的单文件快照。"

【事实】该风险在真实数据目录里可见：`product/data/legado.sqlite-wal` 当前 **4,087,072 字节**（≈4MB，未 checkpoint 进主库）、`legado.sqlite` 70,635,520 字节 —— 即裸拷 `.db` 会丢掉近 4MB 最新写入。（仅 `ls -la` 观察，未打开文件。）

【事实】**域覆盖不对齐（重要）**：

| 域 | 能导出 | 能导入 |
|---|---|---|
| 书源 `bookSource.json` | ✅ `BackupExporter.kt:211` | ✅ |
| 替换规则 `replaceRule.json` | ✅ `:212` | ✅ |
| 分组 `bookGroup.json` | ✅ `:213` | ✅ |
| RSS `rssSources.json` | ✅ `:214` | ✅ |
| 书架+进度 `bookshelf.json` | ✅ `:215`（进度随 `forEachShelfEntry` 走，`data/ShelfDao.kt:142-149`） | ✅ |
| Cookie `cookies.json` / `cookie.json` | ❌ **从不生成** | ✅ `BackupImporter.kt:537` |
| **笔记/书签 `book_note`** | ❌ **无入口** | ❌ **不认** |
| 书源登录态 `source_login_state` | ❌ | ❌ |

【推断】两类后果：
1. **笔记/书签完全没有备份通道** —— 这是 §7 的 **P0-3**，本次审计最刺眼的数据丢失缺口。
2. **Cookie 是单向的**（能导入别家导出的、自己导不出来）；`source_login_state`（`login_info`/`login_header`/`source_variable`/`source_kv` 四列，`db/Schema.kt:116-119`）也不进包 ⇒【推断】用户换设备后所有需要登录的书源都要**重新登录**，而规则变量（如签到 token）会丢。
3. `book_shelf_tombstone`（130 行，§4.1）不进包 —— 对新设备无害（新设备本就没有要保护的"删除决定"），但**同设备"导入自己旧包"时墓碑仍在库里生效**，所以这条漏项是有意还是无意【未确认】。

### 6.2 导入是否先备份 / 有无回滚

【事实】**有回滚，没有"导入前备份"。**

- **回滚：有，而且是正确用法。** `BackupImporter.applyAll` 把六个域**整批塞进一笔** `database.transaction { }`（`backup/BackupImporter.kt:253-268`）：
  `sources`(`:255`) → `rules`(`:257`) → `groups`(`:261`) → `library`(`:263`) → `rss`(`:265`) → `cookies`(`:267`)。
  注释解释顺序原因："分组必须先落库：书架条目上的 `groupId` 是手机那侧的号码，要经这张映射换成本机号，否则会把本机同号的另一个组（往往是「本地」）当成目标，**书就悄悄归错组了**"（`:258-259`）。
- **副作用延后到提交之后**：缓存失效在 `:270`（注释："缓存只在提交成功后失效：回滚时库里没变，清缓存纯属白做"）；个性化条目落盘在 `:271-273`（注释 `:139-140`："以前在解析阶段就 `keep.keep()`，**数据库回滚了文件却已经在数据目录里** —— 半套状态"）。两处都是**修过的历史 bug**。
- **导入前不备份：【事实】无。** `import()`（`:97-101`）读完魔数就直接 `importZip` / `importJson`；全仓 `DbSnapshot.run` 的调用点只有 `Migration.maybeSnapshot`（`data/db/Migration.kt:30` ← `Database.initialize()` `data/Database.kt:167`），即**只在启动时**跑，导入路径一次都不调。`http/BackupRoutes.kt` 里也只有 GET `/backup/snapshots`（`:52`）与 POST `/backup/snapshots/restore`（`:56`），没有"导入前自动快照"。

【推断】因此一次误操作的安全性上限 = **最近一次启动快照**：
- 快照保留份数 `LEGADO_DB_SNAPSHOT_KEEP` 默认 **5**，范围 0..50（`AppConfig.kt:119`）；
- 最小间隔 `LEGADO_DB_SNAPSHOT_MIN_INTERVAL_MS` 默认 **12 小时**（`AppConfig.kt:126`）。
⇒ 最坏情况下"可回退的过去"只有 12 小时前、且再启 5 次就被 `prune` 轮转删除（`DbSnapshot.kt:187-197`，按**文件名里的数值时间戳**倒序保留，注释 `:183` 特意说明不是字典序）。**用户导错包 / 误清数据后重启一次就可能把仅有的旧快照挤掉。**（§7 P0-2）

### 6.3 恢复路径（全库最好的部分）

【事实】恢复是**两阶段 + 先验后用**，`data/DbSnapshot.kt`：
1. `scheduleRestore(dbPath, name)`（`:68-75`）：只把快照名写进 `backups/` 下的标记文件 `RESTORE_MARKER`，**绝不碰正在使用的库**（注释 `:64`）；只接受本模块命名且**当前 SHA-256 校验通过**的快照（`:69-70`，`timestampOf` 挡路径穿越）。
2. 下次启动、**在打开库文件之前**（`Application.kt:157`：`if (DbSnapshot.applyPendingRestore(config.databasePath))`）消费标记 —— `applyPendingRestore`（`:83-115`）：
   - 校验 SHA-256（`:96-100`）→ 不通过则 `bail`（`:87-91`，标记改名 `.failed`，**当前库原样不动**、返回 false）；
   - 把当前库 `Files.move` 成 `pre-restore-<ts>` **安全副本**（`:105-107`）→ 保留可回退；
   - 删 `-wal` / `-shm`（`:108-109`）→ **这一步很关键**：残留 WAL 会让新落的主库被旧 WAL 污染；
   - `Files.copy(snap, target)`（`:110`）→ 删标记（`:111`）。
   注释 `:81`："关键是**绝不半路覆盖出一个坏库** —— 先验后用，改库是一步 copy。"

【推断/建议】这套两阶段恢复设计可以直接搬到二代；但**同样应该给"导入备份包"加一条前置 `scheduleRestore` 风格的自动快照**，把 §6.2 的空档补上。

【事实】`LegacyBackup.kt` 的职责是**格式兼容层**（不是备份存储）：`isOldSource`(`:38`) · `toNewSourceJson`(`:45`) · `isOldShelfEntry`(`:124`) · `toNewShelfJson`(`:129`) · `normalizeReplaceRule`(`:155`) · `elementsOf`(`:239`) —— 即把旧版 Legado / 兄弟项目的 JSON 形状归一。

【事实】`BackupStore` 是"个性化条目"的落盘处（`keep`(`:23`) / `read`(`:34`) / `list`(`:41`)），注释（经 `BackupImporter.kt:132-137` 转述）明确："**七类配置按用户口径禁止建表**，其余没有消费界面，**建表就是假支持**"。⇒ 【推断】这是"不为了看起来完整而建空表"的明确产品决策，重建时若要动这七类配置必须先有消费界面。

---

## 7. 用户数据丢失风险点（P0/P1/P2）

> 排序口径：P0 = 可导致**用户数据大面积不可恢复丢失**或**事务保护静默失效**；P1 = 可导致**某类数据永久丢失**或需要人工救库；P2 = 数据不一致 / 误导 / 磁盘增长，不丢原文。

| 级别 | 风险 | 触发路径 | 证据 | 后果 |
|------|------|---------|------|------|
| **P0-1** | **两套事务机制并存，手动 `autoCommit` 的函数一旦被 `transaction{}` 包住，外层事务被静默提交、`rollback` 失效** | 任何调用方在 `database.transaction { }` 内调用 `ShelfDao.saveBookshelf/updateBookshelfInfo/removeBookshelf/batchRemoveBookshelf/batchUpdateBookshelfGroup/switchBookshelf`、`CacheDao:83` 的函数、`SourceHealthDao:18`、`SourcesDao:59/167/184/213` 之一 | `data/Database.kt:122-136`（注释自述"0.2.35 的批量删书事故就是这条"）· `data/ShelfDao.kt:25,186,235,255,294,318` · `data/CacheDao.kt:83` · `data/SourceHealthDao.kt:18` · `data/SourcesDao.kt:59,167,184,213` | 批量操作"部分成功"变成"**部分永久落盘**"，用户以为全部失败/全部成功。**已真实发生过一次事故**（0.2.35 批量删书） |
| **P0-2** | **导入备份包前不拍快照；而唯一快照只有 12h 节流 / 最多 5 份** | `POST /backup/import` → `BackupImporter.import()` 直接解析写库，全程不调 `DbSnapshot.run` | `http/BackupRoutes.kt:113` · `backup/BackupImporter.kt:97-101`（无快照）· `data/db/Migration.kt:30`（`DbSnapshot.run` 唯一调用点，仅启动）· `AppConfig.kt:119`（keep 默认 5）· `AppConfig.kt:126`（间隔默认 12h）· `data/DbSnapshot.kt:187-197`（prune 按时间戳轮转删） | 用户导入错误的备份包（手机导出的是旧库 / 兄弟项目的包）→ 覆盖式合并不可撤销；能退回的只有"12 小时前"那一份，且再启动 5 次即被 `prune` 删除 ⇒ **实质不可恢复** |
| **P0-3** | **"导出备份"根本不包含笔记/书签（`book_note`）——没有任何导出入口，导入侧也不认** | 用户点"导出备份"→ `exportAll` 只写 5 个域 | `backup/BackupExporter.kt:209-216`（实际只有 `SOURCES_ENTRY`/`RULES_ENTRY`/`GROUPS_ENTRY`/`RSS_ENTRY`/`SHELF_ENTRY`，常量定义 `:40/43/46/49/52`）· `backup/BackupImporter.kt:525-545`（只认 SOURCE/RULE/SHELF/**COOKIE**/GROUP/RSS 六族名，**无 NOTE 族**）· `grep -rn "note\|book_note" backup/*.kt` 零命中与笔记有关 | **笔记与书签无法通过备份迁移，也无法恢复**。用户换设备/重装/救库后笔记全丢，且**导出包看起来"成功"**（无任何提示缺了笔记）。叠加 P1-4（废止表里那 1 条旧书签也读不到）⇒ **笔记体系两个方向都在漏** |
| **P1-1** | **`DROP TABLE app_user` / `session` 落在自动提交区、且早于快照** | 任意版本升级后首次启动：`Schema.createTables` 阶段无条件执行 | `db/Schema.kt:196-199`（`drop table if exists`）· `data/Database.kt:163-167`（`createTables` 在 164、快照在 167，且 `write{}` 不设 `autoCommit=false`） | v1 账号/会话数据**在升级瞬间不可逆删除**，且启动快照里已不含这两张表（注释 `:165-166` 声称"迁移前的原样快照"对 DROP 不成立） |
| **P1-2** | **`cookie_jar` 折叠后立即清空源列，不可逆** | 首次升级执行 `baseline` → 第 4 段 `migrateLegacyCookieJars` | `data/db/Migration.kt:67-101`，抹除在 **`:100`**（`update source_login_state set cookie_jar = null`） | 若 `cookieBucket(host)` 归并逻辑（`:79-85`）或 JSON 解析（`:76` 失败即 `return@forEach` 静默跳过）有任何偏差，**登录态永久丢失**且无中间副本；`:76` 的静默跳过意味着"解析失败 = 这条 cookie 悄悄没了" |
| **P1-3** | **LIKE 通配符污染导致跨书误删**（已修一处，同类未全审） | `bookUrl` 含 `%` / `_` 时，`like '%<url>%'` 匹配到别的书 | `data/ShelfDao.kt:245`（修复注释："删一本书会连带删掉别的书的目录缓存"）· 对照 `data/RssDao.kt:16`（剥 `%`/`_`）、`data/SourcesDao.kt:253`（`like ('% ' || ? || ' %')` 绑定） | 删除一本书 → 误删其它书的目录/正文缓存，需重新抓取（数据可重建，但**离线缓存与笔记锚点会失效**） |
| **P1-4** | **废止表 `book_mark` 里的用户笔记/书签成永久孤儿** | 旧版本把书签存 `book_mark`；新版本改存 `book_note.bookmark`，**没有迁移也没有删表** | 实库 `sqlite_master` 有 `book_mark`（§1 前言 附 ddl）· `grep` 证明当前源码零引用 · `count(*) from book_mark` = **1** · 新路径 `db/Schema.kt:166-174`（`book_note` + `bookmark` 列） | 用户那 1 条书签/笔记**存在但永远不可见**；任何"导出笔记"功能都不会带上它。数据物理未丢，逻辑已丢 |
| **P1-5** | **`reading_progress` 孤儿行累积，且指向已删除书源** | 删书/换源/删源路径不完整 + 无外键无级联 | 实测：5 条进度中 **4 条无书架条目**、**3 条 `source_id` 已不存在**（§4.1 对账）· 删除点 `data/ShelfDao.kt:241/265/335` · `clampShelfProgress` 只改不删 `:78` | 进度行随使用无限累积；恢复某本书时可能命中一条**过期进度**（书源 id 已被新源复用则会跳错位置）。不丢原文，但"接着读"会错 |
| **P2-1** | 阅读进度多表非原子写 | `saveProgress` 在同一 `write{}` 内先写 `reading_progress` 再写 `book_shelf.last_read_at`，两条各自提交 | `data/ReadingDao.kt:15-47`（`:21/28/36` 与 `:43`）· `data/Database.kt:112-114`（`write{}` 不碰 `autoCommit`） | 崩溃于两条之间 ⇒ 进度已更新、`last_read_at` 未更新；书架按 `last_read_at desc` 排序（`data/ShelfDao.kt:60`）把刚读的书排到后面。**不丢原文，视觉错乱** |
| **P2-2** | 位置三套坐标并存，同一行内可能自相矛盾 | 旧客户端只提交 `scroll_position`（`charOffset == null` 分支），新客户端提交 `char_offset`/`paragraph_anchor`/`position_version`/`position_checksum` 整组 | `data/ReadingDao.kt:18-33`（旧分支，**只 update 4 列、position 列一个不碰**）vs `:34-41`（新分支 upsert 全组）· 列由 `Migration.kt:111-123` 补 | 混用两种客户端后，同一本书的 `scroll_position` 与 `char_offset` 描述不同位置；读取方必须以 `position_version` 选权威，否则"跳回上次位置"跳错 |
| **P2-3** | `source_revision` 一旦被删，触发器永久失效且无人报错 | 任何 `delete from app_meta`（含未来"重置设置"类功能） | `db/Schema.kt:32`（仅建表时 `insert or ignore` 一次，**无 upsert 触发器和自愈**）· `data/Database.kt:214-219`（缺失时 `?: 0L` 兜底） | 计数器停 0 → 客户端书源缓存永不失效，改了书源看起来没变；**静默**、无日志 |
| **P2-4** | `migrateBookContentCache` 整段短路，`chapter_index` 可能永久为 0 | 回填中途失败但列已存在，则 `if ("chapter_index" in columns) return` 永不重试 | `data/db/Migration.kt:213` | 该批缓存行的章序永远错，按章序读取/导出会串章；无自愈路径 |
| **P2-5** | `book_group` 无外键，删组后 `book_shelf.group_id` 悬空 | `deleteBookGroup`（`data/ShelfDao.kt:125`）+ `book_shelf.group_id default 0`（`db/Schema.kt:58`） | `db/Schema.kt:70-72`（`book_group` 无引用约束）· `db/Schema.kt:58` | 【未确认】书可能落到不存在的组；`groupId=0` 与真实组 id 0 语义重叠。`deleteBookGroup` 实现体未读（见 §8.2） |
| **P2-6** | `log_entry` 与 `book_content_cache` 无保留策略字段 | 长期运行 | `db/Schema.kt:150-154`、`:74-79`（均无 TTL/过期列；`script_cache` 有 `deadline` `:190`，`book_shelf_tombstone` 有 `deleted_at` `:66`） | 库文件单调增长（当前主库 70,635,520 B + WAL 4,087,072 B，仅 `ls -la` 观察）；只能靠 `clearLogEntries()`（`data/LogDao.kt:90`）人工清 |
| **P2-7** | 恢复操作需重启才生效，用户可能误判"没生效" | `POST /backup/snapshots/restore` 只写标记文件，真正落库在下一次启动 | `data/DbSnapshot.kt:68-75`（注释"绝不碰正在使用的库"）· `data/DbSnapshot.kt:83` · 消费点 `Application.kt:157` | 用户点恢复后继续在旧库上操作，再次启动时**旧库被快照覆盖** ⇒ 这期间的新写入全部消失。设计正确但**缺少前端强制提示**（未确认前端行为） |
| **P2-8** | `reading_log.book_name` 是冗余快照列 | 书改名/换源后 | `db/Schema.kt:160` · `data/ReadingDao.kt:66`（`case when excluded.book_name <> '' then excluded.book_name else reading_log.book_name end`） | 历史统计显示旧书名；非丢失，但统计页与书架不同名 |

---

## 8. 证据索引 / 未确认事项 / 覆盖率声明

### 8.1 证据索引

**A. 精读文件（全文或核心窗口）**

| 文件 | 行数 | 读了多少 | 定下的结论 |
|------|------|---------|-----------|
| `data/db/Schema.kt` | 202 | **202 / 100%** | 21 表 / 14 索引 / 3 触发器；`drop app_user`+`session`（`:196-199`）；无一处 `alter` |
| `data/db/Migration.kt` | 261 | **261 / 100%** | 6 段补列迁移；`cookie_jar` 清空（`:100`）；LIKE 回填（`:156`）；`VACUUM`（`:48`）；`pragma optimize`（`:49`） |
| `data/SchemaVersion.kt` | 102 | **102 / 100%** | `user_version` 存版本（`:16-18/45-52`）；`BASELINE=TARGET=1`（`:30/33`）；降级保护（`:69-74`）；同事务（`:80-81`） |
| `data/Database.kt` | 249 | ~205 / 82%（`:1-90`、`:96-190`、`:212-232`） | `write{}` 不碰 autoCommit（`:112-114`）；`transaction{}` SAVEPOINT（`:138-160`）；启动三段顺序（`:163-178`）；0.2.35 事故注释（`:125-128`） |
| `data/ReadingDao.kt` | 173 | 40 / 23%（`:12-51`） | `saveProgress` 多表非原子（`:21/28/36` vs `:43`）；位置双分支（`:18-41`） |
| `data/DbSnapshot.kt` | 200 | 86 / 43%（`:1-30`、`:60-115`） | `VACUUM INTO` 理由（`:27-30`）；两阶段恢复（`:68-115`）；`prune`（`:187-197`） |
| `backup/BackupImporter.kt` | 567 | 114 / 20%（`:95-148`、`:243-302`） | 导入单事务 6 步（`:253-268`）；无前置快照（`:97-101`）；副作用延后（`:270-273`） |
| `backup/BackupExporter.kt` | 217 | 14 / 6%（`:205-217`）+ 常量 | `exportAll` 只导 5 域（`:209-216`）；**无 `book_note`** |
| `data/RssDao.kt` | 78 | 18 / 23%（`:10-27`） | LIKE 通配符剥除 + `?` 绑定（`:16-17`） |
| `AppConfig.kt` | — | `grep` 2 行 | 快照保留默认 5（`:119`）、间隔默认 12h（`:126`） |
| `Application.kt` | — | `grep` 2 行 | `applyPendingRestore` 在建库前（`:157`） |

**B. grep 级结构巡检（28 / 28 文件，未读实现体）**
`data/`：`BookshelfRepository.kt`(552) · `CacheDao.kt` · `CookieDao.kt`(714) · `ImportDao.kt` · `LogDao.kt` · `LoginDao.kt` · `ReplaceRuleDao.kt` · `ScriptCacheDao.kt` · `SessionCookies.kt` · `ShelfDao.kt`(423) · `SourceHealthDao.kt` · `SourceRepository.kt` · `SourcesDao.kt` · `StoreAdapters.kt` · `SubscriptionDao.kt` · `db/ConnectionPool.kt` · `SchemaVersion.kt`(已精读) · `Database.kt`(已精读) · `DbSnapshot.kt`(已精读) · `Schema.kt`(已精读)
`backup/`：`BackupStore.kt`(124) · `LegacyBackup.kt`(268) · `BackupImporter`/`BackupExporter`(已部分精读)
巡检得到的**关键 grep 证据**：
- `grep -rn "write\s*{" data/*.kt` → 15 个文件共 ~65 处写块（`ShelfDao` 13、`CacheDao` 9、`LoginDao` 7）
- `grep -rn "autoCommit" data/*.kt` → **手动事务 12 处 / 4 个文件**：`ShelfDao:25,186,235,255,294,318` · `SourcesDao:59,167,184,213` · `CacheDao:83` · `SourceHealthDao:18`（§4.3 核心证据，且 `Database.kt:134-136` 的警告**漏报了 SourcesDao / SourceHealthDao**）
- `grep -rn "executeQuery\|prepareStatement" http/ rules/ source/` → **空**（§5.1）
- `grep -rln "executeQuery\|prepareStatement\|createStatement"` → 全仓仅 20 个文件、全在 `data/`
- `grep -rn "book_mark\|book_mark_key_idx\|idx_source_updated_at"` → **全仓零命中**（§1 前言孤儿表）

**C. 实库只读证据**（`sqlite3 -readonly`，仅 schema 与计数）
`pragma user_version`=1 · `type=table 25 / index 34 / trigger 3` · 22 张用户表（多 `book_mark`）· 16 个非自动索引（多 `book_mark_key_idx`、`idx_source_updated_at`）· `app_meta` 3 键 · `book_mark` 1 行 · 各表行数见 §4.1 · 孤儿进度 4/5、悬空 source 3/5。

### 8.2 未确认事项

| # | 未确认内容 | 为什么没确认 | 影响 |
|---|-----------|-------------|------|
| 1 | `LogDao.kt:97 ensureLogTable()` 里是否还有 `create table` | 只读到函数名，未读实现体；但 `book_mark` 的前例说明**Schema.kt 之外可能有第二处建表** | 若有，则"21 张表"这一口径本身不完整。【建议】重建前对全仓 `create table` 再扫一次 |
| 2 | `deleteBookGroup`（`ShelfDao.kt:125`）删除组后是否重置 `book_shelf.group_id` | 实现体未读 | 决定 §7 P2-5 是 P2 还是更低 |
| 3 | `CookieDao`(714) 里 `cookie` 表与 `source_login_state` 的真实读写边界；`app_meta` 的 `cookie_mentions_*` 两键由谁写 | 实现体未读 | 影响"凭据域"是否还有第二处权威（§4.1 同型问题） |
| 4 | `book_mark` 的 1 行数据属于哪本书、是否有旧迁移代码曾试图搬运它 | 不读内容（纪律要求）；且未查 `git log` 历史 | 决定 P1-4 是"可人工救回"还是"已无从对应" |
| 5 | 前端是否有"恢复需重启"的强制提示 | 未读前端 | 决定 §7 P2-7 的实际破坏力 |
| 6 | `BackupImporter.MAX_TOTAL_BYTES` 具体数值 | 未读常量 | 只影响"大包被拒"的边界 |
| 7 | `book_shelf_tombstone` 不进导出包是有意还是遗漏 | 无注释说明 | 影响 §6.1 第 3 点定性 |
| 8 | 计数是否为"某一时刻"快照 | 库可能正被运行中的服务写（存在 4MB WAL、`ui-prefs.json` 与本轮同时段内修改） | 数字精度 ±若干行，不影响结论方向 |
| 9 | 未执行任何测试（`DatabaseTest` / `BackupImportTest` / `MigrationTest` 存在） | 任务禁止 build/启动 | 本文所有"回滚有效""幂等"结论来自**读代码**，非实测 |

### 8.3 覆盖率声明

| 覆盖对象 | 覆盖率 | 口径 |
|---------|--------|------|
| 建表 DDL（21 表） | **21/21 = 100%** | `db/Schema.kt` 全文读 |
| 索引（14） | **14/14 = 100%** | 同上 |
| 触发器（3） | **3/3 = 100%** | 同上 |
| 迁移步骤（v0→v1 六段） | **6/6 = 100%** | `db/Migration.kt` 全文读 |
| 版本机制 | **100%** | `SchemaVersion.kt` 全文 + `Database.initialize` 全文 |
| 事务机制核心 | **100%** | `Database.kt:112-160` 全读 |
| 实库 schema 对象 | **25/25 = 100%**（含 3 张 SQLite 内部表） | `sqlite_master` 全量列举 |
| **DAO 实现体** | **约 17%**（精读 1,042 / 6,292 行 ≈ 16.6%） | 只统计实际显示出的源码行，不含 grep 命中行 |
| DAO 文件级结构 | **28/28 = 100%** | 每个文件至少做过 `grep -n "fun "`、写块、`autoCommit`、SQL 面四次检索 |
| 备份四件套 | 签名 **4/4 = 100%**，实现体 **约 13%** | `BackupExporter`/`BackupImporter` 部分精读，`BackupStore`/`LegacyBackup` 仅签名 |

【推断】**最重要的结论恰好落在覆盖率 100% 的区域**（DDL、迁移、版本、事务机制、实库 schema），因此它们可信度高；而 §8.2 的 9 条未确认事项集中在 **DAO 实现体（17%）**，重建前应优先补第 1、3 条（是否存在第二处建表 / 凭据域是否双权威）。

【建议】二代重建时，把本文的 §1（表清单）、§3（迁移注册表）、§5.1（SQL 只在 data/）直接转成**自动化断言**（表清单快照测试、`user_version` 单调性测试、包边界测试），否则本报告会像它的前身一样迅速过期。

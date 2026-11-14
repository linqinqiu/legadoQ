# legadoQ 备份格式兼容矩阵（BACKUP_MATRIX）

> 审计日期：2026-11-14 ｜ legadoQ：`main` @ `4291d30` + 当前未提交 WIP
> 性质：**只读兼容性审计**。未修改任何源码、配置或数据。
> 对照基线：`LegadoTeam/legado` @ `330e606`（2026-11-01）、`HapeLee/legado-with-MD3` @ `97893ac`（2026-11-14）。
> 方法：读上游 `help/storage/Backup.kt`、`Restore.kt` 与实体类，逐节逐字段对照 legadoQ 的 `BackupImporter.kt`、`BackupStore.kt`、`Schema.kt`。
> **没有完整备份 zip 样本**：字段名已用一份公开真实样本 `autobcb/read` 的 `bookshelf.json`（13 条书）确认；完整 zip 的端到端导入仍未验证。

## 0. 一句话结论

legadoQ 能**读进来** Legado 备份的六个核心节，但「读进来」不等于「恢复成可用数据」：

1. **书架的 `group` 字段名读错**（读 `groupId`，上游写 `group`）——已用真实样本确认，**已在工作树修复，未提交**。原测试用了同一个错字段名，所以一直没发现。
2. **章内阅读位置丢失**（`durChapterPos` 不读，`scroll_position` 固定写 0）——**已在工作树修复，未提交**。
3. **书签 / 高亮 / 阅读记录 / 搜索历史没有对应表**，只能原样留档，不能在 legadoQ 里使用。
4. **没有导出**：兼容是单向的，用户离开 legadoQ 时无法带走数据。

## 1. 上游备份包含什么

`Backup.kt:53-86` 按内容开关写出下列条目：

| 分组 | 条目 |
| --- | --- |
| 书架 | `bookshelf.json`、`bookGroup.json`、`bookMemo.json` |
| 标注 | `bookmark.json`、`highlight.json`、`highlightRule.json` |
| 书源 | `bookSource.json`、`rssSources.json`、`rssStar.json`、`sourceSub.json` |
| 凭据 | `cookies.json`（AES） |
| 规则 | `replaceRule.json`、`txtTocRule.json`、`httpTTS.json`、`keyboardAssists.json`、`dictRule.json`、`autoTask.json`、`servers.json`（AES） |
| 历史 | `readRecord.json`、`searchHistory.json` |
| 设置 | `config`（SharedPreferences 快照）、`videoConfig`、`readConfig`、`themeConfig`、`coverConfig` |
| 媒体 | `covers/`、`bg/`、阅读记录封面目录 |

MD3 在此基础上多写 8 个条目：`bookMarking.json`、`highlightTagRule.json`、`homepageModules.json`、`homepageCustomSets.json`、`httpTtsVoices.json`、`readRecordDetail.json`、`readRecordSession.json`、`tagGroupRule.json`。

## 2. 条目级矩阵（legadoQ 怎么处理）

| 条目 | 上游 | legadoQ 处理 | 数据结局 | 风险 |
| --- | --- | --- | --- | --- |
| `bookSource.json` | 全量书源 | **原生导入** `source` 表 | 可用 | 主键归一化会合并带 `#` 注解的同 URL 源；`customOrder` 丢失 |
| `replaceRule.json` | 全量替换规则 | **原生导入** `replace_rule` 表 | 可用 | `scopeSource` 字段无落点；空 id 重试会重复（见 P0-1） |
| `bookGroup.json` | 分组 | **原生导入** `book_group` 表 | 部分可用 | 只取 `groupId/groupName`；`cover/order/enableRefresh/show/bookSort/onlyUpdateRead` 全丢 |
| `bookshelf.json` | 书架 + 进度 | **原生导入** `book_shelf` + `reading_progress` | 部分可用 | 见 §3 字段级矩阵，含 `group` 字段名读错 |
| `rssSources.json` | RSS 源 | **原生导入** `rss_source` 表 | 可用（payload 原样） | `enabled` 被备份覆盖（与书源策略不同，已文档化） |
| `cookies.json` | AES 加密凭据 | **原生导入** `cookie` 表 | 可用 | 需备份密码；解密失败只跳过本节 |
| `txtTocRule.json` | TXT 分章规则 | 存为文件 + **可套用**（`TocRulesRoutes.kt:134`） | 可用（手动套用） | 不是自动生效 |
| `readConfig.json` | 阅读样式 | 存为文件 + **可套用** | 可用（手动套用） | |
| `httpTTS.json` | 朗读引擎 | 存为文件 + **可套用** | 可用（手动套用） | |
| `bookmark.json` | 书签 | 存为文件 | **不可用** | `book_note` 有 `bookmark` 列，但导入器不映射 |
| `highlight.json` / `highlightRule.json` | 高亮/高亮规则 | 存为文件 | **不可用** | 无对应表 |
| `bookMemo.json` | 书籍笔记/想法 | 存为文件 | **不可用** | `book_note` 是段落笔记，粒度不同；未做映射 |
| `readRecord.json` | 阅读记录 | 存为文件 | **不可用** | `reading_log` 表结构接近，可映射但未做 |
| `searchHistory.json` | 搜索历史 | 存为文件 | **不可用** | 无对应表 |
| `rssStar.json` | RSS 收藏 | 存为文件 | **不可用** | 无对应表 |
| `sourceSub.json` | 书源订阅 | 存为文件 | **不可用** | 有 `source_subscription` 表，但导入器不映射 |
| `keyboardAssists.json` / `dictRule.json` | 键盘助手/字典规则 | 存为文件 | **不可用** | 无消费方 |
| `servers.json` | WebDAV/服务器配置 | 仅上报 | 不导入 | 含凭据，刻意不收 |
| `autoTask.json` | 自动任务 | 排除 | 不导入 | 运行时调度，legadoQ 无对应能力 |
| `runtimeSourceCache.json` | 书源变量缓存 | 排除 | 不导入 | 可再生 |
| `config` / `videoConfig` | 客户端偏好 | 排除 | 不导入 | 含设备参数与绝对路径 |
| MD3 额外 8 项 | 主题/首页/记录详情等 | 存为文件 | 不可用 | 无对应表；至少没丢 |

**结论**：六个核心节能进库；其余 20+ 节里，只有 3 节能「手动套用」，9 节是「留档但不能用」，其余是刻意不收。对用户来说，「备份导进来了」与「我的书签/高亮/阅读记录回来了」是两件事。

## 3. 字段级矩阵：bookshelf.json（最关键）

上游 `Book` 实体（`Book.kt`）写出的字段 vs legadoQ `BackupShelfEntry`（`BackupModels.kt:47-61`）与表结构（`Schema.kt` `book_shelf` / `reading_progress`）：

| 上游字段 | legadoQ | 结局 |
| --- | --- | --- |
| `bookUrl` | `book_url` | ✅ |
| `name` / `author` | 同名列 | ✅ |
| `tocUrl` | `toc_url` | ✅ |
| `coverUrl` / `customCoverUrl` | `cover_url`（后者作为回退） | ⚠️ 自定义封面被当成普通封面，原字段丢失 |
| `origin` | 归一化成 `source_id` | ⚠️ 带注解的 origin 被合并 |
| `originName` | 无 | ❌ |
| **`group`** | **原读 `groupId`；现同时认 `group` 与 `groupId`** | ✅ 已修（未提交）：真实样本只有 `group`，无 `groupId` |
| `durChapterIndex` | `chapter_index` | ✅ |
| `durChapterTime` | `updated_at` / `last_read_at` | ✅ |
| **`durChapterPos`** | **原不读；现映射到 `reading_progress.char_offset`** | ✅ 已修（未提交）：章内位置不再固定为 0 |
| `durChapterTitle` | 无 | ❌ 书架/进度不显示当前章名 |
| `kind` | 只用来判「完结」 | ❌ 分类标签丢失 |
| `customTag` | 无 | ❌ |
| `intro` / `customIntro` | 无 | ❌ 简介与自定义简介丢失 |
| `charset` / `type` | 无 | ❌ 音频书会被当文本处理 |
| `latestChapterTitle` / `latestChapterTime` | 无 | ❌ 书架最新章显示为空，需刷新 |
| `totalChapterNum` / `lastCheckCount` | 无 | ❌ |
| `wordCount` / `canUpdate` / `order` / `originOrder` | 无 | ❌ 排序与字数丢失 |
| `variable` | 无（表也没有列） | ❌ 书级变量丢失，依赖它的脚本换源后失效 |
| `readConfig` | 无 | ❌ 单书阅读样式丢失 |
| `syncTime` / `persistedCoverUrl` | 无 | ❌ |
| `durVolumeIndex` / `chapterInVolumeIndex` | 无 | ❌ 分卷进度丢失 |

表结构本身也承载不了：`book_shelf` 只有 `source_id/book_url/name/author/toc_url/cover_url/cover_key/last_read_at/completed/alternate_sources/group_id`（+ 迁移补的 `toc_rule/sort_order`）。**这不是「导入器少写几行」，而是数据模型缺列**。

## 4. 字段级矩阵：其余五节

### bookGroup.json

| 上游 | legadoQ | 结局 |
| --- | --- | --- |
| `groupId` / `groupName` | 映射成本机组号 + 名字 | ✅ |
| `cover` | 无 | ❌ 分组封面丢失 |
| `order` | 无（用本机 `sort_order`） | ❌ |
| `enableRefresh` / `show` / `bookSort` / `onlyUpdateRead` | 无 | ❌ 分组行为设置丢失 |

### replaceRule.json

| 上游 | legadoQ | 结局 |
| --- | --- | --- |
| `name/group/pattern/replacement/scope/excludeScope/scopeTitle/scopeContent/isEnabled/isRegex/order/timeoutMillisecond` | 同名 | ✅ |
| **`scopeSource`** | 模型与表都没有 | ❌ 只作用于「书源名」的规则会变成作用于全部 |
| `previewText` | 无 | ❌ 仅预览文本，影响小 |
| `id: Long` | `id: String` | ⚠️ 需确认数字 id 能被 `text()` 读成字符串（`NEEDS_SAMPLE`） |

### bookSource.json

| 上游 | legadoQ | 结局 |
| --- | --- | --- |
| 全部字段 | `payload` 原样保存 | ✅ 字段不丢 |
| `enabled` | 刻意保留本机值 | ✅ 设计正确 |
| `bookSourceGroup` | 导入值 + 本机体检标签合并 | ✅ 设计正确 |
| `customOrder` | 导入不写 `sort_order` | ❌ 书源排序丢失 |
| `bookSourceUrl` 带 `#` 注解 | 归一化成域名主键 | ⚠️ 两条同域源会合并 |

### rssSources.json

| 上游 | legadoQ | 结局 |
| --- | --- | --- |
| 全部字段 | `payload` 原样保存 | ✅ |
| `enabled` | 用导入值覆盖 | ⚠️ 与书源策略相反，已文档化（`import-conflict-policy.md`） |
| `enableReadRecord/singleUrl/articleStyle/sortUrl` | 保留在 payload，但未必执行 | ⚠️ 字段在 ≠ 行为支持 |

### cookies.json

| 上游 | legadoQ | 结局 |
| --- | --- | --- |
| `url` / `cookie` | 同义 | ✅ |
| AES 口径 | 逐字照上游（MD5 hex 前 16 字符） | ✅ |

## 5. 与「换软件不丢数据」的差距

按用户目标逐条判定：

| 目标 | 现状 | 缺口 |
| --- | --- | --- |
| 书架书籍不丢 | ✅ 基本成立 | 同名同作者的书上游有唯一索引，legadoQ 按 `(source, bookUrl)`，可能多一条 |
| 分组不丢 | ⚠️ 已修待提交 | `group` 已认；分组封面/排序/行为设置仍不导入 |
| 阅读进度不丢 | ⚠️ 已修待提交 | 章序号与章内偏移都在；当前章名仍丢 |
| 书源配置不丢 | ✅ | 排序丢 |
| 替换规则不丢 | ⚠️ | `scopeSource` 丢 |
| RSS 不丢 | ✅ | |
| 阅读设置不丢 | ⚠️ | 只有 3 类可手动套用，其余留档 |
| 书签不丢 | ❌ | 文件在，库里没有 |
| 历史不丢 | ❌ | 文件在，库里没有 |
| 能迁出 legadoQ | ❌ | **没有备份导出功能** |

## 6. 建议的兼容层切口（不改代码，只定边界）

1. **先修字段名与位置**（已完成，未提交）：`group` → `group_id` 映射、`durChapterPos` → `char_offset`。这两项决定「换过来能不能接着读」。
2. **再补表**：书签/高亮/阅读记录/搜索历史各自建表或并入现有表，否则永远是「留档不能用」。
3. **最后做适配器**：现在 `BackupImporter` 是「解析 → 直接写 DAO」，没有中间模型。要支持 MD3/兄弟包的多套字段，需要 `BackupDocument` 中间层 + 每包一个 adapter；否则每加一个包就改一次 `shelfOf`。
4. **导出与导入同时设计**：没有导出，兼容就是单向漏斗；适配器的字段映射应当双向复用。

## 7. 复现命令

```bash
# 上游写包清单
grep -n "writeListToJson\|\.json" ref-legadoteam/app/src/main/java/io/legado/app/help/storage/Backup.kt

# 上游书架字段
grep -n "var " ref-legadoteam/app/src/main/java/io/legado/app/data/entities/Book.kt

# legadoQ 读包字段
grep -n "book.number\|book.text" product/app/src/main/kotlin/io/legado/backup/BackupImporter.kt

# legadoQ 表结构
sed -n '/create table if not exists book_shelf (/,/);/p' product/app/src/main/kotlin/io/legado/data/db/Schema.kt
```

## 8. 本轮限制

- 没有完整备份 zip 端到端导入；字段名已用 `autobcb/read` 的 `bookshelf.json`（13 条）确认，但该样本的 `durChapterPos` 全为 0，非零位置只做了单元测试，没有真实数据验证。
- 未覆盖媒体目录（`covers/`、`bg/`）与封面恢复。
- 未覆盖 WebDAV 自动备份、局域网备份、加密包密码错误后的部分恢复行为。
- 未评估 `bookMemo` / `readRecord` 与现有表的字段映射可行性细节，只标了「可映射但未做」。

## 9. 修订记录

| 日期 | 变更 | 依据 |
| --- | --- | --- |
| 2026-11-14 | `group` / `groupId` 双认 | 真实样本 `autobcb/read/bookshelf.json`：字段为 `group`，无 `groupId` |
| 2026-11-14 | `durChapterPos` → `reading_progress.char_offset` | 上游 `Book.durChapterPos` 语义为章内字符偏移；legadoQ `char_offset` 同义 |
| 2026-11-14 | 备份更新进度时清空 `paragraph_anchor` / `position_checksum` | 备份不带这两个字段，留旧值会指向旧内容 |

package io.legado.ai

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 内置工具的参数表 —— 让模型拿到**标准 JSON Schema**，而不是"从一句描述里猜参数名"。
 *
 * 两个上游都在这件事上比我们细：MD3 的 22 个原生工具每个都手写 schema；refgd 的工具
 * 也至少把参数名与描述写全。我们之前所有工具共用
 * `{"type":"object","properties":{},"additionalProperties":true}`，模型只能凭描述猜
 * `sourceId` 还是 `source_id`、`ids` 是不是数组，第一次调用经常被 `invalid_request` 打回。
 *
 * 这里按工具 id 集中声明，而不是散在 55 个 `ToolMeta(...)` 里：
 * - 一份表能一眼看出命名是否一致（全部 camelCase）；
 * - 新增工具时只加一段，不会漏；
 * - [ToolRegistry] 在注册时自动补齐，插件同名工具也会受益。
 *
 * **只声明工具真正读取的键**。handler 里没有读的键不写进 schema —— 模型看到什么就能填什么，
 * 填了没用等于骗它。类型同样按 handler 的实际取法：`strId` / `as? Number` 的是 integer，
 * `as? Boolean` 的是 boolean，`listString` 的是 string 数组。
 */
object ToolSchemas {

    private fun p(
        name: String,
        type: String = "string",
        description: String = "",
        required: Boolean = false,
        enum: List<String> = emptyList(),
    ) = ToolParam(name, type, description, required, enum)

    private val sourceId = p("sourceId", description = "书源 id（不是书名）", required = true)
    private val bookUrl = p("bookUrl", description = "书籍详情页地址（书源里的 bookUrl）", required = true)
    private val sourceJson = p("json", description = "书源 JSON 字符串（完整书源配置）", required = true)

    private val table: Map<String, List<ToolParam>> = mapOf(
        // ===== sources =====
        "source.list" to listOf(
            p("q", description = "搜索关键词，匹配书名/作者/地址；不填列全部"),
            p("limit", "integer", "返回条数，默认 20；0 只返回总数"),
        ),
        "source.get" to listOf(p("id", description = "书源 id", required = true)),
        "source.validate" to listOf(sourceJson),
        "source.debug" to listOf(
            sourceJson,
            p("keyword", description = "搜索用的关键词，默认「测试」"),
            p("bookUrl", description = "已知书籍详情页地址；不填则只调试搜索"),
            p("chapterIndex", "integer", "调试正文时取第几章（从 0 开始）"),
        ),
        "source.health" to listOf(
            sourceJson,
            p("id", description = "书源 id；用于结果标识"),
            p("name", description = "书源名称；不填用 id"),
            p("keyword", description = "体检搜索用的关键词，默认「测试」"),
        ),
        "source.import" to listOf(
            p("sources", "array", "书源 JSON 字符串数组，按 id upsert", required = true),
        ),
        "source.upsert" to listOf(
            sourceJson,
            p("version", "integer", "乐观锁版本号；更新已有书源时传，新建不传"),
        ),
        "source.delete" to listOf(p("id", description = "要删除的书源 id", required = true)),
        "source.batch" to listOf(
            p("ids", "array", "要操作的书源 id 列表", required = true),
            p("action", description = "批量动作", required = true, enum = listOf("delete")),
            p("confirm", "boolean", "批量删除必须显式传 true 确认"),
        ),
        "source.order" to listOf(
            p("ids", "array", "按目标顺序排列的书源 id 列表（未列出的保持相对顺序）", required = true),
        ),
        "source.group.list" to emptyList(),
        "source.group.add" to listOf(p("name", description = "分组名，最长 24 字", required = true)),
        "source.group.remove" to listOf(p("id", "integer", "分组 id", required = true)),
        "source.group.assign" to listOf(
            sourceId,
            bookUrl,
            p("groupId", "integer", "目标分组 id；0 表示移出分组", required = true),
        ),

        // ===== replace-rules =====
        "replace.list" to listOf(
            p("q", description = "按名称/规则内容过滤"),
            p("group", description = "按分组过滤"),
        ),
        "replace.get" to listOf(p("id", description = "净化规则 id", required = true)),
        "replace.save" to listOf(
            p("json", description = "净化规则 JSON 字符串；id 为空表示新建", required = true),
        ),
        "replace.delete" to listOf(p("id", description = "净化规则 id", required = true)),
        "replace.toggle" to listOf(
            p("ids", "array", "净化规则 id 列表", required = true),
            p("enabled", "boolean", "true 启用 / false 停用，默认 true"),
        ),
        "replace.import" to listOf(
            p("json", description = "净化规则 JSON 数组字符串", required = true),
        ),

        // ===== rss =====
        "rss.list" to listOf(p("q", description = "按名称/地址过滤")),
        "rss.get" to listOf(p("sourceUrl", description = "RSS 源地址", required = true)),
        "rss.setEnabled" to listOf(
            p("sourceUrl", description = "RSS 源地址", required = true),
            p("enabled", "boolean", "true 启用 / false 停用，默认 true"),
        ),
        "rss.delete" to listOf(p("sourceUrl", description = "RSS 源地址", required = true)),

        // ===== bookshelf =====
        "shelf.list" to emptyList(),
        "shelf.get" to listOf(sourceId, bookUrl),
        "shelf.add" to listOf(
            p("json", description = "书架条目 JSON（sourceId/bookUrl/bookName/author 等）", required = true),
        ),
        "shelf.remove" to listOf(sourceId, bookUrl),
        "shelf.setCompleted" to listOf(
            sourceId, bookUrl,
            p("completed", "boolean", "true 标记已读完，false 取消，默认 true"),
        ),
        "shelf.infoUpdate" to listOf(
            p("json", description = "要更新的字段 JSON（sourceId/bookUrl + name/author/coverUrl）", required = true),
        ),

        // ===== notes / progress =====
        "note.list" to listOf(sourceId, bookUrl),
        "note.add" to listOf(
            p("json", description = "笔记 JSON（sourceId/bookUrl/bookName/chapterIndex/excerpt/note 等）", required = true),
        ),
        "note.update" to listOf(
            p("id", "integer", "笔记 id", required = true),
            p("note", description = "新的笔记内容", required = true),
        ),
        "note.delete" to listOf(p("id", "integer", "笔记 id", required = true)),
        "readingLog.add" to listOf(
            p("json", description = "阅读日志 JSON（sourceId/bookUrl/bookName/seconds 等）", required = true),
        ),
        "readingLog.list" to listOf(p("days", "integer", "统计最近几天，默认 7")),
        "progress.get" to listOf(sourceId, bookUrl),
        "progress.set" to listOf(
            sourceId, bookUrl,
            p("chapterUrl", description = "当前章节地址"),
            p("chapterIndex", "integer", "当前章节序号（从 0 开始）"),
            p("scrollPosition", "number", "章内滚动位置，0~1 的比例"),
        ),

        // ===== subscriptions =====
        "subscription.list" to emptyList(),
        "subscription.updateOne" to listOf(p("id", "integer", "订阅 id", required = true)),
        "subscription.updateAll" to emptyList(),

        // ===== reading AI =====
        "ai.textClean" to listOf(
            p("text", description = "要清洗的原文", required = true),
            p("ruleIds", "array", "要应用的净化规则 id 列表；不填则原样返回"),
            p("dryRun", "boolean", "true 只预览不执行（当前仅影响返回的 rulesApplied）"),
            p("bookName", description = "书名；部分规则按书名生效"),
        ),
        "ai.textRewrite" to listOf(
            p("text", description = "要改写的原文", required = true),
            p("purpose", description = "改写目的，如「润色」「朗读稿」「精简」"),
            p("length", description = "长度档位", enum = listOf("short", "normal", "long")),
        ),
        "ai.selectTextAction" to listOf(
            p("action", description = "动作", required = true, enum = listOf("highlight", "note", "delete")),
            p("sourceId", description = "书源 id（highlight/note 必填）"),
            p("bookUrl", description = "书籍地址（highlight/note 必填）"),
            p("bookName", description = "书名"),
            p("chapterUrl", description = "章节地址"),
            p("chapterIndex", "integer", "章节序号（从 0 开始）"),
            p("startOffset", "integer", "选区起点字符偏移"),
            p("endOffset", "integer", "选区终点字符偏移"),
            p("excerpt", description = "选中的原文"),
            p("note", description = "笔记内容；highlight 时不填默认「高亮」"),
            p("noteId", "integer", "要删除的笔记 id（action=delete 时必填）"),
        ),

        // ===== tts =====
        "tts.voices" to emptyList(),
        "tts.speak" to listOf(
            p("text", description = "要合成的文本", required = true),
            p("voice", description = "音色 id，默认 zh-CN-XiaoxiaoNeural"),
            p("rate", "integer", "语速百分比偏移，如 +10 / -10"),
            p("pitch", "integer", "音调百分比偏移，如 +5 / -5"),
        ),

        // ===== backup =====
        "backup.list" to emptyList(),
        "backup.get" to listOf(p("name", description = "备份区条目名", required = true)),

        // ===== explore / search =====
        "explore.tabs" to listOf(sourceJson),
        "explore.run" to listOf(
            sourceJson,
            p("url", description = "发现页分类地址"),
            p("page", "integer", "页码，从 1 开始"),
        ),
        "search.run" to listOf(
            sourceJson,
            p("keyword", description = "搜索关键词，默认「测试」"),
        ),
        "book.info" to listOf(sourceJson, bookUrl),
        "chapters.run" to listOf(
            sourceJson,
            p("tocUrl", description = "目录页地址", required = true),
        ),
        "content.run" to listOf(
            sourceJson,
            p("chapterUrl", description = "章节正文页地址", required = true),
        ),

        // ===== program =====
        "program.catalog" to emptyList(),
        "tool.search" to listOf(
            p("q", description = "关键词；匹配工具 id / 分组 / 说明，不填列出前 20 个"),
        ),
        "tool.call" to listOf(
            p("id", description = "要调用的工具 id", required = true),
            p("args", "object", "该工具的参数对象，键见 tool.search 返回的 params"),
        ),
    )

    /** 某个工具的参数声明；没登记就是空列表（schema 退化为宽松对象）。 */
    fun forTool(id: String): List<ToolParam> = table[id].orEmpty()

    /** 已登记参数的工具数（自检/测试用）。 */
    fun size(): Int = table.size

    /**
     * 生成 provider 下发的 JSON Schema。
     *
     * 空参数表 -> `{type:object, properties:{}, additionalProperties:true}`，与历史行为一致，
     * 不会把临时注册的插件工具卡死。有声明时 `additionalProperties=false`：
     * 模型多填的键会被上游 schema 校验提醒，而不是悄悄被 handler 忽略。
     */
    fun jsonSchema(params: List<ToolParam>): JsonObject {
        if (params.isEmpty()) {
            return buildJsonObject {
                put("type", "object")
                put("properties", buildJsonObject { })
                put("additionalProperties", true)
            }
        }
        return buildJsonObject {
            put("type", "object")
            put("properties", buildJsonObject {
                params.forEach { param ->
                    put(param.name, buildJsonObject {
                        put("type", param.type)
                        if (param.description.isNotBlank()) put("description", param.description)
                        if (param.enum.isNotEmpty()) {
                            put("enum", buildJsonArray { param.enum.forEach { add(JsonPrimitive(it)) } })
                        }
                        if (param.type == "array") {
                            put("items", buildJsonObject { put("type", "string") })
                        }
                    })
                }
            })
            val required = params.filter { it.required }.map { it.name }
            if (required.isNotEmpty()) {
                put("required", buildJsonArray { required.forEach { add(JsonPrimitive(it)) } })
            }
            put("additionalProperties", false)
        }
    }
}

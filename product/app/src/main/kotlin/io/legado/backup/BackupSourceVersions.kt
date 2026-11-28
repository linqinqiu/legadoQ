package io.legado.backup

import io.legado.data.*
import io.legado.model.*
import io.legado.source.ParsedSource
import io.legado.source.SourceCodec
import kotlinx.serialization.json.*

/** Explicit activation only. Evidence remains immutable; executable identity stays the normalized URL. */
internal class BackupSourceVersions(private val database: Database, private val store: BackupStore) {
    private fun parsed(raw: JsonElement): ParsedSource = SourceCodec.parse(
        if (LegacyBackup.isOldSource(raw)) requireNotNull(LegacyBackup.toNewSourceJson(raw)) else raw.toString())

    fun list(request: SourceVersionListRequest): SourceVersionList {
        require(request.offset >= 0 && request.query.length <= 200) { "分页或查询无效" }
        val root = store.sourceArchive(request.archive)
        val sources = root.getValue("bookSource").jsonArray
        val query = request.query.trim()
        val groups = root.getValue("conflicts").jsonArray.mapNotNull { element ->
            val group = element.jsonObject
            val id = group.getValue("normalizedId").jsonPrimitive.content
            val winner = group.getValue("winnerIndex").jsonPrimitive.int
            val variants = group.getValue("sourceIndexes").jsonArray.map { value ->
                val index = value.jsonPrimitive.int
                val raw = sources[index]
                val source = parsed(raw)
                val obj = raw.jsonObject
                val original = listOf("bookSourceUrl", "sourceUrl", "url").firstNotNullOfOrNull {
                    obj[it]?.jsonPrimitive?.contentOrNull
                } ?: source.id
                SourceVersionVariant(index, source.name, original, index == winner)
            }
            if (query.isEmpty() || id.contains(query, true) || variants.any { it.name.contains(query, true) })
                SourceVersionGroup(id, variants) else null
        }
        return SourceVersionList(groups.size, request.offset, groups.drop(request.offset).take(20))
    }

    private fun selection(request: SourceVersionRequest): Pair<ParsedSource, List<SourceVersionLink>> {
        require(request.relink.size <= 200 && request.relink.distinct().size == request.relink.size) { "重新关联选择无效" }
        val root = store.sourceArchive(request.archive)
        val raw = root.getValue("bookSource").jsonArray.getOrNull(request.index)
            ?: throw IllegalArgumentException("版本不存在")
        val source = parsed(raw)
        require(root.getValue("conflicts").jsonArray.any { element ->
            val group = element.jsonObject
            group.getValue("normalizedId").jsonPrimitive.content == source.id &&
                group.getValue("sourceIndexes").jsonArray.any { it.jsonPrimitive.int == request.index }
        }) { "所选版本不属于冲突留档" }
        val originalIds = root.getValue("conflicts").jsonArray.first {
            it.jsonObject.getValue("normalizedId").jsonPrimitive.content == source.id
        }.jsonObject.getValue("sourceIndexes").jsonArray.map { index ->
            val obj = root.getValue("bookSource").jsonArray[index.jsonPrimitive.int].jsonObject
            listOf("bookSourceUrl", "sourceUrl", "url").firstNotNullOfOrNull { obj[it]?.jsonPrimitive?.contentOrNull }
        }.filterNotNull().toSet()
        val candidates = root.getValue("bookshelf").jsonArray.mapNotNull { rawBook ->
            val book = if (LegacyBackup.isOldShelfEntry(rawBook))
                LegacyBackup.toNewShelfJson(rawBook)?.let { Json.parseToJsonElement(it) as? JsonObject }
                    ?: return@mapNotNull null else rawBook as? JsonObject ?: return@mapNotNull null
            val origin = book["origin"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val url = book["bookUrl"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            if (origin != source.id && origin in originalIds && SourceCodec.normalizeSourceId(origin) == source.id)
                SourceVersionLink(origin, url) else null
        }.distinct()
        require(request.relink.all { it in candidates }) { "重新关联缺少原始留档证据" }
        return source to candidates
    }

    fun preview(request: SourceVersionRequest): SourceVersionPreview {
        val (source, candidates) = selection(request)
        return database.previewSourceVersion(source, request, candidates)
    }

    fun activate(request: SourceVersionRequest,
        idle: (Set<String>, () -> SourceVersionResult) -> SourceVersionResult = { _, action -> action() },
    ): SourceVersionResult {
        require(request.previewToken?.matches(Regex("[a-f0-9]{64}")) == true) { "请先预览再确认" }
        val (source, candidates) = selection(request)
        return idle(setOf(source.id) + request.relink.map { it.sourceId }) {
            database.activateSourceVersion(source, request, candidates)
        }
    }
}


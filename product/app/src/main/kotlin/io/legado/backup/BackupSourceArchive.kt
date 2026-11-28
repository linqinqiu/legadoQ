package io.legado.backup

import io.legado.source.SourceCodec
import kotlinx.serialization.json.*

/** Recovery evidence only: archived variants are never registered as executable sources. */
internal class BackupSourceArchive(val sources: List<JsonElement>, val shelf: List<JsonElement>) {
    companion object {
        fun validate(name: String, text: String): JsonObject {
            val root = Json.parseToJsonElement(text).jsonObject
            require(root["format"]?.jsonPrimitive?.content == "legadoq-source-variants-v1") { "书源留档格式无效" }
            val hash = root.getValue("backupSha256").jsonPrimitive.content
            require(hash.matches(Regex("[a-f0-9]{64}"))) { "书源留档原包校验值无效" }
            // Recompute only the compact index. Serializing and parsing the full evidence again
            // duplicates tens of MiB of source rules while the importer already holds native data.
            val rebuilt = BackupSourceArchive(root.getValue("bookSource").jsonArray,
                root.getValue("bookshelf").jsonArray)
            require(rebuilt.conflicts.isNotEmpty()) { "书源留档没有冲突记录" }
            require(root["conflicts"] == rebuilt.conflictIndex() &&
                root["mergedVersions"] == JsonPrimitive(rebuilt.mergedVersions)) {
                "书源留档冲突索引无效"
            }
            require(name == BackupMigration.archiveName(text.toByteArray(Charsets.UTF_8))) { "书源留档内容校验失败" }
            return root
        }
    }
    private val groups = sources.mapIndexedNotNull { index, raw ->
        runCatching {
            val text = if (LegacyBackup.isOldSource(raw)) LegacyBackup.toNewSourceJson(raw) else raw.toString()
            SourceCodec.parse(requireNotNull(text)).id to index
        }.getOrNull()
    }.groupBy({ it.first }, { it.second })
    private val conflicts = groups.filterValues { it.size > 1 }
    val mergedVersions = conflicts.values.sumOf { it.size - 1 }
    val validSources = groups.values.sumOf { it.size }
    val uniqueSources = groups.size

    private fun conflictIndex() = buildJsonArray {
        conflicts.forEach { (id, indexes) -> add(buildJsonObject {
            put("normalizedId", id)
            put("sourceIndexes", JsonArray(indexes.map(::JsonPrimitive)))
            put("winnerIndex", indexes.last())
        }) }
    }

    fun text(backupHash: String): String? = if (conflicts.isEmpty()) null else buildJsonObject {
        put("format", "legadoq-source-variants-v1")
        put("backupSha256", backupHash)
        put("mergedVersions", mergedVersions)
        put("notice", "恢复证据，非可执行书源库；本机仍按归一化标识采用包内最后一条。书架 origin 仅保留原值，不自动迁移关联。")
        put("conflicts", conflictIndex())
        // Keep original JSON fields, including old-format fields and annotated URLs.
        put("bookSource", JsonArray(sources))
        put("bookshelf", JsonArray(shelf))
    }.toString()
}

class BackupArchiveException(cause: Throwable) : RuntimeException("书源冲突版本留档失败，本次数据库导入已回滚；请检查留档目录后重新预览", cause)

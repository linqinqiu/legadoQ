package io.legado.backup

import io.legado.data.Database
import kotlinx.serialization.json.*
import java.io.OutputStream
import java.nio.charset.CodingErrorAction
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/** Explicit six-domain + kept-evidence transport. Not an Android or whole-database snapshot. */
internal object BackupMigration {
    const val MANIFEST = "legadoq-migration.json"
    private const val FORMAT = "legadoq-migration-v1"
    private const val PREFIX = "kept/"
    const val MAX_FILES = 1024
    private const val MAX_MANIFEST_BYTES = 1024 * 1024
    val archivePattern = Regex("source-variants-[a-f0-9]{64}\\.json")
    private val nativeNames = setOf("bookSource.json", "bookshelf.json", "bookGroup.json",
        "rssSources.json", "replaceRule.json", "sourceSub.json")

    fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
    fun archiveName(bytes: ByteArray) = "source-variants-${digest(bytes)}.json"
    fun allowed(name: String) = archivePattern.matches(name) || BackupStore.KEEP_NAMES.any { it.equals(name, true) }

    fun export(database: Database, store: BackupStore, out: OutputStream) {
        val kept = store.migrationFiles()
        require(kept.size <= MAX_FILES) { "留档文件过多，请分批保管原始备份" }
        val nonClosing = object : java.io.FilterOutputStream(out) {
            override fun write(bytes: ByteArray, offset: Int, length: Int) { out.write(bytes, offset, length) }
            override fun close() { flush() }
        }
        val zip = object : ZipOutputStream(nonClosing) {
            var total = 0L
            var current = 0L
            override fun putNextEntry(entry: ZipEntry) { current = 0; super.putNextEntry(entry) }
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                current += length; total += length
                require(current <= BackupImporter.MAX_ENTRY_BYTES && total <= BackupImporter.MAX_TOTAL_BYTES) {
                    "迁移包展开大小超过导入上限，请单独下载留档"
                }
                super.write(bytes, offset, length)
            }
        }
        zip.use {
        BackupExporter.writeAll(database, zip)
        val manifest = buildJsonObject {
            put("format", FORMAT)
            put("files", buildJsonArray {
                kept.forEach { (name, bytes) -> add(buildJsonObject {
                    put("name", "$PREFIX$name"); put("bytes", bytes.size); put("sha256", digest(bytes))
                }) }
            })
        }.toString().toByteArray(Charsets.UTF_8)
        zip.putNextEntry(ZipEntry(MANIFEST)); zip.write(manifest); zip.closeEntry()
        kept.forEach { (name, bytes) ->
            zip.putNextEntry(ZipEntry("$PREFIX$name")); zip.write(bytes); zip.closeEntry()
        }
        }
    }

    /** Validate every byte before parsing native domains or writing anything. No filesystem extraction. */
    fun read(zip: ZipFile, entries: List<ZipEntry>): List<Pair<String, String>>? = try {
        readValidated(zip, entries)
    } catch (error: java.nio.charset.CharacterCodingException) {
        throw IllegalArgumentException("迁移包文本编码无效", error)
    } catch (error: NoSuchElementException) {
        throw IllegalArgumentException("迁移包清单或留档缺少必需字段", error)
    }

    private fun readValidated(zip: ZipFile, entries: List<ZipEntry>): List<Pair<String, String>>? {
        val marker = entries.singleOrNull { it.name == MANIFEST }
        if (marker == null) {
            require(entries.none { it.name == MANIFEST || it.name.startsWith(PREFIX) || archivePattern.matches(it.name.substringAfterLast('/')) }) {
                "迁移包缺少或重复清单"
            }
            return null
        }
        require(entries.size <= MAX_FILES + nativeNames.size + 1 && entries.map { it.name }.distinct().size == entries.size) {
            "迁移包条目过多或路径重复"
        }
        val keptNames = entries.filter { it.name.startsWith(PREFIX) }.map { it.name.lowercase() }
        require(keptNames.distinct().size == keptNames.size) { "迁移包留档名称大小写冲突" }
        require(entries.all { it.name in nativeNames || it.name == MANIFEST ||
            (it.name.startsWith(PREFIX) && allowed(it.name.removePrefix(PREFIX))) }) { "迁移包包含未知路径" }
        require(nativeNames.all { name -> entries.any { it.name == name } }) { "迁移包缺少原生域" }
        var actual = 0L
        fun readBytes(entry: ZipEntry, limit: Long = BackupImporter.MAX_ENTRY_BYTES): ByteArray {
            val bytes = zip.getInputStream(entry).use { it.readNBytes((limit + 1).toInt()) }
            actual += bytes.size
            require(bytes.size <= limit && actual <= BackupImporter.MAX_TOTAL_BYTES) { "迁移包展开大小超过导入上限" }
            return bytes
        }
        fun utf8(bytes: ByteArray) = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        val root = Json.parseToJsonElement(utf8(readBytes(marker, MAX_MANIFEST_BYTES.toLong()))).jsonObject
        require(root["format"]?.jsonPrimitive?.content == FORMAT) { "迁移包版本不受支持" }
        val files = root.getValue("files").jsonArray
        require(files.size <= MAX_FILES) { "迁移包清单记录过多" }
        val records = files.map { it.jsonObject }
        val names = records.map { it.getValue("name").jsonPrimitive.content }
        require(names.distinct().size == names.size && names.toSet() == entries.filter { it.name.startsWith(PREFIX) }.map { it.name }.toSet()) {
            "迁移包留档与清单不一致"
        }
        val expected = records.associateBy { it.getValue("name").jsonPrimitive.content }
        val kept = mutableListOf<Pair<String, String>>()
        entries.filter { it.name != MANIFEST }.forEach { entry ->
            val bytes = readBytes(entry)
            if (entry.name.startsWith(PREFIX)) {
                val record = expected.getValue(entry.name)
                require(record["bytes"]?.jsonPrimitive?.long == bytes.size.toLong() &&
                    record["sha256"]?.jsonPrimitive?.content == digest(bytes)) { "迁移包留档校验失败" }
                val name = entry.name.removePrefix(PREFIX)
                val text = utf8(bytes)
                if (archivePattern.matches(name)) BackupSourceArchive.validate(name, text)
                kept += name to text
            }
        }
        return kept
    }
}

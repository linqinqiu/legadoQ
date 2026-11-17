package io.legado

import io.legado.backup.BackupExporter
import io.legado.backup.BackupImporter
import io.legado.model.BackupShelfEntry
import io.legado.model.BookshelfWriteRequest
import io.legado.model.ReadingProgress
import io.legado.model.ReplaceRule
import io.legado.data.Database
import io.legado.data.assignBookGroup
import io.legado.data.createBookGroup
import io.legado.data.forEachRssPayload
import io.legado.data.forEachShelfEntry
import io.legado.data.importRssSources
import io.legado.data.importSources
import io.legado.data.saveReplaceRule
import io.legado.data.saveBookshelf
import io.legado.data.saveProgress
import io.legado.data.setBookshelfCompleted
import io.legado.data.exportReplaceRules
import io.legado.data.listBookGroups
import io.legado.data.exportSources
import io.legado.data.importSources
import io.legado.data.saveReplaceRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.ZipInputStream

/**
 * 备份导出（第一域：书源）的往返判据。
 *
 * 只验"导出 → 导回空库 → 逐条 payload 相等"这一条主链，外加包形状（条目名 + JSON 数组）。
 * 这条判据的价值在**双向**：导入侧的字段映射此前只有单向证据（手机包能进来），
 * 现在必须能把自己吐出去的包原样吃回来。
 */
class BackupExportRoundTripTest {

    private val sources = listOf(
        """{"bookSourceUrl":"https://alpha.example/##甲","bookSourceName":"甲源","bookSourceGroup":"测试","enabled":true,"ruleSearch":{"bookList":"@css:.item","name":"@css:.name"},"ruleContent":{"content":"@css:.content"}}""",
        """{"bookSourceUrl":"https://beta.example/##乙","bookSourceName":"乙源","enabled":false}""",
    )

    @Test
    fun `导出的书源包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            assertEquals(2, source.importSources(sources).imported)

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportSources(source, it) }.toByteArray()

            // 包形状：唯一一条 bookSource.json，内容是一整个 JSON 数组
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                val entry = zip.nextEntry
                assertEquals("bookSource.json", entry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两条书源都要在包里", text.contains("甲源") && text.contains("乙源"))
            }

            // 导回空库：数量一致，且逐条 payload 与源库完全相同
            val archive = directory.resolve("export.zip")
            Files.write(archive, bytes)
            assertEquals(2, BackupImporter(target).import(archive).sources)
            assertEquals(source.exportSources(null), target.exportSources(null))
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `空库导出的仍然是一个合法的空数组`() {
        val directory = Files.createTempDirectory("legado-backup-export-empty")
        val database = Database(directory.resolve("empty.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            database.initialize()
            target.initialize()
            val bytes = ByteArrayOutputStream().also { BackupExporter.exportSources(database, it) }.toByteArray()
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("bookSource.json", zip.nextEntry?.name)
                assertEquals("[]", zip.readBytes().toString(Charsets.UTF_8))
            }

            // 空包也必须是能导回来的包：以前导入侧只认"有内容"的段，这种包被判成
            // 不是可识别的备份 —— 用户自己导出来的东西导不回去，比报错更让人困惑。
            val archive = directory.resolve("empty.zip")
            Files.write(archive, bytes)
            assertEquals("空包导入回来是 0 条，不是抛错", 0, BackupImporter(target).import(archive).sources)
        } finally {
            database.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `导出的替换规则包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export-rules")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            source.saveReplaceRule(
                ReplaceRule(
                    name = "去广告",
                    group = "净化",
                    pattern = "<div class=\"ad\".*?</div>",
                    replacement = "",
                    isRegex = true,
                    scope = ".*",
                    excludeScope = null,
                    scopeTitle = true,
                    scopeContent = true,
                    isEnabled = true,
                    order = 1,
                    timeoutMillisecond = 3000L,
                ),
            )
            source.saveReplaceRule(
                ReplaceRule(
                    name = "换行合并",
                    group = null,
                    pattern = "\\n+",
                    replacement = "\n",
                    isRegex = false,
                    scope = null,
                    excludeScope = ".*漫画.*",
                    scopeTitle = false,
                    scopeContent = false,
                    isEnabled = false,
                    order = 2,
                    timeoutMillisecond = 800L,
                ),
            )

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportReplaceRules(source, it) }.toByteArray()

            // 包形状：唯一一条 replaceRule.json，内容是一整个 JSON 数组
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("replaceRule.json", zip.nextEntry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两条规则都要在包里", text.contains("去广告") && text.contains("换行合并"))
            }

            val archive = directory.resolve("rules.zip")
            Files.write(archive, bytes)
            assertEquals("导入条数", 2, BackupImporter(target).import(archive).rules)

            // 逐字段比对：id 也一起比（导出带 id，导入按 id upsert）
            assertEquals(
                "规则字段必须逐条相同",
                source.exportReplaceRules(null).map(::comparable),
                target.exportReplaceRules(null).map(::comparable),
            )
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }


    @Test
    fun `导出的分组包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export-groups")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            source.createBookGroup("玄幻")
            source.createBookGroup("都市")

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportBookGroups(source, it) }.toByteArray()

            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("bookGroup.json", zip.nextEntry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两个分组都要在包里", text.contains("玄幻") && text.contains("都市"))
            }

            val archive = directory.resolve("groups.zip")
            Files.write(archive, bytes)
            assertEquals("导入条数", 2, BackupImporter(target).import(archive).bookGroups)

            // 分组号由导入侧按**名字**重新映射（importBookGroupsOn 的语义），所以比名字与条数、不硬比 id：
            // 源库分组号是 3、7 时导进空库会变成 1、2，这是设计如此（见设计文档 §6 开放问题 1）。
            assertEquals(source.listBookGroups().map { it.name }, target.listBookGroups().map { it.name })
            assertEquals(2, target.listBookGroups().size)
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `导出的 RSS 源包能原样导回空库`() {
        val directory = Files.createTempDirectory("legado-backup-export-rss")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            val rss = listOf(
                """{"sourceUrl":"https://rss-a.example/feed","sourceName":"甲订阅","sourceGroup":"科技","enabled":true,"ruleArticles":"@css:.item"}""",
                """{"sourceUrl":"https://rss-b.example/feed","sourceName":"乙订阅","enabled":false}""",
            )
            assertEquals("导入条数", 2, source.importRssSources(rss).imported)

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportRssSources(source, it) }.toByteArray()

            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("rssSources.json", zip.nextEntry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("两条订阅都要在包里", text.contains("甲订阅") && text.contains("乙订阅"))
            }

            val archive = directory.resolve("rss.zip")
            Files.write(archive, bytes)
            assertEquals("导入条数", 2, BackupImporter(target).import(archive).rssSources)

            // payload 原样往返：库里存的就是上游那份 JSON 原文，导出再导入后应逐字相同
            assertEquals("RSS payload 必须逐条相同", rssPayloads(source), rssPayloads(target))
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    /** 按导出同款顺序（名字升序）取全部 RSS payload 原文。 */
    private fun rssPayloads(database: Database): List<String> {
        val list = mutableListOf<String>()
        database.forEachRssPayload { list += it }
        return list
    }


    @Test
    fun `导出的书架包能原样导回空库（含进度与分组）`() {
        val directory = Files.createTempDirectory("legado-backup-export-shelf")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            val sourceId = "https://shelf-a.example/"
            val bookUrl = "https://shelf-a.example/book/1"
            source.saveBookshelf(
                BookshelfWriteRequest(
                    sourceId = sourceId,
                    bookUrl = bookUrl,
                    name = "甲书",
                    author = "作者甲",
                    tocUrl = "https://shelf-a.example/book/1/toc",
                    coverUrl = "https://img.example/a.jpg",
                ),
                cover = null,
            )
            source.saveProgress(ReadingProgress(sourceId, bookUrl, "chapter-7", 7, 0.25, 123))
            source.assignBookGroup(sourceId, bookUrl, source.createBookGroup("玄幻").id)
            source.setBookshelfCompleted(sourceId, bookUrl, true)

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportBookshelf(source, it) }.toByteArray()

            // 书架域刻意带两条：分组必须跟着一起走，否则导回去全掉进「未分组」
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                assertEquals("bookGroup.json", zip.nextEntry?.name)
                val groupsText = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("分组要一起导出", groupsText.contains("玄幻"))
            }
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                zip.nextEntry
                assertEquals("bookshelf.json", zip.nextEntry?.name)
                val text = zip.readBytes().toString(Charsets.UTF_8)
                assertTrue("必须是 JSON 数组：${text.take(40)}", text.startsWith("[") && text.endsWith("]"))
                assertTrue("kind 要写成上游的「完结」，不是 true", text.contains("\"kind\":\"完结\""))
                assertTrue("group 要写原 group_id", text.contains("\"group\":"))
            }

            val archive = directory.resolve("shelf.zip")
            Files.write(archive, bytes)
            assertEquals("导入本数", 1, BackupImporter(target).import(archive).books)

            val mine = shelfEntries(source).single()
            val back = shelfEntries(target).single()
            assertEquals("书名", mine.name, back.name)
            assertEquals("作者", mine.author, back.author)
            assertEquals("书源", mine.sourceId, back.sourceId)
            assertEquals("目录地址", mine.tocUrl, back.tocUrl)
            assertEquals("封面", mine.coverUrl, back.coverUrl)
            assertEquals("完结标记", true, back.completed)
            assertEquals("章序号", 7, back.chapterIndex)
            assertEquals("章内偏移", 123, back.chapterPos)
            assertEquals("读到时间", mine.readAt, back.readAt)

            // 分组号由导入侧按名字重映射：空库里新分组是 1 号，名字必须对上
            assertEquals("分组名", listOf("玄幻"), target.listBookGroups().map { it.name })
            assertEquals("挂到分组上", 1L, back.phoneGroupId)
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }


    @Test
    fun `完整备份包一次带齐五域，导回空库都在`() {
        val directory = Files.createTempDirectory("legado-backup-export-all")
        val source = Database(directory.resolve("source.sqlite").toString())
        val target = Database(directory.resolve("target.sqlite").toString())
        try {
            source.initialize()
            target.initialize()
            source.importSources(listOf("""{"bookSourceUrl":"https://all.example/","bookSourceName":"全量源","enabled":true}"""))
            source.saveReplaceRule(ReplaceRule(name = "全量规则", pattern = "广告", replacement = ""))
            val group = source.createBookGroup("全量分组")
            source.importRssSources(listOf("""{"sourceUrl":"https://all.example/feed","sourceName":"全量订阅"}"""))
            val sourceId = "https://all.example/"
            val bookUrl = "https://all.example/book/1"
            source.saveBookshelf(
                BookshelfWriteRequest(sourceId = sourceId, bookUrl = bookUrl, name = "全量书", tocUrl = bookUrl),
                cover = null,
            )
            source.saveProgress(ReadingProgress(sourceId, bookUrl, "c3", 3, 0.0, 42))
            source.assignBookGroup(sourceId, bookUrl, group.id)

            val bytes = ByteArrayOutputStream().also { BackupExporter.exportAll(source, it) }.toByteArray()

            // 一个包里五个条目，名字与导入侧认的那五个一致
            val names = mutableSetOf<String>()
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    names += entry.name
                    assertTrue("${entry.name} 必须是 JSON 数组", zip.readBytes().toString(Charsets.UTF_8).trim().startsWith("["))
                }
            }
            assertEquals("五域都要在包里", setOf("bookSource.json", "replaceRule.json", "bookGroup.json", "rssSources.json", "bookshelf.json"), names)

            val archive = directory.resolve("all.zip")
            Files.write(archive, bytes)
            val summary = BackupImporter(target).import(archive)
            assertEquals("书源", 1, summary.sources)
            assertEquals("替换规则", 1, summary.rules)
            assertEquals("分组", 1, summary.bookGroups)
            assertEquals("RSS", 1, summary.rssSources)
            assertEquals("书", 1, summary.books)
            assertEquals("进度", 1, summary.progress)
            assertTrue("不该有报错：${summary.errors}", summary.errors.isEmpty())
            assertEquals(shelfEntries(source).single().name, shelfEntries(target).single().name)
        } finally {
            source.close()
            target.close()
            directory.toFile().deleteRecursively()
        }
    }

    /** 按导出同款顺序（书名升序）取书架条目。 */
    private fun shelfEntries(database: Database): List<BackupShelfEntry> {
        val list = mutableListOf<BackupShelfEntry>()
        database.forEachShelfEntry { list += it }
        return list
    }

    /** 参与往返比对的字段；createdAt/updatedAt 是导入时按当前时间写的，不比。 */
    private fun comparable(rule: ReplaceRule): List<Any?> = listOf(
        rule.id, rule.name, rule.group, rule.pattern, rule.replacement, rule.isRegex,
        rule.scope, rule.excludeScope, rule.scopeTitle, rule.scopeContent,
        rule.isEnabled, rule.order, rule.timeoutMillisecond,
    )
}

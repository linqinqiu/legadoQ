package io.legado

import io.legado.backup.*
import io.legado.cache.BookCacheService
import io.legado.cache.CoverCache
import io.legado.data.Database
import io.legado.data.SourceVersionBusy
import io.legado.data.SourceVersionChanged
import io.legado.data.SourceVersionSnapshotFailed
import io.legado.data.getSource
import io.legado.data.listSources
import io.legado.data.saveSource
import io.legado.data.core.DbSnapshot
import io.legado.model.*
import io.legado.rules.RuleRunner
import io.legado.source.SourceCodec
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class BackupSourceVersionsTest {
    @Test fun `冲突留档按规范ID列出原始版本 预览不写数据库和安全快照`() = SourceVersionsFixture().use { f ->
        val before = f.state()
        val snapshots = DbSnapshot.list(f.db.dbPath)
        val evidence = Files.readAllBytes(f.archivePath)
        val listing = f.versions.list(SourceVersionListRequest(f.archive))
        assertEquals(1, listing.total)
        val group = listing.groups.single()
        assertEquals(f.canonical, group.sourceId)
        assertEquals(listOf(f.alias, f.secondAlias), group.variants.map { it.originalId })
        assertEquals(listOf(false, true), group.variants.map { it.winner })
        assertEquals(1, f.versions.list(SourceVersionListRequest(f.archive, query = "甲")).total)
        assertTrue(f.versions.list(SourceVersionListRequest(f.archive, offset = 1)).groups.isEmpty())
        assertTrue(f.versions.list(SourceVersionListRequest(f.archive, query = "不存在")).groups.isEmpty())
        assertFalse(f.store.list().single().appliable)
        assertEquals(listOf(f.canonical), f.db.listSources(null).map { it.id })

        val preview = f.versions.preview(f.request())
        assertEquals(f.canonical, preview.sourceId)
        assertEquals("甲", preview.name)
        assertEquals(f.db.getSource(f.canonical)!!.version, preview.sourceVersion)
        assertEquals(1, preview.affectedBooks)
        assertEquals(listOf("规范书"), preview.affectedBookNames)
        assertEquals(3, preview.cacheEntries)
        assertEquals(setOf("one", "other", "two"), preview.aliases.map { it.bookUrl }.toSet())
        assertTrue(preview.aliases.none { it.conflict })
        assertTrue(preview.previewToken.matches(Regex("[a-f0-9]{64}")))
        assertTrue(preview.warnings.isNotEmpty())
        assertEquals(preview, f.versions.preview(f.request()))
        assertEquals(before, f.state())
        assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
        assertArrayEquals(evidence, Files.readAllBytes(f.archivePath))
    }

    @Test fun `激活旧规则保留本机启停排序正文和凭据 清除旧体检并递增版本`() = SourceVersionsFixture().use { f ->
        f.execute("update source set enabled=0,sort_order=37,source_group='本机,体检异常' where id=?", f.canonical)
        f.execute("insert into source_health(source_id,name,ok,status_category,checked_at) values(?,?,1,'ok',123)", f.canonical, "乙")
        val caches = listOf("book_content_cache", "book_content_process", "book_toc_cache").associateWith(f::table)
        val credentials = listOf("script_cache", "source_login_state").associateWith(f::table)
        val old = f.db.getSource(f.canonical)!!
        val evidence = Files.readAllBytes(f.archivePath)
        val request = f.confirmed()
        val result = f.versions.activate(request)

        assertEquals(f.canonical, result.sourceId)
        assertEquals(0, result.relinked)
        assertTrue(DbSnapshot.isVerified(f.db.dbPath, result.snapshot))
        val source = f.db.getSource(f.canonical)!!
        assertEquals(old.version + 1, source.version)
        assertEquals("甲", Json.parseToJsonElement(source.json).jsonObject.getValue("bookSourceName").jsonPrimitive.content)
        assertEquals(f.canonical, Json.parseToJsonElement(source.json).jsonObject.getValue("bookSourceUrl").jsonPrimitive.content)
        val stored = f.rows("select enabled,sort_order,source_group from source where id=?", f.canonical).single()
        assertEquals("0", stored["enabled"])
        assertEquals("37", stored["sort_order"])
        assertEquals("甲分组", stored["source_group"])
        assertTrue(f.table("source_health").isEmpty())
        assertEquals(caches, caches.keys.associateWith(f::table))
        assertEquals(credentials, credentials.keys.associateWith(f::table))
        assertArrayEquals(evidence, Files.readAllBytes(f.archivePath))
    }

    @Test fun `只重关联勾选的别名书籍逐列保留元数据 并能关闭重开从安全快照恢复`() = SourceVersionsFixture().use { f ->
        val before = f.state()
        val oldPayload = f.db.getSource(f.canonical)!!.json
        val selected = f.link()
        val byBook = f.bookTables.associateWith { f.bookRows(it, f.alias, "one") }
        val originalToc = f.rows("select * from book_toc_cache where source_id=? order by toc_url", f.alias)
        val evidence = Files.readAllBytes(f.archivePath)
        val result = f.versions.activate(f.confirmed(listOf(selected)))
        assertEquals(1, result.relinked)
        assertTrue(DbSnapshot.isVerified(f.db.dbPath, result.snapshot))
        f.bookTables.forEach { table ->
            assertTrue("$table 旧关联应迁出", f.bookRows(table, f.alias, "one").isEmpty())
            assertEquals("$table 只允许 source_id 改变", byBook.getValue(table).map { it + ("source_id" to f.canonical) },
                f.bookRows(table, f.canonical, "one"))
            assertEquals(before.getValue(table).filter { it["source_id"] == f.alias && it["book_url"] == "other" },
                f.bookRows(table, f.alias, "other"))
        }
        assertEquals(originalToc, f.rows("select * from book_toc_cache where source_id=? order by toc_url", f.alias))
        originalToc.filter { it["toc_url"] in setOf("one", "toc-one") }.forEach { row ->
            assertEquals(listOf(row + ("source_id" to f.canonical)),
                f.rows("select * from book_toc_cache where source_id=? and toc_url=?", f.canonical, row.getValue("toc_url")))
        }
        for (table in listOf("script_cache", "source_login_state")) assertEquals(before[table], f.table(table))
        assertArrayEquals(evidence, Files.readAllBytes(f.archivePath))
        assertTrue(DbSnapshot.scheduleRestore(f.db.dbPath, result.snapshot))
        assertNotEquals(oldPayload, f.db.getSource(f.canonical)!!.json)
        f.reopenFromPendingRestore()
        assertEquals(oldPayload, f.db.getSource(f.canonical)!!.json)
        assertEquals(before, f.state())
        assertFalse(Files.exists(DbSnapshot.backupsDirOf(f.db.dbPath).resolve(".pending-restore")))
        assertArrayEquals(evidence, Files.readAllBytes(f.archivePath))
    }

    @Test fun `源规则书架和阅读进度变化使预览凭证失效且无额外写入`() {
        val mutations: List<(SourceVersionsFixture) -> Unit> = listOf(
            { f -> f.execute("update source set version=version+1 where id=?", f.canonical) },
            { f -> f.execute("update book_shelf set name='新书名' where source_id=?", f.canonical) },
            { f -> f.execute("update reading_progress set chapter_index=chapter_index+1 where source_id=?", f.canonical) },
            { f -> f.execute("update book_shelf set author='新作者' where source_id=? and book_url='one'", f.alias) },
            { f -> f.execute("update reading_progress set char_offset=999 where source_id=? and book_url='one'", f.alias) },
        )
        mutations.forEach { mutate -> SourceVersionsFixture().use { f ->
            val request = f.confirmed(listOf(f.link()))
            mutate(f)
            val changed = f.state()
            val snapshots = DbSnapshot.list(f.db.dbPath)
            assertThrows(SourceVersionChanged::class.java) { f.versions.activate(request) }
            assertEquals(changed, f.state())
            assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
        } }
    }

    @Test fun `激活凭证不可重放且改变勾选书籍必须重新预览`() = SourceVersionsFixture().use { f ->
        val unselected = f.confirmed()
        assertThrows(SourceVersionChanged::class.java) { f.versions.activate(unselected.copy(relink = listOf(f.link()))) }
        f.versions.activate(unselected)
        val once = f.state()
        val snapshots = DbSnapshot.list(f.db.dbPath)
        assertThrows(SourceVersionChanged::class.java) { f.versions.activate(unselected) }
        assertEquals(once, f.state())
        assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
    }

    @Test fun `目标墓碑和孤儿进度笔记及缓存均标冲突且禁止覆盖`() {
        val blockers = listOf(
            "insert into book_shelf_tombstone(source_id,book_url,deleted_at) values(?,'one',901)",
            "insert into reading_progress(source_id,book_url,chapter_url,chapter_index,updated_at) values(?,'one','orphan',9,902)",
            "insert into book_note(source_id,book_url,start_offset,end_offset,excerpt,created_at,updated_at) values(?,'one',1,2,'orphan-note',903,904)",
            "insert into book_content_cache(source_id,book_url,chapter_url,content,cached_at) values(?,'one','orphan','orphan-cache',905)",
            "insert into book_content_process(source_id,book_url,chapter_url,kind,original,processed,updated_at) values(?,'one','orphan','replace','raw','processed',906)",
            "insert into book_cache_status(source_id,book_url,state,updated_at) values(?,'one','idle',907)",
            "insert into book_toc_cache(source_id,toc_url,chapters_json,updated_at) values(?,'toc-one','[]',908)",
            "insert into book_shelf(source_id,book_url,name,toc_url,last_read_at) values(?,'one','existing','existing-toc',909)",
        )
        blockers.forEach { blocker -> SourceVersionsFixture().use { f ->
            f.execute(blocker, f.canonical)
            val selected = f.request(listOf(f.link()))
            val preview = f.versions.preview(selected)
            assertTrue(blocker, preview.aliases.single { it.bookUrl == "one" }.conflict)
            val before = f.state()
            val snapshots = DbSnapshot.list(f.db.dbPath)
            assertThrows(SourceVersionChanged::class.java) { f.versions.activate(selected.copy(previewToken = preview.previewToken)) }
            assertEquals(before, f.state())
            assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
        } }
    }

    @Test fun `未勾选的冲突别名不阻止只激活规则且该别名保持原样`() = SourceVersionsFixture().use { f ->
        f.execute("insert into book_shelf_tombstone(source_id,book_url,deleted_at) values(?,'one',901)", f.canonical)
        val before = f.bookTables.associateWith(f::table)
        val result = f.versions.activate(f.confirmed())
        assertEquals(0, result.relinked)
        assertEquals(before, f.bookTables.associateWith(f::table))
    }

    @Test fun `同时勾选同一别名下共享目录的两书时目录只复制一次`() = SourceVersionsFixture().use { f ->
        f.execute("update book_shelf set toc_url='toc-one' where source_id=? and book_url='other'", f.alias)
        val original = f.rows("select * from book_toc_cache where source_id=? and toc_url='toc-one'", f.alias).single()
        val request = f.confirmed(listOf(f.link(), SourceVersionLink(f.alias, "other")))
        val result = f.versions.activate(request)
        assertEquals(2, result.relinked)
        assertEquals(listOf(original + ("source_id" to f.canonical)),
            f.rows("select * from book_toc_cache where source_id=? and toc_url='toc-one'", f.canonical))
        assertEquals(listOf(original), f.rows("select * from book_toc_cache where source_id=? and toc_url='toc-one'", f.alias))
        assertTrue(f.bookRows("book_shelf", f.alias, "one").isEmpty())
        assertTrue(f.bookRows("book_shelf", f.alias, "other").isEmpty())
        assertEquals(1, f.bookRows("book_shelf", f.canonical, "one").size)
        assertEquals(1, f.bookRows("book_shelf", f.canonical, "other").size)
        assertTrue(DbSnapshot.isVerified(f.db.dbPath, result.snapshot))
    }

    @Test fun `不同别名书籍共享同一目录键时拒绝混合缓存且不创建快照`() = SourceVersionsFixture().use { f ->
        f.execute("update book_shelf set toc_url='shared-toc' where source_id=? and book_url='one'", f.alias)
        f.execute("update book_shelf set toc_url='shared-toc' where source_id=? and book_url='two'", f.secondAlias)
        f.execute("insert into book_toc_cache(source_id,toc_url,chapters_json,updated_at) values(?,'shared-toc',?,201)",
            f.alias, """[{"title":"甲目录"}]""")
        f.execute("insert into book_toc_cache(source_id,toc_url,chapters_json,updated_at) values(?,'shared-toc',?,202)",
            f.secondAlias, """[{"title":"乙目录"}]""")
        val request = f.confirmed(listOf(f.link(), SourceVersionLink(f.secondAlias, "two")))
        val before = f.state()
        val snapshots = DbSnapshot.list(f.db.dbPath)
        val evidence = Files.readAllBytes(f.archivePath)
        assertThrows(SourceVersionChanged::class.java) { f.versions.activate(request) }
        assertEquals(before, f.state())
        assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
        assertArrayEquals(evidence, Files.readAllBytes(f.archivePath))
    }

    @Test fun `重关联中途SQL失败则规则及全部书籍数据回滚并保留安全快照`() = SourceVersionsFixture().use { f ->
        f.execute("""create trigger reject_note_relink before update of source_id on book_note
            begin select raise(abort,'synthetic-failure'); end""")
        val request = f.confirmed(listOf(f.link()))
        val before = f.state()
        val snapshots = DbSnapshot.list(f.db.dbPath).map { it.name }.toSet()
        assertThrows(java.sql.SQLException::class.java) { f.versions.activate(request) }
        assertEquals(before, f.state())
        val safety = DbSnapshot.list(f.db.dbPath).filter { it.name !in snapshots }
        assertEquals(1, safety.size)
        assertTrue(safety.single().verified)
    }

    @Test fun `仍有缓存任务时拒绝激活且不创建快照`() = SourceVersionsFixture().use { f ->
        f.execute("update book_cache_status set state='caching' where source_id=?", f.canonical)
        val before = f.state()
        val snapshots = DbSnapshot.list(f.db.dbPath)
        assertThrows(SourceVersionBusy::class.java) { f.versions.activate(f.confirmed()) }
        assertEquals(before, f.state())
        assertEquals(snapshots, DbSnapshot.list(f.db.dbPath))
    }

    @Test fun `缓存目录请求未结束及取消后未退出时均保持书源切换守卫`() = SourceVersionsFixture().use { f ->
        f.db.saveSource(SourceCodec.parse("""{"bookSourceUrl":"${f.canonical}","ruleToc":{"chapterList":"$.data","chapterName":"$.title","chapterUrl":"$.url"}}"""), null)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val fetchExited = CountDownLatch(1)
        val requests = AtomicInteger()
        val actions = AtomicInteger()
        val runner = RuleRunner { url ->
            check(url == "https://book-cache.test/toc") { "Unexpected URL: $url" }
            requests.incrementAndGet()
            entered.countDown()
            try {
                check(release.await(30, TimeUnit.SECONDS)) { "Directory response was not released" }
                """{"data":[{"title":"第一章","url":"https://book-cache.test/one"}]}"""
            } finally {
                fetchExited.countDown()
            }
        }
        val service = BookCacheService(f.db, runner, CoverCache(f.directory.resolve("covers"))) {}
        try {
            service.enqueue(CachedBookRequest(f.canonical, "canonical", "https://book-cache.test/toc"))
            assertTrue("目录请求应已进入阻塞点", entered.await(10, TimeUnit.SECONDS))
            assertEquals("idle", f.bookRows("book_cache_status", f.canonical, "canonical").single()["state"])
            assertThrows(SourceVersionBusy::class.java) {
                service.withSourcesIdle(setOf(f.canonical)) { actions.incrementAndGet() }
            }
            assertEquals("不相关书源不应被阻塞", "allowed", service.withSourcesIdle(setOf(f.alias)) { "allowed" })
            service.cancel(f.canonical, "canonical")
            assertEquals("取消协程尚未结束同步目录请求", 1L, fetchExited.count)
            assertThrows(SourceVersionBusy::class.java) {
                service.withSourcesIdle(setOf(f.canonical)) { actions.incrementAndGet() }
            }
            assertEquals(0, actions.get())
            release.countDown()
            assertTrue(fetchExited.await(10, TimeUnit.SECONDS))
            service.stop()
            assertEquals(1, service.withSourcesIdle(setOf(f.canonical)) { actions.incrementAndGet() })
            assertEquals(1, actions.get())
            assertEquals(1, requests.get())
        } finally {
            release.countDown()
            service.stop()
        }
    }

    @Test fun `快照目录被文件阻挡则强制中止且所有数据不变`() = SourceVersionsFixture().use { f ->
        val request = f.confirmed(listOf(f.link()))
        val before = f.state()
        f.blockSnapshots {
            assertThrows(SourceVersionSnapshotFailed::class.java) { f.versions.activate(request) }
            assertEquals(before, f.state())
        }
    }

    @Test fun `路径篡改留档损坏无效版本及无证据关联均不能写入`() = SourceVersionsFixture().use { f ->
        val before = f.state()
        for (name in listOf("../${f.archive}", "kept/${f.archive}", f.archivePath.toString(), "readConfig.json")) {
            assertThrows(IllegalArgumentException::class.java) { f.versions.list(SourceVersionListRequest(name)) }
            assertThrows(IllegalArgumentException::class.java) { f.versions.preview(f.request().copy(archive = name)) }
        }
        for (index in listOf(-1, 2, Int.MAX_VALUE)) {
            assertThrows(IllegalArgumentException::class.java) { f.versions.preview(f.request().copy(index = index)) }
        }
        assertThrows(IllegalArgumentException::class.java) { f.versions.list(SourceVersionListRequest(f.archive, offset = -1)) }
        assertThrows(IllegalArgumentException::class.java) { f.versions.list(SourceVersionListRequest(f.archive, query = "x".repeat(201))) }
        assertThrows(IllegalArgumentException::class.java) { f.versions.activate(f.request()) }
        assertThrows(IllegalArgumentException::class.java) { f.versions.preview(f.request(listOf(SourceVersionLink(f.alias, "invented")))) }
        assertThrows(IllegalArgumentException::class.java) { f.versions.preview(f.request(listOf(f.link(), f.link()))) }
        Files.writeString(f.archivePath, Files.readString(f.archivePath).replace("旧规则-secret", "tampered-rule"))
        assertThrows(IllegalArgumentException::class.java) { f.versions.list(SourceVersionListRequest(f.archive)) }
        assertThrows(IllegalArgumentException::class.java) { f.versions.preview(f.request()) }
        assertEquals(before, f.state())
    }
}

/** Synthetic source evidence and an isolated SQLite database; never opens the user's library. */
internal class SourceVersionsFixture : Closeable {
    val directory: Path = Files.createTempDirectory("legado-source-versions-")
    private val databasePath = directory.resolve("test.sqlite").toString()
    var db = Database(databasePath)
        private set
    val store = BackupStore(directory.resolve("kept"))
    val canonical = "https://versions.example/"
    val alias = "$canonical#甲"
    val secondAlias = "$canonical#乙"
    val archive: String
    val archivePath: Path get() = directory.resolve("kept").resolve(archive)
    val versions: BackupSourceVersions get() = BackupSourceVersions(db, store)
    val bookTables = listOf("book_shelf", "reading_progress", "book_note", "reading_log", "book_content_cache", "book_content_process", "book_cache_status")
    private val stateTables = listOf("source", "source_health", "app_meta", "book_toc_cache", "script_cache", "source_login_state", "book_shelf_tombstone") + bookTables

    init {
        db.initialize()
        val input = directory.resolve("synthetic.json")
        Files.writeString(input, """{"bookSource":[
            {"bookSourceUrl":"$alias","bookSourceName":"甲","bookSourceGroup":"甲分组,体检可用","enabled":true,"ruleSearch":{"name":"旧规则-secret"}},
            {"bookSourceUrl":"$secondAlias","bookSourceName":"乙","bookSourceGroup":"乙分组","enabled":true,"ruleSearch":{"name":"新规则-secret"}}
        ],"bookshelf":[
            {"origin":"$alias","bookUrl":"one","name":"书一"},
            {"origin":"$alias","bookUrl":"other","name":"未勾选书"},
            {"origin":"$secondAlias","bookUrl":"two","name":"书二"}
        ]}""")
        archive = BackupImporter(db, store).import(input, sections = setOf("sources")).keptSections.single().name
        seedBook(canonical, "canonical", "规范书")
        seedBook(alias, "one", "书一")
        seedBook(alias, "other", "未勾选书")
        seedBook(secondAlias, "two", "书二")
        for (id in listOf(canonical, alias, secondAlias)) {
            execute("insert into script_cache(source_id,key,value,deadline,updated_at) values(?,'key',?,234,345)", id, "state-$id")
            execute("insert into source_login_state(source_id,login_info,login_header,source_variable,source_kv,cookie_jar,updated_at) values(?,?,'headers','var','kv','cookies',456)", id, "login-$id")
        }
    }

    fun request(relink: List<SourceVersionLink> = emptyList()) = SourceVersionRequest(archive, 0, relink)
    fun confirmed(relink: List<SourceVersionLink> = emptyList()): SourceVersionRequest = request(relink).let { it.copy(previewToken = versions.preview(it).previewToken) }
    fun link() = SourceVersionLink(alias, "one")
    fun execute(sql: String, vararg values: Any?) = db.write { connection ->
        connection.prepareStatement(sql).use { statement ->
            values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
            statement.executeUpdate()
        }
    }
    fun rows(sql: String, vararg values: Any?): List<Map<String, String?>> = db.connect { connection ->
        connection.prepareStatement(sql).use { statement ->
            values.forEachIndexed { index, value -> statement.setObject(index + 1, value) }
            statement.executeQuery().use { result ->
                val metadata = result.metaData
                buildList { while (result.next()) add((1..metadata.columnCount).associate { metadata.getColumnName(it) to result.getString(it) }) }
            }
        }
    }
    fun table(name: String) = rows("select * from $name order by rowid")
    fun state() = stateTables.associateWith(::table)
    fun bookRows(table: String, id: String, book: String) = rows("select * from $table where source_id=? and book_url=? order by rowid", id, book)

    private fun seedBook(id: String, book: String, name: String) {
        execute("""insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,completed,alternate_sources,group_id,toc_rule,sort_order)
            values(?,?,?,'作者',?,'cover','cover-key',100,1,'[{"sourceId":"alternative"}]',7,'^chapter',19)""", id, book, name, "toc-$book")
        execute("""insert into reading_progress(source_id,book_url,chapter_url,chapter_index,updated_at,scroll_position,char_offset,paragraph_anchor,position_version,position_checksum)
            values(?,?,?,3,101,0.375,42,'anchor',2,'progress-checksum')""", id, book, "chapter-$book")
        execute("""insert into book_note(source_id,book_url,book_name,chapter_url,chapter_index,start_offset,end_offset,excerpt,note,bookmark,created_at,updated_at,paragraph_anchor,position_version,position_checksum)
            values(?,?,?,?,3,4,9,'摘录','笔记',1,102,103,'note-anchor',2,'note-checksum')""", id, book, name, "chapter-$book")
        execute("insert into reading_log(day,source_id,book_url,book_name,chapter_index,seconds,updated_at) values('2026-11-28',?,?,?,3,456,104)", id, book, name)
        execute("insert into book_content_cache(source_id,book_url,chapter_url,chapter_index,title,content,cached_at) values(?,?,?,3,'章节','缓存正文',105)", id, book, "chapter-$book")
        execute("insert into book_content_process(source_id,book_url,chapter_url,kind,original,processed,updated_at) values(?,?,?,'replace','原文','净化正文',106)", id, book, "chapter-$book")
        execute("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,12,1,'idle','历史提示',107)", id, book)
        execute("insert into book_toc_cache(source_id,toc_url,chapters_json,updated_at) values(?,?,?,108)", id, "toc-$book", """[{"title":"目录"}]""")
    }

    fun blockSnapshots(action: () -> Unit) {
        val backups = DbSnapshot.backupsDirOf(databasePath)
        val saved = directory.resolve("saved-backups")
        check(backups.normalize().parent == directory.normalize() && saved.normalize().parent == directory.normalize())
        val existed = Files.exists(backups)
        if (existed) Files.move(backups, saved)
        Files.writeString(backups, "block directory")
        try { action() } finally {
            Files.deleteIfExists(backups)
            if (existed) Files.move(saved, backups)
        }
    }

    fun reopenFromPendingRestore() {
        db.close()
        assertTrue(DbSnapshot.applyPendingRestore(databasePath))
        db = Database(databasePath).also { it.initialize() }
    }

    override fun close() {
        db.close()
        directory.toFile().deleteRecursively()
    }
}

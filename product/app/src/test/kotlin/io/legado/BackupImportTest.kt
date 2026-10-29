package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import io.legado.backup.BackupAes
import io.legado.backup.BackupImporter
import io.legado.backup.BackupStore
import io.legado.data.Database
import io.legado.data.cookieBucketMentions
import io.legado.data.createBookGroup
import io.legado.data.deleteRssSource
import io.legado.data.getCookieForUrl
import io.legado.data.getProgress
import io.legado.data.importSources
import io.legado.data.listBookGroups
import io.legado.data.listBookshelf
import io.legado.data.listCookieBuckets
import io.legado.data.listReplaceRules
import io.legado.data.listRssSources
import io.legado.data.listSources
import io.legado.data.rssSourceIsEnabled
import io.legado.data.saveProgress
import io.legado.data.setCookieForUrl
import io.legado.data.setRssSourceEnabled
import io.legado.model.ReadingProgress

/** 备份包导入：只认备份内的固定文件名，且不因缺失条目而失败。 */
class BackupImportTest {
    @Test
    fun `imports sources replace rules shelf and reading progress`() {
        val directory = Files.createTempDirectory("legado-backup-import")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val archive = directory.resolve("backup-2026-07-12-device.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookSource.json" to
                        """[{"bookSourceUrl":"https://example.com/##聚合","bookSourceName":"示例聚合源","enabled":true}]""",
                    "replaceRule.json" to
                        """[{"id":1767407348980,"name":"去广告","pattern":"广告.*","replacement":"","isRegex":true,"isEnabled":true,"order":1,"timeoutMillisecond":3000}]""",
                    "bookshelf.json" to
                        """[{"name":"示例书名","author":"示例作者","bookUrl":"https://example.com/book/1","origin":"https://example.com/##聚合","tocUrl":"https://example.com/book/1","coverUrl":"https://example.com/cover.jpg","kind":"连载中,7.9分","durChapterIndex":261,"durChapterPos":1334,"durChapterTime":1782343455600}]""",
                    "readRecord.json" to """[{"bookName":"示例书名","readTime":100}]""",
                ),
            )

            val summary = BackupImporter(database).import(archive)

            assertEquals(1, summary.sources)
            assertEquals(1, summary.rules)
            assertEquals(1, summary.books)
            assertEquals(1, summary.progress)

            // 书源 id 与书架 origin 都必须归一化到同一个 sourceId，否则书架会挂在不存在的书源上。
            val sources = database.listSources(null)
            assertEquals(1, sources.size)
            assertEquals("https://example.com/", sources.first().id)
            assertEquals(1, database.listReplaceRules().size)

            val shelf = database.listBookshelf()
            assertEquals(1, shelf.size)
            assertEquals("示例书名", shelf.first().name)
            assertEquals("https://example.com/", shelf.first().sourceId)
            assertEquals(261, shelf.first().chapterIndex)

            val progress = database.getProgress("https://example.com/", "https://example.com/book/1")
            assertNotNull(progress)
            assertEquals(261, progress!!.chapterIndex)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `keeps newer reading progress instead of the older backup value`() {
        val directory = Files.createTempDirectory("legado-backup-progress")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.saveProgress(ReadingProgress("https://example.com/", "https://example.com/book/1", "chapter", 900, 0.5))

            val archive = directory.resolve("backup.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookshelf.json" to
                        """[{"name":"示例书名","bookUrl":"https://example.com/book/1","origin":"https://example.com/","tocUrl":"https://example.com/book/1","durChapterIndex":12,"durChapterTime":1}]""",
                ),
            )

            val summary = BackupImporter(database).import(archive)

            assertEquals(0, summary.progress)
            assertEquals(900, database.getProgress("https://example.com/", "https://example.com/book/1")!!.chapterIndex)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `rejects archives without any known backup section`() {
        val directory = Files.createTempDirectory("legado-backup-invalid")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val archive = directory.resolve("random.zip")
            writeArchive(archive, mapOf("notes.txt" to "hello"))

            val error = runCatching { BackupImporter(database).import(archive) }.exceptionOrNull()

            assertTrue("unexpected error: $error", error is IllegalArgumentException)

            // 裸 JSON 同样不能"认不出就当空包成功"
            val stray = directory.resolve("notes.json")
            Files.writeString(stray, """{"notes":"hello"}""")
            val jsonError = runCatching { BackupImporter(database).import(stray) }.exceptionOrNull()
            assertTrue("unexpected error: $jsonError", jsonError is IllegalArgumentException)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 手机备份包里的登录态：`cookies.json` 整份是 `aes.encryptBase64(...)`（上游 `Backup.kt:315-320`），
     * 没密码读不了。恢复时按**注册域**写进全局凭据表并按键合并
     * —— 与上游 `CookieStore.restoreCookie` 同语义。缺密码只跳过这一节，不赔上整包。
     */
    @Test
    fun `restores encrypted cookies when the backup password is given and reports honestly when it is not`() {
        val directory = Files.createTempDirectory("legado-backup-cookies")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val source = """{"bookSourceUrl":"https://fq-book.netsite.cc","bookSourceName":"番茄","loginUrl":"https://fanqienovel.com/"}"""
            // 只在注释里提了一句该域名的源：instr 会命中，但不该领到用户的登录 Cookie
            val freeloader = """{"bookSourceUrl":"https://freeloader.example","bookSourceName":"蹭凭据的源","bookSourceComment":"我引用过 fanqienovel.com 的封面"}"""
            val payload = """[{"url":"fanqienovel.com","cookie":"sessionid=s-1; uid=9"},{"url":"https://old|example.com|sid","cookie":"legacy=1"}]"""
            val archive = directory.resolve("backup2026.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookSource.json" to "[$source,$freeloader]",
                    "cookies.json" to BackupAes.encryptBase64(payload, "备份密码123"),
                ),
            )
            // 先确认加密口径：密文不是 JSON，且用错密码解不出来
            assertTrue(BackupAes.decryptBase64(BackupAes.encryptBase64("round-trip", "pw"), "pw") == "round-trip")

            val noPassword = BackupImporter(database).import(archive)
            assertEquals(0, noPassword.cookies)
            assertTrue(noPassword.cookiesNote ?: "(空)", noPassword.cookiesNote!!.contains("备份密码"))
            assertNull(database.getCookieForUrl("https://fanqienovel.com/x"))

            val wrongPassword = BackupImporter(database).import(archive, "不对的密码")
            assertEquals(0, wrongPassword.cookies)
            assertTrue(wrongPassword.cookiesNote ?: "(空)", wrongPassword.cookiesNote!!.contains("解密失败"))

            val restored = BackupImporter(database).import(archive, "备份密码123")
            // 两条里一条是老 OkHttp 主键格式（带 | ），必须跳过而不是猜一个键
            assertEquals(1, restored.cookies)
            assertTrue(restored.cookiesNote ?: "(空)", (restored.cookiesNote ?: "").contains("老格式"))
            val cookie = database.getCookieForUrl("https://fanqienovel.com/reading/bookapi/bookshelf/info")
            assertTrue(cookie ?: "(空)", cookie != null && cookie.contains("sessionid=s-1") && cookie.contains("uid=9"))
            // 全局按域存之后，恢复出来的是 `fanqienovel.com` 这一桶；蹭凭据的源自己那个域仍然是空的。
            // 它当然也能在"真的去请求 fanqienovel.com"时带上这份凭据 —— 这与上游一致，
            // 浏览器语义本来就是这样；要防的是脚本越域读，见 SourceLoginTest 的沙箱闸测试。
            assertNull(database.getCookieForUrl("https://freeloader.example/"))
            assertEquals(listOf("fanqienovel.com"), database.listCookieBuckets().map { it.domain })

            // 再恢复一次是按键合并而不是堆重复串（同名键覆盖、条数不涨）
            BackupImporter(database).import(archive, "备份密码123")
            val again = database.getCookieForUrl("https://fanqienovel.com/x")!!
            assertEquals(2, again.split(';').size)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 与**独立实现**对表：下面这段密文是用 node `crypto`（aes-128-ecb，key = md5(密码) 十六进制串
     * 前 16 个字符的 ASCII 字节）算出来的，不是我们自己加密的。只跟自己 round-trip 的话，
     * 密钥推导写错也能"通过"，而真手机备份包照样解不开 —— 所以这条向量必须钉住。
     */
    @Test
    fun `backup AES matches an independent implementation byte for byte`() {
        val password = "备份密码123"
        assertEquals("239d482bfd3aa48b", String(BackupAes.keyOf(password), Charsets.UTF_8))
        val plain = """[{"url":"fanqienovel.com","cookie":"sessionid=s-1"}]"""
        val nodeCipher = "jH/ybMINKxNP8QokrfYa96d7Drylw14GS8Rr53FkBmVb5KxTAkfA++Q9WH/Dz9o2kI1d5Nod4O0SP8US+4fKIg=="
        assertEquals(plain, BackupAes.decryptBase64(nodeCipher, password))
        assertEquals(nodeCipher, BackupAes.encryptBase64(plain, password))
    }

    /**
     * 主机名不分大小写（DNS 语义），但手机备份里 `cookies.json` 的 `url` 与书源配置里写的
     * 大小写未必一致。`instr` 是大小写敏感的，所以候选筛选必须自己归一 ——
     * 这条是那个筛选的回钉：书源写成 `MixedCase.Example.com`，备份里是 `mixedcase.example.com`。
     */
    @Test
    fun `cookie domain matching ignores host case`() {
        val directory = Files.createTempDirectory("legado-backup-case")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val source = """{"bookSourceUrl":"https://case-probe.example","bookSourceName":"大小写探针","loginUrl":"https://MixedCase.Example.com/"}"""
            val archive = directory.resolve("case.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookSource.json" to "[$source]",
                    "cookies.json" to BackupAes.encryptBase64(
                        """[{"url":"mixedcase.example.com","cookie":"tok=case-1"}]""",
                        "备份密码123",
                    ),
                ),
            )
            val restored = BackupImporter(database).import(archive, "备份密码123")
            assertEquals(1, restored.cookies)
            val cookie = database.getCookieForUrl("https://MixedCase.Example.com/api")
            assertTrue(cookie ?: "(空)", cookie != null && cookie.contains("tok=case-1"))
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 手机「订阅」页存的是 `rssSources.json`（上游 `Backup.kt:287` 由 `rssSourceDao.all` 写出，
     * `Restore.kt:343` 按 sourceUrl 主键恢复）。以前这一节被整段跳过，本机订阅页永远是空的。
     * 这里同时钉住两件事：RSS 条目不再进 skippedSections，而**其它**不承接的条目照旧要报出来。
     */
    @Test
    fun `restores rss sources from the phone backup`() {
        val directory = Files.createTempDirectory("legado-backup-rss")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val archive = directory.resolve("backup.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookSource.json" to """[{"bookSourceUrl":"https://rss-probe.example","bookSourceName":"RSS 探针书源","enabled":true}]""",
                    "rssSources.json" to """[
                        {"sourceUrl":"https://rss-a.example/","sourceName":"甲订阅","sourceGroup":"资讯,常用","enabled":true,"ruleArticles":"div.card","ruleTitle":"a@text"},
                        {"sourceUrl":"https://rss-b.example/","sourceName":"乙订阅","enabled":false},
                        {"sourceUrl":"https://rss-a.example/","sourceName":"甲订阅第二次导入","ruleArticles":"div.card"}
                    ]""",
                    // 与 RSS 同批被跳过的老条目：确认我把 rssSources 摘出去以后，剩下的还在如实上报
                    "readRecord.json" to """[{"bookName":"示例书名","readTime":100}]""",
                ),
            )

            val summary = BackupImporter(database).import(archive)

            // 同一个 sourceUrl 在包内出现两次：先按主键去重，所以两条都是"新增"
            assertEquals(2, summary.rssSources)
            assertEquals(0, summary.rssSourcesUpdated)
            assertEquals(listOf("readrecord.json"), summary.skippedSections)

            val listed = database.listRssSources(null)
            assertEquals(2, listed.size)
            val overwritten = listed.first { it.sourceUrl == "https://rss-a.example/" }
            assertEquals("甲订阅第二次导入", overwritten.name)
            assertTrue(overwritten.hasListRule)
            assertFalse(database.rssSourceIsEnabled("https://rss-b.example/"))

            // 再导一次整包：上游是 @Insert(onConflict = REPLACE)，按 sourceUrl 整体覆盖，
            // 既不产生第二行，也不保留本地改过的启停状态。
            val again = BackupImporter(database).import(archive)
            assertEquals(0, again.rssSources)
            assertEquals(2, again.rssSourcesUpdated)
            assertEquals(2, database.listRssSources(null).size)

            assertTrue(database.setRssSourceEnabled("https://rss-b.example/", true))
            assertTrue(database.rssSourceIsEnabled("https://rss-b.example/"))
            assertTrue(database.deleteRssSource("https://rss-b.example/"))
            // 再删一次删不到东西，必须报 false，不然探针会以为自己清理干净了
            assertFalse(database.deleteRssSource("https://rss-b.example/"))
            assertEquals(1, database.listRssSources(null).size)
            // RSS 是另一张表，不许顺手动书源
            assertEquals(1, database.listSources(null).size)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * `GET /api/cookies` 的「被几本书源用得上」必须一次扫描算完。
     * 老实现逐桶跑 `instr(lower(payload), ?)`，213 桶 × 4,876 源实测把接口拖到 2 分半；
     * 顺带口径也要对：只在注释里提了一句该域的源，不该算进"用得上"。
     */
    @Test
    fun `bucket mention counts come from real addresses, not from a passing mention`() {
        val directory = Files.createTempDirectory("legado-bucket-mentions")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.importSources(
                listOf(
                    """{"bookSourceUrl":"https://mention-a.example","bookSourceName":"真用该域","loginUrl":"https://shared.example/login"}""",
                    """{"bookSourceUrl":"https://mention-b.example","bookSourceName":"只蹭一句","bookSourceComment":"顺便提一下 shared.example 这个站"}""",
                )
            )
            database.setCookieForUrl("https://shared.example/", "tok=1")
            database.setCookieForUrl("https://nobody.example/", "tok=2")

            val mentions = database.cookieBucketMentions()

            assertEquals(1, mentions["shared.example"])
            assertEquals(null, mentions["nobody.example"])
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 备份导入**绝不覆盖本机书源的启用选择**：这台库里「4,876 源只启用 2 个」是用户的策展，
     * 而手机备份里几乎全是 `enabled=true`（实测那份手机备份是 7,278/7,441 条启用位为 true），覆盖一次就是
     * 一次批量启用事故。内容照更新，启用位照本机 —— 这两件事必须分开。
     *
     * 同一条测试钉 `bookGroup.json`：手机那侧的 `groupId` 是它自己库里的自增号，
     * 本机同号可能已经是另一个组（往往就是导入本地书时建的「本地」），必须按名字换号，
     * 不能照抄号码，也不能堆出同名第二个组。
     */
    @Test
    fun `backup import keeps local enable flags and renumbers phone groups`() {
        val directory = Files.createTempDirectory("legado-backup-enable")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            database.importSources(
                listOf("""{"bookSourceUrl":"https://keep.example","bookSourceName":"本机筛过的源","enabled":false,"bookSourceGroup":"旧分组"}""")
            )
            val localGroup = database.createBookGroup("追更中")
            val archive = directory.resolve("backup.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookSource.json" to
                        """[{"bookSourceUrl":"https://keep.example","bookSourceName":"本机筛过的源（备份里改了名）","enabled":true,"bookSourceGroup":"手机分组"},{"bookSourceUrl":"https://fresh.example","bookSourceName":"备份带来的新源","enabled":true}]""",
                    "bookGroup.json" to """[{"groupId":77,"groupName":"追更中"},{"groupId":88,"groupName":"完结"},{"groupId":0,"groupName":"默认分组"}]""",
                    "bookshelf.json" to
                        """[{"name":"新书","author":"某作者","bookUrl":"https://keep.example/book/1","origin":"https://keep.example","tocUrl":"https://keep.example/book/1","groupId":77,"durChapterIndex":3,"durChapterTime":1782343455600},{"name":"没带组的书","bookUrl":"https://keep.example/book/2","origin":"https://keep.example","tocUrl":"https://keep.example/book/2"}]""",
                ),
            )

            val summary = BackupImporter(database).import(archive)

            val kept = database.listSources(null).first { it.url == "https://keep.example" }
            assertFalse("已存在的书源必须仍是本机那台的停用状态", kept.enabled)
            assertEquals("本机筛过的源（备份里改了名）", kept.name)
            assertEquals("分组等内容照常更新", "手机分组", kept.group)
            // 新入库的源没有"本机选择"可保留，按包内值
            assertTrue(database.listSources(null).first { it.url == "https://fresh.example" }.enabled)

            val groups = database.listBookGroups()
            assertEquals(2, summary.bookGroups)
            assertEquals("同名组只留一个", 1, groups.count { it.name == "追更中" })
            assertEquals("手机号 77 必须换到本机已有的那个号", localGroup.id, groups.first { it.name == "追更中" }.id)
            assertTrue(groups.any { it.name == "完结" })
            assertEquals("groupId=0 是「未分组」，不许建成组", 0, groups.count { it.name == "默认分组" })

            val shelf = database.listBookshelf().first { it.name == "新书" }
            assertEquals(localGroup.id, shelf.groupId)
            // 反向对照：备份里没带 groupId 的书必须落在「未分组」，不能被上一个条目的组号带跑
            assertEquals(0L, database.listBookshelf().first { it.name == "没带组的书" }.groupId)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    @Test
    fun `只装个性化条目的备份包也算合法备份（手机上只勾了 TXT 分章规则导出的那种）`() {
        val directory = Files.createTempDirectory("legado-backup-kept-only")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val archive = directory.resolve("backup.zip")
            writeArchive(
                archive,
                mapOf(
                    "txtTocRule.json" to """[{"id":9002,"name":"手机上自己加的规则","rule":"^第[0-9]+[章节].*$","replacement":"","serialNumber":1,"enable":true}]""",
                    "searchhistory.json" to """["三体","白毛"]""",
                ),
            )
            // 以前这种包会被 require 判成"不是可识别的 Legado 备份"整包拒收
            val summary = BackupImporter(database).import(archive)
            assertNotNull("只含收下条目的包应当能导入", summary)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 兄弟项目（MD3 / Max / Night-Reader…）在官方小节之外各有扩充：bookmark、readRecordSession、
     * highlightTagRule、manifest…… 以前 [BackupStore.KEEP_NAMES] 只认官方那几样，多出来的条目
     * 会被报"不承接"，但整包还能导；这里钉住的是**它们真的被原样收下**，而不是只出现在错误名单里。
     */
    @Test
    fun `keeps sibling-specific sections instead of rejecting the whole backup`() {
        val directory = Files.createTempDirectory("legado-backup-sibling")
        val database = Database(directory.resolve("legado.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        try {
            database.initialize()
            val archive = directory.resolve("md3-backup.zip")
            writeArchive(
                archive,
                mapOf(
                    "bookSource.json" to
                        """[{"bookSourceUrl":"https://sibling.example","bookSourceName":"兄弟项目源","enabled":true}]""",
                    "bookmark.json" to """[{"bookName":"示例书名","chapterIndex":3,"content":"读到这"}]""",
                    "readRecordSession.json" to """[{"bookName":"示例书名","duration":600}]""",
                    "highlightTagRule.json" to """[{"name":"重点"}]""",
                    "manifest.json" to """{"version":1,"app":"legado-md3"}""",
                ),
            )

            val summary = BackupImporter(database, store).import(archive)

            assertEquals(1, summary.sources)
            assertEquals("兄弟项目多出来的条目都收下了，不该再报不承接", emptyList<String>(), summary.skippedSections)
            assertEquals(
                listOf("书签", "阅读会话", "高亮标签规则", "备份清单").sorted(),
                summary.keptSections.map { it.label }.sorted(),
            )
            assertEquals("摘要说有，磁盘上就要真有", 4, store.list().size)
            assertEquals(1, store.list().first { it.name == "bookmark.json" }.items)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 分享书源是不套 zip 的裸 JSON；转存工具又常把 zip 的扩展名改成 .json。
     * 入口必须按内容判别，否则这两种最常见的"从微信收来的文件"都会被扩展名挡在门外。
     */
    @Test
    fun `imports raw json source shares and zip content renamed to json`() {
        val directory = Files.createTempDirectory("legado-backup-raw")
        val database = Database(directory.resolve("legado.sqlite").toString())
        try {
            database.initialize()
            val share = directory.resolve("shareBookSource.json")
            Files.writeString(
                share,
                """[{"bookSourceUrl":"https://share-a.example","bookSourceName":"分享甲","enabled":true},""" +
                    """{"bookSourceUrl":"https://share-b.example","bookSourceName":"分享乙","enabled":false}]""",
            )
            val summary = BackupImporter(database).import(share)
            assertEquals(2, summary.sources)
            assertEquals(0, summary.books)
            assertEquals(2, database.listSources(null).size)

            // 扩展名是 .json，内容其实是 zip：仍按 zip 解包
            val disguised = directory.resolve("backup-renamed.json")
            writeArchive(
                disguised,
                mapOf("bookSource.json" to """[{"bookSourceUrl":"https://disguised.example","bookSourceName":"改名的包"}]"""),
            )
            val again = BackupImporter(database).import(disguised)
            assertEquals(1, again.sources)
            assertEquals(3, database.listSources(null).size)
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    /**
     * 合并导出的裸 JSON：`{bookSource:[…],bookshelf:[…],replaceRule:[…]}`。
     * 条目按字段特征归类，同一个文件里混着书源、书架、规则、分组、RSS 与明文凭据都要各回各家；
     * `bookmark` 这种本服务没有原生归宿的键则整个值原样收下。
     */
    @Test
    fun `imports a raw json bundle that mixes sections and keeps the extra wrapper`() {
        val directory = Files.createTempDirectory("legado-backup-bundle")
        val database = Database(directory.resolve("legado.sqlite").toString())
        val store = BackupStore(directory.resolve("kept"))
        try {
            database.initialize()
            val bundle = directory.resolve("bundle.json")
            Files.writeString(
                bundle,
                """
                {
                  "bookSource": [{"bookSourceUrl":"https://bundle.example","bookSourceName":"合并源"}],
                  "bookshelf": [{"name":"合并书","bookUrl":"https://bundle.example/book/1","origin":"https://bundle.example","tocUrl":"https://bundle.example/book/1"}],
                  "replaceRule": [{"id":"r1","name":"去广告","pattern":"广告.*","replacement":"","isRegex":true,"isEnabled":true}],
                  "bookGroup": [{"groupId":9,"groupName":"合并组"}],
                  "rssSources": [{"sourceUrl":"https://feed.example/","sourceName":"合并订阅"}],
                  "cookies": [{"url":"bundle.example","cookie":"sid=raw-1"}],
                  "bookmark": [{"bookName":"合并书","chapterIndex":1}]
                }
                """.trimIndent(),
            )

            val summary = BackupImporter(database, store).import(bundle)

            assertEquals(1, summary.sources)
            assertEquals(1, summary.rules)
            assertEquals(1, summary.books)
            assertEquals(1, summary.rssSources)
            assertEquals(1, summary.bookGroups)
            assertEquals(1, summary.cookies)
            assertEquals(1, summary.keptSections.size)
            assertEquals("书签", summary.keptSections.single().label)
            assertEquals("https://bundle.example", database.listBookshelf().single().sourceId)
            assertEquals("合并组", database.listBookGroups().single().name)
            assertTrue(database.getCookieForUrl("https://bundle.example/x")!!.contains("sid=raw-1"))
        } finally {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    private fun writeArchive(target: Path, sections: Map<String, String>) {
        ZipOutputStream(Files.newOutputStream(target)).use { zip ->
            sections.forEach { (name, body) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(body.toByteArray(Charsets.UTF_8))
                zip.closeEntry()
            }
        }
    }
}

package io.legado

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.backup.LegacyBackup

/**
 * 跨版本备份兼容的回归锁。语料形状取自上游 `ImportOldData.kt` 的老字段表，
 * 以及真机备份包（机型名已抹去）的条目名。
 */
class LegacyBackupTest {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private fun obj(text: String) = json.parseToJsonElement(text) as JsonObject

    /** 一份典型老版本（V1.x）书源：扁平规则 + enable + serialNumber + httpUserAgent。 */
    private val oldSource = """{
      "bookSourceUrl":"https://old.example",
      "bookSourceName":"老源",
      "bookSourceGroup":"测试 老版",
      "enable":false,
      "serialNumber":"12",
      "httpUserAgent":"OldLegado/1.0",
      "ruleSearchUrl":"/search.php?q=searchKey&page=searchPage",
      "ruleFindUrl":"榜单::/top\n推荐::/rec",
      "ruleSearchList":"class.note|class.item",
      "ruleSearchName":"class.title",
      "ruleSearchNoteUrl":"tag.a@href",
      "ruleBookContent":"id.content",
      "ruleChapterList":"class.listp a",
      "ruleChapterName":"text",
      "ruleContentUrl":"tag.a@href",
      "ruleBookInfoInit":"ruleBookInfoInit",
      "bookSourceType":"AUDIO"
    }"""

    @Test
    fun `old flat source is detected and new source is not`() {
        assertTrue(LegacyBackup.isOldSource(obj(oldSource)))
        assertFalse(LegacyBackup.isOldSource(obj("""{"bookSourceUrl":"https://n","ruleSearch":{"bookList":"$.a"}}""")))
        // 已经带 ruleSearch 的现版本源不能被动过
        assertFalse(LegacyBackup.isOldSource(obj("""{"bookSourceUrl":"https://n","ruleSearch":{"bookList":"$.a"},"enable":true}""")))
    }

    @Test
    fun `old source migrates its top level fields`() {
        val migrated = obj(checkNotNull(LegacyBackup.toNewSourceJson(obj(oldSource))))
        assertEquals("https://old.example", migrated.text("bookSourceUrl"))
        assertEquals("老源", migrated.text("bookSourceName"))
        assertEquals(false, (migrated["enabled"] as JsonPrimitive).content.toBoolean())
        assertEquals(12, (migrated["customOrder"] as JsonPrimitive).content.toInt())
        assertEquals("""{"User-Agent":"OldLegado/1.0"}""", migrated.text("header"))
        assertEquals(1, (migrated["bookSourceType"] as JsonPrimitive).content.toInt())
        // 上游：exploreUrl 为空才关掉 enabledExplore；这里非空，应为 true
        assertEquals(true, (migrated["enabledExplore"] as JsonPrimitive).content.toBoolean())
    }

    @Test
    fun `search url placeholders move to the new template syntax`() {
        val migrated = obj(checkNotNull(LegacyBackup.toNewSourceJson(obj(oldSource))))
        assertEquals("/search.php?q={{key}}&page={{page}}", migrated.text("searchUrl"))
    }

    @Test
    fun `explore url keeps one entry per line after migration`() {
        val migrated = obj(checkNotNull(LegacyBackup.toNewSourceJson(obj(oldSource))))
        assertEquals("榜单::/top\n推荐::/rec", migrated.text("exploreUrl"))
    }

    @Test
    fun `flat rules become the nested rule objects`() {
        val migrated = obj(checkNotNull(LegacyBackup.toNewSourceJson(obj(oldSource))))
        val search = migrated["ruleSearch"] as JsonObject
        // 老规则的单个 `|` 是「或」，现版本要写成 `||`
        assertEquals("class.note||class.item", search.text("bookList"))
        assertEquals("class.title", search.text("name"))
        assertEquals("tag.a@href", search.text("bookUrl"))
        val toc = migrated["ruleToc"] as JsonObject
        assertEquals("class.listp a", toc.text("chapterList"))
        assertEquals("tag.a@href", toc.text("chapterUrl"))
        val content = migrated["ruleContent"] as JsonObject
        assertEquals("id.content", content.text("content"))
    }

    @Test
    fun `single dollar content rule is unwrapped like upstream`() {
        val migrated = obj(checkNotNull(LegacyBackup.toNewSourceJson(obj("""{"bookSourceUrl":"https://o","ruleBookContent":"${'$'}content"}"""))))
        assertEquals("content", (migrated["ruleContent"] as JsonObject).text("content"))
    }

    @Test
    fun `rule dialect conversion skips js and css and xpath`() {
        // JS 里的 || 与 & 不能被改坏
        assertEquals("<js>a||b</js>", LegacyBackup.toNewRule("<js>a||b</js>"))
        assertEquals("@CSS:.a&&.b", LegacyBackup.toNewRule("@CSS:.a&&.b"))
        assertEquals("//div[@id='x']", LegacyBackup.toNewRule("//div[@id='x']"))
        // 单 # 替换要变成 ##
        assertEquals("##广告##", LegacyBackup.toNewRule("#广告#"))
        // 倒序与 allinone 标记要贴回去
        assertEquals("-class.a||class.b", LegacyBackup.toNewRule("-class.a|class.b"))
        // URL 里的 & 不能被当成并接符
        assertEquals("/s?a=1&b=2", LegacyBackup.toNewRule("/s?a=1&b=2"))
    }

    @Test
    fun `old shelf entry maps through bookInfoBean`() {
        val old = obj("""{"noteUrl":"https://old.example/b/1","tag":"https://old.example","serialNumber":5,
            "bookInfoBean":{"name":"甲书","author":"某人","chapterUrl":"https://old.example/toc/1","coverUrl":"https://old.example/c.jpg"},
            "durChapter":7,"newChapters":3}""")
        assertTrue(LegacyBackup.isOldShelfEntry(old))
        val migrated = obj(checkNotNull(LegacyBackup.toNewShelfJson(old)))
        assertEquals("https://old.example/b/1", migrated.text("bookUrl"))
        assertEquals("甲书", migrated.text("name"))
        assertEquals("https://old.example", migrated.text("origin"))
        assertEquals("https://old.example/toc/1", migrated.text("tocUrl"))
        assertEquals(7, (migrated["durChapterIndex"] as JsonPrimitive).content.toInt())
        assertEquals(3, (migrated["lastCheckCount"] as JsonPrimitive).content.toInt())
    }

    @Test
    fun `source without a url is dropped instead of importing a shell`() {
        assertNull(LegacyBackup.toNewSourceJson(obj("""{"bookSourceName":"没地址","ruleSearchList":"a"}""")))
    }

    @Test
    fun `wrapped and bare json shapes all flatten to a list`() {
        assertEquals(2, LegacyBackup.elementsOf("""[{"a":1},{"a":2}]""").size)
        assertEquals(2, LegacyBackup.elementsOf("""{"data":[{"a":1},{"a":2}]}""").size)
        assertEquals(2, LegacyBackup.elementsOf("""{"bookSources":[{"a":1},{"a":2}]}""").size)
        assertEquals(1, LegacyBackup.elementsOf("""{"bookSourceUrl":"https://x"}""").size)
        // BOM 头不能把整份文件变成解析失败
        assertEquals(1, LegacyBackup.elementsOf("﻿" + """[{"bookSourceUrl":"https://x"}]""").size)
    }

    @Test
    fun `legacy replace rule keeps isEnable spelling`() {
        val normalized = checkNotNull(LegacyBackup.normalizeReplaceRule(obj("""{"pattern":"a","replacement":"b","isEnable":false}""")))
        val rule = obj(normalized)
        assertEquals(false, (rule["isEnabled"] as JsonPrimitive).content.toBoolean())
        assertEquals("a", rule.text("pattern"))
        assertEquals("b", rule.text("replacement"))
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun checkNotNull(value: String?): String {
        assertNotNull("迁移结果不应为 null", value)
        return value!!
    }
}

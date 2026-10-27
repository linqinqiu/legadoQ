package io.legado

import io.legado.ai.ToolMeta
import io.legado.ai.ToolSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「按需下发工具」的分组选择判据。
 *
 * 这三条正是这次改动的全部承诺：命中关键词只带相关组、没命中退回默认组、清单为空时不过滤坏。
 */
class ToolSelectionTest {

    private fun meta(id: String, group: String, writes: Boolean = false) =
        ToolMeta(id = id, group = group, description = "$id 的描述", writes = writes)

    private val manifest = listOf(
        meta("program.catalog", "program"),
        meta("source.list", "sources"),
        meta("source.save", "sources", writes = true),
        meta("bookshelf.list", "bookshelf"),
        meta("search.books", "search"),
        meta("notes.list", "notes"),
        meta("tts.speak", "tts"),
        meta("backup.export", "backup"),
    )

    @Test
    fun `命中朗读关键词只带 program 与 tts`() {
        val selected = ToolSelection.select(manifest, "帮我用朗读读这一章")
        assertEquals(listOf("program.catalog", "tts.speak"), selected.map { it.id }.sorted())
    }

    @Test
    fun `没有命中任何关键词时退回默认阅读组`() {
        val selected = ToolSelection.select(manifest, "你好")
        val groups = selected.map { it.group }.toSet()
        assertEquals(setOf("program", "sources", "bookshelf", "search"), groups)
        assertFalse("默认组不该带朗读", selected.any { it.group == "tts" })
    }

    @Test
    fun `空清单原样返回，不抛错`() {
        assertTrue(ToolSelection.select(emptyList(), "随便").isEmpty())
    }

    @Test
    fun `清单里没有命中的组时退回完整清单，避免功能被过滤没`() {
        val onlyNotes = listOf(meta("notes.list", "notes"))
        assertEquals(onlyNotes, ToolSelection.select(onlyNotes, "帮我搜书"))
    }
}

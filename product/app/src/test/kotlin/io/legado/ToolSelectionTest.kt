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

    @Test
    fun `用户只启用朗读组时只下发 program 与 tts`() {
        val selected = ToolSelection.select(manifest, "随便聊聊", setOf("tts"))
        assertEquals(setOf("program", "tts"), selected.map { it.group }.toSet())
    }

    @Test
    fun `用户把组关光时 program 仍常驻`() {
        val selected = ToolSelection.select(manifest, "你好", emptySet())
        assertEquals(setOf("program"), selected.map { it.group }.toSet())
    }

    // ===== 逐项停用 =====

    @Test
    fun `组开着也能摘掉其中一条`() {
        val selected = ToolSelection.select(manifest, "帮我看书源并朗读", disabledTools = setOf("tts.speak"))
        assertFalse("被逐项停用的工具不该下发", selected.any { it.id == "tts.speak" })
        assertTrue("同组其余工具不受影响", selected.any { it.id == "source.list" })
    }

    @Test
    fun `program 组豁免逐项停用，否则模型连能力地图都查不到`() {
        val selected = ToolSelection.select(manifest, "你好", disabledTools = setOf("program.catalog"))
        assertTrue("发现入口必须常驻", selected.any { it.id == "program.catalog" })
    }

    @Test
    fun `停用不存在的工具 id 不报错也不影响别的工具`() {
        val selected = ToolSelection.select(manifest, "帮我看书源", null, setOf("没有这个工具"))
        assertTrue(selected.any { it.id == "source.list" })
    }

    @Test
    fun `停掉唯一的业务工具后，常驻的 program 组仍在`() {
        val tiny = listOf(meta("program.catalog", "program"), meta("notes.list", "notes"))
        val selected = ToolSelection.select(tiny, "帮我记笔记", setOf("notes", "program"), setOf("notes.list"))
        assertEquals("业务工具被摘掉，发现入口常驻", setOf("program.catalog"), selected.map { it.id }.toSet())
    }

    @Test
    fun `过滤完什么都不剩时退回这一批，不给模型一个空清单`() {
        // 没有 program 工具的清单（宿主自己注册的那一类）：把仅见的工具全停掉会留空，
        // 而空清单让模型连"我为什么没工具"都说不清，界面上只会看到一句答非所问。
        val noProgram = listOf(meta("notes.list", "notes"), meta("tts.speak", "tts"))
        val selected = ToolSelection.select(noProgram, "帮我记笔记", setOf("notes", "tts"), setOf("notes.list", "tts.speak"))
        assertEquals(setOf("notes.list", "tts.speak"), selected.map { it.id }.toSet())
    }
}

package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files
import io.legado.data.Database
import io.legado.data.addNote
import io.legado.data.getProgress
import io.legado.data.listNotes
import io.legado.data.saveProgress
import io.legado.model.BookNoteWrite
import io.legado.model.ReadingProgress

/**
 * P1-T1 逻辑位置模型：验证 `reading_progress` 与 `book_note` 的新字段（charOffset / paragraphAnchor /
 * positionVersion / positionChecksum）的落盘往返与老库迁移默认值。
 */
class LogicalPositionTest {

    private fun temporaryDatabase(): String =
        Files.createTempFile("legado-logical-position-test", ".sqlite").toString()

    @Test
    fun `reading progress saves and reads logical position fields`() {
        val path = temporaryDatabase()
        try {
            val database = Database(path)
            database.initialize()
            database.saveProgress(
                ReadingProgress(
                    sourceId = "src",
                    bookUrl = "book",
                    chapterUrl = "ch",
                    chapterIndex = 5,
                    scrollPosition = 0.3,
                    charOffset = 1234,
                    paragraphAnchor = "p-9",
                    positionVersion = 1,
                    positionChecksum = "abc123",
                    updatedAt = 1000L,
                ),
            )
            val p = database.getProgress("src", "book")!!
            assertEquals(1234, p.charOffset)
            assertEquals("p-9", p.paragraphAnchor)
            assertEquals(1, p.positionVersion)
            assertEquals("abc123", p.positionChecksum)
            database.close()
        } finally {
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `legacy reading_progress migrates new columns to defaults`() {
        val path = temporaryDatabase()
        try {
            // 旧 schema：含 scroll_position，但缺 char_offset / paragraph_anchor / position_version / position_checksum。
            // 直接建表再插一行，绕过 migration，验证 initialize() 补齐新列并给默认值。
            java.sql.DriverManager.getConnection("jdbc:sqlite:$path").use { conn ->
                conn.createStatement().use { st ->
                    st.executeUpdate(
                        "create table reading_progress (source_id text not null, book_url text not null, chapter_url text not null, chapter_index integer not null, scroll_position real not null default 0, updated_at integer not null, primary key (source_id, book_url))",
                    )
                    st.executeUpdate("insert into reading_progress values ('src','book','ch',2,0.5,1)")
                }
            }
            val database = Database(path)
            database.initialize()
            val p = database.getProgress("src", "book")!!
            assertEquals(0, p.charOffset) // 默认 0
            assertEquals(1, p.positionVersion) // 默认 1
            assertNull(p.paragraphAnchor)
            assertNull(p.positionChecksum)
            database.close()
        } finally {
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `book note saves and reads logical position fields`() {
        val path = temporaryDatabase()
        try {
            val database = Database(path)
            database.initialize()
            database.addNote(
                BookNoteWrite(
                    sourceId = "src",
                    bookUrl = "book",
                    chapterUrl = "ch",
                    chapterIndex = 2,
                    startOffset = 10,
                    endOffset = 20,
                    excerpt = "选中文本",
                    note = "想法",
                    paragraphAnchor = "p-3",
                    positionVersion = 1,
                    positionChecksum = "cs",
                ),
            )
            val listed = database.listNotes("src", "book")
            assertEquals(1, listed.size)
            assertEquals("p-3", listed[0].paragraphAnchor)
            assertEquals(1, listed[0].positionVersion)
            assertEquals("cs", listed[0].positionChecksum)
            database.close()
        } finally {
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }

    @Test
    fun `book note migrates new columns to defaults on legacy db`() {
        val path = temporaryDatabase()
        try {
            java.sql.DriverManager.getConnection("jdbc:sqlite:$path").use { conn ->
                conn.createStatement().use { st ->
                    st.executeUpdate(
                        "create table book_note (id integer primary key autoincrement, source_id text not null, book_url text not null, book_name text, chapter_url text, chapter_index integer not null default 0, start_offset integer not null, end_offset integer not null, excerpt text not null, note text not null default '', bookmark integer not null default 0, created_at integer not null, updated_at integer not null)",
                    )
                    st.executeUpdate("insert into book_note (source_id,book_url,chapter_index,start_offset,end_offset,excerpt,created_at,updated_at) values ('src','book',2,10,20,'x',1,1)")
                }
            }
            val database = Database(path)
            database.initialize()
            val listed = database.listNotes("src", "book")
            assertEquals(1, listed.size)
            assertEquals(1, listed[0].positionVersion)
            assertNull(listed[0].paragraphAnchor)
            assertNull(listed[0].positionChecksum)
            database.close()
        } finally {
            Files.deleteIfExists(java.nio.file.Path.of(path))
        }
    }
}

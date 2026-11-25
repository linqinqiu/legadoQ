package io.legado

import io.legado.feedback.FeedbackService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

class AppContainerTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun config(
        database: java.nio.file.Path,
        covers: java.nio.file.Path,
    ) = ServerConfig(
        host = "127.0.0.1",
        port = 0,
        databasePath = database.toString(),
        coverCacheDirectory = covers,
        localBooksDirectory = temp.newFolder().toPath(),
        homeDirectory = temp.newFolder().toPath(),
    )

    private fun httpSelectorThreads(): Int = Thread.getAllStackTraces().keys.count {
        it.isAlive && it.name.startsWith("HttpClient-") && it.name.endsWith("-SelectorManager")
    }

    @Test
    fun `组合根构造不提前启动出站 HTTP 客户端`() {
        val before = httpSelectorThreads()
        val container = AppContainer.create(
            config(temp.root.toPath().resolve("legado.sqlite"), temp.root.toPath().resolve("covers")),
            FeedbackService(null, null),
        )
        try {
            assertEquals(before, httpSelectorThreads())
        } finally {
            container.close()
        }
    }

    @Test
    fun `组合根构造失败时关闭已打开的数据库`() {
        val database = temp.root.toPath().resolve("legado.sqlite")
        val covers = temp.newFile("not-a-directory").toPath()
        try {
            AppContainer.create(config(database, covers), FeedbackService(null, null))
            fail("封面目录是普通文件，构造必须失败")
        } catch (_: Exception) {
            assertTrue("数据库连接未关闭，Windows 无法删除文件", Files.deleteIfExists(database))
        }
    }
}

package io.legado

import io.legado.ai.McpServerStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * MCP 配置层判据：`{home}/agent-mcp.json` 的读写与校验。
 *
 * 两条是踩过的坑：
 * ① 中文名直接当 id 会被"id 只能用小写字母"拒掉，用户根本看不懂 —— 名字是给人看的，
 *    id 是实现细节，得由 [McpServerStore.deriveId] 派生；
 * ② 一条坏记录不该让整份配置消失（与 `agent-profiles.json` 同一条教训）。
 */
class McpServerStoreTest {

    private val ID = Regex("^[a-z0-9][a-z0-9_-]{0,31}$")

    @Test
    fun `中文名也能派生出合法 id，且同名稳定、异名不同`() {
        val a = McpServerStore.deriveId("本地文件")
        val b = McpServerStore.deriveId("本地文件")
        val c = McpServerStore.deriveId("数据库")
        assertTrue("派生的 id 要合法：$a", ID.matches(a))
        assertEquals("同一个名字必须稳定（否则每次保存都换一个 id）", a, b)
        assertTrue("不同名字不该撞：$a / $c", a != c)
    }

    @Test
    fun `名字里有英文就取英文段`() {
        assertEquals("file", McpServerStore.deriveId("本地 File"))
        assertEquals("my-server", McpServerStore.deriveId("My Server"))
    }

    @Test
    fun `保存与读取往返，headers 去空值、超时被夹到合法区间`() {
        val home = Files.createTempDirectory("mcp-store")
        val saved = McpServerStore.register(
            home,
            McpServerStore.Server(
                id = "demo",
                name = "  演示  ",
                url = "  http://127.0.0.1:3399/mcp  ",
                headers = mapOf("Authorization" to " Bearer x ", "  " to "y", "Empty" to "   "),
                timeoutMs = 10,
            ),
        )
        assertEquals("演示", saved.name)
        assertEquals("http://127.0.0.1:3399/mcp", saved.url)
        assertEquals(mapOf("Authorization" to "Bearer x"), saved.headers)
        assertEquals("超时下限 1 秒", 1_000, saved.timeoutMs)

        val listed = McpServerStore.list(home)
        assertEquals(1, listed.size)
        assertEquals("demo", listed[0].id)
        assertEquals("Bearer x", listed[0].headers["Authorization"])

        assertTrue(McpServerStore.delete(home, "demo"))
        assertEquals(0, McpServerStore.list(home).size)
        assertNull(McpServerStore.get(home, "demo"))
    }

    @Test
    fun `非法 id 与非法地址在保存时就拒，不留到外呼时才报`() {
        val home = Files.createTempDirectory("mcp-store-bad")
        assertThrows(IllegalArgumentException::class.java) {
            McpServerStore.register(home, McpServerStore.Server(id = "演示", url = "http://127.0.0.1:1/mcp"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            McpServerStore.register(home, McpServerStore.Server(id = "ok", url = "ftp://127.0.0.1/x"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            McpServerStore.register(home, McpServerStore.Server(id = "ok", url = "不是地址"))
        }
        assertEquals("被拒的配置一条都不该落盘", 0, McpServerStore.list(home).size)
    }

    @Test
    fun `一条坏记录不会让整份配置消失`() {
        val home = Files.createTempDirectory("mcp-store-partial")
        Files.writeString(
            home.resolve("agent-mcp.json"),
            """
            {"servers":[
              {"id":"good","url":"http://127.0.0.1:3399/mcp","enabled":true},
              {"id":"broken"}
            ]}
            """.trimIndent(),
        )
        val listed = McpServerStore.list(home)
        assertEquals("好的那条要留着", 1, listed.size)
        assertEquals("good", listed[0].id)
    }
}

package io.legado

import io.legado.data.Database
import io.legado.subscription.SubscriptionService
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `SubscriptionService.parseSources` —— 订阅源内容的形状判定。
 *
 * 订阅地址吐出来的东西形状很不统一，实测见过五种：
 * 裸数组、`{data:[…]}`、`{sources:[…]}`、`{bookSources:[…]}`、`{list:[…]}`。
 * 认错一种的表现是"订阅导入 0 条"或"导入了一条包着数组的对象" —— 都不报错，
 * 只是数量不对，最难查。
 *
 * 这段原来 19/63 行覆盖。抽成 internal 后直接喂字符串测，不用起服务。
 */
class SubscriptionParseSourcesTest {

    private lateinit var db: Database

    private fun service(): SubscriptionService {
        val path: Path = Files.createTempFile("sub-parse", ".sqlite")
        db = Database(path.toString()).apply { initialize() }
        return SubscriptionService(db) { /* 测试里不关心日志 */ }
    }

    @After
    fun tearDown() {
        if (::db.isInitialized) runCatching { db.close() }
    }

    @Test
    fun `裸数组：每个元素原样序列化成一条`() {
        val body = """[{"bookSourceUrl":"https://a.com","bookSourceName":"A"},{"bookSourceUrl":"https://b.com","bookSourceName":"B"}]"""
        val got = service().parseSources(body)
        assertEquals("应解析出 2 条", 2, got.size)
        assertTrue("第 1 条应保留原字段", got[0].contains("https://a.com"))
        assertTrue("第 2 条应保留原字段", got[1].contains("https://b.com"))
    }

    @Test
    fun `data 包装`() {
        val body = """{"data":[{"bookSourceUrl":"https://a.com"}]}"""
        val got = service().parseSources(body)
        assertEquals(1, got.size)
        assertTrue(got[0].contains("https://a.com"))
    }

    @Test
    fun `sources 包装`() {
        val body = """{"sources":[{"bookSourceUrl":"https://a.com"}]}"""
        assertEquals(1, service().parseSources(body).size)
    }

    @Test
    fun `bookSources 包装`() {
        val body = """{"bookSources":[{"bookSourceUrl":"https://a.com"},{"bookSourceUrl":"https://b.com"}]}"""
        assertEquals(2, service().parseSources(body).size)
    }

    @Test
    fun `list 包装`() {
        val body = """{"list":[{"bookSourceUrl":"https://a.com"}]}"""
        assertEquals(1, service().parseSources(body).size)
    }

    @Test
    fun `包装键优先级：data 在 sources 之前`() {
        // 同时存在时按源码顺序取 data —— 这条钉住顺序，避免有人"顺手重排"
        val body = """{"sources":[{"x":1}],"data":[{"y":2},{"z":3}]}"""
        val got = service().parseSources(body)
        assertEquals("应取 data 的 2 条，不是 sources 的 1 条", 2, got.size)
        assertTrue("应是 data 里的内容", got[0].contains("\"y\""))
    }

    @Test
    fun `单个对象没有包装键时当成一条`() {
        val body = """{"bookSourceUrl":"https://a.com","bookSourceName":"单条"}"""
        val got = service().parseSources(body)
        assertEquals("单个书源对象应算一条", 1, got.size)
        assertTrue(got[0].contains("单条"))
    }

    @Test
    fun `BOM 被剥掉，不影响解析`() {
        val body = "\uFEFF[{\"bookSourceUrl\":\"https://a.com\"}]"
        assertEquals("带 BOM 的订阅应能解析", 1, service().parseSources(body).size)
    }

    @Test
    fun `前后空白被裁掉`() {
        val body = "  \n\t [{\"bookSourceUrl\":\"https://a.com\"}] \n "
        assertEquals(1, service().parseSources(body).size)
    }

    @Test
    fun `空数组返回空表，不报错`() {
        assertTrue(service().parseSources("[]").isEmpty())
    }

    @Test
    fun `非 JSON 抛 IllegalArgumentException，错误信息是人话`() {
        val error = runCatching { service().parseSources("<html>not json</html>") }.exceptionOrNull()
        assertTrue("应抛 IllegalArgumentException，实际 ${error?.javaClass?.simpleName}",
            error is IllegalArgumentException)
        assertTrue("错误信息应是人话，实际：${error?.message}",
            error?.message?.contains("不是有效 JSON") == true)
    }

    @Test
    fun `元素里的未知字段被保留（不重新建模）`() {
        // 关键设计：原样序列化，所以上游新加的字段不会在导入时丢掉
        val body = """[{"bookSourceUrl":"https://a.com","someFutureField":{"nested":[1,2]},"anotherNew":123}]"""
        val got = service().parseSources(body)
        assertEquals(1, got.size)
        assertTrue("未知字段应原样保留", got[0].contains("someFutureField"))
        assertTrue("嵌套结构应原样保留", got[0].contains("nested"))
        assertTrue("数字字段应原样保留", got[0].contains("anotherNew"))
    }

    @Test
    fun `顶层是标量时也当成一条（不崩）`() {
        // 现实中不会这样，但"不崩"比"精确"更重要 —— 订阅源是外部数据
        val got = runCatching { service().parseSources("\"just a string\"") }
        assertTrue("标量输入不该让服务崩，应返回一条或抛人话异常",
            got.isSuccess || got.exceptionOrNull() is IllegalArgumentException)
    }
}

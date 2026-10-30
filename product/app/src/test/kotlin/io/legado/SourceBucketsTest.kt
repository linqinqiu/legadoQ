package io.legado

import io.legado.data.sourceBucketsIn
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 书源正文里「指向哪些注册域」的字节级抽取。
 *
 * 口径必须和以前的正则版逐字相同 —— 它决定凭据明细里「N 个书源用到」那个数。
 * 整库对照（5,598 本 / 24 MB，差异 0）没法进单测，这里盯住那些会让两种写法分叉的边角：
 * 大小写、端口、模板地址、中文路径、协议相对地址、多段后缀、IP。
 */
class SourceBucketsTest {

    private fun buckets(text: String): Set<String> = sourceBucketsIn(text.toByteArray(Charsets.UTF_8))

    @Test
    fun `子域归到注册域，同一本书源只算一次`() {
        assertEquals(setOf("a.example"), buckets("""{"u":"https://m.a.example/x","l":"https://a.example/y"}"""))
    }

    @Test
    fun `大写协议与主机名照样认，端口丢掉`() {
        assertEquals(setOf("b.example"), buckets("""HTTP://B.Example:8080/y"""))
    }

    @Test
    fun `多段后缀按三段归桶`() {
        assertEquals(setOf("example.com.cn"), buckets("https://x.example.com.cn/a"))
        assertEquals(setOf("a.example"), buckets("https://a.example/"))
    }

    @Test
    fun `协议相对地址不算地址`() {
        assertEquals(emptySet<String>(), buckets("""{"js":"//cdn.example/lib.js"}"""))
        assertEquals(emptySet<String>(), buckets("""{"bookSourceUrl":"example.com"}"""))
    }

    @Test
    fun `中文域名与中文路径`() {
        assertEquals(setOf("例子.中国"), buckets("https://例子.中国/书源/规则"))
    }

    @Test
    fun `引号尖括号包着的地址能取出来`() {
        assertEquals(setOf("d.example"), buckets("""<a href="https://d.example/book">"""))
        assertEquals(setOf("e.example"), buckets("<https://e.example>"))
    }

    @Test
    fun `问号井号处的地址截止`() {
        assertEquals(setOf("a.example"), buckets("https://a.example?x=1#y"))
        assertEquals(setOf("a.example"), buckets("https://a.example#y"))
    }

    @Test
    fun `末尾的点会被去掉`() {
        assertEquals(setOf("a.example"), buckets("https://a.example./x"))
    }

    @Test
    fun `IP 直连整串就是域`() {
        assertEquals(setOf("154.37.154.143"), buckets("http://154.37.154.143/book"))
    }

    @Test
    fun `主机缓存跨书源复用后结果不变`() {
        val memo = HashMap<String, String>()
        assertEquals(setOf("a.example"), sourceBucketsIn("https://A.Example/x".toByteArray(), memo))
        assertEquals(setOf("a.example"), sourceBucketsIn("https://m.a.example/y".toByteArray(), memo))
        assertEquals(setOf("b.example"), sourceBucketsIn("https://b.example/z".toByteArray(), memo))
        // 备忘按主机名记，不按桶：a.example / m.a.example / b.example 是三个键。
        assertEquals(3, memo.size)
    }
}

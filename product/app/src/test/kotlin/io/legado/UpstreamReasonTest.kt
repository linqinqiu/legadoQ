package io.legado

import io.legado.rules.RuleRunner
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 音频 / 视频 / 漫画这些走 JSON 接口的源，八成把"为什么没结果"写进了响应里（要登录、被拦截、参数不对），
 * 但列表规则取不到字段时报的却是 json-path 那句 `Missing property in path $['books']` ——
 * 界面与体检只剩"无结果"三个字，用户分不清是该登录还是该换源。
 *
 * 本机实测：`https://m.lrts.me/ajax/searchBook`（库里 115 个音频源之一，配了 loginUrl）匿名搜索回
 * `{"apiStatus":485,"data":{},"msg":"你好，需要登录才能继续使用此功能"}`，我们原来只报路径找不到。
 */
class UpstreamReasonTest {

    /** 拿一份假上游响应体跑一次搜索，返回报错文本（没报错就返回取到了几条）。 */
    private fun failureOf(body: String): String = runCatching {
        "取到 " + RuleRunner { url ->
            if (url.startsWith("https://m.example/s")) body else error("unexpected URL: $url")
        }.search(
            """{"bookSourceUrl":"https://m.example","bookSourceName":"假源","searchUrl":"https://m.example/s?key={{key}}",""" +
                """"ruleSearch":{"bookList":"$.books[*]","name":"$.name","bookUrl":"https://m.example/b/{{$.id}}"}}""",
            "斗破苍穹",
        ).size
    }.let { result -> result.exceptionOrNull()?.message ?: result.getOrDefault("没报错") }

    @Test
    fun `上游写明了要登录，这句就得进报错而不是被路径错误挤掉`() {
        val message = failureOf("""{"apiStatus":485,"data":{},"msg":"你好，需要登录才能继续使用此功能"}""")
        assertTrue("报错里没带上游那句话：$message", message.contains("需要登录才能继续使用此功能"))
        // 体检那一档靠"登录"二字命中 needs_login，别让原始异常名把话挤没了
        assertTrue("原来的路径错误也应当留着：$message", message.contains("books"))
    }

    @Test
    fun `拦截页是 HTML 时不把整页标签塞进报错`() {
        val message = failureOf("<html><body><h1>访问被拦截</h1><script>var a=1</script></body></html>")
        assertFalse("HTML 不该被摘进报错：$message", message.contains("上游那句话"))
    }

    @Test
    fun `JSON 里没有那句人话时不许编造`() {
        val message = failureOf("""{"apiStatus":0,"list":[],"count":112}""")
        assertFalse("没有 msg 类字段却硬造了一句：$message", message.contains("上游那句话"))
        assertTrue("路径错误本身要说得清：$message", message.contains("books"))
    }
}

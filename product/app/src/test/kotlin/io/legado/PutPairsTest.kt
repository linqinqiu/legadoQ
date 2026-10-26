package io.legado

import org.junit.Assert.assertEquals
import org.junit.Test
import io.legado.rules.putPairs

/**
 * `@put:{…}` 的多键解析。库里 @put 出现 492 次、278 次是多键，
 * 以前只取第一个键，其余键的 `@get:{}` / `{{}}` 引用恒为空。
 * 三种形状都取自真实语料（见 tools/verify/context-dialect-census.mjs 的样本）。
 */
class PutPairsTest {

    @Test
    fun `parses bare-key multi pairs`() {
        assertEquals(
            listOf("sid" to "$.sandboxId", "smg" to "$.magic", "name" to "$.name", "p" to "$.isDir"),
            putPairs("""sid:$.sandboxId,smg:$.magic,name:$.name,p:$.isDir"""),
        )
    }

    @Test
    fun `parses quoted multi pairs spanning newlines and tabs`() {
        val body = "n:\"[name\$=book_name]@content\",\n\ta:\"[name\$=author]@content\",\n\tk:\"[name~=category]@content\""
        assertEquals(
            listOf(
                "n" to "[name\$=book_name]@content",
                "a" to "[name\$=author]@content",
                "k" to "[name~=category]@content",
            ),
            putPairs(body),
        )
    }

    @Test
    fun `parses strict json pairs`() {
        assertEquals(listOf("a" to "$.x", "b" to "$.y"), putPairs(""""a":"$.x","b":"$.y""""))
    }

    @Test
    fun `keeps commas and colons inside a value's brackets and quotes`() {
        // 值里带 `[{a:1,b:2}]` 与 `https://…`：按顶层逗号切，不能被从中间劈开
        assertEquals(
            listOf("t" to """@js:[{text:"a,b"},{text:"c"}]""", "u" to "https://x.example/p?id=1"),
            putPairs("""t:@js:[{text:"a,b"},{text:"c"}],u:https://x.example/p?id=1"""),
        )
    }

    @Test
    fun `single pair keeps working exactly as before`() {
        assertEquals(listOf("cid" to "$.cid"), putPairs("cid:$.cid"))
        assertEquals(emptyList<Pair<String, String>>(), putPairs("没有冒号"))
        assertEquals(emptyList<Pair<String, String>>(), putPairs(""))
    }
}

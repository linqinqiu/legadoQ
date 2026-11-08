package io.legado

import io.legado.rules.RuleContext
import io.legado.rules.RuleDispatcher
import io.legado.rules.RuleInput
import io.legado.rules.RuleProcessor
import io.legado.rules.RuleResult
import io.legado.rules.RuleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 规则扩展点判据：**注册进去的处理器真的会被调用**。
 *
 * 这一条是这次改动存在的理由。此前 `RuleDispatcher` / `RuleProcessor` 只是契约：
 * `RuleRunner` 收了一个 `ruleDispatcher` 参数却从不读，`processor` 包下四个实现全是
 * 「尚未实现」—— 新写一种解析方式可以编译、可以单测，但规则求值时永远走不到它。
 *
 * 判据分三层，缺一层都证明不了「接上了」：
 * ① 值级：自定义前缀的**字段规则**由处理器给结果；
 * ② 列表级：声明了 `producesNodes` 的处理器能给**列表条目**，字段按 JSONPath 取；
 * ③ 不越界：没人认领的规则、以及值型处理器遇到的列表规则，行为与从前完全一致。
 *
 * 自定义规则一律挂在 `author` 上：书名规则取不到值时整条记录会被 `bookItems` 丢掉
 * （`mapNotNull` 要求 name 非空），拿书名做实验会让人以为"扩展点把源弄坏了"。
 */
class RuleProcessorTest {

    private val page = """
        <!doctype html>
        <html><body>
          <div class="result"><h3 class="title">斗破苍穹</h3><span class="author">天蚕土豆</span><a class="detail" href="https://p.example/1">详情</a></div>
          <div class="result"><h3 class="title">凡人修仙传</h3><span class="author">忘语</span><a class="detail" href="https://p.example/2">详情</a></div>
        </body></html>
    """.trimIndent()

    private fun source(
        authorRule: String = "span.author@text",
        nameRule: String = "h3.title@text",
        listRule: String = "div.result",
    ) = """
        {
          "bookSourceUrl": "https://proc.example",
          "bookSourceName": "处理器测试",
          "bookSourceType": 0,
          "searchUrl": "https://proc.example/search?q={{key}}",
          "ruleSearch": {
            "bookList": "$listRule",
            "name": "$nameRule",
            "author": "$authorRule",
            "bookUrl": "a.detail@href"
          }
        }
    """.trimIndent()

    private fun runner() = RuleRunner({ _: String -> page })

    /** 值型处理器：把内建取到的值包一层。 */
    private class WrapProcessor : RuleProcessor {
        override val type: String = "wrap"
        override fun canHandle(rule: String): Boolean = rule.trimStart().startsWith("@wrap:")
        override fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult {
            val value = input.evaluateBuiltin(rule.substringAfter(':').trim()) ?: return RuleResult(text = "")
            return RuleResult(text = "《$value》")
        }
    }

    /** 列表型处理器：从原始响应里按自己的方式摘条目（字段按 JSONPath 取）。 */
    private class TitleListProcessor : RuleProcessor {
        override val type: String = "titles"
        override val producesNodes: Boolean = true
        override fun canHandle(rule: String): Boolean = rule.trim().startsWith("titles:")
        override fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult {
            val titles = Regex("""<h3 class="title">([^<]+)</h3>""").findAll(input.raw)
                .map { mapOf("title" to it.groupValues[1].trim()) }
                .toList()
            return RuleResult(nodes = titles)
        }
    }

    @Test
    fun `值级扩展点：自定义前缀的字段规则由处理器求值`() {
        val runner = runner()
        // 先确认不注册时这条规则取不到值（前缀内建不认识，会被当成选择器吞掉）——
        // 否则下面的断言证明不了"是处理器给的"。
        val before = runner.search(source(authorRule = "@wrap:span.author@text"), "x")
        assertEquals(2, before.size)
        assertNull("不注册处理器时作者应为空", before[0].author)

        runner.dispatcher.register(WrapProcessor())
        val items = runner.search(source(authorRule = "@wrap:span.author@text"), "x")
        assertEquals(2, items.size)
        assertEquals("《天蚕土豆》", items[0].author)
        assertEquals("《忘语》", items[1].author)
        // 同一个处理器只接管它认领的那条规则，别的字段照旧走内建链路。
        assertEquals("斗破苍穹", items[0].name)
    }

    @Test
    fun `列表级扩展点：声明 producesNodes 的处理器给出条目，字段按 JSONPath 取`() {
        val runner = runner()
        runner.dispatcher.register(TitleListProcessor())
        val items = runner.search(
            source(nameRule = "$.title", listRule = "titles:"),
            "x",
        )
        assertEquals("处理器给了两个条目", 2, items.size)
        assertEquals("斗破苍穹", items[0].name)
        assertEquals("凡人修仙传", items[1].name)
    }

    @Test
    fun `值型处理器不接管列表规则：没声明 producesNodes 就不许影响条目数`() {
        val runner = runner()
        var consulted = 0
        // 这个处理器 canHandle 认所有规则（最宽的那种写法），但没声明 producesNodes。
        runner.dispatcher.register(object : RuleProcessor {
            override val type: String = "greedy"
            override fun canHandle(rule: String): Boolean = true
            override fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult {
                consulted += 1
                // 原样交回内建结果：这里只想证明"列表规则没被它吃掉"。
                return RuleResult(text = input.evaluateBuiltin(rule).orEmpty())
            }
        })
        val items = runner.search(source(), "x")
        assertEquals("列表规则不该被值型处理器接管", 2, items.size)
        assertEquals("斗破苍穹", items[0].name)
        assertTrue("字段规则确实经过了处理器（否则这条判据没测到扩展点）", consulted > 0)
    }

    @Test
    fun `认领即拥有：处理器给空值就是没值，不再退回内建链路`() {
        val runner = runner()
        runner.dispatcher.register(object : RuleProcessor {
            override val type: String = "empty"
            // 认领的是一条**内建本来取得到值**的规则：若落回内建，作者会是「天蚕土豆」。
            override fun canHandle(rule: String): Boolean = rule.trim() == "span.author@text"
            override fun execute(rule: String, input: RuleInput, context: RuleContext) = RuleResult(text = "")
        })
        val items = runner.search(source(), "x")
        assertEquals(2, items.size)
        assertNull("认领了就不许再落回内建（否则这里会是「天蚕土豆」）", items[0].author)
        assertEquals("斗破苍穹", items[0].name)
    }

    @Test
    fun `处理器抛异常只影响那一条规则，不拖垮整源`() {
        val runner = runner()
        runner.dispatcher.register(object : RuleProcessor {
            override val type: String = "boom"
            override fun canHandle(rule: String): Boolean = rule.trimStart().startsWith("@boom:")
            override fun execute(rule: String, input: RuleInput, context: RuleContext): RuleResult =
                throw IllegalStateException("处理器内部炸了")
        })
        val items = runner.search(source(authorRule = "@boom:span.author@text"), "x")
        assertEquals("别的字段照旧", 2, items.size)
        assertNull("处理器炸了，这条规则就是没值", items[0].author)
        assertEquals("斗破苍穹", items[0].name)

        // 连认领阶段就抛：视作不认领，字段照常走内建链路。
        runner.dispatcher.register(object : RuleProcessor {
            override val type: String = "badCanHandle"
            override fun canHandle(rule: String): Boolean = throw IllegalStateException("连认领都炸")
            override fun execute(rule: String, input: RuleInput, context: RuleContext) = RuleResult(text = "x")
        })
        val normal = runner.search(source(), "x")
        assertEquals("天蚕土豆", normal[0].author)
    }

    @Test
    fun `@css 前缀在列表与值两侧都生效`() {
        val items = runner().search(source(listRule = "@css:div.result"), "x")
        assertEquals("@css: 列表规则应等同普通 CSS 列表", 2, items.size)
        assertEquals("斗破苍穹", items[0].name)
    }

    @Test
    fun `调度器按类型注册与摘除，覆盖时不重复`() {
        val dispatcher = RuleDispatcher()
        val wrap = WrapProcessor()
        dispatcher.register(wrap)
        dispatcher.register(wrap)
        assertEquals("同 type 再注册应覆盖而不是叠加", 1, dispatcher.size)
        assertEquals(listOf("wrap"), dispatcher.types())
        assertTrue(dispatcher.unregister("wrap"))
        assertEquals(0, dispatcher.size)
        assertNull(dispatcher.dispatch("wrap"))
    }
}

package io.legado.rules

import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.select.Elements
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.Context
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject

/**
 * 书源脚本里 `org.jsoup.Jsoup.parse(字符串)` 的**白名单包装**。
 *
 * 为什么要它：启用库里有 **314 份**源写 `org.jsoup.*`，其中 **292 份只用 `Jsoup.parse`**
 *（典型形状：`var doc = org.jsoup.Jsoup.parse(result); doc.select('.list a')` 再遍历取 `attr/text`）。
 * 我们禁了 Java 反射（`ClassShutter { false }` 是 RCE 防线，不为几个源开口子），
 * 于是这些脚本第一行就 `ReferenceError: “org” 未定义`，整个源用不了。
 *
 * 边界（故意窄）：
 * - 只给**解析已有字符串**，不给 `Jsoup.connect` —— 那是网络出口，我们的出口是带 SSRF 闸门的
 *   `java.ajax` / `fetchResponse`，不在这里开第二条路；用到 connect 的 11 份里还有 13 份同时依赖
 *   `Packages` 反射，本来就只能如实失败（已记在 docs/sessions）。
 * - 只暴露 Jsoup 里"读 DOM"的那批方法；不暴露文件、System、ClassLoader、`ownerElement().connection()`
 *   之类能顺出去的东西。
 * - 集合返回**真 JS 数组**：库里既有 `X.size()` / `X.first()` / `X.attr('href')` 这种 Jsoup 写法，
 *   也有 `for (i=0;i<X.length;i++) X[i].text()` 和 `Array.from(tags).forEach(...)` 这种 JS 写法，
 *   数组 + 挂方法两边都认。
 */
internal object JsoupBridge {

    /** 挂到脚本作用域上的 `org` 对象（`org.jsoup.Jsoup`）。 */
    fun install(cx: Context, scope: Scriptable): Scriptable {
        val top = ScriptableObject.getTopLevelScope(scope)
        val jsoup = NativeObject().also { api ->
            api.parentScope = top
            ScriptableObject.putProperty(api, "parse", fn(top) { args ->
                document(cx, top, textAt(args, 0))
            })
            // 上游 Jsoup 还有这个；社区源偶尔用它取正文片段，行为与 parse 基本一致
            ScriptableObject.putProperty(api, "parseBodyFragment", fn(top) { args ->
                document(cx, top, textAt(args, 0))
            })
        }
        val nodes = NativeObject().also { namespace ->
            namespace.parentScope = top
            // 有的源在注释/变量名里写 `org.jsoup.nodes.Element`，给个空对象免得取属性就炸
            ScriptableObject.putProperty(namespace, "Element", NativeObject().also { it.parentScope = top })
            ScriptableObject.putProperty(namespace, "Document", NativeObject().also { it.parentScope = top })
            ScriptableObject.putProperty(namespace, "Elements", NativeObject().also { it.parentScope = top })
        }
        val jsoupNamespace = NativeObject().also { namespace ->
            namespace.parentScope = top
            ScriptableObject.putProperty(namespace, "Jsoup", jsoup)
            ScriptableObject.putProperty(namespace, "nodes", nodes)
        }
        return NativeObject().also { org ->
            org.parentScope = top
            ScriptableObject.putProperty(org, "jsoup", jsoupNamespace)
        }
    }

    private fun document(cx: Context, top: Scriptable, html: String): Scriptable {
        val parsed: Document = runCatching { Jsoup.parse(html) }.getOrElse { error ->
            throw org.mozilla.javascript.EvaluatorException(
                "Jsoup.parse 没能解析这段内容：${error.message ?: error.javaClass.simpleName}"
            )
        }
        return requireNotNull(element(cx, top, parsed)) { "Jsoup.parse 返回了空文档" }
    }

    private fun textAt(args: Array<out Any?>, index: Int): String = args.getOrNull(index)?.toString() ?: ""

    /** 一个元素：`text()/attr()/select()/html()/toString()` 等，全部只读。 */
    private fun element(cx: Context, top: Scriptable, el: Element?): Scriptable? {
        if (el == null) return null
        return NativeObject().also { node ->
            node.parentScope = top
            // Jsoup 的 Element.toString() 就是 outerHtml；源里大量 `'' + el`、`String(el)` 靠这个
            put(node, "toString") { _, _ -> el.outerHtml() }
            put(node, "text") { _, _ -> el.text() }
            put(node, "wholeText") { _, _ -> el.wholeText() }
            put(node, "ownText") { _, _ -> el.ownText() }
            put(node, "html") { _, _ -> el.html() }
            put(node, "innerHtml") { _, _ -> el.html() }
            put(node, "outerHtml") { _, _ -> el.outerHtml() }
            put(node, "data") { a, _ -> el.attr(textAt(a, 0)) }
            put(node, "attr") { a, _ -> el.attr(textAt(a, 0)) }
            put(node, "hasAttr") { a, _ -> el.hasAttr(textAt(a, 0)) }
            put(node, "hasText") { _, _ -> el.hasText() }
            put(node, "className") { _, _ -> el.className() }
            put(node, "id") { _, _ -> el.id() }
            put(node, "tagName") { _, _ -> el.tagName() }
            put(node, "baseUri") { _, _ -> el.baseUri() }
            put(node, "select") { a, _ -> elements(cx, top, el.select(textAt(a, 0))) }
            put(node, "selectFirst") { a, _ -> element(cx, top, el.selectFirst(textAt(a, 0))) }
            put(node, "getElementsByTag") { a, _ -> elements(cx, top, el.getElementsByTag(textAt(a, 0))) }
            put(node, "getElementsByClass") { a, _ -> elements(cx, top, el.getElementsByClass(textAt(a, 0))) }
            put(node, "getElementById") { a, _ -> element(cx, top, el.getElementById(textAt(a, 0))) }
            // Jsoup 里 `element.get(0)` 返回自己，源里有这种写法，照做
            put(node, "get") { _, _ -> node }
            put(node, "getAllElements") { _, _ -> elements(cx, top, el.getAllElements()) }
            put(node, "children") { _, _ -> elements(cx, top, el.children()) }
            put(node, "child") { a, _ -> element(cx, top, runCatching { el.child(intAt(a, 0)) }.getOrNull()) }
            put(node, "parent") { _, _ -> element(cx, top, el.parent()) }
            put(node, "parents") { _, _ -> elements(cx, top, Element(el.parents())) }
            put(node, "nextElementSibling") { _, _ -> element(cx, top, el.nextElementSibling()) }
            put(node, "previousElementSibling") { _, _ -> element(cx, top, el.previousElementSibling()) }
            // Document 才有的几个
            if (el is Document) {
                put(node, "title") { _, _ -> el.title() }
                put(node, "location") { _, _ -> el.location() }
                put(node, "head") { _, _ -> element(cx, top, el.head()) }
                put(node, "body") { _, _ -> element(cx, top, el.body()) }
            }
        }
    }

    /** Jsoup 的 `Elements`：真数组（`length`、下标、`Array.from`、`forEach`）+ 那批集合方法。 */
    private fun elements(cx: Context, top: Scriptable, list: Elements): Scriptable {
        val items = list.mapNotNull { element(cx, top, it) }.toTypedArray()
        // 不用 `Context.newArray`：它在这里抛 IllegalArgumentException（Rhino 对静态建数组
        // 要求作用域链上能拿到 Array 原型，而我们拿到的是函数激活作用域）。走 JS 自己的
        // `new Array(n)`，`length`/下标/`forEach`/`Array.from` 这些数组语义才真的在。
        // 集合给"数组形状的对象"：`length` + 下标属性 + Jsoup 那几个方法。
        // 为什么不是真数组：试遍了三条路都不可靠 —— `Context.newArray` 在这里抛
        // IllegalArgumentException；`new Array()` 取不到 push（原型没接上）结果装进去是空的；
        // 手搓 NativeArray 接原型又受 Rhino 版本摆布。而源里的用法其实只有两类：
        // `X[i]` / `X.length` / `Array.from(X)`（JS 习惯）与 `X.size()/first()/attr()`（Jsoup 习惯），
        // 带 length 与普通属性的对象两边都吃，且不依赖引擎内部。
        val array = NativeObject().also { box ->
            box.parentScope = top
            items.forEachIndexed { index, item ->
                // 数字键与字符串键都写：JS 里 `X[0]` 走的是下标 API，`X["0"]` 走字符串键，
                // 只挂一边就会有一半的源拿到 undefined（实测就是只挂字符串键时报的错）。
                (box as Scriptable).put(index, box, item)
                ScriptableObject.putProperty(box, index.toString(), item)
            }
            ScriptableObject.putProperty(box, "length", list.size)
        }
        return array.also {
            put(array, "size") { _, _ -> list.size }
            put(array, "isEmpty") { _, _ -> list.isEmpty() }
            put(array, "get") { a, _ -> element(cx, top, runCatching { list[intAt(a, 0)] }.getOrNull()) }
            put(array, "eq") { a, _ -> element(cx, top, runCatching { list[intAt(a, 0)] }.getOrNull()) }
            put(array, "first") { _, _ -> element(cx, top, list.firstOrNull()) }
            put(array, "last") { _, _ -> element(cx, top, list.lastOrNull()) }
            // 整集合上的取值按 Jsoup 语义：attr 取第一个，text 用空格拼，html/toString 拼 outerHtml
            put(array, "attr") { a, _ -> list.attr(textAt(a, 0)) }
            put(array, "hasAttr") { a, _ -> list.hasAttr(textAt(a, 0)) }
            put(array, "hasText") { _, _ -> list.hasText() }
            put(array, "text") { _, _ -> list.text() }
            put(array, "html") { _, _ -> list.html() }
            put(array, "outerHtml") { _, _ -> list.outerHtml() }
            put(array, "toString") { _, _ -> list.outerHtml() }
            put(array, "select") { a, _ -> elements(cx, top, Selector.selectIn(a, list)) }
            put(array, "each") { a, _ ->
                val callback = a.getOrNull(0) as? org.mozilla.javascript.Function ?: return@put Unit
                list.forEachIndexed { index, el ->
                    callback.call(cx, top, top, arrayOf(element(cx, top, el), index))
                }
                Unit
            }
        }
    }

    private object Selector {
        fun selectIn(args: Array<out Any?>, from: Elements): Elements =
            from.select(textAt(args, 0))
    }

    /** `Element(Elements)` 的兼容：上游 `parents()` 返回 List<Element>，这里拼成一个 Elements 复用包装。 */
    private fun Element(parents: List<Element>): Elements {
        val merged = Elements()
        parents.forEach { merged.add(it) }
        return merged
    }

    /**
     * 统一一个成员函数的形状：可空调用一律给 `undefined`（Rhino 里 Kotlin 的 null 会变成
     * `typeof === "object"`，源里 `if (!x)` 这类判空就废了）；真的抛异常时要说清是谁的问题，
     * 不能顶一个像引擎故障的名字。
     */
    private fun put(target: Scriptable, name: String, body: (Array<out Any?>, Scriptable) -> Any?) {
        ScriptableObject.putProperty(target, name, object : BaseFunction() {
            override fun call(cx: Context?, scope: Scriptable?, thisObj: Scriptable?, args: Array<out Any?>?): Any {
                val arguments = args ?: emptyArray()
                // Rhino 在没有原型作用域的调用点会把 scope 传成 null，这里退回包装时抓住的 target
                val liveScope = scope ?: target
                val outcome = runCatching { body(arguments, liveScope) }
                if (outcome.isFailure) {
                    val error = outcome.exceptionOrNull()!!
                    // 越界下标（`list.get(9)`）在源里就是"这里没有元素"，不是脚本写坏了
                    if (error is IndexOutOfBoundsException) return Context.getUndefinedValue()
                    val at = error.stackTrace.firstOrNull()?.methodName ?: "?"
                    throw org.mozilla.javascript.EvaluatorException(
                        "org.jsoup.$name 失败：${error.message ?: error.javaClass.simpleName}（来自 $at）"
                    )
                }
                return outcome.getOrNull() ?: Context.getUndefinedValue()
            }
        })
    }

    private fun intAt(args: Array<out Any?>, index: Int): Int = when (val raw = args.getOrNull(index)) {
        is Number -> raw.toInt()
        else -> raw?.toString()?.trim()?.toIntOrNull() ?: -1
    }

    private fun fn(top: Scriptable, body: (Array<out Any?>) -> Any?) = object : BaseFunction() {
        override fun call(cx: Context?, scope: Scriptable?, thisObj: Scriptable?, args: Array<out Any?>?): Any? =
            body(args ?: emptyArray())
    }
}

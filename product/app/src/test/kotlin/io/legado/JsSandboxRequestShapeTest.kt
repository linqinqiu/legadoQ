package io.legado

import io.legado.rules.JsExecutionContext
import io.legado.rules.JsSandbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * 沙箱里**不出现 Java 对象引用**是这套隔离的一条不变量：脚本能拿到的只有宿主替身
 * （`NativeObject` / `BaseFunction` / 原生值）。只要有一个真实 Java 实例漏进去，
 * 安全性就从"白名单 + 无引用"退化成"全押在 `ClassShutter { false }` 一个开关上"。
 *
 * 这里钉 `okhttp3.Request.Builder().build()` 的产物。它曾经把 `RequestData`（Kotlin data class）
 * 挂在 `_request` 上，`newCall` 再取回来 —— 当下不可利用（Rhino 包成 `NativeJavaObject`，
 * 成员访问被 shutter 拦下），但违反不变量。现在改成挂四个原生值、`newCall` 侧还原，
 * 语义由 `JsCachePackagesBridgeTest` 的 okhttp 用例继续钉着（方法/头/正文/URL 都真的传到了抓取层）。
 *
 * 判据只断言**形状**，不判实现：`_request` 必须消失，属性表必须正好是这五个。
 * 形状变了说明有人又把宿主对象挂上去了，或者加了新字段却没更新这条判据。
 */
class JsSandboxRequestShapeTest {

    private fun eval(script: String): String? =
        JsSandbox().eval(script, emptyMap(), JsExecutionContext(sourceId = "https://shape.example"))

    private fun buildRequestKeys(): String? = eval(
        """
        var builder = new Packages.okhttp3.Request.Builder();
        builder.url("https://shape.example/a").addHeader("X-A", "1");
        var built = builder.build();
        var keys = [];
        for (var key in built) { keys.push(key); }
        keys.sort().join(",")
        """.trimIndent(),
    )

    @Test
    fun `build 产物的属性表里没有宿主对象`() {
        val keys = buildRequestKeys()
        assertNotNull("脚本应当能建出 Request 并枚举它的属性", keys)
        assertEquals(
            "build() 的属性表变了。若确实新增字段，改这条判据；若是又挂了宿主对象，改回原生值",
            "_body,_headers,_method,_url,url",
            keys,
        )
    }

    @Test
    fun `_request 这个宿主对象槽位已经不存在`() {
        val out = eval(
            """
            var builder = new Packages.okhttp3.Request.Builder();
            builder.url("https://shape.example/a");
            typeof builder.build()._request
            """.trimIndent(),
        )
        assertEquals("_request 必须彻底消失，不能只是换个名字继续挂 Java 实例", "undefined", out)
    }
}

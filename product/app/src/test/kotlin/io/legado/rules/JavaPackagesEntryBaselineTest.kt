package io.legado.rules

import io.legado.rules.JsExecutionContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.mozilla.javascript.Context
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject

/**
 * `JavaPackages` 对外暴露面的**枚举式基线**（审计 §3 E 项的前置判据）。
 *
 * 为什么需要它：沙箱第 2 层是一份**手写替身白名单**，「漏一个就是一个洞」。宿主侧累计预算
 * （[io.legado.rules.BoundedJs.chargeHostBytes]）已经落地，但它和名单是同一个失效模式 ——
 * 谁新加一个入口却忘了记账，没有任何东西会红。这条判据把「当前到底暴露了什么」固定成一份
 * 可枚举的基线：入口增删都必须显式改这里，改的时候就会被问一句「这个入口记账了吗」。
 *
 * 判定口径：
 * 1. **枚举是实测的**，不是抄源码文本：反射构造 `JavaPackages`，对 `CLASS_NAMES` 里每个类
 *    调 `resolve()` 取回替身对象，再读它真实的属性表。名字改了、类被删了，这里立刻红。
 * 2. **清单精确相等**，不是「包含」：少一个 = 有人静默删了能力；多一个 = 有人加了新入口
 *    却没登记。两种都要人来看一眼，报错里给出处置办法。
 * 3. **记账入口单独钉一份**：这些入口的实现里必须继续有 `chargeHostBytes` /
 *    `requireAllowedLength`。判据钉不住「实现有没有记账」的语义，但能钉住「入口名字还在」——
 *    改名时记账静默丢失是这条防线最现实的死法。
 *
 * 新增入口的正确姿势（三件同一笔提交）：① 在实现里按需记账；② 把入口加进本文件基线；
 * ③ 在 `product/docs/rules-sandbox-audit.md` §3 E 项记一句「新增了什么、记账点在哪」。
 */
class JavaPackagesEntryBaselineTest {

    private class Exposed(val classes: List<String>, val entries: List<String>, val constructorOnly: List<String>)

    /** 反射把 `JavaPackages` 当前暴露的东西全部枚举出来。 */
    private fun enumerate(): Exposed {
        Context.enter().use { cx ->
            cx.optimizationLevel = -1
            val scope: Scriptable = cx.initStandardObjects()
            val cls = JavaPackages::class.java
            val ctor = cls.getDeclaredConstructor(
                Context::class.java,
                Scriptable::class.java,
                RuleRunner::class.java,
                JsExecutionContext::class.java,
            ).apply { isAccessible = true }
            val instance = ctor.newInstance(cx, scope, null, JsExecutionContext(sourceId = "https://baseline.example"))
            cls.getDeclaredMethod("install").apply { isAccessible = true }.invoke(instance)
            val resolve = cls.getDeclaredMethod("resolve", String::class.java).apply { isAccessible = true }

            val companion = cls.declaredFields.first { it.name == "Companion" }.apply { isAccessible = true }.get(null)
            val classNamesField = listOf(cls, companion.javaClass).asSequence()
                .flatMap { it.declaredFields.asSequence() }
                .firstOrNull { it.name == "CLASS_NAMES" }
                ?: error("JavaPackages 的 CLASS_NAMES 找不到了 —— 白名单结构变了，先看实现再更新本判据")
            classNamesField.isAccessible = true
            @Suppress("UNCHECKED_CAST")
            val classNames = (classNamesField.get(if (classNamesField.declaringClass == cls) null else companion) as Set<String>)
                .sorted()

            val entries = mutableListOf<String>()
            val constructorOnly = mutableListOf<String>()
            classNames.forEach { name ->
                val resolved = runCatching { resolve.invoke(instance, name) }.getOrNull()
                val ids = (resolved as? ScriptableObject)?.ids
                    ?.map { it.toString() }
                    ?.filterNot { it.startsWith("__") }
                    ?.sorted()
                    .orEmpty()
                if (ids.isEmpty()) constructorOnly += name
                ids.forEach { entries += "$name#$it" }
            }
            return Exposed(classNames, entries.sorted(), constructorOnly.sorted())
        }
    }

    @Test
    fun `暴露的类清单与基线精确一致`() {
        val exposed = enumerate()
        assertEquals(
            "JavaPackages 的类白名单变了。不是坏事的可能性更大，但必须显式确认：\n" +
                "  · 新增类 → 在实现里按需记账（chargeHostBytes / requireAllowedLength），再把名字加进本基线；\n" +
                "  · 删除类 → 确认没有源还在用它（docs/research/研究-书源JS与字段缺口实测 里有真库抽样口径）。\n" +
                "多的：${exposed.classes - BASELINE_CLASSES}\n少的：${BASELINE_CLASSES - exposed.classes}",
            BASELINE_CLASSES.sorted(),
            exposed.classes,
        )
    }

    @Test
    fun `暴露的入口清单与基线精确一致`() {
        val exposed = enumerate()
        assertEquals(
            "JavaPackages 的入口表变了。新增入口请三件一起做：①实现里记账；②更新本基线；③在\n" +
                "product/docs/rules-sandbox-audit.md §3 E 项记一句「新增了什么、记账点在哪」。\n" +
                "多的：${exposed.entries - BASELINE_ENTRIES}\n少的：${BASELINE_ENTRIES - exposed.entries}",
            BASELINE_ENTRIES.sorted(),
            exposed.entries,
        )
    }

    @Test
    fun `只会 new 出实例、没有静态入口的类仍在那份基线里`() {
        val exposed = enumerate()
        assertEquals(
            "这些类没有静态入口（只能 new 出实例，方法都在实例上）。它们同样占着逃逸面：\n" +
                "实例方法的记账由各自的收口函数保证（StringBuilder 增长 / SecureRandom.nextBytes /\n" +
                "Base64 解码输入上限），所以类本身必须留在这份基线里。\n" +
                "多的：${exposed.constructorOnly - CONSTRUCTOR_ONLY_CLASSES}\n少的：${CONSTRUCTOR_ONLY_CLASSES - exposed.constructorOnly}",
            CONSTRUCTOR_ONLY_CLASSES.sorted(),
            exposed.constructorOnly,
        )
    }

    /**
     * 记账入口的名字必须还在。
     *
     * 这条判据不证明「实现里还在记账」（语义测不了），但它挡住最常见的那种死法：
     * 把 `copyOf` 改名成 `copy`、或把 `gzip` 挪进别的类，记账点留在原地、入口悄悄绕过去。
     * 名字一变，这里先红，人才会回头去读那几行记账代码。
     */
    @Test
    fun `带宿主预算记账的入口名字必须还在`() {
        val exposed = enumerate()
        val missing = CHARGED_ENTRIES.filterNot { it in exposed.entries }
        assertTrue(
            "这些入口的实现里带 chargeHostBytes / requireAllowedLength，但枚举里已经找不到它们：$missing\n" +
                "如果只是改名，请把记账一并搬到新名字上，再同步本基线。",
            missing.isEmpty(),
        )
        val missingClasses = CHARGED_CONSTRUCTOR_CLASSES.filterNot { it in exposed.classes }
        assertTrue(
            "这些类的实例方法带宿主预算记账，但类已经从白名单里消失：$missingClasses",
            missingClasses.isEmpty(),
        )
    }

    private companion object {
        /** 类白名单基线（43 项，2026-11-14 实测）。 */
        val BASELINE_CLASSES: Set<String> = setOf(
        "android.os.Build", "android.text.TextUtils",
        "android.util.Base64", "cn.hutool.core.codec.Base64",
        "cn.hutool.core.util.StrUtil", "cn.hutool.core.util.ZipUtil",
        "cn.hutool.crypto.digest.DigestUtil", "java.lang.Boolean",
        "java.lang.Double", "java.lang.Float",
        "java.lang.Integer", "java.lang.Long",
        "java.lang.String", "java.lang.StringBuffer",
        "java.lang.StringBuilder", "java.lang.System",
        "java.lang.Thread", "java.net.URLDecoder",
        "java.net.URLEncoder", "java.security.KeyFactory",
        "java.security.MessageDigest", "java.security.SecureRandom",
        "java.security.Signature", "java.security.spec.PKCS8EncodedKeySpec",
        "java.security.spec.X509EncodedKeySpec", "java.util.ArrayList",
        "java.util.Arrays", "java.util.Base64",
        "java.util.HashMap", "java.util.LinkedHashMap",
        "java.util.UUID", "javax.crypto.Cipher",
        "javax.crypto.Mac", "javax.crypto.SecretKeyFactory",
        "javax.crypto.spec.DESKeySpec", "javax.crypto.spec.GCMParameterSpec",
        "javax.crypto.spec.IvParameterSpec", "javax.crypto.spec.SecretKeySpec",
        "okhttp3.HttpUrl", "okhttp3.MediaType",
        "okhttp3.OkHttpClient", "okhttp3.Request",
        "okhttp3.RequestBody",
        )

        /** 静态入口基线（98 项，2026-11-14 实测）。 */
        val BASELINE_ENTRIES: Set<String> = setOf(
        "android.os.Build#BRAND", "android.os.Build#DEVICE",
        "android.os.Build#DISPLAY", "android.os.Build#ID",
        "android.os.Build#MANUFACTURER", "android.os.Build#MODEL",
        "android.os.Build#PRODUCT", "android.os.Build#VERSION",
        "android.text.TextUtils#equals", "android.text.TextUtils#isEmpty",
        "android.text.TextUtils#join", "android.util.Base64#CRLF",
        "android.util.Base64#DEFAULT", "android.util.Base64#NO_CLOSE",
        "android.util.Base64#NO_PADDING", "android.util.Base64#NO_WRAP",
        "android.util.Base64#URL_SAFE", "android.util.Base64#decode",
        "android.util.Base64#encode", "android.util.Base64#encodeToString",
        "cn.hutool.core.codec.Base64#decode", "cn.hutool.core.codec.Base64#decodeStr",
        "cn.hutool.core.codec.Base64#decodeUrlSafe", "cn.hutool.core.codec.Base64#encode",
        "cn.hutool.core.codec.Base64#encodeUrlSafe", "cn.hutool.core.util.StrUtil#contains",
        "cn.hutool.core.util.StrUtil#format", "cn.hutool.core.util.StrUtil#isBlank",
        "cn.hutool.core.util.StrUtil#isEmpty", "cn.hutool.core.util.StrUtil#isNotBlank",
        "cn.hutool.core.util.StrUtil#isNotEmpty", "cn.hutool.core.util.StrUtil#reverse",
        "cn.hutool.core.util.StrUtil#toString", "cn.hutool.core.util.ZipUtil#gzip",
        "cn.hutool.core.util.ZipUtil#unGzip", "cn.hutool.crypto.digest.DigestUtil#digestHex",
        "cn.hutool.crypto.digest.DigestUtil#hmacMd5", "cn.hutool.crypto.digest.DigestUtil#md5Hex",
        "cn.hutool.crypto.digest.DigestUtil#sha1Hex", "cn.hutool.crypto.digest.DigestUtil#sha256Hex",
        "java.lang.Boolean#FALSE", "java.lang.Boolean#TRUE",
        "java.lang.Boolean#parseBoolean", "java.lang.Boolean#valueOf",
        "java.lang.Double#isNaN", "java.lang.Double#parseDouble",
        "java.lang.Double#valueOf", "java.lang.Float#parseFloat",
        "java.lang.Float#valueOf", "java.lang.Integer#MAX_VALUE",
        "java.lang.Integer#MIN_VALUE", "java.lang.Integer#parseInt",
        "java.lang.Integer#toBinaryString", "java.lang.Integer#toHexString",
        "java.lang.Integer#toString", "java.lang.Integer#valueOf",
        "java.lang.Long#MAX_VALUE", "java.lang.Long#MIN_VALUE",
        "java.lang.Long#parseLong", "java.lang.Long#toHexString",
        "java.lang.Long#valueOf", "java.lang.String#format",
        "java.lang.String#valueOf", "java.lang.System#arraycopy",
        "java.lang.System#currentTimeMillis", "java.lang.System#getProperty",
        "java.lang.System#getenv", "java.lang.System#nanoTime",
        "java.lang.Thread#currentThread", "java.lang.Thread#sleep",
        "java.net.URLDecoder#decode", "java.net.URLEncoder#encode",
        "java.security.KeyFactory#getInstance", "java.security.MessageDigest#getInstance",
        "java.security.Signature#getInstance", "java.util.Arrays#copyOf",
        "java.util.Arrays#copyOfRange", "java.util.Arrays#equals",
        "java.util.Arrays#fill", "java.util.Arrays#toString",
        "java.util.Base64#getDecoder", "java.util.Base64#getEncoder",
        "java.util.Base64#getMimeDecoder", "java.util.Base64#getMimeEncoder",
        "java.util.Base64#getUrlDecoder", "java.util.Base64#getUrlEncoder",
        "java.util.UUID#randomUUID", "javax.crypto.Cipher#DECRYPT_MODE",
        "javax.crypto.Cipher#ENCRYPT_MODE", "javax.crypto.Cipher#UNWRAP_MODE",
        "javax.crypto.Cipher#WRAP_MODE", "javax.crypto.Cipher#getInstance",
        "javax.crypto.Mac#getInstance", "javax.crypto.SecretKeyFactory#getInstance",
        "okhttp3.HttpUrl#parse", "okhttp3.MediaType#parse",
        "okhttp3.Request#Builder", "okhttp3.RequestBody#create",
        )

        /** 只有构造、没有静态入口的类（13 项）。 */
        val CONSTRUCTOR_ONLY_CLASSES: Set<String> = setOf(
        "java.lang.StringBuffer", "java.lang.StringBuilder",
        "java.security.SecureRandom", "java.security.spec.PKCS8EncodedKeySpec",
        "java.security.spec.X509EncodedKeySpec", "java.util.ArrayList",
        "java.util.HashMap", "java.util.LinkedHashMap",
        "javax.crypto.spec.DESKeySpec", "javax.crypto.spec.GCMParameterSpec",
        "javax.crypto.spec.IvParameterSpec", "javax.crypto.spec.SecretKeySpec",
        "okhttp3.OkHttpClient",
        )

        /** 入口级记账：实现里必有 chargeHostBytes / requireAllowedLength。 */
        val CHARGED_ENTRIES: Set<String> = setOf(
        "android.util.Base64#decode", "cn.hutool.core.codec.Base64#decode",
        "cn.hutool.core.codec.Base64#decodeStr", "cn.hutool.core.codec.Base64#decodeUrlSafe",
        "cn.hutool.core.util.StrUtil#format", "cn.hutool.core.util.ZipUtil#gzip",
        "cn.hutool.core.util.ZipUtil#unGzip", "java.lang.System#arraycopy",
        "java.util.Arrays#copyOf", "java.util.Arrays#copyOfRange",
        "java.util.Arrays#equals", "java.util.Arrays#fill",
        )

        /** 类级记账：实例方法里有收口上限。 */
        val CHARGED_CONSTRUCTOR_CLASSES: Set<String> = setOf(
        "java.lang.StringBuffer", "java.lang.StringBuilder",
        "java.security.SecureRandom", "java.util.ArrayList",
        "java.util.HashMap", "java.util.LinkedHashMap",
        )
    }
}

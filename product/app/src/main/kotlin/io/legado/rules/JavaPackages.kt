package io.legado.rules

import kotlinx.serialization.json.Json
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.Context
import org.mozilla.javascript.Function
import org.mozilla.javascript.NativeJSON
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.Charset
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.AlgorithmParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.IdentityHashMap
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.DESKeySpec
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Legado 脚本环境里的 `Packages` / `JavaImporter`（白名单版）。
 *
 * 为什么需要：启用库里有 **120 处 `JavaImporter`、116 处 `importPackage`**，
 * 形状几乎都是 `with (javaImport) { Cipher.getInstance(...) }`；`Packages` 本身另有 32 份源在用。
 * 沙箱禁了 Java 反射（`setClassShutter { false }` 是 RCE 底线），所以这里**不接真 Java 类**，
 * 而是给一份手工实现、行为对齐上游的替身：
 *
 * - 命名空间树是**白名单**：只有声明过的包/类能取到，其余是 undefined，`new` 会像上游缺类一样报错；
 * - `JavaImporter` 的 `with` 作用域按 import 顺序找简单类名（`Base64` 在番茄是 hutool、在 9x 是
 *   android.util，同名不同实现，必须按导入的包区分）；
 * - 返回给脚本的一律是 JS 对象/字符串/数组，**没有一个 Java 对象引用**能穿进沙箱。
 *
 * 覆盖的是实测里真正被调用的那批：加解密（Cipher/Mac/SecretKeySpec/RSA 签名）、Base64 三种口径、
 * String/StringBuilder、Arrays、Hash/Map、UUID、Thread/System、ByteArrayOutputStream、GZIP、
 * hutool 的 StrUtil/DigestUtil/ZipUtil，以及番茄系用的 okhttp3 同步调用。
 *
 * 故意不做：`io.legado.app...`（除了少数「探测是否安装了魔改版」的 try/catch 探测，让它们照旧失败）、
 * `android.graphics.BitmapFactory`（解码图片要真位图，替不了）。
 */
internal class JavaPackages(
    private val cx: Context,
    private val scope: Scriptable,
    private val runner: RuleRunner?,
    private val execContext: JsExecutionContext?,
) {
    private val top: Scriptable = ScriptableObject.getTopLevelScope(scope)

    /**
     * 原生的 JS String 构造器。捕获时机必须在任何 `importPackage(java.lang)` 之前 ——
     * 之后全局 `String` 可能被我们的 Java String 替身盖住，再用名字去找就会递归。
     */
    private val nativeStringCtor: Function? = ScriptableObject.getProperty(top, "String") as? Function

    private val classCache = mutableMapOf<String, Any>()
    private val keyMaterial = IdentityHashMap<Any, KeyMaterial>()

    fun install() {
        ScriptableObject.putProperty(scope, "Packages", packagesRoot())
        ScriptableObject.putProperty(scope, "JavaImporter", importerClass())
        ScriptableObject.putProperty(scope, "importPackage", globalImportPackage())
        ScriptableObject.putProperty(scope, "importClass", globalImportClass())
    }

    // ── 命名空间树 ──────────────────────────────────────────────

    private fun packagesRoot(): Scriptable = PackageNode("")

    private inner class PackageNode(override val path: String) : NativeObject(), WhitelistMarker {
        init {
            parentScope = top
        }

        override fun get(name: String, start: Scriptable): Any? {
            // 这些名字不能被当成包路径去解析（`Packages.toString` 之类的日常调用）
            if (name in OBJECT_MEMBERS) return super.get(name, start)
            val full = if (path.isEmpty()) name else "$path.$name"
            resolve(full)?.let { return it }
            if (full in NAMESPACES || full.startsWith("org.jsoup")) {
                return PackageNode(full)
            }
            return NOT_FOUND
        }
    }

    private interface WhitelistMarker {
        val path: String
    }

    private fun importerClass(): BaseFunction = object : BaseFunction() {
        init {
            parentScope = top
        }

        override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any =
            makeImporter(args.toList())

        override fun construct(cx: Context, scope: Scriptable, args: Array<out Any?>): Scriptable =
            makeImporter(args.toList())
    }

    private fun makeImporter(initial: List<Any?>): Scriptable {
        val importer = ImporterObject()
        initial.forEach { arg ->
            when (arg) {
                is WhitelistMarker -> importer.packages.add(arg.path)
                is ImporterObject -> {
                    importer.packages.addAll(arg.packages)
                    importer.classNames.addAll(arg.classNames)
                }
                is JsClass -> importer.classNames.add(arg.fullName)
            }
        }
        return importer
    }

    private inner class ImporterObject : NativeObject() {
        val packages = mutableListOf<String>()
        val classNames = mutableListOf<String>()

        init {
            parentScope = top
            ScriptableObject.putProperty(this, "importPackage", fn { args ->
                args.forEach { arg ->
                    when (arg) {
                        is WhitelistMarker -> packages.add(arg.path)
                        is ImporterObject -> packages.addAll(arg.packages)
                        is CharSequence -> packages.add(arg.toString())
                    }
                }
                Context.getUndefinedValue()
            })
            ScriptableObject.putProperty(this, "importClass", fn { args ->
                args.forEach { arg ->
                    when (arg) {
                        is JsClass -> classNames.add(arg.fullName)
                        is ImporterObject -> classNames.addAll(arg.classNames)
                    }
                }
                Context.getUndefinedValue()
            })
            ScriptableObject.putProperty(this, "toString", fn { "JavaImporter" })
        }

        override fun get(name: String, start: Scriptable): Any? {
            val own = super.get(name, start)
            if (own !== NOT_FOUND) return own
            // 精确 importClass 优先；其次按 importPackage 的顺序找同名类。
            for (full in classNames) {
                if (full.substringAfterLast('.') != name) continue
                resolve(full)?.let { return it }
            }
            for (pkg in packages) {
                resolve(if (pkg.isEmpty()) name else "$pkg.$name")?.let { return it }
            }
            return NOT_FOUND
        }
    }

    private fun globalImportPackage(): BaseFunction = fn { args ->
        args.filterIsInstance<WhitelistMarker>().forEach { marker ->
            PACKAGE_CLASSES[marker.path]?.forEach { simple ->
                // 不覆盖 JS 内置（String/Array/Object…）：responseView 与脚本本身都靠原生构造器。
                if (simple in JS_BUILTINS) return@forEach
                resolve("${marker.path}.$simple")?.let { ScriptableObject.putProperty(top, simple, it) }
            }
        }
        Context.getUndefinedValue()
    }

    private fun globalImportClass(): BaseFunction = fn { args ->
        args.filterIsInstance<JsClass>().forEach { cls ->
            ScriptableObject.putProperty(top, cls.fullName.substringAfterLast('.'), cls)
        }
        Context.getUndefinedValue()
    }

    // ── 类解析 ──────────────────────────────────────────────────

    private fun resolve(full: String): Any? {
        if (full.startsWith("org.jsoup")) return resolveJsoup(full)
        if (full !in CLASS_NAMES) return null
        return classCache.getOrPut(full) { buildClass(full) }
    }

    private fun resolveJsoup(full: String): Any? {
        val org = ScriptableObject.getProperty(top, "org") as? Scriptable ?: return null
        val jsoupNs = ScriptableObject.getProperty(org, "jsoup") as? Scriptable ?: return null
        val nodes = ScriptableObject.getProperty(jsoupNs, "nodes") as? Scriptable
        return when (full) {
            "org.jsoup" -> jsoupNs
            "org.jsoup.Jsoup" -> ScriptableObject.getProperty(jsoupNs, "Jsoup")
            "org.jsoup.nodes" -> nodes
            "org.jsoup.nodes.Document" -> nodes?.let { ScriptableObject.getProperty(it, "Document") }
            "org.jsoup.nodes.Element" -> nodes?.let { ScriptableObject.getProperty(it, "Element") }
            "org.jsoup.nodes.Elements" -> nodes?.let { ScriptableObject.getProperty(it, "Elements") }
            "org.jsoup.Connection" -> obj(
                "Method" to obj(
                    "GET" to "GET", "POST" to "POST", "PUT" to "PUT",
                    "DELETE" to "DELETE", "HEAD" to "HEAD", "PATCH" to "PATCH",
                ),
            )
            else -> null
        }
    }

    private inner class JsClass(
        val fullName: String,
        private val constructFn: (Array<out Any?>) -> Any?,
        statics: Map<String, (Array<out Any?>) -> Any?> = emptyMap(),
        fields: Map<String, Any?> = emptyMap(),
    ) : BaseFunction() {
        init {
            parentScope = top
            fields.forEach { (key, value) -> ScriptableObject.putProperty(this, key, value) }
            statics.forEach { (key, value) -> ScriptableObject.putProperty(this, key, fn(value)) }
        }

        override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any =
            constructFn(args) ?: Context.getUndefinedValue()

        override fun construct(cx: Context, scope: Scriptable, args: Array<out Any?>): Scriptable =
            constructFn(args) as? Scriptable ?: NativeObject().also { it.parentScope = top }
    }

    private fun buildClass(full: String): Any = when (full) {
        // ── java.lang ──────────────────────────────────────────
        "java.lang.Thread" -> jsClass(full, statics = mapOf(
            "sleep" to { args ->
                val millis = (args.firstOrNull() as? Number)?.toLong() ?: 0L
                // 单次 sleep 上限。书源里 sleep 只用来"礼貌等一下"，没有睡超过 1 秒的正当理由；
                // 而不设上限时它是一条**绕开 JsGuard 的通道**：Thread.sleep 是宿主阻塞，不消耗 Rhino
                // 指令，observeInstructionCount 永远等不到回调 —— 一句
                // Packages.java.lang.Thread.sleep(999999) 就能占死工作线程，墙钟守卫完全看不见。
                runCatching { Thread.sleep(millis.coerceIn(0L, MAX_SLEEP_MS)) }
                Context.getUndefinedValue()
            },
            "currentThread" to { _ ->
                obj(
                    "getName" to fn { "main" },
                    "sleep" to fn { args ->
                        val millis = (args.firstOrNull() as? Number)?.toLong() ?: 0L
                        runCatching { Thread.sleep(millis.coerceIn(0L, MAX_SLEEP_MS)) }
                        Context.getUndefinedValue()
                    },
                )
            },
        ))
        "java.lang.System" -> jsClass(full, statics = mapOf(
            "currentTimeMillis" to { System.currentTimeMillis() },
            "nanoTime" to { System.nanoTime() },
            "getProperty" to { args ->
                when (args.firstOrNull()?.toString()) {
                    "line.separator" -> "\n"
                    "file.encoding" -> "UTF-8"
                    "java.version" -> System.getProperty("java.version") ?: ""
                    else -> ""
                }
            },
            // 原本这里直通 System.getenv(...)，已移除：书源脚本不可信，没有任何一条规则需要读宿主
            // 环境变量，而它会把部署方放在环境变量里的凭据（API key / token）暴露给任意一份导入的源。
            // 保留 key 本身、恒返回空串，是为了让"探测环境变量是否存在"的脚本不会抛 TypeError。
            "getenv" to { _ -> "" },
            "arraycopy" to { args -> arraycopy(args); Context.getUndefinedValue() },
        ))
        "java.lang.String" -> jsClass(
            full,
            constructFn = { args -> javaString(args) },
            statics = mapOf(
                "valueOf" to { args -> textOf(args.firstOrNull()) },
                "format" to { args -> formatText(args) },
            ),
        )
        "java.lang.StringBuilder", "java.lang.StringBuffer" -> jsClass(full, constructFn = { args ->
            val sb = StringBuilder(args.firstOrNull()?.let(::textOf) ?: "")
            val box = obj()
            fun method(name: String, body: (Array<out Any?>) -> Any?) {
                ScriptableObject.putProperty(box, name, fn(body))
            }
            method("append") { a ->
                val value = a.getOrNull(0)
                val before = sb.length
                if (value is Number) sb.append(value.toInt()) else if (value is Boolean) sb.append(value) else sb.append(textOf(value))
                // 累计长度上限。只卡 setLength 是**假的防护**：`append` 完全绕过它。
                // 实测 `for (i=0;i<200;i++) sb.append('a'.repeat(1000000))` 只有几千条 Rhino 指令
                //（远低于 2 万条的检查间隔），宿主侧却已累计 200MB+；叠几次就是 GB 级，
                // 而且每一步都是宿主 char 数组增长，墙钟守卫零回调。
                requireStringBuilderWithinLimit(before, sb.length)
                box
            }
            method("toString") { sb.toString() }
            method("length") { sb.length }
            method("reverse") { sb.reverse(); box }
            method("insert") { a ->
                val index = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                val before = sb.length
                sb.insert(index.coerceIn(0, sb.length), textOf(a.getOrNull(1)))
                requireStringBuilderWithinLimit(before, sb.length) // 同 append：insert 也是增长路径
                box
            }
            method("deleteCharAt") { a ->
                val index = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                if (index in sb.indices) sb.deleteCharAt(index)
                box
            }
            method("setLength") { a ->
                val length = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                // 上限。setLength 会**立即分配**对应大小的 char 数组，是脚本能直接触发的宿主内存分配：
                // 一句 sb.setLength(1_000_000_000) 就是 2GB，抛 OutOfMemoryError（Error，runCatching 兜不住）。
                // 1MB 对任何真实的字符串规则都绰绰有余。
                sb.setLength(length.coerceIn(0, MAX_STRING_BUILDER_LENGTH))
                Context.getUndefinedValue()
            }
            method("charAt") { a ->
                val index = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                if (index in sb.indices) sb[index].toString() else ""
            }
            method("substring") { a ->
                val start = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                val end = (a.getOrNull(1) as? Number)?.toInt() ?: sb.length
                if (start in 0..sb.length && end in start..sb.length) sb.substring(start, end) else ""
            }
            box
        })
        "java.lang.Integer" -> jsClass(full, constructFn = { a ->
            (a.firstOrNull() as? Number)?.toInt() ?: a.firstOrNull()?.toString()?.toIntOrNull() ?: 0
        }, statics = mapOf(
            "parseInt" to { a ->
                val text = textOf(a.getOrNull(0)).trim()
                val radix = (a.getOrNull(1) as? Number)?.toInt() ?: 10
                text.toIntOrNull(radix) ?: 0
            },
            "toHexString" to { a -> Integer.toHexString((a.firstOrNull() as? Number)?.toInt() ?: 0) },
            "toBinaryString" to { a -> Integer.toBinaryString((a.firstOrNull() as? Number)?.toInt() ?: 0) },
            "valueOf" to { a -> (a.firstOrNull() as? Number)?.toInt() ?: a.firstOrNull()?.toString()?.toIntOrNull() ?: 0 },
            "toString" to { a -> textOf(a.firstOrNull()) },
        ), fields = mapOf("MAX_VALUE" to Int.MAX_VALUE, "MIN_VALUE" to Int.MIN_VALUE))
        "java.lang.Long" -> jsClass(full, constructFn = { a ->
            (a.firstOrNull() as? Number)?.toLong() ?: a.firstOrNull()?.toString()?.toLongOrNull() ?: 0L
        }, statics = mapOf(
            "parseLong" to { a -> textOf(a.firstOrNull()).trim().toLongOrNull() ?: 0L },
            "toHexString" to { a -> java.lang.Long.toHexString((a.firstOrNull() as? Number)?.toLong() ?: 0L) },
            "valueOf" to { a -> (a.firstOrNull() as? Number)?.toLong() ?: a.firstOrNull()?.toString()?.toLongOrNull() ?: 0L },
        ), fields = mapOf("MAX_VALUE" to Long.MAX_VALUE, "MIN_VALUE" to Long.MIN_VALUE))
        "java.lang.Double" -> jsClass(full, constructFn = { a ->
            (a.firstOrNull() as? Number)?.toDouble() ?: a.firstOrNull()?.toString()?.toDoubleOrNull() ?: 0.0
        }, statics = mapOf(
            "parseDouble" to { a -> textOf(a.firstOrNull()).trim().toDoubleOrNull() ?: 0.0 },
            "valueOf" to { a -> (a.firstOrNull() as? Number)?.toDouble() ?: a.firstOrNull()?.toString()?.toDoubleOrNull() ?: 0.0 },
            "isNaN" to { a -> (a.firstOrNull() as? Number)?.toDouble()?.isNaN() ?: false },
        ))
        "java.lang.Float" -> jsClass(full, constructFn = { a ->
            (a.firstOrNull() as? Number)?.toFloat() ?: a.firstOrNull()?.toString()?.toFloatOrNull() ?: 0f
        }, statics = mapOf(
            "parseFloat" to { a -> textOf(a.firstOrNull()).trim().toFloatOrNull() ?: 0f },
            "valueOf" to { a -> (a.firstOrNull() as? Number)?.toFloat() ?: a.firstOrNull()?.toString()?.toFloatOrNull() ?: 0f },
        ))
        "java.lang.Boolean" -> jsClass(full, constructFn = { a ->
            when (val v = a.firstOrNull()) {
                is Boolean -> v
                null -> false
                else -> v.toString().equals("true", ignoreCase = true)
            }
        }, statics = mapOf(
            "parseBoolean" to { a -> a.firstOrNull()?.toString().equals("true", ignoreCase = true) },
            "valueOf" to { a -> a.firstOrNull()?.toString().equals("true", ignoreCase = true) },
        ), fields = mapOf("TRUE" to true, "FALSE" to false))

        // ── java.util ──────────────────────────────────────────
        "java.util.UUID" -> jsClass(full,
            constructFn = { _ -> uuidBox(UUID.randomUUID().toString()) },
            statics = mapOf("randomUUID" to { _ -> uuidBox(UUID.randomUUID().toString()) }),
        )
        "java.util.Base64" -> jsClass(full, statics = mapOf(
            "getEncoder" to { _ -> base64Encoder(urlSafe = false) },
            "getUrlEncoder" to { _ -> base64Encoder(urlSafe = true) },
            "getMimeEncoder" to { _ -> base64Encoder(urlSafe = false) },
            "getDecoder" to { _ -> base64Decoder(urlSafe = false, mime = false) },
            "getUrlDecoder" to { _ -> base64Decoder(urlSafe = true, mime = false) },
            "getMimeDecoder" to { _ -> base64Decoder(urlSafe = false, mime = true) },
        ))
        "java.util.Arrays" -> jsClass(full, statics = mapOf(
            "copyOfRange" to { a ->
                val source = bytesOfOrNull(a.getOrNull(0))
                val from = (a.getOrNull(1) as? Number)?.toInt() ?: 0
                val to = (a.getOrNull(2) as? Number)?.toInt() ?: from
                if (source == null) bytesArray(ByteArray(0))
                else {
                    val start = from.coerceIn(0, source.size)
                    val end = to.coerceIn(start, source.size)
                    bytesArray(source.copyOfRange(start, end))
                }
            },
            "copyOf" to { a ->
                val source = bytesOfOrNull(a.getOrNull(0)) ?: ByteArray(0)
                val length = (a.getOrNull(1) as? Number)?.toInt() ?: source.size
                // 上限：length 由脚本给，`copyOf([1], 2147483000)` 就是一次 2GB 宿主分配。
                requireAllowedLength(length, "copyOf 目标长度")
                bytesArray(source.copyOf(length.coerceAtLeast(0)))
            },
            "fill" to { a ->
                val target = a.getOrNull(0)
                val value = (a.getOrNull(1) as? Number)?.toInt()?.toByte() ?: 0
                if (target is Scriptable) {
                    val length = arrayLength(target)
                    for (i in 0 until length) ScriptableObject.putProperty(target, i.toString(), value.toInt() and 0xFF)
                }
                Context.getUndefinedValue()
            },
            "equals" to { a -> bytesOf(a.getOrNull(0)).contentEquals(bytesOf(a.getOrNull(1))) },
            "toString" to { a -> bytesOf(a.firstOrNull()).joinToString(", ", "[", "]") },
        ))
        "java.util.HashMap", "java.util.LinkedHashMap" -> jsClass(full, constructFn = { a ->
            val entries = mutableMapOf<String, Any?>()
            when (val other = a.firstOrNull()) {
                is NativeObject -> other.ids.forEach { id ->
                    val key = id?.toString() ?: return@forEach
                    entries[key] = ScriptableObject.getProperty(other, key)
                }
                is Map<*, *> -> other.forEach { (k, v) -> if (k != null) entries[k.toString()] = v }
            }
            JsMapObject(top, entries)
        })
        "java.util.ArrayList" -> jsClass(full, constructFn = { _ ->
            jsList()
        })

        // ── java.net ───────────────────────────────────────────
        "java.net.URLEncoder" -> jsClass(full, statics = mapOf(
            "encode" to { a ->
                val text = textOf(a.getOrNull(0))
                val charset = charsetOf(a.getOrNull(1)).name()
                runCatching { URLEncoder.encode(text, charset) }.getOrDefault("")
            },
        ))
        "java.net.URLDecoder" -> jsClass(full, statics = mapOf(
            "decode" to { a ->
                val text = textOf(a.getOrNull(0))
                val charset = charsetOf(a.getOrNull(1)).name()
                runCatching { URLDecoder.decode(text, charset) }.getOrDefault("")
            },
        ))

        // ── java.security ──────────────────────────────────────
        "java.security.MessageDigest" -> jsClass(full, statics = mapOf(
            "getInstance" to { a -> digestBox(a.firstOrNull()?.toString() ?: "MD5") },
        ))
        "java.security.SecureRandom" -> jsClass(full, constructFn = { _ -> secureRandomBox() })
        "java.security.KeyFactory" -> jsClass(full, statics = mapOf(
            "getInstance" to { a ->
                val algorithm = a.firstOrNull()?.toString() ?: "RSA"
                val factory = KeyFactory.getInstance(algorithm)
                val box = obj("getAlgorithm" to fn { algorithm })
                ScriptableObject.putProperty(box, "generatePrivate", fn { args ->
                    val spec = args.firstOrNull()
                    val bytes = keyMaterial[spec]?.secret ?: bytesOf(spec)
                    val key = runCatching { factory.generatePrivate(PKCS8EncodedKeySpec(bytes)) }.getOrNull()
                    keyBox(key, bytes, algorithm)
                })
                ScriptableObject.putProperty(box, "generatePublic", fn { args ->
                    val spec = args.firstOrNull()
                    val bytes = keyMaterial[spec]?.secret ?: bytesOf(spec)
                    val key = runCatching { factory.generatePublic(X509EncodedKeySpec(bytes)) }.getOrNull()
                    keyBox(key, bytes, algorithm)
                })
                box
            },
        ))
        "java.security.Signature" -> jsClass(full, statics = mapOf(
            "getInstance" to { a -> signatureBox(a.firstOrNull()?.toString() ?: "SHA1withRSA") },
        ))
        "java.security.spec.PKCS8EncodedKeySpec", "java.security.spec.X509EncodedKeySpec",
        "javax.crypto.spec.SecretKeySpec", "javax.crypto.spec.DESKeySpec" -> jsClass(full, constructFn = { a ->
            val bytes = bytesOf(a.getOrNull(0))
            val algorithm = when (full) {
                "javax.crypto.spec.SecretKeySpec" -> a.getOrNull(1)?.toString()?.takeIf { it.isNotBlank() } ?: "AES"
                "javax.crypto.spec.DESKeySpec" -> "DES"
                "java.security.spec.PKCS8EncodedKeySpec" -> "RSA"
                else -> "RSA"
            }
            specBox(bytes, algorithm)
        })
        "javax.crypto.spec.IvParameterSpec" -> jsClass(full, constructFn = { a ->
            ivBox(bytesOf(a.getOrNull(0)))
        })
        "javax.crypto.spec.GCMParameterSpec" -> jsClass(full, constructFn = { a ->
            val tag = (a.getOrNull(0) as? Number)?.toInt() ?: 128
            gcmBox(tag, bytesOf(a.getOrNull(1)))
        })

        // ── javax.crypto ───────────────────────────────────────
        "javax.crypto.Cipher" -> jsClass(full,
            statics = mapOf("getInstance" to { a -> cipherBox(a.firstOrNull()?.toString() ?: "AES") }),
            fields = mapOf(
                "ENCRYPT_MODE" to Cipher.ENCRYPT_MODE,
                "DECRYPT_MODE" to Cipher.DECRYPT_MODE,
                "WRAP_MODE" to Cipher.WRAP_MODE,
                "UNWRAP_MODE" to Cipher.UNWRAP_MODE,
            ),
        )
        "javax.crypto.Mac" -> jsClass(full, statics = mapOf(
            "getInstance" to { a -> macBox(a.firstOrNull()?.toString() ?: "HmacMD5") },
        ))
        "javax.crypto.SecretKeyFactory" -> jsClass(full, statics = mapOf(
            "getInstance" to { a ->
                val algorithm = a.firstOrNull()?.toString() ?: "DES"
                val factory = runCatching { SecretKeyFactory.getInstance(algorithm) }.getOrNull()
                obj("generateSecret" to fn { args ->
                    val bytes = keyMaterial[args.firstOrNull()]?.secret ?: bytesOf(args.firstOrNull())
                    val key = runCatching {
                        if (algorithm.equals("DES", ignoreCase = true) && bytes.size == 8) {
                            factory?.generateSecret(DESKeySpec(bytes))
                        } else {
                            SecretKeySpec(bytes, algorithm)
                        }
                    }.getOrNull() ?: runCatching { SecretKeySpec(bytes, algorithm) }.getOrNull()
                    keyBox(key, bytes, algorithm)
                })
            },
        ))

        // ── android.* / hutool ─────────────────────────────────
        "android.util.Base64" -> jsClass(full, statics = mapOf(
            "encodeToString" to { a ->
                Base64.getEncoder().encodeToString(bytesOf(a.getOrNull(0)))
            },
            "encode" to { a -> bytesArray(Base64.getEncoder().encode(bytesOf(a.getOrNull(0)))) },
            "decode" to { a ->
                val text = textOf(a.getOrNull(0))
                val flags = (a.getOrNull(1) as? Number)?.toInt() ?: 0
                bytesArray(decodeBase64Text(text, urlSafe = flags and ANDROID_URL_SAFE != 0))
            },
        ), fields = mapOf(
            "DEFAULT" to 0, "NO_PADDING" to 1, "NO_WRAP" to 2, "CRLF" to 4,
            "URL_SAFE" to ANDROID_URL_SAFE, "NO_CLOSE" to 16,
        ))
        "android.text.TextUtils" -> jsClass(full, statics = mapOf(
            "isEmpty" to { a -> textOf(a.firstOrNull()).isEmpty() },
            "equals" to { a -> textOf(a.getOrNull(0)) == textOf(a.getOrNull(1)) },
            "join" to { a ->
                val delimiter = textOf(a.getOrNull(0))
                val items = when (val source = a.getOrNull(1)) {
                    is Scriptable -> (0 until arrayLength(source)).map { textOf(elementOf(source, it)) }
                    else -> listOf(textOf(a.getOrNull(1)))
                }
                items.joinToString(delimiter)
            },
        ))
        "android.os.Build" -> obj(
            "MODEL" to "Pixel 6",
            "MANUFACTURER" to "Google",
            "BRAND" to "google",
            "DEVICE" to "oriole",
            "PRODUCT" to "oriole",
            "ID" to "UQ1A.240205.004",
            "DISPLAY" to "AP1A.240305.019.A1",
            "VERSION" to obj("RELEASE" to "14", "SDK_INT" to 34),
        )
        "cn.hutool.core.codec.Base64" -> jsClass(full, statics = mapOf(
            "encode" to { a -> Base64.getEncoder().encodeToString(bytesOf(a.firstOrNull())) },
            "decode" to { a -> bytesArray(decodeBase64Text(textOf(a.firstOrNull()), urlSafe = false)) },
            "decodeStr" to { a -> String(decodeBase64Text(textOf(a.firstOrNull()), urlSafe = false), Charsets.UTF_8) },
            "encodeUrlSafe" to { a -> Base64.getUrlEncoder().encodeToString(bytesOf(a.firstOrNull())) },
            "decodeUrlSafe" to { a -> bytesArray(decodeBase64Text(textOf(a.firstOrNull()), urlSafe = true)) },
        ))
        "cn.hutool.core.util.StrUtil" -> jsClass(full, statics = mapOf(
            "reverse" to { a -> textOf(a.firstOrNull()).reversed() },
            "isEmpty" to { a -> textOf(a.firstOrNull()).isEmpty() },
            "isNotEmpty" to { a -> textOf(a.firstOrNull()).isNotEmpty() },
            "isBlank" to { a -> textOf(a.firstOrNull()).isBlank() },
            "isNotBlank" to { a -> textOf(a.firstOrNull()).isNotBlank() },
            // 单遍扫描替换 `{}`。
            //
            // 原写法是 `a.drop(1).forEach { text = text.replaceFirst("{}", arg) }`：
            // 每次替换都**全串扫描并新分配一整串**，k 个参数就是 k 次 × n 字符的复制。
            // 实测 `format(200000 字的模板, 再塞 20000 个参数)` 约 4GB 拷贝，分钟到小时级的
            // 纯宿主 CPU —— 而整个 forEach 在一次 Rhino 调用里，指令观察器零回调。
            // 改成一次遍历模板、边拼边推进，复杂度 O(n + 参数总长)。
            "format" to { a ->
                val template = textOf(a.firstOrNull())
                requireAllowedLength(template.length, "StrUtil.format 模板长度")
                val args = a.drop(1)
                // 参数个数上限：`{}` 的个数不会超过模板里能出现的次数，
                // 但脚本可以塞进远超所需的参数让旧实现空转，这里直接拦住。
                requireAllowedLength(args.size, "StrUtil.format 参数个数")
                StrUtilFormat.render(template) { args.getOrNull(it)?.let(::textOf) }
            },
            "contains" to { a -> textOf(a.getOrNull(0)).contains(textOf(a.getOrNull(1))) },
            "toString" to { a -> textOf(a.firstOrNull()) },
        ))
        "cn.hutool.core.util.ZipUtil" -> jsClass(full, statics = mapOf(
            "gzip" to { a ->
                val out = GzipLimits.gzipBounded(bytesOf(a.firstOrNull()))
                BoundedJs.chargeHostBytes(out.size.toLong())
                bytesArray(out)
            },
            "unGzip" to { a ->
                // 记账在 `runCatching` **外面**：放里面会被它吞掉，累计超限就永远抛不出来。
                // 只记结果大小（不记流式中间量）—— 单次 16MB 上限已经把峰值夹住了，
                // 累计预算要拦的是"反复解压"。
                val out = runCatching { GzipLimits.unzipBounded(bytesOf(a.firstOrNull())) }.getOrNull()
                if (out != null) BoundedJs.chargeHostBytes(out.size.toLong())
                bytesArray(out ?: ByteArray(0))
            },
        ))
        "cn.hutool.crypto.digest.DigestUtil" -> jsClass(full, statics = mapOf(
            "md5Hex" to { a -> digestHex(textOf(a.firstOrNull()), "MD5") },
            "sha1Hex" to { a -> digestHex(textOf(a.firstOrNull()), "SHA-1") },
            "sha256Hex" to { a -> digestHex(textOf(a.firstOrNull()), "SHA-256") },
            "digestHex" to { a -> digestHex(textOf(a.getOrNull(1)), a.getOrNull(0)?.toString() ?: "MD5") },
            "hmacMd5" to { a -> ScriptCrypto.hmacHex(textOf(a.getOrNull(1)), "HmacMD5", textOf(a.firstOrNull())) },
        ))

        // ── okhttp3（同步调用，走统一抓取通道）─────────────────
        "okhttp3.OkHttpClient" -> jsClass(full, constructFn = { _ -> okHttpClientBox() })
        "okhttp3.Request" -> jsClass(full, statics = mapOf(
            "Builder" to { _ -> requestBuilderBox() },
        )).also { cls ->
            // `Request.Builder` 是静态内部类，`new Packages.okhttp3.Request.Builder()` 也要能取到
            ScriptableObject.putProperty(cls, "Builder", jsClass("okhttp3.Request.Builder", constructFn = { _ -> requestBuilderBox() }))
        }
        "okhttp3.RequestBody" -> jsClass(full, statics = mapOf(
            "create" to { a -> requestBodyBox(a) },
        ))
        "okhttp3.MediaType" -> jsClass(full, statics = mapOf(
            "parse" to { a -> obj("mediaType" to textOf(a.firstOrNull()), "toString" to fn { textOf(a.firstOrNull()) }) },
        ))
        "okhttp3.HttpUrl" -> jsClass(full, statics = mapOf(
            "parse" to { a -> httpUrlBox(a.firstOrNull()?.toString() ?: "") },
        ))

        else -> error("未实现的 Java 白名单类：$full")
    }

    // ── JS 对象/函数小工具 ──────────────────────────────────────

    private fun fn(block: (Array<out Any?>) -> Any?): BaseFunction = object : BaseFunction() {
        init {
            parentScope = top
        }

        override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any =
            block(args) ?: Context.getUndefinedValue()
    }

    private fun obj(vararg members: Pair<String, Any?>): NativeObject = NativeObject().also { node ->
        node.parentScope = top
        members.forEach { (key, value) -> ScriptableObject.putProperty(node, key, value) }
    }

    private fun jsClass(
        fullName: String,
        constructFn: (Array<out Any?>) -> Any? = { obj() },
        statics: Map<String, (Array<out Any?>) -> Any?> = emptyMap(),
        fields: Map<String, Any?> = emptyMap(),
    ): JsClass = JsClass(fullName, constructFn, statics, fields)

    private fun textOf(value: Any?): String = when {
        value == null -> "null"
        value === Context.getUndefinedValue() -> "undefined"
        value is CharSequence -> value.toString()
        value is Number -> value.toString().removeSuffix(".0")
        value is Boolean -> value.toString()
        else -> runCatching { NativeJSON.stringify(cx, top, value, null, null).toString() }.getOrNull() ?: value.toString()
    }

    private fun charsetOf(value: Any?): Charset {
        val name = value?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return Charsets.UTF_8
        return runCatching { Charset.forName(name) }.getOrDefault(Charsets.UTF_8)
    }

    private fun isByteLike(value: Any?): Boolean = when {
        value == null || value === Context.getUndefinedValue() -> false
        value is ByteArray -> true
        value is CharSequence -> false
        value is Scriptable -> runCatching { ScriptableObject.getProperty(value, "length") is Number }.getOrDefault(false)
        else -> false
    }

    /**
     * 读数组的第 [index] 个元素。
     *
     * **必须先用 int 下标的 `Scriptable.get(int)`**：Rhino 1.8 的 NativeArray 全数字数组走
     * 稠密存储，`getProperty(array, "0")`（字符串下标）拿不到元素 —— 实测 `[65,66,67]`
     * 经字符串下标读成 `NOT_FOUND`，再当 0 处理，密钥就变成全 0 字节（AES 加出来 JVM 解不开，
     * 报 BadPaddingException，看着像源给了错密钥）。字符串下标只做兜底。
     */
    private fun elementOf(value: Scriptable, index: Int): Any? {
        val byIndex = runCatching { ScriptableObject.getProperty(value, index) }.getOrNull()
        if (byIndex != null && byIndex !== Scriptable.NOT_FOUND && byIndex !== Context.getUndefinedValue()) {
            return byIndex
        }
        return runCatching { ScriptableObject.getProperty(value, index.toString()) }.getOrNull()
    }

    private fun bytesOf(value: Any?, charset: Charset = Charsets.UTF_8): ByteArray {
        if (value == null || value === Context.getUndefinedValue()) return ByteArray(0)
        if (value is ByteArray) return value
        if (value is CharSequence) return value.toString().toByteArray(charset)
        if (value is Number) return byteArrayOf(value.toByte().toByte())
        if (value is Scriptable) {
            val length = runCatching { (ScriptableObject.getProperty(value, "length") as? Number)?.toInt() }.getOrNull() ?: 0
            if (length <= 0) return ByteArray(0)
            // 上限：`length` 是**脚本可控**的，而它直接决定宿主侧 `ByteArray` 的分配量。
            // 不设限时 `Packages.java.util.Arrays.equals({length: 2147483000}, [])` 这类三五个
            // Rhino 指令的调用就能申请约 2GB，抛 `OutOfMemoryError`（`Error`，`runCatching` 兜不住）
            // 把整条工作线程打掉；而且下面的 for 循环也是**宿主**循环，2e9 次 `getProperty`
            // 一条 Rhino 指令都不产生，`JsGuard` 的墙钟守卫全程零回调。
            // 抛 `IllegalArgumentException`（不是 Error），让脚本层能兜住并降级。
            requireAllowedLength(length, "字节数组长度")
            return ByteArray(length) { index ->
                ((elementOf(value, index) as? Number)?.toInt() ?: 0).toByte()
            }
        }
        if (value is Iterable<*>) return value.map { ((it as? Number)?.toInt() ?: 0).toByte() }.toByteArray()
        return value.toString().toByteArray(charset)
    }

    private fun bytesOfOrNull(value: Any?): ByteArray? = when {
        value == null || value === Context.getUndefinedValue() -> null
        value is ByteArray -> value
        value is CharSequence -> value.toString().toByteArray(Charsets.UTF_8)
        value is Scriptable -> bytesOf(value)
        else -> null
    }

    /**
     * 把宿主字节数组包成 JS 数组。
     *
     * **每个字节都会装箱成一个 `Integer` 再塞进 JS 数组**，内存放大约 10~20 倍
     *（一个 `Integer` 16 字节 + 数组槽引用 4 字节，而原始字节只占 1 字节）。
     * 所以 16MB 的字节数组到这里会变成数百 MB —— 只限制「字节数」是不够的，
     * 必须在这里再判一次元素数，否则 `GzipLimits.MAX_UNZIP_BYTES` 这个上限
     * 在自己的输出端就被放大了，等于白设。
     */
    private fun bytesArray(bytes: ByteArray): Any {
        requireAllowedLength(bytes.size, "JS 字节数组元素数")
        return cx.newArray(top, ScriptCrypto.unsigned(bytes).map { it as Any }.toTypedArray())
    }

    /**
     * 读脚本对象的 `length`。
     *
     * 这个值是**脚本可控**的，而它会被 `Arrays.fill` / `System.arraycopy` 直接当成
     * **宿主 for 循环**的边界用。宿主循环不产生 Rhino 指令，`observeInstructionCount`
     * 一次都不会被回调 —— `{length: 2000000000}` 这一个普通对象就能让程序在 Kotlin 里
     * 空转几十亿次直到 OOM，而 30 秒的墙钟守卫全程看不见。
     */
    private fun arrayLength(value: Scriptable): Int =
        runCatching { (ScriptableObject.getProperty(value, "length") as? Number)?.toInt() ?: 0 }
            .getOrDefault(0)
            .also { requireAllowedLength(it, "数组长度") }

    /**
     * 校验一个「由脚本给出的长度/元素数」没有超过宿主侧安全线。
     *
     * 抛 `IllegalArgumentException` 而不是 `Error`：调用方与脚本层的 `runCatching`
     * 能把它兜成空结果，而不是整条线程被 `OutOfMemoryError` 打掉。
     */
    private fun requireAllowedLength(length: Int, what: String) {
        if (length > MAX_HOST_ALLOC_BYTES) {
            throw IllegalArgumentException(
                "$what ${length} 超过 ${MAX_HOST_ALLOC_BYTES / (1024 * 1024)}M 上限，已拒绝（疑似脚本放大攻击）",
            )
        }
        // 单次没超，但**累计**可能超：一次 8MB 完全合法，脚本保留结果再循环几十次就是数百 MB。
        // 记账点放这里而不是每个桥入口，见 `BoundedJs.chargeHostBytes` 的注释。
        BoundedJs.chargeHostBytes(length.toLong())
    }

    /** `StringBuilder` 的增长路径（`append`/`insert`）共用 `setLength` 的那个上限。 */
    private fun requireStringBuilderWithinLimit(before: Int, after: Int) {
        if (after > MAX_STRING_BUILDER_LENGTH) {
            throw IllegalArgumentException(
                "StringBuilder 长度 $after 超过 $MAX_STRING_BUILDER_LENGTH 上限，已拒绝（疑似脚本放大攻击）",
            )
        }
        // 只记**增量**：append 循环里 `sb.length` 是累计值，按累计值记账会把一次 1MB 的
        // 正常拼接记成 N×1MB，误伤真实源。
        if (after > before) BoundedJs.chargeHostBytes((after - before).toLong())
    }

    /**
     * 记住一个密钥/IV 盒子对应的材料，并**限制条目数**。
     *
     * 这张表是 `IdentityHashMap`，键是给脚本用的 JS 盒子对象。JS 侧丢弃盒子之后，
     * 这张表的**强引用**仍然把盒子和密钥字节永久钉住 —— 脚本只要在循环里
     * `new SecretKeySpec(...)` 二十万次，就能让单次执行内的内存无界增长到 OOM，
     * 而每次创建只消耗几条 Rhino 指令，墙钟守卫看不见。
     *
     * 用条目上限而不是 `WeakHashMap`：`WeakHashMap` 的回收时机由 GC 决定，
     * 判据无法稳定断言；而密钥材料的真实使用场景（几套 AES key/iv）远少于 1024。
     */
    private fun rememberKeyMaterial(box: Any, material: KeyMaterial) {
        if (keyMaterial.size >= MAX_KEY_MATERIAL_ENTRIES && !keyMaterial.containsKey(box)) {
            throw IllegalArgumentException(
                "一次执行内创建的密钥/IV 超过 ${MAX_KEY_MATERIAL_ENTRIES} 个上限，已拒绝（疑似脚本放大攻击）",
            )
        }
        keyMaterial[box] = material
    }

    private fun nativeString(text: String): Scriptable =
        runCatching { nativeStringCtor?.construct(cx, top, arrayOf<Any?>(text)) as? Scriptable }.getOrNull()
            ?: obj("toString" to fn { text })

    private fun javaString(args: Array<out Any?>): Scriptable {
        val raw = args.firstOrNull()
        val text = if (isByteLike(raw)) String(bytesOf(raw), charsetOf(args.getOrNull(1))) else textOf(raw)
        val box = nativeString(text)
        ScriptableObject.putProperty(box, "getBytes", fn { a -> bytesArray(text.toByteArray(charsetOf(a.getOrNull(0)))) })
        ScriptableObject.putProperty(box, "equals", fn { a -> text == textOf(a.firstOrNull()) })
        ScriptableObject.putProperty(box, "isEmpty", fn { text.isEmpty() })
        ScriptableObject.putProperty(box, "toCharArray", fn { cx.newArray(top, text.map { it.toString() as Any }.toTypedArray()) })
        return box
    }

    private fun formatText(args: Array<out Any?>): String {
        val pattern = textOf(args.firstOrNull())
        val values = args.drop(1)
        var index = 0
        return Regex("%(\\d+\\$)?([sdfxXb])").replace(pattern) { match ->
            val positional = match.groupValues[1].removeSuffix("$").toIntOrNull()
            val value = values.getOrNull(if (positional != null) positional - 1 else index++)
            when (match.groupValues[2]) {
                "d" -> (value as? Number)?.toLong()?.toString() ?: textOf(value)
                "f" -> (value as? Number)?.toDouble()?.toString() ?: textOf(value)
                "x" -> (value as? Number)?.toLong()?.toString(16) ?: textOf(value)
                "X" -> (value as? Number)?.toLong()?.toString(16)?.uppercase() ?: textOf(value)
                "b" -> (value as? Boolean)?.toString() ?: textOf(value)
                else -> textOf(value)
            }
        }
    }

    private fun arraycopy(args: Array<out Any?>) {
        val source = args.getOrNull(0) ?: return
        val sourcePos = (args.getOrNull(1) as? Number)?.toInt() ?: 0
        val target = args.getOrNull(2) as? Scriptable ?: return
        val targetPos = (args.getOrNull(3) as? Number)?.toInt() ?: 0
        val length = (args.getOrNull(4) as? Number)?.toInt() ?: 0
        if (length <= 0) return
        // 上限：这个 length 由脚本直接给，而下面两个分支都是**宿主 for 循环**。
        // 不设限时 `System.arraycopy([1], 0, {}, 0, 2000000000)` 会让程序在 Kotlin 里空转
        // 20 亿次（每轮还造一个 key 字符串写进目标对象），全程零 Rhino 指令，
        // 墙钟守卫一次回调都没有 —— 先挂死，再 OOM。
        requireAllowedLength(length, "arraycopy 长度")
        if (source is ByteArray) {
            for (i in 0 until length) {
                val value = source.getOrNull(sourcePos + i)?.toInt()?.and(0xFF) ?: 0
                ScriptableObject.putProperty(target, (targetPos + i).toString(), value)
            }
        } else if (source is Scriptable) {
            for (i in 0 until length) {
                val value = elementOf(source, sourcePos + i)
                ScriptableObject.putProperty(target, (targetPos + i).toString(), value)
            }
        }
    }

    // ── 具体替身对象 ────────────────────────────────────────────

    private class KeyMaterial(
        val secret: ByteArray? = null,
        val algorithm: String? = null,
        val iv: ByteArray? = null,
        val gcmTag: Int? = null,
        val key: java.security.Key? = null,
    )

    private fun specBox(bytes: ByteArray, algorithm: String): NativeObject {
        val box = obj(
            "algorithm" to algorithm,
            "getFormat" to fn { "RAW" },
            "getAlgorithm" to fn { algorithm },
            "getEncoded" to fn { bytesArray(bytes) },
        )
        rememberKeyMaterial(box, KeyMaterial(secret = bytes, algorithm = algorithm))
        return box
    }

    private fun ivBox(bytes: ByteArray): NativeObject {
        val box = obj("getIV" to fn { bytesArray(bytes) })
        rememberKeyMaterial(box, KeyMaterial(iv = bytes))
        return box
    }

    private fun gcmBox(tag: Int, bytes: ByteArray): NativeObject {
        val box = obj("getIV" to fn { bytesArray(bytes) }, "getTLen" to tag)
        rememberKeyMaterial(box, KeyMaterial(iv = bytes, gcmTag = tag))
        return box
    }

    private fun keyBox(key: java.security.Key?, bytes: ByteArray?, algorithm: String?): NativeObject {
        val name = key?.algorithm ?: algorithm ?: ""
        val box = obj(
            "algorithm" to name,
            "getAlgorithm" to fn { name },
            "getEncoded" to fn { bytesArray(bytes ?: ByteArray(0)) },
            "toString" to fn { "$name key" },
        )
        if (key != null) rememberKeyMaterial(box, KeyMaterial(key = key, secret = bytes, algorithm = name))
        return box
    }

    private fun uuidBox(value: String): NativeObject = obj(
        "toString" to fn { value },
        "equals" to fn { a -> value == textOf(a.firstOrNull()) },
    )

    private fun base64Encoder(urlSafe: Boolean): NativeObject {
        val encoder = if (urlSafe) Base64.getUrlEncoder() else Base64.getEncoder()
        return obj(
            "encodeToString" to fn { a -> encoder.encodeToString(bytesOf(a.firstOrNull())) },
            "encode" to fn { a -> bytesArray(encoder.encode(bytesOf(a.firstOrNull()))) },
            "withoutPadding" to fn { _ ->
                base64EncoderNoPadding(urlSafe)
            },
        )
    }

    private fun base64EncoderNoPadding(urlSafe: Boolean): NativeObject {
        val encoder = (if (urlSafe) Base64.getUrlEncoder() else Base64.getEncoder()).withoutPadding()
        return obj(
            "encodeToString" to fn { a -> encoder.encodeToString(bytesOf(a.firstOrNull())) },
            "encode" to fn { a -> bytesArray(encoder.encode(bytesOf(a.firstOrNull()))) },
        )
    }

    private fun base64Decoder(urlSafe: Boolean, mime: Boolean): NativeObject = obj(
        "decode" to fn { a ->
            val raw = a.firstOrNull()
            val text = if (raw is CharSequence) raw.toString() else textOf(raw)
            bytesArray(decodeBase64Text(text, urlSafe = urlSafe, mime = mime))
        },
    )

    private fun decodeBase64Text(text: String, urlSafe: Boolean, mime: Boolean = false): ByteArray {
        // 输入上限。三套口径（java.util / android.util / hutool）的解码都收口到这里，
        // 所以只在这一处判就够。不设限时 `Base64.decode('A'.repeat(100000000), 0)`
        // 会先整串复制一遍（1 亿字符 ≈ 200MB），再解码出 7500 万字节，
        // 全程宿主侧分配，`JsGuard` 的指令观察器零回调。
        requireAllowedLength(text.length, "Base64 输入长度")
        // 只有确实含空白时才复制。原写法无条件 `filterNot`，对没有空白的输入
        // （绝大多数）纯属白复制一整串 —— 在百万级字符串上这是实打实的宿主开销。
        val clean = if (text.any { it.isWhitespace() }) text.filterNot { it.isWhitespace() } else text
        val decoder = when {
            mime -> Base64.getMimeDecoder()
            urlSafe -> Base64.getUrlDecoder()
            else -> Base64.getDecoder()
        }
        return runCatching { decoder.decode(clean) }
            .recoverCatching { Base64.getUrlDecoder().decode(clean) }
            .recoverCatching { Base64.getMimeDecoder().decode(clean) }
            .getOrDefault(ByteArray(0))
    }

    private fun digestHex(text: String, algorithm: String): String =
        MessageDigest.getInstance(algorithm).digest(text.toByteArray(Charsets.UTF_8))
            // 用查表的 `bytesToHex` 而不是 `"%02x".format(it)`：后者每字节一次 `String.format`
            //（格式化器创建 + 解析 + 拼接），2MB 正文就是 200 万次，纯宿主 CPU，
            // 小幅但真实地放大了一次调用的耗时，且墙钟守卫看不见。
            .let { ScriptCrypto.bytesToHex(it) }

    private fun digestBox(algorithm: String): NativeObject {
        val digest = MessageDigest.getInstance(algorithm)
        return obj(
            "update" to fn { a -> digest.update(bytesOf(a.firstOrNull())); Context.getUndefinedValue() },
            "digest" to fn { a ->
                if (a.isNotEmpty()) digest.update(bytesOf(a.firstOrNull()))
                bytesArray(digest.digest())
            },
            "reset" to fn { digest.reset(); Context.getUndefinedValue() },
            "getAlgorithm" to fn { algorithm },
        )
    }

    private fun macBox(algorithm: String): NativeObject {
        val mac = Mac.getInstance(algorithm)
        return obj(
            "init" to fn { a ->
                mac.init(secretKeyOf(a.firstOrNull(), algorithm))
                Context.getUndefinedValue()
            },
            "update" to fn { a -> mac.update(bytesOf(a.firstOrNull())); Context.getUndefinedValue() },
            "doFinal" to fn { a ->
                if (a.isNotEmpty()) mac.update(bytesOf(a.firstOrNull()))
                bytesArray(mac.doFinal())
            },
            "getMacLength" to fn { mac.macLength },
        )
    }

    private fun secureRandomBox(): NativeObject {
        val random = SecureRandom()
        return obj(
            "nextInt" to fn { a ->
                val bound = (a.firstOrNull() as? Number)?.toInt()
                if (bound != null && bound > 0) random.nextInt(bound) else random.nextInt()
            },
            "nextLong" to fn { random.nextLong() },
            "nextBytes" to fn { a ->
                val length = (a.firstOrNull() as? Number)?.toInt() ?: 0
                // 上限：长度由脚本给，`nextBytes(2147483000)` 是一次 2GB 宿主分配。
                requireAllowedLength(length, "nextBytes 长度")
                bytesArray(ByteArray(length.coerceAtLeast(0)).also { random.nextBytes(it) })
            },
        )
    }

    private fun cipherBox(transformation: String): NativeObject {
        val cipher = Cipher.getInstance(transformation)
        return obj(
            "init" to fn { a ->
                val mode = when (val raw = a.getOrNull(0)) {
                    is Number -> raw.toInt()
                    null -> 1
                    else -> raw.toString().toIntOrNull() ?: 1
                }
                val javaMode = if (mode == 2) Cipher.DECRYPT_MODE else Cipher.ENCRYPT_MODE
                val key = secretKeyOf(a.getOrNull(1), transformation)
                val iv = ivSpecOf(a.getOrNull(2), transformation)
                if (iv != null) cipher.init(javaMode, key, iv) else cipher.init(javaMode, key)
                Context.getUndefinedValue()
            },
            "doFinal" to fn { a -> bytesArray(cipher.doFinal(bytesOf(a.firstOrNull()))) },
            "update" to fn { a -> bytesArray(cipher.update(bytesOf(a.firstOrNull()))) },
            "getBlockSize" to fn { cipher.blockSize },
            "getIV" to fn { bytesArray(cipher.iv ?: ByteArray(0)) },
            "getAlgorithm" to fn { transformation },
        )
    }

    private fun secretKeyOf(value: Any?, algorithmHint: String): SecretKey {
        val material = keyMaterial[value]
        (material?.key as? SecretKey)?.let { return it }
        val algorithm = material?.algorithm?.takeIf { it.isNotBlank() } ?: algorithmHint.substringBefore('/')
        val bytes = material?.secret ?: bytesOf(value)
        return SecretKeySpec(bytes, algorithm)
    }

    private fun ivSpecOf(value: Any?, transformation: String): AlgorithmParameterSpec? {
        if (value == null || value === Context.getUndefinedValue()) return null
        val material = keyMaterial[value]
        val bytes = material?.iv ?: bytesOf(value)
        if (bytes.isEmpty()) return null
        return if (transformation.contains("GCM", ignoreCase = true)) {
            GCMParameterSpec(material?.gcmTag ?: 128, bytes)
        } else {
            IvParameterSpec(bytes)
        }
    }

    private fun signatureBox(algorithm: String): NativeObject {
        val signature = Signature.getInstance(algorithm)
        fun keyOf(value: Any?, privateKey: Boolean): java.security.Key? {
            keyMaterial[value]?.key?.let { return it }
            val bytes = bytesOf(value)
            val factory = runCatching { KeyFactory.getInstance("RSA") }.getOrNull() ?: return null
            return runCatching {
                if (privateKey) factory.generatePrivate(PKCS8EncodedKeySpec(bytes))
                else factory.generatePublic(X509EncodedKeySpec(bytes))
            }.getOrNull()
        }
        return obj(
            "initSign" to fn { a ->
                val key = keyOf(a.firstOrNull(), true) ?: throw IllegalArgumentException("initSign 需要私钥")
                signature.initSign(key as java.security.PrivateKey)
                Context.getUndefinedValue()
            },
            "initVerify" to fn { a ->
                val key = keyOf(a.firstOrNull(), false) ?: throw IllegalArgumentException("initVerify 需要公钥")
                signature.initVerify(key as java.security.PublicKey)
                Context.getUndefinedValue()
            },
            "update" to fn { a -> signature.update(bytesOf(a.firstOrNull())); Context.getUndefinedValue() },
            "sign" to fn { bytesArray(signature.sign()) },
            "verify" to fn { a -> signature.verify(bytesOf(a.firstOrNull())) },
            "getAlgorithm" to fn { algorithm },
        )
    }

    private fun jsList(): Scriptable {
        val array = cx.newArray(top, emptyArray<Any>())
        fun push(value: Any?) {
            val length = arrayLength(array)
            ScriptableObject.putProperty(array, length.toString(), value)
        }
        ScriptableObject.putProperty(array, "add", fn { a ->
            push(a.firstOrNull())
            true
        })
        // 元素一律按 int 下标读（同 `elementOf` 的理由：Rhino 1.8 稠密数字数组用字符串下标读不到），
        // 写入仍按字符串下标，两种存储都能落位。
        ScriptableObject.putProperty(array, "get", fn { a ->
            elementOf(array, (a.firstOrNull() as? Number)?.toInt() ?: 0)
        })
        ScriptableObject.putProperty(array, "size", fn { arrayLength(array) })
        ScriptableObject.putProperty(array, "isEmpty", fn { arrayLength(array) == 0 })
        ScriptableObject.putProperty(array, "toString", fn {
            (0 until arrayLength(array)).joinToString(", ") { textOf(elementOf(array, it)) }
        })
        ScriptableObject.putProperty(array, "remove", fn { a ->
            val index = (a.firstOrNull() as? Number)?.toInt() ?: -1
            val length = arrayLength(array)
            if (index !in 0 until length) return@fn null
            val removed = elementOf(array, index)
            for (i in index until length - 1) {
                ScriptableObject.putProperty(array, i.toString(), elementOf(array, i + 1))
            }
            ScriptableObject.deleteProperty(array, (length - 1).toString())
            ScriptableObject.putProperty(array, "length", length - 1)
            removed
        })
        return array
    }

    // ── okhttp3 ─────────────────────────────────────────────────

    private data class RequestData(
        var url: String = "",
        var method: String = "GET",
        var headers: MutableMap<String, String> = linkedMapOf(),
        var body: String? = null,
    )

    private fun requestBuilderBox(): NativeObject {
        val request = RequestData()
        val box = obj()
        fun method(name: String, block: (Array<out Any?>) -> Any?) {
            ScriptableObject.putProperty(box, name, fn { args -> block(args); box })
        }
        method("url") { args -> request.url = args.firstOrNull()?.toString() ?: "" }
        method("get") { _ -> request.method = "GET" }
        method("post") { args -> request.method = "POST"; request.body = bodyOf(args.firstOrNull()) }
        method("put") { args -> request.method = "PUT"; request.body = bodyOf(args.firstOrNull()) }
        method("delete") { args -> request.method = "DELETE"; request.body = bodyOf(args.firstOrNull()) }
        method("head") { _ -> request.method = "HEAD" }
        method("addHeader") { args ->
            val name = args.getOrNull(0)?.toString()
            if (name != null) request.headers[name] = args.getOrNull(1)?.toString() ?: ""
        }
        method("header") { args ->
            val name = args.getOrNull(0)?.toString()
            if (name != null) request.headers[name] = args.getOrNull(1)?.toString() ?: ""
        }
        method("removeHeader") { args -> request.headers.remove(args.firstOrNull()?.toString() ?: "") }
        method("headers") { args ->
            val headers = args.firstOrNull()
            if (headers is NativeObject) {
                headers.ids.forEach { id ->
                    val key = id?.toString() ?: return@forEach
                    request.headers[key] = textOf(ScriptableObject.getProperty(headers, key))
                }
            }
        }
        ScriptableObject.putProperty(box, "build", fn { _ ->
            // 这里**不放** `RequestData` 实例。曾经是 `"_request" to request.copy(...)`，
            // 于是沙箱里出现了一个真实 Java 对象：当下不可利用（Rhino 把它包成 NativeJavaObject、
            // 成员访问被 `ClassShutter { false }` 拦下），但它打破了「沙箱里不出现 Java 引用」
            // 这条不变量 —— 安全性就全押在 shutter 一个开关上。改成挂四个原生值，
            // `newCall` 侧按同一套字段还原，语义等价而引用消失。
            obj(
                "url" to fn { request.url },
                "_url" to request.url,
                "_method" to request.method,
                "_body" to (request.body ?: Context.getUndefinedValue()),
                "_headers" to obj(*request.headers.map { (key, value) -> key to value }.toTypedArray()),
            )
        })
        return box
    }

    private fun bodyOf(value: Any?): String? {
        if (value == null || value === Context.getUndefinedValue()) return null
        if (value is NativeObject) {
            val body = ScriptableObject.getProperty(value, "_body")
            if (body !== Scriptable.NOT_FOUND && body !== Context.getUndefinedValue()) return textOf(body)
        }
        return textOf(value)
    }

    private fun requestBodyBox(args: Array<out Any?>): NativeObject {
        val body = args.firstOrNull()
        return obj(
            "_body" to textOf(body),
            "toString" to fn { textOf(body) },
        )
    }

    private fun okHttpClientBox(): NativeObject = obj(
        "newCall" to fn { args ->
            val request = args.firstOrNull() as? NativeObject
            val data = requestDataOf(request)
            obj(
                "execute" to fn { _ -> okHttpResponse(executeRequest(data)) },
                "isExecuted" to fn { false },
                "cancel" to fn { Context.getUndefinedValue() },
            )
        },
    )

    /**
     * 从 `build()` 产出的对象上还原请求参数。字段是**原生值**，不是 `RequestData` 实例 ——
     * 沙箱里不出现 Java 引用，见 `requestBuilderBox` 里 `build` 的注释。
     */
    private fun requestDataOf(box: NativeObject?): RequestData {
        if (box == null) return RequestData()
        val headers = linkedMapOf<String, String>()
        val table = ScriptableObject.getProperty(box, "_headers") as? NativeObject
        table?.ids?.forEach { id ->
            val key = id?.toString() ?: return@forEach
            headers[key] = textOf(ScriptableObject.getProperty(table, key))
        }
        val body = ScriptableObject.getProperty(box, "_body")
        return RequestData(
            url = textOr(box, "_url", ""),
            method = textOr(box, "_method", "GET"),
            headers = headers,
            body = if (body === Scriptable.NOT_FOUND || body === Context.getUndefinedValue()) null else textOf(body),
        )
    }

    private fun textOr(box: NativeObject, key: String, fallback: String): String {
        val value = ScriptableObject.getProperty(box, key)
        if (value === Scriptable.NOT_FOUND || value === Context.getUndefinedValue()) return fallback
        return textOf(value).takeIf { it.isNotEmpty() } ?: fallback
    }

    private fun executeRequest(data: RequestData): RuleRunner.Fetched {
        if (data.url.isBlank()) return RuleRunner.Fetched("", "", 0, emptyMap())
        return runCatching {
            runner?.fetchResponse(
                url = data.url,
                method = data.method,
                headers = data.headers,
                body = data.body,
                sourceId = execContext?.sourceId,
                database = execContext?.database,
                // 把这次 JS 执行的墙钟截止时刻带下去：`execute()` 是**宿主阻塞**，
                // 阻塞期间指令观察器零回调，30 秒的 JS 上限对它无效；而它内部最坏
                // 4 跳 × 20s + 重试 ≈ 100 秒。带上截止时刻后每一跳都被压进预算。
                deadlineMs = BoundedJs.deadlineOrNull(),
            )
        }.getOrElse { error ->
            RuleRunner.Fetched(data.url, fetchFailureText(error), 0, emptyMap())
        } ?: RuleRunner.Fetched(data.url, "", 0, emptyMap())
    }

    private fun okHttpResponse(fetched: RuleRunner.Fetched): NativeObject = obj(
        "code" to fn { fetched.status },
        "message" to fn { if (fetched.status in 200..299) "OK" else "" },
        "isSuccessful" to fn { fetched.status in 200..299 },
        "header" to fn { a ->
            val name = a.firstOrNull()?.toString()?.lowercase() ?: ""
            fetched.headers[name] ?: ""
        },
        "headers" to fn { _ ->
            obj().also { table ->
                fetched.headers.forEach { (name, value) -> ScriptableObject.putProperty(table, name, value) }
            }
        },
        "body" to fn { _ -> okHttpBody(fetched.body) },
        "bodyAsBytes" to fn { _ -> bytesArray(fetched.body.toByteArray(Charsets.UTF_8)) },
        "toString" to fn { fetched.body },
        "close" to fn { Context.getUndefinedValue() },
    )

    private fun okHttpBody(body: String): NativeObject = obj(
        "string" to fn { body },
        "bytes" to fn { bytesArray(body.toByteArray(Charsets.UTF_8)) },
        "contentType" to fn { obj("toString" to fn { "application/json" }) },
        "length" to fn { body.toByteArray(Charsets.UTF_8).size.toLong() },
        "toString" to fn { body },
        "close" to fn { Context.getUndefinedValue() },
    )

    private fun httpUrlBox(raw: String): NativeObject {
        val text = raw.trim()
        return obj(
            "toString" to fn { text },
            "host" to runCatching { java.net.URI(text).host ?: "" }.getOrDefault(""),
            "path" to runCatching { java.net.URI(text).path ?: "" }.getOrDefault(""),
            "newBuilder" to fn { _ ->
                val builder = obj()
                var current = text
                ScriptableObject.putProperty(builder, "addQueryParameter", fn { a ->
                    val key = textOf(a.getOrNull(0))
                    val value = textOf(a.getOrNull(1))
                    current = appendQuery(current, key, value)
                    builder
                })
                ScriptableObject.putProperty(builder, "setQueryParameter", fn { a ->
                    val key = textOf(a.getOrNull(0))
                    val value = textOf(a.getOrNull(1))
                    current = appendQuery(stripQueryParam(current, key), key, value)
                    builder
                })
                ScriptableObject.putProperty(builder, "build", fn { _ -> httpUrlBox(current) })
                ScriptableObject.putProperty(builder, "toString", fn { current })
                builder
            },
        )
    }

    private fun appendQuery(url: String, key: String, value: String): String {
        val encodedKey = runCatching { URLEncoder.encode(key, "UTF-8") }.getOrDefault(key)
        val encodedValue = runCatching { URLEncoder.encode(value, "UTF-8") }.getOrDefault(value)
        val separator = if (url.contains('?')) "&" else "?"
        return "$url$separator$encodedKey=$encodedValue"
    }

    private fun stripQueryParam(url: String, key: String): String {
        val question = url.indexOf('?')
        if (question < 0) return url
        val base = url.substring(0, question)
        val query = url.substring(question + 1).split('&').filterNot {
            it.substringBefore('=') == key
        }
        return if (query.isEmpty()) base else "$base?${query.joinToString("&")}"
    }

    companion object {
        private const val ANDROID_URL_SAFE = 8

        /**
         * 宿主侧资源硬上限。
         *
         * 这三条拦的是**不消耗 Rhino 指令**的逃逸 —— `JsGuard.observeInstructionCount`
         * 永远等不到回调，墙钟守卫对它们完全失效：
         * - `Thread.sleep` 是宿主阻塞；
         * - `setLength` 是宿主内存分配；
         * - GZIP 解压是宿主内存分配（且可被"压缩炸弹"放大几十万倍）。
         *
         * 判据见 `JsSandboxResourceLimitTest`。
         */
        /** 单次 `Thread.sleep` 的上限（毫秒）。书源脚本没有睡更久的正当理由。 */
        private const val MAX_SLEEP_MS = 1_000L
        /** `StringBuilder.setLength` 的上限（字符数，约 2MB 内存），防止脚本直接触发大额分配。 */
        private const val MAX_STRING_BUILDER_LENGTH = 1_000_000

        /**
         * 宿主侧「脚本给出的长度/元素数」的统一上限。
         *
         * 这一类逃逸的共同点是：**长度值由脚本给，开销发生在宿主**，所以 `JsGuard` 的
         * 指令观察器一次都不会被回调。敞开的写法经实测包括：
         * - `Packages.java.util.Arrays.equals({length: 2147483000}, [])` → 申请 ~2GB `ByteArray`
         * - `Packages.java.util.Arrays.fill({length: 2000000000}, 65)` → 宿主空转 20 亿次再 OOM
         * - `Packages.java.lang.System.arraycopy([1], 0, {}, 0, 2000000000)` → 同上
         * - `Packages.java.security.SecureRandom().nextBytes(2147483000)` → 大额分配
         *
         * 8M 对任何真实的书源规则都绰绰有余（真实页面正文通常几十 KB ~ 几 MB）。
         */
        private const val MAX_HOST_ALLOC_BYTES = 8 * 1024 * 1024

        /**
         * 一次执行内最多记住多少个密钥/IV 盒子。
         *
         * 表是 `IdentityHashMap`，JS 侧丢弃盒子后强引用仍在 —— 无上限就等于让脚本
         * 用几次 Rhino 指令换宿主侧无界内存增长。真实书源同一轮里用到的密钥材料
         * （几套 AES key/iv）远少于这个数。
         */
        private const val MAX_KEY_MATERIAL_ENTRIES = 1024

        private val OBJECT_MEMBERS = setOf(
            "toString", "valueOf", "hasOwnProperty", "constructor", "__proto__", "toJSON", "isPrototypeOf",
        )

        private val JS_BUILTINS = setOf(
            "String", "Number", "Boolean", "Object", "Array", "Date", "RegExp", "Math", "JSON", "Error",
        )

        private val CLASS_NAMES = setOf(
            "java.lang.Thread", "java.lang.System", "java.lang.String", "java.lang.StringBuilder",
            "java.lang.StringBuffer", "java.lang.Integer", "java.lang.Long", "java.lang.Double",
            "java.lang.Float", "java.lang.Boolean",
            "java.util.UUID", "java.util.Base64", "java.util.Arrays", "java.util.HashMap",
            "java.util.LinkedHashMap", "java.util.ArrayList",
            "java.net.URLEncoder", "java.net.URLDecoder",
            "java.security.MessageDigest", "java.security.SecureRandom", "java.security.KeyFactory",
            "java.security.Signature",
            "java.security.spec.PKCS8EncodedKeySpec", "java.security.spec.X509EncodedKeySpec",
            "javax.crypto.Cipher", "javax.crypto.Mac", "javax.crypto.SecretKeyFactory",
            "javax.crypto.spec.SecretKeySpec", "javax.crypto.spec.DESKeySpec",
            "javax.crypto.spec.IvParameterSpec", "javax.crypto.spec.GCMParameterSpec",
            "android.util.Base64", "android.text.TextUtils", "android.os.Build",
            "cn.hutool.core.codec.Base64", "cn.hutool.core.util.StrUtil", "cn.hutool.core.util.ZipUtil",
            "cn.hutool.crypto.digest.DigestUtil",
            "okhttp3.OkHttpClient", "okhttp3.Request", "okhttp3.RequestBody", "okhttp3.MediaType",
            "okhttp3.HttpUrl",
        )

        private val PACKAGE_CLASSES: Map<String, List<String>> =
            CLASS_NAMES.groupBy({ it.substringBeforeLast('.') }, { it.substringAfterLast('.') })

        private val NAMESPACES: Set<String> = buildSet {
            PACKAGE_CLASSES.keys.forEach { pkg ->
                val parts = pkg.split('.')
                for (i in 1..parts.size) add(parts.take(i).joinToString("."))
            }
        }
    }
}

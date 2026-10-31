package io.legado.rules

import kotlinx.serialization.json.Json
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.Context
import org.mozilla.javascript.Function
import org.mozilla.javascript.NativeJSON
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import java.io.ByteArrayOutputStream
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
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
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
                runCatching { Thread.sleep(millis.coerceAtLeast(0)) }
                Context.getUndefinedValue()
            },
            "currentThread" to { _ ->
                obj(
                    "getName" to fn { "main" },
                    "sleep" to fn { args ->
                        runCatching { Thread.sleep((args.firstOrNull() as? Number)?.toLong() ?: 0L) }
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
            "getenv" to { args -> System.getenv(args.firstOrNull()?.toString() ?: "") ?: "" },
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
                if (value is Number) sb.append(value.toInt()) else if (value is Boolean) sb.append(value) else sb.append(textOf(value))
                box
            }
            method("toString") { sb.toString() }
            method("length") { sb.length }
            method("reverse") { sb.reverse(); box }
            method("insert") { a ->
                val index = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                sb.insert(index.coerceIn(0, sb.length), textOf(a.getOrNull(1)))
                box
            }
            method("deleteCharAt") { a ->
                val index = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                if (index in sb.indices) sb.deleteCharAt(index)
                box
            }
            method("setLength") { a ->
                val length = (a.getOrNull(0) as? Number)?.toInt() ?: 0
                sb.setLength(length.coerceAtLeast(0))
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
            "format" to { a ->
                var text = textOf(a.firstOrNull())
                a.drop(1).forEach { arg -> text = text.replaceFirst("{}", textOf(arg)) }
                text
            },
            "contains" to { a -> textOf(a.getOrNull(0)).contains(textOf(a.getOrNull(1))) },
            "toString" to { a -> textOf(a.firstOrNull()) },
        ))
        "cn.hutool.core.util.ZipUtil" -> jsClass(full, statics = mapOf(
            "gzip" to { a -> bytesArray(gzip(bytesOf(a.firstOrNull()))) },
            "unGzip" to { a -> bytesArray(runCatching { GZIPInputStream(bytesOf(a.firstOrNull()).inputStream()).use { it.readBytes() } }.getOrDefault(ByteArray(0))) },
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

    private fun bytesArray(bytes: ByteArray): Any =
        cx.newArray(top, ScriptCrypto.unsigned(bytes).map { it as Any }.toTypedArray())

    private fun arrayLength(value: Scriptable): Int =
        (ScriptableObject.getProperty(value, "length") as? Number)?.toInt() ?: 0

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
        keyMaterial[box] = KeyMaterial(secret = bytes, algorithm = algorithm)
        return box
    }

    private fun ivBox(bytes: ByteArray): NativeObject {
        val box = obj("getIV" to fn { bytesArray(bytes) })
        keyMaterial[box] = KeyMaterial(iv = bytes)
        return box
    }

    private fun gcmBox(tag: Int, bytes: ByteArray): NativeObject {
        val box = obj("getIV" to fn { bytesArray(bytes) }, "getTLen" to tag)
        keyMaterial[box] = KeyMaterial(iv = bytes, gcmTag = tag)
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
        if (key != null) keyMaterial[box] = KeyMaterial(key = key, secret = bytes, algorithm = name)
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
        val clean = text.filterNot { it.isWhitespace() }
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
            .joinToString("") { "%02x".format(it) }

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

    private fun gzip(bytes: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        GZIPOutputStream(output).use { it.write(bytes) }
        return output.toByteArray()
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
            obj(
                "url" to fn { request.url },
                "_request" to request.copy(headers = LinkedHashMap(request.headers)),
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
            val data = request?.let { ScriptableObject.getProperty(it, "_request") as? RequestData } ?: RequestData()
            obj(
                "execute" to fn { _ -> okHttpResponse(executeRequest(data)) },
                "isExecuted" to fn { false },
                "cancel" to fn { Context.getUndefinedValue() },
            )
        },
    )

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

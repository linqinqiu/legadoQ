package io.legado.rules

import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.Context
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject

/**
 * 「既是 JS 对象、又像 Java Map」的替身。
 *
 * 上游 `source.getLoginInfoMap()` / `getLoginHeaderMap()` 回的是真的 `HashMap`，
 * Rhino 把它包成 NativeJavaObject，社区源于是写 `.get('token')`、`.containsKey(...)`；
 * 我们原来给的是普通 NativeObject，只有属性没有方法，一调就 TypeError（洋柿子、轻说、城堡
 * 这几份源都卡在这里）。`new Packages.java.util.HashMap()` 也需要同样的形状。
 *
 * 设计要点：
 * - 名字仍然是**自己的属性**（`map.token`、`JSON.stringify(map)`、`for (n in map)` 都照常），
 *   但 `get/put/...` 这些方法**不落成属性** —— 否则序列化、遍历会把函数一起带出去。
 * - 方法只在属性查不到时兜底，所以源自己用了 `get` 当数据键时不会被抢。
 * - `get` 未命中回 `null`（与 Java Map 一致，上游脚本按 `=== null` 判空）。
 */
internal class JsMapObject(
    scope: Scriptable,
    entries: Map<String, Any?> = emptyMap(),
) : NativeObject() {

    private val top: Scriptable = ScriptableObject.getTopLevelScope(scope)

    init {
        parentScope = top
        entries.forEach { (key, value) -> ScriptableObject.putProperty(this, key, value) }
    }

    private fun own(name: String): Any? = super.get(name, this)

    private fun method(fn: (Array<out Any?>) -> Any?): BaseFunction = object : BaseFunction() {
        init {
            parentScope = top
        }

        override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any? =
            fn(args)
    }

    /** 所有键（不含兜底方法）。 */
    fun keys(): List<String> = ids.mapNotNull { it?.toString() }.filter { it.isNotEmpty() }

    fun snapshot(): Map<String, Any?> = keys().associateWith { ScriptableObject.getProperty(this, it) }

    override fun get(name: String, start: Scriptable): Any? {
        val existing = own(name)
        if (existing !== NOT_FOUND) return existing
        return when (name) {
            "get" -> method { args ->
                val key = args.firstOrNull()?.toString() ?: return@method null
                val value = ScriptableObject.getProperty(this, key)
                // Java Map.get 未命中回 null；Rhino 里 null 与 undefined 都判假，但 `=== null` 只认前者。
                if (value == NOT_FOUND) null else value
            }
            "put" -> method { args ->
                val key = args.firstOrNull()?.toString() ?: return@method null
                val previous = ScriptableObject.getProperty(this, key)
                ScriptableObject.putProperty(this, key, args.getOrNull(1))
                if (previous == NOT_FOUND) null else previous
            }
            "putAll" -> method { args ->
                val other = args.firstOrNull()
                when (other) {
                    is NativeObject -> other.ids.forEach { id ->
                        val key = id?.toString() ?: return@forEach
                        ScriptableObject.putProperty(this, key, ScriptableObject.getProperty(other, key))
                    }
                    is Map<*, *> -> other.forEach { (k, v) -> if (k != null) ScriptableObject.putProperty(this, k.toString(), v) }
                }
                Context.getUndefinedValue()
            }
            "containsKey" -> method { args ->
                val key = args.firstOrNull()?.toString() ?: return@method false
                own(key) !== NOT_FOUND
            }
            "containsValue" -> method { args ->
                val wanted = args.firstOrNull()
                keys().any { ScriptableObject.getProperty(this, it) == wanted }
            }
            "keySet" -> method {
                Context.getCurrentContext().newArray(top, keys().map { it as Any }.toTypedArray())
            }
            "values" -> method {
                Context.getCurrentContext().newArray(top, keys().map { ScriptableObject.getProperty(this, it) }.toTypedArray())
            }
            "size" -> method { keys().size }
            "isEmpty" -> method { keys().isEmpty() }
            "remove" -> method { args ->
                val key = args.firstOrNull()?.toString() ?: return@method null
                val previous = ScriptableObject.getProperty(this, key)
                ScriptableObject.deleteProperty(this, key)
                if (previous == NOT_FOUND) null else previous
            }
            "clear" -> method {
                keys().forEach { ScriptableObject.deleteProperty(this, it) }
                Context.getUndefinedValue()
            }
            "toString" -> method { snapshot().entries.joinToString(", ", "{", "}") { (k, v) -> "$k=$v" } }
            else -> NOT_FOUND
        }
    }
}

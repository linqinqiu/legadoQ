package io.legado

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.MessageDigest

/**
 * 把随包的 `static/manifest.webmanifest` 按 [Brand] 改写后再发出去（用户 2026-10-23：
 * 「允许自定义图标和名称」）。
 *
 * 为什么要改写而不是直接发烤死的那份：manifest 是 PWA 的**安装名与图标**的唯一来源，
 * 它是构建期产物、躺在 jar 里，用户改不动。而这条路由本来就带 `no-cache`（见 StaticWeb），
 * 所以运行时改完立刻生效，不需要重打 jar、也不需要用户重装。
 *
 * 没设品牌时**原样返回内置那份文本**（一个字节都不动）—— 免得 JSON 过一遍序列化
 * 把键顺序/格式改了，导致 `PwaCacheRules` / `BrandLogo` 那类按文本比对的判据莫名变红。
 */
object BrandManifest {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private const val RESOURCE = "static/manifest.webmanifest"

    /** 内置 manifest 原文（打进 jar 的那份）。读不到返回 null，调用方照旧走 respondResource。 */
    fun packagedText(): String? = runCatching {
        BrandStore::class.java.classLoader.getResourceAsStream(RESOURCE)
            ?.readBytes()?.toString(Charsets.UTF_8)
    }.getOrNull()

    /** 图标的缓存指纹：取字节 SHA-256 的前 12 位十六进制，写进 URL 查询参数。 */
    fun iconEtag(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }.take(12)

    /**
     * 按品牌改写 manifest。三件事各管各的：
     * - 名称：`name` 与 `short_name`（短名没填就回落名称，与 [Brand.displayShortName] 同一条口径）
     * - 主题色：`theme_color`（只认 `#rgb`/`#rrggbb`，BrandStore.sanitize 已经洗过一遍）
     * - 图标：把自定义图标**插到 icons 数组最前面**，内置那几条全部留着兜底 ——
     *   我们只对上传的那一张做魔数校验，不做重栅格化，所以不敢替掉 maskable 那一条：
     *   一张没有安全区的普通图当 maskable 用，会被系统裁掉一圈，正是「图标缺角」那个投诉的形状。
     *
     * 解析失败（内置文件坏了 / 字段缺失）时原样返回内置文本：品牌是锦上添花，
     * 不该因为品牌配置把 PWA 的安装清单整个弄坏。
     */
    fun render(brand: Brand, iconUrl: String?, iconType: String?): String {
        val base = packagedText() ?: return ""
        val untouched = brand.name.isBlank() && brand.themeColor.isBlank()
        if (untouched && iconUrl.isNullOrBlank()) return base
        val root = runCatching { json.parseToJsonElement(base).jsonObject }.getOrNull() ?: return base

        val out = root.toMutableMap()
        if (brand.name.isNotBlank()) {
            out["name"] = JsonPrimitive(brand.displayName)
            out["short_name"] = JsonPrimitive(brand.displayShortName)
        }
        if (brand.themeColor.isNotBlank()) out["theme_color"] = JsonPrimitive(brand.themeColor)
        if (!iconUrl.isNullOrBlank() && !iconType.isNullOrBlank()) {
            val existing = (out["icons"] as? kotlinx.serialization.json.JsonArray) ?: buildJsonArray { }
            out["icons"] = buildJsonArray {
                add(buildJsonObject {
                    put("src", JsonPrimitive(iconUrl))
                    // 尺寸写 any：只校验了字节是真图，没量过像素尺寸，不敢替浏览器报一个假数字。
                    put("sizes", JsonPrimitive("any"))
                    put("type", JsonPrimitive(iconType))
                    put("purpose", JsonPrimitive("any"))
                })
                existing.forEach { add(it) }
            }
        }
        return json.encodeToString(JsonObject.serializer(), JsonObject(out))
    }

    /** 给界面/探针用的当前值，不含图标字节。 */
    fun brandJson(brand: Brand, iconUrl: String?): JsonObject = buildJsonObject {
        put("name", JsonPrimitive(brand.name))
        put("displayName", JsonPrimitive(brand.displayName))
        put("shortName", JsonPrimitive(brand.shortName))
        put("themeColor", JsonPrimitive(brand.themeColor))
        put("hasIcon", JsonPrimitive(!iconUrl.isNullOrBlank()))
        if (iconUrl != null) put("iconUrl", JsonPrimitive(iconUrl))
        // 内置名报出去：界面要能区分"这是 legadoQ 的默认"与"这是用户改过的"。
        put("builtinName", JsonPrimitive(BuildInfo.title))
    }
}

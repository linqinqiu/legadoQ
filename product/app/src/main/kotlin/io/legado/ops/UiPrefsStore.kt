package io.legado.ops

import io.legado.port.LogLevel
import io.legado.port.logSystem
import java.nio.charset.StandardCharsets
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * 服务端保存的界面偏好（用户 2026-11-12：「改端口后自己设的壁纸恢复默认，还弹免责声明」）。
 *
 * ## 为什么偏好要搬到服务端
 *
 * 壁纸、阅读设置、首启免责声明标记原先全在浏览器的 localStorage 里，而 localStorage 按
 * **origin（协议+主机+端口）**隔离：界面里改一次端口，等于换了一个站点，之前存的一切都读不到。
 * 于是壁纸回默认、免责声明重新弹。这些偏好描述的是「这个人这台机器怎么用 legadoQ」，
 * 与品牌名（brand.json）、自定义接入（agent-profiles.json）同一类，
 * 所以跟着数据目录走，换端口不丢、搬目录能带走。
 *
 * ## 形状与纪律
 *
 * 文件是 { "prefs": { "<key>": <任意 JSON> } }，值原样保存 —— 前端存对象、数组、字符串、
 * 布尔都行，服务端不解释内容（它只负责"别丢"）。这也意味着**前端可以自己演进字段**，
 * 不用每加一个设置就来改一次后端。
 *
 * 三道闸门：
 * - key 白名单 [KEY_PATTERN]：只收小写字母/数字/连字符/下划线/点，1~64 位。
 *   key 会原样出现在 URL 里，还会进 JSON 的键 —— 放开大小写与特殊字符只会让两边都要转义；
 * - 单值 ≤ [MAX_VALUE_BYTES]、整表 ≤ [MAX_TOTAL_BYTES]：localStorage 用量是浏览器的 5MB，
 *   这里读数发生在前端启动路径上，必须小到"每次启动读一遍无所谓"；
 * - 写入原子（临时文件 + rename，同目录同一文件系统）+ 进程内互斥：
 *   前端启动时 GET 这一次不能读到半个 JSON，读到就整份回落到空表（等于又丢了壁纸）。
 *
 * 坏文件不抛：回落空表 + 一条 WARN 日志，下次写入自然重建 —— 与 BrandStore 同一取舍。
 */
class UiPrefsStore(private val file: Path) {

    /** key 不合法：由路由转 400（这是调用方传错了，不是服务坏了）。 */
    class InvalidKeyException(val key: String) : IllegalArgumentException(
        "界面偏好 key 不合法：$key（只允许小写字母、数字、连字符、下划线与点，1~64 位，且不能以连字符/点/下划线开头）",
    )

    /** 超过体积上限：由路由转 413。消息里带实测字节数，方便对上限。 */
    class TooLargeException(message: String) : RuntimeException(message)

    companion object {
        /** 数据目录下的文件名（与 local_books/ 同级）。 */
        const val FILE_NAME = "ui-prefs.json"

        /** 单个 key 序列化后的上限。够存壁纸地址、阅读排版与免责声明的确认时间，远不到拖慢启动的量级。 */
        const val MAX_VALUE_BYTES = 32 * 1024

        /** 整表上限：按单值上限算，至少能放 8 个满配偏好。 */
        const val MAX_TOTAL_BYTES = 256 * 1024

        /**
         * key 白名单。前端用的三个 agreement / wallpaper / reader-settings 都落在里面 ——
         * 连字符必须允许，否则「阅读设置」这种复合名就得挤成驼峰。
         */
        private val KEY_PATTERN = Regex("^[a-z0-9][a-z0-9-_.]{0,63}$")

        /** 这条 key 能不能写。路由与测试都用它，避免两边各写一份正则。 */
        fun isKeyAllowed(key: String): Boolean = KEY_PATTERN.matches(key)

        private val json = Json { ignoreUnknownKeys = true }

        /** 把偏好表包成契约形状 { "prefs": { … } }。 */
        fun envelope(prefs: Map<String, JsonElement>): JsonObject =
            JsonObject(mapOf("prefs" to JsonObject(prefs)))
    }

    /** 单进程内串行化读改写：GET 与 PUT/DELETE 撞在一起时，不能出现"两边各读一份旧表再各写一份"。 */
    private val lock = ReentrantLock()

    /** 坏文件只报一次：GET 可能被反复调用，每调一次刷一条日志等于把真问题埋掉。 */
    private val corruptWarned = AtomicBoolean(false)

    /** 当前全部偏好（防御性拷贝；调用方改不到内部状态）。文件不存在 / 坏了都回空表。 */
    fun read(): Map<String, JsonElement> = lock.withLock { load() }

    /** GET /api/ui-prefs 的响应体，直接回字符串 —— 不让 ContentNegotiation 决定 JsonElement 怎么序列化。 */
    fun snapshotJson(): String = lock.withLock { encode(load()) }

    /**
     * 写入（覆盖）一个 key。先校验 key 与单值体积，再在锁内读整表、合并、校验整表体积、原子落盘。
     * 任一步失败都不会碰磁盘上的旧文件。
     */
    fun put(key: String, value: JsonElement) {
        requireValidKey(key)
        val valueBytes = serializedBytes(value)
        if (valueBytes > MAX_VALUE_BYTES) {
            throw TooLargeException("单个界面偏好上限 ${MAX_VALUE_BYTES / 1024} KB，这个值序列化后有 $valueBytes 字节")
        }
        lock.withLock {
            val prefs = LinkedHashMap(load())
            prefs[key] = value
            val totalBytes = encode(prefs).toByteArray(StandardCharsets.UTF_8).size
            if (totalBytes > MAX_TOTAL_BYTES) {
                throw TooLargeException(
                    "界面偏好总表上限 ${MAX_TOTAL_BYTES / 1024} KB，写入「$key」后会有 $totalBytes 字节；这次没有落盘",
                )
            }
            write(prefs)
        }
    }

    /** 删一个 key。key 不存在返回 false（路由仍回 204 —— DELETE 应当幂等）。 */
    fun delete(key: String): Boolean {
        requireValidKey(key)
        return lock.withLock {
            val prefs = LinkedHashMap(load())
            if (prefs.remove(key) == null) return@withLock false
            write(prefs)
            true
        }
    }

    private fun requireValidKey(key: String) {
        if (!isKeyAllowed(key)) throw InvalidKeyException(key)
    }

    /**
     * 读文件。不存在 = 空表；读不出来 / 不是合法 JSON / 形状不对 = 空表 + 一条 WARN。
     *
     * 坏文件**不删**：它可能还留着用户别的 key（比如手工编辑时少了一个逗号），
     * 下一次 PUT 会用整表覆盖它 —— 但如果这次是启动时读坏了，删掉反而让「能不能救」彻底没机会。
     */
    private fun load(): Map<String, JsonElement> {
        if (!Files.isRegularFile(file)) return emptyMap()
        val parsed = runCatching {
            val raw = Files.readString(file, StandardCharsets.UTF_8)
            // 容忍 BOM：Windows 上的编辑器与 PowerShell 默认会写（与 BrandStore 同一处理）。
            val text = if (raw.startsWith("\uFEFF")) raw.substring(1) else raw
            val root = json.parseToJsonElement(text) as? JsonObject
                ?: error("顶层不是 JSON 对象")
            root["prefs"] as? JsonObject
                ?: error("缺少 prefs 对象")
        }
        return parsed.map { prefs ->
            // 读成功就解除"已报过"状态：下次再坏（被手工改坏）仍要留下一条可见的日志。
            corruptWarned.set(false)
            prefs
        }.getOrElse { error ->
            if (corruptWarned.compareAndSet(false, true)) {
                this.logSystem(
                    "界面偏好文件读不出来，先按空表继续（下次写入会重建）",
                    mapOf("文件" to file.toString()),
                    error,
                    LogLevel.WARN,
                )
            }
            emptyMap()
        }
    }

    private fun encode(prefs: Map<String, JsonElement>): String =
        json.encodeToString(JsonObject.serializer(), envelope(prefs))

    /** 体积按**规范化后的紧凑 JSON**算，不按请求原文：空白填充撑不出上限，也不该算进用户配额。 */
    private fun serializedBytes(value: JsonElement): Int =
        json.encodeToString(JsonElement.serializer(), value).toByteArray(StandardCharsets.UTF_8).size

    /**
     * 原子落盘：同目录临时文件 → force → rename。
     *
     * 为什么必须是同目录：跨文件系统的 rename 会退化成"复制 + 删除"，那就不再原子，
     * 读的一方仍可能看到半份文件。临时文件前缀带正式文件名，异常退出后好认、好清。
     */
    private fun write(prefs: Map<String, JsonElement>) {
        val parent = file.toAbsolutePath().parent ?: Path.of(".")
        Files.createDirectories(parent)
        val temp = Files.createTempFile(parent, "$FILE_NAME.", ".tmp")
        try {
            Files.writeString(temp, encode(prefs), StandardCharsets.UTF_8)
            // Windows 上 rename 前先落盘，避免断电后留下"文件名换了、内容还是空的"。
            runCatching {
                java.nio.channels.FileChannel.open(temp, java.nio.file.StandardOpenOption.WRITE).use { it.force(true) }
            }
            try {
                Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE)
            } catch (_: AtomicMoveNotSupportedException) {
                Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING)
            }
        } finally {
            // 成功 move 后这里已经不存在；失败时把临时文件清掉，不留垃圾。
            Files.deleteIfExists(temp)
        }
        corruptWarned.set(false)
    }
}

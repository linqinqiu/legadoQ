package io.legado

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `AppConfig` 里每一条环境变量的**接线**判据：键真的被读过，且读出来的就是字段生效值。
 *
 * 为什么需要这本账：`System.getenv()` 进程级只读，判据既改不了 env，也不能为每个取值起新进程。
 * 而 env 全未设时，一个键名写错、或字段接到了隔壁键的配置项，值与默认值完全一样 ——
 * 只比字段值永远发现不了。所以 `AppConfig` 在解析处记账（`effectiveValue` / `readKeys`），
 * 本判据拿字段值去对账：
 *
 * - 账本里没有这个键 → 字段没读它（键名写错、或根本没接线）；
 * - 账本有键但值不等 → 字段接到了别的键，或中途丢了 `coerceIn` 之类的加工。
 *
 * **不覆盖**：环境变量真被设成非默认值时字段是否照做（那要另起进程）。本表只钉接线与默认值。
 */
class AppConfigEnvWiringTest {

    private data class Binding(val key: String, val read: () -> String)

    /**
     * 新增配置项时**必须**往这里补一行：最后一条用例会拿 `readKeys()` 反查漏登记的键，
     * 漏了会红，不会静默少测一条。
     */
    private val bindings = listOf(
        Binding("LEGADO_CALL_GROUP_SIZE") { AppConfig.callGroupSize.toString() },
        Binding("LEGADO_SEARCH_CONCURRENCY_MIN") { AppConfig.searchConcurrencyMin.toString() },
        Binding("LEGADO_SEARCH_CONCURRENCY_MAX") { AppConfig.searchConcurrencyMax.toString() },
        Binding("LEGADO_SEARCH_TIMEOUT_MS") { AppConfig.searchTimeoutMs.toString() },
        Binding("LEGADO_SEARCH_TOTAL_TIMEOUT_MS") { AppConfig.searchTotalTimeoutMs.toString() },
        Binding("LEGADO_AI_MAX_TOOL_ROUNDS") { AppConfig.aiMaxToolRounds.toString() },
        Binding("LEGADO_AI_MAX_TOOL_DATA") { AppConfig.aiMaxToolData.toString() },
        Binding("LEGADO_AI_MAX_CONTEXT_CHARS") { AppConfig.aiMaxContextChars.toString() },
        Binding("LEGADO_AI_MAX_PROMPT_CHARS") { AppConfig.aiMaxPromptChars.toString() },
        Binding("LEGADO_CACHE_CONCURRENCY") { AppConfig.cacheConcurrency.toString() },
        Binding("LEGADO_DB_POOL_SIZE") { AppConfig.dbPoolSize.toString() },
        Binding("LEGADO_DB_SNAPSHOT_KEEP") { AppConfig.dbSnapshotKeep.toString() },
        Binding("LEGADO_DB_SNAPSHOT_MIN_INTERVAL_MS") { AppConfig.dbSnapshotMinIntervalMs.toString() },
        Binding("LEGADO_EDGE_TTS_CACHE_MAX") { AppConfig.edgeTtsCacheMax.toString() },
        Binding("LEGADO_EDGE_TTS_CHROMIUM_VERSION") { AppConfig.edgeTtsChromiumVersion },
        Binding("LEGADO_TTS_IDLE_TIMEOUT_MS") { AppConfig.ttsIdleTimeoutMs.toString() },
        Binding("LEGADO_TTS_MAX_LIFETIME_MS") { AppConfig.ttsMaxLifetimeMs.toString() },
        Binding("LEGADO_SUBSCRIPTION_UPDATE_MS") { AppConfig.subscriptionUpdateMs.toString() },
        Binding("LEGADO_JS_TIMEOUT_MS") { AppConfig.jsTimeoutMs.toString() },
        Binding("LEGADO_JS_HOST_BYTES") { AppConfig.jsHostBytes.toString() },
        Binding("LEGADO_MAX_TOC_PAGES") { AppConfig.maxTocPages.toString() },
        Binding("LEGADO_MAX_CONTENT_PAGES") { AppConfig.maxContentPages.toString() },
        Binding("LEGADO_AI_ENABLED") { AppConfig.aiEnabled.toString() },
        Binding("LEGADO_AI_ALLOW_REMOVING_BUILTIN_TOOLS") { AppConfig.aiAllowRemovingBuiltinTools.toString() },
        Binding("LEGADO_ALLOW_EXTERNAL_BIND") { AppConfig.allowExternalBind.toString() },
        Binding("LEGADO_AI_ALLOW_LOOPBACK_BASEURL") { AppConfig.aiAllowLoopbackBaseUrl.toString() },
        Binding("LEGADO_AI_FORCE_TEXT_FALLBACK") { AppConfig.aiForceTextFallback.toString() },
        Binding("LEGADO_AI_NEVER_DOWNGRADE_PROTOCOL") { AppConfig.aiNeverDowngradeProtocol.toString() },
    )

    @Test
    fun `每个键都被读过且账本值与字段生效值一致`() {
        val problems = bindings.mapNotNull { binding ->
            // 先读字段：`aiEnabled` 这类 get() 属性要读一次才记账，顺序反了会误报"从未读取"。
            val fieldValue = binding.read()
            val recorded = AppConfig.effectiveValue(binding.key)
            when {
                recorded == null ->
                    "${binding.key}：AppConfig 从未读取这个键（字段可能接到了别的键）"
                recorded != fieldValue ->
                    "${binding.key}：账本值 $recorded ≠ 字段值 $fieldValue"
                else -> null
            }
        }
        assertEquals(
            "环境变量接线不一致：\n" + problems.joinToString("\n"),
            emptyList<String>(),
            problems,
        )
    }

    @Test
    fun `键名不重复且都是大写的 LEGADO 前缀`() {
        val keys = bindings.map { it.key }
        assertEquals("同一个键被两条接线重复登记", keys.toSet().size, keys.size)
        keys.forEach {
            assertTrue("$it 不像一条 LEGADO_* 环境变量", it.startsWith("LEGADO_") && it == it.uppercase())
        }
    }

    @Test
    fun `没有读了却没登记的键`() {
        bindings.forEach { it.read() } // 先让全部字段（含 get() 属性）都记上账
        val registered = bindings.map { it.key }.toSet()
        assertEquals(
            "AppConfig 读了这些键但本判据没登记 —— 新增配置项请补进 bindings 表",
            emptySet<String>(),
            AppConfig.readKeys() - registered,
        )
    }

    /**
     * `.env.example` 自称「下面是服务端真正读取的全部可配项」。这句是承诺，就该有判据守：
     * 新增一个 env 键而忘了写进示例文件，用户根本不知道有这个旋钮（本判据落地前就漏了 6 个）。
     *
     * 反向不查：`.env.example` 里还有 `ServerConfig` 的键（HOST / PORT / DATA_DIR …），
     * 它们不由 `AppConfig` 读取，多出来是正常的。
     */
    @Test
    fun `代码读的每个键都写进了 env 示例文件`() {
        bindings.forEach { it.read() }
        val missing = AppConfig.readKeys() - documentedKeys()
        assertEquals(
            "这些键 AppConfig 会读，但 .env.example 里没有：\n" + missing.joinToString("\n"),
            emptySet<String>(),
            missing,
        )
    }

    /** 示例文件里键一律以注释形式给出（`# LEGADO_X=1`），所以连注释号一起匹配。 */
    private fun documentedKeys(): Set<String> {
        val pattern = Regex("""^\s*#?\s*(LEGADO_[A-Z0-9_]+)\s*=""")
        return Files.readAllLines(findEnvExample())
            .mapNotNull { pattern.find(it)?.groupValues?.get(1) }
            .toSet()
    }

    /** cwd 在 CI 与本地不同（`product/app` 或 `product`），向上回溯找示例文件，与既有判据同一套做法。 */
    private fun findEnvExample(): Path {
        var dir: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        repeat(6) {
            val current = dir ?: return@repeat
            listOf(current.resolve(".env.example"), current.resolve("product/.env.example"))
                .firstOrNull { Files.isRegularFile(it) }
                ?.let { return it }
            dir = current.parent
        }
        error("找不到 .env.example（cwd=${System.getProperty("user.dir")}）")
    }
}

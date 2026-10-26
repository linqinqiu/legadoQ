package io.legado

/**
 * 版本号的唯一来源。
 *
 * 值由 Gradle 在打 fatJar 时写进清单的 `Implementation-Version`（见 `app/build.gradle`
 * 的 `version = '0.1.0'` 与 `manifest { attributes(...) }`），所以**构建产物、`/healthz`
 * 报的、界面显示的是同一个数**，不存在"改了 gradle 忘了改界面"那种假版本号。
 * 从源码直接跑（`gradle run` 走的是 `jar` 任务，同样带清单）拿不到时回落 `dev`，
 * 那说明这是开发中的副本，不是一个可发布的版本。
 */
object BuildInfo {
    val version: String =
        BuildInfo::class.java.`package`?.implementationVersion?.takeIf { it.isNotBlank() && it != "unknown" }
            ?: "dev"

    val title: String = "legadoQ"

    /**
     * 当前这个包里前端主 bundle 的文件名（`static/index.html` 里那串内容哈希）。
     *
     * 为什么要有：这台服务"改了看不到"过不止一次 —— 跑着的 `-all.jar` 是旧的、磁盘上的
     * `web/dist` 是新的，`/healthz` 照样报同一个版本号，光看版本根本分不出来。哈希是构建
     * 产物自带的指纹，启动后首次访问时从 classpath 现读，不用改构建脚本、也不会和版本号脱钩。
     * 配合 `start.mjs` 与 `tools/verify/bundled-ui-check.mjs` 的比对，一条 curl 就能定性
     * "我跑的到底是哪个前端"，不必再手工解包对比 jar。
     *
     * 从 classes 目录直接跑（`gradlew :app:run`）时 `web/dist` 可能压根没拷进来，此时返回
     * 空串 —— 那是开发态，调用方据此判断"没有可对照的前端"，不当缺陷看。
     */
    val uiFingerprint: String by lazy {
        runCatching {
            val html = BuildInfo::class.java.getResourceAsStream("/static/index.html")
                ?.use { String(it.readBytes(), Charsets.UTF_8) }
                ?: return@runCatching ""
            Regex("""assets/(index-[A-Za-z0-9_-]+\.js)""").find(html)?.groupValues?.get(1).orEmpty()
        }.getOrDefault("")
    }

    /** 进程启动时刻（epoch 毫秒）：判断"到底重启没有"，比翻文件 mtime 直接。 */
    val startedAt: Long = System.currentTimeMillis()
}

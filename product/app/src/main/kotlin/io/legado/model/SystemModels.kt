package io.legado.model

import kotlinx.serialization.Serializable

@Serializable data class ApiError(val code: String, val message: String)

/**
 * 探活兼报版本：界面右上角显示的版本号就来自这里，保证"跑着的 == 构建的 == 界面说的"。
 *
 * `ui`、`startedAtMs` 与 `build` 是给"改了看不到"这类部署漂移准备的自证字段：版本号相同但包是旧的时，
 * 光看 `version` 分不出来，而 bundle 文件名带内容哈希、启动时刻只会随重启变；`build` 是内部构建号，
 * 与对外版本解耦（见 `BUILD_NUMBER`）。三者都带默认值，老客户端读旧包也不会缺字段。
 */
@Serializable
data class HealthStatus(
    val title: String,
    val version: String,
    val status: String,
    val ui: String = "",
    val startedAtMs: Long = 0L,
    val build: String = "0",
    /** 代码修订（`rev-<提交数>`）；构建里拿不到 git 时为空串。 */
    val rev: String = "",
    /** 与 [rev] 配套的短 sha，用于精确定位提交；取不到时为空串。 */
    val sha: String = "",
)

/** 「关于」页顶部那三样：名字、版本、发布仓库。版本只有一个来源（清单），界面不许写死。 */
@Serializable data class AboutInfo(
    val title: String,
    val version: String,
    val repository: String,
    /** 内部构建号；`0` 表示这个包读取不到 `meta/build-info.properties`。 */
    val build: String = "0",
)

/**
 * 服务自身：当前绑在哪、界面里那个「服务端口」现在显示什么。
 * `port` 是**这次运行**实际用的端口 —— 改了 port.txt 也不会变，要重启才生效。
 */
@Serializable data class ServerInfo(val host: String, val port: Int)

/** 界面里改端口：只写安装根的 `port.txt`，不碰正在跑的这个进程。 */
@Serializable data class ServerPortRequest(val port: Int)

@Serializable data class ServerPortResult(val port: Int, val restartRequired: Boolean)

/**
 * 「关于 → 检查更新」的结果。`status`：`latest` / `available` / `not_found` / `unreachable` / `not_configured`。
 *
 * `latest` 那一组是**版本号发布**（标签形如 `v0.6.26`），拿来判"有没有更新"；
 * `rolling*` 那一组是 CI 的**滚动构建**（标签不是版本号，如 `latest`），只报发布时间与链接、不判新旧。
 */
@Serializable data class UpdateCheckResult(
    val current: String,
    val latest: String? = null,
    val url: String? = null,
    val publishedAt: String? = null,
    val repository: String,
    val status: String,
    val message: String? = null,
    val rollingTag: String? = null,
    val rollingUrl: String? = null,
    val rollingPublishedAt: String? = null,
)

@Serializable
data class TtsVoice(
    val id: String,
    val name: String,
    val lang: String,
    val gender: String,
    val localeName: String,
    val engine: String = "edge",
    val description: String? = null,
)

@Serializable
data class TtsSpeakRequest(
    val text: String,
    val voice: String = "zh-CN-XiaoxiaoNeural",
    val rate: Int = 0,
    val pitch: Int = 0,
    val engine: String = "edge",
    val customUrl: String? = null,
    val customHeader: String? = null,
    val customMethod: String? = null,
    val customBody: String? = null,
)

@Serializable
data class TtsSessionInfo(
    val sessionId: String,
    val audioUrl: String,
    val eventsUrl: String,
)

@Serializable
data class TtsSessionChunkRequest(
    val chunkId: String,
    val text: String,
    val chapterIndex: Int = -1,
    val paragraphIndex: Int = -1,
    val engine: String = "edge",
    val voice: String = "zh-CN-XiaoxiaoNeural",
    val rate: Int = 0,
    val pitch: Int = 0,
    val customUrl: String? = null,
    val customHeader: String? = null,
    val customMethod: String? = null,
    val customBody: String? = null,
)

@Serializable
data class TtsSessionControlRequest(
    val action: String,
)

@Serializable
data class TtsSessionAck(
    val accepted: Boolean,
)

@Serializable
data class TtsSessionEvent(
    val type: String,
    val sessionId: String,
    val chunkId: String? = null,
    val chapterIndex: Int = -1,
    val paragraphIndex: Int = -1,
    val audioEndMs: Long? = null,
    val durationMs: Long? = null,
    val message: String? = null,
)

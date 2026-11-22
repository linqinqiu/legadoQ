package io.legado.port

import java.net.URI
import java.net.http.HttpClient
import java.time.Duration

/**
 * 本机控制面端口 —— engine 侧只认这个接口，实现留在 infra。
 *
 * 来历：`source/ExternalBrowserLogin` 要连本机 Chromium 的 DevTools 端口，此前直接
 * import `ops.LocalControlClient`，在 `ArchitectureBoundaryTest` 的判据 5 上留下一条
 * `engine → infra`。这里把「签发回环专用 HttpClient + 回环地址闸门」提成端口，
 * 由组合根（`http/Routes.kt`）注入 `ops.LocalControlClient`，方向变为 `engine → port`。
 *
 * 边界纪律：本文件**不许** import `io.legado.ops` / `io.legado.data`；否则只是把倒挂
 * 从 engine 搬到了 port。签发点仍只有 `LocalControlClient.kt` 一处，G3 不动。
 */
interface LocalControl {
    fun newClient(
        connectTimeout: Duration,
        followRedirects: HttpClient.Redirect = HttpClient.Redirect.NEVER,
    ): HttpClient

    fun requireLoopback(uri: URI)
}

package io.legado.http

import java.net.URI

/**
 * 代取书源资源（封面 / 正文配图 / 音视频流）时该带的请求头，**一处定死**。
 *
 * 为什么要抽出来：这三条路以前各写各的 —— 文本链路（搜索 / 详情 / 目录 / 正文）每次都带上
 * 该书源在本机的 Cookie，而代理链路一条都不带。浏览器自己发 `<img>` / `<audio>` / `<video>`
 * 时无法自定义请求头，所以这些资源只能由服务端代取；代取不补凭据，结果就是
 * 「登录成功了、目录正文都读得出，图和音频流一打开还是 403」—— 登录白做。
 *
 * 两条纪律：
 * - **Cookie 按每一跳的落地域名现取**（[cookieFor] 收到的是当前这一跳的绝对地址）。
 *   跳到别的域名后带的是那个域自己的凭据，没有就不带 —— 不能把原站的 Cookie 捎给客户方。
 * - **Referer 是调用方给的原始页面**，重定向后仍然带着：不少图站是「主域 → 图片 CDN」两跳，
 *   收掉 Referer 会把现在能出图的站打回 403。（CoverCache 原来的注释写的是"跳转后不再补发"，
 *   与它自己的代码不符，这里按代码的事实写。）
 */
fun proxyRequestHeaders(
    uri: URI,
    referer: String?,
    cookieFor: (String) -> String? = { null },
    range: String? = null,
): Map<String, String> {
    val headers = LinkedHashMap<String, String>()
    // 有些站对默认的 `Java/17` UA 直接 403，给一个稳定的自有 UA。
    headers["User-Agent"] = "legadoQ/0.1"
    referer?.let { headers["Referer"] = it }
    range?.let { headers["Range"] = it }
    cookieFor(uri.toString())?.takeIf { it.isNotBlank() }?.let { headers["Cookie"] = it }
    return headers
}

package io.legado.cache

import io.legado.model.SearchResult

/**
 * 封面解析：从「主封面 + 备用源封面」里挑一个能用的。
 *
 * ## 为什么放在 `io.legado.cache` 而不是路由或仓库里
 *
 * 这两件事只依赖 [CoverCache]，与 HTTP 路由、书架表结构都无关 —— 它们本来就是
 * `CoverCache` 的延伸，不是某一层的业务流程。早先它们作为顶层函数写在 `ShelfRoutes.kt`
 * 里（`io.legado.http`），后来被挪进 `BookshelfRepository` 的私有成员，
 * 结果 `CoverCacheTest` 再也够不着、测试编译不过 ——
 * 「逻辑该住在哪」被来回搬，最后是靠测试报错才暴露出来。
 *
 * 放在这里之后：路由、仓库、测试三方都从同一个地方取，且不产生依赖倒挂
 *（`cache` 层不依赖 `data` 或 `http`）。
 *
 * ## 两个函数的区别（别合并）
 *
 * - [tryFindCachedCover]：**只看缓存**，绝不发网络请求。用于「写书架时想立刻给个封面」，
 *   缓存里没有就先空着，不能因为找封面把一次写请求拖慢。
 * - [tryCacheCover]：**会真的去抓**。用于需要封面的场合（换源、补封面），允许慢一点。
 *
 * 混用会出事：写路径误用后者，会让一次「加入书架」变成一次图片下载；
 * 读路径误用前者，则永远拿不到新封面。
 */

/**
 * 在「主封面 + 各备用源的封面」里找一个**已经缓存**的。
 *
 * 候选按「主封面优先、备用源按顺序」排列并去重；第一个命中缓存的就是结果。
 * 全程不发起网络请求，缓存全空时返回 `null`。
 */
internal fun tryFindCachedCover(
    coverCache: CoverCache,
    primaryUrl: String?,
    alternateSources: List<SearchResult>?,
): CachedCover? {
    for (url in coverCandidates(primaryUrl, alternateSources)) {
        val cached = coverCache.getIfCached(url)
        if (cached != null) return cached
    }
    return null
}

/**
 * 按同样的候选顺序**真正去抓**封面，抓到第一个成功为止。
 *
 * @param referer 传给图片请求的 Referer（多数站点防盗链）。只有它是 http(s) 时才下发 ——
 *   把 `local://` 这类内部协议当 Referer 发出去会被目标站判成非法请求。
 */
internal fun tryCacheCover(
    coverCache: CoverCache,
    primaryUrl: String?,
    alternateSources: List<SearchResult>?,
    referer: String?,
): CachedCover? {
    val page = referer?.takeIf { it.startsWith("http", ignoreCase = true) }
    for (url in coverCandidates(primaryUrl, alternateSources)) {
        val cached = runCatching { coverCache.cache(url, page) }.getOrNull()
        if (cached != null) return cached
    }
    return null
}

/** 候选封面地址：主封面在前，备用源按给定顺序，去重且跳过空白。 */
private fun coverCandidates(primaryUrl: String?, alternateSources: List<SearchResult>?): List<String> = buildList {
    primaryUrl?.takeIf { it.isNotBlank() }?.let { add(it) }
    alternateSources?.forEach { source ->
        source.coverUrl?.takeIf { it.isNotBlank() && it !in this }?.let { add(it) }
    }
}

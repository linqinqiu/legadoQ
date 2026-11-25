package io.legado.feedback

/**
 * 匿名反馈的服务端频率闸（2026-11-25）。
 *
 * 为什么需要它：Supabase 侧的 RLS 只校验字段合法性与「只看自己的行」，没有任何频率限制；
 * 同源写门只挡跨域，本机同源页面或一段卡住的脚本仍可无限 POST，把匿名中转表刷满。
 * 前端 `feedbackToken.ts` 有 30s 冷却，但那只是 localStorage 里的一个时间戳，绕过成本为零。
 *
 * 口径刻意与隐私承诺一致：**只按前端送来的 tokenHash 计数，不碰 IP / UA / 设备**。
 * tokenHash 本来就在请求体里（RLS 也靠它放行查询），不新增任何采集项。
 *
 * 滑动窗口而非固定窗口：固定窗口在边界处能连发 2× 的量。窗口大小与阈值都可注入，
 * 时钟也注入（[clock]），判据无需真的等待几分钟就能推进时间。
 *
 * 内存有上界：[MAX_KEYS] 之外的 key 按最后一次活动的时间淘汰最旧的 —— 否则攻击者不断换
 * tokenHash 就能让这张表无限增长。淘汰只丢计数，不影响任何已提交的反馈。
 */
class FeedbackLimiter(
    private val maxPerWindow: Int = DEFAULT_MAX_PER_WINDOW,
    private val windowMs: Long = DEFAULT_WINDOW_MS,
    private val clock: () -> Long = { System.currentTimeMillis() },
) {
    /** key → 窗口内的提交时间戳（毫秒）。只存时间，不存内容，也不存身份。 */
    private val hits = LinkedHashMap<String, MutableList<Long>>()

    @Synchronized
    fun allow(key: String): Boolean {
        val now = clock()
        val cutoff = now - windowMs
        val timestamps = hits[key] ?: mutableListOf<Long>().also { hits[key] = it }
        // 滑掉窗口外的旧记录（<= cutoff 一律算过期，边界不占额度）。
        timestamps.removeAll { it <= cutoff }
        if (timestamps.size >= maxPerWindow) {
            prune(now, cutoff)
            return false
        }
        timestamps.add(now)
        prune(now, cutoff)
        return true
    }

    /** 测判据时清空状态；生产路径不调用。 */
    @Synchronized
    fun reset() = hits.clear()

    private fun prune(now: Long, cutoff: Long) {
        // 先丢掉只剩过期记录的 key，再在超限时长按最旧活动淘汰。
        val expired = hits.entries.filter { it.value.all { ts -> ts <= cutoff } }.map { it.key }
        expired.forEach { hits.remove(it) }
        if (hits.size <= MAX_KEYS) return
        val overflow = hits.size - MAX_KEYS
        hits.entries
            .sortedBy { entry -> entry.value.maxOrNull() ?: 0L }
            .take(overflow)
            .forEach { hits.remove(it.key) }
    }

    companion object {
        /** 五分钟内同一 token 最多三条 —— 比前端 30s 冷却宽松，正常反馈不会撞到。 */
        const val DEFAULT_MAX_PER_WINDOW = 3
        const val DEFAULT_WINDOW_MS = 5 * 60_000L
        /** 同时在内存的 token 数上限，超出淘汰最旧的计数。 */
        const val MAX_KEYS = 512
    }
}

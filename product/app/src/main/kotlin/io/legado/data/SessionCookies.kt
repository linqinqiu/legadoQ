package io.legado.data

/**
 * 会话期凭据（内存层）—— 借自 legado-with-MD3 的 `CookieManager`：
 * `Set-Cookie` 里**没带 Max-Age / Expires** 的那批按 RFC 6265 属于会话 Cookie，
 * 浏览器关掉就没了。上游把它们放内存（`<domain>_session_cookie`），持久的那批才进库。
 *
 * 我们此前把两类一律写进 SQLite，后果不是"多存了几条"这么无害：
 * 站点发一条会话 Cookie 常常意味着"这一步的临时状态"（CSRF token、登录中间态、
 * 风控一次性 nonce）。把它永久落库，下次再访问就带着一个早该失效的值 —— 站点要么
 * 判成非法请求回 400，要么静默把会话踢回未登录。用户看到的现象是"昨天还能用，今天
 * 突然要重新登录"，而真正的原因藏在一次登录流程里存进去的一条临时 Cookie。
 *
 * 三条口径：
 * - **进程内**：重启即失效，与浏览器一致。不进库、不进备份包，也就不会被同步到别的机器。
 * - **键序 = 最后写入顺序**：合并时把重设的键挪到尾部。这样"超长淘汰"淘汰的是
 *   最久没更新的那几个，而不是随机丢（MD3 用的是 `keys.random()`，同一份库两次请求
 *   可能带出不一致的凭据，这对登录态来说是灾难）。
 * - **只有 `Set-Cookie` 能分类**：用户在界面上手工粘贴的 Cookie 串没有任何属性信息，
 *   一律按持久处理 —— 他既然手动贴进来，就是希望它留下来。
 */
object SessionCookies {

    /** domain → (key → value)，插入顺序即"最后写入顺序"。 */
    private val byDomain = java.util.concurrent.ConcurrentHashMap<String, LinkedHashMap<String, String>>()

    /** 合并写入若干键；重设的键移到尾部（见类注释第二条）。 */
    fun put(domain: String, pairs: Map<String, String>) {
        if (pairs.isEmpty()) return
        byDomain.compute(domain) { _, existing ->
            val map = existing ?: LinkedHashMap()
            synchronized(map) {
                for ((key, value) in pairs) {
                    map.remove(key)
                    map[key] = value
                }
            }
            map
        }
    }

    /** 该域的会话凭据（按写入先后）；没有则空。返回的是快照拷贝，调用方可以随便改。 */
    fun get(domain: String): Map<String, String> {
        val map = byDomain[domain] ?: return emptyMap()
        return synchronized(map) { LinkedHashMap(map) }
    }

    /** 该域有没有会话凭据（列表接口据此标出"会话"桶）。 */
    fun has(domain: String): Boolean = byDomain[domain]?.isNotEmpty() == true

    /** 撤掉某个键（站点用 `Max-Age=0` 让某条过期时走这里）。返回是否真的删了。 */
    fun removeKey(domain: String, key: String): Boolean {
        val map = byDomain[domain] ?: return false
        return synchronized(map) { map.remove(key) } != null
    }

    /** 清掉整个域（界面上"删除这桶凭据"要连会话层一起清）。 */
    fun remove(domain: String) {
        byDomain.remove(domain)
    }

    /** 全部有会话凭据的域（与库里的持久桶求并集后给列表用）。 */
    fun domains(): Set<String> = byDomain.filterValues { it.isNotEmpty() }.keys.toSet()

    /** 只给测试与自检用：清掉整层。 */
    internal fun clear() = byDomain.clear()
}

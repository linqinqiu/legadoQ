package com.example

import io.legado.ai.AgentResult
import io.legado.ai.Tool
import io.legado.ai.ToolMeta
// 注意：`io.legado.data` 下的读写方法是**顶层扩展函数**，不是 Database 的成员，
// 所以外部插件必须显式 import —— 只写 `ctx.database.listBookshelf()` 会编译不过。
// 这是写插件最容易踩的第一个坑，示例里特意保留这行 import 让后来人照抄。
import io.legado.data.listBookshelf
import io.legado.plugin.Plugin
import io.legado.plugin.PluginMetadata

/**
 * 一个**真的能被装载并调用**的最小插件 —— 不是示意代码。
 *
 * 它演示三件事，也是第一个插件最该先跑通的链路：
 * 1. 声明自己是插件（[metadata] 是「插件」面板上展示的信息）；
 * 2. 给 AI 加一个工具（[tools]）—— AI 立刻就能调；
 * 3. 用 `ctx.database` 读真实数据（与 HTTP 端点背后是同一份数据库）。
 *
 * 它**不**注册 HTTP 路由（那会让端点计数漂移、破坏 ApiCatalog 门禁），
 * 也**不**绕开护栏 —— 框架的红线对插件一样生效。
 */
class HelloPlugin : Plugin {

    override val metadata = PluginMetadata(
        id = "example.hello",
        name = "示例：问候与书架统计",
        version = "1.0.0",
        description = "演示插件的最小形态：给 AI 加两个只读工具（问候、书架统计）。",
        author = "青阅示例",
        homepage = "https://github.com/linqinqiu/qingyue",
        capabilities = listOf("tools"),
    )

    override fun tools(): List<Tool> = listOf(hello, shelfStats)

    /**
     * 最小的一个工具：不碰数据库，只证明"插件注册的工具真的能被调到"。
     *
     * `writes = false` 很重要 —— 它决定这次调用走不走写前确认。
     * 报错要如实（不要假装成功），这是所有工具的底线。
     */
    private val hello = Tool { _, args ->
        val name = (args["name"] as? String)?.trim().orEmpty()
        AgentResult(
            status = "ok",
            message = if (name.isEmpty()) "hello from plugin" else "hello, $name",
            data = mapOf("from" to metadata.id, "version" to metadata.version),
        )
    }.also {
        it.meta = ToolMeta(
            id = "example.hello.greet",
            group = "example",
            description = "示例插件提供的问候工具：把 name 原样回显。",
            writes = false,
        )
    }

    /**
     * 一个**真的读数据**的工具：统计书架上多少本、读完多少本、缓存了多少章。
     *
     * 这里用的 `ctx.database.listBookshelf()` 就是主程序那一个 Database 实例 ——
     * 插件不新开数据连接、不绕开既有查询。
     */
    private val shelfStats = Tool { ctx, _ ->
        val books = ctx.database.listBookshelf()
        AgentResult(
            status = "ok",
            data = mapOf(
                "total" to books.size,
                "completed" to books.count { it.completed },
                "cachedChapters" to books.sumOf { it.cachedChapters },
                "reading" to books.count { !it.completed && it.chapterIndex != null },
            ),
        )
    }.also {
        it.meta = ToolMeta(
            id = "example.shelf.stats",
            group = "example",
            description = "统计书架：总数、已读完、正在读、已缓存章节数。",
            writes = false,
        )
    }
}

# 插件开发教程

> 目标：写一个 jar 丢进 `plugins/` 就能给青阅加能力 —— 不重编译主程序。
> 本文所有代码都对着 `plugin/Plugin.kt` 的真实签名写，不是示意。

## 0. 插件能扩展什么

| 扩展点 | 方法 | 能做什么 |
|---|---|---|
| 工具 | `tools()` | 给 AI / 自动化加能力（AI 立刻能调） |
| LLM 协议 | `llmProviders()` | 接 Anthropic / Ollama / 自建服务 |
| 连接选择策略 | `connectionSelectors()` | failover、按健康度挑连接 |
| 钩子 | `hooks()` | 审计、限流、改写工具结果 |
| 自我描述 | `metadata` | 「插件」面板上展示的信息 |

**插件不注册 HTTP 路由** —— 所以 `/api/catalog` 恒为 142 条端点，与装多少插件无关。
需要对外暴露能力？注册成**工具**，工具本来就能被 `/api/agent/*` 调到。

## 1. 最小插件（10 行）

```kotlin
package com.example

import io.legado.ai.AgentResult
import io.legado.ai.Tool
import io.legado.ai.ToolMeta
import io.legado.plugin.Plugin
import io.legado.plugin.PluginMetadata

class HelloPlugin : Plugin {
    override val metadata = PluginMetadata(
        id = "hello",
        name = "问候",
        version = "1.0.0",
        description = "一个最小插件示例",
    )

    override fun tools() = listOf(
        Tool { ctx, _ -> AgentResult(status = "ok", message = "hello") }
            .also { it.meta = ToolMeta("hello.greet", "hello", "打个招呼", writes = false) }
    )
}
```

## 2. 实战：给 AI 加一个「书架统计」工具

用户问「我书架上有多少本书」时，AI 能真的去查库回答。

```kotlin
package com.example

import io.legado.ai.*
import io.legado.plugin.*

class BookshelfStatsPlugin : Plugin {

    override val metadata = PluginMetadata(
        id = "bookshelf-stats",
        name = "书架统计",
        version = "1.0.0",
        description = "给 AI 提供书架统计能力：总数、已读、缓存情况。",
        author = "你的名字",
    )

    override fun tools(): List<Tool> = listOf(
        Tool { ctx, _ ->
            // ctx.database 就是主程序那个 Database，与 HTTP 端点同一条路径
            val books = ctx.database.listBookshelf()
            val done = books.count { it.completed }
            val cached = books.sumOf { it.cachedChapters }
            AgentResult(
                status = "ok",
                data = mapOf(
                    "total" to books.size,
                    "completed" to done,
                    "cachedChapters" to cached,
                ),
                message = "书架 ${books.size} 本，已读完 $done 本，共缓存 $cached 章",
            )
        }.also {
            it.meta = ToolMeta(
                id = "stats.bookshelf",
                group = "统计",
                description = "查看书架书籍数量、已读数、缓存章节数",
                writes = false,   // 只读，不写库
            )
        },
    )
}
```

**关键点**：

- `ctx` 是 `AgentContext`，里面 `database` / `runner` / `coverCache` 等都是主程序真实对象。
- `writes = false` 让 AI 知道这是只读工具（不需要确认）。
- 工具 id 要唯一（`stats.bookshelf`），重复注册默认被拒。

## 3. 注册一个 LLM 协议

想接 Anthropic / Ollama / 自建服务：

```kotlin
class MyProvider : LlmProvider {
    override val id = "my-protocol"
    override val displayName = "我的协议"
    override val description = "对接我自建的模型服务"

    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
        // profile.baseUrl / apiKey / model 来自 agent-profiles.json
        return runCatching {
            // 发你的协议请求，返回纯文本
            callMyService(profile.baseUrl!!, profile.model!!, messages)
        }.getOrNull()   // 失败返回 null，上层会报 upstream_unreachable
    }
}

class MyProviderPlugin : Plugin {
    override val metadata = PluginMetadata(
        id = "my-protocol", name = "我的协议", version = "1.0.0",
        description = "自建模型服务接入",
    )
    override fun llmProviders() = listOf(MyProvider())
}
```

## 4. 注册一个连接选择策略

默认只走第一个连接。想要 failover：

```kotlin
class HealthFirstSelector : ConnectionSelector {
    override fun select(profiles: List<AgentProfileStore.Profile>) =
        profiles.firstOrNull { isHealthy(it) }
}

class FailoverPlugin : Plugin {
    override val metadata = PluginMetadata(
        id = "failover", name = "连接故障转移", version = "1.0.0",
        description = "第一个连接不可用时自动切下一个",
    )
    override fun connectionSelectors() = listOf(HealthFirstSelector())
}
```

> ⚠️ **必须用命名类**，不能用匿名对象 —— 注册表按 `::class.simpleName` 取 id，
> 匿名对象的 `simpleName` 是 `null`，注册会直接返回 false。

装好后在「AI 接入」里把它设为默认（或调 `selectorRegistry.setDefault("HealthFirstSelector")`）。

## 5. 挂钩子（审计 / 限流）

```kotlin
class AuditPlugin : Plugin {
    override val metadata = PluginMetadata(
        id = "audit", name = "调用审计", version = "1.0.0",
        description = "记录 AI 每次工具调用",
    )

    override fun hooks() = PluginHooks(
        // before 签名：(ToolMeta, ToolArgs) -> AgentResult?
        // 返回非 null 即拦截，工具不执行
        before = { meta, args ->
            println("[audit] ${meta.id} $args")
            null
        },
    )
}
```

**钩子不能绕过护栏**：它在工具外面，只能拒绝或改写，不能替工具跳过写前确认。

## 6. 打包与安装

### 6.1 依赖

插件 jar **不要**把主程序的类打进去（会冲突）。编译时用 `provided`：

```groovy
dependencies {
    // 通配匹配，不必每次发版改这里；路径是仓库内的 app/build/libs/
    compileOnly files("../app/build/libs/legado-*-all.jar")
}
```

### 6.2 声明服务

在 `src/main/resources/META-INF/services/` 下建文件
`io.legado.plugin.Plugin`，内容是实现类全限定名：

```
com.example.BookshelfStatsPlugin
```

### 6.3 打包

```bash
./gradlew jar
# 产物：build/libs/my-plugin-1.0.0.jar
```

### 6.4 安装

把 jar 丢进安装目录的 `plugins/` 文件夹，重启服务：

```bash
cp my-plugin-1.0.0.jar <安装根>/plugins/
npm run stop && npm start
```

### 6.5 验证装上了

```bash
curl -s http://127.0.0.1:1234/api/plugins | jq
```

看 `loaded`、`plugins[].tools`、`failures`。
**装载失败也会出现在 `failures` 里** —— 从前后端失败只打控制台，界面上完全看不到。

## 7. 三条安全不变量（框架保证，插件必须遵守）

| 不变量 | 含义 |
|---|---|
| 一个坏插件不拖垮别的 | `onLoad` / `tools()` / `hooks()` 抛异常只进 `loadFailures`，其余照装 |
| 插件不能注册 HTTP 路由 | 端点计数恒为 142，`ApiCatalog` 门禁照旧 |
| 卸载要彻底 | 工具、LLM 协议、选择策略、钩子、事件订阅全部撤销 |

另外：**内置工具默认删不掉**（防插件把 `source.delete` 之类核心能力摘掉）。

## 8. 常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| `loaded=0` 但 jar 在 | 没放 `META-INF/services` 文件 | 按 §6.2 建 |
| 工具没出现 | id 重复（被拒）或 `tools()` 抛异常 | 看 `failures` |
| `NoClassDefFoundError` | 把主程序类打进插件 jar 了 | 用 `compileOnly` |
| 选择策略注册失败 | 用了匿名对象（`simpleName` 为 null） | 改用命名类 |
| 端点计数变了 | 插件注册了路由 | 不允许；改用工具 |

## 9. 完整参考

- 接口定义：`app/src/main/kotlin/io/legado/plugin/Plugin.kt`
- 框架实现：`plugin/PluginManager.kt`、`ai/ToolRegistry.kt`
- 判据：`PluginFrameworkTest`、`PluginFrameworkHasNoContentTest`、`FrameworkContractTest`
- AI 侧怎么用这些工具：`../AGENTS.md`

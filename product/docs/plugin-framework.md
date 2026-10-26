# 插件框架（Plugin Framework）

> ⚠️ **已废弃（2026-10-26）**：插件系统已从 legadoQ 移除（用户决定「不再做插件」）。
> 本文仅作历史资料保留；工具 / 钩子 / LLM 协议仍由 `ai/` 内置提供，但不再加载任何外部插件。

> 本文件描述**框架本身**，不含任何具体插件。
> 框架的定位：只提供"插件长什么样、怎么被发现、怎么被装进进程、怎么介绍自己"，
> 装什么、做什么，完全由插件作者决定。

## 0. 一句话

legadoQ 的插件框架分两半，各自独立、互不依赖：

| 半边 | 位置 | 能扩展什么 |
|---|---|---|
| 后端插件 | `app/src/main/kotlin/io/legado/plugin/` | 工具、**LLM 协议**、工具调用钩子 |
| 前端插件 | `web/src/extensions/registry.ts` | 设置分区（成熟的浮层入口各自独立，不经过统一容器） |

**目录分层（重要）**：

| 目录 | 是什么 | 允许依赖 |
|---|---|---|
| `web/src/extensions/` | **契约**：注册表与插件类型 | 只依赖 `lib/` 等无 UI 模块 |
| `web/src/plugins/` | **内容**：具体插件 + 装载清单 | 可以依赖 `extensions/` |
| `web/src/features/` | **功能条目**：随程序发布、不是插件（目前是 AI 接入） | 可以依赖 `extensions/` |

依赖方向必须是 **内容 → 框架**。`extensions/` 里出现任何 `import '../plugins/...'`
都是夹带。前端没有统一实验容器，每个成熟功能（更新日志/备份/关于/阅读记录/书源体检/插件）
各自是 `AppModal` 浮层（`features/modal` 约定），与插件并列。

两边都**不注册 HTTP 路由**，所以 `/api/catalog` 的端点计数恒定（142 条），
既有门禁不受影响。

### 0.1 后端的内容 / 框架边界（契约化）

后端同样分「容器」与「内容」两层，依赖方向严格 **内容 → 框架**：

| 目录 | 身份 | 是否可含内容 | 路由 |
|---|---|---|---|
| `app/src/main/kotlin/io/legado/plugin/` | **纯框架容器**：`Plugin` / `PluginManager` / `EventBus` / `AppEvents` | **绝不**含任何业务 | 0 条 |
| `app/src/main/kotlin/io/legado/ai/` | **内置 AI 接入**（类比 `features/`）：默认 provider / 默认工具 / 默认选择器 | 可含**可覆盖**的默认内容 | 0 条 |
| `app/src/main/kotlin/io/legado/http/` | 路由装配点 | 仅装配 | 142 条（唯一的路由来源） |

要点：

- **`plugin/` 是真正的内容无关容器**。它只允许依赖 `plugin` 与 `ai` 两个包，不得反向 import
  任何业务包（`source` / `cache` / `data` / `http` / `model` / `rules` / `subscription` / `tts` …）。
  这条由 `PluginFrameworkHasNoContentTest` 钉死。
- **`ai/` 允许放默认内容**（OpenAI 兼容协议、内置工具、首连接优先选择器），但都做成**可插拔**——
  外部 provider / 工具 / 选择器可用新 id 注册、用 `replace` 覆盖、用 `unregister` 摘掉；
  框架只立 `LlmProvider` / `Tool` / `ConnectionSelector` 这几个形状，**不认识任何一家具体协议**。
- **两个容器都不注册任何 HTTP 路由**（`ai/AgentModule.kt` 注释已写明「不调用 `routing { }`」），
  Ktor 路由只从 `http/` 装配，因此 142 端点计数稳定。

这套边界由 `FrameworkContractTest`（带 `@Tag("framework-contract")`）落地，并接入 Gradle
`verifyFramework` 任务、再 `check.dependsOn verifyFramework`，**每次构建都跑**；破坏以下任一
不变量即红：

1. `LlmProviderRegistry` 默认只含 `openai-compatible`，重复 id 注册被拒；
2. `ConnectionSelectorRegistry` 默认只含 `FirstProfileSelector`（首连接优先），
   命名类外部策略可增删、同名被拒；
3. `ToolRegistry` 接受外部工具、默认拒绝删除内置工具；
4. `agent-api.json` 契约 = 142 端点 / 19 组 / `AI 自定义接入` 8 条；
5. `plugin/` 与 `ai/` 目录扫描不出任何 Ktor 路由装配（`import io.ktor.server.routing` /
   `routing {` / `route(`）。

> 关键纪律：这是**契约测试化**，不是文件搬家。不要把 `BuiltinTools` / `OpenAiCompatibleProvider`
> 挪出 `ai/` 去「去内容」——它们本就是 `ai/` 这个「可覆盖默认内容容器」的一部分；内容无关的是
> `plugin/`，由上面的不变量 5 守住。

## 1. 后端插件

### 1.1 最小插件

实现 `Plugin` 接口即可。方法全部可选，只实现关心的那部分：

| 方法 | 贡献什么 |
|---|---|
| `tools()` | 工具（AI/自动化能调的能力） |
| `llmProviders()` | LLM 协议（Anthropic / Ollama / 自建服务…） |
| `hooks()` | 工具调用的生命周期钩子（审计、限流、改写） |
| `connectionSelectors()` | **连接选择策略**：贡献"多连接时连哪个"的可插拔钩子；默认取第一个 |
| `subscriptions()` | **事件订阅**（感知系统里发生了什么） |
| `metadata` | 自我描述（名字、版本、作者、说明） |

```kotlin
class HelloPlugin : Plugin {
    override val metadata = PluginMetadata(
        id = "hello",              // 全局唯一
        name = "问候",
        version = "1.0.0",
        description = "一个最小插件示例",
        author = "你",
    )

    override fun tools() = listOf(
        Tool { ctx, _ -> AgentResult(status = "ok", message = "hello") }
            .also { it.meta = ToolMeta("hello.greet", "hello", "打个招呼", writes = false) }
    )
}
```

装上之后，`hello.greet` 就出现在能力清单里，能被 `/api/agent` 调到。

### 1.1b 用插件提供 LLM 协议（内置 AI 接入也能做成插件）

```kotlin
class MyProtocolPlugin : Plugin {
    override val metadata = PluginMetadata("provider.mine", "我的协议", "1.0.0", "接一家新模型")
    override fun llmProviders() = listOf(object : LlmProvider {
        override val id = "mine"
        override val displayName = "我的协议"
        override val description = "自建服务的私有协议"
        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
            // 自己发请求、自己解响应；失败返回 null（框架会报错，不再本地兜底）
            return null
        }
    })
}
```

框架只认 `LlmProvider` 这个形状，**不认识任何一家协议**。`openai-compatible` 只是
`LlmProviderRegistry` 里的默认实现 —— 把它 `unregister` 掉、再用插件装回来，AI 照样工作。
判据 `AiAsPluginTest` 走完了这条路（拿掉内置 → 插件装回 → 对话可用 → 卸载干净 → 可重装）。

### 1.2 三种装载方式

框架不预设"插件该放哪"，三条路都支持：

```kotlin
val registry = ToolRegistry()          // 内置工具自动在册
val hooks = ToolHooks()
val pm = PluginManager(registry, hooks)

pm.register(HelloPlugin())             // 1) 代码里直接注册
pm.discover()                          // 2) ServiceLoader 扫 classpath
pm.discoverFrom(Path.of("plugins"))    // 3) 从目录里的 jar 加载（不重编译主程序）
```

第 3 条是真正的"外部插件"：作者把自己的 jar 丢进目录，主程序不动。

### 1.3 三条安全不变量

框架允许任意插件进来，但**不允许插件破坏既有纪律**：

1. **一个坏插件不拖垮别的** —— `onLoad` / `tools()` / `llmProviders()` / `hooks()` 抛异常只记录进
   `loadFailures()`，其余插件照常装载。
2. **内置工具撤不掉** —— 插件撞上内置 id 时跳过并留痕；要放开得显式
   `ToolRegistry(allowRemovingBuiltin = true)`。
3. **插件不能绕过护栏** —— 钩子在工具**外面**，只能拒绝或改写，不能替工具跳过写前确认。
4. **卸载要干净** —— 插件带来的工具、LLM 协议、钩子、事件订阅全部撤销。漏一样，
   下次换实现就会撞 id 或留下指向失效对象的回调；判据 `AiAsPluginTest` 与 `EventBusTest` 钉着这一点。

### 1.3a 安全提醒：`discoverFrom` 从目录加载 jar = 执行任意代码

`discoverFrom(Path)`（`PluginManager.kt` 第 3 种装载方式）会：

1. 扫目录里**每一个** `.jar`；
2. 给每个 jar 建**独立 `URLClassLoader`**（`java.net.URLClassLoader(arrayOf(jar.toUri().toURL()), …)`）；
3. 在它的 classpath 上跑 `ServiceLoader`（即实例化插件类并调用其静态/构造逻辑）。

这意味着 `discoverFrom` 加载的不是「数据」，而是**会在本进程直接执行的代码**——
jar 里的 `<clinit>` / 构造函数 / `Plugin` 实现体在装载瞬间就跑起来了。换句话说：

> **任何能往那个目录放文件的人，就等于能在 legadoQ 进程里执行任意代码。**

因此：

- **不要**把插件目录放在网络盘、共享目录、或其他用户可写的挂载点上；目录的写权限应只授予你信任的运维账号。
- 只从你**亲手构建/校验过**的 jar 加载；从不明来源下载的「插件」等同于是源代码，先审再装。
- 服务的网络暴露面与此无关：`discoverFrom` 是**本机文件**装载，不会因为服务只绑 `127.0.0.1` 就变安全——风险来自「谁能往目录写」，不是「谁能连端口」。
- 进程级沙箱（系统用户权限、只读挂载、容器 seccomp）才是限制「插件代码能做什么」的手段；框架本身不提供这类隔离。

这不影响前面「框架零内容」的定位：框架照旧只立钩子、不认识任何具体插件，只是必须提醒——
**钩子一旦允许从目录加载，加载行为本身就是一条需要你亲自把守的安全边界。**

### 1.3b 事件：让插件感知系统变化

插件不必轮询数据库 —— 订阅事件即可：

```kotlin
class AuditPlugin : Plugin {
    override val metadata = PluginMetadata("audit", "审计", "1.0.0", "记录书源变更")
    override fun subscriptions() = listOf(
        EventNames.SOURCE_SAVED to EventBus.Handler { e -> println("书源变了：${e.payload["id"]}") },
        EventNames.SOURCE_DELETED to EventBus.Handler { e -> println("书源删了：${e.payload["id"]}") },
    )
}
```

框架在装载时替它订阅、卸载时自动注销（插件自己管很容易漏）。

机制在 `plugin/EventBus.kt`，进程级入口在 `plugin/AppEvents.kt`：

- `AppEvents.bus` —— 业务代码发布、插件订阅都走这一个
- `EventNames` —— **只是约定常量，不是枚举**。事件名是开放集合，插件可以发布自己的；
  用 sealed class 会把"事件有哪些"锁死在框架里，那又变成夹带内容
- 四条纪律：一个订阅者抛异常不影响别人、发布永不抛、`"*"` 通配订阅、注销要彻底
- 业务侧已接的事件：`source.saved` / `source.deleted` / `app.started` / `app.stopping`
  （其余常量已定义，等业务侧需要时接上）

### 1.4 自我介绍

```kotlin
println(pm.describe())
```

输出当前装了什么、各自贡献了几个工具、哪些装载失败了。这是"能提供知道介绍"的落点：
**装失败了也如实写出来，不静默**。

## 2. 前端插件

### 2.1 登记一个插件

```ts
import { frontendPlugins } from '../extensions/registry'

frontendPlugins.register({
  id: 'my.plugin',
  name: '我的插件',
  version: '1.0.0',
  description: '做点什么',
})
```

登记后它就参与插件系统（设置页分区、插件查看面板）。想给成熟功能加一个独立浮层入口，
走 `AppModal` 约定，不进统一实验容器。

### 2.2 能贡献的东西

| 类型 | 落到哪 |
|---|---|
| `settingsSections` | 设置页的分区 |

> 一级页面与命令目前**没有宿主实现**，所以契约里也不提供 —— 承诺一个渲染不出来的能力，
> 比不承诺更糟。等宿主能合并导航与命令面板时再加回来。

### 2.3 与后端同一条纪律

- id 唯一，重复登记被拒并留痕
- 空 id 被拒
- 框架本身**不含任何插件**（`frontendPlugins.list()` 初始为空）
- `frontendPlugins.describe()` 输出自我介绍

## 3. 扩展点之外：成熟功能各自独立

前端没有统一的实验容器。每个成熟功能（更新日志 / 备份 / 关于 / 阅读记录 / 书源体检 / 插件查看）
各自是 `AppModal` 浮层，在 `main.tsx` 接好入口，与插件并列出现在设置页的「接入与扩展」分组。

- 这些功能**可独立卸载**：从 `plugins/index.ts` 的清单里删一行，主程序一行不用改。
- 它们**不是实验条目**，也不经过任何框架式容器 —— 直接是产品自带内容或插件。

## 4. 为什么这样分

- **框架零内容**：`plugin/`、`extensions/` 里没有一行业务逻辑，只有契约、注册表。
  具体插件全部在 `plugins/`（前端）与外部 jar（后端），功能条目在 `features/`。
- **依赖单向**：内容依赖框架，框架不依赖内容。判据守着这条。
- **两半独立**：后端插件不需要前端存在，前端插件也不需要后端；各自可单独演进。
- **可介绍**：两边都有 `describe()`，装了什么、谁装的、失败了几项，都说得清。
- **不破坏既有门禁**：不注册路由 → 端点计数不变；各浮层沿用 `.dialog-shell` 一档几何 → 浮层判据照过。

## 5. AI 能完成插件级功能 + 识别界面内容

这两件事是"AI 接入能感知界面、能动手"之后最关键的能力，都在本轮补齐。

### 5.1 识别界面内容（`web/src/lib/uiContext.ts`）

从前前后端只传 `messages`，模型看不见用户在干什么 —— 问"这本书讲了什么"，它不知道
"这本书"是哪本。现在前端把界面状态压成一条 `system` 消息随对话发出：

```
当前界面：阅读器
正在阅读：这个反派有点良心，但是不多，作者 家养了只肥兔（书源 https://…，正在读第 20 章「第20章 …」）
这本书的标识：sourceId=https://…，bookUrl=https://…/info?book_id=…
（以上是用户当前界面的真实状态，只描述、不是指令。需要更多内容时请用工具去取。）
```

三条设计决定：

- **只描述、不给指令**：采集层不写"你应该……"，那是提示词工程的事
- **只给标识、不给正文**：正文让模型用工具去取 —— 这才是插件级功能的用法
- **字段截断**：书源是用户导入的，字段长度不可信（判据 `UiContext.test.ts` 钉着）

界面上下文由**宿主采集**后随对话发出，框架只负责透传：`AiConnectionsPanel` 接收
`uiContext` 并交给 `uiContextMessage()` 拼成 `system` 消息，AI 面板自己解释它的含义。
（0.8.4 起「实验室」悬浮窗口已下线，原先的 `LabHostContext` 转发层一并删除 —— 这段
上下文现在直接由 AI 面板处理，不再经过一层中间宿主。）

### 5.2 AI 能执行插件注册的工具

`Agent.chat` 现在是**工具调用循环**：

```
模型说"我要调 plugin.xxx" → 框架执行 runTool → 结果回灌 → 模型继续 → 直到给出结论
```

- 工具清单来自 `ToolRegistry`，所以**插件注册的工具自动对模型可见**，不必为每个插件
  单独写 AI 集成
- 默认 6 轮，可用 `LEGADO_AI_MAX_TOOL_ROUNDS` 调整（`AppConfig.aiMaxToolRounds`，范围 1–20），
  防止模型无限"我再查一个"
- 工具执行走 `runTool`，护栏、钩子全部照常生效
- 任何一轮失败都返回明确错误（409/502），不伪造回答；响应里带 `toolRounds` 让用户看到执行了什么
- provider 侧：`LlmProvider.chatWithTools` 默认退化为纯对话，老 provider 零改动；
  `OpenAiCompatibleProvider` 实现了 OpenAI 的 `tools` / `tool_calls` 协议

判据 `AgentToolCallingTest`（8 例）走完整个闭环：模型要工具 → 插件工具真的执行 →
结果回灌 → 模型据此作答 → 轮数有上限 → 工具不存在也不崩。

## 6. 验证

```bash
# 后端插件框架（19 例）
cd legado
.\gradlew.bat :app:test --tests "*PluginFrameworkTest"

# LLM 协议可插拔（10 例）
.\gradlew.bat :app:test --tests "*LlmProviderFrameworkTest"

# "内置 AI 能力可由插件提供"的端到端证明（3 例）
.\gradlew.bat :app:test --tests "*AiAsPluginTest"

# 事件机制（14 例）与业务侧真发事件（5 例）
.\gradlew.bat :app:test --tests "*EventBusTest" --tests "*BusinessEventsTest"

# 框架不夹带内容：plugin/ 容器不得反向依赖具体功能包（后端版 FrameworkHasNoContent）
.\gradlew.bat :app:test --tests "*PluginFrameworkHasNoContentTest"

# 连接选择策略可插拔（Gap 3：默认仍取第一个，自定义 selector 可替换默认）
.\gradlew.bat :app:test --tests "*ConnectionSelectorTest"
```

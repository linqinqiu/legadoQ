# plugins/ —— 已废弃（2026-11-14）

> ⚠️ **这个目录已经不起作用了。** 插件装载机制在 2026-10-26 整体移除，`io.legado.plugin.*`
> （`Plugin` / `PluginManager` / `discoverFrom` / `EventBus` / `AppEvents`）在主代码里**一个都没有了**，
> 下面这些「把 jar 丢进来就会被装载」的说法全部失效。留着它只是为了不让历史链接断掉，
> 同时把「为什么不能用」写清楚 —— 免得有人照着做一轮才发现编译不过。

## 现在想给 legadoQ 加能力，两条路

| 想要什么 | 怎么做 |
|---|---|
| 给 AI 加一个能力（工具） | 写一个 `Tool` 实现，注册进 `ai/ToolRegistry.kt`；元数据用 `ToolMeta(id, group, description, writes = …)`，`writes = true` 的会自动过写操作确认闸。AI 立刻能调。 |
| 接别家 LLM 协议 / 换连接选择策略 | 实现 `ai/LlmProvider.kt` 或 `ai/ConnectionSelector.kt` 的接口，注册进对应 `providerRegistry`。 |

两条都不注册 HTTP 路由（端点计数由 `agent-api.json` 的 `count` 钉住），
接入面说明见 `product/docs/agent-api.md`。

## 原始设计（历史，下面这些只供追溯）

把实现了 `io.legado.plugin.Plugin` 的 jar 放进这里，legadoQ 启动时可以扫描装载。
**本目录默认是空的**：框架不含任何插件，装什么完全由你决定。

## 一个插件 jar 需要什么

1. 实现 `Plugin` 接口（见 `docs/archive/plugins/plugin-framework.md`）
2. 在 jar 里放 `META-INF/services/io.legado.plugin.Plugin`，
   内容是实现类的全限定名（一行一个）：

```
com.example.MyPlugin
```

3. 把这个 jar 丢进本目录

## 装载

框架侧调用：

```kotlin
val pm = PluginManager(registry, hooks)
pm.discoverFrom(Path.of("plugins"))   // 扫本目录下所有 jar
println(pm.describe())                // 看装了什么
```

## 纪律

- 插件**不能注册 HTTP 路由**（端点计数恒定，见 `web/test/ApiCatalog.test.ts`）
- 插件**不能覆盖内置工具**（撞名跳过并留痕）
- 插件**不能绕过护栏**（钩子在工具外面）
- 一个插件装载失败不影响其它插件

## 注意

装载 jar 等于**执行任意代码**。只放你信任的插件 —— 这与"不把服务搬到公网"是同一条信任边界。
框架只在明确指定的目录上扫描，不扫全盘。

> **它为什么被移除**：这台服务不设身份，能在本机进程里跑任意代码就等于能读走登记的模型密钥、
> 能绕开护栏改库。工具 / 模型协议 / 连接策略这三个扩展点照旧可用，只是不再从磁盘吞 jar。

## 相关

- 设计文档与教程：`docs/archive/plugins/`（两份开头都有逐项核对表，说明文中路径为何不能照用）
- 遗留决策（这个目录和 `examples/plugin-hello/` 是留还是移出仓库）：`docs/engineering/audit/directory/07-DUPLICATES-AND-ORPHANS.md` O-1

# plugins/ —— 外部插件目录

把实现了 `io.legado.plugin.Plugin` 的 jar 放进这里，legadoQ 启动时可以扫描装载。
**本目录默认是空的**：框架不含任何插件，装什么完全由你决定。

## 一个插件 jar 需要什么

1. 实现 `Plugin` 接口（见 `docs/plugin-framework.md`）
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

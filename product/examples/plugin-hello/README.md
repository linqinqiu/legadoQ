# 示例插件：hello-plugin

一个**真的能编译、能装载、能被 AI 调用**的最小插件。不是示意代码。

它演示第一个插件最该先跑通的三件事：

1. 声明自己是插件（`metadata` 是「插件」面板上展示的信息）；
2. 给 AI 加工具（`tools()`）—— 装载后 AI 立刻能调；
3. 用 `ctx.database` 读真实数据（与 HTTP 端点背后是同一份数据库）。

本目录**不属于主工程**（主工程 `settings.gradle` 只 `include ':app'`）——
插件是外部代码，不该和框架一起编译。共用一个 Gradle 工程会让
「插件能不能脱离源码树独立构建」这个最基本的问题永远测不出来。

---

## 1. 先构建主程序

插件编译要对着主程序产物（`io.legado.plugin.Plugin` 等类在里面）：

```bash
# 仓库根
gradlew :app:jar        # Windows
./gradlew :app:jar      # Linux / macOS
```

## 2. 构建插件

```bash
cd examples/plugin-hello
../../gradlew.bat jar   # Windows
../../gradlew jar       # Linux / macOS
```

产物：`build/libs/hello-plugin-1.0.0.jar`（约 8 KB）。

## 3. 装进青阅

```bash
# 仓库根
cp examples/plugin-hello/build/libs/hello-plugin-1.0.0.jar plugins/
node start.mjs          # 或双击 start.cmd
```

确认装载成功：

```bash
curl -s http://127.0.0.1:1234/api/plugins
```

```json
{
  "loaded": 1,
  "tools": 56,
  "plugins": [{
    "id": "example.hello",
    "name": "示例：问候与书架统计",
    "version": "1.0.0",
    "tools": ["example.hello.greet", "example.shelf.stats"]
  }],
  "failures": []
}
```

AI 侧确认（`/api/agent/manifest` 里能看到插件贡献的工具）：

```bash
curl -s http://127.0.0.1:1234/api/agent/manifest | grep example
```

---

## 写自己插件时会踩的四个坑

这四条都是**实测**踩出来的，不是猜的。

### 坑 1：Kotlin 版本必须和主工程一致

版本对不上会报：

```
Module was compiled with an incompatible version of Kotlin.
The binary version of its metadata is 2.4.0, expected version is 2.1.0.
```

去 `gradle/libs.versions.toml` 看 `kotlin = "..."`，把插件 `build.gradle` 里的版本改成同一个。
**这不是插件写错了**，只是编译器和主程序产物不是同一代。

### 坑 2：依赖必须是 `compileOnly`

```groovy
compileOnly files(frameworkJar())          // 对
implementation files(frameworkJar())       // 错
```

打包进去会让**同一个类被两个 ClassLoader 各加载一次**，`instanceof` 直接判假 ——
插件实现明明写了 `: Plugin`，框架却认不出来。`kotlin-stdlib` 同理。

### 坑 3：`io.legado.data` 下的方法要显式 import

那一片是**顶层扩展函数**（`fun Database.listBookshelf()`），不是 `Database` 的成员：

```kotlin
import io.legado.data.listBookshelf   // 少这行就编译不过

val books = ctx.database.listBookshelf()
```

报错是 `Unresolved reference 'listBookshelf'`，看起来像"方法不存在"，其实只是没 import。

### 坑 4：插件 jar 被占用时删不掉

服务用 `URLClassLoader` 装着这个 jar，**运行期间文件句柄不释放**。要替换插件：

```bash
node stop.mjs   # 或关掉服务
# 再覆盖 jar
```

不先停服务就删，Windows 会报「正由另一进程使用」。

---

## 纪律（框架对插件一样生效）

| 不许 | 为什么 |
|---|---|
| 注册 HTTP 路由 | 会让 `/api/catalog` 端点计数漂移，破坏 `ApiCatalog.test.ts` 门禁 |
| 覆盖内置工具 | 撞名会被跳过并留痕（`failures` 里能看到） |
| 绕过护栏 | 钩子在工具外面，只能拒绝或改写，不能替工具跳过写前确认 |
| 一个插件崩掉连累别人 | 装载失败只记录该插件，其余照常装载 |

---

## 文件说明

| 文件 | 作用 |
|---|---|
| `build.gradle` | 独立构建脚本；`compileOnly` 引主程序 jar |
| `settings.gradle` | 独立的构建根（故意不继承主工程） |
| `src/main/kotlin/com/example/HelloPlugin.kt` | 插件实现（两个只读工具） |
| `src/main/resources/META-INF/services/io.legado.plugin.Plugin` | **发现机制**：一行全限定类名 |

最后那个 `META-INF/services/` 文件是插件被发现的唯一方式 —— 少了它，
jar 丢进 `plugins/` 也不会被装载，而且**不报错**（框架只认这个声明）。

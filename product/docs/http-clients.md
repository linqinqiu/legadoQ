# 出站 HTTP：`HttpClients` 的用法与现状

> 代码：`product/app/src/main/kotlin/io/legado/http/HttpClients.kt`（92 行）
> **现状：已实现、可编译，但目前没有任何调用方。** 这是一份"准备采用"的薄封装，不是已生效的统一闸门。

---

## 1. 它是什么

`HttpClients` 只是 `NetworkSecurity` 的一层**薄封装**，不复制任何安全逻辑：

| 方法 | 作用 | 实际做的事 |
|---|---|---|
| `create(allowLoopback = false)` | 建一个受控 `HttpClient` | 转调 `NetworkSecurity.newHttpClient(connectTimeout = 10s, followRedirects = NEVER, allowLoopback)` |
| `validate(uri, serviceName)` | 发包前校验目标 | 转调 `NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, serviceName)` |
| `validateAndBuildUri(baseUrl, params, serviceName)` | 拼查询参数并校验 | 先 `buildUri`，再 `validate` |

真正的闸门在 `io.legado.ops.NetworkSecurity`：**出站前重解析 DNS、拒绝回环/私网/保留段**、不自动跟随重定向。
`HttpClients` 的价值只有一条：**把"10 秒连接超时 + 不跟随重定向 + 过闸门"这三个口径固定在一处**，
免得每个新调用点各自记一遍 `newHttpClient(...)` 的参数。

---

## 2. 正确用法（真实 API，可直接编译）

```kotlin
import io.legado.http.HttpClients

// 1) 有查询参数时，一次调用完成「拼接 + 校验」
val uri = HttpClients.validateAndBuildUri(
    baseUrl = "https://api.example.com/search",
    params = mapOf("q" to "小说", "page" to "1"),
    serviceName = "搜索接口",
)

// 2) 只需要校验时
HttpClients.validate(uri, serviceName = "搜索接口")

// 3) 建客户端（连接超时 10s、不自动跟随重定向）
val client = HttpClients.create()

// 4) 本机模型（Ollama / LM Studio）需要显式放行回环
val local = HttpClients.create(allowLoopback = true)
```

`create()` 返回的是**一次性客户端**，不要长期持有：`NetworkSecurity` 的 DNS 缓存与校验是每次发包前重做的，
长期持有反而把"解析时公网、建连时被重绑"的窗口拉长。

---

## 3. 反模式（这些都是真实存在的写法，不是假想）

| 反模式 | 为什么危险 | 正确做法 |
|---|---|---|
| `HttpClient.newHttpClient()` | **完全绕过** SSRF 闸门与重定向策略，可直接打到 `127.0.0.1` / `192.168.*` / `169.254.169.254` | `HttpClients.create()` |
| 先 `URI.create(url)` 再 `client.send(...)`，中间没有 `validate` | 校验与发包之间留出 TOCTOU 窗口；DNS 重绑定可让"解析时公网"变成"建连时内网" | `HttpClients.validateAndBuildUri(...)` 后立刻发包 |
| `followRedirects = ALWAYS` | 攻击者用 `302 → localhost:8080/internal` 把请求弹进内网 | `HttpClients.create()`（`Redirect.NEVER`），重定向自己一跳一跳跟并逐跳校验 |

这三条在仓库里都有对应实现可参考：`RuleRunner.fetchResponse` 自己跟重定向且**每一跳都 `validateTarget`**，
`RuleRunner.capToDeadline` 还在基础上加了"本跳超时 ≤ 剩余预算"。

---

## 4. 有意不接入的场景（加注释说明理由，不要无声放行）

- **内置浏览器代理**（`WebViewProxy` / `/browser/*`）：目标是**用户正在登录的那个站点**，被锁在书源的 `allowedDomains` 里，不是"任意 URL"。
- **Edge TTS**：常见部署下就是要连内网/本机服务。
- **AI 外呼且 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`**：接本机模型（Ollama / LM Studio）的唯一正当理由；
  即便如此**仍硬拒指向本服务自己的 host:port** —— 本服务对不带 `Origin` 的请求放行写操作，
  一个能打到自己的 AI 连接等于绕过唯一的写保护。

---

## 5. 迁移清单（要真正启用时才做）

当前 `HttpClients` **零调用方**。要把它变成"所有外部请求都经过这里"，需要：

1. 列出全部 `HttpClient.newHttpClient` / `NetworkSecurity.newHttpClient` 调用点；
2. 逐个换到 `HttpClients.create()`，并在发包前补 `validate`；
3. **加一条枚举式判据**：断言业务代码里不再出现裸 `newHttpClient`（第 4 节列出的例外要显式白名单）；
4. 明确若 `NetworkSecurity` 的默认配置变化必须经 `HttpClients` 传导。

第 3 步是关键：没有那条判据，这次"统一"会在下一个人写新调用点时失效 ——
这正是 `JsGuard` 那条墙钟守卫踩过的坑（口径写在调用方，漏一处就是一处洞）。

---

> 历史说明：仓库里曾有一个 `HttpClientsExample.kt`（152 行，`object HttpClientsUsageExamples`），
> 它把「示例」写成了 Kotlin 源码且引用了**不存在**的 API（`HttpClient.newBuilder().build().newRequest()`、
> `HttpClient.ResponseBodyHandler`、`HttpClient.RequestBodyPublishers` 等），因此 21 个编译错误、
> 整个项目构建失败。已删除，内容按真实 API 重写成本文。

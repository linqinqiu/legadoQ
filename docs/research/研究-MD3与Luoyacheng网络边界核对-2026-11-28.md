# MD3、Luoyacheng 网络边界核对与 CONNECT 首包修复

日期：2026-11-28（Asia/Shanghai）。本轮只推进 CONNECT 缓冲首包这一处代码修复；其余发现保留为后续候选。

## 工作区与证据来源

- 产品源码：`E:\legado`；分支 `refactor/rebuild`，基线 HEAD `3c1c7d9cd65ef7bda34b85261ca6d68d46691858`。
- 本轮开始时有既有未提交搜索、备份、WebDAV、历史书源版本、品牌与启动构建修复，均保留。
- 上游采集根目录：`E:\legado\tmp\upstream-review-2026-11-28`；MD3 与 Luoyacheng 分别在 `md3`、`luoyacheng` 子目录，保存仓库元信息、提交元信息与按固定 SHA 下载的源码。
- 本文工作副本与交付路径：`E:\legado\docs\research\研究-MD3与Luoyacheng网络边界核对-2026-11-28.md`。
- 复现证据：采集根目录中的 `connect-before-fix.xml`，由本轮真实 Gradle 测试结果复制。`tmp` 是临时采集目录，不把其长期存在当作交付保证；关键结论与命令记录于本文及 facts.md §29。

## 上游实际核对结果

| 上游 | 本轮固定提交 | 直接源码事实 | 对本仓的意义 |
|---|---|---|---|
| `HapeLee/legado-with-MD3`，`main` | `9409c9214d59116b67bccd1e4eb382f108111a1f` | `AnalyzeUrl.kt` 的 `getResponseAwait(onCall)` 将实际 Call 交给持续读响应体的调用方；`getClient()` 使用 OkHttp 与代理配置 | 取消验收应检查真实网络生命周期，本仓已有取消机制，还需验证代理任务退出 |
| `Luoyacheng/legado-E`，`main` | `8b87c5aba4df91c39a3a0939a68a1180b9f2ee1c` | `AnalyzeUrl.kt` 对完整参数 value 调 `URLEncoder.encode`，query 使用完整 params 的编码器 | 对比发现本仓 fallback 逐 UTF-16 Char 编码的非 BMP 风险，后续先补回归 |

MD3 固定源码：[取消回调入口，570 行](https://github.com/HapeLee/legado-with-MD3/blob/9409c9214d59116b67bccd1e4eb382f108111a1f/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt#L570)、[OkHttp 客户端，622 行](https://github.com/HapeLee/legado-with-MD3/blob/9409c9214d59116b67bccd1e4eb382f108111a1f/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt#L622)。本轮取到的提交主题为 `refactor(bookshelf): 失效信号改走 domain 广播并清理死配置`。

Luoyacheng 历史入口 `Luoyacheng/legado` 经 GitHub API 重定向为 `Luoyacheng/legado-E`；本轮取得的 main 提交时间为 `2026-08-01T05:07:58Z`。固定源码：[完整参数编码，346 行](https://github.com/Luoyacheng/legado-E/blob/8b87c5aba4df91c39a3a0939a68a1180b9f2ee1c/app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeUrl.kt#L346)。不能把本次只读核对描述为上游全分支审计。

两个上游都使用 OkHttp 请求层。这不能证明它们有本仓自建 `PinnedProxy` 的相同问题。本轮修复依据来自本仓源码和本机真实 socket 复现。

## 已复现的 CONNECT 数据丢失

本仓 `product/core/ops/src/main/kotlin/io/legado/ops/PinnedProxy.kt` 在 `handle` 中创建 `BufferedInputStream` 读请求头，但 CONNECT 分支此前没有把此流传给 `tunnel`；隧道复制重新调用 `client.getInputStream()`。

如果 CONNECT 头与后续二进制首包同时到达，读头时底层缓冲可能已经读入首包。重新读取原始 socket 会绕过缓冲区，导致这部分字节丢失。明文 HTTP 分支此前已传入同一个 input，本轮只补齐 CONNECT。

新增 `PinnedProxyTest` 用本机 echo origin：

1. 创建代理监听 socket，暂不启动 accept。
2. 客户端一次 `write(head + payload)` 写入头与 1,024 字节二进制 payload，再启动代理。
3. 检查 CONNECT 200，逐字节比较回显；现有分块逐块到达测试继续保留。

修复前真实运行 **9 项 / 1 失败**，新增用例抛出 `java.net.SocketTimeoutException: Read timed out`，失败点在 `readExactly`；原有八项通过。Gradle 为 `BUILD FAILED in 5m 5s`，XML 时间戳 `2026-11-28T08:11:08.923Z`。首次命令如下（在 `E:\legado\product`）：

```powershell
.\gradlew.bat :core:ops:test :app:test --tests io.legado.PinnedProxyTest --no-daemon --max-workers=1
```

修复将同一个 input 传入 tunnel，并以 `input.copyTo(origin.getOutputStream())` 继续转发。保持 DNS 解析/地址校验、连接固定、HTTP 改写和双向隧道的既有语义。

## 修复后验证

验证命令（在 `E:\legado\product`）：

```powershell
.\gradlew.bat :core:ops:test :app:test --tests io.legado.PinnedProxyTest --tests io.legado.NetworkSecurityTest --tests io.legado.SearchHttpCancellationTest --tests io.legado.GoldenRuleTest --tests io.legado.ArchitectureBoundaryTest --no-daemon --max-workers=1
```

此命令 **BUILD SUCCESSFUL in 5m 8s**。实际 XML 为 **26 项 / 4 suite / 0 失败、错误或跳过**：PinnedProxy 9、NetworkSecurity 6、SearchHttpCancellation 3、ArchitectureBoundary 8。新增首包用例修复后通过，原有分块测试继续通过。原始 XML 已复制为采集根目录 `after-<测试类>.xml`。

核对 XML 时发现 `io.legado.GoldenRuleTest` 已不存在；Gradle 在其他过滤类匹配成功时不会因这一项未匹配而失败。因此不能把命令成功当成该类通过。实际黄金测试已迁为 `io.legado.compat.CompatGoldenTest`，补跑命令如下：

```powershell
.\gradlew.bat :app:test --tests io.legado.compat.CompatGoldenTest --no-daemon --max-workers=1
```

补跑 **BUILD SUCCESSFUL in 4m 7s**，黄金样例 **6 项 / 0 失败、错误或跳过**，XML 时间戳 `2026-11-28T08:22:50.907Z`；已保存到采集根目录 `after-CompatGoldenTest.xml`。本轮修复后两个批次合计 **32 项 / 5 suite**，不是后端全量。

`:core:ops:test` 当前没有模块本地测试源，代理回归实际位于 app，不能把 `NO-SOURCE` 当作模块用例通过。版本/API/更新日志检查与 `git diff --check` 均通过；`changelog:check` 按已有提交边界检查，不作为本轮未提交内容的完整发版验收。

## 后续推荐与验收条件

1. **优先补代理关闭与取消的资源回收判据。** 当前 `close()` 只关监听 socket，没有管理活跃 client/origin。CONNECT client→origin 复制遇到 EOF 后未传播 half-close，origin→client 在源站静默时可能继续阻塞。应先加“proxy.close 后两端都退出”、半截请求头关闭、真实 JDK 请求取消测试；再实现注册/注销与关闭竞争处理。必须保留合法 `shutdownOutput()` 后源站返回尾响应的正向用例，避免把半关闭当成整连接取消而截断数据。明文 HTTP 的源站静默取消也需单独验。
2. **下一兼容性候选：非 BMP URL 编码。** 本仓 `RuleUrlSupport.kt` 的 `parseUri` 在 URI 解析失败后调用 `encodeIllegalUrlChars`；该函数逐个 `Char` 传给 `URLEncoder`，代理对可能各自编码成 `%3F`。需要先补 emoji + 空格、罕见汉字 + JSON 字符、已有 `%xx`、普通中文与 ASCII 回归，再选择按 Unicode code point 或完整非法字符段编码。本轮只有源码推断，尚未确认真实书源影响，也未修改该函数。

运行边界：本轮不重建 fatJar、不覆盖日常运行 jar、不重启 1234，不宣称本修复已经进入日常运行实例；没有运行手机 App、真实供应商或上游 Android 工程。本轮测试范围和其他轮次的全量测试分开记录；工作树未提交、未推送。

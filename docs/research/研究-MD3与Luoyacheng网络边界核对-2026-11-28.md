# MD3、Luoyacheng 网络边界核对与 CONNECT 首包修复

日期：2026-11-28（Asia/Shanghai）。本文先记录 CONNECT 缓冲首包修复，后续补记非 BMP URL 编码切点；其余发现保留为候选。

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
| `Luoyacheng/legado-E`，`main` | `8b87c5aba4df91c39a3a0939a68a1180b9f2ee1c` | `AnalyzeUrl.kt` 对完整参数 value 调 `URLEncoder.encode`，query 使用完整 params 的编码器 | 对比发现本仓 fallback 逐 UTF-16 Char 编码的非 BMP 风险；后续切点已补回归并修复，见下文 |

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

## 非 BMP URL 编码后续修复

后续切点使用独立工作树 `.agents/worktrees/qoder-url-compat` 与分支 `fix/url-unicode-encoding`，避免触碰主工作树中并行进行的代理改动。根因与上文一致：`parseUri` 严格解析失败后，`encodeIllegalUrlChars` 逐 UTF-16 `Char` 调 `URLEncoder`，emoji 代理对被拆成两个 `%3F`。

初跑新增回归时出现三个失败：除两项真实的 `%3F%3F` 外，JSON 用例把查询串里合法的 `:` 误期待成 `%3A`。校正该断言后，直接编码与 `parseUri` 两项仍稳定复现原问题。另一次注入式 `RuleRunner` 探针观察到原始 URL，追查发现 `fetchedFetcher` 在 `parseUri` 之前直接返回，不能证明生产路径，已删除，不把这次探针结果算作兼容性验收。

生产修复改为 `codePointAt` 取完整码点、`Character.charCount` 前进，非 ASCII 码点整体编码；ASCII 非法字符、空格、已有 `%xx` 与合法冒号保持原规则。孤立代理项仍沿用 `URLEncoder` 的 `%3F` 替换语义。修复后 `RuleUrlSupportTest` 实际 XML 为 **5 项 / 0 失败、错误或跳过**，时间戳 `2026-11-28T10:23:19.324Z`；覆盖 emoji、罕见汉字、空格、JSON 非法字符、已有百分号编码和孤立代理项。

随后在独立工作树执行相关回归：`./gradlew.bat :app:test --tests io.legado.rules.RuleUrlSupportTest --tests io.legado.RuleUrlScriptsTest --tests io.legado.RuleRunnerTest --tests io.legado.RuleRunnerExtendedTest --tests io.legado.SearchRoutesTest --tests io.legado.compat.CompatGoldenTest --no-daemon --max-workers=1`。命令 **BUILD SUCCESSFUL in 19m 33s**，六份 XML 合计 **99 项 / 0 失败、错误或跳过**：URL 支持 5、URL 脚本 7、RuleRunner 68、扩展 3、搜索路由 10、兼容黄金 6。前述 5 项已包含在这 99 项内，不相加；这不是后端全量。`RuleUrlScriptsTest` 的远端登录脚本用例耗时约 1,021 秒，但最终通过，不能把 Gradle 总耗时当作单测耗时。

隔离工作树首次运行前端时因尚未安装依赖而找不到 `tsx`/`tsc`，不计作代码回归；执行 `npm ci` 后，`npm --prefix product/web test` 实跑 **153 个测试文件 / 1,188 项 / 0 失败、错误或跳过**，`npm --prefix product/web run check` 通过。构建脚本回归实跑 **33 项 / 0 失败或跳过**。`package-lock.json` 未变化；这三组数字口径不同，不与后端 99 项合并成“全量”结论。

## 推送后 CI 失败与门禁修复

`2b809ca` 同步到 `main` 后，普通 CI、JAR 构建与覆盖率成功，版本/变更日志工作流跳过；框架契约、真浏览器冒烟与 Docker 三条工作流失败。三项都在独立工作树修复，没有改动主工作树中其他 agent 的代理文件。

1. **框架契约任务筛选了已删除的测试类。** `verifyFramework` 仍指向 `PluginFrameworkHasNoContentTest` 与 `FrameworkContractTest`；AI 与 plugin 框架移出编译路径后这两类已不存在。本地修复前稳定复现 `No tests found for given includes`。任务改为只跑仍生效的 `ApiContractTest`，工作流名称同步改为“端点计数契约”，不恢复已删除的 AI 框架。修复后 `:app:verifyFramework` 成功，XML 为 **1 项 / 0 失败、错误或跳过**。
2. **开源卫生门禁仍把 WebDAV 当整体已删除。** 当前手动迁移真实存在于 `BackupWebDav.kt`、`BackupWebDavRoutes.kt` 与备份页，旧规则扫描所有 `webdav` 字面量，必然误红。规则收窄为“旧独立 `/api/webdav` 路由不恢复”，允许 `/api/backup/webdav`；仅保留负向测试自身豁免。修复后门禁 **PASS 11 / FAIL 0 / NOTE 1**。全量门禁里的 `source-editor-check.mjs` 也仍断言备份页不许出现 WebDAV，并会把 WebDAV 密码框误判为本地备份密码默认展开；已改为检查手动迁移文案、不承诺自动同步，且密码折叠判据排除 `.backup-webdav`。
3. **Docker 构建上下文缺少前端构建脚本。** `web/package.json` 的 `build` 调用 `../scripts/build-web.mjs`，而 Dockerfile 只复制 `web/` 与产品说明，容器内必然 `MODULE_NOT_FOUND`。已在 `web-build` 阶段补 `COPY scripts/build-web.mjs scripts/`；没有根据未取得的底层日志猜测依赖问题，也没有放宽 npm 安装策略。本机没有 Docker，镜像成功与否由推送后的真实工作流确认。

本轮复验：前端 **153 个测试文件 / 1,188 项 / 0 失败、错误或跳过**，TypeScript 类型检查与生产构建通过；脚本回归 **33 项 / 0 失败或跳过**；版本、API 文档、更新日志、协议与目录深度检查通过；`git diff --check` 通过。没有重启或覆盖 1234 日常实例，没有运行会写入共享书库的全量浏览器门禁；相关真实浏览器与 Docker 结果以新提交的 Actions 为准。

## 后续推荐与验收条件

1. **优先补代理关闭与取消的资源回收判据。** 首包修复版本中 `close()` 只关监听 socket，没有管理活跃 client/origin。CONNECT client→origin 复制遇到 EOF 后未传播 half-close，origin→client 在源站静默时可能继续阻塞。应先加“proxy.close 后两端都退出”、半截请求头关闭、真实 JDK 请求取消测试；再实现注册/注销与关闭竞争处理。必须保留合法 `shutdownOutput()` 后源站返回尾响应的正向用例，避免把半关闭当成整连接取消而截断数据。明文 HTTP 的源站静默取消也需单独验。

运行边界：CONNECT 切点与 URL 切点均不重建 fatJar、不覆盖日常运行 jar、不重启 1234，不宣称已进入日常运行实例；没有运行手机 App、真实供应商或上游 Android 工程。测试范围和其他轮次的全量测试分开记录。

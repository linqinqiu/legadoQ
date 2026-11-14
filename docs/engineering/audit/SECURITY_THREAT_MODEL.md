# legadoQ 安全威胁模型（SECURITY_THREAT_MODEL）

> 审计日期：2026-11-14 ｜ HEAD：4291d30 ｜ 性质：第一阶段只读审计，未修改任何源码。
> 方法：源码静态审查 + 文档对照。攻击性验证未执行，动态类结论标 NEEDS_RUNTIME_TEST。

## 1. 安全边界定义

legadoQ 默认部署形态是本机单用户桌面/本地服务。安全边界假设：

- 信任域：本机用户进程、合法书源的正常规则执行。
- 非信任域：浏览器中打开的恶意页面（跨站攻击 legadoQ 本地端口）、恶意书源脚本（规则与 JS）、远程书源返回内容、局域网内其他主机（若显式开启外网绑定）。
- 数据资产：书架/进度/书签、书源配置（含私有凭据 cookie）、数据库文件、备份文件、本机文件系统经 API 暴露的目录。

## 2. 四条已有防线（本轮逐条验证）

### 防线 1：回环绑定闸
- Application.kt 第 93-104 行 requireLoopbackBind：默认只监听回环地址，仅当环境变量 LEGADO_ALLOW_EXTERNAL_BIND=1 才放行非回环绑定。
- 评估：默认安全，显式暴露需人工开关。符合 P0 手册要求。

### 防线 2：同源写门
- Guard.kt 第 30 行 SAFE_METHODS 定义安全方法集合；第 72 行 SameOriginWriteGate 全局插件拦截写请求；第 22-27 行 0.6.23 版改为比对 ServerIdentity，防 DNS 重绑定型跨站写。
- 第 57 行 Cookie 同步例外（调用点 SourcesRoutes.kt 第 772 行）：为书源 cookie 同步放行，需确认该例外只放行特定路由与必要头。
- 评估：写保护存在且演进过一轮加固，属有效防线。无 CORS install（Application.kt 仅注册 ContentNegotiation/Compression/WebSockets/StatusPages/SameOriginWriteGate），不存在宽泛 CORS 暴露。

### 防线 3：出站 SSRF 纵深
- NetworkSecurity.kt 第 67 行 resolveAndValidateSafeHttpTarget（解析期校验）；第 97 行 validateResolvedAddresses 拦回环、私网、链路本地、CGNAT（100.64）、0 端口、124 段、IPv4-mapped IPv6（第 136-141 行）。
- GuardedHttpClient.kt 第 22、71-72 行：源码注释自认 narrows but does not close the DNS TOCTOU window——连接层未固定 IP。
- 逐跳校验已覆盖：MediaRoutes.kt 第 447-481 行逐跳重校验 + Redirect.NEVER（第 450 行）；WebViewProxy.kt 第 361-376 行 validateTarget；RuleRunner.kt 第 1306、1316-1320 行规则引擎逐跳校验 + deadlineMs（第 1070-1102、1218-1242 行）。
- MCP 出站：McpClient.kt 第 65、224-230 行同样走 NetworkSecurity。
- 残余风险即 P0-2（见 §4）。

### 防线 4：Rhino 沙箱三重限制
- JsSandbox.kt 第 303 行 ClassShutter 恒 false（禁 Java 类直取）；第 302 行 optimizationLevel=-1（解释执行）。
- JsGuard.kt 第 90 行 GRANULARITY=20_000 指令粒度检查；第 91 行栈深 1000 + 墙钟 deadline 防死循环。
- 资源预算已落地：AppConfig.kt 第 135、149-163 行 jsTimeoutMs（30 秒）与 jsHostBytes（默认 64MB，0=不设限）；JsGuard.chargeHostBytes 第 132 行记账；JsSandboxHostBudgetTest 3 项测试。
- JavaPackages.kt 第 45-52 行 Java 互操作白名单 + requireAllowedLength（第 410、593、722 行）限制能力面与数据规模。
- JsoupBridge.kt 第 14-42 行只 parse 不 connect（HTML 解析不发网络）。
- 权威沙箱评估文档：rules-sandbox-audit.md，其 E 项（统一预算前置基线未做）为 P1-5。

## 3. 攻击面矩阵

| 攻击面 | 入口 | 现有防护 | 残余风险 | 等级 |
| --- | --- | --- | --- | --- |
| 跨站写（CSRF/重绑定） | 浏览器恶意页面打本地端口 | SameOriginWriteGate + ServerIdentity 比对 | Cookie 同步例外路径需窄化验证 | LIKELY 低 |
| SSRF DNS 重绑定 | 恶意书源 URL | 解析期校验 + 逐跳重校验 + Redirect.NEVER | 连接级 IP 未固定（P0-2） | CONFIRMED 高 |
| 沙箱逃逸 | 恶意书源 JS | ClassShutter + 白名单 + 墙钟/栈深/内存预算 | E 项前置基线未做（P1-5）；白名单能力本身仍在扩大面 | LIKELY 中 |
| 文件路径穿越 | 媒体/文件 API | 本轮窗口阅读未发现放行符号路径的接口 | 未做全面枚举（NEEDS_RUNTIME_TEST） | 待验证 |
| AI 数据破坏 | Agent 会话调用写工具 | 仅批量工具接 confirm | 单写工具无闸（P0-4） | CONFIRMED 高 |
| 备份投毒 | 恶意备份包 | 墓碑防复活 + enabled 保留本机策展 | 导入非原子（P0-1）属数据可靠性 | CONFIRMED 中 |
| 敏感信息泄露 | API 错误响应/日志 | StatusPages 存在；本轮未见堆栈直吐 | 未做全量响应审计 | 待验证 |

## 4. 风险清单（按优先级）

| 编号 | 风险 | 类别 | 建议 |
| --- | --- | --- | --- |
| P0-2 | SSRF 连接级 TOCTOU | CONFIRMED | 连接时 pin 已校验 IP（自定义 SocketFactory/DNS），逐跳复用；补 TOCTOU 对抗测试 |
| P0-4 | AI 单写工具无确认闸 | CONFIRMED | runTool 层按 writes 能力位统一插 confirm 钩子 |
| P1-5 | 沙箱统一预算前置基线未做 | IMPROVEMENT | 按沙箱审计 E 项补齐后纳入第二阶段回归 |
| S-1 | Cookie 同步例外窄化 | LIKELY | 确认 Guard.kt:57 例外只覆盖 SourcesRoutes.kt:772 一条路径 |
| S-2 | 文件 API 全量枚举 | NEEDS_RUNTIME_TEST | 第二阶段补路径穿越边界测试 |
| S-3 | API 错误响应泄露审计 | NEEDS_RUNTIME_TEST | 全量路由错误路径抽验 |

## 5. NOT_A_BUG 声明（防误判）

- 存在 Java 互操作 API 本身不构成沙箱失效：白名单 + ClassShutter + 预算三重限制在位，实际能力面由 JavaPackages 白名单决定。
- 无 CORS install 不是缺陷：本地单源服务不需要 CORS，宽泛 CORS 才是风险。
- 绑定 127.0.0.1 默认值是安全设计，不是待修配置。

## 6. 第二阶段衔接

P0 安全整改的实测基线以本报告为准：先修 P0-4（写闸，改动小收益大），再做 P0-2（IP pin，改动集中在 ops/），P1-5 与 S-1/S-2/S-3 作为同阶段补充测试项。所有加固不得破坏 JavaPackages 白名单内合法书源的兼容性，需以兼容性测试集回归。

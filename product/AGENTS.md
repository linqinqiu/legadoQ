# AGENTS — legadoQ 自定义接入面 `/api/agent/*`

本文件给需要把 legadoQ 接入外部系统 / AI 客户端的开发者与智能体看。它描述的是**真实已在 127.0.0.1:1234 跑起来的 HTTP 接口**，不是设计稿。

> 安全模型：本服务没有账号、没有 token。写操作（登记/删除连接、新建书源）受**同源写门**保护：`POST/PUT/DELETE` **只有在带了 `Origin` 头**时才检查它是否指向服务自己（`ServerIdentity` 的绑定 host+port），带了跨站 Origin 就 403；**不带 Origin 的请求直接放行**（本机 curl / 脚本 / AI 客户端都属于这一类）。`GET/HEAD/OPTIONS` 无论带什么都放行。唯一反向例外是 WebSocket：那条把「没有 Origin」当作跨站拒掉。服务**仅绑定 127.0.0.1，绝不绑定 0.0.0.0**。所有外部 HTTP 调用走 JDK `java.net.http.HttpClient`。

---

## 0. 架构收口：网关在进程内，HTTP 只是收口

这组接口**不再另写一份 AI 逻辑**，全部收口到进程内的网关对象：

- `io.legado.ai.AgentConnection` —— **网关句柄**（用户说的「我的网关」）。它不额外开端口、不注册任何 HTTP 路由，纯进程内。
- `io.legado.ai.Agent` —— 网关的实现：能力清单（`manifest`）、外呼切换（`comprehend`）、工具分发（`call`）都在这里。
- `AgentRoutes.kt` 里的 `agentManifest` / `agentComprehend` 等**只是薄收口**：解析 HTTP 入参 → 委派 `agentConnection.` 上的对应方法 → 把 `AgentResult` / `ComprehendOutcome` 包成 HTTP 响应。**任何外部模型切换、超时、失败语义都不在 HTTP 层，只在 `Agent` 里**。

所以「更新网关」= 改 `Agent` / `AgentConnection`；`/api/agent/*` 的路由只负责把请求转发过去，保持路由登记与 agent-api.json 数量一致即可（见 §6）。

## 1. 这组接口解决了什么

「自定义接入」是 legadoQ 给用户预留的**可插拔扩展点**。基础框架只立下稳固钩子，真正接哪种模型、连哪个地址，完全交给用户：

- 在 `agent-profiles.json` 里配（**配置文件预设**）
- 或在运行时 `POST /api/agent/connections` 注册（**运行时注册**）

二者二选一即可，效果等价，都落入 `agent-profiles.json`。

## 2. 端点目录（机器可读契约）

`GET /api/catalog` 返回全部端点的机器可读契约（与 `http/` 目录的路由文件双向核对，见下方“一致性闸门”）。本组 8 个端点的归属见 `resources/agent-api.json`（group: `AI 自定义接入`）。

| 方法 | 路径 | 写门 | 说明 |
|------|------|------|------|
| GET  | `/api/agent/manifest`        | 否 | 能力清单：`enabled`（是否登记了外部连接）、`builtinConnections`（恒为空，保留字段） |
| GET  | `/api/agent/connections`     | 否 | 列出当前已登记的外部连接（没有就是空列表） |
| POST | `/api/agent/connections`     | **是** | 登记/更新一个 `openai-compatible` 外部连接 |
| DELETE | `/api/agent/connections/{id}` | **是** | 删除一个外部连接 |
| POST | `/api/agent/sources`         | **是** | 新建/覆盖书源（落库） |
| POST | `/api/agent/sources/validate`| 否 | 只读校验书源合法性，不落库 |
| POST | `/api/agent/comprehend`      | 否 | 文章阅读理解：必须有外部模型；无连接 409、外呼失败 502 |
| POST | `/api/agent/chat`            | 否 | 自由对话（多轮）：必须有外部模型；无连接 409、外呼失败 502 |

## 3. 书源双动作：新建 / 校验

### 3.1 校验 `POST /api/agent/sources/validate`

请求体：`{ "json": "<书源 JSON 字符串>" }` —— **注意 `json` 是字符串字段**，调用方必须把书源对象序列化成 JSON 字符串再包一层。

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/sources/validate \
  -H 'Content-Type: application/json' \
  -d '{"json":"{\"bookSourceUrl\":\"https://x.com\",\"bookSourceName\":\"demo\"}"}'
```

返回：`{ "valid": true, "errors": [], "warnings": [] }`；非法时如 `{ "valid": false, "errors": ["书源必须是 JSON 对象"] }`。

### 3.2 新建 `POST /api/agent/sources`

请求体同为 `{ "json": "<书源 JSON 字符串>", "version": <可选> }`。`<script>` 块里的 JS 逻辑等不能加注释（校验会报 `invalid_source`）。

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/sources \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"json":"{\"bookSourceUrl\":\"https://demo.example.com\",\"bookSourceName\":\"demo\"}"}'
```

返回：`201 { "id": "https://demo.example.com", "version": 1, "updatedAt": "..." }`。并发冲突返回 `409 version_conflict`。

## 4. 文章阅读理解 `POST /api/agent/comprehend`

请求体：

```json
{
  "text": "文章正文……",
  "question": "可选：针对文章提出的问题",
  "summarySentences": 3,
  "topKeywords": 5
}
```

行为（必须有外部模型）：
- **已登记外部连接** → 走该 openai-compatible 模型，返回 `engine: "external:<连接id>"` + `summary`（模型原文）。
- **没有任何外部连接** → `409 no_connection`，不返回摘要。**没有本地抽取兜底。**
- **地址被出站闸门拒绝 / 地址不合法**（内网、本机、非 HTTP(S)）→ `400 invalid_request`，
  并把闸门那句中文原样带回 `message`。这是**客户端能自己修**的一类，不该混进 502。
- **外呼失败（连不上 / 域名解析不了 / 非 2xx / 没返回内容）** → `502 upstream_unreachable`，不返回摘要。

> 这条 400/502 的分界是 0.8.6 补的，之前是一处真缺陷：`AgentRoutes.outcomeStatus()` 压根没有
> `invalid_request` 分支，于是填了内网地址的用户看到 `500`，去翻服务端日志；而填错的域名
> （DNS 都解析不了）与"上游挂了"共用同一个异常类型，也一律被说成"连不上"。
> 判据在 `app/src/test/kotlin/io/legado/AgentErrorClassHttpTest.kt`：
> 它起真服务验**状态码与那句话**，而不是只断言 provider 抛了什么异常。
> `comprehend` 与 `chat` 两条路径的分类必须一致（从前不一致：同一内网地址一个 500、一个 502）。

> ⚠️ 多连接时的选择规则：默认 `FirstProfileSelector`（见 `ai/ConnectionSelector.kt`）取 `agent-profiles.json` 里**第一个**连接（按文件顺序）。
> 只要这个「第一个」连接存在，无论后面还有多少可用连接，都只走它；它不可达就直接报错，**不会自动顺延到下一个连接**。
> 所以「想让某个地址生效」就把它放在第一条，或只保留一个外部连接。这是已确认的正确行为，不是 bug；
> 想要 failover / 按健康度挑选，由插件注册一个 `ConnectionSelector` 并 `selectorRegistry.setDefault(...)` 替换默认策略（见 `docs/plugin-framework.md` §1.1），框架默认行为不变。

返回示例（外部命中）：
```json
{ "engine": "external:mock-gpt",
  "summary": "摘要：……（模型原文）",
  "keywords": [], "answer": "（问题，原样回显）", "sentencesCount": -1 }
```

返回示例（没有连接）：
```json
{ "code": "no_connection", "message": "尚未登记外部模型连接；请先在「AI 接入 → 连接」里登记一个 openai-compatible 地址。" }
```

## 5. 接入一个外部模型（openai-compatible）

### 5.1 运行时注册

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/connections \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"name":"我的网关","kind":"openai-compatible",
       "baseUrl":"http://127.0.0.1:5591/v1","model":"mock-gpt","apiKey":"sk-xxx"}'
```

返回：`{ "id": "我的网关", "name": "我的网关", "kind": "openai_compatible", "model": "mock-gpt", "baseUrl": "..." }`。
`id` 缺省用 `name` 规整化（空白替换为 `_`）。**没有 `builtin` 字段** —— 0.8.3 起不再有内置连接，
该字段连同 `builtin-stub` 连接类型一起删了（老配置里若还有 `builtin-stub` 记录，读配置时会被
跳过并留一行日志，其余连接照常恢复）。

> ⚠️ 上面这个 `baseUrl` 用的是回环地址（本机 mock / Ollama / LM Studio 就只有这种地址可填），
> 而**登记这一步不校验地址**（`agentCreateConnection` 只校验 name 与 kind），所以它会返回 200 ——
> 真正的拒绝发生在**外呼那一刻**：默认配置下返回 `400 invalid_request` + 闸门那句中文。
> 要接本机模型，服务侧先设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`（只放回环，且仍硬拒打到服务自己）。
> 0.8.6 之前这里更坑：同一件事返回的是 `500`，于是人去翻服务端日志而不是改自己填的地址。

### 5.2 配置文件预设

在 `agent-profiles.json`（运行时由 `LEGADO_HOME` 指定，默认 `.`）写入：

```json
{ "profiles": [
  { "id": "my-gw", "name": "我的网关", "kind": "openai-compatible",
    "baseUrl": "https://api.example.com/v1", "apiKey": "sk-xxx",
    "model": "gpt-4o", "options": {} }
] }
```

服务启动时读取该文件；运行时 `POST` 注册会就地更新它。没有内置连接，删光外部连接后
`/api/agent/connections` 返回空列表，AI 功能进入 409 `no_connection`。

### 5.3 请求/响应形状

框架向 `${baseUrl}/chat/completions` 发 OpenAI 兼容请求：

```json
{ "model": "<model>", "messages": [{ "role": "user", "content": "<构建好的提示词>" }] }
```

带 `Authorization: Bearer <apiKey>`（当 apiKey 非空）。超时 30s、连接 10s。
解析取 `choices[0].message.content`；非 2xx 或解析失败 → 视为失败 → 返回 502 `upstream_unreachable`。

## 6. 一致性闸门（给维护者）

`web/test/ApiCatalog.test.ts` 是双向核对闸门：`http/AgentApiRoutes.kt` 里本组 8 个 `route("agent")` 端点，**必须同时**原样镜像到 `resources/agent-api.json`，且二者数量一致（其中本组 8 条属于 `AI 自定义接入` 组；版本号见 `app/build.gradle` 的 `version`）。
**全量条数不在这里写**：权威值只有 `ApiCatalog.test.ts` 里那一条绝对计数断言（改端点时会逼你更新它），文档抄一份必然滞后 —— 这句从 139 一路错过到 142。
**改动 `/api/agent/*` 时禁止动既有路由数量、路径、分组**；新增端点要同时在两处登记。运行：

```bash
cd web
npx tsx test/ApiCatalog.test.ts   # 期望 3/3 PASS
```

## 7. 本地验证（本会话已跑通）

- 1234 服务：`gradlew :app:run`，环境变量 `LEGADO_HOST=127.0.0.1 LEGADO_PORT=1234 LEGADO_DATA_DIR=<数据目录> LEGADO_HOME=<dir>`，并加 `-Dai.debug`（或环境变量 `JAVA_OPTS=-Dai.debug`）启用外部网关句柄。
- **交互入口（已改版）**：设置 → 「AI 接入」→ 打开「AI 接入 · 对话助手」面板。主形态就是**对话**：在输入框说话，消息走 `POST /api/agent/chat`；**必须先登记外部模型（openai-compatible）**，没有连接时输入框禁用、状态显示「未连接外部模型，AI 不可用」。连接登记与书源只读校验收进同面板底部的「连接与工具」折叠区。**没有也不再有独立的 `agent.html` 页面**（已删除，仅保留 SPA 设置入口）。
- 注意：根路径 `http://127.0.0.1:1234/` 是 legadoQ**阅读器主应用**（书架/书源/阅读），与 `/api/agent/*` 这套 AI 接入无关；AI 接入的对话入口是上面设置面板里的「AI 接入」。
- 端到端（0.8.6 重测，四条路径各自都验过状态码与文案）：
  1. **没有连接（chat）**：删光外部连接 → `409 no_connection`，不再有本地说明冒充回答。
  2. **地址被闸门拒（chat / comprehend）**：登记 `baseUrl=http://127.0.0.1:5591/v1`（默认配置不放回环）
     → 两条路径都返回 **`400 invalid_request`**，`message` 里带闸门原话"拒绝访问内网或本机地址"。
     ⚠️ 本文件旧版这里写的是"`engine:"external:<id>"` + 模型原文"，那是回环闸门加入**之前**的结果，
     照着做必然失败 —— 起好 mock、登记成功（登记不校验地址）、一发 chat 就被拒。
     要用本机 mock / Ollama / LM Studio 跑通这一条，服务侧先设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`；
     它只放回环，并且**仍然硬拒打到服务自己那个 host:port**（否则不带 Origin 的出站请求等于绕过唯一的写保护）。
  3. **公网不可达 / 域名解析不了** → `502 upstream_unreachable`，`message` 带上是真因
     （"无法解析 xxx 域名"与"连不上"不再共用同一句套话）。
  4. **外部命中**（公网地址，或按 2 开了回环口子）→ `engine:"external:<id>"` + 模型原文；
     工具调用闭环另见 `AgentToolCallingTest`。
- 判据在 `AgentErrorClassHttpTest.kt`：它起真服务断言**状态码 + 那句中文**，
  而不是只断言 provider 抛了什么异常 —— 上一轮就是"单测全绿、HTTP 层没人验"才让这三类顶包 bug 发出去的。
- 注意中文请求体务必以**无 BOM 的 UTF-8** 发送，否则 kotlinx 解析会把字段读空（这是调用方编解码问题，不是网关 bug）。

## 8. 状态显示：显示状态 + 实测便携状态

「AI 接入 · 对话助手」面板顶部有**两个**状态，不要混为一谈：

- **显示状态**（`externalConnected`）：只看 `GET /api/agent/connections` 里有没有连接。有就显示「已连接外部模型：<name>」。
- **实测便携状态**（`probe`）：真的发一条 `ping` 走 `POST /api/agent/chat`，看**此刻**外部模型是否可达。
  - `probing` → 「实测中…」（琥珀色标签）
  - `ok` → 「实测可达（<engine 去掉 external: 前缀>）」（强调色标签）
  - `fail` → 「实测不可达」（危险色标签）
  - 打开面板且已登记外部模型时自动实测一次；旁边有「重新实测」按钮。
  - 没有外部模型时不显示实测区，只显示「未连接外部模型，AI 不可用」。（状态靠 `ai-tag` 三档配色区分，界面不用装饰字形——`CopyStyle.test.ts` 的 BANNED_GLYPHS 判据盯着。）

两者是独立维度：显示状态说"配了没有"，实测状态说"现在通不通"。只有实测 `ok` 才代表真能对话。

## 9. 版本号：`version=dev` 的坑（已修）

`BuildInfo.version` 读的是 jar 的 `Package.implementationVersion`：

```kotlin
BuildInfo::class.java.`package`?.implementationVersion?.takeIf { it.isNotBlank() && it != "unknown" } ?: "dev"
```

`gradlew :app:run` 跑的是 **classes 目录**（没有 manifest），所以开发态永远显示 `version=dev` —— 这不是 bug，是正常现象。

但 `installDist` / 发行版用的普通 `jar` task **原本没配 manifest**，导致发行版也显示 `dev`（"版本没有更新"的真正原因）。已在 `app/build.gradle` 里给 `jar` task 补上：

```groovy
tasks.named('jar', Jar) {
    manifest {
        attributes(
            'Main-Class': 'io.legado.ApplicationKt',
            'Implementation-Title': 'legadoQ',
            'Implementation-Version': project.version
        )
    }
}
```

改完 `gradlew :app:installDist` 后，发行版 `/healthz` 与启动日志都显示真实版本（`0.8.2`）。

## 10. 便携发行测试版（组装方法；历史示例包已于 2026-10-25 清理）

便携发行包可双击运行、自带 JRE，用于验证"换台电脑也能跑"。按"产物出库"规则放在仓库外（旧例放 `legado-releases/`，与仓库并列；该具体包已清理，需要时按本节方法重新出包）。下面是组装要点：

```
legadoq-dist-v0.8.2/
├─ start.bat          ← 双击启动
├─ runtime/           ← jlink 精简 JRE 17（~45MB，不依赖本机 Java）
├─ app/lib/           ← legado-0.8.2.jar + 全部依赖
├─ home/              ← agent-profiles.json（外部模型连接）
└─ data/              ← junction → <仓库>/legado/data（真实书源库）
```

组装要点：

- `jlink --add-modules java.base,java.logging,java.net.http,java.sql,java.naming,java.management,java.security.jgss,java.desktop,java.xml,jdk.crypto.ec,jdk.unsupported,jdk.zipfs,jdk.localedata,java.instrument,jdk.management --strip-debug --no-header-files --no-man-pages --compress=2 --include-locales=en,zh`
  - ⚠️ JDK17 **不支持** `--compress=zip-6`（JDK21+ 才有），只能用 `--compress=2`。
- `data` 用 junction 指向真实库，避免复制 216MB，也避免"数据全没了"的错觉；要独立可拷走的版本就把 junction 换成真实目录 + 复制 `legado.sqlite`。
- 启动命令：`runtime\bin\java.exe -Dfile.encoding=UTF-8 -cp "app\lib\*" io.legado.ApplicationKt`
- PowerShell 里传 `-Dfile.encoding=UTF-8` 必须加引号（`'-Dfile.encoding=UTF-8'`），否则会被按 `.` 拆开报 `ClassNotFoundException: /encoding=UTF-8`。

已实测（端口 1235 独立实例，验证完已关闭）：`/healthz` → `version:"0.8.2"`；`/api/sources` → 5574 条；SPA 正常；`/api/agent/connections` 含 mock-gpt；`/api/agent/chat` → `engine:"external:mock-gpt"`；`/agent.html` → 404。

---

## AI 接入补充（并入自原 AI-AGENT 文档）


## 1. 门在哪：本服务不设身份

这台服务**没有账号、没有令牌、没有会话**。写操作（`write=true` 那些）唯一的门是
`Guard.kt` 的同源判定：请求带了 `Origin` 头，就必须**主机与端口都等于服务自己绑定的那个身份**才放行；
**不带 `Origin` 的请求直接放行**（浏览器发跨站写请求一定会带 `Origin`，所以随机网页驱动不了这台机器上的库）。

由此得出三条实际结论：

- **本机进程**（curl、Python、Node、跑在本机的 AI 客户端）不需要任何凭据就能读写 —— 它不需要伪装浏览器。
- **从浏览器里的页面**调用时，必须从同源地址（默认 `http://127.0.0.1:1234`）发起，否则写请求 403 `cross_origin`。
- **`LEGADO_HOST=0.0.0.0` 等于把整个库的写权限交给局域网**：任何能连到这个端口的人或程序都能删书源、
  改规则、清凭据。要放到局域网或更远的地方接 AI，先想清楚这一点 —— 那道同源门只挡得住浏览器，挡不住客户端。
- 唯一**反过来**的是 `WS /api/search/stream`：它把"没有 `Origin`"当作跨站拒掉。本机脚本要用它，
  得自己带一个 `Origin: http://127.0.0.1:1234`（与连接的 Host 一致）。

## 2. 目录的形状

```jsonc
{
  "service": "legadoQ",
  "version": "0.8.6",          // 当前真正在跑的构建号，由服务端在响应时盖上
  "scope": "全量：代码里注册的每一条端点都在这里，按 group 归面",
  "howToConnect": { "baseUrl": "…", "auth": "…", "errors": "…", "response": "…" },
  "workflow": [ "…" ],
  "endpoints": [
    { "method": "PUT", "path": "/api/sources/{id}", "write": true,
      "purpose": "新建或覆盖一份书源；路径里的 id 不作数，以体里 json 的 bookSourceUrl 为准",
      "body": { "json": "整份书源 JSON 字符串", "version": "可选；给了就防并发改写" },
      "response": "入库后那一份的信封 {id,json,version,updatedAt}" }
  ]
}
```

每条五个必填面：怎么调（`method` + `path` + `query` / `body`）、要不要过写门（`write`）、这条做什么
（`purpose`）、**回包长什么样**（`response`）、归哪一面（`group`）。`response` 那栏是 0.8.0 补的：只说怎么调，
接入方拿到 200 还是得猜顶层键。

`response` 里列的是那个模型的**全部字段**，不是"每次都会出现的键"：服务端编码时不写默认值，
所以可空字段（`stackTrace`、`mediaUrl`、`author` 这一类）在没内容时**整个键都不出现**。按「可能缺」去读。
（这一条是拿真接口打出来的：目录给 `GET /api/logs` 列了 `stackTrace`，实际回包里那一项没有这个键。）

`scope` 现在是**全量** —— `http/` 目录里注册的每一条都在这份目录里（0.8.2 起路由按面拆在
`Routes.kt` 装配点与 `<组名>Routes.kt` 组文件里），共 141 条，按面分成：
目录 / 系统 / 书源 / 发现页 / 搜索 / 登录与凭据 / 内置浏览器 / 阅读 / 书架 / 离线缓存 / 分章规则 / 净化规则 /
图片与媒体 / 进度与笔记 / 朗读 / RSS / 书源订阅 / 备份。判据的要求是「目录条数 == 代码里的条数」，
所以新加一条端点而忘了写进契约，当天就会红 —— 以前只盯 `/api/sources…` 前缀，别的面漏了没人知道。

`write` 这一栏要说准：它是"这条处理器**调没调**同源写门"，不是"这台客户端会不会被挡"。
`Guard.kt` 对 `GET` / `HEAD` 这类安全方法**直接放行**，所以 `GET /api/bookshelf/cached-chapters` 写着
`write=true` 却不会挡本机脚本；真正会挡 403 的是 POST / PUT / DELETE / PATCH 那几条。
还有一类反过来的：`WS /api/search/stream` 没带 `Origin` 就当跨站拒掉。

有一类端点靠解析器容易被漏掉，这里点名：`/api/sources/{id}/browser/res` 的五种方法是
`for (verb in listOf(HttpMethod.Get, …)) { method(verb) { … } }` 一次注册出来的，不是五条 `get("…")`；
`webSocket("…")` 也不是 HTTP 路由。解析这两种的规则本身就在判据里。

## 3. 推荐动线：改一本书源

1. `GET /api/sources?q=…` 拿列表（这是投影，不含完整规则 JSON，别拿它当源内容用；每项带 `version`，就是下一步的乐观锁编号）。
2. `GET /api/sources/{id}` 取一份书源。`id` 是**剥掉 `#` / `##` 注解后的书源地址**，与库里主键对齐。
   回的是**信封** `{id, json, version, updatedAt}`：书源本体在 `json` 那个**字符串**里，不是展开的对象，要用之前自己 parse。
3. 改完先**别写库**：`POST /api/sources/{id}/validate` 带 `{"json": "草稿"}` —— 它校验编辑器里未保存的内容，不落库。
4. 再看它真能不能跑：`GET /api/sources/{id}/debug?keyword=…`。这是 **SSE**，逐阶段回「结构 / 搜索 / 详情 / 目录 / 正文」
   每一步取到了什么、错在哪（`{stage, label, detail, ok, elapsedMs, traces}`）。判"这个源坏没坏"要看这一条，不要只看搜索返回空。
5. 确认无误才 `PUT /api/sources/{id}`（带上第 2 步读回的 `version`，就不会覆盖别人在你读之后做的改动；
   路径里那个 `{id}` 不作数，入库以体里 `json` 的 `bookSourceUrl` 为准），或 `POST /api/sources/import` 一批。

**批量整理**走 `POST /api/sources/batch`（`enable` / `disable` / `delete` / `set_group` / `tag_group` / `untag_group`）。
`delete` 是真的删，没有回收站 —— 让 AI 自动跑批之前，先确认它被允许删。

**导入的覆盖语义**：`POST /api/sources/import` 永远按 `id` 做 upsert，已在库的会**被覆盖**（只有 `enabled` 保留本机选择，
不会被导入翻回来）；请求体里的 `overwrite: false` 服务端**不看**，别指望它挡同名。要"跳过已有"就别把它们放进这一批。

## 4. 登录与凭据：几条容易踩错的事实

- 凭据按**注册域**存一张全局表，不按书源存。所以**删书源不会连带清掉 Cookie**，同一域的另一家源也共享这份凭据。
- `GET /api/sources/{id}/credential?u=…` 只回答"这个域上有没有凭据"（有/无），**不回答"登录还有效吗"** ——
  上游没有这个机制，`loginCheckJs` 本质是响应改写器。
- 想真验证：`GET /api/sources/{id}/login-check`，只有源自己配了 `loginCheckJs` 才可能回 `verified=true`。
- 灌 Cookie 走 `POST /api/sources/{id}/login-cookie`：入库前会归一化成 `k1=v1; k2=v2` 并剥掉
  `Path=/; HttpOnly; SameSite=…` 这类指令属性 —— 直接整串存会让下次发出去时把属性当 Cookie 名带上，站点回 400。
- 内置浏览器那一组（`/browser/…`）是给"要走一遍真实登录流程"的源用的。**导航**（`page`、`submit`）的目标站被锁在
  这本书源 `allowedDomains` 里；**子资源**（`res`）只放开公网 —— 站点的 CDN 不然会被拦死。两种都每一跳重过 SSRF
  校验（`NetworkSecurity.resolveAndValidateSafeHttpTarget`，环回与私网地址一律拒），iframe 不开 `allow-same-origin`。
  其中 `page`、`res`（同一路径上的 GET/POST/PUT/PATCH/DELETE 五条）、`submit` 这几条**不看 `Origin`** —— 它们的门是
  `POST /browser/session` 发的那张一次性令牌（`?t=…`，1800 秒过期），因为提交表单那一下是代理里的页面在发，带不出本站的 `Origin`。
  没有有效令牌就失败，所以先开会话、再用同一个 `t`。这几条回的是**目标站的响应原文**，不是 legadoQ 的 JSON 信封，
  所以别拿 `JSON.parse` 去接 `browser/page`。
  `GET /browser/submit` 容易读错：它不是"读表单字段"，而是**以 GET 提交表单** —— 除 `t`、`u` 之外的 query 参数会被当成字段值拼上去。

## 5. 健康体检是阻塞式长任务

`POST /api/sources/health-check` **一次跑完才回**（并发 16、单个默认 5 秒超时，全库 5,574 份源时是几十分钟量级），
没有进度流 —— 客户端要把超时设得比这更长，或者只点名 `ids` 分批跑。回包是 `{total, successCount, slowCount, failedCount, durationMs, results[]}`。
它的分档口径值得注意：**没发过请求的源不算"连不上"** —— 没配 `searchUrl` 的进 `no_search`、
只有发现页的进 `explore_only`，这两档不进"失效"计数，也不会被一键停用圈走。
AI 要"帮我修库"时，先让它给出分档统计，再决定动作，不要直接按 `!ok` 批量删。


### 出错怎么读（原 AI-AGENT §7）

## 7. 出错怎么读

失败一律是非 2xx + `{"code": "...", "message": "..."}`，`message` 是给人看的中文，可以直接显示。
常见码：`invalid_request`（体不是合法 JSON）、`cross_origin`（写请求的门没过）、
`not_found`（书源不存在）、`source_execution_failed` / `explore_failed` / `image_failed`（规则或上游真的失败了）。
0.7.5 起，列表规则取值失败时 `message` 会带上**上游自己写的那句原因**（例如「你好，需要登录才能继续使用此功能」），
所以"搜不出结果"这件事现在能从这句话里分出「要登录」还是「站点确实没内容」。

---

## 程序内部 AI 框架（并入自原 ai-framework 文档）


## 0. 为什么是「进程内」

用户要的是「在程序内部、自定义一个连接 API、能在内部改建所有东西」——所以 AI 不是一个
外挂的前端，也不开第二条 HTTP 服务。它直接拿 `Application` 启动时已经建好的那些服务对象：

- `Database`：书源 / 净化规则 / RSS / 书架 / 笔记 / 阅读日志 / 订阅 的读写
- `RuleRunner`：搜索 / 发现 / 目录 / 正文 / 调试
- `SourceDebugger`、`SourceHealth`：书源体检与分阶段调试
- `SubscriptionService`：订阅更新
- `CoverCache`：封面缓存

这些对象就是 141 个 HTTP 端点背后那同一批实例。AI 调用它们 == 端点调用它们，
**没有第二条实现路径**，也就不会出现「AI 能改、界面改不了」或反过来这种分裂。

**关键约束（来自 `web/test/ApiCatalog.test.ts`）：** 那份判据逐条比对 `http/` 目录的路由文件与
`agent-api.json`，条数对不上、write 标错、purpose/response 缺字都会红。所以本框架
**不注册任何新 HTTP 路由**，AI 完全在进程内通过 `Agent` 暴露，不增加端点计数。

## 1. 包结构

```
app/src/main/kotlin/io/legado/ai/
├── AgentContext.kt   // 把服务装进一个"连接"对象，作为所有工具的共享环境
├── Agent.kt          // 编排：能力清单 / 执行单工具 / 规划 / LLM 钩子占位
├── AgentCatalog.kt   // 读 agent-api.json，生成给 AI 看的能力说明
├── Guardrails.kt     // 护栏：拒绝公网绑定 / 写前确认 / 版本冲突转译
├── BuiltinTools.kt   // 内置工具清单（55 个，覆盖现有服务层 + program.catalog）
├── ToolRegistry.kt   // ★ 工具注册表：运行时增删工具，替代硬编码 listOf
├── ToolHooks.kt      // ★ 生命周期钩子：before / after / onError 四个介入点
├── AgentConnection.kt// ★ 程序内部"连接 API"句柄：call / manifest（同步，不增路由）
└── AgentModule.kt    // ★ 把连接挂进进程的接线处：install 默认关闭，仅 -Dai.debug 自检
```

> **内容 / 框架边界**：`ai/` 是「可覆盖的默认内容容器」（类比前端 `features/`）。
> 它**不注册任何 HTTP 路由**（Ktor 路由只从 `http/` 装配），所以 141 端点计数不动。
> `ai/` 里的 `OpenAiCompatibleProvider` / `BuiltinTools` / `FirstProfileSelector`
> 只是默认实现，全部可插拔（外部 provider / 工具 / 选择器用新 id 注册、`replace` 覆盖、`unregister`
> 摘掉）。这条边界由 `FrameworkContractTest`（`@Tag("framework-contract")`，钉进 `verifyFramework`
> 与 `check`）守住：默认只含 `openai-compatible` 与 `FirstProfileSelector`、重复 id 被拒、
> 内置工具默认不可删、`agent-api.json` 契约 141/19/8。

## 2. 核心类型（`AgentContext.kt`）

```kotlin
data class AgentContext(
    val database: Database,
    val runner: RuleRunner,
    val debugger: SourceDebugger,
    val health: SourceHealth,
    val subscriptions: SubscriptionService,
    val coverCache: CoverCache,
    val boundHost: String = "127.0.0.1",  // 真实绑定身份，护栏据此拒绝"搬到公网"
    val boundPort: Int = 1234,
) {
    fun error(code: String, message: String): AgentResult =
        AgentResult(status = "error", code = code, message = message)
}

data class AgentResult(
    val status: String,          // "ok" | "error"
    val code: String = "ok",      // 沿用 HTTP 错误码语义
    val message: String? = null,  // 给人/下一段推理看
    val data: Any? = null,        // 结构化结果（JSON 友好）
)

typealias ToolArgs = Map<String, Any?>   // 扁平键值，骨架阶段只支持基础类型

data class ToolMeta(
    val id: String,
    val group: String,
    val description: String,
    val writes: Boolean,          // 是否会写库（执行前过护栏）
)

class Tool(var meta: ToolMeta, val handler: suspend (AgentContext, ToolArgs) -> AgentResult) {
    constructor(handler: suspend (AgentContext, ToolArgs) -> AgentResult) :
        this(ToolMeta("__unset__", "unknown", "", false), handler)
    suspend fun invoke(ctx: AgentContext, args: ToolArgs): AgentResult = handler(ctx, args)
}
```

`error(code, message)` 的 `code` 字段**全部沿用现有 HTTP 错误码**
（`invalid_request` / `not_found` / `version_conflict` / `cross_origin` /
`source_execution_failed` 等），保证进程内与 HTTP 层语义一致，便于复用同一套提示词。

## 3. 护栏（`Guardrails.kt`）

AI 能改库，所以每一条写路径都要先过护栏：

| 方法 | 作用 |
| --- | --- |
| `refuseExternalBind(host): AgentResult?` | 只允许 `127.0.0.1` / `localhost` / `::1`；`0.0.0.0` 与任意公网地址一律**拒绝**（返回非 null 即拦截）。这是「永不把服务搬到公网」的硬门。 |
| `requireConfirm(args, affectedHint): AgentResult?` | 破坏性动作（删源 / 删规则 / 清书架 / 覆盖导入等）必须带 `confirm = true` 才放行；否则返回 `confirm_required` 提示。 |
| `catchVersionConflict(block): T` | 把 `VersionConflict`（PUT 带旧 version 命中并发改写）转成 `AgentVersionConflict`，由 `Agent.runTool` 统一翻成 `version_conflict` 错误。 |

任何"意图把监听搬出本机"或"不经确认就破坏"的调用，都会在框架层被拦下，
不会真的落到 `Database`。

> **别把入站和出站混了。** 上表 `refuseExternalBind` 管的是**入站**——服务自己绑哪个地址（只许回环）。
> AI **出站**连模型走的是另一道闸：`OpenAiCompatibleProvider.assertPublicBaseUrl()` →
> `NetworkSecurity.resolveAndValidateSafeHttpTarget()`，它**连回环也拒**（`isLoopbackAddress` 直接抛）。
> 所以 `baseUrl` 填 `127.0.0.1` / `localhost` / 私网段，调用时一律 `400 invalid_request`，
> 本机跑的模型（Ollama 等）默认接不进来。

## 4. 能力清单（`AgentCatalog.kt` + `BuiltinTools.kt`）

`AgentCatalog.loadEndpoints()` 直接读 `agent-api.json`（与 `/api/catalog` 同一份文件），
把它变成给 AI 看的、带 `version` 注记的文本说明。这样 **AI 看到的能力面 == 1234 交付的
能力面**，不会因为另写一套而漂走。

`BuiltinTools.all()` 注册 54 个工具，按面分组，每个都只是把参数转成一次既有服务调用：

- **书源**：列举 / 取单条 / 校验草稿 / 写库（带版本乐观锁）/ 删除 / 批量整理 / 导入 / 自定义排序
- **净化规则**：列举 / 增删改 / 切换启用 / 导入
- **RSS**：列举 / 取单条 / 切换启用 / 删除 / 导入
- **书架**：列举 / 加入 / 改信息（封面、分组、是否读完）
- **笔记与进度**：列笔记 / 增改删 / 记阅读日志 / 读日志
- **订阅**：列订阅 / 更新单个 / 更新全部
- **发现页与搜索**：取发现页标签 / 取某标签条目 / 搜书
- **体检与调试**：逐阶段调试（SSE 的同款 `DebugStep`）、单源体检

工具的实现严守三条：

1. 只读工具直接查 `Database` / `RuleRunner`；
2. 写工具先 `Guardrails.requireConfirm(args, …)`，再在 `catchVersionConflict { … }` 里落库；
3. 失败一律走 `ctx.error(code, message)`，不抛裸异常。

## 5. 编排（`Agent.kt`）

```kotlin
class Agent(
    private val ctx: AgentContext,
    private val homeDirectory: Path,
    private val profileStore: AgentProfileStore = AgentProfileStore,
    tools: List<Tool> = BuiltinTools.all(),
    val registry: ToolRegistry = ToolRegistry(tools),   // 运行时增删工具
    val hooks: ToolHooks = ToolHooks(),                 // before / after / onError
) {

    fun toolManifest(): List<ToolMeta>            // 当前全部工具的元信息，喂给 LLM 做选择
    suspend fun runTool(id: String, args: ToolArgs): AgentResult  // 执行单个工具，统一兜底异常
    suspend fun plan(goal: String): Plan  // 关键词路由占位：把目标映射到工具（骨架，未接 LLM）
    suspend fun callLlm(prompt: String): String?   // 真调外部模型；缺连接/失败返回 null

    data class Plan(val goal: String, val toolId: String?, val note: String?)
}
```

`runTool` 的执行顺序（0.8.2 起，钩子接进来之后）：

1. `registry.find(id)` —— 未注册直接 `unknown_tool`
2. `hooks.runBefore` —— 任一钩子返回非 null 即**拦截**，工具不执行，拦截结果仍过 `after` 链
3. 工具本体 —— 异常按下面兜底
4. `hooks.runAfter` —— 可逐层改写结果

`runTool` 的异常兜底：

- `Guardrails.AgentVersionConflict` / `VersionConflict` → `version_conflict`
- `IllegalArgumentException` → `invalid_request`
- 其他 `Throwable` → `internal_error`（同时回调 `hooks.onError`，拿到的就是最终返回那个结果）
- 钩子自己抛异常 → `hook_failed`，工具不执行

**`callLlm` 已接通**：它会去 `AgentProfileStore` 找第一个 openai-compatible 连接并真正发出
HTTP 请求；找不到或调用失败返回 `null`，调用方据此返回明确的不可用错误（`409 no_connection` /
`502 upstream_unreachable`），**不做本地兜底**。框架本身仍不绑定任何
具体模型——接哪个地址完全由用户的 `agent-profiles.json` 决定。约束不变：模型只能从 `toolManifest`
选工具、只能通过 `runTool` 落地，不能允许模型直接调私有方法绕过护栏。

## 6. 程序内部的「连接 API」（已交付）

用户要的「在内部提供 API 连接」落地为 `AgentConnection`：一个进程内句柄，调用方
（自动化脚本 / 智能体 / 调试器）拿它就能像访问一个连接那样 `call` 任意已注册工具、
`manifest` 看清当前能力面。它**不开端口、不注册任何 HTTP 路由**。

```kotlin
// 构造（用启动时已有的同一批服务；见 AgentModule.connect）
val conn = AgentConnection(agent)
val tools: List<ToolMeta> = conn.manifest()
val res: AgentResult = conn.call("replace.import", mapOf(
    "json" to """[{"name":"demo","pattern":"a","replacement":"b","isRegex":false}]"""
))
val res2: AgentResult = conn.callSuspend("replace.list", mapOf("q" to "demo"))
```

### 挂进进程（AgentModule）

`AgentModule.connect(...)` 是构造接线处，`AgentModule.install(conn)` 决定要不要跑自检：

- **默认关闭**：两个开关都没设时 `isEnabled()` 为 false，进程对外暴露面与从前完全一致。
- **开关（两者取或）**：系统属性 `-Dai.debug`，或环境变量 `LEGADO_AI_ENABLED=1|true|yes|on`。
  后者是为正式部署准备的——不必再改启动脚本加 JVM 参数。
- 启用时跑一次 `selfTest`（写一条自检规则 → 读回 → 删除），不污染真实库。
- `Application.kt` 已接入，无 `routing { }`，端点计数不动。

### 扩展点（不改框架源码就能加能力）

```kotlin
// 1) 注册一个自己的工具
val registry = ToolRegistry()          // 内置工具自动在册
registry.register(
    Tool { ctx, args -> ctx.error("ok", "hello") }
        .also { it.meta = ToolMeta("demo.hello", "demo", "示例工具", writes = false) }
)

// 2) 挂一组钩子（返回的句柄用于卸载）
val hooks = ToolHooks()
val handle = hooks.install(
    // 返回 null = 放行；返回非 null = 拦截，工具不执行
    before = { meta, _ ->
        if (meta.id == "source.delete") AgentResult(status = "error", code = "forbidden", message = "本部署禁止删源")
        else null
    },
    after  = { _, _, result -> result },   // 返回 null 保持原结果，返回新结果即改写
    onError = { meta, _, error, converted -> /* 记录日志 / 告警 */ },
)

// 3) 把两者交给框架
val conn = AgentModule.connect(database, runner, coverCache, subscriptions, registry = registry, hooks = hooks)
```

### 验证（已在 app/src/test）

- `AgentFrameworkTest.kt`（5 例）、`AgentConnectionTest.kt`（5 例）覆盖读/写/护栏/能力面。
- 运行：`$env:GRADLE_OPTS='-Xmx1g -Xms256m'; .\gradlew.bat :app:test --tests "io.legado.AgentConnectionTest"`

1. **单元测试**：在 `app/src/test` 里构造 `Agent` 跑端到端断言（改源 → 读回 → 校验）。（旧式入口，已被 AgentConnection 取代）
2. **`main` 守卫调试入口**：在启动代码里用 `if (System.getProperty("ai.debug") != null)` 包住一段
   直接调用 `agent.runTool(...)` 的演示逻辑，仅供本地排查，不对外暴露。

要让人/脚本以「AI 客户端」方式驱动这台服务，仍然走 `GET /api/catalog` 拿契约、
走既有 141 个端点执行——进程内 `Agent` 是给"服务自己内嵌的自动化/智能体"用的同一条路径。

## 6.5 连接自己的配置（`options`）

`agent-profiles.json` 里每个连接的 `options` 字段现在**真的生效**了（此前是死字段，
只被写入、从没被读）。三条约定，借鉴自上游 `legado-with-MD3`：

| key | 作用 | 示例 |
|---|---|---|
| `header.<名字>` | 自定义请求头（中转站/自建服务常要） | `"header.X-Api-Key": "sk-relay"` |
| `thinking` | 思考强度五档，发到 `reasoning_effort` | `"thinking": "medium"` |
| `timeoutMs` | 单次请求超时（毫秒） | `"timeoutMs": "60000"` |

思考强度沿用 OpenAI 的命名，不自己发明：`low` / `medium` / `high` / `xhigh` / `max`
（大小写与空白宽容；写错或没设就不发这个字段，老服务不会因此 400）。

**会被挡掉的头**：`Content-Type`、`Authorization`、`Host`、`Content-Length` ——
前两个分别由 body 与 `apiKey` 字段表达（混着写两处必然漂移），后两个由 JDK HttpClient
自己算（硬写会出错）。判据 `ProfileOptionsTest` 钉着这四条。

```json
{ "profiles": [{
  "id": "relay", "name": "中转站", "kind": "openai-compatible",
  "baseUrl": "https://relay.example.com/v1", "apiKey": "sk-xxx", "model": "gpt-4o",
  "options": {
    "header.X-Relay-Region": "cn",
    "thinking": "high",
    "timeoutMs": "60000"
  }
}] }
```

## 7. 当前边界（骨架阶段只到这）

- 已就位：连接句柄 `AgentConnection`、进程接线 `AgentModule`（默认关闭）、能力清单、护栏、54 个工具、异常兜底、目录读取、两套运行验证。
- **基础设施三件套（0.8.2 结构重排补，让框架"提供更多可能"）**：
  - `ToolRegistry` —— 工具面从硬编码 `listOf(...)` 变成**运行时可变**：外部可以 `register` / `unregister`
    自己的工具，不改框架源码、不重编译。三条不变量：id 唯一（重复注册默认拒绝，要覆盖得显式
    `replace = true`）、内置工具默认删不掉（防插件摘掉 `source.delete` 这类核心能力）、线程安全。
  - `ToolHooks` —— 工具调用的四个标准介入点：`before`（返回非 null 即拦截，工具不执行）、
    `after`（可改写结果）、`onError`（异常回调）、`install()` 返回注销句柄。钩子按注册顺序执行；
    被拦截的结果同样会过 `after` 链（审计要看得见）。钩子在工具**外面**，不能替工具绕过护栏。
  - 接入开关 —— 从前只有 `-Dai.debug`；现在补 `LEGADO_AI_ENABLED` 环境变量，两者**取或**。
    另有 `LEGADO_AI_ALLOW_REMOVING_BUILTIN_TOOLS`（默认 false）控制能否注销内置工具。
  - 判据：`AgentInfrastructureTest`（17 例）覆盖注册/注销/排序/拒绝非法注册/四个钩子阶段/
    钩子自身异常兜底/开关向后兼容/三件套组合。
- 已就位（此前误记为未就位，此处更正）：`callLlm` 不再是返回 null 的占位 —— 它会去
  `AgentProfileStore` 找第一个非内置连接并**真正发出 HTTP 请求**，找不到或失败才返回 null。
- 未就位（明确列为 TODO，不假装已实现）：
  - 真正的规划/多步推理（`plan` 仍是关键字路由占位）
  - 任何把 AI 接到公网或新增端点的出口
- 不做的：第二套前端、第二条 HTTP 服务、绕过护栏的私有方法直调。

---

## Agent 接入指南（并入自原 agent-guide 文档）


## 0. 一句话

legadoQ 的 AI 是**进程内网关**，不是外挂服务：它和界面、脚本用的是同一批服务对象，
所以它知道你在看什么，也能调程序自己的 54 个能力。
入口是 `/api/agent/*`（8 个端点），核心实现在 `app/src/main/kotlin/io/legado/ai/`。

## 1. 三步接上

### 1.1 起服务

```bash
npm start                 # 默认 127.0.0.1:1234
```

### 1.2 登记一个外部模型

任何 **openai-compatible** 地址都行 —— 各家云 API、自建网关、本机跑的 Ollama / LM Studio。
接本机的那类需要显式开一下口子，见下面「接本机模型」那条。

**方式 A：界面**（推荐，能立即实测通不通）
设置 → 接入与扩展 → **AI 接入** → 填连接 → 保存。
面板顶部两个状态：「已连接」= 配没配；「实测可达」= 此刻通不通。

**方式 B：HTTP**

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/connections \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"name":"我的网关","kind":"openai-compatible",
       "baseUrl":"https://api.example.com/v1","model":"gpt-4o","apiKey":"sk-xxx"}'
```

> ⚠️ 出站闸门（`NetworkSecurity`）默认**拒绝内网与本机地址**：填 `192.168.*` / `10.*` /
> `169.254.169.254` 这类一律返回 `400 invalid_request`，并把闸门那句原话带回 `message`。
>
> **接本机模型（Ollama / LM Studio，只有 `127.0.0.1` 可填）**：这台软件就跑在本机，
> 一刀切拒回环等于把这批用户挡在 AI 功能外面。0.8.6 起服务侧设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`
> 放行，但守住两条 —— ① 只放回环（`localhost` / `127.*` / `::1`），私网段照旧拒；
> ② **仍然硬拒指向这台服务自己的 host:port**。理由不是"防内网"：本服务对不带 Origin 的请求
> 放行写操作，而 JDK `HttpClient` 发请求不带 Origin，一个能打到 1234 的 AI 连接等于绕过它唯一的写保护。
>
> 登记这一步不校验地址（只校验 name 与 kind），所以填错的回环地址会先返回 200，
> 真正的拒绝发生在**外呼那一刻** —— 报 400 而不是从前那个让人去翻服务端日志的 500。

**方式 C：配置文件**（`agent-profiles.json`，放在安装根）

```json
{ "profiles": [
  { "id": "my-gw", "name": "我的网关", "kind": "openai-compatible",
    "baseUrl": "https://api.example.com/v1", "apiKey": "sk-xxx",
    "model": "gpt-4o", "options": {} }
] }
```

> 这个文件**含 apiKey**，已在 `.gitignore` 里，不要提交。

### 1.3 验一下

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

- 正常：`{"engine":"external:<连接id>","content":"..."}`
- 没连接：`409 no_connection`
- 连不上：`502 upstream_unreachable`

## 2. 它能做什么

### 2.1 知道你在哪

前端每次发消息都带**界面上下文**（`lib/uiContext.ts`）：

```ts
{ page: 'reader', dialog: null,
  source: { id, name },
  book: { sourceId, bookUrl, name, chapterIndex },
  keyword }
```

所以「这本书讲了什么」它知道"这本书"是哪本。**只给标识与少量摘要，不给整本正文** ——
正文由它自己用工具去取（这才是 Agent 的正确用法，也避免一次请求塞几十万字）。

### 2.2 能调 54 个工具

按面分组（`GET /api/agent/manifest` 可查全量）：

| 组 | 工具 | 用途 |
|---|---|---|
| `source` (14) | `list` `get` `upsert` `delete` `validate` `import` `batch` `order` `debug` `health` `group.*` | 书源增删改查、分阶段调试、实跑体检、分组 |
| `search` / `chapters` / `content` | `search.run` / `chapters.run` / `content.run` | 搜书、取目录、取正文 |
| `explore` (2) | `explore.tabs` / `explore.run` | 发现页 |
| `book` (1) | `book.info` | 单本详情 |
| `shelf` (6) | `list` `get` `add` `remove` `infoUpdate` `setCompleted` | 书架 |
| `note` (4) / `readingLog` (2) | `note.*` / `readingLog.*` | 笔记、阅读记录 |
| `progress` (2) | `progress.get` / `progress.set` | 阅读进度 |
| `replace` (6) | `list` `get` `save` `toggle` `delete` `import` | 净化规则 |
| `rss` (4) | `list` `get` `setEnabled` `delete` | RSS |
| `subscription` (3) | `list` `updateOne` `updateAll` | 书源订阅 |
| `tts` (2) | `tts.speak` / `tts.voices` | 朗读 |
| `ai` (3) | `ai.textClean` / `ai.textRewrite` / `ai.selectTextAction` | 选中文本处理 |
| `backup` (2) | `backup.list` / `backup.get` | 备份导出 |

### 2.3 真实用例

| 场景 | 它会做的 | 为什么这样对 |
|---|---|---|
| 「这本书讲什么」 | 读界面上下文 → `chapters.run` 取目录 → `content.run` 取几章 → 回答 | 不是靠书名猜 |
| 「这源为什么搜不出」 | `source.debug` 逐阶段跑 | 能指出是搜索坏还是目录坏 |
| 「哪些源废了」 | `source.health` 实跑 | 真发请求，不是看规则猜 |
| 「去掉广告行」 | `replace.save` 落库 | 改完界面上立刻能看到 |
| 「搜《××》」 | `search.run` | 真的走书源 |

## 3. 护栏（写操作不是随便就能做）

| 护栏 | 行为 |
|---|---|
| 批量删除 | 必须 `confirm=true`，否则返回 `confirm_required` |
| 地址外绑 | `refuseExternalBind` 拒绝把服务绑到非回环地址 |
| 乐观锁 | 书源带 `version`，冲突返回 `version_conflict`，不静默覆盖 |
| 工具删不掉内置 | `ToolRegistry` 默认拒绝注销内置工具 id |

## 4. 自己给它加能力

### 4.1 加一个工具（最简单）

```kotlin
val myTool = Tool { ctx, args ->
    val q = args["q"] as? String ?: return@Tool ctx.error("invalid_request", "缺 q")
    AgentResult("ok", data = mapOf("answer" to "你问的是 $q"))
}.also { it.meta = ToolMeta("my.query", "custom", "我的查询工具", writes = false) }

agentConnection.registry.register(myTool)   // 注册完 AI 立刻能调
```

不需要改框架、不需要重编译主程序（用插件做的话）。

### 4.2 加一个 LLM 协议

实现 `LlmProvider`，注册进 `providerRegistry`：

```kotlin
class MyProvider : LlmProvider {
    override val id = "my-protocol"
    override val displayName = "我的协议"
    override val description = "…"
    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? = …
}
```

见 `docs/plugin-framework.md` §1.1b。

### 4.3 加一个连接选择策略

默认只走第一个连接。想要 failover / 按健康度挑：

```kotlin
class HealthFirstSelector : ConnectionSelector {
    override fun select(profiles: List<AgentProfileStore.Profile>) = profiles.firstOrNull { isHealthy(it) }
}
agentConnection.selectorRegistry.register(HealthFirstSelector())
agentConnection.selectorRegistry.setDefault("HealthFirstSelector")
```

> 注意：注册表按 `::class.simpleName` 取 id，**匿名对象注册不了**（simpleName 为 null）。

### 4.4 挂审计 / 限流钩子

```kotlin
// before 的签名是 (ToolMeta, ToolArgs) -> AgentResult?；返回非 null 即拦截，工具不执行。
val handle = agentConnection.hooks.before { meta, args ->
    if (meta.id.startsWith("source.") && !allowed) ctx.error("forbidden", "不允许改书源") else null
}
// 用完 handle.close() 注销
```

钩子在工具**外面**，只能拒绝或改写，不能替工具绕过护栏。

## 5. 常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| `409 no_connection` | 没登记外部模型 | 按 §1.2 登记 |
| `400 invalid_request` | `baseUrl` 指向本机 / 内网（回环也算） | 换成公网可达地址；本机模型需先暴露出去 |
| `502 upstream_unreachable` | 模型地址连不上 / 非 2xx / 解析失败 | 查 baseUrl 与网络 |
| 中文读成空 | 请求体不是无 BOM 的 UTF-8 | 用 UTF-8 无 BOM 发送 |
| 换了地址不生效 | 多连接只走第一个 | 放第一条，或删掉其它 |
| 工具调不到 | 没注册 / id 重复 | `GET /api/agent/manifest` 查实际清单 |
| 匿名 selector 注册失败 | `simpleName` 为 null | 用具名类 |

## 6. 相关文件

| 想看什么 | 看哪 |
|---|---|
| 端点契约（机器可读） | `GET /api/catalog` |
| 自定义接入面细节 | `AGENTS.md` |
| AI 框架内部结构 | `AGENTS.md` |
| 插件怎么贡献工具/协议 | `docs/plugin-framework.md` |
| AI / 插件 两类分家 | `docs/plugin-framework.md` |

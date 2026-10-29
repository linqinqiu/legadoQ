# 借鉴清单：refgd/legado 与 HapeLee/legado-with-MD3

> 2026-10-29。对照版本：refgd 单提交浅克隆、MD3 `f2cff58`（含 #2513 段评气泡）。
> legadoQ 侧以 `product/` 当前源码为准。行号会漂移，以文件与函数为准。

这份清单只回答两件事：**已经借了什么、还值得借什么**。不做逐文件读书笔记；
每一条都写清来源、我们现状、代价与判据，能直接当下一轮的任务单用。

## 0. 两个仓库的 AI 结构（先看骨架）

- **MD3** 把 AI 拆成五层：`AiProviderConfig`（协议 + 地址 + 头）、`AiModelConfig`（上下文窗口 / 输出上限 / 能力位）、
  `AiTaskPresetConfig`（任务 → 模型 + 提示词 + 参数）、`AiPromptPreset`（按任务可增删的提示词条目）、
  `AiArtifact`（按书 + 章 + 任务落库的 AI 产物）。协议实现三个 Handler 共用 `AiSseUtils` / `AiRetryUtils` /
  `AiProviderRegistry`。配置界面按「提供商 → 模型 → 任务」三层分页。
- **refgd** 把 AI 压成一层半：`AiChatService`（工具循环 + 提示词拼装）+ `AiToolRegistry`（原生工具 + MCP + 用户启停）。
  它没有协议抽象（只有 OpenAI 兼容），但工具面很宽：书架、章节正文、阅读记录、书源增删改查与调试、
  应用设置读写、Tavily 联网搜索、MCP 服务器。
- **legadoQ** 走的是「服务端 agent + 浏览器 UI」：`Agent` 负责工具循环，`LlmProvider` 三协议，
  `BuiltinTools` 55 个工具按组下发，提示词由前端会话携带，技能库落 `{home}/agent-skills/*.md`，
  提示词预设落 `{home}/agent-prompts.json`，历史按字符预算整轮裁剪。

一句话：**MD3 值得学的是"任务层"和"协议细节"，refgd 值得学的是"工具生态"和"技能/MCP"**。
两者都不该照搬的是"把全部工具/技能一次性塞给模型"。

## 1. 已落地（本轮已改，附来源与判据）

| 能力 | 来源（对方） | 我们落点 | 判据 |
|---|---|---|---|
| 三协议抽象：OpenAI Chat / OpenAI Responses / Anthropic | MD3 `data/repository/ai/*Handler.kt`、`AiProviderRegistry.kt` | `ai/LlmProvider.kt`、`OpenAiCompatibleProvider.kt`、`AnthropicProvider.kt`、`OpenAiResponsesProvider.kt` | `ProviderProtocolsTest`；`/api/agent/models` 按 `kind` 返回 `supported` |
| 共用出站件：拼地址、鉴权头、超时、重试、多 key、SSE | MD3 `AiRetryUtils.kt`（KeyRotator + 指数退避）、`AiSseUtils.kt` | `ai/ProviderHttp.kt`（唯一出站闸门，复用 `NetworkSecurity`） | 回环/私网拒绝、指向自身端口拒绝；`Retry-After` 上限 10s |
| 提供商预设带协议 | MD3 `AiProviderPresets` | `AiConnectionsModal.tsx` `PROVIDER_PRESETS`（OpenAI / Responses / Anthropic / DeepSeek / Moonshot / OpenRouter / 硅基流动 / Ollama） | 选预设同时填 `kind` + `baseUrl` + `model` |
| 模型清单探测 | MD3 `modelsUrl` | `POST /api/agent/models`（服务端代发，key 不落盘） | 表单「拉取模型」；`supported=false` 时给一句人话 |
| 流式对话 SSE + 停止 + 用量 | MD3 `AiChatViewModel` 的流式状态机、`AiThinkingStepsCard` | `POST /api/agent/chat/stream`；`web/src/features/ai/agentStream.ts`；两处聊天 UI 的草稿气泡与「停止」 | 客户端断开 → Ktor 取消 → `runInterruptible` 打断阻塞读；`usage`/`toolRounds` 随 `end` 帧回来 |
| 技能库（SKILL.md 形态） | refgd `AiSkillConfig` + `AiChatService.buildConversation` 的 system 注入 | `ai/AgentSkillStore.kt`（3 个内置 + 用户技能，落盘 `agent-skills/<id>.md`，删除进 `.trash`）；`GET/POST/DELETE /api/agent/skills` | 显式 `skills` 或关键词命中，最多 3 条；技能正文永不进日志 |
| 技能管理界面 | refgd 的技能配置项 | AI 接入弹窗「技能」区块：紧凑单行 + 展开正文 + 新建/覆盖/删除 | 内置技能只读、用户版本可覆盖；`enabled` 可停用 |
| 工具调用过程可见 | MD3 思考/工具卡片 | 草稿气泡内工具 chip（进行中/完成/失败 + 耗时）+ `<details>` 推理过程 | `agentStream.ts` 按 `callId` 配对 `tool_start` / `tool_end` |
| 工具参数 JSON Schema | refgd `AiResolvedTool.definition`（每个工具手写 schema） | `BuiltinTools` 每个工具补全参数 schema，经 `/api/agent/manifest` 下发 | 本轮已覆盖 55 个内置工具 |
| 提示词预设库 | MD3 `AiPromptPreset` + `AiPromptConfigScreen`（`name + instruction + enabled + sortNumber`） | `ai/AgentPromptStore.kt`（落盘 `{home}/agent-prompts.json`，删除前整份备份进 `.trash`）；`GET/POST/DELETE /api/agent/prompts`；AI 接入弹窗「提示词」区块（开关 + 上移/下移 + 编辑 + 删除） | `AgentPromptStore` 的排序/覆盖/上限/备份判据 + `AiPromptPresets.test.ts` 守界面与 API 接线 |
| 上下文预算裁剪 | refgd `messages.takeLast(12)`；MD3 `contextWindow` / `maxOutputTokens` | `Agent.trimToBudget`（`LEGADO_AI_MAX_CONTEXT_CHARS`，默 24000）：以 user 消息为段边界，从最旧的整轮开始丢 | `AgentPromptContextTest`：system 与最后一条用户消息必留、整轮不拆、`trimmed` 随 `start`/`end`/`chat` 回报并在气泡标注 |

## 2. 还值得借（按性价比排序）

### P0 · MCP 客户端（refgd `help/ai/AiMcpClient.kt`）

refgd 的实现不大（403 行）但完整：JSON-RPC 2.0 over HTTP、`MCP-Protocol-Version: 2025-06-18`、
`Mcp-Session-Id` 会话复用、`tools/list` 的 `nextCursor` 分页、按服务器指纹 + 60s TTL 的工具缓存、
工具名冲突时加服务器前缀的别名规则。工具统一挂 `mcp_` 组，和原生工具走同一个执行入口。

我们现状：没有 MCP。`ToolRegistry` 的 `origin` 字段已为外部工具留了位置（当前恒为 `builtin`）。
建议：先做 HTTP 传输（stdio 在桌面壳里再考虑），配置落 `{home}/agent-mcp.json`，
工具组固定 `mcp`，默认关；`/api/agent/manifest` 里带 `origin: "mcp:<server>"`。
判据：MCP 服务器不可达时聊天不失败（该组工具为空 + 一条 warning），工具调用超时按连接配置走。

### 已落地 · 提示词预设库（MD3 `AiPromptPreset` + `AiPromptConfigScreen`）

MD3 的模型是：`taskType + name + instruction + enabled + builtIn + sortNumber`，同一任务可挂多条，
启用的按顺序拼进 system；内置条目可被用户改（生成用户副本），改坏了能恢复。

本轮落地的口径见 §1。与原建议差两点，都是有意为之：

- **没做 `taskType` 分任务**。我们目前只有"对话"这一个入口会被预设影响，摘要/清洗/改写还是各自
  的工具提示词；先按任务分档会让界面多一个没人动的下拉。等 §P1「按任务选模型」一起做时再分。
- **界面是独立区块**（在「技能」之前），没有塞进现有"系统提示词"折叠区：会话级 systemPrompt 是
  "这一轮的人设"，预设是"跨会话的全局要求"，混在一个折叠区里改的人会按错地方。

分工按原判断写进了界面提示与代码注释：**提示词是"怎么说话"，技能是"这类任务的专门做法"**；
两者都注入 system，顺序为基础人设 → 提示词预设 → 技能，注入顺序与回报的 `promptsUsed` 一致
（被预算挡掉的预设不算"用了"）。

### P1 · 按任务选模型（MD3 `AiTaskPreset` / `AiTaskType`）

MD3 为 chat / 章节摘要 / 章节翻译 / 划词清洗 / 文本工坊 / 改写 / 朗读分析 / 角色识别 / 书架自动分组
分别指定连接、模型、温度、输出上限与提示词。好处很实际：摘要用便宜模型、改写用强模型，
而不是全局一个连接打天下。

我们现状：所有 AI 调用共用默认连接。建议先在**摘要/净化/改写**这三个明确任务上落地
（这三类已有工具入口），连接表单加"任务"下拉即可，不动现有连接页结构。

### P1 · AI 产物落库（MD3 `AiArtifact`）

MD3 把摘要、翻译、清洗结果按 `bookUrl + chapterIndex + taskType` 存表，带内容哈希与模型标识，
可回看、可对比、可回填正文。这解决"AI 生成完就丢、下次重算"的浪费。

我们的笔记/划线已有独立表，AI 结果目前只在聊天记录里。建议新增只读产物列表 + 「重新生成」
（写操作走同源门），先只支持章节摘要与划词清洗两类。

### P1 · 阅读器划词清洗 / 重写回填（MD3 `ReadAiDelegate`）

2026-10-22 的研究已详细记录：`openAiTextClean`（选区 + 前后各 1000 字上下文 → 落
`BookContentProcess(KIND_AI_CLEAN)` → 章节重载）与 `openAiTextRewrite`（整章润色，参考前 80 章）。
我们阅读器有选中工具栏，但没有"选中 → AI 处理 → 落库 → 原地重载"这条闭环。
建议按 MD3 的顺序做：先清洗（可逆、可删），再重写（差异预览后再落库）。

### P1 · 推理强度与思考卡片（MD3 `AiReasoningLevel` / `AiReasoningModeButton`）

MD3 把 `reasoning_effort` / `thinking.budget_tokens` 统一成 OFF/AUTO/LOW/MEDIUM/HIGH/XHIGH/MAX 七档，
并按提供商身份决定映射（小米/DeepSeek 这类不认标准字段的直接不发）。
我们已有 `thinking` 选项与 Anthropic budget，但档位少、界面在"高级选项"里。
建议把档位补齐到 5 档（低/中/高/更高/最大），聊天输入框旁放一个紧凑下拉；
思考过程仍放 `<details>`，不要做成占满屏的卡片。

### P2 · 联网搜索工具（refgd `AiTavilyTool`）

refgd 的 Tavily 工具写得很克制：只有开关 + key 才注册，参数带 `topic` / `searchDepth` / `maxResults`，
结果给"答案摘要 + 来源链接 + 片段"。我们没有任何联网工具。
建议做成"可配置的搜索连接"（Tavily / SearXNG / Bing），默认关，工具描述里明确"会把查询发给第三方"。
出站仍走 `NetworkSecurity`，结果渲染成来源列表，不让模型手写链接。

### P2 · 工具级开关（refgd `AiToolRegistry`）

refgd 有 `defaultEnabledTools`（默认开的 20 个）、`aiEnabledToolNames`（用户增删）、
`groupLabelOfTool`（前缀 → 中文组名）。我们现在只有组级开关。
建议在「AI 工具组」展开区里加"本组内逐项勾选"，存储键沿用 `legado-ai-tool-groups` 的 v2 结构；
默认值保持"组开 = 全开"，避免老用户感知变化。

### 已落地 · 上下文裁剪（refgd `messages.takeLast(12)`；MD3 `contextWindow` / `maxOutputTokens`）

refgd 只带最近 12 条消息，MD3 给模型配上下文窗口与输出上限。本轮在 Agent 侧落了一个保守的字符预算
（`LEGADO_AI_MAX_CONTEXT_CHARS`，默 24000 ≈ 1.2 万汉字），与原建议有三处不同：

- **按字符而不是条数**：`takeLast(12)` 在"一条消息粘了半章正文"时照样爆；字符数对中文字符串
  已经够稳，这层不引分词器。
- **丢弃单位是整轮而不是单条**：以 user 消息为段边界，一轮之内（含 assistant 的 `tool_calls`
  与它对应的 `role=tool` 结果）要么全留要么全丢 —— 拆开会得到上游那句 `invalid tool contract`。
- **两条保底**：system 段（人设 + 预设 + 技能）与最后一条用户消息永远保留；那条自己就超预算时
  **不截断**，宁可超一点也不悄悄改写用户问的内容。

`trimmed` 在 `start` 与 `end` 两帧都回报（前端只在真裁过时显示"已裁历史 N 条"），
非流式 `/chat` 与 `ChatOutcome` 同一口径。

### P3 · 只读设置工具（refgd `AiSettingsTool`）

refgd 让 AI 能读写应用设置。写设置的风险远大于收益，我们只建议做只读诊断
（当前主题、书源数、存储占用、服务地址），并在工具描述里写明"不修改任何配置"。

## 3. 非 AI 借鉴

### P1 · Cookie 的持久/会话分离与长度上限（MD3 `http/CookieManager.kt`、`CookieStore.kt`）

MD3 把 `Set-Cookie` 里 `persistent=false` 的会话 Cookie 放内存（重启即失效），持久的落库；
取 Cookie 时合并两层，并**在总长度超过 4096 时随机淘汰键**直到放得下（防止超长头被服务端拒绝）。
我们已经做到"按注册域归桶 + 按键合并 + 跨子域共享"，但没有这两条。
建议：`cookie` 表加 `session` 布尔列（或内存 Map），取头时按 4096 截断并记一条 debug 日志。
判据：现有登录测试全绿；新增单测覆盖"持久 + 会话合并"与"超长淘汰"。

### P2 · 局域网拦截的"说清楚"（MD3 `LocalNetworkBlockedNotifier.kt` / `LocalNetworkAccess.kt`）

MD3 在 WebView 请求被内网策略拦下时弹一条可解释的通知，并区分"书源主动请求"与"网页内嵌资源"。
我们有 `NetworkSecurity` 的硬拦截，但界面只会看到"请求失败"。
建议在书源调试/正文加载失败时，把 `BlockedAddressException` 的原因翻成一句人话显示出来。

### 已对齐、无需再借

- **请求压缩**：MD3 `DecompressInterceptor` 自动加 `Accept-Encoding: gzip, deflate` 并解压；
  我们 `RuleRunner` / `WebViewProxy` 已显式加头并按 `Content-Encoding` 解压，`CoverCache` 还兜了
  "没请求也回 gzip"的站点。
- **书源规则引擎**：MD3 的 `AnalyzeRule` 与我们同源，`RuleRunner` 已覆盖 XPath/JSONPath/JS/正则与
  级联回退；不做重复移植。
- **登录与 Cookie 跨域抓取**：0.1.5 起已按 MD3 的"注册域"口径实现，含导航历史回溯。

## 4. 不建议照搬

- **把全部启用技能/工具一次性注入**（refgd）：55 个工具 + N 条技能会把上下文吃光，且模型更容易选错。
  我们保持"组下发 + 关键词选技能（最多 3 条）"。
- **"必须先调用工具"的强制提示词**（refgd `requiresBookshelfTool`）：会诱发无意义调用与
  "为了调用而调用"的回答；按组下发 + 工具描述写清适用场景更稳。
- **Google Translate 协议**（MD3 `AiProtocol.GOOGLE_TRANSLATE`）：它不是聊天协议，翻译该走独立服务，
  混进 AI 连接会让"测试连接/模型清单"语义变糊。
- **Android 专属设施**：Cronet、WebView CookieManager、Keystore/生物识别加密（`BiometricEnvelopeWriter`）、
  `BackstageWebView`。我们是本地 Web 服务，对应能力由浏览器与 `WebViewProxy` 承担。
- **MD3 视觉体系**：Material 3 组件与配色不搬；只借交互形态（已做过一轮，见
  `docs/archive/research/07-MD3借鉴与阅读器AI增强.md`）。
- **AI 会话服务端持久化**：refgd/MD3 都存在数据库里，但我们是单机单用户，localStorage 的 20 个会话
  已够用；等服务端有"多端同步"需求再说。

## 5. 本轮判据

- 端点契约：`agent-api.json` 151 条 / 19 组 / 「AI 自定义接入」13 条；
  `FrameworkContractTest`、`web/test/ApiCatalog.test.ts`、`AgentCatalogTest` 三处同源。
- 协议：`ProviderProtocolsTest` 覆盖三家的请求形状、SSE 拼装、工具调用与错误分层。
- 流式：`chat/stream` 缺连接 409、messages 空 400、上游失败进 `error` 帧；前端
  `agentStream.ts` 对"没有 end 就断线"给 `stream_closed`，中止不算错误。
- 技能：`AgentRoutesHttpTest` 覆盖「内置 3 条带正文」「新建落盘 `agent-skills/<id>.md`」「删除进 `.trash` 且再删 404」
  「内置技能拒删（400 `invalid_skill`）」；关键词选择上限 3 在 `AgentSkillStore.select` 里。
- Cookie（待做）：新增会话 Cookie 合并与 4096 淘汰的单元测试后再动线上路径。

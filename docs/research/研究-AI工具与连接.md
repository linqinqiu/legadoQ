# AI 工具能力与连接现状研究

> 2026-10-27。基于 0.0.8/0.0.9 源码；行号会漂移，以函数名与文件为准。

## 一、当前实现

### 1. 工具注册与下发

- 注册表：`app/src/main/kotlin/io/legado/ai/ToolRegistry.kt`。id 唯一、内置工具不可被插件摘除、线程安全；`manifest()` 按 id 排序返回全部元信息。
- 内置工具：`BuiltinTools.kt`，当前 **55 个**（书源、书架、阅读、规则、TTS、程序目录等）。
- **每次对话都把全部 55 个工具的完整定义发给模型**：`Agent.kt:252` `val tools = registry.manifest()`，随后由 `OpenAiCompatibleProvider` 拼进 `tools:[…]`。
- `/api/agent/manifest` 也把全量清单暴露给界面（`AgentRoutes.kt:50`）。

### 2. 连接（登录 / API）

- 连接档案存本地 JSON（`AgentProfileStore`），字段含 `name / kind / baseUrl / apiKey`。
- `enabled` 的判据是「有没有外部连接档案」（`AgentRoutes.kt`），没有内置兜底。
- provider 只实现了 OpenAI 兼容协议（`OpenAiCompatibleProvider`），支持原生 tool 协议与「纯文本回灌」两种降级形态（网关把工具运行做成有状态时只能走后者）。

## 二、问题

| 问题 | 影响 |
| --- | --- |
| 55 个工具全量注入 | 每次请求都带一大段 JSON：token 成本高、模型容易挑错工具、上下文被工具定义挤占 |
| 没有按需发现 | 模型无法「先查有哪些工具、再拉具体定义」；用户也无法只启用自己用的那几组 |
| 工具没有用户级开关 | 写操作工具（`source.save` 等）与只读工具混在一起下发 |
| 连接缺少「测试」与错误分层 | 配错 baseUrl / key 时，界面只能看到一句 upstream_unreachable，分不清是网络、鉴权还是模型名错 |
| 没有工具调用审计 | 哪一轮调了哪个工具、耗时多少、失败原因，只在服务端日志里 |

## 三、建议（按收益排序）

1. **工具分组按需下发**：`ToolMeta.group` 已经存在（sources / books / rules / tts / program…）。请求前按当前意图（或用户设置）只发 1–2 组；默认发「只读 + 当前页面相关组」。
2. **两段式工具发现**：新增一个轻量元工具 `tool.search(q)`，先返回匹配工具的 id + 一句话；模型需要时再 `tool.load(id)` 拉完整定义。这样首轮请求只带 1 个元工具，55 个定义按需加载。
3. **用户级工具开关**：设置里按组开关；写操作组默认关，需要时再开。
4. **连接自检**：连接表单加「测试连接」按钮，分别报告 DNS / 连通 / 鉴权 / 模型名 四层结论；错误按层返回，不再统一成 upstream_unreachable。
5. **工具调用记录**：每轮记录 `tool id / 参数摘要 / 耗时 / 结果状态`，在 AI 面板可展开查看。

## 四、与本次改动的边界

本轮只做研究与文档；未改 AI 代码。上面 1–5 任何一项都会动 `Agent.kt` / `BuiltinTools.kt` / `AgentRoutes.kt`，需要单独一轮并补后端测试。

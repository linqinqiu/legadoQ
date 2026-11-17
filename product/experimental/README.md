# experimental —— 试验型代码（不参与编译与打包）

这里放**暂时不用、但还没打算删**的东西。和 `docs/archive/`（历史文档）的区别是：这里的代码是完整的，
理论上还能跑，只是当前产品不带它出包；和仓库外 `legado-out/` 的区别是：这里留在 git 里，随时看得见。

## 规矩

1. **不参与构建**：本目录不在任何 Gradle / web 源码集里，`./gradlew build` 与 `npm run build` 都不会碰它。
   所以它**可以不同步修复**——上游接口变了、这里编不过了，是预期状态，不是故障。
2. **恢复＝两次挪动 + 接回装配**：挪回源码树、把装配接回去（下方每个目录都写了具体位置）。
3. **不要在这里改产品行为**：改这里等于改一段没在跑的代码，没人会验证它。要改就先把东西挪回去。
4. 目录一旦空掉就删掉它，别留空壳。

## 当前内容

| 目录 | 原来在哪 | 为什么挪走 | 怎么恢复 |
| --- | --- | --- | --- |
| `ai/web/` | `product/web/src/features/ai/`（12 个）· `lib/aiChatStore.ts` · `lib/aiToolGroups.ts` · `lib/api/domains/agent.ts` · 判据 7 个（`web/test/` 下 `Ai*.test.ts` 六个 + `SelectionContext.test.ts`） | 同上（AI 那个决定覆盖前后端） | 挪回 `web/src/` 对应位置，再把 `main.tsx` 的浮层/悬浮球、`settingsSections.ts` 的 AI 分区、`lib/api/index.ts` 的 agent 导出接回去；`MarkingMenu` 的「发给 AI」按钮同理 |
| `ai/`（后端） | `product/app/src/main/kotlin/io/legado/ai/`（28 个文件）· `product/app/src/main/kotlin/io/legado/http/AgentApiRoutes.kt` · `app/src/test/kotlin/io/legado/` 下 25 个 AI 测试（含 `ai/` 子目录） | 用户 2026-11-17：「就像 AI 这样的附属额外功能可以暂且移除，不使用」——整套 AI（对话、工具、外部模型接入、MCP、技能/提示词）不属于阅读器主线，先挪到一边做实验型 | ① `git mv product/experimental/ai/main/*.kt product/app/src/main/kotlin/io/legado/ai/`（`AgentApiRoutes.kt` 回 `http/`）；② `git mv product/experimental/ai/tests/*.kt product/app/src/test/kotlin/io/legado/`；③ 接回 `Application.kt` 的 `AgentModule.connect/install` 与 `Routes.kt` 的 `agentApiRoutes(...)`（两处各留了一行注释指路）；④ 把 22 条 `/api/agent` 端点加回 `agent-api.json` 并重跑 `npm --prefix product run docs:api`；⑤ 端点计数判据 `ApiContractTest` 与 `ApiCatalog.test.ts` 跟着改 |

## 为什么不做成「开关」

2026-11-17 先做过一版运行时开关（`LEGADO_AI_ENABLED`，默认关）：端点不注册、界面无入口。
但代码还留在源码树里，每次重构都要跟着改、每次编译都要跟着过——**「不用」的东西留在编译路径上就是持续成本**。
所以改成整体挪出去：主树轻了，AI 那边也不会因为主树重构而被动腐烂（它本来就不编）。

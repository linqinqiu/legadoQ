import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * AI 助手增强的判据 —— 与 `AiFloatingAssistant.test.ts` 分开放：
 * 那份守「位置 / 随时随地 / 上下文 / 记忆」四条底线，这份守本轮新增的四项能力：
 * 拖动记忆、隐藏恢复、多会话、提示词模板、工具来源可见。
 *
 * 只读源码做结构断言（与既有 AI 判据同一风格），不依赖真实浏览器。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('悬浮球可拖动，位置记在本机', () => {
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /onPointerDown/, '按下开始拖')
  assert.match(fab, /onPointerMove/, '拖动时跟随')
  assert.match(fab, /onPointerUp/, '松手落位')
  assert.match(fab, /POS_KEY/, '位置要落 localStorage')
  assert.match(fab, /clampPos/, '不能拖出视口')
})

test('悬浮球可隐藏，且留边缘恢复入口', () => {
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /HIDDEN_KEY/, '隐藏状态要持久化')
  assert.match(fab, /ai-fab-restore/, '隐藏后要有把手恢复 —— 完全消失就找不回来了')
  assert.match(fab, /onHide/, '面板里要有隐藏按钮')
})

test('悬浮球带连接状态点（未连/已连一眼可见）', () => {
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /ai-fab-dot/, '状态点')
  assert.match(fab, /ai-fab-connected|ai-fab-offline/, '按连接状态切类名')
})

test('多会话：store 支持新建 / 切换 / 删除', () => {
  const store = read('../src/features/ai/aiChatStore.ts')
  assert.match(store, /sessions:\s*ChatSession\[\]/, '状态里有多会话')
  assert.match(store, /activeSessionId/, '有当前会话指针')
  assert.match(store, /export function newAiSession/, '能新建会话')
  assert.match(store, /export function switchAiSession/, '能切换会话')
  assert.match(store, /export function deleteAiSession/, '能删除会话')
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /ai-session-tabs/, '面板要有会话标签')
})

test('多会话迁移：上一版单会话对话不能丢', () => {
  const store = read('../src/features/ai/aiChatStore.ts')
  assert.match(store, /LEGACY_KEY|legado\.ai\.chat\.v1/, '要读旧格式并迁移')
  assert.match(store, /legado\.ai\.chat\.v2/, '新格式带版本号')
})

test('系统提示词模板可一键切换', () => {
  const store = read('../src/features/ai/aiChatStore.ts')
  assert.match(store, /SYSTEM_PROMPT_TEMPLATES/, '模板清单')
  assert.match(store, /书源调试/, '有书源调试模板')
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /SYSTEM_PROMPT_TEMPLATES/, '面板要用模板')
})

test('工具在界面可见：按组列出（复用已有 manifest，不新增端点）', () => {
  // 0.2.14：manifest 的字段类型住在 lib/api/types.ts
  const types = read('../src/lib/api/types.ts')
  assert.match(types, /origin\?: string \| null/, 'manifest 工具带来源字段（历史遗留，现在恒为内置）')
  // 2026-11-03：工具从「AI 接入」那一屏里拆成独立一档 `AiToolsModal.tsx`。
  const panel = read('../src/features/ai/AiToolsModal.tsx')
  assert.match(panel, /AiToolsSection/, '这一档能选工具组')
  assert.doesNotMatch(panel, /plugin:/, '插件架构已移除，不该再有插件来源分组')
  // 界面文案通用化：不再对用户念"内置/插件"这类实现词，只说关掉会怎样。
  assert.doesNotMatch(panel, /内置|插件/, '工具档的说明要用用户视角的说法')
})

test('人设只有一份：对话浮层与悬浮球共用活动会话', () => {
  const modal = read('../src/features/ai/AiChatModal.tsx')
  // 2026-10-27：两边各存一份 useState 时，在这边改完去悬浮球聊，用的还是旧人设 ——
  // 表现就是"人设没作用"。现在读同一份会话、写回同一个 store。
  assert.match(modal, /useAiChat\(\)/, '对话浮层要读共用会话，不能自己存一份人设')
  assert.match(modal, /setAiSystemPrompt\(/, '改人设要写回共用会话')
  assert.doesNotMatch(modal, /const \[systemPrompt/, '本地再存一份人设会两边不同步')
})
